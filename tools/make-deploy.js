#!/usr/bin/env node
/* ============================================================
   FieldKit :: make-deploy — everything that goes on a server, in
   two folders, so deploying is copying and not remembering.

     node tools/make-deploy.js

   writes (all under deploy/, which is gitignored because it holds
   the real config.json):

     deploy/relay-upload/      exactly the files the relay's panel
                               needs, and nothing else
     deploy/relay-upload/_CHANGED.txt
                               which of them differ from the last
                               time this ran, so an update is a few
                               files rather than all of them
     deploy/bastion2/          the run server: runnerd, its images,
                               compose file and setup script
     deploy/bastion2.tar.gz    the same, as one file to copy over
     deploy/NEXT-STEPS.txt     the commands, with the real values in

   It never uploads anything and holds no credentials. It also
   refuses to include release-key.json, by construction: it copies
   from an allow list, not from a directory listing.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "deploy");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

/* The relay's own code. An allow list on purpose: it is what goes
   into the image, so nothing here may be a secret. */
const RELAY_CODE = ["start.js", "server.js", "browse.js", "browse-runtime.js", "messaging.js",
  "updates.js", "ws.js", "cdp.js", "guard.js", "browser-engine.js", "browser-route.js", "video-encoder.js", "proc-usage.js", "fairness.js",
  "runner.js", "fk-wake.js", "fetch-cloudflared.js", "fetch-tailscale.js"];

const BASTION2 = [
  ["relay/ws.js", "relay/ws.js"], ["relay/guard.js", "relay/guard.js"],
  ["runnerd/server.js"], ["runnerd/ticket.js"], ["runnerd/limits.js"], ["runnerd/sandbox.js"],
  ["runnerd/store.js"], ["runnerd/admin.js"], ["runnerd/save.js"], ["runnerd/egress.js"], ["runnerd/power.js"], ["runnerd/fk-power.sh"], ["runnerd/access.js"], ["runnerd/sleep.js"], ["runnerd/zip.js"], ["runnerd/fk-sleep.sh"], ["runnerd/Dockerfile"], ["runnerd/compose.yml"],
  ["runnerd/config.example.json"], ["runnerd/setup.sh"], ["runnerd/inspect.sh"],
  ["runnerd/image/Dockerfile"], ["runnerd/image-wine/Dockerfile"], ["runnerd/image-wine/run-exe.sh"],
  ["runnerd/image-screen/Dockerfile"], ["runnerd/image-screen/fk-screen.py"]
];

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const TEXT = /\.(js|json|sh|py|yml|md|txt)$|Dockerfile$/;

/* Copies one file. Anything that will be read by Linux is written
   with LF endings no matter how git checked it out here: a CRLF
   shell script is a server that will not start. */
function put(from, to, forceLf) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (forceLf && TEXT.test(from)) {
    fs.writeFileSync(to, fs.readFileSync(from, "utf8").replace(/\r\n/g, "\n"), "utf8");
  } else fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(a, b);
    else { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(a, b); n++; }
  }
  return n;
}

fs.mkdirSync(OUT, { recursive: true });
const settingsFile = path.join(OUT, ".settings.json");
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch (e) { /* first run */ }
["relay", "runner", "ssh"].forEach((k) => { if (arg("--" + k)) settings[k] = arg("--" + k); });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 1), "utf8");

/* ---- the relay ----
   Its CODE goes into the image, built on Bastion 1 from
   deploy/bastion1/. Its CONFIG is the one file uploaded through the
   panel. The two change for different reasons and are tracked
   separately, so _CHANGED.txt can say which of the two jobs is due. */
const relayOut = path.join(OUT, "relay-upload"), b1 = path.join(OUT, "bastion1");
const lastFile = path.join(OUT, ".last-relay.json");
let last = {};
try { last = JSON.parse(fs.readFileSync(lastFile, "utf8")); } catch (e) { /* first run */ }
fs.rmSync(relayOut, { recursive: true, force: true });
fs.rmSync(b1, { recursive: true, force: true });

const now = {}, missing = [];
for (const f of RELAY_CODE) {
  const src = path.join(ROOT, "relay", f);
  if (!fs.existsSync(src)) { missing.push(f); continue; }
  put(src, path.join(b1, "relay", f), true);
  now[f] = sha(path.join(b1, "relay", f));
}
for (const [from, to] of [["relay/docker/Dockerfile", "Dockerfile"], ["relay/docker/entrypoint.sh", "entrypoint.sh"]]) {
  put(path.join(ROOT, from), path.join(b1, to), true);
  now[to] = sha(path.join(b1, to));
}
const cfgSrc = path.join(ROOT, "relay", "config.json");
if (fs.existsSync(cfgSrc)) {
  put(cfgSrc, path.join(relayOut, "config.json"), false);
  now["config.json"] = sha(cfgSrc);
} else missing.push("config.json (run node build.js)");

const firstTime = !Object.keys(last).length;
const codeChanged = firstTime || Object.keys(now).some((k) => k !== "config.json" && last[k] !== now[k]);
const configChanged = firstTime || last["config.json"] !== now["config.json"];
fs.mkdirSync(relayOut, { recursive: true });
fs.writeFileSync(path.join(relayOut, "_CHANGED.txt"), [
  configChanged ? "config.json CHANGED: upload it into /home/container and restart the relay."
    : "config.json is the same as last time. Nothing to upload.",
  codeChanged ? "The relay's CODE changed: the image needs rebuilding on Bastion 1 (deploy/bastion1)."
    : "The relay's code is the same as last time. No rebuild needed.",
  "", "(_CHANGED.txt itself never needs uploading.)", ""].join("\n"), "utf8");
fs.writeFileSync(lastFile, JSON.stringify(now, null, 1), "utf8");

const tarUp = (dir) => {
  const t = path.join(OUT, dir + ".tar.gz");
  fs.rmSync(t, { force: true });
  const r = spawnSync("tar", ["-czf", dir + ".tar.gz", dir], { cwd: OUT, encoding: "utf8" });
  return r.status === 0 && fs.existsSync(t) ? "" : String(r.stderr || r.error).trim();
};
const tar1 = tarUp("bastion1");

/* ---- bastion 2 ---- */
const b2 = path.join(OUT, "bastion2");
fs.rmSync(b2, { recursive: true, force: true });
for (const [from, to] of BASTION2) put(path.join(ROOT, from), path.join(b2, to || from), true);
fs.writeFileSync(path.join(b2, "answers.env"),
  "# Written by tools/make-deploy.js. setup.sh reads it so nothing has to be typed.\n" +
  "RELAY_URL=" + (settings.relay || "") + "\n", "utf8");

const tarball = path.join(OUT, "bastion2.tar.gz");
fs.rmSync(tarball, { force: true });
const tar = spawnSync("tar", ["-czf", "bastion2.tar.gz", "bastion2"], { cwd: OUT, encoding: "utf8" });
const tarOk = tar.status === 0 && fs.existsSync(tarball);

/* ---- what to do with them ---- */
const user = settings.ssh || "you";
const steps = [
  "FieldKit deploy bundle — made " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  "",
  "RELAY, Bastion 1",
  "  config.json: " + (configChanged ? "upload deploy/relay-upload/config.json into /home/container, then Restart."
    : "unchanged, nothing to upload."),
  "  code:        " + (codeChanged ? "the image needs rebuilding on Bastion 1, then Restart:" : "unchanged."),
  codeChanged ? "      scp deploy/bastion1.tar.gz " + user + "@bastion-1:~/" : "",
  codeChanged ? "      ssh " + user + "@bastion-1 \"rm -rf bastion1 && tar xzf bastion1.tar.gz && docker build -t fieldkit-relay:1 bastion1\"" : "",
  "",
  "RUN SERVER, Bastion 2",
  "  scp deploy/bastion2.tar.gz " + user + "@bastion-2:~/",
  "  ssh -t " + user + "@bastion-2 \"rm -rf bastion2 && tar xzf bastion2.tar.gz && sudo bash bastion2/runnerd/setup.sh\"",
  "",
  "  The same commands are how both are updated later.",
  ""].filter((l, i, a) => l !== "" || a[i - 1] !== "");
fs.writeFileSync(path.join(OUT, "NEXT-STEPS.txt"), steps.join("\n"), "utf8");

console.log("deploy/relay-upload/   config.json" + (configChanged ? " (changed: upload it)" : " (unchanged)"));
console.log("deploy/bastion1/       the relay image's build folder, " + RELAY_CODE.length + " code file(s)" +
  (tar1 ? " (tar failed: " + tar1 + ")" : ", and deploy/bastion1.tar.gz") +
  (codeChanged ? " — code changed, rebuild due" : ""));
if (missing.length) console.log("  not present here, so not bundled: " + missing.join(", "));
console.log("deploy/bastion2/       " + BASTION2.length + " file(s)" +
  (tarOk ? ", and deploy/bastion2.tar.gz" : " (tar failed: " + String(tar.stderr || tar.error).trim() + ")"));
if (!settings.relay) console.log("  no relay address saved yet: run once with --relay https://your-relay");
console.log("deploy/NEXT-STEPS.txt  the commands");
