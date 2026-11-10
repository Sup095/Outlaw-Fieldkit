/* ============================================================
   FieldKit :: colony — DEEPHOLD
   A shared underground colony game. Your colony is yours; the
   Civilization above it is everyone's. The game runs on the relay
   (relay/colony-engine.js); this panel shows it and sends clicks.

   You never mine anything yourself: you choose what to build, where,
   and how much of what it makes goes up to the Civ.

   WHO PLAYS. A DEEPHOLD gamertag, made here: separate from MESSAGES
   and from the vault, so the people the game counts are exactly the
   people who play.

   HOW IT STAYS SMOOTH. The relay is asked every few seconds. In
   between, this panel keeps running on what the relay last said: the
   stocks climb at the rates it reported, the clocks count down, the
   workers keep walking. Nothing on screen is ever rebuilt while you are
   using it, so a text box or a button you are holding is never lost:
   each piece of the screen is made once and only its words change.

   The panel trusts nothing it computes. A click is a request the relay
   can refuse with a reason.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var RES = ["ore", "water", "fungus", "crystal", "fuel", "food", "parts", "goods", "arms"];
  var RES_NAME = { ore: "ORE", water: "WATER", fungus: "FUNGUS", crystal: "CRYSTAL", fuel: "FUEL", food: "FOOD", parts: "PARTS", goods: "GOODS", arms: "ARMS" };
  var STORE_KEY = "fk.deephold";

  /* ---- who is signed in (kept for the page, and on this device if asked) ---- */
  var session = null;                  /* { token, tag } */
  var lastEv = null;
  var alertTimer = null;

  function ui() { return FieldKit.service("ui"); }
  function relayBase() {
    var st = FieldKit.service("settings");
    var u = String((st && st.get("relayUrl")) || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }
  function store(get, v) {
    try {
      if (get === "get") return JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
      if (v === null) window.localStorage.removeItem(STORE_KEY); else window.localStorage.setItem(STORE_KEY, JSON.stringify(v));
    } catch (e) { /* no storage: the session lives for this page only */ }
    return null;
  }
  function remember(on) {
    if (!session) return;
    var s = store("get") || {};
    if (on) store("set", { token: session.token, tag: session.tag, ev: lastEv }); else store("set", { tag: session.tag, ev: lastEv });
  }
  (function restore() {
    var s = store("get");
    if (s && s.token && s.tag) { session = { token: s.token, tag: s.tag }; lastEv = s.ev == null ? null : s.ev; }
  })();

  async function api(method, path, body, opts) {
    opts = opts || {};
    var base = relayBase();
    if (!base) throw new Error("no relay is set up; add one in RELAY LINK first");
    var headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (session && session.token && !opts.anon) headers.Authorization = "Bearer " + session.token;
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 15000);
    try {
      var res = await window.fetch(base + "/colony/" + path, { method: method, headers: headers, mode: "cors", cache: "no-store", signal: ac.signal, body: body === undefined ? undefined : JSON.stringify(body) });
      var text = await res.text(), data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
      if (!res.ok) {
        if (res.status === 401 && data && data.needsSignIn && session) { session = null; store("set", null); FieldKit.emit("deephold:signout", {}); }
        var err = new Error((data && data.error) || ("the relay answered " + res.status));
        err.status = res.status; err.data = data; throw err;
      }
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("the relay did not answer in time");
      throw e;
    } finally { clearTimeout(timer); }
  }

  /* ---- warnings and news, even while the panel is closed ------------------- */
  async function pollEvents() {
    if (!session || document.hidden) return;
    try {
      var r = await api("GET", "events?since=" + (lastEv == null ? -1 : lastEv));
      var u = ui();
      (r.events || []).slice(-8).forEach(function (e) {
        if (u) u.toast("DEEPHOLD: " + e.text, e.level === "bad" ? "fail" : e.level === "warn" ? "warn" : e.level === "ok" ? "ok" : "info");
      });
      lastEv = r.last;
      var s = store("get"); if (s) { s.ev = lastEv; store("set", s); }
    } catch (e) { /* the tray already says when the relay is away */ }
  }
  function startAlerts() {
    if (alertTimer) return;
    alertTimer = setInterval(pollEvents, 45000);
    setTimeout(pollEvents, 4000);
  }
  if (session) startAlerts();
  FieldKit.on("deephold:signout", function () { if (alertTimer) { clearInterval(alertTimer); alertTimer = null; } });

  /* ---- small helpers -------------------------------------------------------- */
  function n(v) { v = Number(v) || 0; return v >= 100000 ? Math.round(v / 1000) + "k" : v >= 10000 ? (Math.round(v / 100) / 10) + "k" : String(Math.round(v)); }
  function n1(v) { v = Number(v) || 0; return v < 100 ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)); }
  function clock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? h + "h " + m + "m" : m ? m + "m " + (s % 60) + "s" : s + "s";
  }
  function costText(cost) { return Object.keys(cost || {}).map(function (r) { return cost[r] + " " + RES_NAME[r].toLowerCase(); }).join(", "); }
  function rateText(r) { var a = Math.abs(r); return (r >= 0 ? "+" : "−") + (a < 10 ? a.toFixed(2) : a.toFixed(1)); }
  function jsonSig(o) { try { return JSON.stringify(o); } catch (e) { return String(Math.random()); } }

  var ctx, el, host, gone = false, root = null;
  var view = null, viewAt = 0, pollTimer = null, tickTimer = null, busy = false;
  var scene = null, R = {};                       /* R: the refs of the screen that exists */
  var screen = "", tab = "colony", sel = null, buildCat = null, menuOpen = false, lastErr = "";
  var sigs = {};
  var foundBiome = "seam", foundName = "";

  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  function setCls(node, cls) { if (node && node.className !== cls) node.className = cls; }
  function show(node, on) { if (node && node.style) node.style.display = on ? "" : "none"; }

  function find(id) {
    var c = view && view.catalog ? view.catalog : [];
    for (var i = 0; i < c.length; i++) if (c[i].id === id) return c[i];
    return { id: id, name: String(id).toUpperCase(), cost: {} };
  }
  function countOf(c, id) { var k = 0; c.grid.forEach(function (row) { row.forEach(function (x) { if (x && x.t === id) k++; }); }); return k; }
  function liveStock(r) {
    var c = view && view.colony; if (!c) return 0;
    var base = c.stock[r] || 0, dt = Math.min(90, (Date.now() - viewAt) / 1000);
    return Math.max(0, Math.min(view.constants.stockCap, base + (c.rate[r] || 0) * dt));
  }
  function afford(cost) { return Object.keys(cost || {}).every(function (r) { return liveStock(r) >= cost[r]; }); }

  /* ---- talking to the relay ---------------------------------------------------- */
  var reqSeq = 0, shownSeq = 0;
  /* a view is shown only if it was asked for after the one on screen */
  function take(v, seq) { if (seq < shownSeq) return; shownSeq = seq; view = v; viewAt = Date.now(); lastErr = ""; applyView(); }

  async function load() {
    if (gone || !session) return;
    var my = ++reqSeq;
    try { take(await api("GET", "me"), my); }
    catch (e) {
      lastErr = e.message || "could not reach the relay";
      if (!session) return route();
      setText(R.err, lastErr);
    }
  }
  /* actions run one after another, in the order clicked; none is dropped */
  var actChain = Promise.resolve();
  function act(path, body, quiet) {
    actChain = actChain.then(async function () {
      if (gone || !session) return;
      var my = ++reqSeq;
      try { take(await api("POST", path, body || {}), my); }
      catch (e) { if (!quiet || e.status !== 400) ui().toast(String(e.message || "failed").toUpperCase(), "warn"); }
    });
    return actChain;
  }

  /* ---- which screen ------------------------------------------------------------ */
  function route() {
    if (gone || !host) return;
    var want = !session ? "auth" : !view ? "wait" : (!view.colony || view.colony.collapsed) ? "found" : "game";
    if (want === screen) return;
    screen = want;
    if (scene) { scene.destroy(); scene = null; }
    ui().clear(host);
    R = {}; sigs = {};
    root = el("div", { class: "dh" });
    host.appendChild(root);
    if (want === "auth") buildAuth();
    else if (want === "wait") root.appendChild(el("div", { class: "dh-center" }, [el("div", { class: "dh-logo", text: "DEEPHOLD" }), R.err = el("div", { class: "dh-dim", text: "Reaching the Deep…" })]));
    else if (want === "found") buildFound();
    else buildGame();
    if (view) applyView();
  }

  /* ---- sign in --------------------------------------------------------------- */
  function buildAuth() {
    var tag = el("input", { class: "fk-input", placeholder: "gamertag", maxlength: "20", autocomplete: "username", value: (store("get") || {}).tag || "" });
    var pw = el("input", { class: "fk-input", type: "password", placeholder: "password", autocomplete: "current-password" });
    var keep = el("input", { type: "checkbox", id: "dh-keep" }); keep.checked = true;
    var msg = el("div", { class: "dh-note", text: "" });
    async function go(kind) {
      if (busy) return;
      busy = true; setText(msg, "…");
      try {
        var r = await api("POST", kind, { tag: tag.value, password: pw.value }, { anon: true });
        session = { token: r.token, tag: r.tag }; lastEv = null; pw.value = "";
        if (keep.checked) remember(true); else remember(false);
        startAlerts();
        /* a MESSAGES admin vouches for this gamertag, quietly */
        var m = FieldKit.service("messages");
        if (m && m.tier && m.tier() === "admin" && !r.admin) { try { await m.colony("POST", "/colony/claimadmin", { token: session.token }); } catch (e) { /* not an admin here, or MESSAGES is signed out */ } }
        screen = ""; view = null; busy = false;
        route(); await load();
      } catch (e) { setText(msg, e.message || "that did not work"); busy = false; }
    }
    root.appendChild(el("div", { class: "dh-center" }, [
      el("div", { class: "dh-logo", text: "DEEPHOLD" }),
      el("p", { class: "dh-p", text: "A colony under the rock, shared with everyone on this relay. Pick a gamertag to play. It is only for this game; it is not your MESSAGES account, and only people who play are counted." }),
      tag, pw,
      el("label", { class: "dh-row dh-dim" }, [keep, el("span", { text: "keep me signed in on this device" })]),
      el("div", { class: "dh-row" }, [ui().button("SIGN IN", function () { go("login"); }, { primary: true }), ui().button("CREATE GAMERTAG", function () { go("register"); })]),
      msg,
      el("div", { class: "dh-note", text: "There is no password reset. Pick one you will keep." })
    ]));
    pw.addEventListener("keydown", function (e) { if (e.key === "Enter") go("login"); });
  }

  /* ---- no colony yet --------------------------------------------------------- */
  function buildFound() {
    var kids = [
      el("div", { class: "dh-logo", text: "DEEPHOLD" }),
      el("p", { class: "dh-p", text: view && view.colony && view.colony.collapsed ? "Everyone is gone. The Civilization still counts what you gave it. Choose where to start again." : "Under the surface there is a Civilization that needs everything, and nobody to give it. Choose a place to break ground. You never dig by hand: you build, and your buildings work whether you are here or not." }),
      el("p", { class: "dh-p dh-dim", text: "Away from the screen, what your colony ships still reaches the Civ in full and you keep 30% of the rest. Nobody can die while you are away. After a week unseen a colony is paused until you come back." })
    ];
    R.biomes = el("div", { class: "dh-biomes" });
    kids.push(R.biomes);
    R.foundName = el("input", { class: "fk-input", placeholder: "name your colony", maxlength: "24", value: foundName });
    R.foundName.addEventListener("input", function (e) { foundName = e.target.value; });
    R.foundBtn = ui().button("BREAK GROUND", function () { if (view && view.cooldown) return; act("found", { biome: foundBiome, name: foundName }); }, { primary: true });
    kids.push(el("div", { class: "dh-row" }, [R.foundName, R.foundBtn]));
    kids.push(R.err = el("div", { class: "dh-note bad", text: "" }));
    kids.push(el("div", { class: "dh-row" }, [ui().button("SIGN OUT", signOut)]));
    root.appendChild(el("div", { class: "dh-center wide" }, kids));
  }
  function fillFound() {
    var sig = jsonSig([view.biomes, foundBiome]);
    if (sigs.biomes !== sig) {
      sigs.biomes = sig; ui().clear(R.biomes);
      view.biomes.forEach(function (b) {
        R.biomes.appendChild(el("button", { class: "dh-biome" + (foundBiome === b.id ? " on" : "") + (b.open ? "" : " locked") + (b.admin ? " admin" : ""), type: "button", disabled: !b.open,
          onclick: function () { foundBiome = b.id; sigs.biomes = ""; fillFound(); } }, [
          el("div", { class: "n", text: b.name + (b.admin ? "  · ADMIN ONLY" : "") }),
          el("div", { class: "b", text: b.open ? b.blurb : "Opens when " + b.at + " colonies are active." })
        ]));
      });
    }
    setText(R.foundBtn, view.cooldown ? "WAIT " + clock(view.cooldown * 1000) : "BREAK GROUND");
  }

  function signOut() {
    api("POST", "logout", {}).catch(function () {});
    session = null; view = null; store("set", null);
    if (alertTimer) { clearInterval(alertTimer); alertTimer = null; }
    menuOpen = false; screen = ""; route();
  }

  /* ---- the game screen --------------------------------------------------------- */
  function tabBtn(id, label) {
    var b = el("button", { class: "dh-tab", type: "button", text: label, onclick: function () { tab = id; applyTabs(); } });
    R.tabs[id] = b; return b;
  }
  function pill(label) { var v = el("span", { class: "v", text: "" }); return { root: el("div", { class: "dh-chip" }, [el("span", { class: "k", text: label }), v]), v: v }; }

  function buildGame() {
    R.tabs = {}; R.panes = {};
    /* top */
    R.stage = el("span", { class: "dh-stage", text: "" });
    R.prog = el("div", { class: "dh-fill" }); R.progT = el("span", { class: "dh-bar-t", text: "" });
    R.wave = el("span", { class: "dh-chip warnchip", text: "" });
    R.top = el("div", { class: "dh-top" }, [
      el("span", { class: "dh-logo sm", text: "DEEPHOLD" }), R.stage,
      el("div", { class: "dh-bar grow" }, [R.prog, R.progT]), R.wave,
      el("button", { class: "dh-menubtn", type: "button", text: "☰ MENU", onclick: function () { menuOpen = true; applyMenu(); } })
    ]);
    /* resources */
    R.res = {};
    var strip = el("div", { class: "dh-resbar" });
    RES.forEach(function (r) {
      var v = el("span", { class: "v", text: "0" }), d = el("span", { class: "d", text: "" });
      var node = el("div", { class: "dh-res", title: RES_NAME[r] }, [el("span", { class: "k", text: RES_NAME[r] }), v, d]);
      R.res[r] = { node: node, v: v, d: d }; strip.appendChild(node);
    });
    /* the picture */
    R.canvas = el("canvas", { class: "dh-canvas", width: "480", height: "360" });
    R.digRow = el("div", { class: "dh-digrow" });
    R.hint = el("div", { class: "dh-hint", text: "Click a plot to build or inspect it. Scroll or drag to look deeper." });
    var jump = el("div", { class: "dh-jump" }, [
      el("button", { class: "dh-mini", type: "button", text: "▲ SURFACE", onclick: function () { if (scene) scene.focus(-1); } }),
      el("button", { class: "dh-mini", type: "button", text: "▼ DEEPEST", onclick: function () { if (scene && view) scene.focus(view.colony.layers - 1); } }),
      el("button", { class: "dh-mini dig", type: "button", text: "⛏ DIG DEEPER", onclick: function () { showDig(); } })
    ]);
    R.sceneBox = el("div", { class: "dh-scenebox" }, [R.canvas, el("div", { class: "dh-scenebar" }, [R.hint, jump]), R.digRow]);
    /* the side */
    R.vitals = el("div", { class: "dh-vitals" });
    R.vit = {};
    [["pop", "PEOPLE"], ["mood", "MOOD"], ["air", "AIR"], ["power", "POWER"], ["crew", "CREW"], ["fun", "FUN"]].forEach(function (p) {
      var bar = el("div", { class: "dh-vbar" }, [el("div", { class: "dh-vfill" })]);
      var val = el("span", { class: "vv", text: "" });
      var row = el("div", { class: "dh-vrow" }, [el("span", { class: "k", text: p[1] }), bar, val]);
      R.vit[p[0]] = { fill: bar.firstChild, val: val, row: row }; R.vitals.appendChild(row);
    });
    R.away = el("div", { class: "dh-note", text: "" });
    R.advice = el("div", { class: "dh-advice" });
    R.pick = el("div", { class: "dh-pick" });
    R.panes.colony = el("div", { class: "dh-pane" }, [R.pick, R.vitals, R.away, el("div", { class: "dh-sec-h", text: "ADVISOR" }), R.advice, R.colLog = el("div", { class: "dh-logs" })]);
    R.panes.ship = el("div", { class: "dh-pane" }, [buildShip()]);
    R.panes.civ = el("div", { class: "dh-pane" }, [buildCiv()]);
    if (view.admin) R.panes.admin = el("div", { class: "dh-pane" }, [buildAdmin()]);
    var tabs = el("div", { class: "dh-tabs" }, [tabBtn("colony", "COLONY"), tabBtn("ship", "SHIPPING"), tabBtn("civ", "CIVILIZATION")].concat(view.admin ? [tabBtn("admin", "ADMIN")] : []));
    R.err = el("div", { class: "dh-note bad", text: "" });
    R.side = el("div", { class: "dh-side" }, [tabs, R.err].concat(Object.keys(R.panes).map(function (k) { return R.panes[k]; })));
    R.over = el("div", { class: "dh-over" });
    R.menu = el("div", { class: "dh-menu" });
    show(R.over, false); show(R.menu, false);
    root.appendChild(R.top); root.appendChild(strip);
    root.appendChild(el("div", { class: "dh-main" }, [R.sceneBox, R.side]));
    root.appendChild(R.over); root.appendChild(R.menu);
    applyTabs();
    /* the picture itself */
    var S = FieldKit.service("colonyScene");
    if (S && R.canvas.getContext) {
      try {
        scene = S.create(R.canvas, { quality: (store("get") || {}).quality || "high", onSelect: function (s, fromClick) { sel = s; if (fromClick && s) tab = "colony"; sigs.pick = ""; applyTabs(); fillPick(); } });
        scene.start();
      } catch (e) { scene = null; }
    }
  }

  function applyTabs() {
    Object.keys(R.tabs).forEach(function (k) { setCls(R.tabs[k], "dh-tab" + (tab === k ? " on" : "")); show(R.panes[k], tab === k); });
  }

  /* shipping */
  var MODE_LABEL = { all: "SEND ALL", surplus: "SEND SURPLUS", lean: "SEND A LITTLE", none: "KEEP ALL" };
  function buildShip() {
    R.shipRows = {};
    var presets = el("div", { class: "dh-row" }, [el("span", { class: "dh-sec-h", text: "EVERYTHING:" })]);
    ["all", "surplus", "lean", "none"].forEach(function (m) {
      presets.appendChild(el("button", { class: "dh-mini wide", type: "button", text: MODE_LABEL[m], title: modeHelp(m), onclick: function () { act("ship", { preset: m }); } }));
    });
    var box = el("div", {}, [
      presets,
      el("div", { class: "dh-note", text: "SEND SURPLUS sends what the colony does not need, and keeps a fund for building. SEND A LITTLE keeps most at home. These rules follow what your colony uses and what the Civilization is asking for, and change by themselves. Pick a percentage on a line to take over by hand." })
    ]);
    RES.forEach(function (r) {
      var sel2 = el("select", { class: "fk-input dh-sel" });
      ["all", "surplus", "lean", "none"].forEach(function (m) { sel2.appendChild(el("option", { value: m, text: MODE_LABEL[m] })); });
      for (var p = 10; p <= 90; p += 10) if (p !== 0) sel2.appendChild(el("option", { value: "p" + p, text: p + "% by hand" }));
      sel2.addEventListener("change", function (e) {
        var v = e.target.value;
        act("ship", { res: r, mode: v.charAt(0) === "p" ? Number(v.slice(1)) : v }, true);
      });
      var rr = { amt: el("span", { class: "a", text: "" }), eff: el("span", { class: "e", text: "" }), ask: el("span", { class: "x", text: "" }), sel: sel2, row: null };
      var row = el("div", { class: "dh-ship" }, [el("span", { class: "r", text: RES_NAME[r] }), rr.amt, rr.eff, sel2, rr.ask]);
      rr.row = row; R.shipRows[r] = rr;
      box.appendChild(row);
      row.insertBefore(rr.eff, sel2); row.appendChild(rr.ask);
    });
    return box;
  }
  function modeHelp(m) {
    return { all: "everything made goes up", surplus: "everything the colony does not need", lean: "a small share, more when the Civ asks", none: "nothing goes up" }[m];
  }

  /* the Civilization */
  function buildCiv() {
    R.civ = { needs: el("div", {}), top: el("div", {}), logs: el("div", {}), war: el("div", {}), where: el("div", { class: "dh-p" }), buffs: el("div", { class: "dh-chips" }), stores: el("div", { class: "dh-chips" }), places: el("div", {}) };
    return el("div", {}, [
      el("div", { class: "dh-sec-h", text: "WHERE WE ARE" }), R.civ.where, R.civ.buffs,
      R.civ.needT = el("div", { class: "dh-sec-h", text: "" }), R.civ.needs,
      R.civ.warT = el("div", { class: "dh-sec-h", text: "THE WAR" }), R.civ.war,
      el("div", { class: "dh-sec-h", text: "CIVILIZATION STORES" }), R.civ.stores,
      el("div", { class: "dh-sec-h", text: "WHO KEEPS US ALIVE" }), R.civ.top,
      el("div", { class: "dh-sec-h", text: "PLACES TO BREAK GROUND" }), R.civ.places,
      el("div", { class: "dh-sec-h", text: "THE LOG" }), R.civ.logs
    ]);
  }

  /* admin */
  function buildAdmin() {
    var sel3 = el("select", { class: "fk-input" });
    for (var i = 0; i < 7; i++) sel3.appendChild(el("option", { value: String(i), text: "stage " + i }));
    var who = el("input", { class: "fk-input", placeholder: "gamertag" });
    var go = function (body, ask) { return function () { if (ask && !window.confirm(ask)) return; act("admin", body); }; };
    R.pauseBtn = ui().button("PAUSE THE GAME", function () { act("admin", { action: "pause", on: !(view && view.paused) }); });
    return el("div", {}, [
      el("div", { class: "dh-sec-h", text: "ADMIN — these change the shared game for everyone and are written in the Civ's log" }),
      el("div", { class: "dh-row" }, [R.pauseBtn]),
      el("div", { class: "dh-row" }, [sel3, ui().button("SET STAGE", function () { go({ action: "setStage", stage: Number(sel3.value) }, "Set the whole Civilization to stage " + sel3.value + "?")(); })]),
      el("div", { class: "dh-row" }, [ui().button("END OCCUPATION", go({ action: "endFall" })), ui().button("CALL WAVE NOW", go({ action: "waveNow" }, "Call the next wave right now?")), ui().button("DELAY WAVE 8H", go({ action: "delayWave", hours: 8 }))]),
      el("div", { class: "dh-row" }, [who, ui().button("MAKE ADMIN", function () { go({ action: "makeAdmin", handle: who.value })(); }), ui().button("REMOVE ADMIN", function () { go({ action: "removeAdmin", handle: who.value })(); }),
        ui().button("REMOVE PLAYER", function () { go({ action: "removePlayer", handle: who.value }, "Remove this gamertag and its colony?")(); }, { danger: true })]),
      el("div", { class: "dh-row" }, [ui().button("RESET THE CIVILIZATION", go({ action: "resetCiv" }, "Reset stage, stores and the war? Colonies stay."), { danger: true })])
    ]);
  }

  /* ---- the pause menu ---------------------------------------------------------- */
  function applyMenu() {
    if (!R.menu) return;
    ui().clear(R.menu);
    show(R.menu, menuOpen);
    if (!menuOpen) return;
    var close = function () { menuOpen = false; applyMenu(); };
    var q = (store("get") || {}).quality || "high";
    var kids = [
      el("div", { class: "dh-logo sm", text: "MENU" }),
      ui().button("RESUME", close, { primary: true }),
      el("div", { class: "dh-note", text: "Your colony keeps running while this is open. Signed in as " + (session ? session.tag : "?") + "." }),
      el("div", { class: "dh-row" }, [el("span", { class: "dh-dim", text: "PICTURE:" })].concat(["high", "low", "off"].map(function (m) {
        return el("button", { class: "dh-mini wide" + (q === m ? " on" : ""), type: "button", text: m.toUpperCase(), onclick: function () {
          var s = store("get") || {}; s.quality = m; store("set", s);
          if (m === "off") { if (scene) { scene.destroy(); scene = null; } show(R.canvas, false); } else { show(R.canvas, true); if (scene) scene.setQuality(m); else { screen = ""; route(); } }
          applyMenu();
        } });
      }))),
      el("div", { class: "dh-note", text: "HOW IT WORKS: buildings make things, lifts carry what you choose to send up to the Civilization, and the Civilization unlocks new buildings for everyone. Keep your people breathing, fed and entertained. From stage 2 a war arrives in waves: arms and guns hold it." })
    ];
    if (view && view.admin) kids.push(ui().button(view.paused ? "RESUME THE GAME FOR EVERYONE" : "PAUSE THE GAME FOR EVERYONE", function () { act("admin", { action: "pause", on: !view.paused }); close(); }, { danger: !view.paused }));
    kids.push(ui().button("ABANDON THIS COLONY", function () { if (window.confirm("Abandon your colony and start again? What you gave the Civilization stays given.")) { act("abandon", { confirm: true }); close(); } }, { danger: true }));
    kids.push(ui().button("SIGN OUT OF DEEPHOLD", function () { close(); signOut(); }));
    R.menu.appendChild(el("div", { class: "dh-menubox" }, kids));
  }

  /* ---- putting a new view on the screen ----------------------------------------- */
  function applyView() {
    if (gone || !host) return;
    var want = !session ? "auth" : !view ? "wait" : (!view.colony || view.colony.collapsed) ? "found" : "game";
    if (want !== screen) { route(); return; }
    if (screen === "found") { fillFound(); return; }
    if (screen !== "game") return;
    var c = view.colony, civ = view.civ;
    setText(R.err, lastErr);
    setText(R.stage, "STAGE " + civ.stage + " · " + civ.name);
    if (view.admin && !R.panes.admin) { screen = ""; route(); return; }
    if (scene) scene.setView(view, c.name);
    fillCivilization();
    fillShip();
    fillAdvice();
    fillPick();
    fillVitals();
    if (R.pauseBtn) setText(R.pauseBtn, view.paused ? "RESUME THE GAME" : "PAUSE THE GAME");
    applyMenu();
    tick();
  }

  function fillVitals() {
    var c = view.colony, s = c.stats || {};
    var set = function (k, frac, text, cls) { var v = R.vit[k]; v.fill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%"; setText(v.val, text); setCls(v.row, "dh-vrow " + (cls || "")); };
    var pop = c.pop;
    set("pop", s.housing ? pop / s.housing : 0, pop + " / " + (s.housing || "?"), pop >= (s.housing || 0) ? "warn" : "");
    set("mood", c.hap / 100, c.hap + "%", c.hap < 25 ? "bad" : c.hap < 50 ? "warn" : "ok");
    var air = s.air || [0, pop], pw = s.power || [0, 0], cr = s.staff || [0, 0], en = s.ent || [0, pop];
    set("air", pop ? air[0] / pop : 1, air[0] + " / " + pop, air[0] < pop ? "bad" : "ok");
    set("power", pw[1] ? pw[0] / pw[1] : 1, pw[0] + " / " + pw[1], pw[0] < pw[1] ? "warn" : "ok");
    set("crew", cr[1] ? cr[0] / cr[1] : 1, cr[0] + " / " + cr[1], cr[0] < cr[1] ? "warn" : "ok");
    set("fun", pop ? en[0] / pop : 1, en[0] + " / " + pop, en[0] < pop ? "warn" : "ok");
    var note = c.frozen ? "PAUSED: you were away for over a week. Everything resumes now." :
      c.safe ? "YOU ARE AWAY. The colony keeps working and what it ships reaches the Civilization in full. You keep 30% of what you would have, and nobody here can die." : "";
    if (c.repair != null) note += (note ? " " : "") + "GARRISON REPAIRED " + Math.floor(c.repair) + "%: every building you raise restores more of it.";
    setText(R.away, note); show(R.away, !!note);
    var logs = jsonSig(c.log);
    if (sigs.colLog !== logs) { sigs.colLog = logs; ui().clear(R.colLog); c.log.slice(0, 4).forEach(function (l) { R.colLog.appendChild(el("div", { class: "dh-log", text: l.text })); }); }
  }

  function fillAdvice() {
    var c = view.colony, sig = jsonSig(c.advice) + jsonSig(c.grid.length);
    if (sigs.advice === sig) return;
    sigs.advice = sig; ui().clear(R.advice);
    if (!c.advice.length) R.advice.appendChild(el("div", { class: "dh-note", text: "Nothing needs doing. Keep building, or dig deeper." }));
    c.advice.forEach(function (a) {
      var kids = [el("span", { class: "dh-adv-t", text: a.text })];
      if (a.build) {
        var b = find(a.build);
        kids.push(el("button", { class: "dh-mini wide", type: "button", text: "BUILD " + b.name, title: costText(b.cost), onclick: function () { quickBuild(a.build); } }));
      } else if (a.id === "dig" || a.id === "room") {
        kids.push(el("button", { class: "dh-mini wide", type: "button", text: "⛏ SHOW THE DIG SITE", onclick: function () { showDig(); } }));
      } else if (a.ship && a.ship.res) {
        kids.push(el("button", { class: "dh-mini wide", type: "button", text: "SET " + RES_NAME[a.ship.res] + " TO SURPLUS", onclick: function () { act("ship", { res: a.ship.res, mode: a.ship.mode }, true); } }));
      } else if (a.res) {
        kids.push(el("button", { class: "dh-mini wide", type: "button", text: "SEND " + RES_NAME[a.res], onclick: function () { tab = "ship"; applyTabs(); } }));
      }
      R.advice.appendChild(el("div", { class: "dh-adv " + a.sev }, kids));
    });
  }

  /* the dig site: scroll the picture to it and open its card */
  function showDig() {
    if (!view || !view.colony) return;
    tab = "colony";
    if (scene) { scene.focus(view.colony.layers); scene.select("dig", null, true); }
    else { sel = { dig: true }; sigs.pick = ""; applyTabs(); fillPick(); }
  }
  function digCard(c) {
    var close = function () { sel = null; if (scene) scene.sel = null; sigs.pick = ""; fillPick(); };
    var nextL = c.layers + 1, kids = [];
    var deeper = view.catalog.filter(function (b) { return !b.locked && b.minLayer === c.layers; }).map(function (b) { return b.name; });
    kids.push(el("div", { class: "dh-card-h" }, [el("b", { text: c.dig ? "DIGGING LAYER " + nextL : c.layers >= view.constants.maxLayers ? "THE BOTTOM" : !c.digCost ? "LAYER " + nextL + " — NOT OPEN YET" : "DIG LAYER " + nextL }), ui().button("CLOSE", close)]));
    if (c.dig) {
      var left = Math.max(0, c.dig.left * 1000 - (Date.now() - viewAt)), tot = Math.max(1, c.dig.total * 1000);
      R.digCardBar = el("div", { class: "dh-vfill" }); R.digCardBar.style.width = Math.round(100 * (1 - left / tot)) + "%";
      R.digCardT = el("div", { class: "dh-note", text: clock(left) + " left. The rig keeps going while you are away." });
      kids.push(el("div", { class: "dh-vbar big" }, [R.digCardBar]), R.digCardT);
    } else if (c.layers >= view.constants.maxLayers) {
      kids.push(el("div", { class: "dh-p", text: "This is as deep as anyone can dig." }));
    } else if (!c.digCost) {
      var need = c.layers - 1, nx = view.civ.next;
      kids.push(el("div", { class: "dh-p", text: "Layer " + nextL + " opens when the Civilization reaches stage " + need + (nx && view.civ.stage + 1 === need ? " (" + nx.name + ")" : "") + ". Ship it what it asks for and it will grow." }));
      kids.push(el("div", { class: "dh-row" }, [ui().button("OPEN SHIPPING", function () { tab = "ship"; applyTabs(); })]));
    } else {
      var ok = afford(c.digCost);
      var missing = Object.keys(c.digCost).filter(function (r) { return liveStock(r) < c.digCost[r]; }).map(function (r) { return Math.ceil(c.digCost[r] - liveStock(r)) + " more " + RES_NAME[r].toLowerCase(); }).join(", ");
      kids.push(el("div", { class: "dh-p", text: "A rig cuts a new tunnel below your deepest one: 8 more plots to build on, and richer ground the deeper you go." + (deeper.length ? " Opens up: " + deeper.join(", ") + "." : "") }));
      kids.push(el("div", { class: "dh-note", text: "COST " + costText(c.digCost) + " · TAKES " + clock(c.digSeconds * 1000) }));
      var digB = ui().button(ok ? "⛏ DIG LAYER " + nextL : "NEED " + missing.toUpperCase(), function () { if (afford(c.digCost)) act("dig"); }, { primary: ok });
      digB.disabled = !ok;
      kids.push(el("div", { class: "dh-row" }, [digB]));
    }
    R.pick.appendChild(el("div", { class: "dh-card digcard" }, kids));
  }

  /* the nearest free plot a building may go in, then build */
  function quickBuild(id) {
    var c = view.colony, b = find(id), best = null;
    for (var l = (b.minLayer || 0); l < c.grid.length && !best; l++) for (var s = 0; s < c.grid[l].length && !best; s++) if (!c.grid[l][s]) best = [l, s];
    if (!best) { ui().toast("NO FREE PLOT FOR THAT: DIG DEEPER", "warn"); return; }
    act("build", { layer: best[0], slot: best[1], type: id });
    if (scene) { scene.focus(best[0]); }
  }

  /* what is selected: a plot's detail, or what could go there */
  function fillPick() {
    if (!R.pick || !view || !view.colony) return;
    var c = view.colony;
    var cell = sel && c.grid[sel.layer] ? c.grid[sel.layer][sel.slot] : null;
    var rec = (c.recommend || []).join(",");
    var sig = jsonSig([sel, cell, buildCat, rec, c.layers, sel && sel.dig ? [!!c.dig, c.digCost, c.digCost && afford(c.digCost)] : 0]) + (sel && !cell ? Object.keys(find("bunk")).length + view.catalog.map(function (b) { return b.id + (b.locked ? "L" : afford(b.cost) ? "Y" : "N"); }).join("") : "");
    if (sigs.pick === sig) return;
    sigs.pick = sig; ui().clear(R.pick);
    if (!sel) return;
    if (sel.dig) { digCard(c); return; }
    var close = function () { sel = null; if (scene) scene.sel = null; sigs.pick = ""; fillPick(); };
    if (cell) {
      var b = find(cell.t), st = scene ? FieldKit.service("colonyScene").statusOf(view, (function () { var o = {}; view.catalog.forEach(function (x) { o[x.id] = x; }); return o; })(), cell) : { text: "" };
      R.pick.appendChild(el("div", { class: "dh-card" }, [
        el("div", { class: "dh-card-h" }, [el("b", { text: b.name }), el("span", { class: "dh-st " + (st.level || ""), text: st.text || (cell.on ? "RUNNING" : "PAUSED") })]),
        el("div", { class: "dh-p", text: b.blurb }),
        el("div", { class: "dh-note", text: ioText(b) }),
        el("div", { class: "dh-row" }, [
          ui().button(cell.on ? "PAUSE" : "RESUME", function () { act("toggle", { layer: sel.layer, slot: sel.slot }); }),
          ui().button("DEMOLISH (50% BACK)", function () { var p = sel; close(); act("demolish", { layer: p.layer, slot: p.slot }); }, { danger: true }),
          ui().button("CLOSE", close)
        ])
      ]));
      return;
    }
    /* an empty plot: the build menu, by what you need */
    var cats = view.cats.filter(function (k) { return view.catalog.some(function (b) { return b.cat === k.id && !b.locked; }); });
    var rank = {}; (c.recommend || []).forEach(function (id, i) { rank[id] = i + 1; });
    var anyRec = cats.filter(function (k) { return view.catalog.some(function (b) { return b.cat === k.id && rank[b.id]; }); })[0];
    var cur = buildCat && cats.some(function (k) { return k.id === buildCat; }) ? buildCat : (anyRec || cats[0] || {}).id;
    var head = el("div", { class: "dh-cats" });
    cats.forEach(function (k) {
      var has = view.catalog.some(function (b) { return b.cat === k.id && rank[b.id]; });
      head.appendChild(el("button", { class: "dh-cat" + (cur === k.id ? " on" : ""), type: "button", text: (has ? "★ " : "") + k.name, onclick: function () { buildCat = k.id; sigs.pick = ""; fillPick(); } }));
    });
    var list = el("div", { class: "dh-opts" });
    var items = view.catalog.filter(function (b) { return b.cat === cur; }).sort(function (x, y) { return (rank[x.id] || 99) - (rank[y.id] || 99); });
    items.forEach(function (b) {
      if (b.locked) { list.appendChild(el("div", { class: "dh-opt locked" }, [el("div", { class: "n", text: b.name }), el("div", { class: "b", text: "Opens at stage " + b.stage })])); return; }
      var why = "";
      if (b.minLayer > sel.layer) why = "needs layer " + (b.minLayer + 1) + " or deeper";
      else if (b.repair && c.repair < b.repair) why = "garrison must be " + b.repair + "% repaired";
      else if (b.max && countOf(c, b.id) >= b.max) why = "limit " + b.max + " reached";
      var ok = !why && afford(b.cost);
      var missing = Object.keys(b.cost).filter(function (r) { return liveStock(r) < b.cost[r]; }).map(function (r) { return Math.ceil(b.cost[r] - liveStock(r)) + " more " + RES_NAME[r].toLowerCase(); }).join(", ");
      list.appendChild(el("button", { class: "dh-opt" + (rank[b.id] ? " rec" : "") + (ok ? "" : " no"), type: "button", disabled: !!why,
        onclick: function () { var p = sel; sel = null; if (scene) scene.sel = null; sigs.pick = ""; act("build", { layer: p.layer, slot: p.slot, type: b.id }); } }, [
        el("div", { class: "n", text: (rank[b.id] ? "★ " : "") + b.name + (why ? "  — " + why : ok ? "" : "  — need " + missing) }),
        el("div", { class: "b", text: b.blurb }),
        el("div", { class: "c", text: "COST " + costText(b.cost) }),
        el("div", { class: "c dim", text: ioText(b) })
      ]));
    });
    R.pick.appendChild(el("div", { class: "dh-card" }, [
      el("div", { class: "dh-card-h" }, [el("b", { text: "BUILD — layer " + (sel.layer + 1) + ", plot " + (sel.slot + 1) }), ui().button("CANCEL", close)]),
      head, list
    ]));
  }
  function ioText(b) {
    var io = [];
    if (b.inp) io.push("uses " + Object.keys(b.inp).map(function (r) { return b.inp[r] + "/s " + RES_NAME[r].toLowerCase(); }).join(", "));
    if (b.out) io.push("makes " + Object.keys(b.out).map(function (r) { return b.out[r] + "/s " + RES_NAME[r].toLowerCase(); }).join(", "));
    if (b.housing) io.push("houses " + b.housing); if (b.ent) io.push("entertains " + b.ent); if (b.air) io.push("air for " + b.air);
    if (b.def) io.push("defence +" + b.def); if (b.heal) io.push("heals"); if (b.lift) io.push("lifts " + b.lift + "/s");
    io.push((b.power > 0 ? "+" : b.power < 0 ? "−" : "") + Math.abs(b.power || 0) + " power", (b.staff || 0) + " crew");
    return io.join(" · ");
  }

  function fillShip() {
    var c = view.colony, civ = view.civ;
    RES.forEach(function (r) {
      var row = R.shipRows[r], m = c.ship[r];
      var want = typeof m === "number" ? "p" + (Math.round(m / 10) * 10 || 10) : m;
      if (typeof m === "number" && !row.sel.querySelector('option[value="' + want + '"]')) want = "p50";
      if (row.sel.value !== want && (typeof document === "undefined" || document.activeElement !== row.sel)) row.sel.value = want;
      setText(row.eff, "≈ " + (c.eff[r] || 0) + "% up");
      var asked = civ.asks && civ.asks[r];
      setText(row.ask, asked ? "THE CIV ASKS FOR THIS" : (c.shipped[r] ? "sent " + n(c.shipped[r]) : ""));
      setCls(row.row, "dh-ship" + (asked ? " asked" : ""));
    });
  }

  function needRows(into, need, progress, key) {
    var sig = jsonSig(Object.keys(need)) + key;
    if (sigs[key] !== sig) {
      sigs[key] = sig; ui().clear(into); R[key] = {};
      Object.keys(need).forEach(function (r) {
        var f = el("div", { class: "dh-fill" }), t = el("span", { class: "dh-bar-t", text: "" });
        into.appendChild(el("div", { class: "dh-need" }, [el("span", { class: "r", text: RES_NAME[r] }), el("div", { class: "dh-bar" }, [f, t])]));
        R[key][r] = { f: f, t: t };
      });
    }
  }
  function paintNeeds(key, need, progress, flow, dt) {
    Object.keys(need).forEach(function (r) {
      var ref = R[key] && R[key][r]; if (!ref) return;
      var got = Math.min(need[r], (progress[r] || 0) + (flow[r] || 0) * dt);
      ref.f.style.width = Math.round(got / need[r] * 100) + "%";
      setText(ref.t, n(got) + " / " + n(need[r]));
    });
  }

  function fillCivilization() {
    var civ = view.civ, K = R.civ;
    setText(K.where, "STAGE " + civ.stage + " — " + civ.name + ". " + civ.text);
    var chips = jsonSig([civ.buffs, civ.brownout, civ.strain]);
    if (sigs.buffs !== chips) {
      sigs.buffs = chips; ui().clear(K.buffs);
      var chip = function (k, v, cls) { return el("div", { class: "dh-chip " + (cls || "") }, [el("span", { class: "k", text: k }), el("span", { class: "v", text: v })]); };
      K.buffs.appendChild(chip("OUTPUT", "+" + Math.round(civ.buffs.yield * 100) + "%")); K.buffs.appendChild(chip("DEFENCE", "+" + Math.round(civ.buffs.def * 100) + "%"));
      K.buffs.appendChild(chip("UPKEEP", civ.brownout ? "UNPAID" : civ.strain > 20 ? "BEHIND" : "PAID", civ.brownout ? "bad" : civ.strain > 20 ? "warn" : "ok"));
    }
    if (civ.fallen) { setText(K.needT, "LIBERATION: the Civilization must be won back"); needRows(K.needs, civ.liberation.need, civ.liberation.progress, "nd"); }
    else if (civ.next) { setText(K.needT, "NEXT: " + civ.next.name + " — " + civ.next.text); needRows(K.needs, civ.next.need, civ.next.progress, "nd"); }
    else { setText(K.needT, "NO FURTHER STAGE YET"); needRows(K.needs, {}, {}, "nd"); }
    show(K.warT, !!civ.war); show(K.war, !!civ.war);
    var st = jsonSig([civ.stock, civ.top, civ.log, view.biomes, civ.war && [civ.war.wins, civ.war.losses, civ.war.strength]]);
    if (sigs.civ !== st) {
      sigs.civ = st;
      ui().clear(K.stores); RES.filter(function (r) { return civ.stock[r] > 0; }).forEach(function (r) { K.stores.appendChild(el("div", { class: "dh-chip" }, [el("span", { class: "k", text: RES_NAME[r] }), el("span", { class: "v", text: n(civ.stock[r]) })])); });
      ui().clear(K.top); civ.top.forEach(function (t) { K.top.appendChild(el("div", { class: "dh-log" + (t.me ? " me" : ""), text: t.name + " — " + n(t.v) + " worth" })); });
      ui().clear(K.places); view.biomes.forEach(function (b) { K.places.appendChild(el("div", { class: "dh-log" + (b.open ? "" : " dim"), text: b.name + (b.open ? " — open" : " — opens at " + b.at + " active colonies") })); });
      ui().clear(K.logs); civ.log.forEach(function (l) { K.logs.appendChild(el("div", { class: "dh-log", text: l.text })); });
      if (civ.war) {
        ui().clear(K.war);
        K.warText = el("div", { class: "dh-p", text: "" }); K.defBar = el("div", { class: "dh-fill" }); K.defT = el("span", { class: "dh-bar-t", text: "" });
        K.wallBar = el("div", { class: "dh-fill" }); K.wallT = el("span", { class: "dh-bar-t", text: "" });
        K.war.appendChild(K.warText); K.war.appendChild(el("div", { class: "dh-bar" }, [K.defBar, K.defT])); K.war.appendChild(el("div", { class: "dh-bar" }, [K.wallBar, K.wallT]));
        K.war.appendChild(el("div", { class: "dh-note", text: "Defence is every ARMS stored plus gun emplacements. Waves held: " + civ.war.wins + ". Lost: " + civ.war.losses + ". A wave you cannot meet spends all the arms and cracks the wall; if the wall breaks, the Civilization falls." }));
      }
    }
  }

  /* ---- between visits: the clock and the stocks ----------------------------------- */
  function tick() {
    if (gone || !view || screen !== "game") return;
    var c = view.colony, civ = view.civ, dt = Math.min(90, (Date.now() - viewAt) / 1000), nowS = view.now + (Date.now() - viewAt);
    RES.forEach(function (r) {
      var ref = R.res[r], v = liveStock(r), net = c.rate[r] || 0, cap = view.constants.stockCap;
      setText(ref.v, n1(v));
      setText(ref.d, Math.abs(net) < 0.0005 ? "" : rateText(net) + "/s");
      var low = v < 25 && net <= 0 && (c.use[r] || 0) > 0, full = v >= cap * 0.98;
      setCls(ref.node, "dh-res" + (low ? " low" : full ? " full" : net < -0.0005 ? " down" : ""));
    });
    var frac = 0, label = "NO FURTHER STAGE YET";
    if (civ.fallen) { var Lb = civ.liberation, tt = 0, gg = 0; Object.keys(Lb.need).forEach(function (r) { tt += Lb.need[r]; gg += Math.min(Lb.need[r], (Lb.progress[r] || 0) + (civ.flow[r] || 0) * dt); }); frac = tt ? gg / tt : 0; label = "OCCUPIED — LIBERATION " + Math.round(frac * 100) + "%"; }
    else if (civ.next) { var t2 = 0, g2 = 0; Object.keys(civ.next.need).forEach(function (r) { t2 += civ.next.need[r]; g2 += Math.min(civ.next.need[r], (civ.next.progress[r] || 0) + (civ.flow[r] || 0) * dt); }); frac = t2 ? g2 / t2 : 0; label = "TO " + civ.next.name + " — " + (Math.floor(frac * 1000) / 10) + "%"; }
    R.prog.style.width = Math.round(frac * 100) + "%"; setText(R.progT, label);
    var wv = civ.war && civ.war.at ? civ.war.at - nowS : null;
    setText(R.wave, view.paused ? "PAUSED" : wv != null ? (wv < 600000 ? "WAVE IN " : "NEXT WAVE ") + clock(wv) : "");
    setCls(R.wave, "dh-chip warnchip" + (view.paused ? " bad" : wv != null && wv < 600000 ? " bad" : ""));
    show(R.wave, view.paused || wv != null);
    if (civ.next && R.nd) paintNeeds("nd", civ.next.need, civ.next.progress, civ.flow, dt);
    else if (civ.fallen && R.nd) paintNeeds("nd", civ.liberation.need, civ.liberation.progress, civ.flow, dt);
    if (civ.war && R.civ.warText) {
      var w = civ.war, g = w.strength ? Math.min(1, w.defence / w.strength) : 0;
      setText(R.civ.warText, w.at ? "The next wave arrives in " + clock(w.at - nowS) + ", strength " + n(w.strength) + "." : "The Consortium is gathering.");
      R.civ.defBar.style.width = Math.round(g * 100) + "%"; setText(R.civ.defT, w.strength ? "DEFENCE " + n(w.defence) + " / " + n(w.strength) : "DEFENCE " + n(w.defence));
      R.civ.wallBar.style.width = Math.max(0, 100 - w.breach) + "%"; setText(R.civ.wallT, "THE WALL " + Math.max(0, 100 - w.breach) + "% STANDING");
    }
    RES.forEach(function (r) { if (R.shipRows[r]) setText(R.shipRows[r].amt, n(liveStock(r))); });
    /* digging: a countdown and a button, made once and kept */
    var key = c.dig ? "d" : c.digCost ? "c" : "x";
    if (R.digKey !== key) {
      R.digKey = key; ui().clear(R.digRow);
      if (c.dig) { R.digT = el("span", { class: "dh-dig", text: "" }); R.digRow.appendChild(R.digT); }
      else if (c.digCost) { R.digBtn = ui().button("DIG LAYER " + (c.layers + 1), function () { act("dig"); }, { primary: true }); R.digInfo = el("span", { class: "dh-note", text: "" }); R.digRow.appendChild(R.digBtn); R.digRow.appendChild(R.digInfo); }
      else if (c.layers < view.constants.maxLayers) R.digRow.appendChild(el("span", { class: "dh-note", text: "LAYER " + (c.layers + 1) + " OPENS AT CIVILIZATION STAGE " + (c.layers - 1) + "." }));
    }
    if (c.dig && R.digCardBar) { var dl = Math.max(0, c.dig.left * 1000 - (Date.now() - viewAt)); R.digCardBar.style.width = Math.round(100 * (1 - dl / Math.max(1, c.dig.total * 1000))) + "%"; setText(R.digCardT, clock(dl) + " left. The rig keeps going while you are away."); }
    if (c.dig && R.digT) setText(R.digT, "DIGGING LAYER " + (c.layers + 1) + " — " + clock(Math.max(0, c.dig.left * 1000 - (Date.now() - viewAt))) + " left");
    if (!c.dig && c.digCost && R.digInfo) {
      setText(R.digInfo, costText(c.digCost) + " · " + clock(c.digSeconds * 1000));
    }
    show(R.over, !!view.paused);
    if (view.paused && !R.over.firstChild) R.over.appendChild(el("div", { class: "dh-overbox", text: "GAME PAUSED BY AN ADMIN. Nothing runs until it resumes." }));
    if (!view.paused && R.over.firstChild) ui().clear(R.over);
  }

  /* ---- styles ---------------------------------------------------------------------- */
  function css() {
    if (document.getElementById("dh-style")) return;
    var s = document.createElement("style"); s.id = "dh-style";
    s.textContent = [
      ".dh{position:relative;display:flex;flex-direction:column;gap:6px;font-size:11px;height:100%;overflow:hidden}",
      ".dh .dim,.dh .dh-dim{color:var(--fg-dimmer)}.dh .bad{color:var(--fail)}.dh .warn{color:var(--warn)}.dh .ok{color:var(--pass)}",
      ".dh-center{max-width:460px;margin:24px auto;display:flex;flex-direction:column;gap:10px;overflow:auto}.dh-center.wide{max-width:760px}",
      ".dh-logo{letter-spacing:.3em;color:var(--accent);font-size:16px}.dh-logo.sm{font-size:12px}",
      ".dh-p{line-height:1.55;margin:0}.dh-note{font-size:10px;line-height:1.5;color:var(--fg-dimmer)}",
      ".dh-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
      ".dh-top{display:flex;gap:10px;align-items:center;border:1px solid var(--line2);padding:5px 8px;background:rgba(0,0,0,.25)}",
      ".dh-stage{letter-spacing:.12em;white-space:nowrap}.dh-menubtn{font:inherit;font-size:10px;letter-spacing:.12em;background:none;border:1px solid var(--line2);color:var(--fg-dim);padding:4px 9px;cursor:pointer}",
      ".dh-menubtn:hover{border-color:var(--accent);color:var(--accent)}",
      ".dh-bar{position:relative;height:16px;border:1px solid var(--line2);background:rgba(0,0,0,.35);min-width:80px}.dh-bar.grow{flex:1}",
      ".dh-fill{height:100%;background:var(--accent);opacity:.55;width:0;transition:width .6s linear}.dh-bar-t{position:absolute;left:6px;top:2px;font-size:9px;letter-spacing:.08em}",
      ".dh-chip{border:1px solid var(--line2);padding:2px 7px;display:flex;gap:6px;align-items:baseline;font-size:10px;letter-spacing:.06em}.dh-chip.bad{border-color:var(--fail);color:var(--fail)}",
      ".dh-chip .k{font-size:8px;letter-spacing:.12em;color:var(--fg-dimmer)}.dh-chip .v{font-size:12px}",
      ".dh-resbar{display:grid;grid-template-columns:repeat(9,1fr);gap:4px}",
      ".dh-res{border:1px solid var(--line2);background:rgba(0,0,0,.2);padding:3px 5px;display:flex;flex-direction:column;line-height:1.25;min-width:0}",
      ".dh-res .k{font-size:7px;letter-spacing:.14em;color:var(--fg-dimmer)}.dh-res .v{font-size:13px}.dh-res .d{font-size:8px;color:var(--pass);min-height:10px}",
      ".dh-res.down .d{color:var(--warn)}.dh-res.low{border-color:var(--fail)}.dh-res.low .d,.dh-res.low .v{color:var(--fail)}.dh-res.full .v{color:var(--warn)}",
      ".dh-main{display:flex;gap:8px;flex:1;min-height:0;flex-wrap:wrap}",
      ".dh-scenebox{flex:1 1 440px;min-width:300px;display:flex;flex-direction:column;gap:4px}",
      ".dh-canvas{width:100%;aspect-ratio:480/360;image-rendering:pixelated;border:1px solid var(--line2);background:#07090c;display:block;cursor:grab}",
      ".dh-scenebar{display:flex;justify-content:space-between;gap:8px;align-items:center}.dh-hint{font-size:9px;color:var(--fg-dimmer)}",
      ".dh-jump{display:flex;gap:4px;flex-wrap:wrap}.dh-mini.dig{border-color:var(--accent);color:var(--accent)}.dh-vbar.big{height:8px;margin:6px 0}",
      ".dh-digrow{display:flex;gap:8px;align-items:center;min-height:26px}.dh-dig{letter-spacing:.1em;color:var(--accent)}",
      ".dh-side{flex:0 1 340px;min-width:280px;display:flex;flex-direction:column;gap:6px;min-height:0;overflow:hidden}",
      ".dh-tabs{display:flex;gap:4px;flex-wrap:wrap}.dh-tab{font:inherit;font-size:10px;letter-spacing:.12em;background:none;color:var(--fg-dim);border:1px solid var(--line2);padding:4px 9px;cursor:pointer}",
      ".dh-tab.on{border-color:var(--accent);color:var(--accent)}",
      ".dh-pane{overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;padding-right:2px}",
      ".dh-sec-h{font-size:9px;letter-spacing:.18em;color:var(--accent);margin-top:4px}",
      ".dh-vrow{display:grid;grid-template-columns:54px 1fr 58px;gap:6px;align-items:center}.dh-vrow .k{font-size:8px;letter-spacing:.12em;color:var(--fg-dimmer)}",
      ".dh-vbar{height:8px;border:1px solid var(--line2);background:rgba(0,0,0,.35)}.dh-vfill{height:100%;background:var(--pass);opacity:.7;width:0;transition:width .6s linear}",
      ".dh-vrow.warn .dh-vfill{background:var(--warn)}.dh-vrow.bad .dh-vfill{background:var(--fail)}.dh-vrow .vv{font-size:10px;text-align:right}",
      ".dh-adv{border:1px solid var(--line2);padding:5px 7px;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;justify-content:space-between;background:rgba(0,0,0,.18)}.dh-adv .dh-mini{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto}",
      ".dh-adv.bad{border-color:var(--fail)}.dh-adv.warn{border-color:var(--warn)}.dh-adv-t{line-height:1.4;font-size:10px;flex:1 1 170px;min-width:0}",
      ".dh-mini{font:inherit;font-size:9px;letter-spacing:.08em;min-width:22px;height:20px;background:none;border:1px solid var(--line2);color:var(--fg-dim);cursor:pointer;padding:0 6px;white-space:nowrap}",
      ".dh-mini:hover{border-color:var(--accent);color:var(--accent)}.dh-mini.on{border-color:var(--accent);color:var(--accent)}",
      ".dh-card{border:1px solid var(--accent);padding:7px;display:flex;flex-direction:column;gap:6px;background:rgba(0,0,0,.25)}",
      ".dh-card-h{display:flex;justify-content:space-between;align-items:center;gap:8px}.dh-st{font-size:9px;letter-spacing:.1em}.dh-st.ok{color:var(--pass)}.dh-st.warn{color:var(--warn)}.dh-st.bad{color:var(--fail)}",
      ".dh-cats{display:flex;gap:4px;flex-wrap:wrap}.dh-cat{font:inherit;font-size:9px;letter-spacing:.08em;background:none;color:var(--fg-dim);border:1px solid var(--line2);padding:3px 7px;cursor:pointer}.dh-cat.on{border-color:var(--accent);color:var(--accent)}",
      ".dh-opts{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow-y:auto}",
      ".dh-opt{font:inherit;text-align:left;border:1px solid var(--line2);background:rgba(0,0,0,.25);color:var(--fg);padding:5px 7px;cursor:pointer;display:flex;flex-direction:column;gap:2px}",
      ".dh-opt:hover:not(:disabled){border-color:var(--accent)}.dh-opt.rec{border-color:var(--accent)}.dh-opt.no{opacity:.6}.dh-opt.locked{opacity:.4;cursor:default}.dh-opt:disabled{opacity:.35;cursor:not-allowed}",
      ".dh-opt .n{font-size:10px;letter-spacing:.08em}.dh-opt .b{font-size:9px;color:var(--fg-dimmer);line-height:1.4}.dh-opt .c{font-size:9px}",
      ".dh-ship{display:grid;grid-template-columns:50px 38px 56px 1fr;gap:4px;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)}",
      ".dh-ship .r{font-size:9px;letter-spacing:.1em}.dh-ship.asked .r{color:var(--accent)}.dh-ship .e{font-size:9px;color:var(--fg-dimmer)}.dh-ship .x{grid-column:1/-1;font-size:8px;letter-spacing:.08em;color:var(--accent)}",
      ".dh-ship .dh-sel{font-size:10px;padding:2px;min-width:0}.dh-ship .a{font-size:11px}",
      ".dh-need{display:grid;grid-template-columns:60px 1fr;gap:6px;align-items:center;margin:2px 0}.dh-need .r{font-size:9px;letter-spacing:.1em}",
      ".dh-chips{display:flex;gap:5px;flex-wrap:wrap}.dh-log{font-size:10px;line-height:1.5;padding:1px 0}.dh-log.me{color:var(--accent)}",
      ".dh-biomes{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px}",
      ".dh-biome{font:inherit;text-align:left;border:1px solid var(--line2);background:rgba(0,0,0,.25);color:var(--fg);padding:8px;cursor:pointer}",
      ".dh-biome.on{border-color:var(--accent)}.dh-biome.locked{opacity:.4;cursor:not-allowed}.dh-biome.admin .n{color:var(--warn)}",
      ".dh-biome .n{letter-spacing:.12em;font-size:10px;margin-bottom:3px}.dh-biome .b{font-size:9px;color:var(--fg-dimmer);line-height:1.4}",
      ".dh-over,.dh-menu{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.68);z-index:30;padding:14px}",
      ".dh-over{pointer-events:none}.dh-menu{z-index:40}",
      ".dh-overbox{border:1px solid var(--warn);color:var(--warn);padding:14px 18px;letter-spacing:.14em;background:rgba(0,0,0,.8);text-align:center}",
      ".dh-menubox{border:1px solid var(--line2);background:var(--bg2);padding:14px;max-width:420px;width:100%;display:flex;flex-direction:column;gap:8px;max-height:100%;overflow:auto}",
      "@media(max-width:760px){.dh-resbar{grid-template-columns:repeat(5,1fr)}.dh-side{flex-basis:100%}}"
    ].join("\n");
    document.head.appendChild(s);
  }

  /* The panel draws what the relay says, so what can break on its own is
     small: the words for things, and the clock. */
  function selfcheck() {
    return [
      { name: "EVERY RESOURCE HAS A NAME ON SCREEN", critical: false, run: function () {
        var missing = RES.filter(function (r) { return !RES_NAME[r]; });
        if (missing.length) throw new Error("no name for: " + missing.join(", "));
        return RES.length + " resources named";
      } },
      { name: "TIMES AND AMOUNTS READ PLAINLY", critical: false, run: function () {
        if (clock(3725000) !== "1h 2m" || clock(125000) !== "2m 5s" || clock(9000) !== "9s") throw new Error("clock() is wrong: " + clock(3725000) + " / " + clock(125000));
        if (n(1234) !== "1234" || n(25000) !== "25k" || n(150000) !== "150k") throw new Error("n() is wrong: " + n(25000));
        return "1h 2m, 2m 5s, 25k";
      } }
    ];
  }

  FieldKit.provide("deephold", {
    signedIn: function () { return !!session; },
    tag: function () { return session ? session.tag : null; },
    signOut: function () { if (session) { api("POST", "logout", {}).catch(function () {}); } session = null; store("set", null); FieldKit.emit("deephold:signout", {}); },
    /* the gamertag is shared by FieldKit's games (POOL HALL signs in with it too) */
    session: function () { return session ? { token: session.token, tag: session.tag } : null; },
    adopt: function (s, keep) {
      if (!s || !s.token || !s.tag) return;
      session = { token: s.token, tag: s.tag }; remember(keep !== false); startAlerts();
      if (host && !gone) { screen = ""; route(); load(); }
    },
    _select: function (layer, slot) { if (scene) scene.select(layer, slot, true); else { sel = { layer: layer, slot: slot }; tab = "colony"; sigs.pick = ""; applyTabs(); fillPick(); } },
    _api: api, _pollEvents: pollEvents, _state: function () { return { screen: screen, tab: tab, sel: sel, view: view }; }
  });

  FieldKit.register("colony", {
    title: "DEEPHOLD",
    icon: "▼",
    group: "ONLINE",
    about: "The shared underground colony: your colony feeds the Civilization",
    keywords: "game colony deephold civilization war build dig play shared coop",
    width: 1040,
    height: 760,
    guestSafe: false,
    selfcheck: selfcheck,

    async mount(h, context) {
      ctx = context; el = ctx.ui.el; host = h; gone = false;
      view = null; lastErr = ""; busy = false; sel = null; screen = ""; menuOpen = false; sigs = {};
      css();
      route();
      if (session) { await load(); }
      pollTimer = setInterval(function () { if (!document.hidden && session) load(); }, 4000);
      tickTimer = setInterval(function () { if (!document.hidden) tick(); }, 250);
    },

    unmount() {
      gone = true;
      if (pollTimer) clearInterval(pollTimer);
      if (tickTimer) clearInterval(tickTimer);
      pollTimer = tickTimer = null;
      if (scene) { scene.destroy(); scene = null; }
      host = null; view = null; R = {}; screen = "";
    }
  });
})(window.FieldKit);
