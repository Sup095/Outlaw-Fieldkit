/* ============================================================
   FieldKit relay :: colony — DEEPHOLD, on the server

   relay/colony-engine.js is the game. This file is only what a game
   on a server needs around it: who is asking, the clock, and a save
   that survives a power cut (jsonfile.js, like everything else here).

     GET  /colony/me                  your colony, the Civilization, what you may build
     POST /colony/found    { biome, name }
     POST /colony/build    { layer, slot, type }
     POST /colony/demolish { layer, slot }
     POST /colony/toggle   { layer, slot }
     POST /colony/dig      {}
     POST /colony/ship     { res, pct }
     POST /colony/abandon  { confirm: true }
     POST /colony/admin    { action, ... }          admins only

   THE SERVER IS THE GAME. A client says "build a drill on this plot";
   the server checks the cost, the stage, the depth and the biome and
   either does it or says why not. Nothing a client sends is ever a
   quantity of anything it owns. The only numbers that arrive are plot
   numbers and percentages, and they are clamped here.

   WHO MAY PLAY. A vouched-for account (member or admin). A guest is an
   account nobody has approved yet; letting them in would let one person
   make ten accounts to unlock biomes and shrink the Civilization's
   costs, since both count colonies.

   THE CLOCK. The world is stepped every few seconds whether or not
   anybody is looking, and again when somebody asks, so a colony is
   never "behind". A restart picks up where the file left off, up to
   six hours of catch-up.
   ============================================================ */
"use strict";

const path = require("path");
const jf = require("./jsonfile");
const E = require("./colony-engine");

const TICK_MS = 5000;
const SAVE_MS = 30000;
const FOUND_COOLDOWN_MS = 5 * 60 * 1000;
const NAME_MAX = 24;

let world = null;
let file = null;
let dirty = false;
let timers = [];
let log = () => {};
let clock = Date.now;

function load(now) {
  let w = null;
  try { w = jf.read(file, null); }
  catch (e) { log("ERROR", "colony: " + e.message + " Starting with the .bak is not possible; the game is paused until an admin looks."); throw e; }
  if (!w || w.v !== 1 || !w.civ || !w.colonies) w = E.newWorld(now);
  if (!w.cool) w.cool = {};
  return w;
}

/* opts: { dataDir, log, now, start } */
function init(opts) {
  opts = opts || {};
  stop();
  log = opts.log || (() => {});
  clock = opts.now || Date.now;
  file = path.join(opts.dataDir, "colony.json");
  world = load(clock());
  dirty = false;
  if (opts.start !== false) {
    timers.push(setInterval(tick, TICK_MS));
    timers.push(setInterval(() => { if (dirty) flush(); }, SAVE_MS));
    timers.forEach((t) => t.unref && t.unref());
  }
  return world;
}

function stop() { timers.forEach(clearInterval); timers = []; }
/* Runs on a timer inside the relay's own process, so a bug in the game
   must never be able to end the process. It is logged (once a minute at
   most) and the next tick tries again. */
let lastTickError = 0;
function tick() {
  try { E.stepWorld(world, clock()); dirty = true; }
  catch (e) {
    const t = Date.now();
    if (t - lastTickError > 60000) { lastTickError = t; log("ERROR", "colony: a tick failed: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e)); }
  }
}
function flush() {
  if (!world || !file) return;
  try { jf.write(file, world); dirty = false; } catch (e) { log("ERROR", "colony: could not save: " + e.message); }
}

function cleanName(s, fallback) {
  const n = String(s == null ? "" : s).replace(/[^A-Za-z0-9 _.'-]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return n.length >= 2 ? n : fallback;
}

function handleOk(who) {
  /* who: { handle, tier, banned }. Guests wait for approval. */
  if (!who || !who.handle) return { status: 401, body: { error: "sign in to MESSAGES first" } };
  if (who.banned) return { status: 403, body: { error: "this account is banned" } };
  /* A handle such as __proto__ or constructor is a legal account name and an illegal key. */
  if (who.handle in {}) return { status: 403, body: { error: "this account name cannot be used in the game; make another account" } };
  if (who.tier === "guest") return { status: 403, body: { error: "an admin has to approve your account before you can play", needsApproval: true } };
  return null;
}

function reply(h, res, now, who, extra) {
  const v = E.viewFor(world, now, who.handle);
  v.me = who.handle; v.admin = who.tier === "admin";
  v.cooldown = Math.max(0, Math.round(((world.cool[who.handle] || 0) + FOUND_COOLDOWN_MS - now) / 1000));
  return h.send(res, 200, Object.assign(v, extra || {}));
}

function act(who, now, body, fn) {
  const c = world.colonies[who.handle];
  if (!c) return { error: "you do not have a colony yet" };
  c.lastSeen = now;
  const r = fn(c);
  if (r && r.ok) dirty = true;
  return r;
}

const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : -1);

/* h: { send, readBody, who(req) } */
async function route(req, res, url, h) {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "colony" || !world) return false;
  const method = req.method;
  const who = h.who(req);
  const no = handleOk(who);
  if (no) { h.send(res, no.status, no.body); return true; }
  const now = clock();
  const what = seg[1] || "";

  if (what === "me" && method === "GET") {
    E.stepWorld(world, now);
    const c = world.colonies[who.handle];
    if (c) c.lastSeen = now;
    reply(h, res, now, who); return true;
  }
  if (method !== "POST") { h.send(res, 404, { error: "not found" }); return true; }
  let body = {};
  try { body = (await h.readBody(req)) || {}; } catch (e) { h.send(res, e.status || 400, { error: e.message || "bad request" }); return true; }
  E.stepWorld(world, now);

  if (what === "found") {
    const have = world.colonies[who.handle];
    if (have && !have.collapsed) { h.send(res, 409, { error: "you already have a colony" }); return true; }
    if (now - (world.cool[who.handle] || 0) < FOUND_COOLDOWN_MS) { h.send(res, 429, { error: "give the rock a few minutes before you start again" }); return true; }
    if (!E.biomeOpen(world, String(body.biome))) { h.send(res, 400, { error: "that place is not open yet" }); return true; }
    const c = E.newColony(who.handle, String(body.biome), cleanName(body.name, who.handle + "'s hold"), now);
    world.colonies[who.handle] = c;
    world.civ.peak = Math.max(world.civ.peak, E.activeColonies(world, now));
    E.say(world.civ.log, now, c.name + " breaks ground in the " + E.BIOMES[c.biome].name + ".");
    dirty = true;
    reply(h, res, now, who); return true;
  }
  if (what === "abandon") {
    if (!body.confirm) { h.send(res, 400, { error: "confirm to abandon" }); return true; }
    const c = world.colonies[who.handle];
    if (!c) { h.send(res, 404, { error: "no colony" }); return true; }
    delete world.colonies[who.handle];
    world.cool[who.handle] = now;
    dirty = true;
    reply(h, res, now, who); return true;
  }

  if (what === "admin") {
    if (who.tier !== "admin") { h.send(res, 403, { error: "admins only" }); return true; }
    const r = admin(body, now);
    if (r.error) { h.send(res, 400, { error: r.error }); return true; }
    dirty = true;
    reply(h, res, now, who, { did: r.did }); return true;
  }

  let r;
  if (what === "build") r = act(who, now, body, (c) => E.build(world, c, int(body.layer), int(body.slot), String(body.type)));
  else if (what === "demolish") r = act(who, now, body, (c) => E.demolish(c, int(body.layer), int(body.slot)));
  else if (what === "toggle") r = act(who, now, body, (c) => E.toggle(c, int(body.layer), int(body.slot)));
  else if (what === "dig") r = act(who, now, body, (c) => E.startDig(world, c, now));
  else if (what === "ship") r = act(who, now, body, (c) => E.setShip(c, String(body.res), body.pct));
  else { h.send(res, 404, { error: "not found" }); return true; }
  if (r.error) { h.send(res, 400, { error: r.error }); return true; }
  reply(h, res, now, who); return true;
}

/* What an admin can do to the shared state. Every one is logged to the
   Civilization's own log so nobody is surprised by it. */
function admin(b, now) {
  const civ = world.civ;
  switch (String(b.action)) {
    case "setStage": {
      const s = int(b.stage);
      if (s < 0 || s >= E.STAGES.length) return { error: "no such stage" };
      civ.stage = s; civ.progress = {}; civ.fallen = false; civ.liberation = {}; civ.breach = 0;
      if (s >= 2 && !civ.war) E.scheduleWave(world, now, E.WAVE_FIRST_MS);
      if (s < 2) civ.war = null;
      E.say(civ.log, now, "An admin set the Civilization to stage " + s + ".");
      return { did: "stage " + s };
    }
    case "endFall":
      civ.fallen = false; civ.liberation = {}; civ.breach = 20;
      E.say(civ.log, now, "An admin ended the occupation.");
      return { did: "occupation ended" };
    case "waveNow":
      if (civ.stage < 2) return { error: "there is no war before stage 2" };
      if (!civ.war) E.scheduleWave(world, now, 0);
      civ.war.at = now;
      E.stepWorld(world, now + 1);
      return { did: "wave called" };
    case "delayWave":
      if (!civ.war) return { error: "no wave is scheduled" };
      civ.war.at += Math.max(1, Math.min(48, Number(b.hours) || 8)) * 3600 * 1000;
      return { did: "wave delayed" };
    case "grantCiv": {
      const res = String(b.res), n = Math.max(0, Math.min(100000, Number(b.amount) || 0));
      if (E.RES.indexOf(res) < 0) return { error: "unknown resource" };
      civ.stock[res] = (civ.stock[res] || 0) + n;
      return { did: "granted " + n + " " + res };
    }
    case "resetCiv":
      world.civ = E.newCiv(now);
      for (const k of Object.keys(world.colonies)) world.colonies[k].shipped = {};
      E.say(world.civ.log, now, "The Civilization was reset by an admin.");
      return { did: "civilization reset" };
    case "removeColony": {
      const h = String(b.handle);
      if (!world.colonies[h]) return { error: "no such colony" };
      delete world.colonies[h]; delete world.cool[h];
      return { did: "colony removed" };
    }
    case "renameColony": {
      const c = world.colonies[String(b.handle)];
      if (!c) return { error: "no such colony" };
      c.name = cleanName(b.name, "Unnamed hold");
      if (civ.givers[c.handle]) civ.givers[c.handle].name = c.name;
      return { did: "renamed" };
    }
    default: return { error: "unknown action" };
  }
}

/* One line for ADMIN CENTER. */
function summary() {
  if (!world) return null;
  const now = clock();
  return { stage: world.civ.stage, name: E.STAGES[world.civ.stage].name, colonies: Object.keys(world.colonies).length,
    active: E.activeColonies(world, now), fallen: world.civ.fallen, wins: world.civ.wins, losses: world.civ.losses,
    nextWave: world.civ.war ? world.civ.war.at : null };
}

module.exports = { init, stop, route, flush, tick, summary, _world: () => world, _internals: { cleanName, admin, FOUND_COOLDOWN_MS } };
