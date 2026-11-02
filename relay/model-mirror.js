/* ============================================================
   FieldKit relay :: model-mirror — tiny models for a network that
   blocks Hugging Face

     GET /ai/mirror?u=<url>   one file of one model, through here

   A school that blocks huggingface.co (or the CDN it redirects to)
   left GET A TINY MODEL with nothing to fetch. So the page asks
   Hugging Face first and, if that fails, asks here for the same file:
   the relay fetches it, keeps a copy on its disk, and passes it on.

   NOT A GENERAL PROXY. The only addresses it will fetch are:
     - a model repository named in the engine this relay serves
       (vendor/web-llm.js lists every model it can run), as its file
       list (huggingface.co/api/models/<repo>) or one of its files
       (huggingface.co/<repo>/resolve/main/<file>);
     - the engine's model libraries, under one fixed GitHub folder.
   Redirects are followed only to Hugging Face's and GitHub's own
   hosts, over https. Anything else is a 403.

   COSTS. A model is hundreds of megabytes, and the bytes leave the
   house through the same upload as everything else, so they go out
   under the relay's upload ceiling (upcap.js) like any other socket.
   The disk copy means Hugging Face is asked once per file, not once
   per person. A file is kept only if it arrived whole; the oldest go
   first when the cache passes cacheGB.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const HF = "https://huggingface.co/";
const LIBS = "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/";
const REDIRECT_OK = /(^|\.)(huggingface\.co|hf\.co|githubusercontent\.com)$/;
const DEFAULTS = { enabled: true, cacheGB: 8, maxBusy: 4, perIp: 2, maxFileMB: 1500 };
const FETCH_MS = 60000;

let cfg = Object.assign({}, DEFAULTS);
let dir = null;
let log = () => {};
let repos = null;              /* the engine's model repositories, read once */
let engineFiles = () => [];
const busy = new Map();         /* ip -> downloads in progress */
let busyAll = 0;

function init(opts) {
  cfg = Object.assign({}, DEFAULTS, (opts && opts.config) || {});
  log = (opts && opts.log) || log;
  dir = opts && opts.dataDir ? path.join(opts.dataDir, "model-cache") : null;
  engineFiles = (opts && opts.engineFiles) || engineFiles;
  repos = null;
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { dir = null; } }
  return { enabled: !!cfg.enabled, cache: !!dir };
}

/* Every huggingface.co/<org>/<model> the engine names. */
function knownRepos() {
  if (repos) return repos;
  repos = new Set();
  const file = engineFiles().find((f) => fs.existsSync(f));
  if (!file) return repos;
  const text = fs.readFileSync(file, "utf8");
  const re = /https:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;
  for (let m; (m = re.exec(text));) repos.add(m[1]);
  return repos;
}

/* The url, if it is one this will fetch; null otherwise. */
function allowed(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const href = u.origin + u.pathname;
  if (/\.\./.test(u.pathname) || /%2e|%2f/i.test(u.pathname)) return null;
  if (href.startsWith(LIBS) && /^[A-Za-z0-9_.\/-]+\.wasm$/.test(href.slice(LIBS.length))) return { url: href, kind: "lib" };
  if (u.origin + "/" !== HF) return null;
  const p = u.pathname.split("/").filter(Boolean);
  if (p[0] === "api" && p[1] === "models" && p.length === 4 && knownRepos().has(p[2] + "/" + p[3])) {
    return { url: HF + "api/models/" + p[2] + "/" + p[3] + "?blobs=true", kind: "list" };
  }
  if (p.length >= 5 && p[2] === "resolve" && p[3] === "main" && knownRepos().has(p[0] + "/" + p[1]) &&
      p.slice(4).every((s) => /^[A-Za-z0-9_.-]+$/.test(s))) {
    return { url: href, kind: "file" };
  }
  return null;
}

function get(url, hops) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "FieldKit-relay/1 (model mirror)" }, timeout: FETCH_MS }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        let next;
        try { next = new URL(loc, url); } catch (e) { return reject(new Error("a bad redirect")); }
        if (next.protocol !== "https:" || !REDIRECT_OK.test(next.hostname) || (hops | 0) >= 5) {
          return reject(new Error("redirected somewhere this will not follow"));
        }
        return resolve(get(next.href, (hops | 0) + 1));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", reject);
  });
}

function cachePath(url) { return path.join(dir, crypto.createHash("sha256").update(url).digest("hex").slice(0, 40)); }

/* Oldest first until the cache fits. Run after a file is kept. */
function trim() {
  if (!dir) return;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => !n.endsWith(".part")).map((n) => {
      const s = fs.statSync(path.join(dir, n));
      return { n, size: s.size, at: s.mtimeMs };
    });
  } catch (e) { return; }
  let total = files.reduce((a, f) => a + f.size, 0);
  const cap = cfg.cacheGB * 1073741824;
  files.sort((a, b) => a.at - b.at);
  while (total > cap && files.length) {
    const f = files.shift();
    try { fs.unlinkSync(path.join(dir, f.n)); total -= f.size; } catch (e) {}
  }
}

function headersFor(kind, size) {
  const h = { "Content-Type": kind === "list" ? "application/json; charset=utf-8" : "application/octet-stream",
    "Cache-Control": kind === "list" ? "no-store" : "public, max-age=604800", "X-Content-Type-Options": "nosniff" };
  if (size != null) h["Content-Length"] = size;
  return h;
}

async function route(req, res, url, kit) {
  if (url.pathname !== "/ai/mirror" || req.method !== "GET") return false;
  const send = kit.send;
  if (!cfg.enabled) { send(res, 503, { error: "this relay does not pass models on" }); return true; }
  const want = allowed(url.searchParams.get("u"));
  if (!want) { send(res, 403, { error: "that is not a file of a model this relay's engine runs" }); return true; }

  /* Already here: from the disk, touched so it is the last to go. */
  const file = dir && want.kind !== "list" ? cachePath(want.url) : null;
  if (file && fs.existsSync(file)) {
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch (e) {}
    res.writeHead(200, headersFor(want.kind, fs.statSync(file).size));
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const ip = kit.clientIp ? kit.clientIp(req) : "?";
  if (busyAll >= cfg.maxBusy || (busy.get(ip) || 0) >= cfg.perIp) {
    send(res, 429, { error: "the relay is already fetching models for others; try again in a minute", busy: true });
    return true;
  }
  busyAll++; busy.set(ip, (busy.get(ip) || 0) + 1);
  let freed = false;
  const done = () => { if (freed) return; freed = true; busyAll--; const n = (busy.get(ip) || 1) - 1; if (n > 0) busy.set(ip, n); else busy.delete(ip); };

  let up;
  try { up = await get(want.url); }
  catch (e) { done(); send(res, 502, { error: "Hugging Face did not answer the relay either: " + e.message }); return true; }
  if (up.statusCode !== 200) {
    up.resume(); done();
    send(res, 502, { error: "Hugging Face answered the relay " + up.statusCode });
    return true;
  }
  const size = up.headers["content-length"] != null ? Number(up.headers["content-length"]) : null;
  if (size != null && size > cfg.maxFileMB * 1048576) {
    up.destroy(); done();
    send(res, 413, { error: "that file is larger than this relay passes on" });
    return true;
  }

  res.writeHead(200, headersFor(want.kind, size));
  /* To the person and to the disk at once: a file of hundreds of
     megabytes cannot wait to be whole before the first byte goes out
     (Cloudflare gives up on an answer that has not started in 100 s). */
  const tmp = file ? file + "." + process.pid + "." + Date.now() + ".part" : null;
  const disk = tmp ? fs.createWriteStream(tmp) : null;
  let got = 0, failed = false;
  if (disk) disk.on("error", () => { failed = true; });
  up.on("data", (c) => {
    got += c.length;
    if (disk && !failed) disk.write(c);
    if (!res.write(c)) { up.pause(); res.once("drain", () => up.resume()); }
  });
  up.on("end", () => {
    res.end();
    if (!disk) return done();
    disk.end(() => {
      if (!failed && (size == null || got === size)) {
        try { fs.renameSync(tmp, file); trim(); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} }
      } else { try { fs.unlinkSync(tmp); } catch (e) {} }
      done();
    });
  });
  up.on("error", () => { failed = true; res.destroy(); });
  res.on("close", () => {
    if (got === size || up.complete) return;
    /* The person went away: the download stops, and nothing half is kept. */
    failed = true;
    up.destroy();
    if (disk) disk.end(() => { try { fs.unlinkSync(tmp); } catch (e) {} done(); });
    else done();
  });
  return true;
}

module.exports = { init, route, allowed, DEFAULTS, _internals: { knownRepos, trim, busy, cachePath } };
