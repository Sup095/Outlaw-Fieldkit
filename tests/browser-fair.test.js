/* ============================================================
   The streamed browser's fair share (RUNNER_PLAN.md §22, phase 7b part
   2) — relay/fairness.js on a fake clock, the signed upload report
   between the two machines, and the browser's line through the route.

   What matters:
     1. Only a NEW browser session waits; admins and the vault holder
        never do, and members wait ahead of guests.
     2. The thresholds are the ones set in RUNNER's ADMIN when Bastion
        2 has spoken lately, and safe defaults when it has not.
     3. The upload counted is the house's: the relay's own and RUNNER's.
     4. A load report is never a ticket, nor a ticket a report, and
        each is believed once.
     5. Video steps down before anyone waits, and back up only when
        that would not push the upload straight back over.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { makeRunner } = require("./harness");
const { Fairness, readCgroup, DEFAULTS, STEPS } = require("../relay/fairness");
const venc = require("../relay/video-encoder");
const { Engine } = require("../relay/browser-engine");
const route = require("../relay/browser-route");
const relayRunner = require("../relay/runner");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");

const { ok, section, state } = makeRunner("browser-fair");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-browser-fair-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return false; };

(async () => {
  section("the meter: this container, not the machine");
  {
    let clock = 1800000000000, r = { cpuUsec: 0, cpus: 3, memUsed: 1e9, memLimit: 4e9 };
    const f = new Fairness({ now: () => clock, read: () => r });
    f.sample();
    r = { cpuUsec: 1.5e6, cpus: 3, memUsed: 1e9, memLimit: 4e9 };
    f.count(125000);
    clock += 1000;
    const m = f.sample();
    ok("processor is a share of the container's own processors (1.5 of 3 = 50%)", m.cpu === 50, JSON.stringify(m));
    ok("memory is a share of its own limit", m.mem === 25);
    ok("upload is what the browser sent (125 kB in 1 s = 1000 kbit/s)", m.upKbps === 1000);
    const real = readCgroup();
    ok("the real reading gives numbers here too", real.cpus > 0 && real.memLimit > 0 && real.cpuUsec >= 0, JSON.stringify(real));
  }

  section("who fits");
  {
    let clock = 1800000000000, peer = null;
    const f = new Fairness({ now: () => clock, read: () => ({}), peer: () => peer });
    const at = (cpu, mem, up) => { f.meter.cpu = cpu; f.meter.mem = mem; f.meter.upKbps = up; };
    at(10, 10, 0);
    ok("with no word from Bastion 2, the defaults", JSON.stringify(f.settings()) === JSON.stringify(DEFAULTS));
    ok("a quiet relay lets a guest in", f.fits("guest", true));
    ok("but never without a free session", !f.fits("guest", false) && f.why("guest", false) === "every browser session is in use");
    ok("an admin always", f.fits("admin", false));
    at(55, 10, 0);
    ok("a guest waits above their line (55 + 10 > 60)", !f.fits("guest", true) && f.why("guest", true) === "the relay is busy");
    ok("a member does not", f.fits("member", true));
    at(10, 80, 0);
    ok("memory counts too", !f.fits("member", true) && /memory/.test(f.why("member", true)));

    at(10, 10, 5000);
    peer = { upKbps: 5000, at: clock, settings: { guest: { load: 30, upload: 40 }, member: { load: 90, upload: 90 }, uploadMbps: 20 } };
    ok("RUNNER's thresholds are used while fresh", f.settings().guest.load === 30);
    ok("the house upload is both machines' ((5000 + 5000 + 800) / 20000 = 54%)", Math.round(f.upPct(800)) === 54);
    ok("so a guest waits for the upload", !f.fits("guest", true) && /upload/.test(f.why("guest", true)));
    ok("and a member does not", f.fits("member", true));
    clock += 31000;
    ok("RUNNER's upload is forgotten after 30 s", f.peerUp() === 0);
    clock += 30000;
    ok("its thresholds after 60 s", f.settings().guest.load === DEFAULTS.guest.load);
    peer = { at: clock, settings: { guest: { load: "x" }, member: null } };
    ok("nonsense thresholds are not used", f.settings().guest.load === DEFAULTS.guest.load && f.settings().member.load === DEFAULTS.member.load);
  }

  section("the line");
  {
    const f = new Fairness({ now: () => 1, read: () => ({}) });
    f.meter.cpu = 99;
    const g1 = f.join("g1", "guest"), g2 = f.join("g2", "guest"), m1 = f.join("m1", "member");
    ok("members ahead of guests, then first come", f.ordered().map((e) => e.who).join() === "m1,g1,g2");
    ok("each knows their place", f.place(g2).place === 3 && f.place(g2).ahead === 2 && f.place(m1).ahead === 0);
    ok("a guest sees others ahead; a member sees no guest ahead", f.someoneAhead("guest") && f.someoneAhead("member") === true);
    ok("nobody is let in while it is busy", f.pump(true) === null && f.line.length === 3);
    f.meter.cpu = 10;
    let went = false;
    m1.ready.then(() => { went = true; });
    ok("one at a time when there is room", f.pump(true) === m1 && f.line.length === 2);
    await wait(0);
    ok("and the one let in is told", went);
    ok("no session free, nobody goes", f.pump(false) === null);
    f.leave(g1);
    ok("leaving takes you out", f.ordered().map((e) => e.who).join() === "g2");
    let full = null;
    try { for (let i = 0; i < 50; i++) f.join("x" + i, "guest"); } catch (e) { full = e.message; }
    ok("the line has an end", /full/.test(full || ""));
  }

  section("video steps down before anyone waits");
  {
    let clock = 1800000000000, peer = null;
    const f = new Fairness({ now: () => clock, read: () => ({}), peer: () => peer });
    const up = (kbps) => { f.meter.upKbps = kbps; };   /* of 20000: 1% per 200 */
    up(2000);
    ok("a quiet house: full quality", f.videoKbps(1500) === 1500 && f.step === 0);
    up(10400);
    ok("past the guests' line (52% > 50%): one step down at once", f.videoKbps(1500) === Math.round(1500 * STEPS[1]));
    up(17400);
    ok("past the members' line (87% > 85%): two", f.videoKbps(1500) === Math.round(1500 * STEPS[2]));
    up(6000);
    clock += 10000;
    ok("calm for 10 s: it stays down", f.videoKbps(1500) === 600);
    clock += 25000;
    ok("calm for 30 s: up one step", f.videoKbps(1500) === 1005 && f.step === 1);
    clock += 31000;
    up(8000);
    ok("not back to full if full would cross the guests' line again (8000 at 0.67 is ~12000 = 60%)", f.videoKbps(1500) === 1005);
    up(4000);
    clock += 31000;
    ok("back to full when it would fit", f.videoKbps(1500) === 1500 && f.step === 0);
    f.join("g", "guest");
    ok("someone waiting for the browser is reason enough", f.videoKbps(1500) === 1005);
    f.line.length = 0;
    clock += 31000;
    f.videoKbps(1500);
    ok("(back at full first)", f.step === 0);
    peer = { waiting: 2, at: clock, upKbps: 0 };
    ok("and so is someone waiting on Bastion 2", f.videoKbps(1500) === 1005 && f.view().videoStep === 1);
  }

  section("the encoder takes a new bitrate from the next picture");
  {
    const LOG = path.join(TMP, "ff.log");
    process.env.FK_FAKE_FFMPEG_LOG = LOG;
    const FAKE = [process.execPath, path.join(__dirname, "fake-ffmpeg.js")];
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, 0, 200, 1, 44, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const pic = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(64, 0x55), Buffer.from([0, 0, 0, 7])]);
    const tx = new venc.Transcoder({ ffmpeg: FAKE, kbps: 1500, maxFps: 1000 });
    const starts = [], keys = [];
    tx.on("start", (z) => starts.push(z));
    tx.on("frame", (au, key) => keys.push(key));
    tx.feed(pic);
    await until(() => keys.length >= 1);
    ok("the same bitrate changes nothing", tx.setKbps(1500) === false);
    ok("a new one is taken", tx.setKbps(600) === true);
    await wait(5);
    tx.feed(pic);
    await until(() => keys.length >= 2);
    const runs = fs.readFileSync(LOG, "utf8").split(/\r?\n/).filter((l) => l.startsWith("start"));
    ok("through a fresh encoder at the new cap", starts.length === 2 && runs.length === 2 && /-maxrate 600k/.test(runs[1]) && /-maxrate 1500k/.test(runs[0]), runs.join(" | "));
    ok("which starts with a keyframe", keys[1] === true);
    tx.close();
    delete process.env.FK_FAKE_FFMPEG_LOG;
  }

  section("the load report: one home line, two machines");
  {
    relayRunner.init({ dataDir: path.join(TMP, "relay"), log: () => {}, whoami: () => null,
      config: { enabled: true, publicUrl: "http://127.0.0.1:1" } });
    const pem = relayRunner._internals.publicPem();
    const key = ticket.loadPublicKey(pem);
    const rep = relayRunner._internals.signReport({ up: 1234.4, cpu: 20, mem: 30, wait: 2 });
    const v = ticket.verifyReport(key, rep);
    ok("what the relay signs, the run server reads", v.ok && v.claims.up === 1234 && v.claims.aud === "fieldkit-load");
    ok("a report is not a ticket", !ticket.verify(key, rep).ok);
    ok("a ticket is not a report", !ticket.verifyReport(key, relayRunner._internals.signTicket("alice", "admin")).ok);
    const parts = rep.split(".");
    const body = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    body.up = 1;
    ok("an altered report is not believed", !ticket.verifyReport(key, Buffer.from(JSON.stringify(body)).toString("base64url") + "." + parts[1]).ok);
    ok("an old one is not believed", !ticket.verifyReport(key, rep, Date.now() + 31000).ok);
    const other = crypto.generateKeyPairSync("ed25519");
    ok("nor one checked with another key", !ticket.verifyReport(other.publicKey, rep).ok);

    relayRunner._internals.remember({ load: { upKbps: 900, waiting: 3, settings: { guest: { load: 1, upload: 2 } } } });
    const l = relayRunner.load();
    ok("the relay remembers Bastion 2's answer", l.upKbps === 900 && l.waiting === 3 && l.settings.guest.load === 1 && l.at > 0);
    relayRunner._internals.remember({ service: "something else" });
    ok("an answer without numbers changes nothing", relayRunner.load().upKbps === 900);

    /* The run server's half. */
    const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
      storePath: path.join(TMP, "store"), driver: "process", dev: true, ticketPublicKey: pem }), () => {});
    const port = await app.listen();
    const get = (q) => new Promise((resolve, reject) => {
      http.get("http://127.0.0.1:" + port + "/health" + (q || ""), (res) => {
        let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(JSON.parse(b)));
      }).on("error", reject);
    });
    const h0 = await get();
    ok("the health check says its load and thresholds", h0.load && typeof h0.load.upKbps === "number" &&
      h0.load.settings.guest.load === 60 && h0.load.settings.member.upload === 85 && h0.load.waiting === 0, JSON.stringify(h0.load));
    ok("and nothing about anyone", !/handle|who|name/.test(JSON.stringify(h0.load)));
    const up0 = app.access.upPct(0);
    const r1 = relayRunner._internals.signReport({ up: 10000 });
    await get("?load=" + encodeURIComponent(r1));
    ok("the relay's upload counts against the house line (10000 of 20000 = +50%)", Math.round(app.access.upPct(0) - up0) === 50);
    ok("and shows in ADMIN's meter", app.access.view(0).meter.relayUpKbps === 10000);
    const r2 = relayRunner._internals.signReport({ up: 0 });
    await get("?load=" + encodeURIComponent(r2));
    ok("a newer report replaces it", app.access.upPct(0) === up0);
    await get("?load=" + encodeURIComponent(r1));
    ok("a report is believed once", app.access.upPct(0) === up0);
    await get("?load=" + encodeURIComponent(relayRunner._internals.signTicket("x", "admin")));
    await get("?load=garbage");
    ok("anything else is ignored, and health still answers", app.access.upPct(0) === up0);
    await app.close();
    relayRunner._internals.forget && relayRunner._internals.forget();
  }

  section("the engine: room, and admins past the cap");
  {
    const eng = new Engine({ config: { enabled: false, maxSessions: 1 }, log: () => {} });
    clearInterval(eng._sweep);
    ok("room while under the cap", eng.hasRoom());
    eng.sessions.set("a", { key: "a", viewers: new Set([1]), lastSeen: 0 });
    ok("none when everyone is watched", !eng.hasRoom());
    eng.sessions.get("a").viewers.clear();
    ok("room again when a session has nobody looking (it can be ended)", eng.hasRoom());
  }

  section("the browser's line through the route");
  {
    const f = new Fairness({ now: Date.now, read: () => ({}) });
    const rt = route.init({ config: { enabled: true, video: false }, log: () => {}, fairness: f });
    rt.sessionFor = async (who) => { rt.sessions.set(String(who), {}); return { url: "about:blank", title: "", zoom: 1 }; };
    rt.resize = async () => {};
    rt.attach = async () => {};
    rt.detach = async () => {};
    const srv = http.createServer();
    srv.on("upgrade", (req, sock, head) => route.upgrade(req, sock, head, new URL(req.url, "http://x")));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const open = async (who, tier) => {
      const sock = new WebSocket("ws://127.0.0.1:" + srv.address().port + "/browser/stream?t=" + route._internals.issue(who, tier));
      sock.got = [];
      sock.addEventListener("message", (e) => { if (typeof e.data === "string") sock.got.push(JSON.parse(e.data)); });
      await new Promise((r) => sock.addEventListener("open", r));
      sock.send(JSON.stringify({ t: "hello", w: 800, h: 600 }));
      return sock;
    };
    const has = (s, t) => s.got.some((m) => m.t === t);
    /* Wait for each close: a socket still closing at exit aborts Node on Windows. */
    const shut = (s) => new Promise((r) => { if (s.readyState === 3) return r(); s.addEventListener("close", r); s.close(); });

    f.meter.cpu = 95;
    const g = await open("msg:gina", "guest");
    await until(() => has(g, "queued"));
    const q = g.got.find((m) => m.t === "queued");
    ok("a guest on a busy relay is told their place and why", q && q.ahead === 0 && q.place === 1 && q.why === "the relay is busy", JSON.stringify(q));
    ok("and has no session yet", !has(g, "ready") && !rt.sessions.has("msg:gina"));
    const m = await open("msg:mo", "member");
    await until(() => has(m, "queued"));
    ok("a member waits too, at 95%", has(m, "queued"));
    ok("but goes ahead of the guest", f.ordered()[0].who === "msg:mo");
    const boss = await open("vault", "admin");
    await until(() => has(boss, "ready"));
    ok("the vault holder never waits", has(boss, "ready") && !has(boss, "queued"));

    await shut(m);
    await until(() => f.line.length === 1);
    ok("closing the panel leaves the line", f.line.length === 1 && f.line[0].who === "msg:gina");

    f.meter.cpu = 10;
    f.pump(rt.hasRoom());
    await until(() => has(g, "ready"));
    ok("with room, the first in line connects by itself", has(g, "ready") && rt.sessions.has("msg:gina"));
    await shut(g);

    f.meter.cpu = 95;
    const again = await open("msg:gina", "guest");
    await until(() => has(again, "ready") || has(again, "queued"));
    ok("someone already browsing never waits (a second tab, a reconnect)", has(again, "ready"));
    await shut(again);

    const tk = route._internals.issue("u");
    ok("a ticket issued without a tier is the vault holder's (the only caller that omits it)", route._internals.tickets.get(tk).tier === "admin");
    await shut(boss);
    await new Promise((r) => srv.close(r));
    await wait(400);          /* undici finishes closing; exiting sooner aborts Node on Windows */
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
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
