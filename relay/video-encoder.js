/* ============================================================
   FieldKit relay :: video-encoder — the browser's pictures as video

   RUNNER_PLAN.md §23. The streamed browser sends what Chromium's
   screencast gives it: one complete JPEG per changed frame. That is
   simple and costs nothing while a page is still, but every frame is
   a whole picture, so scrolling or a playing video costs 3–10 Mbit/s
   of a home upload that is ~20 Mbit/s for everything.

   This turns those same pictures into H.264, one encoder per viewer:
   a moving page costs about a fifth of the bandwidth (measured: 1.4
   Mbit/s of JPEG became 0.27 of H.264), and a still page still costs
   nothing, because nothing is fed in when nothing changed. The panel
   decodes it with WebCodecs, in hardware on a Chromebook.

   HOW A FRAME GETS THROUGH WITHOUT WAITING FOR THE NEXT ONE

   ffmpeg is fed multipart JPEG (each picture with its length up
   front), so it can decode a frame the moment its last byte arrives
   instead of waiting to see where the next one starts. Out comes
   H.264 with a marker (AUD) before each frame; a frame is handed on
   when the next marker arrives, or when ffmpeg has gone quiet for a
   few milliseconds, which is how the last frame before a page stops
   moving gets out at all.

   Pictures arrive faster than 30 a second on a busy page; the extra
   ones are not encoded, but the newest is always kept and sent a
   moment later, so the screen never ends on a stale frame.

   And when a page STOPS moving, its last picture is encoded a few
   more times. Each pass sharpens it (the encoder spends the bits on
   what is still blurred), so text that went soft while scrolling is
   crisp a moment after it stops; then nothing more is sent at all.

   A change of size (the panel was resized) starts a fresh encoder,
   because H.264 cannot change size mid-stream; "start" says so, and
   the panel makes a fresh decoder.
   ============================================================ */
"use strict";

const fs = require("fs");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const AUD = Buffer.from([0, 0, 0, 1, 9]);
const QUIET_MS = 12;
const BOUNDARY = "fkframe";
const SETTLE_FIRST_MS = 200, SETTLE_MS = 100, SETTLE_PASSES = 10;

/* The width and height a JPEG says it has, from its frame header. */
function jpegSize(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    /* SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC). */
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function isKey(au) {
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 5) return true;
  }
  return false;
}

/* Bytes of H.264 in, one whole frame at a time out. */
function splitter(onFrame, quietMs) {
  let buf = Buffer.alloc(0), timer = null;
  const flush = () => {
    timer = null;
    if (buf.length && buf.indexOf(AUD) === 0) onFrame(buf, isKey(buf));
    buf = Buffer.alloc(0);
  };
  return {
    push(d) {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      let at = buf.indexOf(AUD);
      if (at > 0) buf = buf.subarray(at);
      while ((at = buf.indexOf(AUD, AUD.length)) > 0) {
        const au = buf.subarray(0, at);
        buf = buf.subarray(at);
        onFrame(au, isKey(au));
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, quietMs == null ? QUIET_MS : quietMs);
    },
    end() { if (timer) clearTimeout(timer); flush(); }
  };
}

const LIKELY = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
/* configured may be [program, ...args]: the tests put a stand-in there. */
function findFfmpeg(configured) {
  if (Array.isArray(configured)) return configured;
  for (const p of (configured ? [configured] : []).concat(LIKELY)) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) {}
  }
  return null;
}

const { Meter } = require("./proc-usage");

class Transcoder extends EventEmitter {
  constructor(opts) {
    super();
    this.bin = opts.ffmpeg;
    this.kbps = opts.kbps || 1500;
    this.minGap = 1000 / (opts.maxFps || 30);
    this.proc = null;
    this.size = null;
    this.lastFed = 0;
    this.pending = null;
    this.timer = null;
    this.closed = false;
    this.last = null;
    this.settles = 0;
    this.settleTimer = null;
    this.meter = new Meter();
  }

  /* What this viewer's encoder is using (proc-usage.js), or null. */
  usage() {
    return this.proc && this.proc.pid ? this.meter.read(this.proc.pid) : null;
  }

  /* One JPEG from the screencast. */
  feed(jpeg) {
    if (this.closed) return;
    const wait = this.lastFed + this.minGap - Date.now();
    if (wait > 0) {
      this.pending = jpeg;
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; const p = this.pending; this.pending = null; if (p) this.feed(p); }, wait);
      return;
    }
    this.lastFed = Date.now();
    this.last = jpeg;
    this.settles = 0;
    this._write(jpeg);
    this._settle();
  }

  _settle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.closed || !this.last || this.settles >= SETTLE_PASSES) return;
      this.settles++;
      this._write(this.last);
      this._settle();
    }, this.settles ? SETTLE_MS : SETTLE_FIRST_MS);
    if (this.settleTimer.unref) this.settleTimer.unref();
  }

  _write(jpeg) {
    const sz = jpegSize(jpeg);
    if (!sz) return;
    if (!this.proc || !this.size || sz.w !== this.size.w || sz.h !== this.size.h) this._start(sz);
    if (!this.proc) return;
    const head = "--" + BOUNDARY + "\r\nContent-Type: image/jpeg\r\nContent-Length: " + jpeg.length + "\r\n\r\n";
    try {
      this.proc.stdin.write(head);
      this.proc.stdin.write(jpeg);
      this.proc.stdin.write("\r\n");
    } catch (e) { /* the exit handler says why */ }
  }

  _start(sz) {
    this._stop();
    /* H.264 wants even sizes; a panel can be any width. One pixel is
       cropped, which nobody can see. */
    const w = sz.w & ~1, h = sz.h & ~1;
    this.size = sz;
    const k = this.kbps;
    const args = ["-nostdin", "-loglevel", "error",
      "-f", "mpjpeg", "-r", "30", "-i", "-",
      "-vf", "crop=" + w + ":" + h + ":0:0,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
      "-threads", "2", "-bf", "0",
      /* Quality-targeted, capped: a still picture is refined up to the
         quality target, while motion is held to the bitrate. */
      "-crf", "23", "-maxrate", k + "k", "-bufsize", Math.max(200, k >> 1) + "k",
      "-x264-params", "aud=1:repeat-headers=1:scenecut=0:keyint=240",
      "-flush_packets", "1", "-f", "h264", "-"];
    let proc;
    const bin = Array.isArray(this.bin) ? this.bin : [this.bin];
    try { proc = spawn(bin[0], bin.slice(1).concat(args), { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return this._fail("could not start the encoder: " + e.message); }
    this.proc = proc;
    let err = "";
    const split = splitter((au, key) => { if (this.proc === proc) this.emit("frame", au, key); });
    proc.stdout.on("data", (d) => split.push(d));
    proc.stderr.on("data", (d) => { err = (err + d).slice(-600); });
    proc.stdin.on("error", () => {});
    proc.on("error", (e) => { if (this.proc === proc) this._fail("the encoder would not run: " + e.message); });
    proc.on("close", (code) => {
      split.end();
      if (this.proc !== proc || this.closed) return;
      this.proc = null;
      this._fail("the encoder stopped (" + code + "): " + err.trim().split("\n").pop());
    });
    this.emit("start", { w: w, h: h });
  }

  _fail(why) {
    this.proc = null;
    this.emit("fail", why);
  }

  _stop() {
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.stdin.end(); } catch (e) {} setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} }, 500).unref(); }
  }

  /* A new bitrate cap (RUNNER_PLAN.md §22: video steps down before
     anyone has to wait). It takes effect from the next picture, through
     a fresh encoder, which starts with a keyframe. */
  setKbps(k) {
    k = Math.round(k);
    if (!(k > 0) || k === this.kbps) return false;
    this.kbps = k;
    this.size = null;
    return true;
  }

  /* The panel was hidden: nothing more until the next picture, not
     even the sharpening passes, which nobody would see. */
  hold() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    this.pending = null;
  }

  close() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    this._stop();
  }
}

module.exports = { Transcoder, jpegSize, splitter, isKey, findFfmpeg, AUD };
