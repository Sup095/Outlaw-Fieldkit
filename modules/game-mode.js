/* ============================================================
   FieldKit :: game-mode — GAME MODE
   The Outlaw Engine, the user's own hub of games and apps, opened from
   FieldKit or OUTPOST: full screen with one thin bar to come back, or in
   a window like any other app.

   NOTHING OF THE ENGINE IS CHANGED OR MERGED. It runs in a frame exactly
   as it is in its own folder: its look, its library, its settings and
   its own diagnostics (SYSTEM CHECK, DIAG, FULL SCAN) stay its own.
   FieldKit only finds a copy and opens it.

   WHERE THE COPY COMES FROM, first that works:
     1. DRIVE: games/outlaw-engine/ beside FIELDKIT.html or OUTPOST.html,
        put there by `node build.js --deploy` from tools/sync-games.js.
        Found by loading its fieldkit-games.js with a <script> tag, which
        works from file:// where fetch does not.
     2. RELAY: the same files in the relay image (relay/games.js), for
        someone signed in to MESSAGES or with a gamertag: the relay hands
        out a ticket good for twelve hours and the frame opens that.

   The frame is another origin (another file, or the relay), so a game
   cannot reach FieldKit, its vault or its sign-ins.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var LOCAL = "games/outlaw-engine/";
  var GAMES = "fk.deephold";
  var ctx, el, host = null, gone = true, local = null, localTried = false, relayInfo = null, note = "", overlay = null;

  function ui() { return FieldKit.service("ui"); }
  function relayBase() {
    var st = FieldKit.service("settings");
    var u = String((st && st.get("relayUrl")) || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }
  function msgs() { var m = FieldKit.service("messages"); return m && m.signedIn && m.signedIn() ? m : null; }
  function game() {
    var dh = FieldKit.service("deephold");
    if (dh && dh.session) { var s = dh.session(); if (s) return s; }
    try { var st = JSON.parse(window.localStorage.getItem(GAMES) || "null"); if (st && st.token && st.tag) return { token: st.token, tag: st.tag }; } catch (e) { /* none */ }
    return null;
  }

  /* 1. a copy beside this page? */
  function findLocal() {
    return new Promise(function (resolve) {
      if (localTried) return resolve(local);
      var base;
      try { base = new URL(LOCAL, document.baseURI || window.location.href).href; } catch (e) { localTried = true; return resolve(null); }
      if (!/^(file|https?):/.test(base)) { localTried = true; return resolve(null); }
      var s = document.createElement("script"), done = false;
      var finish = function (ok) {
        if (done) return; done = true;
        localTried = true;
        local = ok && window.FK_GAMES ? { url: base + "index.html", info: window.FK_GAMES } : null;
        try { s.parentNode && s.parentNode.removeChild(s); } catch (e) { /* gone */ }
        resolve(local);
      };
      s.onload = function () { finish(true); };
      s.onerror = function () { finish(false); };
      setTimeout(function () { finish(false); }, 4000);
      s.src = base + "fieldkit-games.js";
      document.head.appendChild(s);
    });
  }

  /* 2. a ticket from the relay */
  async function relayTicket() {
    var base = relayBase();
    if (!base) throw new Error("no relay is set up (RELAY LINK)");
    var m = msgs(), data = null;
    if (m && m.gamesTicket) data = await m.gamesTicket();
    else {
      var g = game();
      if (!g) { var e0 = new Error("sign in to MESSAGES, or with your gamertag (POOL HALL or DEEPHOLD), to play through the relay"); e0.needsSignIn = true; throw e0; }
      var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 15000);
      try {
        var res = await window.fetch(base + "/games/ticket", { method: "POST", headers: { Authorization: "Bearer " + g.token }, mode: "cors", cache: "no-store", signal: ac.signal });
        var text = await res.text();
        try { data = JSON.parse(text || "{}"); } catch (e) { data = {}; }
        if (!res.ok) { var e1 = new Error(data.error || ("the relay answered " + res.status)); e1.needsSignIn = !!data.needsSignIn; throw e1; }
      } catch (e) { if (e.name === "AbortError") throw new Error("the relay did not answer in time"); throw e; }
      finally { clearTimeout(timer); }
    }
    relayInfo = data.info || relayInfo;
    return { url: base + data.path, info: data.info || null };
  }
  async function relayStatus() {
    var base = relayBase();
    if (!base) return null;
    try {
      var res = await window.fetch(base + "/games/status", { cache: "no-store", mode: "cors" });
      if (!res.ok) return null;
      return JSON.parse((await res.text()) || "{}");
    } catch (e) { return null; }
  }

  /* where to open, or why not */
  async function source() {
    var l = await findLocal();
    if (l) return { url: l.url, info: l.info, from: "DRIVE" };
    var r = await relayTicket();
    return { url: r.url, info: r.info, from: "RELAY" };
  }

  /* ---- full screen: the engine and one thin bar --------------------------- */
  function enter(src) {
    leave();
    css();
    el = el || ui().el;
    var frame = document.createElement("iframe");
    frame.className = "gx-frame";
    frame.setAttribute("title", "Outlaw Engine");
    frame.setAttribute("allow", "fullscreen; autoplay; gamepad; clipboard-write");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = src.url;
    var back = el("button", { class: "gx-btn", type: "button", text: "◂ BACK TO " + appName(), onclick: function () { leave(); } });
    var fs = el("button", { class: "gx-btn", type: "button", text: "⛶ FULL SCREEN", onclick: function () { toggleFull(); } });
    var bar = el("div", { class: "gx-bar" }, [
      back,
      el("span", { class: "gx-title", text: "OUTLAW ENGINE" + (src.info && src.info.version ? " v" + src.info.version : "") + " · GAME MODE" }),
      el("span", { class: "gx-from", text: src.from === "DRIVE" ? "FROM THIS DRIVE" : "THROUGH THE RELAY" }),
      fs
    ]);
    overlay = el("div", { class: "gx-overlay" }, [bar, frame]);
    overlay.addEventListener("keydown", function (e) { if (e.key === "Escape" && e.target === overlay) leave(); });
    document.body.appendChild(overlay);
    try { overlay.requestFullscreen && overlay.requestFullscreen().catch(function () { /* the bar is enough */ }); } catch (e) { /* not allowed here */ }
    setTimeout(function () { try { frame.focus(); } catch (e) { /* fine */ } }, 50);
  }
  function leave() {
    if (!overlay) return;
    try { if (document.fullscreenElement === overlay && document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) { /* fine */ }
    var f = overlay.querySelector ? overlay.querySelector("iframe") : null;
    if (f) f.src = "about:blank";                     /* stops the game and its sound */
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }
  function toggleFull() {
    if (!overlay) return;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (overlay.requestFullscreen) overlay.requestFullscreen();
    } catch (e) { /* not here */ }
  }
  function appName() {
    var b = FieldKit.service("boot");
    return b && b.OUTPOST ? "OUTPOST" : "FIELDKIT";
  }

  /* ---- the panel ----------------------------------------------------------- */
  async function go(where) {
    note = "OPENING..."; paint();
    try {
      var src = await source();
      note = "";
      if (where === "window") {
        paint(src);
      } else { enter(src); paint(); }
    } catch (e) {
      note = "! " + e.message;
      paint(null, !!e.needsSignIn);
    }
  }

  function paint(inWindow, wantSignIn) {
    if (!host || gone) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    var root = el("div", { class: "gx-root" });
    host.appendChild(root);
    if (inWindow) {
      var fr = document.createElement("iframe");
      fr.className = "gx-frame"; fr.setAttribute("title", "Outlaw Engine");
      fr.setAttribute("allow", "fullscreen; autoplay; gamepad; clipboard-write");
      fr.setAttribute("referrerpolicy", "no-referrer");
      fr.src = inWindow.url;
      root.appendChild(el("div", { class: "gx-bar" }, [
        el("button", { class: "gx-btn", type: "button", text: "◂ BACK", onclick: function () { paint(); } }),
        el("span", { class: "gx-title", text: "OUTLAW ENGINE · GAME MODE" }),
        el("button", { class: "gx-btn", type: "button", text: "⛶ GO FULL SCREEN", onclick: function () { enter(inWindow); paint(); } })
      ]));
      root.appendChild(fr);
      return;
    }
    var info = (local && local.info) || relayInfo;
    var body = el("div", { class: "gx-body" });
    root.appendChild(body);
    body.appendChild(el("div", { class: "gx-logo", text: "OUTLAW ENGINE" }));
    body.appendChild(el("div", { class: "gx-sub", text: "GAME MODE · YOUR GAMES AND APPS" + (info && info.version ? " · v" + info.version : "") }));
    body.appendChild(el("div", { class: "gx-row" }, [
      el("button", { class: "gx-play", type: "button", text: "▶ ENTER GAME MODE", onclick: function () { go("full"); } }),
      el("button", { class: "gx-btn", type: "button", text: "PLAY IN THIS WINDOW", onclick: function () { go("window"); } })
    ]));
    var where = local ? "Opens from this drive (games/outlaw-engine)." : localTried ? "No copy on this drive, so it opens through the relay while you are signed in." : "";
    if (where) body.appendChild(el("p", { class: "gx-p", text: where }));
    if (note) body.appendChild(el("p", { class: note.charAt(0) === "!" ? "gx-warn" : "gx-p", text: note }));
    if (wantSignIn) {
      body.appendChild(el("div", { class: "gx-row" }, [
        el("button", { class: "gx-btn", type: "button", text: "SIGN IN TO MESSAGES", onclick: async function () { var m = FieldKit.service("messages"); if (m && m.promptSignIn) { try { await m.promptSignIn("for GAME MODE"); } catch (e) { /* closed */ } } note = ""; paint(); } }),
        el("button", { class: "gx-btn", type: "button", text: "GET A GAMERTAG (POOL HALL)", onclick: function () { var sh = FieldKit.service("shell"); if (sh && sh.open) sh.open("pool"); } })
      ]));
    }
    if (info && info.library && info.library.sections) {
      body.appendChild(el("div", { class: "gx-count", text: info.library.games + " GAMES · " + info.library.apps + " APPS · " + info.library.workshop + " WORKSHOP · " + info.library.legacy + " LEGACY" }));
      var list = el("div", { class: "gx-lib" });
      info.library.sections.forEach(function (s) {
        if (s.group === "LEGACY") return;
        list.appendChild(el("div", { class: "gx-sec" }, [
          el("div", { class: "gx-sec-h", text: s.label }),
          el("div", { class: "gx-sec-t", text: s.titles.join(" · ") })
        ]));
      });
      body.appendChild(list);
    }
    body.appendChild(el("p", { class: "gx-p dim", text: "Everything inside is the Outlaw Engine as it is: its own look, settings and SYSTEM CHECK. In full screen, the bar at the top brings you back. © Outlaw Systems." }));
  }

  function css() {
    if (document.getElementById("gx-css")) return;
    var s = document.createElement("style"); s.id = "gx-css";
    s.textContent = [
      ".gx-overlay{position:fixed;inset:0;z-index:2147483000;background:#000;display:flex;flex-direction:column}",
      ".gx-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#020604;color:#7dffa0;font-family:Consolas,'Courier New',monospace;overflow:hidden}",
      ".gx-bar{display:flex;align-items:center;gap:10px;height:30px;padding:0 8px;background:#020a05;border-bottom:1px solid #1d5a2e;color:#5fe08a;font:12px Consolas,'Courier New',monospace;flex:none}",
      ".gx-title{flex:1;letter-spacing:.25em;text-shadow:0 0 6px rgba(80,255,140,.5)}.gx-from{color:#3a8a55;font-size:10px;letter-spacing:.15em}",
      ".gx-btn{font:inherit;font-size:11px;letter-spacing:.12em;background:#03140a;color:#7dffa0;border:1px solid #1d5a2e;padding:4px 10px;cursor:pointer}",
      ".gx-btn:hover,.gx-play:hover{background:#0a2a15;border-color:#4fe07f}",
      ".gx-frame{flex:1;width:100%;border:0;background:#000;display:block}",
      ".gx-body{flex:1;overflow:auto;padding:22px;display:flex;flex-direction:column;gap:12px;background:radial-gradient(ellipse at 50% 0,#06200f,#020604 70%)}",
      ".gx-logo{font-size:30px;letter-spacing:.35em;font-weight:bold;color:#8dffaf;text-shadow:0 0 14px rgba(80,255,140,.6)}",
      ".gx-sub{letter-spacing:.2em;font-size:11px;color:#4fbf72}",
      ".gx-row{display:flex;gap:8px;flex-wrap:wrap}",
      ".gx-play{font:inherit;font-size:15px;letter-spacing:.2em;padding:10px 20px;background:#063018;color:#b0ffc8;border:1px solid #4fe07f;cursor:pointer;box-shadow:0 0 12px rgba(80,255,140,.25)}",
      ".gx-p{margin:0;color:#5fbf80;line-height:1.5;font-size:12px}.gx-p.dim{color:#3a7a52;font-size:11px}.gx-warn{margin:0;color:#ffb07a;font-size:12px}",
      ".gx-count{letter-spacing:.18em;font-size:11px;color:#8dffaf;margin-top:6px}",
      ".gx-lib{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}",
      ".gx-sec{border:1px solid #154a26;background:rgba(0,20,8,.6);padding:8px}.gx-sec-h{font-size:10px;letter-spacing:.18em;color:#e8d070;margin-bottom:4px}.gx-sec-t{font-size:11px;color:#6fd890;line-height:1.5}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function selfcheck() {
    return [{ name: "GAME MODE CAN FIND THE GAMES", critical: false, run: async function () {
      var l = await findLocal();
      if (l) return "on this drive: Outlaw Engine" + (l.info.version ? " v" + l.info.version : "") + ", " + (l.info.files || "?") + " files";
      var r = await relayStatus();
      if (r && r.up) return "not on this drive; the relay has them (v" + (r.version || "?") + ") for signed-in people";
      if (!relayBase()) return "no copy on this drive and no relay set up, so GAME MODE cannot open";
      throw new Error("SKIPPED — no copy on this drive, and this relay has none");
    } }];
  }

  FieldKit.provide("gameMode", { _source: source, _enter: enter, _leave: leave, _local: findLocal, _open: function () { return !!overlay; } });

  FieldKit.register("game-mode", {
    title: "GAME MODE",
    icon: "▶",
    group: "GAMES",
    about: "The Outlaw Engine: your games and apps, full screen",
    keywords: "game mode games outlaw engine arcade play library apps steam console fullscreen",
    width: 980,
    height: 700,
    guestSafe: true,
    selfcheck: selfcheck,
    async mount(h, context) {
      ctx = context; el = ctx.ui.el; host = h; gone = false; note = "";
      css();
      paint();
      await findLocal();
      if (!local) relayStatus().then(function (r) { if (r && r.up && !relayInfo) relayInfo = { version: r.version, library: null }; paint(); });
      paint();
    },
    unmount() { gone = true; host = null; }
  });
})(window.FieldKit);
