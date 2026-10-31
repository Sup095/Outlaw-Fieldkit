/* ============================================================
   FieldKit :: ai-install
   Tiny models for the browser, installed with a button.

   Tier 2 could always run a model, but getting one meant fetching a
   folder by hand and picking it again every session (MODELS.md). This
   does the downloading: the engine from your relay, the model from
   Hugging Face, both into this browser's own storage, so USE needs no
   folder and no network afterwards. It works in both builds.

   The list of what can be installed is the engine's own, cut down to
   what fits a small machine, so a rebuilt engine brings its models
   with it and no URL here can go stale.

   IndexedDB rather than the Cache API because a file:// page has no
   Cache API. The engine is code, so it is hashed against ENGINE_SHA256
   before it runs (a test keeps that equal to vendor/web-llm.js). The
   weights are data and the model library is WebAssembly, which can
   reach only what the engine hands it.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ENGINE_SHA256 = "3ac982ef28477c5008c10350a2b7c76d154c4f6ebbfa65c27145d528f1beb902";
  var DB = "fieldkit.models.v1";
  var MAX_MB = 1000;              // vram_required_MB: the small-machine end
  var HF = "https://huggingface.co/";
  var SKIP = /(^|\/)(\.gitattributes|README\.md)$/;

  function relayBase() {
    var s = FieldKit.service("settings");
    return s ? String(s.get("relayUrl") || "").replace(/\/+$/, "") : "";
  }

  function db() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error("this browser has no storage for models"));
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        r.result.createObjectStore("files");
        r.result.createObjectStore("models", { keyPath: "id" });
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error("could not open model storage")); };
    });
  }

  async function tx(store, mode, fn) {
    var d = await db();
    return new Promise(function (resolve, reject) {
      var t = d.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = function () { d.close(); resolve(req && req.result); };
      t.onerror = t.onabort = function () {
        d.close();
        reject(t.error && t.error.name === "QuotaExceededError"
          ? new Error("not enough room in this browser for that model") : t.error || new Error("storage failed"));
      };
    });
  }

  async function sha256(buf) {
    var h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return Array.prototype.map.call(h, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function engineGlobal() { return window.webllm || window.WebLLM || window.mlc || null; }

  function runEngine(text) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
      var s = document.createElement("script");
      s.src = url;
      s.onload = function () { URL.revokeObjectURL(url); engineGlobal() ? resolve() : reject(new Error("the engine loaded but offers nothing")); };
      s.onerror = function () { URL.revokeObjectURL(url); reject(new Error("the engine would not start in this browser")); };
      document.head.appendChild(s);
    });
  }

  /* From this browser if it was fetched before, otherwise the relay.
     Hashed either way: storage can be edited as easily as a relay. */
  async function ensureEngine() {
    if (engineGlobal()) return;
    var buf = await tx("files", "readonly", function (st) { return st.get("engine"); });
    if (!buf) {
      var base = relayBase();
      if (!base) throw new Error("add a relay in RELAY LINK first: the engine comes from there");
      var res = await fetch(base + "/ai/engine.js", { cache: "no-store" });
      if (!res.ok) throw new Error("the relay does not have the engine (" + res.status + ")");
      buf = await res.arrayBuffer();
    }
    if (await sha256(buf) !== ENGINE_SHA256) throw new Error("the engine does not match this copy of FieldKit: update FieldKit or the relay");
    await tx("files", "readwrite", function (st) { return st.put(buf, "engine"); });
    await runEngine(new TextDecoder().decode(buf));
  }

  /* What the engine knows how to run, smallest first. Embedding models
     cannot chat, so they are left out. */
  async function catalogue() {
    await ensureEngine();
    var g = engineGlobal();
    var cfg = g.prebuiltAppConfig || (g.default && g.default.prebuiltAppConfig);
    var list = (cfg && cfg.model_list) || [];
    return list.filter(function (m) { return m.vram_required_MB && m.vram_required_MB <= MAX_MB && !/embed/i.test(m.model_id); })
      .sort(function (a, b) { return a.vram_required_MB - b.vram_required_MB; })
      .map(function (m) { return { id: m.model_id, url: m.model, lib: m.model_lib, mb: Math.round(m.vram_required_MB) }; });
  }

  function installed() { return tx("models", "readonly", function (st) { return st.getAll(); }); }

  async function install(model, onProgress) {
    var repo = String(model.url).replace(HF, "").replace(/\/?(resolve\/main\/?)?$/, "");
    var res = await fetch(HF + "api/models/" + repo, { cache: "no-store" });
    if (!res.ok) throw new Error("Hugging Face would not list that model (" + res.status + ")");
    var names = ((await res.json()).siblings || []).map(function (s) { return s.rfilename; })
      .filter(function (n) { return !SKIP.test(n); });
    var files = names.map(function (n) { return { name: n, url: HF + repo + "/resolve/main/" + n }; });
    files.push({ name: "model.wasm", url: model.lib });

    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
    var size = 0;
    for (var i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i / files.length, files[i].name);
      var r = await fetch(files[i].url);
      if (!r.ok) throw new Error("could not fetch " + files[i].name + " (" + r.status + "): a network may be blocking it");
      var blob = await r.blob();
      size += blob.size;
      await putFile(model.id + "/" + files[i].name, blob);
    }
    /* Written last: a model that is listed is a model that is whole. */
    await tx("models", "readwrite", function (st) {
      return st.put({ id: model.id, bytes: size, files: files.map(function (f) { return f.name; }), at: Date.now() });
    });
    if (onProgress) onProgress(1, "");
  }

  function putFile(key, blob) { return tx("files", "readwrite", function (st) { return st.put(blob, key); }); }
  function getFile(key) { return tx("files", "readonly", function (st) { return st.get(key); }); }

  async function remove(id) {
    var rec = (await installed()).find(function (m) { return m.id === id; });
    if (!rec) return;
    await tx("models", "readwrite", function (st) { return st.delete(id); });
    await tx("files", "readwrite", function (st) {
      rec.files.forEach(function (n) { st.delete(id + "/" + n); });
      return null;
    });
  }

  /* An installed model, as the files tier 2 serves to the engine. */
  async function use(id) {
    var rec = (await installed()).find(function (m) { return m.id === id; });
    if (!rec) throw new Error("that model is not installed");
    await ensureEngine();
    var ai2 = FieldKit.need("aiLocal"), map = new Map();
    for (var i = 0; i < rec.files.length; i++) {
      var blob = await getFile(id + "/" + rec.files[i]);
      if (!blob) throw new Error("part of that model is missing: install it again");
      var f = new File([blob], rec.files[i].split("/").pop());
      map.set(rec.files[i], f);
      map.set(f.name, f);
    }
    if (ai2.state().ready) await ai2.unload();
    ai2.useFiles(map, id);
    await ai2.load({ modelId: id });
  }

  FieldKit.provide("aiInstall", {
    ENGINE_SHA256: ENGINE_SHA256,
    gpu: function () { return !!(navigator.gpu && navigator.gpu.requestAdapter); },
    catalogue: catalogue, installed: installed, install: install, remove: remove, use: use
  });
})(window.FieldKit);
