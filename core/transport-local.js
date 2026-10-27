/* ============================================================
   FieldKit :: transport-local
   IndexedDB-backed transport. Two jobs:

     1. Stands in for the relay during development, so Phase 1 is
        testable before the server exists. Same interface, so the
        real relay drops in without touching store.js.
     2. Holds the offline queue in every configuration.

   It stores exactly what the relay will store: ciphertext boxes
   plus the minimum plaintext metadata needed to sync (id, type,
   updatedAt). It never sees a key.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var DB_NAME = "fieldkit";
  var DB_VERSION = 3;
  var S_META = "meta";
  var S_RECORDS = "records";
  var S_QUEUE = "queue";
  var S_SNAPSHOTS = "snapshots";   // added in v2, see core/backup.js
  var S_BLOBS = "blobs";           // added in v3, see core/files.js

  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META);
        if (!db.objectStoreNames.contains(S_RECORDS)) {
          var rs = db.createObjectStore(S_RECORDS, { keyPath: "id" });
          rs.createIndex("type", "type", { unique: false });
        }
        if (!db.objectStoreNames.contains(S_QUEUE)) {
          db.createObjectStore(S_QUEUE, { keyPath: "seq", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(S_SNAPSHOTS)) {
          db.createObjectStore(S_SNAPSHOTS, { keyPath: "at" });
        }
        if (!db.objectStoreNames.contains(S_BLOBS)) {
          db.createObjectStore(S_BLOBS, { keyPath: "key" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("indexedDB.open failed")); };
      req.onblocked = function () { reject(new Error("indexedDB open blocked by another tab")); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var result;
        try { result = fn(s); } catch (e) { reject(e); return; }
        t.oncomplete = function () {
          resolve(result && typeof result.result !== "undefined" ? result.result : result);
        };
        t.onerror = function () { reject(t.error || new Error("transaction failed")); };
        t.onabort = function () { reject(t.error || new Error("transaction aborted")); };
      });
    });
  }

  function reqValue(store, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var r = fn(t.objectStore(store));
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error || new Error("request failed")); };
      });
    });
  }

  var LocalTransport = {
    name: "local",
    label: "LOCAL SIMULATED VAULT",

    async ping() {
      try { await openDB(); return true; }
      catch (e) { return false; }
    },

    async loadHeader() {
      var h = await reqValue(S_META, "readonly", function (s) { return s.get("vaultHeader"); });
      return h || null;
    },

    async saveHeader(header) {
      await tx(S_META, "readwrite", function (s) { s.put(header, "vaultHeader"); });
      return header;
    },

    async listRecords() {
      var all = await reqValue(S_RECORDS, "readonly", function (s) { return s.getAll(); });
      return (all || []).map(function (r) {
        return { id: r.id, type: r.type, updatedAt: r.updatedAt, deletedAt: r.deletedAt || null };
      });
    },

    async getRecord(id) {
      var r = await reqValue(S_RECORDS, "readonly", function (s) { return s.get(id); });
      return r || null;
    },

    async putRecord(rec) {
      await tx(S_RECORDS, "readwrite", function (s) { s.put(rec); });
      return rec;
    },

    async deleteRecord(id) {
      await tx(S_RECORDS, "readwrite", function (s) { s.delete(id); });
      return true;
    },

    /* ---- blobs ----
       Same interface as the relay's, so core/files.js does not care
       which one it got. Worth being clear-eyed about what this is
       though: IndexedDB lives in the browser profile, so blobs
       stored here do NOT travel with the drive and do NOT survive a
       Chromebook powerwash. They also compete for the same ~10 GB
       quota as everything else.

       So this is the development stand-in and the offline holding
       pen, not a place to keep a project. files.js says so in the
       UI rather than letting it be discovered later. */
    async putBlob(key, bytes) {
      await tx(S_BLOBS, "readwrite", function (s) {
        s.put({ key: key, bytes: bytes, size: bytes.length, at: new Date().toISOString() });
      });
      return true;
    },

    async getBlob(key) {
      var b = await reqValue(S_BLOBS, "readonly", function (s) { return s.get(key); });
      if (!b) return null;
      /* Round-trips as an ArrayBuffer in some engines and a
         Uint8Array in others. Normalise rather than trusting it. */
      return b.bytes instanceof Uint8Array ? b.bytes : new Uint8Array(b.bytes);
    },

    async deleteBlob(key) {
      await tx(S_BLOBS, "readwrite", function (s) { s.delete(key); });
      return true;
    },

    async listBlobs() {
      var all = await reqValue(S_BLOBS, "readonly", function (s) { return s.getAll(); });
      var blobs = (all || []).map(function (b) {
        return { key: b.key, size: b.size || (b.bytes ? b.bytes.length : 0), at: b.at || null };
      });
      var used = blobs.reduce(function (n, b) { return n + b.size; }, 0);
      /* No real quota here — the browser's own storage limit is the
         cap, and it is not knowable per-store. Reported as null so
         the UI shows "unknown" instead of inventing a number. */
      return { blobs: blobs, usedBytes: used, quotaBytes: null, maxBlobBytes: null };
    }
  };

  /* ---- offline queue (used no matter which transport is live) --- */
  var Queue = {
    async push(op) {
      await tx(S_QUEUE, "readwrite", function (s) { s.add(op); });
      return op;
    },
    async all() {
      var a = await reqValue(S_QUEUE, "readonly", function (s) { return s.getAll(); });
      return a || [];
    },
    async count() {
      var n = await reqValue(S_QUEUE, "readonly", function (s) { return s.count(); });
      return n || 0;
    },
    async clear() {
      await tx(S_QUEUE, "readwrite", function (s) { s.clear(); });
      return true;
    },
    async removeUpTo(seq) {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(S_QUEUE, "readwrite");
          var r = t.objectStore(S_QUEUE).delete(IDBKeyRange.upperBound(seq));
          r.onsuccess = function () { resolve(true); };
          r.onerror = function () { reject(r.error); };
        });
      });
    },
    /* Honest rather than optimistic: on a platform with no IndexedDB
       at all, callers need to know before they try, and a self-test
       needs to say SKIPPED rather than FAILED. */
    available: typeof indexedDB !== "undefined"
  };

  /* ---- snapshot ring -------------------------------------------
     A rolling set of sealed archives, kept locally so that losing
     the relay does not depend on anyone having remembered to press
     EXPORT. Content is a normal archive — sealed boxes only — so
     this store is no more sensitive than the records store beside
     it. See core/backup.js for what writes here and when. */
  var Snapshots = {
    async put(entry) {
      await tx(S_SNAPSHOTS, "readwrite", function (s) { s.put(entry); });
      return entry;
    },
    async list() {
      var all = await reqValue(S_SNAPSHOTS, "readonly", function (s) { return s.getAll(); });
      return (all || []).map(function (e) {
        return { at: e.at, reason: e.reason, records: e.records, bytes: e.bytes,
                 checksum: e.checksum };
      }).sort(function (a, b) { return b.at - a.at; });
    },
    async get(at) {
      var e = await reqValue(S_SNAPSHOTS, "readonly", function (s) { return s.get(at); });
      return e || null;
    },
    async remove(at) {
      await tx(S_SNAPSHOTS, "readwrite", function (s) { s.delete(at); });
      return true;
    },
    async clear() {
      await tx(S_SNAPSHOTS, "readwrite", function (s) { s.clear(); });
      return true;
    },
    /* Honest rather than optimistic: on a platform with no IndexedDB
       at all, callers need to know before they try, and a self-test
       needs to say SKIPPED rather than FAILED. */
    available: typeof indexedDB !== "undefined"
  };

  /* Device identity, so per-row last-write-wins can work later. */
  async function deviceId() {
    var id = await reqValue(S_META, "readonly", function (s) { return s.get("deviceId"); });
    if (!id) {
      var b = new Uint8Array(8);
      window.crypto.getRandomValues(b);
      id = Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
      await tx(S_META, "readwrite", function (s) { s.put(id, "deviceId"); });
    }
    return id;
  }

  FieldKit.provide("transportLocal", LocalTransport);
  FieldKit.provide("queue", Queue);
  FieldKit.provide("snapshots", Snapshots);
  FieldKit.provide("deviceId", deviceId);
})(window.FieldKit);
