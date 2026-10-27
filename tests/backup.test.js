/* ============================================================
   core/backup.js — cold backup and disaster recovery.

   Two properties carry the whole feature:
     1. an archive never contains plaintext, a key, or a token
     2. a corrupted archive is refused, not silently restored

   Everything else is convenience. These run against a REAL vault
   built by core/crypto.js, so the sealed boxes here are the same
   ones the relay would hold.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js",
  "core/crypto.js", "core/store.js", "core/backup.js"
]);
const { ok, section, state } = makeRunner("backup");
const backup = FieldKit.need("backup");
const crypto_ = FieldKit.need("crypto");

/* A transport that behaves like the relay: it holds sealed records
   and a vault header, and knows nothing else. */
function makeTransport(name) {
  let header = null;
  const recs = new Map();
  return {
    name: name || "test",
    _recs: recs,
    async ping() { return true; },
    async loadHeader() { return header; },
    async saveHeader(h) { header = h; return h; },
    async listRecords() {
      return [...recs.entries()].map(([id, r]) => ({ id, type: r.type, updatedAt: r.updatedAt }));
    },
    async getRecord(id) { return recs.get(id) || null; },
    async putRecord(rec) { recs.set(rec.id, JSON.parse(JSON.stringify(rec))); return rec; },
    async deleteRecord(id) { recs.delete(id); return true; },
    setToken() {}
  };
}

function memQueue() {
  let ops = [], seq = 0;
  return {
    async push(o) { o.seq = ++seq; ops.push(o); return o; },
    async all() { return ops.slice(); },
    async count() { return ops.length; },
    async removeUpTo(s) { ops = ops.filter((o) => o.seq > s); return true; }
  };
}

const PASSWORD = "correct-horse-battery-staple";
const store = FieldKit.need("store");

(async function () {
  FieldKit.provide("queue", memQueue());
  FieldKit.provide("deviceId", async () => "test-device");
  FieldKit.provide("transportLocal", makeTransport("local"));

  const relay = makeTransport("relay");
  await store.init([relay]);
  const made = await store.setup(PASSWORD, { iterations: 1000 });

  const CANARY = "PLAINTEXT-CANARY-9f3a2b7c";
  const TOKEN = "PROVISION-CANARY-4d8e1a";

  /* The bearer credential for record uploads — deliberately NOT
     TOKEN above, which is the provision-token canary this suite uses
     to prove that secret never reaches an archive. The two authorise
     different halves of a restore and conflating them in a test is
     how the real difference stayed hidden. */
  const AUTH = store.vault().authToken;

  await store.put("note", { title: "TITLE-CANARY-ALPHA", body: CANARY });
  await store.put("note", { title: "TITLE-CANARY-BRAVO", body: "ordinary content" });
  await store.put("snippet", { title: "TITLE-CANARY-CHARLIE", body: "console.log(1)" });
  FieldKit.need("settings").set("relayProvisionToken", TOKEN);
  FieldKit.need("settings").set("theme", "cyan");

  /* ---------- build ---------- */
  section("building an archive");
  let archive;
  {
    archive = await backup.build();
    ok("format and version are stamped",
      archive.format === "fieldkit-archive" && archive.v === backup.FORMAT_VERSION);
    ok("it carries the vault header", !!(archive.vault && archive.vault.kdf && archive.vault.wrap));
    ok("every record is present", archive.records.length === 3, String(archive.records.length));
    ok("the manifest count agrees", archive.counts.records === archive.records.length);
    ok("types are summarised", archive.counts.types.note === 2 && archive.counts.types.snippet === 1,
      JSON.stringify(archive.counts.types));
    ok("it records the app and schema version",
      archive.appVersion === FieldKit.VERSION && archive.schemaVersion === FieldKit.SCHEMA_VERSION);
    ok("it has a checksum", /^[0-9a-f]{64}$/.test(archive.checksum || ""));
  }

  /* ---------- the property everything rests on ---------- */
  section("an archive contains nothing readable");
  {
    const raw = JSON.stringify(archive);
    ok("the plaintext canary is absent", raw.indexOf(CANARY) < 0);
    ok("no record title leaks", raw.indexOf("TITLE-CANARY") < 0);
    ok("the provision token is absent", raw.indexOf(TOKEN) < 0);
    ok("the password is absent", raw.indexOf(PASSWORD) < 0);
    ok("the recovery key is absent", raw.indexOf(made.recoveryKey.replace(/-/g, "")) < 0 &&
      raw.indexOf(made.recoveryKey) < 0);
    ok("the derived auth token is absent", raw.indexOf(store.vault().authToken) < 0);

    ok("every record carries a sealed box",
      archive.records.every((r) => r.box && r.box.iv && r.box.ct));
    ok("records carry no field beyond the sealed shape",
      archive.records.every((r) => Object.keys(r).every((k) =>
        ["id", "type", "createdAt", "updatedAt", "deviceId", "schemaVersion", "box"].includes(k))),
      JSON.stringify(Object.keys(archive.records[0])));

    /* Metadata is plaintext by design (§13) — assert exactly that,
       so the boundary stays a known quantity rather than a surprise. */
    ok("record type IS visible, as documented", raw.indexOf('"note"') >= 0);
  }

  section("settings in the archive");
  {
    ok("non-secret settings travel", archive.settings && archive.settings.theme === "cyan");
    ok("the provision token is stripped", !("relayProvisionToken" in (archive.settings || {})));
    ok("the denylist is exactly what is stripped",
      backup.SETTINGS_DENYLIST.every((k) => !(k in (archive.settings || {}))));

    FieldKit.need("settings").set("wallpaper", "data:image/png;base64," + "A".repeat(4000));
    const withWall = await backup.build();
    ok("an uploaded wallpaper is omitted rather than bloating the archive",
      withWall.settings.wallpaper === null && withWall.settings._wallpaperOmitted === true);
    ok("omitting it keeps the archive small", JSON.stringify(withWall).indexOf("A".repeat(200)) < 0);
    FieldKit.need("settings").set("wallpaper", null);
  }

  /* ---------- parse + verify ---------- */
  section("parsing");
  {
    const round = backup.parse(JSON.stringify(archive));
    ok("a round trip through JSON parses", round.records.length === 3);

    const cases = [
      ["", /JSON/],
      ["not json", /JSON/],
      ['{"format":"other"}', /not a FieldKit archive/],
      ['{"format":"fieldkit-archive","v":99,"vault":{"kdf":{},"wrap":{}},"records":[]}', /newer/],
      ['{"format":"fieldkit-archive","v":1,"records":[]}', /vault header/],
      ['{"format":"fieldkit-archive","v":1,"vault":{"kdf":{},"wrap":{}}}', /record list/],
      ['{"format":"fieldkit-archive","v":1,"vault":{},"records":[]}', /vault header/]
    ];
    let allRejected = true, detail = [];
    for (const [input, pattern] of cases) {
      let msg = null;
      try { backup.parse(input); } catch (e) { msg = e.message; }
      if (!msg || !pattern.test(msg)) {
        allRejected = false;
        detail.push(JSON.stringify(input).slice(0, 30) + " -> " + msg);
      }
    }
    ok("every malformed input is rejected with a specific message", allRejected, detail.join(" | "));
  }

  section("verification catches tampering");
  {
    const clean = await backup.verify(archive);
    ok("an untouched archive verifies", clean.intact && clean.ok, clean.issues.join("; "));

    async function mutate(fn) {
      const c = JSON.parse(JSON.stringify(archive));
      fn(c);
      return backup.verify(c);
    }

    ok("a flipped ciphertext byte is caught",
      !(await mutate((c) => { c.records[0].box.ct = "ZZ" + c.records[0].box.ct.slice(2); })).intact);
    ok("a changed record id is caught",
      !(await mutate((c) => { c.records[0].id = "somethingelse"; })).intact);
    ok("a removed record is caught",
      !(await mutate((c) => { c.records.pop(); })).intact);
    ok("an added record is caught",
      !(await mutate((c) => { c.records.push(JSON.parse(JSON.stringify(c.records[0]))); })).intact);
    ok("an altered vault header is caught",
      !(await mutate((c) => { c.vault.kdf.iterations = 1; })).intact);
    ok("altered settings are caught",
      !(await mutate((c) => { c.settings.theme = "rust"; })).intact);
    ok("a swapped checksum is caught",
      !(await mutate((c) => { c.checksum = "0".repeat(64); })).intact);

    /* Reordering must NOT trip it — canonical form sorts keys, and a
       transport is free to hand records back in any order. */
    const reordered = JSON.parse(JSON.stringify(archive));
    reordered.records.reverse();
    const r = await backup.verify(reordered);
    ok("reordering records still verifies", r.intact, r.issues.join("; "));

    const rekeyed = JSON.parse(JSON.stringify(archive));
    rekeyed.records = rekeyed.records.map((rec) => {
      const out = {};
      Object.keys(rec).reverse().forEach((k) => { out[k] = rec[k]; });
      return out;
    });
    ok("reordering keys within a record still verifies", (await backup.verify(rekeyed)).intact);

    const dupes = JSON.parse(JSON.stringify(archive));
    dupes.records.push(dupes.records[0]);
    dupes.checksum = await backup.checksum({
      vault: dupes.vault, records: dupes.records, settings: dupes.settings });
    const dr = await backup.verify(dupes);
    ok("duplicate ids are reported even when the checksum matches",
      dr.intact && !dr.ok && dr.issues.some((i) => /duplicate/.test(i)), dr.issues.join("; "));
  }

  /* ---------- vault identity ---------- */
  section("telling vaults apart");
  {
    ok("an archive matches the vault it came from",
      backup.sameVaultAs(archive, store.header()));

    const foreign = JSON.parse(JSON.stringify(archive));
    foreign.vault.authKeyHash = "a-different-vault";
    ok("a different auth hash does not match", !backup.sameVaultAs(foreign, store.header()));
    ok("a missing header does not match", !backup.sameVaultAs(archive, null));
    ok("a header with no auth hash does not match",
      !backup.sameVaultAs(archive, { kdf: {}, wrap: {} }));
  }

  /* ---------- the disaster-recovery path ---------- */
  section("restoring into a fresh, empty transport");
  {
    const fresh = makeTransport("fresh-relay");
    const steps = [];
    const result = await backup.restoreToTransport(archive, fresh,
      (n, total) => steps.push(n + "/" + total), { token: AUTH });

    ok("the header was uploaded", !!(await fresh.loadHeader()));
    ok("every record was uploaded", result.records === 3, String(result.records));
    ok("progress was reported", steps.length >= 3, steps.join(" "));
    ok("the fresh transport now holds the same ids",
      (await fresh.listRecords()).map((r) => r.id).sort().join(",") ===
      archive.records.map((r) => r.id).sort().join(","));

    /* The real proof: a brand-new session, pointed at the restored
       transport, opens it with nothing but the original password. */
    await store.init([fresh]);
    ok("the restored transport reports a vault", store.hasVault());
    await store.unlock(PASSWORD);
    ok("the original password unlocks the restored vault", store.isUnlocked());

    const notes = await store.list("note");
    ok("every note came back", notes.length === 2, String(notes.length));
    ok("the content decrypts to exactly what went in",
      notes.some((n) => n.data.body === CANARY), JSON.stringify(notes.map((n) => n.data.title)));
    ok("the snippet came back too", (await store.list("snippet")).length === 1);
  }

  section("a restore that cannot authenticate refuses before it starts");
  {
    /* The header provisions with the one-time provision token; every
       record after it is an ordinary authenticated write. Uploading
       the header and then failing on record one leaves a relay that
       is provisioned and empty — indistinguishable from a successful
       restore unless you go looking for the data. So it is refused
       up front instead. */
    const target = makeTransport("no-token");
    let msg = null;
    try { await backup.restoreToTransport(archive, target); }
    catch (e) { msg = e.message; }
    ok("restoring records without an auth token is refused", !!msg, String(msg));
    ok("...naming what to pass", /auth token|headerOnly/i.test(String(msg)));
    ok("...before writing anything at all", !(await target.loadHeader()));

    /* headerOnly is the boot-restore path: the password has not been
       typed yet, so no token can exist. The header goes up, the user
       unlocks, and the records merge in authenticated. */
    const staged = makeTransport("header-first");
    const r = await backup.restoreToTransport(archive, staged, null, { headerOnly: true });
    ok("headerOnly uploads the header", !!(await staged.loadHeader()) && r.header === true);
    ok("...and writes no records", r.records === 0 && (await staged.listRecords()).length === 0);
  }

  section("restore refuses to clobber");
  {
    const occupied = makeTransport("occupied");
    await occupied.saveHeader({ kdf: { salt: "x", iterations: 1 }, wrap: {},
      authKeyHash: "somebody-elses-vault" });
    let msg = null;
    try { await backup.restoreToTransport(archive, occupied, null, { token: AUTH }); }
    catch (e) { msg = e.message; }
    ok("restoring over a different vault is refused", !!msg && /different vault/.test(msg), String(msg));
    ok("nothing was written", (await occupied.listRecords()).length === 0);

    /* Restoring over the SAME vault is fine — that is a re-sync. */
    const same = makeTransport("same");
    await same.saveHeader(archive.vault);
    let ok2 = true;
    try { await backup.restoreToTransport(archive, same, null, { token: AUTH }); }
    catch (e) { ok2 = false; }
    ok("restoring over the same vault is allowed", ok2);

    const corrupt = JSON.parse(JSON.stringify(archive));
    corrupt.records[0].box.ct = "ZZ" + corrupt.records[0].box.ct.slice(2);
    const target = makeTransport("target");
    let cmsg = null;
    try { await backup.restoreToTransport(corrupt, target, null, { token: AUTH }); }
    catch (e) { cmsg = e.message; }
    ok("a corrupted archive is refused before anything is written", !!cmsg, String(cmsg));
    ok("the target is untouched", !(await target.loadHeader()) &&
      (await target.listRecords()).length === 0);
  }

  /* ---------- merge ---------- */
  section("merging into an open vault");
  {
    /* The store is open on the restored transport from the section
       above. Stamp a copy of the archive as belonging elsewhere. */
    const foreign = JSON.parse(JSON.stringify(archive));
    foreign.vault = Object.assign({}, foreign.vault, { authKeyHash: "another-vault-entirely" });
    let msg = null;
    try { await backup.mergeIntoOpenVault(foreign, {}); } catch (e) { msg = e.message; }
    ok("merging an archive from another vault is refused",
      !!msg && /different vault/.test(msg), String(msg));

    const before = await store.list();
    const victim = before.find((r) => r.meta.type === "snippet");
    await store.remove(victim.id);
    ok("a record was removed for the test", (await store.list()).length === before.length - 1);

    const r1 = await backup.mergeIntoOpenVault(archive, {});
    ok("the missing record was written back", r1.written === 1, JSON.stringify(r1));
    ok("the rest were recognised as already present", r1.alreadyPresent === 2, JSON.stringify(r1));
    ok("the vault is whole again", (await store.list()).length === before.length);
    ok("the merged record decrypts",
      (await store.list("snippet"))[0].data.body === "console.log(1)");

    const r2 = await backup.mergeIntoOpenVault(archive, {});
    ok("merging again writes nothing", r2.written === 0, JSON.stringify(r2));

    /* An older archive must not overwrite newer live content. */
    const target = (await store.list("note"))[0];
    await store.put("note", { title: "edited since the backup", body: "newer" }, { id: target.id });
    const r3 = await backup.mergeIntoOpenVault(archive, {});
    ok("a stale archive does not overwrite newer records", r3.written === 0, JSON.stringify(r3));
    ok("the newer content survived",
      (await store.get(target.id)).body === "newer");

    const r4 = await backup.mergeIntoOpenVault(archive, { overwrite: true });
    ok("overwrite mode does replace it", r4.written === 3, JSON.stringify(r4));
    ok("the archive's version is back", (await store.get(target.id)).body !== "newer");
  }

  /* ---------- plaintext export is clearly marked ---------- */
  section("plaintext export");
  {
    const plain = await backup.buildPlaintext();
    ok("it is a distinct format, not an archive", plain.format === "fieldkit-plaintext-export");
    ok("it says what it is", /NOT ENCRYPTED/.test(plain.warning || ""));
    ok("it does contain readable content — that is its purpose",
      JSON.stringify(plain).indexOf(CANARY) >= 0 ||
      plain.records.some((r) => JSON.stringify(r.data).length > 2));
    let msg = null;
    try { backup.parse(JSON.stringify(plain)); } catch (e) { msg = e.message; }
    ok("it cannot be mistaken for an archive on import", !!msg, String(msg));
  }

  /* ---------- reminder ---------- */
  section("backup reminder");
  {
    const settings = FieldKit.need("settings");
    settings.set("backupReminderDays", 0);
    ok("a zero interval never nags", backup.reminder() === null);

    settings.set("backupReminderDays", 14);
    global.localStorage.removeItem("fieldkit.lastBackup");
    const never = backup.reminder();
    ok("with no backup ever taken it says so",
      never && never.overdue && /NO BACKUP HAS EVER BEEN TAKEN/.test(never.text), JSON.stringify(never));

    backup.noteBackupTaken();
    ok("straight after a backup it is quiet", backup.reminder() === null);
    ok("the timestamp is recorded", Math.abs(Date.now() - backup.lastBackupAt()) < 5000);

    global.localStorage.setItem("fieldkit.lastBackup", String(Date.now() - 20 * 86400000));
    const stale = backup.reminder();
    ok("after the interval it speaks up", stale && stale.days >= 20, JSON.stringify(stale));
    settings.set("backupReminderDays", 14);
  }

  /* ---------- the local snapshot ring ---------- */
  section("automatic local snapshots");
  {
    /* Stands in for the IndexedDB store, same interface. */
    const held = new Map();
    FieldKit.provide("snapshots", {
      available: true,
      async put(e) { held.set(e.at, e); return e; },
      async list() {
        return [...held.values()].map((e) => ({ at: e.at, reason: e.reason,
          records: e.records, bytes: e.bytes, checksum: e.checksum }))
          .sort((a, b) => b.at - a.at);
      },
      async get(at) { return held.get(at) || null; },
      async remove(at) { held.delete(at); return true; },
      async clear() { held.clear(); return true; }
    });

    const settings = FieldKit.need("settings");
    settings.set("autoSnapshotKeep", 3);

    const first = await backup.takeSnapshot("manual");
    ok("a snapshot is taken on demand", !!first && first.records > 0, JSON.stringify(first));
    ok("it records why it was taken", first.reason === "manual");
    ok("it records its size", first.bytes > 0 && first.records === (await store.list()).length);

    const stored = await backup.getSnapshot(first.at);
    ok("it can be read back as an archive", !!stored && stored.format === "fieldkit-archive");
    ok("what came back verifies", (await backup.verify(stored)).intact);

    /* The property that matters: what sits at rest is sealed. */
    const marker = "SNAPSHOT-CANARY-8b1f";
    await store.put("note", { title: "TITLE-CANARY-DELTA", body: marker });
    const sealed = await backup.takeSnapshot("manual");
    ok("a later snapshot picks up the new record", sealed.records === first.records + 1,
      sealed.records + " vs " + first.records);
    ok("nothing in stored snapshot data is readable",
      JSON.stringify([...held.values()]).indexOf(marker) < 0);

    /* Several inside one millisecond must not collide on the key. */
    const burst = [];
    for (let i = 0; i < 4; i++) burst.push(await backup.takeSnapshot("manual"));
    ok("every snapshot in a burst got a distinct key",
      new Set(burst.map((s) => s.at)).size === burst.length,
      burst.map((s) => s.at).join(","));

    const list = await backup.listSnapshots();
    ok("the ring is pruned to the keep count", list.length === 3, String(list.length));
    ok("it keeps the newest, not the oldest", list[0].at === burst[burst.length - 1].at);
    ok("it is listed newest first", list.every((s, i) => i === 0 || list[i - 1].at > s.at));

    settings.set("autoSnapshotKeep", 1);
    await backup.pruneSnapshots();
    ok("lowering the limit prunes immediately", (await backup.listSnapshots()).length === 1);
    settings.set("autoSnapshotKeep", 3);

    /* A guest's scratch data must never land in the owner's ring. */
    const realStore = FieldKit.need("store");
    FieldKit.provide("store", Object.assign({}, realStore, { isGuest: true }));
    const guestSnap = await backup.takeSnapshot("manual");
    FieldKit.provide("store", realStore);
    ok("a guest session takes no snapshot", guestSnap === null);
    ok("the ring is unchanged after a guest tried",
      (await backup.listSnapshots()).length === 1);

    /* "Not applicable" and "tried and broke" must not look alike. */
    FieldKit.provide("snapshots", null);
    const noStore = await backup.takeSnapshot("manual");
    const noList = await backup.listSnapshots();
    FieldKit.provide("snapshots", { available: false });
    const offStore = await backup.takeSnapshot("manual");
    ok("with no snapshot storage it returns null rather than throwing",
      noStore === null && offStore === null);
    ok("listing with no storage returns an empty list",
      Array.isArray(noList) && noList.length === 0);

    FieldKit.provide("snapshots", {
      available: true,
      async put() { throw new Error("QuotaExceededError"); },
      async list() { return []; },
      async get() { return null; },
      async remove() { return true; }
    });
    let broke = null;
    try { await backup.takeSnapshot("manual"); } catch (e) { broke = e.message; }
    ok("storage that is present but broken reports the failure",
      broke === "QuotaExceededError", String(broke));
    ok("listing survives broken storage", (await backup.listSnapshots()).length === 0);
  }

  /* ---------- canonicalisation ---------- */
  section("canonical form");
  {
    ok("key order does not change the output",
      backup.canonical({ b: 1, a: 2 }) === backup.canonical({ a: 2, b: 1 }));
    ok("nested key order does not change the output",
      backup.canonical({ x: { q: 1, p: 2 } }) === backup.canonical({ x: { p: 2, q: 1 } }));
    ok("array order DOES change the output",
      backup.canonical([1, 2]) !== backup.canonical([2, 1]));
    ok("null and undefined-ish values are stable",
      backup.canonical({ a: null }) === backup.canonical({ a: null }));
    ok("different values produce different output",
      backup.canonical({ a: 1 }) !== backup.canonical({ a: 2 }));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + e.stack);
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});
