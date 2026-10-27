/* ============================================================
   FieldKit :: BROWSER
   The client half of §14.3. Runs in both builds.

   This half is deliberately almost nothing, and it got that way by
   losing an argument with an origin boundary.

   ---- WHY THE CONTROLS ARE NOT HERE ----------------------------

   The page is rendered by an iframe pointed at the relay, which
   fetched it, stripped its scripts and rewrote its links to come
   back through the same route. `file://` cannot fetch cross-origin
   and most sites refuse to be framed, so an in-app browser is
   either a toy or a proxy.

   The first version put the address bar, the back button and the
   reload button in this panel, outside the frame. Every one of them
   was then on the wrong side of an origin boundary that cannot be
   crossed: this page is `file://` (origin null) and the frame is
   `https://relay`, so `frame.contentWindow.location` is unreadable
   and always will be. `allow-same-origin` does not help — it only
   decides whether the frame keeps its own origin instead of an
   opaque one. So the address bar could not follow a link click, the
   back button did not know what the frame considered "back", and
   keeping them honest meant interrogating the relay after every
   load.

   The controls now live INSIDE the frame, served by the relay as
   part of every page — a GET form and four links, no JavaScript.
   That does not work around the boundary, it removes it: the bar
   and the page are the same document, so the address shown is the
   address loaded, by construction.

   There ARE back, forward and reload buttons out here as well, and
   they do not contradict any of the above. The boundary stops this
   side from READING where the frame is; it never stopped it from
   telling the relay to move. The history lives on the relay, keyed
   by the ticket this module already holds, so a button here is a
   one-line command rather than a guess. See navUrl().

   What is left here is the part that genuinely belongs on this
   side: getting a ticket from a credential that must never leave
   this side, and saying plainly what the thing does and does not
   do.

   ---- THE TICKET ----------------------------------------------

   An iframe cannot send an Authorization header, so the relay
   trades a real credential for a short-lived ticket that can do
   nothing but browse. The vault token never appears in a URL. The
   ticket is held in memory only and re-fetched when it expires.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var ticket = null, ticketAt = 0;
  var alive = function () { return true; };   // replaced per mount

  /* THE ONE THAT MADE IT DO NOTHING AT ALL.

     An <iframe> with a `srcdoc` attribute ignores `src` entirely —
     spec, not a quirk, and silent. The panel used to finish by
     writing a "READY" message through srcdoc, so from the first
     paint every `frame.src = …` was a no-op: type an address, press
     enter, nothing, forever, no error anywhere.

     Verified rather than assumed: a same-origin frame given srcdoc
     and then a src stays at about:srcdoc showing the srcdoc content.

     So the two ways of filling the frame each clear the other, and
     neither assumes it was reached from a clean state. */
  function frameShowUrl(url) {
    nodes.frame.removeAttribute("srcdoc");
    nodes.frame.src = url;
  }
  function frameShowHtml(html) {
    nodes.frame.removeAttribute("src");
    nodes.frame.srcdoc = html;
  }

  /* The capability set the frame gets, as data, so the selfcheck and
     the suite can assert on the same list the frame is built from
     rather than on a copy of it that can drift.

     Every entry is here for a reason and the reasons are in the
     comment at the frame itself. What matters up here is what is
     ABSENT: allow-top-navigation, allow-popups-to-escape-sandbox,
     allow-modals, allow-downloads. */
  var SANDBOX = [
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-popups",
    /* THE THREE THAT GAMES NEED, and the rule that made them
       necessary: a nested iframe can never hold more permission than
       the frame it is inside. A game embedded in a proxied page sets
       its own sandbox asking for pointer lock and presentation — and
       got neither, because this frame did not have them to give. The
       symptom is a game that loads its page and then does nothing,
       which reads as "the browser is broken".

       allow-pointer-lock — anything that captures the mouse. Without
       it requestPointerLock rejects and most first-person and
       driving games stop at the title screen.

       allow-presentation and allow-orientation-lock — the two a game
       asks for on the way into fullscreen. Cheap, and the absence of
       either is invisible until it is not.

       STILL absent, and still on purpose: allow-top-navigation,
       allow-modals, allow-downloads, allow-popups-to-escape-sandbox.
       Those are about what a page can do to FieldKit and to the
       machine, not about what it can do to itself. */
    "allow-pointer-lock",
    "allow-presentation",
    "allow-orientation-lock"
  ];

  /* Permissions Policy, which is a SEPARATE gate from the sandbox and
     is why adding sandbox flags alone changed nothing.

     A cross-origin iframe is denied every powerful feature by
     default, and `allow` is how a parent delegates. CrazyGames' own
     game frame asks for exactly this list; with no `allow` here the
     delegation stops at this frame and the nested request is refused
     with no error a page can catch.

     Absent deliberately: camera, microphone, geolocation, payment,
     usb, midi, display-capture. A proxied page cannot ask this
     machine for any of those, and nothing that needs them belongs in
     a reader. */
  var ALLOW = [
    "fullscreen",
    "autoplay",
    "gamepad",
    "accelerometer",
    "gyroscope",
    "screen-wake-lock",
    "clipboard-write",
    "keyboard-map",
    "xr-spatial-tracking"
  ];

  /* The relay hands out 30-minute tickets. Renewing at 20 avoids a
     page half-loading with a ticket that expires between its HTML
     and its stylesheet. */
  var TICKET_FRESH_MS = 20 * 60 * 1000;

  function relayBase() {
    /* Also asked before the panel is mounted (prewarm), when there is
       no ctx yet. */
    var st = (ctx && ctx.settings) || FieldKit.service("settings");
    var u = String((st && st.get("relayUrl")) || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }

  /* Two credentials answer on the relay side and two answer here:
     the vault token in the full build, a messaging session in
     OUTPOST, which has no vault to get a token from.

     Neither is read directly. Each owner does its own exchange and
     hands back only the ticket, so this module never holds anything
     that could do more than browse. */
  function ticketSources() {
    var out = [];
    var relay = FieldKit.service("transportRelay");
    var store = FieldKit.service("store");
    if (relay && typeof relay.browseTicket === "function" &&
        store && store.isUnlocked && store.isUnlocked()) {
      out.push({ what: "the vault", get: function () { return relay.browseTicket(); } });
    }
    var msg = FieldKit.service("messages");
    if (msg && typeof msg.browseTicket === "function" && msg.signedIn && msg.signedIn()) {
      out.push({ what: "your MESSAGES account", get: function () { return msg.browseTicket(); } });
    }
    return out;
  }

  async function getTicket(force) {
    if (!force && ticket && (Date.now() - ticketAt) < TICKET_FRESH_MS) return ticket;
    if (!relayBase()) throw new Error("no relay is configured — set one in SETTINGS first");

    var sources = ticketSources();
    if (!sources.length) {
      throw new Error("nothing here can prove who you are yet. Unlock the vault, " +
        "or sign in to MESSAGES if this is the limited build.");
    }

    var last = null;
    for (var i = 0; i < sources.length; i++) {
      try {
        var data = await sources[i].get();
        if (!data || !data.ticket) throw new Error("the relay returned no ticket");
        ticket = data.ticket;
        ticketAt = Date.now();
        return ticket;
      } catch (e) {
        if (e.status === 503) {
          throw new Error("the browser is switched off on this relay. " +
            "Set browse.enabled in config.json and restart it.");
        }
        /* Kept and re-thrown only if every source fails, so a locked
           vault does not mask a working messaging session. */
        last = new Error("could not get a browse pass from " + sources[i].what +
          " — " + e.message);
      }
    }
    throw last;
  }

  /* The only URLs this side builds. Everything after them is built
     by the relay, inside the frame. */
  function uiUrl(t) {
    return relayBase() + "/browse/ui?t=" + encodeURIComponent(t);
  }

  /* BACK, FORWARD AND RELOAD, FROM OUT HERE — and why that is
     possible now when the module header says it is not.

     The header is still right about what cannot be done: this page
     is file:// and the frame is https://relay, so nothing here can
     READ where the frame went. What it can do is TELL the relay to
     move, because the history is not in the frame at all — it lives
     on the relay, keyed by the ticket this module is already
     holding. So the button does not need to know where "back" is.
     It says "back" to the thing that does.

     The in-page toolbar keeps its own copies. Two paths to the same
     three routes is not duplication that can drift, because both
     are the same GET and the relay is the only thing with an
     opinion. */
  function navUrl(what, t) {
    return relayBase() + "/browse/" + what + "?t=" + encodeURIComponent(t);
  }

  async function navigate(what) {
    try {
      var t = await getTicket();
      frameShowUrl(navUrl(what, t));
    } catch (e) {
      setStatus(e.message, "bad");
    }
  }

  /* Enabled state comes from the relay, on every load, alongside the
     address readout that was already being fetched. A Back button
     that is always lit is worse than no Back button: it teaches you
     that pressing it does nothing. */
  function setNavState(canBack, canFwd) {
    if (nodes.back) nodes.back.disabled = !canBack;
    if (nodes.fwd) nodes.fwd.disabled = !canFwd;
  }

  /* ---- the session ------------------------------------------------ */
  async function open(force) {
    setStatus("getting a browse pass…", "dim");
    var stillMine = alive;
    try {
      var t = await getTicket(force);
      if (!stillMine()) return;
      frameShowUrl(uiUrl(t));
      setStatus("session open — the address bar is inside the page", "ok");
    } catch (e) {
      if (!stillMine()) return;
      setStatus(e.message, "bad");
      showMessage("COULD NOT START", e.message);
    }
  }

  /* The frame is cross-origin, so the load event is all this side
     can observe about it — the fact that something arrived, never
     what. The address is asked of the relay, which knows, and shown
     as a readout rather than as a control: it is here so the panel
     can say where the session is, not so anything can be steered
     from out here. */
  async function onFrameLoad() {
    var stillMine = alive;
    if (nodes.frame.hasAttribute("srcdoc")) return;   // our own message
    if (!ticket) return;
    try {
      var res = await window.fetch(
        relayBase() + "/browse/where?t=" + encodeURIComponent(ticket),
        { method: "GET", cache: "no-store" });
      if (!res.ok) return;
      var data = await res.json();
      if (!stillMine() || !data) return;
      setStatus(data.url ? shorten(data.url) : "session open", "dim");
      setNavState(!!data.canBack, !!data.canFwd);
    } catch (e) { /* offline mid-session; the readout just goes stale */ }
  }

  function shorten(u) {
    var s = String(u).replace(/^https?:\/\//, "");
    return s.length > 70 ? s.slice(0, 70) + "…" : s;
  }

  function setStatus(text, level) {
    if (!nodes.status) return;
    nodes.status.textContent = text;
    nodes.status.className = "br-status" + (level ? " " + level : "");
  }

  function showMessage(head, body, rows) {
    /* srcdoc rather than a proxied page: this is our own text, so it
       never goes near the relay. Still sandboxed, because a sandbox
       that is sometimes off is not a sandbox. */
    frameShowHtml(
      '<body style="font:13px ui-monospace,monospace;background:#0c100e;color:#c8d4cd;' +
      'padding:24px;line-height:1.6">' +
      '<div style="color:#e08080;letter-spacing:.16em;margin-bottom:10px">' + esc(head) + "</div>" +
      "<div>" + esc(body) + "</div>" +
      (rows && rows.length
        ? '<div style="margin-top:16px;border-top:1px solid #2b3a33;padding-top:12px">' +
          rows.map(function (r) { return "<div>" + esc(r) + "</div>"; }).join("") + "</div>"
        : "") + "</body>");
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---- which engine actually answers ------------------------------

     Search engines refuse datacentre addresses, and the relay lives
     in one. Half of them hand back a CAPTCHA page instead of
     results — which, proxied and script-stripped, renders as a
     broken-looking page rather than an error, so it reads as "the
     browser is broken".

     Nothing here tries to get past that. Presenting a fake browser
     User-Agent to look less like a proxy is exactly the kind of
     detection-dodging this project does not do, and it is a losing
     game besides. The answer is to find an engine that is willing,
     and the only place that can be tested from is the relay itself
     — so the app asks rather than the documentation guessing. */
  async function testEngines() {
    setStatus("asking the relay which engines answer it…", "dim");
    var stillMine = alive;
    try {
      var t = await getTicket();
      if (!stillMine()) return;
      var res = await window.fetch(
        relayBase() + "/browse/engines?t=" + encodeURIComponent(t),
        { method: "GET", cache: "no-store" });
      var data = await res.json();
      if (!stillMine()) return;
      if (!res.ok) throw new Error(data.error || ("the relay said " + res.status));

      var rows = data.results.map(function (r) {
        return (r.usable ? "WORKS    " : r.why === "challenge" ? "BLOCKED  " : "FAILED   ") +
          r.name + "  —  " + r.detail;
      });
      var working = data.results.filter(function (r) { return r.usable; });

      /* This used to end at "edit config.json and restart the
         relay", which is a long way round for a setting whose whole
         purpose is to be tried. The relay now takes a per-session
         engine, so the answer to "which of these works" can be a
         button rather than a paragraph. Switching lasts as long as
         the browse pass and changes nothing for anyone else — the
         relay's own config stays the default. */
      showEngineChoices(data, working, rows);
      setStatus(working.length + " of " + data.results.length + " engines answered",
        working.length ? "ok" : "bad");
    } catch (e) {
      if (!stillMine()) return;
      setStatus(e.message, "bad");
      showMessage("COULD NOT TEST", e.message);
    }
  }

  /* The engine list, as buttons. Rendered into the FieldKit panel
     rather than into the frame, because the frame is a different
     origin and a button in there could not call back out here — the
     same boundary that put the address bar inside the page puts this
     one outside it. */
  function showEngineChoices(data, working, rows) {
    if (!nodes.engines) return;
    ui.clear(nodes.engines);
    nodes.engines.style.display = "";

    nodes.engines.appendChild(el("div", { class: "br-eng-head" }, [
      el("div", { class: "br-eng-h", text:
        working.length ? "ENGINES THAT ANSWER YOUR RELAY" : "NO ENGINE ANSWERED" }),
      el("button", { class: "br-eng-x", type: "button", text: "CLOSE", title:
        "put the page back", onclick: function () {
          nodes.engines.style.display = "none";
        } })
    ]));

    if (!working.length) {
      nodes.engines.appendChild(el("div", { class: "br-eng-p", text:
        "Every engine tried either refused the relay's address or handed back a bot " +
        "check. Nothing here will try to get past a bot check. A SearXNG instance you " +
        "run yourself is the one search endpoint with no reason to block you." }));
    }

    data.results.forEach(function (r) {
      var row = el("div", { class: "br-eng-row" + (r.usable ? "" : " bad") }, [
        el("span", { class: "br-eng-n", text: r.name }),
        el("span", { class: "br-eng-d", text:
          (r.usable ? "" : (r.why === "challenge" ? "bot check — " : "")) + r.detail })
      ]);
      if (r.usable) {
        var current = r.url === data.current;
        row.appendChild(current
          ? el("span", { class: "br-eng-cur", text: "IN USE" })
          : ui.button("USE", function () { useEngine(r.url, r.name); }, { small: true }));
      }
      nodes.engines.appendChild(row);
    });

    nodes.engines.appendChild(el("div", { class: "br-eng-p", text:
      "Switching lasts as long as this browse pass. To make it permanent, set " +
      "browse.searchUrl in the relay's config.json — currently " + data.configured + "." }));
  }

  async function useEngine(url, name) {
    var stillMine = alive;
    try {
      var t = await getTicket();
      var res = await window.fetch(relayBase() + "/browse/engine?t=" +
        encodeURIComponent(t) + "&url=" + encodeURIComponent(url),
        { method: "GET", cache: "no-store" });
      var data = await res.json();
      if (!stillMine()) return;
      if (!res.ok) throw new Error(data.error || ("the relay said " + res.status));
      ui.toast("SEARCHING WITH " + name.toUpperCase(), "ok");
      setStatus("search engine for this session: " + name, "ok");
      if (nodes.engines) nodes.engines.style.display = "none";
    } catch (e) {
      if (!stillMine()) return;
      setStatus(e.message, "bad");
    }
  }

  /* ---- the panel -------------------------------------------------- */

  /* ================================================================
     THE STREAMED BROWSER (§14.11) — the client half

     Everything above this line is the fetch-and-rewrite proxy, and
     it is still here on purpose: it is the fallback for a relay
     with no Chromium in its container. But when the relay CAN run
     a real browser, none of the reasoning above applies any more.

     There is no origin boundary to lose an argument with, because
     there is no frame — the page is a <canvas> and what arrives is
     JPEG. The address bar can be out here now, because the relay is
     telling us where it is over the same socket that carries the
     picture. Back and forward are the real browser's own history
     rather than a list the proxy kept.

     AND IT IS ONE CONNECTION. That is the fix for "it sends a lot
     of requests": a page's two hundred subresources are fetched
     inside the container, at container speed, and never touch the
     relay's rate limiter. What crosses the tunnel is frames out and
     input in.
     ================================================================ */

  var live = null;          /* the open stream, or null */
  var liveReady = false;    /* does this relay have a real browser? */
  var liveInfo = null;      /* what it said about itself */

  var MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  function modsOf(e) {
    return (e.altKey ? MOD.alt : 0) | (e.ctrlKey ? MOD.ctrl : 0) |
           (e.metaKey ? MOD.meta : 0) | (e.shiftKey ? MOD.shift : 0);
  }

  /* A key with one character in its name is a character. Everything
     else — Enter, Tab, ArrowLeft, F5 — is a key, and sending it with
     text attached would type its name into the page. */
  function isTypedChar(e) {
    return e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  }

  /* FASTER FIRST OPEN (RUNNER_PLAN.md §16). Chromium on the relay
     starts on the first ticket and is parked after 10 idle minutes,
     so the first open after a quiet spell waited a second or two for
     it. Now pointing at the BROWSER tile asks for the status and a
     ticket straight away: the relay starts Chromium while the hand
     is still moving, and the panel uses what was fetched. A ticket
     lasts 60 s and works once; one older than WARM_TICKET_MS is let
     go and a fresh one fetched as before. */
  var WARM_TICKET_MS = 40000, WARM_STATUS_MS = 15000;
  var warm = { ticket: null, ticketAt: 0, status: null, statusAt: 0 };
  var liveTier = null;              /* what the relay said with the last ticket */
  var live_usageStop = function () {};

  async function prewarm() {
    if (!relayBase()) return;
    var st = await liveStatus(true);
    warm.status = st; warm.statusAt = Date.now();
    if (!(st && st.enabled && (st.ready || st.available))) return;
    if (!streamSources().length) return;
    if (warm.ticket && Date.now() - warm.ticketAt < WARM_TICKET_MS) return;
    var t = await getStreamTicket(true);
    warm.ticket = t; warm.ticketAt = Date.now();
    warm.tier = liveTier;
  }

  async function liveStatus(fresh) {
    if (!fresh && warm.status && Date.now() - warm.statusAt < WARM_STATUS_MS) return warm.status;
    var base = relayBase();
    if (!base) return null;
    try {
      var r = await fetch(base + "/browser/status", { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  /* Admin things in the toolbar appear once the relay has said this
     is an admin; the relay checks again on every request. */
  var adminBits = [];
  function showAdmin() {
    adminBits.forEach(function (n) { n.style.display = liveTier === "admin" ? "" : "none"; });
  }

  /* USAGE (RUNNER_PLAN.md §17): what the browser costs, for an admin. */
  async function fetchUsage() {
    var relay = FieldKit.service("transportRelay");
    var store = FieldKit.service("store");
    if (relay && typeof relay.browserUsage === "function" && store && store.isUnlocked && store.isUnlocked()) {
      return relay.browserUsage();
    }
    var msg = FieldKit.service("messages");
    if (msg && typeof msg.browserUsage === "function" && msg.signedIn && msg.signedIn()) return msg.browserUsage();
    throw new Error("sign in to see this");
  }
  function cores(n) { return n == null ? "…" : n.toFixed(2) + " core"; }

  function streamSources() {
    var sources = [];
    var relay = FieldKit.service("transportRelay");
    var store = FieldKit.service("store");
    if (relay && typeof relay.streamTicket === "function" &&
        store && store.isUnlocked && store.isUnlocked()) {
      sources.push({ what: "the vault", get: function () { return relay.streamTicket(); } });
    }
    var msg = FieldKit.service("messages");
    if (msg && typeof msg.streamTicket === "function" && msg.signedIn && msg.signedIn()) {
      sources.push({ what: "your MESSAGES account", get: function () { return msg.streamTicket(); } });
    }
    return sources;
  }

  async function getStreamTicket(fresh) {
    if (!fresh && warm.ticket && Date.now() - warm.ticketAt < WARM_TICKET_MS) {
      var t = warm.ticket;
      warm.ticket = null;            /* it works once */
      if (warm.tier) liveTier = warm.tier;
      return t;
    }
    var sources = streamSources();
    if (!sources.length) {
      throw new Error("sign in to MESSAGES, or unlock the vault, to use the browser");
    }
    var last = null;
    for (var i = 0; i < sources.length; i++) {
      try {
        var d = await sources[i].get();
        if (d && d.ticket) { liveTier = d.tier || null; showAdmin(); return d.ticket; }
        throw new Error("the relay returned no ticket");
      } catch (e) { last = e; }
    }
    throw last;
  }

  function wsUrlFor(t) {
    var base = relayBase();
    var ws = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    return ws + "/browser/stream?t=" + encodeURIComponent(t);
  }

  /* The same steps as Chrome's own zoom, and as the relay's list. */
  var ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

  /* ---- bookmarks and history, in the vault (RUNNER_PLAN.md §16) ----
     Records in the store like any other: sealed with the vault's key
     before they are synced, so the relay keeps them and cannot read
     them. Bookmarks are a record each; history is one record of the
     last HIST_MAX pages, saved at most every 20 s. With the vault
     locked there are none, and nothing is remembered anywhere. */
  var BM = "browser-bookmark", HIST = "browser-history", HIST_ID = "browser-history", HIST_MAX = 500;
  var places = { marks: [], hist: [], off: false, loaded: false, timer: null };
  function placeStore() {
    var st = FieldKit.service("store");
    return st && st.isUnlocked && st.isUnlocked() ? st : null;
  }
  function keepable(u) { return /^https?:\/\//i.test(String(u || "")); }
  async function loadPlaces() {
    var st = placeStore();
    if (!st) { places.marks = []; places.hist = []; places.loaded = false; return false; }
    var rows = await st.list(BM);
    places.marks = rows.map(function (r) { return { id: r.id, url: String(r.data.url || ""), title: String(r.data.title || ""), at: r.data.at || 0 }; })
      .filter(function (b) { return keepable(b.url); });
    var h = await st.get(HIST_ID);
    places.hist = h && Array.isArray(h.items) ? h.items.filter(function (x) { return x && keepable(x.u); }).slice(0, HIST_MAX) : [];
    places.off = !!(h && h.off);
    places.loaded = true;
    return true;
  }
  function saveHistSoon() {
    if (places.timer) return;
    places.timer = setTimeout(function () { places.timer = null; saveHist(); }, 20000);
  }
  function saveHist() {
    if (places.timer) { clearTimeout(places.timer); places.timer = null; }
    var st = placeStore();
    if (!st || !places.loaded) return Promise.resolve();
    return st.put(HIST, { items: places.hist, off: places.off }, { id: HIST_ID }).catch(function () {});
  }
  function noteVisit(url, title) {
    if (!places.loaded || places.off || !keepable(url)) return;
    var top = places.hist[0];
    if (top && top.u === url) { if (title) top.t = title; }
    else places.hist.unshift({ u: url, t: title || "", at: Date.now() });
    if (places.hist.length > HIST_MAX) places.hist.length = HIST_MAX;
    saveHistSoon();
  }
  function markOf(url) {
    for (var i = 0; i < places.marks.length; i++) if (places.marks[i].url === url) return places.marks[i];
    return null;
  }
  async function toggleMark(url, title) {
    var st = placeStore();
    if (!st || !keepable(url)) return null;
    var had = markOf(url);
    if (had) {
      await st.remove(had.id);
      places.marks = places.marks.filter(function (b) { return b !== had; });
      return false;
    }
    var rec = await st.put(BM, { url: url, title: title || "", at: Date.now() });
    places.marks.unshift({ id: rec && rec.id ? rec.id : String(Date.now()), url: url, title: title || "", at: Date.now() });
    return true;
  }
  /* Best first: words in the title or address, bookmarks before history. */
  function findPlaces(q, max) {
    var words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    var seen = {}, out = [];
    function add(u, t, mark) {
      if (seen[u]) return;
      var hay = (t + " " + u).toLowerCase();
      for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return;
      seen[u] = true;
      out.push({ url: u, title: t, mark: mark });
    }
    places.marks.forEach(function (b) { add(b.url, b.title, true); });
    places.hist.forEach(function (h) { add(h.u, h.t, false); });
    return out.slice(0, max || 50);
  }

  function closeLive() {
    if (places.timer) saveHist();
    if (!live) return;
    if (live.offVis) live.offVis();
    try { if (live.sock) { live.sock.onclose = null; live.sock.close(); } } catch (e) {}
    if (live.ro) { try { live.ro.disconnect(); } catch (e) {} }
    if (live.offKeys) live.offKeys();
    if (live.dec) { try { live.dec.close(); } catch (e) {} }
    live = null;
  }

  function renderLive(host, status) {
    ui.clear(host);
    closeLive();

    var addr = el("input", { class: "br-addr", type: "text",
      placeholder: "address, or something to search for" });
    var stat = el("div", { class: "br-status", text: "connecting…" });
    var canvas = el("canvas", { class: "br-canvas" });

    function cmd(o) {
      if (live && live.sock && live.sock.readyState === 1) live.sock.send(JSON.stringify(o));
    }

    var btn = function (label, title, fn) {
      return el("button", { class: label.length > 1 ? "br-nav br-word" : "br-nav", text: label, title: title, onclick: fn });
    };
    var back = btn("◁", "back", function () { cmd({ t: "back" }); });
    var zoomBtn = el("button", { class: "br-nav br-zoom", text: "100%",
      title: "zoom (Ctrl + and Ctrl −); click for 100%", onclick: function () { zoomTo(1); } });
    function zoomTo(z) { cmd({ t: "zoom", zoom: z }); canvas.focus(); }
    function zoomStep(d) {
      var i = ZOOMS.indexOf(live && live.zoom || 1);
      if (i < 0) i = ZOOMS.indexOf(1);
      zoomTo(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + d))]);
    }

    /* ---- find, on the real page ---- */
    var findIn = el("input", { class: "br-addr br-findin", type: "text", placeholder: "find on this page" });
    var findSaid = el("span", { class: "br-findsaid" });
    function findGo(backwards) {
      var q = findIn.value;
      if (q) cmd({ t: "find", text: q, back: !!backwards });
    }
    function findClose() { findBar.style.display = "none"; findSaid.textContent = ""; canvas.focus(); }
    var findBar = el("div", { class: "br-findbar" }, [
      findIn,
      btn("▲", "previous (Shift+Enter)", function () { findGo(true); }),
      btn("▼", "next (Enter)", function () { findGo(false); }),
      findSaid,
      btn("✕", "close (Esc)", findClose)
    ]);
    findBar.style.display = "none";
    function findOpen() {
      findBar.style.display = "";
      findIn.focus();
      findIn.select();
    }
    findIn.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); findGo(e.shiftKey); }
      else if (e.key === "Escape") { e.preventDefault(); findClose(); }
    });
    var fwd = btn("▷", "forward", function () { cmd({ t: "fwd" }); });
    var reload = btn("↻", "reload", function () { cmd({ t: "reload" }); });

    function go() {
      var v = addr.value.trim();
      if (v) cmd({ t: "nav", url: v });
      canvas.focus();
    }
    addr.addEventListener("keydown", function (e) {
      /* The address bar is a real input out here, so its keys must
         not also be forwarded to the page. */
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });

    /* ---- tabs, downloads and "choose file" (RUNNER_PLAN.md §16) ----
       The relay's session is a set of tabs; a page that opens a window
       gets one, so the strip appears as soon as there are two. */
    var tabStrip = el("div", { class: "br-tabs", style: { display: "none" } });
    var notes = el("div", { class: "br-asks" });
    function drawTabs(m) {
      ui.clear(tabStrip);
      var list = Array.isArray(m.tabs) ? m.tabs : [];
      tabStrip.style.display = list.length > 1 ? "" : "none";
      list.forEach(function (t) {
        var label = t.title || shorten(t.url || "") || "new tab";
        tabStrip.appendChild(el("div", { class: "br-tab" + (t.id === m.active ? " on" : ""), title: t.url || "" }, [
          el("button", { class: "br-tab-t", type: "button", text: label,
            onclick: function () { cmd({ t: "tab", id: t.id }); canvas.focus(); } }),
          el("button", { class: "br-tab-x", type: "button", text: "✕", title: "close this tab",
            onclick: function () { cmd({ t: "tab-close", id: t.id }); } })
        ]));
      });
    }
    /* One line per thing waiting on the person, each with its own buttons. */
    var noteOf = {};
    function note(key, parts) {
      var old = noteOf[key];
      if (old && old.parentNode) old.parentNode.removeChild(old);
      delete noteOf[key];
      if (!parts) return;
      var n = el("div", { class: "br-ask" }, parts);
      notes.appendChild(n);
      noteOf[key] = n;
      return n;
    }
    function fmtSize(b) {
      return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : b >= 1024 ? Math.round(b / 1024) + " KB" : (b | 0) + " B";
    }
    async function fetchDownload(m) {
      var r = await fetch(relayBase() + m.url, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 404 ? "the download expired; download it again" : "the relay said " + r.status);
      return r.blob();
    }
    function onDownload(m) {
      var key = "dl-" + m.id;
      if (m.state === "inProgress") {
        return note(key, [el("span", { class: "br-ask-t", text: "downloading " + m.name +
          (m.total ? " — " + Math.round(100 * m.got / m.total) + "% of " + fmtSize(m.total) : m.got ? " — " + fmtSize(m.got) : "…") })]);
      }
      if (m.state !== "completed") {
        return note(key, [el("span", { class: "br-ask-t warn", text: "download of " + m.name + " stopped" + (m.why ? ": " + m.why : "") }),
          btn("OK", "dismiss", function () { note(key, null); })]);
      }
      var files = FieldKit.service("files"), store = FieldKit.service("store");
      var canVault = !!(files && store && store.isUnlocked && store.isUnlocked());
      var said = el("span", { class: "br-ask-t", text: "downloaded " + m.name + " (" + fmtSize(m.got) + ")" });
      var blobP = null;
      var get = function () { if (!blobP) blobP = fetchDownload(m); return blobP; };
      note(key, [said,
        btn("SAVE TO THIS DEVICE", "save it into this computer's downloads", function () {
          get().then(function (b) {
            var a = document.createElement("a");
            a.href = URL.createObjectURL(b);
            a.download = m.name;
            document.body.appendChild(a); a.click(); a.parentNode.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
            said.textContent = "saved " + m.name + " to this device";
          }).catch(function (e) { said.textContent = e.message; said.className = "br-ask-t warn"; });
        }),
        canVault ? btn("SAVE TO VAULT FILES", "encrypt it into VAULT FILES, on the relay", function () {
          said.textContent = "saving " + m.name + " to VAULT FILES…";
          get().then(function (b) {
            return files.upload(new File([b], m.name), { onProgress: function (d, t) {
              said.textContent = "saving " + m.name + " to VAULT FILES… " + d + "/" + t;
            } });
          }).then(function () { said.textContent = m.name + " is in VAULT FILES"; })
            .catch(function (e) { said.textContent = "not saved: " + e.message; said.className = "br-ask-t warn"; });
        }) : null,
        btn("✕", "dismiss", function () { note(key, null); })]);
    }
    /* A page's "choose file". The picker is opened at once if the
       browser allows it (the click that asked was a moment ago), and
       the button is there for when it does not. */
    function onChooseFile(m) {
      var input = el("input", { type: "file", style: { display: "none" } });
      if (m.multiple) input.multiple = true;
      var said = el("span", { class: "br-ask-t", text: "the page wants " + (m.multiple ? "files" : "a file") });
      input.addEventListener("change", function () {
        var list = Array.prototype.slice.call(input.files || []);
        if (!list.length) return;
        said.textContent = "sending " + list.length + " file" + (list.length === 1 ? "" : "s") + " to the page…";
        (async function () {
          var ids = [];
          for (var i = 0; i < list.length; i++) {
            var r = await fetch(relayBase() + m.url + "?name=" + encodeURIComponent(list[i].name),
              { method: "POST", body: list[i], headers: { "Content-Type": "application/octet-stream" } });
            var d = await r.json().catch(function () { return {}; });
            if (!r.ok) throw new Error(d.error || "the relay said " + r.status);
            ids.push(d.id);
          }
          cmd({ t: "files", ids: ids });
          note("choose", null);
        })().catch(function (e) { said.textContent = "not sent: " + e.message; said.className = "br-ask-t warn"; });
      });
      note("choose", [said, input,
        btn("CHOOSE FILE", "pick the file from this device", function () { input.click(); }),
        btn("CANCEL", "do not send anything", function () { note("choose", null); canvas.focus(); })]);
      try { input.click(); } catch (e) {}
    }
    var CURSORS = ["default", "pointer", "text", "move", "grab", "grabbing", "crosshair", "not-allowed",
      "wait", "progress", "help", "col-resize", "row-resize", "ew-resize", "ns-resize", "nesw-resize",
      "nwse-resize", "n-resize", "s-resize", "e-resize", "w-resize", "ne-resize", "nw-resize", "se-resize",
      "sw-resize", "zoom-in", "zoom-out", "copy", "cell", "context-menu", "all-scroll", "vertical-text", "none"];

    /* ---- bookmarks and history ---- */
    var star = btn("☆", "bookmark this page (kept encrypted in your vault)", function () {
      var u = live && live.url, t = live && live.title;
      if (!placeStore()) { stat.textContent = "unlock the vault to keep bookmarks"; stat.className = "br-status warn"; return; }
      toggleMark(u, t).then(function (on) {
        if (on === null) { stat.textContent = "only web pages can be bookmarked"; stat.className = "br-status warn"; return; }
        stat.textContent = on ? "bookmarked" : "bookmark removed";
        stat.className = "br-status ok";
        drawStar(); if (placesBar.style.display !== "none") drawPlaces();
      }).catch(function (e) { stat.textContent = "not saved: " + e.message; stat.className = "br-status warn"; });
    });
    function drawStar() {
      var on = !!(live && markOf(live.url));
      star.textContent = on ? "★" : "☆";
      star.classList.toggle("on", on);
    }
    var suggest = el("datalist", { id: "br-suggest-" + Math.random().toString(36).slice(2) });
    addr.setAttribute("list", suggest.id);
    addr.addEventListener("input", function () {
      ui.clear(suggest);
      var v = addr.value.trim();
      if (v.length < 2) return;
      findPlaces(v, 8).forEach(function (p) { suggest.appendChild(el("option", { value: p.url, label: p.title || p.url })); });
    });
    var placeTab = "marks";
    var placeQ = el("input", { class: "br-addr br-findin", type: "text", placeholder: "search bookmarks and history" });
    var placeList = el("div", { class: "br-places-list" });
    var placeHead = el("div", { class: "br-places-head" });
    var placesBar = el("div", { class: "br-places" }, [placeHead, placeList]);
    placesBar.style.display = "none";
    placeQ.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); placesBar.style.display = "none"; canvas.focus(); }
    });
    placeQ.addEventListener("input", function () { drawPlaces(); });
    function openPlace(u) { placesBar.style.display = "none"; cmd({ t: "nav", url: u }); canvas.focus(); }
    function drawPlaces() {
      ui.clear(placeHead); ui.clear(placeList);
      var tabBtn = function (k, label) {
        return el("button", { class: "br-nav br-word" + (placeTab === k ? " on" : ""), text: label, type: "button",
          onclick: function () { placeTab = k; drawPlaces(); } });
      };
      placeHead.appendChild(tabBtn("marks", "BOOKMARKS (" + places.marks.length + ")"));
      placeHead.appendChild(tabBtn("hist", "HISTORY"));
      placeHead.appendChild(placeQ);
      if (placeTab === "hist") {
        var keep = el("input", { type: "checkbox" });
        keep.checked = !places.off;
        keep.addEventListener("change", function () { places.off = !keep.checked; saveHist(); });
        placeHead.appendChild(el("label", { class: "br-places-keep", title: "remember the pages you visit, encrypted in your vault" },
          [keep, document.createTextNode(" keep")]));
        placeHead.appendChild(btn("CLEAR", "forget every page in your history", function () {
          if (ctx.confirm && !ctx.confirm("Forget your browsing history?")) return;
          places.hist = []; saveHist(); drawPlaces();
        }));
      }
      placeHead.appendChild(btn("✕", "close", function () { placesBar.style.display = "none"; canvas.focus(); }));
      if (!places.loaded) {
        return placeList.appendChild(el("div", { class: "br-places-none", text: "Unlock the vault to keep bookmarks and history. Nothing is kept until then." }));
      }
      var q = placeQ.value.trim();
      var rows = placeTab === "marks"
        ? findPlaces(q, 200).filter(function (p) { return p.mark; })
        : places.hist.filter(function (h) { return !q || findPlaces(q, 1000).some(function (p) { return p.url === h.u; }); })
          .slice(0, 100).map(function (h) { return { url: h.u, title: h.t, at: h.at }; });
      if (!rows.length) {
        placeList.appendChild(el("div", { class: "br-places-none", text: placeTab === "marks"
          ? (q ? "no bookmark matches" : "No bookmarks yet: ☆ next to the address keeps the page you are on.")
          : (places.off ? "History is not being kept." : q ? "nothing in your history matches" : "Nothing yet.") }));
      }
      rows.forEach(function (p) {
        placeList.appendChild(el("div", { class: "br-place" }, [
          el("button", { class: "br-place-go", type: "button", title: p.url, onclick: function () { openPlace(p.url); } }, [
            el("span", { class: "br-place-t", text: p.title || p.url }),
            el("span", { class: "br-place-u", text: p.url })
          ]),
          placeTab === "marks" ? btn("✕", "remove this bookmark", function () {
            toggleMark(p.url).then(function () { drawPlaces(); drawStar(); });
          }) : null
        ]));
      });
    }
    function placesOpen() {
      if (placesBar.style.display !== "none") { placesBar.style.display = "none"; canvas.focus(); return; }
      placesBar.style.display = "";
      (places.loaded ? Promise.resolve() : loadPlaces().catch(function () {})).then(function () { drawPlaces(); placeQ.focus(); });
    }
    loadPlaces().then(drawStar).catch(function () {});

    var usageBar = el("div", { class: "br-places br-usage" });
    usageBar.style.display = "none";
    var usageTimer = null;
    function drawUsage(u, err) {
      ui.clear(usageBar);
      usageBar.appendChild(el("div", { class: "br-places-head" }, [
        el("span", { class: "br-lbl", text: "WHAT THE BROWSER IS USING (UPDATES EVERY 4 S)" }),
        el("button", { class: "br-nav br-word", type: "button", text: "CLOSE", onclick: usageOpen })
      ]));
      if (err) return usageBar.appendChild(el("div", { class: "br-places-none", text: err }));
      if (!u) return usageBar.appendChild(el("div", { class: "br-places-none", text: "asking the relay…" }));
      var line = function (t) { usageBar.appendChild(el("div", { class: "br-use-line", text: t })); };
      var c = u.chromium;
      line("CHROMIUM  " + (c ? cores(c.cpu) + " · " + c.memMb + " MB · " + c.procs + " processes" : "not running (parked)") +
        (u.upKbps != null ? "  ·  house upload " + u.upKbps + " kbit/s" : ""));
      line("SESSIONS (" + u.sessions.length + ")");
      u.sessions.forEach(function (s) {
        line("  " + s.who + " (" + s.tier + ") · " + s.tabs + " tab" + (s.tabs === 1 ? "" : "s") + " · " +
          s.viewers + " watching · idle " + s.idleSec + " s");
      });
      line("OPEN PANELS (" + u.viewers.length + ")");
      u.viewers.forEach(function (v) {
        line("  " + v.who + " · " + (v.video ? "video " + v.kbps + " kbit/s now, cap " + v.capKbps +
          (v.step ? " (turned down " + v.step + ")" : "") + " · encoder " + cores(v.encCpu) +
          (v.encMemMb != null ? ", " + v.encMemMb + " MB" : "") : "pictures " + v.kbps + " kbit/s") +
          " · " + v.sentMb + " MB sent in " + Math.round(v.sinceSec / 60) + " min");
      });
    }
    function pollUsage() {
      fetchUsage().then(function (u) { if (usageBar.style.display !== "none") drawUsage(u); },
        function (e) { if (usageBar.style.display !== "none") drawUsage(null, String(e.message || e)); });
    }
    function usageOpen() {
      if (usageBar.style.display !== "none") {
        usageBar.style.display = "none";
        if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
        return;
      }
      usageBar.style.display = "";
      drawUsage(null);
      pollUsage();
      usageTimer = setInterval(pollUsage, 4000);
    }
    live_usageStop = function () { if (usageTimer) { clearInterval(usageTimer); usageTimer = null; } };
    var usageBtn = btn("USAGE", "what the browser costs: Chromium, each session and each open panel (admins)", usageOpen);
    adminBits = [usageBtn];
    showAdmin();

    var bar = el("div", { class: "br-toolbar" }, [
      back, fwd, reload, addr, star,
      btn("GO", "open that address", go),
      btn("PLACES", "bookmarks and history, kept encrypted in your vault", placesOpen),
      btn("+TAB", "a new tab (what is in the address bar, or a blank page)", function () {
        var v = addr.value.trim();
        cmd({ t: "tab-new", url: v && v !== (live && live.url) ? v : "" });
      }),
      btn("−", "zoom out (Ctrl −)", function () { zoomStep(-1); }),
      zoomBtn,
      btn("+", "zoom in (Ctrl +)", function () { zoomStep(1); }),
      btn("FIND", "find on this page (Ctrl F)", findOpen),
      btn("COOKIES", "forget the cookies this session has collected", function () {
        if (ctx.confirm ? ctx.confirm("Forget all cookies for your browsing session?") : true) {
          cmd({ t: "clear", what: "cookies" });
        }
      }),
      btn("WIPE", "end the session and throw away everything in it", function () {
        cmd({ t: "clear", what: "all" });
      }),
      usageBtn
    ]);

    var wrap = el("div", { class: "br-canvas-wrap" }, [canvas]);
    host.appendChild(el("div", { class: "br-wrap" }, [
      tabStrip, bar, findBar, placesBar, usageBar, suggest, notes, wrap, stat, buildNote(status)
    ]));

    /* ---- the stream ---- */
    var g = canvas.getContext("2d", { alpha: false });
    canvas.tabIndex = 0;

    live = { sock: null, ro: null, offKeys: null, offVis: null, drawing: false, queued: null,
      video: false, dec: null, keyWait: true, ts: 0, zoom: 1, hidden: false };

    /* A minimised window or a hidden tab: tell the relay, which stops
       sending (and, if nobody else is looking, stops encoding). Shown
       again, the current picture comes at once. */
    function setHidden(h) {
      if (!live || live.hidden === h) return;
      live.hidden = h;
      cmd({ t: "pause", on: h });
    }
    function isHidden() {
      var r = wrap.getBoundingClientRect();
      return document.hidden || r.width < 2 || r.height < 2;
    }
    function onVis() { setHidden(isHidden()); }
    document.addEventListener("visibilitychange", onVis);
    live.offVis = function () { document.removeEventListener("visibilitychange", onVis); };

    function fit() {
      var r = wrap.getBoundingClientRect();
      /* Zero means minimised, not small: resizing the page to the
         smallest size would make it lay out for a phone. */
      if (r.width < 2 || r.height < 2) return { w: canvas.width, h: canvas.height };
      var w = Math.max(320, Math.round(r.width));
      var h = Math.max(240, Math.round(r.height));
      if (canvas.width !== w || canvas.height !== h) {
        /* Resizing a canvas blanks it, and the next picture is a
           moment away (a new size is a new encoder). Keep the old
           one, stretched, rather than show black. */
        var old = null;
        try {
          old = document.createElement("canvas");
          old.width = canvas.width; old.height = canvas.height;
          old.getContext("2d").drawImage(canvas, 0, 0);
        } catch (e) { old = null; }
        canvas.width = w; canvas.height = h;
        if (old) { try { g.drawImage(old, 0, 0, w, h); } catch (e) {} }
      }
      cmd({ t: "resize", w: w, h: h, scale: 1 });
      return { w: w, h: h };
    }

    /* One decode at a time. A busy page can produce frames faster
       than createImageBitmap finishes, and queueing them all turns a
       fast site into a memory leak that plays in slow motion. The
       newest frame is the only one worth drawing. */
    function draw(blob) {
      if (live.drawing) { live.queued = blob; return; }
      live.drawing = true;
      createImageBitmap(blob).then(function (bmp) {
        if (!live) return;
        g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close && bmp.close();
      }).catch(function () {}).then(function () {
        if (!live) return;
        live.drawing = false;
        var q = live.queued;
        live.queued = null;
        if (q) draw(q);
      });
    }

    /* ---- the page as video (RUNNER_PLAN.md §23) ----
       When the relay can, it sends H.264 instead of one JPEG per
       frame: about a fifth of the bandwidth on a moving page. The
       browser's own decoder does the work, in hardware on a
       Chromebook. A "video" message gives the size before the first
       frame and again after a resize; { off: true } means pictures
       again, which is also what an older relay sends throughout. */
    function canVideo() {
      return typeof window.VideoDecoder === "function" && typeof window.EncodedVideoChunk === "function";
    }

    function videoOn(m) {
      if (live.dec) { try { live.dec.close(); } catch (e) {} live.dec = null; }
      live.video = !m.off;
      live.keyWait = true;
      if (!live.video) return;
      try {
        live.dec = new window.VideoDecoder({
          output: function (fr) {
            try { if (live) g.drawImage(fr, 0, 0, canvas.width, canvas.height); } finally { fr.close(); }
          },
          error: function () {
            /* Lost its place: ask for a fresh start, which begins with a keyframe. */
            if (!live) return;
            live.dec = null;
            live.keyWait = true;
            cmd({ t: "keyframe" });
          }
        });
        live.dec.configure({ codec: "avc1.42E01F", optimizeForLatency: true });
      } catch (e) { live.dec = null; }
    }

    function videoFrame(buf) {
      var b = new Uint8Array(buf);
      if (b.length < 2) return;
      var key = (b[0] & 1) === 1;
      if (!live.dec || live.dec.state === "closed") {
        if (!key) return;
        videoOn({});
        if (!live.dec) return;
      }
      if (live.keyWait && !key) return;
      /* Behind: drop to the next keyframe rather than play late. */
      if (!key && live.dec.decodeQueueSize > 4) { live.keyWait = true; cmd({ t: "keyframe" }); return; }
      live.keyWait = false;
      try {
        live.dec.decode(new window.EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: (live.ts += 33333), data: b.subarray(1) }));
      } catch (e) { live.keyWait = true; }
    }

    (async function connect() {
      var t;
      try { t = await getStreamTicket(); }
      catch (e) { stat.textContent = e.message; stat.className = "br-status bad"; return; }
      if (!alive()) return;

      var sock;
      try { sock = new WebSocket(wsUrlFor(t)); }
      catch (e) { stat.textContent = "could not open the stream — " + e.message;
        stat.className = "br-status bad"; return; }
      sock.binaryType = "arraybuffer";
      live.sock = sock;

      sock.onopen = function () {
        var d = fit();
        cmd({ t: "hello", w: d.w, h: d.h, scale: 1, video: canVideo() });
        stat.textContent = "connecting…";
        stat.className = "br-status ok";
        canvas.focus();
      };

      sock.onmessage = function (ev) {
        if (typeof ev.data !== "string") {
          return live.video ? videoFrame(ev.data) : draw(new Blob([ev.data], { type: "image/jpeg" }));
        }
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === "video") {
          videoOn(m);
        } else if (m.t === "queued") {
          /* Every browser session is busy or the house upload is: a
             place in line (RUNNER_PLAN.md §22). It connects by itself. */
          stat.textContent = "waiting for a browser: " + (m.ahead ? m.ahead + " ahead of you" : "you are next") +
            " (" + (m.why || "busy") + "). Members go ahead of guests. This connects by itself.";
          stat.className = "br-status warn";
        } else if (m.t === "ready") {
          live.zoom = m.zoom || 1;
          zoomBtn.textContent = Math.round(live.zoom * 100) + "%";
          stat.textContent = "connected";
          stat.className = "br-status ok";
          if (isHidden()) setHidden(true);
        } else if (m.t === "zoomed") {
          live.zoom = m.zoom || 1;
          zoomBtn.textContent = Math.round(live.zoom * 100) + "%";
        } else if (m.t === "found") {
          findSaid.textContent = m.ok ? "" : "not found";
        } else if (m.t === "copied") {
          var txt = String(m.text || "");
          if (!txt) {
            stat.textContent = "nothing selected to copy";
            stat.className = "br-status warn";
          } else {
            /* Onto the Chromebook's clipboard. The text arrives a moment
               after the key press, still inside the few seconds a browser
               counts as "the person just did something"; if it is refused
               anyway, ui.copy shows it in a box to copy by hand. */
            ui.copy(txt, { title: "COPIED FROM THE PAGE" }).then(function (how) {
              stat.textContent = how ? "copied " + txt.length + " character" + (txt.length === 1 ? "" : "s")
                : "copy it from the box";
              stat.className = how ? "br-status ok" : "br-status warn";
            });
          }
        } else if (m.t === "tabs") {
          drawTabs(m);
        } else if (m.t === "download") {
          onDownload(m);
        } else if (m.t === "choose-file") {
          onChooseFile(m);
        } else if (m.t === "files-set") {
          stat.textContent = "sent " + m.n + " file" + (m.n === 1 ? "" : "s") + " to the page";
          stat.className = "br-status ok";
        } else if (m.t === "cursor") {
          canvas.style.cursor = CURSORS.indexOf(m.c) >= 0 ? m.c : "default";
        } else if (m.t === "quality") {
          /* The relay turned this panel's video down to fit its connection, or back up. */
          stat.textContent = m.step ? "video turned down to " + m.kbps + " kbit/s to fit " + (m.why || "the connection")
            : "video back to full quality";
          stat.className = m.step ? "br-status warn" : "br-status ok";
        } else if (m.t === "note") {
          stat.textContent = m.why || "";
          stat.className = "br-status warn";
        } else if (m.t === "nav") {
          if (live) live.url = m.url || "";
          if (document.activeElement !== addr) addr.value = m.url || "";
          drawStar();
        } else if (m.t === "loaded") {
          if (document.activeElement !== addr) addr.value = m.url || "";
          if (live) { live.url = m.url || live.url; live.title = m.title || ""; }
          noteVisit(m.url, m.title);
          drawStar();
          stat.textContent = m.title || m.url || "";
          stat.className = "br-status";
        } else if (m.t === "history") {
          back.disabled = !m.canBack;
          fwd.disabled = !m.canFwd;
        } else if (m.t === "blocked") {
          stat.textContent = "not opened: " + m.why;
          stat.className = "br-status warn";
        } else if (m.t === "dialog") {
          var d = m.dialog || {};
          var answer = d.type === "prompt"
            ? window.prompt(d.message || "", d.prompt || "")
            : (d.type === "alert" ? (window.alert(d.message || ""), "")
                                  : (window.confirm(d.message || "") ? "" : null));
          cmd({ t: "dialog", accept: answer !== null, text: answer || "" });
        } else if (m.t === "cleared") {
          stat.textContent = "cookies forgotten";
          stat.className = "br-status ok";
        } else if (m.t === "gone") {
          stat.textContent = "session ended: " + (m.why || "");
          stat.className = "br-status warn";
        } else if (m.t === "error") {
          stat.textContent = m.why || "something went wrong";
          stat.className = "br-status bad";
        }
      };

      sock.onclose = function () {
        if (!alive() || !live) return;
        stat.textContent = "the stream closed — press ↻ to reconnect";
        stat.className = "br-status warn";
      };
    })();

    /* ---- input ---- */
    function pt(e) {
      var r = canvas.getBoundingClientRect();
      return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
    }
    var BUTTON = ["left", "middle", "right"];

    canvas.addEventListener("mousemove", function (e) {
      var p = pt(e);
      cmd({ t: "mouse", type: "mouseMoved", x: p.x, y: p.y, buttons: e.buttons,
        modifiers: modsOf(e) });
    });
    canvas.addEventListener("mousedown", function (e) {
      e.preventDefault(); canvas.focus();
      var p = pt(e);
      cmd({ t: "mouse", type: "mousePressed", x: p.x, y: p.y,
        button: BUTTON[e.button] || "left", buttons: e.buttons,
        clickCount: e.detail || 1, modifiers: modsOf(e) });
    });
    canvas.addEventListener("mouseup", function (e) {
      e.preventDefault();
      var p = pt(e);
      cmd({ t: "mouse", type: "mouseReleased", x: p.x, y: p.y,
        button: BUTTON[e.button] || "left", buttons: e.buttons,
        clickCount: e.detail || 1, modifiers: modsOf(e) });
    });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var p = pt(e);
      /* Passed straight through, NOT negated. Both sides use the
         same convention — positive deltaY means scrolling down —
         and inverting it here meant every downward scroll was sent
         as an upward one. On a page already at the top that does
         nothing at all, so scrolling simply did not work and there
         was no error anywhere to say why. */
      cmd({ t: "mouse", type: "mouseWheel", x: p.x, y: p.y,
        deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modsOf(e) });
    }, { passive: false });

    /* Touch (RUNNER_PLAN.md §16): a Chromebook's screen is often
       touched. One finger dragging scrolls the page, and a flick keeps
       it going for a moment; a tap clicks; two fingers pinch the zoom.
       Turned into the same wheel and click messages a mouse sends, so
       the relay needs nothing new. Moves are sent once a frame. */
    var touch = null, glide = 0;
    function touchPt(t) { return pt({ clientX: t.clientX, clientY: t.clientY }); }
    function spread(ts) { return Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY); }
    function scrollBy(p, dx, dy) {
      if (dx || dy) cmd({ t: "mouse", type: "mouseWheel", x: p.x, y: p.y, deltaX: dx, deltaY: dy, modifiers: 0 });
    }
    canvas.addEventListener("touchstart", function (e) {
      e.preventDefault();
      if (glide) { cancelAnimationFrame(glide); glide = 0; }
      var ts = e.touches;
      if (ts.length >= 2) {
        touch = { pinch: spread(ts), zoom: live && live.zoom || 1, scrolled: true };
        return;
      }
      var p = touchPt(ts[0]);
      touch = { start: p, last: p, at: Date.now(), scrolled: false, dx: 0, dy: 0, vx: 0, vy: 0, t: Date.now(), frame: 0 };
    }, { passive: false });
    canvas.addEventListener("touchmove", function (e) {
      e.preventDefault();
      if (!touch) return;
      var ts = e.touches;
      if (touch.pinch) { if (ts.length >= 2) touch.scale = spread(ts) / touch.pinch; return; }
      var p = touchPt(ts[0]);
      if (!touch.scrolled && Math.hypot(p.x - touch.start.x, p.y - touch.start.y) < 8) return;
      touch.scrolled = true;
      /* Finger up moves the page up, which is scrolling down. */
      var mx = touch.last.x - p.x, my = touch.last.y - p.y, now = Date.now();
      touch.dx += mx; touch.dy += my;
      var dt = Math.max(1, now - touch.t);
      touch.vx = 0.8 * (mx / dt) + 0.2 * touch.vx;
      touch.vy = 0.8 * (my / dt) + 0.2 * touch.vy;
      touch.last = p; touch.t = now;
      if (!touch.frame) {
        var mine = touch;
        touch.frame = requestAnimationFrame(function () {
          mine.frame = 0;
          scrollBy(mine.last, Math.round(mine.dx), Math.round(mine.dy));
          mine.dx = 0; mine.dy = 0;
        });
      }
    }, { passive: false });
    canvas.addEventListener("touchend", function (e) {
      e.preventDefault();
      var t = touch;
      if (!t || e.touches.length) return;
      touch = null;
      if (t.pinch) {
        if (t.scale && Math.abs(t.scale - 1) > 0.08) {
          var want = t.zoom * t.scale, best = ZOOMS[0];
          ZOOMS.forEach(function (z) { if (Math.abs(z - want) < Math.abs(best - want)) best = z; });
          zoomTo(best);
        }
        return;
      }
      if (!t.scrolled) {
        canvas.focus();
        cmd({ t: "mouse", type: "mouseMoved", x: t.start.x, y: t.start.y, buttons: 0, modifiers: 0 });
        cmd({ t: "mouse", type: "mousePressed", x: t.start.x, y: t.start.y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
        cmd({ t: "mouse", type: "mouseReleased", x: t.start.x, y: t.start.y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
        return;
      }
      if (t.frame) { cancelAnimationFrame(t.frame); scrollBy(t.last, Math.round(t.dx), Math.round(t.dy)); }
      /* The flick: px per ms, carried on for a moment and slowing. */
      var vx = t.vx * 16, vy = t.vy * 16;
      if (Date.now() - t.t > 80 || Math.hypot(vx, vy) < 4) return;
      (function step() {
        vx *= 0.92; vy *= 0.92;
        if (Math.hypot(vx, vy) < 1 || !alive()) { glide = 0; return; }
        scrollBy(t.last, Math.round(vx), Math.round(vy));
        glide = requestAnimationFrame(step);
      })();
    }, { passive: false });
    canvas.addEventListener("touchcancel", function () { touch = null; }, { passive: false });

    function onKeyDown(e) {
      if (!live || document.activeElement === addr) return;
      /* Keys the panel needs to keep. Everything else belongs to the
         page, including Tab — a form is not usable without it. */
      if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
        e.preventDefault(); cmd({ t: "reload" }); return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault(); addr.focus(); addr.select(); return;
      }
      var k = e.key.toLowerCase(), ctl = e.ctrlKey || e.metaKey;
      if (ctl && !e.altKey) {
        if (k === "f") { e.preventDefault(); findOpen(); return; }
        if (k === "=" || k === "+") { e.preventDefault(); zoomStep(1); return; }
        if (k === "-" || k === "_") { e.preventDefault(); zoomStep(-1); return; }
        if (k === "0") { e.preventDefault(); zoomTo(1); return; }
        /* Paste: left alone, so the browser fires a paste event below
           with the Chromebook's clipboard in it. Cancelling the key
           cancels the paste with it. */
        if (k === "v") return;
        /* Cut: the selection is read first and the cut done after, on
           the relay, so it is not gone before it is copied. */
        if (k === "x") { e.preventDefault(); cmd({ t: "copy", cut: true }); return; }
      }
      e.preventDefault();
      cmd({ t: "key", type: "keydown", key: e.key, code: e.code,
        keyCode: e.keyCode, modifiers: modsOf(e),
        text: isTypedChar(e) ? e.key : undefined });
      /* Copy: the page gets its Ctrl-C as usual, and the selection
         comes back for the Chromebook's own clipboard. */
      if (ctl && !e.altKey && k === "c") cmd({ t: "copy" });
    }
    function onKeyUp(e) {
      if (!live || document.activeElement === addr) return;
      e.preventDefault();
      cmd({ t: "key", type: "keyup", key: e.key, code: e.code,
        keyCode: e.keyCode, modifiers: modsOf(e) });
    }
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);

    /* Paste cannot be synthesised key by key — the clipboard is not
       readable that way and a long paste as keystrokes is slow and
       lossy. insertText on the far side is exactly right. */
    canvas.addEventListener("paste", function (e) {
      var text = (e.clipboardData || window.clipboardData).getData("text");
      if (!text) return;
      e.preventDefault();
      cmd({ t: "key", type: "char", text: text.slice(0, 4096) });
    });

    live.offKeys = function () {
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
    };

    if (window.ResizeObserver) {
      live.ro = new ResizeObserver(function () { if (live) { fit(); setHidden(isHidden()); } });
      live.ro.observe(wrap);
    }
  }

  function render(host) {
    ui.clear(host);

    if (!relayBase()) {
      host.appendChild(el("div", { class: "br-empty" }, [
        el("div", { class: "br-empty-h", text: "NO RELAY CONFIGURED" }),
        el("div", { class: "br-empty-p", text:
          "Pages are fetched by your relay and served back through it. " +
          "Set the relay address in SETTINGS, then come back." })
      ]));
      return;
    }

    /* THE STREAMED BROWSER, IF THE RELAY HAS ONE.

       Decided in mount() rather than here, so this stays a single
       synchronous draw. A panel that renders one browser and then
       swaps it for the other is a flash of the wrong thing every
       time somebody opens it.

       A relay with no chromium in its container falls through to
       everything below, which is the proxy, unchanged. */
    if (liveReady) return renderLive(host, liveInfo);

    var frame = el("iframe", {
      class: "br-frame",
      /* THIS SET GOT LARGER AND THE REASON IS WORTH READING.

         It used to be allow-forms and nothing else, with the relay
         deleting every script before the page ever arrived. That is
         a genuinely safer browser and it is also one that cannot
         load most of the web: a modern site's HTML is a loading
         screen, and the page is assembled afterwards by code. Asked
         for a browser where any site loads, the scripts have to run,
         and if they run here they need permission here.

         allow-scripts — the site's own code, and the relay's shim
         that sits in front of it rewriting the URLs that code builds
         at runtime. Without this the shim does not exist and the
         un-stripped scripts are inert, which is the same class of
         mistake as the empty sandbox that quietly broke every form.

         allow-same-origin — a frame without it gets an OPAQUE origin,
         and on an opaque origin localStorage and document.cookie
         throw rather than return empty. Sites do not guard those, so
         the first access ends the page's JavaScript. It also makes
         location.origin the string "null", which the shim compares
         against to catch URLs the site resolved against the wrong
         origin. Both halves of the script story need it.

           The usual objection to allow-scripts + allow-same-origin is
           that a frame can then reach into its parent and delete the
           sandbox attribute. That requires being same-origin WITH THE
           PARENT. This parent is file:// and the frame is
           https://relay — different origins, permanently, and it is
           the same boundary that forced the toolbar server-side. The
           frame cannot see this document at all.

           The real cost is different and is not a browser bug: every
           proxied site shares ONE origin, the relay's. Site A's
           script can read what site B left in localStorage or in a
           cookie on that origin. Every single-origin web proxy has
           this and this one is no exception. Do not sign in to
           anything through here that you would mind another site
           reading. A new ticket does not fix it either — the origin
           is the same for everybody.

         allow-forms — the toolbar the relay serves IS a form, and so
         is every site's search box. Verified, not assumed: without
         it the same form stays put; with it it navigates.

         allow-popups — window.open returns null without it, and
         sites that check the result show "please allow popups"
         instead of working. The shim routes the URL back through the
         proxy first. NOT allow-popups-to-escape-sandbox, so anything
         opened carries these same limits.

         STILL ABSENT, deliberately:

         allow-top-navigation — a proxied page must never be able to
         navigate FIELDKIT.html out from under itself. The rewriter
         retargets links to _self so this costs nothing visible.

         allow-modals — alert/confirm/prompt no-op instead of
         blocking. A page that loops on alert() would otherwise take
         the whole console down with it, and nothing needs a modal
         to render.

         allow-downloads — this is for reading. A download here would
         land on the host machine, outside anything FieldKit can see
         or clean up.

         So: the frame can now run code, and the thing keeping it away
         from the rest of FieldKit is no longer "it cannot script" —
         it is that it is a different origin from this page and cannot
         navigate the top. That is one wall instead of two, it is the
         wall the whole design already rests on, and the trade was
         made on purpose rather than discovered later. */
      sandbox: SANDBOX.join(" "),
      /* Both spellings. `allow` is the Permissions Policy list and is
         what every current engine reads; `allowfullscreen` is the
         older boolean, still honoured, and costs one attribute to
         keep working on whatever the school machine is running. */
      allow: ALLOW.join("; "),
      allowfullscreen: true,
      referrerpolicy: "no-referrer"
    });
    frame.addEventListener("load", onFrameLoad);

    nodes.frame = frame;
    nodes.status = el("div", { class: "br-status", text: "starting…" });
    nodes.engines = el("div", { class: "br-eng", style: { display: "none" } });

    /* The three that steer, kept as their own group and as the
       leftmost thing in the bar, because that is where every browser
       ever made puts them and muscle memory is a feature.

       They are plain buttons rather than ui.button so they can be
       small, glyph-only and disabled — a disabled ui.button is not
       something that component does. */
    function navBtn(glyph, title, what) {
      return el("button", {
        class: "br-nav", type: "button", text: glyph, title: title,
        onclick: function () { navigate(what); }
      });
    }
    nodes.back = navBtn("◁", "back", "back");
    nodes.fwd = navBtn("▷", "forward", "fwd");
    nodes.reload = navBtn("↻", "reload this page", "reload");
    nodes.back.disabled = true;
    nodes.fwd.disabled = true;

    host.appendChild(el("div", { class: "br-wrap" }, [
      el("div", { class: "br-toolbar" }, [
        el("span", { class: "br-lbl", text: "BROWSER" }),
        el("span", { class: "br-navgroup" }, [nodes.back, nodes.fwd, nodes.reload]),
        ui.button("NEW SESSION", function () { open(true); }, {
          title: "start again with a fresh browse pass and empty history" }),
        ui.button("ENGINES", testEngines, {
          title: "ask the relay which search engines will answer it" }),
        /* Fullscreen belongs here as well as in the title bar. A game
           in a proxied page cannot take the screen unless something
           above it does, and the person about to press it is looking
           at the browser, not at the window chrome. */
        ui.button("FULLSCREEN", function () {
          var sh = FieldKit.service("shell");
          if (sh && sh.fullscreen) sh.fullscreen("browser");
          else ui.toast("NO SHELL TO GO FULLSCREEN WITH", "warn");
        }, { title: "give this window the whole screen — Esc to come back" })
      ]),
      frame,
      nodes.engines,
      nodes.status,
      buildNote()
    ]));

    open(false);
  }

  /* THE NOTE THAT WAS BIGGER THAN THE WEB PAGE.

     All of this text was on screen, permanently, under the frame.
     Measured in the panel at its default size: the note was 157
     pixels of 561, the frame got 339, and inside that frame the
     relay's own bar took another slice. So the thing this window
     exists to show had well under half the window, and the half it
     lost was spent on a paragraph that does not change and that
     nobody reads twice.

     Not deleted, because every sentence in it is true and two of
     them are the kind of true you want in front of someone before
     they sign in to something. Collapsed instead: the line that
     matters at a glance stays out, the rest is one click away and
     stays in the DOM — which is also what keeps the selfcheck below
     honest, since it reads this element's text and would otherwise
     start passing because the words had been removed rather than
     because they were being shown.

     Open state is remembered per session in module scope rather than
     saved: someone who opens it wants it for the next page too, and
     someone who closed it does not want it back tomorrow. */
  var noteOpen = false;

  var NOTE_FULL =
    "The address bar is inside the page, served by your relay — out here it " +
    "could not see where the frame went, because this page and that frame are " +
    "different origins. The back, forward and reload buttons up here work " +
    "anyway: they do not read the frame, they tell the relay to move, and the " +
    "history is the relay's. " +
    "Your relay fetches each page and runs its scripts through a shim that puts " +
    "their requests back through the relay, so most sites work. WebSockets do " +
    "not, so live chat and anything that updates by itself will sit still. " +
    "Every site you open here shares one origin — the relay's — so a site you " +
    "visit can read what another site left in storage. Do not sign in to " +
    "anything here that you would mind another site reading. " +
    "Games and video mostly work now — the frame is allowed fullscreen, a " +
    "gamepad and pointer lock, and FULLSCREEN gives the whole screen to the " +
    "window. What still fails is a host that blocks your relay's address " +
    "outright, which is common for game files behind a CDN: the page loads and " +
    "the one piece inside it says so. Nothing here tries to get past a block. " +
    "This is NOT anonymity: your relay sees every address you ask for, and the " +
    "network you are on sees a connection to your relay for the whole session. " +
    "It hides what you read from the local network. It does not hide you from " +
    "anyone, and it hides nothing from whoever can read the relay.";

  /* The one line. Chosen as the two things that change what somebody
     DOES: every site shares an origin, so do not sign in; and the
     relay sees everything, so this is not anonymity. */
  var NOTE_SHORT =
    "Every site here shares one origin — do not sign in to anything you would " +
    "mind another site reading. Not anonymity: your relay sees every address.";

  function buildNote() {
    nodes.noteBody = el("div", { class: "br-note-body", text: NOTE_FULL });
    nodes.noteToggle = el("button", {
      class: "br-note-toggle", type: "button",
      text: noteOpen ? "LESS ▾" : "WHAT THIS CANNOT DO ▸",
      onclick: function () { setNoteOpen(!noteOpen); }
    });
    nodes.note = el("div", { class: "br-note" + (noteOpen ? " open" : "") }, [
      el("div", { class: "br-note-line" }, [
        el("span", { class: "br-note-short", text: NOTE_SHORT }),
        nodes.noteToggle
      ]),
      nodes.noteBody
    ]);
    return nodes.note;
  }

  function setNoteOpen(on) {
    noteOpen = !!on;
    if (!nodes.note) return;
    nodes.note.className = "br-note" + (noteOpen ? " open" : "");
    nodes.noteToggle.textContent = noteOpen ? "LESS ▾" : "WHAT THIS CANNOT DO ▸";
  }

  /* ---- selfcheck --------------------------------------------------- */
  function selfcheck() {
    return [
      /* An equality on the whole set, not a contains-check. The
         interesting failure is a token nobody meant to grant, and a
         contains-check cannot see one. */
      { name: "THE FRAME IS SANDBOXED TO A KNOWN SET", critical: true, run: async function () {
        if (!nodes.frame) throw new Error("SKIPPED — no relay configured, so no frame was built");
        var s = nodes.frame.getAttribute("sandbox");
        if (s === null || s === undefined) throw new Error("the frame has no sandbox attribute at all");
        var granted = String(s).trim().split(/\s+/).filter(Boolean);

        var extra = granted.filter(function (g) { return SANDBOX.indexOf(g) < 0; });
        if (extra.length) throw new Error("more is allowed than was decided: " + extra.join(", "));
        var missing = SANDBOX.filter(function (g) { return granted.indexOf(g) < 0; });
        if (missing.length) throw new Error("the frame is missing " + missing.join(", ") +
          " — with scripts running, every one of those is load bearing");

        /* Named individually because these are the ones that would
           let a proxied page out of the frame, and a future edit that
           adds one should have to argue with this line. */
        ["allow-top-navigation", "allow-top-navigation-by-user-activation",
         "allow-popups-to-escape-sandbox", "allow-downloads", "allow-modals"
        ].forEach(function (bad) {
          if (granted.indexOf(bad) >= 0) throw new Error(bad + " is granted, and it should never be");
        });

        return 'sandbox="' + granted.join(" ") + '" — scripts run, but it is a ' +
          "different origin from this page and cannot navigate the top";
      } },

      /* The rule the ticket exists to keep. */
      { name: "THE VAULT TOKEN NEVER GOES IN A URL", critical: true, run: async function () {
        var src = String(uiUrl) + String(open) + String(getTicket);
        if (/setToken|authToken|Authorization/.test(src)) {
          throw new Error("a credential is being handled where only a ticket should be");
        }
        var built = uiUrl("TICKET");
        if (built.indexOf("TICKET") < 0) throw new Error("the ticket is not in the url");
        if (/Bearer/i.test(built)) throw new Error("a bearer token reached the url");
        return "urls carry a browse ticket and nothing else";
      } },

      { name: "A TICKET IS NOT KEPT ANYWHERE PERSISTENT", critical: true, run: async function () {
        var src = String(getTicket);
        if (/localStorage|sessionStorage|settings\.set|store\.put/.test(src)) {
          throw new Error("the ticket is being written somewhere that outlives the tab");
        }
        return "memory only, renewed after " + Math.round(TICKET_FRESH_MS / 60000) + " minutes";
      } },

      /* The one that made the whole panel do nothing at all, and the
         reason it is worth a permanent check: it fails silently and
         it fails completely. */
      { name: "A MESSAGE IN THE FRAME DOES NOT BLOCK NAVIGATION", critical: true, run: async function () {
        if (!nodes.frame) throw new Error("SKIPPED — no relay configured, so no frame was built");
        var hadSrc = nodes.frame.getAttribute("src");
        var hadDoc = nodes.frame.getAttribute("srcdoc");
        try {
          showMessage("SELF TEST", "checking that this can be navigated away from");
          if (!nodes.frame.getAttribute("srcdoc")) throw new Error("the message did not render");
          frameShowUrl("about:blank");
          if (nodes.frame.hasAttribute("srcdoc")) {
            throw new Error("srcdoc survived a navigation — the frame would silently " +
              "ignore every address from here on");
          }
          return "srcdoc is cleared before src is set, in that order";
        } finally {
          if (hadDoc) { nodes.frame.removeAttribute("src"); nodes.frame.srcdoc = hadDoc; }
          else if (hadSrc) { nodes.frame.removeAttribute("srcdoc"); nodes.frame.src = hadSrc; }
        }
      } },

      /* Nothing out here steers the frame, and that is not an
         accident to be quietly reversed later: the moment this side
         starts building page URLs again it needs to know where the
         frame is, and it cannot. */
      { name: "NAVIGATION IS THE RELAY'S JOB, NOT THIS PANEL'S", critical: false, run: async function () {
        /* navUrl and navigate are in the scan now. They are the new
           way this side steers the frame, and the point of scanning
           them is that steering must stay "ask the relay to move"
           and never become "work out where back is and go there" —
           which this side cannot do correctly and would get subtly
           wrong the first time a page redirected. */
        var src = String(render) + String(open) + String(onFrameLoad) +
          String(navUrl) + String(navigate);
        if (/contentWindow|contentDocument/.test(src)) {
          throw new Error("something is reaching into the frame, which is cross-origin " +
            "and will always fail");
        }
        if (/\/browse\/p\//.test(src)) {
          throw new Error("this side is building page urls again — that is what the " +
            "server-rendered toolbar exists to stop");
        }
        return "this side builds commands (/browse/ui, back, fwd, reload), never page urls";
      } },

      { name: "IT SAYS WHAT IT IS NOT", critical: false, run: async function () {
        if (!nodes.frame) throw new Error("SKIPPED — no relay configured");
        var note = nodes.frame.parentNode &&
          nodes.frame.parentNode.querySelector(".br-note");
        /* textContent, so a collapsed note still counts — the words
           have to be present and reachable, not necessarily painted.
           What must NOT happen is the collapse turning into a
           deletion the next time somebody tidies this file. */
        var text = note ? note.textContent : "";
        [[/websockets? do\s*\n?\s*not|websockets/i, "which things still will not work"],
         [/share one origin|shares one origin/i, "that every site here shares one origin"],
         [/NOT anonymity/, "that it is not anonymity"],
         [/does not hide you/i, "who it does not hide you from"]].forEach(function (p) {
          if (!p[0].test(text)) throw new Error("it does not say " + p[1]);
        });
        var short = note && note.querySelector(".br-note-short");
        if (!short) throw new Error("the always-visible line is gone");
        if (!/sign in/i.test(short.textContent) || !/anonymity/i.test(short.textContent)) {
          throw new Error("the line that is always visible no longer carries the two " +
            "warnings that change what somebody does");
        }
        if (!note.querySelector(".br-note-toggle")) {
          throw new Error("there is no way to open the rest of it");
        }
        return "the limits are reachable, and the two that matter are never hidden";
      } }
    ];
  }

  FieldKit.register("browser", {
    title: "BROWSER",
    icon: "🌐",
    group: "ONLINE",
    about: "Browse the web through the relay, with your own sign-ins",
    keywords: "web internet site page google search chrome surf youtube",
    width: 900,
    height: 640,
    guestSafe: false,
    selfcheck: selfcheck,
    prewarm: prewarm,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      alive = FieldKit.mountGuard("browser");
      injectCSS();

      /* One cheap unauthenticated GET that says which of the two
         browsers this relay can actually give you. It is allowed to
         fail: a relay that is old, off, or unreachable simply has no
         streamed browser and the proxy answers instead. */
      liveInfo = await liveStatus();
      /* "available", not just "ready": Chromium starts on the first
         ticket, so a relay nobody has browsed on since it restarted says
         ready: false, and this used to give everyone the proxy instead —
         which is how the streamed browser went unseen on the real relay. */
      liveReady = !!(liveInfo && liveInfo.enabled && (liveInfo.ready || liveInfo.available));
      if (!alive()) return;

      render(host);
    },

    unmount() {
      live_usageStop();
      /* A stream left open keeps a Chromium session warm on the
         relay and keeps sending frames nobody is looking at. */
      closeLive();
      /* The frame is holding a live connection to the relay. Left
         alone it keeps loading whatever it was loading into a panel
         nobody can see. */
      if (nodes.frame) { nodes.frame.removeAttribute("src"); nodes.frame.srcdoc = ""; }
      if (alive && alive.end) alive.end();
      nodes = {};
    }
  });

  function injectCSS() {
    if (document.getElementById("br-style")) return;
    var s = document.createElement("style");
    s.id = "br-style";
    s.textContent = [
      ".br-wrap{display:flex;flex-direction:column;height:100%;gap:6px}",
      ".br-toolbar{display:flex;gap:6px;align-items:center}",
      ".br-lbl{font-size:9px;letter-spacing:.22em;color:var(--fg-dimmer)}",
      ".br-navgroup{display:flex;gap:3px;flex:1}",
      ".br-nav{width:26px;height:22px;font:inherit;font-size:12px;line-height:1;padding:0;",
      "  background:#10130f;border:1px solid var(--line2);color:var(--fg-dim);cursor:pointer}",
      ".br-nav:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}",
      ".br-nav:disabled{opacity:.35;cursor:default}",
      ".br-eng{border:1px solid var(--line2);background:rgba(0,0,0,.3);padding:8px;",
      "  max-height:44%;overflow-y:auto;flex:0 0 auto}",
      ".br-eng-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}",
      ".br-eng-h{font-size:9px;letter-spacing:.18em;color:var(--accent);flex:1}",
      ".br-eng-x{flex:0 0 auto;font:inherit;font-size:9px;letter-spacing:.14em;",
      "  background:none;border:1px solid var(--line2);color:var(--fg-dim);",
      "  cursor:pointer;padding:1px 7px}",
      ".br-eng-x:hover{border-color:var(--accent);color:var(--accent)}",
      ".br-eng-p{font-size:10px;color:var(--fg-dimmer);line-height:1.55;margin:6px 0}",
      ".br-eng-row{display:flex;gap:8px;align-items:center;padding:3px 0;",
      "  border-bottom:1px solid rgba(255,255,255,.05)}",
      ".br-eng-row.bad{opacity:.55}",
      ".br-eng-n{font-size:11px;color:var(--fg);flex:0 0 130px}",
      ".br-eng-d{font-size:10px;color:var(--fg-dim);flex:1;line-height:1.4}",
      ".br-eng-cur{font-size:9px;letter-spacing:.12em;color:var(--pass)}",
      ".br-frame{flex:1;width:100%;border:1px solid var(--line);background:#0c100e;min-height:0}",
      ".br-status{font-size:10px;color:var(--fg-dim);letter-spacing:.06em;",
      "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".br-status.bad{color:var(--fail)}",
      ".br-status.warn{color:var(--warn)}",
      ".br-status.ok{color:var(--pass)}",
      ".br-note{font-size:10px;color:var(--fg-dimmer);line-height:1.5;",
      "  border-top:1px solid var(--line);padding-top:6px;flex:0 0 auto}",
      ".br-note-line{display:flex;gap:8px;align-items:baseline}",
      ".br-note-short{flex:1;min-width:0}",
      ".br-note-toggle{flex:0 0 auto;font:inherit;font-size:9px;letter-spacing:.12em;",
      "  background:none;border:0;color:var(--fg-dim);cursor:pointer;padding:0}",
      ".br-note-toggle:hover{color:var(--accent)}",
      ".br-note-body{display:none;margin-top:6px;max-height:150px;overflow-y:auto}",
      ".br-note.open .br-note-body{display:block}",
      ".br-canvas-wrap{flex:1;min-height:0;position:relative;",
      "  border:1px solid var(--line);background:#0c100e;overflow:hidden}",
      ".br-canvas{display:block;width:100%;height:100%;outline:none;cursor:default}",
      ".br-canvas:focus{outline:1px solid var(--accent);outline-offset:-1px}",
      ".br-addr{flex:1;min-width:0;font:inherit;font-size:11px;background:#0c100e;",
      "  color:var(--fg);border:1px solid var(--line);padding:3px 6px}",
      ".br-addr:focus{outline:none;border-color:var(--accent)}",
      ".br-nav.br-word,.br-zoom{width:auto;padding:0 6px;font-size:10px;letter-spacing:.06em;flex:0 0 auto}",
      ".br-findbar{display:flex;gap:4px;align-items:center;flex:0 0 auto}",
      ".br-findin{flex:0 1 260px}",
      ".br-findsaid{font-size:10px;color:var(--warn);flex:1}",
      /* Tabs and the notes for downloads and "choose file" (§16). */
      ".br-tabs{display:flex;gap:3px;flex:0 0 auto;overflow-x:auto;scrollbar-width:thin}",
      ".br-tab{display:flex;align-items:stretch;flex:0 1 190px;min-width:70px;border:1px solid var(--line);background:#0c100e}",
      ".br-tab.on{border-color:var(--accent-dim);background:rgba(var(--accent-glow),.1)}",
      ".br-tab-t{flex:1;min-width:0;background:none;border:0;color:var(--fg-dim);font:inherit;font-size:10px;",
      "  text-align:left;padding:4px 6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".br-tab.on .br-tab-t{color:var(--accent)}",
      ".br-tab-x{flex:none;background:none;border:0;color:var(--fg-dimmer);font:inherit;font-size:9px;padding:0 6px;cursor:pointer}",
      ".br-tab-x:hover{color:var(--fail)}",
      ".br-asks{display:flex;flex-direction:column;gap:3px;flex:0 0 auto}",
      ".br-nav.on{color:var(--accent);border-color:var(--accent)}",
      ".br-places{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;border:1px solid var(--accent-dim);padding:6px}",
      ".br-places-head{display:flex;gap:4px;align-items:center;flex-wrap:wrap}",
      ".br-places-keep{font-size:10px;color:var(--fg-dim);display:flex;align-items:center;gap:2px}",
      ".br-places-list{max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:1px}",
      ".br-places-none{font-size:11px;color:var(--fg-dimmer);padding:4px}",
      ".br-use-line{font-size:11px;white-space:pre-wrap;color:var(--fg-dim)}",
      ".br-place{display:flex;gap:4px;align-items:center}",
      ".br-place-go{flex:1;min-width:0;display:flex;gap:8px;align-items:baseline;background:none;border:0;padding:3px 4px;",
      "  font:inherit;color:var(--fg);text-align:left;cursor:pointer}",
      ".br-place-go:hover{background:var(--accent-dim)}",
      ".br-place-t{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}",
      ".br-place-u{font-size:10px;color:var(--fg-dimmer);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}",
      ".br-asks:empty{display:none}",
      ".br-ask{display:flex;gap:6px;align-items:center;padding:4px 6px;border:1px solid var(--accent-dim);",
      "  background:rgba(var(--accent-glow),.07)}",
      ".br-ask-t{flex:1;min-width:0;font-size:11px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".br-ask-t.warn{color:var(--warn)}",
      ".br-empty{padding:28px;text-align:center}",
      ".br-empty-h{font-size:12px;letter-spacing:.2em;color:var(--accent);margin-bottom:6px}",
      ".br-empty-p{font-size:11px;color:var(--fg-dim);line-height:1.6}"
    ].join("\n");
    document.head.appendChild(s);
  }
})(window.FieldKit);
