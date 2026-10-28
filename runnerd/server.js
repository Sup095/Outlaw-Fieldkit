/* ============================================================
   FieldKit runnerd — runs uploaded files on Bastion 2

   The data plane of RUNNER (RUNNER_PLAN.md §3). The relay decides
   WHO somebody is and signs a one-minute ticket saying so; this
   process believes the ticket and nothing else, runs the file in
   a sandbox, and streams what it prints.

   ONE CONNECTION PER PERSON. Uploads, commands, input and output
   all travel over a single WebSocket. The relay is asked for one
   ticket and then is not involved again, so a busy afternoon here
   costs the relay nothing.

   WHAT A GUEST GETS. An account nobody has approved still gets a
   sandbox — small, short, no GPU — and it exists exactly as long
   as their connection does. Close the tab, lose the Wi-Fi, sign
   out: the jobs are killed and the files are deleted. That is not
   a cleanup task that might run later; it is what closing the
   socket does.

   WHAT A MEMBER GETS. Their programs belong to their account, not
   to the connection that started them. Close the panel and a job
   keeps running to its time limit; open RUNNER again, from any
   device, and it re-attaches with the recent output. A job that
   finished while nobody was watching leaves its result to be picked
   up. They also get a saved folder (/save, save.js) and the web
   through the filter (egress.js).

   Zero npm dependencies, like the relay. The WebSocket framing is
   the relay's own ws.js.
   ============================================================ */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");
const ws = require("../relay/ws");
const ticket = require("./ticket");
const limits = require("./limits");
const sandbox = require("./sandbox");
const { Store } = require("./store");
const { Admin, overview, command } = require("./admin");
const { Saves } = require("./save");
const { Power } = require("./power");
const zip = require("./zip");
const { Access, IDLE_CPU } = require("./access");

const VERSION = 1;
const CHUNK_MAX = 1024 * 1024;          /* one upload frame */
const TEXT_MAX = 128 * 1024;            /* one command */
const FLUSH_MS = 40, FLUSH_BYTES = 32 * 1024;
const MSGS_PER_SEC = 120;
/* A screen's frames to one viewer: past HIGH bytes waiting on their
   connection, video is dropped until a keyframe can be sent with less
   than LOW waiting. A slow Chromebook gets fewer frames, not a queue
   that grows until the server runs out of memory. */
const SCREEN_HIGH = 1024 * 1024, SCREEN_LOW = 256 * 1024;
const UI_MAX = 64;                      /* input events in one message */

const DEFAULTS = {
  host: "127.0.0.1", port: 25580,
  storePath: path.join(__dirname, "data"), storeHostPath: "",
  driver: "docker", runtime: "", dockerBin: "docker",
  images: { base: "fieldkit-runner:1", wine: "", screen: "fieldkit-runner-screen:1" },
  screen: {},                    /* sandbox.js SCREEN has the defaults */
  gpu: { runtime: "" },          /* "runsc-gpu", written by setup.sh when the card works inside gVisor */
  relayUrl: "", ticketPublicKey: "",
  dev: false, tiers: {}, machine: {},
  ttlDays: 30, pressureTtlDays: 14, tombstoneHours: 48, sweepHours: 6,
  finishedHours: 24,             /* how long a result waits for its owner */
  egress: {},                    /* sandbox.js EGRESS has the defaults */
  powerFile: "/run/fieldkit/power.json"   /* written by fk-power on the host (setup.sh) */
};
const SAVE_GET_MAX = 32 * 1024 * 1024, SAVE_CHUNK = 192 * 1024;

function loadConfig(file) {
  let raw = {};
  if (file) {
    /* A broken config is fatal, not a fallback to defaults. Defaults
       here would mean "no relay key", which looks like every ticket
       being refused and nothing like a typo. */
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const cfg = Object.assign({}, DEFAULTS, raw);
  cfg.images = Object.assign({}, DEFAULTS.images, raw.images || {});
  return cfg;
}

const isLoopback = (h) => h === "127.0.0.1" || h === "::1" || h === "localhost";

function create(cfg, logFn) {
  const log = logFn || ((lvl, msg) => console.log(new Date().toISOString() + " [" + lvl + "] " + msg));

  if (cfg.driver === "process" && !(cfg.dev === true && isLoopback(cfg.host))) {
    throw new Error("the 'process' driver runs uploaded files with NO sandbox. It is refused " +
      "unless dev is true AND host is loopback. Use the docker driver.");
  }

  const L = limits.build({ tiers: cfg.tiers, machine: cfg.machine });
  const store = new Store(cfg.storePath);
  const driver = sandbox.make(cfg, log);
  const spent = new ticket.Spent();
  const admin = new Admin(cfg.storePath);
  const saves = new Saves(cfg.storePath);
  const power = new Power({ file: cfg.powerFile, settingsFile: path.join(cfg.storePath, "power-settings.json") });
  /* Who gets in, and the line (access.js). */
  const access = new Access({ settingsFile: path.join(cfg.storePath, "access-settings.json"),
    sent: () => state.sentBytes,
    other: () => (relayFresh() ? state.relayUp.kbps : 0),
    otherWaiting: () => (relayFresh() ? state.relayUp.wait : 0),
    otherAt: () => (state.relayUp ? state.relayUp.at : 0) });
  function relayFresh() { return !!(state.relayUp && Date.now() - state.relayUp.at < 15000); }
  const reports = new ticket.Spent();

  /* The relay's signed report of its browser's upload, carried on its
     health check. Believed only if it verifies, once. */
  function takeReport(text) {
    if (!text || !state.key) return;
    const v = ticket.verifyReport(state.key, text);
    if (!v.ok || !reports.use(v.claims)) return;
    state.relayUp = { kbps: v.claims.up, wait: Math.max(0, Math.min(1000, v.claims.wait | 0)), at: Date.now() };
    if (!state.relayHeard) { state.relayHeard = true; log("INFO", "runnerd: hearing the relay's load reports (one home upload for both)"); }
  }

  /* How busy a job's processor is, in % of one; null when it cannot be
     told (then nothing is ended on its account). Tests replace it. */
  let cpuOf = (j) => (j.ctl && j.ctl.cpu ? j.ctl.cpu() : Promise.resolve(null));
  const DAY = 86400000;
  const RENEW_MS = 20 * 60 * 1000;     /* the panel renews every 10 */

  /* Disk pressure (RUNNER_PLAN.md §7): at 80% the expiry clock drops
     to 14 days; at 90% only admins can upload. */
  function pressure() {
    const p = store.disk().pct;
    return p >= 0.9 ? "full" : p >= 0.8 ? "high" : "ok";
  }
  const ttlMs = () => (pressure() === "ok" ? cfg.ttlDays : Math.min(cfg.ttlDays, cfg.pressureTtlDays)) * DAY;
  const tombMs = () => cfg.tombstoneHours * 3600000;

  /* Each of a member's files says when it will be deleted, so the
     panel can warn a week ahead. Library files never expire. */
  function decorate(f) {
    if (f.library) return f;
    const at = store.expiresAt(f, ttlMs());
    return Object.assign({}, f, { expiresAt: new Date(at).toISOString(),
      expiringSoon: at - Date.now() < 7 * DAY });
  }

  function runSweep() {
    const now = Date.now();
    const r = store.sweep(now, ttlMs(), tombMs());
    r.saves = saves.sweep(now, ttlMs(), (h) => count((j) => j.handle === h) > 0);
    if (r.expired.length || r.purged || r.saves) {
      log("INFO", `runnerd: sweep — ${r.expired.length} file(s) expired, ${r.purged} removed from the bin, ` +
        `${r.saves} unused saved folder(s) deleted`);
    }
    return r;
  }

  /* Closes every session a person has, and stops every job they run:
     a member's jobs outlive their connections, so closing those is
     not enough on its own. */
  function kick(handle, why) {
    for (const j of jobs.values()) if (j.handle === handle) j.stop(why);
    let n = 0;
    for (const s of Array.from(sessions.values())) {
      if (s.handle !== handle) continue;
      tell(s, { t: "denied", why: why });
      try { s.sock.close(4003, "denied"); } catch (e) {}
      endSession(s, why);
      n++;
    }
    return n;
  }

  /* A session whose ticket was not renewed in time is closed. */
  function checkRenewals(now) {
    now = now || Date.now();
    for (const x of Array.from(sessions.values())) {
      if (x.renewBy < now) {
        tell(x, { t: "denied", why: "your sign-in could not be renewed. Sign in to MESSAGES again." });
        try { x.sock.close(4002, "not renewed"); } catch (e) {}
        endSession(x, "not renewed");
      }
    }
  }

  const until = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const sessions = new Map();           /* sid -> session */
  const jobs = new Map();               /* job id -> job */
  const finished = new Map();           /* handle -> results nobody was watching for */

  /* Whose a job is. A guest's belongs to the one connection (it dies
     with it); a member's to the account, so any of their sessions,
     on any device, can watch it, type into it or stop it. */
  const whoOf = (s) => (s.owner.kind === "guest" ? "g:" + s.sid : "u:" + s.handle);
  const mine = (s, j) => !!j && j.who === whoOf(s);
  const send = (job, obj) => { for (const w of job.watchers) tell(w, obj); };

  function keepResult(job, rec) {
    const list = (finished.get(job.handle) || []).concat([rec]).slice(-10);
    finished.set(job.handle, list);
  }
  function takeResults(handle) {
    const cut = Date.now() - cfg.finishedHours * 3600000;
    const list = (finished.get(handle) || []).filter((r) => r.endedAt >= cut);
    finished.delete(handle);
    return list;
  }
  function pruneResults() {
    const cut = Date.now() - cfg.finishedHours * 3600000;
    for (const [h, list] of finished) {
      const keep = list.filter((r) => r.endedAt >= cut);
      if (keep.length) finished.set(h, keep); else finished.delete(h);
    }
  }

  const fmtMb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB");
  const state = { key: null, keyWhy: "the relay's key has not been fetched yet",
    driverCheck: null, upSince: Date.now(), ran: 0, sentBytes: 0 };
  const screenReady = () => !!(state.driverCheck && state.driverCheck.images && state.driverCheck.images.screen);
  const gpuReady = () => !!(state.driverCheck && state.driverCheck.gpu && sandbox.gpuRuntime(cfg));
  const screenCfg = Object.assign({}, sandbox.SCREEN, cfg.screen || {});

  /* ---- the relay's public key ---- */
  function setKey(pem, from) {
    try { state.key = ticket.loadPublicKey(pem); state.keyWhy = null; }
    catch (e) { state.key = null; state.keyWhy = "the key from " + from + " is not a public key"; }
    return !!state.key;
  }

  async function fetchKey() {
    if (cfg.ticketPublicKey) return setKey(cfg.ticketPublicKey, "config");
    if (!cfg.relayUrl) { state.keyWhy = "neither relayUrl nor ticketPublicKey is set"; return false; }
    try {
      const res = await fetch(String(cfg.relayUrl).replace(/\/+$/, "") + "/runner/pubkey",
        { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error("the relay answered " + res.status);
      const body = await res.json();
      if (!body || !body.publicKey) throw new Error("the relay sent no key");
      const had = !!state.key;
      if (setKey(body.publicKey, "the relay") && !had) log("INFO", "runnerd: have the relay's ticket key");
      return !!state.key;
    } catch (e) {
      /* Keep an old key if there is one. A relay that is briefly
         down should not log everybody out of a machine that is up. */
      if (!state.key) state.keyWhy = "could not get the relay's key: " + e.message;
      return false;
    }
  }

  /* ---- counting ---- */
  const count = (pred) => { let n = 0; for (const x of jobs.values()) if (pred(x)) n++; return n; };

  /* What each program is using, every 10 s while any run (phase 10's
     "measure first"). Admins see it in the overview; each program's
     own watchers are sent it, so people can see what their program
     costs. One sample at a time; a slow docker just skips a turn. */
  let sampling = false;
  async function sampleUse() {
    if (sampling || !jobs.size || typeof driver.stats !== "function") return;
    sampling = true;
    try {
      const got = await driver.stats(Array.from(jobs.keys()));
      const at = Date.now();
      for (const [id, u] of Object.entries(got)) {
        const j = jobs.get(id);
        if (!j || j.ended) continue;
        j.use = { cpu: u.cpu, memMb: u.memMb, at: at };
        for (const w of j.watchers || []) tell(w, { t: "use", job: id, cpu: u.cpu, memMb: u.memMb, memLimitMb: j.limits.memoryMb });
      }
    } catch (e) { /* never fatal */ }
    sampling = false;
  }
  const useTimer = setInterval(sampleUse, cfg.useEverySec ? cfg.useEverySec * 1000 : 10000);
  if (useTimer.unref) useTimer.unref();
  const sessionCount = (pred) => { let n = 0; for (const s of sessions.values()) if (pred(s)) n++; return n; };

  function health() {
    return { service: "fieldkit-runnerd", version: VERSION,
      ready: !!state.key && !!(state.driverCheck && state.driverCheck.ok),
      why: state.keyWhy || (state.driverCheck && !state.driverCheck.ok ? state.driverCheck.why : null),
      sandbox: driver.name + (cfg.runtime ? " + " + cfg.runtime : ""),
      windows: !!cfg.images.wine,
      internet: !!(state.driverCheck && state.driverCheck.egress),
      screens: screenReady(), screensInUse: count((j) => !!j.plan.screen), gpu: gpuReady(),
      sessions: sessions.size, jobs: jobs.size, ran: state.ran, upSince: state.upSince,
      /* For the relay, whose browser shares the home line and the
         thresholds (RUNNER_PLAN.md §22). Numbers only. */
      load: { upKbps: access.meter.upKbps, waiting: access.line.length,
        settings: (() => { const s = access.settings(); return { guest: s.guest, member: s.member, uploadMbps: s.uploadMbps }; })() } };
  }

  /* ---- jobs ---- */
  /* The machine-wide counts, which everybody but admins is held to. */
  function countsOk(kind, tier) {
    if (tier === "admin") return true;
    if (jobs.size >= L.machine.maxJobs) return false;
    if (tier === "guest" && count((j) => j.tier === "guest") >= L.machine.maxGuestJobs) return false;
    if (kind === "screen" && count((j) => !!j.plan.screen) >= L.machine.maxScreens) return false;
    return true;
  }
  const kindOf = (j) => (j.plan.screen ? "screen" : "console");
  const runningOf = (kind) => count((j) => kindOf(j) === kind);
  const placeOf = (e) => access.place(e, runningOf(e.kind));
  const toWho = (who, obj) => { for (const x of sessions.values()) if (whoOf(x) === who) tell(x, obj); };

  /* Every 2 s: the meter, then the line moves (offers, lapsed places,
     and runs held to their share while people wait). */
  function tickAccess(sampleToo) {
    if (sampleToo !== false) access.sample();
    if (state.relayHeard && state.relayUp && Date.now() - state.relayUp.at > 120000) {
      state.relayHeard = false;
      log("WARN", "runnerd: the relay's load reports stopped; counting only this machine's upload");
    }
    /* Windows' video follows the house upload (§22 point 5). */
    const k = access.videoKbps(screenCfg.kbps);
    if (k !== state.screenKbps) {
      if (state.screenKbps) log("INFO", "runnerd: windows' video " + (k < state.screenKbps ? "down" : "up") + " to " + k + " kbit/s");
      state.screenKbps = k;
      for (const j of jobs.values()) if (j.screen && j.ctl && !j.ended) { j.kbps = k; j.ctl.write(JSON.stringify({ t: "rate", k: k }) + "\n"); }
    }
    if (!access.line.length) return;
    const r = access.pump({ countsOk: countsOk,
      online: (who) => Array.from(sessions.values()).some((x) => whoOf(x) === who),
      running: () => Array.from(jobs.values()).map((j) => ({ id: j.id, kind: kindOf(j), tier: j.tier,
        startedAt: j.startedAt, lastInput: j.lastInput, lastOut: j.lastOut, warned: j.warned })) });
    const turn = access.settings().turnSec;
    r.offer.forEach((e) => {
      log("INFO", `runnerd: ${e.handle}'s turn for a ${e.kind}`);
      toWho(e.who, { t: "turn", id: e.id, kind: e.kind, name: e.req.name, seconds: turn });
    });
    r.lapsed.forEach((x) => toWho(x.e.who, { t: "line-gone", id: x.e.id, why: x.why }));
    r.warn.forEach((w) => {
      const j = jobs.get(w.id);
      if (!j) return;
      j.warned = true;
      send(j, { t: "out", job: j.id, s: "stderr", d: "\n[" + w.text + "]\n" });
    });
    r.end.forEach((x) => { const j = jobs.get(x.id); if (j) j.stop(x.why); });
    /* Quiet console programs: asked about at most once a minute each. */
    r.quiet.forEach((x) => {
      const j = jobs.get(x.id);
      if (!j || Date.now() - (j.cpuAsked || 0) < 60000) return;
      j.cpuAsked = Date.now();
      const quietSince = Math.max(j.lastInput || 0, j.lastOut || 0);
      cpuOf(j).then((pct) => {
        if (pct == null || pct >= IDLE_CPU || !jobs.has(j.id) || j.ended) return;
        if (Math.max(j.lastInput || 0, j.lastOut || 0) !== quietSince) return;
        log("INFO", "runnerd: ended " + j.handle + "'s idle program " + j.id + " (" + pct + "% of a processor)");
        j.stop(x.why);
      }).catch(() => {});
    });
    /* Everyone waiting hears where they are. */
    for (const x of sessions.values()) {
      const mine = access.mine(whoOf(x));
      if (mine.length) tell(x, { t: "line", entries: mine.map(placeOf) });
    }
  }

  function startJob(s, m, fromLine) {
    const lim = s.limits;
    const st = admin.state(s.handle);
    if (st.suspended) throw new Error("you are suspended from RUNNER until " + until(st.suspended.until) + ": " + st.suspended.reason);
    if (st.cooldown) throw new Error("you cannot start anything until " + until(st.cooldown.until) + ": " + st.cooldown.reason);
    const who = whoOf(s);
    if (count((j) => j.who === who) >= lim.concurrentJobs) {
      throw new Error("you already have " + lim.concurrentJobs + " thing(s) running — stop one first");
    }
    const kind = store.sniff(s.owner, m.file);
    if (!kind) throw new Error("no such file");
    const entry = store.find(s.owner, m.file);
    if (admin.denied(entry.sha256)) throw new Error("that file has been blocked on this server by an admin");
    const wantScreen = !!m.screen;
    if (wantScreen) {
      if (!lim.screen) throw new Error("programs with a window are for approved members — ask an admin to approve you");
      if (!screenReady()) throw new Error("programs with a window are not switched on for this server yet");
    }
    let inZip = null;
    if (kind === "zip") {
      const e = zip.cleanEntry(m.entry);
      if (!e) throw new Error("choose which file inside the zip to run");
      /* Unpacked into /work, which also holds a Windows program's prefix. */
      inZip = { entry: e, capBytes: Math.floor(lim.workMb * 1048576 * 0.85) };
    }
    const plan = sandbox.plan(entry.name, kind, m.args, "/job", wantScreen, inZip);

    /* Room for it? If not, the line rather than an error (RUNNER_PLAN.md
       §22). Admins always get in. Coming from the line, the room was
       held for this person and is checked by "take". */
    const runKind = wantScreen ? "screen" : "console";
    if (!fromLine && s.tier !== "admin") {
      const fits = access.fits(s.tier, runKind, countsOk(runKind, s.tier)) && !access.someoneAhead(s.tier, runKind, who);
      if (!fits) {
        const why = access.someoneAhead(s.tier, runKind, who) ? "others are already waiting" : access.why(s.tier, runKind, countsOk(runKind, s.tier));
        const e = access.join({ who: who, handle: s.handle, tier: s.tier, kind: runKind, owner: s.owner,
          req: { file: m.file, args: Array.isArray(m.args) ? m.args.slice(0, 64) : [], screen: wantScreen, name: entry.name } });
        log("INFO", `runnerd: ${s.handle} (${s.tier}) waits for a ${runKind} — ${why}`);
        return { queued: placeOf(e), why: why };
      }
    }

    /* The saved folder: a full one refuses the run, rather than
       letting it start and stopping it a few seconds in. */
    let save = null;
    if (lim.saveBytes > 0 && s.owner.kind === "user") {
      const used = saves.measure(s.handle, lim);
      if (used.over) {
        throw new Error("your saved folder (/save) is over its limit of " + fmtMb(lim.saveBytes) + " or " +
          lim.saveFiles + " files. Delete something from it first.");
      }
      save = saves.ensure(s.handle);
      saves.touch(s.handle);
    }

    const id = crypto.randomBytes(8).toString("hex");
    const staged = store.stage(s.owner, m.file, id);
    const job = { id: id, sid: s.sid, who: who, handle: s.handle, tier: s.tier, file: entry.id, name: entry.name,
      dir: staged.dir, plan: plan, limits: lim, startedAt: Date.now(), lastInput: Date.now(), lastOut: 0, warned: false, bytes: 0, why: null,
      kbps: wantScreen ? (state.screenKbps || screenCfg.kbps) : 0,
      sha256: entry.sha256, library: !!entry.library,
      save: save, wantNet: !!lim.internet, keep: !!lim.keepRunning,
      watchers: new Set([s]), tail: [], tailBytes: 0,
      buf: { stdout: "", stderr: "" }, dec: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
      flushTimer: null, ended: false,
      screen: wantScreen ? { w: screenCfg.width, h: screenCfg.height, sound: null } : null,
      /* The card encodes a member's screen, unless an admin said no. */
      gpu: wantScreen && !!lim.gpu && !st.noGpu && gpuReady(),
      /* The encoder is set to screenCfg.kbps, but what arrives was
         written inside the box, by code that could be the program's.
         Twice the setting, enforced here, is the most it can cost. */
      vrate: wantScreen ? { left: screenCfg.kbps * 250, at: Date.now(), drop: false } : null };

    /* The recent output, so whoever attaches later sees where it is. */
    const remember = (k, d) => {
      job.tail.push({ s: k, d: d });
      job.tailBytes += d.length;
      while (job.tailBytes > lim.scrollbackBytes && job.tail.length > 1) job.tailBytes -= job.tail.shift().d.length;
    };

    const flush = () => {
      job.flushTimer = null;
      ["stdout", "stderr"].forEach((k) => {
        if (!job.buf[k]) return;
        send(job, { t: "out", job: id, s: k, d: job.buf[k] });
        remember(k, job.buf[k]);
        job.buf[k] = "";
      });
    };

    const stop = (why) => { if (!job.why) job.why = why; if (job.ctl) job.ctl.kill(); };
    job.stop = stop;

    try {
      job.ctl = driver.start(job, {
        out(stream, chunk) {
          if (job.ended) return;
          if (!chunk.length) return;
          job.lastOut = Date.now();
          job.bytes += chunk.length;
          if (job.bytes > lim.outputBytes) return stop("it printed more than the output limit");
          job.buf[stream] += job.dec[stream].write(chunk);
          if (job.buf.stdout.length + job.buf.stderr.length >= FLUSH_BYTES) {
            if (job.flushTimer) clearTimeout(job.flushTimer);
            flush();
          } else if (!job.flushTimer) job.flushTimer = setTimeout(flush, FLUSH_MS);
        },
        status(st) {
          if (!job.screen) return;
          const w = Math.max(16, Math.min(3840, st.w | 0)), h = Math.max(16, Math.min(2160, st.h | 0));
          job.screen = { w: w, h: h, sound: !!st.sound, enc: st.enc === "gpu" ? "gpu" : "cpu" };
          send(job, { t: "screen", job: id, screen: job.screen });
        },
        video(data, key) {
          if (job.ended || !job.vrate) return;
          if (!spend(job.vrate, data.length, screenCfg.kbps * 250)) { job.vrate.drop = true; return; }
          if (job.vrate.drop && !key) return;
          job.vrate.drop = false;
          frame(job, 1, key, data);
        },
        audio(data) {
          if (job.ended || !job.vrate) return;
          if (!spend(job.vrate, data.length, screenCfg.kbps * 250)) return;
          frame(job, 2, false, data);
        },
        exit(code, failure) {
          if (job.ended) return;
          job.ended = true;
          clearTimeout(job.timer);
          if (job.flushTimer) clearTimeout(job.flushTimer);
          flush();
          jobs.delete(id);
          access.ended(kindOf(job), Date.now() - job.startedAt);
          setImmediate(() => tickAccess(false));
          if (job.saveTimer) clearInterval(job.saveTimer);
          store.unstage(id);
          /* 137 is "killed", and when nothing here did the killing it
             was the kernel enforcing the memory ceiling. Without this
             a program that ran out of memory just says "code 137",
             which tells the person who wrote it nothing. */
          if (!job.why && !failure && code === 137) {
            job.why = "it was killed, most likely for using more than its " + lim.memoryMb + " MB of memory";
          }
          const result = { t: "exit", job: id, code: code, why: job.why || failure || null,
            ms: Date.now() - job.startedAt };
          send(job, result);
          if (!job.watchers.size && job.keep) {
            /* Nobody was watching: kept, with the end of its output,
               for whenever they next open RUNNER. */
            keepResult(job, Object.assign({}, result, { name: job.name, file: job.file,
              endedAt: Date.now(), tail: job.tail }));
          }
          log("INFO", `runnerd: job ${id} (${s.handle}, ${s.tier}) ended` +
            (job.why ? " — " + job.why : " with code " + code) +
            (job.watchers.size ? "" : " while detached"));
        }
      });
    } catch (e) {
      store.unstage(id);
      throw e;
    }

    jobs.set(id, job);
    state.ran++;
    job.timer = setTimeout(() => stop("it ran past the time limit (" + lim.timeoutSec + " s)"),
      lim.timeoutSec * 1000);
    if (save) {
      job.saveTimer = setInterval(() => {
        if (saves.measure(s.handle, lim).over) {
          stop("its saved folder (/save) went over the limit of " + fmtMb(lim.saveBytes) + " or " + lim.saveFiles + " files");
        }
      }, 3000);
      job.saveTimer.unref();
    }
    log("INFO", `runnerd: job ${id} started for ${s.handle} (${s.tier}): ${entry.name}` +
      (job.wantNet ? ", filtered internet" : "") + (save ? ", /save" : "") + (wantScreen ? ", with a screen" + (job.gpu ? " on the GPU" : "") : ""));
    return describe(job);
  }

  /* ---- a screen's frames ----
     Binary, so video is not inflated by a third as base64 text:
       kind (1 = video, 2 = sound) | flags (1 = keyframe) | id length | id | payload */
  function spend(b, bytes, perSec) {
    const now = Date.now();
    b.left = Math.min(perSec, b.left + (now - b.at) * perSec / 1000);
    b.at = now;
    if (b.left < bytes) return false;
    b.left -= bytes;
    return true;
  }

  function frame(job, kind, key, data) {
    const head = Buffer.alloc(3 + job.id.length);
    head[0] = kind; head[1] = key ? 1 : 0; head[2] = job.id.length;
    head.write(job.id, 3, "latin1");
    const pkt = Buffer.concat([head, data]);
    for (const w of job.watchers) sendFrame(w, job.id, pkt, kind === 1, key);
  }

  function sendFrame(s, id, pkt, video, key) {
    if (!s.alive) return;
    const waiting = s.sock.sock ? s.sock.sock.writableLength : 0;
    if (!s.vskip) s.vskip = new Set();
    if (video) {
      if (s.vskip.has(id)) {
        if (!key || waiting > SCREEN_LOW) return;
        s.vskip.delete(id);
      } else if (waiting > SCREEN_HIGH) { s.vskip.add(id); return; }
    } else if (waiting > SCREEN_HIGH) return;
    try { if (s.sock.send(pkt)) state.sentBytes += pkt.length; } catch (e) {}
  }

  /* Input for a screen, checked field by field: it is written to a
     program inside the box, so nothing but these shapes gets there. */
  function cleanUi(e, sc) {
    if (!e || typeof e !== "object") return null;
    const d = e.d ? 1 : 0;
    const int = (v, hi) => Math.max(0, Math.min(hi, Math.round(Number(v) || 0)));
    switch (e.t) {
      case "m": return { t: "m", x: int(e.x, sc.w - 1), y: int(e.y, sc.h - 1) };
      case "b": return { t: "b", b: Math.max(1, Math.min(3, e.b | 0)), d: d };
      case "w": return { t: "w", y: Number(e.y) > 0 ? 1 : -1 };
      case "k": return /^[A-Za-z0-9]{1,24}$/.test(String(e.c)) ? { t: "k", c: String(e.c), d: d } : null;
      default: return null;
    }
  }

  function describe(j, withTail) {
    const d = { id: j.id, file: j.file, name: j.name, startedAt: j.startedAt,
      timeoutSec: j.limits.timeoutSec, keepRunning: j.keep, internet: j.wantNet, save: !!j.save,
      screen: j.screen || null };
    if (withTail) d.tail = j.tail;
    return d;
  }

  function tell(s, obj) { if (s.alive) { try { s.sock.send(JSON.stringify(obj)); } catch (e) {} } }

  function endSession(s, why) {
    if (!s.alive) return;
    s.alive = false;
    sessions.delete(s.sid);
    if (s.upload) { s.upload.h.abort(); s.upload = null; }
    for (const j of jobs.values()) {
      if (!j.watchers.delete(s)) continue;
      if (j.watchers.size) continue;
      if (j.keep) log("INFO", `runnerd: job ${j.id} (${j.handle}) keeps running with nobody watching`);
      else j.stop("the connection closed");
    }
    if (s.tier === "guest") {
      /* The whole point of the guest tier, done where it cannot be
         skipped: this is the socket closing, not a timer. */
      store.dropGuest(s.sid);
    }
    log("INFO", `runnerd: ${s.handle} (${s.tier}) left — ${why || "closed"}` +
      (s.tier === "guest" ? "; guest sandbox wiped" : ""));
  }

  /* ---- what a connected person can say ---- */
  function onText(s, m) {
    if (m.t.indexOf("adm-") === 0) {
      if (s.tier !== "admin") throw new Error("admins only");
      const ctx = { store, admin, jobs, sessions, kick, decorate, ttlMs, pressure, sweep: runSweep, saves, power,
        access, runningOf, tellWho: toWho, tickAccess,
        tombHours: () => cfg.tombstoneHours };
      const ref = String(m.ref || "").slice(0, 40);
      if (m.t === "adm-overview") return tell(s, { t: "adm", ref: ref, data: overview(ctx) });
      return tell(s, Object.assign({ t: "adm-done", ref: ref }, command(ctx, s, m)));
    }
    switch (m.t) {
      case "hello":
      case "ls": {
        /* The library, each title with how many are running it now. */
        const libraryView = () => store.library().map((f) => Object.assign(f,
          { playing: count((j) => j.library && j.file === f.id) }));
        const st = admin.state(s.handle);
        const files = store.list(s.owner);
        tell(s, { t: m.t === "hello" ? "ready" : "files", handle: s.handle, tier: s.tier,
          limits: limits.publicView(s.limits), usage: store.usage(s.owner),
          files: s.owner.kind === "guest" ? files : files.map(decorate),
          library: libraryView(), windows: !!cfg.images.wine, pressure: pressure(),
          screens: screenReady() && !!s.limits.screen,
          internet: !!(s.limits.internet && state.driverCheck && state.driverCheck.egress),
          ttlDays: Math.round(ttlMs() / DAY),
          notices: st.warnings.map((w) => ({ kind: "warning", by: w.by, at: w.at, reason: w.reason }))
            .concat(st.cooldown ? [{ kind: "cooldown", until: st.cooldown.until, reason: st.cooldown.reason }] : []),
          /* Saying hello attaches: every job of yours that is running,
             with its recent output, and the results of any that ended
             while nobody was watching. */
          jobs: Array.from(jobs.values()).filter((j) => mine(s, j)).map((j) => {
            if (m.t === "hello") {
              j.watchers.add(s);
              /* Joining mid-stream: pictures start at the next keyframe. */
              if (j.screen) { if (!s.vskip) s.vskip = new Set(); s.vskip.add(j.id); }
            }
            return describe(j, m.t === "hello");
          }),
          finished: m.t === "hello" && s.owner.kind === "user" ? takeResults(s.handle) : [],
          line: access.mine(whoOf(s)).map(placeOf),
          save: s.limits.saveBytes > 0 ? Object.assign(saves.measure(s.handle), { limitBytes: s.limits.saveBytes,
            limitFiles: s.limits.saveFiles }) : null });
        if (m.t === "hello") admin.seen(s.handle);
        return;
      }

      /* What is inside a .zip of yours (or the library's), so the panel
         can ask which file to run. Only the index is read. */
      case "zip-ls": {
        const ref = String(m.ref || "").slice(0, 40);
        if (store.sniff(s.owner, m.file) !== "zip") throw new Error("that is not a zip file");
        const l = zip.list(store.pathOf(s.owner, m.file));
        return tell(s, { t: "zip", ref: ref, file: m.file, runnable: zip.runnable(l.entries).slice(0, 200),
          files: l.entries.length, total: l.total, truncated: l.truncated,
          room: Math.floor(s.limits.workMb * 1048576 * 0.85) });
      }

      case "save-ls":
      case "save-get":
      case "save-rm":
      case "save-clear": {
        if (!(s.limits.saveBytes > 0) || s.owner.kind !== "user") throw new Error("you do not have a saved folder");
        const ref = String(m.ref || "").slice(0, 40);
        if (m.t === "save-ls") {
          return tell(s, { t: "save", ref: ref, files: saves.list(s.handle),
            usage: Object.assign(saves.measure(s.handle), { limitBytes: s.limits.saveBytes, limitFiles: s.limits.saveFiles }) });
        }
        /* A running program could be swapping a file for a link while
           this reads or deletes it. Not while anything runs, then. */
        if (count((j) => j.who === whoOf(s))) {
          throw new Error("stop your running programs first — they could be changing those files");
        }
        if (m.t === "save-get") {
          const data = saves.read(s.handle, m.path, SAVE_GET_MAX);
          tell(s, { t: "save-file", ref: ref, path: String(m.path), size: data.length });
          for (let at = 0; at < data.length || at === 0; at += SAVE_CHUNK) {
            const end = at + SAVE_CHUNK >= data.length;
            tell(s, { t: "save-chunk", ref: ref, d: data.subarray(at, at + SAVE_CHUNK).toString("base64"), end: end });
            if (end) break;
          }
          return;
        }
        if (m.t === "save-rm") saves.remove(s.handle, m.path);
        else saves.clear(s.handle);
        return tell(s, { t: "save", ref: ref, files: saves.list(s.handle),
          usage: Object.assign(saves.measure(s.handle), { limitBytes: s.limits.saveBytes, limitFiles: s.limits.saveFiles }) });
      }

      case "renew": {
        /* A fresh ticket from the relay, every ten minutes. It is how a
           ban or an approval made in MESSAGES reaches a session that is
           already open. */
        const v = state.key ? ticket.verify(state.key, m.ticket) : { ok: false };
        if (!v.ok || v.claims.handle !== s.handle || !spent.use(v.claims)) {
          throw new Error("that renewal ticket was not accepted");
        }
        if ((v.claims.tier === "guest") !== (s.tier === "guest")) {
          /* Guest to member or back: where their files live changes,
             so the session starts over. The panel reconnects by itself. */
          for (const j of jobs.values()) if (j.handle === s.handle) j.stop("your account changed to " + v.claims.tier);
          tell(s, { t: "reconnect", why: "your account changed to " + v.claims.tier });
          try { s.sock.close(4001, "tier changed"); } catch (e) {}
          return endSession(s, "tier changed");
        }
        s.tier = v.claims.tier;
        s.limits = L.tiers[s.tier];
        s.renewBy = Date.now() + RENEW_MS;
        return tell(s, { t: "renewed", tier: s.tier });
      }

      case "put": {
        if (s.upload) throw new Error("one upload at a time");
        const sha = String(m.sha256 || "").toLowerCase();
        if (admin.denied(sha)) throw new Error("that file has been blocked on this server by an admin");
        if (pressure() === "full" && s.tier !== "admin") {
          throw new Error("the server's disk is nearly full, so uploads are paused. Ask an admin.");
        }
        /* The same bytes already on your own list: nothing to send. */
        const have = s.owner.kind === "user" && store.list(s.owner).find((f) => f.sha256 === sha);
        if (have) {
          return tell(s, { t: "put-done", ref: String(m.ref || "").slice(0, 40), file: decorate(have),
            usage: store.usage(s.owner), deduped: true });
        }
        const h = store.begin(s.owner, m, s.limits);
        s.upload = { h: h, ref: String(m.ref || "").slice(0, 40), acked: 0 };
        return tell(s, { t: "put-ok", ref: s.upload.ref });
      }
      case "put-cancel":
        if (s.upload) { s.upload.h.abort(); s.upload = null; }
        return tell(s, { t: "put-cancelled" });

      case "rm": {
        if (count((j) => j.who === whoOf(s) && j.file === m.file)) throw new Error("that file is running — stop it first");
        const ok = store.remove(s.owner, m.file);
        return tell(s, { t: "removed", file: m.file, ok: ok, usage: store.usage(s.owner) });
      }

      case "run": {
        const ref = String(m.ref || "").slice(0, 40);
        const r = startJob(s, m);
        if (r.queued) return tell(s, { t: "job", ref: ref, queued: r.queued, why: r.why });
        return tell(s, { t: "job", ref: ref, job: r });
      }
      case "take": {
        /* START pressed: the room held for this place. */
        const ref = String(m.ref || "").slice(0, 40);
        const e = access.line.find((x) => x.id === String(m.id) && x.who === whoOf(s));
        if (!e) throw new Error("that place in the line has gone");
        if (!e.offered) throw new Error("it is not your turn yet");
        if (!countsOk(e.kind, s.tier)) {
          e.offered = null;
          throw new Error("an admin took that room a moment ago — you are still first in line");
        }
        access.leave(e.id);
        return tell(s, { t: "job", ref: ref, job: startJob(s, e.req, true) });
      }
      case "leave": {
        const e = access.line.find((x) => x.id === String(m.id) && x.who === whoOf(s));
        if (e) access.leave(e.id);
        setImmediate(() => tickAccess(false));
        return tell(s, { t: "line", ref: String(m.ref || "").slice(0, 40), entries: access.mine(whoOf(s)).map(placeOf) });
      }

      case "in": {
        const j = jobs.get(String(m.job));
        if (!mine(s, j)) return;
        const d = String(m.d == null ? "" : m.d);
        if (d.length > 64 * 1024) throw new Error("that is too much input at once");
        j.lastInput = Date.now();
        /* A screen's box takes JSON lines; fk-screen passes text on. */
        return j.ctl.write(j.screen ? JSON.stringify({ t: "in", d: d }) + "\n" : d);
      }
      case "eof": {
        const j = jobs.get(String(m.job));
        if (!mine(s, j)) return;
        if (j.screen) j.ctl.write('{"t":"eof"}\n'); else j.ctl.endInput();
        return;
      }
      case "ui": {
        /* Mouse and keys for a screen, batched by the panel. */
        const j = jobs.get(String(m.job));
        if (!mine(s, j) || !j.screen || !Array.isArray(m.e)) return;
        j.lastInput = Date.now();
        const lines = m.e.slice(0, UI_MAX).map((e) => cleanUi(e, j.screen)).filter(Boolean)
          .map((e) => JSON.stringify(e) + "\n").join("");
        if (lines) j.ctl.write(lines);
        return;
      }
      case "kill": {
        const j = jobs.get(String(m.job));
        /* Only your own. A job id is random, but "it is hard to
           guess" is not the rule; "it is yours" is. */
        if (mine(s, j)) j.stop("stopped");
        return;
      }
      default: return;
    }
  }

  function onBinary(s, chunk) {
    const u = s.upload;
    if (!u) throw new Error("bytes arrived with no upload open");
    const complete = u.h.write(chunk);
    if (complete) {
      s.upload = null;
      const entry = u.h.finish();
      log("INFO", `runnerd: ${s.handle} uploaded ${entry.name} (${entry.size} bytes)`);
      return tell(s, { t: "put-done", ref: u.ref, file: s.owner.kind === "guest" ? entry : decorate(entry),
        usage: store.usage(s.owner) });
    }
    /* An ack every megabyte: enough for a progress bar and for the
       sender to pace itself, without a message per chunk. */
    if (u.h.received() - u.acked >= 1024 * 1024) {
      u.acked = u.h.received();
      tell(s, { t: "put-ack", ref: u.ref, got: u.acked });
    }
  }

  /* ---- the socket ---- */
  function refuse(sock, code, text) {
    /* end(), not write() then destroy(): destroy can drop the reply
       before it leaves, and Cloudflare reports a dropped reply as 502. */
    try {
      sock.end("HTTP/1.1 " + code + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      setTimeout(() => sock.destroy(), 2000).unref();
    } catch (e) {}
  }

  function upgrade(req, sock) {
    sock.on("error", () => {});
    let url;
    try { url = new URL(req.url, "http://x"); } catch (e) { return refuse(sock, 400, "Bad Request"); }
    if (url.pathname.replace(/\/+$/, "") !== "/attach") return refuse(sock, 404, "Not Found");
    if (!state.key) return refuse(sock, 503, "Service Unavailable");

    const v = ticket.verify(state.key, url.searchParams.get("t"));
    if (!v.ok || !spent.use(v.claims)) return refuse(sock, 401, "Unauthorized");
    const c = v.claims;

    if (sessions.size >= L.machine.maxSessions ||
        (c.tier === "guest" && sessionCount((x) => x.tier === "guest") >= L.machine.maxGuestSessions)) {
      return refuse(sock, 503, "Service Unavailable");
    }

    /* A short heartbeat. A lost connection (Wi-Fi gone, lid shut) sends
       no goodbye, so the ping is the only thing that notices — and
       for a guest, noticing is what deletes their sandbox. */
    const socket = ws.accept(req, sock, { maxPayload: CHUNK_MAX + 1024, pingMs: 10000 });
    if (!socket) return;

    const sid = crypto.randomBytes(12).toString("hex");
    const s = { sid: sid, handle: c.handle, tier: c.tier, limits: L.tiers[c.tier], sock: socket,
      alive: true, upload: null, win: Date.now(), n: 0, since: Date.now(), renewBy: Date.now() + RENEW_MS,
      owner: c.tier === "guest" ? { kind: "guest", sid: sid, files: {} }
        : { kind: "user", handle: c.handle } };
    sessions.set(sid, s);
    log("INFO", `runnerd: ${s.handle} connected as ${s.tier}`);
    const banned = admin.state(s.handle).suspended;
    if (banned) {
      /* Told why, then closed: a refusal at the handshake would reach
         the panel as a bare failed connection. */
      setImmediate(() => kick(s.handle, "you are suspended from RUNNER until " + until(banned.until) + ": " + banned.reason));
    }

    socket.on("close", (code, why) => endSession(s, why || String(code)));
    socket.on("message", (data, binary) => {
      if (!s.alive) return;
      const now = Date.now();
      if (now - s.win > 1000) { s.win = now; s.n = 0; }
      if (!binary && ++s.n > MSGS_PER_SEC) return;
      let ref;
      try {
        if (binary) return onBinary(s, data);
        if (data.length > TEXT_MAX) throw new Error("that message is too large");
        let m;
        try { m = JSON.parse(data); } catch (e) { return; }
        if (!m || typeof m.t !== "string") return;
        ref = typeof m.ref === "string" ? m.ref.slice(0, 40) : undefined;
        onText(s, m);
      } catch (e) {
        if (binary && s.upload) { ref = s.upload.ref; s.upload.h.abort(); s.upload = null; }
        tell(s, { t: "error", why: e.message, ref: ref });
      }
    });
  }

  /* ---- http: one route, and it says very little ---- */
  const server = http.createServer((req, res) => {
    const p = String(req.url || "").split("?")[0].replace(/\/+$/, "") || "/";
    const head = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (req.method === "GET" && p === "/health") {
      let q = null;
      try { q = new URL(req.url, "http://x").searchParams.get("load"); } catch (e) {}
      if (q) takeReport(q);
      res.writeHead(200, head);
      return res.end(JSON.stringify(health()));
    }
    res.writeHead(404, head);
    res.end(JSON.stringify({ error: "no such route", routes: ["GET /health", "WS /attach?t=<ticket>"] }));
  });
  server.on("upgrade", upgrade);

  let keyTimer = null, renewTimer = null, sweepTimer = null, sweepFirst = null, powerTimer = null, accessTimer = null;

  async function listen() {
    const opened = store.open();
    state.driverCheck = driver.check();
    const sweptBoxes = driver.sweep();
    if (opened.swept || sweptBoxes) {
      log("INFO", `runnerd: cleaned up after a previous run — ${opened.swept} leftover folder(s), ${sweptBoxes} container(s)`);
    }
    await fetchKey();
    /* Retried until there is a key, and refreshed after that so a
       reinstalled relay (which makes a new key) is picked up without
       anybody having to come and restart this. */
    keyTimer = setInterval(() => { fetchKey(); }, 60 * 1000);
    keyTimer.unref();
    renewTimer = setInterval(() => { checkRenewals(); pruneResults(); }, 30 * 1000);
    renewTimer.unref();
    sweepFirst = setTimeout(runSweep, 60 * 1000);
    sweepFirst.unref();
    power.sample();
    powerTimer = setInterval(() => power.sample(), 60 * 1000);
    powerTimer.unref();
    access.sample();
    accessTimer = setInterval(() => tickAccess(), 2000);
    accessTimer.unref();
    sweepTimer = setInterval(runSweep, cfg.sweepHours * 3600000);
    sweepTimer.unref();

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
    const c = state.driverCheck;
    log("INFO", `runnerd: listening on ${cfg.host}:${server.address().port}`);
    if (c.egress === false) {
      log("WARN", "runnerd: the egress proxy container is not running — members' jobs will run offline");
    }
    log(c.ok ? "INFO" : "ERROR", "runnerd: sandbox — " + driver.name +
      (c.ok ? " " + c.version : " NOT WORKING: " + c.why) +
      (cfg.runtime ? ", runtime " + cfg.runtime + (c.runtime ? "" : " (NOT INSTALLED — jobs will fail)") : ""));
    Object.keys(c.images || {}).forEach((k) => {
      if (c.images[k] === false) log("ERROR", `runnerd: image for '${k}' (${cfg.images[k]}) is not built — those jobs will fail`);
    });
    if (driver.name === "process") log("WARN", "runnerd: DEV MODE. Files run as plain processes with NO sandbox.");
    if (!state.key) log("WARN", "runnerd: " + state.keyWhy + " — nobody can connect until it arrives");
    return server.address().port;
  }

  async function close() {
    [keyTimer, renewTimer, sweepTimer, powerTimer, accessTimer, useTimer].forEach((t) => t && clearInterval(t));
    if (sweepFirst) clearTimeout(sweepFirst);
    for (const s of Array.from(sessions.values())) {
      try { s.sock.close(1001, "the server is shutting down"); } catch (e) {}
      endSession(s, "shutdown");
    }
    await new Promise((r) => { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); });
  }

  return { server, listen, close, health, state, store, driver, limits: L,
    admin, saves, access, _internals: { sampleUse, driver, sessions, jobs, finished, setKey, fetchKey, runSweep, checkRenewals, RENEW_MS, tickAccess, setCpuOf: (f) => { cpuOf = f; } } };
}

if (require.main === module) {
  const file = process.env.FK_RUNNER_CONFIG || path.join(__dirname, "config.json");
  let cfg;
  try { cfg = loadConfig(fs.existsSync(file) ? file : null); }
  catch (e) { console.error("runnerd: " + file + " is not valid JSON — " + e.message); process.exit(1); }
  let app;
  try { app = create(cfg); } catch (e) { console.error("runnerd: " + e.message); process.exit(1); }
  app.listen().catch((e) => { console.error("runnerd: could not start — " + e.message); process.exit(1); });
  const bye = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

module.exports = { create, loadConfig, DEFAULTS, VERSION };
