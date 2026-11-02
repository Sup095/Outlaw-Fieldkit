/* ============================================================
   FieldKit tests :: admin — ADMIN CENTER's relay half

   Who may do what, that an allowed site reaches everything doing the
   blocking, and that nothing a person typed ends up on the page.

   node tests/admin.test.js
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const admin = require("../relay/admin");
const { Notices } = require("../relay/notices");
const probe = require("../relay/probe");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra ? "\n        " + extra : "")); }
}
function section(s) { console.log("\n== " + s + " =="); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-admin-"));

/* The parts ADMIN CENTER gathers from, each as small as it can be. */
const engineAllow = [], overflowAllow = [];
const ended = [], cleared = [];
const engine = {
  sessions: new Map([["msg:ana", { who: "msg:ana", tier: "member", tabs: [1, 2], viewers: new Set([1]), lastSeen: Date.now() }]]),
  status: () => ({ enabled: true, running: true }),
  lists: {
    setAllow(l) { engineAllow.push(l.slice()); },
    view: () => ({ names: 5000, blocked: { ads: 3 }, recent: [] }),
    refreshed: 0,
    async refresh() { this.refreshed++; }
  },
  async destroy(who, why) { ended.push([who, why]); this.sessions.delete(who); }
};
const overflow = {
  setAllow(l) { overflowAllow.push(l.slice()); },
  view: () => [{ id: "bastion-1", blocked: { ads: 2, adult: 1 } }],
  holding: (who) => who === "msg:bo" ? "helper-1" : null,
  async clear(h, who, what) { if (who === "msg:bo") cleared.push([h, who, what]); }
};
const notices = new Notices({ file: path.join(TMP, "announcement.json") });
const parts = () => ({
  dataDir: TMP, engine, overflow, notices, fairness: null,
  runner: { status: async () => { throw new Error("run server is off"); } },
  messaging: { counts: () => ({ users: 4, pending: 1 }) },
  updates: { state: () => ({ version: "1" }) },
  config: { browser: { adblockAllow: ["from-config.example"] } },
  log() {}
});

/* One request through the router. Admin unless told otherwise. */
async function call(method, p, body, as) {
  let got = null;
  const who = as === undefined ? "root" : as;
  const handled = await admin.route({ method }, {}, new URL("http://x" + p), {
    send: (res, status, out) => { got = { status, out }; },
    readBody: async () => { if (body === undefined) throw new Error("no body"); return body; },
    who: () => who,
    isAdmin: () => who === "root"
  });
  return Object.assign({ handled }, got);
}

(async () => {
  admin.init(parts());

  section("who may do what");
  {
    const out = await call("GET", "/somewhere/else");
    ok("a route that is not its own is left alone", out.handled === false);
    for (const [m, p] of [["GET", "/admin/overview"], ["POST", "/admin/announce"], ["POST", "/admin/block"], ["POST", "/admin/session"]]) {
      const r = await call(m, p, { text: "x", host: "a.com", op: "allow", who: "msg:ana" }, "ana");
      ok("a member cannot use " + p, r.status === 403, String(r.status));
      const n = await call(m, p, {}, null);
      ok("nor can nobody", n.status === 403, String(n.status));
    }
    ok("and the refusals changed nothing", engine.sessions.has("msg:ana") && notices.announcement() === null);
    const r = await call("POST", "/admin/report", { host: "x.com" }, null);
    ok("a report needs an account", r.status === 401, String(r.status));
    ok("an unknown admin route is a 404, not a hang", (await call("GET", "/admin/nothing")).status === 404);
  }

  section("the overview is all in one place");
  {
    const r = await call("GET", "/admin/overview");
    const o = r.out;
    ok("it answers", r.status === 200);
    ok("with the relay's own numbers", o.relay && o.relay.uptimeSec >= 0 && o.relay.memMb > 0 && o.relay.cpus > 0);
    ok("who has a session", o.browser.sessionList.length === 1 && o.browser.sessionList[0].who === "msg:ana" &&
      o.browser.sessionList[0].tabs === 2);
    ok("and no page address in it", !/url/i.test(JSON.stringify(o.browser.sessionList)));
    ok("blocked counts add the helpers' to this machine's",
      o.blocking.blocked.ads === 5 && o.blocking.blocked.adult === 1, JSON.stringify(o.blocking.blocked));
    ok("a run server that is off is shown and does not fail the page",
      o.runner && o.runner.online === false && o.runner.enabled === true && /off/.test(o.runner.why));
    ok("people and updates are there", o.people.pending === 1 && o.updates.version === "1");
  }

  section("what went wrong lately");
  {
    admin.note("INFO", "nothing to see");
    admin.note("WARN", "a warning");
    admin.note("ERROR", "x".repeat(900));
    const e = (await call("GET", "/admin/overview")).out.events;
    ok("warnings and errors only, newest first", e.length === 2 && e[0].level === "ERROR" && e[1].msg === "a warning");
    ok("cut to a sensible length", e[0].msg.length === 300);
    for (let i = 0; i < 100; i++) admin.note("WARN", "n" + i);
    ok("and it does not grow without end", (await call("GET", "/admin/overview")).out.events.length === 60);
  }

  section("telling everyone");
  {
    let r = await call("POST", "/admin/announce", { text: "back at six", level: "warn", hours: 2 });
    ok("an announcement goes up", r.status === 200 && notices.list().some((n) => /back at six/.test(n.text)), JSON.stringify(r.out));
    ok("the overview shows it", (await call("GET", "/admin/overview")).out.announcement.text === "back at six");
    r = await call("POST", "/admin/announce", { text: "" });
    ok("an empty one is refused", r.status === 400);
    r = await call("POST", "/admin/announce");
    ok("so is no body at all", r.status === 400);
    r = await call("POST", "/admin/announce", { end: true });
    ok("and it can be taken down", r.status === 200 && !notices.list().some((n) => /back at six/.test(n.text)));
  }

  section("a wrong block");
  {
    let r = await call("POST", "/admin/report", { host: "good.example.com", kind: "ads" }, "ana");
    ok("any account can report one", r.status === 200);
    r = await call("POST", "/admin/report", { host: "good.example.com", kind: "ads" }, "bo");
    let list = (await call("GET", "/admin/overview")).out.blocking.reports;
    ok("the same site twice is one report", list.length === 1 && list[0].by === "ana");
    r = await call("POST", "/admin/report", { host: "<script>alert(1)</script>" }, "ana");
    ok("what is not a site name is refused", r.status === 400);
    r = await call("POST", "/admin/report", { host: "https://Good.Example.org/some/page?q=secret" }, "ana");
    ok("a pasted address keeps only the site", r.status === 200);
    list = (await call("GET", "/admin/overview")).out.blocking.reports;
    ok("no path or query is kept", list[0].host === "good.example.org" && !/secret/.test(JSON.stringify(list)), JSON.stringify(list));
    for (let i = 0; i < 130; i++) await call("POST", "/admin/report", { host: "site" + i + ".example" }, "ana");
    list = (await call("GET", "/admin/overview")).out.blocking.reports;
    ok("reports are capped, so one account cannot fill the disk", list.length === 100, String(list.length));

    engineAllow.length = overflowAllow.length = 0;
    r = await call("POST", "/admin/block", { op: "allow", host: "site129.example" });
    ok("an admin can allow a site", r.status === 200);
    ok("the allow list reaches this machine's browser",
      engineAllow.length === 1 && engineAllow[0].includes("site129.example"), JSON.stringify(engineAllow));
    ok("and the helpers", overflowAllow.length === 1 && overflowAllow[0].includes("site129.example"));
    ok("with the config's own list kept", engineAllow[0].includes("from-config.example"));
    let o = (await call("GET", "/admin/overview")).out.blocking;
    ok("the report goes away", !o.reports.some((x) => x.host === "site129.example"));
    ok("the allow shows", o.allowed.includes("site129.example"));
    await call("POST", "/admin/block", { op: "allow", host: "site129.example" });
    o = (await call("GET", "/admin/overview")).out.blocking;
    ok("allowed twice is listed once", o.allowed.filter((h) => h === "site129.example").length === 1);

    r = await call("POST", "/admin/block", { op: "dismiss", host: "site128.example" });
    o = (await call("GET", "/admin/overview")).out.blocking;
    ok("a report can be dismissed without allowing it", r.status === 200 &&
      !o.reports.some((x) => x.host === "site128.example") && !o.allowed.includes("site128.example"));

    r = await call("POST", "/admin/block", { op: "unallow", host: "site129.example" });
    ok("an allow can be taken back", r.status === 200 && !engineAllow[engineAllow.length - 1].includes("site129.example"));

    await call("POST", "/admin/block", { op: "allow", host: "keep.example" });
    ok("the allow list is on disk", /keep\.example/.test(fs.readFileSync(path.join(TMP, "blocking.json"), "utf8")));
    engineAllow.length = 0;
    admin.init(parts());
    ok("and comes back after a restart", engineAllow.length === 1 && engineAllow[0].includes("keep.example"));

    ok("an unknown action is refused", (await call("POST", "/admin/block", { op: "melt", host: "a.com" })).status === 400);
    ok("as is an action with no site", (await call("POST", "/admin/block", { op: "allow" })).status === 400);
    await call("POST", "/admin/block", { op: "refresh" });
    ok("REFRESH asks for the lists again", engine.lists.refreshed === 1);
  }

  section("ending a session");
  {
    let r = await call("POST", "/admin/session", { who: "msg:ana" });
    ok("a session here is ended", r.status === 200 && ended.length === 1 && ended[0][0] === "msg:ana");
    ok("and they are told by whom", /admin/.test(ended[0][1]));
    r = await call("POST", "/admin/session", { who: "msg:bo" });
    ok("a session on a helper is ended there", r.status === 200 && cleared.length === 1 && cleared[0][0] === "helper-1");
    r = await call("POST", "/admin/session", { who: "msg:nobody" });
    ok("one that has gone says so", r.status === 404);
  }

  section("what a device allows");
  {
    const go = async (method, p, body) => {
      let got = null;
      const handled = await probe.route({ method }, {}, new URL("http://x" + p), {
        send: (res, status, out) => { got = { status, out }; },
        sendRaw: (res, status, type, text, headers) => { got = { status, type, text, headers }; },
        readBody: async () => { if (body === undefined) throw new Error("none"); return body; }
      });
      return Object.assign({ handled }, got);
    };
    ok("other routes are left alone", (await go("GET", "/notices")).handled === false);
    const page = await go("GET", "/probe");
    ok("the page is a page", page.status === 200 && /text\/html/.test(page.type) && /serviceWorker/.test(page.text));
    ok("and says what it sends", /Nothing about you/.test(page.text));
    ok("it asks for nothing typed", !/<input|<form/.test(page.text));
    const sw = await go("GET", "/probe/sw.js");
    ok("the worker is served as a script", sw.status === 200 && /javascript/.test(sw.type));
    ok("and answers only its own ping", /probe\/ping/.test(sw.text) && !/importScripts|fetch\(e\.request/.test(sw.text));
    await go("POST", "/probe/result", { checks: { sw: true, swAnswers: true, wasm: "yes", webSocket: true, evil: true },
      platform: "ChromeOS", major: 140, name: "ana", url: "https://secret.example/" });
    const seen = probe.list()[0];
    ok("an answer is kept", seen.platform === "ChromeOS" && seen.major === 140 && seen.checks.sw === true);
    ok("only yes or no for the lines it knows", seen.checks.wasm === false && !("evil" in seen.checks));
    ok("and nothing else that was sent", !/ana|secret/.test(JSON.stringify(seen)));
    await go("POST", "/probe/result", { platform: "<script>", major: 1e9 });
    ok("nonsense becomes other and 0", probe.list()[0].platform === "other" && probe.list()[0].major === 0);
    ok("no body is refused", (await go("POST", "/probe/result")).status === 400);
    for (let i = 0; i < 80; i++) await go("POST", "/probe/result", { platform: "Linux" });
    ok("it keeps only the last few", probe.list().length === 30);
    ok("the overview shows them", (await call("GET", "/admin/overview")).out.devices.length === 12);
  }

  section("a helper that is not answering");
  {
    const real = overflow.clear;
    overflow.clear = async () => { throw new Error("timed out"); };
    const r = await call("POST", "/admin/session", { who: "msg:bo" });
    overflow.clear = real;
    ok("is a clear error, not a crash", r.status === 502 && /timed out/.test(r.out.error));
  }

  section("the lens address");
  {
    const { LensLink } = require("../relay/lens-link");
    const crypto = require("crypto");
    const p = crypto.generateKeyPairSync("ed25519");
    const lens = new LensLink({ keys: { privateKey: p.privateKey, publicPem: "" }, everyMs: 3600000,
      fetch: async () => ({ ok: true, json: async () => ({ up: true, state: "ok", key: true }) }) });
    admin.init(Object.assign(parts(), { lens }));
    ok("a member cannot set it", (await call("POST", "/admin/lens", { url: "https://lens.example.com" }, "ana")).status === 403);
    ok("an address that is not one is refused", (await call("POST", "/admin/lens", { url: "ftp://x" })).status === 400 && lens.url() === "");
    const r = await call("POST", "/admin/lens", { url: "https://lens.example.com/" });
    ok("an admin sets it, and lens starts using it", r.status === 200 && r.out.url === "https://lens.example.com" && lens.url() === "https://lens.example.com");
    ok("…kept, so a restart remembers it", admin.savedLensUrl(TMP) === "https://lens.example.com");
    const ov = await call("GET", "/admin/overview");
    ok("the overview shows it and whether it can be used", ov.out.browser.lens && ov.out.browser.lens.url === "https://lens.example.com" && "usable" in ov.out.browser.lens);
    ok("empty turns it off", (await call("POST", "/admin/lens", { url: "" })).status === 200 && lens.url() === "" && admin.savedLensUrl(TMP) === "");
    lens.stop();
    admin.init(parts());
    ok("a relay with the browser off says so", (await call("POST", "/admin/lens", { url: "https://lens.example.com" })).status === 409);
    ok("nothing saved: nothing read", admin.savedLensUrl(path.join(TMP, "nowhere")) === "");
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\nRESULT  pass " + pass + "  fail " + fail);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e && e.stack || e)); process.exit(1); });
