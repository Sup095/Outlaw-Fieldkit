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
   running" is answerable by reading one object.

   Each ends with a second filter of the same kind, from another
   company, asked only when CleanBrowsing does not answer at all (a
   timeout or a server error; a "no such name" is an answer and is
   not asked twice). Without it, CleanBrowsing having a bad hour was
   every site failing at once, and looking like the filter. */
const DNS_PRESETS = {
  /* Pornography, plus phishing and malware. What was asked for.
     Behind it, Cloudflare for Families: malware and adult. */
  adult: { name: "CleanBrowsing adult + malware",
    servers: ["185.228.168.10", "185.228.169.11", "1.1.1.3", "1.0.0.3"] },
  /* The above plus mixed-content sites, proxies/VPNs, and forced
     safe search on the big engines. Stricter than asked for. */
  family: { name: "CleanBrowsing family",
    servers: ["185.228.168.168", "185.228.169.168", "1.1.1.3", "1.0.0.3"] },
  /* Phishing and malware only — no content filtering at all.
     Behind it, Quad9, which blocks the same kind of thing. */
  security: { name: "CleanBrowsing security only",
    servers: ["185.228.168.9", "185.228.169.9", "9.9.9.9", "149.112.112.112"] },
  /* Escape hatch. Uses whatever the container was configured with. */
  system: { name: "the container's own resolver", servers: null }
};

/* THE SECOND OPINION. When the filter finds nothing for a name, an
   unfiltered resolver is asked the same question, and only to decide
   what to say and whether an allowed name may still open. Its answer
   never opens a site the filter refused unless the lists allow that
   site (blocklist.js: an admin's ALLOW, or KEEP).

   Found on YouTube (2026-11-02): its player tries video hosts that do
   not exist anywhere (Google's own nameserver says so), and the guard
   said "the content filter blocks sites by refusing to look them up",
   so the filter took the blame for a name nobody has. Now a name that
   is missing everywhere says that, and the filter is named only when
   it was the filter. */
const PLAIN_DNS = ["1.1.1.1", "8.8.8.8"];

/* How long an answer is kept. A video page opens the same few hosts
   dozens of times a minute; a short cache saves those lookups and
   cannot keep a changed name wrong for long. */
const DNS_CACHE_MS = 60000;
const DNS_MISS_MS = 15000;
const DNS_CACHE_MAX = 2000;
/* The same refusal of the same name is written to the log once a minute. */
const LOG_REPEAT_MS = 60000;

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

/* Two limits on one direction: a sandbox's own, and everybody's
   together (upTotal). Whichever wants the longer wait wins. */
function both(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return { take: (n) => Math.max(a.take(n), b.take(n)) };
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
    /* What no one may open (blocklist.js). Ads and trackers are refused
       without a log line each, because a page asks for dozens a second:
       they are counted instead. */
    this.lists = opts.lists || null;
    /* Which ports may be opened. "web" (the default, RUNNER's jobs):
       80, 443, 8080, 8443. "browser": those, and any port from 1024 up,
       because games keep their servers there (Photon, which many web
       games use, is on 19090-19093). Still only to public addresses,
       and never the well-known ports below 1024 that mail and other
       services listen on. */
    this.ports = opts.ports === "browser" ? "browser" : "web";
    /* What everything through this guard may send to the internet,
       together: a { take(n) -> ms } (upcap.js, or a Bucket). Pages
       that upload, and programs that do, use the house's upload too. */
    this.upTotal = opts.upTotal || null;
    this.stats = { allowed: 0, refusedPrivate: 0, refusedFilter: 0, refusedDns: 0, refusedAds: 0 };
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
    /* Short timeouts: c-ares's own (5 s, four tries per server) meant a
       filter that had gone quiet held each page for most of a minute
       before the backup filter was asked. */
    this.filtered = !!preset.servers;
    this.resolver = opts.resolver || new dns.promises.Resolver({ timeout: 2500, tries: 2 });
    if (preset.servers && !opts.resolver) this.resolver.setServers(preset.servers);
    /* "system" filters nothing, so there is no second opinion to ask. */
    this.plain = opts.plainResolver || null;
    if (!this.plain && this.filtered) {
      this.plain = new dns.promises.Resolver({ timeout: 2500, tries: 1 });
      this.plain.setServers(PLAIN_DNS);
    }
    this.cache = new Map();          /* host -> { at, addrs, miss } */
    this.logged = new Map();         /* host|why -> when it was last written */

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

  /* Ports a connection may go to. plain: an http:// request, which on
     the web ports means 80 and 8080 only. */
  portOk(port, plain) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    if (plain ? (port === 80 || port === 8080) : (port === 443 || port === 80 || port === 8080 || port === 8443)) return true;
    return this.ports === "browser" && port >= 1024;
  }

  /* Resolve, then judge. Returns {ok, address, why}. */
  async place(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");

    const no = (kind, why) => {
      this.lastRefusal = { host, why, kind, at: Date.now() };
      return { ok: false, why, kind };
    };

    const listed = this.lists && this.lists.match(host);
    if (listed && listed.cat === "ads") {
      this.stats.refusedAds++;
      return { ok: false, why: "an ad or tracker (the browser's ad blocker)", kind: "ads", quiet: true };
    }
    if (listed) {
      this.stats.refusedFilter++;
      return no(listed.cat, "that site is " + listed.why);
    }
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

    const hit = this._cached(host);
    let addrs = hit ? hit.addrs : await lookupSteady(this.resolver, host);
    if (!hit) this._remember(host, addrs);

    let overridden = false;
    const refused = !addrs.length || BLOCK_ANSWERS.has(addrs[0].address);
    if (refused) {
      /* Asked only now, and its answer kept apart from the filter's. */
      const second = this.plain ? await this._second(host) : null;
      const real = (second || []).filter((a) => !BLOCK_ANSWERS.has(a.address));
      if (!real.length) {
        this.stats.refusedDns++;
        if (!this.filtered || second) {
          return no("missing", "that name does not exist" + (second ?
            " (an unfiltered lookup found nothing either, so this is not the filter)" : "") +
            ". The address may be misspelled, or the site gone.");
        }
        /* The unfiltered resolver did not answer, so which it was
           cannot be told, and the message does not pretend to. */
        return no("dns", "that name did not resolve. It may be misspelled or gone, or the " +
          "content filter refused it.");
      }
      if (this.lists && this.lists.allows && this.lists.allows(host)) {
        /* An admin's ALLOW, or one of the hosts that only carry a big
           site's own media: opened, and still range-checked below. */
        addrs = real;
        overridden = true;
      } else {
        this.stats.refusedDns++;
        if (this.lists && this.lists.noteRefused) this.lists.noteRefused(host, "filter");
        return no("filtered", "the content filter on this " + this.words.place + " refused that site " +
          "(it exists, but the filter would not look it up)");
      }
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

    if (overridden) this._note("INFO", host, "guard: the DNS filter refused " + host + ", which is allowed, so it was opened anyway");
    this.stats.allowed++;
    return { ok: true, address: addrs[0].address, family: addrs[0].family };
  }

  async _tunnel(req, sock, head) {
    const [rawHost, rawPort] = splitAuthority(req.url);
    const port = Number(rawPort) || 443;
    const lim = this._admit(sock.remoteAddress);

    const deny = (code, why) => {
      this._note("INFO", rawHost, "guard: refused CONNECT " + rawHost + " — " + why);
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

    if (!this.portOk(port)) {
      this.lastRefusal = { host: rawHost, kind: "port", at: Date.now(),
        why: "port " + port + " is not one " + this.words.who + " is allowed to open" };
      return deny("403 Forbidden", "port " + port + " is not one " + this.words.who + " may open");
    }

    const where = await this.place(rawHost);
    if (!where.ok && where.quiet) { try { sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); } catch (e) {} return; }
    /* A name that would not resolve is not a refusal, and "Forbidden" on
       something that opens a moment later is the wrong thing to say. */
    if (!where.ok) return deny(where.kind === "dns" ? "502 Bad Gateway" : "403 Forbidden", where.why);

    const up = net.connect({ host: where.address, port, family: where.family }, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      flow(sock, up, both(lim && lim.up, this.upTotal));
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

    const deny = (why, status) => {
      this._note("INFO", u.hostname, "guard: refused " + u.hostname + " — " + why);
      const body = "This site was not opened.\n\n" + why + "\n";
      res.writeHead(status || 403, { "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };

    const port = Number(u.port) || 80;
    if (!this.portOk(port, true)) return deny("port " + port + " is not one " + this.words.who + " may open");

    const where = await this.place(u.hostname);
    if (!where.ok && where.quiet) { res.writeHead(403, { "Content-Length": 0 }); return res.end(); }
    if (!where.ok) return deny(where.why, where.kind === "dns" ? 502 : 403);

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
    flow(req, up, both(lim && lim.up, this.upTotal));
  }
}

/* A resolver's addresses for a name: v4 first, v6 only if there are
   none. .answered is false when nobody answered at all (a timeout, a
   server error), which is not the same thing as "no such name". */
async function lookup(resolver, host) {
  /* Each family keeps its own verdict. "Nothing for this name" is an
     answer only when EVERY family that was asked gave one: an A lookup
     that timed out followed by an AAAA lookup that said "no such
     record" used to count as an answer, so a hiccup in DNS was
     remembered as "that name does not exist" and the site was refused
     for fifteen seconds, then opened on a refresh. */
  const ask = (fn) => resolver[fn](host).then((a) => ({ list: a || [], ok: true }), (e) => ({
    list: [], ok: !!(e && (e.code === "ENOTFOUND" || e.code === "ENODATA"))
  }));
  const four = await ask("resolve4");
  const six = four.list.length ? { list: [], ok: true } : await ask("resolve6");
  const addrs = four.list.length ? four.list.map((a) => ({ address: a, family: 4 }))
                                 : six.list.map((a) => ({ address: a, family: 6 }));
  addrs.answered = addrs.length > 0 || (four.ok && six.ok);
  return addrs;
}

/* One more try when nobody answered, a moment later: most of these
   are a single lost packet. */
async function lookupSteady(resolver, host) {
  let addrs = await lookup(resolver, host);
  for (let i = 0; i < 2 && !addrs.answered; i++) {
    await new Promise((r) => setTimeout(r, 120));
    addrs = await lookup(resolver, host);
  }
  return addrs;
}

Guard.prototype._cached = function (host) {
  const c = this.cache.get(host);
  if (!c) return null;
  if (Date.now() - c.at > (c.addrs.length ? DNS_CACHE_MS : DNS_MISS_MS)) { this.cache.delete(host); return null; }
  return c;
};

/* Only real answers are kept: a timeout is asked again next time. */
Guard.prototype._remember = function (host, addrs) {
  if (!addrs.answered) return;
  if (this.cache.size >= DNS_CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
  this.cache.set(host, { at: Date.now(), addrs: addrs });
};

/* The unfiltered answer, or null if the unfiltered resolver did not
   answer. Cached under its own key, so the two are never mixed. */
Guard.prototype._second = async function (host) {
  const hit = this._cached(" plain " + host);
  if (hit) return hit.addrs;
  const a = await lookupSteady(this.plain, host);
  this._remember(" plain " + host, a);
  return a.answered ? a : null;
};

/* One log line per name and reason a minute, however often a page asks. */
Guard.prototype._note = function (level, host, msg) {
  const k = host + "|" + msg;
  const now = Date.now();
  if (now - (this.logged.get(k) || 0) < LOG_REPEAT_MS) return;
  if (this.logged.size > 500) this.logged.clear();
  this.logged.set(k, now);
  this.log(level, msg);
};

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
Guard.prototype.whyRefused = function (withinMs, host) {
  const r = this.lastRefusal;
  if (!r) return null;
  /* And only one about the page that failed. A video host a player
     tried a second earlier is not why the page did not open: blaming
     it was how YouTube's missing hosts came to look like the filter. */
  if (host && r.host !== String(host).toLowerCase()) return null;
  /* == null, not ||. A caller asking for a zero-millisecond
     window means "only something that just happened", and with ||
     that read as "unset" and silently became six seconds. */
  const window = withinMs == null ? 6000 : withinMs;
  if (Date.now() - r.at > window) return null;
  return r;
};

module.exports = { Guard, isPrivateAddress, DNS_PRESETS, splitAuthority, BLOCK_ANSWERS, Bucket, flow, both };
