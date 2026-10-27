/* A stand-in for ffmpeg recording a sink to Ogg Opus, for
   tests/browser-sound.test.js. Not a suite itself.

   It writes the two Opus header packets, then one packet of
   $FK_FAKE_AUDIO_SIZES (comma-separated byte counts) every 20 ms, round
   and round, until it is killed. Every start appends its arguments to
   $FK_FAKE_AUDIO_LOG as a JSON line. */
"use strict";
const fs = require("fs");
const { page } = require("./ogg-pages");

if (process.env.FK_FAKE_AUDIO_LOG) fs.appendFileSync(process.env.FK_FAKE_AUDIO_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
const sizes = String(process.env.FK_FAKE_AUDIO_SIZES || "3,80").split(",").map(Number);
let seq = 0;
process.stdout.write(page([Buffer.from("OpusHead" + "x".repeat(11))], seq++));
process.stdout.write(page([Buffer.from("OpusTags" + "y".repeat(20))], seq++));
let i = 0;
setInterval(() => {
  const n = sizes[i++ % sizes.length];
  process.stdout.write(page([Buffer.alloc(n, 0x41 + (i % 20))], seq++));
}, 20);
