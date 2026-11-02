/* ============================================================
   FieldKit :: upcap — the most FieldKit may send, as a hard ceiling

   The house has one upload line (21 Mbit/s) and other servers on it
   that must not be interrupted. The load lines in fairness.js and
   runnerd/access.js decide who may START something, and step video
   down; neither stops a big download or a busy page from taking the
   whole line. This does: every socket a FieldKit server accepted is
   paced through one shared budget, so whatever is asked of it, the
   bytes leave no faster than the ceiling.

   HOW. Each accepted socket's writes go through a token bucket shared
   by all of them, in slices of 16 KB, so one large response cannot
   hold the line while everything else waits behind it: a page's
   video and somebody's download take turns. A write that has to wait
   is held, not dropped, and the socket reports itself full meanwhile,
   so anything piping into it (the RUNNER and helper pipes, file
   downloads) slows at its source instead of piling up in memory.

   NOT PACED: peers on the tailnet (100.64.0.0/10) and the home
   network (192.168.0.0/16, fc00::/7). Those bytes never cross the
   house's upload: on Bastion 2 the relay's own connections arrive
   from its tailnet address, and the relay paces them on their way
   out. Loopback IS paced: the relay's tunnel (cloudflared) runs
   inside its container and connects from 127.0.0.1, so that is
   exactly the traffic that goes to the internet.

   Used by the relay (server.js) and by runnerd (server.js); each sets
   its rate to the ceiling less what the other reports sending.
   ============================================================ */
"use strict";

const net = require("net");

const SLICE = 16 * 1024;
/* Left out of the ceiling for what neither server paces itself but
   still leaves the house, each held to its own total: RUNNER's programs
   through fk-egress (about 1 Mbit/s for all) and pages uploading
   through the browser helpers on Bastion 2 (HELPER_UP_BPS each). */
const RESERVE_KBPS = 2000;
const HELPER_UP_BPS = 62 * 1024;

function v4(addr) {
  const a = String(addr || "").replace(/^::ffff:/i, "");
  return net.isIPv4(a) ? a.split(".").map(Number) : null;
}

/* True for a peer whose bytes do not use the house's upload. */
function nearby(addr) {
  const q = v4(addr);
  if (q) return (q[0] === 100 && q[1] >= 64 && q[1] <= 127) || (q[0] === 192 && q[1] === 168);
  const s = String(addr || "").toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(s);
}

class UpCap {
  /* opts: bps (bytes a second; 0 = no pacing), exempt(addr) -> bool, now */
  constructor(opts) {
    opts = opts || {};
    this.now = opts.now || Date.now;
    this.exempt = opts.exempt || nearby;
    this.bps = 0;
    this.debt = 0;
    this.at = this.now();
    this.sent = 0;            /* bytes written by paced sockets */
    this.waited = 0;          /* writes that had to wait */
    this.open = 0;
    this.setRate(opts.bps || 0);
  }

  setRate(bps) {
    this.bps = Math.max(0, Math.round(Number(bps) || 0));
  }

  /* How long a write of n bytes must wait, and the bytes booked. */
  take(n) {
    this.sent += n;
    if (!this.bps) return 0;
    const now = this.now();
    this.debt = Math.max(0, this.debt - (now - this.at) * this.bps / 1000) + n;
    this.at = now;
    /* A quarter of a second's worth may go at once: enough that a
       person's click is not queued behind a frame, little enough that
       the line never sees a burst it notices. */
    return Math.max(0, (this.debt - this.bps / 4) * 1000 / this.bps);
  }

  /* Every socket this server accepts from now on. */
  attach(server) {
    server.on("connection", (sock) => this.wrap(sock));
    return this;
  }

  wrap(sock) {
    if (!sock || sock.__upcap) return sock;
    sock.__upcap = true;
    if (this.exempt(sock.remoteAddress)) return sock;
    const self = this;
    const raw = sock._write;
    this.open++;
    sock.once("close", () => { self.open--; });
    /* One write at a time through _write: with _writev gone, Node
       hands buffered writes over one by one, each through the pace. */
    sock._writev = null;
    sock._write = function (chunk, encoding, cb) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
      const go = (part, done) => {
        const wait = self.take(part.length);
        if (wait <= 0) return raw.call(sock, part, "buffer", done);
        self.waited++;
        const t = setTimeout(() => raw.call(sock, part, "buffer", done), wait);
        if (t.unref) t.unref();
      };
      if (buf.length <= SLICE) return go(buf, cb);
      let at = 0;
      const next = (err) => {
        if (err || at >= buf.length) return cb(err);
        const part = buf.subarray(at, at + SLICE);
        at += part.length;
        go(part, next);
      };
      next();
    };
    return sock;
  }

  view() {
    return { kbps: Math.round(this.bps * 8 / 1000), sent: this.sent, waited: this.waited, open: this.open };
  }
}

/* What the pace should be, in bytes a second: the ceiling (Mbit/s),
   less 5% for the tunnel's own framing, less what else is sending
   (kbit/s), never below a quarter of the ceiling so neither side can
   starve the other on a stale report. */
function paceFor(capMbps, othersKbps) {
  const cap = Math.max(0.1, Number(capMbps) || 0) * 1000 * 0.95;
  const left = Math.max(cap / 4, cap - Math.max(0, Number(othersKbps) || 0));
  return Math.round(left * 1000 / 8);
}

/* Bytes a second over the last interval, from a counter. */
class Rate {
  constructor(read, now) { this.read = read; this.now = now || Date.now; this.prev = null; this.kbps = 0; }
  sample() {
    const v = this.read(), t = this.now(), p = this.prev;
    if (p && t > p.t) this.kbps = Math.max(0, Math.round((v - p.v) * 8 / (t - p.t)));
    this.prev = { v, t };
    return this.kbps;
  }
}

module.exports = { UpCap, Rate, nearby, paceFor, SLICE, RESERVE_KBPS, HELPER_UP_BPS };
