/* ============================================================
   Two people, one vault.

   The design already allowed this — a vault is tied to a password,
   not a device — so none of this is about granting access. It is
   about the three things that make shared editing either trusted
   or quietly destructive:

     1. authorship survives the round trip, and does NOT leak into
        the plaintext metadata the relay can read
     2. pull() brings the other person's work in without a full
        re-decrypt of everything
     3. when last-write-wins throws work away, somebody is told

   Two independent store instances would be ideal. There is one
   module instance per process, so the second person is simulated
   by writing to the shared transport directly with a second vault
   handle — which is exactly what their machine would be doing.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js",
  "core/crypto.js", "core/store.js"
]);
const { ok, section, state } = makeRunner("shared");
const store = FieldKit.need("store");
const crypto_ = FieldKit.need("crypto");
const settings = FieldKit.need("settings");

function makeTransport(name) {
  let header = null;
  const recs = new Map();
  return {
    name: name || "relay",
    _recs: recs,
    calls: { list: 0, get: 0, put: 0 },
    async ping() { return true; },
    async loadHeader() { return header; },
    async saveHeader(h) { header = h; return h; },
    async listRecords() {
      this.calls.list++;
      return [...recs.entries()].map(([id, r]) => ({ id, type: r.type, updatedAt: r.updatedAt }));
    },
    async getRecord(id) { this.calls.get++; return recs.get(id) || null; },
    async putRecord(rec) { this.calls.put++; recs.set(rec.id, JSON.parse(JSON.stringify(rec))); return rec; },
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

const PASSWORD = "a-shared-passphrase-for-two";

(async function () {
  FieldKit.provide("queue", memQueue());
  FieldKit.provide("deviceId", async () => "machine-one");
  FieldKit.provide("transportLocal", makeTransport("local"));

  const relay = makeTransport("relay");
  await store.init([relay]);
  await store.setup(PASSWORD, { iterations: 1000 });

  /* The second person: same password, own machine, own vault handle. */
  const theirVault = await crypto_.unlockVault(store.header(), PASSWORD);

  section("the second person can open it at all");
  {
    ok("the same password unlocks from another machine", !!theirVault);
    ok("they derive the same auth token", theirVault.authToken === store.vault().authToken);

    const wrong = await crypto_.unlockVault(store.header(), "not-the-password").catch(() => null);
    ok("a wrong password still does not", wrong === null);
  }

  /* Writing as them: same shape store.put() produces, sealed with
     their own vault handle. */
  let theirSeq = 0;
  async function theyWrite(id, type, data, author) {
    const now = new Date(Date.now() + (++theirSeq)).toISOString();
    const existing = relay._recs.get(id);
    await relay.putRecord({
      id, type,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
      deviceId: "machine-two",
      schemaVersion: FieldKit.SCHEMA_VERSION,
      box: await theirVault.seal({ __fk: 1, a: author, d: data })
    });
    return now;
  }

  section("authorship");
  {
    settings.set("displayName", "ALEX");
    const mine = await store.put("note", { title: "mine", body: "written by me" });
    ok("my name is on what I write", mine.author === "ALEX", JSON.stringify(mine));

    const raw = relay._recs.get(mine.id);
    ok("the record still has exactly the sealed shape",
      Object.keys(raw).sort().join(",") ===
      "box,createdAt,deviceId,id,schemaVersion,type,updatedAt",
      Object.keys(raw).join(","));

    /* The point of putting the author inside the box. */
    ok("the name is NOT in the plaintext metadata",
      JSON.stringify({ id: raw.id, type: raw.type, createdAt: raw.createdAt,
        updatedAt: raw.updatedAt, deviceId: raw.deviceId }).indexOf("ALEX") < 0);
    ok("the name is not anywhere the relay can read it",
      JSON.stringify([...relay._recs.values()].map((r) => Object.assign({}, r, { box: null })))
        .indexOf("ALEX") < 0);

    settings.set("displayName", "");
    const anon = await store.put("note", { title: "anon", body: "no name set" });
    ok("no name set means no author, not an empty string", anon.author === null,
      JSON.stringify(anon.author));
    ok("the record is still perfectly readable",
      (await store.get(anon.id)).body === "no name set");

    settings.set("displayName", "  A NAME WITH SPACE  ");
    const trimmed = await store.put("note", { title: "t", body: "x" });
    ok("the name is trimmed", trimmed.author === "A NAME WITH SPACE", trimmed.author);

    settings.set("displayName", "N".repeat(200));
    const capped = await store.put("note", { title: "c", body: "x" });
    ok("an absurd name is capped rather than stored whole", capped.author.length === 40,
      String(capped.author.length));
    settings.set("displayName", "ALEX");
  }

  section("records written before authorship existed");
  {
    /* Sealed the old way: the payload IS the data, no envelope. */
    const legacyId = "legacy-record-0001";
    await relay.putRecord({
      id: legacyId, type: "note",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      deviceId: "machine-zero", schemaVersion: FieldKit.SCHEMA_VERSION,
      box: await theirVault.seal({ title: "old", body: "written before envelopes existed" })
    });
    await store.hydrate();

    ok("a legacy record still decrypts",
      (await store.get(legacyId)).body === "written before envelopes existed");
    const rows = await store.list("note");
    const legacy = rows.find((r) => r.id === legacyId);
    ok("it reports no author rather than failing", legacy.meta.author === null);
    ok("nothing else was disturbed", rows.length > 1);

    /* And a rewrite upgrades it in place. */
    await store.put("note", { title: "old", body: "now rewritten" }, { id: legacyId });
    await store.hydrate();
    const after = (await store.list("note")).find((r) => r.id === legacyId);
    ok("rewriting a legacy record attaches an author", after.meta.author === "ALEX");
    ok("and keeps its original creation time",
      after.meta.createdAt !== after.meta.updatedAt);
  }

  section("pulling their work");
  {
    await store.hydrate();
    const before = (await store.list()).length;

    const theirId = "their-note-0001";
    await theyWrite(theirId, "note", { title: "theirs", body: "from machine two" }, "SAM");

    ok("their record is not visible before pulling", (await store.get(theirId)) === null);

    const r = await store.pull();
    ok("pull reports what arrived", r.added === 1 && r.updated === 0, JSON.stringify(r));
    ok("their content decrypts here", (await store.get(theirId)).body === "from machine two");
    ok("their name came with it", r.changes[0].author === "SAM", JSON.stringify(r.changes));
    ok("the vault grew by exactly one", (await store.list()).length === before + 1);

    const quiet = await store.pull();
    ok("pulling again finds nothing", quiet.added === 0 && quiet.updated === 0 &&
      quiet.changes.length === 0, JSON.stringify(quiet));
  }

  section("pull only fetches what changed");
  {
    await store.hydrate();
    const total = (await store.list()).length;
    relay.calls.get = 0;
    relay.calls.list = 0;

    await store.pull();
    ok("an unchanged vault costs one list and no record fetches",
      relay.calls.list === 1 && relay.calls.get === 0,
      "list " + relay.calls.list + ", get " + relay.calls.get);

    await theyWrite("their-note-0002", "snippet", { title: "s", body: "y" }, "SAM");
    relay.calls.get = 0;
    await store.pull();
    ok("one changed record costs exactly one fetch", relay.calls.get === 1,
      String(relay.calls.get));
    ok("regardless of how many records exist", total >= 4, String(total));
  }

  section("their edits to an existing record");
  {
    const id = "shared-doc-0001";
    await store.put("note", { title: "doc", body: "first draft" }, { id: id });
    await theyWrite(id, "note", { title: "doc", body: "their revision" }, "SAM");

    const r = await store.pull();
    ok("it counts as updated, not added", r.updated === 1 && r.added === 0, JSON.stringify(r));
    ok("their version is what I now hold", (await store.get(id)).body === "their revision");
    const row = (await store.list("note")).find((x) => x.id === id);
    ok("the author flipped to them", row.meta.author === "SAM", String(row.meta.author));
  }

  section("their deletions");
  {
    const id = "doomed-0001";
    await store.put("note", { title: "doomed", body: "delete me" }, { id: id });
    await store.hydrate();
    ok("it is here to begin with", !!(await store.get(id)));

    relay._recs.delete(id);
    const r = await store.pull();
    ok("a deletion elsewhere is picked up", r.removed === 1, JSON.stringify(r));
    ok("the record is gone locally", (await store.get(id)) === null);
    ok("it is reported, not silent",
      r.changes.some((c) => c.id === id && c.kind === "removed"));
  }

  section("a partial cache must never delete everything");
  {
    /* The dangerous case: pull() decides a record is gone because
       it is absent from a cache that was never fully loaded. */
    await store.hydrate();
    const total = (await store.list()).length;
    await store.init([relay]);
    await store.unlock(PASSWORD);
    ok("everything is still here after a fresh unlock",
      (await store.list()).length === total, (await store.list()).length + " of " + total);

    const r = await store.pull();
    ok("and a pull straight afterwards removes nothing", r.removed === 0, JSON.stringify(r));
  }

  section("last write wins, and says so");
  {
    const events = [];
    FieldKit.on("store:overwrote", (e) => events.push(e));

    const id = "contested-0001";
    await store.put("note", { title: "c", body: "my version" }, { id: id });
    await store.hydrate();

    /* They save after I loaded it, and I save again without pulling. */
    await theyWrite(id, "note", { title: "c", body: "their version" }, "SAM");
    await store.put("note", { title: "c", body: "my second version" }, { id: id });

    ok("the overwrite was announced", events.length === 1, JSON.stringify(events));
    ok("it names whose work was lost", events[0] && events[0].author === "SAM",
      JSON.stringify(events[0]));
    ok("it names the record", events[0] && events[0].id === id);
    ok("my write still went through — it is a warning, not a block",
      (await store.get(id)).body === "my second version");

    events.length = 0;
    await store.put("note", { title: "c", body: "third" }, { id: id });
    ok("writing over my own newer version says nothing", events.length === 0,
      JSON.stringify(events));

    events.length = 0;
    await store.put("note", { title: "brand new", body: "x" });
    ok("a brand new record says nothing", events.length === 0);
  }

  section("background pull is opt-in");
  {
    settings.set("pullSeconds", 0);
    ok("a solo vault does not poll", store.startAutoPull() === false);

    settings.set("pullSeconds", 30);
    ok("setting an interval starts it", store.startAutoPull() === true);
    store.stopAutoPull();

    settings.set("pullSeconds", -5);
    ok("a nonsense interval is refused rather than spinning", store.startAutoPull() === false);
    settings.set("pullSeconds", 0);
  }

  section("pull is safe when it cannot work");
  {
    const locked = makeTransport("locked");
    await store.init([locked]);
    let threw = null;
    let r = null;
    try { r = await store.pull(); } catch (e) { threw = e; }
    ok("pulling a locked vault does not throw", !threw, threw && threw.message);
    ok("it reports nothing rather than pretending",
      r && r.added === 0 && r.updated === 0 && r.changes.length === 0, JSON.stringify(r));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + e.stack);
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});
