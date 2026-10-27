/* ============================================================
   FieldKit :: config-vault
   Known-good configs: systemd units, sudoers snippets, BIOS fix
   notes, firewall rules (§4). The point is that hard-won fixes
   stop living in your head or a lost terminal buffer.

   Distinct from the snippet library because these carry operational
   metadata — which host it was verified on, when, and whether
   applying it can break something.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "config";
  var KINDS = ["systemd unit", "sudoers", "bios / firmware", "network", "firewall",
               "docker / pterodactyl", "shell script", "other"];
  var SYSTEMS = ["BASTION-1", "BASTION-2", "PTERODACTYL", "RELAY", "LOCAL PC", "MAIN PC", "OTHER"];

  var ctx, ui, el, nodes = {}, entries = [], editingId = null, filter = "";

  async function load() {
    entries = await ctx.store.list(TYPE);
    renderList();
  }

  async function save() {
    var title = nodes.title.value.trim();
    if (!title) { ui.toast("TITLE REQUIRED", "warn"); return; }
    if (!nodes.body.value.trim()) { ui.toast("CONFIG IS EMPTY", "warn"); return; }

    await ctx.store.put(TYPE, {
      title: title,
      kind: nodes.kind.value,
      system: nodes.system.value,
      path: nodes.path.value.trim(),
      body: nodes.body.value,
      why: nodes.why.value,
      verifiedOn: nodes.verified.value.trim(),
      dangerous: nodes.dangerous.checked
    }, { id: editingId || undefined });

    ui.toast(editingId ? "CONFIG UPDATED" : "CONFIG STORED", "ok");
    await load();
  }

  function clearForm() {
    editingId = null;
    ["title", "path", "why", "verified"].forEach(function (k) { nodes[k].value = ""; });
    nodes.body.value = "";
    nodes.kind.value = KINDS[0];
    nodes.system.value = SYSTEMS[0];
    nodes.dangerous.checked = false;
    nodes.saveBtn.textContent = "STORE CONFIG";
    renderList();
  }

  function edit(id) {
    var e = entries.find(function (x) { return x.id === id; });
    if (!e) return;
    editingId = id;
    nodes.title.value = e.data.title || "";
    nodes.kind.value = e.data.kind || KINDS[0];
    nodes.system.value = e.data.system || SYSTEMS[0];
    nodes.path.value = e.data.path || "";
    nodes.body.value = e.data.body || "";
    nodes.why.value = e.data.why || "";
    nodes.verified.value = e.data.verifiedOn || "";
    nodes.dangerous.checked = !!e.data.dangerous;
    nodes.saveBtn.textContent = "UPDATE CONFIG";
    renderList();
  }

  async function remove() {
    if (!editingId) return;
    if (!confirm("Delete this config? If it's a fix you fought for, consider exporting it first.")) return;
    await ctx.store.remove(editingId);
    clearForm();
    await load();
    ui.toast("CONFIG DELETED", "warn");
  }

  function copyBody(text) {
    /* A secret on screen in a modal is worse than one that failed to
       copy, so this stops at the clipboard rather than dumping it. */
    ui.copy(text, { silent: true }).then(function (how) {
      ui.toast(how ? "COPIED" : "CLIPBOARD BLOCKED — REVEAL THE VALUE AND COPY IT BY HAND",
        how ? "ok" : "warn");
    });
  }

  function renderList() {
    ui.clear(nodes.list);
    var f = filter.toLowerCase();
    var shown = entries.filter(function (e) {
      if (!f) return true;
      return [e.data.title, e.data.kind, e.data.system, e.data.path, e.data.body, e.data.why]
        .join(" ").toLowerCase().indexOf(f) >= 0;
    });

    if (!shown.length) {
      nodes.list.appendChild(el("div", { class: "cv-none",
        text: entries.length ? "NO MATCHES" : "VAULT EMPTY" }));
      return;
    }

    shown.forEach(function (e) {
      nodes.list.appendChild(el("div", {
        class: "cv-item" + (e.id === editingId ? " active" : "")
      }, [
        el("button", { class: "cv-item-main", type: "button", onclick: function () { edit(e.id); } }, [
          el("span", { class: "cv-item-head" }, [
            e.data.dangerous ? el("span", { class: "cv-danger", text: "!" }) : null,
            el("span", { class: "cv-item-title", text: e.data.title || "(untitled)" })
          ]),
          el("span", { class: "cv-item-meta", text: (e.data.system || "") + " · " + (e.data.kind || "") }),
          e.data.path ? el("span", { class: "cv-item-path", text: e.data.path }) : null
        ]),
        el("button", { class: "cv-copy", type: "button", text: "COPY",
          onclick: function (ev) { ev.stopPropagation(); copyBody(e.data.body || ""); } })
      ]));
    });
  }

  function select(labelText, options) {
    var sel = el("select", { class: "fk-input cv-select" });
    options.forEach(function (o) { sel.appendChild(el("option", { value: o, text: o })); });
    var wrap = el("label", { class: "fk-field" }, [
      el("span", { class: "fk-field-label", text: labelText }), sel
    ]);
    return { wrap: wrap, input: sel };
  }

  function selfcheck(api) {
    return [
      { name: "STORE / LIST / DELETE", critical: false, run: async function () {
        var marker = "SELFTEST-CONFIG-" + Math.random().toString(36).slice(2, 8);
        nodes.title.value = marker;
        nodes.body.value = "server { listen 80; }";
        nodes.path.value = "/etc/nginx/conf.d/probe.conf";
        nodes.why.value = "created by the system exercise";
        nodes.verified.value = "2026-08-12";
        nodes.dangerous.checked = true;
        await save();

        var mine = entries.filter(function (e) { return e.data.title === marker; });
        if (mine.length !== 1) throw new Error("expected 1 stored config, found " + mine.length);
        api.sandbox.track(mine[0].id);

        /* The flag is the whole reason this is separate from
           snippets — it must survive a save/load cycle. */
        if (mine[0].data.dangerous !== true) throw new Error("the 'can break things' flag was not persisted");
        if (mine[0].data.verifiedOn !== "2026-08-12") throw new Error("verified-on date was not persisted");

        await ctx.store.remove(mine[0].id);
        clearForm();
        await load();
        return "stored with operational metadata intact, then removed";
      } }
    ];
  }

  FieldKit.register("config-vault", {
    group: "FILES",
    about: "Known-good server configs and fixes, kept safe",
    keywords: "config systemd sudoers bios firewall fixes server notes",
    selfcheck: selfcheck,
    title: "CONFIG VAULT",
    icon: "🗝",
    width: 900,
    height: 600,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.search = el("input", { class: "fk-input cv-search", placeholder: "SEARCH VAULT",
        oninput: function (e) { filter = e.target.value; renderList(); } });
      nodes.list = el("div", { class: "cv-list" });

      nodes.title = el("input", { class: "fk-input", placeholder: "what this config does" });
      nodes.path = el("input", { class: "fk-input", placeholder: "/etc/systemd/system/thing.service" });
      nodes.body = el("textarea", { class: "fk-input cv-body", spellcheck: "false",
        placeholder: "the actual config" });
      nodes.why = el("textarea", { class: "fk-input cv-why", rows: "3", spellcheck: "false",
        placeholder: "why it was needed, what broke without it" });
      nodes.verified = el("input", { class: "fk-input", placeholder: "e.g. Bastion-1, 2026-08-11" });
      nodes.dangerous = el("input", { type: "checkbox" });

      var kind = select("KIND", KINDS);
      var system = select("SYSTEM", SYSTEMS);
      nodes.kind = kind.input;
      nodes.system = system.input;
      nodes.saveBtn = ui.button("STORE CONFIG", save, { primary: true });

      nodes.body.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      });

      host.appendChild(el("div", { class: "cv-wrap" }, [
        el("div", { class: "cv-side" }, [
          nodes.search, nodes.list,
          el("div", { class: "cv-side-actions" }, [ui.button("NEW", clearForm)])
        ]),
        el("div", { class: "cv-main" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "TITLE" }), nodes.title
          ]),
          el("div", { class: "cv-row" }, [kind.wrap, system.wrap]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "FILE PATH" }), nodes.path
          ]),
          el("label", { class: "fk-field cv-bodyfield" }, [
            el("span", { class: "fk-field-label", text: "CONFIG" }), nodes.body
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "WHY / WHAT IT FIXED" }), nodes.why
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "VERIFIED ON" }), nodes.verified
          ]),
          el("label", { class: "cv-check" }, [
            nodes.dangerous,
            el("span", { text: "APPLYING THIS CAN BREAK THINGS — FLAG IT" })
          ]),
          el("div", { class: "cv-actions" }, [
            nodes.saveBtn,
            ui.button("COPY", function () { copyBody(nodes.body.value); }),
            ui.button("CLEAR", clearForm),
            ui.button("DELETE", remove, { danger: true })
          ])
        ])
      ]));

      await load();
    },

    unmount() { nodes = {}; entries = []; editingId = null; filter = ""; },

    searchIndex() {
      return entries.map(function (e) {
        return {
          id: e.id, module: "config-vault",
          title: e.data.title || "(untitled)",
          body: [e.data.kind, e.data.system, e.data.path, e.data.why, e.data.body].join(" ")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("cv-style")) return;
    var s = document.createElement("style");
    s.id = "cv-style";
    s.textContent = `
.cv-wrap{display:flex;gap:10px;height:100%;min-height:0}
.cv-side{width:250px;flex:none;display:flex;flex-direction:column;gap:8px;min-height:0}
.cv-search{padding:6px 8px;font-size:11px;letter-spacing:.1em}
.cv-list{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);min-height:0}
.cv-side-actions{flex:none;display:flex;gap:6px}
.cv-side-actions .fk-btn{flex:1}
.cv-item{display:flex;border-bottom:1px solid var(--line)}
.cv-item:hover{background:rgba(var(--accent-glow),.07)}
.cv-item.active{background:rgba(var(--accent-glow),.13);border-left:2px solid var(--accent)}
.cv-item-main{flex:1;text-align:left;background:none;border:0;padding:7px 9px;cursor:pointer;min-width:0}
.cv-item-head{display:flex;align-items:center;gap:5px}
.cv-danger{color:var(--fail);font-weight:700;flex:none}
.cv-item-title{color:var(--fg);font-size:11px;letter-spacing:.06em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-item.active .cv-item-title{color:var(--accent)}
.cv-item-meta{display:block;font-size:9px;color:var(--fg-dimmer);letter-spacing:.08em;margin-top:2px}
.cv-item-path{display:block;font-size:9px;color:var(--fg-dimmer);margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-copy{flex:none;background:none;border:0;border-left:1px solid var(--line);color:var(--fg-dimmer);
  font:inherit;font-size:9px;letter-spacing:.1em;padding:0 8px;cursor:pointer}
.cv-copy:hover{color:var(--accent);background:rgba(var(--accent-glow),.1)}
.cv-main{flex:1;display:flex;flex-direction:column;min-width:0;overflow:auto}
.cv-row{display:flex;gap:8px}
.cv-row .fk-field{flex:1}
.cv-select{padding:8px 9px}
.cv-bodyfield{flex:1;display:flex;flex-direction:column;min-height:150px}
.cv-body{flex:1;resize:vertical;line-height:1.5;min-height:130px}
.cv-why{resize:vertical;line-height:1.5}
.cv-check{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:9px;
  letter-spacing:.12em;color:var(--fail);cursor:pointer}
.cv-actions{display:flex;gap:6px;flex-wrap:wrap}
.cv-none{padding:14px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
