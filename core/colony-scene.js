/* ============================================================
   FieldKit :: colony-scene — a colony you can watch

   A pixel picture of one DEEPHOLD colony, drawn on a canvas and kept
   alive between visits to the relay: the workers keep walking, the
   lights flicker and the lift runs whether or not new numbers have
   arrived. It draws what the relay last said and invents nothing that
   matters: a building is there because the relay says so, a worker
   stands at a machine because that machine needs one.

   NOT A STRAIGHT LINE PER LEVEL. A colony's shape is grown from its
   owner's name: every layer is its own meandering tunnel with rooms
   set back from it at different heights, caverns behind, and a shaft
   that jogs sideways between layers. A layer that is being dug is a
   half-finished tunnel with a rig at its end. The ground above is
   solid rock until then.

   DEPTH. Rock far behind, rock behind that, the colony, and cables
   and stalactites in front, each moving a little differently as the
   camera scrolls and the pointer moves.

   Pure parts (layoutFor, buildChunk, Crowd) touch no canvas, so tests
   can run them; Scene is the part that draws.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var SP = FieldKit.need("colonySprites");
  var C = SP.C;

  var W = 480, VH = 360, GROUND = 84, TOP0 = 92, LH = 84, MAXL = 10, SLOTS = 8;

  /* ---- randomness, the same every time for the same name ------------ */
  function hash32(s) {
    var h = 2166136261; s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function ih(x, y, s) {
    var h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, sc, s) {
    var gx = x / sc, gy = y / sc, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = ih(x0, y0, s), b = ih(x0 + 1, y0, s), c = ih(x0, y0 + 1, s), d = ih(x0 + 1, y0 + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ---- the look of each biome --------------------------------------- */
  var PAL = {
    seam:    { rock: [[26, 24, 28], [66, 56, 58]], glow: [255, 170, 70], ore: [214, 150, 70], gem: [255, 200, 110], lamp: C.warm },
    aquifer: { rock: [[18, 28, 38], [44, 66, 86]], glow: [90, 190, 255], ore: [120, 170, 200], gem: [150, 230, 255], lamp: C.cyan },
    fungal:  { rock: [[22, 32, 26], [52, 74, 54]], glow: [120, 255, 170], ore: [200, 120, 210], gem: [255, 130, 190], lamp: C.green },
    magma:   { rock: [[40, 22, 20], [92, 48, 34]], glow: [255, 110, 50], ore: [255, 160, 60], gem: [255, 220, 90], lamp: C.orange },
    veins:   { rock: [[24, 22, 44], [60, 54, 92]], glow: [190, 140, 255], ore: [220, 170, 255], gem: [255, 255, 255], lamp: C.violet },
    ruin:    { rock: [[24, 23, 27], [64, 60, 64]], glow: [255, 96, 52], ore: [190, 150, 90], gem: [255, 90, 60], lamp: C.orange }
  };
  function palFor(biome) { return PAL[biome] || PAL.seam; }

  /* ---- the shape of a colony ----------------------------------------- */
  function makeLayer(seed, l, prevX) {
    var r = mulberry(seed ^ Math.imul(l + 1, 0x9E3779B1));
    var top = TOP0 + l * LH;
    var sx = l === 0 ? 58 + Math.floor(r() * 30) : clamp(Math.round(prevX + (r() - 0.5) * 80), 34, 150);
    var ty = top + 42;
    var xL = Math.max(12, sx - 14 - Math.floor(r() * 36));
    var xR = 466 - Math.floor(r() * 14);
    var pts = [], y = ty, drift = 0;
    for (var x = xL; x <= xR + 9; x += 10) {
      drift = drift * 0.7 + (r() - 0.5) * 2.4;
      y = clamp(y + drift, ty - 5, ty + 5);
      pts.push([Math.min(x, xR), Math.round(y)]);
    }
    var L = { l: l, top: top, sx: sx, ty: ty, xL: xL, xR: xR, pts: pts, rooms: [], caverns: [], r: r };
    L.yAt = function (x) {
      var p = L.pts;
      if (x <= p[0][0]) return p[0][1];
      for (var i = 1; i < p.length; i++) if (x <= p[i][0]) { var a = p[i - 1], b = p[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / Math.max(1, b[0] - a[0]); }
      return p[p.length - 1][1];
    };
    /* eight plots: four above the tunnel, four below, set back by different amounts */
    var x0 = sx + 30, x1 = xR - 8, span = x1 - x0;
    for (var i = 0; i < SLOTS; i++) {
      var side = i % 2 === 0 ? -1 : 1, k = Math.floor(i / 2);
      var cx = x0 + span * (k + 0.5) / 4 + Math.round((r() - 0.5) * 8);
      var w = 34 + Math.floor(r() * 7), h = 23 + Math.floor(r() * 4);
      var gap = 8 + Math.floor(r() * 4);
      var tyAt = L.yAt(cx), ry;
      if (side < 0) { ry = Math.round(tyAt - gap - h); ry = Math.max(top + 3, ry); }
      else { ry = Math.round(tyAt + gap); ry = Math.min(top + LH - 3 - h, ry); }
      var room = { slot: i, layer: l, side: side, x: Math.round(cx - w / 2), y: ry, w: w, h: h, cx: Math.round(cx) };
      room.floorY = room.y + room.h - 2;
      L.rooms.push(room);
    }
    /* caverns behind the colony: holes through to the far rock, where nothing is built */
    var tries = 0;
    while (L.caverns.length < 3 && tries++ < 40) {
      var cxx = 20 + r() * 440, cyy = top + 8 + r() * (LH - 16), rad = 9 + r() * 15;
      var clear = true;
      if (cxx > xL - rad - 4 && cxx < xR + rad + 4 && Math.abs(cyy - L.yAt(cxx)) < rad + 12) clear = false;
      for (var q = 0; q < L.rooms.length && clear; q++) {
        var rm = L.rooms[q];
        if (cxx > rm.x - rad - 5 && cxx < rm.x + rm.w + rad + 5 && cyy > rm.y - rad - 5 && cyy < rm.y + rm.h + rad + 5) clear = false;
      }
      if (Math.abs(cxx - sx) < rad + 12) clear = false;
      if (clear) L.caverns.push({ x: cxx, y: cyy, rx: rad * (1 + r() * 0.8), ry: rad * (0.6 + r() * 0.5), s: Math.floor(r() * 1e6) });
    }
    return L;
  }

  /* o: { seed, layers: open layers, dig: { frac } | null } */
  function layoutFor(o) {
    var open = clamp(Math.floor(o.layers || 1), 1, MAXL);
    var total = Math.min(MAXL, open + (o.dig ? 1 : 0));
    var seed = typeof o.seed === "number" ? o.seed : hash32(o.seed);
    var layers = [], prev = 64;
    for (var l = 0; l < total; l++) { var L = makeLayer(seed, l, prev); layers.push(L); prev = L.sx; }
    /* the dig site: where the next layer will start, under the shaft. The
       next layer is grown from the same seed, so the tunnel that is dug
       later starts exactly where the site was. */
    var face = null;
    if (!o.dig && open < MAXL && o.face !== false) {
      var Lp = layers[open - 1], Ln = makeLayer(seed, open, Lp.sx), midY = Lp.ty + Math.round(LH / 2);
      face = { l: open, x: Ln.sx, y: Ln.ty, L: Ln, midY: midY,
        pts: [[Lp.sx, Lp.ty + 4], [Lp.sx, midY], [Ln.sx, midY], [Ln.sx, Ln.ty - 9]],
        cx0: Ln.sx - 26, cx1: Ln.sx + 44, cy0: Ln.ty - 16, cy1: Ln.ty + 10 };
      face.box = { x: Math.min(Lp.sx, Ln.sx) - 10, y: midY - 8, w: Math.max(Lp.sx, Ln.sx + 44) - Math.min(Lp.sx, Ln.sx) + 22, h: Ln.ty + 16 - midY + 8 };
    }
    var bottom = TOP0 + total * LH + (face ? LH + 40 : 26);
    var G = { w: W, seed: seed, open: open, total: total, layers: layers, h: Math.max(VH, bottom), dig: o.dig || null, face: face,
      nodes: [], adj: [], shaft: [], ground: GROUND };

    function node(x, y) { G.nodes.push([x, y]); G.adj.push([]); return G.nodes.length - 1; }
    function link(a, b) { if (a === b) return; G.adj[a].push(b); G.adj[b].push(a); }
    function chain(pts, step) {
      var ids = [];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1], len = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
        var n = Math.max(1, Math.round(len / step));
        for (var j = (i === 0 ? 0 : 1); j <= n; j++) ids.push(node(Math.round(lerp(a[0], b[0], j / n)), Math.round(lerp(a[1], b[1], j / n))));
      }
      for (var k = 1; k < ids.length; k++) link(ids[k - 1], ids[k]);
      return ids;
    }

    /* the surface walk and the top of the shaft */
    var sx0 = layers[0].sx;
    var walk = chain([[Math.max(14, sx0 - 70), GROUND], [sx0, GROUND], [Math.min(W - 14, sx0 + 110), GROUND]], 10);
    G.top = walk.filter(function (id) { return G.nodes[id][0] === sx0; })[0];
    G.surfaceNodes = walk;

    /* the shaft: down, across at mid-height, down again */
    var sp = [[sx0, GROUND]];
    for (var l2 = 0; l2 < total; l2++) {
      var Ly = layers[l2];
      sp.push([Ly.sx, Ly.ty + 4]);
      if (l2 + 1 < total) { var mid = Ly.ty + Math.round(LH / 2); sp.push([Ly.sx, mid]); sp.push([layers[l2 + 1].sx, mid]); }
    }
    var sIds = chain(sp, 8);
    link(G.top, sIds[0]);
    G.shaftPts = sp;
    G.shaftNodes = sIds;

    for (var m = 0; m < total; m++) {
      var Lm = layers[m];
      var ids = chain(Lm.pts.map(function (p) { return [p[0], p[1] + 4]; }), 10);
      Lm.nodes = ids;
      /* the shaft meets the tunnel */
      var best = ids[0], bd = 1e9;
      ids.forEach(function (id) { var d = Math.abs(G.nodes[id][0] - Lm.sx) + Math.abs(G.nodes[id][1] - (Lm.yAt(Lm.sx) + 4)); if (d < bd) { bd = d; best = id; } });
      var meet = sIds.filter(function (id) { return Math.abs(G.nodes[id][0] - Lm.sx) < 2 && Math.abs(G.nodes[id][1] - (Lm.ty + 4)) < 7; });
      meet.forEach(function (id) { link(id, best); });
      Lm.shaftNode = best;
      Lm.rooms.forEach(function (rm) {
        var near = ids[0], nd = 1e9;
        ids.forEach(function (id) { var d = Math.abs(G.nodes[id][0] - rm.cx); if (d < nd) { nd = d; near = id; } });
        var a = G.nodes[near];
        var stub = chain([[a[0], a[1]], [a[0], rm.floorY]], 6);
        link(near, stub[0]);
        rm.door = stub[stub.length - 1];
        rm.doorX = a[0];
        rm.spot0 = rm.x + 5; rm.spot1 = rm.x + rm.w - 5;
      });
    }
    return G;
  }

  /* ---- finding the way ------------------------------------------------ */
  function pathBetween(G, from, to) {
    if (from === to) return [from];
    var prev = {}, q = [from], head = 0;
    prev[from] = -1;
    while (head < q.length) {
      var cur = q[head++];
      if (cur === to) break;
      var a = G.adj[cur];
      for (var i = 0; i < a.length; i++) if (prev[a[i]] === undefined) { prev[a[i]] = cur; q.push(a[i]); }
    }
    if (prev[to] === undefined) return null;
    var out = [], n = to;
    while (n !== -1) { out.push(n); n = prev[n]; }
    return out.reverse();
  }

  /* ---- the ground, one layer at a time -------------------------------- */
  /* state: "solid" | "partial" | "open". Returns { w, h, y0, rgba, mask }.
     Mask: 0 rock, 1 tunnel, 2 room, 3 shaft, 4 cavern (see-through). */
  function buildChunk(G, l, biome, state, prog, repair) {
    var pal = palFor(biome), L = G.layers[l], seed = G.seed & 0xffff;
    var y0 = l < 0 ? 0 : TOP0 + l * LH, h = l < 0 ? TOP0 : LH;
    var mask = new Uint8Array(W * h);
    function set(x, y, v) { x = Math.round(x); y = Math.round(y - y0); if (x < 0 || x >= W || y < 0 || y >= h) return; mask[y * W + x] = v; }
    function rect(x, y, w, hh, v) { for (var j = 0; j < hh; j++) for (var i = 0; i < w; i++) set(x + i, y + j, v); }

    if (l >= 0 && state !== "solid") {
      /* the tunnel, with a ragged roof and floor */
      var reach = state === "partial" ? L.sx + (L.xR - L.sx) * clamp(prog, 0, 1) : L.xR + 1;
      for (var x = L.xL; x <= Math.min(L.xR, reach); x++) {
        var c = L.yAt(x), rough = Math.round((ih(x, l, seed) - 0.5) * 2.2), rough2 = Math.round((ih(x, l + 77, seed) - 0.5) * 2);
        for (var y = Math.round(c - 5 + rough); y <= Math.round(c + 5 + rough2); y++) set(x, y, 1);
      }
      if (state === "open") {
        L.rooms.forEach(function (rm) {
          rect(rm.x, rm.y, rm.w, rm.h, 2);
          /* knock the corners off */
          set(rm.x, rm.y, 0); set(rm.x + rm.w - 1, rm.y, 0); set(rm.x, rm.y + rm.h - 1, 0); set(rm.x + rm.w - 1, rm.y + rm.h - 1, 0);
          for (var i = 0; i < rm.w; i++) { if (ih(i, rm.slot + l * 9, seed) < 0.18) set(rm.x + i, rm.y, 0); }
          var tyAt = L.yAt(rm.doorX);
          var from = rm.side < 0 ? rm.y + rm.h : Math.round(tyAt) + 5, to = rm.side < 0 ? Math.round(tyAt) - 4 : rm.y;
          rect(rm.doorX - 3, Math.min(from, to), 6, Math.abs(to - from) + 1, 2);
        });
      }
      L.caverns.forEach(function (cv) {
        for (var yy = Math.floor(cv.y - cv.ry - 3); yy <= cv.y + cv.ry + 3; yy++) for (var xx = Math.floor(cv.x - cv.rx - 3); xx <= cv.x + cv.rx + 3; xx++) {
          var dx = (xx - cv.x) / cv.rx, dy = (yy - cv.y) / cv.ry, d = dx * dx + dy * dy;
          var n = vnoise(xx, yy, 5, cv.s) * 0.55;
          if (d + n * 0.5 < 0.9) { if (!(yy - y0 < 0 || yy - y0 >= h) && mask[(yy - y0) * W + xx] === 0) set(xx, yy, 4); }
        }
      });
    }
    /* the shaft, wherever it passes through this slice */
    if (l >= 0 || true) {
      var sp = G.shaftPts, lastTy = 0;
      var maxL = state === "solid" ? l - 1 : l;
      var cap = maxL < 0 ? -1 : (G.layers[Math.min(maxL, G.layers.length - 1)].ty + 4);
      if (l === -1 || maxL >= 0) {
        for (var s = 0; s < sp.length - 1; s++) {
          var a = sp[s], b = sp[s + 1];
          var ya = Math.min(a[1], b[1]), yb = Math.max(a[1], b[1]);
          if (yb < y0 - 4 || ya > y0 + h + 4) continue;
          if (ya > cap && l >= 0) continue;
          var stopAt = Math.min(yb, cap < 0 ? yb : cap);
          if (a[0] === b[0]) rect(a[0] - 3, ya - 2, 7, stopAt - ya + 4, 3);
          else rect(Math.min(a[0], b[0]) - 3, a[1] - 3, Math.abs(b[0] - a[0]) + 7, 7, 3);
        }
      }
    }
    void lastTy;

    /* the dig site: a pilot shaft down from the deepest layer, and a
       rough chamber cut where the next tunnel will begin */
    var F = G.face;
    if (F && (l === F.l || l === F.l - 1)) {
      for (var fs = 0; fs < F.pts.length - 1; fs++) {
        var fa = F.pts[fs], fb = F.pts[fs + 1];
        if (fa[0] === fb[0]) rect(fa[0] - 3, Math.min(fa[1], fb[1]) - 2, 7, Math.abs(fb[1] - fa[1]) + 4, 3);
        else rect(Math.min(fa[0], fb[0]) - 3, fa[1] - 3, Math.abs(fb[0] - fa[0]) + 7, 7, 3);
      }
      if (l === F.l) {
        for (var fy = F.cy0 - 3; fy <= F.cy1 + 2; fy++) for (var fx = F.cx0 - 3; fx <= F.cx1 + 3; fx++) {
          var ex = (fx - (F.cx0 + F.cx1) / 2) / ((F.cx1 - F.cx0) / 2), ey = (fy - (F.cy0 + F.cy1) / 2) / ((F.cy1 - F.cy0) / 2);
          var edge = ex * ex * 0.7 + ey * ey * ey * ey + (vnoise(fx, fy, 4, seed + 13) - 0.5) * 0.5;
          if (edge < 0.9 && fy <= F.cy1) set(fx, fy, 5);
        }
      }
    }

    /* colour */
    var px = new Uint8ClampedArray(W * h * 4);
    var rk0 = pal.rock[0], rk1 = pal.rock[1];
    var depth = clamp((y0 - TOP0) / (MAXL * LH), 0, 1);
    function isCave(xx, yy) { if (xx < 0 || xx >= W || yy < 0 || yy >= h) return false; var v = mask[yy * W + xx]; return v === 1 || v === 2 || v === 3 || v === 5; }
    var ruin = biome === "ruin" && l >= 0, rep = clamp((repair || 0) / 100, 0, 1);
    var Lr = ruin ? (G.layers[l] || null) : null;
    /* the old garrison's walls: cut stone around every hall that has been
       opened, crumbling into raw rock where it has not been rebuilt */
    /* where the old builders laid stone: a lining around every hall and
       chamber, and buttress piers between the chambers */
    var piers = [];
    if (Lr) { var px0 = Lr.sx + 30, px1 = Lr.xR - 8; for (var pk = 1; pk < 4; pk++) piers.push(Math.round(px0 + (px1 - px0) * pk / 4)); }
    function lined(xx, wy) {
      if (Math.abs(wy - Lr.yAt(xx)) < 11 && xx >= Lr.xL - 8 && xx <= Lr.xR + 8) return true;
      for (var q = 0; q < Lr.rooms.length; q++) { var rm = Lr.rooms[q]; if (xx >= rm.x - 6 && xx < rm.x + rm.w + 6 && wy >= rm.y - 6 && wy < rm.y + rm.h + 6) return true; }
      for (var p = 0; p < piers.length; p++) if (Math.abs(xx - piers[p]) < 5) return true;
      return false;
    }
    function masonry(xx, wy) {
      if (!Lr || state === "solid" || !lined(xx, wy)) return null;
      var crumble = vnoise(xx, wy, 14, seed + 40) * 0.7 + vnoise(xx, wy, 5, seed + 41) * 0.3;
      if (crumble < 0.3 + 0.32 * (1 - rep)) return null;
      var pier = -1;
      for (var p = 0; p < piers.length; p++) if (Math.abs(xx - piers[p]) < 5) pier = xx - piers[p];
      if (pier > -5 && Math.abs(wy - Lr.yAt(xx)) > 6) {
        /* a buttress: a fluted stone column with a gilded band */
        var pc = 70 - Math.abs(pier) * 6 + (pier === -4 ? 16 : 0);
        if ((wy - Lr.top) % 28 === 4 || (wy - Lr.top) % 28 === 5) return [178, 136, 64];
        return [pc, pc * 0.94, pc * 0.92];
      }
      var course = Math.floor(wy / 8), off = course % 2 ? 9 : 0, bx = Math.floor((xx + off) / 18);
      var v = ih(bx, course, seed + 3), joint = wy % 8 === 0 || (xx + off) % 18 === 0;
      var base = 48 + v * 14 - (crumble < 0.36 + 0.32 * (1 - rep) ? 14 : 0);
      if (joint) return [base * 0.55, base * 0.52, base * 0.56];
      var top = wy % 8 === 1 ? 8 : 0;
      return [base + top + 3, base + top, base + top + 2];
    }
    for (var j = 0; j < h; j++) {
      var wy = y0 + j;
      for (var i2 = 0; i2 < W; i2++) {
        var m = mask[j * W + i2], o = (j * W + i2) * 4, rr, gg, bb, aa = 255;
        if (l < 0) {
          /* the surface band: ground below a ragged line, nothing above (sky is drawn behind) */
          var gl = GROUND - 3 + Math.round((vnoise(i2, 3, 14, seed) - 0.5) * 6);
          if (wy < gl) { px[o + 3] = 0; continue; }
        }
        if (m === 4) { px[o + 3] = 0; /* see-through: the far rock shows */
          continue; }
        if (m === 5) {
          /* the dig chamber: freshly cut rock, loose spoil on the floor */
          var fl = F.cy1 - wy;
          rr = 22 + fl * 0.6; gg = 20 + fl * 0.55; bb = 22 + fl * 0.5;
          if (ih(i2, wy, seed + 7) < 0.08) { rr += 14; gg += 12; bb += 10; }
          if (fl < 3) { var sp2 = ih(i2 >> 1, 1, seed); rr = 56 + sp2 * 30; gg = 48 + sp2 * 24; bb = 42 + sp2 * 18; }
          if (!isCave(i2, j - 1)) { rr = 12; gg = 11; bb = 12; }
        } else if (m === 0) {
          var n1 = vnoise(i2, wy, 9, seed), n2 = vnoise(i2, wy, 4, seed + 5), n3 = vnoise(i2, wy, 22, seed + 9);
          var t = clamp(n1 * 0.55 + n2 * 0.25 + n3 * 0.35 - 0.1, 0, 1);
          var band = Math.sin(wy * 0.11 + n3 * 5) > 0.88 ? 0.12 : 0;
          var dk = 1 - 0.38 * depth - (l < 0 ? 0 : 0.0);
          rr = (lerp(rk0[0], rk1[0], t) + band * 60) * dk; gg = (lerp(rk0[1], rk1[1], t) + band * 55) * dk; bb = (lerp(rk0[2], rk1[2], t) + band * 50) * dk;
          var hh = ih(i2, wy, seed + 21);
          if (state === "solid" && l >= 0) {
            var stra = Math.sin(wy * 0.19 + vnoise(i2, wy, 30, seed + 17) * 7);
            if (stra > 0.7) { rr *= 1.18; gg *= 1.14; bb *= 1.1; } else if (stra < -0.75) { rr *= 0.72; gg *= 0.72; bb *= 0.75; }
            var vein = Math.abs(vnoise(i2, wy, 26, seed + 91) - 0.5);
            if (vein < 0.006) { var vg = 1 - vein / 0.006; rr = lerp(rr, pal.ore[0], vg * 0.6); gg = lerp(gg, pal.ore[1], vg * 0.6); bb = lerp(bb, pal.ore[2], vg * 0.6); }
            if (vnoise(i2, wy, 5, seed + 93) > 0.9 && vnoise(i2, wy, 40, seed + 95) > 0.6 && ih(i2, wy, seed + 94) < 0.45) { rr = pal.gem[0] * 0.75; gg = pal.gem[1] * 0.75; bb = pal.gem[2] * 0.75; }
          }
          if (hh < 0.0018) { rr = pal.ore[0]; gg = pal.ore[1]; bb = pal.ore[2]; }
          else if (hh > 0.9975 - depth * 0.004) { rr = pal.gem[0]; gg = pal.gem[1]; bb = pal.gem[2]; }
          /* rim light where rock meets a hollow */
          var up = isCave(i2, j - 1), lf = isCave(i2 - 1, j), dn = isCave(i2, j + 1), rt = isCave(i2 + 1, j);
          if (up || lf) { rr += 36; gg += 34; bb += 32; }
          if (dn || rt) { rr *= 0.72; gg *= 0.72; bb *= 0.72; }
          if (l < 0 && wy < GROUND + 3) { rr = lerp(rr, 120, 0.25); gg = lerp(gg, 100, 0.25); bb = lerp(bb, 86, 0.25); }
          if (ruin) { var ms = masonry(i2, wy); if (ms) { rr = ms[0] * (1 - 0.3 * depth); gg = ms[1] * (1 - 0.3 * depth); bb = ms[2] * (1 - 0.3 * depth); if (up || lf) { rr += 30; gg += 26; bb += 22; } if (dn || rt) { rr *= 0.7; gg *= 0.7; bb *= 0.7; } } }
        } else if (m === 1) {
          /* tunnel: dark steel, a walkway, beams, a pipe along the roof */
          var cx0 = L.yAt(i2);
          var rel = wy - cx0;
          var base = 20 + (rel + 6) * 1.6;
          rr = base; gg = base + 6; bb = base + 12;
          if (isCave(i2, j - 1) === false) { rr = 12; gg = 15; bb = 20; }
          if (rel >= 3) { rr = 70; gg = 76; bb = 80; if ((i2 + wy) % 4 < 1) { rr = 44; gg = 48; bb = 52; } }
          if (rel >= 4.5) { rr = 30; gg = 34; bb = 38; }
          if (i2 % 30 === 7 || i2 % 30 === 8) { rr = 112; gg = 70; bb = 40; if (rel > -2 && rel < 2) { rr = 70; gg = 44; bb = 28; } }
          if (rel < -3.2 && rel > -4.6 && (i2 % 90) < 70) { rr = 60; gg = 80; bb = 96; }
          if (rel > -1 && rel < 1.3 && (i2 % 14) === 3) { rr += 30; gg += 24; bb += 14; }
          if (ruin) {
            /* a vaulted hall: flagstones, stone piers with gilded capitals, a dark vault */
            rr = 16 + (rel + 6) * 1.4; gg = 14 + (rel + 6) * 1.2; bb = 16 + (rel + 6) * 1.2;
            if (rel >= 3) { var fsx = Math.floor((i2 + (Math.floor(wy) % 2) * 4) / 8); var fv = ih(fsx, l, seed); rr = 58 + fv * 20; gg = 54 + fv * 16; bb = 52 + fv * 14; if (i2 % 8 === 0) { rr = 30; gg = 28; bb = 28; } }
            if (rel >= 4.5) { rr = 26; gg = 24; bb = 24; }
            var pier = (i2 + 11) % 34;
            if (pier < 4 && rel < 3) { rr = 70 + (pier === 0 ? 20 : pier === 3 ? -20 : 0); gg = 64 + (pier === 0 ? 18 : pier === 3 ? -18 : 0); bb = 62 + (pier === 0 ? 16 : pier === 3 ? -18 : 0); if (rel < -3.5) { rr = 196; gg = 150; bb = 70; } }
            if (rel < -4 && pier >= 4) { rr = 10; gg = 9; bb = 11; }
          }
        } else if (m === 2) {
          /* a room: panelled back wall, a floor plate */
          var rm = null;
          for (var q = 0; q < L.rooms.length; q++) { var r2 = L.rooms[q]; if (i2 >= r2.x && i2 < r2.x + r2.w && wy >= r2.y && wy < r2.y + r2.h) { rm = r2; break; } }
          if (rm) {
            var ry = wy - rm.y, rx = i2 - rm.x;
            rr = 36 + ry * 0.7; gg = 44 + ry * 0.7; bb = 52 + ry * 0.7;
            if (ry % 7 === 0) { rr -= 10; gg -= 10; bb -= 10; }
            if (rx % 13 === 6) { rr += 8; gg += 8; bb += 10; }
            if (ry >= rm.h - 2) { rr = 62; gg = 68; bb = 74; }
            if (ry === 0 || rx === 0 || rx === rm.w - 1) { rr -= 16; gg -= 16; bb -= 16; }
            if (biome === "ruin") {
              /* a chapel-hall: stone courses, a gilded cornice and tall
                 pointed windows of red glass, black where still broken */
              var cv2 = ih(Math.floor((rx + (Math.floor(ry / 5) % 2) * 4) / 8), Math.floor(ry / 5) + rm.slot * 7, seed);
              rr = 40 + cv2 * 12 + ry * 0.3; gg = 36 + cv2 * 10 + ry * 0.3; bb = 38 + cv2 * 10 + ry * 0.3;
              if (ry % 5 === 0 || (rx + (Math.floor(ry / 5) % 2) * 4) % 8 === 0) { rr *= 0.7; gg *= 0.7; bb *= 0.7; }
              var nw = Math.max(1, Math.floor((rm.w - 4) / 12)), wsp = (rm.w - nw * 7) / (nw + 1);
              for (var wi = 0; wi < nw; wi++) {
                var wx0 = Math.round(wsp + wi * (7 + wsp)), wpos = rx - wx0, tip = ry - 4;
                if (wpos < 0 || wpos > 6 || tip < 0 || ry > rm.h - 7) continue;
                var half = Math.abs(wpos - 3);
                if (tip < 3 && half > tip) continue;
                var lit = ih(wi, rm.slot + l * 11, seed + 9) < 0.3 + rep * 0.75;
                if (half === 3 || (tip < 3 && half === tip)) { rr = 90; gg = 80; bb = 70; }
                else if (lit) {
                  var gl2 = 1 - tip / Math.max(1, rm.h - 11);
                  rr = 120 + gl2 * 110; gg = 22 + gl2 * 70; bb = 20 + gl2 * 24;
                  if (wpos === 3 || tip === Math.round((rm.h - 11) / 2)) { rr *= 0.5; gg *= 0.5; bb *= 0.5; }
                } else { rr = 10; gg = 9; bb = 11; if (ih(rx, ry, seed + 77) < 0.15) { rr = 60; gg = 30; bb = 26; } }
              }
              if (ry === 1 || ry === 2) { rr = 170 - ry * 30; gg = 128 - ry * 24; bb = 60 - ry * 10; }
              if (rx <= 1 || rx >= rm.w - 2) { rr = 74; gg = 68; bb = 66; }
              if (ry >= rm.h - 2) { rr = 56; gg = 50; bb = 48; }
            }
          } else { rr = 30; gg = 38; bb = 46; }
        } else {
          /* the shaft: dark, with rungs */
          rr = 14; gg = 18; bb = 24;
          if (wy % 4 === 0) { rr = 52; gg = 58; bb = 64; }
          if (isCave(i2 - 1, j) === false) { rr = 56; gg = 62; bb = 70; }
        }
        px[o] = clamp(rr, 0, 255); px[o + 1] = clamp(gg, 0, 255); px[o + 2] = clamp(bb, 0, 255); px[o + 3] = aa;
      }
    }
    return { w: W, h: h, y0: y0, rgba: px, mask: mask };
  }

  /* ---- far rock: a low-resolution picture, drawn big ------------------- */
  function buildFar(seed, biome, kind) {
    var pal = palFor(biome), sc = kind === "far" ? 4 : 2, w = Math.ceil((W + 80) / sc), h = 320;
    var px = new Uint8ClampedArray(w * h * 4);
    var dark = kind === "far" ? 0.34 : 0.5;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var o = (y * w + x) * 4;
      var n = vnoise(x * sc, y * sc, kind === "far" ? 34 : 18, seed + (kind === "far" ? 3 : 8));
      var n2 = vnoise(x * sc, y * sc, kind === "far" ? 9 : 6, seed + 31);
      var t = clamp(n * 0.7 + n2 * 0.3, 0, 1);
      var rr = lerp(pal.rock[0][0], pal.rock[1][0], t) * dark, gg = lerp(pal.rock[0][1], pal.rock[1][1], t) * dark, bb = lerp(pal.rock[0][2], pal.rock[1][2], t) * dark;
      /* big shapes: pillars and a few glowing seams */
      var seam = vnoise(x * sc, y * sc, 60, seed + 55);
      if (Math.abs(seam - 0.5) < 0.012) { rr = lerp(rr, pal.glow[0], 0.5); gg = lerp(gg, pal.glow[1], 0.5); bb = lerp(bb, pal.glow[2], 0.5); }
      var pillar = vnoise(x * sc, 0, 40, seed + 71);
      if (pillar > 0.72 && kind === "far") { rr *= 0.55; gg *= 0.55; bb *= 0.6; }
      px[o] = rr; px[o + 1] = gg; px[o + 2] = bb; px[o + 3] = 255;
    }
    return { w: w, h: h, sc: sc, rgba: px };
  }

  /* ---- the people ------------------------------------------------------- */
  var KINDS = { work: 1, eat: 2, fun: 3, sleep: 4, haul: 5 };

  function Crowd(G, opts) {
    this.G = G; this.list = []; this.rand = mulberry(opts && opts.seed || 7);
    this.nextId = 1; this.jobs = []; this.social = []; this.homes = []; this.lifts = [];
  }
  Crowd.prototype.setLayout = function (G) {
    this.G = G;
    var self = this;
    this.list.forEach(function (w) { self._reset(w); });
  };
  /* places: [{ layer, slot, kind: "job"|"eat"|"fun"|"home"|"lift", staff }], n people */
  Crowd.prototype.setPlaces = function (places, n) {
    var G = this.G, self = this;
    this.jobs = []; this.social = []; this.homes = []; this.lifts = [];
    places.forEach(function (p) {
      var L = G.layers[p.layer];
      if (!L || !L.rooms[p.slot]) return;
      var rm = L.rooms[p.slot];
      if (p.kind === "job") for (var i = 0; i < Math.max(1, p.staff || 1); i++) self.jobs.push({ rm: rm, type: p.type });
      else if (p.kind === "eat" || p.kind === "fun") self.social.push({ rm: rm, kind: p.kind });
      else if (p.kind === "home") self.homes.push({ rm: rm });
      else if (p.kind === "lift") self.lifts.push({ rm: rm });
    });
    n = Math.max(0, Math.min(60, Math.round(n)));
    while (this.list.length < n) this.list.push(this._make());
    while (this.list.length > n) this.list.pop();
    /* give the crew their jobs, the rest wander */
    this.list.forEach(function (w, i) { w.job = self.jobs.length ? self.jobs[i % self.jobs.length] : null; if (i >= self.jobs.length) w.job = null; if (!w.rm) self._reset(w); });
  };
  Crowd.prototype._make = function () {
    var r = this.rand;
    return { id: this.nextId++, x: 0, y: 0, path: null, pi: 0, dir: 1, frame: 0, ft: 0, suit: Math.floor(r() * 7), state: "idle", timer: r() * 4, rm: null,
      speed: 13 + r() * 5, job: null, carry: false, inside: false, spot: 0 };
  };
  Crowd.prototype._reset = function (w) {
    var G = this.G, r = this.rand;
    var rooms = [];
    G.layers.forEach(function (L, li) { if (li < G.open) L.rooms.forEach(function (rm) { rooms.push(rm); }); });
    var rm = (w.job && w.job.rm) || rooms[Math.floor(r() * rooms.length)];
    if (!rm) { var top = G.nodes[G.top]; w.x = top[0]; w.y = top[1]; w.rm = null; w.state = "idle"; w.path = null; return; }
    w.rm = rm; w.x = rm.spot0 + r() * (rm.spot1 - rm.spot0); w.y = rm.floorY; w.inside = true; w.state = "work"; w.timer = 2 + r() * 8; w.path = null; w.node = rm.door;
  };
  Crowd.prototype._goto = function (w, rm, why) {
    var G = this.G, from = w.node;
    if (from === undefined) from = rm.door;
    var p = pathBetween(G, from, rm.door);
    if (!p) { w.state = "work"; w.timer = 4; return; }
    w.path = p; w.pi = 0; w.target = rm; w.state = "walk"; w.why = why; w.inside = false;
    /* if standing inside a room, first walk to its door */
    w.spot = rm.spot0 + this.rand() * (rm.spot1 - rm.spot0);
  };
  Crowd.prototype._choose = function (w) {
    var r = this.rand, roll = r();
    var job = w.job, G = this.G;
    if (job && roll < 0.62) { if (w.rm !== job.rm) return this._goto(w, job.rm, "work"); w.state = "work"; w.timer = 6 + r() * 14; w.carry = false; return; }
    if (job && roll < 0.74 && this.lifts.length) { w.carry = true; return this._goto(w, this.lifts[Math.floor(r() * this.lifts.length)].rm, "haul"); }
    if (roll < 0.86 && this.social.length) { var s = this.social[Math.floor(r() * this.social.length)]; return this._goto(w, s.rm, s.kind); }
    if (this.homes.length && roll < 0.95) return this._goto(w, this.homes[Math.floor(r() * this.homes.length)].rm, "sleep");
    /* wander to any room on any open layer */
    var rooms = [];
    G.layers.forEach(function (L, li) { if (li < G.open) L.rooms.forEach(function (rm) { rooms.push(rm); }); });
    if (rooms.length) return this._goto(w, rooms[Math.floor(r() * rooms.length)], "wander");
    w.state = "work"; w.timer = 5;
  };
  Crowd.prototype.step = function (dt) {
    var G = this.G;
    for (var i = 0; i < this.list.length; i++) {
      var w = this.list[i];
      if (w.state === "walk" && w.path) {
        var remaining = w.speed * dt;
        while (remaining > 0 && w.pi < w.path.length) {
          var n = G.nodes[w.path[w.pi]];
          if (w.inside && w.pi === 0) {
            /* leave the room by walking to the door's column first */
            var dxn = n[0] - w.x;
            var mv = Math.min(Math.abs(dxn), remaining);
            if (Math.abs(dxn) > 0.4) { w.x += Math.sign(dxn) * mv; w.dir = Math.sign(dxn) || w.dir; remaining -= mv; continue; }
            w.inside = false;
          }
          var dx = n[0] - w.x, dy = n[1] - w.y, d = Math.hypot(dx, dy);
          if (d < 0.5) { w.node = w.path[w.pi]; w.pi++; continue; }
          var m = Math.min(d, remaining);
          w.x += dx / d * m; w.y += dy / d * m; remaining -= m;
          if (Math.abs(dx) > 0.3) w.dir = dx > 0 ? 1 : -1;
        }
        if (w.pi >= w.path.length) {
          /* arrived at the door: step inside */
          var rm = w.target;
          w.rm = rm; w.inside = true; w.path = null; w.state = "enter"; w.node = rm.door;
        }
        w.ft += dt * 7; w.frame = Math.floor(w.ft) % 4;
      } else if (w.state === "enter") {
        var tx = w.spot, ddx = tx - w.x;
        if (Math.abs(ddx) > 0.6) { w.x += Math.sign(ddx) * Math.min(Math.abs(ddx), w.speed * dt); w.dir = Math.sign(ddx); w.ft += dt * 7; w.frame = Math.floor(w.ft) % 4; }
        else {
          w.state = "work"; w.frame = 0;
          w.timer = (w.why === "sleep" ? 14 : w.why === "eat" ? 8 : w.why === "fun" ? 10 : w.why === "haul" ? 2 : 7) + this.rand() * 8;
          if (w.why === "haul") w.dropped = true;
        }
      } else {
        w.timer -= dt;
        w.ft += dt * 4; w.frame = Math.floor(w.ft) % 4;
        if (w.timer <= 0) { w.carry = false; this._choose(w); }
      }
    }
  };

  /* ---- what a building looks like it is doing -------------------------- */
  function statusOf(view, cat, cell) {
    var col = view && view.colony; if (!col || !cell) return { run: 0, text: "" };
    var b = cat[cell.t] || {}, s = col.stats || {}, st = col.stock || {}, rate = col.rate || {};
    if (!cell.on) return { run: 0, text: "PAUSED", level: "warn" };
    var powerLow = s.power && s.power[1] > 0 && s.power[0] < s.power[1] * 0.5;
    if (b.power < 0 && powerLow) return { run: 0, text: "NO POWER", level: "bad" };
    if (b.staff > 0 && s.staff && s.staff[1] > 0 && s.staff[0] < s.staff[1] * 0.4) return { run: 0.15, text: "SHORT OF CREW", level: "warn" };
    if (b.inp) for (var k in b.inp) if ((st[k] || 0) < 1 && (rate[k] || 0) <= 0.0005) return { run: 0, text: "OUT OF " + k.toUpperCase(), level: "bad" };
    var eff = clamp(s.eff == null ? 1 : s.eff, 0, 1.2);
    return { run: clamp(eff, 0.2, 1), text: "RUNNING", level: "ok" };
  }

  /* ---- the scene ------------------------------------------------------- */
  function Scene(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas; this.opts = opts;
    this.g = canvas.getContext ? canvas.getContext("2d") : null;
    this.t = 0; this.view = null; this.seedName = ""; this.G = null; this.crowd = null;
    this.camY = 0; this.camTarget = 0; this.mx = 0.5; this.sel = null; this.hover = null;
    this.chunks = {}; this.far = null; this.mid = null; this.glows = {}; this.motes = [];
    this.crates = []; this.launches = []; this.cage = { s: 0, dir: 1, load: 0, wait: 2 };
    this.cat = {}; this.born = {}; this.sig = ""; this.quality = opts.quality || "high"; this.running = false; this.lastDraw = 0;
    this.baseNow = 0; this.baseAt = 0;
    this.onSelect = opts.onSelect || null; this.onHover = opts.onHover || null;
    if (this.g) { this.g.imageSmoothingEnabled = false; canvas.width = W; canvas.height = VH; }
    var r = mulberry(99);
    for (var i = 0; i < 46; i++) this.motes.push({ x: r() * W, y: r() * VH, v: 0.5 + r(), p: r() * 6 });
    this._bind();
  }

  Scene.prototype._bind = function () {
    var self = this, cv = this.canvas;
    if (!cv.addEventListener) return;
    function pos(e) {
      var rc = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0, width: W, height: VH };
      var x = (e.clientX - rc.left) / Math.max(1, rc.width) * W, y = (e.clientY - rc.top) / Math.max(1, rc.height) * VH;
      return { x: x, y: y + self.camY };
    }
    var down = null, moved = 0;
    cv.addEventListener("mousemove", function (e) {
      var p = pos(e);
      self.mx = clamp((e.clientX - (cv.getBoundingClientRect ? cv.getBoundingClientRect().left : 0)) / Math.max(1, cv.getBoundingClientRect ? cv.getBoundingClientRect().width : W), 0, 1);
      if (down) {
        var dy = e.clientY - down.y; moved += Math.abs(dy) + Math.abs(e.clientX - down.x);
        var rc = cv.getBoundingClientRect(); self.camTarget = clamp(down.cam - dy / Math.max(1, rc.height) * VH, 0, Math.max(0, self.worldH() - VH)); self.camY = self.camTarget;
      }
      var h = self.hit(p.x, p.y);
      var key = h ? (h.dig ? "dig" : h.layer + ":" + h.slot) : "";
      if (key !== (self.hover ? (self.hover.dig ? "dig" : self.hover.layer + ":" + self.hover.slot) : "")) { self.hover = h; if (self.onHover) self.onHover(h); if (cv.style) cv.style.cursor = h ? "pointer" : (down ? "grabbing" : "grab"); }
    });
    cv.addEventListener("mousedown", function (e) { down = { x: e.clientX, y: e.clientY, cam: self.camTarget }; moved = 0; });
    var up = function (e) {
      if (down && moved < 5 && e && e.type === "mouseup") {
        var h = self.hit(pos(e).x, pos(e).y);
        self.select(h ? (h.dig ? "dig" : h.layer) : null, h ? h.slot : null, true);
      }
      down = null;
    };
    cv.addEventListener("mouseup", up);
    cv.addEventListener("mouseleave", function () { down = null; self.mx = 0.5; if (self.hover) { self.hover = null; if (self.onHover) self.onHover(null); } });
    cv.addEventListener("wheel", function (e) {
      if (e.preventDefault) e.preventDefault();
      self.camTarget = clamp(self.camTarget + (e.deltaY > 0 ? 1 : -1) * 36, 0, Math.max(0, self.worldH() - VH));
    });
  };

  Scene.prototype.worldH = function () { return this.G ? this.G.h : VH; };

  Scene.prototype.hit = function (x, y) {
    if (!this.G) return null;
    for (var l = 0; l < this.G.open; l++) {
      var L = this.G.layers[l];
      for (var i = 0; i < L.rooms.length; i++) {
        var rm = L.rooms[i];
        if (x >= rm.x - 2 && x < rm.x + rm.w + 2 && y >= rm.y - 2 && y < rm.y + rm.h + 2) return { layer: l, slot: i };
      }
    }
    var F = this.G.face;
    if (F && x >= F.box.x && x < F.box.x + F.box.w && y >= F.box.y && y < F.box.y + F.box.h) return { dig: true };
    if (this.G.dig && this.G.layers[this.G.open]) {
      var Ld = this.G.layers[this.G.open];
      if (x >= Ld.xL - 4 && x <= Ld.xR && Math.abs(y - Ld.yAt(x)) < 16) return { dig: true };
    }
    return null;
  };

  /* layer "dig" selects the dig site */
  Scene.prototype.select = function (layer, slot, fromClick) {
    this.sel = layer == null ? null : layer === "dig" ? { dig: true } : { layer: layer, slot: slot };
    if (this.onSelect) this.onSelect(this.sel, !!fromClick);
  };

  Scene.prototype.focus = function (layer) {
    var y = layer < 0 ? 0 : TOP0 + layer * LH - 70;
    this.camTarget = clamp(y, 0, Math.max(0, this.worldH() - VH));
  };

  /* The relay's last word. Rebuilds the shape only when it changed. */
  Scene.prototype.setView = function (view, name) {
    this.view = view;
    this.baseNow = view.now; this.baseAt = this.t;
    var col = view.colony;
    this.cat = {};
    (view.catalog || []).forEach(function (b) { this.cat[b.id] = b; }, this);
    if (!col) return;
    var dig = col.dig ? { frac: clamp(1 - col.dig.left / Math.max(1, col.dig.total || col.digSeconds || 1), 0, 1) } : null;
    var seed = hash32((name || this.seedName || col.name) + "|" + col.biome);
    var open = col.layers;
    var sig = seed + "|" + open + "|" + (dig ? "d" : "-") + "|" + col.biome;
    if (sig !== this.sig) {
      this.sig = sig; this.seedName = name || this.seedName;
      this.G = layoutFor({ seed: seed, layers: open, dig: dig });
      this.chunks = {}; this.far = null; this.mid = null;
      if (!this.crowd) this.crowd = new Crowd(this.G, { seed: seed ^ 5 }); else this.crowd.setLayout(this.G);
    } else if (this.G) { this.G.dig = dig; }
    this._places(col);
    var grid = col.grid || [];
    for (var l = 0; l < grid.length; l++) for (var s = 0; s < grid[l].length; s++) {
      var c = grid[l][s]; if (c && c.built) this.born[l + ":" + s] = c.built;
    }
    if (this.camTarget === 0 && this.camY === 0 && open > 2 && !this._focused) { this._focused = true; this.focus(Math.max(0, open - 2)); }
  };

  Scene.prototype._places = function (col) {
    var places = [], cat = this.cat;
    var G = this.G;
    (col.grid || []).forEach(function (row, l) {
      row.forEach(function (c, s) {
        if (!c) return;
        var b = cat[c.t] || {};
        if (b.staff > 0 && c.on) places.push({ layer: l, slot: s, kind: "job", staff: b.staff, type: c.t });
        if (c.t === "mess" || c.t === "hydro") places.push({ layer: l, slot: s, kind: "eat" });
        if (c.t === "stimden" || c.t === "vidhall" || c.t === "arcology") places.push({ layer: l, slot: s, kind: "fun" });
        if (b.housing > 0) places.push({ layer: l, slot: s, kind: "home" });
        if (c.t === "lift") places.push({ layer: l, slot: s, kind: "lift" });
      });
    });
    if (this.crowd && G) this.crowd.setPlaces(places, col.pop || 0);
  };

  Scene.prototype.nowServer = function () { return this.baseNow + (this.t - this.baseAt) * 1000; };

  /* ---- time ------------------------------------------------------------- */
  Scene.prototype.step = function (dt) {
    dt = Math.min(dt, 0.25);
    this.t += dt;
    this.camY += (this.camTarget - this.camY) * Math.min(1, dt * 6);
    if (this.crowd && this.G) this.crowd.step(dt);
    /* the cargo lift rides the shaft */
    var G = this.G;
    if (G && this.view && this.view.colony) {
      var sentRate = 0, sent = this.view.colony.sent || {};
      for (var k in sent) sentRate += sent[k];
      this.cage.wait -= dt;
      if (this.cage.wait <= 0 && sentRate > 0.02 && !this.cage.busy) {
        this.cage.busy = true; this.cage.s = this._shaftLen(); this.cage.dir = -1; this.cage.load = 3;
      }
      if (this.cage.busy) {
        this.cage.s += this.cage.dir * 38 * dt;
        if (this.cage.s <= 0) { this.cage.s = 0; this.cage.dir = 1; this.launches.push({ t: 0, x: G.shaftPts[0][0] - 3 }); this.cage.load = 0; }
        if (this.cage.dir === 1 && this.cage.s >= this._shaftLen() * 0.4) { this.cage.busy = false; this.cage.wait = clamp(8 / Math.max(0.15, sentRate), 3, 22); }
      }
    }
    for (var i = this.launches.length - 1; i >= 0; i--) { this.launches[i].t += dt; if (this.launches[i].t > 4) this.launches.splice(i, 1); }
    for (var m = 0; m < this.motes.length; m++) { var mo = this.motes[m]; mo.y += mo.v * dt * 3; mo.x += Math.sin(this.t + mo.p) * dt * 4; if (mo.y > VH) mo.y -= VH; if (mo.x < 0) mo.x += W; if (mo.x > W) mo.x -= W; }
  };

  Scene.prototype._shaftLen = function () {
    var p = this.G.shaftPts, n = 0;
    for (var i = 0; i < p.length - 1; i++) n += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    return n;
  };
  Scene.prototype._shaftAt = function (s) {
    var p = this.G.shaftPts, acc = 0;
    for (var i = 0; i < p.length - 1; i++) {
      var d = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
      if (acc + d >= s) { var f = d ? (s - acc) / d : 0; return [lerp(p[i][0], p[i + 1][0], f), lerp(p[i][1], p[i + 1][1], f)]; }
      acc += d;
    }
    return p[p.length - 1];
  };

  /* ---- drawing -------------------------------------------------------------- */
  function makeCanvas(w, h) {
    var c = document.createElement("canvas"); c.width = w; c.height = h; return c;
  }
  function paint(canvas, data) {
    var g = canvas.getContext("2d");
    var im = g.createImageData(data.w, data.h);
    im.data.set(data.rgba);
    g.putImageData(im, 0, 0);
  }

  Scene.prototype._chunk = function (l) {
    var G = this.G, col = this.view.colony;
    var state = l < 0 ? "open" : l < G.open ? "open" : (G.dig && l === G.open ? "partial" : "solid");
    var prog = state === "partial" ? Math.round(G.dig.frac * 24) / 24 : 0;
    var rp = col.biome === "ruin" ? Math.floor((col.repair || 0) / 10) * 10 : 0;
    var key = state + ":" + prog + ":" + col.biome + ":" + G.seed + ":" + rp + ":" + (G.face ? G.face.l : "-");
    var c = this.chunks[l];
    if (c && c.key === key) return c;
    var data = buildChunk(G, l, col.biome, state, prog, rp);
    var cv = c ? c.canvas : makeCanvas(data.w, data.h);
    paint(cv, data);
    c = { key: key, canvas: cv, y0: data.y0, h: data.h, state: state };
    this.chunks[l] = c;
    return c;
  };

  Scene.prototype._glow = function (rgb) {
    var k = rgb.join(",");
    if (this.glows[k]) return this.glows[k];
    var c = makeCanvas(64, 64), g = c.getContext("2d");
    var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(" + k + ",0.55)"); gr.addColorStop(0.4, "rgba(" + k + ",0.18)"); gr.addColorStop(1, "rgba(" + k + ",0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    this.glows[k] = c; return c;
  };
  var HEX = function (h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; };
  Scene.prototype._light = function (g, x, y, rgb, size, a) {
    g.globalAlpha = a; g.globalCompositeOperation = "lighter";
    g.drawImage(this._glow(rgb), x - size / 2, y - size / 2, size, size);
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
  };

  Scene.prototype.render = function () {
    var g = this.g; if (!g || !this.view || !this.G || !this.view.colony) return;
    var G = this.G, col = this.view.colony, civ = this.view.civ, t = this.t, cam = Math.round(this.camY);
    var pal = palFor(col.biome), low = this.quality === "low";
    var mxo = (this.mx - 0.5);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#07090c"; g.fillRect(0, 0, W, VH);

    /* sky, and the skyline behind the ground */
    if (cam < GROUND + 40) this._sky(g, cam, mxo, civ);

    /* far rock and mid rock */
    if (cam + VH > GROUND - 6) {
      if (!this.far) { var f = buildFar(G.seed & 0xffff, col.biome, "far"); this.far = { c: makeCanvas(f.w, f.h), f: f }; paint(this.far.c, f); }
      if (!this.mid) { var m = buildFar(G.seed & 0xffff, col.biome, "mid"); this.mid = { c: makeCanvas(m.w, m.h), f: m }; paint(this.mid.c, m); }
      g.save(); g.beginPath(); g.rect(0, Math.max(0, GROUND - cam), W, VH); g.clip();
      var ofy = Math.round(-cam * 0.35), ofy2 = Math.round(-cam * 0.65);
      for (var ty = 0; ty < G.h * 0.4 + VH; ty += this.far.f.h * this.far.f.sc) g.drawImage(this.far.c, Math.round(-40 - mxo * 14), ofy + ty + 40, this.far.f.w * this.far.f.sc, this.far.f.h * this.far.f.sc);
      for (var ty2 = 0; ty2 < G.h * 0.7 + VH; ty2 += this.mid.f.h * this.mid.f.sc) g.drawImage(this.mid.c, Math.round(-40 - mxo * 26), ofy2 + ty2 + 20, this.mid.f.w * this.mid.f.sc, this.mid.f.h * this.mid.f.sc);
      g.restore();
    }

    /* the ground itself */
    g.setTransform(1, 0, 0, 1, 0, -cam);
    var first = -1, last = Math.ceil((G.h - TOP0) / LH) - 1;
    for (var l = first; l <= last; l++) {
      var y0 = l < 0 ? 0 : TOP0 + l * LH, hh = l < 0 ? TOP0 : LH;
      if (y0 + hh < cam - 2 || y0 > cam + VH + 2) continue;
      var ch = this._chunk(l);
      g.drawImage(ch.canvas, 0, ch.y0);
    }

    /* behind the buildings: lamps along each open tunnel, and the shaft's lift */
    for (var l2 = 0; l2 < G.open; l2++) {
      var L = G.layers[l2];
      if (L.top + LH < cam || L.top > cam + VH) continue;
      this._tunnelLamps(g, L, col, t);
      this._rooms(g, L, l2, col, t, pal);
    }
    if (G.dig && G.layers[G.open]) this._rig(g, G.layers[G.open], t);
    if (G.face) this._face(g, t, col);
    var fadeY = TOP0 + G.total * LH + (G.face ? 30 : 0);
    if (fadeY < cam + VH) { var fg = g.createLinearGradient(0, fadeY, 0, G.h); fg.addColorStop(0, "rgba(4,5,8,0)"); fg.addColorStop(1, "rgba(4,5,8,.75)"); g.fillStyle = fg; g.fillRect(0, fadeY, W, G.h - fadeY); }
    this._shaft(g, t);

    /* ruins: rubble, banners and the old garrison's statues */
    if (col.biome === "ruin") this._ruin(g, cam, col, t);

    /* surface structures */
    if (cam < GROUND + 10) this._surface(g, t, civ, col);

    /* people */
    if (this.crowd) this._people(g, cam);

    /* glow and weather */
    g.setTransform(1, 0, 0, 1, 0, 0);
    this._motes(g, cam, pal, low);
    this._overlays(g, cam, col, civ, t, mxo);
  };

  Scene.prototype._sky = function (g, cam, mxo, civ) {
    var t = this.t, gy = GROUND - cam;
    var gr = g.createLinearGradient(0, 0, 0, Math.max(10, gy));
    var red = civ && (civ.fallen || (civ.war && civ.war.at && civ.war.at - this.nowServer() < 600000));
    gr.addColorStop(0, red ? "#2a0d10" : "#10161e"); gr.addColorStop(0.6, red ? "#4a1c18" : "#1d2630"); gr.addColorStop(1, red ? "#7a3220" : "#3a3a3c");
    g.fillStyle = gr; g.fillRect(0, 0, W, Math.max(0, gy + 4));
    /* a smear of dying sun, and a ruined skyline in two layers */
    this._lightSky(g, 360 - mxo * 6, gy - 28, red);
    var gothic = this.view && this.view.colony && this.view.colony.biome === "ruin";
    if (gothic) {
      var hx = ((t * 1.6) % (W + 260)) - 130 - mxo * 8, hy = gy - 66;
      g.fillStyle = "#151a20";
      g.fillRect(hx, hy, 96, 6); g.fillRect(hx + 6, hy - 3, 70, 3); g.fillRect(hx + 30, hy - 13, 10, 10); g.fillRect(hx + 33, hy - 19, 4, 6); g.fillRect(hx + 34, hy - 24, 2, 5);
      g.fillRect(hx + 96, hy + 1, 10, 4); g.fillRect(hx + 106, hy + 2, 6, 2); g.fillRect(hx - 8, hy + 1, 8, 4);
      g.fillStyle = "#ffb070"; for (var wi = 0; wi < 9; wi++) if (ih(wi, 3, 7) > 0.4) g.fillRect(hx + 8 + wi * 9, hy + 2, 1, 1);
      g.fillStyle = "rgba(120,180,255,.5)"; g.fillRect(hx - 12, hy + 2, 4, 2);
    }
    for (var layer = 0; layer < 2; layer++) {
      var sh = layer ? 0.6 : 0.35, col = layer ? "#171d24" : "#1f2831", base = gy - 4 - layer * 6;
      g.fillStyle = col;
      var seed = (this.G.seed & 255) + layer * 31;
      for (var x = -10; x < W + 10; x += 9) {
        var hgt = 8 + ih(Math.floor((x + mxo * 40 * sh) / 9), layer, seed) * (layer ? 34 : 52);
        var ox = Math.round(x - mxo * 30 * sh);
        g.fillRect(ox, base - hgt, 8, hgt + 6);
        if (gothic) { for (var sp = 0; sp < 4; sp++) g.fillRect(ox + sp, base - hgt - (4 - sp) * 3, 8 - sp * 2, 3); g.fillRect(ox + 3, base - hgt - 17, 2, 5); }
        else if (ih(Math.floor(x / 9), layer + 5, seed) > 0.7) g.fillRect(ox + 3, base - hgt - 6, 2, 7);
        if (layer === 1 && ih(Math.floor(x / 9), 9, seed) > 0.8 && SP.flick(t, x)) { g.fillStyle = "#ffcf6e"; g.fillRect(ox + 2, base - hgt + 4, 2, 2); g.fillStyle = col; }
      }
    }
    /* rain of ash */
    g.fillStyle = "rgba(180,170,160,.35)";
    for (var i = 0; i < 26; i++) { var px = (i * 53 + t * 12) % W, py = (i * 31 + t * 18) % Math.max(10, gy); g.fillRect(px, py, 1, 1); }
    /* launches into the sky */
    for (var k = 0; k < this.launches.length; k++) {
      var la = this.launches[k], ly = gy - 40 - la.t * la.t * 40;
      g.fillStyle = "#ffd27a"; g.fillRect(la.x, ly, 2, 4); g.fillStyle = "rgba(255,200,120,.4)"; g.fillRect(la.x, ly + 4, 1, 14 + la.t * 8);
    }
  };
  Scene.prototype._lightSky = function (g, x, y, red) {
    var gr = g.createRadialGradient(x, y, 0, x, y, 130);
    gr.addColorStop(0, red ? "rgba(255,90,50,.35)" : "rgba(255,170,90,.28)"); gr.addColorStop(1, "rgba(255,120,60,0)");
    g.fillStyle = gr; g.fillRect(x - 130, y - 130, 260, 260);
  };

  Scene.prototype._tunnelLamps = function (g, L, col, t) {
    var pal = palFor(col.biome), rgb = HEX(pal.lamp);
    var lowPower = col.stats && col.stats.power && col.stats.power[0] < col.stats.power[1] * 0.6;
    for (var x = L.xL + 18; x < L.xR; x += 56) {
      var y = L.yAt(x) - 5, on = lowPower ? SP.flick(t, x) : true;
      g.fillStyle = on ? "#fff1c0" : "#3a3328"; g.fillRect(x, y, 3, 2);
      if (on) this._light(g, x + 1, y + 6, rgb, 44, 0.32 + (SP.flick(t, x + 3) ? 0.05 : 0));
    }
  };

  Scene.prototype._rooms = function (g, L, l, col, t, pal) {
    var grid = col.grid && col.grid[l] || [], cat = this.cat, nowS = this.nowServer();
    for (var i = 0; i < L.rooms.length; i++) {
      var rm = L.rooms[i], cell = grid[i];
      var sel = this.sel && this.sel.layer === l && this.sel.slot === i, hov = this.hover && this.hover.layer === l && this.hover.slot === i;
      if (!cell) {
        /* an empty plot: corner brackets, and a plus that breathes */
        var a = 0.25 + (hov ? 0.5 : 0) + (sel ? 0.4 : 0) + 0.08 * Math.sin(t * 2 + i);
        g.fillStyle = "rgba(255,210,122," + a.toFixed(2) + ")";
        var x = rm.x + 2, y = rm.y + 2, w = rm.w - 4, h = rm.h - 4;
        g.fillRect(x, y, 5, 1); g.fillRect(x, y, 1, 5); g.fillRect(x + w - 5, y, 5, 1); g.fillRect(x + w - 1, y, 1, 5);
        g.fillRect(x, y + h - 1, 5, 1); g.fillRect(x, y + h - 5, 1, 5); g.fillRect(x + w - 5, y + h - 1, 5, 1); g.fillRect(x + w - 1, y + h - 5, 1, 5);
        g.fillRect(rm.x + rm.w / 2 - 3, rm.y + rm.h / 2 - 1, 7, 2); g.fillRect(rm.x + rm.w / 2 - 1, rm.y + rm.h / 2 - 3, 2, 7);
        continue;
      }
      var st = statusOf(this.view, cat, cell);
      var born = this.born[l + ":" + i] || 0, age = born ? (nowS - born) / 1000 : 99;
      var P = SP.pen(g, rm.x, rm.y);
      SP.building(cell.t, P, rm.w, rm.h, { t: t, on: cell.on, run: st.run, build: age < 9 ? clamp(age / 9, 0.05, 1) : 1 });
      if (st.run > 0.3 && cell.on) {
        var rgb = (SP.GLOW && SP.GLOW[cell.t]) || null;
        if (rgb) this._light(g, rm.x + rm.w / 2, rm.y + rm.h / 2, rgb, 52, 0.35 * st.run);
      }
      /* trouble you can see from across the cave */
      if (cell.on && (st.level === "bad") && SP.blink(t, 2)) { g.fillStyle = C.red; g.fillRect(rm.x + rm.w - 8, rm.y - 3, 4, 4); g.fillStyle = C.white; g.fillRect(rm.x + rm.w - 7, rm.y - 2, 2, 2); }
      if (sel || hov) {
        g.strokeStyle = sel ? "#ffd27a" : "rgba(255,255,255,.55)"; g.lineWidth = 1;
        g.strokeRect(rm.x - 0.5, rm.y - 0.5, rm.w + 1, rm.h + 1);
      }
    }
    if (this.view && this.view.recommend && col.recommend) void 0;
  };

  /* a small label with a dark plate behind it */
  Scene.prototype._tag = function (g, cx, y, text, colr) {
    g.font = "bold 8px monospace"; g.textBaseline = "top";
    var w = Math.ceil(g.measureText ? g.measureText(text).width : text.length * 5) + 12, x = Math.round(cx - w / 2);
    x = clamp(x, 2, W - w - 2);
    g.fillStyle = "rgba(6,8,10,.82)"; g.fillRect(x, y, w, 11);
    g.fillStyle = colr; g.fillRect(x, y, w, 1); g.fillRect(x, y + 10, w, 1);
    g.fillText(text, x + 3, y + 2);
  };
  Scene.prototype._afford = function (cost) {
    var st = (this.view && this.view.colony && this.view.colony.stock) || {};
    for (var k in cost) if ((st[k] || 0) < cost[k]) return false;
    return true;
  };
  Scene.prototype._digSel = function (g, x, y, w, h, t) {
    var on = this.sel && this.sel.dig, hov = this.hover && this.hover.dig;
    if (!on && !hov) return;
    g.strokeStyle = on ? "#ffd27a" : "rgba(255,255,255,.6)"; g.lineWidth = 1;
    if (g.setLineDash) { g.setLineDash([3, 2]); g.lineDashOffset = -Math.floor(t * 8); }
    g.strokeRect(x + 0.5, y + 0.5, w, h);
    if (g.setLineDash) g.setLineDash([]);
  };

  /* The dig site under the deepest layer: a pilot shaft, a cut chamber
     propped with beams, a rig parked nose to the rock and the line of the
     tunnel to come. Click it to dig. */
  Scene.prototype._face = function (g, t, col) {
    var F = this.G.face, P = SP.pen(g, 0, 0);
    var locked = !col.digCost, afford = !locked && this._afford(col.digCost);
    var x0 = F.cx0 + 3, x1 = F.cx1 - 4, top = F.cy0 + 3, fl = F.cy1;
    /* the ghost of the tunnel to come */
    g.globalAlpha = 0.2 + 0.1 * Math.sin(t * 1.6);
    var pts = F.L.pts;
    for (var i = 0; i < pts.length; i++) { if (pts[i][0] < F.cx1 + 4) continue; P.r(pts[i][0], pts[i][1] - 5, 4, 1, "#ffd27a"); P.r(pts[i][0], pts[i][1] + 5, 4, 1, "#ffd27a"); }
    F.L.rooms.forEach(function (rm) {
      if (rm.x < F.cx1 + 2) return;
      P.r(rm.x, rm.y, 4, 1, "#ffd27a"); P.r(rm.x, rm.y, 1, 4, "#ffd27a"); P.r(rm.x + rm.w - 4, rm.y + rm.h - 1, 4, 1, "#ffd27a"); P.r(rm.x + rm.w - 1, rm.y + rm.h - 4, 1, 4, "#ffd27a");
    });
    g.globalAlpha = 1;
    /* survey stakes along it, blinking one after another */
    for (var s = 0; s < 4; s++) {
      var sx = Math.round(F.cx1 + 14 + s * 26); if (sx > F.L.xR) break;
      var sy = Math.round(F.L.yAt(sx));
      P.r(sx, sy - 3, 1, 4, "#8a7a5a");
      var on = Math.floor(t * 3) % 5 === s;
      P.r(sx - 1, sy - 5, 3, 2, on ? (locked ? C.red : C.warm) : "#3a3226");
      if (on) this._light(g, sx, sy - 4, locked ? [229, 72, 58] : [255, 190, 90], 22, 0.5);
    }
    /* props and a striped beam */
    P.r(x0, top, 2, fl - top, "#6a5a40"); P.r(x0, top, 1, fl - top, "#8a7656");
    P.r(x1, top, 2, fl - top, "#6a5a40"); P.r(x1, top, 1, fl - top, "#8a7656");
    P.r(x0, top, x1 - x0 + 2, 2, "#2a241c");
    for (var k = x0; k < x1; k += 4) P.r(k, top, 2, 2, locked ? C.red : C.amber);
    /* a work lamp hanging from the beam */
    var lx = Math.round((x0 + x1) / 2) - 6;
    P.r(lx, top + 2, 1, 3, C.k4); P.r(lx - 1, top + 5, 3, 2, "#fff1c0");
    this._light(g, lx, top + 8, locked ? [229, 72, 58] : [255, 200, 120], 52, 0.35 + (SP.flick(t, 4) ? 0.06 : 0));
    /* spoil, crates, a pick left against the wall */
    P.r(x0 + 3, fl - 3, 9, 3, "#5a4c40"); P.r(x0 + 5, fl - 5, 5, 2, "#6a5c4e"); P.r(x0 + 6, fl - 6, 2, 1, "#7a6a5a");
    P.r(x0 + 14, fl - 4, 5, 4, C.bronze); P.r(x0 + 14, fl - 4, 5, 1, C.brass); P.r(x0 + 16, fl - 4, 1, 4, C.rust);
    P.r(x1 - 3, fl - 9, 1, 9, "#7a5a3a"); P.r(x1 - 5, fl - 9, 4, 1, C.k5);
    if (!locked) {
      /* the rig, nose to the rock, its bit turning slowly while it waits */
      var rx = x1 - 22, ry = fl - 9, bc = afford ? C.amber : "#8a6a3a";
      P.r(rx, ry, 13, 8, bc); P.r(rx, ry, 13, 1, afford ? C.warm : "#a88a5a"); P.r(rx + 2, ry + 2, 4, 3, C.k1); P.r(rx + 3, ry + 3, 2, 1, C.cyan);
      for (var z = 0; z < 13; z += 4) P.r(rx + z, ry + 6, 2, 1, C.k0);
      P.r(rx, ry + 8, 13, 1, C.k1); P.r(rx + 1, ry + 8, 2, 1, C.k4); P.r(rx + 9, ry + 8, 2, 1, C.k4);
      var bt = Math.floor(t * (afford ? 6 : 1.5)) % 3;
      P.r(rx + 13, ry + 2, 3, 4, C.k4); P.r(rx + 16, ry + 3, 2, 2, C.k5); P.r(rx + 18, ry + 3 + (bt === 1 ? 1 : 0), 2, 1, C.k6);
      P.r(rx + 8, ry - 2, 2, 2, SP.blink(t, 1.5) ? C.orange : C.dred);
    } else {
      /* sealed: a barrier and a warning plate */
      for (var b2 = x0 + 4; b2 < x1 - 2; b2 += 2) P.r(b2, fl - 8, 2, 2, (b2 / 2) % 2 ? C.red : C.white);
      P.r(x0 + 4, fl - 8, 1, 8, C.k4); P.r(x1 - 3, fl - 8, 1, 8, C.k4);
    }
    /* the sign, and an arrow that bobs when you can dig */
    var label = locked ? "LAYER " + (F.l + 1) + " - STAGE " + (F.l - 1) : afford ? "DIG LAYER " + (F.l + 1) : "DIG SITE - LAYER " + (F.l + 1);
    var lc = locked ? "#ff7a6a" : afford ? "#ffd27a" : "#a3b8c8";
    var ly = F.cy0 - 15;
    this._tag(g, F.x + 6, ly, label, lc);
    if (afford) { var bob = Math.round(Math.sin(t * 4) * 2); P.r(F.x + 3, ly - 7 + bob, 7, 1, lc); P.r(F.x + 4, ly - 6 + bob, 5, 1, lc); P.r(F.x + 5, ly - 5 + bob, 3, 1, lc); P.r(F.x + 6, ly - 4 + bob, 1, 1, lc); }
    this._digSel(g, F.cx0 - 5, ly - 3, F.cx1 - F.cx0 + 10, F.cy1 - ly + 6, t);
  };

  /* The rig at work: a boring machine at the end of a half-cut tunnel,
     rings going in behind it and a cart hauling the spoil away. */
  Scene.prototype._rig = function (g, L, t) {
    var G = this.G, frac = G.dig ? G.dig.frac : 0, P = SP.pen(g, 0, 0);
    var x = Math.round(L.sx + (L.xR - L.sx) * clamp(frac, 0, 1)), y = Math.round(L.yAt(x));
    for (var sx = L.sx + 14; sx < x - 28; sx += 12) { var yy = Math.round(L.yAt(sx)); P.r(sx, yy - 6, 1, 11, "#5a4a32"); P.r(sx - 1, yy - 6, 3, 1, "#8a7656"); }
    for (var lx = L.sx + 22; lx < x - 24; lx += 30) { var ly = Math.round(L.yAt(lx)) - 5; P.r(lx, ly, 2, 1, "#fff1c0"); this._light(g, lx + 1, ly + 5, [255, 200, 120], 30, 0.28); }
    var span = Math.max(8, x - 34 - L.sx), cp = (Math.sin(t * 0.7) + 1) / 2, cx = Math.round(L.sx + 6 + cp * span), cy = Math.round(L.yAt(cx));
    P.r(cx - 4, cy, 9, 3, C.rust); P.r(cx - 4, cy, 9, 1, C.bronze); P.r(cx - 3, cy - 2, 7, 2, "#6a5c4e"); P.r(cx - 3, cy + 3, 2, 1, C.k1); P.r(cx + 2, cy + 3, 2, 1, C.k1);
    var bx = x - 28, by = y - 6;
    P.r(bx, by + 3, 7, 7, C.k3); P.r(bx + 1, by + 4, 5, 2, C.k5); P.r(bx + 7, by + 5, 2, 2, C.k4);
    P.r(bx + 9, by, 17, 11, C.amber); P.r(bx + 9, by, 17, 1, C.warm); P.r(bx + 9, by + 10, 17, 1, "#7a5420");
    for (var k = 0; k < 17; k += 4) P.r(bx + 9 + k, by + 7, 2, 2, C.k0);
    P.r(bx + 12, by + 2, 6, 3, C.k1); P.r(bx + 13, by + 3, 3, 1, SP.flick(t, 9) ? C.cyan : C.blue);
    P.r(bx + 21, by - 2, 2, 2, SP.blink(t, 2) ? C.orange : C.dred);
    var hx = x - 2;
    P.r(hx - 1, y - 7, 4, 14, C.k4); P.r(hx, y - 7, 1, 14, C.k5);
    for (var i = 0; i < 4; i++) { var a = t * 5 + i * Math.PI / 2; P.r(hx + 2 + Math.round(Math.cos(a)), y + Math.round(Math.sin(a) * 6) - 1, 2, 2, C.k6); }
    for (var j = 0; j < 6; j++) { var p = (t * 1.6 + j / 6) % 1; g.fillStyle = "rgba(150,135,120," + (0.55 * (1 - p)).toFixed(2) + ")"; g.fillRect(Math.round(hx + 3 - p * 12), Math.round(y - 2 - p * 5 + Math.sin(j + t) * 2), 2, 2); }
    for (var q = 0; q < 4; q++) { var p2 = (t * 2.6 + q * 0.29) % 1; if (p2 < 0.7) P.r(hx + 4 + p2 * 5, y - 3 + (q - 1.5) * p2 * 5 + p2 * p2 * 6, 1, 1, q % 2 ? C.warm : C.white); }
    this._light(g, hx + 4, y, [255, 190, 90], 60, 0.55);
    this._tag(g, x - 14, Math.round(L.yAt(x)) - 24, "LAYER " + (G.open + 1) + "  " + Math.round(frac * 100) + "%", "#ffd27a");
    this._digSel(g, L.sx - 4, y - 26, x - L.sx + 14, 36, t);
  };

  Scene.prototype._shaft = function (g, t) {
    var G = this.G, c = this.cage;
    var s = c.busy ? c.s : this._shaftLen() * 0.05 + (Math.sin(t * 0.4) + 1) * 4;
    var pt = this._shaftAt(Math.min(s, this._shaftLen()));
    var P = SP.pen(g, pt[0] - 4, pt[1] - 5);
    P.r(0, 0, 9, 9, C.amber); P.r(0, 0, 9, 2, C.warm); P.r(1, 3, 7, 5, C.k1);
    if (c.load > 0) { P.r(2, 3, 5, 3, C.bronze); P.r(2, 3, 5, 1, C.brass); }
    P.r(4, -6, 1, 6, C.k6);
    this._light(g, pt[0], pt[1], [255, 190, 90], 30, 0.3);
  };

  Scene.prototype._surface = function (g, t, civ, col) {
    var G = this.G;
    if (col && col.biome === "ruin") this._fortress(g, t, civ, col);
    else SP.surface(g, t, civ ? civ.stage : 0, { groundY: GROUND - 1, shaftX: G.shaftPts[0][0], stage: civ ? civ.stage : 0 });
    if (civ && civ.stage >= 2) {
      /* the Civ's wall, on the right, cracking as the breach grows */
      var breach = civ.war ? civ.war.breach : 0, hgt = 30;
      g.fillStyle = "#2b333b"; g.fillRect(W - 28, GROUND - hgt, 28, hgt); g.fillStyle = "#46535f"; g.fillRect(W - 28, GROUND - hgt, 28, 3);
      for (var i = 0; i < Math.floor(breach / 12); i++) { g.fillStyle = "#0c0f12"; g.fillRect(W - 26 + (i * 7) % 24, GROUND - hgt + 4 + (i * 11) % 22, 1, 6 + (i % 3) * 3); }
      if (civ.fallen) { g.fillStyle = "#8a2a24"; g.fillRect(W - 24, GROUND - hgt - 12, 3, 12); g.fillRect(W - 21, GROUND - hgt - 12, 9, 6); }
      var soon = civ.war && civ.war.at && civ.war.at - this.nowServer() < 600000;
      if (soon && SP.blink(t, 2)) { g.fillStyle = C.red; g.fillRect(W - 14, GROUND - hgt - 6, 4, 4); this._light(g, W - 12, GROUND - hgt - 4, [255, 60, 40], 60, 0.5); }
    }
  };

  Scene.prototype._people = function (g, cam) {
    var list = this.crowd.list, t = this.t;
    this._uniform = this.view && this.view.colony && this.view.colony.biome === "ruin" ? ["#7a1c1a", "#4b5d6c", "#7a1c1a", "#6a6870", "#a8793c"] : null;
    var P = SP.pen(g, 0, 0), SPR = SP;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.y < cam - 12 || w.y > cam + VH + 12) continue;
      var working = w.state === "work" && w.rm && (w.job && w.job.rm === w.rm) && !w.carry;
      var o = { color: this._uniform ? this._uniform[w.suit % this._uniform.length] : null, dir: w.dir, frame: w.state === "walk" || w.state === "enter" ? w.frame : (working ? w.frame : 0), suit: w.suit, carry: w.carry && w.state === "walk",
        work: working, stand: !(w.state === "walk" || w.state === "enter") };
      var y = Math.round(w.y) + (w.state === "work" && !working && w.why === "sleep" ? 0 : 0);
      if (w.state === "work" && w.why === "sleep") { P.r(Math.round(w.x) - 3, y - 3, 6, 2, "#d8d0bc"); P.r(Math.round(w.x) - 3, y - 4, 2, 2, "#d9b38c"); continue; }
      SPR.person(P, Math.round(w.x), y, o);
    }
  };

  /* The old Imperial garrison: a buried fortress-cathedral. Banners of
     the old crest hang from the vaults, braziers burn at the piers, giant
     stone wardens stand in the caverns and blast doors guard the shaft.
     Everything is broken at first and mends as the repair climbs. */
  function crest(P, x, y, c, d) {
    /* the old crest: a crowned tower between two blades */
    P.r(x + 1, y, 1, 1, c); P.r(x + 3, y, 1, 1, c); P.r(x + 5, y, 1, 1, c);
    P.r(x + 1, y + 1, 5, 1, c); P.r(x + 2, y + 2, 3, 3, c); P.r(x + 3, y + 3, 1, 2, d);
    P.r(x, y + 1, 1, 5, c); P.r(x + 6, y + 1, 1, 5, c); P.r(x + 1, y + 5, 5, 1, c);
  }
  Scene.prototype._ruin = function (g, cam, col, t) {
    var G = this.G, rep = clamp((col.repair || 0) / 100, 0, 1), left = 1 - rep, P = SP.pen(g, 0, 0);
    for (var l = 0; l < G.open; l++) {
      var L = G.layers[l]; if (L.top + LH < cam || L.top > cam + VH) continue;
      var r = mulberry(G.seed + l * 7);
      /* stone wardens in the caverns: headless and broken until the
         garrison is half rebuilt, then whole, with a lit visor */
      for (var c = 0; c < L.caverns.length; c++) {
        var cv = L.caverns[c]; if (cv.ry < 9) continue;
        var hgt = Math.min(Math.round(cv.ry * 1.7), 30), sx = Math.round(cv.x), base = Math.round(cv.y + cv.ry * 0.75);
        var whole = rep >= 0.5 || ih(c, l, G.seed) < rep * 2 - 0.2;
        P.r(sx - 7, base - 3, 15, 3, "#4a4648"); P.r(sx - 7, base - 3, 15, 1, "#6a6466");
        var bh = hgt - 6;
        P.r(sx - 4, base - 3 - bh, 9, bh, "#3a3638"); P.r(sx - 4, base - 3 - bh, 1, bh, "#56504f");
        P.r(sx - 6, base - 3 - bh, 13, 4, "#454042"); P.r(sx - 6, base - 3 - bh, 13, 1, "#625b5b");
        P.r(sx - 3, base - 3 - Math.round(bh * 0.45), 7, 1, "#a8793c");
        P.r(sx + 6, base - 3 - bh + 2, 1, bh, "#5a5658"); P.r(sx + 4, base - 3 - bh + 4, 5, 1, "#a8793c");
        if (whole) {
          P.r(sx - 2, base - 3 - bh - 5, 5, 5, "#454042"); P.r(sx - 2, base - 3 - bh - 5, 5, 1, "#625b5b"); P.r(sx - 1, base - 3 - bh - 3, 3, 1, SP.flick(t, c + l) ? "#ff6a4a" : "#8a2a24");
          P.r(sx + 6, base - 3 - bh - 6, 1, 8, "#7a7476");
        } else {
          P.r(sx + 7, base - 4, 4, 2, "#3a3638"); P.r(sx - 9, base - 2, 3, 2, "#454042");
        }
        this._light(g, sx, base - 3 - bh, [255, 96, 52], 40, 0.12 + rep * 0.12);
      }
      /* blast doors where the shaft meets the hall, open, edged in warning stripes */
      var dx = L.sx + 7, dy = Math.round(L.yAt(L.sx + 7));
      P.r(dx, dy - 6, 3, 11, "#4b4f55"); P.r(dx, dy - 6, 3, 1, "#7a8088");
      for (var s2 = 0; s2 < 11; s2 += 3) P.r(dx + 2, dy - 6 + s2, 1, 2, C.amber);
      P.r(dx + 1, dy - 8, 2, 2, SP.blink(t + l, 1) ? C.red : C.dred);
      /* braziers at the piers: more of them lit as the garrison mends */
      for (var px = L.xL + 23; px < L.xR - 4; px += 34) {
        var lit = ih(px, l, G.seed + 5) < 0.25 + rep * 0.8;
        var fy = Math.round(L.yAt(px)) + 3;
        P.r(px - 1, fy - 3, 4, 2, "#2a2628"); P.r(px, fy - 1, 2, 2, "#3a3638");
        if (lit) {
          var fl2 = Math.floor(t * 9 + px) % 3;
          P.r(px, fy - 5 - (fl2 === 1 ? 1 : 0), 2, 2, C.orange); P.r(px, fy - 4, 2, 1, C.warm);
          this._light(g, px + 1, fy - 5, [255, 110, 50], 34, 0.32 + (fl2 ? 0.04 : 0));
        }
      }
      /* banners of the crest between the piers, torn and dark until mended */
      for (var b = 0; b < 3; b++) {
        var bx = Math.round(L.xL + 40 + b * (L.xR - L.xL - 70) / 2 + (r() - 0.5) * 10), by = Math.round(L.yAt(bx)) - 5;
        var torn = r() < left * 0.9, sway = Math.round(Math.sin(t * 1.1 + b + l) * 0.6);
        var bl = torn ? 5 : 9;
        P.r(bx - 1, by - 1, 9, 1, "#a8793c");
        P.r(bx + sway, by, 7, bl, torn ? "#4a1614" : "#7a1c1a"); P.r(bx + sway, by, 1, bl, torn ? "#5a2018" : "#d9a84e"); P.r(bx + 6 + sway, by, 1, bl, torn ? "#5a2018" : "#d9a84e");
        if (!torn) { crest(P, bx + sway, by + 1, "#d9a84e", "#7a1c1a"); P.r(bx + sway, by + bl, 3, 1, "#7a1c1a"); P.r(bx + 4 + sway, by + bl, 3, 1, "#7a1c1a"); }
        else { P.r(bx + 2 + sway, by + bl, 1, 2, "#4a1614"); P.r(bx + 5 + sway, by + bl, 1, 1, "#4a1614"); }
      }
      /* rubble and old bones: fewer as the garrison is rebuilt */
      var n = Math.round(left * 8);
      for (var k = 0; k < n; k++) {
        var rx = Math.round(L.xL + 8 + r() * (L.xR - L.xL - 16)), ry = Math.round(L.yAt(rx)) + 4;
        P.r(rx, ry - 2, 6, 2, "#4a4648"); P.r(rx + 1, ry - 3, 3, 1, "#625b5b"); P.r(rx + 4, ry - 1, 4, 1, "#2a2628");
        if (k % 3 === 0) { P.r(rx + 2, ry - 4, 2, 2, C.bone); P.r(rx + 2, ry - 3, 1, 1, "#2a2628"); }
      }
      /* a torn cable that spits sparks until the power is properly restored */
      if (rep < 0.6) {
        var cx = Math.round(L.xL + 60 + r() * (L.xR - L.xL - 120)), cy = Math.round(L.yAt(cx)) - 5;
        P.r(cx, cy, 1, 4, "#222"); P.r(cx + 1, cy + 3, 1, 2, "#333");
        if (SP.blink(t * 1.7 + l, 3)) { P.r(cx, cy + 5, 2, 1, C.white); P.r(cx - 1, cy + 6, 1, 1, C.warm); P.r(cx + 2, cy + 7, 1, 1, C.warm); this._light(g, cx, cy + 5, [180, 210, 255], 22, 0.4); }
      }
    }
  };

  /* The garrison above ground: a gatehouse of two spired towers over the
     shaft, a crenellated wall with a gun battery, searchlights, and a
     wrecked dropship half buried beside it. */
  Scene.prototype._fortress = function (g, t, civ, col) {
    var G = this.G, P = SP.pen(g, 0, 0), gy = GROUND - 1, sx = G.shaftPts[0][0];
    var rep = clamp((col.repair || 0) / 100, 0, 1);
    var ST = "#3e3b40", ST2 = "#56525a", ST3 = "#2a282c", GOLD = "#c9973e";
    /* searchlights sweeping the sky */
    if (rep >= 0.2) {
      for (var s = 0; s < 2; s++) {
        var ox = sx - 16 + s * 34, oy = gy - 58, ang = -Math.PI / 2 + Math.sin(t * 0.35 + s * 2.1) * 0.6;
        g.globalCompositeOperation = "lighter"; g.fillStyle = "rgba(255,220,170,.07)";
        g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox + Math.cos(ang - 0.08) * 220, oy + Math.sin(ang - 0.08) * 220); g.lineTo(ox + Math.cos(ang + 0.08) * 220, oy + Math.sin(ang + 0.08) * 220); g.closePath(); g.fill();
        g.globalCompositeOperation = "source-over";
      }
    }
    /* the curtain wall, gapped where it has not been rebuilt */
    var w0 = sx - 46, w1 = Math.min(W - 40, sx + 170), wh = 20;
    for (var x = w0; x < w1; x += 7) {
      var gone = ih(Math.floor(x / 7), 3, G.seed) > 0.45 + rep * 0.6;
      var hh = gone ? Math.round(wh * (0.25 + ih(x, 4, G.seed) * 0.3)) : wh;
      P.r(x, gy - hh, 7, hh, ST); P.r(x, gy - hh, 7, 1, ST2);
      if (!gone) { P.r(x, gy - wh - 4, 4, 4, ST); P.r(x, gy - wh - 4, 4, 1, ST2); }
      else { P.r(x + 1, gy - 3, 5, 3, "#4a4648"); P.r(x + 2, gy - 4, 2, 1, "#625b5b"); }
      if (!gone && Math.floor(x / 7) % 3 === 1) { P.r(x + 3, gy - wh + 5, 1, 5, ST3); if (SP.flick(t, x)) P.r(x + 3, gy - wh + 7, 1, 2, "#ff6a4a"); }
    }
    P.r(w0, gy - 6, w1 - w0, 1, ST3);
    /* the gun battery on the wall */
    var gx = sx + 96;
    P.r(gx, gy - wh - 9, 22, 9, ST3); P.r(gx, gy - wh - 9, 22, 1, ST2); P.r(gx + 2, gy - wh - 7, 4, 2, rep >= 0.7 ? "#ff6a4a" : "#3a1a18");
    var lift = rep >= 0.7 ? Math.sin(t * 0.3) * 0.15 : 0.35;
    for (var bb = 0; bb < 2; bb++) {
      var ang2 = -0.5 - lift, bxs = gx + 12, bys = gy - wh - 7 + bb * 3;
      for (var i = 0; i < 18; i++) P.r(bxs + Math.cos(ang2) * i, bys + Math.sin(ang2) * i, 2, 2, i > 15 ? "#2a282c" : "#6a6870");
    }
    if (rep >= 0.7 && ((t * 0.25) % 5) < 0.12) { var mx = gx + 12 + Math.cos(-0.5) * 19, my = gy - wh - 7 + Math.sin(-0.5) * 19; P.r(mx - 2, my - 2, 5, 5, C.warm); this._light(g, mx, my, [255, 200, 120], 50, 0.7); }
    /* the gatehouse: two towers with spires, a pointed gate over the shaft */
    for (var tw = 0; tw < 2; tw++) {
      var tx = sx - 22 + tw * 34, th = 50;
      P.r(tx, gy - th, 12, th, ST); P.r(tx, gy - th, 1, th, ST2); P.r(tx + 11, gy - th, 1, th, ST3);
      for (var c = 0; c < 3; c++) P.r(tx + c * 4, gy - th - 3, 3, 3, ST);
      P.r(tx + 5, gy - th + 8, 2, 6, ST3); P.r(tx + 5, gy - th + 9, 2, 4, SP.flick(t, tw + 11) ? "#ff7a3a" : "#8a2a24");
      P.r(tx + 5, gy - th + 22, 2, 5, ST3);
      var broken = tw === 1 && rep < 0.45;
      var sp = broken ? 6 : 18;
      for (var y2 = 0; y2 < sp; y2++) { var wdt = Math.max(1, Math.round(10 * (1 - y2 / 18))); P.r(tx + 6 - Math.ceil(wdt / 2), gy - th - 3 - y2, wdt, 1, y2 % 4 === 0 ? ST2 : ST); }
      if (!broken) { P.r(tx + 5, gy - th - 24, 2, 4, GOLD); P.r(tx + 4, gy - th - 22, 4, 1, GOLD); lamp2(P, tx + 5, gy - th - 26, t, tw); }
      else { P.r(tx + 2, gy - th - 9, 3, 2, ST2); P.r(tx + 14, gy - 3, 4, 3, "#4a4648"); }
    }
    /* the gate: a pointed arch, its blast door raised as far as the repair */
    var ax = sx - 10, aw = 22, ah = 30;
    P.r(ax - 2, gy - ah - 6, aw + 4, ah + 6, ST);
    for (var yy = 0; yy < ah; yy++) {
      var inset = yy < 8 ? Math.round((8 - yy) * 1.2) : 0;
      P.r(ax + inset, gy - ah + yy, aw - inset * 2, 1, "#0d0b0c");
    }
    var door = Math.round(ah * (0.2 + rep * 0.6));
    P.r(ax, gy - door, aw, door, "#4b4f55"); for (var d = 0; d < door; d += 4) P.r(ax, gy - door + d, aw, 1, "#3a3d42");
    for (var st = 0; st < aw; st += 4) P.r(ax + st, gy - door, 2, 1, C.amber);
    this._light(g, sx, gy - door - 4, [255, 96, 52], 40, 0.3);
    /* the crest over the gate, and long banners from the towers */
    crest(P, sx - 3, gy - ah - 14, GOLD, ST3);
    for (var bn = 0; bn < 2; bn++) {
      var bx = sx - 20 + bn * 34 + 3, by = gy - 44, bl = rep >= 0.3 ? 22 : 10, sw = Math.round(Math.sin(t * 0.9 + bn) * 0.7);
      P.r(bx + sw, by, 6, bl, rep >= 0.3 ? "#7a1c1a" : "#4a1614"); P.r(bx + sw, by, 6, 1, GOLD);
      if (rep >= 0.3) { crest(P, bx + sw - 0.5, by + 4, GOLD, "#7a1c1a"); P.r(bx + sw, by + bl, 2, 2, "#7a1c1a"); P.r(bx + 4 + sw, by + bl, 2, 2, "#7a1c1a"); }
    }
    /* a wrecked dropship, nose down in the ash, still smoking */
    var hx = Math.min(W - 120, sx + 200), hy = gy;
    if (hx > sx + 130) {
      for (var hh2 = 0; hh2 < 16; hh2++) { var len = 54 - hh2 * 2.4; P.r(hx + hh2 * 1.4, hy - 16 + hh2, len, 1, hh2 < 2 ? "#6a6e76" : hh2 % 5 === 0 ? "#2a2c30" : "#45484f"); }
      P.r(hx + 40, hy - 26, 10, 12, "#45484f"); P.r(hx + 40, hy - 26, 10, 1, "#6a6e76"); P.r(hx + 42, hy - 23, 6, 2, SP.flick(t, 21) ? "#5ccfff" : "#1a3a4a");
      P.r(hx + 6, hy - 12, 8, 3, "#0d0b0c"); P.r(hx + 18, hy - 9, 4, 4, "#0d0b0c");
      P.r(hx + 50, hy - 4, 10, 4, "#4a4648");
      for (var sm = 0; sm < 5; sm++) { var p = (t * 0.25 + sm / 5) % 1; g.fillStyle = "rgba(60,58,62," + (0.5 * (1 - p)).toFixed(2) + ")"; g.fillRect(Math.round(hx + 10 + Math.sin(p * 5 + sm) * 3 + p * 10), Math.round(hy - 14 - p * 40), 3 + Math.round(p * 4), 3 + Math.round(p * 4)); }
      if (SP.flick(t, 33)) { P.r(hx + 11, hy - 12, 2, 1, C.orange); this._light(g, hx + 12, hy - 12, [255, 110, 50], 24, 0.35); }
    }
  };
  function lamp2(P, x, y, t, k) { P.r(x, y, 2, 2, SP.blink(t + k * 0.5, 1) ? "#e5483a" : "#5a1a18"); }

  Scene.prototype._motes = function (g, cam, pal, low) {
    if (low) return;
    var c = pal.glow;
    g.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",.35)";
    for (var i = 0; i < this.motes.length; i++) { var m = this.motes[i]; if (m.y + cam < GROUND) continue; g.fillRect(Math.round(m.x), Math.round(m.y), 1, 1); }
  };

  Scene.prototype._overlays = function (g, cam, col, civ, t, mxo) {
    /* depth fog, darker the deeper the camera */
    var depth = clamp((cam - 40) / 500, 0, 0.45);
    if (depth > 0.01) { g.fillStyle = "rgba(0,0,6," + depth.toFixed(3) + ")"; g.fillRect(0, 0, W, VH); }
    /* stalactites in front, moving faster than the world */
    if (cam + 40 > GROUND && this.quality !== "low") {
      var r = mulberry((this.G.seed >>> 3) + 3);
      g.fillStyle = "rgba(6,8,10,.9)";
      for (var i = 0; i < 9; i++) {
        var x = Math.round(r() * W - mxo * 40), hgt = 6 + r() * 14, w2 = 3 + r() * 5;
        var y = -((cam * 1.25) % 60) + Math.floor(i / 3) * 0;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x + w2, 0); g.lineTo(x + w2 / 2, hgt); g.closePath(); g.fill();
      }
      for (var k = 0; k < 3; k++) { var cx = Math.round(r() * W - mxo * 50); g.fillRect(cx, 0, 1, 14 + k * 8); g.fillStyle = "rgba(60,70,80,.7)"; g.fillRect(cx, 14 + k * 8, 2, 2); g.fillStyle = "rgba(6,8,10,.9)"; }
    }
    /* trouble tints the whole screen */
    var hap = col.hap;
    if (hap < 30) { g.fillStyle = "rgba(140,20,20," + (0.05 + 0.04 * Math.sin(t * 3)).toFixed(3) + ")"; g.fillRect(0, 0, W, VH); }
    if (civ && civ.war && civ.war.at && civ.war.at - this.nowServer() < 600000 && civ.war.at - this.nowServer() > 0) { g.fillStyle = "rgba(160,10,10," + (0.04 + 0.05 * (Math.sin(t * 4) + 1) / 2).toFixed(3) + ")"; g.fillRect(0, 0, W, VH); }
    if (civ && civ.fallen) { g.fillStyle = "rgba(30,0,0,.18)"; g.fillRect(0, 0, W, VH); }
    /* vignette */
    var vg = g.createRadialGradient(W / 2, VH / 2, VH * 0.35, W / 2, VH / 2, W * 0.62);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.5)");
    g.fillStyle = vg; g.fillRect(0, 0, W, VH);
  };

  /* ---- running ----------------------------------------------------------- */
  Scene.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    var self = this, last = 0;
    function frame(ts) {
      if (!self.running) return;
      if (last) {
        var dt = (ts - last) / 1000;
        if (ts - self.lastDraw >= (self.quality === "low" ? 66 : 32)) { self.lastDraw = ts; self.step(dt); try { self.render(); } catch (e) { self.lastError = e; } last = ts; }
      } else last = ts;
      self.raf = requestAnimationFrame(frame);
    }
    this.raf = requestAnimationFrame(frame);
  };
  Scene.prototype.stop = function () { this.running = false; if (this.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf); };
  Scene.prototype.destroy = function () { this.stop(); this.view = null; this.chunks = {}; };
  Scene.prototype.setQuality = function (q) { this.quality = q; };

  FieldKit.provide("colonyScene", {
    W: W, VH: VH, GROUND: GROUND, TOP0: TOP0, LH: LH, MAXL: MAXL,
    create: function (canvas, opts) { return new Scene(canvas, opts); },
    layoutFor: layoutFor, pathBetween: pathBetween, buildChunk: buildChunk, buildFar: buildFar, Crowd: Crowd, statusOf: statusOf,
    hash32: hash32, PAL: PAL
  });
})(window.FieldKit);
