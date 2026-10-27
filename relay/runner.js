/* ============================================================
   FieldKit relay :: runner — the control plane for RUNNER

   RUNNER executes uploaded files on a second machine (Bastion 2).
   This file is the relay's entire part in that, and it is small on
   purpose: three routes, none of which carries a file.

     GET  /runner/status   is the run server there, and ready?
     POST /runner/ticket   who you are, signed, good for one minute
     GET  /runner/pubkey   the key that signature can be checked with
     POST /runner/wake     wake Bastion 2 up (RUNNER_PLAN.md §24)
     GET  /runner/wake/wait  the wake helper on Bastion 1 waiting

   The relay knows the accounts; Bastion 2 knows nothing. So the
   relay signs a statement — this handle, this tier — and the panel
   carries it straight to Bastion 2 over that machine's own
   hostname. After that the relay is out of the picture: no upload,
   no output and no video ever passes through here.

   THE KEY. An Ed25519 pair, made on first start and kept in the
   data directory. The private half never leaves this process. The
   public half is public and served to anybody, which is what lets
   Bastion 2 fetch it by itself instead of somebody copying a file
   between machines.

   WHEN BASTION 2 IS DOWN. /runner/status says so, in a sentence,
   and /runner/ticket refuses with the same sentence. The panel
   shows it and blocks uploading. Nothing here throws because a
   machine in somebody's house was unplugged.

   WHEN BASTION 2 IS ASLEEP (runnerd/sleep.js). Its /health said what
   its network card's address is, and that it was about to sleep; both
   are kept on disk here, because it cannot be asked while asleep.
   Waking takes a Wake-on-LAN packet on the home network, and this
   process cannot send one: from inside its container, broadcasts do
   not reach the LAN. So a helper (fk-wake.js) runs on Bastion 1's own
   network and waits here, holding a request open; when somebody opens
   RUNNER, it is answered with the address and sends the packet. It
   proves itself with a key this relay makes in its data folder, which
   the helper is given read-only.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TICKET_MS = 60 * 1000;
const PROBE_FRESH_MS = 8000;
const PROBE_TIMEOUT_MS = 4000;
const AUDIENCE = "fieldkit-runner";

let cfg = { enabled: false, publicUrl: "" };
let log = () => {};
let whoami = () => null;
let keys = null;                 /* { privateKey, publicPem } */
let probe = { at: 0, result: null, pending: null };
let peer = null;                 /* Bastion 2's load: { upKbps, settings, waiting, at } */
let reportTimer = null, lastReport = 0;

/* ---- waking Bastion 2 ---- */
const WAKE_WAIT_MS = 50 * 1000;       /* one held request from the helper */
const WAKE_HOLD_MS = 90 * 1000;       /* a wake nobody collected yet */
const WAKE_AGAIN_MS = 15 * 1000;      /* a second packet, if it is still asleep */
const WAKING_MS = 2 * 60 * 1000;      /* "waking" is said for this long */
const HELPER_FRESH_MS = 3 * 60 * 1000;
const MAX_WAITERS = 4;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
let wake = { mac: null, can: false, on: false, soon: false, quiet: null };
let wakeFile = null, wakeKey = null;
let helperAt = 0, waiters = [], pending = null;

/* Same rule as runnerd/sleep.js: from-hour up to to-hour, across
   midnight when from > to, in the admin's own time zone. */
function inQuiet(q, now) {
  if (!q || q.from == null || q.to == null || q.from === q.to) return false;
  let h;
  try {
    h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: q.tz || "UTC" })
      .format(new Date(now || Date.now()))) % 24;
  } catch (e) { h = new Date(now || Date.now()).getUTCHours(); }
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

function loadWake(dir) {
  wakeFile = path.join(dir, "wake-state.json");
  try {
    const w = JSON.parse(fs.readFileSync(wakeFile, "utf8"));
    if (w && typeof w === "object") wake = Object.assign(wake, w);
  } catch (e) {}
  /* The helper's key, in a folder of its own so the helper can be
     given that folder and nothing else (not the ticket key). */
  if (cfg.wakeKey) { wakeKey = String(cfg.wakeKey); return; }
  const kd = path.join(dir, "wake");
  fs.mkdirSync(kd, { recursive: true, mode: 0o700 });
  const kf = path.join(kd, "key");
  if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  wakeKey = fs.readFileSync(kf, "utf8").trim();
}

/* From Bastion 2's own /health: its card, and whether it was about
   to sleep. Saved only when something changed. */
function rememberSleep(sl) {
  if (!sl || typeof sl !== "object") return;
  const q = sl.quiet && typeof sl.quiet === "object" && Number.isInteger(sl.quiet.from) && Number.isInteger(sl.quiet.to)
    ? { from: sl.quiet.from % 24, to: sl.quiet.to % 24, tz: typeof sl.quiet.tz === "string" ? sl.quiet.tz.slice(0, 64) : "UTC" } : null;
  const mac = typeof sl.mac === "string" && MAC_RE.test(sl.mac) ? sl.mac : wake.mac;
  const next = { mac: mac, can: !!sl.can, on: !!sl.on, soon: !!sl.soon, quiet: q };
  if (JSON.stringify(next) === JSON.stringify(wake)) return;
  wake = next;
  if (!wakeFile) return;
  try { fs.writeFileSync(wakeFile, JSON.stringify(wake)); } catch (e) { log("WARN", "runner: could not save Bastion 2's wake details: " + e.message); }
}

const helperFresh = () => helperAt > 0 && Date.now() - helperAt < HELPER_FRESH_MS;

/* What the panel is told while Bastion 2 does not answer. */
function wakeView() {
  const now = Date.now();
  return { asleep: !!wake.soon, wakeable: !!(wake.mac && wake.can && helperFresh()),
    waking: !!(pending && now - pending.at < WAKING_MS), quiet: inQuiet(wake.quiet, now) ? wake.quiet : null };
}

function deliver() {
  if (!pending || pending.sent || !wake.mac) return;
  if (!waiters.length) return;
  pending.sent = true;
  for (const w of waiters.splice(0)) w.done({ wake: true, mac: wake.mac });
  log("INFO", "runner: the wake helper is sending Bastion 2 its Wake-on-LAN packet");
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const base = () => String(cfg.publicUrl || "").trim().replace(/\/+$/, "");

function loadKeys(dir) {
  const file = path.join(dir, "ticket-key.pem");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    const pair = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(file, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    log("INFO", "runner: made a new ticket-signing key");
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
  const publicPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  return { privateKey, publicPem };
}

function init(opts) {
  cfg = Object.assign({ enabled: false, publicUrl: "" }, opts.config || {});
  log = opts.log || log;
  whoami = opts.whoami || whoami;
  probe = { at: 0, result: null, pending: null };
  keys = null;
  for (const w of waiters.splice(0)) w.done({ wake: false });
  helperAt = 0; pending = null; wakeKey = null; wakeFile = null;
  wake = { mac: null, can: false, on: false, soon: false, quiet: null };
  if (!cfg.enabled) return { enabled: false };
  keys = loadKeys(path.join(opts.dataDir, "runner"));
  loadWake(path.join(opts.dataDir, "runner"));
  if (!base()) {
    log("WARN", "runner: enabled, but runner.publicUrl is empty — the panel will be told the run server is not set up");
  }
  return { enabled: true, url: base() };
}

/* RUNNER_PLAN.md §22: the two machines share one home line, so each
   tells the other its upload. Ours rides on the health check, signed
   for a different audience than tickets so it can never be one. */
const REPORT_AUDIENCE = "fieldkit-load";
function signReport(r, now) {
  const body = b64u(JSON.stringify({ v: 1, aud: REPORT_AUDIENCE, up: Math.max(0, Math.round(r.up || 0)),
    cpu: r.cpu, mem: r.mem, wait: r.wait | 0,
    /* seconds since the wake helper last asked, -1 never: for ADMIN */
    wh: helperAt ? Math.max(0, Math.round((Date.now() - helperAt) / 1000)) : -1,
    exp: (now || Date.now()) + 30000, n: crypto.randomBytes(12).toString("hex") }));
  return body + "." + b64u(crypto.sign(null, Buffer.from(body), keys.privateKey));
}

function remember(body) {
  if (body && body.service === "fieldkit-runnerd") rememberSleep(body.sleep);
  const l = body && body.load;
  if (!l || typeof l !== "object") return;
  peer = { upKbps: Math.max(0, Number(l.upKbps) || 0), settings: l.settings && typeof l.settings === "object" ? l.settings : null,
    waiting: Math.max(0, l.waiting | 0), at: Date.now() };
}

/* Every 5 s while the browser is in use or anyone waits, every 30 s
   otherwise. `mine` gives { up, cpu, mem, wait, busy }. */
function startReports(mine) {
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = setInterval(async () => {
    if (!cfg.enabled || !base() || !keys) return;
    const m = mine() || {};
    const busy = m.busy || (peer && peer.waiting > 0);
    if (!busy && Date.now() - lastReport < 30000) return;
    lastReport = Date.now();
    try {
      const res = await fetch(base() + "/health?load=" + encodeURIComponent(signReport(m)),
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "error" });
      if (res.ok) remember(await res.json());
    } catch (e) { /* offline is a state, not an error: the browser uses its defaults */ }
  }, 5000);
  if (reportTimer.unref) reportTimer.unref();
}

function signTicket(handle, tier, now) {
  const body = b64u(JSON.stringify({ v: 1, aud: AUDIENCE, handle: handle, tier: tier,
    exp: (now || Date.now()) + TICKET_MS, n: crypto.randomBytes(12).toString("hex") }));
  return body + "." + b64u(crypto.sign(null, Buffer.from(body), keys.privateKey));
}

/* Asks Bastion 2 how it is, and remembers the answer for a few
   seconds so a panel that polls cannot turn into a stream of
   outbound requests. Every failure becomes a sentence. */
async function status() {
  if (!cfg.enabled) return { enabled: false, online: false, why: "RUNNER is switched off on this relay" };
  if (!base()) return { enabled: true, online: false, why: "the run server has not been set up yet" };
  if (probe.result && Date.now() - probe.at < PROBE_FRESH_MS) return probe.result;
  if (probe.pending) return probe.pending;

  probe.pending = (async () => {
    let out;
    try {
      const res = await fetch(base() + "/health", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "error" });
      const body = res.ok ? await res.json() : null;
      remember(body);
      if (!body || body.service !== "fieldkit-runnerd") {
        out = { online: false, why: "the run server is offline" };
      } else {
        pending = null;
        out = { online: true, ready: !!body.ready,
          why: body.ready ? null : "the run server is starting up" + (body.why ? " (" + body.why + ")" : ""),
          sandbox: body.sandbox || null, windows: !!body.windows,
          sessions: body.sessions || 0, jobs: body.jobs || 0 };
      }
    } catch (e) {
      out = { online: false, why: "the run server is offline" };
    }
    if (!out.online) {
      Object.assign(out, wakeView());
      if (out.asleep) out.why = out.waking ? "the run server is waking up" : "the run server is asleep to save power";
    }
    out.enabled = true;
    out.url = base();
    out.checkedAt = Date.now();
    probe = { at: Date.now(), result: out, pending: null };
    return out;
  })();
  return probe.pending;
}

async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "runner") return false;
  const { send } = helpers;
  const what = seg[1] || "", method = req.method;

  /* Answered whether or not the feature is on: the panel asks this
     first, and "off" is an answer, not an error. */
  if (what === "status" && method === "GET") {
    send(res, 200, await status());
    return true;
  }

  if (!cfg.enabled) {
    send(res, 503, { error: "RUNNER is switched off on this relay",
      detail: "set runner.enabled in config.json and restart" });
    return true;
  }

  if (what === "pubkey" && method === "GET") {
    send(res, 200, { alg: "Ed25519", publicKey: keys.publicPem });
    return true;
  }

  if (what === "ticket" && method === "POST") {
    /* An ACCOUNT, not the vault token. RUNNER's limits, files and
       punishments are all per person, and the vault token is one
       secret shared by everybody who holds the full build. */
    const me = whoami(req);
    if (!me) {
      send(res, 401, { error: "sign in to MESSAGES to use RUNNER" });
      return true;
    }
    if (me.banned) {
      send(res, 403, { error: "this account cannot use RUNNER while it is banned", banned: me.banned });
      return true;
    }
    const st = await status();
    if (!st.online || !st.ready) {
      send(res, 503, { error: st.why || "the run server is offline", offline: true });
      return true;
    }
    send(res, 201, { ticket: signTicket(me.handle, me.tier), url: base(), tier: me.tier,
      expiresIn: TICKET_MS / 1000 });
    return true;
  }

  /* The helper on Bastion 1, waiting to be told to wake Bastion 2. */
  if (what === "wake" && seg[2] === "wait" && method === "GET") {
    const k = String(req.headers["x-fk-wake-key"] || "");
    const a = Buffer.from(k), b = Buffer.from(wakeKey || "");
    if (!wakeKey || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      send(res, 401, { error: "wrong wake key" });
      return true;
    }
    if (!helperFresh()) log("INFO", "runner: the wake helper on Bastion 1 is connected");
    helperAt = Date.now();
    if (pending && !pending.sent && wake.mac && Date.now() - pending.at < WAKE_HOLD_MS) {
      pending.sent = true;
      log("INFO", "runner: the wake helper is sending Bastion 2 its Wake-on-LAN packet");
      send(res, 200, { wake: true, mac: wake.mac });
      return true;
    }
    if (waiters.length >= MAX_WAITERS) waiters.shift().done({ wake: false });
    await new Promise((resolve) => {
      const w = { done: (body) => { if (w.over) return; w.over = true; clearTimeout(w.timer);
        helperAt = Date.now(); if (!res.writableEnded) send(res, 200, body); resolve(); } };
      w.timer = setTimeout(() => { waiters = waiters.filter((x) => x !== w); w.done({ wake: false }); }, WAKE_WAIT_MS);
      res.on("close", () => { if (!w.over) { waiters = waiters.filter((x) => x !== w); w.over = true; clearTimeout(w.timer); resolve(); } });
      waiters.push(w);
    });
    return true;
  }

  /* Somebody opened RUNNER while Bastion 2 sleeps. */
  if (what === "wake" && !seg[2] && method === "POST") {
    const me = whoami(req);
    if (!me) { send(res, 401, { error: "sign in to MESSAGES to wake the run server" }); return true; }
    if (me.banned) { send(res, 403, { error: "this account cannot use RUNNER while it is banned" }); return true; }
    probe = { at: 0, result: null, pending: null };
    const st = await status();
    if (st.online) { send(res, 200, { awake: true }); return true; }
    if (!wake.mac || !wake.can) {
      send(res, 503, { error: "the run server is offline, and this relay does not know how to wake it" });
      return true;
    }
    if (!helperFresh()) {
      send(res, 503, { error: "the run server is asleep, but the wake helper on Bastion 1 is not running, so it cannot be woken from here" });
      return true;
    }
    if (inQuiet(wake.quiet) && me.tier !== "admin") {
      send(res, 403, { error: "the run server sleeps from " + wake.quiet.from + ":00 to " + wake.quiet.to + ":00 (" + wake.quiet.tz +
        "); only an admin can wake it then", quiet: wake.quiet });
      return true;
    }
    const now = Date.now();
    if (!pending || now - pending.at > WAKE_AGAIN_MS) {
      pending = { at: now, by: me.handle, sent: false };
      log("INFO", "runner: " + me.handle + " asked to wake Bastion 2");
      deliver();
    }
    probe = { at: 0, result: null, pending: null };
    send(res, 202, { waking: true, expectSec: 30 });
    return true;
  }

  send(res, 404, { error: "no such runner route", saw: url.pathname,
    routes: ["GET /runner/status", "POST /runner/ticket", "GET /runner/pubkey", "POST /runner/wake", "GET /runner/wake/wait"] });
  return true;
}

module.exports = { init, route, status, startReports, load: () => peer, AUDIENCE, REPORT_AUDIENCE, TICKET_MS,
  _internals: { signTicket, signReport, remember, publicPem: () => keys && keys.publicPem, inQuiet, wakeView,
    wakeKey: () => wakeKey, wakeState: () => wake, waiters: () => waiters.length, helperAt: (t) => { if (t != null) helperAt = t; return helperAt; },
    WAKE_WAIT_MS, WAKE_AGAIN_MS,
    forget: () => { probe = { at: 0, result: null, pending: null }; } } };
