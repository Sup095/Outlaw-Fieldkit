/* ============================================================
   The streamed browser (§14.11) — the parts that can be tested
   without a Chromium.

   What is here: the WebSocket framing both ways, the egress guard's
   address rules, the address bar's idea of what an address is, and
   the stream ticket. What is NOT here is anything that needs a real
   browser — that was tested by driving one, and the notes in
   FIELDKIT_PROJECT.md §14.11 say what was measured.

   The framing tests matter more than they look. A WebSocket
   implementation that is subtly wrong does not fail loudly; it works
   for small messages and corrupts large ones, which in this system
   means a JPEG that decodes to garbage once an hour.
   ============================================================ */
"use strict";

const net = require("net");
const { makeRunner } = require("./harness");
const ws = require("../relay/ws");
const guard = require("../relay/guard");
const engine = require("../relay/browser-engine");
const route = require("../relay/browser-route");

const { ok, section, state } = makeRunner("browser-stream");

/* A pair of Sockets wired to each other through a real TCP pair, so
   what is being tested is the bytes and not a mock of them. */
function pair() {
  return new Promise((resolve) => {
    /* Both ends have to exist before either is handed back. The
       first version resolved from whichever callback fired first,
       which on Windows was the server's — so `client` was still
       undefined and every test after it failed on the same line. */
    let server = null, client = null;
    const done = () => { if (server && client) resolve({ server, client }); };

    const srv = net.createServer((serverSide) => {
      srv.close();
      server = new ws.Socket(serverSide, { masked: false });
      done();
    });
    srv.listen(0, "127.0.0.1", () => {
      const c = net.connect(srv.address().port, "127.0.0.1", () => {
        client = new ws.Socket(c, { masked: true });
        done();
      });
    });
  });
}

function once(sock, event) {
  return new Promise((resolve) => sock.once(event, (a, b) => resolve([a, b])));
}

(async () => {

  section("the handshake is the thing that proves who answered");
  {
    /* The one fixed vector in RFC 6455. If this drifts, every
       browser refuses the connection and the reason is invisible. */
    ok("the RFC's own example key produces the RFC's own accept",
      ws.acceptFor("dGhlIHNhbXBsZSBub25jZQ==") === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      ws.acceptFor("dGhlIHNhbXBsZSBub25jZQ=="));
  }

  section("frames survive the trip, at every length the format has");
  {
    const p = await pair();

    /* The three width classes are three different header layouts,
       and a bug lives in exactly one of them at a time. */
    const cases = [
      ["a short frame", "x".repeat(10)],
      ["one byte under the 16-bit boundary", "y".repeat(125)],
      ["exactly at it", "z".repeat(126)],
      ["a 16-bit length", "w".repeat(5000)],
      ["one byte under the 64-bit boundary", "v".repeat(65535)],
      ["a 64-bit length", "u".repeat(70000)]
    ];

    for (const [what, payload] of cases) {
      const got = once(p.server, "message");
      p.client.send(payload);
      const [text] = await got;
      ok("client to server: " + what, text === payload,
        typeof text === "string" ? text.length + " chars" : typeof text);
    }

    for (const [what, payload] of cases) {
      const got = once(p.client, "message");
      p.server.send(payload);
      const [text] = await got;
      ok("server to client: " + what, text === payload,
        typeof text === "string" ? text.length + " chars" : typeof text);
    }

    /* Binary is the whole point here — every video frame is one. */
    const jpegish = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const gotBin = once(p.client, "message");
    p.server.send(jpegish);
    const [buf, isBinary] = await gotBin;
    ok("a binary frame arrives as a buffer, not a mangled string",
      isBinary === true && Buffer.isBuffer(buf) && buf.equals(jpegish));

    /* Bytes that are not valid UTF-8 are exactly what a JPEG is. If
       binary ever went through the text path this is what would
       catch it. */
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc0]);
    const gotRaw = once(p.server, "message");
    p.client.send(raw);
    const [rbuf] = await gotRaw;
    ok("bytes that are not text survive being sent as bytes",
      Buffer.isBuffer(rbuf) && rbuf.equals(raw), rbuf && rbuf.toString("hex"));

    p.client.close(1000, "done");
  }

  section("a frame that claims too much is refused, not allocated");
  {
    const p = await pair();
    /* The cap is lowered rather than the message raised, so the test
       stays fast and still exercises the branch that matters: the
       length is judged from the HEADER, before any allocation. */
    p.server.maxPayload = 64;
    const closed = once(p.server, "close");
    p.client.send("A".repeat(500));
    const [code] = await closed;
    ok("an oversized message closes the connection", code === 1009, String(code));
    ok("and it closes rather than truncating, because a truncated frame is a desync",
      p.server.open === false);
  }

  section("the address rules the guard applies");
  {
    const priv = guard.isPrivateAddress;
    [
      ["127.0.0.1", "loopback, which is where the relay itself lives"],
      ["10.1.2.3", "class A private"],
      ["172.16.0.1", "the bottom of the 172 range"],
      ["172.31.255.255", "the top of it"],
      ["192.168.1.1", "the one everybody has"],
      ["169.254.169.254", "the cloud metadata address"],
      ["100.64.0.1", "CGNAT, which is where a tailnet lives"],
      ["0.0.0.0", "the unspecified address"],
      ["::1", "loopback again, in v6"],
      ["fd00::1", "v6 unique-local"],
      ["fe80::1", "v6 link-local"],
      ["::ffff:127.0.0.1", "loopback wearing a v6 hat"],
      ["not an address", "something that is not an address at all"]
    ].forEach(([ip, why]) => ok("refused: " + ip + " — " + why, priv(ip) === true));

    [
      ["8.8.8.8", "an ordinary public address"],
      ["172.32.0.1", "just outside the private 172 range"],
      ["172.15.255.255", "just below it"],
      ["2606:4700:4700::1111", "a public v6 address"]
    ].forEach(([ip, why]) => ok("allowed: " + ip + " — " + why, priv(ip) === false));
  }

  section("splitting an authority, including the v6 shape that breaks it");
  {
    const s = guard.splitAuthority;
    ok("host and port", JSON.stringify(s("example.com:443")) === '["example.com","443"]',
      JSON.stringify(s("example.com:443")));
    ok("no port", JSON.stringify(s("example.com")) === '["example.com",""]');
    ok("a v6 literal keeps its own colons",
      JSON.stringify(s("[::1]:8443")) === '["::1","8443"]', JSON.stringify(s("[::1]:8443")));
    ok("a v6 literal with no port is not split at one of its own colons",
      s("[2001:db8::1]")[0] === "2001:db8::1", JSON.stringify(s("[2001:db8::1]")));
  }

  section("the guard refuses before it opens a socket");
  {
    const g = new guard.Guard({ log: () => {}, dnsFilter: "system",
      filter: (h) => h === "blocked.example"
        ? { ok: false, why: "that host is on this relay's block list" } : { ok: true } });

    const loop = await g.place("127.0.0.1");
    ok("a literal loopback address is refused", loop.ok === false && loop.kind === "private");
    ok("and the reason names the relay's own network",
      /relay's own network/.test(loop.why), loop.why);

    const blocked = await g.place("blocked.example");
    ok("the relay's own block list is honoured here too",
      blocked.ok === false && blocked.kind === "filter");

    /* The refusal is remembered so a CONNECT — which cannot carry a
       message — can still be explained to somebody. */
    const fresh = g.whyRefused();
    ok("the last refusal is available to explain an error page",
      fresh && fresh.host === "blocked.example", JSON.stringify(fresh));
    /* Backdated rather than waited for. The point is that an OLD
       refusal must not be used to explain a new failure — a site
       that is merely down would otherwise be reported as blocked. */
    g.lastRefusal.at -= 60000;
    ok("but only while it is fresh, or it would explain the wrong failure",
      g.whyRefused() === null);

    g.close();
  }

  section("the presets say which filter is running");
  {
    const p = guard.DNS_PRESETS;
    ok("adult is the default and blocks porn plus malware",
      p.adult && p.adult.servers.length === 2 && /adult/i.test(p.adult.name));
    ok("family is offered for stricter filtering", !!p.family);
    ok("security is offered for malware only, without content filtering", !!p.security);
    ok("system means no filtering, and says so", p.system.servers === null);
    ok("every preset that filters names real resolvers",
      ["adult", "family", "security"].every((k) =>
        p[k].servers.every((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s))));
  }

  section("what the address bar treats as an address");
  {
    const n = engine.normaliseUrl;
    ok("a bare hostname becomes https", n("example.com") === "https://example.com/", n("example.com"));
    ok("a full url is kept", n("https://a.example/b?c=1") === "https://a.example/b?c=1");
    ok("http is left as http", n("http://a.example/") === "http://a.example/");
    ok("a host with a path works", n("docs.godotengine.org/en/stable") ===
      "https://docs.godotengine.org/en/stable");

    ok("words are not an address, so they become a search", n("godot navmesh") === null);
    ok("one word is not an address either", n("godot") === null);
    ok("and nothing is nothing", n("") === null);

    /* These are the ones that matter: a scheme that would reach out
       of the browser and into the machine it runs on. */
    ["file:///etc/passwd", "javascript:fetch('/vault')", "data:text/html,<script>",
     "chrome://settings", "devtools://devtools/bundled/x.js", "view-source:https://a.example"]
      .forEach((u) => ok("refused as an address: " + u.slice(0, 28), n(u) === null));
  }

  section("a stream ticket is worth one use and then nothing");
  {
    const P = route._internals;
    P.tickets.clear();
    const t = P.issue("msg:alice");
    ok("a ticket is long enough not to be guessed", t.length >= 32, String(t.length));
    ok("it names who asked for it", P.spend(t) === "msg:alice");
    ok("and it is gone the moment it is used", P.spend(t) === null);
    ok("something nobody issued is worth nothing", P.spend("deadbeef") === null);

    const old = P.issue("msg:bob");
    P.tickets.get(old).expires = Date.now() - 1;
    ok("an expired ticket is not honoured", P.spend(old) === null);
    P.tickets.clear();
  }

  section("typing words in the address bar searches for them");
  {
    const url = route._internals.searchUrlFor("godot navmesh");
    ok("the query is encoded into the engine's url",
      url.indexOf("godot%20navmesh") > 0 || url.indexOf("godot+navmesh") > 0, url);
    ok("and it is a real https url", /^https:\/\//.test(url), url);
  }

  section("looking for a browser, and saying where you looked");
  {
    /* Whether this machine has a Chromium decides where the search
       stops, so the claims are about the order, not what is installed. */
    const f = engine.findChromium("");
    const L = engine.LIKELY_PATHS;
    ok("it says every path it tried, in order, up to the one it found",
      Array.isArray(f.tried) && f.tried.length >= 1 && f.tried.every((p, i) => p === L[i]) &&
      (f.path ? f.tried[f.tried.length - 1] === f.path : f.tried.length === L.length), JSON.stringify(f));
    ok("a search that finds nothing has tried them all, the container paths among them",
      L.length >= 5 && L.some((p) => p.indexOf("/usr/bin/chromium") === 0));
    ok("a configured path is tried first",
      engine.findChromium("/somewhere/custom/chrome").tried[0] === "/somewhere/custom/chrome");
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
