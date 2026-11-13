#!/usr/bin/env node
/* ============================================================
   FieldKit :: sync-games — bring the Outlaw Engine into FieldKit

     node tools/sync-games.js                 from the remembered folder
     node tools/sync-games.js "<folder>"      from this one (and remember it)

   GAME MODE (modules/game-mode.js) runs the Outlaw Engine: the user's own
   hub of games and apps, built and kept in its own folder (given once, then
   remembered in the gitignored games.local.json). That folder is the
   source; this copies what the engine needs to RUN into games/outlaw-engine/
   here, byte for byte. Nothing in a game is changed: the engine keeps its
   own look, its own diagnostics and its own build (tools/build.py there).

   Copied:     index.html, LICENSE.md, README.md, engine/, games/, apps/,
               workshop/, legacy/, modules/, vendor/
   Left there: src/, tools/, handoff/, the plans and logs, screenshots.

   games/ is gitignored and never published: the games are the user's
   (All rights reserved, Outlaw Systems). It does go onto a drive
   (build.js --deploy) and into the relay image (tools/make-deploy.js), so
   GAME MODE works from a drive and, for signed-in people, through the relay.

   A small games/outlaw-engine/fieldkit-games.js is written last. FieldKit
   loads it with a <script> tag, which works from file:// where fetch does
   not, to learn that a copy is there and what is in it.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DEST = path.join(ROOT, "games", "outlaw-engine");
const REMEMBER = path.join(ROOT, "games.local.json");
const TAKE = ["index.html", "LICENSE.md", "README.md", "engine", "games", "apps", "workshop", "legacy", "modules", "vendor"];
const NEED = ["index.html", "engine/outlaw-core.js", "engine/outlaw-catalog.js"];
const SKIP = /(^|[\\/])(__pycache__|\.git|node_modules)([\\/]|$)|\.(pyc|log)$/;

function sourceDir(argv) {
  if (argv[2]) return path.resolve(argv[2]);
  try { const j = JSON.parse(fs.readFileSync(REMEMBER, "utf8")); if (j && j.source) return j.source; } catch (e) { /* none yet */ }
  throw new Error("say where the Outlaw Engine folder is the first time: node tools/sync-games.js \"<folder>\"");
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

/* What the catalog says is in the library, for the panel to show: each
   section's name and its titles. The catalog is window.OUTLAW_CATALOG = {JSON}. */
function catalogSummary(src) {
  try {
    const t = fs.readFileSync(path.join(src, "engine", "outlaw-catalog.js"), "utf8");
    const i = t.indexOf("window.OUTLAW_CATALOG =");
    if (i < 0) return null;
    const j = JSON.parse(t.slice(i + 23).trim().replace(/;s*$/, ""));
    const title = {};
    for (const e of j.entries || []) title[e.id] = e.title;
    const count = {};
    const sections = (j.sections || []).map((x) => {
      count[x.group] = (count[x.group] || 0) + (x.ids || []).length;
      return { group: x.group, label: x.label, titles: (x.ids || []).map((id) => title[id] || id) };
    });
    return { games: count.GAMES || 0, apps: count.APPS || 0, workshop: count.WORKSHOP || 0, legacy: count.LEGACY || 0, sections: sections };
  } catch (e) { return null; }
}
function engineVersion(src) {
  try {
    const t = fs.readFileSync(path.join(src, "engine", "outlaw-core.js"), "utf8");
    const m = /version\s*:\s*["'](\d+\.\d+(?:\.\d+)?)["']/.exec(t) || /v(\d+\.\d+\.\d+)/.exec(t);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function sync(src, dest, opts) {
  opts = opts || {};
  for (const f of NEED) if (!fs.existsSync(path.join(src, f))) throw new Error("not an Outlaw Engine folder (no " + f + "): " + src);
  const files = [];
  for (const t of TAKE) {
    const abs = path.join(src, t);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, t, files); else files.push({ rel: t, abs: abs, size: st.size });
  }
  /* a clean copy: what was removed there is removed here */
  fs.rmSync(dest + ".incoming", { recursive: true, force: true });
  const stage = dest + ".incoming";
  let bytes = 0;
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const to = path.join(stage, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.abs, to);
    bytes += f.size;
    h.update(f.rel + "\0" + f.size + "\0");
  }
  const info = {
    engine: "Outlaw Engine", version: engineVersion(src), at: new Date(opts.now || Date.now()).toISOString(),
    files: files.length, bytes: bytes, fingerprint: h.digest("hex").slice(0, 16), library: catalogSummary(src)
  };
  /* every game also as one file, for GAME MODE's shelf (tools/shelf.js): it rides along to drives, the relay and the pack */
  try {
    const sh = require("./shelf").build(stage, null, { version: info.version });
    info.shelf = { games: sh.shelf.games.length, bytes: sh.bytes };
    if (sh.warn.length && !opts.quiet) sh.warn.forEach((w) => console.log("  shelf ! " + w));
  } catch (e) { info.shelf = null; if (!opts.quiet) console.log("  shelf: not made (" + e.message + ")"); }
  /* JSON inside a script tag: < is escaped so nothing in a path can close it */
  fs.writeFileSync(path.join(stage, "fieldkit-games.js"),
    "/* Written by FieldKit's tools/sync-games.js. Tells GAME MODE this copy is here. */\n" +
    "window.FK_GAMES = " + JSON.stringify(info).replace(/</g, "\\u003c") + ";\n");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(stage, dest);
  writeIndex(path.dirname(dest));
  return info;
}

/* games/fieldkit-index.js: which libraries this games folder holds. GAME MODE reads this one file
   first, so it never asks for a folder that is not there (each miss was a red error in the console). */
function writeIndex(gamesDir) {
  const libs = ["library", "outlaw-engine"].filter((l) => fs.existsSync(path.join(gamesDir, l, "fieldkit-games.js")));
  try {
    fs.writeFileSync(path.join(gamesDir, "fieldkit-index.js"),
      "/* Written by FieldKit's tools (sync-games.js, add-games.js). Which libraries are in this games folder. */\n" +
      "window.FK_GAMES_INDEX = " + JSON.stringify(libs) + ";\n");
  } catch (e) { /* GAME MODE then looks for the engine by itself */ }
  return libs;
}

if (require.main === module) {
  try {
    const src = sourceDir(process.argv);
    const info = sync(src, DEST);
    /* the same file also remembers your own library and the GAME MODE choice (add-games.js, setup.js) */
    let mem = {};
    try { mem = JSON.parse(fs.readFileSync(REMEMBER, "utf8")) || {}; } catch (e) { /* first time */ }
    fs.writeFileSync(REMEMBER, JSON.stringify(Object.assign(mem, { source: src }), null, 2) + "\n");
    console.log("GAME MODE: copied the Outlaw Engine " + (info.version ? "v" + info.version + " " : "") + "(" + info.files + " files, " + (info.bytes / 1048576).toFixed(1) + " MB)");
    console.log("  from " + src);
    console.log("  to   games/outlaw-engine/  (gitignored; goes on drives and into the relay image)");
    if (info.library) console.log("  library: " + info.library.games + " games, " + info.library.apps + " apps, " + info.library.workshop + " workshop, " + info.library.legacy + " legacy");
    if (info.shelf) console.log("  shelf:   " + info.shelf.games + " games and apps as one file each (" + (info.shelf.bytes / 1048576).toFixed(1) + " MB), for GAME MODE to keep on a device");
  } catch (e) {
    console.error("GAME MODE: " + e.message);
    process.exit(1);
  }
}

module.exports = { sync, writeIndex, TAKE, DEST };
