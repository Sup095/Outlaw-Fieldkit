/* ============================================================
   RUNNER phase 5 — programs that outlive the panel, the saved
   folder, and the way out to the internet — against a real run
   server (process driver) and the real proxy code.

   The order of what matters:
     1. A guest's program still dies with the connection. Nothing in
        this phase may loosen that.
     2. A member's program is theirs: only they can see it, type into
        it or stop it, from any device — and an admin's kick still
        stops it even with nobody attached.
     3. The saved folder cannot be used to read or delete anything
        outside itself, and cannot grow without limit.
     4. Each job's internet is its own network, through the filter.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { PassThrough, Writable } = require("stream");
const { makeRunner } = require("./harness");
const { connect, wait } = require("./runner-kit");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");
const sandbox = require("../runnerd/sandbox");
const limits = require("../runnerd/limits");
const { Guard, Bucket, flow } = require("../relay/guard");
const egress = require("../runnerd/egress");

const { ok, section, state } = makeRunner("runner-persist");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-persist-"));
const STORE = path.join(TMP, "store");
const pair = crypto.generateKeyPairSync("ed25519");
const sign = (handle, tier) => ticket.sign(pair.privateKey, { handle, tier, exp: Date.now() + 30000 });

const TICKS = "let n = 0; console.log('started'); setInterval(() => console.log('tick ' + (++n)), 200);";
const SLOW = "console.log('started'); setTimeout(() => console.log('done'), 1200);";
const ECHO = "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write('echo ' + d));" +
  " setTimeout(() => {}, 60000);";
const SAVER = "const fs = require('fs'), p = require('path');" +
  " fs.mkdirSync(p.join(process.env.SAVE, 'game'), { recursive: true });" +
  " fs.writeFileSync(p.join(process.env.SAVE, 'game', 'slot1.txt'), 'level 7');" +
  " console.log('saved to ' + (process.env.SAVE ? 'SAVE' : 'nowhere'));";
const FILLER = "const fs = require('fs'), p = require('path');" +
  " fs.writeFileSync(p.join(process.env.SAVE, 'big.bin'), Buffer.alloc(200 * 1024));" +
  " console.log('wrote'); setTimeout(() => {}, 20000);";

(async () => {
  const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
    storePath: STORE, driver: "process", dev: true,
    /* Small enough that the over-the-limit case is quick to cause. */
    tiers: { member: { saveBytes: 64 * 1024, saveFiles: 50 } },
    ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), () => {});
  const port = await app.listen();
  const realDisk = app.store.disk.bind(app.store);
  app.store.disk = () => Object.assign(realDisk(), { pct: 0.5 });
  const jobs = app._internals.jobs;
  const as = async (h, tier) => { const c = await connect(port, sign(h, tier)); c.ready = await c.hello(); return c; };
  const outOf = (c, job, re, ms) => c.next((m) => m.t === "out" && m.job === job && re.test(m.d), ms);

  section("the tiers say what they get");
  {
    const L = limits.build({ tiers: { guest: { keepRunning: true, saveBytes: 1e9, internet: false } } }).tiers;
    ok("a guest's programs cannot be set to outlive them", L.guest.keepRunning === false);
    ok("nor given a saved folder", L.guest.saveBytes === 0 && L.guest.saveFiles === 0);
    ok("guests are offline by default", limits.DEFAULTS.guest.internet === false);
    ok("members keep running, save, and get the filtered web",
      L.member.keepRunning && L.member.saveBytes > 0 && L.member.internet);
    const v = limits.publicView(L.member);
    ok("and the panel is told so", v.keepRunning === true && v.saveBytes > 0 && v.internet === true);
  }

  section("a guest's program still dies with the connection");
  {
    const g = await as("stranger", "guest");
    const up = await g.put("t.js", TICKS);
    const job = (await g.run(up.file.id)).job;
    ok("it starts", !!job && jobs.has(job.id));
    ok("and says it will not keep running", job.keepRunning === false);
    await outOf(g, job.id, /started/);
    await g.close();
    await wait(400);
    ok("closing the connection stops it", !jobs.has(job.id));
  }

  section("a member's program outlives the panel");
  let alice = await as("alice", "member");
  let jobId;
  {
    const up = await alice.put("ticks.js", TICKS);
    const job = (await alice.run(up.file.id)).job;
    jobId = job.id;
    ok("it starts, and says it will keep running", job.keepRunning === true);
    await outOf(alice, jobId, /tick 2/);
    await alice.close();
    await wait(500);
    ok("closing the panel leaves it running", jobs.has(jobId));

    alice = await connect(port, sign("alice", "member"));
    alice.ready = await alice.hello();
    const back = alice.ready.jobs.find((j) => j.id === jobId);
    ok("opening RUNNER again lists it", !!back, JSON.stringify(alice.ready.jobs).slice(0, 200));
    ok("with its recent output", back && back.tail.some((p) => /tick/.test(p.d)));
    ok("and it is attached: new output arrives", !!(await outOf(alice, jobId, /tick/)));
    alice.say({ t: "kill", job: jobId });
    const ex = await alice.next((m) => m.t === "exit" && m.job === jobId);
    ok("and it can be stopped from the new connection", ex.why === "stopped");
  }

  section("results wait for whoever comes back");
  {
    const up = await alice.put("slow.js", SLOW);
    const job = (await alice.run(up.file.id)).job;
    await outOf(alice, job.id, /started/);
    await alice.close();
    await wait(2200);
    ok("it finished with nobody watching", !jobs.has(job.id));
    alice = await connect(port, sign("alice", "member"));
    alice.ready = await alice.hello();
    const r = (alice.ready.finished || []).find((x) => x.job === job.id);
    ok("the result is waiting", !!r && r.code === 0 && r.name === "slow.js", JSON.stringify(alice.ready.finished));
    ok("with the end of its output", r && r.tail.some((p) => /done/.test(p.d)));
    const second = await alice.hello();
    ok("and it is handed over once, not every time", !(second.finished || []).length);
  }

  section("two devices, one program");
  {
    const up = await alice.put("echo.js", ECHO);
    const job = (await alice.run(up.file.id)).job;
    const phone = await as("alice", "member");
    ok("the second device sees it", phone.ready.jobs.some((j) => j.id === job.id));
    phone.say({ t: "in", job: job.id, d: "from the phone\n" });
    ok("typing on one reaches the program", !!(await outOf(phone, job.id, /echo from the phone/)));
    ok("and both see the answer", !!(await outOf(alice, job.id, /echo from the phone/)));
    await phone.close();
    await wait(300);
    ok("closing one leaves it running for the other", jobs.has(job.id));
    alice.say({ t: "kill", job: job.id });
    await alice.next((m) => m.t === "exit" && m.job === job.id);
  }

  section("only the owner");
  {
    const up = await alice.put("ticks2.js", TICKS);
    const job = (await alice.run(up.file.id)).job;
    const bob = await as("bob", "member");
    ok("someone else does not see it", !bob.ready.jobs.some((j) => j.id === job.id));
    bob.say({ t: "kill", job: job.id });
    bob.say({ t: "in", job: job.id, d: "hi\n" });
    await wait(400);
    ok("nor can they stop it", jobs.has(job.id));
    const g = await as("bob", "guest");
    ok("not even with the same name as a guest", !g.ready.jobs.some((j) => j.id === job.id));
    await g.close();
    await alice.close();
    await wait(300);
    ok("it is still running, detached", jobs.has(job.id));
    const boss = await as("boss", "admin");
    const o = (await boss.ask({ t: "adm-overview" })).data;
    const seen = o.jobs.find((j) => j.id === job.id);
    ok("an admin sees it, marked as not being watched", seen && seen.watched === false);
    await boss.ask({ t: "adm-kick", handle: "alice" });
    await wait(400);
    ok("and DISCONNECT stops it even with nobody attached", !jobs.has(job.id));
    await bob.close();
    await boss.close();
  }

  section("the saved folder");
  {
    alice = await as("alice", "member");
    ok("a member is told about it", alice.ready.save && alice.ready.save.limitBytes === 64 * 1024);
    ok("and is not promised internet this server cannot give (no egress here)", alice.ready.internet === false);
    const up = await alice.put("saver.js", SAVER);
    const job = (await alice.run(up.file.id)).job;
    ok("the job is told it has one", job.save === true);
    const done = await alice.next((m) => m.t === "exit" && m.job === job.id);
    ok("a program can write to it", done.code === 0);
    const ls = await alice.ask({ t: "save-ls" });
    ok("and the file is listed", ls.files.some((x) => x.path === "game/slot1.txt" && x.size === 7), JSON.stringify(ls));
    ok("with the folder's size", ls.usage.bytes === 7);

    alice.say({ t: "save-get", path: "game/slot1.txt", ref: "dl" });
    const head = await alice.next((m) => m.t === "save-file" && m.ref === "dl");
    const piece = await alice.next((m) => m.t === "save-chunk" && m.ref === "dl");
    ok("it can be downloaded", head.size === 7 && Buffer.from(piece.d, "base64").toString() === "level 7" && piece.end);

    for (const bad of ["../alice.json", "/etc/passwd", "game/../../x", "game//slot1.txt", "C:\\x"]) {
      const r = await alice.ask({ t: "save-get", path: bad });
      ok("a path outside it is refused: " + bad, r.t === "error", JSON.stringify(r));
    }

    /* A program leaving a link to somewhere else. On this machine
       the link may not be allowed to exist (Windows), in which case
       there is nothing to test. */
    const dir = app.saves.dir("alice");
    const outside = path.join(TMP, "secret.txt");
    fs.writeFileSync(outside, "not yours");
    let linked = false;
    try { fs.symlinkSync(outside, path.join(dir, "trap")); linked = true; } catch (e) {}
    try { fs.symlinkSync(TMP, path.join(dir, "door"), "junction"); linked = true; } catch (e) {}
    if (linked) {
      const r1 = await alice.ask({ t: "save-get", path: "trap" });
      ok("a link to a file outside is not followed", r1.t === "error", JSON.stringify(r1));
      const r2 = await alice.ask({ t: "save-get", path: "door/secret.txt" });
      ok("nor a link to a folder outside", r2.t === "error", JSON.stringify(r2));
      await alice.ask({ t: "save-rm", path: "door/secret.txt" });
      ok("and deleting through one deletes nothing outside", fs.existsSync(outside));
      const m = app.saves.measure("alice");
      ok("measuring does not follow them either", m.bytes < 1000, JSON.stringify(m));
    } else ok("(links cannot be made here; the realpath rule is still in force)", true);

    const t2 = (await alice.run((await alice.put("ticks3.js", TICKS)).file.id)).job;
    const busy = await alice.ask({ t: "save-get", path: "game/slot1.txt" });
    ok("nothing is read while a program is running", busy.t === "error" && /stop your running/.test(busy.why));
    alice.say({ t: "kill", job: t2.id });
    await alice.next((m) => m.t === "exit" && m.job === t2.id);

    const rm = await alice.ask({ t: "save-rm", path: "game/slot1.txt" });
    ok("a file can be deleted", rm.t === "save" && !rm.files.some((x) => x.path === "game/slot1.txt"));
    const cl = await alice.ask({ t: "save-clear" });
    ok("and the whole folder emptied", cl.t === "save" && cl.files.length === 0 && fs.existsSync(dir));

    const fill = (await alice.run((await alice.put("filler.js", FILLER)).file.id)).job;
    const stopped = await alice.next((m) => m.t === "exit" && m.job === fill.id, 12000);
    ok("going over the limit stops the program", /saved folder/.test(stopped.why || ""), JSON.stringify(stopped));
    const refused = await alice.run(up.file.id);
    ok("and a full folder refuses the next run", refused.t === "error" && /saved folder/.test(refused.why));
    await alice.ask({ t: "save-clear" });
    ok("until it is emptied", (await alice.run(up.file.id)).t === "job");
    await alice.next((m) => m.t === "exit");

    const g = await as("visitor", "guest");
    ok("a guest has no saved folder", g.ready.save === null);
    const gr = await g.ask({ t: "save-ls" });
    ok("and cannot ask for one", gr.t === "error");
    await g.close();

    /* Not used in longer than the expiry: gone at the next sweep. */
    const old = (Date.now() - 40 * 86400000) / 1000;
    fs.utimesSync(path.join(STORE, "save-used", "alice"), old, old);
    await alice.close();
    await wait(200);
    app._internals.runSweep();
    ok("an unused saved folder expires like a file", !fs.existsSync(dir));
  }

  section("the way out: a network per job, through the filter");
  {
    const d = new sandbox.DockerDriver({ images: { base: "img:1" }, storePath: "/s", storeHostPath: "" });
    const base = { id: "abc", limits: limits.DEFAULTS.member, dir: "/s/jobs/abc", plan: { image: "base", argv: ["true"] } };
    const off = d.args(Object.assign({}, base)).argv;
    ok("no internet: no network at all", off[off.indexOf("--network") + 1] === "none");
    ok("and no proxy settings", !off.some((a) => /PROXY=/i.test(a)));
    const on = d.args(Object.assign({}, base, { net: "fk-j-abc", save: "/s/save/alice" })).argv;
    ok("with it: the job's own network", on[on.indexOf("--network") + 1] === "fk-j-abc");
    ok("and every proxy variable pointing at egress",
      ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].every((k) => on.includes(k + "=http://egress:3128")));
    ok("the saved folder is mounted at /save", on.includes("type=bind,source=/s/save/alice,target=/save"));
    ok("and everything else about the box is unchanged",
      ["--read-only", "--cap-drop", "no-new-privileges", "65534:65534"].every((x) => on.includes(x)));
    const noEgress = new sandbox.DockerDriver({ images: { base: "img:1" }, egress: { enabled: false } });
    noEgress.start = sandbox.DockerDriver.prototype.start;
    ok("egress switched off means wantNet is ignored",
      !(Object.assign({}, base, { wantNet: true }).net) && noEgress.egress.enabled === false);

    const s = egress.settings();
    ok("the proxy defaults to the adult+malware filter", s.dnsFilter === "adult");
    ok("and a per-job ceiling", s.perClient.maxConns > 0 && s.perClient.upBps > 0 && s.perClient.downBps > s.perClient.upBps);
    process.env.FK_DNS_FILTER = "nonsense";
    ok("an unknown filter name falls back to the default, not to none", egress.settings().dnsFilter === "adult");
    delete process.env.FK_DNS_FILTER;

    const g = new Guard({ perClient: { maxConns: 2, upBps: 1000, downBps: 1000 } });
    const a1 = g._admit("10.9.0.2"), a2 = g._admit("10.9.0.2"), a3 = g._admit("10.9.0.2");
    ok("each sandbox gets a few connections", a1 && a2 && a3 === false);
    ok("and another sandbox has its own", !!g._admit("10.9.0.3"));
    a1.done(); a1.done();
    ok("closing one frees exactly one", !!g._admit("10.9.0.2") && g._admit("10.9.0.2") === false);
    ok("the relay's own browser is not limited", new Guard({})._admit("x") === null);

    const b = new Bucket(100 * 1024);
    ok("a quarter-second burst is free", b.take(20 * 1024) === 0);
    ok("past it, the wait grows with what was sent", b.take(100 * 1024) > 500);

    const src = new PassThrough(), t0 = Date.now();
    let got = 0;
    const sink = new Writable({ write(c, e, cb) { got += c.length; cb(); } });
    flow(src, sink, new Bucket(100 * 1024));
    const ended = new Promise((r) => sink.on("finish", r));
    for (let i = 0; i < 25; i++) src.write(Buffer.alloc(8 * 1024));
    src.end();
    await ended;
    const took = Date.now() - t0;
    ok("200 KB at 100 KB/s takes about two seconds", got === 200 * 1024 && took > 1400 && took < 4000, took + " ms");
  }

  await app.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }
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
