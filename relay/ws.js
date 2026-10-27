/* ============================================================
   FieldKit relay :: ws — WebSocket, both ends, no dependencies

   This exists because the browser overhaul needs two WebSockets
   that point in opposite directions:

     - a SERVER one, so the FieldKit client can hold a single
       connection open instead of making hundreds of requests, and
     - a CLIENT one, so the relay can talk CDP to the Chromium it
       launched.

   Node ships neither. The rest of this relay has no dependencies
   and gets a lot of its safety from that — nothing to audit, no
   lockfile, nothing that can be replaced under it on a machine
   that belongs to somebody else. A WebSocket is a framing format
   and a handshake, both small, so it is written out here rather
   than bought.

   WHAT IS AND IS NOT IMPLEMENTED

   Implemented: RFC 6455 as both ends — the handshake, the frame
   format at all three length widths, client masking (mandatory
   outbound, rejected inbound on a server), continuation frames,
   close/ping/pong, and a payload cap.

   Not implemented: extensions. permessage-deflate is deliberately
   not negotiated. It would help the CDP link, which carries
   base64 JPEG, but every frame this relay sends is already either
   a JPEG (compressed) or a short JSON control message, and an
   unnegotiated extension is a silent corruption bug rather than a
   loud one. If it is ever wanted it belongs behind a flag with a
   test that proves both ends agreed.

   THE PAYLOAD CAP IS THE SECURITY BOUNDARY HERE. A frame header
   can claim 2^63 bytes, and a reader that believes it allocates
   until the process dies. Everything is checked against maxPayload
   BEFORE anything is allocated, and a frame over it closes the
   connection rather than truncating — a truncated CDP message is
   indistinguishable from a malformed one and would desync the
   stream.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { EventEmitter } = require("events");

/* The constant from the RFC. It is not a secret and not a
   credential — it exists so that a cache or a proxy that does not
   understand WebSocket cannot accidentally complete a handshake. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP = {
  CONT: 0x0, TEXT: 0x1, BINARY: 0x2,
  CLOSE: 0x8, PING: 0x9, PONG: 0xa
};

function acceptFor(key) {
  return crypto.createHash("sha1").update(String(key) + GUID).digest("base64");
}

/* ---- one connection, either end --------------------------------

   `masked` is the whole difference between the two roles: a client
   MUST mask every frame it sends and a server MUST NOT. Getting it
   backwards produces a connection that opens cleanly and then
   fails on the first frame, which is a memorably bad hour, so it is
   one constructor argument rather than two near-identical classes. */
class Socket extends EventEmitter {
  constructor(sock, opts) {
    super();
    opts = opts || {};
    this.sock = sock;
    this.masked = !!opts.masked;          /* true on the client side */
    this.maxPayload = opts.maxPayload || 8 * 1024 * 1024;
    this.open = true;

    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOp = 0;

    sock.on("data", (chunk) => this._feed(chunk));
    sock.on("close", () => this._down("socket closed"));
    /* An EventEmitter that emits "error" with nobody listening THROWS,
       and takes the process with it. This is a relay: a peer that
       resets a connection at the wrong moment must not be able to
       stop it serving everyone else. So the error is offered, and if
       nothing wanted it the socket just goes down quietly. */
    sock.on("error", (e) => {
      if (this.listenerCount("error")) this.emit("error", e);
      this._down(e.message);
    });

    /* A dead peer that never sends FIN looks exactly like an idle
       one. The ping is what tells them apart, and without it a
       browser session survives on the server long after the person
       closed the lid. */
    if (opts.pingMs) {
      this._ping = setInterval(() => {
        if (!this.open) return;
        if (this._awaitingPong) return this.close(1001, "no pong");
        this._awaitingPong = true;
        try { this._frame(OP.PING, Buffer.alloc(0)); } catch (e) {}
      }, opts.pingMs);
      if (this._ping.unref) this._ping.unref();
    }
  }

  /* ---- reading ---- */

  _feed(chunk) {
    /* Concat rather than a ring buffer: frames here are small and
       the alternative is an index-arithmetic bug that shows up as
       corrupted JPEG once an hour. */
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const f = this._readFrame();
      if (!f) return;
      if (f === "over") return;             /* already closed */
      this._dispatch(f);
    }
  }

  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const op = b[0] & 0x0f;
    const hasMask = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    /* No extension was negotiated, so a reserved bit set means the
       peer is speaking something we did not agree to. Reading on
       would be guessing. */
    if (rsv) { this.close(1002, "reserved bits set"); return "over"; }

    /* A server must reject an unmasked client frame; a client must
       reject a masked server one. Both are protocol errors and both
       are cheap to get wrong. */
    if (this.masked ? hasMask : !hasMask) {
      this.close(1002, "masking is wrong for this direction");
      return "over";
    }

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      /* Read as two 32-bit halves. A length above 2^32 is beyond
         anything this relay will ever accept, and readBigUInt64BE
         would hand back a BigInt that then has to be compared
         against a Number anyway. */
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      if (hi !== 0) { this.close(1009, "frame too large"); return "over"; }
      len = lo; off += 8;
    }

    /* Checked BEFORE the slice, which is the entire point. */
    if (len > this.maxPayload) { this.close(1009, "frame too large"); return "over"; }

    const maskLen = hasMask ? 4 : 0;
    if (b.length < off + maskLen + len) return null;    /* wait for more */

    let payload;
    if (hasMask) {
      const key = b.slice(off, off + 4);
      payload = Buffer.from(b.slice(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    } else {
      payload = Buffer.from(b.slice(off, off + len));
    }

    this._buf = b.slice(off + maskLen + len);
    return { fin, op, payload };
  }

  _dispatch(f) {
    /* A control frame may arrive in the middle of a fragmented
       message and must be answered immediately — it is never part
       of the message being assembled. */
    if (f.op === OP.PING) { this._frame(OP.PONG, f.payload); return; }
    if (f.op === OP.PONG) { this._awaitingPong = false; return; }
    if (f.op === OP.CLOSE) {
      const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
      this.close(code === 1005 ? 1000 : code, "");
      return;
    }

    if (f.op === OP.CONT) {
      if (!this._fragOp) { this.close(1002, "continuation with nothing to continue"); return; }
      this._frags.push(f.payload);
    } else {
      if (this._fragOp) { this.close(1002, "new message inside a fragmented one"); return; }
      this._fragOp = f.op;
      this._frags = [f.payload];
    }

    /* The cap applies to the ASSEMBLED message too. Otherwise a
       peer sends a million one-byte fragments and every individual
       frame passes the check while the buffer grows without limit. */
    let total = 0;
    for (const p of this._frags) total += p.length;
    if (total > this.maxPayload) { this.close(1009, "message too large"); return; }

    if (!f.fin) return;

    const body = this._frags.length === 1 ? this._frags[0] : Buffer.concat(this._frags);
    const op = this._fragOp;
    this._frags = [];
    this._fragOp = 0;

    if (op === OP.TEXT) this.emit("message", body.toString("utf8"), false);
    else this.emit("message", body, true);
  }

  /* ---- writing ---- */

  send(data) {
    if (!this.open) return false;
    const isBuf = Buffer.isBuffer(data);
    return this._frame(isBuf ? OP.BINARY : OP.TEXT,
      isBuf ? data : Buffer.from(String(data), "utf8"));
  }

  _frame(op, payload) {
    if (!this.open) return false;
    const len = payload.length;
    let header;

    if (len < 126) header = Buffer.alloc(2);
    else if (len < 65536) header = Buffer.alloc(4);
    else header = Buffer.alloc(10);

    header[0] = 0x80 | op;                   /* always FIN — we never fragment */
    if (len < 126) header[1] = len;
    else if (len < 65536) { header[1] = 126; header.writeUInt16BE(len, 2); }
    else {
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }

    let out;
    if (this.masked) {
      header[1] |= 0x80;
      /* Cryptographically random, because the RFC says so and the
         reason is real: a predictable mask lets an attacker who can
         see the ciphertext steer bytes through a broken proxy. */
      const key = crypto.randomBytes(4);
      const body = Buffer.from(payload);
      for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
      out = Buffer.concat([header, key, body]);
    } else {
      out = Buffer.concat([header, payload]);
    }

    /* Asked before writing, because a write to an ended socket
       throws asynchronously as an "error" event rather than here —
       which is how a close handshake against a peer that has already
       gone became an unhandled throw. */
    if (!this.sock.writable) { this._down("the socket is no longer writable"); return false; }
    try { this.sock.write(out); return true; }
    catch (e) { this._down(e.message); return false; }
  }

  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(String(reason || ""), "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code || 1000, 0);
    r.copy(p, 2);
    try { this._frame(OP.CLOSE, p); } catch (e) {}
    this._down(String(reason || "closed"), code || 1000);
    try { this.sock.end(); } catch (e) {}
  }

  _down(why, code) {
    if (!this.open) return;
    this.open = false;
    if (this._ping) clearInterval(this._ping);
    this.emit("close", code || 1006, why || "");
  }
}

/* ---- server side ------------------------------------------------

   Called from the http server's `upgrade` event. Answers the
   handshake and hands back a Socket, or writes a plain HTTP refusal
   and returns null — the caller does not have to know the shape of
   either. */
function accept(req, sock, opts) {
  opts = opts || {};
  const key = req.headers["sec-websocket-key"];
  const ver = String(req.headers["sec-websocket-version"] || "");

  const refuse = (status, why) => {
    try {
      sock.end("HTTP/1.1 " + status + "\r\n" +
        "Connection: close\r\nContent-Type: text/plain\r\n" +
        "Content-Length: " + Buffer.byteLength(why) + "\r\n\r\n" + why);
      setTimeout(() => sock.destroy(), 2000).unref();
    } catch (e) {}
    return null;
  };

  if (!/\bwebsocket\b/i.test(String(req.headers.upgrade || ""))) {
    return refuse("400 Bad Request", "not a websocket upgrade");
  }
  if (!key) return refuse("400 Bad Request", "missing Sec-WebSocket-Key");
  if (ver !== "13") return refuse("426 Upgrade Required", "this relay speaks WebSocket 13");

  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + acceptFor(key)
  ];
  if (opts.protocol) headers.push("Sec-WebSocket-Protocol: " + opts.protocol);

  sock.write(headers.join("\r\n") + "\r\n\r\n");
  /* Nagle off. Every frame here is either an input event that a
     person is waiting on or a video frame that is stale the moment
     it is late, and both are small enough to be exactly what Nagle
     delays. */
  try { sock.setNoDelay(true); } catch (e) {}

  return new Socket(sock, {
    masked: false,
    maxPayload: opts.maxPayload,
    pingMs: opts.pingMs
  });
}

/* ---- client side ------------------------------------------------

   Only ever used to reach the Chromium this relay launched, on
   loopback. It still does the full handshake check, because a
   half-verified handshake against a local port is how you end up
   talking to whatever else happened to bind it. */
function connect(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("bad websocket url: " + url)); }

    const secure = u.protocol === "wss:";
    const mod = secure ? https : http;
    const key = crypto.randomBytes(16).toString("base64");

    const req = mod.request({
      host: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: (u.pathname || "/") + (u.search || ""),
      headers: Object.assign({
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        Host: u.host
      }, opts.headers || {})
    });

    const fail = (e) => { cleanup(); reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error("websocket handshake timed out")),
      opts.timeout || 10000);
    function cleanup() { clearTimeout(timer); try { req.destroy(); } catch (e) {} }

    req.on("error", fail);
    req.on("response", (res) => fail(new Error("expected 101, got " + res.statusCode)));
    req.on("upgrade", (res, sock) => {
      clearTimeout(timer);
      if (String(res.headers["sec-websocket-accept"] || "") !== acceptFor(key)) {
        try { sock.destroy(); } catch (e) {}
        return reject(new Error("the handshake did not verify — something else is on that port"));
      }
      try { sock.setNoDelay(true); } catch (e) {}
      resolve(new Socket(sock, {
        masked: true,
        maxPayload: opts.maxPayload,
        pingMs: opts.pingMs
      }));
    });
    req.end();
  });
}

module.exports = { accept, connect, Socket, acceptFor, OP };
