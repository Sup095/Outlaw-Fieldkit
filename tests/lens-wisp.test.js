/* ============================================================
   FieldKit tests :: lens-wisp — the lighter browser's server end

   The Wisp server against a real WebSocket client and real TCP sites
   on loopback: that bytes go both ways, that every refusal the relay
   makes is made here too (with the real guard), that the credit and
   the meter work, and that nothing is left open when a person goes.

   node tests/lens-wisp.test.js
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const ws = require("../relay/ws");
const { Guard } = require("../relay/guard");
const W = require("../lens/wisp");
const { Meter } = require("../lens/meter");
const lens = require("../lens/server");
const { sign, verify } = require("../relay/overflow");
const { LensLink, parseLensUrl } = require("../relay/lens-link");
const crypto = require("crypto");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra ? "\n        " + extra : "")); }
}
function section(s) { console.log("\n== " + s + " =="); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-lens-"));

/* A site on loopback: echoes, and remembers who is connected. */
const site = { open: 0, conns: [] };
const BIG = 8 * 1024 * 1024;
const echo = net.createServer((c) => {
  site.open++;
  site.conns.push(c);
  c.on("data", (d) => {
    if (String(d) === "bye") return c.end("ok bye");
    if (String(d) === "big") return c.write(Buffer.alloc(BIG, 7));
    c.write(d);
  });
  c.on("close", () => site.open--);
  c.on("error", () => {});
});

/* The judge for most tests: names map to loopback, as a resolver
   would map them to the internet. The real guard is used below. */
const placed = [];
const judge = {
  portOk: (p) => p !== 25,
  place(host) {
    placed.push(host);
    if (host === "echo.test" || host === "www.yt.test") return { ok: true, address: "127.0.0.1" };
    if (host === "adult.test") return { ok: false, kind: "adult", why: "that site is for adults" };
    if (host === "ads.test") return { ok: false, kind: "ads", why: "an ad", quiet: true };
    if (host === "gone.test") return { ok: false, kind: "dns", why: "did not resolve" };
    return { ok: false, kind: "filter", why: "unknown" };
  }
};

function start(opts) {
  const lines = [];
  const server = new W.WispServer(Object.assign({ judge, log: (l, m) => lines.push(m) }, opts));
  const httpServer = http.createServer((q, r) => { r.writeHead(404); r.end(); });
  httpServer.on("upgrade", (req, sock, head) => {
    sock.on("error", () => {});
    const who = new URL(req.url, "http://x").searchParams.get("who");
    server.handle(req, sock, head, who);
  });
  return new Promise((r) => httpServer.listen(0, "127.0.0.1", () => r({ server, httpServer, lines, port: httpServer.address().port })));
}

/* A client that keeps every packet, by stream. */
async function client(port, who) {
  const c = await ws.connect("ws://127.0.0.1:" + port + "/wisp/" + (who ? "?who=" + who : ""));
  const got = [];
  const waiters = [];
  c.on("message", (m, bin) => {
    const p = W.parse(m);
    got.push(p);
    for (const w of waiters.slice()) if (w.test(p)) { waiters.splice(waiters.indexOf(w), 1); w.done(p); }
  });
  const want = (test, ms) => {
    const already = got.find(test);
    if (already) return Promise.resolve(already);
    return new Promise((done) => {
      const w = { test, done };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); done(null); } }, ms || 3000);
    });
  };
  const closeOf = (id, ms) => want((p) => p.type === W.T.CLOSE && p.id === id, ms);
  const dataOf = (id) => Buffer.concat(got.filter((p) => p.type === W.T.DATA && p.id === id).map((p) => p.body));
  return { c, got, want, closeOf, dataOf,
    connect: (id, host, port, kind) => c.send(W.connectPacket(id, host, port, kind)),
    data: (id, b) => c.send(W.packet(W.T.DATA, id, Buffer.from(b))),
    close: (id) => c.send(W.closePacket(id, W.WHY.VOLUNTARY)) };
}

(async () => {
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const ECHO = echo.address().port;

  section("packets");
  {
    const p = W.parse(W.connectPacket(7, "example.org", 443));
    const c = W.parseConnect(p.body);
    ok("CONNECT round-trips", p.type === W.T.CONNECT && p.id === 7 && c.kind === W.KIND.TCP && c.port === 443 && c.host === "example.org");
    const k = W.parse(W.continuePacket(0, 128));
    ok("CONTINUE carries its credit little-endian", k.type === W.T.CONTINUE && k.body.readUInt32LE(0) === 128);
    ok("CLOSE carries one reason byte", W.parse(W.closePacket(3, 0x48)).body[0] === 0x48);
    ok("too short is not a packet", W.parse(Buffer.from([1, 0, 0])) === null);
    ok("ids are unsigned 32-bit", W.parse(W.packet(W.T.DATA, 0xfffffffe)).id === 0xfffffffe);
  }

  const A = await start({ buffer: 8 });

  section("the conversation");
  {
    const k = await client(A.port, "ana");
    const first = await k.want(() => true);
    ok("the server speaks first: CONTINUE on stream 0", first && first.type === W.T.CONTINUE && first.id === 0 && first.body.readUInt32LE(0) === 8);

    k.connect(1, "echo.test", ECHO);
    k.data(1, "hello");                     /* before the connection is up: queued */
    await k.want((p) => p.type === W.T.DATA && p.id === 1);
    await sleep(50);
    ok("bytes go out and come back", k.dataOf(1).toString() === "hello", k.dataOf(1).toString());

    k.connect(2, "echo.test", ECHO);
    await sleep(80);
    k.data(2, "bye");
    const end = await k.closeOf(2);
    ok("a site that hangs up closes the stream as voluntary", end && end.body[0] === W.WHY.VOLUNTARY);
    ok("what the site said before hanging up arrives first", k.dataOf(2).toString() === "ok bye");
    ok("stream 1 is unaffected", A.server.view().streams === 1);

    /* Credit: 8 packets, given back in halves. */
    k.connect(3, "echo.test", ECHO);
    await sleep(80);
    for (let i = 0; i < 4; i++) k.data(3, "x" + i);
    const more = await k.want((p) => p.type === W.T.CONTINUE && p.id === 3);
    ok("after half the credit, the server gives it back", more && more.body.readUInt32LE(0) === 8);

    const before = site.open;
    k.close(1);
    await sleep(100);
    ok("a stream the client closes is closed at the site", site.open === before - 1);
    ok("…and the server does not answer a client's CLOSE", !k.got.some((p) => p.type === W.T.CLOSE && p.id === 1));

    k.c.close(1000, "done");
    await sleep(150);
    ok("a person leaving closes every connection they had", A.server.view().open === 0 && A.server.view().streams === 0);
  }

  section("refusals");
  {
    const k = await client(A.port, "ben");
    k.connect(1, "adult.test", 443);
    ok("a listed site is refused as blocked (0x48)", (await k.closeOf(1)).body[0] === W.WHY.BLOCKED);
    ok("…and logged", A.lines.some((l) => /refused adult\.test:443/.test(l)));
    k.connect(2, "ads.test", 443);
    ok("an ad is refused too", (await k.closeOf(2)).body[0] === W.WHY.BLOCKED);
    ok("…without a line each", !A.lines.some((l) => /ads\.test/.test(l)));
    k.connect(3, "gone.test", 443);
    ok("a name that does not resolve is unreachable (0x42)", (await k.closeOf(3)).body[0] === W.WHY.UNREACHABLE);
    const asked = placed.length;
    k.connect(4, "echo.test", 25);
    ok("a port pages may not open is refused before any lookup", (await k.closeOf(4)).body[0] === W.WHY.BLOCKED && placed.length === asked);
    k.connect(5, "echo.test", ECHO, W.KIND.UDP);
    ok("UDP is refused as invalid (0x41)", (await k.closeOf(5)).body[0] === W.WHY.INVALID);
    k.connect(6, "bad host\n", 443);
    ok("a hostname with spaces is invalid", (await k.closeOf(6)).body[0] === W.WHY.INVALID);
    k.connect(0, "echo.test", ECHO);
    ok("stream 0 cannot be opened", (await k.closeOf(0)).body[0] === W.WHY.INVALID);
    k.connect(7, "echo.test", ECHO);
    await sleep(60);
    k.connect(7, "echo.test", ECHO);
    ok("an id already open is invalid", (await k.want((p) => p.type === W.T.CLOSE && p.id === 7)).body[0] === W.WHY.INVALID);
    ok("…and the open one is left alone", A.server.view().streams === 1);
    k.connect(8, "unknown.test", 443);
    await k.closeOf(8);
    ok("the last refusal is kept, to explain it", A.server.view().open === 1 && [...A.server.sessions][0].lastRefusal.host === "unknown.test");
    ok("…and asked for by host, for that person only", A.server.whyFor("ben", "unknown.test").kind === "filter" &&
      A.server.whyFor("ben", "adult.test") === null && A.server.whyFor("cy", "unknown.test") === null);
    k.connect(9, "ads.test", 443);
    await k.closeOf(9);
    ok("a quiet refusal (an ad) does not replace it", A.server.whyFor("ben", "unknown.test") !== null);
    k.connect(10, "gone.test", 443);
    await k.closeOf(10);
    ok("a name that does not exist is explained too", A.server.whyFor("ben", "gone.test").kind === "dns");
    ok("…but not once it is old", A.server.whyFor("ben", "gone.test", -1) === null);
    k.c.close(1000);
    await sleep(80);
  }

  section("limits");
  {
    const B = await start({ maxStreams: 2, maxPerWho: 1 });
    const k = await client(B.port, "cy");
    k.connect(1, "echo.test", ECHO); k.connect(2, "echo.test", ECHO); k.connect(3, "echo.test", ECHO);
    ok("past the streams a person may hold: throttled (0x49)", (await k.closeOf(3)).body[0] === W.WHY.THROTTLED);
    let second = null;
    try { second = await client(B.port, "cy"); } catch (e) { second = e; }
    ok("one more WebSocket than allowed is refused", second instanceof Error && /429/.test(second.message), String(second && second.message));
    const other = await client(B.port, "dee");
    ok("…but someone else still gets in", !!(await other.want((p) => p.type === W.T.CONTINUE)));
    const text = await client(B.port, "eve");
    const closed = new Promise((r) => text.c.on("close", (code) => r(code)));
    text.c.send("hello");
    ok("text instead of Wisp ends the session", (await Promise.race([closed, sleep(1000)])) === 1003);
    B.server.close();
    B.httpServer.close();
  }

  section("a slow reader does not fill the server");
  {
    /* How much a paused reader's kernel soaks up differs by system
       (Windows took 24 MB on loopback), so the queue the server sees
       is set here and the mechanism is what is checked. */
    const C = await start({ highWater: 64 * 1024 });
    const k = await client(C.port, "fay");
    k.connect(1, "echo.test", ECHO);
    await sleep(80);
    const s = [...C.server.sessions][0];
    let queued = 0;
    Object.defineProperty(s.raw, "writableLength", { configurable: true, get: () => queued });
    queued = 1024 * 1024;
    k.data(1, "ping");
    await k.want((p) => p.type === W.T.DATA && p.id === 1);
    const tcp = s.streams.get(1).tcp;
    ok("past highWater the session pauses its sites", s.paused === true && C.server.stats.pauses === 1 && tcp.isPaused());
    k.connect(2, "echo.test", ECHO);
    await sleep(80);
    ok("…and a site opened meanwhile starts paused", s.streams.get(2).tcp.isPaused());
    queued = 0;
    s.raw.emit("drain");
    ok("when the person catches up, every site reads again", !s.paused && !tcp.isPaused() && !s.streams.get(2).tcp.isPaused());
    delete s.raw.writableLength;
    k.data(1, "big");
    for (let i = 0; i < 60 && k.dataOf(1).length < BIG + 4; i++) await sleep(100);
    ok("a large answer arrives whole", k.dataOf(1).length === BIG + 4, String(k.dataOf(1).length));
    k.c.close(1000);
    C.server.close();
    C.httpServer.close();
  }

  section("the meter");
  {
    let t = Date.parse("2026-11-30T23:59:00Z");
    const states = [];
    const file = path.join(TMP, "meter.json");
    const m = new Meter({ file, capBytes: 1000, personDayBytes: 400, now: () => t, onState: (s) => states.push(s) });
    m.add("ana", 300);
    ok("counts", m.view().used === 300 && m.view().state === "ok");
    m.add("ana", 150);
    ok("a person's day share runs out on its own", !m.allowed("ana").ok && m.allowed("ben").ok);
    m.add("ben", 400);
    ok("past 80% the state is near", m.view().state === "near" && states[0] === "near");
    m.add("ben", 200);
    ok("at the ceiling, no one gets in", !m.allowed("cy").ok && /month/.test(m.allowed("cy").why) && states[1] === "over");
    m.save();
    const again = new Meter({ file, capBytes: 1000, now: () => t });
    ok("the month's count survives a restart", again.view().used === 1050);
    again.close();
    t = Date.parse("2026-12-01T00:00:30Z");
    ok("a new month starts at zero", m.allowed("cy").ok && m.view().used === 0 && m.view().month === "2026-12");
    ok("…and says it is fine again", states[2] === "ok");
    ok("…with the day shares cleared", m.allowed("ana").ok);
    m.close();
    const free = new Meter({});
    free.add("x", 1e12);
    ok("no ceiling set: never refuses", free.allowed("x").ok && free.view().state === "ok");
    const seen = new Meter({ capBytes: 1000, log: () => {} });
    seen.add("x", 100);
    ok("the provider's count, when ahead, is taken", seen.seen(500) === true && seen.view().used === 500);
    ok("…and never pulls the count back", seen.seen(200) === false && seen.view().used === 500);
    ok("…and can stop everyone at the ceiling", seen.seen(1000) && seen.view().state === "over" && !seen.allowed("y").ok);
    seen.close();

    const D = await start({ meter: new Meter({ capBytes: 50 }) });
    const k = await client(D.port, "gus");
    k.connect(1, "echo.test", ECHO);
    await sleep(60);
    k.data(1, "0123456789012345678901234567890123456789");
    await k.want((p) => p.type === W.T.DATA && p.id === 1);
    await sleep(50);
    ok("lens counts both ways into the meter", D.server.meter.view().used >= 80, String(D.server.meter.view().used));
    k.connect(2, "echo.test", ECHO);
    ok("past the ceiling, new connections are throttled", (await k.closeOf(2)).body[0] === W.WHY.THROTTLED);
    ok("the view carries the meter", D.server.view().meter.state === "over");
    k.c.close(1000);
    D.server.close();
    D.httpServer.close();
  }

  section("with the relay's real guard");
  {
    const guard = new Guard({ ports: "browser", lists: { match: (h) => /(^|\.)blocked\.example$/.test(h) ? { cat: "malware", why: "known for malware" } : null } });
    const E = await start({ judge: guard });
    const k = await client(E.port, "hal");
    k.connect(1, "127.0.0.1", ECHO);
    ok("loopback is refused, even though it is listening", (await k.closeOf(1)).body[0] === W.WHY.BLOCKED && site.open === 0);
    k.connect(2, "10.1.2.3", 443);
    ok("a private address is refused", (await k.closeOf(2)).body[0] === W.WHY.BLOCKED);
    k.connect(3, "169.254.169.254", 80);
    ok("the cloud metadata address is refused", (await k.closeOf(3)).body[0] === W.WHY.BLOCKED);
    k.connect(4, "::1", 443);
    ok("IPv6 loopback is refused", (await k.closeOf(4)).body[0] === W.WHY.BLOCKED);
    k.connect(5, "cdn.blocked.example", 443);
    ok("a listed name is refused before it is looked up", (await k.closeOf(5)).body[0] === W.WHY.BLOCKED && guard.stats.refusedFilter >= 1);
    k.connect(6, "1.1.1.1", 22);
    ok("ports below 1024 other than the web ones are refused", (await k.closeOf(6)).body[0] === W.WHY.BLOCKED);
    ok("…and the last refusal says why", /port 22/.test([...E.server.sessions][0].lastRefusal.why));
    k.c.close(1000);
    E.server.close();
    E.httpServer.close();
  }

  section("the lens server: passes, status, files");
  {
    const pair = crypto.generateKeyPairSync("ed25519");
    const other = crypto.generateKeyPairSync("ed25519");
    let loads = 0;
    const relayKey = { key: null, async load() { loads++; this.key = pair.publicKey; return true; }, due: () => true };
    const client = path.join(TMP, "client");
    fs.mkdirSync(client);
    fs.writeFileSync(path.join(client, "index.html"), "<p>lens</p>");
    fs.writeFileSync(path.join(TMP, "secret.txt"), "no");
    const L = await lens.start({ config: { port: 0, host: "127.0.0.1", dataDir: path.join(TMP, "lensdata"), clientDir: client },
      relayKey, judge, log: () => {} });
    await sleep(20);
    const pass = (claims, key, opts) => sign((key || pair).privateKey, Object.assign({ what: "lens", who: "msg:ivy" }, claims), Date.now(), opts || lens.passOptions);
    const url = (p) => "ws://127.0.0.1:" + L.port + "/wisp/" + (p === undefined ? "" : "?pass=" + encodeURIComponent(p));
    const tryOpen = async (u) => { try { const c = await ws.connect(u); return c; } catch (e) { return e; } };

    ok("no pass: refused", /401/.test((await tryOpen(url())).message));
    ok("a pass signed by another key: refused", /401/.test((await tryOpen(url(pass({}, other)))).message));
    ok("…and the relay's key is fetched again", loads >= 2);
    ok("a browser helper's pass is not a lens pass", /401/.test((await tryOpen(url(pass({}, null, {})))).message));
    ok("a pass for something else: refused", /401/.test((await tryOpen(url(pass({ what: "link" })))).message));
    ok("a pass with no account: refused", /401/.test((await tryOpen(url(pass({ who: "" })))).message));
    const good = pass({});
    const c = await tryOpen(url(good));
    ok("a good pass opens Wisp", !(c instanceof Error));
    ok("…as the account it names", [...L.wisp.sessions][0].who === "msg:ivy");
    const again = await tryOpen(url(good));
    ok("the same pass works again (libcurl.js reconnects by itself)", !(again instanceof Error));
    ok("a pass lasts 12 hours", lens.PASS_MS === 12 * 3600 * 1000);
    ok("another path is not Wisp", /404/.test((await tryOpen("ws://127.0.0.1:" + L.port + "/other")).message));

    const st = await new Promise((r) => http.get("http://127.0.0.1:" + L.port + "/lens/status", (res) => {
      let b = ""; res.on("data", (d) => b += d); res.on("end", () => r({ code: res.statusCode, body: JSON.parse(b), cors: res.headers["access-control-allow-origin"] }));
    }));
    ok("status says up, the meter's state and who is on", st.code === 200 && st.body.up && st.body.state === "ok" && st.body.open === 2 && st.body.key === true);
    ok("…and names no one", !/ivy/.test(JSON.stringify(st.body)));
    const get = (p) => new Promise((r) => http.get("http://127.0.0.1:" + L.port + p, (res) => {
      let b = ""; res.on("data", (d) => b += d); res.on("end", () => r({ code: res.statusCode, body: b, h: res.headers }));
    }));
    const page = await get("/");
    ok("the client's page is served, isolated", page.code === 200 && page.body === "<p>lens</p>" && page.h["cross-origin-embedder-policy"] === "require-corp");
    ok("nothing outside the client folder is", (await get("/..%2fsecret.txt")).code === 404 && (await get("/%2e%2e/secret.txt")).code === 404);
    const head = await new Promise((r) => http.request("http://127.0.0.1:" + L.port + "/", { method: "HEAD" }, (res) => {
      let b = ""; res.on("data", (d) => b += d); res.on("end", () => r({ code: res.statusCode, body: b }));
    }).end());
    ok("HEAD answers like GET, without the body", head.code === 200 && head.body === "");
    ok("a wasm file is served as wasm (WebAssembly refuses any other type)", lens.TYPES[".wasm"] === "application/wasm");

    const inPath = await tryOpen("ws://127.0.0.1:" + L.port + "/wisp/" + encodeURIComponent(good) + "/");
    ok("the pass works in the path too (libcurl.js wants an address ending in /)", !(inPath instanceof Error));
    ok("…not without the closing /", /404/.test((await tryOpen("ws://127.0.0.1:" + L.port + "/wisp/" + encodeURIComponent(good))).message));
    inPath.close(1000);

    L.wisp.noteRefusal("msg:ivy", "adult.test", "adult", "that site is for adults");
    const why = (p, h) => get("/lens/why?pass=" + encodeURIComponent(p) + "&host=" + h);
    const w1 = await why(good, "adult.test");
    ok("/lens/why explains a refusal to the person it happened to", w1.code === 200 && JSON.parse(w1.body).kind === "adult");
    ok("…says nothing of another host", JSON.stringify(JSON.parse((await why(good, "other.test")).body)) === "{}");
    ok("…nor to someone else", JSON.stringify(JSON.parse((await why(pass({ who: "msg:zed" }), "adult.test")).body)) === "{}");
    ok("…and nothing at all without a good pass", (await why(pass({}, other), "adult.test")).code === 401);
    c.close(1000); again.close(1000);

    let refused = 0;
    for (let i = 0; i < 35; i++) { const r = await tryOpen(url()); if (/429/.test(r.message)) refused++; }
    ok("one address opening too many sockets a minute is slowed", refused > 0);
    L.close();

    /* Behind Caddy every socket comes from loopback: with trustProxy
       "loopback" the limit is per person's address, the last one Caddy
       added; without it, X-Forwarded-For is never believed. */
    const behind = async (trust) => {
      const S = await lens.start({ config: { port: 0, host: "127.0.0.1", dataDir: path.join(TMP, "lensdata-p" + trust), trustProxy: trust },
        relayKey, judge, log: () => {} });
      const open = (ip) => ws.connect("ws://127.0.0.1:" + S.port + "/wisp/", { headers: { "X-Forwarded-For": "6.6.6.6, " + ip } }).then(() => "open", (e) => e.message);
      for (let i = 0; i < 35; i++) await open("203.0.113.9");
      const other = await open("203.0.113.10");
      S.close();
      return other;
    };
    ok("trustProxy loopback: one person's sockets do not slow another", /401/.test(await behind("loopback")));
    ok("…and without it, the header is not believed", /429/.test(await behind("")));
    const keyless = await lens.start({ config: { port: 0, host: "127.0.0.1", dataDir: path.join(TMP, "lensdata2") },
      relayKey: { key: null, async load() { return false; }, due: () => false }, judge, log: () => {} });
    ok("without the relay's key, no one gets in (503)", /503/.test((await tryOpen("ws://127.0.0.1:" + keyless.port + "/wisp/?pass=x")).message));
    keyless.close();
  }

  section("the relay's side (lens-link)");
  {
    ok("an https address is taken", parseLensUrl("https://lens.example.com/").wisp === "wss://lens.example.com/wisp/");
    ok("anything else is not", !parseLensUrl("ftp://x") && !parseLensUrl("https://a:b@x") && !parseLensUrl("https://x/?q=1") && !parseLensUrl(""));
    const keys = (() => { const p = crypto.generateKeyPairSync("ed25519"); return { privateKey: p.privateKey, publicPem: p.publicKey.export({ type: "spki", format: "pem" }) }; })();
    let t = 1e12, answer = { up: true, state: "ok", fraction: 0.1, open: 2, key: true }, failing = null;
    const link = new LensLink({ url: "https://lens.example.com", keys, now: () => t, everyMs: 1000,
      fetch: async (u) => { if (failing) throw new Error(failing); return { ok: true, json: async () => answer }; } });
    ok("before it has been heard from: streamed, and nothing said yet", link.offer("msg:jo").mode === "stream" && link.notice() === null);
    await link.poll();
    ok("up and under the ceiling: usable", link.usable());
    const o = link.offer("msg:jo", "member");
    ok("the offer is lens, with the page, the pass and a Wisp address ending in /", o.mode === "lens" && o.page === "https://lens.example.com/" &&
      o.wisp === "wss://lens.example.com/wisp/" + encodeURIComponent(o.pass) + "/");
    const v = verify(crypto.createPublicKey(keys.publicPem), o.pass, t, lens.passOptions);
    ok("its pass is a lens pass naming the account and tier", v.ok && v.claims.who === "msg:jo" && v.claims.tier === "member" && v.claims.what === "lens");
    ok("no notice while lens works", link.notice() === null);
    failing = "connect ECONNREFUSED";
    await link.poll();
    ok("not answering: streamed, and why", link.offer("msg:jo").mode === "stream" && /not answering/.test(link.offer("msg:jo").why));
    ok("…and everyone is told it fell back", /streamed mode for now/.test(link.notice().text));
    failing = null; answer = Object.assign({}, answer, { state: "over" });
    await link.poll();
    ok("over the ceiling: streamed until next month, said so", link.offer("x").mode === "stream" && /until next month/.test(link.notice().text));
    answer = Object.assign({}, answer, { state: "near" });
    await link.poll();
    ok("near the ceiling: still lens, and the panel is told", link.offer("x").mode === "lens" && link.offer("x").near === true);
    ok("…and the notice is gone by itself", link.notice() === null);
    t += 3500;
    ok("a reading three polls old is no reading", !link.usable() && /for a while/.test(link.why()));
    answer = Object.assign({}, answer, { key: false });
    await link.poll();
    ok("a lens server without the relay's key is not offered", !link.usable() && /key/.test(link.why()));
    const off = new LensLink({});
    ok("not set up: no notice, streamed", off.notice() === null && off.offer("x").mode === "stream" && !off.configured());
    ok("ADMIN CENTER's view names no one", !/jo/.test(JSON.stringify(link.view())) && "fraction" in link.view());

    /* The whole path: the relay's offer opens the lens server. */
    const L = await lens.start({ config: { port: 0, host: "127.0.0.1", dataDir: path.join(TMP, "lensdata3") },
      relayKey: { key: crypto.createPublicKey(keys.publicPem), async load() { return true; }, due: () => false }, judge, log: () => {} });
    const real = new LensLink({ url: "http://127.0.0.1:" + L.port, keys, everyMs: 60000 });
    await real.poll();
    const offer = real.offer("msg:kay", "guest");
    ok("against a real lens server: usable", offer.mode === "lens", JSON.stringify(real.view()));
    const c = await ws.connect(offer.wisp);
    const first = await new Promise((r) => c.on("message", (m) => r(W.parse(m))));
    ok("…and the address it hands out opens Wisp as that person", first.type === W.T.CONTINUE && [...L.wisp.sessions][0].who === "msg:kay");
    c.close(1000);
    L.close();
  }

  section("the one fix to Scramjet, and the client's files");
  {
    const P = require("../lens/patch-scramjet");
    const code = 'let x=v["set-cookie"]||[];for(let t in x)if(h){let r=f.dispatch(h,{});' + P.BEFORE + '}';
    const fixed = P.patch(code);
    ok("the cookie wait is taken out", fixed && fixed.includes(P.AFTER) && !fixed.includes(P.BEFORE));
    ok("…and nothing else changes", fixed.replace(P.AFTER, P.BEFORE) === code);
    ok("it refuses when the code is not there (a new Scramjet is looked at again)", P.patch("other code") === null);
    ok("…or is there twice", P.patch(code + code) === null);
    ok("…or was already fixed", P.patch(fixed) === null);

    const dir = path.join(__dirname, "..", "lens");
    const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
    const docker = read("Dockerfile"), page = read("client/index.html"), js = read("client/lens.js"), sw = read("client/sw.js");
    const folder = (/client\/v\/(scramjet-[^/]+)\//.exec(docker) || [])[1];
    ok("the image patches Scramjet when it is built", /RUN node lens\/patch-scramjet\.js lens\/client\/v\/scramjet-[^ ]+\/scramjet\.all\.js/.test(docker));
    ok("the patched copy has a folder of its own (browsers keep v/ for a month)", /-fk\d+$/.test(folder || ""), folder);
    ok("…and the page, the script and the worker all load that folder",
      page.includes("/v/" + folder + "/") && js.includes("/v/" + folder + "/") && sw.includes("/v/" + folder + "/"));
    ok("the deploy carries the patch", /lens\/patch-scramjet\.js/.test(fs.readFileSync(path.join(__dirname, "..", "tools", "make-deploy.js"), "utf8")));
    ok("the Wisp address ends in /", /"\/wisp\/" \+ encodeURIComponent\(pass\) \+ "\/"/.test(js));
    ok("searching uses DuckDuckGo's plain page, strict", /html\.duckduckgo\.com\/html\/\?kp=1&q=/.test(js));
    ok("YouTube is handed to the full mode", /youtube\\\.com/.test(js) && /t: "stream"/.test(js));
    ok("[hidden] hides, whatever display an element has", /\[hidden\]\{display:none!important\}/.test(read("client/lens.css")));
    ok("the pass leaves the address bar at once", /history\.replaceState\(null, "", location\.pathname\)/.test(js));
  }

  section("egress: YouTube leaves by WARP or a bought address");
  {
    const { Egress, hostMatches, parseProxy, ipv6Bytes } = require("../lens/egress");
    const socks = require("../lens/warp/socks");
    ok("the list matches a site and its subdomains, not look-alikes",
      hostMatches("rr3---sn-abc.googlevideo.com", ["googlevideo.com"]) && hostMatches("youtube.com", ["youtube.com"]) &&
      !hostMatches("notyoutube.com", ["youtube.com"]) && !hostMatches("youtube.com.evil.test", ["youtube.com"]));
    const pp = parseProxy("socks5://u%40x:p%3Aw@203.0.113.7:1080");
    ok("a proxy address keeps its login out of its name", pp && pp.user === "u@x" && pp.pass === "p:w" && pp.name === "socks5://203.0.113.7:1080");
    ok("only socks5:// and http:// with a port", !parseProxy("https://x:1") && !parseProxy("socks5://x") && !parseProxy("nonsense"));
    ok("IPv6 addresses are packed for SOCKS", ipv6Bytes("2001:db8::1").toString("hex") === "20010db8000000000000000000000001");
    ok("the WARP door refuses anything inside", socks.privateAddress("10.1.2.3") && socks.privateAddress("127.0.0.1") &&
      socks.privateAddress("169.254.169.254") && socks.privateAddress("192.168.0.1") && socks.privateAddress("100.64.0.9") &&
      socks.privateAddress("::1") && socks.privateAddress("fd00::1") && !socks.privateAddress("142.250.1.1") && !socks.privateAddress("2607:f8b0::1"));

    /* The real WARP door (warp/socks.js), told to allow loopback so the
       echo site can stand in for YouTube. */
    let viaDoor = 0;
    const door = socks.createServer({ allowLocal: true });
    door.on("connection", () => viaDoor++);
    await new Promise((r) => door.listen(0, "127.0.0.1", r));
    const strict = socks.createServer();
    await new Promise((r) => strict.listen(0, "127.0.0.1", r));
    /* A bought-style proxy: HTTP CONNECT with a login. */
    let viaHttp = 0, sawAuth = "";
    const hp = net.createServer((c) => {
      viaHttp++;
      c.once("data", (d) => {
        const head = String(d);
        sawAuth = (/Proxy-Authorization: Basic (\S+)/.exec(head) || [])[1] || "";
        const m = /^CONNECT ([\d.]+):(\d+)/.exec(head);
        if (!m || Buffer.from(sawAuth, "base64").toString() !== "ana:secret") return c.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        const up = net.connect({ host: m[1], port: Number(m[2]) }, () => { c.write("HTTP/1.1 200 Connection established\r\n\r\n"); c.pipe(up); up.pipe(c); });
        up.on("error", () => c.destroy());
      });
      c.on("error", () => {});
    });
    await new Promise((r) => hp.listen(0, "127.0.0.1", r));
    const DOOR = door.address().port, HP = hp.address().port, STRICT = strict.address().port;
    const dead = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

    const roundTrip = async (egress, who, host) => {
      const S = await start({ egress });
      const k = await client(S.port, who);
      k.connect(1, host, ECHO);
      k.data(1, "ping");
      await k.want((p) => p.type === W.T.DATA && p.id === 1, 4000);
      const said = k.dataOf(1).toString();
      k.c.close();
      S.httpServer.close();
      return { said, stats: S.server.stats };
    };

    const e1 = new Egress({ hosts: ["yt.test"], proxies: ["socks5://127.0.0.1:" + DOOR] });
    let r = await roundTrip(e1, "ana", "www.yt.test");
    ok("a listed site goes through the WARP door, and works", r.said === "ping" && viaDoor === 1 && r.stats.viaProxy === 1, JSON.stringify(r));
    r = await roundTrip(e1, "ana", "echo.test");
    ok("…any other site does not", r.said === "ping" && viaDoor === 1 && r.stats.viaProxy === 0);

    const e2 = new Egress({ hosts: ["yt.test"], proxies: ["http://ana:secret@127.0.0.1:" + HP] });
    r = await roundTrip(e2, "bo", "www.yt.test");
    ok("a bought address over HTTP CONNECT, with its login", r.said === "ping" && viaHttp === 1 && r.stats.viaProxy === 1);
    const e3 = new Egress({ hosts: ["yt.test"], proxies: ["http://ana:wrong@127.0.0.1:" + HP] });
    r = await roundTrip(e3, "bo", "www.yt.test");
    ok("a refused login rests that proxy and the site still opens directly", r.said === "ping" && r.stats.proxyMissed === 1 && !e3.usable());

    const e4 = new Egress({ hosts: ["yt.test"], proxies: ["socks5://127.0.0.1:" + dead, "socks5://127.0.0.1:" + DOOR] });
    const before = viaDoor;
    r = await roundTrip(e4, "cy", "www.yt.test");
    const firstWas = e4.order("cy")[0];
    ok("a proxy that is down is passed over for the next", r.said === "ping" && viaDoor === before + 1 && e4.usable());
    ok("…and is tried last until its minute is up", firstWas.name === "socks5://127.0.0.1:" + DOOR);

    const e5 = new Egress({ hosts: ["yt.test"], proxies: ["socks5://127.0.0.1:" + STRICT] });
    r = await roundTrip(e5, "dee", "www.yt.test");
    ok("the real WARP door will not open an address inside (lens then goes direct)", r.said === "ping" && r.stats.proxyMissed === 1);

    const many = new Egress({ proxies: ["socks5://198.51.100.1:1", "socks5://198.51.100.2:1", "socks5://198.51.100.3:1"] });
    ok("one person keeps one address (a video is tied to the address that asked)",
      many.order("ana")[0] === many.order("ana")[0] && ["a", "b", "c", "d", "e", "f", "g", "h"].map((w) => many.order(w)[0].name).filter((v, i, a) => a.indexOf(v) === i).length > 1);
    ok("with no list given, it is YouTube's hosts", many.wants("www.youtube.com") && many.wants("rr1---sn-x.googlevideo.com") && !many.wants("www.google.com"));
    ok("no proxies: nothing is sent anywhere else", !new Egress({ proxies: [] }).wants("www.youtube.com"));

    door.close(); strict.close(); hp.close();
  }

  section("the lens page: YouTube here when it can, and the sign-in warning");
  {
    const js = fs.readFileSync(path.join(__dirname, "..", "lens", "client", "lens.js"), "utf8");
    const page = fs.readFileSync(path.join(__dirname, "..", "lens", "client", "index.html"), "utf8");
    const srv = fs.readFileSync(path.join(__dirname, "..", "lens", "server.js"), "utf8");
    ok("the server says whether YouTube can play here", /youtube: !!\(egress && egress\.usable\(\)\)/.test(srv));
    ok("…and the page plays it here when so, handing it over only when not", /youtubeHere = !!\(st && st\.youtube\)/.test(js) && /if \(youtubeHere \|\| !HANDOFF/.test(js));
    ok("the bar always says not to sign in", /id="warn"[^>]*>⚠ Not private: do not sign in/.test(page));
    ok("…and a password box says it again, loudly", /String\(t\.type\)\.toLowerCase\(\) !== "password"/.test(js) && /STOP: do not type a password here/.test(js));
    const setup = fs.readFileSync(path.join(__dirname, "..", "lens", "setup.sh"), "utf8");
    ok("setup runs WARP in a container of its own, its door on loopback only",
      /docker run -d --name fk-warp/.test(setup) && /-p 127\.0\.0\.1:1080:1080/.test(setup) && /--cap-drop ALL --cap-add NET_ADMIN/.test(setup));
    ok("…and writes the egress file once, never over one with bought addresses", /if \[ ! -f "\$ETC\/egress\.json" \]/.test(setup) && /chmod 600 "\$ETC\/egress\.json"/.test(setup));
    ok("…and takes 0.9.0's full mode off this machine", /docker rm -f fk-full/.test(setup) && !/fk-full --restart/.test(setup));
    const start = fs.readFileSync(path.join(__dirname, "..", "lens", "warp", "start.sh"), "utf8");
    ok("the WARP container runs nothing fetched from elsewhere, and drops to an ordinary user",
      /exec setpriv --reuid=node/.test(start) && !/github\.com|wgcf/.test(start) &&
      !/curl[^\n]*\| *(sh|bash)/.test(start + fs.readFileSync(path.join(__dirname, "..", "lens", "warp", "Dockerfile"), "utf8")));
    const deploy = fs.readFileSync(path.join(__dirname, "..", "tools", "make-deploy.js"), "utf8");
    ok("the deploy carries egress and the WARP container", /"lens\/egress\.js"/.test(deploy) && /"lens\/warp\/start\.sh"/.test(deploy) && /"lens\/warp\/socks\.js"/.test(deploy));
  }

  section("a client that sends first");
  {
    /* The fix in relay/ws.js: a frame that arrives with the 101. */
    const F = http.createServer();
    F.on("upgrade", (req, sock) => {
      const key = req.headers["sec-websocket-key"];
      const frame = Buffer.from([0x82, 3, 9, 8, 7]);
      sock.write(Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        ws.acceptFor(key) + "\r\n\r\n"), frame]));
    });
    await new Promise((r) => F.listen(0, "127.0.0.1", r));
    const c = await ws.connect("ws://127.0.0.1:" + F.address().port + "/");
    const m = await Promise.race([new Promise((r) => c.on("message", (d) => r(d))), sleep(1000)]);
    ok("ws.connect keeps a frame that came in the same packet as the 101", Buffer.isBuffer(m) && m.length === 3 && m[0] === 9);
    c.close(1000);
    F.close();
  }

  A.server.close();
  A.httpServer.close();
  echo.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log("\nRESULT  pass " + pass + "  fail " + fail);
  if (fail) { console.log("FAILED: " + failures.join("; ")); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.log("CRASHED", e.stack); process.exit(1); });
