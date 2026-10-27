/* ============================================================
   FieldKit :: boot
   POST screen -> quick self-test -> vault gate -> splash -> desktop.

   The whole sequence is driven from here so the visual states in
   §10 stay in one place. Each connection hop gets its own line, so
   a failure is legible instead of a spinner that never resolves.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ui = FieldKit.need("ui");
  var el = ui.el;

  var screenEl, consoleEl, promptEl;
  var settings = null;
  var hopTwo = null;          // resolved after unlock, see connect()
  var lastTransports = null;  // kept so a restore can re-run store.init()

  var FLAVOR = [
    "field terminal — handle with contempt",
    "if it boots, it ships",
    "no network is a network you can trust",
    "the drive remembers what you forget",
    "encryption is just optimism with math",
    "every good tool started as a bad script",
    "warranty void on plug-in",
    "signal is temporary, notes are forever",
    "assume the machine is hostile",
    "one console to carry them"
  ];

  /* ---- console output ----------------------------------------- */
  function line(text, level) {
    var row = el("div", { class: "boot-line" + (level ? " lvl-" + level : "") , text: text });
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
    var v = row.querySelector(".boot-value");
    if (!v) return;
    v.textContent = String(value);
    v.className = "boot-value" + (level ? " lvl-" + level : "");
  }

  function wait(ms) {
    /* Boot theatre gets skipped entirely on slow hardware. */
    var budget = settings ? settings.perfBudget() : "full";
    if (budget === "minimal") return Promise.resolve();
    var scale = budget === "reduced" ? 0.4 : 1;
    return new Promise(function (r) { setTimeout(r, ms * scale); });
  }

  /* ---- phases ------------------------------------------------- */
  async function post() {
    line("FIELDKIT BASIC I/O — v" + FieldKit.VERSION, "accent");
    line("");
    await wait(140);

    pair("HOST", (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "unknown");
    pair("CORES", navigator.hardwareConcurrency || "unreported");
    pair("MEMORY", navigator.deviceMemory ? navigator.deviceMemory + " GB" : "unreported");
    pair("ORIGIN", location.protocol === "file:" ? "LOCAL MEDIA (file://)" : location.origin);
    pair("PERF BUDGET", (settings ? settings.perfBudget() : "full").toUpperCase());

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
    await wait(200);

    var secure = pair("SECURE CONTEXT", "CHECKING");
    await wait(160);
    setValue(secure, window.isSecureContext ? "YES" : "NO", window.isSecureContext ? "pass" : "fail");

    var quota = pair("STORAGE", "QUERYING");
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        setValue(quota, Math.round((est.usage || 0) / 1024) + " KB / " +
          Math.round((est.quota || 0) / 1048576) + " MB", "info");
      } else setValue(quota, "UNREPORTED", "dim");
    } catch (e) { setValue(quota, "UNAVAILABLE", "warn"); }

    /* §10: show when this drive was last used, before the "OS" loads.
       Kept in localStorage rather than the vault so it is readable at
       POST time, and it is not sensitive. */
    var lastSeen = null;
    try { lastSeen = localStorage.getItem("fieldkit.lastLaunch"); } catch (e) { /* private mode */ }
    if (lastSeen) {
      var ago = Date.now() - Number(lastSeen);
      var mins = Math.round(ago / 60000);
      var human = mins < 1 ? "moments ago"
        : mins < 60 ? mins + " min ago"
        : mins < 1440 ? Math.round(mins / 60) + " hr ago"
        : Math.round(mins / 1440) + " day(s) ago";
      pair("LAST LAUNCH", new Date(Number(lastSeen)).toLocaleString() + "  (" + human + ")", "dim");
    } else {
      pair("LAST LAUNCH", "FIRST RUN ON THIS MACHINE", "warn");
    }
    try { localStorage.setItem("fieldkit.lastLaunch", String(Date.now())); } catch (e) { /* fine */ }

    var launches = 0;
    try {
      launches = Number(localStorage.getItem("fieldkit.launchCount") || 0) + 1;
      localStorage.setItem("fieldkit.launchCount", String(launches));
    } catch (e) { /* fine */ }
    if (launches > 1) pair("LAUNCH COUNT", String(launches), "dim");

    await wait(220);
    line("");
  }

  async function quickTest() {
    line("RUNNING QUICK SELF-TEST", "accent");
    var selftest = FieldKit.need("selftest");
    var rows = {};
    var report = await selftest.runQuick(function (i, n, name) {
      rows[name] = pair(name, "...");
    });
    report.results.forEach(function (r) {
      var row = rows[r.name];
      if (row) setValue(row, (r.pass ? "PASS" : "FAIL") + "  " + r.detail, r.pass ? "pass" : (r.critical ? "fail" : "warn"));
    });
    await wait(260);
    line("");
    line(report.criticalFailed
      ? "SELF-TEST: " + report.criticalFailed + " CRITICAL FAULT(S)"
      : "SELF-TEST: " + report.passed + "/" + report.results.length + " PASS  (" + report.totalMs + " ms)",
      report.criticalFailed ? "fail" : "pass");
    await wait(300);
    return report;
  }

  /* ---- connection hops ----------------------------------------
     §10 asks for the two network hops to be visually distinct, so a
     failure says *which leg* died instead of leaving a spinner. The
     USB never talks to the home PC directly — it reaches the relay,
     and the relay reaches LM Studio — so they fail independently and
     are drawn that way. */
  function hop(n, from, to) {
    var glyph = el("span", { class: "hop-glyph", text: "◇" });
    var state = el("span", { class: "hop-state", text: "STANDBY" });
    var detail = el("span", { class: "hop-detail", text: "" });
    var row = el("div", { class: "hop" }, [
      el("span", { class: "hop-n", text: "HOP " + n }),
      glyph,
      el("span", { class: "hop-path" }, [
        el("span", { class: "hop-from", text: from }),
        el("span", { class: "hop-arrow", text: " ──▶ " }),
        el("span", { class: "hop-to", text: to })
      ]),
      state, detail
    ]);
    consoleEl.appendChild(row);
    consoleEl.scrollTop = consoleEl.scrollHeight;

    return {
      probing: function () {
        row.className = "hop probing";
        glyph.textContent = "◈";
        state.textContent = "PROBING";
        detail.textContent = "";
      },
      done: function (level, text, extra) {
        row.className = "hop " + level;
        glyph.textContent = level === "pass" ? "◆" : level === "fail" ? "✕" : "◇";
        state.textContent = text;
        detail.textContent = extra || "";
      }
    };
  }

  async function connect() {
    line("");
    line("ESTABLISHING DATA LINK", "accent");
    await wait(120);

    var store = FieldKit.need("store");
    var relayUrl = settings.get("relayUrl");
    var relay = FieldKit.service("transportRelay");

    var h1 = hop(1, "USB", "RELAY");
    var h2 = hop(2, "RELAY", "HOME PC / LM STUDIO");

    /* ---- hop 1: this machine to the relay ---- */
    var transports = [];
    if (relay && relayUrl) {
      relay.configure(relayUrl, { provisionToken: settings.get("relayProvisionToken") || "" });
      transports.push(relay);
      h1.probing();
      await wait(140);
    } else {
      h1.done("warn", "NOT CONFIGURED", "set a relay URL in RELAY LINK");
    }
    transports.push(FieldKit.need("transportLocal"));
    lastTransports = transports;

    var t0 = performance.now();
    var info = await store.init(transports);
    var hop1Ms = Math.round(performance.now() - t0);

    if (info.transport === "relay") {
      h1.done("pass", "ONLINE", hop1Ms + " ms · " + shortHost(relayUrl));
    } else if (info.unprovisioned) {
      /* Reachable, answered, holds no vault. Reporting this as
         UNREACHABLE — which it did — sent people to check firewalls
         and tunnels for a relay that was replying correctly the
         whole time. The fix is one click away and this is the only
         screen guaranteed to be read, so it names it. */
      h1.done("warn", "NO VAULT ON RELAY",
        "reachable · open RELAY LINK and press PROVISION");
    } else if (relayUrl) {
      h1.done("fail", "UNREACHABLE", "after " + hop1Ms + " ms — working offline");
    }

    /* ---- hop 2 is deferred ----
       /ai/targets is authenticated, and the token is derived from the
       password that has not been typed yet. So this leg is marked as
       waiting here and resolved by probeHop2() once the vault opens —
       which is also the honest order of events. */
    hopTwo = h2;
    if (info.transport !== "relay") {
      h2.done("dim", "NOT ATTEMPTED",
        info.unprovisioned ? "relay has no vault yet"
          : relayUrl ? "needs hop 1" : "relay not configured");
      hopTwo = null;
    } else {
      h2.done("dim", "AWAITING VAULT", "authenticated leg — probed after unlock");
    }

    await wait(200);
    line("");
    pair("TRANSPORT", info.transport.toUpperCase(), info.transport === "relay" ? "pass" : "warn");
    pair("VAULT", info.state === "EMPTY" ? "NOT INITIALISED" : "PRESENT",
      info.state === "EMPTY" ? "warn" : "pass");
    if (info.unprovisioned) {
      pair("RELAY VAULT", "NOT PROVISIONED — RELAY LINK -> PROVISION", "warn");
    }

    var q = FieldKit.service("queue");
    var pending = await q.count();
    if (pending) pair("QUEUED WORK", pending + " op(s) awaiting upload", "warn");

    await wait(240);
    return info;
  }

  /* Resolved after unlock — see the note in connect(). */
  async function probeHop2() {
    if (!hopTwo) return;
    var relay = FieldKit.service("transportRelay");
    var store = FieldKit.need("store");
    if (!relay || store.transportName() !== "relay") {
      hopTwo.done("dim", "NOT ATTEMPTED", "not running against the relay");
      return;
    }

    hopTwo.probing();
    var t0 = performance.now();
    try {
      /* The route returns a bare array of
         { name, priority, health: { ok, status|error } }. */
      var list = await relay.aiTargets();
      var ms = Math.round(performance.now() - t0);
      if (!Array.isArray(list) || !list.length) {
        hopTwo.done("warn", "NO TARGETS", "relay has none configured — tier 3 only");
        return;
      }
      var up = list.filter(function (t) { return t.health && t.health.ok; });
      if (up.length) {
        hopTwo.done("pass", "ONLINE", up[0].name + " · " + up.length + "/" +
          list.length + " reachable · " + ms + " ms");
      } else {
        var why = list[0].health && (list[0].health.error || ("HTTP " + list[0].health.status));
        hopTwo.done("warn", "NO MODEL", list.length + " target(s), none answering" +
          (why ? " (" + preview(why, 30) + ")" : "") + " — tier 3 only");
      }
    } catch (e) {
      hopTwo.done("warn", "UNAVAILABLE", preview(e.message, 44) + " — tier 3 only");
    }
  }

  function shortHost(u) {
    try { return new URL(u).host; } catch (e) { return String(u || "").slice(0, 28); }
  }

  function preview(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /* ---- vault gate --------------------------------------------- */
  function gate(render) {
    return new Promise(function (resolve) {
      ui.clear(promptEl);
      promptEl.style.display = "block";
      render(promptEl, resolve);
      var f = promptEl.querySelector("input");
      if (f) f.focus();
    });
  }

  /* Disaster recovery. Reached when the transport has no vault —
     which is exactly the situation after a relay container is lost
     and replaced. There is no desktop yet, so this has to live here
     rather than in the backup module. */
  async function restoreFlow() {
    var backup = FieldKit.service("backup");
    if (!backup) throw new Error("backup service unavailable");

    var archive = await gate(function (host, done) {
      var msg = el("div", { class: "boot-msg" });
      var summary = el("div");
      var confirmBtn = ui.button("RESTORE THIS ARCHIVE", function () {
        if (pending) done(pending);
      }, { primary: true });
      confirmBtn.disabled = true;

      var pending = null;
      var fileInput = el("input", { type: "file", accept: ".json,application/json",
        style: { display: "none" } });

      fileInput.addEventListener("change", async function (e) {
        var file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        pending = null;
        confirmBtn.disabled = true;
        ui.clear(summary);
        msg.textContent = "READING...";
        msg.className = "boot-msg lvl-dim";
        try {
          var parsed = backup.parse(await backup.readFile(file));
          var check = await backup.verify(parsed);
          var d = backup.describe(parsed);
          ui.clear(summary);
          summary.appendChild(ui.readout([
            { label: "FILE", value: file.name, level: "dim" },
            { label: "CREATED", value: new Date(d.createdAt).toLocaleString() },
            { label: "RECORDS", value: String(d.records) },
            { label: "CONTENTS", value: d.typeSummary || "(none)", level: "dim" },
            { label: "INTEGRITY", value: check.intact ? "CHECKSUM OK" : "CHECKSUM MISMATCH",
              level: check.intact ? "pass" : "fail" }
          ]));
          if (!check.intact) {
            msg.textContent = "REFUSING — THIS ARCHIVE HAS BEEN ALTERED OR TRUNCATED.";
            msg.className = "boot-msg lvl-fail";
            return;
          }
          check.issues.forEach(function (i) {
            summary.appendChild(el("div", { class: "boot-msg lvl-warn", text: i }));
          });
          pending = parsed;
          confirmBtn.disabled = false;
          msg.textContent = "READY. YOU WILL NEED THE PASSWORD THIS ARCHIVE WAS MADE WITH.";
          msg.className = "boot-msg lvl-dim";
        } catch (err) {
          msg.textContent = err.message.toUpperCase();
          msg.className = "boot-msg lvl-fail";
        }
      });

      host.appendChild(el("div", { class: "gate" }, [
        el("div", { class: "gate-title", text: "RESTORE FROM ARCHIVE" }),
        el("p", { class: "gate-note", text:
          "Uploads a previous archive's vault header and every sealed record to this transport. " +
          "Nothing is decrypted here — you unlock afterwards with the password that archive was " +
          "made with, and that is what proves it worked." }),
        el("div", { class: "gate-actions" }, [
          ui.button("CHOOSE ARCHIVE FILE", function () { fileInput.click(); })
        ]),
        summary, msg,
        el("div", { class: "gate-actions" }, [
          confirmBtn,
          ui.button("BACK", function () { done(null); })
        ]),
        fileInput
      ]));
    });

    promptEl.style.display = "none";
    if (!archive) return false;

    var store = FieldKit.need("store");
    var backup = FieldKit.need("backup");
    var row = pair("RESTORING", "header");

    /* Header first, records later, and the split is forced by how
       the relay authenticates rather than by preference. Provisioning
       the header uses the one-time provision token; every record
       upload after it is an ordinary authenticated write needing a
       token derived from the password — which nobody has typed yet
       at this point in the boot.

       Doing both here is what the old code tried, and against a real
       relay the header landed and the first record came back 401,
       leaving a provisioned-but-empty vault that looked restored.
       So: header now, unlock, then merge the records in through an
       authenticated transport. */
    try {
      await backup.restoreToTransport(archive, store.transport(), null, { headerOnly: true });
    } catch (e) {
      setValue(row, "FAILED — " + e.message, "fail");
      line("");
      line("RESTORE FAILED. NOTHING WAS UNLOCKED.", "fail");
      return false;
    }
    setValue(row, "vault header uploaded", "pass");

    /* Re-init so the store picks up the header that now exists. */
    line("RE-READING VAULT HEADER", "dim");
    await store.init(lastTransports || [FieldKit.need("transportLocal")]);

    line("UNLOCK WITH THE ARCHIVE'S PASSWORD TO FINISH THE RESTORE", "accent");
    await unlockFlow();

    /* `store` is the real store captured before unlockFlow ran. A
       guest session swaps the service for a memory one, so asking
       the service would answer "unlocked" about the wrong vault. */
    var guest = FieldKit.service("guest");
    if (guest && guest.active()) {
      line("GUEST SESSION — RESTORE STOPPED AFTER THE HEADER", "warn");
      line("Reload and unlock properly to write the records.", "dim");
      return "unlocked";
    }
    if (!store.isUnlocked()) {
      line("RESTORE INCOMPLETE — the header is in place but no records were written.", "warn");
      line("Re-run the restore and unlock when asked.", "dim");
      return "unlocked";
    }

    var row2 = pair("RESTORING RECORDS", "0 / " + archive.records.length);
    try {
      var merged = await backup.mergeIntoOpenVault(archive, { overwrite: true },
        function (n, total) { setValue(row2, n + " / " + total, "info"); });
      setValue(row2, merged.written + " record(s) restored", "pass");
    } catch (e) {
      setValue(row2, "FAILED — " + e.message, "fail");
      line("");
      line("THE VAULT IS OPEN BUT THE RECORDS DID NOT LAND.", "fail");
      line("Your archive is untouched — try BACKUP -> RESTORE once you are in.", "dim");
      return "unlocked";
    }

    line("RESTORE COMPLETE", "pass");
    return "unlocked";
  }

  async function setupFlow() {
    line("");
    line("NO VAULT ON THIS TRANSPORT — INITIALISING", "accent");

    var choice = await gate(function (host, done) {
      var pw = ui.field("SET MASTER PASSWORD", { type: "password", autocomplete: "new-password" });
      var pw2 = ui.field("CONFIRM", { type: "password", autocomplete: "new-password" });
      var msg = el("div", { class: "boot-msg" });
      function submit() {
        var a = pw.input.value, b = pw2.input.value;
        if (a.length < 8) { msg.textContent = "MINIMUM 8 CHARACTERS."; msg.className = "boot-msg lvl-fail"; return; }
        if (a !== b) { msg.textContent = "PASSWORDS DO NOT MATCH."; msg.className = "boot-msg lvl-fail"; return; }
        done({ kind: "create", password: a });
      }
      host.appendChild(el("div", { class: "gate" }, [
        el("div", { class: "gate-title", text: "VAULT INITIALISATION" }),
        el("p", { class: "gate-note", text:
          "This password encrypts everything. The server never receives it and cannot recover it." }),
        pw, pw2, msg,
        el("div", { class: "gate-actions" }, [ui.button("CREATE VAULT", submit, { primary: true })]),
        FieldKit.service("backup") ? el("p", { class: "gate-note", style: { margin: "14px 0 8px" },
          text: "Replacing a relay you lost? Restore a previous archive instead of starting over." }) : null,
        FieldKit.service("backup") ? el("div", { class: "gate-actions" }, [
          ui.button("RESTORE FROM ARCHIVE", function () { done({ kind: "restore" }); })
        ]) : null
      ]));
      [pw.input, pw2.input].forEach(function (i) {
        i.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
      });
    });

    if (choice && choice.kind === "restore") {
      /* restoreFlow has to unlock partway through — the record
         uploads need a token only the password can derive — so it
         returns "unlocked" when it got that far. Calling unlockFlow
         again here would ask for the same password twice. */
      var restored = await restoreFlow();
      if (restored === "unlocked") return;
      if (restored) { await unlockFlow(); return; }
      /* Backed out or it failed — fall through and offer setup again. */
      return setupFlow();
    }

    var password = choice.password;
    var row = pair("DERIVING KEYS", "WORKING");
    var store = FieldKit.need("store");
    var t0 = performance.now();
    var made = await store.setup(password);
    setValue(row, Math.round(performance.now() - t0) + " ms", "pass");

    /* Recovery key must be acknowledged, not merely displayed. */
    await gate(function (host, done) {
      var confirmField = ui.field("TYPE THE LAST BLOCK TO CONFIRM YOU SAVED IT", { placeholder: "XXXX" });
      var msg = el("div", { class: "boot-msg" });
      var lastBlock = made.recoveryKey.split("-").pop();
      function submit() {
        if (confirmField.input.value.trim().toUpperCase() !== lastBlock) {
          msg.textContent = "DOES NOT MATCH.";
          msg.className = "boot-msg lvl-fail";
          return;
        }
        done(true);
      }
      host.appendChild(el("div", { class: "gate" }, [
        el("div", { class: "gate-title", text: "RECOVERY KEY — WRITE THIS DOWN" }),
        el("p", { class: "gate-note", text:
          "This is the only way back in if you forget the password. It is shown once and is not stored anywhere you can reach." }),
        el("div", { class: "recovery-key", text: made.recoveryKey }),
        el("div", { class: "gate-actions" }, [
          ui.button("COPY", function () {
            ui.copy(made.recoveryKey, {
              title: "RECOVERY KEY — WRITE THIS DOWN",
              note: "The clipboard is blocked here. This key is shown once and cannot be " +
                    "recovered. Copy it by hand before closing this."
            }).then(function (how) { if (how) ui.toast("RECOVERY KEY COPIED", "ok"); });
          }),
          ui.button("PRINT", function () { window.print(); })
        ]),
        confirmField, msg,
        el("div", { class: "gate-actions" }, [ui.button("I HAVE SAVED IT", submit, { primary: true })])
      ]));
      confirmField.input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    });

    promptEl.style.display = "none";
    line("VAULT CREATED", "pass");
  }

  async function unlockFlow() {
    line("");
    line("VAULT LOCKED — AUTHENTICATION REQUIRED", "accent");
    var store = FieldKit.need("store");

    var asGuest = await gate(function (host, done) {
      var pw = ui.field("MASTER PASSWORD", { type: "password", autocomplete: "current-password" });
      var msg = el("div", { class: "boot-msg" });
      var recoveryMode = false;

      async function submit() {
        var val = pw.input.value;
        if (!val) return;
        msg.textContent = "DERIVING KEYS...";
        msg.className = "boot-msg lvl-dim";
        try {
          if (recoveryMode) await store.unlockWithRecovery(val);
          else await store.unlock(val);
          done(true);
        } catch (e) {
          msg.textContent = (e.code === "BAD_PASSWORD" || e.code === "BAD_RECOVERY")
            ? "ACCESS DENIED." : "UNLOCK FAILED: " + e.message;
          msg.className = "boot-msg lvl-fail";
          pw.input.value = "";
          pw.input.focus();
        }
      }

      var toggle = ui.button("USE RECOVERY KEY", function () {
        recoveryMode = !recoveryMode;
        pw.input.type = recoveryMode ? "text" : "password";
        pw.input.value = "";
        pw.querySelector(".fk-field-label").textContent =
          recoveryMode ? "RECOVERY KEY" : "MASTER PASSWORD";
        toggle.textContent = recoveryMode ? "USE PASSWORD" : "USE RECOVERY KEY";
        pw.input.focus();
      });

      host.appendChild(el("div", { class: "gate" }, [
        el("div", { class: "gate-title", text: "AUTHENTICATE" }),
        pw, msg,
        el("div", { class: "gate-actions" }, [
          ui.button("UNLOCK", submit, { primary: true }), toggle
        ]),
        el("p", { class: "gate-note", style: { margin: "14px 0 8px" }, text:
          "Lending the drive? A guest session runs the tools with memory-only " +
          "storage. Nothing of yours is decrypted or shown." }),
        el("div", { class: "gate-actions" }, [
          ui.button("GUEST SESSION", function () { done("guest"); })
        ])
      ]));
      pw.input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    });

    promptEl.style.display = "none";

    if (asGuest === "guest") {
      FieldKit.need("guest").activate();
      line("GUEST SESSION — VAULT SEALED", "warn");
      line("storage is memory-only and discarded on close", "dim");
      return;
    }

    line("VAULT OPEN", "pass");

    var store2 = FieldKit.need("store");
    if (store2.state() === "OFFLINE") {
      line("OFFLINE MODE — PRIOR RECORDS UNREADABLE UNTIL RECONNECT", "warn");
    }

    /* Everything lives on one relay unless a second copy exists. Say
       so at boot rather than at the moment it stops mattering. */
    /* A note left by a guest is sitting unencrypted until someone
       collects it. Nobody opens the guestbook unprompted, so the
       prompt has to come to them. */
    try {
      var pendingRaw = localStorage.getItem("fieldkit.guestbook.pending.v1");
      var pendingNotes = pendingRaw ? JSON.parse(pendingRaw) : [];
      if (Array.isArray(pendingNotes) && pendingNotes.length) {
        line(pendingNotes.length + " GUESTBOOK NOTE(S) WAITING — OPEN GUESTBOOK TO FILE THEM",
          "accent");
      }
    } catch (e) { /* a malformed staging area is the module's problem */ }

    /* The quiet failures: a wrong clock, a full quota, work that
       never uploaded. None of these throw, so nothing else would
       ever mention them. Advisory — it never blocks the desktop. */
    var health = FieldKit.service("health");
    if (health) {
      health.check().then(function (report) {
        report.problems.forEach(function (f) {
          line(f.text, f.level === "fail" ? "fail" : "warn");
        });
      }).catch(function (e) {
        FieldKit.log("warn", "boot", "health check failed: " + e.message);
      });
    }

    var backup = FieldKit.service("backup");
    if (backup) {
      var due = backup.reminder();
      if (due && !health) {
        line(due.text + " — OPEN BACKUP AND EXPORT AN ARCHIVE", "warn");
      }
      /* Start the local snapshot ring. Deliberately after unlock and
         after the reminder: it can only run with the vault open, and
         it is not an excuse to skip the file. */
      if (backup.armAutoSnapshot()) {
        var mins = settings.get("autoSnapshotMinutes");
        if (mins) {
          line("LOCAL SNAPSHOTS ARMED — EVERY " + mins + " MIN AFTER A CHANGE, KEEPING " +
            backup.snapshotKeepCount(), "dim");
        }
      }
      /* One snapshot at boot, so a session that changes nothing still
         leaves a current second copy behind. */
      backup.listSnapshots().then(function (list) {
        var newest = list.length ? list[0].at : 0;
        if (settings.get("autoSnapshotMinutes") && Date.now() - newest > 12 * 3600000) {
          return backup.takeSnapshot("boot");
        }
      }).catch(function () { /* already logged; never blocks the desktop */ });
    }
  }

  /* ---- splash + handoff --------------------------------------- */
  async function splash() {
    line("");
    if (settings.get("bootFlavor")) {
      line("\"" + FLAVOR[Math.floor(Math.random() * FLAVOR.length)] + "\"", "dim");
      line("");
    }
    line("STARTING SHELL", "accent");
    await wait(320);

    screenEl.classList.add("fade");
    await wait(340);
    screenEl.style.display = "none";

    var shell = FieldKit.need("shell");
    shell.build(document.getElementById("fk-root"));
    if (settings.get("wallpaper")) shell.setWallpaper(settings.get("wallpaper"));
    if (settings.get("crt")) document.body.classList.add("crt");

    FieldKit.emit("boot:done", {});
  }

  async function halt(reason) {
    line("");
    line("BOOT HALTED", "fail");
    line(reason, "fail");
    line("");
    line("This machine cannot run FieldKit. Open PREFLIGHT.html from the same folder", "dim");
    line("and press RUN CHECKS — it says which part of this machine is the problem.", "dim");
  }

  /* ---- entry -------------------------------------------------- */
  async function start() {
    settings = FieldKit.need("settings");
    /* Before the theme is applied, so a drive that remembers a
       theme does not make the boot screen flash the old one. */
    var dp = FieldKit.service("driveProfile");
    var profile = dp ? dp.apply() : { loaded: false, applied: [] };
    ui.applyTheme(settings.get("theme"));

    screenEl = document.getElementById("fk-boot");
    consoleEl = document.getElementById("fk-boot-console");
    promptEl = document.getElementById("fk-boot-prompt");
    ui.clear(consoleEl);

    try {
      await post();

      if (!window.isSecureContext || !FieldKit.service("crypto").available) {
        return halt("crypto.subtle is unavailable on this origin — the vault cannot be opened.");
      }

      var report = await quickTest();
      if (report.criticalFailed) {
        var bad = report.results.filter(function (r) { return !r.pass && r.critical; })
          .map(function (r) { return r.name; }).join(", ");
        return halt("critical self-test failure: " + bad);
      }

      var info = await connect();

      if (info.state === "EMPTY") {
        if (!info.online && !FieldKit.need("store").hasVault()) {
          line("");
          line("FIRST RUN REQUIRES A REACHABLE TRANSPORT", "warn");
        }
        await setupFlow();
      } else {
        await unlockFlow();
      }

      var guest = FieldKit.service("guest");
      var isGuest = !!(guest && guest.active());

      /* The vault is open now, so the authenticated second leg can
         finally be reached. A guest never gets one. */
      if (!isGuest) await probeHop2();

      /* Now that the vault is open, the self-test result has
         somewhere encrypted to live. A guest session has no vault to
         write it to, and logging into memory would be pointless. */
      if (!isGuest) FieldKit.need("selftest").log(report);

      await splash();

      /* The screen lock only makes sense over a real open vault. */
      if (!isGuest) {
        var lock = FieldKit.service("lockscreen");
        if (lock) lock.init();
      }

      var eggs = FieldKit.service("easterEggs");
      if (eggs) eggs.init();
    } catch (e) {
      FieldKit.log("error", "boot", e.message);
      halt(e.message);
    }
  }

  FieldKit.provide("boot", { start: start, FLAVOR: FLAVOR });
})(window.FieldKit);
