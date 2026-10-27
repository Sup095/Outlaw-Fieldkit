/* ============================================================
   FieldKit :: ai-local
   The panel over core/ai-tier2-local.js — an in-browser model as
   tier 2 of the AI router (§9, §11).

   The design brief for this screen is unusual: most of its value
   is in explaining why it is awkward. Someone who opens it
   expecting "download a model, press go" needs to understand the
   file:// constraint before they spend an hour on it, and needs
   to be able to tell which of the four independent things went
   wrong when it does not work.

   So the layout is diagnostic-first: what is present, what is
   missing, what to do about each. The buttons come after.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, ai2, nodes = {}, offs = [], inspectCache = null;

  function state() { return ai2.state(); }

  /* ---- the four gates -----------------------------------------
     Rendered as a checklist because they are genuinely
     independent: an engine with no model, a model with no engine,
     and both with no GPU all fail differently and are fixed
     differently. A single "not working" message would be useless. */
  async function renderGates() {
    ui.clear(nodes.gates);
    var s = state();
    var engines = ai2.detectAdapters();
    var anyEngine = engines.some(function (e) { return e.present; });
    var info = s.hasFolder ? ai2.inspect() : null;
    var head = await ai2.headroom();

    var gpu = !!(navigator.gpu && typeof navigator.gpu.requestAdapter === "function");

    var gates = [
      { ok: gpu, title: "WEBGPU",
        good: "Available. The hardware can run inference.",
        bad: "Not available in this browser. Chrome or Edge on a machine with a GPU. " +
             "Without it, tier 2 cannot run at all and tier 3 heuristics are the offline floor." },
      { ok: anyEngine, title: "INFERENCE ENGINE",
        good: engines.filter(function (e) { return e.present; })
                     .map(function (e) { return e.label; }).join(", ") + " is loaded.",
        bad: "No engine present. vendor/web-llm.js is missing. It cannot be downloaded from " +
             "here — a file:// page cannot load an ES module, so the library has to be " +
             "flattened into a classic script ahead of time. On a machine with npm, in the " +
             "FieldKit repo on the SSD, run:  node tools/build-webllm.js  then re-deploy." },
      { ok: !!(info && info.ok), title: "MODEL FOLDER",
        good: info ? (info.label + " — " + info.shards + " shards, " +
                      (info.tokenizer.length ? "tokenizer present" : "no tokenizer found")) : "",
        bad: !s.hasFolder
          ? "No folder picked. Weights cannot be read off the drive automatically — fetch() is " +
            "blocked on file://, so the browser will only give us files you choose by hand. " +
            "Press CHOOSE MODEL FOLDER below. This has to be done once per session; there is " +
            "no API on file:// that can remember a directory."
          : ("Picked folder is not a usable MLC model" +
             (info && info.missing.length ? " — missing " + info.missing.join(", ") : "") +
             (info && !info.shards ? " — no params_shard_*.bin files found" : "") +
             ". Expect a folder containing mlc-chat-config.json, ndarray-cache.json and " +
             "numbered shard files.") },
      { ok: !(info && info.needsWasm), title: "MODEL LIBRARY (.wasm)", soft: true,
        good: info && info.wasm && info.wasm.length ? info.wasm[0] : "",
        bad: "No .wasm in the folder. WebLLM would try to fetch its compiled model library " +
             "from the internet, which defeats the point of an offline tier and will fail on " +
             "a restricted network anyway. Download the matching -webgpu.wasm and put it in " +
             "the same folder." },
      { ok: !head.known || head.free > 2 * 1024 * 1024 * 1024, title: "STORAGE HEADROOM", soft: true,
        good: head.known
          ? ai2.fmtBytes(head.free) + " free of " + ai2.fmtBytes(head.quota)
          : "Cannot be measured on this platform.",
        bad: head.known
          ? ("Only " + ai2.fmtBytes(head.free) + " free of " + ai2.fmtBytes(head.quota) +
             ". The engine caches weights in browser storage, and this is a separate ceiling " +
             "from the drive — the Chromebook reported about 10 GB for everything.")
          : "" }
    ];

    gates.forEach(function (g) {
      var cls = g.ok ? "ok" : (g.soft ? "warn" : "bad");
      nodes.gates.appendChild(el("div", { class: "al-gate " + cls }, [
        el("div", { class: "al-gate-head" }, [
          el("span", { class: "al-gate-mark", text: g.ok ? "✓" : (g.soft ? "!" : "✕") }),
          el("strong", { text: g.title })
        ]),
        el("div", { class: "al-gate-body", text: g.ok ? g.good : g.bad })
      ]));
    });

    nodes.loadBtn.disabled = !(gpu && anyEngine && info && info.ok) || s.loading || s.ready;
    nodes.unloadBtn.disabled = !s.ready;
  }

  function renderStatus() {
    var s = state();
    ui.clear(nodes.status);
    nodes.status.appendChild(ui.readout([
      { label: "TIER 2", value: s.ready ? "READY" : (s.loading ? "LOADING" : "NOT LOADED"),
        level: s.ready ? "ok" : (s.loading ? "warn" : "dim") },
      { label: "ENGINE", value: s.adapter || "—", level: s.adapter ? "ok" : "dim" },
      { label: "FOLDER", value: s.folder || "—", level: s.folder ? "ok" : "dim" },
      { label: "FETCH SHIM", value: s.shimmed ? "INSTALLED" : "OFF",
        level: s.shimmed ? "warn" : "dim" }
    ]));
    if (s.phase === "loading" || s.phase === "failed") {
      nodes.status.appendChild(el("div", {
        class: "al-phase " + (s.phase === "failed" ? "bad" : ""),
        text: s.detail
      }));
    }
    if (s.error) {
      nodes.status.appendChild(el("div", { class: "al-phase bad", text: "LAST ERROR: " + s.error }));
    }
  }

  async function refresh() {
    renderStatus();
    await renderGates();
  }

  /* ---- actions -------------------------------------------------- */
  async function onFolderPicked(fileList) {
    try {
      inspectCache = await ai2.pickFolder(fileList);
      ui.toast("FOLDER INDEXED", "ok");
    } catch (e) {
      ui.toast("COULD NOT READ THAT FOLDER", "fail");
      ctx.warn(e.message);
    }
    await refresh();
  }

  async function doLoad() {
    try {
      nodes.loadBtn.disabled = true;
      await ai2.load({});
      ui.toast("LOCAL MODEL READY — TIER 2 IS LIVE", "ok");
    } catch (e) {
      ui.textDump(e.message, { title: "MODEL LOAD FAILED" });
    }
    await refresh();
  }

  async function doUnload() {
    await ai2.unload();
    ui.toast("MODEL UNLOADED, FETCH RESTORED", "ok");
    await refresh();
  }

  async function doTest() {
    var s = state();
    if (!s.ready) { ui.toast("NO MODEL LOADED", "warn"); return; }
    nodes.testOut.textContent = "thinking… (generation runs on the main thread, so the " +
      "interface will be unresponsive until it finishes)";
    try {
      var t0 = performance.now();
      var r = await FieldKit.need("ai").chat([
        { role: "user", content: nodes.testIn.value || "Say hello in one short sentence." }
      ], { forceTier: 2 });
      nodes.testOut.textContent = "[tier " + r.tier + ", " +
        Math.round(performance.now() - t0) + " ms]\n\n" + r.content;
    } catch (e) {
      nodes.testOut.textContent = "FAILED: " + e.message;
    }
  }

  function injectCSS() {
    if (document.getElementById("al-style")) return;
    var s = document.createElement("style");
    s.id = "al-style";
    s.textContent = [
      ".al-wrap{display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;padding:2px}",
      ".al-lead{font-size:12px;line-height:1.6;opacity:.85;border-left:3px solid var(--fk-accent);padding:7px 10px}",
      ".al-gate{border:1px solid var(--fk-line);border-left-width:3px;padding:7px 10px;margin-bottom:5px}",
      ".al-gate.ok{border-left-color:var(--fk-ok)}",
      ".al-gate.warn{border-left-color:var(--fk-warn)}",
      ".al-gate.bad{border-left-color:var(--fk-fail)}",
      ".al-gate-head{display:flex;gap:8px;align-items:center;letter-spacing:.06em;font-size:12px}",
      ".al-gate-mark{width:14px;text-align:center;opacity:.9}",
      ".al-gate-body{font-size:11.5px;line-height:1.55;opacity:.8;margin-top:4px}",
      ".al-phase{font-size:11.5px;opacity:.8;margin-top:6px;white-space:pre-wrap}",
      ".al-phase.bad{color:var(--fk-fail);opacity:1}",
      ".al-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center}",
      ".al-out{font-size:12px;line-height:1.55;white-space:pre-wrap;background:rgba(255,255,255,0.04);padding:8px;min-height:60px;margin-top:6px}",
      ".al-why{font-size:11.5px;line-height:1.6;opacity:.75;white-space:pre-wrap}",
      ".al-why b{opacity:1}"
    ].join("");
    document.head.appendChild(s);
  }

  var WHY = [
    "WHY THIS IS AWKWARD, IN ONE PLACE",
    "",
    "FieldKit runs from a file:// page so it needs no install and no server. That buys a lot " +
    "and costs exactly one thing that matters here: fetch() does not work against file URLs. " +
    "A model folder sitting next to FIELDKIT.html on the same drive is unreadable to the page.",
    "",
    "The browser's only sanctioned way in is a file picker. So you pick the folder, we index " +
    "the File objects it hands back, and a shim answers the engine's requests from that index " +
    "instead of the network. Everything that is not a model request goes to the real fetch " +
    "untouched, which is what keeps the relay working while a model is loaded.",
    "",
    "The pick cannot be remembered. The File System Access API — the one that keeps a " +
    "directory handle across sessions — is also unavailable on file://. So this is once per " +
    "session, every session, permanently. That is not a bug and there is no workaround.",
    "",
    "The engine itself has the same problem one level up: WebLLM is an ES module, and " +
    "<script type=\"module\"> is CORS-blocked on file:// too. It has to be flattened into a " +
    "classic script on a machine with npm before it can be loaded here.",
    "",
    "IS IT WORTH IT",
    "",
    "Probably only if the relay proves unreliable. Tier 1 through the relay is faster, better " +
    "and needs none of this. Tier 3 heuristics already cover the offline case for tagging and " +
    "summarising without any model at all. Tier 2 is the middle ground: real generation with " +
    "no network, at the cost of a folder pick and a slow load. Worth having available. " +
    "Not worth depending on."
  ].join("\n");

  function selfcheck(api) {
    return [
      { name: "THE SHIM ONLY ANSWERS ITS OWN URLS", critical: true, run: async function () {
        /* The load-bearing safety property. If this ever fails, the
           relay transport quietly stops working while a model is
           loaded, and the vault appears to go offline for reasons
           nobody would connect to the AI panel. */
        if (!ai2._canServe()) {
          throw new Error("SKIPPED — the shim refuses to install without a Response " +
            "constructor, which jsdom does not provide");
        }
        var before = window.fetch;
        var called = null;
        window.fetch = function (u) { called = String(u); return Promise.resolve("passthrough"); };
        try {
          ai2._install();
          var r = await window.fetch("https://relay.example.invalid/health");
          if (r !== "passthrough") throw new Error("a non-model URL did not reach the real fetch");
          if (called !== "https://relay.example.invalid/health") {
            throw new Error("the original fetch got the wrong URL: " + called);
          }
        } finally {
          ai2._uninstall();
          window.fetch = before;
        }
        return "non-model requests pass through unchanged";
      } },

      { name: "THE SHIM SERVES PICKED FILES", critical: true, run: async function () {
        if (!ai2._canServe()) {
          throw new Error("SKIPPED — no Response constructor in this environment " +
            "(jsdom); the shim needs a real browser to build responses");
        }
        var body = '{"probe":true}';
        var map = new Map();
        map.set("mlc-chat-config.json", new File([body], "mlc-chat-config.json",
          { type: "application/json" }));
        ai2._setVfsForTest(map, "probe-model");
        try {
          var res = await ai2._serve(ai2.SENTINEL + "mlc-chat-config.json");
          if (res.status !== 200) throw new Error("served " + res.status + " for a present file");
          var got = await res.json();
          if (!got.probe) throw new Error("body did not survive: " + JSON.stringify(got));

          var miss = await ai2._serve(ai2.SENTINEL + "not-there.bin");
          if (miss.status !== 404) {
            throw new Error("a missing file returned " + miss.status + ", not 404");
          }
        } finally {
          ai2.forget();
        }
        return "200 with the real bytes, 404 for a miss";
      } },

      { name: "THE SHIM IS REMOVED WHEN NOTHING IS LOADED", critical: true, run: async function () {
        /* A leftover global fetch override is the worst failure this
           module can cause, because the symptom appears somewhere
           else entirely. Nothing should be installed at rest. */
        if (ai2._shimActive() && !ai2.state().ready) {
          throw new Error("the fetch shim is installed but no model is loaded");
        }
        return "clean at rest";
      } },

      { name: "IT REPORTS MISSING PIECES INSTEAD OF FAILING VAGUELY", critical: false, run: async function () {
        var map = new Map();
        map.set("readme.txt", new File(["nope"], "readme.txt"));
        ai2._setVfsForTest(map, "not-a-model");
        try {
          var info = ai2.inspect();
          if (info.ok) throw new Error("a folder with no model files was called usable");
          if (!info.missing.length) throw new Error("nothing was named as missing");
          if (info.missing.indexOf("mlc-chat-config.json") < 0) {
            throw new Error("did not name the config file: " + info.missing.join(","));
          }
        } finally { ai2.forget(); }
        return "names the specific files that are absent";
      } },

      { name: "TIER 2 STAYS OUT OF THE ROUTER UNTIL IT IS REAL", critical: true, run: async function () {
        /* An empty slot that claims availability would make the
           router prefer a model that cannot answer, and every AI
           call in the app would degrade for no reason. */
        var t2 = FieldKit.service("aiTier2");
        if (!t2) throw new Error("tier 2 did not register at all");
        if (typeof t2.available !== "function") throw new Error("no available()");
        if (!ai2.state().ready && t2.available()) {
          throw new Error("tier 2 reports available with no engine loaded");
        }
        var avail = await FieldKit.need("ai").availability();
        if (!ai2.state().ready && avail[2].available) {
          throw new Error("the router thinks tier 2 is available when it is not");
        }
        return "registered, honest about being empty";
      } },

      { name: "THE PANEL EXPLAINS THE CONSTRAINT", critical: false, run: async function () {
        var txt = api.host().textContent;
        if (!/file:\/\//.test(txt)) throw new Error("the file:// constraint is not stated");
        if (!/fetch/i.test(txt)) throw new Error("the fetch limitation is not explained");
        if (!/build-webllm|npm/i.test(txt)) throw new Error("no route to getting an engine is given");
        return "states the limit and the way round it";
      } }
    ];
  }

  FieldKit.register("ai-local", {
    group: "ONLINE",
    about: "The AI model that runs inside this browser, with no server",
    keywords: "ai model llm webllm offline local tier 2",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "AI LOCAL",
    icon: "◐",
    width: 880,
    height: 660,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      ai2 = FieldKit.need("aiLocal");
      injectCSS();

      nodes.gates = el("div");
      nodes.status = el("div");

      nodes.picker = el("input", { type: "file", style: "display:none" });
      /* Not settable through el() — these are non-standard
         attributes and setAttribute is the only route. */
      nodes.picker.setAttribute("webkitdirectory", "");
      nodes.picker.setAttribute("directory", "");
      nodes.picker.setAttribute("multiple", "");
      nodes.picker.addEventListener("change", function (e) {
        onFolderPicked(e.target.files);
        e.target.value = "";
      });

      nodes.loadBtn = ui.button("LOAD MODEL", doLoad, { primary: true });
      nodes.unloadBtn = ui.button("UNLOAD", doUnload);
      nodes.testIn = el("input", { class: "fk-input",
        placeholder: "Say hello in one short sentence." });
      nodes.testOut = el("div", { class: "al-out", text: "—" });

      host.appendChild(el("div", { class: "al-wrap" }, [
        el("div", { class: "al-lead", text:
          "Tier 2 of the AI router: a model that runs here, with no relay and no network. " +
          "It is genuinely useful and genuinely awkward, and the checklist below tells you " +
          "which part is currently in the way." }),
        nodes.status,
        ui.panel("WHAT IS NEEDED", [nodes.gates]),
        ui.panel("CONTROLS", [
          el("div", { class: "al-row" }, [
            ui.button("CHOOSE MODEL FOLDER", function () { nodes.picker.click(); }, { primary: true }),
            nodes.picker,
            nodes.loadBtn,
            nodes.unloadBtn,
            ui.button("RECHECK", refresh),
            ui.button("FORGET FOLDER", function () { ai2.forget(); refresh(); })
          ]),
          el("div", { class: "al-why", text:
            "Loading a large model takes minutes and the progress line below is the only sign " +
            "it is working. Generation runs on the main thread — a Worker cannot see the fetch " +
            "shim — so the interface freezes while it answers. That is expected." })
        ]),
        ui.panel("TEST", [
          nodes.testIn,
          el("div", { class: "al-row" }, [ui.button("ASK TIER 2 DIRECTLY", doTest)]),
          nodes.testOut
        ]),
        ui.panel("WHY THIS IS LIKE THIS", [el("div", { class: "al-why", text: WHY })])
      ]));

      await refresh();
      offs.push(ctx.on("ai2:state", function () { renderStatus(); }));
    },

    unmount() {
      offs.forEach(function (f) { try { f(); } catch (e) {} });
      offs = [];
      nodes = {}; inspectCache = null;
    },

    searchIndex() {
      return [{ id: "ai-local", module: "ai-local",
        title: "AI LOCAL — in-browser model (tier 2)",
        body: "webllm offline model webgpu file:// fetch shim model folder tier 2 " + WHY }];
    }
  });
})(window.FieldKit);
