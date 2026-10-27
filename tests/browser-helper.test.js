/* ============================================================
   Browser helpers (FIELDKIT_PROJECT.md §14.38) — relay/overflow.js on
   the relay, relay/browser-helper.js on Bastion 2, and the browser
   route between them, with both machines in this one process (each
   with its own copy of browser-route.js, as two processes would have)
   and stand-ins for Chromium.

   What matters:
     1. A helper does nothing for anyone without a pass signed by the
        relay's key: not its state, not a stream, not a download. A
        pass is for one purpose and is spent on use.
     2. A new session goes to the helper only when the relay is full,
        and someone already on the helper goes back to it.
     3. The panel only ever talks to the relay: the stream is passed
        through (and counted in the house upload), and a download link
        comes back through the relay too.
     4. A helper that is down or says no is not an outage: the panel
        is served on the relay instead, or waits there as before.
     5. Someone waiting is moved to the helper when it has room.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { makeRunner } = require("./harness");
const { Overflow, sign, verify, Spent, parseUrl, PASS_MS } = require("../relay/overflow");
const { Fairness } = require("../relay/fairness");
const route = require("../relay/browser-route");

/* The helper's own copy of browser-route.js, as on Bastion 2. */
delete require.cache[require.resolve("../relay/browser-route")];
delete require.cache[require.resolve("../relay/browser-helper")];
const helperMod = require("../relay/browser-helper");
const helperRoute = require("../relay/browser-route");

const { ok, section, state } = makeRunner("browser-helper");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-browser-helper-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 4000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return false; };

/* An engine that keeps sessions in a Map and does nothing else. */
function standIn(engine, extra) {
  engine.sessionFor = async (who) => {
    if (!engine.sessions.has(String(who))) engine.sessions.set(String(who), { key: String(who), who: String(who), tier: "member", viewers: new Set(), tabs: [{}], lastSeen: Date.now() });
    return Object.assign(engine.sessions.get(String(who)), { url: "about:blank", title: "", zoom: 1 });
  };
  engine.resize = async () => {};
  engine.attach = async (s, v) => { s.viewers.add(v); };
  engine.detach = async (s, v) => { s.viewers.delete(v); };
  engine.start = async () => true;
  Object.assign(engine, extra || {});
  return engine;
}

function get(port, p, method, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: method || "GET", headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body || undefined);
  });
}
const json = (r) => { try { return JSON.parse(r.body.toString("utf8")); } catch (e) { return null; } };

(async () => {
  section("passes");
  {
    const a = crypto.generateKeyPairSync("ed25519"), b = crypto.generateKeyPairSync("ed25519");
    const p = sign(a.privateKey, { what: "state", step: 1 });
    const v = verify(a.publicKey, p);
    ok("a pass the relay signed is believed, purpose and all", v.ok && v.claims.what === "state" && v.claims.step === 1);
    ok("one signed by any other key is not", !verify(b.publicKey, p).ok && /signature/.test(verify(b.publicKey, p).why));
    ok("nor once its minute is up", !verify(a.publicKey, p, Date.now() + PASS_MS + 1).ok);
    const body = Buffer.from(JSON.stringify({ v: 1, aud: "fieldkit-runner", what: "state", exp: Date.now() + 1000, n: "x".repeat(16) })).toString("base64url");
    ok("nor a RUNNER ticket made with the same key", !verify(a.publicKey, body + "." + crypto.sign(null, Buffer.from(body), a.privateKey).toString("base64url")).ok);
    ok("nor nonsense", !verify(a.publicKey, "nonsense").ok && !verify(a.publicKey, "a.b.c").ok && !verify(a.publicKey, "x".repeat(3000)).ok);
    const s = new Spent();
    ok("and each is spent on use", s.use(v.claims) && !s.use(v.claims));
    ok("a helper's address is http://address:port and nothing else",
      parseUrl("http://192.0.2.7:25570").port === 25570 && !parseUrl("https://x:1") && !parseUrl("http://x:1/path") && !parseUrl("nope"));
  }

  /* ---- the two machines ---- */
  const f = new Fairness({ now: Date.now, read: () => ({}) });
  let ov;
  const relayKey = { base: "https://relay.example.com", key: null, due: () => false, load: async () => true };
  const helper = await helperMod.start({ relayKey,
    config: { host: "127.0.0.1", port: 0, dataDir: path.join(TMP, "helper"), helper: { relayUrl: relayKey.base },
      browser: { enabled: true, video: false, maxSessions: 2 }, browse: {} } });
  const hEngine = standIn(helper.engine, { status: () => ({ available: true }) });
  const hPort = helper.server.address().port;
  const DL = path.join(TMP, "report.txt");
  fs.writeFileSync(DL, "the downloaded file's bytes");
  const cleared = [];
  hEngine.download = (s, id) => (id === "d1" ? { size: fs.statSync(DL).size, name: "report.txt", path: DL } : null);
  hEngine.clearAll = async (s) => { cleared.push(s.key); };

  ov = new Overflow({ urls: ["http://127.0.0.1:" + hPort, "https://not-a-helper.example"], dataDir: path.join(TMP, "relay"), log: () => {} });
  relayKey.key = crypto.createPublicKey(ov.keys.publicPem);
  const rEngine = standIn(route.init({ config: { enabled: true, video: false, maxSessions: 1 }, log: () => {}, fairness: f, overflow: ov }));
  rEngine.cfg.maxSessions = 1;
  const send = (res, status, body) => { const t = JSON.stringify(body); res.writeHead(status, { "Content-Type": "application/json" }); res.end(t); };
  const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || "{}")); } catch (e) { resolve({}); } }); });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, "http://relay");
    const who = req.headers["x-who"] || null;
    route.route(req, res, url, { send, readBody, authorise: () => who, tierOf: () => req.headers["x-tier"] || "member" })
      .then((done) => { if (!done) send(res, 404, {}); });
  });
  relay.on("upgrade", (req, sock, head) => route.upgrade(req, sock, head, new URL(req.url, "http://relay")));
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const rPort = relay.address().port;

  section("a helper answers nobody but the relay");
  {
    ok("an address that is not http://address:port is not used", ov.helpers.length === 1);
    let r = await get(hPort, "/health");
    ok("its health says it is a helper and nothing more", r.status === 200 && json(r).service === "fieldkit-browser-helper");
    r = await get(hPort, "/helper/state");
    ok("no pass: nothing", r.status === 401);
    const stranger = crypto.generateKeyPairSync("ed25519");
    r = await get(hPort, "/helper/state", "GET", null, { "X-FieldKit-Pass": sign(stranger.privateKey, { what: "state" }) });
    ok("a pass from any other key: nothing", r.status === 401);
    const usagePass = ov.pass({ what: "usage" });
    r = await get(hPort, "/helper/state", "GET", null, { "X-FieldKit-Pass": usagePass });
    ok("a pass for something else: nothing", r.status === 401);
    const p = ov.pass({ what: "state" });
    r = await get(hPort, "/helper/state", "GET", null, { "X-FieldKit-Pass": p });
    ok("the relay's pass: its free sessions, load and who is there", r.status === 200 && json(r).free === 2 && Array.isArray(json(r).sessions), r.body.toString());
    r = await get(hPort, "/helper/state", "GET", null, { "X-FieldKit-Pass": p });
    ok("the same pass twice: nothing", r.status === 401);
    r = await get(hPort, "/browser/file/abcdef");
    ok("a download link without a pass: nothing", r.status === 401);
    const s = await new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:" + hPort + "/browser/stream");
      ws.addEventListener("open", () => resolve("open"));
      ws.addEventListener("error", () => resolve("refused"));
    });
    ok("a stream without a pass: refused", s === "refused");
    r = await get(hPort, "/vault");
    ok("and it is not a relay: no vault, no accounts", r.status === 404);
  }

  const open = async (who, tier) => {
    const res = await get(rPort, "/browser/ticket", "POST", null, { "x-who": who, "x-tier": tier });
    const sock = new WebSocket("ws://127.0.0.1:" + rPort + "/browser/stream?t=" + json(res).ticket);
    sock.got = [];
    sock.addEventListener("message", (e) => { if (typeof e.data === "string") sock.got.push(JSON.parse(e.data)); });
    sock.closed = new Promise((r) => sock.addEventListener("close", r));
    await new Promise((r) => sock.addEventListener("open", r));
    sock.send(JSON.stringify({ t: "hello", w: 800, h: 600 }));
    return sock;
  };
  const has = (s, t) => s.got.some((m) => m.t === t);
  const shut = (s) => new Promise((r) => { if (s.readyState === 3) return r(); s.addEventListener("close", r); s.close(); });

  section("new sessions go to the helper when the relay is full");
  {
    await ov.poll(ov.helpers[0]);
    ok("the relay has heard from it", ov.fresh(ov.helpers[0]) && ov.helpers[0].state.free === 2);
    const alice = await open("msg:alice", "member");
    await until(() => has(alice, "ready"));
    ok("with a free session here, the first person stays here", has(alice, "ready") && rEngine.sessions.has("msg:alice") && !hEngine.sessions.has("msg:alice"));
    const sentBefore = f.sent;
    const bob = await open("msg:bob", "member");
    await until(() => has(bob, "ready"));
    ok("the relay full, the next goes to the helper", has(bob, "ready") && hEngine.sessions.has("msg:bob") && !rEngine.sessions.has("msg:bob"));
    ok("through the relay's own socket, counted in the house upload", f.sent > sentBefore);

    /* A download on the helper: the link points back at the relay. */
    const viewer = Array.from(helperRoute._internals.viewers)[0];
    viewer.onEvent({ t: "download", state: "completed", id: "d1", name: "report.txt" });
    await until(() => has(bob, "download"));
    const d = bob.got.find((m) => m.t === "download");
    ok("a download's link goes through the relay", d && /^\/browser\/via\/0\/file\/[0-9a-f]+$/.test(d.url), d && d.url);
    const before = f.sent;
    const r = await get(rPort, d.url);
    ok("and fetching it there gives the helper's file", r.status === 200 && r.body.toString() === "the downloaded file's bytes");
    ok("counted as upload too", f.sent >= before + r.body.length);
    ok("a link works once", (await get(rPort, d.url)).status === 404);

    await ov.poll(ov.helpers[0]);
    ok("the relay knows bob is on the helper", ov.holding("msg:bob") === ov.helpers[0] && ov.sessionsOut() >= 1);
    await shut(alice);
    rEngine.sessions.delete("msg:alice");
    await shut(bob);
    await until(() => ov.helpers[0].piped === 0);
    const again = await open("msg:bob", "member");
    await until(() => has(again, "ready"));
    ok("coming back, bob goes to his session on the helper even with room here", has(again, "ready") && !rEngine.sessions.has("msg:bob"));

    const c = await get(rPort, "/browser/clear", "POST", JSON.stringify({ what: "everything" }), { "x-who": "msg:bob" });
    ok("CLEAR for a session on the helper reaches the helper", c.status === 200 && cleared.indexOf("msg:bob") >= 0, c.body.toString());
    const u = json(await get(rPort, "/browser/usage", "GET", null, { "x-who": "vault", "x-tier": "admin" }));
    ok("an admin's USAGE includes the helper and its sessions",
      u && u.helpers && u.helpers[0].usage && u.helpers[0].usage.sessions.some((s) => s.who === "msg:bob"), JSON.stringify(u && u.helpers));
    ok("the status says how many helpers are up", json(await get(rPort, "/browser/status")).helpers[0].up === true);
    ok("the helper's public key is public", /BEGIN PUBLIC KEY/.test(json(await get(rPort, "/browser/helper-key")).key));
    await shut(again);
  }

  section("someone waiting moves to the helper when it has room");
  {
    const carol = await open("msg:carol", "member");
    await until(() => has(carol, "ready"));
    ok("carol takes the relay's one session", rEngine.sessions.has("msg:carol"));
    hEngine.sessions.set("msg:x", { key: "msg:x", viewers: new Set([1]), tabs: [] });
    hEngine.sessions.set("msg:y", { key: "msg:y", viewers: new Set([1]), tabs: [] });
    hEngine.sessions.delete("msg:bob");
    await ov.poll(ov.helpers[0]);
    ok("the helper is full too", ov.helpers[0].state.free === 0);
    const dan = await open("msg:dan", "member");
    await until(() => has(dan, "queued"));
    ok("so dan waits on the relay, as before", has(dan, "queued") && !has(dan, "ready"));
    hEngine.sessions.delete("msg:y");
    await ov.poll(ov.helpers[0]);
    await until(() => has(dan, "moved"), 5000);
    ok("a session comes free on the helper: dan is told to connect again", has(dan, "moved"));
    await dan.closed;
    const dan2 = await open("msg:dan", "member");
    await until(() => has(dan2, "ready"));
    ok("and connecting again lands him there", has(dan2, "ready") && hEngine.sessions.has("msg:dan"));
    await shut(dan2);
    await shut(carol);
    hEngine.sessions.clear();
  }

  section("a helper that is down is not an outage");
  {
    rEngine.sessions.clear();
    const erin = await open("msg:erin", "member");
    await until(() => has(erin, "ready"));
    /* The helper said it had room a moment ago, and then it went away. */
    await ov.poll(ov.helpers[0]);
    await new Promise((r) => helper.server.close(r));
    helper.server.closeAllConnections && helper.server.closeAllConnections();
    const fred = await open("msg:fred", "member");
    await until(() => has(fred, "queued") || has(fred, "ready"));
    ok("the next person is served by the relay instead (here: waits in its line)", has(fred, "queued"), JSON.stringify(fred.got));
    ok("and the helper is marked down", !!ov.helpers[0].down && !ov.fresh(ov.helpers[0]));
    await ov.poll(ov.helpers[0]);
    ok("polling it again says it is still down", !!ov.helpers[0].down);
    ok("so nobody is placed there", ov.pick("msg:gail", "member", f) === null);
    await shut(fred);
    await shut(erin);
  }

  section("the deploy bundle and start.js");
  {
    const mk = fs.readFileSync(path.join(__dirname, "..", "tools", "make-deploy.js"), "utf8");
    ok("both new relay files go into the image", /"overflow\.js"/.test(mk) && /"browser-helper\.js"/.test(mk));
    const st = fs.readFileSync(path.join(__dirname, "..", "relay", "start.js"), "utf8");
    ok("start.js runs the helper when config.json has a helper block", /browser-helper\.js/.test(st) && /\.helper\b/.test(st));
    const ex = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "relay", "helper-config.example.json"), "utf8"));
    ok("the helper's example config has a relay address and its own session count",
      /^https:\/\//.test(ex.helper.relayUrl) && ex.browser.maxSessions > 0);
    const rc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "relay", "config.example.json"), "utf8"));
    ok("the relay's example lists no helpers, so nothing changes until one is set", Array.isArray(rc.browser.helpers) && !rc.browser.helpers.length);
    const cfg = helperMod.readConfig(null);
    ok("a helper always binds every address unless told otherwise", cfg.host === "0.0.0.0" && cfg.browser.enabled === true);
  }

  ov.stop();
  await new Promise((r) => relay.close(r));
  await wait(400);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((x) => console.log("  - " + x));
  }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + (e.stack || e.message));
  process.exit(1);
});
