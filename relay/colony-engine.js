/* ============================================================
   FieldKit relay :: colony-engine — DEEPHOLD, the shared game

   Everybody on the relay runs a small underground colony. Buildings
   (never the player's hands) dig, grow, smelt and brew; the colony
   keeps its people breathing, fed and not-quite-miserable; and what it
   ships goes to ONE shared Civilization that levels up, unlocks the
   next tier of buildings for everyone, and is at war.

   THIS FILE IS PURE. No disk, no clock, no network: every function is
   given the time. That is what lets tests/colony.test.js run a month
   of fake time with fake players and say how long each stage took,
   which is how the numbers below were tuned.

   RULES THAT HOLD THE DESIGN UP
   - Nothing is limited per day. Output is limited by what you have
     built, and the shared costs scale with how many people are
     playing (scaleFor), so a small server and a big one both finish
     a stage in about the same time.
   - Offline colonies keep working. What they SHIP reaches the Civ in
     full; what they KEEP at home accrues at OFFLINE_KEEP (30%). They
     are also safe: nobody starves to death while away.
   - Only the current stage and the next are ever shown to players
     (viewFor). Later stages can be added to STAGES at any time.
   - The Civ can fall, but it is hard: several lost waves in a row.
     A fallen Civ gains advancement slower and its buffs are halved
     until it is liberated.
   ============================================================ */
"use strict";

/* ---- tunables ------------------------------------------------ */
const SLOTS = 8;                    /* building plots per layer */
const MAX_LAYERS = 8;
const ONLINE_MS = 5 * 60 * 1000;    /* seen this recently = online */
const ACTIVE_MS = 7 * 24 * 3600 * 1000;
const OFFLINE_KEEP = 0.3;           /* what an offline colony keeps at home */
const STOCK_CAP = 1500;             /* a colony's warehouse, per resource */
const CIV_CAP = 1000000;
const WAVE_MS = 8 * 3600 * 1000;    /* a war wave this often (stage 2 and up) */
const WAVE_FIRST_MS = 24 * 3600 * 1000;
const FALL_MULT = 1.5;              /* advancement cost while fallen */
const BASE_HOUSING = 10;
const EAT = 0.02, USE_GOODS = 0.004;
const REFUND = 0.5;
/* While you are online a colony never ships itself below this: a safety
   so one wrong slider cannot starve your own people. */
const RESERVE = { ore: 60, water: 40, fungus: 40, food: 60, parts: 20, fuel: 20, goods: 20, crystal: 0, arms: 0 };

const RES = ["ore", "water", "fungus", "crystal", "fuel", "food", "parts", "goods", "arms"];
/* What a unit is worth as a gift to the Civ. Only for thanks (the
   contributor list), never for gating. */
const VALUE = { ore: 1, water: 1, fungus: 1, crystal: 12, fuel: 3, food: 2, parts: 3, goods: 5, arms: 8 };
const DEFAULT_SHIP = { ore: 50, water: 50, fungus: 50, crystal: 50, fuel: 0, food: 0, parts: 50, goods: 0, arms: 100 };

/* ---- biomes --------------------------------------------------
   `at` is how many active colonies the Civ needs before the biome
   opens. They open once and stay open. */
const BIOMES = {
  seam:    { name: "ORE SEAM",        at: 0,  mult: { ore: 1.5 },           blurb: "Rich in metal. The safe place to begin." },
  aquifer: { name: "BLACK AQUIFER",   at: 0,  mult: { water: 1.5 },         blurb: "Cold water everywhere. Easy to keep fed." },
  fungal:  { name: "FUNGAL CAVERNS",  at: 3,  mult: { fungus: 1.5 },        blurb: "Spores feed anyone. The air is thick." },
  magma:   { name: "MAGMA VENTS",     at: 6,  mult: { fuel: 1.5 },          blurb: "Heat and fuel gas. Geo taps run here, nowhere else." },
  veins:   { name: "CRYSTAL VEINS",   at: 10, mult: { crystal: 2 },         blurb: "Crystal close to the surface. The war runs on it.", crystalLayer: 1 }
};

/* ---- buildings ------------------------------------------------
   power: + gives, - uses. staff: workers it needs. inp/out: per second
   at full run. order: the chain order each step (raw first).
   stage: Civ stage that unlocks it. minLayer: depth (0 = top).
   housing/air/ent/lift/def/heal: what it provides. */
const B = {
  bunk:     { name: "BUNK BLOCK",     blurb: "Beds in a stack. Houses 6.", cost: { ore: 40 }, power: -1, staff: 0, housing: 6, order: 9, stage: 0 },
  scrubber: { name: "AIR SCRUBBER",   blurb: "Cleans air for 10 people.", cost: { ore: 30, parts: 5 }, power: -3, staff: 0, air: 10, order: 9, stage: 0 },
  cell:     { name: "SALVAGE CELL",   blurb: "Scavenged cells. A little power, free.", cost: { ore: 25, parts: 5 }, power: 15, staff: 0, max: 4, order: 0, stage: 0 },
  burner:   { name: "FUEL BURNER",    blurb: "Burns fuel for strong power.", cost: { ore: 60, parts: 15 }, power: 30, staff: 1, inp: { fuel: 0.1 }, order: 0, stage: 1 },
  geo:      { name: "GEO TAP",        blurb: "Draws heat from the vents. Power for nothing.", cost: { ore: 90, parts: 30 }, power: 25, staff: 1, max: 3, biomes: ["magma"], order: 0, stage: 1 },
  drill:    { name: "ORE DRILL",      blurb: "Chews rock into metal.", cost: { ore: 30 }, power: -4, staff: 2, out: { ore: 0.5 }, order: 1, stage: 0 },
  pump:     { name: "WATER PUMP",     blurb: "Pulls water up from the deep.", cost: { ore: 30 }, power: -3, staff: 1, out: { water: 0.5 }, order: 1, stage: 0 },
  farm:     { name: "FUNGUS FARM",    blurb: "Grows spore mats. Needs water.", cost: { ore: 35, water: 10 }, power: -2, staff: 2, inp: { water: 0.15 }, out: { fungus: 0.5 }, order: 1, stage: 0 },
  siphon:   { name: "GAS SIPHON",     blurb: "Taps fuel gas pockets. Layer 2 and deeper.", cost: { ore: 60, parts: 10 }, power: -3, staff: 1, out: { fuel: 0.2 }, minLayer: 1, order: 1, stage: 1 },
  bore:     { name: "CRYSTAL BORE",   blurb: "Reaches the crystal seams. Deep only.", cost: { ore: 120, parts: 40 }, power: -8, staff: 3, out: { crystal: 0.1 }, minLayer: 2, order: 1, stage: 1 },
  mess:     { name: "MESS HALL",      blurb: "Cooks spores into rations.", cost: { ore: 50 }, power: -2, staff: 2, inp: { fungus: 0.6, water: 0.1 }, out: { food: 0.5 }, order: 2, stage: 0 },
  foundry:  { name: "FOUNDRY",        blurb: "Smelts ore into parts.", cost: { ore: 70 }, power: -6, staff: 2, inp: { ore: 0.6 }, out: { parts: 0.25 }, order: 2, stage: 0 },
  workshop: { name: "WORKSHOP",       blurb: "Makes goods people will pay for. Parts and water in.", cost: { ore: 60, parts: 20 }, power: -4, staff: 2, inp: { parts: 0.1, water: 0.05 }, out: { goods: 0.1 }, order: 3, stage: 1 },
  armoury:  { name: "ARMOURY",        blurb: "Turns parts and crystal into arms.", cost: { ore: 80, parts: 30 }, power: -6, staff: 3, inp: { parts: 0.2, crystal: 0.02 }, out: { arms: 0.1 }, order: 3, stage: 2 },
  stimden:  { name: "STIM DEN",       blurb: "Entertainment for 12. Uses some goods.", cost: { ore: 60, parts: 15 }, power: -3, staff: 1, ent: 12, inp: { goods: 0.01 }, order: 4, stage: 1 },
  clinic:   { name: "MED BAY",        blurb: "Keeps people patched and a little less bitter.", cost: { ore: 70, parts: 25 }, power: -3, staff: 2, heal: 8, max: 2, order: 9, stage: 2 },
  lift:     { name: "CARGO LIFT",     blurb: "Carries 1.5 units a second up to the Civ.", cost: { ore: 50 }, power: -3, staff: 1, lift: 1.5, max: 4, order: 9, stage: 0 },
  reactor:  { name: "MICRO REACTOR",  blurb: "Serious power. Eats fuel.", cost: { ore: 160, parts: 70, crystal: 10 }, power: 90, staff: 2, inp: { fuel: 0.18 }, order: 0, stage: 3 },
  vidhall:  { name: "VID HALL",       blurb: "Loud, bright, and for 30 people. Uses goods.", cost: { ore: 120, parts: 50 }, power: -5, staff: 2, ent: 30, inp: { goods: 0.02 }, order: 4, stage: 3 },
  turret:   { name: "TURRET NEST",    blurb: "Adds to the Civ's defence in every wave.", cost: { ore: 110, parts: 45 }, power: -2, staff: 1, def: 6, max: 3, order: 9, stage: 3 }
};
for (const id of Object.keys(B)) { B[id].id = id; }

/* ---- the stages ---------------------------------------------
   `need` is for ONE player; the server multiplies it by scaleFor().
   buff accumulates for every stage reached. Add more at the end
   whenever you like: nobody can see past the next one. */
const STAGES = [
  { name: "SURVIVORS", need: null, buff: {}, text: "A few holes in the rock and a lot of nerve." },
  { name: "FOOTHOLD",  need: { ore: 1200, water: 600, fungus: 500, parts: 250 },
    buff: { yield: 0.05 }, text: "Burners, Workshops and Stim Dens. +5% output.", unlocks: ["burner", "geo", "siphon", "bore", "workshop", "stimden"] },
  { name: "SETTLEMENT", need: { parts: 400, food: 250, goods: 40 },
    buff: { yield: 0.05, housing: 2 }, text: "Armouries and Med Bays. The Consortium notices. +5% output, +2 beds per colony.", unlocks: ["armoury", "clinic"], war: true },
  { name: "GARRISON", need: { arms: 150, crystal: 100, goods: 150, parts: 500 },
    buff: { yield: 0.05, def: 0.15 }, text: "Reactors, Vid Halls and Turret Nests. +5% output, +15% defence.", unlocks: ["reactor", "vidhall", "turret"] },
  { name: "BULWARK", need: { arms: 600, crystal: 300, food: 800, goods: 600, parts: 1200 },
    buff: { yield: 0.08, def: 0.2, lift: 0.25 }, text: "The Civ stops being a camp. +8% output, +20% defence, +25% cargo." },
  { name: "STRONGHOLD", need: { arms: 1400, crystal: 700, goods: 1400, parts: 2600, fuel: 800 },
    buff: { yield: 0.08, def: 0.25, housing: 2 }, text: "Nobody remembers the surface." }
];

/* Everything in the stage costs scales with how many are playing. A
   little under one-for-one, so a bigger server is a little quicker, not
   slower, and never a lot. */
function scaleFor(active) { return Math.pow(Math.max(1, active || 1), 0.8); }

/* One stage need is written for one player over a few hours; this makes it days. */
const NEED_K = Number(process.env.NEED_K) || 8;
const LIBERATE = { arms: 90, parts: 160, goods: 40 };

/* ---- construction ------------------------------------------- */
function newCiv(now) {
  return { stage: 0, progress: {}, stock: {}, strain: 0, fallen: false, liberation: {}, breach: 0,
    war: null, debt: {}, wins: 0, losses: 0, peak: 0, givers: {}, log: [], created: now || 0, upkeepAt: now || 0 };
}
function newWorld(now) { return { v: 1, civ: newCiv(now), colonies: {}, tickAt: now || 0 }; }

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function num(v, d) { v = Number(v); return Number.isFinite(v) ? v : d; }

function say(list, now, text, keep) {
  list.push({ t: now, text: String(text).slice(0, 200) });
  while (list.length > (keep || 40)) list.shift();
}

/* ---- population of the server --------------------------------- */
function activeColonies(world, now) {
  let n = 0;
  for (const h of Object.keys(world.colonies)) {
    const c = world.colonies[h];
    if (!c.collapsed && now - c.lastSeen < ACTIVE_MS) n++;
  }
  return n;
}
function activeScale(world, now) { return scaleFor(activeColonies(world, now)); }
function biomeOpen(world, id) {
  const b = Object.prototype.hasOwnProperty.call(BIOMES, id) ? BIOMES[id] : null;
  return !!b && (world.civ.peak >= b.at || b.at === 0);
}

function buffs(civ) {
  const t = { yield: 0, housing: 0, def: 0, lift: 0 };
  for (let i = 1; i <= civ.stage && i < STAGES.length; i++) {
    const b = STAGES[i].buff || {};
    for (const k of Object.keys(t)) t[k] += b[k] || 0;
  }
  /* A starving Civ (strain full) or a fallen one gets less of it. */
  const f = (civ.strain >= 100 ? 0 : 1) * (civ.fallen ? 0.5 : 1);
  for (const k of Object.keys(t)) t[k] *= f;
  return t;
}

function needFor(world, now, stage) {
  const s = STAGES[stage];
  if (!s || !s.need) return null;
  const k = activeScale(world, now) * (world.civ.fallen ? FALL_MULT : 1);
  const out = {};
  for (const r of Object.keys(s.need)) out[r] = Math.ceil(s.need[r] * k * NEED_K);
  return out;
}
function liberationNeed(world, now) {
  const k = activeScale(world, now) * (1 + world.civ.stage * 0.4);
  const out = {};
  for (const r of Object.keys(LIBERATE)) out[r] = Math.ceil(LIBERATE[r] * k);
  return out;
}

/* ---- the colony ---------------------------------------------- */
function newColony(handle, biome, name, now) {
  const grid = [];
  for (let l = 0; l < MAX_LAYERS; l++) { grid.push(new Array(SLOTS).fill(null)); }
  const put = (l, s, t) => { grid[l][s] = { t: t, on: true }; };
  put(0, 0, "scrubber"); put(0, 1, "cell"); put(0, 2, "cell"); put(0, 3, "drill"); put(0, 4, "pump"); put(0, 5, "lift");
  const ship = Object.assign({}, DEFAULT_SHIP);
  return {
    handle: handle, name: name, biome: biome, born: now, lastSeen: now, collapsed: false,
    layers: 1, dig: null, grid: grid, stock: { ore: 140, water: 70, fungus: 60, food: 120, parts: 20, crystal: 0, fuel: 0, goods: 0, arms: 0 },
    pop: 8, hap: 70, sat: { food: 1, goods: 1 }, ship: ship, given: 0,
    stats: {}, log: [], crisis: 0, safe: false, shipped: {}
  };
}

function countOf(colony, id) {
  let n = 0;
  for (const row of colony.grid) for (const c of row) if (c && c.t === id) n++;
  return n;
}
function layerCap(civ) { return Math.min(MAX_LAYERS, 2 + civ.stage); }
function digCost(colony) {
  const n = colony.layers;                 /* the layer being opened */
  return { ore: Math.round(90 * Math.pow(1.9, n - 1)), parts: Math.round(10 * Math.pow(2, n - 1)) };
}
function digSeconds(colony) { return 90 * colony.layers; }

function canAfford(stock, cost) {
  for (const r of Object.keys(cost)) if ((stock[r] || 0) < cost[r]) return false;
  return true;
}
function pay(stock, cost) { for (const r of Object.keys(cost)) stock[r] = (stock[r] || 0) - cost[r]; }

/* ---- what a colony can do (all checked here, on the server) ---- */
function build(world, colony, layer, slot, type) {
  const b = Object.prototype.hasOwnProperty.call(B, type) ? B[type] : null;
  if (!b) return { error: "unknown building" };
  if (colony.collapsed) return { error: "this colony has fallen" };
  layer = layer | 0; slot = slot | 0;
  if (layer < 0 || layer >= colony.layers || slot < 0 || slot >= SLOTS) return { error: "no such plot" };
  if (colony.grid[layer][slot]) return { error: "that plot is taken" };
  if (b.stage > world.civ.stage) return { error: "the Civilization has not unlocked that yet" };
  if ((b.minLayer || 0) > layer) return { error: "needs layer " + ((b.minLayer || 0) + 1) + " or deeper" };
  if (b.biomes && b.biomes.indexOf(colony.biome) < 0) return { error: "this biome cannot run that" };
  if (b.max && countOf(colony, type) >= b.max) return { error: "you have as many as you can run (" + b.max + ")" };
  if (!canAfford(colony.stock, b.cost)) return { error: "not enough materials" };
  pay(colony.stock, b.cost);
  colony.grid[layer][slot] = { t: type, on: true };
  return { ok: true };
}
function demolish(colony, layer, slot) {
  layer = layer | 0; slot = slot | 0;
  const c = colony.grid[layer] && colony.grid[layer][slot];
  if (!c) return { error: "nothing there" };
  const b = B[c.t];
  for (const r of Object.keys(b.cost)) colony.stock[r] = Math.min(STOCK_CAP, (colony.stock[r] || 0) + Math.floor(b.cost[r] * REFUND));
  colony.grid[layer][slot] = null;
  return { ok: true };
}
function toggle(colony, layer, slot) {
  const c = colony.grid[layer | 0] && colony.grid[layer | 0][slot | 0];
  if (!c) return { error: "nothing there" };
  c.on = !c.on;
  return { ok: true, on: c.on };
}
function startDig(world, colony, now) {
  if (colony.collapsed) return { error: "this colony has fallen" };
  if (colony.dig) return { error: "a dig is already running" };
  if (colony.layers >= layerCap(world.civ)) return { error: "the Civilization must grow before you can dig deeper" };
  const cost = digCost(colony);
  if (!canAfford(colony.stock, cost)) return { error: "not enough materials" };
  pay(colony.stock, cost);
  colony.dig = { done: now + digSeconds(colony) * 1000 };
  return { ok: true };
}
function setShip(colony, res, pct) {
  if (RES.indexOf(res) < 0) return { error: "unknown resource" };
  colony.ship[res] = clamp(Math.round(num(pct, 0)), 0, 100);
  return { ok: true };
}

/* ---- the Civilization receives -------------------------------- */
function deliver(world, now, colony, res, amount) {
  const civ = world.civ;
  if (!(amount > 0)) return;
  const v = amount * (VALUE[res] || 1);
  colony.given += v;
  const g = civ.givers[colony.handle] || (civ.givers[colony.handle] = { v: 0, name: colony.name });
  g.v += v; g.name = colony.name;
  colony.shipped[res] = (colony.shipped[res] || 0) + amount;
  let left = amount;
  /* Upkeep is paid first, like a tax: what the Civ owes to keep the lights on. */
  if (civ.debt && civ.debt[res] > 0) { const p = Math.min(left, civ.debt[res]); civ.debt[res] -= p; left -= p; }
  /* A fallen Civ must be liberated first. */
  if (civ.fallen) {
    const need = liberationNeed(world, now)[res];
    if (need) {
      const have = civ.liberation[res] || 0;
      const take = Math.min(left, Math.max(0, need - have));
      civ.liberation[res] = have + take; left -= take;
    }
  } else {
    const need = needFor(world, now, civ.stage + 1);
    if (need && need[res]) {
      const have = civ.progress[res] || 0;
      const take = Math.min(left, Math.max(0, need[res] - have));
      civ.progress[res] = have + take; left -= take;
    }
  }
  if (left > 0) civ.stock[res] = Math.min(CIV_CAP, (civ.stock[res] || 0) + left);
}

function checkAdvance(world, now) {
  const civ = world.civ;
  if (civ.fallen) {
    const need = liberationNeed(world, now);
    if (Object.keys(need).every((r) => (civ.liberation[r] || 0) >= need[r])) {
      civ.fallen = false; civ.liberation = {}; civ.breach = 40; civ.strain = 0;
      say(civ.log, now, "LIBERATED. The Civilization stands again.");
    }
    return;
  }
  const need = needFor(world, now, civ.stage + 1);
  if (!need) return;
  if (Object.keys(need).every((r) => (civ.progress[r] || 0) >= need[r])) {
    civ.stage++; civ.progress = {};
    say(civ.log, now, "STAGE " + civ.stage + " REACHED: " + STAGES[civ.stage].name + ".");
    if (STAGES[civ.stage].war && !civ.war) scheduleWave(world, now, WAVE_FIRST_MS);
  }
}

/* ---- war ----------------------------------------------------- */
function waveStrength(world, now) {
  return Math.round(250 * Math.pow(1.3, Math.max(0, world.civ.stage - 2)) * activeScale(world, now));
}
function scheduleWave(world, now, delay) {
  world.civ.war = { at: now + delay, strength: waveStrength(world, now) };
}
function defenceNow(world) {
  const civ = world.civ;
  let turrets = 0;
  for (const h of Object.keys(world.colonies)) {
    const c = world.colonies[h];
    if (c.collapsed) continue;
    for (const row of c.grid) for (const s of row) if (s && s.on && B[s.t].def) turrets += B[s.t].def;
  }
  const f = 1 + buffs(civ).def;
  return { arms: civ.stock.arms || 0, turrets: turrets, total: ((civ.stock.arms || 0) + turrets) * f };
}
function resolveWave(world, now) {
  const civ = world.civ, w = civ.war;
  const d = defenceNow(world);
  if (d.total >= w.strength) {
    const spend = Math.min(civ.stock.arms || 0, Math.round(w.strength * 0.6));
    civ.stock.arms = (civ.stock.arms || 0) - spend;
    civ.breach = Math.max(0, civ.breach - 15); civ.wins++;
    say(civ.log, now, "WAVE REPELLED. " + w.strength + " against " + Math.round(d.total) + ". " + spend + " arms spent.");
  } else {
    const short = 1 - d.total / w.strength;
    civ.stock.arms = 0;
    if (!civ.fallen) civ.breach += Math.round(12 + 24 * short);
    civ.losses++;
    if (!civ.fallen) say(civ.log, now, "WAVE BROKE THROUGH. " + w.strength + " against " + Math.round(d.total) + ". The wall is cracking (" + civ.breach + "/100).");
    if (civ.breach >= 100 && !civ.fallen) {
      civ.fallen = true; civ.breach = 50; civ.liberation = {};
      for (const r of Object.keys(civ.stock)) civ.stock[r] = Math.floor((civ.stock[r] || 0) * 0.5);
      say(civ.log, now, "THE CIVILIZATION HAS FALLEN. Half its stores are gone. Advancement is slower and buffs are halved until it is liberated.");
    }
  }
  scheduleWave(world, now, WAVE_MS);
}

/* ---- one colony, one step ------------------------------------ */
function stepColony(world, colony, now, dt) {
  const civ = world.civ;
  if (colony.collapsed) return;
  const online = now - colony.lastSeen < ONLINE_MS;
  colony.safe = !online;
  const biome = BIOMES[colony.biome] || BIOMES.seam;
  const bf = buffs(civ);
  const st = colony.stock;

  /* digging */
  if (colony.dig && now >= colony.dig.done) {
    colony.layers = Math.min(MAX_LAYERS, colony.layers + 1); colony.dig = null;
    say(colony.log, now, "Layer " + colony.layers + " is open.", 20);
  }

  /* what is built and on */
  const live = [];
  for (let l = 0; l < colony.layers; l++) for (let s = 0; s < SLOTS; s++) {
    const c = colony.grid[l][s];
    if (c && c.on) live.push({ b: B[c.t], l: l });
  }
  const pop = Math.floor(colony.pop);
  const housing = BASE_HOUSING + bf.housing + live.reduce((a, x) => a + (x.b.housing || 0), 0);
  let need = 0;
  for (const x of live) need += x.b.staff || 0;
  const staffF = need > 0 ? Math.min(1, pop / need) : 1;
  const hapMult = clamp(0.5 + colony.hap / 100 * 0.7, 0.5, 1.15);

  /* power: generators first, by what fuel they can burn */
  let supply = 0, demand = 0;
  for (const x of live) {
    const b = x.b;
    if (b.power > 0) {
      let r = 1;
      if (b.inp) for (const k of Object.keys(b.inp)) r = Math.min(r, (st[k] || 0) / (b.inp[k] * dt));
      r = clamp(r, 0, 1);
      if (b.inp) for (const k of Object.keys(b.inp)) st[k] -= b.inp[k] * dt * r;
      supply += b.power * r * staffF;
    } else demand += -b.power;
  }
  const pf = demand > 0 ? clamp(supply / demand, 0, 1) : 1;
  const E = pf * staffF * hapMult * (1 + bf.yield);

  /* extractors, then processors, in chain order */
  const crystalMult = (layer) => {
    const base = biome.mult.crystal || 0.6;
    const first = biome.crystalLayer != null ? biome.crystalLayer : 2;
    return layer >= first ? base : base * 0.5;
  };
  const made = {};
  const order = live.filter((x) => x.b.power <= 0 || x.b.out).sort((a, b2) => a.b.order - b2.b.order);
  let airCap = 0, entCap = 0, heal = 0, liftCap = 0;
  for (const x of order) {
    const b = x.b;
    const svc = pf * staffF;
    if (b.air) airCap += b.air * svc;
    if (b.heal) heal += b.heal * svc;
    if (b.lift) liftCap += b.lift * svc * (1 + bf.lift);
    if (b.out || b.ent) {
      let r = b.out ? E : svc;
      if (b.inp) for (const k of Object.keys(b.inp)) r = Math.min(r, (st[k] || 0) / (b.inp[k] * dt));
      r = Math.max(0, r);
      if (b.inp) for (const k of Object.keys(b.inp)) st[k] -= b.inp[k] * dt * r;
      if (b.ent) entCap += b.ent * r;
      if (b.out) for (const k of Object.keys(b.out)) {
        let m = k === "crystal" ? crystalMult(x.l) : (biome.mult[k] || 1);
        made[k] = (made[k] || 0) + b.out[k] * dt * r * m;
      }
    }
  }

  /* shipping: a share of what was made goes up, as far as the lifts
     can carry. Offline, the share kept at home is only 30%. */
  let room = liftCap * dt;
  for (const k of Object.keys(made)) {
    const amt = made[k];
    const want = online && (st[k] || 0) < (RESERVE[k] || 0) ? 0 : amt * (colony.ship[k] || 0) / 100;
    const send = Math.min(want, room);
    room -= send;
    if (send > 0) deliver(world, now, colony, k, send);
    const keep = amt - send;
    st[k] = Math.min(STOCK_CAP, (st[k] || 0) + keep * (online ? 1 : OFFLINE_KEEP));
  }
  colony.stats = { power: [Math.round(supply), Math.round(demand)], staff: [Math.min(need, pop), need], air: [Math.round(airCap), pop],
    ent: [Math.round(entCap), pop], housing: housing, lift: Math.round(liftCap * 10) / 10, eff: Math.round(E * 100) / 100 };

  /* people eat, and buy things */
  const wantFood = pop * EAT * dt, wantGoods = pop * USE_GOODS * dt;
  const gotFood = Math.min(st.food || 0, wantFood), gotGoods = Math.min(st.goods || 0, wantGoods);
  st.food = (st.food || 0) - gotFood; st.goods = (st.goods || 0) - gotGoods;
  const k = Math.min(1, dt / 30);
  colony.sat.food += ((wantFood > 0 ? gotFood / wantFood : 1) - colony.sat.food) * k;
  colony.sat.goods += ((wantGoods > 0 ? gotGoods / wantGoods : 1) - colony.sat.goods) * k;

  /* happiness */
  const air = pop > 0 ? Math.min(1, airCap / pop) : 1;
  const ent = pop > 0 ? Math.min(1, entCap / pop) : 1;
  const crowd = Math.max(0, pop / Math.max(1, housing) - 1);
  const target = clamp(100 * (0.35 * colony.sat.food + 0.15 * colony.sat.goods + 0.2 * ent + 0.3 * air) - crowd * 40 + Math.min(10, heal), 0, 100);
  colony.hap += (target - colony.hap) * Math.min(1, dt / 60);
  colony.airNow = air;

  /* people come and go. Offline, nobody dies and the mood never
     falls below 20: coming back to a dead colony would punish
     going to sleep. */
  if (!online) { if (colony.hap < 20) colony.hap = 20; }
  const hungry = colony.sat.food < 0.3, choking = air < 0.5, bitter = colony.hap < 25;
  if (online && (hungry || choking || bitter)) {
    colony.pop -= dt / 240;
    if (colony.hap < 10) colony.crisis += dt; else colony.crisis = 0;
  } else {
    colony.crisis = 0;
    if (colony.hap >= 55 && air >= 1 && colony.sat.food > 0.9 && st.food > pop * 3 && colony.pop < housing) colony.pop = Math.min(housing, colony.pop + dt / 300);
  }
  if (!online && colony.pop < 2) colony.pop = 2;
  if (colony.pop < 1 && online) {
    colony.collapsed = true; colony.pop = 0;
    say(colony.log, now, "Everyone is gone. The colony has fallen.", 20);
    say(civ.log, now, colony.name + " has fallen. Its people did not make it.");
  }
}

/* ---- the world, one step ------------------------------------- */
const STEP = 15;

function stepWorld(world, now) {
  const civ = world.civ;
  let dt = (now - world.tickAt) / 1000;
  if (!(dt > 0)) { world.tickAt = now; return; }
  dt = Math.min(dt, 6 * 3600);
  let t = world.tickAt;
  const handles = Object.keys(world.colonies);
  while (dt > 0) {
    const h = Math.min(STEP, dt);
    t += h * 1000; dt -= h;
    civ.peak = Math.max(civ.peak, activeColonies(world, t));
    for (const id of handles) stepColony(world, world.colonies[id], t, h);
    upkeep(world, t, h);
    checkAdvance(world, t);
    if (civ.war && t >= civ.war.at) resolveWave(world, t);
  }
  world.tickAt = now;
}

/* The Civ pays for itself: parts and water, per stage, per active
   player. If it cannot, strain builds; at 100 its buffs stop until
   it is paid again. */
function upkeep(world, now, dt) {
  const civ = world.civ;
  if (civ.stage < 1) return;
  if (!civ.debt) civ.debt = {};
  const perHour = { water: 14 * civ.stage, parts: 8 * civ.stage };
  const k = activeScale(world, now) * NEED_K / 12;
  let worst = 0;
  for (const r of Object.keys(perHour)) {
    const rate = perHour[r] * k;                 /* per hour */
    civ.debt[r] = (civ.debt[r] || 0) + rate * dt / 3600;
    const take = Math.min(civ.stock[r] || 0, civ.debt[r]);
    civ.stock[r] = (civ.stock[r] || 0) - take; civ.debt[r] -= take;
    worst = Math.max(worst, civ.debt[r] / (rate * 2));      /* two hours behind = broken */
  }
  const target = clamp(worst * 100, 0, 100);
  civ.strain += (target - civ.strain) * Math.min(1, dt / 600);
  if (civ.strain > 99.5) civ.strain = 100;
}

/* ---- what a player is shown ---------------------------------- */
function buildingView(id) {
  const b = B[id];
  return { id: id, name: b.name, blurb: b.blurb, cost: b.cost, power: b.power, staff: b.staff || 0, inp: b.inp || null, out: b.out || null,
    max: b.max || 0, minLayer: b.minLayer || 0, biomes: b.biomes || null, stage: b.stage };
}

/* Current stage and the next only. A building two stages out is not
   in the list at all. */
function catalogFor(civ) {
  const out = [];
  for (const id of Object.keys(B)) {
    const b = B[id];
    if (b.stage <= civ.stage) out.push(buildingView(id));
    else if (b.stage === civ.stage + 1) out.push({ id: id, name: b.name, blurb: "", locked: true, stage: b.stage });
  }
  return out;
}

function viewFor(world, now, handle) {
  const civ = world.civ;
  const colony = world.colonies[handle] || null;
  const active = activeColonies(world, now);
  const next = civ.fallen ? null : STAGES[civ.stage + 1];
  const nextNeed = next ? needFor(world, now, civ.stage + 1) : null;
  const top = Object.keys(civ.givers).map((h) => ({ name: civ.givers[h].name, v: Math.round(civ.givers[h].v), me: h === handle }))
    .sort((a, b) => b.v - a.v).slice(0, 5);
  const bf = buffs(civ);
  const biomes = Object.keys(BIOMES).filter((id) => BIOMES[id].at <= civ.peak + 3 || biomeOpen(world, id)).map((id) => ({
    id: id, name: BIOMES[id].name, blurb: BIOMES[id].blurb, open: biomeOpen(world, id), at: BIOMES[id].at }));
  const view = {
    now: now,
    civ: {
      stage: civ.stage, name: STAGES[civ.stage].name, text: STAGES[civ.stage].text,
      next: next ? { name: next.name, text: next.text, need: nextNeed, progress: civ.progress } : null,
      fallen: civ.fallen,
      liberation: civ.fallen ? { need: liberationNeed(world, now), progress: civ.liberation } : null,
      stock: civ.stock, strain: Math.round(civ.strain), brownout: civ.strain >= 100,
      buffs: bf, active: active, colonies: Object.keys(world.colonies).filter((h) => !world.colonies[h].collapsed).length,
      war: STAGES[civ.stage].war || civ.stage >= 2 ? {
        at: civ.war ? civ.war.at : null, strength: civ.war ? civ.war.strength : null,
        defence: Math.round(defenceNow(world).total), breach: civ.breach, wins: civ.wins, losses: civ.losses } : null,
      top: top, log: civ.log.slice(-12).reverse()
    },
    biomes: biomes,
    catalog: catalogFor(civ),
    constants: { slots: SLOTS, maxLayers: MAX_LAYERS, layerCap: layerCap(civ), stockCap: STOCK_CAP, offlineKeep: OFFLINE_KEEP, res: RES },
    colony: null
  };
  if (colony) {
    view.colony = {
      name: colony.name, biome: colony.biome, collapsed: colony.collapsed, layers: colony.layers,
      dig: colony.dig ? { left: Math.max(0, Math.round((colony.dig.done - now) / 1000)) } : null,
      digCost: colony.layers < layerCap(civ) ? digCost(colony) : null, digSeconds: digSeconds(colony),
      grid: colony.grid.slice(0, colony.layers).map((row) => row.map((c) => c ? { t: c.t, on: c.on } : null)),
      stock: Object.keys(colony.stock).reduce((o, r) => { o[r] = Math.floor(colony.stock[r] * 10) / 10; return o; }, {}),
      pop: Math.floor(colony.pop), hap: Math.round(colony.hap), stats: colony.stats, ship: colony.ship,
      given: Math.round(colony.given), shipped: colony.shipped, log: colony.log.slice(-8).reverse(),
      safe: colony.safe, since: colony.born
    };
  }
  return view;
}

module.exports = {
  SLOTS, MAX_LAYERS, ONLINE_MS, ACTIVE_MS, OFFLINE_KEEP, STOCK_CAP, RESERVE, WAVE_MS, WAVE_FIRST_MS, RES, VALUE, DEFAULT_SHIP, BIOMES, B, STAGES, LIBERATE,
  scaleFor, newWorld, newCiv, newColony, build, demolish, toggle, startDig, setShip, stepWorld, stepColony, deliver, checkAdvance,
  activeColonies, activeScale, biomeOpen, buffs, needFor, liberationNeed, waveStrength, scheduleWave, resolveWave, defenceNow,
  viewFor, catalogFor, digCost, layerCap, countOf, say, STEP
};
