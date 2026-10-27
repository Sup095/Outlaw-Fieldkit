/* ============================================================
   core/guest.js — guest session isolation.

   The property that matters: once a guest session is active, no
   module can reach the real vault through ctx.store, and nothing a
   guest does can persist. Everything else here is secondary.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js", "core/guest.js"
]);
const { ok, section, state } = makeRunner("guest");

/* Stand-in for the real store, holding something a guest must never
   be able to see. */
const SECRET = { note: "the real vault contents" };
let realRemoved = false;
const realStore = {
  async list() { return [{ id: "real-1", meta: { type: "note" }, data: SECRET }]; },
  async get() { return SECRET; },
  async put() { throw new Error("the real store must not be written during a guest session"); },
  async remove() { realRemoved = true; return true; },
  async pendingCount() { return 7; },
  state: () => "ONLINE",
  isUnlocked: () => true,
  hasVault: () => true,
  transportName: () => "relay"
};
FieldKit.provide("store", realStore);

const guest = FieldKit.need("guest");

(async function () {
  /* ---------- before activation ---------- */
  section("before activation");
  ok("guest mode starts inactive", guest.active() === false);
  ok("every module is allowed when not in a guest session",
    guest.allowed({ id: "anything" }) === true &&
    guest.allowed({ id: "x", guestSafe: true }) === true);
  ok("the real store is in place", FieldKit.service("store") === realStore);

  /* ---------- activation ---------- */
  section("activation");
  let stateEvent = null;
  FieldKit.on("store:state", (e) => { stateEvent = e; });
  guest.activate();

  ok("guest mode reports active", guest.active() === true);
  ok("the store service was replaced", FieldKit.service("store") !== realStore);
  ok("the replacement identifies itself as a guest store",
    FieldKit.service("store").isGuest === true);
  ok("a GUEST state event was emitted", stateEvent && stateEvent.state === "GUEST");
  ok("activating twice is a no-op", (function () {
    const before = FieldKit.service("store");
    guest.activate();
    return FieldKit.service("store") === before;
  })());

  /* ---------- isolation ---------- */
  section("isolation from the real vault");
  const gs = FieldKit.service("store");
  const listed = await gs.list();
  ok("the guest store starts empty", listed.length === 0, "got " + listed.length);
  ok("the real record is unreachable by id", (await gs.get("real-1")) === null);
  ok("the guest store reports no vault", gs.hasVault() === false);
  ok("the guest store cannot read history", gs.canReadHistory() === false);
  ok("the guest store exposes no vault object", gs.vault() === null);
  ok("state reads as GUEST", gs.state() === "GUEST");
  ok("transport reads as memory, not relay", gs.transportName() === "memory");
  ok("device id is not the real one", gs.deviceId() === "guest");
  ok("queued-work count is zero, not the real 7", (await gs.pendingCount()) === 0);

  /* Writes must land in memory only — the real store's put() throws
     if it is ever reached, so a passing write proves isolation. */
  const meta = await gs.put("note", { body: "guest scratch" });
  ok("a guest write succeeds without touching the real store", !!meta && !!meta.id);
  ok("the write is readable back within the session",
    (await gs.get(meta.id)).body === "guest scratch");
  ok("the guest write is the only record", (await gs.list()).length === 1);
  ok("the real store was never written", realRemoved === false);

  await gs.remove(meta.id);
  ok("a guest delete removes only the in-memory record", (await gs.list()).length === 0);
  ok("deleting in a guest session never reaches the real store", realRemoved === false);

  section("guest store behaves like the real interface");
  const r1 = await gs.put("note", { v: 1 });
  const r2 = await gs.put("note", { v: 2 }, { id: r1.id });
  ok("put with an explicit id updates rather than duplicating",
    (await gs.list("note")).length === 1 && (await gs.get(r1.id)).v === 2);
  ok("createdAt is preserved across an update", r2.createdAt === r1.createdAt);
  await gs.put("other", { v: 3 });
  ok("list() filters by type", (await gs.list("note")).length === 1 && (await gs.list("other")).length === 1);
  ok("list() with no type returns everything", (await gs.list()).length === 2);
  const sync = await gs.sync();
  ok("sync is a no-op rather than an error", sync.pushed === 0 && !!sync.skipped);

  /* ---------- module gating ---------- */
  section("module gating");
  ok("a module without the flag is sealed", guest.allowed({ id: "relay-config" }) === false);
  ok("a module with guestSafe is allowed", guest.allowed({ id: "dev-tools", guestSafe: true }) === true);
  ok("guestSafe:false is sealed", guest.allowed({ id: "x", guestSafe: false }) === false);
  ok("a missing module is sealed rather than allowed", guest.allowed(null) === false);
  ok("gating fails closed — the default is sealed", guest.allowed({}) === false);

  /* The flags actually shipped on disk, not a hypothetical list. */
  section("which modules ship as guest-safe");
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "modules");
  const flagged = [], unflagged = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    (/guestSafe:\s*true/.test(src) ? flagged : unflagged).push(f.replace(/\.js$/, ""));
  }
  const mustBeSealed = ["relay-config", "settings-panel", "config-vault", "ai-chat-panel"];
  ok("modules that touch the relay, settings, or secrets are not guest-safe",
    mustBeSealed.every((m) => !flagged.includes(m)),
    "flagged: " + flagged.join(", "));
  ok("at least a usable set of tools is guest-safe", flagged.length >= 5, flagged.join(", "));
  console.log("        guest-safe: " + flagged.join(", "));
  console.log("        sealed:     " + unflagged.join(", "));

  /* DIAGNOSTICS is deliberately guest-safe — handing someone the
     drive and having the self-test refuse to run would be unhelpful.
     But the NETWORK group printed the relay URL as a check detail
     and then pinged it, so the report handed a guest the owner's
     private tailnet address and confirmed it was live. Every other
     group that touches owner state already guarded; this one is the
     seal that RELAY LINK's guestSafe:false was supposed to provide. */
  section("the self-test does not leak the relay to a guest");
  {
    const selftestSrc = fs.readFileSync(path.join(__dirname, "..", "core", "selftest.js"), "utf8");
    const network = selftestSrc.slice(
      selftestSrc.indexOf('group("NETWORK"'),
      selftestSrc.indexOf('group("AI"')
    );
    ok("the NETWORK group exists to inspect", network.length > 200);

    ["RELAY CONFIGURED", "RELAY PING", "RELAY RECORD ROUNDTRIP"].forEach((name) => {
      const at = network.indexOf('check("' + name + '"');
      ok(name + " is present", at >= 0);
      const body = network.slice(at, at + 700);
      ok(name + " skips in a guest session", /skipIfGuest\(\)/.test(body),
        body.slice(0, 160).replace(/\s+/g, " "));
    });

    const panelSrc = fs.readFileSync(
      path.join(__dirname, "..", "modules", "selftest-panel.js"), "utf8");
    /* Sliced to the end of the function rather than a fixed number of
       characters. It was 900, and adding a comment inside runHealth
       pushed the guest branch past the window — so the assertion
       failed while the code it checks was untouched. A test that
       breaks when a comment is added is measuring the wrong thing. */
    const at = panelSrc.indexOf("function runHealth");
    const health = panelSrc.slice(at, panelSrc.indexOf("\n  }", at) + 4);
    ok("the health panel checks for a guest before reporting",
      /guest\.active\(\)/.test(health), health.slice(0, 200).replace(/\s+/g, " "));
    ok("and says why rather than silently blanking",
      /not shown in a\s*\n?\s*"?\s*\+?\s*"?guest session|guest session/.test(health));
  }

  /* The guest store stands in for the real one, so anything missing
     from it is a crash waiting for whichever module calls it — which
     is exactly how the GUESTBOOK self-check died on exportRecords.
     A module cannot be expected to feature-detect every store method
     it uses; the substitute has to be complete. */
  section("the guest store answers everything the real one does");
  {
    const storeSrc = fs.readFileSync(path.join(__dirname, "..", "core", "store.js"), "utf8");
    const exportsBlock = storeSrc.slice(storeSrc.lastIndexOf("FieldKit.provide(\"store\""));
    const realNames = new Set();
    exportsBlock.replace(/^\s*([A-Za-z_$][\w$]*)\s*:/gm, (_, name) => {
      realNames.add(name);
      return _;
    });
    ok("the real store's export list was found", realNames.size > 10,
      String(realNames.size));

    /* Vault lifecycle is boot's business and a guest must never have
       it — there is no vault to init, unlock or provision, and a
       module reaching for these in a guest session is a bug in the
       module, not a gap here. Everything else is fair game for a
       module to call and must therefore exist. */
    const BOOT_ONLY = new Set(["init", "setup", "unlock", "unlockWithRecovery", "transport"]);

    const memory = FieldKit.service("store");
    const missing = [...realNames].filter((n) => !BOOT_ONLY.has(n) && memory[n] === undefined);
    ok("the guest store provides every key a module could call",
      missing.length === 0, "missing: " + missing.join(", "));
    ok("and deliberately withholds the vault lifecycle",
      [...BOOT_ONLY].every((n) => memory[n] === undefined),
      [...BOOT_ONLY].filter((n) => memory[n] !== undefined).join(", "));

    /* And the ones a module is most likely to call must not throw. */
    let exported = null;
    try { exported = await memory.exportRecords(); } catch (e) { exported = e; }
    ok("exportRecords() returns rows rather than throwing",
      Array.isArray(exported), String(exported && exported.message));
    ok("pendingCount() answers", (await memory.pendingCount()) === 0);
    ok("pull() answers with an empty result",
      (await memory.pull()).changes.length === 0);
  }

  section("ending a session");
  guest.end();
  ok("end() reloads rather than trying to restore the vault in place",
    global.window.__reloaded === true);

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + e.stack);
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});
