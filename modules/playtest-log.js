/* ============================================================
   FieldKit :: playtest-log
   Bugs and observations from actually playing the game.

   WHY NOT THE INCIDENT LOG

   INCIDENT LOG is for infrastructure: the relay fell over, the
   tunnel dropped, a disk filled. It asks "what broke and how did
   we get it back". Those questions are wrong for a gameplay bug,
   which needs "what were you doing, what did you expect, what
   happened instead, and can you make it happen again" — and
   crucially, WHICH BUILD, because a bug report without a build
   number cannot be confirmed fixed.

   REPRODUCIBILITY IS A FIELD, NOT AN ADJECTIVE

   The single most useful thing on a bug report is whether it
   happens every time. "Sometimes" and "always" get completely
   different treatment: an always-bug is a fix, a sometimes-bug is
   an investigation, and a once-bug is a note to watch for. Making
   it a required choice rather than something to mention in prose
   is the whole reason this is a form and not a text file.

   THE FIXED-IN FIELD IS THE POINT

   A bug is not closed when someone believes it is fixed; it is
   closed when it fails to reproduce on a later build. So FIXED
   records the build it was fixed in, and the report stays until
   somebody says they retested. That is why VERIFIED is a separate
   status from FIXED — on a two-person team the person who fixed
   it is usually not the person who found it, and the gap between
   those two states is where regressions live.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "playtest";

  var SEVERITIES = [
    { id: "crash",   label: "CRASH / BLOCKER", note: "cannot continue playing" },
    { id: "major",   label: "MAJOR",           note: "breaks something important" },
    { id: "minor",   label: "MINOR",           note: "wrong, but playable" },
    { id: "polish",  label: "POLISH",          note: "feel, timing, presentation" },
    { id: "idea",    label: "IDEA",            note: "not a bug — something noticed while playing" }
  ];

  var REPRO = [
    { id: "always",    label: "ALWAYS",    note: "every single time" },
    { id: "sometimes", label: "SOMETIMES", note: "intermittent" },
    { id: "once",      label: "ONCE",      note: "seen a single time, not reproduced" },
    { id: "untested",  label: "NOT TRIED", note: "have not attempted to reproduce" }
  ];

  var STATUSES = [
    { id: "open",     label: "OPEN" },
    { id: "fixed",    label: "FIXED" },
    { id: "verified", label: "VERIFIED" },
    { id: "wontfix",  label: "WON'T FIX" },
    { id: "cantrepro",label: "CANNOT REPRODUCE" }
  ];

  var ctx, ui, el, nodes = {}, rows = [], editingId = null;
  var filterStatus = "open", filterSev = "", filterText = "";

  function me() {
    var s = FieldKit.service("settings");
    return s ? String(s.get("displayName") || "").trim() : "";
  }

  /* The build string is remembered between reports, because during
     a play session every report is against the same build and
     retyping it is exactly the friction that stops people filing
     the fifth bug they noticed. */
  function lastBuild() {
    var s = FieldKit.service("settings");
    return s ? String(s.get("playtestBuild") || "").trim() : "";
  }
  function rememberBuild(b) {
    var s = FieldKit.service("settings");
    if (s && b) { try { s.set("playtestBuild", b); } catch (e) { /* not fatal */ } }
  }

  async function load() {
    rows = await ctx.store.list(TYPE);
    render();
  }

  function labelOf(list, id, fallback) {
    var f = list.filter(function (x) { return x.id === id; })[0];
    return f ? f.label : (fallback || String(id || "").toUpperCase());
  }

  function statusOf(r) {
    var s = r.data.status;
    return STATUSES.some(function (x) { return x.id === s; }) ? s : "open";
  }

  function matches(r) {
    if (filterStatus === "open-ish") {
      if (statusOf(r) !== "open" && statusOf(r) !== "fixed") return false;
    } else if (filterStatus && statusOf(r) !== filterStatus) return false;
    if (filterSev && String(r.data.severity || "") !== filterSev) return false;
    if (filterText) {
      var hay = [r.data.title, r.data.expected, r.data.actual, r.data.steps,
        r.data.area, r.data.build, (r.data.tags || []).join(" ")].join(" ").toLowerCase();
      if (hay.indexOf(filterText.toLowerCase()) < 0) return false;
    }
    return true;
  }

  /* ---- writing ------------------------------------------------- */
  function formData() {
    var title = nodes.title.value.trim();
    if (!title) throw new Error("a report needs a one-line summary");
    var actual = nodes.actual.value.trim();
    if (!actual) throw new Error("say what actually happened");
    return {
      title: title,
      steps: nodes.steps.value.trim(),
      expected: nodes.expected.value.trim(),
      actual: actual,
      severity: nodes.severity.value,
      repro: nodes.repro.value,
      status: nodes.status.value,
      build: nodes.build.value.trim(),
      fixedIn: nodes.fixedIn.value.trim(),
      area: nodes.area.value.trim(),
      reporter: nodes.reporter.value.trim() || me(),
      tags: nodes.tags.value.split(",").map(function (t) { return t.trim(); }).filter(Boolean)
    };
  }

  async function save() {
    var data;
    try { data = formData(); }
    catch (e) { ui.toast(e.message.toUpperCase(), "fail"); return; }

    try {
      await ctx.store.put(TYPE, data, editingId ? { id: editingId } : undefined);
      rememberBuild(data.build);
      ui.toast(editingId ? "REPORT UPDATED" : "REPORT FILED", "ok");
      clearForm();
      await load();
    } catch (e) {
      ui.toast("SAVE FAILED: " + e.message, "fail");
      ctx.error("playtest save failed: " + e.message);
    }
  }

  async function setStatus(r, status) {
    var next = Object.assign({}, r.data, { status: status });
    try {
      await ctx.store.put(TYPE, next, { id: r.id });
      await load();
    } catch (e) { ui.toast("COULD NOT UPDATE: " + e.message, "fail"); }
  }

  function edit(r) {
    editingId = r.id;
    var d = r.data;
    nodes.title.value = d.title || "";
    nodes.steps.value = d.steps || "";
    nodes.expected.value = d.expected || "";
    nodes.actual.value = d.actual || "";
    nodes.severity.value = d.severity || "minor";
    nodes.repro.value = d.repro || "untested";
    nodes.status.value = statusOf(r);
    nodes.build.value = d.build || "";
    nodes.fixedIn.value = d.fixedIn || "";
    nodes.area.value = d.area || "";
    nodes.reporter.value = d.reporter || "";
    nodes.tags.value = (d.tags || []).join(", ");
    nodes.saveBtn.textContent = "UPDATE REPORT";
    nodes.editHint.textContent = "editing an existing report";
  }

  function clearForm() {
    editingId = null;
    ["title", "steps", "expected", "actual", "fixedIn", "area", "tags"].forEach(function (k) {
      if (nodes[k]) nodes[k].value = "";
    });
    if (nodes.severity) nodes.severity.value = "minor";
    if (nodes.repro) nodes.repro.value = "untested";
    if (nodes.status) nodes.status.value = "open";
    if (nodes.build) nodes.build.value = lastBuild();
    if (nodes.reporter) nodes.reporter.value = me();
    if (nodes.saveBtn) nodes.saveBtn.textContent = "FILE REPORT";
    if (nodes.editHint) nodes.editHint.textContent = "";
  }

  /* ---- rendering ----------------------------------------------- */
  function row(r) {
    var d = r.data;
    var st = statusOf(r);

    var head = el("div", { class: "pt-head" }, [
      el("span", { class: "pt-sev sev-" + (d.severity || "minor"),
        text: labelOf(SEVERITIES, d.severity, "MINOR") }),
      el("span", { class: "pt-title", text: d.title || "(untitled)" }),
      el("span", { class: "pt-status st-" + st, text: labelOf(STATUSES, st) })
    ]);

    var meta = [];
    if (d.repro) meta.push("repro: " + labelOf(REPRO, d.repro));
    if (d.build) meta.push("build " + d.build);
    if (d.fixedIn) meta.push("fixed in " + d.fixedIn);
    if (d.area) meta.push(d.area);
    if (d.reporter) meta.push("by " + d.reporter);

    var box = el("div", { class: "pt-row" }, [head]);
    if (meta.length) box.appendChild(el("div", { class: "pt-meta", text: meta.join("  ·  ") }));

    if (d.actual) box.appendChild(el("div", { class: "pt-line" }, [
      el("span", { class: "pt-k", text: "HAPPENED" }),
      el("span", { class: "pt-v", text: d.actual })
    ]));
    if (d.expected) box.appendChild(el("div", { class: "pt-line" }, [
      el("span", { class: "pt-k", text: "EXPECTED" }),
      el("span", { class: "pt-v", text: d.expected })
    ]));
    if (d.steps) box.appendChild(el("div", { class: "pt-line" }, [
      el("span", { class: "pt-k", text: "STEPS" }),
      el("span", { class: "pt-v pre", text: d.steps })
    ]));
    if ((d.tags || []).length) {
      box.appendChild(el("div", { class: "pt-tags", text: (d.tags || []).join(" · ") }));
    }

    var acts = el("div", { class: "pt-actions" });
    /* The two transitions that happen constantly during a session
       get buttons; everything else goes through the editor. */
    if (st === "open") {
      acts.appendChild(el("button", { class: "pt-mini", type: "button", text: "MARK FIXED",
        onclick: function () { setStatus(r, "fixed"); } }));
    }
    if (st === "fixed") {
      acts.appendChild(el("button", { class: "pt-mini ok", type: "button", text: "VERIFIED",
        onclick: function () { setStatus(r, "verified"); } }));
      acts.appendChild(el("button", { class: "pt-mini", type: "button", text: "STILL BROKEN",
        onclick: function () { setStatus(r, "open"); } }));
    }
    acts.appendChild(el("button", { class: "pt-mini", type: "button", text: "EDIT",
      onclick: function () { edit(r); } }));
    box.appendChild(acts);
    return box;
  }

  function render() {
    if (!nodes.list) return;
    ui.clear(nodes.list);

    var visible = rows.filter(matches);

    /* Crashes first, then majors, and within a severity the newest.
       A bug list sorted purely by date puts a typo above a crash. */
    var order = SEVERITIES.map(function (s) { return s.id; });
    visible.sort(function (a, b) {
      var sa = order.indexOf(a.data.severity || "minor");
      var sb = order.indexOf(b.data.severity || "minor");
      if (sa !== sb) return sa - sb;
      return String(b.meta.updatedAt || "").localeCompare(String(a.meta.updatedAt || ""));
    });

    if (!visible.length) {
      nodes.list.appendChild(el("div", { class: "pt-empty", text:
        rows.length ? "nothing matches this filter" : "no reports yet — file one while you play" }));
    } else {
      visible.forEach(function (r) { nodes.list.appendChild(row(r)); });
    }

    renderSummary();
  }

  function renderSummary() {
    if (!nodes.summary) return;
    ui.clear(nodes.summary);
    var open = rows.filter(function (r) { return statusOf(r) === "open"; });
    var crashes = open.filter(function (r) { return r.data.severity === "crash"; }).length;
    var awaiting = rows.filter(function (r) { return statusOf(r) === "fixed"; }).length;

    nodes.summary.appendChild(ui.readout([
      { label: "OPEN", value: String(open.length), level: open.length ? "warn" : "pass" },
      { label: "BLOCKERS", value: String(crashes), level: crashes ? "fail" : "pass" },
      /* The number that actually moves a project: fixed but not
         yet retested by the other person. */
      { label: "AWAITING RETEST", value: String(awaiting), level: awaiting ? "warn" : "dim" },
      { label: "TOTAL FILED", value: String(rows.length), level: "dim" }
    ]));
  }

  function asMarkdown() {
    var L = ["# PLAYTEST REPORT", "", "_" + new Date().toLocaleString() + "_", ""];
    var order = SEVERITIES.map(function (s) { return s.id; });
    STATUSES.forEach(function (st) {
      var mine = rows.filter(function (r) { return statusOf(r) === st.id; });
      if (!mine.length) return;
      mine.sort(function (a, b) {
        return order.indexOf(a.data.severity || "minor") - order.indexOf(b.data.severity || "minor");
      });
      L.push("## " + st.label + " (" + mine.length + ")");
      L.push("");
      mine.forEach(function (r) {
        var d = r.data;
        L.push("### [" + labelOf(SEVERITIES, d.severity, "MINOR") + "] " + (d.title || "(untitled)"));
        var bits = [];
        if (d.repro) bits.push("repro " + labelOf(REPRO, d.repro));
        if (d.build) bits.push("build " + d.build);
        if (d.fixedIn) bits.push("fixed in " + d.fixedIn);
        if (d.area) bits.push(d.area);
        if (d.reporter) bits.push("by " + d.reporter);
        if (bits.length) L.push("_" + bits.join(" · ") + "_");
        L.push("");
        if (d.actual) L.push("- **Happened:** " + d.actual.replace(/\n+/g, " "));
        if (d.expected) L.push("- **Expected:** " + d.expected.replace(/\n+/g, " "));
        if (d.steps) {
          L.push("- **Steps:**");
          d.steps.split("\n").forEach(function (s) {
            if (s.trim()) L.push("  1. " + s.trim());
          });
        }
        L.push("");
      });
    });
    return L.join("\n");
  }

  function selfcheck() {
    return [
      { name: "A REPORT ROUND TRIPS", critical: false, run: async function (api) {
        var sb = api && api.sandbox;
        var title = "PROBE BUG " + Date.now();
        var rec = await ctx.store.put(TYPE, {
          title: title, actual: "the probe wrote this", severity: "minor",
          repro: "always", status: "open", build: "probe", tags: ["probe"]
        });
        if (sb) sb.track(rec.id);
        var back = (await ctx.store.list(TYPE)).filter(function (r) { return r.id === rec.id; })[0];
        if (!back) throw new Error("the report did not persist");
        if (back.data.title !== title) throw new Error("it came back wrong");
        return "filed and read back";
      } },

      /* A report is worthless without a build number and a repro
         rate, so the two that matter most are the two the form
         refuses to lose. */
      { name: "A REPORT WITH NO SUMMARY IS REFUSED", critical: false, run: async function () {
        var keepT = nodes.title.value, keepA = nodes.actual.value;
        nodes.title.value = "";
        nodes.actual.value = "something";
        var threw = null;
        try { formData(); } catch (e) { threw = e; }
        nodes.title.value = keepT; nodes.actual.value = keepA;
        if (!threw) throw new Error("a titleless report was accepted");
        return "refused, with a reason";
      } },

      { name: "AN UNKNOWN STATUS READS AS OPEN", critical: true, run: async function () {
        /* A report written by a future build with a status this one
           does not know must not vanish from the default view —
           losing sight of an open bug is the failure mode here. */
        var fake = { id: "x", meta: {}, data: { title: "t", status: "triaged-by-a-later-build" } };
        if (statusOf(fake) !== "open") {
          throw new Error("unknown status resolved to '" + statusOf(fake) + "'");
        }
        return "unknown statuses stay visible as OPEN";
      } },

      { name: "SEVERITY ORDERS THE LIST, NOT DATE", critical: false, run: async function () {
        var keep = rows;
        rows = [
          { id: "1", meta: { updatedAt: "2030-01-01" }, data: { title: "a typo", severity: "polish", status: "open", tags: [] } },
          { id: "2", meta: { updatedAt: "2020-01-01" }, data: { title: "hard crash", severity: "crash", status: "open", tags: [] } }
        ];
        var keepFilter = filterStatus; filterStatus = "open";
        render();
        var first = nodes.list.querySelector(".pt-title");
        var text = first ? first.textContent : "";
        rows = keep; filterStatus = keepFilter; render();
        if (text !== "hard crash") {
          throw new Error("a polish item outranked a crash: got '" + text + "'");
        }
        return "crashes sort above cosmetics regardless of date";
      } },

      { name: "MARKDOWN EXPORT IS USABLE", critical: false, run: async function () {
        var keep = rows;
        rows = [{ id: "1", meta: {}, data: { title: "Falls through floor", severity: "major",
          repro: "always", status: "open", build: "0.3.1", area: "player",
          actual: "player clips through the floor", expected: "collision holds",
          steps: "load level 2\nsprint into the east wall", tags: ["physics"] } }];
        var md = asMarkdown();
        rows = keep;
        ["# PLAYTEST REPORT", "Falls through floor", "MAJOR", "build 0.3.1",
          "Happened", "Expected", "Steps"].forEach(function (frag) {
          if (md.indexOf(frag) < 0) throw new Error("export is missing '" + frag + "'");
        });
        if (/undefined/.test(md)) throw new Error("export contains 'undefined'");
        return md.split("\n").length + " lines, ready to paste into an issue";
      } }
    ];
  }

  FieldKit.register("playtest-log", {
    group: "PROJECT",
    about: "Bugs and notes from playing the game",
    keywords: "bugs playtest game issues testing",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "PLAYTEST LOG",
    icon: "⚑",
    width: 1000,
    height: 660,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.list = el("div", { class: "pt-list" });
      nodes.summary = el("div");

      nodes.statusFilter = el("select", { class: "fk-input pt-filter",
        onchange: function (e) { filterStatus = e.target.value; render(); } });
      nodes.statusFilter.appendChild(el("option", { value: "open", text: "OPEN ONLY" }));
      nodes.statusFilter.appendChild(el("option", { value: "open-ish", text: "OPEN + FIXED" }));
      nodes.statusFilter.appendChild(el("option", { value: "", text: "EVERYTHING" }));
      STATUSES.forEach(function (s) {
        nodes.statusFilter.appendChild(el("option", { value: s.id, text: s.label }));
      });
      nodes.statusFilter.value = "open";

      nodes.sevFilter = el("select", { class: "fk-input pt-filter",
        onchange: function (e) { filterSev = e.target.value; render(); } });
      nodes.sevFilter.appendChild(el("option", { value: "", text: "ALL SEVERITIES" }));
      SEVERITIES.forEach(function (s) {
        nodes.sevFilter.appendChild(el("option", { value: s.id, text: s.label }));
      });

      nodes.search = el("input", { class: "fk-input pt-filter", placeholder: "SEARCH",
        oninput: function (e) { filterText = e.target.value; render(); } });

      nodes.title = el("input", { class: "fk-input", placeholder: "one line: what is wrong" });
      nodes.actual = el("textarea", { class: "fk-input", rows: "2",
        placeholder: "what actually happened" });
      nodes.expected = el("textarea", { class: "fk-input", rows: "2",
        placeholder: "what you expected instead" });
      nodes.steps = el("textarea", { class: "fk-input", rows: "3",
        placeholder: "one step per line — this is the part that makes it fixable" });
      nodes.build = el("input", { class: "fk-input", placeholder: "build / commit" });
      nodes.fixedIn = el("input", { class: "fk-input", placeholder: "build it was fixed in" });
      nodes.area = el("input", { class: "fk-input", placeholder: "scene, system or asset" });
      nodes.reporter = el("input", { class: "fk-input", placeholder: "who saw it" });
      nodes.tags = el("input", { class: "fk-input", placeholder: "comma, separated, tags" });

      nodes.severity = el("select", { class: "fk-input" });
      SEVERITIES.forEach(function (s) {
        nodes.severity.appendChild(el("option", { value: s.id, text: s.label + " — " + s.note }));
      });
      nodes.repro = el("select", { class: "fk-input" });
      REPRO.forEach(function (s) {
        nodes.repro.appendChild(el("option", { value: s.id, text: s.label + " — " + s.note }));
      });
      nodes.status = el("select", { class: "fk-input" });
      STATUSES.forEach(function (s) {
        nodes.status.appendChild(el("option", { value: s.id, text: s.label }));
      });

      nodes.saveBtn = ui.button("FILE REPORT", save, { primary: true });
      nodes.editHint = el("span", { class: "pt-edit-hint" });

      host.appendChild(el("div", { class: "pt-wrap" }, [
        el("div", { class: "pt-bar" }, [
          nodes.search, nodes.statusFilter, nodes.sevFilter,
          ui.button("EXPORT MARKDOWN", function () {
            ui.copy(asMarkdown(), { title: "PLAYTEST REPORT" }).then(function (how) {
              if (how) ui.toast("REPORT COPIED", "ok");
            });
          }),
          ui.button("REFRESH", load)
        ]),
        nodes.summary,
        el("div", { class: "pt-body" }, [
          nodes.list,
          el("div", { class: "pt-editor" }, [
            el("div", { class: "pt-editor-head" }, [
              el("span", { text: "FILE A REPORT" }), nodes.editHint
            ]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "SUMMARY" }), nodes.title]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "WHAT HAPPENED" }), nodes.actual]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "WHAT YOU EXPECTED" }), nodes.expected]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "STEPS TO REPRODUCE" }), nodes.steps]),
            el("div", { class: "pt-grid" }, [
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "SEVERITY" }), nodes.severity]),
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "HAPPENS" }), nodes.repro]),
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "STATUS" }), nodes.status]),
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "BUILD" }), nodes.build]),
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "FIXED IN" }), nodes.fixedIn]),
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "AREA" }), nodes.area]),
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "REPORTER" }), nodes.reporter]),
              el("label", { class: "fk-field" }, [
                el("span", { class: "fk-field-label", text: "TAGS" }), nodes.tags])
            ]),
            el("div", { class: "pt-actions" }, [nodes.saveBtn, ui.button("CLEAR", clearForm)]),
            el("div", { class: "pt-hint", text:
              "The build number is remembered between reports, so a whole session's worth " +
              "can be filed without retyping it. FIXED and VERIFIED are separate on purpose: " +
              "the person who fixed it is usually not the person who found it." })
          ])
        ])
      ]));

      clearForm();
      await load();
    },

    unmount() {
      nodes = {}; rows = []; editingId = null;
      filterStatus = "open"; filterSev = ""; filterText = "";
    },

    searchIndex() {
      return rows.map(function (r) {
        return {
          id: r.id, module: "playtest-log",
          title: "BUG: " + r.data.title,
          body: [r.data.actual, r.data.expected, r.data.steps, r.data.area, r.data.build]
            .concat(r.data.tags || []).join(" ")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("pt-style")) return;
    var s = document.createElement("style");
    s.id = "pt-style";
    s.textContent = [
      ".pt-wrap{display:flex;flex-direction:column;gap:8px;height:100%}",
      ".pt-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:0 0 auto}",
      ".pt-filter{max-width:180px}",
      ".pt-body{display:flex;gap:10px;flex:1 1 auto;min-height:0}",
      ".pt-list{flex:1 1 58%;overflow-y:auto;min-height:0}",
      ".pt-editor{flex:1 1 42%;overflow-y:auto;min-height:0;border-left:1px solid var(--line2);padding-left:10px}",
      ".pt-editor-head{display:flex;gap:10px;align-items:baseline;font-size:9px;",
      "  letter-spacing:.18em;color:var(--accent);margin-bottom:6px}",
      ".pt-edit-hint{font-size:9px;color:var(--warn)}",
      ".pt-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}",
      ".pt-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}",
      ".pt-hint{font-size:9px;color:var(--fg-dimmer);line-height:1.5;margin-top:8px}",
      ".pt-empty{font-size:10px;color:var(--fg-dimmer);font-style:italic;padding:10px 4px}",
      ".pt-row{border:1px solid var(--line2);background:rgba(0,0,0,.2);padding:7px;margin-bottom:7px}",
      ".pt-head{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}",
      ".pt-title{font-size:11px;flex:1;word-break:break-word}",
      ".pt-sev{font-size:8px;letter-spacing:.08em;padding:1px 4px;border:1px solid var(--line2)}",
      ".pt-sev.sev-crash{border-color:var(--fail);color:var(--fail)}",
      ".pt-sev.sev-major{border-color:var(--warn);color:var(--warn)}",
      ".pt-sev.sev-idea{border-color:var(--accent-dim);color:var(--accent)}",
      ".pt-status{font-size:8px;letter-spacing:.08em;color:var(--fg-dimmer)}",
      ".pt-status.st-verified{color:var(--ok)}",
      ".pt-status.st-fixed{color:var(--warn)}",
      ".pt-meta{font-size:8px;color:var(--fg-dimmer);margin:4px 0}",
      ".pt-line{display:flex;gap:6px;margin:3px 0;font-size:10px;line-height:1.4}",
      ".pt-k{flex:0 0 66px;font-size:8px;letter-spacing:.1em;color:var(--fg-dimmer);padding-top:1px}",
      ".pt-v{flex:1;word-break:break-word}",
      ".pt-v.pre{white-space:pre-wrap}",
      ".pt-tags{font-size:8px;color:var(--fg-dimmer);margin-top:4px}",
      ".pt-actions,.pt-row .pt-actions{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}",
      ".pt-mini{font:inherit;font-size:8px;letter-spacing:.06em;background:none;",
      "  border:1px solid var(--line2);color:var(--fg-dim);padding:2px 6px;cursor:pointer}",
      ".pt-mini:hover{border-color:var(--accent);color:var(--accent)}",
      ".pt-mini.ok:hover{border-color:var(--ok);color:var(--ok)}"
    ].join("");
    document.head.appendChild(s);
  }
})(window.FieldKit);
