/* ============================================================
   core/store.js :: attachTransport, and the gap it closes.

   Reported bug: a vault created before any relay was configured —
   which is the ordinary shape of a first boot on a fresh drive,
   since RELAY LINK is a module and modules are unreachable until a
   vault exists — has no path onto a relay afterward. A later boot
   picks the relay as `transport` because it pings fine, finds no
   header there, falls back to the cached local one, and unlocks
   normally. The session reports TRANSPORT: RELAY the whole time.
   Nothing is ever provisioned, and nothing said so.

   This suite reproduces that shape with fake transports that model
   the one behaviour that matters: a relay with no vault throws on
   an authenticated call, the way the real one's requireAuth() does
   on GET /records with no header on disk. Then it proves the fix —
   store.attachTransport(), fed by backup.build() +
   backup.restoreToTransport(), which is the code RELAY LINK's
   "provision this vault on the relay" action runs.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js",
  "core/crypto.js", "core/store.js", "core/backup.js"
]);
const { ok, section, state } = makeRunner("relay-provision");
const backup = FieldKit.need("backup");
const store = FieldKit.need("store");

/* Local transport: behaves like transport-local.js always does —
   readable and writable the moment a header exists on it. */
function makeLocal() {
  let header = null;
  const recs = new Map();
  return {
    name: "local",
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

/* Relay stand-in: reachable (ping true) whether or not a vault has
   ever been provisioned on it — that is exactly what makes the real
   bug invisible from the connection status alone.

   It also DEMANDS A BEARER TOKEN on every record route, which the
   fakes in the other suites do not. That omission is not cosmetic:
   with a no-op setToken(), backup.restoreToTransport() passed here
   for months while failing against a real relay, because the header
   provisions with the one-time provision token and every record
   after it needs Bearer hex(authKey). The header landed, the first
   record came back 401, and the relay was left provisioned and
   empty — looking exactly like a successful restore. A fake that
   cannot say "unauthorized" cannot catch that. */
function makeRelay(name) {
  let header = null;
  const recs = new Map();
  let token = null;
  function auth() {
    if (!header) throw Object.assign(new Error("no vault provisioned"), { status: 401 });
    if (!token) throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  return {
    name: name || "relay",
    async ping() { return true; },                 // reachable regardless of provisioning
    async loadHeader() { return header; },          // null == 404, matching transport-relay.js
    /* Provisioning is the one write that does NOT need a bearer
       token — it is authorised by the provision token instead. */
    async saveHeader(h) {
      if (header) throw Object.assign(new Error("vault already exists"), { status: 409 });
      header = h; return h;
    },
    async listRecords() {
      auth();
      return [...recs.entries()].map(([id, r]) => ({ id, type: r.type, updatedAt: r.updatedAt }));
    },
    async getRecord(id) { auth(); return recs.get(id) || null; },
    async putRecord(rec) { auth(); recs.set(rec.id, JSON.parse(JSON.stringify(rec))); return rec; },
    async deleteRecord(id) { auth(); recs.delete(id); return true; },
    setToken(t) { token = t; },
    _hasVault: () => !!header,
    _recCount: () => recs.size,
    _token: () => token
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

const PASSWORD = "correct horse battery staple";

(async function () {
  FieldKit.provide("queue", memQueue());
  FieldKit.provide("deviceId", async () => "test-device");

  const local = makeLocal();
  FieldKit.provide("transportLocal", local);

  section("a reachable but unprovisioned relay does not win the election");
  {
    /* Boot 1 — a fresh drive, no relay configured yet. Exactly what
       setupFlow() does the first time anyone runs FieldKit. */
    await store.init([local]);
    await store.setup(PASSWORD, { iterations: 1000 });
    const id1 = await store.put("note", { text: "written before any relay existed" });
    ok("a record exists in the local-only vault", !!id1.id);

    /* Boot 2 — the user has since opened RELAY LINK, typed a URL,
       hit SAVE, and restarted. The relay is reachable and has never
       seen this vault. This is store.init() exactly as boot.js's
       connect() calls it: relay first in the list, local as
       fallback. */
    const relay = makeRelay("never-provisioned");
    const boot2 = await store.init([relay, local]);

    /* The relay pings fine and holds no vault. Before the fix it won
       the election on ping alone and the header came from the local
       cache instead — two transports supplying connection and
       identity separately, which is the whole bug. The session then
       read RELAY / ONLINE while every authenticated call it made was
       refused. */
    ok("the store falls back to the transport that actually holds the vault",
      boot2.transport === "local");
    ok("...and does not claim a remote connection", boot2.online === false);
    ok("...and names the relay that needs provisioning",
      boot2.unprovisioned === "never-provisioned");
    ok("...with the vault still perfectly usable", boot2.state === "LOCKED");
    ok("the store exposes it for RELAY LINK to act on",
      store.unprovisionedTransport() === relay);

    /* Unlock, mirroring boot.js's unlockFlow -> store.unlock(). */
    await store.unlock(PASSWORD);

    ok("the session runs against local storage, working normally",
      store.transport().name === "local" && store.state() === "ONLINE");
    ok("the record from boot 1 is readable, not lost behind a broken transport",
      (await store.list("note")).length === 1);
    ok("the relay still holds nothing, and nothing pretended otherwise",
      !relay._hasVault() && relay._recCount() === 0);
  }

  section("the fix: provisioning an already-open vault onto the relay");
  {
    /* Same shape as above, fresh instances so the two sections
       cannot leak state into each other. */
    const local2 = makeLocal();
    FieldKit.provide("transportLocal", local2);
    await store.init([local2]);
    await store.setup(PASSWORD, { iterations: 1000 });
    await store.put("note", { text: "first" });
    await store.put("note", { text: "second" });

    const relay2 = makeRelay("fresh-relay");
    const bootF = await store.init([relay2, local2]);
    await store.unlock(PASSWORD);
    ok("starts on local with the relay flagged as unprovisioned",
      store.transport().name === "local" && bootF.unprovisioned === "fresh-relay");

    /* This is the RELAY LINK "PROVISION THIS VAULT ON THE RELAY"
       action, exactly as modules/relay-config.js calls it —
       including reading from the transport that holds the records
       rather than the one being provisioned. */
    const archive = await backup.build({ from: store.transport() });
    ok("the archive holds both records written before the relay existed",
      archive.records.length === 2);

    /* Without opts.token this is refused up front rather than
       half-completing. The old behaviour uploaded the header, got a
       401 on the first record, and left the relay provisioned and
       empty — which reads as a successful restore from every angle
       except looking for the data. */
    let noToken = null;
    try { await backup.restoreToTransport(archive, makeRelay("tokenless")); }
    catch (e) { noToken = e; }
    ok("restoring records without an auth token is refused up front", !!noToken);
    ok("...and the message says what to pass",
      /auth token|headerOnly/i.test(noToken && noToken.message));

    const result = await backup.restoreToTransport(archive, relay2, null,
      { token: store.vault().authToken });
    ok("restoreToTransport reports both records uploaded", result.records === 2);
    ok("...having armed the transport with the bearer token",
      relay2._token() === store.vault().authToken);
    ok("the relay now actually holds a header", relay2._hasVault());
    ok("...and both records", relay2._recCount() === 2);

    await store.attachTransport(relay2);
    ok("the store moves to ONLINE once attached", store.state() === "ONLINE");
    ok("...and the active transport is genuinely provisioned now",
      store.transport().name === "fresh-relay" && relay2._hasVault());

    /* Prove it is not just self-reported: an authenticated call the
       relay would have refused a moment ago now succeeds. */
    const remoteList = await relay2.listRecords();
    ok("the relay answers an authenticated read now", remoteList.length === 2);
  }

  section("a failed hydrate does not leave the vault looking empty");
  {
    /* hydrate() clears the cache before it reads. When the read then
       fails, the OFFLINE branch it lands in used to stop there —
       unlike the "transport unreachable" branch beside it, which
       replays the queue. Since list() and get() serve ONLY from the
       cache, the result was every module in the console showing
       nothing at all: no error, no empty-state explanation, just an
       apparently blank vault. It read as data loss. */
    const local5 = makeLocal();
    FieldKit.provide("transportLocal", local5);
    await store.init([local5]);
    await store.setup(PASSWORD, { iterations: 1000 });

    /* A relay that IS provisioned — so it legitimately wins the
       election — but that fails on the authenticated read. A relay
       restarted with a wiped data dir behaves exactly like this. */
    const flaky = makeRelay("provisioned-but-failing");
    await flaky.saveHeader(store.header());
    flaky.listRecords = async () => { throw new Error("relay fell over mid-read"); };

    await store.init([flaky, local5]);
    ok("the provisioned relay wins the election", store.transport().name === "provisioned-but-failing");

    await store.unlock(PASSWORD);
    ok("a failed hydrate drops to OFFLINE", store.state() === "OFFLINE");

    /* The point: writes still work and are still visible. Before the
       fix the cache stayed empty and this record was the only thing
       that could ever appear in it. */
    await store.put("note", { text: "written after the relay broke" });
    const visible = await store.list("note");
    ok("work done while offline is readable, not swallowed", visible.length === 1);
    ok("...and it is the record just written",
      visible[0].data.text === "written after the relay broke");
  }

  section("attachTransport refuses on a locked vault");
  {
    /* A fresh module instance: a header exists (so state is LOCKED,
       not EMPTY) but nobody has unlocked it. Provisioning onto a
       relay needs vault.authToken, which only exists once a
       password has derived it — attaching blind here would either
       crash reaching into a null vault or, worse, attach a
       transport with no token and have every write silently queue
       instead of failing loudly. */
    const FK2 = bootstrap([
      "core/kernel.js", "core/settings.js", "core/ui.js",
      "core/crypto.js", "core/store.js", "core/backup.js"
    ]);
    const local4 = makeLocal();
    FK2.provide("deviceId", async () => "test-device-2");
    FK2.provide("queue", memQueue());
    FK2.provide("transportLocal", local4);
    const store2 = FK2.need("store");
    await store2.init([local4]);
    await store2.setup(PASSWORD, { iterations: 1000 });

    /* Re-init against the same local header without unlocking —
       this is what a locked-vault boot looks like: header known,
       vault not open. */
    const FK3 = bootstrap([
      "core/kernel.js", "core/settings.js", "core/ui.js",
      "core/crypto.js", "core/store.js", "core/backup.js"
    ]);
    FK3.provide("deviceId", async () => "test-device-3");
    FK3.provide("queue", memQueue());
    FK3.provide("transportLocal", local4);
    const store3 = FK3.need("store");
    const boot3 = await store3.init([local4]);
    ok("this session is locked, not unlocked", boot3.state === "LOCKED" && !store3.isUnlocked());

    let threw = null;
    try { await store3.attachTransport(makeRelay("blocked")); }
    catch (e) { threw = e; }
    ok("attachTransport refuses without an open vault", !!threw);
    ok("...for the reason that actually applies", /vault must be open/i.test(threw && threw.message));
  }

  state.fail === 0
    ? console.log("\nRESULT  pass " + state.pass + "  fail 0")
    : console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.log("\nSUITE CRASHED: " + e.stack);
  console.log("RESULT  pass 0  fail 1");
  process.exit(1);
});
