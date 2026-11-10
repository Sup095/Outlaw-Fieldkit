/* ============================================================
   GAME MODE: the copy of the Outlaw Engine (tools/sync-games.js), the
   relay's ticketed copy (relay/games.js) and the panel
   (modules/game-mode.js).

   What matters:
     1. The engine is copied exactly as it is, and only what it needs to
        run: never its source, tools, handoff notes or plans.
     2. Through the relay only people who are signed in can open it, the
        ticket runs out, and nothing outside the copy can be reached.
     3. The games are never in the repo or a public release.
     4. The panel opens full screen with a way back, and finds the copy.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "modules/game-mode.js"]);
const { ok, section, state } = makeRunner("game-mode");
const sync = require("../tools/sync-games");
const games = require("../relay/games");

function fakeEngine() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fk-oe-"));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
  put("index.html", "<!doctype html><title>Outlaw Engine</title><style>body{color:#0f0}</style>");
  put("engine/outlaw-core.js", "const Outlaw = { version: \"3.2.0\" };");
  put("engine/outlaw-catalog.js", "window.OUTLAW_CATALOG = " + JSON.stringify({
    sections: [{ key: "a", group: "GAMES", label: "ARCADE", ids: ["slope", "space"] }, { key: "b", group: "APPS", label: "TOOLS", ids: ["hub"] }, { key: "c", group: "LEGACY", label: "OLD", ids: ["x"] }],
    entries: [{ id: "slope", title: "Slope" }, { id: "space", title: "Space Game" }, { id: "hub", title: "StudyHub" }, { id: "x", title: "Old" }]
  }) + ";");
  put("games/slope.html", "<!doctype html><p>slope</p>");
  put("vendor/fonts/a.woff2", "font");
  put("src/slope.html", "working copy");
  put("tools/build.py", "print(1)");
  put("handoff/HANDOFF.md", "private notes");
  put("COMPLETION-PLAN.md", "plan");
  put("games/__pycache__/x.pyc", "junk");
  return d;
}

(async () => {
  section("the copy");
  const src = fakeEngine();
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fk-gm-")), "outlaw-engine");
  const info = sync.sync(src, dest);
  ok("the engine is copied byte for byte", fs.readFileSync(path.join(dest, "index.html"), "utf8") === fs.readFileSync(path.join(src, "index.html"), "utf8") && fs.existsSync(path.join(dest, "vendor/fonts/a.woff2")));
  ok("only what runs: no source, tools, handoff, plans or junk", ["src", "tools", "handoff", "COMPLETION-PLAN.md", "games/__pycache__"].every((p) => !fs.existsSync(path.join(dest, p))));
  ok("it says what is in the library", info.version === "3.2.0" && info.library.games === 2 && info.library.apps === 1 && info.library.sections[0].titles.join() === "Slope,Space Game");
  ok("and never where it came from on this computer", !fs.readFileSync(path.join(dest, "fieldkit-games.js"), "utf8").includes(src.split(path.sep).pop()) && !("from" in info));
  fs.rmSync(path.join(src, "games/slope.html"));
  sync.sync(src, dest);
  ok("a game removed there is removed here", !fs.existsSync(path.join(dest, "games/slope.html")));
  let bad = null; try { sync.sync(os.tmpdir(), dest + "2"); } catch (e) { bad = e; }
  ok("a folder that is not the engine is refused", bad && /not an Outlaw Engine folder/.test(bad.message));

  section("through the relay");
  let now = Date.now();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "fk-gk-"));
  games.init({ dataDir: data, root: dest, now: () => now });
  const call = async (method, p, who) => {
    const u = new URL("http://relay" + p);
    let out = null, head = null, chunks = [];
    const res = {
      writeHead(c, h) { head = { status: c, headers: h }; },
      write(c) { chunks.push(Buffer.from(c)); }, end(c) { if (c) chunks.push(Buffer.from(c)); res._done(); },
      on() { return res; }, once() { return res; }, emit() { return res; }, removeListener() { return res; }, _done() {}
    };
    const finished = new Promise((r) => { res._done = r; });
    const handled = await games.route({ method, headers: {}, url: u.pathname }, res, u, { send: (r, s, b) => { out = { status: s, b }; res._done(); return true; }, readBody: async () => ({}), who: () => who || null });
    if (!handled) return null;
    if (!out && !chunks.length && head) {
      /* a stream: read the file the way pipe() would */
      await Promise.race([finished, new Promise((r) => setTimeout(r, 200))]);
    }
    return out || { status: head.status, headers: head.headers, body: Buffer.concat(chunks).toString("utf8") };
  };
  /* pipe() needs a real stream to write to; give the route one */
  const { Writable } = require("stream");
  const get = (p) => new Promise((resolve) => {
    const u = new URL("http://relay" + p), bufs = [];
    let head = null;
    const w = new Writable({ write(c, e, cb) { bufs.push(Buffer.from(c)); cb(); } });
    w.writeHead = (c, h) => { head = { status: c, headers: h }; };
    w.on("finish", () => resolve({ status: head.status, headers: head.headers, body: Buffer.concat(bufs).toString("utf8") }));
    games.route({ method: "GET", headers: {}, url: u.pathname }, w, u, { send: (r, st, b) => { resolve({ status: st, headers: {}, body: JSON.stringify(b) }); return true; }, readBody: async () => ({}), who: () => null })
      .then((handled) => { if (!handled) resolve({ status: 404, headers: {}, body: "" }); });
  });
  ok("anyone can ask whether the relay has them", (await call("GET", "/games/status")).b.up === true);
  const no = await call("POST", "/games/ticket", null);
  ok("a ticket needs a sign-in", no.status === 401 && no.b.needsSignIn);
  const t = await call("POST", "/games/ticket", { name: "ava" });
  ok("signed in, you get a path with a ticket", t.status === 200 && /^\/games\/t\/[0-9a-z]+\.[A-Za-z0-9_-]{22}\/index\.html$/.test(t.b.path));
  const base = t.b.path.replace("index.html", "");
  const page = await get(t.b.path);
  ok("the engine is served exactly as it is", page.status === 200 && page.body === fs.readFileSync(path.join(dest, "index.html"), "utf8") && /text\/html/.test(page.headers["Content-Type"]));
  ok("and never tells another site the ticket", page.headers["Referrer-Policy"] === "no-referrer" && /private/.test(page.headers["Cache-Control"]));
  const font = await get(base + "vendor/fonts/a.woff2");
  ok("its own files come with it", font.status === 200 && font.headers["Content-Type"] === "font/woff2");
  for (const p of ["..%2F..%2Fgames-key", "%2e%2e/%2e%2e/x", "fieldkit-games.js/../../x", ".hidden"]) {
    const r = await get(base + p);
    ok("nothing outside the copy: " + p, r.status === 404 || r.status === 403);
  }
  const forged = t.b.path.replace(/\.[A-Za-z0-9_-]{22}\//, "." + "A".repeat(22) + "/");
  ok("a made-up ticket is refused", (await get(forged)).status === 403);
  now += games.TICKET_MS + 1000;
  ok("and a ticket runs out", (await get(t.b.path)).status === 403);
  games.init({ dataDir: data, root: path.join(os.tmpdir(), "nope-" + Date.now()) });
  ok("a relay with no copy says so", (await call("GET", "/games/status")).b.up === false && (await call("POST", "/games/ticket", { name: "a" })).status === 503);

  section("the panel");
  {
    window.FK_GAMES = info;
    const ui = FieldKit.need("ui");
    const host = fakeElement("div");
    const all = (node) => { const out = []; (function w(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); w(c); } }); })(node); return out; };
    const text = () => all(host).map((n) => n.textContent || "").join(" | ");
    const def = FieldKit.modules()["game-mode"];
    ok("it is in both builds' GAMES group, for guests too", def.group === "GAMES" && def.guestSafe === true && typeof def.selfcheck === "function");
    const mountP = def.mount(host, { settings: FieldKit.need("settings"), ui, log() {}, warn() {}, error() {}, on() {}, emit() {} });
    await new Promise((r) => setTimeout(r, 30));
    ok("it opens on ENTER GAME MODE", /ENTER GAME MODE/.test(text()) && /PLAY IN THIS WINDOW/.test(text()));
    def.unmount();
    void mountP;
  }

  section("wired into FieldKit, kept apart");
  {
    const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    ok("both builds carry the panel", ["FIELDKIT.html", "OUTPOST.html"].every((f) => /"modules\/game-mode\.js"/.test(rd(f))));
    ok("the games are never committed or published", /^games\/$/m.test(rd(".gitignore")));
    ok("drives get them, outside the manifest (the engine checks itself)", /PAYLOAD_BASE = \[[^\]]*"games"/.test(rd("build.js")) && /UNHASHED = \[[^\]]*"games"/.test(rd("build.js")));
    ok("the relay image gets them, and routes /games", /"games\.js"/.test(rd("tools/make-deploy.js")) && /outlaw-engine/.test(rd("tools/make-deploy.js")) && /seg\[0\] === "games"/.test(rd("relay/server.js")));
    ok("FieldKit's diagnostics do not run the engine's", !/outlaw-diagnostics|SYSTEM CHECK/.test(rd("core/selftest.js")));
    ok("the panel never builds markup from text", !/innerHTML/.test(rd("modules/game-mode.js")));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
