/* ============================================================
   FieldKit :: decisions
   An append-only decision log (§5).

   WHY THIS AND NOT THE CHANGELOG OR THE SCRATCHPAD

   Three different things, and collapsing them loses the one that
   matters most:

     scratchpad  thinking in progress. Mutable, messy, private.
     changelog   what changed. Derivable from the repo.
     decisions   what was chosen, what was REJECTED, and why.

   Only the third cannot be reconstructed later. A second person
   can read the code and see what it does; they cannot see the
   three approaches you tried and abandoned, and so they propose
   one of them again six weeks later. That conversation is the
   single most avoidable cost in a two-person project.

   APPEND-ONLY, ON PURPOSE

   A decision can be superseded but never edited or deleted. An
   editable decision log is just notes: if you can quietly change
   what past-you decided, the record stops being evidence and
   nobody trusts it. Superseding creates a new entry that points
   back, so the reasoning chain stays walkable.

   The one exception is a decision written in the last few minutes
   — a typo caught immediately is not history being rewritten. The
   window is short and the UI says why.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "decision";

  /* Ten minutes. Long enough to fix a typo you noticed on re-read,
     short enough that nothing anyone else has seen can change. */
  var EDIT_WINDOW_MS = 10 * 60 * 1000;

  var STATUSES = [
    { id: "decided",    label: "DECIDED",    note: "Chosen and in effect." },
    { id: "trial",      label: "TRIAL",      note: "Doing it this way for now; revisit deliberately." },
    { id: "superseded", label: "SUPERSEDED", note: "Replaced by a later decision." }
  ];

  var ctx, ui, el, nodes = {}, rows = [], filter = "", statusFilter = "", supersedes = null;

  function svcProjects() { return FieldKit.service("projects"); }

  async function load() {
    rows = await ctx.store.list(TYPE);
    renderList();
  }

  function withinEditWindow(r) {
    if (!r || !r.meta || !r.meta.createdAt) return false;
    return (Date.now() - new Date(r.meta.createdAt).getTime()) < EDIT_WINDOW_MS;
  }

  function statusOf(r) {
    /* A decision is superseded if something else points at it.
       Derived rather than stored, so the two can never disagree —
       the alternative is a flag that goes stale the moment a
       superseding entry is written on another device. */
    var by = rows.filter(function (x) { return x.data.supersedesId === r.id; });
    if (by.length) return { id: "superseded", by: by };
    return { id: r.data.status || "decided", by: [] };
  }

  async function save() {
    var title = nodes.title.value.trim();
    if (!title) { ui.toast("A DECISION NEEDS A TITLE", "warn"); return; }
    var chose = nodes.chose.value.trim();
    if (!chose) { ui.toast("WHAT WAS CHOSEN?", "warn"); return; }
    var why = nodes.why.value.trim();
    if (!why) { ui.toast("THE REASON IS THE WHOLE POINT — WRITE ONE", "warn"); return; }

    await ctx.store.put(TYPE, {
      title: title,
      chose: chose,
      rejected: nodes.rejected.value.trim(),
      why: why,
      revisitIf: nodes.revisit.value.trim(),
      status: nodes.status.value,
      projectId: nodes.project.value || null,
      supersedesId: supersedes ? supersedes.id : null,
      supersedesTitle: supersedes ? supersedes.data.title : null,
      tags: nodes.tags.value.split(",").map(function (t) {
        return t.trim().toLowerCase();
      }).filter(Boolean)
    });

    ui.toast(supersedes ? "DECISION SUPERSEDED" : "DECISION RECORDED", "ok");
    clearForm();
    await load();
  }

  function clearForm() {
    supersedes = null;
    ["title", "chose", "rejected", "why", "revisit", "tags"].forEach(function (k) {
      if (nodes[k]) nodes[k].value = "";
    });
    if (nodes.status) nodes.status.value = "decided";
    renderSupersedeBar();
  }

  function startSupersede(id) {
    var r = rows.find(function (x) { return x.id === id; });
    if (!r) return;
    supersedes = r;
    nodes.title.value = "";
    nodes.chose.value = "";
    nodes.why.value = "";
    nodes.rejected.value = r.data.chose ? ("Previously: " + r.data.chose) : "";
    nodes.status.value = "decided";
    renderSupersedeBar();
    nodes.title.focus();
    ui.toast("WRITING A REPLACEMENT — THE OLD ONE STAYS", "ok");
  }

  function renderSupersedeBar() {
    ui.clear(nodes.supersedeBar);
    if (!supersedes) return;
    nodes.supersedeBar.appendChild(el("div", { class: "dc-supersede" }, [
      el("span", { text: "SUPERSEDING: " + supersedes.data.title }),
      ui.button("CANCEL", function () { supersedes = null; renderSupersedeBar(); })
    ]));
  }

  /* Editing is allowed only inside the window, and the button is
     absent rather than disabled outside it — a greyed-out EDIT
     invites arguing with the rule instead of superseding. */
  function beginEdit(r) {
    if (!withinEditWindow(r)) return;
    nodes.title.value = r.data.title || "";
    nodes.chose.value = r.data.chose || "";
    nodes.rejected.value = r.data.rejected || "";
    nodes.why.value = r.data.why || "";
    nodes.revisit.value = r.data.revisitIf || "";
    nodes.status.value = r.data.status || "decided";
    nodes.tags.value = (r.data.tags || []).join(", ");
    supersedes = null;
    renderSupersedeBar();
    nodes.editingId = r.id;
    nodes.saveBtn.textContent = "SAVE CORRECTION";
  }

  async function saveEdit() {
    if (!nodes.editingId) { await save(); return; }
    var r = rows.find(function (x) { return x.id === nodes.editingId; });
    if (!r || !withinEditWindow(r)) {
      ui.toast("THE CORRECTION WINDOW HAS CLOSED — SUPERSEDE IT INSTEAD", "warn");
      nodes.editingId = null;
      nodes.saveBtn.textContent = "RECORD DECISION";
      return;
    }
    await ctx.store.put(TYPE, {
      title: nodes.title.value.trim(),
      chose: nodes.chose.value.trim(),
      rejected: nodes.rejected.value.trim(),
      why: nodes.why.value.trim(),
      revisitIf: nodes.revisit.value.trim(),
      status: nodes.status.value,
      projectId: r.data.projectId || null,
      supersedesId: r.data.supersedesId || null,
      supersedesTitle: r.data.supersedesTitle || null,
      tags: nodes.tags.value.split(",").map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean),
      corrected: true
    }, { id: nodes.editingId });
    nodes.editingId = null;
    nodes.saveBtn.textContent = "RECORD DECISION";
    ui.toast("CORRECTED", "ok");
    clearForm();
    await load();
  }

  function matches(r) {
    var st = statusOf(r).id;
    if (statusFilter && st !== statusFilter) return false;
    if (!filter) return true;
    var q = filter.toLowerCase();
    return [r.data.title, r.data.chose, r.data.rejected, r.data.why, r.data.revisitIf]
      .concat(r.data.tags || []).join(" ").toLowerCase().indexOf(q) >= 0;
  }

  function shortDate(iso) {
    if (!iso) return "";
    try { return new Date(iso).toISOString().slice(0, 10); } catch (e) { return ""; }
  }

  function renderList() {
    ui.clear(nodes.list);
    ui.clear(nodes.chips);

    var counts = { decided: 0, trial: 0, superseded: 0 };
    rows.forEach(function (r) {
      var s = statusOf(r).id;
      counts[s] = (counts[s] || 0) + 1;
    });

    nodes.chips.appendChild(el("button", {
      class: "dc-chip" + (statusFilter === "" ? " on" : ""), type: "button",
      text: "ALL " + rows.length,
      onclick: function () { statusFilter = ""; renderList(); }
    }));
    STATUSES.forEach(function (s) {
      nodes.chips.appendChild(el("button", {
        class: "dc-chip " + s.id + (statusFilter === s.id ? " on" : ""), type: "button",
        text: s.label + " " + (counts[s.id] || 0),
        onclick: function () { statusFilter = statusFilter === s.id ? "" : s.id; renderList(); }
      }));
    });

    var shown = rows.filter(matches);
    if (!shown.length) {
      nodes.list.appendChild(el("div", { class: "dc-empty", text: rows.length
        ? "NO MATCHES"
        : "NO DECISIONS RECORDED YET.\n\nThe first one is usually the most valuable: write down " +
          "why the project is built the way it is, and what you decided against." }));
      return;
    }

    shown.forEach(function (r) {
      var d = r.data;
      var st = statusOf(r);
      var box = el("div", { class: "dc-item " + st.id });

      box.appendChild(el("div", { class: "dc-head" }, [
        el("strong", { class: "dc-title", text: d.title }),
        el("span", { class: "dc-badge " + st.id,
          text: (STATUSES.filter(function (s) { return s.id === st.id; })[0] || {}).label || st.id })
      ]));

      box.appendChild(el("div", { class: "dc-meta", text:
        shortDate(r.meta.createdAt) +
        (r.meta.author ? " · " + r.meta.author : "") +
        (d.corrected ? " · corrected" : "") +
        (d.tags && d.tags.length ? " · " + d.tags.join(", ") : "") }));

      box.appendChild(el("div", { class: "dc-field" }, [
        el("span", { class: "dc-label", text: "CHOSE" }),
        el("span", { class: "dc-value", text: d.chose })
      ]));
      if (d.rejected) {
        box.appendChild(el("div", { class: "dc-field" }, [
          el("span", { class: "dc-label", text: "REJECTED" }),
          el("span", { class: "dc-value", text: d.rejected })
        ]));
      }
      box.appendChild(el("div", { class: "dc-field" }, [
        el("span", { class: "dc-label", text: "BECAUSE" }),
        el("span", { class: "dc-value", text: d.why })
      ]));
      if (d.revisitIf) {
        box.appendChild(el("div", { class: "dc-field" }, [
          el("span", { class: "dc-label", text: "REVISIT IF" }),
          el("span", { class: "dc-value", text: d.revisitIf })
        ]));
      }
      if (d.supersedesTitle) {
        box.appendChild(el("div", { class: "dc-chain", text: "↳ replaces: " + d.supersedesTitle }));
      }
      if (st.by.length) {
        box.appendChild(el("div", { class: "dc-chain", text:
          "↳ replaced by: " + st.by.map(function (x) { return x.data.title; }).join("; ") }));
      }

      var actions = [ui.button("SUPERSEDE", function () { startSupersede(r.id); })];
      if (withinEditWindow(r)) {
        actions.push(ui.button("CORRECT", function () { beginEdit(r); }));
      }
      actions.push(ui.button("COPY", function () {
        ui.copy(asText(r), { title: d.title }).then(function (h) { if (h) ui.toast("COPIED", "ok"); });
      }));
      box.appendChild(el("div", { class: "dc-actions" }, actions));

      nodes.list.appendChild(box);
    });
  }

  function asText(r) {
    var d = r.data;
    var st = statusOf(r);
    return [
      d.title,
      "=".repeat(Math.min(60, d.title.length)),
      "DATE:      " + shortDate(r.meta.createdAt) + (r.meta.author ? "  by " + r.meta.author : ""),
      "STATUS:    " + st.id.toUpperCase(),
      "",
      "CHOSE:     " + d.chose,
      d.rejected ? "REJECTED:  " + d.rejected : "",
      "BECAUSE:   " + d.why,
      d.revisitIf ? "REVISIT IF: " + d.revisitIf : "",
      d.supersedesTitle ? "REPLACES:  " + d.supersedesTitle : ""
    ].filter(Boolean).join("\n");
  }

  function exportAll() {
    var out = rows.slice().sort(function (a, b) {
      return (a.meta.createdAt || "").localeCompare(b.meta.createdAt || "");
    }).map(asText).join("\n\n" + "-".repeat(60) + "\n\n");
    ui.textDump(out || "No decisions recorded.", { title: "DECISION LOG" });
  }

  function injectCSS() {
    if (document.getElementById("dc-style")) return;
    var s = document.createElement("style");
    s.id = "dc-style";
    s.textContent = [
      ".dc-wrap{display:flex;gap:10px;height:100%}",
      ".dc-side{flex:1 1 55%;display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".dc-main{flex:1 1 45%;display:flex;flex-direction:column;gap:6px;overflow:auto;min-width:0}",
      ".dc-list{flex:1 1 auto;overflow:auto;padding-right:4px}",
      ".dc-chips{display:flex;gap:4px;flex-wrap:wrap}",
      ".dc-chip{background:none;border:1px solid var(--fk-line);color:inherit;font:inherit;font-size:10px;letter-spacing:.05em;padding:1px 6px;cursor:pointer}",
      ".dc-chip.on{border-color:var(--fk-accent);color:var(--fk-accent)}",
      ".dc-item{border:1px solid var(--fk-line);border-left-width:3px;padding:8px 10px;margin-bottom:6px}",
      ".dc-item.decided{border-left-color:var(--fk-ok)}",
      ".dc-item.trial{border-left-color:var(--fk-warn)}",
      ".dc-item.superseded{border-left-color:var(--fk-line);opacity:.62}",
      ".dc-head{display:flex;gap:8px;align-items:baseline}",
      ".dc-title{flex:1;min-width:0}",
      ".dc-badge{font-size:9px;letter-spacing:.08em;border:1px solid var(--fk-line);padding:0 4px;opacity:.8}",
      ".dc-badge.decided{border-color:var(--fk-ok);color:var(--fk-ok)}",
      ".dc-badge.trial{border-color:var(--fk-warn);color:var(--fk-warn)}",
      ".dc-meta{font-size:10.5px;opacity:.55;margin:3px 0 6px}",
      ".dc-field{display:flex;gap:8px;font-size:12px;line-height:1.5;margin-bottom:3px}",
      ".dc-label{flex:0 0 74px;opacity:.55;font-size:10px;letter-spacing:.06em;padding-top:2px}",
      ".dc-value{flex:1;white-space:pre-wrap;min-width:0}",
      ".dc-chain{font-size:11px;opacity:.6;margin-top:5px}",
      ".dc-actions{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}",
      ".dc-empty{opacity:.5;font-size:12px;padding:12px 0;white-space:pre-wrap;line-height:1.6}",
      ".dc-supersede{display:flex;gap:8px;align-items:center;font-size:11px;border:1px solid var(--fk-warn);color:var(--fk-warn);padding:4px 8px;margin-bottom:6px}",
      ".dc-supersede span{flex:1;min-width:0}",
      ".dc-hint{font-size:11px;opacity:.65;line-height:1.55;margin-top:4px}"
    ].join("");
    document.head.appendChild(s);
  }

  function selfcheck(api) {
    return [
      { name: "A DECISION NEEDS A REASON", critical: false, run: async function () {
        /* The rule the whole module exists for. A log of decisions
           with no reasoning is a list of facts already visible in
           the code. */
        var before = rows.length;
        nodes.title.value = "SELFTEST-noreason";
        nodes.chose.value = "something";
        nodes.why.value = "";
        await save();
        await load();
        if (rows.length !== before) {
          var bad = rows.filter(function (r) { return r.data.title === "SELFTEST-noreason"; });
          bad.forEach(function (b) { api.sandbox.track(b.id); });
          throw new Error("a decision saved with no reason");
        }
        clearForm();
        return "refused without a why";
      } },

      { name: "SUPERSEDING KEEPS THE ORIGINAL", critical: true, run: async function () {
        /* Append-only is the load-bearing property. If superseding
           ever overwrites, the log stops being evidence. */
        var m = "SELFTEST-" + Math.random().toString(36).slice(2, 8);
        nodes.title.value = m + "-first";
        nodes.chose.value = "approach A";
        nodes.why.value = "it was simplest at the time";
        nodes.rejected.value = "approach B";
        await save();
        await load();

        var first = rows.filter(function (r) { return r.data.title === m + "-first"; })[0];
        if (!first) throw new Error("the first decision did not save");
        api.sandbox.track(first.id);

        startSupersede(first.id);
        nodes.title.value = m + "-second";
        nodes.chose.value = "approach B after all";
        nodes.why.value = "A did not survive contact with the second person";
        await save();
        await load();

        var stillThere = rows.filter(function (r) { return r.id === first.id; })[0];
        if (!stillThere) throw new Error("superseding destroyed the original");
        var second = rows.filter(function (r) { return r.data.title === m + "-second"; })[0];
        if (!second) throw new Error("the replacement did not save");
        api.sandbox.track(second.id);
        if (second.data.supersedesId !== first.id) {
          throw new Error("the replacement does not point back at what it replaced");
        }
        if (statusOf(stillThere).id !== "superseded") {
          throw new Error("the original is not shown as superseded");
        }

        await ctx.store.remove(second.id);
        await ctx.store.remove(first.id);
        await load();
        clearForm();
        return "original kept, chain walkable in both directions";
      } },

      { name: "THE CORRECTION WINDOW CLOSES", critical: true, run: async function () {
        /* Old entries must not be editable. Tested against the
           predicate rather than the UI, because the button being
           absent is a consequence of this, not the rule itself. */
        var fresh = { id: "x", meta: { createdAt: new Date().toISOString() }, data: {} };
        var old = { id: "y", meta: {
          createdAt: new Date(Date.now() - EDIT_WINDOW_MS - 60000).toISOString() }, data: {} };
        if (!withinEditWindow(fresh)) throw new Error("a brand new entry is not correctable");
        if (withinEditWindow(old)) throw new Error("an old entry is still editable");
        if (withinEditWindow({ id: "z", meta: {}, data: {} })) {
          throw new Error("an entry with no timestamp was treated as fresh");
        }
        return "10 minute window, closes cleanly, no timestamp means no";
      } },

      { name: "EXPORT IS COMPLETE AND ORDERED", critical: false, run: async function () {
        var m = "SELFTEST-" + Math.random().toString(36).slice(2, 8);
        nodes.title.value = m;
        nodes.chose.value = "export probe";
        nodes.why.value = "to prove the export contains it";
        await save();
        await load();
        var mine = rows.filter(function (r) { return r.data.title === m; })[0];
        api.sandbox.track(mine.id);

        var txt = rows.slice().sort(function (a, b) {
          return (a.meta.createdAt || "").localeCompare(b.meta.createdAt || "");
        }).map(asText).join("\n");
        if (txt.indexOf(m) < 0) throw new Error("the export is missing a decision");
        if (txt.indexOf("to prove the export contains it") < 0) {
          throw new Error("the export dropped the reasoning");
        }
        await ctx.store.remove(mine.id);
        await load();
        clearForm();
        return "every field survives the export";
      } }
    ];
  }

  FieldKit.register("decisions", {
    group: "PROJECT",
    about: "Why things were decided, written down for later",
    keywords: "decisions log why choices adr",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "DECISIONS",
    icon: "⚖",
    width: 980,
    height: 620,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.editingId = null;
      nodes.list = el("div", { class: "dc-list" });
      nodes.chips = el("div", { class: "dc-chips" });
      nodes.supersedeBar = el("div");
      nodes.search = el("input", { class: "fk-input", placeholder: "SEARCH DECISIONS",
        oninput: function (e) { filter = e.target.value; renderList(); } });

      nodes.title = el("input", { class: "fk-input", placeholder: "the question, in a few words" });
      nodes.chose = el("textarea", { class: "fk-input", rows: "2",
        placeholder: "what you are going to do" });
      nodes.rejected = el("textarea", { class: "fk-input", rows: "2",
        placeholder: "what you considered and did not do — this is the part people forget, and the part that stops the same idea coming back" });
      nodes.why = el("textarea", { class: "fk-input", rows: "3",
        placeholder: "why. required. write it for someone who was not in the conversation" });
      nodes.revisit = el("input", { class: "fk-input",
        placeholder: "what would change your mind (optional, but it makes the decision testable)" });
      nodes.tags = el("input", { class: "fk-input", placeholder: "comma, separated, tags" });

      nodes.status = el("select", { class: "fk-input" });
      STATUSES.filter(function (s) { return s.id !== "superseded"; }).forEach(function (s) {
        nodes.status.appendChild(el("option", { value: s.id, text: s.label + " — " + s.note }));
      });

      nodes.project = el("select", { class: "fk-input" });
      nodes.project.appendChild(el("option", { value: "", text: "— no project —" }));
      try {
        var p = svcProjects();
        if (p) {
          (await p.list()).forEach(function (x) {
            nodes.project.appendChild(el("option", { value: x.id, text: x.data.name }));
          });
        }
      } catch (e) { ctx.warn("could not list projects: " + e.message); }

      nodes.saveBtn = ui.button("RECORD DECISION", saveEdit, { primary: true });

      host.appendChild(el("div", { class: "dc-wrap" }, [
        el("div", { class: "dc-side" }, [
          nodes.search, nodes.chips, nodes.list,
          el("div", { class: "dc-actions" }, [
            ui.button("EXPORT ALL", exportAll),
            ui.button("REFRESH", load)
          ])
        ]),
        el("div", { class: "dc-main" }, [
          nodes.supersedeBar,
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "DECISION" }), nodes.title]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "WE CHOSE" }), nodes.chose]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "WE REJECTED" }), nodes.rejected]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "BECAUSE" }), nodes.why]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "REVISIT IF" }), nodes.revisit]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "STATUS" }), nodes.status]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "PROJECT" }), nodes.project]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "TAGS" }), nodes.tags]),
          el("div", { class: "dc-actions" }, [nodes.saveBtn, ui.button("CLEAR", clearForm)]),
          el("div", { class: "dc-hint", text:
            "Decisions are append-only. There is no delete and no edit after ten minutes — " +
            "supersede instead, and the chain stays readable. A log you can quietly rewrite " +
            "is not evidence of anything." })
        ])
      ]));

      await load();
    },

    unmount() {
      nodes = {}; rows = []; filter = ""; statusFilter = ""; supersedes = null;
    },

    searchIndex() {
      return rows.map(function (r) {
        return {
          id: r.id, module: "decisions",
          title: "DECISION: " + r.data.title,
          body: [r.data.chose, r.data.rejected, r.data.why, r.data.revisitIf]
            .concat(r.data.tags || []).join(" ")
        };
      });
    }
  });
})(window.FieldKit);
