/* ============================================================
   Bastion 2 asleep when nobody needs it (RUNNER_PLAN.md §24):
   runnerd/sleep.js deciding, ADMIN on a real run server, the relay
   keeping Bastion 2's card address and holding the wake helper's
   request, the panel's wake, and fk-wake.js sending the packet.
   fk-sleep.sh itself was run against stand-ins for ip, ethtool,
   who and systemctl (FIELDKIT_PROJECT.md §14.27).

   What matters:
     1. Off unless an admin switches it on, and never while anything
        runs, anyone waits, or the card cannot wake the machine.
     2. "Sleeping soon" is said before "sleep", so the relay can tell
        "asleep" from "offline".
     3. Only the holder of the relay's wake key hears about wakes; only
        a signed-in account can ask for one; in quiet hours only an
        admin.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dgram = require("dgram");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { makeRunner } = require("./harness");
const { connect } = require("./runner-kit");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");
const { Sleep, inQuiet, ANNOUNCE_MS } = require("../runnerd/sleep");
const relayRunner = require("../relay/runner");
const fkWake = require("../relay/fk-wake");

const { ok, section, state } = makeRunner("runner-sleep");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-sleep-"));
const MAC = "02:00:5e:10:00:01";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const HOST = path.join(TMP, "wake.json"), PLAN = path.join(TMP, "plan.json"), SET = path.join(TMP, "sleep-settings.json");
  let clock = Date.UTC(2026, 9, 27, 12, 0, 0);
  const z = new Sleep({ settingsFile: SET, planFile: PLAN, hostFile: HOST, now: () => clock });
  const host = (o) => fs.writeFileSync(HOST, JSON.stringify(Object.assign({ at: Math.floor(clock / 1000), iface: "eno1", mac: MAC,
    supports: "pumbg", wol: "d", blocked: null, resumedAt: null }, o)));
  const plan = () => JSON.parse(fs.readFileSync(PLAN, "utf8"));
  const idle = { jobs: 0, line: 0 };

  section("deciding");
  {
    let r = z.tick(idle);
    ok("off until an admin switches it on", !r.sleep && /switched off/.test(r.why) && plan().sleep === false);
    ok("and the plan file says so, with the time", plan().at === Math.floor(clock / 1000));
    z.set({ enabled: true, idleMinutes: 20 });
    r = z.tick(idle);
    ok("on, but without fk-sleep: never", !r.sleep && /fk-sleep is not running/.test(r.why));
    host({ supports: "pumb" });
    r = z.tick(idle);
    ok("a card that cannot wake it: never", !r.sleep && /cannot wake/.test(r.why));
    host({});
    r = z.tick(idle);
    ok("otherwise it waits out the idle time", !r.sleep && /idle for 0 of 20 minutes/.test(r.why), r.why);
    clock += 19 * 60000; host({});
    ok("still waiting at 19 minutes", !z.tick(idle).soon);
    clock += 60000; host({});
    r = z.tick(idle);
    ok("at 20 it says soon, not yet sleep", r.soon && !r.sleep && plan().soon === true && plan().sleep === false);
    clock += ANNOUNCE_MS - 1000; host({});
    ok("still only soon just before the announcement is over", !z.tick(idle).sleep);
    clock += 1000; host({});
    r = z.tick(idle);
    ok("then sleep", r.sleep && plan().sleep === true, JSON.stringify(plan()));
    r = z.tick({ jobs: 1, line: 0 });
    ok("a job starting puts it back to awake at once", !r.sleep && !r.soon && /running/.test(r.why));
    clock += 60000; host({});
    r = z.tick(idle);
    ok("and the idle time starts again from when it ended", !r.soon && /idle for 1 of 20/.test(r.why), r.why);
    clock += 30 * 60000; host({});
    z.tick({ jobs: 0, line: 2 });
    ok("people waiting count too", /waiting/.test(z.last.why));
    clock += 30 * 60000; host({});
    z.tick({ jobs: 0, line: 0, browser: 2 });
    ok("so do the relay's browser sessions on this machine's helper (FIELDKIT_PROJECT.md §14.38)",
      /browser has sessions/.test(z.last.why) && !z.last.soon, z.last.why);
    clock += 30 * 60000; host({});
    z.tick(idle);
    clock += ANNOUNCE_MS; host({});
    ok("idle again: sleep", z.tick(idle).sleep);
    z.touch();
    ok("somebody doing something keeps it awake", !z.tick(idle).soon);
    clock += 30 * 60000; host({});
    z.tick(idle);
    clock += ANNOUNCE_MS; host({});
    ok("idle again", z.tick(idle).sleep);
    host({ resumedAt: Math.floor(clock / 1000) });
    r = z.tick(idle);
    ok("waking up starts a fresh idle time, for whoever woke it", !r.soon && /idle for 0/.test(r.why), r.why);
    clock += 4 * 60000;
    ok("an fk-sleep that stopped writing counts as missing", /fk-sleep is not running/.test(z.tick(idle).why));
  }

  section("quiet hours and SLEEP NOW");
  {
    ok("quiet hours: a plain range", inQuiet({ from: 1, to: 7, tz: "UTC" }, Date.UTC(2026, 0, 1, 3)) &&
      !inQuiet({ from: 1, to: 7, tz: "UTC" }, Date.UTC(2026, 0, 1, 7)));
    ok("across midnight", inQuiet({ from: 23, to: 6, tz: "UTC" }, Date.UTC(2026, 0, 1, 23, 30)) &&
      inQuiet({ from: 23, to: 6, tz: "UTC" }, Date.UTC(2026, 0, 1, 2)) && !inQuiet({ from: 23, to: 6, tz: "UTC" }, Date.UTC(2026, 0, 1, 12)));
    ok("in the admin's own time zone", inQuiet({ from: 1, to: 7, tz: "America/New_York" }, Date.UTC(2026, 0, 1, 8)) &&
      !inQuiet({ from: 1, to: 7, tz: "UTC" }, Date.UTC(2026, 0, 1, 8)));
    ok("none, or equal hours: never quiet", !inQuiet(null, clock) && !inQuiet({ from: 3, to: 3, tz: "UTC" }, clock));

    clock = Date.UTC(2026, 9, 28, 2, 0, 0); host({});
    z.set({ quietFrom: 1, quietTo: 7, tz: "UTC" });
    z.touch();
    clock += 5 * 60000; host({});
    let r = z.tick(idle);
    ok("in quiet hours it goes after 5 idle minutes", r.soon && r.quiet, JSON.stringify(r));
    z.set({ quietFrom: null, quietTo: null });
    z.set({ enabled: false });
    z.touch();
    r = z.tick(idle);
    ok("switched off: awake", !r.soon);
    z.sleepNow("boss");
    r = z.tick(idle);
    ok("SLEEP NOW ignores the switch and the idle time", r.soon && !r.sleep);
    ok("but not a running job", /running/.test(z.tick({ jobs: 1, line: 0 }).why));
    clock += ANNOUNCE_MS; host({});
    z.tick(idle);
    clock += ANNOUNCE_MS; host({});
    ok("and is still announced first", z.tick(idle).sleep);
    z.cancel();
    ok("STAY AWAKE undoes it", !z.tick(idle).soon && z.force === null);
    fs.unlinkSync(HOST);
    let refused = null;
    try { z.sleepNow("boss"); } catch (e) { refused = e.message; }
    ok("SLEEP NOW without fk-sleep is refused with a reason", /fk-sleep/.test(refused || ""), refused);
    host({ supports: "d" });
    refused = null;
    try { z.sleepNow("boss"); } catch (e) { refused = e.message; }
    ok("so is SLEEP NOW on a card that cannot wake it", /would not come back/.test(refused || ""), refused);
  }

  section("settings are checked");
  {
    const bad = (c, re) => { try { z.set(c); return false; } catch (e) { return re.test(e.message); } };
    ok("idle under 5 minutes refused", bad({ idleMinutes: 3 }, /5 to 720/));
    ok("a fraction refused", bad({ idleMinutes: 7.5 }, /whole number/));
    ok("half a quiet range refused", bad({ quietFrom: 2, quietTo: null }, /both/));
    ok("an hour of 24 refused", bad({ quietFrom: 24, quietTo: 3 }, /0 to 23/));
    ok("an unknown time zone refused", bad({ tz: "Mars/Olympus" }, /time zone/));
    ok("and nothing bad was stored", z.settings().idleMinutes === 20 && z.settings().quietFrom === null);
    fs.writeFileSync(SET, JSON.stringify({ enabled: "yes", idleMinutes: -4, quietFrom: "x", tz: "<b>" }));
    const s = z.settings();
    ok("a damaged settings file reads as the safe defaults", s.enabled === false && s.idleMinutes === 20 && s.quietFrom === null && s.tz === "UTC");
    host({ mac: "not-a-mac", iface: "eno1; rm -rf /", blocked: "x".repeat(500) });
    const h = z.host();
    ok("what fk-sleep wrote is only believed in shape", h.mac === null && h.iface === null && h.blocked.length === 120);
  }

  section("ADMIN and /health on a real run server");
  let app, port, boss, alice, pair;
  {
    const STORE = path.join(TMP, "store");
    pair = crypto.generateKeyPairSync("ed25519");
    const sign = (handle, tier) => ticket.sign(pair.privateKey, { handle, tier, exp: Date.now() + 30000 });
    const WAKE = path.join(TMP, "run-wake.json");
    fs.writeFileSync(WAKE, JSON.stringify({ at: Math.floor(Date.now() / 1000), iface: "eno1", mac: MAC, supports: "pumbg", wol: "d", blocked: null, resumedAt: null }));
    app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
      storePath: STORE, driver: "process", dev: true, wakeFile: WAKE, powerFile: path.join(TMP, "none.json"),
      ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), () => {});
    port = await app.listen();
    const as = async (h, tier) => { const c = await connect(port, sign(h, tier)); c.ready = await c.hello(); return c; };
    boss = await as("boss", "admin"); alice = await as("alice", "member");

    const health = await (await fetch("http://127.0.0.1:" + port + "/health")).json();
    ok("/health carries the card's address for the relay", health.sleep && health.sleep.mac === MAC && health.sleep.can === true &&
      health.sleep.on === false && health.sleep.soon === false, JSON.stringify(health.sleep));
    let o = (await boss.ask({ t: "adm-overview" })).data;
    ok("an admin sees the checks", o.sleep && o.sleep.host.mac === MAC && o.sleep.settings.enabled === false, JSON.stringify(o.sleep).slice(0, 200));
    ok("and that the relay has not said anything about its helper yet", o.sleep.helperSec === null);
    const r = await alice.ask({ t: "adm-sleep", enabled: true });
    ok("a member cannot switch it on", r.t === "error" && r.why === "admins only");
    const done = await boss.ask({ t: "adm-sleep", enabled: true, idleMinutes: 30, quietFrom: 1, quietTo: 7, tz: "Europe/London" });
    ok("an admin can, and is told what was saved", done.t === "adm-done" && /after 30 idle minutes, quiet 1:00-7:00 Europe\/London/.test(done.done), JSON.stringify(done));
    o = (await boss.ask({ t: "adm-overview" })).data;
    ok("in the audit log", o.audit.some((a) => a.action === "sleep-settings" && a.by === "boss"));
    const h2 = await (await fetch("http://127.0.0.1:" + port + "/health")).json();
    ok("and /health now gives the relay the quiet hours", h2.sleep.on === true && h2.sleep.quiet.from === 1 && h2.sleep.quiet.tz === "Europe/London");
    const now = await boss.ask({ t: "adm-sleep-now" });
    ok("SLEEP NOW, with what happens next", now.t === "adm-done" && /about a minute/.test(now.done));
    const plan = JSON.parse(fs.readFileSync(path.join(STORE, "sleep-plan.json"), "utf8"));
    ok("the plan in the store says soon at once (two people connected do not stop it)", plan.soon === true && plan.sleep === false, JSON.stringify(plan));
    const h3 = await (await fetch("http://127.0.0.1:" + port + "/health")).json();
    ok("and so does /health, so the relay will say asleep, not offline", h3.sleep.soon === true);
    await boss.ask({ t: "adm-sleep-cancel" });
    ok("STAY AWAKE", JSON.parse(fs.readFileSync(path.join(STORE, "sleep-plan.json"), "utf8")).soon === false);
    const before = app.sleep.lastActive;
    await wait(5);
    alice.say({ t: "ls" });
    await alice.next("files");
    ok("a member doing something counts as activity", app.sleep.lastActive > before);
    const quiet = app.sleep.lastActive;
    await wait(5);
    alice.say({ t: "renew", ticket: "x" });
    await wait(50);
    ok("the panel's own renewal does not", app.sleep.lastActive === quiet);
  }

  section("the relay");
  {
    const RELAYDIR = path.join(TMP, "relay");
    let who = null;
    const logs = [];
    const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const rs = http.createServer((req, res) => {
      relayRunner.route(req, res, new URL(req.url, "http://relay"), { send }).then((done) => { if (!done) send(res, 404, {}); });
    });
    await new Promise((r) => rs.listen(0, "127.0.0.1", r));
    const RP = rs.address().port;
    const rurl = "http://127.0.0.1:" + RP;
    const init = () => relayRunner.init({ dataDir: RELAYDIR, log: (l, m) => logs.push(m), whoami: () => who,
      config: { enabled: true, publicUrl: "http://127.0.0.1:" + port } });
    init();
    const KEY = fs.readFileSync(path.join(RELAYDIR, "runner", "wake", "key"), "utf8").trim();
    ok("the relay makes the helper's key, in a folder of its own", KEY.length === 48 &&
      fs.readdirSync(path.join(RELAYDIR, "runner", "wake")).join() === "key");
    init();
    ok("and keeps it across a restart", fs.readFileSync(path.join(RELAYDIR, "runner", "wake", "key"), "utf8").trim() === KEY);

    let st = await relayRunner.status();
    ok("a live run server: online", st.online === true);
    ok("and its card's address is kept on disk", JSON.parse(fs.readFileSync(path.join(RELAYDIR, "runner", "wake-state.json"), "utf8")).mac === MAC);

    /* The run server says it is about to sleep, then goes. */
    await boss.ask({ t: "adm-sleep", quietFrom: null, quietTo: null });
    await boss.ask({ t: "adm-sleep-now" });
    relayRunner._internals.forget();
    await relayRunner.status();
    boss.close(); alice.close();
    await app.close();
    relayRunner._internals.forget();
    init();               /* and the relay restarts while it sleeps */
    relayRunner._internals.forget();
    st = await relayRunner.status();
    ok("then offline: asleep, not just offline, even after a relay restart", st.online === false && st.asleep === true &&
      /asleep to save power/.test(st.why), JSON.stringify(st));
    ok("but not wakeable while no helper is waiting", st.wakeable === false);

    const pollRaw = (k) => fetch(rurl + "/runner/wake/wait", { headers: k ? { "X-FK-Wake-Key": k } : {} });
    ok("the helper's route refuses a wrong key", (await pollRaw("nope")).status === 401 && (await pollRaw(null)).status === 401);

    who = null;
    const ask = async () => { const r = await fetch(rurl + "/runner/wake", { method: "POST" }); return { status: r.status, body: await r.json() }; };
    let w = await ask();
    ok("waking needs an account", w.status === 401 && /sign in/.test(w.body.error));
    who = { handle: "alice", tier: "member" };
    w = await ask();
    ok("and a helper: without one it says so", w.status === 503 && /wake helper on Bastion 1 is not running/.test(w.body.error), JSON.stringify(w));

    const held = pollRaw(KEY).then((r) => r.json());
    await wait(80);
    ok("the helper's request is held open", relayRunner._internals.waiters() === 1);
    relayRunner._internals.forget();
    st = await relayRunner.status();
    ok("and now it is wakeable", st.wakeable === true && st.waking === false);
    who = { banned: { until: null } , handle: "x" };
    ok("not by a banned account", (await ask()).status === 403);
    who = { handle: "alice", tier: "member" };
    w = await ask();
    ok("a member asks: accepted", w.status === 202 && w.body.waking === true);
    const got = await held;
    ok("and the helper is answered at once with the address", got.wake === true && got.mac === MAC, JSON.stringify(got));
    relayRunner._internals.forget();
    st = await relayRunner.status();
    ok("the panel is told it is waking", st.waking === true && /waking up/.test(st.why), JSON.stringify(st));
    w = await ask();
    ok("asking again straight away does not send another", w.status === 202 && !logs.slice(-1)[0].includes("asked"));

    /* A wake with no helper waiting at that moment is collected by its next request. */
    const pending = relayRunner._internals;
    pending.helperAt(Date.now());
    await wait(5);
    const realNow = Date.now;
    Date.now = () => realNow() + relayRunner._internals.WAKE_AGAIN_MS + 1000;
    w = await ask();
    Date.now = realNow;
    ok("a later ask with nobody waiting is kept", w.status === 202);
    const next = await (await pollRaw(KEY)).json();
    ok("and handed to the helper's next request", next.wake === true && next.mac === MAC);

    /* Quiet hours: only admins. */
    const h = new Date().getUTCHours();
    relayRunner._internals.remember({ service: "fieldkit-runnerd", sleep: { mac: MAC, can: true, on: true, soon: true,
      quiet: { from: h, to: (h + 2) % 24, tz: "UTC" } } });
    w = await ask();
    ok("in quiet hours a member is told only an admin can", w.status === 403 && /only an admin/.test(w.body.error) && w.body.quiet.from === h);
    who = { handle: "boss", tier: "admin" };
    const held2 = pollRaw(KEY).then((r) => r.json());
    await wait(50);
    Date.now = () => realNow() + 2 * (relayRunner._internals.WAKE_AGAIN_MS + 1000);
    w = await ask();
    Date.now = realNow;
    ok("an admin can", w.status === 202 && (await held2).wake === true);

    /* What the relay tells runnerd about its helper. */
    const rep = relayRunner._internals.signReport({ up: 0 });
    const claims = JSON.parse(Buffer.from(rep.split(".")[0], "base64url").toString());
    ok("the relay's load report says when the helper last asked", Number.isInteger(claims.wh) && claims.wh >= 0 && claims.wh < 5);

    /* ---- fk-wake.js ---- */
    const pkt = fkWake.magic(MAC);
    ok("the magic packet: six 0xFF then the address sixteen times", pkt.length === 102 && pkt.slice(0, 6).equals(Buffer.alloc(6, 0xff)) &&
      pkt.slice(96).toString("hex") === MAC.replace(/:/g, "") && pkt.slice(6, 12).toString("hex") === "02005e100001");
    let bad = null;
    try { fkWake.magic("zz:00"); } catch (e) { bad = e.message; }
    ok("and nothing for an address that is not one", /not a network card address/.test(bad || ""));
    const t = fkWake.targets({ lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
      eno1: [{ family: "IPv4", address: "192.168.1.20", netmask: "255.255.255.0", internal: false }, { family: "IPv6", address: "fe80::1", netmask: "ffff::", internal: false }],
      docker0: [{ family: "IPv4", address: "172.17.0.1", netmask: "255.255.0.0", internal: false }],
      tailscale0: [{ family: "IPv4", address: "100.64.0.7", netmask: "255.255.255.255", internal: false }] });
    ok("sent to the LAN's broadcast address and the all-ones one, not Docker's or Tailscale's", t.sort().join() === "192.168.1.255,255.255.255.255", t.join());

    const sock = dgram.createSocket("udp4");
    const heard = [];
    sock.on("message", (m) => heard.push(m));
    await new Promise((r) => sock.bind(0, "127.0.0.1", r));
    const UP = sock.address().port;
    const sent = await fkWake.send(MAC, { targets: ["127.0.0.1"], port: UP, gapMs: 0 });
    await wait(100);
    ok("three copies, a moment apart", sent.sent === 3 && heard.length === 3 && heard.every((m) => m.equals(pkt)));

    /* The helper end to end: a real child process, asked through the relay. */
    heard.length = 0;
    const child = spawn(process.execPath, [path.join(__dirname, "..", "relay", "fk-wake.js")], {
      env: Object.assign({}, process.env, { FK_WAKE_URL: rurl, FK_WAKE_KEY: KEY, FK_WAKE_TARGETS: "127.0.0.1", FK_WAKE_PORT: String(UP) }),
      stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return false; };
    ok("the helper connects and waits", await until(() => relayRunner._internals.waiters() >= 1, 5000), out);
    who = { handle: "boss", tier: "admin" };
    Date.now = () => realNow() + 3 * (relayRunner._internals.WAKE_AGAIN_MS + 1000);
    w = await ask();
    Date.now = realNow;
    ok("somebody opens RUNNER", w.status === 202);
    ok("and the helper sends the packet", await until(() => heard.length >= 3, 6000) && heard[0].equals(pkt), out);
    /* The line is written after the last packet, so it can trail them. */
    ok("saying so in its log", await until(() => /woke 02:00:5e:10:00:01: 3 packet/.test(out), 3000), out);
    child.kill();
    sock.close();

    for (let i = 0; i < 5 && relayRunner._internals.waiters(); i++) await wait(50);
    relayRunner.init({ dataDir: RELAYDIR, log: () => {}, config: { enabled: false } });
    await new Promise((r) => { rs.close(() => r()); rs.closeAllConnections && rs.closeAllConnections(); });
  }

  await wait(300);
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
