#!/usr/bin/env node
/* ============================================================
   FieldKit relay :: fetch-cloudflared

   Downloads the static linux/amd64 cloudflared binary for upload
   into the Pterodactyl container.

   Why this exists — the same reason as fetch-tailscale.js, plus
   one more. You develop on Windows and the container is Linux, so
   you need a binary that will never run on your own machine. And
   the container has no shell: Pterodactyl's console is the stdout
   of one process, not a prompt, so `curl | install` inside it is
   not a thing you can do. The only route in is the file manager
   or SFTP, which means somebody has to fetch the file first.

     node relay/fetch-cloudflared.js

   Output: relay/cloudflared-bin/cloudflared
   Upload that into /home/container/ and set MAIN_FILE=start.js.

   The executable bit does not survive Pterodactyl's file manager,
   so start.js sets it at boot — the same fix already used for the
   Tailscale binaries.

   WHAT THIS DOES NOT DO

   It does not create a tunnel or log you in. Those write
   credentials tied to your Cloudflare account and must happen
   once, interactively, on the container — see CONNECTIVITY.md.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT_DIR = path.join(__dirname, "cloudflared-bin");
const OUT = path.join(OUT_DIR, "cloudflared");
const URL_LATEST =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error("too many redirects"));
    https.get(url, { headers: { "User-Agent": "fieldkit-relay-setup" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      let seen = 0;
      const total = Number(res.headers["content-length"] || 0);
      res.on("data", (c) => {
        chunks.push(c);
        seen += c.length;
        if (total && seen % (2 * 1024 * 1024) < c.length) {
          process.stdout.write(`  ${(seen / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB\r`);
        }
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

(async () => {
  console.log("downloading cloudflared (linux/amd64) from GitHub releases...");
  const bin = await get(URL_LATEST);
  process.stdout.write("                              \r");

  /* An ELF header is four bytes and checking it costs nothing.
     Without this, a proxy's HTML error page or a rate-limit
     response saves happily as "cloudflared" and fails inside the
     container with something unhelpful about exec format. */
  if (bin.length < 1024 * 1024) {
    throw new Error(`only ${bin.length} bytes — that is not a binary. ` +
      "Check whether something intercepted the download.");
  }
  if (!(bin[0] === 0x7f && bin[1] === 0x45 && bin[2] === 0x4c && bin[3] === 0x46)) {
    throw new Error("the downloaded file is not a Linux ELF binary. " +
      "Something returned a page instead of the release asset.");
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, bin);
  /* Meaningless on Windows, correct if this is ever run on Linux,
     and harmless either way. */
  try { fs.chmodSync(OUT, 0o755); } catch (e) {}

  console.log(`wrote ${path.relative(path.join(__dirname, ".."), OUT)}  (${(bin.length / 1048576).toFixed(1)} MB)`);
  console.log("");
  console.log("NEXT — none of this can happen from your PC:");
  console.log("  1. Upload the file into /home/container/ (file manager or SFTP).");
  console.log("  2. Set MAIN_FILE=start.js in Pterodactyl. It finds the binary,");
  console.log("     sets the executable bit, and runs the tunnel beside the relay.");
  console.log("  3. Create the tunnel ONCE, interactively — see CONNECTIVITY.md.");
  console.log("     That writes credentials tied to your Cloudflare account and");
  console.log("     cannot be done for you ahead of time.");
  console.log("  4. Put the tunnel name in config.json as \"cloudflared\": { \"tunnel\": \"...\" }");
})().catch((e) => {
  console.error("FAILED: " + e.message);
  console.error("");
  console.error("Manual fallback: download this file in a browser and upload it yourself:");
  console.error("  " + URL_LATEST);
  process.exit(1);
});
