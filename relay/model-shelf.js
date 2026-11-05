/* ============================================================
   FieldKit relay :: model-shelf — a few tiny models kept on the relay

     GET /k/list        what is on the shelf: [{ n, id, mb, bytes, files: [{ i, name, size, sha256 }] }]
     GET /k/<n>/<i>     file i of model n
     GET /k/e.js        the in-browser engine (the same file as /ai/engine.js)

   GET A TINY MODEL used to ask Hugging Face, then the relay's mirror
   (model-mirror.js) for a school that blocks Hugging Face. A filter that
   reads addresses still saw "huggingface.co" and the model's name in
   every one of the mirror's (/ai/mirror?u=https://huggingface.co/...),
   and blocked them too. So the relay keeps a few models whole on its own
   disk, fetched once when it starts, and serves them under addresses
   that say nothing: numbers under /k/. The panel installs those from
   here first and never asks Hugging Face for them.

   WHICH. config.modelShelf.models, model ids from the engine's own list
   (vendor/web-llm.js), so the files and the model library are the ones
   the engine expects. Changing the list and restarting fetches the new
   ones; a model taken off the list is deleted.

   Each file is kept only at the size Hugging Face lists and with its
   SHA-256 written down; the panel checks both. A model appears on the
   list only once every file is here (its manifest is written last).
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const HF = "https://huggingface.co/";
const DEFAULTS = {
  enabled: true,
  models: ["SmolLM2-360M-Instruct-q4f16_1-MLC", "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", "Llama-3.2-1B-Instruct-q4f16_1-MLC"],
  perIp: 3                     /* files one address may be fetching at once */
};
const SKIP = /(^|\/)(\.gitattributes|README\.md)$/;
const FETCH_MS = 60000;

let cfg = Object.assign({}, DEFAULTS);
let dir = null;
let log = () => {};
let engineFiles = () => [];
let fetcher = null;             /* (url) => Promise<IncomingMessage-like>; replaceable for the tests */
let shelf = [];                 /* the manifests, in config order */
const busy = new Map();
const state = { filling: null, error: null };

function get(url, hops) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "FieldKit-relay/1 (model shelf)" }, timeout: FETCH_MS }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        let next;
        try { next = new URL(loc, url); } catch (e) { return reject(new Error("a bad redirect")); }
        if (next.protocol !== "https:" || (hops | 0) >= 5) return reject(new Error("redirected somewhere this will not follow"));
        return resolve(get(next.href, (hops | 0) + 1));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", reject);
  });
}

/* Where the engine says a model's weights and library are. */
function locate(id) {
  const file = engineFiles().find((f) => fs.existsSync(f));
  if (!file) return null;
  const text = fs.readFileSync(file, "utf8");
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp('model:"(https://huggingface\\.co/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)",model_id:"' + esc +
    '",model_lib:[A-Za-z_$]+\\+[A-Za-z_$]+\\+"(/[A-Za-z0-9_.-]+\\.wasm)"').exec(text);
  const v = /="(v\d+_\d+_\d+)",[A-Za-z_$]+="(https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/main\/web-llm-models\/)"/.exec(text);
  if (!m || !v) return null;
  return { repo: m[1].slice(HF.length), lib: v[2] + v[1] + m[2] };
}

async function getJson(url) {
  const r = await fetcher(url);
  if (r.statusCode !== 200) { r.resume(); throw new Error(url.replace(HF, "") + " answered " + r.statusCode); }
  let body = "";
  r.setEncoding("utf8");
  for await (const c of r) body += c;
  return JSON.parse(body);
}

/* One file to disk, hashed on the way; refused at the wrong size. */
async function download(url, to, size) {
  const r = await fetcher(url);
  if (r.statusCode !== 200) { r.resume(); throw new Error(path.basename(to) + ": answered " + r.statusCode); }
  const h = crypto.createHash("sha256");
  const tmp = to + ".part";
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    for await (const c of r) {
      got += c.length; h.update(c);
      if (!out.write(c)) await new Promise((ok) => out.once("drain", ok));
    }
    await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok())));
  } catch (e) { out.destroy(); try { fs.unlinkSync(tmp); } catch (x) {} throw e; }
  if (size != null && got !== size) { try { fs.unlinkSync(tmp); } catch (x) {} throw new Error(path.basename(to) + " arrived at the wrong size"); }
  fs.renameSync(tmp, to);
  return { size: got, sha256: h.digest("hex") };
}

function folder(id) { return path.join(dir, id.replace(/[^A-Za-z0-9_.-]/g, "_")); }
function readManifest(id) {
  try { return JSON.parse(fs.readFileSync(path.join(folder(id), "manifest.json"), "utf8")); } catch (e) { return null; }
}

async function fill(id) {
  if (readManifest(id)) return;
  const where = locate(id);
  if (!where) throw new Error(id + " is not a model the engine knows");
  state.filling = id;
  log("INFO", "model-shelf: fetching " + id);
  const meta = await getJson(HF + "api/models/" + where.repo + "?blobs=true");
  const files = (meta.siblings || []).filter((s) => !SKIP.test(s.rfilename))
    .map((s) => ({ name: s.rfilename, url: HF + where.repo + "/resolve/main/" + s.rfilename, size: typeof s.size === "number" ? s.size : null }));
  if (!files.length || files.some((f) => !/^[A-Za-z0-9_.-]+$/.test(f.name))) throw new Error(id + ": an unexpected file list");
  files.push({ name: "model.wasm", url: where.lib, size: null });
  const into = folder(id);
  fs.mkdirSync(into, { recursive: true });
  const kept = [];
  for (const f of files) kept.push(Object.assign({ name: f.name }, await download(f.url, path.join(into, f.name), f.size)));
  const manifest = { id, bytes: kept.reduce((a, f) => a + f.size, 0), files: kept, at: new Date().toISOString() };
  fs.writeFileSync(path.join(into, "manifest.json"), JSON.stringify(manifest, null, 1));
  log("INFO", "model-shelf: " + id + " is on the shelf (" + Math.round(manifest.bytes / 1048576) + " MB)");
}

function reload() {
  shelf = (cfg.models || []).map(readManifest).filter(Boolean);
}

/* Fetches what is missing, one model at a time, and deletes what is no
   longer listed. Runs in the background after start. */
async function fillAll() {
  if (!dir) return;
  const want = new Set((cfg.models || []).map((id) => path.basename(folder(id))));
  for (const name of fs.readdirSync(dir)) {
    if (!want.has(name)) { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); log("INFO", "model-shelf: removed " + name); }
  }
  for (const id of cfg.models || []) {
    try { await fill(id); state.error = null; }
    catch (e) { state.error = e.message; log("WARN", "model-shelf: " + e.message); }
    reload();
  }
  state.filling = null;
}

function init(opts) {
  cfg = Object.assign({}, DEFAULTS, (opts && opts.config) || {});
  log = (opts && opts.log) || log;
  engineFiles = (opts && opts.engineFiles) || engineFiles;
  fetcher = (opts && opts.fetcher) || get;
  dir = opts && opts.dataDir && cfg.enabled ? path.join(opts.dataDir, "shelf") : null;
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { dir = null; } }
  reload();
  if (dir && opts.start !== false) setTimeout(() => fillAll().catch((e) => log("WARN", "model-shelf: " + e.message)), 30000).unref();
  return { enabled: !!dir, models: shelf.length };
}

function list() {
  return shelf.map((m, n) => ({ n, id: m.id, mb: Math.round(m.bytes / 1048576), bytes: m.bytes,
    files: m.files.map((f, i) => ({ i, name: f.name, size: f.size, sha256: f.sha256 })) }));
}

async function route(req, res, url, kit) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "k" || req.method !== "GET") return false;
  const send = kit.send;
  if (seg[1] === "list" && !seg[2]) {
    send(res, 200, { models: list(), filling: state.filling });
    return true;
  }
  if (!/^\d+$/.test(seg[1] || "") || !/^\d+$/.test(seg[2] || "") || seg[3]) return false;
  const m = shelf[Number(seg[1])], f = m && m.files[Number(seg[2])];
  if (!f) { send(res, 404, { error: "not on the shelf" }); return true; }
  const ip = kit.clientIp ? kit.clientIp(req) : "?";
  if ((busy.get(ip) || 0) >= cfg.perIp) { send(res, 429, { error: "one file at a time, please", busy: true }); return true; }
  const file = path.join(folder(m.id), f.name);
  let st;
  try { st = fs.statSync(file); } catch (e) { send(res, 404, { error: "not on the shelf" }); return true; }
  busy.set(ip, (busy.get(ip) || 0) + 1);
  let freed = false;
  const done = () => { if (freed) return; freed = true; const n = (busy.get(ip) || 1) - 1; if (n > 0) busy.set(ip, n); else busy.delete(ip); };
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size,
    "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" });
  const s = fs.createReadStream(file);
  s.on("error", () => { done(); res.destroy(); });
  res.on("close", () => { done(); s.destroy(); });
  s.pipe(res);
  return true;
}

module.exports = { init, route, list, fillAll, locate, state, DEFAULTS };
