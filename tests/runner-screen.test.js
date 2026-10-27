/* ============================================================
   RUNNER phase 6 — programs with a window, streamed — against a
   real run server whose "docker" is tests/fake-docker.js. The real
   pipeline (Xvfb, the encoders, gVisor) is proven on Bastion 2; this
   is everything around it, which is where the rules live:

     1. Guests do not get screens; a member's screen is theirs only.
     2. What comes out of the box is untrusted: a garbled or flooding
        stream is cut off or held to the rate, never passed on whole.
     3. What goes into the box is only the input shapes fk-screen
        knows, with every number clamped to the screen.
     4. The graphics card is only ever given through a gVisor runtime,
        and an admin can take it away from one person.
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
const sandbox = require("../runnerd/sandbox");
const limits = require("../runnerd/limits");

const { ok, section, state } = makeRunner("runner-screen");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-screen-"));
const LOG = path.join(TMP, "docker-runs.log");
const pair = crypto.generateKeyPairSync("ed25519");
const sign = (handle, tier) => ticket.sign(pair.privateKey, { handle, tier, exp: Date.now() + 30000 });
const runs = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const frame = (k, body) => { const b = Buffer.from(body), h = Buffer.alloc(5); h[0] = k.charCodeAt(0); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };

(async () => {
  section("what a screen is, before anything runs");
  {
    const p = sandbox.plan("game.py", "script", [], "/job", true);
    ok("a screen wraps the program in fk-screen, in the screen image",
      p.image === "screen" && p.screen === true && p.argv[0] === "fk-screen" && p.argv.slice(1).join(" ") === "python3 -u /job/game.py");
    const w = sandbox.plan("game.exe", "pe", [], "/job", true);
    ok("a Windows program gets one too", w.argv.join(" ") === "fk-screen wine-run /job/game.exe" && w.image === "screen");
    ok("without asking, nothing changes", !sandbox.plan("a.py", "script", [], "/job").screen);

    ok("no GPU runtime unless one is configured", sandbox.gpuRuntime({}) === null && sandbox.gpuRuntime({ gpu: { runtime: "" } }) === null);
    ok("and never a runtime that is not gVisor", sandbox.gpuRuntime({ gpu: { runtime: "nvidia" } }) === null &&
      sandbox.gpuRuntime({ gpu: { runtime: "runc" } }) === null);
    ok("a gVisor one is used", sandbox.gpuRuntime({ gpu: { runtime: "runsc-gpu" } }) === "runsc-gpu");
    ok("an unsandboxed one only when the config says so in words",
      sandbox.gpuRuntime({ gpu: { runtime: "nvidia", unsandboxed: true } }) === "nvidia");

    const L = limits.build({ tiers: { guest: { gpu: true } } }).tiers;
    ok("guests never get the card, whatever the config says", L.guest.gpu === false);
    ok("screens are for members and admins by default", !limits.DEFAULTS.guest.screen && limits.DEFAULTS.member.screen && limits.DEFAULTS.admin.screen);
    ok("two screens at once, machine-wide, to begin with", limits.MACHINE.maxScreens === 2);

    const d = new sandbox.DockerDriver({ images: { screen: "img:1" }, runtime: "runsc", gpu: { runtime: "runsc-gpu" } });
    const job = { id: "j1", dir: "/x", limits: limits.DEFAULTS.member, plan: sandbox.plan("g.py", "script", [], "/job", true) };
    const a = d.args(job).argv;
    const env = (k) => { const i = a.indexOf("--env", a.findIndex((x, n) => x === "--env" && a[n + 1].indexOf(k + "=") === 0)); return i >= 0 ? a[i + 1] : null; };
    ok("the screen's size, rate and sound are passed in", env("FK_W") === "FK_W=1280" && env("FK_H") === "FK_H=720" &&
      env("FK_KBPS") === "FK_KBPS=1500" && env("FK_SOUND") === "FK_SOUND=1");
    ok("the ordinary gVisor runtime, without the card", a[a.indexOf("--runtime") + 1] === "runsc" && a.indexOf("--gpus") < 0);
    ok("still no network, read-only, no capabilities", a[a.indexOf("--network") + 1] === "none" && a.indexOf("--read-only") >= 0 &&
      a[a.indexOf("--cap-drop") + 1] === "ALL");
    job.gpu = true;
    const g = d.args(job).argv;
    ok("with the card: the GPU runtime, and only the video part of the driver",
      g[g.indexOf("--runtime") + 1] === "runsc-gpu" && g.indexOf("--gpus") >= 0 &&
      g.indexOf("NVIDIA_DRIVER_CAPABILITIES=video,utility") >= 0 && g.indexOf("FK_ENC=gpu") >= 0);
    const bare = new sandbox.DockerDriver({ images: { screen: "img:1" }, runtime: "runsc", gpu: { runtime: "nvidia" } });
    let threw = null;
    try { bare.args(job); } catch (e) { threw = e.message; }
    ok("asked for the card with no sandboxed runtime, it refuses rather than run without gVisor", /no sandboxed runtime/.test(threw || ""));
  }

  section("splitting the box's stream");
  {
    const got = { out: [], v: [], a: [], s: [] };
    const feed = sandbox.demux({
      out: (k, b) => got.out.push(k + ":" + b.toString()),
      video: (d, key) => got.v.push([key, d.length]),
      audio: (d) => got.a.push(d.length),
      status: (st) => got.s.push(st)
    });
    const all = Buffer.concat([frame("S", '{"w":640,"h":360}'), frame("O", "hi\n"), frame("V", Buffer.from([1, 9, 9, 9])),
      frame("A", "xx"), frame("E", "oops\n"), frame("S", "not json"), frame("V", Buffer.from([0, 7]))]);
    for (let i = 0; i < all.length; i += 3) feed(all.subarray(i, i + 3));
    ok("frames survive being cut at any byte", got.out.join("|") === "stdout:hi\n|stderr:oops\n" && got.a.join() === "2");
    ok("keyframes are told apart", got.v.length === 2 && got.v[0][0] === true && got.v[1][0] === false && got.v[0][1] === 3);
    ok("a status that is not JSON is ignored", got.s.length === 1 && got.s[0].w === 640);
    const bad = [];
    const feed2 = sandbox.demux({ out: (k, b) => bad.push(b.toString()), video: () => bad.push("video") });
    const h = Buffer.alloc(5); h[0] = 0x56; h.writeUInt32BE(64 * 1024 * 1024, 1);
    feed2(h); feed2(frame("V", Buffer.from([1, 1])));
    ok("a frame claiming 64 MB stops the stream, with a sentence", bad.length === 1 && /stopped making sense/.test(bad[0]));
  }

  /* ---- a run server whose docker is the stand-in ---- */
  process.env.FK_FAKE_LOG = LOG;
  const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
    storePath: path.join(TMP, "store"), driver: "docker", runtime: "runsc",
    dockerBin: [process.execPath, path.join(__dirname, "fake-docker.js")],
    images: { base: "fieldkit-runner:1", wine: "", screen: "fieldkit-runner-screen:1" },
    gpu: { runtime: "runsc-gpu" }, screen: { kbps: 400 }, egress: { enabled: false },
    ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), () => {});
  const port = await app.listen();
  const realDisk = app.store.disk.bind(app.store);
  app.store.disk = () => Object.assign(realDisk(), { pct: 0.5 });
  const as = async (h, tier) => { const c = await connect(port, sign(h, tier)); c.ready = await c.hello(); return c; };
  const said = (c, job) => c.got.filter((m) => m.t === "out" && m.job === job).map((m) => m.d).join("");
  /* The box is started just after the reply, so wait for its line. */
  const newRun = async (had) => { await until(() => runs().length > had, 5000); return runs().pop() || []; };
  const until = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (fn()) return true; await wait(50); } return false; };

  section("who gets a screen");
  {
    ok("the server says screens and the card are available", app.health().screens === true && app.health().gpu === true);
    const g = await as("visitor", "guest");
    ok("a guest's panel is told no", g.ready.screens === false);
    const up = await g.put("g.py", "print(1)");
    const r = await g.run(up.file.id, [], { screen: true });
    ok("and a guest's run with a screen is refused, saying why", r.t === "error" && /approved members/.test(r.why));
    await g.close();
  }

  const alice = await as("alice", "member");
  let id;
  section("a member's screen");
  {
    ok("a member's panel is told yes", alice.ready.screens === true);
    const up = await alice.put("game.py", "print(1)");
    const had0 = runs().length;
    const j = await alice.run(up.file.id, [], { screen: true });
    id = j.job && j.job.id;
    ok("it starts, and says it has a screen", j.t === "job" && j.job.screen && j.job.screen.w === 1280);
    const st = await alice.next((m) => m.t === "screen" && m.job === id, 5000);
    ok("the box's size and encoder are passed on", st.screen.w === 1280 && st.screen.sound === true && st.screen.enc === "gpu");
    const run = await newRun(had0);
    ok("it ran on the GPU runtime, encoding on the card", run[run.indexOf("--runtime") + 1] === "runsc-gpu" && run.indexOf("FK_ENC=gpu") >= 0);
    await until(() => alice.frames.filter((f) => f.job === id && f.kind === 1).length > 15, 5000);
    const v = alice.frames.filter((f) => f.job === id && f.kind === 1);
    ok("pictures arrive as binary frames, starting with a keyframe", v.length > 15 && v[0].key === true);
    ok("and sound", alice.frames.some((f) => f.job === id && f.kind === 2));
    ok("they carry the job's id", v.every((f) => f.job === id));
  }

  section("what reaches the box");
  {
    alice.say({ t: "ui", job: id, e: [
      { t: "m", x: 5000, y: -40 }, { t: "b", b: 9, d: "yes" }, { t: "w", y: -3 },
      { t: "k", c: "KeyA", d: 1 }, { t: "k", c: "Key A;rm -rf", d: 1 }, { t: "zap", x: 1 }, "string", null,
      { t: "m", x: 10, y: 20, extra: "dropped" }] });
    await until(() => /"x":10/.test(said(alice, id)), 5000);
    const lines = said(alice, id).split("\n").filter((l) => l.indexOf("got ") === 0).map((l) => JSON.parse(l.slice(4)));
    ok("a move is clamped to the screen", JSON.stringify(lines[0]) === '{"t":"m","x":1279,"y":0}');
    ok("a button is one of 1-3, pressed or not", JSON.stringify(lines[1]) === '{"t":"b","b":3,"d":1}');
    ok("the wheel is a direction only", JSON.stringify(lines[2]) === '{"t":"w","y":-1}');
    ok("a key code passes; one that is not a key code does not", JSON.stringify(lines[3]) === '{"t":"k","c":"KeyA","d":1}' &&
      !lines.some((l) => /rm -rf/.test(JSON.stringify(l))));
    ok("unknown shapes are dropped, and extra fields stripped", lines.length === 5 && JSON.stringify(lines[4]) === '{"t":"m","x":10,"y":20}');
    alice.say({ t: "in", job: id, d: "hello\n" });
    await until(() => /"d":"hello\\n"/.test(said(alice, id)), 5000);
    ok("typed text goes in as a line fk-screen understands", /got \{"t":"in","d":"hello\\n"\}/.test(said(alice, id)));
    const many = []; for (let i = 0; i < 200; i++) many.push({ t: "m", x: i, y: 1 });
    alice.say({ t: "ui", job: id, e: many });
    await until(() => /"x":63,/.test(said(alice, id)), 5000);
    await wait(300);
    ok("at most 64 events from one message", /"x":63,/.test(said(alice, id)) && !/"x":64,/.test(said(alice, id)));
  }

  section("the video steps down while the house upload is busy");
  {
    const A = app.access;
    A.sample = () => A.meter;
    A.meter.upKbps = 18000;          /* 90% of 20 Mbit/s: past the members' line */
    app._internals.tickAccess(false);
    await until(() => /"t":"rate","k":160/.test(said(alice, id)), 5000);
    ok("the running window is told its new bitrate (400 -> 160)", /got \{"t":"rate","k":160\}/.test(said(alice, id)));
    A.meter.upKbps = 0;              /* room to start one; the step holds for 30 s */
    const up = await alice.put("g2.py", "print(2)");
    const had = runs().length;
    const j2 = await alice.run(up.file.id, [], { screen: true });
    const run = await newRun(had);
    ok("a window started now starts at it", run.indexOf("FK_KBPS=160") >= 0, run.filter((x) => /FK_KBPS/.test(x)).join());
    alice.say({ t: "kill", job: j2.job && j2.job.id });
    await alice.next((m) => m.t === "exit" && m.job === (j2.job && j2.job.id), 5000).catch(() => null);
    A.step = 0;
    app._internals.tickAccess(false);
    await until(() => /"t":"rate","k":400/.test(said(alice, id)), 5000);
    ok("and back to full when it is calm", /"t":"rate","k":400/.test(said(alice, id)));
  }

  section("nobody else's");
  {
    const bob = await as("bob", "member");
    bob.say({ t: "ui", job: id, e: [{ t: "k", c: "KeyB", d: 1 }] });
    bob.say({ t: "in", job: id, d: "from bob\n" });
    await wait(600);
    ok("bob cannot steer it or type into it", !/KeyB|from bob/.test(said(alice, id)));
    ok("and receives none of its pictures", bob.frames.length === 0);
    await bob.close();
  }

  section("leaving and coming back");
  {
    await alice.close();
    const a2 = await as("alice", "member");
    const back = a2.ready.jobs.find((j) => j.id === id);
    ok("the screen is still there when reopened", back && back.screen && back.screen.enc === "gpu");
    await until(() => a2.frames.filter((f) => f.job === id && f.kind === 1).length > 12, 5000);
    const v = a2.frames.filter((f) => f.job === id && f.kind === 1);
    ok("pictures resume at a keyframe, not mid-stream", v.length > 12 && v[0].key === true);
    global.a2 = a2;
  }
  const a2 = global.a2;

  section("one screen too many");
  {
    const c = await as("carol", "member");
    const up = await c.put("c.py", "print(1)");
    const j1 = await c.run(up.file.id, [], { screen: true });
    const j2 = await c.run(up.file.id, [], { screen: true });
    /* Not refused any more: the line (RUNNER_PLAN.md §22). */
    ok("past the machine's screens, a run waits in line, with a reason", j1.t === "job" && j1.job && j2.t === "job" && j2.queued &&
      j2.queued.place === 1 && /screen is in use/.test(j2.why), JSON.stringify(j2));
    c.say({ t: "leave", id: j2.queued.id });
    await c.next((m) => m.t === "line" && !m.entries.length, 4000);
    c.say({ t: "kill", job: j1.job.id });
    await c.next((m) => m.t === "exit" && m.job === j1.job.id, 8000);
    await c.close();
  }

  section("a box that floods or garbles");
  {
    a2.say({ t: "kill", job: id });
    await a2.next((m) => m.t === "exit" && m.job === id, 8000);
    const up = await a2.put("flood.py", "print('flood')");
    const j = await a2.run(up.file.id, [], { screen: true });
    const fid = j.job.id;
    const t0 = Date.now();
    await wait(2500);
    const bytes = a2.frames.filter((f) => f.job === fid).reduce((n, f) => n + f.data.length, 0);
    const secs = (Date.now() - t0) / 1000;
    /* The box writes ~12 MB/s; the setting is 400 kbit/s, so the most
       passed on is 100 KB/s plus a one-second burst. */
    ok("a box writing 12 MB/s of video is held to twice its rate (" + Math.round(bytes / 1024) + " KB in " + secs.toFixed(1) + " s)",
      bytes > 0 && bytes <= 100 * 1024 * (secs + 1.2));
    a2.say({ t: "kill", job: fid });
    await a2.next((m) => m.t === "exit" && m.job === fid, 8000);
    const gu = await a2.put("garbage.py", "print('garbage')");
    const gj = await a2.run(gu.file.id, [], { screen: true });
    const gx = await a2.next((m) => m.t === "exit" && m.job === gj.job.id, 8000);
    ok("a garbled stream ends the picture with a sentence, and the job ends normally",
      /stopped making sense/.test(said(a2, gj.job.id)) && gx.code === 0);
  }

  section("the graphics card, per person");
  {
    const boss = await as("boss", "admin");
    const up = await a2.put("game2.py", "print(2)");
    const had1 = runs().length;
    const j = await a2.run(up.file.id, [], { screen: true });
    ok("alice's screen is on the card", j.job && (await newRun(had1)).indexOf("runsc-gpu") >= 0);
    const r = await boss.ask({ t: "adm-punish", handle: "alice", action: "nogpu", reason: "testing" });
    ok("an admin can take the card away", r.t === "adm-done" && /nogpu/.test(r.done));
    const ex = await a2.next((m) => m.t === "exit" && m.job === j.job.id, 8000);
    ok("which stops her card-using program, saying why", /graphics card/.test(ex.why || ""));
    const had2 = runs().length;
    const j2 = await a2.run(up.file.id, [], { screen: true });
    const run = await newRun(had2);
    ok("her next screen runs, encoded on the CPU, in the ordinary gVisor", j2.t === "job" &&
      run[run.indexOf("--runtime") + 1] === "runsc" && run.indexOf("--gpus") < 0);
    const ov = await boss.ask({ t: "adm-overview" });
    ok("the ADMIN screen shows it", ov.data.users.some((u) => u.handle === "alice" && u.noGpu && u.noGpu.reason === "testing"));
    const back = await boss.ask({ t: "adm-punish", handle: "alice", action: "gpu" });
    ok("and can give it back, without a reason", back.t === "adm-done" && !app.admin.state("alice").noGpu);
    a2.say({ t: "in", job: j2.job.id, d: "quit\n" });
    await a2.next((m) => m.t === "exit" && m.job === j2.job.id, 8000);
    await boss.close();
  }

  await a2.close();
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
