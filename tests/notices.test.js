/* ============================================================
   FieldKit tests :: notices — what everyone is told, and that it
   goes away by itself

   node tests/notices.test.js
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Notices, TEXT_MAX } = require("../relay/notices");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra ? "\n        " + extra : "")); }
}
function section(s) { console.log("\n== " + s + " =="); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-notices-"));
let clock = 1000000;
const SEC = 1000;
const make = (extra) => new Notices(Object.assign({ now: () => clock }, extra || {}));
const DOWN = { level: "warn", text: "the fast browser is down" };

(async () => {
  section("a blip says nothing");
  {
    const n = make();
    n.report("x", DOWN);
    ok("not at once", n.list().length === 0);
    clock += 20 * SEC;
    n.report("x", DOWN);
    ok("nor after 20 seconds", n.list().length === 0);
    n.report("x", null);
    clock += 60 * SEC;
    n.report("x", DOWN);
    clock += 20 * SEC;
    n.report("x", DOWN);
    ok("a blip that cleared starts the wait again", n.list().length === 0);
  }

  section("a real outage is shown, and clears itself");
  {
    const n = make();
    n.report("x", DOWN);
    clock += 31 * SEC;
    n.report("x", DOWN);
    const l = n.list();
    ok("after 30 seconds everyone gets it", l.length === 1 && l[0].id === "x" && l[0].level === "warn" && /down/.test(l[0].text));
    const since = l[0].since;
    clock += 90 * SEC;
    n.report("x", DOWN);
    ok("it stays while it is true, as the same occurrence", n.list().length === 1 && n.list()[0].since === since);
    n.report("x", null);
    ok("recovering is not instant, so a flap does not flash", n.list().length === 1);
    clock += 31 * SEC;
    n.report("x", null);
    ok("once it has held for 30 seconds it is gone, with nobody having done anything", n.list().length === 0);
    ok("nothing is left behind for anyone to clear", !n.state.has("x"));
  }

  section("flapping");
  {
    const n = make();
    n.report("x", DOWN);
    clock += 31 * SEC;
    n.report("x", DOWN);
    n.report("x", null);
    clock += 31 * SEC;
    n.report("x", null);
    ok("even when it recovers quickly, it stays its minute", n.list().length === 1);
    clock += 30 * SEC;
    n.report("x", null);
    ok("then goes", n.list().length === 0);

    const m = make();
    m.report("y", DOWN);
    clock += 31 * SEC;
    m.report("y", DOWN);
    m.report("y", null);
    clock += 20 * SEC;
    m.report("y", DOWN);
    clock += 20 * SEC;
    m.report("y", null);
    clock += 20 * SEC;
    m.report("y", null);
    ok("failing again restarts the wait to clear", m.list().length === 1);
    clock += 15 * SEC;
    m.report("y", null);
    ok("and it clears after a real 30 seconds of health", m.list().length === 0);
  }

  section("what it watches");
  {
    const n = make({ holdMs: 0, minMs: 0 });
    let down = true;
    n.watch("svc", async () => (down ? DOWN : null));
    n.watch("broken", async () => { throw new Error("cannot tell"); });
    await n.tick();
    ok("a watch that says something bad is reported", n.list().length === 1);
    down = false;
    await n.tick();
    await n.tick();
    ok("and when it stops, it is gone", n.list().length === 0);
    ok("a watch that throws is not taken to mean anything", !n.state.has("broken"));
    n.report("long", { level: "nonsense", text: "x".repeat(2000) });
    ok("the level is one of three, the text has a length", n.list()[0].level === "warn" && n.list()[0].text.length === TEXT_MAX);
  }

  section("an announcement");
  {
    const file = path.join(TMP, "a.json");
    const n = make({ file });
    const a = n.announce("  maintenance tonight  ", "warn", 2, "sup095");
    ok("it is shown to everyone at once", n.list()[0].text === "maintenance tonight" && n.list()[0].announcement === true);
    ok("with who said it kept for the admin", a.by === "sup095");
    const again = make({ file });
    ok("it survives a restart", again.list()[0].text === "maintenance tonight");
    clock += 2 * 3600 * SEC + SEC;
    ok("and ends by itself when its time is up", again.list().length === 0 && n.announcement() === null);
    n.announce("again", "nonsense", 9999999);
    ok("an odd level becomes info, and an odd length is cut to a fortnight", n.list()[0].level === "info" && n.announcement().until - clock === 14 * 24 * 3600 * SEC);
    n.endAnnouncement();
    ok("an admin can end it", n.list().length === 0 && make({ file }).list().length === 0);
    let threw = false;
    try { n.announce("   "); } catch (e) { threw = true; }
    ok("an empty one is refused", threw);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\nRESULT  pass " + pass + "  fail " + fail);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e)); process.exit(1); });
