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
    ruin:    { rock: [[38, 31, 26], [82, 68, 56]], glow: [255, 190, 100], ore: [200, 160, 90], gem: [255, 210, 130], lamp: C.brass }
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
    var G = { w: W, seed: seed, open: open, total: total, layers: layers, h: Math.max(VH, TOP0 + total * LH + 26), dig: o.dig || null,
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

    /* colour */
    var px = new Uint8ClampedArray(W * h * 4);
    var rk0 = pal.rock[0], rk1 = pal.rock[1];
    var depth = clamp((y0 - TOP0) / (MAXL * LH), 0, 1);
    function isCave(xx, yy) { if (xx < 0 || xx >= W || yy < 0 || yy >= h) return false; var v = mask[yy * W + xx]; return v === 1 || v === 2 || v === 3; }
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
        if (m === 0) {
          var n1 = vnoise(i2, wy, 9, seed), n2 = vnoise(i2, wy, 4, seed + 5), n3 = vnoise(i2, wy, 22, seed + 9);
          var t = clamp(n1 * 0.55 + n2 * 0.25 + n3 * 0.35 - 0.1, 0, 1);
          var band = Math.sin(wy * 0.11 + n3 * 5) > 0.88 ? 0.12 : 0;
          var dk = 1 - 0.38 * depth - (l < 0 ? 0 : 0.0);
          rr = (lerp(rk0[0], rk1[0], t) + band * 60) * dk; gg = (lerp(rk0[1], rk1[1], t) + band * 55) * dk; bb = (lerp(rk0[2], rk1[2], t) + band * 50) * dk;
          var hh = ih(i2, wy, seed + 21);
          if (hh < 0.0045) { rr = pal.ore[0]; gg = pal.ore[1]; bb = pal.ore[2]; }
          else if (hh > 0.9975 - depth * 0.004) { rr = pal.gem[0]; gg = pal.gem[1]; bb = pal.gem[2]; }
          /* rim light where rock meets a hollow */
          var up = isCave(i2, j - 1), lf = isCave(i2 - 1, j), dn = isCave(i2, j + 1), rt = isCave(i2 + 1, j);
          if (up || lf) { rr += 36; gg += 34; bb += 32; }
          if (dn || rt) { rr *= 0.72; gg *= 0.72; bb *= 0.72; }
          if (l < 0 && wy < GROUND + 3) { rr = lerp(rr, 120, 0.25); gg = lerp(gg, 100, 0.25); bb = lerp(bb, 86, 0.25); }
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
            if (biome === "ruin") { rr += 14; gg += 6; bb -= 6; if (rx % 9 === 0 || ry % 9 === 0) { rr += 10; gg += 8; bb += 4; } }
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
      var key = h ? h.layer + ":" + h.slot : "";
      if (key !== (self.hover ? self.hover.layer + ":" + self.hover.slot : "")) { self.hover = h; if (self.onHover) self.onHover(h); if (cv.style) cv.style.cursor = h ? "pointer" : (down ? "grabbing" : "grab"); }
    });
    cv.addEventListener("mousedown", function (e) { down = { x: e.clientX, y: e.clientY, cam: self.camTarget }; moved = 0; });
    var up = function (e) {
      if (down && moved < 5 && e && e.type === "mouseup") {
        var h = self.hit(pos(e).x, pos(e).y);
        self.select(h ? h.layer : null, h ? h.slot : null, true);
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
    return null;
  };

  Scene.prototype.select = function (layer, slot, fromClick) {
    this.sel = layer == null ? null : { layer: layer, slot: slot };
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
    var key = state + ":" + prog + ":" + col.biome + ":" + G.seed;
    var c = this.chunks[l];
    if (c && c.key === key) return c;
    var data = buildChunk(G, l, col.biome, state, prog, 0);
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
    var first = -1, last = G.total - 1;
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
    for (var layer = 0; layer < 2; layer++) {
      var sh = layer ? 0.6 : 0.35, col = layer ? "#171d24" : "#1f2831", base = gy - 4 - layer * 6;
      g.fillStyle = col;
      var seed = (this.G.seed & 255) + layer * 31;
      for (var x = -10; x < W + 10; x += 9) {
        var hgt = 8 + ih(Math.floor((x + mxo * 40 * sh) / 9), layer, seed) * (layer ? 34 : 52);
        var ox = Math.round(x - mxo * 30 * sh);
        g.fillRect(ox, base - hgt, 8, hgt + 6);
        if (ih(Math.floor(x / 9), layer + 5, seed) > 0.7) g.fillRect(ox + 3, base - hgt - 6, 2, 7);
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

  Scene.prototype._rig = function (g, L, t) {
    var frac = this.G.dig ? this.G.dig.frac : 0;
    var x = L.sx + (L.xR - L.sx) * clamp(frac, 0, 1), y = L.yAt(x);
    var P = SP.pen(g, x - 8, y - 6);
    P.r(0, 0, 14, 11, C.amber); P.r(0, 0, 14, 2, C.warm); P.r(2, 3, 10, 5, C.k1);
    P.r(14, 2 + Math.floor(t * 8) % 3, 6, 4, C.k5); P.r(19, 3, 3, 2, C.white);
    for (var i = 0; i < 4; i++) { var p = (t * 3 + i * 0.27) % 1; P.r(20 + p * 8, 4 - p * 6 + p * p * 10, 1, 1, i % 2 ? C.warm : C.k6); }
    this._light(g, x + 8, y, [255, 190, 90], 46, 0.5);
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
    SP.surface(g, t, civ ? civ.stage : 0, { groundY: GROUND - 1, shaftX: G.shaftPts[0][0], stage: civ ? civ.stage : 0 });
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
    var P = SP.pen(g, 0, 0), SPR = SP;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.y < cam - 12 || w.y > cam + VH + 12) continue;
      var working = w.state === "work" && w.rm && (w.job && w.job.rm === w.rm) && !w.carry;
      var o = { dir: w.dir, frame: w.state === "walk" || w.state === "enter" ? w.frame : (working ? w.frame : 0), suit: w.suit, carry: w.carry && w.state === "walk",
        work: working, stand: !(w.state === "walk" || w.state === "enter") };
      var y = Math.round(w.y) + (w.state === "work" && !working && w.why === "sleep" ? 0 : 0);
      if (w.state === "work" && w.why === "sleep") { P.r(Math.round(w.x) - 3, y - 3, 6, 2, "#d8d0bc"); P.r(Math.round(w.x) - 3, y - 4, 2, 2, "#d9b38c"); continue; }
      SPR.person(P, Math.round(w.x), y, o);
    }
  };

  Scene.prototype._ruin = function (g, cam, col, t) {
    var G = this.G, left = 1 - clamp((col.repair || 0) / 100, 0, 1);
    for (var l = 0; l < G.open; l++) {
      var L = G.layers[l]; if (L.top + LH < cam || L.top > cam + VH) continue;
      var r = mulberry(G.seed + l * 7);
      /* banners that hang in the tunnel, torn until repaired */
      for (var b = 0; b < 3; b++) {
        var bx = Math.round(L.xL + 30 + r() * (L.xR - L.xL - 60)), by = L.yAt(bx) - 4;
        var sway = Math.sin(t * 1.2 + b) * 1;
        var torn = r() < left;
        g.fillStyle = "#6a1f1c"; g.fillRect(bx + sway, by, 5, torn ? 6 : 10);
        g.fillStyle = "#d9a84e"; g.fillRect(bx + 2 + sway, by + 2, 1, torn ? 2 : 5); g.fillRect(bx + 1 + sway, by + 3, 3, 1);
      }
      /* rubble drifts: fewer as the garrison is rebuilt */
      var n = Math.round(left * 7);
      for (var k = 0; k < n; k++) {
        var rx = Math.round(L.xL + 8 + r() * (L.xR - L.xL - 16)), ry = L.yAt(rx) + 4;
        g.fillStyle = "#4a4038"; g.fillRect(rx, ry - 2, 6, 2); g.fillStyle = "#6a5c4e"; g.fillRect(rx + 1, ry - 3, 3, 1); g.fillStyle = "#2a241f"; g.fillRect(rx + 4, ry - 1, 4, 1);
      }
    }
  };

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
