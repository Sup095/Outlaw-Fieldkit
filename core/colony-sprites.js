/* ============================================================
   FieldKit :: colony-sprites — the little pictures in DEEPHOLD

   Every building, worker and surface structure is drawn here from
   rectangles: no image files, nothing to load, one palette. A drawer is
   given a pen P (P.r(x, y, w, h, colour) in the room's own pixels, origin
   top-left, floor at h - 3) and what the building is doing:

     a = { t: seconds, on: it is switched on, run: 0..1 how hard it is
           working (0 = starved of power, staff or input), build: 0..1
           while it is going up }

   Nothing in here knows about the game. colony-scene.js decides what
   goes where; this decides what it looks like.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var C = {
    k0: "#0b0f13", k1: "#151b21", k2: "#222c35", k3: "#33414d", k4: "#4b5d6c", k5: "#7188a0", k6: "#a3b8c8",
    warm: "#ffd27a", amber: "#e8a23c", orange: "#ff7a2a", red: "#e5483a", dred: "#8a2a24", green: "#5fdc90", dgreen: "#2c7a4b",
    cyan: "#5ccfff", blue: "#2f7fd0", teal: "#2fb5a0", violet: "#a58bff", dviolet: "#5a3fa0", pink: "#ff6fa8", bone: "#d8d0bc",
    bronze: "#a8793c", brass: "#d9a84e", rust: "#7a3b24", white: "#eaf2f6", soil: "#3b2f25", moss: "#6f9a3a"
  };

  function blink(t, hz) { return Math.floor(t * (hz || 2)) % 2 === 0; }
  function flick(t, seed) { var v = Math.sin(t * 17.3 + seed * 3.1) + Math.sin(t * 7.1 + seed); return v > -0.4; }

  /* ---- pen -------------------------------------------------------- */
  function pen(g, ox, oy) {
    var P = {
      g: g, ox: ox, oy: oy,
      r: function (x, y, w, h, c) {
        if (w <= 0 || h <= 0) return;
        g.fillStyle = c;
        g.fillRect(Math.round(P.ox + x), Math.round(P.oy + y), Math.round(w), Math.round(h));
      }
    };
    return P;
  }

  /* ---- parts shared by many buildings ------------------------------ */
  function lamp(P, x, y, c, on) { P.r(x, y, 2, 2, on ? c : C.k2); if (on) P.r(x, y, 1, 1, C.white); }
  function pipe(P, x, y, len, vert, c) { c = c || C.k4; if (vert) { P.r(x, y, 2, len, c); P.r(x, y, 1, len, C.k5); } else { P.r(x, y, len, 2, c); P.r(x, y, len, 1, C.k5); } }
  function box(P, x, y, w, h, c, edge) { P.r(x, y, w, h, c || C.k3); P.r(x, y, w, 1, edge || C.k5); P.r(x, y + h - 1, w, 1, C.k1); P.r(x, y, 1, h, edge || C.k4); }
  function crate(P, x, y, c) { P.r(x, y, 5, 4, c || C.bronze); P.r(x, y, 5, 1, C.brass); P.r(x + 2, y, 1, 4, C.rust); }
  function grill(P, x, y, w, h) { box(P, x, y, w, h, C.k2, C.k4); for (var i = 2; i < w - 1; i += 2) P.r(x + i, y + 1, 1, h - 2, C.k1); }
  function steam(P, x, y, t, n) { for (var i = 0; i < (n || 3); i++) { var p = ((t * 0.7 + i / (n || 3)) % 1); P.r(x + Math.sin(p * 6 + i) * 2, y - p * 10, 2, 2, p < 0.6 ? C.k6 : C.k4); } }
  function sparks(P, x, y, t, c) { for (var i = 0; i < 3; i++) { var p = ((t * 2.3 + i * 0.37) % 1); if (p < 0.7) P.r(x + (i - 1) * p * 6, y - p * 7 + p * p * 8, 1, 1, c || C.warm); } }
  function dim(a) { return a.on && a.run > 0.05; }
  function status(P, w, a, c) { lamp(P, w - 5, 2, a.on ? (a.run > 0.05 ? (c || C.green) : C.red) : C.amber, a.on ? (a.run > 0.05 || blink(a.t, 3)) : true); }

  /* ---- the buildings ----------------------------------------------- */
  var D = {};

  D.scrubber = function (P, w, h, a) {
    var F = h - 3;
    box(P, 5, F - 17, 12, 17, C.k3); grill(P, 7, F - 14, 8, 9);
    P.r(8, F - 20, 6, 3, C.k4);
    var s = dim(a) ? Math.floor(a.t * 12) % 2 : 0;
    P.r(8, F - 22, 6, 2, C.k2); P.r(9 + s, F - 22, 2, 2, C.k5); P.r(12 - s, F - 22, 2, 2, C.k5);
    pipe(P, 17, F - 10, 14, false); pipe(P, 29, F - 10, 2, true); pipe(P, 29, F - 20, 2, true);
    P.r(26, F - 21, 8, 3, C.k3); if (dim(a)) steam(P, 30, F - 22, a.t, 3);
    P.r(31, F - 9, 8, 7, C.k2); P.r(32, F - 8, 6, 5, dim(a) ? C.dgreen : C.k1);
    status(P, w, a);
  };
  D.cell = function (P, w, h, a) {
    var F = h - 3;
    for (var i = 0; i < 3; i++) {
      var y = F - 7 - i * 7;
      box(P, 6, y, 28, 6, C.k3);
      for (var j = 0; j < 5; j++) P.r(8 + j * 5, y + 1, 4, 4, dim(a) || a.on ? (((a.t * 0.8 + j * 0.3 + i) % 1) < 0.5 ? C.cyan : C.blue) : C.k2);
    }
    P.r(34, F - 20, 3, 18, C.k2); P.r(35, F - 19, 1, 16, C.amber);
    P.r(4, F - 22, 32, 2, C.k4); lamp(P, 6, F - 23, C.warm, blink(a.t, 1.5));
    P.r(2, F - 3, 36, 1, C.k4);
  };
  D.burner = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    box(P, 6, F - 16, 26, 16, C.k3); P.r(8, F - 12, 12, 9, C.k0);
    if (on) { var f = Math.floor(a.t * 9) % 3; P.r(9, F - 6 - f, 10, 3 + f, C.orange); P.r(11, F - 8 - f, 6, 4, C.warm); P.r(12, F - 5, 4, 2, C.white); }
    else P.r(9, F - 5, 10, 2, C.dred);
    P.r(24, F - 24, 5, 10, C.k4); P.r(24, F - 24, 5, 1, C.k6); if (on) steam(P, 26, F - 25, a.t, 3);
    P.r(22, F - 12, 8, 5, C.k2); lamp(P, 24, F - 11, C.red, on);
    P.r(30, F - 6, 6, 3, C.rust);
  };
  D.geo = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    P.r(8, F - 6, 24, 6, C.k3); P.r(10, F - 5, 20, 3, on ? C.orange : C.dred);
    P.r(17, F - 18, 6, 12, C.k4); P.r(17, F - 18, 6, 2, C.k6); P.r(18, F - 16, 4, 8, on ? C.red : C.k2);
    pipe(P, 20, F - 24, 14, true); pipe(P, 20, F - 24, 10, false);
    if (on) steam(P, 28, F - 26, a.t, 4);
    sparks(P, 20, F - 6, a.t, C.orange);
  };
  D.reactor = function (P, w, h, a) {
    var F = h - 3, on = dim(a), p = on ? (Math.sin(a.t * 3) + 1) / 2 : 0;
    box(P, 4, F - 5, 32, 5, C.k3); P.r(4, F - 5, 32, 1, C.amber);
    P.r(10, F - 20, 20, 15, C.k4); P.r(12, F - 22, 16, 3, C.k4); P.r(10, F - 20, 20, 1, C.k6);
    P.r(13, F - 18, 14, 11, on ? C.teal : C.k1);
    if (on) { P.r(16, F - 16, 8, 7, p > 0.5 ? C.green : C.cyan); P.r(18, F - 14, 4, 3, C.white); }
    for (var i = 0; i < 4; i++) P.r(4 + i * 8, F - 3, 4, 2, i % 2 ? C.warm : C.k1);
    lamp(P, 32, F - 18, C.red, blink(a.t, on ? 2 : 0.7));
  };
  D.fusion = function (P, w, h, a) {
    var F = h - 3, on = dim(a), t = a.t;
    box(P, 6, F - 4, 28, 4, C.k3);
    var cx = 20, cy = F - 14;
    for (var ang = 0; ang < 16; ang++) { var q = ang / 16 * 6.283; P.r(cx + Math.cos(q) * 10, cy + Math.sin(q) * 8, 2, 2, on ? (((ang + Math.floor(t * 8)) % 4) < 2 ? C.violet : C.cyan) : C.k3); }
    P.r(cx - 3, cy - 3, 6, 6, on ? C.white : C.k2); if (on) P.r(cx - 5, cy - 1, 10, 2, C.violet);
    P.r(8, F - 12, 3, 8, C.k2); P.r(29, F - 12, 3, 8, C.k2); lamp(P, 9, F - 14, C.red, blink(t, 2));
  };
  D.drill = function (P, w, h, a) {
    var F = h - 3, on = dim(a), d = on ? Math.floor(a.t * 6) % 3 : 0;
    box(P, 4, F - 6, 16, 6, C.amber, C.warm); P.r(6, F - 4, 12, 2, C.k2);
    P.r(14, F - 20, 4, 14, C.k3); P.r(12, F - 21, 8, 2, C.k4);
    P.r(20, F - 26, 4, 22, C.k4); P.r(14, F - 26, 10, 3, C.amber);
    P.r(26, F - 6 + d, 5, 3, C.k5); P.r(27, F - 4 + d, 3, 3, C.k6); P.r(28, F - 2 + d, 1, 2, C.white);
    P.r(22, F - 24, 4, 20, C.k3);
    if (on) { P.r(25, F - 8, 6, 2, C.k3); sparks(P, 28, F - 2, a.t, C.warm); }
    for (var i = 0; i < 3; i++) P.r(30 + i * 3, F - 1, 2, 1, C.k4);
    lamp(P, 6, F - 5, C.red, on);
  };
  D.pump = function (P, w, h, a) {
    var F = h - 3, on = dim(a), s = on ? Math.abs(Math.sin(a.t * 3)) : 0;
    P.r(5, F - 14, 14, 14, C.k3); P.r(5, F - 14, 14, 1, C.k6); P.r(6, F - 8, 12, 7, C.blue); P.r(6, F - 8, 12, 1, C.cyan);
    P.r(22, F - 18, 3, 18, C.k2); P.r(21, F - 20 + (1 - s) * 6, 5, 4, C.k5);
    pipe(P, 25, F - 10, 10, false); P.r(33, F - 10, 2, 8, C.k4);
    if (on) { P.r(34, F - 3, 2, 3, C.cyan); P.r(33, F - 1, 5, 1, C.blue); }
    status(P, w, a, C.cyan);
  };
  D.siphon = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    P.r(6, F - 10, 16, 10, C.k3); P.r(7, F - 9, 14, 8, on ? C.dgreen : C.k1); P.r(8, F - 5, 12, 3, on ? C.moss : C.k2);
    pipe(P, 22, F - 8, 12, false); pipe(P, 32, F - 20, 2, true); P.r(30, F - 22, 6, 3, C.k4);
    if (on) { var f = Math.floor(a.t * 8) % 3; P.r(31, F - 26 - f, 3, 4 + f, C.warm); P.r(32, F - 25, 1, 3, C.white); }
    status(P, w, a, C.warm);
  };
  D.bore = function (P, w, h, a) {
    var F = h - 3, on = dim(a), t = a.t;
    box(P, 5, F - 8, 18, 8, C.dviolet, C.violet); P.r(8, F - 6, 12, 3, C.k1);
    P.r(13, F - 22, 4, 14, C.k4); P.r(10, F - 24, 10, 3, C.violet);
    for (var i = 0; i < 5; i++) { var tw = ((t * 2 + i * 0.4) % 1) < 0.3 && on; P.r(26 + i * 2, F - 4 - (i % 3) * 3, 2, 3 + (i % 3) * 3, tw ? C.white : (i % 2 ? C.violet : C.pink)); }
    P.r(23, F - 5, 4, 2, C.k4); status(P, w, a, C.violet);
  };
  D.deepdrill = function (P, w, h, a) {
    var F = h - 3, on = dim(a), d = on ? Math.floor(a.t * 8) % 2 : 0;
    box(P, 3, F - 10, 34, 10, C.rust, C.orange); P.r(5, F - 8, 30, 3, C.k1);
    P.r(8, F - 22, 5, 12, C.k4); P.r(26, F - 22, 5, 12, C.k4); P.r(6, F - 24, 28, 3, C.k5);
    P.r(9, F - 2 + d, 3, 2, C.k6); P.r(27, F - 2 - d + 1, 3, 2, C.k6);
    if (on) { sparks(P, 10, F - 1, a.t, C.warm); sparks(P, 28, F - 1, a.t + 0.5, C.orange); }
    lamp(P, 18, F - 22, C.red, blink(a.t, 3)); status(P, w, a);
  };
  D.foundry = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    box(P, 4, F - 12, 22, 12, C.k3); P.r(6, F - 10, 18, 7, C.k0);
    P.r(8, F - 9, 14, 5, on ? C.orange : C.dred); if (on) { P.r(10, F - 8, 10, 2, C.warm); P.r(13, F - 7, 4, 1, C.white); }
    P.r(30, F - 24, 5, 14, C.k4); if (on) steam(P, 32, F - 25, a.t, 4);
    P.r(27, F - 6, 10, 6, C.k2); P.r(28, F - 5, 3, 3, on ? C.warm : C.rust); P.r(32, F - 5, 3, 3, C.k4);
    if (on) sparks(P, 14, F - 11, a.t, C.warm);
    status(P, w, a);
  };
  D.farm = function (P, w, h, a) {
    var F = h - 3, on = dim(a), t = a.t;
    for (var i = 0; i < 3; i++) {
      var y = F - 6 - i * 7;
      P.r(4, y, 32, 2, C.k4); P.r(4, y + 2, 32, 1, C.k1);
      for (var j = 0; j < 8; j++) { var hh = 2 + ((j * 7 + i * 3) % 3); P.r(5 + j * 4, y - hh, 3, hh, j % 3 === 0 ? C.pink : (j % 2 ? C.green : C.moss)); }
      P.r(4, y - 6, 32, 1, on ? C.violet : C.k2);
    }
    if (on) for (var k = 0; k < 4; k++) P.r(8 + k * 8, F - 24, 4, 1, blink(t + k, 1) ? C.violet : C.dviolet);
    status(P, w, a, C.pink);
  };
  D.mess = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    P.r(4, F - 10, 18, 10, C.k3); P.r(4, F - 10, 18, 1, C.k6); P.r(6, F - 8, 14, 5, C.k1);
    P.r(8, F - 15, 8, 5, C.k4); P.r(9, F - 16, 6, 2, C.k5); if (on) steam(P, 12, F - 17, a.t, 3);
    P.r(8, F - 7, 3, 3, C.amber); P.r(13, F - 7, 3, 3, C.orange);
    P.r(26, F - 8, 10, 2, C.brass); P.r(27, F - 6, 2, 6, C.k4); P.r(33, F - 6, 2, 6, C.k4);
    P.r(25, F - 4, 4, 2, C.k5); P.r(33, F - 4, 4, 2, C.k5);
    P.r(31, F - 22, 1, 6, C.k4); P.r(28, F - 17, 7, 3, C.k4); P.r(29, F - 14, 5, 2, on ? C.warm : C.k2);
    status(P, w, a);
  };
  D.hydro = function (P, w, h, a) {
    var F = h - 3, on = dim(a), t = a.t;
    for (var i = 0; i < 3; i++) {
      var x = 5 + i * 11;
      P.r(x, F - 18, 9, 18, C.k3); P.r(x + 1, F - 17, 7, 16, on ? C.teal : C.k1);
      P.r(x + 1, F - 9, 7, 8, on ? C.blue : C.k2);
      for (var j = 0; j < 3; j++) P.r(x + 2 + j * 2, F - 14 + ((j + i) % 2) * 2, 1, 5, on ? C.green : C.dgreen);
      if (on) P.r(x + 2 + (Math.floor(t * 2 + i) % 4) * 1, F - 4 - ((t * 3 + i) % 3), 1, 1, C.white);
    }
    P.r(3, F - 20, 34, 2, C.k4); status(P, w, a, C.cyan);
  };
  D.stimden = function (P, w, h, a) {
    var F = h - 3, on = dim(a) || a.on, t = a.t;
    P.r(4, F - 18, 32, 18, C.k1); P.r(4, F - 18, 32, 1, C.k4);
    P.r(8, F - 15, 24, 4, on ? ((Math.floor(t * 2) % 2) ? C.pink : C.violet) : C.k3);
    P.r(9, F - 14, 22, 2, on ? C.white : C.k2);
    P.r(6, F - 8, 12, 5, C.dviolet); P.r(6, F - 8, 12, 1, C.violet); P.r(6, F - 3, 12, 1, C.k0);
    P.r(22, F - 8, 12, 5, C.dred); P.r(22, F - 8, 12, 1, C.pink);
    if (on) { P.r(19, F - 9, 2, 6, C.k4); P.r(18, F - 11 - (t * 3) % 3, 1, 1, C.pink); }
  };
  D.workshop = function (P, w, h, a) {
    var F = h - 3, on = dim(a), t = a.t;
    box(P, 4, F - 9, 22, 9, C.k3); P.r(6, F - 12, 6, 3, C.k5); P.r(14, F - 11, 8, 2, C.amber);
    P.r(28, F - 20, 3, 17, C.k4); var ang = on ? Math.sin(t * 3) * 4 : 0;
    P.r(28, F - 20, 8 + ang, 2, C.k5); P.r(34 + ang, F - 19, 2, 6, C.k5); P.r(33 + ang, F - 14, 4, 2, C.warm);
    P.r(8, F - 18, 14, 4, C.k2); P.r(9, F - 17, 3, 2, C.cyan); P.r(14, F - 17, 3, 2, C.green); P.r(18, F - 17, 3, 2, C.amber);
    if (on) sparks(P, 34 + ang, F - 12, t, C.warm); crate(P, 30, F - 4, C.bronze);
    status(P, w, a);
  };
  D.vidhall = function (P, w, h, a) {
    var F = h - 3, on = dim(a) || a.on, t = a.t;
    P.r(4, F - 20, 32, 14, C.k0); P.r(5, F - 19, 30, 12, C.k2);
    if (on) for (var i = 0; i < 6; i++) P.r(6 + i * 5, F - 18, 4, 10, [C.red, C.amber, C.green, C.cyan, C.violet, C.pink][(i + Math.floor(t * 3)) % 6]);
    for (var r = 0; r < 2; r++) for (var j = 0; j < 5; j++) P.r(6 + j * 6, F - 5 + r * 3 - r * 2, 4, 3, r ? C.dred : C.k4);
    status(P, w, a, C.pink);
  };
  D.assembler = function (P, w, h, a) {
    var F = h - 3, on = dim(a), t = a.t;
    P.r(3, F - 5, 34, 5, C.k3); P.r(3, F - 5, 34, 1, C.k6);
    for (var i = 0; i < 6; i++) P.r(4 + i * 6, F - 4, 3, 2, ((i + (on ? Math.floor(t * 4) : 0)) % 2) ? C.k5 : C.k2);
    if (on) { var x = (t * 10) % 30; crate(P, 4 + x, F - 9, C.bronze); }
    P.r(10, F - 22, 4, 12, C.k4); P.r(10, F - 22, 16, 3, C.k5); var d = on ? Math.abs(Math.sin(t * 2)) * 6 : 0;
    P.r(24, F - 22, 3, 6 + d, C.k4); P.r(23, F - 16 + d, 5, 2, C.warm);
    if (on) sparks(P, 25, F - 14 + d, t, C.white); status(P, w, a);
  };
  D.bunk = function (P, w, h, a) {
    var F = h - 3, cols = [C.dred, C.dgreen, C.blue, C.dviolet, C.rust, C.teal];
    for (var s = 0; s < 2; s++) {
      var x = 4 + s * 18;
      P.r(x, F - 20, 2, 20, C.k4); P.r(x + 14, F - 20, 2, 20, C.k4);
      for (var l = 0; l < 3; l++) { var y = F - 6 - l * 6; P.r(x + 2, y, 12, 2, C.k3); P.r(x + 3, y - 2, 10, 2, cols[(s * 3 + l) % 6]); P.r(x + 3, y - 3, 3, 1, C.bone); }
    }
    lamp(P, 18, F - 22, C.warm, flick(a.t, 4) && a.on);
  };
  D.clinic = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    P.r(4, F - 18, 32, 18, C.k4); P.r(4, F - 18, 32, 1, C.k6); P.r(6, F - 16, 28, 14, C.k5);
    P.r(8, F - 14, 7, 7, C.white); P.r(10, F - 13, 3, 5, C.red); P.r(9, F - 11, 5, 1, C.red);
    P.r(19, F - 8, 14, 3, C.white); P.r(19, F - 5, 14, 2, C.k3); P.r(31, F - 12, 1, 4, C.k2);
    if (on) { P.r(22, F - 13, 2, 2, C.green); P.r(22 + (Math.floor(a.t * 3) % 8), F - 12, 1, 1, C.cyan); }
    status(P, w, a, C.cyan);
  };
  D.habtower = function (P, w, h, a) {
    var F = h - 3;
    P.r(8, F - 22, 24, 22, C.k3); P.r(8, F - 22, 24, 1, C.k6); P.r(6, F - 24, 28, 3, C.k4);
    for (var r = 0; r < 4; r++) for (var c = 0; c < 5; c++) { var lit = ((r * 7 + c * 13 + Math.floor(a.t * 0.2)) % 5) !== 0; P.r(10 + c * 4, F - 20 + r * 5, 3, 3, lit && a.on ? C.warm : C.k1); }
    lamp(P, 19, F - 27, C.red, blink(a.t, 1));
  };
  D.arcology = function (P, w, h, a) {
    var F = h - 3;
    P.r(4, F - 8, 32, 8, C.k3); P.r(8, F - 15, 24, 7, C.k4); P.r(13, F - 21, 14, 6, C.k3); P.r(17, F - 25, 6, 4, C.k4);
    for (var i = 0; i < 6; i++) P.r(6 + i * 5, F - 6, 3, 2, a.on ? C.warm : C.k1);
    for (var j = 0; j < 4; j++) P.r(10 + j * 6, F - 13, 3, 2, a.on ? C.cyan : C.k1);
    P.r(14, F - 19, 12, 1, C.moss); P.r(5, F - 9, 8, 1, C.moss); P.r(27, F - 9, 8, 1, C.moss);
    lamp(P, 19, F - 27, C.pink, blink(a.t, 1.4));
  };
  D.barracks = function (P, w, h, a) {
    var F = h - 3;
    for (var i = 0; i < 4; i++) { P.r(5 + i * 8, F - 5, 7, 2, C.k4); P.r(5 + i * 8, F - 7, 7, 2, i % 2 ? C.dred : C.k3); P.r(5 + i * 8, F - 7, 2, 2, C.bone); P.r(5 + i * 8, F - 3, 1, 3, C.k2); P.r(11 + i * 8, F - 3, 1, 3, C.k2); }
    P.r(16, F - 24, 8, 14, C.dred); P.r(16, F - 24, 8, 1, C.brass); P.r(19, F - 21, 2, 8, C.brass); P.r(18, F - 19, 4, 2, C.brass);
    P.r(15, F - 25, 10, 1, C.bronze);
  };
  D.armoury = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    P.r(4, F - 20, 32, 20, C.k2); P.r(4, F - 20, 32, 1, C.k4);
    for (var i = 0; i < 6; i++) { P.r(6 + i * 5, F - 18, 2, 10, C.k5); P.r(6 + i * 5, F - 18, 4, 2, C.k4); }
    P.r(6, F - 6, 28, 5, C.k3); for (var j = 0; j < 5; j++) crate(P, 7 + j * 5.5, F - 5, j % 2 ? C.bronze : C.rust);
    P.r(14, F - 24, 12, 3, C.red); P.r(16, F - 23, 8, 1, C.white);
    if (on) lamp(P, 31, F - 23, C.amber, blink(a.t, 2)); status(P, w, a);
  };
  D.arsenal = function (P, w, h, a) {
    var F = h - 3, on = dim(a);
    box(P, 3, F - 14, 20, 14, C.rust, C.bronze); P.r(5, F - 11, 16, 8, C.k0); P.r(7, F - 9, 12, 5, on ? C.orange : C.dred);
    if (on) sparks(P, 13, F - 10, a.t, C.warm);
    P.r(26, F - 22, 10, 9, C.dred); P.r(26, F - 22, 10, 1, C.brass); P.r(29, F - 20, 4, 5, C.brass); P.r(30, F - 19, 2, 3, C.dred);
    for (var i = 0; i < 3; i++) crate(P, 26 + i * 4, F - 5 - (i % 2) * 4, C.bronze);
    P.r(8, F - 20, 4, 6, C.k4); if (on) steam(P, 10, F - 21, a.t, 3);
    status(P, w, a);
  };
  D.turret = function (P, w, h, a) {
    var F = h - 3, t = a.t, fire = a.on && ((t * 0.5) % 4) < 0.15;
    P.r(8, F - 8, 24, 8, C.k3); P.r(8, F - 8, 24, 1, C.k5); P.r(14, F - 13, 12, 6, C.k4);
    var ang = a.on ? Math.sin(t * 0.8) * 5 : 0;
    P.r(20, F - 17, 3, 6, C.k5); P.r(21 + ang, F - 22, 2, 7, C.k6); if (fire) { P.r(20 + ang, F - 27, 4, 4, C.warm); P.r(21 + ang, F - 26, 2, 2, C.white); }
    P.r(10, F - 5, 4, 2, a.on ? C.green : C.k2);
  };
  D.shield = function (P, w, h, a) {
    var F = h - 3, on = dim(a), t = a.t;
    P.r(14, F - 8, 12, 8, C.k3); P.r(14, F - 8, 12, 1, C.k5);
    P.r(18, F - 20, 4, 12, C.k4); P.r(15, F - 22, 10, 3, C.k5); P.r(19, F - 24, 2, 3, C.cyan);
    if (on) for (var i = 0; i < 5; i++) { var y = F - 4 - i * 4 - ((t * 6) % 3); P.r(4 + (i * 7) % 6, y, 4 + (i % 3) * 2, 1, i % 2 ? C.cyan : C.white); P.r(26 + (i * 5) % 7, y - 1, 5, 1, C.blue); }
  };
  D.railgun = function (P, w, h, a) {
    var F = h - 3, t = a.t, charge = a.on ? (t * 0.4) % 1 : 0;
    P.r(4, F - 6, 32, 6, C.k3); P.r(4, F - 6, 32, 1, C.k5);
    P.r(6, F - 14, 28, 3, C.k4); P.r(6, F - 11, 28, 1, C.cyan); P.r(6, F - 15, 28, 1, C.k6);
    P.r(8, F - 12, 6, 6, C.k2); P.r(9, F - 11, 4, 4, charge > 0.8 ? C.white : C.blue);
    P.r(14, F - 18, 3, 4, C.k5); lamp(P, 30, F - 5, charge > 0.9 ? C.warm : C.green, true);
  };
  D.bastion = function (P, w, h, a) {
    var F = h - 3, t = a.t, fire = a.on && ((t * 0.35) % 3) < 0.2;
    P.r(3, F - 8, 34, 8, C.k3); P.r(3, F - 8, 34, 1, C.k6); P.r(8, F - 15, 24, 8, C.k4);
    var ang = a.on ? Math.sin(t * 0.5) * 3 : 0;
    P.r(12 + ang, F - 22, 5, 9, C.k5); P.r(23 + ang, F - 22, 5, 9, C.k5); P.r(11 + ang, F - 25, 7, 3, C.k6); P.r(22 + ang, F - 25, 7, 3, C.k6);
    if (fire) { P.r(12 + ang, F - 30, 5, 5, C.warm); P.r(24 + ang, F - 30, 5, 5, C.warm); }
    lamp(P, 18, F - 14, C.red, blink(t, 2));
  };
  D.gunline = function (P, w, h, a) {
    var F = h - 3, t = a.t, fire = a.on && ((t * 0.45) % 3) < 0.15;
    for (var i = 0; i < 2; i++) { var x = 5 + i * 18;
      P.r(x, F - 6, 14, 6, C.bronze); P.r(x, F - 6, 14, 1, C.brass); P.r(x + 3, F - 11, 8, 5, C.rust);
      P.r(x + 9, F - 15, 3, 9, C.k4); P.r(x + 8, F - 17, 5, 3, C.bronze); if (fire && i === 0) P.r(x + 8, F - 21, 5, 4, C.warm);
      P.r(x + 1, F - 3, 3, 3, C.k1); P.r(x + 10, F - 3, 3, 3, C.k1); }
  };
  D.lift = function (P, w, h, a) {
    var F = h - 3, on = dim(a), p = on ? (Math.sin(a.t * 1.3) + 1) / 2 : 0;
    P.r(6, F - 22, 3, 22, C.k4); P.r(31, F - 22, 3, 22, C.k4); P.r(5, F - 24, 30, 3, C.k5);
    P.r(19, F - 22, 1, 12 + p * 8, C.k6);
    P.r(10, F - 8 - p * 4, 20, 3, C.amber); P.r(10, F - 8 - p * 4, 20, 1, C.warm); P.r(12, F - 12 - p * 4, 6, 4, C.bronze); P.r(22, F - 11 - p * 4, 6, 3, C.rust);
    P.r(8, F - 4, 24, 4, C.k2); lamp(P, 31, F - 26, C.amber, blink(a.t, 2.5) && on); status(P, w, a);
  };

  /* A building going up: scaffolding and a welding spark. */
  function scaffold(P, w, h, a, kind) {
    var F = h - 3, f = Math.max(0.1, Math.min(1, a.build));
    var hh = Math.round((h - 6) * f);
    P.r(4, F - hh, 2, hh, C.k4); P.r(w - 6, F - hh, 2, hh, C.k4);
    for (var y = 0; y < hh; y += 6) P.r(4, F - y, w - 8, 1, C.k3);
    P.r(8, F - Math.round(hh * 0.8), w - 16, Math.round(hh * 0.8), C.k2);
    sparks(P, 12 + (a.t * 8) % (w - 24), F - hh, a.t, C.white);
    P.r(w / 2 - 6, F - hh - 4, 12, 2, C.amber);
  }

  function building(type, P, w, h, a) {
    if (a.build != null && a.build < 1) { scaffold(P, w, h, a, type); return; }
    (D[type] || D.bunk)(P, w, h, a);
    if (!a.on) { P.r(0, 0, w, h, "rgba(8,10,14,.45)"); P.r(w / 2 - 3, 3, 2, 6, C.amber); P.r(w / 2 + 1, 3, 2, 6, C.amber); }
  }

  /* ---- people ------------------------------------------------------ */
  var SUITS = ["#e8a23c", "#5ccfff", "#ff7a2a", "#a58bff", "#5fdc90", "#d8d0bc", "#ff6fa8"];
  function person(P, x, y, o) {
    /* x centre, y feet. o: { dir: 1|-1, frame, suit, carry, slump, work } */
    var f = o.frame % 4, suit = SUITS[o.suit % SUITS.length], d = o.dir;
    var bob = (f === 1 || f === 3) ? 1 : 0;
    P.r(x - 1, y - 8 + bob, 3, 2, "#d9b38c");                       /* face */
    P.r(x - 1, y - 9 + bob, 3, 1, suit);                            /* helmet */
    P.r(x - 2, y - 6 + bob, 4, 4, suit);                            /* torso */
    P.r(x - 2, y - 3 + bob, 4, 1, C.k2);                            /* belt */
    if (o.work) { P.r(x + d * 2, y - 6 + bob, 2, 1, C.k5); P.r(x + d * 3, y - 7 + bob - (f % 2), 1, 2, C.warm); }
    var l = f === 0 ? 0 : f === 2 ? 0 : (f === 1 ? 1 : -1);
    P.r(x - 2 + (o.stand ? 0 : l), y - 2, 1, 2, C.k1); P.r(x + 1 - (o.stand ? 0 : l), y - 2, 1, 2, C.k1);
    if (o.carry) { P.r(x - 2, y - 10 + bob, 5, 3, C.bronze); P.r(x - 2, y - 10 + bob, 5, 1, C.brass); }
  }

  /* ---- the surface ------------------------------------------------- */
  function surface(g, t, stage, o) {
    /* o: { x0, groundY, shaftX, stage, fallen, breach, siren, turrets } */
    var P = pen(g, 0, 0), gy = o.groundY, sx = o.shaftX;
    /* the head of the shaft: a hut, a winch frame, an antenna */
    P.r(sx - 18, gy - 14, 36, 14, C.k3); P.r(sx - 18, gy - 14, 36, 2, C.k5); P.r(sx - 14, gy - 10, 8, 6, C.k0); P.r(sx - 13, gy - 9, 6, 4, flick(t, 2) ? C.warm : C.amber);
    P.r(sx + 4, gy - 22, 3, 22, C.k4); P.r(sx - 6, gy - 24, 22, 3, C.k5); P.r(sx, gy - 20, 1, 8, C.k6);
    P.r(sx + 14, gy - 30, 2, 16, C.k4); lamp(P, sx + 13, gy - 33, C.red, blink(t, 1.2));
    /* a launch rail up toward the Civ */
    P.r(sx - 3, gy - 42, 1, 24, C.k2);
    if (stage >= 1) { P.r(sx + 28, gy - 10, 22, 10, C.k3); P.r(sx + 28, gy - 10, 22, 2, C.k5); P.r(sx + 33, gy - 7, 4, 4, C.k0); P.r(sx + 40, gy - 7, 4, 4, C.k0); }
    if (stage >= 2) { P.r(sx + 56, gy - 16, 14, 16, C.k3); P.r(sx + 56, gy - 16, 14, 2, C.k5); P.r(sx + 60, gy - 12, 6, 5, flick(t, 5) ? C.cyan : C.k1); P.r(sx + 62, gy - 22, 2, 6, C.k4); }
    if (stage >= 3) { for (var i = 0; i < 2; i++) { var x = sx - 60 + i * 24; P.r(x, gy - 9, 14, 9, C.k3); P.r(x + 5, gy - 14, 4, 6, C.k4); P.r(x + 6, gy - 20, 2, 7, C.k6); } }
    if (stage >= 4) { P.r(sx + 78, gy - 24, 10, 24, C.k3); P.r(sx + 78, gy - 24, 10, 2, C.k6); for (var r = 0; r < 4; r++) P.r(sx + 80, gy - 20 + r * 5, 6, 2, flick(t, r + 7) ? C.warm : C.k1); }
    if (stage >= 5) { P.r(sx - 90, gy - 20, 18, 20, C.k3); P.r(sx - 90, gy - 20, 18, 2, C.k6); P.r(sx - 84, gy - 26, 6, 6, C.k4); P.r(sx - 82, gy - 30, 2, 4, C.cyan); }
    if (stage >= 6) { P.r(sx + 94, gy - 34, 8, 34, C.k4); P.r(sx + 94, gy - 34, 8, 2, C.violet); P.r(sx + 96, gy - 40, 4, 6, C.violet); lamp(P, sx + 97, gy - 43, C.white, blink(t, 2)); }
  }

  FieldKit.provide("colonySprites", { C: C, D: D, pen: pen, building: building, person: person, surface: surface, SUITS: SUITS, blink: blink, flick: flick, TYPES: Object.keys(D) });
})(window.FieldKit);
