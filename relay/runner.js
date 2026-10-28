/* ============================================================
   FieldKit relay :: runner — the control plane for RUNNER

   RUNNER executes uploaded files on a second machine (Bastion 2).
   This file is the relay's entire part in that, and it is small on
   purpose: three routes, none of which carries a file.

     GET  /runner/status   is the run server there, and ready?
     POST /runner/ticket   who you are, signed, good for one minute
     GET  /runner/pubkey   the key that signature can be checked with
     WS   /runner/attach   RUNNER itself, passed through to Bastion 2

   The relay knows the accounts; Bastion 2 knows nothing. So the
   relay signs a statement — this handle, this tier — and the panel
   carries it to Bastion 2.

   THE SAME ADDRESS AS EVERYTHING ELSE. With runner.innerUrl set (Bastion
   2's run server as this relay reaches it over the tailnet), the panel
   opens RUNNER at <this relay>/runner/attach and the connection is
   passed through to Bastion 2 byte for byte, so whichever address got
   someone to the relay also gets them to RUNNER: one name to keep
   unblocked, not two. Nothing is read or kept on the way through; the
   ticket is still checked by Bastion 2. runner.publicUrl (and
   runner.alsoUrls) are then only spares the panel tries if that fails.
   Without innerUrl, the panel goes to publicUrl as before.

   THE KEY. An Ed25519 pair, made on first start and kept in the
   data directory. The private half never leaves this process. The
   public half is public and served to anybody, which is what lets
   Bastion 2 fetch it by itself instead of somebody copying a file
   between machines.

   WHEN BASTION 2 IS DOWN. /runner/status says so, in a sentence,
   and /runner/ticket refuses with the same sentence. The panel
   shows it and blocks uploading. Nothing here throws because a
   machine in somebody's house was unplugged.

   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");

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

const b64u = (b) => Buffer.from(b).toString("base64url");
const base = () => String(cfg.publicUrl || "").trim().replace(/\/+$/, "");
/* The run server's address first, then any others it also answers on
   (runner.alsoUrls), so a panel that cannot reach one tries the next.
   https only, and no paths. */
const urls = () => [base()].concat((Array.isArray(cfg.alsoUrls) ? cfg.alsoUrls : [])
  .map((u) => String(u || "").trim().replace(/\/+$/, ""))
  .filter((u) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)))
  .filter((u, i, a) => u && a.indexOf(u) === i);
/* Bastion 2's run server as this relay reaches it (the tailnet):
   http://host:port and nothing more. */
function inner() {
  const u = String(cfg.innerUrl || "").trim().replace(/\/+$/, "");
  return /^http:\/\/[a-z0-9.-]+:\d+$/i.test(u) ? u : "";
}
/* Where health checks and load reports go: the short way when there is one. */
const probeBase = () => inner() || base();

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
  if (!cfg.enabled) return { enabled: false };
  keys = loadKeys(path.join(opts.dataDir, "runner"));
  if (!base() && !inner()) {
    log("WARN", "runner: enabled, but runner.publicUrl is empty — the panel will be told the run server is not set up");
  }
  return { enabled: true, url: base(), inner: inner() };
}

/* RUNNER_PLAN.md §22: the two machines share one home line, so each
   tells the other its upload. Ours rides on the health check, signed
   for a different audience than tickets so it can never be one. */
const REPORT_AUDIENCE = "fieldkit-load";
function signReport(r, now) {
  const body = b64u(JSON.stringify({ v: 1, aud: REPORT_AUDIENCE, up: Math.max(0, Math.round(r.up || 0)),
    cpu: r.cpu, mem: r.mem, wait: r.wait | 0,
    exp: (now || Date.now()) + 30000, n: crypto.randomBytes(12).toString("hex") }));
  return body + "." + b64u(crypto.sign(null, Buffer.from(body), keys.privateKey));
}

function remember(body) {
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
    if (!cfg.enabled || !probeBase() || !keys) return;
    const m = mine() || {};
    const busy = m.busy || (peer && peer.waiting > 0);
    if (!busy && Date.now() - lastReport < 30000) return;
    lastReport = Date.now();
    try {
      const res = await fetch(probeBase() + "/health?load=" + encodeURIComponent(signReport(m)),
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
  if (!probeBase()) return { enabled: true, online: false, why: "the run server has not been set up yet" };
  if (probe.result && Date.now() - probe.at < PROBE_FRESH_MS) return probe.result;
  if (probe.pending) return probe.pending;

  probe.pending = (async () => {
    let out;
    try {
      const res = await fetch(probeBase() + "/health", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "error" });
      const body = res.ok ? await res.json() : null;
      remember(body);
      if (!body || body.service !== "fieldkit-runnerd") {
        out = { online: false, why: "the run server is offline" };
      } else {
        out = { online: true, ready: !!body.ready,
          why: body.ready ? null : "the run server is starting up" + (body.why ? " (" + body.why + ")" : ""),
          sandbox: body.sandbox || null, windows: !!body.windows,
          sessions: body.sessions || 0, jobs: body.jobs || 0 };
      }
    } catch (e) {
      out = { online: false, why: "the run server is offline" };
    }
    out.enabled = true;
    out.url = base();
    out.viaRelay = !!inner();
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
    send(res, 201, { ticket: signTicket(me.handle, me.tier), url: base(), urls: urls(), viaRelay: !!inner(), tier: me.tier,
      expiresIn: TICKET_MS / 1000 });
    return true;
  }

  send(res, 404, { error: "no such runner route", saw: url.pathname,
    routes: ["GET /runner/status", "POST /runner/ticket", "GET /runner/pubkey", "WS /runner/attach"] });
  return true;
}

/* ---- RUNNER through this relay's own address ---- */
const isAttach = (url) => url.pathname.replace(/\/+$/, "") === "/runner/attach";

/* Passes one panel's RUNNER connection to Bastion 2. The ticket in the
   query goes along untouched and Bastion 2 checks it. If Bastion 2
   does not answer with a 101, the panel gets a 502 and tries the
   spare addresses. */
function attach(req, sock, head, url) {
  const fail = (code, text) => {
    try { sock.end("HTTP/1.1 " + code + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch (e) {}
    setTimeout(() => { try { sock.destroy(); } catch (e) {} }, 2000).unref();
  };
  if (!cfg.enabled || !inner()) return fail(404, "Not Found");
  const to = new URL(inner());
  const up = net.connect({ host: to.hostname, port: Number(to.port) });
  let open = false, first = Buffer.alloc(0);
  const done = () => { try { up.destroy(); } catch (e) {} try { sock.destroy(); } catch (e) {} };
  const refuse = (why) => {
    if (open) return done();
    open = true;   /* once */
    try { up.destroy(); } catch (e) {}
    log("WARN", "runner: could not pass a RUNNER connection to Bastion 2 — " + why);
    fail(502, "Bad Gateway");
  };
  up.setTimeout(PROBE_TIMEOUT_MS * 2, () => refuse("it did not answer"));
  up.on("connect", () => {
    up.write(["GET /attach" + url.search + " HTTP/1.1", "Host: " + to.host,
      "Upgrade: websocket", "Connection: Upgrade",
      "Sec-WebSocket-Key: " + String(req.headers["sec-websocket-key"] || ""),
      "Sec-WebSocket-Version: " + String(req.headers["sec-websocket-version"] || "13")].join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
  });
  const onFirst = (c) => {
    first = Buffer.concat([first, c]);
    if (first.indexOf("\r\n\r\n") < 0) { if (first.length > 8192) refuse("its answer made no sense"); return; }
    const status = first.toString("latin1", 0, first.indexOf("\r\n"));
    /* Its refusals (a spent ticket, a full machine) are passed on as they are. */
    up.removeListener("data", onFirst);
    up.setTimeout(0);
    open = true;
    sock.write(first);
    if (!/^HTTP\/1\.1 101 /.test(status)) { sock.end(); return up.destroy(); }
    up.pipe(sock);
    sock.pipe(up);
  };
  up.on("data", onFirst);
  up.on("error", (e) => refuse(e.message));
  up.on("close", () => { if (!open) refuse("it closed the connection"); else done(); });
  sock.on("close", done);
  sock.on("error", done);
}

module.exports = { init, route, status, startReports, isAttach, attach, load: () => peer, AUDIENCE, REPORT_AUDIENCE, TICKET_MS,
  _internals: { signTicket, signReport, remember, publicPem: () => keys && keys.publicPem, inner,
    forget: () => { probe = { at: 0, result: null, pending: null }; } } };
