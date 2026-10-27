/* ============================================================
   FieldKit :: ai-tier2-local
   Tier 2 of the AI router (§9): a model that runs in this browser,
   with no relay and no network.

   THE CONSTRAINT CHAIN, BECAUSE IT EXPLAINS EVERY DESIGN CHOICE

   Every in-browser inference library loads weights by fetching
   them. On file:// that is impossible — fetch() and XHR are both
   blocked against file URLs (§2C), so a 2 GB model sitting on the
   drive next to FIELDKIT.html cannot be read by FIELDKIT.html.
   That is the whole problem. It is not about disk space; the
   deploy payload is under 2 MB of a 15.9 GB stick.

   There is exactly one route in that the browser permits: the
   user picks the folder by hand, through <input webkitdirectory>.
   That yields File objects, which ARE readable. So:

     1. The user picks the model directory once per session.
     2. We index it into a virtual filesystem: path -> File.
     3. We install a fetch shim that answers a sentinel origin
        from that index, and delegates everything else to the real
        fetch untouched — the relay must keep working.
     4. The engine is pointed at the sentinel origin and never
        knows the difference.

   WHY THE PICK CANNOT BE REMEMBERED

   The File System Access API would let us keep a directory handle
   and re-open it silently. It does not exist on file:// either.
   So the folder pick genuinely has to happen every session. We
   remember the *index* — names, sizes, which model it was — so
   the UI can say "this is the folder you used last time" instead
   of making you rediscover it. The bytes are not cached; the
   engine's own cache handles that, inside the browser's ~10 GB
   quota, which is its own ceiling.

   WHY THE ENGINE IS NOT BUNDLED

   WebLLM ships as an ES module, and <script type="module"> is
   CORS-blocked on file:// — the same wall that made FieldKit use
   classic scripts everywhere (§1). A classic-script build of it
   has to be produced ahead of time on a machine with npm. That is
   what tools/build-webllm.js does; it writes vendor/web-llm.js,
   which the boot manifest loads if present and skips if not.

   So this file is the host, not the engine. It works with no
   engine present — reports honestly, stays out of the router's
   way — and lights up when one appears.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  /* Any absolute origin the browser will accept in a URL and that
     nothing else will ever legitimately request. It is never
     resolved by the network: the shim answers it before fetch
     gets near a socket. */
  var SENTINEL = "https://model.fieldkit.invalid/";

  var vfs = null;            // Map: relative path -> File
  var vfsLabel = "";         // the folder name the user picked
  var engine = null;         // the live engine, once loaded
  var engineAdapter = null;  // which adapter produced it
  var loading = false;
  var loadState = { phase: "idle", detail: "", progress: 0 };
  var nativeFetch = null;    // saved before shimming, restored on unload
  var lastError = null;

  function emit() {
    FieldKit.emit("ai2:state", {
      phase: loadState.phase, detail: loadState.detail,
      progress: loadState.progress, ready: !!engine
    });
  }

  function setPhase(phase, detail, progress) {
    loadState = {
      phase: phase,
      detail: detail || "",
      progress: typeof progress === "number" ? progress : loadState.progress
    };
    emit();
  }

  /* ---- the virtual filesystem ---------------------------------
     webkitRelativePath is "<pickedFolder>/a/b/c.bin". The first
     segment is the folder the user chose, which is noise — the
     engine wants paths relative to the model root. Strip it, but
     keep both forms addressable, because a model directory picked
     one level up should still resolve. */
  function indexFiles(fileList) {
    var map = new Map();
    var label = "";
    var list = Array.prototype.slice.call(fileList || []);
    if (!list.length) throw new Error("no files in that folder");

    list.forEach(function (f) {
      var rel = f.webkitRelativePath || f.name;
      var parts = rel.split("/");
      if (!label && parts.length > 1) label = parts[0];
      map.set(rel, f);                                  // full form
      if (parts.length > 1) map.set(parts.slice(1).join("/"), f);  // root-relative
      map.set(f.name, f);                               // bare name, last resort
    });

    return { map: map, label: label || list[0].name, count: list.length,
             bytes: list.reduce(function (n, f) { return n + f.size; }, 0) };
  }

  /* ---- the fetch shim -----------------------------------------
     The single most dangerous function here, because it replaces a
     global that the relay transport depends on. Two rules, and the
     order matters:

       1. Anything that is not our sentinel goes to the ORIGINAL
          fetch, with the original arguments, untouched. If this
          rule ever breaks, the relay silently stops working and
          the vault appears to go offline — a spectacularly
          confusing failure to debug.
       2. The shim is removable. install() saves the native, and
          uninstall() puts it back, so unloading a model returns
          the page to exactly the state it was in. */
  function canServe() {
    return typeof window.fetch === "function" && typeof window.Response === "function";
  }

  function installShim() {
    if (nativeFetch) return;             // already installed
    if (typeof window.fetch !== "function") {
      throw new Error("this browser has no fetch to shim");
    }
    /* Response comes with fetch in every real browser, so this is
       really a guard against test environments. Checked anyway,
       because failing here names the problem, while failing later
       surfaces as an unreadable error from inside the engine. */
    if (typeof window.Response !== "function") {
      throw new Error("this environment has fetch but no Response constructor, " +
        "so the model shim cannot answer requests");
    }
    nativeFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
      var url = "";
      try {
        url = typeof input === "string" ? input
            : (input && typeof input.url === "string" ? input.url : String(input));
      } catch (e) { url = ""; }

      if (url.indexOf(SENTINEL) !== 0) return nativeFetch(input, init);
      return serve(url);
    };
    FieldKit.log("info", "ai2", "model fetch shim installed");
  }

  function uninstallShim() {
    if (!nativeFetch) return;
    window.fetch = nativeFetch;
    nativeFetch = null;
    FieldKit.log("info", "ai2", "model fetch shim removed");
  }

  /* Answers from the index. Returns a real Response so the caller
     cannot tell it apart from a network one — including a proper
     404 for a miss, because an engine that gets a rejected promise
     instead of a 404 reports it as a network error and sends
     whoever is debugging in the wrong direction. */
  function serve(url) {
    var rel = "";
    try {
      rel = decodeURIComponent(url.slice(SENTINEL.length).split("?")[0].split("#")[0]);
    } catch (e) { rel = url.slice(SENTINEL.length); }

    if (!vfs) {
      return Promise.resolve(new Response(
        JSON.stringify({ error: "no model folder is loaded" }),
        { status: 503, headers: { "Content-Type": "application/json" } }));
    }

    var f = vfs.get(rel);
    if (!f) {
      /* Try the bare filename — engines vary on whether they build
         nested paths or flat ones. */
      var base = rel.split("/").pop();
      f = vfs.get(base);
    }
    if (!f) {
      return Promise.resolve(new Response(
        JSON.stringify({ error: "not in the picked folder", path: rel }),
        { status: 404, headers: { "Content-Type": "application/json" } }));
    }

    var type = f.type || guessType(rel);
    return Promise.resolve(new Response(f, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(f.size)
      }
    }));
  }

  function guessType(p) {
    if (/\.json$/i.test(p)) return "application/json";
    if (/\.wasm$/i.test(p)) return "application/wasm";
    if (/\.(bin|params|safetensors)$/i.test(p)) return "application/octet-stream";
    return "application/octet-stream";
  }

  /* ---- what a model folder should contain ---------------------
     Validated before anything heavy happens, because the failure
     mode otherwise is a long load that dies deep inside the engine
     with a message about a missing key in an object. Checking up
     front means the error names the file. */
  var MLC_REQUIRED = ["mlc-chat-config.json", "ndarray-cache.json"];
  var MLC_OPTIONAL = ["tokenizer.json", "tokenizer.model", "tokenizer_config.json"];

  function inspect() {
    if (!vfs) return { ok: false, reason: "no folder picked" };

    var names = [];
    vfs.forEach(function (f, k) { if (k.indexOf("/") < 0) names.push(k); });

    var have = function (n) { return vfs.has(n); };
    var missing = MLC_REQUIRED.filter(function (n) { return !have(n); });
    var shards = [];
    vfs.forEach(function (f, k) {
      if (/params_shard_\d+\.bin$/.test(k) && k.indexOf("/") < 0) shards.push(k);
    });
    var wasm = [];
    vfs.forEach(function (f, k) { if (/\.wasm$/i.test(k) && k.indexOf("/") < 0) wasm.push(k); });

    var tokenizer = MLC_OPTIONAL.filter(have);

    return {
      ok: !missing.length && shards.length > 0,
      missing: missing,
      shards: shards.length,
      wasm: wasm,
      tokenizer: tokenizer,
      label: vfsLabel,
      files: names.length,
      /* The engine needs a model_lib wasm. If it is not in the
         folder, WebLLM's default is to fetch it from the internet
         — which defeats the entire point of an offline tier and
         will fail on the school network anyway. Say so. */
      needsWasm: wasm.length === 0
    };
  }

  /* ---- engine adapters ----------------------------------------
     An adapter is: can I see my library, and can I build an engine
     pointed at the sentinel origin. Registered rather than
     hardcoded so transformers.js can be added without touching
     the router, and so a build of WebLLM under a different global
     name still works. */
  var adapters = [];

  function registerAdapter(a) {
    if (!a || !a.id || typeof a.detect !== "function" || typeof a.create !== "function") {
      throw new Error("an engine adapter needs id, detect() and create()");
    }
    adapters.push(a);
    FieldKit.log("info", "ai2", "engine adapter registered: " + a.id);
  }

  function detectAdapters() {
    return adapters.map(function (a) {
      var present = false, why = "";
      try { present = !!a.detect(); }
      catch (e) { present = false; why = e.message; }
      return { id: a.id, label: a.label || a.id, present: present, why: why, note: a.note || "" };
    });
  }

  /* The built-in one. Looks for a classic-script build of WebLLM
     under any of the globals its bundles commonly use. */
  registerAdapter({
    id: "webllm",
    label: "WebLLM (MLC)",
    note: "Needs vendor/web-llm.js — build it with tools/build-webllm.js on a machine with npm.",
    detect: function () {
      var g = window.webllm || window.WebLLM || window.mlc;
      return !!(g && (g.CreateMLCEngine || g.MLCEngine));
    },
    create: async function (opts) {
      var g = window.webllm || window.WebLLM || window.mlc;
      var info = inspect();
      if (!info.ok) throw new Error("folder is not a usable MLC model: " + (info.missing.join(", ") || "no shards"));

      var modelId = opts.modelId || vfsLabel || "local-model";
      var appConfig = {
        /* IndexedDB rather than the Cache API. cache.add() runs the
           browser's own fetch, not ours, so it would go straight
           past the shim and try the network. The IndexedDB path
           goes through window.fetch, which is the one we control. */
        useIndexedDBCache: true,
        model_list: [{
          model: SENTINEL.replace(/\/$/, ""),
          model_id: modelId,
          model_lib: info.wasm.length ? SENTINEL + info.wasm[0] : undefined
        }]
      };

      var create = g.CreateMLCEngine || g.CreateWebWorkerMLCEngine;
      /* Main thread on purpose. A Worker created from a file:// URL
         is blocked as cross-origin, and the blob-URL workaround
         cannot see the shim we installed on this window. The cost
         is that generation blocks the UI, which the panel says. */
      return await create(modelId, {
        appConfig: appConfig,
        initProgressCallback: function (p) {
          setPhase("loading", p && p.text ? p.text : "loading model",
            p && typeof p.progress === "number" ? p.progress : loadState.progress);
        }
      });
    },
    chat: async function (eng, messages) {
      var res = await eng.chat.completions.create({ messages: messages, stream: false });
      var c = res && res.choices && res.choices[0];
      return (c && c.message && c.message.content) || "";
    },
    unload: async function (eng) {
      if (eng && typeof eng.unload === "function") await eng.unload();
    }
  });

  /* ---- lifecycle ---------------------------------------------- */
  async function pickFolder(fileList) {
    var idx = indexFiles(fileList);
    vfs = idx.map;
    vfsLabel = idx.label;
    lastError = null;
    setPhase("picked", idx.count + " files, " + fmtBytes(idx.bytes) + " in " + idx.label, 0);
    /* Remember what was picked, not the bytes. Purely so the panel
       can say "same folder as last time" — there is no way to
       re-open it without the user. */
    try {
      var s = FieldKit.service("settings");
      if (s) s.set("aiLocalLastFolder", { label: idx.label, files: idx.count, bytes: idx.bytes });
    } catch (e) { /* remembering is a convenience, never a blocker */ }
    return inspect();
  }

  async function load(opts) {
    opts = opts || {};
    if (loading) throw new Error("already loading");
    if (!vfs) throw new Error("pick the model folder first");

    var usable = detectAdapters().filter(function (a) { return a.present; });
    if (!usable.length) {
      throw new Error("no inference engine is present. vendor/web-llm.js is missing — " +
        "build it with tools/build-webllm.js on a machine with npm, then re-deploy the drive.");
    }

    var chosen = adapters.filter(function (a) {
      return a.id === (opts.adapter || usable[0].id);
    })[0];
    if (!chosen) throw new Error("no such adapter: " + opts.adapter);

    loading = true;
    lastError = null;
    setPhase("loading", "starting " + chosen.id, 0);
    try {
      installShim();
      engine = await chosen.create(opts);
      engineAdapter = chosen;
      setPhase("ready", chosen.label + " loaded", 1);
      FieldKit.emit("ai2:ready", { adapter: chosen.id });
      return true;
    } catch (e) {
      lastError = e.message;
      /* Take the shim back down on failure. Leaving a global fetch
         override installed after an aborted load is exactly the
         kind of thing that breaks the relay an hour later and
         looks unrelated. */
      uninstallShim();
      engine = null;
      engineAdapter = null;
      setPhase("failed", e.message, 0);
      throw e;
    } finally {
      loading = false;
    }
  }

  async function unload() {
    if (engine && engineAdapter && engineAdapter.unload) {
      try { await engineAdapter.unload(engine); }
      catch (e) { FieldKit.log("warn", "ai2", "engine unload complained: " + e.message); }
    }
    engine = null;
    engineAdapter = null;
    uninstallShim();
    setPhase("idle", "unloaded", 0);
  }

  function forget() {
    vfs = null;
    vfsLabel = "";
    setPhase("idle", "folder forgotten", 0);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  /* ---- storage headroom ---------------------------------------
     The second, independent ceiling. Even with the folder picked,
     the engine caches weights in browser storage, and the school
     Chromebook reported ~10 GB total for everything (§2C). Better
     to say so before a 40-minute load fails at 90%. */
  async function headroom() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) {
        return { known: false };
      }
      var est = await navigator.storage.estimate();
      return {
        known: true,
        quota: est.quota || 0,
        usage: est.usage || 0,
        free: Math.max(0, (est.quota || 0) - (est.usage || 0))
      };
    } catch (e) { return { known: false, error: e.message }; }
  }

  /* ---- the tier-2 contract the router expects ------------------
     Exactly two methods, matching what ai-router.js calls. Kept
     deliberately narrow: the router must never need to know that
     any of the above exists. */
  FieldKit.provide("aiTier2", {
    available: function () { return !!engine; },
    chat: async function (messages) {
      if (!engine || !engineAdapter) throw new Error("no local model is loaded");
      var content = await engineAdapter.chat(engine, messages);
      if (!content) throw new Error("the local model returned nothing");
      return { content: content };
    }
  });

  /* The control surface, used by modules/ai-local.js. Separate
     from the router contract on purpose — the router should not be
     able to pick folders. */
  FieldKit.provide("aiLocal", {
    SENTINEL: SENTINEL,
    pickFolder: pickFolder,
    inspect: inspect,
    load: load,
    unload: unload,
    forget: forget,
    headroom: headroom,
    registerAdapter: registerAdapter,
    detectAdapters: detectAdapters,
    fmtBytes: fmtBytes,
    state: function () {
      return {
        phase: loadState.phase, detail: loadState.detail, progress: loadState.progress,
        ready: !!engine, loading: loading, folder: vfsLabel,
        hasFolder: !!vfs, adapter: engineAdapter ? engineAdapter.id : null,
        error: lastError, shimmed: !!nativeFetch
      };
    },
    /* Exposed so the panel and the self-test can prove the shim
       works without an engine present. This is the part that is
       genuinely verifiable today, and it is the part most likely
       to be wrong. */
    _serve: serve,
    _canServe: canServe,
    _shimActive: function () { return !!nativeFetch; },
    _install: installShim,
    _uninstall: uninstallShim,
    _setVfsForTest: function (map, label) { vfs = map; vfsLabel = label || "test"; }
  });
})(window.FieldKit);
