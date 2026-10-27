/* ============================================================
   The streamed browser's copy, find, zoom and pause (FIELDKIT_PROJECT.md
   §14.19) — the engine against a stand-in page that records what it is
   asked, and the route's messages end to end. The same things were run
   against a real Chromium in the relay image (17 checks, §14.19).

   What matters:
     1. Copy and find run in the engine's own isolated world, never the
        page's, and what comes back is capped.
     2. A cut reads the selection BEFORE the page cuts it.
     3. A hidden panel is sent nothing, and when no panel is looking
        the screencast stops; shown again, it starts at once.
     4. Zoom only ever lands on one of the fixed steps.
   ============================================================ */
"use strict";

const http = require("http");
const { EventEmitter } = require("events");
const { makeRunner } = require("./harness");
const { Engine } = require("../relay/browser-engine");
const route = require("../relay/browser-route");

const { ok, section, state } = makeRunner("browser-tools");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return false; };

/* A page that answers the CDP calls the engine makes, and remembers them. */
function fakePage(answers) {
  const p = new EventEmitter();
  p.calls = [];
  p.worlds = 0;
  p.send = async (method, params) => {
    p.calls.push({ method, params: params || {} });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 100 + (++p.worlds) };
    if (method === "Runtime.evaluate") {
      if (p.gone) { p.gone = false; throw new Error("Cannot find context with specified id"); }
      return { result: { value: answers(params.expression) } };
    }
    return {};
  };
  p.count = (m) => p.calls.filter((c) => c.method === m).length;
  return p;
}

function session(page) {
  /* One tab, on screen: the shape sessionFor makes (§16). */
  const tab = { id: "t1", page, url: "about:blank", title: "", dialog: null };
  return { key: "k", who: "w", page, active: tab, tabs: [tab], viewers: new Set(), casting: false,
    width: 1000, height: 600, scale: 1, zoom: 1, world: null, url: "about:blank", lastSeen: 0 };
}

(async () => {
  const eng = new Engine({ config: { enabled: false }, log: () => {} });
  clearInterval(eng._sweep);

  section("copy");
  {
    let said = "hello there";
    const page = fakePage((x) => (/getSelection/.test(x) ? said : undefined));
    const s = session(page);
    ok("the selection comes back", (await eng.copyText(s)) === "hello there");
    const ev = page.calls.filter((c) => c.method === "Runtime.evaluate");
    ok("asked in the engine's own world, not the page's", ev.length === 1 && ev[0].params.contextId === 101);
    ok("and never from a password box", /password/.test(ev[0].params.expression));
    await eng.copyText(s);
    ok("the world is made once, not per copy", page.worlds === 1);
    page.gone = true;
    ok("a page that navigated away: a fresh world, and it still works", (await eng.copyText(s)) === "hello there" && page.worlds === 2);
    said = "x".repeat(300000);
    ok("capped at 100 000 characters", (await eng.copyText(s)).length === 100000);
    said = { not: "a string" };
    ok("anything but a string is nothing", (await eng.copyText(s)) === "");
  }

  section("find");
  {
    const asked = [];
    const page = fakePage((x) => { asked.push(x); return /found/.test(x); });
    const s = session(page);
    ok("found", (await eng.find(s, "found it")) === true);
    ok("not found", (await eng.find(s, "nothing")) === false);
    ok("an empty search asks nothing", (await eng.find(s, "")) === false && asked.length === 2);
    await eng.find(s, "\"); alert(1); (\"");
    ok("the text is passed as a string, not code", asked[2].indexOf(JSON.stringify("\"); alert(1); (\"")) > 0);
    await eng.find(s, "q", true);
    ok("backwards is passed as backwards", /window\.find\("q", false, true,/.test(asked[3]));
    await eng.find(s, "y".repeat(5000));
    ok("a search is at most 200 characters", asked[4].indexOf("y".repeat(201)) < 0 && asked[4].indexOf("y".repeat(200)) > 0);
  }

  section("zoom");
  {
    const asked = [];
    const page = fakePage((x) => { asked.push(x); return true; });
    const s = session(page);
    ok("150% is a step", (await eng.zoom(s, 1.5)) === 1.5 && /zoom = "1.5"/.test(asked[0]));
    ok("1.33 snaps to 125%", (await eng.zoom(s, 1.33)) === 1.25);
    ok("held to 200%", (await eng.zoom(s, 50)) === 2);
    ok("held to 50%", (await eng.zoom(s, -3)) === 0.5);
    ok("100% clears it rather than setting it", (await eng.zoom(s, 1)) === 1 && /zoom = ''/.test(asked[asked.length - 1]));
    ok("the picture keeps the panel's size", page.count("Emulation.setDeviceMetricsOverride") === 0);
  }

  section("a panel that is hidden");
  {
    const page = fakePage(() => true);
    const s = session(page);
    eng._wirePage(s, s.active);
    const a = { got: 0, onFrame() { this.got++; }, onEvent() {} };
    const b = { got: 0, onFrame() { this.got++; }, onEvent() {} };
    await eng.attach(s, a);
    await eng.attach(s, b);
    const frame = () => page.emit("Page.screencastFrame", { data: "", sessionId: 1 });
    frame();
    await wait(5);
    ok("two panels, both get the picture", a.got === 1 && b.got === 1);
    await eng.pause(s, a, true);
    frame();
    await wait(5);
    ok("one hidden: it gets nothing, the other still does", a.got === 1 && b.got === 2 && s.casting);
    const stops = page.count("Page.stopScreencast");
    await eng.pause(s, b, true);
    ok("both hidden: the screencast stops", !s.casting && page.count("Page.stopScreencast") === stops + 1);
    const starts = page.count("Page.startScreencast");
    await eng.pause(s, b, false);
    ok("shown again: it starts at once", s.casting && page.count("Page.startScreencast") === starts + 1);
    await eng.detach(s, b);
    ok("the visible one leaves, the hidden one stays: stopped", !s.casting);
  }

  section("a download is never bigger than the temporary space");
  {
    const fsm = require("fs");
    const real = fsm.statfsSync;
    const e3 = new Engine({ config: { enabled: false, downloadMaxMB: 200 }, log: () => {} });
    clearInterval(e3._sweep);
    fsm.statfsSync = () => ({ bavail: (70 * 1048576) / 4096, bsize: 4096 });
    ok("with 70 MB free (a 100 MB tmpfs), the most is 40 MB, not 200", Math.round(e3.downloadRoom() / 1048576) === 40);
    ok("what a download already holds counts as its own", Math.round(e3.downloadRoom({ got: 20 * 1048576 }) / 1048576) === 60);
    fsm.statfsSync = () => ({ bavail: (900 * 1048576) / 4096, bsize: 4096 });
    ok("with room to spare, the setting decides", Math.round(e3.downloadRoom() / 1048576) === 200);
    fsm.statfsSync = () => { throw new Error("no statfs"); };
    ok("and where free space cannot be read, the setting alone", Math.round(e3.downloadRoom() / 1048576) === 200);
    fsm.statfsSync = real;
  }

  section("an unused browser stops");
  {
    const e2 = new Engine({ config: { enabled: false, parkMinutes: 10 }, log: () => {} });
    clearInterval(e2._sweep);
    let killed = 0;
    /* A stand-in Chromium, as the shared host (browser-engine.js _launch). */
    const arm = () => {
      e2.ready = true;
      const p = { exitCode: null, kill() { killed++; this.exitCode = 0; }, once(ev, fn) { fn(); } };
      e2.main = { proc: p, profile: require("path").join(require("os").tmpdir(), "fk-no-such-profile"), sink: null };
      e2.hosts.add(e2.main);
      e2.proc = p;
    };
    arm();
    e2.lastUsed = Date.now() - 9 * 60000;
    e2.evictIdle();
    ok("nine minutes unused: still running", e2.ready && killed === 0);
    e2.lastUsed = Date.now() - 11 * 60000;
    e2.sessions.set("x", { key: "x", viewers: new Set([{}]), lastSeen: Date.now() - 11 * 60000 });
    e2.evictIdle();
    ok("eleven minutes, but a session is open: still running", e2.ready && killed === 0);
    e2.sessions.clear();
    e2.evictIdle();
    ok("eleven minutes and no sessions: Chromium is stopped", !e2.ready && killed === 1 && e2.proc === null);
    arm();
    e2.cfg.parkMinutes = 0;
    e2.lastUsed = 0;
    e2.evictIdle();
    ok("parkMinutes 0: never", e2.ready && killed === 1);
    arm();
    e2.cfg.parkMinutes = 10;
    e2.lastUsed = Date.now() - 11 * 60000;
    e2.sessions.set("y", { key: "y", viewers: new Set(), lastSeen: Date.now() - 2 * 60000 });
    e2.evictIdle();
    e2.sessions.clear();
    e2.evictIdle();
    ok("a session used two minutes ago counts as use, even once it is gone", e2.ready && killed === 1);
  }

  section("the route");
  {
    const rt = route.init({ config: { enabled: true, video: false }, log: () => {} });
    const fake = { url: "about:blank", title: "", zoom: 1 };
    const did = [];
    rt.sessionFor = async () => fake;
    rt.resize = async () => {};
    rt.attach = async () => {};
    rt.detach = async () => {};
    rt.copyText = async () => { did.push("copy"); return "picked"; };
    rt.key = async (s, e) => { did.push(e.type + ":" + e.key + ":" + e.modifiers); };
    rt.find = async (s, t, back) => { did.push("find:" + t + ":" + back); return t === "yes"; };
    rt.zoom = async (s, z) => { did.push("zoom:" + z); return 1.25; };
    rt.pause = async (s, v, on) => { did.push("pause:" + on); };

    const srv = http.createServer();
    srv.on("upgrade", (req, sock, head) => route.upgrade(req, sock, head, new URL(req.url, "http://x")));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const sock = new WebSocket("ws://127.0.0.1:" + srv.address().port + "/browser/stream?t=" + route._internals.issue("u"));
    const got = [];
    sock.addEventListener("message", (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); });
    await new Promise((r) => sock.addEventListener("open", r));
    const send = (o) => sock.send(JSON.stringify(o));
    send({ t: "hello", w: 1000, h: 600 });
    await until(() => got.some((m) => m.t === "ready"));
    ok("ready says the zoom", got.find((m) => m.t === "ready").zoom === 1);

    send({ t: "copy" });
    await until(() => got.some((m) => m.t === "copied"));
    ok("copy answers with the text", got.find((m) => m.t === "copied").text === "picked");
    did.length = 0;
    send({ t: "copy", cut: true });
    await until(() => did.length >= 3);
    ok("cut: copied first, then the page's own Ctrl-X", did.join(",") === "copy,keydown:x:2,keyup:x:2", did.join(","));
    send({ t: "find", text: "yes", back: true });
    await until(() => got.some((m) => m.t === "found"));
    ok("find answers yes or no", got.find((m) => m.t === "found").ok === true && did.indexOf("find:yes:true") >= 0);
    send({ t: "zoom", zoom: "1.3" });
    await until(() => got.some((m) => m.t === "zoomed"));
    ok("zoom answers with the step it landed on", got.find((m) => m.t === "zoomed").zoom === 1.25);
    send({ t: "pause", on: 1 });
    await until(() => did.indexOf("pause:true") >= 0);
    ok("pause reaches the engine as a yes/no", did.indexOf("pause:true") >= 0);

    did.length = 0;
    for (let i = 0; i < route._internals.INPUT_PER_SEC + 40; i++) send({ t: "find", text: "x" });
    await wait(300);
    ok("finds count against the same input limit as keys (" + did.length + ")", did.length <= route._internals.INPUT_PER_SEC);
    sock.close();
    srv.close();
  }

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
