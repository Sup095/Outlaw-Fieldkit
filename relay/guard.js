/* ============================================================
   FieldKit relay :: guard — the only way out of the browser

   A tiny HTTP/CONNECT proxy on loopback that the streamed Chromium
   is launched pointed at. Every request it makes — pages,
   subresources, XHR, WebSockets, the lot — arrives here first.

   WHY A PROXY RATHER THAN CDP INTERCEPTION

   The obvious way to filter a CDP-driven browser is Fetch.enable
   and refuse in Fetch.requestPaused. That was the first design and
   it is not good enough, for one specific reason: it sees what the
   RENDERER asks for. It does not reliably see WebSocket handshakes,
   it does not see traffic from a service worker in every case, and
   every one of those gaps is a way around the check.

   A proxy sees the connection. There is no request Chromium can
   make that does not come through here, because Chromium was
   started with --proxy-bypass-list="<-loopback>" which removes the
   one exemption it has by default. That exemption is the whole
   reason this file exists in this shape:

   THE RELAY IS ON LOOPBACK. Without the bypass override, a page in
   the streamed browser could fetch http://127.0.0.1:25569/vault and
   read the encrypted vault straight out of the relay it is running
   inside. "The browser must not be able to access the rest of
   FieldKit" was already the rule when the browser was a fetch-and-
   rewrite proxy that had no network of its own. Now it is a real
   browser sitting INSIDE the trust boundary, and the rule needs a
   real mechanism instead of an accident of architecture.

   So: every address is resolved here, and every resolved address is
   checked against the private ranges before a socket is opened.
   Same rule the old proxy applied, moved to where it now has to be.

   AND THE DNS FILTER LIVES HERE TOO

   Resolution happens in this process, against whichever servers the
   config names — CleanBrowsing's adult+malware filter by default.
   That is a much stronger place for it than Chromium's own DoH
   flags, which are version-dependent, silently fall back, and can
   be sidestepped by a literal IP address. Here, a literal IP does
   not skip the check: it skips DNS and lands on the range check
   instead, which is the one that matters for safety.

   WHAT THIS IS NOT. It is not anonymity and it is not evasion. The
   browser identifies itself honestly as the Chromium it is. Nothing
   here rewrites a User-Agent, forges a header, or tries to look
   like residential traffic. When a site puts up a bot check, the
   person sees it and answers it — which is the entire point of
   streaming a real browser instead of scraping one.
   ============================================================ */
"use strict";

const http = require("http");
const net = require("net");
const dns = require("dns");
const { URL } = require("url");

/* CleanBrowsing's published resolvers. Named rather than pasted as
   bare IPs at the call site so that "which filter is this relay
   running" is answerable by reading one object. */
const DNS_PRESETS = {
  /* Pornography, plus phishing and malware. What was asked for. */
  adult: { name: "CleanBrowsing adult + malware",
    servers: ["185.228.168.10", "185.228.169.11"] },
  /* The above plus mixed-content sites, proxies/VPNs, and forced
     safe search on the big engines. Stricter than asked for. */
  family: { name: "CleanBrowsing family",
    servers: ["185.228.168.168", "185.228.169.168"] },
  /* Phishing and malware only — no content filtering at all. */
  security: { name: "CleanBrowsing security only",
    servers: ["185.228.168.9", "185.228.169.9"] },
  /* Escape hatch. Uses whatever the container was configured with. */
  system: { name: "the container's own resolver", servers: null }
};

/* CleanBrowsing answers a blocked name by pointing it at a block
   page rather than by refusing, so a resolution that lands on one
   of these is a filter hit and not a real host. Recognising them
   turns "a confusing page appeared" into a sentence that says what
   happened. */
const BLOCK_ANSWERS = new Set(["0.0.0.0", "::", "146.112.61.106"]);

function isPrivateAddress(ip) {
  const v = String(ip || "");
  if (net.isIPv4(v)) {
    const p = v.split(".").map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;          /* link-local + metadata */
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;  /* CGNAT, incl. tailnet */
    if (p[0] >= 224) return true;                            /* multicast + reserved */
    return false;
  }
  if (net.isIPv6(v)) {
    const s = v.toLowerCase();
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
    /* An IPv4 address wearing a v6 hat is still that address. */
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true;   /* unparseable is not something to open a socket to */
}

/* A byte budget per second, for RUNNER's sandboxes (the relay's own
   browser does not use one). It charges what has been sent and says
   how long to wait before reading more, so a job that downloads as
   fast as it can gets exactly its share of the house's line and no
   more. A quarter-second of burst keeps small requests snappy. */
class Bucket {
  constructor(bps) { this.bps = bps; this.debt = 0; this.at = Date.now(); }
  take(n) {
    const now = Date.now();
    this.debt = Math.max(0, this.debt - (now - this.at) * this.bps / 1000) + n;
    this.at = now;
    return Math.max(0, (this.debt - this.bps / 4) * 1000 / this.bps);
  }
}

/* src -> dst, slowed to the bucket's rate. Without a bucket it is
   just pipe(), which is what the relay's browser has always used. */
function flow(src, dst, bucket) {
  if (!bucket) return src.pipe(dst);
  src.on("data", (chunk) => {
    const more = dst.write(chunk);
    const wait = bucket.take(chunk.length);
    if (more && wait <= 0) return;
    src.pause();
    let need = (more ? 0 : 1) + (wait > 0 ? 1 : 0);
    const go = () => { if (--need === 0) src.resume(); };
    if (!more) dst.once("drain", go);
    if (wait > 0) setTimeout(go, wait);
  });
  src.on("end", () => { try { dst.end(); } catch (e) {} });
}

class Guard {
  constructor(opts) {
    opts = opts || {};
    this.log = opts.log || (() => {});
    this.port = 0;
    /* Where it listens. The relay's browser: loopback, any port. RUNNER's
       egress container: every interface of a container whose only
       neighbours are the sandboxes it serves (runnerd/egress.js). */
    this.bindHost = opts.host || "127.0.0.1";
    this.bindPort = opts.port || 0;
    /* Per-sandbox ceilings: { maxConns, upBps, downBps }. Keyed by the
       address a connection comes from, which is one sandbox each. */
    this.perClient = opts.perClient || null;
    this.clients = new Map();
    /* How refusals name things. The relay's browser by default. */
    this.words = Object.assign({ place: "relay", who: "this browser" }, opts.words || {});
    this.filter = opts.filter || (() => ({ ok: true }));
    this.stats = { allowed: 0, refusedPrivate: 0, refusedFilter: 0, refusedDns: 0 };
    /* THE LAST NO, SO SOMEBODY CAN BE TOLD WHY.

       A refused CONNECT cannot carry a message: the tunnel never
       opens, so there is no response body to put one in, and what
       the person sees is Chromium's own ERR_TUNNEL_CONNECTION_FAILED
       — which names the proxy as broken and says nothing about the
       filter that actually acted.

       So the reason is kept here for a few seconds and the engine
       reads it when a navigation lands on an error page. Attribution
       is by time rather than by session, because a CONNECT carries
       nothing that says which browser context made it. In practice
       one person is navigating at a time and the window is short;
       where it is wrong it is stale rather than invented, and it is
       only ever used to explain a failure that already happened. */
    this.lastRefusal = null;

    const preset = DNS_PRESETS[opts.dnsFilter] || DNS_PRESETS.adult;
    this.dnsName = preset.name;
    this.resolver = new dns.promises.Resolver();
    if (preset.servers) this.resolver.setServers(preset.servers);

    this.server = http.createServer();
    /* Absolute-form http:// requests. Rare now that everything is
       https, but a captive portal check or a plain-http site still
       arrives this way. */
    this.server.on("request", (req, res) => this._plain(req, res));
    /* Everything else: CONNECT, which is https and WebSockets. */
    this.server.on("connect", (req, sock, head) => this._tunnel(req, sock, head));
    this.server.on("clientError", (e, sock) => { try { sock.destroy(); } catch (x) {} });
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      /* Loopback only. This proxy has no authentication and does not
         need any, because nothing outside this container can reach
         it — but only if it is never bound anywhere else. */
      this.server.listen(this.bindPort, this.bindHost, () => {
        this.port = this.server.address().port;
        this.log("INFO", "guard: egress proxy on " + this.bindHost + ":" + this.port +
          " — dns via " + this.dnsName);
        resolve(this.port);
      });
    });
  }

  close() { try { this.server.close(); } catch (e) {} }

  /* null: no per-client limits. false: over the connection limit.
     Otherwise the client's shared buckets, released when done. */
  _admit(ip) {
    if (!this.perClient) return null;
    const key = String(ip || "?");
    let c = this.clients.get(key);
    if (!c) {
      if (this.clients.size > 1000) {
        for (const [k, v] of this.clients) if (!v.conns) this.clients.delete(k);
      }
      c = { conns: 0, up: new Bucket(this.perClient.upBps), down: new Bucket(this.perClient.downBps) };
      this.clients.set(key, c);
    }
    if (c.conns >= this.perClient.maxConns) return false;
    c.conns++;
    let gone = false;
    return { up: c.up, down: c.down, done: () => { if (!gone) { gone = true; c.conns--; } } };
  }

  /* Resolve, then judge. Returns {ok, address, why}. */
  async place(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");

    const no = (kind, why) => {
      this.lastRefusal = { host, why, kind, at: Date.now() };
      return { ok: false, why, kind };
    };

    const verdict = this.filter(host);
    if (!verdict.ok) {
      this.stats.refusedFilter++;
      return no("filter", verdict.why || "blocked by the " + this.words.place + "'s filter");
    }

    /* A literal address skips DNS, which is exactly why the range
       check below is the one that actually protects anything. */
    if (net.isIP(host)) {
      if (isPrivateAddress(host)) {
        this.stats.refusedPrivate++;
        return no("private", "that address is inside the " + this.words.place + "'s own network");
      }
      return { ok: true, address: host, family: net.isIPv6(host) ? 6 : 4 };
    }

    let addrs = [];
    try {
      const four = await this.resolver.resolve4(host).catch(() => []);
      const six = four.length ? [] : await this.resolver.resolve6(host).catch(() => []);
      addrs = four.length ? four.map((a) => ({ address: a, family: 4 }))
                          : six.map((a) => ({ address: a, family: 6 }));
    } catch (e) { addrs = []; }

    if (!addrs.length) {
      this.stats.refusedDns++;
      return no("dns", "that name did not resolve. The content filter blocks sites by " +
        "refusing to look them up, so this is what a filtered site looks like — but a " +
        "site that is simply down or misspelled looks the same.");
    }

    if (BLOCK_ANSWERS.has(addrs[0].address)) {
      this.stats.refusedDns++;
      return no("filtered", "the content filter on this " + this.words.place + " refused that site");
    }

    /* EVERY answer is checked, not just the first. A name that
       resolves to one public address and one loopback address is
       the oldest trick against a check that only reads [0]. */
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        this.stats.refusedPrivate++;
        return no("private", "that name points inside the " + this.words.place + "'s own network");
      }
    }

    this.stats.allowed++;
    return { ok: true, address: addrs[0].address, family: addrs[0].family };
  }

  async _tunnel(req, sock, head) {
    const [rawHost, rawPort] = splitAuthority(req.url);
    const port = Number(rawPort) || 443;
    const lim = this._admit(sock.remoteAddress);

    const deny = (code, why) => {
      this.log("INFO", "guard: refused CONNECT " + rawHost + " — " + why);
      try {
        sock.write("HTTP/1.1 " + code + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        sock.destroy();
      } catch (e) {}
    };

    /* Only the ports a browser has any business reaching. Without
       this the streamed browser is a general-purpose port scanner
       aimed at whatever the container can see. */
    if (lim === false) return deny("429 Too Many Requests", "too many connections open at once");
    if (lim) sock.on("close", lim.done);

    if (port !== 443 && port !== 80 && port !== 8080 && port !== 8443) {
      this.lastRefusal = { host: rawHost, kind: "port", at: Date.now(),
        why: "port " + port + " is not one " + this.words.who + " is allowed to open" };
      return deny("403 Forbidden", "port " + port + " is not one " + this.words.who + " may open");
    }

    const where = await this.place(rawHost);
    if (!where.ok) return deny("403 Forbidden", where.why);

    const up = net.connect({ host: where.address, port, family: where.family }, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      flow(sock, up, lim && lim.up);
      flow(up, sock, lim && lim.down);
    });
    up.setNoDelay(true);
    sock.setNoDelay(true);
    up.on("error", () => { try { sock.destroy(); } catch (e) {} });
    sock.on("error", () => { try { up.destroy(); } catch (e) {} });
    up.setTimeout(120000, () => up.destroy());
  }

  async _plain(req, res) {
    /* Same reasoning as the upgrade handler in server.js: a client
       that resets mid-request emits "error" on a stream nobody is
       listening to, and an unhandled one of those ends the process.
       A browser abandons requests constantly — every navigation away
       from a half-loaded page is a handful of them. */
    req.on("error", () => { try { res.destroy(); } catch (e) {} });
    res.on("error", () => {});
    const lim = this._admit(req.socket.remoteAddress);
    if (lim === false) {
      res.writeHead(429, { "Content-Type": "text/plain", "Content-Length": 26 });
      return res.end("too many connections open\n");
    }
    if (lim) res.on("close", lim.done);
    let u;
    try { u = new URL(req.url); } catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("the guard proxy expects absolute-form requests");
    }

    const deny = (why) => {
      this.log("INFO", "guard: refused " + u.hostname + " — " + why);
      const body = "This site was not opened.\n\n" + why + "\n";
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };

    const port = Number(u.port) || 80;
    if (port !== 80 && port !== 8080) return deny("port " + port + " is not one " + this.words.who + " may open");

    const where = await this.place(u.hostname);
    if (!where.ok) return deny(where.why);

    const headers = Object.assign({}, req.headers);
    delete headers["proxy-connection"];

    const up = http.request({
      host: where.address, port, family: where.family,
      method: req.method, path: (u.pathname || "/") + (u.search || ""),
      headers: Object.assign(headers, { host: u.host })
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      flow(upRes, res, lim && lim.down);
    });
    up.on("error", (e) => {
      if (res.headersSent) return res.destroy();
      const body = "Could not reach that site: " + e.message + "\n";
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    });
    flow(req, up, lim && lim.up);
  }
}

function splitAuthority(authority) {
  const s = String(authority || "");
  /* [::1]:443 has colons inside the host, so the last one wins. */
  const i = s.lastIndexOf(":");
  if (i < 0 || s.indexOf("]") > i) return [s.replace(/^\[|\]$/g, ""), ""];
  return [s.slice(0, i).replace(/^\[|\]$/g, ""), s.slice(i + 1)];
}

/* Only a FRESH refusal explains a failure that just happened. An
   old one would turn an ordinary "that site is down" into a
   confident and wrong claim about the filter. */
Guard.prototype.whyRefused = function (withinMs) {
  const r = this.lastRefusal;
  if (!r) return null;
  /* == null, not ||. A caller asking for a zero-millisecond
     window means "only something that just happened", and with ||
     that read as "unset" and silently became six seconds. */
  const window = withinMs == null ? 6000 : withinMs;
  if (Date.now() - r.at > window) return null;
  return r;
};

module.exports = { Guard, isPrivateAddress, DNS_PRESETS, splitAuthority, BLOCK_ANSWERS, Bucket, flow };
