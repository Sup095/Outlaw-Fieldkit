/* Shared by the RUNNER suites: a client for the run server that
   remembers everything it was sent, so a test can ask for "the next
   exit" without racing the message that carries it. Not a suite
   itself (the runner only runs *.test.js). */
"use strict";

const crypto = require("crypto");
const zlib = require("zlib");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(port, t) {
  return new Promise((resolve) => {
    const sock = new WebSocket("ws://127.0.0.1:" + port + "/attach?t=" + encodeURIComponent(t));
    sock.binaryType = "arraybuffer";
    /* frames: a screen's binary frames, as { kind, key, job, data }. */
    const c = { sock, got: [], waiters: [], frames: [], open: false, closed: false, closeCode: null };
    const pump = () => {
      c.waiters = c.waiters.filter((w) => {
        const i = c.got.findIndex(w.pred);
        if (i < 0) return true;
        w.resolve(c.got.splice(i, 1)[0]);
        return false;
      });
    };
    c.next = (pred, ms) => new Promise((res, rej) => {
      const w = { pred: typeof pred === "string" ? (m) => m.t === pred : pred, resolve: res };
      c.waiters.push(w);
      pump();
      setTimeout(() => rej(new Error("timed out waiting for " + pred + "; had " +
        JSON.stringify(c.got).slice(0, 300) + (c.closed ? " (closed)" : ""))), ms || 8000);
    });
    c.say = (o) => sock.send(JSON.stringify(o));
    c.ask = (o) => { const ref = "q" + Math.random().toString(36).slice(2, 8); c.say(Object.assign({ ref }, o));
      return c.next((m) => m.ref === ref); };
    c.close = () => new Promise((r) => { if (c.closed) return r(); sock.addEventListener("close", () => r()); sock.close(); });
    c.put = async (name, body, claim) => {
      const buf = Buffer.from(body);
      c.say({ t: "put", ref: name, name: name, size: buf.length, sha256: claim || sha(buf) });
      const first = await c.next((m) => m.t === "put-ok" || m.t === "error" || m.t === "put-done");
      if (first.t !== "put-ok") return first;
      sock.send(buf);
      return c.next((m) => m.t === "put-done" || m.t === "error");
    };
    c.run = async (file, args, more) => {
      c.say(Object.assign({ t: "run", file: file, args: args, ref: "r" }, more || {}));
      return c.next((m) => m.t === "job" || m.t === "error");
    };
    c.hello = async () => { c.say({ t: "hello" }); return c.next("ready"); };
    sock.addEventListener("open", () => { c.open = true; resolve(c); });
    sock.addEventListener("message", (e) => {
      if (typeof e.data !== "string") {
        const b = Buffer.from(e.data), n = b[2];
        c.frames.push({ kind: b[0], key: (b[1] & 1) === 1, job: b.subarray(3, 3 + n).toString("latin1"), data: b.subarray(3 + n) });
        return;
      }
      c.got.push(JSON.parse(e.data)); pump();
    });
    sock.addEventListener("close", (e) => { c.closed = true; c.closeCode = e.code; if (!c.open) resolve(c); });
    /* Node 22 fires only "error" for a refused upgrade, never "close". */
    sock.addEventListener("error", () => { if (!c.open) { c.closed = true; resolve(c); } });
  });
}

/* A small zip writer: [{ name, data, deflate, exec }]. Enough for the
   tests; the real ones come from people's computers. */
function makeZip(files, opts) {
  const o = opts || {};
  const locals = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data || "");
    const body = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(f.deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.lieSize != null ? f.lieSize : raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(f.deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.lieSize != null ? f.lieSize : raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((f.exec ? 0o100755 : f.name.endsWith("/") ? 0o40755 : 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body);
    central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(o.cdOff != null ? o.cdOff : off, 16);
  return Buffer.concat(locals.concat([cd, end]));
}
module.exports = { connect, sha, wait, makeZip };
