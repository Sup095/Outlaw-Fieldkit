/* ============================================================
   FieldKit :: colony — DEEPHOLD
   A shared underground colony game. Your colony is yours; the
   Civilization above it is everyone's. The game itself runs on the
   relay (relay/colony-engine.js); this panel shows it and sends clicks.

   Point and click. You never mine anything yourself: you choose what
   to build, where, and how much of what it makes goes up to the Civ.

   The panel trusts nothing it computes. Everything on screen is what
   the relay last said, redrawn every few seconds, and a click is a
   request the relay can refuse with a reason.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, host, timer = null, gone = false;
  var view = null, err = "", busy = false;
  var tab = "colony", menu = null, picked = null, foundName = "", foundBiome = "seam", adminStage = "1";

  var RES = ["ore", "water", "fungus", "crystal", "fuel", "food", "parts", "goods", "arms"];
  var RES_NAME = { ore: "ORE", water: "WATER", fungus: "FUNGUS", crystal: "CRYSTAL", fuel: "FUEL", food: "FOOD", parts: "PARTS", goods: "GOODS", arms: "ARMS" };

  function msg() { return FieldKit.service("messages"); }

  function call(method, path, body) {
    var m = msg();
    if (!m || !m.colony) return Promise.reject(new Error("MESSAGES is not available"));
    return m.colony(method, path, body);
  }

  /* ---- numbers ------------------------------------------------ */
  function n(v) { v = Number(v) || 0; return v >= 100000 ? Math.round(v / 1000) + "k" : v >= 10000 ? (Math.round(v / 100) / 10) + "k" : String(Math.round(v)); }
  function clock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? h + "h " + m + "m" : m ? m + "m " + (s % 60) + "s" : s + "s";
  }
  function costText(cost) {
    return Object.keys(cost || {}).map(function (r) { return cost[r] + " " + RES_NAME[r].toLowerCase(); }).join(", ");
  }
  function afford(cost) {
    var st = view && view.colony ? view.colony.stock : {};
    return Object.keys(cost || {}).every(function (r) { return (st[r] || 0) >= cost[r]; });
  }
  function find(id) {
    var c = view && view.catalog ? view.catalog : [];
    for (var i = 0; i < c.length; i++) if (c[i].id === id) return c[i];
    return { id: id, name: id.toUpperCase(), cost: {} };
  }

  /* ---- talking to the relay ----------------------------------- */
  function take(v) { view = v; err = ""; draw(); }

  async function load() {
    if (gone) return;
    try { take(await call("GET", "/colony/me")); }
    catch (e) {
      err = e.data && e.data.needsApproval ? "An admin has to approve your account before you can play." : (e.message || "could not reach the relay");
      draw();
    }
  }

  async function act(path, body, quiet) {
    if (busy) return;
    busy = true;
    try { take(await call("POST", "/colony/" + path, body || {})); }
    catch (e) { if (!quiet) ui.toast(String(e.message || "failed").toUpperCase(), "warn"); err = ""; draw(); }
    busy = false;
  }

  /* ---- small pieces ------------------------------------------- */
  function bar(frac, cls, label) {
    frac = Math.max(0, Math.min(1, frac || 0));
    return el("div", { class: "dh-bar " + (cls || ""), title: label || "" }, [
      el("div", { class: "dh-fill", style: { width: Math.round(frac * 100) + "%" } }),
      label ? el("span", { class: "dh-bar-t", text: label }) : null
    ]);
  }
  function chip(label, value, cls) {
    return el("div", { class: "dh-chip " + (cls || "") }, [el("span", { class: "k", text: label }), el("span", { class: "v", text: value })]);
  }
  function section(title, kids, cls) {
    return el("div", { class: "dh-sec " + (cls || "") }, [el("div", { class: "dh-sec-h", text: title })].concat(kids));
  }

  /* ---- the header: the Civ at a glance -------------------------- */
  function header() {
    var c = view.civ;
    var frac = 0, label = "";
    if (c.fallen) {
      var L = c.liberation, tot = 0, got = 0;
      Object.keys(L.need).forEach(function (r) { tot += L.need[r]; got += Math.min(L.need[r], L.progress[r] || 0); });
      frac = tot ? got / tot : 0; label = "OCCUPIED — LIBERATION " + Math.round(frac * 100) + "%";
    } else if (c.next) {
      var t = 0, g = 0;
      Object.keys(c.next.need).forEach(function (r) { t += c.next.need[r]; g += Math.min(c.next.need[r], c.next.progress[r] || 0); });
      frac = t ? g / t : 0; label = "TO " + c.next.name + " — " + Math.round(frac * 100) + "%";
    } else label = "NO FURTHER STAGE YET";
    var war = c.war && c.war.at ? "NEXT WAVE IN " + clock(c.war.at - view.now) : "";
    return el("div", { class: "dh-head" }, [
      el("div", { class: "dh-title" }, [
        el("span", { class: "dh-logo", text: "DEEPHOLD" }),
        el("span", { class: "dh-stage", text: "STAGE " + c.stage + " · " + c.name }),
        el("span", { class: "dh-meta", text: c.colonies + " colonies · " + c.active + " active" })
      ]),
      bar(frac, c.fallen ? "bad" : "", label),
      el("div", { class: "dh-meta" }, [
        el("span", { text: war }),
        c.fallen ? el("span", { class: "bad", text: " · THE CIVILIZATION HAS FALLEN: advancement is slower, buffs are halved" }) : null,
        c.brownout ? el("span", { class: "bad", text: " · BROWNOUT: the Civ cannot pay upkeep, buffs are off" }) : null
      ])
    ]);
  }

  /* ---- no colony yet ------------------------------------------- */
  function founding() {
    var kids = [
      el("p", { class: "dh-p", text: "Under the surface there is a Civilization that needs everything, and nobody to give it. Pick a place to break ground. You never dig by hand: you build, and the buildings work whether you are here or not." }),
      el("p", { class: "dh-p dim", text: "Away from the screen, everything your colony ships still reaches the Civ in full, and you keep 30% of what you would have kept online. More places open as more people join." })
    ];
    var row = el("div", { class: "dh-biomes" });
    view.biomes.forEach(function (b) {
      var card = el("button", { class: "dh-biome" + (foundBiome === b.id ? " on" : "") + (b.open ? "" : " locked"), type: "button",
        disabled: !b.open,
        onclick: function () { foundBiome = b.id; draw(); } }, [
        el("div", { class: "n", text: b.name }),
        el("div", { class: "b", text: b.open ? b.blurb : "Opens when " + b.at + " colonies are active in the Civilization." })
      ]);
      row.appendChild(card);
    });
    kids.push(row);
    var name = el("input", { class: "fk-input", placeholder: "name your colony", maxlength: "24", value: foundName,
      oninput: function (e) { foundName = e.target.value; } });
    kids.push(el("div", { class: "dh-row" }, [name, ui.button(view.cooldown ? "WAIT " + clock(view.cooldown * 1000) : "BREAK GROUND", function () {
      if (view.cooldown) return;
      act("found", { biome: foundBiome, name: foundName });
    }, { primary: true })]));
    return section("FOUND A COLONY", kids);
  }

  function fallenColony() {
    return section("YOUR COLONY HAS FALLEN", [
      el("p", { class: "dh-p", text: "Everyone is gone. The Civilization still counts what you gave it. You can start again." }),
      ui.button(view.cooldown ? "WAIT " + clock(view.cooldown * 1000) : "START OVER", function () {
        if (view.cooldown) return;
        act("abandon", { confirm: true });
      }, { primary: true })
    ]);
  }

  /* ---- the colony ------------------------------------------- */
  function stats(c) {
    var s = c.stats || {};
    var pop = c.pop, hapCls = c.hap < 25 ? "bad" : c.hap < 50 ? "warn" : "ok";
    var row = el("div", { class: "dh-chips" }, [
      chip("PEOPLE", pop + " / " + (s.housing || "?")),
      chip("MOOD", c.hap + "%", hapCls),
      chip("AIR", (s.air ? s.air[0] : 0) + " / " + pop, s.air && s.air[0] < pop ? "bad" : ""),
      chip("POWER", (s.power ? s.power[0] : 0) + " / " + (s.power ? s.power[1] : 0), s.power && s.power[0] < s.power[1] ? "warn" : ""),
      chip("WORKERS", (s.staff ? s.staff[0] : 0) + " / " + (s.staff ? s.staff[1] : 0), s.staff && s.staff[0] < s.staff[1] ? "warn" : ""),
      chip("ENTERTAIN", (s.ent ? s.ent[0] : 0) + " / " + pop, s.ent && s.ent[0] < pop ? "warn" : ""),
      chip("LIFT", (s.lift || 0) + "/s"),
      chip("OUTPUT", Math.round((s.eff || 0) * 100) + "%")
    ]);
    var kids = [row, bar(c.hap / 100, hapCls, "MOOD " + c.hap + "%")];
    if (c.safe) kids.push(el("div", { class: "dh-note", text: "YOU ARE AWAY. The colony keeps working and everything it ships reaches the Civilization. You keep 30% of what you would have, and nobody here can die while you are gone." }));
    return el("div", {}, kids);
  }

  function shipping(c) {
    var rows = RES.map(function (r) {
      var pct = c.ship[r] || 0;
      var step = function (d) { return function () { act("ship", { res: r, pct: Math.max(0, Math.min(100, pct + d)) }, true); }; };
      var asked = view.civ.next && view.civ.next.need && view.civ.next.need[r] && (view.civ.next.progress[r] || 0) < view.civ.next.need[r];
      return el("div", { class: "dh-ship" + (asked ? " asked" : "") }, [
        el("span", { class: "r", text: RES_NAME[r] }),
        el("span", { class: "a", text: n(c.stock[r] || 0) }),
        el("span", { class: "s" }, [
          el("button", { class: "dh-mini", type: "button", text: "−", onclick: step(-10) }),
          el("span", { class: "p", text: pct + "% UP" }),
          el("button", { class: "dh-mini", type: "button", text: "+", onclick: step(10) })
        ]),
        el("span", { class: "x", text: asked ? "THE CIV ASKS FOR THIS" : (c.shipped[r] ? "sent " + n(c.shipped[r]) : "") })
      ]);
    });
    return section("WAREHOUSE AND CARGO — what share of each thing you make goes up to the Civilization", [
      el("div", { class: "dh-note", text: "The rest stays here for your people and your buildings. A colony never ships itself below a small reserve while you are online." })
    ].concat(rows));
  }

  function plot(layer, slot, cell) {
    if (!cell) {
      return el("button", { class: "dh-plot empty", type: "button", title: "build here", onclick: function () { menu = { layer: layer, slot: slot }; picked = null; draw(); } },
        [el("span", { class: "plus", text: "+" })]);
    }
    var b = find(cell.t);
    var on = picked && picked.layer === layer && picked.slot === slot;
    return el("button", { class: "dh-plot full" + (cell.on ? "" : " off") + (on ? " sel" : ""), type: "button", title: b.blurb || b.name,
      onclick: function () { picked = { layer: layer, slot: slot, t: cell.t, on: cell.on }; menu = null; draw(); } }, [
      el("span", { class: "nm", text: b.name }),
      el("span", { class: "st", text: cell.on ? "RUNNING" : "PAUSED" })
    ]);
  }

  function layers(c) {
    var out = [];
    c.grid.forEach(function (row, l) {
      var cells = row.map(function (cell, s) { return plot(l, s, cell); });
      out.push(el("div", { class: "dh-layer" }, [
        el("div", { class: "dh-layer-h", text: "LAYER " + (l + 1) + (l === 0 ? " · surface" : l >= 2 ? " · deep" : "")}),
        el("div", { class: "dh-plots" }, cells)
      ]));
    });
    var dig;
    if (c.dig) dig = el("div", { class: "dh-note", text: "DIGGING LAYER " + (c.layers + 1) + " — " + clock(c.dig.left * 1000) + " left" });
    else if (c.digCost) {
      dig = el("div", { class: "dh-row" }, [
        ui.button("DIG LAYER " + (c.layers + 1), function () { act("dig"); }, { primary: afford(c.digCost) }),
        el("span", { class: "dh-note", text: costText(c.digCost) + " · " + clock(c.digSeconds * 1000) + " · deeper is richer and more dangerous" })
      ]);
    } else dig = el("div", { class: "dh-note", text: "THE CIVILIZATION MUST GROW BEFORE YOU CAN DIG ANY DEEPER." });
    out.push(dig);
    return section("YOUR COLONY — click a plot", out);
  }

  /* The build list or the detail of one plot, under the layers. */
  function chooser(c) {
    if (menu) {
      var items = view.catalog.map(function (b) {
        if (b.locked) {
          return el("div", { class: "dh-opt locked" }, [el("div", { class: "n", text: b.name }), el("div", { class: "b", text: "Unlocks at stage " + b.stage + "." })]);
        }
        var why = "";
        if (b.minLayer > menu.layer) why = "needs layer " + (b.minLayer + 1) + " or deeper";
        else if (b.biomes && b.biomes.indexOf(c.biome) < 0) why = "not in this biome";
        else if (b.max && countOf(c, b.id) >= b.max) why = "limit " + b.max;
        var ok = !why && afford(b.cost);
        var io = [];
        if (b.inp) io.push("uses " + Object.keys(b.inp).map(function (r) { return b.inp[r] + "/s " + RES_NAME[r].toLowerCase(); }).join(", "));
        if (b.out) io.push("makes " + Object.keys(b.out).map(function (r) { return b.out[r] + "/s " + RES_NAME[r].toLowerCase(); }).join(", "));
        io.push((b.power > 0 ? "+" : b.power < 0 ? "−" : "") + Math.abs(b.power) + " power", b.staff + " workers");
        return el("button", { class: "dh-opt" + (ok ? "" : " no"), type: "button", disabled: !!why,
          onclick: function () { var m = menu; menu = null; act("build", { layer: m.layer, slot: m.slot, type: b.id }); } }, [
          el("div", { class: "n", text: b.name + (ok ? "" : why ? "  (" + why + ")" : "  (cannot afford)") }),
          el("div", { class: "b", text: b.blurb }),
          el("div", { class: "c", text: "COST " + costText(b.cost) }),
          el("div", { class: "c dim", text: io.join(" · ") })
        ]);
      });
      return section("BUILD ON LAYER " + (menu.layer + 1) + ", PLOT " + (menu.slot + 1), [
        el("div", { class: "dh-opts" }, items),
        ui.button("CANCEL", function () { menu = null; draw(); })
      ], "pick");
    }
    if (picked) {
      var b = find(picked.t);
      return section(b.name, [
        el("div", { class: "dh-p", text: b.blurb }),
        el("div", { class: "dh-row" }, [
          ui.button(picked.on ? "PAUSE" : "RESUME", function () { var p = picked; picked = null; act("toggle", { layer: p.layer, slot: p.slot }); }),
          ui.button("DEMOLISH (50% BACK)", function () { var p = picked; picked = null; act("demolish", { layer: p.layer, slot: p.slot }); }, { danger: true }),
          ui.button("CLOSE", function () { picked = null; draw(); })
        ])
      ], "pick");
    }
    return null;
  }
  function countOf(c, id) {
    var k = 0;
    c.grid.forEach(function (row) { row.forEach(function (x) { if (x && x.t === id) k++; }); });
    return k;
  }

  function colonyTab() {
    var c = view.colony;
    if (!c) return founding();
    if (c.collapsed) return fallenColony();
    return el("div", {}, [
      el("div", { class: "dh-yours" }, [el("b", { text: c.name }), el("span", { class: "dim", text: "  " + view.biomes.filter(function (b) { return b.id === c.biome; }).map(function (b) { return b.name; })[0] + " · gave " + n(c.given) + " worth" })]),
      stats(c), layers(c), chooser(c), shipping(c),
      c.log.length ? section("WHAT HAPPENED", c.log.map(function (l) { return el("div", { class: "dh-log", text: l.text }); })) : null
    ]);
  }

  /* ---- the Civilization -------------------------------------- */
  function needRows(need, progress) {
    return Object.keys(need).map(function (r) {
      var got = Math.min(need[r], progress[r] || 0);
      return el("div", { class: "dh-need" }, [
        el("span", { class: "r", text: RES_NAME[r] }),
        bar(got / need[r], "", n(got) + " / " + n(need[r]))
      ]);
    });
  }

  function civTab() {
    var c = view.civ, kids = [];
    kids.push(section("WHERE WE ARE", [
      el("div", { class: "dh-p", text: "STAGE " + c.stage + " — " + c.name + ". " + c.text }),
      el("div", { class: "dh-chips" }, [
        chip("OUTPUT BUFF", "+" + Math.round(c.buffs.yield * 100) + "%"),
        chip("DEFENCE BUFF", "+" + Math.round(c.buffs.def * 100) + "%"),
        chip("UPKEEP", c.brownout ? "UNPAID" : c.strain > 20 ? "BEHIND" : "PAID", c.brownout ? "bad" : c.strain > 20 ? "warn" : "ok")
      ])
    ]));
    if (c.fallen) {
      kids.push(section("LIBERATION — the Civilization must be won back", [
        el("div", { class: "dh-p", text: "Until it is liberated, advancement costs more and buffs are halved. Ship these:" })
      ].concat(needRows(c.liberation.need, c.liberation.progress))));
    } else if (c.next) {
      kids.push(section("NEXT: " + c.next.name, [el("div", { class: "dh-p", text: c.next.text })].concat(needRows(c.next.need, c.next.progress))
        .concat([el("div", { class: "dh-note", text: "Set the shipping sliders on the COLONY tab to send what is asked for. The cost grows a little with how many people are playing, so it is always reachable." })])));
    }
    if (c.war) {
      var w = c.war, g = w.strength ? Math.min(1, w.defence / w.strength) : 0;
      kids.push(section("THE WAR", [
        el("div", { class: "dh-p", text: w.at ? "The next wave arrives in " + clock(w.at - view.now) + ", strength " + n(w.strength) + "." : "The Consortium is gathering." }),
        w.strength ? bar(g, g >= 1 ? "" : "bad", "DEFENCE " + n(w.defence) + " / " + n(w.strength)) : null,
        bar(w.breach / 100, w.breach > 60 ? "bad" : "", "THE WALL " + (100 - w.breach) + "% STANDING"),
        el("div", { class: "dh-note", text: "Defence is every ARMS stored here plus turret nests. Waves held: " + w.wins + ". Waves lost: " + w.losses + ". A wave you cannot meet spends everything and cracks the wall; if the wall breaks, the Civilization falls." })
      ]));
    }
    var stock = RES.filter(function (r) { return c.stock[r] > 0; }).map(function (r) { return chip(RES_NAME[r], n(c.stock[r])); });
    if (stock.length) kids.push(section("CIVILIZATION STORES (for upkeep and the war)", [el("div", { class: "dh-chips" }, stock)]));
    if (c.top.length) kids.push(section("WHO KEEPS US ALIVE", c.top.map(function (t) { return el("div", { class: "dh-log" + (t.me ? " me" : ""), text: t.name + " — " + n(t.v) + " worth" }); })));
    kids.push(section("PLACES TO BREAK GROUND", view.biomes.map(function (b) {
      return el("div", { class: "dh-log" + (b.open ? "" : " dim"), text: b.name + (b.open ? " — open" : " — opens at " + b.at + " active colonies") });
    })));
    kids.push(section("THE LOG", c.log.map(function (l) { return el("div", { class: "dh-log", text: l.text }); })));
    return el("div", {}, kids);
  }

  /* ---- admin ------------------------------------------------- */
  function adminTab() {
    var sel = el("select", { class: "fk-input", onchange: function (e) { adminStage = e.target.value; } });
    for (var i = 0; i < 6; i++) sel.appendChild(el("option", { value: String(i), text: "stage " + i, selected: String(i) === adminStage }));
    var go = function (body, ask) { return function () { if (ask && !window.confirm(ask)) return; act("admin", body); }; };
    return section("ADMIN — these change the shared game for everyone, and are written in the Civ's log", [
      el("div", { class: "dh-row" }, [sel, ui.button("SET STAGE", function () { go({ action: "setStage", stage: Number(adminStage) }, "Set the whole Civilization to stage " + adminStage + "?")(); })]),
      el("div", { class: "dh-row" }, [
        ui.button("END OCCUPATION", go({ action: "endFall" })),
        ui.button("CALL WAVE NOW", go({ action: "waveNow" }, "Call the next wave right now?")),
        ui.button("DELAY WAVE 8H", go({ action: "delayWave", hours: 8 }))
      ]),
      el("div", { class: "dh-row" }, [
        ui.button("RESET THE CIVILIZATION", go({ action: "resetCiv" }, "Reset stage, stores and the war? Colonies stay."), { danger: true })
      ])
    ]);
  }

  /* ---- the whole panel --------------------------------------- */
  function css() {
    if (document.getElementById("dh-style")) return;
    var s = document.createElement("style"); s.id = "dh-style";
    s.textContent = [
      ".dh{display:flex;flex-direction:column;gap:10px;font-size:11px;padding:2px 2px 14px;overflow-y:auto;height:100%}",
      ".dh .dim{color:var(--fg-dimmer)} .dh .bad{color:var(--fail)} .dh .warn{color:var(--warn)} .dh .ok{color:var(--pass)}",
      ".dh-head{border:1px solid var(--line2);padding:8px;background:rgba(0,0,0,.2);display:flex;flex-direction:column;gap:6px}",
      ".dh-title{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}",
      ".dh-logo{letter-spacing:.3em;color:var(--accent);font-size:13px}.dh-stage{letter-spacing:.14em}",
      ".dh-meta{font-size:9px;color:var(--fg-dimmer);letter-spacing:.06em}",
      ".dh-bar{position:relative;height:16px;border:1px solid var(--line2);background:rgba(0,0,0,.3)}",
      ".dh-fill{height:100%;background:var(--accent);opacity:.55}.dh-bar.bad .dh-fill{background:var(--fail)}",
      ".dh-bar-t{position:absolute;left:6px;top:2px;font-size:9px;letter-spacing:.08em}",
      ".dh-tabs{display:flex;gap:6px;flex-wrap:wrap}",
      ".dh-tab{font:inherit;font-size:10px;letter-spacing:.14em;background:none;color:var(--fg-dim);border:1px solid var(--line2);padding:5px 12px;cursor:pointer}",
      ".dh-tab.on{border-color:var(--accent);color:var(--accent)}",
      ".dh-sec{border:1px solid var(--line2);padding:8px;display:flex;flex-direction:column;gap:6px;background:rgba(0,0,0,.14)}",
      ".dh-sec.pick{border-color:var(--accent)}",
      ".dh-sec-h{font-size:9px;letter-spacing:.18em;color:var(--accent)}",
      ".dh-p{line-height:1.5;margin:0}.dh-note{font-size:9px;line-height:1.5;color:var(--fg-dimmer)}",
      ".dh-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
      ".dh-chips{display:flex;gap:6px;flex-wrap:wrap}",
      ".dh-chip{border:1px solid var(--line2);padding:3px 7px;display:flex;gap:6px;align-items:baseline}",
      ".dh-chip .k{font-size:8px;letter-spacing:.12em;color:var(--fg-dimmer)}.dh-chip .v{font-size:12px}",
      ".dh-chip.bad{border-color:var(--fail)}.dh-chip.warn{border-color:var(--warn)}",
      ".dh-yours{font-size:13px}",
      ".dh-layer-h{font-size:8px;letter-spacing:.16em;color:var(--fg-dimmer);margin-bottom:3px}",
      ".dh-plots{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}",
      "@media(min-width:760px){.dh-plots{grid-template-columns:repeat(8,1fr)}}",
      ".dh-plot{font:inherit;min-height:48px;border:1px solid var(--line2);background:rgba(0,0,0,.25);color:var(--fg);cursor:pointer;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:2px;padding:3px}",
      ".dh-plot:hover{border-color:var(--accent)}.dh-plot.empty{border-style:dashed;color:var(--fg-dimmer)}",
      ".dh-plot .plus{font-size:18px}.dh-plot .nm{font-size:8px;letter-spacing:.06em;text-align:center}",
      ".dh-plot .st{font-size:7px;color:var(--pass);letter-spacing:.1em}.dh-plot.off{opacity:.6}.dh-plot.off .st{color:var(--warn)}",
      ".dh-plot.sel{border-color:var(--accent);background:rgba(255,255,255,.06)}",
      ".dh-opts{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px}",
      ".dh-opt{font:inherit;text-align:left;border:1px solid var(--line2);background:rgba(0,0,0,.25);color:var(--fg);padding:6px;cursor:pointer;display:flex;flex-direction:column;gap:3px}",
      ".dh-opt:hover:not(:disabled){border-color:var(--accent)}.dh-opt.no{opacity:.6}.dh-opt.locked{opacity:.4;cursor:default}",
      ".dh-opt:disabled{opacity:.35;cursor:not-allowed}",
      ".dh-opt .n{font-size:10px;letter-spacing:.1em}.dh-opt .b{font-size:9px;color:var(--fg-dimmer);line-height:1.4}.dh-opt .c{font-size:9px}",
      ".dh-ship{display:grid;grid-template-columns:70px 50px 140px 1fr;gap:6px;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)}",
      ".dh-ship.asked .r{color:var(--accent)}.dh-ship .x{font-size:8px;letter-spacing:.08em;color:var(--fg-dimmer)}.dh-ship.asked .x{color:var(--accent)}",
      ".dh-ship .s{display:flex;gap:4px;align-items:center}.dh-ship .p{min-width:52px;text-align:center}",
      ".dh-mini{font:inherit;width:22px;height:20px;background:none;border:1px solid var(--line2);color:var(--fg-dim);cursor:pointer}.dh-mini:hover{border-color:var(--accent);color:var(--accent)}",
      ".dh-need{display:grid;grid-template-columns:70px 1fr;gap:8px;align-items:center}.dh-need .r{font-size:9px;letter-spacing:.1em}",
      ".dh-log{font-size:10px;line-height:1.5;padding:1px 0}.dh-log.me{color:var(--accent)}",
      ".dh-biomes{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px}",
      ".dh-biome{font:inherit;text-align:left;border:1px solid var(--line2);background:rgba(0,0,0,.25);color:var(--fg);padding:8px;cursor:pointer}",
      ".dh-biome.on{border-color:var(--accent)}.dh-biome.locked{opacity:.4;cursor:not-allowed}",
      ".dh-biome .n{letter-spacing:.12em;font-size:10px;margin-bottom:3px}.dh-biome .b{font-size:9px;color:var(--fg-dimmer);line-height:1.4}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function draw() {
    if (gone || !host) return;
    var keep = host.firstChild ? host.firstChild.scrollTop : 0;
    ui.clear(host);
    var root = el("div", { class: "dh" });
    if (!view) {
      root.appendChild(section("DEEPHOLD", [el("div", { class: "dh-p" + (err ? " bad" : ""), text: err || "Reaching the Deep…" })]));
      host.appendChild(root); return;
    }
    root.appendChild(header());
    var tabs = el("div", { class: "dh-tabs" });
    var list = [["colony", "COLONY"], ["civ", "CIVILIZATION"]];
    if (view.admin) list.push(["admin", "ADMIN"]);
    list.forEach(function (t) {
      tabs.appendChild(el("button", { class: "dh-tab" + (tab === t[0] ? " on" : ""), type: "button", text: t[1], onclick: function () { tab = t[0]; draw(); } }));
    });
    root.appendChild(tabs);
    if (err) root.appendChild(el("div", { class: "dh-note bad", text: err }));
    root.appendChild(tab === "civ" ? civTab() : tab === "admin" && view.admin ? adminTab() : colonyTab());
    host.appendChild(root);
    root.scrollTop = keep;
  }

  /* The panel draws what the relay says, so what can break on its own is
     small: the words for things, and the clock. */
  function selfcheck() {
    return [
      { name: "EVERY RESOURCE HAS A NAME ON SCREEN", critical: false, run: function () {
        var missing = RES.filter(function (r) { return !RES_NAME[r]; });
        if (missing.length) throw new Error("no name for: " + missing.join(", "));
        return RES.length + " resources named";
      } },
      { name: "TIMES AND AMOUNTS READ PLAINLY", critical: false, run: function () {
        if (clock(3725000) !== "1h 2m" || clock(125000) !== "2m 5s" || clock(9000) !== "9s") throw new Error("clock() is wrong: " + clock(3725000) + " / " + clock(125000));
        if (n(1234) !== "1234" || n(25000) !== "25k" || n(150000) !== "150k") throw new Error("n() is wrong: " + n(25000));
        return "1h 2m, 2m 5s, 25k";
      } }
    ];
  }

  FieldKit.register("colony", {
    title: "DEEPHOLD",
    icon: "▼",
    group: "ONLINE",
    about: "The shared underground colony: your colony feeds the Civilization",
    keywords: "game colony deephold civilization war build dig play shared coop",
    width: 920,
    height: 720,
    guestSafe: false,
    selfcheck: selfcheck,

    async mount(h, context) {
      ctx = context; ui = ctx.ui; el = ui.el; host = h; gone = false;
      view = null; err = ""; busy = false; menu = null; picked = null;
      css();
      draw();
      await load();
      timer = setInterval(function () { if (!document.hidden) load(); }, 4000);
    },

    unmount() {
      gone = true;
      if (timer) clearInterval(timer);
      timer = null; host = null; view = null;
    }
  });
})(window.FieldKit);
