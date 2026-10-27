/* ============================================================
   FieldKit :: security-mockup
   Design sandbox for the Bastion security tab. (§4)

   The real thing is a Flask dashboard that does not exist yet.
   This is where its shape gets decided, offline, before anyone
   writes a route.

   The temptation with a mockup is to draw a pretty dashboard full
   of invented numbers and call it progress. That is worth almost
   nothing, and it is actively dangerous the first time somebody
   glances at it and reads the fake numbers as real. So this leans
   the other way:

     - every sample figure is stamped SYNTHETIC, on screen, always
     - the module cannot reach the network at all, by construction
     - the part that gets exported is the POLICY, not the pixels

   The policy is the real artifact. Detective observes and
   proposes; Enforcer acts, but only from a fixed list; some things
   only a human may do. Getting that table right is the whole
   design problem, and a linter here catches the mistakes that
   would otherwise be found in production by a restarted server.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "secdesign";

  /* Blast radius, worst first. The policy linter reads these. */
  var RADIUS = {
    observe:    { label: "OBSERVE",    rank: 0, note: "reads state, changes nothing" },
    reversible: { label: "REVERSIBLE", rank: 1, note: "undoable in one step" },
    disruptive: { label: "DISRUPTIVE", rank: 2, note: "interrupts players or services" },
    destructive:{ label: "DESTRUCTIVE",rank: 3, note: "loses data or state permanently" }
  };

  var ACTORS = {
    detective: { label: "DETECTIVE", note: "the watcher — may propose, never act" },
    enforcer:  { label: "ENFORCER",  note: "acts automatically from the whitelist" },
    human:     { label: "HUMAN",     note: "requires a person to press it" }
  };

  var PANELS = [
    { id: "feed",      label: "DETECTION FEED",    note: "what Detective noticed, newest first" },
    { id: "queue",     label: "PROPOSAL QUEUE",    note: "proposed actions awaiting a verdict" },
    { id: "whitelist", label: "ACTION WHITELIST",  note: "the fixed set Enforcer may run" },
    { id: "audit",     label: "AUDIT TRAIL",       note: "every action taken, with who and why" },
    { id: "limits",    label: "RATE LIMITS",       note: "how often each action may fire" },
    { id: "health",    label: "SERVICE HEALTH",    note: "the boring status strip" }
  ];

  /* Sample rows. Deliberately absurd hostnames and round numbers —
     nothing here should ever be mistaken for a reading. */
  var SAMPLE_FEED = [
    { at: "T-00:02", sev: "high", text: "12 failed SSH auths from 203.0.113.9 in 40s" },
    { at: "T-00:11", sev: "med",  text: "minecraft-1 heap at 94% for 6 minutes" },
    { at: "T-01:20", sev: "low",  text: "new process 'xmrig-ish' seen on bastion-2" },
    { at: "T-03:44", sev: "low",  text: "cert for duckdns leg expires in 11 days" }
  ];

  var SAMPLE_QUEUE = [
    { action: "ban-ip", why: "matched brute-force rule", verdict: "auto-approved" },
    { action: "restart-minecraft", why: "heap exhaustion", verdict: "waiting on human" },
    { action: "wipe-world", why: "operator request", verdict: "refused — not whitelisted" }
  ];

  /* The shipped starting policy. This is a real proposal, not
     filler — it is the list I would actually give Enforcer. */
  var DEFAULT_ACTIONS = [
    { id: "read-logs", label: "Pull recent logs", radius: "observe",
      actor: "enforcer", tailnetOnly: false, cooldownS: 10,
      note: "Read-only, so it is safe over the public leg." },
    { id: "service-status", label: "Query service status", radius: "observe",
      actor: "enforcer", tailnetOnly: false, cooldownS: 5, note: "" },
    { id: "ban-ip", label: "Ban an IP for 24h", radius: "reversible",
      actor: "enforcer", tailnetOnly: true, cooldownS: 30,
      note: "Reversible and time-boxed, which is what makes it safe to automate." },
    { id: "kick-player", label: "Kick a player", radius: "disruptive",
      actor: "human", tailnetOnly: true, cooldownS: 60,
      note: "Disruptive to a person. A false positive here costs goodwill." },
    { id: "restart-minecraft", label: "Restart the Minecraft server", radius: "disruptive",
      actor: "human", tailnetOnly: true, cooldownS: 300,
      note: "Interrupts everyone online. Never automatic." },
    { id: "rotate-keys", label: "Rotate relay tokens", radius: "destructive",
      actor: "human", tailnetOnly: true, cooldownS: 3600,
      note: "Locks out every existing client until they are re-provisioned." }
  ];

  var DEFAULT_LAYOUT = ["feed", "queue", "whitelist", "audit"];

  var ctx, ui, el, nodes = {};
  var design = null, designs = [];
  var savePaused = false;

  /* ---- the policy linter -----------------------------------------
     Four rules, each one earned:

       1. Nothing destructive runs by itself. Ever.
       2. Detective proposes; it never acts. If Detective is set as
          the actor on anything that changes state, the split has
          collapsed and there is no second pair of eyes.
       3. Anything that changes state is tailnet-only — §9D, decided
          when the Funnel leg went public.
       4. An automatic action with no cooldown is a loop waiting to
          happen. Enforcer reacting to the consequences of its own
          last action is the classic way this goes wrong.
     ------------------------------------------------------------- */
  function lint(actions) {
    var out = [];
    (actions || []).forEach(function (a) {
      var r = RADIUS[a.radius] || RADIUS.observe;
      var mutating = r.rank > 0;
      var automatic = a.actor === "enforcer" || a.actor === "detective";

      if (a.radius === "destructive" && automatic) {
        out.push({ level: "fail", id: a.id, text:
          "\"" + a.label + "\" is destructive and set to run automatically. " +
          "Destructive actions need a human — there is no undo to fall back on." });
      }
      if (a.actor === "detective" && mutating) {
        out.push({ level: "fail", id: a.id, text:
          "Detective is set to perform \"" + a.label + "\", which changes state. " +
          "Detective observes and proposes; the moment it also acts, the split stops " +
          "being a safety mechanism." });
      }
      if (mutating && !a.tailnetOnly) {
        out.push({ level: "fail", id: a.id, text:
          "\"" + a.label + "\" changes state but is not tailnet-only. §9D says mutating " +
          "actions never ride the public Funnel leg." });
      }
      if (automatic && mutating && !(a.cooldownS > 0)) {
        out.push({ level: "warn", id: a.id, text:
          "\"" + a.label + "\" is automatic with no cooldown. If it ever reacts to its own " +
          "side effects it will fire in a loop." });
      }
      if (r.rank >= 2 && !String(a.note || "").trim()) {
        out.push({ level: "warn", id: a.id, text:
          "\"" + a.label + "\" is " + r.label.toLowerCase() + " but carries no note. " +
          "Whoever is woken up at 3am deserves to know why this exists." });
      }
    });

    /* Object.create(null), not {} — an action legitimately called
       "constructor" or "toString" would otherwise inherit a truthy
       value from Object.prototype and be reported as a duplicate of
       itself. A linter that invents failures is worse than none. */
    var ids = Object.create(null);
    (actions || []).forEach(function (a) {
      if (ids[a.id]) {
        out.push({ level: "fail", id: a.id, text:
          "Two actions share the id \"" + a.id + "\". The whitelist is looked up by id, " +
          "so one of them is unreachable." });
      }
      ids[a.id] = true;
    });

    if (!(actions || []).length) {
      out.push({ level: "warn", id: null, text:
        "The whitelist is empty. Enforcer with an empty whitelist is safe but useless." });
    }
    return out;
  }

  /* ---- model ----------------------------------------------------- */
  function normalise(d, id) {
    d = d || {};
    var out = {
      id: id,
      name: String(d.name || "SECURITY TAB").slice(0, 60),
      layout: [],
      actions: []
    };
    var seen = {};
    (Array.isArray(d.layout) ? d.layout : DEFAULT_LAYOUT).forEach(function (p) {
      if (!PANELS.some(function (x) { return x.id === p; })) return;
      if (seen[p]) return;
      seen[p] = true;
      out.layout.push(p);
    });
    var src = Array.isArray(d.actions) ? d.actions : DEFAULT_ACTIONS;
    src.forEach(function (a) {
      if (!a || !a.id) return;
      out.actions.push({
        id: String(a.id).slice(0, 40),
        label: String(a.label || a.id).slice(0, 60),
        radius: RADIUS[a.radius] ? a.radius : "observe",
        actor: ACTORS[a.actor] ? a.actor : "human",
        tailnetOnly: a.tailnetOnly !== false,
        cooldownS: Math.max(0, Math.min(86400, Number(a.cooldownS) || 0)),
        note: String(a.note || "").slice(0, 300)
      });
    });
    return out;
  }

  /* Serialised for the same reason as the other editors: save()
     awaits before design.id is set, so two overlapping saves of an
     unsaved design would each create their own record. */
  var saveChain = Promise.resolve();

  function save() {
    /* Decided at call time — see the note in topology.js. */
    if (savePaused || !design) return saveChain;
    saveChain = saveChain.then(doSave, doSave).catch(reportSaveFailure);
    return saveChain;
  }

  /* Callers fire and forget from sync handlers, so a rejection would
     otherwise be swallowed and the edit would look applied. */
  function reportSaveFailure(e) {
    var msg = (e && e.message) || String(e);
    FieldKit.log("error", "security-mockup", "save failed: " + msg);
    if (ui && ui.toast) ui.toast("NOT SAVED — " + msg, "fail");
  }

  async function doSave() {
    if (savePaused || !design) return;
    var payload = { name: design.name, layout: design.layout, actions: design.actions };
    if (design.id) await ctx.store.put(TYPE, payload, { id: design.id });
    else { var rec = await ctx.store.put(TYPE, payload); design.id = rec.id; }
    await load();
  }

  async function load() {
    var rows = await ctx.store.list(TYPE);
    designs = rows.map(function (r) { return normalise(r.data, r.id); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (design && design.id) {
      var f = designs.filter(function (d) { return d.id === design.id; })[0];
      if (f) design = f;
    }
    if (!design) design = designs.length ? designs[0] : normalise({}, null);
    render();
  }

  /* ---- export -----------------------------------------------------
     Markdown, because the destination is a human writing Flask
     routes, not a machine. A JSON blob would have to be read by a
     person anyway, and this way the reasoning survives the trip. */
  function toMarkdown() {
    var L = [];
    L.push("# " + design.name);
    L.push("");
    L.push("Design sketch produced offline in FieldKit. **No live data appears anywhere in " +
      "this document** — the sandbox has no network access. Everything below is a decision, " +
      "not a measurement.");
    L.push("");
    L.push("## Panels, in order");
    L.push("");
    design.layout.forEach(function (id, i) {
      var p = PANELS.filter(function (x) { return x.id === id; })[0];
      if (p) L.push((i + 1) + ". **" + p.label + "** — " + p.note);
    });
    L.push("");
    L.push("## Action whitelist");
    L.push("");
    L.push("Enforcer may run exactly these and nothing else. There is no arbitrary-command " +
      "path, by design.");
    L.push("");
    L.push("| Action | Blast radius | Who may run it | Tailnet only | Cooldown |");
    L.push("|---|---|---|---|---|");
    design.actions.forEach(function (a) {
      L.push("| `" + a.id + "` — " + a.label +
        " | " + RADIUS[a.radius].label +
        " | " + ACTORS[a.actor].label +
        " | " + (a.tailnetOnly ? "yes" : "no") +
        " | " + (a.cooldownS ? a.cooldownS + "s" : "none") + " |");
    });
    L.push("");
    var noted = design.actions.filter(function (a) { return String(a.note || "").trim(); });
    if (noted.length) {
      L.push("### Why each of these is where it is");
      L.push("");
      noted.forEach(function (a) { L.push("- **" + a.label + "** — " + a.note); });
      L.push("");
    }
    L.push("## Rules this policy is held to");
    L.push("");
    L.push("1. Nothing destructive runs automatically.");
    L.push("2. Detective proposes; Enforcer acts. Detective never changes state itself.");
    L.push("3. Anything that changes state is tailnet-only (§9D).");
    L.push("4. Automatic mutating actions carry a cooldown.");
    L.push("");
    var problems = lint(design.actions);
    if (problems.length) {
      L.push("### Outstanding problems");
      L.push("");
      problems.forEach(function (p) {
        L.push("- **" + p.level.toUpperCase() + "** — " + p.text);
      });
    } else {
      L.push("This policy currently satisfies all four.");
    }
    L.push("");
    return L.join("\n");
  }

  /* ---- rendering --------------------------------------------------- */
  function render() {
    if (!nodes.body || !design) return;
    ui.clear(nodes.body);
    renderPicker();

    nodes.body.appendChild(el("div", { class: "sm-stamp", text:
      "SYNTHETIC — every figure below is invented. This sandbox has no network access and " +
      "never had any. It shows layout and policy, not the state of anything." }));

    nodes.body.appendChild(mockup());
    nodes.body.appendChild(whitelistEditor());
    nodes.body.appendChild(lintReport());
  }

  function renderPicker() {
    if (!nodes.designSel) return;
    ui.clear(nodes.designSel);
    if (!designs.length) {
      nodes.designSel.appendChild(el("option", { value: "", text: "(unsaved)" }));
    }
    designs.forEach(function (d) {
      nodes.designSel.appendChild(el("option", { value: d.id, text: d.name,
        selected: design && d.id === design.id ? true : null }));
    });
  }

  function mockup() {
    var frame = el("div", { class: "sm-frame" }, [
      el("div", { class: "sm-chrome" }, [
        el("span", { class: "sm-dot" }), el("span", { class: "sm-dot" }),
        el("span", { class: "sm-dot" }),
        el("span", { class: "sm-url", text: "bastion.local/dashboard/security" }),
        el("span", { class: "sm-fake", text: "MOCKUP" })
      ])
    ]);

    var page = el("div", { class: "sm-page" });
    design.layout.forEach(function (id) {
      var p = PANELS.filter(function (x) { return x.id === id; })[0];
      if (p) page.appendChild(mockPanel(p));
    });
    if (!design.layout.length) {
      page.appendChild(el("div", { class: "sm-empty", text:
        "No panels. Add some below to sketch the tab." }));
    }
    frame.appendChild(page);

    var picker = el("div", { class: "sm-panelpick" });
    PANELS.forEach(function (p) {
      var on = design.layout.indexOf(p.id) >= 0;
      var b = ui.button((on ? "− " : "+ ") + p.label, function () {
        var i = design.layout.indexOf(p.id);
        if (i >= 0) design.layout.splice(i, 1); else design.layout.push(p.id);
        render(); save();
      }, { title: p.note });
      if (on) b.className += " fk-btn-primary";
      picker.appendChild(b);
    });

    return el("div", {}, [frame, picker]);
  }

  function mockPanel(p) {
    var box = el("section", { class: "sm-panel" }, [
      el("h4", { class: "sm-panel-h" }, [
        el("span", { text: p.label }),
        el("span", { class: "sm-synthetic", text: "SYNTHETIC" })
      ])
    ]);

    if (p.id === "feed") {
      SAMPLE_FEED.forEach(function (r) {
        box.appendChild(el("div", { class: "sm-row" }, [
          el("span", { class: "sm-sev sm-sev-" + r.sev, text: r.sev.toUpperCase() }),
          el("span", { class: "sm-when", text: r.at }),
          el("span", { class: "sm-what", text: r.text })
        ]));
      });
    } else if (p.id === "queue") {
      SAMPLE_QUEUE.forEach(function (r) {
        box.appendChild(el("div", { class: "sm-row" }, [
          el("code", { class: "sm-code", text: r.action }),
          el("span", { class: "sm-what", text: r.why }),
          el("span", { class: "sm-verdict", text: r.verdict })
        ]));
      });
    } else if (p.id === "whitelist") {
      design.actions.forEach(function (a) {
        box.appendChild(el("div", { class: "sm-row" }, [
          el("code", { class: "sm-code", text: a.id }),
          el("span", { class: "sm-tag sm-rad-" + a.radius, text: RADIUS[a.radius].label }),
          el("span", { class: "sm-tag", text: ACTORS[a.actor].label }),
          a.tailnetOnly ? el("span", { class: "sm-tag sm-tail", text: "TAILNET" }) : null
        ]));
      });
      if (!design.actions.length) {
        box.appendChild(el("div", { class: "sm-row sm-muted", text: "(nothing whitelisted)" }));
      }
    } else if (p.id === "audit") {
      box.appendChild(el("div", { class: "sm-row" }, [
        el("span", { class: "sm-when", text: "T-00:02" }),
        el("span", { class: "sm-what", text: "ENFORCER ran ban-ip 203.0.113.9 — rule brute-force" })
      ]));
      box.appendChild(el("div", { class: "sm-row" }, [
        el("span", { class: "sm-when", text: "T-04:10" }),
        el("span", { class: "sm-what", text: "HUMAN ran restart-minecraft — approved proposal #41" })
      ]));
    } else if (p.id === "limits") {
      design.actions.slice(0, 5).forEach(function (a) {
        box.appendChild(el("div", { class: "sm-row" }, [
          el("code", { class: "sm-code", text: a.id }),
          el("span", { class: "sm-what",
            text: a.cooldownS ? "at most once per " + a.cooldownS + "s" : "no cooldown set" })
        ]));
      });
    } else if (p.id === "health") {
      ["bastion-1", "bastion-2", "relay", "discord-bot"].forEach(function (h) {
        box.appendChild(el("div", { class: "sm-row" }, [
          ui.statusDot("ok", h), el("span", { class: "sm-muted", text: "sample" })
        ]));
      });
    }
    return box;
  }

  function whitelistEditor() {
    var wrap = el("div", { class: "sm-edit" });
    design.actions.forEach(function (a, i) {
      var radiusSel = el("select", { class: "fk-input" });
      Object.keys(RADIUS).forEach(function (k) {
        radiusSel.appendChild(el("option", { value: k, text: RADIUS[k].label,
          selected: a.radius === k ? true : null }));
      });
      radiusSel.addEventListener("change", function () {
        a.radius = radiusSel.value; render(); save();
      });

      var actorSel = el("select", { class: "fk-input" });
      Object.keys(ACTORS).forEach(function (k) {
        actorSel.appendChild(el("option", { value: k, text: ACTORS[k].label,
          selected: a.actor === k ? true : null }));
      });
      actorSel.addEventListener("change", function () {
        a.actor = actorSel.value; render(); save();
      });

      var tail = el("input", { type: "checkbox", checked: a.tailnetOnly ? true : null });
      tail.addEventListener("change", function () {
        a.tailnetOnly = !!tail.checked; render(); save();
      });

      var cool = el("input", { class: "fk-input sm-num", type: "number", min: "0",
        value: String(a.cooldownS) });
      cool.addEventListener("change", function () {
        a.cooldownS = Math.max(0, Math.min(86400, Number(cool.value) || 0));
        render(); save();
      });

      wrap.appendChild(el("div", { class: "sm-erow" }, [
        el("div", { class: "sm-ehead" }, [
          el("code", { class: "sm-code", text: a.id }),
          el("span", { class: "sm-elabel", text: a.label }),
          ui.button("REMOVE", function () {
            design.actions.splice(i, 1); render(); save();
          }, { danger: true })
        ]),
        el("div", { class: "sm-egrid" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "BLAST RADIUS" }), radiusSel ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "WHO MAY RUN IT" }), actorSel ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "COOLDOWN (s)" }), cool ]),
          el("label", { class: "fk-field sm-check" }, [
            tail, el("span", { class: "fk-field-label", text: "TAILNET ONLY" }) ])
        ]),
        a.note ? el("p", { class: "sm-note", text: a.note }) : null
      ]));
    });

    wrap.appendChild(ui.button("ADD ACTION", function () {
      var id = prompt("Action id (lowercase, hyphenated):");
      if (id === null) return;
      id = String(id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
      if (!id) { ui.toast("AN ACTION NEEDS AN ID", "warn"); return; }
      if (design.actions.some(function (x) { return x.id === id; })) {
        ui.toast("THAT ID IS ALREADY WHITELISTED", "warn"); return;
      }
      var label = prompt("What does it do, in plain words?") || id;
      /* New actions start at the safe end. Widening a permission
         should be a decision someone makes, not a default. */
      design.actions.push({ id: id, label: String(label).slice(0, 60), radius: "observe",
        actor: "human", tailnetOnly: true, cooldownS: 60, note: "" });
      render(); save();
    }, { primary: true }));

    return ui.panel("ACTION WHITELIST — the part that matters", [wrap]);
  }

  function lintReport() {
    var problems = lint(design.actions);
    var body = el("div");
    nodes.lint = body;
    if (!problems.length) {
      body.appendChild(el("div", { class: "sm-ok", text:
        "Nothing destructive runs by itself, Detective never acts, everything mutating is " +
        "tailnet-only, and every automatic action has a cooldown. This policy is safe to " +
        "hand to a Flask route." }));
    } else {
      problems.forEach(function (p) {
        body.appendChild(el("div", { class: p.level === "fail" ? "sm-fail" : "sm-warn",
          text: p.text }));
      });
    }
    return ui.panel("POLICY CHECK", [body]);
  }

  /* ---- probes ------------------------------------------------------ */
  function selfcheck(api) {
    return [
      /* The one that justifies the module existing at all. If this
         ever fails, the mockup has started lying about being real. */
      { name: "IT IS OBVIOUSLY A MOCKUP", critical: true, run: async function () {
        var was = design;
        try {
          design = normalise({}, null);
          render();
          var text = flatten(nodes.body);
          if (!/SYNTHETIC/.test(text)) {
            throw new Error("the SYNTHETIC stamp is gone from the sandbox");
          }
          if (!/no network access/i.test(text)) {
            throw new Error("it no longer states that it cannot reach anything");
          }
          if (!/MOCKUP/.test(text)) throw new Error("the browser chrome no longer says MOCKUP");
          var md = toMarkdown();
          if (!/No live data appears anywhere/i.test(md)) {
            throw new Error("the exported spec carries no synthetic warning");
          }
          return "stamped on screen, in every panel header, and in the export";
        } finally { design = was; render(); }
      } },

      { name: "IT CANNOT REACH THE NETWORK", critical: true, run: async function () {
        var src = String(lint) + String(toMarkdown) + String(render) + String(mockPanel) +
          String(save) + String(load) + String(normalise) + String(whitelistEditor);
        [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/]
          .forEach(function (re) {
            if (re.test(src)) throw new Error("this module now contains " + re.source);
          });
        return "no fetch, no sockets, no beacons — the sandbox is sealed";
      } },

      { name: "DESTRUCTIVE ACTIONS CANNOT BE AUTOMATIC", critical: true, run: async function () {
        var bad = lint([{ id: "wipe", label: "Wipe the world", radius: "destructive",
          actor: "enforcer", tailnetOnly: true, cooldownS: 600, note: "n" }]);
        if (!bad.some(function (p) { return p.level === "fail" && /destructive/i.test(p.text); })) {
          throw new Error("an automatic destructive action passed the linter");
        }
        var ok = lint([{ id: "wipe", label: "Wipe the world", radius: "destructive",
          actor: "human", tailnetOnly: true, cooldownS: 600, note: "n" }]);
        if (ok.some(function (p) { return p.level === "fail"; })) {
          throw new Error("the same action assigned to a human was still rejected");
        }
        return "automatic destruction fails the check; human-gated destruction passes";
      } },

      { name: "DETECTIVE PROPOSES, IT DOES NOT ACT", critical: true, run: async function () {
        var bad = lint([{ id: "ban", label: "Ban", radius: "reversible",
          actor: "detective", tailnetOnly: true, cooldownS: 60, note: "n" }]);
        if (!bad.some(function (p) { return p.level === "fail" && /Detective/.test(p.text); })) {
          throw new Error("Detective was allowed to perform a state change");
        }
        var fine = lint([{ id: "look", label: "Look", radius: "observe",
          actor: "detective", tailnetOnly: false, cooldownS: 0, note: "" }]);
        if (fine.some(function (p) { return p.level === "fail"; })) {
          throw new Error("Detective was blocked from a read-only action");
        }
        return "Detective may observe freely and may not change anything";
      } },

      { name: "MUTATING ACTIONS ARE TAILNET ONLY", critical: true, run: async function () {
        var bad = lint([{ id: "kick", label: "Kick", radius: "disruptive",
          actor: "human", tailnetOnly: false, cooldownS: 60, note: "n" }]);
        if (!bad.some(function (p) { return p.level === "fail" && /tailnet/i.test(p.text); })) {
          throw new Error("a mutating action was allowed on the public leg");
        }
        var reads = lint([{ id: "logs", label: "Logs", radius: "observe",
          actor: "enforcer", tailnetOnly: false, cooldownS: 5, note: "" }]);
        if (reads.some(function (p) { return p.level === "fail"; })) {
          throw new Error("a read-only action was forced onto the tailnet");
        }
        return "§9D holds: reads may be public, writes may not";
      } },

      { name: "THE SHIPPED POLICY PASSES ITS OWN RULES", critical: true, run: async function () {
        var fails = lint(normalise({}, null).actions).filter(function (p) {
          return p.level === "fail";
        });
        if (fails.length) {
          throw new Error("the default whitelist breaks its own linter: " + fails[0].text);
        }
        return "the starting whitelist is a policy I would actually deploy";
      } },

      { name: "NEW ACTIONS START AT THE SAFE END", critical: false, run: async function () {
        var src = String(whitelistEditor);
        if (!/radius:\s*"observe"/.test(src) || !/actor:\s*"human"/.test(src) ||
            !/tailnetOnly:\s*true/.test(src)) {
          throw new Error("a newly added action no longer defaults to the safest settings");
        }
        return "added actions default to observe / human / tailnet-only";
      } },

      { name: "DUPLICATE IDS ARE CAUGHT", critical: false, run: async function () {
        var dup = lint([
          { id: "same", label: "A", radius: "observe", actor: "human", tailnetOnly: true },
          { id: "same", label: "B", radius: "observe", actor: "human", tailnetOnly: true }
        ]);
        if (!dup.some(function (p) { return /share the id/.test(p.text); })) {
          throw new Error("two actions with the same id were accepted");
        }
        return "a shadowed whitelist entry is reported rather than silently ignored";
      } },

      { name: "A LOADED DESIGN CANNOT SMUGGLE ANYTHING IN", critical: false,
        run: async function () {
          var d = normalise({ name: "x", layout: ["feed", "feed", "nonsense", "audit"],
            actions: [{ id: "a", radius: "apocalyptic", actor: "root", cooldownS: -5 },
                      { label: "no id at all" }] }, null);
          if (d.layout.join(",") !== "feed,audit") {
            throw new Error("bad panel ids survived normalisation: " + d.layout.join(","));
          }
          if (d.actions.length !== 1) throw new Error("an action with no id was kept");
          if (d.actions[0].radius !== "observe") throw new Error("an unknown radius was kept");
          if (d.actions[0].actor !== "human") throw new Error("an unknown actor was kept");
          if (d.actions[0].cooldownS !== 0) throw new Error("a negative cooldown was kept");
          if (d.actions[0].tailnetOnly !== true) {
            throw new Error("an unspecified tailnet flag did not default to true");
          }
          return "unknown panels, radii and actors are dropped; the safe defaults win";
        } },

      { name: "THE EXPORT CARRIES THE REASONING", critical: false, run: async function () {
        var was = design;
        try {
          design = normalise({}, null);
          var md = toMarkdown();
          design.actions.forEach(function (a) {
            if (md.indexOf(a.id) < 0) throw new Error("action " + a.id + " is missing");
          });
          if (md.indexOf("Rules this policy is held to") < 0) {
            throw new Error("the four rules are not in the export");
          }
          if (!/restart-minecraft/.test(md)) throw new Error("the table is empty");
          if (!/Interrupts everyone online/.test(md)) {
            throw new Error("the per-action notes did not travel");
          }
          return "panels, table, notes and the rules all survive the export";
        } finally { design = was; }
      } },

      { name: "PROBES DO NOT PERSIST ANYTHING", critical: true, run: async function () {
        var before = (await ctx.store.list(TYPE)).length;
        var was = design;
        savePaused = true;
        try {
          design = normalise({ name: "probe" }, null);
          await save();
        } finally { savePaused = false; design = was; }
        var after = (await ctx.store.list(TYPE)).length;
        if (after !== before) throw new Error("a probe wrote " + (after - before) + " design(s)");
        return "drove the save path with the guard on, wrote nothing";
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

  FieldKit.register("security-mockup", {
    group: "TOOLS",
    about: "Sketch the Bastion security dashboard before it is built",
    keywords: "security dashboard design mockup",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "SECURITY SANDBOX",
    icon: "◈",
    width: 900,
    height: 740,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.designSel = el("select", { class: "fk-input" });
      nodes.designSel.addEventListener("change", function () {
        design = designs.filter(function (d) { return d.id === nodes.designSel.value; })[0]
          || design;
        render();
      });
      nodes.body = el("div", { class: "sm-body" });

      host.appendChild(el("div", { class: "sm-wrap" }, [
        el("p", { class: "sm-intro", text:
          "The Bastion security tab does not exist yet. This is where its shape gets decided " +
          "— offline, with no network, before anyone writes a route. The layout is a sketch; " +
          "the action whitelist below it is the real output." }),

        el("div", { class: "sm-toprow" }, [
          el("label", { class: "fk-field sm-selfield" }, [
            el("span", { class: "fk-field-label", text: "DESIGN" }), nodes.designSel ]),
          ui.button("NEW", function () {
            var name = prompt("Design name:");
            if (name === null) return;
            design = normalise({ name: name || "SECURITY TAB" }, null);
            save();
          }),
          ui.button("COPY SPEC", function () {
            ui.copy(toMarkdown(), { title: "SECURITY TAB SPEC",
              note: "Clipboard access is blocked here. Select this and press Ctrl+C." })
              .then(function (how) { if (how) ui.toast("SPEC COPIED", "ok"); });
          }),
          ui.button("SAVE SPEC", function () {
            var ok = ui.download(toMarkdown(),
              slug(design.name) + "-security-spec.md", "text/markdown");
            ui.toast(ok ? "SPEC SAVED" : "COULD NOT SAVE — USE COPY SPEC", ok ? "ok" : "warn");
          })
        ]),

        nodes.body
      ]));

      await load();
    },

    unmount() { nodes = {}; design = null; designs = []; }
  });

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design";
  }

  function injectCSS() {
    if (document.getElementById("sm-style")) return;
    var s = document.createElement("style");
    s.id = "sm-style";
    s.textContent = `
.sm-wrap{height:100%;overflow:auto}
.sm-intro{font-size:11px;color:var(--fg-dim);line-height:1.7;margin:0 0 10px;
  border-left:2px solid var(--line2);padding-left:9px}
.sm-toprow{display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px}
.sm-selfield{flex:1;min-width:160px;margin:0}
.sm-stamp{font-size:10px;color:var(--warn);line-height:1.6;margin:0 0 10px;
  border:1px dashed var(--warn);padding:7px 9px;letter-spacing:.04em}
.sm-frame{border:1px solid var(--line2);background:var(--bg2)}
.sm-chrome{display:flex;align-items:center;gap:5px;padding:5px 8px;
  border-bottom:1px solid var(--line2);background:var(--panel)}
.sm-dot{width:7px;height:7px;border-radius:50%;background:var(--line2)}
.sm-url{flex:1;font-size:9px;color:var(--fg-dimmer);letter-spacing:.06em;margin-left:6px}
.sm-fake{font-size:8px;color:var(--warn);border:1px solid var(--warn);padding:1px 5px;
  letter-spacing:.12em}
.sm-page{padding:9px;display:grid;gap:9px}
.sm-panel{border:1px solid var(--line);background:var(--panel);padding:8px 9px}
.sm-panel-h{display:flex;justify-content:space-between;align-items:center;margin:0 0 6px;
  font-size:10px;letter-spacing:.12em;color:var(--fg-dim);font-weight:normal}
.sm-synthetic{font-size:7px;color:var(--warn);letter-spacing:.14em;opacity:.8}
.sm-row{display:flex;gap:7px;align-items:baseline;padding:3px 0;font-size:10px;
  border-top:1px solid var(--line);flex-wrap:wrap}
.sm-row:first-of-type{border-top:none}
.sm-sev{font-size:8px;letter-spacing:.1em;padding:0 4px;border:1px solid currentColor}
.sm-sev-high{color:var(--fail)} .sm-sev-med{color:var(--warn)} .sm-sev-low{color:var(--fg-dim)}
.sm-when{color:var(--fg-dimmer);font-size:9px;min-width:46px}
.sm-what{color:var(--fg-dim);flex:1;min-width:140px}
.sm-verdict{color:var(--fg-dimmer);font-size:9px;letter-spacing:.06em}
.sm-code{color:var(--accent);font-size:10px}
.sm-tag{font-size:8px;letter-spacing:.1em;color:var(--fg-dimmer);border:1px solid var(--line2);
  padding:0 4px}
.sm-rad-disruptive{color:var(--warn);border-color:var(--warn)}
.sm-rad-destructive{color:var(--fail);border-color:var(--fail)}
.sm-tail{color:var(--info);border-color:var(--info)}
.sm-muted{color:var(--fg-dimmer)}
.sm-empty{color:var(--fg-dimmer);font-size:10px;padding:14px;text-align:center}
.sm-panelpick{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0 12px}
.sm-panelpick .fk-btn{font-size:9px;padding:4px 8px}
.sm-edit{display:grid;gap:9px}
.sm-erow{border:1px solid var(--line);padding:8px 9px;background:var(--panel2)}
.sm-ehead{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:7px}
.sm-elabel{flex:1;font-size:10px;color:var(--fg-dim);min-width:120px}
.sm-egrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px}
.sm-egrid .fk-field{margin:0}
.sm-check{display:flex;flex-direction:row;align-items:center;gap:6px}
.sm-num{max-width:100%}
.sm-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:7px 0 0}
.sm-ok{font-size:10px;color:var(--pass);line-height:1.6;border-left:2px solid var(--pass);
  padding-left:9px}
.sm-warn{font-size:10px;color:var(--warn);line-height:1.6;border-left:2px solid var(--warn);
  padding-left:9px;margin-bottom:7px}
.sm-fail{font-size:10px;color:var(--fail);line-height:1.6;border-left:2px solid var(--fail);
  padding-left:9px;margin-bottom:7px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
