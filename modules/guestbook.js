/* ============================================================
   FieldKit :: guestbook
   Someone holding the drive leaves a note (§6).

   The awkward bit, and why this is not just another record type:
   a guest has no vault. Guest mode swaps the store for an
   in-memory one on purpose, so anything a guest writes vanishes
   on reload — which would make a guestbook a cruel joke.

   So entries land in two stages:

     1. A guest writes to localStorage. Unencrypted, on this
        machine, and the UI says exactly that before they type.
     2. Next time the owner unlocks, FieldKit notices the pending
        notes and offers to file them into the vault. From then on
        they are sealed like everything else.

   Nothing is collected automatically. Filing someone else's words
   into your encrypted store without looking at them first is a
   small thing to get wrong and an annoying one to undo.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "guestbook";
  var PENDING_KEY = "fieldkit.guestbook.pending.v1";
  var MAX_PENDING = 40;
  var MAX_NAME = 40;
  var MAX_NOTE = 600;

  var ctx, ui, el, nodes = {};
  var filed = [];

  /* ---- the unencrypted staging area ------------------------------- */
  function readPending() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return list.filter(function (e) {
        return e && typeof e.note === "string" && typeof e.at === "string";
      });
    } catch (e) { return []; }
  }

  function writePending(list) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING))); return true; }
    catch (e) { return false; }
  }

  function addPending(name, note) {
    note = String(note || "").trim().slice(0, MAX_NOTE);
    if (!note) throw new Error("write something first");
    var list = readPending();
    if (list.length >= MAX_PENDING) {
      throw new Error("there are already " + MAX_PENDING +
        " notes waiting to be filed — ask whoever owns this to collect them");
    }
    var entry = {
      name: String(name || "").trim().slice(0, MAX_NAME) || "anonymous",
      note: note,
      at: new Date().toISOString()
    };
    list.push(entry);
    if (!writePending(list)) throw new Error("this browser will not let us store the note");
    FieldKit.emit("guestbook:pending", { count: list.length });
    return entry;
  }

  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* fine */ }
  }

  function pendingCount() { return readPending().length; }

  /* ---- the vault side ---------------------------------------------- */
  function normalise(d, id, meta) {
    return {
      id: id,
      name: String(d.name || "anonymous").slice(0, MAX_NAME),
      note: String(d.note || "").slice(0, MAX_NOTE),
      at: d.at || (meta && meta.updatedAt) || new Date().toISOString(),
      filedAt: d.filedAt || null,
      filedBy: (meta && meta.author) || null
    };
  }

  async function loadFiled() {
    if (!ctx.store.isUnlocked()) { filed = []; return filed; }
    var rows = await ctx.store.list(TYPE);
    filed = rows.map(function (r) { return normalise(r.data, r.id, r.meta); })
      .sort(function (a, b) { return (b.at || "").localeCompare(a.at || ""); });
    return filed;
  }

  /* Deliberately explicit. Nothing is filed without someone pressing
     the button having read what they are filing. */
  async function fileAll() {
    var list = readPending();
    if (!list.length) return { filed: 0 };
    var now = new Date().toISOString();
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      await ctx.store.put(TYPE, {
        name: list[i].name, note: list[i].note, at: list[i].at, filedAt: now
      });
      n++;
    }
    clearPending();
    await loadFiled();
    return { filed: n };
  }

  /* ---- ui ---------------------------------------------------------- */
  function isGuest() {
    var g = FieldKit.service("guest");
    return !!(g && g.active());
  }

  function render() {
    renderPending();
    renderFiled();
  }

  function renderPending() {
    if (!nodes.pending) return;
    ui.clear(nodes.pending);
    var list = readPending();
    if (!list.length) {
      nodes.pending.appendChild(el("div", { class: "gb-none", text: "NOTHING WAITING" }));
      if (nodes.fileBtn) nodes.fileBtn.disabled = true;
      return;
    }
    if (nodes.fileBtn) nodes.fileBtn.disabled = !ctx.store.isUnlocked();

    nodes.pending.appendChild(el("div", { class: "gb-warn", text:
      list.length + " note(s) are sitting in this browser's storage, unencrypted. They are " +
      "readable by anyone who opens this profile until they are filed into the vault." }));

    list.slice().reverse().forEach(function (e, i) {
      var idx = list.length - 1 - i;
      nodes.pending.appendChild(el("div", { class: "gb-entry gb-unfiled" }, [
        el("div", { class: "gb-head" }, [
          el("span", { class: "gb-name", text: e.name }),
          el("span", { class: "gb-when", text: new Date(e.at).toLocaleString() }),
          ui.button("×", function () {
            if (!confirm("Discard this note without filing it?")) return;
            var cur = readPending();
            cur.splice(idx, 1);
            writePending(cur);
            render();
          }, { title: "discard" })
        ]),
        el("div", { class: "gb-note", text: e.note })
      ]));
    });
  }

  function renderFiled() {
    if (!nodes.filed) return;
    ui.clear(nodes.filed);
    if (!ctx.store.isUnlocked()) {
      nodes.filed.appendChild(el("div", { class: "gb-none",
        text: "THE VAULT IS NOT OPEN — FILED NOTES ARE NOT READABLE HERE" }));
      return;
    }
    if (!filed.length) {
      nodes.filed.appendChild(el("div", { class: "gb-none", text: "NOTHING FILED YET" }));
      return;
    }
    filed.forEach(function (e) {
      nodes.filed.appendChild(el("div", { class: "gb-entry" }, [
        el("div", { class: "gb-head" }, [
          el("span", { class: "gb-name", text: e.name }),
          el("span", { class: "gb-when", text: new Date(e.at).toLocaleDateString() }),
          ui.button("×", function () {
            if (!confirm("Delete this note permanently?")) return;
            ctx.store.remove(e.id).then(function () { loadFiled().then(renderFiled); });
          }, { title: "delete" })
        ]),
        el("div", { class: "gb-note", text: e.note })
      ]));
    });
  }

  /* ---- probes ------------------------------------------------------ */
  function selfcheck(api) {
    return [
      { name: "A GUEST NOTE SURVIVES A RELOAD", critical: true, run: async function () {
        var was = readPending();
        try {
          clearPending();
          var marker = "probe-" + Math.random().toString(36).slice(2, 10);
          addPending("PROBE", marker);
          /* Reading it back from storage, not from memory — that is
             the whole difference between this and the guest store. */
          var raw = localStorage.getItem(PENDING_KEY);
          if (!raw || raw.indexOf(marker) < 0) {
            throw new Error("the note did not reach localStorage");
          }
          var back = readPending();
          if (back.length !== 1 || back[0].note !== marker) {
            throw new Error("it did not read back intact");
          }
          if (back[0].name !== "PROBE") throw new Error("the name was lost");
          return "written to and read back from browser storage, not memory";
        } finally { clearPending(); writePending(was); }
      } },

      /* The honesty check. A guest note is NOT encrypted, and the
         module must not imply otherwise. */
      { name: "PENDING NOTES ARE HONESTLY UNENCRYPTED", critical: true, run: async function () {
        var was = readPending();
        try {
          clearPending();
          var marker = "canary-" + Math.random().toString(36).slice(2, 10);
          addPending("PROBE", marker);
          var raw = localStorage.getItem(PENDING_KEY);
          if (raw.indexOf(marker) < 0) {
            throw new Error("the note is not where the UI says it is");
          }
          renderPending();
          var text = flatten(nodes.pending);
          if (!/unencrypted/i.test(text)) {
            throw new Error("the panel does not say the notes are unencrypted");
          }
          if (!/until they are filed/i.test(text)) {
            throw new Error("the panel does not say when that stops being true");
          }
          return "readable in storage, and the panel says so before anyone types";
        } finally { clearPending(); writePending(was); render(); }
      } },

      { name: "FILING SEALS THEM AND CLEARS THE STAGING AREA",
        critical: true, run: async function () {
        var was = readPending();
        try {
          clearPending();
          var marker = "seal-" + Math.random().toString(36).slice(2, 10);
          addPending("PROBE", marker);
          addPending("PROBE TWO", marker + "-b");

          var before = (await ctx.store.list(TYPE)).length;
          var r = await fileAll();
          if (r.filed !== 2) throw new Error("filed " + r.filed + " of 2");

          var after = await ctx.store.list(TYPE);
          if (after.length !== before + 2) throw new Error("the vault did not gain both notes");
          if (localStorage.getItem(PENDING_KEY)) {
            throw new Error("the unencrypted copies were left behind after filing");
          }
          if (readPending().length) throw new Error("pending list is not empty");

          /* And they are sealed like everything else.

             Only checkable where there is a vault to seal them in.
             On OUTPOST (§14.1) there is no encryption at all and
             store-outpost says so in its own header — asserting
             secrecy there would be asserting something false, so the
             check names the absence instead of skipping it quietly. */
          if (typeof ctx.store.exportRecords === "function") {
            var raw = await ctx.store.exportRecords();
            var mine = raw.filter(function (x) { return x.type === TYPE; });
            if (JSON.stringify(mine).indexOf(marker) >= 0) {
              throw new Error("a filed note is readable in the sealed record");
            }
          } else if (ctx.store.hasVault && !ctx.store.hasVault()) {
            FieldKit.log("info", "guestbook",
              "no vault on this build — filed notes are stored in the clear, as documented");
          } else {
            throw new Error("the store has no exportRecords() and does not explain why");
          }

          /* Clean up: these went in outside the sandbox. */
          var ids = after.filter(function (x) { return x.data && x.data.note &&
            x.data.note.indexOf(marker) === 0; }).map(function (x) { return x.id; });
          for (var i = 0; i < ids.length; i++) await ctx.store.remove(ids[i]);
          return "both filed, staging cleared, and the filed copies are sealed";
        } finally { clearPending(); writePending(was); await loadFiled(); }
      } },

      { name: "GARBAGE IN STORAGE DOES NOT BREAK IT", critical: false, run: async function () {
        var was = readPending();
        try {
          var cases = ["not json", "{}", "[]", '["a string"]', '[{"note":123}]', 'null'];
          for (var i = 0; i < cases.length; i++) {
            localStorage.setItem(PENDING_KEY, cases[i]);
            var got = readPending();
            if (!Array.isArray(got)) throw new Error("case " + i + " did not return an array");
            if (got.length) throw new Error("case " + i + " kept a malformed entry");
          }
          localStorage.setItem(PENDING_KEY,
            '[{"name":"ok","note":"good","at":"2026-01-01T00:00:00Z"},{"broken":true}]');
          var mixed = readPending();
          if (mixed.length !== 1) throw new Error("a mixed list did not keep exactly the good one");
          return cases.length + " kinds of corruption survived, good entries kept";
        } finally { clearPending(); writePending(was); }
      } },

      { name: "LIMITS ARE ENFORCED", critical: false, run: async function () {
        var was = readPending();
        try {
          clearPending();
          var threw = null;
          try { addPending("x", "   "); } catch (e) { threw = e.message; }
          if (!threw) throw new Error("an empty note was accepted");

          var e1 = addPending("N".repeat(200), "L".repeat(2000));
          if (e1.name.length !== MAX_NAME) throw new Error("the name was not capped");
          if (e1.note.length !== MAX_NOTE) throw new Error("the note was not capped");

          var e2 = addPending("", "no name given");
          if (e2.name !== "anonymous") throw new Error("a blank name did not become anonymous");

          clearPending();
          var list = [];
          for (var i = 0; i < MAX_PENDING; i++) {
            list.push({ name: "n", note: "x", at: new Date().toISOString() });
          }
          writePending(list);
          var full = null;
          try { addPending("one", "too many"); } catch (e) { full = e.message; }
          if (!full) throw new Error("the staging area accepted an entry past its limit");
          if (!/collect/.test(full)) throw new Error("the message does not say what to do");
          return "empty refused, name and note capped, blank name handled, limit enforced";
        } finally { clearPending(); writePending(was); }
      } },

      { name: "A NOTE IS TEXT, NEVER MARKUP", critical: true, run: async function () {
        var was = readPending();
        try {
          clearPending();
          addPending("<img onerror=x>", "<script>alert(1)</script>");
          renderPending();
          if (nodes.pending.querySelectorAll("script").length) {
            throw new Error("a script element was created from a guest note");
          }
          if (nodes.pending.querySelectorAll("img").length) {
            throw new Error("an img element was created from a guest name");
          }
          if (flatten(nodes.pending).indexOf("<script>") < 0) {
            throw new Error("the note was not rendered at all");
          }
          return "a hostile note renders as text — §10F's rule, enforced";
        } finally { clearPending(); writePending(was); render(); }
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

  FieldKit.register("guestbook", {
    group: "PROJECT",
    about: "Notes left by people who borrowed the drive",
    keywords: "guestbook visitors notes guest sign",
    /* The one module a guest is actually meant to write in. */
    guestSafe: true,
    selfcheck: selfcheck,
    title: "GUESTBOOK",
    icon: "✍",
    width: 640,
    height: 580,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.pending = el("div");
      nodes.filed = el("div", { class: "gb-list" });

      var nameIn = ui.field("YOUR NAME", { placeholder: "or leave it blank" });
      var noteIn = el("textarea", { class: "fk-input gb-input", rows: "4",
        placeholder: "say something", maxlength: String(MAX_NOTE) });

      var signBtn = ui.button("SIGN", function () {
        try {
          addPending(nameIn.input.value, noteIn.value);
          nameIn.input.value = "";
          noteIn.value = "";
          render();
          ui.toast("SIGNED — THANK YOU", "ok");
        } catch (e) {
          ui.toast(e.message.toUpperCase(), "fail");
        }
      }, { primary: true });

      nodes.fileBtn = ui.button("FILE THESE INTO THE VAULT", function () {
        if (!ctx.store.isUnlocked()) { ui.toast("THE VAULT IS NOT OPEN", "warn"); return; }
        var n = pendingCount();
        if (!confirm("File " + n + " note(s) into the vault?\n\n" +
          "Read them first — this is someone else's text going into your encrypted store.")) return;
        fileAll().then(function (r) {
          render();
          ui.toast("FILED " + r.filed + " NOTE(S)", "ok");
        }).catch(function (e) { ui.toast(e.message.toUpperCase(), "fail"); });
      });

      host.appendChild(el("div", { class: "gb-wrap" }, [
        ui.panel("SIGN THE BOOK", [
          el("p", { class: "gb-note-block", text:
            "Leave a note for whoever owns this drive. It is kept on this machine, in the " +
            "clear, until they collect it — so write it as if someone else might read it " +
            "before they do, because they might." }),
          nameIn, noteIn,
          el("div", { class: "gb-actions" }, [signBtn])
        ]),

        ui.panel("WAITING TO BE FILED", [
          nodes.pending,
          el("div", { class: "gb-actions" }, [nodes.fileBtn])
        ]),

        ui.panel("THE BOOK", [nodes.filed])
      ]));

      if (!isGuest()) await loadFiled();
      render();
    },

    unmount() { nodes = {}; filed = []; }
  });

  function injectCSS() {
    if (document.getElementById("gb-style")) return;
    var s = document.createElement("style");
    s.id = "gb-style";
    s.textContent = `
.gb-wrap{height:100%;overflow:auto}
.gb-input{width:100%;font-size:11px;line-height:1.6;resize:vertical;margin-top:8px}
.gb-actions{display:flex;gap:6px;margin-top:8px}
.gb-actions .fk-btn{flex:1}
.gb-note-block{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:0;
  border-left:2px solid var(--line2);padding-left:9px}
.gb-warn{font-size:10px;color:var(--warn);line-height:1.6;margin:0 0 8px;
  border-left:2px solid var(--warn);padding-left:9px}
.gb-list{max-height:260px;overflow:auto}
.gb-entry{padding:7px 0;border-bottom:1px solid var(--line)}
.gb-entry:last-child{border-bottom:none}
.gb-unfiled{border-left:2px solid var(--warn);padding-left:9px}
.gb-head{display:flex;align-items:baseline;gap:9px}
.gb-name{flex:1;font-size:10px;letter-spacing:.12em;color:var(--accent)}
.gb-when{font-size:9px;color:var(--fg-dimmer);letter-spacing:.08em}
.gb-head .fk-btn{padding:1px 7px;font-size:11px;line-height:1}
.gb-note{margin-top:4px;font-size:11px;line-height:1.65;color:var(--fg-dim);
  white-space:pre-wrap;word-break:break-word}
.gb-none{padding:12px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
