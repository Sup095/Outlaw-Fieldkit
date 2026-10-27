/* ============================================================
   FieldKit :: ui
   DOM helpers, the theme system, and the stylesheet for
   everything past the boot screen.

   Rule: nothing in FieldKit ever assigns innerHTML from data.
   el() takes text, not markup. See FIELDKIT_PROJECT.md §10F.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  /* ---- themes: all dark, accent is the only variable ---------- */
  var THEMES = {
    amber:  { name: "AMBER",  accent: "#e0a63c", accent2: "#8a6520", glow: "224,166,60" },
    green:  { name: "GREEN",  accent: "#4fbf6a", accent2: "#2c6b3c", glow: "79,191,106" },
    cyan:   { name: "CYAN",   accent: "#43b8c8", accent2: "#256670", glow: "67,184,200" },
    rust:   { name: "RUST",   accent: "#d4593c", accent2: "#7a3122", glow: "212,89,60" },
    violet: { name: "VIOLET", accent: "#9b6fd4", accent2: "#523a73", glow: "155,111,212" }
  };

  var currentTheme = "amber";

  function applyTheme(id) {
    var t = THEMES[id] || THEMES.amber;
    currentTheme = THEMES[id] ? id : "amber";
    var r = document.documentElement;
    r.style.setProperty("--accent", t.accent);
    r.style.setProperty("--accent-dim", t.accent2);
    r.style.setProperty("--accent-glow", t.glow);
    r.setAttribute("data-theme", currentTheme);
    FieldKit.emit("ui:theme", { id: currentTheme, theme: t });
    return currentTheme;
  }

  /* ---- DOM ---------------------------------------------------- */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") throw new Error("ui.el: raw html is not allowed — use 'text'");
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k.slice(0, 2) === "on" && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (k === "data" && typeof v === "object") {
          Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        }
        /* A <textarea> takes its content from a child text node, not
           from a value attribute — setAttribute("value", …) on one
           is silently ignored and the box renders empty. That is how
           DEV TOOLS' base64/hex result box shipped blank. Setting
           the property works for every form element, so route them
           all through it rather than remembering which is which. */
        else if (k === "value" && "value" in node) node.value = v;
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null || c === false) return;
        node.appendChild(typeof c === "string" || typeof c === "number"
          ? document.createTextNode(String(c)) : c);
      });
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /* ---- widgets ------------------------------------------------ */
  function button(label, onClick, opts) {
    opts = opts || {};
    return el("button", {
      class: "fk-btn" + (opts.primary ? " fk-btn-primary" : "") + (opts.danger ? " fk-btn-danger" : ""),
      type: "button", text: label, onclick: onClick, title: opts.title || null
    });
  }

  function field(labelText, opts) {
    opts = opts || {};
    var input = el("input", {
      class: "fk-input", type: opts.type || "text",
      placeholder: opts.placeholder || "", value: opts.value || "",
      autocomplete: opts.autocomplete || "off", spellcheck: "false"
    });
    var wrap = el("label", { class: "fk-field" }, [
      el("span", { class: "fk-field-label", text: labelText }), input
    ]);
    wrap.input = input;
    return wrap;
  }

  function statusDot(level, label) {
    return el("span", { class: "fk-status fk-status-" + level }, [
      el("span", { class: "fk-dot" }), el("span", { text: label })
    ]);
  }

  function panel(title, children) {
    return el("div", { class: "fk-panel" }, [
      el("div", { class: "fk-panel-title", text: title }),
      el("div", { class: "fk-panel-body" }, children)
    ]);
  }

  /* Terminal-style readout list: [{label, value, level}] */
  function readout(rows) {
    return el("div", { class: "fk-readout" }, rows.map(function (r) {
      return el("div", { class: "fk-readout-row" }, [
        el("span", { class: "fk-readout-label", text: r.label }),
        el("span", { class: "fk-readout-dots" }),
        el("span", { class: "fk-readout-value " + (r.level ? "lvl-" + r.level : ""), text: String(r.value) })
      ]);
    }));
  }

  function toast(message, level) {
    var host = document.getElementById("fk-toasts") ||
      document.body.appendChild(el("div", { id: "fk-toasts" }));
    var t = el("div", { class: "fk-toast lvl-" + (level || "info"), text: message });
    host.appendChild(t);
    setTimeout(function () {
      t.classList.add("out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, 3600);
    return t;
  }

  /* ---- getting text out of here ------------------------------- */
  /* This machine may have no terminal, no clipboard permission, and
     no downloads. Every route out has to be tried, and the last one
     has to be a plain selectable box that cannot fail — a diagnostic
     you can run but not read is worthless.

     navigator.clipboard is often *absent* rather than failing, which
     throws a TypeError before any .catch() can see it. That is why
     everything below is inside try/catch rather than promise chains. */
  function copy(text, opts) {
    opts = opts || {};
    text = String(text == null ? "" : text);

    return new Promise(function (resolve) {
      function fallback() {
        if (execCopy(text)) { resolve("execCommand"); return; }
        if (opts.silent) { resolve(null); return; }
        textDump(text, opts.title || "COPY THIS", opts.note ||
          "Clipboard access is blocked here. The text is selected — press Ctrl+C.");
        resolve(null);
      }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(function () { resolve("clipboard"); }, fallback);
          return;
        }
      } catch (e) { /* fall through */ }
      fallback();
    });
  }

  /* Selecting is a convenience, never a requirement. If it throws,
     the user can still drag-select — but only if we did not take the
     whole panel down on the way. */
  function selectAll(ta) {
    try {
      ta.focus();
      if (typeof ta.select === "function") ta.select();
      if (typeof ta.setSelectionRange === "function") ta.setSelectionRange(0, (ta.value || "").length);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* The old synchronous path. Deprecated everywhere else, and still
     the only one that works in a lot of locked-down configurations. */
  function execCopy(text) {
    var ta = null;
    try {
      ta = el("textarea", { style: {
        position: "fixed", top: "0", left: "0", width: "2px", height: "2px",
        opacity: "0", padding: "0", border: "none" } });
      ta.value = text;
      document.body.appendChild(ta);
      selectAll(ta);
      return !!document.execCommand("copy");
    } catch (e) {
      return false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  }

  /* Tries to hand the user a file, and says honestly that it cannot
     tell whether it worked — a blocked download is silent. */
  function download(text, filename, mime) {
    try {
      var blob = new Blob([text], { type: mime || "text/plain" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 6000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* The route that cannot be blocked: put the text on the screen,
     selected, and get out of the way. */
  function textDump(text, title, note) {
    var existing = document.getElementById("fk-textdump");
    if (existing) existing.parentNode.removeChild(existing);

    var ta = el("textarea", { class: "fk-input fk-dump-text", spellcheck: "false" });
    ta.value = String(text == null ? "" : text);

    function close() { if (host.parentNode) host.parentNode.removeChild(host); }

    var host = el("div", { id: "fk-textdump", class: "fk-dump" }, [
      el("div", { class: "fk-dump-box" }, [
        el("div", { class: "fk-dump-head" }, [
          el("span", { class: "fk-dump-title", text: title || "TEXT" }),
          button("CLOSE", close)
        ]),
        note ? el("div", { class: "fk-dump-note", text: note }) : null,
        ta,
        el("div", { class: "fk-dump-actions" }, [
          button("SELECT ALL", function () { selectAll(ta); }),
          button("TRY COPY AGAIN", function () {
            copy(ta.value, { silent: true }).then(function (how) {
              toast(how ? "COPIED" : "STILL BLOCKED — SELECT AND PRESS CTRL+C",
                how ? "ok" : "warn");
            });
          })
        ])
      ])
    ]);

    host.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    document.body.appendChild(host);
    selectAll(ta);
    return host;
  }

  /* ---- stylesheet --------------------------------------------- */
  var CSS = `
:root{
  --bg:#0a0c0b; --bg2:#0f1211; --panel:#121614; --panel2:#171c19;
  --line:#232b26; --line2:#2e3831;
  --fg:#c2cdc4; --fg-dim:#7c8a80; --fg-dimmer:#4d584f;
  --accent:#e0a63c; --accent-dim:#8a6520; --accent-glow:224,166,60;
  --pass:#4fbf6a; --fail:#e0503c; --warn:#e0a63c; --info:#4a9ad4;
  --mono:ui-monospace,"Cascadia Mono","Consolas","DejaVu Sans Mono",monospace;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);
  font-family:var(--mono);font-size:13px;line-height:1.5;overflow:hidden}
button,input,textarea,select{font:inherit;color:inherit}
::selection{background:var(--accent);color:#0a0c0b}

/* scrollbars */
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:var(--bg2)}
*::-webkit-scrollbar-thumb{background:var(--line2);border:2px solid var(--bg2)}
*::-webkit-scrollbar-thumb:hover{background:var(--accent-dim)}

/* ---- desktop ---- */
#fk-desktop{position:fixed;inset:0;overflow:hidden;
  background-color:var(--bg);background-size:cover;background-position:center}
#fk-desktop.has-wallpaper::after{content:"";position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(10,12,11,.55),rgba(10,12,11,.8));pointer-events:none}
#fk-windows{position:absolute;inset:0 0 30px 0}

/* ---- launcher ----
   Full-size tiles, and groups as folders you click into.

   Two earlier shapes: one alphabetical grid of everything (a wall
   at thirty-seven, and it sat SCRATCHPAD next to SECURITY SANDBOX
   because S follows S), then six columns of one-line rows — which
   read well but looked like a settings page rather than a desktop.
   Folders keep the density of the second and the recognisability
   of the first: you find PROJECT by its shape, then the app inside
   it at a size you can actually hit. */
/* Centred and capped, so a wide screen is not one long thin strip
   along the top with the rest empty (§21). Absolute with left/right
   and auto margins rather than a transform: a transformed ancestor
   would pin the fixed folder overlay to it instead of the screen. */
#fk-icons{position:absolute;top:22px;left:14px;right:14px;margin:0 auto;max-width:980px;
  display:flex;flex-direction:column;gap:16px;max-height:calc(100% - 66px);
  overflow-y:auto;overflow-x:hidden;z-index:1;scrollbar-width:thin}
#fk-icons.folder-open{z-index:4000;overflow:visible}
.fk-shelves{display:flex;flex-direction:column;gap:18px}
#fk-icons.searching .fk-shelves{display:none}

/* The search bar (§21). Typing anywhere on the desktop lands here. */
.fk-search{display:flex;flex-direction:column;gap:4px;flex:0 0 auto}
.fk-search-bar{display:flex;align-items:center;gap:10px;padding:9px 12px;
  border:1px solid var(--line2);background:rgba(12,15,13,.78)}
.fk-search-bar:focus-within{border-color:var(--accent-dim);
  box-shadow:0 0 0 1px rgba(var(--accent-glow),.18)}
.fk-search-g{color:var(--accent);font-size:16px;line-height:1}
.fk-search-in{flex:1;min-width:0;background:none;border:0;outline:none;color:var(--fg);
  font:inherit;font-size:13px;letter-spacing:.04em}
.fk-search-in::placeholder{color:var(--fg-dimmer)}
.fk-search-k{flex:none;background:none;border:1px solid var(--line);color:var(--fg-dimmer);
  font:inherit;font-size:8px;letter-spacing:.16em;padding:3px 6px;cursor:pointer}
.fk-search-k:hover{color:var(--accent);border-color:var(--accent-dim)}
.fk-search-hits{display:flex;flex-direction:column}
.fk-hit{display:flex;align-items:center;gap:12px;width:100%;padding:9px 12px;cursor:pointer;
  border:1px solid transparent;border-bottom-color:var(--line);background:rgba(12,15,13,.7);
  color:var(--fg-dim);font:inherit;text-align:left}
.fk-hit.sel{border-color:var(--accent-dim);background:rgba(var(--accent-glow),.1)}
.fk-hit .g{width:22px;flex:none;text-align:center;font-size:18px;color:var(--accent)}
.fk-hit .n{flex:none;min-width:150px;font-size:11px;letter-spacing:.12em;color:var(--fg)}
.fk-hit.sel .n{color:var(--accent)}
.fk-hit .a{flex:1;min-width:0;font-size:10px;color:var(--fg-dimmer);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fk-hit .k{flex:none;font-size:8px;letter-spacing:.16em;color:var(--fg-dimmer)}
.fk-hit.sealed{opacity:.55}
.fk-hit.more .n{min-width:0;flex:1;color:var(--fg-dim);letter-spacing:.06em}
.fk-hit-none{padding:12px;font-size:10px;letter-spacing:.1em;color:var(--fg-dimmer)}

.fk-shelf{display:flex;flex-direction:column;gap:8px}
.fk-shelf-lbl{font-size:9px;letter-spacing:.24em;color:var(--fg-dimmer)}
.fk-grid{display:flex;flex-wrap:wrap;gap:10px}

/* One app. Big enough to hit without aiming, and the label wraps to
   two lines rather than being cut — "SECURITY SANDBOX" truncated to
   "SECURITY SAN" is how you open the wrong thing. */
.fk-app{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  gap:7px;width:100px;height:96px;padding:12px 5px 7px;cursor:pointer;
  border:1px solid var(--line2);background:rgba(12,15,13,.6);
  color:var(--fg-dim);letter-spacing:.05em;text-align:center}
.fk-app:hover,.fk-app:focus-visible{border-color:var(--accent-dim);
  background:rgba(var(--accent-glow),.09);color:var(--accent);outline:none}
.fk-app .g{font-size:28px;line-height:1;color:var(--accent);flex:0 0 auto}
.fk-app .n{font-size:9px;letter-spacing:.06em;line-height:1.25;word-break:break-word}
.fk-app.dead{opacity:.55;border-color:var(--fail)}
.fk-app.dead .g{color:var(--fail)}
.fk-app.sealed{opacity:.45;cursor:not-allowed}
.fk-app.sealed .g{color:var(--fg-dimmer)}
.fk-app.sealed:hover{border-color:var(--line2);color:var(--fg-dimmer);
  background:rgba(12,15,13,.55)}

/* A folder. The 2x2 of what is inside is the whole reason this
   works — a labelled empty square is something you have to read,
   four glyphs is something you recognise. */
/* Since §21 a card, not a square: the glyphs on the left, and the
   name with what is inside it on the right, so a folder says what
   it holds without being opened. */
.fk-folders{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr))}
.fk-folder{position:relative;display:flex;flex-direction:row;align-items:center;
  gap:12px;min-height:80px;padding:10px 12px;cursor:pointer;
  border:1px solid var(--line2);background:rgba(12,15,13,.6);
  color:var(--fg-dim);letter-spacing:.05em;text-align:left;font:inherit}
.fk-folder-txt{display:flex;flex-direction:column;gap:5px;min-width:0}
.fk-folder:hover,.fk-folder:focus-visible,.fk-folder.open{border-color:var(--accent-dim);
  background:rgba(var(--accent-glow),.09);color:var(--accent);outline:none}
.fk-folder.open{box-shadow:inset 0 0 0 1px rgba(var(--accent-glow),.25)}
.fk-folder-peek{display:grid;grid-template-columns:repeat(2,1fr);gap:2px;
  width:46px;height:46px;padding:4px;flex:0 0 auto;
  border:1px solid var(--line);background:rgba(0,0,0,.35)}
.fk-folder-peek .p{display:flex;align-items:center;justify-content:center;
  font-size:14px;line-height:1;color:var(--accent);overflow:hidden}
.fk-folder .n{font-size:11px;letter-spacing:.2em;line-height:1.2;color:var(--fg)}
.fk-folder:hover .n,.fk-folder.open .n{color:var(--accent)}
.fk-folder .s{font-size:9px;letter-spacing:.04em;line-height:1.45;color:var(--fg-dimmer);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fk-folder .c{position:absolute;top:5px;right:7px;font-size:8px;color:var(--fg-dimmer)}
.fk-folder.bad{border-color:var(--fail)}
.fk-folder.bad .n,.fk-folder.bad .fk-folder-peek .p{color:var(--fail)}

/* The opened folder. Fixed, so it covers the desktop the way a
   phone's does; the backdrop is a sibling of the panel so a click
   on a tile is never confused with a click behind one. */
.fk-folder-open{position:fixed;inset:0 0 30px 0;display:flex;
  align-items:center;justify-content:center}
.fk-folder-back{position:absolute;inset:0;background:rgba(6,8,7,.78);
  backdrop-filter:blur(2px)}
.fk-folder-panel{position:relative;max-width:min(760px,90vw);max-height:80%;
  overflow:auto;padding:14px;background:var(--panel);border:1px solid var(--accent-dim);
  box-shadow:0 18px 60px rgba(0,0,0,.8)}
.fk-folder-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;
  padding-bottom:8px;border-bottom:1px solid var(--line2)}
.fk-folder-head .t{font-size:12px;letter-spacing:.24em;color:var(--accent)}
.fk-folder-head .c{font-size:8px;letter-spacing:.16em;color:var(--fg-dimmer);flex:1}

/* ---- windows ---- */
.fk-win{position:absolute;min-width:280px;min-height:150px;display:flex;flex-direction:column;
  background:var(--panel);border:1px solid var(--line2);
  box-shadow:0 14px 40px rgba(0,0,0,.65);z-index:10}
.fk-win.focused{border-color:var(--accent-dim);
  box-shadow:0 0 0 1px rgba(var(--accent-glow),.18),0 18px 48px rgba(0,0,0,.75)}
.fk-win-bar{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:move;
  background:var(--panel2);border-bottom:1px solid var(--line);user-select:none}
.fk-win.focused .fk-win-bar{background:linear-gradient(180deg,#1c231e,#151a17)}
.fk-win-glyph{color:var(--accent)}
.fk-win-title{flex:1;font-size:11px;letter-spacing:.18em;color:var(--fg-dim);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fk-win.focused .fk-win-title{color:var(--accent)}
.fk-win-btn{width:22px;height:20px;border:1px solid var(--line2);background:#10130f;
  color:var(--fg-dim);cursor:pointer;line-height:1;font-size:11px;padding:0}
.fk-win-btn:hover{border-color:var(--accent);color:var(--accent)}
.fk-win-btn.close:hover{border-color:var(--fail);color:var(--fail)}
.fk-win-body{flex:1;overflow:auto;padding:12px;position:relative}
.fk-win-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;
  z-index:2;touch-action:none}
.fk-win-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;
  border-right:2px solid var(--line2);border-bottom:2px solid var(--line2)}
/* Edge handles. Six pixels wide and invisible until hovered — a
   corner grip alone is a 16px target that has to be hit before a
   window can be made usable, and BROWSER is the one people most
   want bigger. touch-action:none so a drag on a touchscreen resizes
   instead of scrolling the desktop out from under it. */
.fk-win-grip{position:absolute;z-index:1;touch-action:none}
.fk-win-grip.e{top:0;right:0;width:6px;height:100%;cursor:ew-resize}
.fk-win-grip.w{top:0;left:0;width:6px;height:100%;cursor:ew-resize}
.fk-win-grip.s{left:0;bottom:0;width:100%;height:6px;cursor:ns-resize}
.fk-win-grip:hover{background:rgba(var(--accent-glow),.22)}
.fk-win.minimized{display:none}
/* Maximised fills the desktop and leaves everything else reachable.
   Inset at the bottom by the taskbar's height so the window it just
   covered is still switchable. */
.fk-win.maximized{left:0 !important;top:0 !important;width:100% !important;
  height:calc(100% - 30px) !important;box-shadow:none}
.fk-win.maximized .fk-win-resize,.fk-win.maximized .fk-win-grip{display:none}
.fk-win.maximized .fk-win-bar{cursor:default}
/* Fullscreen is the real API, so the element is the whole screen and
   the desktop's own background is not behind it. */
.fk-win:fullscreen{width:100% !important;height:100% !important;left:0 !important;top:0 !important;
  border:none;background:var(--panel)}
.fk-win:fullscreen .fk-win-resize,.fk-win:fullscreen .fk-win-grip{display:none}
.fk-win:-webkit-full-screen{width:100% !important;height:100% !important;border:none}

/* ---- taskbar ---- */
#fk-taskbar{position:absolute;left:0;right:0;bottom:0;height:30px;display:flex;align-items:center;
  gap:8px;padding:0 10px;background:#0c0f0d;border-top:1px solid var(--line2);z-index:5000}
#fk-taskbar .brand{color:var(--accent);letter-spacing:.24em;font-size:11px;font-weight:700}
#fk-tasks{flex:1;display:flex;gap:5px;overflow:hidden}
.fk-task{padding:3px 10px;border:1px solid var(--line2);background:#11150f;color:var(--fg-dim);
  font-size:11px;letter-spacing:.1em;cursor:pointer;white-space:nowrap}
.fk-task:hover{color:var(--accent);border-color:var(--accent-dim)}
.fk-task.active{color:var(--accent);border-color:var(--accent);background:rgba(var(--accent-glow),.08)}
#fk-tray{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--fg-dim)}

/* ---- status ---- */
.fk-status{display:inline-flex;align-items:center;gap:6px;letter-spacing:.1em;font-size:11px}
.fk-dot{width:7px;height:7px;border-radius:50%;background:var(--fg-dimmer);flex:none}
.fk-status-ok .fk-dot{background:var(--pass);box-shadow:0 0 6px var(--pass)}
.fk-status-ok{color:var(--pass)}
.fk-status-warn .fk-dot{background:var(--warn);box-shadow:0 0 6px var(--warn)}
.fk-status-warn{color:var(--warn)}
.fk-status-bad .fk-dot{background:var(--fail);box-shadow:0 0 6px var(--fail)}
.fk-status-bad{color:var(--fail)}

/* ---- controls ---- */
.fk-btn{background:#161b18;border:1px solid var(--line2);color:var(--fg);
  padding:7px 14px;letter-spacing:.12em;font-size:11px;cursor:pointer}
.fk-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.fk-btn:disabled{opacity:.35;cursor:default}
.fk-btn-primary{border-color:var(--accent-dim);color:var(--accent)}
.fk-btn-primary:hover:not(:disabled){background:rgba(var(--accent-glow),.1)}
.fk-btn-danger:hover:not(:disabled){border-color:var(--fail);color:var(--fail)}
.fk-field{display:block;margin-bottom:12px}
.fk-field-label{display:block;font-size:10px;letter-spacing:.2em;color:var(--fg-dim);margin-bottom:5px}
.fk-input,textarea.fk-input{width:100%;background:#0b0e0c;border:1px solid var(--line2);
  color:var(--fg);padding:9px 10px}
.fk-input:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 1px rgba(var(--accent-glow),.25)}

/* ---- panels / readouts ---- */
.fk-panel{border:1px solid var(--line);background:var(--bg2);margin-bottom:12px}
.fk-panel-title{padding:6px 10px;border-bottom:1px solid var(--line);
  font-size:10px;letter-spacing:.22em;color:var(--accent);background:#101412}
.fk-panel-body{padding:10px}
.fk-readout-row{display:flex;align-items:baseline;gap:6px;padding:2px 0}
.fk-readout-label{color:var(--fg-dim);font-size:11px;letter-spacing:.08em;white-space:nowrap}
.fk-readout-dots{flex:1;border-bottom:1px dotted var(--line2);transform:translateY(-3px)}
.fk-readout-value{font-size:11px;white-space:nowrap}
.lvl-ok,.lvl-pass{color:var(--pass)} .lvl-fail{color:var(--fail)}
.lvl-warn{color:var(--warn)} .lvl-info{color:var(--info)} .lvl-dim{color:var(--fg-dim)}

/* ---- toasts ---- */
#fk-toasts{position:fixed;right:14px;bottom:42px;display:flex;flex-direction:column;
  gap:6px;z-index:9000;pointer-events:none}
.fk-toast{padding:8px 12px;border:1px solid var(--line2);background:#12160f;
  font-size:11px;letter-spacing:.08em;max-width:340px;
  animation:fk-slide .22s ease-out}
.fk-toast.lvl-ok{border-color:var(--pass);color:var(--pass)}
.fk-toast.lvl-fail{border-color:var(--fail);color:var(--fail)}
.fk-toast.lvl-warn{border-color:var(--warn);color:var(--warn)}
.fk-toast.out{opacity:0;transition:opacity .4s}
@keyframes fk-slide{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}

/* ---- text dump: the route out that cannot be blocked ---- */
.fk-dump{position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.72);
  display:flex;align-items:center;justify-content:center;padding:24px}
.fk-dump-box{background:var(--panel);border:1px solid var(--accent);
  width:min(760px,100%);max-height:100%;display:flex;flex-direction:column;
  box-shadow:0 0 40px rgba(var(--accent-glow),.18)}
.fk-dump-head{display:flex;align-items:center;gap:10px;padding:9px 11px;
  border-bottom:1px solid var(--line2)}
.fk-dump-title{flex:1;font-size:11px;letter-spacing:.16em;color:var(--accent)}
.fk-dump-note{padding:8px 11px;font-size:10px;line-height:1.6;color:var(--warn);
  border-bottom:1px solid var(--line2)}
.fk-dump-text{flex:1;min-height:320px;margin:11px;width:calc(100% - 22px);
  font-size:11px;line-height:1.5;resize:none;white-space:pre}
.fk-dump-actions{display:flex;gap:6px;padding:0 11px 11px}
.fk-dump-actions .fk-btn{flex:1}

/* ---- CRT / ambient (opt-in) ---- */
body.crt #fk-desktop::before{content:"";position:absolute;inset:0;z-index:8000;pointer-events:none;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px)}
body.crt #fk-desktop{animation:fk-flicker 5s infinite}
@keyframes fk-flicker{0%,97%,100%{filter:none}98%{filter:brightness(1.1)}99%{filter:brightness(.94)}}

@media (prefers-reduced-motion: reduce){
  .fk-toast{animation:none}
  body.crt #fk-desktop{animation:none}
}
`;

  function injectCSS() {
    if (document.getElementById("fk-style")) return;
    var s = document.createElement("style");
    s.id = "fk-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  injectCSS();
  applyTheme(currentTheme);

  FieldKit.provide("ui", {
    THEMES: THEMES,
    applyTheme: applyTheme,
    currentTheme: function () { return currentTheme; },
    el: el,
    clear: clear,
    button: button,
    field: field,
    panel: panel,
    readout: readout,
    statusDot: statusDot,
    toast: toast,
    copy: copy,
    download: download,
    textDump: textDump
  });
})(window.FieldKit);
