/* ============================================================
   FieldKit lens :: server — what runs on the rented server

   One small process:

     WS  /wisp/?pass=…   the Wisp server (wisp.js), for FieldKit
                         accounts only
     GET /lens/status    up, and the meter's state: the relay asks
                         this to decide between lens and the streamed
                         browser, and to put up (and take down) the
                         fallback notice
     GET /…              the client's files (Scramjet, libcurl.js, the
                         page that registers the service worker), with
                         the isolation headers they need

   WHO MAY USE IT. The relay knows the accounts; this server knows
   none. A person's panel asks the relay for a PASS (the same signed
   format and key as the browser helpers', overflow.js, with its own
   audience) and puts it in the WebSocket address, because a page
   cannot set headers on a WebSocket. The pass names the account, so
   the meter's daily share and the per-person limit follow the person,
   not the address. It lasts 12 hours and is not spent on use:
   libcurl.js reconnects to the same address by itself when a
   connection drops, and a person holding at most a few sockets at
   once (maxPerWho) is what limits a pass that leaks.

   The relay's public key is fetched from the relay, as a helper does
   (browser-helper.js RelayKey), and again after a pass fails to match.

   Configuration: lens/config.json (see config.example.json), or the
   file named by FK_LENS_CONFIG.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { Guard } = require("../relay/guard");
const { Blocklist } = require("../relay/blocklist");
const { verify } = require("../relay/overflow");
const { passOptions, AUD, PASS_MS } = require("../relay/lens-link");
const { WispServer } = require("./wisp");
const { Meter } = require("./meter");
const { Egress } = require("./egress");

const OPENS_PER_MIN = 30;

const DEFAULTS = {
  host: "0.0.0.0",
  port: 8080,
  relayUrl: "",
  dataDir: path.join(__dirname, "data"),
  clientDir: "",
  dnsFilter: "adult",
  capBytes: 0,
  personDayBytes: 0,
  maxPerWho: 4,
  /* "loopback": behind Caddy on the same machine, so the person's
     address is the last X-Forwarded-For entry when the connection comes
     from loopback. Anything else trusts no header. */
  trustProxy: "",
  /* A file holding a read-only Linode API token. With it, Linode's own
     count of the month's traffic is read every ten minutes and the
     meter catches up to it (meter.seen), a second stop on the bill. */
  providerTokenFile: "",
  /* Sites that refuse this server's address (YouTube) leave through an
     upstream proxy (egress.js): a JSON file { hosts, proxies }, kept out
     of config.json because bought proxies come with a login. */
  egressFile: ""
};

const ALLOW_EVERY_MS = 5 * 60 * 1000;
const PROVIDER_EVERY_MS = 10 * 60 * 1000;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function log(level, msg) { console.log(new Date().toISOString() + " " + level + " " + msg); }

function readConfig(file) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw new Error("lens: " + file + " is not valid JSON: " + e.message); }
  return Object.assign({}, DEFAULTS, c);
}

function start(opts) {
  opts = opts || {};
  const config = Object.assign({}, DEFAULTS, opts.config || {});
  const say = opts.log || log;
  fs.mkdirSync(config.dataDir, { recursive: true });

  const relayKey = opts.relayKey || new (require("../relay/browser-helper").RelayKey)(config.relayUrl);
  if (!opts.relayKey && !relayKey.base) say("ERROR", "lens: relayUrl is empty, so no pass can be checked and no one can use lens");
  relayKey.load().catch(() => {});

  let lists = opts.lists || null;
  if (!lists && !opts.judge) {
    lists = new Blocklist({ log: say, dir: path.join(config.dataDir, "blocklists") });
    lists.start().catch((e) => say("WARN", "lens: block lists did not start: " + e.message));
  }
  const judge = opts.judge || new Guard({ log: say, ports: "browser", lists, dnsFilter: config.dnsFilter,
    words: { place: "lens server", who: "a page" } });
  const meter = opts.meter || new Meter({ file: path.join(config.dataDir, "meter.json"), log: say,
    capBytes: config.capBytes, personDayBytes: config.personDayBytes });
  let egress = opts.egress || null;
  if (!egress && config.egressFile) {
    try {
      const e = JSON.parse(fs.readFileSync(config.egressFile, "utf8"));
      egress = new Egress({ hosts: e.hosts, proxies: e.proxies, log: say });
      say("INFO", "lens: " + egress.proxies.length + " egress proxy(ies) for " + egress.hosts.length + " site(s)");
    } catch (e) {
      if (e.code !== "ENOENT") say("WARN", "lens: " + config.egressFile + " could not be read (" + e.message + "); every site leaves directly");
    }
  }
  const wisp = new WispServer({ judge, meter, egress, log: say, maxPerWho: config.maxPerWho });

  /* The person's address, for the per-address limit. */
  const clientIp = (req) => {
    const a = String(req.socket.remoteAddress || "?");
    if (config.trustProxy === "loopback" && /^(127\.|::1$|::ffff:127\.)/.test(a)) {
      const xf = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (xf.length) return xf[xf.length - 1];
    }
    return a;
  };

  /* What admins allowed on the relay, so an ALLOW there opens here too. */
  const pullAllow = async () => {
    /* The relay address that last gave the key, or the first listed. */
    const base = relayKey.base || String(config.relayUrl || "").split(/[\s,]+/)[0].replace(/\/+$/, "");
    if (!lists || !base || opts.noPoll) return;
    try {
      const r = await fetch(base + "/browser/allow", { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!r.ok) return;
      const j = await r.json();
      if (j && Array.isArray(j.allow)) lists.setAllow(j.allow);
    } catch (e) { /* kept what it had */ }
  };
  pullAllow();
  const allowTimer = setInterval(pullAllow, ALLOW_EVERY_MS);
  if (allowTimer.unref) allowTimer.unref();

  /* Linode's own count, as a second stop on the bill. */
  let providerSaid = null;
  const pullProvider = async () => {
    if (!config.providerTokenFile || opts.noPoll) return;
    try {
      const token = fs.readFileSync(config.providerTokenFile, "utf8").trim();
      const r = await fetch("https://api.linode.com/v4/account/transfer", { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error("Linode answered " + r.status);
      const j = await r.json();
      meter.seen(Math.round((Number(j.used) || 0) * 1e9));
      providerSaid = null;
    } catch (e) {
      if (providerSaid !== e.message) say("WARN", "lens: could not read Linode's traffic count (" + e.message + "); this server's own count still applies");
      providerSaid = e.message;
    }
  };
  pullProvider();
  const providerTimer = setInterval(pullProvider, PROVIDER_EVERY_MS);
  if (providerTimer.unref) providerTimer.unref();

  const opens = new Map();
  const tooMany = (ip) => {
    const now = Date.now();
    const list = (opens.get(ip) || []).filter((t) => now - t < 60000);
    list.push(now);
    opens.set(ip, list);
    if (opens.size > 5000) opens.clear();
    return list.length > OPENS_PER_MIN;
  };

  const clientDir = config.clientDir ? path.resolve(config.clientDir) + path.sep : "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://lens");
    if (url.pathname === "/lens/status" && req.method === "GET") {
      const m = meter.view();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify({ up: true, state: m.state, month: m.month, fraction: m.fraction,
        open: wisp.sessions.size, key: !!relayKey.key, youtube: !!(egress && egress.usable()) }));
    }
    /* Why the site this person just tried did not open: asked by their
       own lens page, with their own pass, about one host. */
    /* POST since 0.11.0, so the host is in the body and not in an
       address a school's filter can read; GET is for older pages. */
    if (url.pathname === "/lens/why" && (req.method === "GET" || req.method === "POST")) {
      const answer = (pass, host) => {
        const v = relayKey.key ? verify(relayKey.key, pass, Date.now(), passOptions) : { ok: false };
        res.writeHead(v.ok ? 200 : 401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        if (!v.ok) return res.end("{}");
        const r = wisp.whyFor(String(v.claims.who), String(host || "").toLowerCase());
        return res.end(JSON.stringify(r ? { host: r.host, kind: r.kind, why: r.why } : {}));
      };
      if (req.method === "GET") return answer(url.searchParams.get("pass"), url.searchParams.get("host"));
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on("end", () => {
        let j = null;
        try { j = JSON.parse(body); } catch (e) { j = null; }
        answer(j && j.pass, j && j.host);
      });
      return;
    }
    if (!clientDir || (req.method !== "GET" && req.method !== "HEAD")) { res.writeHead(404); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ""); } catch (e) { res.writeHead(400); return res.end(); }
    if (!rel || rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(clientDir, rel);
    if (!file.startsWith(clientDir)) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (e, body) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        /* Scramjet's own files carry their version in the folder name
           and never change; ours are asked again each time, so an
           update reaches everyone at once. */
        "Cache-Control": /^v\//.test(rel) ? "public, max-age=2592000, immutable" : "no-cache" });
      res.end(req.method === "HEAD" ? undefined : body);
    });
  });

  const refuse = (sock, status) => {
    try { sock.end("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch (e) {}
  };

  server.on("upgrade", (req, sock, head) => {
    sock.on("error", () => { try { sock.destroy(); } catch (e) {} });
    let url;
    try { url = new URL(req.url, "http://lens"); } catch (e) { return sock.destroy(); }
    /* /wisp/?pass=… or /wisp/<pass>/: libcurl.js will only open a Wisp
       address that ends in "/", so the page puts the pass in the path. */
    const inPath = /^\/wisp\/([A-Za-z0-9_.-]{20,2048})\/$/.exec(url.pathname);
    if (url.pathname !== "/wisp/" && url.pathname !== "/wisp" && !inPath) return refuse(sock, "404 Not Found");
    if (inPath) url.searchParams.set("pass", inPath[1]);
    if (tooMany(clientIp(req))) return refuse(sock, "429 Too Many Requests");
    if (!relayKey.key) { if (relayKey.due && relayKey.due(true)) relayKey.load().catch(() => {}); return refuse(sock, "503 Service Unavailable"); }
    const v = verify(relayKey.key, url.searchParams.get("pass"), Date.now(), passOptions);
    if (!v.ok) {
      if (/signature/.test(v.why) && relayKey.due && relayKey.due(true)) relayKey.load().catch(() => {});
      return refuse(sock, "401 Unauthorized");
    }
    if (v.claims.what !== "lens" || typeof v.claims.who !== "string" || !v.claims.who) return refuse(sock, "401 Unauthorized");
    wisp.handle(req, sock, head, v.claims.who);
  });

  const keyTimer = setInterval(() => { if (relayKey.due && relayKey.due(false)) relayKey.load().catch(() => {}); }, 30000);
  if (keyTimer.unref) keyTimer.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      say("INFO", "lens: listening on " + config.host + ":" + server.address().port);
      resolve({
        server, wisp, meter, judge, egress, port: server.address().port,
        close() { clearInterval(keyTimer); clearInterval(allowTimer); clearInterval(providerTimer); wisp.close(); meter.close(); if (lists && lists.stop) lists.stop(); server.close(); }
      });
    });
  });
}

module.exports = { start, readConfig, passOptions, AUD, PASS_MS, TYPES };

if (require.main === module) {
  const file = process.env.FK_LENS_CONFIG || path.join(__dirname, "config.json");
  start({ config: readConfig(file) }).catch((e) => { log("ERROR", "lens: " + e.message); process.exit(1); });
}
