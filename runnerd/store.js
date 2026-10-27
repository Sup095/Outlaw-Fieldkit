/* ============================================================
   FieldKit runnerd :: store — where uploaded files live

   Two kinds of owner, kept apart on purpose.

   A MEMBER's files are content-addressed: the bytes are stored
   once under their SHA-256 and each person's list points at them.
   Two people uploading the same game costs the disk once.

   A GUEST's files are plain files in a directory named after
   their connection. Nothing is shared and nothing is indexed, so
   "wipe the guest" is one recursive delete and cannot miss
   anything. Whatever is left in that directory at startup belongs
   to a session that died with the machine, and is removed.

   The hash is checked HERE, against the bytes that arrived. The
   client's claim is only ever used to find out early that an
   upload is pointless.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-f0-9]{16,64}$/;

/* What a file is allowed to be called once it is on this machine.
   The name ends up as a path inside the sandbox, so it is reduced
   to something that cannot be a path of its own. */
function safeName(name) {
  let n = String(name || "").split(String.fromCharCode(92)).join("/").split("/").pop() || "";
  n = n.replace(/[^A-Za-z0-9._ ()+-]/g, "_").replace(/^\.+/, "_").trim().slice(0, 100);
  return n || "file";
}

class Store {
  constructor(root) {
    this.root = root;
    this.dirs = {};
    ["blobs", "users", "guests", "jobs", "tmp"].forEach((d) => { this.dirs[d] = path.join(root, d); });
  }

  open() {
    Object.keys(this.dirs).forEach((d) => fs.mkdirSync(this.dirs[d], { recursive: true }));
    /* Anything in these three belonged to a process that is gone. */
    let swept = 0;
    ["guests", "jobs", "tmp"].forEach((d) => {
      for (const n of fs.readdirSync(this.dirs[d])) {
        try { fs.rmSync(path.join(this.dirs[d], n), { recursive: true, force: true }); swept++; }
        catch (e) { /* reported by the caller's next write if it matters */ }
      }
    });
    return { swept: swept };
  }

  /* ---- owners ---- */
  _userFile(handle) { return path.join(this.dirs.users, handle + ".json"); }
  _readUser(handle) {
    try { return JSON.parse(fs.readFileSync(this._userFile(handle), "utf8")); }
    catch (e) { return { version: 1, files: {} }; }
  }
  _writeUser(handle, u) {
    const f = this._userFile(handle), tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(u), "utf8");
    fs.renameSync(tmp, f);
  }
  _blob(sha) { return path.join(this.dirs.blobs, sha.slice(0, 2), sha); }
  _guestDir(sid) { return path.join(this.dirs.guests, sid); }

  list(owner) {
    if (owner.kind === "guest") return Object.values(owner.files || {});
    return Object.values(this._readUser(owner.handle).files)
      .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  }

  usage(owner) {
    const files = this.list(owner);
    return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }

  get(owner, id) {
    if (!ID_RE.test(String(id || ""))) return null;
    if (owner.kind === "guest") return (owner.files || {})[id] || null;
    return this._readUser(owner.handle).files[id] || null;
  }

  /* ---- uploading ----
     Bytes go to tmp/ first and are only given a real name once the
     size and the hash both match what arrived. A half-finished
     upload therefore never exists anywhere a job could run it. */
  begin(owner, meta, limits) {
    const size = Number(meta.size);
    if (!Number.isInteger(size) || size < 1) throw new Error("that file is empty");
    if (size > limits.maxFileBytes) {
      throw new Error("that file is too large for your account (" +
        Math.floor(limits.maxFileBytes / 1048576) + " MB at most)");
    }
    const use = this.usage(owner);
    if (use.files >= limits.maxFiles) throw new Error("you have too many files — delete some first");
    if (use.bytes + size > limits.quotaBytes) {
      throw new Error("that would go over your storage limit (" +
        Math.floor(limits.quotaBytes / 1048576) + " MB)");
    }
    const claimed = String(meta.sha256 || "").toLowerCase();
    if (!SHA_RE.test(claimed)) throw new Error("the upload did not say what its SHA-256 is");

    const tmp = path.join(this.dirs.tmp, crypto.randomBytes(12).toString("hex"));
    const fd = fs.openSync(tmp, "wx");
    const hash = crypto.createHash("sha256");
    const self = this;
    let got = 0, open = true;

    const close = () => { if (open) { open = false; try { fs.closeSync(fd); } catch (e) {} } };
    const abort = () => { close(); try { fs.rmSync(tmp, { force: true }); } catch (e) {} };

    return {
      size: size,
      received: () => got,
      abort: abort,
      write(chunk) {
        if (!open) throw new Error("that upload is closed");
        if (got + chunk.length > size) { abort(); throw new Error("more bytes arrived than the upload declared"); }
        fs.writeSync(fd, chunk);
        hash.update(chunk);
        got += chunk.length;
        return got === size;
      },
      finish() {
        close();
        const sha = hash.digest("hex");
        if (got !== size) { abort(); throw new Error("the upload stopped short"); }
        if (sha !== claimed) { abort(); throw new Error("the file was damaged on the way — its hash does not match"); }
        return self._adopt(owner, tmp, { name: safeName(meta.name), size: size, sha256: sha });
      }
    };
  }

  _adopt(owner, tmp, f) {
    const entry = { id: crypto.randomBytes(12).toString("hex"), name: f.name, size: f.size,
      sha256: f.sha256, addedAt: new Date().toISOString(), usedAt: null };

    if (owner.kind === "guest") {
      const dir = this._guestDir(owner.sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(tmp, path.join(dir, entry.id));
      owner.files = owner.files || {};
      owner.files[entry.id] = entry;
      return entry;
    }

    const blob = this._blob(f.sha256);
    if (fs.existsSync(blob)) fs.rmSync(tmp, { force: true });   /* already have these bytes */
    else {
      fs.mkdirSync(path.dirname(blob), { recursive: true });
      fs.renameSync(tmp, blob);
    }
    const u = this._readUser(owner.handle);
    u.files[entry.id] = entry;
    this._writeUser(owner.handle, u);
    return entry;
  }

  _pathOf(owner, entry) {
    return owner.kind === "guest" && !entry.library ? path.join(this._guestDir(owner.sid), entry.id)
      : this._blob(entry.sha256);
  }

  /* ---- deleting ----
     You can only name files on your own list, so "delete only your
     own" is not a check that could be forgotten: there is no way to
     refer to anybody else's. */
  remove(owner, id) {
    const entry = this.get(owner, id);
    if (!entry) return false;
    if (owner.kind === "guest") {
      delete owner.files[id];
      try { fs.rmSync(this._pathOf(owner, entry), { force: true }); } catch (e) {}
      return true;
    }
    /* Into the tombstone, not straight off the disk: a member who
       deletes the wrong thing can ask an admin to bring it back. */
    this.discard(owner.handle, id, "deleted by its owner", owner.handle);
    return true;
  }

  /* A scan rather than a counter. A reference count is one crash
     away from being wrong in the direction that deletes somebody's
     file; a scan of a few dozen small indexes cannot be. */
  _blobInUse(sha) {
    let names = [];
    try { names = fs.readdirSync(this.dirs.users); } catch (e) { return true; }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      let u;
      try { u = JSON.parse(fs.readFileSync(path.join(this.dirs.users, n), "utf8")); }
      catch (e) { return true; }          /* unreadable index: assume it is in use */
      for (const id of Object.keys(u.files || {})) if (u.files[id].sha256 === sha) return true;
    }
    const lib = this._readLib().files;
    for (const id of Object.keys(lib)) if (lib[id].sha256 === sha) return true;
    return this._readTrash().files.some((x) => x.entry.sha256 === sha);
  }

  dropGuest(sid) {
    try { fs.rmSync(this._guestDir(sid), { recursive: true, force: true }); } catch (e) {}
  }

  /* ---- running ----
     A job gets its own directory holding the one file, under the
     name it was uploaded with. That directory is what the sandbox
     sees, read-only. A hard link where the disk allows it, so
     starting a 2 GB game does not copy 2 GB. */
  stage(owner, id, jobId) {
    const entry = this.find(owner, id);
    if (!entry) throw new Error("no such file");
    const dir = path.join(this.dirs.jobs, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const src = this._pathOf(owner, entry), dst = path.join(dir, entry.name);
    try { fs.linkSync(src, dst); } catch (e) { fs.copyFileSync(src, dst); }
    try { fs.chmodSync(dst, 0o555); fs.chmodSync(dir, 0o755); } catch (e) {}

    if (owner.kind !== "guest" && !entry.library) this.touch(owner.handle, id);
    return { dir: dir, name: entry.name, entry: entry };
  }

  unstage(jobId) {
    try { fs.rmSync(path.join(this.dirs.jobs, jobId), { recursive: true, force: true }); } catch (e) {}
  }

  /* ---- the shared library ----------------------------------------
     A file an admin made permanent. It leaves the uploader's list
     (so it stops counting against them), is never swept, and anyone
     signed in can run it. The uploader is remembered in `origin`, and
     unpinning gives it back to them with a fresh 30-day clock. The
     bytes never move: the blob is the same blob either way. */
  _readLib() {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, "library.json"), "utf8")); }
    catch (e) { return { version: 1, files: {} }; }
  }
  _writeLib(l) {
    const f = path.join(this.root, "library.json"), tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(l), "utf8");
    fs.renameSync(tmp, f);
  }
  library() {
    return Object.values(this._readLib().files).map((f) => Object.assign({}, f, { library: true }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /* Your own file, or a library one. What RUN is allowed to name. */
  find(owner, id) {
    const own = this.get(owner, id);
    if (own) return own;
    if (!ID_RE.test(String(id || ""))) return null;
    const lib = this._readLib().files[id];
    return lib ? Object.assign({}, lib, { library: true }) : null;
  }

  pin(handle, id, by) {
    const u = this._readUser(handle), e = u.files[id];
    if (!e) return null;
    delete u.files[id];
    this._writeUser(handle, u);
    const lib = this._readLib();
    lib.files[id] = Object.assign({}, e, { origin: { handle: handle }, pinnedBy: by,
      pinnedAt: new Date().toISOString() });
    this._writeLib(lib);
    return lib.files[id];
  }

  unpin(id) {
    const lib = this._readLib(), e = lib.files[id];
    if (!e) return null;
    delete lib.files[id];
    this._writeLib(lib);
    const handle = (e.origin && e.origin.handle) || "library";
    const back = { id: e.id, name: e.name, size: e.size, sha256: e.sha256, addedAt: e.addedAt,
      /* A fresh clock, so unpinning is not the same as deleting it tonight. */
      usedAt: new Date().toISOString() };
    const u = this._readUser(handle);
    u.files[id] = back;
    this._writeUser(handle, u);
    return { handle: handle, file: back };
  }

  /* ---- expiry ------------------------------------------------------ */
  expiresAt(entry, ttlMs) {
    return Date.parse(entry.usedAt || entry.addedAt) + ttlMs;
  }

  /* A run refreshes the clock, at most once an hour: running the same
     thing all afternoon should not rewrite the index every minute. */
  touch(handle, id, now) {
    now = now || Date.now();
    const u = this._readUser(handle), e = u.files[id];
    if (!e) return;
    if (e.usedAt && now - Date.parse(e.usedAt) < 3600000) return;
    e.usedAt = new Date(now).toISOString();
    this._writeUser(handle, u);
  }

  handles() {
    let names = [];
    try { names = fs.readdirSync(this.dirs.users); } catch (e) { return []; }
    return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
  }

  /* ---- deleting into a tombstone ------------------------------------
     A deleted file is kept for a while (48 hours by default) so a
     mistake, by its owner, by an admin or by the expiry sweep, can be
     undone. Its bytes stay until the tombstone runs out. */
  _readTrash() {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, "trash.json"), "utf8")); }
    catch (e) { return { version: 1, files: [] }; }
  }
  _writeTrash(t) {
    const f = path.join(this.root, "trash.json"), tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(t), "utf8");
    fs.renameSync(tmp, f);
  }
  trash() { return this._readTrash().files.slice().reverse(); }

  _toTrash(from, entry, reason, by) {
    const t = this._readTrash();
    t.files.push({ from: from, entry: entry, reason: reason, by: by || null,
      deletedAt: new Date().toISOString() });
    this._writeTrash(t);
  }

  /* Takes a file out of a user's list into the tombstone. */
  discard(handle, id, reason, by) {
    const u = this._readUser(handle), e = u.files[id];
    if (!e) return null;
    delete u.files[id];
    this._writeUser(handle, u);
    this._toTrash(handle, e, reason, by);
    return e;
  }

  libRemove(id, by) {
    const lib = this._readLib(), e = lib.files[id];
    if (!e) return null;
    delete lib.files[id];
    this._writeLib(lib);
    this._toTrash("library", e, "removed from the library", by);
    return e;
  }

  purgeUser(handle, by) {
    const ids = Object.keys(this._readUser(handle).files);
    ids.forEach((id) => this.discard(handle, id, "purged by an admin", by));
    return ids.length;
  }

  restore(id) {
    const t = this._readTrash();
    const i = t.files.findIndex((x) => x.entry.id === id);
    if (i < 0) return null;
    const x = t.files.splice(i, 1)[0];
    this._writeTrash(t);
    const e = Object.assign({}, x.entry, { usedAt: new Date().toISOString() });
    if (x.from === "library") {
      const lib = this._readLib(); lib.files[e.id] = e; this._writeLib(lib);
    } else {
      const u = this._readUser(x.from); u.files[e.id] = e; this._writeUser(x.from, u);
    }
    return { to: x.from, file: e };
  }

  /* The daily job: anything unused for ttlMs goes to the tombstone,
     and anything in the tombstone longer than tombMs is gone. */
  sweep(now, ttlMs, tombMs) {
    now = now || Date.now();
    const expired = [];
    for (const h of this.handles()) {
      const u = this._readUser(h);
      for (const id of Object.keys(u.files)) {
        if (this.expiresAt(u.files[id], ttlMs) <= now) {
          expired.push({ handle: h, name: u.files[id].name });
          this.discard(h, id, "not used for " + Math.round(ttlMs / 86400000) + " days", "sweep");
        }
      }
    }
    const t = this._readTrash();
    const keep = [], gone = [];
    t.files.forEach((x) => (now - Date.parse(x.deletedAt) >= tombMs ? gone : keep).push(x));
    if (gone.length) {
      t.files = keep;
      this._writeTrash(t);
      gone.forEach((x) => { if (!this._blobInUse(x.entry.sha256)) this._rmBlob(x.entry.sha256); });
    }
    return { expired: expired, purged: gone.length };
  }

  /* A hash an admin has forbidden: every copy, everywhere, at once,
     tombstone included. There is no undo for this one on purpose. */
  dropHash(sha) {
    let n = 0;
    for (const h of this.handles()) {
      const u = this._readUser(h);
      const ids = Object.keys(u.files).filter((id) => u.files[id].sha256 === sha);
      ids.forEach((id) => { delete u.files[id]; n++; });
      if (ids.length) this._writeUser(h, u);
    }
    const lib = this._readLib();
    const lids = Object.keys(lib.files).filter((id) => lib.files[id].sha256 === sha);
    lids.forEach((id) => { delete lib.files[id]; n++; });
    if (lids.length) this._writeLib(lib);
    const t = this._readTrash();
    const before = t.files.length;
    t.files = t.files.filter((x) => x.entry.sha256 !== sha);
    if (t.files.length !== before) this._writeTrash(t);
    this._rmBlob(sha);
    return n;
  }

  _rmBlob(sha) { try { fs.rmSync(this._blob(sha), { force: true }); } catch (e) {} }

  /* How full the disk the store lives on is. */
  disk() {
    try {
      const s = fs.statfsSync(this.root);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      return { total: total, free: free, used: total - free, pct: total ? (total - free) / total : 0 };
    } catch (e) { return { total: 0, free: 0, used: 0, pct: 0 }; }
  }

  /* Where a file of yours (or the library's) is on disk, or null. */
  pathOf(owner, id) {
    const entry = this.find(owner, id);
    return entry ? this._pathOf(owner, entry) : null;
  }

  /* The first bytes, to tell a Linux program from a Windows one from
     a script without trusting what the file is called. */
  sniff(owner, id) {
    const entry = this.find(owner, id);
    if (!entry) return null;
    const buf = Buffer.alloc(4);
    let fd;
    try { fd = fs.openSync(this._pathOf(owner, entry), "r"); fs.readSync(fd, buf, 0, 4, 0); }
    catch (e) { return null; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return "elf";
    if (buf[0] === 0x4d && buf[1] === 0x5a) return "pe";
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "zip";
    if (buf[0] === 0x23 && buf[1] === 0x21) return "script";
    return "data";
  }
}

module.exports = { Store, safeName, SHA_RE, ID_RE };
