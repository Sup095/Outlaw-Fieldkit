/* ============================================================
   FieldKit relay :: ogg-opus — Opus packets out of an Ogg stream

   ffmpeg writes Opus in Ogg pages; the panel's decoder (WebCodecs'
   AudioDecoder) wants bare packets. A page is "OggS", a header, a
   table of segment lengths, then the segments; a packet is segments
   up to the first one shorter than 255. The first two packets are
   Opus's own headers and are skipped. The same reading as RUNNER's
   fk-screen.py (audio_pages), in JavaScript.

   The stream is ffmpeg's, not a stranger's, but it is still parsed
   defensively: anything that is not a page is skipped to the next
   "OggS", and nothing is held past MAX_HELD.
   ============================================================ */
"use strict";

const MAX_HELD = 256 * 1024;
const MAGIC = Buffer.from("OggS");

class OggOpus {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.seen = 0;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 27) break;
      if (this.buf.readUInt32BE(0) !== 0x4f676753) {
        const j = this.buf.indexOf(MAGIC, 1);
        this.buf = j >= 0 ? this.buf.subarray(j) : Buffer.alloc(0);
        continue;
      }
      const n = this.buf[26];
      if (this.buf.length < 27 + n) break;
      let size = 0;
      for (let i = 0; i < n; i++) size += this.buf[27 + i];
      if (this.buf.length < 27 + n + size) break;
      let p = 27 + n;
      for (let i = 0; i < n; i++) {
        const len = this.buf[27 + i];
        this.parts.push(this.buf.subarray(p, p + len));
        p += len;
        if (len < 255) {
          const pkt = Buffer.concat(this.parts);
          this.parts = [];
          if (++this.seen > 2 && pkt.length) this.onPacket(pkt);
        }
      }
      this.buf = this.buf.subarray(p);
    }
    if (this.buf.length > MAX_HELD) this.buf = Buffer.alloc(0);
  }
}

module.exports = { OggOpus };
