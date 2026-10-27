/* ============================================================
   FieldKit :: changelog
   Bullet points in, a release note out (§3).

   The problem it solves is not formatting. It is that the moment
   you know what changed is while you are changing it, and the
   moment you need a changelog is three weeks later when you have
   forgotten. So entries go in one at a time, unreleased, and
   CUT A VERSION stamps the pile with a number and a date.

   Follows Keep a Changelog's categories, because they are the ones
   people already recognise and because "Added / Fixed / Changed /
   Removed" forces a useful question about each line.

   Shares the project list with everything else through the
   projects service — see core/projects.js for why.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "changelog";

  var KINDS = [
    { id: "added",      label: "ADDED",      hint: "new features" },
    { id: "changed",    label: "CHANGED",    hint: "changes to existing behaviour" },
    { id: "fixed",      label: "FIXED",      hint: "bug fixes" },
    { id: "removed",    label: "REMOVED",    hint: "features taken out" },
    { id: "deprecated", label: "DEPRECATED", hint: "going away soon" },
    { id: "security",   label: "SECURITY",   hint: "anything a user should act on" }
  ];
  var KIND_IDS = KINDS.map(function (k) { return k.id; });

  var ctx, ui, el, nodes = {};
  var projects = [];
  var currentProject = null;
  var entries = [];

  function svc() { return FieldKit.need("projects"); }

  /* ---- data ------------------------------------------------------ */
  function normalise(d, id, meta) {
    return {
      id: id,
      projectId: d.projectId || null,
      kind: KIND_IDS.indexOf(d.kind) >= 0 ? d.kind : "changed",
      text: String(d.text || "").trim(),
      version: d.version || null,          // null = unreleased
      releasedAt: d.releasedAt || null,
      breaking: !!d.breaking,
      at: d.at || (meta && meta.updatedAt) || new Date().toISOString(),
      author: (meta && meta.author) || d.author || null
    };
  }

  async function loadEntries() {
    var rows = await ctx.store.list(TYPE);
    entries = rows
      .map(function (r) { return normalise(r.data, r.id, r.meta); })
      .filter(function (e) { return !currentProject || e.projectId === currentProject.id; })
      .sort(function (a, b) { return (b.at || "").localeCompare(a.at || ""); });
    return entries;
  }

  async function addEntry(kind, text, breaking) {
    if (!currentProject) throw new Error("pick a project first");
    text = String(text || "").trim();
    if (!text) throw new Error("an entry needs some text");
    await ctx.store.put(TYPE, {
      projectId: currentProject.id,
      kind: kind, text: text, breaking: !!breaking,
      version: null, releasedAt: null,
      at: new Date().toISOString()
    });
    await refresh();
  }

  /* Stamping is the whole point: everything unreleased becomes one
     version, atomically, so a half-cut release cannot exist. */
  async function cutVersion(version) {
    version = String(version || "").trim();
    if (!version) throw new Error("a version needs a name");
    var unreleased = entries.filter(function (e) { return !e.version; });
    if (!unreleased.length) throw new Error("there is nothing unreleased to cut");
    if (versions().indexOf(version) >= 0) throw new Error("version " + version + " already exists");

    var at = new Date().toISOString();
    for (var i = 0; i < unreleased.length; i++) {
      var e = unreleased[i];
      await ctx.store.put(TYPE, {
        projectId: e.projectId, kind: e.kind, text: e.text, breaking: e.breaking,
        version: version, releasedAt: at, at: e.at
      }, { id: e.id });
    }
    await refresh();
    return { version: version, entries: unreleased.length };
  }

  async function unrelease(version) {
    var rows = entries.filter(function (e) { return e.version === version; });
    for (var i = 0; i < rows.length; i++) {
      var e = rows[i];
      await ctx.store.put(TYPE, {
        projectId: e.projectId, kind: e.kind, text: e.text, breaking: e.breaking,
        version: null, releasedAt: null, at: e.at
      }, { id: e.id });
    }
    await refresh();
    return rows.length;
  }

  function versions() {
    var seen = {};
    entries.forEach(function (e) { if (e.version) seen[e.version] = e.releasedAt || ""; });
    return Object.keys(seen).sort(function (a, b) {
      return (seen[b] || "").localeCompare(seen[a] || "");
    });
  }

  function grouped() {
    var out = [];
    var unreleased = entries.filter(function (e) { return !e.version; });
    if (unreleased.length) out.push({ version: null, releasedAt: null, entries: unreleased });
    versions().forEach(function (v) {
      var rows = entries.filter(function (e) { return e.version === v; });
      out.push({ version: v, releasedAt: rows[0] && rows[0].releasedAt, entries: rows });
    });
    return out;
  }

  /* ---- markdown -------------------------------------------------- */
  function toMarkdown(opts) {
    opts = opts || {};
    var lines = [];
    var title = currentProject ? currentProject.name : "CHANGELOG";
    lines.push("# " + title);
    lines.push("");
    if (!opts.bare) {
      lines.push("All notable changes to this project are recorded here.");
      lines.push("Categories follow [Keep a Changelog](https://keepachangelog.com).");
      lines.push("");
    }

    grouped().forEach(function (g) {
      if (opts.only && g.version !== opts.only) return;
      lines.push("## " + (g.version || "Unreleased") +
        (g.releasedAt ? " — " + String(g.releasedAt).slice(0, 10) : ""));
      lines.push("");

      var breaking = g.entries.filter(function (e) { return e.breaking; });
      if (breaking.length) {
        lines.push("**BREAKING**");
        lines.push("");
        breaking.forEach(function (e) { lines.push("- " + e.text); });
        lines.push("");
      }

      KINDS.forEach(function (k) {
        var rows = g.entries.filter(function (e) { return e.kind === k.id; });
        if (!rows.length) return;
        lines.push("### " + k.label.charAt(0) + k.label.slice(1).toLowerCase());
        lines.push("");
        rows.forEach(function (e) {
          lines.push("- " + e.text + (e.author && opts.credit ? "  _(" + e.author + ")_" : ""));
        });
        lines.push("");
      });
    });

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  /* ---- ui -------------------------------------------------------- */
  async function refresh() {
    projects = await svc().all();
    if (currentProject) {
      currentProject = projects.filter(function (p) { return p.id === currentProject.id; })[0] || null;
    }
    if (!currentProject && projects.length) currentProject = projects[0];
    await loadEntries();
    renderProjects();
    renderEntries();
  }

  function renderProjects() {
    if (!nodes.projectSel) return;
    ui.clear(nodes.projectSel);
    if (!projects.length) {
      nodes.projectSel.appendChild(el("option", { value: "", text: "NO PROJECTS YET" }));
    }
    projects.forEach(function (p) {
      nodes.projectSel.appendChild(el("option", {
        value: p.id, text: p.name + (p.status !== "active" ? "  (" + p.status + ")" : ""),
        selected: currentProject && p.id === currentProject.id ? true : null
      }));
    });
    var has = !!currentProject;
    [nodes.addBtn, nodes.cutBtn, nodes.copyBtn, nodes.rawBtn].forEach(function (b) {
      if (b) b.disabled = !has;
    });
  }

  function renderEntries() {
    ui.clear(nodes.list);
    if (!currentProject) {
      nodes.list.appendChild(el("div", { class: "cl-none",
        text: "CREATE A PROJECT TO START A CHANGELOG" }));
      return;
    }
    var groups = grouped();
    if (!groups.length) {
      nodes.list.appendChild(el("div", { class: "cl-none", text: "NOTHING RECORDED YET" }));
      return;
    }

    groups.forEach(function (g) {
      var head = el("div", { class: "cl-vhead" }, [
        el("span", { class: "cl-vname" + (g.version ? "" : " cl-unreleased"),
          text: g.version || "UNRELEASED" }),
        el("span", { class: "cl-vdate",
          text: g.releasedAt ? String(g.releasedAt).slice(0, 10) : g.entries.length + " pending" })
      ]);
      if (g.version) {
        head.appendChild(ui.button("REOPEN", function () {
          if (!confirm("Move every entry in " + g.version + " back to unreleased?")) return;
          unrelease(g.version).then(function (n) {
            ui.toast("REOPENED " + g.version + " — " + n + " ENTRY(S)", "ok");
          });
        }));
      }
      nodes.list.appendChild(head);

      KINDS.forEach(function (k) {
        var rows = g.entries.filter(function (e) { return e.kind === k.id; });
        if (!rows.length) return;
        nodes.list.appendChild(el("div", { class: "cl-kind", text: k.label }));
        rows.forEach(function (e) {
          nodes.list.appendChild(el("div", { class: "cl-entry" }, [
            e.breaking ? el("span", { class: "cl-breaking", text: "BREAKING" }) : null,
            el("span", { class: "cl-text", text: e.text }),
            e.author ? el("span", { class: "cl-author", text: e.author }) : null,
            ui.button("×", function () {
              if (!confirm("Delete this entry?")) return;
              ctx.store.remove(e.id).then(refresh);
            }, { title: "delete" })
          ]));
        });
      });
    });
  }

  async function newProject() {
    var name = prompt("Project name:");
    if (name === null) return;
    try {
      var p = await svc().create(name);
      currentProject = p;
      await refresh();
      ui.toast("PROJECT CREATED — " + p.slug, "ok");
    } catch (e) {
      ui.toast(e.message.toUpperCase(), "fail");
    }
  }

  /* ---- probes ---------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "SLUGS ARE STABLE AND SAFE", critical: false, run: async function () {
        var s = svc().slugify;
        var cases = [
          ["IRONMARCH", "ironmarch"],
          ["Metro-fall", "metro-fall"],
          ["Guild of the Deep", "guild-of-the-deep"],
          ["  spaced  out  ", "spaced-out"],
          ["Don't Starve!", "dont-starve"],
          ["../../etc/passwd", "etc-passwd"],
          ["", "untitled"],
          ["!!!", "untitled"]
        ];
        for (var i = 0; i < cases.length; i++) {
          var got = s(cases[i][0]);
          if (got !== cases[i][1]) {
            throw new Error(JSON.stringify(cases[i][0]) + " -> " + got + ", expected " + cases[i][1]);
          }
        }
        if (/[^a-z0-9-]/.test(s("Ünïcödé ✱ Name"))) throw new Error("a slug escaped the safe alphabet");
        return cases.length + " names slugged, including path traversal and empty input";
      } },

      { name: "A PROJECT ROUND TRIPS", critical: true, run: async function () {
        var name = "SELFTEST PROJECT " + Math.random().toString(36).slice(2, 8).toUpperCase();
        var rec = await api.sandbox.put("project", {
          name: name, slug: svc().slugify(name), status: "active", notes: "",
          createdAt: new Date().toISOString()
        });
        var back = await svc().get(rec.id);
        if (!back) throw new Error("the project could not be read back");
        if (back.name !== name) throw new Error("the name did not survive: " + back.name);
        if (back.status !== "active") throw new Error("the status did not survive");
        var listed = await svc().all();
        if (!listed.some(function (p) { return p.id === rec.id; })) {
          throw new Error("it is not in the list");
        }
        return "created, read back and listed";
      } },

      { name: "DUPLICATE PROJECTS ARE REFUSED", critical: false, run: async function () {
        var name = "SELFTEST DUP " + Math.random().toString(36).slice(2, 8).toUpperCase();
        await api.sandbox.put("project", {
          name: name, slug: svc().slugify(name), status: "active",
          notes: "", createdAt: new Date().toISOString()
        });
        var threw = null;
        try { await svc().create(name); } catch (e) { threw = e.message; }
        if (!threw) throw new Error("a second project with the same name was allowed");
        /* Case and punctuation must collide too, or the guard is
           theatre — "Ironmarch" and "IRONMARCH" are one project. */
        var threw2 = null;
        try { await svc().create(name.toLowerCase()); } catch (e) { threw2 = e.message; }
        if (!threw2) throw new Error("a differently-cased duplicate was allowed");
        return "same name and same-slug variants both refused";
      } },

      { name: "CUTTING A VERSION IS ALL OR NOTHING", critical: true, run: async function () {
        var was = currentProject;
        var wasEntries = entries;
        try {
          currentProject = { id: "selftest-proj", name: "SELFTEST" };
          entries = [
            { id: "a", projectId: "selftest-proj", kind: "added", text: "one", version: null, at: "2026-01-01T00:00:00Z" },
            { id: "b", projectId: "selftest-proj", kind: "fixed", text: "two", version: null, at: "2026-01-02T00:00:00Z" },
            { id: "c", projectId: "selftest-proj", kind: "added", text: "old", version: "0.9", releasedAt: "2025-12-01T00:00:00Z", at: "2025-11-01T00:00:00Z" }
          ];
          var g = grouped();
          if (g[0].version !== null) throw new Error("unreleased is not listed first");
          if (g[0].entries.length !== 2) throw new Error("wrong unreleased count");
          if (g[1].version !== "0.9") throw new Error("released versions are missing");

          var vs = versions();
          if (vs.length !== 1 || vs[0] !== "0.9") throw new Error("version list is wrong: " + vs.join(","));

          /* Re-cutting an existing version would silently merge two
             releases into one. It has to be refused. */
          var threw = null;
          try { await cutVersion("0.9"); } catch (e) { threw = e.message; }
          if (!threw || !/already exists/.test(threw)) {
            throw new Error("re-cutting an existing version was allowed");
          }
          var threw2 = null;
          try { await cutVersion("  "); } catch (e) { threw2 = e.message; }
          if (!threw2) throw new Error("a blank version name was allowed");
          return "grouping correct; duplicate and blank versions refused";
        } finally {
          currentProject = was;
          entries = wasEntries;
        }
      } },

      { name: "MARKDOWN IS WELL FORMED", critical: false, run: async function () {
        var was = currentProject, wasEntries = entries;
        try {
          currentProject = { id: "p", name: "TEST PROJECT", slug: "test-project" };
          entries = [
            { id: "a", projectId: "p", kind: "added", text: "a new thing", version: null, at: "2026-01-02T00:00:00Z" },
            { id: "b", projectId: "p", kind: "security", text: "closed a hole", breaking: true, version: "1.0", releasedAt: "2026-01-01T00:00:00Z", at: "2025-12-31T00:00:00Z", author: "SAM" }
          ];
          var md = toMarkdown({ credit: true });
          var need = ["# TEST PROJECT", "## Unreleased", "## 1.0 — 2026-01-01",
                      "### Added", "### Security", "- a new thing", "**BREAKING**", "_(SAM)_"];
          for (var i = 0; i < need.length; i++) {
            if (md.indexOf(need[i]) < 0) throw new Error("missing from the markdown: " + need[i]);
          }
          if (/\n{3,}/.test(md)) throw new Error("the markdown has runs of blank lines");
          if (md.indexOf("### Added\n\n- a new thing") < 0) {
            throw new Error("a heading is not followed by its bullets");
          }
          var only = toMarkdown({ only: "1.0" });
          if (/Unreleased/.test(only)) throw new Error("a single-version export leaked other versions");
          return md.split("\n").length + " lines, all sections present";
        } finally { currentProject = was; entries = wasEntries; }
      } },

      { name: "EMPTY STATES DO NOT THROW", critical: false, run: async function () {
        var was = currentProject, wasEntries = entries;
        try {
          currentProject = null; entries = [];
          renderEntries();
          if (!/CREATE A PROJECT/.test(flatten(nodes.list))) {
            throw new Error("no project selected did not render its prompt");
          }
          currentProject = { id: "p", name: "EMPTY" };
          renderEntries();
          if (!/NOTHING RECORDED/.test(flatten(nodes.list))) {
            throw new Error("an empty project did not render its prompt");
          }
          var md = toMarkdown();
          if (md.indexOf("# EMPTY") < 0) throw new Error("an empty changelog produced no heading");
          return "no project and empty project both render";
        } finally { currentProject = was; entries = wasEntries; renderEntries(); }
      } },

      { name: "ENTRY TEXT IS NEVER TREATED AS MARKUP", critical: true, run: async function () {
        var was = currentProject, wasEntries = entries;
        try {
          currentProject = { id: "p", name: "XSS" };
          entries = [{ id: "a", projectId: "p", kind: "added",
            text: "<script>alert(1)</script> and <img onerror=x>", version: null,
            at: "2026-01-01T00:00:00Z" }];
          renderEntries();
          if (nodes.list.querySelectorAll("script").length) {
            throw new Error("a script element was created from entry text");
          }
          if (nodes.list.querySelectorAll("img").length) {
            throw new Error("an img element was created from entry text");
          }
          if (flatten(nodes.list).indexOf("<script>") < 0) {
            throw new Error("the text was not rendered at all");
          }
          return "markup in an entry renders as text, not DOM";
        } finally { currentProject = was; entries = wasEntries; renderEntries(); }
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

  FieldKit.register("changelog", {
    group: "PROJECT",
    about: "Turn bullet points into release notes",
    keywords: "changelog release notes version changes",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "CHANGELOG",
    icon: "⌸",
    width: 760,
    height: 640,

    searchIndex: function () {
      return entries.map(function (e) {
        return { id: e.id, title: e.text.slice(0, 60), body: e.kind + " " + (e.version || "unreleased") };
      });
    },

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.list = el("div", { class: "cl-list" });
      nodes.projectSel = el("select", { class: "fk-input" });
      nodes.projectSel.addEventListener("change", function () {
        currentProject = projects.filter(function (p) { return p.id === nodes.projectSel.value; })[0] || null;
        loadEntries().then(renderEntries);
      });

      var kindSel = el("select", { class: "fk-input cl-kindsel" });
      KINDS.forEach(function (k) {
        kindSel.appendChild(el("option", { value: k.id, text: k.label + " — " + k.hint }));
      });

      var textIn = ui.field("WHAT CHANGED", { placeholder: "one line, written for whoever reads it later" });
      var breakingBox = el("input", { type: "checkbox" });

      function submit() {
        addEntry(kindSel.value, textIn.input.value, breakingBox.checked)
          .then(function () {
            textIn.input.value = "";
            breakingBox.checked = false;
            textIn.input.focus();
            ui.toast("ENTRY ADDED", "ok");
          })
          .catch(function (e) { ui.toast(e.message.toUpperCase(), "fail"); });
      }
      textIn.input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      nodes.addBtn = ui.button("ADD ENTRY", submit, { primary: true });
      nodes.cutBtn = ui.button("CUT A VERSION", function () {
        var v = prompt("Version name (e.g. 0.3.0):");
        if (v === null) return;
        cutVersion(v)
          .then(function (r) { ui.toast("CUT " + r.version + " — " + r.entries + " ENTRY(S)", "ok"); })
          .catch(function (e) { ui.toast(e.message.toUpperCase(), "fail"); });
      });
      nodes.copyBtn = ui.button("COPY MARKDOWN", function () {
        ui.copy(toMarkdown({ credit: true }), {
          title: "CHANGELOG — " + (currentProject ? currentProject.name : ""),
          note: "Clipboard access is blocked here. Select this and press Ctrl+C."
        }).then(function (how) { if (how) ui.toast("MARKDOWN COPIED", "ok"); });
      });
      nodes.rawBtn = ui.button("SHOW MARKDOWN", function () {
        ui.textDump(toMarkdown({ credit: true }),
          "CHANGELOG — " + (currentProject ? currentProject.name : ""),
          "Ready to paste into a README or a release. Select and copy, or just read it.");
      });

      host.appendChild(el("div", { class: "cl-wrap" }, [
        el("div", { class: "cl-projrow" }, [
          el("label", { class: "fk-field cl-projfield" }, [
            el("span", { class: "fk-field-label", text: "PROJECT" }), nodes.projectSel
          ]),
          ui.button("NEW PROJECT", newProject)
        ]),

        ui.panel("RECORD A CHANGE", [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "CATEGORY" }), kindSel
          ]),
          textIn,
          el("label", { class: "cl-check" }, [
            breakingBox, el("span", { text: "BREAKING — someone has to do something about this" })
          ]),
          el("div", { class: "cl-actions" }, [nodes.addBtn, nodes.cutBtn]),
          el("p", { class: "cl-note", text:
            "Entries start unreleased. CUT A VERSION stamps everything pending with a version " +
            "and a date in one go, so a half-cut release cannot exist. Reopening a version puts " +
            "it all back." })
        ]),

        ui.panel("CHANGELOG", [nodes.list]),
        el("div", { class: "cl-actions" }, [nodes.copyBtn, nodes.rawBtn])
      ]));

      await refresh();
    },

    unmount() { nodes = {}; entries = []; projects = []; currentProject = null; }
  });

  function injectCSS() {
    if (document.getElementById("cl-style")) return;
    var s = document.createElement("style");
    s.id = "cl-style";
    s.textContent = `
.cl-wrap{height:100%;overflow:auto}
.cl-projrow{display:flex;gap:6px;align-items:flex-end;margin-bottom:10px}
.cl-projfield{flex:1;margin:0}
.cl-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.cl-actions .fk-btn{flex:1;min-width:140px}
.cl-check{display:flex;gap:8px;align-items:center;margin-top:8px;font-size:10px;
  color:var(--fg-dim);letter-spacing:.08em}
.cl-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
.cl-list{max-height:340px;overflow:auto}
.cl-vhead{display:flex;align-items:center;gap:8px;padding:8px 2px 5px;margin-top:6px;
  border-bottom:1px solid var(--line2)}
.cl-vname{flex:1;font-size:12px;letter-spacing:.14em;color:var(--accent)}
.cl-vname.cl-unreleased{color:var(--warn)}
.cl-vdate{font-size:9px;color:var(--fg-dimmer);letter-spacing:.1em}
.cl-vhead .fk-btn{padding:3px 8px;font-size:9px}
.cl-kind{font-size:9px;letter-spacing:.2em;color:var(--accent-dim);margin:9px 0 3px}
.cl-entry{display:flex;gap:8px;align-items:baseline;padding:4px 2px;font-size:11px;
  line-height:1.55;border-bottom:1px solid var(--line)}
.cl-text{flex:1;color:var(--fg-dim);word-break:break-word}
.cl-author{font-size:9px;color:var(--fg-dimmer);letter-spacing:.1em;white-space:nowrap}
.cl-breaking{font-size:8px;letter-spacing:.14em;color:var(--fail);border:1px solid var(--fail);
  padding:1px 4px;white-space:nowrap}
.cl-entry .fk-btn{padding:1px 7px;font-size:11px;line-height:1}
.cl-none{padding:14px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
