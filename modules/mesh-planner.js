/* ============================================================
   FieldKit :: mesh-planner
   Where do the LoRa nodes go, and will they actually hear each
   other? (§4)

   Offline by design — the whole point of planning a mesh is that
   you are doing it before there is any network out there to ask.

   What it models, and what it does not:

     RANGE      free-space path loss plus a terrain margin. This
                is a sanity check, not a survey. Real LoRa range
                is dominated by what is between the antennas, and
                nothing here can see that.
     LINE OF    a straight-line check against obstacles you place
     SIGHT      by hand. Again: it knows what you told it.
     ROUTES     which nodes can reach which, and how many hops to
                the gateway. This part IS reliable, because it is
                pure graph work on the links you have accepted.

   The estimates are deliberately conservative and the UI says
   they are estimates. A planner that flatters you is one you find
   out about on a hillside in the rain.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "meshplan";

  /* Metres per grid unit, so the numbers mean something. */
  var SCALE_M = 25;
  var W = 800, H = 460;

  var PRESETS = {
    sf7:  { label: "SF7  — fast, short",   budgetDb: 132 },
    sf9:  { label: "SF9  — balanced",      budgetDb: 138 },
    sf12: { label: "SF12 — slow, far",     budgetDb: 148 }
  };

  /* The margin is not a fudge factor, it is the whole model.

     Free-space path loss at these link budgets works out to two
     hundred kilometres, which is true and useless — nobody gets
     that on the ground. Everything that makes real LoRa range
     finite is terrain, foliage, buildings and antenna height, and
     all of it lands in this one number. Forty decibels is roughly
     suburban non-line-of-sight and gives about 2 km on SF9, which
     matches what people actually report. Clear line of sight
     across a valley is closer to 10; dense woodland is 60 or worse.

     So the ceiling is 100, not 60 — a planner that cannot express
     a bad site cannot warn you about one. */
  var DEFAULT_MARGIN_DB = 40;
  var MAX_MARGIN_DB = 100;

  var MARGIN_HINTS = [
    { db: 10, text: "clear line of sight, raised antennas" },
    { db: 25, text: "open ground, some clutter" },
    { db: 40, text: "suburban, no line of sight" },
    { db: 60, text: "woodland or dense building" },
    { db: 80, text: "hills in the way — expect very little" }
  ];

  var ROLES = {
    gateway: { label: "GATEWAY" },
    node:    { label: "NODE" },
    sensor:  { label: "SENSOR" }
  };

  var ctx, ui, el, nodes = {};
  var plan = null;
  var plans = [];
  var selected = null;
  var drag = null;
  /* Set before a draw() that should preserve keyboard focus. */
  var refocusId = null;
  /* Assigned in mount() — pushes the current plan into the radio
     controls, which live outside draw(). */
  var syncControls = function () {};
  var savePaused = false;

  var NS = "http://www.w3.org/2000/svg";

  /* ---- the radio maths -------------------------------------------
     Free-space path loss at 868 MHz:
        FSPL(dB) = 20log10(d_km) + 20log10(f_MHz) + 32.45
     Then a margin for everything reality adds that this cannot see.
     Solving for distance gives the ring we draw. */
  function rangeMetres(budgetDb, marginDb, freqMhz) {
    freqMhz = freqMhz || 868;
    var usable = budgetDb - marginDb;
    if (usable <= 0) return 0;
    var km = Math.pow(10, (usable - 32.45 - 20 * Math.log10(freqMhz)) / 20);
    return Math.max(0, km * 1000);
  }

  function distanceM(a, b) {
    var dx = (a.x - b.x) * SCALE_M, dy = (a.y - b.y) * SCALE_M;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* Does the straight line a→b cross any obstacle rectangle? */
  function blockedBy(a, b, obstacles) {
    for (var i = 0; i < obstacles.length; i++) {
      if (segmentHitsRect(a, b, obstacles[i])) return obstacles[i];
    }
    return null;
  }

  function segmentHitsRect(a, b, r) {
    /* Trivial accept: either endpoint inside. */
    if (pointInRect(a, r) || pointInRect(b, r)) return true;
    var corners = [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }
    ];
    for (var i = 0; i < 4; i++) {
      if (segmentsCross(a, b, corners[i], corners[(i + 1) % 4])) return true;
    }
    return false;
  }

  function pointInRect(p, r) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  function segmentsCross(p1, p2, p3, p4) {
    function o(a, b, c) {
      var v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
      return v === 0 ? 0 : (v > 0 ? 1 : 2);
    }
    var o1 = o(p1, p2, p3), o2 = o(p1, p2, p4);
    var o3 = o(p3, p4, p1), o4 = o(p3, p4, p2);
    return o1 !== o2 && o3 !== o4;
  }

  /* ---- the graph --------------------------------------------------
     This half is exact. Given the links, hop counts and unreachable
     nodes are facts, not estimates. */
  function analyse(p) {
    var reach = rangeMetres(PRESETS[p.preset].budgetDb, p.marginDb);
    var links = [];
    for (var i = 0; i < p.nodes.length; i++) {
      for (var j = i + 1; j < p.nodes.length; j++) {
        var a = p.nodes[i], b = p.nodes[j];
        var d = distanceM(a, b);
        if (d > reach) continue;
        var block = blockedBy(a, b, p.obstacles);
        links.push({ from: a.id, to: b.id, metres: d, blocked: !!block,
          by: block ? block.label : null });
      }
    }

    var clear = links.filter(function (l) { return !l.blocked; });
    var adj = {};
    p.nodes.forEach(function (n) { adj[n.id] = []; });
    clear.forEach(function (l) { adj[l.from].push(l.to); adj[l.to].push(l.from); });

    var gateways = p.nodes.filter(function (n) { return n.role === "gateway"; });
    var hops = {};
    p.nodes.forEach(function (n) { hops[n.id] = Infinity; });

    /* Breadth-first from every gateway at once. */
    var queue = gateways.map(function (g) { hops[g.id] = 0; return g.id; });
    var head = 0;
    while (head < queue.length) {
      var id = queue[head++];
      adj[id].forEach(function (next) {
        if (hops[next] > hops[id] + 1) { hops[next] = hops[id] + 1; queue.push(next); }
      });
    }

    var orphans = p.nodes.filter(function (n) { return !isFinite(hops[n.id]); });
    var worst = 0;
    p.nodes.forEach(function (n) { if (isFinite(hops[n.id])) worst = Math.max(worst, hops[n.id]); });

    /* A node whose only path is through one other node is a single
       point of failure, and that is the useful thing to be told. */
    var fragile = p.nodes.filter(function (n) {
      if (n.role === "gateway" || !isFinite(hops[n.id])) return false;
      return adj[n.id].length === 1;
    });

    return {
      reachM: reach, links: links, clear: clear, hops: hops,
      gateways: gateways, orphans: orphans, worstHops: worst, fragile: fragile,
      blocked: links.filter(function (l) { return l.blocked; })
    };
  }

  /* ---- model ------------------------------------------------------ */
  function normalise(d, id) {
    var out = {
      id: id,
      name: String(d.name || "UNTITLED MESH").slice(0, 60),
      preset: PRESETS[d.preset] ? d.preset : "sf9",
      marginDb: d.marginDb === undefined || d.marginDb === null
        ? DEFAULT_MARGIN_DB
        : clamp(Number(d.marginDb) || 0, 0, MAX_MARGIN_DB),
      nodes: [], obstacles: []
    };
    (Array.isArray(d.nodes) ? d.nodes : []).forEach(function (n) {
      if (!n || !n.id) return;
      out.nodes.push({
        id: String(n.id).slice(0, 40),
        label: String(n.label || n.id).slice(0, 30),
        role: ROLES[n.role] ? n.role : "node",
        x: clamp(Number(n.x) || 0, 0, W),
        y: clamp(Number(n.y) || 0, 0, H)
      });
    });
    (Array.isArray(d.obstacles) ? d.obstacles : []).forEach(function (o) {
      if (!o) return;
      out.obstacles.push({
        label: String(o.label || "OBSTACLE").slice(0, 30),
        x: clamp(Number(o.x) || 0, 0, W), y: clamp(Number(o.y) || 0, 0, H),
        w: clamp(Number(o.w) || 40, 6, W), h: clamp(Number(o.h) || 40, 6, H)
      });
    });
    return out;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function nodeById(id) {
    for (var i = 0; i < plan.nodes.length; i++) if (plan.nodes[i].id === id) return plan.nodes[i];
    return null;
  }

  function uniqueId(base) {
    var s = String(base).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "n";
    var id = s, i = 2;
    while (nodeById(id)) id = s + "-" + (i++);
    return id;
  }

  /* Serialised: save() awaits a store round trip before plan.id is
     set, so two overlapping saves of an unsaved plan would both see
     a null id and both create a record. Chained rather than dropped
     so the last edit still lands. */
  var saveChain = Promise.resolve();

  function save() {
    /* Decided at call time, not inside doSave — an unawaited save
       queued while paused would otherwise run after the pause was
       lifted. See the note in topology.js. */
    if (savePaused || !plan) return saveChain;
    saveChain = saveChain.then(doSave, doSave).catch(reportSaveFailure);
    return saveChain;
  }

  /* Callers fire and forget from sync handlers, so a rejection would
     otherwise be swallowed and the edit would look applied. */
  function reportSaveFailure(e) {
    var msg = (e && e.message) || String(e);
    FieldKit.log("error", "mesh-planner", "save failed: " + msg);
    if (ui && ui.toast) ui.toast("NOT SAVED — " + msg, "fail");
  }

  async function doSave() {
    if (savePaused || !plan) return;
    var payload = { name: plan.name, preset: plan.preset, marginDb: plan.marginDb,
      nodes: plan.nodes, obstacles: plan.obstacles };
    if (plan.id) await ctx.store.put(TYPE, payload, { id: plan.id });
    else { var rec = await ctx.store.put(TYPE, payload); plan.id = rec.id; }
    await load();
  }

  async function load() {
    var rows = await ctx.store.list(TYPE);
    plans = rows.map(function (r) { return normalise(r.data, r.id); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (plan && plan.id) {
      var f = plans.filter(function (p) { return p.id === plan.id; })[0];
      if (f) plan = f;
    }
    if (!plan) plan = plans.length ? plans[0] : normalise({ name: "NEW MESH" }, null);
    renderList();
    draw();
  }

  /* ---- drawing ----------------------------------------------------- */
  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function draw() {
    if (!nodes.svg || !plan) return;
    while (nodes.svg.firstChild) nodes.svg.removeChild(nodes.svg.firstChild);
    var a = analyse(plan);
    var radiusUnits = a.reachM / SCALE_M;

    plan.obstacles.forEach(function (o, i) {
      nodes.svg.appendChild(svgEl("rect", { x: o.x, y: o.y, width: o.w, height: o.h,
        class: "mp-obstacle" }));
      var t = svgEl("text", { x: o.x + o.w / 2, y: o.y + o.h / 2, class: "mp-obslabel",
        "text-anchor": "middle" });
      t.textContent = o.label;
      nodes.svg.appendChild(t);
      void i;
    });

    /* Range rings on gateways only — a ring per node is unreadable. */
    a.gateways.forEach(function (g) {
      nodes.svg.appendChild(svgEl("circle", { cx: g.x, cy: g.y, r: radiusUnits.toFixed(1),
        class: "mp-ring" }));
    });

    a.links.forEach(function (l) {
      var f = nodeById(l.from), t = nodeById(l.to);
      if (!f || !t) return;
      nodes.svg.appendChild(svgEl("line", { x1: f.x, y1: f.y, x2: t.x, y2: t.y,
        class: "mp-link" + (l.blocked ? " mp-blocked" : "") }));
    });

    plan.nodes.forEach(function (n) {
      var hop = a.hops[n.id];
      var g = svgEl("g", { class: "mp-node mp-r-" + n.role +
        (isFinite(hop) ? "" : " mp-orphan") + (selected === n.id ? " mp-selected" : ""),
        tabindex: "0", role: "button",
        "aria-label": n.label + ", " + ROLES[n.role].label +
          (isFinite(hop) ? ", " + hop + " hops from a gateway" : ", unreachable") });

      g.appendChild(svgEl("circle", { cx: n.x, cy: n.y, r: n.role === "gateway" ? 9 : 6 }));
      var label = svgEl("text", { x: n.x, y: n.y - 13, "text-anchor": "middle",
        class: "mp-label" });
      label.textContent = n.label;
      g.appendChild(label);
      var sub = svgEl("text", { x: n.x, y: n.y + 20, "text-anchor": "middle", class: "mp-hop" });
      sub.textContent = isFinite(hop) ? (hop === 0 ? "GATEWAY" : hop + " HOP" + (hop > 1 ? "S" : ""))
        : "UNREACHABLE";
      g.appendChild(sub);

      g.addEventListener("pointerdown", function (ev) { startDrag(ev, n); });
      g.addEventListener("keydown", function (ev) { nodeKey(ev, n); });
      g.addEventListener("focus", function () { selected = n.id; renderReport(a); });
      nodes.svg.appendChild(g);

      /* draw() just destroyed whatever had focus. Give it back. */
      if (refocusId === n.id) {
        try { g.focus(); } catch (e) { /* not focusable here, fine */ }
      }
    });

    refocusId = null;
    renderReport(a);
  }

  function renderReport(a) {
    if (!nodes.report) return;
    a = a || analyse(plan);
    ui.clear(nodes.report);
    if (nodes.marginHint) nodes.marginHint.textContent = marginHintFor(plan.marginDb);

    nodes.report.appendChild(ui.readout([
      { label: "ESTIMATED RANGE", value: fmtM(a.reachM), level: "info" },
      { label: "NODES", value: String(plan.nodes.length), level: "dim" },
      { label: "GATEWAYS", value: String(a.gateways.length),
        level: a.gateways.length ? "ok" : "fail" },
      { label: "USABLE LINKS", value: a.clear.length + " of " + a.links.length + " in range",
        level: a.clear.length ? "ok" : "warn" },
      { label: "DEEPEST PATH", value: a.worstHops ? a.worstHops + " hop(s)" : "—",
        level: a.worstHops > 4 ? "warn" : "dim" },
      { label: "UNREACHABLE", value: String(a.orphans.length),
        level: a.orphans.length ? "fail" : "ok" }
    ]));

    if (!a.gateways.length) {
      nodes.report.appendChild(el("div", { class: "mp-fail", text:
        "No gateway. Without one, nothing has anywhere to send to — mark a node as GATEWAY." }));
    }
    if (a.orphans.length) {
      nodes.report.appendChild(el("div", { class: "mp-fail", text:
        "Out of reach entirely: " + a.orphans.map(function (n) { return n.label; }).join(", ") +
        ". Move them closer, add a relay between, or raise the spreading factor." }));
    }
    if (a.blocked.length) {
      nodes.report.appendChild(el("div", { class: "mp-warn", text:
        a.blocked.length + " link(s) are in range but blocked by an obstacle: " +
        a.blocked.slice(0, 4).map(function (l) {
          var f = nodeById(l.from), t = nodeById(l.to);
          return (f ? f.label : l.from) + "↔" + (t ? t.label : l.to) + " (" + l.by + ")";
        }).join(", ") + (a.blocked.length > 4 ? " …" : "") }));
    }
    if (a.fragile.length) {
      nodes.report.appendChild(el("div", { class: "mp-warn", text:
        "Single point of failure — these reach the mesh through exactly one neighbour: " +
        a.fragile.map(function (n) { return n.label; }).join(", ") + "." }));
    }
    if (a.worstHops > 4) {
      nodes.report.appendChild(el("div", { class: "mp-warn", text:
        "A " + a.worstHops + "-hop path is long for LoRa. Latency and collision risk both climb " +
        "with every hop." }));
    }

    nodes.report.appendChild(el("div", { class: "mp-caveat", text:
      "Range is free-space path loss with a " + plan.marginDb + " dB margin — a sanity check, " +
      "not a survey. Real LoRa range is dominated by what is between the antennas, and this " +
      "only knows about obstacles you drew. Hop counts and reachability are exact, because " +
      "those are just graph work on the links above." }));
  }

  /* Nearest anchor, so a number in decibels means something to
     someone who has never opened a link budget calculator. */
  function marginHintFor(db) {
    var best = MARGIN_HINTS[0];
    MARGIN_HINTS.forEach(function (h) {
      if (Math.abs(h.db - db) < Math.abs(best.db - db)) best = h;
    });
    return "≈ " + best.text;
  }

  function fmtM(m) {
    if (m >= 1000) return (m / 1000).toFixed(2) + " km";
    return Math.round(m) + " m";
  }

  /* ---- interaction --------------------------------------------------- */
  function svgPoint(ev) {
    var r = nodes.svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  }

  /* Same two traps as topology.js, for the same reason: onMove calls
     draw(), draw() rebuilds every <g>, and removing an element from
     the document both releases its pointer capture and drops its
     focus. So a drag released off-canvas never ended, and arrow keys
     moved a node exactly once per Tab before focus fell to <body>
     and the next press scrolled the page. Window listeners for the
     gesture, and re-focus the rebuilt group. */
  function startDrag(ev, n) {
    selected = n.id;
    var p = svgPoint(ev);
    drag = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    ev.preventDefault();
  }

  function endDragListeners() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  }

  function onMove(ev) {
    if (!drag) return;
    var n = nodeById(drag.id);
    if (!n) return;
    var p = svgPoint(ev);
    n.x = clamp(Math.round(p.x - drag.dx), 0, W);
    n.y = clamp(Math.round(p.y - drag.dy), 0, H);
    drag.moved = true;
    draw();
  }

  function onUp() {
    endDragListeners();
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    if (moved) save();
  }

  function nodeKey(ev, n) {
    var step = ev.shiftKey ? 1 : 10;
    var handled = true;
    if (ev.key === "ArrowLeft") n.x = clamp(n.x - step, 0, W);
    else if (ev.key === "ArrowRight") n.x = clamp(n.x + step, 0, W);
    else if (ev.key === "ArrowUp") n.y = clamp(n.y - step, 0, H);
    else if (ev.key === "ArrowDown") n.y = clamp(n.y + step, 0, H);
    else if (ev.key === "Delete" || ev.key === "Backspace") {
      /* The mouse path has no delete at all, so this key is the only
         way to lose a node — it should still ask. */
      ev.preventDefault();
      if (!confirm("Delete \"" + n.label + "\" from this plan?\n\nThere is no undo.")) return;
      plan.nodes = plan.nodes.filter(function (x) { return x.id !== n.id; });
      if (selected === n.id) selected = null;
      draw(); save(); return;
    } else handled = false;
    if (handled) {
      ev.preventDefault();
      refocusId = n.id;
      draw();
      save();
    }
  }

  function renderList() {
    if (!nodes.planSel) return;
    ui.clear(nodes.planSel);
    if (!plans.length) nodes.planSel.appendChild(el("option", { value: "", text: "(unsaved)" }));
    plans.forEach(function (p) {
      nodes.planSel.appendChild(el("option", { value: p.id, text: p.name,
        selected: plan && p.id === plan.id ? true : null }));
    });
  }

  /* ---- export --------------------------------------------------------
     Meshtastic-shaped JSON, so this can eventually feed real config
     rather than being a drawing. Positions are relative metres, not
     coordinates — the planner has no idea where on earth you are. */
  function toJSON() {
    var a = analyse(plan);
    return {
      format: "fieldkit-mesh-plan",
      v: 1,
      name: plan.name,
      radio: { preset: plan.preset, linkBudgetDb: PRESETS[plan.preset].budgetDb,
        terrainMarginDb: plan.marginDb, estimatedRangeM: Math.round(a.reachM) },
      scaleMetresPerUnit: SCALE_M,
      nodes: plan.nodes.map(function (n) {
        return { id: n.id, label: n.label, role: n.role,
          offsetM: { x: Math.round(n.x * SCALE_M), y: Math.round(n.y * SCALE_M) },
          hopsToGateway: isFinite(a.hops[n.id]) ? a.hops[n.id] : null };
      }),
      links: a.clear.map(function (l) {
        return { from: l.from, to: l.to, metres: Math.round(l.metres) };
      }),
      obstacles: plan.obstacles.map(function (o) {
        return { label: o.label,
          offsetM: { x: Math.round(o.x * SCALE_M), y: Math.round(o.y * SCALE_M) },
          sizeM: { w: Math.round(o.w * SCALE_M), h: Math.round(o.h * SCALE_M) } };
      }),
      caveat: "Range is estimated from free-space path loss plus a terrain margin. " +
              "Verify on site before committing to hardware positions."
    };
  }

  /* ---- probes ---------------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "PATH LOSS MATHS IS SANE", critical: true, run: async function () {
        /* A known point: 868 MHz, 1 km free space is ~91.2 dB. */
        var r = rangeMetres(91.2, 0, 868);
        if (Math.abs(r - 1000) > 30) {
          throw new Error("1 km should need ~91.2 dB, got " + Math.round(r) + " m");
        }
        /* 6 dB more budget doubles the distance. */
        var a = rangeMetres(120, 0), b = rangeMetres(126, 0);
        if (Math.abs(b / a - 2) > 0.05) {
          throw new Error("+6 dB should double range, got x" + (b / a).toFixed(3));
        }
        /* More margin can only shorten it, never lengthen it. */
        if (rangeMetres(140, 30) >= rangeMetres(140, 10)) {
          throw new Error("a larger terrain margin did not shorten the range");
        }
        if (rangeMetres(10, 50) !== 0) throw new Error("a negative budget did not clamp to zero");
        if (PRESETS.sf12.budgetDb <= PRESETS.sf7.budgetDb) {
          throw new Error("SF12 should have a larger link budget than SF7");
        }
        return "1 km checkpoint, +6 dB doubling, margin monotonic, no negative range";
      } },

      { name: "REACHABILITY IS EXACT", critical: true, run: async function () {
        /* A deliberate chain: gateway - a - b, spaced 1 km apart so
           b is out of the gateway's reach but not out of a's. It
           must come back as two hops, not as unreachable. The
           margin is chosen to put the range in that band, and the
           probe checks that before trusting the rest. */
        var p = normalise({
          name: "t", preset: "sf9", marginDb: 43,
          nodes: [
            { id: "gw", role: "gateway", x: 0, y: 0 },
            { id: "a", role: "node", x: 40, y: 0 },
            { id: "b", role: "node", x: 80, y: 0 }
          ]
        }, null);
        var was = plan;
        try {
          plan = p;
          var a = analyse(p);
          if (!(a.reachM > 1050 && a.reachM < 1950)) {
            throw new Error("the fixture no longer straddles the 1 km spacing — reach is " +
              Math.round(a.reachM) + " m");
          }
          if (a.hops.gw !== 0) throw new Error("the gateway is not zero hops");
          if (a.hops.a !== 1) throw new Error("a is one hop away, got " + a.hops.a);
          if (a.hops.b !== 2) {
            throw new Error("b should be exactly two hops, got " + a.hops.b);
          }

          /* Now strand one. */
          p.nodes.push({ id: "far", role: "node", x: 799, y: 459 });
          a = analyse(p);
          if (isFinite(a.hops.far)) throw new Error("a node 20 km away was called reachable");
          if (!a.orphans.some(function (n) { return n.id === "far"; })) {
            throw new Error("the stranded node was not reported as an orphan");
          }

          /* And with no gateway at all, nothing is reachable. */
          p.nodes[0].role = "node";
          a = analyse(p);
          if (a.gateways.length) throw new Error("a gateway appeared from nowhere");
          if (a.orphans.length !== p.nodes.length) {
            throw new Error("with no gateway everything should be unreachable");
          }
          return "hop counts, stranded nodes and the no-gateway case all correct";
        } finally { plan = was; }
      } },

      { name: "OBSTACLES BLOCK THE LINE, NOT THE RANGE", critical: true, run: async function () {
        var p = normalise({
          name: "t", preset: "sf12", marginDb: 0,
          nodes: [{ id: "gw", role: "gateway", x: 10, y: 100 },
                  { id: "n", role: "node", x: 200, y: 100 }],
          obstacles: [{ label: "HILL", x: 90, y: 40, w: 30, h: 120 }]
        }, null);
        var was = plan;
        try {
          plan = p;
          var a = analyse(p);
          if (!a.links.length) throw new Error("the two nodes are not even in range");
          if (!a.links[0].blocked) throw new Error("a wall across the line did not block it");
          if (a.links[0].by !== "HILL") throw new Error("the blocker was not named");
          if (a.clear.length) throw new Error("a blocked link was counted as usable");
          if (!a.orphans.some(function (n) { return n.id === "n"; })) {
            throw new Error("a node behind an obstacle was still called reachable");
          }

          /* Move the obstacle out of the way and it comes back. */
          p.obstacles[0].y = 300;
          a = analyse(p);
          if (a.links[0].blocked) throw new Error("moving the obstacle did not clear the link");
          if (!a.clear.length) throw new Error("the cleared link is not usable");
          return "an obstacle across the path blocks it; moving it restores the link";
        } finally { plan = was; }
      } },

      /* The failure this module is one bad constant away from: a
         default so generous that every node reaches every other and
         the planner cheerfully approves any layout you draw. */
      { name: "THE DEFAULT ANSWER IS NOT ALWAYS YES", critical: true, run: async function () {
        var d = normalise({ name: "t" }, null);
        if (d.marginDb !== DEFAULT_MARGIN_DB) {
          throw new Error("a plan with no margin set did not get the default");
        }
        var reach = rangeMetres(PRESETS[d.preset].budgetDb, d.marginDb);
        var canvasM = Math.sqrt(W * W + H * H) * SCALE_M;
        if (reach >= canvasM) {
          throw new Error("the default range (" + Math.round(reach) +
            " m) covers the whole canvas (" + Math.round(canvasM) +
            " m) — every layout would pass");
        }
        if (reach < 300) {
          throw new Error("the default range is " + Math.round(reach) +
            " m, too short to be usable");
        }
        if (MAX_MARGIN_DB < 80) {
          throw new Error("the margin ceiling is too low to describe a bad site");
        }
        if (!/woodland|hills/i.test(MARGIN_HINTS.map(function (h) { return h.text; }).join(" "))) {
          throw new Error("the margin hints no longer cover the difficult cases");
        }
        return "default reaches " + fmtM(reach) + " on a " + fmtM(canvasM) + " canvas";
      } },

      { name: "GEOMETRY EDGE CASES", critical: false, run: async function () {
        var r = { x: 10, y: 10, w: 20, h: 20 };
        if (!segmentHitsRect({ x: 15, y: 15 }, { x: 100, y: 100 }, r)) {
          throw new Error("a segment starting inside the rect was not caught");
        }
        if (segmentHitsRect({ x: 0, y: 0 }, { x: 5, y: 5 }, r)) {
          throw new Error("a segment nowhere near the rect was caught");
        }
        if (!segmentHitsRect({ x: 0, y: 20 }, { x: 100, y: 20 }, r)) {
          throw new Error("a segment straight through the rect was missed");
        }
        if (segmentHitsRect({ x: 0, y: 200 }, { x: 100, y: 200 }, r)) {
          throw new Error("a segment well below the rect was caught");
        }
        /* Two nodes on top of each other must not produce NaN. */
        var d = distanceM({ x: 5, y: 5 }, { x: 5, y: 5 });
        if (d !== 0) throw new Error("zero distance came out as " + d);
        return "inside, outside, crossing and coincident all handled";
      } },

      { name: "SINGLE POINTS OF FAILURE ARE NAMED", critical: false, run: async function () {
        /* A triangle, not a line — three collinear nodes cannot
           express this, because the direct gateway-to-leaf path
           runs straight through the relay's own position. The wall
           sits on the gateway-leaf line only, so the leaf's single
           remaining neighbour is the relay. */
        var p = normalise({
          name: "t", preset: "sf12", marginDb: 0,
          nodes: [{ id: "gw", role: "gateway", x: 10, y: 10 },
                  { id: "relay", role: "node", x: 60, y: 60 },
                  { id: "leaf", role: "sensor", x: 110, y: 10 }],
          obstacles: [{ label: "WALL", x: 50, y: 0, w: 20, h: 20 }]
        }, null);
        var was = plan;
        try {
          plan = p;
          var a = analyse(p);
          var names = a.fragile.map(function (n) { return n.id; });
          if (names.indexOf("leaf") < 0) {
            throw new Error("a leaf hanging off one neighbour was not flagged (" +
              names.join(",") + ")");
          }
          if (names.indexOf("gw") >= 0) throw new Error("the gateway was flagged as fragile");
          return "a node reachable through exactly one neighbour is called out";
        } finally { plan = was; }
      } },

      /* This module's honesty problem: it must not imply survey-grade
         numbers. If the caveat ever goes, the module becomes a liar. */
      { name: "IT SAYS THESE ARE ESTIMATES", critical: true, run: async function () {
        var was = plan;
        try {
          plan = normalise({ name: "t", nodes: [{ id: "a", role: "gateway", x: 10, y: 10 }] }, null);
          renderReport();
          var text = flatten(nodes.report);
          if (!/not a survey/i.test(text)) {
            throw new Error("the report no longer says this is not a survey");
          }
          if (!/only knows about obstacles you drew/i.test(text)) {
            throw new Error("it no longer says what it cannot see");
          }
          var json = toJSON();
          if (!/Verify on site/i.test(json.caveat || "")) {
            throw new Error("the exported plan carries no caveat");
          }
          return "the caveat is on screen and travels with the export";
        } finally { plan = was; draw(); }
      } },

      { name: "EXPORT IS COMPLETE AND IN METRES", critical: false, run: async function () {
        var was = plan;
        try {
          plan = normalise({
            name: "T", preset: "sf12", marginDb: 10,
            nodes: [{ id: "gw", label: "GW", role: "gateway", x: 4, y: 0 },
                    { id: "n1", label: "N1", role: "node", x: 8, y: 0 }],
            obstacles: [{ label: "SHED", x: 40, y: 40, w: 8, h: 8 }]
          }, null);
          var j = toJSON();
          if (j.format !== "fieldkit-mesh-plan") throw new Error("wrong format stamp");
          if (j.nodes.length !== 2) throw new Error("nodes are missing");
          if (j.nodes[0].offsetM.x !== 4 * SCALE_M) {
            throw new Error("positions are not converted to metres");
          }
          if (j.obstacles[0].sizeM.w !== 8 * SCALE_M) {
            throw new Error("obstacle sizes are not converted to metres");
          }
          if (j.radio.estimatedRangeM <= 0) throw new Error("no range in the export");
          if (j.nodes[0].hopsToGateway !== 0) throw new Error("hop counts are missing");
          if (JSON.stringify(j).indexOf("NaN") >= 0) throw new Error("the export contains NaN");
          return "format, metres, hops and radio settings all present";
        } finally { plan = was; }
      } },

      { name: "PROBES DO NOT PERSIST ANYTHING", critical: true, run: async function () {
        var before = (await ctx.store.list(TYPE)).length;
        var was = plan;
        savePaused = true;
        try {
          plan = normalise({ name: "probe", nodes: [{ id: "a", role: "node", x: 1, y: 1 }] }, null);
          nodeKey({ key: "ArrowRight", shiftKey: false, preventDefault: function () {} },
            plan.nodes[0]);
          await save();
        } finally { savePaused = false; plan = was; }
        var after = (await ctx.store.list(TYPE)).length;
        if (after !== before) throw new Error("a probe wrote " + (after - before) + " plan(s)");
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

  FieldKit.register("mesh-planner", {
    group: "SERVERS",
    about: "Plan where LoRa radio nodes go and if they can hear each other",
    keywords: "lora mesh radio meshtastic nodes range",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "MESH PLANNER",
    icon: "◇",
    width: 880,
    height: 720,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "mp-canvas",
        preserveAspectRatio: "xMidYMid meet" });
      nodes.report = el("div");
      nodes.planSel = el("select", { class: "fk-input" });
      nodes.planSel.addEventListener("change", function () {
        plan = plans.filter(function (p) { return p.id === nodes.planSel.value; })[0] || plan;
        selected = null;
        /* The radio controls live outside draw(), so switching plans
           redrew the canvas while the spreading factor and margin
           boxes kept showing the plan you just left. The diagram
           then disagreed with the numbers next to it, and the first
           edit to either control silently wrote the old plan's
           value onto the new one. */
        syncControls();
        draw();
      });

      var presetSel = el("select", { class: "fk-input" });
      Object.keys(PRESETS).forEach(function (k) {
        presetSel.appendChild(el("option", { value: k, text: PRESETS[k].label }));
      });
      presetSel.addEventListener("change", function () {
        plan.preset = presetSel.value; draw(); save();
      });

      var marginIn = el("input", { class: "fk-input", type: "number", min: "0",
        max: String(MAX_MARGIN_DB) });
      marginIn.addEventListener("change", function () {
        plan.marginDb = clamp(Number(marginIn.value) || 0, 0, MAX_MARGIN_DB);
        marginIn.value = String(plan.marginDb);
        draw(); save();
      });

      var marginHint = el("span", { class: "mp-hint" });
      nodes.marginHint = marginHint;

      /* One place that pushes the current plan into the controls, so
         every path that changes which plan is current — the picker,
         NEW, and the initial load — cannot forget one of them. */
      syncControls = function () {
        if (!plan) return;
        presetSel.value = plan.preset;
        marginIn.value = String(plan.marginDb);
      };

      host.appendChild(el("div", { class: "mp-wrap" }, [
        el("div", { class: "mp-toprow" }, [
          el("label", { class: "fk-field mp-selfield" }, [
            el("span", { class: "fk-field-label", text: "PLAN" }), nodes.planSel
          ]),
          ui.button("NEW", function () {
            var name = prompt("Plan name:");
            if (name === null) return;
            plan = normalise({ name: name || "NEW MESH" }, null);
            selected = null;
            syncControls();
            save();
          })
        ]),

        el("div", { class: "mp-grid" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "SPREADING FACTOR" }), presetSel
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "TERRAIN MARGIN (dB)" }),
            marginIn, marginHint
          ])
        ]),

        el("div", { class: "mp-canvaswrap" }, [nodes.svg]),

        el("div", { class: "mp-actions" }, [
          ui.button("ADD NODE", function () { addNode("node"); }),
          ui.button("ADD GATEWAY", function () { addNode("gateway"); }),
          ui.button("ADD OBSTACLE", function () {
            var label = prompt("What is in the way? (hill, building, treeline)");
            if (label === null) return;
            plan.obstacles.push({ label: (label || "OBSTACLE").slice(0, 30),
              x: 300, y: 180, w: 90, h: 60 });
            draw(); save();
          }),
          ui.button("COPY PLAN JSON", function () {
            ui.copy(JSON.stringify(toJSON(), null, 1), { title: "MESH PLAN",
              note: "Clipboard access is blocked here. Select this and press Ctrl+C." })
              .then(function (how) { if (how) ui.toast("PLAN COPIED", "ok"); });
          })
        ]),

        ui.panel("ANALYSIS", [nodes.report]),

        el("p", { class: "mp-note", text:
          "Drag a node, or Tab to it and use the arrow keys. Range rings are drawn on gateways " +
          "only — one per node is unreadable. Grid scale is " + SCALE_M + " m per unit." })
      ]));

      function addNode(role) {
        var label = prompt(role === "gateway" ? "Gateway label:" : "Node label:");
        if (label === null) return;
        label = String(label).trim() || (role === "gateway" ? "GW" : "NODE");
        plan.nodes.push({ id: uniqueId(label), label: label.slice(0, 30), role: role,
          x: 100 + (plan.nodes.length % 6) * 60, y: 100 + (plan.nodes.length % 5) * 50 });
        draw(); save();
      }

      await load();
      syncControls();
      draw();
    },

    unmount() { nodes = {}; plan = null; plans = []; selected = null; drag = null; }
  });

  function injectCSS() {
    if (document.getElementById("mp-style")) return;
    var s = document.createElement("style");
    s.id = "mp-style";
    s.textContent = `
.mp-wrap{height:100%;overflow:auto}
.mp-toprow{display:flex;gap:6px;align-items:flex-end;margin-bottom:8px}
.mp-selfield{flex:1;margin:0}
.mp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px;
  margin-bottom:8px}
.mp-canvaswrap{border:1px solid var(--line2);background:var(--bg2);overflow:hidden}
.mp-canvas{display:block;width:100%;height:auto;touch-action:none}
.mp-obstacle{fill:rgba(224,80,60,.10);stroke:var(--fail);stroke-width:1;stroke-dasharray:3 3}
.mp-obslabel{fill:var(--fail);font-size:8px;font-family:inherit;letter-spacing:1px;
  pointer-events:none}
.mp-ring{fill:rgba(224,166,60,.05);stroke:var(--accent-dim);stroke-width:1;stroke-dasharray:4 4}
.mp-link{stroke:var(--pass);stroke-width:1.2;opacity:.7}
.mp-link.mp-blocked{stroke:var(--fail);stroke-dasharray:3 3;opacity:.55}
.mp-node{cursor:grab}
.mp-node:focus{outline:none}
.mp-node circle{fill:var(--panel);stroke:var(--fg-dim);stroke-width:2}
.mp-r-node circle{stroke:var(--info)}
.mp-r-sensor circle{stroke:var(--pass)}
.mp-r-gateway circle{stroke:var(--accent);fill:rgba(224,166,60,.15)}
.mp-orphan circle{stroke:var(--fail);stroke-dasharray:2 2}
.mp-node:focus circle,.mp-selected circle{stroke-width:3}
.mp-label{fill:var(--fg);font-size:9px;font-family:inherit;pointer-events:none}
.mp-hop{fill:var(--fg-dimmer);font-size:7px;letter-spacing:1px;font-family:inherit;
  pointer-events:none}
.mp-orphan .mp-hop{fill:var(--fail)}
.mp-hint{display:block;font-size:9px;color:var(--fg-dimmer);letter-spacing:.06em;
  margin-top:3px}
.mp-actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.mp-actions .fk-btn{flex:1;min-width:120px}
.mp-warn{font-size:10px;color:var(--warn);line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--warn);padding-left:9px}
.mp-fail{font-size:10px;color:var(--fail);line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--fail);padding-left:9px}
.mp-caveat{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:10px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
.mp-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:10px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
