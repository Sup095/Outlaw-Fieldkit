/* ============================================================
   FieldKit relay :: admin — one page for whoever runs this relay

   What ADMIN CENTER (modules/admin-center.js) reads and does. Most of
   it only gathers what other parts already know, so that nobody has to
   open five panels to find out whether things are all right. People
   and roles stay with messaging.js (/msg/people, /msg/role) and RUNNER's
   own admin stays on its own connection: those are not repeated here.

     GET  /admin/overview   everything at once
     POST /admin/announce   { text, level, hours } or { end: true }
     POST /admin/block      { op: "allow"|"unallow"|"dismiss"|"refresh", host }
     POST /admin/session    { who }: end someone's browser session
     POST /admin/lens       { url }: where the lighter browser is ("" = off)
     POST /admin/report     any account: "this was blocked by mistake"

   The overview also carries what /probe has heard (relay/probe.js).

   Admins only, checked here on every route but the last. Nothing that
   a person wrote or typed passes through: sites blocked are recorded by
   name and never by who asked, except a report, which someone chose to
   send.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const jf = require("./jsonfile");
const probe = require("./probe");

const EVENTS_MAX = 60;
const REPORTS_MAX = 100;
const HOST_RE = /^[a-z0-9._-]{1,253}$/;

const events = [];
let parts = null;
let blocking = { allow: [], reports: [] };
let file = null;
const startedAt = Date.now();

/* Called from the relay's log(): warnings and errors, newest first. */
function note(level, msg) {
  if (level !== "WARN" && level !== "ERROR") return;
  events.unshift({ at: Date.now(), level: level, msg: String(msg).slice(0, 300) });
  if (events.length > EVENTS_MAX) events.pop();
}

function pushAllow() {
  const { engine, overflow, config } = parts;
  const all = ((config && config.browser && config.browser.adblockAllow) || []).concat(blocking.allow);
  if (engine && engine.lists) engine.lists.setAllow(all);
  if (overflow) overflow.setAllow(all);
}

/* opts: { dataDir, engine, overflow, fairness, runner, messaging,
   updates, notices, config, log } */
function init(opts) {
  parts = opts;
  file = path.join(opts.dataDir, "blocking.json");
  blocking = Object.assign({ allow: [], reports: [] }, jf.read(file, {}) || {});
  pushAllow();
}

function save() {
  try { jf.write(file, blocking); } catch (e) { parts.log("WARN", "admin: could not save blocking.json: " + e.message); }
}

function diskOf(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { totalGb: Math.round(s.blocks * s.bsize / 1e8) / 10, freeGb: Math.round(s.bavail * s.bsize / 1e8) / 10 };
  } catch (e) { return null; }
}

async function overview() {
  const { engine, overflow, fairness, runner, messaging, updates, notices, dataDir, lens } = parts;
  const mem = process.memoryUsage();
  const fair = fairness ? fairness.meter : null;
  const browser = engine ? engine.status() : { enabled: false };
  const sessions = engine ? Array.from(engine.sessions.values()).map((s) => ({
    who: String(s.who), tier: s.tier, tabs: (s.tabs || []).length, viewers: s.viewers.size,
    idleSec: Math.round((Date.now() - (s.lastSeen || Date.now())) / 1000) })) : [];
  const helpers = overflow ? overflow.view() : [];
  const lists = engine && engine.lists ? engine.lists.view() : null;
  if (lists) {
    for (const h of helpers) for (const k of Object.keys(h.blocked || {})) lists.blocked[k] = (lists.blocked[k] || 0) + h.blocked[k];
  }
  let run = null;
  try { run = runner ? await runner.status() : null; } catch (e) { run = { enabled: true, online: false, why: e.message }; }
  return {
    at: Date.now(),
    relay: { uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version,
      memMb: Math.round(mem.rss / 1048576), load: os.loadavg()[0], cpus: os.cpus().length,
      disk: diskOf(dataDir), upKbps: fair ? fair.upKbps || 0 : null, cpu: fair ? fair.cpu : null, mem: fair ? fair.mem : null },
    browser: Object.assign(browser, { sessionList: sessions, helpers: helpers }, lens ? { lens: Object.assign(lens.view(), { url: lens.url() }) } : {}),
    upload: parts.upload ? parts.upload() : null,
    runner: run,
    people: messaging && messaging.counts ? messaging.counts() : null,
    blocking: lists ? Object.assign(lists, { reports: blocking.reports, allowed: blocking.allow }) : null,
    updates: updates && updates.state ? updates.state() : null,
    addresses: parts.addresses ? { list: parts.addresses.state.addresses, checkedAt: parts.addresses.state.checkedAt, error: parts.addresses.state.error } : null,
    shelf: parts.shelf ? { models: parts.shelf.list().map((m) => ({ id: m.id, mb: m.mb })), filling: parts.shelf.state.filling, error: parts.shelf.state.error } : null,
    notices: notices ? notices.list() : [],
    announcement: notices ? notices.announcement() : null,
    devices: probe.list().slice(0, 12),
    events: events.slice(0, EVENTS_MAX)
  };
}

function hostFrom(v) {
  const h = String(v || "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return HOST_RE.test(h) ? h : null;
}

/* helpers: { send, readBody, who(req) -> handle or null, isAdmin(req) } */
async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "admin") return false;
  const { send, readBody } = helpers;
  const what = seg[1] || "", method = req.method;

  if (what === "report" && method === "POST") {
    const who = helpers.who(req);
    if (!who) { send(res, 401, { error: "sign in first" }); return true; }
    const body = await readBody(req).catch(() => null);
    const host = hostFrom(body && body.host);
    if (!host) { send(res, 400, { error: "which site?" }); return true; }
    if (!blocking.reports.some((r) => r.host === host)) {
      blocking.reports.unshift({ host: host, by: String(who), at: Date.now(), kind: String((body && body.kind) || "").slice(0, 20) });
      blocking.reports = blocking.reports.slice(0, REPORTS_MAX);
      save();
    }
    send(res, 200, { ok: true });
    return true;
  }

  if (!helpers.isAdmin(req)) { send(res, 403, { error: "admins only" }); return true; }

  if (what === "overview" && method === "GET") { send(res, 200, await overview()); return true; }

  if (what === "announce" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) { send(res, 400, { error: "expected a JSON body" }); return true; }
    if (body.end) { parts.notices.endAnnouncement(); send(res, 200, { ok: true }); return true; }
    try { send(res, 200, parts.notices.announce(body.text, body.level, body.hours, helpers.who(req) || "admin")); }
    catch (e) { send(res, 400, { error: e.message }); }
    return true;
  }

  if (what === "block" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const op = body && body.op;
    if (op === "refresh") {
      if (parts.engine && parts.engine.lists) parts.engine.lists.refresh().catch(() => {});
      send(res, 200, { ok: true });
      return true;
    }
    const host = hostFrom(body && body.host);
    if (!host) { send(res, 400, { error: "which site?" }); return true; }
    if (op === "allow") {
      if (blocking.allow.indexOf(host) < 0) blocking.allow.push(host);
      blocking.reports = blocking.reports.filter((r) => r.host !== host);
    } else if (op === "unallow") {
      blocking.allow = blocking.allow.filter((h) => h !== host);
    } else if (op === "dismiss") {
      blocking.reports = blocking.reports.filter((r) => r.host !== host);
    } else { send(res, 400, { error: "no such action" }); return true; }
    save();
    pushAllow();
    send(res, 200, { ok: true });
    return true;
  }

  if (what === "lens" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const u = String((body && body.url) || "").trim();
    if (!parts.lens) { send(res, 409, { error: "the browser is off on this relay, so there is nothing to point at lens" }); return true; }
    if (!parts.lens.setUrl(u)) { send(res, 400, { error: "that is not an https address" }); return true; }
    try { jf.write(path.join(parts.dataDir, "lens.json"), { url: parts.lens.url() }); }
    catch (e) { parts.log("WARN", "admin: could not save lens.json: " + e.message); }
    parts.log("INFO", "admin: lens address " + (u ? "set to " + parts.lens.url() : "cleared"));
    send(res, 200, { ok: true, url: parts.lens.url() });
    return true;
  }

  if (what === "session" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const who = String((body && body.who) || "");
    const { engine, overflow } = parts;
    if (engine && engine.sessions.has(who)) {
      await engine.destroy(who, "an admin ended this session");
      send(res, 200, { ok: true });
      return true;
    }
    const away = overflow ? overflow.holding(who) : null;
    if (away) {
      try { await overflow.clear(away, who, "everything"); send(res, 200, { ok: true }); }
      catch (e) { send(res, 502, { error: "the browser helper is not answering — " + e.message }); }
      return true;
    }
    send(res, 404, { error: "that session has already ended" });
    return true;
  }

  send(res, 404, { error: "no such admin route" });
  return true;
}

/* The lens address ADMIN CENTER saved, read at start (server.js). */
function savedLensUrl(dataDir) {
  const j = jf.read(path.join(dataDir, "lens.json"), {}) || {};
  return typeof j.url === "string" ? j.url : "";
}

module.exports = { init, route, note, overview, savedLensUrl, _internals: { events, hostFrom } };
