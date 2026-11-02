/* ============================================================
   FieldKit lens :: the page

   What a person sees: a toolbar and the page they asked for. The page
   runs here, in their browser, through Scramjet (a service worker that
   rewrites it) and libcurl.js (its TLS, in WebAssembly), and every
   connection it makes goes over one WebSocket to FieldKit's lens server
   (lens/wisp.js), which blocks what the relay blocks.

   HOW IT IS OPENED. FieldKit's BROWSER asks the relay for a PASS (a
   signed note naming the account, 12 hours) and opens this page with it
   in the address's fragment: /#p=<pass>&u=<where to go>. A fragment is
   never sent to any server, and it is taken out of the address bar at
   once and kept in this tab's sessionStorage only.

   INSIDE BROWSER (an iframe) the panel and this page talk by
   postMessage, always tagged fk:"lens":
     out: ready, nav {url,title}, blocked {host,kind,why}, expired, failed {why},
          stream {url} (a site lens cannot play: open it in full mode)
     in:  go {url}, pass {pass}, back, forward, reload
   On its own tab, it works the same with nobody listening.
   ============================================================ */
(function () {
  "use strict";

  var V = { scram: "/v/scramjet-1.1.0-fk1/", mux: "/v/bare-mux-2.1.9/", curl: "/v/libcurl-transport-1.5.2/" };
  var PASS_KEY = "fk.lens.pass";
  /* DuckDuckGo's plain page, strict safe search: a tenth of the main
     page's bytes, against the month's allowance, and the main page is
     the quicker of the two to ask a shared server's address to prove
     it is human. Any other engine is an address away. */
  var SEARCH = "https://html.duckduckgo.com/html/?kp=1&q=";
  var RENEW_MS = 10 * 60 * 1000;
  var embedded = window.parent !== window;

  var $ = function (id) { return document.getElementById(id); };
  var addr = $("addr"), note = $("note"), view = $("view"), start = $("start"), state = $("state");

  /* ---- the pass ---------------------------------------------------- */
  var hash = new URLSearchParams(location.hash.slice(1));
  var pass = hash.get("p") || "";
  var first = hash.get("u") || "";
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

  function say(text, level, keep) {
    note.hidden = !text;
    note.className = level || "";
    note.textContent = "";
    if (!text) return;
    var t = document.createElement("span");
    t.textContent = text;
    note.appendChild(t);
    var x = document.createElement("button");
    x.className = "x"; x.type = "button"; x.textContent = "✕"; x.title = "close";
    x.onclick = function () { say(""); };
    note.appendChild(x);
    if (!keep) setTimeout(function () { if (note.firstChild === t) say(""); }, 9000);
  }

  /* ---- Scramjet ---------------------------------------------------- */
  var scramjet = null, connection = null, frame = null, ready = false;

  function wispUrl() {
    /* In the path, not the query: libcurl.js wants the address to end in "/". */
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/" + encodeURIComponent(pass) + "/";
  }

  async function setTransport() {
    await connection.setTransport(V.curl + "index.mjs", [{ websocket: wispUrl() }]);
  }

  async function boot() {
    if (!pass) return fail("This page needs to be opened from BROWSER in FieldKit, which signs you in to it.");
    if (passLeft() <= 0) return expired();
    if (!("serviceWorker" in navigator)) return fail("This browser does not allow the service worker lens needs.");
    try {
      var Loader = window.$scramjetLoadController;
      scramjet = new (Loader().ScramjetController)({
        files: { wasm: V.scram + "scramjet.wasm.wasm", all: V.scram + "scramjet.all.js", sync: V.scram + "scramjet.sync.js" }
      });
      await scramjet.init();
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      connection = new BareMux.BareMuxConnection(V.mux + "worker.js");
      await setTransport();
    } catch (e) {
      return fail("Lens could not start here: " + (e && e.message || e) +
        (embedded ? ". Try TAB above to open it in a tab of its own." : "."));
    }
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
     confirm you're not a bot", and no video at all), whatever lens does.
     BROWSER's streamed mode plays it from the relay's own connection, so
     inside BROWSER it is handed over there; on a tab of its own, said. */
  var HANDOFF = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;
  function handOff(u) {
    if (!HANDOFF.test(hostOf(u))) return false;
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
      var r = await fetch("/lens/why?host=" + encodeURIComponent(host) + "&pass=" + encodeURIComponent(pass), { cache: "no-store" });
      if (r.status === 401) return expired();
      var j = await r.json();
      if (!j || !j.host) return;
      var words = j.kind === "missing" ? j.why : j.host + " was not opened: " + j.why;
      say(words, j.kind === "missing" ? "warn" : "fail", true);
      tell({ t: "blocked", host: j.host, kind: j.kind, why: j.why });
    } catch (e) { /* the server will say it again next time */ }
  }

  function ensureFrame() {
    if (frame) return frame;
    frame = scramjet.createFrame();
    frame.frame.setAttribute("allow", "fullscreen; autoplay; clipboard-write; gamepad");
    frame.frame.setAttribute("allowfullscreen", "");
    view.appendChild(frame.frame);
    frame.addEventListener("urlchange", function (e) {
      var u = String(e.url || "");
      /* A link to YouTube clicked inside some other site: back to the
         page it came from, and over to the mode that can play it. */
      if (handOff(u)) { frame.back(); return; }
      if (document.activeElement !== addr) addr.value = u;
      var title = "";
      try { title = frame.frame.contentDocument.title || ""; } catch (x) {}
      document.title = (title || hostOf(u) || "BROWSER") + " — FieldKit";
      tell({ t: "nav", url: u, title: title });
    });
    frame.frame.addEventListener("load", function () {
      var u = "", title = "";
      try { u = String(frame.url || ""); } catch (x) {}
      if (!u) return;
      why(hostOf(u));
      /* urlchange comes before the page has a title; now it has one. */
      try { title = frame.frame.contentDocument.title || ""; } catch (x) {}
      if (title) {
        document.title = title + " — FieldKit";
        tell({ t: "nav", url: u, title: title });
      }
    });
    return frame;
  }

  async function go(text) {
    var u = target(text);
    if (!u) return;
    if (!ready) { first = u; return; }
    if (passLeft() <= 0) return expired();
    if (handOff(u)) return;
    say("");
    start.hidden = true;
    addr.value = u;
    ensureFrame().go(u);
    setTimeout(function () { why(hostOf(u)); }, 4000);
  }

  function home() {
    if (frame) { frame.frame.remove(); frame = null; }
    start.hidden = false;
    addr.value = "";
    document.title = "FieldKit BROWSER";
    $("search").focus();
  }

  /* ---- controls ---------------------------------------------------- */
  $("go-form").addEventListener("submit", function (e) { e.preventDefault(); go(addr.value); });
  $("search-form").addEventListener("submit", function (e) { e.preventDefault(); go($("search").value); });
  $("go").onclick = function () { go(addr.value); };
  $("back").onclick = function () { if (frame) frame.back(); };
  $("fwd").onclick = function () { if (frame) frame.forward(); };
  $("reload").onclick = function () { if (frame) frame.reload(); };
  $("home").onclick = home;
  addr.addEventListener("focus", function () { addr.select(); });

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) { e.preventDefault(); addr.focus(); }
    if (e.key === "F5" && frame) { e.preventDefault(); frame.reload(); }
    if (e.altKey && e.key === "ArrowLeft" && frame) { e.preventDefault(); frame.back(); }
    if (e.altKey && e.key === "ArrowRight" && frame) { e.preventDefault(); frame.forward(); }
  });

  /* From BROWSER, the panel this page sits in, and from nobody else. */
  window.addEventListener("message", function (e) {
    if (!embedded || e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.fk !== "lens") return;
    if (m.t === "go") go(m.url);
    else if (m.t === "back" && frame) frame.back();
    else if (m.t === "forward" && frame) frame.forward();
    else if (m.t === "reload" && frame) frame.reload();
    else if (m.t === "pass" && typeof m.pass === "string" && m.pass) {
      pass = m.pass;
      try { sessionStorage.setItem(PASS_KEY, pass); } catch (x) {}
      if (connection) setTransport().then(function () { if (!ready) { ready = true; state.textContent = "Ready."; } }, function () {});
      else boot();
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
