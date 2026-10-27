/* ============================================================
   FieldKit :: tests/files.test.js
   The chunked encrypted file store (core/files.js).

   The in-app exercise only covers a single-chunk round trip,
   because moving megabytes during a self-test on a Chromebook is
   not a kindness. Everything that only shows up across a chunk
   boundary lives here: ordering, the rollback path, orphan
   detection, and the guarantee that the transport never sees a
   recognisable byte of the original.

   Chunk size is passed per upload and set to 400 bytes here, so a
   "multi-chunk file" costs 3 KB instead of 12 MB. That option
   exists because this suite went looking for the rollback path and
   found it had never once been executed — the default 4 MB chunk
   meant every earlier fixture was a single chunk.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const nodeCrypto = require("crypto");

const FILES = [
  "core/kernel.js",
  "core/settings.js",
  "core/crypto.js",
  "core/transport-local.js",
  "core/store.js",
  "core/files.js"
];

/* ---- a transport that behaves like the relay's blob routes ----
   Deliberately not the IndexedDB one: this suite is about what
   files.js does, and a fake lets us break things on purpose —
   fail the fourth PUT, lose a chunk, count the requests. */
function makeTransport(opts) {
  opts = opts || {};
  const blobs = new Map();
  const records = new Map();
  const log = { puts: 0, gets: 0, deletes: 0 };
  let failAfter = opts.failAfter || Infinity;

  return {
    name: opts.name || "fake-relay",
    log, blobs, records,
    setFailAfter(n) { failAfter = n; },

    async ping() { return true; },
    async loadHeader() { return this._header || null; },
    async saveHeader(h) { this._header = h; return h; },
    async listRecords() {
      return Array.from(records.values()).map((r) => ({
        id: r.id, type: r.type, updatedAt: r.updatedAt, deletedAt: r.deletedAt || null
      }));
    },
    async getRecord(id) { return records.get(id) || null; },
    async putRecord(rec) { records.set(rec.id, rec); return rec; },
    async deleteRecord(id) { records.delete(id); return true; },

    async putBlob(key, bytes) {
      log.puts++;
      if (log.puts > failAfter) throw new Error("relay refused the blob (simulated)");
      /* Copy, so a caller that reuses its buffer cannot silently
         make the test pass. */
      blobs.set(key, Uint8Array.from(bytes));
      return true;
    },
    async getBlob(key) {
      log.gets++;
      const b = blobs.get(key);
      return b ? Uint8Array.from(b) : null;
    },
    async deleteBlob(key) { log.deletes++; blobs.delete(key); return true; },
    async listBlobs() {
      const out = [];
      blobs.forEach((v, k) => out.push({ key: k, size: v.length, at: null }));
      return { blobs: out, usedBytes: out.reduce((n, b) => n + b.size, 0),
               quotaBytes: 1024 * 1024, maxBlobBytes: 8192 };
    }
  };
}

/* A stand-in for the browser File/Blob pair. files.js only uses
   .size, .name, .type and .slice().arrayBuffer(). */
function fakeFile(name, bytes, type) {
  return {
    name, type: type || "", size: bytes.length,
    slice(start, end) {
      const part = bytes.subarray(start, end);
      return { async arrayBuffer() { return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength); } };
    }
  };
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  nodeCrypto.webcrypto.getRandomValues(b);
  return b;
}

(async function () {
  const t = makeRunner("FILES");
  const { ok, section, throws } = t;

  const FieldKit = bootstrap(FILES);

  /* Blob is only used by download() to assemble the result. Node
     18+ has it globally; define a minimal one if not. */
  if (typeof global.Blob !== "function") {
    global.Blob = class {
      constructor(parts, o) {
        this.type = (o && o.type) || "";
        const total = parts.reduce((n, p) => n + p.length, 0);
        const all = new Uint8Array(total);
        let at = 0;
        parts.forEach((p) => { all.set(p, at); at += p.length; });
        this._bytes = all;
        this.size = total;
      }
      async arrayBuffer() { return this._bytes.buffer.slice(0, this._bytes.length); }
    };
  }

  const store = FieldKit.need("store");
  const files = FieldKit.need("files");
  const transport = makeTransport({});

  await store.init([transport]);
  await store.setup("correct horse battery staple", {});

  /* Every multi-chunk test passes an explicit small chunk size.
     The default is 4 MB, so without this the suite would need a
     12 MB fixture to enter the chunking path at all — and until a
     probe went looking, that path had never been exercised. */
  const SMALL = 400;

  section("a small file makes one chunk and comes back intact");
  {
    const original = randomBytes(2048);
    const up = await files.upload(fakeFile("notes.bin", original), { chunkBytes: 4096 });
    ok("upload returned a record id", !!up.id);
    ok("the manifest recorded the original size", up.manifest.size === 2048,
      "got " + up.manifest.size);
    ok("it recorded the chunk size it used", up.manifest.chunkBytes > 0);
    ok("one chunk for a file smaller than the chunk size",
      up.manifest.chunks.length === 1, up.manifest.chunks.length + " chunks");

    const back = await files.download(up.id);
    const got = new Uint8Array(await back.arrayBuffer());
    ok("the round trip preserved the length", got.length === original.length,
      original.length + " -> " + got.length);
    ok("the round trip preserved every byte",
      Buffer.compare(Buffer.from(got), Buffer.from(original)) === 0);

    await files.remove(up.id);
  }

  section("the relay never sees the plaintext");
  {
    /* The claim the whole design rests on. A recognisable run of
       original bytes anywhere in the stored blobs would mean the
       encryption is not doing what the module says it is. */
    const marker = Buffer.from("THIS-IS-THE-SECRET-ASSET-CONTENT-0123456789");
    const payload = new Uint8Array(3000);
    payload.set(marker, 100);
    payload.set(marker, 1500);

    const up = await files.upload(fakeFile("secret.blend", payload), {
      chunkBytes: SMALL, note: "a note that is also not for the relay"
    });

    let leaked = false;
    transport.blobs.forEach((v) => {
      if (Buffer.from(v).includes(marker)) leaked = true;
    });
    ok("no stored chunk contains the plaintext marker", !leaked);

    const rec = transport.records.get(up.id);
    const asJson = JSON.stringify(rec);
    ok("the manifest record is sealed, not plaintext", !!(rec && rec.box && rec.box.ct));
    ok("the filename is not in the stored record", asJson.indexOf("secret.blend") < 0);
    ok("the note is not in the stored record",
      asJson.indexOf("not for the relay") < 0);
    ok("the record type IS visible — sync needs it", rec.type === "file");

    await files.remove(up.id);
  }

  section("chunk boundaries");
  {
    /* Sized to land just past a boundary, because an off-by-one in
       the slice arithmetic survives a file that divides evenly. */
    const original = randomBytes(SMALL * 3 + 137);
    const up = await files.upload(fakeFile("odd.bin", original), { chunkBytes: SMALL });
    const expect = Math.ceil(original.length / SMALL);
    ok("chunk count matches ceil(size / chunkBytes)",
      up.manifest.chunks.length === expect && expect > 3,
      "expected " + expect + ", got " + up.manifest.chunks.length);

    const sum = up.manifest.chunks.reduce((n, c) => n + c.plainSize, 0);
    ok("the chunk plain sizes add up to the file size, including the short last one", sum === original.length,
      sum + " vs " + original.length);

    const back = new Uint8Array(await (await files.download(up.id)).arrayBuffer());
    ok("a file that does not divide evenly still rebuilds",
      Buffer.compare(Buffer.from(back), Buffer.from(original)) === 0);

    await files.remove(up.id);
  }

  section("every chunk gets its own IV");
  {
    /* Identical plaintext chunks must not produce identical
       ciphertext. If they did, anyone holding the relay could see
       which parts of a file repeat — and could confirm a guess
       about content by encrypting it themselves. */
    const repeated = new Uint8Array(2400);   // all zeroes, maximally repetitive
    const up = await files.upload(fakeFile("zeros.bin", repeated), { chunkBytes: SMALL });
    const seen = new Set();
    let dupe = false;
    up.manifest.chunks.forEach((c) => {
      const hex = Buffer.from(transport.blobs.get(c.key)).toString("hex");
      if (seen.has(hex)) dupe = true;
      seen.add(hex);
    });
    ok("identical plaintext chunks encrypt differently", !dupe);

    const ivs = new Set(up.manifest.chunks.map((c) =>
      Buffer.from(transport.blobs.get(c.key).subarray(0, 12)).toString("hex")));
    ok("every chunk has a distinct IV", ivs.size === up.manifest.chunks.length,
      ivs.size + " IVs for " + up.manifest.chunks.length + " chunks");

    await files.remove(up.id);
  }

  section("a failed upload does not leave a broken file");
  {
    const before = transport.records.size;
    const blobsBefore = transport.blobs.size;
    transport.setFailAfter(transport.log.puts + 1);   // let one land, refuse the rest

    const big = randomBytes(SMALL * 8);
    let threw = null;
    try { await files.upload(fakeFile("doomed.bin", big), { chunkBytes: SMALL }); }
    catch (e) { threw = e; }
    transport.setFailAfter(Infinity);

    ok("the upload failed rather than half-succeeding", !!threw);
    ok("no manifest record was written", transport.records.size === before,
      transport.records.size + " vs " + before);
    ok("the chunks that landed were rolled back",
      transport.blobs.size === blobsBefore,
      transport.blobs.size + " blobs vs " + blobsBefore);
  }

  section("a missing chunk is refused, not silently truncated");
  {
    const original = randomBytes(SMALL * 4);
    const up = await files.upload(fakeFile("gap.bin", original), { chunkBytes: SMALL });

    const victim = up.manifest.chunks[up.manifest.chunks.length - 1];
    transport.blobs.delete(victim.key);

    await throws("download refuses a file with a hole",
      () => files.download(up.id), /missing/i);

    const v = await files.verify(up.id);
    ok("verify reports it as broken", v.ok === false);
    ok("verify names which chunk", v.missing.length === 1,
      JSON.stringify(v.missing));
    ok("verify counts the rest as present",
      v.chunks === up.manifest.chunks.length);

    await files.remove(up.id);
  }

  section("tampering is caught by the cipher, not by trust");
  {
    const original = randomBytes(1500);
    const up = await files.upload(fakeFile("honest.bin", original), {});
    const key = up.manifest.chunks[0].key;
    const b = transport.blobs.get(key);
    b[b.length - 1] ^= 0xff;               // flip a bit in the ciphertext
    transport.blobs.set(key, b);

    await throws("a modified chunk will not decrypt", () => files.download(up.id));
    await files.remove(up.id);
  }

  section("deleting a file takes its chunks with it");
  {
    const up = await files.upload(fakeFile("temp.bin", randomBytes(2000)), {});
    const keys = up.manifest.chunks.map((c) => c.key);
    ok("chunks are on the transport before deletion",
      keys.every((k) => transport.blobs.has(k)));

    await files.remove(up.id);
    ok("every chunk is gone afterwards",
      keys.every((k) => !transport.blobs.has(k)));
    ok("the manifest record is gone too", !transport.records.has(up.id));
  }

  section("orphan detection");
  {
    /* An orphan is a chunk no manifest references. The realistic
       source is a rollback that could not finish, so it is
       simulated the honest way rather than by inventing a key. */
    await transport.putBlob("deadbeef".repeat(4), randomBytes(64));
    const up = await files.upload(fakeFile("kept.bin", randomBytes(900)), {});

    const o = await files.orphans();
    const keys = o.orphans.map((b) => b.key);
    ok("the stray chunk is found", keys.indexOf("deadbeef".repeat(4)) >= 0);
    ok("chunks belonging to a real file are NOT called orphans",
      up.manifest.chunks.every((c) => keys.indexOf(c.key) < 0));
    const live = await files.list();
    const liveChunks = live.reduce((n, f) => n + (f.data.chunks || []).length, 0);
    ok("referenced count matches every chunk of every live file",
      o.referenced === liveChunks, o.referenced + " vs " + liveChunks);

    const n = await files.purgeOrphans(keys);
    ok("purging removed exactly the orphans", n === keys.length);
    ok("the real file's chunks survived the purge",
      up.manifest.chunks.every((c) => transport.blobs.has(c.key)));

    const after = await files.orphans();
    ok("a second pass finds nothing", after.orphans.length === 0);

    await files.remove(up.id);
  }

  section("orphan search refuses a partial view");
  {
    /* The dangerous case. Offline, the cache holds only queued
       work, so every chunk of every unloaded file looks orphaned —
       and the obvious next click deletes them all. It has to
       refuse rather than answer confidently. */
    const solo = makeTransport({ name: "empty" });
    const k2 = bootstrap(FILES);
    const s2 = k2.need("store");
    const f2 = k2.need("files");
    await s2.init([solo]);
    await s2.setup("another vault entirely", {});
    await f2.upload(fakeFile("a.bin", randomBytes(300)), {});

    /* Force the partial state the guard exists for. */
    const canRead = s2.canReadHistory();
    ok("the fixture starts with a full view", canRead === true);

    await s2.init([{ ...solo, ping: async () => false }]);
    await throws("orphan search refuses without the whole record list",
      () => f2.orphans(), /full record list|partial/i);
  }

  section("usage is reported honestly");
  {
    const up = await files.upload(fakeFile("measured.bin", randomBytes(2500)), {});
    const u = await files.usage();
    ok("it counts the file", u.files >= 1);
    ok("logical size is the original size", u.logicalBytes >= 2500);
    ok("stored size exceeds logical — IV and tag per chunk",
      u.storedBytes > u.logicalBytes,
      u.storedBytes + " stored vs " + u.logicalBytes + " logical");
    ok("it names the transport", u.transport === transport.name);
    await files.remove(up.id);
  }

  section("classification and advice");
  {
    const cases = {
      "player.gd": "gdscript", "level.tscn": "godot-scene", "mat.tres": "godot-res",
      "rock.blend": "blender", "rock.glb": "model", "albedo.png": "texture",
      "step.wav": "audio", "readme.md": "doc", "data.json": "data",
      "thing.unknownext": "other"
    };
    let bad = [];
    Object.keys(cases).forEach((n) => {
      const got = files.classify(n).kind;
      if (got !== cases[n]) bad.push(n + "→" + got);
    });
    ok("every toolchain extension classifies correctly", bad.length === 0, bad.join(", "));

    ok("a small .tscn is pointed at Git",
      /git/i.test(files.advise("a.tscn", 20000).text));
    ok("a .blend is welcomed",
      files.advise("a.blend", 50 * 1024 * 1024).level === "ok");
    ok("a .import is called derived, not a source file",
      /derived/i.test(files.advise("tree.png.import", 800).text));
    ok("a very large file warns about request count",
      /consider git lfs/i.test(files.advise("huge.bin", 400 * 1024 * 1024).text));
    ok("an archive is flagged as opaque",
      /opaque/i.test(files.advise("stuff.zip", 5 * 1024 * 1024).text));
  }

  section("capabilities never overstate durability");
  {
    const c = files.capabilities();
    ok("blob support is detected", c.available === true);
    ok("a real transport is called durable", c.durable === true);

    const k3 = bootstrap(FILES);
    const s3 = k3.need("store");
    const f3 = k3.need("files");
    await s3.init([]);                       // falls back to transport-local
    const c3 = f3.capabilities();
    ok("the local transport is NOT called durable", c3.durable === false,
      "transport was " + c3.transport);
  }

  t.state.fail === 0
    ? console.log("\nRESULT  pass " + t.state.pass + "  fail 0")
    : console.log("\nRESULT  pass " + t.state.pass + "  fail " + t.state.fail);
  process.exit(t.state.fail ? 1 : 0);
})().catch((e) => {
  console.log("\nSUITE CRASHED: " + e.stack);
  console.log("RESULT  pass 0  fail 1");
  process.exit(1);
});
