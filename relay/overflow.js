/* ============================================================
   FieldKit relay :: overflow — browser sessions on Bastion 2 when
   this relay is full

   The relay runs in a Pterodactyl container with a few processors
   and a few GB, and each streamed-browser session is a Chromium of
   its own (§14.37). Bastion 2 has more of both, mostly idle. So a
   second copy of the relay's image runs there as a BROWSER HELPER
   (browser-helper.js), its own server in Pterodactyl so its use shows
   beside this one's, and new sessions go to it when this relay has
   no free session or is over its load line.

   WHAT THE PANEL SEES: nothing new. It still opens one socket to
   this relay. A session placed on the helper is a byte-for-byte pipe
   from that socket to the helper's, over the home network or the
   tailnet, never the internet: the panel's address is the only one
   that has to work, which is the point when several addresses are
   listed in case one is blocked somewhere.

   WHY A PIPE AND NOT A SECOND ADDRESS. The helper's pictures cross
   the home upload exactly once either way. Piping costs this relay
   a copy of the bytes and nothing else (no decoding, no encoding),
   keeps the helper off the internet entirely, and lets the bytes be
   counted in this relay's share of the upload like every other frame.

   TRUST runs one way, as with RUNNER. This relay knows the accounts;
   the helper knows none. Every request to it carries a PASS: a short
   statement (this account, this tier, this one request) signed with
   an Ed25519 key that lives only here. The helper fetches the public
   half from this relay's public address by itself and believes
   exactly that much. A pass is good for a minute and spent on use.

   WHERE A NEW SESSION GOES (browser-route.js asks place()):
     1. it already has a session here: here;
     2. it has one on a helper: there;
     3. here has a free session and is under the line: here;
     4. a helper has a free session and is under the line: there;
     5. otherwise here, as before (an unwatched session gives way, or
        the line).
   The home upload is shared, so it counts the same for both.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");

const AUDIENCE = "fieldkit-browser-helper";
const PASS_MS = 60 * 1000;
const POLL_BUSY_MS = 3000;           /* someone is on a helper, or waiting */
const POLL_IDLE_MS = 20000;
const STATE_FRESH_MS = 15000;
const TIMEOUT_MS = 4000;
/* What a helper's new session is guessed to cost, as in fairness.js. */
const COST = { cpu: 10, mem: 6 };

const b64u = (b) => Buffer.from(b).toString("base64url");

function sign(privateKey, claims, now) {
  const body = b64u(JSON.stringify(Object.assign({ v: 1, aud: AUDIENCE, exp: (now || Date.now()) + PASS_MS,
    n: crypto.randomBytes(12).toString("hex") }, claims)));
  return body + "." + b64u(crypto.sign(null, Buffer.from(body), privateKey));
}

/* { ok, claims } or { ok: false, why }. Never throws: the text came
   from the network. */
function verify(publicKey, text, now) {
  now = now || Date.now();
  const s = String(text || "");
  const parts = s.split(".");
  if (s.length > 2048 || parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, why: "not a pass" };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(parts[0]), publicKey, Buffer.from(parts[1], "base64url")); }
  catch (e) { good = false; }
  if (!good) return { ok: false, why: "the signature does not match the relay's key" };
  let c;
  try { c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (e) { return { ok: false, why: "not a pass" }; }
  if (!c || c.v !== 1 || c.aud !== AUDIENCE) return { ok: false, why: "that pass is for something else" };
  if (typeof c.exp !== "number" || c.exp <= now) return { ok: false, why: "that pass has expired" };
  if (c.exp - now > PASS_MS * 2) return { ok: false, why: "that pass claims to last too long" };
  if (typeof c.n !== "string" || c.n.length < 16) return { ok: false, why: "no nonce" };
  if (typeof c.what !== "string") return { ok: false, why: "no purpose" };
  return { ok: true, claims: c };
}

/* Nonces seen, kept only while their pass could still be replayed. */
class Spent {
  constructor() { this.seen = new Map(); }
  use(c, now) {
    now = now || Date.now();
    for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
    if (this.seen.has(c.n)) return false;
    this.seen.set(c.n, c.exp);
    return true;
  }
}

function loadKeys(dir) {
  const file = path.join(dir, "helper-key.pem");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    const pair = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(file, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
  return { privateKey, publicPem: crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }) };
}

/* "http://host:port" only: a helper is on the home network or the
   tailnet, and anything else in the list is a mistake to say aloud. */
function parseUrl(u) {
  let x;
  try { x = new URL(String(u || "")); } catch (e) { return null; }
  if (x.protocol !== "http:" || !x.hostname || x.pathname.replace(/\/+$/, "") || x.search) return null;
  return { host: x.hostname.replace(/^\[|\]$/g, ""), port: Number(x.port) || 80, url: x.origin };
}

class Overflow {
  /* opts: { urls, dataDir, log, now } */
  constructor(opts) {
    this.log = opts.log || (() => {});
    this.now = opts.now || Date.now;
    this.keys = loadKeys(path.join(opts.dataDir, "browser"));
    this.helpers = [];
    (opts.urls || []).forEach((u, i) => {
      const p = parseUrl(typeof u === "string" ? u : u && u.url);
      if (!p) { this.log("WARN", "browser: helper " + JSON.stringify(u) + " is not an http://address:port, so it is not used"); return; }
      this.helpers.push(Object.assign(p, { id: i, name: (u && u.name) || "helper " + (i + 1), state: null, at: 0,
        down: null, piped: 0, polling: false }));
    });
    this.step = 0;               /* the house video step, passed on so helpers follow it */
    this.timer = null;
    this.lastPoll = 0;
  }

  any() { return this.helpers.length > 0; }

  pass(claims) { return sign(this.keys.privateKey, claims, this.now()); }

  fresh(h) { return !!(h.state && this.now() - h.at < STATE_FRESH_MS); }

  /* How many sessions are on helpers: runner.js says so to Bastion 2,
     so it does not go to sleep under them. */
  sessionsOut() {
    return this.helpers.reduce((n, h) => n + (this.fresh(h) ? (h.state.sessions || []).length : 0) + h.piped, 0);
  }

  holding(who) {
    who = String(who);
    return this.helpers.find((h) => this.fresh(h) && (h.state.sessions || []).indexOf(who) >= 0) || null;
  }

  /* A helper with a free session that this tier may have, by its own
     load and the shared upload; the one keeping this account's
     sign-ins first, then the least busy. */
  pick(who, tier, fair) {
    const t = fair ? fair.settings()[tier] || fair.settings().guest : null;
    if (fair && tier !== "admin" && fair.upPct(800) > t.upload) return null;
    const ok = this.helpers.filter((h) => {
      if (!this.fresh(h) || !h.state.ready || !(h.state.free > 0)) return false;
      if (!t || tier === "admin") return true;
      return h.state.cpu + COST.cpu <= t.load && h.state.mem + COST.mem <= t.load;
    });
    const kept = ok.find((h) => (h.state.kept || []).indexOf(String(who)) >= 0);
    return kept || ok.sort((a, b) => (b.state.free - a.state.free) || (a.state.cpu - b.state.cpu))[0] || null;
  }

  /* ---- talking to a helper ---- */

  request(h, method, p, claims, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: h.host, port: h.port, method: method, path: p, timeout: TIMEOUT_MS,
        headers: Object.assign({ "X-FieldKit-Pass": this.pass(claims) },
          body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => { size += c.length; if (size < 1048576) chunks.push(c); });
        res.on("end", () => {
          let j = null;
          try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) {}
          if (res.statusCode >= 400) return reject(new Error((j && j.error) || "the helper answered " + res.statusCode));
          resolve(j);
        });
      });
      req.on("timeout", () => req.destroy(new Error("the helper did not answer")));
      req.on("error", reject);
      req.end(body || undefined);
    });
  }

  async poll(h) {
    if (h.polling) return;
    h.polling = true;
    try {
      const s = await this.request(h, "GET", "/helper/state", { what: "state", step: this.step });
      if (!s || typeof s !== "object") throw new Error("the helper said nothing useful");
      h.state = { ready: !!s.ready, free: Math.max(0, s.free | 0), max: s.max | 0,
        cpu: Number(s.cpu) || 0, mem: Number(s.mem) || 0,
        sessions: Array.isArray(s.sessions) ? s.sessions.map(String).slice(0, 200) : [],
        kept: Array.isArray(s.kept) ? s.kept.map(String).slice(0, 200) : [] };
      h.at = this.now();
      if (h.down) this.log("INFO", "browser: " + h.name + " (" + h.url + ") answers again");
      h.down = null;
    } catch (e) {
      if (!h.down) this.log("INFO", "browser: " + h.name + " (" + h.url + ") is not answering — " + e.message +
        ". New sessions stay here until it does.");
      h.down = e.message;
      h.state = null;
    } finally {
      h.polling = false;
    }
  }

  /* busy(): is anyone on a helper or waiting here. */
  start(busy) {
    if (!this.any() || this.timer) return;
    const tick = () => {
      const now = this.now();
      const want = busy() || this.sessionsOut() > 0 ? POLL_BUSY_MS : POLL_IDLE_MS;
      if (now - this.lastPoll < want - 50) return;
      this.lastPoll = now;
      for (const h of this.helpers) this.poll(h);
    };
    this.timer = setInterval(tick, 1000);
    if (this.timer.unref) this.timer.unref();
    tick();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /* The panel's socket, handed to a helper. The upgrade request is
     passed on as it came (the panel's own key, so the helper's answer
     completes the panel's handshake), with a pass instead of the
     ticket. Until the helper has said "101", nothing has been written
     to the panel, so a helper that cannot be reached or says no
     leaves fallback() to serve it here instead. */
  pipe(h, req, sock, head, who, tier, count, fallback) {
    const lines = ["GET /browser/stream HTTP/1.1", "Host: " + h.host + ":" + h.port,
      "Upgrade: websocket", "Connection: Upgrade",
      "Sec-WebSocket-Key: " + String(req.headers["sec-websocket-key"] || ""),
      "Sec-WebSocket-Version: " + String(req.headers["sec-websocket-version"] || "13"),
      "X-FieldKit-Pass: " + this.pass({ what: "stream", who: String(who), tier: tier, via: h.id })];
    const up = net.connect({ host: h.host, port: h.port });
    let stage = "asking", counted = false, first = Buffer.alloc(0);
    const uncount = () => { if (counted) { counted = false; h.piped = Math.max(0, h.piped - 1); } };
    const finish = () => {
      if (stage === "done") return;
      stage = "done";
      uncount();
      try { up.destroy(); } catch (e) {}
      try { sock.destroy(); } catch (e) {}
    };
    const refuse = (why) => {
      if (stage !== "asking") return finish();
      stage = "done";
      uncount();
      try { up.destroy(); } catch (e) {}
      h.down = why; h.state = null;
      this.log("WARN", "browser: " + h.name + " could not take " + who + "'s session — " + why + "; served here instead");
      fallback();
    };
    up.setTimeout(TIMEOUT_MS, () => refuse("the helper did not answer"));
    up.on("connect", () => {
      counted = true; h.piped++;
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
    });
    const onFirst = (c) => {
      first = Buffer.concat([first, c]);
      const at = first.indexOf("\r\n\r\n");
      if (at < 0) { if (first.length > 8192) refuse("the helper's answer made no sense"); return; }
      const status = first.toString("latin1", 0, first.indexOf("\r\n"));
      if (!/^HTTP\/1\.1 101 /.test(status)) return refuse("it said " + status.slice(9, 60));
      up.removeListener("data", onFirst);
      up.setTimeout(0);
      stage = "open";
      if (count) count(first.length);
      sock.write(first);
      up.on("data", (d) => { if (count) count(d.length); });
      up.pipe(sock);
      sock.pipe(up);
      this.log("INFO", "browser: " + who + " (" + tier + ") is on " + h.name);
    };
    up.on("data", onFirst);
    up.on("error", (e) => refuse(e.message));
    up.on("close", () => { if (stage === "asking") refuse("the helper closed the connection"); else finish(); });
    sock.on("close", finish);
    sock.on("error", finish);
  }

  /* A download or a page's file, by the link the helper gave the panel
     (/browser/via/<id>/file|put/<token>): passed through as it is. */
  link(id, rest, req, res, count, send) {
    const h = this.helpers.find((x) => String(x.id) === String(id));
    if (!h) { send(res, 404, { error: "that link has gone" }); return; }
    const out = http.request({ host: h.host, port: h.port, method: req.method, path: "/browser/" + rest,
      headers: Object.assign({ "X-FieldKit-Pass": this.pass({ what: "link" }) },
        req.headers["content-length"] ? { "Content-Length": req.headers["content-length"] } : {},
        req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}) }, (r) => {
      const keep = {};
      for (const k of ["content-type", "content-length", "content-disposition", "cache-control", "x-content-type-options"]) {
        if (r.headers[k]) keep[k] = r.headers[k];
      }
      res.writeHead(r.statusCode, keep);
      r.on("data", (c) => { if (count) count(c.length); });
      r.pipe(res);
    });
    out.on("error", () => { if (!res.headersSent) send(res, 502, { error: "the browser helper is not answering" }); else res.destroy(); });
    req.pipe(out);
  }

  /* Forgetting cookies or everything, for a session on a helper. */
  clear(h, who, what) {
    return this.request(h, "POST", "/helper/clear", { what: "clear", who: String(who) }, JSON.stringify({ what: what }));
  }

  async usage() {
    return Promise.all(this.helpers.map(async (h) => {
      const base = { name: h.name, url: h.url, down: h.down, cpu: h.state ? h.state.cpu : null, mem: h.state ? h.state.mem : null };
      try { return Object.assign(base, { usage: await this.request(h, "GET", "/helper/usage", { what: "usage" }) }); }
      catch (e) { return Object.assign(base, { down: e.message }); }
    }));
  }

  view() {
    return this.helpers.map((h) => ({ name: h.name, up: this.fresh(h), free: h.state ? h.state.free : 0,
      sessions: h.state ? h.state.sessions.length : 0 }));
  }
}

module.exports = { Overflow, sign, verify, Spent, parseUrl, AUDIENCE, PASS_MS };
