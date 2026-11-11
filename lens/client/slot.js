/* ============================================================
   FieldKit lens :: a slot

   One site runs here, in its own origin (s0.<lens host> … s15.<lens
   host>), so the browser itself keeps it apart from every other site:
   its storage, its sign-ins, its service worker and Scramjet's cookie
   store are this origin's and no one else's. The lens page (lens.js)
   chooses the slot for a site, wipes a slot before giving it to a new
   site, and keeps the pass, the toolbar and the history, none of which
   a site can reach from here.

   When the lens host has no slot names (no DNS for them yet), lens.js
   loads this page from its own origin as the one shared slot: every
   site together, as before 0.16.3, and the page says it is not private.

   Talks only to the lens page that holds it, by postMessage, tagged
   fk:"slot":
     out: hello, ready, failed {why}, nav {url,title}, loaded {url,title},
          foreign {url, replace, popup}, moved {dir, ok},
          password {host, inside?, url?} (inside: the site whose page holds it)
     in:  init {pass, site}, go {url}, back, forward, reload, pass {pass}
   ============================================================ */
(function () {
  "use strict";

  var V = { scram: "/v/scramjet-1.1.0-fk2/", mux: "/v/bare-mux-2.1.9/", curl: "/v/libcurl-transport-1.5.2-fk1/" };
  var L = self.FK_LENS, CODEC = L.CODEC, PREFIX = L.PREFIX, siteOf = L.siteOf;

  /* A slot that was just given to another site is opened once with
     ?wipe=1: the server answers that with Clear-Site-Data, so the last
     site's storage, cookies and service worker are gone, and the slot
     starts again clean. */
  if (/[?&]wipe=1/.test(location.search)) { location.replace(location.pathname); return; }

  var SLOT = /^s(\d{1,2})\./.exec(location.host);
  var TOP = location.protocol + "//" + (SLOT ? location.host.slice(SLOT[0].length) : location.host);
  if (window.parent === window) {
    document.body.textContent = "This is part of FieldKit BROWSER and only works inside it.";
    return;
  }

  function tell(msg) {
    msg.fk = "slot";
    try { window.parent.postMessage(msg, TOP); } catch (e) {}
  }

  var pass = "", site = "", scramjet = null, connection = null, frame = null, ready = false;
  var stack = [], at = -1, moving = 0;

  function wispUrl() {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/" + encodeURIComponent(pass) + "/";
  }
  function setTransport() { return connection.setTransport(V.curl + "index.mjs", [{ websocket: wispUrl() }]); }

  async function boot() {
    if (!("serviceWorker" in navigator)) return tell({ t: "failed", why: "This browser does not allow the service worker lens needs." });
    try {
      var Loader = window.$scramjetLoadController;
      scramjet = new (Loader().ScramjetController)({
        prefix: PREFIX,
        codec: { encode: CODEC.encode, decode: CODEC.decode },
        files: { wasm: V.scram + "scramjet.wasm.wasm", all: V.scram + "scramjet.all.js", sync: V.scram + "scramjet.sync.js" }
      });
      await scramjet.init();
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      connection = new BareMux.BareMuxConnection(V.mux + "worker.js");
      await setTransport();
    } catch (e) {
      return tell({ t: "failed", why: "Lens could not start here: " + (e && e.message || e) });
    }
    ready = true;
    tell({ t: "ready" });
  }

  function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ""; } }
  function titleOf() { try { return frame.frame.contentDocument.title || ""; } catch (x) { return ""; } }

  function ensureFrame() {
    if (frame) return frame;
    frame = scramjet.createFrame();
    frame.frame.setAttribute("allow", "fullscreen; autoplay; clipboard-write; gamepad");
    frame.frame.setAttribute("allowfullscreen", "");
    document.body.appendChild(frame.frame);

    /* Another site, loading in this slot's own frame (a link, a
       redirect, a script moving the page): stopped before any of its
       scripts run, which is the moment Scramjet hooks a new page, and
       handed back to the lens page to open in that site's own slot.
       Frames inside a page (a video player, a game) stay with the page
       that holds them, as a browser keeps a site's embeds with it. */
    frame.addEventListener("contextInit", function (ev) {
      var u = "";
      try { u = String(ev.client.url.href); } catch (x) { return; }
      var isTop = ev.window === frame.frame.contentWindow;
      if (!site || !isTop || !/^https?:/i.test(u) || siteOf(u) === site) return guard(ev.window, ev.client, isTop);
      try { ev.window.stop(); } catch (x) {}
      try { ev.window.document.documentElement.innerHTML = ""; } catch (x) {}
      var replace = at < 0;
      tell({ t: "foreign", url: u, replace: replace });
      if (replace) frame.frame.src = "about:blank";
      else { moving++; frame.back(); }
    });

    frame.addEventListener("urlchange", function (e) {
      var u = String(e.url || "");
      if (!/^https?:/i.test(u)) return;
      if (site && siteOf(u) !== site) return;      /* contextInit has it */
      if (moving > 0) moving--;
      else if (stack[at] !== u) { stack = stack.slice(0, at + 1); stack.push(u); at = stack.length - 1; }
      tell({ t: "nav", url: u, title: titleOf() });
    });
    frame.frame.addEventListener("load", function () {
      var u = "";
      try { u = String(frame.url || ""); } catch (x) {}
      if (u && /^https?:/i.test(u)) tell({ t: "loaded", url: u, title: titleOf() });
    });
    return frame;
  }

  /* The address a page's link or form really points at. Scramjet shows
     a page its own addresses, but the element itself may hold the
     rewritten one (<this origin>/c/<letters>), now and then rewritten
     twice over; whichever it is, it is read back to the site's own. */
  function realOf(h) {
    var u = String(h || "");
    for (var i = 0; i < 4; i++) {
      try {
        var x = new URL(u, location.href);
        if (x.origin !== location.origin || x.pathname.indexOf(PREFIX) !== 0) return x.href;
        u = CODEC.decode(x.pathname.slice(PREFIX.length) + x.search + x.hash);
      } catch (e) { return ""; }
    }
    return "";
  }
  function foreignTo(u) { return !!site && /^https?:/i.test(u) && siteOf(u) !== site; }

  /* Every page and frame in this slot, before its own scripts run:

     A WINDOW OR TAB FOR ANOTHER SITE (window.open, a link with
     target=_blank) would open on this slot's origin, so that site would
     run in this one's space, where this site's scripts could reach it:
     the classic case is a "Sign in with Google" window. It is opened by
     the lens page instead, in that site's own space, and the page that
     asked gets no window back, as when a browser blocks a popup. Sites
     then sign in by moving the whole page, which works.

     A PASSWORD BOX touched: the lens page decides what to say. One in a
     frame from another site (a sign-in box set into this site's page) is
     reachable by this site, so the lens page says so plainly.

     A GET FORM (a site's search box), in the page itself, is sent by the
     browser as <masked address>?q=what+was+typed, in plain text before
     Scramjet sees it, so it is caught here and opened as one masked
     address. */
  function guard(w, client, isTop) {
    var doc = null;
    try { doc = w.document; } catch (x) { return; }
    if (!doc || doc.fkWatched) return;
    doc.fkWatched = true;
    function here() { try { return realOf(String(client.url.href)); } catch (x) { return ""; } }

    try {
      var realOpen = w.open;
      if (typeof realOpen === "function") w.open = function (url) {
        var to = "";
        try { to = url ? new URL(String(url), here()).href : ""; } catch (x) {}
        if (foreignTo(to)) { tell({ t: "foreign", url: to, replace: false, popup: true }); return null; }
        return realOpen.apply(this, arguments);
      };
    } catch (x) {}

    doc.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button > 1) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var t = String(a.target || "").toLowerCase();
      if (t !== "_blank" && t !== "_new" && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button !== 1) return;
      var to = realOf(a.href);
      if (!foreignTo(to)) return;
      e.preventDefault();
      tell({ t: "foreign", url: to, replace: false, popup: true });
    }, true);

    doc.addEventListener("focusin", function (e) {
      var t = e.target;
      if (!t || t.tagName !== "INPUT" || String(t.type).toLowerCase() !== "password") return;
      var u = here(), msg = { t: "password", host: hostOf(u) };
      if (!isTop && foreignTo(u)) { msg.inside = hostOf(stack[at] || ""); msg.url = u; }
      tell(msg);
    }, true);

    if (!isTop) return;
    doc.addEventListener("submit", function (e) {
      var f = e.target;
      if (!f || String(f.method || "get").toLowerCase() !== "get" || (f.target && f.target !== "_self") || e.defaultPrevented) return;
      var real = "";
      try {
        var act = realOf(f.action);
        if (!act || new URL(act).origin === location.origin) act = here();
        var u = new URL(act);
        if (u.protocol !== "https:" && u.protocol !== "http:") return;
        u.search = new URLSearchParams(new FormData(f, e.submitter || undefined)).toString();
        u.hash = "";
        real = u.href;
      } catch (x) { return; }
      e.preventDefault();
      go(real);
    }, true);
  }

  function go(u) {
    if (!ready || !u) return;
    if (site && siteOf(u) !== site) return tell({ t: "foreign", url: u, replace: false });
    ensureFrame().go(u);
  }

  /* Back and forward inside this slot while it has somewhere to go;
     otherwise the lens page moves to the site before or after. */
  function move(dir) {
    var to = at + dir;
    if (!frame || to < 0 || to >= stack.length) return tell({ t: "moved", dir: dir, ok: false });
    at = to; moving++;
    if (dir < 0) frame.back(); else frame.forward();
    tell({ t: "moved", dir: dir, ok: true });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || e.origin !== TOP) return;
    var m = e.data;
    if (!m || m.fk !== "slot") return;
    if (m.t === "init" && !scramjet) {
      pass = String(m.pass || ""); site = String(m.site || "");
      boot();
    } else if (m.t === "pass" && typeof m.pass === "string" && m.pass) {
      pass = m.pass;
      if (connection) setTransport().catch(function () {});
    } else if (m.t === "go") go(String(m.url || ""));
    else if (m.t === "back") move(-1);
    else if (m.t === "forward") move(1);
    else if (m.t === "reload" && frame) frame.reload();
  });

  tell({ t: "hello" });
})();
