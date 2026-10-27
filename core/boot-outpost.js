/* ============================================================
   FieldKit :: boot-outpost
   The boot sequence for the limited build (§14.1).

   Same shape as core/boot.js so the thing feels like FieldKit —
   POST, self-test, splash, shell — with the entire middle removed.
   There is no vault gate because there is no vault: no transport
   election, no unlock, no setup, no recovery, no screen lock.

   Kept as a separate file rather than a flag inside boot.js on
   purpose. boot.js is 700 lines of vault lifecycle, and OUTPOST's
   manifest does not carry the services half of it calls. A shared
   file guarded by `if (OUTPOST)` would be one missing guard away
   from a boot that dies on a machine nobody can debug from.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ui = null, settings = null, el = null;
  var screenEl = null, consoleEl = null;

  var FLAVOR = [
    "no vault, no worries",
    "everything here is borrowed",
    "the good stuff is on someone else's drive",
    "a terminal is a terminal",
    "assume the machine is hostile",
    "you get the tools, not the secrets"
  ];

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function line(text, level) {
    var row = el("div", { class: "boot-line" + (level ? " lvl-" + level : ""), text: text });
    consoleEl.appendChild(row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
    return row;
  }

  function pair(label, value, level) {
    var row = el("div", { class: "boot-line" }, [
      el("span", { class: "boot-label", text: label }),
      el("span", { class: "boot-dots" }),
      el("span", { class: "boot-value" + (level ? " lvl-" + level : ""), text: String(value) })
    ]);
    consoleEl.appendChild(row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
    return row;
  }

  function setValue(row, value, level) {
    var v = row.lastChild;
    v.textContent = String(value);
    v.className = "boot-value" + (level ? " lvl-" + level : "");
  }

  async function post() {
    line("FIELDKIT OUTPOST — v" + FieldKit.VERSION, "accent");
    line("");
    await wait(140);

    pair("BUILD", "OUTPOST — no vault on this build", "warn");
    pair("HOST", (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform || "unknown");
    pair("CORES", navigator.hardwareConcurrency || "unreported");
    pair("ORIGIN", location.protocol === "file:" ? "LOCAL MEDIA (file://)" : location.origin);

    /* Whether this launch came up already configured, and from what.
       Worth a line: the whole point is that a machine you have never
       used before is not a fresh start, and if it IS one you want to
       know at boot rather than when the relay turns out unset. */
    var dp2 = FieldKit.service("driveProfile");
    var st = dp2 && dp2.status();
    if (st && st.loaded) {
      pair("DRIVE PROFILE", (st.label ? st.label + ", " : "") +
        "saved " + String(st.savedAt || "?").slice(0, 10) +
        (st.applied.length ? " — applied " + st.applied.length : " — machine settings win"), "info");
    } else {
      pair("DRIVE PROFILE", "none — SETTINGS > SAVE TO DRIVE makes this machine's setup travel", "dim");
    }
    await wait(180);

    /* OUTPOST does not need a secure context the way the full build
       does — there is no crypto.subtle dependency in its manifest —
       so this is reported rather than enforced. Messaging will need
       it, and says so itself when it cannot have it. */
    var secure = pair("SECURE CONTEXT", "CHECKING");
    await wait(140);
    setValue(secure, window.isSecureContext ? "YES" : "NO",
      window.isSecureContext ? "pass" : "warn");

    await wait(160);
    line("");
  }

  /* Whether anything written here survives the tab. Worth saying at
     boot rather than leaving someone to discover it by losing a
     guestbook entry. */
  async function storage() {
    var store = FieldKit.need("store");
    var row = pair("LOCAL STORE", "OPENING");
    var info = await store.init();
    if (info.persistent) {
      setValue(row, "READY — kept on this machine", "pass");
    } else {
      setValue(row, "MEMORY ONLY — lost when this tab closes", "warn");
      var why = store.storageError && store.storageError();
      if (why) line("  " + why, "dim");
    }
    await wait(140);
  }

  async function quickTest() {
    line("RUNNING QUICK SELF-TEST", "accent");
    var selftest = FieldKit.need("selftest");
    var report = await selftest.runQuick();
    var lvl = report.criticalFailed ? "fail" : (report.failed ? "warn" : "pass");
    pair("SELF-TEST", report.passed + "/" + report.results.length + " PASS", lvl);

    /* A critical failure does not halt OUTPOST the way it halts the
       full build. There is no vault to protect here, so the useful
       behaviour is to come up anyway and let DIAGNOSTICS say what is
       wrong — a dead screen on a borrowed laptop helps nobody. */
    if (report.criticalFailed) {
      report.results.filter(function (r) { return !r.pass && r.critical; })
        .forEach(function (r) { line("  FAILED: " + r.name, "fail"); });
      line("  continuing anyway — open DIAGNOSTICS for the detail", "dim");
    }
    await wait(160);
    return report;
  }

  async function splash() {
    line("");
    if (settings.get("bootFlavor")) {
      line("\"" + FLAVOR[Math.floor(Math.random() * FLAVOR.length)] + "\"", "dim");
      line("");
    }
    line("STARTING SHELL", "accent");
    await wait(300);

    screenEl.classList.add("fade");
    await wait(320);
    screenEl.style.display = "none";

    var shell = FieldKit.need("shell");
    shell.build(document.getElementById("fk-root"));
    if (settings.get("wallpaper")) shell.setWallpaper(settings.get("wallpaper"));
    if (settings.get("crt")) document.body.classList.add("crt");

    FieldKit.emit("boot:done", { outpost: true });
  }

  function halt(reason) {
    line("");
    line("BOOT HALTED", "fail");
    line(reason, "fail");
    line("");
    line("Open PREFLIGHT.html from the same folder and press RUN CHECKS —", "dim");
    line("it says which part of this machine is the problem.", "dim");
  }

  async function start() {
    ui = FieldKit.need("ui");
    el = ui.el;
    settings = FieldKit.need("settings");
    /* Before the theme is applied, so a drive that remembers a
       theme does not make the boot screen flash the old one. */
    var dp = FieldKit.service("driveProfile");
    var profile = dp ? dp.apply() : { loaded: false, applied: [] };
    ui.applyTheme(settings.get("theme"));

    screenEl = document.getElementById("fk-boot");
    consoleEl = document.getElementById("fk-boot-console");
    ui.clear(consoleEl);

    try {
      await post();
      await storage();
      await quickTest();
      await splash();

      var eggs = FieldKit.service("easterEggs");
      if (eggs) eggs.init();
    } catch (e) {
      FieldKit.log("error", "boot-outpost", e.stack || e.message);
      halt(e.message);
    }
  }

  FieldKit.provide("boot", { start: start, FLAVOR: FLAVOR, OUTPOST: true });
})(window.FieldKit);
