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
   - Offline colonies keep working for a week. What they SHIP reaches
     the Civ in full; what they KEEP at home accrues at OFFLINE_KEEP
     (30%). They are also safe: nobody starves while away. After a week
     unseen a colony is PAUSED (it makes and ships nothing) and stops
     counting toward the scaling, until its owner comes back.
   - Only the current stage and the next are ever shown to players
     (viewFor). Later stages can be added to STAGES at any time.
   - The Civ can fall, but it is hard: several lost waves in a row.
     A fallen Civ gains advancement slower and its buffs are halved
     until it is liberated.
   - An admin can pause the whole game. Time stops for everyone: no
     production, no waves, no timers running down.
   ============================================================ */
"use strict";

/* ---- tunables ------------------------------------------------ */
const SLOTS = 8;                    /* building plots per layer */
const MAX_LAYERS = 10;
const ONLINE_MS = 5 * 60 * 1000;    /* seen this recently = online */
const ACTIVE_MS = 7 * 24 * 3600 * 1000;   /* unseen longer than this = paused */
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
   so one wrong setting cannot starve your own people. */
const RESERVE = { ore: 60, water: 40, fungus: 40, food: 60, parts: 20, fuel: 20, goods: 20, crystal: 0, arms: 0 };

const RES = ["ore", "water", "fungus", "crystal", "fuel", "food", "parts", "goods", "arms"];
/* What a unit is worth as a gift to the Civ. Only for thanks (the
   contributor list), never for gating. */
const VALUE = { ore: 1, water: 1, fungus: 1, crystal: 12, fuel: 3, food: 2, parts: 3, goods: 5, arms: 8 };

/* How a resource goes up to the Civ. A number is a fixed share of what
   is made (0 to 100). A word is an automatic rule that follows what the
   colony itself needs and what the Civ is asking for, and changes as
   they do:
     all      every unit made
     surplus  everything the colony does not need for the next 15 minutes
     lean     a quarter of it, and only what an hour of use leaves over;
              double that when the Civ is asking for it
     none     nothing */
const MODES = ["all", "surplus", "lean", "none"];
const MODE_BUFFER_S = { surplus: 900, lean: 3600 };
/* What an automatic rule keeps for building, before it sends anything:
   a colony that ships its ore away cannot build. Grows with depth. */
const FUND = { ore: 260, parts: 80, water: 60, fungus: 50, crystal: 20 };
const DEFAULT_SHIP = { ore: "surplus", water: "surplus", fungus: "surplus", crystal: "surplus", fuel: "lean", food: "lean", parts: "surplus", goods: "lean", arms: "all" };

/* ---- biomes --------------------------------------------------
   `at` is how many active colonies the Civ needs before the biome
   opens. They open once and stay open. adminOnly places are never
   offered to anyone else. */
const BIOMES = {
  seam:    { name: "ORE SEAM",        at: 0,  mult: { ore: 1.5 },           blurb: "Rich in metal. The safe place to begin." },
  aquifer: { name: "BLACK AQUIFER",   at: 0,  mult: { water: 1.5 },         blurb: "Cold water everywhere. Easy to keep fed." },
  fungal:  { name: "FUNGAL CAVERNS",  at: 3,  mult: { fungus: 1.5 },        blurb: "Spores feed anyone. The air is thick." },
  magma:   { name: "MAGMA VENTS",     at: 6,  mult: { fuel: 1.5 },          blurb: "Heat and fuel gas. Geo taps run here, nowhere else." },
  veins:   { name: "CRYSTAL VEINS",   at: 10, mult: { crystal: 2 },         blurb: "Crystal close to the surface. The war runs on it.", crystalLayer: 1 },
  ruin:    { name: "OLD IMPERIAL GARRISON", at: 0, adminOnly: true, mult: { ore: 1.1, arms: 1.5 },
             blurb: "A shattered fortress of an old empire. Its armouries are still full. Every building you raise repairs a little more of it." }
};

/* ---- buildings ------------------------------------------------
   power: + gives, - uses. staff: workers it needs. inp/out: per second
   at full run. order: the chain order each step (raw first).
   stage: Civ stage that unlocks it. minLayer: depth (0 = top).
   housing/air/ent/lift/def/heal: what it provides.
   cat: where it sits in the build menu. repair: how much of the old
   garrison must be restored before it can be built (ruin only). */
const CATS = [
  { id: "air",   name: "POWER & AIR" },
  { id: "dig",   name: "MATERIALS" },
  { id: "food",  name: "FOOD" },
  { id: "goods", name: "GOODS & FUN" },
  { id: "home",  name: "HOUSING & CARE" },
  { id: "war",   name: "DEFENCE" },
  { id: "cargo", name: "CARGO" }
];
const B = {
  scrubber: { cat: "air", name: "AIR SCRUBBER",   blurb: "Cleans air for 10 people.", cost: { ore: 30, parts: 5 }, power: -3, staff: 0, air: 10, order: 9, stage: 0 },
  cell:     { cat: "air", name: "SALVAGE CELL",   blurb: "Scavenged cells. A little power, free.", cost: { ore: 25, parts: 5 }, power: 15, staff: 0, max: 4, order: 0, stage: 0 },
  burner:   { cat: "air", name: "FUEL BURNER",    blurb: "Burns fuel for strong power.", cost: { ore: 60, parts: 15 }, power: 30, staff: 1, inp: { fuel: 0.1 }, order: 0, stage: 1 },
  geo:      { cat: "air", name: "GEO TAP",        blurb: "Draws heat from the vents. Power for nothing.", cost: { ore: 90, parts: 30 }, power: 25, staff: 1, max: 3, biomes: ["magma"], order: 0, stage: 1 },
  reactor:  { cat: "air", name: "MICRO REACTOR",  blurb: "Serious power. Eats fuel.", cost: { ore: 160, parts: 70, crystal: 10 }, power: 90, staff: 2, inp: { fuel: 0.18 }, order: 0, stage: 3 },
  fusion:   { cat: "air", name: "FUSION CORE",    blurb: "Power for a whole city. Sips crystal.", cost: { ore: 300, parts: 140, crystal: 40 }, power: 220, staff: 3, inp: { crystal: 0.03 }, order: 0, stage: 6 },

  drill:    { cat: "dig", name: "ORE DRILL",      blurb: "Chews rock into metal.", cost: { ore: 30 }, power: -4, staff: 2, out: { ore: 0.5 }, order: 1, stage: 0 },
  pump:     { cat: "dig", name: "WATER PUMP",     blurb: "Pulls water up from the deep.", cost: { ore: 30 }, power: -3, staff: 1, out: { water: 0.5 }, order: 1, stage: 0 },
  siphon:   { cat: "dig", name: "GAS SIPHON",     blurb: "Taps fuel gas pockets. Layer 2 and deeper.", cost: { ore: 60, parts: 10 }, power: -3, staff: 1, out: { fuel: 0.2 }, minLayer: 1, order: 1, stage: 1 },
  bore:     { cat: "dig", name: "CRYSTAL BORE",   blurb: "Reaches the crystal seams. Deep only.", cost: { ore: 120, parts: 40 }, power: -8, staff: 3, out: { crystal: 0.1 }, minLayer: 2, order: 1, stage: 1 },
  deepdrill:{ cat: "dig", name: "DEEP DRILL",     blurb: "Four times the rock, four times the crew. Layer 4 and deeper.", cost: { ore: 200, parts: 80 }, power: -12, staff: 4, out: { ore: 2 }, minLayer: 3, order: 1, stage: 5 },
  foundry:  { cat: "dig", name: "FOUNDRY",        blurb: "Smelts ore into parts.", cost: { ore: 70 }, power: -6, staff: 2, inp: { ore: 0.6 }, out: { parts: 0.25 }, order: 2, stage: 0 },

  farm:     { cat: "food", name: "FUNGUS FARM",   blurb: "Grows spore mats. Needs water.", cost: { ore: 35, water: 10 }, power: -2, staff: 2, inp: { water: 0.15 }, out: { fungus: 0.5 }, order: 1, stage: 0 },
  mess:     { cat: "food", name: "MESS HALL",     blurb: "Cooks spores into rations.", cost: { ore: 50 }, power: -2, staff: 2, inp: { fungus: 0.6, water: 0.1 }, out: { food: 0.5 }, order: 2, stage: 0 },
  hydro:    { cat: "food", name: "HYDROPONIC VAULT", blurb: "Grows rations straight from water. Hungry for power.", cost: { ore: 120, parts: 40, water: 30 }, power: -6, staff: 3, inp: { water: 0.3 }, out: { food: 1 }, order: 2, stage: 4 },

  stimden:  { cat: "goods", name: "STIM DEN",     blurb: "Somewhere to be somebody else for an hour. Entertainment for 12.", cost: { ore: 50, parts: 10 }, power: -3, staff: 1, ent: 12, order: 4, stage: 0 },
  workshop: { cat: "goods", name: "WORKSHOP",     blurb: "Makes goods people will pay for. Parts and water in.", cost: { ore: 60, parts: 20 }, power: -4, staff: 2, inp: { parts: 0.1, water: 0.05 }, out: { goods: 0.1 }, order: 3, stage: 1 },
  vidhall:  { cat: "goods", name: "VID HALL",     blurb: "Loud, bright, and for 30 people. Uses goods.", cost: { ore: 120, parts: 50 }, power: -5, staff: 2, ent: 30, inp: { goods: 0.02 }, order: 4, stage: 3 },
  assembler:{ cat: "goods", name: "ASSEMBLY LINE", blurb: "Goods by the crate.", cost: { ore: 140, parts: 60 }, power: -8, staff: 3, inp: { parts: 0.15, ore: 0.2 }, out: { goods: 0.4 }, order: 3, stage: 5 },

  bunk:     { cat: "home", name: "BUNK BLOCK",    blurb: "Beds in a stack. Houses 6.", cost: { ore: 40 }, power: -1, staff: 0, housing: 6, order: 9, stage: 0 },
  clinic:   { cat: "home", name: "MED BAY",       blurb: "Keeps people patched and a little less bitter.", cost: { ore: 70, parts: 25 }, power: -3, staff: 2, heal: 8, max: 2, order: 9, stage: 2 },
  habtower: { cat: "home", name: "HAB TOWER",     blurb: "A whole street, stood on end. Houses 16.", cost: { ore: 200, parts: 60 }, power: -4, staff: 0, housing: 16, order: 9, stage: 4 },
  arcology: { cat: "home", name: "ARCOLOGY",      blurb: "A district with its own weather. Houses 30 and entertains 24.", cost: { ore: 320, parts: 140, goods: 40 }, power: -8, staff: 2, housing: 30, ent: 24, inp: { goods: 0.02 }, order: 4, stage: 6 },
  barracks: { cat: "home", name: "GARRISON BARRACKS", blurb: "The old bunk halls, scrubbed out. Houses 14 and adds a little defence.", cost: { ore: 70, parts: 20 }, power: -2, staff: 0, housing: 14, def: 4, max: 3, repair: 45, biomes: ["ruin"], order: 9, stage: 0 },

  armoury:  { cat: "war", name: "ARMOURY",        blurb: "Turns parts and crystal into arms.", cost: { ore: 80, parts: 30 }, power: -6, staff: 3, inp: { parts: 0.2, crystal: 0.02 }, out: { arms: 0.1 }, order: 3, stage: 2 },
  turret:   { cat: "war", name: "TURRET NEST",    blurb: "Adds to the Civ's defence in every wave.", cost: { ore: 110, parts: 45 }, power: -2, staff: 1, def: 6, max: 3, order: 9, stage: 3 },
  shield:   { cat: "war", name: "SHIELD PROJECTOR", blurb: "A wall of humming air in front of the wall.", cost: { ore: 150, parts: 80, crystal: 20 }, power: -10, staff: 2, def: 12, max: 2, order: 9, stage: 4 },
  railgun:  { cat: "war", name: "RAIL BATTERY",   blurb: "Slow to reload and worth it.", cost: { ore: 180, parts: 90, crystal: 15 }, power: -10, staff: 2, def: 14, max: 3, order: 9, stage: 5 },
  bastion:  { cat: "war", name: "BASTION GUN",    blurb: "The last thing a wave hears.", cost: { ore: 260, parts: 150, crystal: 30 }, power: -14, staff: 3, def: 28, max: 2, order: 9, stage: 6 },
  arsenal:  { cat: "war", name: "IMPERIAL ARSENAL", blurb: "The old forge-floor, relit. Cheap arms from parts and ore.", cost: { ore: 50, parts: 30 }, power: -4, staff: 2, inp: { parts: 0.08, ore: 0.12 }, out: { arms: 0.2 }, max: 2, repair: 20, biomes: ["ruin"], order: 3, stage: 0 },
  gunline:  { cat: "war", name: "OLD GUN LINE",   blurb: "The garrison's own guns, back on their mounts.", cost: { ore: 40, parts: 40 }, power: -2, staff: 1, def: 10, max: 3, repair: 70, biomes: ["ruin"], order: 9, stage: 0 },

  lift:     { cat: "cargo", name: "CARGO LIFT",   blurb: "Carries 1.5 units a second up to the Civ.", cost: { ore: 50 }, power: -3, staff: 1, lift: 1.5, max: 4, order: 9, stage: 0 }
};
for (const id of Object.keys(B)) { B[id].id = id; }

/* ---- the stages ---------------------------------------------
   `need` is for ONE player; the server multiplies it by scaleFor().
   buff accumulates for every stage reached. Add more at the end
   whenever you like: nobody can see past the next one. Stages 1 to 6
   all carry something new to build. */
const STAGES = [
  { name: "SURVIVORS", need: null, buff: {}, text: "A few holes in the rock and a lot of nerve." },
  { name: "FOOTHOLD",  need: { ore: 1200, water: 600, fungus: 500, parts: 250 },
    buff: { yield: 0.05 }, text: "Burners, Workshops, gas and crystal. +5% output.", unlocks: ["burner", "geo", "siphon", "bore", "workshop"] },
  { name: "SETTLEMENT", need: { parts: 400, food: 250, goods: 40 },
    buff: { yield: 0.05, housing: 2 }, text: "Armouries and Med Bays. The Consortium notices. +5% output, +2 beds per colony.", unlocks: ["armoury", "clinic"], war: true },
  { name: "GARRISON", need: { arms: 150, crystal: 100, goods: 150, parts: 500 },
    buff: { yield: 0.05, def: 0.15 }, text: "Reactors, Vid Halls and Turret Nests. +5% output, +15% defence.", unlocks: ["reactor", "vidhall", "turret"] },
  { name: "BULWARK", need: { arms: 600, crystal: 300, food: 800, goods: 600, parts: 1200 },
    buff: { yield: 0.08, def: 0.2, lift: 0.25 }, text: "Hydroponics, Hab Towers and Shield Projectors. +8% output, +20% defence, +25% cargo.", unlocks: ["hydro", "habtower", "shield"] },
  { name: "STRONGHOLD", need: { arms: 1400, crystal: 700, goods: 1400, parts: 2600, fuel: 800 },
    buff: { yield: 0.08, def: 0.25, housing: 2 }, text: "Assembly Lines, Deep Drills and Rail Batteries. +8% output, +25% defence, +2 beds.", unlocks: ["assembler", "deepdrill", "railgun"] },
  { name: "CITADEL", need: { arms: 3000, crystal: 1500, goods: 3000, parts: 5500, fuel: 2000, food: 3000 },
    buff: { yield: 0.1, def: 0.3, lift: 0.25, housing: 3 }, text: "Fusion Cores, Arcologies and Bastion Guns. +10% output, +30% defence, +25% cargo, +3 beds.", unlocks: ["fusion", "arcology", "bastion"] }
];

/* Everything in the stage costs scales with how many are playing. A
   little under one-for-one, so a bigger server is a little quicker, not
   slower, and never a lot. */
function scaleFor(active) { return Math.pow(Math.max(1, active || 1), 0.8); }

/* One stage need is written for one player over a few hours; this makes it days. */
const NEED_K = Number(process.env.NEED_K) || 8;
const LIBERATE = { arms: 90, parts: 160, goods: 40 };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---- construction ------------------------------------------- */
function newCiv(now) {
  return { stage: 0, progress: {}, stock: {}, strain: 0, fallen: false, liberation: {}, breach: 0, brown: false,
    war: null, debt: {}, wins: 0, losses: 0, peak: 0, givers: {}, log: [], flow: {}, created: now || 0, upkeepAt: now || 0 };
}
function newWorld(now) { return { v: 2, civ: newCiv(now), colonies: {}, tickAt: now || 0, paused: null, events: [], evid: 0 }; }

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function num(v, d) { v = Number(v); return Number.isFinite(v) ? v : d; }

function say(list, now, text, keep) {
  list.push({ t: now, text: String(text).slice(0, 200) });
  while (list.length > (keep || 40)) list.shift();
}

/* Something a player should be told, even if they are not looking.
   `to` is a handle, or null for everyone. The panel turns these into
   FieldKit notifications. */
/* relay/colony.js listens here to pass news on to EMAIL UPDATES. */
let emitHook = null;
function onEmit(fn) { emitHook = typeof fn === "function" ? fn : null; }
function emit(world, now, to, level, text, kind) {
  if (!world.events) { world.events = []; world.evid = 0; }
  world.evid = (world.evid || 0) + 1;
  const ev = { id: world.evid, t: now, to: to || null, level: level || "info", kind: kind || "info", text: String(text).slice(0, 200) };
  world.events.push(ev);
  while (world.events.length > 240) world.events.shift();
  if (emitHook) { try { emitHook(world, ev); } catch (e) { /* news must never stop the game */ } }
}
function eventsFor(world, handle, since, limit) {
  const out = [];
  for (const e of world.events || []) {
    if (e.id > since && (!e.to || e.to === handle)) out.push({ id: e.id, t: e.t, level: e.level, kind: e.kind, text: e.text });
  }
  return out.slice(-(limit || 30));
}

/* ---- population of the server --------------------------------- */
function isFrozen(colony, now) { return now - colony.lastSeen > ACTIVE_MS; }
function activeColonies(world, now) {
  let n = 0;
  for (const h of Object.keys(world.colonies)) {
    const c = world.colonies[h];
    if (!c.collapsed && !isFrozen(c, now)) n++;
  }
  return n;
}
function activeScale(world, now) { return scaleFor(activeColonies(world, now)); }
function biomeOpen(world, id) {
  const b = has(BIOMES, id) ? BIOMES[id] : null;
  return !!b && (world.civ.peak >= b.at || b.at === 0);
}
/* May this player break ground here? */
function mayFound(world, id, admin) {
  if (!has(BIOMES, id)) return false;
  if (BIOMES[id].adminOnly) return !!admin;
  return biomeOpen(world, id);
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

/* What the Civ is asking for right now, per resource: the next stage's
   unmet needs, what is owed for upkeep, the war's arms, and the price
   of freedom. The automatic shipping rules lean on this. */
function civAsks(world, now) {
  const civ = world.civ, out = {};
  if (civ.fallen) {
    const need = liberationNeed(world, now);
    for (const r of Object.keys(need)) if ((civ.liberation[r] || 0) < need[r]) out[r] = true;
  } else {
    const need = needFor(world, now, civ.stage + 1);
    if (need) for (const r of Object.keys(need)) if ((civ.progress[r] || 0) < need[r]) out[r] = true;
  }
  for (const r of Object.keys(civ.debt || {})) if (civ.debt[r] > 1) out[r] = true;
  if (civ.war && civ.stage >= 2) {
    const d = defenceNow(world);
    if (d.total < civ.war.strength * 1.15) out.arms = true;
  }
  return out;
}

/* ---- the colony ---------------------------------------------- */
function newColony(handle, biome, name, now) {
  const grid = [];
  for (let l = 0; l < MAX_LAYERS; l++) { grid.push(new Array(SLOTS).fill(null)); }
  const put = (l, s, t) => { grid[l][s] = { t: t, on: true }; };
  put(0, 0, "scrubber"); put(0, 1, "cell"); put(0, 2, "cell"); put(0, 3, "drill"); put(0, 4, "pump"); put(0, 5, "lift");
  const stock = { ore: 140, water: 70, fungus: 60, food: 120, parts: 20, crystal: 0, fuel: 0, goods: 0, arms: 0 };
  if (biome === "ruin") { stock.ore = 180; stock.parts = 140; stock.arms = 150; }
  return {
    handle: handle, name: name, biome: biome, born: now, lastSeen: now, collapsed: false, frozen: false, repair: 0,
    layers: 1, dig: null, grid: grid, stock: stock,
    pop: 8, hap: 70, sat: { food: 1, goods: 1 }, ship: Object.assign({}, DEFAULT_SHIP), given: 0,
    stats: {}, log: [], crisis: 0, safe: false, shipped: {},
    rate: {}, made: {}, use: {}, sent: {}, eff: {}, fl: {}
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
function costSum(cost) { let n = 0; for (const r of Object.keys(cost)) n += cost[r]; return n; }

/* The old garrison is repaired by building in it: every unit spent
   restores a sliver. Past each quarter something is found. */
function repairBy(world, colony, now, points) {
  if (colony.biome !== "ruin" || colony.repair >= 100) return;
  const before = colony.repair;
  colony.repair = Math.min(100, colony.repair + points);
  for (const m of [25, 50, 75, 100]) {
    if (before < m && colony.repair >= m) {
      const what = m === 25 ? "The lower armoury vaults are open. 100 arms were still crated inside."
        : m === 50 ? "The barracks halls are clear. Garrison Barracks can be built."
        : m === 75 ? "The old gun mounts are free of rubble. Old Gun Lines can be built."
        : "THE GARRISON STANDS AGAIN. Every wall and arch is sound.";
      if (m === 25) colony.stock.arms = Math.min(STOCK_CAP, (colony.stock.arms || 0) + 100);
      say(colony.log, now, "Repaired to " + m + "%. " + what, 20);
      emit(world, now, colony.handle, "ok", "The old garrison is " + m + "% repaired. " + what, "repair");
    }
  }
}

/* ---- what a colony can do (all checked here, on the server) ---- */
function build(world, colony, layer, slot, type, now) {
  const b = has(B, type) ? B[type] : null;
  if (!b) return { error: "unknown building" };
  if (colony.collapsed) return { error: "this colony has fallen" };
  layer = layer | 0; slot = slot | 0;
  if (layer < 0 || layer >= colony.layers || slot < 0 || slot >= SLOTS) return { error: "no such plot" };
  if (colony.grid[layer][slot]) return { error: "that plot is taken" };
  if (b.stage > world.civ.stage) return { error: "the Civilization has not unlocked that yet" };
  if ((b.minLayer || 0) > layer) return { error: "needs layer " + ((b.minLayer || 0) + 1) + " or deeper" };
  if (b.biomes && b.biomes.indexOf(colony.biome) < 0) return { error: "this biome cannot run that" };
  if (b.repair && colony.repair < b.repair) return { error: "the garrison must be " + b.repair + "% repaired first (it is " + Math.floor(colony.repair) + "%)" };
  if (b.max && countOf(colony, type) >= b.max) return { error: "you have as many as you can run (" + b.max + ")" };
  if (!canAfford(colony.stock, b.cost)) return { error: "not enough materials" };
  pay(colony.stock, b.cost);
  colony.grid[layer][slot] = { t: type, on: true, built: now || 0 };
  repairBy(world, colony, now || 0, costSum(b.cost) * 0.03);
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
  colony.dig = { start: now, done: now + digSeconds(colony) * 1000 };
  repairBy(world, colony, now, 1);
  return { ok: true };
}

/* mode: a number 0..100, or one of MODES. */
function setShip(colony, res, mode) {
  if (RES.indexOf(res) < 0) return { error: "unknown resource" };
  if (typeof mode === "string" && MODES.indexOf(mode) >= 0) colony.ship[res] = mode;
  else if (typeof mode === "number" || (typeof mode === "string" && mode.trim() !== "" && Number.isFinite(Number(mode)))) colony.ship[res] = clamp(Math.round(Number(mode)), 0, 100);
  else return { error: "unknown way to ship" };
  return { ok: true };
}
function setPreset(colony, preset) {
  if (MODES.indexOf(preset) < 0) return { error: "unknown preset" };
  for (const r of RES) colony.ship[r] = preset;
  return { ok: true };
}

/* Woken by its owner after being paused for a week or more. */
function wake(world, colony, now) {
  if (colony.frozen) {
    const away = now - (colony.frozenAt || now);
    if (colony.dig) { colony.dig.done += away; if (colony.dig.start) colony.dig.start += away; }
    colony.frozen = false; colony.frozenAt = 0;
    say(colony.log, now, "Your colony was paused while you were away. It is running again.", 20);
    emit(world, now, colony.handle, "info", "Welcome back. Your colony was paused while you were away and is running again.", "wake");
  }
  /* Back after being away: ten minutes before anyone can starve, to
     look around and fix what ran out while you slept. */
  if (now - colony.lastSeen > ONLINE_MS) colony.grace = now + 10 * 60 * 1000;
  colony.lastSeen = now;
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
  civ.accum = civ.accum || {};
  civ.accum[res] = (civ.accum[res] || 0) + amount;
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
      emit(world, now, null, "ok", "THE CIVILIZATION IS LIBERATED. It stands again.", "liberated");
    }
    return;
  }
  const need = needFor(world, now, civ.stage + 1);
  if (!need) return;
  if (Object.keys(need).every((r) => (civ.progress[r] || 0) >= need[r])) {
    civ.stage++; civ.progress = {};
    say(civ.log, now, "STAGE " + civ.stage + " REACHED: " + STAGES[civ.stage].name + ".");
    emit(world, now, null, "ok", "STAGE " + civ.stage + " REACHED: " + STAGES[civ.stage].name + ". New buildings are open to everyone.", "stage");
    if (STAGES[civ.stage].war && !civ.war) scheduleWave(world, now, WAVE_FIRST_MS);
  }
}

/* ---- war ----------------------------------------------------- */
function waveStrength(world, now) {
  return Math.round(250 * Math.pow(1.3, Math.max(0, world.civ.stage - 2)) * activeScale(world, now));
}
function scheduleWave(world, now, delay) {
  world.civ.war = { at: now + delay, strength: waveStrength(world, now), w60: false, w10: false };
}
function defenceNow(world, now) {
  const civ = world.civ;
  let turrets = 0;
  for (const h of Object.keys(world.colonies)) {
    const c = world.colonies[h];
    if (c.collapsed || c.frozen) continue;
    for (const row of c.grid) for (const s of row) if (s && s.on && B[s.t].def) turrets += B[s.t].def;
    if (c.biome === "ruin") turrets += c.repair / 10;      /* the old wall emplacements */
  }
  const f = 1 + buffs(civ).def;
  return { arms: civ.stock.arms || 0, turrets: turrets, total: ((civ.stock.arms || 0) + turrets) * f };
}
function resolveWave(world, now) {
  const civ = world.civ, w = civ.war;
  const d = defenceNow(world, now);
  if (d.total >= w.strength) {
    const spend = Math.min(civ.stock.arms || 0, Math.round(w.strength * 0.6));
    civ.stock.arms = (civ.stock.arms || 0) - spend;
    civ.breach = Math.max(0, civ.breach - 15); civ.wins++;
    say(civ.log, now, "WAVE REPELLED. " + w.strength + " against " + Math.round(d.total) + ". " + spend + " arms spent.");
    emit(world, now, null, "ok", "WAVE REPELLED. The wall held against " + w.strength + ". " + spend + " arms spent.", "wave");
  } else {
    const short = 1 - d.total / w.strength;
    civ.stock.arms = 0;
    if (!civ.fallen) civ.breach += Math.round(12 + 24 * short);
    civ.losses++;
    if (!civ.fallen) {
      say(civ.log, now, "WAVE BROKE THROUGH. " + w.strength + " against " + Math.round(d.total) + ". The wall is cracking (" + civ.breach + "/100).");
      emit(world, now, null, "bad", "A WAVE BROKE THROUGH. " + w.strength + " against " + Math.round(d.total) + ". The wall is at " + Math.max(0, 100 - civ.breach) + "%.", "wave");
    }
    if (civ.breach >= 100 && !civ.fallen) {
      civ.fallen = true; civ.breach = 50; civ.liberation = {};
      for (const r of Object.keys(civ.stock)) civ.stock[r] = Math.floor((civ.stock[r] || 0) * 0.5);
      say(civ.log, now, "THE CIVILIZATION HAS FALLEN. Half its stores are gone. Advancement is slower and buffs are halved until it is liberated.");
      emit(world, now, null, "bad", "THE CIVILIZATION HAS FALLEN. Half its stores are gone. Everyone: ship what the Civilization needs to liberate it.", "fall");
    }
  }
  scheduleWave(world, now, WAVE_MS);
}

/* ---- one colony, one step ------------------------------------ */
function ema(o, k, v, a) { o[k] = (o[k] || 0) + (v - (o[k] || 0)) * a; }

function stepColony(world, colony, now, dt, asks) {
  const civ = world.civ;
  if (colony.collapsed) return;
  if (isFrozen(colony, now)) {
    if (!colony.frozen) { colony.frozen = true; colony.frozenAt = now; }
    return;
  }
  const online = now - colony.lastSeen < ONLINE_MS;
  colony.safe = !online;
  const biome = BIOMES[colony.biome] || BIOMES.seam;
  const bf = buffs(civ);
  const st = colony.stock;
  const before = {};
  for (const r of RES) before[r] = st[r] || 0;
  const used = {};
  const useUp = (k, v) => { used[k] = (used[k] || 0) + v; };

  /* digging */
  if (colony.dig && now >= colony.dig.done) {
    colony.layers = Math.min(MAX_LAYERS, colony.layers + 1); colony.dig = null;
    say(colony.log, now, "Layer " + colony.layers + " is open.", 20);
    emit(world, now, colony.handle, "ok", "Layer " + colony.layers + " is open. Room to build.", "dig");
  }

  /* what is built and on */
  const live = [];
  for (let l = 0; l < colony.layers; l++) for (let s = 0; s < SLOTS; s++) {
    const c = colony.grid[l][s];
    if (c && c.on) live.push({ b: B[c.t], l: l });
  }
  const pop = Math.floor(colony.pop);
  const repairHousing = colony.biome === "ruin" ? Math.floor(colony.repair / 25) : 0;
  const housing = BASE_HOUSING + bf.housing + repairHousing + live.reduce((a, x) => a + (x.b.housing || 0), 0);
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
      if (b.inp) for (const k of Object.keys(b.inp)) { st[k] -= b.inp[k] * dt * r; useUp(k, b.inp[k] * dt * r); }
      /* a machine nobody has to crew does not slow down for want of people */
      supply += b.power * r * (b.staff ? staffF : 1);
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
    const svc = pf * (b.staff ? staffF : 1);
    if (b.air) airCap += b.air * svc;
    if (b.heal) heal += b.heal * svc;
    if (b.lift) liftCap += b.lift * svc * (1 + bf.lift);
    if (b.out || b.ent) {
      let r = b.out ? E : svc;
      if (b.inp) for (const k of Object.keys(b.inp)) r = Math.min(r, (st[k] || 0) / (b.inp[k] * dt));
      r = Math.max(0, r);
      if (b.inp) for (const k of Object.keys(b.inp)) { st[k] -= b.inp[k] * dt * r; useUp(k, b.inp[k] * dt * r); }
      if (b.ent) entCap += b.ent * r;
      if (b.out) for (const k of Object.keys(b.out)) {
        let m = k === "crystal" ? crystalMult(x.l) : (biome.mult[k] || 1);
        if (k === "arms" && colony.biome === "ruin") m *= 1 + colony.repair / 200;
        made[k] = (made[k] || 0) + b.out[k] * dt * r * m;
      }
    }
  }

  /* shipping: a share of what was made goes up, as far as the lifts
     can carry. Offline, the share kept at home is only 30%. */
  let room = liftCap * dt, sentTotal = 0;
  const sentNow = {};
  for (const k of Object.keys(made)) {
    const amt = made[k];
    const share = shareFor(colony, k, online, asks);
    ema(colony.eff, k, share, Math.min(1, dt / 40));
    const send = Math.min(amt * share, room);
    room -= send; sentTotal += send;
    if (send > 0) { deliver(world, now, colony, k, send); sentNow[k] = send; }
    const keep = amt - send;
    /* Away, what the colony's own buildings use is kept in full up to its
       working stock, so a chain (ore to parts to goods) keeps running; only
       the rest falls under the away rule. */
    let full = online ? keep : 0;
    if (!online && (colony.use[k] || 0) > 0) full = Math.min(keep, Math.max(0, bufferFor(colony, k, typeof colony.ship[k] === "string" ? colony.ship[k] : "surplus") - (st[k] || 0)));
    st[k] = Math.min(STOCK_CAP, (st[k] || 0) + full + (keep - full) * OFFLINE_KEEP);
  }
  /* The automatic rules also clear what has piled up beyond twice what the
     colony needs, a little at a time, as far as the lifts allow. */
  for (const k of RES) {
    const m = colony.ship[k];
    if ((m !== "surplus" && m !== "all") || room <= 0) continue;
    const over = (st[k] || 0) - 2 * bufferFor(colony, k, m);
    if (over <= 0 || (online && (st[k] || 0) < (RESERVE[k] || 0))) continue;
    const send = Math.min(room, over * Math.min(1, dt / 240));
    if (send <= 0) continue;
    st[k] -= send; room -= send; sentTotal += send;
    deliver(world, now, colony, k, send); sentNow[k] = (sentNow[k] || 0) + send;
  }

  /* people eat, and buy things */
  const wantFood = pop * EAT * dt, wantGoods = pop * USE_GOODS * dt;
  const gotFood = Math.min(st.food || 0, wantFood), gotGoods = Math.min(st.goods || 0, wantGoods);
  st.food = (st.food || 0) - gotFood; st.goods = (st.goods || 0) - gotGoods;
  useUp("food", gotFood); useUp("goods", gotGoods);
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

  /* the rates the panel runs on between visits */
  const a = Math.min(1, dt / 20);
  for (const r of RES) {
    ema(colony.rate, r, ((st[r] || 0) - before[r]) / dt, a);
    ema(colony.made, r, (made[r] || 0) / dt, a);
    ema(colony.use, r, (used[r] || 0) / dt, a);
    ema(colony.sent, r, (sentNow[r] || 0) / dt, a);
  }
  colony.stats = { power: [Math.round(supply), Math.round(demand)], staff: [Math.min(need, pop), need], air: [Math.round(airCap), pop],
    ent: [Math.round(entCap), pop], housing: housing, lift: Math.round(liftCap * 10) / 10, eff: Math.round(E * 100) / 100,
    liftUse: liftCap > 0 ? Math.round(sentTotal / (liftCap * dt) * 100) / 100 : 0 };

  /* warnings for the player, once each time a problem starts */
  if (online) {
    const flag = (key, bad, level, text, kind) => {
      if (bad && !colony.fl[key]) { colony.fl[key] = 1; emit(world, now, colony.handle, level, text, kind); }
      else if (!bad && colony.fl[key]) colony.fl[key] = 0;
    };
    flag("hungry", colony.sat.food < 0.4, "bad", "Your colony is running out of food.", "food");
    flag("choke", air < 0.75, "bad", "The air is going bad. Build or repair an air scrubber.", "air");
    flag("dark", pf < 0.6 && demand > 0, "warn", "Power is failing. Buildings are slowing down.", "power");
    flag("bitter", colony.hap < 30, "warn", "Your people are miserable. Food, air and entertainment all count.", "mood");
  }

  /* people come and go. Offline, nobody dies and the mood never
     falls below 20: coming back to a dead colony would punish
     going to sleep. */
  if (!online) { if (colony.hap < 20) colony.hap = 20; }
  const hungry = colony.sat.food < 0.3, choking = air < 0.5, bitter = colony.hap < 25;
  const grace = now < (colony.grace || 0);
  if (online && !grace && (hungry || choking || bitter)) {
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
    emit(world, now, colony.handle, "bad", "Everyone is gone. Your colony has fallen. You can start again.", "collapse");
  }
}

/* What an automatic rule keeps back: a little of what the colony uses, and a
   fund for building. */
function bufferFor(colony, k, m) {
  const floor = (RESERVE[k] || 0) * 1.5 + 20;
  const fund = (FUND[k] || 0) * (m === "lean" ? 2 : 1) * (1 + 0.25 * colony.layers);
  return Math.max(floor, (colony.use[k] || 0) * (MODE_BUFFER_S[m] || 900), fund);
}

/* How much of what was just made goes up. */
function shareFor(colony, k, online, asks) {
  const m = colony.ship[k];
  const st = colony.stock[k] || 0;
  if (online && st < (RESERVE[k] || 0)) return 0;
  if (typeof m === "number") return clamp(m / 100, 0, 1);
  if (m === "all") return 1;
  if (m === "none") return 0;
  const asked = !!(asks && asks[k]);
  const buf = bufferFor(colony, k, m);
  const floor = (RESERVE[k] || 0) * 1.5 + 20;
  if (m === "lean") {
    const open = clamp((st - buf * 0.5) / (buf * 0.5), 0, 1);
    return open * (asked ? 0.5 : 0.25);
  }
  /* surplus: closes smoothly as the stock falls toward what is needed */
  const open = clamp((st - buf * 0.5) / (buf * 0.5), 0, 1);
  return asked ? Math.max(open, open * 0.5 + 0.5 * (st > floor ? 1 : 0)) : open;
}

/* ---- the world, one step ------------------------------------- */
const STEP = 15;

function stepWorld(world, now) {
  const civ = world.civ;
  let dt = (now - world.tickAt) / 1000;
  if (!(dt > 0)) { world.tickAt = now; return; }
  if (world.paused) {
    /* Time stops: nothing runs, and every timer is pushed back by as
       long as it stood still. */
    const ms = now - world.tickAt;
    if (civ.war) civ.war.at += ms;
    for (const h of Object.keys(world.colonies)) {
      const c = world.colonies[h];
      c.lastSeen += ms;
      if (c.dig) { c.dig.done += ms; if (c.dig.start) c.dig.start += ms; }
    }
    world.tickAt = now;
    return;
  }
  dt = Math.min(dt, 6 * 3600);
  let t = world.tickAt;
  const handles = Object.keys(world.colonies);
  while (dt > 0) {
    const h = Math.min(STEP, dt);
    t += h * 1000; dt -= h;
    civ.peak = Math.max(civ.peak, activeColonies(world, t));
    const asks = civAsks(world, t);
    civ.accum = {};
    for (const id of handles) stepColony(world, world.colonies[id], t, h, asks);
    for (const k of RES) civ.flow[k] = (civ.flow[k] || 0) + ((civ.accum[k] || 0) / h - (civ.flow[k] || 0)) * Math.min(1, h / 30);
    upkeep(world, t, h);
    checkAdvance(world, t);
    if (civ.war) {
      if (!civ.war.w60 && t >= civ.war.at - 3600000 && t < civ.war.at) { civ.war.w60 = true; emit(world, t, null, "warn", "A WAVE ARRIVES IN ONE HOUR. Strength " + civ.war.strength + ", defence " + Math.round(defenceNow(world, t).total) + ".", "war"); }
      if (!civ.war.w10 && t >= civ.war.at - 600000 && t < civ.war.at) { civ.war.w10 = true; emit(world, t, null, "bad", "A WAVE ARRIVES IN TEN MINUTES. Strength " + civ.war.strength + ", defence " + Math.round(defenceNow(world, t).total) + ".", "war"); }
      if (t >= civ.war.at) resolveWave(world, t);
    }
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
  const brown = civ.strain >= 100;
  if (brown !== !!civ.brown) {
    civ.brown = brown;
    emit(world, now, null, brown ? "bad" : "ok", brown ? "BROWNOUT: the Civilization cannot pay upkeep and its buffs are off. Ship water and parts." : "The Civilization's upkeep is paid again. Buffs are back.", "brownout");
  }
}

/* ---- advice ---------------------------------------------------
   What this colony would do well to do next, in order. Each item may
   name a building (the panel offers it with one click) and says why. */
function adviseFor(world, colony, now) {
  const civ = world.civ, st = colony.stock, s = colony.stats || {};
  const out = [];
  if (!s.power) return out;
  const pop = Math.floor(colony.pop);
  const n = (id) => countOf(colony, id);
  const avail = (id) => {
    const b = B[id];
    return !!b && b.stage <= civ.stage && (!b.biomes || b.biomes.indexOf(colony.biome) >= 0) && (!b.max || n(id) < b.max) &&
      (!b.repair || colony.repair >= b.repair) && (b.minLayer || 0) < colony.layers;
  };
  const MAKER = { ore: "drill", water: "pump", fungus: "farm", parts: "foundry", food: "mess", crystal: "bore", fuel: "siphon", goods: "workshop" };
  const madeNone = (r) => (colony.made[r] || 0) <= 0 && !(MAKER[r] && n(MAKER[r]));
  /* a building whose input nobody here makes would stand idle */
  const fed = (id) => !B[id].inp || Object.keys(B[id].inp).every((r) => !madeNone(r) || (st[r] || 0) >= 30);
  /* the first that can be built now, runs, and is paid for; else the first that runs; else the first that can be built */
  const pick = (ids) => ids.find((id) => avail(id) && fed(id) && canAfford(st, B[id].cost)) || ids.find((id) => avail(id) && fed(id)) || ids.find(avail) || null;
  const push = (id, sev, text, build, res) => out.push({ id: id, sev: sev, text: text, build: build || null, res: res || null });
  const rate = (r) => colony.rate[r] || 0;
  const asks = civAsks(world, now);
  const freeSlot = colony.grid.slice(0, colony.layers).some((row) => row.some((c) => !c));

  if (colony.collapsed) return out;
  if (s.air[0] < pop) push("air", "bad", "The air will not stretch to everyone (" + s.air[0] + " of " + pop + ").", pick(["scrubber"]));
  if (s.power[0] < s.power[1]) push("power", "bad", "Not enough power: " + s.power[0] + " of " + s.power[1] + ". Everything is running slow.", pick(["fusion", "reactor", "geo", "burner", "cell"]));
  if (colony.sat.food < 0.7 || ((st.food || 0) < pop * 4 && rate("food") <= 0)) {
    if (n("mess") + n("hydro") === 0) push("food", "bad", "Nothing is cooking. People eat 0.02 food a second each.", pick(["mess", "hydro"]));
    else if ((st.fungus || 0) < 30 && n("hydro") === 0 && rate("fungus") <= 0) push("food", "bad", "The mess hall is starved of fungus.", pick(["farm"]));
    else if ((st.water || 0) < 20 && rate("water") <= 0) push("food", "warn", "Water is nearly out, and food needs it.", pick(["pump"]));
    else push("food", "warn", "Food is not keeping up with the people eating it.", pick(["hydro", "mess"]));
  }
  if (pop >= s.housing - 1 && colony.hap >= 40) push("home", "warn", "Beds are full (" + pop + " of " + s.housing + "). Nobody new can move in.", pick(["habtower", "arcology", "bunk"]));
  if (s.ent[0] < pop) push("ent", pop - s.ent[0] > 6 ? "warn" : "tip", "People need somewhere to unwind (" + s.ent[0] + " of " + pop + " covered).", pick(["arcology", "vidhall", "stimden"]));
  if (s.staff[0] < s.staff[1]) {
    /* beds only help when the beds are what is full; otherwise say what
       is stopping people moving in (stepColony: mood 55, air, food) */
    if (pop >= s.housing - 1) push("staff", "warn", "There are " + s.staff[1] + " jobs and " + s.staff[0] + " people. Machines are idle. More beds mean more people.", pick(["habtower", "bunk"]));
    else {
      const why = colony.sat.food <= 0.9 || (st.food || 0) <= pop * 3 ? "food in store" : s.air[0] < pop ? "air for everyone" : colony.hap < 55 ? "a happier colony (" + Math.round(colony.hap) + "%, needs 55%)" : null;
      if (why) push("staff", "tip", "There are " + s.staff[1] + " jobs and " + s.staff[0] + " people. You have beds; new people come when there is " + why + ".");
    }
  }
  if (civ.stage >= 1 && colony.sat.goods < 0.5 && (n("workshop") + n("assembler")) === 0) push("goods", "warn", "People want goods and nobody makes any.", pick(["assembler", "workshop"]));
  if (s.liftUse > 0.95 && Object.keys(colony.made).some((r) => colony.made[r] > 0)) push("lift", "warn", "The lifts are full. What you make piles up instead of going up.", pick(["lift"]));
  if (colony.hap < 40 && colony.hap >= 0) push("mood", "warn", "Your people are unhappy (" + Math.round(colony.hap) + "%). Fix food, air or entertainment first.");
  if (civ.war && civ.stage >= 2) {
    const d = defenceNow(world, now);
    if (d.total < civ.war.strength) {
      const gap = Math.ceil(civ.war.strength - d.total);
      push("war", d.total < civ.war.strength * 0.6 ? "bad" : "warn", "The next wave beats our defence by " + gap + ". Ship ARMS, and build guns.", pick(["bastion", "railgun", "shield", "turret", "gunline", "armoury", "arsenal"]), "arms");
    }
  }
  if (civ.brown) push("brown", "bad", "The Civilization cannot pay its upkeep. Ship water and parts.", null, "water");
  /* asked for, and nothing goes up: none made, or your own buildings use it all */
  const usesAll = (r) => (colony.made[r] || 0) > 0 && (colony.sent[r] || 0) < (colony.made[r] || 0) * 0.05 && (colony.use[r] || 0) >= (colony.made[r] || 0) * 0.8;
  const topAsk = Object.keys(asks).filter((r) => r !== "arms" && has(colony.made, r) && ((colony.made[r] || 0) === 0 || usesAll(r)))[0];
  if (topAsk && !out.some((o) => o.id === "ask")) {
    const mk = { ore: "drill", water: "pump", fungus: "farm", parts: "foundry", goods: pick(["assembler", "workshop"]), food: pick(["hydro", "mess"]), crystal: "bore", fuel: "siphon", arms: "armoury" }[topAsk];
    if (mk && avail(mk)) push("ask", "tip", "The Civilization is asking for " + topAsk.toUpperCase() + (usesAll(topAsk) ? ", and your own buildings use all you make. Build another." : " and you make none."), mk, topAsk);
  }
  const freeCount = colony.grid.slice(0, colony.layers).reduce((a, row) => a + row.filter((c) => !c).length, 0);
  const canDeeper = !colony.dig && colony.layers < layerCap(civ);
  if (canDeeper && !freeSlot) push("room", "warn", "You are out of room. Click the dig site at the bottom of your colony to open layer " + (colony.layers + 1) + ".");
  else if (canDeeper && canAfford(st, digCost(colony)) && (colony.layers <= 2 || freeCount <= 2)) push("dig", "tip", "Dig layer " + (colony.layers + 1) + " (the dig site at the bottom): 8 more plots, and deeper ground is richer.");
  else if (!colony.dig && colony.layers < MAX_LAYERS && colony.layers >= layerCap(civ) && freeCount <= 1 && !civ.fallen)
    push("deeper", "tip", "Layer " + (colony.layers + 1) + " opens when the Civilization reaches stage " + (colony.layers - 1) + ". Ship what it asks for to get there.");
  if (colony.biome === "ruin" && colony.repair < 100) push("repair", "tip", "The garrison is " + Math.floor(colony.repair) + "% repaired. Everything you build restores more of it.");
  if (colony.sent && !out.length) {
    const askedRes = Object.keys(asks)[0];
    if (askedRes && typeof colony.ship[askedRes] === "string" && colony.ship[askedRes] !== "all") push("give", "tip", "All is well here. The Civilization needs " + askedRes.toUpperCase() + ": you could send more.", null, askedRes);
  }
  /* Starved by your own shipping: the colony makes it, but ships all of it. */
  {
    let starved = null;
    for (const row of colony.grid.slice(0, colony.layers)) for (const c of row) {
      const b = c && c.on && B[c.t];
      if (starved || !b || !b.inp) continue;
      for (const r of Object.keys(b.inp)) {
        const m = colony.ship[r];
        if ((colony.made[r] || 0) > 0 && (st[r] || 0) < b.inp[r] * 60 && (m === "all" || (typeof m === "number" && m >= 90))) { starved = { t: c.t, r: r }; break; }
      }
    }
    if (starved) push("starved", "warn", "Your " + B[starved.t].name + " is starved of " + starved.r.toUpperCase() + ": you ship all of it. Set " + starved.r.toUpperCase() + " to SURPLUS so it keeps what it needs.", null, starved.r);
    if (starved) out[out.length - 1].ship = { res: starved.r, mode: "surplus" };
  }
  /* A fix you cannot pay for because you make none of something it needs
     (no foundry, so no parts) is no fix: say what to build first. */
  const lacking = (cost) => Object.keys(cost || {}).filter((r) => (st[r] || 0) < cost[r] && madeNone(r) && MAKER[r] && avail(MAKER[r]));
  for (const o of out) {
    const cost = o.build ? B[o.build].cost : (o.id === "room" || o.id === "dig") ? digCost(colony) : null;
    const r = cost && !canAfford(st, cost) ? lacking(cost)[0] : null;
    if (r && MAKER[r] !== o.build) {
      o.text += " That needs " + r.toUpperCase() + ", and you make none: build a " + B[MAKER[r]].name + " first.";
      o.build = MAKER[r]; o.res = r;
      continue;
    }
    const inp = o.build && B[o.build].inp ? Object.keys(B[o.build].inp).filter((x) => madeNone(x) && (st[x] || 0) < 30 && MAKER[x] && avail(MAKER[x]))[0] : null;
    if (inp) {
      o.text += " A " + B[o.build].name + " runs on " + inp.toUpperCase() + ", and you make none: build a " + B[MAKER[inp]].name + " first.";
      o.build = MAKER[inp]; o.res = inp;
    }
  }
  /* Out of room, with plots doing nothing useful: beds nobody sleeps in. */
  if (!freeSlot && out.some((o) => o.build || o.id === "deeper")) {
    const spare = s.housing - Math.max(pop, 1) - 6;
    let idle = null;
    for (const row of colony.grid.slice(0, colony.layers)) for (const c of row) {
      const b = c && B[c.t];
      if (!idle && b && b.inp && Object.keys(b.inp).some((r) => madeNone(r) && (st[r] || 0) < 1)) idle = c.t;
    }
    if (idle) out.push({ id: "spare", sev: "bad", text: "Every plot is taken, and your " + B[idle].name + " stands idle: nothing here makes " + Object.keys(B[idle].inp).filter((r) => madeNone(r)).map((r) => r.toUpperCase()).join(" or ") + ". Demolish it (click it, then DEMOLISH) to make room.", build: null, res: null, demolish: idle });
    else if (n("bunk") && spare >= 6) out.push({ id: "spare", sev: "bad", text: "Every plot is taken, and " + spare + " beds stand empty. Demolish a BUNK BLOCK (click it, then DEMOLISH) to make room for what you need.", build: null, res: null, demolish: "bunk" });
  }
  const rank = { bad: 0, warn: 1, tip: 2 };
  out.sort((x, y) => rank[x.sev] - rank[y.sev]);
  return out.slice(0, 6);
}

/* ---- what a player is shown ---------------------------------- */
function buildingView(id) {
  const b = B[id];
  return { id: id, name: b.name, blurb: b.blurb, cat: b.cat, cost: b.cost, power: b.power, staff: b.staff || 0, inp: b.inp || null, out: b.out || null,
    housing: b.housing || 0, ent: b.ent || 0, air: b.air || 0, def: b.def || 0, lift: b.lift || 0, heal: b.heal || 0,
    max: b.max || 0, minLayer: b.minLayer || 0, repair: b.repair || 0, stage: b.stage };
}

/* Current stage and the next only, and only what this biome can run. A
   building two stages out is not in the list at all. */
function catalogFor(civ, biome) {
  const out = [];
  for (const id of Object.keys(B)) {
    const b = B[id];
    if (b.biomes && biome && b.biomes.indexOf(biome) < 0) continue;
    if (b.stage <= civ.stage) out.push(buildingView(id));
    else if (b.stage === civ.stage + 1) out.push({ id: id, name: b.name, blurb: "", cat: b.cat, locked: true, stage: b.stage });
  }
  return out;
}

function viewFor(world, now, handle, admin) {
  const civ = world.civ;
  const colony = has(world.colonies, handle) ? world.colonies[handle] : null;
  const active = activeColonies(world, now);
  const next = civ.fallen ? null : (STAGES[civ.stage + 1] || null);
  const nextNeed = next ? needFor(world, now, civ.stage + 1) : null;
  const top = Object.keys(civ.givers).map((h) => ({ name: civ.givers[h].name, v: Math.round(civ.givers[h].v), me: h === handle }))
    .sort((a, b) => b.v - a.v).slice(0, 5);
  const bf = buffs(civ);
  const biomes = Object.keys(BIOMES).filter((id) => !BIOMES[id].adminOnly || admin)
    .filter((id) => BIOMES[id].at <= civ.peak + 3 || biomeOpen(world, id)).map((id) => ({
      id: id, name: BIOMES[id].name, blurb: BIOMES[id].blurb, open: BIOMES[id].adminOnly ? !!admin : biomeOpen(world, id), at: BIOMES[id].at, admin: !!BIOMES[id].adminOnly }));
  const asks = civAsks(world, now);
  const view = {
    now: now,
    paused: world.paused ? { since: world.paused.since, by: world.paused.by } : null,
    ev: world.evid || 0,
    civ: {
      stage: civ.stage, name: STAGES[civ.stage].name, text: STAGES[civ.stage].text,
      next: next ? { name: next.name, text: next.text, need: nextNeed, progress: civ.progress } : null,
      fallen: civ.fallen,
      liberation: civ.fallen ? { need: liberationNeed(world, now), progress: civ.liberation } : null,
      stock: civ.stock, strain: Math.round(civ.strain), brownout: civ.strain >= 100,
      flow: civ.flow, asks: asks,
      buffs: bf, active: active, colonies: Object.keys(world.colonies).filter((h) => !world.colonies[h].collapsed).length,
      war: STAGES[civ.stage].war || civ.stage >= 2 ? {
        at: civ.war ? civ.war.at : null, strength: civ.war ? civ.war.strength : null,
        defence: Math.round(defenceNow(world, now).total), breach: civ.breach, wins: civ.wins, losses: civ.losses } : null,
      top: top, log: civ.log.slice(-12).reverse()
    },
    biomes: biomes,
    cats: CATS,
    catalog: catalogFor(civ, colony ? colony.biome : null),
    constants: { slots: SLOTS, maxLayers: MAX_LAYERS, layerCap: layerCap(civ), stockCap: STOCK_CAP, offlineKeep: OFFLINE_KEEP, res: RES, modes: MODES, reserve: RESERVE },
    colony: null
  };
  if (colony) {
    const adv = adviseFor(world, colony, now);
    view.colony = {
      name: colony.name, biome: colony.biome, collapsed: colony.collapsed, frozen: !!colony.frozen, layers: colony.layers,
      repair: colony.biome === "ruin" ? Math.floor(colony.repair * 10) / 10 : null,
      dig: colony.dig ? { left: Math.max(0, Math.round((colony.dig.done - now) / 1000)), total: Math.round((colony.dig.done - (colony.dig.start || now)) / 1000) } : null,
      digCost: colony.layers < layerCap(civ) ? digCost(colony) : null, digSeconds: digSeconds(colony),
      grid: colony.grid.slice(0, colony.layers).map((row) => row.map((c) => c ? { t: c.t, on: c.on, built: c.built || 0 } : null)),
      stock: Object.keys(colony.stock).reduce((o, r) => { o[r] = Math.floor(colony.stock[r] * 10) / 10; return o; }, {}),
      rate: RES.reduce((o, r) => { o[r] = Math.round((colony.rate[r] || 0) * 1000) / 1000; return o; }, {}),
      made: RES.reduce((o, r) => { o[r] = Math.round((colony.made[r] || 0) * 1000) / 1000; return o; }, {}),
      use: RES.reduce((o, r) => { o[r] = Math.round((colony.use[r] || 0) * 1000) / 1000; return o; }, {}),
      sent: RES.reduce((o, r) => { o[r] = Math.round((colony.sent[r] || 0) * 1000) / 1000; return o; }, {}),
      eff: RES.reduce((o, r) => { o[r] = Math.round((colony.eff[r] || 0) * 100); return o; }, {}),
      pop: Math.floor(colony.pop), hap: Math.round(colony.hap), stats: colony.stats, ship: colony.ship,
      given: Math.round(colony.given), shipped: colony.shipped, log: colony.log.slice(-8).reverse(),
      safe: colony.safe, since: colony.born, advice: adv,
      recommend: adv.map((a) => a.build).filter(Boolean)
    };
  }
  return view;
}

module.exports = {
  SLOTS, MAX_LAYERS, ONLINE_MS, ACTIVE_MS, OFFLINE_KEEP, STOCK_CAP, RESERVE, WAVE_MS, WAVE_FIRST_MS, RES, VALUE, DEFAULT_SHIP, MODES, CATS, BIOMES, B, STAGES, LIBERATE,
  scaleFor, newWorld, newCiv, newColony, build, demolish, toggle, startDig, setShip, setPreset, wake, stepWorld, stepColony, deliver, checkAdvance,
  activeColonies, activeScale, biomeOpen, mayFound, buffs, needFor, liberationNeed, waveStrength, scheduleWave, resolveWave, defenceNow,
  viewFor, catalogFor, digCost, layerCap, countOf, say, emit, onEmit, eventsFor, adviseFor, civAsks, isFrozen, STEP
};
