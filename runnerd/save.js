/* ============================================================
   FieldKit runnerd :: save — a member's saved folder

   Mounted read-write at /save in every job a member runs, so a
   program can keep what it makes between runs: a save game, a
   database, the output of last night's job. Guests do not get one.

   THE FOLDER IS WRITTEN BY HOSTILE CODE. Whatever is in it was put
   there by a program nobody here has read, so this side treats every
   name in it as a possible trap:

     nothing here follows a symlink. A job can leave /save/x pointing
     at /etc/shadow; inside the sandbox that is the sandbox's own
     /etc, but out here, read naively, it would be runnerd's. Walking
     uses lstat; anything that is read, listed or deleted must resolve
     to itself (realpath equals the plain path), so no component of it
     can be a link out.

     reads and deletes are refused while the person has a job
     running, which is the only thing that could swap a file for a
     link between the check and the use.

   THE SIZE LIMIT. There is no per-folder quota in ext4 without
   reformatting, so the size is watched instead: measured before a run
   (a full folder refuses to start one) and every few seconds during
   it (going over stops it). A fast writer can overshoot by a few
   seconds' worth, which the disk can absorb; it cannot keep going.

   Unused folders expire like files do: 30 days after the last run.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const NOBODY = 65534;
const MAX_LIST = 1000;

class Saves {
  constructor(root) {
    this.root = path.join(root, "save");
    this.used = path.join(root, "save-used");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o711 });
    fs.mkdirSync(this.used, { recursive: true, mode: 0o700 });
  }

  dir(handle) { return path.join(this.root, String(handle)); }
  has(handle) { try { return fs.lstatSync(this.dir(handle)).isDirectory(); } catch (e) { return false; } }

  /* Made on first use, owned by the user jobs run as. */
  ensure(handle) {
    const d = this.dir(handle);
    if (!this.has(handle)) {
      fs.mkdirSync(d, { mode: 0o700 });
      if (process.getuid && process.getuid() === 0) fs.chownSync(d, NOBODY, NOBODY);
    }
    return d;
  }

  /* When it was last used, kept OUTSIDE the folder: a marker inside
     would be the job's to delete. */
  touch(handle) {
    const f = path.join(this.used, String(handle));
    try { fs.writeFileSync(f, ""); } catch (e) {}
  }
  lastUsed(handle) {
    try { return fs.statSync(path.join(this.used, String(handle))).mtimeMs; }
    catch (e) { try { return fs.lstatSync(this.dir(handle)).mtimeMs; } catch (x) { return 0; } }
  }

  /* Bytes and entries, stopping early once either cap is passed so a
     folder of a million files does not cost a million lstats. */
  measure(handle, caps) {
    const out = { bytes: 0, files: 0, over: false };
    const maxB = caps && caps.saveBytes, maxF = caps && caps.saveFiles;
    const walk = (d) => {
      let names;
      try { names = fs.readdirSync(d); } catch (e) { return; }
      for (const n of names) {
        if (out.over) return;
        let st;
        try { st = fs.lstatSync(path.join(d, n)); } catch (e) { continue; }
        out.files++;
        if (st.isDirectory()) walk(path.join(d, n));
        else out.bytes += st.size;
        if ((maxB && out.bytes > maxB) || (maxF && out.files > maxF)) out.over = true;
      }
    };
    if (this.has(handle)) walk(this.dir(handle));
    return out;
  }

  list(handle) {
    const out = [], base = this.dir(handle);
    const walk = (d) => {
      let names;
      try { names = fs.readdirSync(d).sort(); } catch (e) { return; }
      for (const n of names) {
        if (out.length >= MAX_LIST) return;
        const full = path.join(d, n);
        let st;
        try { st = fs.lstatSync(full); } catch (e) { continue; }
        const rel = path.relative(base, full).split(path.sep).join("/");
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) out.push({ path: rel, size: st.size, mtime: st.mtimeMs });
        else out.push({ path: rel, size: 0, mtime: st.mtimeMs, special: true });
      }
    };
    if (this.has(handle)) walk(base);
    return out;
  }

  /* A path inside the folder that is exactly itself: no "..", not
     absolute, and no component of it a link. */
  resolve(handle, rel) {
    const r = String(rel || "");
    const parts = r.split("/");
    if (!r || r.length > 1024 || parts.some((p) => !p || p === "." || p === "..") ||
        /[\\:\0]/.test(r)) {
      throw new Error("that is not a file in your saved folder");
    }
    const base = this.dir(handle);
    const full = path.join(base, ...parts);
    let real;
    try { real = fs.realpathSync(full); } catch (e) { throw new Error("that file is not there any more"); }
    if (real !== path.join(fs.realpathSync(base), ...parts)) {
      throw new Error("that is a link, and links in the saved folder are never followed");
    }
    return full;
  }

  read(handle, rel, maxBytes) {
    const full = this.resolve(handle, rel);
    const st = fs.lstatSync(full);
    if (!st.isFile()) throw new Error("only ordinary files can be downloaded");
    if (st.size > maxBytes) throw new Error("that file is too big to download here (" + Math.round(maxBytes / 1048576) + " MB at most)");
    return fs.readFileSync(full);
  }

  remove(handle, rel) {
    const full = this.resolve(handle, rel);
    fs.rmSync(full, { recursive: true, force: true });
  }

  clear(handle) {
    if (!this.has(handle)) return;
    fs.rmSync(this.dir(handle), { recursive: true, force: true });
    this.ensure(handle);
  }

  drop(handle) {
    try { fs.rmSync(this.dir(handle), { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(path.join(this.used, String(handle)), { force: true }); } catch (e) {}
  }

  /* Folders not used for ttlMs are deleted. `busy` says whose jobs
     are running, so a folder in use is never taken away. */
  sweep(now, ttlMs, busy) {
    let n = 0;
    let names = [];
    try { names = fs.readdirSync(this.root); } catch (e) { return 0; }
    for (const h of names) {
      if (busy && busy(h)) continue;
      if (now - this.lastUsed(h) > ttlMs) { this.drop(h); n++; }
    }
    return n;
  }
}

module.exports = { Saves, NOBODY, MAX_LIST };
