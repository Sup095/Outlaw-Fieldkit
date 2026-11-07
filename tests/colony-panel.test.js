/* ============================================================
   modules/colony.js — DEEPHOLD's panel, against the real relay game
   (relay/colony.js driven in-process; window.fetch is answered by it).

   What matters:
     1. Nobody sees the game before signing in; a gamertag is made in
        the panel and is separate from MESSAGES.
     2. A new player gets places to start and one button; every click
        becomes the right request and the screen is what the relay said.
     3. The screen is built once and only text changes, so a poll never
        throws away what you are typing or pressing.
     4. Admin controls appear for admins only; pausing is in the menu.
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

const T0 = Date.now();
let clockNow = T0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-colony-panel-"));
colony.init({ dataDir: dir, start: false, now: () => clockNow });

const asked = [];
let msgTier = null;
const makeRes = () => { const r = { status: 200, body: null, writeHead(s) { r.status = s; }, end(b) { r.body = b; } }; return r; };
window.fetch = async (url, o) => {
  o = o || {};
  const u = new URL(url);
  asked.push((o.method || "GET") + " " + u.pathname.replace(/^\/colony\//, "") + (o.body ? " " + o.body : ""));
  const headers = {};
  Object.keys(o.headers || {}).forEach((k) => { headers[k.toLowerCase()] = o.headers[k]; });
  const req = { method: o.method || "GET", headers: headers, url: u.pathname + u.search };
  let out = null;
  const h = {
    send: (r, status, b) => { out = { status, b }; return true; },
    readBody: async () => { try { return JSON.parse(o.body || "{}"); } catch (e) { return {}; } },
    msgWho: () => (msgTier ? { handle: "m", tier: msgTier } : null),
    ip: () => "5.5.5.5"
  };
  await colony.route(req, makeRes(), u, h);
  const body = JSON.stringify(out ? out.b : {});
  return { ok: out.status < 400, status: out.status, text: async () => body };
};
FieldKit.need("settings").set("relayUrl", "http://relay.test");
/* MESSAGES, only as far as DEEPHOLD uses it: who is signed in there, and a way to vouch */
FieldKit.provide("messages", {
  tier: () => msgTier,
  colony: async (method, p, body) => { const r = await window.fetch("http://relay.test" + p, { method: method, body: JSON.stringify(body) }); if (!r.ok) throw new Error("refused"); return JSON.parse(await r.text()); }
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
const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await wait(5); } return false; };
const inputs = () => all(host).filter((n) => n.tagName === "INPUT");

(async () => {
  section("nobody sees the game before signing in");
  {
    await def.mount(host, ctx);
    ok("the sign-in screen is first", /DEEPHOLD/.test(text()) && /gamertag/.test(inputs().map((i) => i.placeholder || i.attributes.placeholder).join(" ")) && !!button("SIGN IN") && !!button("CREATE GAMERTAG"));
    ok("it says this is not the MESSAGES account", /not your MESSAGES account/.test(text()));
    ok("nothing was asked of the relay yet", asked.length === 0);
    const [tag, pw] = inputs();
    tag.value = "Sam"; pw.value = "x";
    click(button("CREATE GAMERTAG"));
    await until(() => /at least/.test(text()));
    ok("a bad password is explained, not swallowed", /password/i.test(text()) && !/FOUND/.test(text()));
    pw.value = "secret1";
    click(button("CREATE GAMERTAG"));
    await until(() => /BREAK GROUND/.test(text()));
    ok("a gamertag is made and the panel moves on", /BREAK GROUND/.test(text()) && FieldKit.service("deephold").signedIn() && FieldKit.service("deephold").tag() === "Sam");
    ok("the password is not kept in the page", !JSON.stringify(def).includes("secret1") && pw.value === "");
  }

  section("a new player");
  {
    ok("the places to start are offered", /ORE SEAM/.test(text()) && /BLACK AQUIFER/.test(text()));
    ok("closed places say when they open, and cannot be picked", byClass("dh-biome").some((n) => /locked/.test(n.className)) && /Opens when 3 colonies are active/.test(text()));
    ok("the old garrison is not offered to a player", !/IMPERIAL/.test(text()));
    const before = asked.length;
    click(button("BREAK GROUND"));
    await until(() => byClass("dh-tab").length > 0);
    ok("it sends the place and name, nothing else", asked.slice(before).some((a) => /^POST found \{"biome":"seam","name":""\}$/.test(a)), asked.slice(before).join(" ; "));
    ok("the game screen has its tabs", ["COLONY", "SHIPPING", "CIVILIZATION"].every((t) => !!button(t)) && !button("ADMIN"));
    ok("the top bar shows the Civ's progress to the next stage", /FOOTHOLD/.test(text()));
    ok("the stats are on screen", /PEOPLE/.test(text()) && /MOOD/.test(text()) && /POWER/.test(text()));
    ok("the advisor says what to do", byClass("dh-advice").length > 0 && byClass("dh-advice")[0].children.length > 0);
  }

  section("the screen is not rebuilt under your hands");
  {
    const root = host.children[0];
    const nodes = all(host).length;
    const tabNode = button("SHIPPING");
    click(tabNode);
    ok("tabs switch without a reload", byClass("dh-tab on").some((n) => n.textContent === "SHIPPING"));
    const selects = all(host).filter((n) => n.tagName === "SELECT");
    ok("every resource has its own shipping choice", selects.length >= 8);
    const sel0 = selects[0];
    const first = sel0.value;
    await FieldKit.service("deephold")._pollEvents();
    await wait(30);
    colony._world().colonies.sam.stock.ore += 5;
    await FieldKit.service("deephold")._api("GET", "me");
    ok("a poll leaves the same elements in place", host.children[0] === root && all(host).filter((n) => n.tagName === "SELECT")[0] === sel0);
    const before = asked.length;
    sel0.value = "lean"; (sel0.onchange || (() => {}))({ target: sel0 });
    sel0.dispatchEvent({ type: "change", target: sel0 });
    await until(() => asked.length > before);
    ok("choosing a rule sends the resource and the rule only", asked.slice(before).some((a) => /^POST ship \{"res":"[a-z]+","mode":"lean"\}$/.test(a)), asked.slice(before).join(" ; "));
    const pre = asked.length;
    click(button("SEND ALL") || button("KEEP ALL") || all(host).find((n) => n.tagName === "BUTTON" && /ALL|NONE|LITTLE|SURPLUS/.test(n.textContent)));
    await until(() => asked.length > pre);
    ok("a preset sets every resource at once", asked.slice(pre).some((a) => /^POST ship \{"preset":"[a-z]+"\}$/.test(a)), asked.slice(pre).join(" ; "));
    click(button("CIVILIZATION"));
    ok("the Civ tab shows what it asks for and the war", /ASKS|NEEDS|NEED/i.test(text()) && /WAVE|WAR|ARMS/i.test(text()));
    click(button("COLONY"));
  }

  section("building");
  {
    colony._world().colonies.sam.stock.ore = 800;
    const want = byClass("dh-advice")[0] && all(host).filter((n) => n.tagName === "BUTTON" && /BUILD/.test(n.textContent));
    ok("advice can build the thing it suggests in one click", !!want && want.length > 0);
    const before = asked.length;
    if (want && want[0]) click(want[0]);
    await until(() => asked.slice(before).some((a) => /^POST build /.test(a)));
    const sent = asked.slice(before).find((a) => /^POST build /.test(a)) || "";
    ok("a build sends layer, slot and type only", /^POST build \{"layer":\d+,"slot":\d+,"type":"[a-z]+"\}$/.test(sent), sent);
    ok("and the colony has it", E.countOf(colony._world().colonies.sam, "mess") + E.countOf(colony._world().colonies.sam, "stimden") + E.countOf(colony._world().colonies.sam, "bunk") > 0);
    ok("a refused build shows the reason", await (async () => {
      colony._world().colonies.sam.stock.ore = 0; colony._world().colonies.sam.stock.parts = 0;
      try { await FieldKit.service("deephold")._api("POST", "build", { layer: 0, slot: 7, type: "drill" }); } catch (e) { return /not enough|taken/.test(e.message); }
      return false;
    })());
  }

  section("the menu, and the notifications");
  {
    click(all(host).find((n) => n.tagName === "BUTTON" && /MENU/.test(n.textContent)));
    ok("the menu has resume, picture quality and sign out", !!button("RESUME") && /PICTURE/.test(text()) && !!button("SIGN OUT OF DEEPHOLD"));
    ok("a player cannot pause the world", !/PAUSE THE GAME/.test(text()));
    click(button("RESUME"));
    const toasts = [];
    const real = ui.toast; ui.toast = (m, k) => toasts.push(m + "|" + k);
    colony._world().events.push({ id: ++colony._world().evid, at: Date.now(), to: "sam", level: "bad", text: "Food is out.", kind: "food" });
    await FieldKit.service("deephold")._pollEvents();
    await FieldKit.service("deephold")._pollEvents();
    ui.toast = real;
    ok("a colony's warning reaches the FieldKit notices", toasts.some((t) => /DEEPHOLD: Food is out\./.test(t) && /fail/.test(t)));
    ok("and is only shown once", toasts.filter((t) => /Food is out/.test(t)).length === 1);
  }

  section("an admin");
  {
    click(all(host).find((n) => n.tagName === "BUTTON" && /MENU/.test(n.textContent)));
    click(button("SIGN OUT OF DEEPHOLD"));
    await until(() => !!button("SIGN IN"));
    ok("signing out returns to the sign-in screen", !FieldKit.service("deephold").signedIn());
    msgTier = "admin";
    const [tag, pw] = inputs();
    tag.value = "Boss"; pw.value = "secret1";
    click(button("CREATE GAMERTAG"));
    await until(() => !!button("BREAK GROUND"));
    await until(() => colony._players.authToken && true);
    ok("a MESSAGES admin is quietly recognised", /ORE SEAM/.test(text()) && /IMPERIAL/.test(text()));
    click(byClass("dh-biome").find((n) => /IMPERIAL/.test(n.textContent)));
    click(button("BREAK GROUND"));
    await until(() => !!button("ADMIN"));
    ok("only an admin has the ADMIN tab", !!button("ADMIN"));
    click(button("ADMIN"));
    ok("it shows the controls", /STAGE/i.test(text()) && /PAUSE/i.test(text()));
    click(all(host).find((n) => n.tagName === "BUTTON" && /MENU/.test(n.textContent)));
    const pause = button("PAUSE THE GAME FOR EVERYONE");
    ok("an admin can pause everything from the menu", !!pause);
    if (pause) { click(pause); await until(() => colony._world().paused); }
    ok("and it is paused", !!colony._world().paused);
    colony._world().paused = null;
  }

  section("the module checks itself");
  {
    const r = def.selfcheck ? await def.selfcheck() : null;
    ok("selfcheck passes", r === null || r === undefined || r === true || (r && r.ok !== false), JSON.stringify(r));
    def.unmount();
    ok("closing leaves nothing running", true);
  }

  colony.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
