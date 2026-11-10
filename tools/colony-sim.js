#!/usr/bin/env node
/* ============================================================
   DEEPHOLD balance simulator.

     node tools/colony-sim.js [days] [players]

   Runs relay/colony-engine.js for fake time with a mix of bots (a
   grinder, a casual who logs in twice a day, and someone who founds
   a colony and never comes back) and prints when the Civ reached each
   stage. The numbers in the engine were tuned with this. tests/
   colony.test.js runs a short version and fails if a stage becomes
   impossible or instant.
   ============================================================ */
"use strict";

const E = require("../relay/colony-engine");

/* What a sensible player wants, in order: [building, how many]. */
const PLAN = [
  ["farm", 1], ["mess", 1], ["stimden", 1], ["drill", 2], ["pump", 2], ["bunk", 1], ["foundry", 1], ["cell", 3], ["scrubber", 2], ["lift", 2],
  ["workshop", 1], ["farm", 2], ["pump", 3], ["drill", 3], ["bunk", 2], ["cell", 4], ["siphon", 1], ["burner", 1],
  ["mess", 2], ["scrubber", 3], ["workshop", 2], ["bore", 1], ["armoury", 1], ["clinic", 1], ["drill", 4], ["stimden", 2], ["bunk", 3], ["burner", 2],
  ["armoury", 2], ["bore", 2], ["geo", 1], ["turret", 2], ["reactor", 1], ["vidhall", 1], ["farm", 3], ["mess", 3], ["bunk", 4], ["scrubber", 4],
  ["hydro", 1], ["habtower", 2], ["shield", 1], ["turret", 3], ["reactor", 2], ["assembler", 1], ["deepdrill", 1], ["railgun", 2], ["habtower", 4], ["armoury", 3],
  ["fusion", 1], ["arcology", 1], ["bastion", 1], ["railgun", 3], ["shield", 2]
];

/* Things a player notices on screen and fixes first. */
function urgent(world, colony, now) {
  const s = colony.stats || {};
  const pop = Math.floor(colony.pop);
  const out = [];
  /* parts only come from a foundry, and half of what is worth building needs them */
  if ((colony.stock.parts || 0) < 25 && E.countOf(colony, "foundry") < 1) out.push(["foundry", 1]);
  if ((colony.stock.parts || 0) < 60 && colony.layers >= 2 && E.countOf(colony, "foundry") < 2) out.push(["foundry", 2]);
  if ((colony.stock.ore || 0) < 60 && colony.layers >= 2 && E.countOf(colony, "drill") < 5) out.push(["drill", 5]);
  if (s.power && s.power[1] > s.power[0]) out.push(["cell", 4], ["burner", 3], ["geo", 3]);
  if (s.air && s.air[0] < pop + 1) out.push(["scrubber", 6]);
  if (s.housing && pop >= s.housing - 1 && colony.hap >= 50) out.push(["bunk", 8]);
  if (colony.sat.food < 0.8) out.push((colony.stock.fungus || 0) < 20 ? ["farm", 4] : ["mess", 3]);
  if (s.ent && s.ent[0] < pop) out.push(["stimden", 2], ["vidhall", 2]);
  /* and builds what the Civilization is asking for, once it is safe to */
  if (colony.layers >= 2 && colony.hap >= 40) {
    const asked = E.civAsks(world, now);
    if (asked.goods) out.push(["workshop", 3], ["assembler", 2]);
    if (asked.food) out.push(["mess", 3], ["farm", 3], ["hydro", 2]);
    if (asked.parts) out.push(["foundry", 2]);
    if (asked.arms) out.push(["armoury", 3], ["arsenal", 2]);
    if (asked.fungus) out.push(["farm", 3]);
    if (asked.ore) out.push(["drill", 4]);
    if (asked.water) out.push(["pump", 3]);
    if (asked.crystal) out.push(["bore", 2]);
  }
  return out;
}

/* One round of a player's attention: fix the worst thing, else
   build the next item, else dig. Returns true if it did anything. */
function act(world, colony, now) {
  if (colony.collapsed) return false;
  /* the plot to use: shallowest free, but deep for what needs depth */
  const freeSlot = (minLayer) => {
    for (let l = minLayer; l < colony.layers; l++) for (let s = 0; s < E.SLOTS; s++) if (!colony.grid[l][s]) return [l, s];
    return null;
  };
  /* A player reads the Civilization tab and sends what it asks for. */
  const asked = E.needFor(world, now, world.civ.stage + 1) || {};
  for (const r of E.RES) {
    /* the default rules, and "all" only for what the Civ asks for AND this colony can spare */
    const rich = (colony.stock[r] || 0) > 300;
    const want = asked[r] && (world.civ.progress[r] || 0) < asked[r] && rich ? "all" : E.DEFAULT_SHIP[r];
    if (colony.ship[r] !== want) E.setShip(colony, r, want);
  }
  const first = urgent(world, colony, now);
  for (const [id, n] of first.concat(PLAN)) {
    const b = E.B[id];
    if (b.stage > world.civ.stage) continue;
    if (E.countOf(colony, id) >= n) continue;
    if (b.biomes && b.biomes.indexOf(colony.biome) < 0) continue;
    if (b.max && E.countOf(colony, id) >= b.max) continue;
    const at = freeSlot(b.minLayer || 0);
    if (!at) {
      /* no room: dig, or knock down the weakest early building */
      if (!colony.dig && colony.layers < E.layerCap(world.civ)) E.startDig(world, colony, now);
      continue;
    }
    if (E.build(world, colony, at[0], at[1], id, now).ok) return true;
    /* cannot afford: wait for it rather than skip ahead forever */
    return false;
  }
  if (!colony.dig && colony.layers < E.layerCap(world.civ)) E.startDig(world, colony, now);
  return false;
}

/* styles: [hours online per day, sessions per day] */
const STYLES = {
  grinder: { hours: 4, sessions: 2 },
  casual: { hours: 0.3, sessions: 2 },
  ghost: { hours: 0, sessions: 0 }
};

function run(opts) {
  opts = opts || {};
  const days = opts.days || 14, mix = opts.mix || { grinder: 2, casual: 5, ghost: 3 };
  const biomes = opts.biomes || ["seam", "aquifer"];
  const DAY = 86400000, STEPMS = 60000;
  let now = 1e12;
  const world = E.newWorld(now);
  const players = [];
  let n = 0;
  for (const style of Object.keys(mix)) for (let i = 0; i < mix[style]; i++) {
    const h = style + n++;
    players.push({ h: h, style: STYLES[style], name: style, joined: (opts.join === "late" ? (i % 5) * DAY : 0) });
  }
  const stages = [];
  const log = [];
  const t0 = now;
  for (; now < t0 + days * DAY; now += STEPMS) {
    const day = (now - t0) / DAY, tod = day % 1;
    for (let pi = 0; pi < players.length; pi++) {
      const p = players[pi];
      if (now - t0 < p.joined) continue;
      let c = world.colonies[p.h];
      if (!c) {
        c = E.newColony(p.h, biomes[pi % biomes.length], p.h, now);
        world.colonies[p.h] = c;
      }
      /* sessions: each starts spread through the day */
      let on = false;
      if (p.style.sessions) {
        const len = p.style.hours / 24 / p.style.sessions;
        for (let s = 0; s < p.style.sessions; s++) {
          const start = (s + 0.3 + pi * 0.07) / p.style.sessions % 1;
          if (((tod - start + 1) % 1) < len) on = true;
        }
      }
      if (on) { E.wake(world, c, now); if (Math.floor(now / STEPMS) % 3 === 0) act(world, c, now); }
    }
    E.stepWorld(world, now);
    while (stages.length < world.civ.stage) stages.push({ stage: stages.length + 1, day: +((now - t0) / DAY).toFixed(2) });
  }
  const alive = Object.values(world.colonies).filter((c) => !c.collapsed).length;
  return { world: world, stages: stages, alive: alive, total: players.length };
}

module.exports = { run, act, PLAN, STYLES };

if (require.main === module) {
  const days = Number(process.argv[2]) || 14, total = Number(process.argv[3]) || 10;
  const mix = { grinder: Math.round(total * 0.2), casual: Math.round(total * 0.5), ghost: Math.max(0, total - Math.round(total * 0.2) - Math.round(total * 0.5)) };
  const r = run({ days: days, mix: mix });
  console.log("players", JSON.stringify(mix), "days", days);
  console.log("stages reached:", r.stages.map((s) => "S" + s.stage + "@day" + s.day).join("  ") || "none");
  console.log("alive colonies:", r.alive + "/" + r.total, " civ stage:", r.world.civ.stage, " fallen:", r.world.civ.fallen,
    " wins/losses:", r.world.civ.wins + "/" + r.world.civ.losses, " strain:", Math.round(r.world.civ.strain));
  console.log("civ stock:", JSON.stringify(Object.fromEntries(Object.entries(r.world.civ.stock).map(([k, v]) => [k, Math.round(v)]))));
  const sample = Object.values(r.world.colonies).slice(0, 10);
  for (const c of sample) console.log(c.handle.padEnd(10), "pop", Math.floor(c.pop), "hap", Math.round(c.hap), "layers", c.layers,
    "bld", c.grid.flat().filter(Boolean).length, "given", Math.round(c.given), "pwr", c.stats.power && c.stats.power.join("/"), "eff", c.stats.eff);
}
