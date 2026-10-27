/* A stand-in for the docker CLI, so the run server's screen path can
   be tested on a machine without Docker. Not a suite itself.

   It answers the few questions runnerd asks (version, image inspect,
   info, inspect, ps, network, rm, kill, stats) and, for `run`, pretends to be
   fk-screen: it writes the same framed stream (status, video, sound,
   output) and echoes every input line it is sent back as output, so a
   test can see exactly what reached the box.

   What a run does is chosen by the uploaded file's name:
     flood.*     video far faster than any encoder setting
     garbage.*   a frame header claiming 64 MB
   Every `run` appends its arguments to $FK_FAKE_LOG as a JSON line. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const IMAGES = (process.env.FK_FAKE_IMAGES || "fieldkit-runner:1,fieldkit-runner-screen:1").split(",");
const RUNTIMES = (process.env.FK_FAKE_RUNTIMES || "runc,runsc,runsc-gpu").split(",");
const pidFile = (name) => path.join(os.tmpdir(), "fk-fake-" + name + ".pid");

const cmd = argv[0];
if (cmd === "version") { console.log("fake-1"); process.exit(0); }
if (cmd === "image") { process.exit(IMAGES.indexOf(argv[argv.length - 1]) >= 0 ? 0 : 1); }
if (cmd === "info") {
  const o = {};
  RUNTIMES.forEach((r) => { o[r] = { path: r }; });
  console.log(JSON.stringify(o));
  process.exit(0);
}
if (cmd === "inspect") process.exit(1);               /* no egress container */
if (cmd === "stats") {
  /* One line per box asked about, the way docker stats prints them. */
  argv.slice(1).filter((x) => x.indexOf("fk-") === 0).forEach((n, i) => {
    console.log(n + "|" + (12.5 * (i + 1)).toFixed(2) + "%|" + (40 + i) + ".5MiB / 2GiB");
  });
  process.exit(0);
}
if (cmd === "ps" || cmd === "rm" || cmd === "network") process.exit(0);
if (cmd === "kill") {
  try { process.kill(Number(fs.readFileSync(pidFile(argv[1]), "utf8")), "SIGTERM"); } catch (e) {}
  process.exit(0);
}
if (cmd !== "run") process.exit(0);

/* ---- run ---- */
if (process.env.FK_FAKE_LOG) fs.appendFileSync(process.env.FK_FAKE_LOG, JSON.stringify(argv) + "\n");
const name = argv[argv.indexOf("--name") + 1];
fs.writeFileSync(pidFile(name), String(process.pid));
const bye = (code) => { try { fs.unlinkSync(pidFile(name)); } catch (e) {} process.exit(code); };
process.on("SIGTERM", () => bye(137));

const i = argv.indexOf("fk-screen");
if (i < 0) { process.stdout.write("ran without a screen\n"); bye(0); }
const job = argv.slice(i + 1).join(" ");
const env = {};
argv.forEach((a, k) => { if (argv[k - 1] === "--env") { const e = a.indexOf("="); env[a.slice(0, e)] = a.slice(e + 1); } });

const out = (kind, payload) => {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const h = Buffer.alloc(5);
  h[0] = kind.charCodeAt(0);
  h.writeUInt32BE(b.length, 1);
  process.stdout.write(Buffer.concat([h, b]));
};

if (/garbage/.test(job)) {
  const h = Buffer.alloc(5);
  h[0] = 0x56; h.writeUInt32BE(64 * 1024 * 1024, 1);
  process.stdout.write(h);
  setTimeout(() => bye(0), 1500);
  return;
}

out("S", JSON.stringify({ w: Number(env.FK_W) || 1280, h: Number(env.FK_H) || 720, fps: 30, sound: true,
  enc: env.FK_ENC === "gpu" ? "gpu" : "cpu" }));
out("O", "fake screen up\n");

/* A pretend access unit: a frame marker, then a slice that is a
   keyframe (type 5) or not (type 1), padded to a size. */
const au = (key, size) => {
  const b = Buffer.alloc(size, 0x11);
  Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, key ? 0x65 : 0x41]).copy(b);
  return b;
};
let n = 0;
const flood = /flood/.test(job);
const tick = setInterval(() => {
  for (let k = 0; k < (flood ? 20 : 1); k++) {
    const key = n % 10 === 0;
    out("V", Buffer.concat([Buffer.from([key ? 1 : 0]), au(key, flood ? 20000 : 600)]));
    n++;
  }
  out("A", Buffer.alloc(40, 0x22));
}, 33);

let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    out("O", "got " + line + "\n");
    if (line.indexOf('"quit') >= 0) { clearInterval(tick); setTimeout(() => bye(0), 50); }
  }
});
process.stdin.on("end", () => { clearInterval(tick); bye(0); });
