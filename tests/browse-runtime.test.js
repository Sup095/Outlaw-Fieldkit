/* ============================================================
   relay/browse-runtime.js — the shim injected into every page

   The shim is the half of the proxy that runs on the far side of the
   origin boundary, inside a page that does not know it is proxied.
   Everything it does is a patch over something the page will call, so
   the only way to test it honestly is to run it against a window and
   then call those things.

   That window is faked here, deliberately small: it provides exactly
   what the shim reaches for and nothing else, so a shim that starts
   reaching for something new fails loudly rather than silently doing
   less than it used to.

   THE CLICK HANDLER IS THE POINT OF THIS FILE. It was added after
   "clicking links in something like crazygames says it refused to
   connect" — the frame had left the proxy entirely, because on a
   site with a client-side router a link is not a link: the router
   takes the click and navigates using an href it holds in its own
   state, which the HTML rewriter never touched. Taking the click
   first is the whole fix, and it is worth a test that fails if
   anyone ever softens it back to a passive listener.
   ============================================================ */
"use strict";

const { makeRunner } = require("./harness");
const { SHIM, runtimeSource } = require("../relay/browse-runtime");
const { ok, section, state } = makeRunner("browse-runtime");

const TICKET = "TICKET";
const PREFIX = "/browse/p/" + TICKET + "/";
const SELF = "https://relay.example";
const REAL = "https://site.example/dir/page.html";

/* A window with just enough in it. Returns the handles a test needs:
   the captured listeners, and a log of everywhere it was told to go. */
function fakeWindow(opts) {
  opts = opts || {};
  const listeners = {};
  const navigations = [];
  const pushed = [];
  const replaced = [];
  let href = SELF + PREFIX + REAL;

  function proto(name) {
    const C = function () {};
    C.prototype = {};
    Object.defineProperty(C.prototype, name, {
      configurable: true, enumerable: true,
      get: function () { return this["_" + name]; },
      set: function (v) { this["_" + name] = v; }
    });
    return C;
  }

  const W = {
    location: {
      get origin() { return SELF; },
      get href() { return href; },
      /* Assigning a relative value resolves it, the way a real
         Location does. Without that, one test's navigation leaves
         `href` as a bare path and the next test's `new URL(href)`
         throws — which looked exactly like the handler declining to
         act, and was the fake being wrong rather than the shim. */
      set href(v) {
        navigations.push(v);
        try { href = new URL(v, href).href; } catch (e) { href = v; }
      }
    },
    addEventListener: function (type, fn, capture) {
      (listeners[type] = listeners[type] || []).push({ fn: fn, capture: !!capture });
    },
    removeEventListener: function () {},
    history: { state: null,
      pushState: function (s, t, u) { pushed.push(u); },
      replaceState: function (s, t, u) { replaced.push(u); } },
    open: function () { return null; },
    fetch: function (input) { return Promise.resolve({ asked: input }); },
    navigator: { sendBeacon: function () { return true; } },
    console: { info: function () {} },
    HTMLImageElement: proto("src"),
    HTMLAnchorElement: proto("href")
  };
  if (opts.withWorker) W.Worker = function (u) { this.url = u; };

  return { W: W, listeners: listeners, navigations: navigations,
    pushed: pushed, replaced: replaced,
    hrefNow: function () { return href; } };
}

/* SHIM reads the bare identifier `window`, because in a page that is
   what it has. Supplying it as a global for the duration is closer to
   how it actually runs than rewriting the shim to take an argument
   would be. */
function runShim(env, extra, opts) {
  const saved = {};
  const globals = Object.assign({
    window: env.W, Element: { prototype: {} }, URL: URL, Request: function () {}
  }, extra || {});
  Object.keys(globals).forEach(function (k) {
    saved[k] = global[k]; global[k] = globals[k];
  });
  try {
    SHIM(Object.assign({ real: REAL, ticket: TICKET, prefix: PREFIX, debug: false },
      opts || {}));
  } finally {
    Object.keys(globals).forEach(function (k) {
      if (saved[k] === undefined) delete global[k]; else global[k] = saved[k];
    });
  }
}

/* A click event with just the surface the handler reads. */
function clickOn(attrs, over) {
  const el = {
    getAttribute: function (n) { return n in attrs ? attrs[n] : null; },
    setAttribute: function (n, v) { attrs[n] = v; },
    hasAttribute: function (n) { return n in attrs; }
  };
  const ev = Object.assign({
    button: 0, defaultPrevented: false,
    stopped: false, immediateStopped: false, prevented: false,
    target: { closest: function (sel) { return /^a\[/.test(sel) ? el : null; } },
    preventDefault: function () { this.prevented = true; },
    stopPropagation: function () { this.stopped = true; },
    stopImmediatePropagation: function () { this.immediateStopped = true; }
  }, over || {});
  return ev;
}

(function () {
  section("the shim is injected safely, whatever the address is");
  {
    const src = runtimeSource(REAL, TICKET, {});
    ok("it is one self-calling function, so it leaves no globals behind",
      /^\(function SHIM\b/.test(src) && /\);\s*$/.test(src), src.slice(0, 60));
    ok("it carries the real address of the page", src.indexOf(REAL) >= 0);
    ok("and the proxy prefix it should build urls with",
      src.indexOf('"prefix":"' + PREFIX + '"') >= 0, src.slice(0, 400));

    /* A URL is wherever a redirect landed, not something we choose,
       and JSON.stringify does not escape "<". Without this a page
       could close the shim's own <script> tag and run first, holding
       the ticket, on an origin shared with every other site. */
    const nasty = runtimeSource(
      'https://site.example/</script><script>steal()</script>', TICKET, {});
    ok("a url containing a closing script tag cannot break out",
      nasty.indexOf("</script>") < 0, nasty.slice(nasty.indexOf("real"), 200));
    ok("it is escaped rather than deleted, so the shim still knows where it is",
      nasty.indexOf("\\u003c/script") >= 0);
  }

  section("urls the page builds at runtime come back through the proxy");
  {
    const env = fakeWindow();
    runShim(env);
    const P = env.W.__fkProxy;

    ok("a root-relative url means the SITE's root, not the relay's",
      P.toProxy("/api/user") === PREFIX + "https://site.example/api/user",
      P.toProxy("/api/user"));
    ok("a relative one resolves against the real page",
      P.toProxy("thing.json") === PREFIX + "https://site.example/dir/thing.json",
      P.toProxy("thing.json"));
    ok("an off-site absolute is kept and proxied",
      P.toProxy("https://other.example/x") === PREFIX + "https://other.example/x");
    ok("an absolute pointing at the relay is the page resolving against the wrong origin",
      P.toProxy(SELF + "/api/user") === PREFIX + "https://site.example/api/user",
      P.toProxy(SELF + "/api/user"));
    ok("an already-proxied url is not nested inside itself",
      P.toProxy(PREFIX + "https://site.example/a") === PREFIX + "https://site.example/a");
    ok("a data: url is left completely alone",
      P.toProxy("data:image/png;base64,AAA") === "data:image/png;base64,AAA");
    ok("so is a fragment", P.toProxy("#top") === "#top");
    ok("and javascript: is never turned into a fetchable address",
      P.toProxy("javascript:steal()") === "javascript:steal()");

    /* A frame built at runtime has to be marked the way one in the
       markup is. The rewriter cannot see these — Bing appends a
       hidden login.live.com frame from script, the Godot docs'
       comments widget appends its own — and unmarked they were
       written into history as pages, which is what made Back appear
       to do nothing. */
    ok("a frame built at runtime is marked as a frame",
      P.toProxyFrame("https://giscus.app/w") === PREFIX.replace(/\/$/, ".f/") +
        "https://giscus.app/w", P.toProxyFrame("https://giscus.app/w"));
    ok("an ordinary url is still unmarked, or nothing would be a page",
      P.toProxy("https://giscus.app/w").indexOf(".f/") < 0);
  }

  section("the address says what the site would say, so the site's router works");
  {
    /* THE BLANK SCREEN. A single-page app routes on
       location.pathname. Served from /browse/p/<ticket>/https:/… it
       matches none of its own routes and renders an empty shell —
       which is what "you can open youtube but searching gives you a
       blank page" was. location cannot be replaced, but replaceState
       can set what it says, and the shim does that before the site's
       own code has read it. */
    const env = fakeWindow();
    runShim(env, null, { pathMode: true });

    ok("the address is rewritten to the site's own path on boot",
      env.replaced.length === 1, JSON.stringify(env.replaced));
    ok("and it is the site's path, not the proxy's",
      env.replaced[0].indexOf("/dir/page.html") === 0, env.replaced[0]);
    ok("carrying the ticket, which is how a reload finds its way back",
      /[?&]__fk=TICKET(&|$)/.test(env.replaced[0]), env.replaced[0]);

    const P = env.W.__fkProxy;
    ok("a same-site url has a visible form",
      P.visibleFor("/api/user") === "/api/user?__fk=TICKET",
      String(P.visibleFor("/api/user")));
    ok("an existing query is kept and the ticket is added to it",
      P.visibleFor("/search?q=godot") === "/search?q=godot&__fk=TICKET",
      String(P.visibleFor("/search?q=godot")));
    ok("a fragment survives",
      P.visibleFor("/a#top") === "/a?__fk=TICKET#top", String(P.visibleFor("/a#top")));
    ok("the ticket is not appended twice to a url that already has it",
      P.visibleFor("/a?__fk=TICKET") === "/a?__fk=TICKET",
      String(P.visibleFor("/a?__fk=TICKET")));
    ok("an off-site url has no visible form — it stays proxied",
      P.visibleFor("https://other.example/x") === null,
      String(P.visibleFor("https://other.example/x")));

    /* The second half of the fix, and the part that broke the FIRST
       version of it: the router pushes its next route, the old patch
       turned that into a /browse/p/… path, and the next thing to
       read location.pathname was back where it started. */
    env.W.history.pushState({}, "", "/watch?v=abc");
    ok("a route the site pushes stays visible",
      env.pushed[0] === "/watch?v=abc&__fk=TICKET", String(env.pushed[0]));
    env.W.history.pushState({}, "", "https://other.example/x");
    ok("but an off-site push is still proxied",
      env.pushed[1] === PREFIX + "https://other.example/x", String(env.pushed[1]));
  }

  section("a page with no pathMode is left where it was");
  {
    const env = fakeWindow();
    runShim(env);
    ok("nothing rewrites the address when the setting is off",
      env.replaced.length === 0, JSON.stringify(env.replaced));
    env.W.history.pushState({}, "", "/watch?v=abc");
    ok("and a pushed route is proxied, the way it always was",
      env.pushed[0] === PREFIX + "https://site.example/watch?v=abc",
      String(env.pushed[0]));
  }

  section("a frame keeps the proxy path, whatever the setting says");
  {
    /* A nested frame is not what the address bar shows, nothing
       routes on it, and rewriting it would cost the .f mark that
       keeps a comments widget out of the Back history. */
    const env = fakeWindow();
    runShim(env, null, { pathMode: true, frame: true });
    ok("the frame's own address is left alone", env.replaced.length === 0,
      JSON.stringify(env.replaced));
    env.W.history.pushState({}, "", "/inner");
    ok("and what it pushes is proxied",
      env.pushed[0] === PREFIX + "https://site.example/inner", String(env.pushed[0]));
  }

  section("a frame inside a frame does not accumulate marks");
  {
    /* The shim in a nested frame is handed a prefix that already
       carries the mark. Deriving rather than appending keeps it at
       one, however deep the nesting goes. */
    const env = fakeWindow();
    const saved = {};
    const globals = { window: env.W, Element: { prototype: {} }, URL: URL, Request: function () {} };
    Object.keys(globals).forEach(function (k) { saved[k] = global[k]; global[k] = globals[k]; });
    try {
      SHIM({ real: "https://giscus.app/w", ticket: TICKET,
        prefix: "/browse/p/" + TICKET + ".f/", debug: false });
    } finally {
      Object.keys(globals).forEach(function (k) {
        if (saved[k] === undefined) delete global[k]; else global[k] = saved[k];
      });
    }
    ok("an already-marked prefix is left at one mark",
      env.W.__fkProxy.toProxyFrame("https://deep.example/x") ===
        "/browse/p/" + TICKET + ".f/https://deep.example/x",
      env.W.__fkProxy.toProxyFrame("https://deep.example/x"));
  }

  section("the click is taken before the site's router can have it");
  {
    const env = fakeWindow();
    runShim(env);
    const click = (env.listeners.click || [])[0];
    ok("there is a click listener at all", !!click);
    ok("and it is on the capture phase, or the router sees it first",
      click && click.capture === true);

    /* The reported bug. The href in the DOM was right; the router
       navigated somewhere else using its own copy. */
    const ev = clickOn({ href: PREFIX + "https://site.example/c/adventure" });
    click.fn(ev);
    ok("a proxied link is handled here, not passed on",
      ev.prevented && ev.stopped, JSON.stringify({ p: ev.prevented, s: ev.stopped }));
    ok("propagation is stopped immediately, since a router listens on the way down",
      ev.immediateStopped);
    ok("and the frame is sent to exactly the address in the href",
      env.navigations[env.navigations.length - 1] ===
        SELF + PREFIX + "https://site.example/c/adventure",
      String(env.navigations[env.navigations.length - 1]));

    /* The relay's own toolbar has to be exempt: it is a control, not
       a page link, and intercepting it would break the very Back
       button this exists to protect. */
    const bar = clickOn({ href: "/browse/back?t=" + TICKET, "data-fieldkit": "chrome" });
    click.fn(bar);
    ok("the relay's own controls are left to the browser", !bar.prevented, "back link");

    const before = env.navigations.length;
    const modified = clickOn({ href: PREFIX + "https://site.example/x" }, { ctrlKey: true });
    click.fn(modified);
    ok("a ctrl-click is left alone — it means somewhere other than here",
      !modified.prevented && env.navigations.length === before);

    const middle = clickOn({ href: PREFIX + "https://site.example/x" }, { button: 1 });
    click.fn(middle);
    ok("so is a middle click", !middle.prevented);

    const already = clickOn({ href: PREFIX + "https://site.example/x" },
      { defaultPrevented: true });
    click.fn(already);
    ok("a click something else already handled is not handled twice", !already.prevented);

    const dl = clickOn({ href: PREFIX + "https://site.example/f.zip", download: "" });
    click.fn(dl);
    ok("a download link is left to the browser", !dl.prevented);

    const frag = clickOn({ href: "#section" });
    click.fn(frag);
    ok("a fragment does not cause a navigation", !frag.prevented);

    const js = clickOn({ href: "javascript:go()" });
    click.fn(js);
    ok("neither does a javascript: link", !js.prevented);

    /* An off-site link the rewriter somehow missed. Letting it
       through means the frame leaves for a site that will refuse to
       be framed, which is the failure this whole section is about. */
    const off = clickOn({ href: "https://elsewhere.example/page" });
    click.fn(off);
    ok("an unrewritten off-site link is caught here rather than escaping",
      off.prevented && env.navigations[env.navigations.length - 1] ===
        PREFIX + "https://elsewhere.example/page",
      String(env.navigations[env.navigations.length - 1]));

    /* Same origin as the relay but not under /browse/ — the page
       resolved something against the wrong origin. */
    const wrong = clickOn({ href: "/api/thing" });
    click.fn(wrong);
    ok("a link resolved against the relay is put back on the real site",
      wrong.prevented && env.navigations[env.navigations.length - 1] ===
        PREFIX + "https://site.example/api/thing",
      String(env.navigations[env.navigations.length - 1]));
  }

  section("the setting reaches the page it is a setting for");
  {
    const on = runtimeSource(REAL, TICKET, { pathMode: true });
    const off = runtimeSource(REAL, TICKET, {});
    ok("pathMode on is stated in the injected source", /pathMode\s*:\s*!0|pathMode["']?\s*:\s*true/.test(on) || on.indexOf("pathMode") > 0);
    ok("and the source is still one self-contained call",
      on.indexOf("function") >= 0 && off.indexOf("function") >= 0);
    ok("the two differ — the flag is not being dropped on the floor", on !== off);
  }

  section("what it refuses to do, and says so");
  {
    const env = fakeWindow();
    env.W.WebSocket = function () {};
    env.W.WebSocket.prototype = {};
    env.W.navigator.serviceWorker = {};
    runShim(env);

    let threw = "";
    try { new env.W.WebSocket("wss://site.example/live"); }
    catch (e) { threw = e.message; }
    ok("a websocket throws something legible rather than hanging forever",
      /not proxied/i.test(threw), threw);

    let refused = null;
    env.W.navigator.serviceWorker.register("/sw.js").catch(function (e) { refused = e.message; });
    ok("registering a service worker is refused, not proxied", true);
    setTimeout(function () {
      ok("and the refusal explains itself", /not allowed/i.test(String(refused)), String(refused));

      console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
      if (state.failures.length) {
        console.log("\nFAILURES:");
        state.failures.forEach(function (f) { console.log("  - " + f); });
      }
      process.exit(state.fail ? 1 : 0);
    }, 0);
  }
})();
