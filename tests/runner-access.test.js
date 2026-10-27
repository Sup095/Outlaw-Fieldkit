/* ============================================================
   RUNNER fair access (RUNNER_PLAN.md §22, phase 7b) — runnerd/access.js
   on a fake clock and fake load, then the whole line through a real
   run server.

   What matters:
     1. Each tier is let in only under its own line; admins always.
     2. Members wait ahead of every guest; nobody jumps a line by
        asking again; an admin can move someone to the front.
     3. A turn is held for 60 seconds and then passed on; a member who
        drops keeps their place for 2 minutes, a guest does not.
     4. While people wait, others' runs are held to their share, and
        admins' never are.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { makeRunner } = require("./harness");
const { connect, wait } = require("./runner-kit");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");
const { Access, STEPS } = require("../runnerd/access");

const { ok, section, state } = makeRunner("runner-access");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-access-"));
const MIN = 60000;

(async () => {
  let clock = 1800000000000, sent = 0, proc = { cpuTotal: 0, cpuIdle: 0, mem: 20 };
  const a = new Access({ settingsFile: path.join(TMP, "a.json"), now: () => clock, read: () => proc, sent: () => sent });

  section("the meter");
  {
    a.sample();
    proc = { cpuTotal: 1000, cpuIdle: 700, mem: 42.5 };
    sent = 1250000; clock += 1000;
    const m = a.sample();
    ok("processor: busy share since the last reading", m.cpu === 30);
    ok("memory: as read", m.mem === 42.5);
    ok("upload: bytes sent per second, as kbit/s", m.upKbps === 10000);
    ok("half of a 20 Mbit/s line", a.view().meter.upPct === 50);
    proc = { cpuTotal: 1000, cpuIdle: 700, mem: 42.5 }; clock += 1000;
    ok("no new processor time: the last reading stands", a.sample().cpu === 30);
  }

  const setLoad = (cpu, mem, upKbps) => { a.meter.cpu = cpu; a.meter.mem = mem; a.meter.upKbps = upKbps; };

  section("who gets in");
  {
    setLoad(40, 30, 0);
    ok("40% busy: a guest's console run fits (40 + 4 under 60)", a.fits("guest", "console", true));
    ok("and a guest's window (40 + 15 under 60)", a.fits("guest", "screen", true));
    setLoad(50, 30, 0);
    ok("50% busy: a guest's window does not fit (50 + 15 over 60)", !a.fits("guest", "screen", true));
    ok("a member's does (50 + 15 under 85)", a.fits("member", "screen", true));
    setLoad(80, 30, 0);
    ok("80% busy: not even a member's window", !a.fits("member", "screen", true));
    ok("an admin's, always", a.fits("admin", "screen", false));
    setLoad(10, 30, 9000);
    ok("upload 9 of 20 Mbit/s: a guest's console run fits (45% under 50)", a.fits("guest", "console", true));
    ok("a guest's window does not (9 + 1.5 Mbit/s is 52.5%, over half)", !a.fits("guest", "screen", true));
    ok("and the reason says it is the upload", /upload/.test(a.why("guest", "screen", true)));
    setLoad(10, 70, 0);
    ok("memory over a guest's line keeps guests out", !a.fits("guest", "console", true) && /memory/.test(a.why("guest", "console", true)));
    setLoad(0, 0, 0);
    ok("an empty machine whose slots are full: no, except admins", !a.fits("member", "console", false) && a.fits("admin", "console", false));
  }

  section("the line");
  {
    const g1 = a.join({ who: "g:1", handle: "guest-1", tier: "guest", kind: "screen", req: { name: "a" } });
    clock += 1000;
    const g2 = a.join({ who: "g:2", handle: "guest-2", tier: "guest", kind: "screen", req: { name: "b" } });
    clock += 1000;
    const m1 = a.join({ who: "u:mia", handle: "mia", tier: "member", kind: "screen", req: { name: "c" } });
    const c1 = a.join({ who: "g:3", handle: "guest-3", tier: "guest", kind: "console", req: { name: "d" } });
    const order = a.ordered("screen").map((e) => e.handle).join(",");
    ok("a member who came last waits ahead of both guests", order === "mia,guest-1,guest-2", order);
    ok("a separate line per kind", a.ordered("console").length === 1 && a.place(c1, 1).place === 1);
    const p = a.place(g2, 1);
    ok("a place says how many are ahead and a guess at the wait", p.place === 3 && p.ahead === 2 && p.etaSec === 1800);
    a.ended("screen", 4 * MIN); a.ended("screen", 6 * MIN);
    ok("the guess follows how long runs have been lasting", a.place(g2, 2).etaSec === Math.round(3 * 5 * MIN / 2 / 1000));
    ok("asking again keeps the same place", a.join({ who: "g:1", handle: "guest-1", tier: "guest", kind: "screen", req: { name: "a2" } }) === g1 && a.line.length === 4);
    ok("someone of your tier or better is waiting: you go behind them", a.someoneAhead("guest", "screen", "g:9") && a.someoneAhead("member", "screen", "u:zed") && !a.someoneAhead("member", "screen", "u:mia"));
    a.bump(g2.id);
    ok("an admin moves a guest to the very front", a.ordered("screen")[0] === g2 && g2.tier === "guest");
    a.leave(g2.id); a.leave(c1.id);
    ok("leaving takes you out", a.line.length === 2);
    void m1;
  }

  section("turns");
  {
    setLoad(80, 30, 0);
    const online = new Set(["u:mia", "g:1"]);
    const ctx = { countsOk: () => true, online: (w) => online.has(w), running: () => [] };
    let r = a.pump(ctx);
    ok("busy: nobody is offered a turn", !r.offer.length);
    setLoad(20, 30, 0);
    r = a.pump(ctx);
    ok("room: the first in line is offered it", r.offer.length === 1 && r.offer[0].handle === "mia");
    r = a.pump(ctx);
    ok("one offer at a time: the room is held for them", !r.offer.length);
    clock += 61000;
    r = a.pump(ctx);
    ok("60 seconds without START: the place lapses, with the reason", r.lapsed.length === 1 && /60 seconds/.test(r.lapsed[0].why));
    ok("and the next person is offered it in the same moment", r.offer.length === 1 && r.offer[0].handle === "guest-1");
    a.leave(r.offer[0].id);

    const m = a.join({ who: "u:mia", handle: "mia", tier: "member", kind: "console", req: {} });
    const g = a.join({ who: "g:7", handle: "guest-7", tier: "guest", kind: "console", req: {} });
    online.clear();
    setLoad(99, 30, 0);
    r = a.pump(ctx);
    ok("a guest who leaves loses their place at once", r.lapsed.some((x) => x.e === g) && a.line.indexOf(g) < 0);
    ok("a member keeps it for now", a.line.indexOf(m) >= 0);
    clock += 100000; a.pump(ctx);
    online.add("u:mia"); a.pump(ctx);
    ok("back within two minutes: still in line", a.line.indexOf(m) >= 0 && !m.gone);
    online.clear(); a.pump(ctx); clock += 121000;
    r = a.pump(ctx);
    ok("away for more than two minutes: gone", r.lapsed.some((x) => x.e === m && /2 minutes/.test(x.why)));
  }

  section("keeping it moving");
  {
    setLoad(99, 30, 0);
    a.join({ who: "g:8", handle: "guest-8", tier: "guest", kind: "screen", req: {} });
    const now = clock;
    const running = [
      { id: "guest19", kind: "screen", tier: "guest", startedAt: now - 19 * MIN, lastInput: now },
      { id: "guest21", kind: "screen", tier: "guest", startedAt: now - 21 * MIN, lastInput: now },
      { id: "member30", kind: "screen", tier: "member", startedAt: now - 30 * MIN, lastInput: now },
      { id: "member61", kind: "screen", tier: "member", startedAt: now - 61 * MIN, lastInput: now },
      { id: "idle", kind: "screen", tier: "member", startedAt: now - 10 * MIN, lastInput: now - 6 * MIN },
      { id: "admin", kind: "screen", tier: "admin", startedAt: now - 500 * MIN, lastInput: now - 100 * MIN },
      { id: "console", kind: "console", tier: "guest", startedAt: now - 50 * MIN, lastInput: now - 50 * MIN }
    ];
    const r = a.pump({ countsOk: () => false, online: () => true, running: () => running });
    const ended = r.end.map((x) => x.id).sort().join(","), warned = r.warn.map((x) => x.id).join(",");
    ok("while people wait: a guest's window past 20 minutes ends, a member's past 60, an untouched one after 5",
      ended === "guest21,idle,member61", ended);
    ok("two minutes before, a warning", warned === "guest19", warned);
    ok("an admin's is never touched, nor runs of a kind nobody waits for", !/admin|console/.test(ended + warned));

    /* Console programs: quiet ones are only candidates, which the
       server checks against their processor use. */
    a.join({ who: "g:9", handle: "guest-9", tier: "guest", kind: "console", req: {} });
    const consoles = [
      { id: "quiet", kind: "console", tier: "member", startedAt: now - 30 * MIN, lastInput: now - 6 * MIN, lastOut: now - 6 * MIN },
      { id: "chatty", kind: "console", tier: "member", startedAt: now - 30 * MIN, lastInput: now - 30 * MIN, lastOut: now - 1 * MIN },
      { id: "typed", kind: "console", tier: "member", startedAt: now - 30 * MIN, lastInput: now - 1 * MIN, lastOut: 0 },
      { id: "young", kind: "console", tier: "member", startedAt: now - 2 * MIN, lastInput: 0, lastOut: 0 },
      { id: "boss", kind: "console", tier: "admin", startedAt: now - 300 * MIN, lastInput: 0, lastOut: 0 }
    ];
    const q = a.pump({ countsOk: () => false, online: () => true, running: () => consoles });
    ok("a console program with no input and no output for 5 minutes is a candidate, not ended outright",
      q.quiet.map((x) => x.id).join() === "quiet" && !q.end.some((x) => x.id === "quiet"), JSON.stringify(q.quiet));
    ok("output or input since keeps it off the list, as does being new, or an admin's", !q.quiet.some((x) => /chatty|typed|young|boss/.test(x.id)));
    a.line.length = 0;
    ok("nobody waiting: nothing is held to anything", !a.pump({ countsOk: () => true, online: () => true, running: () => running }).end.length);
  }

  section("windows' video steps down before anyone waits");
  {
    const b = new Access({ settingsFile: path.join(TMP, "v.json"), now: () => clock, read: () => proc, sent: () => sent,
      other: () => relayUp, otherWaiting: () => relayWait, otherAt: () => clock - 3000 });
    let relayUp = 0, relayWait = 0;
    const up = (k) => { b.meter.upKbps = k; };   /* of 20000 */
    up(1000);
    ok("quiet: full", b.videoKbps(1500) === 1500);
    relayUp = 9600;
    ok("the relay's browser counts toward the guests' line (1000 + 9600 = 53%)", b.videoKbps(1500) === Math.round(1500 * STEPS[1]));
    relayUp = 0; up(17200);
    ok("past the members' line: two steps", b.videoKbps(1500) === Math.round(1500 * STEPS[2]));
    up(1000); clock += 31000;
    ok("back up one step after 30 s of calm", b.videoKbps(1500) === 1005);
    relayWait = 1; clock += 31000;
    ok("not to full while someone waits for the relay's browser", b.videoKbps(1500) === 1005);
    relayWait = 0; clock += 31000;
    ok("then full", b.videoKbps(1500) === 1500);
    const v = b.view(0).meter;
    ok("ADMIN sees the relay's report, how long ago, and the step", v.relaySeenSec === 3 && v.relayWaiting === 0 && v.videoStep === 0, JSON.stringify(v));
  }

  section("settings");
  {
    const s = a.set({ guest: { load: 50, upload: 40 }, uploadMbps: 50 });
    ok("saved", s.guest.load === 50 && s.guest.upload === 40 && s.uploadMbps === 50 && s.member.load === 85);
    for (const [bad, what] of [[{ guest: { load: 120 } }, "over 100%"], [{ member: { load: 30 } }, "members let in later than guests"],
      [{ uploadMbps: 0 }, "no upload"], [{ guest: { upload: "lots" } }, "not a number"]]) {
      let threw = false;
      try { a.set(bad); } catch (e) { threw = true; }
      ok("refused: " + what, threw);
    }
    fs.writeFileSync(path.join(TMP, "a.json"), JSON.stringify({ guest: { load: 900 }, uploadMbps: -1 }));
    ok("a file edited badly by hand falls back to the defaults", a.settings().guest.load === 60 && a.settings().uploadMbps === 20);
  }

  section("through a real run server");
  {
    const STORE = path.join(TMP, "store");
    const pair = crypto.generateKeyPairSync("ed25519");
    const sign = (handle, tier) => ticket.sign(pair.privateKey, { handle, tier, exp: Date.now() + 60000 });
    const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
      storePath: STORE, driver: "process", dev: true,
      ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), () => {});
    const port = await app.listen();
    const A = app.access;
    A.sample = () => A.meter;          /* the load is whatever this test says */
    const load = (cpu) => { A.meter.cpu = cpu; A.meter.mem = 10; A.meter.upKbps = 0; };
    load(70);
    const as = async (h, tier) => { const c = await connect(port, sign(h, tier)); c.ready = await c.hello(); return c; };
    const SLOW = "setTimeout(() => console.log('done'), 400);";
    const guest = await as("guest-1", "guest"), mia = await as("mia", "member"), boss = await as("boss", "admin");
    const gf = (await guest.put("g.js", SLOW + "//g")).file;
    const mf = (await mia.put("m.js", SLOW + "//m")).file;
    const bf = (await boss.put("b.js", SLOW + "//b")).file;

    const gj = await guest.run(gf.id, []);
    ok("70% busy: a guest waits in line instead of being refused", gj.t === "job" && gj.queued && gj.queued.place === 1 && /busy/.test(gj.why), JSON.stringify(gj));
    const mj = await mia.run(mf.id, []);
    ok("a member still gets in at 70%", mj.t === "job" && mj.job && mj.job.id);
    load(90);
    const mj2 = await mia.run(mf.id, []);
    ok("at 90% a member waits too, ahead of the guest", mj2.queued && mj2.queued.place === 1);
    const gl = await guest.next((m) => m.t === "line" && m.entries[0] && m.entries[0].place === 2, 5000).catch(() => null);
    ok("and the guest hears they are now second", !!gl);
    const bj = await boss.run(bf.id, []);
    ok("an admin starts at once, whatever the load", bj.job && bj.job.id);

    const early = await guest.ask({ t: "take", id: gj.queued.id });
    ok("START before your turn is refused", early.t === "error" && /not your turn/.test(early.why));
    const theirs = await mia.ask({ t: "take", id: gj.queued.id });
    ok("someone else's place cannot be taken", theirs.t === "error" && /gone/.test(theirs.why));

    const ov = (await boss.ask({ t: "adm-overview" })).data.access;
    ok("ADMIN sees the meter and the line, guests unnamed", ov.meter.cpu === 90 && ov.line.length === 2 &&
      ov.line[0].handle === "mia" && ov.line[1].handle === "a guest", JSON.stringify(ov.line));
    const up = await boss.ask({ t: "adm-line-up", id: gj.queued.id });
    ok("an admin moves the guest to the front", up.t === "adm-done" && (await boss.ask({ t: "adm-overview" })).data.access.line[0].tier === "guest");

    load(20);
    const turn = await guest.next("turn", 5000).catch(() => null);
    ok("room again: the guest, now first, is told it is their turn, with 60 seconds", turn && turn.id === gj.queued.id && turn.seconds === 60);
    const took = await guest.ask({ t: "take", id: gj.queued.id });
    ok("START: it runs", took.t === "job" && took.job && took.job.name === "g.js", JSON.stringify(took));
    const done = await guest.next((m) => m.t === "exit" && m.job === took.job.id, 5000).catch(() => null);
    ok("to the end", done && done.code === 0);
    const mturn = await mia.next("turn", 5000).catch(() => null);
    ok("then the member is offered theirs", mturn && mturn.id === mj2.queued.id);

    const rm = await boss.ask({ t: "adm-line-rm", id: mj2.queued.id, reason: "testing" });
    const told = await mia.next("line-gone", 3000).catch(() => null);
    ok("an admin can take someone out, and they are told why", rm.t === "adm-done" && told && /testing/.test(told.why));

    const bad = await boss.ask({ t: "adm-access", guest: { load: 99 } });
    ok("thresholds that would let guests in after members are refused", bad.t === "error");
    const good = await boss.ask({ t: "adm-access", guest: { load: 40, upload: 30 }, uploadMbps: 21 });
    ok("good ones are saved", good.t === "adm-done" && A.settings().guest.load === 40 && A.settings().uploadMbps === 21);
    const nope = await mia.ask({ t: "adm-access", guest: { load: 10 } });
    ok("by admins only", nope.t === "error" && nope.why === "admins only");

    load(95);
    const again = await mia.run(mf.id, []);
    await mia.close();
    const back = await as("mia", "member");
    ok("a member who reconnects is told their place at once", back.ready.line && back.ready.line.length === 1 && back.ready.line[0].id === again.queued.id);
    const left = await back.ask({ t: "leave", id: again.queued.id }).catch(() => null);
    void left;
    await wait(100);
    ok("and can leave the line", !A.line.length);

    /* A quiet console program while someone waits for one. */
    let cpu = 0.4;
    app._internals.setCpuOf(() => Promise.resolve(cpu));
    load(10);
    const SLEEP = "setTimeout(() => {}, 60000);";
    const qa = await as("mia2", "member");
    const qj = await qa.run((await qa.put("q.js", SLEEP + "//q2")).file.id, []);
    const J = app._internals.jobs.get(qj.job.id);
    ok("(a quiet program is running)", !!J);
    load(99);
    const gq = await guest.run(gf.id, []);
    ok("(someone waits for a console program)", !!gq.queued);
    J.startedAt -= 10 * MIN; J.lastInput -= 10 * MIN;
    cpu = 40;
    app._internals.tickAccess(false);
    await wait(100);
    ok("quiet but using its processor: left alone", app._internals.jobs.has(J.id));
    J.cpuAsked = 0; cpu = null;
    app._internals.tickAccess(false);
    await wait(100);
    ok("when its processor use cannot be told: left alone", app._internals.jobs.has(J.id));
    J.cpuAsked = 0; cpu = 0.4;
    app._internals.tickAccess(false);
    J.cpuAsked = 0;
    app._internals.tickAccess(false);
    const gone = await qa.next((m) => m.t === "exit" && m.job === J.id, 5000).catch(() => null);
    ok("doing nothing at all: ended, saying why", gone && /done nothing for 5 minutes/.test(gone.why || ""), JSON.stringify(gone));
    await qa.close();
    for (const j of app._internals.jobs.values()) j.stop("test over");

    await Promise.all([guest.close(), back.close(), boss.close()]);
    await app.close();
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
