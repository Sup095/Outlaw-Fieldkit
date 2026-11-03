/* ============================================================
   FieldKit lens :: egress — some sites leave by another address

   YouTube refuses a rented server's address ("Sign in to confirm
   you're not a bot", LOGIN_REQUIRED) and plays for an ordinary one.
   So connections to the sites listed here are not opened from this
   server's own address but through an upstream proxy:

     - Cloudflare WARP, run beside lens as the container fk-warp
       (lens/warp/), which offers SOCKS5 on 127.0.0.1:1080; or
     - addresses bought from a proxy provider (SOCKS5 or HTTP CONNECT,
       with a login), listed in /srv/lens/egress.json.

   Everything else leaves as before. The guard (relay/guard.js) has
   already judged the connection, block lists and all, and named the
   address; the proxy is asked for exactly that address, never a name,
   so it cannot be pointed anywhere the guard did not allow.

   One person stays on one proxy (a hash of their account), because a
   video's address is tied to the address that asked for it. A proxy
   that fails is rested for a minute and the next one is used; with
   none left, the connection goes direct, which is what lens did
   before.

   Config (lens config.json "egress", or the file it names):
     { "hosts": ["youtube.com", "googlevideo.com", ...],
       "proxies": ["socks5://127.0.0.1:1080",
                   "socks5://user:pass@203.0.113.7:1080",
                   "http://user:pass@203.0.113.8:3128"] }
   ============================================================ */
"use strict";

const net = require("net");
const crypto = require("crypto");

/* What YouTube needs, and nothing else of Google's. */
const YOUTUBE = ["youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com", "ytimg.com",
  "ggpht.com", "youtubei.googleapis.com", "jnn-pa.googleapis.com", "youtube.googleapis.com"];

const REST_MS = 60 * 1000;
const SHAKE_MS = 10000;

function parseProxy(u) {
  let x;
  try { x = new URL(String(u || "")); } catch (e) { return null; }
  const kind = x.protocol === "socks5:" || x.protocol === "socks5h:" ? "socks5" : x.protocol === "http:" ? "http" : null;
  if (!kind || !x.hostname || !x.port) return null;
  return { kind, host: x.hostname.replace(/^\[|\]$/g, ""), port: Number(x.port),
    user: decodeURIComponent(x.username || ""), pass: decodeURIComponent(x.password || ""),
    /* Shown in status and logs: never the login. */
    name: kind + "://" + x.hostname + ":" + x.port, down: 0, fails: 0, used: 0 };
}

function hostMatches(host, suffixes) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return suffixes.some((s) => h === s || h.endsWith("." + s));
}

/* SOCKS5 (RFC 1928, login per RFC 1929): CONNECT to an address. */
function socksShake(tcp, p, address, port, done) {
  let buf = Buffer.alloc(0), step = 0;
  const ip6 = net.isIPv6(address);
  const fail = (why) => done(new Error("socks5 " + p.name + ": " + why));
  const ask = () => {
    const a = ip6 ? ipv6Bytes(address) : Buffer.from(address.split(".").map(Number));
    const port2 = Buffer.alloc(2); port2.writeUInt16BE(port, 0);
    tcp.write(Buffer.concat([Buffer.from([5, 1, 0, ip6 ? 4 : 1]), a, port2]));
    step = 2;
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (step === 0) {
      if (buf.length < 2) return;
      if (buf[0] !== 5) return fail("not a SOCKS5 proxy");
      const method = buf[1]; buf = buf.subarray(2);
      if (method === 0) return ask();
      if (method !== 2) return fail("no login method it accepts");
      const u = Buffer.from(p.user), w = Buffer.from(p.pass);
      tcp.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([w.length]), w]));
      step = 1;
      return;
    }
    if (step === 1) {
      if (buf.length < 2) return;
      if (buf[1] !== 0) return fail("login refused");
      buf = buf.subarray(2);
      return ask();
    }
    if (step === 2) {
      if (buf.length < 5) return;
      if (buf[1] !== 0) return fail("refused the connection (code " + buf[1] + ")");
      const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
      if (buf.length < len) return;
      tcp.removeListener("data", onData);
      done(null, buf.subarray(len));
    }
  };
  tcp.on("data", onData);
  const methods = p.user ? [0, 2] : [0];
  tcp.write(Buffer.from([5, methods.length].concat(methods)));
}

/* HTTP CONNECT, with Basic login when there is one. */
function httpShake(tcp, p, address, port, done) {
  let buf = Buffer.alloc(0);
  const where = (net.isIPv6(address) ? "[" + address + "]" : address) + ":" + port;
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) { if (buf.length > 16384) done(new Error("http " + p.name + ": answer too long")); return; }
    tcp.removeListener("data", onData);
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString("latin1"));
    if (!status || status[1] !== "200") return done(new Error("http " + p.name + ": answered " + (status ? status[1] : "nonsense")));
    done(null, buf.subarray(end + 4));
  };
  tcp.on("data", onData);
  tcp.write("CONNECT " + where + " HTTP/1.1\r\nHost: " + where + "\r\n" +
    (p.user ? "Proxy-Authorization: Basic " + Buffer.from(p.user + ":" + p.pass).toString("base64") + "\r\n" : "") + "\r\n");
}

function ipv6Bytes(a) {
  const halves = a.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = head.concat(new Array(8 - head.length - tail.length).fill("0"), tail);
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return b;
}

class Egress {
  /* opts: { hosts, proxies, log, now } */
  constructor(opts) {
    opts = opts || {};
    this.log = opts.log || (() => {});
    this.now = opts.now || Date.now;
    this.hosts = (Array.isArray(opts.hosts) && opts.hosts.length ? opts.hosts : YOUTUBE).map((h) => String(h).toLowerCase());
    this.proxies = (opts.proxies || []).map(parseProxy).filter(Boolean);
    (opts.proxies || []).forEach((u) => { if (!parseProxy(u)) this.log("WARN", "lens: egress proxy " + String(u).replace(/\/\/[^@/]*@/, "//…@") + " is not socks5:// or http:// with a port, so it is not used"); });
  }

  /* Whether this host leaves by a proxy at all. */
  wants(host) { return this.proxies.length > 0 && hostMatches(host, this.hosts); }

  /* The proxies to try for this person, their own first. */
  order(who) {
    const n = this.proxies.length;
    if (!n) return [];
    const h = crypto.createHash("sha256").update(String(who || "")).digest().readUInt32BE(0);
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.proxies[(h + i) % n]);
    const now = this.now();
    return out.filter((p) => p.down <= now).concat(out.filter((p) => p.down > now));
  }

  /* A socket to address:port through this person's proxy. Calls back
     (err, tcp, leftover) once the tunnel is open; tcp is a plain
     net.Socket from then on. On every proxy failing: (err). */
  open(who, address, port, cb) {
    const list = this.order(who);
    const tryNext = (i, lastErr) => {
      if (i >= list.length) return cb(lastErr || new Error("no proxy"));
      const p = list[i];
      const tcp = net.connect({ host: p.host, port: p.port });
      let done = false;
      const finish = (err, rest) => {
        if (done) return;
        done = true;
        clearTimeout(late);
        if (err) {
          try { tcp.destroy(); } catch (e) {}
          p.fails++;
          if (p.down <= this.now()) this.log("WARN", "lens: egress " + err.message + "; resting it a minute");
          p.down = this.now() + REST_MS;
          return tryNext(i + 1, err);
        }
        p.used++;
        tcp.removeListener("error", onErr);
        cb(null, tcp, rest && rest.length ? rest : null, p);
      };
      const onErr = (e) => finish(new Error(p.name + ": " + e.message));
      const late = setTimeout(() => finish(new Error(p.name + ": no answer")), SHAKE_MS);
      if (late.unref) late.unref();
      tcp.on("error", onErr);
      tcp.once("close", () => finish(new Error(p.name + ": closed")));
      tcp.on("connect", () => (p.kind === "socks5" ? socksShake : httpShake)(tcp, p, address, port, finish));
    };
    tryNext(0, null);
  }

  /* Up when at least one proxy is not resting. */
  usable() { const now = this.now(); return this.proxies.some((p) => p.down <= now); }

  view() {
    const now = this.now();
    return { proxies: this.proxies.map((p) => ({ name: p.name, up: p.down <= now, fails: p.fails, used: p.used })), hosts: this.hosts.length };
  }
}

module.exports = { Egress, parseProxy, hostMatches, YOUTUBE, ipv6Bytes };
