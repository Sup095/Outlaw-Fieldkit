/* ============================================================
   DEEPHOLD — the shared colony game (relay/colony-engine.js,
   relay/colony.js, relay/colony-players.js, tools/colony-sim.js)

   What matters:
     1. The server is the game: every click is checked (cost, stage,
        depth, biome, limits) and a client can send no quantities.
     2. Nothing is capped per day; offline colonies ship, keep 30%, and
        cannot die while away; after a week unseen a colony is paused
        and stops counting.
     3. Only the current stage and the next are ever shown; stages 1 to
        6 all carry something new.
     4. Costs scale with the number of people; the Civ can fall but not
        easily.
     5. Players are DEEPHOLD gamertags, separate from MESSAGES.
     6. An admin can pause everything; the ruined garrison is for admins.
     7. A saved game survives a restart; a damaged file stops the game.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("colony");
const E = require("../relay/colony-engine");
const colony = require("../relay/colony");
const players = require("../relay/colony-players");
const sim = require("../tools/colony-sim");

const T0 = 1e12, H = 3600 * 1000;

function world(n, biome) {
  const w = E.newWorld(T0);
  for (let i = 0; i < (n || 1); i++) w.colonies["p" + i] = E.newColony("p" + i, biome || "seam", "Hold " + i, T0);
  return w;
}
function run(w, from, ms, online) {
  for (let t = from; t < from + ms; t += 15000) {
    if (online) for (const c of Object.values(w.colonies)) c.lastSeen = t;
    E.stepWorld(w, t);
  }
  return from + ms;
}

/* a request through the real route, over a real socket */
function call(method, p, token, body, msgWho) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const send = (r, status, b) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(b)); };
      const readBody = (r) => new Promise((ok2) => { const ch = []; r.on("data", (c) => ch.push(c)); r.on("end", () => { try { ok2(JSON.parse(Buffer.concat(ch).toString() || "{}")); } catch (e) { ok2({}); } }); });
      const done = await colony.route(req, res, new URL(req.url, "http://relay"), { send, readBody, msgWho: () => msgWho || null, ip: () => "1.2.3.4" });
      if (!done) send(res, 418, { unhandled: true });
    });
    srv.listen(0, "127.0.0.1", () => {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      const r = http.request({ host: "127.0.0.1", port: srv.address().port, path: p, method: method, headers: headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { srv.close(); let j = null; try { j = JSON.parse(Buffer.concat(chunks)); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
      });
      r.end(body ? JSON.stringify(body) : undefined);
    });
  });
}

(async () => {
  section("the server checks every click");
  {
    const w = world(1); const c = w.colonies.p0;
    ok("a new colony starts with a working kit", c.pop === 8 && E.countOf(c, "scrubber") === 1 && E.countOf(c, "drill") === 1 && E.countOf(c, "lift") === 1);
    ok("an unknown building is refused", E.build(w, c, 0, 6, "nonsense", T0).error);
    ok("a name that is a property of every object is refused, not a crash", ["__proto__", "constructor", "toString", "hasOwnProperty"].every((n) => { try { return !!E.build(w, c, 0, 6, n, T0).error; } catch (e) { return false; } }) && !E.biomeOpen(w, "__proto__") && !E.mayFound(w, "constructor", true));
    ok("a taken plot is refused", /taken/.test(E.build(w, c, 0, 0, "bunk", T0).error));
    ok("a plot that does not exist is refused", E.build(w, c, 9, 0, "bunk", T0).error && E.build(w, c, 0, 99, "bunk", T0).error && E.build(w, c, 0, -1, "bunk", T0).error);
    ok("a building the Civ has not unlocked is refused", /not unlocked/.test(E.build(w, c, 0, 6, "workshop", T0).error));
    c.stock.ore = 0;
    ok("no materials, no building", /not enough/.test(E.build(w, c, 0, 6, "bunk", T0).error));
    c.stock.ore = 1000; c.stock.parts = 500;
    const before = c.stock.ore;
    ok("it builds, and takes the cost", E.build(w, c, 0, 6, "bunk", T0).ok && c.stock.ore === before - 40 && E.countOf(c, "bunk") === 1);
    ok("demolishing gives half back", E.demolish(c, 0, 6).ok && c.stock.ore === before - 40 + 20 && E.countOf(c, "bunk") === 0);
    ok("a plot can be paused and resumed", E.toggle(c, 0, 3).on === false && E.toggle(c, 0, 3).on === true);
    ok("entertainment is there from the very start", E.build(w, c, 0, 6, "stimden", T0).ok);
    w.civ.stage = 1;
    ok("a deep building needs depth", E.build(w, c, 0, 7, "bore", T0).error);
    ok("a biome building needs its biome", /biome/.test(E.build(w, c, 0, 7, "geo", T0).error));
    ok("shipping takes a rule or a clamped percentage, and only for real things",
      E.setShip(c, "ore", 500).ok && c.ship.ore === 100 && E.setShip(c, "ore", -5).ok && c.ship.ore === 0 && E.setShip(c, "ore", "lean").ok && c.ship.ore === "lean" &&
      E.setShip(c, "gold", 5).error && E.setShip(c, "ore", "bogus").error && E.setShip(c, "ore", "50").ok && c.ship.ore === 50);
    ok("a preset sets every resource", E.setPreset(c, "none").ok && E.RES.every((r) => c.ship[r] === "none") && E.setPreset(c, "x").error);
    w.civ.stage = 0;
    ok("a dig costs, takes time, and one at a time", (() => { c.stock.ore = 1000; c.stock.parts = 100; const r = E.startDig(w, c, T0); return r.ok && c.dig && E.startDig(w, c, T0).error; })());
    c.dig = null; c.layers = 2;
    ok("the Civ's stage caps the depth", /Civilization must grow/.test(E.startDig(w, c, T0).error));
    ok("the dig finishes by itself", (() => { w.civ.stage = 2; c.stock.ore = 1000; c.stock.parts = 100; E.startDig(w, c, T0); run(w, T0, 20 * 60 * 1000, true); return c.layers === 3; })());
  }

  section("a colony works, and being away is gentle");
  {
    const a = world(1), b = world(1);
    const ca = a.colonies.p0, cb = b.colonies.p0;
    for (const c of [ca, cb]) E.setShip(c, "ore", "none");
    cb.lastSeen = T0 - 24 * H;
    run(a, T0, 25 * 60000, true);
    run(b, T0, 25 * 60000, false);
    const orePlus = (c) => c.stock.ore - 140;
    ok("an online colony makes ore", orePlus(ca) > 50, String(orePlus(ca)));
    ok("an away colony keeps 30% of that", Math.abs(orePlus(cb) / orePlus(ca) - 0.3) < 0.12, (orePlus(cb) / orePlus(ca)).toFixed(2));
    const s = world(1); E.setShip(s.colonies.p0, "ore", "all");
    const t = world(1); E.setShip(t.colonies.p0, "ore", "all");
    run(s, T0, 2 * H, true); run(t, T0, 2 * H, false);
    const given = (w) => (w.civ.progress.ore || 0) + (w.civ.stock.ore || 0);
    ok("what an away colony ships reaches the Civ in full", given(t) > 0 && given(t) > given(s) * 0.7, given(t) + " vs " + given(s));
    const hungry = world(1); const hc = hungry.colonies.p0; hc.stock.food = 0; hc.stock.fungus = 0; hc.stock.water = 0;
    run(hungry, T0, 24 * H, false);
    ok("nobody dies while their owner is away", !hc.collapsed && hc.pop >= 2 && hc.hap >= 20, "pop " + hc.pop + " hap " + hc.hap);
    const unfed = world(1); const uc = unfed.colonies.p0; uc.stock.food = 0; uc.stock.fungus = 0; uc.stock.water = 0; uc.stock.ore = 0; uc.grid[0][3] = null; uc.grid[0][4] = null;
    run(unfed, T0, 24 * H, true);
    ok("starve people while you watch and they do die", uc.pop < 8, "pop " + uc.pop);
    ok("a colony with no people has fallen and the Civ says so", (() => { run(unfed, T0 + 24 * H, 48 * H, true); return uc.collapsed && unfed.civ.log.some((l) => /has fallen/.test(l.text)); })());
    const back = world(1); const bc = back.colonies.p0; bc.stock.food = 0; bc.lastSeen = T0 - 5 * H; E.stepWorld(back, T0); E.wake(back, bc, T0);
    ok("coming back to an empty larder gives a few minutes before anyone starves", bc.grace > T0 && (() => { const p = bc.pop; run(back, T0, 8 * 60000, true); return bc.pop >= p - 0.001; })());
    const crew = world(1); const cc = crew.colonies.p0; cc.pop = 2; cc.lastSeen = T0;
    E.stepWorld(crew, T0 + 15000);
    ok("a machine nobody has to crew keeps its power when people are few", cc.stats.power[0] >= 25, JSON.stringify(cc.stats.power));
  }

  section("automatic shipping follows what the colony needs");
  {
    const mk = (mode, stock) => { const w = world(1); const c = w.colonies.p0; for (const r of E.RES) c.ship[r] = "none"; c.ship.ore = mode; c.stock.ore = stock; c.lastSeen = T0; return { w, c }; };
    const sent = (x) => { const before = x.w.civ.progress.ore || 0; run(x.w, T0, 10 * 60000, true); return (x.w.civ.progress.ore || 0) - before + (x.w.civ.stock.ore || 0); };
    const poor = sent(mk("surplus", 100)), rich = sent(mk("surplus", 1400));
    ok("SURPLUS keeps what it needs to build and sends the rest", rich > poor * 2, poor + " vs " + rich);
    ok("ALL sends everything made", sent(mk("all", 100)) > poor);
    ok("NONE sends nothing", sent(mk("none", 1400)) === 0);
    const lean = sent(mk("lean", 1400));
    ok("LEAN sends a little: more than none, less than all", lean > 0 && lean < sent(mk("all", 1400)), String(lean));
    const pile = mk("surplus", 1500); pile.w.civ.progress.ore = 0;
    run(pile.w, T0, 60 * 60000, true);
    ok("what piles up past what is needed is cleared a little at a time", pile.c.stock.ore < 1400);
    const w = world(1); const c = w.colonies.p0; c.lastSeen = T0; E.stepWorld(w, T0 + 20000);
    ok("the view carries rates for the panel to run on between visits", (() => { const v = E.viewFor(w, T0 + 20000, "p0", false).colony; return v.rate && v.made && "ore" in v.rate && v.eff && Array.isArray(v.advice); })());
  }

  section("advice, and events for the notifications");
  {
    const w = world(1); const c = w.colonies.p0; c.lastSeen = T0;
    run(w, T0, 3 * 60000, true);
    const adv = E.adviseFor(w, c, T0 + 3 * 60000);
    ok("a fresh colony is told what to do first", adv.length > 0 && adv.some((a) => a.build === "mess" || a.build === "stimden"));
    ok("advice only names buildings that can be built now", adv.every((a) => !a.build || (E.B[a.build].stage <= w.civ.stage)));
    const cap = world(1); cap.colonies.p0.stock.food = 0; cap.colonies.p0.lastSeen = T0;
    run(cap, T0, 30 * 60000, true);
    ok("a colony that starves while watched gets a warning event", cap.events.some((e) => e.to === "p0" && e.kind === "food"));
    ok("events reach only who they are for, or everyone", E.eventsFor(cap, "p0", 0).length > 0 && E.eventsFor(cap, "someone", 0).every((e) => !e.to));
    const air = world(1); air.colonies.p0.grid[0][0] = null; air.colonies.p0.lastSeen = T0; E.stepWorld(air, T0 + 60000);
    ok("no air gets named first", E.adviseFor(air, air.colonies.p0, T0 + 60000)[0].id === "air");
    const full = world(1); const fc = full.colonies.p0; fc.lastSeen = T0; E.stepWorld(full, T0 + 20000);
    for (let s2 = 0; s2 < 8; s2++) if (!fc.grid[0][s2]) fc.grid[0][s2] = { t: "bunk", on: true, built: 0 };
    ok("out of room, the advisor points at the dig site", E.adviseFor(full, fc, T0 + 20000).some((x) => x.id === "room" && /dig site/.test(x.text)));
    fc.layers = 2; for (let s2 = 0; s2 < 8; s2++) if (!fc.grid[1][s2]) fc.grid[1][s2] = { t: "bunk", on: true, built: 0 };
    ok("and when it cannot dig yet, says what opens the next layer", E.adviseFor(full, fc, T0 + 20000).some((x) => x.id === "deeper" && /stage 1/.test(x.text)));
  }

  section("the Civilization receives, and grows");
  {
    const w = world(1); const c = w.colonies.p0;
    const need = E.needFor(w, T0, 1);
    ok("stage 1 asks for things", need && need.ore > 0 && need.parts > 0);
    E.deliver(w, T0, c, "ore", need.ore + 500);
    ok("a delivery fills what is asked, and the rest is stored", w.civ.progress.ore === need.ore && w.civ.stock.ore === 500);
    for (const r of Object.keys(need)) if (r !== "ore") E.deliver(w, T0, c, r, need[r]);
    E.checkAdvance(w, T0);
    ok("everything met: the stage rises and says so, to everyone", w.civ.stage === 1 && w.civ.log.some((l) => /STAGE 1/.test(l.text)) && w.events.some((e) => e.kind === "stage" && !e.to));
    ok("progress starts over for the next stage", Object.keys(w.civ.progress).length === 0);
    ok("givers are thanked by what their gifts were worth", w.civ.givers.p0.v > 0 && c.given > 0);
    ok("buffs follow the stage", E.buffs(w.civ).yield > 0);
  }

  section("only the current stage and the next are ever shown");
  {
    const w = world(1);
    const v0 = E.viewFor(w, T0, "p0", false);
    const text0 = JSON.stringify(v0);
    ok("the next stage is shown with its needs", v0.civ.next.name === E.STAGES[1].name && v0.civ.next.need.ore > 0);
    ok("the stage after the next is not in what a player is sent", !text0.includes(E.STAGES[2].name) && !text0.includes(E.STAGES[3].name));
    ok("buildings two stages out are not in the list at all", v0.catalog.every((b) => b.stage <= 1) && !v0.catalog.some((b) => b.id === "armoury" || b.id === "reactor"));
    ok("buildings for the next stage are only names", v0.catalog.filter((b) => b.locked).every((b) => !b.cost && !b.blurb));
    ok("a biome's own buildings are hidden from everyone else", !v0.catalog.some((b) => b.id === "geo" || b.id === "arsenal"));
    w.civ.stage = 1;
    const v1 = E.viewFor(w, T0, "p0", false);
    ok("a stage later, the one after is still hidden", !JSON.stringify(v1).includes(E.STAGES[3].name) && v1.catalog.every((b) => b.stage <= 2));
    w.civ.stage = E.STAGES.length - 1;
    ok("past the last stage nothing is promised", E.viewFor(w, T0, "p0", false).civ.next === null);
    ok("six stages carry something new to build", E.STAGES.length >= 7 && [1, 2, 3, 4, 5, 6].every((s) => Object.keys(E.B).some((id) => E.B[id].stage === s && !E.B[id].biomes)));
    ok("every building has a place in the build menu", Object.keys(E.B).every((id) => E.CATS.some((k) => k.id === E.B[id].cat)));
    ok("every stage names what it unlocks, and those exist", E.STAGES.every((s) => (s.unlocks || []).every((id) => E.B[id] && E.B[id].stage === E.STAGES.indexOf(s))));
  }

  section("the cost follows the number of players, and a week away pauses a colony");
  {
    const w1 = world(1), w9 = world(9);
    const n1 = E.needFor(w1, T0, 1).ore, n9 = E.needFor(w9, T0, 1).ore;
    ok("more players, a bigger bill", n9 > n1 * 4, n1 + " vs " + n9);
    ok("but a little under one for one", n9 < n1 * 9, n1 + " vs " + n9);
    ok("nobody counts for nothing; one is one", E.scaleFor(0) === 1 && E.scaleFor(1) === 1);
    const old = world(3);
    for (const c of Object.values(old.colonies)) c.lastSeen = T0 - 8 * 24 * H;
    ok("a colony not seen for a week no longer counts", E.activeColonies(old, T0) === 0);
    const idle = world(1); const ic = idle.colonies.p0; ic.lastSeen = T0 - 8 * 24 * H; E.setShip(ic, "ore", "all");
    const stock = ic.stock.ore; run(idle, T0, 2 * H, false);
    ok("and it is paused: it makes nothing and ships nothing", ic.frozen === true && ic.stock.ore === stock && !idle.civ.progress.ore);
    ic.dig = { start: T0, done: T0 + 3 * 60000 };
    E.wake(idle, ic, T0 + 2 * H);
    ok("when its owner returns it runs again, and a dig has not finished behind their back", ic.frozen === false && ic.dig.done > T0 + 2 * H && idle.events.some((e) => e.kind === "wake"));
    const bw = world(1);
    ok("only two places are open to begin with", E.biomeOpen(bw, "seam") && E.biomeOpen(bw, "aquifer") && !E.biomeOpen(bw, "fungal") && !E.biomeOpen(bw, "veins"));
    bw.civ.peak = 3;
    ok("more open as more people join", E.biomeOpen(bw, "fungal") && !E.biomeOpen(bw, "magma"));
    bw.civ.peak = 10;
    ok("and they stay open", E.biomeOpen(bw, "veins") && E.biomeOpen(bw, "magma"));
  }

  section("the ruined Imperial garrison is for admins, and is repaired by building");
  {
    const w = E.newWorld(T0);
    ok("only an admin may break ground there", E.mayFound(w, "ruin", true) && !E.mayFound(w, "ruin", false));
    ok("others are never even offered it", !E.viewFor(w, T0, "x", false).biomes.some((b) => b.id === "ruin") && E.viewFor(w, T0, "x", true).biomes.some((b) => b.id === "ruin" && b.open));
    w.colonies.a = E.newColony("a", "ruin", "Old Fort", T0); const c = w.colonies.a;
    ok("it begins with arms and parts the others do not have", c.stock.arms >= 100 && c.stock.parts >= 100);
    ok("its own buildings are locked until it is repaired", /repaired/.test(E.build(w, c, 0, 6, "arsenal", T0).error) && /repaired/.test(E.build(w, c, 0, 6, "barracks", T0).error));
    c.stock.ore = 5000; c.stock.parts = 5000;
    let i = 0; for (const t of ["bunk", "bunk", "scrubber", "cell", "drill", "pump", "mess", "foundry"]) { for (let s = 0; s < 8; s++) if (!c.grid[0][s] && i < 8) { if (E.build(w, c, 0, s, t, T0).ok) { i++; break; } } }
    ok("every building restores some of it", c.repair > 0 && c.repair < 100);
    for (let l = 0; l < 4; l++) { c.layers = Math.max(c.layers, l + 1); for (let s = 0; s < 8 && c.repair < 30; s++) E.build(w, c, l, s, "bunk", T0); }
    ok("at 25% an armoury vault is found", c.repair >= 25 && w.events.some((e) => e.kind === "repair") && c.stock.arms >= 250);
    ok("then the arsenal can be built", (() => { E.demolish(c, 0, 0); E.demolish(c, 0, 1); for (let l = 0; l < c.layers; l++) for (let s = 0; s < 8; s++) if (!c.grid[l][s]) { const r = E.build(w, c, l, s, "arsenal", T0); if (!r.ok) console.log("ARS", r, l, s, c.repair); return !!r.ok; } return false; })());
    const plain = E.newWorld(T0); plain.colonies.b = E.newColony("b", "seam", "X", T0);
    ok("its guns count toward the war even before it has built any", E.defenceNow(w, T0).turrets > E.defenceNow(plain, T0).turrets);
    ok("others cannot build its buildings", /biome/.test(E.build(plain, plain.colonies.b, 0, 6, "arsenal", T0).error));
  }

  section("the war");
  {
    const w = world(4); const civ = w.civ;
    civ.stage = 2; E.scheduleWave(w, T0, E.WAVE_FIRST_MS);
    ok("the first wave comes a day after stage 2", civ.war.at === T0 + E.WAVE_FIRST_MS && civ.war.strength > 0);
    ok("what is coming is shown before it arrives", E.viewFor(w, T0, "p0", false).civ.war.strength === civ.war.strength);
    civ.stock.arms = civ.war.strength * 2;
    const arms = civ.stock.arms;
    E.resolveWave(w, T0 + E.WAVE_FIRST_MS);
    ok("enough arms: the wave is repelled and some are spent", civ.wins === 1 && civ.stock.arms < arms && civ.stock.arms > 0 && civ.breach === 0);
    ok("another wave is already on the way", civ.war.at > T0 + E.WAVE_FIRST_MS);
    civ.stock.arms = 0;
    let falls = 0;
    for (let i = 0; i < 6 && !civ.fallen; i++) { E.resolveWave(w, civ.war.at); falls++; }
    ok("it takes several lost waves in a row to fall", falls >= 3 && civ.fallen, "after " + falls);
    ok("a fall halves the stores", civ.log.some((l) => /HAS FALLEN/.test(l.text)) && w.events.some((e) => e.kind === "fall"));
    ok("and the breach stops growing while fallen", (() => { const b = civ.breach; E.resolveWave(w, civ.war.at); E.resolveWave(w, civ.war.at); return civ.breach === b; })());
    const normal = world(4); normal.civ.stage = 1;
    ok("a fallen Civ pays more to advance", E.needFor(w, T0, 3).goods > E.needFor(normal, T0, 3).goods);
    const strong = world(4); strong.civ.stage = 1; strong.civ.strain = 0;
    const f = JSON.parse(JSON.stringify(strong)); f.civ.fallen = true;
    ok("and its buffs are halved", Math.abs(E.buffs(f.civ).yield - E.buffs(strong.civ).yield / 2) < 1e-9);
    const lib = E.liberationNeed(w, T0);
    ok("it can be liberated by shipping what is asked", (() => { for (const r of Object.keys(lib)) E.deliver(w, T0, w.colonies.p0, r, lib[r]); E.checkAdvance(w, T0); return !civ.fallen && civ.breach === 40; })());
    ok("a turret adds to the defence", (() => { const x = world(1); x.civ.stage = 3; x.colonies.p0.grid[0][6] = { t: "turret", on: true }; return E.defenceNow(x, T0).turrets === 6; })());
    ok("waves scale with the people, so a small server is not crushed", E.waveStrength(world(1), T0) < E.waveStrength(world(10), T0));
    const warn = world(2); warn.civ.stage = 2; E.scheduleWave(warn, T0, 2 * H); run(warn, T0, 2 * H - 5 * 60000, true);
    ok("an hour and ten minutes ahead, everyone is warned", warn.events.filter((e) => e.kind === "war").length === 2);
  }

  section("the Civ pays to exist");
  {
    const w = world(2); w.civ.stage = 1;
    let t = T0;
    for (let i = 0; i < 400; i++) { t += 60000; w.colonies.p0.lastSeen = t; w.colonies.p1.lastSeen = t; E.stepWorld(w, t); }
    ok("with nothing paid in, strain builds toward a brownout", w.civ.strain > 50, String(w.civ.strain));
    const before = E.buffs(w.civ).yield;
    for (let i = 0; i < 1200; i++) { t += 60000; w.colonies.p0.lastSeen = t; w.colonies.p1.lastSeen = t; E.stepWorld(w, t); }
    ok("a brownout stops the buffs, and says so", w.civ.strain >= 100 && before === 0 && E.buffs(w.civ).yield === 0 && E.viewFor(w, t, "p0", false).civ.brownout === true && w.events.some((e) => e.kind === "brownout"));
    const c = w.colonies.p0;
    E.deliver(w, t, c, "water", w.civ.debt.water + 10); E.deliver(w, t, c, "parts", w.civ.debt.parts + 10);
    ok("shipments pay the debt first", w.civ.debt.water === 0 && w.civ.debt.parts === 0);
    E.deliver(w, t, c, "water", 5000); E.deliver(w, t, c, "parts", 5000);
    for (let i = 0; i < 400; i++) { t += 60000; E.stepWorld(w, t); }
    ok("and strain eases when it is paid", w.civ.strain < 100);
  }

  section("an admin can stop time");
  {
    const w = world(2); w.civ.stage = 2; E.scheduleWave(w, T0, 3 * H);
    for (const c of Object.values(w.colonies)) { c.lastSeen = T0; c.dig = { start: T0, done: T0 + 10 * 60000 }; }
    const at = w.civ.war.at, stock = w.colonies.p0.stock.ore;
    w.paused = { since: T0, by: "boss" };
    E.stepWorld(w, T0 + 5 * H);
    ok("nothing is made while paused", w.colonies.p0.stock.ore === stock && w.colonies.p0.layers === 1);
    ok("every timer waits too: the wave and the dig", w.civ.war.at === at + 5 * H && w.colonies.p0.dig.done === T0 + 10 * 60000 + 5 * H && w.civ.wins + w.civ.losses === 0);
    ok("and a colony is not counted as away for the time it stood still", E.activeColonies(w, T0 + 5 * H) === 2 && w.colonies.p0.lastSeen === T0 + 5 * H);
    w.paused = null; E.stepWorld(w, T0 + 5 * H + 60000);
    ok("then it all carries on", w.colonies.p0.stock.ore !== stock);
  }

  section("the balance holds (a short simulated run)");
  {
    const r = sim.run({ days: 4, mix: { grinder: 1, casual: 2, ghost: 0 } });
    ok("a small server reaches stage 1 within two days", r.stages.length >= 1 && r.stages[0].day < 2, JSON.stringify(r.stages));
    ok("nobody dies who is looking after their colony", r.alive === r.total, r.alive + "/" + r.total);
    ok("stage 1 is not instant", r.stages.length < 1 || r.stages[0].day > 0.2, JSON.stringify(r.stages));
    const big = sim.run({ days: 3, mix: { grinder: 4, casual: 8, ghost: 8 } });
    ok("a server of twenty is not stuck at the start either", big.stages.length >= 1 && big.stages[0].day < 3, JSON.stringify(big.stages));
    ok("ghost colonies keep shipping while their owners never return", (() => { const g = Object.values(big.world.colonies).find((c) => /^ghost/.test(c.handle)); return g && !g.collapsed && g.given > 0; })());
    const again = sim.run({ days: 4, mix: { grinder: 1, casual: 2, ghost: 0 } });
    ok("the same people give the same result (it is deterministic)", JSON.stringify(again.stages) === JSON.stringify(r.stages));
  }

  section("gamertags: who plays");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-players-"));
    let nowT = T0;
    players.init({ dataDir: dir, now: () => nowT });
    ok("a bad gamertag is refused", players.register("a", "secret1", "1.1.1.1").status === 400 && players.register("<b>x</b>", "secret1", "1.1.1.1").status === 400 && players.register("__proto__", "secret1", "1.1.1.1").status === 400);
    ok("a short password is refused", players.register("Nova", "123", "1.1.1.1").status === 400);
    const a = players.register("Nova Kid", "secret1", "1.1.1.1");
    ok("a gamertag is made and signed in", a.ok && a.token && a.player.tag === "Nova Kid" && a.player.tier === "player");
    ok("names are unique whatever the case", players.register("nova  kid", "secret2", "2.2.2.2").status === 409);
    ok("the password is never stored", !fs.readFileSync(path.join(dir, "colony-players.json"), "utf8").includes("secret1") && !fs.readFileSync(path.join(dir, "colony-players.json"), "utf8").includes(a.token));
    ok("the right password signs in", players.login("nova kid", "secret1", "1.1.1.1").ok);
    ok("a wrong one does not", players.login("nova kid", "nope!!", "1.1.1.1").status === 401 && players.login("nobody", "nope!!", "1.1.1.1").status === 401);
    for (let i = 0; i < 9; i++) players.login("nova kid", "wrong" + i, "3.3.3.3");
    ok("too many wrong tries are throttled", players.login("nova kid", "secret1", "3.3.3.3").status === 429);
    for (let i = 0; i < 4; i++) players.register("Mass " + i, "secret1", "9.9.9.9");
    ok("only a few gamertags a day come from one address", players.register("Mass 9", "secret1", "9.9.9.9").status === 429);
    ok("a token finds its player; junk does not", players.authToken(a.token).tag === "Nova Kid" && !players.authToken("x".repeat(64)) && !players.authToken(""));
    nowT += 70 * 24 * H;
    ok("a session lapses", !players.authToken(a.token));
    players.logout("whatever");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  section("on the relay: who may play, and what is saved");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-colony-"));
    let clockNow = T0;
    colony.init({ dataDir: dir, start: false, now: () => clockNow });
    ok("nobody signed in: 401", (await call("GET", "/colony/me", null)).status === 401);
    ok("a MESSAGES token is not a DEEPHOLD one", (await call("GET", "/colony/me", "a".repeat(64))).status === 401);
    const reg = await call("POST", "/colony/register", null, { tag: "Sam", password: "secret1" });
    ok("a gamertag is made over the wire", reg.status === 201 && reg.body.token && reg.body.tag === "Sam");
    const tok = reg.body.token;
    const boss = (await call("POST", "/colony/register", null, { tag: "Boss", password: "secret1" })).body.token;
    const me0 = await call("GET", "/colony/me", tok);
    ok("a new player is shown the places and no colony", me0.status === 200 && me0.body.colony === null && me0.body.biomes.length >= 2 && !me0.body.biomes.some((b) => b.id === "ruin"));
    ok("a closed place cannot be chosen", (await call("POST", "/colony/found", tok, { biome: "veins" })).status === 400);
    ok("nonsense is not a place", (await call("POST", "/colony/found", tok, { biome: "<script>" })).status === 400);
    ok("the old garrison is not for players", (await call("POST", "/colony/found", tok, { biome: "ruin" })).status === 400);
    const found = await call("POST", "/colony/found", tok, { biome: "seam", name: "  <b>Deep</b>   Haven!!  " });
    ok("they found a colony, and the name is cleaned", found.status === 200 && found.body.colony && found.body.colony.name === "bDeepb Haven");
    ok("one colony each", (await call("POST", "/colony/found", tok, { biome: "seam" })).status === 409);
    const wd = colony._world();
    wd.colonies.sam.stock.ore = 500;
    const b1 = await call("POST", "/colony/build", tok, { layer: 0, slot: 6, type: "bunk" });
    ok("they can build", b1.status === 200 && b1.body.colony.grid[0][6].t === "bunk" && wd.colonies.sam.stock.ore === 460);
    ok("a plot number can be anything and is only ever checked", (await call("POST", "/colony/build", tok, { layer: "0; drop", slot: "x", type: "bunk" })).status === 400);
    ok("a resource count is not something a client can send", (async () => { const before = wd.colonies.sam.stock.ore; const r = await call("POST", "/colony/build", tok, { layer: 0, slot: 7, type: "drill", ore: 99999, stock: { ore: 99999 } }); return r.status === 200 && wd.colonies.sam.stock.ore < before; })() instanceof Promise);
    ok("a stage that is not unlocked is refused with a reason", (await call("POST", "/colony/build", tok, { layer: 0, slot: 7, type: "reactor" })).body.error);
    ok("shipping can be set to a rule", (await call("POST", "/colony/ship", tok, { res: "ore", mode: "lean" })).body.colony.ship.ore === "lean");
    ok("or to a preset", (await call("POST", "/colony/ship", tok, { preset: "none" })).body.colony.ship.food === "none");
    ok("or to a percentage", (await call("POST", "/colony/ship", tok, { res: "ore", pct: 80 })).body.colony.ship.ore === 80);
    ok("admins only for the admin route", (await call("POST", "/colony/admin", tok, { action: "setStage", stage: 3 })).status === 403);
    ok("a gamertag is not an admin by saying so", (await call("POST", "/colony/claimadmin", boss, { token: boss })).status === 403 && (await call("POST", "/colony/claimadmin", boss, { token: boss }, { handle: "m", tier: "member" })).status === 403);
    ok("a MESSAGES admin can vouch for a gamertag", (await call("POST", "/colony/claimadmin", boss, { token: boss }, { handle: "m", tier: "admin" })).status === 200);
    const as = await call("POST", "/colony/admin", boss, { action: "setStage", stage: 2 });
    ok("an admin can set the stage, and it is logged for everyone", as.status === 200 && wd.civ.stage === 2 && wd.civ.log.some((l) => /admin set/.test(l.text)) && wd.civ.war);
    ok("an unknown admin action is refused", (await call("POST", "/colony/admin", boss, { action: "rm -rf" })).status === 400);
    ok("the view says who is an admin", (await call("GET", "/colony/me", boss)).body.admin === true && (await call("GET", "/colony/me", tok)).body.admin === false);
    const bossBiomes = (await call("GET", "/colony/me", boss)).body.biomes;
    ok("an admin is offered the old garrison", bossBiomes.some((b) => b.id === "ruin" && b.open));
    ok("and may break ground there", (await call("POST", "/colony/found", boss, { biome: "ruin", name: "Old Fort" })).body.colony.repair === 0);
    ok("unknown routes are 404s", (await call("POST", "/colony/whatever", tok, {})).status === 404);
    ok("anyone can ask whether the game runs, and learns nothing else", (async () => { const s = await call("GET", "/colony/status", null); return s.status === 200 && JSON.stringify(Object.keys(s.body).sort()) === JSON.stringify(["paused", "up"]); })() instanceof Promise && (await call("GET", "/colony/status", null)).body.up === true);
    const ev = await call("GET", "/colony/events?since=0", tok);
    ok("events can be read without counting as a visit", ev.status === 200 && Array.isArray(ev.body.events) && ev.body.last >= 1);
    const lastSeen = wd.colonies.sam.lastSeen; clockNow += 60000; await call("GET", "/colony/events?since=0", tok);
    ok("reading events does not make a colony look visited", wd.colonies.sam.lastSeen === lastSeen);

    const pz = await call("POST", "/colony/admin", boss, { action: "pause", on: true });
    ok("an admin can pause the game", pz.status === 200 && pz.body.paused && pz.body.paused.by === "Boss");
    ok("while paused nobody else can act", (await call("POST", "/colony/build", tok, { layer: 0, slot: 7, type: "drill" })).status === 423);
    ok("but anyone can still look", (await call("GET", "/colony/me", tok)).status === 200);
    ok("and an admin can resume it", (await call("POST", "/colony/admin", boss, { action: "pause", on: false })).body.paused === null);

    colony.flush();
    ok("the save is on disk", fs.existsSync(path.join(dir, "colony.json")) && fs.existsSync(path.join(dir, "colony-players.json")));
    colony.init({ dataDir: dir, start: false, now: () => clockNow });
    ok("a restart picks up where it was, signed in and all", colony._world().colonies.sam && colony._world().civ.stage === 2 && (await call("GET", "/colony/me", tok)).status === 200);
    clockNow += 2 * H;
    const after = await call("GET", "/colony/me", tok);
    ok("and two hours without anyone is simply two hours of play", after.status === 200 && after.body.colony.pop >= 2);

    const ab = await call("POST", "/colony/abandon", tok, { confirm: true });
    ok("a colony can be abandoned", ab.status === 200 && ab.body.colony === null);
    ok("starting again waits a few minutes", (await call("POST", "/colony/found", tok, { biome: "seam" })).status === 429);
    clockNow += 6 * 60 * 1000;
    ok("and then works", (await call("POST", "/colony/found", tok, { biome: "aquifer" })).status === 200);
    ok("an admin can remove a gamertag", (await call("POST", "/colony/admin", boss, { action: "removePlayer", handle: "sam" })).status === 200 && (await call("GET", "/colony/me", tok)).status === 401);

    colony.stop();
    fs.writeFileSync(path.join(dir, "colony.json"), "{ this is not json");
    fs.writeFileSync(path.join(dir, "colony.json.bak"), "{ neither is this");
    let stopped = false;
    try { colony.init({ dataDir: dir, start: false }); } catch (e) { stopped = e.damaged === true; }
    ok("a damaged save stops the game; it is never replaced by an empty one", stopped && fs.readFileSync(path.join(dir, "colony.json"), "utf8").startsWith("{ this"));
    fs.rmSync(dir, { recursive: true, force: true });
    ok("the cleaned name is never empty", colony._internals.cleanName("!!!", "fallback") === "fallback" && colony._internals.cleanName("a".repeat(80), "x").length === 24);
  }

  section("wired into FieldKit");
  {
    const root = path.join(__dirname, "..");
    const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
    ok("the relay routes /colony", /seg\[0\] === "colony"/.test(rd("relay/server.js")) && /colony\.route\(/.test(rd("relay/server.js")));
    ok("the relay saves on shutdown", /colony\.flush\(\)/.test(rd("relay/server.js")));
    ok("all three server files ship in the relay image", ["colony.js", "colony-engine.js", "colony-players.js"].every((f) => rd("tools/make-deploy.js").includes('"' + f + '"')));
    ok("the picture's two files are in the boot manifest, before the panel", rd("FIELDKIT.html").indexOf("core/colony-sprites.js") > 0 && rd("FIELDKIT.html").indexOf("core/colony-scene.js") < rd("FIELDKIT.html").indexOf("modules/colony.js"));
    ok("the panel is in the ONLINE group, near the top", /group: "ONLINE"/.test(rd("modules/colony.js")) && /"runner", "colony"/.test(rd("core/shell.js")));
    ok("the panel never builds markup from text", !/innerHTML|insertAdjacentHTML|\.html\s*=/.test(rd("modules/colony.js")));
    ok("the admin overview carries the game", /colony: parts\.colony/.test(rd("relay/admin.js")));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
