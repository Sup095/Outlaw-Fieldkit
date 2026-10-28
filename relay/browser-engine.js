/* ============================================================
   FieldKit relay :: browser-engine — a real browser, server side

   §14.11. The replacement for fetch-and-rewrite.

   WHAT CHANGED AND WHY

   The old browser fetched a page, rewrote every URL in it, and
   served the result from the relay's own origin. That works for
   documents and falls apart on applications, and the failures were
   never fixable in kind — a router reads location.pathname, a
   bundle branches on its own hostname, a bot check wants a real
   browser to answer it. Every fix bought one site and cost another,
   and the last one (pathMode) traded a blank YouTube for a browser
   that dropped pages at random.

   So: run an actual Chromium here, and send the person PIXELS.

   A page that renders in this browser renders correctly, because it
   is a browser and not an impression of one. A bot check appears,
   and the person solves it, because there is a real human at the
   other end of a real browser and that is what those checks are
   for. Nothing is rewritten, so nothing can be rewritten wrong.

   WHAT IT COSTS, STATED UP FRONT

   - Memory. Chromium is ~150 MB plus 80-150 MB per active session.
     That is why sessions are per-account, capped, and evicted, and
     why Chromium itself stops when nobody has used it for a while
     (park, parkMinutes).
   - Audio does not travel. A screencast is video frames. Video
     plays and you will not hear it. Fixing that needs a real media
     pipeline and is a different project.
   - It is a picture. Copy, find and zoom are done by asking the real
     page (copyText, find, zoom below), not by anything the panel can
     see. So is the pointer's shape (cursorAt).

   TABS, DOWNLOADS, UPLOADS (RUNNER_PLAN.md §16)

   A session is a set of tabs, one of them on screen. A page that
   opens a window (a link with target=_blank, window.open) gets a tab
   and is switched to, as a browser does; before this it opened
   somewhere nobody was looking and the link seemed dead. A download
   lands in the session's own folder in the container, capped, and is
   handed to the panel by a single-use link; a page's "choose file"
   asks the panel, whose file comes back the same way. Both folders go
   with the session.

   ISOLATION IS THE POINT, NOT A FEATURE

   One BrowserContext per account. That is Chromium's own boundary:
   separate cookie jar, separate storage, separate cache, separate
   everything. Two people on this relay cannot see each other's
   sessions, and signing out is a context being destroyed rather
   than a best-effort clear.

   And the browser is INSIDE the relay's container now, which the
   old one never was. Everything it does goes through guard.js —
   see the note at the top of that file, because it is the whole
   reason the vault is still out of reach.
   ============================================================ */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { CDP, version } = require("./cdp");
const { Guard } = require("./guard");
const { Meter } = require("./proc-usage");
const { Pulse } = require("./pulse");
const { OggOpus } = require("./ogg-opus");
const { AdBlock } = require("./adblock");

const DEFAULTS = {
  enabled: false,
  chromium: "",                 /* path to the binary; "" means search */
  dnsFilter: "adult",
  maxSessions: 6,
  maxViewportWidth: 1920,
  maxViewportHeight: 1200,
  idleMinutes: 15,
  parkMinutes: 10,              /* no sessions this long: Chromium stops until next opened; 0 = never */
  quality: 62,
  videoQuality: 80,             /* the JPEG a video encoder starts from: higher, so it is not lost twice */
  everyNthFrame: 1,
  noSandbox: true,
  startTimeoutMs: 30000,
  maxTabs: 8,
  downloads: true,
  downloadMaxMB: 200,
  uploads: true,
  uploadMaxMB: 50,
  guestGraceSec: 60,            /* a guest's closed browser is ended after this (a dropped connection comes back) */
  keepSignInsHours: 12,         /* members' cookies across a park or an idle end; memory only; 0 = never */
  sound: true,                  /* sound, when the image has PulseAudio: a Chromium per session, each on its own sink */
  soundKbps: 48,                /* Opus, per session that someone is listening to */
  pulse: "",                    /* path to pulseaudio; "" means search */
  adblock: true,                /* ads and trackers refused by name (adblock.js) */
  adblockAllow: [],             /* hosts the ad blocker must never refuse */
  /* Where each Chromium keeps its profile, cache and shared memory.
     NOT /tmp: in the relay's container that is a 100 MB tmpfs, two
     idle Chromiums took 78 MB of it, and a game filled the rest.
     "" means $FK_BROWSER_TMP (the image sets it to the server's own
     disk), else the system temp folder. */
  profileRoot: "",
  diskCacheMB: 64,              /* per Chromium; thrown away with the session */
  rendererLimit: 6,             /* renderer processes per Chromium; tabs share past this */
  sessionMemMB: 1800,           /* one session past this is ended, with a reason, before it can take the others down */
  memHighPct: 90,               /* the container this full: the largest session is ended */
  freezeAfterSec: 120           /* nobody watching this long: its pages are frozen until someone is */
};
/* The container's memory: { used, max } in bytes, or null outside a
   limited container. "Used" leaves out file cache the kernel can drop. */
function containerMemory() {
  const rd = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch (e) { return null; } };
  let max = rd("/sys/fs/cgroup/memory.max"), cur = rd("/sys/fs/cgroup/memory.current"), stat = rd("/sys/fs/cgroup/memory.stat");
  let inactive = "inactive_file";
  if (max === null) {
    max = rd("/sys/fs/cgroup/memory/memory.limit_in_bytes"); cur = rd("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    stat = rd("/sys/fs/cgroup/memory/memory.stat"); inactive = "total_inactive_file";
  }
  const m = Number(max), c = Number(cur);
  if (!m || !c || !isFinite(m) || m > 1e15) return null;
  const im = stat && new RegExp("^" + inactive + " (\\d+)", "m").exec(stat);
  return { used: Math.max(0, c - (im ? Number(im[1]) : 0)), max: m };
}

/* Opus packets this small are silence. Not sent: a quiet page then
   costs nothing, and the panel's player starts afresh when sound
   comes back. */
const SILENT_BYTES = 12;
const DL_KEEP_MS = 15 * 60 * 1000;
/* Pointer shapes a page may ask for. Anything else (a picture of its
   own, say) shows as the ordinary arrow. */
const CURSORS = ["default", "pointer", "text", "move", "grab", "grabbing", "crosshair", "not-allowed",
  "wait", "progress", "help", "col-resize", "row-resize", "ew-resize", "ns-resize", "nesw-resize",
  "nwse-resize", "n-resize", "s-resize", "e-resize", "w-resize", "ne-resize", "nw-resize", "se-resize",
  "sw-resize", "zoom-in", "zoom-out", "copy", "cell", "context-menu", "all-scroll", "vertical-text", "none"];
const CURSOR_JS = "(function (x, y) {" +
  " var e = document.elementFromPoint(x, y); if (!e) return 'default';" +
  " var c = String(getComputedStyle(e).cursor || 'auto').split(',').pop().trim();" +
  " if (c && c !== 'auto') return c;" +
  " var t = e.tagName; if (t === 'INPUT' || t === 'TEXTAREA' || e.isContentEditable) return 'text';" +
  " return 'default'; })";

/* Where a container image is likely to have put it. Ordered by how
   likely the image was built on purpose for this. */
const LIKELY_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/lib/chromium/chromium",
  "/home/container/chromium/chrome",
  "/home/container/chrome-linux/chrome"
];

const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const COPY_MAX = 100000;
const COPY_JS = "(function () {" +
  " var a = document.activeElement;" +
  " if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && typeof a.selectionStart === 'number') {" +
  "   return a.type === 'password' ? '' : a.value.substring(a.selectionStart, a.selectionEnd).slice(0, " + COPY_MAX + ");" +
  " }" +
  " return String(window.getSelection()).slice(0, " + COPY_MAX + ");" +
  "})()";

function findChromium(configured) {
  const tried = [];
  const candidates = configured ? [configured, ...LIKELY_PATHS] : LIKELY_PATHS;
  for (const p of candidates) {
    tried.push(p);
    try { fs.accessSync(p, fs.constants.X_OK); return { path: p, tried }; }
    catch (e) { /* keep looking */ }
  }
  return { path: null, tried };
}

class Engine {
  constructor(opts) {
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.log = opts.log || (() => {});
    this.filter = opts.filter || (() => ({ ok: true }));

    this.proc = null;
    this.cdp = null;
    this.guard = null;
    this.ready = false;
    /* SOUND (RUNNER_PLAN.md §23). One Chromium cannot give each person
       their own sound: every page in it plays to the same card. So with
       sound on, each session gets a Chromium of its own (a "host") on a
       sink of its own (pulse.js), and one spare host is kept started
       so opening the browser is still quick. Without PulseAudio it is
       as before: one shared Chromium, a context per session, muted. */
    this.pulse = new Pulse({ bin: this.cfg.pulse || null, log: this.log });
    this.soundOn = false;
    this.hosts = new Set();
    this.main = null;                   /* the shared host, without sound */
    this.spare = null;
    this._sparing = null;
    /* Members' cookies kept while their session is ended for being
       idle or for Chromium parking: in memory only, never on disk,
       and gone with the relay process. key -> { cookies, at } */
    this.kept = new Map();
    this.filesDir = path.join(os.tmpdir(), "fk-browser-files-" + process.pid);
    this.startedAt = 0;
    this.lastFailure = null;
    this.sessions = new Map();          /* key -> session */
    this._starting = null;
    /* Whether there is a Chromium to start. Chromium itself starts on the
       first ticket, so "ready" is false on a relay nobody has used since
       it started; the panel decides by this instead. */
    this.binary = findChromium(this.cfg.chromium).path;

    this.lastUsed = Date.now();
    this._sweep = setInterval(() => this.evictIdle(), 60000);
    this._guard = setInterval(() => { this._watchdog().catch(() => {}); }, 5000);
    if (this._guard.unref) this._guard.unref();
    if (this._sweep.unref) this._sweep.unref();
  }

  /* ---- lifecycle ------------------------------------------------ */

  async start() {
    if (this.ready) { this._topUp(); return true; }
    /* Concurrent callers share one launch. Without this, two people
       opening the browser at the same moment start two Chromiums
       and the second one's debugging port collides. */
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    const found = findChromium(this.cfg.chromium);
    if (!found.path) {
      this.lastFailure = "no chromium binary found";
      this.log("WARN", "browser: no chromium found. Looked in: " + found.tried.join(", ") +
        ". Set browser.chromium in config.json, or run an image that has one.");
      return false;
    }
    this.chromiumPath = found.path;

    this.ads = new AdBlock({ enabled: this.cfg.adblock !== false, allow: this.cfg.adblockAllow });
    this.log("INFO", "browser: ad blocker " + (this.ads.on ? "on — " + this.ads.source : "off (browser.adblock is false)"));
    this.guard = new Guard({ log: this.log, dnsFilter: this.cfg.dnsFilter, filter: this.filter, ads: this.ads, ports: "browser" });
    this._sweepProfiles();
    this.guardPort = await this.guard.listen();

    this.soundOn = false;
    if (this.cfg.sound && this.pulse.available()) this.soundOn = await this.pulse.start();
    try {
      if (this.soundOn) {
        this.spare = await this._launch(true);
      } else {
        const h = await this._launch(false);
        this.main = h;
        this.proc = h.proc;
        this.cdp = h.cdp;
        this.profileDir = h.profile;
      }
    } catch (e) {
      this.lastFailure = e.message;
      return false;
    }

    this.ready = true;
    this.startedAt = Date.now();
    /* Started ahead of the panel (a warm-up), it gets the full park
       time to be used, not whatever was left since the last session. */
    this.lastUsed = Date.now();
    this.lastFailure = null;
    this.log("INFO", "browser: ready — " + (this.version || "chromium") +
      ", egress through the guard, " + this.guard.dnsName +
      (this.soundOn ? ", with sound (a Chromium per session)" : ", without sound"));
    return true;
  }

  /* One Chromium: a "host". Shared by every session when there is no
     sound; one per session, on its own sink, when there is. */
  async _launch(withSink) {
    const port = await freePort();
    const root = this._profileRoot();
    const profile = fs.mkdtempSync(path.join(root, "fk-browser-"));
    fs.mkdirSync(path.join(profile, "tmp"), { recursive: true });
    let sink = null;
    if (withSink) {
      try { sink = await this.pulse.sink(); }
      catch (e) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (x) {} throw new Error("no sound card for the browser: " + e.message); }
    }
    const guardPort = this.guardPort;

    const args = [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=" + port,
      "--user-data-dir=" + profile,

      /* EVERYTHING goes through the guard, loopback included. The
         bypass override is not a tuning knob — without it Chromium
         exempts localhost by default and the relay's own API is one
         fetch() away from any page. */
      "--proxy-server=http://127.0.0.1:" + guardPort,
      "--proxy-bypass-list=<-loopback>",

      /* /dev/shm is 64 MB in a default container and Chromium will
         happily try to put a compositor surface in it. */
      "--disable-dev-shm-usage",
      "--disable-gpu",

      /* Nothing that phones home on its own. Not evasion — this is
         a browser somebody else's relay is running on their behalf,
         and it should do what they asked and nothing else. */
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-breakpad",
      "--disable-domain-reliability",
      "--disable-client-side-phishing-detection",
      "--metrics-recording-only",
      "--no-pings",

      /* No keyring in a container; without these Chromium blocks on
         a DBus call that never answers. */
      "--password-store=basic",
      "--use-mock-keychain",

      "--window-size=1280,800",

      /* Lean (FIELDKIT_PROJECT.md §14.42). Each of these was a cost per
         session for something nobody here uses. Site isolation is the
         big one: it gives every cross-site frame its own process, which
         on an ad-heavy page meant dozens. Sessions are already apart,
         a Chromium each (with sound) or a browser context each, and
         the guard stands between all of them and anything private. */
      "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions," +
        "CertificateTransparencyComponentUpdater,IsolateOrigins,site-per-process,BackForwardCache,PrivacySandboxSettings4",
      "--disable-site-isolation-trials",
      "--renderer-process-limit=" + Math.max(1, this.cfg.rendererLimit | 0 || 6),
      "--disable-extensions",
      "--disable-component-update",
      "--disable-default-apps",
      "--disk-cache-dir=" + path.join(profile, "cache"),
      "--disk-cache-size=" + Math.max(1, this.cfg.diskCacheMB | 0 || 64) * 1048576
    ];
    /* Its own sink, or no sound at all. */
    if (!sink) args.push("--mute-audio");

    /* The container IS the boundary here, and that is the honest
       framing. Chromium's own sandbox needs user namespaces that a
       Pterodactyl container does not grant, so it cannot be left
       on; what protects the relay is the guard proxy and the fact
       that the vault is encrypted with a key this process never
       holds. Said out loud in the log because somebody should be
       able to find out without reading this file. */
    if (this.cfg.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");

    this.log("INFO", "browser: starting " + this.chromiumPath + (sink ? " on " + sink.name : ""));
    /* Chromium's home is its own throwaway profile, not the relay's.

       The crash handler insists on a database directory and looks for
       one under $HOME. Where the server's home cannot be written —
       a read-only mount, or a panel that runs the container as a uid
       the directory does not belong to — it exits, and Chromium goes
       down with it on SIGTRAP before the debugging port ever opens.
       Found by running the relay inside its own image.

       It is also simply the right place: nothing a browser leaves
       behind should land beside the vault's data, and this directory
       is deleted when the engine stops. */
    args.push("--crash-dumps-dir=" + path.join(profile, "crashes"));
    const env = Object.assign({}, process.env, {
      HOME: profile,
      XDG_CONFIG_HOME: path.join(profile, "config"),
      XDG_CACHE_HOME: path.join(profile, "cache"),
      /* Shared memory (--disable-dev-shm-usage) and anything else temporary: on the profile's disk too. */
      TMPDIR: path.join(profile, "tmp")
    }, sink ? Object.assign(this.pulse.env(), { PULSE_SINK: sink.name }) : {});
    const proc = spawn(this.chromiumPath, args, { stdio: ["ignore", "pipe", "pipe"], env: env });
    const host = { proc: proc, cdp: null, profile: profile, sink: sink, shared: !withSink, meter: new Meter() };
    this.hosts.add(host);

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    /* A Chromium that was stopped on purpose (park, stop, a session
       ending) has already been let go, and one exiting late must not
       tear down its replacement: _hostExited checks. */
    proc.on("exit", (code, sig) => this._hostExited(host, String(sig || code)));
    proc.on("error", (e) => {
      this.lastFailure = e.message;
      this.log("WARN", "browser: could not run chromium — " + e.message);
    });

    const deadline = Date.now() + this.cfg.startTimeoutMs;
    const fail = (why, words) => {
      this.lastFailure = why;
      this.log("WARN", "browser: " + words + " " + (stderr.trim().split("\n").slice(-4).join(" | ") || "(nothing)"));
      this._dropHost(host);
      return new Error(why);
    };
    for (;;) {
      if (proc.exitCode !== null || host.gone) throw fail("chromium exited during startup", "chromium died on startup. Its last words:");
      try { await version(port); break; }
      catch (e) {
        if (Date.now() > deadline) throw fail("chromium did not open its debugging port", "chromium started but never opened its debugging port.");
        await sleep(200);
      }
    }

    const cdp = await CDP.open(port);
    host.cdp = cdp;
    cdp.on("disconnected", () => this._hostExited(host, "its debugging connection closed"));
    /* Every page Chromium opens, so a pop-up becomes a tab, and every
       title and address change, which is what the tab strip shows. */
    cdp.on("Target.targetCreated", (p) => { this._adopt(p.targetInfo, cdp).catch(() => {}); });
    cdp.on("Target.targetDestroyed", (p) => { this._tabGone(p.targetId).catch(() => {}); });
    cdp.on("Target.targetInfoChanged", (p) => this._tabInfo(p.targetInfo));
    cdp.on("Browser.downloadWillBegin", (p) => this._dlBegin(p));
    cdp.on("Browser.downloadProgress", (p) => this._dlProgress(p));
    await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});

    /* Refused unless a session says otherwise: each one that may
       download gets its own folder (sessionFor), so nothing lands
       anywhere shared, and a site gets a clean answer instead of a
       stall. */
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    this.version = cdp.info.Browser || this.version;
    return host;
  }

  _profileRoot() {
    const want = this.cfg.profileRoot || process.env.FK_BROWSER_TMP || "";
    if (want) {
      try { fs.mkdirSync(want, { recursive: true }); fs.accessSync(want, fs.constants.W_OK); return want; }
      catch (e) { if (!this._rootWarned) { this._rootWarned = true; this.log("WARN", "browser: cannot use " + want + " for profiles (" + e.message + "); using " + os.tmpdir()); } }
    }
    return os.tmpdir();
  }

  /* Profiles left by a Chromium that died with the process (a crash,
     a kill): nothing else would ever delete them. */
  _sweepProfiles() {
    const root = this._profileRoot();
    const live = new Set([...this.hosts].map((h) => h.profile));
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return; }
    for (const n of names) {
      const p = path.join(root, n);
      if (!/^fk-browser-[A-Za-z0-9]{6}$/.test(n) || live.has(p)) continue;
      try { if (Date.now() - fs.statSync(p).mtimeMs > 60000) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
    }
  }

  /* A Chromium stopped. On purpose (dropped first): nothing to do. The
     shared one: everything stops, as it always has. A session's: that
     session ends. The spare: there is no spare. */
  _hostExited(host, why) {
    if (host.gone) return;
    host.gone = true;
    if (host === this.main) {
      this.log("WARN", "browser: chromium exited (" + why + ")");
      this.proc = null;
      this._teardown();
      return;
    }
    if (host === this.spare) this.spare = null;
    const s = [...this.sessions.values()].find((x) => x.host === host);
    this._dropHost(host);
    if (s) {
      this.log("WARN", "browser: " + s.who + "'s chromium exited (" + why + ")");
      this.destroy(s.key, "the browser for this session stopped").catch(() => {});
    }
  }

  _dropHost(host) {
    if (!host || host.dropped) return;
    host.dropped = host.gone = true;
    this.hosts.delete(host);
    if (host.cdp) { try { host.cdp.close(); } catch (e) {} }
    const p = host.proc;
    if (p && p.exitCode === null) {
      try { p.kill("SIGTERM"); } catch (e) {}
      const t = setTimeout(() => { try { if (p.exitCode === null) p.kill("SIGKILL"); } catch (e) {} }, 3000);
      if (t.unref) t.unref();
    }
    /* The profile is Chromium's, so it goes once Chromium has. */
    const gone = () => { try { fs.rmSync(host.profile, { recursive: true, force: true }); } catch (e) {} };
    if (p && p.exitCode === null) p.once("exit", gone); else gone();
    if (host.sink) this.pulse.drop(host.sink).catch(() => {});
  }

  /* With sound, one Chromium is kept started and waiting, so the next
     person to open the browser does not wait for one. Started when the
     browser is asked for (a ticket, a warm-up) and not already there. */
  _topUp() {
    if (!this.ready || !this.soundOn || this.spare || this._sparing) return;
    if (this.sessions.size >= this.cfg.maxSessions) return;
    this._sparing = this._launch(true).then((h) => {
      if (!this.ready || this.spare) return this._dropHost(h);
      this.spare = h;
    }, (e) => {
      this.log("WARN", "browser: could not start a spare chromium — " + e.message);
    }).finally(() => { this._sparing = null; });
  }

  _teardown() {
    this.ready = false;
    for (const s of this.sessions.values()) {
      this._audioStop(s);
      for (const v of s.viewers) { try { v.onGone("the browser restarted"); } catch (e) {} }
      s.viewers.clear();
    }
    this.sessions.clear();
    for (const h of [...this.hosts]) this._dropHost(h);
    this.main = null;
    this.spare = null;
    this.proc = null;
    this.cdp = null;
    this.profileDir = null;
    if (this.guard) { try { this.guard.close(); } catch (e) {} this.guard = null; }
    this.pulse.stop();
    this.soundOn = false;
    try { fs.rmSync(this.filesDir, { recursive: true, force: true }); } catch (e) {}
  }

  stop() {
    clearInterval(this._sweep);
    clearInterval(this._guard);
    this._teardown();
  }

  /* What the browser costs (RUNNER_PLAN.md §17): Chromium with all its
     processes, and each session. For admins only (browser-route.js). */
  usage() {
    const now = Date.now();
    const read = new Map();
    for (const h of this.hosts) read.set(h, h.proc && h.proc.pid ? h.meter.read(h.proc.pid) : null);
    const all = [...read.values()].filter(Boolean);
    const chromium = all.length ? {
      cpu: all.some((r) => r.cpu === null) ? null : Math.round(all.reduce((n, r) => n + r.cpu, 0) * 100) / 100,
      memMb: all.reduce((n, r) => n + r.memMb, 0), procs: all.reduce((n, r) => n + r.procs, 0),
      instances: all.length, sound: this.soundOn } : null;
    return {
      chromium: chromium,
      sessions: Array.from(this.sessions.values()).map((s) => {
        const r = s.host ? read.get(s.host) : null;
        return { who: String(s.who), tier: s.tier, tabs: (s.tabs || []).length, viewers: s.viewers.size,
          idleSec: Math.round((now - (s.lastSeen || now)) / 1000),
          cpu: r ? r.cpu : null, memMb: r ? r.memMb : null, sound: !!s.audio };
      })
    };
  }

  status() {
    return {
      enabled: !!this.cfg.enabled,
      ready: this.ready,
      available: !!this.cfg.enabled && !!this.binary,
      sound: this.soundOn,
      chromium: this.ready ? this.version || null : null,
      sessions: this.sessions.size,
      maxSessions: this.cfg.maxSessions,
      dnsFilter: this.guard ? this.guard.dnsName : null,
      video: !!this.videoBin,
      egress: this.guard ? this.guard.stats : null,
      lastFailure: this.lastFailure,
      upSince: this.startedAt || null
    };
  }

  /* ---- sessions -------------------------------------------------

     Keyed by ACCOUNT, not by tab or by connection. Closing the
     panel and opening it again lands you back on the page you were
     on, which is what a browser does; and the two people on this
     relay get two contexts that share nothing. */

  /* Could a new session start without waiting? (One that nobody is
     looking at can always be evicted to make room.) */
  hasRoom() {
    if (this.sessions.size < this.cfg.maxSessions) return true;
    for (const s of this.sessions.values()) if (!s.viewers.size) return true;
    return false;
  }

  async sessionFor(who, opts) {
    if (!this.ready) {
      const ok = await this.start();
      if (!ok) throw new Error(this.lastFailure || "the browser is not available");
    }
    this.lastUsed = Date.now();
    const key = String(who);
    const existing = this.sessions.get(key);
    if (existing) { existing.lastSeen = Date.now(); return existing; }

    if (this.sessions.size >= this.cfg.maxSessions) {
      /* Evict the coldest rather than refusing. Refusing means the
         newest person is the one who cannot browse, which is the
         wrong way round — the idle session's owner is not looking. */
      const cold = [...this.sessions.values()]
        .filter((s) => s.viewers.size === 0)
        .sort((a, b) => a.lastSeen - b.lastSeen)[0];
      /* An admin is never refused: past the cap by one at a time. */
      if (!cold && !(opts && opts.over)) throw new Error("every browser session is in use — try again in a minute");
      if (cold) await this.destroy(cold.key, "made room for another session");
    }

    /* With sound, the spare Chromium becomes this session's (or one is
       started), and another spare is started for whoever is next. */
    let host = null;
    if (this.soundOn) {
      if (!this.spare && this._sparing) await this._sparing.catch(() => {});
      host = this.spare;
      this.spare = null;
      if (!host || host.gone) host = await this._launch(true);
    }
    const cdp = host ? host.cdp : this.cdp;
    let browserContextId;
    try {
      ({ browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: false }));
    } catch (e) {
      if (host) this._dropHost(host);
      throw e;
    }
    const tier = (opts && opts.tier) || "admin";
    const s = {
      key, who, tier, browserContextId, page: null, active: null, tabs: [], creating: new Set(),
      host: host, cdp: cdp, audio: null, audioFails: 0,
      viewers: new Set(),
      casting: false,
      width: 1280, height: 800, scale: 1, zoom: 1, world: null,
      url: "about:blank", title: "",
      lastSeen: Date.now(), createdAt: Date.now(),
      pendingDialog: null,
      /* Its own folder for what it downloads and what is uploaded to it. */
      dir: path.join(this.filesDir, crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)),
      downloads: new Map(), chooser: null, uploads: [], cursor: "default", cursorAt: 0
    };
    this.sessions.set(key, s);
    if (host) this._topUp();

    if (this.cfg.downloads) {
      try { fs.mkdirSync(path.join(s.dir, "dl"), { recursive: true }); } catch (e) {}
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", browserContextId,
        downloadPath: path.join(s.dir, "dl"), eventsEnabled: true }).catch(() => {});
    }
    /* A member's sign-ins, from a session that ended while they were away. */
    const kept = this.kept.get(key);
    this.kept.delete(key);
    if (kept && tier !== "guest" && Date.now() - kept.at < this.cfg.keepSignInsHours * 3600000 && kept.cookies.length) {
      await cdp.send("Storage.setCookies", { cookies: kept.cookies, browserContextId }).catch(() => {});
      this.log("INFO", "browser: " + who + "'s sign-ins put back (" + kept.cookies.length + " cookies)");
    }

    const tab = await this._newTab(s);
    this._show(s, tab);
    this.log("INFO", "browser: session for " + who + " (" + this.sessions.size + " open)");
    return s;
  }

  /* ---- tabs ------------------------------------------------------ */

  /* A blank tab of our own making. Chromium can announce it before it
     answers, so every tab still being made is in s.creating BEFORE it
     is asked for, and a new page waits for them all before deciding
     it is a pop-up: this one is never adopted twice. */
  async _newTab(s) {
    let done;
    const gate = new Promise((r) => { done = r; });
    s.creating.add(gate);
    try {
      const { targetId } = await s.cdp.send("Target.createTarget", {
        url: "about:blank", browserContextId: s.browserContextId
      });
      return await this._attachTab(s, targetId, null);
    } finally {
      s.creating.delete(gate);
      done();
    }
  }

  async _attachTab(s, targetId, info) {
    const { sessionId } = await s.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = { id: targetId, page: s.cdp.session(sessionId),
      url: (info && info.url) || "about:blank", title: (info && info.title) || "", dialog: null };
    s.tabs.push(tab);
    this._wirePage(s, tab);
    await tab.page.send("Page.enable");
    await tab.page.send("Runtime.enable").catch(() => {});
    await this._metricsFor(s, tab.page);
    /* Touch off: this is a desktop viewport and a site that thinks
       it is on a phone lays out for one. */
    await tab.page.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    if (this.cfg.uploads) await tab.page.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
    return tab;
  }

  /* Make a tab the one on screen, without the stream (switchTab does that). */
  _show(s, tab) {
    s.active = tab;
    s.page = tab.page;
    s.world = null;
    s.url = tab.url;
    s.title = tab.title;
    s.pendingDialog = tab.dialog;
  }

  /* A page Chromium opened: a pop-up, or a link meant for a new
     window. Only pages, only in a context that is someone's session,
     and only once whatever tab we were making ourselves is made. */
  async _adopt(info, cdp) {
    if (!info || info.type !== "page") return;
    const s = [...this.sessions.values()].find((x) => x.browserContextId === info.browserContextId && (!cdp || x.cdp === cdp));
    if (!s) return;
    while (s.creating.size) await Promise.all([...s.creating]);
    if (s.tabs.some((t) => t.id === info.targetId)) return;
    if (s.tabs.length >= this.cfg.maxTabs) {
      await s.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
      this._push(s, { t: "note", why: "a page tried to open another tab, but " + this.cfg.maxTabs + " is the most a session can have" });
      return;
    }
    const tab = await this._attachTab(s, info.targetId, info);
    await this.switchTab(s, tab.id);
    this.log("INFO", "browser: " + s.who + " has a new tab (" + s.tabs.length + ")");
  }

  _tabInfo(info) {
    if (!info || info.type !== "page") return;
    for (const s of this.sessions.values()) {
      const tab = s.tabs.find((t) => t.id === info.targetId);
      if (!tab) continue;
      const changed = tab.title !== (info.title || "") || tab.url !== (info.url || tab.url);
      tab.title = info.title || "";
      if (info.url) tab.url = info.url;
      if (tab === s.active) s.title = tab.title;
      if (changed) this._pushTabs(s);
      return;
    }
  }

  async _tabGone(targetId) {
    for (const s of this.sessions.values()) {
      const i = s.tabs.findIndex((t) => t.id === targetId);
      if (i < 0) continue;
      const was = s.tabs[i];
      s.tabs.splice(i, 1);
      if (was === s.active) {
        const next = s.tabs[Math.min(i, s.tabs.length - 1)] || await this._newTab(s);
        s.active = null;
        await this.switchTab(s, next.id);
      } else this._pushTabs(s);
      return;
    }
  }

  async switchTab(s, id) {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab || tab === s.active) return false;
    if (s.casting && s.page) await s.page.send("Page.stopScreencast").catch(() => {});
    s.casting = false;
    this._show(s, tab);
    s.lastSeen = Date.now();
    await this._life(s);
    await tab.page.send("Page.bringToFront").catch(() => {});
    if (s.zoom !== 1) this._applyZoom(s);
    if (this._watching(s)) await this._startCast(s);
    this._push(s, { t: "nav", url: s.url });
    if (s.pendingDialog) this._push(s, { t: "dialog", dialog: s.pendingDialog });
    this._pushTabs(s);
    this._pushHistory(s);
    return true;
  }

  async openTab(s, url) {
    if (s.tabs.length >= this.cfg.maxTabs) throw new Error(this.cfg.maxTabs + " tabs is the most a session can have");
    const tab = await this._newTab(s);
    await this.switchTab(s, tab.id);
    if (url) await this.navigate(s, url);
    return tab;
  }

  async closeTab(s, id) {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return false;
    await s.cdp.send("Target.closeTarget", { targetId: id }).catch(() => {});
    /* Not waiting for Chromium to say so: the strip should change now. */
    await this._tabGone(id);
    return true;
  }

  _push(s, msg) {
    for (const v of s.viewers) { try { v.onEvent(msg); } catch (e) {} }
  }

  _pushTabs(s) {
    this._push(s, { t: "tabs", active: s.active ? s.active.id : null,
      tabs: s.tabs.map((t) => ({ id: t.id, title: String(t.title || "").slice(0, 120), url: String(t.url || "").slice(0, 500) })) });
  }

  _wirePage(s, tab) {
    const on = () => s.active === tab;
    const push = (msg) => { if (on()) this._push(s, msg); };

    tab.page.on("Page.frameNavigated", (p) => {
      if (p.frame && !p.frame.parentId) {
        tab.url = p.frame.url || tab.url;
        if (!on()) return;
        s.world = null;
        s.url = tab.url;
        push({ t: "nav", url: s.url });
      }
    });
    tab.page.on("Page.domContentEventFired", () => { if (on() && s.zoom !== 1) this._applyZoom(s); });
    /* A page's "choose file": the panel is asked, and its file comes
       back through takeUpload and setFiles. */
    tab.page.on("Page.fileChooserOpened", (p) => {
      if (!on() || !p.backendNodeId) return;
      s.chooser = { tab, node: p.backendNodeId, multiple: p.mode === "selectMultiple", at: Date.now() };
      push({ t: "choose-file", multiple: s.chooser.multiple });
    });
    /* Chromium's own error page. Nothing loaded, so the person is
       looking at a wall of capitals about a tunnel, and the actual
       answer — the filter refused it — is sitting in the guard. */
    tab.page.on("Page.frameNavigated", (p) => {
      if (p.frame && !p.frame.parentId && /^chrome-error:/.test(String(p.frame.url || ""))) {
        const r = this.guard && this.guard.whyRefused();
        push({ t: "blocked",
          url: s.pendingNav || p.frame.unreachableUrl || "",
          host: r ? r.host : "",
          kind: r ? r.kind : "unreachable",
          why: r ? r.why : "that site could not be reached" });
      }
    });

    tab.page.on("Page.loadEventFired", async () => {
      try {
        const r = await tab.page.send("Runtime.evaluate",
          { expression: "document.title", returnByValue: true });
        tab.title = (r.result && r.result.value) || "";
      } catch (e) {}
      if (!on()) return this._pushTabs(s);
      s.title = tab.title;
      push({ t: "loaded", url: s.url, title: s.title });
      this._pushTabs(s);
      this._pushHistory(s);
    });

    /* A dialog blocks the page until it is answered. Unanswered,
       the tab looks frozen and there is nothing on screen to say
       why — the screencast keeps sending the same frame. */
    /* A tab that is not on screen keeps its dialog until it is. */
    tab.page.on("Page.javascriptDialogOpening", (p) => {
      tab.dialog = { type: p.type, message: p.message, prompt: p.defaultPrompt || "" };
      if (!on()) return;
      s.pendingDialog = tab.dialog;
      push({ t: "dialog", dialog: s.pendingDialog });
      if (!s.viewers.size) this.answerDialog(s, false, "");
    });

    tab.page.on("Page.screencastFrame", async (p) => {
      /* Ack first, always. Chromium sends at most one unacked frame
         and stops until it is acknowledged, so a throw between the
         frame and the ack freezes the stream permanently. */
      try { await tab.page.send("Page.screencastFrameAck", { sessionId: p.sessionId }); }
      catch (e) {}
      if (!on()) return;
      for (const v of s.viewers) { if (!v.paused) { try { v.onFrame(p.data, p.metadata); } catch (e) {} } }
    });
  }

  /* ---- downloads ---------------------------------------------------
     Into the session's own folder, named by Chromium's id for it.
     Over downloadMaxMB is cancelled. Kept 15 minutes, for the panel
     to fetch through a single-use link (browser-route.js). */
  _dlSession(p) {
    for (const s of this.sessions.values()) {
      if (s.downloads.has(p.guid)) return s;
      if (p.frameId && s.tabs.some((t) => t.id === p.frameId)) return s;
    }
    /* A download started from a frame inside the page: whichever
       session's folder Chromium is writing it into. */
    for (const s of this.sessions.values()) {
      try { if (fs.existsSync(path.join(s.dir, "dl", p.guid))) return s; } catch (e) {}
    }
    return null;
  }

  _dlBegin(p) {
    const s = this._dlSession(p);
    if (!s) return;
    const name = cleanName(p.suggestedFilename) || "download";
    s.downloads.set(p.guid, { id: p.guid, name, url: String(p.url || "").slice(0, 500), state: "inProgress",
      got: 0, total: 0, at: Date.now(), told: 0, path: path.join(s.dir, "dl", p.guid) });
    this._push(s, { t: "download", id: p.guid, name, state: "inProgress", got: 0, total: 0 });
    this.log("INFO", "browser: " + s.who + " is downloading " + name);
  }

  /* The most one download may be: downloadMaxMB, or less when the
     temporary folder is smaller. On the Pterodactyl relay /tmp is a
     100 MB tmpfs, so a 200 MB download used to fill it and fail half
     way. Counted as what is free now plus what this download already
     holds, less 30 MB for Chromium's own files. */
  downloadRoom(d) {
    let room = this.cfg.downloadMaxMB * 1048576;
    try {
      const st = fs.statfsSync(path.dirname(this.filesDir));
      const free = Number(st.bavail) * Number(st.bsize) + ((d && d.got) || 0) - 30 * 1048576;
      room = Math.max(1048576, Math.min(room, free));
    } catch (e) { /* no statfs: the setting alone */ }
    return room;
  }

  _dlProgress(p) {
    const s = this._dlSession(p);
    const d = s && s.downloads.get(p.guid);
    if (!d) return;
    d.got = p.receivedBytes || 0;
    d.total = p.totalBytes || 0;
    const max = this.downloadRoom(d);
    if (p.state === "inProgress" && (d.got > max || d.total > max)) {
      s.cdp.send("Browser.cancelDownload", { guid: p.guid, browserContextId: s.browserContextId }).catch(() => {});
      d.state = "canceled";
      d.why = "over " + Math.floor(max / 1048576) + " MB, the most the browser can hold" +
        (max < this.cfg.downloadMaxMB * 1048576 ? " right now (its temporary space is small)" : "");
      try { fs.rmSync(d.path, { force: true }); } catch (e) {}
      return this._push(s, { t: "download", id: d.id, name: d.name, state: "canceled", why: d.why });
    }
    if (d.state === "canceled") return;
    d.state = p.state;
    const now = Date.now();
    if (p.state === "inProgress" && now - d.told < 500) return;
    d.told = now;
    if (p.state === "completed") { d.size = d.got; d.at = now; }
    this._push(s, { t: "download", id: d.id, name: d.name, state: d.state, got: d.got, total: d.total,
      why: p.state === "canceled" ? "the download stopped" : undefined });
  }

  /* A finished download, for the route to stream. */
  download(s, id) {
    const d = s.downloads.get(String(id));
    if (!d || d.state !== "completed") return null;
    try { const st = fs.statSync(d.path); return { name: d.name, size: st.size, path: d.path }; }
    catch (e) { return null; }
  }

  /* ---- uploads -----------------------------------------------------
     A file the panel sent for a "choose file": saved under its own
     name (the page sees that name) in a folder of its own. */
  takeUpload(s, name, buf) {
    if (!s.chooser) throw new Error("no page is asking for a file");
    if (s.uploads.length >= 20) throw new Error("too many files at once");
    const dir = path.join(s.dir, "up", crypto.randomBytes(8).toString("hex"));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, cleanName(name) || "file");
    fs.writeFileSync(file, buf);
    const id = crypto.randomBytes(12).toString("hex");
    s.uploads.push({ id, file, at: Date.now() });
    return id;
  }

  async setFiles(s, ids) {
    const c = s.chooser;
    if (!c) throw new Error("no page is asking for a file");
    s.chooser = null;
    const files = (Array.isArray(ids) ? ids : []).map((id) => (s.uploads.find((u) => u.id === id) || {}).file).filter(Boolean);
    if (!files.length) return 0;
    await c.tab.page.send("DOM.setFileInputFiles", { files: c.multiple ? files : files.slice(0, 1), backendNodeId: c.node });
    return files.length;
  }

  /* ---- the pointer's shape -----------------------------------------
     Asked of the real page, at most every 150 ms while the mouse
     moves: the panel only has a picture, so without this the arrow
     never turns into a hand over a link. */
  async cursorAt(s, x, y) {
    const now = Date.now();
    if (now - s.cursorAt < 150) return null;
    s.cursorAt = now;
    const z = s.zoom || 1;
    const v = await this._evaluate(s, CURSOR_JS + "(" + Math.round(x / z) + "," + Math.round(y / z) + ")").catch(() => null);
    const c = CURSORS.indexOf(v) >= 0 ? v : "default";
    if (c === s.cursor) return null;
    s.cursor = c;
    return c;
  }

  async _pushHistory(s) {
    try {
      const h = await s.page.send("Page.getNavigationHistory");
      const msg = { t: "history",
        canBack: h.currentIndex > 0,
        canFwd: h.currentIndex < h.entries.length - 1 };
      for (const v of s.viewers) { try { v.onEvent(msg); } catch (e) {} }
    } catch (e) {}
  }

  /* ---- viewers and the stream ----------------------------------- */

  async attach(s, viewer) {
    s.viewers.add(viewer);
    s.lastSeen = Date.now();
    /* Started again even if it was running: a fresh cast sends the
       current picture at once, which is what a new viewer (and a new
       video encoder) needs, rather than nothing until the page moves. */
    if (s.casting) await s.page.send("Page.stopScreencast").catch(() => {});
    await this._startCast(s);
    viewer.onEvent({ t: "nav", url: s.url });
    if (s.pendingDialog) viewer.onEvent({ t: "dialog", dialog: s.pendingDialog });
    this._pushTabs(s);
    this._pushHistory(s);
    if (s.dropTimer) { clearTimeout(s.dropTimer); s.dropTimer = null; }
    this._audioCheck(s);
    await this._life(s);
  }

  async detach(s, viewer) {
    s.viewers.delete(viewer);
    s.lastSeen = Date.now();
    this._audioCheck(s);
    /* A guest's browser is a throwaway (RUNNER_PLAN.md §16): closed,
       it is gone, after a minute's grace for a dropped connection. */
    if (s.tier === "guest" && !s.viewers.size && !s.dropTimer) {
      s.dropTimer = setTimeout(() => {
        s.dropTimer = null;
        if (!s.viewers.size && this.sessions.get(s.key) === s) this.destroy(s.key, "a guest's browser ends when it is closed").catch(() => {});
      }, this.cfg.guestGraceSec * 1000);
      if (s.dropTimer.unref) s.dropTimer.unref();
    }
    /* Nobody is looking, so stop encoding. This is most of what
       keeps an idle session cheap. */
    if (!this._watching(s) && s.casting) {
      s.casting = false;
      await s.page.send("Page.stopScreencast").catch(() => {});
    }
  }

  /* A panel that is minimised or on a hidden tab stays attached but
     is sent nothing, and when no panel is looking the screencast
     stops: no encoding, no upload. Shown again, it gets the current
     picture at once. */
  async pause(s, viewer, paused) {
    viewer.paused = !!paused;
    if (!s.viewers.has(viewer)) return;
    this._audioCheck(s);
    if (this._watching(s)) {
      if (!paused) {
        if (s.casting) await s.page.send("Page.stopScreencast").catch(() => {});
        await this._startCast(s);
      }
    } else if (s.casting) {
      s.casting = false;
      await s.page.send("Page.stopScreencast").catch(() => {});
    }
  }

  /* ---- sound -------------------------------------------------------
     Encoded only while someone is listening: a panel that asked for
     sound, is not hidden, and is on a session with a sink. One encoder
     per session, shared by its panels, like the screencast. */
  setSound(s, viewer, on) {
    viewer.sound = !!on;
    this._audioCheck(s);
    return viewer.sound && this.soundOn && !!s.host;
  }

  _audioCheck(s) {
    let want = !!(this.soundOn && s.host && s.host.sink && this.videoBin && this.sessions.get(s.key) === s);
    if (want) { want = false; for (const v of s.viewers) if (v.sound && !v.paused) { want = true; break; } }
    if (want && !s.audio) this._audioStart(s);
    else if (!want && s.audio) this._audioStop(s);
  }

  _audioStart(s) {
    const bin = Array.isArray(this.videoBin) ? this.videoBin : [this.videoBin];
    const args = ["-nostdin", "-loglevel", "error",
      "-f", "pulse", "-fragment_size", "3840", "-i", s.host.sink.name + ".monitor",
      "-c:a", "libopus", "-b:a", Math.max(16, Math.min(128, this.cfg.soundKbps | 0)) + "k",
      "-application", "lowdelay", "-frame_duration", "20", "-ar", "48000", "-ac", "2",
      "-page_duration", "20000", "-flush_packets", "1", "-f", "ogg", "-"];
    let proc;
    try {
      proc = spawn(bin[0], bin.slice(1).concat(args), { stdio: ["ignore", "pipe", "pipe"],
        env: Object.assign({}, process.env, this.pulse.env()) });
    } catch (e) { return; }
    const a = { proc: proc, at: Date.now(), packets: 0 };
    s.audio = a;
    const ogg = new OggOpus((pkt) => {
      if (pkt.length <= SILENT_BYTES) return;
      a.packets++;
      for (const v of s.viewers) {
        if (v.sound && !v.paused && v.onAudio) { try { v.onAudio(pkt); } catch (e) {} }
      }
    });
    proc.stdout.on("data", (d) => ogg.push(d));
    let said = "";
    proc.stderr.on("data", (d) => { said = (said + d).slice(-1000); });
    proc.on("error", () => {});
    proc.on("exit", (code) => {
      if (s.audio !== a) return;
      s.audio = null;
      this.log("WARN", "browser: sound for " + s.who + " stopped (" + code + ") " + said.trim().split("\n").pop());
      /* Tried again, a few times: a hiccup should not mean silence for the rest of the session. */
      if (++s.audioFails <= 3) {
        const t = setTimeout(() => this._audioCheck(s), 2000);
        if (t.unref) t.unref();
      }
    });
  }

  _audioStop(s) {
    const a = s.audio;
    s.audio = null;
    if (a) { try { a.proc.kill("SIGTERM"); } catch (e) {} }
  }

  _watching(s) {
    for (const v of s.viewers) if (!v.paused) return true;
    return false;
  }

  /* FREEZING (RUNNER_PLAN.md §17, phase 10). A page nobody can see is
     frozen: its scripts, timers and animations stop, so it costs no
     CPU, and it carries on where it was when it is shown again. That
     is every tab but the one on screen, and that one too once nobody
     has had the panel open for freezeAfterSec, unless someone is
     listening to its sound. Like a phone does with background tabs. */
  async _life(s) {
    const now = Date.now();
    const seen = s.viewers.size > 0 || now - (s.lastSeen || now) < this.cfg.freezeAfterSec * 1000 || !!s.audio;
    for (const tab of s.tabs || []) {
      const want = tab === s.active && seen ? "active" : "frozen";
      if (tab.life === want || !tab.page) continue;
      tab.life = want;
      await tab.page.send("Page.setWebLifecycleState", { state: want }).catch(() => { tab.life = null; });
    }
  }

  /* MEMORY. One page (a big WebGL game, a leak) must not take the
     browser down for everybody: the container has a hard limit, and
     at it the kernel kills Chromium, or the relay. So a session
     past sessionMemMB is ended, and when the container is nearly
     full the largest one is, each with a sentence saying why. */
  async _watchdog() {
    if (!this.sessions.size) return;
    let big = null;
    for (const s of [...this.sessions.values()]) {
      this._life(s).catch(() => {});
      if (!s.host || s.host.shared || !s.host.proc || !s.host.proc.pid) continue;
      if (!s.host.watch) s.host.watch = new Meter();
      const r = s.host.watch.read(s.host.proc.pid);
      if (!r) continue;
      s.memMb = r.memMb;
      if (r.memMb > this.cfg.sessionMemMB) {
        this.log("WARN", "browser: " + s.who + "'s session used " + r.memMb + " MB, over the " + this.cfg.sessionMemMB + " MB a session may; ended");
        await this.destroy(s.key, "this page needed " + r.memMb + " MB of memory, more than a session may use (" + this.cfg.sessionMemMB + " MB). Open the browser again to start fresh.").catch(() => {});
        continue;
      }
      if (!big || r.memMb > big.memMb) big = s;
    }
    const box = containerMemory();
    if (big && box && box.used / box.max * 100 > this.cfg.memHighPct) {
      this.log("WARN", "browser: the container is " + Math.round(box.used / box.max * 100) + "% full; ending the largest session (" + big.who + ", " + big.memMb + " MB)");
      await this.destroy(big.key, "the browser ran out of memory for everyone, and this session was using the most (" + big.memMb + " MB). Open the browser again to start fresh.").catch(() => {});
    }
  }

  /* The current picture again, for a viewer whose decoder lost its place. */
  async refresh(s) {
    if (!s.casting) return;
    await s.page.send("Page.stopScreencast").catch(() => {});
    await this._startCast(s);
  }

  async _startCast(s) {
    s.casting = true;
    const video = [...s.viewers].some((v) => v.video);
    await s.page.send("Page.startScreencast", {
      format: "jpeg",
      quality: clamp(video ? this.cfg.videoQuality : this.cfg.quality, 20, 95),
      maxWidth: s.width,
      maxHeight: s.height,
      everyNthFrame: Math.max(1, this.cfg.everyNthFrame | 0)
    });
  }

  async resize(s, width, height, scale) {
    const w = clamp(Math.round(width) || 1280, 320, this.cfg.maxViewportWidth);
    const h = clamp(Math.round(height) || 800, 240, this.cfg.maxViewportHeight);
    if (w === s.width && h === s.height) return;
    s.width = w; s.height = h;
    s.scale = clamp(Number(scale) || 1, 0.5, 3);
    await this._metrics(s);
    if (s.casting) {
      await s.page.send("Page.stopScreencast").catch(() => {});
      await this._startCast(s);
    }
  }

  /* Zoom is CSS zoom on the page's root, so text is drawn bigger and
     reflows, sharp, and clicks land where they look as if they should
     with no arithmetic here. Not a device scale factor: Chromium's
     screencast sends pictures at the page's own pixel size, so that
     came out two-thirds the size and was blown up blurry. It is put
     back after every navigation; a new page may show at 100% for a
     moment first. */
  async zoom(s, level) {
    const z = ZOOMS.reduce((a, b) => (Math.abs(b - level) < Math.abs(a - level) ? b : a), 1);
    s.zoom = z;
    await this._applyZoom(s);
    return z;
  }

  async _applyZoom(s) {
    await this._evaluate(s, "document.documentElement && (document.documentElement.style.zoom = " +
      (s.zoom === 1 ? "''" : JSON.stringify(String(s.zoom))) + ", true)").catch(() => {});
  }

  _metrics(s) {
    return Promise.all(s.tabs.map((t) => this._metricsFor(s, t.page).catch(() => {})));
  }

  _metricsFor(s, page) {
    return page.send("Emulation.setDeviceMetricsOverride", {
      width: s.width, height: s.height, deviceScaleFactor: 1, mobile: false
    });
  }

  /* ---- copy and find ----------------------------------------------
     Both run in a world of the engine's own (an isolated world: the
     same document, none of the page's JavaScript), so a page that
     replaces getSelection or window.find changes nothing here. What
     comes back is only ever a string or a yes/no, and is capped. */
  async _evaluate(s, expression) {
    for (let tries = 0; tries < 2; tries++) {
      if (!s.world) {
        const tree = await s.page.send("Page.getFrameTree");
        const r = await s.page.send("Page.createIsolatedWorld",
          { frameId: tree.frameTree.frame.id, worldName: "fieldkit" });
        s.world = r.executionContextId;
      }
      try {
        const r = await s.page.send("Runtime.evaluate",
          { expression, contextId: s.world, returnByValue: true, timeout: 2000 });
        if (r.exceptionDetails) return undefined;
        return r.result ? r.result.value : undefined;
      } catch (e) {
        /* The page moved on and took the world with it. */
        s.world = null;
        if (tries) throw e;
      }
    }
  }

  /* The selected text, for the person's own clipboard. Never from a
     password box, as no browser copies from one. */
  async copyText(s) {
    s.lastSeen = Date.now();
    const v = await this._evaluate(s, COPY_JS);
    return typeof v === "string" ? v.slice(0, COPY_MAX) : "";
  }

  async find(s, text, backwards) {
    s.lastSeen = Date.now();
    const q = String(text || "").slice(0, 200);
    if (!q) return false;
    const v = await this._evaluate(s,
      "window.find(" + JSON.stringify(q) + ", false, " + (backwards ? "true" : "false") + ", true, false, true, false)");
    return v === true;
  }

  /* ---- what a person does to a page ------------------------------ */

  async navigate(s, url) {
    const target = normaliseUrl(url);
    if (!target) throw new Error("that does not look like an address");
    s.lastSeen = Date.now();
    s.pendingNav = target;
    const r = await s.page.send("Page.navigate", { url: target });
    /* Page.navigate reports some failures inline rather than by
       rendering an error page, so both routes have to be covered. */
    if (r && r.errorText && r.errorText !== "net::ERR_ABORTED") {
      const why = this.guard && this.guard.whyRefused();
      for (const v of s.viewers) {
        try {
          v.onEvent({ t: "blocked", url: target, host: why ? why.host : "",
            kind: why ? why.kind : "unreachable",
            why: why ? why.why : "that site could not be reached (" + r.errorText + ")" });
        } catch (e) {}
      }
    }
    return target;
  }

  async back(s) {
    const h = await s.page.send("Page.getNavigationHistory");
    if (h.currentIndex <= 0) return false;
    await s.page.send("Page.navigateToHistoryEntry",
      { entryId: h.entries[h.currentIndex - 1].id });
    return true;
  }

  async forward(s) {
    const h = await s.page.send("Page.getNavigationHistory");
    if (h.currentIndex >= h.entries.length - 1) return false;
    await s.page.send("Page.navigateToHistoryEntry",
      { entryId: h.entries[h.currentIndex + 1].id });
    return true;
  }

  async reload(s) { await s.page.send("Page.reload", { ignoreCache: false }); }

  async answerDialog(s, accept, text) {
    if (!s.pendingDialog) return;
    s.pendingDialog = null;
    if (s.active) s.active.dialog = null;
    await s.page.send("Page.handleJavaScriptDialog",
      { accept: !!accept, promptText: String(text || "") }).catch(() => {});
  }

  async mouse(s, e) {
    s.lastSeen = Date.now();
    await s.page.send("Input.dispatchMouseEvent", {
      type: e.type,
      x: clamp(Number(e.x) || 0, 0, s.width),
      y: clamp(Number(e.y) || 0, 0, s.height),
      button: e.button || "none",
      buttons: e.buttons | 0,
      clickCount: e.clickCount | 0,
      modifiers: e.modifiers | 0,
      deltaX: e.deltaX || 0,
      deltaY: e.deltaY || 0
    });
  }

  async key(s, e) {
    s.lastSeen = Date.now();
    /* insertText for real characters, dispatchKeyEvent for the rest.
       Typing "@" through a raw keydown means getting the modifier
       state and the keyboard layout right; insertText is what the
       person meant and works on every layout. */
    if (e.type === "char" && e.text) {
      return s.page.send("Input.insertText", { text: String(e.text).slice(0, 256) });
    }
    await s.page.send("Input.dispatchKeyEvent", {
      type: e.type === "keyup" ? "keyUp" : "keyDown",
      key: e.key || "",
      code: e.code || "",
      windowsVirtualKeyCode: e.keyCode | 0,
      nativeVirtualKeyCode: e.keyCode | 0,
      modifiers: e.modifiers | 0,
      text: e.type === "keydown" && e.text ? e.text : undefined
    });
  }

  /* ---- clearing, which is the other half of "separate sessions" -- */

  async clearCookies(s) {
    this.kept.delete(s.key);
    await s.cdp.send("Storage.clearCookies", { browserContextId: s.browserContextId })
      .catch(async () => { await s.page.send("Network.clearBrowserCookies").catch(() => {}); });
    this.log("INFO", "browser: cookies cleared for " + s.who);
  }

  async clearAll(s) {
    /* Everything a site could have left: cookies, localStorage,
       IndexedDB, service workers, cache. Done by destroying the
       context rather than by asking nicely, because "clear my
       data" should not depend on a browser API doing all of it. */
    this.kept.delete(s.key);
    await this.destroy(s.key, "cleared by request");
    this.log("INFO", "browser: session wiped for " + s.who);
  }

  async destroy(key, why) {
    const s = this.sessions.get(String(key));
    if (!s) return false;
    /* Ended while its member was away: their sign-ins are kept (in
       memory) for the next session, so a quiet afternoon does not
       sign them out of everything. Never a guest's, never on request. */
    if (s.tier !== "guest" && this.cfg.keepSignInsHours > 0 &&
        (why === "idle" || why === "made room for another session")) {
      try {
        const c = await s.cdp.send("Storage.getCookies", { browserContextId: s.browserContextId });
        if (c && Array.isArray(c.cookies) && c.cookies.length) this.kept.set(s.key, { cookies: c.cookies, at: Date.now() });
      } catch (e) {}
    }
    this.sessions.delete(String(key));
    if (s.dropTimer) { clearTimeout(s.dropTimer); s.dropTimer = null; }
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) {}
    for (const v of s.viewers) { try { v.onGone(why || "session ended"); } catch (e) {} }
    s.viewers.clear();
    this._audioStop(s);
    if (s.host) this._dropHost(s.host);
    else { try { await s.cdp.send("Target.disposeBrowserContext", { browserContextId: s.browserContextId }); } catch (e) {} }
    return true;
  }

  evictIdle() {
    const now = Date.now();
    for (const [k, v] of this.kept) if (now - v.at > this.cfg.keepSignInsHours * 3600000) this.kept.delete(k);
    if (!this.ready) return;
    for (const s of this.sessions.values()) {
      if (!s.downloads) continue;
      for (const [id, d] of s.downloads) {
        if (d.state !== "inProgress" && now - d.at > DL_KEEP_MS) {
          s.downloads.delete(id);
          try { fs.rmSync(d.path, { force: true }); } catch (e) {}
        }
      }
      s.uploads = s.uploads.filter((u) => {
        if (now - u.at < 30 * 60000) return true;
        try { fs.rmSync(path.dirname(u.file), { recursive: true, force: true }); } catch (e) {}
        return false;
      });
      if (s.chooser && now - s.chooser.at > 10 * 60000) s.chooser = null;
    }
    const cutoff = Date.now() - this.cfg.idleMinutes * 60000;
    for (const s of [...this.sessions.values()]) {
      if (s.lastSeen > this.lastUsed) this.lastUsed = s.lastSeen;
      if (s.viewers.size === 0 && s.lastSeen < cutoff) {
        this.destroy(s.key, "idle").catch(() => {});
        this.log("INFO", "browser: evicted idle session for " + s.who);
      }
    }
    if (!this.sessions.size && this.cfg.parkMinutes > 0 &&
        Date.now() - this.lastUsed > this.cfg.parkMinutes * 60000) this.park();
  }

  /* Nobody has used the browser for a while, so Chromium goes: its
     memory (150 MB and up) and its idle CPU are Bastion 1's again for
     most of the day. The next person to open BROWSER starts it, which
     takes a second or two, exactly as on a freshly started relay. */
  park() {
    if (!this.ready || this.sessions.size) return false;
    this._teardown();
    this.log("INFO", "browser: unused for " + this.cfg.parkMinutes + " min, Chromium stopped until it is next opened");
    return true;
  }
}

/* ---- odds and ends ---------------------------------------------- */

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n) || lo)); }

/* A file name that is only a name: no folders, no control
   characters, nothing that starts with a dot, and not too long. */
function cleanName(n) {
  let s = String(n || "").split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").trim();
  s = s.replace(/^\.+/, "");
  if (s.length > 120) { const ext = (s.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0]; s = s.slice(0, 120 - ext.length) + ext; }
  return s;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require("net").createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* An address bar takes what a person types, which is usually not a
   URL. Anything with no scheme and no dot is a search. */
function normaliseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^(javascript|data|file|chrome|devtools|view-source):/i.test(s)) return null;
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).href; } catch (e) { return null; }
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[:/?#]|$)/i.test(s)) {
    try { return new URL("https://" + s).href; } catch (e) { return null; }
  }
  return null;    /* the caller turns this into a search */
}

module.exports = { Engine, findChromium, normaliseUrl, cleanName, DEFAULTS, LIKELY_PATHS, CURSORS };
