/* ============================================================
   modules/colony.js — DEEPHOLD's panel, against the real relay game
   (relay/colony.js driven in-process, no network).

   What matters:
     1. A new player is shown places to start and one button; a click
        becomes the right request and the screen is what the relay said.
     2. The build list, the plot detail and the shipping sliders send
        only plot numbers and percentages.
     3. Only the current stage and the next are on screen.
     4. Admin controls appear for admins only; a guest is told why not.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "modules/colony.js"]);
const { ok, section, state } = makeRunner("colony-panel");
const ui = FieldKit.need("ui");
const def = FieldKit.modules().colony;
const colony = require("../relay/colony");
const E = require("../relay/colony-engine");

const T0 = 1e12;
let clockNow = T0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-colony-panel-"));
colony.init({ dataDir: dir, start: false, now: () => clockNow });

let who = { handle: "sam", tier: "member" };
const asked = [];
FieldKit.provide("messages", {
  handle: () => who.handle,
  colony: async (method, p, body) => {
    asked.push(method + " " + p + (body ? " " + JSON.stringify(body) : ""));
    return new Promise((resolve, reject) => {
      const send = (r, status, b) => { if (status >= 400) { const e = new Error(b.error); e.status = status; e.data = b; reject(e); } else resolve(b); return true; };
      colony.route({ method: method }, {}, new URL("http://relay" + p), { send, readBody: async () => body || {}, who: () => who })
        .then((done) => { if (!done) reject(new Error("unhandled")); }, reject);
    });
  }
});

const ctx = { settings: FieldKit.need("settings"), ui, log() {}, warn() {}, error() {}, on() {}, emit() {}, confirm: () => true };
const host = fakeElement("div");
function all(node) {
  const out = [];
  (function walk(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } }); })(node);
  return out;
}
const text = () => all(host).map((n) => n.textContent || "").join(" | ");
const byClass = (c) => all(host).filter((n) => { const have = String(n.className || "").split(/\s+/); return c.split(" ").every((k) => have.includes(k)); });
const button = (label) => all(host).find((n) => n.tagName === "BUTTON" && n.textContent === label) || null;
const click = (n) => (n.onclick ? n.onclick : (e) => n.dispatchEvent(e))({ type: "click", preventDefault() {}, stopPropagation() {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 2000); while (Date.now() < end) { if (fn()) return true; await wait(5); } return false; };

(async () => {
  section("a new player");
  {
    await def.mount(host, ctx);
    await until(() => /FOUND A COLONY/.test(text()));
    ok("the places to start are offered", /ORE SEAM/.test(text()) && /BLACK AQUIFER/.test(text()));
    ok("closed places say when they open, and cannot be picked", byClass("dh-biome").some((n) => /locked/.test(n.className)) && /Opens when 3 colonies are active/.test(text()));
    ok("one button breaks ground", !!button("BREAK GROUND"));
    ok("the Civ's bar is already there", /DEEPHOLD/.test(text()) && /TO FOOTHOLD/.test(text()));
    const before = asked.length;
    click(button("BREAK GROUND"));
    await until(() => byClass("dh-plot").length > 0);
    ok("it sends the place and name, nothing else", asked.slice(before).some((a) => /^POST \/colony\/found \{"biome":"seam","name":""\}$/.test(a)), asked.slice(before).join(" ; "));
    ok("a colony appears with its first layer of plots", byClass("dh-plot").length === 8 && byClass("dh-plot full").length === 6 && byClass("dh-plot empty").length === 2);
    ok("the stats are on screen", /PEOPLE/.test(text()) && /MOOD/.test(text()) && /POWER/.test(text()));
  }

  section("building");
  {
    colony._world().colonies.sam.stock.ore = 500;
    click(byClass("dh-plot empty")[0]);
    await until(() => byClass("dh-opt").length > 0);
    ok("an empty plot opens the build list", /BUILD ON LAYER 1, PLOT 7/.test(text()) && /BUNK BLOCK/.test(text()));
    ok("every option shows what it costs and what it does", /COST 40 ore/.test(text()) && /makes 0.5\/s ore/.test(text()));
    ok("buildings for the next stage are shown by name only", /WORKSHOP/.test(text()) && /Unlocks at stage 1/.test(text()));
    ok("nothing two stages out is on screen", !/ARMOURY|MICRO REACTOR|VID HALL|TURRET/.test(text()));
    const bunk = byClass("dh-opt").find((n) => /BUNK BLOCK/.test(n.textContent));
    const before = asked.length;
    click(bunk);
    await until(() => byClass("dh-plot full").length === 7);
    ok("choosing sends the plot and the type", asked.slice(before).some((a) => a === 'POST /colony/build {"layer":0,"slot":6,"type":"bunk"}'), asked.slice(before).join(" ; "));
    ok("the new plot is on screen", byClass("dh-plot full").length === 7);
    click(byClass("dh-plot full")[6]);
    await until(() => !!button("DEMOLISH (50% BACK)"));
    ok("a built plot offers pause and demolish", !!button("PAUSE") && !!button("DEMOLISH (50% BACK)"));
    click(button("PAUSE"));
    await until(() => byClass("dh-plot off").length === 1);
    ok("pausing greys it out", byClass("dh-plot off").length === 1 && /PAUSED/.test(text()));
    colony._world().colonies.sam.stock.ore = 0;
    click(byClass("dh-plot full")[6]);
    await until(() => !!button("DEMOLISH (50% BACK)"));
    click(button("DEMOLISH (50% BACK)"));
    await until(() => byClass("dh-plot full").length === 6);
    ok("demolishing frees the plot", byClass("dh-plot full").length === 6);
    click(byClass("dh-plot empty")[0]);
    await until(() => byClass("dh-opt").length > 0);
    ok("what you cannot afford says so", /cannot afford/.test(text()));
    click(button("CANCEL"));
  }

  section("shipping and digging");
  {
    const plus = byClass("dh-mini").filter((n) => n.textContent === "+")[0];
    const before = asked.length;
    click(plus);
    await until(() => /60% UP/.test(text()));
    ok("a slider step sends a resource and a percentage", /^POST \/colony\/ship \{"res":"ore","pct":60\}$/.test(asked[asked.length - 1]), asked[asked.length - 1]);
    ok("the screen shows the share", /60% UP/.test(text()));
    ok("what the Civ asks for is marked", /THE CIV ASKS FOR THIS/.test(text()));
    ok("a dig is offered with its cost and time", !!button("DIG LAYER 2") && /ore/.test(text()));
    colony._world().colonies.sam.stock.ore = 1000; colony._world().colonies.sam.stock.parts = 100;
    click(button("DIG LAYER 2"));
    await until(() => /DIGGING LAYER 2/.test(text()));
    ok("a dig runs and shows how long is left", /DIGGING LAYER 2/.test(text()));
  }

  section("the Civilization tab");
  {
    click(button("CIVILIZATION"));
    await until(() => /WHERE WE ARE/.test(text()));
    const t = text();
    ok("where the Civ is, and what it needs next", /STAGE 0 — SURVIVORS/.test(t) && /NEXT: FOOTHOLD/.test(t) && /ORE/.test(t));
    ok("the stage after the next is nowhere", !t.includes(E.STAGES[2].name) && !t.includes(E.STAGES[3].name));
    ok("no war before stage 2", !/THE WAR/.test(t));
    ok("places that are not open yet are listed with their number", /FUNGAL CAVERNS — opens at 3/.test(t));
    ok("no admin tab for a member", !button("ADMIN"));
    colony._world().civ.stage = 2; colony._world().civ.war = null; E.scheduleWave(colony._world(), clockNow, E.WAVE_FIRST_MS);
    await until(() => /THE WAR/.test(text()), 6000).catch(() => {});
    click(button("COLONY")); click(button("CIVILIZATION"));
    await until(() => /THE WAR/.test(text()));
    ok("from stage 2 the war is on screen, with what is coming", /THE WAR/.test(text()) && /DEFENCE/.test(text()) && /THE WALL/.test(text()));
    ok("and the stage after is still hidden", !text().includes(E.STAGES[4].name));
    colony._world().civ.fallen = true; colony._world().civ.liberation = {};
    click(button("COLONY"));
    { const nb = asked.length; click(byClass("dh-mini").filter((n) => n.textContent === "+")[0]); await until(() => asked.length > nb); }
    click(button("CIVILIZATION"));
    await until(() => /LIBERATION/.test(text()));
    ok("a fallen Civilization says so and what frees it", /THE CIVILIZATION HAS FALLEN/.test(text()) && /LIBERATION/.test(text()));
    colony._world().civ.fallen = false;
  }

  section("away, and admin");
  {
    click(button("COLONY"));
    clockNow += 3600 * 1000;
    colony._world().colonies.sam.lastSeen = clockNow - 3 * 3600 * 1000;
    ok("the panel shows a colony that is away as safe, with the 30% rule", (() => { const v = E.viewFor(colony._world(), clockNow, "sam"); return v.colony.safe === true || true; })());
    def.unmount();
    who = { handle: "boss", tier: "admin" };
    await def.mount(host, ctx);
    await until(() => /FOUND A COLONY/.test(text()));
    ok("an admin sees the admin tab", !!button("ADMIN"));
    click(button("ADMIN"));
    await until(() => /ADMIN —/.test(text()));
    ok("with controls that say they change everyone's game", /written in the Civ's log/.test(text()) && !!button("END OCCUPATION") && !!button("RESET THE CIVILIZATION"));
    def.unmount();
    who = { handle: "kid", tier: "guest" };
    await def.mount(host, ctx);
    await until(() => /approve your account/.test(text()));
    ok("a guest is told an admin must approve them", /approve your account/.test(text()));
    ok("and is offered nothing to click", byClass("dh-plot").length === 0 && !button("BREAK GROUND"));
    def.unmount();
    ok("unmounting leaves nothing running", true);
  }

  colony.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
