/* ============================================================
   FieldKit :: scratchpad
   Markdown notes with full version history — every save writes a
   new version record rather than overwriting.

   This is Phase 1's proving module: it exercises encrypted writes,
   many-record reads, search, and the offline queue harder than
   anything else in the toolkit.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "note";
  var TYPE_VER = "note-version";

  var ctx = null;
  var ui = null;
  var el = null;

  var state = { noteId: null, dirty: false, notes: [], filter: "" };
  var nodes = {};
  var autosaveTimer = null;

  /* ---- safe markdown ------------------------------------------
     Builds DOM nodes. Nothing here ever touches innerHTML, so a
     note containing markup is text, not markup. (§10F)          */
  function inline(text, parent) {
    var re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      if (tok.slice(0, 2) === "**") parent.appendChild(el("strong", { text: tok.slice(2, -2) }));
      else if (tok[0] === "`") parent.appendChild(el("code", { class: "md-code", text: tok.slice(1, -1) }));
      else if (tok[0] === "[") {
        var mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
        var href = mm[2].trim();
        /* Only http/https survive — no javascript:, no data:. */
        if (/^https?:\/\//i.test(href)) {
          parent.appendChild(el("a", { class: "md-link", href: href, target: "_blank",
            rel: "noopener noreferrer nofollow", text: mm[1] }));
        } else {
          parent.appendChild(document.createTextNode(mm[1] + " (" + href + ")"));
        }
      }
      else parent.appendChild(el("em", { text: tok.slice(1, -1) }));
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
    return parent;
  }

  function renderMarkdown(src) {
    var host = el("div", { class: "md" });
    var lines = String(src || "").split(/\r?\n/);
    var i = 0, list = null;

    function endList() { list = null; }

    while (i < lines.length) {
      var ln = lines[i];

      if (/^```/.test(ln)) {
        endList();
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        host.appendChild(el("pre", { class: "md-pre" }, [el("code", { text: buf.join("\n") })]));
        continue;
      }
      if (/^\s*---\s*$/.test(ln)) { endList(); host.appendChild(el("hr", { class: "md-hr" })); i++; continue; }

      var h = /^(#{1,4})\s+(.*)$/.exec(ln);
      if (h) {
        endList();
        host.appendChild(inline(h[2], el("h" + (h[1].length + 1), { class: "md-h" })));
        i++; continue;
      }
      var q = /^>\s?(.*)$/.exec(ln);
      if (q) { endList(); host.appendChild(inline(q[1], el("blockquote", { class: "md-quote" }))); i++; continue; }

      var li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(ln);
      if (li) {
        var ordered = /\d/.test(li[1]);
        if (!list || list.ordered !== ordered) {
          list = { node: el(ordered ? "ol" : "ul", { class: "md-list" }), ordered: ordered };
          host.appendChild(list.node);
        }
        list.node.appendChild(inline(li[2], el("li")));
        i++; continue;
      }

      if (!ln.trim()) { endList(); i++; continue; }

      endList();
      host.appendChild(inline(ln, el("p", { class: "md-p" })));
      i++;
    }
    return host;
  }

  /* ---- data --------------------------------------------------- */
  async function loadNotes() {
    state.notes = await ctx.store.list(TYPE);
    renderList();
  }

  function currentNote() {
    return state.notes.find(function (n) { return n.id === state.noteId; }) || null;
  }

  /* The close path. Takes everything by value and writes only to the
     store — no state, no nodes, no toast, because by the time this
     resolves the module is gone and both are somebody else's now. */
  function saveDetached(title, body, noteId) {
    var store = ctx.store;
    Promise.resolve()
      .then(function () {
        return store.put(TYPE, { title: title, body: body },
          noteId ? { id: noteId } : undefined);
      })
      .then(function (meta) {
        return store.put(TYPE_VER, {
          noteId: meta.id, title: title, body: body, at: meta.updatedAt
        });
      })
      .catch(function (e) {
        FieldKit.log("error", "scratchpad", "save on close failed: " + e.message);
      });
  }

  async function saveNote(opts) {
    opts = opts || {};
    var title = nodes.title.value.trim() || "UNTITLED";
    var body = nodes.editor.value;
    var existing = currentNote();

    if (existing && !opts.force && existing.data.body === body && existing.data.title === title) {
      return existing;
    }

    var meta = await ctx.store.put(TYPE, { title: title, body: body }, { id: state.noteId || undefined });
    state.noteId = meta.id;

    /* Version history: append-only, never overwritten. */
    await ctx.store.put(TYPE_VER, {
      noteId: meta.id, title: title, body: body, at: meta.updatedAt
    });

    state.dirty = false;
    updateDirty();
    await loadNotes();
    ui.toast("SAVED :: " + title, "ok");
    return meta;
  }

  async function newNote() {
    if (state.dirty && !confirm("Discard unsaved changes?")) return;
    state.noteId = null;
    nodes.title.value = "";
    nodes.editor.value = "";
    state.dirty = false;
    updateDirty();
    renderList();
    renderPreview();
    nodes.title.focus();
  }

  async function openNote(id) {
    if (state.dirty && !confirm("Discard unsaved changes?")) return;
    var n = state.notes.find(function (x) { return x.id === id; });
    if (!n) return;
    state.noteId = id;
    nodes.title.value = n.data.title || "";
    nodes.editor.value = n.data.body || "";
    state.dirty = false;
    updateDirty();
    renderList();
    renderPreview();
  }

  async function deleteNote() {
    var n = currentNote();
    if (!n) return;
    if (!confirm('Delete "' + (n.data.title || "UNTITLED") + '"? Versions are kept.')) return;
    await ctx.store.remove(n.id);
    state.noteId = null;
    nodes.title.value = "";
    nodes.editor.value = "";
    state.dirty = false;
    updateDirty();
    await loadNotes();
    renderPreview();
    ui.toast("DELETED", "warn");
  }

  async function showHistory() {
    if (!state.noteId) { ui.toast("SAVE THE NOTE FIRST", "warn"); return; }
    var all = await ctx.store.list(TYPE_VER);
    var mine = all.filter(function (v) { return v.data.noteId === state.noteId; });
    ui.clear(nodes.preview);
    if (!mine.length) { nodes.preview.appendChild(el("p", { class: "md-p", text: "No versions yet." })); return; }

    nodes.preview.appendChild(ui.panel("VERSION HISTORY — " + mine.length, mine.map(function (v) {
      var when = new Date(v.data.at || v.meta.updatedAt);
      return el("div", { class: "ver-row" }, [
        el("span", { class: "ver-when", text: when.toLocaleString() }),
        el("span", { class: "ver-size", text: (v.data.body || "").length + " ch" }),
        ui.button("RESTORE", function () {
          nodes.editor.value = v.data.body || "";
          nodes.title.value = v.data.title || "";
          markDirty();
          renderPreview();
          ui.toast("VERSION LOADED — SAVE TO KEEP", "warn");
        })
      ]);
    })));
  }

  /* ---- rendering ---------------------------------------------- */
  function renderList() {
    ui.clear(nodes.list);
    var f = state.filter.toLowerCase();
    var shown = state.notes.filter(function (n) {
      if (!f) return true;
      return ((n.data.title || "") + " " + (n.data.body || "")).toLowerCase().indexOf(f) >= 0;
    });

    if (!shown.length) {
      nodes.list.appendChild(el("div", { class: "sp-empty", text:
        state.notes.length ? "NO MATCHES" : "NO NOTES YET" }));
      return;
    }

    shown.forEach(function (n) {
      var preview = (n.data.body || "").replace(/\s+/g, " ").slice(0, 46);
      nodes.list.appendChild(el("button", {
        class: "sp-item" + (n.id === state.noteId ? " active" : ""),
        type: "button", onclick: function () { openNote(n.id); }
      }, [
        el("span", { class: "sp-item-title", text: n.data.title || "UNTITLED" }),
        el("span", { class: "sp-item-prev", text: preview || "—" }),
        el("span", { class: "sp-item-date", text:
          new Date(n.meta.updatedAt).toLocaleDateString() + " " +
          new Date(n.meta.updatedAt).toLocaleTimeString().slice(0, 5) })
      ]));
    });
  }

  function renderPreview() {
    ui.clear(nodes.preview);
    nodes.preview.appendChild(renderMarkdown(nodes.editor.value));
  }

  function markDirty() {
    state.dirty = true;
    updateDirty();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      if (state.dirty && (nodes.editor.value.trim() || nodes.title.value.trim())) saveNote();
    }, 12000);
  }

  function updateDirty() {
    nodes.dirty.textContent = state.dirty ? "UNSAVED" : "";
    nodes.dirty.className = "sp-dirty" + (state.dirty ? " on" : "");
  }

  /* ---- module ------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "WRITE / SAVE / VERSION", critical: false, run: async function () {
        var marker = "SELFTEST-NOTE-" + Math.random().toString(36).slice(2, 8);
        var wasNote = state.noteId;
        state.noteId = null;
        nodes.title.value = marker;
        nodes.editor.value = "# probe\n\nWritten by the system exercise.";
        var meta = await saveNote({ force: true });
        if (!meta || !meta.id) throw new Error("save returned nothing");
        api.sandbox.track(meta.id);

        var back = await ctx.store.get(meta.id);
        if (!back || back.title !== marker) throw new Error("note did not read back");

        /* Version history is append-only and is the reason a note is
           safe to overwrite — check one actually landed. */
        var versions = (await ctx.store.list(TYPE_VER))
          .filter(function (v) { return v.data.noteId === meta.id; });
        versions.forEach(function (v) { api.sandbox.track(v.id); });
        if (!versions.length) throw new Error("no version snapshot was written");

        await ctx.store.remove(meta.id);
        for (var i = 0; i < versions.length; i++) await ctx.store.remove(versions[i].id);
        state.noteId = wasNote;
        state.dirty = false;
        await loadNotes();
        return "saved, read back, " + versions.length + " version snapshot(s), cleaned up";
      } },
      { name: "MARKDOWN PREVIEW", critical: false, run: async function () {
        nodes.editor.value = "# Heading\n\nSome **bold** text and `code`.\n\n- one\n- two";
        renderPreview();
        var html = nodes.preview;
        /* Headings are shifted down a level on purpose — a note's "#"
           is not the page's h1. */
        if (!html.querySelector("h2.md-h")) throw new Error("heading was not rendered");
        if (!html.querySelector("li")) throw new Error("list was not rendered");
        if (!html.querySelector("strong")) throw new Error("bold was not rendered");
        if (!html.querySelector("code")) throw new Error("inline code was not rendered");
        /* Markup in a note must never become live markup. */
        nodes.editor.value = "<img src=x onerror=alert(1)>";
        renderPreview();
        if (nodes.preview.querySelector("img")) throw new Error("raw HTML in a note was rendered as an element");
        nodes.editor.value = "";
        renderPreview();
        return "renders markdown, refuses raw HTML";
      } }
    ];
  }

  FieldKit.register("scratchpad", {
    group: "FILES",
    about: "Quick notes in Markdown, with every version kept",
    keywords: "notes text write markdown jot draft memo",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "SCRATCHPAD",
    icon: "▤",
    width: 860,
    height: 540,

    async mount(host, context) {
      ctx = context;
      ui = ctx.ui;
      el = ui.el;

      injectCSS();

      nodes.search = el("input", { class: "fk-input sp-search", placeholder: "SEARCH NOTES",
        oninput: function (e) { state.filter = e.target.value; renderList(); } });
      nodes.list = el("div", { class: "sp-list" });
      nodes.title = el("input", { class: "fk-input sp-title", placeholder: "NOTE TITLE",
        oninput: markDirty });
      nodes.editor = el("textarea", { class: "fk-input sp-editor", spellcheck: "false",
        placeholder: "# markdown supported\n\n- lists\n- **bold**, *italic*, `code`\n- > quotes and ``` blocks",
        oninput: function () { markDirty(); renderPreview(); } });
      nodes.preview = el("div", { class: "sp-preview" });
      nodes.dirty = el("span", { class: "sp-dirty" });

      var offlineWarning = ctx.store.canReadHistory() ? null :
        el("div", { class: "sp-offline", text:
          "OFFLINE — prior notes are encrypted on the relay and cannot be read here. New notes are queued for upload." });

      host.appendChild(el("div", { class: "sp-wrap" }, [
        el("div", { class: "sp-side" }, [
          nodes.search,
          el("div", { class: "sp-side-actions" }, [ui.button("NEW", newNote, { primary: true })]),
          nodes.list
        ]),
        el("div", { class: "sp-main" }, [
          offlineWarning,
          el("div", { class: "sp-bar" }, [
            nodes.title, nodes.dirty,
            ui.button("SAVE", function () { saveNote({ force: true }); }, { primary: true }),
            ui.button("HISTORY", showHistory),
            ui.button("DELETE", deleteNote, { danger: true })
          ]),
          el("div", { class: "sp-split" }, [nodes.editor, nodes.preview])
        ])
      ]));

      nodes.editor.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          saveNote({ force: true });
        }
      });

      await loadNotes();
      renderPreview();
    },

    unmount() {
      clearTimeout(autosaveTimer);
      if (state.dirty && (nodes.editor.value.trim() || nodes.title.value.trim())) {
        /* Fire-and-forget, so closing the window never loses work —
           but it must not write back into module state afterwards.
           saveNote() sets state.noteId AFTER its await, and by then
           unmount has already installed a fresh state object; the
           id of the note being closed landed on the NEXT note you
           opened, quietly retargeting it. Everything needed is
           captured here, and the detached save touches nothing but
           the store. */
        saveDetached(nodes.title.value.trim() || "UNTITLED", nodes.editor.value, state.noteId);
      }
      nodes = {};
      state = { noteId: null, dirty: false, notes: [], filter: "" };
    },

    searchIndex() {
      return state.notes.map(function (n) {
        return { id: n.id, module: "scratchpad", title: n.data.title || "UNTITLED", body: n.data.body || "" };
      });
    }
  });

  /* ---- styles ------------------------------------------------- */
  function injectCSS() {
    if (document.getElementById("scratch-style")) return;
    var s = document.createElement("style");
    s.id = "scratch-style";
    s.textContent = `
.sp-wrap{display:flex;gap:10px;height:100%;min-height:0}
.sp-side{width:210px;flex:none;display:flex;flex-direction:column;gap:8px;min-height:0}
.sp-search{padding:6px 8px;font-size:11px;letter-spacing:.1em}
.sp-side-actions{display:flex;gap:6px}
.sp-side-actions .fk-btn{flex:1}
.sp-list{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);min-height:0}
.sp-item{display:block;width:100%;text-align:left;padding:7px 9px;background:none;border:0;
  border-bottom:1px solid var(--line);cursor:pointer;color:var(--fg-dim)}
.sp-item:hover{background:rgba(var(--accent-glow),.07)}
.sp-item.active{background:rgba(var(--accent-glow),.12);border-left:2px solid var(--accent)}
.sp-item-title{display:block;color:var(--fg);font-size:11px;letter-spacing:.1em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-item.active .sp-item-title{color:var(--accent)}
.sp-item-prev{display:block;font-size:10px;color:var(--fg-dimmer);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.sp-item-date{display:block;font-size:9px;color:var(--fg-dimmer);margin-top:3px;letter-spacing:.08em}
.sp-empty{padding:14px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.2em}
.sp-main{flex:1;display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}
.sp-bar{display:flex;gap:6px;align-items:center;flex:none}
.sp-title{flex:1;padding:6px 9px;letter-spacing:.1em}
.sp-dirty{font-size:10px;letter-spacing:.16em;color:transparent;min-width:60px}
.sp-dirty.on{color:var(--warn)}
.sp-split{flex:1;display:flex;gap:8px;min-height:0}
.sp-editor{flex:1;resize:none;line-height:1.6;min-height:0}
.sp-preview{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);
  padding:10px 12px;min-height:0}
.sp-offline{flex:none;border:1px solid var(--warn);color:var(--warn);padding:7px 10px;font-size:10px;
  letter-spacing:.08em;background:rgba(224,166,60,.07)}
.md-h{color:var(--accent);letter-spacing:.1em;margin:.7em 0 .35em;font-size:13px}
.md-p{margin:.4em 0}
.md-list{margin:.4em 0;padding-left:20px}
.md-quote{margin:.5em 0;padding-left:10px;border-left:2px solid var(--accent-dim);color:var(--fg-dim)}
.md-pre{background:#0b0e0c;border:1px solid var(--line);padding:9px;overflow-x:auto;margin:.5em 0}
.md-code{background:#0b0e0c;border:1px solid var(--line);padding:1px 4px;color:var(--accent)}
.md-hr{border:0;border-top:1px solid var(--line2);margin:.8em 0}
.md-link{color:var(--info)}
.ver-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--line)}
.ver-when{flex:1;font-size:11px}
.ver-size{font-size:10px;color:var(--fg-dimmer)}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
