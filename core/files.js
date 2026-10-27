/* ============================================================
   FieldKit :: files
   Chunked, encrypted file storage on top of the blob transport.
   The design is argued in relay/LARGE-FILES.md; this is it built.

   THE PROBLEM IT SOLVES

   A record is JSON. Putting a .blend in one means base64 (+33%)
   and three simultaneous copies in memory — file, ciphertext,
   string — which is ~1.7 GB for a 500 MB asset on a Chromebook
   with 4 GB. It also has to clear a 2 MB body cap it cannot.

   THE SHAPE

   Split first, encrypt each piece separately, upload as raw bytes.
   Peak memory becomes roughly one chunk regardless of file size: a
   10 GB file costs the same as a 10 MB one. Each chunk gets its
   own random IV and its own key on the relay, and the relay is
   told nothing that ties them together.

   What ties them together is a manifest record — encrypted like
   every other record — holding the name, the size, the hash, and
   the ordered list of chunk keys. Consequences, both deliberate:

     - The relay cannot reconstruct a file even in principle. It
       holds an unordered heap of unlabelled ciphertext.
     - Lose the manifest and the file is gone, though every byte is
       still sitting there. Manifests are records, so they ride in
       backups; blobs do not. verify() and orphans() exist because
       of this gap and the UI is blunt about it.

   NO DEDUP, ON PURPOSE

   Identical chunks encrypt differently because each IV is random.
   Convergent encryption (key derived from the plaintext hash)
   would give dedup, and would also let anyone holding the relay
   confirm a guess about file content. Not worth it at this scale.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "file";

  /* 4 MB plaintext per chunk. Chosen against three limits at once:
       - the relay's blobMaxBytes (8 MB) with room for IV + overhead
       - Chromebook memory, since a few of these are live at once
       - request count, because 512 KB chunks would mean 1000
         requests for a 500 MB file and school wifi will not do that
     Stored in every manifest, so changing it later does not break
     files written under the old value. */
  var CHUNK_BYTES = 4 * 1024 * 1024;

  /* Not a hard cap — a soft line past which the UI warns. Beyond
     this the request count and wall-clock stop being reasonable
     over a school connection, and Git is the better answer. */
  var SOFT_MAX_BYTES = 256 * 1024 * 1024;

  /* Uploads run a few at a time. Sequential wastes the link;
     unbounded parallelism puts N chunks in memory at once and
     makes progress reporting a lie. */
  var CONCURRENCY = 3;

  var store = null;

  function needStore() {
    if (!store) store = FieldKit.need("store");
    return store;
  }

  function transport() {
    var t = needStore().transport();
    if (!t) throw new Error("no transport");
    if (typeof t.putBlob !== "function") {
      throw new Error("this transport has no blob support — the relay needs updating");
    }
    return t;
  }

  function vault() {
    var v = needStore().vault();
    if (!v) throw new Error("vault is locked");
    if (typeof v.sealRaw !== "function") throw new Error("this vault build cannot seal raw bytes");
    return v;
  }

  function randomKey() {
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) {
      return x.toString(16).padStart(2, "0");
    }).join("");
  }

  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (x) {
      return x.toString(16).padStart(2, "0");
    }).join("");
  }

  /* Hash of the plaintext, computed while chunking so the file is
     never held whole in memory just to hash it. Used to tell "this
     download is intact" from "this download is subtly wrong", and
     to spot the same asset uploaded twice under different names. */
  async function sha256(bytes) {
    var d = await window.crypto.subtle.digest("SHA-256", bytes);
    return toHex(d);
  }

  /* ---- file-kind classification -------------------------------
     Not decoration. The UI groups by it, the Godot/Blender advice
     keys off it, and "this is a source file, put it in Git" is the
     single most useful thing this module can say. */
  var KINDS = [
    { kind: "godot-scene",  exts: ["tscn", "escn"],                                  label: "GODOT SCENE",     text: true },
    { kind: "godot-res",    exts: ["tres", "res", "godot", "import", "gdextension"], label: "GODOT RESOURCE",  text: true },
    { kind: "gdscript",     exts: ["gd", "gdshader", "gdshaderinc"],                 label: "GDSCRIPT/SHADER", text: true },
    { kind: "blender",      exts: ["blend", "blend1", "blend2"],                     label: "BLENDER",         text: false },
    { kind: "model",        exts: ["glb", "gltf", "fbx", "obj", "dae", "stl", "ply", "usd", "usdz"], label: "3D MODEL", text: false },
    { kind: "texture",      exts: ["png", "jpg", "jpeg", "webp", "tga", "bmp", "exr", "hdr", "ktx", "ktx2", "dds", "svg"], label: "TEXTURE/IMAGE", text: false },
    { kind: "audio",        exts: ["wav", "ogg", "mp3", "flac", "aiff", "aif"],      label: "AUDIO",           text: false },
    { kind: "video",        exts: ["mp4", "webm", "mov", "ogv"],                     label: "VIDEO",           text: false },
    { kind: "font",         exts: ["ttf", "otf", "woff", "woff2"],                   label: "FONT",            text: false },
    { kind: "doc",          exts: ["md", "txt", "pdf", "rtf", "odt", "docx"],        label: "DOCUMENT",        text: false },
    { kind: "data",         exts: ["json", "csv", "yaml", "yml", "toml", "cfg", "ini", "xml"], label: "DATA",  text: true },
    { kind: "code",         exts: ["js", "ts", "py", "cs", "cpp", "c", "h", "hpp", "sh", "rs", "go"], label: "CODE", text: true },
    { kind: "archive",      exts: ["zip", "7z", "tar", "gz", "rar", "xz"],           label: "ARCHIVE",         text: false }
  ];

  function extOf(name) {
    var m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function classify(name) {
    var e = extOf(name);
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].exts.indexOf(e) >= 0) return KINDS[i];
    }
    return { kind: "other", exts: [], label: "OTHER", text: false };
  }

  /* ---- the advice layer ---------------------------------------
     The honest answer to "can I keep my Godot project in here" is
     mostly no, and saying so at the moment of upload is worth more
     than saying it in a document nobody opens.

     Rules, in order of how strongly they apply. Each returns a
     level and a reason; nothing here blocks an upload. */
  function advise(name, size) {
    var c = classify(name);
    var e = extOf(name);

    /* .import before the generic source-file rule. It is a text
       file under 512 KB, so the broad rule would swallow it and
       give the wrong advice — the answer for a derived artefact is
       not "put it in Git", it is "do not store it at all". Order
       here is load-bearing; a probe caught this exact shadowing. */
    if (e === "import") {
      return {
        level: "warn", kind: c.kind,
        text: "Godot regenerates .import files from the source asset. Storing one is storing a " +
              "derived artefact — it belongs in .gitignore, not in the vault. (Note the " +
              "exception: .import files inside the project SHOULD be committed to Git. " +
              "It is uploading them here that has no purpose.)"
      };
    }
    if (c.text && size < 512 * 1024) {
      return {
        level: "warn", kind: c.kind,
        text: "This is a source file. Git handles it far better than the vault does — " +
              "it diffs, merges and blames. The vault only versions it if you upload it again by hand."
      };
    }
    if (c.kind === "blender") {
      return {
        level: "ok", kind: c.kind,
        text: ".blend files are binary and large — exactly what Git is worst at. " +
              "The vault is a reasonable home, or Git LFS if you want history. " +
              "Keep the exported .glb next to it so nobody has to open Blender to see the mesh."
      };
    }
    if (c.kind === "archive") {
      return {
        level: "warn", kind: c.kind,
        text: "An archive is opaque — you cannot see inside it from here, and neither can search. " +
              "Fine as a delivery or a backup, poor as working storage."
      };
    }
    if (size > SOFT_MAX_BYTES) {
      return {
        level: "warn", kind: c.kind,
        text: "Over " + fmtBytes(SOFT_MAX_BYTES) + ". This will work, but it is " +
              Math.ceil(size / CHUNK_BYTES) + " requests and will take a while on a slow link. " +
              "Consider Git LFS."
      };
    }
    return { level: "ok", kind: c.kind, text: "" };
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  /* ---- upload --------------------------------------------------
     Order matters and is the opposite of the obvious one: every
     chunk is uploaded BEFORE the manifest is written. A manifest
     pointing at chunks that do not exist is a file that looks
     present and fails on open — the worst outcome. Chunks with no
     manifest are merely garbage, and orphans() finds them.

     onProgress(done, total, phase) fires per chunk. */
  async function upload(file, opts) {
    opts = opts || {};
    var t = transport();
    var v = vault();
    var onProgress = opts.onProgress || function () {};

    if (!file || typeof file.slice !== "function") throw new Error("not a file");
    var size = file.size;
    if (!size) throw new Error("file is empty");

    /* Per-upload override. The default is right for a normal link,
       but a connection that keeps timing out mid-chunk wants
       smaller ones, and the manifest records whatever was used so
       a file uploaded at one size still downloads at another.
       It is also what lets the test suite exercise the multi-chunk
       path without a 12 MB fixture — a path that was, until a
       probe went looking, completely untested. */
    var chunkBytes = Number(opts.chunkBytes) > 0
      ? Math.floor(opts.chunkBytes) : CHUNK_BYTES;

    var total = Math.max(1, Math.ceil(size / chunkBytes));
    var chunks = new Array(total);
    var done = 0;
    var cancelled = false;
    var hasher = [];   // per-chunk plaintext hashes (hex), not the plaintext itself

    onProgress(0, total, "starting");

    /* One chunk: read → hash → seal → upload. Nothing outside this
       function holds the plaintext, so a chunk becomes collectable
       the moment its upload resolves. */
    async function doChunk(i) {
      if (cancelled) return;
      var start = i * chunkBytes;
      var slice = file.slice(start, Math.min(start + chunkBytes, size));
      var plain = new Uint8Array(await slice.arrayBuffer());
      var plainSize = plain.length;
      var key = randomKey();
      var sealed = await v.sealRaw(plain);
      hasher[i] = await sha256(plain);
      plain = null;
      await t.putBlob(key, sealed, { timeout: opts.timeout || 120000 });
      chunks[i] = { key: key, size: sealed.length, plainSize: plainSize };
      done++;
      onProgress(done, total, "uploading");
    }

    /* A fixed-size worker pool over an index queue: bounded memory,
       and a failure in one worker stops the others rather than
       letting them keep spending bandwidth on a doomed upload. */
    var next = 0;
    var failure = null;
    async function worker() {
      while (!failure && !cancelled) {
        var i = next++;
        if (i >= total) return;
        try { await doChunk(i); }
        catch (e) { failure = e; return; }
      }
    }
    var pool = [];
    for (var w = 0; w < Math.min(CONCURRENCY, total); w++) pool.push(worker());
    await Promise.all(pool);

    if (failure) {
      /* Roll back what did land. Best-effort: a chunk we cannot
         delete becomes an orphan, which is recoverable, whereas
         leaving a half-file addressable is not. */
      onProgress(done, total, "rolling back");
      for (var r = 0; r < chunks.length; r++) {
        if (!chunks[r]) continue;
        try { await t.deleteBlob(chunks[r].key); } catch (e) { /* orphan; GC will find it */ }
      }
      throw failure;
    }

    /* Whole-file hash from the per-chunk hashes, so the file never
       exists in memory in one piece. Not the same value as
       sha256(wholefile) and deliberately labelled as such — it is
       a change detector, not something to compare against a hash
       from another tool. */
    var rollup = await sha256(new TextEncoder().encode(hasher.join(":")));
    var c = classify(file.name);

    onProgress(total, total, "writing manifest");

    var manifest = {
      name: String(file.name || "untitled").slice(0, 260),
      size: size,
      mime: file.type || "",
      kind: c.kind,
      chunkBytes: chunkBytes,
      chunks: chunks,
      chunkHashes: hasher,
      rollupHash: rollup,
      projectId: opts.projectId || null,
      tags: (opts.tags || []).slice(0, 20),
      note: String(opts.note || "").slice(0, 2000),
      uploadedAt: new Date().toISOString(),
      transport: t.name
    };

    var meta = await needStore().put(TYPE, manifest, { id: opts.id || undefined });
    FieldKit.emit("files:changed", { id: meta.id, action: "upload" });
    return { id: meta.id, manifest: manifest };
  }

  /* ---- download ------------------------------------------------
     Returns a Blob. Assembling one is unavoidable — the user wants
     a file — but the chunks are decrypted straight into the parts
     array and never concatenated by hand, so the peak is the file
     once rather than three times.

     A missing chunk fails loudly with its index. "File is
     corrupt" would be true and useless; knowing chunk 41 of 63 is
     gone tells you whether a partial recovery is worth trying. */
  async function download(id, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var t = transport();
    var v = vault();

    var manifest = await needStore().get(id);
    if (!manifest) throw new Error("no such file record");
    if (!manifest.chunks || !manifest.chunks.length) throw new Error("manifest has no chunks");

    var parts = [];
    var total = manifest.chunks.length;
    for (var i = 0; i < total; i++) {
      onProgress(i, total, "downloading");
      var ch = manifest.chunks[i];
      var raw = await t.getBlob(ch.key, { timeout: opts.timeout || 120000 });
      if (!raw) {
        throw new Error("chunk " + (i + 1) + " of " + total + " is missing from the relay " +
          "(key " + ch.key.slice(0, 8) + "…). The file cannot be rebuilt.");
      }
      var plain = await v.openRaw(raw);
      if (manifest.chunkHashes && manifest.chunkHashes[i]) {
        var h = await sha256(plain);
        if (h !== manifest.chunkHashes[i]) {
          throw new Error("chunk " + (i + 1) + " decrypted but does not match its recorded hash");
        }
      }
      parts.push(plain);
    }
    onProgress(total, total, "assembling");
    return new Blob(parts, { type: manifest.mime || "application/octet-stream" });
  }

  /* ---- integrity ----------------------------------------------
     Presence only — does not download or decrypt. Cheap enough to
     run over every file, which is what makes it useful: the point
     is finding the file that broke months ago, before you need it. */
  async function verify(id) {
    var t = transport();
    var manifest = await needStore().get(id);
    if (!manifest) return { ok: false, reason: "no such record" };
    var index = await t.listBlobs();
    var have = Object.create(null);
    (index.blobs || []).forEach(function (b) { have[b.key] = b.size; });

    var missing = [], wrongSize = [];
    (manifest.chunks || []).forEach(function (c, i) {
      if (!(c.key in have)) missing.push(i + 1);
      else if (have[c.key] !== c.size) wrongSize.push(i + 1);
    });

    return {
      ok: !missing.length && !wrongSize.length,
      chunks: (manifest.chunks || []).length,
      missing: missing,
      wrongSize: wrongSize
    };
  }

  /* ---- garbage ------------------------------------------------
     Blobs no manifest points at. They come from failed uploads
     whose rollback did not complete, and from a manifest deleted
     while offline.

     Refuses to answer unless the whole record set is loaded. A
     partial view would call every chunk of every unloaded file an
     orphan, and the natural next step is to delete them — the same
     failure mode that shared.js guards against for record removal,
     with worse consequences. */
  async function orphans() {
    var s = needStore();
    if (!s.canReadHistory()) {
      throw new Error("cannot look for orphans without the full record list — " +
        "this needs a live relay connection, because a partial view would call " +
        "every chunk of every unloaded file an orphan");
    }
    var t = transport();
    var index = await t.listBlobs();
    var referenced = Object.create(null);
    var files = await s.list(TYPE);
    files.forEach(function (f) {
      (f.data.chunks || []).forEach(function (c) { referenced[c.key] = true; });
    });

    var out = [];
    (index.blobs || []).forEach(function (b) {
      if (!referenced[b.key]) out.push(b);
    });
    return {
      orphans: out,
      bytes: out.reduce(function (n, b) { return n + b.size; }, 0),
      totalBlobs: (index.blobs || []).length,
      referenced: Object.keys(referenced).length
    };
  }

  async function purgeOrphans(keys) {
    var t = transport();
    var removed = 0;
    for (var i = 0; i < keys.length; i++) {
      try { await t.deleteBlob(keys[i]); removed++; }
      catch (e) { FieldKit.log("warn", "files", "could not delete blob " + keys[i]); }
    }
    return removed;
  }

  /* Chunks first, then the manifest — the same order as upload and
     for the same reason. If chunk deletion fails halfway, what is
     left is an orphan rather than a file that opens to nothing. */
  async function remove(id) {
    var s = needStore();
    var manifest = await s.get(id);
    if (manifest && manifest.chunks) {
      var t = transport();
      for (var i = 0; i < manifest.chunks.length; i++) {
        try { await t.deleteBlob(manifest.chunks[i].key); }
        catch (e) { FieldKit.log("warn", "files", "chunk left behind: " + manifest.chunks[i].key); }
      }
    }
    await s.remove(id);
    FieldKit.emit("files:changed", { id: id, action: "remove" });
    return true;
  }

  async function list(opts) {
    opts = opts || {};
    var rows = await needStore().list(TYPE);
    if (opts.projectId) {
      rows = rows.filter(function (r) { return r.data.projectId === opts.projectId; });
    }
    return rows;
  }

  async function usage() {
    var t = transport();
    var index = await t.listBlobs();
    var files = await needStore().list(TYPE);
    return {
      files: files.length,
      logicalBytes: files.reduce(function (n, f) { return n + (f.data.size || 0); }, 0),
      storedBytes: index.usedBytes || 0,
      quotaBytes: index.quotaBytes,
      blobs: (index.blobs || []).length,
      transport: t.name
    };
  }

  function capabilities() {
    var s = FieldKit.service("store");
    var t = s && s.transport ? s.transport() : null;
    return {
      available: !!(t && typeof t.putBlob === "function"),
      transport: t ? t.name : null,
      durable: !!(t && t.name !== "local"),
      chunkBytes: CHUNK_BYTES,
      softMaxBytes: SOFT_MAX_BYTES,
      concurrency: CONCURRENCY
    };
  }

  FieldKit.provide("files", {
    TYPE: TYPE,
    CHUNK_BYTES: CHUNK_BYTES,
    SOFT_MAX_BYTES: SOFT_MAX_BYTES,
    KINDS: KINDS,
    upload: upload,
    download: download,
    verify: verify,
    orphans: orphans,
    purgeOrphans: purgeOrphans,
    remove: remove,
    list: list,
    usage: usage,
    capabilities: capabilities,
    classify: classify,
    advise: advise,
    fmtBytes: fmtBytes
  });
})(window.FieldKit);
