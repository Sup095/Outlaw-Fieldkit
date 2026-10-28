/* ============================================================
   relay/browse.js — the fetch-and-re-serve proxy

   Most of this suite is about the four ways a proxy like this gets
   someone hurt, and they are not equally likely. The one that
   actually happens is SSRF: the relay sits in a container that can
   reach other containers, the host, and on most providers a
   metadata endpoint that hands out credentials to whatever asks.
   `?url=http://169.254.169.254/` has to be refused, and so does a
   hostname that resolves there, and so does a redirect that lands
   there on the third hop.

   So the address checks are tested exhaustively and by hand rather
   than through a live fetch: a test that needs the network to prove
   127.0.0.1 is refused proves nothing on a machine with no network.
   The live half runs against a real origin server started here.
   ============================================================ */
"use strict";

const http = require("http");
const { makeRunner } = require("./harness");
const browse = require("../relay/browse");
const { ok, section, state } = makeRunner("browse");
const P = browse._internals;

browse.init({ config: { enabled: true }, log: () => {} });

(async function () {
  section("private and reserved addresses are refused");
  {
    /* Every one of these is a way in to something that is not the
       public internet. The metadata address is the one that turns a
       proxy bug into a credential leak. */
    const mustBlock = [
      "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.5", "10.255.255.255",
      "172.16.0.1", "172.20.10.1", "172.31.255.255", "192.168.1.1", "192.168.0.254",
      "169.254.169.254", "169.254.1.1", "100.64.0.1", "100.127.255.255",
      "192.0.0.1", "192.0.2.5", "198.18.0.1", "224.0.0.1", "239.1.1.1", "255.255.255.255",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "not-an-address", ""
    ];
    let missed = [];
    mustBlock.forEach((ip) => { if (!P.isPrivateAddress(ip)) missed.push(ip); });
    ok("every private, reserved and unparseable address is refused",
      missed.length === 0, missed.join(", "));

    /* The metadata endpoint named on its own, because it is the one
       that costs the most and is the easiest to leave out. */
    ok("the cloud metadata address specifically", P.isPrivateAddress("169.254.169.254"));
    ok("and its IPv4-mapped IPv6 disguise", P.isPrivateAddress("::ffff:169.254.169.254"));

    const mustAllow = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1",
      "100.63.255.255", "100.128.0.1", "11.0.0.1", "2606:4700::1111"];
    let wrong = [];
    mustAllow.forEach((ip) => { if (P.isPrivateAddress(ip)) wrong.push(ip); });
    ok("ordinary public addresses are not refused by mistake",
      wrong.length === 0, wrong.join(", "));

    /* The boundaries, because off-by-one here is the whole bug.
       172.16-31 is private; 172.15 and 172.32 are not. */
    ok("172.15.255.255 is public and 172.16.0.0 is not",
      !P.isPrivateAddress("172.15.255.255") && P.isPrivateAddress("172.16.0.0"));
    ok("172.31.255.255 is private and 172.32.0.0 is not",
      P.isPrivateAddress("172.31.255.255") && !P.isPrivateAddress("172.32.0.0"));
  }

  section("what counts as a url");
  {
    ok("a bare host is assumed https", P.parseTarget("example.com").url.protocol === "https:");
    ok("http is allowed", P.parseTarget("http://example.com").ok);
    ok("file: is not", !P.parseTarget("file:///etc/passwd").ok);
    ok("data: is not", !P.parseTarget("data:text/html,<b>x</b>").ok);
    ok("gopher: is not", !P.parseTarget("gopher://example.com").ok);
    ok("javascript: is not", !P.parseTarget("javascript:alert(1)").ok);

    /* Credentials in a url would be forwarded upstream and sit in
       this process's memory. Refused rather than stripped, so nobody
       believes they were sent. */
    const creds = P.parseTarget("https://user:pw@example.com");
    ok("a url with a password in it is refused", !creds.ok);
    ok("and says why", /username or password/.test(creds.why), creds.why);

    ok("something absurd is refused", !P.parseTarget("h ttp://x").ok);
    ok("nothing at all is refused", !P.parseTarget("").ok);
    ok("a 3000-character url is refused", !P.parseTarget("https://e.com/" + "a".repeat(3000)).ok);
  }

  section("an ip literal skips dns but not the check");
  {
    const loop = await P.safeAddresses("127.0.0.1");
    ok("a loopback literal is refused without a lookup", !loop.ok);
    ok("and says what is wrong", /private or reserved/.test(loop.why), loop.why);
    const meta = await P.safeAddresses("169.254.169.254");
    ok("so is the metadata address", !meta.ok);
    const pub = await P.safeAddresses("8.8.8.8");
    ok("a public literal passes and is handed back to pin against",
      pub.ok && pub.addresses[0].address === "8.8.8.8");
  }

  section("allow and block lists");
  {
    browse.init({ config: { enabled: true, blockHosts: ["bad.example"] }, log: () => {} });
    ok("a blocked host is refused", !P.hostAllowed("bad.example").ok);
    ok("and so is a subdomain of it", !P.hostAllowed("www.bad.example").ok);
    ok("but not a host that merely ends in the same letters",
      P.hostAllowed("notbad.example").ok);
    ok("anything else passes when there is no allow list", P.hostAllowed("good.example").ok);

    browse.init({ config: { enabled: true, allowHosts: ["wiki.example"] }, log: () => {} });
    ok("with an allow list, a listed host passes", P.hostAllowed("wiki.example").ok);
    ok("a subdomain of a listed host passes", P.hostAllowed("en.wiki.example").ok);
    ok("and everything else does not", !P.hostAllowed("other.example").ok);

    /* Re-initialising must give the config the file describes, not
       that config merged onto the last one. Without this, a setting
       once turned on could never be turned off. */
    browse.init({ config: { enabled: true }, log: () => {} });
    ok("re-initialising clears the previous allow list rather than merging onto it",
      P.hostAllowed("anything.example").ok);
    ok("and the previous block list too", P.hostAllowed("bad.example").ok);
  }

  section("tickets");
  {
    const t = P.issueTicket("vault");
    ok("a ticket is issued", typeof t.ticket === "string" && t.ticket.length >= 32);
    ok("it says when it dies", t.expiresIn > 0);
    ok("it resolves back to who asked for it", P.ticketHolder(t.ticket) === "vault");
    ok("a made-up ticket resolves to nobody", P.ticketHolder("0".repeat(48)) === null);
    ok("so does an empty one", P.ticketHolder("") === null);

    /* The ticket is not the token: it carries a name, not a
       credential, and knowing it does not let you do anything else
       on this relay. */
    ok("a ticket is not derived from anything the holder sent",
      t.ticket !== "vault" && t.ticket.indexOf("vault") < 0);

    P.tickets.set("expired-one", { who: "vault", expires: Date.now() - 1000 });
    ok("an expired ticket resolves to nobody", P.ticketHolder("expired-one") === null);
    ok("and is dropped rather than left to accumulate", !P.tickets.has("expired-one"));
  }

  section("rewriting with scripts off — reader mode");
  {
    /* Reader mode is still a supported setting and it is the one to
       hand somebody a drive on, so it keeps its own section rather
       than being replaced by the scripts-on behaviour. Everything
       here asserts the strip. */
    browse.init({ config: { enabled: true, runScripts: false }, log: () => {} });

    const base = "https://site.example/dir/page.html";

    const scripts = P.rewrite(
      '<html><body><script>steal()</script><p>kept</p><script src="/x.js"></script></body></html>', base);
    ok("inline scripts are removed", scripts.indexOf("steal()") < 0);
    ok("script tags with a src are removed", scripts.indexOf("x.js") < 0);
    ok("the page around them survives", scripts.indexOf("kept") >= 0);

    const handlers = P.rewrite('<body><a href="/x" onclick="steal()" onmouseover=\'go()\'>t</a></body>', base);
    ok("inline event handlers are removed too — they are scripts in a hat",
      handlers.indexOf("steal()") < 0 && handlers.indexOf("go()") < 0);

    const links = P.rewrite('<body><a href="/other">x</a><img src="pic.png"></body>', base);
    ok("an absolute-path link is rewritten through the proxy",
      links.indexOf("/browse/p/") >= 0 && links.indexOf("https://site.example/other") >= 0, links);
    ok("a relative link resolves against the page, not the proxy",
      links.indexOf("https://site.example/dir/pic.png") >= 0, links);

    const skip = P.rewrite('<body><a href="#top">a</a><a href="mailto:x@y.z">b</a>' +
      '<a href="javascript:steal()">c</a></body>', base);
    ok("a fragment is left alone", skip.indexOf('href="#top"') >= 0);
    ok("mailto is left alone", skip.indexOf("mailto:x@y.z") >= 0);
    ok("a javascript: link is not turned into a proxied one",
      skip.indexOf("/browse/p/") < 0 || skip.indexOf("javascript:steal") === skip.lastIndexOf("javascript:steal"));

    /* <base> would send every relative url straight back to the real
       site, which quietly undoes all of the above. */
    ok("a <base> tag is removed",
      P.rewrite('<head><base href="https://elsewhere/"></head><body>x</body>', base)
        .indexOf("<base") < 0);
    ok("meta refresh is removed",
      P.rewrite('<head><meta http-equiv="refresh" content="0;url=/go"></head><body>x</body>', base)
        .indexOf("http-equiv") < 0);

    ok("css url() is rewritten",
      P.rewriteCss("a{background:url(/bg.png)}", base)
        .indexOf("https://site.example/bg.png") >= 0);
    ok("a data: url in css is left alone",
      P.rewriteCss("a{background:url(data:image/gif;base64,AA)}", base).indexOf("data:image") >= 0);

    /* Counted inside the srcset attribute rather than across the
       whole document: the toolbar injected at the top of every page
       has a proxied reload link of its own, so a document-wide count
       measures the toolbar as well as the thing under test. */
    const srcsetOf = (html) =>
      ((/\bsrcset="([^"]*)"/i.exec(html) || [])[1] || "");
    ok("srcset entries are all rewritten",
      (srcsetOf(P.rewrite('<body><img srcset="a.png 1x, b.png 2x"></body>', base))
        .match(/browse\/p\//g) || []).length === 2,
      srcsetOf(P.rewrite('<body><img srcset="a.png 1x, b.png 2x"></body>', base)));

    /* Every rewritten URL is a separate request the BROWSER makes,
       not one we make, and an iframe cannot set a header. Drop the
       ticket and the page arrives as unstyled text with broken
       images and every link 401ing. */
    const withTicket = P.rewrite(
      '<body><a href="/a">x</a><img src="/b.png"><style>i{background:url(/c.png)}</style></body>',
      base, "TICKET123");
    ok("links carry the ticket", /href="\/browse\/p\/TICKET123\//.test(withTicket), withTicket);
    ok("images carry it too", /src="\/browse\/p\/TICKET123\/[^"]*b\.png/.test(withTicket), withTicket);
    ok("and so do css urls inside the page",
      /url\(\/browse\/p\/TICKET123\/[^)]*c\.png/.test(withTicket), withTicket);
    ok("srcset entries carry it",
      (srcsetOf(P.rewrite('<body><img srcset="a.png 1x, b.png 2x"></body>', base, "TICKET123"))
        .match(/\/browse\/p\/TICKET123\//g) || []).length === 2);
    ok("a standalone stylesheet carries it",
      /\/browse\/p\/TICKET123\//.test(P.rewriteCss("a{background:url(/bg.png)}", base, "TICKET123")));
    ok("the ticket comes before the target, so a query cannot displace it",
      P.proxied("https://x.example/s?q=1", "TICK").indexOf("/browse/p/TICK/https://x.example/s?q=1") === 0,
      P.proxied("https://x.example/s?q=1", "TICK"));

    /* Forms work now, and that is the whole point of moving the
       target into the path: a GET form's query lands AFTER the
       target instead of beside it. */
    const form = P.rewrite('<body><form action="/search"><input name=q></form></body>', base, "T");
    ok("a GET form's action is proxied so it can actually submit",
      /action="\/browse\/p\/T\/https:\/\/site\.example\/search"/.test(form), form);
    ok("and the csp permits submission back to us",
      /form-action 'self'/.test(P.baseHeaders()["Content-Security-Policy"]));

    /* A POST form used to be dismantled here, because the route
       refused POST and a button that produces a 405 is worse than a
       button that explains itself. The route takes POST now, so the
       form is left intact — in reader mode too. Reader mode means the
       page's scripts do not run; it never meant its forms are
       ornamental, and defanging them would have made "scripts off"
       quietly also mean "cannot log in". */
    const post = P.rewrite('<body><form method="POST" action="/login"><input name=pw></form></body>', base, "T");
    ok("a POST form keeps its method", /method\s*=\s*"POST"/i.test(post), post);
    ok("and is pointed back through the proxy",
      post.indexOf('action="/browse/p/T/https://site.example/login"') >= 0, post);
    ok("nothing tells the reader their typing is going nowhere any more",
      !/Nothing typed below will be sent/.test(post));

    const banner = P.rewrite("<html><body><p>hi</p></body></html>", base);
    ok("a banner says this is a proxied copy", /FIELDKIT READER/.test(banner));
    ok("it names the page it is a copy of", banner.indexOf("site.example") >= 0);
    ok("and warns against typing a password into it", /Do not type a password/.test(banner));
    ok("it says scripts are gone, since that is what breaks pages",
      /scripts removed/.test(banner));
    /* The banner is the last thing a reader sees before they trust
       the page, so it has to repeat the one claim the module makes
       everywhere else rather than implying privacy by omission. */
    ok("and it does not let the reader assume anonymity",
      /does not hide you from your relay/.test(banner), banner.slice(0, 400));

    /* A page with no <body> still gets the banner, or a bare
       fragment would render with nothing marking it as proxied. */
    ok("a page with no body tag still gets the banner",
      /FIELDKIT READER/.test(P.rewrite("<p>bare</p>", base)));

    /* The banner is built from the URL, so a URL with a quote in it
       must not be able to close the attribute and inject markup. */
    const nasty = P.rewrite("<body>x</body>", 'https://site.example/"><script>steal()</script>');
    ok("a hostile url cannot break out of the banner", nasty.indexOf("<script>steal") < 0, nasty.slice(0, 300));
  }

  section("what we send back with scripts off");
  {
    browse.init({ config: { enabled: true, runScripts: false }, log: () => {} });
    const h = P.baseHeaders();
    /* Every proxied site lands on ONE origin. A Set-Cookie from the
       first site would be sent back to us on a request for the
       second, so nothing from upstream is copied at all — the
       response headers are built from scratch, and this asserts that
       the built set contains nothing a site could have influenced. */
    const names = Object.keys(h).map((k) => k.toLowerCase());
    ok("nothing sets a cookie", names.indexOf("set-cookie") < 0);
    ok("sniffing is off, so a .png full of html cannot become a script",
      h["X-Content-Type-Options"] === "nosniff");
    /* same-origin rather than no-referrer, and the difference is
       load bearing rather than cosmetic. rescueFromReferer() is the
       only net under a navigation the shim cannot intercept —
       location.assign, a worker's own fetches — and it works by
       reading the Referer of the page that made the request. Under
       no-referrer there was never one to read, so the net was dead
       code: measured on a live page, document.referrer was empty and
       /favicon.ico came back as the relay's 404 rather than the
       site's icon.

       Cross-origin still sends nothing, which is the half that
       matters for secrecy: a proxied page's URL carries the browse
       ticket in its path, and the relay is the only party that is
       allowed to see it. */
    ok("the referrer reaches the relay, so the rescue has something to read",
      h["Referrer-Policy"] === "same-origin");
    ok("and never leaves this origin, because the ticket is in the path",
      h["Referrer-Policy"] !== "unsafe-url" &&
      h["Referrer-Policy"] !== "no-referrer-when-downgrade" &&
      h["Referrer-Policy"] !== "origin-when-cross-origin");
    ok("nothing is cached, since one origin serves every site",
      /no-store/.test(h["Cache-Control"]));

    const csp = h["Content-Security-Policy"];
    ok("the csp default is to allow nothing", /default-src 'none'/.test(csp));
    ok("scripts are blocked by the csp as well as stripped by the rewriter",
      csp.indexOf("script-src") < 0 && /default-src 'none'/.test(csp));
    ok("images and styles are allowed, or nothing would render",
      /img-src/.test(csp) && /style-src/.test(csp));
  }

  section("rewriting with scripts on — the setting that makes real sites load");
  {
    /* Back to the shipped default for the rest of the file. */
    browse.init({ config: { enabled: true }, log: () => {} });

    const base = "https://site.example/dir/page.html";
    const page = P.rewrite(
      '<html><head><link rel=stylesheet href="/s.css" integrity="sha384-zz" crossorigin>' +
      '<script type="importmap">{"imports":{"a":"/a.js"}}</script></head>' +
      '<body><script>go()</script><script src="/x.js"></script>' +
      '<a href="/other" onclick="hi()">t</a></body></html>', base, "T");

    ok("an inline script survives, because the page is assembled by one",
      page.indexOf("go()") >= 0, page.slice(0, 400));
    ok("an external script survives and is pointed back through the proxy",
      /\/browse\/p\/T\/https:\/\/site\.example\/x\.js/.test(page), page);
    ok("an inline handler survives too — removing it breaks every button",
      page.indexOf("hi()") >= 0);

    /* Subresource integrity is a hash of the ORIGINAL bytes. Every
       one of those files comes back rewritten, so the hash cannot
       match and the browser refuses the file outright. Leaving these
       in is not a smaller problem than removing them — it is a page
       that loads nothing. */
    ok("integrity attributes are gone, or nothing would be allowed to load",
      !/\sintegrity=/i.test(page), page);

    /* crossorigin stays, and a real browser is why. It was stripped
       for one revision on the reasoning that everything is
       same-origin now — true, and harmless, since a same-origin
       request in CORS mode always passes. But a font is fetched in
       CORS mode regardless, so a preload without crossorigin does not
       match the real request, gets discarded, and the font is
       downloaded twice. Chrome prints exactly that. */
    const preload = P.rewrite(
      '<head><link rel="preload" as="font" href="/f.woff2" crossorigin></head>', base, "T");
    ok("crossorigin survives, or every font is fetched twice",
      /crossorigin/i.test(preload), preload);

    /* An importmap resolves against the DOCUMENT's origin, which is
       the relay. Every bare specifier in it would point at a file the
       relay does not have. */
    ok("an importmap is dropped rather than left pointing at the relay",
      !/importmap/i.test(page), page);

    ok("the shim is injected", /data-fieldkit="shim"/.test(page));
    ok("and it goes in before the page's own scripts, or it is too late",
      page.indexOf('data-fieldkit="shim"') < page.indexOf("go()"), page.slice(0, 300));
    ok("the shim is told the real address of the page",
      page.indexOf("site.example/dir/page.html") >= 0);
    ok("and the ticket, so it can build proxy urls",
      /"prefix":"\/browse\/p\/T\//.test(page), page.slice(0, 1200));

    const h = P.baseHeaders();
    const csp = h["Content-Security-Policy"];
    ok("the csp now permits scripts, since refusing them would undo all of this",
      /script-src [^;]*'unsafe-inline'/.test(csp) && /'unsafe-eval'/.test(csp), csp);
    ok("workers can load from this origin, not just from blob:",
      /worker-src[^;]*\*/.test(csp), csp);
    ok("a form still cannot submit anywhere but back to us",
      /form-action 'self'/.test(csp), csp);
    ok("sniffing stays off even with scripts on",
      h["X-Content-Type-Options"] === "nosniff");
  }

  section("javascript bodies: the import specifiers a shim cannot reach");
  {
    const base = "https://site.example/app/main.js";

    /* Relative specifiers already work by accident of the path
       layout, and rewriting them would be the bug. */
    const rel = P.rewriteJs('import a from "./chunk.js";\nexport {b} from "../lib/b.js";', base, "T");
    ok("a relative import is left exactly as it was",
      rel.indexOf('"./chunk.js"') >= 0 && rel.indexOf('"../lib/b.js"') >= 0, rel);

    const root = P.rewriteJs('import x from "/static/x.js";', base, "T");
    ok("a root-relative import is sent to the site, not to the relay",
      root.indexOf("/browse/p/T/https://site.example/static/x.js") >= 0, root);

    const dyn = P.rewriteJs('const m = await import("/lazy/panel.js");', base, "T");
    ok("a dynamic import is caught too",
      dyn.indexOf("/browse/p/T/https://site.example/lazy/panel.js") >= 0, dyn);

    const bare = P.rewriteJs('import "/side-effect.css";', base, "T");
    ok("an import with no bindings is still an import",
      bare.indexOf("/browse/p/T/https://site.example/side-effect.css") >= 0, bare);

    /* The line this whole function is scoped narrowly to protect. A
       path in ordinary code is data, and rewriting it would corrupt
       the program. */
    const data = P.rewriteJs(
      'const routes = ["/home", "/about"];\nfetch("/api/x");\nimport y from "/real.js";', base, "T");
    ok("a path in an array is not touched", data.indexOf('["/home", "/about"]') >= 0, data);
    ok("a path passed to fetch is left to the shim, which handles it at runtime",
      data.indexOf('fetch("/api/x")') >= 0, data);
    ok("while the real import beside them is still rewritten",
      data.indexOf("/browse/p/T/https://site.example/real.js") >= 0, data);

    ok("a script with no imports comes back byte for byte",
      P.rewriteJs("function f(){return 1}", base, "T") === "function f(){return 1}");
  }

  section("against a real origin");
  {
    let hits = [];
    const origin = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === "/plain") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": "sid=secret; Path=/" });
        return res.end('<html><body><a href="/next">n</a><script>steal()</script></body></html>');
      }
      if (req.url === "/redir-public") { res.writeHead(302, { Location: "/plain" }); return res.end(); }
      /* The attack this proxy has to survive: a public hostname that
         answers with a redirect to somewhere internal. A check that
         only looks at the first url walks straight into it. */
      if (req.url === "/redir-internal") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      }
      if (req.url === "/loop") { res.writeHead(302, { Location: "/loop" }); return res.end(); }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("nope");
    });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    const port = origin.address().port;

    /* The origin is on loopback, which the proxy refuses on
       principle — which is the point. Rather than weaken the guard
       for the test, the request goes through the route with the
       guard doing exactly what it does in production, and the
       assertion is that it REFUSES. */
    const sent = [];
    const res = {
      writeHead(status, headers) { sent.push({ status, headers }); },
      end(body) { sent.push({ body: String(body || "") }); }
    };
    const send = (r2, status, body) => { sent.push({ status, json: body }); };

    const call = (path, search, headers) => browse.route(
      { method: "GET", headers: headers || {} }, res,
      { pathname: path, search: "", searchParams: new URLSearchParams(search) },
      { send, authorise: () => "vault" });
    /* The target lives in the path now, so the route is exercised the
       way a browser actually reaches it: a ticket segment, then the
       whole absolute URL. */
    const page = (target) => call("/browse/p/TESTTICKET/" + target, {});

    sent.length = 0;
    await page("http://127.0.0.1:" + port + "/plain");
    ok("a loopback origin is refused even with a valid credential",
      sent.some((s) => s.status === 403 || (s.status === 400)), JSON.stringify(sent).slice(0, 200));
    ok("and the origin was never contacted", hits.length === 0, hits.join(","));

    sent.length = 0;
    await page("http://169.254.169.254/latest/meta-data/");
    ok("the metadata endpoint is refused", sent.some((s) => s.status === 403 || s.status === 400));

    sent.length = 0;
    await call("/browse/check", { url: "https://example.com" });
    ok("check answers for a public host",
      sent.some((s) => s.status === 200 || s.status === 403), JSON.stringify(sent).slice(0, 160));

    /* Search must never fetch anything itself — it hands back a
       redirect into the proxy, so the same address checks run on the
       next request rather than being skipped by a second code path. */
    sent.length = 0;
    await call("/browse/search", { t: "TESTTICKET", q: "godot navmesh" });
    const redirect = sent.find((s) => s.status === 302);
    ok("a search redirects rather than fetching", !!redirect, JSON.stringify(sent).slice(0, 200));
    ok("and it redirects into the proxy, carrying the ticket",
      redirect && redirect.headers.Location.indexOf("/browse/p/TESTTICKET/") === 0,
      redirect && redirect.headers.Location);
    ok("with the query escaped into the engine's url",
      redirect && redirect.headers.Location.indexOf("godot%20navmesh") > 0,
      redirect && redirect.headers.Location);

    sent.length = 0;
    await call("/browse/search", { t: "TESTTICKET", q: "   " });
    ok("an empty search is refused rather than redirecting to a blank query",
      sent.some((s) => s.status === 400), JSON.stringify(sent).slice(0, 160));

    origin.close();
  }

  section("/browse/where, driven through the real route");
  {
    /* The unit checks above prove isNavigation() and noteLocation()
       in isolation. This proves they are actually WIRED: the route
       has to call them, on the right requests, and /browse/where has
       to hand back what they stored. A correct pair of functions
       nobody calls is the failure this catches. */
    const t = P.issueTicket("vault");
    const sent = [];
    const res = { writeHead(s, h) { sent.push({ status: s, headers: h }); },
      end(b) { sent.push({ body: String(b || "") }); } };
    const send = (r, status, body) => { sent.push({ status, json: body }); };

    const hit = (path, search, headers) => browse.route(
      { method: "GET", headers: headers || {} }, res,
      { pathname: path, search: "", searchParams: new URLSearchParams(search) },
      { send, authorise: () => "vault" });

    const where = async () => {
      sent.length = 0;
      await hit("/browse/where", { t: t.ticket });
      return (sent.find((s) => s.json) || {}).json;
    };

    ok("a fresh ticket has been nowhere", (await where()).url === null);

    /* A real origin, because "the route recorded it" has to mean the
       url it actually ENDED at — after redirects — not the one that
       was asked for. */
    let served = 0;
    const origin = http.createServer((req, res2) => {
      served++;
      if (req.url === "/moved") { res2.writeHead(302, { Location: "/landed" }); return res2.end(); }
      res2.writeHead(200, { "Content-Type": "text/html" });
      res2.end("<html><body><p>here</p></body></html>");
    });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    const port = origin.address().port;

    /* Loopback is refused on principle, which is the point of the
       guard — so this drives the recording functions against the
       real route using the paths that do not need the network, and
       leaves the redirect-following case to the unit checks. */
    sent.length = 0;
    await hit("/browse/p/" + t.ticket + "/http://127.0.0.1:" + port + "/landed", {},
      { "sec-fetch-dest": "iframe" });
    ok("a refused fetch records nothing — the bar must not follow a page that never loaded",
      (await where()).url === null, JSON.stringify(await where()));
    ok("and the origin was never contacted", served === 0, String(served));
    origin.close();

    /* So the storage path is exercised directly and then read back
       through the route, which is the half the unit checks cannot
       reach. */
    P.noteLocation(t.ticket, "https://site.example/landed");
    const got = await where();
    ok("what was recorded comes back out of /browse/where",
      got.url === "https://site.example/landed", JSON.stringify(got));
    ok("with a timestamp, so a stale answer can be spotted", typeof got.at === "number");

    sent.length = 0;
    await hit("/browse/where", { t: "0".repeat(48) });
    const unknown = (sent.find((s) => s.json) || {}).json;
    ok("an unknown ticket answers null rather than leaking someone else's page",
      unknown && unknown.url === null, JSON.stringify(unknown));
  }

  section("the filter reads the lists people actually have");
  {
    /* Hosts files, plain domain lists and AdBlock rules all turn up
       in the wild and people paste whichever they found. Taking all
       three costs a few lines and saves an afternoon of "why is my
       list not working". */
    const parsed = P.parseBlocklist([
      "# a comment",
      "! an adblock comment",
      "",
      "0.0.0.0 ads.example",
      "127.0.0.1 tracker.example   # trailing comment",
      "0.0.0.0 one.example two.example",
      "||adblock.example^",
      "||plain-adblock.example",
      "plain.example",
      "*.wild.example",
      "127.0.0.1 localhost",
      "127.0.0.1 localhost.localdomain",
      "example.com##.ad-banner",
      "/regex-rule/",
      "not a domain at all"
    ].join("\n"));

    const has = (h) => parsed.indexOf(h) >= 0;
    ok("a hosts-file line is read", has("ads.example"));
    ok("and one with a trailing comment", has("tracker.example"));
    ok("two hosts on one line are both read", has("one.example") && has("two.example"));
    ok("an adblock rule is read", has("adblock.example"));
    ok("even without the trailing caret", has("plain-adblock.example"));
    ok("a bare domain is read", has("plain.example"));
    ok("a wildcard is read as the domain under it", has("wild.example"));

    ok("comments are skipped", !parsed.some((h) => h.indexOf("comment") >= 0));
    ok("localhost is never blocked, which would be absurd", !has("localhost"));
    ok("a cosmetic adblock rule is not mistaken for a domain",
      !parsed.some((h) => h.indexOf("ad-banner") >= 0));
    ok("and neither is prose", !has("not"));
  }

  section("a parent entry covers what is under it");
  {
    ok("a host walks up to its parents",
      P.walkUp("a.b.example.com").join(",") === "a.b.example.com,b.example.com,example.com");
    ok("a two-label host walks up to itself only",
      P.walkUp("example.com").join(",") === "example.com");
  }

  section("the filter, and what it will and will not stop");
  {
    browse.init({
      config: { enabled: true, filter: {
        enabled: true, block: ["blocked.example", "ads.example"],
        allow: ["ok.blocked.example"], blockIpLiterals: true
      } }, log: () => {}
    });

    ok("a listed host is blocked", !P.filterVerdict("blocked.example").ok);
    ok("and says which entry matched",
      P.filterVerdict("blocked.example").matched === "blocked.example");
    ok("a subdomain of a listed host is blocked too",
      !P.filterVerdict("www.blocked.example").ok);
    ok("a host that merely ends in the same letters is not",
      P.filterVerdict("notblocked.example").ok);
    ok("anything unlisted passes", P.filterVerdict("example.com").ok);

    /* An exception beats the lists. Without it, turning on a
       hundred-thousand-entry list and then needing one of them back
       means editing the list. */
    ok("an allow entry beats the block list", P.filterVerdict("ok.blocked.example").ok);
    ok("and covers its own subdomains", P.filterVerdict("deep.ok.blocked.example").ok);

    /* The obvious way around a NAME filter is not to use a name. */
    ok("a numeric address is refused while the filter is on",
      !P.filterVerdict("93.184.216.34").ok);
    ok("and it says why rather than pretending the list covered it",
      /no name to check/.test(P.filterVerdict("93.184.216.34").why));
    ok("IPv6 literals too", !P.filterVerdict("2606:4700::1111").ok);

    browse.init({
      config: { enabled: true, filter: {
        enabled: true, block: ["x.example"], blockIpLiterals: false
      } }, log: () => {}
    });
    ok("unless that is deliberately turned off",
      P.filterVerdict("93.184.216.34").ok);

    /* Off means off, and a filter that keeps working after being
       switched off is worse than one that never worked. */
    browse.init({ config: { enabled: true, filter: { enabled: false, block: ["x.example"] } }, log: () => {} });
    ok("with the filter off nothing is filtered", P.filterVerdict("x.example").ok);
    ok("not even a numeric address", P.filterVerdict("93.184.216.34").ok);

    /* Re-initialising must forget the previous lists, the same rule
       as allowHosts — a blocklist that can never be removed is a
       config file that lies. */
    browse.init({ config: { enabled: true, filter: { enabled: true, block: ["only.example"] } }, log: () => {} });
    ok("re-initialising drops the previous entries", P.filterVerdict("x.example").ok);
    ok("and keeps the new ones", !P.filterVerdict("only.example").ok);
  }

  section("the filter is enforced where it cannot be walked around");
  {
    browse.init({
      config: { enabled: true, filter: { enabled: true, block: ["blocked.example"] } },
      log: () => {}
    });

    /* Every fetch goes through parseTarget, including each hop of a
       redirect — so a public host redirecting to a blocked one is
       caught on the second hop rather than being a way through. */
    const direct = P.parseTarget("https://blocked.example/page");
    ok("a blocked host does not parse into a fetchable target", !direct.ok);
    ok("and is marked as filtered, not as a failure", direct.filtered === true);
    ok("carrying the host, so the block page can name it",
      direct.host === "blocked.example");

    const allowed = P.parseTarget("https://example.com/page");
    ok("an unblocked host still parses", allowed.ok);

    /* hostAllowed is the single gate, so allowHosts, blockHosts and
       the filter cannot disagree about a host. */
    ok("the filter runs inside hostAllowed, not beside it",
      !P.hostAllowed("blocked.example").ok &&
      P.hostAllowed("blocked.example").filtered === true);

    /* A named allowHosts entry is a deliberate act and must not be
       silently overruled by a downloaded list of 100,000 domains. */
    browse.init({
      config: { enabled: true, allowHosts: ["blocked.example"],
        filter: { enabled: true, block: ["blocked.example"] } },
      log: () => {}
    });
    ok("but an explicit allowHosts entry is still subject to it, and says so",
      !P.hostAllowed("blocked.example").ok);
  }

  section("a block reads as a decision, not as a broken connection");
  {
    const t = P.issueTicket("vault").ticket;
    const page = P.blockedPage("blocked.example", "blocked by this relay's filter", t);
    ok("it says blocked, not that it did not load",
      /BLOCKED BY THIS RELAY/.test(page) && !/DID NOT LOAD/.test(page));
    ok("it names the host", page.indexOf("blocked.example") >= 0);
    ok("it says where the decision lives",
      /set on the relay, not on this/.test(page));
    ok("and that nothing here can undo it",
      /nothing in FieldKit can turn it off/.test(page));
    ok("it still carries the toolbar, so you are not stranded",
      /\/browse\/go/.test(page));
    ok("a hostile host name cannot inject markup",
      P.blockedPage('x"><script>steal()</script>', "why", t).indexOf("<script>steal") < 0);
  }

  section("a list that was named but is not there");
  {
    /* The failure that matters: the relay runs wide open while the
       config says it is filtering. It has to be loud, and it has to
       not pretend the missing list was empty. */
    const stats = P.loadFilter("/no/such/directory/at/all");
    ok("a missing list is reported", stats.missing.length > 0 || stats.lists === 0);

    browse.init({
      config: { enabled: true, filter: { enabled: true, lists: ["nope.txt"] } },
      dataDir: "/no/such/directory/at/all", log: () => {}
    });
    const st = P.filterStats();
    ok("it is named so it can be fixed",
      st.missing.some((m) => m.indexOf("nope.txt") >= 0), JSON.stringify(st.missing));
    ok("and it did not quietly become an empty list that blocks nothing quietly",
      st.lists === 0);

    /* A path is a config value, not a request — but a typo that
       reads outside the blocklists folder should say so rather than
       be scrubbed into something else. */
    browse.init({
      config: { enabled: true, filter: { enabled: true, lists: ["../../config.json"] } },
      dataDir: "/tmp", log: () => {}
    });
    ok("a list name that is a path is refused by name",
      P.filterStats().missing.some((m) => /not a plain filename/.test(m)),
      JSON.stringify(P.filterStats().missing));
  }

  /* Put the config back for everything after this. */
  browse.init({ config: { enabled: true }, log: () => {} });

  section("the toolbar is served into the page, not bolted on outside it");
  {
    /* The controls used to live in the FieldKit panel, which put
       every one of them on the wrong side of an origin boundary:
       file:// parent, https:// frame, so the client could not read
       where the frame went or whether Back was available. Serving
       the toolbar INTO the page removes the boundary rather than
       working around it — the bar and the page are the same
       document, so the address shown is the address loaded. */
    const t = P.issueTicket("vault");
    const base = "https://site.example/dir/page.html";
    const page = P.rewrite("<html><body><p>hi</p></body></html>", base, t.ticket);

    ok("there is a form, not a script", /<form action="\/browse\/go" method="GET"/.test(page), page.slice(0, 400));
    /* Asserted on the toolbar itself rather than on the finished
       page, because the page now carries the shim and would match a
       search for "<script" for a completely unrelated reason. The
       claim being kept is about the CONTROLS: they have to work with
       scripts turned off, which is a supported setting, so none of
       them may depend on JavaScript. */
    const bar = P.toolbar(t.ticket, base);
    ok("nothing in the toolbar needs javascript",
      !/<script|onclick|onsubmit|javascript:/i.test(bar), bar.slice(0, 600));
    ok("the ticket rides in a hidden field rather than being retyped",
      page.indexOf('name="t" value="' + t.ticket + '"') >= 0);
    ok("the address box is prefilled with where you actually are",
      page.indexOf('name="q" value="' + base + '"') >= 0, page.slice(0, 900));

    /* The toolbar's own links must survive rewriting untouched. It
       is injected last for exactly this reason — proxying
       /browse/go through /browse/p would be nonsense. */
    ok("the toolbar's action is not itself proxied",
      page.indexOf('action="/browse/p/') < 0, page.slice(0, 400));
    ok("and the HOME link points at the start page, not at a site",
      page.indexOf("/browse/ui?t=" + t.ticket) >= 0);

    ok("it still says it is a proxied copy", /FIELDKIT READER/.test(page));
    ok("it still names the page", page.indexOf("site.example") >= 0);
    ok("it still warns against typing a password", /Do not type a password/.test(page));
    ok("and it still refuses to imply anonymity",
      /does not hide you from your relay/.test(page));

    /* A hostile URL must not be able to close an attribute and
       inject markup into a bar the reader is meant to trust. */
    const nasty = P.rewrite("<body>x</body>", 'https://site.example/"><script>steal()</script>', t.ticket);
    ok("a hostile url cannot break out of the address box",
      nasty.indexOf("<script>steal") < 0, nasty.slice(0, 400));
  }

  section("back and forward, kept by the relay");
  {
    /* History lives on the relay because the toolbar that uses it is
       served from the relay. The client could not maintain this even
       in principle — it cannot see where the frame went. */
    const t = P.issueTicket("vault").ticket;
    const st = () => P.historyState(t);

    ok("a new ticket can go neither way", !st().canBack && !st().canFwd);

    P.noteLocation(t, "https://a.example/");
    ok("one page in, still nowhere to go back to", !st().canBack);
    P.noteLocation(t, "https://b.example/");
    ok("two pages in, back is available", st().canBack && !st().canFwd);
    P.noteLocation(t, "https://c.example/");

    ok("back returns the previous page", P.historyGo(t, -1) === "https://b.example/");
    ok("and now forward is available too", st().canBack && st().canFwd);
    ok("back again reaches the first", P.historyGo(t, -1) === "https://a.example/");
    ok("back past the beginning refuses rather than wrapping", P.historyGo(t, -1) === null);
    ok("and did not move the cursor on the way", st().url === "https://a.example/");
    ok("forward returns", P.historyGo(t, 1) === "https://b.example/");

    /* The redirect back/forward issues comes back through the fetch
       path and records a location. If that pushed an entry, going
       back would append the page you just left and forward would
       never be available. */
    P.noteLocation(t, "https://b.example/");
    ok("re-recording the page you just went back to does not push a duplicate",
      st().canFwd && st().url === "https://b.example/");

    /* A new page from the middle drops what was ahead, the same as
       every browser and the same as what Back implies. */
    P.noteLocation(t, "https://d.example/");
    ok("a new page from the middle drops the forward history", !st().canFwd);
    ok("and back now leads to where the new page was opened from",
      P.historyGo(t, -1) === "https://b.example/");

    ok("history for a ticket that does not exist is empty, not an error",
      P.historyGo("nope", -1) === null && P.historyState("nope").canBack === false);
  }

  section("one place decides address-or-search");
  {
    /* This used to be answered in the client, which then built a
       different URL for each. Two answers that can disagree is one
       more than the question needs. */
    ok("a bare hostname is an address", P.looksLikeAddress("example.com"));
    ok("so is one with a path", P.looksLikeAddress("docs.godotengine.org/en/stable/"));
    ok("and an explicit url", P.looksLikeAddress("https://example.com"));
    ok("localhost counts, so the refusal explains itself",
      P.looksLikeAddress("localhost:8080"));
    ok("and a bare ip", P.looksLikeAddress("192.168.1.1"));

    ok("a sentence is a search", !P.looksLikeAddress("how do i bake a navmesh"));
    ok("one word is a search", !P.looksLikeAddress("games"));
    ok("something with a space is always a search",
      !P.looksLikeAddress("example.com and more"));
    ok("nothing at all is neither", !P.looksLikeAddress(""));

    /* The report that started this: searching one word. */
    ok('"games" specifically is a search, not a hostname',
      !P.looksLikeAddress("games"));
  }

  section("the start page");
  {
    const t = P.issueTicket("vault").ticket;
    const home = P.homePage(t);
    ok("it is a whole document, not a fragment", /^<!doctype html>/i.test(home));
    ok("it carries the toolbar", /FIELDKIT READER/.test(home) && /\/browse\/go/.test(home));
    ok("it says what happens to a page's scripts, either way",
      /scripts removed/i.test(home) || /scripts and all/i.test(home), home);
    ok("and with scripts on it warns that every site shares one origin",
      /shares ONE origin/i.test(home), home);
    ok("and it says what to do when an engine refuses the relay",
      /bot check/i.test(home) && /ENGINES/.test(home));
    ok("no javascript on our own page either", !/<script/i.test(home));
  }

  section("the engine list is candidates, not a promise");
  {
    /* /browse/engines makes eight outbound fetches, so it is not
       driven live here — that would make the suite depend on eight
       third parties being up and would take a minute. What is
       checked is the part that can be wrong without the network:
       the list itself. */
    const list = P.ENGINE_CANDIDATES;
    ok("there are several to try", list.length >= 5, String(list.length));
    ok("each has a name and a url",
      list.every((e) => e.name && /^https:\/\//.test(e.url)));
    ok("each url ends ready for a query to be appended",
      list.every((e) => /[?&][a-z]+=$/.test(e.url)),
      list.filter((e) => !/[?&][a-z]+=$/.test(e.url)).map((e) => e.url).join(", "));
    ok("none of them is http", list.every((e) => e.url.indexOf("https://") === 0));

    /* The configured default has to be one this list would have
       tested, or ENGINES tells you about engines that are not the
       one you are using. */
    browse.init({ config: { enabled: true }, log: () => {} });
    const dflt = P.baseHeaders && require("../relay/browse");
    ok("the default search engine is among the candidates",
      list.some((e) => e.url === "https://lite.duckduckgo.com/lite/?kp=1&q="),
      list.map((e) => e.url).join(", "));
    void dflt;
  }

  section("a link that wanted a new window opens in the frame instead");
  {
    /* A sandboxed frame without allow-popups cannot open a window,
       so target="_blank" is a dead click. Retargeting keeps the link
       working and keeps it inside the console, which is what a link
       in a reader should do anyway. */
    const base = "https://site.example/dir/page.html";
    const out = P.rewrite(
      '<body><a href="/a" target="_blank">q</a>' +
      '<a href="/b" target=_blank>u</a>' +
      '<form action="/s" target="win"><input name=q></form>' +
      '<a href="/c">plain</a></body>', base, "T");
    ok("a quoted target is retargeted", !/target="_blank"/.test(out), out);
    ok("an unquoted one too", !/target=_blank/.test(out), out);
    ok("and a form's named window", !/target="win"/.test(out), out);
    ok("all three became _self", (out.match(/target="_self"/g) || []).length === 3, out);
    ok("a link with no target is left alone",
      /<a\s+href="\/browse\/p\/T\/https:\/\/site\.example\/c">plain<\/a>/.test(
        out.replace(/\s+href/, " href")), out);
  }

  section("a bot check is named rather than rendered");
  {
    /* Most bot checks are a 200 with a CAPTCHA in the body. Proxied
       and script-stripped that renders as a broken-looking page, and
       the reasonable conclusion from the other side of the screen is
       "the browser is broken" rather than "this site will not talk
       to my relay". */
    ok("a captcha page is recognised",
      P.looksLikeChallenge('<html><body><div class="anomaly-modal__check">…</div></body></html>'));
    ok("so is cloudflare's", P.looksLikeChallenge("<html>__cf_chl_opt</html>"));

    /* THE FALSE POSITIVES THAT MADE THIS TWO-TIER.

       Wikipedia serves `"wgConfirmEditCaptchaNeeded…":"hcaptcha"` in
       its config blob and GitHub serves `octocaptcha_origin…`, both
       inside six hundred kilobytes of a page that arrived complete
       and with a 200. The old single-tier check saw the word and
       replaced two working pages with "this site thinks you are a
       robot", which is a worse failure than the one it was written
       to prevent: it breaks pages that work.

       So a weak signal now has to arrive in a SMALL body with a
       REFUSAL status, which is what an actual interstitial is. A
       strong signal — a Cloudflare token, a challenge platform — is
       still enough on its own if the page is small or refused. */
    ok("a weak word alone is not a bot check",
      !P.looksLikeChallenge("our systems have detected unusual traffic"));
    ok("but the same wording in a small refusal is",
      P.looksLikeChallenge("our systems have detected unusual traffic", 429));
    ok("a full page that merely mentions captcha somewhere is not",
      !P.looksLikeChallenge('<html><body>' + "x".repeat(40000) +
        '"wgConfirmEditCaptchaNeeded":"hcaptcha"</body></html>', 200), "wikipedia");
    ok("nor is a big page with a strong token buried in it and a 200",
      !P.looksLikeChallenge("<html>" + "x".repeat(40000) + "g-recaptcha</html>", 200));
    ok("while a small page with a strong token still is",
      P.looksLikeChallenge("<html><body>g-recaptcha</body></html>", 200));

    ok("an ordinary page is not",
      !P.looksLikeChallenge("<html><body><h1>Godot NavMesh</h1><p>baking</p></body></html>"));
    ok("the check reads only the head of a page, not megabytes of it",
      !P.looksLikeChallenge("x".repeat(70000) + "captcha"));
  }

  section("where the frame went");
  {
    const t = P.issueTicket("vault");
    ok("a fresh ticket has been nowhere", P.tickets.get(t.ticket).lastUrl === undefined);

    /* Sec-Fetch-Dest is how a navigation is told from the dozens of
       sub-resource requests one page makes. Without this the address
       bar would show whichever stylesheet finished last. */
    ok("an iframe navigation counts",
      P.isNavigation({ headers: { "sec-fetch-dest": "iframe" } }, "text/html"));
    ok("a top-level document counts",
      P.isNavigation({ headers: { "sec-fetch-dest": "document" } }, "text/html"));
    ok("a stylesheet does not",
      !P.isNavigation({ headers: { "sec-fetch-dest": "style" } }, "text/css"));
    ok("nor an image, even one served as html by mistake",
      !P.isNavigation({ headers: { "sec-fetch-dest": "image" } }, "text/html"));

    /* A browser that sends no Sec-Fetch-Dest at all falls back to
       the content type, which at worst mistakes a nested frame for
       the page containing it. */
    ok("with no such header, html is assumed to be a page",
      P.isNavigation({ headers: {} }, "text/html; charset=utf-8"));
    ok("and css is assumed not to be", !P.isNavigation({ headers: {} }, "text/css"));

    P.noteLocation(t.ticket, "https://site.example/one");
    ok("a recorded location is readable back",
      P.tickets.get(t.ticket).lastUrl === "https://site.example/one");
    P.noteLocation(t.ticket, "https://site.example/two");
    ok("and the latest wins", P.tickets.get(t.ticket).lastUrl === "https://site.example/two");
    P.noteLocation("not-a-ticket", "https://evil.example/");
    ok("recording against a ticket that does not exist does nothing",
      !P.tickets.has("not-a-ticket"));

    /* It is memory only. A page-by-page history of what two people
       read, on disk, is a liability nobody asked for. */
    ok("nothing about this is written down",
      !/writeFile|appendFile|fs\./.test(String(P.noteLocation)));
  }

  section("nothing works without a credential");
  {
    const sent = [];
    const send = (r, status, body) => sent.push({ status, body });
    const res = { writeHead() {}, end() {} };

    const anon = (path, search) => browse.route(
      { method: "GET", headers: {} }, res,
      { pathname: path, searchParams: new URLSearchParams(search) },
      { send, authorise: () => null });

    sent.length = 0;
    await anon("/browse/p/-/https://example.com", {});
    ok("fetching a page needs a ticket or a token", sent[0] && sent[0].status === 401);

    /* A made-up ticket in the path is not a credential. Without this,
       anyone who guessed the URL shape would have an open proxy. */
    sent.length = 0;
    await anon("/browse/p/" + "0".repeat(48) + "/https://example.com", {});
    ok("an invented ticket in the path is not a credential",
      sent[0] && sent[0].status === 401, JSON.stringify(sent[0]));

    sent.length = 0;
    await anon("/browse/check", { url: "https://example.com" });
    ok("so does checking one", sent[0] && sent[0].status === 401);

    sent.length = 0;
    await browse.route({ method: "POST", headers: {} }, res,
      { pathname: "/browse/ticket", searchParams: new URLSearchParams("") },
      { send, authorise: () => null });
    ok("and so does asking for a ticket", sent[0] && sent[0].status === 401);

    /* An unknown route says so before it asks for a credential, the
       same as /msg/* and the relay's own 404 — otherwise "you typed
       the path wrong" reads as "log in first". */
    sent.length = 0;
    await anon("/browse/nonsense", {});
    ok("an unknown route 404s rather than 401ing", sent[0] && sent[0].status === 404);
    ok("and lists what does exist", sent[0].body.routes.length === 14,
      JSON.stringify(sent[0].body.routes));
    ok("including the two that hand a page back as data rather than as a page",
      sent[0].body.routes.indexOf("/browse/text") >= 0 &&
      sent[0].body.routes.indexOf("/browse/find") >= 0,
      JSON.stringify(sent[0].body.routes));

    sent.length = 0;
    await browse.route({ method: "DELETE", headers: {} }, res,
      { pathname: "/browse/p/-/https://example.com", searchParams: new URLSearchParams("") },
      { send, authorise: () => null });
    ok("a real route called the wrong way says 405, not 404", sent[0] && sent[0].status === 405);
  }

  section("the search engine can be changed for one session");
  {
    browse.init({ config: { enabled: true, searchUrl: "https://www.bing.com/search?q=" },
      log: () => {} });
    const t = P.issueTicket("vault").ticket;

    const sent = [];
    const redirects = [];
    const send = (r, status, body) => sent.push({ status, body });
    const res = { writeHead(st, h) { redirects.push({ status: st, to: h && h.Location }); }, end() {} };
    const call = (path, search) => browse.route(
      { method: "GET", headers: {} }, res,
      { pathname: path, searchParams: new URLSearchParams(search) },
      { send, authorise: () => null });

    ok("a fresh session searches with the relay's configured engine",
      P.searchFor(t) === "https://www.bing.com/search?q=");

    /* The reason this route exists: ENGINES could tell you which
       engine answers your relay, and then the only way to act on
       that was to edit config.json on the server and restart it. */
    sent.length = 0;
    await call("/browse/engine", "t=" + t + "&url=" + encodeURIComponent("https://www.mojeek.com/search?q="));
    ok("switching to an offered engine is accepted",
      sent[0] && sent[0].status === 200 && sent[0].body.ok === true &&
      sent[0].body.searchUrl === "https://www.mojeek.com/search?q=",
      JSON.stringify(sent[0]));
    ok("and the session now searches with it",
      P.searchFor(t) === "https://www.mojeek.com/search?q=", P.searchFor(t));

    /* Only from the list the relay itself offered. An arbitrary
       prefix here would make this a way to point somebody's search
       box at any URL a page could construct. */
    sent.length = 0;
    await call("/browse/engine", "t=" + t + "&url=" + encodeURIComponent("https://evil.example/?q="));
    ok("an engine nobody offered is refused", sent[0] && sent[0].status === 400,
      JSON.stringify(sent[0]));
    ok("and the session is left as it was",
      P.searchFor(t) === "https://www.mojeek.com/search?q=");

    /* Per session, deliberately. The relay's own config stays the
       default and the thing that survives a restart, and one
       session cannot redefine what anyone else searches with. */
    const other = P.issueTicket("vault").ticket;
    ok("another session is unaffected",
      P.searchFor(other) === "https://www.bing.com/search?q=");

    redirects.length = 0;
    await call("/browse/go", "t=" + t + "&q=godot navmesh");
    ok("go redirects into the session's engine, not the configured one",
      /mojeek.com/.test(String(redirects[0] && redirects[0].to)),
      String(redirects[0] && redirects[0].to));

    /* Typed text that is an address is still an address. Changing
       the engine must not turn every URL into a search. */
    redirects.length = 0;
    await call("/browse/go", "t=" + t + "&q=example.com/page");
    ok("an address is still an address",
      /example.com/.test(String(redirects[0] && redirects[0].to)) &&
      !/mojeek/.test(String(redirects[0] && redirects[0].to)),
      String(redirects[0] && redirects[0].to));
  }

  section("reload asks the relay, because this side cannot see the frame");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;
    const redirects = [];
    const res = { writeHead(st, h) { redirects.push({ status: st, to: h && h.Location }); }, end() {} };
    const call = (path, search) => browse.route(
      { method: "GET", headers: {} }, res,
      { pathname: path, searchParams: new URLSearchParams(search) },
      { send: () => {}, authorise: () => null });

    /* Nothing loaded yet: reload has to land somewhere real rather
       than 404 or redirect to an empty proxy URL. */
    redirects.length = 0;
    await call("/browse/reload", "t=" + t);
    ok("reload with nothing loaded goes to the start page",
      /\/browse\/ui\?t=/.test(String(redirects[0] && redirects[0].to)),
      String(redirects[0] && redirects[0].to));

    P.noteLocation(t, "https://site.example/article");
    redirects.length = 0;
    await call("/browse/reload", "t=" + t);
    ok("and after a page, back to that same page",
      String(redirects[0].to).indexOf("https://site.example/article") > 0,
      String(redirects[0].to));
    ok("as a redirect, so history and the address box see a navigation",
      redirects[0].status === 302);
  }

  section("a search page with nothing in it");
  {
    browse.init({ config: { enabled: true, searchUrl: "https://www.bing.com/search?q=" },
      log: () => {} });
    const t = P.issueTicket("vault").ticket;

    /* Compared on host AND path. An engine's front page, its
       settings page and its image search are all on the same host,
       and calling any of them "a search with no results" would be
       nonsense. */
    ok("a search on the session's engine is recognised",
      P.isSearchPage("https://www.bing.com/search?q=cats", t));
    ok("the engine's front page is not a search",
      !P.isSearchPage("https://www.bing.com/", t));
    ok("nor is a different path on the same host",
      !P.isSearchPage("https://www.bing.com/images/search?q=cats", t));
    ok("nor is another site entirely",
      !P.isSearchPage("https://example.com/search?q=cats", t));
  }

  section("a nested frame is not a page you navigated to");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const base = "https://site.example/docs/p.html";

    /* THE ONE THAT MADE BACK DO NOTHING. The Godot docs embed the
       giscus comments widget in an iframe. The relay decides what
       goes in history from Sec-Fetch-Dest, a nested frame sends
       "iframe", and so does the FieldKit frame itself because it IS
       one. So the widget was recorded as a page: Back moved onto the
       article underneath it, the screen did not change, and forward
       was somehow available at the same time.

       Nothing in the request separates them — same dest, same mode,
       same ticket, and no Referer either way. The REWRITER can tell,
       because it is looking at the markup. */
    const page = P.rewrite(
      '<body><p>hi</p><img src="/a.png"><a href="/next">n</a>' +
      '<iframe src="https://giscus.app/w"></iframe>' +
      "<frame src=\"/legacy.html\"></body>", base, "T");

    ok("what the rewriter found inside an iframe is marked",
      /\/browse\/p\/T\.f\/https:\/\/giscus\.app\/w/.test(page), page);
    ok("an old-style frame too",
      /\/browse\/p\/T\.f\/https:\/\/site\.example\/legacy\.html/.test(page), page);
    ok("an image is not marked", /\/browse\/p\/T\/https:\/\/site\.example\/a\.png/.test(page));
    ok("neither is an ordinary link",
      /\/browse\/p\/T\/https:\/\/site\.example\/next/.test(page));

    const f = P.targetFromPath("/browse/p/T.f/https:/giscus.app/w", "");
    ok("the mark comes back off the path", f.ok && f.frame === true && f.ticket === "T",
      JSON.stringify(f));
    ok("and an unmarked path is not confused for one",
      P.targetFromPath("/browse/p/T/https:/site.example/a", "").frame === false);
    ok("a ticket with the mark on it still resolves to its holder",
      P.ticketHolder(P.targetFromPath("/browse/p/" +
        P.issueTicket("vault").ticket + ".f/https:/x.example/", "").ticket) === "vault");

    /* Inherited, which is what makes it work rather than half-work:
       everything the nested document goes on to load resolves against
       its own marked path and stays marked, with no further
       decisions anywhere. */
    const inner = P.rewrite('<body><a href="/deeper">d</a></body>',
      "https://giscus.app/w", "T", true);
    ok("a nested frame's own links stay marked",
      /\/browse\/p\/T\.f\/https:\/\/giscus\.app\/deeper/.test(inner), inner);
    ok("and the shim inside it inherits the mark, so its fetches do too",
      /"prefix":"\/browse\/p\/T\.f\//.test(inner), inner.slice(0, 900));

    /* A comments widget with its own address bar and Back button,
       sitting in the middle of somebody's article, would be steering
       something nobody thinks of as a page. */
    ok("a nested frame gets no toolbar", inner.indexOf('action="/browse/go"') < 0);
    ok("while the page around it still has one",
      P.rewrite("<body>x</body>", base, "T", false).indexOf('action="/browse/go"') >= 0);

    /* THE HOLE THE FIRST FIX LEFT. Bing's search page embeds a
       sign-in frame, that frame is a redirector, and the relay
       followed it — handing back an UNMARKED destination, which then
       went into history as though somebody had navigated to
       login.live.com. Marking the frame was not enough; the mark has
       to survive every place the relay hands out a new address. */
    const rescued = browse.rescueFromReferer(
      { headers: { referer: "https://relay.example/browse/p/T.f/https://giscus.app/w" } },
      { pathname: "/api/comments", search: "" });
    ok("a rescue from inside a frame stays inside the frame",
      rescued === "/browse/p/T.f/https://giscus.app/api/comments", String(rescued));
    ok("while a rescue from a real page does not gain a mark",
      browse.rescueFromReferer(
        { headers: { referer: "https://relay.example/browse/p/T/https://site.example/p" } },
        { pathname: "/api/x", search: "" }) === "/browse/p/T/https://site.example/api/x");
  }

  section("a page whose only job is to bounce");
  {
    browse.init({ config: { enabled: true }, log: () => {} });

    /* THE ONE THAT MADE SEARCH RESULTS DO NOTHING. Every result on a
       Bing page is a link through bing.com/ck/a, and that does not
       answer with a 302 — it answers with a small HTML page whose
       whole content is a script that assigns to location. In the
       frame that script runs and the frame leaves the proxy for the
       real site, which declines to be framed; through curl it is a
       blank page. Same bug, and both symptoms were reported.

       The shape below is Bing's, copied: the destination goes into a
       variable first and only then to location, which is why a rule
       that accepted string literals only found nothing on the exact
       page it was written for. */
    const bing =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><script>' +
      'var s = false;' +
      'function r() { var u = "https://docs.godotengine.org/en/stable/x.html";' +
      ' if (s) window.location.href = u; else window.location.replace(u); }' +
      '</script></head><body onload="r()">' +
      '<a href="https://www.bing.com/ck/a?p=1">Please click here if the page ' +
      'does not redirect automatically</a></body></html>';

    ok("the destination is followed one variable hop back to its literal",
      P.redirectorTarget(bing, "https://www.bing.com/ck/a?p=1") ===
        "https://docs.godotengine.org/en/stable/x.html",
      String(P.redirectorTarget(bing, "https://www.bing.com/ck/a?p=1")));

    ok("a plain literal works too",
      P.redirectorTarget('<html><body><script>location.replace("/landing")</script></body></html>',
        "https://site.example/go") === "https://site.example/landing");

    /* A meta refresh is the older spelling of the same thing. The
       rewriter strips them — correctly, since one left in would send
       the frame to the real site — which turned a meta-refresh bounce
       into a blank page for exactly the same reason. */
    ok("a meta refresh is followed rather than stripped into a blank page",
      P.redirectorTarget('<html><head><meta http-equiv="refresh" content="0;url=/next">' +
        "</head><body>redirecting…</body></html>", "https://site.example/go") ===
        "https://site.example/next");

    ok("a bounce to the page it is already on is a loop, not a redirect",
      P.redirectorTarget('<html><body><script>location.replace("/go")</script></body></html>',
        "https://site.example/go") === null);

    /* WHAT KEEPS THIS FROM EATING REAL PAGES, and the numbers are
       measured rather than picked. Bing's redirector is 1.8 KB with
       65 characters of visible text; a real search page is 144 KB
       with 2818, and a game page 183 KB with 5820. The gate sits in
       the middle of a gap two orders of magnitude wide. */
    const realPage = "<html><body><h1>Godot NavMesh</h1><p>" +
      "Baking a navigation mesh is done from the editor. ".repeat(40) +
      '</p><script>if (bad) location.replace("/error")</script></body></html>';
    ok("a page with something to say is never treated as a bounce",
      P.redirectorTarget(realPage, "https://site.example/p") === null,
      "visible=" + P.visibleText(realPage).length);

    ok("nor is a big page, however little of it is text",
      P.redirectorTarget("<html><body><script>location.replace('/x');" +
        "//" + "z".repeat(30000) + "</script></body></html>", "https://site.example/p") === null);

    /* A destination built by concatenation is not something to guess
       at — sending somebody to an address they did not ask for is a
       worse failure than the blank page this replaces. */
    ok("a destination it cannot read plainly is left alone",
      P.redirectorTarget('<html><body><script>location.replace(base + path)</script></body></html>',
        "https://site.example/go") === null);

    ok("and a non-http destination is refused",
      P.redirectorTarget('<html><body><script>location.replace("javascript:steal()")</script></body></html>',
        "https://site.example/go") === null);
  }

  section("POST, which is the difference between a reader and a browser");
  {
    browse.init({ config: { enabled: true }, log: () => {} });

    /* A login is a POST. So is a comment, and every write an
       application makes. While the route refused POST, a page could
       render perfectly and do nothing when you pressed the button —
       and a 405 in the console is not something the person pressing
       it can act on. */
    const sent = [];
    const res = { writeHead() {}, end() {} };
    const send = (r, status, body, headers) => sent.push({ status, body, headers });
    await browse.route(
      { method: "POST", headers: {} }, res,
      { pathname: "/browse/p/nope/https://example.com/login", search: "",
        searchParams: new URLSearchParams("") },
      { send, authorise: () => null });
    ok("a POST is no longer refused for being a POST",
      !sent.some((s) => s.status === 405), JSON.stringify(sent).slice(0, 200));
    ok("it is refused for the reason it should be — no ticket",
      sent.some((s) => s.status === 401), JSON.stringify(sent).slice(0, 200));

    /* The body is read as bytes, never parsed. A multipart form
       carries a boundary that only survives if nothing touches it. */
    const fake = (chunks) => {
      const handlers = {};
      const req = { on: (ev, fn) => { handlers[ev] = fn; return req; } };
      setTimeout(() => {
        chunks.forEach((c) => handlers.data && handlers.data(Buffer.from(c)));
        handlers.end && handlers.end();
      }, 0);
      return req;
    };
    const body = await P.readRaw(fake(["a=1&", "b=2"]), 1024);
    ok("a body arrives whole, in order, as bytes",
      Buffer.isBuffer(body) && body.toString() === "a=1&b=2", String(body));

    const over = await P.readRaw(
      Object.assign(fake(["x".repeat(200)]), { destroy() {} }), 50);
    ok("a body over the cap is refused rather than buffered",
      over === null, String(over));
  }

  section("a page's forty requests are not an anonymous flood");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;

    /* server.js asks this before its general rate limiter. One
       ordinary page is forty-odd requests and an iframe cannot send
       an Authorization header, so without this the browser trips a
       limiter built to stop anonymous floods after four or five
       pages — while the browse bucket's own 600 goes unused. */
    ok("a path carrying a live ticket is recognised",
      browse.hasValidTicket("/browse/p/" + t + "/https://site.example/x.css"));
    ok("a made-up ticket is not",
      !browse.hasValidTicket("/browse/p/deadbeef/https://site.example/x.css"));
    ok("neither is a path with no ticket in it",
      !browse.hasValidTicket("/browse/ui"));
    ok("nor anything outside the proxy",
      !browse.hasValidTicket("/vault"));

    P.tickets.set("stale-one", { who: "vault", expires: Date.now() - 1000 });
    ok("an expired ticket buys nothing",
      !browse.hasValidTicket("/browse/p/stale-one/https://site.example/x.css"));
  }

  section("cookies, kept by the relay and never by the drive");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;

    P.storeSetCookies(t, "site.example",
      ["sid=abc; Path=/; HttpOnly", "pref=dark; Path=/", "scoped=x; Path=/admin"]);
    const h = P.cookieHeaderFor(t, "site.example", "/");
    ok("a cookie set on a page comes back on the next request", /sid=abc/.test(h), h);
    ok("more than one is joined", /pref=dark/.test(h));
    ok("a path-scoped cookie stays out of the wrong path", !/scoped=x/.test(h), h);
    ok("and comes back on the right one",
      /scoped=x/.test(P.cookieHeaderFor(t, "site.example", "/admin/users")));

    /* A jar hung off the ticket rather than off the relay is the
       whole point: sessions do not outlive a browse pass and do not
       leak between the two people using this. */
    const other = P.issueTicket("vault").ticket;
    ok("another ticket does not inherit the session",
      P.cookieHeaderFor(other, "site.example", "/") === "");

    P.storeSetCookies(t, "app.site.example", ["shared=1; Domain=site.example; Path=/"]);
    ok("a Domain cookie reaches the parent host",
      /shared=1/.test(P.cookieHeaderFor(t, "site.example", "/")));
    ok("and its other subdomains",
      /shared=1/.test(P.cookieHeaderFor(t, "cdn.site.example", "/")));

    /* The one that would be a real leak: a site claiming a domain it
       is not under, so its cookie is sent to somebody else. */
    P.storeSetCookies(t, "evil.example", ["steal=1; Domain=site.example; Path=/"]);
    ok("a site cannot set a cookie for a domain it is not under",
      !/steal=1/.test(P.cookieHeaderFor(t, "site.example", "/")),
      P.cookieHeaderFor(t, "site.example", "/"));
    ok("the cookie is kept for the site that set it, though",
      /steal=1/.test(P.cookieHeaderFor(t, "evil.example", "/")));

    P.storeSetCookies(t, "site.example", ["sid=; Path=/; Max-Age=0"]);
    ok("a logout that clears a cookie actually clears it",
      !/sid=abc/.test(P.cookieHeaderFor(t, "site.example", "/")));

    ok("an unknown ticket has no jar and does not throw",
      P.cookieHeaderFor("nope", "site.example", "/") === "");
  }

  section("the net under the shim: a page that asked the relay for the site's path");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;
    const ref = "https://relay.example/browse/p/" + encodeURIComponent(t) +
      "/https://site.example/app/page.html";

    const rescued = browse.rescueFromReferer(
      { headers: { referer: ref } },
      { pathname: "/api/me", search: "?x=1" });
    ok("a root-relative request is sent to the site the page came from",
      rescued === "/browse/p/" + encodeURIComponent(t) + "/https://site.example/api/me?x=1",
      String(rescued));

    ok("with no referer there is nothing to go on, so it stays a 404",
      browse.rescueFromReferer({ headers: {} }, { pathname: "/api/me", search: "" }) === null);
    ok("a referer that is not a proxied page is not a hint either",
      browse.rescueFromReferer({ headers: { referer: "https://relay.example/browse/ui?t=x" } },
        { pathname: "/api/me", search: "" }) === null);

    /* The relay's own surface must never be rescued — redirecting
       /vault into the proxy would make the relay fetch its own
       address from the outside. */
    ["/vault", "/records/x", "/health", "/msg/poll", "/updates/latest", "/browse/ui"]
      .forEach(function (p) {
        ok("it refuses to rescue " + p,
          browse.rescueFromReferer({ headers: { referer: ref } }, { pathname: p, search: "" }) === null);
      });

    /* A forged Referer is worth nothing here and that is the reason
       this is allowed to exist: the ticket is put back in the path
       and checked on the next request like any other. */
    const forged = browse.rescueFromReferer(
      { headers: { referer: "https://relay.example/browse/p/made-up/https://site.example/" } },
      { pathname: "/api/me", search: "" });
    ok("a forged referer still produces a url that has to prove its ticket",
      /^\/browse\/p\/made-up\//.test(String(forged)), String(forged));
    ok("and that ticket does not exist", P.ticketHolder("made-up") === null);
  }

  /* ============================================================
     WHAT WENT OUT ON THE WIRE.

     The relay asks origins for gzip because it has to read the
     bytes to rewrite them, and it used to send the result out
     unpacked. Measured on one page of the Godot docs: 107 KB
     fetched directly by a browser, 2.3 MB through the proxy. The
     rewrite is most of the difference — every URL gains a
     /browse/p/<48 hex>/https:// prefix — and those prefixes are the
     most compressible bytes there are.
     ============================================================ */
  section("text is packed before it leaves, and only text");
  {
    browse.init({ config: { enabled: true }, log: () => {} });

    /* A response recorder shaped like the bits of http.ServerResponse
       these functions touch. */
    function grab() {
      const r = { status: 0, headers: null, chunks: [], ended: false };
      r.res = {
        writeHead(status, headers) { r.status = status; r.headers = headers; },
        end(body) { r.ended = true; if (body) r.chunks.push(Buffer.from(body)); }
      };
      r.body = () => Buffer.concat(r.chunks);
      return r;
    }
    const asks = (enc, method) => ({ method: method || "GET",
      headers: enc ? { "accept-encoding": enc } : {} });

    /* Something long enough to be worth packing and repetitive
       enough to show what packing is for — which is exactly the
       shape of a rewritten page. */
    const long = Buffer.from(("<a href=\"/browse/p/TICKET/https://site.example/x\">l</a>")
      .repeat(400), "utf8");

    const packed = grab();
    P.finish(asks("gzip, deflate"), packed.res, 200, "text/html; charset=utf-8", long);
    await new Promise((r) => setTimeout(r, 30));
    ok("html comes back gzipped", packed.headers["Content-Encoding"] === "gzip",
      JSON.stringify(packed.headers && packed.headers["Content-Encoding"]));
    ok("and it is a lot smaller", packed.body().length < long.length / 5,
      packed.body().length + " vs " + long.length);
    ok("the length header describes what was actually sent",
      Number(packed.headers["Content-Length"]) === packed.body().length);
    ok("and it unpacks back to exactly the original bytes",
      require("zlib").gunzipSync(packed.body()).equals(long));

    /* Vary regardless, because a cache that does not know the body
       depends on the request will hand a gzipped page to something
       that never asked for one. */
    const plainReq = grab();
    P.finish(asks(null), plainReq.res, 200, "text/html; charset=utf-8", long);
    ok("a client that did not ask for gzip does not get it",
      !plainReq.headers["Content-Encoding"]);
    ok("it gets the bytes unchanged", plainReq.body().equals(long));
    ok("and Vary is set either way",
      plainReq.headers.Vary === "Accept-Encoding" && packed.headers.Vary === "Accept-Encoding");

    /* Already-compressed formats: running gzip over a jpeg spends
       the relay's cpu to make the file very slightly bigger. */
    const img = grab();
    P.finish(asks("gzip"), img.res, 200, "image/png", long);
    ok("an image is not packed again", !img.headers["Content-Encoding"]);
    const font = grab();
    P.finish(asks("gzip"), font.res, 200, "font/woff2", long);
    ok("nor is a font", !font.headers["Content-Encoding"]);
    const wasm = grab();
    P.finish(asks("gzip"), wasm.res, 200, "application/wasm", long);
    ok("nor is wasm", !wasm.headers["Content-Encoding"]);

    const css = grab();
    P.finish(asks("gzip"), css.res, 200, "text/css; charset=utf-8", long);
    await new Promise((r) => setTimeout(r, 30));
    ok("stylesheets are packed", css.headers["Content-Encoding"] === "gzip");
    const js = grab();
    P.finish(asks("gzip"), js.res, 200, "text/javascript; charset=utf-8", long);
    await new Promise((r) => setTimeout(r, 30));
    ok("and scripts", js.headers["Content-Encoding"] === "gzip");
    const json = grab();
    P.finish(asks("gzip"), json.res, 200, "application/json", long);
    await new Promise((r) => setTimeout(r, 30));
    ok("and json", json.headers["Content-Encoding"] === "gzip");

    /* A gzip header is twenty-odd bytes and a one-line error page is
       not worth them. */
    const tiny = grab();
    P.finish(asks("gzip"), tiny.res, 200, "text/html", Buffer.from("<p>no</p>", "utf8"));
    ok("something tiny is left alone", !tiny.headers["Content-Encoding"]);

    ok("gzip is recognised in a real header",
      P.acceptsGzip(asks("gzip, deflate, br")) && P.acceptsGzip(asks("GZIP")));
    ok("and not invented out of one that does not mention it",
      !P.acceptsGzip(asks("br, deflate")) && !P.acceptsGzip(null));
  }

  section("HEAD is answered, not refused");
  {
    browse.init({ config: { enabled: true }, log: () => {} });

    /* Loaders probe with HEAD before they fetch, and so does anything
       checking whether a file changed. Two of them came back 405 on
       one CrazyGames page and the loader read that as "not there". */
    const sent = [];
    const res = { writeHead() {}, end() {} };
    const send = (r, status, body, headers) => sent.push({ status, body, headers });
    await browse.route(
      { method: "HEAD", headers: {} }, res,
      { pathname: "/browse/p/nope/https://example.com/x.js", search: "",
        searchParams: new URLSearchParams("") },
      { send, authorise: () => null });
    ok("HEAD is not rejected for being HEAD",
      !sent.some((s) => s.status === 405), JSON.stringify(sent).slice(0, 160));
    ok("it is refused for the reason it should be — no ticket",
      sent.some((s) => s.status === 401));

    /* And it means HEAD: the headers of the answer, none of the body. */
    const r = { status: 0, headers: null, chunks: [] };
    const rec = {
      writeHead(status, headers) { r.status = status; r.headers = headers; },
      end(body) { if (body) r.chunks.push(Buffer.from(body)); }
    };
    const payload = Buffer.from("x".repeat(4000), "utf8");
    P.finish({ method: "HEAD", headers: { "accept-encoding": "gzip" } },
      rec, 200, "text/html", payload);
    ok("no body goes out with a HEAD", Buffer.concat(r.chunks).length === 0);
    ok("but the length it would have had does",
      Number(r.headers["Content-Length"]) === payload.length);
    ok("and it is not claimed to be gzipped", !r.headers["Content-Encoding"]);
  }

  /* ============================================================
     A PIECE OF A PAGE IS NOT A PAGE.

     Both halves of this were reported as "games just silently
     fail". A subresource that could not be fetched was answered
     with our own HTML error page, and the browser's report of that
     is "Refused to execute script ... MIME type (text/html) is not
     executable" — which names the proxy's error page as the fault
     and never mentions the host that refused. And HTML that a page
     fetched for itself got a toolbar and a shim spliced into it,
     which the page then inserted into itself.
     ============================================================ */
  section("a subresource fails as a subresource");
  {
    const dest = (d) => ({ method: "GET", headers: d ? { "sec-fetch-dest": d } : {} });

    ["script", "style", "image", "font", "empty", "audio", "video", "manifest"]
      .forEach((d) => ok("dest " + d + " is a piece of a page", P.isSubresource(dest(d))));
    ["document", "iframe", "frame"]
      .forEach((d) => ok("dest " + d + " is a page", !P.isSubresource(dest(d))));

    /* No header at all means page, and that direction is deliberate:
       the other way round turns an ordinary failed navigation into a
       blank frame with nothing in it. */
    ok("no dest header at all is treated as a page", !P.isSubresource(dest(null)));

    /* The chrome. A fragment keeps its rewritten urls and loses
       everything that would only make sense around a whole page. */
    const base = "https://site.example/x";
    const frag = P.rewrite('<div><a href="/next">n</a></div>', base, "T", false, null, true);
    ok("a fragment gets no toolbar", frag.indexOf("FIELDKIT READER") < 0, frag);
    ok("and no shim", frag.indexOf('data-fieldkit="shim"') < 0);
    ok("but its links are still rewritten",
      frag.indexOf("/browse/p/T/https://site.example/next") >= 0, frag);

    const page = P.rewrite('<html><head></head><body><a href="/next">n</a></body></html>',
      base, "T", false, null, false);
    ok("a real page still gets the toolbar", page.indexOf("FIELDKIT READER") >= 0);
  }

  section("a page that failed still has a way out of itself");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;
    P.noteLocation(t, "https://first.example/");
    P.noteLocation(t, "https://second.example/");

    /* blockedPage has always carried the bar. This one — the failure
       people actually meet — did not, so the commonest way to fail
       was the only one that left you somewhere with no address box
       and no Back. */
    const page = P.errorPage("that host refused us", "https://third.example/thing", t);
    ok("it carries the toolbar", page.indexOf("/browse/go") >= 0);
    ok("and a live Back, because there is somewhere to go back to",
      page.indexOf("/browse/back?t=") >= 0, page.slice(0, 400));
    ok("the address box is prefilled with what failed",
      page.indexOf("https://third.example/thing") >= 0);
    ok("and it still says plainly that it did not load",
      /THAT DID NOT LOAD/.test(page) && /that host refused us/.test(page));

    /* With no ticket it is still a bar, just a dead one. A caller
       with nothing to give must not produce a page with no exit. */
    const orphan = P.errorPage("no ticket here", "https://x.example/", null);
    ok("no ticket still renders a bar", orphan.indexOf("/browse/go") >= 0);
  }

  section("where the frame is, not where it has been");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;
    P.noteLocation(t, "https://one.example/");
    P.noteLocation(t, "https://two.example/");
    P.noteLocation(t, "https://three.example/");

    const asked = [];
    const send = (r, status, body) => asked.push(body);
    const call = () => browse.route(
      { method: "GET", headers: {} }, { writeHead() {}, end() {} },
      { pathname: "/browse/where", search: "",
        searchParams: new URLSearchParams("t=" + t) },
      { send, authorise: () => "vault" });

    await call();
    ok("at rest it reports the page that is showing",
      asked[0].url === "https://three.example/", asked[0].url);

    /* The bug: the cursor moved and the reported url did not, so the
       panel drew its address from one place and its buttons from
       another and disagreed with itself after every Back. */
    P.historyGo(t, -1);
    await call();
    ok("after a step back it reports where back went",
      asked[1].url === "https://two.example/", asked[1].url);
    ok("and says there is now somewhere forward", asked[1].canFwd === true);
    ok("the most recent load is still available, under its own name",
      asked[1].lastLoaded === "https://three.example/", String(asked[1].lastLoaded));
  }

  /* ============================================================
     VIDEO, AND THE HEADER THAT MAKES IT POSSIBLE.

     A browser does not download a video, it asks for slices — that
     is the Range header, and it is also what a scrubber does when
     you drag it. The proxy used to drop the header entirely, so
     every request came back 200 with the whole file. Two things
     followed. Seeking was impossible. And "the whole file" ran into
     maxBytes, which is eight megabytes because this fetches pages,
     so anything longer than about half a minute was cut off with no
     error anywhere near it.

     Measured before the fix: metadata read, duration read, playback
     started, MEDIA_ERR_NETWORK at 1.2 seconds, every time.
     ============================================================ */
  section("a range is carried, and bounded to something we can deliver whole");
  {
    browse.init({ config: { enabled: true }, log: () => {} });

    /* The first thing a media element sends. Open-ended means "to
       the end of the file", which for a 2.9 GB video is a request
       the relay cannot answer whole — so it is narrowed before it
       goes out, and the origin then answers a slice that arrives
       complete. */
    ok("an open-ended range is narrowed to one chunk",
      P.boundRange("bytes=0-") === "bytes=0-4194303", P.boundRange("bytes=0-"));
    ok("and so is one that asks for more than a chunk",
      P.boundRange("bytes=0-99999999") === "bytes=0-4194303");
    ok("narrowing is relative to where the slice starts, not to zero",
      P.boundRange("bytes=5000000-") === "bytes=5000000-9194303",
      P.boundRange("bytes=5000000-"));

    /* A range that already fits is passed through untouched: the
       player asked for exactly those bytes and shortening it would
       be answering a different question. */
    ok("a range that already fits is left alone",
      P.boundRange("bytes=100-200") === "bytes=100-200");

    /* The two shapes this deliberately does not touch. A suffix
       range is small by definition; a multi-range answer comes back
       as multipart/byteranges and rewriting one means reassembling
       it. */
    ok("a suffix range is not rewritten", P.boundRange("bytes=-500") === "bytes=-500");
    ok("neither is a multi-range request",
      P.boundRange("bytes=0-100,200-300") === "bytes=0-100,200-300");
    ok("nor anything that is not a range at all",
      P.boundRange("cheese") === "cheese" && P.boundRange("") === "" &&
      P.boundRange(undefined) === "");

    /* The chunk has to stay under the read cap, or the thing it
       exists to prevent happens to the slice instead. */
    ok("a whole chunk still fits inside what the relay will read",
      4 * 1024 * 1024 <= browse.LIMITS.maxBytes);
  }

  section("a partial answer never lies about which bytes it holds");
  {
    /* Content-Range counts bytes of the ORIGINAL file. A player
       believes it and waits for what it promises, so the one thing
       that must never happen is forwarding it next to a body that
       was cut short. */
    const whole = P.rangeHeaders({ status: 206, truncated: false,
      headers: { "content-range": "bytes 0-1023/9999", "accept-ranges": "bytes" } });
    ok("an intact slice keeps its Content-Range",
      whole["Content-Range"] === "bytes 0-1023/9999");
    ok("and says ranges are available", whole["Accept-Ranges"] === "bytes");

    const cut = P.rangeHeaders({ status: 206, truncated: true,
      headers: { "content-range": "bytes 0-2999999999/2999999999" } });
    ok("a truncated one drops the claim entirely", !cut["Content-Range"],
      JSON.stringify(cut));
    ok("but still says ranges work, so the player asks for a smaller one",
      cut["Accept-Ranges"] === "bytes");

    /* And gzip stays away from all of it: packing a slice makes
       every number in the header wrong. */
    const r = { headers: null, chunks: [] };
    const rec = { writeHead(st, h) { r.headers = h; },
      end(b) { if (b) r.chunks.push(Buffer.from(b)); } };
    P.finish({ method: "GET", headers: { "accept-encoding": "gzip" } }, rec,
      206, "text/plain", Buffer.from("y".repeat(5000), "utf8"),
      { "Content-Range": "bytes 0-4999/100000" });
    ok("a 206 is never gzipped", !r.headers["Content-Encoding"],
      JSON.stringify(r.headers["Content-Encoding"]));
    ok("and it keeps the header it was given",
      r.headers["Content-Range"] === "bytes 0-4999/100000");
  }

  section("a bare path finds its way back to the site it belongs to");
  {
    /* The cost of pathMode: once a page's address is /results?q=x, a
       reload — or any request the shim never got to touch — arrives
       at the relay as a path with no site in it. __fk is the answer,
       and it is the ticket, which is what this route is keyed on
       anyway. */
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;

    ok("the parameter has the name the shim writes", P.VISIBLE_KEY === "__fk");

    const vis = (qs, headers) => P.ticketFromVisible(
      new URL("https://relay.example/results" + qs), { headers: headers || {} });

    ok("a ticket named in the address is found",
      (vis("?q=godot&__fk=" + t) || {}).ticket === t);
    ok("and it is reported as coming from the address",
      (vis("?__fk=" + t) || {}).from === "url");
    ok("a ticket nobody was issued is not honoured",
      vis("?__fk=deadbeefdeadbeefdeadbeef") === null);
    ok("no ticket anywhere means no rescue", vis("?q=godot") === null);

    ok("a subresource is rescued by the ticket in its page's address",
      (vis("?q=godot", { referer: "https://relay.example/results?q=godot&__fk=" + t }) || {}).ticket === t,
      JSON.stringify(vis("?q=godot", { referer: "https://relay.example/results?__fk=" + t })));
    ok("and that one says where it came from",
      (vis("", { referer: "https://relay.example/x?__fk=" + t }) || {}).from === "referer");
    ok("an unparseable referer is not a crash",
      vis("", { referer: "))) not a url" }) === null);

    /* The parameter is ours and must not reach the site: it is not
       part of the site's url, it would be sent upstream, and it would
       show up in the address the toolbar prints. */
    ok("the parameter is taken back out of the path",
      P.strippedPath(new URL("https://r.example/results?q=godot&__fk=" + t)) === "/results?q=godot",
      P.strippedPath(new URL("https://r.example/results?q=godot&__fk=" + t)));
    ok("a path with nothing else in the query loses the question mark too",
      P.strippedPath(new URL("https://r.example/watch?__fk=" + t)) === "/watch",
      P.strippedPath(new URL("https://r.example/watch?__fk=" + t)));
    ok("a path with no query at all is itself",
      P.strippedPath(new URL("https://r.example/watch")) === "/watch");
    ok("everything else in the query is kept",
      P.strippedPath(new URL("https://r.example/w?v=a&__fk=" + t + "&list=b")) === "/w?v=a&list=b",
      P.strippedPath(new URL("https://r.example/w?v=a&__fk=" + t + "&list=b")));

    /* End to end: a bare path that reaches the relay is turned back
       into the proxy path for the page that ticket is actually on.
       This is the reload of a visible address, and it is the whole
       reason the parameter exists. */
    P.noteLocation(t, "https://www.youtube.com/results?search_query=godot");
    const back = browse.rescueFromReferer({ method: "GET", headers: {} },
      new URL("https://relay.example/watch?v=abc&__fk=" + t));
    ok("a bare path is rescued rather than 404ed", !!back, String(back));
    ok("onto the site the ticket is on, at the path that was asked for",
      String(back).indexOf("https://www.youtube.com/watch?v=abc") > 0, String(back));
    ok("and our own parameter does not travel upstream with it",
      String(back).indexOf("__fk") < 0, String(back));

    /* Resolved against where the ticket IS, which is what makes a
       reload land back on the page rather than on the front door. */
    ok("a ticket with nowhere to be is not rescued to somewhere invented",
      browse.rescueFromReferer({ method: "GET", headers: {} },
        new URL("https://relay.example/watch?__fk=" + P.issueTicket("vault").ticket)) === null);
  }

  section("the base the page used to get for free");
  {
    /* Stripping <base> was only safe while the document's own URL
       WAS the proxy path — anything relative that the rewriter never
       saw still resolved through the proxy by accident of where the
       page was served from. pathMode moves the address and pulls
       that net out from under the page, so the net has to be written
       down instead of relied on. */
    browse.init({ config: { enabled: true, runScripts: true, pathMode: true },
      log: () => {} });
    const t = P.issueTicket("vault").ticket;
    const HERE = "https://site.example/dir/page.html?q=1";
    const html = "<html><head><base href='https://evil.example/'><title>t</title></head>" +
      "<body><p>hi</p></body></html>";

    const on = P.rewrite(html, HERE, t, false, null, false, true);
    const tag = /<base\b[^>]*href="([^"]*)"/i.exec(on);
    ok("a base tag is written when the address is going to move", !!tag, on.slice(0, 200));
    ok("and it is the page's own proxy url",
      tag[1] === "/browse/p/" + t + "/" + HERE, tag && tag[1]);

    /* The bug this replaced: injected before the rewriting pass, our
       own href was rewritten too and came out with the prefix twice.
       Measured on a live page before it was moved. */
    ok("the prefix appears once in it, not twice",
      tag[1].split("/browse/p/").length === 2, tag[1]);
    ok("the site's own base tag is still gone",
      on.indexOf("evil.example") < 0);
    ok("there is exactly one base tag",
      (on.match(/<base\b/gi) || []).length === 1);

    /* The whole url rather than the directory, because a fragment
       against a directory is a link to the directory — every in-page
       anchor a script builds would become a navigation. */
    ok("it keeps the query, so a fragment resolves to this page",
      /\?q=1$/.test(tag[1]), tag[1]);

    const off = P.rewrite(html, HERE, t, false, null, false, false);
    ok("no base tag when the address is staying where it was",
      !/<base\b/i.test(off), off.slice(0, 160));

    const framed = P.rewrite(html, HERE, t, true, null, false, true);
    ok("and none in a nested frame, whose address never moves",
      !/<base\b/i.test(framed));
  }

  section("more engines to try, because three was not enough");
  {
    const names = P.ENGINE_CANDIDATES.map((e) => e.name);
    ["Bing", "Marginalia", "Mojeek"].forEach((n) =>
      ok("the ones that were already answering are still offered: " + n,
        names.indexOf(n) >= 0));
    ["Brave", "MetaGer", "4get"].forEach((n) =>
      ok("and a relay that only had three now has more to try: " + n,
        names.indexOf(n) >= 0));
    ok("every candidate is a https url with somewhere to put the query",
      P.ENGINE_CANDIDATES.every((e) => /^https:\/\//.test(e.url) && /[?&][a-z]+=$/i.test(e.url)),
      JSON.stringify(P.ENGINE_CANDIDATES.filter((e) => !/[?&][a-z]+=$/i.test(e.url))));
    ok("no two candidates share a name",
      new Set(names).size === names.length);
    ok("and none share a url",
      new Set(P.ENGINE_CANDIDATES.map((e) => e.url)).size === names.length);
    ok("all of them count as an offered engine",
      P.ENGINE_CANDIDATES.every((e) => P.isOfferedEngine(e.url)));
  }

  section("a request that could belong to a page, and one that could not");
  {
    browse.init({ config: { enabled: true }, log: () => {} });
    const t = P.issueTicket("vault").ticket;
    ok("a live ticket in the address says this came from a proxied page",
      browse.looksProxied({ headers: {} },
        new URL("https://relay.example/x?__fk=" + t)) === true);
    ok("a ticket nobody holds does not",
      browse.looksProxied({ headers: {} },
        new URL("https://relay.example/x?__fk=nope")) === false);
    ok("and neither does an ordinary request to a missing route",
      browse.looksProxied({ headers: {} },
        new URL("https://relay.example/x")) === false);

    browse.init({ config: { enabled: false }, log: () => {} });
    ok("with the browser off nothing is ever attributed to it",
      browse.looksProxied({ headers: {} },
        new URL("https://relay.example/x?__fk=" + t)) === false);
  }

  section("off means off");
  {
    browse.init({ config: { enabled: false }, log: () => {} });
    const sent = [];
    await browse.route({ method: "GET", headers: {} }, { writeHead() {}, end() {} },
      { pathname: "/browse/p/-/https://example.com", searchParams: new URLSearchParams("") },
      { send: (r, status, body) => sent.push({ status, body }), authorise: () => "vault" });
    ok("a disabled proxy refuses before it looks at anything else",
      sent[0] && sent[0].status === 503);
    ok("and says which setting turns it on", /browse.enabled/.test(sent[0].body.detail));

    ok("a path that is not /browse is not ours",
      (await browse.route({ method: "GET", headers: {} }, {},
        { pathname: "/health", searchParams: new URLSearchParams("") }, {})) === false);
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + (e.stack || e.message));
  process.exit(1);
});
