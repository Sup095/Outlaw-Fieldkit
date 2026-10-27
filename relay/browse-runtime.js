/* ============================================================
   FieldKit relay :: browse-runtime

   The script injected at the top of every proxied page, as a
   string, so it runs before the site's own code does.

   ---- WHY A PAGE NEEDS THIS AT ALL -----------------------------

   The proxy rewrites URLs in the HTML it serves. That is enough for
   a document, and it is nowhere near enough for a page that runs
   JavaScript, because the interesting URLs are not in the HTML —
   they are built at runtime by code that has no idea it is being
   proxied. `fetch("/api/user")` resolves against the document's
   origin, which is the relay, so it asks the RELAY for /api/user
   and gets a 404. Every SPA does this on its first paint, which is
   why a site either works completely or shows a blank page.

   So the page gets a shim that knows two things the site does not:
   what the real URL of this page is, and how to turn any URL the
   site produces back into one that comes through the proxy.

   ---- WHAT IT CANNOT DO ----------------------------------------

   `window.location` cannot be replaced. It is non-configurable in
   every current engine — and so are its own methods, `assign`,
   `replace` and `reload`, which are [LegacyUnforgeable] properties of
   the instance rather than of a prototype, so there is nothing to
   patch. A site that reads `location.hostname` sees the relay's
   hostname, and a site that assigns to `location.href` navigates
   without going through toProxy().

   Two things soften that and neither closes it. Clicks and submits
   are caught here, before the browser commits. And a navigation that
   does get away lands on the relay's own root, where the relay
   redirects it back into the proxy using the Referer of the page it
   came from — a net one layer further out, in browse.js.

   What stays broken: a site that BRANCHES on its own hostname takes
   the wrong branch. Nothing short of rewriting its JavaScript at the
   syntax level fixes that, and that is a different project. It is a
   real ceiling and it is stated here rather than discovered.

   ---- THE PATH, WHICH USED TO BE BROKEN TOO --------------------

   The same used to be true of the PATH, and that one turned out to
   be fixable, and fixing it is the difference between "you can open
   the site" and "you can use it".

   A single-page application does not route on its URL bar for show:
   YouTube's page manager reads location.pathname, matches it against
   a table, and builds the component for whichever route it finds.
   Served from /browse/p/<ticket>/https:/www.youtube.com/results it
   matched nothing, built nothing, and left an empty shell with a
   masthead on top of it. That is the blank screen — not a crash, not
   a failed request, a router that was asked for a page called
   "/browse" and correctly had none.

   location cannot be replaced, but its VISIBLE VALUE can be set:
   history.replaceState takes a URL. So the shim, on a real page,
   immediately rewrites the address to the site's own path and query
   — /results?search_query=godot — and the router then sees exactly
   what it would see on the real site. Measured: from an empty
   page-manager and no title to YTD-SEARCH, three result renderers
   and the right title, on the same request.

   Two things fall out of that and both are handled below:

     - pushState must stop proxying. The patch used to turn every
       url a router pushed into a /browse/p/… path, which put the
       thing we just removed straight back and broke the next route
       change. Under pathMode it keeps same-site urls visible.

     - a request the shim never saw now lands on a bare relay path.
       So the visible url carries __fk=<ticket>, which is how the
       relay maps that path back to the site the ticket is on. See
       rescueFromReferer() in browse.js.

   It is a setting rather than an assumption because it is a change
   to what every page's address says, and a site that reads its own
   query string and objects to an extra parameter is the kind of
   thing you want to be able to switch off without editing code.

   WebSockets are not proxied. A relay that opened arbitrary
   outbound sockets on request is a different and much larger thing
   than a page fetcher, so the constructor throws something legible
   instead of hanging forever.

   Everything here is inside one IIFE with no globals but the one
   namespace, because it shares a window with code that assumes it
   is alone.
   ============================================================ */
"use strict";

/* Built as a function-to-string rather than a file read at request
   time: the values it needs are per-page, and a template with three
   substitutions is easier to be sure of than a file plus a config
   blob the page could tamper with before it runs. */
function runtimeSource(realUrl, ticket, opts) {
  opts = opts || {};
  /* `frame` marks this as a NESTED frame — a comments widget, a
     video player — rather than the page itself. It rides in the
     prefix so everything this document goes on to build at runtime
     stays marked too, and the relay keeps it out of the history the
     Back button walks. See proxied() in browse.js for what went
     wrong without it. */
  const cfg = JSON.stringify({
    real: String(realUrl),
    ticket: String(ticket || ""),
    prefix: "/browse/p/" + encodeURIComponent(String(ticket || "-")) +
      (opts.frame ? ".f" : "") + "/",
    debug: !!opts.debug,
    pathMode: !!opts.pathMode
  });

  /* The URL goes into the config, the config goes inside a <script>
     element, and JSON.stringify does not escape "<". So a page whose
     address contained `</script><script>…` would close this tag and
     get its own script running FIRST, before the shim, with the
     ticket in hand — on an origin shared with every other site read
     through this proxy. The address is not something we choose: it is
     wherever a redirect landed.

     Escaping "<" as < is valid JSON, valid JavaScript, parses
     back to the same string, and there is no longer a "<" anywhere in
     the emitted text for the HTML parser to find. Doing it here means
     it cannot be forgotten at a call site. */
  const safe = cfg.replace(/</g, "\\u003c");

  return "(" + SHIM.toString() + ")(" + safe + ");";
}

/* The shim itself. Written as a real function so it is syntax
   checked at load and readable in a debugger, then stringified. It
   must not close over anything from this file. */
function SHIM(CFG) {
  var W = window;
  if (W.__fkProxy) return;              // one shim per window, not one per script tag

  var REAL = CFG.real;
  var PREFIX = CFG.prefix;
  var SELF = W.location.origin;
  var realOrigin, realBase;
  try {
    var ru = new URL(REAL);
    realOrigin = ru.origin;
    realBase = REAL;
  } catch (e) { realOrigin = ""; realBase = REAL; }

  function isProxied(u) {
    return u.indexOf(PREFIX) === 0 ||
      u.indexOf(SELF + PREFIX) === 0 ||
      u.indexOf("/browse/") === 0 ||
      u.indexOf(SELF + "/browse/") === 0;
  }

  /* Turn whatever the page produced into the real absolute URL it
     meant. The three cases that matter:

       "https://other.com/x"  already absolute, keep it
       "/api/user"            root-relative: the page means the real
                              SITE's root, not the relay's, and this
                              is the one every SPA gets wrong
       "thing.json"           relative: resolve against the real page
  */
  function toReal(input) {
    var u = String(input == null ? "" : input);
    if (!u) return u;
    if (/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(u)) return null;

    /* Already ours: pull the real url back out rather than nesting. */
    var at = u.indexOf(PREFIX);
    if (at >= 0) {
      var rest = u.slice(at + PREFIX.length);
      return /^https?:\/\//i.test(rest) ? rest : "https://" + rest.replace(/^\/+/, "");
    }
    if (/^https?:\/\//i.test(u)) {
      /* An absolute url pointing at the relay itself is the page
         having resolved something against the wrong origin. */
      if (u.indexOf(SELF + "/") === 0) return realOrigin + u.slice(SELF.length);
      return u;
    }
    if (u.indexOf("//") === 0) return "https:" + u;
    try { return new URL(u, realBase).href; } catch (e) { return null; }
  }

  function toProxy(input) {
    var real = toReal(input);
    if (real === null) return input;    // data:, blob:, javascript:, #frag
    return PREFIX + real;
  }

  /* The same thing, marked as a nested frame. See proxied() in
     browse.js: the mark keeps a frame's whole document tree out of
     the history the Back button walks. Derived from PREFIX rather
     than passed in, so a frame inside a frame stays marked once
     rather than accumulating marks. */
  var FRAME_PREFIX = /\.f\/$/.test(PREFIX) ? PREFIX : PREFIX.replace(/\/$/, ".f/");
  function toProxyFrame(input) {
    var real = toReal(input);
    if (real === null) return input;
    return FRAME_PREFIX + real;
  }

  /* The address as the SITE would write it: its own path and query,
     plus the one parameter the relay needs to know which site this
     is when something asks for a bare path. */
  var TKEY = "__fk";
  function visibleFor(input) {
    var real = toReal(input);
    if (real === null) return null;
    var u;
    try { u = new URL(real); } catch (e) { return null; }
    if (!realOrigin || u.origin !== realOrigin) return null;   // off-site stays proxied
    var q = u.search;
    /* Not appended twice — a router that pushes the url it was given
       would otherwise grow one parameter per navigation. */
    if (q.indexOf(TKEY + "=") < 0) {
      q = q ? q + "&" + TKEY + "=" + encodeURIComponent(CFG.ticket)
            : "?" + TKEY + "=" + encodeURIComponent(CFG.ticket);
    }
    return u.pathname + q + u.hash;
  }

  W.__fkProxy = { toReal: toReal, toProxy: toProxy, toProxyFrame: toProxyFrame,
    visibleFor: visibleFor, real: REAL };

  /* Done before the site's own code runs, because a router reads the
     path once, on boot, and never asks again.

     Only a real page. A nested frame keeps its proxy path: it is not
     what the address bar is showing, nothing routes on it, and
     rewriting it would cost the frame mark that keeps a comments
     widget out of the Back history. */
  if (CFG.pathMode && !CFG.frame) {
    try {
      var want = visibleFor(REAL);
      if (want) W.history.replaceState(W.history.state, "", want);
    } catch (e) { /* a page can lock this down; the proxy path still works */ }
  }

  /* ---- fetch ---------------------------------------------------- */
  var _fetch = W.fetch;
  if (_fetch) {
    W.fetch = function (input, init) {
      try {
        if (typeof input === "string") input = toProxy(input);
        else if (input && input.url) {
          /* A Request object is immutable, so it is rebuilt rather
             than edited. Everything else about it is carried over. */
          input = new Request(toProxy(input.url), input);
        }
      } catch (e) { /* never let the shim be the reason a fetch fails */ }
      return _fetch.call(this, input, init);
    };
  }

  /* ---- XMLHttpRequest ------------------------------------------- */
  if (W.XMLHttpRequest) {
    var _open = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function (method, url) {
      var args = [].slice.call(arguments);
      try { args[1] = toProxy(url); } catch (e) {}
      return _open.apply(this, args);
    };
  }

  /* ---- EventSource ---------------------------------------------- */
  if (W.EventSource) {
    var _ES = W.EventSource;
    W.EventSource = function (url, init) { return new _ES(toProxy(url), init); };
    W.EventSource.prototype = _ES.prototype;
  }

  /* ---- WebSocket ------------------------------------------------
     Not proxied. A relay that opened arbitrary outbound sockets on
     request is a much larger thing than a page fetcher, and pushing
     that decision behind a silent failure would be worse than
     saying so. Sites that use one for chat or live updates lose
     that feature and keep the rest of the page. */
  if (W.WebSocket) {
    var _WS = W.WebSocket;
    W.WebSocket = function (url) {
      throw new Error("FIELDKIT READER: websockets are not proxied (" + url + ")");
    };
    W.WebSocket.prototype = _WS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k, i) {
      try { W.WebSocket[k] = i; } catch (e) {}
    });
  }

  /* ---- workers ---------------------------------------------------
     The URL is re-pointed so the worker's SCRIPT loads. What the
     worker then fetches is on its own — a worker is a separate global
     with no shim in it, so its root-relative requests come back to
     the relay's root. Those are caught one layer further out, by the
     relay's referer rescue, which is a weaker net than this one but
     is better than the worker simply failing. */
  ["Worker", "SharedWorker"].forEach(function (name) {
    var Ctor = W[name];
    if (!Ctor) return;
    var Patched = function (url, options) { return new Ctor(toProxy(url), options); };
    Patched.prototype = Ctor.prototype;
    try { W[name] = Patched; } catch (e) {}
  });

  /* ---- sendBeacon ------------------------------------------------ */
  if (W.navigator && typeof W.navigator.sendBeacon === "function") {
    var _beacon = W.navigator.sendBeacon.bind(W.navigator);
    try {
      W.navigator.sendBeacon = function (url, data) {
        try { url = toProxy(url); } catch (e) {}
        return _beacon(url, data);
      };
    } catch (e) {}
  }

  /* ---- history --------------------------------------------------
     A site calling pushState("/page/2") would move the address to
     the relay's root and the next relative fetch would resolve from
     there. Rewritten so the visible URL stays inside the proxy. */
  ["pushState", "replaceState"].forEach(function (name) {
    var orig = W.history && W.history[name];
    if (!orig) return;
    W.history[name] = function (state, title, url) {
      if (url !== undefined && url !== null) {
        try {
          /* Under pathMode a same-site url stays visible. Proxying it
             here is what broke the SECOND route change after the
             first one was fixed: the router pushes /watch?v=…, the
             patch turned it into /browse/p/…, and the next thing to
             read the path was back where it started. */
          var vis = CFG.pathMode && !CFG.frame ? visibleFor(url) : null;
          url = vis !== null && vis !== undefined ? vis : toProxy(url);
        } catch (e) {}
      }
      return orig.call(W.history, state, title, url);
    };
  });

  /* ---- window.open ---------------------------------------------- */
  var _wopen = W.open;
  if (_wopen) {
    W.open = function (url) {
      var args = [].slice.call(arguments);
      if (url) { try { args[0] = toProxy(url); } catch (e) {} }
      return _wopen.apply(W, args);
    };
  }

  /* ---- attributes set from script -------------------------------
     The HTML rewriter only sees the HTML. Anything the page builds
     afterwards — an <img> created in a loop, a <script> appended by
     a loader — never passes through it. */
  var URL_ATTRS = { src: 1, href: 1, action: 1, poster: 1, "xlink:href": 1, formaction: 1 };

  /* A frame BUILT AT RUNTIME has to be marked the same way one in the
     markup is, and this is the only place that can do it.

     The rewriter marks `<iframe src>` because it can see the tag. It
     never sees these: Bing appends a hidden login.live.com frame from
     script, and the Godot docs' comments widget appends its own. Both
     were written into history as pages, which is what made Back
     appear to do nothing — twice, because fixing the markup case
     left these behind and the second fix had to be found the same
     way as the first, by reading the history back out of the relay.

     `isFrame` is a tag check rather than an instanceof, because a
     page can and does hand out objects that are not what they claim. */
  function isFrame(el) {
    var tn = el && el.tagName;
    return tn === "IFRAME" || tn === "FRAME";
  }
  function proxyFor(el, value) {
    return isFrame(el) ? toProxyFrame(value) : toProxy(value);
  }

  var _setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name && URL_ATTRS[String(name).toLowerCase()]) {
      try { value = proxyFor(this, value); } catch (e) {}
    }
    return _setAttribute.call(this, name, value);
  };
  var _setAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, name, value) {
    if (name && URL_ATTRS[String(name).toLowerCase().replace(/^.*:/, "")]) {
      try { value = proxyFor(this, value); } catch (e) {}
    }
    return _setAttributeNS.call(this, ns, name, value);
  };

  /* The property form — el.src = "…" — does not go through
     setAttribute, so each one is patched on its prototype. */
  [[W.HTMLImageElement, "src"], [W.HTMLScriptElement, "src"],
   [W.HTMLIFrameElement, "src"], [W.HTMLMediaElement, "src"],
   [W.HTMLSourceElement, "src"], [W.HTMLEmbedElement, "src"],
   [W.HTMLTrackElement, "src"], [W.HTMLInputElement, "src"],
   [W.HTMLLinkElement, "href"], [W.HTMLAnchorElement, "href"],
   [W.HTMLAreaElement, "href"], [W.HTMLFormElement, "action"],
   [W.HTMLObjectElement, "data"]].forEach(function (pair) {
    var Ctor = pair[0], prop = pair[1];
    if (!Ctor || !Ctor.prototype) return;
    var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!d || !d.set || !d.configurable) return;
    Object.defineProperty(Ctor.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: function () { return d.get.call(this); },
      set: function (v) {
        try { v = proxyFor(this, v); } catch (e) {}
        return d.set.call(this, v);
      }
    });
  });

  /* ---- service workers -------------------------------------------
     Refused rather than proxied. A service worker registered by a
     proxied site would install itself on the RELAY's origin with a
     scope of its choosing, outlive the tab, and start intercepting
     requests for every other site read through this proxy. That is
     a genuinely bad outcome and there is no version of it that is
     fine. */
  if (W.navigator && W.navigator.serviceWorker) {
    try {
      Object.defineProperty(W.navigator, "serviceWorker", {
        configurable: true,
        get: function () {
          return {
            register: function () {
              return Promise.reject(new Error(
                "FIELDKIT READER: service workers are not allowed through the proxy"));
            },
            getRegistration: function () { return Promise.resolve(undefined); },
            getRegistrations: function () { return Promise.resolve([]); },
            addEventListener: function () {}, removeEventListener: function () {},
            ready: new Promise(function () {})
          };
        }
      });
    } catch (e) { /* locked down already; nothing to do */ }
  }

  /* ---- clicks ---------------------------------------------------

     THE ONE THAT SENT A CLICK TO THE REAL SITE.

     Reported as "clicking links in something like crazygames says it
     refused to connect", and the refusal was the least interesting
     part: the frame had left the proxy entirely and landed on the
     real site, which then declined to be framed.

     The link was not the problem. Its href in the DOM was rewritten
     correctly and pointed straight back through the proxy. The
     problem is that on a site built with a client-side router —
     Next, React Router, Nuxt, Vue Router, all of them — a link is not
     a link. The router listens for clicks, calls preventDefault, and
     navigates using the href it holds in ITS OWN state, which came
     from the page's hydration data and was never touched by the
     rewriter. So the rewritten href is read by nobody, the router's
     original absolute URL wins, and the frame leaves.

     Rewriting the hydration data is not a fix either: it is
     framework-specific JSON, different in every framework, and the
     router also builds URLs by concatenation at runtime.

     So the click is taken BEFORE the router sees it. A capture-phase
     listener on window runs ahead of anything the page registered on
     document or on its root container, and when the anchor already
     carries a proxied href — meaning the rewriter did its job and we
     know exactly where this should go — the event is stopped dead and
     the navigation is done here.

     WHAT IT COSTS: a client-side route transition becomes a full page
     load. Slower, sometimes visibly. That is the right trade for a
     proxy — a page that reloads is better than a page that quietly
     renders a different site — and it is the difference between
     links working and links not working.

     A modifier click is left alone. Ctrl, Cmd, Shift and the middle
     button all mean "somewhere other than here", the href is already
     correct, and the browser does the right thing with it. */
  W.addEventListener("click", function (ev) {
    if (ev.defaultPrevented) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    var a = ev.target && ev.target.closest && ev.target.closest("a[href]");
    if (!a) return;
    if (a.hasAttribute("download") || a.getAttribute("target") === "_blank") return;

    var href = a.getAttribute("href");
    if (!href || /^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(href)) return;

    var abs;
    try { abs = new URL(href, W.location.href).href; } catch (e) { return; }

    /* Already ours. Take it: the router must not get a say. */
    if (abs.indexOf(SELF) === 0 && isProxied(abs.slice(SELF.length))) {
      /* Not our own toolbar — those are relay routes and go straight
         through, and stopping them would break Back and the address
         box. */
      if (a.getAttribute("data-fieldkit") === "chrome") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      W.location.href = abs;
      return;
    }

    /* Same origin but NOT proxied: the page resolved a URL against
       the relay instead of against itself. Put it back. */
    if (abs.indexOf(SELF) === 0) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      W.location.href = toProxy(href);
      return;
    }

    /* A genuine off-site absolute link. The rewriter should have
       caught it; if it did not, catch it here rather than letting the
       frame leave for a site that will refuse to be framed. */
    if (/^https?:/i.test(abs)) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      W.location.href = toProxy(abs);
    }
  }, true);

  /* Forms built at runtime, same reasoning. */
  W.addEventListener("submit", function (ev) {
    var f = ev.target;
    if (!f || !f.getAttribute) return;
    var action = f.getAttribute("action");
    if (action === null) return;                 // no action = this url, already ours
    var abs;
    try { abs = new URL(action, W.location.href).href; } catch (e) { return; }
    if (abs.indexOf(SELF) === 0 && !isProxied(abs.slice(SELF.length))) {
      f.setAttribute("action", toProxy(action));
    }
  }, true);

  if (CFG.debug && W.console) {
    W.console.info("[fieldkit] proxy shim active for " + REAL);
  }
}

module.exports = { runtimeSource, SHIM };
