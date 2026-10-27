/* ============================================================
   FieldKit :: guest
   Guest session — hand the drive to someone without handing over
   the vault.

   A guest never unlocks anything. Instead the real store service is
   swapped for an in-memory one that looks identical to modules but
   holds nothing, persists nothing, and dies with the tab. Modules
   that touch your network, your relay, or your settings are sealed
   outright; the rest work normally on empty data.

   The honest boundary: this protects your *data*, not the drive.
   Anyone holding the USB can read the source, and the encrypted
   records still live on the relay behind your password. Guest mode
   is about not showing someone your notes while they borrow a hex
   converter — nothing stronger is claimed.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var active = false;
  var realStore = null;

  /* ---- in-memory stand-in for store -------------------------- */
  function memoryStore() {
    var mem = new Map();
    var seq = 0;

    function meta(id, type, rec) {
      return {
        id: id, type: type,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt,
        deviceId: "guest", schemaVersion: FieldKit.SCHEMA_VERSION
      };
    }

    return {
      STATE: { EMPTY: "EMPTY", LOCKED: "LOCKED", ONLINE: "ONLINE", OFFLINE: "OFFLINE", GUEST: "GUEST" },

      async put(type, data, opts) {
        opts = opts || {};
        var id = opts.id || ("guest-" + (++seq));
        var prev = mem.get(id);
        var now = new Date().toISOString();
        var rec = {
          type: type, data: data,
          createdAt: (prev && prev.createdAt) || now,
          updatedAt: now
        };
        mem.set(id, rec);
        FieldKit.emit("store:changed", { id: id, type: type });
        return meta(id, type, rec);
      },

      async get(id) { var r = mem.get(id); return r ? r.data : null; },

      async list(type) {
        var out = [];
        mem.forEach(function (r, id) {
          if (!type || r.type === type) out.push({ id: id, meta: meta(id, r.type, r), data: r.data });
        });
        out.sort(function (a, b) { return b.meta.updatedAt.localeCompare(a.meta.updatedAt); });
        return out;
      },

      async remove(id) {
        mem.delete(id);
        FieldKit.emit("store:changed", { id: id, removed: true });
        return true;
      },

      /* Sync is a no-op rather than an error: a guest pressing a sync
         button should get an honest "nothing to send", not a fault. */
      async sync() { return { pushed: 0, failed: 0, skipped: "guest session" }; },
      async hydrate() { return; },
      async pendingCount() { return 0; },

      /* The real store exposes these, so anything that calls them
         through ctx.store crashes in a guest session rather than
         degrading — which is how the GUESTBOOK self-check broke.
         A guest has nothing to export and nowhere to import to, so
         they answer honestly instead of throwing.

         `exportRecords` returns the guest's own in-memory rows in
         the sealed shape callers expect, minus any sealing: there
         is no vault here, and pretending otherwise would be worse
         than an empty list. */
      async exportRecords() {
        var out = [];
        mem.forEach(function (r, id) {
          out.push({ id: id, type: r.type, createdAt: r.createdAt, updatedAt: r.updatedAt,
            schemaVersion: FieldKit.SCHEMA_VERSION, guest: true });
        });
        return out;
      },
      async importRecords() {
        throw new Error("a guest session has no vault to import into");
      },
      async pull() { return { added: 0, updated: 0, removed: 0, changes: [] }; },
      startAutoPull: function () {},
      stopAutoPull: function () {},
      author: function () { return "guest"; },
      header: function () { return null; },
      needsNewPassword: function () { return false; },
      openedWithRecovery: function () { return false; },
      async changePassword() {
        throw new Error("a guest session has no vault password to change");
      },
      async attachTransport() {
        throw new Error("a guest session has no vault to put on a transport");
      },
      /* Never anything to provision: a guest holds no vault, so no
         relay is waiting for one. Answering null rather than
         omitting the key keeps RELAY LINK's checks from throwing if
         it is ever opened in a guest session. */
      unprovisionedTransport: function () { return null; },

      state: function () { return "GUEST"; },
      /* A guest store is ready the moment it exists — there is
         nothing to reach and nothing to wait for. */
      initialised: function () { return true; },
      isUnlocked: function () { return true; },
      hasVault: function () { return false; },
      canReadHistory: function () { return false; },
      vault: function () { return null; },
      transportName: function () { return "memory"; },
      deviceId: function () { return "guest"; },
      isGuest: true
    };
  }

  /* ---- activation --------------------------------------------- */
  function activate() {
    if (active) return;
    active = true;
    realStore = FieldKit.service("store");
    /* Replacing the service is what makes every module guest-safe by
       default: none of them reach past ctx.store, so none of them can
       see the real vault once this is in place. */
    FieldKit.provide("store", memoryStore());
    FieldKit.log("warn", "guest", "guest session active — vault sealed, storage is memory-only");
    FieldKit.emit("store:state", { state: "GUEST", detail: "guest session" });
    FieldKit.emit("guest:active", {});
  }

  /* There is no deactivate(). Coming back from a guest session means
     a full reload and the master password — anything softer would
     leave a decrypted vault one function call away from a stranger. */
  function end() {
    if (!active) return;
    location.reload();
  }

  /* Modules opt in. Anything not listed is sealed for a guest —
     failing closed is the only defensible default here. */
  function allowed(mod) {
    if (!active) return true;
    return !!(mod && mod.guestSafe);
  }

  FieldKit.provide("guest", {
    activate: activate,
    end: end,
    active: function () { return active; },
    allowed: allowed,
    realState: function () { return realStore ? realStore.state() : "UNKNOWN"; }
  });
})(window.FieldKit);
