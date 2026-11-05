/* ============================================================
   FieldKit :: shell
   Fake-OS desktop: icons, draggable/resizable windows, focus and
   z-order, taskbar, status tray.

   Modules are mounted on open and unmounted on close, so nothing
   keeps running in the background. A module that throws during
   mount degrades to an error readout inside its own window — it
   never takes the desktop with it. (§10F)
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ui = FieldKit.need("ui");
  var el = ui.el;

  var desktop, iconLayer, shelves, winLayer, taskbar, taskList, tray;
  var windows = new Map();     // moduleId -> window record
  /* Where each app's window was left, and which were open: this machine's
     business, like the usage counts, so localStorage and not the vault. */
  var GEO_KEY = "fieldkit.windows.v1", OPEN_KEY = "fieldkit.open.v1", SEEN_KEY = "fieldkit.seenVersion";
  var zTop = 10;
  var focused = null;
  var cascade = 0;

  /* ---- construction ------------------------------------------- */
  function build(root) {
    desktop = el("div", { id: "fk-desktop" });
    /* The search bar is built once and kept: refreshIcons() rebuilds
       only the shelves under it, so a module registering mid-search
       never takes the text being typed with it. */
    shelves = el("div", { class: "fk-shelves" });
    attn = el("div", { class: "fk-attn" });
    offers = el("div", { class: "fk-attn" });
    iconLayer = el("div", { id: "fk-icons" }, [buildSearch(), offers, attn, shelves]);
    winLayer = el("div", { id: "fk-windows" });
    taskList = el("div", { id: "fk-tasks" });
    tray = el("div", { id: "fk-tray" });
    taskbar = el("div", { id: "fk-taskbar" }, [
      el("span", { class: "brand", text: onOutpost() ? "OUTPOST" : "FIELDKIT" }), taskList, tray
    ]);
    desktop.appendChild(iconLayer);
    desktop.appendChild(winLayer);
    desktop.appendChild(taskbar);
    root.appendChild(desktop);

    buildTray();
    var notices = FieldKit.service("notices");
    if (notices) notices.attach(desktop, tray);
    offerRestore();
    offerWhatsNew();
    FieldKit.on("shell:resize", function (e) { if (!e || !e.id) refit(); });
    window.addEventListener("resize", refit);
    refreshIcons();

    FieldKit.on("module:registered", refreshIcons);
    FieldKit.on("module:failed", refreshIcons);
    FieldKit.on("messages:session", refreshIcons);
    FieldKit.on("health:checked", drawAttention);
    window.addEventListener("keydown", onKey);
    /* A menu goes when anything else is pressed. */
    document.addEventListener("pointerdown", function (e) {
      if (menuNode && !menuNode.contains(e.target)) closeMenu();
    }, true);
    desktop.addEventListener("mousedown", function (e) {
      var inWin = false;
      windows.forEach(function (r) { if (r.node.contains(e.target)) inWin = true; });
      keysToWindow = inWin;
    }, true);
    return desktop;
  }

  /* ---- what needs attention ------------------------------------
     What was left of HOME once the desktop itself shows your apps: the
     things that go wrong quietly (core/health.js), each with a ✕. Only
     what is actually wrong; a row that is always there gets ignored. */
  var attn, dismissed = {};
  function drawAttention(report) {
    if (!attn) return;
    ui.clear(attn);
    ((report && report.problems) || []).forEach(function (f) {
      if (dismissed[f.id]) return;
      var row = el("div", { class: "fk-attn-row" + (f.level === "fail" ? " fail" : "") }, [
        el("span", { class: "fk-attn-t", text: f.text, title: f.detail || "" }),
        el("button", { class: "fk-attn-x", type: "button", text: "✕", title: "dismiss until next time",
          onclick: function () { dismissed[f.id] = true; if (row.parentNode) row.parentNode.removeChild(row); } })
      ]);
      attn.appendChild(row);
    });
  }

  /* ---- things to offer once ---------------------------------- */
  var offers;

  function offer(text, label, go) {
    var row = el("div", { class: "fk-attn-row calm" }, [
      el("span", { class: "fk-attn-t", text: text }),
      el("button", { class: "fk-task", type: "button", text: label,
        onclick: function () { if (row.parentNode) row.parentNode.removeChild(row); go(); } }),
      el("button", { class: "fk-attn-x", type: "button", text: "✕", title: "no thanks",
        onclick: function () { if (row.parentNode) row.parentNode.removeChild(row); } })
    ]);
    offers.appendChild(row);
  }

  /* What was open when the page last closed. Offered, not done: BROWSER
     and RUNNER each start something on the server when they open. */
  function lastOpen() {
    try {
      var l = JSON.parse(localStorage.getItem(OPEN_KEY) || "[]");
      return Array.isArray(l) ? l.filter(function (id) { return typeof id === "string"; }) : [];
    } catch (e) { return []; }
  }

  function noteOpen() {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(Array.from(windows.keys()))); } catch (e) {}
  }

  var wasOpen = [];
  function reopen() {
    var ids = wasOpen.slice();
    ids.forEach(function (id) { if (FieldKit.module(id)) open(id); });
    return ids.length;
  }

  function offerRestore() {
    wasOpen = lastOpen();
    if (!wasOpen.length) return;
    var names = wasOpen.map(function (id) { var m = FieldKit.module(id); return m ? m.title : null; }).filter(Boolean);
    if (names.length) offer("Open again: " + names.join(", "), "REOPEN", reopen);
  }

  /* After an update, once. Nothing on a first run: it is all new then. */
  function offerWhatsNew() {
    var wn = FieldKit.service("whatsNew");
    if (!wn) return;
    var seen = null;
    try { seen = localStorage.getItem(SEEN_KEY); localStorage.setItem(SEEN_KEY, FieldKit.VERSION); } catch (e) { return; }
    if (seen && seen !== FieldKit.VERSION) offer("Updated to " + FieldKit.VERSION + ".", "WHAT'S NEW", showWhatsNew);
  }

  /* A sheet over the desktop, for reading. */
  function sheet(title, kids) {
    var old = document.getElementById("fk-sheet");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var host = el("div", { id: "fk-sheet" });
    function done() { if (host.parentNode) host.parentNode.removeChild(host); }
    host.appendChild(el("div", { class: "fk-sheet-back", onclick: done }));
    host.appendChild(el("div", { class: "fk-sheet-box" }, [
      el("div", { class: "fk-sheet-h" }, [
        el("span", { text: title }),
        el("button", { class: "fk-task", type: "button", text: "CLOSE", onclick: done })
      ])
    ].concat(kids)));
    desktop.appendChild(host);
    return host;
  }

  function showWhatsNew() {
    var wn = FieldKit.service("whatsNew");
    if (!wn) return;
    var kids = [];
    wn.notes().slice(0, 4).forEach(function (n) {
      kids.push(el("div", { class: "fk-sheet-sub", text: n.v }));
      n.items.forEach(function (i) { kids.push(el("div", { class: "fk-sheet-li", text: i })); });
    });
    sheet("WHAT'S NEW", kids);
  }

  var KEYS = [
    ["Type on the desktop", "find an app; Enter opens it"],
    ["Ctrl+K", "search apps, notes and actions"],
    ["Ctrl+/", "this list"],
    ["Ctrl+L", "lock the screen, if a PIN is set"],
    ["Esc", "close a folder or the window you are in, but not from a page or a program"],
    ["Ctrl+Shift+Left / Right", "snap the window to half the screen"],
    ["Ctrl+Shift+Up", "maximise, or restore"],
    ["Ctrl+Shift+Down", "minimise"],
    ["Ctrl+Shift+D", "show the desktop; again brings the windows back"],
    ["Right-click an app or a window's button", "pin it, snap it, close it"],
    ["Middle-click a window's button", "close it"],
    ["Double-click a title bar", "maximise, or restore"],
    ["Drag a title bar to an edge", "snap to that side; the top edge maximises"],
    ["In BROWSER: Ctrl+F, Ctrl+L, F5", "find, address bar, reload"],
    ["In BROWSER: Ctrl and + or -", "zoom"]
  ];

  function showKeys() {
    sheet("KEYBOARD", KEYS.map(function (k) {
      return el("div", { class: "fk-sheet-key" }, [el("span", { class: "k", text: k[0] }), el("span", { class: "v", text: k[1] })]);
    }));
  }

  /* Apps marked adminOnly exist only for an admin on the relay: to
     everyone else there is no tile, no search hit and no window. */
  /* The build without a vault names itself, and offers nothing it lacks. */
  function onOutpost() {
    var boot = FieldKit.service("boot");
    return !!(boot && boot.OUTPOST);
  }

  function adminOK(m) {
    if (!m || !m.adminOnly) return true;
    var msg = FieldKit.service("messages");
    return !!(msg && msg.tier && msg.tier() === "admin");
  }

  /* ---- tray --------------------------------------------------- */
  var trayStatus, trayPending, trayClock;

  function buildTray() {
    trayStatus = ui.statusDot("warn", "INIT");
    trayPending = el("span", { class: "lvl-dim", text: "" });
    trayClock = el("span", { text: "--:--:--" });

    var themeBtn = el("button", {
      class: "fk-task", text: "THEME",
      title: "cycle accent palette",
      onclick: cycleTheme
    });
    var crtBtn = el("button", {
      class: "fk-task", text: "CRT",
      title: "toggle scanline mode",
      onclick: function () {
        document.body.classList.toggle("crt");
        ui.toast("CRT MODE " + (document.body.classList.contains("crt") ? "ENGAGED" : "OFF"), "info");
      }
    });

    var guest = FieldKit.service("guest");
    var lockBtn = el("button", {
      class: "fk-task",
      text: guest && guest.active() ? "END GUEST" : "LOCK",
      title: guest && guest.active()
        ? "end the guest session and return to the master password"
        : "lock the screen (Ctrl+L)",
      onclick: function () {
        if (guest && guest.active()) {
          if (confirm("End the guest session? The page will reload.")) guest.end();
          return;
        }
        var lock = FieldKit.service("lockscreen");
        if (!lock) return;
        lock.hasPin().then(function (yes) {
          if (yes) lock.engage({});
          else ui.toast("NO PIN SET — CONFIGURE ONE IN SETTINGS", "warn");
        });
      }
    });

    /* Pulling other people's work on demand. Present even on a solo
       vault, because "did that save?" is a question worth being able
       to answer without reloading the page. */
    var refreshBtn = el("button", {
      class: "fk-task", text: "REFRESH",
      title: "pull changes made from another machine",
      onclick: function () {
        var store = FieldKit.service("store");
        if (!store || !store.pull) return;
        if (!store.isUnlocked()) { ui.toast("THE VAULT IS NOT OPEN", "warn"); return; }
        refreshBtn.disabled = true;
        refreshBtn.textContent = "PULLING";
        store.pull().then(function (r) {
          var n = r.added + r.updated + r.removed;
          ui.toast(n ? "PULLED " + n + " CHANGE(S)" : "ALREADY UP TO DATE", n ? "ok" : "info");
        }).catch(function (e) {
          ui.toast("PULL FAILED: " + e.message, "fail");
        }).then(function () {
          refreshBtn.disabled = false;
          refreshBtn.textContent = "REFRESH";
        });
      }
    });

    tray.appendChild(trayPending);
    tray.appendChild(refreshBtn);
    tray.appendChild(themeBtn);
    tray.appendChild(crtBtn);
    tray.appendChild(lockBtn);
    tray.appendChild(trayStatus);
    tray.appendChild(trayClock);

    tick();
    setInterval(tick, 1000);

    FieldKit.on("store:state", renderStoreState);
    FieldKit.on("store:changed", refreshPending);
    FieldKit.on("store:synced", refreshPending);
    FieldKit.on("store:remote", announceRemote);
    FieldKit.on("store:overwrote", announceOverwrite);
    renderStoreState({ state: FieldKit.service("store") ? FieldKit.service("store").state() : "INIT" });
    refreshPending();
    if (onOutpost()) {
      checkRelay();
      setInterval(checkRelay, RELAY_CHECK_MS);
      FieldKit.on("settings:changed", function (e) { if (e && e.key === "relayUrl") { relayAnswers = null; checkRelay(); } });
    }
    /* Clicking the state opens RELAY LINK, where the address is changed. */
    trayStatus.style.cursor = "pointer";
    trayStatus.title = "open RELAY LINK";
    trayStatus.addEventListener("click", function () { if (FieldKit.service("shell")) FieldKit.service("shell").open("relay-link"); });
  }

  /* Somebody else's work just landed. Say whose, and what — a change
     appearing under you with no explanation is worse than no sync. */
  function announceRemote(e) {
    if (!e || !e.changes || !e.changes.length) return;
    var who = {};
    e.changes.forEach(function (c) { if (c.author) who[c.author] = true; });
    var names = Object.keys(who);
    var bits = [];
    if (e.added) bits.push(e.added + " new");
    if (e.updated) bits.push(e.updated + " updated");
    if (e.removed) bits.push(e.removed + " removed");
    ui.toast((names.length ? names.join(", ").toUpperCase() + ": " : "PULLED: ") + bits.join(", "),
      "info");
  }

  /* The one that actually matters. Last write wins is a defensible
     rule; losing someone's work without telling anyone is not. */
  function announceOverwrite(e) {
    if (!e) return;
    ui.toast("YOU OVERWROTE A NEWER " + String(e.type || "record").toUpperCase() +
      (e.author ? " BY " + String(e.author).toUpperCase() : "") +
      " — PRESS REFRESH BEFORE EDITING", "warn");
  }

  function tick() {
    var d = new Date(), s = FieldKit.service("settings");
    trayClock.textContent = clockText(d, !s || s.get("clock24") !== false);
    /* The date where the time is, without taking room on the bar. */
    var day = d.toDateString();
    if (trayClock.__day !== day) {
      trayClock.__day = day;
      trayClock.title = d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    }
  }

  function clockText(d, h24) {
    var p = function (n) { return String(n).padStart(2, "0"); };
    if (h24) return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    return (d.getHours() % 12 || 12) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) +
      (d.getHours() < 12 ? " AM" : " PM");
  }

  /* ONLINE means "the store is answering", which is not the same as
     "the relay is up". With no relay configured the store is happily
     online against IndexedDB on this one machine — and the tray used
     to call that RELAY ONLINE, which is the single most misleading
     thing the bar could say: it is exactly the reading you would use
     to decide whether your work is reaching the other person. So the
     label names the transport it is actually online through. */
  function transportLabel() {
    var store = FieldKit.service("store");
    var t = store && typeof store.transportName === "function"
      ? store.transportName() : "none";
    if (t === "relay") return "RELAY ONLINE" + relayHostSuffix();
    if (t === "local") return "LOCAL ONLY — NO RELAY";
    if (t === "memory") return "MEMORY ONLY";
    return "ONLINE";
  }

  function relayHostSuffix() {
    var st = FieldKit.service("settings");
    var u = st ? String(st.get("relayUrl") || "") : "";
    try { return u ? " · " + new URL(/^[a-z]+:\/\//i.test(u) ? u : "https://" + u).hostname.toUpperCase() : ""; } catch (e) { return ""; }
  }

  /* OUTPOST has no vault, so its store is always this machine's and the
     bar said LOCAL ONLY — NO RELAY with MESSAGES and BROWSER working on
     the relay all along. There, the bar says whether the relay answers:
     asked every RELAY_CHECK_MS, and again when the address changes. */
  var RELAY_CHECK_MS = 60000;
  var relayAnswers = null;          /* null: not asked yet */
  async function checkRelay() {
    var st = FieldKit.service("settings"), rc = FieldKit.service("relayChoice");
    var u = st ? String(st.get("relayUrl") || "").trim() : "";
    if (!u || !rc) { relayAnswers = null; return renderStoreState(); }
    var url = rc.clean(u);
    var yes = url ? await rc.answers(url) : false;
    relayAnswers = yes;
    renderStoreState();
  }

  function outpostLabel() {
    var st = FieldKit.service("settings");
    if (!st || !String(st.get("relayUrl") || "").trim()) return ["warn", "NO RELAY SET"];
    if (relayAnswers === null) return ["warn", "RELAY: CHECKING"];
    return relayAnswers ? ["ok", "RELAY ONLINE" + relayHostSuffix()] : ["warn", "RELAY NOT ANSWERING" + relayHostSuffix()];
  }

  function renderStoreState(e) {
    var s = (e && e.state) || (FieldKit.service("store") ? FieldKit.service("store").state() : "INIT");
    var map = {
      ONLINE: ["ok", transportLabel],
      OFFLINE: ["warn", "OFFLINE — QUEUED"],
      LOCKED: ["bad", "LOCKED"],
      EMPTY: ["bad", "NO VAULT"],
      GUEST: ["warn", "GUEST — VAULT SEALED"],
      INIT: ["warn", "INIT"]
    };
    var m = map[s] || ["warn", s];
    if (typeof m[1] === "function") m = [m[0], m[1]()];
    /* Online through something that is not the relay is a true and
       useful thing to say, but it is not the all-clear. */
    if (s === "ONLINE" && m[1].indexOf("RELAY ONLINE") !== 0) m = ["warn", m[1]];
    if (onOutpost()) m = outpostLabel();
    ui.clear(trayStatus);
    trayStatus.className = "fk-status fk-status-" + m[0];
    trayStatus.appendChild(el("span", { class: "fk-dot" }));
    trayStatus.appendChild(el("span", { text: m[1] }));
  }

  async function refreshPending() {
    var store = FieldKit.service("store");
    if (!store) return;
    var n = await store.pendingCount();
    trayPending.textContent = n ? "QUEUED " + n : "";
  }

  function cycleTheme() {
    var ids = Object.keys(ui.THEMES);
    var next = ids[(ids.indexOf(ui.currentTheme()) + 1) % ids.length];
    ui.applyTheme(next);
    var settings = FieldKit.service("settings");
    if (settings) settings.set("theme", next);
    ui.toast("PALETTE :: " + ui.THEMES[next].name, "info");
  }

  /* ---- how much each app is used -------------------------------
     Which tools you reach for is not secret and not worth a round
     trip to the relay, so this lives in localStorage. It also has
     to work in a guest session, where there is no vault at all.

     Kept out of the vault for a second reason: a shared vault would
     otherwise mean your friend's habits reordering your desktop.

     It was a list of the last five opened. It is now a count and a
     time per app, because "the apps I use most" and "the app I
     opened once, five minutes ago" are different questions and the
     home screen should answer the first (RUNNER_PLAN.md §21). */
  var USAGE_KEY = "fieldkit.usage.v1";
  var RECENT_KEY = "fieldkit.recent.v1";     // the old list: read once, to seed the counts
  var TOP_MAX = 8;
  var TOP_MIN = 6;
  /* Until a few have been used, the ones most people want first. */
  var DEFAULT_APPS = ["browser", "messages", "runner", "vault-files", "ai-chat", "scratchpad"];
  var DAY = 86400000;

  function readUsage() {
    try {
      var u = JSON.parse(localStorage.getItem(USAGE_KEY) || "null");
      if (u && typeof u === "object" && !Array.isArray(u)) return u;
    } catch (e) { /* unreadable: start again from the old list */ }
    var out = {};
    try {
      var old = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (Array.isArray(old)) {
        old.forEach(function (id, i) {
          if (typeof id === "string" && !out[id]) out[id] = { n: 1, at: Date.now() - i * 1000 };
        });
      }
    } catch (e) {}
    return out;
  }

  /* ---- pinned apps ---------------------------------------------
     Also this machine's and not the vault's, for the same reason. */
  var PIN_KEY = "fieldkit.pins.v1";
  function readPins() {
    try {
      var p = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
      return Array.isArray(p) ? p.filter(function (x) { return typeof x === "string"; }).slice(0, TOP_MAX) : [];
    } catch (e) { return []; }
  }
  function isPinned(id) { return readPins().indexOf(id) >= 0; }
  function setPinned(id, on) {
    var p = readPins().filter(function (x) { return x !== id; });
    if (on) {
      if (p.length >= TOP_MAX) { ui.toast("YOUR APPS HOLDS " + TOP_MAX + " — UNPIN ONE FIRST", "warn"); return false; }
      p.push(id);
    }
    try { localStorage.setItem(PIN_KEY, JSON.stringify(p)); } catch (e) { return false; }
    refreshIcons();
    return true;
  }

  function noteUsed(id) {
    try {
      var u = readUsage();
      var r = u[id] && typeof u[id] === "object" ? u[id] : { n: 0, at: 0 };
      u[id] = { n: Math.min(9999, (r.n | 0) + 1), at: Date.now() };
      /* Bounded, so a long life on one machine cannot grow it. */
      var keys = Object.keys(u);
      if (keys.length > 60) {
        keys.sort(function (a, b) { return (u[b].at || 0) - (u[a].at || 0); })
          .slice(60).forEach(function (k) { delete u[k]; });
      }
      localStorage.setItem(USAGE_KEY, JSON.stringify(u));
    } catch (e) { /* a full quota must not stop a module opening */ }
  }

  /* Often AND lately: a use a fortnight ago counts half as much as
     one today, so last term's habit gives way to this week's. */
  function usageScore(r, now) {
    if (!r || typeof r !== "object") return 0;
    return (r.n | 0) / (1 + Math.max(0, now - (r.at || 0)) / (14 * DAY));
  }

  /* Only modules that still exist, have a tile and are openable. A
     stale id from a removed module, or one sealed by the current
     session, must not appear as a dead shortcut. */
  function topModules() {
    var guest = FieldKit.service("guest");
    var mods = FieldKit.modules();
    var u = readUsage(), now = Date.now();
    var usable = function (id) {
      var m = mods[id];
      return !!m && !m.inside && adminOK(m) && (!guest || guest.allowed(m));
    };
    /* Pinned first, in the order pinned, so they stay where the hand
       expects them; the rest of the row follows what is used. */
    var pins = readPins().filter(usable);
    var ids = pins.concat(Object.keys(u).filter(function (id) {
      return usable(id) && pins.indexOf(id) < 0;
    }).sort(function (a, b) {
      return usageScore(u[b], now) - usageScore(u[a], now) || a.localeCompare(b);
    })).slice(0, TOP_MAX);
    DEFAULT_APPS.forEach(function (id) {
      if (ids.length < TOP_MIN && ids.indexOf(id) < 0 && usable(id)) ids.push(id);
    });
    return ids.map(function (id) { return mods[id]; });
  }

  /* ---- search ---------------------------------------------------
     "It isn't very easy to find stuff" (RUNNER_PLAN.md §21). A bar at
     the top of the desktop that finds an app by its name, by what it
     does (each module's `about` and `keywords`) or by its group, and
     opens the first hit on Enter. Typing anywhere on the desktop
     lands in it, so finding something is: type, Enter.

     It finds APPS. Records, notes and commands are the palette's
     (Ctrl+K), and the last row hands the same words over to it. */
  var searchBox, searchInput, searchHits, hits = [], hitSel = 0;
  /* Whether keys belong to a window: true once one is focused or
     clicked, false once the desktop itself is clicked or the window
     goes. The keyboard focus alone cannot say this: clicking the text
     of a window leaves it on <body>, and those keys must not vanish
     into a search bar hidden behind the window. */
  var keysToWindow = false;

  function buildSearch() {
    searchInput = el("input", {
      class: "fk-search-in", type: "text", spellcheck: "false", autocomplete: "off",
      placeholder: "Find an app: type its name or what you want to do",
      "aria-label": "find an app",
      oninput: runSearch,
      onkeydown: searchKey
    });
    searchHits = el("div", { class: "fk-search-hits" });
    searchBox = el("div", { class: "fk-search" }, [
      el("div", { class: "fk-search-bar" }, [
        el("span", { class: "fk-search-g", text: "⌕" }),
        searchInput,
        el("button", {
          class: "fk-search-k", type: "button", text: "CTRL+K",
          title: "search everything: notes, records and commands too",
          onclick: function () { everything(searchInput.value); }
        })
      ]),
      searchHits
    ]);
    return searchBox;
  }

  /* How well one app matches. The name counts most, then the words
     it is described by; every word typed has to appear somewhere, so
     "edit save" finds SAVE CODES and not every app that edits. */
  function matchScore(m, q, words) {
    var title = String(m.title || "").toLowerCase();
    if (title === q) return 200;
    if (title.indexOf(q) === 0) return 150;
    if ((" " + title).indexOf(" " + q) >= 0) return 120;
    if (title.indexOf(q) >= 0) return 90;
    var about = String(m.about || "").toLowerCase();
    var keys = " " + String(m.keywords || "").toLowerCase() + " ";
    var group = String(m.group || "").toLowerCase();
    var hay = title + " " + about + " " + keys + " " + group;
    if (words.every(function (w) { return hay.indexOf(w) >= 0; })) {
      var s = 40;
      words.forEach(function (w) {
        if (keys.indexOf(" " + w) >= 0) s += 10;
        if ((" " + about).indexOf(" " + w) >= 0) s += 5;
        if (group.indexOf(w) === 0) s += 5;
      });
      return s;
    }
    /* Letters in order, so "vf" finds VAULT FILES. */
    var i = 0;
    for (var c = 0; c < title.length && i < q.length; c++) if (title[c] === q[i]) i++;
    return i === q.length && q.length > 1 ? 12 : 0;
  }

  function findApps(text) {
    var q = String(text || "").trim().toLowerCase();
    if (!q) return [];
    var words = q.split(/\s+/);
    var mods = FieldKit.modules(), u = readUsage(), now = Date.now();
    var out = [];
    Object.keys(mods).forEach(function (id) {
      if (mods[id].inside || !adminOK(mods[id])) return;
      var s = matchScore(mods[id], q, words);
      if (s > 0) out.push({ id: id, m: mods[id], s: s, use: usageScore(u[id], now) });
    });
    return out.sort(function (a, b) {
      return b.s - a.s || b.use - a.use || String(a.m.title).localeCompare(String(b.m.title));
    }).slice(0, 8);
  }

  function runSearch() {
    hits = findApps(searchInput.value);
    hitSel = 0;
    drawHits();
  }

  function drawHits() {
    ui.clear(searchHits);
    var q = searchInput.value.trim();
    if (iconLayer) iconLayer.classList.toggle("searching", !!q);
    if (!q) return;
    var guest = FieldKit.service("guest");
    /* The highlighted hit is the one Enter opens: let it get ready. */
    var top = hits[hitSel];
    if (top && !(guest && !guest.allowed(top.m))) prewarm(top.id, top.m);
    hits.forEach(function (h, i) {
      var sealed = guest && !guest.allowed(h.m);
      searchHits.appendChild(el("button", {
        class: "fk-hit" + (i === hitSel ? " sel" : "") + (sealed ? " sealed" : ""), type: "button",
        onclick: function () { hitSel = i; openHit(); },
        onmousemove: function () { if (hitSel !== i) { hitSel = i; drawHits(); } }
      }, [
        el("span", { class: "g", text: sealed ? "▩" : h.m.icon }),
        el("span", { class: "n", text: h.m.title }),
        el("span", { class: "a", text: sealed ? "sealed in a guest session" : (h.m.about || "") }),
        el("span", { class: "k", text: String(h.m.group || "").toUpperCase() })
      ]));
    });
    if (!hits.length) searchHits.appendChild(el("div", { class: "fk-hit-none", text: "No app matches “" + q + "”." }));
    searchHits.appendChild(el("button", {
      class: "fk-hit more", type: "button",
      onclick: function () { everything(q); }
    }, [
      el("span", { class: "g", text: ">" }),
      el("span", { class: "n", text: (onOutpost() ? "Search commands for “" : "Search notes, records and commands for “") + q + "”" }),
      el("span", { class: "k", text: "CTRL+K" })
    ]));
  }

  function clearSearch() {
    if (!searchInput) return;
    searchInput.value = "";
    hits = [];
    drawHits();
  }

  function openHit() {
    var h = hits[hitSel];
    if (!h) return;
    clearSearch();
    if (typeof searchInput.blur === "function") searchInput.blur();
    closeFolder();
    open(h.id);
  }

  function everything(q) {
    var pal = FieldKit.service("commandPalette");
    if (!pal) return;
    clearSearch();
    pal.show(q);
  }

  function searchKey(e) {
    if (e.key === "Enter") { e.preventDefault(); openHit(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); hitSel = Math.min(hitSel + 1, Math.max(0, hits.length - 1)); drawHits(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hitSel = Math.max(hitSel - 1, 0); drawHits(); }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      clearSearch();
      if (typeof searchInput.blur === "function") searchInput.blur();
    }
  }

  /* Typing anywhere on the desktop starts a search. Only on the
     desktop itself: never while typing into something, never into a
     window (a game in RUNNER or a page in BROWSER takes its own
     keys), never with Ctrl/Alt/Meta held, never behind the lock. */
  function typedOnDesktop(e) {
    if (!searchInput || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!e.key || e.key.length !== 1 || e.key === " ") return false;
    if (keysToWindow && focused) return false;
    var t = e.target;
    if (t && t !== document.body && t !== window && t !== document) {
      var tag = String(t.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return false;
      if (winLayer && winLayer.contains(t)) return false;
      if (desktop && !desktop.contains(t)) return false;
    }
    var lock = FieldKit.service("lockscreen");
    if (lock && lock.isLocked && lock.isLocked()) return false;
    return true;
  }

  /* ---- icons ---------------------------------------------------

     Full-size tiles and folders you click into, which is the third
     shape this launcher has had and the first one that scales.

     It began as one alphabetical grid of every module: fine at
     eleven, a wall at thirty-seven, and it put SCRATCHPAD beside
     SECURITY SANDBOX because S follows S. That became six labelled
     columns of one-line rows — readable, but visually it was a
     settings page, and the whole point of the desktop metaphor is
     that you recognise a thing by its shape before you read it.

     So: groups are folders. The home screen holds one card per
     folder, and a folder card shows the first four glyphs inside it
     in a 2x2 the way a phone does, because that is what makes a
     folder recognisable without reading the label beside it. Since
     the rework (§21) the card also lists what is inside, the groups
     are named for what they hold (MESSAGES used to live in NOTES and
     RUNNER in SERVER), and the row above them is the apps you use
     most, so nothing used daily is more than one click away.
     ---------------------------------------------------------------- */
  var GROUP_ORDER = ["ONLINE", "FILES", "TOOLS", "SYSTEM"];
  /* Inside a folder, the everyday ones first; that is also which four
     glyphs its card shows. Anything not listed follows, by name. */
  var APP_ORDER = ["browser", "messages", "runner", "ai-chat",
    "vault-files", "scratchpad", "task-board", "topology", "relay-config", "relay-link",
    "game-math", "qr-gen", "terminal", "critter-ref",
    "admin-center", "settings-panel", "settings-outpost", "updater", "help", "selftest-panel"];
  var DEAD_FOLDER = "DID NOT LOAD";
  var FOLDER_PREVIEW = 4;      // glyphs shown on the folder tile
  var openFolder = null;       // name of the folder panel on screen

  /* One app tile, in whichever of the three states it is in.
     Sealed modules stay visible on purpose — a guest should be able
     to see the console is bigger than what they were handed,
     without being able to open any of it. */
  function appTile(id, m, guest) {
    if (m && m.__dead) {
      return el("button", {
        class: "fk-app dead", type: "button",
        title: "failed to load: " + (m.__dead.message || "unknown fault"),
        onclick: function () { ui.toast("MODULE FAULT :: " + id, "fail"); }
      }, [
        el("span", { class: "g", text: "⚠" }),
        el("span", { class: "n", text: id })
      ]);
    }
    if (guest && !guest.allowed(m)) {
      return el("button", {
        class: "fk-app sealed", type: "button",
        title: m.title + " — sealed in a guest session",
        onclick: function () { ui.toast("SEALED :: " + m.title, "warn"); }
      }, [
        el("span", { class: "g", text: "▩" }),
        el("span", { class: "n", text: m.title })
      ]);
    }
    var tile = el("button", {
      class: "fk-app" + (isPinned(id) ? " pinned" : ""), type: "button",
      title: m.title + (m.about ? " — " + m.about : "") + (isPinned(id) ? " (pinned)" : ""),
      onclick: function () { if (tile.__held) { tile.__held = false; return; } closeFolder(); open(id); },
      oncontextmenu: function (e) { if (e.preventDefault) e.preventDefault(); tileMenu(id, m, e.clientX, e.clientY); },
      onpointerenter: function () { prewarm(id, m); },
      ontouchstart: function () { prewarm(id, m); },
      onfocus: function () { prewarm(id, m); }
    }, [
      el("span", { class: "g", text: m.icon }),
      el("span", { class: "n", text: m.title })
    ]);
    holdForMenu(tile, function (x, y) { tileMenu(id, m, x, y); });
    return tile;
  }

  function tileMenu(id, m, x, y) {
    var pinned = isPinned(id);
    var manual = FieldKit.service("manual");
    var page = manual && manual.pageFor(id);
    return popMenu(x, y, [
      ["OPEN", function () { closeFolder(); open(id); }],
      [pinned ? "UNPIN FROM YOUR APPS" : "PIN TO YOUR APPS", function () {
        if (setPinned(id, !pinned)) ui.toast((pinned ? "UNPINNED :: " : "PINNED :: ") + m.title, "ok");
      }],
      page ? ["HOW IT WORKS", function () { manual.open(page); }] : null
    ]);
  }

  /* ---- a small menu: right-click, or a long press on a touch screen */
  var menuNode = null;
  function closeMenu() {
    if (menuNode && menuNode.parentNode) menuNode.parentNode.removeChild(menuNode);
    menuNode = null;
  }
  function popMenu(x, y, items) {
    closeMenu();
    if (!desktop) return null;
    var box = el("div", { class: "fk-menu", role: "menu" });
    items.filter(Boolean).forEach(function (it) {
      box.appendChild(el("button", { class: "fk-menu-i", type: "button", role: "menuitem", text: it[0],
        onclick: function () { closeMenu(); it[1](); } }));
    });
    /* Up and down move between the items, as in any menu. */
    box.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.preventDefault) e.preventDefault();
      var list = Array.prototype.slice.call(box.children || []);
      var i = list.indexOf(document.activeElement);
      var next = list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length];
      if (next && next.focus) next.focus();
    });
    desktop.appendChild(box);
    /* Kept on screen, whichever corner it was asked for in. */
    var w = box.offsetWidth || 200, h = box.offsetHeight || items.length * 30;
    box.style.left = Math.max(4, Math.min(Number(x) || 0, (window.innerWidth || 1024) - w - 4)) + "px";
    /* y below zero means "with its bottom edge this far up", for the
       taskbar, so the menu never covers the buttons it came from. */
    var top = Number(y) < 0 ? (window.innerHeight || 768) + Number(y) - h : Number(y) || 0;
    box.style.top = Math.max(4, Math.min(top, (window.innerHeight || 768) - h - 4)) + "px";
    menuNode = box;
    var first = box.children && box.children[0];
    if (first && first.focus) first.focus();
    return box;
  }
  /* Half a second's press on a touch screen is a right-click. The click
     that follows it is swallowed, or the app would open under the menu. */
  function holdForMenu(node, fn) {
    var timer = null;
    node.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch") return;
      var x = e.clientX, y = e.clientY;
      timer = setTimeout(function () { timer = null; node.__held = true; fn(x, y); }, 550);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) {
      node.addEventListener(t, function () { if (timer) { clearTimeout(timer); timer = null; } });
    });
  }

  /* A module can start something slow before it is opened: the
     pointer resting on its tile, a finger touching it or the keyboard
     reaching it is a good sign it is about to be. At most once every
     30 seconds per module, and nothing that goes wrong here is shown:
     opening it works the same without. */
  var warmedAt = {};
  function prewarm(id, m) {
    if (!m || typeof m.prewarm !== "function") return;
    var now = Date.now();
    if (warmedAt[id] && now - warmedAt[id] < 30000) return;
    warmedAt[id] = now;
    try { Promise.resolve(m.prewarm()).catch(function () {}); } catch (e) {}
  }

  function folderTile(name, ids, mods, bad) {
    var preview = el("span", { class: "fk-folder-peek" });
    ids.slice(0, FOLDER_PREVIEW).forEach(function (id) {
      preview.appendChild(el("span", {
        class: "p", text: bad ? "⚠" : (mods[id] && mods[id].icon) || "·"
      }));
    });
    /* What is inside, by name: a folder that says what it holds is
       one you do not have to open to find out. */
    var inside = ids.map(function (id) { return (mods[id] && mods[id].title) || id; }).join(" · ");
    return el("button", {
      class: "fk-folder" + (bad ? " bad" : "") +
        (openFolder === name ? " open" : ""),
      type: "button",
      title: name + " — " + inside,
      onclick: function () { toggleFolder(name); }
    }, [
      preview,
      el("span", { class: "fk-folder-txt" }, [
        el("span", { class: "n", text: name }),
        el("span", { class: "s", text: inside })
      ]),
      el("span", { class: "c", text: String(ids.length) })
    ]);
  }

  function toggleFolder(name) {
    openFolder = (openFolder === name) ? null : name;
    refreshIcons();
  }

  function closeFolder() {
    if (!openFolder) return;
    openFolder = null;
    refreshIcons();
  }

  /* Grouping is read fresh every time rather than cached, because a
     module can register late (§10F) and the folder it belongs in
     has to appear without a reload. */
  function groupedModules() {
    var mods = FieldKit.modules();
    var grouped = Object.create(null);
    Object.keys(mods).sort().forEach(function (id) {
      /* A module that declares `inside` is a tab of another module
         and gets no tile of its own. This is how three panels about
         the same subject become one thing on the launcher without
         any of them being rewritten into a single 1700-line file:
         each keeps its own module, its own selfchecks and its own
         tests, and the host mounts it as a tab.

         It stays a real module on purpose: it is still in
         FieldKit.modules(), still selfchecks, and open() still
         reaches it by id, so the terminal and the palette can still
         put one on screen on its own. The only thing `inside`
         changes is whether it gets a tile. */
      if (mods[id].inside || !adminOK(mods[id])) return;
      var g = (mods[id].group || "TOOLS").toUpperCase();
      (grouped[g] = grouped[g] || []).push(id);
    });
    var rank = function (id) { var i = APP_ORDER.indexOf(id); return i < 0 ? APP_ORDER.length : i; };
    Object.keys(grouped).forEach(function (g) {
      grouped[g].sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); });
    });
    return grouped;
  }

  function refreshIcons() {
    if (!iconLayer) return;
    ui.clear(shelves);
    var guest = FieldKit.service("guest");
    var mods = FieldKit.modules();
    var grouped = groupedModules();

    /* Anything that failed to load becomes its own folder rather
       than sitting quietly at the end. On the school machine there
       is no console to ask, so a broken module has to announce
       itself on the desktop or it is invisible. */
    var dead = FieldKit.failedModules();
    var deadIds = Object.keys(dead);
    var view = Object.create(null);
    Object.keys(mods).forEach(function (id) { view[id] = mods[id]; });
    deadIds.forEach(function (id) { view[id] = { title: id, icon: "⚠", __dead: dead[id] }; });

    /* The apps used most, loose on the home screen the way a phone
       keeps its favourites out of the folders. */
    var top = topModules();
    if (top.length) {
      var topGrid = el("div", { class: "fk-grid" });
      top.forEach(function (m) {
        topGrid.appendChild(appTile(m.id, view[m.id] || m, guest));
      });
      shelves.appendChild(el("div", { class: "fk-shelf" }, [
        el("span", { class: "fk-shelf-lbl", text: "YOUR APPS" }), topGrid
      ]));
    }

    /* A fixed order, roughly "how often would a working day touch
       this". Any group a module invents that is not listed lands at
       the end rather than vanishing. */
    var order = GROUP_ORDER.filter(function (g) { return grouped[g]; })
      .concat(Object.keys(grouped).filter(function (g) {
        return GROUP_ORDER.indexOf(g) < 0;
      }).sort());
    if (deadIds.length) { grouped[DEAD_FOLDER] = deadIds; order.push(DEAD_FOLDER); }

    var folderGrid = el("div", { class: "fk-grid fk-folders" });
    order.forEach(function (g) {
      folderGrid.appendChild(folderTile(g, grouped[g], view, g === DEAD_FOLDER));
    });
    shelves.appendChild(el("div", { class: "fk-shelf" }, [
      el("span", { class: "fk-shelf-lbl", text: "ALL APPS" }), folderGrid
    ]));

    /* The open folder is re-rendered from `openFolder` rather than
       left standing, so a module registering while a folder is open
       lands inside it instead of being cleared away with it. If the
       folder it named has since gone, it closes rather than
       rendering an empty panel. */
    if (openFolder && grouped[openFolder]) {
      shelves.appendChild(folderPanel(openFolder, grouped[openFolder], view, guest));
    } else if (openFolder) {
      openFolder = null;
    }
    /* The overlay lives inside #fk-icons so that clearing the layer
       tears it down with everything else — but #fk-icons sits under
       the windows. Lifting the whole layer while a folder is open is
       one class instead of a second teardown path. */
    iconLayer.classList.toggle("folder-open", !!openFolder);
    /* A module that registered while a search was showing belongs in
       its results too. */
    if (searchInput && searchInput.value.trim()) runSearch();
  }

  function folderPanel(name, ids, view, guest) {
    var grid = el("div", { class: "fk-grid" });
    ids.forEach(function (id) { grid.appendChild(appTile(id, view[id], guest)); });

    var panel = el("div", { class: "fk-folder-panel" }, [
      el("div", { class: "fk-folder-head" }, [
        el("span", { class: "t", text: name }),
        el("span", { class: "c", text: ids.length + " ITEM(S)" }),
        el("button", {
          class: "fk-task", type: "button", text: "CLOSE",
          title: "close this folder (Esc)", onclick: closeFolder
        })
      ]),
      grid
    ]);

    /* The backdrop is a sibling, not a parent, so a click that lands
       on a tile never has to be distinguished from a click that
       landed behind one. */
    return el("div", { class: "fk-folder-open" }, [
      el("div", { class: "fk-folder-back", onclick: closeFolder }),
      panel
    ]);
  }

  /* ---- windows ------------------------------------------------ */
  function open(id) {
    /* Before the desktop exists (the boot screen, a test) there is no
       layer to put a window in: say no rather than throw. */
    if (!winLayer) return null;
    var mod = FieldKit.module(id);
    if (!mod) { ui.toast("NO SUCH MODULE :: " + id, "fail"); return null; }

    /* Checked here as well as in refreshIcons: the command palette and
       any future caller reach open() directly. */
    var guest = FieldKit.service("guest");
    if (guest && !guest.allowed(mod)) {
      ui.toast("SEALED :: " + mod.title, "warn");
      return null;
    }
    if (!adminOK(mod)) { ui.toast("ADMINS ONLY :: " + mod.title, "warn"); return null; }

    noteUsed(id);

    var existing = windows.get(id);
    if (existing) {
      existing.node.classList.remove("minimized");
      focus(id);
      refreshIcons();
      return existing;
    }

    var w = Math.min(mod.width || 620, window.innerWidth - 60);
    var h = Math.min(mod.height || 420, window.innerHeight - 100);
    /* The stagger gives way to the screen: on a Chromebook the last
       steps of it put a window's bottom row under the taskbar, which
       is where ASK's input and every app's buttons are. */
    var room = { width: winLayer.clientWidth, height: winLayer.clientHeight };
    var x = 130 + (cascade % 6) * 26;
    var y = 40 + (cascade % 6) * 24;
    if (room.height) {
      h = Math.min(mod.height || 420, room.height - 8);
      x = Math.max(0, Math.min(x, room.width - w));
      y = Math.max(0, Math.min(y, room.height - h));
    }
    cascade++;

    var kept = readGeo()[id];
    if (kept && room.height) {
      w = Math.min(Math.max(MIN_W, kept.w | 0), room.width);
      h = Math.min(Math.max(MIN_H, kept.h | 0), room.height - 8);
      x = Math.max(Math.min(0, KEEP_VISIBLE - w), Math.min(kept.x | 0, room.width - KEEP_VISIBLE));
      y = Math.max(0, Math.min(kept.y | 0, room.height - 30));
    }

    var body = el("div", { class: "fk-win-body" });
    var title = el("span", { class: "fk-win-title", text: mod.title });
    var bar = el("div", { class: "fk-win-bar" }, [
      el("span", { class: "fk-win-glyph", text: mod.icon }), title,
      el("button", { class: "fk-win-btn", type: "button", text: "_", title: "minimise",
        onclick: function (ev) { ev.stopPropagation(); minimize(id); } }),
      /* Two different things that both look like "make it bigger",
         kept separate because they fail in different places.

         MAXIMISE fills the desktop and leaves the taskbar, the
         launcher and every other window reachable. It is CSS and
         cannot be refused.

         FULLSCREEN takes over the physical screen through the
         Fullscreen API. It is the one a game inside BROWSER wants,
         and it is also the one a managed Chromebook or a policy can
         decline — so it reports when it is refused instead of
         appearing to do nothing. */
      el("button", { class: "fk-win-btn", type: "button", text: "□", title: "maximise / restore",
        onclick: function (ev) { ev.stopPropagation(); toggleMaximise(id); } }),
      el("button", { class: "fk-win-btn", type: "button", text: "⛶", title: "fullscreen",
        onclick: function (ev) { ev.stopPropagation(); toggleFullscreen(id); } }),
      el("button", { class: "fk-win-btn close", type: "button", text: "✕", title: "close",
        onclick: function (ev) { ev.stopPropagation(); close(id); } })
    ]);
    /* Four handles rather than one corner. The corner alone is a
       16-pixel target that has to be hit before a window can be made
       usable, and BROWSER is the module people most want bigger. */
    var grips = [
      el("div", { class: "fk-win-grip e", "data-edge": "e" }),
      el("div", { class: "fk-win-grip s", "data-edge": "s" }),
      el("div", { class: "fk-win-grip w", "data-edge": "w" }),
      el("div", { class: "fk-win-resize", "data-edge": "se" })
    ];
    var node = el("div", { class: "fk-win", style: { left: x + "px", top: y + "px",
      width: w + "px", height: h + "px" } }, [bar, body].concat(grips));

    winLayer.appendChild(node);
    var rec = { id: id, mod: mod, node: node, body: body, bar: bar };
    windows.set(id, rec);

    bar.addEventListener("dblclick", function (e) {
      if (e.target.classList && e.target.classList.contains("fk-win-btn")) return;
      toggleMaximise(id);
    });
    makeDraggable(rec, bar);
    grips.forEach(function (g) { makeResizable(rec, g, g.getAttribute("data-edge")); });
    node.addEventListener("mousedown", function () { focus(id); });

    addTask(rec);
    focus(id);
    noteOpen();
    if (kept && kept.max) toggleMaximise(id);

    /* Mount inside a guard — a broken module gets a dead window,
       not a dead desktop. */
    try {
      var r = mod.mount(body, FieldKit.context());
      if (r && typeof r.then === "function") r.catch(function (e) { mountFailed(rec, e); });
    } catch (e) {
      mountFailed(rec, e);
    }

    refreshIcons();
    FieldKit.emit("shell:open", { id: id });
    return rec;
  }

  function mountFailed(rec, err) {
    FieldKit.log("error", "shell", "mount failed for " + rec.id + ": " + err.message);
    ui.clear(rec.body);
    rec.body.appendChild(ui.panel("MODULE FAULT", [
      ui.readout([
        { label: "MODULE", value: rec.id, level: "fail" },
        { label: "ERROR", value: err.message, level: "fail" }
      ]),
      el("div", { style: { marginTop: "10px" } },
        [ui.button("RETRY", function () {
          close(rec.id);
          setTimeout(function () { open(rec.id); }, 60);
        })])
    ]));
  }

  function close(id) {
    var rec = windows.get(id);
    if (!rec) return;
    try { if (typeof rec.mod.unmount === "function") rec.mod.unmount(); }
    catch (e) { FieldKit.log("error", "shell", "unmount threw for " + id + ": " + e.message); }
    if (rec.node.parentNode) rec.node.parentNode.removeChild(rec.node);
    if (rec.task && rec.task.parentNode) rec.task.parentNode.removeChild(rec.task);
    windows.delete(id);
    noteOpen();
    if (focused === id) { focused = null; keysToWindow = false; }
    FieldKit.emit("shell:close", { id: id });
  }

  function minimize(id) {
    var rec = windows.get(id);
    if (!rec) return;
    rec.node.classList.add("minimized");
    if (rec.task) rec.task.classList.remove("active");
    if (focused === id) { focused = null; keysToWindow = false; }
  }

  function focus(id) {
    var rec = windows.get(id);
    if (!rec) return;
    focused = id;
    keysToWindow = true;
    rec.node.style.zIndex = ++zTop;
    windows.forEach(function (r) {
      r.node.classList.toggle("focused", r.id === id);
      if (r.task) r.task.classList.toggle("active", r.id === id && !r.node.classList.contains("minimized"));
    });
  }

  function addTask(rec) {
    rec.task = el("button", { class: "fk-task", type: "button", text: rec.mod.title,
      onclick: function () {
        if (rec.task.__held) { rec.task.__held = false; return; }
        if (rec.node.classList.contains("minimized")) { rec.node.classList.remove("minimized"); focus(rec.id); }
        else if (focused === rec.id) minimize(rec.id);
        else focus(rec.id);
      },
      /* The middle button closes, as it does a browser's tab. */
      onauxclick: function (e) { if (e.button === 1) { if (e.preventDefault) e.preventDefault(); close(rec.id); } },
      onmousedown: function (e) { if (e.button === 1 && e.preventDefault) e.preventDefault(); },
      oncontextmenu: function (e) { if (e.preventDefault) e.preventDefault(); taskMenu(rec, e.clientX, e.clientY); } });
    holdForMenu(rec.task, function (x, y) { taskMenu(rec, x, y); });
    taskList.appendChild(rec.task);
  }

  function taskMenu(rec, x) {
    var min = rec.node.classList.contains("minimized");
    var back = function () { rec.node.classList.remove("minimized"); };
    /* From the taskbar it opens upward, over the desktop, its bottom
       edge on the bar's top (the bar is 30px high). */
    return popMenu(x, -34, [
      [min ? "RESTORE" : "MINIMISE", function () { if (min) { back(); focus(rec.id); } else minimize(rec.id); }],
      [rec.node.classList.contains("maximized") ? "RESTORE SIZE" : "MAXIMISE", function () { back(); toggleMaximise(rec.id); focus(rec.id); }],
      ["SNAP LEFT", function () { back(); snap(rec.id, "left"); focus(rec.id); }],
      ["SNAP RIGHT", function () { back(); snap(rec.id, "right"); focus(rec.id); }],
      ["CLOSE", function () { close(rec.id); }]
    ]);
  }

  /* ---- show the desktop -----------------------------------------
     Everything out of the way, and the same windows back on the second
     press. A window opened or restored in between ends that: the next
     press hides again. */
  var hiddenForDesktop = null;
  function showDesktop() {
    var shown = [];
    windows.forEach(function (r, id) { if (!r.node.classList.contains("minimized")) shown.push(id); });
    if (!shown.length && hiddenForDesktop) {
      var back = hiddenForDesktop.filter(function (id) { return windows.has(id); });
      hiddenForDesktop = null;
      back.forEach(function (id) { windows.get(id).node.classList.remove("minimized"); });
      if (back.length) focus(back[back.length - 1]);
      return back.length ? "restored" : "nothing";
    }
    shown.forEach(function (id) { minimize(id); });
    hiddenForDesktop = shown.length ? shown : null;
    return shown.length ? "hidden" : "nothing";
  }

  /* ---- drag / resize ------------------------------------------ */
  /* THE ONE THAT MADE RESIZING LOOK BROKEN.

     Both of these listened for mousemove on `document`. That works
     until the pointer crosses an <iframe> — and then it stops dead,
     because the events are being delivered to the iframe's document
     instead, and this document is not told. BROWSER is a window that
     is almost entirely iframe, so dragging its edge inward moved a
     few pixels and then froze the moment the cursor entered the
     page. Nothing threw; it just stopped.

     Pointer events with setPointerCapture fix it at the source: the
     capturing element receives every pointermove until release, no
     matter what is underneath — iframes included. It also gets touch
     and pen for free, which the mouse handlers never had.

     The capture is taken on the HANDLE, not on the window, so a
     drag that starts on the title bar cannot be stolen by a child
     that happens to be under the pointer later.

     WHY WINDOWS FELT STUCK ON THE CHROMEBOOKS (2026-10-29). Three
     things, none of them a broken handler:
     - every move set left/top, which re-lays-out and repaints the
       whole window, its big shadow and the translucent desktop under
       it. On a slow Chromebook with RUNNER's or BROWSER's video
       canvas inside, that took longer than a frame, so the window
       trailed the pointer and seemed not to want to move. A move is
       now a transform (moved by the compositor, no layout), turned
       into left/top once, on release; while a drag is on, the body
       has fk-dragging, which drops the shadow and stops pages and
       canvases from taking the pointer;
     - the title bar had no touch-action, so on a touchscreen the
       browser took the finger for a scroll and cancelled the drag
       after a few pixels;
     - a window as big as the screen could not go left or up at all
       (it was kept fully on screen). It may now hang off any side
       but the top, as long as KEEP_VISIBLE pixels of its bar stay
       reachable. */
  var KEEP_VISIBLE = 120;

  function onDrag(handle, onStart, onMove, onEnd) {
    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;                     // left button only
      if (e.target.classList && e.target.classList.contains("fk-win-btn")) return;
      e.preventDefault();
      var ctx = onStart(e);
      if (ctx === false) return;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* older engine */ }
      if (document.body) document.body.classList.add("fk-dragging");

      function move(ev) { onMove(ev, ctx); }
      function up(ev) {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try { handle.releasePointerCapture(ev.pointerId); } catch (err) { /* already gone */ }
        if (document.body) document.body.classList.remove("fk-dragging");
        if (onEnd) onEnd(ev, ctx);
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function makeDraggable(rec, handle) {
    function place(ev, c) {
      var w = rec.node.offsetWidth || 0;
      var minX = Math.min(0, KEEP_VISIBLE - w);
      c.nx = Math.max(minX, Math.min(c.ox + ev.clientX - c.sx, winLayer.clientWidth - KEEP_VISIBLE));
      c.ny = Math.max(0, Math.min(c.oy + ev.clientY - c.sy, winLayer.clientHeight - 30));
    }
    onDrag(handle, function (e) {
      focus(rec.id);
      /* A maximised window is not draggable — there is nowhere to
         drag it to, and letting it move would leave it maximised and
         half off the screen. */
      if (rec.node.classList.contains("maximized")) return false;
      rec.node.classList.add("moving");
      return { sx: e.clientX, sy: e.clientY,
        ox: rec.node.offsetLeft, oy: rec.node.offsetTop, nx: null, ny: null };
    }, function (ev, c) {
      place(ev, c);
      rec.node.style.transform = "translate(" + (c.nx - c.ox) + "px," + (c.ny - c.oy) + "px)";
    }, function (ev, c) {
      rec.node.classList.remove("moving");
      rec.node.style.transform = "";
      if (c.nx === null) return;                      // a click, not a drag
      rec.node.style.left = c.nx + "px";
      rec.node.style.top = c.ny + "px";
      var r = winLayer.getBoundingClientRect ? winLayer.getBoundingClientRect() : { left: 0, right: winLayer.clientWidth, top: 0 };
      /* Past the edge is not at the edge: a window nearly as wide as a
         Chromebook is pushed left by a pointer that has left the desktop. */
      var x = ev.clientX, y = ev.clientY;
      if (x >= r.left && x <= r.left + SNAP_EDGE) snap(rec.id, "left");
      else if (x <= r.right && x >= r.right - SNAP_EDGE) snap(rec.id, "right");
      else if (y >= r.top && y <= r.top + SNAP_EDGE) toggleMaximise(rec.id);
      else { rec.prevBox = null; rec.snapped = null; saveGeo(rec); }
    });
  }

  /* Half the desktop. It remembers the box it replaced, as maximise does,
     so the same keys bring it back. */
  var SNAP_EDGE = 6;
  function snap(id, side) {
    var rec = windows.get(id);
    if (!rec) return;
    focus(id);
    if (rec.node.classList.contains("maximized")) toggleMaximise(id);
    if (!rec.prevBox) {
      rec.prevBox = { left: rec.node.style.left, top: rec.node.style.top, width: rec.node.style.width, height: rec.node.style.height };
    }
    rec.snapped = side;
    fillHalf(rec);
    saveGeo(rec);
    FieldKit.emit("shell:resize", { id: id });
  }

  function fillHalf(rec) {
    var half = Math.round(winLayer.clientWidth / 2);
    rec.node.style.left = (rec.snapped === "left" ? 0 : winLayer.clientWidth - half) + "px";
    rec.node.style.top = "0px";
    rec.node.style.width = half + "px";
    rec.node.style.height = winLayer.clientHeight + "px";
  }

  /* The desktop changed size: the browser's window, or a notice line at
     the top. A snapped window goes with it, or its bottom is under the
     taskbar. */
  function refit() {
    if (!winLayer) return;
    windows.forEach(function (rec) {
      if (!rec.snapped || rec.node.classList.contains("maximized")) return;
      fillHalf(rec);
      FieldKit.emit("shell:resize", { id: rec.id });
    });
  }

  function readGeo() {
    try {
      var g = JSON.parse(localStorage.getItem(GEO_KEY) || "{}");
      return g && typeof g === "object" && !Array.isArray(g) ? g : {};
    } catch (e) { return {}; }
  }

  function saveGeo(rec) {
    try {
      var g = readGeo(), n = rec.node;
      var max = n.classList.contains("maximized"), box = max && rec.prevBox ? rec.prevBox : n.style;
      g[rec.id] = { x: parseInt(box.left, 10) || 0, y: parseInt(box.top, 10) || 0,
        w: parseInt(box.width, 10) || MIN_W, h: parseInt(box.height, 10) || MIN_H, max: max };
      localStorage.setItem(GEO_KEY, JSON.stringify(g));
    } catch (e) { /* a full quota must not stop a window moving */ }
  }

  /* edge is "se", "e", "s" or "w". West moves the left edge, which
     means changing left and width together — otherwise the window
     grows to the right while the pointer goes left. */
  function makeResizable(rec, grip, edge) {
    onDrag(grip, function (e) {
      e.stopPropagation();
      focus(rec.id);
      if (rec.node.classList.contains("maximized")) return false;
      return { sx: e.clientX, sy: e.clientY,
        ow: rec.node.offsetWidth, oh: rec.node.offsetHeight,
        ox: rec.node.offsetLeft };
    }, function (ev, c) {
      var dx = ev.clientX - c.sx, dy = ev.clientY - c.sy;
      if (edge === "e" || edge === "se") {
        rec.node.style.width = Math.max(MIN_W, c.ow + dx) + "px";
      }
      if (edge === "s" || edge === "se") {
        rec.node.style.height = Math.max(MIN_H, c.oh + dy) + "px";
      }
      if (edge === "w") {
        var w = Math.max(MIN_W, c.ow - dx);
        rec.node.style.width = w + "px";
        rec.node.style.left = Math.max(0, c.ox + (c.ow - w)) + "px";
      }
    }, function () { rec.prevBox = null; rec.snapped = null; saveGeo(rec); });
  }

  var MIN_W = 280, MIN_H = 150;

  /* ---- bigger, two ways -------------------------------------- */

  /* Maximise remembers the geometry it replaced rather than
     recomputing a "sensible" size on restore, because the size you
     had is the only size you asked for. */
  function toggleMaximise(id) {
    var rec = windows.get(id);
    if (!rec) return;
    focus(id);
    if (rec.node.classList.contains("maximized")) {
      var p = rec.prevBox || {};
      rec.node.classList.remove("maximized");
      rec.node.style.left = p.left || "60px";
      rec.node.style.top = p.top || "40px";
      rec.node.style.width = p.width || "620px";
      rec.node.style.height = p.height || "420px";
      rec.prevBox = null;
      rec.snapped = null;
    } else {
      rec.prevBox = {
        left: rec.node.style.left, top: rec.node.style.top,
        width: rec.node.style.width, height: rec.node.style.height
      };
      rec.node.classList.add("maximized");
      rec.node.style.left = ""; rec.node.style.top = "";
      rec.node.style.width = ""; rec.node.style.height = "";
    }
    saveGeo(rec);
    FieldKit.emit("shell:resize", { id: id });
  }

  /* The real thing, on the window element. Asked for by BROWSER
     first — a game in a proxied page cannot take the screen unless
     something above it does — but every module gets it, because a
     diff or a spreadsheet at full screen is worth as much.

     It can be refused: policy on a managed machine, or a call that
     did not come from a real click. A refusal that looks like
     nothing happening is the worst outcome, so it says so. */
  function toggleFullscreen(id) {
    var rec = windows.get(id);
    if (!rec) return;
    focus(id);
    var doc = document;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      return;
    }
    var node = rec.node;
    var go = node.requestFullscreen || node.webkitRequestFullscreen;
    if (!go) { ui.toast("THIS BROWSER HAS NO FULLSCREEN", "warn"); return; }
    var p;
    /* navigationUI:"hide" is a hint, not a promise, and Firefox
       rejects the whole call on an unknown option — so it is passed
       inside a try rather than relied on. */
    try { p = go.call(node, { navigationUI: "hide" }); }
    catch (e) { p = go.call(node); }
    if (p && typeof p.catch === "function") {
      p.catch(function (e) {
        ui.toast("FULLSCREEN REFUSED :: " + (e && e.message ? e.message : "no reason given"), "warn");
      });
    }
  }

  /* The class is what the CSS hangs off, and it has to come off
     again when the user leaves fullscreen by pressing Escape rather
     than by pressing the button — which is how most people leave it. */
  ["fullscreenchange", "webkitfullscreenchange"].forEach(function (evt) {
    document.addEventListener(evt, function () {
      var fs = document.fullscreenElement || document.webkitFullscreenElement;
      windows.forEach(function (rec) {
        rec.node.classList.toggle("fullscreen", rec.node === fs);
      });
      FieldKit.emit("shell:resize", { id: fs ? null : null });
    });
  });

  /* ---- keyboard ----------------------------------------------- */
  function keysBelongElsewhere(e) {
    var t = e.target;
    if (!t || t === window || t === document || t === document.body) return false;
    var tag = String(t.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return true;
    return !!(t.closest && t.closest("[data-fk-keys]"));
  }

  function onKey(e) {
    /* An open folder is on top of everything and was opened last, so
       it is what Escape means — checked before the focused window,
       or Esc would close a window the user cannot currently see. */
    if (e.key === "Escape" && menuNode) { closeMenu(); return; }
    if (e.key === "Escape" && openFolder) { closeFolder(); return; }
    var sh = document.getElementById("fk-sheet");
    if (e.key === "Escape" && sh && sh.parentNode) { sh.parentNode.removeChild(sh); return; }
    /* A page or a program takes its own keys, Esc above all: a game's
       menu is on it, and a form field uses it to cancel. It closed
       BROWSER, and the session with it. */
    if (keysBelongElsewhere(e)) return;
    if (e.key === "Escape" && focused) { close(focused); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "/") { if (e.preventDefault) e.preventDefault(); showKeys(); return; }
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "D" || e.key === "d")) {
      if (e.preventDefault) e.preventDefault();
      showDesktop();
      return;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && focused) {
      if (e.key === "ArrowLeft") { if (e.preventDefault) e.preventDefault(); snap(focused, "left"); return; }
      if (e.key === "ArrowRight") { if (e.preventDefault) e.preventDefault(); snap(focused, "right"); return; }
      if (e.key === "ArrowUp") { if (e.preventDefault) e.preventDefault(); toggleMaximise(focused); return; }
      if (e.key === "ArrowDown") { if (e.preventDefault) e.preventDefault(); minimize(focused); return; }
    }
    if (typedOnDesktop(e)) {
      if (e.preventDefault) e.preventDefault();
      closeFolder();
      searchInput.focus();
      searchInput.value += e.key;
      runSearch();
    }
  }

  /* ---- wallpaper ---------------------------------------------- */
  /* Accepts either a CSS background-image value (the gradient
     presets) or a bare data: URL from an upload — callers should
     not have to remember which needs url() wrapping. */
  function setWallpaper(value) {
    if (!desktop) return;
    if (!value) {
      desktop.style.backgroundImage = "";
      desktop.classList.remove("has-wallpaper");
      return;
    }
    desktop.style.backgroundImage =
      value.indexOf("data:") === 0 ? 'url("' + value + '")' : value;
    desktop.classList.add("has-wallpaper");
  }

  FieldKit.provide("shell", {
    build: build,
    open: open,
    adminOK: adminOK,
    close: close,
    focus: focus,
    minimize: minimize,
    /* Exposed so a module can offer its own control without
       reaching into the window chrome. BROWSER does: a game wants
       the whole screen, and the button for that belongs next to the
       address bar, not only in the title bar. */
    maximize: toggleMaximise,
    snap: snap,
    reopen: reopen,
    showKeys: showKeys,
    showWhatsNew: showWhatsNew,
    fullscreen: toggleFullscreen,
    isFullscreen: function () {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    },
    refreshIcons: refreshIcons,
    /* The search (§21), for the palette and the tests. */
    findApps: findApps,
    search: function (text) { searchInput.value = String(text || ""); runSearch(); return hits.slice(); },
    setWallpaper: setWallpaper,
    openWindows: function () { return Array.from(windows.keys()); },
    showDesktop: showDesktop,
    pins: readPins,
    pin: setPinned,
    tileMenu: tileMenu,
    taskMenu: function (id, x, y) { var r = windows.get(id); return r ? taskMenu(r, x || 0, y || 0) : null; },
    closeMenu: closeMenu,
    clockText: clockText,
    desktop: function () { return desktop; }
  });
})(window.FieldKit);
