/* ============================================================
   FieldKit lens :: the page

   What a person sees: a toolbar and the page they asked for. The page
   runs here, in their browser, through Scramjet (a service worker that
   rewrites it) and libcurl.js (its TLS, in WebAssembly), and every
   connection it makes goes over one WebSocket to FieldKit's lens server
   (lens/wisp.js), which blocks what the relay blocks. The server only
   ever carries encrypted bytes: TLS is made and read here.

   EACH SITE IN A ROOM OF ITS OWN (0.16.3). A site runs in a slot
   (slot.html, slot.js) on an origin of its own, s0.<this host> to
   s15.<this host>, so the browser keeps its storage and sign-ins apart
   from every other site's and from this page, which holds the pass and
   the history. A slot given to a new site is wiped first. A site's own
   frames (a video, a game) stay in its slot, as a browser keeps them.
   When the slot names do not answer (no DNS for them yet), every site
   shares one slot on this origin, and the page says it is not private.

   HOW IT IS OPENED. FieldKit's BROWSER asks the relay for a PASS (a
   signed note naming the account, 12 hours) and opens this page with it
   in the address's fragment: /#p=<pass>&u=<where to go>. A fragment is
   never sent to any server, and it is taken out of the address bar at
   once and kept in this tab's sessionStorage only.

   INSIDE BROWSER (an iframe) the panel and this page talk by
   postMessage, always tagged fk:"lens":
     out: ready, nav {url,title}, blocked {host,kind,why}, expired, failed {why},
          password {host} (a password box was touched), private {on}
          (whether sites have rooms of their own), stream {url} (a site
          lens cannot play: open it in full mode)
     in:  go {url}, pass {pass}, back, forward, reload
   On its own tab, it works the same with nobody listening.
   ============================================================ */
(function () {
  "use strict";

  var L = self.FK_LENS, CODEC = L.CODEC, siteOf = L.siteOf;
  var PASS_KEY = "fk.lens.pass", SLOTS_KEY = "fk.lens.slots.v1", ISO_KEY = "fk.lens.rooms";
  var SLOTS = 16;
  /* DuckDuckGo's plain page, strict safe search: a tenth of the main
     page's bytes, against the month's allowance. Any other engine is an
     address away. */
  var SEARCH = "https://html.duckduckgo.com/html/?kp=1&q=";
  var RENEW_MS = 10 * 60 * 1000;
  var embedded = window.parent !== window;
  function unmask(x) { return x ? CODEC.decode(x) : ""; }

  var $ = function (id) { return document.getElementById(id); };
  var addr = $("addr"), note = $("note"), view = $("view"), start = $("start"), state = $("state");

  /* ---- the pass ---------------------------------------------------- */
  var hash = new URLSearchParams(location.hash.slice(1));
  var pass = hash.get("p") || "";
  var first = hash.get("u") || unmask(hash.get("x") || "");
  try {
    if (pass) sessionStorage.setItem(PASS_KEY, pass);
    else pass = sessionStorage.getItem(PASS_KEY) || "";
  } catch (e) { /* storage off: the pass lives in this variable only */ }
  if (location.hash) history.replaceState(null, "", location.pathname);

  function claims(p) {
    try {
      var b = String(p).split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(b + "===".slice((b.length + 3) % 4)));
    } catch (e) { return null; }
  }
  function passLeft() { var c = claims(pass); return c && c.exp ? c.exp - Date.now() : -1; }

  function tell(msg) {
    if (!embedded) return;
    msg.fk = "lens";
    try { window.parent.postMessage(msg, "*"); } catch (e) {}
  }

  function say(text, level, keep, act) {
    note.hidden = !text;
    note.className = level || "";
    note.textContent = "";
    if (!text) return;
    var t = document.createElement("span");
    t.textContent = text;
    note.appendChild(t);
    if (act) {
      var b = document.createElement("button");
      b.className = "act"; b.type = "button"; b.textContent = act.label;
      b.onclick = function () { say(""); act.run(); };
      note.appendChild(b);
    }
    var x = document.createElement("button");
    x.className = "x"; x.type = "button"; x.textContent = "✕"; x.title = "close";
    x.onclick = function () { say(""); };
    note.appendChild(x);
    if (!keep) setTimeout(function () { if (note.firstChild === t) say(""); }, 9000);
  }

  /* ---- rooms: may sites have origins of their own here? -------------- */
  var rooms = false, ready = false;
  function slotOrigin(n) { return n < 0 ? location.origin : location.protocol + "//s" + n + "." + location.host; }

  async function probeRooms() {
    try { var k = sessionStorage.getItem(ISO_KEY); if (k === "1" || k === "0") return k === "1"; } catch (e) {}
    if (/^s\d{1,2}\./.test(location.host) || /^[\d.]+(:\d+)?$/.test(location.host) || /^\[/.test(location.host)) return false;
    var ok = false;
    try {
      var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 5000);
      var r = await fetch(slotOrigin(0) + "/lens/status", { cache: "no-store", mode: "cors", signal: ctl.signal });
      clearTimeout(t);
      ok = r.ok && !!(await r.json()).up;
    } catch (e) { ok = false; }
    try { sessionStorage.setItem(ISO_KEY, ok ? "1" : "0"); } catch (e) {}
    return ok;
  }

  function showMode() {
    $("warn").textContent = rooms
      ? "Each site here has a space of its own: other sites cannot read what it keeps. Ads, trackers and adult sites are blocked."
      : "⚠ Not private: do not sign in to anything here. Sites in this browser share one space and can read each other's sign-ins.";
    $("warn").className = rooms ? "ok" : "";
    $("start-warn").textContent = rooms
      ? "Each site runs on its own here, apart from the others, and the server only passes on encrypted bytes. " +
        "Signing in is fine on sites you trust; sign out when you finish if other people use this computer."
      : "Do not sign in to anything here: no email, no school account, no social media, no shopping. " +
        "Every site in this browser shares one space, so it is not private.";
    tell({ t: "private", on: rooms });
  }

  /* ---- the slots ----------------------------------------------------- */
  function loadMap() {
    try { var m = JSON.parse(localStorage.getItem(SLOTS_KEY) || "{}"); return m && typeof m === "object" ? m : {}; }
    catch (e) { return {}; }
  }
  function saveMap(m) { try { localStorage.setItem(SLOTS_KEY, JSON.stringify(m)); } catch (e) {} }

  /* The slot for a site: the one it had, or a free one, or the one used
     longest ago. A slot that changes hands is wiped first. */
  function slotFor(site) {
    var m = loadMap(), now = Date.now();
    if (m[site] && m[site].n >= 0 && m[site].n < SLOTS) { m[site].at = now; saveMap(m); return { n: m[site].n, wipe: false }; }
    var used = {}, oldest = null;
    Object.keys(m).forEach(function (s) {
      used[m[s].n] = s;
      if (!oldest || m[s].at < m[oldest].at) oldest = s;
    });
    var n = -1;
    for (var i = 0; i < SLOTS; i++) if (!(i in used)) { n = i; break; }
    if (n < 0) { n = m[oldest].n; delete m[oldest]; }
    m[site] = { n: n, at: now };
    saveMap(m);
    return { n: n, wipe: true };
  }

  var cur = null;           /* { n, site, origin, el, up, queue } */
  function drop() {
    if (cur) { try { cur.el.remove(); } catch (e) {} }
    cur = null;
  }
  function post(msg) {
    if (!cur) return;
    msg.fk = "slot";
    if (!cur.up && msg.t !== "init") { cur.queue.push(msg); return; }
    try { cur.el.contentWindow.postMessage(msg, cur.origin); } catch (e) {}
  }

  function openSlot(site) {
    var s = rooms ? slotFor(site) : { n: -1, wipe: false };
    drop();
    var el = document.createElement("iframe");
    el.setAttribute("allow", "fullscreen; autoplay; clipboard-write; gamepad");
    el.setAttribute("allowfullscreen", "");
    el.className = "slot";
    cur = { n: s.n, site: rooms ? site : "", origin: slotOrigin(s.n), el: el, up: false, queue: [] };
    el.src = cur.origin + "/slot.html" + (s.wipe ? "?wipe=1" : "");
    view.appendChild(el);
    return cur;
  }

  /* ---- history across slots ----------------------------------------- */
  var trail = [], at = -1;

  /* Open an address: in the slot of its site, the current one when it is
     the same site. how: "new" (a fresh step), "replace", or "history". */
  function open(u, how) {
    if (handOff(u)) return;
    var site = siteOf(u);
    if (how === "new") { trail = trail.slice(0, at + 1); trail.push({ url: u }); at = trail.length - 1; }
    else if (how === "replace" && at >= 0) trail[at] = { url: u };
    else if (how === "replace") { trail = [{ url: u }]; at = 0; }
    say("");
    start.hidden = true;
    addr.value = u;
    if (!cur || (rooms && cur.site !== site)) openSlot(site);
    post({ t: "go", url: u });
    setTimeout(function () { why(hostOf(u)); }, 5000);
  }

  function move(dir) {
    if (cur) post({ t: dir < 0 ? "back" : "forward" });
    else if (dir < 0 && at >= 0) { at = Math.max(0, at); open(trail[at].url, "history"); }
  }
  function moved(m) {
    if (m.ok) return;
    var to = at + m.dir;
    if (to < 0 || to >= trail.length) return;
    at = to;
    open(trail[at].url, "history");
  }

  /* ---- messages from the slot ---------------------------------------- */
  var warnedFor = "";
  window.addEventListener("message", function (e) {
    if (!cur || e.source !== cur.el.contentWindow || e.origin !== cur.origin) return;
    var m = e.data;
    if (!m || m.fk !== "slot") return;
    if (m.t === "hello") {
      cur.up = false;
      try { cur.el.contentWindow.postMessage({ fk: "slot", t: "init", pass: pass, site: cur.site }, cur.origin); } catch (x) {}
    } else if (m.t === "ready") {
      cur.up = true;
      var q = cur.queue; cur.queue = [];
      q.forEach(post);
    } else if (m.t === "failed") {
      fail(String(m.why || "Lens could not start here.") + (embedded ? " Try TAB above to open it in a tab of its own." : ""));
    } else if (m.t === "nav" || m.t === "loaded") {
      var u = String(m.url || "");
      /* A slot speaks for its own site only. A page there that got past
         Scramjet could post as the slot; it still cannot make the address
         bar name another site over its own page. */
      if (rooms && cur.site && siteOf(u) !== cur.site) return;
      if (handOff(u)) { post({ t: "back" }); return; }
      if (at >= 0) trail[at] = { url: u };
      if (document.activeElement !== addr) addr.value = u;
      /* The tab's title stays FieldKit's: a monitor reads titles too. */
      tell({ t: "nav", url: u, title: String(m.title || "") });
      if (m.t === "loaded") why(hostOf(u));
    } else if (m.t === "foreign") {
      var to = String(m.url || "");
      if (/^https?:\/\//i.test(to)) open(to, m.replace ? "replace" : "new");
    } else if (m.t === "moved") {
      moved(m);
    } else if (m.t === "password") {
      var h = String(m.host || ""), inside = rooms ? String(m.inside || "") : "";
      if (warnedFor === h + " " + inside) return;
      warnedFor = h + " " + inside;
      var own = "";
      try { own = new URL(String(m.url || "")).origin + "/"; } catch (x) { own = ""; }
      if (inside && /^https?:/i.test(own)) {
        say("STOP: this sign-in box is " + h + "'s, set into " + inside + "'s page, so " + inside +
          " could read what you type in it. To sign in to " + h + ", open it on its own.", "fail", true,
          { label: "OPEN " + h.toUpperCase() + " ON ITS OWN", run: function () { open(own, "new"); } });
      } else if (rooms) {
        say("Signing in to " + h + ": it has a space of its own here that other sites cannot read. " +
          "Only sign in to sites you trust, and sign out when you finish if other people use this computer.", "warn", false);
      } else {
        say("STOP: do not type a password here. This browser is not private: sites in it can read " +
          "each other's sign-ins. Sign in to things only in your own browser" +
          (embedded ? ", or in BROWSER's FULL MODE if an admin has given you it." : "."), "fail", true);
      }
      tell({ t: "password", host: h, private: rooms && !inside });
    }
  });

  /* ---- start ----------------------------------------------------------- */
  async function boot() {
    if (!pass) return fail("This page needs to be opened from BROWSER in FieldKit, which signs you in to it.");
    if (passLeft() <= 0) return expired();
    if (!("serviceWorker" in navigator)) return fail("This browser does not allow the service worker lens needs.");
    try {
      var st = await fetch("/lens/status", { cache: "no-store" }).then(function (r) { return r.json(); });
      youtubeHere = !!(st && st.youtube);
    } catch (e) { youtubeHere = false; }
    rooms = await probeRooms();
    showMode();
    ready = true;
    state.textContent = "Ready.";
    tell({ t: "ready" });
    if (first) go(first);
    else $("search").focus();
  }

  function fail(why) {
    state.textContent = why;
    state.className = "p";
    say(why, "fail", true);
    tell({ t: "failed", why: why });
  }

  function expired() {
    ready = false;
    tell({ t: "expired" });
    if (!embedded) fail("Your pass for this page has run out. Open BROWSER in FieldKit again.");
  }

  /* An address, or words to search for. */
  function target(text) {
    var s = String(text || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return "https://" + s;
    return SEARCH + encodeURIComponent(s);
  }

  function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ""; } }

  /* YouTube will not play for a rented server's address ("Sign in to
     confirm you're not a bot"). When the server sends YouTube out through
     WARP or a bought address (lens/egress.js) its status says youtube,
     and YouTube plays here like any site. Otherwise BROWSER's streamed
     mode plays it from home, so inside BROWSER it is handed over there;
     on a tab of its own, said. */
  var HANDOFF = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;
  var youtubeHere = false;
  function handOff(u) {
    if (youtubeHere || !HANDOFF.test(hostOf(u))) return false;
    if (embedded) {
      tell({ t: "stream", url: u });
      say("YouTube opens in BROWSER's full mode, which can play it.", "warn");
    } else {
      say("YouTube will not play here. Open it from BROWSER in FieldKit, in full mode.", "warn", true);
    }
    return true;
  }

  /* After a page loads, ask the server whether its own site was refused,
     so a blocked or missing site says so instead of a blank error. */
  async function why(host) {
    if (!host) return;
    try {
      var r = await fetch("/lens/why", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: host, pass: pass }) });
      if (r.status === 401) return expired();
      var j = await r.json();
      if (!j || !j.host) return;
      var words = j.kind === "missing" ? j.why : j.host + " was not opened: " + j.why;
      say(words, j.kind === "missing" ? "warn" : "fail", true);
      tell({ t: "blocked", host: j.host, kind: j.kind, why: j.why });
    } catch (e) { /* the server will say it again next time */ }
  }

  function go(text) {
    var u = target(text);
    if (!u) return;
    if (!ready) { first = u; return; }
    if (passLeft() <= 0) return expired();
    open(u, "new");
  }

  function home() {
    drop();
    start.hidden = false;
    addr.value = "";
    document.title = "FieldKit BROWSER";
    $("search").focus();
  }

  /* ---- controls ---------------------------------------------------- */
  $("go-form").addEventListener("submit", function (e) { e.preventDefault(); go(addr.value); });
  $("search-form").addEventListener("submit", function (e) { e.preventDefault(); go($("search").value); });
  $("go").onclick = function () { go(addr.value); };
  $("back").onclick = function () { move(-1); };
  $("fwd").onclick = function () { move(1); };
  $("reload").onclick = function () { post({ t: "reload" }); };
  $("home").onclick = home;
  addr.addEventListener("focus", function () { addr.select(); });

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) { e.preventDefault(); addr.focus(); }
    if (e.key === "F5" && cur) { e.preventDefault(); post({ t: "reload" }); }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); move(1); }
  });

  /* From BROWSER, the panel this page sits in, and from nobody else. */
  window.addEventListener("message", function (e) {
    if (!embedded || e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.fk !== "lens") return;
    if (m.t === "go") go(m.url);
    else if (m.t === "back") move(-1);
    else if (m.t === "forward") move(1);
    else if (m.t === "reload") post({ t: "reload" });
    else if (m.t === "pass" && typeof m.pass === "string" && m.pass) {
      pass = m.pass;
      try { sessionStorage.setItem(PASS_KEY, pass); } catch (x) {}
      if (cur && cur.up) post({ t: "pass", pass: pass });
      if (!ready) boot();
    }
  });

  /* A pass lasts 12 hours. Inside BROWSER a fresh one is asked for
     before it runs out; on its own tab, the person is told. */
  setInterval(function () {
    var left = passLeft();
    if (left > 0 && left < RENEW_MS) tell({ t: "expired" });
    if (left <= 0 && ready) expired();
  }, 60000);

  boot();
})();
