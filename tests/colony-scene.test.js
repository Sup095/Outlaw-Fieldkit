/* ============================================================
   core/colony-scene.js + core/colony-sprites.js — DEEPHOLD's picture

   What matters:
     1. The same colony always looks the same, and two colonies do not.
     2. Every plot is inside the picture, layers go down, and every
        room can be walked to from the surface.
     3. The little people move along the tunnels and never leave them.
     4. A click lands on the plot that was drawn there.
     5. Every building and every stage of the picture draws without an
        error, on a canvas that records what was asked of it.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/colony-sprites.js", "core/colony-scene.js"]);
const { ok, section, state } = makeRunner("colony-scene");
const S = FieldKit.need("colonyScene");
const SP = FieldKit.need("colonySprites");
const E = require("../relay/colony-engine");

/* a 2D context that does nothing but count, and fails on a bad number */
function fakeCtx(log) {
  const target = { canvas: null };
  const special = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: (...a) => { if (a.some((v) => !Number.isFinite(v))) log.bad.push("gradient " + a.join(",")); return { addColorStop() {} }; },
    createPattern: () => ({}),
    measureText: (t) => ({ width: String(t).length * 5 })
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in special) return special[k];
      if (k in t) return t[k];
      return (...a) => {
        log.calls++;
        if ((k === "fillRect" || k === "drawImage" || k === "arc" || k === "moveTo" || k === "lineTo") && a.some((v) => typeof v === "number" && !Number.isFinite(v))) log.bad.push(String(k) + " " + a.join(","));
      };
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}
function fakeCanvas(log) {
  const c = { width: 0, height: 0, style: {}, getContext: () => { const g = fakeCtx(log); g.canvas = c; return g; }, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: S.W, height: S.VH }) };
  return c;
}
const log = { calls: 0, bad: [] };
document.createElement = ((orig) => (t) => (String(t).toLowerCase() === "canvas" ? fakeCanvas(log) : orig(t)))(document.createElement);

/* a view the way the relay sends it */
function viewOf(biome, stage, fill) {
  const T0 = 1e12;
  const w = E.newWorld(T0);
  w.civ.stage = stage;
  w.colonies.a = E.newColony("a", biome, "Test Hold", T0);
  const c = w.colonies.a;
  c.layers = Math.min(E.layerCap(w.civ), 6);
  c.stock.ore = 1e6; c.stock.parts = 1e6;
  if (fill) {
    const ids = Object.keys(E.B).filter((id) => E.B[id].stage <= stage && (!E.B[id].biomes || E.B[id].biomes.includes(biome)));
    let i = 0;
    for (let l = 0; l < c.layers; l++) for (let s = 0; s < 8; s++) if (!c.grid[l][s]) { c.repair = 100; E.build(w, c, l, s, ids[i++ % ids.length], T0); }
  }
  c.dig = { start: T0, done: T0 + 60000 };
  c.lastSeen = T0;
  E.stepWorld(w, T0 + 5000);
  return E.viewFor(w, T0 + 5000, "a", true);
}

section("the same colony always looks the same");
{
  const a = S.layoutFor({ seed: "Deep Haven|seam", layers: 4 });
  const b = S.layoutFor({ seed: "Deep Haven|seam", layers: 4 });
  const c = S.layoutFor({ seed: "Other Hold|seam", layers: 4 });
  const shape = (G) => JSON.stringify(G.layers.map((L) => [L.sx, L.ty, L.rooms.map((r) => [r.x, r.y, r.w, r.h])]));
  ok("one name, one shape", shape(a) === shape(b));
  ok("another name, another shape", shape(a) !== shape(c));
  ok("the tunnels are not one straight line per level", a.layers.some((L) => L.pts && new Set(L.pts.map((p) => p[1])).size > 2) && new Set(a.layers.map((L) => L.sx)).size > 1);
  ok("the hash is stable", S.hash32("x") === S.hash32("x") && S.hash32("x") !== S.hash32("y"));
}

section("every plot is in the picture, and can be reached");
{
  let fine = true, reach = true, order = true;
  for (let n = 1; n <= S.MAXL; n++) {
    for (const name of ["A", "Bee", "Old Fort", "zz top"]) {
      const G = S.layoutFor({ seed: name, layers: n, dig: n < S.MAXL ? { frac: 0.5 } : null });
      if (G.layers.length !== Math.min(S.MAXL, n + (n < S.MAXL ? 1 : 0))) fine = false;
      G.layers.forEach((L, l) => {
        if (L.rooms.length !== E.SLOTS) fine = false;
        L.rooms.forEach((r) => { if (r.x < 0 || r.x + r.w > S.W || r.y < S.GROUND || r.y + r.h > G.h) fine = false; });
        if (l > 0 && L.ty <= G.layers[l - 1].ty) order = false;
        if (l < G.open) L.rooms.forEach((r) => { if (!S.pathBetween(G, G.top, r.door)) reach = false; });
      });
    }
  }
  ok("eight plots on every layer, all inside the picture", fine);
  ok("each layer is deeper than the one above", order);
  ok("every open room can be walked to from the surface", reach);
  ok("no way is found to a place that does not exist", S.pathBetween({ adj: [[1], [0], []] }, 0, 2) === null);
}

section("the little people stay in the tunnels");
{
  const G = S.layoutFor({ seed: "walkers", layers: 3 });
  const crowd = new S.Crowd(G, { seed: 3 });
  const places = [];
  G.layers.forEach((L, l) => L.rooms.forEach((r, s) => places.push({ layer: l, slot: s, kind: ["job", "eat", "fun", "home", "lift"][s % 5], staff: 1, type: "drill" })));
  crowd.setPlaces(places, 20);
  ok("there are as many as asked", crowd.list.length === 20);
  crowd.setPlaces(places, 500);
  ok("but never a crowd too big to draw", crowd.list.length === 60);
  crowd.setPlaces(places, 20);
  let inside = true, moved = 0;
  const start = crowd.list.map((w) => [w.x, w.y]);
  for (let i = 0; i < 2000; i++) {
    crowd.step(1 / 30);
    for (const w of crowd.list) if (!(Number.isFinite(w.x) && Number.isFinite(w.y)) || w.x < -2 || w.x > S.W + 2 || w.y < S.GROUND - 30 || w.y > G.h + 2) inside = false;
  }
  crowd.list.forEach((w, i) => { if (Math.hypot(w.x - start[i][0], w.y - start[i][1]) > 4) moved++; });
  ok("they stay inside the colony", inside);
  ok("and they actually go places", moved >= 10, moved + " of 20");
  crowd.setLayout(S.layoutFor({ seed: "walkers", layers: 4 }));
  ok("a new layer does not lose anyone", crowd.list.length === 20 && crowd.list.every((w) => Number.isFinite(w.x)));
}

section("the ground is carved where the rooms are");
{
  const G = S.layoutFor({ seed: "dirt", layers: 2, dig: { frac: 0.3 } });
  const open = S.buildChunk(G, 0, "seam", "open", 0, 0);
  const part = S.buildChunk(G, 2, "seam", "partial", 0.3, 0);
  const solid = S.buildChunk(G, 2, "seam", "solid", 0, 0);
  const holes = (d) => d.mask.reduce((n, v) => n + (v ? 1 : 0), 0);
  ok("a chunk is a full picture", open.rgba.length === open.w * open.h * 4 && open.mask.length === open.w * open.h);
  ok("an open layer has tunnels and rooms cut", holes(open) > open.w * 4);
  ok("a layer being dug is part way", holes(part) > holes(solid) && holes(part) < holes(open) + open.w * open.h);
  const r = G.layers[0].rooms[0];
  const at = (r.y + Math.floor(r.h / 2) - open.y0) * open.w + r.x + Math.floor(r.w / 2);
  ok("a room is hollow in the middle", open.mask[at] === 2, String(open.mask[at]));
  ok("every biome has its colours, the garrison too", E.BIOMES && Object.keys(E.BIOMES).every((b) => { try { S.buildChunk(G, 0, b, "open", 0, 50); return true; } catch (e) { return false; } }));
}

section("everything draws");
{
  const sp = SP.TYPES;
  ok("every building has a picture", Object.keys(E.B).every((id) => sp.includes(id)), Object.keys(E.B).filter((id) => !sp.includes(id)).join(","));
  for (const [biome, stage] of [["seam", 0], ["aquifer", 2], ["fungal", 4], ["magma", 6], ["ruin", 3], ["veins", 5]]) {
    const v = viewOf(biome, stage, true);
    const canvas = fakeCanvas(log);
    const sc = S.create(canvas, { quality: "high" });
    let err = null;
    try {
      sc.setView(v, "Test Hold");
      for (let i = 0; i < 40; i++) { sc.step(1 / 20); sc.render(); }
      sc.focus(v.colony.layers - 1);
      for (let i = 0; i < 40; i++) { sc.step(1 / 20); sc.render(); }
    } catch (e) { err = e; }
    ok("a " + biome + " colony at stage " + stage + " draws without an error", !err && !sc.lastError, String(err && err.stack || sc.lastError));
    sc.destroy();
  }
  ok("it really drew (the canvas was asked to do things)", log.calls > 5000, String(log.calls));
  ok("and never with a broken number", log.bad.length === 0, log.bad.slice(0, 3).join(" ; "));
  const low = S.create(fakeCanvas(log), { quality: "low" });
  const v = viewOf("seam", 1, false);
  low.setView(v, "x"); low.step(0.1);
  ok("the low picture setting draws too", (() => { try { low.render(); return true; } catch (e) { return false; } })());
}

section("a click lands on what was drawn there");
{
  const v = viewOf("seam", 2, false);
  const picks = [];
  const sc = S.create(fakeCanvas(log), { onSelect: (s) => picks.push(s) });
  sc.setView(v, "Test Hold");
  const r = sc.G.layers[0].rooms[5];
  const h = sc.hit(r.x + r.w / 2, r.y + r.h / 2);
  ok("the middle of a room is that room", h && h.layer === 0 && h.slot === 5, JSON.stringify(h));
  ok("bare rock is nothing", sc.hit(1, sc.G.h - 1) === null || sc.hit(1, sc.G.h - 1) === undefined);
  sc.select(0, 5, true);
  ok("selecting tells the panel", picks.some((p) => p && p.layer === 0 && p.slot === 5));
  sc.destroy();
}

section("what a building is shown doing");
{
  const v = viewOf("seam", 0, false);
  const cat = {}; v.catalog.forEach((b) => { cat[b.id] = b; });
  ok("a paused building says so", S.statusOf(v, cat, { t: "drill", on: false }).text === "PAUSED");
  ok("a running one runs", S.statusOf(v, cat, { t: "drill", on: true }).run > 0);
  const starved = JSON.parse(JSON.stringify(v)); starved.colony.stock.fungus = 0; starved.colony.rate.fungus = 0;
  ok("one with nothing to work says what is missing", /OUT OF FUNGUS/.test(S.statusOf(starved, cat, { t: "mess", on: true }).text));
}

console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
process.exit(state.fail ? 1 : 0);
