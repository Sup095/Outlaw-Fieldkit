/* ============================================================
   The browser, lean (FIELDKIT_PROJECT.md §14.42).

   Measured first, on CrazyGames in the relay's real image with the
   live container's limits: one game page opened a dozen ad and
   tracker frames, each its own Chromium process; the game itself
   could not reach its multiplayer server (port 19093 was refused);
   and a session's profile and shared memory lived in a 100 MB /tmp.
   What matters here:
     1. Ads and trackers are refused by name, parents included, quietly.
     2. The browser may open the high ports games use; RUNNER's jobs
        still may not; private addresses never.
     3. Chromium is started lean, with its profile off /tmp.
     4. Pages nobody can see are frozen, and come back when seen.
     5. A session using too much memory is ended with a sentence,
        and so is the largest one when the container is nearly full.
     6. The default search is DuckDuckGo Lite with safe search.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { makeRunner } = require("./harness");
const { Blocklist, CORE } = require("../relay/blocklist");
const { clean } = require("../relay/fetch-adblock");
const { Guard } = require("../relay/guard");
const { Engine, renderPlan } = require("../relay/browser-engine");
const { Transcoder } = require("../relay/video-encoder");
const { ok, section, state } = makeRunner("browser-lean");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-lean-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connectVia(port, target) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n"));
    let got = "";
    s.on("data", (d) => { got += d; if (got.indexOf("\r\n") > 0) { s.destroy(); resolve(got.split("\r\n")[0]); } });
    s.on("error", () => resolve("error"));
    setTimeout(() => { s.destroy(); resolve(got.split("\r\n")[0] || "timeout"); }, 4000);
  });
}

(async () => {
  section("the ad blocker");
  {
    const list = path.join(TMP, "hosts.txt");
    fs.writeFileSync(list, "# a comment\n0.0.0.0 ads.example.com\n0.0.0.0 tracker.example.net # trailing\nbare.example.org\n127.0.0.1 localhost\n0.0.0.0 0.0.0.0\n");
    const a = new Blocklist({ baseFiles: [list], allow: ["ok.ads.example.com"] });
    await a.start();
    ok("a listed host is refused", a.match("ads.example.com"));
    ok("and anything under it", a.match("x.y.ads.example.com"));
    ok("but not its parent", !a.match("example.com") && !a.match("www.example.com"));
    ok("hosts-file and bare lines both count; localhost does not", a.match("tracker.example.net") && a.match("bare.example.org") && !a.match("localhost"));
    ok("an allowed host is never refused, even under a listed one", !a.match("ok.ads.example.com"));
    ok("the big ad networks are refused with no list at all", new Blocklist({ baseFiles: [path.join(TMP, "none.txt")] }).match("securepubads.g.doubleclick.net") && CORE.length > 40);
    ok("switched off, it refuses nothing", !new Blocklist({ enabled: false }).match("doubleclick.net"));
    const names = clean("0.0.0.0 a.example.com\n127.0.0.1 b.example.com\n# 0.0.0.0 c.example.com\n1.2.3.4 evil.example.com\n0.0.0.0 localhost\nfe80::1 x.example.com\n");
    ok("the fetched list keeps only blocking lines with real names", JSON.stringify(names) === JSON.stringify(["a.example.com", "b.example.com"]), JSON.stringify(names));
  }

  section("the guard: ads, game ports, private addresses");
  {
    const logs = [];
    const ads = new Blocklist({ baseFiles: [] });
    const g = new Guard({ log: (l, m) => logs.push(m), dnsFilter: "off", lists: ads, ports: "browser" });
    const port = await g.listen();
    const r1 = await connectVia(port, "googlesyndication.com:443");
    ok("an ad host is refused", /403/.test(r1), r1);
    ok("without a log line for it", !logs.some((m) => /googlesyndication/.test(m)) && g.stats.refusedAds === 1);
    ok("the browser may use a game's high port", g.portOk(19093) && g.portOk(5055) && g.portOk(443));
    ok("but not mail and other low ports", !g.portOk(25) && !g.portOk(587) && !g.portOk(22) && !g.portOk(0) && !g.portOk(70000));
    const r2 = await connectVia(port, "127.0.0.1:19093");
    ok("and never a private address, on any port", /403/.test(r2), r2);
    g.close();
    const web = new Guard({ log: () => {}, dnsFilter: "off" });
    ok("RUNNER's jobs keep the web ports only", web.portOk(443) && !web.portOk(19093) && !web.portOk(5055));
    ok("plain http stays on 80 and 8080 for jobs", web.portOk(80, true) && !web.portOk(443, true));
  }

  section("Chromium, started lean");
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "relay", "browser-engine.js"), "utf8");
    ok("site isolation off: one process per frame was the cost", /IsolateOrigins,site-per-process/.test(src) && /--disable-site-isolation-trials/.test(src));
    ok("a renderer limit, a capped cache, no extensions or updaters", /--renderer-process-limit=/.test(src) && /--disk-cache-size=/.test(src) &&
      /--disable-extensions/.test(src) && /--disable-component-update/.test(src));
    ok("its temporary files and shared memory go with its profile", /TMPDIR: path\.join\(profile, "tmp"\)/.test(src));
    const root = path.join(TMP, "profiles");
    process.env.FK_BROWSER_TMP = root;
    const e = new Engine({ config: { enabled: true }, log: () => {} });
    ok("profiles go where FK_BROWSER_TMP says (the server's disk), not /tmp", e._profileRoot() === root);
    const stale = path.join(root, "fk-browser-AbC123"), fresh = path.join(root, "fk-browser-XyZ789"), other = path.join(root, "keep-me");
    [stale, fresh, other].forEach((d) => fs.mkdirSync(d, { recursive: true }));
    const old = new Date(Date.now() - 3600000);
    fs.utimesSync(stale, old, old); fs.utimesSync(other, old, old);
    e._sweepProfiles();
    ok("a profile left by a Chromium that died is swept; a fresh one and other folders are not",
      !fs.existsSync(stale) && fs.existsSync(fresh) && fs.existsSync(other));
    delete process.env.FK_BROWSER_TMP;
    const docker = fs.readFileSync(path.join(__dirname, "..", "relay", "docker", "Dockerfile"), "utf8");
    ok("the image fetches the ad list and points profiles at the server's disk",
      /node fetch-adblock\.js/.test(docker) && /FK_BROWSER_TMP=\/home\/container/.test(docker));
    const bundle = fs.readFileSync(path.join(__dirname, "..", "tools", "make-deploy.js"), "utf8");
    ok("and both files ship", /"blocklist\.js"/.test(bundle) && /"fetch-adblock\.js"/.test(bundle));
    e.stop();
  }

  /* A session with fake pages: what was asked of each. */
  const said = [];
  const page = (id) => ({ send: async (m, p) => { said.push(id + " " + m + " " + (p && p.state || "")); return {}; } });
  const mk = (eng, extra) => {
    const t1 = { id: "t1", page: page("t1") }, t2 = { id: "t2", page: page("t2") };
    const s = Object.assign({ key: "k", who: "w", tier: "member", tabs: [t1, t2], active: t1, viewers: new Set(), lastSeen: Date.now(), audio: null }, extra || {});
    eng.sessions.set(s.key, s);
    return { s, t1, t2 };
  };

  section("pages nobody can see are frozen");
  {
    const eng = new Engine({ config: { enabled: true, freezeAfterSec: 1 }, log: () => {} });
    const { s, t1, t2 } = mk(eng);
    s.viewers.add({ paused: false });
    await eng._life(s);
    ok("the tab on screen stays live; the one behind it is frozen", t1.life === "active" && t2.life === "frozen");
    said.length = 0;
    await eng._life(s);
    ok("and nothing is asked again when nothing changed", said.length === 0);
    s.viewers.clear(); s.lastSeen = Date.now() - 5000;
    await eng._life(s);
    ok("nobody watching for a while: the one on screen is frozen too", t1.life === "frozen");
    s.audio = {};
    await eng._life(s);
    ok("unless someone is listening to it", t1.life === "active");
    s.audio = null; s.viewers.add({ paused: false }); s.lastSeen = Date.now();
    s.active = t2;
    await eng._life(s);
    ok("switching tabs wakes the new one and freezes the old", t2.life === "active" && t1.life === "frozen");
    eng.stop();
  }

  section("one session cannot take the browser down");
  {
    const logs = [];
    const eng = new Engine({ config: { enabled: true, sessionMemMB: 1000 }, log: (l, m) => logs.push(m) });
    const ended = [];
    eng.destroy = async (key, why) => { ended.push(why); eng.sessions.delete(key); return true; };
    const { s } = mk(eng, { host: { proc: { pid: 1 }, watch: { read: () => ({ memMb: 2500 }) } } });
    await eng._watchdog();
    ok("a session past its memory is ended", ended.length === 1 && /needed 2500 MB/.test(ended[0]), ended.join(" | "));
    ok("with a sentence the person can act on, and a line in the log", /Open the browser again/.test(ended[0]) && logs.some((m) => /over the 1000 MB/.test(m)));
    void s;
    eng.stop();
  }

  section("how pages are drawn, and what happens when that fails");
  {
    const has = (...names) => (f) => names.includes(f);
    const NV = "/usr/share/glvnd/egl_vendor.d/10_nvidia.json", LVP = "/usr/share/vulkan/icd.d/lvp_icd.json";
    let p = renderPlan("auto", 4, has("/dev/nvidia0", NV, LVP));
    ok("a card and its EGL driver: on the card, through EGL", p.mode === "gpu" && p.args.includes("--use-angle=gl-egl") && p.env.__EGL_VENDOR_LIBRARY_FILENAMES === NV);
    p = renderPlan("auto", 3, has(LVP));
    ok("no card: llvmpipe, with its threads capped", p.mode === "cpu" && p.args.includes("--use-angle=vulkan") && p.env.LP_NUM_THREADS === "3" && p.env.VK_ICD_FILENAMES === LVP);
    ok("asked for the processor, a card is left alone", renderPlan("cpu", 4, has("/dev/nvidia0", NV, LVP)).mode === "cpu");
    ok("neither: the old way, which always starts", renderPlan("auto", 4, has()).args.join() === "--disable-gpu");
    ok("and off means off", renderPlan("off", 4, has("/dev/nvidia0", NV, LVP)).mode === "off");

    const logs = [], pics = [];
    const eng = new Engine({ config: { enabled: true, maxFps: 20 }, log: (l, m) => logs.push(m) });
    const hand = {};
    const sends = [];
    const page = { on: (e, f) => { hand[e] = f; }, send: async (m, o) => { sends.push(m + (o && o.sessionId ? ":" + o.sessionId : "")); } };
    const pushed = [];
    const v = { paused: false, onFrame: (d) => pics.push(d), onEvent: (m) => pushed.push(m) };
    const tab = { id: "t", page: page, url: "https://game.example/", title: "" };
    const s = { key: "k", who: "sam", tier: "member", tabs: [tab], active: tab, page: page, viewers: new Set([v]), url: tab.url };
    eng._wirePage(s, tab);
    hand["Page.screencastFrame"]({ data: "a", sessionId: 1 });
    hand["Page.screencastFrame"]({ data: "b", sessionId: 2 });
    hand["Page.screencastFrame"]({ data: "c", sessionId: 3 });
    ok("every picture goes out at once", pics.join("") === "abc");
    ok("the first is acknowledged straight away, the rest wait their turn", sends.filter((x) => /Ack/.test(x)).length === 1, sends.join());
    await wait(130);
    ok("one turn per picture, so two out at once cannot double the rate", sends.filter((x) => /Ack/.test(x)).length === 3, sends.join());
    sends.length = 0;
    hand["Inspector.targetCrashed"]();
    ok("a page that crashes is opened again, and the person is told", sends.includes("Page.reload") && pushed.some((m) => m.t === "note" && /crashed/.test(m.why)));
    hand["Inspector.targetCrashed"]();
    hand["Inspector.targetCrashed"]();
    ok("not for ever", sends.filter((x) => x === "Page.reload").length === 2 && pushed.some((m) => /keeps crashing/.test(m.why || "")));

    /* What the watchdog does with what it measures. */
    pushed.length = 0;
    const ended = [];
    eng.destroy = async (key, why) => { ended.push(key); eng.sessions.delete(key); return true; };
    const hostOf = (mb, cpu) => ({ proc: { pid: 1 }, watch: { read: () => ({ memMb: mb, cpu: cpu }) } });
    eng.sessions.set("k", Object.assign(s, { host: hostOf(300, 2), tabs: [] }));
    await eng._watchdog(); await eng._watchdog();
    ok("heavy for a moment is not heavy", !pushed.some((m) => m.t === "heavy"));
    await eng._watchdog();
    ok("heavy for 15 s: the panel hears", pushed.filter((m) => m.t === "heavy").length === 1 && pushed.find((m) => m.t === "heavy").url === tab.url);
    await eng._watchdog();
    ok("once per address", pushed.filter((m) => m.t === "heavy").length === 1);

    /* A page that breaks the card. */
    const moved = [];
    eng.spare = null;
    const card = { render: { mode: "gpu" } };
    s.host = card;
    s.viewers.add({ onMove: () => moved.push(1) });
    eng._cardFault(card);
    ok("a page that breaks the card: its panel reconnects, its page is remembered", moved.length === 1 && eng.softly.get("k") === tab.url && ended.includes("k"));
    ok("and it is said in the log", logs.some((m) => /broke the graphics card/.test(m)));
    {
      const name = new URL(tab.url).hostname;
      ok("and the site is remembered, so the next session does not crash into it", !name || eng.cardAvoid.has(name));
      eng.cardAvoid.add("example-breaks.test");
      moved.length = 0;
      const shy = { key: "k2", who: "w", url: "https://play.example-breaks.test/game", host: { render: { mode: "gpu" } }, viewers: new Set(), tabs: [] };
      eng.sessions.set("k2", shy);
      shy.viewers.add({ onMove: () => moved.push("k2") });
      ok("a session reaching a known site leaves the card before anything is drawn", eng._shyOfCard(shy) === true && moved.length === 1 && eng.softly.has("k2"));
      const fine = { key: "k3", who: "w", url: "https://fine.example/", host: { render: { mode: "gpu" } }, viewers: new Set(), tabs: [] };
      ok("any other site stays on it", eng._shyOfCard(fine) === false);
      const cpu = { key: "k4", who: "w", url: "https://play.example-breaks.test/", host: { render: { mode: "cpu" } }, viewers: new Set(), tabs: [] };
      ok("and on the processor there is nothing to leave", eng._shyOfCard(cpu) === false);
    }
    eng.stop();
  }

  section("video on the card");
  {
    /* A stand-in encoder that writes nothing and stops, then one that works. */
    const script = path.join(TMP, "enc.js");
    fs.writeFileSync(script, "if (process.argv.includes('h264_nvenc')) process.exit(1);\nprocess.stdin.on('data', () => process.stdout.write(Buffer.from([0,0,0,1,9,0x10,0,0,1,0x65,1])));\nprocess.stdin.on('end', () => process.exit(0));");
    const tx = new Transcoder({ ffmpeg: [process.execPath, script], kbps: 800, card: true });
    let frames = 0, failed = null;
    tx.on("frame", () => frames++);
    tx.on("fail", (w) => { failed = w; });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 0xff, 0xd9]);
    tx.feed(jpeg);
    await wait(700);
    ok("a card that will not encode: x264 takes over, and the panel never knows", !tx.card && !failed && frames > 0, "frames " + frames + " " + failed);
    tx.close();
  }

  section("search");
  {
    const route = fs.readFileSync(path.join(__dirname, "..", "relay", "browser-route.js"), "utf8");
    const ex = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "relay", "config.example.json"), "utf8"));
    ok("the default is DuckDuckGo Lite with strict safe search", /https:\/\/lite\.duckduckgo\.com\/lite\/\?kp=1&q=/.test(route) &&
      ex.browser.searchUrl === "https://lite.duckduckgo.com/lite/?kp=1&q=");
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
