/* ============================================================
   FieldKit :: jsonfile — small JSON records that survive a power cut

   Used by the relay (accounts, the vault header, records) and by the
   run server (everybody's file lists, the library, bans). Both used
   to read a damaged file as "empty", and the next write then saved
   that empty list over it: one power cut at the wrong moment and an
   account list, or somebody's files, was gone for good.

   Writing: to a temp file, flushed to the disk, and only then renamed
   over the real one. The previous good copy is kept as <name>.bak
   first, so there is always one whole version on disk.

   Reading: the file; if it is there but damaged, the .bak. If both are,
   read() throws a Damaged error instead of pretending the record is
   empty, so whatever was about to change it stops, and nothing is
   saved over what is left. A file that is simply not there yet is
   the empty value, as before.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

class Damaged extends Error {
  constructor(file) {
    super(path.basename(file) + " is damaged on the server, so nothing was changed. " +
      "An admin needs to look at it (" + file + ", and its .bak copy).");
    this.name = "Damaged";
    this.file = file;
    this.damaged = true;
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* { value, from: "file" | "bak" | "none" }, or throws Damaged. */
function readInfo(file, empty) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    /* Not there: empty. The .bak is NOT used then, or a deleted
       record would come back from its backup. */
    if (e.code === "ENOENT") return { value: clone(empty), from: "none" };
    throw e;                         /* unreadable for another reason: say so, do not guess */
  }
  try { return { value: JSON.parse(text), from: "file" }; } catch (e) {}
  try { return { value: JSON.parse(fs.readFileSync(file + ".bak", "utf8")), from: "bak" }; } catch (e) {}
  throw new Damaged(file);
}

function read(file, empty) { return readInfo(file, empty).value; }

/* Deletes a record and its backup. */
function remove(file) {
  for (const f of [file, file + ".bak", file + ".tmp"]) { try { fs.unlinkSync(f); } catch (e) {} }
}

/* read(), but a damaged record is `empty` and reported through
   onDamaged instead of thrown: for things that must keep working
   (a list on screen), never for something about to be written back. */
function readSoft(file, empty, onDamaged) {
  try { return read(file, empty); }
  catch (e) {
    if (!e.damaged) throw e;
    if (onDamaged) onDamaged(e);
    return clone(empty);
  }
}

function goodJson(f) {
  try { JSON.parse(fs.readFileSync(f, "utf8")); return true; } catch (e) { return false; }
}

function flushDir(dir) {
  /* Makes the rename itself durable. Not possible on Windows, where
     opening a directory fails; there the rename is as good as it gets. */
  let fd = null;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); } catch (e) {} finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }
}

function write(file, value, opts) {
  opts = opts || {};
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w", opts.mode);
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  /* Only a whole file becomes the backup: a damaged one must never
     push out the good .bak. */
  if (fs.existsSync(file) && goodJson(file)) {
    try { fs.copyFileSync(file, file + ".bak"); } catch (e) {}
  }
  fs.renameSync(tmp, file);
  flushDir(path.dirname(file));
}

module.exports = { read, readInfo, readSoft, write, remove, Damaged, flushDir };
