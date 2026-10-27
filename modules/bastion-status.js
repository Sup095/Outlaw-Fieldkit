/* ============================================================
   FieldKit :: bastion-status
   Service status board for the Bastion network (§4).

   Two layers, because the drive has to be useful with no network:

     MANUAL   a checklist you maintain by hand. Stored encrypted,
              works offline, and is the source of truth for "what
              is supposed to exist and who cares if it dies".
     LIVE     when the relay is reachable, GET /status probes each
              configured service and fills in the real answer.

   The manual layer is not a fallback for the live one — it holds
   things the live probe cannot know: what a service is for, how
   bad it is when it stops, and what you did about it last time.

   Read-only on purpose. There is no restart button and there will
   not be one here: mutating actions are tailnet-only (§9C), and a
   kill-switch reachable from a school Chromebook is a liability,
   not a feature.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "bastion-service";

  var CRITICALITY = ["CRITICAL", "IMPORTANT", "NICE-TO-HAVE"];
  var KINDS = ["host", "web", "service", "container", "tunnel", "other"];

  var ctx, ui, el, nodes = {};
  var services = [];       // manual records
  var live = null;         // last live probe result
  var probing = false;
  var editingId = null;

  /* ---- manual records ------------------------------------------ */
  async function load() {
    try { services = await ctx.store.list(TYPE); }
    catch (e) { services = []; }
    renderBoard();
    renderList();
  }

  async function save() {
    var name = nodes.name.value.trim();
    if (!name) { ui.toast("NAME REQUIRED", "warn"); return; }
    await ctx.store.put(TYPE, {
      name: name,
      kind: nodes.kind.value,
      criticality: nodes.criticality.value,
      host: nodes.host.value.trim(),
      purpose: nodes.purpose.value,
      manualState: nodes.manualState.value,
      checkedAt: new Date().toISOString(),
      notes: nodes.notes.value
    }, { id: editingId || undefined });
    ui.toast(editingId ? "SERVICE UPDATED" : "SERVICE ADDED", "ok");
    clearForm();
    await load();
  }

  function clearForm() {
    editingId = null;
    nodes.name.value = "";
    nodes.host.value = "";
    nodes.purpose.value = "";
    nodes.notes.value = "";
    nodes.kind.value = KINDS[0];
    nodes.criticality.value = CRITICALITY[0];
    nodes.manualState.value = "UNKNOWN";
    nodes.saveBtn.textContent = "ADD SERVICE";
    renderList();
  }

  function edit(id) {
    var s = services.find(function (x) { return x.id === id; });
    if (!s) return;
    editingId = id;
    nodes.name.value = s.data.name || "";
    nodes.kind.value = s.data.kind || KINDS[0];
    nodes.criticality.value = s.data.criticality || CRITICALITY[0];
    nodes.host.value = s.data.host || "";
    nodes.purpose.value = s.data.purpose || "";
    nodes.manualState.value = s.data.manualState || "UNKNOWN";
    nodes.notes.value = s.data.notes || "";
    nodes.saveBtn.textContent = "UPDATE SERVICE";
    renderList();
  }

  async function remove() {
    if (!editingId) return;
    if (!confirm("Remove this service from the board?")) return;
    await ctx.store.remove(editingId);
    clearForm();
    await load();
    ui.toast("SERVICE REMOVED", "warn");
  }

  /* ---- live probe ---------------------------------------------- */
  async function probe() {
    if (probing) return;
    var relay = FieldKit.service("transportRelay");
    if (!relay || ctx.store.transportName() !== "relay") {
      ui.toast("NOT CONNECTED TO THE RELAY — MANUAL VIEW ONLY", "warn");
      renderBoard();
      return;
    }

    probing = true;
    nodes.probeBtn.disabled = true;
    nodes.probeBtn.textContent = "PROBING...";
    renderBoard();

    var t0 = performance.now();
    try {
      live = await relay.status();
      live.clientMs = Math.round(performance.now() - t0);
      ui.toast("PROBE: " + live.up + "/" + live.total + " UP",
        live.up === live.total ? "ok" : (live.up ? "warn" : "fail"));
    } catch (e) {
      live = { error: e.message, at: new Date().toISOString(), services: [], total: 0, up: 0 };
      /* A 404 here means an old relay build, which is worth saying
         plainly rather than leaving as a generic failure. */
      if (/404|no such route/i.test(e.message)) {
        ui.toast("RELAY HAS NO /status ROUTE — UPDATE relay/server.js", "fail");
      } else {
        ui.toast("PROBE FAILED: " + e.message, "fail");
      }
    } finally {
      probing = false;
      nodes.probeBtn.disabled = false;
      nodes.probeBtn.textContent = "PROBE LIVE";
      renderBoard();
    }
  }

  /* Matches a live result to a manual record by name, case- and
     separator-insensitively, so "Bastion 1" and "bastion-1" line up. */
  function normalise(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function liveFor(name) {
    if (!live || !live.services) return null;
    var want = normalise(name);
    return live.services.find(function (s) { return normalise(s.name) === want; }) || null;
  }

  /* ---- board ---------------------------------------------------- */
  function renderBoard() {
    ui.clear(nodes.board);

    var summary = [];
    if (live && !live.error) {
      summary.push({ label: "LIVE PROBE", value: live.up + " / " + live.total + " UP",
        level: live.up === live.total ? "ok" : (live.up ? "warn" : "fail") });
      summary.push({ label: "PROBED", value: new Date(live.at).toLocaleTimeString() +
        "  (" + live.clientMs + " ms round trip)", level: "dim" });
      if (live.relay && live.relay.proxy) {
        summary.push({ label: "RELAY EGRESS", value: "VIA TAILSCALE PROXY", level: "dim" });
      }
    } else if (live && live.error) {
      summary.push({ label: "LIVE PROBE", value: "FAILED", level: "fail" });
      summary.push({ label: "REASON", value: live.error, level: "fail" });
    } else {
      summary.push({ label: "LIVE PROBE", value: probing ? "RUNNING..." : "NOT RUN THIS SESSION",
        level: "dim" });
    }

    var down = services.filter(function (s) {
      var l = liveFor(s.data.name);
      if (l) return !l.ok;
      return s.data.manualState === "DOWN";
    });
    var criticalDown = down.filter(function (s) { return s.data.criticality === "CRITICAL"; });

    summary.push({ label: "TRACKED", value: services.length + " service(s)", level: "dim" });
    if (services.length) {
      summary.push({ label: "DOWN", value: down.length ? String(down.length) : "NONE",
        level: criticalDown.length ? "fail" : (down.length ? "warn" : "ok") });
    }
    nodes.board.appendChild(ui.readout(summary));

    if (criticalDown.length) {
      nodes.board.appendChild(el("div", { class: "bs-alarm" }, [
        el("div", { class: "bs-alarm-title", text: "CRITICAL SERVICE DOWN" }),
        el("div", { class: "bs-alarm-body",
          text: criticalDown.map(function (s) { return s.data.name; }).join(" · ") })
      ]));
    }

    /* Services the relay reports but nobody has written down. Worth
       surfacing: it usually means the board is out of date. */
    if (live && live.services && live.services.length) {
      var untracked = live.services.filter(function (l) {
        return !services.some(function (s) { return normalise(s.data.name) === normalise(l.name); });
      });
      if (untracked.length) {
        nodes.board.appendChild(el("div", { class: "bs-note",
          text: "Relay reports " + untracked.length + " service(s) not on this board: " +
            untracked.map(function (u) { return u.name; }).join(", ") }));
      }
    }
  }

  function renderList() {
    ui.clear(nodes.list);
    if (!services.length) {
      nodes.list.appendChild(el("div", { class: "bs-none",
        text: "NO SERVICES TRACKED — ADD ONE ON THE RIGHT" }));
      return;
    }

    var order = { CRITICAL: 0, IMPORTANT: 1, "NICE-TO-HAVE": 2 };
    var sorted = services.slice().sort(function (a, b) {
      var d = (order[a.data.criticality] || 9) - (order[b.data.criticality] || 9);
      return d || String(a.data.name).localeCompare(String(b.data.name));
    });

    sorted.forEach(function (s) {
      var l = liveFor(s.data.name);
      var state, level, detail;

      if (l) {
        state = l.ok ? "UP" : "DOWN";
        level = l.ok ? "ok" : "bad";
        detail = l.ok ? ("HTTP " + l.status + " · " + l.ms + " ms")
          : (l.error ? l.error : "HTTP " + l.status);
      } else {
        state = s.data.manualState || "UNKNOWN";
        level = state === "UP" ? "ok" : state === "DOWN" ? "bad" : "warn";
        detail = s.data.checkedAt
          ? "manual · noted " + new Date(s.data.checkedAt).toLocaleDateString()
          : "manual · never checked";
      }

      nodes.list.appendChild(el("div", {
        class: "bs-item" + (s.id === editingId ? " active" : "") + " crit-" +
          normalise(s.data.criticality || "")
      }, [
        el("button", { class: "bs-item-main", type: "button",
          onclick: function () { edit(s.id); } }, [
          el("span", { class: "bs-item-head" }, [
            el("span", { class: "bs-item-name", text: s.data.name || "(unnamed)" }),
            el("span", { class: "bs-item-crit", text: s.data.criticality || "" })
          ]),
          el("span", { class: "bs-item-sub",
            text: (s.data.kind || "") + (s.data.host ? " · " + s.data.host : "") }),
          s.data.purpose ? el("span", { class: "bs-item-purpose", text: s.data.purpose }) : null
        ]),
        el("div", { class: "bs-item-state" }, [
          ui.statusDot(level, state),
          el("span", { class: "bs-item-detail", text: detail })
        ])
      ]));
    });
  }

  /* ---- probes --------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "ADD / LIST / REMOVE", critical: false, run: async function () {
        var marker = "SELFTEST-SVC-" + Math.random().toString(36).slice(2, 8);
        nodes.name.value = marker;
        nodes.host.value = "100.64.0.99";
        nodes.purpose.value = "created by the system exercise";
        nodes.criticality.value = "CRITICAL";
        nodes.manualState.value = "DOWN";
        await save();

        var mine = services.filter(function (s) { return s.data.name === marker; });
        if (mine.length !== 1) throw new Error("expected 1 service, found " + mine.length);
        api.sandbox.track(mine[0].id);

        if (!nodes.list.textContent.includes(marker)) throw new Error("service is not on the board");
        if (!/CRITICAL SERVICE DOWN/.test(nodes.board.textContent)) {
          throw new Error("a down critical service did not raise the alarm");
        }

        await ctx.store.remove(mine[0].id);
        clearForm();
        await load();
        if (/CRITICAL SERVICE DOWN/.test(nodes.board.textContent)) {
          throw new Error("the alarm persisted after the service was removed");
        }
        return "added, alarmed, removed";
      } },
      { name: "LIVE RESULTS MATCH BY NAME", critical: false, run: async function () {
        /* Name matching has to survive the difference between what
           you typed and what the relay config says. */
        live = { at: new Date().toISOString(), clientMs: 12, total: 2, up: 1,
          services: [
            { name: "bastion-1", ok: true, status: 200, ms: 9 },
            { name: "discord_bot", ok: false, error: "ECONNREFUSED", ms: 4000 }
          ] };
        if (!liveFor("Bastion 1")) throw new Error("'Bastion 1' did not match 'bastion-1'");
        if (!liveFor("DISCORD BOT")) throw new Error("'DISCORD BOT' did not match 'discord_bot'");
        if (liveFor("something-else")) throw new Error("an unrelated name matched");
        renderBoard();
        if (!/1 \/ 2 UP/.test(nodes.board.textContent)) throw new Error("summary did not render the count");
        live = null;
        renderBoard();
        return "case, spaces, dashes and underscores all normalise";
      } },
      { name: "PROBE FAILURE IS SURVIVABLE", critical: false, run: async function () {
        live = { error: "HTTP 404 no such route", at: new Date().toISOString(),
          services: [], total: 0, up: 0 };
        renderBoard();
        if (!/FAILED/.test(nodes.board.textContent)) throw new Error("a failed probe was not reported");
        if (!/404/.test(nodes.board.textContent)) throw new Error("the reason was not shown");
        live = null;
        renderBoard();
        return "reports the reason instead of going blank";
      } },
      { name: "READ ONLY — NO MUTATING CONTROLS", critical: true, run: async function () {
        /* §9C: nothing reachable from here may change a service's
           state. If a restart button ever appears, this fails. */
        var labels = [].map.call(api.host().querySelectorAll("button"), function (b) {
          return b.textContent.toUpperCase();
        });
        var bad = labels.filter(function (t) {
          return /RESTART|REBOOT|STOP|KILL|SHUTDOWN|POWER|START SERVICE/.test(t);
        });
        if (bad.length) throw new Error("mutating control present: " + bad.join(", "));
        return labels.length + " controls, none of them mutate a service";
      } }
    ];
  }

  FieldKit.register("bastion-status", {
    group: "SERVERS",
    about: "Which of the Bastion services are up",
    keywords: "status uptime services",
    /* A tab of BASTION rather than a tile of its own — see
       modules/bastion.js. It is still a whole module: it keeps its
       own selfchecks, its own lifecycle and its own id, and open()
       still reaches it. `inside` only tells the launcher not to
       draw a second icon for something already on screen. */
    inside: "bastion",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "BASTION STATUS",
    icon: "◉",
    width: 900,
    height: 620,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.board = el("div", { class: "bs-board" });
      nodes.list = el("div", { class: "bs-list" });

      nodes.name = el("input", { class: "fk-input", placeholder: "bastion-1", spellcheck: "false" });
      nodes.host = el("input", { class: "fk-input", placeholder: "100.64.0.3 or a hostname", spellcheck: "false" });
      nodes.purpose = el("input", { class: "fk-input", placeholder: "what it does" });
      nodes.notes = el("textarea", { class: "fk-input bs-notes", spellcheck: "false",
        placeholder: "what you did last time it broke" });

      nodes.kind = el("select", { class: "fk-input bs-select" });
      KINDS.forEach(function (k) { nodes.kind.appendChild(el("option", { value: k, text: k.toUpperCase() })); });

      nodes.criticality = el("select", { class: "fk-input bs-select" });
      CRITICALITY.forEach(function (c) { nodes.criticality.appendChild(el("option", { value: c, text: c })); });

      nodes.manualState = el("select", { class: "fk-input bs-select" });
      ["UNKNOWN", "UP", "DOWN"].forEach(function (s) {
        nodes.manualState.appendChild(el("option", { value: s, text: s }));
      });

      nodes.saveBtn = ui.button("ADD SERVICE", save, { primary: true });
      nodes.probeBtn = ui.button("PROBE LIVE", probe, { primary: true,
        title: "ask the relay to check every configured service" });

      host.appendChild(el("div", { class: "bs-wrap" }, [
        el("div", { class: "bs-left" }, [
          el("div", { class: "bs-actions" }, [
            nodes.probeBtn,
            ui.button("REFRESH", load)
          ]),
          nodes.board,
          nodes.list
        ]),
        el("div", { class: "bs-right" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "SERVICE NAME" }), nodes.name
          ]),
          el("p", { class: "bs-hint", text:
            "Match the name in the relay's statusServices config and the live probe will fill " +
            "itself in here." }),
          el("div", { class: "bs-row" }, [
            el("label", { class: "fk-field bs-f1" }, [
              el("span", { class: "fk-field-label", text: "KIND" }), nodes.kind
            ]),
            el("label", { class: "fk-field bs-f1" }, [
              el("span", { class: "fk-field-label", text: "CRITICALITY" }), nodes.criticality
            ])
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "HOST / ADDRESS" }), nodes.host
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "PURPOSE" }), nodes.purpose
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "MANUAL STATE (USED WHEN OFFLINE)" }), nodes.manualState
          ]),
          el("label", { class: "fk-field bs-notesfield" }, [
            el("span", { class: "fk-field-label", text: "NOTES" }), nodes.notes
          ]),
          el("div", { class: "bs-actions" }, [
            nodes.saveBtn,
            ui.button("CLEAR", clearForm),
            ui.button("REMOVE", remove, { danger: true })
          ]),
          el("p", { class: "bs-footnote", text:
            "Read-only by design. The relay can look at these services but has no route that can " +
            "start, stop, or restart one — mutating actions stay on the tailnet." })
        ])
      ]));

      await load();
    },

    unmount() {
      nodes = {}; services = []; live = null; editingId = null; probing = false;
    },

    searchIndex() {
      return services.map(function (s) {
        return {
          id: s.id, module: "bastion-status",
          title: s.data.name || "(unnamed)",
          body: [s.data.kind, s.data.host, s.data.purpose, s.data.criticality, s.data.notes]
            .filter(Boolean).join(" ")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("bs-style")) return;
    var s = document.createElement("style");
    s.id = "bs-style";
    s.textContent = `
.bs-wrap{display:flex;gap:12px;height:100%;min-height:0}
.bs-left{flex:1;display:flex;flex-direction:column;gap:9px;min-width:0;min-height:0}
.bs-right{width:300px;flex:none;display:flex;flex-direction:column;min-height:0;overflow:auto}
.bs-actions{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.bs-actions .fk-btn{flex:1;min-width:96px}
.bs-board{flex:none;border:1px solid var(--line);background:var(--bg2);padding:9px 11px}
.bs-alarm{margin-top:9px;border:1px solid var(--fail);background:rgba(224,80,60,.08);padding:8px 10px}
.bs-alarm-title{color:var(--fail);font-size:9px;letter-spacing:.22em;margin-bottom:4px}
.bs-alarm-body{color:var(--fg);font-size:11px;letter-spacing:.08em}
.bs-note{margin-top:9px;font-size:9px;color:var(--fg-dimmer);line-height:1.6;
  border-left:2px solid var(--line2);padding-left:9px}
.bs-list{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);min-height:0}
.bs-item{display:flex;align-items:stretch;border-bottom:1px solid var(--line)}
.bs-item:hover{background:rgba(var(--accent-glow),.07)}
.bs-item.active{background:rgba(var(--accent-glow),.13)}
.bs-item.crit-critical{border-left:2px solid var(--fail)}
.bs-item.crit-important{border-left:2px solid var(--warn)}
.bs-item.crit-nicetohave{border-left:2px solid var(--line2)}
.bs-item-main{flex:1;text-align:left;background:none;border:0;padding:8px 10px;cursor:pointer;min-width:0}
.bs-item-head{display:flex;align-items:baseline;gap:8px}
.bs-item-name{font-size:11px;color:var(--fg);letter-spacing:.08em}
.bs-item.active .bs-item-name{color:var(--accent)}
.bs-item-crit{font-size:8px;letter-spacing:.14em;color:var(--fg-dimmer)}
.bs-item-sub{display:block;font-size:9px;color:var(--fg-dimmer);margin-top:2px}
.bs-item-purpose{display:block;font-size:9px;color:var(--fg-dim);margin-top:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bs-item-state{flex:none;display:flex;flex-direction:column;align-items:flex-end;justify-content:center;
  gap:3px;padding:8px 10px;border-left:1px solid var(--line);min-width:150px}
.bs-item-detail{font-size:8px;color:var(--fg-dimmer);text-align:right;
  max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-none{padding:16px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
.bs-row{display:flex;gap:8px;flex:none}
.bs-f1{flex:1;min-width:0}
.bs-select{padding:8px 9px}
.bs-hint{font-size:9px;color:var(--fg-dimmer);line-height:1.55;margin:-6px 0 12px;
  border-left:2px solid var(--line2);padding-left:9px}
.bs-notesfield{display:flex;flex-direction:column}
.bs-notes{min-height:70px;resize:vertical;line-height:1.5}
.bs-footnote{font-size:9px;color:var(--fg-dimmer);line-height:1.6;margin:10px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
