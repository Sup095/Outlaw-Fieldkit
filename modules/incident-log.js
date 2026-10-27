/* ============================================================
   FieldKit :: incident-log
   "Server did X weird thing" entries, tagged by system, searchable.

   The point of this module over a plain note: when you log a new
   incident it is compared against everything already recorded, so
   "this matches 3 other incidents" surfaces on its own (§9 tier 3).
   That works with no model and no network.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "incident";
  var SYSTEMS = ["BASTION-1", "BASTION-2", "PTERODACTYL", "RELAY", "DISCORD BOT",
                 "TAILSCALE", "DUCKDNS", "LORA MESH", "OTHER"];
  var SEVERITY = ["INFO", "DEGRADED", "DOWN"];

  var ctx, ui, el, nodes = {}, incidents = [], editingId = null, filter = "";

  function t3() { return FieldKit.service("aiTier3"); }

  async function load() {
    incidents = await ctx.store.list(TYPE);
    renderList();
    renderStats();
  }

  function related(text, excludeId) {
    var corpus = incidents
      .filter(function (i) { return i.id !== excludeId; })
      .map(function (i) { return { id: i.id, text: (i.data.title || "") + " " + (i.data.detail || ""), data: i.data }; });
    return t3().findSimilar(text, corpus, 0.4);
  }

  function showRelated(text, excludeId) {
    ui.clear(nodes.related);
    if (!text.trim()) return;
    var hits = related(text, excludeId);
    if (!hits.length) {
      nodes.related.appendChild(el("div", { class: "il-none", text: "NO SIMILAR INCIDENTS ON RECORD" }));
      return;
    }
    nodes.related.appendChild(el("div", { class: "il-flag",
      text: "⚠ MATCHES " + hits.length + " EXISTING INCIDENT" + (hits.length > 1 ? "S" : "") }));
    var ach = FieldKit.service("achievements");
    if (ach) ach.noteIncidentMatch();
    hits.slice(0, 5).forEach(function (h) {
      nodes.related.appendChild(el("button", {
        class: "il-related", type: "button",
        onclick: function () { edit(h.item.id); }
      }, [
        el("span", { class: "il-score", text: Math.round(h.score * 100) + "%" }),
        el("span", { class: "il-rel-title", text: h.item.data.title || "(untitled)" }),
        el("span", { class: "il-rel-date", text: new Date(h.item.data.at || 0).toLocaleDateString() })
      ]));
    });
  }

  async function save() {
    var title = nodes.title.value.trim();
    if (!title) { ui.toast("TITLE REQUIRED", "warn"); return; }

    var detail = nodes.detail.value;
    var payload = {
      title: title,
      detail: detail,
      system: nodes.system.value,
      severity: nodes.severity.value,
      at: nodes.when.value || new Date().toISOString(),
      resolved: nodes.resolved.checked,
      tags: t3().tag(title + " " + detail, 6)
    };

    await ctx.store.put(TYPE, payload, { id: editingId || undefined });
    ui.toast(editingId ? "INCIDENT UPDATED" : "INCIDENT LOGGED", "ok");
    clearForm();
    await load();
  }

  function clearForm() {
    editingId = null;
    nodes.title.value = "";
    nodes.detail.value = "";
    nodes.system.value = SYSTEMS[0];
    nodes.severity.value = SEVERITY[1];
    nodes.when.value = "";
    nodes.resolved.checked = false;
    nodes.saveBtn.textContent = "LOG INCIDENT";
    ui.clear(nodes.related);
    renderList();
  }

  function edit(id) {
    var inc = incidents.find(function (i) { return i.id === id; });
    if (!inc) return;
    editingId = id;
    nodes.title.value = inc.data.title || "";
    nodes.detail.value = inc.data.detail || "";
    nodes.system.value = inc.data.system || SYSTEMS[0];
    nodes.severity.value = inc.data.severity || SEVERITY[1];
    nodes.when.value = inc.data.at || "";
    nodes.resolved.checked = !!inc.data.resolved;
    nodes.saveBtn.textContent = "UPDATE INCIDENT";
    showRelated(nodes.title.value + " " + nodes.detail.value, id);
    renderList();
  }

  async function remove() {
    if (!editingId) return;
    if (!confirm("Delete this incident?")) return;
    await ctx.store.remove(editingId);
    clearForm();
    await load();
    ui.toast("INCIDENT DELETED", "warn");
  }

  function renderList() {
    ui.clear(nodes.list);
    var f = filter.toLowerCase();
    var shown = incidents.filter(function (i) {
      if (!f) return true;
      var hay = [i.data.title, i.data.detail, i.data.system, i.data.severity]
        .concat(i.data.tags || []).join(" ").toLowerCase();
      return hay.indexOf(f) >= 0;
    });

    if (!shown.length) {
      nodes.list.appendChild(el("div", { class: "il-none",
        text: incidents.length ? "NO MATCHES" : "NOTHING LOGGED YET" }));
      return;
    }

    shown.forEach(function (i) {
      var d = i.data;
      nodes.list.appendChild(el("button", {
        class: "il-item" + (i.id === editingId ? " active" : "") + (d.resolved ? " resolved" : ""),
        type: "button", onclick: function () { edit(i.id); }
      }, [
        el("div", { class: "il-item-head" }, [
          el("span", { class: "il-sev sev-" + (d.severity || "INFO"), text: d.severity || "INFO" }),
          el("span", { class: "il-sys", text: d.system || "OTHER" }),
          el("span", { class: "il-date", text: new Date(d.at || i.meta.updatedAt).toLocaleDateString() }),
          d.resolved ? el("span", { class: "il-ok", text: "RESOLVED" }) : null
        ]),
        el("div", { class: "il-item-title", text: d.title || "(untitled)" }),
        (d.tags && d.tags.length)
          ? el("div", { class: "il-tags", text: d.tags.slice(0, 5).join(" · ") })
          : null
      ]));
    });
  }

  function renderStats() {
    ui.clear(nodes.stats);
    if (!incidents.length) return;
    var open = incidents.filter(function (i) { return !i.data.resolved; }).length;
    var bySystem = {};
    incidents.forEach(function (i) {
      var s = i.data.system || "OTHER";
      bySystem[s] = (bySystem[s] || 0) + 1;
    });
    var worst = Object.keys(bySystem).sort(function (a, b) { return bySystem[b] - bySystem[a]; })[0];
    nodes.stats.appendChild(ui.readout([
      { label: "TOTAL", value: incidents.length, level: "dim" },
      { label: "OPEN", value: open, level: open ? "warn" : "pass" },
      { label: "MOST AFFECTED", value: worst + " (" + bySystem[worst] + ")", level: "info" }
    ]));
  }

  function select(labelText, options, value) {
    var sel = el("select", { class: "fk-input il-select" });
    options.forEach(function (o) {
      sel.appendChild(el("option", { value: o, text: o, selected: o === value ? true : null }));
    });
    var wrap = el("label", { class: "fk-field" }, [
      el("span", { class: "fk-field-label", text: labelText }), sel
    ]);
    wrap.input = sel;
    return { wrap: wrap, input: sel };
  }

  function selfcheck(api) {
    return [
      { name: "LOG / LIST / DELETE", critical: false, run: async function () {
        var marker = "SELFTEST relay unreachable " + Math.random().toString(36).slice(2, 8);
        nodes.title.value = marker;
        nodes.detail.value = "The relay stopped answering after the container restarted.";
        nodes.system.value = nodes.system.options[0].value;
        await save();

        var mine = incidents.filter(function (i) { return i.data.title === marker; });
        if (mine.length !== 1) throw new Error("expected 1 logged incident, found " + mine.length);
        api.sandbox.track(mine[0].id);
        if (!mine[0].data.tags || !mine[0].data.tags.length) throw new Error("no tags were derived");

        await ctx.store.remove(mine[0].id);
        await load();
        return "logged with " + mine[0].data.tags.length + " auto-tag(s), then removed";
      } },
      /* The feature that makes this module worth having: it must
         notice a near-duplicate before you finish typing. */
      { name: "SIMILARITY FLAGS A DUPLICATE", critical: false, run: async function () {
        var base = "SELFTEST nginx returned 502 after the docker container restarted";
        nodes.title.value = base;
        nodes.detail.value = "Reverse proxy could not reach the upstream service.";
        await save();
        var first = incidents.filter(function (i) { return i.data.title === base; })[0];
        if (!first) throw new Error("setup incident was not saved");
        api.sandbox.track(first.id);

        showRelated("nginx gave a 502 once the docker container was restarted", null);
        var flagged = /MATCHES \d+ EXISTING INCIDENT/.test(nodes.related.textContent);

        showRelated("the wallpaper gradient looks wrong in the violet palette", null);
        var quiet = /NO SIMILAR INCIDENTS/.test(nodes.related.textContent);

        await ctx.store.remove(first.id);
        clearForm();
        await load();

        if (!flagged) throw new Error("a near-duplicate was not flagged");
        if (!quiet) throw new Error("an unrelated incident was wrongly flagged as similar");
        return "flagged the duplicate, ignored the unrelated one";
      } },
      { name: "STATS RENDER", critical: false, run: async function () {
        renderStats();
        return incidents.length ? "rendered for " + incidents.length + " incident(s)"
          : "no incidents on record — nothing to summarise";
      } }
    ];
  }

  FieldKit.register("incident-log", {
    group: "PROJECT",
    about: "Server problems you have seen, matched to earlier ones",
    keywords: "incidents server problems outage log errors",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "INCIDENT LOG",
    icon: "⚠",
    width: 860,
    height: 580,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.search = el("input", { class: "fk-input il-search", placeholder: "SEARCH INCIDENTS",
        oninput: function (e) { filter = e.target.value; renderList(); } });
      nodes.list = el("div", { class: "il-list" });
      nodes.stats = el("div", { class: "il-stats" });

      nodes.title = el("input", { class: "fk-input", placeholder: "what happened",
        oninput: function () { showRelated(nodes.title.value + " " + nodes.detail.value, editingId); } });
      nodes.detail = el("textarea", { class: "fk-input il-detail", rows: "6", spellcheck: "false",
        placeholder: "symptoms, logs, what you tried, what fixed it",
        oninput: function () { showRelated(nodes.title.value + " " + nodes.detail.value, editingId); } });

      var sys = select("SYSTEM", SYSTEMS, SYSTEMS[0]);
      var sev = select("SEVERITY", SEVERITY, SEVERITY[1]);
      nodes.system = sys.input;
      nodes.severity = sev.input;
      nodes.when = el("input", { class: "fk-input", type: "text", placeholder: "ISO timestamp (blank = now)" });
      nodes.resolved = el("input", { type: "checkbox" });
      nodes.related = el("div", { class: "il-relbox" });
      nodes.saveBtn = ui.button("LOG INCIDENT", save, { primary: true });

      host.appendChild(el("div", { class: "il-wrap" }, [
        el("div", { class: "il-side" }, [
          nodes.search, nodes.stats, nodes.list,
          el("div", { class: "il-side-actions" }, [ui.button("NEW", clearForm)])
        ]),
        el("div", { class: "il-main" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "TITLE" }), nodes.title
          ]),
          el("div", { class: "il-row" }, [sys.wrap, sev.wrap]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "WHEN" }), nodes.when
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "DETAIL" }), nodes.detail
          ]),
          nodes.related,
          el("label", { class: "il-check" }, [nodes.resolved, el("span", { text: "RESOLVED" })]),
          el("div", { class: "il-actions" }, [
            nodes.saveBtn,
            ui.button("CLEAR", clearForm),
            ui.button("DELETE", remove, { danger: true })
          ])
        ])
      ]));

      await load();
    },

    unmount() { nodes = {}; incidents = []; editingId = null; filter = ""; },

    searchIndex() {
      return incidents.map(function (i) {
        return {
          id: i.id, module: "incident-log",
          title: i.data.title || "(untitled)",
          body: [i.data.system, i.data.severity, i.data.detail].concat(i.data.tags || []).join(" ")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("il-style")) return;
    var s = document.createElement("style");
    s.id = "il-style";
    s.textContent = `
.il-wrap{display:flex;gap:10px;height:100%;min-height:0}
.il-side{width:250px;flex:none;display:flex;flex-direction:column;gap:8px;min-height:0}
.il-search{padding:6px 8px;font-size:11px;letter-spacing:.1em}
.il-stats{flex:none}
.il-list{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);min-height:0}
.il-side-actions{flex:none;display:flex;gap:6px}
.il-side-actions .fk-btn{flex:1}
.il-item{display:block;width:100%;text-align:left;padding:7px 9px;background:none;border:0;
  border-bottom:1px solid var(--line);cursor:pointer}
.il-item:hover{background:rgba(var(--accent-glow),.07)}
.il-item.active{background:rgba(var(--accent-glow),.13);border-left:2px solid var(--accent)}
.il-item.resolved{opacity:.55}
.il-item-head{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
.il-sev{font-size:8px;letter-spacing:.12em;padding:1px 4px;border:1px solid currentColor}
.sev-INFO{color:var(--info)} .sev-DEGRADED{color:var(--warn)} .sev-DOWN{color:var(--fail)}
.il-sys{font-size:9px;color:var(--fg-dimmer);letter-spacing:.1em}
.il-date{font-size:9px;color:var(--fg-dimmer);margin-left:auto}
.il-ok{font-size:8px;color:var(--pass);letter-spacing:.1em}
.il-item-title{color:var(--fg);font-size:11px;line-height:1.35}
.il-tags{font-size:9px;color:var(--fg-dimmer);margin-top:3px}
.il-main{flex:1;display:flex;flex-direction:column;min-width:0;overflow:auto}
.il-row{display:flex;gap:8px}
.il-row .fk-field{flex:1}
.il-select{padding:8px 9px}
.il-detail{resize:vertical;line-height:1.5}
.il-relbox{margin-bottom:10px}
.il-flag{color:var(--warn);font-size:10px;letter-spacing:.14em;margin-bottom:5px}
.il-none{padding:12px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
.il-related{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:#0e1210;
  border:1px solid var(--line2);color:var(--fg-dim);padding:5px 8px;margin-bottom:3px;cursor:pointer}
.il-related:hover{border-color:var(--warn);color:var(--warn)}
.il-score{font-size:9px;color:var(--warn);width:34px;flex:none}
.il-rel-title{flex:1;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.il-rel-date{font-size:9px;color:var(--fg-dimmer)}
.il-check{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:10px;
  letter-spacing:.16em;color:var(--fg-dim);cursor:pointer}
.il-actions{display:flex;gap:6px;flex-wrap:wrap}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
