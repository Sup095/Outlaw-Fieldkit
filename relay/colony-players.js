/* ============================================================
   FieldKit relay :: colony-players — who plays DEEPHOLD

   A player is a gamertag and a password, made inside the game. It is
   NOT a MESSAGES account and shares nothing with one: the people on the
   server's own list of players are exactly the people who chose to play,
   which is what the game's scaling counts. Nobody needs approving.

   What keeps it fair without approvals:
     - one colony per gamertag, and the scaling counts colonies that
       were visited in the last week (relay/colony-engine.js);
     - a handful of gamertags per address per day, and a limit on wrong
       passwords (throttled by address and name).

   Passwords are salted and hashed with scrypt and never stored. A
   session is a random token; only its hash is kept. There is no
   password reset: an admin can remove a gamertag so its name is free.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const path = require("path");
const jf = require("./jsonfile");

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,18}[A-Za-z0-9]$/;
const MIN_PASSWORD = 6;
const MAX_PLAYERS = 3000;
const SESSION_MS = 60 * 24 * 3600 * 1000;
const RENEW_MS = 24 * 3600 * 1000;
const SIGNUPS_PER_DAY = 4;          /* per address */
const FAILS_PER_10_MIN = 8;         /* per address + name */

let file = null, data = null, clock = Date.now, dirty = false;
const signups = new Map();          /* ip -> [ms] */
const fails = new Map();            /* ip|key -> [ms] */

function init(opts) {
  opts = opts || {};
  clock = opts.now || Date.now;
  file = path.join(opts.dataDir, "colony-players.json");
  data = jf.read(file, null);
  if (!data || data.v !== 1 || !data.players) data = { v: 1, players: {}, sessions: {} };
  if (!data.sessions) data.sessions = {};
  signups.clear(); fails.clear();
  sweep();
  return data;
}
function save() { try { jf.write(file, data); dirty = false; } catch (e) { dirty = true; } }
function flush() { if (dirty) save(); }

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const keyOf = (tag) => String(tag || "").trim().replace(/\s+/g, " ").toLowerCase();
function validKey(key) { return !(key in {}) && key.indexOf("__") !== 0; }

function hashPw(password, salt) { return crypto.scryptSync(String(password), salt, 32).toString("hex"); }
function same(a, b) { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && crypto.timingSafeEqual(x, y); }

function recent(map, k, ms) {
  const now = clock();
  const list = (map.get(k) || []).filter((t) => now - t < ms);
  map.set(k, list);
  if (map.size > 5000) map.clear();
  return list;
}

function sweep() {
  const now = clock();
  let n = 0;
  for (const h of Object.keys(data.sessions)) if (data.sessions[h].exp < now) { delete data.sessions[h]; n++; }
  if (n) save();
}

function issue(key) {
  const token = crypto.randomBytes(32).toString("hex");
  data.sessions[sha(token)] = { key: key, exp: clock() + SESSION_MS, at: clock() };
  /* a player keeps a handful of sessions, the newest ones */
  const mine = Object.keys(data.sessions).filter((h) => data.sessions[h].key === key).sort((a, b) => data.sessions[a].at - data.sessions[b].at);
  while (mine.length > 6) delete data.sessions[mine.shift()];
  return token;
}

function shape(key) {
  const p = data.players[key];
  return { key: key, tag: p.tag, admin: !!p.admin, tier: p.admin ? "admin" : "player" };
}

function register(tag, password, ip) {
  tag = String(tag == null ? "" : tag).trim().replace(/\s+/g, " ");
  password = String(password == null ? "" : password);
  if (!TAG_RE.test(tag)) return { status: 400, error: "A gamertag is 3 to 20 letters, digits, spaces, dots, dashes or underscores." };
  const key = keyOf(tag);
  if (!validKey(key)) return { status: 400, error: "That gamertag is not available." };
  if (password.length < MIN_PASSWORD) return { status: 400, error: "Use a password of at least " + MIN_PASSWORD + " characters. There is no way to reset it." };
  if (password.length > 200) return { status: 400, error: "That password is too long." };
  if (data.players[key]) return { status: 409, error: "That gamertag is taken." };
  if (Object.keys(data.players).length >= MAX_PLAYERS) return { status: 507, error: "This relay is full." };
  const list = recent(signups, String(ip || "?"), 24 * 3600 * 1000);
  if (list.length >= SIGNUPS_PER_DAY) return { status: 429, error: "Too many gamertags made from here today. Try tomorrow, or sign in to one you have." };
  const salt = crypto.randomBytes(16).toString("hex");
  data.players[key] = { tag: tag, salt: salt, hash: hashPw(password, salt), created: clock(), admin: false };
  list.push(clock());
  const token = issue(key);
  save();
  return { ok: true, token: token, player: shape(key) };
}

function login(tag, password, ip) {
  const key = keyOf(tag);
  const fk = String(ip || "?") + "|" + key;
  const list = recent(fails, fk, 10 * 60 * 1000);
  if (list.length >= FAILS_PER_10_MIN) return { status: 429, error: "Too many wrong tries. Wait a few minutes." };
  const p = validKey(key) && data.players[key];
  /* the same work either way, so nobody can tell a name from a wrong password by timing */
  const salt = p ? p.salt : "00000000000000000000000000000000";
  const h = hashPw(password == null ? "" : password, salt);
  if (!p || !same(h, p.hash)) { list.push(clock()); return { status: 401, error: "Wrong gamertag or password." }; }
  const token = issue(key);
  save();
  return { ok: true, token: token, player: shape(key) };
}

function logout(token) {
  if (!token) return;
  delete data.sessions[sha(token)];
  save();
}

/* The player a request belongs to, or null. */
function authToken(token) {
  if (!token || typeof token !== "string" || token.length < 40 || token.length > 100) return null;
  const h = sha(token), s = data.sessions[h];
  if (!s) return null;
  const now = clock();
  if (s.exp < now) { delete data.sessions[h]; return null; }
  if (!data.players[s.key]) { delete data.sessions[h]; return null; }
  if (s.exp - now < SESSION_MS - RENEW_MS) { s.exp = now + SESSION_MS; dirty = true; }
  return shape(s.key);
}
function auth(req) {
  const h = String((req.headers && req.headers.authorization) || "");
  return h.indexOf("Bearer ") === 0 ? authToken(h.slice(7)) : null;
}

function setAdmin(key, on) {
  key = keyOf(key);
  if (!validKey(key) || !data.players[key]) return false;
  data.players[key].admin = !!on;
  save();
  return true;
}
function remove(key) {
  key = keyOf(key);
  if (!validKey(key) || !data.players[key]) return false;
  delete data.players[key];
  for (const h of Object.keys(data.sessions)) if (data.sessions[h].key === key) delete data.sessions[h];
  save();
  return true;
}
function count() { return data ? Object.keys(data.players).length : 0; }
function has(tag) { const k = keyOf(tag); return validKey(k) && !!(data && data.players[k]); }

module.exports = { init, flush, register, login, logout, auth, authToken, setAdmin, remove, count, has, keyOf, TAG_RE, MIN_PASSWORD };
