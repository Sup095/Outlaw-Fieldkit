#!/usr/bin/env node
/* ============================================================
   FieldKit :: make-games-pack — a library as one zip, to hand to someone

     node tools/make-games-pack.js                     the Outlaw Engine copy -> release/OUTLAW-ENGINE-GAMES.zip
     node tools/make-games-pack.js library             your own library       -> release/LIBRARY-GAMES.zip
     node tools/make-games-pack.js outlaw-engine <out.zip>

   The zip holds one folder (outlaw-engine/ or library/). Whoever gets it
   unzips it into their FieldKit's games/ folder, so that
   games/outlaw-engine/index.html exists, and GAME MODE finds it: on a
   drive after `node build.js --deploy`, and through their relay after a
   restart (or `node tools/make-deploy.js` for a relay in Docker).

   THIS TOOL NEVER PUBLISHES ANYTHING. games/ is gitignored and no build
   or snapshot includes it. Whether a pack is given out, and to whom, is
   the decision of whoever owns the games in it. The Outlaw Engine is All
   rights reserved; its owner publishes its pack beside each FieldKit
   release (gh release upload), and section 2.7 of the LICENSE.md inside
   says what someone running their own relay may do with it.

   No packages: a zip is written here with Node's own zlib.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SKIP = /(^|[\\/])(\.[^\\/]*|__pycache__|node_modules|Thumbs\.db)([\\/]|$)/;

let table = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir, rel, out) {
  for (const n of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, n), r = rel ? rel + "/" + n : n;
    if (SKIP.test(r)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, r, out);
    else if (st.isFile()) out.push({ rel: r, abs: abs });
  }
  return out;
}

/* files: [{ name (forward slashes), data (Buffer) }] -> a zip, as one Buffer.
   Deflate, UTF-8 names, a fixed date so the same files make the same zip. */
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1, TIME = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), raw = f.data;
    const def = zlib.deflateRawSync(raw, { level: 9 });
    const stored = def.length >= raw.length, body = stored ? raw : def, crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(stored ? 0 : 8, 8); head.writeUInt16LE(TIME, 10); head.writeUInt16LE(DATE, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    parts.push(head, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10); cen.writeUInt16LE(TIME, 12); cen.writeUInt16LE(DATE, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cdir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([cdir, end]));
}

/* The folder games/<lib> as a zip whose one top folder is <lib>/. */
function pack(lib, gamesDir) {
  const src = path.join(gamesDir || path.join(ROOT, "games"), lib);
  if (!fs.existsSync(path.join(src, "index.html"))) {
    throw new Error("there is no games/" + lib + " here" + (lib === "library" ? " (node tools/add-games.js <folder> makes it)" : " (node tools/sync-games.js makes it)"));
  }
  const files = walk(src, "", []).map((f) => ({ name: lib + "/" + f.rel, data: fs.readFileSync(f.abs) }));
  if (files.length > 65000) throw new Error("too many files for a plain zip (" + files.length + ")");
  return { buf: zip(files), files: files.length };
}

if (require.main === module) {
  try {
    const lib = process.argv[2] || "outlaw-engine";
    if (!/^(outlaw-engine|library)$/.test(lib)) throw new Error("say which: outlaw-engine or library");
    const out = path.resolve(process.argv[3] || path.join(ROOT, "release", lib === "library" ? "LIBRARY-GAMES.zip" : "OUTLAW-ENGINE-GAMES.zip"));
    const p = pack(lib);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, p.buf);
    console.log("wrote " + path.relative(ROOT, out) + "  (" + p.files + " files, " + (p.buf.length / 1048576).toFixed(1) + " MB)");
    console.log("  sha256 " + crypto.createHash("sha256").update(p.buf).digest("hex"));
    console.log("  Unzip it into a FieldKit's games/ folder. Nothing was uploaded: giving it out is up to whoever owns the games.");
  } catch (e) {
    console.error("games pack: " + e.message);
    process.exit(1);
  }
}

module.exports = { zip, pack, crc32 };
