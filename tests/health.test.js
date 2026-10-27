/* ============================================================
   core/health.js — the failures that do not throw.

   Everything here is a problem you only notice weeks later:
   a clock that disagrees with the relay quietly reorders two
   people's edits, a full quota stops the safety net first, and
   queued work that never uploaded exists on exactly one machine.

   Two properties the suite exists to hold:
     1. it never throws, whatever the platform is missing
     2. it says nothing when there is nothing to say — a health
        check that always complains gets ignored, and then the
        one time it is right nobody reads it
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "core/health.js"]);
const { ok, section, state } = makeRunner("health");
const health = FieldKit.need("health");

function find(report, id) {
  return report.findings.filter((f) => f.id === id)[0] || null;
}

/* A relay whose clock we control. */
function relayAt(offsetMs) {
  global.fetch = async () => ({
    async json() { return { up: true, time: new Date(Date.now() + offsetMs).toISOString() }; }
  });
  FieldKit.provide("transportRelay", { url: () => "https://relay.example.com" });
}

function noRelay() {
  FieldKit.provide("transportRelay", null);
  global.fetch = async () => { throw new Error("no network"); };
}

function storageAt(ratio) {
  global.navigator.storage = {
    async estimate() { return { usage: Math.round(1e9 * ratio), quota: 1e9 }; }
  };
}

function pending(n) {
  FieldKit.provide("store", { async pendingCount() { return n; } });
}

(async function () {
  FieldKit.deviceId = "device-one";
  noRelay();
  delete global.navigator.storage;
  pending(0);

  section("a healthy machine says nothing alarming");
  {
    relayAt(0);
    storageAt(0.2);
    pending(0);
    FieldKit.provide("backup", {
      reminder: () => null,
      async listSnapshots() { return [{ at: Date.now() }]; }
    });
    const r = await health.check();
    ok("the overall level is pass", r.level === "pass", r.level);
    ok("there is nothing to act on", r.problems.length === 0,
      JSON.stringify(r.problems.map((f) => f.text)));
    ok("it still reports what it checked", r.findings.length >= 4, String(r.findings.length));
  }

  section("the clock");
  {
    relayAt(0);
    let r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("an agreeing clock passes", find(r, "clock").level === "pass", find(r, "clock").text);

    relayAt(-2 * 60 * 1000);
    r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("two minutes of drift is not worth mentioning",
      find(r, "clock").level === "pass", find(r, "clock").text);

    relayAt(-10 * 60 * 1000);
    r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("ten minutes warns", find(r, "clock").level === "warn", find(r, "clock").text);
    ok("it says which way the drift goes", /AHEAD OF/.test(find(r, "clock").text),
      find(r, "clock").text);

    relayAt(45 * 60 * 1000);
    r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("forty-five minutes fails", find(r, "clock").level === "fail", find(r, "clock").text);
    ok("the other direction is named too", /BEHIND/.test(find(r, "clock").text),
      find(r, "clock").text);
    ok("it explains why a clock matters", /order/i.test(find(r, "clock").detail || ""),
      find(r, "clock").detail);

    /* Symmetry: ±the same drift must be judged the same way. */
    relayAt(-40 * 60 * 1000);
    const behind = find(await health.check({ skip: ["storage", "backlog", "profile", "backup"] }), "clock");
    relayAt(40 * 60 * 1000);
    const ahead = find(await health.check({ skip: ["storage", "backlog", "profile", "backup"] }), "clock");
    ok("drift is judged by size, not direction", behind.level === ahead.level);
  }

  section("the clock check gives up quietly when it cannot run");
  {
    noRelay();
    let r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("no relay configured means no clock finding at all", find(r, "clock") === null);

    FieldKit.provide("transportRelay", { url: () => "https://relay.example.com" });
    global.fetch = async () => { throw new Error("Failed to fetch"); };
    r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("an unreachable relay is the network's problem, not this one",
      find(r, "clock") === null);

    global.fetch = async () => ({ async json() { return { up: true }; } });
    r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("a health response with no time is ignored", find(r, "clock") === null);

    global.fetch = async () => ({ async json() { return { time: "not a date" }; } });
    r = await health.check({ skip: ["storage", "backlog", "profile", "backup"] });
    ok("an unparseable time is ignored rather than reported as huge drift",
      find(r, "clock") === null);
  }

  section("storage");
  {
    relayAt(0);
    storageAt(0.1);
    let r = await health.check({ skip: ["clock", "backlog", "profile", "backup"] });
    ok("plenty of room passes", find(r, "storage").level === "pass", find(r, "storage").text);

    storageAt(0.85);
    r = await health.check({ skip: ["clock", "backlog", "profile", "backup"] });
    ok("85% warns", find(r, "storage").level === "warn", find(r, "storage").text);

    storageAt(0.97);
    r = await health.check({ skip: ["clock", "backlog", "profile", "backup"] });
    ok("97% fails", find(r, "storage").level === "fail", find(r, "storage").text);
    ok("it says what breaks first", /safety net/i.test(find(r, "storage").detail || ""),
      find(r, "storage").detail);

    delete global.navigator.storage;
    r = await health.check({ skip: ["clock", "backlog", "profile", "backup"] });
    ok("a platform with no storage API is skipped, not failed",
      find(r, "storage") === null);

    global.navigator.storage = { async estimate() { return {}; } };
    r = await health.check({ skip: ["clock", "backlog", "profile", "backup"] });
    ok("an estimate with no quota is skipped", find(r, "storage") === null);

    global.navigator.storage = { async estimate() { throw new Error("denied"); } };
    r = await health.check({ skip: ["clock", "backlog", "profile", "backup"] });
    ok("a refused estimate does not become a failure", find(r, "storage") === null);
  }

  section("unsynced work");
  {
    pending(0);
    let r = await health.check({ skip: ["clock", "storage", "profile", "backup"] });
    ok("an empty queue passes", find(r, "backlog").level === "pass");

    pending(3);
    r = await health.check({ skip: ["clock", "storage", "profile", "backup"] });
    ok("a few queued changes warn", find(r, "backlog").level === "warn", find(r, "backlog").text);
    ok("the count is in the message", /3 CHANGE/.test(find(r, "backlog").text),
      find(r, "backlog").text);

    pending(50);
    r = await health.check({ skip: ["clock", "storage", "profile", "backup"] });
    ok("a large backlog fails", find(r, "backlog").level === "fail", find(r, "backlog").text);
    ok("it says the work exists in one place only",
      /this machine only/i.test(find(r, "backlog").detail || ""), find(r, "backlog").detail);

    FieldKit.provide("store", {});
    r = await health.check({ skip: ["clock", "storage", "profile", "backup"] });
    ok("a store with no queue support is skipped", find(r, "backlog") === null);

    FieldKit.provide("store", { async pendingCount() { throw new Error("indexedDB gone"); } });
    r = await health.check({ skip: ["clock", "storage", "profile", "backup"] });
    ok("a throwing queue count does not break the check", find(r, "backlog") === null);
    pending(0);
  }

  section("browser profile");
  {
    global.localStorage.removeItem("fieldkit.lastDevice");
    FieldKit.deviceId = "device-one";
    let r = await health.check({ skip: ["clock", "storage", "backlog", "backup"] });
    ok("the first run in a profile is noted, not warned about",
      find(r, "profile").level === "info", find(r, "profile").text);

    r = await health.check({ skip: ["clock", "storage", "backlog", "backup"] });
    ok("the same profile next time passes", find(r, "profile").level === "pass");

    FieldKit.deviceId = "device-two";
    r = await health.check({ skip: ["clock", "storage", "backlog", "backup"] });
    ok("a different profile warns", find(r, "profile").level === "warn", find(r, "profile").text);
    ok("it explains that the vault is fine",
      /vault is unaffected/i.test(find(r, "profile").detail || ""), find(r, "profile").detail);

    r = await health.check({ skip: ["clock", "storage", "backlog", "backup"] });
    ok("and it only says it once", find(r, "profile").level === "pass");

    FieldKit.deviceId = null;
    r = await health.check({ skip: ["clock", "storage", "backlog", "backup"] });
    ok("no device id means no finding", find(r, "profile") === null);
    FieldKit.deviceId = "device-two";
  }

  section("backups");
  {
    FieldKit.provide("backup", {
      reminder: () => null,
      async listSnapshots() { return []; }
    });
    let r = await health.check({ skip: ["clock", "storage", "backlog", "profile"] });
    ok("a recent backup passes even with no snapshots",
      find(r, "backup").level === "pass", find(r, "backup").text);

    FieldKit.provide("backup", {
      reminder: () => ({ overdue: true, days: 40, text: "LAST BACKUP WAS 40 DAY(S) AGO" }),
      async listSnapshots() { return [{ at: 1 }, { at: 2 }]; }
    });
    r = await health.check({ skip: ["clock", "storage", "backlog", "profile"] });
    ok("overdue with snapshots warns", find(r, "backup").level === "warn", find(r, "backup").text);
    ok("it credits the snapshots but does not oversell them",
      /not this profile being cleared/i.test(find(r, "backup").detail || ""),
      find(r, "backup").detail);

    FieldKit.provide("backup", {
      reminder: () => ({ overdue: true, days: null, text: "NO BACKUP HAS EVER BEEN TAKEN" }),
      async listSnapshots() { return []; }
    });
    r = await health.check({ skip: ["clock", "storage", "backlog", "profile"] });
    ok("overdue with no snapshots at all fails", find(r, "backup").level === "fail",
      find(r, "backup").text);
    ok("it says the data is in one place", /nowhere else/i.test(find(r, "backup").detail || ""));

    FieldKit.provide("backup", null);
    r = await health.check({ skip: ["clock", "storage", "backlog", "profile"] });
    ok("no backup service means no finding", find(r, "backup") === null);
  }

  section("the check never takes the boot down with it");
  {
    /* Every service missing, every API absent, nothing configured. */
    FieldKit.provide("transportRelay", null);
    FieldKit.provide("store", null);
    FieldKit.provide("backup", null);
    delete global.navigator.storage;
    global.fetch = undefined;
    FieldKit.deviceId = null;

    let threw = null, r = null;
    try { r = await health.check(); } catch (e) { threw = e; }
    ok("a completely bare platform does not throw", !threw, threw && threw.message);
    ok("it returns a report anyway", !!r && Array.isArray(r.findings));
    ok("with nothing to report", r.findings.length === 0, JSON.stringify(r.findings));
    ok("and a passing level rather than a false alarm", r.level === "pass", r.level);
  }

  section("worst level wins");
  {
    relayAt(0);
    storageAt(0.2);
    pending(50);                 // one failing check among passing ones
    FieldKit.deviceId = "device-two";
    FieldKit.provide("backup", { reminder: () => null, async listSnapshots() { return []; } });
    const r = await health.check();
    ok("one failure makes the whole report a failure", r.level === "fail", r.level);
    ok("only the non-passing findings are listed as problems",
      r.problems.every((f) => f.level !== "pass"),
      JSON.stringify(r.problems.map((f) => f.level)));
    ok("passing checks are still in the full list",
      r.findings.length > r.problems.length,
      r.findings.length + " vs " + r.problems.length);
  }

  section("plain text");
  {
    relayAt(0); storageAt(0.97); pending(50);
    const r = await health.check();
    const text = health.asText(r);
    ok("it names itself", /FIELDKIT — HEALTH CHECK/.test(text));
    ok("every finding is in it",
      r.findings.every((f) => text.indexOf(f.text) >= 0));
    ok("details are included", /safety net/i.test(text));
    ok("it is plain text", !/[<>]/.test(text));
    const longest = text.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
    ok("lines are short enough to paste", longest <= 90, String(longest));
    ok("an empty report does not crash the formatter",
      health.asText({ at: "x", findings: [], problems: [], level: "pass" }).length > 0);
    ok("a null report returns an empty string", health.asText(null) === "");
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + e.stack);
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});
