#!/usr/bin/env node
/* ============================================================
   FieldKit :: setup — your own relay, from a handful of questions

     node tools/setup.js            asks, writes your settings, builds
     node tools/setup.js --check    reads your settings and says, in plain
                                    words, what is wrong or missing
     node tools/setup.js --show     prints what is set now (never a secret)

   No questions (for scripts), any of:
     --yes  --admin kay  --port 8080  --tunnel-token <token>  --address relay.example.com
     --approve yes|no  --browser on|off  --game-mode on|off  --no-build

   WHAT IT WRITES
     relay/config.local.json   only the settings that are yours. It is
                               gitignored and never leaves this computer.
                               Anything already in it is kept.
     games.local.json          whether your copies have GAME MODE.
   Then it runs `node build.js`, which merges your settings over
   relay/config.example.json (where every setting is explained) into
   relay/config.json, the file the relay reads.

   Run it again whenever you want to change an answer: it shows what you
   chose last time and Enter keeps it. For anything it does not ask
   about, edit relay/config.local.json and run `node build.js`.

   THE ONE RULE IT ENFORCES. The relay only believes the "who is really
   calling" header from a tunnel when nothing else can reach it: with a
   tunnel, host is 127.0.0.1 and trustProxy is "loopback", together;
   without one, host is 0.0.0.0 and trustProxy is false, together. The
   other two combinations are either unreachable or let anyone reset
   their own rate limit, and --check says so.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawnSync } = require("child_process");

/* FK_SETUP_ROOT points it at another copy of the tree: the test suite uses a
   throwaway folder, so a test can never rewrite the real settings. */
const ROOT = process.env.FK_SETUP_ROOT ? path.resolve(process.env.FK_SETUP_ROOT) : path.join(__dirname, "..");
const LOCAL = path.join(ROOT, "relay", "config.local.json");
const EXAMPLE = path.join(ROOT, "relay", "config.example.json");
const OUT = path.join(ROOT, "relay", "config.json");
const GAMES_LOCAL = path.join(ROOT, "games.local.json");
const DEPLOY_SETTINGS = path.join(ROOT, "deploy", ".settings.json");
const HANDLE = /^[a-z0-9][a-z0-9_.-]{2,23}$/;          /* the same rule as relay/messaging.js */

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } };
const newToken = () => crypto.randomBytes(24).toString("base64url");
const isPlaceholder = (t) => !t || /CHANGE-ME/i.test(String(t)) || String(t).length < 16;
const loopback = (h) => h === "127.0.0.1" || h === "::1" || h === "localhost";

function cleanAddress(raw) {
  let s = String(raw || "").trim();
  if (!s || /^(none|no|-)$/i.test(s)) return "";
  if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
  try { const u = new URL(s); return u.hostname && /^https?:$/.test(u.protocol) ? u.origin : ""; } catch (e) { return ""; }
}

/* What the answers were last time, read back out of the files. */
function current(local, gamesLocal) {
  local = local || {}; gamesLocal = gamesLocal || {};
  const m = local.messaging || {};
  return {
    admin: (Array.isArray(m.moderators) && m.moderators[0]) || "",
    port: Number(local.port) || 8080,
    tunnelToken: (local.cloudflared && local.cloudflared.token) || "",
    approve: m.requireApproval !== false,
    browser: !!(local.browser && local.browser.enabled),
    gameMode: gamesLocal.gameMode === "off" ? "off" : "on"
  };
}

/* Answers -> the two files' new contents. Everything already in
   config.local.json that is not asked about is kept as it is. */
function plan(answers, local, gamesLocal) {
  const a = Object.assign(current(local, gamesLocal), answers || {});
  const admin = String(a.admin || "").trim().toLowerCase();
  if (!HANDLE.test(admin)) throw new Error("the admin name must be 3 to 24 characters: small letters, numbers, and . _ - (it is the name you will sign in with)");
  const port = Number(a.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("the port must be a number from 1 to 65535");
  const out = JSON.parse(JSON.stringify(local || {}));
  out._ = "Written by `node tools/setup.js`. Only the settings that are yours; relay/config.example.json explains every one. " +
    "Run setup again, or edit this file and run `node build.js`. Never upload or publish this file.";
  delete out._how;
  out.port = port;
  if (isPlaceholder(out.provisionToken)) out.provisionToken = newToken();
  const tunnel = String(a.tunnelToken || "").trim();
  out.cloudflared = Object.assign({}, out.cloudflared, { token: tunnel });
  const ownTunnel = !!(out.cloudflared.tunnel);            /* one made by hand: left alone */
  if (tunnel || ownTunnel) { out.host = "127.0.0.1"; out.trustProxy = "loopback"; }
  else { out.host = "0.0.0.0"; out.trustProxy = false; }
  /* The example's lists are illustrations. A relay should not probe or
     offer things its owner never listed. */
  for (const k of ["aiTargets", "statusServices", "actions"]) if (!Array.isArray(out[k])) out[k] = [];
  const mods = Array.isArray(out.messaging && out.messaging.moderators) ? out.messaging.moderators.map((x) => String(x).toLowerCase()) : [];
  out.messaging = Object.assign({ openRegistration: true }, out.messaging, {
    enabled: true, requireApproval: !!a.approve,
    moderators: [admin].concat(mods.filter((x) => x !== admin))
  });
  out.browser = Object.assign({}, out.browser, { enabled: !!a.browser });
  out.browse = Object.assign({}, out.browse, { enabled: !!a.browser });
  out.updates = Object.assign({ enabled: true }, out.updates);
  const games = Object.assign({}, gamesLocal, { gameMode: a.gameMode === "off" ? "off" : "on" });
  return { local: out, gamesLocal: games, answers: Object.assign(a, { admin: admin, port: port, tunnelToken: tunnel }) };
}

/* Plain-word findings about a setup. level: "bad" stops a relay working
   or makes it unsafe, "note" is worth knowing, "ok" is fine.
   env: { exists(path) -> bool, nodeMajor, platform, gamesLocal, mtime(path) -> ms | 0 } */
function check(local, env) {
  env = env || {};
  const out = [], say = (level, text) => out.push({ level: level, text: text });
  const exists = env.exists || ((p) => fs.existsSync(path.join(ROOT, p)));
  if ((env.nodeMajor || Number(process.versions.node.split(".")[0])) < 22) say("bad", "Node.js 22 or newer is needed; this is " + process.versions.node + ". Get it from nodejs.org.");
  if (!local) { say("bad", "There is no relay/config.local.json yet. Run: node tools/setup.js"); return out; }
  if (local.__broken) { say("bad", "relay/config.local.json is not valid JSON (" + local.__broken + "). Usual causes: a missing quote, a trailing comma, or a comment."); return out; }
  if (isPlaceholder(local.provisionToken)) say("bad", "provisionToken is missing or still the placeholder. Run node tools/setup.js and it makes one.");
  else say("ok", "provisionToken is set.");
  const m = local.messaging || {};
  const mods = Array.isArray(m.moderators) ? m.moderators : [];
  if (!m.enabled) say("note", "Accounts and MESSAGES are off (messaging.enabled). OUTPOST needs them: nobody can sign in.");
  else if (!mods.length) say("bad", "Accounts are on but nobody is the admin (messaging.moderators is empty): new people can never be approved.");
  else {
    const wrong = mods.filter((h) => !HANDLE.test(String(h)));
    if (wrong.length) say("bad", "These admin names cannot be account names: " + wrong.join(", ") + ". Small letters, numbers and . _ - only, 3 to 24 long.");
    else say("ok", "Admin: " + mods.join(", ") + ". Create an account with that exact name in MESSAGES and it is the admin.");
  }
  const cf = local.cloudflared || {};
  const tunnel = !!(cf.token || cf.tunnel);
  const host = local.host === undefined ? "0.0.0.0" : local.host;
  const tp = local.trustProxy === undefined ? false : local.trustProxy;
  if (tp && !loopback(host)) say("bad", "DANGEROUS: trustProxy is set while the relay listens on " + host + ". Anyone who can reach that port can pretend to be any address and reset their own rate limits. Set host to 127.0.0.1 (tunnel only), or trustProxy to false.");
  else if (loopback(host) && !tunnel) say("note", "The relay listens on " + host + " with no tunnel set, so only this computer can reach it. Fine for trying it out here.");
  else if (tunnel && !tp) say("note", "A tunnel is set but trustProxy is false, so everyone shares one rate limit. Once nothing but the tunnel can reach the relay, run setup again (it sets host 127.0.0.1 and trustProxy loopback together).");
  else say("ok", tunnel ? "Reached through the tunnel only (host " + host + ", trustProxy " + JSON.stringify(tp) + ")." : "Reached directly on port " + (local.port || 8080) + " (no tunnel).");
  if (cf.token && !exists("relay/cloudflared-bin/cloudflared")) {
    say((env.platform || process.platform) === "linux" ? "bad" : "note",
      "A tunnel token is set but Cloudflare's tunnel program is not here. On the Linux machine that runs the relay: node relay/fetch-cloudflared.js  (once), then node relay/start.js. On Windows or a Mac, run Cloudflare's own cloudflared with the same token instead.");
  }
  if (local.browser && local.browser.enabled) say("note", "The streamed browser is on. It needs Chromium and ffmpeg beside the relay: use the Docker image (relay/BROWSER.md). Without them BROWSER says it cannot start; everything else works.");
  const r = local.runner || {};
  if (r.enabled && !r.innerUrl && !r.publicUrl) say("bad", "RUNNER is on but has no run server address (runner.innerUrl or runner.publicUrl). See runnerd/README.md, or turn it off.");
  const gl = env.gamesLocal || readJson(GAMES_LOCAL, {});
  if (gl.gameMode === "off") say("ok", "GAME MODE is left out of your copies.");
  else if (exists("games/library/index.html") || exists("games/outlaw-engine/index.html")) say("ok", "GAME MODE is on and there are games in games/.");
  else say("note", "GAME MODE is on but there are no games yet: it will say so. Add your own with  node tools/add-games.js <folder>  or leave it out with  node tools/setup.js --game-mode off");
  const mtime = env.mtime || ((p) => { try { return fs.statSync(path.join(ROOT, p)).mtimeMs; } catch (e) { return 0; } });
  if (!mtime("relay/config.json")) say("bad", "relay/config.json has not been made yet. Run: node build.js");
  else if (mtime("relay/config.local.json") > mtime("relay/config.json")) say("bad", "relay/config.local.json is newer than relay/config.json, so the relay would not see your last change. Run: node build.js");
  return out;
}

/* A setup with every secret hidden, for --show and for pasting into a bug report. */
function redact(local) {
  const hide = (v) => (v ? "(set, " + String(v).length + " characters)" : "(not set)");
  const o = JSON.parse(JSON.stringify(local || {}));
  if ("provisionToken" in o) o.provisionToken = hide(o.provisionToken);
  if (o.cloudflared) for (const k of Object.keys(o.cloudflared)) if (o.cloudflared[k]) o.cloudflared[k] = hide(o.cloudflared[k]);
  (function walk(x) {
    if (!x || typeof x !== "object") return;
    for (const k of Object.keys(x)) {
      if (/token|secret|password|key$/i.test(k) && typeof x[k] === "string" && x[k] && !/^\(/.test(x[k])) x[k] = hide(x[k]);
      else walk(x[k]);
    }
  })(o);
  return o;
}

function nextSteps(a, address) {
  const where = address || "http://localhost:" + a.port;
  const lines = ["", "DONE. What to do next:", ""];
  let n = 1;
  if (a.tunnelToken) lines.push((n++) + ". Once, on the Linux machine that runs the relay:   node relay/fetch-cloudflared.js");
  lines.push((n++) + ". Start the relay:                 node relay/start.js");
  lines.push((n++) + ". See that it answers:             " + where + "/health   (open it in a browser; it should say \"up\": true)");
  lines.push((n++) + ". Open OUTPOST-STANDALONE.html in Chrome. While it starts press C and type:   " + where);
  lines.push((n++) + ". MESSAGES, CREATE AN ACCOUNT, with the name:   " + a.admin + "   (that name is the admin)");
  lines.push("");
  lines.push("Check it any time:   node tools/setup.js --check      Change an answer:   node tools/setup.js");
  if (a.gameMode !== "off") lines.push("Your own games:      node tools/add-games.js \"<a folder of HTML games>\"");
  if (!a.tunnelToken) lines.push("To let people outside your network in, make a Cloudflare Tunnel (SETUP.md, part 3) and run setup again with its token.");
  return lines;
}

function flags(argv) {
  const f = {}, val = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const yn = (v) => (v === undefined ? undefined : /^(y|yes|on|true|1)$/i.test(v));
  if (val("--admin") !== undefined) f.admin = val("--admin");
  if (val("--port") !== undefined) f.port = Number(val("--port"));
  if (val("--tunnel-token") !== undefined) f.tunnelToken = /^(none|no|off|-)$/i.test(val("--tunnel-token")) ? "" : val("--tunnel-token");
  if (val("--approve") !== undefined) f.approve = yn(val("--approve"));
  if (val("--browser") !== undefined) f.browser = yn(val("--browser"));
  if (val("--game-mode") !== undefined) f.gameMode = yn(val("--game-mode")) ? "on" : "off";
  return { answers: f, address: val("--address") };
}

async function ask(cur) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  /* Lines are queued as they arrive, so answers typed one at a time and
     answers piped in all at once are read the same way. When the input
     ends early, every question left keeps its suggestion. */
  let ended = false;
  const lines = [], waiting = [];
  rl.on("line", (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
  rl.on("close", () => { ended = true; while (waiting.length) waiting.shift()(null); });
  const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((r) => waiting.push(r)));
  const q = async (text, def) => {
    process.stdout.write(text + (def === undefined || def === "" ? "" : " [" + def + "]") + ": ");
    const s = await nextLine();
    if (s === null) process.stdout.write("\n");
    return (s === null ? "" : String(s).trim()) || (def === undefined ? "" : String(def));
  };
  const yn = async (text, def) => /^(y|yes)$/i.test(await q(text + " (y/n)", def ? "y" : "n"));
  console.log("");
  console.log("FIELDKIT RELAY SETUP. Enter keeps what is in [brackets]. Nothing is sent anywhere.");
  console.log("");
  const a = {};
  for (;;) {
    a.admin = (await q("1. A name for your own account, which will be the admin (small letters)", cur.admin || undefined)).toLowerCase();
    if (HANDLE.test(a.admin) || ended) break;
    console.log("   3 to 24 characters: small letters, numbers, and . _ -");
  }
  a.port = Number(await q("2. The port the relay listens on", cur.port));
  console.log("3. To let people outside your own network reach it you need a Cloudflare Tunnel");
  console.log("   (free, needs a domain on Cloudflare: SETUP.md part 3). Paste its token, or leave empty for now.");
  const tok = await q("   Tunnel token", cur.tunnelToken ? "keep the one already set" : "none");
  a.tunnelToken = /^keep the one/.test(tok) ? cur.tunnelToken : /^(none|no|-)$/i.test(tok) ? "" : tok;
  let address = "";
  if (a.tunnelToken) address = cleanAddress(await q("   The address you gave that tunnel, such as relay.example.com", "none"));
  a.approve = await yn("4. Should new accounts wait for your approval?", cur.approve);
  a.browser = await yn("5. Turn on the streamed browser? (needs the Docker image, relay/BROWSER.md)", cur.browser);
  a.gameMode = (await yn("6. Keep GAME MODE in your copies? (you add the games; \"n\" leaves it out entirely)", cur.gameMode !== "off")) ? "on" : "off";
  rl.close();
  return { answers: a, address: address };
}

async function main(argv) {
  let local = null;
  if (fs.existsSync(LOCAL)) {
    try { local = JSON.parse(fs.readFileSync(LOCAL, "utf8")); } catch (e) { local = { __broken: e.message }; }
  }
  const gamesLocal = readJson(GAMES_LOCAL, {});

  if (argv.indexOf("--show") >= 0) {
    if (!local || local.__broken) { console.log(local ? "relay/config.local.json is not valid JSON: " + local.__broken : "no relay/config.local.json yet: run node tools/setup.js"); return 1; }
    console.log(JSON.stringify(redact(local), null, 2));
    console.log("GAME MODE: " + (gamesLocal.gameMode === "off" ? "left out" : "on"));
    return 0;
  }
  if (argv.indexOf("--check") >= 0) {
    const found = check(local, { gamesLocal: gamesLocal });
    const mark = { bad: "FIX ", note: "NOTE", ok: " OK " };
    found.forEach((f) => console.log("[" + mark[f.level] + "] " + f.text));
    const bad = found.filter((f) => f.level === "bad").length;
    console.log("");
    console.log(bad ? bad + " thing(s) to fix." : "Nothing to fix.");
    return bad ? 1 : 0;
  }
  if (local && local.__broken) { console.error("relay/config.local.json is not valid JSON (" + local.__broken + "). Fix or delete it, then run this again."); return 1; }

  const fl = flags(argv);
  const quiet = argv.indexOf("--yes") >= 0 || Object.keys(fl.answers).length > 0;
  const got = quiet ? fl : await ask(current(local, gamesLocal));
  const p = plan(got.answers, local, gamesLocal);
  fs.writeFileSync(LOCAL, JSON.stringify(p.local, null, 2) + "\n", "utf8");
  fs.writeFileSync(GAMES_LOCAL, JSON.stringify(p.gamesLocal, null, 2) + "\n", "utf8");
  const address = cleanAddress(got.address);
  if (address) {
    /* where tools/make-deploy.js keeps the relay's address for the other servers */
    fs.mkdirSync(path.dirname(DEPLOY_SETTINGS), { recursive: true });
    fs.writeFileSync(DEPLOY_SETTINGS, JSON.stringify(Object.assign(readJson(DEPLOY_SETTINGS, {}), { relay: address }), null, 1), "utf8");
  }
  console.log("");
  console.log("wrote relay/config.local.json (yours; never upload or publish it) and games.local.json");
  if (argv.indexOf("--no-build") < 0) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "build.js")], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) { console.error(String(r.stdout || "") + String(r.stderr || "")); console.error("the build failed; fix what it says and run: node build.js"); return 1; }
    console.log("built: FIELDKIT-STANDALONE.html, OUTPOST-STANDALONE.html and relay/config.json" + (p.gamesLocal.gameMode === "off" ? " (without GAME MODE)" : ""));
  }
  const found = check(p.local, { gamesLocal: p.gamesLocal }).filter((f) => f.level !== "ok");
  if (found.length) { console.log(""); found.forEach((f) => console.log("[" + (f.level === "bad" ? "FIX " : "NOTE") + "] " + f.text)); }
  nextSteps(p.answers, address).forEach((l) => console.log(l));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error("setup: " + e.message); process.exit(1); });
}

module.exports = { plan, check, current, redact, cleanAddress, nextSteps, flags, HANDLE };
