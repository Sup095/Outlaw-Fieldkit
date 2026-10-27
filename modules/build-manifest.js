/* ============================================================
   FieldKit :: build-manifest
   How big is this thing, and is it growing? (§3, and §5B's
   growth-over-time chart, which is the same data drawn sideways.)

   The original plan was to point this at a directory and have it
   count for itself. showDirectoryPicker() exists on the target
   Chromebook but has never been successfully invoked there (§2C),
   and a tool that only works on one machine is not a tool. So the
   primary input is PASTE: run whatever you already run, paste the
   output, and this pulls the numbers out of it.

   The parser is deliberately loud about what it did NOT find. A
   stat tracker that quietly guesses zero is worse than one that
   says "I could not see a test count in that".

   A snapshot is a point in time, never edited. The chart is the
   whole point — one number is trivia, a line is information.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "manifest";

  var FIELDS = [
    { id: "files",   label: "FILES",   unit: "" },
    { id: "lines",   label: "LINES",   unit: "" },
    { id: "bytes",   label: "SIZE",    unit: "bytes" },
    { id: "tests",   label: "TESTS",   unit: "passing" },
    { id: "failing", label: "FAILING", unit: "" }
  ];

  var ctx, ui, el, nodes = {};
  /* Set at every mount. Async work started by one mount must not
     write into the panel belonging to the next one — see
     FieldKit.mountGuard in core/kernel.js. */
  var alive = function () { return false; };
  var projects = [];
  var currentProject = null;
  var snapshots = [];

  function svc() { return FieldKit.need("projects"); }

  /* ---- the paste parser ------------------------------------------
     Each pattern says where it came from, so the UI can show its
     working rather than a bare number the user has to trust. */
  var PATTERNS = [
    { field: "lines", from: "wc -l total",
      re: /^\s*([\d,]+)\s+total\s*$/mi },
    { field: "lines", from: "cloc SUM",
      re: /^\s*SUM:\s+([\d,]+)\s+[\d,]+\s+[\d,]+\s+([\d,]+)\s*$/mi, group: 2 },
    { field: "files", from: "cloc SUM",
      re: /^\s*SUM:\s+([\d,]+)\s/mi },
    { field: "lines", from: "a 'lines' label",
      re: /\blines?\s*[:=]\s*([\d,]+)/i },
    { field: "files", from: "a 'files' label",
      re: /\bfiles?\s*[:=]\s*([\d,]+)/i },
    { field: "tests", from: "FieldKit test runner",
      re: /^\s*TOTAL\s+pass\s+([\d,]+)/mi },
    { field: "failing", from: "FieldKit test runner",
      re: /^\s*TOTAL\s+pass\s+[\d,]+\s+fail\s+([\d,]+)/mi },
    { field: "tests", from: "jest/vitest summary",
      re: /Tests?:\s*(?:[\d,]+\s+failed,\s*)?([\d,]+)\s+passed/i },
    { field: "failing", from: "jest/vitest summary",
      re: /Tests?:\s*([\d,]+)\s+failed/i },
    { field: "tests", from: "a 'passing' label",
      re: /([\d,]+)\s+passing/i },
    { field: "failing", from: "a 'failing' label",
      re: /([\d,]+)\s+failing/i },
    { field: "bytes", from: "a 'size' label",
      re: /\bsize\s*[:=]\s*([\d,]+)/i },
    { field: "bytes", from: "a KB figure",
      re: /([\d.,]+)\s*KB\b/i, scale: 1024 },
    { field: "bytes", from: "an MB figure",
      re: /([\d.,]+)\s*MB\b/i, scale: 1024 * 1024 }
  ];

  function parsePaste(text) {
    text = String(text || "");
    var found = {}, sources = {}, tried = 0;
    PATTERNS.forEach(function (p) {
      tried++;
      if (found[p.field] !== undefined) return;   // first match wins
      var m = p.re.exec(text);
      if (!m) return;
      var raw = m[p.group || 1];
      var n = Number(String(raw).replace(/,/g, ""));
      if (!isFinite(n)) return;
      found[p.field] = Math.round(p.scale ? n * p.scale : n);
      sources[p.field] = p.from;
    });

    /* Nothing matched but the text is clearly numeric? Say so rather
       than leaving the user staring at an empty form. */
    var missing = FIELDS.map(function (f) { return f.id; })
      .filter(function (id) { return found[id] === undefined; });

    return { values: found, sources: sources, missing: missing, patterns: tried };
  }

  /* ---- data ------------------------------------------------------ */
  function normalise(d, id, meta) {
    var out = {
      id: id,
      projectId: d.projectId || null,
      at: d.at || (meta && meta.updatedAt) || new Date().toISOString(),
      note: String(d.note || "").slice(0, 200),
      author: (meta && meta.author) || null
    };
    FIELDS.forEach(function (f) {
      var v = Number(d[f.id]);
      out[f.id] = isFinite(v) && v >= 0 ? Math.round(v) : null;
    });
    return out;
  }

  async function loadSnapshots() {
    var rows = await ctx.store.list(TYPE);
    snapshots = rows
      .map(function (r) { return normalise(r.data, r.id, r.meta); })
      .filter(function (s) { return !currentProject || s.projectId === currentProject.id; })
      .sort(function (a, b) { return (a.at || "").localeCompare(b.at || ""); });
    return snapshots;
  }

  async function addSnapshot(values, note) {
    if (!currentProject) throw new Error("pick a project first");
    var any = FIELDS.some(function (f) {
      return values[f.id] !== null && values[f.id] !== undefined && values[f.id] !== "";
    });
    if (!any) throw new Error("a snapshot with no numbers in it records nothing");

    var rec = { projectId: currentProject.id, at: new Date().toISOString(), note: note || "" };
    FIELDS.forEach(function (f) {
      var v = values[f.id];
      rec[f.id] = (v === "" || v === null || v === undefined) ? null : Number(v);
    });
    await ctx.store.put(TYPE, rec);
    await refresh();
    return rec;
  }

  function latest() { return snapshots.length ? snapshots[snapshots.length - 1] : null; }
  function previous() { return snapshots.length > 1 ? snapshots[snapshots.length - 2] : null; }

  function delta(field) {
    var a = previous(), b = latest();
    if (!a || !b || a[field] === null || b[field] === null) return null;
    return b[field] - a[field];
  }

  /* ---- the chart -------------------------------------------------
     An inline SVG sparkline. No library, no canvas — it has to
     survive being copied into a report, and a path is text. */
  function sparkline(field, w, h) {
    w = w || 320; h = h || 60;
    var points = snapshots
      .map(function (s) { return { at: s.at, v: s[field] }; })
      .filter(function (p) { return p.v !== null; });

    if (points.length < 2) return null;

    var min = Math.min.apply(null, points.map(function (p) { return p.v; }));
    var max = Math.max.apply(null, points.map(function (p) { return p.v; }));
    var span = max - min || 1;
    var pad = 4;

    var d = points.map(function (p, i) {
      var x = pad + (i / (points.length - 1)) * (w - pad * 2);
      var y = h - pad - ((p.v - min) / span) * (h - pad * 2);
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("class", "bm-spark");
    svg.setAttribute("preserveAspectRatio", "none");

    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    svg.appendChild(path);

    var last = points[points.length - 1];
    var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(w - pad));
    dot.setAttribute("cy", (h - pad - ((last.v - min) / span) * (h - pad * 2)).toFixed(1));
    dot.setAttribute("r", "2.5");
    dot.setAttribute("fill", "currentColor");
    svg.appendChild(dot);

    return { svg: svg, min: min, max: max, points: points.length };
  }

  function fmt(field, v) {
    if (v === null || v === undefined) return "—";
    if (field === "bytes") {
      if (v >= 1048576) return (v / 1048576).toFixed(1) + " MB";
      if (v >= 1024) return Math.round(v / 1024) + " KB";
      return v + " B";
    }
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function fmtDelta(field, d) {
    if (d === null) return "";
    if (d === 0) return "no change";
    return (d > 0 ? "+" : "") + fmt(field, Math.abs(d)).replace(/^/, d > 0 ? "" : "-");
  }

  /* ---- ui -------------------------------------------------------- */
  async function refresh() {
    projects = await svc().all();
    if (currentProject) {
      currentProject = projects.filter(function (p) { return p.id === currentProject.id; })[0] || null;
    }
    if (!currentProject && projects.length) currentProject = projects[0];
    await loadSnapshots();
    renderProjects();
    renderStats();
    renderHistory();
  }

  function renderProjects() {
    if (!nodes.projectSel) return;
    ui.clear(nodes.projectSel);
    if (!projects.length) {
      nodes.projectSel.appendChild(el("option", { value: "", text: "NO PROJECTS YET" }));
    }
    projects.forEach(function (p) {
      nodes.projectSel.appendChild(el("option", {
        value: p.id, text: p.name,
        selected: currentProject && p.id === currentProject.id ? true : null
      }));
    });
  }

  function renderStats() {
    ui.clear(nodes.stats);
    if (!currentProject) {
      nodes.stats.appendChild(el("div", { class: "bm-none",
        text: "CREATE A PROJECT IN CHANGELOG TO TRACK IT HERE" }));
      return;
    }
    var cur = latest();
    if (!cur) {
      nodes.stats.appendChild(el("div", { class: "bm-none", text: "NO SNAPSHOTS YET" }));
      return;
    }

    FIELDS.forEach(function (f) {
      var d = delta(f.id);
      var spark = sparkline(f.id);
      var row = el("div", { class: "bm-stat" }, [
        el("div", { class: "bm-stathead" }, [
          el("span", { class: "bm-statlabel", text: f.label }),
          el("span", { class: "bm-statvalue" + (cur[f.id] === null ? " bm-missing" : ""),
            text: fmt(f.id, cur[f.id]) }),
          el("span", { class: "bm-statdelta" + (d > 0 ? " up" : (d < 0 ? " down" : "")),
            text: fmtDelta(f.id, d) })
        ])
      ]);
      if (spark) {
        var wrap = el("div", { class: "bm-sparkwrap" });
        wrap.appendChild(spark.svg);
        wrap.appendChild(el("span", { class: "bm-sparkrange",
          text: fmt(f.id, spark.min) + " → " + fmt(f.id, spark.max) +
                "  (" + spark.points + " snapshots)" }));
        row.appendChild(wrap);
      }
      nodes.stats.appendChild(row);
    });

    nodes.stats.appendChild(el("div", { class: "bm-asof",
      text: "AS OF " + new Date(cur.at).toLocaleString() +
            (cur.author ? "  ·  " + cur.author : "") +
            (cur.note ? "  ·  " + cur.note : "") }));
  }

  function renderHistory() {
    ui.clear(nodes.history);
    if (!snapshots.length) {
      nodes.history.appendChild(el("div", { class: "bm-none", text: "NOTHING RECORDED YET" }));
      return;
    }
    snapshots.slice().reverse().forEach(function (s) {
      nodes.history.appendChild(el("div", { class: "bm-hrow" }, [
        el("span", { class: "bm-hwhen", text: new Date(s.at).toLocaleDateString() }),
        el("span", { class: "bm-hvals", text: FIELDS.map(function (f) {
          return s[f.id] === null ? null : f.label.toLowerCase() + " " + fmt(f.id, s[f.id]);
        }).filter(Boolean).join("  ·  ") }),
        s.note ? el("span", { class: "bm-hnote", text: s.note }) : null,
        ui.button("×", function () {
          if (!confirm("Delete this snapshot? History is the point of this module.")) return;
          ctx.store.remove(s.id).then(refresh);
        }, { title: "delete" })
      ]));
    });
  }

  function applyParsed(result) {
    ui.clear(nodes.parseNote);
    FIELDS.forEach(function (f) {
      if (result.values[f.id] !== undefined) nodes.inputs[f.id].value = String(result.values[f.id]);
    });

    var got = Object.keys(result.sources);
    if (!got.length) {
      nodes.parseNote.appendChild(el("div", { class: "bm-warn", text:
        "Nothing recognisable in that. Try output from wc -l, cloc, jest, vitest, or the " +
        "FieldKit test runner — or just type the numbers in." }));
      return;
    }
    nodes.parseNote.appendChild(ui.readout(got.map(function (id) {
      var f = FIELDS.filter(function (x) { return x.id === id; })[0];
      return { label: f.label, value: fmt(id, result.values[id]) + "  (from " + result.sources[id] + ")",
        level: "ok" };
    })));
    if (result.missing.length) {
      nodes.parseNote.appendChild(el("div", { class: "bm-warn", text:
        "Not found: " + result.missing.join(", ") + ". Fill those in by hand if you want them." }));
    }
  }

  /* ---- probes ---------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "THE PASTE PARSER READS REAL OUTPUT", critical: false, run: async function () {
        var cases = [
          { text: "   12 a.js\n  340 b.js\n  352 total\n", field: "lines", want: 352 },
          { text: "TOTAL  pass 361   fail 0", field: "tests", want: 361 },
          { text: "TOTAL  pass 361   fail 3", field: "failing", want: 3 },
          { text: "Tests:       2 failed, 40 passed, 42 total", field: "tests", want: 40 },
          { text: "Tests:       2 failed, 40 passed, 42 total", field: "failing", want: 2 },
          { text: "  118 passing\n  2 failing", field: "tests", want: 118 },
          { text: "files: 1,234", field: "files", want: 1234 },
          { text: "wrote FIELDKIT-STANDALONE.html  (566.2 KB)", field: "bytes",
            want: Math.round(566.2 * 1024) }
        ];
        for (var i = 0; i < cases.length; i++) {
          var r = parsePaste(cases[i].text);
          if (r.values[cases[i].field] !== cases[i].want) {
            throw new Error("case " + i + ": " + cases[i].field + " came out as " +
              r.values[cases[i].field] + ", expected " + cases[i].want);
          }
        }
        return cases.length + " real-world formats parsed";
      } },

      /* A stat tracker that guesses is worse than one that shrugs. */
      { name: "THE PARSER ADMITS WHAT IT MISSED", critical: true, run: async function () {
        var r = parsePaste("this is just prose with no numbers in it at all");
        if (Object.keys(r.values).length) {
          throw new Error("it invented values from prose: " + JSON.stringify(r.values));
        }
        if (r.missing.length !== FIELDS.length) {
          throw new Error("it did not report every field as missing");
        }
        var partial = parsePaste("  352 total\n");
        if (partial.values.lines !== 352) throw new Error("it missed the one real number");
        if (partial.missing.indexOf("tests") < 0) {
          throw new Error("it did not report the test count as missing");
        }
        if (Object.keys(partial.sources).length !== 1) {
          throw new Error("it claimed sources it did not have");
        }
        return "no numbers invented, every gap reported";
      } },

      { name: "A SNAPSHOT WITH NO NUMBERS IS REFUSED", critical: false, run: async function () {
        var was = currentProject;
        try {
          currentProject = { id: "selftest-proj", name: "SELFTEST" };
          var threw = null;
          try { await addSnapshot({ files: "", lines: "", bytes: "", tests: "", failing: "" }); }
          catch (e) { threw = e.message; }
          if (!threw) throw new Error("an empty snapshot was accepted");

          var threw2 = null;
          currentProject = null;
          try { await addSnapshot({ lines: 10 }); } catch (e) { threw2 = e.message; }
          if (!threw2) throw new Error("a snapshot with no project was accepted");
          return "empty snapshots and project-less snapshots both refused";
        } finally { currentProject = was; }
      } },

      { name: "SNAPSHOTS ROUND TRIP AND STAY ORDERED", critical: true, run: async function () {
        var was = currentProject, wasSnaps = snapshots;
        try {
          var pid = "selftest-proj-" + Math.random().toString(36).slice(2, 8);
          currentProject = { id: pid, name: "SELFTEST" };
          await api.sandbox.put(TYPE, { projectId: pid, at: "2026-01-01T00:00:00.000Z",
            files: 10, lines: 100, bytes: 1000, tests: 5, failing: 0, note: "first" });
          await api.sandbox.put(TYPE, { projectId: pid, at: "2026-02-01T00:00:00.000Z",
            files: 12, lines: 150, bytes: 1500, tests: 9, failing: 1, note: "second" });

          await loadSnapshots();
          if (snapshots.length !== 2) throw new Error("expected 2 snapshots, got " + snapshots.length);
          if (snapshots[0].note !== "first") throw new Error("oldest is not first");
          if (latest().lines !== 150) throw new Error("latest() picked the wrong one");
          if (previous().lines !== 100) throw new Error("previous() picked the wrong one");
          if (delta("lines") !== 50) throw new Error("delta is wrong: " + delta("lines"));
          if (delta("failing") !== 1) throw new Error("a rising failure count was not seen");
          return "two snapshots, correctly ordered, deltas correct";
        } finally { currentProject = was; snapshots = wasSnaps; }
      } },

      { name: "MISSING NUMBERS STAY MISSING", critical: false, run: async function () {
        var wasSnaps = snapshots;
        try {
          snapshots = [
            normalise({ projectId: "p", at: "2026-01-01T00:00:00Z", lines: 100 }),
            normalise({ projectId: "p", at: "2026-02-01T00:00:00Z", lines: 150 })
          ];
          if (latest().tests !== null) throw new Error("an absent test count became a number");
          if (delta("tests") !== null) throw new Error("a delta was computed from nothing");
          if (fmt("tests", null) !== "—") throw new Error("a missing value did not render as a dash");
          if (fmt("bytes", 2048) !== "2 KB") throw new Error("byte formatting is wrong");
          if (fmt("lines", 1234567) !== "1,234,567") throw new Error("thousands separators are wrong");
          return "absent values stay absent all the way to the screen";
        } finally { snapshots = wasSnaps; }
      } },

      { name: "THE CHART NEEDS TWO POINTS, NOT ONE", critical: false, run: async function () {
        var wasSnaps = snapshots;
        try {
          snapshots = [];
          if (sparkline("lines")) throw new Error("a chart was drawn from no data");
          snapshots = [normalise({ projectId: "p", at: "2026-01-01T00:00:00Z", lines: 100 })];
          if (sparkline("lines")) throw new Error("a chart was drawn from one point");

          snapshots.push(normalise({ projectId: "p", at: "2026-02-01T00:00:00Z", lines: 150 }));
          var s = sparkline("lines", 100, 40);
          if (!s) throw new Error("no chart from two points");
          if (s.min !== 100 || s.max !== 150) throw new Error("the range is wrong");
          var d = s.svg.querySelector("path").getAttribute("d");
          if (!/^M[\d. ]+L/.test(d)) throw new Error("the path is malformed: " + d);

          /* A flat line must not divide by zero. */
          snapshots = [
            normalise({ projectId: "p", at: "2026-01-01T00:00:00Z", lines: 100 }),
            normalise({ projectId: "p", at: "2026-02-01T00:00:00Z", lines: 100 })
          ];
          var flat = sparkline("lines", 100, 40);
          if (!flat) throw new Error("a flat line produced no chart");
          if (/NaN|Infinity/.test(flat.svg.querySelector("path").getAttribute("d"))) {
            throw new Error("a flat line produced a broken path");
          }
          return "one point draws nothing, two draw a line, a flat line does not divide by zero";
        } finally { snapshots = wasSnaps; }
      } },

      { name: "PANEL RENDERS EVERY STATE", critical: false, run: async function () {
        var wasP = currentProject, wasS = snapshots;
        try {
          currentProject = null; snapshots = [];
          renderStats(); renderHistory();
          if (!/CREATE A PROJECT/.test(flatten(nodes.stats))) throw new Error("no-project state missing");

          currentProject = { id: "p", name: "EMPTY" };
          renderStats(); renderHistory();
          if (!/NO SNAPSHOTS/.test(flatten(nodes.stats))) throw new Error("empty state missing");

          snapshots = [
            normalise({ projectId: "p", at: "2026-01-01T00:00:00Z", lines: 100, tests: 5 }),
            normalise({ projectId: "p", at: "2026-02-01T00:00:00Z", lines: 150, tests: 9 })
          ];
          renderStats(); renderHistory();
          var txt = flatten(nodes.stats);
          if (txt.indexOf("150") < 0) throw new Error("the latest value is not shown");
          if (txt.indexOf("+50") < 0) throw new Error("the delta is not shown");
          return "no project, empty, and populated all render";
        } finally { currentProject = wasP; snapshots = wasS; renderStats(); renderHistory(); }
      } }
    ];
  }

  function flatten(node) {
    if (!node) return "";
    var out = [];
    (function walk(n) {
      if (!n) return;
      if (n.textContent) out.push(n.textContent);
      var kids = n.children;
      if (!kids) return;
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(node);
    return out.join(" ");
  }

  FieldKit.register("build-manifest", {
    group: "SYSTEM",
    about: "How big FieldKit is and how it is growing",
    keywords: "manifest size lines code growth",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "MANIFEST",
    icon: "▤",
    width: 740,
    height: 660,

    async mount(host, context) {
      alive = FieldKit.mountGuard("build-manifest");
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.stats = el("div");
      nodes.history = el("div", { class: "bm-history" });
      nodes.parseNote = el("div");
      nodes.inputs = {};

      nodes.projectSel = el("select", { class: "fk-input" });
      nodes.projectSel.addEventListener("change", function () {
        currentProject = projects.filter(function (p) { return p.id === nodes.projectSel.value; })[0] || null;
        loadSnapshots().then(function () { renderStats(); renderHistory(); });
      });

      var paste = el("textarea", { class: "fk-input bm-paste", rows: "5", spellcheck: "false",
        placeholder: "paste output from wc -l, cloc, jest, vitest, or npm test..." });
      paste.addEventListener("input", function () {
        if (paste.value.trim().length > 4) applyParsed(parsePaste(paste.value));
      });

      var grid = el("div", { class: "bm-grid" });
      FIELDS.forEach(function (f) {
        var input = el("input", { class: "fk-input", type: "number", min: "0",
          placeholder: f.unit || "" });
        nodes.inputs[f.id] = input;
        grid.appendChild(el("label", { class: "fk-field bm-field" }, [
          el("span", { class: "fk-field-label", text: f.label + (f.unit ? " (" + f.unit + ")" : "") }),
          input
        ]));
      });

      var noteIn = ui.field("NOTE", { placeholder: "optional — what was happening at this point" });

      var saveBtn = ui.button("TAKE SNAPSHOT", function () {
        var values = {};
        FIELDS.forEach(function (f) { values[f.id] = nodes.inputs[f.id].value; });
        /* Captured, not read inside the continuation: `alive` is
           module scope and the next mount reassigns it, so reading
           it there reads a guard that is always current — passing
           exactly when it should fail. */
        var stillMine = alive;
        addSnapshot(values, noteIn.input.value)
          .then(function () {
            if (!stillMine()) return;
            FIELDS.forEach(function (f) { nodes.inputs[f.id].value = ""; });
            noteIn.input.value = "";
            paste.value = "";
            ui.clear(nodes.parseNote);
            ui.toast("SNAPSHOT TAKEN", "ok");
          })
          .catch(function (e) { ui.toast(e.message.toUpperCase(), "fail"); });
      }, { primary: true });

      host.appendChild(el("div", { class: "bm-wrap" }, [
        el("label", { class: "fk-field" }, [
          el("span", { class: "fk-field-label", text: "PROJECT" }), nodes.projectSel
        ]),

        ui.panel("WHERE IT STANDS", [nodes.stats]),

        ui.panel("TAKE A SNAPSHOT", [
          el("p", { class: "bm-note", text:
            "Paste the output of whatever you already run and the numbers get pulled out of it. " +
            "Anything it cannot find is left blank rather than guessed at — fill those in by hand " +
            "if you want them." }),
          paste,
          nodes.parseNote,
          grid,
          noteIn,
          el("div", { class: "bm-actions" }, [saveBtn])
        ]),

        ui.panel("HISTORY", [nodes.history])
      ]));

      await refresh();
    },

    unmount() { alive.end(); nodes = {}; snapshots = []; projects = []; currentProject = null; }
  });

  function injectCSS() {
    if (document.getElementById("bm-style")) return;
    var s = document.createElement("style");
    s.id = "bm-style";
    s.textContent = `
.bm-wrap{height:100%;overflow:auto}
.bm-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:0 0 8px;
  border-left:2px solid var(--line2);padding-left:9px}
.bm-warn{font-size:10px;color:var(--warn);line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--warn);padding-left:9px}
.bm-paste{width:100%;font-size:10px;line-height:1.5;resize:vertical;white-space:pre}
.bm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;
  margin-top:10px}
.bm-field{margin:0}
.bm-actions{display:flex;gap:6px;margin-top:10px}
.bm-actions .fk-btn{flex:1}
.bm-stat{padding:8px 0;border-bottom:1px solid var(--line)}
.bm-stat:last-child{border-bottom:none}
.bm-stathead{display:flex;align-items:baseline;gap:10px}
.bm-statlabel{flex:0 0 90px;font-size:9px;letter-spacing:.18em;color:var(--accent-dim)}
.bm-statvalue{font-size:15px;color:var(--fg);letter-spacing:.06em}
.bm-statvalue.bm-missing{color:var(--fg-dimmer);font-size:12px}
.bm-statdelta{flex:1;text-align:right;font-size:10px;color:var(--fg-dimmer);letter-spacing:.08em}
.bm-statdelta.up{color:var(--pass)}
.bm-statdelta.down{color:var(--warn)}
.bm-sparkwrap{display:flex;align-items:center;gap:10px;margin-top:5px;padding-left:90px}
.bm-spark{width:100%;max-width:320px;height:46px;color:var(--accent);flex:1}
.bm-sparkrange{font-size:9px;color:var(--fg-dimmer);letter-spacing:.08em;white-space:nowrap}
.bm-asof{margin-top:9px;font-size:9px;color:var(--fg-dimmer);letter-spacing:.1em}
.bm-history{max-height:220px;overflow:auto}
.bm-hrow{display:flex;gap:9px;align-items:baseline;padding:4px 2px;font-size:10px;
  border-bottom:1px solid var(--line)}
.bm-hwhen{flex:0 0 84px;color:var(--accent-dim);letter-spacing:.08em}
.bm-hvals{flex:1;color:var(--fg-dim)}
.bm-hnote{color:var(--fg-dimmer);font-size:9px}
.bm-hrow .fk-btn{padding:1px 7px;font-size:11px;line-height:1}
.bm-none{padding:14px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
@media (max-width:560px){ .bm-sparkwrap{padding-left:0} }
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
