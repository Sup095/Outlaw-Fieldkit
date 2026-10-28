/* ============================================================
   FieldKit relay :: updates
   Serves signed releases (§14.4, §14.43).

   ---- WHAT THIS FILE IS NOT TRUSTED TO DO ---------------------

   Almost everything. It hands out two things: a release.json that
   somebody signed on the SSD, and the files that release.json
   names. It cannot sign, it has no key, and it is not asked
   whether a release is good — the client checks the signature
   against a public key that shipped inside the client.

   That is the entire design. Auto-update is a remote-code path
   into the application that holds the vault: whoever decides what
   FieldKit downloads next can hand over a modified core/crypto.js,
   and the version that reads your passphrase looks exactly like
   the version that does not. So this relay is assumed hostile. It
   can serve a stale release, or none, or garbage — and the worst
   any of those does is leave the user on the version they already
   have, which is a bad day rather than a catastrophe.

   ---- WHERE THE FILES COME FROM -------------------------------

   Two places, and the newer wins:
     1. GitHub. With updates.githubRepo set, the relay reads the
        latest release there every mirrorEveryMin minutes. Its notes
        carry the signed record (between FIELDKIT-RELEASE markers,
        written by `node build.js --release`); the relay downloads
        each file it names, keeps it only if its hash matches, and
        serves the copy. This is the fallback for a school network
        that blocks GitHub, and the way the page gets bytes at all:
        GitHub's downloads cannot be read by a page (no CORS), the
        relay's can, so the page can hash them before saving.
     2. Uploaded by hand into data/updates/ (the release/ folder
        `node build.js --release` makes), as before.

   ---- WHO CAN ASK ---------------------------------------------

   Anyone. The builds are public on GitHub, and OUTPOST, which has
   no vault token, needs updates too. Rate-limited in server.js.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  nameChars: 64,
  fetchMs: 60000
};

let DIR = null;
let MIRROR = null;
let cfg = { enabled: false };
let log = () => {};
let timer = null;
/* What the GitHub mirror last did, for /updates/status and DIAGNOSTICS. */
const mirrorState = { checkedAt: null, version: null, error: null, busy: false };

const CONFIG_DEFAULTS = { enabled: false, githubRepo: "", mirrorEveryMin: 360 };

/* The signed record inside a release's notes. Kept identical to
   parseReleaseBody() in modules/updater.js; tests/updates.test.js
   runs both. */
const BODY_RE = /<!--\s*FIELDKIT-RELEASE\s*([\s\S]*?)\s*FIELDKIT-RELEASE\s*-->/;
function parseReleaseBody(body) {
  const m = BODY_RE.exec(String(body || ""));
  if (!m) return null;
  try {
    const rel = JSON.parse(m[1]);
    return rel && typeof rel === "object" && Array.isArray(rel.files) ? rel : null;
  } catch (e) { return null; }
}

function init(opts) {
  DIR = path.join(opts.dataDir, "updates");
  MIRROR = path.join(DIR, "github");
  cfg = Object.assign({}, CONFIG_DEFAULTS, opts.config || {});
  log = opts.log || log;
  if (timer) { clearInterval(timer); timer = null; }

  if (!cfg.enabled) return { enabled: false };

  fs.mkdirSync(DIR, { recursive: true });
  if (cfg.githubRepo && validRepo(cfg.githubRepo) && opts.mirror !== false) {
    const every = Math.max(10, Number(cfg.mirrorEveryMin) || 360) * 60000;
    setTimeout(() => { mirror().catch(() => {}); }, 15000).unref();
    timer = setInterval(() => { mirror().catch(() => {}); }, every);
    if (timer.unref) timer.unref();
  } else if (cfg.githubRepo) {
    log("WARN", "updates: githubRepo should look like owner/name; not mirroring");
  }
  const cur = current();
  if (!cur) {
    log("INFO", "updates: on; nothing to serve yet" +
      (cfg.githubRepo ? " — the GitHub release will be fetched shortly" : " — upload release/ into data/updates/"));
    return { enabled: true, version: null };
  }
  const missing = (cur.rel.files || []).filter((f) => !fs.existsSync(path.join(cur.dir, f.name)));
  if (missing.length) {
    /* A release.json naming files that are not there is the most
       likely upload mistake, and the symptom on the client is a
       download that 404s halfway through a check. Named at boot
       instead. */
    log("WARN", "updates: release.json names file(s) that are not uploaded: " +
      missing.map((f) => f.name).join(", "));
  }
  log("INFO", `updates: serving v${cur.rel.version} from ${cur.source} (${(cur.rel.files || []).length} file(s)), ` +
    `signed with key ${cur.rel.keyFingerprint || "?"}`);
  return { enabled: true, version: cur.rel.version };
}

function validRepo(r) { return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(String(r || "")); }

function readRel(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8")); }
  catch (e) { return null; }
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* The release to serve: the newer of the hand upload and the mirror. */
function current() {
  if (!DIR) return null;
  const hand = readRel(DIR), gh = readRel(MIRROR);
  if (hand && gh) {
    return compareVersions(hand.version, gh.version) >= 0
      ? { rel: hand, dir: DIR, source: "upload" } : { rel: gh, dir: MIRROR, source: "github" };
  }
  if (hand) return { rel: hand, dir: DIR, source: "upload" };
  if (gh) return { rel: gh, dir: MIRROR, source: "github" };
  return null;
}

async function fetchWithin(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), LIMITS.fetchMs);
  try {
    return await fetch(url, Object.assign({ signal: ac.signal, redirect: "follow" }, opts || {}));
  } finally { clearTimeout(t); }
}

/* Reads the latest GitHub release and keeps a verified copy. Files
   are checked against the hashes inside the record (and against
   GitHub's own digest when it gives one); a file that does not match
   means nothing is replaced. release.json is written last, so a copy
   cut off halfway is never served. `fetcher` is for the tests. */
async function mirror(fetcher) {
  if (!cfg.enabled || !validRepo(cfg.githubRepo) || mirrorState.busy) return mirrorState;
  const get = fetcher || fetchWithin;
  mirrorState.busy = true;
  try {
    const r = await get("https://api.github.com/repos/" + cfg.githubRepo + "/releases/latest",
      { headers: { "Accept": "application/vnd.github+json", "User-Agent": "fieldkit-relay" } });
    if (!r.ok) throw new Error("GitHub answered " + r.status);
    const gh = await r.json();
    const rel = parseReleaseBody(gh.body);
    if (!rel) throw new Error("release " + (gh.tag_name || "?") + " carries no signed FieldKit record in its notes");
    if (!rel.signature || !rel.files.length) throw new Error("the record in " + (gh.tag_name || "?") + " is unsigned");
    const have = readRel(MIRROR);
    if (have && have.signature === rel.signature &&
        rel.files.every((f) => fs.existsSync(path.join(MIRROR, f.name)))) {
      mirrorState.version = rel.version;
      mirrorState.error = null;
      return mirrorState;
    }
    const stage = MIRROR + ".incoming";
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    for (const f of rel.files) {
      if (!fileNamed(rel, f.name)) throw new Error("the record names a file this relay will not serve: " + f.name);
      const asset = (gh.assets || []).find((a) => a.name === f.name);
      if (!asset) throw new Error(f.name + " is named in the record but not attached to the release");
      if (asset.digest && asset.digest !== "sha256:" + f.sha256) {
        throw new Error("GitHub's " + f.name + " does not match the signed record");
      }
      if (f.size > LIMITS.maxFileBytes) throw new Error(f.name + " is larger than this relay serves");
      const d = await get(asset.browser_download_url, { headers: { "User-Agent": "fieldkit-relay" } });
      if (!d.ok) throw new Error("downloading " + f.name + ": GitHub answered " + d.status);
      const buf = Buffer.from(await d.arrayBuffer());
      const got = crypto.createHash("sha256").update(buf).digest("hex");
      if (got !== f.sha256 || buf.length !== f.size) {
        throw new Error("the downloaded " + f.name + " does not match the signed record");
      }
      fs.writeFileSync(path.join(stage, f.name), buf);
    }
    fs.writeFileSync(path.join(stage, "release.json"), JSON.stringify(rel, null, 2));
    fs.rmSync(MIRROR + ".old", { recursive: true, force: true });
    if (fs.existsSync(MIRROR)) fs.renameSync(MIRROR, MIRROR + ".old");
    fs.renameSync(stage, MIRROR);
    fs.rmSync(MIRROR + ".old", { recursive: true, force: true });
    mirrorState.version = rel.version;
    mirrorState.error = null;
    log("INFO", "updates: mirrored v" + rel.version + " from GitHub (" + rel.files.length + " file(s))");
    return mirrorState;
  } catch (e) {
    mirrorState.error = e.name === "AbortError" ? "GitHub did not answer in time" : e.message;
    log("WARN", "updates: GitHub mirror: " + mirrorState.error);
    return mirrorState;
  } finally {
    mirrorState.checkedAt = new Date().toISOString();
    mirrorState.busy = false;
  }
}

/* Names come from a URL, so nothing but a plain filename is
   acceptable — and it must be one release.json actually lists,
   which is a stronger check than any amount of path scrubbing
   because it is an allow list rather than a denial. */
function fileNamed(rel, name) {
  name = String(name || "");
  if (name.length > LIMITS.nameChars) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (name.indexOf("..") >= 0) return null;
  if (name === "release.json") return null;
  return (rel.files || []).find((f) => f.name === name) || null;
}

const ROUTES_BY_NAME = { latest: ["GET"], file: ["GET"], status: ["GET"] };

async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "updates") return false;

  const { send } = helpers;
  const what = seg[1] || "";
  const method = req.method;

  if (!cfg.enabled) {
    send(res, 503, { error: "updates are not enabled on this relay",
      detail: "set updates.enabled in config.json and restart" });
    return true;
  }

  if (!ROUTES_BY_NAME[what]) {
    send(res, 404, { error: "no such updates route",
      routes: Object.keys(ROUTES_BY_NAME).map((n) => "/updates/" + n) });
    return true;
  }
  if (ROUTES_BY_NAME[what].indexOf(method) < 0) {
    send(res, 405, { error: method + " is not how you call /updates/" + what,
      allowed: ROUTES_BY_NAME[what] }, { Allow: ROUTES_BY_NAME[what].join(", ") });
    return true;
  }

  const cur = current();

  if (what === "status") {
    send(res, 200, { serving: cur ? cur.rel.version : null, source: cur ? cur.source : null,
      github: cfg.githubRepo ? { repo: cfg.githubRepo, checkedAt: mirrorState.checkedAt,
        version: mirrorState.version, error: mirrorState.error } : null });
    return true;
  }

  if (!cur) {
    send(res, 503, { error: "this relay has no release to offer yet",
      detail: cfg.githubRepo ? "it fetches the GitHub release every " + cfg.mirrorEveryMin + " minutes" +
        (mirrorState.error ? "; last time: " + mirrorState.error : "")
        : "run `node build.js --release` on the SSD and upload release/ into data/updates/" });
    return true;
  }
  const rel = cur.rel;

  if (what === "latest") {
    /* Handed over exactly as it was signed. Not rebuilt, not
       re-serialised, not annotated — a field added here would be a
       field outside the signature, and a client reading it would be
       trusting this process about something. */
    send(res, 200, rel);
    return true;
  }

  /* ---- the file itself ---- */
  const entry = fileNamed(rel, url.searchParams.get("name"));
  if (!entry) {
    send(res, 404, { error: "that file is not part of the current release",
      available: (rel.files || []).map((f) => f.name) });
    return true;
  }

  const abs = path.join(cur.dir, entry.name);
  let buf;
  try { buf = fs.readFileSync(abs); }
  catch (e) {
    send(res, 404, { error: "release.json names " + entry.name + " but it is not uploaded" });
    return true;
  }
  if (buf.length > LIMITS.maxFileBytes) {
    send(res, 507, { error: "that file is larger than this route will serve" });
    return true;
  }

  /* Checked here too, and this is NOT the security boundary — the
     client re-hashes and checks the signature regardless. It is
     here because a file that got truncated on upload should be
     caught by the person who can fix it, not diagnosed by whoever
     tries to update at school. */
  const got = crypto.createHash("sha256").update(buf).digest("hex");
  if (got !== entry.sha256) {
    log("ERROR", `updates: ${entry.name} on disk does not match release.json ` +
      `(expected ${entry.sha256.slice(0, 12)}, have ${got.slice(0, 12)}). Re-upload it.`);
    send(res, 409, { error: "the stored file does not match the signed release",
      detail: "it was probably truncated or replaced. Re-upload data/updates/." });
    return true;
  }

  log("INFO", `updates: ${entry.name} (v${rel.version}) downloaded`);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(buf.length),
    /* Downloaded, never rendered. Serving a full FieldKit build as
       a live page on the relay's own origin would put the whole app
       somewhere it was never designed to run. */
    "Content-Disposition": 'attachment; filename="' + entry.name + '"',
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  res.end(buf);
  return true;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { init, route, mirror, stop, parseReleaseBody, LIMITS,
  _internals: { fileNamed, current, mirrorState, compareVersions } };
