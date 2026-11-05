/* ============================================================
   FieldKit relay :: addresses — every address this relay answers on,
   read from its own tunnel

     GET /relay/addresses     the list, for a signed-in panel
     GET /relay/probe/<n>     204 if this relay asked for n (below)

   A school's filter blocks one hostname at a time, so the owner keeps
   adding hostnames to the Cloudflare tunnel and deleting the blocked
   ones. Every copy of FieldKit used to need each new one typed in. Now
   the relay reads the tunnel's live configuration from cloudflared
   itself (its metrics server's /config, on 127.0.0.1:20241 by default:
   the same ingress list the Cloudflare dashboard shows, no API key),
   keeps the hostnames that point at this relay's port, and checks each
   one really reaches THIS relay: it asks https://<host>/relay/probe/<n>
   with a number only it knows. A hostname whose DNS points at another
   tunnel (run., for RUNNER) fails that and is left out.

   The panels fetch the list after they connect (core/relay-choice.js
   learn()) and keep it as their spare addresses, dropping the ones the
   tunnel no longer has.

   WHO MAY ASK. Anyone signed in (the vault, or a messaging account).
   Not the public: the whole list in one answer is exactly what a
   filter's maker would want, to block them all at once.
   ============================================================ */
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");

const DEFAULTS = {
  enabled: true,
  everyMin: 5,                         /* how often the tunnel is read again */
  metricsPorts: [20241, 20242, 20243, 20244, 20245],   /* cloudflared's defaults, in the order it tries them */
  extra: [],                           /* addresses to offer that the tunnel does not list (another tunnel, a direct name) */
  private: []                          /* hostnames never offered: one kept for the servers (lens, helpers, runnerd) only */
};
const PROBE_MS = 8000;

let cfg = Object.assign({}, DEFAULTS);
let log = () => {};
let port = 0;
let timer = null;
let readConfig = null;               /* () => the tunnel's ingress; replaceable for the tests */
let probeHost = null;                /* (host, nonce) => true if it reached this relay */
const nonces = new Set();
let lastHosts = [];                  /* what the tunnel last said, kept through a blip */
const state = { addresses: [], checkedAt: null, tunnelVersion: null, error: null, busy: false };

function getJson(opts, ms) {
  return new Promise((resolve, reject) => {
    const req = (opts.protocol === "https:" ? https : http).get(opts, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; if (body.length > 1 << 20) req.destroy(new Error("too large")); });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("answered " + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("not JSON")); }
      });
    });
    req.setTimeout(ms, () => req.destroy(new Error("no answer in time")));
    req.on("error", reject);
  });
}

/* cloudflared's current configuration: { version, config: { ingress: [...] } }. */
async function tunnelConfig() {
  let last = null;
  for (const p of cfg.metricsPorts) {
    try { return await getJson({ host: "127.0.0.1", port: p, path: "/config" }, 2000); }
    catch (e) { last = e; }
  }
  throw new Error("cloudflared's /config did not answer (" + (last ? last.message : "no ports") + ")");
}

/* The hostnames in an ingress list that point at this relay's port. */
function hostsFor(ingress, relayPort) {
  const here = new RegExp("^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):" + relayPort + "/?$", "i");
  const out = [];
  for (const rule of ingress || []) {
    const h = String((rule && rule.hostname) || "").toLowerCase();
    if (!h || h.indexOf("*") >= 0 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) continue;
    if (rule.path) continue;                       /* only part of a site: not an address for FieldKit */
    if (!here.test(String(rule.service || ""))) continue;
    if (out.indexOf(h) < 0) out.push(h);
  }
  return out;
}

function clean(raw) {
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(String(raw)) ? String(raw) : "https://" + raw); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.origin;
}

async function defaultProbe(origin, nonce) {
  const u = new URL(origin + "/relay/probe/" + nonce);
  return new Promise((resolve) => {
    const req = (u.protocol === "https:" ? https : http).get(u, (res) => { res.resume(); resolve(res.statusCode === 204); });
    req.setTimeout(PROBE_MS, () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

/* Reads the tunnel and checks every hostname. A tunnel that cannot be
   read keeps the last good list: a blip is not "every address is gone". */
async function refresh() {
  if (!cfg.enabled || state.busy) return state;
  state.busy = true;
  try {
    let hosts = [];
    try {
      const c = await readConfig();
      state.tunnelVersion = c && c.version != null ? c.version : null;
      hosts = lastHosts = hostsFor(c && c.config && c.config.ingress, port).map((h) => "https://" + h);
      state.error = null;
    } catch (e) {
      state.error = e.message;
      hosts = lastHosts;
    }
    const hidden = (cfg.private || []).map(clean).filter(Boolean);
    const candidates = [];
    hosts.filter((o) => hidden.indexOf(o) < 0).concat((cfg.extra || []).map(clean).filter(Boolean)).forEach((o) => { if (candidates.indexOf(o) < 0) candidates.push(o); });
    const good = [];
    await Promise.all(candidates.map(async (o) => {
      const n = crypto.randomBytes(12).toString("hex");
      nonces.add(n);
      try { if (await probeHost(o, n)) good.push(o); }
      finally { nonces.delete(n); }
    }));
    /* The tunnel's order, which is the order the owner added them. */
    good.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
    const was = state.addresses.join(" ");
    state.addresses = good;
    if (good.join(" ") !== was) log("INFO", "addresses: " + (good.length ? good.map((o) => o.replace(/^https?:\/\//, "")).join(", ") : "none answer"));
    return state;
  } finally {
    state.checkedAt = new Date().toISOString();
    state.busy = false;
  }
}

function init(opts) {
  cfg = Object.assign({}, DEFAULTS, (opts && opts.config) || {});
  log = (opts && opts.log) || log;
  port = (opts && opts.port) || 0;
  readConfig = (opts && opts.readConfig) || tunnelConfig;
  probeHost = (opts && opts.probe) || defaultProbe;
  lastHosts = [];
  if (timer) clearInterval(timer);
  timer = null;
  if (!cfg.enabled) return { enabled: false };
  if (opts && opts.start !== false) {
    /* A moment after start, so the tunnel has had time to connect. */
    setTimeout(() => refresh().catch(() => {}), 20000).unref();
    timer = setInterval(() => refresh().catch(() => {}), Math.max(1, Number(cfg.everyMin) || 5) * 60000);
    timer.unref();
  }
  return { enabled: true };
}

function stop() { if (timer) clearInterval(timer); timer = null; }

async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "relay") return false;
  const { send } = helpers;
  if (seg[1] === "probe" && seg[2] && req.method === "GET") {
    res.writeHead(nonces.has(seg[2]) ? 204 : 404, { "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  if (seg[1] === "addresses" && !seg[2] && req.method === "GET") {
    if (!helpers.authorise(req)) {
      send(res, 401, { error: "sign in to MESSAGES, or unlock the vault, to get this relay's addresses" });
      return true;
    }
    send(res, 200, { addresses: cfg.enabled ? state.addresses : [], checkedAt: state.checkedAt,
      everyMin: cfg.everyMin, error: state.error });
    return true;
  }
  return false;
}

module.exports = { init, refresh, route, stop, state, hostsFor, DEFAULTS };
