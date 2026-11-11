/* ============================================================
   FieldKit :: pool — POOL HALL
   Eight-ball on a nine-foot table: against the computer, against a
   friend on the same screen, alone for practice, or against anyone on
   the relay with a gamertag (the same one DEEPHOLD uses).

   The physics and the rules are core/pool-engine.js. This panel draws,
   takes the cue, and for online matches sends the shot to the relay,
   which plays it with the same engine and says what happened. The
   panel shows the shot as it happens from the same table, so it lands
   exactly where the relay says it did.

   LIGHT ON THE MACHINE. Nothing is drawn while nothing changes: the
   table is painted once into a picture, and a frame is only drawn
   while a ball moves, the cue is being aimed or something animates.
   Each ball is shaded pixel by pixel into its own small picture, and
   only again when it has turned.

   CONTROLS. Move over the table to aim. Press and pull back to set the
   power, let go to shoot. Arrow keys fine-tune the aim, Up and Down
   set the power bar, Space shoots with it. Click the little cue ball
   to put spin on. With ball in hand, drag the cue ball where you want
   it. On the 8, the pocket it is heading for is called for you; click
   another pocket to call that one.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var STORE = "fk.pool", GAMES = "fk.deephold";
  var RAIL = 0.118;                               /* wood + cushion beyond the cushion nose (m) */
  var COL = { 0: [240, 238, 228], 1: [242, 190, 30], 2: [30, 80, 200], 3: [212, 44, 34], 4: [96, 44, 146], 5: [240, 122, 22], 6: [30, 136, 62], 7: [140, 30, 30], 8: [22, 22, 24] };
  var LIGHT = (function () { var x = -0.38, y = -0.52, z = 0.76, m = Math.sqrt(x * x + y * y + z * z); return [x / m, y / m, z / m]; })();
  var HALF = (function () { var x = LIGHT[0], y = LIGHT[1], z = LIGHT[2] + 1, m = Math.sqrt(x * x + y * y + z * z); return [x / m, y / m, z / m]; })();

  function PE() { return FieldKit.service("poolEngine"); }
  function ui() { return FieldKit.service("ui"); }
  function relayBase() {
    var st = FieldKit.service("settings");
    var u = String((st && st.get("relayUrl")) || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }
  function prefs(v) {
    try {
      if (v === undefined) return JSON.parse(window.localStorage.getItem(STORE) || "null") || {};
      window.localStorage.setItem(STORE, JSON.stringify(v));
    } catch (e) { /* no storage */ }
    return v || {};
  }
  function setPref(k, val) { var p = prefs(); p[k] = val; prefs(p); }

  /* ---- the gamertag, shared with DEEPHOLD ---------------------------------- */
  var ownSession = null;
  function session() {
    var dh = FieldKit.service("deephold");
    if (dh && dh.session) { var s = dh.session(); if (s) return s; }
    if (ownSession) return ownSession;
    try { var st = JSON.parse(window.localStorage.getItem(GAMES) || "null"); if (st && st.token && st.tag) return { token: st.token, tag: st.tag }; } catch (e) { /* none */ }
    return null;
  }
  function adopt(s, keep) {
    var dh = FieldKit.service("deephold");
    if (dh && dh.adopt) dh.adopt(s, keep);
    ownSession = { token: s.token, tag: s.tag };
    try { if (keep !== false) window.localStorage.setItem(GAMES, JSON.stringify({ token: s.token, tag: s.tag })); } catch (e) { /* page only */ }
  }
  function dropSession() {
    ownSession = null;
    var dh = FieldKit.service("deephold");
    if (dh && dh.signOut) dh.signOut();
    try { window.localStorage.removeItem(GAMES); } catch (e) { /* none */ }
  }

  async function api(method, path, body, prefix) {
    var base = relayBase();
    if (!base) throw new Error("no relay is set up; add one in RELAY LINK first");
    var headers = {}, s = session();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (s) headers.Authorization = "Bearer " + s.token;
    var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 15000);
    try {
      var res = await window.fetch(base + "/" + (prefix || "pool") + "/" + path, { method: method, headers: headers, mode: "cors", cache: "no-store", signal: ac.signal, body: body === undefined ? undefined : JSON.stringify(body) });
      var text = await res.text(), data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
      if (!res.ok) {
        if (res.status === 401 && data && data.needsSignIn && s) dropSession();
        var err = new Error((data && data.error) || ("the relay answered " + res.status));
        err.status = res.status; err.data = data; throw err;
      }
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("the relay did not answer in time");
      throw e;
    } finally { clearTimeout(timer); }
  }

  /* ---- sound: a few synthesised clicks, quiet, and off with one button ---- */
  var actx = null, lastClack = 0;
  function sound(kind, v) {
    if (prefs().sound === false) return;
    try {
      if (!actx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; actx = new AC(); }
      if (actx.state === "suspended") actx.resume();
      var now = actx.currentTime;
      if (kind === "clack" && now - lastClack < 0.025) return;
      if (kind === "clack") lastClack = now;
      var vol = Math.min(1, Math.max(0.05, v || 0.5));
      var len = kind === "pot" ? 0.18 : kind === "rail" ? 0.07 : kind === "cue" ? 0.05 : 0.035;
      var buf = actx.createBuffer(1, Math.ceil(actx.sampleRate * len), actx.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < d.length; i++) { var t = i / d.length; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, kind === "pot" ? 2 : 4); }
      var src = actx.createBufferSource(); src.buffer = buf;
      var f = actx.createBiquadFilter(); f.type = "bandpass";
      f.frequency.value = kind === "clack" ? 2600 : kind === "rail" ? 420 : kind === "pot" ? 220 : 1400; f.Q.value = kind === "clack" ? 2.5 : 1.2;
      var g = actx.createGain(); g.gain.value = 0.22 * vol;
      src.connect(f); f.connect(g); g.connect(actx.destination); src.start(now);
    } catch (e) { /* no sound is fine */ }
  }

  /* ---- small helpers -------------------------------------------------------- */
  function sig(o) { try { return JSON.stringify(o); } catch (e) { return String(Math.random()); } }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rgb(c, k) { return "rgb(" + Math.round(c[0] * k) + "," + Math.round(c[1] * k) + "," + Math.round(c[2] * k) + ")"; }
  function gameOf() { return prefs().game === "9ball" ? "9ball" : "8ball"; }
  function gameTitle(g) { return g === "9ball" ? "NINE-BALL" : "EIGHT-BALL"; }
  function groupName(g) { return g === "solid" ? "SOLIDS" : g === "stripe" ? "STRIPES" : "OPEN TABLE"; }

  /* ---- what is on screen ---------------------------------------------------- */
  var ctx, el, host, gone = true, R = {}, screen = "";
  var mode = null, level = "normal", gs = null, match = null;     /* match: { id, seat, seq } */
  var vis = {};                                                     /* n -> { x, y, on, M, dirty, spr, potT, pk } */
  var sim = null, simShot = null, simAcc = 0, pendingFinal = null, waitingRelay = false, replaying = false;
  var aim = { dx: 1, dy: 0 }, power = 0.45, spin = { x: 0, y: 0 }, callPocket = null, callManual = false;
  var drag = null, pointer = null, strikeT = 0, aiTimer = null, aiShow = null, pollTimer = null, lobbyTimer = null, bgTimer = null;
  var raf = 0, lastTs = 0, kscale = 300, dpr = 1, staticCanvas = null, hits0 = 0, rails0 = 0, pots0 = 0, needDraw = true;
  var lobbySig = "", lastLobby = null, onResize = null, ro = null;

  function myTurn() {
    if (!gs || gs.over || sim) return false;
    if (mode === "ai") return gs.turn === 0;
    if (mode === "online") return !!match && gs.turn === match.seat;
    return true;
  }
  function names() {
    if (mode === "ai") return ["YOU", "COMPUTER · " + level.toUpperCase()];
    if (mode === "hot") return ["PLAYER 1", "PLAYER 2"];
    if (mode === "practice") return ["YOU", "—"];
    return gs ? gs.names : ["", ""];
  }

  /* ---- balls on screen ------------------------------------------------------ */
  function rotM(M, ax, ay, az, ang) {
    var c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    var r = [t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay,
      t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax,
      t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c];
    var o = new Array(9);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) o[i * 3 + j] = r[i * 3] * M[j] + r[i * 3 + 1] * M[3 + j] + r[i * 3 + 2] * M[6 + j];
    return o;
  }
  function orthonormal(M) {
    var a = [M[0], M[3], M[6]], b = [M[1], M[4], M[7]];
    var la = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); a = a.map(function (v) { return v / la; });
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; b = [b[0] - d * a[0], b[1] - d * a[1], b[2] - d * a[2]];
    var lb = Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]); b = b.map(function (v) { return v / lb; });
    var c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
  }
  function startM(n) {
    var M = [0, 0, -1, 0, 1, 0, 1, 0, 0];
    var r = ((n * 2654435761) >>> 0) / 4294967296;
    M = rotM(M, 0, 0, 1, (r - 0.5) * 1.2);
    M = rotM(M, 1, 0, 0, (((n * 40503) % 97) / 97 - 0.5) * 0.6);
    return M;
  }
  function syncVis(balls, fresh) {
    balls.forEach(function (b) {
      var v = vis[b.n];
      if (!v || fresh) v = vis[b.n] = { n: b.n, M: v && !fresh ? v.M : startM(b.n), dirty: true, spr: v ? v.spr : null, potT: 0, pk: -1, steps: 0 };
      v.x = b.x; v.y = b.y; if (v.on !== b.on) v.potT = 0; v.on = b.on;
    });
    needDraw = true;
  }

  function shadeBall(v) {
    var D = Math.max(8, Math.ceil(2 * PE().R * kscale * dpr) + 2);
    if (!v.spr || v.spr.width !== D) { v.spr = document.createElement("canvas"); v.spr.width = D; v.spr.height = D; }
    var g = v.spr.getContext("2d"); if (!g) return;
    var img = g.createImageData(D, D), d = img.data, c = D / 2, rad = D / 2 - 1, M = v.M, n = v.n;
    var base = COL[n > 8 ? n - 8 : n], stripe = n > 8, white = COL[0];
    for (var y = 0; y < D; y++) for (var x = 0; x < D; x++) {
      var px = (x + 0.5 - c) / rad, py = (y + 0.5 - c) / rad, r2 = px * px + py * py, o = (y * D + x) * 4;
      if (r2 > 1.06) { d[o + 3] = 0; continue; }
      var a = r2 > 1 ? (1.06 - r2) / 0.06 : 1;
      if (r2 > 1) { var s1 = 1 / Math.sqrt(r2); px *= s1; py *= s1; r2 = 1; }
      var pz = Math.sqrt(Math.max(0, 1 - r2));
      var bx = M[0] * px + M[3] * py + M[6] * pz, by = M[1] * px + M[4] * py + M[7] * pz, bz = M[2] * px + M[5] * py + M[8] * pz;
      var colr;
      if (n === 0) colr = (Math.abs(by) > 0.95 || Math.abs(bz) > 0.95) ? [200, 40, 40] : white;
      else if (Math.abs(bx) > 0.83) colr = white;
      else if (stripe) colr = Math.abs(by) < 0.5 ? base : white;
      else colr = base;
      var dif = Math.max(0, px * LIGHT[0] + py * LIGHT[1] + pz * LIGHT[2]);
      var sp = Math.max(0, px * HALF[0] + py * HALF[1] + pz * HALF[2]); sp = sp * sp; sp = sp * sp; sp = sp * sp; sp = sp * sp; sp = sp * sp;
      var k = (0.36 + 0.72 * dif) * (0.82 + 0.18 * pz);
      d[o] = Math.min(255, colr[0] * k + 255 * sp * 0.85);
      d[o + 1] = Math.min(255, colr[1] * k + 255 * sp * 0.85);
      d[o + 2] = Math.min(255, colr[2] * k + 255 * sp * 0.85);
      d[o + 3] = 255 * a;
    }
    g.putImageData(img, 0, 0);
    if (n > 0) {
      /* the number, on whichever spot faces up */
      var sx = M[0], sy = M[1], sz = M[2], ax2 = M[0], ay2 = M[3], az2 = M[6];
      void sx; void sy; void sz;
      if (az2 < 0) { ax2 = -ax2; ay2 = -ay2; az2 = -az2; }
      if (az2 > 0.3) {
        g.save();
        g.globalAlpha = Math.min(1, (az2 - 0.3) * 3);
        g.translate(c + ax2 * rad * 0.98, c + ay2 * rad * 0.98);
        var sc = 0.55 + 0.45 * az2; g.scale(sc, sc);
        g.fillStyle = "#111"; g.font = "bold " + Math.max(6, Math.round(rad * 0.78)) + "px Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(String(n), 0, rad * 0.04);
        g.restore();
      }
    }
    v.dirty = false;
  }

  /* ---- the table, painted once ---------------------------------------------- */
  function X(x) { return (x + RAIL) * kscale * dpr; }
  function Y(y) { return (y + RAIL) * kscale * dpr; }
  function paintStatic() {
    var E = PE(), cv = R.canvas; if (!cv || !cv.getContext) return;
    staticCanvas = document.createElement("canvas"); staticCanvas.width = cv.width; staticCanvas.height = cv.height;
    var g = staticCanvas.getContext("2d"); if (!g) return;
    var Wp = cv.width, Hp = cv.height, s = kscale * dpr;
    /* the wood */
    var wg = g.createLinearGradient(0, 0, 0, Hp);
    wg.addColorStop(0, "#4a2312"); wg.addColorStop(0.5, "#3a1a0c"); wg.addColorStop(1, "#2a1208");
    g.fillStyle = wg; roundRect(g, 0, 0, Wp, Hp, 0.05 * s); g.fill();
    var rnd = PE().mulberry(77);
    g.globalAlpha = 0.18;
    for (var i = 0; i < 160; i++) { var yy = rnd() * Hp; g.strokeStyle = rnd() < 0.5 ? "#6a3418" : "#1a0904"; g.lineWidth = 0.5 + rnd() * 1.5; g.beginPath(); g.moveTo(0, yy); g.bezierCurveTo(Wp * 0.3, yy + (rnd() - 0.5) * 8, Wp * 0.7, yy + (rnd() - 0.5) * 8, Wp, yy + (rnd() - 0.5) * 6); g.stroke(); }
    g.globalAlpha = 1;
    /* a sheen along the inner edge of the wood */
    g.strokeStyle = "rgba(255,200,150,.12)"; g.lineWidth = 2 * dpr; roundRect(g, 0.012 * s, 0.012 * s, Wp - 0.024 * s, Hp - 0.024 * s, 0.04 * s); g.stroke();
    /* the cloth, under the cushions */
    var inset = (RAIL - 0.05) * s;
    g.fillStyle = "#145c3e"; g.fillRect(inset, inset, Wp - 2 * inset, Hp - 2 * inset);
    var fg = g.createRadialGradient(Wp / 2, Hp / 2, Hp * 0.1, Wp / 2, Hp / 2, Wp * 0.62);
    fg.addColorStop(0, "#23855a"); fg.addColorStop(0.6, "#1a6e49"); fg.addColorStop(1, "#11523a");
    g.fillStyle = fg; g.fillRect(X(0), Y(0), E.L * s, E.W * s);
    /* the nap of the cloth */
    var img = g.getImageData(Math.round(X(0)), Math.round(Y(0)), Math.round(E.L * s), Math.round(E.W * s)), d = img.data;
    for (var p = 0; p < d.length; p += 4) { var nz = (rnd() - 0.5) * 9; d[p] += nz; d[p + 1] += nz; d[p + 2] += nz; }
    g.putImageData(img, Math.round(X(0)), Math.round(Y(0)));
    /* cushions, with their jaws cut toward the pockets */
    var depth = 0.045;
    var cush = [
      [[E.SEGS[0][0] - 0.03, -depth], [E.SEGS[0][0], 0], [E.L / 2 - 0.064, 0], [E.L / 2 - 0.064 + 0.01, -depth]],
      [[E.L / 2 + 0.064 - 0.01, -depth], [E.L / 2 + 0.064, 0], [E.L - 0.086, 0], [E.L - 0.086 + 0.03, -depth]]
    ];
    var all = [];
    cush.forEach(function (c) { all.push(c); all.push(c.map(function (q) { return [q[0], E.W - q[1]]; })); });
    all.push([[-depth, 0.086 - 0.03], [0, 0.086], [0, E.W - 0.086], [-depth, E.W - 0.086 + 0.03]]);
    all.push([[E.L + depth, 0.086 - 0.03], [E.L, 0.086], [E.L, E.W - 0.086], [E.L + depth, E.W - 0.086 + 0.03]]);
    all.forEach(function (poly) {
      g.beginPath(); poly.forEach(function (q, i) { if (i) g.lineTo(X(q[0]), Y(q[1])); else g.moveTo(X(q[0]), Y(q[1])); }); g.closePath();
      g.fillStyle = "#0f5236"; g.fill();
      g.strokeStyle = "rgba(160,255,200,.18)"; g.lineWidth = 1.2 * dpr;
      g.beginPath(); g.moveTo(X(poly[1][0]), Y(poly[1][1])); g.lineTo(X(poly[2][0]), Y(poly[2][1])); g.stroke();
    });
    /* the pockets */
    E.POCKETS.forEach(function (P, k) {
      var side = k === 1 || k === 4, r = (side ? 0.062 : 0.068) * s, cx = X(side ? P.x : P.x + (P.x < 1 ? 0.004 : -0.004)), cy = Y(P.y);
      var pg = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.25);
      pg.addColorStop(0, "#000"); pg.addColorStop(0.75, "#050403"); pg.addColorStop(1, "rgba(20,10,4,.0)");
      g.fillStyle = "#2b1a10"; g.beginPath(); g.arc(cx, cy, r * 1.22, 0, Math.PI * 2); g.fill();
      g.fillStyle = pg; g.beginPath(); g.arc(cx, cy, r * 1.08, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#000"; g.beginPath(); g.arc(cx, cy, r * 0.86, 0, Math.PI * 2); g.fill();
    });
    /* the sights in the rails */
    var dmd = function (x, y) { g.fillStyle = "#e8dcc0"; g.beginPath(); g.moveTo(x, y - 3 * dpr); g.lineTo(x + 2.2 * dpr, y); g.lineTo(x, y + 3 * dpr); g.lineTo(x - 2.2 * dpr, y); g.closePath(); g.fill(); };
    for (var q = 1; q < 8; q++) { if (q === 4) continue; dmd(X(E.L * q / 8), Y(-RAIL / 2 - 0.02)); dmd(X(E.L * q / 8), Y(E.W + RAIL / 2 + 0.02)); }
    for (var q2 = 1; q2 < 4; q2++) { dmd(X(-RAIL / 2 - 0.02), Y(E.W * q2 / 4)); dmd(X(E.L + RAIL / 2 + 0.02), Y(E.W * q2 / 4)); }
    /* foot spot and head string marks */
    g.fillStyle = "rgba(255,255,255,.35)"; g.beginPath(); g.arc(X(E.FOOT.x), Y(E.FOOT.y), 2 * dpr, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(X(E.HEAD), Y(E.W / 2), 1.5 * dpr, 0, Math.PI * 2); g.fill();
    /* the lamp over the table */
    var lg = g.createRadialGradient(Wp / 2, Hp * 0.45, 0, Wp / 2, Hp / 2, Wp * 0.55);
    lg.addColorStop(0, "rgba(255,240,200,.07)"); lg.addColorStop(1, "rgba(0,0,0,.22)");
    g.fillStyle = lg; g.fillRect(0, 0, Wp, Hp);
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath(); }

  function fit() {
    var E = PE(), cv = R.canvas; if (!cv || !E) return;
    var box = cv.parentNode && cv.parentNode.getBoundingClientRect ? cv.parentNode.getBoundingClientRect() : { width: 900 };
    var cssW = Math.max(320, Math.floor(box.width || 900));
    var tw = E.L + 2 * RAIL, th = E.W + 2 * RAIL;
    var maxH = Math.max(200, (host && host.getBoundingClientRect ? host.getBoundingClientRect().height : 700) - 230);
    if (cssW * th / tw > maxH) cssW = Math.floor(maxH * tw / th);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    kscale = cssW / tw;
    cv.style.width = cssW + "px"; cv.style.height = Math.round(cssW * th / tw) + "px";
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssW * th / tw * dpr);
    paintStatic();
    Object.keys(vis).forEach(function (k) { vis[k].dirty = true; });
    needDraw = true; kick();
  }

  /* ---- drawing a frame ------------------------------------------------------ */
  function cuePos() {
    var c = vis[0];
    if (drag && drag.kind === "place") return { x: drag.x, y: drag.y };
    return c ? { x: c.x, y: c.y } : { x: 0.5, y: 0.6 };
  }
  function draw(now) {
    var cv = R.canvas, g = cv && cv.getContext ? cv.getContext("2d") : null, E = PE();
    if (!g || !staticCanvas || !gs) return;
    var s = kscale * dpr, rr = E.R * s;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(staticCanvas, 0, 0);
    var turnable = myTurn() && !aiShow;
    /* where the cue ball may go */
    if (gs.inHand && turnable) {
      g.fillStyle = "rgba(255,255,255,.05)";
      if (gs.behind) { g.fillRect(X(0), Y(0), E.HEAD * s, E.W * s); g.strokeStyle = "rgba(255,255,255,.3)"; g.setLineDash && g.setLineDash([4 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(X(E.HEAD), Y(0)); g.lineTo(X(E.HEAD), Y(E.W)); g.stroke(); g.setLineDash && g.setLineDash([]); }
    }
    /* which balls are yours: a soft ring */
    var legal = {};
    if (gs && !gs.over && !sim && mode !== "practice") E.targets(gs).forEach(function (n) { legal[n] = true; });
    /* shadows, then balls */
    var list = Object.keys(vis).map(function (k) { return vis[k]; });
    list.forEach(function (v) {
      if (!v.on && !(v.potT && now - v.potT < 380)) return;
      var p = v.n === 0 ? cuePos() : v;
      var sh = g.createRadialGradient(X(p.x) + rr * 0.35, Y(p.y) + rr * 0.45, rr * 0.2, X(p.x) + rr * 0.35, Y(p.y) + rr * 0.45, rr * 1.25);
      sh.addColorStop(0, "rgba(0,0,0,.45)"); sh.addColorStop(1, "rgba(0,0,0,0)");
      if (v.on) { g.fillStyle = sh; g.beginPath(); g.arc(X(p.x) + rr * 0.35, Y(p.y) + rr * 0.45, rr * 1.25, 0, Math.PI * 2); g.fill(); }
    });
    list.forEach(function (v) {
      var p = v.n === 0 ? cuePos() : v, scale = 1, alpha = 1;
      if (!v.on) {
        if (!(v.potT && now - v.potT < 380)) return;
        var f = (now - v.potT) / 380; scale = 1 - f * 0.55; alpha = 1 - f;
        var P = E.POCKETS[v.pk] || { x: v.x, y: v.y }; p = { x: v.x + (P.x - v.x) * f, y: v.y + (P.y - v.y) * f };
      }
      if (v.dirty || !v.spr) shadeBall(v);
      if (!v.spr) return;
      var D = v.spr.width * scale;
      g.globalAlpha = alpha * (drag && drag.kind === "place" && v.n === 0 && !E.placeOk(gs, p.x, p.y) ? 0.45 : 1);
      g.drawImage(v.spr, X(p.x) - D / 2, Y(p.y) - D / 2, D, D);
      g.globalAlpha = 1;
      if (legal[v.n] && turnable && v.on) {
        g.strokeStyle = v.n === 8 ? "rgba(255,210,120,.85)" : "rgba(255,255,255,.55)"; g.lineWidth = 1.4 * dpr;
        g.beginPath(); g.arc(X(p.x), Y(p.y), rr + 2.5 * dpr, 0, Math.PI * 2); g.stroke();
      }
    });
    /* the called pocket */
    if (callPocket != null && needCall() && (turnable || aiShow)) {
      var CP = E.POCKETS[callPocket], pulse = 0.5 + 0.5 * Math.sin(now / 180);
      g.strokeStyle = "rgba(255,210,120," + (0.5 + pulse * 0.5).toFixed(2) + ")"; g.lineWidth = 2.5 * dpr;
      g.beginPath(); g.arc(X(CP.mx + (CP.x - CP.mx) * 0.6), Y(CP.my + (CP.y - CP.my) * 0.6), 0.075 * s, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#ffd27a"; g.font = "bold " + Math.round(10 * dpr) + "px monospace"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("8", X(CP.mx + (CP.x - CP.mx) * 0.6), Y(CP.my + (CP.y - CP.my) * 0.6));
    }
    /* aiming */
    if ((turnable || aiShow) && vis[0] && (vis[0].on || gs.inHand)) {
      var c = cuePos(), a = aiShow ? aiShow.dir : aim;
      var pr = E.predict(gs, c.x, c.y, a.dx, a.dy);
      var bad = pr.ball != null && mode !== "practice" && !legal[pr.ball];
      g.strokeStyle = bad ? "rgba(255,110,90,.7)" : "rgba(255,255,255,.55)"; g.lineWidth = 1.2 * dpr;
      g.setLineDash && g.setLineDash([5 * dpr, 4 * dpr]);
      g.beginPath(); g.moveTo(X(c.x + a.dx * E.R), Y(c.y + a.dy * E.R)); g.lineTo(X(pr.x), Y(pr.y)); g.stroke();
      g.setLineDash && g.setLineDash([]);
      g.beginPath(); g.arc(X(pr.x), Y(pr.y), rr, 0, Math.PI * 2); g.stroke();
      if (pr.ball != null) {
        var len = 0.12 + 0.5 * Math.max(0, pr.cut);
        g.strokeStyle = bad ? "rgba(255,110,90,.85)" : "rgba(255,230,140,.9)"; g.lineWidth = 2 * dpr;
        g.beginPath(); var ob = vis[pr.ball]; g.moveTo(X(ob.x), Y(ob.y)); g.lineTo(X(ob.x + pr.ox * len), Y(ob.y + pr.oy * len)); g.stroke();
        var tl = Math.sqrt(pr.tx * pr.tx + pr.ty * pr.ty);
        if (tl > 0.05) { g.strokeStyle = "rgba(140,200,255,.6)"; g.lineWidth = 1.2 * dpr; g.beginPath(); g.moveTo(X(pr.x), Y(pr.y)); g.lineTo(X(pr.x + pr.tx / tl * 0.18 * tl), Y(pr.y + pr.ty / tl * 0.18 * tl)); g.stroke(); }
        if (bad) { g.fillStyle = "rgba(255,120,100,.95)"; g.font = "bold " + Math.round(10 * dpr) + "px monospace"; g.textAlign = "center"; g.fillText("NOT YOUR BALL", X(pr.x), Y(pr.y) - rr - 8 * dpr); }
      }
      /* the cue itself */
      var pull = (drag && drag.kind === "pull" ? drag.power : aiShow ? aiShow.pull : 0) * 0.28;
      if (strikeT && now - strikeT < 90) pull = pull * (1 - (now - strikeT) / 90);
      drawCue(g, c, a, pull);
      if (drag && drag.kind === "pull") {
        g.fillStyle = "#ffd27a"; g.font = "bold " + Math.round(11 * dpr) + "px monospace"; g.textAlign = "center";
        g.fillText(Math.round(drag.power * 100) + "%", X(c.x) - a.dx * (0.2 + pull) * s, Y(c.y) - a.dy * (0.2 + pull) * s - 14 * dpr);
      }
    }
  }
  function drawCue(g, c, a, pull) {
    var E = PE(), s = kscale * dpr, gap = E.R + 0.012 + pull;
    var tx = c.x - a.dx * gap, ty = c.y - a.dy * gap, len = 1.42;
    var bx = tx - a.dx * len, by = ty - a.dy * len, nx = -a.dy, ny = a.dx;
    function quad(f0, f1, w0, w1, col) {
      var x0 = tx - a.dx * len * f0, y0 = ty - a.dy * len * f0, x1 = tx - a.dx * len * f1, y1 = ty - a.dy * len * f1;
      g.fillStyle = col; g.beginPath();
      g.moveTo(X(x0 + nx * w0), Y(y0 + ny * w0)); g.lineTo(X(x1 + nx * w1), Y(y1 + ny * w1));
      g.lineTo(X(x1 - nx * w1), Y(y1 - ny * w1)); g.lineTo(X(x0 - nx * w0), Y(y0 - ny * w0)); g.closePath(); g.fill();
    }
    var w = function (f) { return 0.0055 + f * 0.0085; };
    g.save();
    g.globalAlpha = 0.3; g.translate(6 * dpr, 9 * dpr); quad(0, 1, w(0), w(1), "#000"); g.restore();
    var grad = g.createLinearGradient(X(tx + nx * 0.01), Y(ty + ny * 0.01), X(tx - nx * 0.01), Y(ty - ny * 0.01));
    quad(0, 0.012, w(0), w(0.012), "#3d6f9e");
    quad(0.012, 0.03, w(0.012), w(0.03), "#f4f0e6");
    quad(0.03, 0.62, w(0.03), w(0.62), "#e2c58e");
    quad(0.62, 0.66, w(0.62), w(0.66), "#c9a24a");
    quad(0.66, 0.8, w(0.66), w(0.8), "#1c1c1e");
    quad(0.8, 0.99, w(0.8), w(0.99), "#5a2410");
    quad(0.99, 1, w(0.99), w(1), "#111");
    /* a line of light along the shaft */
    g.strokeStyle = "rgba(255,255,255,.28)"; g.lineWidth = 1 * dpr;
    g.beginPath(); g.moveTo(X(tx + nx * 0.002 - a.dx * 0.03), Y(ty + ny * 0.002 - a.dy * 0.03)); g.lineTo(X(bx + nx * 0.005), Y(by + ny * 0.005)); g.stroke();
    void grad;
  }

  /* ---- time ----------------------------------------------------------------- */
  function kick() { if (!raf && !gone && typeof requestAnimationFrame === "function") { lastTs = 0; raf = requestAnimationFrame(frame); } }
  function frame(ts) {
    raf = 0; if (gone) return;
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016; lastTs = ts;
    var E = PE(), busy = false;
    if (sim) {
      busy = true;
      simAcc += dt;
      var steps = 0;
      while (simAcc >= E.DT && !sim.done && steps < 1200) { sim.step(); simAcc -= E.DT; steps++; }
      /* what the balls do, on screen */
      sim.b.forEach(function (o) {
        var v = vis[o.n]; if (!v) return;
        if (v.on && !o.on) { v.potT = ts; v.pk = o.pk; sound("pot", 0.8); }
        v.x = o.x; v.y = o.y; v.on = o.on;
        var w = Math.sqrt(o.wx * o.wx + o.wy * o.wy + o.wz * o.wz);
        if (w > 1e-3 && o.on) { v.M = rotM(v.M, o.wx / w, o.wy / w, o.wz / w, w * dt); v.dirty = true; if (++v.steps % 90 === 0) v.M = orthonormal(v.M); }
      });
      var ev = sim.ev;
      while (hits0 < ev.hits.length) { sound("clack", ev.hits[hits0].v / 3); hits0++; }
      if ((ev.railHits || 0) > rails0) { sound("rail", 0.5); rails0 = ev.railHits; }
      if (sim.done) endShot();
    }
    var now = ts;
    var animating = Object.keys(vis).some(function (k) { return vis[k].potT && now - vis[k].potT < 400; }) || (strikeT && now - strikeT < 120) || !!aiShow || (callPocket != null && needCall() && myTurn());
    if (busy || animating || needDraw) { draw(now); needDraw = false; }
    if (busy || animating) raf = requestAnimationFrame(frame);
  }

  /* ---- shooting -------------------------------------------------------------- */
  function needCall() { return gs && gs.mode === "8ball" && mode !== "practice" && gs.phase !== "break" && PE().onEight(gs, gs.turn); }
  function autoCall() {
    if (!needCall() || callManual) return;
    var E = PE(), c = cuePos(), pr = E.predict(gs, c.x, c.y, aim.dx, aim.dy);
    if (pr.ball === 8) { var b8 = vis[8]; var k = E.pocketFor(b8.x, b8.y, pr.ox, pr.oy); if (k != null) callPocket = k; }
    if (callPocket == null) callPocket = 0;
  }
  function currentShot(pw) {
    var s = { dx: aim.dx, dy: aim.dy, power: pw, sx: spin.x, sy: spin.y };
    if (gs.inHand) s.cue = { x: vis[0].x, y: vis[0].y };
    if (needCall()) s.call = callPocket == null ? 0 : callPocket;
    return s;
  }
  function fire(shot, opts) {
    opts = opts || {};
    var E = PE(), base = opts.from || gs;
    var p = E.prepare(base, shot);
    if (p.error) { ui().toast(p.error.toUpperCase(), "warn"); return false; }
    if (opts.from) { gs = opts.from; syncVis(gs.balls, false); }
    syncVis(p.before, false);
    sim = p.sim; simShot = p.shot; simAcc = 0; hits0 = 0; rails0 = 0; pendingFinal = null; waitingRelay = false;
    strikeT = typeof performance !== "undefined" ? performance.now() : Date.now();
    sound("cue", 0.4 + shot.power * 0.6);
    paintHud(); kick();
    return true;
  }
  function endShot() {
    var E = PE(), done = sim, shot = simShot;
    sim = null; simShot = null;
    if (mode === "online") {
      if (pendingFinal) { applyState(pendingFinal); pendingFinal = null; }
      else { waitingRelay = true; gs = E.finish(gs, shot, done); syncVis(gs.balls, false); }
    } else {
      gs = E.finish(gs, shot, done);
      syncVis(gs.balls, false);
      afterShot();
    }
    replaying = false; callManual = false; callPocket = null;
    paintHud(); needDraw = true; kick();
  }
  function applyState(st) {
    gs = st; waitingRelay = false;
    syncVis(gs.balls, false);
    if (gs.over) sound("pot", 0.3);
    paintHud(); needDraw = true; kick();
  }
  function afterShot() {
    if (gs.over) return;
    if (mode === "ai" && gs.turn === 1) planAi();
  }
  function shootNow(pw) {
    if (!myTurn() || !gs) return;
    if (gs.inHand && !E2().placeOk(gs, vis[0].x, vis[0].y)) { ui().toast(gs.behind ? "PUT THE CUE BALL BEHIND THE LINE FIRST" : "MOVE THE CUE BALL CLEAR OF THE OTHERS", "warn"); return; }
    autoCall();
    var shot = currentShot(pw);
    if (mode === "online") {
      var before = gs, seq = match.seq;
      if (!fire(shot)) return;
      api("POST", "shot", { id: match.id, seq: seq, shot: shot }).then(function (r) {
        match.seq = r.match.seq; match.lastSeen = r.match.seq;
        if (sim) pendingFinal = r.match.state; else applyState(r.match.state);
      }).catch(function (e) {
        ui().toast(String(e.message || "the shot did not go through").toUpperCase(), "warn");
        sim = null; gs = before; syncVis(gs.balls, false); loadMatch(match.id);
      });
    } else fire(shot);
  }
  function E2() { return PE(); }

  /* ---- the computer ----------------------------------------------------------- */
  function planAi() {
    if (aiTimer) clearTimeout(aiTimer);
    aiTimer = setTimeout(function () {
      aiTimer = null;
      if (gone || mode !== "ai" || !gs || gs.over || gs.turn !== 1 || sim) return;
      var E = PE(), shot = E.aiShot(gs, level, Math.random);
      if (shot.cue) { vis[0].x = shot.cue.x; vis[0].y = shot.cue.y; vis[0].on = true; }
      if (shot.call != null) callPocket = shot.call;
      var target = { dx: shot.dx, dy: shot.dy }, from = { dx: aim.dx, dy: aim.dy }, t0 = Date.now();
      aiShow = { dir: from, pull: 0 };
      kick();
      var iv = setInterval(function () {
        if (gone || mode !== "ai") { clearInterval(iv); aiShow = null; return; }
        var f = Math.min(1, (Date.now() - t0) / 700), e = f * f * (3 - 2 * f);
        var dx = from.dx + (target.dx - from.dx) * e, dy = from.dy + (target.dy - from.dy) * e, m = Math.sqrt(dx * dx + dy * dy) || 1;
        aiShow.dir = { dx: dx / m, dy: dy / m };
        aiShow.pull = Math.max(0, (Date.now() - t0 - 700) / 500) * shot.power;
        if (Date.now() - t0 > 1250) {
          clearInterval(iv); aiShow = null; aim = { dx: shot.dx, dy: shot.dy };
          fire(shot);
        }
      }, 30);
    }, 500);
  }

  /* ---- the cue in your hand ----------------------------------------------------- */
  function toTable(e) {
    var rc = R.canvas.getBoundingClientRect();
    var E = PE(), tw = E.L + 2 * RAIL;
    var k = rc.width / tw;
    return { x: (e.clientX - rc.left) / k - RAIL, y: (e.clientY - rc.top) / k - RAIL };
  }
  function bindCanvas() {
    var cv = R.canvas; if (!cv.addEventListener) return;
    cv.addEventListener("pointermove", function (e) {
      var p = toTable(e); pointer = p;
      if (!gs) return;
      if (drag && drag.kind === "place") { drag.x = clamp(p.x, PE().R, PE().L - PE().R); drag.y = clamp(p.y, PE().R, PE().W - PE().R); needDraw = true; kick(); return; }
      if (drag && drag.kind === "pull") {
        var dx = drag.sx - p.x, dy = drag.sy - p.y, along = dx * aim.dx + dy * aim.dy;
        drag.power = clamp(along / 0.42, 0, 1); setPower(drag.power, true); needDraw = true; kick(); return;
      }
      if (!myTurn()) return;
      var c = cuePos(), ax = p.x - c.x, ay = p.y - c.y, m = Math.sqrt(ax * ax + ay * ay);
      if (m > PE().R * 1.3) { aim = { dx: ax / m, dy: ay / m }; autoCall(); needDraw = true; kick(); }
    });
    cv.addEventListener("pointerdown", function (e) {
      if (!gs || !myTurn()) return;
      var p = toTable(e), E = PE(), c = cuePos();
      if (cv.setPointerCapture && e.pointerId != null) { try { cv.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } }
      if (gs.inHand && Math.hypot(p.x - c.x, p.y - c.y) < E.R * 2.2) { drag = { kind: "place", x: c.x, y: c.y }; return; }
      /* a pocket, when calling the 8 */
      if (needCall()) {
        for (var k = 0; k < 6; k++) { var P = E.POCKETS[k]; if (Math.hypot(p.x - P.mx, p.y - P.my) < 0.09) { callPocket = k; callManual = true; needDraw = true; kick(); paintHud(); return; } }
      }
      drag = { kind: "pull", sx: p.x, sy: p.y, power: 0 };
      if (e.preventDefault) e.preventDefault();
    });
    var up = function () {
      if (!drag) return;
      var d = drag; drag = null;
      if (d.kind === "place") {
        if (PE().placeOk(gs, d.x, d.y)) { vis[0].x = d.x; vis[0].y = d.y; vis[0].on = true; }
        else ui().toast(gs.behind ? "BEHIND THE LINE, CLEAR OF THE OTHER BALLS" : "NOT THERE: IT TOUCHES ANOTHER BALL", "warn");
        needDraw = true; kick(); return;
      }
      if (d.power > 0.02) shootNow(d.power);
      needDraw = true; kick();
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", function () { drag = null; needDraw = true; kick(); });
    cv.addEventListener("contextmenu", function (e) { if (drag) { drag = null; needDraw = true; kick(); } if (e.preventDefault) e.preventDefault(); });
  }
  function onKey(e) {
    if (screen !== "table" || !gs) return;
    var tag = e.target && e.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (!myTurn()) return;
      var a = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.02 : 0.0025), c = Math.cos(a), s = Math.sin(a);
      aim = { dx: aim.dx * c - aim.dy * s, dy: aim.dx * s + aim.dy * c }; autoCall(); needDraw = true; kick(); e.preventDefault();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") { setPower(power + (e.key === "ArrowUp" ? 0.05 : -0.05)); e.preventDefault(); }
    else if (e.key === " " || e.key === "Enter") { shootNow(power); e.preventDefault(); }
    else if (e.key === "Escape" && drag) { drag = null; needDraw = true; kick(); }
  }
  function setPower(v, fromDrag) {
    power = clamp(v, 0.02, 1);
    if (R.powFill) R.powFill.style.width = Math.round(power * 100) + "%";
    if (R.powT) R.powT.textContent = "POWER " + Math.round(power * 100) + "%";
    if (!fromDrag) setPref("power", power);
  }

  /* ---- the spin picker ---------------------------------------------------------- */
  function paintSpin() {
    var cv = R.spin; if (!cv || !cv.getContext) return;
    var g = cv.getContext("2d"); if (!g) return;
    var W = cv.width, c = W / 2, r = W / 2 - 3;
    g.clearRect(0, 0, W, W);
    var gr = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
    gr.addColorStop(0, "#ffffff"); gr.addColorStop(0.7, "#e8e4d8"); gr.addColorStop(1, "#a8a496");
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(0,0,0,.25)"; g.beginPath(); g.moveTo(c - r, c); g.lineTo(c + r, c); g.moveTo(c, c - r); g.lineTo(c, c + r); g.stroke();
    g.strokeStyle = "rgba(0,0,0,.18)"; g.beginPath(); g.arc(c, c, r * 0.6, 0, Math.PI * 2); g.stroke();
    var x = c + spin.x * r * 0.62, y = c - spin.y * r * 0.62;
    g.fillStyle = "#d42a20"; g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
    if (R.spinT) {
      var v = spin.y > 0.25 ? "FOLLOW" : spin.y < -0.25 ? "DRAW" : "", h = spin.x > 0.25 ? "RIGHT" : spin.x < -0.25 ? "LEFT" : "";
      R.spinT.textContent = "SPIN: " + ((v + (v && h ? " + " : "") + h) || "CENTRE");
    }
  }
  function bindSpin() {
    var cv = R.spin; if (!cv.addEventListener) return;
    var set = function (e) {
      var rc = cv.getBoundingClientRect(), c = rc.width / 2, r = (rc.width / 2 - 3) * 0.62;
      var x = (e.clientX - rc.left - c) / r, y = -(e.clientY - rc.top - c) / r, m = Math.sqrt(x * x + y * y);
      if (m > 1) { x /= m; y /= m; }
      spin = { x: Math.round(x * 20) / 20, y: Math.round(y * 20) / 20 }; paintSpin();
    };
    var down = false;
    cv.addEventListener("pointerdown", function (e) { down = true; set(e); });
    cv.addEventListener("pointermove", function (e) { if (down) set(e); });
    cv.addEventListener("pointerup", function () { down = false; });
    cv.addEventListener("dblclick", function () { spin = { x: 0, y: 0 }; paintSpin(); });
  }

  /* ---- the heads-up line --------------------------------------------------------- */
  function paintHud() {
    if (screen !== "table" || !gs) return;
    var E = PE(), nm = names();
    for (var p = 0; p < 2; p++) {
      var pl = R.plates[p], g = gs.groups[p], active = !gs.over && gs.turn === p && mode !== "practice";
      pl.box.className = "ph-plate" + (active ? " on" : "") + (gs.over && gs.winner === p ? " win" : "") + (mode === "practice" && p === 1 ? " gone" : "");
      pl.name.textContent = nm[p] || "";
      var nine = gs.mode === "9ball";
      pl.grp.textContent = gs.over && gs.winner === p ? "WINNER" : nine ? (gs.phase === "break" ? (active ? "TO BREAK" : "") : active ? "ON THE " + E.lowest(gs) : (gs.pots[p] || 0) + " POTTED")
        : g ? groupName(g) + (E.onEight(gs, p) ? " · ON THE 8" : "") : gs.phase === "break" ? (active ? "TO BREAK" : "") : "OPEN TABLE";
      for (var n = 1; n <= 15; n++) {
        var chip = pl.chips[n], mineK = nine ? n <= 9 && p === 0 : g ? E.kind(n) === g : false, b = gs.balls.filter(function (x) { return x.n === n; })[0];
        chip.className = "ph-chip" + (n > 8 ? " st" : "") + (mineK ? "" : " hide") + (b && !b.on ? " down" : "");
      }
    }
    var turnName = nm[gs.turn];
    var hint = "";
    if (gs.over) hint = mode === "online" ? "Match over." : "Game over. NEW GAME for another.";
    else if (sim) hint = replaying ? "Watching " + turnName + "'s shot…" : "";
    else if (waitingRelay) hint = "Waiting for the relay…";
    else if (mode === "ai" && gs.turn === 1) hint = "The computer is lining up…";
    else if (mode === "online" && !myTurn()) hint = "Waiting for " + turnName + " to shoot. You can leave and come back.";
    else {
      hint = (mode === "hot" ? turnName + ": " : "YOUR SHOT. ") + (gs.inHand ? "Drag the cue ball to place it" + (gs.behind ? " behind the line" : "") + ", then " : "") + "aim with the mouse, press and pull back, let go to shoot.";
      if (needCall()) hint += " Calling the 8 for the " + E.POCKETS[callPocket == null ? 0 : callPocket].name.toLowerCase() + " pocket: click a pocket to change.";
    }
    R.msg.textContent = gs.msg || "";
    R.msg.className = "ph-msg" + (gs.foul ? " foul" : "") + (gs.over ? " over" : "");
    R.hint.textContent = hint;
    R.again.style.display = gs.over && mode !== "online" ? "" : "none";
    R.rerack.style.display = mode === "practice" ? "" : "none";
    R.resign.style.display = mode === "online" && !gs.over ? "" : "none";
    R.rematch.style.display = mode === "online" && gs.over ? "" : "none";
  }

  /* ---- screens ------------------------------------------------------------------ */
  function clear() { if (host) { while (host.firstChild) host.removeChild(host.firstChild); } R = {}; }
  function css() {
    if (document.getElementById("ph-css")) return;
    var s = document.createElement("style"); s.id = "ph-css";
    s.textContent = [
      ".ph-root{position:absolute;inset:0;display:flex;flex-direction:column;background:radial-gradient(ellipse at 50% 30%,#1b1712,#0a0907 70%);color:var(--fg);font-size:12px;overflow:hidden}",
      ".ph-top{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line)}",
      ".ph-logo{letter-spacing:.32em;color:#ffd27a;font-weight:bold}.ph-sub{color:var(--fg-dimmer);letter-spacing:.12em;font-size:10px;flex:1}",
      ".ph-home{flex:1;overflow:auto;padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;align-content:start}",
      ".ph-card{border:1px solid var(--line2);background:rgba(0,0,0,.35);padding:14px;display:flex;flex-direction:column;gap:9px}",
      ".ph-card h3{margin:0;letter-spacing:.2em;font-size:12px;color:#ffd27a}.ph-card p{margin:0;color:var(--fg-dim);line-height:1.5;font-size:11px}",
      ".ph-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ph-wide{grid-column:1/-1}",
      ".ph-list{display:flex;flex-direction:column;gap:4px}.ph-item{display:flex;gap:8px;align-items:center;border:1px solid var(--line);padding:6px 8px;background:rgba(0,0,0,.25)}",
      ".ph-item .t{flex:1}.ph-item.turn{border-color:#ffd27a}.ph-badge{font-size:9px;letter-spacing:.14em;padding:2px 6px;border:1px solid currentColor}.ph-badge.go{color:#ffd27a}.ph-badge.win{color:#6fdc90}.ph-badge.loss{color:#ff7a6a}",
      ".ph-note{font-size:10px;color:var(--fg-dimmer);line-height:1.5}.ph-h{font-size:10px;letter-spacing:.18em;color:var(--fg-dim);margin-top:4px}",
      ".ph-table{flex:1;display:flex;flex-direction:column;align-items:center;padding:8px 12px;gap:7px;min-height:0}",
      ".ph-hud{display:flex;gap:10px;width:100%;align-items:stretch}.ph-plate{flex:1;border:1px solid var(--line);padding:6px 10px;background:rgba(0,0,0,.35);transition:border-color .2s,box-shadow .2s}",
      ".ph-plate.on{border-color:#ffd27a;box-shadow:0 0 14px rgba(255,210,122,.25)}.ph-plate.win{border-color:#6fdc90}.ph-plate.gone{visibility:hidden}",
      ".ph-plate .n{font-weight:bold;letter-spacing:.1em;font-size:13px}.ph-plate .g{font-size:10px;letter-spacing:.14em;color:var(--fg-dim);margin:2px 0 4px}.ph-plate.on .g{color:#ffd27a}",
      ".ph-ladder{display:flex;flex-direction:column;gap:2px}.ph-lrow{display:grid;grid-template-columns:34px 1fr 52px 56px 40px 104px;align-items:center;gap:6px;padding:3px 6px;border:1px solid rgba(255,210,122,.12);background:rgba(0,0,0,.25)}" +
      ".ph-lrow.me{border-color:#ffd27a;background:rgba(255,210,122,.08)}.ph-lrow .n{opacity:.7}.ph-lrow .r{color:#ffd27a;font-weight:bold;text-align:right}.ph-lrow .wl{opacity:.8;text-align:right}.ph-lrow .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ph-chips{display:flex;gap:3px;flex-wrap:wrap}.ph-chip{width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:bold;color:#111;box-shadow:inset -2px -2px 3px rgba(0,0,0,.35)}",
      ".ph-chip.hide{display:none}.ph-chip.down{opacity:.18}.ph-chip span{background:#fff;border-radius:50%;width:9px;height:9px;display:flex;align-items:center;justify-content:center;line-height:1}",
      ".ph-mid{flex:1.6;display:flex;flex-direction:column;justify-content:center;text-align:center;gap:3px}",
      ".ph-msg{font-size:13px;letter-spacing:.04em}.ph-msg.foul{color:#ff8a6a}.ph-msg.over{color:#ffd27a;font-weight:bold}.ph-hint{font-size:10px;color:var(--fg-dimmer)}",
      ".ph-canvasbox{width:100%;display:flex;justify-content:center;flex:1;min-height:0}.ph-canvas{display:block;touch-action:none;cursor:crosshair;border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.6)}",
      ".ph-bar{display:flex;gap:14px;align-items:center;width:100%;flex-wrap:wrap}.ph-spin{width:64px;height:64px;cursor:pointer;touch-action:none}",
      ".ph-pow{width:200px;height:12px;border:1px solid var(--line2);background:rgba(0,0,0,.4);position:relative;cursor:pointer}",
      ".ph-powfill{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#5fdc90,#ffd27a 60%,#ff6a4a)}",
      ".ph-lbl{font-size:10px;letter-spacing:.14em;color:var(--fg-dim)}.ph-grow{flex:1}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function shell(sub) {
    clear();
    var root = el("div", { class: "ph-root", tabindex: "0" });
    var top = el("div", { class: "ph-top" }, [el("span", { class: "ph-logo", text: "POOL HALL" }), R.sub = el("span", { class: "ph-sub", text: sub || "" })]);
    root.appendChild(top);
    host.appendChild(root);
    R.root = root; R.topBar = top;
    root.addEventListener("keydown", onKey);
    return root;
  }

  /* the home screen: how to play, and the online lobby */
  function showHome() {
    stopMatch();
    screen = "home"; mode = null; gs = null; match = null; vis = {};
    var root = shell(gameTitle(gameOf()) + " · NINE-FOOT TABLE");
    var home = el("div", { class: "ph-home" });
    var gameRow = el("div", { class: "ph-row" });
    ["8ball", "9ball"].forEach(function (g) {
      gameRow.appendChild(ui().button(gameTitle(g), function () { setPref("game", g); showHome(); }, { primary: g === gameOf() }));
    });
    home.appendChild(el("div", { class: "ph-card ph-wide" }, [el("h3", { text: "WHICH GAME" }),
      el("p", { text: gameOf() === "9ball" ? "Nine-ball: always hit the lowest ball first. Pot the 9 without a foul to win, even off another ball, even on the break." : "Eight-ball: solids or stripes, then the 8 in the pocket you call." }),
      gameRow]));
    var lv = el("div", { class: "ph-row" });
    ["easy", "normal", "hard"].forEach(function (l) {
      lv.appendChild(ui().button(l.toUpperCase(), function () { level = l; setPref("level", l); startLocal("ai"); }, { primary: l === (prefs().level || "normal") }));
    });
    home.appendChild(el("div", { class: "ph-card" }, [el("h3", { text: "PLAY THE COMPUTER" }), el("p", { text: "You break. Pick how good it is: EASY misses often, HARD rarely does." }), lv]));
    home.appendChild(el("div", { class: "ph-card" }, [el("h3", { text: "TWO PLAYERS HERE" }), el("p", { text: "Pass the mouse: the table says whose shot it is." }), el("div", { class: "ph-row" }, [ui().button("START", function () { startLocal("hot"); }, { primary: true })])]));
    home.appendChild(el("div", { class: "ph-card" }, [el("h3", { text: "PRACTICE" }), el("p", { text: "No rules, no turns. Try draw, follow and side spin." }), el("div", { class: "ph-row" }, [ui().button("RACK THEM", function () { startLocal("practice"); }, { primary: true })])]));
    R.online = el("div", { class: "ph-card ph-wide" });
    home.appendChild(R.online);
    home.appendChild(el("div", { class: "ph-card ph-wide" }, [el("h3", { text: "HOW TO PLAY" }), el("p", { text: "Move over the table to aim. Press, pull back for power and let go to shoot (or set the bar and press Space). Arrow keys fine-tune the aim. Click the small cue ball to hit it high (follow), low (draw) or on a side. The dashed line shows where the cue ball meets the first ball, the yellow line where that ball goes and the blue line where the cue ball goes after." }),
      el("p", { text: "Nine-ball: only balls 1 to 9. The cue ball must hit the lowest ball on the table first; after that, anything you pot keeps your turn. Pot the 9 on a legal shot and you win, on the break or off another ball. A foul gives the other player ball in hand anywhere, and a 9 potted on a foul comes back up." }),
      el("p", { text: "Eight-ball: after the break the table is open; the first ball you pot makes you SOLIDS (1-7) or STRIPES (9-15). Pot all of yours, then the 8 in the pocket you call. A foul (scratch, hitting the wrong ball first, or no ball reaching a cushion) gives the other player ball in hand. Potting the 8 early, or scratching on it, loses." }),
      el("div", { class: "ph-row" }, [R.snd = ui().button(prefs().sound === false ? "SOUND: OFF" : "SOUND: ON", function () { var on = prefs().sound === false; setPref("sound", on); R.snd.textContent = on ? "SOUND: ON" : "SOUND: OFF"; })])]));
    root.appendChild(home);
    paintOnline(true);
    refreshLobby();
    lobbyTimer = setInterval(function () { if (!document.hidden && screen === "home") refreshLobby(); }, 6000);
  }

  function paintOnline(force) {
    var box = R.online; if (!box) return;
    var s = session(), base = relayBase();
    var key = (s ? s.tag : "-") + "|" + (base ? 1 : 0) + "|" + sig(lastLobby);
    if (!force && key === lobbySig) return;
    lobbySig = key;
    if (!base) { clearNode(box); box.appendChild(el("h3", { text: "PLAY FRIENDS ONLINE" })); box.appendChild(el("p", { text: "Needs a relay: add one in RELAY LINK, then come back." })); return; }
    if (!s) {
      if (R.signForm && R.signForm.parentNode === box) return;
      clearNode(box);
      box.appendChild(el("h3", { text: "PLAY FRIENDS ONLINE" }));
      box.appendChild(el("p", { text: "Sign in with a gamertag. It is the same one DEEPHOLD uses; if you have one, use it." }));
      var tag = ui().field("GAMERTAG", { placeholder: "3 to 20 letters" }), pw = ui().field("PASSWORD", { type: "password" });
      var keep = el("input", { type: "checkbox" }); keep.checked = true;
      var go = async function (what) {
        try {
          var r = await api("POST", what, { tag: tag.input.value, password: pw.input.value }, "colony");
          pw.input.value = "";
          adopt({ token: r.token, tag: r.tag }, keep.checked);
          R.signForm = null; paintOnline(true); refreshLobby();
        } catch (e) { pw.input.value = ""; ui().toast(String(e.message || "could not sign in").toUpperCase(), "warn"); }
      };
      pw.input.addEventListener("keydown", function (e) { if (e.key === "Enter") go("login"); });
      R.signForm = el("div", { class: "ph-list" }, [el("div", { class: "ph-row" }, [tag, pw]), el("label", { class: "ph-note" }, [keep, document.createTextNode(" keep me signed in on this computer")]),
        el("div", { class: "ph-row" }, [ui().button("SIGN IN", function () { go("login"); }, { primary: true }), ui().button("CREATE GAMERTAG", function () { go("register"); })])]);
      box.appendChild(R.signForm);
      return;
    }
    /* signed in: the inputs are made once and kept */
    if (!R.lob || R.lob.parentNode !== box) {
      clearNode(box);
      R.signForm = null;
      R.who = el("span", { class: "ph-note" });
      R.toInput = ui().field("CHALLENGE A GAMERTAG", { placeholder: "their gamertag" });
      R.toInput.input.addEventListener("keydown", function (e) { if (e.key === "Enter") challenge(R.toInput.input.value); });
      R.lob = el("div", { class: "ph-list" });
      box.appendChild(el("div", { class: "ph-row" }, [el("h3", { class: "ph-grow", text: "PLAY FRIENDS ONLINE" }), R.who, ui().button("SIGN OUT", function () { dropSession(); lastLobby = null; paintOnline(true); })]));
      box.appendChild(el("div", { class: "ph-row" }, [R.toInput, ui().button("CHALLENGE", function () { challenge(R.toInput.input.value); }, { primary: true }), ui().button("OPEN CHALLENGE (ANYONE)", function () { challenge(""); })]));
      box.appendChild(el("div", { class: "ph-note", text: "Challenges are for " + gameTitle(gameOf()).toLowerCase() + ", the game picked above." }));
      box.appendChild(R.lob);
    }
    var L = lastLobby;
    var rec = L && L.record;
    R.who.textContent = s.tag + (rec ? "  ·  " + (typeof rec.r === "number" ? "RATING " + rec.r + "  ·  " : "") + rec.w + " WON " + rec.l + " LOST" +
      (rec.s >= 2 ? "  ·  " + rec.s + " IN A ROW" : "") + (L.ladder && L.ladder.rank ? "  ·  #" + L.ladder.rank + " OF " + L.ladder.of : "") : "");
    clearNode(R.lob);
    if (!L) { R.lob.appendChild(el("div", { class: "ph-note", text: "Asking the relay…" })); return; }
    if (L.up === false) { R.lob.appendChild(el("div", { class: "ph-note", text: "This relay does not run POOL HALL yet." })); return; }
    var sect = function (title, items) { if (!items.length) return; R.lob.appendChild(el("div", { class: "ph-h", text: title })); items.forEach(function (x) { R.lob.appendChild(x); }); };
    sect("CHALLENGES FOR YOU", L.invites.map(function (m) {
      return el("div", { class: "ph-item turn" }, [el("span", { class: "t", text: m.names[0] + " challenges you to " + gameTitle(m.game).toLowerCase() }), ui().button("ACCEPT", function () { accept(m.id); }, { primary: true }), ui().button("DECLINE", function () { simple("decline", m.id); })]);
    }));
    sect("YOUR MATCHES", L.matches.map(function (m) {
      var opp = m.names[1 - m.seat] || "?", over = m.status === "over";
      var dl = typeof m.delta === "number" ? " " + (m.delta > 0 ? "+" : "") + m.delta : "";
      var badge = over ? (m.winner === m.seat ? el("span", { class: "ph-badge win", text: "WON" + dl }) : m.winner == null ? el("span", { class: "ph-badge", text: "OFF" }) : el("span", { class: "ph-badge loss", text: "LOST" + dl }))
        : m.yourTurn ? el("span", { class: "ph-badge go", text: "YOUR TURN" }) : el("span", { class: "ph-badge", text: "THEIR TURN" });
      var grp = m.groups && m.groups[m.seat] ? " · you have " + groupName(m.groups[m.seat]).toLowerCase() + (m.left ? " (" + m.left[m.seat] + " left, they have " + m.left[1 - m.seat] + ")" : "") : "";
      return el("div", { class: "ph-item" + (m.yourTurn ? " turn" : "") }, [el("span", { class: "t", text: (m.game === "9ball" ? "9-ball " : "") + "vs " + opp + grp }), badge, ui().button(over ? "LOOK" : "PLAY", function () { openMatch(m.id); }, { primary: !!m.yourTurn })]);
    }));
    sect("OPEN CHALLENGES: ANYONE CAN TAKE ONE", L.open.map(function (m) {
      return el("div", { class: "ph-item" }, [el("span", { class: "t", text: m.names[0] + " wants a game of " + gameTitle(m.game).toLowerCase() }), ui().button("PLAY THEM", function () { accept(m.id); }, { primary: true })]);
    }));
    sect("WAITING FOR AN ANSWER", L.sent.map(function (m) {
      return el("div", { class: "ph-item" }, [el("span", { class: "t", text: m.to ? "You challenged " + m.to : "Your open challenge" }), ui().button("CANCEL", function () { simple("cancel", m.id); })]);
    }));
    if (L.online.length) {
      R.lob.appendChild(el("div", { class: "ph-h", text: "IN THE HALL NOW" }));
      var row = el("div", { class: "ph-row" });
      L.online.forEach(function (t) { row.appendChild(el("button", { class: "fk-btn", type: "button", text: t, title: "Challenge " + t, onclick: function () { R.toInput.input.value = t; } })); });
      R.lob.appendChild(row);
    }
    if (L.ladder && L.ladder.top && L.ladder.top.length) {
      R.lob.appendChild(el("div", { class: "ph-h", text: "THE LADDER" }));
      var tb = el("div", { class: "ph-ladder" });
      L.ladder.top.forEach(function (x) {
        tb.appendChild(el("div", { class: "ph-lrow" + (x.me ? " me" : "") }, [
          el("span", { class: "n", text: "#" + x.n }), el("span", { class: "t", text: x.tag }),
          el("span", { class: "r", text: String(x.r) }), el("span", { class: "wl", text: x.w + "–" + x.l }),
          el("span", { class: "s", text: x.s >= 2 ? "🔥" + x.s : "" }),
          x.me ? el("span", { class: "c" }) : el("button", { class: "fk-btn", type: "button", text: "CHALLENGE", onclick: function () { challenge(x.tag); } })
        ]));
      });
      R.lob.appendChild(tb);
      if (L.ladder.rank && L.ladder.rank > L.ladder.top.length) R.lob.appendChild(el("div", { class: "ph-note", text: "You are #" + L.ladder.rank + " of " + L.ladder.of + ". Beat someone above you to climb." }));
    }
    if (!L.invites.length && !L.matches.length && !L.open.length && !L.sent.length) R.lob.appendChild(el("div", { class: "ph-note", text: "No games yet. Challenge a friend by gamertag, or post an open challenge that anyone can take." }));
  }
  function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  async function refreshLobby() {
    if (!session() || !relayBase()) { paintOnline(); return; }
    try { lastLobby = await api("GET", "lobby"); } catch (e) { if (e.status === 404) lastLobby = { up: false, invites: [], matches: [], open: [], sent: [], online: [] }; }
    if (screen === "home") paintOnline();
  }
  async function challenge(to, game) {
    try { await api("POST", "challenge", { to: String(to || "").trim() || null, game: game || gameOf() }); if (R.toInput) R.toInput.input.value = ""; ui().toast(to ? "CHALLENGE SENT TO " + String(to).toUpperCase() : "OPEN CHALLENGE POSTED", "ok"); refreshLobby(); }
    catch (e) { ui().toast(String(e.message).toUpperCase(), "warn"); }
  }
  async function accept(id) {
    try { var r = await api("POST", "accept", { id: id }); openMatch(r.match.id, r.match); }
    catch (e) { ui().toast(String(e.message).toUpperCase(), "warn"); refreshLobby(); }
  }
  async function simple(what, id) {
    try { await api("POST", what, { id: id }); } catch (e) { ui().toast(String(e.message).toUpperCase(), "warn"); }
    refreshLobby();
  }

  /* the table screen */
  function showTable(sub) {
    if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
    screen = "table";
    var root = shell(sub);
    R.topBar.appendChild(ui().button("◀ HALL", function () { showHome(); }));
    var t = el("div", { class: "ph-table" });
    R.plates = [];
    var plate = function () {
      var p = { name: el("div", { class: "n" }), grp: el("div", { class: "g" }), chips: {} };
      var chips = el("div", { class: "ph-chips" });
      for (var n = 1; n <= 15; n++) {
        var c = COL[n > 8 ? n - 8 : n], chip = el("span", { class: "ph-chip", title: String(n) }, [el("span", { text: String(n) })]);
        chip.style.background = n > 8 ? "linear-gradient(#f4f0e6 0 28%," + rgb(c, 1) + " 28% 72%,#f4f0e6 72%)" : rgb(c, 1);
        p.chips[n] = chip; chips.appendChild(chip);
      }
      p.box = el("div", { class: "ph-plate" }, [p.name, p.grp, chips]);
      R.plates.push(p); return p.box;
    };
    R.msg = el("div", { class: "ph-msg" }); R.hint = el("div", { class: "ph-hint" });
    var a = plate(), mid = el("div", { class: "ph-mid" }, [R.msg, R.hint]), b = plate();
    t.appendChild(el("div", { class: "ph-hud" }, [a, mid, b]));
    R.canvas = el("canvas", { class: "ph-canvas", width: "900", height: "480" });
    t.appendChild(el("div", { class: "ph-canvasbox" }, [R.canvas]));
    R.spin = el("canvas", { class: "ph-spin", width: "128", height: "128" });
    R.spinT = el("div", { class: "ph-lbl" });
    R.powFill = el("div", { class: "ph-powfill" }); R.powT = el("div", { class: "ph-lbl" });
    var pow = el("div", { class: "ph-pow", title: "Click to set the power for SPACE / SHOOT" }, [R.powFill]);
    pow.addEventListener("pointerdown", function (e) { var rc = pow.getBoundingClientRect(); setPower((e.clientX - rc.left) / rc.width); });
    R.again = ui().button("NEW GAME", function () { startLocal(mode); }, { primary: true });
    R.rerack = ui().button("RE-RACK", function () { startLocal("practice"); });
    R.resign = ui().button("CONCEDE", function () { if (ctx.confirm ? ctx.confirm("Concede this match?") : true) simple("resign", match.id).then(function () { loadMatch(match.id); }); });
    R.rematch = ui().button("REMATCH", function () { var opp = gs.names[1 - match.seat]; challenge(opp, gs.mode); showHome(); }, { primary: true });
    t.appendChild(el("div", { class: "ph-bar" }, [
      el("div", { class: "ph-row" }, [R.spin, el("div", {}, [R.spinT, el("div", { class: "ph-note", text: "click the ball to set spin; double-click to centre" })])]),
      el("div", {}, [R.powT, pow, el("div", { class: "ph-note", text: "or press on the table and pull back" })]),
      ui().button("SHOOT", function () { shootNow(power); }), el("span", { class: "ph-grow" }), R.again, R.rerack, R.resign, R.rematch
    ]));
    root.appendChild(t);
    bindCanvas(); bindSpin(); paintSpin(); setPower(prefs().power || 0.45, true);
    setTimeout(function () { if (!gone && screen === "table") { fit(); if (R.root.focus) R.root.focus(); } }, 0);
  }

  function startLocal(m) {
    stopMatch();
    mode = m; level = prefs().level || level;
    var E = PE(), seed = Math.floor(Math.random() * 4294967296);
    gs = E.newGame(seed, m === "practice" ? "practice" : gameOf(), names());
    if (m === "practice") gs.msg = "Practice: shoot as you like. Scratch and you place the cue ball again.";
    if (m === "ai") gs.msg = "You break. Place the cue ball behind the line, then shoot.";
    vis = {}; syncVis(gs.balls, true);
    aim = { dx: 1, dy: 0 }; spin = { x: 0, y: 0 }; callPocket = null; callManual = false;
    showTable(m === "ai" ? gameTitle(gs.mode) + " AGAINST THE COMPUTER · " + level.toUpperCase() : m === "hot" ? gameTitle(gs.mode) + " · TWO PLAYERS, ONE SCREEN" : "PRACTICE");
    paintHud();
  }

  /* ---- online matches -------------------------------------------------------- */
  function stopMatch() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; } aiShow = null; sim = null; }
  async function openMatch(id, given) {
    stopMatch();
    mode = "online"; match = { id: id, seat: 0, seq: -1 }; gs = null; vis = {};
    showTable("ONLINE MATCH");
    if (given) take(given, true); else await loadMatch(id, true);
    pollTimer = setInterval(function () { if (!document.hidden && !sim && screen === "table" && mode === "online") loadMatch(id); }, 1800);
  }
  async function loadMatch(id, first) {
    try { var r = await api("GET", "match?id=" + encodeURIComponent(id)); take(r.match, first); }
    catch (e) { if (first) { ui().toast(String(e.message).toUpperCase(), "warn"); showHome(); } }
  }
  function take(m, first) {
    if (!m || !match || m.id !== match.id) return;
    if (!m.state) { if (R.msg) R.msg.textContent = "Waiting for them to accept."; return; }
    var prev = match.seq;
    match.seat = m.seat; match.status = m.status;
    if (R.sub) R.sub.textContent = "ONLINE · " + m.names[0] + " vs " + m.names[1];
    if (m.seq === prev) return;
    match.seq = m.seq;
    /* their shot, played again from the same table */
    if (!first && m.last && m.last.seq === prev && m.last.by !== m.seat && gs) {
      replaying = true;
      pendingFinal = null;
      if (fire(m.last.shot, { from: m.last.state })) { pendingFinal = m.state; return; }
    }
    applyState(m.state);
    if (first) { syncVis(gs.balls, true); }
    if (!first && m.state.over) sound("pot", 0.4);
  }

  /* ---- notices while the hall is closed ---------------------------------------- */
  var known = null;
  async function backgroundCheck() {
    if (!session() || !relayBase() || document.hidden) return;
    var L;
    try { L = await api("GET", "lobby"); } catch (e) { return; }
    var now = {};
    L.invites.forEach(function (m) { now["i" + m.id] = m.names[0]; });
    L.matches.forEach(function (m) { if (m.yourTurn) now["t" + m.id + ":" + m.seq] = m.names[1 - m.seat]; });
    if (known) Object.keys(now).forEach(function (k) {
      if (known[k] || (screen === "table" && match && k.indexOf("t" + match.id) === 0)) return;
      if (k[0] === "i") ui().toast("POOL HALL: " + now[k] + " challenged you to a game", "info");
      else ui().toast("POOL HALL: your shot against " + now[k], "info");
    });
    known = now;
    if (screen === "home") { lastLobby = L; paintOnline(); }
  }
  if (typeof setInterval === "function") bgTimer = setInterval(backgroundCheck, 60000);
  if (typeof setTimeout === "function") setTimeout(backgroundCheck, 9000);

  /* ---- self checks ------------------------------------------------------------- */
  function selfcheck() {
    return [
      { name: "THE ENGINE IS LOADED", critical: true, run: function () { if (!PE()) throw new Error("core/pool-engine.js did not load"); return "pool-engine ready"; } },
      { name: "A SHOT PLAYS THE SAME TWICE", critical: false, run: function () {
        var E = PE(), g = E.newGame(5, "8ball"), shot = { dx: 1, dy: 0.01, power: 0.9, cue: { x: E.HEAD - 0.12, y: E.W / 2 } };
        var a = E.play(g, shot).state.balls, b = E.play(g, shot).state.balls;
        if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("the same shot ended differently");
        return "break replays exactly";
      } }
    ];
  }

  FieldKit.provide("poolHall", {
    _state: function () { return { screen: screen, mode: mode, gs: gs, match: match, sim: !!sim, aim: aim, spin: spin, power: power, call: callPocket }; },
    _shoot: function (shot) { if (shot) { aim = { dx: shot.dx, dy: shot.dy }; if (shot.sx != null) spin = { x: shot.sx, y: shot.sy || 0 }; if (shot.cue && vis[0]) { vis[0].x = shot.cue.x; vis[0].y = shot.cue.y; } } shootNow(shot && shot.power != null ? shot.power : power); },
    _finishNow: function () { while (sim && !sim.done) sim.step(); if (sim) endShot(); },
    _open: openMatch, _start: startLocal, _home: function () { showHome(); }, _lobby: function () { return lastLobby; }, _refresh: refreshLobby, _api: api, _check: backgroundCheck
  });

  FieldKit.register("pool", {
    title: "POOL HALL",
    icon: "●",
    group: "ONLINE",
    about: "Eight-ball: play the computer, a friend here, or friends online",
    keywords: "game pool billiards eight ball 8ball snooker cue play friends multiplayer challenge",
    width: 1060,
    height: 760,
    guestSafe: true,
    selfcheck: selfcheck,
    async mount(h, context) {
      ctx = context; el = ctx.ui.el; host = h; gone = false;
      css();
      level = prefs().level || "normal";
      showHome();
      onResize = function () { if (screen === "table") fit(); };
      window.addEventListener("resize", onResize);
      if (typeof ResizeObserver === "function") { ro = new ResizeObserver(function () { if (screen === "table") fit(); }); ro.observe(host); }
    },
    unmount() {
      gone = true;
      stopMatch();
      if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      raf = 0;
      try { window.removeEventListener("resize", onResize); if (ro) ro.disconnect(); } catch (e) { /* fine */ }
      ro = null; onResize = null;
      host = null; R = {}; screen = ""; gs = null; vis = {};
    }
  });
})(window.FieldKit);
