/* ============================================================
   FieldKit :: snippet-library
   Searchable, taggable code snippets with one-click copy (§3).
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "snippet";
  var LANGS = ["javascript", "typescript", "html", "css", "python", "bash", "json", "sql", "systemd", "other"];

  var ctx, ui, el, nodes = {}, snippets = [], editingId = null, filter = "", langFilter = "";

  async function load() {
    snippets = await ctx.store.list(TYPE);
    renderTags();
    renderList();
  }

  async function save() {
    var title = nodes.title.value.trim();
    if (!title) { ui.toast("TITLE REQUIRED", "warn"); return; }
    var body = nodes.body.value;
    if (!body.trim()) { ui.toast("SNIPPET IS EMPTY", "warn"); return; }

    await ctx.store.put(TYPE, {
      title: title,
      body: body,
      lang: nodes.lang.value,
      tags: nodes.tags.value.split(",").map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean),
      note: nodes.note.value
    }, { id: editingId || undefined });

    ui.toast(editingId ? "SNIPPET UPDATED" : "SNIPPET SAVED", "ok");
    await load();
  }

  function clearForm() {
    editingId = null;
    nodes.title.value = "";
    nodes.body.value = "";
    nodes.tags.value = "";
    nodes.note.value = "";
    nodes.lang.value = LANGS[0];
    nodes.saveBtn.textContent = "SAVE SNIPPET";
    renderList();
  }

  function edit(id) {
    var s = snippets.find(function (x) { return x.id === id; });
    if (!s) return;
    editingId = id;
    nodes.title.value = s.data.title || "";
    nodes.body.value = s.data.body || "";
    nodes.lang.value = s.data.lang || LANGS[0];
    nodes.tags.value = (s.data.tags || []).join(", ");
    nodes.note.value = s.data.note || "";
    nodes.saveBtn.textContent = "UPDATE SNIPPET";
    renderList();
  }

  async function remove() {
    if (!editingId) return;
    if (!confirm("Delete this snippet?")) return;
    await ctx.store.remove(editingId);
    clearForm();
    await load();
    ui.toast("SNIPPET DELETED", "warn");
  }

  function copyBody(text) {
    ui.copy(text, { title: "SNIPPET" })
      .then(function (how) { if (how) ui.toast("COPIED TO CLIPBOARD", "ok"); });
  }

  function renderTags() {
    ui.clear(nodes.tagbar);
    var counts = {};
    snippets.forEach(function (s) {
      (s.data.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 12);
    if (!tags.length) return;

    nodes.tagbar.appendChild(el("button", {
      class: "sl-tag" + (langFilter === "" ? " on" : ""), type: "button", text: "ALL",
      onclick: function () { langFilter = ""; renderTags(); renderList(); }
    }));
    tags.forEach(function (t) {
      nodes.tagbar.appendChild(el("button", {
        class: "sl-tag" + (langFilter === t ? " on" : ""), type: "button",
        text: t + " " + counts[t],
        onclick: function () { langFilter = langFilter === t ? "" : t; renderTags(); renderList(); }
      }));
    });
  }

  function renderList() {
    ui.clear(nodes.list);
    var f = filter.toLowerCase();
    var shown = snippets.filter(function (s) {
      if (langFilter && (s.data.tags || []).indexOf(langFilter) < 0) return false;
      if (!f) return true;
      return [s.data.title, s.data.body, s.data.note, s.data.lang]
        .concat(s.data.tags || []).join(" ").toLowerCase().indexOf(f) >= 0;
    });

    if (!shown.length) {
      nodes.list.appendChild(el("div", { class: "sl-none",
        text: snippets.length ? "NO MATCHES" : "NO SNIPPETS YET" }));
      return;
    }

    shown.forEach(function (s) {
      var preview = (s.data.body || "").split("\n").slice(0, 2).join(" ").slice(0, 54);
      nodes.list.appendChild(el("div", {
        class: "sl-item" + (s.id === editingId ? " active" : "")
      }, [
        el("button", { class: "sl-item-main", type: "button", onclick: function () { edit(s.id); } }, [
          el("span", { class: "sl-item-title", text: s.data.title || "(untitled)" }),
          el("span", { class: "sl-item-lang", text: s.data.lang || "other" }),
          el("span", { class: "sl-item-prev", text: preview || "—" })
        ]),
        el("button", { class: "sl-copy", type: "button", text: "COPY", title: "copy to clipboard",
          onclick: function (e) { e.stopPropagation(); copyBody(s.data.body || ""); } })
      ]));
    });
  }

  function selfcheck(api) {
    return [
      { name: "SAVE / LIST / DELETE", critical: false, run: async function () {
        var marker = "SELFTEST-" + Math.random().toString(36).slice(2, 8);
        nodes.title.value = marker;
        nodes.body.value = "console.log('probe');";
        nodes.lang.value = "javascript";
        nodes.tags.value = "selftest, probe";
        nodes.note.value = "created by the system exercise";
        await save();

        var mine = snippets.filter(function (s) { return s.data.title === marker; });
        if (mine.length !== 1) throw new Error("expected 1 saved snippet, found " + mine.length);
        api.sandbox.track(mine[0].id);

        if (!nodes.list.textContent.includes(marker)) throw new Error("saved snippet is not in the list");

        await ctx.store.remove(mine[0].id);
        clearForm();
        await load();
        if (snippets.some(function (s) { return s.data.title === marker; })) {
          throw new Error("snippet survived deletion");
        }
        return "saved, listed, deleted";
      } },
      { name: "SEARCH FILTER", critical: false, run: async function () {
        filter = "zzz-no-such-snippet-zzz";
        renderList();
        var empty = /NO MATCHES|NO SNIPPETS/.test(nodes.list.textContent);
        filter = "";
        renderList();
        if (!empty) throw new Error("a search with no matches still listed results");
        return "filters and clears";
      } }
    ];
  }

  FieldKit.register("snippet-library", {
    group: "FILES",
    about: "Code snippets you reuse, tagged and one click to copy",
    keywords: "code snippets copy paste library tags",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "SNIPPETS",
    icon: "❑",
    width: 880,
    height: 560,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.search = el("input", { class: "fk-input sl-search", placeholder: "SEARCH SNIPPETS",
        oninput: function (e) { filter = e.target.value; renderList(); } });
      nodes.tagbar = el("div", { class: "sl-tagbar" });
      nodes.list = el("div", { class: "sl-list" });

      nodes.title = el("input", { class: "fk-input", placeholder: "what this snippet does" });
      nodes.body = el("textarea", { class: "fk-input sl-body", spellcheck: "false",
        placeholder: "paste the code" });
      nodes.note = el("input", { class: "fk-input", placeholder: "when to reach for it (optional)" });
      nodes.tags = el("input", { class: "fk-input", placeholder: "comma, separated, tags" });

      nodes.lang = el("select", { class: "fk-input sl-select" });
      LANGS.forEach(function (l) { nodes.lang.appendChild(el("option", { value: l, text: l })); });

      nodes.saveBtn = ui.button("SAVE SNIPPET", save, { primary: true });

      nodes.body.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
        if (e.key === "Tab") {
          e.preventDefault();
          var st = this.selectionStart, en = this.selectionEnd;
          this.value = this.value.slice(0, st) + "  " + this.value.slice(en);
          this.selectionStart = this.selectionEnd = st + 2;
        }
      });

      host.appendChild(el("div", { class: "sl-wrap" }, [
        el("div", { class: "sl-side" }, [
          nodes.search, nodes.tagbar, nodes.list,
          el("div", { class: "sl-side-actions" }, [ui.button("NEW", clearForm)])
        ]),
        el("div", { class: "sl-main" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "TITLE" }), nodes.title
          ]),
          el("div", { class: "sl-row" }, [
            el("label", { class: "fk-field sl-langfield" }, [
              el("span", { class: "fk-field-label", text: "LANGUAGE" }), nodes.lang
            ]),
            el("label", { class: "fk-field sl-tagfield" }, [
              el("span", { class: "fk-field-label", text: "TAGS" }), nodes.tags
            ])
          ]),
          el("label", { class: "fk-field sl-bodyfield" }, [
            el("span", { class: "fk-field-label", text: "CODE" }), nodes.body
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "NOTE" }), nodes.note
          ]),
          el("div", { class: "sl-actions" }, [
            nodes.saveBtn,
            ui.button("COPY", function () { copyBody(nodes.body.value); }),
            ui.button("CLEAR", clearForm),
            ui.button("DELETE", remove, { danger: true })
          ])
        ])
      ]));

      await load();
    },

    unmount() { nodes = {}; snippets = []; editingId = null; filter = ""; langFilter = ""; },

    searchIndex() {
      return snippets.map(function (s) {
        return {
          id: s.id, module: "snippet-library",
          title: s.data.title || "(untitled)",
          body: [s.data.lang, s.data.note, s.data.body].concat(s.data.tags || []).join(" ")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("sl-style")) return;
    var s = document.createElement("style");
    s.id = "sl-style";
    s.textContent = `
.sl-wrap{display:flex;gap:10px;height:100%;min-height:0}
.sl-side{width:260px;flex:none;display:flex;flex-direction:column;gap:7px;min-height:0}
.sl-search{padding:6px 8px;font-size:11px;letter-spacing:.1em}
.sl-tagbar{display:flex;flex-wrap:wrap;gap:3px;flex:none;max-height:66px;overflow:auto}
.sl-tag{background:#11150f;border:1px solid var(--line2);color:var(--fg-dimmer);
  font:inherit;font-size:9px;letter-spacing:.08em;padding:2px 6px;cursor:pointer}
.sl-tag:hover{color:var(--accent);border-color:var(--accent-dim)}
.sl-tag.on{color:var(--accent);border-color:var(--accent);background:rgba(var(--accent-glow),.1)}
.sl-list{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);min-height:0}
.sl-side-actions{flex:none;display:flex;gap:6px}
.sl-side-actions .fk-btn{flex:1}
.sl-item{display:flex;align-items:stretch;border-bottom:1px solid var(--line)}
.sl-item:hover{background:rgba(var(--accent-glow),.07)}
.sl-item.active{background:rgba(var(--accent-glow),.13);border-left:2px solid var(--accent)}
.sl-item-main{flex:1;text-align:left;background:none;border:0;padding:7px 9px;cursor:pointer;min-width:0}
.sl-item-title{display:block;color:var(--fg);font-size:11px;letter-spacing:.08em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-item.active .sl-item-title{color:var(--accent)}
.sl-item-lang{display:inline-block;font-size:8px;color:var(--fg-dimmer);letter-spacing:.1em;margin-top:2px}
.sl-item-prev{display:block;font-size:9px;color:var(--fg-dimmer);margin-top:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono)}
.sl-copy{flex:none;background:none;border:0;border-left:1px solid var(--line);color:var(--fg-dimmer);
  font:inherit;font-size:9px;letter-spacing:.1em;padding:0 8px;cursor:pointer}
.sl-copy:hover{color:var(--accent);background:rgba(var(--accent-glow),.1)}
.sl-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.sl-row{display:flex;gap:8px;flex:none}
.sl-langfield{width:150px;flex:none}
.sl-tagfield{flex:1}
.sl-select{padding:8px 9px}
.sl-bodyfield{flex:1;display:flex;flex-direction:column;min-height:0}
.sl-body{flex:1;resize:none;line-height:1.5;min-height:120px}
.sl-actions{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.sl-none{padding:14px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
