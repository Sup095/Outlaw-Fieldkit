/* ============================================================
   RUNNER's power readout (RUNNER_PLAN.md §24) — runnerd/power.js reading
   what fk-power writes, and ADMIN -> POWER through a real run server.
   fk-power itself was run on Bastion 2 against its real graphics card
   and a stand-in energy counter (FIELDKIT_PROJECT.md §14.20).

   What matters:
     1. Only numbers in a sane range are believed; a stopped fk-power
        reads as stopped, never as a steady draw.
     2. A month's estimate is the day's average, plus the stated
        estimate for the parts nobody measures.
     3. Only an admin sees it or sets the price, and bad values are
        refused rather than stored.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { makeRunner } = require("./harness");
const { connect } = require("./runner-kit");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");
const { Power, STALE_MS } = require("../runnerd/power");

const { ok, section, state } = makeRunner("runner-power");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-power-"));

(async () => {
  const FILE = path.join(TMP, "power.json"), SET = path.join(TMP, "power-settings.json");
  let clock = 1800000000000;
  const p = new Power({ file: FILE, settingsFile: SET, now: () => clock });
  const write = (o) => fs.writeFileSync(FILE, JSON.stringify(Object.assign({ at: clock / 1000 }, o)));

  section("before fk-power exists");
  {
    p.sample();
    const v = p.view();
    ok("says why there is nothing, and what to do", v.ok === false && /setup\.sh/.test(v.why));
    ok("with the starting settings", v.settings.pricePerKwh === 0 && v.settings.otherWatts === 30 && v.settings.currency === "$");
  }

  section("readings");
  {
    write({ cpuW: 12, gpuW: 2, gpuState: "P8", gpuTempC: 30 });
    p.sample();
    let v = p.view();
    ok("now: what was measured", v.ok && v.now.cpuW === 12 && v.now.gpuW === 2 && v.now.gpuState === "P8");
    ok("average: measured plus the estimate for the rest", v.avgW === 44);
    ok("a month at that: 44 W × 730 h = 32.1 kWh", v.monthKwh === 32.1);
    ok("no price set: no cost", v.monthCost === null);
    p.sample();
    ok("the same reading twice counts once", p.samples.length === 1);
    clock += 60000; write({ cpuW: 52, gpuW: 2 }); p.sample();
    v = p.view();
    ok("two readings: their average (12+2 and 52+2) + 30", v.avgW === 64 && v.overHours === 0);
    clock += 60000; write({ cpuW: 5000, gpuW: -1, gpuState: "<b>", gpuTempC: "hot" }); p.sample();
    v = p.view();
    ok("nonsense is not believed: no watts, no state", v.now.cpuW === null && v.now.gpuW === null && v.now.gpuState === null && v.now.gpuTempC === null);
    ok("and a reading with nothing in it is not averaged in", p.samples.length === 2);
    fs.writeFileSync(FILE, "{not json");
    p.sample();
    ok("a half-written file changes nothing", p.samples.length === 2);
  }

  section("a stopped fk-power");
  {
    write({ cpuW: 10, gpuW: 1 }); p.sample();
    clock += STALE_MS + 60000;
    p.sample();
    const v = p.view();
    ok("reads as stopped, with how long ago", v.ok === false && /minutes old/.test(v.why));
    clock += 25 * 3600000;
    write({ cpuW: 20, gpuW: 0 }); p.sample();
    ok("a day later, the old readings have gone from the average", p.samples.length === 1 && p.view().avgW === 50);
  }

  section("settings");
  {
    const s = p.set({ pricePerKwh: 0.31, otherWatts: 40, currency: "€" });
    ok("saved", s.pricePerKwh === 0.31 && s.otherWatts === 40 && s.currency === "€");
    const v = p.view();
    ok("and used: (20 + 40) W × 730 h × 0.31 = 13.58 a month", v.avgW === 60 && v.monthKwh === 43.8 && v.monthCost === 13.58, JSON.stringify(v));
    for (const [bad, what] of [[{ pricePerKwh: -1 }, "a negative price"], [{ pricePerKwh: "abc" }, "a price that is not a number"],
      [{ otherWatts: 5000 }, "5000 W for the rest"], [{ currency: "<img>" }, "markup as a currency"], [{ currency: "dollars" }, "a long currency"]]) {
      let threw = false;
      try { p.set(bad); } catch (e) { threw = true; }
      ok("refused: " + what, threw);
    }
    ok("and what was saved before is untouched", p.settings().pricePerKwh === 0.31 && p.settings().currency === "€");
    fs.writeFileSync(SET, JSON.stringify({ pricePerKwh: 1e9, otherWatts: "x", currency: "<script>" }));
    const t = p.settings();
    ok("a settings file edited badly by hand falls back, field by field", t.pricePerKwh === 0 && t.otherWatts === 30 && t.currency === "$");
  }

  section("ADMIN -> POWER on a real run server");
  {
    const STORE = path.join(TMP, "store");
    const pair = crypto.generateKeyPairSync("ed25519");
    const sign = (handle, tier) => ticket.sign(pair.privateKey, { handle, tier, exp: Date.now() + 30000 });
    const RUNFILE = path.join(TMP, "run-power.json");
    fs.writeFileSync(RUNFILE, JSON.stringify({ at: Math.floor(Date.now() / 1000), cpuW: 9.5, gpuW: 1.1, gpuState: "P8", gpuTempC: 29 }));
    const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
      storePath: STORE, driver: "process", dev: true, powerFile: RUNFILE,
      ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), () => {});
    const port = await app.listen();
    const as = async (h, tier) => { const c = await connect(port, sign(h, tier)); c.ready = await c.hello(); return c; };
    const boss = await as("boss", "admin"), alice = await as("alice", "member");

    const o = (await boss.ask({ t: "adm-overview" })).data;
    ok("an admin sees the reading", o.power && o.power.ok && o.power.now.cpuW === 9.5 && o.power.avgW === 40.6, JSON.stringify(o.power));
    const r = await alice.ask({ t: "adm-power", price: 0.5 });
    ok("a member cannot set the price", r.t === "error" && r.why === "admins only");
    const done = await boss.ask({ t: "adm-power", price: 0.25, other: 35, currency: "£" });
    ok("an admin can, and is told what was saved", done.t === "adm-done" && /£0\.25 per kWh, 35 W/.test(done.done), JSON.stringify(done));
    const o2 = (await boss.ask({ t: "adm-overview" })).data;
    ok("which the next overview uses: (9.5 + 1.1 + 35) W, 33.3 kWh, £8.32 a month",
      o2.power.settings.currency === "£" && o2.power.avgW === 45.6 && o2.power.monthKwh === 33.3 && o2.power.monthCost === 8.32, JSON.stringify(o2.power));
    ok("and is in the audit log", o2.audit.some((a) => a.action === "power-settings" && a.by === "boss"));
    const bad = await boss.ask({ t: "adm-power", price: -3 });
    ok("a bad price from an admin is refused with a reason", bad.t === "error" && /between 0 and 100/.test(bad.why), JSON.stringify(bad));
    boss.close(); alice.close();
    await app.close();
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + (e.stack || e.message));
  process.exit(1);
});
