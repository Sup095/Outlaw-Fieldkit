/* ============================================================
   FieldKit tests :: upload-cap — the most FieldKit may send

   relay/upcap.js against real sockets on loopback: that what a server
   sends is held to the pace however it is written (one big response,
   many small ones, a WebSocket, two people at once), that nothing is
   lost or reordered on the way, that peers on the tailnet and the home
   network are not held, and that the meters on both machines count
   each byte once.

   node tests/upload-cap.test.js
   ============================================================ */
"use strict";

const http = require("http");
const ws = require("../relay/ws");
const { UpCap, Rate, nearby, paceFor, RESERVE_KBPS } = require("../relay/upcap");
const { both, Bucket } = require("../relay/guard");
const { Fairness } = require("../relay/fairness");
const { Access } = require("../runnerd/access");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra ? "\n        " + extra : "")); }
}
function section(s) { console.log("\n== " + s + " =="); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-upcap-"));

const BODY = Buffer.alloc(1024 * 1024);
for (let i = 0; i < BODY.length; i++) BODY[i] = (i * 31 + 7) & 255;

function serve(cap, handler) {
  const server = http.createServer(handler);
  cap.attach(server);
  server.on("upgrade", (req, sock) => {
    const s = ws.accept(req, sock, { maxPayload: 1 << 20 });
    if (!s) return;
    for (let i = 0; i < 40; i++) { const b = Buffer.alloc(32 * 1024, i); s.send(b); }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
function fetchAll(port, p) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => http.get("http://127.0.0.1:" + port + (p || "/"), (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ body: Buffer.concat(parts), ms: Date.now() - t0 }));
  }).on("error", reject));
}

(async () => {
  section("who is held");
  ok("the tailnet is not", nearby("100.64.0.106") && nearby("::ffff:100.64.0.1") && nearby("100.127.255.255"));
  ok("the home network is not", nearby("192.168.1.20") && nearby("fd7a:115c:a1e0::1"));
  ok("loopback is: the relay's tunnel connects from there", !nearby("127.0.0.1") && !nearby("::1"));
  ok("Docker's network is: runnerd's tunnel container is on it", !nearby("172.19.0.5"));
  ok("the internet is", !nearby("8.8.8.8") && !nearby("100.128.0.1") && !nearby("2606:4700::1111"));

  section("the pace");
  ok("12 Mbit/s, nothing else sending: 95% of it, in bytes", paceFor(12, 0) === Math.round(12 * 0.95 * 1e6 / 8));
  ok("the other machine's sending comes off it", paceFor(12, 4000) === Math.round((11400 - 4000) * 1000 / 8));
  ok("…never below a quarter, whatever a stale report says", paceFor(12, 1e9) === Math.round(11400 / 4 * 1000 / 8));
  ok("the reserve is taken out by both servers", RESERVE_KBPS === 2000);

  section("one big response is held to it");
  {
    const cap = new UpCap({ bps: 400 * 1024 });
    const server = await serve(cap, (req, res) => { res.writeHead(200); res.end(BODY); });
    const r = await fetchAll(server.address().port);
    ok("all of it arrives, unchanged", r.body.equals(BODY));
    /* 1 MB at 400 KB/s, a quarter of a second of it free: ~2.3 s. */
    ok("at the pace: about 2.3 s for 1 MB at 400 KB/s", r.ms >= 1900 && r.ms <= 4000, r.ms + " ms");
    ok("…and the bytes are counted", cap.sent >= BODY.length && cap.view().waited > 0);
    cap.setRate(0);
    const free = await fetchAll(server.address().port);
    ok("rate 0: not held at all", free.ms < 1000 && free.body.equals(BODY), free.ms + " ms");
    server.close();
  }

  section("two people share it");
  {
    const cap = new UpCap({ bps: 800 * 1024 });
    const server = await serve(cap, (req, res) => {
      res.writeHead(200);
      /* Many small writes, as a stream would make. */
      let i = 0;
      const more = () => { while (i < BODY.length) { const ok_ = res.write(BODY.subarray(i, i + 4096)); i += 4096; if (!ok_) return res.once("drain", more); } res.end(); };
      more();
    });
    const t0 = Date.now();
    const [a, b] = await Promise.all([fetchAll(server.address().port, "/a"), fetchAll(server.address().port, "/b")]);
    const all = Date.now() - t0;
    ok("both arrive whole", a.body.equals(BODY) && b.body.equals(BODY));
    ok("together they take what 2 MB takes at the pace (~2.3 s), not what one does", all >= 1900, all + " ms");
    ok("…and they finish close together: one does not wait for the other", Math.abs(a.ms - b.ms) < Math.max(900, all * 0.4), a.ms + " / " + b.ms + " of " + all);
    server.close();
  }

  section("a WebSocket through it");
  {
    const cap = new UpCap({ bps: 600 * 1024 });
    const server = await serve(cap, (req, res) => res.end());
    const t0 = Date.now();
    const c = await ws.connect("ws://127.0.0.1:" + server.address().port + "/", { maxPayload: 1 << 20 });
    const got = [];
    await new Promise((r) => c.on("message", (m) => { got.push(m); if (got.length === 40) r(); }));
    const ms = Date.now() - t0;
    ok("every frame arrives, in order, unchanged", got.every((m, i) => m.length === 32 * 1024 && m[0] === i && m[m.length - 1] === i));
    ok("at the pace (1.25 MB at 600 KB/s)", ms >= 1500, ms + " ms");
    c.close(1000);
    server.close();
  }

  section("a peer that does not use the upload");
  {
    const cap = new UpCap({ bps: 100 * 1024, exempt: () => true });
    const server = await serve(cap, (req, res) => { res.writeHead(200); res.end(BODY); });
    const r = await fetchAll(server.address().port);
    ok("is not held (1 MB at a 100 KB/s pace would take 10 s)", r.ms < 1500 && r.body.equals(BODY), r.ms + " ms");
    ok("…and is not counted", cap.sent === 0);
    server.close();
  }

  section("a pipe into a held socket slows at its source");
  {
    const cap = new UpCap({ bps: 200 * 1024 });
    let pausedSeen = false;
    const server = await serve(cap, (req, res) => {
      const { Readable } = require("stream");
      let n = 0;
      const src = new Readable({ highWaterMark: 16 * 1024, read() { n++; this.push(n <= 32 ? Buffer.alloc(16 * 1024, 1) : null); } });
      const watch = setInterval(() => { if (src.isPaused() || src.readableFlowing === false || res.writableNeedDrain) pausedSeen = true; }, 20);
      res.on("finish", () => clearInterval(watch));
      res.writeHead(200);
      src.pipe(res);
    });
    const r = await fetchAll(server.address().port);
    ok("the whole stream arrives", r.body.length === 32 * 16 * 1024);
    ok("the socket said it was full meanwhile, so the source waited", pausedSeen);
    server.close();
  }

  section("two limits on one direction");
  {
    const a = { take: () => 100 }, b = { take: () => 400 };
    ok("the longer wait wins", both(a, b).take(10) === 400);
    ok("either alone is itself", both(a, null) === a && both(null, b) === b && both(null, null) === null);
    const cap = new UpCap({ bps: 1000 });
    ok("UpCap is a bucket the guard can use (take(n) -> ms)", typeof cap.take(5000) === "number" && cap.take(5000) > 0);
    const egress = require("../runnerd/egress");
    ok("fk-egress: all sandboxes together get about 1 Mbit/s", Math.round(egress.settings().upTotalBps * 8 / 1000) === 983);
  }

  section("each byte counted once");
  {
    let t = 1e12;
    const rate = new Rate(() => t / 1000 * 125000, () => t);   /* 1 Mbit/s: 125000 bytes a second */
    rate.sample(); t += 2000;
    ok("Rate: bytes since the last reading, as kbit/s", rate.sample() === 1000);

    /* The relay: everything it sends (RUNNER through it included), and
       what Bastion 2 sends by itself. */
    let peer = { upKbps: 2000, at: t, settings: { uploadCapMbps: 12, guest: { load: 60, upload: 50 }, member: { load: 85, upload: 85 } } };
    const f = new Fairness({ now: () => t, read: () => ({}), peer: () => peer, net: () => 4000 });
    f.meter.upKbps = 1000;      /* the browser's part of the 4000 */
    ok("the relay counts its whole upload plus Bastion 2's own, against the ceiling", Math.round(f.upPct(0)) === 50);
    ok("the default ceiling is 12 Mbit/s", new Fairness({ now: () => t, read: () => ({}) }).settings().uploadCapMbps === 12);

    fs.writeFileSync(path.join(TMP, "s.json"), "{}");
    const a = new Access({ settingsFile: path.join(TMP, "s.json"), now: () => t, read: () => ({}), sent: () => 0,
      other: () => 4000, net: () => 2000 });
    a.meter.upKbps = 3000;      /* RUNNER's windows, most of them through the relay */
    ok("runnerd counts the relay's (RUNNER through it included) plus its own, not its windows twice", Math.round(a.upPct(0)) === 50);
    ok("and both machines arrive at the same share", Math.round(a.upPct(0)) === Math.round(f.upPct(0)));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\nRESULT  pass " + pass + "  fail " + fail);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((x) => console.log("  - " + x)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e && e.stack || e)); process.exit(1); });
