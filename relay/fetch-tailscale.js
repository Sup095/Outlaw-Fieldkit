#!/usr/bin/env node
/* ============================================================
   FieldKit relay :: fetch-tailscale

   Downloads the static linux/amd64 Tailscale binaries and unpacks
   the two you need for the container.

   Why this exists: you develop on Windows but the Pterodactyl
   container is Linux, so you need linux/amd64 binaries that will
   never run on your own machine. Windows has no reliable built-in
   way to open a .tgz, and this avoids adding a dependency just to
   untar one file. Node has gzip built in, and the tar format is
   simple enough to read directly.

     node fetch-tailscale.js

   Output: relay/tailscale-bin/{tailscaled,tailscale}
   Upload those two into /home/container/ on the server.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const https = require("https");

const OUT_DIR = path.join(__dirname, "tailscale-bin");
const WANT = ["tailscaled", "tailscale"];

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
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
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

/* Minimal ustar reader. Enough for Tailscale's tarball: it only
   needs regular files, and we ignore everything else. */
function untar(buf) {
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    /* Two consecutive zero blocks mark end of archive. */
    if (header.every((b) => b === 0)) break;

    const str = (start, len) => header.subarray(start, start + len)
      .toString("utf8").replace(/\0.*$/, "").trim();

    const name = str(0, 100);
    const sizeOctal = str(124, 12);
    const size = parseInt(sizeOctal, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = str(345, 155);
    const full = prefix ? prefix + "/" + name : name;

    off += 512;
    if (type === "0" || type === "\0" || type === "") {
      files.push({ name: full, data: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

(async () => {
  console.log("querying tailscale for the current stable version...");
  let version;
  try {
    const meta = JSON.parse((await get("https://pkgs.tailscale.com/stable/?mode=json")).toString("utf8"));
    version = meta.TarballsVersion || meta.Version;
  } catch (e) {
    throw new Error("could not determine the current version: " + e.message);
  }
  if (!version) throw new Error("version missing from the index response");
  console.log(`stable version: ${version}`);

  const url = `https://pkgs.tailscale.com/stable/tailscale_${version}_amd64.tgz`;
  console.log(`downloading ${url}`);
  const tgz = await get(url);
  console.log(`  ${(tgz.length / 1048576).toFixed(1)} MB received`);

  console.log("decompressing...");
  const tar = zlib.gunzipSync(tgz);

  const files = untar(tar);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let found = 0;
  for (const want of WANT) {
    const hit = files.find((f) => path.posix.basename(f.name) === want);
    if (!hit) {
      console.error(`  MISSING: ${want} was not in the archive`);
      continue;
    }
    const dest = path.join(OUT_DIR, want);
    fs.writeFileSync(dest, hit.data);
    /* Meaningless on Windows, but harmless, and correct if this is
       ever run on Linux. The container needs the bit set — see the
       chmod note in README. */
    try { fs.chmodSync(dest, 0o755); } catch (e) {}
    console.log(`  extracted ${want}  (${(hit.data.length / 1048576).toFixed(1)} MB)`);
    found++;
  }

  if (found !== WANT.length) throw new Error("archive did not contain both binaries");

  console.log("");
  console.log(`done -> ${OUT_DIR}`);
  console.log("upload BOTH files into /home/container/ on the Pterodactyl server,");
  console.log("then follow the Tailscale section of relay/README.md.");
})().catch((e) => {
  console.error("FAILED: " + e.message);
  console.error("");
  console.error("Manual fallback: download the linux amd64 static tarball from");
  console.error("https://pkgs.tailscale.com/stable/ and extract tailscaled + tailscale yourself.");
  process.exit(1);
});
