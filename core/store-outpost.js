/* ============================================================
   FieldKit :: store-outpost
   The store OUTPOST gets instead of the vault.

   OUTPOST is the limited build (FIELDKIT_PROJECT.md §14.1). It is
   not the full app with features switched off — `core/store.js`,
   `core/crypto.js` and both transports are not in its manifest at
   all, so there is no vault code on the machine to reach.

   But the modules it *does* carry — GUESTBOOK, QR FORGE,
   DIAGNOSTICS — all write through `ctx.store`, so something has to
   answer that. This is that something: the same surface, backed by
   plain IndexedDB, holding only what this build produces.

   WHAT THIS IS NOT. There is no passphrase, no envelope, and no
   encryption here, and that is deliberate rather than an omission.
   Encrypting with a key the same machine also stores protects
   nothing; it just makes the absence of protection harder to see.
   So: nothing secret is allowed in here. The messaging account's
   private key does NOT live in this store — it is wrapped by the
   account password and handled separately (§14.2). If a future
   module wants to keep a secret, it needs its own answer, not this.

   Anyone with the machine can read what OUTPOST wrote. Everything
   OUTPOST writes is a guestbook signature, a QR payload, or a
   self-test result, and none of that was ever private.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var DB_NAME = "fieldkit-outpost";
  var DB_VERSION = 1;
  var SHELF = "records";

  var STATE = {
    EMPTY: "EMPTY", LOCKED: "LOCKED", ONLINE: "ONLINE",
    OFFLINE: "OFFLINE", GUEST: "GUEST", LOCAL: "LOCAL"
  };

  var db = null;
  var seq = 0;
  var opened = false;
  var openError = null;

  /* Written to on every put and served from on every read.

     Not an optimisation — `list()` and `get()` are synchronous-ish
     in every caller's mental model and IndexedDB is not, but more
     importantly a machine that refuses IndexedDB (private windows in
     some browsers, storage disabled by policy) must still get a
     working OUTPOST rather than a dead one. When the database cannot
     be opened this cache is the whole store, and the session simply
     does not survive the tab. That is a degradation worth having
     silently; PREFLIGHT and DIAGNOSTICS both report it out loud. */
  var cache = new Map();

  function open() {
    if (db || openError) return Promise.resolve(db);
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { openError = e.message; return resolve(null); }

      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(SHELF)) d.createObjectStore(SHELF, { keyPath: "id" });
      };
      req.onerror = function () {
        openError = (req.error && req.error.message) || "could not open the database";
        resolve(null);
      };
      req.onblocked = function () { openError = "another tab is holding the database open"; resolve(null); };
      req.onsuccess = function () { db = req.result; resolve(db); };
    });
  }

  function tx(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!db) return resolve(null);
      var t;
      try { t = db.transaction(SHELF, mode); } catch (e) { return reject(e); }
      var shelf = t.objectStore(SHELF);
      var out;
      try { out = fn(shelf); } catch (e) { return reject(e); }
      t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
      t.onerror = function () { reject(t.error || new Error("transaction failed")); };
      t.onabort = function () { reject(t.error || new Error("transaction aborted")); };
    });
  }

  function metaOf(rec) {
    return {
      id: rec.id, type: rec.type,
      createdAt: rec.createdAt, updatedAt: rec.updatedAt,
      deviceId: "outpost", schemaVersion: FieldKit.SCHEMA_VERSION,
      author: rec.author || null
    };
  }

  /* ---- lifecycle ---------------------------------------------- */
  async function init() {
    await open();
    opened = true;
    cache.clear();

    if (db) {
      try {
        var rows = await tx("readonly", function (shelf) { return shelf.getAll(); });
        (rows || []).forEach(function (r) { cache.set(r.id, r); });
      } catch (e) {
        openError = e.message;
        FieldKit.log("warn", "store-outpost", "could not read stored records: " + e.message);
      }
    }

    FieldKit.emit("store:state", { state: STATE.LOCAL, online: false });
    FieldKit.emit("store:ready", { state: STATE.LOCAL });
    return { state: STATE.LOCAL, online: false, transport: "outpost", persistent: !!db };
  }

  /* ---- reads ---------------------------------------------------
     From the cache, never the database, so the shape of a read here
     matches the vault store exactly: `list()` and `get()` serve what
     was loaded, and nothing goes to storage mid-render. */
  async function get(id) {
    var r = cache.get(id);
    return r ? r.data : null;
  }

  async function list(type) {
    var out = [];
    cache.forEach(function (r, id) {
      if (!type || r.type === type) out.push({ id: id, meta: metaOf(r), data: r.data });
    });
    out.sort(function (a, b) { return (b.meta.updatedAt || "").localeCompare(a.meta.updatedAt || ""); });
    return out;
  }

  /* ---- writes -------------------------------------------------- */
  async function put(type, data, opts) {
    opts = opts || {};
    var now = new Date().toISOString();
    var id = opts.id || ("op-" + Date.now().toString(36) + "-" + (++seq));
    var prev = cache.get(id);

    var rec = {
      id: id, type: type, data: data,
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
      author: authorName()
    };

    cache.set(id, rec);
    /* The cache is authoritative for this session, so a storage
       failure costs persistence and nothing else. Losing the write
       entirely because the disk said no would be the worse trade. */
    if (db) {
      try { await tx("readwrite", function (shelf) { return shelf.put(rec); }); }
      catch (e) { FieldKit.log("warn", "store-outpost", "not persisted: " + e.message); }
    }

    FieldKit.emit("store:changed", { id: id, type: type });
    return metaOf(rec);
  }

  async function remove(id) {
    cache.delete(id);
    if (db) {
      try { await tx("readwrite", function (shelf) { return shelf.delete(id); }); }
      catch (e) { FieldKit.log("warn", "store-outpost", "not removed from storage: " + e.message); }
    }
    FieldKit.emit("store:changed", { id: id, removed: true });
    return true;
  }

  async function clear() {
    cache.clear();
    if (db) {
      try { await tx("readwrite", function (shelf) { return shelf.clear(); }); }
      catch (e) { FieldKit.log("warn", "store-outpost", "could not clear storage: " + e.message); }
    }
    FieldKit.emit("store:changed", { cleared: true });
    return true;
  }

  function authorName() {
    var s = FieldKit.service("settings");
    var n = s ? String(s.get("displayName") || "").trim() : "";
    return n || null;
  }

  /* ---- the vault surface, answered honestly --------------------
     Modules written for the full build ask these. They must get a
     truthful answer rather than a throw, because a module reporting
     "no vault" degrades gracefully while a module hitting a
     TypeError takes the window down.

     The ones that would *do* something irreversible are absent on
     purpose — there is no unlock(), setup(), or transport() here,
     and `tests/outpost.test.js` asserts they stay absent. A module
     that calls one gets a clear "not a function" during the exercise
     rather than quietly operating on a vault that does not exist. */
  FieldKit.provide("store", {
    STATE: STATE,
    init: init,
    get: get,
    list: list,
    put: put,
    remove: remove,
    clear: clear,

    state: function () { return STATE.LOCAL; },
    /* Same rule as pull() and flushQueue() below: named and honest
       rather than missing, so anything shared with FIELDKIT can ask
       without first checking which of the two stores it got. */
    transportName: function () { return "local"; },
    isUnlocked: function () { return true; },
    hasVault: function () { return false; },
    isOnline: function () { return false; },
    author: authorName,
    header: function () { return null; },
    vault: function () { return null; },
    needsNewPassword: function () { return false; },
    openedWithRecovery: function () { return false; },
    unprovisionedTransport: function () { return null; },

    /* Sync is a vault concept and there is nothing to sync. Named
       and inert rather than missing, for the same reason as above. */
    pull: async function () { return { added: 0, updated: 0, removed: 0, changes: [] }; },
    flushQueue: async function () { return { pushed: 0, failed: 0 }; },
    pendingCount: async function () { return 0; },
    startAutoPull: function () { return false; },
    stopAutoPull: function () { },

    /* Diagnostics-only, and the reason DIAGNOSTICS can tell a
       session that will survive a reload from one that will not. */
    persistent: function () { return !!db; },
    storageError: function () { return openError; },
    ready: function () { return opened; },
    initialised: function () { return opened; }
  });
})(window.FieldKit);
