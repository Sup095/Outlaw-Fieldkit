/* ============================================================
   FieldKit relay
   Runs in a Pterodactyl container. Zero npm dependencies on
   purpose — a game-server container should not need an install
   step, and fewer moving parts means fewer things to break at
   2am on a school night.

   What it is:
     - an encrypted blob store the server cannot read
     - an AI proxy to LM Studio with priority failover
     - a read-only status surface

   What it deliberately is NOT:
     - anything that can restart or mutate a Bastion service.
       Per FIELDKIT_PROJECT.md §9C, mutating actions are
       tailnet-only and do not live behind the public Funnel.

   Auth model (§9C): the client derives authKey from the master
   password and sends it as a bearer token. We store only
   SHA-256(authKey), taken from the vault header the client
   uploaded. We never see the password or the data key, so the
   record bodies here are opaque ciphertext.
   ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const jf = require("./jsonfile");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const messaging = require("./messaging");
const browse = require("./browse");
const updates = require("./updates");
const browser = require("./browser-route");
const runner = require("./runner");
const { Fairness } = require("./fairness");
const { Overflow } = require("./overflow");

/* ---- config -------------------------------------------------- */
/* Where config.json is. FK_CONFIG wins; otherwise next to this file;
   otherwise the Pterodactyl server folder. The third case is the
   image that carries the relay's code in /opt/fieldkit/relay: the
   code is read-only there and config.json is the one file uploaded
   into /home/container. Same order start.js uses. */
const CONFIG_PATH = process.env.FK_CONFIG ||
  [path.join(__dirname, "config.json"), "/home/container/config.json"]
    .find((p) => fs.existsSync(p)) || path.join(__dirname, "config.json");

/* Data lives beside config.json, not beside the code. In the usual
   layout those are the same folder; in the image they are not, and
   the code's folder is read-only. */
const DEFAULT_DATA = path.join(path.dirname(CONFIG_PATH), "data");

const DEFAULTS = {
  port: 8080,
  host: "0.0.0.0",
  provisionToken: "",
  dataDir: DEFAULT_DATA,
  maxBodyBytes: 2 * 1024 * 1024,
  aiTargets: [],
  /* Read-only Bastion service probes surfaced at GET /status.
     Each entry: { name, url, kind?, note?, expectStatus? }
     The relay only ever issues a GET and reports the code — it has
     no route that can restart, stop, or otherwise touch any of
     these. Mutating actions stay tailnet-only (§9C). */
  statusServices: [],
  statusTimeoutMs: 4000,
  /* Accounts and end-to-end encrypted chat (§14.2). Off until it
     is turned on, because a relay that quietly accepts account
     registrations is a relay whose user list is whoever found it.

     `moderators` is the only way to become one. It is here rather
     than in the app because the vault and the messaging directory
     are separate identity systems on purpose — holding the full
     FieldKit build does not, and should not, prove anything to the
     messaging server about who you are. */
  messaging: {
    enabled: false,
    openRegistration: true,
    moderators: []
  },
  /* The in-app browser's proxy (§14.3). Off by default, because
     turning it on makes this relay fetch things on someone else's
     behalf and that should be a decision rather than a default.

     allowHosts empty means "anywhere public" — private and reserved
     address ranges are refused regardless and that is not
     configurable. Putting hosts in allowHosts turns it into an
     allow list, which is the right setting for a drive handed to
     someone else. blockHosts is subtracted either way. */
  browse: {
    enabled: false,
    allowHosts: [],
    blockHosts: []
  },
  /* Signed release downloads (FIELDKIT_PROJECT.md 14.4). Off by
     default. This relay never signs anything and is not asked
     whether a release is good — the client checks the signature
     against a public key that shipped inside the client, so a
     compromised relay can withhold an update but cannot forge one. */
  updates: {
    enabled: false
  },
  httpProxy: "",              // e.g. http://127.0.0.1:1055 for Tailscale userspace mode
  /* Whose X-Forwarded-For do we believe? Default: nobody. When the
     relay is directly internet-exposed, that header is attacker-
     controlled, and believing it lets anyone reset their own rate
     limit by sending a fresh fake IP on every request — including
     the limits protecting the unauthenticated GET /vault.
     Set to "loopback" when a tunnel (cloudflared, nginx) runs beside
     the relay in the same container, or list the proxy addresses. */
  trustProxy: false,
  /* Whitelisted quick actions (§9D). Each entry:
       { id, label, cmd, args?, note?, timeoutMs?, cooldownS? }
     The client sends an id and nothing else. It cannot pass
     arguments, cannot pass a command, and cannot compose one — the
     whole point is that the set of things this relay can do to a
     server is fixed in a file you edited, not derived from a
     request. Empty by default: an unconfigured relay has no
     ability to change anything.

     Every one of these is tailnet-only and that is not
     configurable. See onTailnet(). */
  actions: [],
  actionTimeoutMs: 20000,
  /* Extra tailnet peers beyond 100.64.0.0/10 and loopback — for
     the unusual case of a bastion reaching the relay over a
     private LAN leg rather than Tailscale. */
  extraTailnetIps: [],
  /* Counters only: which route, which AI target, how often. Never
     prompts, never record contents, never who. */
  usageLog: true,
  aiTimeoutMs: 120000,
  aiHealthTimeoutMs: 2500,
  /* ---- blob store (see LARGE-FILES.md) ----
     Records cannot carry a .blend or a 4K texture: they are JSON,
     so the ciphertext has to be base64'd (+33%) and the whole file
     has to exist in memory three times over. Blobs are the answer
     to that and nothing else — raw encrypted bytes, straight to
     disk, no parsing, no base64, one chunk per request.

     The relay still cannot read any of it. A blob is AES-GCM
     ciphertext with its IV prefixed; the key never leaves the
     browser. What the relay knows is a key, a length, and a date.

     blobMaxBytes is a per-chunk cap, not a per-file one — the
     client splits before it uploads, so file size is bounded by
     the quota rather than by this.

     blobQuotaBytes exists because a container disk is not
     elastic and a runaway upload loop should hit a clean 507
     rather than fill the volume and take the whole relay down
     with it. Set it below whatever the plan actually allows. */
  blobMaxBytes: 8 * 1024 * 1024,
  blobQuotaBytes: 2 * 1024 * 1024 * 1024,
  rateLimit: { windowMs: 60000, max: 240, authedMax: 3000, vaultMax: 10, authFailMax: 8,
    actionMax: 20, blobMax: 600, msgMax: 400, msgAuthMax: 10,
    /* One page pulls its stylesheet, its fonts and every image
       through here, so the ceiling has to be per-subresource
       generous. The ticket route is the opposite — it is the one a
       credential touches, and nobody needs more than a handful. */
    /* 600 was measured against a document, not against a site. One
       page of somewhere like crazygames is a couple of hundred
       requests on its own, so three pages a minute tripped it and the
       browser reported "slow down" in the middle of ordinary reading.
       The caller is not anonymous — a browse ticket is issued only in
       exchange for a vault token or a signed-in account — so this is
       sized to be a flood guard rather than a usage budget. */
    browseMax: 3000, browseTicketMax: 20, browseEngineMax: 4,
    /* The streamed browser: control requests, and socket opens. These
       were only ever in config.example.json, so a config written
       before them had no ceiling at all — and no ceiling compares as
       "already over it", which answered the very first request with
       429. A limit has to have a default here or it is a trap. */
    browserMax: 60, browserStreamMax: 12,
    /* RUNNER asks the relay for a status and a ticket and nothing
       else, so this is small. */
    runnerMax: 60,
    /* A build is one big download, not many small ones, and a
       check is one small GET. Neither needs headroom. */
    updateMax: 30 }
};

/* A missing config.json and a BROKEN one are completely different
   situations, and treating them the same cost an afternoon.

   Missing is the first-run state: defaults, with a warning, and the
   relay comes up so you can see it working. Broken is a typo in a
   file somebody wrote on purpose — and falling back to defaults
   there is the worst possible response, because every setting
   silently reverts at once. Messaging turns off. The tunnel does
   not start, so the relay is unreachable anyway. trustProxy drops
   to false. The provision token disappears. None of that looks like
   "line 89 has a typo"; it looks like FieldKit is broken.

   So: broken config, with a config file present, stops here and
   says where. A relay that will not start is a five-minute fix. A
   relay running a configuration nobody chose is not. */
let config = Object.assign({}, DEFAULTS);
let configText = null;
try { configText = fs.readFileSync(CONFIG_PATH, "utf8"); }
catch (e) {
  console.error("[relay] no config.json — using defaults.");
  console.error("[relay] copy config.example.json to config.json before exposing this.");
}

if (configText !== null) {
  let raw;
  try { raw = JSON.parse(configText); }
  catch (e) {
    /* JSON.parse gives a character offset. Turning it into a line
       and column is the difference between "go and look" and "go and
       look at line 89". */
    const at = /position (\d+)/.exec(e.message);
    let where = "";
    if (at) {
      const before = configText.slice(0, Number(at[1]));
      const line = before.split("\n").length;
      const col = before.length - before.lastIndexOf("\n");
      where = " at line " + line + ", column " + col;
      const src = configText.split("\n")[line - 1] || "";
      where += "\n[relay]   " + src.trim();
    }
    console.error("");
    console.error("[relay] ==============================================");
    console.error("[relay] config.json is not valid JSON" + where);
    console.error("[relay] " + e.message);
    console.error("[relay]");
    console.error("[relay] Refusing to start rather than falling back to defaults —");
    console.error("[relay] that would silently turn off messaging, the tunnel, and");
    console.error("[relay] every other setting in this file at once, which does not");
    console.error("[relay] look like a typo when you go looking for the cause.");
    console.error("[relay]");
    console.error("[relay] Common causes: an unquoted string (moderators must be");
    console.error("[relay] [\"name\"], not [name]), a trailing comma, or a comment.");
    console.error("[relay] ==============================================");
    console.error("");
    process.exit(1);
  }
  config = Object.assign({}, DEFAULTS, raw);
  config.rateLimit = Object.assign({}, DEFAULTS.rateLimit, raw.rateLimit || {});
  config.messaging = Object.assign({}, DEFAULTS.messaging, raw.messaging || {});
  config.browse = Object.assign({}, DEFAULTS.browse, raw.browse || {});
  config.updates = Object.assign({}, DEFAULTS.updates, raw.updates || {});
}

/* Pterodactyl allocates a port per server and injects it as
   SERVER_PORT — that is the port actually wired through to the
   outside world, regardless of what config.json says. Prefer it
   so a mismatched config can never cause a silent bind failure.
   Host stays 0.0.0.0: SERVER_IP is the externally-visible address,
   not something bindable from inside the container's netns. */
if (process.env.SERVER_PORT) config.port = Number(process.env.SERVER_PORT);

const DATA_DIR = path.resolve(config.dataDir);
const RECORDS_DIR = path.join(DATA_DIR, "records");
const BLOBS_DIR = path.join(DATA_DIR, "blobs");
const VAULT_PATH = path.join(DATA_DIR, "vault.json");
fs.mkdirSync(RECORDS_DIR, { recursive: true });
fs.mkdirSync(BLOBS_DIR, { recursive: true });

/* ---- logging ------------------------------------------------- */
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

/* ---- rate limiting ------------------------------------------- */
/* In-memory sliding window. Resets on restart, which is fine —
   this is abuse damping, not a security boundary. */
const buckets = new Map();

function hit(key, max) {
  const now = Date.now();
  const win = config.rateLimit.windowMs;
  let b = buckets.get(key);
  if (!b || now - b.start > win) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  return b.count <= max;
}

setInterval(() => {
  const cutoff = Date.now() - config.rateLimit.windowMs * 2;
  for (const [k, b] of buckets) if (b.start < cutoff) buckets.delete(k);
}, 60000).unref();

/* ---- who is actually calling --------------------------------- */
/* Rate limiting is only as good as this function. A forwarded-for
   header from an untrusted peer is a claim, not a fact, so it is
   ignored unless the peer is a proxy we put there ourselves. */
function normaliseIp(ip) {
  ip = String(ip || "").trim();
  if (ip.indexOf("::ffff:") === 0) ip = ip.slice(7);   // IPv4-mapped IPv6
  return ip;
}

function isLoopback(ip) {
  ip = normaliseIp(ip);
  return ip === "127.0.0.1" || ip === "::1" || ip.indexOf("127.") === 0;
}

function peerIsTrusted(req) {
  const peer = normaliseIp(req.socket.remoteAddress);
  const t = config.trustProxy;
  if (!t) return false;
  if (t === true) return true;
  if (t === "loopback") return isLoopback(peer);
  if (Array.isArray(t)) return t.map(normaliseIp).indexOf(peer) >= 0;
  return false;
}

/* ---- the tailnet gate ----------------------------------------
   §9D: anything that changes a server's state is tailnet-only. The
   public Funnel leg carries read-only status, AI and data sync,
   and nothing else.

   This reads req.socket.remoteAddress and NOTHING ELSE. Not
   clientIp(), not a header, not even a header from a peer we
   otherwise trust — because the trusted proxy IS the public leg.
   A cloudflared tunnel running on loopback is a legitimate proxy
   for rate-limiting purposes and an illegitimate one here: every
   request arriving through it came from the internet, whatever
   X-Forwarded-For says. The socket cannot be forged from the far
   side of a tunnel, so the socket is the only thing asked.

   Tailscale hands out addresses in 100.64.0.0/10 (the CGNAT
   range), and fd7a:115c:a1e0::/48 on the v6 side.

   A TRUSTED PROXY IS NEVER THE TAILNET. This started as a special
   case about loopback: cloudflared runs beside the relay and
   connects to it from 127.0.0.1, so trusting loopback with a tunnel
   configured hands the whole internet the kill switch.

   But loopback was only ever an instance of the general rule, and
   writing it as a special case left the same hole open one address
   over. `trustProxy` also accepts an array, and a reverse proxy on
   a Tailscale address (nginx on the bastion at 100.64.0.9, say) is
   an ordinary deployment. That peer is in 100.64.0.0/10, so the
   range check waved it straight through — and everything it
   forwards came from the public internet.

   So the rule is now stated once, generally: a peer whose
   forwarded-for headers we are willing to believe is by definition
   a public ingress, whatever its address. peerIsTrusted() already
   encodes exactly that, so onTailnet() asks it first and refuses.
   Turning on a tunnel closes this door by itself rather than
   requiring somebody to remember a second switch. */
function isTailnetIp(ip) {
  ip = normaliseIp(ip);
  if (!ip) return false;
  if (isLoopback(ip)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(ip);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10
  }
  if (/^fd7a:115c:a1e0:/i.test(ip)) return true;         // Tailscale ULA range
  const extra = Array.isArray(config.extraTailnetIps) ? config.extraTailnetIps : [];
  return extra.map(normaliseIp).indexOf(ip) >= 0;
}

function onTailnet(req) {
  /* The general rule, before any address matching: if we would
     believe this peer's forwarded-for header, it is a proxy, and a
     proxy is the public leg. */
  if (peerIsTrusted(req)) return false;
  return isTailnetIp(req.socket.remoteAddress);
}

function clientIp(req) {
  const peer = normaliseIp(req.socket.remoteAddress) || "unknown";
  if (!peerIsTrusted(req)) return peer;

  /* Cloudflare's own header is the true client and cannot be
     appended to by the caller the way X-Forwarded-For can. */
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return normaliseIp(String(cf).split(",")[0]);

  const fwd = req.headers["x-forwarded-for"];
  if (fwd) {
    const first = normaliseIp(String(fwd).split(",")[0]);
    if (first) return first;
  }
  return peer;
}

/* ---- usage counters (§9 Relay/AI extras) -------------------------------------
   "How often does the AI tier actually get used" is a fun number
   and a genuinely useful one — it is the difference between
   knowing the fallback chain works and hoping it does.

   Counters only. No prompts, no message contents, no record ids,
   no client addresses. What goes in this file could be printed on
   a poster. That constraint is what makes it safe to leave running
   forever and safe to show anybody.

   Persisted on a timer rather than on every request, because
   fsync-ing a stats file on the hot path to save a number nobody
   will read for a week is a bad trade. A restart loses at most the
   last thirty seconds of counting, which for a fun stat is fine —
   and the file records lastFlush so the gap is visible rather
   than pretended away. */
const USAGE_PATH = path.join(DATA_DIR, "usage.json");
const USAGE_VERSION = 1;

function blankUsage() {
  return {
    v: USAGE_VERSION,
    since: new Date().toISOString(),
    lastFlush: null,
    restarts: 0,
    routes: {},        // "GET /status" -> n
    ai: {
      requests: 0,
      byTarget: {},    // target name -> { ok, failed, totalMs }
      fellBack: 0,     // a request that had to try more than one target
      exhausted: 0     // every target failed
    },
    actions: {},       // action id -> { ok, failed, refused }
    days: {}           // "2026-08-12" -> total requests
  };
}

let usage = blankUsage();
let usageDirty = false;

(function loadUsage() {
  if (!config.usageLog) return;
  const prior = readJson(USAGE_PATH);
  if (prior && prior.v === USAGE_VERSION) {
    usage = Object.assign(blankUsage(), prior);
    usage.ai = Object.assign(blankUsage().ai, prior.ai || {});
    usage.restarts = (Number(prior.restarts) || 0) + 1;
    usageDirty = true;
  }
})();

/* The routes this relay actually has. A counter key is only ever
   one of these — see routeKey(). */
const KNOWN_ROUTES = ["health", "status", "vault", "records", "blobs", "actions", "usage", "ai", "msg", "browser"];

/* A counter key must never be attacker-controlled.

   The first version built the key from the request path, collapsing
   only the segments after the first. That meant `GET /<8000 chars>`
   minted a permanent 8 KB key in a map with no cap — unauthenticated,
   surviving restart through usage.json, re-serialised synchronously
   by the flush timer every 30 seconds, and echoed back verbatim on
   the operator's own usage panel. A stats counter is not worth a
   memory leak, let alone one a stranger can drive.

   So the shape is decided here, from a fixed list, and anything
   unrecognised collapses into a single bucket. The key space is now
   bounded by the route table, which is a constant. */
function routeKey(method, pathname) {
  const segs = String(pathname).replace(/^\/+|\/+$/g, "").split("/");
  const first = segs[0] || "root";
  if (KNOWN_ROUTES.indexOf(first) < 0) return method + " /(unrecognised)";
  return method + " /" + first + (segs.length > 1 ? "/:x" : "");
}

function bump(path1, path2) {
  if (!config.usageLog) return;
  usageDirty = true;
  if (path2 === undefined) {
    usage.routes[path1] = (usage.routes[path1] || 0) + 1;
    const day = new Date().toISOString().slice(0, 10);
    usage.days[day] = (usage.days[day] || 0) + 1;
    /* Ninety days is plenty for a fun stat and keeps the file from
       growing without bound on a relay nobody ever restarts. */
    const keys = Object.keys(usage.days).sort();
    while (keys.length > 90) delete usage.days[keys.shift()];
    return;
  }
  const bucket = usage[path1] || (usage[path1] = {});
  bucket[path2] = (bucket[path2] || 0) + 1;
}

function noteAiCall(targetName, ok, ms) {
  if (!config.usageLog) return;
  usageDirty = true;
  const t = usage.ai.byTarget[targetName] ||
    (usage.ai.byTarget[targetName] = { ok: 0, failed: 0, totalMs: 0 });
  /* Only successful calls contribute to totalMs, because avgMs is
     reported over the success count. Folding in the time a failed
     call spent timing out would inflate the average with latency
     nobody actually waited for an answer through. */
  if (ok) { t.ok++; t.totalMs += Math.max(0, Number(ms) || 0); }
  else t.failed++;
}

/* Same rule as routeKey(): a counter key is never taken from a
   request. A refused action id comes straight out of the body, and
   the body may be 2 MB — so an id that is not a configured action
   is counted under one fixed bucket rather than under itself. The
   whole point of the refusal path is that a non-whitelisted id is
   inert; a persistent side effect would contradict that. */
const ACTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function noteAction(id, outcome) {
  if (!config.usageLog) return;
  usageDirty = true;
  const known = (Array.isArray(config.actions) ? config.actions : [])
    .some((a) => a && a.id === id);
  const key = known && ACTION_ID_RE.test(id) ? id : "(unrecognised)";
  const a = usage.actions[key] || (usage.actions[key] = { ok: 0, failed: 0, refused: 0 });
  if (a[outcome] !== undefined) a[outcome]++;
}

function flushUsage() {
  if (!config.usageLog || !usageDirty) return;
  usage.lastFlush = new Date().toISOString();
  try {
    writeJsonAtomic(USAGE_PATH, usage);
    usageDirty = false;
  } catch (e) {
    log("WARN", `could not write usage.json: ${e.message}`);
  }
}
setInterval(flushUsage, 30000).unref();

/* ---- helpers ------------------------------------------------- */
/* A file:// page sends `Origin: null`. We must accept it, which
   means CORS cannot be the security boundary — the bearer token
   is. Every mutating route checks auth, no exceptions. */
function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-FieldKit-Provision");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
}

function send(res, status, body, headers) {
  const payload = body === null || body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }, headers || {}));
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > config.maxBodyBytes) {
        /* Stop buffering, but do NOT destroy the socket here. The
           rejection reaches the handler on a later microtask, and a
           destroyed socket silently swallows the 413 that the
           handler then writes — the client sees a connection reset
           and cannot tell "this one record is too big" from "the
           relay is down". It then retries the same oversized record
           forever. Dropping further chunks costs a little bandwidth
           and buys an answer the client can act on. */
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(Object.assign(new Error("malformed JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

/* Raw body, for blobs. Deliberately a separate function from
   readBody(): that one parses JSON and caps at maxBodyBytes, and
   blobs are neither JSON nor that small. Same no-destroy rule
   though — the 413 has to survive long enough to be written, or
   the client cannot tell "this chunk is too big" from "the relay
   fell over" and will retry the same chunk forever. */
function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > cap) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(
          new Error(`blob is larger than blobMaxBytes (${cap} bytes)`), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

/* Blob keys are client-generated, become filenames, and are the
   only thing standing between a request and the filesystem. Hex
   only, fixed length band, no dots — same posture as record ids
   but stricter, because there is no JSON layer behind this to
   fail safely on a weird name. */
const BLOB_KEY_RE = /^[a-f0-9]{32,64}$/;
function validBlobKey(k) { return typeof k === "string" && BLOB_KEY_RE.test(k); }
function blobPath(key) {
  const p = path.join(BLOBS_DIR, key + ".bin");
  if (path.dirname(p) !== BLOBS_DIR) throw new Error("path escape attempt");
  return p;
}

/* Walked on demand rather than kept in a counter, because a counter
   drifts the moment anything touches the directory out of band —
   a restore, a manual delete, a half-finished upload. Reading the
   directory is O(files) and this is not a hot path. */
function blobUsage() {
  let bytes = 0, count = 0;
  let names = [];
  try { names = fs.readdirSync(BLOBS_DIR); } catch (e) { return { bytes: 0, count: 0 }; }
  for (const f of names) {
    if (!f.endsWith(".bin")) continue;
    try { bytes += fs.statSync(path.join(BLOBS_DIR, f)).size; count++; }
    catch (e) { /* vanished mid-walk; not our problem */ }
  }
  return { bytes, count };
}

/* Record ids come from the client. They become filenames, so they
   are validated strictly rather than sanitised — anything that is
   not plain hex/base36 is refused outright. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function validId(id) {
  return typeof id === "string" && ID_RE.test(id) && id.indexOf(".") < 0;
}
function recordPath(id) {
  const p = path.join(RECORDS_DIR, id + ".json");
  if (path.dirname(p) !== RECORDS_DIR) throw new Error("path escape attempt");
  return p;
}

/* jsonfile.js: a damaged file reads as missing here, loudly. The vault
   header is read with readStrict: a damaged header read as "missing"
   would invite provisioning a new vault over the old one. */
function readJson(file) {
  return jf.readSoft(file, null, (e) => log("ERROR", e.message));
}
function readStrict(file) {
  try { return jf.read(file, null); }
  catch (e) { if (e.damaged) log("ERROR", e.message); throw e; }
}

/* Write to a temp file then rename, so a crash or a yanked drive
   cannot leave a half-written record behind. */
function writeJsonAtomic(file, obj) { jf.write(file, obj); }

/* ---- auth ---------------------------------------------------- */
function loadVault() { return readStrict(VAULT_PATH); }

function constantTimeEqual(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* The client sends hex(authKey). The vault header carries
   base64(SHA-256(authKey)). Hash what we were given and compare. */
function checkAuth(req) {
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+([A-Fa-f0-9]{16,256})$/.exec(header.trim());
  if (!m) return { ok: false, reason: "missing or malformed bearer token" };

  let vault;
  try { vault = loadVault(); } catch (e) { return { ok: false, reason: "the vault header on the relay is damaged" }; }
  if (!vault || !vault.authKeyHash) return { ok: false, reason: "no vault provisioned" };

  let digest;
  try { digest = crypto.createHash("sha256").update(Buffer.from(m[1], "hex")).digest("base64"); }
  catch (e) { return { ok: false, reason: "token not decodable" }; }

  if (constantTimeEqual(digest, vault.authKeyHash)) return { ok: true, via: "password" };

  /* The recovery key is a second credential of equal power — it
     unwraps the same master key, so it already grants full access
     to the plaintext. Refusing it here did not protect anything; it
     just meant that forgetting your password cost you the relay
     permanently, because setting a new one requires uploading a
     header, and uploading a header requires a token you no longer
     had. Vaults created before this field exists simply do not have
     it, and fall through to the rejection below. */
  if (vault.recoveryAuthKeyHash &&
      constantTimeEqual(digest, vault.recoveryAuthKeyHash)) {
    return { ok: true, via: "recovery" };
  }

  return { ok: false, reason: "token rejected" };
}

function requireAuth(req, res) {
  const ip = clientIp(req);
  const r = checkAuth(req);
  if (!r.ok) {
    if (!hit("authfail:" + ip, config.rateLimit.authFailMax)) {
      log("WARN", `auth failures throttled for ${ip}`);
      send(res, 429, { error: "too many failed attempts" });
      return false;
    }
    log("WARN", `auth rejected from ${ip}: ${r.reason}`);
    send(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

/* ---- upstream requests --------------------------------------- */
/* Built on raw http.request rather than fetch, because Tailscale in
   a Pterodactyl container has to run in userspace-networking mode
   (no /dev/net/tun, no NET_ADMIN in an unprivileged container). In
   that mode Tailscale gives you a local HTTP proxy instead of a
   network interface, and Node's global fetch cannot be pointed at a
   proxy without pulling in a dependency. Speaking HTTP proxy
   protocol directly costs about ten lines and keeps the zero-
   dependency promise.

   Absolute-form request URIs ("GET http://host/path HTTP/1.1") are
   how you talk to a forward proxy. Only plain-HTTP upstreams are
   supported through a proxy — an HTTPS upstream would need CONNECT
   tunnelling, which LM Studio does not require. */
/* A status response travels to a client that may be on a school
   network. Credentials and query strings in a configured URL are not
   part of what "is it up" needs to say, so they are stripped. */
function redactUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol + "//" + p.host + p.pathname;
  } catch (e) {
    return "(unparseable url)";
  }
}

function upstreamRequest(method, urlStr, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(urlStr); }
    catch (e) { return reject(new Error("bad target url: " + urlStr)); }

    const proxy = config.httpProxy ? new URL(config.httpProxy) : null;
    if (proxy && target.protocol === "https:") {
      return reject(new Error("https upstreams through a proxy need CONNECT, which is not implemented"));
    }

    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), "utf8");
    const headers = { "Accept": "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }

    let opts;
    if (proxy) {
      headers["Host"] = target.host;
      opts = {
        host: proxy.hostname,
        port: proxy.port || 80,
        method,
        path: target.toString(),          // absolute-form, required by forward proxies
        headers
      };
    } else {
      opts = {
        host: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method,
        path: target.pathname + target.search,
        headers
      };
    }

    const lib = (!proxy && target.protocol === "https:") ? require("https") : http;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error("upstream response too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error("upstream timed out after " + timeoutMs + "ms")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---- AI proxy ------------------------------------------------ */
const targetHealth = new Map();

/* ---- why a target cannot be reached ---------------------------
   "DOWN" is not a diagnosis. The AI leg fails for a handful of
   completely different reasons and they have completely different
   fixes — LM Studio not started, LM Studio started but not serving
   on the network, an address this container could never route to,
   or a tunnel that is not up. Reporting all of them as DOWN sends
   people to restart LM Studio when the real answer is that a
   hosted container cannot reach 192.168.x.x on their home LAN and
   never will.

   These two are the ones that are hopeless rather than merely
   failing, and they are visible from the address alone. */
/* Loopback is deliberately NOT in here. 127.x from the relay's
   point of view means "inside this container", which is somewhere
   it can genuinely reach — a tunnel endpoint, or a model running
   beside it. Lumping it in with the LAN ranges produced the
   confidently wrong advice "put that PC on Tailscale" about the
   container's own loopback. It gets a real probe instead. */
const RFC1918 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/* Returns extra context for a probe that ALREADY FAILED. It never
   decides on its own that a target is unreachable.

   The first draft of this refused to probe a private address at
   all, on the reasoning that a hosted container cannot see a home
   LAN. That reasoning is wrong often enough to matter: plenty of
   people run the relay on a box sitting on the same LAN as the PC,
   and for them 192.168.x.x is correct and works. Pre-judging it
   would have reported a working target as unreachable and sent
   them to fix something that was never broken — which is the exact
   failure mode this whole classifier exists to remove.

   So: always probe, and use the address only to explain a failure
   that actually happened. A wrong IP and an unroutable network
   look identical on the wire; the difference is in the advice. */
function addressNote(t) {
  let host;
  try { host = new URL(t.url).hostname; }
  catch (e) { return "this is not a valid URL"; }

  const viaProxy = !!config.httpProxy;

  if (CGNAT.test(host) || /\.ts\.net$/i.test(host)) {
    if (!viaProxy) {
      return "this is a Tailscale address and httpProxy is empty, so the relay has no " +
             "route onto the tailnet. Either start Tailscale (MAIN_FILE=start.js with " +
             "TS_AUTHKEY set) and set httpProxy to http://127.0.0.1:1055, or use an " +
             "address that is reachable without it.";
    }
    return "";
  }

  if (RFC1918.test(host)) {
    return "this is a private LAN address, so it only works if the relay is on that same " +
           "network. If it is, check the IP is still correct — LM Studio's address changes " +
           "when DHCP reassigns it. If it is not, put the PC on Tailscale and use its " +
           "100.x address.";
  }

  return "";
}

/* Node's error codes, translated once, here, rather than shown raw
   to somebody on a Chromebook with no way to look them up. */
function explainProbeError(e) {
  const code = e && e.code ? String(e.code) : "";
  const msg = String((e && e.message) || "");
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) {
    return { kind: "refused",
      hint: "something answered instantly with 'no'. The address is right and reachable, " +
            "but nothing is listening on that port — LM Studio is not running, or its " +
            "server is off. In LM Studio: Developer tab, Start Server." };
  }
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/.test(msg)) {
    return { kind: "dns", hint: "the hostname does not resolve from inside the container." };
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || /UNREACH/.test(msg)) {
    return { kind: "unroutable",
      hint: "there is no route to that address from this container at all." };
  }
  if (/timed out|ETIMEDOUT/i.test(msg) || code === "ETIMEDOUT") {
    return { kind: "timeout",
      hint: "the packets went nowhere and the probe waited out its timeout. That is what a " +
            "firewall dropping traffic looks like, and also what an address on a network " +
            "this container cannot see looks like." };
  }
  if (/ECONNRESET/.test(msg) || code === "ECONNRESET") {
    return { kind: "reset", hint: "the connection was opened and then dropped." };
  }
  return { kind: "error", hint: msg };
}

async function probeTarget(t) {
  try {
    const r = await upstreamRequest("GET", t.url.replace(/\/$/, "") + "/v1/models",
      undefined, config.aiHealthTimeoutMs);
    const ok = r.status >= 200 && r.status < 400;
    targetHealth.set(t.name, {
      ok, at: Date.now(), status: r.status,
      kind: ok ? "ok" : "http",
      hint: ok ? "" :
        (r.status === 404
          ? "reached it, but /v1/models is not there. That port is serving something " +
            "other than an OpenAI-compatible API."
          : "reached it and got HTTP " + r.status + ".")
    });
    return ok;
  } catch (e) {
    const why = explainProbeError(e);
    /* The address note is appended to a failure, never used to
       predict one. A wrong IP and an unroutable network produce the
       same timeout; only the advice differs. */
    const note = addressNote(t);
    targetHealth.set(t.name, {
      ok: false, at: Date.now(), kind: why.kind,
      hint: note ? why.hint + " " + note : why.hint,
      error: e.message
    });
    return false;
  }
}

/* Priority order, first healthy target wins. §9D: local PC is
   default, main PC over Tailscale is the fallback. */
function orderedTargets() {
  return config.aiTargets.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

async function pickTarget(preferred) {
  const list = orderedTargets();
  if (preferred) {
    const p = list.find((t) => t.name === preferred);
    if (p && await probeTarget(p)) return p;
  }
  for (const t of list) {
    if (await probeTarget(t)) return t;
  }
  return null;
}

async function proxyChat(req, res, body) {
  if (config.usageLog) { usage.ai.requests++; usageDirty = true; }
  const target = await pickTarget(body && body.__target);
  if (!target) {
    if (config.usageLog) usage.ai.exhausted++;
    send(res, 503, {
      error: "no AI target reachable",
      targets: orderedTargets().map((t) => ({ name: t.name, health: targetHealth.get(t.name) || null }))
    });
    return;
  }

  /* "Fell back" means the request did not land on the first-choice
     target. Worth counting on its own: a relay that quietly serves
     everything from the second-best model for a month is the kind
     of thing you only notice when you go looking. */
  const first = orderedTargets()[0];
  if (config.usageLog && first && first.name !== target.name) usage.ai.fellBack++;

  const payload = Object.assign({}, body);
  delete payload.__target;

  const started = Date.now();
  try {
    const upstream = await upstreamRequest("POST",
      target.url.replace(/\/$/, "") + "/v1/chat/completions", payload, config.aiTimeoutMs);
    noteAiCall(target.name, upstream.status >= 200 && upstream.status < 400,
      Date.now() - started);
    log("INFO", `ai -> ${target.name} (${upstream.status})`);
    res.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-FieldKit-Target": target.name
    });
    res.end(upstream.text);
  } catch (e) {
    noteAiCall(target.name, false, Date.now() - started);
    log("ERROR", `ai proxy to ${target.name} failed: ${e.message}`);
    send(res, 502, { error: "upstream failed", target: target.name, detail: e.message });
  }
}

/* ---- whitelisted actions --------------------------------------
   The safety property here is structural, not careful: spawn() is
   called with a command and an array of arguments, both read from
   config.json, and `shell` is never set. With no shell there is no
   parsing, so there is nothing for a semicolon or a backtick to
   escape into — argument strings reach the process as literal
   argv entries whatever is in them.

   The request contributes an id and nothing else. Not a flag, not
   a server name, not a numeric limit. The moment a caller can put
   any part of a command line together, the whitelist has stopped
   being a whitelist and this becomes a remote shell with extra
   steps. If a variant is needed, it is a second entry in the
   config file. */
const actionLastRun = new Map();

function actionReady(a) {
  const last = actionLastRun.get(a.id);
  if (!last) return true;
  const cool = (Number(a.cooldownS) || 0) * 1000;
  return Date.now() - last >= cool;
}

function runAction(a) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (!a.cmd || typeof a.cmd !== "string") {
      return resolve({ ok: false, id: a.id, ms: 0,
        error: "this action has no cmd in config.json" });
    }
    const args = (Array.isArray(a.args) ? a.args : []).map(String);
    const timeout = Number(a.timeoutMs) || config.actionTimeoutMs;

    let child;
    try {
      child = spawn(a.cmd, args, {
        shell: false,          /* load-bearing — see the note above */
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      return resolve({ ok: false, id: a.id, ms: Date.now() - started,
        error: "could not start: " + e.message });
    }

    /* Output is capped. An action that decides to cat a log file
       forever should not be able to grow the relay's heap. */
    const CAP = 16 * 1024;
    let out = "", err = "", truncated = false;
    function collect(which, chunk) {
      const s = chunk.toString("utf8");
      if (which === "out") {
        if (out.length + s.length > CAP) { truncated = true; out = (out + s).slice(0, CAP); }
        else out += s;
      } else {
        if (err.length + s.length > CAP) { truncated = true; err = (err + s).slice(0, CAP); }
        else err += s;
      }
    }
    child.stdout.on("data", (c) => collect("out", c));
    child.stderr.on("data", (c) => collect("err", c));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
      settle({ ok: false, error: `timed out after ${timeout}ms` });
    }, timeout);

    function settle(extra) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign({
        id: a.id, label: a.label || a.id, ms: Date.now() - started,
        stdout: out, stderr: err, truncated
      }, extra));
    }

    child.on("error", (e) => settle({ ok: false, error: e.message }));
    child.on("close", (code) => settle({ ok: code === 0, exitCode: code,
      error: code === 0 ? null : `exited with code ${code}` }));
  });
}

/* ---- routes -------------------------------------------------- */
/* Kept beside the router and served on a 404 and at boot. It is a
   hand-maintained list, which is a cost — but the thing it buys is
   that "no such route" and the startup banner both describe the
   build that is actually running, rather than the build the docs
   describe. Those drifted apart once already. */
const ROUTES = [
  "GET  /health",
  "GET  /vault", "POST /vault", "PUT  /vault",
  "GET  /records", "GET/PUT/DELETE /records/:id",
  "GET  /blobs", "GET/PUT/DELETE /blobs/:key",
  "GET  /status",
  "GET  /ai/targets", "POST /ai/chat",
  "GET  /actions", "POST /actions",
  "GET  /usage",
  "POST /msg/register", "POST /msg/login", "POST /msg/logout",
  "GET  /msg/users", "GET/POST /msg/conv", "POST /msg/send", "GET  /msg/poll",
  "POST /msg/rotate", "POST /msg/report",
  "GET  /msg/reports", "GET  /msg/review", "POST /msg/resolve", "GET  /msg/signins",
  "GET  /msg/people", "POST /msg/role",
  "POST /browse/ticket", "GET  /browse/get", "GET  /browse/check",
  "GET  /browser/status", "POST /browser/ticket", "POST /browser/clear", "GET  /browser/helper-key",
  "GET  /runner/status", "POST /runner/ticket", "GET  /runner/pubkey",
  "WS   /browser/stream",
  "GET  /updates/latest", "GET  /updates/file"
];

async function route(req, res, url) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const method = req.method;

  /* Messaging owns /msg/* entirely and lives in its own file. It
     gets the same CORS and body cap as everything else — those
     happen upstream of here — plus two limits of its own.

     The split matters. A long poll re-arms every 25 seconds and an
     active conversation is chatty, so the general messaging limit
     has to be generous. Registration and login are the opposite:
     guessing is the entire attack, and a low ceiling there costs a
     legitimate user nothing because nobody logs in ten times a
     minute. Sharing one number would have meant choosing which of
     those two to get wrong. */
  if (seg[0] === "msg") {
    const authish = seg[1] === "login" || seg[1] === "register";
    const key = (authish ? "msgauth:" : "msg:") + clientIp(req);
    const cap = authish ? config.rateLimit.msgAuthMax : config.rateLimit.msgMax;
    if (!hit(key, cap)) {
      return send(res, 429, { error: "slow down",
        detail: authish ? "too many login or registration attempts" : "too many messaging requests" });
    }
  }
  if (await messaging.route(req, res, url, { send, readBody, clientIp })) return;

  /* The browser proxy (§14.3). Same shape as /msg/*: its own file,
     its own limits, the shared CORS and body cap from upstream.

     `authorise` is passed in rather than browse.js reaching for
     either credential itself. Two different identity systems answer
     here — the vault token for the full build, a signed-in
     messaging account for OUTPOST, which has no vault — and keeping
     the decision in one place is what stops a third one appearing
     by accident. */
  if (seg[0] === "browse") {
    /* Three buckets, because these routes cost wildly different
       amounts. One page is hundreds of proxied requests, so that cap
       is high. A ticket is one cheap call nobody needs many of. And
       /browse/engines fetches eight sites in one request — the most
       expensive thing this relay can be asked to do, and the easiest
       to hold down as a way of making the relay hammer somebody. */
    const bucket = seg[1] === "ticket" ? "browseticket"
      : seg[1] === "engines" ? "browseengine" : "browse";
    const cap = bucket === "browseticket" ? config.rateLimit.browseTicketMax
      : bucket === "browseengine" ? config.rateLimit.browseEngineMax
      : config.rateLimit.browseMax;
    if (!hit(bucket + ":" + clientIp(req), cap)) {
      return send(res, 429, { error: "slow down", detail:
        bucket === "browseticket" ? "too many browse tickets requested"
        : bucket === "browseengine" ? "the engine check fetches eight sites; wait a minute"
        : "too many proxied requests" });
    }
    const authorise = (r) => {
      if (checkAuth(r).ok) return "vault";
      const me = messaging.whoami(r);
      if (me && me.handle && !me.banned) return "msg:" + me.handle;
      return null;
    };
    if (await browse.route(req, res, url, { send, readBody, clientIp, authorise })) return;
  }

  /* THE STREAMED BROWSER (§14.11).

     Deliberately a small number of cheap routes. The expensive
     thing — a page, with its couple of hundred subresources —
     happens inside the container and never reaches the limiter at
     all, which is the entire reason this replaced the proxy. What
     is left here is a status read, a ticket, and a clear.

     Same authorise() as /browse: a messaging account or a vault
     token. One account for both apps, which is what makes "your
     cookies" mean anything. */
  if (seg[0] === "browser") {
    if (!hit("browser:" + clientIp(req), config.rateLimit.browserMax)) {
      return send(res, 429, { error: "slow down", detail: "too many browser control requests" });
    }
    const authorise = (r) => {
      if (checkAuth(r).ok) return "vault";
      const me = messaging.whoami(r);
      if (me && me.handle && !me.banned) return "msg:" + me.handle;
      return null;
    };
    /* The vault holder owns this relay: admin. Otherwise the account's tier. */
    const tierOf = (r) => (checkAuth(r).ok ? "admin" : ((messaging.whoami(r) || {}).tier || "guest"));
    if (await browser.route(req, res, url, { send, readBody, clientIp, authorise, tierOf })) return;
  }

  /* RUNNER (RUNNER_PLAN.md). The relay's whole part is saying who
     somebody is; the files and the output go straight to the run
     server and never through here. */
  if (seg[0] === "runner") {
    if (!hit("runner:" + clientIp(req), config.rateLimit.runnerMax)) {
      return send(res, 429, { error: "slow down", detail: "too many runner requests" });
    }
    if (await runner.route(req, res, url, { send, readBody, clientIp })) return;
  }

  /* Updates (14.4). Vault token only — a signed build is for the
     people who own this, and a messaging session is not that. The
     relay is deliberately not part of the trust chain here: it
     serves what was uploaded and the client verifies the signature
     itself, so this needs no key and is given none. */
  if (seg[0] === "updates") {
    if (!hit("update:" + clientIp(req), config.rateLimit.updateMax)) {
      return send(res, 429, { error: "slow down", detail: "too many update requests" });
    }
    const authorise = (r) => (checkAuth(r).ok ? "vault" : null);
    if (await updates.route(req, res, url, { send, readBody, clientIp, authorise })) return;
  }

  /* --- health: public, deliberately says almost nothing --- */
  if (seg[0] === "health" && method === "GET") {
    /* A damaged header still counts as provisioned: "not provisioned"
       would invite setting up a new vault over it. */
    let vault;
    try { vault = loadVault(); } catch (e) { vault = { damaged: true }; }
    return send(res, 200, {
      service: "fieldkit-relay",
      version: 1,
      up: true,
      vaultProvisioned: !!vault,
      /* Lets a client tell an old relay from a new one without
         probing an authenticated route and reading 404 vs 401.
         Names only — no sizes, no counts, nothing about content. */
      features: ["records", "blobs", "actions", "usage", "ai"],
      time: new Date().toISOString()
    });
  }

  /* --- status: read-only Bastion service probes ---
     Authenticated, because the service list is a map of the internal
     network and there is no reason to hand that to the internet.
     Strictly GET-and-report: nothing here can change a service's
     state, by design (§9C). */
  if (seg[0] === "status" && method === "GET") {
    if (!requireAuth(req, res)) return;

    const services = Array.isArray(config.statusServices) ? config.statusServices : [];
    const checked = await Promise.all(services.map(async (s) => {
      const started = Date.now();
      const base = {
        name: s.name || s.url, kind: s.kind || "http",
        note: s.note || "", url: redactUrl(s.url)
      };
      if (!s.url) return Object.assign(base, { ok: false, error: "no url configured" });
      try {
        const r = await upstreamRequest("GET", s.url, undefined,
          Number(s.timeoutMs) || config.statusTimeoutMs);
        const want = Number(s.expectStatus) || 0;
        const ok = want ? r.status === want : (r.status >= 200 && r.status < 400);
        return Object.assign(base, { ok, status: r.status, ms: Date.now() - started });
      } catch (e) {
        return Object.assign(base, { ok: false, error: e.message, ms: Date.now() - started });
      }
    }));

    const up = checked.filter((c) => c.ok).length;
    log("INFO", `status: ${up}/${checked.length} up`);
    return send(res, 200, {
      at: new Date().toISOString(),
      relay: { up: true, proxy: !!config.httpProxy },
      total: checked.length,
      up,
      services: checked
    });
  }

  /* --- vault header --- */
  if (seg[0] === "vault") {
    if (method === "GET") {
      /* Unauthenticated by necessity: you need the salt and the
         wrapped key in order to derive the token that would
         authenticate you. This is inherent to a zero-knowledge
         design. The defence is the PBKDF2 cost (600k iterations)
         plus hard rate limiting here. */
      if (!hit("vault:" + clientIp(req), config.rateLimit.vaultMax)) {
        return send(res, 429, { error: "rate limited" });
      }
      const vault = loadVault();
      if (!vault) return send(res, 404, { error: "no vault provisioned" });
      return send(res, 200, vault);
    }

    if (method === "POST") {
      if (loadVault()) return send(res, 409, { error: "vault already exists" });
      if (!config.provisionToken) {
        return send(res, 503, { error: "provisionToken is not set in config.json" });
      }
      const supplied = req.headers["x-fieldkit-provision"] || "";
      if (!constantTimeEqual(String(supplied), config.provisionToken)) {
        log("WARN", `provision rejected from ${clientIp(req)}`);
        return send(res, 403, { error: "bad provision token" });
      }
      const body = await readBody(req);
      if (!body || !body.authKeyHash || !body.kdf || !body.wrap) {
        return send(res, 400, { error: "not a valid vault header" });
      }
      writeJsonAtomic(VAULT_PATH, body);
      log("INFO", "vault provisioned");
      return send(res, 201, { ok: true });
    }

    if (method === "PUT") {
      /* Password change: re-wrapped header, authenticated with the
         OLD token, which the client still holds at that moment. */
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      if (!body || !body.authKeyHash || !body.wrap) {
        return send(res, 400, { error: "not a valid vault header" });
      }
      writeJsonAtomic(VAULT_PATH, body);
      log("INFO", "vault header replaced (password change)");
      return send(res, 200, { ok: true });
    }
  }

  /* --- records --- */
  if (seg[0] === "records") {
    if (!requireAuth(req, res)) return;

    if (seg.length === 1 && method === "GET") {
      const out = [];
      for (const f of fs.readdirSync(RECORDS_DIR)) {
        if (!f.endsWith(".json")) continue;
        const rec = readJson(path.join(RECORDS_DIR, f));
        if (!rec) continue;
        out.push({
          id: rec.id, type: rec.type, updatedAt: rec.updatedAt,
          deletedAt: rec.deletedAt || null
        });
      }
      return send(res, 200, out);
    }

    const id = seg[1];
    if (!validId(id)) return send(res, 400, { error: "invalid record id" });
    const file = recordPath(id);

    if (method === "GET") {
      const rec = readJson(file);
      if (!rec) return send(res, 404, { error: "not found" });
      return send(res, 200, rec);
    }

    if (method === "PUT") {
      const body = await readBody(req);
      if (!body || body.id !== id || !body.box || !body.box.iv || !body.box.ct) {
        return send(res, 400, { error: "record must carry a matching id and an encrypted box" });
      }
      writeJsonAtomic(file, body);
      return send(res, 200, { ok: true, id: id });
    }

    if (method === "DELETE") {
      jf.remove(file);   /* and its backup; already gone is fine */
      return send(res, 200, { ok: true, id: id });
    }
  }

  /* --- blobs: opaque encrypted chunks (LARGE-FILES.md) ---
     The relay's dumbest route, on purpose. It stores bytes under a
     key and hands them back. It does not parse them, does not know
     what file they belong to, does not know their order, and cannot
     tell one file's chunks from another's. All of that lives in an
     encrypted manifest record that only the client can read.

     Which means: losing the manifest loses the file even though
     every byte is still here. That is the correct trade — the
     alternative is a relay that knows your project's file tree.

     Authenticated like records. Not tailnet-gated: this is data
     sync, and the whole point is reaching it from school. */
  if (seg[0] === "blobs") {
    if (!requireAuth(req, res)) return;

    if (!hit("blob:" + clientIp(req), config.rateLimit.blobMax)) {
      return send(res, 429, { error: "rate limited" });
    }

    /* Index: keys and sizes, nothing else. The client needs this to
       find orphans — chunks whose manifest is gone — because only
       the client can know which keys are still referenced. */
    if (seg.length === 1 && method === "GET") {
      const out = [];
      let names = [];
      try { names = fs.readdirSync(BLOBS_DIR); } catch (e) { names = []; }
      for (const f of names) {
        if (!f.endsWith(".bin")) continue;
        try {
          const st = fs.statSync(path.join(BLOBS_DIR, f));
          out.push({ key: f.slice(0, -4), size: st.size, at: st.mtime.toISOString() });
        } catch (e) { /* skip */ }
      }
      const used = blobUsage();
      return send(res, 200, {
        blobs: out,
        usedBytes: used.bytes,
        quotaBytes: config.blobQuotaBytes,
        maxBlobBytes: config.blobMaxBytes
      });
    }

    const key = seg[1];
    if (!validBlobKey(key)) {
      return send(res, 400, { error: "invalid blob key — expected 32-64 lowercase hex characters" });
    }
    const bfile = blobPath(key);

    if (method === "GET") {
      let st;
      try { st = fs.statSync(bfile); } catch (e) { return send(res, 404, { error: "not found" }); }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      /* Streamed, not read into memory. A 8 MB chunk buffered per
         concurrent reader is how a 512 MB container dies. */
      return fs.createReadStream(bfile).pipe(res);
    }

    if (method === "PUT") {
      /* Quota is checked before reading the body, so an upload that
         cannot possibly fit is refused without spending the
         bandwidth. It is checked again implicitly by the write
         itself failing if the disk is genuinely full. */
      const used = blobUsage();
      let existing = 0;
      try { existing = fs.statSync(bfile).size; } catch (e) { existing = 0; }
      if (used.bytes - existing >= config.blobQuotaBytes) {
        return send(res, 507, {
          error: "blob quota reached",
          detail: `${used.bytes} of ${config.blobQuotaBytes} bytes used. ` +
                  "Delete some files, or raise blobQuotaBytes in config.json.",
          usedBytes: used.bytes, quotaBytes: config.blobQuotaBytes
        });
      }

      const buf = await readRawBody(req, config.blobMaxBytes);
      if (!buf || !buf.length) return send(res, 400, { error: "empty blob" });

      /* Same atomic rule as records: temp file then rename, so a
         killed container cannot leave a truncated chunk that
         decrypts to garbage. AES-GCM would catch it, but "the file
         is corrupt" is a worse answer than "the chunk is missing". */
      const tmp = bfile + ".tmp";
      const fd = fs.openSync(tmp, "w");
      try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }   /* on the disk before it has its name */
      fs.renameSync(tmp, bfile);
      return send(res, 200, { ok: true, key: key, size: buf.length });
    }

    if (method === "DELETE") {
      try { fs.unlinkSync(bfile); } catch (e) { /* already gone is fine */ }
      return send(res, 200, { ok: true, key: key });
    }
  }

  /* --- actions: the kill switch (§9D) ---
     Four gates, in this order, and the order is deliberate:

       1. tailnet         — before auth, so a public caller learns
                            only that the door is shut, not whether
                            their token was any good
       2. auth            — the bearer token, same as everything else
       3. whitelist       — an id that is not in config.json is not
                            an action, full stop
       4. cooldown        — per action, so a stuck client cannot
                            restart a server in a loop

     GET lists what is available. POST runs one. Nothing in the
     request body becomes part of a command line; the body carries
     an id and nothing else is read from it. */
  if (seg[0] === "actions") {
    if (!onTailnet(req)) {
      log("WARN", `action refused: ${clientIp(req)} is not on the tailnet`);
      return send(res, 403, {
        error: "actions are tailnet-only",
        detail: "Anything that changes a server's state requires being on the tailnet. " +
                "The public leg carries status, AI and sync only."
      });
    }
    if (!requireAuth(req, res)) return;

    const defined = Array.isArray(config.actions) ? config.actions : [];

    if (method === "GET") {
      return send(res, 200, {
        actions: defined.map((a) => ({
          id: a.id, label: a.label || a.id, note: a.note || "",
          cooldownS: Number(a.cooldownS) || 0,
          /* How long this relay will let the action run. The client
             sizes its own timeout from this, so it cannot give up on
             a command that is still going. Not the command line —
             that stays on the server. */
          timeoutMs: Number(a.timeoutMs) || config.actionTimeoutMs,
          lastRunAt: actionLastRun.get(a.id) ? new Date(actionLastRun.get(a.id)).toISOString() : null,
          ready: actionReady(a)
        })),
        tailnet: true
      });
    }

    if (method === "POST") {
      if (!hit("action:" + clientIp(req), config.rateLimit.actionMax)) {
        return send(res, 429, { error: "rate limited" });
      }
      const body = await readBody(req);
      const id = body && typeof body.id === "string" ? body.id : "";
      const action = defined.filter((a) => a && a.id === id)[0];
      if (!action) {
        noteAction(id || "(none)", "refused");
        /* Truncated for the same reason it is not used as a counter
           key: the body can carry 2 MB and the container console is
           written to disk. */
        log("WARN", `action refused: "${String(id).slice(0, 80)}" is not whitelisted`);
        return send(res, 404, {
          error: "not a whitelisted action",
          detail: "This relay can only run actions listed in its config. It has no path " +
                  "for arbitrary commands, by design."
        });
      }
      if (!actionReady(action)) {
        noteAction(action.id, "refused");
        const wait = Math.ceil((actionLastRun.get(action.id) +
          (Number(action.cooldownS) || 0) * 1000 - Date.now()) / 1000);
        return send(res, 429, {
          error: "cooling down",
          detail: `"${action.label || action.id}" ran recently. ${wait}s to go.`
        });
      }
      actionLastRun.set(action.id, Date.now());
      const result = await runAction(action);
      noteAction(action.id, result.ok ? "ok" : "failed");
      log(result.ok ? "INFO" : "WARN",
        `action ${action.id} -> ${result.ok ? "ok" : "failed"} in ${result.ms}ms`);
      return send(res, result.ok ? 200 : 500, result);
    }
  }

  /* --- usage: counters, never content (§9 Relay/AI extras) --- */
  if (seg[0] === "usage" && method === "GET") {
    if (!requireAuth(req, res)) return;
    if (!config.usageLog) {
      return send(res, 200, { enabled: false,
        detail: "usageLog is off in config.json — nothing is being counted" });
    }
    const byTarget = usage.ai.byTarget;
    const targets = Object.keys(byTarget).map((name) => {
      const t = byTarget[name];
      const n = t.ok + t.failed;
      return { name, ok: t.ok, failed: t.failed,
        avgMs: t.ok ? Math.round(t.totalMs / t.ok) : null,
        share: n ? Math.round((t.ok / Math.max(1, usage.ai.requests)) * 100) : 0 };
    }).sort((a, b) => b.ok - a.ok);

    return send(res, 200, {
      enabled: true,
      since: usage.since,
      lastFlush: usage.lastFlush,
      restarts: usage.restarts,
      /* This sentence used to end "...or anywhere else on this
         relay", which was not true: every request writes an INFO
         line to the container console that includes the client
         address, and Pterodactyl keeps that console output on disk.
         The counters really are clean; the claim about the rest of
         the relay was not mine to make. */
      note: "Counters only. Nothing in this file identifies a client — no prompts, no " +
            "record contents, no addresses. Note that the relay's own console log does " +
            "record client addresses per request, and your host keeps that log.",
      routes: usage.routes,
      days: usage.days,
      ai: { requests: usage.ai.requests, fellBack: usage.ai.fellBack,
        exhausted: usage.ai.exhausted, targets },
      actions: usage.actions
    });
  }

  /* --- ai --- */
  if (seg[0] === "ai") {
    if (!requireAuth(req, res)) return;

    if (seg[1] === "targets" && method === "GET") {
      const list = orderedTargets();
      await Promise.all(list.map(probeTarget));
      return send(res, 200, list.map((t) => ({
        name: t.name, priority: t.priority || 99,
        health: targetHealth.get(t.name) || null
      })));
    }

    if (seg[1] === "chat" && method === "POST") {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.messages)) {
        return send(res, 400, { error: "expected { messages: [...] }" });
      }
      return proxyChat(req, res, body);
    }
  }

  /* LAST CHANCE FOR A PROXIED PAGE THAT ASKED THE WRONG SERVER.

     A page read through the browser lives on this origin, so every
     root-relative URL it produces — `/api/me`, `location.href =
     "/login"`, a bundle's `/static/x.js` — arrives HERE instead of at
     the site it belongs to. The shim inside the page catches most of
     them, but `window.location` is non-configurable, so an assignment
     to it cannot be intercepted at all, and no rewriter sees a URL
     built by concatenation at runtime.

     Those all land in this function, one line above a 404 that says
     "no such route" — which is true and completely unhelpful.

     The Referer says where they came from, and if that is a proxied
     page then the intent is unambiguous: this path, on that page's
     real host. So it is sent there. Referer is worthless as a
     credential and this does not use it as one — the ticket is taken
     from the referring URL and then validated normally by the browse
     route, exactly as if the shim had rewritten the link. The worst a
     forged Referer buys is a redirect the sender could have typed. */
  if (config.browse && config.browse.enabled) {
    const rescued = browse.rescueFromReferer(req, url);
    if (rescued) {
      /* 307 rather than 302 for anything with a body. A 302 turns a
         POST into a GET and drops what was being sent, which for a
         form submission means the page silently loses the thing the
         person just typed. 307 says "again, exactly as it was". */
      const code = method === "GET" || method === "HEAD" ? 302 : 307;
      res.writeHead(code, { Location: rescued, "Cache-Control": "no-store" });
      return res.end();
    }
  }

  /* A bare "no such route" is a dead end. The question it leaves
     open is whether the relay is old, or whether the path it saw
     is the path you sent — and those have completely different
     fixes. So it answers both: the path AS THIS PROCESS SAW IT,
     and what this build actually serves.

     The path matters more than it looks. A proxy that forwards
     with a prefix, or a tunnel pointed at the wrong origin, both
     show up here as a `saw` that is not what you typed. That was
     otherwise invisible from the outside. */
  /* THE UNFORMATTED SCREEN.

     Everything below answers in JSON, which is right for a client
     and wrong for a person: a frame that lands here shows a wall of
     unstyled route names, and the reasonable conclusion from the
     other side of the screen is "the browser is broken" rather than
     "that request did not carry enough to place it".

     So a navigation gets a page. Gated on the request actually being
     one — an API client asking for JSON still gets JSON, and that
     matters because this same 404 is how a client discovers that a
     relay is running an older build than it thinks. */
  const wantsPage = /\btext\/html\b/i.test(String(req.headers.accept || "")) &&
    String(req.headers["sec-fetch-dest"] || "document") === "document";
  if (wantsPage) {
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const proxied = config.browse && config.browse.enabled &&
      browse.looksProxied && browse.looksProxied(req, url);
    const body = "<!doctype html><meta charset=\"utf-8\">" +
      "<title>nothing at that address</title>" +
      "<style>body{background:#0b0e0b;color:#b8c9b8;font:14px/1.6 ui-monospace,monospace;" +
      "margin:0;padding:2.5rem 1.5rem;}h1{font-size:1rem;letter-spacing:.12em;color:#8fdc8f;" +
      "margin:0 0 1rem;}code{color:#e8d98f;word-break:break-all;}p{max-width:38rem;}</style>" +
      "<h1>NOTHING AT THAT ADDRESS</h1>" +
      "<p>The relay was asked for <code>" + esc(method + " " + url.pathname) +
      "</code>, which is not one of its own routes" +
      (proxied
        ? " and could not be matched to the page it came from either. That usually " +
          "means a page built a link the proxy never saw. Going back and following " +
          "the link again normally works."
        : ". If a proxied page sent you here, its request arrived without anything " +
          "saying which site it belonged to.") +
      "</p><p>Nothing is broken on the drive, and nothing was sent anywhere.</p>";
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff" });
    return res.end(body);
  }

  send(res, 404, {
    error: "no such route",
    saw: { method, path: url.pathname },
    routes: ROUTES,
    version: 1,
    detail: "If `saw.path` is not the path you requested, something between you and " +
            "this relay is rewriting it. If it IS, and the route you want is missing " +
            "from `routes`, this relay is running an older server.js than you think."
  });
}

/* ---- server -------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  cors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  /* One limit for strangers, a much higher one for a caller who has
     already proved they hold the vault key.

     The general limit exists to stop an anonymous flood — above all
     against the unauthenticated GET /vault, which keeps its own much
     tighter `vaultMax` regardless of any of this. It was never meant
     to throttle the owner, and doing so had a concrete cost: FULL
     SYSTEM EXERCISE drives every module for real against the relay
     and would sail past 240 requests, so the last third of the suite
     failed with "rate limited" and read as a broken relay.

     A valid Authorization header is not free to forge — it is the
     same credential that reads the vault. Someone who has it can
     already read everything, so rate limiting them protects nothing
     that is not already lost. A WRONG one still counts against the
     stranger bucket, and authFailMax is untouched. */
  /* Only consult checkAuth when there is something to check.
     It reads the vault header off disk, and doing that for every
     anonymous request — the exact traffic a flood consists of —
     would put a file read in the hot path to defend against floods. */
  const authed = !!req.headers.authorization && checkAuth(req).ok === true;

  /* A proxied page is exempt from the GENERAL limit and metered by
     the browse bucket instead, which is the limit written for it.

     This only became a bug when the browser started working. One
     ordinary page is forty-odd requests — stylesheets, fonts, images,
     scripts — and an iframe cannot send an Authorization header,
     which is the entire reason browse tickets exist. So four or five
     pages tripped a limiter meant to stop anonymous floods, and the
     browse bucket's own 600 was never reached.

     Exempt, not unmetered: every request here still hits the browse
     bucket a few lines into the route. And the ticket is checked, not
     merely present — hasValidTicket is a Map lookup against tickets
     that were issued in exchange for a real credential and expire in
     thirty minutes. A bad one falls through to the stranger bucket
     exactly as before. */
  const browsing = config.browse && config.browse.enabled &&
    browse.hasValidTicket(req.url ? req.url.split("?")[0] : "");

  const cap = authed ? config.rateLimit.authedMax : config.rateLimit.max;
  if (!browsing && !hit((authed ? "authed:" : "req:") + ip, cap)) {
    log("WARN", `rate limited ${ip}${authed ? " (authenticated)" : ""}`);
    return send(res, 429, {
      error: "rate limited",
      detail: authed
        ? `over ${cap} requests in ${Math.round(config.rateLimit.windowMs / 1000)}s. ` +
          "If this was the full system exercise, wait a minute and re-run it."
        : "authenticate, or slow down",
      retryAfterMs: config.rateLimit.windowMs
    }, { "Retry-After": String(Math.ceil(config.rateLimit.windowMs / 1000)) });
  }

  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch (e) { return send(res, 400, { error: "bad url" }); }

  const t0 = Date.now();
  try {
    await route(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    log("ERROR", `${req.method} ${url.pathname} -> ${status}: ${e.message}`);
    if (!res.headersSent) send(res, status, { error: e.message });
  } finally {
    /* Counted by shape, not by value — "GET /records/:x", never the
       id itself. A counter keyed by record id would be a list of
       which records exist and how often they are touched, which is
       exactly the metadata a zero-knowledge store is supposed not
       to leak. routeKey() also bounds the key space to the known
       route table so a stranger cannot mint keys. */
    bump(routeKey(req.method, url.pathname));
    log("INFO", `${ip} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`);
  }
});

/* A listen failure arrives as an 'error' event, and an unhandled
   one is an uncaught exception: Node prints a stack trace and the
   process dies. On Pterodactyl that scrolls past in a console
   nobody was watching, and the symptom you are left with is a
   server that "did not start" with no reason attached. Name the
   two that actually happen. */
/* THE ONE SOCKET.

   Node hands an upgrade to a listener or the connection hangs, so
   this is not optional even for paths we do not serve. Anything
   that is not the browser stream is closed immediately rather than
   left dangling. */
server.on("upgrade", (req, sock, head) => {
  /* Before anything else, and this is not defensive padding: a raw
     upgrade socket has no error listener of its own, and a client
     that resets while we are still deciding what to do with it
     emits "error" on a bare stream — which Node turns into an
     unhandled throw that takes the whole relay down. Measured: one
     browser tab navigating away mid-handshake killed the process
     and every other session with it. */
  sock.on("error", () => { try { sock.destroy(); } catch (e) {} });

  let url;
  try { url = new URL(req.url, "http://" + (req.headers.host || "relay")); }
  catch (e) { try { sock.destroy(); } catch (x) {} return; }

  /* Do WebSockets get through this network? PREFLIGHT and DIAGNOSTICS
     ask, because the browser and RUNNER need them and some networks
     pass ordinary requests but not these. One message, then closed;
     no account, nothing read, rate-limited like everything else. */
  if (url.pathname === "/ws-check") {
    if (!hit("wscheck:" + clientIp(req), config.rateLimit.browserStreamMax)) {
      try { sock.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); } catch (e) {}
      return;
    }
    const w = require("./ws").accept(req, sock, { maxPayload: 1024 });
    if (w) { try { w.send("fieldkit-ws-ok"); } catch (e) {} setTimeout(() => { try { w.close(1000, "checked"); } catch (e) {} }, 200).unref(); }
    return;
  }

  /* RUNNER, passed through to Bastion 2 (runner.js), so it answers on
     whatever address the relay itself was reached by. */
  if (runner.isAttach(url)) {
    if (!hit("runnerws:" + clientIp(req), config.rateLimit.browserStreamMax)) {
      try {
        sock.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        setTimeout(() => sock.destroy(), 2000).unref();
      } catch (e) {}
      return;
    }
    runner.attach(req, sock, head, url);
    return;
  }

  if (!config.browser || !config.browser.enabled || !browser.isStreamUpgrade(url)) {
    try {
      sock.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      setTimeout(() => sock.destroy(), 2000).unref();
    } catch (e) {}
    return;
  }

  /* One connection per person replaces hundreds of requests, so the
     limit that matters here is on OPENING them, not on using them. */
  if (!hit("browserws:" + clientIp(req), config.rateLimit.browserStreamMax)) {
    try {
      sock.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      setTimeout(() => sock.destroy(), 2000).unref();
    } catch (e) {}
    return;
  }

  browser.upgrade(req, sock, head, url).catch((e) => {
    log("WARN", "browser: stream upgrade failed — " + e.message);
    try { sock.destroy(); } catch (x) {}
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log("ERROR", `port ${config.port} is already in use on ${config.host}.`);
    log("ERROR", "Something else is bound to it — usually a previous relay that did not");
    log("ERROR", "shut down, or SERVER_PORT pointing at a port another process owns.");
  } else if (e.code === "EACCES") {
    log("ERROR", `not allowed to bind ${config.host}:${config.port}.`);
    log("ERROR", "Ports below 1024 need privileges a container does not have.");
  } else {
    log("ERROR", `could not listen on ${config.host}:${config.port}: ${e.message}`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log("INFO", `fieldkit-relay listening on ${config.host}:${config.port}`);
  log("INFO", `data dir: ${DATA_DIR}`);
  {
  let v = null, bad = false;
  try { v = loadVault(); } catch (e) { bad = true; }
  log(bad ? "ERROR" : "INFO", "vault: " + (bad ? "the header is DAMAGED (and so is its .bak); nothing can sign in until it is restored" : v ? "provisioned" : "NOT provisioned"));
}
  log("INFO", `ai targets: ${config.aiTargets.length
    ? orderedTargets().map((t) => `${t.name}(${t.priority || 99})`).join(", ")
    : "none configured"}`);

  /* One genuine configuration contradiction is worth naming at
     boot, because it cannot work and is invisible otherwise: a
     Tailscale address with no proxy to reach the tailnet through.
     Private LAN addresses are NOT flagged here — whether they work
     depends on where this container actually sits, and calling a
     working target broken is worse than saying nothing. */
  orderedTargets().forEach((t) => {
    let host = "";
    try { host = new URL(t.url).hostname; } catch (e) {
      log("WARN", `ai target '${t.name}' has an unparseable url: ${t.url}`);
      return;
    }
    if ((CGNAT.test(host) || /\.ts\.net$/i.test(host)) && !config.httpProxy) {
      log("WARN", `ai target '${t.name}' (${t.url}) is a Tailscale address but httpProxy ` +
        "is empty — the relay has no route onto the tailnet. See relay/README.md.");
    }
  });
  if (!config.provisionToken) log("WARN", "provisionToken is empty — vault creation is disabled");

  /* Binding loopback is correct ONCE a tunnel is in front, and is
     a silent outage before that: the relay is healthy, the logs
     are clean, and nothing outside the container can reach it.
     Pterodactyl's allocation forwards to the container's address,
     not to 127.0.0.1, so the panel may also never see the port
     come up. Worth saying at the only moment anyone is looking. */
  const loopbackOnly = /^(127\.|::1$|localhost$)/.test(String(config.host));
  const tunnelled = !!(config.cloudflared && (config.cloudflared.token || config.cloudflared.tunnel));
  if (loopbackOnly && !tunnelled) {
    log("WARN", `host is ${config.host}, so this relay accepts connections from INSIDE`);
    log("WARN", "the container only, and no tunnel is configured to bring them in.");
    log("WARN", 'Set "host": "0.0.0.0" until a Cloudflare Tunnel is running.');
  } else if (loopbackOnly) {
    log("INFO", `host is ${config.host} — reachable only through the tunnel, as intended`);
  }

  const acts = Array.isArray(config.actions) ? config.actions : [];
  if (!acts.length) {
    log("INFO", "actions: none configured — this relay cannot change anything");
  } else {
    log("INFO", `actions: ${acts.map((a) => a.id).join(", ")} (tailnet-only)`);
    const bad = acts.filter((a) => !a.id || !a.cmd);
    if (bad.length) log("WARN", `${bad.length} action(s) missing id or cmd — they will refuse`);
    /* Worth saying out loud, once, at boot: with a proxy in front,
       that proxy is the public leg and never counts as the tailnet
       — including when it sits on loopback or on a Tailscale
       address. Somebody testing with curl on the box will be
       refused, and that refusal is correct. */
    if (config.trustProxy) {
      log("INFO", "trustProxy is set, so the trusted proxy is treated as public ingress — " +
        "actions require a direct tailnet peer, not a forwarded request");
    }
    /* An address in both lists is a contradiction: "believe this
       peer's headers" and "this peer is the tailnet" cannot both
       hold. onTailnet() resolves it safely (trustProxy wins), but
       the operator almost certainly did not mean it. */
    const trusted = Array.isArray(config.trustProxy) ? config.trustProxy.map(normaliseIp) : [];
    const extra = Array.isArray(config.extraTailnetIps) ? config.extraTailnetIps.map(normaliseIp) : [];
    const both = extra.filter((ip) => trusted.indexOf(ip) >= 0);
    if (both.length) {
      log("ERROR", `${both.join(", ")} appears in BOTH trustProxy and extraTailnetIps. ` +
        "It is being treated as public ingress and will be refused actions. Remove it from " +
        "one list.");
    }
  }
  log("INFO", `usage counters: ${config.usageLog ? "on" : "off"}`);

  const msg = messaging.init({ dataDir: DATA_DIR, config: config.messaging, log: log });
  if (!msg.enabled) log("INFO", "messaging: off (messaging.enabled is false)");

  const up = updates.init({ dataDir: DATA_DIR, config: config.updates, log: log });
  if (!up.enabled) log("INFO", "updates: off (updates.enabled is false)");

  const br = browse.init({ dataDir: DATA_DIR, config: config.browse, log: log });
  if (!br.enabled) log("INFO", "browse: off (browse.enabled is false)");
  else {
    /* Said at startup rather than left in a config file, because
       "this relay will fetch things on someone else's behalf" is the
       kind of thing you want to be reminded of every time you read
       the console. */
    log("INFO", "browse: on — " + (br.allowHosts.length
      ? "allow list of " + br.allowHosts.length + " host(s)"
      : "any public host") +
      (br.blockHosts.length ? ", " + br.blockHosts.length + " blocked" : "") +
      ". Private and reserved address ranges are always refused.");
  }
  const rn = runner.init({ dataDir: DATA_DIR, config: config.runner || {}, log: log,
    whoami: (r) => messaging.whoami(r) });
  log("INFO", rn.enabled ? "runner: on — run server at " + (rn.url || "(not set)")
    : "runner: off (runner.enabled is false)");

  /* The streamed browser shares browse.js's host filter — one
     blocklist, one place to change it, whichever browser is on. */
  /* The browser's share of this container and of the home upload,
     with Bastion 2's numbers and thresholds (RUNNER_PLAN.md §22). */
  const fairness = new Fairness({ peer: () => runner.load() });
  /* Browser helpers on Bastion 2 (overflow.js): new sessions go there
     when this relay is full. */
  const helperUrls = config.browser && config.browser.enabled && Array.isArray(config.browser.helpers) ? config.browser.helpers : [];
  const overflow = helperUrls.length ? new Overflow({ urls: helperUrls, dataDir: DATA_DIR, log: log }) : null;
  const bw = browser.init({
    config: config.browser,
    log: log,
    filter: (host) => browse.hostVerdict(host),
    fairness: fairness,
    overflow: overflow
  });
  if (overflow && overflow.any()) {
    overflow.start(() => fairness.line.length > 0 || bw.sessions.size > 0);
    log("INFO", "browser: " + overflow.helpers.length + " helper(s) take new sessions when this relay is full: " +
      overflow.helpers.map((h) => h.url).join(", "));
  }
  runner.startReports(() => ({ up: fairness.meter.upKbps, cpu: fairness.meter.cpu, mem: fairness.meter.mem,
    wait: fairness.line.length,
    busy: fairness.meter.upKbps > 0 || fairness.line.length > 0 || bw.sessions.size > 0 || !!(overflow && overflow.sessionsOut()) }));
  if (!config.browser || !config.browser.enabled) {
    log("INFO", "browser: off (browser.enabled is false)");
  } else {
    const found = require("./browser-engine").findChromium(config.browser.chromium);
    if (found.path) {
      log("INFO", "browser: streamed browser on — chromium at " + found.path +
        ", up to " + (config.browser.maxSessions || 6) + " session(s), " +
        "content filter: " + (config.browser.dnsFilter || "adult") + ".");
      log("INFO", "browser: every request it makes goes through the guard proxy. " +
        "It cannot reach this relay's own API or any private address.");
    } else {
      log("WARN", "browser: enabled, but no chromium binary was found. Looked in: " +
        found.tried.join(", ") + ". Set browser.chromium in config.json.");
    }
  }
  void bw;

  log("INFO", `routes: ${ROUTES.join("  |  ")}`);

  /* ---- the line Pterodactyl is waiting for --------------------
     Pterodactyl decides a server has finished starting by matching
     a string in its stdout — the egg's "Startup Configuration"
     done string. It is NOT watching the port. If nothing matches,
     the process runs perfectly and the panel sits on "Starting"
     forever: no crash, no error, and every stop/restart goes
     through the kill timeout because the panel never believed it
     was up.

     Nothing above is likely to match a generic Node egg's default.
     So this prints, on its own line and last, the phrase those
     eggs actually look for. It is also simply true. If your egg
     uses something else, set the done string to:

         fieldkit-relay listening on

     See relay/README.md, "Pterodactyl says Starting forever". */
  console.log("Server started");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("INFO", `${sig} received, shutting down`);
    flushUsage();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
