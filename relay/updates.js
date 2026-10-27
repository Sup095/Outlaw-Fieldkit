/* ============================================================
   FieldKit relay :: updates
   Serves signed releases (§14.4).

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

   A checksum served from here would prove nothing, because anyone
   who can replace the file can replace the checksum beside it.
   Hence a signature, made somewhere this process cannot reach.

   ---- WHERE THE FILES COME FROM -------------------------------

   Uploaded by hand into data/updates/, the same way every other
   server file gets here. `node build.js --release` on the SSD
   produces exactly the folder to upload.

   ---- WHO CAN ASK ---------------------------------------------

   The vault token. Not a messaging session, and not the public —
   builds are for the two people who own this thing. OUTPOST users
   do not get updates yet and the header of the route says so
   rather than failing silently; that is a decision to revisit, not
   an oversight.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  nameChars: 64
};

let DIR = null;
let cfg = { enabled: false };
let log = () => {};

const CONFIG_DEFAULTS = { enabled: false };

function init(opts) {
  DIR = path.join(opts.dataDir, "updates");
  cfg = Object.assign({}, CONFIG_DEFAULTS, opts.config || {});
  log = opts.log || log;

  if (!cfg.enabled) return { enabled: false };

  fs.mkdirSync(DIR, { recursive: true });
  const rel = current();
  if (!rel) {
    log("WARN", "updates: on, but data/updates/release.json is missing or unreadable — " +
      "nothing will be offered until you upload one");
    return { enabled: true, version: null };
  }
  const missing = (rel.files || []).filter((f) => !fs.existsSync(path.join(DIR, f.name)));
  if (missing.length) {
    /* A release.json naming files that are not there is the most
       likely upload mistake, and the symptom on the client is a
       download that 404s halfway through a check. Named at boot
       instead. */
    log("WARN", "updates: release.json names file(s) that are not uploaded: " +
      missing.map((f) => f.name).join(", "));
  }
  log("INFO", `updates: serving v${rel.version} (${(rel.files || []).length} file(s)), ` +
    `signed with key ${rel.keyFingerprint || "?"}`);
  return { enabled: true, version: rel.version };
}

function current() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, "release.json"), "utf8")); }
  catch (e) { return null; }
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
  return (rel.files || []).find((f) => f.name === name) || null;
}

const ROUTES_BY_NAME = { latest: ["GET"], file: ["GET"] };

async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "updates") return false;

  const { send, authorise } = helpers;
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

  const who = authorise(req);
  if (!who) {
    send(res, 401, { error: "a vault token is required",
      detail: "builds are not public. OUTPOST accounts cannot fetch updates yet." });
    return true;
  }

  const rel = current();
  if (!rel) {
    send(res, 503, { error: "no release has been uploaded to this relay",
      detail: "run `node build.js --release` on the SSD and upload data/updates/" });
    return true;
  }

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

  const abs = path.join(DIR, entry.name);
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
    send(res, 409, { error: "the uploaded file does not match the signed release",
      detail: "it was probably truncated or replaced. Re-upload data/updates/." });
    return true;
  }

  log("INFO", `updates: ${who} downloaded ${entry.name} (v${rel.version})`);
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

module.exports = { init, route, LIMITS, _internals: { fileNamed, current } };
