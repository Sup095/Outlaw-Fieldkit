/* ============================================================
   FieldKit relay :: colony — DEEPHOLD's routes, clock and save

   The rules are in colony-engine.js and are pure. This file is the part
   that touches the world: who is asking (relay/colony-players.js),
   the clock that keeps the world running whether or not anyone is
   looking, and the save file.

     POST /colony/register { tag, password }      a gamertag, made here
     POST /colony/login    { tag, password }
     POST /colony/logout
     GET  /colony/me                              the whole picture
     GET  /colony/events?since=N                  warnings and news (does not
                                                  count as a visit)
     POST /colony/found    { biome, name }
     POST /colony/abandon  { confirm: true }
     POST /colony/build    { layer, slot, type }
     POST /colony/demolish { layer, slot }
     POST /colony/toggle   { layer, slot }
     POST /colony/dig
     POST /colony/ship     { res, mode }  or  { preset }
     POST /colony/claimadmin { token }            a MESSAGES admin vouches for
                                                  a gamertag (sent with the
                                                  MESSAGES session)
     POST /colony/admin    { action, ... }        admins of the game only

   Either does it or says why not. Nothing a client sends is ever a
   quantity of anything it owns. The only numbers that arrive are plot
   numbers and percentages, and they are clamped here.

   THE CLOCK. The world is stepped every few seconds whether or not
   anybody is looking, and again when somebody asks, so a colony is
   never "behind". A restart picks up where the file left off, up to
   six hours of catch-up. A colony unvisited for a week is paused.
   ============================================================ */
"use strict";

const path = require("path");
const jf = require("./jsonfile");
const E = require("./colony-engine");
const players = require("./colony-players");
const mail = require("./mail-updates");

/* EMAIL UPDATES: what a player would want to hear while away. Their own
   colony's news, and the Civilization's big moments; not the ten-minute
   wave warning (the one-hour one is the useful one), not "welcome back". */
const MAIL_ALL = { stage: 1, liberated: 1, wave: 1, fall: 1, brownout: 1, pause: 1, war: 1 };
E.onEmit((w, ev) => {
  if (w !== world) return;
  const item = { cat: "deephold", text: ev.text, chk: { k: "dh" } };
  if (ev.to) { if (ev.kind !== "wake") mail.notify({ tag: ev.to }, item); return; }
  if (!MAIL_ALL[ev.kind] || /TEN MINUTES/.test(ev.text)) return;
  mail.broadcast(item, (s) => !!(s.tag && world && has(world.colonies, s.tag) && !world.colonies[s.tag].collapsed));
});
mail.check("dh", (it, s) => {
  const c = s.tag && world && has(world.colonies, s.tag) ? world.colonies[s.tag] : null;
  return !(c && c.lastSeen > it.t);
});

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
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function load(now) {
  let w = null;
  try { w = jf.read(file, null); }
  catch (e) { log("ERROR", "colony: " + e.message + " The game is paused until an admin looks."); throw e; }
  if (!w || w.v !== 2 || !w.civ || !w.colonies) w = E.newWorld(now);
  if (!w.cool) w.cool = {};
  if (!w.events) { w.events = []; w.evid = 0; }
  return w;
}

/* opts: { dataDir, log, now, start } */
function init(opts) {
  opts = opts || {};
  stop();
  log = opts.log || (() => {});
  clock = opts.now || Date.now;
  file = path.join(opts.dataDir, "colony.json");
  players.init({ dataDir: opts.dataDir, now: clock });
  world = load(clock());
  dirty = false;
  if (opts.start !== false) {
    timers.push(setInterval(tick, TICK_MS));
    timers.push(setInterval(() => { if (dirty) flush(); players.flush(); }, SAVE_MS));
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
  players.flush();
}

function cleanName(s, fallback) {
  const n = String(s == null ? "" : s).replace(/[^A-Za-z0-9 _.'-]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return n.length >= 2 ? n : fallback;
}

function reply(h, res, now, who, extra) {
  const v = E.viewFor(world, now, who.key, who.tier === "admin");
  v.me = who.tag; v.admin = who.tier === "admin";
  v.cooldown = Math.max(0, Math.round(((world.cool[who.key] || 0) + FOUND_COOLDOWN_MS - now) / 1000));
  return h.send(res, 200, Object.assign(v, extra || {}));
}

/* a change is reflected at once: power, air and advice are worked out again
   with a sliver of time, so the panel never advises what was just built */
function refresh(c, now) {
  try { E.stepColony(world, c, now, 0.05, E.civAsks(world, now)); } catch (e) { /* the next tick will */ }
}

function act(who, now, fn) {
  const c = has(world.colonies, who.key) ? world.colonies[who.key] : null;
  if (!c) return { error: "you do not have a colony yet" };
  const r = fn(c);
  if (r && r.ok) { dirty = true; refresh(c, now); }
  return r;
}

const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : -1);

/* h: { send, readBody, msgWho(req), ip(req) } */
async function route(req, res, url, h) {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "colony" || !world) return false;
  const method = req.method;
  const what = seg[1] || "";
  const ip = h.ip ? h.ip(req) : "?";
  const now = clock();

  const readBody = async () => { try { return (await h.readBody(req)) || {}; } catch (e) { return { __bad: e }; } };

  /* ---- before there is a player ---- */
  /* For PREFLIGHT and DIAGNOSTICS: is the game running, nothing more. */
  if (what === "status" && method === "GET") { h.send(res, 200, { up: true, paused: !!world.paused }); return true; }
  if (what === "register" || what === "login") {
    if (method !== "POST") { h.send(res, 405, { error: "POST this" }); return true; }
    const b = await readBody();
    if (b.__bad) { h.send(res, b.__bad.status || 400, { error: b.__bad.message || "bad request" }); return true; }
    const r = what === "register" ? players.register(b.tag, b.password, ip) : players.login(b.tag, b.password, ip);
    if (!r.ok) { h.send(res, r.status || 400, { error: r.error }); return true; }
    h.send(res, what === "register" ? 201 : 200, { token: r.token, tag: r.player.tag, admin: r.player.admin });
    return true;
  }

  /* A MESSAGES admin vouching for a gamertag: the request carries the
     MESSAGES session, and the body names the gamertag's own token. */
  if (what === "claimadmin") {
    if (method !== "POST") { h.send(res, 405, { error: "POST this" }); return true; }
    const m = h.msgWho ? h.msgWho(req) : null;
    if (!m || m.tier !== "admin" || m.banned) { h.send(res, 403, { error: "only an admin of this relay can do that" }); return true; }
    const b = await readBody();
    const p = players.authToken(String(b.token || ""));
    if (!p) { h.send(res, 401, { error: "sign in to DEEPHOLD first" }); return true; }
    players.setAdmin(p.key, true);
    log("INFO", "colony: " + p.tag + " was made a DEEPHOLD admin by " + (m.handle || "an admin"));
    h.send(res, 200, { ok: true, admin: true });
    return true;
  }

  const who = players.auth(req);
  if (!who) { h.send(res, 401, { error: "sign in to DEEPHOLD", needsSignIn: true }); return true; }

  if (what === "logout" && method === "POST") {
    players.logout(String(req.headers.authorization || "").slice(7));
    h.send(res, 200, { ok: true });
    return true;
  }

  if (what === "events" && method === "GET") {
    const since = Math.max(-1, int(url.searchParams.get("since")));
    if (since < 0) { h.send(res, 200, { events: [], last: world.evid || 0 }); return true; }
    h.send(res, 200, { events: E.eventsFor(world, who.key, since, 30), last: world.evid || 0, paused: !!world.paused });
    return true;
  }

  if (what === "me" && method === "GET") {
    E.stepWorld(world, now);
    const c = has(world.colonies, who.key) ? world.colonies[who.key] : null;
    if (c && !world.paused) { E.wake(world, c, now); dirty = true; }
    reply(h, res, now, who); return true;
  }
  if (method !== "POST") { h.send(res, 404, { error: "not found" }); return true; }
  const body = await readBody();
  if (body.__bad) { h.send(res, body.__bad.status || 400, { error: body.__bad.message || "bad request" }); return true; }
  E.stepWorld(world, now);

  if (what === "admin") {
    if (who.tier !== "admin") { h.send(res, 403, { error: "admins only" }); return true; }
    const r = admin(body, now, who);
    if (r.error) { h.send(res, 400, { error: r.error }); return true; }
    dirty = true;
    reply(h, res, now, who, { did: r.did }); return true;
  }

  if (world.paused) { h.send(res, 423, { error: "The game is paused by an admin.", paused: true }); return true; }
  const mine = has(world.colonies, who.key) ? world.colonies[who.key] : null;
  if (mine) E.wake(world, mine, now);

  if (what === "found") {
    const have = mine;
    if (have && !have.collapsed) { h.send(res, 409, { error: "you already have a colony" }); return true; }
    if (now - (world.cool[who.key] || 0) < FOUND_COOLDOWN_MS) { h.send(res, 429, { error: "give the rock a few minutes before you start again" }); return true; }
    const biome = String(body.biome);
    if (!E.mayFound(world, biome, who.tier === "admin")) { h.send(res, 400, { error: "that place is not open to you yet" }); return true; }
    const c = E.newColony(who.key, biome, cleanName(body.name, who.tag + "'s hold"), now);
    world.colonies[who.key] = c;
    refresh(c, now);
    world.civ.peak = Math.max(world.civ.peak, E.activeColonies(world, now));
    E.say(world.civ.log, now, c.name + " breaks ground in the " + E.BIOMES[c.biome].name + ".");
    dirty = true;
    reply(h, res, now, who); return true;
  }
  if (what === "abandon") {
    if (!body.confirm) { h.send(res, 400, { error: "confirm to abandon" }); return true; }
    if (!mine) { h.send(res, 404, { error: "no colony" }); return true; }
    delete world.colonies[who.key];
    world.cool[who.key] = now;
    dirty = true;
    reply(h, res, now, who); return true;
  }

  let r;
  if (what === "build") r = act(who, now, (c) => E.build(world, c, int(body.layer), int(body.slot), String(body.type), now));
  else if (what === "demolish") r = act(who, now, (c) => E.demolish(c, int(body.layer), int(body.slot)));
  else if (what === "toggle") r = act(who, now, (c) => E.toggle(c, int(body.layer), int(body.slot)));
  else if (what === "dig") r = act(who, now, (c) => E.startDig(world, c, now));
  else if (what === "ship") {
    r = act(who, now, (c) => body.preset !== undefined ? E.setPreset(c, String(body.preset)) : E.setShip(c, String(body.res), body.mode !== undefined ? body.mode : body.pct));
  }
  else { h.send(res, 404, { error: "not found" }); return true; }
  if (r.error) { h.send(res, 400, { error: r.error }); return true; }
  reply(h, res, now, who); return true;
}

/* What an admin can do to the shared state. Every one is logged to the
   Civilization's own log so nobody is surprised by it. */
function admin(b, now, who) {
  const civ = world.civ;
  switch (String(b.action)) {
    case "pause": {
      const on = b.on !== false;
      if (on && !world.paused) {
        E.stepWorld(world, now);
        world.paused = { since: now, by: who.tag };
        E.say(civ.log, now, "An admin paused the game.");
        E.emit(world, now, null, "warn", "The game was paused by an admin. Nothing runs until it resumes.", "pause");
        return { did: "paused" };
      }
      if (!on && world.paused) {
        E.stepWorld(world, now);              /* shifts every timer by the time stood still */
        world.paused = null;
        E.say(civ.log, now, "An admin resumed the game.");
        E.emit(world, now, null, "ok", "The game is running again.", "pause");
        return { did: "resumed" };
      }
      return { did: on ? "already paused" : "not paused" };
    }
    case "setStage": {
      const s = int(b.stage);
      if (s < 0 || s >= E.STAGES.length) return { error: "no such stage" };
      civ.stage = s; civ.progress = {}; civ.fallen = false; civ.liberation = {}; civ.breach = 0;
      if (s >= 2 && !civ.war) E.scheduleWave(world, now, E.WAVE_FIRST_MS);
      if (s < 2) civ.war = null;
      E.say(civ.log, now, "An admin set the Civilization to stage " + s + ".");
      E.emit(world, now, null, "good", "The Civilization is now stage " + s + ": " + E.STAGES[s].name + ".", "stage");
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
      civ.war.w60 = civ.war.w10 = false;
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
      const h = players.keyOf(b.handle);
      if (!has(world.colonies, h)) return { error: "no such colony" };
      delete world.colonies[h]; delete world.cool[h];
      return { did: "colony removed" };
    }
    case "renameColony": {
      const c = has(world.colonies, players.keyOf(b.handle)) ? world.colonies[players.keyOf(b.handle)] : null;
      if (!c) return { error: "no such colony" };
      c.name = cleanName(b.name, "Unnamed hold");
      if (civ.givers[c.handle]) civ.givers[c.handle].name = c.name;
      return { did: "renamed" };
    }
    case "makeAdmin":
    case "removeAdmin": {
      const on = b.action === "makeAdmin";
      if (players.keyOf(b.handle) === who.key && !on) return { error: "you cannot take your own admin away" };
      if (!players.setAdmin(b.handle, on)) return { error: "no such gamertag" };
      return { did: on ? "admin given" : "admin removed" };
    }
    case "removePlayer": {
      const k = players.keyOf(b.handle);
      if (k === who.key) return { error: "you cannot remove yourself" };
      if (!players.remove(k)) return { error: "no such gamertag" };
      if (has(world.colonies, k)) { delete world.colonies[k]; delete world.cool[k]; }
      return { did: "gamertag removed" };
    }
    default: return { error: "unknown action" };
  }
}

/* One line for ADMIN CENTER. */
function summary() {
  if (!world) return null;
  const now = clock();
  return { stage: world.civ.stage, name: E.STAGES[world.civ.stage].name, colonies: Object.keys(world.colonies).length,
    players: players.count(), active: E.activeColonies(world, now), fallen: world.civ.fallen, wins: world.civ.wins, losses: world.civ.losses,
    paused: !!world.paused, nextWave: world.civ.war ? world.civ.war.at : null };
}

module.exports = { init, stop, route, flush, tick, summary, _world: () => world, _players: players, _internals: { cleanName, admin, FOUND_COOLDOWN_MS } };
