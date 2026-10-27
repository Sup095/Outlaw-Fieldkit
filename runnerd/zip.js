/* ============================================================
   FieldKit runnerd :: zip — what is inside an uploaded .zip

   A program is often a folder: an .exe beside its data. RUNNER takes
   it as one .zip. Unpacking happens inside the sandbox, at the start
   of each run (sandbox.js, UNZIP), where a zip bomb or a strange path
   meets the box's own limits. This file only READS THE INDEX (the
   central directory at the end of the file), so the panel can ask
   which file inside to run. Nothing is decompressed here.

   The index is somebody's bytes, so every offset is checked against
   the file before it is used, and there is a cap on how many entries
   are read.
   ============================================================ */
"use strict";

const fs = require("fs");

const EOCD = 0x06054b50, CDH = 0x02014b50;
const MAX_ENTRIES = 5000;
const TAIL = 65536 + 22;           /* the end record, and the longest comment it can have */

/* Files RUNNER knows how to start, as sandbox.js decides it. */
const RUNNABLE = /\.(exe|py|js|mjs|cjs|sh|bash)$/i;

function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/* A name that is safe to hand to the box as "the file to run":
   relative, forward slashes, no "..", nothing odd. */
function cleanEntry(name) {
  const n = String(name || "").replace(/\\/g, "/");
  if (!n || n.length > 240 || /[\0\r\n]/.test(n)) return null;
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split("/");
  if (parts.some((p) => p === ".." || p === ".")) return null;
  if (n.endsWith("/")) return null;
  return n;
}

/* { entries: [{ name, size }], total, truncated } or throws with a sentence. */
function list(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error("that is not a zip file");
    const tailLen = Math.min(size, TAIL);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { e = i; break; }
    if (e < 0) throw new Error("that zip file has no index at its end (is it whole?)");
    const count = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error("zip files over 4 GB are not supported");
    if (cdOff + cdSize > size) throw new Error("that zip file's index points past its end");
    const cd = Buffer.alloc(Math.min(cdSize, 16 * 1024 * 1024));
    fs.readSync(fd, cd, 0, cd.length, cdOff);
    const entries = [];
    let p = 0, total = 0, truncated = false;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH) break;
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      const usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      if (p + 46 + nl > cd.length) break;
      const utf8 = (cd.readUInt16LE(p + 8) & 0x800) !== 0;
      const name = cd.toString(utf8 ? "utf8" : "latin1", p + 46, p + 46 + nl);
      if (!name.endsWith("/")) {
        entries.push({ name: name, size: usize });
        total += usize;
      }
      p += 46 + nl + xl + cl;
    }
    return { entries, total, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

/* The files worth offering as "run this", best first: shallow before
   deep, then by name. */
function runnable(entries) {
  return entries.filter((x) => RUNNABLE.test(x.name) && cleanEntry(x.name) && !/(^|\/)__MACOSX\//.test(x.name))
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.name.localeCompare(b.name))
    .map((x) => x.name);
}

module.exports = { list, runnable, cleanEntry, isZip, RUNNABLE, MAX_ENTRIES };
