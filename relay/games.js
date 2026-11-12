/* ============================================================
   FieldKit relay :: games — GAME MODE through the relay

   GAME MODE (modules/game-mode.js) opens a library of games: the relay
   owner's own (games/library/, made by tools/add-games.js), the Outlaw
   Engine (games/outlaw-engine/, tools/sync-games.js), or both. On a drive
   it opens the copy beside FIELDKIT.html. Where there is no copy (a single
   downloaded file, a friend on OUTPOST) it opens this one: the same
   files, put beside the relay by tools/make-deploy.js. They are served
   exactly as they are; each game keeps its own look, and the Outlaw
   Engine its own diagnostics.

   ONLY FOR PEOPLE WHO ARE SIGNED IN. The games belong to whoever put them
   here (the Outlaw Engine is All rights reserved), not a public site. Someone signed in to MESSAGES, or with a
   gamertag, asks POST /games/ticket and gets a path with a ticket in it:

     /games/t/<ticket>/index.html

   A ticket is the time it runs out and an HMAC of that time under a key
   only this relay holds (data/games-key), so nothing has to be stored per
   ticket. It is in the PATH, not a cookie or a header, because a frame
   cannot send a header and the engine's own relative links (engine/,
   games/, vendor/...) then carry it along by themselves. Every answer says
   Referrer-Policy: no-referrer, so a game that loads something from
   elsewhere does not hand that site the ticket.

   Saves: every game keeps its saves in localStorage, which belongs to the
   relay's address, so they last from one ticket to the next.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TICKET_MS = 12 * 3600 * 1000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg", ".wav": "audio/wav", ".wasm": "application/wasm", ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

let root = null, entry = "", key = null, clock = Date.now, info = null;

/* What a games folder holds, and so what is served:
     library/        the owner's own games (tools/add-games.js). When it is
                     there the whole games folder is served and the library's
                     page is the way in, so its link to ../outlaw-engine/
                     works when that is there too.
     outlaw-engine/  alone: served by itself, as before. */
function pick(dir) {
  if (!dir) return null;
  const has = (p) => fs.existsSync(path.join(dir, p, "index.html"));
  if (has("library")) return { root: path.resolve(dir), entry: "library/" };
  if (has("outlaw-engine")) return { root: path.resolve(dir, "outlaw-engine"), entry: "" };
  return null;
}

/* opts: { dataDir, now, dir (a games folder: see pick) or root (one library's own folder) } */
function init(opts) {
  opts = opts || {};
  clock = opts.now || Date.now;
  const p = opts.dir ? pick(opts.dir) : null;
  root = p ? p.root : opts.root ? path.resolve(opts.root) : null;
  entry = p ? p.entry : "";
  if (root && !fs.existsSync(path.join(root, entry, "index.html"))) root = null;
  info = null;
  if (root) {
    try {
      const t = fs.readFileSync(path.join(root, entry, "fieldkit-games.js"), "utf8");
      const i = t.indexOf("window.FK_GAMES =");
      if (i >= 0) info = JSON.parse(t.slice(i + 17).trim().replace(/;\s*$/, ""));
    } catch (e) { info = null; }
  }
  const kf = path.join(opts.dataDir, "games-key");
  try { key = fs.readFileSync(kf); } catch (e) { key = null; }
  if (!key || key.length < 32) {
    key = crypto.randomBytes(32);
    try { fs.mkdirSync(opts.dataDir, { recursive: true }); fs.writeFileSync(kf, key, { mode: 0o600 }); } catch (e) { /* a key for this run only */ }
  }
  return { up: !!root, version: info && info.version, name: name() };
}
function name() { return String((info && (info.engine || info.name)) || "Outlaw Engine").slice(0, 40); }
function up() { return !!root; }

const mac = (exp) => crypto.createHmac("sha256", key).update("games:" + exp).digest("base64url").slice(0, 22);
function ticket() {
  const exp = (clock() + TICKET_MS).toString(36);
  return exp + "." + mac(exp);
}
function ticketOk(t) {
  const m = /^([0-9a-z]{6,12})\.([A-Za-z0-9_-]{22})$/.exec(String(t || ""));
  if (!m) return false;
  const want = Buffer.from(mac(m[1])), got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  return parseInt(m[1], 36) > clock();
}

/* The file a request names, or null: inside the root, no dot-names, no tricks. */
function fileFor(rel) {
  let p;
  try { p = decodeURIComponent(rel); } catch (e) { return null; }
  if (!p || p.endsWith("/")) p += "index.html";
  if (p.indexOf("\0") >= 0 || /(^|[\\/])\.[^\\/]*/.test(p)) return null;
  const abs = path.resolve(root, p);
  if (abs !== root && abs.indexOf(root + path.sep) !== 0) return null;
  try { const st = fs.statSync(abs); return st.isFile() ? { abs: abs, size: st.size, mtime: st.mtimeMs } : null; } catch (e) { return null; }
}

const HEAD = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin"
};

/* h: { send, readBody, who(req) -> { name } | null } */
async function route(req, res, url, h) {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "games") return false;
  const what = seg[1] || "", method = req.method;
  if (what === "status" && method === "GET") {
    h.send(res, 200, { up: up(), name: up() ? name() : null, version: info ? info.version || null : null, library: info && info.library ? { games: info.library.games, apps: info.library.apps } : null });
    return true;
  }
  if (what === "ticket" && method === "POST") {
    if (!up()) { h.send(res, 503, { error: "this relay has no copy of the games" }); return true; }
    const who = h.who(req);
    if (!who) { h.send(res, 401, { error: "sign in to MESSAGES, or with your gamertag, to play through the relay", needsSignIn: true }); return true; }
    const t = ticket();
    h.send(res, 200, { ok: true, path: "/games/t/" + t + "/" + entry + "index.html", expires: parseInt(t.split(".")[0], 36), info: info || null });
    return true;
  }
  if (what === "t" && (method === "GET" || method === "HEAD")) {
    if (!up() || !ticketOk(seg[2])) {
      const body = "<!doctype html><meta charset=utf-8><title>GAME MODE</title><body style=\"background:#000;color:#3f6;font:14px monospace;padding:24px\">" +
        "<p>This game link has run out. Close GAME MODE and open it again from FieldKit.</p></body>";
      res.writeHead(403, Object.assign({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, HEAD));
      res.end(method === "HEAD" ? undefined : body);
      return true;
    }
    const prefix = "/games/t/" + seg[2] + "/";
    const f = url.pathname.indexOf(prefix) === 0 ? fileFor(url.pathname.slice(prefix.length)) : null;
    if (!f) { res.writeHead(404, Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, HEAD)); res.end(method === "HEAD" ? undefined : "not found"); return true; }
    const type = TYPES[path.extname(f.abs).toLowerCase()] || "application/octet-stream";
    const etag = "\"" + f.size.toString(36) + "-" + Math.floor(f.mtime).toString(36) + "\"";
    const headers = Object.assign({ "Content-Type": type, "Content-Length": f.size, "ETag": etag,
      /* private: the path holds a ticket, so no shared cache keeps it */
      "Cache-Control": /\.html?$/.test(f.abs) ? "private, no-cache" : "private, max-age=3600" }, HEAD);
    if (req.headers["if-none-match"] === etag) { delete headers["Content-Length"]; res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, headers);
    if (method === "HEAD") { res.end(); return true; }
    fs.createReadStream(f.abs).on("error", () => { try { res.destroy(); } catch (e) { /* gone */ } }).pipe(res);
    return true;
  }
  h.send(res, 404, { error: "no such games route" });
  return true;
}

module.exports = { init, route, up, _ticket: ticket, _ticketOk: ticketOk, TICKET_MS };
