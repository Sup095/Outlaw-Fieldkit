/* ============================================================
   FieldKit relay :: browse
   The fetch-and-re-serve proxy behind the BROWSER module (§14.3).

   `file://` cannot fetch cross-origin and most sites refuse to be
   framed, so an in-app browser is either a toy or a proxy. This is
   the proxy: the relay fetches a page, rewrites its links to come
   back through here, and serves it into a sandboxed iframe.

   Scope boundary, stated once and held to: this is a plain
   fetch-and-re-serve on the user's own domain. Nothing here is
   built for evading detection — no traffic disguising, no domain
   fronting, no obfuscation against inspection. Routing around a
   deliberate network block may breach an acceptable-use policy and
   a managed device logs where it connects. That call is the user's,
   made knowingly.

   ---- THE FOUR THINGS THAT WOULD SINK THIS ---------------------

   1. AN OPEN PROXY. A fetch-and-re-serve with no credential is a
      gift to anyone who finds the URL: they launder traffic through
      a domain with the user's name on it, and the domain ends up
      blocked or worse. Every route here needs either the vault
      token or a signed-in messaging account. OUTPOST has no vault,
      which is exactly why the messaging session counts — and it
      means a banned account cannot browse either.

   2. SSRF. The relay runs in a container that can reach things the
      internet cannot: other containers, the host, and on most
      providers a metadata endpoint that hands out credentials to
      anyone who asks. `?url=http://169.254.169.254/` must not work.
      So every hostname is resolved FIRST, every resolved address is
      checked against the private and reserved ranges, and the
      request is then pinned to the address that passed — not
      re-resolved, which would leave a DNS-rebinding window between
      the check and the connection.

   3. CREDENTIALS IN A URL. An iframe cannot send an Authorization
      header, so the obvious shortcut is `?token=`. The vault token
      reads the vault; it does not go in a URL, a referrer, or a
      proxy log. Instead the client trades it once for a short-lived
      BROWSE TICKET that can do nothing but browse and expires on
      its own.

   4. COOKIES AND SCRIPTS ON OUR OWN ORIGIN. Every proxied site
      arrives on the same origin, so a Set-Cookie from one site
      would be readable by the next. They are stripped. Scripts are
      stripped too — see the note on rewrite() for why that is a
      feature here rather than a limitation.
   ============================================================ */
"use strict";

const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { runtimeSource } = require("./browse-runtime.js");

const LIMITS = {
  maxBytes: 8 * 1024 * 1024,   // a page, not a download
  timeoutMs: 20000,
  maxRedirects: 5,
  ticketMs: 30 * 60 * 1000,    // 30 minutes
  maxTickets: 200,
  urlChars: 2048,
  /* A form body, not an upload. Deliberately small: this is a login
     or a comment, and the relay buffers it whole before sending it
     on, so it is memory on a 512 MB container. */
  maxPostBytes: 1024 * 1024
};

const HISTORY_MAX = 100;   // per ticket, in memory, dies with it

const CONFIG_DEFAULTS = {
  enabled: false,
  /* Let a page's address say what the SITE would say — its own path
     and query — instead of the proxy path it was fetched through.

     This fixes one real thing: a single-page app routes on
     location.pathname, and served under /browse/p/<ticket>/https:/…
     it matches no route and renders an empty shell. That is the
     blank screen on YouTube search. The shim rewrites the address
     with replaceState before the site's own code reads it, and it
     demonstrably works — YouTube search goes from an empty page
     manager to real results.

     OFF ANYWAY, and this is the honest part. Shipped on, it made a
     live relay worse rather than better: pages arriving unformatted
     on first load, and reloads intermittently failing outright. The
     reason is structural rather than a bug that got missed. Moving
     the address to the site's own path puts every url the page then
     builds at the RELAY'S ROOT, where it collides with the relay's
     own routes, with whatever sits in front of the relay, and with
     a 404 handler that answers in JSON. Every one of those requests
     used to carry the site's identity in its own path and now
     depends on a rescue that has to be right every single time.

     The gains are real and the machinery stays, tested, behind this
     flag. But the default is the one that works everywhere, and a
     blank YouTube search is a smaller failure than a browser that
     drops pages at random. Making this sound needs the site's
     identity in the ORIGIN — a subdomain per site — not in a
     parameter smuggled through a query string. */
  pathMode: false,
  /* Two constraints, and together they rule out most of the obvious
     names.

     Scripts are stripped here, so an engine that needs JavaScript
     returns a blank page and looks like the proxy is broken. That
     alone removes google.com and most of the modern ones.

     Then: this relay lives at a datacentre address, and search
     engines treat those as robots. Tested through this proxy,
     DuckDuckGo's lite endpoint and Mojeek both answered with a
     CAPTCHA rather than results — which renders as a broken page,
     not as an error, so it reads as "the browser is broken".

     Nothing here tries to look like something it is not to get past
     that; see the scope note in the header. Bing is the default
     because it answered plain HTML results to a request that
     honestly identified itself as a proxy. If it stops doing that
     from your relay's address, /browse/engines tests the
     alternatives from the relay rather than guessing here. */
  searchUrl: "https://www.bing.com/search?q=",
  /* Whether a proxied page may run its own JavaScript. On, because
     with it off a large part of the web renders as a blank page or
     a spinner, and "the browser is broken" is what that looks like
     from the other side of the screen. See baseHeaders() for what
     turning it on costs and what it does NOT cost. */
  runScripts: true,
  debugRuntime: false,
  /* Empty means "anywhere public". A list turns this into an
     allowlist, which is the right setting for a shared drive. */
  allowHosts: [],
  blockHosts: [],
  /* The filter (§14.3b). Off by default: a relay that silently
     drops requests nobody configured it to drop is worse than one
     that does not filter. See loadFilter() for what it is and,
     more importantly, what it is not. */
  filter: {
    enabled: false,
    lists: [],
    block: [],
    allow: [],
    blockIpLiterals: true
  }
};

/* Tried by /browse/engines, in the order a person would want them:
   general-purpose first, then the indie indexes that are least
   likely to care where a request came from. */
const ENGINE_CANDIDATES = [
  { name: "Bing", url: "https://www.bing.com/search?q=" },
  { name: "Marginalia", url: "https://marginalia-search.com/search?query=" },
  { name: "Mojeek", url: "https://www.mojeek.com/search?q=" },
  { name: "DuckDuckGo Lite", url: "https://lite.duckduckgo.com/lite/?q=" },
  { name: "DuckDuckGo HTML", url: "https://html.duckduckgo.com/html/?q=" },
  { name: "Wiby (old web)", url: "https://wiby.me/?q=" },
  { name: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
  { name: "Ecosia", url: "https://www.ecosia.org/search?q=" },
  /* Added after a relay reported that only three of the above
     answered it at all. Every one of these was fetched through the
     proxy and checked for real off-engine result hosts before being
     put on the list; none of that predicts what a DATACENTRE address
     gets, which is exactly why ENGINES tests from the relay instead
     of trusting this list. Brave was the strongest of them — a wide
     index, server-rendered results, and it answered a second ask
     after refusing the first. */
  { name: "Brave", url: "https://search.brave.com/search?q=" },
  { name: "MetaGer", url: "https://metager.de/meta/meta.ger3?eingabe=" },
  { name: "SearXNG (searx.be)", url: "https://searx.be/search?q=" },
  { name: "SearXNG (tiekoetter)", url: "https://searx.tiekoetter.com/search?q=" },
  { name: "4get", url: "https://4get.ca/web?s=" }
];

/* ---- is this a bot check, or a page that merely says "captcha"? --

   The first version of this searched the page for a word list and
   nothing else, and it took out Wikipedia and GitHub on day one.
   Wikipedia ships `"wgConfirmEditCaptchaNeededForGenericEdit":
   "hcaptcha"` in its config blob; GitHub ships a feature flag named
   `octocaptcha_origin_optimization`. Both were served in full, 500
   KB and 350 KB of real article, and both were replaced with "this
   site thinks your relay is a robot" — a confident, wrong, and
   completely unhelpful error.

   The fix is not a longer word list. It is that a real interstitial
   has a SHAPE: it is small, it has almost no content, and it very
   often comes with a status that already says something is wrong.
   A 500 KB article is not a bot check no matter what words are in
   it. So a signal only counts when the page is small enough to be
   an interstitial, or the status already indicates a refusal.

   Two tiers, because the evidence is not equally strong. `__cf_chl`
   in a page means Cloudflare is challenging, full stop. The word
   "captcha" means someone wrote the word "captcha". */
const CHALLENGE_STRONG = new RegExp([
  "__cf_chl", "cf-challenge", "cf_chl_opt", "anomaly-modal",
  "challenge-error-text", "challenge-platform",
  "<title>\\s*just a moment", "g-recaptcha\\b", "h-captcha\\b",
  "precursor_interstitial", "px-captcha", "arkoselabs"
].join("|"), "i");

const CHALLENGE_WEAK = new RegExp([
  "captcha", "unusual traffic", "are you a robot", "verify you are human",
  "automated queries", "enable javascript and cookies",
  "your request has been blocked", "access denied"
].join("|"), "i");

/* A real interstitial is a few kilobytes. Cloudflare's is about
   five, DuckDuckGo's anomaly page seventeen. Anything past this is
   a page with content, whatever words it contains. */
const CHALLENGE_MAX_BYTES = 30000;

/* Below this many off-engine links, a results page is not a results
   page. See the use site for why it is not zero. */
const EMPTY_RESULTS_BELOW = 3;
const REFUSAL_STATUS = [401, 403, 405, 406, 409, 418, 421, 423, 429, 503];

function looksLikeChallenge(html, status) {
  const text = String(html);
  const head = text.slice(0, 60000);
  const small = text.length <= CHALLENGE_MAX_BYTES;
  const refused = status !== undefined && REFUSAL_STATUS.indexOf(Number(status)) >= 0;

  /* Strong evidence is believed on a small page or a refusal. On a
     large 200 it is still not believed — a documentation page about
     Cloudflare challenges is a real thing, and being wrong here
     costs the whole page. */
  if (CHALLENGE_STRONG.test(head)) return small || refused;

  /* Weak evidence needs BOTH: the shape of an interstitial and a
     status that agrees something went wrong. */
  if (CHALLENGE_WEAK.test(head)) return small && refused;

  return false;
}

let cfg = Object.assign({}, CONFIG_DEFAULTS);
let log = () => {};

function init(opts) {
  /* From DEFAULTS, not from whatever cfg happens to hold. Merging
     into the previous config means a setting that was once on can
     never be turned off by re-initialising — it just accumulates.
     The server calls this once so it would not have shown there, but
     "config is what the file says" is the property worth having. */
  cfg = Object.assign({}, CONFIG_DEFAULTS, opts.config || {});
  cfg.allowHosts = (cfg.allowHosts || []).map((h) => String(h).toLowerCase());
  cfg.blockHosts = (cfg.blockHosts || []).map((h) => String(h).toLowerCase());
  cfg.filter = Object.assign({}, CONFIG_DEFAULTS.filter, cfg.filter || {});
  log = opts.log || log;

  const stats = loadFilter(opts.dataDir);
  if (cfg.filter.enabled) {
    log("INFO", "browse: filter on — " + stats.hosts + " host(s) from " +
      (stats.files.join(", ") || "config only"));
    /* A list named but not present is the failure that matters: the
       relay would run wide open while the config says it is
       filtering. Loud, at boot, where it can be fixed. */
    if (stats.missing && stats.missing.length) {
      log("ERROR", "browse: filter lists MISSING and therefore NOT enforced: " +
        stats.missing.join(", "));
    }
  }
  cfg.filterStats = stats;
  return cfg;
}

/* ---- tickets ---------------------------------------------------
   A ticket is not the token. It cannot read the vault, it cannot
   send a message, and it dies on its own. It exists only because an
   iframe has no way to set a header. */
const tickets = new Map();

function sweepTickets() {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expires <= now) tickets.delete(k);
  /* A cap as well as an expiry: without it, anyone with a valid
     token could mint tickets until the process ran out of memory. */
  while (tickets.size > LIMITS.maxTickets) tickets.delete(tickets.keys().next().value);
}

function issueTicket(who) {
  sweepTickets();
  const id = crypto.randomBytes(24).toString("hex");
  tickets.set(id, { who: who, expires: Date.now() + LIMITS.ticketMs });
  return { ticket: id, expiresIn: Math.round(LIMITS.ticketMs / 1000) };
}

/* WHICH ENGINE THIS SESSION SEARCHES WITH.

   It used to be cfg.searchUrl and nothing else, which meant that
   discovering — via ENGINES — that the configured engine answers
   this relay with a bot check left exactly one remedy: edit
   config.json on the server, upload it, restart. That is a long way
   round for a setting whose whole purpose is to be tried.

   So a ticket may carry its own. It is per-session and deliberately
   not persisted: the relay's own config stays the default and the
   thing that survives a restart, and a session cannot quietly
   redefine what everyone else searches with. */
function searchFor(ticket) {
  const t = tickets.get(String(ticket || ""));
  return (t && t.searchUrl) || cfg.searchUrl;
}

/* Only an engine the relay itself offered. Accepting an arbitrary
   prefix would make this route a way to point a session's search box
   at any URL a page could construct — the proxy already refuses
   private addresses, but there is no reason to add a second door. */
/* Is this URL a search on the engine this session uses? Compared on
   the prefix rather than on the hostname, because an engine's host
   serves plenty of pages that are not searches and flagging its
   front page as "a search with no results" would be nonsense. */
function isSearchPage(href, ticket) {
  const eng = searchFor(ticket);
  if (!eng) return false;
  try {
    const a = new URL(href), b = new URL(eng);
    if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
    return a.pathname === b.pathname;
  } catch (e) { return false; }
}

function isOfferedEngine(u) {
  return ENGINE_CANDIDATES.some((e) => e.url === u) || u === cfg.searchUrl;
}

function ticketHolder(id) {
  const t = tickets.get(String(id || ""));
  if (!t) return null;
  if (t.expires <= Date.now()) { tickets.delete(String(id)); return null; }
  return t.who;
}

/* ---- cookies, kept here rather than in the browser --------------

   Every proxied site lands on ONE origin, so a Set-Cookie passed
   through to the browser would be sent back on a request for a
   different site. That is not a subtle leak: read a webmail and
   then read anything else, and the second site is handed the first
   one's session cookie.

   Stripping them was the old answer and it means no site can ever
   log you in. Keeping them HERE, in a jar keyed by ticket and by
   host, is the answer that works: the browser never sees a cookie,
   so there is nothing for a script on the shared origin to read,
   and the site still gets its session because the relay replays it
   on the way out.

   The jar dies with the ticket, which means logins do not survive
   thirty minutes or a NEW SESSION. That is a limitation and it is
   also the only reason this is safe to have on a shared machine.

   Not implemented, deliberately: Secure/HttpOnly/SameSite are
   ignored, because the transport to the site is always https from
   here and the "browser" holding the jar is this process. Expiry is
   honoured only as session-vs-not; a cookie with a far-future date
   still dies with the ticket. */
const COOKIE_MAX_PER_HOST = 50;

function cookieJar(ticket) {
  const t = tickets.get(String(ticket || ""));
  if (!t) return null;
  return (t.jar = t.jar || Object.create(null));
}

/* Cookies belong to a host and its subdomains, never up to a public
   suffix — "Domain=.com" must not become a cookie every site gets. */
function cookieHostKey(host, domainAttr) {
  host = String(host).toLowerCase();
  if (!domainAttr) return host;
  let d = String(domainAttr).toLowerCase().replace(/^\./, "");
  if (!d || d.indexOf(".") < 0) return host;
  /* Only accept a domain the host is actually under. */
  if (host === d || host.endsWith("." + d)) return d;
  return host;
}

function storeSetCookies(ticket, host, setCookieHeaders) {
  const jar = cookieJar(ticket);
  if (!jar || !setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

  for (const raw of list) {
    const parts = String(raw).split(";");
    const first = parts.shift() || "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;

    let domain = null, path = "/", expired = false;
    for (const attr of parts) {
      const [k, v] = attr.split("=");
      const key = String(k).trim().toLowerCase();
      if (key === "domain") domain = String(v || "").trim();
      else if (key === "path") path = String(v || "/").trim() || "/";
      else if (key === "max-age" && Number(v) <= 0) expired = true;
      else if (key === "expires" && Date.parse(v) && Date.parse(v) < Date.now()) expired = true;
    }

    const key = cookieHostKey(host, domain);
    const bucket = (jar[key] = jar[key] || Object.create(null));
    if (expired) { delete bucket[name]; continue; }
    bucket[name] = { value: value, path: path };

    const names = Object.keys(bucket);
    if (names.length > COOKIE_MAX_PER_HOST) delete bucket[names[0]];
  }
}

function cookieHeaderFor(ticket, host, pathname) {
  const jar = cookieJar(ticket);
  if (!jar) return "";
  const out = [];
  for (const key of walkUp(String(host).toLowerCase())) {
    const bucket = jar[key];
    if (!bucket) continue;
    for (const name of Object.keys(bucket)) {
      const c = bucket[name];
      if (c.path && c.path !== "/" && String(pathname).indexOf(c.path) !== 0) continue;
      out.push(name + "=" + c.value);
    }
  }
  return out.join("; ");
}

/* ---- where the frame went --------------------------------------

   The client cannot see this for itself and never will. Its page is
   file:// (origin null) and the frame is https://relay, so they are
   cross-origin no matter what the sandbox says — `allow-same-origin`
   would not help, it only decides whether the frame keeps its own
   origin instead of an opaque one. So clicking a link inside the
   frame was invisible: the address bar went stale and Back was a
   list of things that had been typed rather than a history.

   The relay knows, because every hop goes through it. It records the
   last page-shaped URL per ticket and /browse/where hands it back.

   Only NAVIGATIONS are recorded. A page is dozens of requests — its
   stylesheet, its fonts, every image — and recording those would
   leave the address bar showing whichever sub-resource happened to
   land last. Sec-Fetch-Dest says which is which and every browser
   that can run this sends it; the content-type is the fallback for
   one that does not, which at worst mistakes a nested frame for the
   page containing it.

   This is memory only and dies with the ticket. It is also a real
   addition to what the relay holds: it already logged the hostname
   of each fetch, and now it keeps one full URL per active session
   for up to thirty minutes. Small, but not nothing, and the sort of
   thing that should be written down rather than discovered. */
function isNavigation(req, contentType) {
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  if (dest) return dest === "document" || dest === "iframe" || dest === "frame";
  return /^text\/html/i.test(String(contentType || ""));
}

/* The other half of the same question, and it has to be asked
   separately rather than as !isNavigation().

   A failure has no content type to fall back on, so isNavigation()
   would answer "no" for a browser that sends no Sec-Fetch-Dest at
   all — and answering "no" means "this is a stylesheet", which turns
   a plain page failure into a blank frame. This asks the narrower
   question: does the request SAY it is a subresource? Only an
   explicit dest counts. No header means treat it as a page, which is
   the safe direction to be wrong in. */
function isSubresource(req) {
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  if (!dest) return false;
  return dest !== "document" && dest !== "iframe" && dest !== "frame";
}

function noteLocation(id, url) {
  const t = tickets.get(String(id || ""));
  if (!t) return;
  t.lastUrl = url;
  t.lastAt = Date.now();

  /* History lives here rather than in the client, because the
     toolbar that uses it is served from here too — see toolbar().
     The client half could not maintain this correctly even in
     principle: it cannot see where the frame went.

     Back and forward work by moving the cursor and redirecting to
     whatever it now points at. That redirect comes back through
     here, sees the url it is already on, and does nothing — which
     is why neither needs a "do not record this one" flag. */
  const hist = (t.hist = t.hist || []);
  if (t.histAt === undefined) t.histAt = -1;
  if (hist[t.histAt] === url) return;
  hist.length = t.histAt + 1;                 // a new page drops what was ahead
  hist.push(url);
  if (hist.length > HISTORY_MAX) hist.shift();
  t.histAt = hist.length - 1;
}

function historyGo(id, delta) {
  const t = tickets.get(String(id || ""));
  if (!t || !t.hist || !t.hist.length) return null;
  const next = t.histAt + delta;
  if (next < 0 || next >= t.hist.length) return null;
  t.histAt = next;
  return t.hist[next];
}

function historyState(id) {
  const t = tickets.get(String(id || ""));
  if (!t || !t.hist) return { canBack: false, canFwd: false, url: null };
  return {
    canBack: t.histAt > 0,
    canFwd: t.histAt < t.hist.length - 1,
    url: t.hist[t.histAt] || null
  };
}

/* ---- where we are allowed to go -------------------------------- */

/* Every range that is not the public internet. The metadata one
   (169.254.169.254) is the reason this list is not optional: on most
   hosting providers it hands out credentials to whatever asks. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0) return true;                       // "this network"
    if (p[0] === 10) return true;                      // RFC1918
    if (p[0] === 127) return true;                     // loopback
    if (p[0] === 169 && p[1] === 254) return true;     // link-local + metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;  // benchmarking
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;     // CGNAT
    if (p[0] >= 224) return true;                      // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();
    if (a === "::" || a === "::1") return true;
    if (a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd")) return true;
    if (a.startsWith("ff")) return true;               // multicast
    /* An IPv4-mapped address is an IPv4 address wearing a hat, and
       ::ffff:127.0.0.1 would otherwise sail straight past. */
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true;  // unparseable is not a thing we connect to
}

function hostAllowed(host) {
  host = String(host).toLowerCase();
  if (cfg.blockHosts.some((h) => host === h || host.endsWith("." + h))) {
    return { ok: false, why: "that host is on this relay's block list" };
  }
  if (cfg.allowHosts.length &&
      !cfg.allowHosts.some((h) => host === h || host.endsWith("." + h))) {
    return { ok: false, why: "this relay is set to an allow list and that host is not on it" };
  }
  /* The filter is checked last so an explicit allowHosts entry is
     not silently overruled by a downloaded list of a hundred
     thousand domains — if you named a host, you meant it. */
  const f = filterVerdict(host);
  if (!f.ok) return f;
  return { ok: true };
}

/* ---- the filter -------------------------------------------------

   Called a DNS filter because that is what it does the job of, but
   it is not DNS. It is a hostname check on the one machine every
   request has to pass through, which is a stronger position than a
   DNS filter has: changing a device's resolver does nothing here,
   and neither does hard-coding 8.8.8.8, because the drive never
   resolves anything. The relay does.

   That is also the honest limit. This blocks by NAME. It does not
   block a numeric address typed in directly (which is why
   blockIpLiterals exists), and it cannot block a site that is not
   on the list — including another proxy. A blocklist is a speed
   bump against carelessness and a wall against nothing determined.
   Said plainly here so nobody deploys it believing otherwise.

   Lists are files, loaded once at boot. Fetching them at runtime
   would mean the relay reaching out to a third party on a schedule
   and failing open when that party is down; `tools/fetch-blocklist.js`
   downloads on the SSD and the file gets uploaded like any other. */
let filterSet = new Set();          // exact hostnames, from the lists
let filterAllow = new Set();        // exceptions that beat the lists
let filterStats = { lists: 0, hosts: 0, files: [] };

/* Hosts files, plain domain lists and AdBlock-style rules all turn
   up in the wild and people paste whichever they found. Taking all
   three costs a few lines and saves an afternoon of "why is my list
   not working". */
function parseBlocklist(text) {
  const out = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === "#" || line[0] === "!" || line[0] === ";") continue;

    /* AdBlock: ||example.com^ */
    let m = /^\|\|([a-z0-9._-]+)\^?/i.exec(line);
    if (m) { out.push(m[1].toLowerCase()); continue; }
    if (line[0] === "|" || line.indexOf("##") >= 0 || line[0] === "/") continue;  // cosmetic rules

    /* Hosts file: 0.0.0.0 example.com  /  127.0.0.1 example.com */
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && /^(\d{1,3}\.){3}\d{1,3}$|^::1?$|^0\.0\.0\.0$/.test(parts[0])) {
      for (const h of parts.slice(1)) {
        if (h[0] === "#") break;
        if (/^[a-z0-9._-]+$/i.test(h) && h !== "localhost") out.push(h.toLowerCase());
      }
      continue;
    }

    /* Plain domain per line. */
    const bare = parts[0].replace(/^\*\./, "");
    if (/^[a-z0-9._-]+\.[a-z]{2,}$/i.test(bare)) out.push(bare.toLowerCase());
  }
  return out;
}

function loadFilter(dataDir) {
  filterSet = new Set();
  filterAllow = new Set();
  filterStats = { lists: 0, hosts: 0, files: [], missing: [] };

  const f = cfg.filter || {};
  (f.block || []).forEach((h) => filterSet.add(String(h).toLowerCase()));
  (f.allow || []).forEach((h) => filterAllow.add(String(h).toLowerCase()));

  if (dataDir) {
    for (const name of (f.lists || [])) {
      /* The name comes from config, not from a request, but it
         still gets an allow-shaped check rather than a scrub: a
         config typo that reads /etc/passwd should say so. */
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.indexOf("..") >= 0) {
        filterStats.missing.push(name + " (not a plain filename)");
        continue;
      }
      const p = path.join(dataDir, "blocklists", name);
      let text;
      try { text = fs.readFileSync(p, "utf8"); }
      catch (e) { filterStats.missing.push(name + " (" + e.code + ")"); continue; }
      const hosts = parseBlocklist(text);
      hosts.forEach((h) => filterSet.add(h));
      filterStats.lists++;
      filterStats.files.push(name + " (" + hosts.length + ")");
    }
  }
  filterStats.hosts = filterSet.size;
  return filterStats;
}

function filterVerdict(host) {
  const f = cfg.filter || {};
  if (!f.enabled) return { ok: true };
  host = String(host).toLowerCase();

  /* An exception beats the lists, and is checked on parents too, so
     allowing "example.com" allows its subdomains. */
  for (const h of walkUp(host)) if (filterAllow.has(h)) return { ok: true };

  /* A numeric address has no name to filter, so it is the obvious
     way around a name filter. Refused outright while the filter is
     on, rather than pretending the list covered it. */
  if (net.isIP(host)) {
    if (f.blockIpLiterals === false) return { ok: true };
    return { ok: false, filtered: true, why:
      "this relay's filter is on, and a numeric address has no name to check" };
  }

  for (const h of walkUp(host)) {
    if (filterSet.has(h)) {
      return { ok: false, filtered: true, matched: h,
        why: "blocked by this relay's filter (" + h + ")" };
    }
  }
  return { ok: true };
}

/* a.b.example.com -> [a.b.example.com, b.example.com, example.com]
   so a list entry blocks the subdomains under it too. */
function walkUp(host) {
  const out = [];
  const parts = String(host).split(".");
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

/* Resolve, check every answer, and hand back the addresses that
   passed so the request can be PINNED to them. Re-resolving at
   connect time would leave a window where a hostile DNS server
   answers once with a public address to pass this check and again
   with 127.0.0.1 to be connected to. */
async function safeAddresses(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      return { ok: false, why: "that address is on a private or reserved range" };
    }
    return { ok: true, addresses: [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }] };
  }

  /* TWO RESOLVERS, AND THE SECOND ONE IS NOT BELT AND BRACES.

     lookup() is the operating system's resolver — it reads
     /etc/hosts, it honours whatever the container was handed, and it
     is the right thing to ask first because it is what every other
     program on the box would get.

     It is also the thing that breaks. Measured here: itch.io answers
     A and AAAA queries perfectly well and lookup() returns ENOENT for
     it, so the proxy called a live host non-existent in five
     milliseconds and put "that hostname does not resolve" on screen.
     A hosted container with a half-configured resolv.conf is exactly
     the environment this relay lives in, and it is exactly where
     lookup() gives up while a direct query does not.

     So a failure falls through to resolve4/resolve6, which ask DNS
     itself. Every address either of them returns still goes through
     the private-range check below — the SSRF guard is on the
     ADDRESSES, not on which function produced them, so widening the
     lookup does not widen what may be reached. */
  let answers = null;
  let firstError = null;
  try {
    answers = await dns.promises.lookup(hostname, { all: true });
  } catch (e) { firstError = e; }

  if (!answers || !answers.length) {
    const both = await Promise.all([
      dns.promises.resolve4(hostname).then(
        (a) => a.map((address) => ({ address: address, family: 4 })), () => []),
      dns.promises.resolve6(hostname).then(
        (a) => a.map((address) => ({ address: address, family: 6 })), () => [])
    ]);
    answers = both[0].concat(both[1]);
  }

  if (!answers.length) {
    return { ok: false, why: firstError
      ? "that hostname does not resolve (" + (firstError.code || firstError.message) + ")"
      : "that hostname resolved to nothing" };
  }

  const bad = answers.filter((a) => isPrivateAddress(a.address));
  if (bad.length) {
    /* Refused if ANY answer is private, not just if all of them are.
       A host that resolves to one public and one loopback address is
       either misconfigured or trying something. */
    return { ok: false, why: "that hostname resolves to a private or reserved address" };
  }
  return { ok: true, addresses: answers };
}

function parseTarget(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, why: "no url given" };
  if (s.length > LIMITS.urlChars) return { ok: false, why: "that url is too long" };

  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s); }
  catch (e) { return { ok: false, why: "that is not a url" }; }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, why: "only http and https are proxied, not " + u.protocol.replace(":", "") };
  }
  /* Credentials in the URL would be forwarded upstream and would sit
     in this process's memory and logs. Refuse rather than strip, so
     nobody thinks they were sent. */
  if (u.username || u.password) {
    return { ok: false, why: "urls with a username or password in them are refused" };
  }
  const host = hostAllowed(u.hostname);
  /* filtered is carried out rather than flattened to a why-string,
     because a block gets a different page from a failure and the
     caller has to be able to tell them apart. */
  if (!host.ok) return { ok: false, why: host.why, filtered: !!host.filtered, host: u.hostname };

  return { ok: true, url: u };
}

/* ---- fetching ---------------------------------------------------

   `send` is { method, body, contentType } or nothing at all. Nothing
   means GET, which is every request this made for its first several
   revisions. */
function fetchOnce(u, addresses, cookie, send) {
  send = send || {};
  const method = String(send.method || "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD" ? null : (send.body || Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: method,
      /* The pin. Node calls this instead of resolving, so the socket
         goes to an address that already passed isPrivateAddress. */
      lookup: (hostname, opts, cb) => {
        const a = addresses[0];
        if (opts && opts.all) return cb(null, addresses);
        return cb(null, a.address, a.family);
      },
      headers: Object.assign({
        /* Deliberately plain. Nothing here is trying to look like
           something it is not — see the scope note in the header. */
        "User-Agent": "FieldKit-Relay/1 (+fetch-and-re-serve proxy)",
        "Accept": "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "en"
      }, cookie ? { Cookie: cookie } : {},
         /* RANGE, AND WHY VIDEO DID NOT WORK WITHOUT IT.

            A browser does not download a video. It asks for the first
            few hundred kilobytes, plays them, and asks for the next
            slice — and when you drag the scrubber it asks for the
            slice under your finger. All of that is the Range header,
            and this proxy used to drop it: every request came back
            200 with the whole file, so seeking was impossible and
            each attempt re-fetched everything through the relay.

            Worse, "everything" was capped. maxBytes is eight
            megabytes because this fetches pages, not downloads, so a
            video longer than about thirty seconds was silently cut
            off mid-file. That is the "it just stops" that has no
            error next to it.

            Passing the header through fixes both at once and makes
            the relay do LESS work, not more: a slice is a slice, it
            is nowhere near the cap, and the player asks for the next
            one when it wants it. */
         send.range ? { Range: send.range } : {},
         send.ifRange ? { "If-Range": send.ifRange } : {},
         body ? {
           "Content-Type": send.contentType || "application/x-www-form-urlencoded",
           "Content-Length": body.length
         } : {}),
      timeout: LIMITS.timeoutMs
    }, (res) => {
      const chunks = [];
      let total = 0;
      let cut = false;
      res.on("data", (c) => {
        total += c.length;
        if (total > LIMITS.maxBytes) {
          cut = true;
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: cut
      }));
      res.on("close", () => {
        if (cut) resolve({
          status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: true
        });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => { req.destroy(new Error("timed out after " + LIMITS.timeoutMs + " ms")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* AN OPEN-ENDED RANGE IS A REQUEST FOR THE WHOLE REST OF THE FILE.

   The first thing a media element sends is "Range: bytes=0-", which
   means "from the start to the end". Passed through as written, the
   origin obliges: for a 2.9 GB video it starts sending 2.9 GB, the
   relay stops reading at maxBytes, and what goes out is eight
   megabytes of body under a Content-Range header promising nearly
   three gigabytes. The player reads the header, waits for bytes that
   never come, and fails with a network error a second into playback.
   Measured exactly that way: metadata fine, duration fine, playing,
   then MEDIA_ERR_NETWORK at 1.2 seconds.

   So the relay bounds the range BEFORE asking. The origin then
   answers a slice it can actually deliver whole, the Content-Range
   describes those bytes truthfully, and the player asks for the next
   slice when it wants it — which is what it was going to do anyway.

   The chunk is half of maxBytes, which is two decisions in one
   number: a slice can never be the thing that gets truncated, and
   a ten-minute video is a few dozen requests rather than a few
   hundred. The second half matters more than it looks — measured
   against Wikimedia, four range requests inside a second earned a
   429, and the fewer slices a file takes the less it looks like a
   flood to whoever is serving it.

   Left alone: a multi-range request (rare, and rewriting one means
   reassembling multipart/byteranges) and a suffix range like
   bytes=-500, which is small by definition. */
const RANGE_CHUNK = 4 * 1024 * 1024;

function boundRange(header) {
  const raw = String(header || "").trim();
  if (!raw) return "";
  if (raw.indexOf(",") >= 0) return raw;          // multi-range: not ours to rewrite
  const m = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!m) return raw;
  if (m[1] === "") return raw;                    // suffix range

  const start = Number(m[1]);
  if (!Number.isFinite(start)) return raw;
  const asked = m[2] === "" ? Infinity : Number(m[2]);
  const cap = start + RANGE_CHUNK - 1;
  const end = Math.min(asked, cap);
  return "bytes=" + start + "-" + end;
}

/* The request body, as bytes. The relay's own readBody parses JSON,
   which is exactly wrong here: a form body is urlencoded or multipart
   and a multipart boundary only survives if nothing touches it.

   Returns null rather than throwing if the body is over the cap, so
   the caller can say so on a page instead of dropping the connection. */
function readRaw(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      total += c.length;
      if (total > cap) { req.destroy(); return finish(null); }
      chunks.push(c);
    });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", () => finish(null));
  });
}

function decompress(res) {
  const enc = String(res.headers["content-encoding"] || "").toLowerCase();
  try {
    if (enc === "gzip") return zlib.gunzipSync(res.body);
    if (enc === "deflate") return zlib.inflateSync(res.body);
    if (enc === "br") return zlib.brotliDecompressSync(res.body);
  } catch (e) {
    /* A truncated body cannot be inflated. Say so rather than
       serving the compressed bytes as if they were text. */
    if (res.truncated) return Buffer.from("");
    throw new Error("the page arrived compressed in a way we could not read (" + enc + ")");
  }
  return res.body;
}

/* Follows redirects by hand rather than letting the HTTP client do
   it, because every hop is a new hostname that has to pass
   safeAddresses again. A redirect to 127.0.0.1 is the classic way
   around an SSRF check that only looks at the first URL. */
async function fetchFollowing(startUrl, ticket, send) {
  let u = startUrl;
  let carry = send || {};
  const chain = [];
  for (let i = 0; i <= LIMITS.maxRedirects; i++) {
    const target = parseTarget(u.href);
    /* Re-checked on EVERY hop, which is what makes a redirect
       through a blocked host fail instead of being a way around the
       filter. Same reason the address checks run per hop. */
    if (!target.ok) {
      return { ok: false, status: target.filtered ? 403 : 400, why: target.why,
        filtered: !!target.filtered, host: target.host, chain: chain };
    }
    const safe = await safeAddresses(target.url.hostname);
    if (!safe.ok) return { ok: false, status: 403, why: safe.why, chain: chain };

    let res;
    const cookie = ticket
      ? cookieHeaderFor(ticket, target.url.hostname, target.url.pathname) : "";
    try { res = await fetchOnce(target.url, safe.addresses, cookie, carry); }
    catch (e) { return { ok: false, status: 502, why: e.message, chain: chain }; }

    /* Kept before the redirect is followed, because a login is very
       often "POST, get a session cookie, 302 to the real page" and
       dropping the cookie at the hop loses the session. */
    if (ticket && res.headers["set-cookie"]) {
      storeSetCookies(ticket, target.url.hostname, res.headers["set-cookie"]);
    }

    chain.push(target.url.href);

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      let next;
      try { next = new URL(res.headers.location, target.url); }
      catch (e) { return { ok: false, status: 502, why: "a redirect went somewhere unparseable", chain: chain }; }

      /* Post/Redirect/Get, which is what nearly every login is. On a
         301, 302 or 303 the method becomes GET and the body is
         dropped — that is what browsers do and what the sites expect.
         307 and 308 exist precisely to say "repeat it as it was", so
         those keep the method and the body. Getting this wrong means
         re-POSTing a login form at the page it redirected you to. */
      if (carry.method && carry.method !== "GET") {
        if (res.status === 307 || res.status === 308) { /* carry unchanged */ }
        else carry = {};
      }

      u = next;
      continue;
    }
    return { ok: true, res: res, url: target.url, chain: chain };
  }
  return { ok: false, status: 508, why: "too many redirects", chain: chain };
}

/* ---- the proxy URL shape ---------------------------------------

   /browse/p/<ticket>/<absolute url>

   The target lives in the PATH, not in ?url=, and that one change is
   what turns this from a reader into a browser.

   With ?url=, a search form on the proxied page submits by appending
   its own query — producing ?url=…&q=cats, where the q lands beside
   the target instead of inside it. There is no way to fix that from
   the server; the browser builds the URL. So forms could not work,
   and a browser where you cannot type into a search box is a
   document viewer.

   In the path, the same submission produces
   /browse/p/TICKET/https://duckduckgo.com/lite?q=cats, which is
   exactly right. Relative links resolve naturally for the same
   reason: the browser treats the whole thing as a path, so `about`
   next to `…/https://site.example/docs/intro` becomes
   `…/https://site.example/docs/about` with no rewriting needed at
   all — though it is still rewritten, because absolute links and
   protocol-relative ones are not so lucky.

   The ticket sits BEFORE the target so it cannot be confused with
   the site's own query string, and so it is not a query parameter
   that a redirect could drop.

   One wrinkle, and it is unavoidable: browsers normalise `//` in a
   path down to `/`, so `https://site` arrives as `https:/site`. It
   is put back on the way in rather than being fought. */
const PROXY_PREFIX = "/browse/p/";

function uiUrl(ticket) {
  return "/browse/ui?t=" + encodeURIComponent(ticket || "-");
}

/* Address or search? This used to live only in the client, which
   meant the client had to build a different URL for each and the
   two answers could drift. Now the toolbar is served from here, so
   the question is answered in exactly one place.

   It errs toward searching: a typo that happens to parse as a
   hostname is far commoner than someone typing a bare domain they
   did not mean. "localhost" and bare IPs deliberately count as
   addresses even though the fetch will refuse them — being told the
   proxy will not fetch a private address is a better answer than
   silently web-searching for "192.168.1.1". */
function looksLikeAddress(s) {
  s = String(s || "").trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^localhost(:\d+)?([/?#]|$)/i.test(s)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(s)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(s);
}

/* THE ".f" ON THE TICKET, AND WHY BACK NEEDED IT.

   Back looked broken on the Godot docs: pressing it did nothing,
   while forward was somehow also available. The relay log said why —
   a request to `giscus.app`, which is the comments widget embedded in
   the page. A nested iframe.

   The relay decides what to write into history with
   `Sec-Fetch-Dest`, and a nested frame sends `iframe`, and so does
   the FieldKit frame itself, because it IS an iframe. The two are
   indistinguishable in the request: same dest, same mode, same
   ticket, and `Referrer-Policy: no-referrer` means neither carries a
   Referer either. So the comments widget was written into history as
   a page, Back moved onto the real page underneath it, and the screen
   did not change.

   The request cannot tell them apart, but the REWRITER can: it is
   looking at the markup and knows perfectly well which URL it found
   inside an `<iframe>`. So it marks those, and the mark rides in the
   one part of the path that is ours to shape — a `.f` after the
   ticket, which cannot collide with anything because a ticket is hex.

   It is inherited, which is the part that makes it work rather than
   half-work: everything a marked frame goes on to load resolves
   against its own marked path, so a whole nested document tree —
   its links, its own sub-frames, its redirects — stays marked
   without a single further decision. */
function proxied(abs, ticket, frame) {
  return PROXY_PREFIX + encodeURIComponent(ticket || "-") +
    (frame ? FRAME_MARK : "") + "/" + abs;
}
const FRAME_MARK = ".f";

/* Recovers the target from a path. Deliberately does not use
   decodeURIComponent on the URL half: it is already a URL, and
   decoding it again would turn a legitimate %2F inside a query
   value into a slash. */
function targetFromPath(pathname, search) {
  if (pathname.indexOf(PROXY_PREFIX) !== 0) return { ok: false, why: "not a proxy path" };
  const rest = pathname.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { ok: false, why: "no url in that path" };

  let ticket = decodeURIComponent(rest.slice(0, slash));
  let raw = rest.slice(slash + 1);

  /* See proxied(): a trailing .f means the rewriter found this URL
     inside an <iframe>, so whatever it is, it is not the page. */
  let frame = false;
  if (ticket.slice(-FRAME_MARK.length) === FRAME_MARK) {
    frame = true;
    ticket = ticket.slice(0, -FRAME_MARK.length);
  }

  /* `https://x` survives the round trip as `https:/x`. Restore it
     rather than treating it as a different scheme. */
  raw = raw.replace(/^(https?:)\/+/i, "$1//");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw.replace(/^\/+/, "");

  return { ok: true, ticket: ticket, frame: frame, url: raw + (search || "") };
}

function absolute(ref, base) {
  try {
    const u = new URL(ref, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch (e) { return null; }
}

/* Scripts are removed, and that is a decision rather than an
   omission.

   The iframe is sandboxed without allow-same-origin, so a script
   would run in an opaque origin and could not touch the relay's
   storage or the page around it. What it could not do either is
   WORK: its XHR and fetch calls go straight to the real site,
   cross-origin, from an opaque origin, and are refused. So keeping
   scripts would buy a page that half-runs and fails in ways that
   look like FieldKit's fault. Removing them buys a page that is
   plainly a reader view, which is what this is. Said out loud in
   the UI rather than left to be discovered. */
/* "bare" means this HTML is not a document — a fragment a page
   asked for with fetch(), or a host's HTML 404 page answering what
   was tagged as a script. Its URLs still need rewriting, because
   whatever the page does with the fragment will resolve them. What
   it must NOT get is our chrome.

   Without this, a site that loads a piece of itself over XHR —
   search suggestions, a modal, the next page of an infinite scroll
   — gets a FieldKit toolbar and a copy of the shim spliced into
   the middle of its own markup, and then inserts that into its
   page. The symptom is an address bar appearing halfway down an
   article, or a dropdown that renders a Back button, and there is
   no way to guess the cause from looking at it.

   Distinct from the frame mark: a nested frame is still a document
   and still needs the shim, it just does not get a toolbar. This
   gets neither. */
function rewrite(html, baseHref, ticket, frame, notice, bare, pathMode) {
  let out = String(html);
  const scripts = !!cfg.runScripts;

  if (!scripts) {
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
             .replace(/<script\b[^>]*\/?>/gi, "")
             .replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi, "$1");

    /* Inline event handlers are scripts wearing a different hat. */
    out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
             .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  } else {
    /* An import map names bare specifiers and resolves them against
       the DOCUMENT's origin, which is the relay. Left alone it
       sends every module import to a relay path that does not
       exist. Rewriting one correctly means understanding the map;
       dropping it makes the failure legible instead of silent. */
    out = out.replace(
      /<script\b[^>]*type\s*=\s*["']?importmap["']?[^>]*>[\s\S]*?<\/script\s*>/gi, "");

    /* Integrity hashes are computed over the bytes the site served.
       Anything this proxy touches on the way through no longer
       matches, and the browser refuses the file rather than loading
       a modified one — correct of it, and fatal here. */
    out = out.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

    /* crossorigin is deliberately LEFT ALONE, and that took a real
       browser to work out. It was being stripped alongside integrity
       on the reasoning that everything is same-origin now so CORS is
       pointless — true, and harmless, because a same-origin request
       in CORS mode always passes.

       What it broke was font preloading. A font is fetched in CORS
       mode no matter what, so `<link rel=preload as=font>` must carry
       crossorigin or the preload's credentials mode does not match
       the real request, the preload is discarded, and the font is
       fetched twice. Chrome says so out loud:

         A preload for '…woff2' is found, but is not used because the
         request credentials mode does not match.

       Stripping an attribute because it looked unnecessary cost two
       extra font downloads on every page. It stays. */
  }

  /* <base> would send every relative URL to the real site, which
     defeats the rewriting below. */
  out = out.replace(/<base\b[^>]*>/gi, "");


  /* Meta refresh is a redirect in disguise. */
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");

  /* A page's own CSP is served in a meta tag as often as a header,
     and it is written for the real origin. Left in place it forbids
     the shim, forbids the site's own scripts now that they come
     from the relay, and reports nothing useful. Ours replaces it —
     the same reasoning as replacing the header rather than merging
     with it. */
  out = out.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");

  /* `action` is back in this list, and it works now — see the note
     on PROXY_PREFIX. A GET form appends its query after the target
     rather than beside it, which is the whole reason the URL moved
     into the path. POST is still refused by the route, so a login
     form fails cleanly rather than sending a password through here. */
  const attr = /\b(href|src|action|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  out = out.replace(attr, (whole, name, _q, dq, sq) => {
    const ref = dq !== undefined ? dq : sq;
    if (!ref || /^(#|javascript:|data:|mailto:|tel:|about:)/i.test(ref)) return whole;
    const abs = absolute(ref, baseHref);
    if (!abs) return whole;
    return " " + name + '="' + proxied(abs, ticket, frame).replace(/"/g, "&quot;") + '"';
  });

  /* Mark what lives inside a frame. Done as a second pass over whole
     tags rather than inside the attribute rewrite above, because that
     rewrite matches attributes and has no idea which element it is
     standing in — and the element is the entire signal here. Running
     after it means the URLs are already proxied and this only has to
     add the mark. See proxied() for what the mark is for. */
  const mine = PROXY_PREFIX + encodeURIComponent(ticket || "-");
  out = out.replace(/<(iframe|frame)\b[^>]*>/gi, (tag) =>
    tag.split(mine + "/").join(mine + FRAME_MARK + "/"));

  /* target="_blank" is retargeted to _self. The frame does have
     allow-popups now, so this is no longer about a dead click — it is
     about where the click LANDS. A popup from here opens a window in
     the host browser, outside the console, which is the one place a
     FieldKit browser should not be putting things. Keeping it in the
     frame keeps Back working too. Applied to <a> and <form> alike,
     and after the href rewrite so a target on the same tag is not
     re-matched. */
  out = out.replace(/<(a|form)\b([^>]*)>/gi, (whole, tag, attrs) => {
    if (!/\btarget\s*=/i.test(attrs)) return whole;
    return "<" + tag + attrs.replace(/\btarget\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      'target="_self"') + ">";
  });

  /* POST forms used to be dismantled here and labelled "nothing typed
     below will be sent", because the route refused POST and a button
     that produces a 405 is worse than a button that explains itself.
     The route takes POST now, so the honest thing is to let the form
     work.

     The warning it carried is not thrown away, it moves: the toolbar
     above every page says not to type a password into what is below
     it, and that line means more now than it did when nothing could
     be sent anyway.

     The form's own enctype is left alone. A multipart upload goes
     through byte for byte, so changing it here would break the
     boundary.

     This applies in reader mode too. Reader mode means the page's
     scripts do not run; it never meant its forms are ornamental, and
     leaving the defang in would have made "scripts off" quietly also
     mean "cannot log in", which is not what the setting says. */

  out = out.replace(/\bsrcset\s*=\s*"([^"]*)"/gi, (whole, list) => {
    const done = list.split(",").map((part) => {
      const bits = part.trim().split(/\s+/);
      const abs = absolute(bits[0], baseHref);
      if (!abs) return part.trim();
      bits[0] = proxied(abs, ticket, frame);
      return bits.join(" ");
    }).join(", ");
    return ' srcset="' + done.replace(/"/g, "&quot;") + '"';
  });

  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, q, ref) => {
    if (/^(data:|about:)/i.test(ref)) return whole;
    const abs = absolute(ref, baseHref);
    return abs ? "url(" + q + proxied(abs, ticket, frame) + q + ")" : whole;
  });

  /* The toolbar goes in last, AFTER every rewrite above, so its own
     links are left exactly as written rather than being proxied
     into nonsense. It is also the banner: someone reading a proxied
     page has to be able to tell that is what they are looking at,
     or a login form on a proxied page looks like the real one.

     A NESTED frame gets no toolbar. It is not the page — it is a
     comments widget or a video player inside one — and giving it an
     address bar and a Back button would put a second set of controls
     in the middle of somebody's article, steering something they did
     not think of as a page. */
  if (!frame && !bare) {
    const bar = toolbar(ticket, baseHref, notice);
    if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, "<body$1>" + bar);
    else out = bar + out;
  }

  /* THE <base> THAT WAS BEING RELIED ON WITHOUT BEING WRITTEN DOWN.

     <base> is stripped further up, and that was only safe because
     the document's own URL was the proxy path — so anything relative
     the rewriter never saw (a url built by script, an image appended
     at runtime, a font named inside a stylesheet) still resolved
     through the proxy by accident of where the page was served from.
     A safety net nobody had to think about.

     pathMode moves the address to the site's own path and pulls that
     net out from under the page: document.baseURI becomes the
     relay's root and every unrewritten relative url lands there.
     Measured on a proxied YouTube — baseURI read
     "http://relay/results?search_query=…", proxy path gone.

     So say explicitly what the document URL used to say implicitly.

     DOWN HERE rather than up with the strip, and that placement is
     the whole correctness of it: injected before the rewriting pass,
     our own href gets rewritten too and comes out as
     /browse/p/T/https://site/browse/p/T/https://site/ — measured,
     not imagined. Everything above is finished with the markup by
     this point. */
  if (pathMode && !frame) {
    /* The page's own proxy url, whole — not its directory. A
       directory resolves relative and root-relative urls correctly
       and gets FRAGMENTS wrong: `#section` against a directory is a
       link to the directory, so every in-page anchor a script builds
       becomes a navigation. The full url is what the document URL
       itself used to be, so all three resolve exactly as they did
       before the address moved. */
    const here = proxied(baseHref, ticket, frame);
    const tag = '<base href="' + escapeHtml(here) + '">';
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, "<head$1>" + tag);
    else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html([^>]*)>/i, "<html$1>" + tag);
    else out = tag + out;
  }

  /* The shim goes in FIRST — before the site's own first inline
     script, which on a lot of pages is a loader that starts
     fetching immediately. Injecting it after would mean the first
     handful of requests escape the rewrite and 404 against the
     relay, which looks exactly like a broken proxy. */
  if (scripts && !bare) {
    const shim = '<script data-fieldkit="shim">' +
      runtimeSource(baseHref, ticket,
        { debug: cfg.debugRuntime, frame: frame, pathMode: cfg.pathMode === true }) + "</script>";
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, "<head$1>" + shim);
    else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html([^>]*)>/i, "<html$1>" + shim);
    else out = shim + out;
  }

  return out;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---- the toolbar, served from here -----------------------------

   The controls used to live in the FieldKit panel, outside the
   frame, and that put every one of them on the wrong side of an
   origin boundary. The parent is `file://` and the frame is
   `https://relay`, so the client could not read where the frame had
   gone, could not know whether Back was available, and had to ask
   the relay after every load to keep an address bar honest.

   Serving the toolbar INTO the page removes the boundary rather
   than working around it. The bar and the page are the same origin
   because they are the same document, so the address shown is the
   address loaded, by construction.

   It uses no JavaScript, because scripts are stripped on this
   origin and the sandbox forbids them anyway. A GET form and four
   links is the entire mechanism. That is not a compromise — it is
   the reason it cannot break: there is no state to get out of sync.

   The frame is sandboxed with allow-forms and nothing else, so this
   toolbar can reach the relay and cannot reach FieldKit. */
function toolbar(ticket, currentUrl, notice) {
  const t = encodeURIComponent(ticket || "-");
  const st = historyState(ticket);
  const here = currentUrl || st.url || "";

  /* data-fieldkit="chrome" marks these as the RELAY'S controls
     rather than the page's. The shim takes over every proxied link
     it sees so a site's router cannot steer the frame off to the
     real site; these have to be exempt, or Back and Home would be
     intercepted by a handler that exists to protect them. */
  const link = (href, label, on, title) =>
    '<a data-fieldkit="chrome" href="' + escapeHtml(href) + '" title="' + escapeHtml(title) + '" style="' +
    "all:initial;font:12px ui-monospace,monospace;color:" + (on ? "#7fdca4" : "#3c4a43") +
    ";text-decoration:none;padding:2px 7px;border:1px solid " +
    (on ? "#2b3a33" : "#1c2622") + ';border-radius:2px;cursor:' +
    (on ? "pointer" : "default") + '">' + label + "</a>";

  return '<div style="all:initial;display:block;font:12px ui-monospace,monospace;' +
    'background:#101614;color:#c8d4cd;border-bottom:1px solid #2b3a33;padding:6px 8px">' +

    '<form action="/browse/go" method="GET" style="all:initial;display:flex;gap:5px;' +
    'align-items:center;width:100%;box-sizing:border-box">' +
    '<input type="hidden" name="t" value="' + escapeHtml(ticket || "") + '">' +

    (st.canBack ? link("/browse/back?t=" + t, "&#9665;", true, "back")
                : link("#", "&#9665;", false, "nothing to go back to")) +
    (st.canFwd ? link("/browse/fwd?t=" + t, "&#9655;", true, "forward")
               : link("#", "&#9655;", false, "nothing to go forward to")) +
    (here ? link("/browse/reload?t=" + t, "&#8635;", true, "reload this page")
          : link("#", "&#8635;", false, "nothing loaded")) +

    '<input name="q" value="' + escapeHtml(here) + '" spellcheck="false" ' +
    'placeholder="search, or type an address" style="all:initial;flex:1;min-width:0;' +
    'font:12px ui-monospace,monospace;background:#0a0e0c;color:#c8d4cd;' +
    'border:1px solid #2b3a33;padding:4px 7px">' +

    '<button type="submit" style="all:initial;font:12px ui-monospace,monospace;' +
    'color:#101614;background:#7fdca4;padding:4px 12px;cursor:pointer">GO</button>' +
    link("/browse/ui?t=" + t, "HOME", true, "the start page") +
    "</form>" +

    (notice
      ? '<div style="all:initial;display:block;font:11px ui-monospace,monospace;' +
        'color:#f0c674;background:#241f10;border:1px solid #5c4a1c;padding:6px 8px;' +
        'margin-top:6px;line-height:1.5">' + escapeHtml(notice) + "</div>"
      : "") +

    /* ONE LINE, AND THE REASON IS FLOOR SPACE.

       This paragraph was four sentences and it was on top of every
       page. In the FieldKit panel at its default size that is a
       third of the bar, sitting above a frame that had already been
       cut down by a note underneath it saying much the same thing —
       measured, the actual web page had 339 of 561 pixels and the
       warnings had the rest.

       A warning you have read on every page since the first one is
       not being read any more, so the cost was real and the benefit
       had already expired. What survives is what is still worth
       glancing at: where you are, that it is a copy, and that this
       is not the place to type a password. The rest keeps its exact
       wording in the tooltip, and lives in full in the panel's own
       note and in the manual.

       Kept on one line deliberately — no wrapping, ellipsis on
       overflow — so the bar's height cannot depend on how long the
       address happens to be. */
    '<div title="' + escapeHtml(
      "Every site you open here shares one origin, your relay's, so a site you visit " +
      "can read what another left in storage on it. This hides what you read from the " +
      "local network. It does not hide you from your relay, or from anyone who can " +
      "read it." + (cfg.runScripts ? " Scripts are running." : " Scripts are removed.")) +
    '" style="all:initial;display:block;font:10px ui-monospace,monospace;' +
    'color:#5f6f68;margin-top:5px;white-space:nowrap;overflow:hidden;' +
    'text-overflow:ellipsis">FIELDKIT READER &mdash; ' +
    (here ? "proxied copy of " + escapeHtml(here).slice(0, 160) + " &mdash; " : "") +
    /* Scripts-off stays on the visible line and scripts-on does not,
       which is not an inconsistency: "scripts removed" is the
       sentence that explains a page which arrived looking broken,
       and it is worth the width every time. "Scripts are running"
       explains nothing that is on screen, so it goes in the tooltip
       with the rest. */
    (cfg.runScripts ? "" : "scripts removed &mdash; ") +
    "one origin for every site, and your relay sees it. " +
    "Do not type a password into a page below this bar.</div></div>";
}

/* The start page. Somewhere to land that is not a blank frame, and
   the only page here that is entirely ours. */
function homePage(ticket) {
  const t = encodeURIComponent(ticket || "-");
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<title>FieldKit Reader</title></head>" +
    '<body style="margin:0;background:#0c100e;color:#c8d4cd;' +
    'font:13px ui-monospace,monospace">' + toolbar(ticket, "") +
    '<div style="padding:28px;line-height:1.7">' +
    '<div style="letter-spacing:.2em;color:#7fdca4;margin-bottom:14px">FIELDKIT READER</div>' +
    "<p>Type an address or a search above.</p>" +
    (cfg.runScripts
      ? "<p style=\"color:#8a978f\">Pages are fetched by your relay and served back " +
        "through it, scripts and all, with a shim in front of them that sends what " +
        "they ask for back through the relay too. Most sites work. WebSockets do not, " +
        "so anything that updates by itself will sit still.</p>" +
        "<p style=\"color:#e0b070\">Every site you open here shares ONE origin &mdash; " +
        "your relay's. A site you visit can read what another site left in storage on " +
        "it. That is how a proxy like this works and there is no version of it that is " +
        "not true. Do not sign in to anything here that you would mind another site " +
        "reading.</p>"
      : "<p style=\"color:#8a978f\">Pages are fetched by your relay and served back " +
        "through it with their scripts removed. Anything that needs JavaScript will " +
        "not work, and logins will not either. Ordinary pages, documentation and " +
        "search results do.</p>") +
    '<p style="color:#8a978f">If searches come back as a bot check, the engine has ' +
    "decided your relay is a robot. Nothing here will try to get past that &mdash; use " +
    "ENGINES in the FieldKit toolbar to find one that answers, and set " +
    "<code>browse.searchUrl</code> to it.</p>" +
    '<p style="margin-top:22px"><a href="' + escapeHtml("/browse/ui?t=" + t) +
    '" style="color:#3c4a43">&nbsp;</a></p>' +
    "</div></body></html>";
}

function rewriteCss(css, baseHref, ticket, frame) {
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, q, ref) => {
    if (/^(data:|about:)/i.test(ref)) return whole;
    const abs = absolute(ref, baseHref);
    return abs ? "url(" + q + proxied(abs, ticket, frame) + q + ")" : whole;
  });
}

/* ---- pages whose only job is to bounce ---------------------------

   THE ONE THAT MADE SEARCH RESULTS DO NOTHING.

   Reported as "when searching, links and stuff don't load". Every
   result on a Bing page is a click-tracking link through
   `bing.com/ck/a`, and that URL does not answer with a 302 — it
   answers with a 1.8 KB HTML page whose entire content is a script
   that assigns to `location`. Given a Referer it does the same
   thing; there is no version of the request that gets a redirect.

   In the frame that script runs, assigns, and the frame leaves for
   the real site — which then declines to be framed, and Chrome's
   word for that is "refused to connect". Through curl it is a blank
   page. Same bug, two symptoms, and both were reported.

   `location` cannot be intercepted from inside the page, and that is
   now measured rather than assumed: `Location.prototype` has no
   `assign`, `replace` or `href` at all — they are own properties of
   the instance, `configurable: false, writable: false` — and
   `Object.defineProperty(window, "location", …)` throws TypeError.
   There is nothing there to patch in any engine.

   So the relay follows the bounce itself, before the page is ever
   served. It reads the destination out of the script, resolves it,
   and answers with a real 302 into the proxy. The frame never sees
   the redirector at all.

   WHAT KEEPS THIS FROM EATING REAL PAGES. A redirector has nothing
   to show. Measured on live responses: the Bing one is 1.8 KB with
   65 characters of visible text ("Please click here if the page does
   not redirect automatically"); an ordinary search page is 144 KB
   with 2818, and a game page 183 KB with 5820. The gate is 20 KB and
   400 characters, which sits in the middle of a gap two orders of
   magnitude wide. A page with something to say is never touched.

   Only a plain string literal counts. A destination built by
   concatenation is not something to guess at, and guessing wrong
   would send someone somewhere they did not ask to go. */
const BOUNCE_MAX_BYTES = 20000;
const BOUNCE_MAX_TEXT = 400;

/* Written as literals rather than built from strings. A regex
   assembled out of quoted pieces is where a backslash goes to die —
   this file has lost one to that before, invisibly.

   What is handed to location is captured whole, because it is a
   string literal about half the time and a variable the other half.
   The real Bing page is the second kind:

     var u = "/news/search?q=godot+navmesh&FORM=HDRSC6";
     if (s) window.location.href = u; else window.location.replace(u);

   so a rule that only accepted literals found nothing on the exact
   page it was written for. One hop of lookup fixes that and is where
   it stops — see BOUNCE_VAR. */
const BOUNCE_JS =
  /(?:window|self|top|document)?\s*\.?\s*location\s*(?:\.\s*(?:replace|assign)\s*\(\s*|\.\s*href\s*=\s*|=\s*)(["'][^"'\n]{1,2000}["']|[A-Za-z_$][\w$]{0,40})/i;

const BOUNCE_META =
  /<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i;

function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function redirectorTarget(html, baseHref) {
  const s = String(html);
  if (s.length > BOUNCE_MAX_BYTES) return null;
  if (visibleText(s).length > BOUNCE_MAX_TEXT) return null;

  let ref = null;

  /* A meta refresh first, because it is the older and plainer form of
     the same thing. These are stripped by the rewriter — correctly,
     since one left in would send the frame to the real site — which
     turned a meta-refresh bounce into a blank page for exactly the
     same reason. Following it here is the other half of that fix. */
  const meta = s.match(BOUNCE_META);
  if (meta) {
    const m = String(meta[1]).match(/url\s*=\s*['"]?([^'";]+)/i);
    if (m) ref = m[1].trim();
  }

  if (!ref) {
    const js = s.match(BOUNCE_JS);
    if (js) {
      const handed = js[1];
      if (/^["']/.test(handed)) {
        ref = handed.slice(1, -1);
      } else {
        /* An identifier. Look for the one place it was given a string
           and stop there. ONE hop, deliberately: past that this is
           interpreting JavaScript rather than reading it, and a wrong
           answer here sends somebody to an address they did not ask
           for. If the variable was built by concatenation there is no
           literal to find, the lookup fails, and the page is served
           as-is — the old behaviour, which is a visibly blank page
           rather than a silently wrong destination. */
        const m = s.match(new RegExp(
          "\\b" + handed.replace(/[$]/g, "\\$") +
          "\\s*=\\s*([\"'])([^\"'\\n]{1,2000})\\1"));
        if (m) ref = m[2];
      }
    }
  }
  if (!ref) return null;

  const abs = absolute(ref, baseHref);
  if (!abs) return null;
  /* A page that bounces to itself is a reload loop, not a redirect. */
  if (abs === baseHref) return null;
  return abs;
}

/* ---- javascript --------------------------------------------------

   The shim inside the page catches URLs that scripts build at
   RUNTIME. There is one class it structurally cannot catch: the
   specifiers in `import` and `export … from`, because the browser
   resolves those itself before any of the page's code — or the
   shim's — has a say.

   Relative ones are already fine, and that is worth understanding
   rather than assuming. A module served from

     /browse/p/TICKET/https:/site.com/app.js

   resolves `./chunk.js` against that URL, which lands back inside the
   proxy pointing at the right host. It works by accident of the path
   layout and it works reliably.

   Root-relative ones are broken in exactly the same way everything
   root-relative is broken here: `/chunk.js` resolves against the
   RELAY's root, and the relay does not have it. So those get
   rewritten, and only those.

   WHAT THIS DELIBERATELY DOES NOT DO. It does not parse JavaScript.
   Rewriting arbitrary strings that look like paths would corrupt any
   file that happens to contain one — a regex describing a route, a
   test fixture, a template. The pattern below only matches a
   specifier in the syntactic position of an import, and only when it
   is a plain quoted literal starting with a single slash. Anything
   cleverer needs a real parser, and a real parser on every script of
   every page is a different project.

   A string in a comment can still match, and the cost of that is a
   comment mentioning a path that now mentions a longer path. */
const JS_IMPORT = new RegExp(
  "(\\b(?:import|export)\\s*(?:[\\s\\S]{0,400}?\\bfrom\\s*)?|\\bimport\\s*\\(\\s*)" +
  "(['\"])(/(?!/)[^'\"\\n]*)\\2", "g");

function rewriteJs(js, baseHref, ticket, frame) {
  const text = String(js);
  /* Cheap gate. Most scripts are not modules, and running a
     backtracking regex over a two-megabyte bundle for nothing is the
     kind of thing that turns a page load into a timeout. */
  if (text.indexOf("import") < 0 && text.indexOf("export") < 0) return text;

  return text.replace(JS_IMPORT, (whole, lead, q, spec) => {
    const abs = absolute(spec, baseHref);
    if (!abs) return whole;
    return lead + q + proxied(abs, ticket, frame) + q;
  });
}

/* ---- reading a page as data ------------------------------------

   The proxy's other routes hand back a PAGE — markup, rewritten,
   for a browser to render. These hand back what is IN it: the
   title, the readable text, and the links, as JSON.

   That difference is the whole point. A script on the drive cannot
   fetch anything at all — file:// has no cross-origin fetch, so
   reading a web page is not something FieldKit can do on its own at
   any length of code. Through here it can, and what comes back is
   structure rather than HTML, because a five-line script wants "the
   third link" and not a tag soup to pick through.

   Deliberately NOT a readability clone. There is no attempt to guess
   which part is the article and drop the furniture — that is a
   guessing game that fails silently and differently on every site.
   This strips what is definitely not prose (script, style, svg and
   the like), turns tags into whitespace, and stops. What comes back
   has the navigation in it, and saying so is better than an
   extractor that sometimes eats the article. */
const TEXT_MAX = 200000;      // characters of extracted text
const LINKS_MAX = 300;

const NON_PROSE =
  /<(script|style|noscript|svg|canvas|template|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

function pageTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]{0,300}?)<\/title\s*>/i);
  return m ? unentity(m[1]).replace(/\s+/g, " ").trim() : "";
}

/* Named entities, and the list is longer than the obvious five for
   a measured reason: the first version handled lt/gt/amp/quot/nbsp
   and the numeric forms, and the very first real page came back with
   the title "Using navigation meshes &mdash; Godot Engine". A dash
   is not an edge case. These are the ones that actually turn up in
   prose. Anything else is left as written, which is ugly but
   legible, and never wrong. */
const ENTITIES = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", times: "×", divide: "÷", minus: "−",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±",
  frac12: "½", frac14: "¼", sup2: "²", sup3: "³",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
  dagger: "†", larr: "←", rarr: "→", harr: "↔", darr: "↓", uarr: "↑",
  shy: "", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " "
};

function unentity(t) {
  return String(t).replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,9});/g,
    (whole, name) => {
      if (name[0] === "#") {
        const hex = name[1] === "x" || name[1] === "X";
        const code = parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
        if (code >= 32 && code < 1114112) {
          try { return String.fromCodePoint(code); } catch (e) { return whole; }
        }
        return whole;
      }
      const v = ENTITIES[name] !== undefined ? ENTITIES[name] : ENTITIES[name.toLowerCase()];
      return v === undefined ? whole : v;
    });
}

function readableText(html) {
  let t = String(html).replace(NON_PROSE, " ").replace(/<!--[\s\S]*?-->/g, " ");
  /* Block-level tags become newlines so paragraphs survive as
     paragraphs. Without this a whole page arrives as one line, and
     the obvious next step in any script — piping it through lines —
     gets exactly one. */
  t = t.replace(
    /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)\b[^>]*>/gi, "\n");
  t = t.replace(/<[^>]*>/g, " ");
  t = unentity(t);
  /* Runs of newlines collapse to ONE, not to a blank line. An
     opening and a closing tag each produce a break, so every block
     came out followed by an empty line and half the payload was
     whitespace \u2014 measured at 9,564 blank lines in a 19,405-line
     page. One break per block is also what a script wants, since
     the next step is almost always to split on lines. */
  t = t.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n");
  return t.trim().slice(0, TEXT_MAX);
}

function pageLinks(html, baseHref) {
  const out = [];
  const seen = Object.create(null);
  const re = /<a\b([^>]*)>([\s\S]{0,400}?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < LINKS_MAX) {
    const hm = m[1].match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hm) continue;
    const ref = hm[2] !== undefined ? hm[2] : hm[3] !== undefined ? hm[3] : hm[4];
    if (!ref || /^(#|javascript:|mailto:|tel:|data:)/i.test(ref)) continue;
    const abs = absolute(unentity(ref), baseHref);
    if (!abs || seen[abs]) continue;
    seen[abs] = 1;
    const label = unentity(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ text: label.slice(0, 200), url: abs });
  }
  return out;
}

/* Search results, as data. Written against what an engine's HTML
   actually is rather than against any one engine: a result is a link
   to somewhere ELSE, with words on it, that is not the engine's own
   furniture. Everything else falls out by that one rule, which is
   why it survives a redesign. */
function searchResults(html, baseHref, engineHost) {
  const eng = String(engineHost || "").toLowerCase().replace(/^www\./, "");
  const seen = Object.create(null);
  const out = [];

  for (const l of pageLinks(html, baseHref)) {
    if (!l.text || l.text.length < 3) continue;

    /* UNWRAP FIRST, then decide. Ordering it the other way round is
       what made the first version hand back "Images, Videos, Maps,
       News, Shopping, Flights" as the top six results for every
       query: Bing's own tab bar is click-tracked exactly like a
       result, so a test for "does this link have a destination
       encoded in it" says yes to the tab bar too. Unwrapped, the
       difference is obvious — a tab decodes to /images/search on the
       engine itself, a result decodes to somewhere else entirely. */
    const real = unwrapRedirect(l.url);
    let h;
    try { h = new URL(real).hostname.toLowerCase(); } catch (e) { continue; }
    if (h === eng || h === "www." + eng || h.endsWith("." + eng)) continue;

    if (seen[real]) continue;
    seen[real] = 1;
    out.push({ title: l.text, url: real });
  }
  return out;
}

/* Engines wrap results in a tracking URL with the destination
   encoded inside. Unwrapping it is a courtesy rather than a
   promise: when it cannot be read the wrapper is handed back as it
   was, and following that still works, because the relay follows
   bounces. */
function unwrapRedirect(u) {
  try {
    const url = new URL(u);
    const keys = ["u", "url", "uddg", "target", "q"];
    for (let i = 0; i < keys.length; i++) {
      const v = url.searchParams.get(keys[i]);
      if (!v) continue;
      if (/^https?:\/\//i.test(v)) return v;
      const b = v.replace(/^a1/, "");
      if (/^[A-Za-z0-9_-]{8,}$/.test(b)) {
        try {
          const dec = Buffer.from(b.replace(/-/g, "+").replace(/_/g, "/"), "base64")
            .toString("utf8");
          if (/^https?:\/\//i.test(dec)) return dec;
        } catch (e) { /* not base64 after all; leave it */ }
      }
    }
  } catch (e) { /* unparseable; leave it */ }
  return u;
}

/* ---- routing ---------------------------------------------------- */
const ROUTES_BY_NAME = {
  /* /browse/p takes POST as well as GET, and that is the difference
     between a reader and a browser. A login is a POST. So is a
     comment, a search on half the sites that have one, and every
     write an application makes. Refusing it left a page that rendered
     perfectly and did nothing when you pressed the button.

     What it costs is written down rather than buried: the relay now
     sees request BODIES on their way past, and a login body has a
     password in it. It is not stored and not logged — the log line
     for a fetch is a hostname and a status, unchanged — but "the
     relay could read it" is true in a way it was not before, and
     anyone running a relay for somebody else should know that. */
  /* HEAD alongside GET, because refusing it was costing real
     loads. Ad and analytics loaders probe with HEAD before they
     fetch, and so does anything checking whether a file changed;
     measured on a CrazyGames page, two HEADs came back 405 and the
     loader treated that as "the file is not there". It is answered
     by doing the GET and sending the headers without the body,
     which is what HEAD means. */
  ticket: ["POST"], p: ["GET", "HEAD", "POST"], check: ["GET"], search: ["GET"],
  where: ["GET"], engines: ["GET"],
  /* Reading, as data rather than as a page. `text` hands back a
     page's readable content and its links as JSON; `find` runs a
     search and hands back the results the same way.

     These exist because the drive cannot do them AT ALL. A file://
     page has no cross-origin fetch, so a script on the drive cannot
     read one line of anything on the web. Routed through here it
     can, and it gets structure rather than markup — which is what a
     five-line script actually wants. They are the reason
     CritterScript has a `fetch` and a `find`. */
  text: ["GET"], find: ["GET"],
  /* The server-rendered browser: a start page, one place that
     decides address-vs-search, and history. All reached by the
     toolbar inside the frame, all plain GET, no JavaScript. */
  ui: ["GET"], go: ["GET"], back: ["GET"], fwd: ["GET"], reload: ["GET"],
  /* Which engine THIS SESSION searches with. A setting rather than a
     navigation, and the only route here that writes anything: see
     searchFor(). */
  engine: ["GET"]
};

async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "browse") return false;

  const { send, authorise } = helpers;
  const what = seg[1] || "";
  const method = req.method;

  if (!cfg.enabled) {
    send(res, 503, { error: "the browser is not enabled on this relay",
      detail: "set browse.enabled in config.json and restart" });
    return true;
  }

  /* 404 and 405 before the auth check, matching /msg/* and the
     relay's own self-diagnosing 404: these names are public, so
     demanding a credential to learn them protects nothing and turns
     "you typed the path wrong" into "log in first". */
  if (!ROUTES_BY_NAME[what]) {
    send(res, 404, { error: "no such browse route",
      routes: Object.keys(ROUTES_BY_NAME).map((n) => "/browse/" + n) });
    return true;
  }
  if (ROUTES_BY_NAME[what].indexOf(method) < 0) {
    send(res, 405, { error: method + " is not how you call /browse/" + what,
      allowed: ROUTES_BY_NAME[what] }, { Allow: ROUTES_BY_NAME[what].join(", ") });
    return true;
  }

  /* Trade a real credential for a ticket. This is the only route
     that accepts a header, and the only one the client calls
     directly — everything else is loaded by the iframe. */
  if (what === "ticket") {
    const who = authorise(req);
    if (!who) { send(res, 401, { error: "a vault token or a signed-in messaging account is required" }); return true; }
    const t = issueTicket(who);
    log("INFO", `browse: ticket issued to ${who}`);
    send(res, 201, t);
    return true;
  }

  /* The ticket comes out of the path for /browse/p/, and out of ?t=
     for the other routes, which the client calls directly. */
  const fromPath = what === "p" ? targetFromPath(url.pathname, url.search) : null;
  const ticket = (fromPath && fromPath.ok ? fromPath.ticket : url.searchParams.get("t")) || "";
  const who = ticketHolder(ticket) || (authorise(req) || null);
  if (!who) {
    send(res, 401, { error: "no valid browse ticket",
      detail: "tickets last " + Math.round(LIMITS.ticketMs / 60000) + " minutes; ask for a new one" });
    return true;
  }

  if (what === "check") {
    const target = parseTarget(url.searchParams.get("url"));
    if (!target.ok) { send(res, 400, { error: target.why }); return true; }
    const safe = await safeAddresses(target.url.hostname);
    send(res, safe.ok ? 200 : 403,
      safe.ok ? { ok: true, host: target.url.hostname, url: target.url.href }
              : { ok: false, error: safe.why });
    return true;
  }

  /* Where the frame ended up. Cheap on purpose — the client calls
     it on every iframe load event, which is once per page and also
     once per click on a link inside one. */
  if (what === "where") {
    const t = tickets.get(String(ticket));
    const st = historyState(ticket);
    /* The history comes back too, and it earned its place: Back
       "doing nothing" turned out to be a nested comments widget
       written into it as though it were a page, and there was no way
       to see that from outside the process — the bug had to be
       inferred from a fetch log. It is the holder's own session,
       nobody else can ask for it, and it dies with the ticket. */
    /* st.url, not t.lastUrl. They are different things and the
       difference shows up the moment somebody presses Back: the
       cursor moves, canBack/canFwd move with it, and lastUrl stays
       on whatever finished loading most recently. The panel out in
       FieldKit reads all three from this one answer and drew its
       address from one of them and its buttons from the others, so
       after a Back it named the page you had just left. lastUrl is
       still here, as lastLoaded, because it is the honest answer to
       a different question — what the frame most recently rendered,
       nested frames and all. */
    send(res, 200, {
      url: st.url || (t && t.lastUrl) || null,
      lastLoaded: (t && t.lastUrl) || null,
      at: (t && t.lastAt) || null,
      canBack: st.canBack,
      canFwd: st.canFwd,
      history: (t && t.hist) ? t.hist.slice() : [],
      at_index: (t && t.histAt !== undefined) ? t.histAt : -1
    });
    return true;
  }

  /* A page as data: title, readable text, links. See readableText.
     This is the route that lets a five-line script read the web,
     which the drive cannot do at all on its own. */
  if (what === "text") {
    const target = parseTarget(url.searchParams.get("url"));
    if (!target.ok) {
      send(res, target.filtered ? 403 : 400,
        { error: target.why, host: target.host || undefined });
      return true;
    }
    let got;
    try { got = await fetchFollowing(target.url, ticket); }
    catch (e) { send(res, 502, { error: e.message }); return true; }
    if (!got.ok) {
      send(res, got.status || 502, { error: got.why, host: got.host || undefined });
      return true;
    }

    const ctype = String(got.res.headers["content-type"] || "");
    let raw;
    try { raw = decompress(got.res).toString("utf8"); }
    catch (e) { send(res, 502, { error: e.message }); return true; }

    log("INFO", "browse: " + who + " read " + got.url.hostname +
      " as text (" + got.res.status + ")");

    /* Not HTML? Hand back what came. Running a tag stripper over
       JSON and calling the result prose helps nobody. */
    const isHtml = /^text\/html/i.test(ctype);
    send(res, 200, {
      ok: true,
      url: got.url.href,
      status: got.res.status,
      type: ctype.split(";")[0].trim(),
      title: isHtml ? pageTitle(raw) : "",
      text: isHtml ? readableText(raw) : raw.slice(0, TEXT_MAX),
      links: isHtml ? pageLinks(raw, got.url.href) : [],
      truncated: !!got.res.truncated
    });
    return true;
  }

  /* A search, as data. Same engine setting the address bar uses, so
     a script and a person get the same answers. */
  if (what === "find") {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 200);
    if (!q) { send(res, 400, { error: "nothing to search for" }); return true; }

    const target = parseTarget(cfg.searchUrl + encodeURIComponent(q));
    if (!target.ok) { send(res, 400, { error: target.why }); return true; }

    let got;
    try { got = await fetchFollowing(target.url, ticket); }
    catch (e) { send(res, 502, { error: e.message }); return true; }
    if (!got.ok) { send(res, got.status || 502, { error: got.why }); return true; }

    let raw;
    try { raw = decompress(got.res).toString("utf8"); }
    catch (e) { send(res, 502, { error: e.message }); return true; }

    /* A bot check is a 200 with a CAPTCHA in it. Handing that back
       as "no results" would be a lie, and a script would branch on
       an empty list and never learn why. */
    if (looksLikeChallenge(raw, got.res.status)) {
      log("WARN", "browse: " + got.url.hostname + " served a bot check to " + who + " (find)");
      send(res, 503, {
        error: "the search engine answered with a bot check rather than results",
        detail: "It has decided this relay's address is a robot. Nothing here tries " +
          "to get past that — use ENGINES in the browser to find one that will " +
          "answer, and set browse.searchUrl to it.",
        engine: got.url.hostname
      });
      return true;
    }

    const results = searchResults(raw, got.url.href, got.url.hostname);
    log("INFO", "browse: " + who + " searched " + got.url.hostname +
      " (" + results.length + " results)");
    send(res, 200, { ok: true, query: q, engine: got.url.hostname, results: results });
    return true;
  }

  /* Which engines will talk to this relay's address. Run FROM the
     relay because that is the only place the question means
     anything: the drive's own connection is irrelevant, and I cannot
     know from here what a datacentre IP can reach. See the note on
     ENGINE_CANDIDATES — nothing here tries to get past a bot check,
     it only reports which engines did not put one up. */
  if (what === "engines") {
    const q = String(url.searchParams.get("q") || "godot navmesh").slice(0, 80);

    /* Concurrently, because eight engines at up to twenty seconds
       each is nearly three minutes of a spinner, and the whole point
       of this route is that someone runs it while wondering why
       search is broken. Eight outbound fetches at once is nothing
       for the relay — one ordinary page is more. */
    const results = await Promise.all(ENGINE_CANDIDATES.map(async (eng) => {
      const row = { name: eng.name, url: eng.url, usable: false, why: "error", detail: "" };
      const target = parseTarget(eng.url + encodeURIComponent(q));
      if (!target.ok) { row.why = "bad-url"; row.detail = target.why; return row; }

      let got;
      try { got = await fetchFollowing(target.url); }
      catch (e) { row.detail = e.message; return row; }
      if (!got.ok) { row.detail = got.why; return row; }

      let body = "";
      try { body = decompress(got.res).toString("utf8"); } catch (e) { body = ""; }

      if (looksLikeChallenge(body, got.res.status)) {
        row.why = "challenge";
        row.detail = "answered a bot check instead of results (HTTP " + got.res.status + ")";
        return row;
      }

      /* "It answered" is not "it answered usefully". A JavaScript
         shell is a page of markup with nothing in it, and rendered
         here — scripts stripped — it is blank, which from the other
         side of the screen is indistinguishable from a broken proxy
         unless it is caught at this end.

         Counting ANY href rather than only absolute ones: the first
         version of this required `href="http`, and engines link
         their own results relatively. It scored Bing at zero and
         called a page of real results "probably needs JavaScript".
         Measured on live responses, a working engine has 15-50 links
         and a JavaScript shell has one. */
      const links = (body.match(/<a\b[^>]*\bhref\s*=/gi) || []).length;
      if (body.length < 4000 || links < 8) {
        row.why = "empty";
        row.detail = "returned " + body.length + " bytes and " + links +
          " links — probably needs JavaScript";
        return row;
      }

      row.usable = true;
      row.why = "ok";
      row.detail = body.length + " bytes, " + links + " links, HTTP " + got.res.status;
      return row;
    }));

    log("INFO", `browse: engine check for ${who} — ` +
      results.filter((r) => r.usable).length + "/" + results.length + " usable");
    send(res, 200, {
      current: searchFor(ticket),
      configured: cfg.searchUrl,
      query: q,
      results: results
    });
    return true;
  }

  /* The start page. Ours, not proxied, and the only page here that
     is entirely our own markup. */
  if (what === "ui") {
    return sendPage(req, res, 200, homePage(ticket)), true;
  }

  /* One place decides whether typed text is an address or a search,
     and it is this one. The client used to decide and then build a
     different URL for each; now it types into a form served from
     here, so there is a single answer rather than two that can
     disagree. */
  if (what === "go") {
    const typed = String(url.searchParams.get("q") || "").trim();
    if (!typed) { res.writeHead(302, Object.assign({ Location: uiUrl(ticket) }, baseHeaders())); res.end(); return true; }
    const to = looksLikeAddress(typed)
      ? proxied(/^https?:\/\//i.test(typed) ? typed : "https://" + typed, ticket)
      : proxied(searchFor(ticket) + encodeURIComponent(typed), ticket);
    res.writeHead(302, Object.assign({ Location: to }, baseHeaders()));
    res.end();
    return true;
  }

  /* Back and forward move the cursor and redirect to whatever it
     now points at. The resulting fetch records a location that is
     already the current entry, so it does not push a duplicate —
     see noteLocation(). */
  if (what === "back" || what === "fwd") {
    const to = historyGo(ticket, what === "back" ? -1 : 1);
    res.writeHead(302, Object.assign(
      { Location: to ? proxied(to, ticket) : uiUrl(ticket) }, baseHeaders()));
    res.end();
    return true;
  }

  /* A search is a redirect into the proxy, not a special case of
     fetching. The engine is a config value and the default is a
     no-JavaScript one on purpose: scripts are stripped here, so an
     engine that needs them returns a blank page and looks broken. */
  if (what === "search") {
    const q = String(url.searchParams.get("q") || "").trim();
    if (!q) { send(res, 400, { error: "nothing to search for" }); return true; }
    const to = proxied(searchFor(ticket) + encodeURIComponent(q), ticket);
    res.writeHead(302, Object.assign({ Location: to }, baseHeaders()));
    res.end();
    return true;
  }

  /* Reload. The client cannot read where the frame went — different
     origin, permanently — but it does not need to: the history lives
     here, keyed by the ticket it already holds. So "again, please"
     is a route rather than a piece of cross-origin cleverness. */
  if (what === "reload") {
    const t = tickets.get(String(ticket));
    const here = (t && t.lastUrl) || null;
    res.writeHead(302, Object.assign(
      { Location: here ? proxied(here, ticket) : uiUrl(ticket) }, baseHeaders()));
    res.end();
    return true;
  }

  /* Change this session's search engine. See searchFor(). */
  if (what === "engine") {
    const want = String(url.searchParams.get("url") || "").trim();
    const t = tickets.get(String(ticket));
    if (!t) { send(res, 401, { error: "no valid browse ticket" }); return true; }
    if (!want) { send(res, 200, { ok: true, searchUrl: searchFor(ticket), default: cfg.searchUrl }); return true; }
    if (!isOfferedEngine(want)) {
      send(res, 400, { error: "that is not one of the engines this relay offers",
        detail: "Use ENGINES to see the list. Only a URL from it is accepted." });
      return true;
    }
    t.searchUrl = want;
    log("INFO", "browse: " + who + " switched search to " + want);
    send(res, 200, { ok: true, searchUrl: want, default: cfg.searchUrl });
    return true;
  }

  /* ---- the page itself ---- */
  if (!fromPath || !fromPath.ok) {
    return sendPage(req, res, 400, errorPage(
      (fromPath && fromPath.why) || "that is not a page address",
      url.pathname, ticket)), true;
  }
  const target = parseTarget(fromPath.url);
  if (!target.ok) {
    /* A filtered host gets its own page. It is a decision, not a
       failure, and a page that says "that did not load" sends
       someone off to check their wifi. */
    if (target.filtered) {
      log("INFO", `browse: ${who} blocked by filter -> ${target.host || "?"}`);
      return sendPage(req, res, 403, blockedPage(target.host || fromPath.url, target.why, ticket)), true;
    }
    return sendPage(req, res, 400, errorPage(target.why, fromPath.url, ticket)), true;
  }

  /* A POST body is read raw and passed through with its type. Raw,
     not parsed: a form can be urlencoded or multipart, and multipart
     carries a boundary that only survives if the bytes do. The size
     cap is the relay's own maxBodyBytes, applied by readRaw. */
  /* Carried for every method, not just GET: a range on a POST is
     meaningless but harmless, and special-casing it here would be a
     second place to keep in step with the first. */
  let send_ = undefined;
  const wantRange = boundRange(req.headers.range);
  if (wantRange) send_ = { range: wantRange, ifRange: String(req.headers["if-range"] || "") || undefined };
  if (method === "POST") {
    const raw = await readRaw(req, LIMITS.maxPostBytes);
    if (raw === null) {
      return sendPage(req, res, 413, errorPage(
        "that form was larger than the proxy will carry (" +
        Math.round(LIMITS.maxPostBytes / 1024) + " KB)", target.url.href, ticket)), true;
    }
    send_ = Object.assign(send_ || {}, { method: "POST", body: raw,
      contentType: String(req.headers["content-type"] || "application/x-www-form-urlencoded") });
  }

  /* The ticket comes along so the cookie jar has somewhere to live.
     The engine probe above deliberately does NOT pass one — a probe
     should neither carry a session nor start one. */
  const got = await fetchFollowing(target.url, ticket, send_);
  if (!got.ok) {
    if (got.filtered) {
      log("INFO", `browse: ${who} blocked by filter -> ${got.host || "?"} (after a redirect)`);
      return sendPage(req, res, 403, blockedPage(got.host || target.url.hostname, got.why, ticket)), true;
    }
    /* Logged by host, not by full URL. A list of every page the two
       of them ever read is a liability sitting on disk, and it is
       not needed to know the proxy is working. */
    log("WARN", `browse: ${who} could not reach ${target.url.hostname} — ${got.why}`);
    /* AN HTML PAGE IS THE WRONG ANSWER TO A FAILED STYLESHEET.

       This branch handed our "THAT DID NOT LOAD" page to whatever
       had asked, and most of what asks is not a page: a script tag,
       a stylesheet, a font. The browser's report of that is "Refused
       to execute script ... MIME type ('text/html') is not
       executable" — which names the proxy's own error page as the
       problem and says nothing about the host that actually refused.
       Measured on one CrazyGames load: three of those, plus a
       stylesheet refusal on the Godot docs, all of them pointing at
       the wrong thing.

       The bot-check branch further down already had this gate. This
       one, which is the ordinary "could not reach it" case, did not.

       A subresource gets the real status, no body, and a type that
       cannot be mistaken for content. Then the page's own error
       handling runs, and the console line names the status. */
    if (isSubresource(req)) {
      return sendRaw(req, res, got.status || 502, "text/plain; charset=utf-8",
        Buffer.alloc(0)), true;
    }
    return sendPage(req, res, got.status, errorPage(got.why, target.url.href, ticket)), true;
  }

  log("INFO", `browse: ${who} -> ${got.url.hostname} (${got.res.status})`);

  const type = String(got.res.headers["content-type"] || "application/octet-stream");
  let body;
  try { body = decompress(got.res); }
  catch (e) {
    /* Same rule for a body that would not decompress. */
    if (isSubresource(req)) {
      return sendRaw(req, res, 502, "text/plain; charset=utf-8", Buffer.alloc(0)), true;
    }
    return sendPage(req, res, 502, errorPage(e.message, got.url.href, ticket)), true;
  }

  /* Only a navigation is recorded — a page is dozens of requests and
     the address bar must not follow whichever stylesheet finished
     last. See noteLocation().

     HTML waits. A redirector is a page nobody was ever meant to see,
     and recording it put a step in the history that Back lands on and
     is immediately bounced off again — so Back looked broken while
     doing exactly what it was told. Non-HTML cannot bounce, so it is
     recorded here where it always was. */
  const isNav = isNavigation(req, type);
  const isHtml = /^text\/html/i.test(type);
  if (isNav && !isHtml && !fromPath.frame) noteLocation(ticket, got.url.href);

  if (isHtml) {
    let text = body.toString("utf8");

    /* A bot check is not an error as far as HTTP is concerned — most
       of them are a 200 with a CAPTCHA in the body. Proxied and
       script-stripped, that renders as a broken-looking page, and
       the reasonable conclusion from the other side of the screen is
       "the browser is broken". Naming it is the whole fix; nothing
       here tries to get past one. */
    /* Gated on isNav, and that gate was missing. A subresource can
       be text/html too — an ad frame, a tracking pixel that answers
       with a page, a JS bundle a CDN decided to 403 — and replacing
       one of those with our explanation served the page an HTML
       document where it asked for a script. The browser's report of
       that is "Refused to execute script ... MIME type text/html",
       which points at the wrong thing entirely and is how a game
       ends up failing silently while the page around it loads. A
       subresource keeps its real status and type and lets the page
       handle its own failure. */
    if (isNav && looksLikeChallenge(text, got.res.status)) {
      log("WARN", `browse: ${got.url.hostname} served a bot check to ${who}`);
      /* The wording had one case in mind — a search engine refusing
         the relay — and said so, which was actively misleading the
         other times it fired. The commonest of those is a game or a
         video embedded from a second host whose protection provider
         has blocked the relay's address outright: measured, that is
         a Cloudflare 403 reading "you are unable to access this
         site", nothing to do with searching.

         Naming which of the two this is costs one boolean and turns
         a wrong instruction into a right one. Neither gets worked
         around: not the search engine's, not the CDN's. */
      const wasSearch = isSearchPage(got.url.href, ticket);
      return sendPage(req, res, 200, errorPage(
        got.url.hostname + " refused this request and answered with a bot check " +
        "rather than a page. Something in front of it has decided this relay's " +
        "address is a robot — hosted servers get this a lot, and it is about " +
        "where the request came from rather than about what was asked for. " +
        "Nothing in FieldKit will try to get past it. " +
        (wasSearch
          ? "This was a search, so press ENGINES in the FieldKit toolbar: it tests " +
            "every engine from this relay and lets you switch to one that answers."
          : "If this was a game or a video inside a page, the page around it " +
            "loaded and this one piece did not. There is no setting that fixes " +
            "that — the block is on the other end."),
        got.url.href, ticket)), true;
    }

    /* Follow a bounce rather than serving it. See redirectorTarget:
       a search result's link is a page that only assigns to
       location, and location is the one thing the shim cannot
       reach. Answered as a 302 so history and the address box see an
       ordinary navigation. */
    const bounce = redirectorTarget(text, got.url.href);
    if (bounce) {
      log("INFO", `browse: ${got.url.hostname} bounced ${who} to ${new URL(bounce).hostname}`);
      /* Deliberately NOT recorded. The next request records where it
         actually landed, so the history holds the two pages a person
         would say they visited and not the doorway between them. */
      /* The mark is carried across the bounce. Without it a
         redirector INSIDE a nested frame — Bing's sign-in widget is
         one — hands back an unmarked destination, and that lands in
         the history as though somebody had navigated to it. */
      res.writeHead(302, Object.assign(
        { Location: proxied(bounce, ticket, fromPath.frame) }, baseHeaders()));
      res.end();
      return true;
    }

    /* Recorded here rather than above: this is the point where a
       page is actually going to be shown to somebody. */
    if (isNav && !fromPath.frame) noteLocation(ticket, got.url.href);

    /* A SEARCH THAT ANSWERED WITH NOTHING.

       This is the shape the report took: "when you search something
       there are no links that pop up". Two different causes look
       identical from the other side of the screen — the engine
       served a results page with no results because it does not like
       being asked from a datacentre, or it served a page whose
       results are assembled by script that did not survive the trip.

       Neither is a proxy fault and neither is visible as an error,
       so the page arrives looking merely empty. Naming it costs one
       link-count over markup that has already been parsed once, and
       it turns a mystery into a sentence with a next step in it.

       Only for the engine this session actually searches with, and
       only for a top-level page — counting links on somebody's
       article and calling it an empty search would be worse than
       saying nothing. */
    let notice = null;
    if (isNav && !fromPath.frame && isSearchPage(got.url.href, ticket)) {
      /* Not zero — THREE. Measured rather than guessed: an engine's
         own results page still carries a handful of off-engine links
         that are not results. Mojeek's empty page has three (its
         blog's Mastodon account, its newsletter, one more), and
         every engine has some version of that footer. A real results
         page measured on live responses has eight to thirty.

         So the test is "fewer off-site links than a footer", which
         is a threshold and is therefore a judgement call — but the
         alternative is a list of hosts to ignore, which is a
         maintenance burden that goes stale silently. */
      let hits = searchResults(text, got.url.href, got.url.hostname);

      /* THE SEARCH THAT ONLY WORKS THE SECOND TIME.

         Reported as "the links only pop up after you refresh", and
         the refresh is the tell. Nothing about the second request is
         different except what the FIRST one left behind: an engine
         answers a session it has never seen with a consent page, a
         region-picker or a stripped shell, sets its cookies on that
         answer, and serves the real results to the next request that
         carries them. On a home connection this is invisible. From a
         datacentre, which is where this relay lives, it is the normal
         first contact.

         So do the refresh. Once, only for a top-level GET on the
         engine this session searches with, and only when the page
         that came back had no results in it — by then the jar has
         whatever the engine just set, which is exactly the state a
         person's manual refresh would have been in.

         Bounded on purpose: one extra request, no loop, and the
         retry only wins if it landed on the same address and came
         back with more. A retry that redirects somewhere else is
         discarded rather than shown, because everything downstream —
         the rewriter's base href, the recorded history entry, the
         toolbar's address — was computed from the first answer. */
      if (hits.length < EMPTY_RESULTS_BELOW && method === "GET" && !wantRange) {
        const again = await fetchFollowing(got.url, ticket, undefined);
        if (again.ok && again.url.href === got.url.href &&
            /^text\/html/i.test(String(again.res.headers["content-type"] || ""))) {
          let retext = null;
          try { retext = decompress(again.res).toString("utf8"); } catch (e) { retext = null; }
          if (retext) {
            const rehits = searchResults(retext, again.url.href, again.url.hostname);
            if (rehits.length > hits.length) {
              log("INFO", "browse: " + got.url.hostname + " answered the second ask with " +
                rehits.length + " result(s) where the first had " + hits.length);
              text = retext;
              hits = rehits;
            }
          }
        }
      }

      if (hits.length < EMPTY_RESULTS_BELOW) {
        log("WARN", "browse: " + got.url.hostname + " returned " + hits.length +
          " result-shaped link(s) to " + who + " twice");
        notice = got.url.hostname + " answered twice with no search results in it. " +
          "Search engines do this to addresses they think are robots, and some " +
          "of them build their results with JavaScript that does not survive " +
          "the trip. Refreshing will not help — this page was already asked for " +
          "a second time. Press ENGINES in the FieldKit toolbar: it tests every " +
          "engine from this relay and lets you switch to one that answers.";
      }
    }

    /* An explicit subresource dest is the only thing that makes
       this true. No dest at all still means "page", for the same
       reason isSubresource() is written the way it is. */
    const bare = isSubresource(req);
    const html = rewrite(text, got.url.href, ticket, fromPath.frame, notice, bare,
      cfg.pathMode === true);
    return sendPage(req, res, got.res.status, html,
      got.res.truncated ? "the page was longer than the proxy will carry and was cut short" : null), true;
  }
  if (/^text\/css/i.test(type)) {
    return sendRaw(req, res, got.res.status, "text/css; charset=utf-8",
      Buffer.from(
        rewriteCss(body.toString("utf8"), got.url.href, ticket, fromPath.frame), "utf8")), true;
  }

  /* JavaScript, and THE ONE THAT WOULD HAVE MADE ALL OF THIS POINTLESS.

     Everything not on the allow list below leaves here as
     application/octet-stream, and every response carries
     X-Content-Type-Options: nosniff. That combination is a hard block
     on execution: a browser will not run a <script> whose response
     came back as octet-stream, and it does not sniff to find out
     better. So with scripts turned on, the HTML kept its <script>
     tags, the shim was injected, the sandbox allowed scripts — and
     every external file the page asked for was refused by the browser
     before a line of it ran. Inline scripts worked, external ones did
     not, and nearly all of a real site is external.

     The allow list is a list rather than "pass the type through"
     because pinning is what stops a .png that is really HTML from
     becoming a script on this origin, and that protection is worth
     keeping. It just has to have JavaScript in it now. */
  if (cfg.runScripts && /^(application|text)\/(x-)?(javascript|ecmascript)|^text\/jsx?$|^application\/wasm/i.test(type)) {
    const isWasm = /^application\/wasm/i.test(type);
    return sendRaw(req, res, got.res.status,
      isWasm ? "application/wasm" : "text/javascript; charset=utf-8",
      isWasm ? body : Buffer.from(
        rewriteJs(body.toString("utf8"), got.url.href, ticket, fromPath.frame), "utf8")), true;
  }

  /* JSON and friends. fetch().json() does not check the type, but
     plenty of code does, and a manifest served as octet-stream is
     just ignored. */
  if (cfg.runScripts && /^(application\/(json|manifest\+json|[a-z0-9.+-]*\+json)|text\/xml|application\/xml|application\/[a-z0-9.+-]*\+xml)/i.test(type)) {
    return sendRaw(req, res, got.res.status, type, body), true;
  }

  /* Everything else goes through untouched but with its type pinned
     and sniffing off. */
  const safeType = /^(image|font|audio|video|text\/plain)/i.test(type)
    ? type : "application/octet-stream";
  /* 206 without a Content-Range is a contradiction, so a truncated
     partial goes out as an ordinary 200 of the bytes we do have. */
  const rh = rangeHeaders(got.res);
  const outStatus = (got.res.status === 206 && !rh["Content-Range"]) ? 200 : got.res.status;
  return sendRaw(req, res, outStatus, safeType, body, rh), true;
}

/* THE ONE THAT SAID "relay.outlawfieldkit.com refused to connect".

   `frame-ancestors *` was in this list, meaning "anyone may frame
   this", which is correct intent — the whole point is to be framed.
   But the wildcard in a CSP source list matches http, https, ws and
   wss, plus the protected resource's own scheme. It does NOT match
   `file:`. And the page doing the framing is FIELDKIT.html, loaded
   from a USB stick over `file://`.

   So the relay was telling the browser to refuse exactly the one
   parent that was ever going to ask, and Chrome's wording for a
   frame blocked that way is the host name followed by "refused to
   connect" — which reads like the server is down.

   It was invisible until now for a stupid reason: before the srcdoc
   fix the frame never navigated at all, so there was nothing for
   the directive to block.

   The directive is simply gone rather than widened. Absent means no
   restriction, which is what `*` was trying to say, and it avoids
   depending on how any given browser scores `file:` against a
   wildcard. Nothing is lost: framing this is the intended use, the
   frame is sandboxed, and a proxied page has no privileges to
   clickjack anyway. */
function baseHeaders() {
  /* Our own CSP, replacing whatever the origin sent rather than
     merging with it: the site's policy was written for the site's
     origin and is meaningless here.

     Which policy depends on runScripts, and the difference is the
     whole security tradeoff in one place.

     WITH SCRIPTS OFF, this is the belt to rewrite()'s braces — if a
     <script> ever survives the rewriter, the browser still refuses
     to run it, and two independent things have to fail.

     WITH SCRIPTS ON that second layer is gone by choice, because a
     reader that renders a tenth of the web is not the thing that
     was asked for. What is still true: this is a different origin
     from FieldKit, which is `file://`, so nothing a page does can
     reach the vault, the settings or the messaging session. That
     protection comes from the origin, not from the sandbox, and it
     does not weaken here.

     What DOES weaken: every proxied site shares this one origin, so
     one site's script can read another's page through the proxy.
     Cookies are kept server-side partly for that reason. It is a
     real cost, it is why runScripts is a setting rather than an
     assumption, and it is written down in config.example.json where
     someone deciding will actually see it. */
  const csp = cfg.runScripts
    ? "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
      "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
      "style-src * data: 'unsafe-inline'; img-src * data: blob:; " +
      "font-src * data:; media-src * data: blob:; connect-src *; " +
      /* worker-src has to include the relay itself, not just blob: —
         a worker the shim re-pointed at /browse/p/… is loaded from
         this origin, and 'blob:' alone refuses it. */
      "frame-src *; worker-src * blob: data:; form-action 'self'"
    : "default-src 'none'; img-src * data:; style-src * 'unsafe-inline'; " +
      "font-src * data:; media-src *; form-action 'self'";

  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    /* same-origin, NOT no-referrer, and this is a correctness fix
       rather than a loosening.

       rescueFromReferer() is the net under everything the shim
       cannot reach: location.assign, a worker's own fetches, a URL
       built inside a stylesheet at runtime. All of those land on the
       relay's root, and the ONLY thing that can say which site they
       meant is the Referer of the page they came from. The header
       above switched that off. Measured rather than reasoned about:
       document.referrer on a proxied page read empty, and a page's
       /favicon.ico came back as the relay's own 404 instead of being
       redirected to the site's. The net was never firing.

       same-origin sends the full referrer to the relay, which is the
       only place these requests go, and sends NOTHING cross-origin —
       which matters more here than usual, because the referrer of a
       proxied page has the browse ticket in its path. The relay is
       already the party that knows the ticket and the address; a
       third party still learns neither. */
    "Referrer-Policy": "same-origin",
    /* no-store stays. This runs off a USB stick on machines that
       belong to somebody else, and a cache is a copy of what was
       read left on their disk. The speed that would have bought is
       taken out of compression instead — see finish(). */
    "Cache-Control": "no-store"
  };
}

/* ---- COMPRESSION, AND WHY ITS ABSENCE WAS THE WHOLE "IT IS SLOW"

   The relay asks origins for gzip and unpacks what it gets, because
   it has to read the bytes to rewrite them. It then sent the result
   out as plain text and never packed it again. Measured on one page
   of the Godot docs: 107 KB over the wire when the browser fetches
   it directly, 2.3 MB through here. Twenty-one times, and it lands
   on whatever the school wifi is that day.

   The rewrite is why the number is so lopsided. Every URL in the
   document gains a /browse/p/<48 hex>/https:// prefix, which grew
   that page's HTML from 1.38 MB to 2.30 MB on its own — and those
   prefixes are the most compressible bytes imaginable, the same
   seventy characters over and over. Packing gives all of it back
   and then some.

   Only text goes through here. Images, fonts, audio, video and wasm
   are already compressed and running them through gzip spends CPU
   on the relay to make the file very slightly bigger. HEAD and 204s
   have no body to pack. Small bodies are left alone because a gzip
   header is 20-odd bytes and a one-line error page is not worth it.

   No brotli. Node ships it, but it is several times slower to
   compress at comparable ratios and this is a per-request cost on a
   box that is also serving the vault. gzip at its default level is
   the trade that fits. */
const PACKABLE = /^(text\/|application\/(json|javascript|ecmascript|manifest\+json|xml|xhtml\+xml|[a-z0-9.+-]*\+json|[a-z0-9.+-]*\+xml))/i;
const PACK_ABOVE = 1400;      // one ethernet frame; below this it is noise

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String((req && req.headers && req.headers["accept-encoding"]) || ""));
}

function finish(req, res, status, type, buf, extra) {
  const headers = Object.assign({ "Content-Type": type }, baseHeaders(), extra || {});

  /* Vary regardless of what this particular answer did: anything
     between here and the browser has to know that the body depends
     on the request's encoding, and saying so only when we happened
     to compress is how a cache poisons itself. */
  headers.Vary = "Accept-Encoding";

  /* HEAD keeps the headers it would have had — including the length
     of the body it is not being sent, which is the number the caller
     asked for. */
  if (String(req.method).toUpperCase() === "HEAD") {
    headers["Content-Length"] = String(buf.length);
    res.writeHead(status, headers);
    return res.end();
  }

  /* Never a partial answer. Content-Range counts bytes of the
     ORIGINAL representation, and gzipping the slice makes every
     number in that header a lie — the player then reassembles
     garbage, which is a far worse failure than a slightly larger
     response. */
  const canPack = buf.length >= PACK_ABOVE && PACKABLE.test(type) &&
    acceptsGzip(req) && status !== 204 && status !== 304 &&
    status !== 206 && !headers["Content-Range"];

  if (!canPack) {
    headers["Content-Length"] = String(buf.length);
    res.writeHead(status, headers);
    return res.end(buf);
  }

  zlib.gzip(buf, function (err, packed) {
    /* A compressor that failed is not a page that failed. */
    if (err || !packed) {
      headers["Content-Length"] = String(buf.length);
      res.writeHead(status, headers);
      return res.end(buf);
    }
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = String(packed.length);
    res.writeHead(status, headers);
    res.end(packed);
  });
}

function sendPage(req, res, status, html, note) {
  const body = note
    ? html.replace(/<\/body>/i,
        '<div style="all:initial;display:block;font:12px monospace;background:#2a1f10;' +
        'color:#e0b070;padding:6px 10px">' + escapeHtml(note) + "</div></body>")
    : html;
  finish(req, res, status, "text/html; charset=utf-8", Buffer.from(body, "utf8"));
}

function sendRaw(req, res, status, type, buf, extra) {
  finish(req, res, status, type,
    Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8"), extra);
}

/* The three headers a partial answer is made of. Copied from
   upstream rather than invented here: the relay did not decide the
   slice, it asked for one and is relaying the answer, and a
   Content-Range that disagrees with the bytes is worse than none. */
function rangeHeaders(res) {
  const out = {};
  const h = (res && res.headers) || {};
  /* A truncated body is exactly the case Content-Range must not
     survive: the header would describe bytes that are not in the
     answer, and a player believes the header. Bounding the request
     should make this unreachable; it is here because "should" is not
     the same as "does", and the failure it prevents is silent. */
  if (res && res.truncated) return { "Accept-Ranges": "bytes" };
  if (h["content-range"]) out["Content-Range"] = h["content-range"];
  if (h["accept-ranges"]) out["Accept-Ranges"] = h["accept-ranges"];
  return out;
}

/* THE DEAD END.

   This page had no toolbar. blockedPage() below has always had one;
   this one, which is the failure people actually meet — a host that
   refused the relay, a bot check, a timeout — did not. So the
   commonest way to fail was also the only way to end up somewhere
   with no address box, no Back, and no way out except closing the
   window and starting the session again.

   It takes the ticket now for exactly that reason. Where a caller
   has no ticket to give, the bar renders in its dead state, which is
   still a bar and still says where you are.

   The address box is prefilled with what was being asked for rather
   than left empty: the usual next move after a page fails is to try
   it again or to edit it slightly, and retyping it is the worst way
   to offer that. */
function errorPage(why, what, ticket) {
  return "<!doctype html><meta charset=utf-8>" +
    '<body style="margin:0;font:13px ui-monospace,monospace;background:#0c100e;color:#c8d4cd">' +
    toolbar(ticket, what ? String(what) : "") +
    '<div style="padding:24px">' +
    '<div style="color:#e08080;letter-spacing:.16em;margin-bottom:10px">THAT DID NOT LOAD</div>' +
    '<div style="line-height:1.7">' + escapeHtml(why) + "</div>" +
    (what ? '<div style="color:#6d7a73;margin-top:10px;word-break:break-all">' +
      escapeHtml(String(what).slice(0, 300)) + "</div>" : "") +
    "</div></body>";
}

/* A block is not an error and must not read like one. "That did not
   load" sends someone to check their connection; this says a
   decision was made, where it was made, and that it was not made
   here — which is the whole point of putting it on the relay. */
function blockedPage(host, why, ticket) {
  return "<!doctype html><meta charset=utf-8>" +
    '<body style="margin:0;font:13px ui-monospace,monospace;background:#0c100e;color:#c8d4cd">' +
    toolbar(ticket, "") +
    '<div style="padding:26px;line-height:1.7">' +
    '<div style="color:#e0b070;letter-spacing:.18em;margin-bottom:12px">BLOCKED BY THIS RELAY</div>' +
    "<div><b>" + escapeHtml(String(host).slice(0, 120)) + "</b> is not reachable through here.</div>" +
    '<div style="color:#8a978f;margin-top:8px">' + escapeHtml(why) + "</div>" +
    '<div style="color:#6d7a73;margin-top:18px">This is set on the relay, not on this ' +
    "machine, so nothing in FieldKit can turn it off. Whoever runs the relay changes it " +
    "in <code>browse.filter</code> and restarts.</div>" +
    "</div></body>";
}

/* The net under everything the shim cannot reach. Called by server.js
   from the one line before its 404, so it only ever sees requests
   nothing else wanted.

   Returns a proxy URL, or null to let the 404 happen. Null is the
   right answer far more often than not: the relay's own routes have
   already matched by this point, so anything here is either a proxied
   page's mistake or somebody poking at the relay, and only the first
   gets helped.

   Reasoning about the Referer honestly: it is unauthenticated and
   trivially forged, so it decides only WHERE TO REDIRECT. The ticket
   inside it is not trusted here — it is put back in the path and
   checked by the browse route on the next request like any other. A
   forged Referer therefore buys a 302 to a URL its sender already
   knew, which is nothing. */
/* The parameter the visible address carries, and the only reason it
   is there: once a page's address is /results?search_query=x, a
   reload or a request the shim never saw arrives at the relay as a
   bare path with nothing to say which site it belongs to. The ticket
   answers that, and it is already the thing this whole route is
   keyed on.

   Read from the request first and from the Referer second, which
   covers both shapes: the page itself being reloaded, and an asset
   the page asked for while sitting at that address. */
const VISIBLE_KEY = "__fk";

function ticketFromVisible(url, req) {
  const own = url.searchParams && url.searchParams.get(VISIBLE_KEY);
  if (own && ticketHolder(own)) return { ticket: own, from: "url" };

  const ref = String((req && (req.headers.referer || req.headers.referrer)) || "");
  if (!ref) return null;
  let refUrl;
  try { refUrl = new URL(ref); } catch (e) { return null; }
  const t = refUrl.searchParams.get(VISIBLE_KEY);
  if (t && ticketHolder(t)) return { ticket: t, from: "referer" };
  return null;
}

/* The path as the site would write it, with our parameter taken back
   out. Removing it matters: it is not part of the site's url, and
   leaving it in would send it upstream and put it in the address the
   toolbar prints. */
function strippedPath(url) {
  const q = new URLSearchParams(url.search || "");
  q.delete(VISIBLE_KEY);
  const qs = q.toString();
  return String(url.pathname || "/") + (qs ? "?" + qs : "");
}

/* Whether this request could possibly belong to a proxied page. Used
   to decide how to FAIL, not whether to allow anything: a request
   that carries a live ticket and still could not be placed deserves
   an explanation a person can read, not the relay's route list. */
function looksProxied(req, url) {
  if (!cfg.enabled) return false;
  return !!ticketFromVisible(url, req);
}

function rescueFromReferer(req, url) {
  const p = String(url.pathname || "");

  /* Never rescue the relay's own surface. Redirecting /vault into the
     proxy because a page happened to link to it would be absurd, and
     worse, it would make the relay fetch its own address from the
     outside. */
  if (p.indexOf("/browse/") === 0) return null;
  if (/^\/(health|status|vault|records|blobs|actions|usage|ai|msg|updates)(\/|$)/.test(p)) return null;

  /* pathMode first: a ticket named in the address is a fact, where a
     Referer is a guess that happens to be usually right. Resolved
     against the page that ticket is currently ON, which is what
     makes a reload land back on the same page rather than on the
     site's front door. */
  const named = ticketFromVisible(url, req);
  if (named) {
    const st = historyState(named.ticket);
    const here = st.url || (tickets.get(named.ticket) || {}).lastUrl;
    if (here) {
      const abs = absolute(strippedPath(url), here);
      if (abs) return proxied(abs, named.ticket, false);
    }
  }

  const ref = String(req.headers.referer || req.headers.referrer || "");
  if (!ref) return null;

  let refPath;
  try { refPath = new URL(ref).pathname; }
  catch (e) { return null; }

  const from = targetFromPath(refPath, "");
  if (!from.ok) return null;

  /* Resolve against the REFERRING PAGE's real address, which is the
     whole trick: `/api/me` means the site's /api/me, not the relay's,
     and the referring page is the only thing that knows which site. */
  const abs = absolute(p + (url.search || ""), from.url);
  if (!abs) return null;

  /* And across the rescue, for the same reason. */
  return proxied(abs, from.ticket, from.frame);
}

/* Does this path carry a browse ticket that is currently valid?

   Asked by server.js BEFORE its general rate limiter, and the reason
   is a bug that only shows up when the browser starts working. One
   ordinary page is forty-odd requests — its stylesheets, its fonts,
   every image, every script. The general limiter allows 240 a minute
   to anyone without an Authorization header, and an iframe cannot
   send one; that is the entire reason tickets exist. So four or five
   pages tripped a limiter meant to stop anonymous floods, and the
   browse bucket's own 600 never came into it.

   A ticket is not a stranger. It is issued only in exchange for a
   vault token or a signed-in messaging account, it is forty-eight hex
   characters, it expires in thirty minutes, and there are never more
   than two hundred. Checking one is a Map lookup with no disk in it,
   which matters because this runs on the path a flood takes.

   Requests that pass still meet the browse bucket, which is the limit
   that was written for this shape of traffic. */
function hasValidTicket(pathname) {
  const p = String(pathname || "");
  if (p.indexOf(PROXY_PREFIX) !== 0) return false;
  const from = targetFromPath(p, "");
  if (!from.ok) return false;
  return ticketHolder(from.ticket) !== null;
}

module.exports = {
  init, route, rescueFromReferer, looksProxied, hasValidTicket, LIMITS,
  /* The streamed browser (§14.11) enforces the same host rules at
     its egress guard. Exported rather than duplicated so there is
     one block list and one place to change it. */
  hostVerdict: (host) => hostAllowed(host),
  _internals: { isPrivateAddress, parseTarget, safeAddresses, rewrite, rewriteCss,
    rewriteJs, issueTicket, ticketHolder, hostAllowed, tickets, baseHeaders, proxied,
    targetFromPath, looksLikeChallenge, isNavigation, isSubresource, noteLocation,
    finish, sendPage, sendRaw, errorPage, acceptsGzip, boundRange, rangeHeaders,
    ticketFromVisible, strippedPath, VISIBLE_KEY, looksProxied,
    searchFor, isSearchPage, isOfferedEngine,
    historyGo, historyState, looksLikeAddress, toolbar, homePage, uiUrl,
    parseBlocklist, loadFilter, filterVerdict, walkUp, blockedPage,
    cookieJar, storeSetCookies, cookieHeaderFor, readRaw,
    redirectorTarget, visibleText,
    readableText, pageTitle, pageLinks, searchResults, unwrapRedirect, unentity,
    filterStats: () => filterStats,
    ENGINE_CANDIDATES }
};
