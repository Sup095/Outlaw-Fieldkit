/* ============================================================
   FieldKit :: command-palette
   Ctrl+K. Jumps to any module and searches across every module
   that implements searchIndex() (§3).

   This is also the keyboard escape hatch for the whole shell — a
   draggable fake-OS is otherwise close to unusable without a
   mouse, which matters on a Chromebook trackpad (§10F).
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ui = FieldKit.need("ui");
  var el = ui.el;

  var root, input, list, hint;
  var open = false, items = [], selected = 0;

  /* ---- index -------------------------------------------------- */
  function moduleCommands() {
    var mods = FieldKit.modules();
    return Object.keys(mods).map(function (id) {
      return {
        kind: "module", id: id, title: mods[id].title, icon: mods[id].icon,
        /* What it does, and the words people look for it by (§21). */
        sub: mods[id].about || "open module",
        haystack: (mods[id].keywords || "") + " " + (mods[id].group || ""),
        run: function () { FieldKit.need("shell").open(id); }
      };
    });
  }

  function actionCommands() {
    var shell = FieldKit.service("shell");
    var settings = FieldKit.service("settings");
    var store = FieldKit.service("store");
    var acts = [
      { title: "TOGGLE CRT MODE", icon: "▚", sub: "scanline overlay", run: function () {
          document.body.classList.toggle("crt");
          if (settings) settings.set("crt", document.body.classList.contains("crt"));
        } },
      { title: "CYCLE THEME", icon: "◐", sub: "next accent palette", run: function () {
          var ids = Object.keys(ui.THEMES);
          var next = ids[(ids.indexOf(ui.currentTheme()) + 1) % ids.length];
          ui.applyTheme(next);
          if (settings) settings.set("theme", next);
          ui.toast("PALETTE :: " + ui.THEMES[next].name, "info");
        } },
      { title: "SYNC NOW", icon: "⇅", sub: "drain the offline queue", run: async function () {
          if (!store) return;
          var r = await store.sync();
          ui.toast(r.skipped ? "SYNC SKIPPED — " + r.skipped
            : "SYNCED " + r.pushed + " op(s)" + (r.failed ? ", " + r.failed + " failed" : ""),
            r.failed ? "warn" : "ok");
        } },
      { title: "RUN COMPREHENSIVE SELF-TEST", icon: "✇", sub: "full diagnostic", run: async function () {
          var st = FieldKit.service("selftest");
          ui.toast("SELF-TEST RUNNING...", "info");
          var report = await st.runFull();
          st.log(report);
          ui.toast("SELF-TEST: " + report.passed + "/" + report.results.length + " PASS" +
            (report.failed ? ", " + report.failed + " FAIL" : ""), report.criticalFailed ? "fail" : "ok");
        } },
      { title: "CLOSE ALL WINDOWS", icon: "✕", sub: "clear the desktop", run: function () {
          if (!shell) return;
          shell.openWindows().slice().forEach(function (id) { shell.close(id); });
        } },
      { title: "LOCK SCREEN", icon: "▩", sub: "requires the PIN to return (Ctrl+L)", run: function () {
          var lock = FieldKit.service("lockscreen");
          if (!lock) return;
          lock.hasPin().then(function (yes) {
            if (yes) lock.engage({});
            else ui.toast("NO PIN SET — CONFIGURE ONE IN SETTINGS", "warn");
          });
        } },
      { title: "FULL SYSTEM EXERCISE", icon: "◎", sub: "drive every feature, then report", run: function () {
          if (shell) shell.open("selftest-panel");
          ui.toast("PRESS FULL SYSTEM EXERCISE", "info");
        } }
    ];

    /* Only offered once at least one secret has been found — listing
       it from the start would give the game away. */
    var eggs = FieldKit.service("easterEggs");
    if (eggs && eggs.unlocked()) {
      acts.push({ title: "CREDITS", icon: "✦",
        sub: eggs.foundCount() + " / " + eggs.total() + " secrets found",
        run: function () { eggs.showCredits(); } });
    }

    return acts.map(function (a) { return Object.assign({ kind: "action" }, a); });
  }

  /* Records come from whichever modules are currently mounted —
     an unmounted module has no live index, which is the honest
     answer rather than a stale one. */
  function recordCommands() {
    var out = [];
    var mods = FieldKit.modules();
    Object.keys(mods).forEach(function (id) {
      var m = mods[id];
      if (typeof m.searchIndex !== "function") return;
      var rows;
      try { rows = m.searchIndex() || []; }
      catch (e) { return; }
      rows.forEach(function (r) {
        out.push({
          kind: "record", id: r.id, title: r.title || "(untitled)",
          icon: m.icon, sub: m.title + " — " + String(r.body || "").replace(/\s+/g, " ").slice(0, 60),
          haystack: (r.title || "") + " " + (r.body || ""),
          run: function () { FieldKit.need("shell").open(id); }
        });
      });
    });
    return out;
  }

  function score(item, q) {
    if (!q) return item.kind === "module" ? 2 : (item.kind === "action" ? 1 : 0);
    var hay = ((item.title || "") + " " + (item.sub || "") + " " + (item.haystack || "")).toLowerCase();
    var title = (item.title || "").toLowerCase();
    if (title.startsWith(q)) return 100;
    if (title.indexOf(q) >= 0) return 60;
    if (hay.indexOf(q) >= 0) return 25;
    /* subsequence match, so "dvt" finds "DEV TOOLS" */
    var i = 0;
    for (var c = 0; c < title.length && i < q.length; c++) if (title[c] === q[i]) i++;
    return i === q.length ? 12 : -1;
  }

  function refresh() {
    var q = input.value.trim().toLowerCase();
    var pool = moduleCommands().concat(actionCommands()).concat(recordCommands());
    items = pool.map(function (it) { return { it: it, s: score(it, q) }; })
      .filter(function (x) { return x.s >= 0; })
      .sort(function (a, b) { return b.s - a.s || a.it.title.localeCompare(b.it.title); })
      .slice(0, 40).map(function (x) { return x.it; });
    selected = 0;
    render();
  }

  function render() {
    ui.clear(list);
    if (!items.length) {
      list.appendChild(el("div", { class: "cp-empty", text: "NO MATCHES" }));
      return;
    }
    items.forEach(function (it, i) {
      list.appendChild(el("div", {
        class: "cp-item" + (i === selected ? " sel" : ""),
        onclick: function () { selected = i; execute(); },
        onmousemove: function () { if (selected !== i) { selected = i; render(); } }
      }, [
        el("span", { class: "cp-icon", text: it.icon || "▸" }),
        el("span", { class: "cp-title", text: it.title }),
        el("span", { class: "cp-sub", text: it.sub || "" }),
        el("span", { class: "cp-kind", text: it.kind })
      ]));
    });
    var sel = list.querySelector(".cp-item.sel");
    if (sel && typeof sel.scrollIntoView === "function") sel.scrollIntoView({ block: "nearest" });
  }

  function execute() {
    var it = items[selected];
    if (!it) return;
    hide();
    var ach = FieldKit.service("achievements");
    if (ach) ach.notePaletteUse();
    /* Several commands are async — SYNC NOW, the self-test — and a
       sync try/catch cannot see a rejected promise. A failing sync
       used to vanish silently: the palette closed, nothing was said,
       and the queue was still full. Handle both shapes. */
    try {
      var r = it.run();
      if (r && typeof r.catch === "function") {
        r.catch(function (e) {
          ui.toast("COMMAND FAILED: " + (e && e.message ? e.message : String(e)), "fail");
        });
      }
    } catch (e) {
      ui.toast("COMMAND FAILED: " + e.message, "fail");
    }
  }

  /* ---- visibility --------------------------------------------- */
  /* q: words to start with, from the desktop's search bar. */
  function show(q) {
    if (open) return;
    /* Guarded here too, not only in the key handler — show() is
       exported and the shell calls it. */
    if (isLocked()) return;
    build();
    open = true;
    root.style.display = "flex";
    input.value = typeof q === "string" ? q : "";
    refresh();
    input.focus();
  }

  function hide() {
    if (!open) return;
    open = false;
    root.style.display = "none";
  }

  function build() {
    if (root) return;
    input = el("input", { class: "cp-input", type: "text", spellcheck: "false",
      placeholder: "jump to a tool, run a command, or search everything", oninput: refresh });
    list = el("div", { class: "cp-list" });
    hint = el("div", { class: "cp-hint", text: "↑↓ move    ENTER run    ESC close" });
    root = el("div", { class: "cp-root" }, [
      el("div", { class: "cp-box" }, [
        el("div", { class: "cp-bar" }, [el("span", { class: "cp-prompt", text: ">" }), input]),
        list, hint
      ])
    ]);
    root.addEventListener("mousedown", function (e) { if (e.target === root) hide(); });
    document.body.appendChild(root);
    injectCSS();
  }

  /* The lock screen only inerts #fk-desktop, and this listener is on
     window — so Ctrl+K sailed straight through it. The palette even
     rendered *under* the lock overlay (z-index 9500 vs 9600), so
     there was no visual sign anything had happened while SYNC NOW,
     CLOSE ALL WINDOWS and shell.open() all ran against the unlocked
     vault, and typing anything painted record titles and body
     previews into the DOM behind a not-quite-opaque backdrop.

     The lock exists to be a barrier against someone walking up to
     an unlocked machine. A global keyboard shortcut that ignores it
     is a hole straight through the middle. */
  function isLocked() {
    var ls = FieldKit.service("lockscreen");
    return !!(ls && ls.isLocked && ls.isLocked());
  }

  window.addEventListener("keydown", function (e) {
    if (isLocked()) {
      if (open) hide();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      open ? hide() : show();
      return;
    }
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); hide(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
    else if (e.key === "Enter") { e.preventDefault(); execute(); }
  }, true);

  function injectCSS() {
    if (document.getElementById("cp-style")) return;
    var s = document.createElement("style");
    s.id = "cp-style";
    s.textContent = `
.cp-root{position:fixed;inset:0;z-index:9500;display:none;align-items:flex-start;
  justify-content:center;padding-top:12vh;background:rgba(6,8,7,.72)}
.cp-box{width:min(660px,92vw);border:1px solid var(--accent-dim);background:var(--panel);
  box-shadow:0 24px 70px rgba(0,0,0,.8);display:flex;flex-direction:column;max-height:70vh}
.cp-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.cp-prompt{color:var(--accent);font-size:15px}
.cp-input{flex:1;background:none;border:0;outline:none;color:var(--fg);font:inherit;font-size:14px}
.cp-list{overflow:auto;flex:1}
.cp-item{display:flex;align-items:baseline;gap:9px;padding:7px 12px;cursor:pointer;
  border-bottom:1px solid #151a17}
.cp-item.sel{background:rgba(var(--accent-glow),.13);border-left:2px solid var(--accent)}
.cp-icon{color:var(--accent);width:16px;flex:none}
.cp-title{color:var(--fg);font-size:12px;letter-spacing:.1em;white-space:nowrap}
.cp-item.sel .cp-title{color:var(--accent)}
.cp-sub{flex:1;color:var(--fg-dimmer);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp-kind{color:var(--fg-dimmer);font-size:9px;letter-spacing:.14em;flex:none}
.cp-empty{padding:18px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.2em}
.cp-hint{padding:6px 12px;border-top:1px solid var(--line);color:var(--fg-dimmer);
  font-size:9px;letter-spacing:.14em}
`;
    document.head.appendChild(s);
  }

  FieldKit.provide("commandPalette", { show: show, hide: hide, refresh: refresh });
})(window.FieldKit);
