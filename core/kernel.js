/* ============================================================
   FieldKit :: kernel
   Global namespace, module registry, service locator, event bus,
   and the boot log that the POST screen reads from.

   Classic script, no ES modules — see FIELDKIT_PROJECT.md §1.
   Everything self-registers onto window.FieldKit.
   ============================================================ */
(function (global) {
  "use strict";

  var VERSION = "0.3.1";
  var SCHEMA_VERSION = 1;

  var modules = {};      // id -> module definition
  var failed = {};       // id -> Error, for modules that died on load
  var services = {};     // name -> service object
  var listeners = {};    // event -> [fn]
  var logBuf = [];       // ring buffer, capped
  var LOG_CAP = 500;

  function now() { return new Date().toISOString(); }

  /* ---- logging ------------------------------------------------ */
  function log(level, source, message) {
    var entry = { t: now(), level: level, source: source, message: String(message) };
    logBuf.push(entry);
    if (logBuf.length > LOG_CAP) logBuf.shift();
    emit("log", entry);
    if (level === "error" && global.console) console.error("[" + source + "]", message);
    return entry;
  }

  /* ---- events ------------------------------------------------- */
  function on(evt, fn) {
    (listeners[evt] || (listeners[evt] = [])).push(fn);
    return function off() {
      var a = listeners[evt] || [];
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
  }

  function emit(evt, payload) {
    var a = (listeners[evt] || []).slice();
    for (var i = 0; i < a.length; i++) {
      // A bad listener must never take down the emitter.
      try { a[i](payload); }
      catch (e) {
        if (evt !== "log") log("error", "kernel", "listener for '" + evt + "' threw: " + e.message);
      }
    }
  }

  /* ---- module registry ---------------------------------------- */
  /* A module is:
     { id, title, icon, width?, height?, singleton?,
       mount(el, ctx), unmount?(), searchIndex?() }              */
  function register(id, def) {
    if (!id || typeof id !== "string") throw new Error("register() needs a string id");
    if (!def || typeof def.mount !== "function") throw new Error("module '" + id + "' has no mount()");
    def.id = id;
    def.title = def.title || id.toUpperCase();
    def.icon = def.icon || "▣";
    modules[id] = def;
    log("info", "kernel", "module registered: " + id);
    emit("module:registered", def);
    return def;
  }

  function markFailed(id, err) {
    failed[id] = err;
    log("error", "kernel", "module failed: " + id + " -- " + (err && err.message));
    emit("module:failed", { id: id, error: err });
  }

  /* ---- services (injected into modules as ctx) ---------------- */
  function provide(name, impl) {
    services[name] = impl;
    log("info", "kernel", "service ready: " + name);
    emit("service:ready", { name: name, service: impl });
    return impl;
  }

  function need(name) {
    if (!services[name]) throw new Error("service '" + name + "' is not available yet");
    return services[name];
  }

  /* The object every module receives. Modules must not reach for
     globals — everything they are allowed to touch is in here. */
  function context() {
    return {
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
      store: services.store,
      crypto: services.crypto,
      settings: services.settings,
      ai: services.ai,
      ui: services.ui,
      shell: services.shell,
      log: function (msg) { return log("info", "module", msg); },
      warn: function (msg) { return log("warn", "module", msg); },
      error: function (msg) { return log("error", "module", msg); },
      on: on,
      emit: emit
    };
  }

  /* ---- sequential classic-script loader ----------------------- */
  /* Order matters and classic scripts do not guarantee it, so we
     load strictly one at a time. Any single failure is isolated. */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(src); };
      s.onerror = function () { reject(new Error("could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  async function loadAll(list, onProgress) {
    var loaded = [], errors = [];
    for (var i = 0; i < list.length; i++) {
      var src = list[i];
      if (onProgress) onProgress(i, list.length, src);
      try {
        await loadScript(src);
        loaded.push(src);
      } catch (e) {
        errors.push({ src: src, error: e });
        markFailed(src.replace(/^.*\//, "").replace(/\.js$/, ""), e);
      }
    }
    return { loaded: loaded, errors: errors };
  }

  /* ---- mount generations ---------------------------------------
     A module's async work outlives the panel that started it, and
     `nodes` is module scope rather than per-mount. So this happens:

       1. FULL SYSTEM EXERCISE mounts SETTINGS offscreen, which
          kicks off a check.
       2. A millisecond later the exercise unmounts it.
       3. The user opens SETTINGS for real. mount() points `nodes`
          at the live panel.
       4. The check from step 1 finally resolves and writes into
          `nodes` — which is now the panel on screen.

     The result is a live panel with a section cleared, or rows
     appended twice, or "CHECKING..." sitting in the middle of a
     finished layout. It looks like a rendering bug, it survives
     closing and reopening the window because the damage is already
     done, and it goes away on refresh — which is exactly the report
     that led here.

     mountGuard() hands a mount a way to ask whether it is still the
     current one. Continuations return early if not. It is a counter
     per module id, and that is all it needs to be: mounts of one
     module never overlap. */
  var mountGen = Object.create(null);
  function mountGuard(id) {
    var mine = (mountGen[id] = (mountGen[id] || 0) + 1);
    var alive = function () { return mountGen[id] === mine; };
    /* Call from unmount(). Without it the guard catches only "a
       newer mount exists" and misses the commoner case: the panel
       was closed and nothing replaced it, so the counter still
       matches and the continuation happily writes into a `nodes`
       that unmount() emptied. That throws, and a throw inside a
       .then() is an unhandled rejection nobody sees.

       Two rules, and they are both easy to get wrong:
         - CAPTURE the guard in a local when the async work starts.
           Reading the module-scope variable inside the continuation
           reads whichever mount is current, which is always valid,
           which means the check passes exactly when it should fail.
         - RELEASE it in unmount(). */
    alive.end = function () { if (mountGen[id] === mine) mountGen[id] = mine + 1; };
    return alive;
  }

  var FieldKit = {
    VERSION: VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    deviceId: null,          // set by store on init
    register: register,
    markFailed: markFailed,
    modules: function () { return modules; },
    module: function (id) { return modules[id]; },
    failedModules: function () { return failed; },
    provide: provide,
    mountGuard: mountGuard,
    need: need,
    service: function (n) { return services[n]; },
    context: context,
    on: on,
    emit: emit,
    log: log,
    logs: function () { return logBuf.slice(); },
    loadScript: loadScript,
    loadAll: loadAll
  };

  global.FieldKit = FieldKit;
  log("info", "kernel", "FieldKit kernel " + VERSION + " online");
})(window);
