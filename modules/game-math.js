/* ============================================================
   FieldKit :: game-math
   Three calculations a game project needs constantly, in one
   window rather than three desktop icons.

     EASING  what a tween actually looks like, and the numbers
     ATLAS   sprite sheet arithmetic, including the off-by-one
     ODDS    drop tables, and the question people get wrong

   WHY THESE THREE TOGETHER

   Not because they are related — they are not — but because each
   is thirty lines of arithmetic that is annoying to get right and
   easy to get subtly wrong, and none of them deserves its own
   icon. Splitting them into three modules would have been three
   more things on a launcher that was just cut down from a wall of
   thirty-two.

   THE ODDS TAB EXISTS BECAUSE THE INTUITION IS WRONG

   "10% drop rate, so ten kills and I have it" is false, and it is
   false in the direction that makes players feel cheated: the
   real answer is 65%. Getting that number in front of whoever is
   tuning the loot table is worth more than any other calculator
   here.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, tab = "easing";

  /* ---- easing --------------------------------------------------
     The standard Penner set, written as plain functions of t in
     0..1. Named to match Godot's Tween.TRANS_* so a value picked
     here can be typed straight into the engine. */
  var EASES = {
    linear:      function (t) { return t; },
    quadIn:      function (t) { return t * t; },
    quadOut:     function (t) { return t * (2 - t); },
    quadInOut:   function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    cubicIn:     function (t) { return t * t * t; },
    cubicOut:    function (t) { return (--t) * t * t + 1; },
    cubicInOut:  function (t) { return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1; },
    quartOut:    function (t) { return 1 - (--t) * t * t * t; },
    expoOut:     function (t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    sineInOut:   function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
    circOut:     function (t) { return Math.sqrt(1 - (--t) * t); },
    backOut:     function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    elasticOut:  function (t) {
      var c4 = (2 * Math.PI) / 3;
      return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
    bounceOut:   function (t) {
      var n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }
  };

  var EASE_ORDER = ["linear", "quadIn", "quadOut", "quadInOut", "cubicIn", "cubicOut",
    "cubicInOut", "quartOut", "expoOut", "sineInOut", "circOut", "backOut",
    "elasticOut", "bounceOut"];

  function sampleEase(name, steps) {
    var f = EASES[name] || EASES.linear;
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      out.push({ t: t, v: f(t) });
    }
    return out;
  }

  /* SVG rather than canvas: it scales with the window, it survives
     a theme change without a redraw, and it can be copied out as a
     file that opens anywhere. */
  function easeSvg(name, w, h) {
    var pts = sampleEase(name, 96);
    /* backOut and elasticOut overshoot outside 0..1, so the view
       box has to accommodate them or the interesting part of the
       curve is exactly the part that gets clipped. */
    var lo = 0, hi = 1;
    pts.forEach(function (p) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; });
    var pad = 14;
    var span = hi - lo || 1;
    function X(t) { return pad + t * (w - pad * 2); }
    function Y(v) { return h - pad - ((v - lo) / span) * (h - pad * 2); }

    var d = pts.map(function (p, i) {
      return (i ? "L" : "M") + X(p.t).toFixed(2) + " " + Y(p.v).toFixed(2);
    }).join(" ");

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(h));
    svg.setAttribute("class", "gm-svg");

    function line(x1, y1, x2, y2, cls) {
      var l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l.setAttribute("x1", x1); l.setAttribute("y1", y1);
      l.setAttribute("x2", x2); l.setAttribute("y2", y2);
      l.setAttribute("class", cls);
      svg.appendChild(l);
    }
    line(X(0), Y(0), X(1), Y(0), "gm-grid");
    line(X(0), Y(1), X(1), Y(1), "gm-grid");
    line(X(0), Y(lo), X(0), Y(hi), "gm-grid");

    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "gm-curve");
    path.setAttribute("fill", "none");
    svg.appendChild(path);
    return svg;
  }

  function easeTable(name, steps) {
    return sampleEase(name, steps).map(function (p) {
      return p.t.toFixed(3) + "\t" + p.v.toFixed(5);
    }).join("\n");
  }

  /* ---- atlas ---------------------------------------------------
     The arithmetic is trivial and the off-by-one is not: N cells
     have N-1 gaps between them, not N. Getting that wrong gives a
     sheet that looks right at the top-left and drifts by a pixel
     per column, which reads as "the art is bad" rather than "the
     importer settings are wrong". */
  function atlasPlan(o) {
    var usableW = o.sheetW - o.marginX * 2;
    var usableH = o.sheetH - o.marginY * 2;
    if (o.cellW <= 0 || o.cellH <= 0) return { ok: false, why: "cell size must be positive" };
    if (usableW <= 0 || usableH <= 0) return { ok: false, why: "the margins are bigger than the sheet" };

    /* cols cells plus (cols-1) gaps must fit. Solving for cols. */
    var cols = Math.floor((usableW + o.spacingX) / (o.cellW + o.spacingX));
    var rows = Math.floor((usableH + o.spacingY) / (o.cellH + o.spacingY));
    if (cols < 1 || rows < 1) return { ok: false, why: "not even one cell fits" };

    var usedW = cols * o.cellW + (cols - 1) * o.spacingX;
    var usedH = rows * o.cellH + (rows - 1) * o.spacingY;

    return {
      ok: true, cols: cols, rows: rows, frames: cols * rows,
      usedW: usedW, usedH: usedH,
      leftoverX: usableW - usedW,
      leftoverY: usableH - usedH,
      /* Power-of-two matters for older mobile GPUs and for some
         compression formats; worth flagging, not worth enforcing. */
      pot: isPow2(o.sheetW) && isPow2(o.sheetH)
    };
  }

  function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

  function frameRect(o, index, plan) {
    var c = index % plan.cols;
    var r = Math.floor(index / plan.cols);
    return {
      x: o.marginX + c * (o.cellW + o.spacingX),
      y: o.marginY + r * (o.cellH + o.spacingY),
      w: o.cellW, h: o.cellH
    };
  }

  /* ---- odds ----------------------------------------------------
     Two questions, and the second is the one that matters.

       1. weighted table -> per-entry percentage
       2. "p per try, n tries" -> chance of AT LEAST ONE

     People compute the second as p*n, which is wrong and goes over
     100% past 1/p. The right answer is 1-(1-p)^n. */
  function parseTable(text) {
    var out = [];
    String(text).split("\n").forEach(function (raw) {
      var line = raw.trim();
      if (!line || line[0] === "#") return;
      /* "name 10" or "name,10" or "name: 10" — accept whatever
         someone pastes out of a spreadsheet. */
      var m = /^(.*?)[\s,:]+(-?\d+(?:\.\d+)?)\s*$/.exec(line);
      if (!m) { out.push({ name: line, weight: 1, bad: true }); return; }
      out.push({ name: m[1].trim(), weight: Number(m[2]) });
    });
    return out;
  }

  function tableOdds(entries) {
    var total = entries.reduce(function (s, e) { return s + (e.weight > 0 ? e.weight : 0); }, 0);
    return {
      total: total,
      rows: entries.map(function (e) {
        var w = e.weight > 0 ? e.weight : 0;
        var p = total > 0 ? w / total : 0;
        return {
          name: e.name, weight: e.weight, bad: !!e.bad, p: p,
          /* Expected tries to see this once. Infinite for a zero
             weight, which is more honest than showing 0. */
          expected: p > 0 ? 1 / p : Infinity
        };
      })
    };
  }

  function atLeastOnce(p, n) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return 1 - Math.pow(1 - p, n);
  }

  /* How many tries to reach a given confidence. The number a
     designer actually wants: "by when will 90% of players have
     seen this". */
  function triesFor(p, confidence) {
    if (p <= 0 || confidence >= 1) return Infinity;
    if (p >= 1) return 1;
    return Math.ceil(Math.log(1 - confidence) / Math.log(1 - p));
  }

  function pct(x) { return (x * 100).toFixed(2) + "%"; }

  /* ---- rendering ----------------------------------------------- */
  function show(which) {
    tab = which;
    ["easing", "atlas", "odds"].forEach(function (t) {
      if (nodes["pane_" + t]) nodes["pane_" + t].style.display = (t === which) ? "" : "none";
      if (nodes["tab_" + t]) nodes["tab_" + t].classList.toggle("on", t === which);
    });
  }

  function renderEase() {
    if (!nodes.easeOut) return;
    var name = nodes.easeSel.value;
    ui.clear(nodes.easeOut);
    nodes.easeOut.appendChild(easeSvg(name, 420, 190));

    var steps = Math.max(2, Math.min(200, Number(nodes.easeSteps.value) || 10));
    var pts = sampleEase(name, steps);
    var dur = Number(nodes.easeDur.value) || 1;
    var from = Number(nodes.easeFrom.value) || 0;
    var to = nodes.easeTo.value === "" ? 1 : Number(nodes.easeTo.value);

    var lines = pts.map(function (p) {
      return (p.t * dur).toFixed(3) + "s   t=" + p.t.toFixed(3) +
        "   eased=" + p.v.toFixed(5) +
        "   value=" + (from + (to - from) * p.v).toFixed(4);
    });
    nodes.easeText.value = lines.join("\n");
  }

  function renderAtlas() {
    if (!nodes.atlasOut) return;
    var o = {
      sheetW: Number(nodes.aSheetW.value) || 0,
      sheetH: Number(nodes.aSheetH.value) || 0,
      cellW: Number(nodes.aCellW.value) || 0,
      cellH: Number(nodes.aCellH.value) || 0,
      marginX: Number(nodes.aMarginX.value) || 0,
      marginY: Number(nodes.aMarginY.value) || 0,
      spacingX: Number(nodes.aSpacingX.value) || 0,
      spacingY: Number(nodes.aSpacingY.value) || 0
    };
    var plan = atlasPlan(o);
    ui.clear(nodes.atlasOut);

    if (!plan.ok) {
      nodes.atlasOut.appendChild(ui.readout([
        { label: "RESULT", value: plan.why.toUpperCase(), level: "fail" }
      ]));
      nodes.atlasText.value = "";
      return;
    }

    nodes.atlasOut.appendChild(ui.readout([
      { label: "GRID", value: plan.cols + " x " + plan.rows, level: "pass" },
      { label: "FRAMES", value: String(plan.frames), level: "pass" },
      { label: "PIXELS USED", value: plan.usedW + " x " + plan.usedH, level: "dim" },
      { label: "LEFT OVER", value: plan.leftoverX + " x " + plan.leftoverY,
        level: (plan.leftoverX || plan.leftoverY) ? "warn" : "pass" },
      { label: "POWER OF TWO", value: plan.pot ? "YES" : "NO", level: plan.pot ? "pass" : "dim" }
    ]));

    /* Every frame rect, because the reason anyone opens this is to
       paste them into an AtlasTexture or a JSON sheet. */
    var L = [];
    for (var i = 0; i < plan.frames; i++) {
      var r = frameRect(o, i, plan);
      L.push(i + "\tx=" + r.x + "\ty=" + r.y + "\tw=" + r.w + "\th=" + r.h);
    }
    nodes.atlasText.value = L.join("\n");
  }

  function renderOdds() {
    if (!nodes.oddsOut) return;
    var entries = parseTable(nodes.oddsTable.value);
    var res = tableOdds(entries);
    ui.clear(nodes.oddsOut);

    if (!entries.length) {
      nodes.oddsOut.appendChild(el("div", { class: "gm-hint",
        text: "one entry per line:  rare sword 5" }));
      return;
    }

    var rowsUi = res.rows.map(function (r) {
      return {
        label: r.name || "(unnamed)",
        value: r.bad ? "NO WEIGHT FOUND — assumed 1"
          : pct(r.p) + "   (1 in " + (r.expected === Infinity ? "never" : r.expected.toFixed(1)) + ")",
        level: r.bad ? "warn" : (r.weight <= 0 ? "dim" : "pass")
      };
    });
    rowsUi.push({ label: "TOTAL WEIGHT", value: String(res.total), level: "dim" });
    nodes.oddsOut.appendChild(ui.readout(rowsUi));

    /* The counter-intuitive part, computed for the selected row. */
    var n = Math.max(1, Math.min(100000, Number(nodes.oddsTries.value) || 10));
    var target = res.rows.filter(function (r) { return r.weight > 0; })[0];
    if (target) {
      var p = target.p;
      nodes.oddsOut.appendChild(el("div", { class: "gm-odds-note" }, [
        el("div", { class: "gm-odds-title", text:
          "AFTER " + n + " TRIES, CHANCE OF AT LEAST ONE '" + (target.name || "first entry") + "'" }),
        el("div", { class: "gm-odds-big", text: pct(atLeastOnce(p, n)) }),
        el("div", { class: "gm-hint", text:
          "Not " + pct(Math.min(1, p * n)) + ", which is what multiplying gives and is wrong. " +
          "50% of players see it by " + triesFor(p, 0.5) + " tries, " +
          "90% by " + triesFor(p, 0.9) + ", 99% by " + triesFor(p, 0.99) + "." })
      ]));
    }
  }

  function selfcheck() {
    return [
      /* The off-by-one this tab exists to get right. A 256px sheet
         of 32px cells with 2px spacing does NOT hold 8 columns —
         7 gaps eat 14px — and getting it wrong drifts the sheet by
         a pixel per column. */
      { name: "ATLAS COUNTS GAPS, NOT CELLS", critical: true, run: async function () {
        var plan = atlasPlan({ sheetW: 256, sheetH: 64, cellW: 32, cellH: 32,
          marginX: 0, marginY: 0, spacingX: 2, spacingY: 0 });
        if (!plan.ok) throw new Error("refused a valid sheet: " + plan.why);
        /* 7 cells = 224px + 6 gaps = 12px -> 236. An 8th needs
           256+2 = 258 > 256, so 7 is the answer. */
        if (plan.cols !== 7) throw new Error("expected 7 columns, got " + plan.cols);
        var last = frameRect({ cellW: 32, cellH: 32, marginX: 0, marginY: 0,
          spacingX: 2, spacingY: 0 }, 6, plan);
        if (last.x + last.w > 256) throw new Error("the last frame runs off the sheet");
        return "7 columns, last frame ends at " + (last.x + last.w) + "px";
      } },

      { name: "NO SPACING IS THE EXACT DIVISION", critical: false, run: async function () {
        var plan = atlasPlan({ sheetW: 256, sheetH: 128, cellW: 32, cellH: 32,
          marginX: 0, marginY: 0, spacingX: 0, spacingY: 0 });
        if (plan.cols !== 8 || plan.rows !== 4) {
          throw new Error("expected 8x4, got " + plan.cols + "x" + plan.rows);
        }
        if (plan.frames !== 32) throw new Error("expected 32 frames");
        if (plan.leftoverX !== 0 || plan.leftoverY !== 0) throw new Error("reported leftover on an exact fit");
        return "8 x 4 = 32 frames, nothing left over";
      } },

      { name: "AN IMPOSSIBLE SHEET IS REFUSED, NOT GUESSED", critical: false, run: async function () {
        var a = atlasPlan({ sheetW: 16, sheetH: 16, cellW: 32, cellH: 32,
          marginX: 0, marginY: 0, spacingX: 0, spacingY: 0 });
        if (a.ok) throw new Error("a 32px cell 'fit' in a 16px sheet");
        var b = atlasPlan({ sheetW: 64, sheetH: 64, cellW: 0, cellH: 8,
          marginX: 0, marginY: 0, spacingX: 0, spacingY: 0 });
        if (b.ok) throw new Error("a zero-width cell was accepted");
        return "both refused with a reason";
      } },

      /* The whole reason the odds tab exists. */
      { name: "AT-LEAST-ONCE IS NOT MULTIPLICATION", critical: true, run: async function () {
        var p = 0.1;
        var real = atLeastOnce(p, 10);
        if (Math.abs(real - 0.6513) > 0.001) {
          throw new Error("10 tries at 10% should be 65.13%, got " + (real * 100).toFixed(2) + "%");
        }
        /* The failure being guarded against: p*n, which passes 100%
           and keeps going. */
        if (atLeastOnce(0.1, 20) >= 1) throw new Error("probability reached or passed certainty");
        if (atLeastOnce(0.1, 1000) > 1) throw new Error("probability exceeded 1");
        if (atLeastOnce(0, 100) !== 0) throw new Error("a zero chance produced a hit");
        return "10 tries at 10% = " + pct(real) + ", never reaches certainty";
      } },

      { name: "CONFIDENCE THRESHOLDS ARE SANE", critical: false, run: async function () {
        var t50 = triesFor(0.1, 0.5), t90 = triesFor(0.1, 0.9);
        if (t50 !== 7) throw new Error("50% at p=0.1 should be 7 tries, got " + t50);
        if (t90 !== 22) throw new Error("90% at p=0.1 should be 22 tries, got " + t90);
        if (!(t90 > t50)) throw new Error("higher confidence needed fewer tries");
        return "50% by " + t50 + " tries, 90% by " + t90;
      } },

      { name: "WEIGHTED TABLE SUMS TO ONE", critical: false, run: async function () {
        var res = tableOdds(parseTable("common 70\nrare 25\nlegendary 5"));
        if (res.total !== 100) throw new Error("total weight was " + res.total);
        var sum = res.rows.reduce(function (s, r) { return s + r.p; }, 0);
        if (Math.abs(sum - 1) > 1e-9) throw new Error("probabilities summed to " + sum);
        if (Math.abs(res.rows[2].p - 0.05) > 1e-9) throw new Error("legendary was not 5%");
        return "three entries, sums to exactly 1";
      } },

      { name: "TABLE PARSING SURVIVES REAL INPUT", critical: false, run: async function () {
        var rows = parseTable("# a comment\n\nrare sword, 5\nhealth potion: 20\nplain 3\n");
        if (rows.length !== 3) throw new Error("expected 3 entries, got " + rows.length);
        if (rows[0].name !== "rare sword" || rows[0].weight !== 5) {
          throw new Error("comma form parsed wrong: " + JSON.stringify(rows[0]));
        }
        if (rows[1].name !== "health potion" || rows[1].weight !== 20) {
          throw new Error("colon form parsed wrong: " + JSON.stringify(rows[1]));
        }
        /* A name with a space in it must not be split — this is the
           case that breaks a naive split(" "). */
        if (rows[2].name !== "plain") throw new Error("space form parsed wrong");
        return "comments, blanks, commas, colons and multi-word names";
      } },

      { name: "EVERY EASING CURVE STARTS AT 0 AND ENDS AT 1", critical: true, run: async function () {
        var bad = [];
        EASE_ORDER.forEach(function (name) {
          var f = EASES[name];
          if (Math.abs(f(0) - 0) > 1e-6) bad.push(name + " starts at " + f(0));
          if (Math.abs(f(1) - 1) > 1e-6) bad.push(name + " ends at " + f(1));
          /* NaN in an easing function is the bug that makes a tween
             silently do nothing, and it is invisible on a graph. */
          for (var i = 0; i <= 20; i++) {
            var v = f(i / 20);
            if (!isFinite(v)) { bad.push(name + " is not finite at t=" + (i / 20)); break; }
          }
        });
        if (bad.length) throw new Error(bad.join("; "));
        return EASE_ORDER.length + " curves, all anchored and finite";
      } },

      { name: "OVERSHOOTING CURVES ARE NOT CLIPPED", critical: false, run: async function () {
        /* backOut and elasticOut go outside 0..1 on purpose. If the
           graph clamped them the overshoot — the entire reason to
           pick those curves — would be invisible. */
        var svg = easeSvg("backOut", 200, 100);
        var d = svg.querySelector(".gm-curve").getAttribute("d");
        if (!d || d.length < 20) throw new Error("no curve path was drawn");
        var over = sampleEase("backOut", 60).some(function (p) { return p.v > 1.001; });
        if (!over) throw new Error("backOut did not overshoot, so the sample is wrong");
        return "overshoot is sampled and the viewbox grows to fit it";
      } }
    ];
  }

  FieldKit.register("game-math", {
    group: "TOOLS",
    about: "Easing curves, damage and probability maths for games",
    keywords: "math easing tween probability damage calculator",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "GAME MATH",
    icon: "∿",
    width: 900,
    height: 640,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      /* ---- easing pane ---- */
      nodes.easeSel = el("select", { class: "fk-input", onchange: renderEase });
      EASE_ORDER.forEach(function (n) {
        nodes.easeSel.appendChild(el("option", { value: n, text: n }));
      });
      nodes.easeSteps = el("input", { class: "fk-input", type: "number", value: "10",
        oninput: renderEase });
      nodes.easeDur = el("input", { class: "fk-input", type: "number", value: "1",
        step: "0.1", oninput: renderEase });
      nodes.easeFrom = el("input", { class: "fk-input", type: "number", value: "0",
        oninput: renderEase });
      nodes.easeTo = el("input", { class: "fk-input", type: "number", value: "1",
        oninput: renderEase });
      nodes.easeOut = el("div", { class: "gm-graph" });
      nodes.easeText = el("textarea", { class: "fk-input gm-mono", rows: "8", readonly: true });

      nodes.pane_easing = el("div", { class: "gm-pane" }, [
        el("div", { class: "gm-row" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "CURVE" }), nodes.easeSel]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "SAMPLES" }), nodes.easeSteps]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "DURATION (s)" }), nodes.easeDur]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "FROM" }), nodes.easeFrom]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "TO" }), nodes.easeTo])
        ]),
        nodes.easeOut,
        nodes.easeText,
        el("div", { class: "gm-actions" }, [
          ui.button("COPY VALUES", function () {
            ui.copy(nodes.easeText.value, { title: "EASING VALUES" }).then(function (h) {
              if (h) ui.toast("VALUES COPIED", "ok");
            });
          }),
          ui.button("COPY TSV", function () {
            ui.copy(easeTable(nodes.easeSel.value,
              Math.max(2, Math.min(200, Number(nodes.easeSteps.value) || 10))),
              { title: "t / value" }).then(function (h) { if (h) ui.toast("TSV COPIED", "ok"); });
          })
        ]),
        el("div", { class: "gm-hint", text:
          "Curve names match Godot's Tween.TRANS_* set, so what you pick here is what you " +
          "type there. backOut and elasticOut deliberately overshoot past 1 — the graph " +
          "grows to show it rather than clipping it flat." })
      ]);

      /* ---- atlas pane ---- */
      function num(v) {
        return el("input", { class: "fk-input", type: "number", value: String(v),
          oninput: renderAtlas });
      }
      nodes.aSheetW = num(1024); nodes.aSheetH = num(1024);
      nodes.aCellW = num(64);    nodes.aCellH = num(64);
      nodes.aMarginX = num(0);   nodes.aMarginY = num(0);
      nodes.aSpacingX = num(0);  nodes.aSpacingY = num(0);
      nodes.atlasOut = el("div");
      nodes.atlasText = el("textarea", { class: "fk-input gm-mono", rows: "9", readonly: true });

      nodes.pane_atlas = el("div", { class: "gm-pane" }, [
        el("div", { class: "gm-grid4" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "SHEET W" }), nodes.aSheetW]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "SHEET H" }), nodes.aSheetH]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "CELL W" }), nodes.aCellW]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "CELL H" }), nodes.aCellH]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "MARGIN X" }), nodes.aMarginX]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "MARGIN Y" }), nodes.aMarginY]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "SPACING X" }), nodes.aSpacingX]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "SPACING Y" }), nodes.aSpacingY])
        ]),
        nodes.atlasOut,
        nodes.atlasText,
        el("div", { class: "gm-actions" }, [
          ui.button("COPY FRAME RECTS", function () {
            ui.copy(nodes.atlasText.value, { title: "FRAME RECTS" }).then(function (h) {
              if (h) ui.toast("RECTS COPIED", "ok");
            });
          })
        ]),
        el("div", { class: "gm-hint", text:
          "Spacing is the gap BETWEEN cells, so seven cells have six gaps. That off-by-one " +
          "is the one that makes a sheet drift a pixel per column and look like bad art " +
          "rather than a bad import setting." })
      ]);

      /* ---- odds pane ---- */
      nodes.oddsTable = el("textarea", { class: "fk-input gm-mono", rows: "7",
        value: "common 70\nrare 25\nlegendary 5", oninput: renderOdds });
      nodes.oddsTries = el("input", { class: "fk-input", type: "number", value: "10",
        oninput: renderOdds });
      nodes.oddsOut = el("div");

      nodes.pane_odds = el("div", { class: "gm-pane" }, [
        el("div", { class: "gm-row" }, [
          el("label", { class: "fk-field gm-grow" }, [
            el("span", { class: "fk-field-label", text: "DROP TABLE — one per line: name weight" }),
            nodes.oddsTable]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "TRIES" }), nodes.oddsTries])
        ]),
        nodes.oddsOut,
        el("div", { class: "gm-hint", text:
          "Weights do not have to add to 100 — they are relative. The percentage and the " +
          "'1 in N' are computed from the total." })
      ]);

      nodes.tab_easing = el("button", { class: "gm-tab on", type: "button", text: "EASING",
        onclick: function () { show("easing"); renderEase(); } });
      nodes.tab_atlas = el("button", { class: "gm-tab", type: "button", text: "SPRITE ATLAS",
        onclick: function () { show("atlas"); renderAtlas(); } });
      nodes.tab_odds = el("button", { class: "gm-tab", type: "button", text: "DROP ODDS",
        onclick: function () { show("odds"); renderOdds(); } });

      host.appendChild(el("div", { class: "gm-wrap" }, [
        el("div", { class: "gm-tabs" }, [nodes.tab_easing, nodes.tab_atlas, nodes.tab_odds]),
        nodes.pane_easing, nodes.pane_atlas, nodes.pane_odds
      ]));

      show("easing");
      renderEase(); renderAtlas(); renderOdds();
    },

    unmount() { nodes = {}; tab = "easing"; }
  });

  function injectCSS() {
    if (document.getElementById("gm-style")) return;
    var s = document.createElement("style");
    s.id = "gm-style";
    s.textContent = [
      ".gm-wrap{display:flex;flex-direction:column;gap:8px;height:100%}",
      ".gm-tabs{display:flex;gap:4px;flex:0 0 auto}",
      ".gm-tab{font:inherit;font-size:9px;letter-spacing:.14em;background:none;",
      "  border:1px solid var(--line2);color:var(--fg-dim);padding:4px 12px;cursor:pointer}",
      ".gm-tab.on,.gm-tab:hover{border-color:var(--accent);color:var(--accent)}",
      ".gm-pane{display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1 1 auto;min-height:0}",
      ".gm-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}",
      ".gm-row .fk-field{flex:0 0 auto;min-width:110px}",
      ".gm-grow{flex:1 1 320px !important}",
      ".gm-grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}",
      ".gm-graph{border:1px solid var(--line2);background:rgba(0,0,0,.25);padding:4px}",
      ".gm-svg{display:block}",
      ".gm-curve{stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke}",
      ".gm-grid{stroke:var(--line2);stroke-width:1;vector-effect:non-scaling-stroke}",
      ".gm-mono{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;white-space:pre}",
      ".gm-actions{display:flex;gap:6px;flex-wrap:wrap}",
      ".gm-hint{font-size:9px;color:var(--fg-dimmer);line-height:1.5}",
      ".gm-odds-note{border:1px solid var(--line2);padding:8px;margin-top:8px;background:rgba(0,0,0,.2)}",
      ".gm-odds-title{font-size:9px;letter-spacing:.14em;color:var(--fg-dimmer);margin-bottom:4px}",
      ".gm-odds-big{font-size:22px;color:var(--accent);letter-spacing:.04em;margin-bottom:5px}"
    ].join("");
    document.head.appendChild(s);
  }
})(window.FieldKit);
