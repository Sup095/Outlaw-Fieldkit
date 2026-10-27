/* Shared by the RUNNER suites: a client for the run server that
   remembers everything it was sent, so a test can ask for "the next
   exit" without racing the message that carries it. Not a suite
   itself (the runner only runs *.test.js). */
"use strict";

const crypto = require("crypto");
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

module.exports = { connect, sha, wait };
