/* ============================================================
   FieldKit lens :: wisp — the server end of the lighter browser

   Lens runs pages in the person's own browser, through Scramjet (a
   service worker that rewrites them) and libcurl.js (TLS done in the
   page, in WebAssembly). What crosses the network is Wisp: many TCP
   connections carried inside one WebSocket. This is the far end of
   that WebSocket. It opens the TCP connections the page asks for and
   moves bytes; it never sees a page in the clear, because the TLS
   ends in the person's browser.

   Why our own and not wisp-js: the one place anything can be refused
   is here, when a connection is asked for, and everything the relay
   already refuses must be refused at exactly that point —

     - the block lists (ads, malware, adult; blocklist.js),
     - addresses inside the network this server sits in,
     - names the filtering resolver will not answer,
     - ports a page has no business opening,
     - and, new for lens, the month's spending ceiling (meter.js).

   relay/guard.js already does the first four for the streamed
   browser's Chromium, in one call (place) that has been tested against
   every trick it knows about. This file reuses it rather than
   re-deriving any of it, so the two browsers cannot disagree.

   THE PROTOCOL (Wisp v1; the spec is CC-BY-4.0). Every WebSocket
   message is one binary packet:

     type u8 | stream id u32 LE | payload

     CONNECT  0x01  kind u8 (1 TCP, 2 UDP) | port u16 LE | hostname
     DATA     0x02  bytes
     CONTINUE 0x03  how many more DATA packets the client may send u32 LE
     CLOSE    0x04  reason u8

   The server speaks first: CONTINUE on stream 0, the credit every new
   stream starts with. UDP is refused (nothing lens runs needs it).

   Flow control in v1 runs one way only, client to server, counted in
   packets. The other way, a page that reads slowly must not make this
   server hold everything the internet sends: when the WebSocket's own
   buffer passes highWater, every TCP connection of that session stops
   reading until it drains.
   ============================================================ */
"use strict";

const net = require("net");
const ws = require("../relay/ws");

const T = { CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04 };
const KIND = { TCP: 0x01, UDP: 0x02 };
const WHY = {
  UNSPECIFIED: 0x01, VOLUNTARY: 0x02, NETWORK: 0x03,
  INVALID: 0x41, UNREACHABLE: 0x42, TIMEOUT: 0x43, REFUSED: 0x44,
  DATA_TIMEOUT: 0x47, BLOCKED: 0x48, THROTTLED: 0x49, CLIENT: 0x81
};

/* Names and literal addresses only. The resolver would refuse the
   rest anyway; refusing them here keeps them out of the logs. */
const HOST_OK = /^[A-Za-z0-9._:\-\[\]]{1,253}$/;

function packet(type, id, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32LE(id >>> 0, 1);
  return payload && payload.length ? Buffer.concat([head, payload]) : head;
}
function continuePacket(id, n) {
  const p = Buffer.alloc(4);
  p.writeUInt32LE(n >>> 0, 0);
  return packet(T.CONTINUE, id, p);
}
function closePacket(id, why) { return packet(T.CLOSE, id, Buffer.from([why & 0xff])); }
function connectPacket(id, host, port, kind) {
  const h = Buffer.from(String(host), "utf8");
  const p = Buffer.alloc(3 + h.length);
  p[0] = kind || KIND.TCP;
  p.writeUInt16LE(port, 1);
  h.copy(p, 3);
  return packet(T.CONNECT, id, p);
}
function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
  return { type: buf[0], id: buf.readUInt32LE(1), body: buf.subarray(5) };
}
function parseConnect(body) {
  if (!body || body.length < 4) return null;
  return { kind: body[0], port: body.readUInt16LE(1), host: body.subarray(3).toString("utf8") };
}

/* What a failed connection says, in Wisp's terms. */
function whyFromError(e) {
  switch (e && e.code) {
    case "ECONNREFUSED": return WHY.REFUSED;
    case "ETIMEDOUT": return WHY.TIMEOUT;
    case "EHOSTUNREACH": case "ENETUNREACH": case "ENOTFOUND": case "EAI_AGAIN": return WHY.UNREACHABLE;
    default: return WHY.NETWORK;
  }
}

class Session {
  constructor(server, socket, who) {
    this.server = server;
    this.socket = socket;
    this.raw = socket.sock;
    this.who = who || null;
    this.streams = new Map();
    this.paused = false;
    this.up = 0;
    this.down = 0;
    this.started = Date.now();
    this.lastRefusal = null;

    socket.on("message", (data, binary) => this._in(data, binary));
    socket.on("close", () => this._end());
    this.raw.on("drain", () => this._resume());
    this._send(continuePacket(0, server.buffer));
  }

  _send(p) {
    const ok = this.socket.send(p);
    if (!this.paused && this.raw.writableLength > this.server.highWater) this._pause();
    return ok;
  }

  _pause() {
    this.paused = true;
    this.server.stats.pauses++;
    for (const s of this.streams.values()) if (s.tcp) s.tcp.pause();
  }

  _resume() {
    if (!this.paused) return;
    this.paused = false;
    for (const s of this.streams.values()) if (s.tcp) s.tcp.resume();
  }

  _in(data, binary) {
    /* Wisp is binary only. Text means something else is talking. */
    if (!binary) return this.socket.close(1003, "wisp is binary");
    const p = parse(data);
    if (!p) return;
    switch (p.type) {
      case T.CONNECT: return this._connect(p.id, parseConnect(p.body));
      case T.DATA: return this._data(p.id, p.body);
      case T.CLOSE: return this._drop(p.id);
      default: return; /* CONTINUE from a client, or a later version's packet */
    }
  }

  _connect(id, c) {
    const st = this.server.stats;
    if (id === 0 || this.streams.has(id)) { st.invalid++; return this._send(closePacket(id, WHY.INVALID)); }
    if (!c || c.kind !== KIND.TCP || !c.port || !HOST_OK.test(c.host)) {
      st.invalid++;
      return this._send(closePacket(id, WHY.INVALID));
    }
    if (this.streams.size >= this.server.maxStreams) {
      st.throttled++;
      return this._send(closePacket(id, WHY.THROTTLED));
    }

    const s = { id, host: c.host, port: c.port, tcp: null, queue: [], got: 0, open: true, drainWait: false };
    this.streams.set(id, s);

    const room = this.server.meter ? this.server.meter.allowed(this.who) : { ok: true };
    if (!room.ok) { st.throttled++; return this._close(s, WHY.THROTTLED, room.why); }

    const judge = this.server.judge;
    if (!judge.portOk(c.port)) {
      st.blocked++;
      return this._close(s, WHY.BLOCKED, "port " + c.port + " is not one a page may open");
    }

    Promise.resolve(judge.place(c.host)).then((v) => {
      if (!s.open) return;
      if (!v || !v.ok) {
        /* A name that does not exist, or one the resolver would not
           answer, is unreachable: the filter is named only when it was
           the filter (guard.js, 0.7.1). The page is told why either way. */
        if (v && (v.kind === "dns" || v.kind === "missing")) {
          st.unreachable++;
          this.server.noteRefusal(this.who, s.host, v.kind, v.why);
          return this._close(s, WHY.UNREACHABLE, v.why);
        }
        st.blocked++;
        if (!(v && v.quiet)) this.server.noteRefusal(this.who, s.host, (v && v.kind) || "blocked", (v && v.why) || "refused");
        return this._close(s, WHY.BLOCKED, (v && v.why) || "refused", v && v.quiet);
      }
      this._dial(s, v.address);
    }, (e) => {
      st.unreachable++;
      this._close(s, WHY.UNREACHABLE, e.message);
    });
  }

  _dial(s, address) {
    const server = this.server;
    server.stats.opened++;
    const tcp = net.connect({ host: address, port: s.port });
    s.tcp = tcp;
    if (this.paused) tcp.pause();
    let ready = false;
    const late = setTimeout(() => this._close(s, WHY.TIMEOUT), server.connectMs);
    if (late.unref) late.unref();

    tcp.on("connect", () => {
      ready = true;
      clearTimeout(late);
      try { tcp.setNoDelay(true); } catch (e) {}
      tcp.setTimeout(server.idleMs, () => this._close(s, WHY.DATA_TIMEOUT));
      for (const b of s.queue) tcp.write(b);
      s.queue = [];
    });
    tcp.on("data", (chunk) => {
      if (!s.open) return;
      this.down += chunk.length;
      server.stats.bytesDown += chunk.length;
      if (server.meter) server.meter.add(this.who, chunk.length + 5);
      this._send(packet(T.DATA, s.id, chunk));
    });
    tcp.on("end", () => this._close(s, WHY.VOLUNTARY));
    tcp.on("error", (e) => this._close(s, ready ? WHY.NETWORK : whyFromError(e)));
    tcp.on("close", () => { clearTimeout(late); this._close(s, ready ? WHY.VOLUNTARY : WHY.UNREACHABLE); });
  }

  _data(id, body) {
    const s = this.streams.get(id);
    if (!s || !s.open) return;
    const server = this.server;
    this.up += body.length;
    server.stats.bytesUp += body.length;
    if (server.meter) server.meter.add(this.who, body.length);

    if (s.tcp && !s.tcp.connecting) s.tcp.write(body);
    else s.queue.push(Buffer.from(body));

    /* Credit back, in halves: the client may keep sending while this
       is on its way. While the connection to the site is backed up,
       the credit waits for it to drain, which is what stops a fast
       upload from piling up here. */
    if (++s.got < server.buffer / 2 || s.drainWait) return;
    const give = () => {
      s.drainWait = false;
      if (!s.open) return;
      s.got = 0;
      this._send(continuePacket(s.id, server.buffer));
    };
    if (s.tcp && s.tcp.writableNeedDrain) { s.drainWait = true; s.tcp.once("drain", give); }
    else give();
  }

  /* Closed from this end: tell the client why. */
  _close(s, why, note, quiet) {
    if (!s.open) return;
    s.open = false;
    this.streams.delete(s.id);
    if (s.tcp) { try { s.tcp.destroy(); } catch (e) {} }
    s.queue = [];
    if (why === WHY.BLOCKED || why === WHY.THROTTLED) {
      this.lastRefusal = { host: s.host, why: note || "", at: Date.now() };
      if (!quiet) this.server.log("INFO", "lens: refused " + s.host + ":" + s.port + " — " + (note || why));
    }
    this._send(closePacket(s.id, why));
  }

  /* Closed by the client: nothing to send back. */
  _drop(id) {
    const s = this.streams.get(id);
    if (!s) return;
    s.open = false;
    this.streams.delete(id);
    if (s.tcp) { try { s.tcp.destroy(); } catch (e) {} }
  }

  _end() {
    for (const s of this.streams.values()) {
      s.open = false;
      if (s.tcp) { try { s.tcp.destroy(); } catch (e) {} }
    }
    this.streams.clear();
    this.server.sessions.delete(this);
  }

  view() {
    return { who: this.who, streams: this.streams.size, up: this.up, down: this.down,
      since: this.started, lastRefusal: this.lastRefusal };
  }
}

class WispServer {
  /* opts:
       judge   { place(host) -> {ok, address, kind, why, quiet}, portOk(port) }
               — a relay/guard.js Guard (ports: "browser"), required.
       meter   lens/meter.js Meter, optional.
       buffer  DATA packets a stream may send before waiting (128).
       maxStreams     per WebSocket (128): a page opens dozens at once.
       maxPerWho      WebSockets one person may hold (4: a few tabs).
       connectMs      to reach a site (10 s).
       idleMs         a connection with nothing either way (10 min).
       highWater      bytes queued to one person before their sites
                      are paused (1 MB).
       maxPayload     largest packet a client may send (1 MB). */
  constructor(opts) {
    opts = opts || {};
    if (!opts.judge || typeof opts.judge.place !== "function") throw new Error("lens wisp: a judge (guard) is required");
    this.judge = opts.judge;
    this.meter = opts.meter || null;
    this.log = opts.log || (() => {});
    this.buffer = opts.buffer || 128;
    this.maxStreams = opts.maxStreams || 128;
    this.maxPerWho = opts.maxPerWho || 4;
    this.connectMs = opts.connectMs || 10000;
    this.idleMs = opts.idleMs || 10 * 60 * 1000;
    this.highWater = opts.highWater || 1024 * 1024;
    this.maxPayload = opts.maxPayload || 1024 * 1024;
    this.sessions = new Set();
    this.stats = { sessions: 0, opened: 0, blocked: 0, throttled: 0, invalid: 0, unreachable: 0, pauses: 0, bytesUp: 0, bytesDown: 0 };
    /* who -> the last site refused for them (never ads: a page asks for
       dozens), so their page can say why a site did not open. In memory,
       a few seconds' worth, and only ever handed back to that person. */
    this.refused = new Map();
  }

  noteRefusal(who, host, kind, why) {
    if (!who) return;
    if (this.refused.size > 2000) this.refused.clear();
    this.refused.set(who, { host: String(host || "").slice(0, 200), kind: String(kind || ""), why: String(why || "").slice(0, 300), at: Date.now() });
  }

  /* The last refusal of this host for this person, if it was recent. */
  whyFor(who, host, withinMs) {
    const r = this.refused.get(who);
    if (!r || Date.now() - r.at > (withinMs || 15000)) return null;
    if (host && r.host !== String(host).toLowerCase()) return null;
    return r;
  }

  /* From an http server's "upgrade" event, once whoever called it has
     decided this person may use lens. Returns the session, or null
     when the upgrade was refused (the socket is answered either way). */
  handle(req, sock, head, who) {
    if (who) {
      let n = 0;
      for (const s of this.sessions) if (s.who === who) n++;
      if (n >= this.maxPerWho) {
        try { sock.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch (e) {}
        return null;
      }
    }
    if (head && head.length) sock.unshift(head);
    const socket = ws.accept(req, sock, { maxPayload: this.maxPayload, pingMs: 30000 });
    if (!socket) return null;
    const s = new Session(this, socket, who);
    this.sessions.add(s);
    this.stats.sessions++;
    return s;
  }

  view() {
    let streams = 0;
    for (const s of this.sessions) streams += s.streams.size;
    return Object.assign({ open: this.sessions.size, streams }, this.stats,
      this.meter ? { meter: this.meter.view() } : {});
  }

  close() {
    for (const s of this.sessions) { try { s.socket.close(1001, "lens is stopping"); } catch (e) {} s._end(); }
  }
}

module.exports = { WispServer, Session, T, KIND, WHY, packet, continuePacket, closePacket, connectPacket, parse, parseConnect };
