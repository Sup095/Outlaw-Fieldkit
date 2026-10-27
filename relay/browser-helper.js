#!/usr/bin/env node
/* ============================================================
   FieldKit relay :: browser-helper — streamed-browser sessions on
   another machine, for a relay that is full

   The same image as the relay, started with a config.json that has a
   "helper" block, and run as a Pterodactyl server of its own on
   Bastion 2 so its processor and memory show in the panel beside the
   relay's. start.js runs this instead of server.js when it sees that
   block.

   It is a browser and nothing else: no vault, no accounts, no
   messaging, no tunnel. It is never reached from the internet. The
   relay (overflow.js) connects to it over the home network or the
   tailnet and passes a panel's socket straight through, so a panel
   only ever talks to the relay's own address.

   Everything it is asked must carry a PASS signed by the relay, whose
   public key it fetches by itself from helper.relayUrl (the relay's
   ordinary public address). A request without one gets nothing, so a
   stranger on the home network who finds the port gets nothing.

     GET  /health          up or not (no pass needed; says nothing)
     GET  /helper/state    free sessions, load, whose sessions are here
     GET  /helper/usage    what each session is using, for ADMIN
     POST /helper/clear    forget a session's cookies or everything
     GET  /browser/file/x  a finished download, by its link
     POST /browser/put/x   a file for a page's "choose file"
     WS   /browser/stream  one panel, passed through by the relay
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { verify, Spent } = require("./overflow");
const browserRoute = require("./browser-route");
const browse = require("./browse");
const { Fairness } = require("./fairness");

const KEY_EVERY_MS = 10 * 60 * 1000;
const KEY_RETRY_MS = 30 * 1000;
const MAX_BODY = 4096;

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

/* Same places as server.js and start.js look. */
function configPath() {
  return [process.env.FK_CONFIG, path.join(__dirname, "config.json"), "/home/container/config.json"]
    .filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

function readConfig(file) {
  let raw = {};
  if (file) {
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { log("ERROR", "config.json is not valid JSON: " + e.message); process.exit(1); }
  }
  const c = Object.assign({ host: "0.0.0.0", port: 8080 }, raw);
  c.helper = Object.assign({ relayUrl: "" }, raw.helper || {});
  c.browser = Object.assign({}, raw.browser || {}, { enabled: true });
  delete c.browser.helpers;
  c.browse = Object.assign({}, raw.browse || {});
  c.dataDir = path.resolve(file ? path.dirname(file) : __dirname, raw.dataDir || "data");
  if (process.env.SERVER_PORT) c.port = Number(process.env.SERVER_PORT);
  return c;
}

/* The relay's public key, from the relay. */
class RelayKey {
  constructor(base, fetchFn) {
    this.base = String(base || "").trim().replace(/\/+$/, "");
    this.fetch = fetchFn || ((u) => fetch(u, { signal: AbortSignal.timeout(8000), redirect: "error" }));
    this.key = null;
    this.at = 0;
    this.tried = 0;
    this.said = null;
  }
  async load() {
    this.tried = Date.now();
    try {
      const r = await this.fetch(this.base + "/browser/helper-key");
      if (!r.ok) throw new Error("it answered " + r.status + (r.status === 404 ? " (is browser.helpers set in the relay's config?)" : ""));
      const j = await r.json();
      this.key = crypto.createPublicKey(String(j && j.key || ""));
      this.at = Date.now();
      if (this.said !== "ok") log("INFO", "helper: have the relay's key from " + this.base);
      this.said = "ok";
    } catch (e) {
      if (this.said !== e.message) log("WARN", "helper: could not fetch the relay's key from " + this.base + " — " + e.message);
      this.said = e.message;
    }
    return !!this.key;
  }
  /* Again every ten minutes, or sooner after a pass did not match. */
  due(mismatch) {
    const since = Date.now() - this.tried;
    return mismatch ? since > KEY_RETRY_MS : (!this.key && since > KEY_RETRY_MS) || since > KEY_EVERY_MS;
  }
}

function start(opts) {
  opts = opts || {};
  const config = opts.config || readConfig(configPath());
  const relayKey = opts.relayKey || new RelayKey(config.helper.relayUrl);
  const spent = new Spent();
  const meter = new Fairness();
  fs.mkdirSync(config.dataDir, { recursive: true });

  if (!relayKey.base) log("ERROR", "helper: helper.relayUrl is empty, so no pass can ever be checked — set it to the relay's https address");
  browse.init({ dataDir: config.dataDir, config: config.browse, log: log });
  const engine = browserRoute.init({ config: config.browser, log: log, filter: (host) => browse.hostVerdict(host) });

  /* The claims of a good pass for `what`, or null. */
  async function passOf(req, what) {
    const text = req.headers["x-fieldkit-pass"];
    if (!text) return null;
    if (relayKey.due(false)) await relayKey.load();
    if (!relayKey.key) return null;
    let v = verify(relayKey.key, text);
    if (!v.ok && /signature/.test(v.why) && relayKey.due(true) && await relayKey.load()) v = verify(relayKey.key, text);
    if (!v.ok || v.claims.what !== what || !spent.use(v.claims)) return null;
    return v.claims;
  }

  const send = (res, status, body) => {
    const t = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(t),
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(t);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on("end", () => {
      if (size > MAX_BODY) return reject(new Error("too big"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, "http://helper"); } catch (e) { return send(res, 400, { error: "bad url" }); }
    const p = url.pathname.replace(/\/+$/, "");
    try {
      if (p === "/health" && req.method === "GET") {
        return send(res, 200, { ok: true, service: "fieldkit-browser-helper", key: !!relayKey.key });
      }
      if (p === "/helper/state" && req.method === "GET") {
        const c = await passOf(req, "state");
        if (!c) return send(res, 401, { error: "no pass" });
        browserRoute.setHouseStep(c.step | 0);
        const m = meter.sample();
        const st = engine.status();
        return send(res, 200, { ready: !!st.available, free: Math.max(0, engine.cfg.maxSessions - engine.sessions.size),
          max: engine.cfg.maxSessions, cpu: m.cpu, mem: m.mem,
          sessions: Array.from(engine.sessions.keys()), kept: Array.from(engine.kept.keys()) });
      }
      if (p === "/helper/usage" && req.method === "GET") {
        if (!await passOf(req, "usage")) return send(res, 401, { error: "no pass" });
        url.pathname = "/browser/usage";
        await browserRoute.route(req, res, url, { send, readBody, authorise: () => "relay", tierOf: () => "admin" });
        return;
      }
      if (p === "/helper/clear" && req.method === "POST") {
        const c = await passOf(req, "clear");
        if (!c || !c.who) return send(res, 401, { error: "no pass" });
        url.pathname = "/browser/clear";
        await browserRoute.route(req, res, url, { send, readBody, authorise: () => String(c.who) });
        return;
      }
      if (/^\/browser\/(file|put)\/[0-9a-f]+$/.test(p)) {
        if (!await passOf(req, "link")) return send(res, 401, { error: "no pass" });
        await browserRoute.route(req, res, url, { send, readBody, authorise: () => null });
        return;
      }
      send(res, 404, { error: "this is a browser helper; the relay is the address to use" });
    } catch (e) {
      log("ERROR", req.method + " " + p + ": " + e.message);
      if (!res.headersSent) send(res, 500, { error: e.message });
    }
  });

  server.on("upgrade", async (req, sock, head) => {
    sock.on("error", () => { try { sock.destroy(); } catch (e) {} });
    const no = () => {
      try { sock.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); setTimeout(() => sock.destroy(), 2000).unref(); } catch (e) {}
    };
    let url;
    try { url = new URL(req.url, "http://helper"); } catch (e) { return no(); }
    if (!browserRoute.isStreamUpgrade(url)) return no();
    const c = await passOf(req, "stream");
    if (!c || typeof c.who !== "string" || !c.who || ["guest", "member", "admin"].indexOf(c.tier) < 0) return no();
    browserRoute.serve(req, sock, head, c.who, c.tier, { linkBase: "/browser/via/" + (c.via | 0) + "/" }).catch((e) => {
      log("WARN", "helper: stream failed — " + e.message);
      try { sock.destroy(); } catch (x) {}
    });
  });

  server.on("error", (e) => {
    log("ERROR", "could not listen on " + config.host + ":" + config.port + ": " + e.message);
    process.exit(1);
  });

  return new Promise((resolve) => {
    server.listen(config.port, config.host, async () => {
      log("INFO", "fieldkit browser helper listening on " + config.host + ":" + server.address().port);
      log("INFO", "helper: up to " + engine.cfg.maxSessions + " session(s); the relay at " + (relayKey.base || "(not set)") + " decides who comes here");
      if (relayKey.base && !opts.relayKey) await relayKey.load();
      log("INFO", "routes: GET /health  |  GET /helper/state  |  GET /helper/usage  |  POST /helper/clear  |  WS /browser/stream (relay passes only)");
      /* The phrase the egg waits for (see server.js). */
      console.log("Server started");
      resolve({ server, engine, relayKey });
    });
  });
}

if (require.main === module) {
  start().then(({ server, engine }) => {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        log("INFO", sig + " received, shutting down");
        try { engine.stop(); } catch (e) {}
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      });
    }
  });
}

module.exports = { start, readConfig, RelayKey };
