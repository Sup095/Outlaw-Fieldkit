/* ============================================================
   FieldKit relay :: mail-updates — EMAIL UPDATES, if you want them

   Opt-in, alongside everything FieldKit already shows. Someone signed
   in (MESSAGES, a gamertag, or both) gives an address, proves it with a
   six-digit code, and picks what they want to hear about:

     messages   someone wrote to you in MESSAGES
     games      POOL HALL challenges, your turn, results (and later games)
     deephold   your colony, the Civilization, waves
     fieldkit   a new FieldKit version, an admin's announcement

   ONE EMAIL, NOT TEN. Nothing is sent the moment it happens. The first
   thing starts a short wait (WAIT_MS, 5 minutes) and each new thing
   restarts it, up to MAX_WAIT_MS from the first; then it all goes in one
   email. One address gets at most one email every GAP_MS and DAY_CAP a
   day, and the relay as a whole maxPerDay (Gmail allows about 500).

   ONLY WHAT YOU HAVE NOT SEEN. Just before sending, each item is asked
   whether it is still news: a message you have since read, a pool shot
   you have since taken, a colony you have since opened are dropped, and
   if nothing is left nothing is sent.

   WHAT IS KEPT: the address, what it wants, which sign-ins it belongs
   to, and the waiting items (data/mail-updates.json). Message text is
   never in an email: MESSAGES is end-to-end encrypted and the relay
   cannot read it. Every email has a link that stops them in one click.
   ============================================================ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const jf = require("./jsonfile");
const mailer = require("./mailer");

const CATS = ["messages", "games", "deephold", "fieldkit"];
const CAT_NAME = { messages: "MESSAGES", games: "GAMES", deephold: "DEEPHOLD", fieldkit: "FIELDKIT" };
const WAIT_MS = 5 * 60 * 1000;
const MAX_WAIT_MS = 15 * 60 * 1000;
const GAP_MS = 15 * 60 * 1000;
const DAY_CAP = 24;
const CODE_MS = 30 * 60 * 1000;
const CODE_TRIES = 5;
const CODES_PER_HOUR = 3;
const CODES_PER_IP_DAY = 8;
const MAX_SUBS = 1000;
const MAX_ITEMS = 40;
const TICK_MS = 30000;
const RETRY_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

let file = null, data = null, cfg = {}, clock = Date.now, log = () => {}, timer = null, dirty = false;
let sender = null, versionOf = null, busy = false;
const checks = new Map();            /* kind -> (item, sub) => still news? */
const ipCodes = new Map();           /* ip -> [ms] */

function init(opts) {
  opts = opts || {};
  cfg = Object.assign({ enabled: true, maxPerDay: 300 }, opts.config || {});
  if (!cfg.from && cfg.user) cfg.from = "FieldKit <" + cfg.user + ">";
  clock = opts.now || Date.now;
  log = opts.log || (() => {});
  sender = opts.send || ((mail) => mailer.send(cfg, mail));
  versionOf = opts.version || null;
  file = path.join(opts.dataDir, "mail-updates.json");
  data = jf.read(file, null);
  if (!data || data.v !== 1 || !data.subs) data = { v: 1, subs: {}, day: { d: "", n: 0 }, announced: null, error: null };
  if (!data.day) data.day = { d: "", n: 0 };
  ipCodes.clear();
  if (timer) clearInterval(timer);
  timer = null;
  if (opts.start !== false && up()) { timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS); if (timer.unref) timer.unref(); }
  return data;
}
function stop() { if (timer) clearInterval(timer); timer = null; }
function save() { if (!file) return; try { jf.write(file, data); dirty = false; } catch (e) { dirty = true; log("ERROR", "mail-updates: could not save: " + e.message); } }
function flush() { if (dirty) save(); }
function up() { return !!(data && cfg.enabled !== false && mailer.configured(cfg)); }

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const today = () => new Date(clock()).toISOString().slice(0, 10);
function subs() { return data ? Object.keys(data.subs).map((id) => data.subs[id]) : []; }
function findBy(who) {
  if (!data || !who) return null;
  return subs().find((s) => (who.msg && s.msg === who.msg) || (who.tag && s.tag === who.tag)) || null;
}
function defaultsCats() { const c = {}; for (const k of CATS) c[k] = true; return c; }
function cleanCats(c, old) {
  const out = Object.assign({}, old || defaultsCats());
  if (c && typeof c === "object") for (const k of CATS) if (has(c, k)) out[k] = !!c[k];
  return out;
}
function view(s) {
  if (!s) return null;
  return { email: s.email, verified: !!s.verified, cats: s.cats, msg: s.msg || null, tag: s.tagName || null,
    waiting: s.verified ? (s.pending || []).length : 0, last: s.last || null };
}

/* ---- the code that proves the address -------------------------------- */
function recent(map, k, ms) {
  const now = clock(), list = (map.get(k) || []).filter((t) => now - t < ms);
  map.set(k, list);
  if (map.size > 5000) map.clear();
  return list;
}
async function sendCode(s, ip) {
  const now = clock();
  s.codeSends = (s.codeSends || []).filter((t) => now - t < 3600000);
  if (s.codeSends.length >= CODES_PER_HOUR) return { status: 429, error: "Three codes this hour already. Check your spam folder, or try again later." };
  const per = recent(ipCodes, String(ip || "?"), 24 * 3600000);
  if (per.length >= CODES_PER_IP_DAY) return { status: 429, error: "Too many codes from here today. Try tomorrow." };
  if (!dayOk()) return { status: 503, error: "This relay has sent all the email it may today. Try tomorrow." };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  s.code = sha(s.id + ":" + code); s.codeExp = now + CODE_MS; s.tries = 0;
  s.codeSends.push(now); per.push(now);
  save();
  const text = "Your FieldKit code is " + code + ".\n\nType it into EMAIL UPDATES in FieldKit to start getting updates at this address. It works for 30 minutes.\n\nIf you did not ask for this, ignore this email: nothing will be sent to you unless the code is typed in.";
  try {
    await sender({ to: s.email, subject: "FieldKit code: " + code, text: text, html: page("Your code", "<p style=\"font-size:15px\">Your FieldKit code is</p><p style=\"font-size:32px;letter-spacing:6px;font-weight:bold;margin:8px 0 16px\">" + code + "</p><p>Type it into EMAIL UPDATES in FieldKit to start getting updates at this address. It works for 30 minutes.</p><p style=\"color:#888\">If you did not ask for this, ignore this email. Nothing will be sent to you unless the code is typed in.</p>", null) });
    countDay();
    data.error = null;
    return { ok: true };
  } catch (e) {
    data.error = { at: now, text: String(e.message).slice(0, 200) };
    log("WARN", "mail-updates: could not send a code: " + e.message);
    save();
    return { status: 502, error: "The email could not be sent: " + String(e.message).slice(0, 140) };
  }
}
function dayOk(extra) {
  const d = today();
  if (data.day.d !== d) data.day = { d: d, n: 0 };
  return data.day.n + (extra || 1) <= (Number(cfg.maxPerDay) || 300);
}
function countDay() { const d = today(); if (data.day.d !== d) data.day = { d: d, n: 0 }; data.day.n++; dirty = true; }

/* who: { msg: handle|null, tag: key|null, tagName } */
async function subscribe(who, body, ip) {
  if (!up()) return { status: 503, error: "Email updates are not set up on this relay." };
  if (!who || (!who.msg && !who.tag)) return { status: 401, error: "Sign in to MESSAGES or with your gamertag first." };
  const email = String((body && body.email) || "").trim();
  if (email.length > 200 || !EMAIL_RE.test(email)) return { error: "That does not look like an email address." };
  let s = findBy(who);
  /* both sign-ins name this one subscription; an older one for either goes */
  for (const o of subs()) {
    if (o === s) continue;
    if ((who.msg && o.msg === who.msg) || (who.tag && o.tag === who.tag)) delete data.subs[o.id];
  }
  if (!s) {
    if (Object.keys(data.subs).length >= MAX_SUBS) return { status: 507, error: "This relay has as many email updates as it can keep." };
    const id = crypto.randomBytes(8).toString("hex");
    s = data.subs[id] = { id: id, created: clock(), cats: defaultsCats(), pending: [], codeSends: [] };
  }
  const changed = s.email !== email;
  s.email = email;
  if (who.msg) s.msg = who.msg;
  if (who.tag) { s.tag = who.tag; s.tagName = who.tagName || who.tag; }
  s.cats = cleanCats(body && body.cats, s.cats);
  if (changed || !s.verified) { s.verified = false; s.pending = []; s.due = 0; s.off = crypto.randomBytes(16).toString("hex"); }
  dirty = true;
  if (s.verified) { save(); return { ok: true, sub: view(s) }; }
  const r = await sendCode(s, ip);
  if (r.error) return Object.assign(r, { sub: view(s) });
  return { ok: true, sub: view(s), sentCode: true };
}
function verify(who, code) {
  const s = findBy(who);
  if (!s) return { status: 404, error: "Give your email address first." };
  if (s.verified) return { ok: true, sub: view(s) };
  if (!s.code || clock() > s.codeExp) return { error: "That code ran out. Ask for a new one." };
  if ((s.tries || 0) >= CODE_TRIES) return { status: 429, error: "Too many wrong codes. Ask for a new one." };
  const want = Buffer.from(s.code, "hex"), got = Buffer.from(sha(s.id + ":" + String(code || "").replace(/\D/g, "")), "hex");
  if (!crypto.timingSafeEqual(want, got)) { s.tries = (s.tries || 0) + 1; dirty = true; return { error: "That is not the code. " + (CODE_TRIES - s.tries) + " tries left." }; }
  s.verified = true; s.code = null; s.codeExp = 0; s.tries = 0; s.verifiedAt = clock();
  save();
  return { ok: true, sub: view(s) };
}
function settings(who, body) {
  const s = findBy(who);
  if (!s) return { status: 404, error: "You have no email updates." };
  s.cats = cleanCats(body && body.cats, s.cats);
  if (s.pending) s.pending = s.pending.filter((it) => s.cats[it.cat]);
  if (who.msg && !s.msg) s.msg = who.msg;
  if (who.tag && !s.tag) { s.tag = who.tag; s.tagName = who.tagName || who.tag; }
  save();
  return { ok: true, sub: view(s) };
}
function remove(who) {
  const s = findBy(who);
  if (s) { delete data.subs[s.id]; save(); }
  return { ok: true, sub: null };
}
async function test(who) {
  const s = findBy(who);
  if (!s || !s.verified) return { status: 404, error: "Prove your address first." };
  if (s.testAt && clock() - s.testAt < 10 * 60 * 1000) return { status: 429, error: "One test email every ten minutes." };
  s.testAt = clock();
  const r = await deliver(s, [{ t: clock(), cat: "fieldkit", text: "This is a test. Email updates work, and this is what they look like." }], true);
  return r.ok ? { ok: true, sub: view(s) } : { status: 502, error: r.error };
}

/* ---- something happened ------------------------------------------------
   who: { msg } or { tag }. item: { cat, text, chk, key }. chk is plain data
   for the check named chk.k; key merges repeats (three messages from one
   person are one line with a count). */
function push(s, item) {
  if (!s.verified || !s.cats[item.cat]) return false;
  const now = clock();
  s.pending = s.pending || [];
  const same = item.key ? s.pending.find((p) => p.key === item.key) : s.pending.find((p) => p.text === item.text && p.cat === item.cat);
  if (same) { same.n = (same.n || 1) + 1; same.t = now; if (item.text) same.text = String(item.text).slice(0, 300); if (item.many) same.many = String(item.many).slice(0, 300); if (item.chk) same.chk = item.chk; }
  else s.pending.push({ t: now, cat: item.cat, text: String(item.text).slice(0, 300), many: item.many ? String(item.many).slice(0, 300) : null, chk: item.chk || null, key: item.key || null });
  while (s.pending.length > MAX_ITEMS) s.pending.shift();
  if (!s.first) s.first = now;
  s.due = Math.min(s.first + MAX_WAIT_MS, now + WAIT_MS);
  dirty = true;
  return true;
}
function notify(who, item) {
  if (!up() || !item || CATS.indexOf(item.cat) < 0) return 0;
  let n = 0;
  for (const s of subs()) {
    if ((who.msg && s.msg === who.msg) || (who.tag && s.tag === who.tag)) if (push(s, item)) n++;
  }
  return n;
}
/* To everyone who wants this kind; filter(sub) narrows it (players only). */
function broadcast(item, filter) {
  if (!up() || !item || CATS.indexOf(item.cat) < 0) return 0;
  let n = 0;
  for (const s of subs()) if ((!filter || filter(s)) && push(s, item)) n++;
  return n;
}
function check(kind, fn) { checks.set(kind, fn); }
function stillNews(it, s) {
  if (!it.chk || !it.chk.k || !checks.has(it.chk.k)) return true;
  try { return checks.get(it.chk.k)(it, s) !== false; } catch (e) { return true; }
}

/* ---- the email ---------------------------------------------------------- */
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]); }
function offUrl(s) {
  const base = String(cfg.publicUrl || "").trim().replace(/\/+$/, "");
  return base && /^https?:\/\//.test(base) ? base + "/email/off?id=" + s.id + "&t=" + s.off : null;
}
function page(title, inner, off) {
  return "<!doctype html><html><body style=\"margin:0;background:#101418;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#e4e8ec\">" +
    "<div style=\"max-width:560px;margin:0 auto;padding:22px 16px\">" +
    "<div style=\"font:bold 13px Consolas,monospace;letter-spacing:3px;color:#7fd6a4;margin-bottom:12px\">FIELDKIT &middot; " + esc(title.toUpperCase()) + "</div>" +
    "<div style=\"background:#1a2128;border:1px solid #2c3640;border-radius:8px;padding:18px 18px 8px;font-size:14px;line-height:1.5\">" + inner + "</div>" +
    "<div style=\"color:#7c8894;font-size:12px;margin-top:14px;line-height:1.5\">You get these because you turned on EMAIL UPDATES in FieldKit. Change what you get there" +
    (off ? ", or <a href=\"" + esc(off) + "\" style=\"color:#9ab\">stop all of them</a>." : ".") + "</div></div></body></html>";
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
}
function compose(s, items) {
  const now = clock(), off = offUrl(s);
  const groups = CATS.filter((c) => items.some((i) => i.cat === c));
  const line = (i) => (i.n || 1) > 1 ? (i.many ? i.many.replace("{n}", i.n) : i.text + " (" + i.n + " times)") : i.text;
  const first = items[0], subject = items.length === 1
    ? "FieldKit: " + ((/^[A-Z][A-Z ]+: /.test(line(first)) ? "" : CAT_NAME[first.cat] + ": ") + line(first)).slice(0, 100)
    : "FieldKit: " + items.length + " updates (" + groups.map((g) => CAT_NAME[g]).join(", ") + ")";
  let text = "", html = "";
  for (const g of groups) {
    text += CAT_NAME[g] + "\n";
    html += "<div style=\"font:bold 12px Consolas,monospace;letter-spacing:2px;color:#e8b14a;margin:4px 0 6px\">" + CAT_NAME[g] + "</div><ul style=\"margin:0 0 14px;padding-left:18px\">";
    for (const i of items.filter((x) => x.cat === g)) {
      text += "  - " + line(i) + "  (" + ago(now - i.t) + ")\n";
      html += "<li style=\"margin:0 0 6px\">" + esc(line(i)) + " <span style=\"color:#7c8894\">&middot; " + ago(now - i.t) + "</span></li>";
    }
    text += "\n";
    html += "</ul>";
  }
  text += "Open FieldKit to answer.\n\nYou get these because you turned on EMAIL UPDATES in FieldKit; change what you get there." + (off ? "\nStop all of them: " + off : "") + "\n";
  return { to: s.email, subject: subject, text: text, html: page("updates", html, off), unsubscribe: off };
}
async function deliver(s, items, forced) {
  if (!dayOk()) return { ok: false, error: "the relay's daily email limit is used up" };
  try {
    await sender(compose(s, items));
    countDay();
    s.last = clock();
    const d = today();
    s.sent = s.sent && s.sent.d === d ? { d: d, n: s.sent.n + 1 } : { d: d, n: 1 };
    data.error = null;
    if (!forced) { s.pending = []; s.first = 0; s.due = 0; }
    save();
    return { ok: true };
  } catch (e) {
    data.error = { at: clock(), text: String(e.message).slice(0, 200) };
    log("WARN", "mail-updates: could not send: " + e.message);
    dirty = true;
    return { ok: false, error: "The email could not be sent: " + String(e.message).slice(0, 140) };
  }
}

/* Runs every TICK_MS: the new-version email, then whatever is due. */
async function tick() {
  if (!up() || busy) return;
  busy = true;
  try {
    if (versionOf) {
      let v = null;
      try { v = versionOf(); } catch (e) { v = null; }
      if (v && v !== data.announced) {
        if (data.announced) broadcast({ cat: "fieldkit", text: "FieldKit " + v + " is out. Open FieldKit and it will offer the update (UPDATES panel).", key: "version" });
        data.announced = v; dirty = true;
      }
    }
    const now = clock(), d = today();
    for (const s of subs()) {
      if (!s.verified || !s.pending || !s.pending.length || !s.due || now < s.due) continue;
      if (s.last && now - s.last < GAP_MS) { s.due = s.last + GAP_MS; continue; }
      if (s.sent && s.sent.d === d && s.sent.n >= DAY_CAP) continue;
      const items = s.pending.filter((it) => s.cats[it.cat] && stillNews(it, s));
      if (!items.length) { s.pending = []; s.first = 0; s.due = 0; dirty = true; continue; }
      const r = await deliver(s, items);
      if (!r.ok) { s.due = now + RETRY_MS; if (!dayOk()) break; }
    }
    if (dirty) save();
  } finally { busy = false; }
}

/* ---- routes -----------------------------------------------------------
   h: { send, readBody, ip, who(req, body) -> { msg, tag, tagName } } */
async function route(req, res, url, h) {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "email" || !data) return false;
  const what = seg[1] || "", method = req.method;
  if (what === "status" && method === "GET") { h.send(res, 200, { up: up() }); return true; }
  if (what === "off" && method === "GET") { offPage(res, url); return true; }
  if (method !== "POST") { h.send(res, 405, { error: "POST this" }); return true; }
  let body;
  try { body = (await h.readBody(req)) || {}; } catch (e) { h.send(res, e.status || 400, { error: e.message || "bad request" }); return true; }
  const who = h.who(req, body);
  const out = (r) => { h.send(res, r.error ? (r.status || 400) : 200, r.error ? { error: r.error, sub: r.sub || undefined } : Object.assign({ ok: true }, r)); return true; };
  if (what === "me") return out({ up: up(), me: { msg: who.msg || null, tag: who.tagName || null }, sub: view(findBy(who)), cats: CATS });
  if (!who.msg && !who.tag) { h.send(res, 401, { error: "Sign in to MESSAGES or with your gamertag first.", needsSignIn: true }); return true; }
  if (what === "subscribe") return out(await subscribe(who, body, h.ip(req)));
  if (what === "resend") {
    const s = findBy(who);
    if (!s || s.verified) return out({ status: 404, error: "There is no code waiting." });
    return out(Object.assign(await sendCode(s, h.ip(req)), { sub: view(s) }));
  }
  if (what === "verify") return out(verify(who, body.code));
  if (what === "settings") return out(settings(who, body));
  if (what === "test") return out(await test(who));
  if (what === "stop") return out(remove(who));
  h.send(res, 404, { error: "no such email route" });
  return true;
}
function offPage(res, url) {
  const id = String(url.searchParams.get("id") || ""), t = String(url.searchParams.get("t") || "");
  const s = has(data.subs, id) ? data.subs[id] : null;
  const good = !!(s && s.off && t.length === s.off.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s.off)));
  let inner;
  if (!good) inner = "<p>These email updates are already off, or the link is old.</p>";
  else if (url.searchParams.get("yes") === "1") { delete data.subs[id]; save(); inner = "<p><b>Done.</b> No more emails will be sent to " + esc(s.email) + ".</p><p>You can turn them on again in FieldKit, EMAIL UPDATES.</p>"; }
  else inner = "<p>Stop all FieldKit email updates to <b>" + esc(s.email) + "</b>?</p><p><a href=\"/email/off?id=" + esc(id) + "&amp;t=" + esc(t) + "&amp;yes=1\" style=\"display:inline-block;background:#c0453a;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:bold\">STOP THE EMAILS</a></p>";
  const html = page("email updates", inner, null).replace(/You get these because[^<]*<\/div>/, "</div>");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
  res.end(html);
}

function summary() {
  if (!data) return null;
  const all = subs();
  return { up: up(), subscribers: all.filter((s) => s.verified).length, waiting: all.reduce((n, s) => n + (s.verified ? (s.pending || []).length : 0), 0),
    sentToday: data.day.d === today() ? data.day.n : 0, maxPerDay: Number(cfg.maxPerDay) || 300, error: data.error || null };
}

module.exports = { init, stop, flush, tick, route, notify, broadcast, check, summary, up, CATS,
  WAIT_MS, MAX_WAIT_MS, GAP_MS, DAY_CAP, _data: () => data, _compose: compose };
