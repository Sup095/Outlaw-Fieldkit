#!/usr/bin/env node
/* ============================================================
   FieldKit :: shelf — every game as one file, for GAME MODE's shelf

     node tools/shelf.js                 games/outlaw-engine -> games/outlaw-engine/shelf/
     node tools/shelf.js <engine folder> <out folder>

   GAME MODE can keep games ON A DEVICE (modules/game-mode.js, "the
   shelf"): someone ticks the games they want, they are saved inside the
   browser, and they play from there with no drive and no relay, through
   FieldKit updates. A game on a shelf has no folder around it, so each
   one is made into a single page here: its scripts, stylesheets, fonts
   and pictures are put inside it. Nothing in the game itself is changed.

   Written: shelf/<id>.html for every game and app in the library's
   catalog (engine/outlaw-catalog.js; not WORKSHOP or LEGACY), and
   shelf/shelf.json, the list GAME MODE reads: id, title, what it is,
   its size and a short sha256, so a copy on a shelf knows when there is
   a newer one.

   tools/sync-games.js runs this after every copy, so the relay image, a
   drive and the games pack all carry the shelf beside the engine.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIME = {
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".json": "application/json"
};
const GROUPS = { GAMES: 1, APPS: 1 };

/* a relative address of a file in this library, or null for anything else */
function local(ref) {
  const r = String(ref || "").trim();
  if (!r || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|%23|\/)/i.test(r)) return null;
  return r.split(/[?#]/)[0];
}
function within(root, abs) { const R = path.resolve(root); return abs === R || abs.indexOf(R + path.sep) === 0; }
function read(root, fromDir, ref) {
  const r = local(ref);
  if (r == null) return null;
  let rel; try { rel = decodeURIComponent(r); } catch (e) { return null; }
  const abs = path.resolve(root, fromDir, rel);
  if (!within(root, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return { abs: abs, dir: path.relative(root, path.dirname(abs)), buf: fs.readFileSync(abs) };
}
function dataUri(f) {
  return "data:" + (MIME[path.extname(f.abs).toLowerCase()] || "application/octet-stream") + ";base64," + f.buf.toString("base64");
}

/* JavaScript put inside a <script>: nothing in it may end the tag early */
function scriptSafe(js) { return String(js).replace(/<\/(script)/gi, "<\\/$1"); }

/* url(...) in a stylesheet -> the file itself, read relative to the sheet */
function inlineCss(css, root, dir, miss) {
  return String(css).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, function (all, q, ref) {
    if (local(ref) == null) return all;
    const f = read(root, dir, ref);
    if (!f) { miss.push(ref); return all; }
    return "url(\"" + dataUri(f) + "\")";
  }).replace(/@import\s+(["'])([^"']+)\1\s*;/g, function (all, q, ref) {
    const f = read(root, dir, ref);
    if (!f) return all;
    return inlineCss(f.buf.toString("utf8"), root, f.dir, miss);
  });
}

/* One page with everything it loads put inside it.
   rel: the page in the library (games/x.html). extra: { query, files } for the engine's runtime page. */
function bundle(root, rel, extra) {
  const dir = path.dirname(rel), miss = [];
  let html = fs.readFileSync(path.join(root, rel), "utf8");
  html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi, function (all, a, q, ref, b) {
    if (local(ref) == null) return all;
    const f = read(root, dir, ref);
    if (!f) { miss.push(ref); return all; }
    const attrs = (a + " " + b).replace(/\b(?:defer|async|crossorigin(?:\s*=\s*(["'])[^"']*\1)?|integrity\s*=\s*(["'])[^"']*\2)/gi, "").replace(/\s+/g, " ").trim();
    return "<script" + (attrs ? " " + attrs : "") + ">" + scriptSafe(f.buf.toString("utf8")) + "\n</script>";
  });
  html = html.replace(/<link\b[^>]*>/gi, function (tag) {
    const relm = /\brel\s*=\s*(["']?)([^"'\s>]+)\1/i.exec(tag), href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag);
    const kind = relm ? relm[2].toLowerCase() : "";
    if (!href || local(href[2]) == null) return tag;
    /* the phone-install files (manifest, home-screen icons) belong to a game's own folder, not to a shelf */
    if (kind === "manifest" || kind === "apple-touch-icon" || kind === "icon" || kind === "shortcut") return kind === "icon" ? "<link rel=\"icon\" href=\"data:,\">" : "";
    if (kind !== "stylesheet") return tag;
    const f = read(root, dir, href[2]);
    if (!f) { miss.push(href[2]); return tag; }
    return "<style>" + inlineCss(f.buf.toString("utf8"), root, f.dir, miss).replace(/<\/(style)/gi, "<\\/$1") + "</style>";
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, function (all, a, css) {
    return /url\(/.test(css) ? "<style" + a + ">" + inlineCss(css, root, dir, miss) + "</style>" : all;
  });
  html = html.replace(/<img\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2/gi, function (all, a, q, ref) {
    const f = local(ref) == null ? null : read(root, dir, ref);
    return f ? "<img" + a + "src=\"" + dataUri(f) + "\"" : all;
  });
  if (extra) {
    const boot = "<script>window.OUTLAW_RUNTIME = " + JSON.stringify(extra).replace(/</g, "\\u003c") + ";</script>";
    const at = html.search(/<script\b/i);
    html = at >= 0 ? html.slice(0, at) + boot + "\n" + html.slice(at) : boot + html;
  }
  return { html: html, miss: miss };
}

function catalog(root) {
  const t = fs.readFileSync(path.join(root, "engine", "outlaw-catalog.js"), "utf8");
  const i = t.indexOf("window.OUTLAW_CATALOG =");
  if (i < 0) throw new Error("no catalog in engine/outlaw-catalog.js");
  return JSON.parse(t.slice(i + 23).trim().replace(/;\s*$/, ""));
}

/* The engine's runtime page, with the native game and its modules carried inside */
function nativeBundle(root, launch) {
  const q = launch.slice(launch.indexOf("?"));
  const p = new URLSearchParams(q), files = {};
  for (const m of (p.get("modules") || "").split(",").filter(Boolean)) {
    const f = path.join(root, "modules", m.toLowerCase() + ".js");
    if (fs.existsSync(f)) files["../modules/" + m.toLowerCase() + ".js"] = fs.readFileSync(f, "utf8");
  }
  const g = p.get("game"), gf = path.join(root, "games", "native", g + ".js");
  if (g && fs.existsSync(gf)) files["../games/native/" + g + ".js"] = fs.readFileSync(gf, "utf8");
  return bundle(root, "engine/runtime.html", { query: q, files: files });
}

/* root: an Outlaw Engine folder, or an own library with opts.catalog (tools/add-games.js).
   out: where shelf/ goes (default root/shelf). */
function build(root, out, opts) {
  opts = opts || {};
  out = out || path.join(root, "shelf");
  const cat = opts.catalog || catalog(root), byId = {};
  for (const e of cat.entries || []) byId[e.id] = e;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const list = [], warn = [];
  for (const s of cat.sections || []) {
    if (!GROUPS[s.group]) continue;
    for (const id of s.ids || []) {
      const e = byId[id];
      if (!e || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(id)) continue;
      const launch = String(e.launch || e.path || e.href || "");
      let b;
      try {
        if (/^engine\/runtime\.html\?/.test(launch)) b = nativeBundle(root, launch);
        else if (/\.html$/.test(launch) && fs.existsSync(path.join(root, launch))) b = bundle(root, launch);
        else continue;
      } catch (err) { warn.push(id + ": " + err.message); continue; }
      if (b.miss.length) warn.push(id + ": left as it was: " + b.miss.join(", "));
      const buf = Buffer.from(b.html, "utf8");
      fs.writeFileSync(path.join(out, id + ".html"), buf);
      list.push({
        id: id, title: String(e.title || id), desc: String(e.desc || e.about || ""), group: s.group, section: s.label,
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [], file: id + ".html", size: buf.length,
        sha: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)
      });
    }
  }
  const shelf = { v: 1, name: opts.name || "Outlaw Engine", version: opts.version || null, games: list };
  fs.writeFileSync(path.join(out, "shelf.json"), JSON.stringify(shelf, null, 1) + "\n");
  return { shelf: shelf, warn: warn, bytes: list.reduce((n, g) => n + g.size, 0) };
}

if (require.main === module) {
  try {
    const root = path.resolve(process.argv[2] || path.join(__dirname, "..", "games", "outlaw-engine"));
    const r = build(root, process.argv[3] ? path.resolve(process.argv[3]) : null);
    console.log("shelf: " + r.shelf.games.length + " games and apps as one file each, " + (r.bytes / 1048576).toFixed(1) + " MB");
    r.warn.forEach((w) => console.log("  ! " + w));
  } catch (e) {
    console.error("shelf: " + e.message);
    process.exit(1);
  }
}

module.exports = { build, bundle, inlineCss, scriptSafe, local };
