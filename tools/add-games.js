#!/usr/bin/env node
/* ============================================================
   FieldKit :: add-games — your own games in GAME MODE

     node tools/add-games.js "<a folder of games>"            add them (and remember the folder)
     node tools/add-games.js "<folder>" --name "Kay's Arcade"  and name the library
     node tools/add-games.js                                  again, from the remembered folder
     node tools/add-games.js --remove                         take the library out

   GAME MODE (modules/game-mode.js) opens a library of games. This makes
   one from any folder of HTML games, with nothing to install:

     my-games/
       slope.html            one game in one file
       tetris/index.html     a game in a folder of its own (the whole folder is taken)
       shared/…              anything else is copied too, so games can share files
       games.json            optional: names and groups (below)

   It is copied, as it is, into games/library/ here, with a page that
   lists the games (search, groups, a bar to come back from a game) unless
   the folder has an index.html of its own, which is then used instead.
   From there it goes wherever GAME MODE's games go: onto a drive
   (node build.js --deploy) and beside the relay (node tools/make-deploy.js,
   or nothing at all when the relay runs from this folder).

   games.json, all of it optional:
     { "name": "Kay's Arcade",
       "titles":   { "slope": "Slope!" },
       "about":    { "slope": "Roll, steer, do not fall." },
       "sections": [ { "label": "ARCADE", "items": ["slope", "tetris"] },
                     { "label": "TOOLS", "group": "APPS", "items": ["notes"] } ] }
   A game is named by its file or folder name without ".html". Games no
   section names go under GAMES. Without the file, a game's name is its
   page's <title>, or its file name.

   games/ is gitignored and never published: what you put here is yours.
   If games/outlaw-engine/ is there as well, the library's page links to it.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DEST = path.join(ROOT, "games", "library");
const REMEMBER = path.join(ROOT, "games.local.json");
const SKIP = /(^|[\\/])(\.[^\\/]*|node_modules|__pycache__|Thumbs\.db)([\\/]|$)/;
const MAX_GAMES = 2000;

function remembered() { try { return JSON.parse(fs.readFileSync(REMEMBER, "utf8")) || {}; } catch (e) { return {}; } }
function remember(patch) {
  const j = Object.assign(remembered(), patch);
  for (const k of Object.keys(j)) if (j[k] === undefined) delete j[k];
  fs.writeFileSync(REMEMBER, JSON.stringify(j, null, 2) + "\n");
}

function walk(dir, rel, out) {
  for (const n of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, n), r = rel ? rel + "/" + n : n;
    if (SKIP.test(r)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, r, out);
    else if (st.isFile()) out.push({ rel: r, abs: abs, size: st.size });
  }
  return out;
}

const pretty = (id) => id.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b[a-z]/g, (c) => c.toUpperCase()) || id;
function pageTitle(file) {
  try {
    const fd = fs.openSync(file, "r"), buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
    const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(buf.slice(0, n).toString("utf8"));
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  } catch (e) { return ""; }
}

/* The games in a folder: every top-level x.html, and every top-level folder with an index.html. */
function findGames(src) {
  const out = [];
  for (const n of fs.readdirSync(src).sort()) {
    if (SKIP.test(n)) continue;
    const abs = path.join(src, n), st = fs.statSync(abs);
    if (st.isFile() && /\.html?$/i.test(n) && !/^index\.html?$/i.test(n)) out.push({ id: n.replace(/\.html?$/i, ""), href: n, file: abs });
    else if (st.isDirectory() && fs.existsSync(path.join(abs, "index.html"))) out.push({ id: n, href: n + "/index.html", file: path.join(abs, "index.html") });
  }
  return out.slice(0, MAX_GAMES);
}

function readMeta(src) {
  const f = path.join(src, "games.json");
  if (!fs.existsSync(f)) return {};
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return j && typeof j === "object" ? j : {}; }
  catch (e) { throw new Error("games.json in that folder is not valid JSON: " + e.message); }
}

/* -> { name, entries: [{id, href, title, about}], sections: [{group, label, ids}] } */
function catalogue(src, opts) {
  const meta = readMeta(src), games = findGames(src);
  const titles = meta.titles || {}, about = meta.about || {};
  const entries = games.map((g) => ({
    id: g.id, href: g.href.split(path.sep).join("/"),
    title: String(titles[g.id] || pageTitle(g.file) || pretty(g.id)).slice(0, 80),
    about: String(about[g.id] || "").slice(0, 200)
  }));
  const known = new Set(entries.map((e) => e.id)), placed = new Set(), sections = [];
  for (const s of Array.isArray(meta.sections) ? meta.sections : []) {
    const ids = (Array.isArray(s.items) ? s.items : []).map(String).filter((id) => known.has(id) && !placed.has(id));
    ids.forEach((id) => placed.add(id));
    if (ids.length) sections.push({ group: String(s.group || "GAMES").toUpperCase() === "APPS" ? "APPS" : "GAMES", label: String(s.label || "GAMES").slice(0, 40), ids: ids });
  }
  const rest = entries.map((e) => e.id).filter((id) => !placed.has(id));
  if (rest.length) sections.push({ group: "GAMES", label: sections.some((s) => s.group === "GAMES") ? "MORE GAMES" : "GAMES", ids: rest });
  return { name: String((opts && opts.name) || meta.name || "My Games").slice(0, 40), entries: entries, sections: sections };
}

/* The library's own page. One file, nothing fetched, works from file://.
   The list is data in a script tag and every word is put on the page as
   text, so nothing in a game's name can become markup. */
function hubPage(cat) {
  const data = JSON.stringify(cat).replace(/</g, "\\u003c");
  return [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"referrer\" content=\"no-referrer\">",
    "<title>Library</title>",
    "<style>",
    "*{box-sizing:border-box}html,body{height:100%;margin:0}",
    "body{background:#0b0f14;color:#d7e3ee;font:15px/1.4 system-ui,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column}",
    "header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid #1d2a38;background:#0e141b}",
    "h1{font-size:18px;letter-spacing:.14em;margin:0;flex:1;min-width:140px;text-transform:uppercase}",
    "input{font:inherit;background:#0b0f14;color:inherit;border:1px solid #2a3b4e;border-radius:8px;padding:9px 12px;min-width:0;width:240px;max-width:100%}",
    "main{flex:1;overflow:auto;padding:14px 16px 28px}",
    "h2{font-size:11px;letter-spacing:.2em;color:#7f97ad;margin:18px 0 8px}",
    ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}",
    ".card{display:block;text-align:left;font:inherit;color:inherit;background:#111a24;border:1px solid #1f2e3f;border-radius:10px;padding:14px;cursor:pointer;min-height:76px}",
    ".card:hover,.card:focus{border-color:#5cc8ff;outline:none;background:#152232}",
    ".card b{display:block;font-size:15px}.card span{display:block;color:#8aa0b5;font-size:12px;margin-top:4px}",
    ".card.wide{border-color:#2d5a3a;background:#0f1d15}",
    ".none{color:#8aa0b5;padding:20px 0}",
    "#play{display:none;flex-direction:column;position:fixed;inset:0;background:#000}",
    "#play.on{display:flex}#bar{display:flex;gap:8px;align-items:center;height:36px;padding:0 8px;background:#0e141b;border-bottom:1px solid #1d2a38;flex:none}",
    "#bar button{font:inherit;font-size:13px;background:#111a24;color:inherit;border:1px solid #2a3b4e;border-radius:6px;padding:4px 12px;cursor:pointer}",
    "#bar b{flex:1;font-size:13px;letter-spacing:.08em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#frame{flex:1;width:100%;border:0;background:#000}",
    "@media (pointer:coarse){.card{min-height:88px}#bar{height:44px}#bar button{padding:8px 14px}}",
    "</style></head><body>",
    "<header><h1 id=\"name\"></h1><input id=\"q\" type=\"search\" placeholder=\"Search\" aria-label=\"Search the library\"></header>",
    "<main id=\"list\"></main>",
    "<div id=\"play\"><div id=\"bar\"><button id=\"back\" type=\"button\">&#9666; LIBRARY</button><b id=\"now\"></b><button id=\"full\" type=\"button\">FULL SCREEN</button></div>",
    "<iframe id=\"frame\" title=\"game\" allow=\"fullscreen; autoplay; gamepad; clipboard-write\" referrerpolicy=\"no-referrer\"></iframe></div>",
    "<script>var LIBRARY = " + data + ";</script>",
    "<script>",
    "(function () {",
    "  var L = LIBRARY, byId = {}, list = document.getElementById('list'), q = document.getElementById('q');",
    "  var play = document.getElementById('play'), frame = document.getElementById('frame'), now = document.getElementById('now');",
    "  L.entries.forEach(function (e) { byId[e.id] = e; });",
    "  document.getElementById('name').textContent = L.name; document.title = L.name;",
    "  var other = null;   /* the Outlaw Engine, when it sits beside this library */",
    "  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }",
    "  function open(title, href) { now.textContent = title; frame.src = href; play.className = 'on'; try { history.replaceState(null, '', '#' + encodeURIComponent(href)); } catch (e) {} setTimeout(function () { try { frame.focus(); } catch (e) {} }, 60); }",
    "  function close() { play.className = ''; frame.src = 'about:blank'; try { history.replaceState(null, '', '#'); } catch (e) {} q.focus(); }",
    "  function card(title, sub, href, wide) { var b = el('button', 'card' + (wide ? ' wide' : '')); b.type = 'button'; b.appendChild(el('b', null, title)); if (sub) b.appendChild(el('span', null, sub)); b.onclick = function () { open(title, href); }; return b; }",
    "  function paint() {",
    "    var want = q.value.trim().toLowerCase(), any = false;",
    "    while (list.firstChild) list.removeChild(list.firstChild);",
    "    L.sections.forEach(function (s) {",
    "      var ids = s.ids.filter(function (id) { var e = byId[id]; return e && (!want || (e.title + ' ' + e.about + ' ' + e.id).toLowerCase().indexOf(want) >= 0); });",
    "      if (!ids.length) return; any = true;",
    "      list.appendChild(el('h2', null, s.label + '  \\u00b7  ' + ids.length));",
    "      var g = el('div', 'grid'); ids.forEach(function (id) { var e = byId[id]; g.appendChild(card(e.title, e.about, e.href)); }); list.appendChild(g);",
    "    });",
    "    if (other && (!want || 'outlaw engine'.indexOf(want) >= 0)) {",
    "      any = true; list.appendChild(el('h2', null, 'ALSO HERE'));",
    "      var g2 = el('div', 'grid'); g2.appendChild(card('Outlaw Engine', other, '../outlaw-engine/index.html', true)); list.appendChild(g2);",
    "    }",
    "    if (!any) list.appendChild(el('div', 'none', L.entries.length ? 'Nothing matches that.' : 'This library is empty. Add games to its folder and run node tools/add-games.js again.'));",
    "  }",
    "  q.oninput = paint;",
    "  document.getElementById('back').onclick = close;",
    "  document.getElementById('full').onclick = function () { try { if (document.fullscreenElement) document.exitFullscreen(); else play.requestFullscreen(); } catch (e) {} };",
    "  paint();",
    "  /* Is the Outlaw Engine beside this library? Its marker is a script, which loads from file:// too. */",
    "  var s = document.createElement('script');",
    "  s.onload = function () { var g = window.FK_GAMES; if (g && g.library) { other = g.library.games + ' games, ' + g.library.apps + ' apps'; paint(); } };",
    "  s.onerror = function () {};",
    "  s.src = '../outlaw-engine/fieldkit-games.js'; document.head.appendChild(s);",
    "})();",
    "</script></body></html>",
    ""
  ].join("\n");
}

/* Copy `src` into `dest` as a library. Returns what GAME MODE is told. */
function add(src, dest, opts) {
  opts = opts || {};
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error("not a folder: " + src);
  const inside = path.relative(path.resolve(src), path.resolve(dest));
  if (!inside || (!inside.startsWith("..") && !path.isAbsolute(inside))) throw new Error("that folder holds games/library itself; give the folder your games are kept in");
  const cat = catalogue(src, opts);
  const ownIndex = fs.existsSync(path.join(src, "index.html"));
  if (!cat.entries.length && !ownIndex) throw new Error("no games found in " + src + "\n  A game is a .html file, or a folder with an index.html in it, directly inside that folder.");
  const files = walk(src, "", []).filter((f) => f.rel !== "games.json" && f.rel !== "fieldkit-games.js");
  const stage = dest + ".incoming";
  fs.rmSync(stage, { recursive: true, force: true });
  let bytes = 0;
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const to = path.join(stage, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.abs, to);
    bytes += f.size;
    h.update(f.rel + "\0" + f.size + "\0");
  }
  fs.mkdirSync(stage, { recursive: true });
  if (!ownIndex) fs.writeFileSync(path.join(stage, "index.html"), hubPage(cat));
  const title = {};
  cat.entries.forEach((e) => { title[e.id] = e.title; });
  const count = (g) => cat.sections.filter((s) => s.group === g).reduce((n, s) => n + s.ids.length, 0);
  const info = {
    engine: cat.name, own: true, version: null, at: new Date(opts.now || Date.now()).toISOString(),
    files: files.length + (ownIndex ? 0 : 1), bytes: bytes, fingerprint: h.digest("hex").slice(0, 16),
    library: { games: count("GAMES"), apps: count("APPS"), workshop: 0, legacy: 0,
      sections: cat.sections.map((s) => ({ group: s.group, label: s.label, titles: s.ids.map((id) => title[id]) })) }
  };
  fs.writeFileSync(path.join(stage, "fieldkit-games.js"),
    "/* Written by FieldKit's tools/add-games.js. Tells GAME MODE this library is here. */\n" +
    "window.FK_GAMES = " + JSON.stringify(info).replace(/</g, "\\u003c") + ";\n");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(stage, dest);
  return Object.assign({ ownIndex: ownIndex }, info);
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    if (argv.indexOf("--remove") >= 0) {
      fs.rmSync(DEST, { recursive: true, force: true });
      remember({ library: undefined, libraryName: undefined });
      console.log("GAME MODE: your library was taken out (games/library/ removed). Build the drive or the relay again.");
      process.exit(0);
    }
    const ni = argv.indexOf("--name");
    const name = ni >= 0 ? argv[ni + 1] : undefined;
    const given = argv.filter((a, i) => a.slice(0, 2) !== "--" && (ni < 0 || i !== ni + 1))[0];
    const mem = remembered();
    const src = given ? path.resolve(given) : mem.library;
    if (!src) throw new Error("say where your games are the first time: node tools/add-games.js \"<folder>\"");
    const info = add(src, DEST, { name: name || mem.libraryName });
    remember({ library: src, libraryName: name || mem.libraryName });
    console.log("GAME MODE: \"" + info.engine + "\" is in  (" + info.library.games + " game(s), " + info.library.apps + " app(s), " + info.files + " files, " + (info.bytes / 1048576).toFixed(1) + " MB)");
    console.log("  from " + src);
    console.log("  to   games/library/  (gitignored: never published)");
    console.log(info.ownIndex ? "  that folder has its own index.html, so that is the library's page" : "  a page listing them was written (games/library/index.html)");
    if (mem.gameMode === "off") console.log("  NOTE: this copy is set to build WITHOUT GAME MODE. Turn it on: node tools/setup.js --game-mode on");
    console.log("");
    console.log("Next:  node build.js --deploy <drive>   for a drive");
    console.log("       node tools/make-deploy.js        for a relay in Docker or Pterodactyl");
    console.log("       (a relay started from this folder only needs a restart)");
  } catch (e) {
    console.error("GAME MODE: " + e.message);
    process.exit(1);
  }
}

module.exports = { add, catalogue, findGames, hubPage, DEST };
