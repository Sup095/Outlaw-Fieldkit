/* ============================================================
   FieldKit :: health
   The things that go wrong quietly (§7).

   The original plan was "verify the directory handle still
   resolves, warn if the drive letter changed". There are no
   directory handles — §1 put the data on the relay and §2C never
   got the picker working. But the intent behind it was right:
   there is a class of problem that does not throw, does not show
   up in the self-test, and is only noticed weeks later when the
   damage is done.

   That class, concretely:

     CLOCK      last-write-wins compares timestamps. A machine
                whose clock is wrong will lose arguments it should
                win, or win ones it should lose, silently. On a
                shared vault this is the one that eats work.
     STORAGE    snapshots and the offline queue both live in a
                quota. Full quota means writes start failing, and
                the first thing to fail is the safety net.
     BACKLOG    queued offline work that never got uploaded is
                work that exists on exactly one machine.
     PROFILE    a new browser profile means local snapshots and
                recents are gone, without anything being broken.

   Every check returns a finding rather than throwing, and the
   whole thing is advisory: nothing here blocks a boot.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  /* A minute of drift is nothing; five is enough to reorder two
     people's edits. Below the warn threshold we say nothing at all,
     because a health check that always complains gets ignored. */
  var CLOCK_WARN_MS = 5 * 60 * 1000;
  var CLOCK_FAIL_MS = 30 * 60 * 1000;
  var STORAGE_WARN = 0.80;
  var STORAGE_FAIL = 0.93;
  var BACKLOG_WARN = 20;

  var DEVICE_KEY = "fieldkit.lastDevice";

  function svc(n) { return FieldKit.service(n); }

  function finding(id, level, text, detail) {
    return { id: id, level: level, text: text, detail: detail || null };
  }

  /* ---- clock ----------------------------------------------------
     The relay's /health carries its time, so this costs nothing
     extra. Skew is measured against the midpoint of the request to
     avoid blaming a slow link for a wrong clock. */
  async function checkClock() {
    var relay = svc("transportRelay");
    if (!relay || !relay.url || !relay.url()) return null;

    var t0 = Date.now();
    var body;
    /* A blocked host does not refuse, it drops the packets — so this
       fetch hangs until the browser's own timeout, which is minutes.
       The health panel showed CHECKING… the entire time with no way
       to stop it, on exactly the network this project exists to cope
       with. Six seconds is generous for a /health that answers in
       milliseconds when it answers at all. */
    var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ac ? setTimeout(function () { ac.abort(); }, 6000) : null;
    try {
      var res = await fetch(relay.url().replace(/\/$/, "") + "/health", {
        method: "GET", cache: "no-store", signal: ac ? ac.signal : undefined
      });
      body = await res.json();
    } catch (e) {
      return null;   // unreachable is the network's problem, not this one
    } finally {
      if (timer) clearTimeout(timer);
    }
    var t1 = Date.now();
    if (!body || !body.time) return null;

    var serverMs = Date.parse(body.time);
    if (!isFinite(serverMs)) return null;

    var localMid = t0 + (t1 - t0) / 2;
    var skew = localMid - serverMs;
    var abs = Math.abs(skew);
    var mins = Math.round(abs / 60000);
    var ahead = skew > 0 ? "ahead of" : "behind";

    if (abs >= CLOCK_FAIL_MS) {
      return finding("clock", "fail",
        "THIS MACHINE'S CLOCK IS " + mins + " MIN " + ahead.toUpperCase() + " THE RELAY",
        "Records are ordered by timestamp. With this much drift, edits from two machines " +
        "will be ordered wrongly and the newer one can lose. Fix the clock before doing " +
        "shared work.");
    }
    if (abs >= CLOCK_WARN_MS) {
      return finding("clock", "warn",
        "CLOCK IS " + mins + " MIN " + ahead.toUpperCase() + " THE RELAY",
        "Enough drift to reorder two people's edits. Worth fixing if you are sharing this vault.");
    }
    return finding("clock", "pass", "CLOCK AGREES WITH THE RELAY (±" +
      Math.round(abs / 1000) + "s)");
  }

  /* ---- storage --------------------------------------------------- */
  async function checkStorage() {
    if (!navigator.storage || typeof navigator.storage.estimate !== "function") return null;
    var est;
    try { est = await navigator.storage.estimate(); }
    catch (e) { return null; }
    if (!est || !est.quota) return null;

    var used = est.usage || 0;
    var ratio = used / est.quota;
    var mb = function (n) { return Math.round(n / 1048576) + " MB"; };

    if (ratio >= STORAGE_FAIL) {
      return finding("storage", "fail",
        "BROWSER STORAGE IS " + Math.round(ratio * 100) + "% FULL",
        "Local snapshots and the offline queue both live here. When this fills, the safety " +
        "net is the first thing to stop working. " + mb(used) + " of " + mb(est.quota) + ".");
    }
    if (ratio >= STORAGE_WARN) {
      return finding("storage", "warn",
        "BROWSER STORAGE IS " + Math.round(ratio * 100) + "% FULL",
        mb(used) + " of " + mb(est.quota) + ". Reduce the snapshot count in BACKUP if this climbs.");
    }
    return finding("storage", "pass",
      "STORAGE " + Math.round(ratio * 100) + "% USED (" + mb(used) + " of " + mb(est.quota) + ")");
  }

  /* ---- unsynced work --------------------------------------------- */
  async function checkBacklog() {
    var store = svc("store");
    if (!store || typeof store.pendingCount !== "function") return null;
    var n = 0;
    try { n = await store.pendingCount(); } catch (e) { return null; }
    if (!n) return finding("backlog", "pass", "NOTHING WAITING TO UPLOAD");

    var level = n >= BACKLOG_WARN ? "fail" : "warn";
    return finding("backlog", level,
      n + " CHANGE(S) HAVE NEVER REACHED THE RELAY",
      "This work exists on this machine only. It uploads on the next successful connect — " +
      "until then it is not backed up and the other machine cannot see it.");
  }

  /* ---- profile identity ------------------------------------------
     Not a fault. But "where did my snapshots go" has exactly one
     cause and it is worth naming rather than leaving as a mystery. */
  function checkProfile() {
    var id = FieldKit.deviceId;
    if (!id) return null;
    var last = null;
    try { last = localStorage.getItem(DEVICE_KEY); } catch (e) { return null; }
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) { /* fine */ }

    if (!last) return finding("profile", "info", "FIRST RUN IN THIS BROWSER PROFILE");
    if (last !== id) {
      return finding("profile", "warn",
        "THIS IS A DIFFERENT BROWSER PROFILE FROM LAST TIME",
        "Local snapshots, recent tools and the screen-lock state live in the profile, not on " +
        "the drive, so they will look empty. Your vault is unaffected — it is on the relay.");
    }
    return finding("profile", "pass", "SAME BROWSER PROFILE AS LAST TIME");
  }

  /* ---- backups ---------------------------------------------------- */
  async function checkBackup() {
    var backup = svc("backup");
    if (!backup) return null;
    var due = backup.reminder();
    var snaps = [];
    try { snaps = await backup.listSnapshots(); } catch (e) { snaps = []; }

    if (due && !snaps.length) {
      return finding("backup", "fail", due.text + " AND THERE ARE NO LOCAL SNAPSHOTS",
        "Everything is on the relay and nowhere else. Open BACKUP and export an archive.");
    }
    if (due) {
      return finding("backup", "warn", due.text,
        "There are " + snaps.length + " local snapshot(s), which survive the relay dying but " +
        "not this profile being cleared. A file on the drive is the copy that matters.");
    }
    return finding("backup", "pass", snaps.length
      ? "BACKED UP, PLUS " + snaps.length + " LOCAL SNAPSHOT(S)"
      : "BACKED UP RECENTLY");
  }

  /* ---- run them all ------------------------------------------------ */
  async function check(opts) {
    opts = opts || {};
    var jobs = [
      ["clock", checkClock],
      ["storage", checkStorage],
      ["backlog", checkBacklog],
      ["profile", function () { return Promise.resolve(checkProfile()); }],
      ["backup", checkBackup]
    ];

    var findings = [];
    for (var i = 0; i < jobs.length; i++) {
      if (opts.skip && opts.skip.indexOf(jobs[i][0]) >= 0) continue;
      var f = null;
      try { f = await jobs[i][1](); }
      catch (e) {
        /* A health check that breaks the boot is worse than no
           health check. Report the breakage as a finding. */
        f = finding(jobs[i][0], "warn", jobs[i][0].toUpperCase() + " CHECK COULD NOT RUN",
          e && e.message);
      }
      if (f) findings.push(f);
    }

    var worst = "pass";
    findings.forEach(function (f) {
      if (f.level === "fail") worst = "fail";
      else if (f.level === "warn" && worst !== "fail") worst = "warn";
    });

    var report = {
      at: new Date().toISOString(),
      findings: findings,
      problems: findings.filter(function (f) { return f.level === "fail" || f.level === "warn"; }),
      level: worst
    };
    FieldKit.emit("health:checked", report);
    return report;
  }

  function asText(report) {
    if (!report) return "";
    var out = ["FIELDKIT — HEALTH CHECK", report.at, ""];
    report.findings.forEach(function (f) {
      out.push(f.level.toUpperCase().padEnd(5) + " " + f.text);
      if (f.detail) {
        wrap(f.detail, 66).forEach(function (l) { out.push("      " + l); });
      }
    });
    return out.join("\n");
  }

  function wrap(text, width) {
    var words = String(text || "").split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      if (!line.length) { line = w; return; }
      if (line.length + 1 + w.length > width) { lines.push(line); line = w; }
      else line += " " + w;
    });
    if (line.length) lines.push(line);
    return lines.length ? lines : [""];
  }

  FieldKit.provide("health", {
    check: check,
    asText: asText,
    CLOCK_WARN_MS: CLOCK_WARN_MS,
    CLOCK_FAIL_MS: CLOCK_FAIL_MS,
    STORAGE_WARN: STORAGE_WARN,
    STORAGE_FAIL: STORAGE_FAIL,
    BACKLOG_WARN: BACKLOG_WARN
  });
})(window.FieldKit);
