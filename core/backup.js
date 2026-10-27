/* ============================================================
   FieldKit :: backup
   Cold backup and disaster recovery (§7).

   The problem this solves: everything lives encrypted on one relay
   container. If that container is lost, so is all of it. An archive
   is a second copy you can put on the drive, or anywhere else.

   What an archive contains:
     · the vault header — salt and the password-wrapped master key
     · every record, still sealed exactly as the relay held it
     · non-secret settings
     · a checksum over all of it

   What it does NOT contain, ever: your password, the master key,
   the derived auth token, or a single byte of plaintext. Backup
   reads sealed boxes straight from the transport and never touches
   the decrypted cache. An archive on a lost USB stick is as inert
   as the relay it came from — it is exactly as strong as your
   master password and no weaker.

   The one deliberate exception is EXPORT PLAINTEXT, which is for
   leaving FieldKit rather than backing it up. It is gated behind
   its own confirmation and says plainly what it is.

   Recovery path when a relay is gone entirely:
     new relay → FieldKit boots to an empty vault → RESTORE FROM
     ARCHIVE at the setup gate → header and records are uploaded →
     unlock with the original password. The new relay never learns
     anything the old one didn't.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var FORMAT = "fieldkit-archive";
  var FORMAT_VERSION = 1;

  /* Settings are non-secret by design (see core/settings.js) with
     exactly one exception, which must never ride along. */
  var SETTINGS_DENYLIST = ["relayProvisionToken"];

  function svc(n) { return FieldKit.service(n); }
  function need(n) {
    var s = FieldKit.service(n);
    if (!s) throw new Error("service '" + n + "' is not available");
    return s;
  }

  /* ---- canonical form + checksum ------------------------------- */
  /* Key order has to be deterministic or the checksum is meaningless
     across engines. */
  function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    var keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + canonical(value[k]);
    }).join(",") + "}";
  }

  /* The record array is a set, not a sequence: a transport is free to
     hand records back in whatever order it likes, and re-serialising
     an archive must not invalidate it. So the checksum is taken over
     records sorted by id, while the file keeps whatever order it has. */
  function payloadFor(vault, records, settings) {
    return {
      vault: vault,
      records: (records || []).slice().sort(function (a, b) {
        var x = (a && a.id) || "", y = (b && b.id) || "";
        return x < y ? -1 : x > y ? 1 : 0;
      }),
      settings: settings === undefined ? null : settings
    };
  }

  async function checksum(payload) {
    var bytes = new TextEncoder().encode(canonical(
      payloadFor(payload.vault, payload.records, payload.settings)));
    var digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return need("crypto").toHex(digest);
  }

  /* ---- build --------------------------------------------------- */
  async function build(opts) {
    opts = opts || {};
    var store = need("store");
    if (!store.isUnlocked()) throw new Error("the vault must be open to build an archive");

    var header = store.header();
    if (!header) throw new Error("no vault header — nothing to archive");

    /* opts.from names the transport to read from. It matters when
       the active one is the reason a backup is being taken at all —
       an unprovisioned relay refuses every authenticated read, so
       defaulting to "wherever the store is pointed" made an archive
       impossible in exactly the situation that needs one. */
    var records = (await store.exportRecords(opts.from)).slice().sort(function (a, b) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    /* Belt and braces: a sealed record is {..., box:{iv,ct}} and must
       not carry anything else. If a future change ever puts a
       plaintext field on a record, this refuses to write it. */
    records.forEach(function (r) {
      if (!r.box || !r.box.ct) throw new Error("record " + r.id + " has no sealed box — refusing to archive");
      Object.keys(r).forEach(function (k) {
        if (["id", "type", "createdAt", "updatedAt", "deviceId", "schemaVersion", "box"].indexOf(k) < 0) {
          throw new Error("record " + r.id + " has an unexpected field '" + k + "' — refusing to archive");
        }
      });
    });

    var settings = null;
    if (opts.includeSettings !== false) {
      var s = svc("settings");
      if (s) {
        settings = Object.assign({}, s.all());
        SETTINGS_DENYLIST.forEach(function (k) { delete settings[k]; });
        /* An uploaded wallpaper is a multi-megabyte data URL and has
           no business bloating a backup. */
        if (typeof settings.wallpaper === "string" && settings.wallpaper.indexOf("data:") === 0) {
          settings.wallpaper = null;
          settings._wallpaperOmitted = true;
        }
      }
    }

    var payload = {
      vault: header,
      records: records,
      settings: settings
    };

    var archive = {
      format: FORMAT,
      v: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: FieldKit.VERSION,
      schemaVersion: FieldKit.SCHEMA_VERSION,
      deviceId: store.deviceId(),
      transport: store.transportName(),
      counts: {
        records: records.length,
        types: countTypes(records)
      },
      checksum: await checksum(payload)
    };
    Object.assign(archive, payload);
    return archive;
  }

  function countTypes(records) {
    var out = {};
    records.forEach(function (r) { out[r.type] = (out[r.type] || 0) + 1; });
    return out;
  }

  /* ---- parse + verify ------------------------------------------ */
  function parse(text) {
    var obj;
    try { obj = JSON.parse(text); }
    catch (e) { throw new Error("not valid JSON — is this a FieldKit archive?"); }
    if (!obj || obj.format !== FORMAT) throw new Error("not a FieldKit archive");
    if (obj.v > FORMAT_VERSION) {
      throw new Error("archive format v" + obj.v + " is newer than this build understands (v" +
        FORMAT_VERSION + ")");
    }
    if (!obj.vault || !obj.vault.kdf || !obj.vault.wrap) throw new Error("archive has no usable vault header");
    if (!Array.isArray(obj.records)) throw new Error("archive has no record list");
    return obj;
  }

  async function verify(archive) {
    var issues = [];
    var expected = await checksum({
      vault: archive.vault,
      records: archive.records,
      settings: archive.settings === undefined ? null : archive.settings
    });
    var intact = expected === archive.checksum;
    if (!intact) issues.push("checksum mismatch — the archive has been altered or truncated");

    if (archive.counts && archive.counts.records !== archive.records.length) {
      issues.push("record count disagrees with the manifest (" + archive.counts.records +
        " claimed, " + archive.records.length + " present)");
    }

    var bad = archive.records.filter(function (r) { return !r || !r.id || !r.box || !r.box.ct; });
    if (bad.length) issues.push(bad.length + " record(s) have no sealed content");

    var ids = archive.records.map(function (r) { return r && r.id; });
    if (new Set(ids).size !== ids.length) issues.push("archive contains duplicate record ids");

    return { intact: intact, ok: issues.length === 0, issues: issues };
  }

  /* Does this archive belong to the vault currently in play? The
     auth key hash is derived from the password, so matching hashes
     means the same password opens both. */
  function sameVaultAs(archive, header) {
    if (!header || !archive || !archive.vault) return false;
    return !!header.authKeyHash && header.authKeyHash === archive.vault.authKeyHash;
  }

  function describe(archive) {
    var types = archive.counts && archive.counts.types ? archive.counts.types : countTypes(archive.records);
    return {
      createdAt: archive.createdAt,
      appVersion: archive.appVersion,
      records: archive.records.length,
      types: types,
      typeSummary: Object.keys(types).sort().map(function (t) { return t + " " + types[t]; }).join(" · "),
      hasSettings: !!archive.settings,
      iterations: archive.vault && archive.vault.kdf && archive.vault.kdf.iterations,
      sizeHint: JSON.stringify(archive).length
    };
  }

  /* ---- restore -------------------------------------------------- */
  /* Into a transport that has no vault yet: the disaster-recovery
     path. Uploads the header, then every sealed record. Nothing here
     needs the password — which is the point. The password is needed
     immediately afterwards, to unlock, and that is the proof it
     worked. */
  /* opts.token is the bearer credential for the record uploads, and
     leaving it out is a real failure rather than a missing nicety.

     The two halves of this authenticate completely differently:
     saveHeader() provisions with the one-time X-FieldKit-Provision
     header, while every putRecord() is an ordinary authenticated
     write needing Bearer hex(authKey). That token is derived from
     the password, so a caller can only supply it with the vault
     open. Without it the header lands, the first record comes back
     401, and the relay is left holding a vault header and nothing
     else — provisioned, empty, and looking like it worked until you
     go looking for the data.

     Fake transports whose setToken() is a no-op cannot see this,
     which is why it survived until a suite pointed at a real relay. */
  async function restoreToTransport(archive, transport, onProgress, opts) {
    opts = opts || {};
    var check = await verify(archive);
    if (!check.intact) throw new Error(check.issues[0]);

    var existing = null;
    try { existing = await transport.loadHeader(); } catch (e) { existing = null; }
    if (existing && !sameVaultAs(archive, existing)) {
      throw new Error("this transport already holds a different vault — refusing to overwrite it");
    }

    if (archive.records.length && !opts.token && !opts.headerOnly &&
        typeof transport.setToken === "function") {
      throw new Error(
        "restoring " + archive.records.length + " record(s) needs the vault's auth token — " +
        "pass opts.token from an open vault, or upload the header alone with opts.headerOnly");
    }
    if (opts.token && typeof transport.setToken === "function") transport.setToken(opts.token);

    if (onProgress) onProgress(0, archive.records.length, "uploading vault header");
    await transport.saveHeader(archive.vault);
    if (opts.headerOnly) return { records: 0, header: true };

    var written = 0;
    for (var i = 0; i < archive.records.length; i++) {
      var rec = archive.records[i];
      if (!rec || !rec.id || !rec.box) continue;
      await transport.putRecord(rec);
      written++;
      if (onProgress) onProgress(written, archive.records.length, rec.type);
    }
    return { records: written, header: true };
  }

  /* Into the vault that is already open. Only meaningful if the
     archive came from the same vault — otherwise the boxes cannot be
     opened and would sit there as undecryptable noise. */
  async function mergeIntoOpenVault(archive, opts, onProgress) {
    opts = opts || {};
    var store = need("store");
    if (!store.isUnlocked()) throw new Error("the vault must be open to merge");
    if (!sameVaultAs(archive, store.header())) {
      throw new Error("this archive belongs to a different vault — its records cannot be decrypted here");
    }

    var check = await verify(archive);
    if (!check.intact) throw new Error(check.issues[0]);

    var present = {};
    (await store.exportRecords()).forEach(function (r) { present[r.id] = r; });

    var toWrite = archive.records.filter(function (r) {
      if (!r || !r.id || !r.box) return false;
      var have = present[r.id];
      if (!have) return true;
      if (opts.overwrite) return true;
      /* Newest wins, matching the per-row rule in §12. */
      return String(r.updatedAt || "") > String(have.updatedAt || "");
    });

    var written = await store.importRecords(toWrite, function (n) {
      if (onProgress) onProgress(n, toWrite.length);
    });
    await store.hydrate();

    return {
      inArchive: archive.records.length,
      alreadyPresent: archive.records.length - toWrite.length,
      written: written
    };
  }

  /* ---- files ---------------------------------------------------- */
  function filename(archive, ext) {
    return "fieldkit-backup-" +
      String(archive.createdAt || new Date().toISOString()).replace(/[:.]/g, "-").slice(0, 19) +
      "." + (ext || "json");
  }

  function download(archive, opts) {
    opts = opts || {};
    var text = JSON.stringify(archive, null, opts.pretty === false ? 0 : 1);
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = opts.filename || filename(archive);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 6000);
    noteBackupTaken();
    return a.download;
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error("could not read the file")); };
      fr.readAsText(file);
    });
  }

  /* ---- plaintext export ----------------------------------------
     Explicitly NOT a backup. This is for taking your notes somewhere
     else, and it writes readable content to disk. The UI makes the
     user say so out loud before this runs. */
  async function buildPlaintext() {
    var store = need("store");
    if (!store.isUnlocked()) throw new Error("the vault must be open");
    var rows = await store.list();
    return {
      format: "fieldkit-plaintext-export",
      v: 1,
      createdAt: new Date().toISOString(),
      warning: "THIS FILE IS NOT ENCRYPTED. Anyone who opens it can read everything in it.",
      records: rows.map(function (r) {
        return { id: r.id, type: r.meta.type, updatedAt: r.meta.updatedAt, data: r.data };
      })
    };
  }

  /* ---- automatic local snapshots --------------------------------
     A backup that depends on someone remembering to take it is not
     a backup. After the vault changes, and no more often than
     autoSnapshotMinutes, an archive is written to a small ring in
     IndexedDB. That is a genuine second copy of every sealed record,
     independent of the relay, taken without asking.

     What it is NOT: a substitute for exporting a file. It lives in
     the same browser profile as nothing else important, and a
     Chromebook that gets wiped takes it with it. The panel says so.
     Its job is to make the relay non-single-point-of-failure, and
     to mean that "I never took a backup" is never quite true. */
  var snapTimer = null;
  var snapRunning = false;
  var lastSnapAt = 0;
  var armed = false;

  function snapStore() { return svc("snapshots"); }

  async function takeSnapshot(reason) {
    var snaps = snapStore();
    var store = svc("store");
    if (!snaps || !snaps.available || !store || !store.isUnlocked()) return null;
    /* A guest session's scratch data has no business in the owner's
       snapshot ring. Boot only arms this after a real unlock, so this
       should be unreachable — which is exactly why it is cheap. */
    if (store.isGuest) return null;
    if (snapRunning) return null;
    snapRunning = true;
    try {
      var archive = await build();
      var text = JSON.stringify(archive);
      /* The timestamp is the key. Two snapshots inside one millisecond
         would silently overwrite each other, so it steps forward
         instead — a snapshot must never be lost to a clock tick. */
      var at = Date.now();
      if (at <= lastSnapAt) at = lastSnapAt + 1;
      var entry = {
        at: at,
        reason: reason || "auto",
        records: archive.records.length,
        bytes: text.length,
        checksum: archive.checksum,
        archive: archive
      };
      await snaps.put(entry);
      lastSnapAt = entry.at;
      await pruneSnapshots();
      FieldKit.log("info", "backup", "local snapshot taken (" + entry.records + " records, " +
        Math.round(entry.bytes / 1024) + " KB, " + entry.reason + ")");
      FieldKit.emit("backup:snapshot", { at: entry.at, records: entry.records });
      return entry;
    } catch (e) {
      /* Null means "not applicable here"; a throw means it was tried
         and went wrong. Keeping those apart is what lets the
         self-test say SKIPPED on a platform with no storage and
         FAILED on a machine where storage is broken. The automatic
         path swallows the throw — a safety net must never interrupt
         what the user was doing. */
      FieldKit.log("warn", "backup", "snapshot failed: " + e.message);
      throw e;
    } finally {
      snapRunning = false;
    }
  }

  async function pruneSnapshots() {
    var snaps = snapStore();
    if (!snaps) return 0;
    var keep = keepCount();
    var list = await snaps.list();
    var dropped = 0;
    for (var i = keep; i < list.length; i++) {
      await snaps.remove(list[i].at);
      dropped++;
    }
    return dropped;
  }

  function keepCount() {
    var s = svc("settings");
    var n = s ? Number(s.get("autoSnapshotKeep")) : 3;
    return isFinite(n) && n > 0 ? Math.floor(n) : 3;
  }

  function intervalMs() {
    var s = svc("settings");
    var m = s ? Number(s.get("autoSnapshotMinutes")) : 0;
    return isFinite(m) && m > 0 ? m * 60000 : 0;
  }

  /* Debounced on store:changed rather than run on a bare timer: a
     snapshot of a vault nothing has written to is wasted work, and
     the moment worth capturing is just after a burst of edits. */
  function armAutoSnapshot() {
    if (armed) return false;
    armed = true;
    FieldKit.on("store:changed", function () {
      if (!intervalMs()) return;
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(function () {
        snapTimer = null;
        if (Date.now() - lastSnapAt < intervalMs()) return;
        takeSnapshot("auto").catch(function () { /* already logged */ });
      }, 4000);
    });
    return true;
  }

  async function listSnapshots() {
    var snaps = snapStore();
    if (!snaps || !snaps.available) return [];
    try { return await snaps.list(); }
    catch (e) { return []; }
  }

  async function getSnapshot(at) {
    var snaps = snapStore();
    if (!snaps) return null;
    var e = await snaps.get(at);
    return e ? e.archive : null;
  }

  /* ---- reminder ------------------------------------------------- */
  var LAST_KEY = "fieldkit.lastBackup";

  function noteBackupTaken() {
    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (e) { /* fine */ }
  }

  function lastBackupAt() {
    try {
      var v = localStorage.getItem(LAST_KEY);
      return v ? Number(v) : null;
    } catch (e) { return null; }
  }

  /* Returns null when there is nothing to say, so callers can treat
     a quiet result as "no nagging required". */
  function reminder() {
    var s = svc("settings");
    var days = s ? Number(s.get("backupReminderDays")) : 0;
    if (!days) return null;
    var last = lastBackupAt();
    if (!last) return { overdue: true, days: null, text: "NO BACKUP HAS EVER BEEN TAKEN" };
    var age = Math.floor((Date.now() - last) / 86400000);
    if (age < days) return null;
    return { overdue: true, days: age, text: "LAST BACKUP WAS " + age + " DAY(S) AGO" };
  }

  FieldKit.provide("backup", {
    FORMAT: FORMAT,
    FORMAT_VERSION: FORMAT_VERSION,
    SETTINGS_DENYLIST: SETTINGS_DENYLIST,
    build: build,
    buildPlaintext: buildPlaintext,
    parse: parse,
    verify: verify,
    describe: describe,
    sameVaultAs: sameVaultAs,
    restoreToTransport: restoreToTransport,
    mergeIntoOpenVault: mergeIntoOpenVault,
    download: download,
    readFile: readFile,
    filename: filename,
    canonical: canonical,
    checksum: checksum,
    lastBackupAt: lastBackupAt,
    noteBackupTaken: noteBackupTaken,
    reminder: reminder,
    armAutoSnapshot: armAutoSnapshot,
    takeSnapshot: takeSnapshot,
    listSnapshots: listSnapshots,
    getSnapshot: getSnapshot,
    pruneSnapshots: pruneSnapshots,
    snapshotKeepCount: keepCount
  });
})(window.FieldKit);
