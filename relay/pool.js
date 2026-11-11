/* ============================================================
   FieldKit relay :: pool — POOL HALL, eight-ball and nine-ball against friends

   Who plays: the same gamertags as DEEPHOLD (relay/colony-players.js).
   One gamertag for FieldKit's games; nothing here touches MESSAGES.

   How a match runs. A challenge names a gamertag, or is left open for
   anyone, and a game: eight-ball, or nine-ball (0.16.3). Once taken, the two take turns: a shot is sent as a
   direction, a power and where the tip hits, and the relay plays it
   with the same engine the panels use (core/pool-engine.js) and
   decides what happened. Each player's panel replays the shot from the
   same table and lands exactly where the relay did, so what you watch
   is what counted, and nobody can claim a shot that did not happen.

   What is kept: open challenges and matches (pool.json), and each
   gamertag's wins, losses, rating and streak.

   THE LADDER (0.16.3). Every finished match moves both ratings, the
   way chess does it (Elo): everyone starts at 1000, beating someone
   rated above you is worth more than beating someone below, and the
   first ten games move faster so a new player finds their place. A
   concession counts as a loss. The lobby shows the top ten. A challenge nobody takes goes after two
   days; a match nobody touches for a week is called off.
   ============================================================ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const jf = require("./jsonfile");
const players = require("./colony-players");
let E = null;
try { E = require("./pool-engine"); } catch (e) { try { E = require("../core/pool-engine"); } catch (e2) { E = null; } }

const INVITE_MS = 2 * 24 * 3600 * 1000;
const IDLE_MS = 7 * 24 * 3600 * 1000;
const OVER_KEEP_MS = 24 * 3600 * 1000;
const ONLINE_MS = 2 * 60 * 1000;
const MAX_OPEN_PER_PLAYER = 4, MAX_LIVE_PER_PLAYER = 8, MAX_MATCHES = 2000;
const SAVE_MS = 20000;

let file = null, data = null, clock = Date.now, log = () => {}, dirty = false, timer = null;
const seen = new Map();             /* key -> { tag, at } : who has the hall open */

function init(opts) {
  opts = opts || {};
  log = opts.log || (() => {});
  clock = opts.now || Date.now;
  file = path.join(opts.dataDir, "pool.json");
  data = jf.read(file, null);
  if (!data || data.v !== 1) data = { v: 1, matches: {}, records: {} };
  if (!data.records) data.records = {};
  seen.clear();
  if (timer) clearInterval(timer);
  if (opts.start !== false) { timer = setInterval(() => { sweep(); if (dirty) flush(); }, SAVE_MS); if (timer.unref) timer.unref(); }
  return data;
}
function flush() { if (!data || !file) return; try { jf.write(file, data); dirty = false; } catch (e) { log("ERROR", "pool: could not save: " + e.message); } }
function stop() { if (timer) clearInterval(timer); timer = null; }

function sweep() {
  if (!data) return;
  const now = clock();
  for (const id of Object.keys(data.matches)) {
    const m = data.matches[id];
    if (m.status === "invite" && now - m.created > INVITE_MS) { delete data.matches[id]; dirty = true; }
    else if (m.status === "live" && now - m.updated > IDLE_MS) { m.status = "over"; m.state.over = true; m.state.msg = "Called off: nobody played for a week."; m.updated = now; dirty = true; }
    else if (m.status === "over" && now - m.updated > OVER_KEEP_MS) { delete data.matches[id]; dirty = true; }
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const START = 1000, LADDER = 10;
function record(key) {
  if (!has(data.records, key)) data.records[key] = { w: 0, l: 0 };
  const r = data.records[key];
  if (typeof r.r !== "number") r.r = START;
  if (typeof r.s !== "number") r.s = 0;
  if (typeof r.best !== "number") r.best = 0;
  return r;
}
/* Elo: K 40 for a player's first ten games, 24 after. */
function rate(win, lose) {
  const exp = 1 / (1 + Math.pow(10, (lose.r - win.r) / 400));
  const kw = win.w + win.l < 10 ? 40 : 24, kl = lose.w + lose.l < 10 ? 40 : 24;
  const up = Math.max(1, Math.round(kw * (1 - exp))), down = Math.max(1, Math.round(kl * (1 - exp)));
  win.r += up; lose.r = Math.max(100, lose.r - down);
  return [up, -down];
}
function ladder(meKey) {
  const rows = Object.keys(data.records).map((k) => ({ k: k, x: record(k) })).filter((o) => o.x.w + o.x.l > 0 && o.x.tag)
    .sort((a, b) => b.x.r - a.x.r || b.x.w - a.x.w || String(a.x.tag).localeCompare(String(b.x.tag)));
  const rank = rows.findIndex((o) => o.k === meKey);
  return { top: rows.slice(0, LADDER).map((o, i) => ({ n: i + 1, tag: o.x.tag, r: o.x.r, w: o.x.w, l: o.x.l, s: o.x.s, me: o.k === meKey })),
    rank: rank >= 0 ? rank + 1 : null, of: rows.length };
}
function seat(m, key) { return m.a === key ? 0 : m.b === key ? 1 : -1; }
function mine(key) { return Object.keys(data.matches).map((id) => data.matches[id]).filter((m) => m.a === key || m.b === key); }

/* What a player may see of a match. */
function viewOf(m, key) {
  const s = seat(m, key);
  return {
    id: m.id, status: m.status, seat: s, names: [m.names[0], m.names[1] || null], open: !m.b && m.status === "invite", game: m.game || "8ball",
    to: m.toTag || null, created: m.created, updated: m.updated, seq: m.seq,
    yourTurn: m.status === "live" && s >= 0 && m.state.turn === s && !m.state.over,
    state: m.status === "invite" ? null : m.state,
    last: m.last || null, rated: m.rated || null
  };
}
function brief(m, key) {
  const s = seat(m, key), st = m.state;
  return {
    id: m.id, status: m.status, seat: s, names: m.names, open: !m.b, to: m.toTag || null, seq: m.seq, updated: m.updated, game: m.game || "8ball",
    yourTurn: m.status === "live" && st && st.turn === s && !st.over,
    winner: st && st.over ? st.winner : null, delta: m.rated && s >= 0 ? m.rated[s] : null,
    groups: st ? st.groups : null, left: st ? [E.groupLeft(st, 0), E.groupLeft(st, 1)] : null
  };
}

function lobby(who) {
  const now = clock();
  const online = [];
  for (const [k, v] of seen) if (now - v.at < ONLINE_MS && k !== who.key) online.push(v.tag);
  const all = Object.keys(data.matches).map((id) => data.matches[id]);
  return {
    me: who.tag, record: Object.assign({}, record(who.key), { tag: undefined }), ladder: ladder(who.key), up: !!E,
    online: online.sort().slice(0, 50),
    open: all.filter((m) => m.status === "invite" && !m.toKey && m.a !== who.key).slice(0, 20).map((m) => brief(m, who.key)),
    invites: all.filter((m) => m.status === "invite" && m.toKey === who.key).map((m) => brief(m, who.key)),
    sent: all.filter((m) => m.status === "invite" && m.a === who.key).map((m) => brief(m, who.key)),
    matches: mine(who.key).filter((m) => m.status !== "invite").sort((x, y) => y.updated - x.updated).slice(0, 20).map((m) => brief(m, who.key))
  };
}

function newId() { return crypto.randomBytes(6).toString("hex"); }

function challenge(who, b) {
  if (!E) return { status: 503, error: "pool is not running on this relay" };
  const open = mine(who.key).filter((m) => m.status === "invite" && m.a === who.key).length;
  if (open >= MAX_OPEN_PER_PLAYER) return { status: 429, error: "you already have " + open + " challenges waiting" };
  if (Object.keys(data.matches).length >= MAX_MATCHES) return { status: 503, error: "the hall is full; try later" };
  let toKey = null, toTag = null;
  if (b.to) {
    toKey = players.keyOf(b.to);
    if (toKey === who.key) return { error: "you cannot challenge yourself" };
    if (!players.has(b.to)) return { status: 404, error: "no gamertag called " + String(b.to).slice(0, 24) };
    toTag = String(b.to).trim().slice(0, 24);
    if (mine(who.key).some((m) => m.status === "invite" && m.toKey === toKey)) return { error: "you already challenged " + toTag };
  }
  const now = clock(), id = newId();
  const game = b.game === "9ball" ? "9ball" : "8ball";
  data.matches[id] = { id: id, status: "invite", game: game, a: who.key, b: null, names: [who.tag, toTag], toKey: toKey, toTag: toTag, created: now, updated: now, seq: 0, state: null, last: null };
  dirty = true;
  return { ok: true, match: data.matches[id] };
}

function accept(who, id) {
  const m = has(data.matches, id) ? data.matches[id] : null;
  if (!m || m.status !== "invite") return { status: 404, error: "that challenge is gone" };
  if (m.a === who.key) return { error: "that is your own challenge" };
  if (m.toKey && m.toKey !== who.key) return { status: 403, error: "that challenge is for someone else" };
  if (mine(who.key).filter((x) => x.status === "live").length >= MAX_LIVE_PER_PLAYER) return { status: 429, error: "finish a match first: you have " + MAX_LIVE_PER_PLAYER + " going" };
  const now = clock();
  m.b = who.key; m.names[1] = who.tag; m.status = "live"; m.updated = now; m.seq = 0;
  /* who breaks: the one who was challenged */
  const seed = crypto.randomBytes(4).readUInt32LE(0);
  const names = [m.names[0], m.names[1]];
  m.state = E.newGame(seed, m.game === "9ball" ? "9ball" : "8ball", names);
  m.state.turn = 1; m.state.msg = names[1] + " breaks. Place the cue ball behind the line, then shoot.";
  delete m.toKey;
  dirty = true;
  return { ok: true, match: m };
}

function shoot(who, b) {
  const m = has(data.matches, String(b.id || "")) ? data.matches[String(b.id)] : null;
  if (!m || m.status === "invite") return { status: 404, error: "no such match" };
  const s = seat(m, who.key);
  if (s < 0) return { status: 403, error: "you are not in that match" };
  if (m.status !== "live" || m.state.over) return { error: "the match is over" };
  if (m.state.turn !== s) return { status: 409, error: "it is not your turn", match: m };
  if (Number(b.seq) !== m.seq) return { status: 409, error: "the table changed; look again", match: m };
  const before = m.state;
  const r = E.play(before, b.shot || {});
  if (r.error) return { error: r.error };
  const now = clock();
  m.last = { seq: m.seq, by: s, shot: r.shot, state: before };
  m.state = r.state; m.seq++; m.updated = now;
  if (m.state.over) finishMatch(m);
  dirty = true;
  return { ok: true, match: m };
}

function finishMatch(m) {
  m.status = "over";
  const w = m.state.winner;
  if (w !== 0 && w !== 1) return;
  const win = record(w === 0 ? m.a : m.b), lose = record(w === 0 ? m.b : m.a);
  win.tag = m.names[w]; lose.tag = m.names[1 - w];
  const d = rate(win, lose);
  win.w++; lose.l++;
  win.s = Math.max(0, win.s) + 1; win.best = Math.max(win.best, win.s); lose.s = 0;
  m.rated = w === 0 ? [d[0], d[1]] : [d[1], d[0]];
}

function resign(who, id) {
  const m = has(data.matches, id) ? data.matches[id] : null;
  if (!m) return { status: 404, error: "no such match" };
  const s = seat(m, who.key);
  if (s < 0) return { status: 403, error: "you are not in that match" };
  if (m.status === "invite") { delete data.matches[id]; dirty = true; return { ok: true, gone: true }; }
  if (m.status !== "live") return { error: "the match is over" };
  m.state.over = true; m.state.winner = 1 - s; m.state.phase = "over";
  m.state.msg = m.names[s] + " conceded. " + m.names[1 - s] + " wins.";
  m.updated = clock(); m.seq++;
  finishMatch(m);
  dirty = true;
  return { ok: true, match: m };
}

/* h: { send, readBody, ip(req) } */
async function route(req, res, url, h) {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "pool" || !data) return false;
  const what = seg[1] || "", method = req.method;
  if (what === "status" && method === "GET") { h.send(res, 200, { up: !!E }); return true; }
  const who = players.auth(req);
  if (!who) { h.send(res, 401, { error: "sign in with your gamertag", needsSignIn: true }); return true; }
  seen.set(who.key, { tag: who.tag, at: clock() });
  if (seen.size > 5000) { const cut = clock() - ONLINE_MS; for (const [k, v] of seen) if (v.at < cut) seen.delete(k); }

  const body = async () => { try { return (await h.readBody(req)) || {}; } catch (e) { return { __bad: e }; } };
  const out = (r, key) => {
    if (r.error) { const x = { error: r.error }; if (r.match) x.match = viewOf(r.match, key); h.send(res, r.status || 400, x); }
    else h.send(res, 200, Object.assign({ ok: true }, r.match ? { match: viewOf(r.match, key) } : {}, r.gone ? { gone: true } : {}));
    return true;
  };

  if (what === "lobby" && method === "GET") { sweep(); h.send(res, 200, lobby(who)); return true; }
  if (what === "match" && method === "GET") {
    const id = String(url.searchParams.get("id") || "");
    const m = has(data.matches, id) ? data.matches[id] : null;
    if (!m || (seat(m, who.key) < 0 && !(m.status === "invite" && !m.toKey))) { h.send(res, 404, { error: "no such match" }); return true; }
    h.send(res, 200, { match: viewOf(m, who.key) });
    return true;
  }
  if (method !== "POST") { h.send(res, 405, { error: "POST this" }); return true; }
  const b = await body();
  if (b.__bad) { h.send(res, b.__bad.status || 400, { error: b.__bad.message || "bad request" }); return true; }
  if (what === "challenge") return out(challenge(who, b), who.key);
  if (what === "accept") return out(accept(who, String(b.id || "")), who.key);
  if (what === "decline") {
    const m = has(data.matches, String(b.id || "")) ? data.matches[String(b.id)] : null;
    if (!m || m.status !== "invite" || m.toKey !== who.key) { h.send(res, 404, { error: "that challenge is gone" }); return true; }
    delete data.matches[m.id]; dirty = true;
    h.send(res, 200, { ok: true, gone: true });
    return true;
  }
  if (what === "cancel" || what === "resign") return out(resign(who, String(b.id || "")), who.key);
  if (what === "shot") return out(shoot(who, b), who.key);
  h.send(res, 404, { error: "no such pool route" });
  return true;
}

function summary() {
  if (!data) return null;
  const ms = Object.keys(data.matches).map((id) => data.matches[id]);
  return { up: !!E, live: ms.filter((m) => m.status === "live").length, waiting: ms.filter((m) => m.status === "invite").length, players: Object.keys(data.records).length };
}

module.exports = { init, flush, stop, route, summary, START, _data: () => data, _sweep: sweep, _rate: rate };
