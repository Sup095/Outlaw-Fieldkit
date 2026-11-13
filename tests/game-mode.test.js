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
    /* a relay is set, so the games may be there: the way in is offered */
    FieldKit.need("settings").set("relayUrl", "https://relay.example");
    const mountP = def.mount(host, { settings: FieldKit.need("settings"), ui, log() {}, warn() {}, error() {}, on() {}, emit() {} });
    await new Promise((r) => setTimeout(r, 30));
    ok("it opens on ENTER GAME MODE", /ENTER GAME MODE/.test(text()) && /PLAY IN THIS WINDOW/.test(text()));
    def.unmount();
    void mountP;
  }

  section("a library of your own (tools/add-games.js)");
  {
    const addGames = require("../tools/add-games");
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), "fk-mine-"));
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(mine, rel)), { recursive: true }); fs.writeFileSync(path.join(mine, rel), text); };
    put("slope.html", "<!doctype html><title>Slope <Run></title><p>slope</p>");
    put("tetris/index.html", "<!doctype html><p>tetris</p>");
    put("tetris/tetris.js", "1");
    put("my-notes.html", "<!doctype html><p>notes</p>");
    put("shared/a.js", "2");
    put(".secret/x.html", "hidden");
    put("games.json", JSON.stringify({ name: "Kay's Arcade", about: { slope: "Roll." }, titles: { tetris: "Blocks </script><b>" },
      sections: [{ label: "TOOLS", group: "APPS", items: ["my-notes", "nope"] }] }));
    const gdir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fk-gd-")), "games");
    const lib = path.join(gdir, "library");
    const li = addGames.add(mine, lib, {});
    ok("every game in the folder is found: single files and folders", li.library.games === 2 && li.library.apps === 1 && fs.existsSync(path.join(lib, "tetris/tetris.js")) && fs.existsSync(path.join(lib, "shared/a.js")));
    ok("it is named, grouped and titled from games.json, a page's title, or the file name", li.engine === "Kay's Arcade" && li.library.sections[0].label === "TOOLS" && li.library.sections[0].titles.join() === "My Notes" && li.library.sections[1].label === "GAMES");
    ok("dot-folders and games.json itself are not copied", !fs.existsSync(path.join(lib, ".secret")) && !fs.existsSync(path.join(lib, "games.json")));
    const hub = fs.readFileSync(path.join(lib, "index.html"), "utf8");
    ok("a page listing them is written, which never builds markup from a name", /var LIBRARY = /.test(hub) && !/innerHTML/.test(hub) && hub.indexOf("</script><b>") < 0 && /textContent/.test(hub));
    ok("and it never says where it came from on this computer", !fs.readFileSync(path.join(lib, "fieldkit-games.js"), "utf8").includes(path.basename(mine)) && !hub.includes(path.basename(mine)));
    {
      const sj = JSON.parse(fs.readFileSync(path.join(lib, "shelf", "shelf.json"), "utf8"));
      const ids = sj.games.map((g) => g.id).sort().join();
      ok("your games get a shelf too, one file each, so GAME MODE can keep them on a device",
        li.shelf && li.shelf.games === 3 && ids === "my-notes,slope,tetris" && sj.name === "Kay's Arcade" &&
        sj.games.every((g) => /^[0-9a-f]{16}$/.test(g.sha) && fs.existsSync(path.join(lib, "shelf", g.file))) &&
        sj.games.filter((g) => g.id === "slope")[0].desc === "Roll." && !JSON.stringify(sj).includes(path.basename(mine)));
    }
    put("index.html", "<!doctype html><p>my own front page</p>");
    addGames.add(mine, lib, {});
    ok("a folder with its own index.html keeps it", /my own front page/.test(fs.readFileSync(path.join(lib, "index.html"), "utf8")));
    fs.rmSync(path.join(mine, "index.html"));
    addGames.add(mine, lib, { name: "Renamed" });
    let empty = null; try { addGames.add(fs.mkdtempSync(path.join(os.tmpdir(), "fk-none-")), lib + "2", {}); } catch (e) { empty = e; }
    ok("an empty folder is refused, with what a game is", empty && /no games found/.test(empty.message) && /index\.html/.test(empty.message));
    let self = null; try { addGames.add(path.dirname(gdir), lib, {}); } catch (e) { self = e; }
    ok("and so is a folder that holds the library itself", !!self);

    /* the relay: your library alone, then with the Outlaw Engine beside it */
    const data2 = fs.mkdtempSync(path.join(os.tmpdir(), "fk-gk2-"));
    const { Writable } = require("stream");
    const get2 = (p) => new Promise((resolve) => {
      const u = new URL("http://relay" + p), bufs = [];
      let head = null;
      const w = new Writable({ write(c, e, cb) { bufs.push(Buffer.from(c)); cb(); } });
      w.writeHead = (c, h) => { head = { status: c, headers: h }; };
      w.on("finish", () => resolve({ status: head.status, body: Buffer.concat(bufs).toString("utf8") }));
      games.route({ method: "GET", headers: {}, url: u.pathname }, w, u, { send: (r, st, b) => { resolve({ status: st, body: JSON.stringify(b) }); return true; }, readBody: async () => ({}), who: () => null });
    });
    const ask = (method, p, who) => new Promise((resolve) => {
      const u = new URL("http://relay" + p);
      games.route({ method, headers: {}, url: u.pathname }, {}, u, { send: (r, s, b) => { resolve({ status: s, b }); return true; }, readBody: async () => ({}), who: () => who || null });
    });
    let g = games.init({ dataDir: data2, dir: gdir });
    ok("a relay with only your library serves it, under its name", g.up && g.name === "Renamed" && (await ask("GET", "/games/status")).b.name === "Renamed");
    let t2 = await ask("POST", "/games/ticket", { name: "ava" });
    ok("the way in is the library's page", /\/library\/index\.html$/.test(t2.b.path) && (await get2(t2.b.path)).status === 200);
    sync.sync(src, path.join(gdir, "outlaw-engine"));
    g = games.init({ dataDir: data2, dir: gdir });
    t2 = await ask("POST", "/games/ticket", { name: "ava" });
    const base2 = t2.b.path.replace("library/index.html", "");
    ok("with the Outlaw Engine beside it, the library is still the way in and can reach the engine", g.name === "Renamed" && (await get2(base2 + "outlaw-engine/index.html")).status === 200 && (await get2(base2 + "outlaw-engine/fieldkit-games.js")).status === 200);
    ok("still nothing outside the games folder", [404, 403].includes((await get2(base2 + "..%2Fgames-key")).status) && [404, 403].includes((await get2(base2 + "library/%2e%2e/%2e%2e/x")).status));
    fs.rmSync(lib, { recursive: true, force: true });
    g = games.init({ dataDir: data2, dir: gdir });
    t2 = await ask("POST", "/games/ticket", { name: "ava" });
    ok("the Outlaw Engine alone is served as before", g.name === "Outlaw Engine" && /\/games\/t\/[^/]+\/index\.html$/.test(t2.b.path));
    ok("a games folder with neither is a relay with no games", games.init({ dataDir: data2, dir: fs.mkdtempSync(path.join(os.tmpdir(), "fk-e-")) }).up === false);
    games.init({ dataDir: data, root: dest, now: () => now });

    /* the pack: one zip to hand over */
    const packer = require("../tools/make-games-pack");
    const zlib = require("zlib");
    ok("the pack's checksum is the standard one", packer.crc32(Buffer.from("123456789")) === 0xcbf43926);
    const p = packer.pack("outlaw-engine", gdir);
    const z = p.buf, nameLen = z.readUInt16LE(26), method = z.readUInt16LE(8), clen = z.readUInt32LE(18);
    const first = z.slice(30, 30 + nameLen).toString("utf8"), body = z.slice(30 + nameLen, 30 + nameLen + clen);
    const back = method === 8 ? zlib.inflateRawSync(body) : body;
    ok("a pack is a real zip with one top folder, and what comes out is what went in", z.readUInt32LE(0) === 0x04034b50 && /^outlaw-engine\//.test(first) &&
      Buffer.compare(back, fs.readFileSync(path.join(gdir, first))) === 0 && z.readUInt16LE(z.length - 22 + 10) === p.files);
    let nolib = null; try { packer.pack("library", gdir); } catch (e) { nolib = e; }
    ok("a pack of a library that is not there says how to make one", nolib && /add-games/.test(nolib.message));
    ok("the pack tool never uploads", !/https?:\/\/|fetch\(|child_process/.test(fs.readFileSync(path.join(__dirname, "..", "tools", "make-games-pack.js"), "utf8")));
  }

  section("a copy with no games, and a copy with no GAME MODE");
  {
    /* a second kernel, so the first panel's "found nothing yet" state is not shared */
    const build = require("../build.js");
    const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    for (const entry of ["FIELDKIT.html", "OUTPOST.html"]) {
      const html = rd(entry), cut = build.withoutGameMode(html);
      ok(entry + " without GAME MODE loses that one line and nothing else", !/modules\/game-mode\.js/.test(cut) && cut.split("\n").length === html.split("\n").length - 1 && /modules\/pool\.js/.test(cut) && /modules\/colony\.js/.test(cut));
    }
    ok("--no-game-mode and the saved choice both turn it off; nothing means on", build.gameModeOff(["node", "build.js", "--no-game-mode"], {}) === true &&
      build.gameModeOff(["node", "build.js"], { gameMode: "off" }) === true && build.gameModeOff(["node", "build.js"], { gameMode: "on" }) === false && build.gameModeOff(["node", "build.js"], {}) === false);
    ok("the second pair has its own names", build.variantOut({ out: "OUTPOST-STANDALONE.html" }) === "OUTPOST-NO-GAME-MODE.html" && /^FIELDKIT-NO-GAME-MODE\.html$/m.test(rd(".gitignore")));
    for (const name of ["FIELDKIT", "OUTPOST"]) {
      const f = path.join(__dirname, "..", name + "-NO-GAME-MODE.html");
      if (!fs.existsSync(f) || build.gameModeOff()) continue;
      const html = fs.readFileSync(f, "utf8"), usual = rd(name + "-STANDALONE.html");
      ok(name + "-NO-GAME-MODE.html is built without the panel's code, and says which it is", !/data-fk-module="modules\/game-mode\.js"/.test(html) && !/gx-overlay/.test(html) && /window\.FK_VARIANT = "NO-GAME-MODE"/.test(html));
      ok("and the usual " + name + " file still has it", /data-fk-module="modules\/game-mode\.js"/.test(usual) && !/FK_VARIANT = /.test(usual.slice(0, usual.indexOf("data-fk-module"))));
    }
    ok("a release carries both kinds, signed", /variantOut\(b\), label: b\.label \+ "-" \+ NO_GAME_MODE/.test(rd("build.js")));
    ok("UPDATE offers a copy without GAME MODE its own file", /FK_VARIANT/.test(rd("modules/updater.js")));
    ok("PREFLIGHT opens whichever kind was downloaded", /FIELDKIT-NO-GAME-MODE\.html/.test(rd("PREFLIGHT.html")) && /OUTPOST-NO-GAME-MODE\.html/.test(rd("PREFLIGHT.html")));

    /* the panel, in a copy where there is nothing to open */
    delete window.FK_GAMES;
    const ui = FieldKit.need("ui");
    const host = fakeElement("div");
    const all = (node) => { const out = []; (function w(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); w(c); } }); })(node); return out; };
    const text = () => all(host).map((n) => n.textContent || "").join(" | ");
    FieldKit.need("settings").set("relayUrl", "");
    const def = FieldKit.modules()["game-mode"];
    const mounted = def.mount(host, { settings: FieldKit.need("settings"), ui, log() {}, warn() {}, error() {}, on() {}, emit() {} });
    /* no file answers a <script> in the test page: fail each probe the way a missing file does */
    for (let i = 0; i < 40; i++) {
      (document.head.children || []).forEach((c) => { if (c && /fieldkit-games\.js$/.test(c.src || "") && c.onerror) { const f = c.onerror; c.onerror = null; f(); } });
      await new Promise((r) => setTimeout(r, 10));
    }
    await mounted;
    ok("with no games and no relay it says so, and how to add some", /NO GAMES IN THIS COPY YET/.test(text()) && /add-games\.js/.test(text()) && /LOOK AGAIN/.test(text()) && !/ENTER GAME MODE/.test(text()));
    def.unmount();
  }

  section("the shelf: games kept on a device");
  {
    const shelfTool = require("../tools/shelf");
    const packer2 = require("../tools/make-games-pack");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "fk-shelf-"));
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
    put("index.html", "<!doctype html><title>hub</title>");
    put("engine/outlaw-core.js", "var Outlaw={version:\"3.2.0\"};");
    put("engine/outlaw-assist.js", "window.ASSIST=1; var s='</script>';");
    put("engine/runtime.html", "<!doctype html><html><head><meta charset=\"utf-8\"><script src=\"outlaw-core.js\"></script></head><body><script>var RT=window.OUTLAW_RUNTIME</script></body></html>");
    put("modules/platformer.js", "window.PLAT=1;");
    put("games/native/hop.js", "window.HOP=1;");
    put("vendor/fonts/f.css", "@font-face{font-family:x;src:url(f.woff2) format('woff2')}");
    put("vendor/fonts/f.woff2", "FONTDATA");
    put("games/one.html", "<!doctype html><html><head><meta charset=\"utf-8\"><link rel=\"manifest\" href=\"manifest.webmanifest\"><link rel=\"stylesheet\" href=\"../vendor/fonts/f.css\"><script src=\"../engine/outlaw-assist.js\"></script><script src=\"https://example.com/x.js\"></script></head><body><img src=\"../vendor/fonts/f.woff2\"></body></html>");
    put("engine/outlaw-catalog.js", "window.OUTLAW_CATALOG = " + JSON.stringify({
      sections: [{ group: "GAMES", label: "ARCADE", ids: ["one", "hop", "../evil"] }, { group: "LEGACY", label: "OLD", ids: ["old"] }],
      entries: [{ id: "one", title: "One", launch: "games/one.html" }, { id: "hop", title: "Hop", launch: "engine/runtime.html?game=hop&modules=platformer" },
        { id: "../evil", title: "x", launch: "games/one.html" }, { id: "old", title: "Old", launch: "games/one.html" }]
    }) + ";");
    const r = shelfTool.build(d);
    const one = fs.readFileSync(path.join(d, "shelf/one.html"), "utf8"), hop = fs.readFileSync(path.join(d, "shelf/hop.html"), "utf8");
    const list = JSON.parse(fs.readFileSync(path.join(d, "shelf/shelf.json"), "utf8"));
    ok("every game becomes one file: its scripts, sheets, fonts and pictures inside it", /window\.ASSIST=1/.test(one) && /data:font\/woff2;base64,/.test(one) && !/f\.css/.test(one) && /<img src="data:/.test(one));
    ok("a script's text can never end its tag early", /'<\\\/script>'/.test(one));
    ok("what is on another site, and a phone-install manifest, are not carried", /https:\/\/example\.com\/x\.js/.test(one) && !/manifest/.test(one));
    ok("a native game carries its runtime, module and game", /window\.OUTLAW_RUNTIME = /.test(hop) && /PLAT=1/.test(hop) && /HOP=1/.test(hop) && /game=hop&modules=platformer/.test(hop) && /Outlaw=\{version/.test(hop));
    ok("only games and apps, only plain ids", list.v === 1 && list.games.map((g) => g.id).join() === "one,hop" && r.shelf.games.length === 2);
    const crypto = require("crypto");
    ok("each says its size and a short sha256", list.games.every((g) => { const b = fs.readFileSync(path.join(d, "shelf", g.file)); return g.size === b.length && g.sha === crypto.createHash("sha256").update(b).digest("hex").slice(0, 16); }));

    const gm = FieldKit.need("gameMode");
    const z = packer2.zip([{ name: "outlaw-engine/shelf/shelf.json", data: fs.readFileSync(path.join(d, "shelf/shelf.json")) },
      { name: "outlaw-engine/shelf/one.html", data: fs.readFileSync(path.join(d, "shelf/one.html")) }, { name: "outlaw-engine/x.bin", data: Buffer.from([1, 2, 3]) }]);
    const zr = gm._readZip(z.buffer.slice(z.byteOffset, z.byteOffset + z.length));
    const back = Buffer.from(await zr.get("outlaw-engine/shelf/one.html")).toString("utf8");
    ok("a games pack is read in the page, without unzipping it by hand", zr.names.length === 3 && back === one && Buffer.from(await zr.get("outlaw-engine/x.bin")).equals(Buffer.from([1, 2, 3])));
    let notZip = null; try { gm._readZip(new Uint8Array(64).buffer); } catch (e) { notZip = e; }
    ok("and a file that is not a zip is refused", notZip && /not a zip/.test(notZip.message));
    const clean = gm._cleanList({ v: 1, games: [list.games[0], { id: "../x", sha: "0123456789abcdef", file: "../x.html" }, { id: "y", sha: "zz", file: "y.html" }, { id: "w", sha: "0123456789abcdef", file: "other.html" }] });
    ok("a list from a relay or a pack is checked: plain ids, a real sha, its own file", clean.length === 1 && clean[0].id === "one");

    /* the stand-in storage, run the way a sandboxed game runs it */
    const vm = require("vm"), posted = [];
    const win = { parent: { postMessage: (m) => posted.push(m) } };
    const docL = {};
    const sbx = { window: win, navigator: {}, document: { addEventListener: (t, f) => { docL[t] = f; } }, DOMException: class extends Error { constructor(m, n) { super(m); this.name = n; } }, Proxy, Object, String, JSON, Promise };
    vm.createContext(sbx);
    vm.runInContext("(" + gm._shelfShim.toString() + ")(" + JSON.stringify({ "metro_fall_save": "{\"day\":3}", other: "1" }) + ")", sbx);
    const ls = win.localStorage;
    ok("a shelf game finds its saves where it left them", ls.getItem("metro_fall_save") === "{\"day\":3}" && ls.length === 2 && ls.other === "1");
    ls.setItem("k", 5); ls.z = "2"; delete ls.other;
    ok("and every change goes back to FieldKit to be kept", posted.map((m) => m.op + ":" + m.k).join() === "set:k,set:z,del:other" && posted.every((m) => m.fkShelf === 1) && ls.getItem("k") === "5" && ls.key(0) === "metro_fall_save");
    let quota = null; try { ls.setItem("big", "x".repeat(33 * 1048576)); } catch (e) { quota = e; }
    ok("a full store says so the way a browser does", quota && quota.name === "QuotaExceededError");
    win.sessionStorage.setItem("s", "1");
    ok("sessionStorage works and is not kept", win.sessionStorage.getItem("s") === "1" && !posted.some((m) => m.k === "s"));
    win.FK_SHELF.open("metro-fall-2.html");
    ok("a game can ask for another one by name", posted[posted.length - 1].op === "open" && posted[posted.length - 1].id === "metro-fall-2");
    ok("a service worker is politely absent", sbx.navigator.serviceWorker && sbx.navigator.serviceWorker.controller === null);
    const page = gm._shelfPage("<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head><body></body></html>", { a: "</script><b>" });
    ok("the stand-in goes first in the page, and saves cannot break out of it", /<head><script>\(function shelfShim/.test(page) && !/<\/script><b>/.test(page) && page.indexOf("<meta charset") > page.indexOf("shelfShim"));
    ok("a shelf game runs sandboxed: scripts yes, FieldKit's origin no", /allow-scripts/.test(gm.SANDBOX) && !/allow-same-origin/.test(gm.SANDBOX) && !/allow-top-navigation/.test(gm.SANDBOX));

    /* the relay lets FieldKit read the shelf, and only the shelf */
    const gd = fs.mkdtempSync(path.join(os.tmpdir(), "fk-shg-"));
    sync.sync(src, path.join(gd, "outlaw-engine"));
    ok("a copy carries its shelf, and the games folder says what is in it", fs.existsSync(path.join(gd, "outlaw-engine/shelf/shelf.json")) && /FK_GAMES_INDEX = \["outlaw-engine"\]/.test(fs.readFileSync(path.join(gd, "fieldkit-index.js"), "utf8")));
    fs.mkdirSync(path.join(gd, "outlaw-engine/shelf"), { recursive: true });
    fs.copyFileSync(path.join(d, "shelf/one.html"), path.join(gd, "outlaw-engine/shelf/one.html"));
    games.init({ dataDir: data, dir: gd, now: () => Date.now() });
    const t2 = await call("POST", "/games/ticket", { name: "ava" });
    const b2 = t2.b.path.replace("index.html", "");
    const sf = await get(b2 + "shelf/one.html"), idx = await get(t2.b.path);
    ok("shelf files may be read by FieldKit from a file (CORS), with the ticket", sf.status === 200 && sf.headers["Access-Control-Allow-Origin"] === "*" && sf.body === one);
    ok("the rest of the library is not", idx.status === 200 && !idx.headers["Access-Control-Allow-Origin"]);
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
