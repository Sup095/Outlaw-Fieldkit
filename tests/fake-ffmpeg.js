/* A stand-in for ffmpeg as relay/video-encoder.js runs it: reads
   multipart JPEG from stdin and, for each picture, writes one pretend
   H.264 frame (a frame marker, then a slice: a keyframe first, then
   not), carrying the picture's first bytes so a test can tell which
   picture it was. Not a suite itself.

   FK_FAKE_FFMPEG_LOG   append one line per picture: "<n> <bytes>"
   FK_FAKE_FFMPEG_DIE   exit with an error after this many pictures */
"use strict";
const fs = require("fs");
const log = process.env.FK_FAKE_FFMPEG_LOG;
const die = Number(process.env.FK_FAKE_FFMPEG_DIE || 0);
if (log) fs.appendFileSync(log, "start " + process.argv.slice(2).join(" ") + "\n");

let buf = Buffer.alloc(0), n = 0;
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const head = buf.indexOf("\r\n\r\n");
    if (head < 0) return;
    const m = /Content-Length: (\d+)/.exec(buf.subarray(0, head).toString());
    if (!m) { buf = buf.subarray(head + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < head + 4 + len + 2) return;
    const pic = buf.subarray(head + 4, head + 4 + len);
    buf = buf.subarray(head + 4 + len + 2);
    n++;
    if (log) fs.appendFileSync(log, n + " " + pic.length + "\n");
    if (die && n >= die) { process.stderr.write("fake failure\n"); process.exit(3); }
    const tag = pic.subarray(pic.length - 4);
    process.stdout.write(Buffer.concat([Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, n === 1 ? 0x65 : 0x41]), tag]));
  }
});
process.stdin.on("end", () => process.exit(0));
