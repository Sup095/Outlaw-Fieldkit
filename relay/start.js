#!/usr/bin/env node
/* ============================================================
   FieldKit relay :: optional Tailscale + cloudflared launcher

   Set MAIN_FILE=start.js in Pterodactyl to use this instead of
   server.js directly. It brings tailscaled up in USERSPACE mode,
   waits for the tailnet to be reachable, then starts the relay.

   It also starts cloudflared if a tunnel is configured, because
   Pterodactyl gives you exactly one startup command and the
   tunnel has to run beside the relay rather than instead of it.
   Both side-cars are optional and independent: with neither
   configured this is just `node server.js` with extra logging.

   THE ORDERING RULE, WHICH IS NOT OBVIOUS

   cloudflared is started BEFORE the relay and pointed at a port
   nothing is listening on yet. That is fine and deliberate — it
   retries the origin until the relay binds, whereas starting it
   afterwards would mean the relay is briefly reachable with no
   tunnel in front of it. Tailscale goes first of all, because the
   relay reads its proxy address at boot.

   Why userspace mode: a Pterodactyl container is unprivileged.
   There is no /dev/net/tun and no NET_ADMIN capability, so normal
   Tailscale cannot create an interface. Userspace mode needs
   neither — it exposes a local HTTP/SOCKS proxy instead, which
   server.js speaks via config.httpProxy.

   If TS_AUTHKEY is not set, this does nothing but start the relay,
   so it is safe to use as MAIN_FILE unconditionally.

   Security posture (see README):
     --shields-up      refuse ALL inbound connections. The relay is
                       reached over its forwarded port, never over
                       the tailnet, so nothing should dial in.
     ephemeral key     node disappears from the tailnet when the
                       container stops, instead of accumulating
                       dead machines.
     tagged key        pairs with an ACL that lets this node reach
                       ONLY the LM Studio ports it needs.
     no route advert   never --advertise-routes or --advertise-exit-node.
   ============================================================ */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const HOME = "/home/container";
const STATE_DIR = path.join(HOME, ".tailscale");
const SOCKET = path.join(STATE_DIR, "tailscaled.sock");
const PROXY_PORT = Number(process.env.TS_PROXY_PORT || 1055);
const HOSTNAME = process.env.TS_HOSTNAME || "fieldkit-relay";

/* Prefer an env var. Fall back to a file so this works without
   editing the egg to add a custom variable — Pterodactyl's egg
   variables are an admin-side change and this should not require
   one. The file is chmod 600 on first read and is gitignored. */
function readAuthKey() {
  if (process.env.TS_AUTHKEY) return process.env.TS_AUTHKEY.trim();
  const f = path.join(HOME, "tailscale-authkey.txt");
  try {
    const k = fs.readFileSync(f, "utf8").trim();
    if (k) { try { fs.chmodSync(f, 0o600); } catch (e) {} }
    return k;
  } catch (e) {
    return "";
  }
}

const AUTHKEY = readAuthKey();

function log(msg) { console.log(`${new Date().toISOString()} [start] ${msg}`); }

/* ---- cloudflared configuration -------------------------------
   Read out of config.json rather than an env var, so it sits
   beside the rest of the relay's settings and survives an egg
   that has no custom variables. Shape:

     "cloudflared": {
       "tunnel": "fieldkit-relay",     // name or UUID from `tunnel create`
       "configFile": "cloudflared.yml" // optional, if you wrote one
     }

   With no `cloudflared` block, or no `tunnel` in it, nothing
   starts and the relay behaves exactly as it did before. */
function readCloudflaredConfig() {
  const candidates = [
    process.env.FK_CONFIG,
    path.join(__dirname, "config.json"),
    path.join(HOME, "config.json")
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      /* Either identifier is enough: `token` for a dashboard-managed
         tunnel, `tunnel` for a locally-created one. Requiring
         `tunnel` was silently fatal for the token setup — the
         config looked complete and the tunnel simply never
         started, with one skipped-line explanation in a log
         nobody reads until something is already wrong. */
      const cf = raw && raw.cloudflared;
      if (cf && (cf.token || cf.tunnel)) return cf;
      if (raw) return null;              // config exists but no tunnel configured
    } catch (e) { /* try the next candidate */ }
  }
  return null;
}

/* The port the tunnel should forward to. Pterodactyl decides the
   relay's port at runtime via SERVER_PORT, and a config.json that
   disagrees is overridden — so deriving it the same way server.js
   does is the only way these cannot drift apart. */
function relayPort() {
  if (process.env.SERVER_PORT) return Number(process.env.SERVER_PORT);
  const candidates = [
    process.env.FK_CONFIG,
    path.join(__dirname, "config.json"),
    path.join(HOME, "config.json")
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw && raw.port) return Number(raw.port);
    } catch (e) { /* next */ }
  }
  return 8080;
}

function startCloudflared() {
  const cfg = readCloudflaredConfig();
  if (!cfg) {
    log("no cloudflared tunnel configured — skipping (see CONNECTIVITY.md)");
    return null;
  }

  const cf = bin("cloudflared");
  if (!cf) {
    log("ERROR: a cloudflared tunnel is configured but the binary was not found.");
    log("Run `node relay/fetch-cloudflared.js` on your PC and upload the result");
    log("into /home/container/. Starting the relay anyway — it will be reachable");
    log("on its forwarded port but NOT through the tunnel hostname.");
    return null;
  }
  if (!ensureExecutable(cf)) {
    log("Starting the relay without the tunnel.");
    return null;
  }

  const port = relayPort();
  const args = ["tunnel", "--no-autoupdate"];
  let describe;

  if (cfg.token) {
    /* Dashboard-managed tunnel. This is the path that actually
       works here, and it is the default for a reason: the other
       one needs `cloudflared tunnel login`, which opens a browser
       and writes a credentials file, and needs `tunnel create`
       and `tunnel route dns` — three interactive commands on the
       container. Pterodactyl's console is one process's stdout,
       not a shell, so there is nowhere to run them.

       With a token, Cloudflare holds the tunnel's configuration
       and the hostname mapping. Nothing has to be created on this
       machine at all; the token is the whole setup. */
    args.push("run", "--token", cfg.token);
    describe = "dashboard-managed tunnel";
  } else if (cfg.configFile) {
    const cfgPath = path.isAbsolute(cfg.configFile)
      ? cfg.configFile : path.join(HOME, cfg.configFile);
    args.push("--config", cfgPath, "run", cfg.tunnel);
    describe = `tunnel '${cfg.tunnel}' via ${cfg.configFile}`;
  } else {
    /* Locally-managed tunnel with no config file: name the origin
       directly. The DNS route was already bound to the tunnel by
       `tunnel route dns`, so the hostname is not needed here. */
    args.push("--url", `http://127.0.0.1:${port}`, "run", cfg.tunnel);
    describe = `tunnel '${cfg.tunnel}'`;
  }

  /* The token is a credential. It goes to cloudflared and never to
     the log, where Pterodactyl would keep it in the console
     scrollback for anyone with panel access to read. */
  log(`starting cloudflared: ${describe} -> 127.0.0.1:${port}`);
  const c = spawn(cf, args, { stdio: "inherit" });

  /* Same rule as tailscaled: a side-car failing must never stop
     the relay from serving. Without this handler a spawn failure
     raises an unhandled 'error' event and takes everything down. */
  c.on("error", (e) => log(`ERROR: cloudflared failed to start: ${e.message}`));
  c.on("exit", (code) => {
    log(`cloudflared exited with code ${code}` +
      (code ? " — the tunnel hostname is now down, but the relay is still serving" : ""));
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { c.kill(sig); } catch (e) {} });
  }
  return c;
}

function bin(name) {
  /* Accept the binary wherever it plausibly landed. People upload
     these by hand through a file manager, so "next to the relay",
     "in the container root", and "still inside the folder the
     fetch script made" are all likely and all fine. */
  const candidates = [
    path.join(HOME, name),
    path.join(HOME, "tailscale", name),
    path.join(HOME, "tailscale-bin", name),
    path.join(HOME, "cloudflared-bin", name),
    path.join(__dirname, name),
    path.join(__dirname, "tailscale-bin", name),
    path.join(__dirname, "cloudflared-bin", name)
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/* Pterodactyl's file manager cannot set the executable bit, and
   uploading over SFTP just to chmod two files is a poor experience.
   The container user owns everything under /home/container, so we
   can simply set it ourselves. */
function ensureExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    try {
      fs.chmodSync(p, 0o755);
      log(`set executable bit on ${path.basename(p)}`);
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch (e2) {
      log(`ERROR: ${path.basename(p)} is not executable and chmod failed: ${e2.message}`);
      return false;
    }
  }
}

function startRelay() {
  log("starting relay");
  const relay = spawn(process.execPath, [path.join(__dirname, "server.js")], { stdio: "inherit" });
  relay.on("error", (e) => {
    log(`FATAL: could not start the relay: ${e.message}`);
    process.exit(1);
  });
  relay.on("exit", (code) => process.exit(code === null ? 1 : code));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { relay.kill(sig); } catch (e) {} });
  }
}

/* Wait until the local proxy actually accepts connections, rather
   than sleeping a fixed number of seconds and hoping. */
function waitForProxy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    (function attempt() {
      const sock = require("net").connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 400);
      });
    })();
  });
}

async function main() {
  if (!AUTHKEY) {
    log("TS_AUTHKEY not set — skipping Tailscale");
    startCloudflared();
    return startRelay();
  }

  const tailscaled = bin("tailscaled");
  const tailscale = bin("tailscale");
  if (!tailscaled || !tailscale) {
    log("ERROR: TS_AUTHKEY is set but the tailscale binaries were not found.");
    log("Upload tailscaled and tailscale into /home/container (see relay/README.md).");
    log("Starting the relay anyway — AI targets on the tailnet will be unreachable.");
    startCloudflared();
    return startRelay();
  }

  if (!ensureExecutable(tailscaled) || !ensureExecutable(tailscale)) {
    log("Starting the relay without Tailscale — tailnet targets will be unreachable.");
    startCloudflared();
    return startRelay();
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });

  log("starting tailscaled in userspace-networking mode");
  const d = spawn(tailscaled, [
    "--tun=userspace-networking",
    `--socks5-server=localhost:${PROXY_PORT}`,
    `--outbound-http-proxy-listen=localhost:${PROXY_PORT}`,
    `--statedir=${STATE_DIR}`,
    `--socket=${SOCKET}`
  ], { stdio: "inherit" });

  /* Without this handler a spawn failure raises an unhandled
     'error' event, which takes the whole process down. Tailscale
     failing must never stop the relay from serving — it only means
     tailnet targets are unreachable. */
  let daemonFailed = false;
  d.on("error", (e) => {
    daemonFailed = true;
    log(`ERROR: tailscaled failed to start: ${e.message}`);
  });
  d.on("exit", (code) => log(`tailscaled exited with code ${code}`));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { d.kill(sig); } catch (e) {} });
  }

  /* Give the daemon a moment to create its socket before `up`. */
  await new Promise((r) => setTimeout(r, 1500));

  if (daemonFailed) {
    log("Starting the relay without Tailscale — tailnet targets will be unreachable.");
    startCloudflared();
    return startRelay();
  }

  log("authenticating to the tailnet (shields up, no routes advertised)");
  const up = spawn(tailscale, [
    `--socket=${SOCKET}`,
    "up",
    `--authkey=${AUTHKEY}`,
    `--hostname=${HOSTNAME}`,
    "--shields-up",
    "--accept-routes=false",
    "--accept-dns=false"
  ], { stdio: ["ignore", "inherit", "inherit"] });

  up.on("error", (e) => log(`ERROR: tailscale up failed to run: ${e.message}`));

  const upCode = await new Promise((resolve) => {
    up.on("exit", resolve);
    up.on("error", () => resolve(-1));
  });
  if (upCode !== 0) log(`WARNING: 'tailscale up' exited with ${upCode} — check the auth key`);

  const ready = await waitForProxy(PROXY_PORT, 20000);
  log(ready
    ? `tailscale proxy listening on 127.0.0.1:${PROXY_PORT}`
    : `WARNING: proxy never came up on ${PROXY_PORT} — tailnet targets will fail`);

  startCloudflared();
  startRelay();
}

main().catch((e) => {
  console.error("[start] fatal: " + e.message);
  /* Whatever went wrong above, the relay itself must still come
     up. A container that serves nothing because a side-car threw
     is strictly worse than one serving without the side-car. */
  try { startCloudflared(); } catch (e2) { console.error("[start] cloudflared: " + e2.message); }
  startRelay();
});
