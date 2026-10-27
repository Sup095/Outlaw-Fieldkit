/* ============================================================
   FieldKit relay :: pulse — a private sound server for the browser

   The streamed browser gets sound by giving each session its own
   Chromium and each of those its own "null sink": a sound card that
   plays into nothing, whose output (its "monitor") ffmpeg records and
   encodes to Opus (browser-engine.js). Measured on Bastion 1 in the
   relay's image: two Chromiums on two sinks, one playing 440 Hz and
   one 1000 Hz, each sink held only its own tone, 31 dB clear of the
   other's.

   This file runs that sound server: one PulseAudio, started by the
   relay as itself (no root, no system daemon), listening only on a
   socket in a private folder, with no default script, so nothing is
   loaded that was not asked for here. Sinks come and go with
   sessions through pactl.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const LIKELY = { pulseaudio: ["/usr/bin/pulseaudio"], pactl: ["/usr/bin/pactl"] };

/* A path given in the settings is the only one tried; otherwise the
   usual places. */
function find(name, configured) {
  for (const p of configured ? [configured] : LIKELY[name]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) {}
  }
  return null;
}

class Pulse {
  constructor(opts) {
    this.bin = find("pulseaudio", opts.bin);
    this.pactlBin = find("pactl", opts.pactl);
    this.log = opts.log || (() => {});
    this.proc = null;
    this.dir = null;
    this.server = null;
    this.next = 1;
  }

  available() { return !!(this.bin && this.pactlBin); }

  /* The environment a program needs to find this server. */
  env() { return { PULSE_SERVER: this.server }; }

  async start() {
    if (this.proc) return true;
    if (!this.available()) return false;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-pulse-"));
    const sock = path.join(this.dir, "native");
    const env = Object.assign({}, process.env, { HOME: this.dir, XDG_RUNTIME_DIR: this.dir, XDG_CONFIG_HOME: this.dir });
    const proc = spawn(this.bin, ["--daemonize=no", "--exit-idle-time=-1", "--disallow-exit", "--disable-shm=yes",
      "--use-pid-file=no", "-n", "--log-target=stderr", "--log-level=error",
      "-L", "module-native-protocol-unix auth-anonymous=1 socket=" + sock,
      /* Something to fall back to, so a stream never lands nowhere. */
      "-L", "module-null-sink sink_name=fk_none"], { stdio: ["ignore", "ignore", "pipe"], env: env });
    let said = "";
    proc.stderr.on("data", (d) => { said = (said + d).slice(-2000); });
    proc.on("exit", (code, sig) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.server = null;
      this.log("WARN", "browser: the sound server stopped (" + (sig || code) + ") " + said.trim().split("\n").pop());
    });
    proc.on("error", () => {});
    this.proc = proc;
    this.server = "unix:" + sock;
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (!this.proc) break;
      if (fs.existsSync(sock)) {
        try { await this.pactl(["info"]); return true; } catch (e) { /* not answering yet */ }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.log("WARN", "browser: the sound server did not start, so the browser has no sound. " + said.trim().split("\n").pop());
    this.stop();
    return false;
  }

  pactl(args) {
    return new Promise((resolve, reject) => {
      if (!this.server) return reject(new Error("no sound server"));
      execFile(this.pactlBin, ["-s", this.server].concat(args), { timeout: 5000,
        env: Object.assign({}, process.env, { HOME: this.dir || os.tmpdir() }) }, (err, out) => {
        if (err) reject(err); else resolve(String(out || "").trim());
      });
    });
  }

  /* A new sink: { name, module }. Its sound is at name + ".monitor". */
  async sink() {
    const name = "fk_s" + (this.next++);
    const module = await this.pactl(["load-module", "module-null-sink", "sink_name=" + name, "rate=48000", "channels=2"]);
    return { name: name, module: module };
  }

  async drop(sink) {
    if (!sink || !this.server) return;
    try { await this.pactl(["unload-module", String(sink.module)]); } catch (e) {}
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.server = null;
    if (p) { try { p.kill("SIGTERM"); } catch (e) {} }
    if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) {} this.dir = null; }
  }
}

module.exports = { Pulse, find };
