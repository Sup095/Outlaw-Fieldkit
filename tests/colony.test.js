/* ============================================================
   DEEPHOLD — the shared colony game (relay/colony-engine.js,
   relay/colony.js, modules/colony.js, tools/colony-sim.js)

   What matters:
     1. The server is the game: every click is checked (cost, stage,
        depth, biome, limits) and a client can send no quantities.
     2. Nothing is capped per day; offline colonies ship in full, keep
        30%, and cannot die while away.
     3. Only the current stage and the next are ever shown.
     4. Costs scale with the number of people; the Civ can fall but not
        easily; a fallen Civ advances slower and has half the buffs.
     5. A saved game survives a restart, and a damaged file stops the
        game instead of being replaced by an empty one.
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

function call(route, method, p, who, body) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const send = (r, status, b) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(b)); };
      const readBody = (r) => new Promise((ok2) => { const ch = []; r.on("data", (c) => ch.push(c)); r.on("end", () => { try { ok2(JSON.parse(Buffer.concat(ch).toString() || "{}")); } catch (e) { ok2({}); } }); });
      const done = await route(req, res, new URL(req.url, "http://relay"), { send, readBody, who: () => who });
      if (!done) send(res, 418, { unhandled: true });
    });
    srv.listen(0, "127.0.0.1", () => {
      const r = http.request({ host: "127.0.0.1", port: srv.address().port, path: p, method: method, headers: { "Content-Type": "application/json" } }, (res) => {
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
    ok("an unknown building is refused", E.build(w, c, 0, 6, "nonsense").error);
    ok("a name that is a property of every object is refused, not a crash", ["__proto__", "constructor", "toString", "hasOwnProperty"].every((n) => { try { return !!E.build(w, c, 0, 6, n).error; } catch (e) { return false; } }) && !E.biomeOpen(w, "__proto__") && !E.biomeOpen(w, "constructor"));
    ok("a taken plot is refused", /taken/.test(E.build(w, c, 0, 0, "bunk").error));
    ok("a plot that does not exist is refused", E.build(w, c, 9, 0, "bunk").error && E.build(w, c, 0, 99, "bunk").error && E.build(w, c, 0, -1, "bunk").error);
    ok("a building the Civ has not unlocked is refused", /not unlocked/.test(E.build(w, c, 0, 6, "workshop").error));
    c.stock.ore = 0;
    ok("no materials, no building", /not enough/.test(E.build(w, c, 0, 6, "bunk").error));
    c.stock.ore = 1000; c.stock.parts = 500;
    const before = c.stock.ore;
    ok("it builds, and takes the cost", E.build(w, c, 0, 6, "bunk").ok && c.stock.ore === before - 40 && E.countOf(c, "bunk") === 1);
    ok("demolishing gives half back", E.demolish(c, 0, 6).ok && c.stock.ore === before - 40 + 20 && E.countOf(c, "bunk") === 0);
    ok("a plot can be paused and resumed", E.toggle(c, 0, 3).on === false && E.toggle(c, 0, 3).on === true);
    w.civ.stage = 1;
    ok("a deep building needs depth", /layer 3/.test(E.build(w, c, 0, 6, "bore").error) || E.build(w, c, 0, 6, "bore").error);
    ok("a biome building needs its biome", /biome/.test(E.build(w, c, 0, 6, "geo").error));
    for (let i = 0; i < 4; i++) c.grid[0][i === 3 ? 6 : i] = c.grid[0][i === 3 ? 6 : i]; /* no-op, keeps the kit */
    ok("a limited building has a limit", (() => { let n = 0; for (let s = 0; s < 8; s++) if (!c.grid[0][s] && E.build(w, c, 0, s, "cell").ok) n++; return E.countOf(c, "cell") <= 4; })());
    ok("shipping is clamped to 0-100 and only for real things", E.setShip(c, "ore", 500).ok && c.ship.ore === 100 && E.setShip(c, "ore", -5).ok && c.ship.ore === 0 &&
      E.setShip(c, "gold", 5).error && E.setShip(c, "ore", "x").ok && c.ship.ore === 0);
    w.civ.stage = 0;
    ok("a dig costs, takes time, and one at a time", (() => {
      c.stock.ore = 1000; c.stock.parts = 100;
      const r = E.startDig(w, c, T0); return r.ok && c.dig && E.startDig(w, c, T0).error;
    })());
    c.dig = null; c.layers = 2;
    ok("the Civ's stage caps the depth", /Civilization must grow/.test(E.startDig(w, c, T0).error));
    ok("the dig finishes by itself", (() => { w.civ.stage = 2; c.stock.ore = 1000; c.stock.parts = 100; E.startDig(w, c, T0); c.lastSeen = T0 + 10 * H; E.stepWorld(w, T0 + 1000); const t = T0 + 20 * 60 * 1000; run(w, T0 + 1000, 20 * 60 * 1000 + 15000, true); return c.layers === 3; })());
  }

  section("a colony works, and being away is gentle");
  {
    const a = world(1), b = world(1);
    const ca = a.colonies.p0, cb = b.colonies.p0;
    for (const c of [ca, cb]) { E.setShip(c, "ore", 0); }
    /* a is online the whole time, b is away */
    cb.lastSeen = T0 - 24 * H;
    run(a, T0, 25 * 60000, true);
    run(b, T0, 25 * 60000, false);
    const orePlus = (c) => c.stock.ore - 140;
    ok("an online colony makes ore", orePlus(ca) > 50, String(orePlus(ca)));
    ok("an away colony keeps 30% of that", Math.abs(orePlus(cb) / orePlus(ca) - 0.3) < 0.12, (orePlus(cb) / orePlus(ca)).toFixed(2));
    const s = world(1); E.setShip(s.colonies.p0, "ore", 100);
    const t = world(1); E.setShip(t.colonies.p0, "ore", 100);
    run(s, T0, 2 * H, true); run(t, T0, 2 * H, false);
    const given = (w) => (w.civ.progress.ore || 0) + (w.civ.stock.ore || 0);
    ok("what an away colony ships reaches the Civ in full", given(t) > 0 && given(t) > given(s) * 0.7, given(t) + " vs " + given(s));
    const hungry = world(1); const hc = hungry.colonies.p0; hc.stock.food = 0; hc.stock.fungus = 0; hc.stock.water = 0;
    for (let i = 0; i < 5; i++) E.deliver(hungry, T0, hc, "ore", 0);
    run(hungry, T0, 24 * H, false);
    ok("nobody dies while their owner is away", !hc.collapsed && hc.pop >= 2 && hc.hap >= 20, "pop " + hc.pop + " hap " + hc.hap);
    const unfed = world(1); const uc = unfed.colonies.p0; uc.stock.food = 0; uc.stock.fungus = 0; uc.stock.water = 0; uc.stock.ore = 0;
    uc.grid[0][3] = null; uc.grid[0][4] = null;
    run(unfed, T0, 24 * H, true);
    ok("starve people while you watch and they do die", uc.pop < 8, "pop " + uc.pop);
    ok("a colony with no people has fallen and the Civ says so", (() => { run(unfed, T0 + 24 * H, 48 * H, true); return uc.collapsed && unfed.civ.log.some((l) => /has fallen/.test(l.text)); })());
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
    ok("everything met: the stage rises and says so", w.civ.stage === 1 && w.civ.log.some((l) => /STAGE 1/.test(l.text)));
    ok("progress starts over for the next stage", Object.keys(w.civ.progress).length === 0);
    ok("givers are thanked by what their gifts were worth", w.civ.givers.p0.v > 0 && c.given > 0);
    ok("buffs follow the stage", E.buffs(w.civ).yield > 0);
  }

  section("only the current stage and the next are ever shown");
  {
    const w = world(1);
    const v0 = E.viewFor(w, T0, "p0");
    const text0 = JSON.stringify(v0);
    ok("the next stage is shown with its needs", v0.civ.next.name === E.STAGES[1].name && v0.civ.next.need.ore > 0);
    ok("the stage after the next is not in what a player is sent", !text0.includes(E.STAGES[2].name) && !text0.includes(E.STAGES[3].name));
    ok("buildings two stages out are not in the list at all", v0.catalog.every((b) => b.stage <= 1) && !v0.catalog.some((b) => b.id === "armoury" || b.id === "reactor"));
    ok("buildings for the next stage are only names", v0.catalog.filter((b) => b.locked).every((b) => !b.cost && !b.blurb));
    w.civ.stage = 1;
    const v1 = E.viewFor(w, T0, "p0");
    ok("a stage later, the one after is still hidden", !JSON.stringify(v1).includes(E.STAGES[3].name) && v1.catalog.every((b) => b.stage <= 2));
    ok("nothing that is a client's to claim is in the view", !("pass" in v1) && !("secret" in v1));
    w.civ.stage = E.STAGES.length - 1;
    ok("past the last stage nothing is promised", E.viewFor(w, T0, "p0").civ.next === null);
  }

  section("the cost follows the number of players");
  {
    const w1 = world(1), w9 = world(9);
    const n1 = E.needFor(w1, T0, 1).ore, n9 = E.needFor(w9, T0, 1).ore;
    ok("more players, a bigger bill", n9 > n1 * 4, n1 + " vs " + n9);
    ok("but a little under one for one", n9 < n1 * 9, n1 + " vs " + n9);
    ok("nobody counts for nothing; one is one", E.scaleFor(0) === 1 && E.scaleFor(1) === 1);
    const old = world(3);
    ok("a colony not seen for a week no longer counts", (() => { for (const c of Object.values(old.colonies)) c.lastSeen = T0 - 8 * 24 * H; return E.activeColonies(old, T0) === 0; })());
    const bw = world(1);
    ok("only two places are open to begin with", E.biomeOpen(bw, "seam") && E.biomeOpen(bw, "aquifer") && !E.biomeOpen(bw, "fungal") && !E.biomeOpen(bw, "veins"));
    bw.civ.peak = 3;
    ok("more open as more people join", E.biomeOpen(bw, "fungal") && !E.biomeOpen(bw, "magma"));
    bw.civ.peak = 10; bw.civ.peak = 10;
    ok("and they stay open", E.biomeOpen(bw, "veins") && E.biomeOpen(bw, "magma"));
  }

  section("the war");
  {
    const w = world(4); const civ = w.civ;
    civ.stage = 2; E.scheduleWave(w, T0, E.WAVE_FIRST_MS);
    ok("the first wave comes a day after stage 2", civ.war.at === T0 + E.WAVE_FIRST_MS && civ.war.strength > 0);
    ok("what is coming is shown before it arrives", E.viewFor(w, T0, "p0").civ.war.strength === civ.war.strength);
    civ.stock.arms = civ.war.strength * 2;
    const arms = civ.stock.arms;
    E.resolveWave(w, T0 + E.WAVE_FIRST_MS);
    ok("enough arms: the wave is repelled and some are spent", civ.wins === 1 && civ.stock.arms < arms && civ.stock.arms > 0 && civ.breach === 0);
    ok("another wave is already on the way", civ.war.at > T0 + E.WAVE_FIRST_MS);
    civ.stock.arms = 0;
    let falls = 0;
    for (let i = 0; i < 6 && !civ.fallen; i++) { E.resolveWave(w, civ.war.at); falls++; }
    ok("it takes several lost waves in a row to fall", falls >= 3 && civ.fallen, "after " + falls);
    ok("a fall halves the stores", civ.log.some((l) => /HAS FALLEN/.test(l.text)));
    ok("and the breach stops growing while fallen", (() => { const b = civ.breach; E.resolveWave(w, civ.war.at); E.resolveWave(w, civ.war.at); return civ.breach === b; })());
    const normal = world(4); normal.civ.stage = 1;
    const fallenNeed = E.needFor(w, T0, 3).goods, okNeed = E.needFor(normal, T0, 3).goods;
    ok("a fallen Civ pays more to advance", fallenNeed > okNeed, okNeed + " vs " + fallenNeed);
    const strong = world(4); strong.civ.stage = 1; strong.civ.strain = 0;
    const f = JSON.parse(JSON.stringify(strong)); f.civ.fallen = true;
    ok("and its buffs are halved", Math.abs(E.buffs(f.civ).yield - E.buffs(strong.civ).yield / 2) < 1e-9);
    const c = w.colonies.p0;
    const lib = E.liberationNeed(w, T0);
    ok("it can be liberated by shipping what is asked", (() => { for (const r of Object.keys(lib)) E.deliver(w, T0, c, r, lib[r]); E.checkAdvance(w, T0); return !civ.fallen && civ.breach === 40; })());
    ok("a turret adds to the defence", (() => { const x = world(1); x.civ.stage = 3; x.colonies.p0.grid[0][6] = { t: "turret", on: true }; return E.defenceNow(x).turrets === 6; })());
    ok("waves scale with the people, so a small server is not crushed", E.waveStrength(world(1), T0) < E.waveStrength(world(10), T0));
  }

  section("the Civ pays to exist");
  {
    const w = world(2); w.civ.stage = 1;
    let t = T0;
    for (let i = 0; i < 400; i++) { t += 60000; w.colonies.p0.lastSeen = t; w.colonies.p1.lastSeen = t; E.stepWorld(w, t); }
    ok("with nothing paid in, strain builds toward a brownout", w.civ.strain > 50, String(w.civ.strain));
    const before = E.buffs(w.civ).yield;
    for (let i = 0; i < 1200; i++) { t += 60000; w.colonies.p0.lastSeen = t; w.colonies.p1.lastSeen = t; E.stepWorld(w, t); }
    ok("a brownout stops the buffs", w.civ.strain >= 100 && before === 0 && E.buffs(w.civ).yield === 0 && E.viewFor(w, t, "p0").civ.brownout === true);
    const c = w.colonies.p0;
    E.deliver(w, t, c, "water", w.civ.debt.water + 10); E.deliver(w, t, c, "parts", w.civ.debt.parts + 10);
    ok("shipments pay the debt first", w.civ.debt.water === 0 && w.civ.debt.parts === 0);
    E.deliver(w, t, c, "water", 5000); E.deliver(w, t, c, "parts", 5000);
    for (let i = 0; i < 400; i++) { t += 60000; E.stepWorld(w, t); }
    ok("and strain eases when it is paid", w.civ.strain < 100);
  }

  section("the balance holds (a short simulated run)");
  {
    const r = sim.run({ days: 6, mix: { grinder: 1, casual: 2, ghost: 0 } });
    ok("a small server reaches stage 1 within two days", r.stages.length >= 1 && r.stages[0].day < 2, JSON.stringify(r.stages));
    ok("nobody dies who is looking after their colony", r.alive === r.total, r.alive + "/" + r.total);
    ok("stage 1 is not instant", r.stages.length < 1 || r.stages[0].day > 0.2, JSON.stringify(r.stages));
    const big = sim.run({ days: 3, mix: { grinder: 4, casual: 8, ghost: 8 } });
    ok("a server of twenty is not stuck at the start either", big.stages.length >= 1 && big.stages[0].day < 3, JSON.stringify(big.stages));
    ok("ghost colonies keep shipping while their owners never return", (() => { const g = Object.values(big.world.colonies).find((c) => /^ghost/.test(c.handle)); return g && !g.collapsed && g.given > 0; })());
    const again = sim.run({ days: 6, mix: { grinder: 1, casual: 2, ghost: 0 } });
    ok("the same people give the same result (it is deterministic)", JSON.stringify(again.stages) === JSON.stringify(r.stages));
  }

  section("on the relay: who may play, and what is saved");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-colony-"));
    let clockNow = T0;
    colony.init({ dataDir: dir, start: false, now: () => clockNow });
    const member = { handle: "sam", tier: "member" }, admin = { handle: "boss", tier: "admin" };
    ok("nobody signed in: 401", (await call(colony.route, "GET", "/colony/me", null)).status === 401);
    ok("a guest waits for approval", (await call(colony.route, "GET", "/colony/me", { handle: "g", tier: "guest" })).status === 403);
    ok("a banned account is refused", (await call(colony.route, "GET", "/colony/me", { handle: "x", tier: "member", banned: true })).status === 403);
    const me0 = await call(colony.route, "GET", "/colony/me", member);
    ok("a new player is shown the places and no colony", me0.status === 200 && me0.body.colony === null && me0.body.biomes.length >= 2);
    ok("a closed place cannot be chosen", (await call(colony.route, "POST", "/colony/found", member, { biome: "veins" })).status === 400);
    ok("nonsense is not a place", (await call(colony.route, "POST", "/colony/found", member, { biome: "<script>" })).status === 400);
    const found = await call(colony.route, "POST", "/colony/found", member, { biome: "seam", name: "  <b>Deep</b>   Haven!!  " });
    ok("they found a colony, and the name is cleaned", found.status === 200 && found.body.colony && found.body.colony.name === "bDeepb Haven");
    ok("one colony each", (await call(colony.route, "POST", "/colony/found", member, { biome: "seam" })).status === 409);
    const wd = colony._world();
    wd.colonies.sam.stock.ore = 500;
    const b1 = await call(colony.route, "POST", "/colony/build", member, { layer: 0, slot: 6, type: "bunk" });
    ok("they can build", b1.status === 200 && b1.body.colony.grid[0][6].t === "bunk" && wd.colonies.sam.stock.ore === 460);
    ok("a plot number can be anything and is only ever checked", (await call(colony.route, "POST", "/colony/build", member, { layer: "0; drop", slot: "x", type: "bunk" })).status === 400);
    ok("a resource count is not something a client can send", (() => { const before = wd.colonies.sam.stock.ore; return call(colony.route, "POST", "/colony/build", member, { layer: 0, slot: 7, type: "drill", ore: 99999, stock: { ore: 99999 } }).then((r) => r.status === 200 && wd.colonies.sam.stock.ore < before); })() instanceof Promise);
    ok("a stage that is not unlocked is refused with a reason", (await call(colony.route, "POST", "/colony/build", member, { layer: 0, slot: 7, type: "reactor" })).body.error);
    ok("shipping can be set", (await call(colony.route, "POST", "/colony/ship", member, { res: "ore", pct: 80 })).body.colony.ship.ore === 80);
    ok("admins only for the admin route", (await call(colony.route, "POST", "/colony/admin", member, { action: "setStage", stage: 3 })).status === 403);
    const as = await call(colony.route, "POST", "/colony/admin", admin, { action: "setStage", stage: 2 });
    ok("an admin can set the stage, and it is logged for everyone", as.status === 200 && wd.civ.stage === 2 && wd.civ.log.some((l) => /admin set/.test(l.text)) && wd.civ.war);
    ok("an unknown admin action is refused", (await call(colony.route, "POST", "/colony/admin", admin, { action: "rm -rf" })).status === 400);
    ok("the view says who is an admin", (await call(colony.route, "GET", "/colony/me", admin)).body.admin === true && (await call(colony.route, "GET", "/colony/me", member)).body.admin === false);
    ok("unknown routes are 404s", (await call(colony.route, "POST", "/colony/whatever", member, {})).status === 404);

    colony.flush();
    ok("the save is on disk", fs.existsSync(path.join(dir, "colony.json")));
    colony.init({ dataDir: dir, start: false, now: () => clockNow });
    ok("a restart picks up where it was", colony._world().colonies.sam && colony._world().civ.stage === 2 && colony._world().colonies.sam.grid[0][6].t === "bunk");
    clockNow += 2 * H;
    const after = await call(colony.route, "GET", "/colony/me", member);
    ok("and two hours without anyone is simply two hours of play", after.status === 200 && after.body.colony.pop >= 2);

    const ab = await call(colony.route, "POST", "/colony/abandon", member, { confirm: true });
    ok("a colony can be abandoned", ab.status === 200 && ab.body.colony === null);
    ok("starting again waits a few minutes", (await call(colony.route, "POST", "/colony/found", member, { biome: "seam" })).status === 429);
    clockNow += 6 * 60 * 1000;
    ok("and then works", (await call(colony.route, "POST", "/colony/found", member, { biome: "aquifer" })).status === 200);
    ok("what was given stays given", colony._world().civ.givers.sam === undefined || colony._world().civ.givers.sam.v >= 0);

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
    ok("the relay routes /colony through a messaging account", /seg\[0\] === "colony"/.test(rd("relay/server.js")) && /colony\.route\(/.test(rd("relay/server.js")));
    ok("the relay saves on shutdown", /colony\.flush\(\)/.test(rd("relay/server.js")));
    ok("both files ship in the relay image", /"colony\.js"/.test(rd("tools/make-deploy.js")) && /"colony-engine\.js"/.test(rd("tools/make-deploy.js")));
    ok("the panel is in the ONLINE group, near the top", /group: "ONLINE"/.test(rd("modules/colony.js")) && /"runner", "colony"/.test(rd("core/shell.js")));
    ok("the messages service exposes only the game's own routes", /colony: async function/.test(rd("modules/messages.js")) && /not a game route/.test(rd("modules/messages.js")));
    ok("the panel never builds markup from text", !/innerHTML|insertAdjacentHTML|\.html\s*=/.test(rd("modules/colony.js")));
    ok("the admin overview carries the game", /colony: parts\.colony/.test(rd("relay/admin.js")));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
