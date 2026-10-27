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
    iconLayer = el("div", { id: "fk-icons" }, [buildSearch(), shelves]);
    winLayer = el("div", { id: "fk-windows" });
    taskList = el("div", { id: "fk-tasks" });
    tray = el("div", { id: "fk-tray" });
    taskbar = el("div", { id: "fk-taskbar" }, [
      el("span", { class: "brand", text: "FIELDKIT" }), taskList, tray
    ]);
    desktop.appendChild(iconLayer);
    desktop.appendChild(winLayer);
    desktop.appendChild(taskbar);
    root.appendChild(desktop);

    buildTray();
    refreshIcons();

    FieldKit.on("module:registered", refreshIcons);
    FieldKit.on("module:failed", refreshIcons);
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("mousedown", function (e) {
      var inWin = false;
      windows.forEach(function (r) { if (r.node.contains(e.target)) inWin = true; });
      keysToWindow = inWin;
    }, true);
    return desktop;
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
    var d = new Date();
    trayClock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return String(n).padStart(2, "0"); }).join(":");
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
    if (t === "relay") return "RELAY ONLINE";
    if (t === "local") return "LOCAL ONLY — NO RELAY";
    if (t === "memory") return "MEMORY ONLY";
    return "ONLINE";
  }

  function renderStoreState(e) {
    var s = (e && e.state) || "INIT";
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
    if (s === "ONLINE" && m[1] !== "RELAY ONLINE") m = ["warn", m[1]];
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
      return !!m && !m.inside && (!guest || guest.allowed(m));
    };
    var ids = Object.keys(u).filter(usable).sort(function (a, b) {
      return usageScore(u[b], now) - usageScore(u[a], now) || a.localeCompare(b);
    }).slice(0, TOP_MAX);
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
      if (mods[id].inside) return;
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
      el("span", { class: "n", text: "Search notes, records and commands for “" + q + "”" }),
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
  var GROUP_ORDER = ["ONLINE", "FILES", "PROJECT", "SERVERS", "TOOLS", "SYSTEM"];
  /* Inside a folder, the everyday ones first; that is also which four
     glyphs its card shows. Anything not listed follows, by name. */
  var APP_ORDER = ["browser", "messages", "runner", "ai-chat", "ai-local",
    "vault-files", "scratchpad", "snippet-library", "backup-panel", "asset-library", "savecode", "config-vault",
    "task-board", "playtest-log", "git-console", "decisions", "changelog", "incident-log", "code-diff", "guestbook",
    "bastion", "relay-config", "link-doctor", "topology", "mesh-planner",
    "terminal", "dev-tools", "critter-ref", "game-math", "qr-gen", "security-mockup",
    "settings-panel", "settings-outpost", "updater", "help", "home", "selftest-panel", "achievements", "build-manifest"];
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
    return el("button", {
      class: "fk-app", type: "button", title: m.title + (m.about ? " — " + m.about : ""),
      onclick: function () { closeFolder(); open(id); },
      onpointerenter: function () { prewarm(id, m); },
      ontouchstart: function () { prewarm(id, m); },
      onfocus: function () { prewarm(id, m); }
    }, [
      el("span", { class: "g", text: m.icon }),
      el("span", { class: "n", text: m.title })
    ]);
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
      if (mods[id].inside) return;
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
    var mod = FieldKit.module(id);
    if (!mod) { ui.toast("NO SUCH MODULE :: " + id, "fail"); return null; }

    /* Checked here as well as in refreshIcons: the command palette and
       any future caller reach open() directly. */
    var guest = FieldKit.service("guest");
    if (guest && !guest.allowed(mod)) {
      ui.toast("SEALED :: " + mod.title, "warn");
      return null;
    }

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
    var x = 130 + (cascade % 6) * 26;
    var y = 40 + (cascade % 6) * 24;
    cascade++;

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

    makeDraggable(rec, bar);
    grips.forEach(function (g) { makeResizable(rec, g, g.getAttribute("data-edge")); });
    node.addEventListener("mousedown", function () { focus(id); });

    addTask(rec);
    focus(id);

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
        if (rec.node.classList.contains("minimized")) { rec.node.classList.remove("minimized"); focus(rec.id); }
        else if (focused === rec.id) minimize(rec.id);
        else focus(rec.id);
      } });
    taskList.appendChild(rec.task);
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
     that happens to be under the pointer later. */
  function onDrag(handle, onStart, onMove) {
    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;                     // left button only
      if (e.target.classList && e.target.classList.contains("fk-win-btn")) return;
      e.preventDefault();
      var ctx = onStart(e);
      if (ctx === false) return;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* older engine */ }

      function move(ev) { onMove(ev, ctx); }
      function up(ev) {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try { handle.releasePointerCapture(ev.pointerId); } catch (err) { /* already gone */ }
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function makeDraggable(rec, handle) {
    onDrag(handle, function (e) {
      focus(rec.id);
      /* A maximised window is not draggable — there is nowhere to
         drag it to, and letting it move would leave it maximised and
         half off the screen. */
      if (rec.node.classList.contains("maximized")) return false;
      return { sx: e.clientX, sy: e.clientY,
        ox: rec.node.offsetLeft, oy: rec.node.offsetTop };
    }, function (ev, c) {
      var nx = Math.max(0, Math.min(c.ox + ev.clientX - c.sx, winLayer.clientWidth - 80));
      var ny = Math.max(0, Math.min(c.oy + ev.clientY - c.sy, winLayer.clientHeight - 30));
      rec.node.style.left = nx + "px";
      rec.node.style.top = ny + "px";
    });
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
    });
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
    } else {
      rec.prevBox = {
        left: rec.node.style.left, top: rec.node.style.top,
        width: rec.node.style.width, height: rec.node.style.height
      };
      rec.node.classList.add("maximized");
      rec.node.style.left = ""; rec.node.style.top = "";
      rec.node.style.width = ""; rec.node.style.height = "";
    }
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
  function onKey(e) {
    /* An open folder is on top of everything and was opened last, so
       it is what Escape means — checked before the focused window,
       or Esc would close a window the user cannot currently see. */
    if (e.key === "Escape" && openFolder) { closeFolder(); return; }
    if (e.key === "Escape" && focused) { close(focused); return; }
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
    close: close,
    focus: focus,
    minimize: minimize,
    /* Exposed so a module can offer its own control without
       reaching into the window chrome. BROWSER does: a game wants
       the whole screen, and the button for that belongs next to the
       address bar, not only in the title bar. */
    maximize: toggleMaximise,
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
    desktop: function () { return desktop; }
  });
})(window.FieldKit);
