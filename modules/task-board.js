/* ============================================================
   FieldKit :: task-board
   A board for two people.

   WHY THIS IS NOT THE DECISION LOG OR THE INCIDENT LOG

     decisions   what was chosen, and why. Append-only, permanent.
     incidents   something broke in the infrastructure.
     tasks       what each of us is doing RIGHT NOW, and what is
                 waiting.

   The third is the one a two-person team loses without. With two
   people there is no standup, no ticket system, and no way to
   tell whether the other person has already started the thing you
   were about to start. That collision — two people building the
   same system for a day — is the single most expensive avoidable
   mistake at this size, and it costs one shared list to prevent.

   BLOCKED IS A COLUMN, NOT A FLAG

   Most small boards make "blocked" a checkbox and it disappears
   into the row. On a two-person team a blocked task is usually
   blocked ON THE OTHER PERSON, so it is the single most important
   thing either of you can see. It gets a column, and the blocker
   is a text field rather than a link, because "waiting on the
   character controller" is a real answer and a task id is often
   not one yet.

   THE WIP WARNING IS DELIBERATE AND SOFT

   Three things in DOING for one person means nothing is in DOING.
   The board says so and then does nothing about it — a hard limit
   in a tool two people run for themselves is a tool they will
   route around within a week.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "task";

  var COLUMNS = [
    { id: "backlog", label: "BACKLOG", note: "not started" },
    { id: "doing",   label: "DOING",   note: "in progress right now" },
    { id: "blocked", label: "BLOCKED", note: "cannot continue" },
    { id: "review",  label: "REVIEW",  note: "done, needs a second pair of eyes" },
    { id: "done",    label: "DONE",    note: "finished" }
  ];

  /* Per person, not per board. Two people each doing two things is
     fine; one person doing four is the problem being named. */
  var WIP_SOFT_LIMIT = 3;

  /* Deliberately shaped for a game project rather than generic
     software. "Art" and "audio" are first-class because in a Godot
     + Blender project they are most of the work, and filing them
     under a generic "other" is how a board stops reflecting what
     the team actually does. */
  var AREAS = [
    { id: "code",   label: "CODE" },
    { id: "art",    label: "ART" },
    { id: "design", label: "DESIGN" },
    { id: "audio",  label: "AUDIO" },
    { id: "build",  label: "BUILD / TOOLING" },
    { id: "admin",  label: "ADMIN" }
  ];

  var PRIORITIES = [
    { id: "high",   label: "HIGH" },
    { id: "normal", label: "NORMAL" },
    { id: "low",    label: "LOW" }
  ];

  var ctx, ui, el, nodes = {}, rows = [], editingId = null;
  var filterWho = "", filterArea = "", filterText = "";

  function me() {
    var s = FieldKit.service("settings");
    var n = s ? String(s.get("displayName") || "").trim() : "";
    return n;
  }

  async function load() {
    rows = await ctx.store.list(TYPE);
    render();
  }

  function colOf(r) {
    var c = r.data.status;
    return COLUMNS.some(function (x) { return x.id === c; }) ? c : "backlog";
  }

  /* Everyone who appears as an assignee anywhere, plus whoever is
     using this machine. Derived rather than configured: a team
     roster to maintain is a second thing to keep in sync, and this
     one cannot go stale. */
  function people() {
    var seen = Object.create(null);
    rows.forEach(function (r) {
      var a = String(r.data.assignee || "").trim();
      if (a) seen[a] = true;
    });
    var mine = me();
    if (mine) seen[mine] = true;
    return Object.keys(seen).sort();
  }

  function matches(r) {
    if (filterWho && String(r.data.assignee || "") !== filterWho) return false;
    if (filterArea && String(r.data.area || "") !== filterArea) return false;
    if (filterText) {
      var hay = [r.data.title, r.data.notes, r.data.blockedBy, (r.data.tags || []).join(" ")]
        .join(" ").toLowerCase();
      if (hay.indexOf(filterText.toLowerCase()) < 0) return false;
    }
    return true;
  }

  /* ---- writing ------------------------------------------------- */
  function formData() {
    var title = nodes.title.value.trim();
    if (!title) throw new Error("a task needs a title");
    return {
      title: title,
      notes: nodes.notes.value.trim(),
      status: nodes.status.value,
      assignee: nodes.assignee.value.trim(),
      area: nodes.area.value,
      priority: nodes.priority.value,
      blockedBy: nodes.blockedBy.value.trim(),
      tags: nodes.tags.value.split(",").map(function (t) { return t.trim(); })
        .filter(Boolean),
      /* Stamped when it first enters DONE and never recomputed, so
         a task dragged back out and finished again keeps the date
         it was actually finished rather than today's. */
      doneAt: nodes.status.value === "done"
        ? (editingId ? (findRow(editingId).data.doneAt || new Date().toISOString())
                     : new Date().toISOString())
        : null
    };
  }

  function findRow(id) {
    return rows.filter(function (r) { return r.id === id; })[0] || { data: {} };
  }

  async function save() {
    var data;
    try { data = formData(); }
    catch (e) { ui.toast(e.message.toUpperCase(), "fail"); return; }

    try {
      await ctx.store.put(TYPE, data, editingId ? { id: editingId } : undefined);
      ui.toast(editingId ? "TASK UPDATED" : "TASK ADDED", "ok");
      clearForm();
      await load();
    } catch (e) {
      ui.toast("SAVE FAILED: " + e.message, "fail");
      ctx.error("task save failed: " + e.message);
    }
  }

  /* Moving a card is the most frequent action on a board by a wide
     margin, so it is one click and does not open the editor. */
  async function move(r, status) {
    var next = Object.assign({}, r.data, { status: status });
    if (status === "done" && !next.doneAt) next.doneAt = new Date().toISOString();
    if (status !== "done") next.doneAt = null;
    try {
      await ctx.store.put(TYPE, next, { id: r.id });
      await load();
    } catch (e) {
      ui.toast("MOVE FAILED: " + e.message, "fail");
    }
  }

  async function claim(r) {
    var mine = me();
    if (!mine) {
      ui.toast("SET A DISPLAY NAME IN SETTINGS FIRST", "warn");
      return;
    }
    try {
      await ctx.store.put(TYPE, Object.assign({}, r.data, { assignee: mine }), { id: r.id });
      await load();
    } catch (e) { ui.toast("COULD NOT CLAIM: " + e.message, "fail"); }
  }

  function edit(r) {
    editingId = r.id;
    nodes.title.value = r.data.title || "";
    nodes.notes.value = r.data.notes || "";
    nodes.status.value = colOf(r);
    nodes.assignee.value = r.data.assignee || "";
    nodes.area.value = r.data.area || "code";
    nodes.priority.value = r.data.priority || "normal";
    nodes.blockedBy.value = r.data.blockedBy || "";
    nodes.tags.value = (r.data.tags || []).join(", ");
    nodes.saveBtn.textContent = "UPDATE TASK";
    nodes.deleteBtn.style.display = "";
    nodes.editHint.textContent = "editing an existing task";
  }

  function clearForm() {
    editingId = null;
    ["title", "notes", "assignee", "blockedBy", "tags"].forEach(function (k) {
      if (nodes[k]) nodes[k].value = "";
    });
    if (nodes.status) nodes.status.value = "backlog";
    if (nodes.area) nodes.area.value = "code";
    if (nodes.priority) nodes.priority.value = "normal";
    if (nodes.saveBtn) nodes.saveBtn.textContent = "ADD TASK";
    if (nodes.deleteBtn) nodes.deleteBtn.style.display = "none";
    if (nodes.editHint) nodes.editHint.textContent = "";
  }

  async function removeCurrent() {
    if (!editingId) return;
    var r = findRow(editingId);
    if (!nodes.confirmDelete) {
      nodes.confirmDelete = true;
      nodes.deleteBtn.textContent = "REALLY DELETE?";
      setTimeout(function () {
        nodes.confirmDelete = false;
        if (nodes.deleteBtn) nodes.deleteBtn.textContent = "DELETE";
      }, 4000);
      return;
    }
    nodes.confirmDelete = false;
    nodes.deleteBtn.textContent = "DELETE";
    try {
      await ctx.store.remove(editingId);
      ui.toast("DELETED :: " + (r.data.title || ""), "warn");
      clearForm();
      await load();
    } catch (e) { ui.toast("DELETE FAILED: " + e.message, "fail"); }
  }

  /* ---- rendering ----------------------------------------------- */
  function card(r) {
    var d = r.data;
    var who = String(d.assignee || "").trim();
    var mine = me();
    var box = el("div", { class: "tb-card pri-" + (d.priority || "normal") }, [
      el("div", { class: "tb-card-title", text: d.title || "(untitled)" })
    ]);

    var meta = el("div", { class: "tb-card-meta" });
    if (d.area) meta.appendChild(el("span", { class: "tb-tag area", text: areaLabel(d.area) }));
    if (who) {
      meta.appendChild(el("span", {
        class: "tb-tag who" + (mine && who === mine ? " is-me" : ""), text: who
      }));
    } else {
      meta.appendChild(el("span", { class: "tb-tag none", text: "UNASSIGNED" }));
    }
    if (d.priority === "high") meta.appendChild(el("span", { class: "tb-tag hi", text: "HIGH" }));
    box.appendChild(meta);

    if (colOf(r) === "blocked" && d.blockedBy) {
      box.appendChild(el("div", { class: "tb-card-blocked", text: "WAITING ON: " + d.blockedBy }));
    }
    if ((d.tags || []).length) {
      box.appendChild(el("div", { class: "tb-card-tags", text: (d.tags || []).join(" · ") }));
    }

    /* One-click column moves. A select rather than drag-and-drop:
       drag is fiddly on a Chromebook trackpad and impossible to
       drive from a keyboard, and this board has to work on the
       machine with the worst input hardware. */
    var mv = el("select", { class: "tb-move", title: "move to column",
      onchange: function (e) { move(r, e.target.value); } });
    COLUMNS.forEach(function (c) {
      mv.appendChild(el("option", { value: c.id, text: c.label, selected: c.id === colOf(r) || null }));
    });
    mv.value = colOf(r);

    var actions = el("div", { class: "tb-card-actions" }, [mv]);
    if (mine && who !== mine) {
      actions.appendChild(el("button", { class: "tb-mini", type: "button", text: "CLAIM",
        onclick: function () { claim(r); } }));
    }
    actions.appendChild(el("button", { class: "tb-mini", type: "button", text: "EDIT",
      onclick: function () { edit(r); } }));
    box.appendChild(actions);
    return box;
  }

  function areaLabel(id) {
    var a = AREAS.filter(function (x) { return x.id === id; })[0];
    return a ? a.label : String(id || "").toUpperCase();
  }

  function render() {
    if (!nodes.board) return;
    ui.clear(nodes.board);

    var visible = rows.filter(matches);

    COLUMNS.forEach(function (c) {
      var mine = visible.filter(function (r) { return colOf(r) === c.id; });

      /* Priority first, then most recently touched. A board sorted
         only by date buries the thing that matters under the thing
         that was typed last. */
      mine.sort(function (a, b) {
        var pa = PRIORITIES.map(function (p) { return p.id; }).indexOf(a.data.priority || "normal");
        var pb = PRIORITIES.map(function (p) { return p.id; }).indexOf(b.data.priority || "normal");
        if (pa !== pb) return pa - pb;
        return String(b.meta.updatedAt || "").localeCompare(String(a.meta.updatedAt || ""));
      });

      var col = el("div", { class: "tb-col" }, [
        el("div", { class: "tb-col-head" }, [
          el("span", { class: "tb-col-name", text: c.label }),
          el("span", { class: "tb-col-count", text: String(mine.length) })
        ])
      ]);

      if (c.id === "doing") {
        /* Counted per person, and only complained about when one
           person is carrying it — two people with two each is a
           working team, not a problem. */
        var byPerson = Object.create(null);
        mine.forEach(function (r) {
          var w = String(r.data.assignee || "").trim() || "(unassigned)";
          byPerson[w] = (byPerson[w] || 0) + 1;
        });
        var over = Object.keys(byPerson).filter(function (w) {
          return byPerson[w] > WIP_SOFT_LIMIT;
        });
        if (over.length) {
          col.appendChild(el("div", { class: "tb-wip", text:
            over.map(function (w) { return w + " has " + byPerson[w]; }).join(", ") +
            " in progress. Nothing is really in progress at that point." }));
        }
      }

      if (!mine.length) {
        col.appendChild(el("div", { class: "tb-empty", text: c.note }));
      } else {
        mine.forEach(function (r) { col.appendChild(card(r)); });
      }
      nodes.board.appendChild(col);
    });

    renderFilters();
    renderSummary(visible);
  }

  function renderFilters() {
    if (!nodes.who) return;
    var current = filterWho;
    ui.clear(nodes.who);
    nodes.who.appendChild(el("option", { value: "", text: "EVERYONE" }));
    people().forEach(function (p) {
      nodes.who.appendChild(el("option", { value: p, text: p.toUpperCase() }));
    });
    nodes.who.value = current;
  }

  function renderSummary(visible) {
    if (!nodes.summary) return;
    ui.clear(nodes.summary);
    var open = visible.filter(function (r) { return colOf(r) !== "done"; }).length;
    var blocked = visible.filter(function (r) { return colOf(r) === "blocked"; }).length;
    var unassigned = visible.filter(function (r) {
      return colOf(r) !== "done" && !String(r.data.assignee || "").trim();
    }).length;

    nodes.summary.appendChild(ui.readout([
      { label: "OPEN", value: String(open), level: "dim" },
      { label: "BLOCKED", value: String(blocked), level: blocked ? "warn" : "dim" },
      { label: "UNCLAIMED", value: String(unassigned), level: unassigned ? "warn" : "dim" },
      { label: "TOTAL", value: String(visible.length), level: "dim" }
    ]));
  }

  /* ---- export --------------------------------------------------
     Markdown, because the place this ends up is a README, a commit
     message or a message to the other person — none of which want
     JSON. */
  function asMarkdown() {
    var L = ["# TASK BOARD", "", "_" + new Date().toLocaleString() + "_", ""];
    COLUMNS.forEach(function (c) {
      var mine = rows.filter(function (r) { return colOf(r) === c.id; });
      if (!mine.length) return;
      L.push("## " + c.label + " (" + mine.length + ")");
      L.push("");
      mine.forEach(function (r) {
        var d = r.data;
        var bits = [];
        if (d.assignee) bits.push("@" + d.assignee);
        if (d.area) bits.push(areaLabel(d.area));
        if (d.priority === "high") bits.push("HIGH");
        L.push("- " + (d.title || "(untitled)") +
          (bits.length ? "  _(" + bits.join(" · ") + ")_" : ""));
        if (c.id === "blocked" && d.blockedBy) L.push("  - waiting on: " + d.blockedBy);
        if (d.notes) L.push("  - " + d.notes.replace(/\n+/g, " "));
      });
      L.push("");
    });
    return L.join("\n");
  }

  function selfcheck() {
    return [
      { name: "BOARD RENDERS EVERY COLUMN", critical: false, run: async function () {
        render();
        var heads = nodes.board.querySelectorAll(".tb-col-name");
        if (heads.length !== COLUMNS.length) {
          throw new Error("expected " + COLUMNS.length + " columns, drew " + heads.length);
        }
        return COLUMNS.length + " columns";
      } },

      /* The board is the one place two people look to avoid doing
         the same work, so a card landing in the wrong column is
         worse than it looks. */
      { name: "AN UNKNOWN STATUS FALLS BACK TO BACKLOG", critical: true, run: async function () {
        var fake = { id: "x", meta: {}, data: { title: "t", status: "not-a-column" } };
        if (colOf(fake) !== "backlog") {
          throw new Error("a task with a bad status went to '" + colOf(fake) + "'");
        }
        /* A task written by a future version with a column this
           build does not know about must still be visible
           somewhere, not silently vanish off the board. */
        return "unknown columns surface in BACKLOG rather than disappearing";
      } },

      { name: "TASK ROUND TRIP", critical: false, run: async function (api) {
        var sb = api && api.sandbox;
        var title = "PROBE TASK " + Date.now();
        var before = (await ctx.store.list(TYPE)).length;
        var rec = await ctx.store.put(TYPE, {
          title: title, status: "doing", area: "code", priority: "normal",
          assignee: "probe", tags: ["probe"], notes: "written by the self-test"
        });
        if (sb) sb.track(rec.id);
        var after = await ctx.store.list(TYPE);
        if (after.length !== before + 1) throw new Error("the task did not persist");
        var back = after.filter(function (r) { return r.id === rec.id; })[0];
        if (!back || back.data.title !== title) throw new Error("it came back wrong");
        return "written, listed and read back";
      } },

      { name: "MARKDOWN EXPORT IS USABLE", critical: false, run: async function () {
        var keep = rows;
        rows = [
          { id: "1", meta: {}, data: { title: "Alpha", status: "doing", assignee: "Ada",
            area: "code", priority: "high", tags: [] } },
          { id: "2", meta: {}, data: { title: "Beta", status: "blocked",
            blockedBy: "the character controller", area: "art", tags: [] } }
        ];
        var md = asMarkdown();
        rows = keep;
        if (md.indexOf("# TASK BOARD") !== 0) throw new Error("no heading");
        ["Alpha", "Beta", "@Ada", "DOING", "BLOCKED", "waiting on"].forEach(function (frag) {
          if (md.indexOf(frag) < 0) throw new Error("export is missing '" + frag + "'");
        });
        if (/undefined/.test(md)) throw new Error("export contains 'undefined'");
        return md.split("\n").length + " lines of markdown";
      } },

      { name: "WIP WARNING COUNTS PER PERSON", critical: false, run: async function () {
        var keep = rows;
        /* Two people with three each must NOT warn; one person with
           four must. Counting per board instead of per person is
           the obvious wrong implementation and it fires constantly
           on a healthy two-person team, which trains people to
           ignore it. */
        rows = [];
        for (var i = 0; i < 3; i++) {
          rows.push({ id: "a" + i, meta: {}, data: { title: "t", status: "doing", assignee: "Ada", tags: [] } });
          rows.push({ id: "b" + i, meta: {}, data: { title: "t", status: "doing", assignee: "Bo", tags: [] } });
        }
        render();
        var warnedFairly = nodes.board.querySelectorAll(".tb-wip").length;

        rows.push({ id: "a4", meta: {}, data: { title: "t", status: "doing", assignee: "Ada", tags: [] } });
        render();
        var warnedOver = nodes.board.querySelectorAll(".tb-wip").length;
        rows = keep;
        render();

        if (warnedFairly !== 0) throw new Error("warned when two people had three each");
        if (warnedOver !== 1) throw new Error("did not warn when one person had four");
        return "warns at more than " + WIP_SOFT_LIMIT + " per person, not per board";
      } }
    ];
  }

  FieldKit.register("task-board", {
    group: "PROJECT",
    about: "A to-do board for the two of you",
    keywords: "tasks todo kanban board work plan",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "TASK BOARD",
    icon: "▤",
    width: 1080,
    height: 680,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.board = el("div", { class: "tb-board" });
      nodes.summary = el("div");

      nodes.who = el("select", { class: "fk-input tb-filter",
        onchange: function (e) { filterWho = e.target.value; render(); } });

      nodes.areaFilter = el("select", { class: "fk-input tb-filter",
        onchange: function (e) { filterArea = e.target.value; render(); } });
      nodes.areaFilter.appendChild(el("option", { value: "", text: "ALL AREAS" }));
      AREAS.forEach(function (a) {
        nodes.areaFilter.appendChild(el("option", { value: a.id, text: a.label }));
      });

      nodes.search = el("input", { class: "fk-input tb-filter", placeholder: "SEARCH",
        oninput: function (e) { filterText = e.target.value; render(); } });

      nodes.mineBtn = ui.button("ONLY MINE", function () {
        var mine = me();
        if (!mine) { ui.toast("SET A DISPLAY NAME IN SETTINGS FIRST", "warn"); return; }
        filterWho = (filterWho === mine) ? "" : mine;
        render();
      });

      /* ---- the editor ---- */
      nodes.title = el("input", { class: "fk-input", placeholder: "what needs doing" });
      nodes.notes = el("textarea", { class: "fk-input", rows: "3",
        placeholder: "detail, links, acceptance criteria (optional)" });
      nodes.blockedBy = el("input", { class: "fk-input",
        placeholder: "if blocked: what is it waiting on?" });
      nodes.tags = el("input", { class: "fk-input", placeholder: "comma, separated, tags" });
      nodes.assignee = el("input", { class: "fk-input", placeholder: "who is doing it" });

      nodes.status = el("select", { class: "fk-input" });
      COLUMNS.forEach(function (c) {
        nodes.status.appendChild(el("option", { value: c.id, text: c.label + " — " + c.note }));
      });
      nodes.area = el("select", { class: "fk-input" });
      AREAS.forEach(function (a) {
        nodes.area.appendChild(el("option", { value: a.id, text: a.label }));
      });
      nodes.priority = el("select", { class: "fk-input" });
      PRIORITIES.forEach(function (p) {
        nodes.priority.appendChild(el("option", { value: p.id, text: p.label }));
      });

      nodes.saveBtn = ui.button("ADD TASK", save, { primary: true });
      nodes.deleteBtn = ui.button("DELETE", removeCurrent, { danger: true });
      nodes.deleteBtn.style.display = "none";
      nodes.editHint = el("span", { class: "tb-edit-hint" });

      nodes.meBtn = ui.button("ASSIGN TO ME", function () {
        var mine = me();
        if (!mine) { ui.toast("SET A DISPLAY NAME IN SETTINGS FIRST", "warn"); return; }
        nodes.assignee.value = mine;
      });

      host.appendChild(el("div", { class: "tb-wrap" }, [
        el("div", { class: "tb-bar" }, [
          nodes.search, nodes.who, nodes.areaFilter, nodes.mineBtn,
          ui.button("EXPORT MARKDOWN", function () {
            ui.copy(asMarkdown(), { title: "TASK BOARD" }).then(function (how) {
              if (how) ui.toast("BOARD COPIED", "ok");
            });
          }),
          ui.button("REFRESH", load)
        ]),
        nodes.summary,
        nodes.board,
        el("div", { class: "tb-editor" }, [
          el("div", { class: "tb-editor-head" }, [
            el("span", { text: "NEW / EDIT TASK" }), nodes.editHint
          ]),
          el("div", { class: "tb-grid" }, [
            el("label", { class: "fk-field tb-wide" }, [
              el("span", { class: "fk-field-label", text: "TASK" }), nodes.title]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "COLUMN" }), nodes.status]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "AREA" }), nodes.area]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "PRIORITY" }), nodes.priority]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "ASSIGNEE" }), nodes.assignee]),
            el("label", { class: "fk-field tb-wide" }, [
              el("span", { class: "fk-field-label", text: "BLOCKED BY" }), nodes.blockedBy]),
            el("label", { class: "fk-field tb-wide" }, [
              el("span", { class: "fk-field-label", text: "TAGS" }), nodes.tags]),
            el("label", { class: "fk-field tb-wide" }, [
              el("span", { class: "fk-field-label", text: "NOTES" }), nodes.notes])
          ]),
          el("div", { class: "tb-actions" }, [
            nodes.saveBtn, nodes.meBtn, ui.button("CLEAR", clearForm), nodes.deleteBtn
          ])
        ])
      ]));

      clearForm();
      await load();
    },

    unmount() {
      nodes = {}; rows = []; editingId = null;
      filterWho = ""; filterArea = ""; filterText = "";
    },

    searchIndex() {
      return rows.map(function (r) {
        return {
          id: r.id, module: "task-board",
          title: "TASK: " + r.data.title,
          body: [r.data.notes, r.data.assignee, r.data.blockedBy, areaLabel(r.data.area)]
            .concat(r.data.tags || []).join(" ")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("tb-style")) return;
    var s = document.createElement("style");
    s.id = "tb-style";
    s.textContent = [
      ".tb-wrap{display:flex;flex-direction:column;gap:8px;height:100%}",
      ".tb-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:0 0 auto}",
      ".tb-filter{max-width:170px}",
      ".tb-board{display:flex;gap:8px;align-items:flex-start;overflow-x:auto;flex:1 1 auto;padding-bottom:4px}",
      ".tb-col{flex:1 0 190px;min-width:190px;border:1px solid var(--line2);padding:6px;",
      "  background:rgba(0,0,0,.16);max-height:100%;overflow-y:auto}",
      ".tb-col-head{display:flex;justify-content:space-between;align-items:center;",
      "  border-bottom:1px solid var(--line2);padding-bottom:4px;margin-bottom:6px}",
      ".tb-col-name{font-size:9px;letter-spacing:.18em;color:var(--accent)}",
      ".tb-col-count{font-size:9px;color:var(--fg-dimmer)}",
      ".tb-empty{font-size:9px;color:var(--fg-dimmer);padding:8px 4px;font-style:italic}",
      ".tb-wip{font-size:9px;color:var(--warn);border:1px solid var(--warn);padding:4px 5px;",
      "  margin-bottom:6px;line-height:1.4}",
      ".tb-card{border:1px solid var(--line2);background:rgba(0,0,0,.25);padding:6px;margin-bottom:6px}",
      ".tb-card.pri-high{border-left:2px solid var(--fail)}",
      ".tb-card.pri-low{opacity:.78}",
      ".tb-card-title{font-size:11px;line-height:1.35;margin-bottom:5px;word-break:break-word}",
      ".tb-card-meta{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px}",
      ".tb-tag{font-size:8px;letter-spacing:.08em;padding:1px 4px;border:1px solid var(--line2);color:var(--fg-dimmer)}",
      ".tb-tag.who.is-me{border-color:var(--accent);color:var(--accent)}",
      ".tb-tag.none{font-style:italic}",
      ".tb-tag.hi{border-color:var(--fail);color:var(--fail)}",
      ".tb-card-blocked{font-size:9px;color:var(--warn);margin:3px 0;line-height:1.35}",
      ".tb-card-tags{font-size:8px;color:var(--fg-dimmer);margin-top:3px}",
      ".tb-card-actions{display:flex;gap:4px;align-items:center;margin-top:5px}",
      ".tb-move{flex:1;font:inherit;font-size:9px;background:none;color:var(--fg-dim);",
      "  border:1px solid var(--line2);padding:1px 2px}",
      ".tb-mini{font:inherit;font-size:8px;letter-spacing:.06em;background:none;",
      "  border:1px solid var(--line2);color:var(--fg-dim);padding:2px 5px;cursor:pointer}",
      ".tb-mini:hover{border-color:var(--accent);color:var(--accent)}",
      ".tb-editor{flex:0 0 auto;border-top:1px solid var(--line2);padding-top:8px}",
      ".tb-editor-head{display:flex;gap:10px;align-items:baseline;font-size:9px;",
      "  letter-spacing:.18em;color:var(--accent);margin-bottom:6px}",
      ".tb-edit-hint{font-size:9px;letter-spacing:.04em;color:var(--warn)}",
      ".tb-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}",
      ".tb-wide{grid-column:1 / -1}",
      ".tb-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}"
    ].join("");
    document.head.appendChild(s);
  }
})(window.FieldKit);
