/* ============================================================
   RUNNER phase 4 — files that expire, a shared library, and what
   an admin can do — against a real run server.

   The order of what matters:
     1. Nobody but an admin can use an admin command.
     2. A file nobody uses is deleted on schedule, warned about a
        week ahead, and recoverable from the bin for a while.
     3. A permanent file is shared, runs for several people at once,
        and cannot be deleted by the person who uploaded it.
     4. Every punishment does what it says, and says why.
     5. A blocked file is gone everywhere and cannot come back.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { makeRunner } = require("./harness");
const { connect, wait, makeZip } = require("./runner-kit");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");

const { ok, section, state } = makeRunner("runner-admin");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-admin-"));
const STORE = path.join(TMP, "store");
const DAY = 86400000;
const pair = crypto.generateKeyPairSync("ed25519");
const sign = (handle, tier) => ticket.sign(pair.privateKey, { handle, tier, exp: Date.now() + 30000 });

const HELLO = "console.log('hello ' + (process.argv[2] || ''));";
const SLOW = "console.log('started'); setTimeout(() => console.log('done'), 1500);";
const FOREVER = "console.log('started'); setInterval(() => {}, 1000);";

/* Pretend a file was last used `days` ago, by editing its index. */
function age(handle, id, days) {
  const f = path.join(STORE, "users", handle + ".json");
  const u = JSON.parse(fs.readFileSync(f, "utf8"));
  u.files[id].usedAt = new Date(Date.now() - days * DAY).toISOString();
  u.files[id].addedAt = u.files[id].usedAt;
  fs.writeFileSync(f, JSON.stringify(u));
}

(async () => {
  const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
    storePath: STORE, driver: "process", dev: true,
    ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), () => {});
  const port = await app.listen();
  /* The disk this test runs on could be anything. Disk pressure is
     tested on purpose further down; everywhere else it reads half full. */
  const realDisk = app.store.disk.bind(app.store);
  const halfFull = () => Object.assign(realDisk(), { pct: 0.5 });
  app.store.disk = halfFull;
  const as = async (h, tier) => { const c = await connect(port, sign(h, tier)); c.ready = await c.hello(); return c; };

  const boss = await as("boss", "admin");
  const alice = await as("alice", "member");
  const bob = await as("bob", "member");

  section("admin commands are for admins");
  {
    for (const t of ["adm-overview", "adm-kill", "adm-punish", "adm-block", "adm-sweep"]) {
      const r = await alice.ask({ t: t, handle: "bob", action: "suspend", reason: "x" });
      ok("a member sending " + t + " is refused", r.t === "error" && r.why === "admins only", JSON.stringify(r));
    }
    const o = (await boss.ask({ t: "adm-overview" })).data;
    ok("an admin sees who is connected", ["boss", "alice", "bob"].every((h) => o.sessions.some((x) => x.handle === h)));
    ok("and how full the disk is", o.disk.total > 0 && o.disk.pct > 0 && o.disk.pct < 1, JSON.stringify(o.disk));
    ok("and the expiry clock", o.ttlDays === 30 && o.pressure === "ok");
  }

  section("files that nobody uses");
  {
    const up = await alice.put("old.js", HELLO);
    ok("a fresh file says when it would expire, about 30 days out",
      Math.abs(Date.parse(up.file.expiresAt) - (Date.now() + 30 * DAY)) < 60000, up.file.expiresAt);
    ok("and is not flagged as expiring soon", up.file.expiringSoon === false);

    const again = await alice.put("old-copy.js", HELLO);
    ok("uploading the same bytes again sends nothing and returns the file already there",
      again.deduped === true && again.file.id === up.file.id, JSON.stringify(again).slice(0, 120));

    age("alice", up.file.id, 25);
    alice.say({ t: "ls" });
    const l = await alice.next("files");
    ok("a week before it goes, it is flagged", l.files[0].expiringSoon === true);

    const running = await alice.run(up.file.id);
    await alice.next("exit");
    alice.say({ t: "ls" });
    ok("running it starts the clock again", (await alice.next("files")).files[0].expiringSoon === false,
      JSON.stringify(running).slice(0, 80));

    age("alice", up.file.id, 31);
    const swept = (await boss.ask({ t: "adm-sweep" }));
    ok("the sweep deletes what has not been used for 30 days", /1 file\(s\) expired/.test(swept.done), swept.done);
    alice.say({ t: "ls" });
    ok("it is gone from the owner's list", (await alice.next("files")).files.length === 0);
    const bin = (await boss.ask({ t: "adm-overview" })).data.trash;
    ok("but it is in the bin, with the reason", bin.length === 1 && /not used for 30 days/.test(bin[0].reason));
    const back = await boss.ask({ t: "adm-restore", file: up.file.id });
    alice.say({ t: "ls" });
    ok("and an admin can bring it back, with a fresh clock",
      /restored/.test(back.done) && (await alice.next("files")).files[0].expiringSoon === false);
  }

  section("the shared library");
  {
    const up = await alice.put("game.js", SLOW);
    const usedBefore = (await (alice.say({ t: "ls" }), alice.next("files"))).usage.bytes;
    const pin = await boss.ask({ t: "adm-pin", handle: "alice", file: up.file.id });
    ok("an admin makes a member's file permanent", /shared library/.test(pin.done), JSON.stringify(pin));
    alice.say({ t: "ls" });
    const l = await alice.next("files");
    ok("it leaves the uploader's own list and stops counting against them",
      !l.files.some((f) => f.id === up.file.id) && l.usage.bytes === usedBefore - up.file.size);
    ok("and appears in everyone's library", l.library.some((f) => f.id === up.file.id && f.library));

    const guest = await as("visitor", "guest");
    ok("a guest sees the library too", guest.ready.library.some((f) => f.id === up.file.id));
    const runs = await Promise.all([alice.run(up.file.id), bob.run(up.file.id), guest.run(up.file.id)]);
    ok("three people run the same permanent file at once", runs.every((r) => r.t === "job"),
      JSON.stringify(runs.map((r) => r.why || r.t)));
    ok("and it really is three jobs", app._internals.jobs.size === 3);
    const playing = (await (bob.say({ t: "ls" }), bob.next("files"))).library.find((f) => f.id === up.file.id);
    ok("the library says how many are playing it", playing && playing.playing === 3, JSON.stringify(playing));
    const ends = await Promise.all([alice.next("exit"), bob.next("exit"), guest.next("exit")]);
    ok("all three finish", ends.every((e) => e.code === 0));

    /* The card: what members see, and how PLAY starts it. */
    let r = await alice.ask({ t: "adm-lib-set", file: up.file.id, title: "Mine now" });
    ok("a member cannot write a library card", r.t === "error" && r.why === "admins only", JSON.stringify(r));
    r = await boss.ask({ t: "adm-lib-set", file: up.file.id, title: "Space\u0007  Game\n", about: "x".repeat(500),
      args: "--fast", window: true });
    ok("an admin can", r.t === "adm-done" && /now shows as Space Game/.test(r.done), JSON.stringify(r));
    const card = (await (bob.say({ t: "ls" }), bob.next("files"))).library.find((f) => f.id === up.file.id).card;
    ok("everyone sees it, cleaned: no control characters, one line, limited length",
      card.title === "Space Game" && card.about.length === 200 && card.args === "--fast" && card.window === true,
      JSON.stringify(card));
    r = await boss.ask({ t: "adm-lib-set", file: up.file.id, entry: "a.js" });
    ok("a file inside can only be chosen for a zip", r.t === "error" && /is not a zip/.test(r.why), JSON.stringify(r));
    r = await boss.ask({ t: "adm-lib-set", file: "0123456789abcdef01234567", title: "x" });
    ok("and only for something in the library", r.t === "error" && /no such library file/.test(r.why));
    r = await boss.ask({ t: "adm-lib-set", file: up.file.id });
    const cleared = (await (bob.say({ t: "ls" }), bob.next("files"))).library.find((f) => f.id === up.file.id);
    ok("an empty card clears it", /was cleared/.test(r.done) && !cleared.card, JSON.stringify(cleared));

    const zb = makeZip([{ name: "a/one.js", data: "console.log('one')" },
      { name: "b/two.js", data: "console.log('two from ' + require('path').basename(process.cwd()))" }]);
    const zu = await alice.put("pair.zip", zb);
    await boss.ask({ t: "adm-pin", handle: "alice", file: zu.file.id });
    r = await boss.ask({ t: "adm-lib-set", file: zu.file.id, entry: "../two.js" });
    ok("a name with .. is refused", r.t === "error", JSON.stringify(r));
    r = await boss.ask({ t: "adm-lib-set", file: zu.file.id, entry: "c/three.js" });
    ok("so is a name that is not a program inside", r.t === "error" && /is not a program inside/.test(r.why), JSON.stringify(r));
    r = await boss.ask({ t: "adm-lib-set", file: zu.file.id, title: "Two", entry: "b/two.js" });
    const zc = (await (bob.say({ t: "ls" }), bob.next("files"))).library.find((f) => f.id === zu.file.id).card;
    ok("a program inside the zip can be chosen", r.t === "adm-done" && zc.entry === "b/two.js", JSON.stringify(r));
    const pr = await bob.run(zu.file.id, [], { entry: zc.entry });
    const pout = await bob.next((m) => m.t === "out" && m.job === (pr.job && pr.job.id));
    ok("and PLAY's way of starting it works for anyone", pr.t === "job" && /two from b/.test(pout.d), JSON.stringify(pout));
    await bob.next("exit");
    await boss.ask({ t: "adm-lib-rm", file: zu.file.id });

    alice.say({ t: "rm", file: up.file.id });
    ok("the uploader cannot delete a permanent file", (await alice.next("removed")).ok === false);
    ok("and it is still in the library", (await (bob.say({ t: "ls" }), bob.next("files"))).library.length === 1);

    const un = await boss.ask({ t: "adm-unpin", file: up.file.id });
    alice.say({ t: "ls" });
    const back = (await alice.next("files")).files.find((f) => f.id === up.file.id);
    ok("unpinning gives it back to its uploader with a fresh clock",
      /went back to alice/.test(un.done) && back && back.expiringSoon === false, un.done);
    await guest.close();
  }

  section("punishments");
  {
    const up = await bob.put("loop.js", FOREVER);
    await bob.run(up.file.id);
    await bob.next("out");

    let r = await boss.ask({ t: "adm-punish", handle: "bob", action: "warn", reason: "" });
    ok("a punishment without a reason is refused", r.t === "error" && /say why/.test(r.why));
    r = await boss.ask({ t: "adm-punish", handle: "boss", action: "warn", reason: "x" });
    ok("nobody punishes themselves", r.t === "error" && /yourself/.test(r.why));

    await boss.ask({ t: "adm-punish", handle: "bob", action: "cooldown", minutes: 30, reason: "too many jobs" });
    const stopped = await bob.next("exit");
    ok("a cooldown stops what they are running", stopped.why === "an admin put you on a cooldown", JSON.stringify(stopped));
    r = await bob.run(up.file.id);
    ok("and they cannot start anything, and are told why and until when",
      r.t === "error" && /cannot start anything until/.test(r.why) && /too many jobs/.test(r.why), r.why);
    await boss.ask({ t: "adm-punish", handle: "bob", action: "clear" });
    r = await bob.run(up.file.id);
    ok("clearing it lets them run again", r.t === "job");
    await boss.ask({ t: "adm-kill", job: r.job.id });
    ok("an admin can stop anyone's job", (await bob.next("exit")).why === "stopped by an admin");

    await boss.ask({ t: "adm-punish", handle: "bob", action: "warn", reason: "please keep it civil" });
    const b2 = await as("bob", "member");
    ok("a warning is shown the next time they connect",
      b2.ready.notices.some((n) => n.kind === "warning" && n.reason === "please keep it civil"));
    await b2.close();
    const b3 = await as("bob", "member");
    ok("once", b3.ready.notices.length === 0);
    await b3.close();

    await boss.ask({ t: "adm-punish", handle: "bob", action: "suspend", days: 3, reason: "cheating" });
    const kicked = await bob.next("denied");
    ok("a suspension disconnects them at once, with the reason", /suspended/.test(kicked.why) && /cheating/.test(kicked.why));
    await wait(200);
    ok("their connection is closed", bob.closed === true);
    const tryAgain = await connect(port, sign("bob", "member"));
    const told = await tryAgain.next("denied");
    ok("and coming back is refused with the same reason", /cheating/.test(told.why));
    await boss.ask({ t: "adm-punish", handle: "bob", action: "clear" });
  }

  section("blocking a file");
  {
    const bob = await as("bob", "member");
    const bad = "console.log('pretend this is malware');";
    const a = await alice.put("free-game.js", bad);
    const b = await bob.put("same-thing.js", bad);
    const r = await boss.ask({ t: "adm-block", handle: "bob", file: b.file.id, reason: "malware" });
    ok("an admin blocks a file by pointing at it", /blocked same-thing\.js/.test(r.done) && /2 copies/.test(r.done), r.done);
    alice.say({ t: "ls" });
    ok("every copy is gone, including other people's", !(await alice.next("files")).files.some((f) => f.id === a.file.id));
    const again = await alice.put("renamed.js", bad);
    ok("and the same bytes cannot be uploaded again under any name", again.t === "error" && /blocked/.test(again.why));
    const ov = (await boss.ask({ t: "adm-overview" })).data;
    ok("the block is listed, with the reason", ov.blocked.some((x) => x.reason === "malware" && x.name === "same-thing.js"));
    ok("and it is not in the bin waiting to be restored", !ov.trash.some((x) => x.name === "same-thing.js"));
    await boss.ask({ t: "adm-unblock", sha256: ov.blocked[0].sha256 });
    ok("unblocking allows it again", (await alice.put("ok-now.js", bad)).t === "put-done");
    await bob.close();
  }

  section("when the disk fills up");
  {
    app.store.disk = () => Object.assign(realDisk(), { pct: 0.85 });
    ok("at 80% the expiry clock drops to 14 days", (await boss.ask({ t: "adm-overview" })).data.ttlDays === 14);
    app.store.disk = () => Object.assign(realDisk(), { pct: 0.95 });
    const m = await alice.put("more.js", "console.log(2)");
    ok("at 90% a member cannot upload, and is told why", m.t === "error" && /nearly full/.test(m.why), JSON.stringify(m));
    ok("an admin still can", (await boss.put("fix.js", "console.log(3)")).t === "put-done");
    app.store.disk = halfFull;
  }

  section("a session has to keep proving who it is");
  {
    alice.say({ t: "renew", ticket: sign("alice", "member") });
    ok("a fresh ticket renews it", (await alice.next("renewed")).tier === "member");
    alice.say({ t: "renew", ticket: sign("mallory", "admin") });
    ok("somebody else's ticket does not", /not accepted/.test((await alice.next("error")).why));
    alice.say({ t: "renew", ticket: sign("alice", "admin") });
    ok("a promotion arrives with the renewal", (await alice.next("renewed")).tier === "admin");
    ok("and the admin commands open up", (await alice.ask({ t: "adm-overview" })).t === "adm");

    const g = await as("newbie", "guest");
    g.say({ t: "renew", ticket: sign("newbie", "member") });
    const re = await g.next("reconnect");
    ok("a guest who is approved is told to reconnect, because their files move", /member/.test(re.why));
    await wait(200);
    ok("and the guest session ends", g.closed && g.closeCode === 4001, String(g.closeCode));

    const stale = await as("carol", "member");
    for (const x of app._internals.sessions.values()) if (x.handle === "carol") x.renewBy = Date.now() - 1;
    app._internals.checkRenewals();
    const d = await stale.next("denied");
    ok("a session that stops renewing is closed, which is how a messaging ban reaches it",
      /could not be renewed/.test(d.why));
  }

  section("everything is written down");
  {
    const audit = (await boss.ask({ t: "adm-overview" })).data.audit;
    const did = (action, target) => audit.some((a) => a.action === action && a.by === "boss" && (!target || a.target === target));
    ok("punishments", did("cooldown", "bob") && did("suspend", "bob") && did("warn", "bob") && did("clear", "bob"));
    ok("file actions", did("make-permanent", "alice") && did("unpin", "alice") && did("restore") && did("block-file"));
    ok("killing a job", did("kill-job", "bob"));
    ok("with the reason given", audit.some((a) => a.action === "suspend" && a.detail === "cheating"));
  }

  await app.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
