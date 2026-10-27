/* ============================================================
   FieldKit :: selftest-panel
   The comprehensive test from §10, with somewhere to actually
   read the results. Also renders the history that boot writes,
   which is what makes "X% of launches passed clean" possible.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, history = [], running = false, lastReport = null;
  /* Set at every mount. Async work started by one mount must not
     write into the panel belonging to the next one — see
     FieldKit.mountGuard in core/kernel.js. */
  var alive = function () { return false; };
  /* Why the history is empty, when it is. "No runs logged yet" and
     "the vault holding them is not open" look identical on screen
     and mean completely different things. */
  var historyError = null;

  /* Never throws. This is called from three places, one of which is
     immediately after a report has been drawn — and a throw there
     used to land in run()'s catch, which clears the report pane and
     replaces a perfectly good result with TEST HARNESS FAULT. The
     history is a nice-to-have; the report someone just waited two
     minutes for is not.

     `list()` throws whenever the vault is not open, which is the
     normal state for a guest session and for a vault whose records
     live on a relay that is not serving them. Both are ordinary
     situations, not faults. */
  async function loadHistory() {
    try {
      history = await ctx.store.list("selftest");
      historyError = null;
    } catch (e) {
      history = [];
      historyError = e.message;
      FieldKit.log("info", "selftest-panel", "no readable history: " + e.message);
    }
    renderHistory();
    renderReliability();
  }

  function renderReport(report) {
    lastReport = report;
    ui.clear(nodes.report);

    var head = report.criticalFailed
      ? { text: "CRITICAL FAULT", level: "fail" }
      : report.failed
        ? { text: "PASS WITH WARNINGS", level: "warn" }
        : { text: "ALL SYSTEMS NOMINAL", level: "pass" };

    nodes.report.appendChild(el("div", { class: "st-verdict lvl-" + head.level, text: head.text }));

    var rows = [
      { label: "SUITE", value: String(report.suite).toUpperCase(), level: "dim" },
      { label: "RESULT", value: report.passed + " / " + report.results.length + " PASS",
        level: report.failed ? "warn" : "pass" }
    ];
    if (report.failed) {
      rows.push({ label: "FAILED", value: String(report.failed),
        level: report.criticalFailed ? "fail" : "warn" });
    }
    if (report.skipped) rows.push({ label: "SKIPPED", value: String(report.skipped), level: "dim" });
    rows.push({ label: "ELAPSED", value: report.totalMs + " ms", level: "dim" });
    rows.push({ label: "MODE", value: report.online ? "ONLINE" : "OFFLINE",
      level: report.online ? "pass" : "warn" });
    nodes.report.appendChild(ui.readout(rows));

    /* The exercise mounts every module for real, and a module that
       touches something outside its own panel leaves the desktop
       subtly wrong afterwards. That is now put back automatically —
       but silently putting it back would hide the bug, so what had
       to be restored is named here. An empty list is the goal. */
    if (report.restored && report.restored.length) {
      nodes.report.appendChild(el("div", { class: "st-restored" }, [
        el("div", { class: "st-restored-h",
          text: "PUT BACK AFTERWARDS (" + report.restored.length + ")" }),
        el("div", { class: "st-restored-p", text:
          "Mounting every module changed these, and the exercise reset them. " +
          "The desktop is as you left it — but each one is a module reaching " +
          "outside its own panel, which is worth fixing at the source." }),
        el("div", { class: "st-restored-l", text: report.restored.join(" · ") })
      ]));
    }

    /* Failures first and separately — with 90-odd checks, scrolling to
       find the red ones is exactly the wrong thing to make someone do. */
    var bad = report.results.filter(function (r) { return !r.pass; });
    if (bad.length) {
      var box = el("div", { class: "st-attention" }, [
        el("div", { class: "st-attention-title", text: "NEEDS ATTENTION" })
      ]);
      bad.forEach(function (r) {
        box.appendChild(el("div", { class: "st-row" }, [
          el("span", { class: "st-flag " + (r.critical ? "lvl-fail" : "lvl-warn"),
            text: r.critical ? "FAIL" : "WARN" }),
          el("span", { class: "st-name", text: r.name }),
          el("span", { class: "st-detail", text: "[" + r.group + "] " + r.detail })
        ]));
      });
      nodes.report.appendChild(box);
    }

    var table = el("div", { class: "st-table" });
    var lastGroup = null;
    report.results.forEach(function (r) {
      if (r.group && r.group !== lastGroup) {
        lastGroup = r.group;
        table.appendChild(el("div", { class: "st-group", text: lastGroup }));
      }
      table.appendChild(el("div", { class: "st-row" }, [
        el("span", {
          class: "st-flag " + (r.skipped ? "lvl-dim" : r.pass ? "lvl-pass" : (r.critical ? "lvl-fail" : "lvl-warn")),
          text: r.skipped ? "SKIP" : r.pass ? "PASS" : (r.critical ? "FAIL" : "WARN")
        }),
        el("span", { class: "st-name", text: r.name }),
        el("span", { class: "st-detail", text: r.detail }),
        el("span", { class: "st-ms", text: r.ms + "ms" })
      ]));
    });
    nodes.report.appendChild(table);
    setExportEnabled(true);
  }

  function setExportEnabled(on) {
    [nodes.copyBtn, nodes.failBtn, nodes.rawBtn, nodes.saveBtn].forEach(function (b) {
      if (b) b.disabled = !on;
    });
  }

  /* The whole reason this panel exists on a machine with no terminal:
     get the results somewhere they can be read or sent. */
  function reportText() {
    return lastReport ? FieldKit.need("selftest").asText(lastReport) : "";
  }

  function copyReport() {
    if (!lastReport) return;
    var text = reportText();
    ui.copy(text, {
      title: "SELF-TEST REPORT",
      note: "Clipboard access is blocked on this machine. The report is selected below — " +
            "press Ctrl+C, or drag-select the part you want."
    }).then(function (how) {
      if (how) ui.toast("REPORT COPIED — " + text.split("\n").length + " LINES", "ok");
    });
  }

  /* A blocked download is silent — the click just does nothing and no
     exception is thrown. So this never claims success; it says where
     to look and offers the route that always works. */
  function saveReport() {
    if (!lastReport) return;
    var text = reportText();
    var name = "fieldkit-selftest-" + lastReport.at.replace(/[:.]/g, "-").slice(0, 19) + ".txt";
    if (ui.download(text, name)) {
      ui.toast("SAVE ATTEMPTED — CHECK DOWNLOADS FOR " + name, "info");
    } else {
      ui.toast("DOWNLOADS ARE BLOCKED HERE", "warn");
      showRaw();
    }
  }

  /* ---- health ---------------------------------------------------- */
  function runHealth() {
    var health = FieldKit.service("health");
    if (!health || !nodes.health) return;
    /* Captured HERE, not read inside the continuations.
       `alive` is module scope and is reassigned by the next mount,
       so a continuation that reads it at call time reads the NEW
       mount's guard — which is always current, and the check passes
       exactly when it should fail. The first version of this fix had
       that bug and looked completely correct. */
    var stillMine = alive;
    /* The health report names the owner's relay, their snapshot
       count and their upload backlog. This panel is guestSafe, so
       the check has to be here rather than assumed. */
    var guest = FieldKit.service("guest");
    if (guest && guest.active()) {
      ui.clear(nodes.health);
      nodes.health.appendChild(el("div", { class: "st-none", text:
        "Health reports on the owner's relay, backups and upload queue — not shown in a " +
        "guest session." }));
      return;
    }
    ui.clear(nodes.health);
    nodes.health.appendChild(el("div", { class: "st-none", text: "CHECKING..." }));
    if (nodes.healthBtn) nodes.healthBtn.disabled = true;

    health.check().then(function (report) {
      if (!stillMine()) return;
      ui.clear(nodes.health);
      nodes.health.appendChild(ui.readout(report.findings.map(function (f) {
        return { label: f.id.toUpperCase(), value: f.text,
          level: f.level === "pass" ? "ok" : f.level };
      })));
      report.problems.forEach(function (f) {
        if (!f.detail) return;
        nodes.health.appendChild(el("div", {
          class: f.level === "fail" ? "st-hfail" : "st-hwarn", text: f.detail
        }));
      });
      if (!report.problems.length) {
        nodes.health.appendChild(el("div", { class: "st-blurb", text: "Nothing to act on." }));
      }
    }).catch(function (e) {
      if (!stillMine()) return;
      ui.clear(nodes.health);
      nodes.health.appendChild(el("div", { class: "st-hfail",
        text: "THE HEALTH CHECK ITSELF FAILED: " + e.message }));
    }).then(function () {
      if (!stillMine()) return;
      if (nodes.healthBtn) nodes.healthBtn.disabled = false;
    });
  }

  /* The one that cannot fail: the text, on the screen, selected. */
  function showRaw() {
    if (!lastReport) return;
    ui.textDump(reportText(), "SELF-TEST REPORT",
      "Everything the test found, as plain text. Select it and press Ctrl+C, or read it here.");
  }

  /* Usually the only part worth sending on. Short enough to retype.

     This read lastReport.groups[].checks[].state — a shape selftest
     has never produced. Reports are {results:[{name, group, pass,
     skipped, critical, detail}]}, so the forEach threw a TypeError
     on undefined every single time, from a plain sync onclick with
     nothing to catch it. The button looked dead.

     Which is a bad button to have broken: this panel exists for a
     machine with no terminal, and this is the one control that gets
     the failures off it. Same family as the clipboard bug — a
     recovery path nobody could have discovered was broken without
     pressing it at the exact moment they needed it. */
  function copyFailures() {
    if (!lastReport) return;
    var rows = Array.isArray(lastReport.results) ? lastReport.results : [];
    var bad = rows.filter(function (r) { return !r.pass || r.skipped; }).map(function (r) {
      var level = r.skipped ? "SKIP" : (r.critical ? "FAIL" : "WARN");
      return level + "  [" + (r.group || "GENERAL") + "] " + r.name +
        (r.detail ? ": " + r.detail : "");
    });
    var text = bad.length
      ? "FIELDKIT — " + bad.length + " NON-PASSING CHECK(S)\n" + lastReport.at + "\n\n" + bad.join("\n")
      : "FIELDKIT — EVERYTHING PASSED\n" + lastReport.at;
    ui.copy(text, {
      title: bad.length + " NON-PASSING CHECK(S)",
      note: "Clipboard access is blocked. Select this and press Ctrl+C."
    }).then(function (how) {
      if (how) ui.toast(bad.length ? "COPIED " + bad.length + " PROBLEM(S)" : "COPIED — ALL CLEAR", "ok");
    });
  }

  /* The exercise mounts modules for real, and this module is one of
     them. core/selftest.js skips anything currently open for exactly
     that reason — but if the shell service is missing, or a future
     caller drives the exercise another way, this module gets mounted
     into the test host and then unmounted, and unmount() sets `nodes`
     to {}. The report would then be drawn into nothing, which is
     precisely how EXERCISE spent its life running to completion and
     printing only a toast.

     Cheap insurance: hold the live panel's state across the run and
     put it back before anything is rendered. Kept as a pair of named
     functions so the probe below can drive the real restore rather
     than a copy of it that could drift. */
  function saveLivePanel() {
    return { nodes: nodes, history: history, error: historyError };
  }
  function restoreLivePanel(saved) {
    if (nodes === saved.nodes) return false;
    nodes = saved.nodes; history = saved.history; historyError = saved.error;
    return true;
  }

  async function run(mode) {
    if (running) return;
    running = true;

    var livePanel = saveLivePanel();
    [nodes.runQuick, nodes.runFull, nodes.runExercise].forEach(function (b) { b.disabled = true; });
    setExportEnabled(false);
    ui.clear(nodes.raw);

    ui.clear(nodes.report);
    var live = el("div", { class: "st-live" });
    var bar = el("div", { class: "st-progress" }, [el("span", { class: "st-progress-fill" })]);
    nodes.report.appendChild(live);
    nodes.report.appendChild(bar);
    var fill = bar.firstChild;

    var st = FieldKit.need("selftest");
    var onStep = function (i, n, name, groupName) {
      live.textContent = "[" + (i + 1) + "/" + n + "]  " +
        (groupName ? groupName + " :: " : "") + name;
      fill.style.width = Math.round((i / n) * 100) + "%";
    };

    try {
      var report = mode === "exercise" ? await st.runExercise(onStep)
        : mode === "full" ? await st.runFull(onStep)
        : await st.runQuick(onStep);

      /* Restore before drawing. If the run remounted this module,
         `nodes` is now either the test host's elements or empty,
         and both draw the report somewhere nobody can see it. */
      if (restoreLivePanel(livePanel)) {
        FieldKit.log("warn", "selftest-panel",
          "the run remounted this panel; restored the live one before rendering");
      }
      renderReport(report);

      /* Everything past this point is bookkeeping, and none of it is
         allowed to take the report down with it. Storing the result
         needs an open vault and reading the history needs a readable
         one; when either is missing — a guest session, or a relay
         that is not serving the vault — this used to throw into the
         catch below, which clears the pane. The COMPREHENSIVE and
         EXERCISE suites take long enough that losing the output to a
         failed log write is the difference between a diagnosis and
         starting over. */
      try { await st.log(report); }
      catch (e2) { FieldKit.log("warn", "selftest-panel", "could not log report: " + e2.message); }
      await loadHistory();

      ui.toast("SELF-TEST: " + report.passed + "/" + report.results.length + " PASS",
        report.criticalFailed ? "fail" : (report.failed ? "warn" : "ok"));
    } catch (e) {
      restoreLivePanel(livePanel);
      /* Even the error path needs somewhere to draw. If the panel
         was torn down entirely there is nothing to report into, and
         the log is the only place left. */
      if (nodes && nodes.report) {
        ui.clear(nodes.report);
        nodes.report.appendChild(el("div", { class: "st-verdict lvl-fail", text: "TEST HARNESS FAULT" }));
        nodes.report.appendChild(el("div", { class: "st-detail", text: e.message }));
      }
      FieldKit.log("error", "selftest-panel", e.stack || e.message);
    } finally {
      restoreLivePanel(livePanel);
      running = false;
      /* Guarded because a torn-down panel has no buttons to re-enable,
         and throwing here would swallow whatever the catch reported. */
      [nodes.runQuick, nodes.runFull, nodes.runExercise].forEach(function (b) {
        if (b) b.disabled = false;
      });
    }
  }

  /* §10: "reliability over time" — the stat that makes logging
     every boot worth doing. */
  function renderReliability() {
    ui.clear(nodes.reliability);
    if (!history.length) {
      nodes.reliability.appendChild(el("div", { class: "st-none",
        text: historyError ? "HISTORY UNREADABLE — " + historyError : "NO TEST HISTORY YET" }));
      /* Distinguishing these two is the whole point. "No history"
         means run one; "unreadable" means the vault holding it is
         not open, and running another will not help. */
      if (historyError) {
        nodes.reliability.appendChild(el("div", { class: "st-detail",
          text: "Results are stored as encrypted records, so this needs an open vault. " +
                "Tests still run and report — they just cannot be kept." }));
      }
      return;
    }

    /* A record whose payload did not decrypt still has meta but no
       data. One of those used to throw here and take the entire
       panel section down; skipping it costs one row of history. */
    history = history.filter(function (h) { return h && h.data; });
    if (!history.length) {
      nodes.reliability.appendChild(el("div", { class: "st-none", text: "NO READABLE TEST HISTORY" }));
      return;
    }

    var clean = history.filter(function (h) { return h.data.failed === 0; }).length;
    var pct = Math.round((clean / history.length) * 100);
    var quick = history.filter(function (h) { return h.data.suite === "quick"; });

    /* Drive-health hint: are startup tests trending slower? Compare
       the oldest third against the newest third. list() is newest
       first, so slice accordingly. */
    var trend = "INSUFFICIENT DATA";
    var trendLevel = "dim";
    if (quick.length >= 6) {
      var third = Math.floor(quick.length / 3);
      var recent = quick.slice(0, third);
      var older = quick.slice(-third);
      var avg = function (a) { return a.reduce(function (s, x) { return s + x.data.totalMs; }, 0) / a.length; };
      var rNow = avg(recent), rThen = avg(older);
      var delta = rThen > 0 ? Math.round(((rNow - rThen) / rThen) * 100) : 0;
      if (delta > 60) { trend = "SLOWING (+" + delta + "%) — CHECK DRIVE"; trendLevel = "fail"; }
      else if (delta > 25) { trend = "SLOWING (+" + delta + "%)"; trendLevel = "warn"; }
      else if (delta < -20) { trend = "FASTER (" + delta + "%)"; trendLevel = "pass"; }
      else { trend = "STABLE (" + (delta >= 0 ? "+" : "") + delta + "%)"; trendLevel = "pass"; }
    }

    nodes.reliability.appendChild(ui.readout([
      { label: "LOGGED RUNS", value: history.length, level: "dim" },
      { label: "CLEAN RUNS", value: clean + " (" + pct + "%)", level: pct >= 90 ? "pass" : (pct >= 70 ? "warn" : "fail") },
      { label: "STARTUP TIME TREND", value: trend, level: trendLevel }
    ]));

    /* Tiny pass/fail strip — oldest on the left. */
    var strip = el("div", { class: "st-strip" });
    history.slice(0, 60).reverse().forEach(function (h) {
      strip.appendChild(el("span", {
        class: "st-tick " + (h.data.criticalFailed ? "bad" : (h.data.failed ? "warn" : "ok")),
        title: new Date(h.data.at).toLocaleString() + " — " +
               h.data.passed + "/" + (h.data.results ? h.data.results.length : "?") + " pass"
      }));
    });
    nodes.reliability.appendChild(strip);
  }

  function renderHistory() {
    ui.clear(nodes.history);
    if (!history.length) {
      /* An empty pane with no caption reads as "broken". Saying
         which kind of empty it is costs one line. */
      nodes.history.appendChild(el("div", { class: "st-none",
        text: historyError ? "NOT READABLE WITHOUT AN OPEN VAULT" : "NO RUNS LOGGED YET" }));
      return;
    }
    history.slice(0, 40).forEach(function (h) {
      var d = h.data;
      if (!d) return;
      nodes.history.appendChild(el("button", {
        class: "st-hist", type: "button",
        onclick: function () { renderReport(d); }
      }, [
        el("span", { class: "st-hist-when", text: new Date(d.at).toLocaleString() }),
        el("span", { class: "st-hist-suite", text: (d.suite || "?").toUpperCase() }),
        el("span", { class: "st-hist-res " + (d.criticalFailed ? "lvl-fail" : (d.failed ? "lvl-warn" : "lvl-pass")),
          text: d.passed + "/" + (d.results ? d.results.length : "?") }),
        el("span", { class: "st-hist-ms", text: d.totalMs + "ms" })
      ]));
    });
  }

  /* This module tests the tester, so it deliberately does not run a
     suite — it checks that a report renders and exports correctly
     against a synthetic one. */
  function selfcheck() {
    var FAKE = {
      at: new Date().toISOString(), suite: "synthetic", totalMs: 12,
      passed: 1, failed: 1, skipped: 1, criticalFailed: 1, online: false,
      device: { platform: "probe", cores: 1, memory: 1, origin: "file://", version: FieldKit.VERSION },
      results: [
        { name: "GOOD", group: "ALPHA", pass: true, detail: "fine", critical: false, ms: 1 },
        { name: "BAD", group: "BETA", pass: false, detail: "broke", critical: true, ms: 2 },
        { name: "MISSING", group: "BETA", pass: true, skipped: true, detail: "SKIPPED — n/a", critical: false, ms: 0 }
      ]
    };
    return [
      { name: "REPORT RENDERS", critical: false, run: async function () {
        var keep = lastReport;
        renderReport(FAKE);
        var text = nodes.report.textContent;
        if (!/CRITICAL FAULT/.test(text)) throw new Error("critical verdict not shown");
        if (!/NEEDS ATTENTION/.test(text)) throw new Error("failures were not surfaced separately");
        if (!/ALPHA/.test(text) || !/BETA/.test(text)) throw new Error("group headers missing");
        if (nodes.report.querySelectorAll(".st-row").length < 4) throw new Error("result rows missing");
        lastReport = keep;
        return "verdict, attention box, and grouped rows";
      } },
      /* The regression this exists for: RELIABILITY and HISTORY read
         `selftest` records, which needs an open, readable vault. When
         list() threw — a guest session, or a relay not serving the
         vault — it escaped loadHistory(), landed in run()'s catch,
         and that catch CLEARS the report pane. So the longest suites
         ran to completion and then replaced their own results with
         TEST HARNESS FAULT, which reads as "the exercise is broken"
         rather than "the history could not be saved". */
      { name: "AN UNREADABLE HISTORY DOES NOT TAKE THE PANEL DOWN", critical: true,
        run: async function () {
          var realList = ctx.store.list;
          var keepHistory = history.slice();
          var keepErr = historyError;
          ctx.store.list = function () {
            return Promise.reject(new Error("vault is locked"));
          };
          try {
            await loadHistory();               // must not throw
            if (history.length !== 0) throw new Error("history should be empty after a failed read");
            if (!historyError) throw new Error("the reason was not recorded");
            var relText = nodes.reliability.textContent;
            if (!/UNREADABLE|OPEN VAULT/i.test(relText)) {
              throw new Error("RELIABILITY does not say why it is empty: " + relText.slice(0, 80));
            }
            var histText = nodes.history.textContent;
            if (!/NOT READABLE|NO RUNS/i.test(histText)) {
              throw new Error("HISTORY does not say why it is empty: " + histText.slice(0, 80));
            }
          } finally {
            ctx.store.list = realList;
            history = keepHistory;
            historyError = keepErr;
            renderHistory();
            renderReliability();
          }
          return "empty history explains itself instead of throwing";
        } },
      /* A record that did not decrypt has meta but no data. One of
         those used to throw out of renderReliability and blank the
         section for every other run in the list. */
      { name: "A HISTORY ROW WITH NO PAYLOAD IS SKIPPED", critical: false,
        run: async function () {
          var keepHistory = history.slice();
          var keepErr = historyError;
          try {
            historyError = null;
            history = [
              { meta: { id: "broken" }, data: null },
              { meta: { id: "fine" }, data: { at: new Date().toISOString(), suite: "quick",
                totalMs: 10, passed: 3, failed: 0, criticalFailed: 0, results: [1, 2, 3] } }
            ];
            renderReliability();
            renderHistory();
            if (!/LOGGED RUNS/.test(nodes.reliability.textContent)) {
              throw new Error("the readable row was not counted");
            }
          } finally {
            history = keepHistory;
            historyError = keepErr;
            renderHistory();
            renderReliability();
          }
          return "undecryptable rows cost one row, not the section";
        } },
      { name: "PLAIN TEXT EXPORT", critical: false, run: async function () {
        var text = FieldKit.need("selftest").asText(FAKE);
        if (text.indexOf("FIELDKIT SELF-TEST REPORT") !== 0) throw new Error("missing header");
        ["-- ALPHA", "-- BETA", "NEEDS ATTENTION", "PASS", "FAIL", "SKIP"].forEach(function (frag) {
          if (text.indexOf(frag) < 0) throw new Error("export is missing '" + frag + "'");
        });
        if (text.indexOf(FieldKit.VERSION) < 0) throw new Error("export does not record the build version");
        return text.split("\n").length + " lines, ready to paste";
      } },
      /* Every export button, driven for real against a report with
         known failures in it. These are the controls that get a
         problem off a machine with no terminal, so a broken one is
         only ever discovered at the exact moment it is needed —
         which is how COPY PROBLEMS ONLY spent its whole life
         throwing a TypeError on a shape selftest never produced. */
      { name: "EVERY EXPORT BUTTON SURVIVES A REAL REPORT", critical: true,
        run: async function () {
          var keep = lastReport;
          var copied = null;
          var realCopy = ui.copy;
          ui.copy = function (text) { copied = text; return Promise.resolve("probe"); };
          try {
            lastReport = FAKE;

            copyFailures();
            if (copied === null) throw new Error("COPY PROBLEMS ONLY produced nothing");
            if (!/FAIL|WARN|SKIP/.test(copied)) {
              throw new Error("the problem list has no non-passing rows in it");
            }
            if (/undefined/.test(copied)) {
              throw new Error("the problem list contains 'undefined': " + copied.slice(0, 120));
            }
            FAKE.results.filter(function (r) { return !r.pass && !r.skipped; })
              .forEach(function (r) {
                if (copied.indexOf(r.name) < 0) {
                  throw new Error("failing check '" + r.name + "' is missing from the list");
                }
              });
            FAKE.results.filter(function (r) { return r.pass && !r.skipped; })
              .forEach(function (r) {
                if (copied.indexOf(r.name) >= 0) {
                  throw new Error("passing check '" + r.name + "' leaked into the problem list");
                }
              });

            copied = null;
            copyReport();
            if (!copied || copied.indexOf("FIELDKIT SELF-TEST REPORT") !== 0) {
              throw new Error("COPY REPORT did not produce a full report");
            }
            return "COPY PROBLEMS ONLY and COPY REPORT both produce usable text";
          } finally {
            ui.copy = realCopy;
            lastReport = keep;
          }
        } },

      { name: "AN ALL-CLEAR REPORT STILL COPIES", critical: false, run: async function () {
        var keep = lastReport;
        var copied = null;
        var realCopy = ui.copy;
        ui.copy = function (text) { copied = text; return Promise.resolve("probe"); };
        try {
          lastReport = { at: new Date().toISOString(), suite: "probe", totalMs: 1,
            passed: 1, skipped: 0, failed: 0, criticalFailed: 0, online: false, device: "probe",
            results: [{ name: "OK", group: "G", pass: true, critical: false, detail: "" }] };
          copyFailures();
          if (!copied) throw new Error("nothing was produced for a clean report");
          if (!/EVERYTHING PASSED/.test(copied)) {
            throw new Error("a clean report does not say so: " + copied.slice(0, 80));
          }
          return "a clean run copies an all-clear rather than an empty string";
        } finally { ui.copy = realCopy; lastReport = keep; }
      } },

      /* Why EXERCISE used to run for thirty seconds and then show
         nothing but a toast. It mounts every module for real, and
         this one holds its DOM in module-level `nodes`; the matching
         unmount() sets that to {}, so renderReport() drew the whole
         report into an object with no elements in it. QUICK and
         COMPREHENSIVE mount nothing, which is the entire reason they
         looked fine and this one did not. */
      { name: "A REMOUNT MID-RUN DOES NOT COST THE REPORT", critical: true,
        run: async function () {
          if (!nodes || !nodes.report) return "SKIPPED — panel is not mounted in this run";
          var saved = saveLivePanel();
          var onScreen = nodes.report;
          nodes = {};                       // exactly what unmount() leaves behind
          if (!restoreLivePanel(saved)) throw new Error("the teardown was not noticed");
          if (nodes.report !== onScreen) throw new Error("restored the wrong panel");

          var keep = lastReport;
          try {
            renderReport(FAKE);
            if (!/CRITICAL FAULT/.test(onScreen.textContent)) {
              throw new Error("the report did not land in the panel that is on screen");
            }
          } finally { lastReport = keep; }
          return "the exercise can remount this panel and still print its results";
        } },

      { name: "HISTORY LOADED", critical: false, run: async function () {
        return history.length ? history.length + " past run(s) on record" : "no history yet";
      } }
    ];
  }

  FieldKit.register("selftest-panel", {
    group: "SYSTEM",
    about: "Test that every part of FieldKit works",
    keywords: "diagnostics test selftest check health",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "DIAGNOSTICS",
    icon: "✇",
    width: 760,
    height: 580,

    async mount(host, context) {
      alive = FieldKit.mountGuard("selftest-panel");
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.report = el("div", { class: "st-report" });
      nodes.raw = el("div");
      nodes.health = el("div");
      nodes.healthBtn = ui.button("RE-CHECK HEALTH", runHealth);
      nodes.reliability = el("div");
      nodes.history = el("div", { class: "st-histlist" });

      nodes.runExercise = ui.button("FULL SYSTEM EXERCISE", function () { run("exercise"); },
        { primary: true, title: "drives every feature for real, including a live message to the AI" });
      nodes.runFull = ui.button("COMPREHENSIVE", function () { run("full"); });
      nodes.runQuick = ui.button("QUICK", function () { run("quick"); });
      nodes.copyBtn = ui.button("COPY REPORT", copyReport, { title: "plain text, ready to paste" });
      nodes.failBtn = ui.button("COPY PROBLEMS ONLY", copyFailures,
        { title: "just the non-passing checks — short enough to retype" });
      nodes.rawBtn = ui.button("SHOW RAW TEXT", showRaw,
        { title: "always works, even with clipboard and downloads blocked" });
      nodes.saveBtn = ui.button("SAVE .TXT", saveReport);
      setExportEnabled(false);

      host.appendChild(el("div", { class: "st-wrap" }, [
        el("div", { class: "st-actions" }, [
          nodes.runExercise, nodes.runFull, nodes.runQuick
        ]),
        el("p", { class: "st-blurb", text:
          "FULL SYSTEM EXERCISE mounts every module, sends a real message to the AI, and puts " +
          "everything back afterwards. It is the one to run when you want to know what actually " +
          "works on this machine." }),
        ui.panel("RESULT", [nodes.report]),
        el("div", { class: "st-actions" }, [
          nodes.copyBtn, nodes.failBtn, nodes.rawBtn
        ]),
        el("div", { class: "st-actions" }, [
          nodes.saveBtn, ui.button("REFRESH HISTORY", loadHistory)
        ]),
        el("p", { class: "st-blurb", text:
          "If COPY does nothing, the clipboard is blocked by policy — SHOW RAW TEXT puts the " +
          "report on screen ready to select, and that route cannot be blocked. A blocked " +
          "download is silent, so SAVE .TXT can only tell you it tried." }),
        nodes.raw,
        ui.panel("HEALTH", [
          el("p", { class: "st-blurb", text:
            "The things that go wrong quietly: a clock that disagrees with the relay, storage " +
            "filling up, work that never uploaded. None of these throw, so nothing else would " +
            "mention them." }),
          nodes.health,
          el("div", { class: "st-actions" }, [nodes.healthBtn])
        ]),
        ui.panel("RELIABILITY", [nodes.reliability]),
        ui.panel("HISTORY", [nodes.history])
      ]));

      nodes.report.appendChild(el("div", { class: "st-none",
        text: "NO TEST RUN THIS SESSION — PRESS FULL SYSTEM EXERCISE" }));
      await loadHistory();
      runHealth();
    },

    unmount() { alive.end();
      nodes = {}; history = []; running = false; lastReport = null; historyError = null;
    }
  });

  function injectCSS() {
    if (document.getElementById("st-style")) return;
    var s = document.createElement("style");
    s.id = "st-style";
    s.textContent = `
.st-wrap{display:flex;flex-direction:column;height:100%;overflow:auto}
.st-actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;flex:none}
.st-blurb{color:var(--fg-dimmer);font-size:10px;line-height:1.55;margin:-4px 0 12px;
  border-left:2px solid var(--line2);padding-left:9px}
.st-hwarn{color:var(--warn);font-size:10px;line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--warn);padding-left:9px}
.st-hfail{color:var(--fail);font-size:10px;line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--fail);padding-left:9px}
.st-verdict{font-size:13px;letter-spacing:.24em;margin-bottom:8px}
.st-restored{border:1px dashed var(--warn);padding:8px;margin-top:8px}
.st-restored-h{font-size:10px;letter-spacing:.16em;color:var(--warn)}
.st-restored-p{font-size:10px;color:var(--fg-dim);line-height:1.5;margin:4px 0}
.st-restored-l{font-size:10px;color:var(--fg);word-break:break-word}
.st-live{color:var(--accent);font-size:11px;letter-spacing:.12em;padding:6px 0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-progress{height:3px;background:var(--line);margin-bottom:8px;overflow:hidden}
.st-progress-fill{display:block;height:100%;width:0;background:var(--accent);
  box-shadow:0 0 8px rgba(var(--accent-glow),.6);transition:width .18s linear}
.st-attention{border:1px solid var(--fail);background:rgba(224,80,60,.06);
  padding:8px 10px;margin:10px 0}
.st-attention-title{color:var(--fail);font-size:9px;letter-spacing:.22em;margin-bottom:5px}
.st-attention .st-row{border-bottom-color:rgba(224,80,60,.2)}
.st-attention .st-row:last-child{border-bottom:0}
.st-group{margin:12px 0 3px;padding-bottom:3px;border-bottom:1px solid var(--line2);
  color:var(--accent);font-size:9px;letter-spacing:.22em}
.st-raw{width:100%;height:190px;resize:vertical;font-size:10px;line-height:1.45;
  margin-bottom:10px;white-space:pre}
.st-table{margin-top:8px}
.st-row{display:flex;align-items:baseline;gap:8px;padding:3px 0;border-bottom:1px dotted var(--line)}
.st-flag{width:38px;flex:none;font-size:9px;letter-spacing:.1em;font-weight:700}
.st-name{width:190px;flex:none;font-size:10px;letter-spacing:.1em;color:var(--fg)}
.st-detail{flex:1;font-size:10px;color:var(--fg-dimmer);word-break:break-word}
.st-ms{flex:none;font-size:9px;color:var(--fg-dimmer)}
.st-strip{display:flex;gap:2px;margin-top:10px;flex-wrap:wrap}
.st-tick{width:7px;height:14px;background:var(--fg-dimmer)}
.st-tick.ok{background:var(--pass)} .st-tick.warn{background:var(--warn)} .st-tick.bad{background:var(--fail)}
.st-histlist{max-height:180px;overflow:auto}
.st-hist{display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;background:none;
  border:0;border-bottom:1px solid var(--line);color:var(--fg-dim);padding:4px 2px;cursor:pointer}
.st-hist:hover{background:rgba(var(--accent-glow),.08);color:var(--accent)}
.st-hist-when{flex:1;font-size:10px}
.st-hist-suite{font-size:9px;color:var(--fg-dimmer);letter-spacing:.1em}
.st-hist-res{font-size:10px;width:44px;text-align:right}
.st-hist-ms{font-size:9px;color:var(--fg-dimmer);width:52px;text-align:right}
.st-none{color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em;padding:8px 0}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
