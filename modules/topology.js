/* ============================================================
   FieldKit :: topology
   A picture of the network, drawn by hand and kept current (§4).

   Not auto-discovered, on purpose. Discovery tells you what is
   talking to what right now; a diagram tells you what is supposed
   to be talking to what, which is the thing you need at 2am when
   it has stopped. The gap between the two is the bug.

   Draggable SVG nodes, edges typed by how the traffic actually
   travels (tailnet / lan / wan / internet), saved encrypted, and
   exportable as a standalone SVG that survives being pasted into
   documentation.

   Keyboard-reachable throughout: a drag-only diagram editor is a
   keyboard trap, and §10F says no.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "topology";
  var NS = "http://www.w3.org/2000/svg";

  var KINDS = {
    host:     { label: "HOST",     w: 118, h: 44, colour: "accent" },
    service:  { label: "SERVICE",  w: 118, h: 38, colour: "info" },
    network:  { label: "NETWORK",  w: 108, h: 38, colour: "pass" },
    cloud:    { label: "CLOUD",    w: 118, h: 40, colour: "warn" },
    device:   { label: "DEVICE",   w: 108, h: 40, colour: "fg" }
  };

  var LINKS = {
    tailnet:  { label: "TAILNET",  dash: "",      note: "encrypted mesh, no ports open" },
    lan:      { label: "LAN",      dash: "",      note: "same physical network" },
    wan:      { label: "FORWARDED", dash: "6 3",  note: "a port open to the internet" },
    internet: { label: "INTERNET", dash: "2 3",   note: "over the public internet" }
  };

  /* Ships with the real thing from §9D, so the module is useful the
     moment it is opened rather than being an empty canvas. */
  var DEFAULT = {
    name: "BASTION",
    nodes: [
      { id: "usb",     label: "FIELDKIT USB",  kind: "device",  x:  40, y: 150 },
      { id: "chrome",  label: "CHROMEBOOK",    kind: "device",  x:  40, y: 220 },
      { id: "net",     label: "SCHOOL WIFI",   kind: "network", x: 200, y: 185 },
      { id: "relay",   label: "RELAY",         kind: "service", x: 360, y: 185 },
      { id: "ptero",   label: "PTERODACTYL",   kind: "host",    x: 360, y: 100 },
      { id: "tail",    label: "TAILSCALE",     kind: "cloud",   x: 520, y: 185 },
      { id: "pc",      label: "HOME PC",       kind: "host",    x: 680, y: 120 },
      { id: "lm",      label: "LM STUDIO",     kind: "service", x: 680, y: 185 },
      { id: "b1",      label: "BASTION-1",     kind: "host",    x: 680, y: 260 },
      { id: "b2",      label: "BASTION-2",     kind: "host",    x: 680, y: 325 }
    ],
    edges: [
      { from: "usb",   to: "chrome", kind: "lan",      label: "plugged in" },
      { from: "chrome", to: "net",   kind: "lan",      label: "" },
      { from: "net",   to: "relay",  kind: "internet", label: "https" },
      { from: "ptero", to: "relay",  kind: "lan",      label: "container" },
      { from: "relay", to: "tail",   kind: "tailnet",  label: "userspace proxy" },
      { from: "tail",  to: "pc",     kind: "tailnet",  label: "" },
      { from: "pc",    to: "lm",     kind: "lan",      label: "1234" },
      { from: "tail",  to: "b1",     kind: "tailnet",  label: "" },
      { from: "tail",  to: "b2",     kind: "tailnet",  label: "" }
    ]
  };

  var ctx, ui, el, nodes = {};
  var diagrams = [];
  var current = null;
  var selected = null;
  var drag = null;
  /* Set by whoever is about to call draw() and wants keyboard focus
     to survive the rebuild. Cleared by draw() itself. */
  var refocusId = null;

  var W = 840, H = 420;

  /* ---- model ------------------------------------------------------ */
  function normalise(d, id) {
    var out = {
      id: id,
      name: String(d.name || "UNTITLED").slice(0, 60),
      nodes: [], edges: []
    };
    var ids = {};
    (Array.isArray(d.nodes) ? d.nodes : []).forEach(function (n) {
      if (!n || !n.id) return;
      var id = String(n.id).slice(0, 40);
      /* Two nodes with one id: nodeById() only ever finds the first,
         so the second could be drawn but never selected, dragged or
         deleted — a box on the canvas that does not respond to
         anything. Dropped, like a dangling edge. */
      if (ids[id]) return;
      ids[id] = true;
      /* Clamped against this kind's own box, not a guessed one.
         A cloud is wider than a device, and clamping every kind to
         60x40 let the wide ones sit with their right edge off the
         canvas after a reload. */
      var kind = KINDS[n.kind] ? n.kind : "host";
      out.nodes.push({
        id: id,
        label: String(n.label || n.id).slice(0, 40),
        kind: kind,
        x: clamp(Number(n.x) || 0, 0, W - KINDS[kind].w),
        y: clamp(Number(n.y) || 0, 0, H - KINDS[kind].h)
      });
    });
    (Array.isArray(d.edges) ? d.edges : []).forEach(function (e) {
      /* An edge to a node that no longer exists would draw to
         nowhere. Dropped rather than rendered as a stray line. */
      if (!e || !ids[e.from] || !ids[e.to] || e.from === e.to) return;
      out.edges.push({
        from: e.from, to: e.to,
        kind: LINKS[e.kind] ? e.kind : "lan",
        label: String(e.label || "").slice(0, 30)
      });
    });
    return out;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function nodeById(id) {
    for (var i = 0; i < current.nodes.length; i++) {
      if (current.nodes[i].id === id) return current.nodes[i];
    }
    return null;
  }

  function uniqueId(base) {
    var n = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
    var id = n, i = 2;
    while (nodeById(id)) { id = n + "-" + (i++); }
    return id;
  }

  /* The self-test drives real interactions — dragging, arrow keys —
     to prove they work. Those paths persist, and a diagnostic that
     writes a diagram into your vault every time you run it is a
     diagnostic with side effects. Probes pause saving instead. */
  var savePaused = false;

  /* Saves are serialised through this.

     Every interaction ends in draw(); save(), and save() awaits a
     store round trip before current.id is set. Two of those in
     flight at once on an unsaved diagram — a drag that ends while
     an arrow-key save is still going, which takes one impatient
     hand — both see current.id as null and both create a record.
     You end up with two diagrams and no idea which one you are
     editing.

     Chaining rather than dropping matters: the last write has to
     land, or the final position of whatever you just moved is the
     one edit that gets lost. */
  var saveChain = Promise.resolve();

  function save() {
    /* The pause is decided HERE, not inside doSave.

       Most callers do `draw(); save();` without awaiting, so a
       queued save runs a microtask later — by which time a probe's
       finally block has already cleared savePaused and the write
       goes through anyway. Deciding at call time keeps the guard
       meaning what it says: a save requested while paused never
       happens, rather than happening slightly later. */
    if (savePaused || !current) return saveChain;
    saveChain = saveChain.then(doSave, doSave).catch(reportSaveFailure);
    return saveChain;
  }

  /* Every caller is `draw(); save();` from a sync handler, so a
     rejection had nowhere to go: the node moved on screen, the edit
     looked applied, and it was never stored. Silence is the one
     answer a save must never give. */
  function reportSaveFailure(e) {
    var msg = (e && e.message) || String(e);
    FieldKit.log("error", "topology", "save failed: " + msg);
    if (ui && ui.toast) ui.toast("NOT SAVED — " + msg, "fail");
  }

  async function doSave() {
    if (savePaused || !current) return;
    var payload = { name: current.name, nodes: current.nodes, edges: current.edges };
    if (current.id) await ctx.store.put(TYPE, payload, { id: current.id });
    else {
      var rec = await ctx.store.put(TYPE, payload);
      current.id = rec.id;
    }
    await load();
  }

  async function load() {
    var rows = await ctx.store.list(TYPE);
    diagrams = rows.map(function (r) { return normalise(r.data, r.id); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (current && current.id) {
      var found = diagrams.filter(function (d) { return d.id === current.id; })[0];
      if (found) current = found;
    }
    if (!current) current = diagrams.length ? diagrams[0] : normalise(DEFAULT, null);
    renderList();
    draw();
  }

  /* ---- drawing ---------------------------------------------------- */
  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function centreOf(n) {
    var k = KINDS[n.kind];
    return { x: n.x + k.w / 2, y: n.y + k.h / 2 };
  }

  /* Meets the box edge rather than the centre, so an arrow does not
     disappear under the node it points at. */
  function edgePoint(from, to) {
    var k = KINDS[from.kind];
    var c = centreOf(from), t = centreOf(to);
    var dx = t.x - c.x, dy = t.y - c.y;
    if (!dx && !dy) return c;
    var hw = k.w / 2, hh = k.h / 2;
    var sx = dx === 0 ? Infinity : hw / Math.abs(dx);
    var sy = dy === 0 ? Infinity : hh / Math.abs(dy);
    var s = Math.min(sx, sy);
    return { x: c.x + dx * s, y: c.y + dy * s };
  }

  function draw() {
    if (!nodes.svg) return;
    while (nodes.svg.firstChild) nodes.svg.removeChild(nodes.svg.firstChild);
    if (!current) return;

    /* Edges first so nodes sit on top of them. */
    current.edges.forEach(function (e, i) {
      var a = nodeById(e.from), b = nodeById(e.to);
      if (!a || !b) return;
      var p1 = edgePoint(a, b), p2 = edgePoint(b, a);
      var link = LINKS[e.kind];

      var line = svgEl("line", {
        x1: p1.x.toFixed(1), y1: p1.y.toFixed(1),
        x2: p2.x.toFixed(1), y2: p2.y.toFixed(1),
        class: "tp-edge tp-edge-" + e.kind
      });
      if (link.dash) line.setAttribute("stroke-dasharray", link.dash);
      nodes.svg.appendChild(line);

      var label = e.label || link.label;
      if (label) {
        var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        var t = svgEl("text", { x: mx.toFixed(1), y: (my - 4).toFixed(1),
          class: "tp-edgelabel", "text-anchor": "middle" });
        t.textContent = label;
        nodes.svg.appendChild(t);
      }
      void i;
    });

    current.nodes.forEach(function (n) {
      var k = KINDS[n.kind];
      var g = svgEl("g", { class: "tp-node tp-" + n.kind +
        (selected === n.id ? " tp-selected" : ""), tabindex: "0",
        role: "button", "aria-label": n.label + ", " + k.label });

      g.appendChild(svgEl("rect", { x: n.x, y: n.y, width: k.w, height: k.h,
        rx: n.kind === "cloud" ? 14 : 2 }));

      var label = svgEl("text", { x: n.x + k.w / 2, y: n.y + k.h / 2 + 1,
        "text-anchor": "middle", class: "tp-label" });
      label.textContent = n.label;
      g.appendChild(label);

      var kind = svgEl("text", { x: n.x + k.w / 2, y: n.y + k.h - 6,
        "text-anchor": "middle", class: "tp-kind" });
      kind.textContent = k.label;
      g.appendChild(kind);

      g.addEventListener("pointerdown", function (ev) { startDrag(ev, n); });
      g.addEventListener("keydown", function (ev) { nodeKey(ev, n); });
      g.addEventListener("focus", function () { selected = n.id; renderInspector(); });
      nodes.svg.appendChild(g);

      /* draw() destroys the element that had focus, so focus falls
         back to <body> and the next arrow key scrolls the page
         instead of moving the node — keyboard editing worked for
         exactly one press per Tab. Whoever asked for focus before
         the redraw gets it back on the rebuilt group. */
      if (refocusId === n.id) {
        try { g.focus(); } catch (e) { /* not focusable here, fine */ }
      }
    });

    refocusId = null;
    renderInspector();
  }

  /* ---- interaction ------------------------------------------------ */
  function svgPoint(ev) {
    var r = nodes.svg.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * (W / r.width),
      y: (ev.clientY - r.top) * (H / r.height)
    };
  }

  /* Pointer capture cannot survive this module's own redraw.

     setPointerCapture() binds the pointer to an element, but
     onMove() calls draw(), which tears down every <g> and builds
     new ones — and removing the capturing element from the document
     implicitly releases the capture. So capture died on the first
     mousemove, and a drag released outside the SVG never got its
     pointerup: the node stayed glued to the cursor until you
     clicked back inside.

     Listening on window for the duration of the drag is immune to
     that, because window is not something draw() can delete. The
     listeners go on at pointerdown and come off at pointerup, so
     nothing outlives the gesture. */
  function startDrag(ev, n) {
    selected = n.id;
    var p = svgPoint(ev);
    drag = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    ev.preventDefault();
    renderInspector();
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
    var k = KINDS[n.kind];
    n.x = clamp(Math.round(p.x - drag.dx), 0, W - k.w);
    n.y = clamp(Math.round(p.y - drag.dy), 0, H - k.h);
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

  /* §10F: a drag-only editor is a keyboard trap. */
  function nodeKey(ev, n) {
    var step = ev.shiftKey ? 1 : 10;
    var k = KINDS[n.kind];
    var handled = true;
    if (ev.key === "ArrowLeft") n.x = clamp(n.x - step, 0, W - k.w);
    else if (ev.key === "ArrowRight") n.x = clamp(n.x + step, 0, W - k.w);
    else if (ev.key === "ArrowUp") n.y = clamp(n.y - step, 0, H - k.h);
    else if (ev.key === "ArrowDown") n.y = clamp(n.y + step, 0, H - k.h);
    else if (ev.key === "Delete" || ev.key === "Backspace") {
      /* The mouse path asks before deleting; the keyboard path used
         to just do it, taking the node and every edge touching it
         with no undo. Backspace is also one key away from the arrows
         somebody is already holding down. Same question, both paths. */
      ev.preventDefault();
      if (!confirm("Delete \"" + n.label + "\" and every link to it?\n\nThere is no undo.")) {
        return;
      }
      removeNode(n.id);
      return;
    }
    else handled = false;
    if (handled) {
      ev.preventDefault();
      refocusId = n.id;
      draw();
      save();
    }
  }

  function removeNode(id) {
    current.nodes = current.nodes.filter(function (n) { return n.id !== id; });
    current.edges = current.edges.filter(function (e) { return e.from !== id && e.to !== id; });
    if (selected === id) selected = null;
    draw();
    save();
  }

  /* ---- inspector -------------------------------------------------- */
  function renderInspector() {
    if (!nodes.inspector) return;
    ui.clear(nodes.inspector);
    var n = selected ? nodeById(selected) : null;
    if (!n) {
      nodes.inspector.appendChild(el("div", { class: "tp-none",
        text: "SELECT A NODE — CLICK IT, OR TAB TO IT" }));
      return;
    }

    var nameIn = el("input", { class: "fk-input", value: n.label });
    nameIn.addEventListener("change", function () {
      n.label = nameIn.value.slice(0, 40) || n.id;
      draw(); save();
    });

    var kindSel = el("select", { class: "fk-input" });
    Object.keys(KINDS).forEach(function (k) {
      kindSel.appendChild(el("option", { value: k, text: KINDS[k].label,
        selected: k === n.kind ? true : null }));
    });
    kindSel.addEventListener("change", function () { n.kind = kindSel.value; draw(); save(); });

    nodes.inspector.appendChild(el("div", { class: "tp-grid" }, [
      el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: "LABEL" }), nameIn
      ]),
      el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: "KIND" }), kindSel
      ])
    ]));

    /* Links from this node, editable in place. */
    var mine = current.edges.filter(function (e) { return e.from === n.id || e.to === n.id; });
    nodes.inspector.appendChild(el("div", { class: "tp-subhead", text: "LINKS" }));
    if (!mine.length) {
      nodes.inspector.appendChild(el("div", { class: "tp-none", text: "NONE" }));
    }
    mine.forEach(function (e) {
      var other = e.from === n.id ? e.to : e.from;
      var o = nodeById(other);
      var sel = el("select", { class: "fk-input tp-linkkind" });
      Object.keys(LINKS).forEach(function (k) {
        sel.appendChild(el("option", { value: k, text: LINKS[k].label,
          selected: k === e.kind ? true : null }));
      });
      sel.addEventListener("change", function () { e.kind = sel.value; draw(); save(); });
      nodes.inspector.appendChild(el("div", { class: "tp-linkrow" }, [
        el("span", { class: "tp-linkto", text: (e.from === n.id ? "→ " : "← ") + (o ? o.label : other) }),
        sel,
        ui.button("×", function () {
          current.edges = current.edges.filter(function (x) { return x !== e; });
          draw(); save();
        }, { title: "remove link" })
      ]));
    });

    var toSel = el("select", { class: "fk-input" });
    current.nodes.forEach(function (o) {
      if (o.id === n.id) return;
      if (mine.some(function (e) { return e.from === o.id || e.to === o.id; })) return;
      toSel.appendChild(el("option", { value: o.id, text: o.label }));
    });
    if (toSel.children.length) {
      nodes.inspector.appendChild(el("div", { class: "tp-linkrow" }, [
        toSel,
        ui.button("LINK", function () {
          if (!toSel.value) return;
          current.edges.push({ from: n.id, to: toSel.value, kind: "lan", label: "" });
          draw(); save();
        })
      ]));
    }

    nodes.inspector.appendChild(el("div", { class: "tp-actions" }, [
      ui.button("DELETE NODE", function () {
        if (!confirm("Delete " + n.label + " and its links?")) return;
        removeNode(n.id);
      }, { danger: true })
    ]));
  }

  function renderList() {
    if (!nodes.diagramSel) return;
    ui.clear(nodes.diagramSel);
    if (!diagrams.length) {
      nodes.diagramSel.appendChild(el("option", { value: "", text: "BASTION (UNSAVED DEFAULT)" }));
    }
    diagrams.forEach(function (d) {
      nodes.diagramSel.appendChild(el("option", { value: d.id, text: d.name,
        selected: current && d.id === current.id ? true : null }));
    });
  }

  /* ---- export ------------------------------------------------------
     Standalone: colours inlined, no CSS variables, no script. It has
     to survive being pasted into a document that knows nothing about
     FieldKit's stylesheet. */
  function toSVG() {
    var PALETTE = {
      bg: "#0f1211", line: "#2e3831", fg: "#c2cdc4", dim: "#7c8a80",
      accent: "#e0a63c", info: "#4a9ad4", pass: "#4fbf6a", warn: "#e0a63c"
    };
    var out = [];
    out.push('<svg xmlns="' + NS + '" viewBox="0 0 ' + W + ' ' + H + '" width="' + W +
      '" height="' + H + '" font-family="monospace">');
    out.push('<rect width="' + W + '" height="' + H + '" fill="' + PALETTE.bg + '"/>');

    current.edges.forEach(function (e) {
      var a = nodeById(e.from), b = nodeById(e.to);
      if (!a || !b) return;
      var p1 = edgePoint(a, b), p2 = edgePoint(b, a);
      var link = LINKS[e.kind];
      out.push('<line x1="' + p1.x.toFixed(1) + '" y1="' + p1.y.toFixed(1) +
        '" x2="' + p2.x.toFixed(1) + '" y2="' + p2.y.toFixed(1) +
        '" stroke="' + PALETTE.line + '" stroke-width="1.5"' +
        (link.dash ? ' stroke-dasharray="' + link.dash + '"' : "") + '/>');
      var label = e.label || link.label;
      if (label) {
        out.push('<text x="' + ((p1.x + p2.x) / 2).toFixed(1) + '" y="' +
          ((p1.y + p2.y) / 2 - 4).toFixed(1) + '" fill="' + PALETTE.dim +
          '" font-size="8" text-anchor="middle">' + esc(label) + '</text>');
      }
    });

    current.nodes.forEach(function (n) {
      var k = KINDS[n.kind];
      var stroke = PALETTE[k.colour] || PALETTE.fg;
      out.push('<rect x="' + n.x + '" y="' + n.y + '" width="' + k.w + '" height="' + k.h +
        '" rx="' + (n.kind === "cloud" ? 14 : 2) + '" fill="#121614" stroke="' + stroke +
        '" stroke-width="1"/>');
      out.push('<text x="' + (n.x + k.w / 2) + '" y="' + (n.y + k.h / 2 + 1) +
        '" fill="' + PALETTE.fg + '" font-size="10" text-anchor="middle">' +
        esc(n.label) + '</text>');
      out.push('<text x="' + (n.x + k.w / 2) + '" y="' + (n.y + k.h - 6) +
        '" fill="' + PALETTE.dim + '" font-size="6.5" text-anchor="middle" ' +
        'letter-spacing="1.5">' + esc(k.label) + '</text>');
    });

    out.push("</svg>");
    return out.join("\n");
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---- probes ------------------------------------------------------ */
  function selfcheck(api) {
    return [
      { name: "THE SHIPPED DIAGRAM IS COHERENT", critical: false, run: async function () {
        var d = normalise(DEFAULT, null);
        if (d.nodes.length !== DEFAULT.nodes.length) {
          throw new Error("the default lost nodes on normalise: " + d.nodes.length +
            " of " + DEFAULT.nodes.length);
        }
        if (d.edges.length !== DEFAULT.edges.length) {
          throw new Error("the default lost edges: " + d.edges.length +
            " of " + DEFAULT.edges.length);
        }
        var ids = {};
        d.nodes.forEach(function (n) {
          if (ids[n.id]) throw new Error("duplicate node id in the default: " + n.id);
          ids[n.id] = true;
        });
        /* Nothing floating: a node with no links is either a mistake
           or something that should not be on the diagram. */
        var orphans = d.nodes.filter(function (n) {
          return !d.edges.some(function (e) { return e.from === n.id || e.to === n.id; });
        });
        if (orphans.length) {
          throw new Error("unconnected nodes: " + orphans.map(function (n) { return n.id; }).join(", "));
        }
        return d.nodes.length + " nodes, " + d.edges.length + " edges, none floating";
      } },

      { name: "DANGLING EDGES ARE DROPPED, NOT DRAWN", critical: true, run: async function () {
        var d = normalise({
          name: "t",
          nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 }],
          edges: [
            { from: "a", to: "b", kind: "lan" },
            { from: "a", to: "ghost", kind: "lan" },
            { from: "ghost", to: "b", kind: "lan" },
            { from: "a", to: "a", kind: "lan" }
          ]
        }, null);
        if (d.edges.length !== 1) {
          throw new Error("expected 1 surviving edge, got " + d.edges.length);
        }
        if (d.edges[0].from !== "a" || d.edges[0].to !== "b") throw new Error("the wrong edge survived");
        return "edges to missing nodes and self-links are dropped";
      } },

      { name: "NODES CANNOT BE DRAGGED OFF THE CANVAS", critical: false, run: async function () {
        var d = normalise({ name: "t", nodes: [
          { id: "a", kind: "host", x: -500, y: -500 },
          { id: "b", kind: "host", x: 99999, y: 99999 }
        ], edges: [] }, null);
        d.nodes.forEach(function (n) {
          if (n.x < 0 || n.y < 0) throw new Error(n.id + " is off the top-left");
          if (n.x > W || n.y > H) throw new Error(n.id + " is off the bottom-right");
        });
        if (clamp(50, 0, 10) !== 10 || clamp(-5, 0, 10) !== 0) throw new Error("clamp is wrong");
        return "out-of-range positions are pulled back onto the canvas";
      } },

      { name: "EDGES MEET THE BOX, NOT THE CENTRE", critical: false, run: async function () {
        var a = { id: "a", kind: "host", x: 0, y: 0 };
        var b = { id: "b", kind: "host", x: 400, y: 0 };
        var k = KINDS.host;
        var p = edgePoint(a, b);
        if (Math.abs(p.x - k.w) > 0.5) {
          throw new Error("horizontal edge does not start at the right face: " + p.x);
        }
        var c = { id: "c", kind: "host", x: 0, y: 300 };
        var q = edgePoint(a, c);
        if (Math.abs(q.y - k.h) > 0.5) {
          throw new Error("vertical edge does not start at the bottom face: " + q.y);
        }
        /* Two nodes stacked exactly should not produce NaN. */
        var same = edgePoint(a, { id: "d", kind: "host", x: 0, y: 0 });
        if (!isFinite(same.x) || !isFinite(same.y)) throw new Error("overlapping nodes gave NaN");
        return "edges terminate on the box face, and overlap does not divide by zero";
      } },

      { name: "EXPORTED SVG IS STANDALONE", critical: true, run: async function () {
        var was = current;
        try {
          current = normalise(DEFAULT, null);
          var svg = toSVG();
          if (svg.indexOf("<svg") !== 0) throw new Error("does not start with an svg element");
          if (svg.indexOf("var(--") >= 0) throw new Error("it references CSS variables");
          if (/<script/i.test(svg)) throw new Error("it contains a script");
          if (/xlink:href|<image/i.test(svg)) throw new Error("it references external content");
          if (svg.indexOf("</svg>") < 0) throw new Error("it is not closed");

          /* Every node must actually appear. */
          var missing = current.nodes.filter(function (n) { return svg.indexOf(esc(n.label)) < 0; });
          if (missing.length) {
            throw new Error("missing from the export: " +
              missing.map(function (n) { return n.label; }).join(", "));
          }
          return svg.length + " bytes, no variables, no script, no external refs";
        } finally { current = was; }
      } },

      { name: "LABELS ARE ESCAPED IN THE EXPORT", critical: true, run: async function () {
        var was = current;
        try {
          current = normalise({ name: "t", nodes: [
            { id: "a", label: '</text><script>alert(1)</script>', kind: "host", x: 10, y: 10 },
            { id: "b", label: 'A & B "quoted"', kind: "host", x: 200, y: 10 }
          ], edges: [{ from: "a", to: "b", kind: "lan", label: "<bad>" }] }, null);
          var svg = toSVG();
          if (/<script/i.test(svg)) throw new Error("a label injected a script element");
          if (svg.indexOf("</text><script>") >= 0) throw new Error("a label broke out of its element");
          if (svg.indexOf("&amp;") < 0) throw new Error("an ampersand was not escaped");
          if (svg.indexOf("&quot;") < 0) throw new Error("a quote was not escaped");
          if (svg.indexOf("&lt;bad&gt;") < 0) throw new Error("an edge label was not escaped");
          return "markup in a label cannot escape its element";
        } finally { current = was; }
      } },

      { name: "IT IS REACHABLE WITHOUT A MOUSE", critical: false, run: async function () {
        var was = current, wasSel = selected;
        savePaused = true;
        try {
          current = normalise(DEFAULT, null);
          draw();
          var focusable = nodes.svg.querySelectorAll('[tabindex="0"]');
          if (focusable.length !== current.nodes.length) {
            throw new Error("only " + focusable.length + " of " + current.nodes.length +
              " nodes are focusable");
          }
          var n = current.nodes[0];
          var x0 = n.x;
          nodeKey({ key: "ArrowRight", shiftKey: false, preventDefault: function () {} }, n);
          if (n.x !== x0 + 10) throw new Error("arrow key did not move the node");
          nodeKey({ key: "ArrowLeft", shiftKey: true, preventDefault: function () {} }, n);
          if (n.x !== x0 + 9) throw new Error("shift did not give a fine step");
          return current.nodes.length + " nodes focusable, arrows move, shift is a fine step";
        } finally { savePaused = false; current = was; selected = wasSel; draw(); }
      } },

      /* Every interaction ends in draw(); save(), and save() awaits
         a store round trip before current.id exists. Two of those
         overlapping on an unsaved diagram used to create two
         records — you end up with two BASTIONs and no idea which
         one you are editing. */
      { name: "TWO SAVES OF A NEW DIAGRAM MAKE ONE RECORD", critical: true,
        run: async function () {
          var was = current, wasPaused = savePaused;
          var realPut = ctx.store.put, realList = ctx.store.list;
          var creates = 0, updates = 0;
          ctx.store.put = function (type, payload, opts) {
            if (opts && opts.id) updates++; else creates++;
            return Promise.resolve({ id: "probe-fake-id" });
          };
          ctx.store.list = function () { return Promise.resolve([]); };
          try {
            savePaused = false;
            current = normalise(DEFAULT, null);
            var a = save(), b = save();
            await a;
            await b;
            if (creates !== 1) {
              throw new Error("two overlapping saves created " + creates + " records");
            }
            if (current.id !== "probe-fake-id") {
              throw new Error("the new id was not carried back onto the diagram");
            }
            if (updates !== 1) {
              throw new Error("the second save should have been an update, got " + updates);
            }
            return "one create, one update — no duplicate diagram";
          } finally {
            ctx.store.put = realPut;
            ctx.store.list = realList;
            savePaused = wasPaused;
            current = was;
          }
        } },

      /* draw() rebuilds every node, which silently dropped keyboard
         focus — so arrow keys worked once per Tab and then started
         scrolling the page instead. */
      { name: "KEYBOARD FOCUS SURVIVES A REDRAW", critical: false, run: async function () {
        var was = current, wasSel = selected, wasPaused = savePaused;
        savePaused = true;
        try {
          current = normalise(DEFAULT, null);
          draw();
          var first = nodes.svg.querySelectorAll('[tabindex="0"]')[0];
          if (!first) throw new Error("nothing is focusable");
          first.focus();
          if (document.activeElement !== first) {
            return "this engine will not focus an SVG group — cannot test here";
          }
          var n = current.nodes[0];
          nodeKey({ key: "ArrowRight", shiftKey: false, preventDefault: function () {} }, n);
          if (document.activeElement === document.body) {
            throw new Error("focus fell back to body after one arrow key");
          }
          var now = document.activeElement;
          if (!now || now.getAttribute("aria-label") !== first.getAttribute("aria-label")) {
            throw new Error("focus did not land back on the same node");
          }
          return "the moved node still has focus, so the next arrow key moves it too";
        } finally { savePaused = wasPaused; current = was; selected = wasSel; draw(); }
      } },

      { name: "A RELOADED DIAGRAM IS COHERENT", critical: false, run: async function () {
        /* Two nodes sharing an id: nodeById only ever finds the
           first, so the second draws but cannot be selected, moved
           or deleted — a box that ignores you. */
        var d = normalise({
          name: "t",
          nodes: [{ id: "a", label: "First", kind: "host", x: 10, y: 10 },
                  { id: "a", label: "Second", kind: "host", x: 90, y: 90 },
                  { id: "wide", label: "Wide", kind: "cloud", x: 9999, y: 9999 }],
          edges: [{ from: "a", to: "wide" }]
        }, null);
        if (d.nodes.length !== 2) {
          throw new Error("a duplicate id survived: " +
            d.nodes.map(function (n) { return n.id; }).join(","));
        }
        if (d.nodes[0].label !== "First") throw new Error("the wrong duplicate was kept");

        /* Clamped against its OWN box, not a guessed 60x40 — a cloud
           is wider, and the old clamp let it hang off the canvas. */
        var wide = d.nodes[1];
        if (wide.x + KINDS[wide.kind].w > W) {
          throw new Error("a wide node was clamped past the right edge: " +
            (wide.x + KINDS[wide.kind].w) + " > " + W);
        }
        if (wide.y + KINDS[wide.kind].h > H) {
          throw new Error("a tall node was clamped past the bottom edge");
        }
        if (d.edges.length !== 1) throw new Error("a valid edge was dropped");
        return "duplicate ids dropped, positions clamped to each node's real size";
      } },

      /* The probes above drive real interaction paths. This one
         proves they left nothing behind, so the guard cannot rot. */
      { name: "PROBES DO NOT PERSIST ANYTHING", critical: true, run: async function () {
        var before = (await ctx.store.list(TYPE)).length;
        var was = current;
        savePaused = true;
        try {
          current = normalise(DEFAULT, null);
          var n = current.nodes[0];
          nodeKey({ key: "ArrowRight", shiftKey: false, preventDefault: function () {} }, n);
          await save();
        } finally { savePaused = false; current = was; }
        var after = (await ctx.store.list(TYPE)).length;
        if (after !== before) {
          throw new Error("a probe wrote " + (after - before) + " diagram(s) into the vault");
        }
        return "drove the save path with the guard on, wrote nothing";
      } },

      { name: "A DIAGRAM ROUND TRIPS THROUGH THE VAULT", critical: false, run: async function () {
        var payload = { name: "SELFTEST TOPOLOGY",
          nodes: [{ id: "a", label: "A", kind: "cloud", x: 20, y: 30 }],
          edges: [] };
        var rec = await api.sandbox.put(TYPE, payload);
        var back = normalise(await ctx.store.get(rec.id), rec.id);
        if (back.name !== payload.name) throw new Error("the name did not survive");
        if (back.nodes.length !== 1) throw new Error("the node did not survive");
        if (back.nodes[0].kind !== "cloud") throw new Error("the kind did not survive");
        if (back.nodes[0].x !== 20) throw new Error("the position did not survive");

        var weird = normalise({ name: "x", nodes: [{ id: "a", kind: "spaceship" }] }, null);
        if (weird.nodes[0].kind !== "host") throw new Error("an unknown kind was kept");
        return "persisted and read back; unknown kinds fall back";
      } }
    ];
  }

  FieldKit.register("topology", {
    group: "SERVERS",
    about: "A drawing of how your network fits together",
    keywords: "network diagram map topology",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "TOPOLOGY",
    icon: "⬡",
    width: 900,
    height: 700,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "tp-canvas",
        preserveAspectRatio: "xMidYMid meet" });
      nodes.inspector = el("div");
      nodes.diagramSel = el("select", { class: "fk-input" });
      nodes.diagramSel.addEventListener("change", function () {
        current = diagrams.filter(function (d) { return d.id === nodes.diagramSel.value; })[0] || current;
        selected = null;
        draw();
      });

      nodes.svg.addEventListener("pointermove", onMove);
      nodes.svg.addEventListener("pointerup", onUp);
      nodes.svg.addEventListener("pointercancel", onUp);

      host.appendChild(el("div", { class: "tp-wrap" }, [
        el("div", { class: "tp-toprow" }, [
          el("label", { class: "fk-field tp-selfield" }, [
            el("span", { class: "fk-field-label", text: "DIAGRAM" }), nodes.diagramSel
          ]),
          ui.button("SAVE", function () {
            save().then(function () { ui.toast("SAVED", "ok"); });
          }, { primary: true }),
          ui.button("NEW", function () {
            var name = prompt("Diagram name:");
            if (name === null) return;
            current = normalise({ name: name || "UNTITLED", nodes: [], edges: [] }, null);
            selected = null;
            save();
          })
        ]),

        el("div", { class: "tp-canvaswrap" }, [nodes.svg]),

        el("div", { class: "tp-actions" }, [
          ui.button("ADD NODE", function () {
            var label = prompt("Node label:");
            if (label === null) return;
            label = String(label).trim() || "NODE";
            var n = { id: uniqueId(label), label: label.slice(0, 40), kind: "host",
              x: 60 + (current.nodes.length % 5) * 30, y: 40 + (current.nodes.length % 6) * 26 };
            current.nodes.push(n);
            selected = n.id;
            draw(); save();
          }),
          ui.button("COPY SVG", function () {
            ui.copy(toSVG(), { title: "TOPOLOGY SVG",
              note: "Clipboard access is blocked here. Select this and press Ctrl+C." })
              .then(function (how) { if (how) ui.toast("SVG COPIED", "ok"); });
          }),
          ui.button("SAVE SVG", function () {
            var name = "topology-" + (current.name || "diagram").toLowerCase()
              .replace(/[^a-z0-9]+/g, "-") + ".svg";
            if (ui.download(toSVG(), name, "image/svg+xml")) {
              ui.toast("SAVE ATTEMPTED — CHECK DOWNLOADS FOR " + name, "info");
            } else {
              ui.textDump(toSVG(), "TOPOLOGY SVG", "Downloads are blocked. Copy this and save it.");
            }
          })
        ]),

        ui.panel("SELECTED", [nodes.inspector]),

        el("p", { class: "tp-note", text:
          "Drawn by hand on purpose. Discovery tells you what is talking right now; a diagram " +
          "tells you what is supposed to be, which is what you need when it has stopped — and " +
          "the gap between the two is usually the bug. Drag a node, or Tab to it and use the " +
          "arrow keys." })
      ]));

      await load();
    },

    unmount() { nodes = {}; current = null; selected = null; drag = null; diagrams = []; }
  });

  function injectCSS() {
    if (document.getElementById("tp-style")) return;
    var s = document.createElement("style");
    s.id = "tp-style";
    s.textContent = `
.tp-wrap{height:100%;overflow:auto}
.tp-toprow{display:flex;gap:6px;align-items:flex-end;margin-bottom:8px}
.tp-selfield{flex:1;margin:0}
.tp-canvaswrap{border:1px solid var(--line2);background:var(--bg2);overflow:hidden}
.tp-canvas{display:block;width:100%;height:auto;touch-action:none}
.tp-edge{stroke:var(--line2);stroke-width:1.5}
.tp-edgelabel{fill:var(--fg-dimmer);font-size:8px;font-family:inherit}
.tp-node{cursor:grab}
.tp-node:focus{outline:none}
.tp-node rect{fill:var(--panel);stroke:var(--fg-dim);stroke-width:1}
.tp-node:focus rect,.tp-selected rect{stroke-width:2}
.tp-node:focus rect{stroke:var(--accent)}
.tp-host rect{stroke:var(--accent)}
.tp-service rect{stroke:var(--info)}
.tp-network rect{stroke:var(--pass)}
.tp-cloud rect{stroke:var(--warn)}
.tp-device rect{stroke:var(--fg-dim)}
.tp-label{fill:var(--fg);font-size:10px;font-family:inherit;pointer-events:none}
.tp-kind{fill:var(--fg-dimmer);font-size:6.5px;letter-spacing:1.5px;font-family:inherit;
  pointer-events:none}
.tp-actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.tp-actions .fk-btn{flex:1;min-width:130px}
.tp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px}
.tp-subhead{font-size:9px;letter-spacing:.18em;color:var(--accent-dim);margin:12px 0 5px}
.tp-linkrow{display:flex;gap:6px;align-items:center;margin-bottom:5px}
.tp-linkto{flex:1;font-size:10px;color:var(--fg-dim);letter-spacing:.06em}
.tp-linkkind{flex:0 0 108px;padding:3px 5px;font-size:9px}
.tp-linkrow .fk-btn{padding:2px 8px;font-size:10px;line-height:1.2}
.tp-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:10px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
.tp-none{padding:10px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
