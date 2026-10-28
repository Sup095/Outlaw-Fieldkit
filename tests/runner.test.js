/* ============================================================
   RUNNER (RUNNER_PLAN.md phase 3) — the relay's ticket routes and
   the run server, talking to each other for real.

   The run server here uses the "process" driver, which has no
   sandbox, so that this suite runs without Docker. What that
   leaves untested is the box itself; the flags that make the box
   are asserted as data below, and the real thing was run against
   Docker separately (FIELDKIT_PROJECT.md §14.14).

   What matters most, in order:

     1. Nobody gets in without a ticket the relay signed, and a
        ticket works once.
     2. A guest's sandbox is gone the moment their connection is.
     3. You can only touch your own files and your own jobs.
     4. Every limit actually stops the thing it limits.
     5. A run server that is down is a sentence, not a crash.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { makeRunner } = require("./harness");
const ticket = require("../runnerd/ticket");
const limits = require("../runnerd/limits");
const sandbox = require("../runnerd/sandbox");
const { safeName } = require("../runnerd/store");
const runnerd = require("../runnerd/server");
const relayRunner = require("../relay/runner");

const { ok, section, state } = makeRunner("runner");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A client that remembers everything it was sent, so a test can ask
   for "the next exit" without racing the message that carries it. */
function connect(port, t) {
  return new Promise((resolve) => {
    const sock = new WebSocket("ws://127.0.0.1:" + port + "/attach?t=" + encodeURIComponent(t));
    const c = { sock, got: [], waiters: [], open: false, closed: false };
    const pump = () => {
      c.waiters = c.waiters.filter((w) => {
        const i = c.got.findIndex(w.pred);
        if (i < 0) return true;
        w.resolve(c.got.splice(i, 1)[0]);
        return false;
      });
    };
    c.next = (pred, ms) => new Promise((res, rej) => {
      const w = { pred: typeof pred === "string" ? (m) => m.t === pred : pred, resolve: res };
      c.waiters.push(w);
      pump();
      setTimeout(() => rej(new Error("timed out waiting for " + pred + "; had " + JSON.stringify(c.got).slice(0, 300) + (c.closed ? " (closed)" : ""))), ms || 8000);
    });
    c.say = (o) => sock.send(JSON.stringify(o));
    c.close = () => new Promise((r) => { if (c.closed) return r(); sock.addEventListener("close", () => r()); sock.close(); });
    c.put = async (name, body, claim) => {
      const buf = Buffer.from(body);
      c.say({ t: "put", ref: name, name: name, size: buf.length, sha256: claim || sha(buf) });
      const first = await c.next((m) => m.t === "put-ok" || m.t === "error");
      if (first.t === "error") return first;
      sock.send(buf);
      return c.next((m) => m.t === "put-done" || m.t === "error");
    };
    c.run = async (file, args) => {
      c.say({ t: "run", file: file, args: args, ref: "r" });
      return c.next((m) => m.t === "job" || m.t === "error");
    };
    sock.addEventListener("open", () => { c.open = true; resolve(c); });
    sock.addEventListener("message", (e) => { c.got.push(JSON.parse(e.data)); pump(); });
    sock.addEventListener("close", () => { c.closed = true; if (!c.open) resolve(c); });
    /* Node 22 fires only "error" for a refused upgrade, never "close". */
    sock.addEventListener("error", () => { if (!c.open) { c.closed = true; resolve(c); } });
  });
}

const HELLO = "console.log('hello from ' + process.argv.slice(2).join(','));";
const ECHO = "process.stdin.on('data', (d) => process.stdout.write('got:' + d));";
const FOREVER = "console.log('started'); setInterval(() => {}, 1000);";
const NOISY = "setInterval(() => process.stdout.write('x'.repeat(1000)), 5);";

(async () => {

  /* The relay half, initialised the way server.js does it. */
  let who = null;
  relayRunner.init({ dataDir: path.join(TMP, "relay"), log: () => {}, whoami: () => who,
    config: { enabled: true, publicUrl: "http://127.0.0.1:1" } });
  const pem = relayRunner._internals.publicPem();
  const key = ticket.loadPublicKey(pem);
  const keyFile = path.join(TMP, "relay", "runner", "ticket-key.pem");
  const sign = (handle, tier) => relayRunner._internals.signTicket(handle, tier);

  section("a ticket is the relay's word, and only the relay's");
  {
    const t = sign("alice", "member");
    const v = ticket.verify(key, t);
    ok("what the relay signs, the run server accepts", v.ok && v.claims.handle === "alice" &&
      v.claims.tier === "member", JSON.stringify(v));

    const other = crypto.generateKeyPairSync("ed25519");
    ok("signed by any other key, it is refused",
      ticket.verify(key, ticket.sign(other.privateKey,
        { handle: "alice", tier: "admin", exp: Date.now() + 30000 })).ok === false);

    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify(Object.assign(
      JSON.parse(Buffer.from(body, "base64url").toString()), { tier: "admin" }))).toString("base64url");
    ok("changing the tier breaks the signature", ticket.verify(key, forged + "." + sig).ok === false);
    ok("an expired ticket is refused", ticket.verify(key, t, Date.now() + 61000).ok === false);
    ok("one claiming to last an hour is refused even though the relay signed it",
      ticket.verify(key, ticket.sign(crypto.createPrivateKey(fs.readFileSync(keyFile, "utf8")),
        { handle: "alice", tier: "member", exp: Date.now() + 3600000 })).ok === false);
    ok("garbage is refused quietly", ticket.verify(key, "not.a-ticket").ok === false &&
      ticket.verify(key, "").ok === false && ticket.verify(key, null).ok === false);

    const spent = new ticket.Spent();
    ok("a ticket is good once", spent.use(v.claims) === true && spent.use(v.claims) === false);
    ok("the signing key on disk is the private half, and is not what gets served",
      /PRIVATE KEY/.test(fs.readFileSync(keyFile, "utf8")) &&
      /PUBLIC KEY/.test(pem) && !/PRIVATE/.test(pem));
  }

  section("what each tier may do");
  {
    const L = limits.build({ tiers: { guest: { keepFiles: true, gpu: true, timeoutSec: 5 } } });
    ok("a guest never keeps files, whatever the config says", L.tiers.guest.keepFiles === false);
    ok("a guest never gets the GPU, whatever the config says", L.tiers.guest.gpu === false);
    ok("the settings that are adjustable are adjusted", L.tiers.guest.timeoutSec === 5);
    ok("a member keeps files", L.tiers.member.keepFiles === true);
    ok("a guest gets less of everything than a member",
      ["maxFileBytes", "quotaBytes", "memoryMb", "timeoutSec", "outputBytes"]
        .every((k) => L.tiers.guest[k] < L.tiers.member[k]));
  }

  section("the box, as the list of flags that make it one");
  {
    const d = new sandbox.DockerDriver({ storePath: "/s", images: { base: "img:1", wine: "" }, runtime: "runsc" });
    const job = { id: "abc", dir: "/s/jobs/abc", limits: limits.DEFAULTS.guest,
      plan: sandbox.plan("a.py", "data", [], "/job") };
    const a = d.args(job).argv, has = (...x) => a.join(" ").indexOf(x.join(" ")) >= 0;
    ok("no network", has("--network", "none"));
    ok("a read-only filesystem", a.indexOf("--read-only") >= 0);
    ok("no capabilities, and no way to gain any",
      has("--cap-drop", "ALL") && has("--security-opt", "no-new-privileges"));
    ok("not root", has("--user", "65534:65534"));
    ok("memory, swap, CPU and process ceilings", has("--memory", "512m") &&
      has("--memory-swap", "512m") && has("--cpus", "1") && has("--pids-limit", "64"));
    ok("the file is mounted read-only", a.some((x) => /target=.job,readonly$/.test(x)));
    ok("under gVisor when the config names it", has("--runtime", "runsc"));
    ok("nothing from the host is passed in: no socket, no device, no privilege",
      !a.some((x) => /docker.sock|--privileged|--device|--gpus|--cap-add|--pid$|=host/.test(x)), a.join(" "));
    ok("the image comes right before the command",
      a.indexOf("img:1") === a.indexOf("python3") - 1);

    let said = "";
    try { d.args(Object.assign({}, job, { plan: sandbox.plan("game.exe", "pe", [], "/job") })); }
    catch (e) { said = e.message; }
    ok("a Windows program says it is not switched on, when it is not", /not switched on/.test(said), said);

    /* A member's Windows program keeps its user folder in /save/Windows/<title>. */
    const w = new sandbox.DockerDriver({ storePath: "/s", images: { base: "img:1", wine: "wine:1" } });
    const exe = sandbox.plan("My Game!.exe", "pe", [], "/job");
    const wa = (save) => w.args(Object.assign({}, job, { plan: exe, save: save })).argv.join(" ");
    ok("a Windows program is named for its kept folder, in plain characters",
      exe.title === "My Game_" && sandbox.titleOf("../../x.zip") === "_.._x" && sandbox.titleOf(".exe") === "program");
    ok("the name never starts with a dot or holds a slash",
      ["..x.exe", "a/b.exe", "\\\\srv\\x.exe"].every((n) => !/^\.|\//.test(sandbox.titleOf(n))));
    ok("the box is told the name when there is a /save", /--env FK_TITLE=My Game_/.test(wa("/s/saves/alice")));
    ok("and not without one (a guest keeps nothing)", !/FK_TITLE/.test(wa(null)));
    ok("a window keeps the name", sandbox.plan("G.exe", "pe", [], "/job", true).title === "G");
    const ws = new sandbox.DockerDriver({ storePath: "/s", images: { base: "img:1", wine: "wine:1", screen: "scr:1" } });
    const win = (save) => ws.args(Object.assign({}, job, { plan: sandbox.plan("G.exe", "pe", [], "/job", true), save: save,
      limits: Object.assign({}, job.limits, { screen: true }) })).argv.join(" ");
    ok("a window's shader cache is kept per program in /save", /MESA_SHADER_CACHE_DIR=\/save\/\.cache\/mesa\/G /.test(win("/s/saves/a")) &&
      /MESA_SHADER_CACHE_MAX_SIZE=128M/.test(win("/s/saves/a")));
    ok("and not without a /save, or without a window", !/MESA_SHADER/.test(win(null)) && !/MESA_SHADER/.test(wa("/s/saves/alice")));

    const refuses = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
    ok("a file type nobody knows is refused in words",
      /does not know how to run/.test(refuses(() => sandbox.plan("notes.docx", "data", [], "/job"))));
    ok("a Linux program is recognised by its bytes, not its name",
      sandbox.plan("whatever", "elf", [], "/job").argv[0] === "/job/whatever");
    ok("too many arguments are refused",
      refuses(() => sandbox.plan("a.py", "data", new Array(40).fill("x"), "/job")) !== "");

    ok("a file name cannot be a path", safeName("../../etc/passwd") === "passwd" &&
      safeName("a/b/c.py") === "c.py" && safeName(".hidden") === "_hidden" && safeName("") === "file");

    ok("the unsandboxed driver is refused unless it is asked for AND local",
      /NO sandbox/.test(refuses(() => runnerd.create({ driver: "process", host: "127.0.0.1", dev: false }))) &&
      /NO sandbox/.test(refuses(() => runnerd.create({ driver: "process", host: "0.0.0.0", dev: true }))));
  }

  /* ---- a real run server, on a real port ---- */
  const STORE = path.join(TMP, "store");
  const mkApp = (extra) => runnerd.create(Object.assign({}, runnerd.DEFAULTS, {
    host: "127.0.0.1", port: 0, storePath: STORE, driver: "process", dev: true,
    ticketPublicKey: pem,
    tiers: { guest: { timeoutSec: 3, outputBytes: 20000, maxFileBytes: 4096 } } }, extra || {}), () => {});
  let app = mkApp();
  let port = await app.listen();

  section("getting in");
  {
    const h = await (await fetch("http://127.0.0.1:" + port + "/health")).json();
    ok("health says what it is and that it is ready", h.service === "fieldkit-runnerd" && h.ready === true,
      JSON.stringify(h));
    ok("and does not say who is connected or what they run",
      !("handles" in h) && !("files" in h) && Object.keys(h).every((k) => k !== "store"));

    ok("no ticket, no connection", (await connect(port, "")).open === false);
    const other = crypto.generateKeyPairSync("ed25519");
    ok("a ticket somebody else signed, no connection", (await connect(port, ticket.sign(other.privateKey,
      { handle: "mallory", tier: "admin", exp: Date.now() + 30000 }))).open === false);

    const t = sign("alice", "member");
    const a = await connect(port, t);
    ok("the relay's ticket opens it", a.open === true);
    ok("the same ticket does not open it twice", (await connect(port, t)).open === false);
    a.say({ t: "hello" });
    const r = await a.next("ready");
    ok("it says who it thinks you are", r.handle === "alice" && r.tier === "member", JSON.stringify(r).slice(0, 120));
    ok("and what you are allowed", r.limits.maxFileBytes > 0 && r.limits.keepFiles === true);
    await a.close();
  }

  section("a guest: a sandbox that lasts exactly as long as the connection");
  {
    const g = await connect(port, sign("visitor", "guest"));
    g.say({ t: "hello" });
    const ready = await g.next("ready");
    ok("a guest is told they keep nothing", ready.tier === "guest" && ready.limits.keepFiles === false);

    const up = await g.put("hello.js", HELLO);
    ok("a guest can upload", up.t === "put-done" && up.file.name === "hello.js", JSON.stringify(up));
    const guestDirs = () => fs.readdirSync(path.join(STORE, "guests"));
    ok("the file is in a folder of their own", guestDirs().length === 1);

    const job = await g.run(up.file.id, ["a", "b"]);
    ok("and run it", job.t === "job", JSON.stringify(job));
    const out = await g.next("out");
    const exit = await g.next("exit");
    ok("the output comes back", /hello from a,b/.test(out.d), out.d);
    ok("and the exit code", exit.code === 0 && exit.why === null, JSON.stringify(exit));

    const echo = await g.put("echo.js", ECHO);
    const ej = await g.run(echo.file.id);
    g.say({ t: "in", job: ej.job.id, d: "typed\n" });
    ok("what is typed reaches the program", /got:typed/.test((await g.next("out")).d));
    g.say({ t: "eof", job: ej.job.id });
    ok("closing its input lets it finish", (await g.next("exit")).code === 0);

    const bad = await g.put("lie.js", "console.log(1)", "0".repeat(64));
    ok("a file that does not match its hash is refused", bad.t === "error" && /hash/.test(bad.why), JSON.stringify(bad));
    const big = await g.put("big.js", "x".repeat(5000));
    ok("a file over the limit is refused before a byte is sent",
      big.t === "error" && /too large/.test(big.why), JSON.stringify(big));
    ok("neither left anything behind", fs.readdirSync(path.join(STORE, "tmp")).length === 0);

    const slow = await g.put("slow.js", FOREVER);
    const sj = await g.run(slow.file.id);
    await g.next("out");
    const second = await g.run(up.file.id);
    ok("a guest runs one thing at a time", second.t === "error" && /already have/.test(second.why), JSON.stringify(second));
    const t0 = Date.now();
    const timed = await g.next("exit");
    ok("a job that will not stop is stopped at the time limit",
      /time limit/.test(timed.why) && Date.now() - t0 < 6000, JSON.stringify(timed));

    const noisy = await g.put("noisy.js", NOISY);
    await g.run(noisy.file.id);
    const capped = await g.next("exit");
    ok("a job that floods its output is stopped at the output limit",
      /output limit/.test(capped.why), JSON.stringify(capped));

    const fj = await g.run(slow.file.id);
    await g.next("out");
    ok("the job is running", app._internals.jobs.has(fj.job.id));
    await g.close();
    await wait(400);
    ok("closing the connection kills it", app._internals.jobs.size === 0);
    ok("and the guest's files are gone", guestDirs().length === 0);
    ok("and nothing is staged for a job that no longer exists",
      fs.readdirSync(path.join(STORE, "jobs")).length === 0);
  }

  section("a member: files that stay, and stay theirs");
  {
    const blobs = () => { let n = 0; for (const d of fs.readdirSync(path.join(STORE, "blobs")))
      n += fs.readdirSync(path.join(STORE, "blobs", d)).length; return n; };

    let a = await connect(port, sign("alice", "member"));
    const up = await a.put("hello.js", HELLO);
    ok("a member uploads", up.t === "put-done");
    await a.close();

    a = await connect(port, sign("alice", "member"));
    a.say({ t: "hello" });
    let r = await a.next("ready");
    ok("and the file is still there next time", r.files.length === 1 && r.files[0].id === up.file.id);

    const b = await connect(port, sign("bob", "member"));
    b.say({ t: "hello" });
    ok("somebody else does not see it", (await b.next("ready")).files.length === 0);
    const stolen = await b.run(up.file.id);
    ok("and cannot run it by knowing its id", stolen.t === "error" && /no such file/.test(stolen.why));
    b.say({ t: "rm", file: up.file.id });
    ok("or delete it", (await b.next("removed")).ok === false);

    const same = await b.put("copy.js", HELLO);
    ok("the same bytes uploaded twice are stored once", same.t === "put-done" && blobs() === 1, String(blobs()));

    const slow = await a.put("slow.js", FOREVER);
    const j = await a.run(slow.file.id);
    await a.next("out");
    b.say({ t: "kill", job: j.job.id });
    b.say({ t: "in", job: j.job.id, d: "x" });
    await wait(300);
    ok("one person cannot stop another's job", app._internals.jobs.has(j.job.id));
    a.say({ t: "rm", file: slow.file.id });
    ok("a file that is running cannot be deleted", /running/.test((await a.next("error")).why));
    a.say({ t: "kill", job: j.job.id });
    ok("its owner can stop it", (await a.next("exit")).why === "stopped");

    a.say({ t: "rm", file: up.file.id });
    await a.next("removed");
    ok("deleting your copy leaves the other person's bytes alone", blobs() === 2);
    b.say({ t: "rm", file: same.file.id });
    await b.next("removed");
    ok("deleting the last copy keeps the bytes in the bin for a while", blobs() === 2);
    app.store.sweep(Date.now(), 30 * 86400000, 0);
    ok("and they go when the bin is emptied", blobs() === 1);
    await a.close(); await b.close();
  }

  section("what is left after a crash is cleaned up at the next start");
  {
    await app.close();
    fs.mkdirSync(path.join(STORE, "guests", "dead-session"), { recursive: true });
    fs.writeFileSync(path.join(STORE, "guests", "dead-session", "x"), "leftover");
    fs.mkdirSync(path.join(STORE, "jobs", "dead-job"), { recursive: true });
    app = mkApp();
    port = await app.listen();
    ok("a dead guest's folder is removed", fs.readdirSync(path.join(STORE, "guests")).length === 0);
    ok("and a dead job's", fs.readdirSync(path.join(STORE, "jobs")).length === 0);
    const a = await connect(port, sign("alice", "member"));
    a.say({ t: "hello" });
    ok("a member's files are not touched by that", (await a.next("ready")).files.length === 1);
    await a.close();
  }

  section("the relay's three routes");
  {
    const call = async (method, p, cfgExtra) => {
      let got = null;
      const res = {};
      const send = (r, status, body) => { got = { status, body }; };
      await relayRunner.route({ method, headers: {} }, res, new URL("http://relay" + p), { send });
      return got;
    };
    const init = (config) => relayRunner.init({ dataDir: path.join(TMP, "relay"), log: () => {},
      whoami: () => who, config });

    init({ enabled: true, publicUrl: "http://127.0.0.1:" + port + "/" });
    let st = (await call("GET", "/runner/status")).body;
    ok("status finds the run server and says it is ready", st.online === true && st.ready === true, JSON.stringify(st));
    ok("restarting the relay does not change its key", relayRunner._internals.publicPem() === pem);
    ok("the public key is served", /PUBLIC KEY/.test((await call("GET", "/runner/pubkey")).body.publicKey));

    who = null;
    ok("no account, no ticket", (await call("POST", "/runner/ticket")).status === 401);
    who = { banned: { until: null, reason: "x" } };
    ok("a banned account, no ticket", (await call("POST", "/runner/ticket")).status === 403);
    who = { handle: "carol", tier: "guest", user: {} };
    const t = await call("POST", "/runner/ticket");
    ok("an account gets one, with where to take it", t.status === 201 && t.body.tier === "guest" &&
      t.body.url === "http://127.0.0.1:" + port, JSON.stringify(t.body).slice(0, 80));
    const c = await connect(port, t.body.ticket);
    c.say({ t: "hello" });
    const r = await c.next("ready");
    ok("and the run server takes it at its word", r.handle === "carol" && r.tier === "guest");
    await c.close();

    /* RUNNER through the relay's own address: innerUrl is the run
       server over the tailnet, and /runner/attach is passed through. */
    init({ enabled: true, innerUrl: "http://127.0.0.1:" + port, publicUrl: "https://run.example.invalid" });
    relayRunner._internals.forget();
    st = (await call("GET", "/runner/status")).body;
    ok("with innerUrl, status asks the run server the short way", st.online === true && st.viaRelay === true, JSON.stringify(st));
    const tv = await call("POST", "/runner/ticket");
    ok("and the ticket says to come through the relay, publicUrl kept as a spare",
      tv.status === 201 && tv.body.viaRelay === true && tv.body.urls[0] === "https://run.example.invalid");
    const relaySrv = require("http").createServer((q, s) => { s.writeHead(404); s.end(); });
    relaySrv.on("upgrade", (q, sock, head) => {
      const u = new URL(q.url, "http://relay");
      if (relayRunner.isAttach(u)) return relayRunner.attach(q, sock, head, u);
      sock.destroy();
    });
    await new Promise((r) => relaySrv.listen(0, "127.0.0.1", r));
    const rport = relaySrv.address().port;
    /* The relay's path is /runner/attach (connect() dials the run server's /attach). */
    const dialRelay = (t) => new Promise((resolve) => {
      const sock = new WebSocket("ws://127.0.0.1:" + rport + "/runner/attach?t=" + encodeURIComponent(t));
      const c = { sock, got: [], open: false };
      sock.addEventListener("open", () => { c.open = true; sock.send(JSON.stringify({ t: "hello" })); });
      sock.addEventListener("message", (e) => { c.got.push(JSON.parse(e.data)); if (c.got.some((m) => m.t === "ready")) resolve(c); });
      sock.addEventListener("close", () => resolve(c));
      sock.addEventListener("error", () => resolve(c));
      setTimeout(() => resolve(c), 8000);
    });
    const cv = await dialRelay(tv.body.ticket);
    const rv = cv.got.find((m) => m.t === "ready");
    ok("a panel reaches the run server through the relay, ticket and all", cv.open && rv && rv.handle === "carol", JSON.stringify(cv.got).slice(0, 200));
    try { cv.sock.close(); } catch (e) {}
    const again = await dialRelay(tv.body.ticket);
    ok("the run server still refuses a spent ticket that came through the relay", !again.open);
    ok("other paths are not passed through", !relayRunner.isAttach(new URL("http://relay/runner/attach/../status")) &&
      !relayRunner.isAttach(new URL("http://relay/browser/stream")));
    init({ enabled: true, innerUrl: "http://127.0.0.1:1", publicUrl: "" });
    const dead = await dialRelay(sign("carol", "guest"));
    ok("with the run server unreachable, the panel gets a refusal (and tries its spares)", !dead.open);
    init({ enabled: true, innerUrl: "https://not-allowed.example:443", publicUrl: "" });
    ok("innerUrl must be plain http://host:port over the tailnet", relayRunner._internals.inner() === "");
    await new Promise((r) => relaySrv.close(r));
    init({ enabled: true, publicUrl: "http://127.0.0.1:" + port + "/" });

    await app.close();
    relayRunner._internals.forget();
    st = (await call("GET", "/runner/status")).body;
    ok("with the run server down, status says so in a sentence",
      st.online === false && st.why === "the run server is offline", JSON.stringify(st));
    const off = await call("POST", "/runner/ticket");
    ok("and a ticket is refused with the same sentence, not an exception",
      off.status === 503 && off.body.offline === true && /offline/.test(off.body.error));

    init({ enabled: true, publicUrl: "" });
    ok("a relay with no run server configured says that instead",
      /not been set up/.test((await call("GET", "/runner/status")).body.why));
    init({ enabled: false });
    ok("switched off, status still answers", (await call("GET", "/runner/status")).body.enabled === false);
    ok("and everything else says it is off", (await call("POST", "/runner/ticket")).status === 503);
  }

  section("everything runnerd loads actually ships");
  {
    /* The image copies named files and make-deploy copies from an
       allow list, so a module that is required but not listed is a
       run server that starts fine here and not on Bastion 2. Both
       lists are read as text, the way they are used. */
    const dir = path.join(__dirname, "..", "runnerd");
    /* server.js, and egress.js, which compose.yml starts on its own. */
    const needed = new Set(["runnerd/server.js", "runnerd/egress.js"]);
    for (const name of fs.readdirSync(dir).filter((n) => /\.js$/.test(n))) {
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      for (const m of src.matchAll(/require\("\.\/([\w-]+)"\)/g)) needed.add("runnerd/" + m[1] + ".js");
      for (const m of src.matchAll(/require\("\.\.\/relay\/([\w-]+)"\)/g)) needed.add("relay/" + m[1] + ".js");
    }
    const image = fs.readFileSync(path.join(dir, "Dockerfile"), "utf8");
    const bundle = fs.readFileSync(path.join(__dirname, "..", "tools", "make-deploy.js"), "utf8");
    for (const f of needed) {
      const base = f.split("/").pop();
      ok("the image copies " + f, image.includes(f) || new RegExp("COPY[^\\n]*" + f.split("/")[0] + "/[^\\n]*" + base.replace(".", "\\.")).test(image));
      ok("the Bastion 2 bundle carries " + f, bundle.includes('"' + f + '"'));
    }
  }

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
