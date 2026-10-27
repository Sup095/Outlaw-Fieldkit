/* ============================================================
   FieldKit :: store
   Encrypted record store. Everything a module persists goes
   through here, and it is encrypted client-side before it ever
   reaches a transport.

   States (FIELDKIT_PROJECT.md §8):
     EMPTY    no vault exists yet — first run, must be online
     LOCKED   vault header known, waiting on the password
     ONLINE   unlocked + transport reachable; full read/write
     OFFLINE  unlocked from a cached header; new work is queued,
              prior records are unreadable because they live
              encrypted on the relay

   Why caching the vault header locally is safe: the header holds a
   salt and a password-wrapped MDK. Without the password it is inert.
   Caching it is what makes OFFLINE mode possible at all — otherwise
   you could not even derive a key to encrypt new work with.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var STATE = { EMPTY: "EMPTY", LOCKED: "LOCKED", ONLINE: "ONLINE", OFFLINE: "OFFLINE" };

  var state = STATE.EMPTY;
  /* Whether init() has run at all. Distinct from "there is no
     vault": before boot reaches connect(), this store has never
     been asked, and reporting that as an empty vault is how the
     boot self-test came to say "no vault yet — first run" on every
     single launch, including launches with a perfectly good vault. */
  var initialised = false;
  var vault = null;
  var transport = null;
  var header = null;
  var deviceId = "unknown";
  var cache = new Map();      // id -> { meta, data }
  var loadedAll = false;

  var crypto_ = null;
  var queue = null;
  var localT = null;

  /* A transport that answered but holds no vault. Kept so RELAY LINK
     can offer to provision the exact one that needs it, rather than
     asking the user to retype a URL the store already knows. */
  var unprovisioned = null;

  function setState(s, detail) {
    if (state === s) return;
    state = s;
    FieldKit.log("info", "store", "state -> " + s + (detail ? " (" + detail + ")" : ""));
    FieldKit.emit("store:state", { state: s, detail: detail || null });
  }

  function uid() {
    var b = new Uint8Array(12);
    window.crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
  }

  /* ---- header cache (plaintext-safe, see note above) ---------- */
  async function cacheHeader(h) {
    try { await localT.saveHeader(h); }
    catch (e) { FieldKit.log("warn", "store", "could not cache vault header: " + e.message); }
  }

  /* ---- init --------------------------------------------------- */
  /* Tries each transport in order and uses the first that answers.
     Falls back to the local one, then to header-cache-only. */
  async function init(transports) {
    initialised = true;
    crypto_ = FieldKit.need("crypto");
    queue = FieldKit.need("queue");
    localT = FieldKit.need("transportLocal");

    try { deviceId = await FieldKit.need("deviceId")(); }
    catch (e) { FieldKit.log("warn", "store", "no stable device id: " + e.message); }
    FieldKit.deviceId = deviceId;

    /* A fresh init is a fresh connection lifecycle. Anything left
       decrypted in memory from a previous transport must go, or an
       offline session could display records it has no business
       being able to read. */
    cache.clear();
    loadedAll = false;
    vault = null;
    header = null;
    unprovisioned = null;

    var list = transports && transports.length ? transports : [localT];
    var online = false;

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var ok = false;
      try { ok = await t.ping(); } catch (e) { ok = false; }
      FieldKit.log("info", "store", "transport '" + t.name + "' ping: " + (ok ? "OK" : "unreachable"));
      if (ok) { transport = t; online = true; break; }
    }

    if (!transport) transport = localT;

    /* Fetch the authoritative header if we can; otherwise use cache. */
    if (online) {
      try {
        header = await transport.loadHeader();
        if (header) await cacheHeader(header);
      } catch (e) {
        FieldKit.log("warn", "store", "header fetch failed: " + e.message);
        online = false;
      }
    }
    var cached = null;
    if (!header) {
      try { cached = await localT.loadHeader(); }
      catch (e) { cached = null; }
    }

    /* THE MISMATCH THAT CAUSED THE BUG.
       A relay can answer /health perfectly and still hold no vault
       — that is its state for the entire window between "I started
       the container" and "I provisioned it". Before this, such a
       relay won the transport election on ping alone, then the
       header quietly came from the local cache instead, and the
       session ran with `transport` pointing at a relay that would
       refuse every authenticated call it made. Everything on screen
       said RELAY / ONLINE; every write queued; hydrate() failed on
       the first authenticated read and the vault looked empty.

       Two different transports cannot supply the connection and the
       identity. If the remote has no vault and this machine does,
       the remote is not serving this vault, so fall back to local
       and say which relay needs provisioning. */
    if (!header && cached && transport !== localT) {
      FieldKit.log("warn", "store",
        "transport '" + transport.name + "' is reachable but holds no vault — " +
        "using the local copy until it is provisioned");
      unprovisioned = transport;
      transport = localT;
      online = false;
    }
    if (!header && cached) {
      header = cached;
      FieldKit.log("info", "store", "using cached vault header");
    }

    if (!header) {
      unprovisioned = null;
      setState(STATE.EMPTY, online ? "no vault yet" : "no vault and no cached header");
      return { state: state, online: online, transport: transport.name };
    }

    setState(STATE.LOCKED, online ? "transport reachable" : "cached header only");
    return {
      state: state, online: online, transport: transport.name,
      /* Named so boot and RELAY LINK can say "reachable, but it has
         no vault yet" instead of the flatly wrong "unreachable". */
      unprovisioned: unprovisioned ? unprovisioned.name : null
    };
  }

  /* ---- first-run setup ---------------------------------------- */
  async function setup(password, opts) {
    if (header) throw new Error("a vault already exists");
    var made = await crypto_.createVault(password, opts);
    vault = made.vault;
    header = made.vault.header;
    if (transport && typeof transport.setToken === "function") {
      transport.setToken(vault.authToken);
    }
    await transport.saveHeader(header);
    if (transport !== localT) await cacheHeader(header);
    setState(STATE.ONLINE, "vault created");
    loadedAll = true;              // brand new vault, nothing to load
    return { recoveryKey: made.recoveryKey };
  }

  /* ---- unlock ------------------------------------------------- */
  async function unlock(password) {
    if (!header) throw new Error("no vault header — first run must be online");
    vault = await crypto_.unlockVault(header, password);
    await afterUnlock();
    return vault;
  }

  async function unlockWithRecovery(recoveryKey) {
    if (!header) throw new Error("no vault header — first run must be online");
    vault = await crypto_.unlockWithRecovery(header, recoveryKey);
    await afterUnlock();
    return vault;
  }

  /* Re-wrap the master key under a new password.

     The data is never re-encrypted — only the small wrapper around
     the master key changes — so this is fast regardless of how many
     records exist. The new header has to reach the relay, and that
     upload authenticates with the token we hold RIGHT NOW, so the
     order matters: change locally, upload, then re-arm the transport
     with the new token. Getting that backwards locks you out of your
     own relay with a header it will not let you replace.

     This is also the path out of a recovery unlock: you got in
     without a password, so now you set one you know. */
  async function changePassword(newPassword) {
    if (!vault) throw new Error("the vault is locked");
    if (!newPassword || String(newPassword).length < 8) {
      throw new Error("a new password must be at least 8 characters");
    }

    var previousToken = vault.authToken;
    var updated = await vault.changePassword(newPassword);

    try {
      await transport.saveHeader(updated);
    } catch (e) {
      /* The relay refused it. Put the old credential back so the
         session keeps working, and tell the caller plainly — a
         half-changed password that works locally and not remotely
         is the worst of both. */
      if (transport && typeof transport.setToken === "function") {
        transport.setToken(previousToken);
      }
      throw new Error("the new header could not be saved to the relay, so the password was " +
        "not changed: " + e.message);
    }

    header = updated;
    if (transport !== localT) await cacheHeader(updated);
    if (transport && typeof transport.setToken === "function") {
      transport.setToken(vault.authToken);
    }
    vault.needsNewPassword = false;
    FieldKit.emit("store:passwordChanged", {});
    return true;
  }

  async function afterUnlock() {
    /* The relay authenticates with a token derived from whichever
       credential just opened the vault — the password, or the
       recovery key. Nothing else knows it, so hand it over here
       rather than plumbing it through boot. */
    if (transport && typeof transport.setToken === "function") {
      transport.setToken(vault.authToken);
    }

    /* A vault created before the recovery key had its own relay
       credential cannot authenticate from a recovery unlock at all.
       Going "online" here would arm the transport with a token the
       relay will always reject, then blame the network: the boot
       screen used to say "OFFLINE — RECONNECT", which was a lie,
       because reconnecting could never fix it. Stay offline
       deliberately and say why. */
    if (vault.recoveryOnlyLocal) {
      if (transport && typeof transport.setToken === "function") {
        transport.setToken(null);
      }
      setState(STATE.OFFLINE, "recovery unlock on a vault that predates recovery relay access");
      await replayQueueIntoCache();
      FieldKit.emit("store:ready", { state: state, recoveryOnlyLocal: true });
      return;
    }

    var reachable = false;
    try { reachable = await transport.ping(); } catch (e) { reachable = false; }

    if (reachable) {
      setState(STATE.ONLINE, "vault open");
      try {
        await hydrate();
        await sync();
        startAutoPull();
      } catch (e) {
        FieldKit.log("warn", "store", "hydrate/sync failed, dropping to offline: " + e.message);
        setState(STATE.OFFLINE, e.message);
        /* hydrate() clears the cache before it reads, so a failure
           part-way leaves it empty — and this branch used to stop
           there, unlike the unreachable branch below which replays
           the queue. The result was an unlocked vault that showed
           nothing at all and offered no explanation. */
        await replayQueueIntoCache();
      }
    } else {
      setState(STATE.OFFLINE, "transport unreachable");
      await replayQueueIntoCache();
    }
    FieldKit.emit("store:ready", { state: state });
  }

  /* Pull every record and decrypt into memory. Fine at this scale;
     revisit if the record count ever gets large. */
  async function hydrate() {
    var metas = await transport.listRecords();
    cache.clear();
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      if (m.deletedAt) continue;
      var rec = await transport.getRecord(m.id);
      if (!rec || !rec.box) continue;
      try {
        cache.set(rec.id, await openRecord(rec));
      } catch (e) {
        /* One unreadable record must not sink the whole boot. */
        FieldKit.log("error", "store", "record " + rec.id + " failed to decrypt: " + e.message);
      }
    }
    loadedAll = true;
    FieldKit.log("info", "store", "hydrated " + cache.size + " records");
  }

  /* Offline: the only readable data is whatever is still queued. */
  async function replayQueueIntoCache() {
    cache.clear();
    var ops = await queue.all();
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.kind === "put" && op.rec && op.rec.box) {
        try { cache.set(op.rec.id, { meta: stripBox(op.rec), data: await vault.open(op.rec.box) }); }
        catch (e) { /* queued under a different vault; skip */ }
      } else if (op.kind === "delete") {
        cache.delete(op.id);
      }
    }
    loadedAll = false;
    if (cache.size) FieldKit.log("info", "store", "restored " + cache.size + " queued records");
  }

  function stripBox(rec) {
    return {
      id: rec.id, type: rec.type, updatedAt: rec.updatedAt,
      createdAt: rec.createdAt, deviceId: rec.deviceId,
      schemaVersion: rec.schemaVersion
    };
  }

  /* ---- authorship ---------------------------------------------
     Two people sharing a vault need to tell their work apart. The
     obvious place for a name is the record metadata — and that is
     exactly the wrong place, because metadata is plaintext on the
     relay. A random device id there is one thing; a human name is
     another. So the author travels *inside* the sealed box.

     Records written before this existed have no envelope, so open()
     falls back to treating the whole payload as data. That keeps
     every existing vault readable without a migration. */
  var ENVELOPE_V = 1;

  function authorName() {
    var s = FieldKit.service("settings");
    var n = s ? String(s.get("displayName") || "").trim() : "";
    return n.slice(0, 40) || null;
  }

  function envelope(data) {
    return { __fk: ENVELOPE_V, a: authorName(), d: data };
  }

  function unwrap(value) {
    if (value && typeof value === "object" && value.__fk === ENVELOPE_V) {
      return { data: value.d, author: value.a || null };
    }
    return { data: value, author: null };
  }

  async function openRecord(rec) {
    var got = unwrap(await vault.open(rec.box));
    var meta = stripBox(rec);
    meta.author = got.author;
    return { meta: meta, data: got.data };
  }

  /* ---- CRUD --------------------------------------------------- */
  function requireVault() {
    if (!vault) throw new Error("vault is locked");
  }

  async function put(type, data, opts) {
    requireVault();
    opts = opts || {};
    var id = opts.id || uid();
    var existing = cache.get(id);
    var rec = {
      id: id,
      type: type,
      createdAt: (existing && existing.meta.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deviceId: deviceId,
      schemaVersion: FieldKit.SCHEMA_VERSION,
      box: await vault.seal(envelope(data))
    };

    /* Did someone else change this while we had it open? Last write
       still wins — but silently losing a collaborator's work is the
       thing that makes shared editing untrustworthy, so it is said
       out loud instead. */
    if (existing && state === STATE.ONLINE && !opts.quiet) {
      try {
        var remote = await transport.getRecord(id);
        if (remote && remote.updatedAt && existing.meta.updatedAt &&
            remote.updatedAt > existing.meta.updatedAt) {
          var loser = null;
          try { loser = unwrap(await vault.open(remote.box)).author; } catch (e2) { loser = null; }
          FieldKit.log("warn", "store", "overwrote a newer version of " + id +
            (loser ? " by " + loser : ""));
          FieldKit.emit("store:overwrote", {
            id: id, type: type, author: loser,
            theirUpdatedAt: remote.updatedAt, oursLoadedAt: existing.meta.updatedAt
          });
        }
      } catch (e) { /* a failed check must never block a write */ }
    }

    var meta = stripBox(rec);
    meta.author = authorName();
    cache.set(id, { meta: meta, data: data });

    if (state === STATE.ONLINE) {
      try {
        await transport.putRecord(rec);
      } catch (e) {
        FieldKit.log("warn", "store", "write failed, queueing: " + e.message);
        setState(STATE.OFFLINE, "write failed");
        await queue.push({ kind: "put", rec: rec, at: rec.updatedAt });
      }
    } else {
      await queue.push({ kind: "put", rec: rec, at: rec.updatedAt });
      var ach = FieldKit.service("achievements");
      if (ach && type !== "achievement") ach.noteOfflineWrite();
    }

    FieldKit.emit("store:changed", { id: id, type: type });
    return meta;
  }

  /* ---- pulling other people's work ------------------------------
     hydrate() decrypts everything and is the right thing at unlock
     and the wrong thing every thirty seconds. This fetches only what
     actually changed: the transport's record list is plaintext
     metadata, so a comparison of updatedAt costs one request no
     matter how big the vault is. */
  async function pull() {
    if (!vault || state !== STATE.ONLINE) return { added: 0, updated: 0, removed: 0, changes: [] };

    var metas = await transport.listRecords();
    var seen = {};
    var changes = [];
    var added = 0, updated = 0, removed = 0;

    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      if (m.deletedAt) continue;
      seen[m.id] = true;
      var have = cache.get(m.id);
      if (have && have.meta.updatedAt === m.updatedAt) continue;

      var rec = await transport.getRecord(m.id);
      if (!rec || !rec.box) continue;
      try {
        var opened = await openRecord(rec);
        cache.set(rec.id, opened);
        if (have) updated++; else added++;
        changes.push({ id: rec.id, type: rec.type, author: opened.meta.author,
                       kind: have ? "updated" : "added" });
      } catch (e) {
        FieldKit.log("error", "store", "pulled record " + m.id + " would not decrypt: " + e.message);
      }
    }

    /* Anything we hold that the transport no longer lists was
       deleted by somebody else. Only trust this when we have the
       whole picture — a partial cache would delete everything. */
    if (loadedAll) {
      var gone = [];
      cache.forEach(function (e, id) { if (!seen[id]) gone.push(id); });
      gone.forEach(function (id) {
        var e = cache.get(id);
        changes.push({ id: id, type: e.meta.type, author: null, kind: "removed" });
        cache.delete(id);
        removed++;
      });
    }

    if (changes.length) {
      FieldKit.log("info", "store", "pulled " + changes.length + " change(s) from the relay");
      FieldKit.emit("store:remote", { changes: changes, added: added, updated: updated, removed: removed });
      FieldKit.emit("store:changed", { remote: true });
    }
    return { added: added, updated: updated, removed: removed, changes: changes };
  }

  /* A shared vault is only shared if the other person's work turns
     up without being asked for. Off by default for a solo vault —
     see settings.pullSeconds. */
  var pullTimer = null;

  function startAutoPull() {
    stopAutoPull();
    var s = FieldKit.service("settings");
    var secs = s ? Number(s.get("pullSeconds")) : 0;
    if (!secs || !isFinite(secs) || secs <= 0) return false;
    pullTimer = setInterval(function () {
      if (!vault || state !== STATE.ONLINE) return;
      pull().catch(function (e) {
        FieldKit.log("warn", "store", "background pull failed: " + e.message);
      });
    }, Math.max(10, secs) * 1000);
    FieldKit.log("info", "store", "auto-pull every " + secs + "s");
    return true;
  }

  function stopAutoPull() {
    if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
  }

  async function get(id) {
    requireVault();
    var e = cache.get(id);
    return e ? e.data : null;
  }

  async function list(type) {
    requireVault();
    var outp = [];
    cache.forEach(function (e, id) {
      if (!type || e.meta.type === type) outp.push({ id: id, meta: e.meta, data: e.data });
    });
    outp.sort(function (a, b) { return (b.meta.updatedAt || "").localeCompare(a.meta.updatedAt || ""); });
    return outp;
  }

  async function remove(id) {
    requireVault();
    cache.delete(id);
    if (state === STATE.ONLINE) {
      try { await transport.deleteRecord(id); }
      catch (e) { await queue.push({ kind: "delete", id: id, at: new Date().toISOString() }); }
    } else {
      await queue.push({ kind: "delete", id: id, at: new Date().toISOString() });
    }
    FieldKit.emit("store:changed", { id: id, removed: true });
    return true;
  }

  /* ---- sync --------------------------------------------------- */
  /* The queue is append-only, so replaying it is safe to retry.
     Only clears once every op has landed. */
  async function sync() {
    if (!vault) return { pushed: 0, failed: 0, skipped: "locked" };
    var reachable = false;
    try { reachable = await transport.ping(); } catch (e) { reachable = false; }
    if (!reachable) return { pushed: 0, failed: 0, skipped: "unreachable" };

    var ops = await queue.all();
    if (!ops.length) {
      if (state !== STATE.ONLINE) setState(STATE.ONLINE, "reconnected");
      return { pushed: 0, failed: 0 };
    }

    FieldKit.log("info", "store", "draining " + ops.length + " queued op(s)");
    var pushed = 0, failed = 0, lastGood = null;

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      try {
        if (op.kind === "put") await transport.putRecord(op.rec);
        else if (op.kind === "delete") await transport.deleteRecord(op.id);
        pushed++;
        lastGood = op.seq;
      } catch (e) {
        failed++;
        FieldKit.log("error", "store", "queued op failed: " + e.message);
        break;                    // stop at the first failure, preserve order
      }
    }

    if (lastGood != null) await queue.removeUpTo(lastGood);
    if (!failed) {
      setState(STATE.ONLINE, "queue drained");
      try { await hydrate(); } catch (e) { /* keep going with what we have */ }
    }
    FieldKit.emit("store:synced", { pushed: pushed, failed: failed });
    return { pushed: pushed, failed: failed };
  }

  async function pendingCount() {
    try { return await queue.count(); } catch (e) { return 0; }
  }

  /* ---- raw access, for backup --------------------------------- */
  /* Returns records exactly as the transport holds them — sealed
     boxes, not decrypted values. Backup must never see plaintext,
     so it goes through here rather than the in-memory cache. */
  /* Reads from an explicit transport when given one, the active
     transport otherwise. That default is wrong exactly once, and it
     is the case a backup exists to cover: the active transport is
     unreachable or refusing (state OFFLINE), which is precisely
     when someone needs an archive built from what is NOT broken.
     Hardcoding `transport` here made a backup impossible in its own
     motivating scenario — see FIELDKIT_PROJECT.md, "the relay that
     started but never said so". */
  async function exportRecords(t) {
    requireVault();
    var tt = t || transport;
    var metas = await tt.listRecords();
    var out = [];
    for (var i = 0; i < metas.length; i++) {
      if (metas[i].deletedAt) continue;
      var rec = await tt.getRecord(metas[i].id);
      if (rec && rec.box) out.push(rec);
    }
    return out;
  }

  /* Writes sealed records straight through, bypassing seal(). Used
     by restore, where the boxes are already encrypted under the
     vault they came from. */
  async function importRecords(records, onProgress) {
    if (!transport) throw new Error("no transport");
    var written = 0;
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec || !rec.id || !rec.box) continue;
      await transport.putRecord(rec);
      written++;
      if (onProgress) onProgress(written, records.length);
    }
    /* The cache was built from whatever was here before; anything
       restored has to be read back through the normal path. */
    cache.clear();
    loadedAll = false;
    return written;
  }

  function currentTransport() { return transport; }

  /* ---- attaching a transport after the fact --------------------
     init() picks the active transport ONCE, at boot, and setup()
     provisions whichever one that was. That leaves no path back for
     the ordinary first-time story: a fresh drive has no relay URL in
     settings yet, RELAY LINK is a module and modules are unreachable
     until a vault exists, so the very first vault a person creates
     is always local-only. Nothing afterwards ever revisits that
     choice — connect() on a later boot picks the relay for `transport`
     because it pings fine, then finds no header there, falls back to
     the cached local one, and unlocks as normal. The session reports
     TRANSPORT: RELAY the whole time. Nothing is provisioned. Nothing
     says so.

     This is what RELAY LINK's "provision this vault" action calls
     once it has pushed the header and every record onto a relay that
     had neither (via backup.restoreToTransport, which reuses the
     disaster-recovery path since uploading a vault nobody has seen
     yet is exactly that operation with a kinder name). It does not
     touch the local copy — that stays as the offline fallback it
     always was. */
  async function attachTransport(t) {
    if (!vault) throw new Error("the vault must be open to attach a transport");
    if (typeof t.setToken === "function") t.setToken(vault.authToken);
    transport = t;
    if (unprovisioned && unprovisioned.name === t.name) unprovisioned = null;
    setState(STATE.ONLINE, "attached " + t.name);
    /* Read it back through the transport now serving it. Without
       this the session keeps showing the cache built from the local
       copy, which is the same content but not the same proof — and
       the first thing anyone wants after provisioning is evidence
       it actually took. */
    try { await hydrate(); }
    catch (e) {
      FieldKit.log("warn", "store", "attached but could not hydrate: " + e.message);
      setState(STATE.OFFLINE, e.message);
      throw e;
    }
    FieldKit.emit("store:transport", { transport: t.name });
  }

  FieldKit.provide("store", {
    STATE: STATE,
    init: init,
    setup: setup,
    unlock: unlock,
    unlockWithRecovery: unlockWithRecovery,
    changePassword: changePassword,
    /* Boot and settings both need to know how the vault was opened —
       a recovery unlock should be followed by setting a password. */
    needsNewPassword: function () { return !!(vault && vault.needsNewPassword); },
    openedWithRecovery: function () { return !!(vault && vault.openedWithRecovery); },
    put: put,
    get: get,
    list: list,
    remove: remove,
    sync: sync,
    hydrate: hydrate,
    pull: pull,
    startAutoPull: startAutoPull,
    stopAutoPull: stopAutoPull,
    author: authorName,
    pendingCount: pendingCount,
    exportRecords: exportRecords,
    importRecords: importRecords,
    transport: currentTransport,
    attachTransport: attachTransport,
    /* The transport that answered but has no vault on it, if any.
       Null once it has been provisioned or if there never was one. */
    unprovisionedTransport: function () { return unprovisioned; },
    header: function () { return header; },
    state: function () { return state; },
    isUnlocked: function () { return !!vault; },
    hasVault: function () { return !!header; },
    initialised: function () { return initialised; },
    canReadHistory: function () { return loadedAll; },
    vault: function () { return vault; },
    transportName: function () { return transport ? transport.name : "none"; },
    deviceId: function () { return deviceId; }
  });
})(window.FieldKit);
