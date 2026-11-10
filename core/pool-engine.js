/* ============================================================
   FieldKit :: pool-engine — the table, the balls and the rules

   One file for both ends. The panel (modules/pool.js) runs it to show a
   shot as it happens and to let the computer play; the relay
   (relay/pool.js) runs the very same code to decide what a shot really
   did in an online match, so nobody can claim a shot that did not
   happen.

   SAME ANSWER EVERYWHERE. The simulation uses only + - * / and
   Math.sqrt, which every JavaScript engine computes to the same bit.
   No sin, cos, random or clock inside a shot: a shot is a direction
   as a vector, a power and where the tip hits the cue ball. Played
   from the same table it ends the same on the relay and on everyone's
   screen.

   SEMI-REAL. Metres and seconds on a nine-foot table. A struck ball
   slides, the cloth turns the slide into a roll, and spin is real
   spin: hit low and the cue ball keeps its backspin through the
   collision and comes back (draw); hit high and it follows; side spin
   bends rebounds off the cushions and throws object balls a little.
   Pockets have jaws, so a ball that hits the point can rattle out.

   THE RULES are eight-ball as most bars play it: break, open table,
   solids or stripes, ball in hand after any foul, and the 8 in a
   called pocket. Pot the 8 early or scratch on it and you lose.
   ============================================================ */
(function (root) {
  "use strict";

  /* ---- the table ------------------------------------------------------ */
  var L = 2.54, WD = 1.27, R = 0.028575;          /* playing surface, ball radius (m) */
  var HEAD = L / 4, FOOT = { x: L * 3 / 4, y: WD / 2 };
  var CJ = 0.086, SM = 0.064;                       /* corner jaw distance, side half-mouth */
  var G = 9.81, MU_S = 0.2, MU_R = 0.011, MU_SP = 0.012, E_BALL = 0.95, E_RAIL = 0.78, MU_RAIL = 0.14, MU_BALL = 0.05;
  var DT = 1 / 600, MAX_T = 40, VMAX = 10.5;

  /* pockets: index 0..5 = top-left, top-middle, top-right, bottom-left, bottom-middle, bottom-right */
  var POCKETS = [
    { x: -0.017, y: -0.017, r: 0.062, name: "TOP LEFT", mx: 0.03, my: 0.03 },
    { x: L / 2, y: -0.038, r: 0.058, name: "TOP SIDE", mx: L / 2, my: 0.006 },
    { x: L + 0.017, y: -0.017, r: 0.062, name: "TOP RIGHT", mx: L - 0.03, my: 0.03 },
    { x: -0.017, y: WD + 0.017, r: 0.062, name: "BOTTOM LEFT", mx: 0.03, my: WD - 0.03 },
    { x: L / 2, y: WD + 0.038, r: 0.058, name: "BOTTOM SIDE", mx: L / 2, my: WD - 0.006 },
    { x: L + 0.017, y: WD + 0.017, r: 0.062, name: "BOTTOM RIGHT", mx: L - 0.03, my: WD - 0.03 }
  ];

  /* the cushions, as segments a ball's centre must stay R away from */
  var SEGS = (function () {
    var s = [];
    function seg(ax, ay, bx, by) { s.push([ax, ay, bx, by]); }
    [[0, 1], [WD, -1]].forEach(function (p) {
      var y = p[0], o = p[1];
      seg(CJ, y, L / 2 - SM, y); seg(L / 2 + SM, y, L - CJ, y);
      seg(CJ, y, CJ - 0.03, y - o * 0.04); seg(L - CJ, y, L - CJ + 0.03, y - o * 0.04);
      seg(L / 2 - SM, y, L / 2 - SM + 0.01, y - o * 0.045); seg(L / 2 + SM, y, L / 2 + SM - 0.01, y - o * 0.045);
    });
    [[0, 1], [L, -1]].forEach(function (p) {
      var x = p[0], o = p[1];
      seg(x, CJ, x, WD - CJ);
      seg(x, CJ, x - o * 0.04, CJ - 0.03); seg(x, WD - CJ, x - o * 0.04, WD - CJ + 0.03);
    });
    return s;
  })();

  function kind(n) { return n === 0 ? "cue" : n === 8 ? "eight" : n < 8 ? "solid" : "stripe"; }
  function mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function num(v, lo, hi, d) { v = Number(v); if (!isFinite(v)) return d; return v < lo ? lo : v > hi ? hi : v; }

  /* ---- a new game ----------------------------------------------------- */
  function rack(seed) {
    var r = mulberry(seed >>> 0), balls = [{ n: 0, x: HEAD - 0.12, y: WD / 2, on: true }];
    var solids = [2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
    function take(list) { return list.splice(Math.floor(r() * list.length), 1)[0]; }
    var cornerA = r() < 0.5 ? take(solids) : take(stripes);
    var cornerB = kind(cornerA) === "solid" ? take(stripes) : take(solids);
    var rest = solids.concat(stripes);
    for (var i = rest.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
    var dx = 2 * R * 0.8660254 + 0.0008, dy = 2 * R + 0.0008;
    for (var k = 0; k < 5; k++) for (var j2 = 0; j2 <= k; j2++) {
      var n;
      if (k === 0) n = 1;
      else if (k === 2 && j2 === 1) n = 8;
      else if (k === 4 && j2 === 0) n = cornerA;
      else if (k === 4 && j2 === 4) n = cornerB;
      else n = rest.pop();
      balls.push({ n: n, x: FOOT.x + k * dx, y: FOOT.y + (j2 - k / 2) * dy, on: true });
    }
    return balls;
  }

  /* mode: "8ball" (rules) or "practice" (no rules, it is always your turn) */
  function newGame(seed, mode, names) {
    return {
      v: 1, mode: mode === "practice" ? "practice" : "8ball", seed: seed >>> 0,
      balls: rack(seed), turn: 0, groups: [null, null], phase: "break", inHand: true, behind: true,
      over: false, winner: null, shots: 0, names: names || ["PLAYER 1", "PLAYER 2"],
      msg: (names ? names[0] : "PLAYER 1") + " breaks. Place the cue ball behind the line, then shoot.", foul: null, pots: [0, 0]
    };
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function ball(state, n) { for (var i = 0; i < state.balls.length; i++) if (state.balls[i].n === n) return state.balls[i]; return null; }

  /* whose balls a player shoots at, and whether they are on the 8 */
  function groupLeft(state, p) {
    var g = state.groups[p]; if (!g) return null;
    return state.balls.filter(function (b) { return b.on && kind(b.n) === g; }).length;
  }
  function targets(state, p) {
    if (p == null) p = state.turn;
    if (state.mode === "practice") return state.balls.filter(function (b) { return b.on && b.n; }).map(function (b) { return b.n; });
    var g = state.groups[p];
    if (state.phase === "break") return state.balls.filter(function (b) { return b.on && b.n; }).map(function (b) { return b.n; });
    if (!g) return state.balls.filter(function (b) { return b.on && b.n && b.n !== 8; }).map(function (b) { return b.n; });
    var mine = state.balls.filter(function (b) { return b.on && kind(b.n) === g; }).map(function (b) { return b.n; });
    return mine.length ? mine : [8];
  }

  /* can the cue ball go here? */
  function placeOk(state, x, y) {
    if (!(x >= R && x <= L - R && y >= R && y <= WD - R)) return false;
    if (state.behind && x > HEAD) return false;
    for (var i = 0; i < state.balls.length; i++) {
      var b = state.balls[i]; if (!b.on || b.n === 0) continue;
      var dx = b.x - x, dy = b.y - y; if (dx * dx + dy * dy < 4 * R * R * 1.0001) return false;
    }
    return true;
  }

  /* ---- a shot in motion ------------------------------------------------ */
  /* shot: { dx, dy, power 0..1, sx, sy (tip offset, -1..1, + = right / top), cue: {x,y} when in hand, call: pocket 0..5 } */
  function clean(shot) {
    shot = shot || {};
    var dx = num(shot.dx, -1, 1, 1), dy = num(shot.dy, -1, 1, 0), m = Math.sqrt(dx * dx + dy * dy);
    if (m < 1e-6) { dx = 1; dy = 0; m = 1; }
    /* a direction that is already one long is left exactly as it is, so a
       shot cleaned twice (the relay, then a replay) is the same shot */
    if (Math.abs(m - 1) < 1e-9) m = 1;
    var sx = num(shot.sx, -1, 1, 0), sy = num(shot.sy, -1, 1, 0), sm = Math.sqrt(sx * sx + sy * sy);
    if (sm > 1 + 1e-9) { sx /= sm; sy /= sm; }
    var out = { dx: m === 1 ? dx : dx / m, dy: m === 1 ? dy : dy / m, power: num(shot.power, 0.02, 1, 0.5), sx: sx, sy: sy };
    if (shot.cue && typeof shot.cue === "object") out.cue = { x: num(shot.cue.x, 0, L, HEAD / 2), y: num(shot.cue.y, 0, WD, WD / 2) };
    if (shot.call != null && isFinite(Number(shot.call))) out.call = Math.max(0, Math.min(5, Math.floor(Number(shot.call))));
    return out;
  }

  function Sim(balls, shot) {
    this.b = balls.map(function (x) { return { n: x.n, x: x.x, y: x.y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: x.on, pk: -1 }; });
    this.t = 0; this.done = false;
    this.ev = { first: null, railAfter: false, railBalls: {}, pots: [], cueOff: false, contacts: 0, hits: [] };
    var c = this.b[0];
    var v0 = Math.max(0.12, shot.power * VMAX);
    c.vx = v0 * shot.dx; c.vy = v0 * shot.dy;
    /* where the tip meets the ball, at most half a radius from centre */
    var b = shot.sy * 0.6 * R, a = shot.sx * 0.6 * R;
    var k = 5 * v0 * b / (2 * R * R);
    c.wx = -shot.dy * k; c.wy = shot.dx * k;
    c.wz = -5 * v0 * a / (2 * R * R);
  }
  Sim.prototype.moving = function () {
    for (var i = 0; i < this.b.length; i++) { var o = this.b[i]; if (o.on && (o.vx !== 0 || o.vy !== 0 || o.wx !== 0 || o.wy !== 0)) return true; }
    return false;
  };
  Sim.prototype.step = function () {
    if (this.done) return;
    var bs = this.b, n = bs.length, i, j, o;
    /* the cloth */
    for (i = 0; i < n; i++) {
      o = bs[i]; if (!o.on) continue;
      var sx = o.vx - R * o.wy, sy = o.vy + R * o.wx, slip = Math.sqrt(sx * sx + sy * sy);
      if (slip > 1e-5) {
        var a = MU_S * G * DT;
        if (slip <= 3.5 * a) {
          o.vx -= sx * 2 / 7; o.vy -= sy * 2 / 7;
          o.wy = o.vx / R; o.wx = -o.vy / R;
        } else {
          var ux = sx / slip, uy = sy / slip;
          o.vx -= a * ux; o.vy -= a * uy;
          o.wx += 2.5 / R * a * -uy; o.wy += 2.5 / R * a * ux;
        }
      } else {
        var sp = Math.sqrt(o.vx * o.vx + o.vy * o.vy), d = MU_R * G * DT;
        if (sp <= d) { o.vx = 0; o.vy = 0; o.wx = 0; o.wy = 0; }
        else { var f = (sp - d) / sp; o.vx *= f; o.vy *= f; o.wy = o.vx / R; o.wx = -o.vy / R; }
      }
      if (o.wz !== 0) { var dz = 2.5 * MU_SP * G / R * DT; o.wz = o.wz > 0 ? Math.max(0, o.wz - dz) : Math.min(0, o.wz + dz); }
      if (o.vx === 0 && o.vy === 0 && o.wx === 0 && o.wy === 0) o.wz = 0;
      o.x += o.vx * DT; o.y += o.vy * DT;
    }
    /* balls against balls: a few passes, so a tight rack passes its energy through */
    for (var pass = 0; pass < 6; pass++) {
    var any = false;
    for (i = 0; i < n; i++) {
      var p = bs[i]; if (!p.on) continue;
      for (j = i + 1; j < n; j++) {
        var q = bs[j]; if (!q.on) continue;
        var ex = q.x - p.x, ey = q.y - p.y, d2 = ex * ex + ey * ey;
        if (d2 >= 4 * R * R) continue;
        var dist = Math.sqrt(d2) || 1e-9, nx = ex / dist, ny = ey / dist;
        var push = (2 * R - dist) / 2;
        p.x -= nx * push; p.y -= ny * push; q.x += nx * push; q.y += ny * push;
        var vrel = (p.vx - q.vx) * nx + (p.vy - q.vy) * ny;
        if (vrel <= 0) continue;
        var jn = (1 + E_BALL) / 2 * vrel;
        p.vx -= jn * nx; p.vy -= jn * ny; q.vx += jn * nx; q.vy += jn * ny;
        /* a little throw from rubbing surfaces */
        var tx = -ny, ty = nx;
        var u = (p.vx - q.vx) * tx + (p.vy - q.vy) * ty + R * (p.wz + q.wz);
        var jt = Math.min(MU_BALL * jn, Math.abs(u) / 7) * (u > 0 ? -1 : 1);
        p.vx += jt * tx; p.vy += jt * ty; q.vx -= jt * tx; q.vy -= jt * ty;
        p.wz += 2.5 / R * jt; q.wz += 2.5 / R * jt;
        any = true;
        this._contact(p, q);
      }
    }
    if (!any) break;
    }
    /* cushions and pockets */
    for (i = 0; i < n; i++) {
      o = bs[i]; if (!o.on) continue;
      if (o.x > R + 0.002 && o.x < L - R - 0.002 && o.y > R + 0.002 && o.y < WD - R - 0.002) continue;
      for (var s = 0; s < SEGS.length; s++) {
        var g = SEGS[s], ax = g[0], ay = g[1], bx = g[2] - ax, by = g[3] - ay;
        var tt = ((o.x - ax) * bx + (o.y - ay) * by) / (bx * bx + by * by);
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        var cx = ax + bx * tt, cy = ay + by * tt, rx = o.x - cx, ry = o.y - cy, rd2 = rx * rx + ry * ry;
        if (rd2 >= R * R) continue;
        var rd = Math.sqrt(rd2) || 1e-9, mx = rx / rd, my = ry / rd;
        o.x = cx + mx * R; o.y = cy + my * R;
        var vn = o.vx * mx + o.vy * my;
        if (vn >= 0) continue;
        var tx2 = -my, ty2 = mx, vt = o.vx * tx2 + o.vy * ty2;
        var vn2 = -E_RAIL * vn;
        var slip2 = vt - R * o.wz;
        var lim = MU_RAIL * (1 + E_RAIL) * -vn, dvt = -slip2 * 2 / 7;
        if (dvt > lim) dvt = lim; else if (dvt < -lim) dvt = -lim;
        vt += dvt; o.wz -= 2.5 / R * dvt;
        o.vx = mx * vn2 + tx2 * vt; o.vy = my * vn2 + ty2 * vt;
        o.wy = o.vx / R * 0.6; o.wx = -o.vy / R * 0.6;
        this._rail(o);
      }
      for (var k = 0; k < 6; k++) {
        var P = POCKETS[k], px = o.x - P.x, py = o.y - P.y;
        if (px * px + py * py < P.r * P.r) { this._pot(o, k); break; }
      }
      if (o.on && (o.x < -0.08 || o.x > L + 0.08 || o.y < -0.08 || o.y > WD + 0.08)) this._pot(o, nearestPocket(o.x, o.y));
    }
    this.t += DT;
    if (this.t > MAX_T || !this.moving()) {
      for (i = 0; i < n; i++) { o = bs[i]; o.vx = o.vy = o.wx = o.wy = o.wz = 0; }
      this.done = true;
    }
  };
  Sim.prototype._contact = function (p, q) {
    var ev = this.ev;
    ev.contacts++;
    if (ev.first === null && (p.n === 0 || q.n === 0)) ev.first = p.n === 0 ? q.n : p.n;
    if (ev.hits.length < 64) ev.hits.push({ t: this.t, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, v: Math.abs((p.vx - q.vx) * (q.x - p.x) + (p.vy - q.vy) * (q.y - p.y)) / (2 * R) });
  };
  Sim.prototype._rail = function (o) {
    var ev = this.ev;
    ev.railHits = (ev.railHits || 0) + 1;
    if (ev.first !== null) ev.railAfter = true;
    if (o.n) ev.railBalls[o.n] = true;
  };
  Sim.prototype._pot = function (o, k) {
    o.on = false; o.pk = k; o.vx = o.vy = o.wx = o.wy = o.wz = 0;
    o.x = POCKETS[k].x; o.y = POCKETS[k].y;
    this.ev.pots.push({ n: o.n, pocket: k, t: this.t });
    if (o.n === 0) this.ev.cueOff = true;
  };
  Sim.prototype.run = function () { var guard = 0; while (!this.done && guard++ < MAX_T / DT + 10) this.step(); return this; };

  function nearestPocket(x, y) {
    var best = 0, bd = 1e9;
    for (var k = 0; k < 6; k++) { var dx = x - POCKETS[k].x, dy = y - POCKETS[k].y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = k; } }
    return best;
  }

  /* Get a shot going: checks it and places the cue ball when in hand. */
  function prepare(state, raw) {
    if (state.over) return { error: "the game is over" };
    var shot = clean(raw);
    var balls = clone(state.balls), cue = balls[0];
    if (state.inHand) {
      var at = shot.cue || (cue.on ? { x: cue.x, y: cue.y } : null);
      if (!at) return { error: "place the cue ball first" };
      if (!placeOk(state, at.x, at.y)) return { error: state.behind ? "the cue ball must go behind the line, clear of other balls" : "the cue ball cannot go there" };
      cue.x = at.x; cue.y = at.y; cue.on = true; shot.cue = { x: at.x, y: at.y };
    } else {
      if (!cue.on) return { error: "the cue ball is not on the table" };
      delete shot.cue;
    }
    return { shot: shot, sim: new Sim(balls, shot), before: balls };
  }

  /* What a finished shot means. Returns the new state. */
  function finish(state, shot, sim) {
    var s = clone(state), ev = sim.ev, me = s.turn, opp = 1 - me, names = s.names;
    s.balls = sim.b.map(function (o) { return { n: o.n, x: o.x, y: o.y, on: o.on }; });
    s.shots++; s.foul = null; s.last = { first: ev.first, pots: ev.pots.map(function (p) { return p.n; }) };
    var potted = ev.pots.map(function (p) { return p.n; }).filter(function (n) { return n !== 0; });
    var cueBall = s.balls[0];

    if (s.mode === "practice") {
      s.phase = "play"; s.behind = false;
      s.inHand = !cueBall.on;
      if (!cueBall.on) { cueBall.x = HEAD - 0.12; cueBall.y = WD / 2; }
      s.msg = potted.length ? "Potted " + potted.join(", ") + "." + (ev.cueOff ? " Scratch: place the cue ball." : "") : ev.cueOff ? "Scratch: place the cue ball anywhere." : ev.first == null ? "Missed everything." : "Nothing down.";
      if (!s.balls.some(function (b) { return b.on && b.n; })) s.msg = "Table cleared in " + s.shots + " shots. RE-RACK for more.";
      return s;
    }

    var wasBreak = s.phase === "break";
    var g = state.groups[me];
    var onEight = !!g && state.balls.filter(function (b) { return b.on && kind(b.n) === g; }).length === 0;
    var foul = null;
    if (ev.cueOff) foul = "scratch: the cue ball went in";
    else if (ev.first === null) foul = "the cue ball hit nothing";
    else if (!wasBreak) {
      if (g && !onEight && kind(ev.first) !== g) foul = "hit the " + ev.first + " first, not one of " + names[me] + "'s " + g + "s";
      else if (g && onEight && ev.first !== 8) foul = "had to hit the 8 first";
      else if (!g && ev.first === 8) foul = "hit the 8 first on an open table";
      else if (!potted.length && !ev.railAfter) foul = "no ball reached a cushion after the hit";
    } else if (!potted.length && Object.keys(ev.railBalls).length < 4) foul = "weak break: fewer than four balls reached a cushion";

    var eightDown = potted.indexOf(8) >= 0;
    if (eightDown && wasBreak) {
      /* the 8 on the break comes back to the foot spot */
      var e = ball(s, 8); e.on = true; e.x = FOOT.x; e.y = FOOT.y;
      while (!spotFree(s, e)) e.x += 0.004;
      potted = potted.filter(function (n) { return n !== 8; }); eightDown = false;
    }
    if (eightDown) {
      var at8 = ev.pots.filter(function (p) { return p.n === 8; })[0].pocket;
      var win = onEight && !foul && (shot.call == null || shot.call === at8);
      s.over = true; s.winner = win ? me : opp;
      s.msg = win ? names[me] + " sinks the 8 " + POCKETS[at8].name.toLowerCase() + " and wins!"
        : names[opp] + " wins: " + names[me] + (foul ? " fouled on the 8 (" + foul + ")" : !onEight ? " potted the 8 too early" : " put the 8 in the wrong pocket (called " + POCKETS[shot.call].name.toLowerCase() + ")") + ".";
      s.phase = "over"; s.inHand = false;
      return s;
    }

    s.phase = "play"; s.behind = false;
    potted.forEach(function (n) { var k = kind(n); if (k === "solid" || k === "stripe") { if (s.groups[0] === k) s.pots[0]++; else if (s.groups[1] === k) s.pots[1]++; } });
    var again = false, said = "";
    if (!foul && potted.length) {
      if (!g && !wasBreak) {
        var first = kind(potted[0]);
        s.groups[me] = first; s.groups[opp] = first === "solid" ? "stripe" : "solid";
        potted.forEach(function (n) { if (kind(n) === first) s.pots[me]++; else s.pots[opp]++; });
        said = names[me] + " takes " + first.toUpperCase() + "S. ";
        again = true;
      } else if (!g) again = true;
      else again = potted.some(function (n) { return kind(n) === g; });
    }
    if (foul) {
      s.foul = foul; s.turn = opp; s.inHand = true;
      if (!cueBall.on) { cueBall.on = true; cueBall.x = HEAD - 0.12; cueBall.y = WD / 2; nudgeFree(s); }
      s.msg = "FOUL by " + names[me] + ": " + foul + ". " + names[opp] + " has ball in hand.";
    } else if (again) {
      s.inHand = false;
      s.msg = said + names[me] + " potted " + potted.join(", ") + (onEightNow(s, me) ? " and is on the 8." : " and shoots again.");
    } else {
      s.inHand = false; s.turn = opp;
      s.msg = (potted.length ? names[me] + " potted " + potted.join(", ") + " but none of theirs. " : wasBreak ? "Nothing down on the break. " : "") + names[opp] + " to shoot.";
    }
    return s;
  }
  function onEightNow(s, p) { var g = s.groups[p]; return !!g && !s.balls.some(function (b) { return b.on && kind(b.n) === g; }); }
  function spotFree(s, b) {
    return s.balls.every(function (o) { if (o === b || !o.on) return true; var dx = o.x - b.x, dy = o.y - b.y; return dx * dx + dy * dy >= 4 * R * R; });
  }
  function nudgeFree(s) { var c = s.balls[0], tries = 0; while (!spotFree(s, c) && tries++ < 200) { c.y += (tries % 2 ? 1 : -1) * tries * 0.006; c.y = Math.max(R, Math.min(WD - R, c.y)); } }

  /* The whole shot at once (the relay, and the computer thinking). */
  function play(state, raw) {
    var p = prepare(state, raw);
    if (p.error) return p;
    p.sim.run();
    return { state: finish(state, p.shot, p.sim), shot: p.shot, events: p.sim.ev, before: p.before };
  }

  /* ---- the aiming guide: where the cue ball will first touch something ---- */
  function predict(state, cx, cy, dx, dy) {
    var m = Math.sqrt(dx * dx + dy * dy) || 1; dx /= m; dy /= m;
    var best = { t: 1e9, n: null };
    state.balls.forEach(function (b) {
      if (!b.on || b.n === 0) return;
      var fx = b.x - cx, fy = b.y - cy, along = fx * dx + fy * dy;
      if (along <= 0) return;
      var perp2 = fx * fx + fy * fy - along * along, rr = 4 * R * R;
      if (perp2 > rr) return;
      var t = along - Math.sqrt(rr - perp2);
      if (t < best.t) best = { t: t, n: b.n, bx: b.x, by: b.y };
    });
    /* the cushion it reaches, if nothing is in the way */
    var tw = 1e9;
    if (dx > 0) tw = Math.min(tw, (L - R - cx) / dx); if (dx < 0) tw = Math.min(tw, (R - cx) / dx);
    if (dy > 0) tw = Math.min(tw, (WD - R - cy) / dy); if (dy < 0) tw = Math.min(tw, (R - cy) / dy);
    if (best.n === null || tw < best.t) return { ball: null, x: cx + dx * tw, y: cy + dy * tw, t: tw };
    var gx = cx + dx * best.t, gy = cy + dy * best.t, nx = best.bx - gx, ny = best.by - gy, nm = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nm; ny /= nm;
    var dot = dx * nx + dy * ny, tx = dx - dot * nx, ty = dy - dot * ny;
    return { ball: best.n, x: gx, y: gy, t: best.t, ox: nx, oy: ny, cut: dot, tx: tx, ty: ty };
  }

  /* where a ball sent along (dx,dy) from (x,y) would go: a pocket index or null */
  function pocketFor(x, y, dx, dy) {
    var best = null, bd = 1e9;
    for (var k = 0; k < 6; k++) {
      var P = POCKETS[k], fx = P.mx - x, fy = P.my - y, along = fx * dx + fy * dy;
      if (along <= 0) continue;
      var perp = Math.abs(fx * dy - fy * dx);
      if (perp < 0.06 && along < bd) { bd = along; best = k; }
    }
    return best;
  }

  /* ---- the computer ------------------------------------------------------ */
  var LEVELS = { easy: { noise: 0.022, pnoise: 0.12, tries: 4, check: 1 }, normal: { noise: 0.009, pnoise: 0.06, tries: 8, check: 3 }, hard: { noise: 0.0028, pnoise: 0.03, tries: 12, check: 5 } };
  function clearPath(state, ax, ay, bx, by, skip) {
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    for (var i = 0; i < state.balls.length; i++) {
      var b = state.balls[i]; if (!b.on || skip.indexOf(b.n) >= 0) continue;
      var t = ((b.x - ax) * dx + (b.y - ay) * dy) / len2; if (t <= 0 || t >= 1) continue;
      var px = ax + dx * t - b.x, py = ay + dy * t - b.y;
      if (px * px + py * py < 4 * R * R * 0.98) return false;
    }
    return true;
  }
  function gauss(r) { var u = 0; for (var i = 0; i < 6; i++) u += r(); return (u - 3) / 1.4; }

  /* Every pot it could try, best first. */
  function options(state, cue) {
    var me = state.turn, list = [];
    targets(state, me).forEach(function (n) {
      var b = ball(state, n); if (!b || !b.on) return;
      for (var k = 0; k < 6; k++) {
        var P = POCKETS[k], px = P.mx - b.x, py = P.my - b.y, pd = Math.sqrt(px * px + py * py);
        px /= pd; py /= pd;
        var gx = b.x - px * 2 * R, gy = b.y - py * 2 * R;
        var ax = gx - cue.x, ay = gy - cue.y, ad = Math.sqrt(ax * ax + ay * ay); if (ad < 1e-6) continue;
        var cut = (ax * px + ay * py) / ad;
        if (cut < 0.25) continue;
        if (!clearPath(state, cue.x, cue.y, gx, gy, [0, n])) continue;
        if (!clearPath(state, b.x, b.y, P.mx, P.my, [n])) continue;
        var score = cut * cut / (1 + ad * 0.6 + pd * 0.9) * (k === 1 || k === 4 ? (Math.abs(px) < 0.5 ? 0.5 : 1) : 1);
        list.push({ n: n, pocket: k, dx: ax / ad, dy: ay / ad, dist: ad + pd / Math.max(0.3, cut), score: score });
      }
    });
    return list.sort(function (a, b) { return b.score - a.score; });
  }

  /* Choose a shot. Deterministic for a given rng; the level decides how
     much it thinks and how steady its hand is. */
  function aiShot(state, level, rnd) {
    var L2 = LEVELS[level] || LEVELS.normal, r = rnd || Math.random;
    var cue = state.balls[0], place = null;
    if (state.phase === "break") {
      place = { x: HEAD - 0.12, y: WD / 2 + (r() - 0.5) * 0.2 };
      var bdx = FOOT.x - place.x, bdy = FOOT.y - place.y, bm = Math.sqrt(bdx * bdx + bdy * bdy);
      return { dx: bdx / bm + gauss(r) * L2.noise * 0.4, dy: bdy / bm + gauss(r) * L2.noise * 0.4, power: 0.92 + r() * 0.08, sx: 0, sy: 0.1, cue: place };
    }
    var c = { x: cue.x, y: cue.y };
    if (state.inHand) {
      /* try a few spots behind the easiest balls */
      var best = null;
      targets(state).forEach(function (n) {
        var b = ball(state, n);
        for (var k = 0; k < 6; k++) {
          var P = POCKETS[k], px = P.mx - b.x, py = P.my - b.y, pd = Math.sqrt(px * px + py * py); px /= pd; py /= pd;
          for (var back = 0.18; back <= 0.5; back += 0.16) {
            var x = b.x - px * (2 * R + back), y = b.y - py * (2 * R + back);
            if (!placeOk(state, x, y)) continue;
            if (!clearPath(state, b.x, b.y, P.mx, P.my, [n])) continue;
            var sc = 1 / (1 + pd + back);
            if (!best || sc > best.sc) best = { x: x, y: y, sc: sc };
          }
        }
      });
      if (!best) { for (var t = 0; t < 60 && !best; t++) { var x2 = R + r() * (L - 2 * R), y2 = R + r() * (WD - 2 * R); if (placeOk(state, x2, y2)) best = { x: x2, y: y2 }; } }
      if (best) { c = { x: best.x, y: best.y }; place = c; }
    }
    var st = state;
    if (place) { st = clone(state); st.balls[0].x = c.x; st.balls[0].y = c.y; st.balls[0].on = true; }
    var opts = options(st, c).slice(0, L2.tries), pick = null;
    /* what a shot leaves: a win, the table still ours with something to
       shoot next, the turn passed, or a foul */
    function judge(sh, bonus) {
      var res = play(st, sh);
      if (res.error) return -1e9;
      var ns = res.state;
      if (ns.over) return ns.winner === state.turn ? 100 : -100;
      if (ns.foul) return -25;
      if (ns.turn === state.turn) { var nx = options(ns, ns.balls[0]); return 10 + Math.min(nx.length, 6) * 0.5 + (nx[0] || { score: 0 }).score * 5 + bonus; }
      return bonus;
    }
    function turn(sh, a) { var ca = 1 - a * a / 2; return { dx: sh.dx * ca - sh.dy * a, dy: sh.dx * a + sh.dy * ca, power: sh.power, sx: sh.sx, sy: sh.sy, cue: sh.cue, call: sh.call }; }
    /* draw, stun or follow: the cue ball rolling in after the object ball is
       the commonest way to lose a turn, so the spin is chosen, not fixed */
    var cands = [];
    opts.forEach(function (o) {
      [0.17, 0.27, 0.42].forEach(function (pw) {
        [-0.35, 0, 0.25].forEach(function (sy) {
          var sh = { dx: o.dx, dy: o.dy, power: Math.min(1, pw * (0.6 + o.dist * 0.5)), sx: 0, sy: sy, cue: place, call: o.pocket };
          var sc = judge(sh, 0) + o.score;
          if (sc > -1e8) cands.push({ sc: sc, sh: sh, o: o });
        });
      });
    });
    cands.sort(function (a, b) { return b.sc - a.sc; });
    /* the best few, tried again with the hand a little off: a shot that only
       works when struck perfectly is a worse choice than a safe one */
    var wob = Math.max(0.003, L2.noise * 1.3), best = -1e9;
    cands.slice(0, L2.check || 3).forEach(function (cd) {
      var sc = (cd.sc * 2 + judge(turn(cd.sh, wob), 0) + cd.o.score + judge(turn(cd.sh, -wob), 0) + cd.o.score) / 4;
      if (sc > best) { best = sc; pick = { dx: cd.sh.dx, dy: cd.sh.dy, power: cd.sh.power, sx: 0, sy: cd.sh.sy, call: cd.sh.call }; }
    });
    if (!pick) {
      /* no pot on: roll softly into one of its own balls */
      var tg = targets(st).map(function (n) { return ball(st, n); }).filter(function (b) { return clearPath(st, c.x, c.y, b.x, b.y, [0, b.n]); })[0] || ball(st, targets(st)[0]);
      var tx = tg.x - c.x, ty = tg.y - c.y, tm = Math.sqrt(tx * tx + ty * ty) || 1;
      pick = { dx: tx / tm, dy: ty / tm, power: 0.35, sx: 0, sy: 0, call: pocketFor(tg.x, tg.y, tx / tm, ty / tm) };
    }
    /* the hand is not perfectly steady */
    var a = gauss(r) * L2.noise, ca = 1 - a * a / 2, sa = a;
    var ndx = pick.dx * ca - pick.dy * sa, ndy = pick.dx * sa + pick.dy * ca;
    pick.dx = ndx; pick.dy = ndy; pick.power = Math.max(0.05, Math.min(1, pick.power * (1 + gauss(r) * L2.pnoise)));
    if (place) pick.cue = place;
    return pick;
  }

  var API = {
    L: L, W: WD, R: R, HEAD: HEAD, FOOT: FOOT, POCKETS: POCKETS, SEGS: SEGS, DT: DT, VMAX: VMAX, LEVELS: LEVELS,
    kind: kind, rack: rack, newGame: newGame, prepare: prepare, finish: finish, play: play, clean: clean, Sim: Sim,
    targets: targets, groupLeft: groupLeft, placeOk: placeOk, predict: predict, pocketFor: pocketFor, aiShot: aiShot, options: options,
    onEight: onEightNow, mulberry: mulberry, clone: clone
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else if (root && root.FieldKit) root.FieldKit.provide("poolEngine", API);
})(typeof window !== "undefined" ? window : this);
