/* ============================================================
   FieldKit relay :: messaging
   Accounts, conversations, and end-to-end encrypted messages.
   FIELDKIT_PROJECT.md §14.2.

   ---- WHAT THE SERVER KNOWS ----------------------------------

   It knows who exists, who is in which conversation, when
   messages were sent, and how big they were. It does not know
   what any of them say, and it cannot: message bodies arrive
   sealed and leave sealed.

   It never sees a password either. The client derives an auth
   secret from the password (PBKDF2, same shape as the vault's
   §9C) and sends only that; the server stores scrypt() of it. The
   account's private key is wrapped under a *different* derivation
   from the same password, so what the server holds for
   authentication cannot unwrap anything.

   ---- REPORTING, AND WHY IT IS NOT A BACKDOOR ----------------

   Moderators cannot read conversations. What makes reporting
   work is that the reporter is already a participant and so
   already holds the conversation key — reporting wraps that key
   to the moderators' public keys and uploads it. The server never
   gains the ability to read anything; it stores one more sealed
   blob that specific moderators can open.

   Four consequences, all of which the client states before the
   report is sent:
     1. It exposes the WHOLE conversation, the reporter's messages
        included.
     2. Resolving deletes the escrow, which ends further access.
        It does not unread what was already read.
     3. So the conversation key is rotated on resolution. Without
        that, a moderator who kept a copy reads everything sent
        afterwards, and "access revoked" would be a lie.
     4. A user can only ever expose a conversation they are in.
        That falls out of the crypto, not out of a rule here.
   ============================================================ */
"use strict";

const fs = require("fs");
const jf = require("./jsonfile");
const path = require("path");
const crypto = require("crypto");

/* ---- limits --------------------------------------------------
   Chosen so one account cannot fill the disk or the user list.
   None of these is a security boundary; they are damage caps. */
const LIMITS = {
  handle: /^[a-z0-9][a-z0-9_.-]{2,23}$/,   // 3-24 chars, lowercase
  displayName: 40,
  maxUsers: 500,
  maxMembers: 50,
  maxCiphertext: 64 * 1024,      // ~48 KB of plaintext after base64
  maxLogBytes: 32 * 1024 * 1024, // per conversation, then it rotates
  sessionMs: 12 * 60 * 60 * 1000,
  pollMs: 25000,                 // under every proxy idle timeout worth worrying about
  reasonChars: 500
};

let DIR = null, USERS = null, ROLES = null, CONV_DIR = null, REPORT_DIR = null;
let cfg = { enabled: false, moderators: [], openRegistration: true, requireApproval: true };
let log = () => {};

/* Sessions are in memory. A restart logs everyone out, which is
   the correct trade: persisting them would mean a stolen token
   survives the one action that reliably clears it. */
const sessions = new Map();       // token -> { handle, expires }
const waiters = [];               // long-poll parkers

function init(opts) {
  DIR = path.join(opts.dataDir, "msg");
  USERS = path.join(DIR, "users.json");
  ROLES = path.join(DIR, "roles.json");
  CONV_DIR = path.join(DIR, "conv");
  REPORT_DIR = path.join(DIR, "reports");
  cfg = Object.assign({ enabled: false, moderators: [], openRegistration: true, requireApproval: true },
    opts.config || {});
  cfg.moderators = (cfg.moderators || []).map((h) => String(h).toLowerCase());
  log = opts.log || log;

  if (!cfg.enabled) return { enabled: false };

  [DIR, CONV_DIR, REPORT_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  if (!fs.existsSync(USERS)) writeJson(USERS, { version: 1, users: {} });

  /* A damaged account list must not stop the relay: everything but
     MESSAGES keeps working, and MESSAGES refuses changes until fixed. */
  let users;
  try { users = readUsers(); }
  catch (e) {
    if (!e.damaged) throw e;
    log("ERROR", "messaging: the account list is DAMAGED (and so is its .bak); sign-ins and new accounts fail until " + USERS + " is restored");
    return { enabled: true, users: 0, moderators: cfg.moderators.length, damaged: true };
  }
  const n = Object.keys(users).length;
  const made = adminList(users).length - cfg.moderators.length;
  log("INFO", `messaging: ${n} account(s), ${cfg.moderators.length} admin(s) from config.json` +
    (made > 0 ? `, ${made} made in the app` : "") +
    (cfg.requireApproval ? ", new accounts are guests until approved" : "") +
    (cfg.openRegistration ? "" : ", registration CLOSED"));
  if (!cfg.moderators.length) {
    log("WARN", "messaging: no moderators configured — reports can be filed but nobody can open them");
  }

  /* A moderator who has not registered yet is the failure people
     actually hit, and it fails at the worst moment: filing a report
     seals the conversation key to every configured moderator, so one
     name with no public key means nobody can report anything. Said
     at boot, when it is a two-minute fix, rather than discovered by
     someone trying to report harassment.

     Not fatal, because the intended order is "start the relay, make
     the account, restart" — but it must be loud while it lasts. */
  const unregistered = cfg.moderators.filter((h) => !users[h]);
  if (unregistered.length) {
    log("WARN", `messaging: moderator(s) with no account yet: ${unregistered.join(", ")}. ` +
      "Reports CANNOT be filed until they register — the report is sealed to every " +
      "moderator's public key and they do not have one. Handles are case-insensitive here " +
      "but must match exactly otherwise.");
  }
  return { enabled: true, users: n, moderators: cfg.moderators.length };
}

/* ---- storage -------------------------------------------------- */
/* jsonfile.js: survives a power cut. readJson is for looking (a damaged
   file reads as missing, loudly); readStrict is for anything about to
   be written back, and throws rather than let a damaged file be saved
   over: one damaged users.json used to become a one-account list. */
function readJson(f) {
  return jf.readSoft(f, null, (e) => log("ERROR", "messaging: " + e.message));
}
function readStrict(f) {
  try { return jf.read(f, null); }
  catch (e) { if (e.damaged) log("ERROR", "messaging: " + e.message); throw e; }
}
function writeJson(f, obj) { jf.write(f, obj); }
function readUsers() { return (readStrict(USERS) || { users: {} }).users || {}; }
function writeUsers(users) { writeJson(USERS, { version: 1, users: users }); }

/* Conversation ids are server-minted and opaque. Never derived from
   the member list — that would leak who talks to whom to anyone who
   can guess a handle. */
function newId() { return crypto.randomBytes(16).toString("hex"); }
const ID_RE = /^[a-f0-9]{32}$/;
const validId = (s) => typeof s === "string" && ID_RE.test(s);

function convMeta(id) { return validId(id) ? readJson(path.join(CONV_DIR, id + ".json")) : null; }
function writeConvMeta(c) { writeJson(path.join(CONV_DIR, c.id + ".json"), c); }
function convLog(id) { return path.join(CONV_DIR, id + ".log"); }

/* ---- passwords -----------------------------------------------
   scrypt over the client's auth secret. The client already spent
   600k PBKDF2 iterations deriving that secret from the password,
   so this layer exists to make the stored value useless if the
   disk is read, not to do the heavy stretching again. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSecret(secret, salt) {
  return crypto.scryptSync(String(secret), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p
  }).toString("hex");
}

function secretMatches(secret, user) {
  const got = Buffer.from(hashSecret(secret, Buffer.from(user.pwSalt, "hex")), "hex");
  const want = Buffer.from(user.pwHash, "hex");
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

/* ---- bans ----------------------------------------------------
   Checked at login AND on every authenticated request, so a ban
   lands on a session that is already open rather than waiting for
   the aggressor to log out. */
function banState(user) {
  if (!user || !user.banned) return null;
  const b = user.banned;
  if (b.until && Date.now() > b.until) return null;   // expired
  return b;
}

function banMessage(b) {
  return b.until
    ? "suspended until " + new Date(b.until).toISOString() + (b.reason ? " — " + b.reason : "")
    : "permanently banned" + (b.reason ? " — " + b.reason : "");
}

/* ---- failed sign-ins ------------------------------------------
   Logged and surfaced to moderators, because a burst of them is the
   only signal available that someone is trying to get into an
   account that is not theirs — and the person being targeted has no
   way to see it themselves.

   What is recorded is deliberately thin: the handle attempted, when,
   and a HASH of the caller's address rather than the address. The
   count and the pattern are what a moderator needs; a list of the IP
   addresses of everyone who ever fat-fingered a password is a
   liability sitting on disk. Never the secret that was tried — a
   near-miss password is still a password. */
const FAIL_KEEP = 500;

function failPath() { return path.join(DIR, "signin-failures.json"); }

function ipTag(ip) {
  return crypto.createHash("sha256").update("fk-msg-ip:" + String(ip)).digest("hex").slice(0, 12);
}

function noteFailure(handle, ip, reason) {
  let f = readJson(failPath()) || { version: 1, failures: [] };
  f.failures.push({
    at: new Date().toISOString(),
    handle: String(handle || "").slice(0, 40),
    exists: reason !== "no-such-account",
    from: ipTag(ip),
    reason: reason
  });
  /* A ring, not a log. An attacker who can generate failures could
     otherwise fill the disk by failing. */
  if (f.failures.length > FAIL_KEEP) f.failures = f.failures.slice(-FAIL_KEEP);
  writeJson(failPath(), f);

  const recent = f.failures.filter((x) => Date.now() - Date.parse(x.at) < 3600000).length;
  log("WARN", `messaging: failed sign-in for '${handle}' from ${ipTag(ip)}` +
    (recent > 10 ? ` — ${recent} failures in the last hour` : ""));
}

function failureSummary() {
  const f = readJson(failPath()) || { failures: [] };
  const now = Date.now();
  const byHandle = {};
  f.failures.forEach((x) => {
    const k = x.handle || "(blank)";
    byHandle[k] = byHandle[k] || { handle: k, exists: x.exists, total: 0, lastDay: 0,
      lastHour: 0, from: {}, last: null };
    const b = byHandle[k];
    b.total++;
    const age = now - Date.parse(x.at);
    if (age < 86400000) b.lastDay++;
    if (age < 3600000) b.lastHour++;
    b.from[x.from] = (b.from[x.from] || 0) + 1;
    if (!b.last || x.at > b.last) b.last = x.at;
  });
  return Object.keys(byHandle).map((k) => {
    const b = byHandle[k];
    return { handle: b.handle, exists: b.exists, total: b.total, lastDay: b.lastDay,
      lastHour: b.lastHour, sources: Object.keys(b.from).length, last: b.last };
  }).sort((a, b) => b.lastDay - a.lastDay || b.total - a.total);
}

/* ---- tiers and admins (RUNNER_PLAN.md §4a, §8a) ----------------
   Three tiers. A GUEST is an account nobody has vouched for yet; a
   MEMBER is one an admin approved; an ADMIN is a moderator, and that
   is the same thing as before under a name that covers more.

   There are two kinds of admin and the difference is the point.

   A ROOT admin is named in config.json. That is the bootstrap — there
   has to be a first one, and the only place to say who is the file.
   Nothing in the app can remove a root, so a compromised admin
   account cannot lock the owner out of their own relay.

   Every other admin is made HERE, by an existing admin, and is
   recorded in roles.json. That is what was asked for: after the
   first one, nobody should need the panel to add a colleague.

   Making an admin is something any admin can do. UNMAKING one is
   root only. The asymmetry is deliberate — otherwise the newest
   admin could demote everyone who came before them. */
const AUDIT_KEEP = 500;

function readRoles() {
  const r = readStrict(ROLES) || {};
  return { version: 1, admins: r.admins || {}, audit: Array.isArray(r.audit) ? r.audit : [] };
}

function isRoot(handle) { return cfg.moderators.indexOf(handle) >= 0; }

/* Roots first, in the order the file gives them, then the ones made
   in the app. An in-app admin whose account has since vanished is
   left out: a report is sealed to every name on this list, and a
   name with no public key would stop every report being filed. */
function adminList(users, roles) {
  users = users || readUsers();
  roles = roles || readRoles();
  const out = cfg.moderators.slice();
  Object.keys(roles.admins).sort().forEach((h) => {
    if (users[h] && out.indexOf(h) < 0) out.push(h);
  });
  return out;
}

function isAdmin(handle, users, roles) { return adminList(users, roles).indexOf(handle) >= 0; }

function tierOf(handle, user, roles) {
  if (isRoot(handle) || (user && (roles || readRoles()).admins[handle])) return "admin";
  if (!cfg.requireApproval) return "member";
  return user && user.approved ? "member" : "guest";
}

function audit(roles, by, action, target) {
  roles.audit.push({ at: new Date().toISOString(), by: by, action: action, target: target });
  /* A ring, for the same reason the sign-in failures are one. */
  if (roles.audit.length > AUDIT_KEEP) roles.audit = roles.audit.slice(-AUDIT_KEEP);
}

/* A demoted admin must stop being able to open reports that were
   sealed to them while they were one. Their copy of each escrowed
   key is deleted; everyone else's is untouched. */
function stripEscrow(handle) {
  let names = [];
  try { names = fs.readdirSync(REPORT_DIR); } catch (e) { return 0; }
  let n = 0;
  names.forEach((f) => {
    if (!f.endsWith(".json")) return;
    const p = path.join(REPORT_DIR, f);
    let r;
    try { r = readStrict(p); } catch (e) { return; }
    if (!r || !r.escrow || !r.escrow[handle]) return;
    delete r.escrow[handle];
    writeJson(p, r);
    n++;
  });
  return n;
}

/* ---- sessions ------------------------------------------------- */
function issueToken(handle) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { handle: handle, expires: Date.now() + LIMITS.sessionMs });
  return token;
}

function whoami(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const s = sessions.get(h.slice(7));
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(h.slice(7)); return null; }

  const user = readUsers()[s.handle];
  if (!user) { sessions.delete(h.slice(7)); return null; }

  /* Deliberately NOT deleted here. Dropping the session would turn
     every subsequent request into a bare "log in first", so a
     banned user would see themselves silently logged out and have
     no idea why. Leaving it means every request answers 403 with
     the reason and the end date. The ban is enforced either way —
     the user record is re-read on every single request, so this
     cannot go stale. */
  const b = banState(user);
  if (b) return { banned: b };

  const tier = tierOf(s.handle, user);
  return { handle: s.handle, user: user, moderator: tier === "admin",
    root: isRoot(s.handle), tier: tier };
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expires) sessions.delete(t);
}, 300000).unref();

/* ---- long poll -----------------------------------------------
   One shared cursor across the whole server, incremented on every
   append. A client polls with the highest cursor it has seen and
   is woken when anything it can read moves past it.

   Long poll rather than WebSocket on purpose: it is an ordinary
   GET on 443 through the same tunnel as everything else, and
   §14's whole constraint is that nothing new opens a port or a
   hostname that a filter has not already seen. */
let cursor = 0;

function wake() {
  const now = waiters.splice(0, waiters.length);
  now.forEach((w) => { clearTimeout(w.timer); w.fire(); });
}

/* ---- messages ------------------------------------------------- */
function appendMessage(convId, entry) {
  const line = JSON.stringify(entry) + "\n";
  const p = convLog(convId);

  /* Rotate rather than refuse. A conversation that hits the cap is
     a conversation people are using; cutting it off would be the
     wrong failure. Older messages stay on disk under .1, and
     clients that already have them are unaffected — the cursor is
     monotonic across the rotation. */
  try {
    if (fs.existsSync(p) && fs.statSync(p).size + line.length > LIMITS.maxLogBytes) {
      fs.renameSync(p, p + "." + Date.now());
      log("INFO", `messaging: rotated the log for conversation ${convId.slice(0, 8)}`);
    }
  } catch (e) { /* a failed rotate must not lose the message */ }

  fs.appendFileSync(p, line, "utf8");
}

function readMessages(convId, since) {
  let raw;
  try { raw = fs.readFileSync(convLog(convId), "utf8"); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch (e) { continue; }   // a torn line costs one message
    if (m.seq > since) out.push(m);
  }
  return out;
}

function myConversations(handle) {
  let names;
  try { names = fs.readdirSync(CONV_DIR); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const c = readJson(path.join(CONV_DIR, n));
    if (c && c.members && c.members.indexOf(handle) >= 0) out.push(c);
  }
  return out;
}

/* ---- routes ---------------------------------------------------
   Returns true if it handled the request. server.js keeps CORS,
   rate limiting and body reading; everything past that is here. */
async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "msg") return false;

  const { send, readBody } = helpers;
  const method = req.method;
  const what = seg[1] || "";

  /* Answered before the auth check, on purpose. The main relay's
     404 is deliberately self-diagnosing and public, and the same
     reasoning applies here: these route names are already listed in
     the public ROUTES array, so demanding a token to learn them
     protects nothing and turns "you typed the path wrong" into
     "log in first" — which sends you looking in the wrong place. */
  const ROUTES_BY_NAME = {
    register: ["POST"], login: ["POST"], logout: ["POST"], users: ["GET"],
    conv: ["GET", "POST"], send: ["POST"], poll: ["GET"], rotate: ["POST"],
    report: ["POST"], reports: ["GET"], review: ["GET"], resolve: ["POST"],
    signins: ["GET"], people: ["GET"], role: ["POST"]
  };
  const ROUTE_NAMES = Object.keys(ROUTES_BY_NAME);

  if (!cfg.enabled) {
    send(res, 503, { error: "messaging is not enabled on this relay",
      detail: "set messaging.enabled in config.json and restart" });
    return true;
  }

  if (ROUTE_NAMES.indexOf(what) < 0) {
    send(res, 404, { error: "no such messaging route",
      saw: { method: method, path: url.pathname },
      routes: ROUTE_NAMES.map((n) => "/msg/" + n) });
    return true;
  }

  /* Answered here, before auth, for the same reason as the 404
     above: a real route called the wrong way is a different problem
     from one that does not exist, and answering 401 for it sends
     you looking for a login bug that is not there. */
  if (ROUTES_BY_NAME[what].indexOf(method) < 0) {
    send(res, 405, { error: method + " is not how you call /msg/" + what,
      saw: { method: method, path: url.pathname },
      allowed: ROUTES_BY_NAME[what] }, { Allow: ROUTES_BY_NAME[what].join(", ") });
    return true;
  }

  /* ---- register ---- */
  if (what === "register" && method === "POST") {
    if (!cfg.openRegistration) {
      return send(res, 403, { error: "registration is closed on this relay" }), true;
    }
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;

    const handle = String(body.handle || "").toLowerCase().trim();
    if (!LIMITS.handle.test(handle)) {
      return send(res, 400, { error: "bad handle",
        detail: "3-24 characters, lowercase letters, digits, and . _ - only" }), true;
    }
    for (const f of ["authSecret", "pubKey", "wrappedPrivKey"]) {
      if (!body[f] || typeof body[f] !== "string") {
        return send(res, 400, { error: "missing " + f }), true;
      }
    }

    const users = readUsers();
    if (users[handle]) return send(res, 409, { error: "that handle is taken" }), true;
    if (Object.keys(users).length >= LIMITS.maxUsers) {
      return send(res, 507, { error: "this relay is full", detail: "max " + LIMITS.maxUsers }), true;
    }

    const salt = crypto.randomBytes(16);
    users[handle] = {
      handle: handle,
      displayName: String(body.displayName || handle).slice(0, LIMITS.displayName),
      createdAt: new Date().toISOString(),
      pwSalt: salt.toString("hex"),
      pwHash: hashSecret(body.authSecret, salt),
      pubKey: body.pubKey,
      wrappedPrivKey: body.wrappedPrivKey,
      approved: null,
      banned: null
    };
    writeUsers(users);
    log("INFO", `messaging: new account ${handle}`);
    return send(res, 201, { handle: handle, token: issueToken(handle),
      moderator: isRoot(handle), root: isRoot(handle),
      tier: tierOf(handle, users[handle]) }), true;
  }

  /* ---- login ---- */
  if (what === "login" && method === "POST") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;
    const handle = String(body.handle || "").toLowerCase().trim();
    const users = readUsers();
    const user = users[handle];

    /* Same answer for "no such account" and "wrong secret", and the
       same amount of work either way, so this is not a way to
       enumerate who has an account here. */
    const ok = user && body.authSecret && secretMatches(body.authSecret, user);
    if (!ok) {
      if (!user) hashSecret(String(body.authSecret || ""), crypto.randomBytes(16));
      noteFailure(handle, helpers.clientIp ? helpers.clientIp(req) : "unknown",
        user ? "wrong-secret" : "no-such-account");
      return send(res, 401, { error: "handle or password is wrong" }), true;
    }

    const b = banState(user);
    if (b) return send(res, 403, { error: "account " + banMessage(b), banned: b }), true;

    return send(res, 200, {
      handle: handle,
      token: issueToken(handle),
      displayName: user.displayName,
      pubKey: user.pubKey,
      wrappedPrivKey: user.wrappedPrivKey,
      moderator: isAdmin(handle, users), root: isRoot(handle),
      tier: tierOf(handle, user)
    }), true;
  }

  /* Everything past here needs a session. */
  const me = whoami(req);
  if (!me) return send(res, 401, { error: "log in first" }), true;
  if (me.banned) {
    return send(res, 403, { error: "account " + banMessage(me.banned), banned: me.banned }), true;
  }

  if (what === "logout" && method === "POST") {
    sessions.delete((req.headers.authorization || "").slice(7));
    return send(res, 200, { ok: true }), true;
  }

  /* ---- the directory ----
     Public keys are public by definition — you need someone's to
     start a conversation with them. Nothing else about an account
     is exposed, and a banned account stays listed so an existing
     conversation still renders their name. */
  if (what === "users" && method === "GET") {
    const users = readUsers();
    /* Who the moderators are is published on purpose. A report seals
       the conversation key to every one of them, so the client has to
       know the list to build the escrow at all — and someone deciding
       whether to file a report deserves to know who will be reading
       it. Keeping it secret would buy nothing and cost that. */
    const mods = adminList(users);
    const list = Object.keys(users).sort().map((h) => ({
      handle: h,
      displayName: users[h].displayName,
      pubKey: users[h].pubKey,
      moderator: mods.indexOf(h) >= 0,
      banned: !!banState(users[h])
    }));
    return send(res, 200, { users: list, me: me.handle, moderator: me.moderator,
      root: me.root, tier: me.tier, moderators: mods }), true;
  }

  /* ---- conversations ---- */
  if (what === "conv" && method === "GET") {
    const mine = myConversations(me.handle).map((c) => ({
      id: c.id, kind: c.kind, name: c.name || null,
      members: c.members, createdAt: c.createdAt, createdBy: c.createdBy,
      keyEpoch: c.keyEpoch || 1,
      myKey: (c.keys || {})[me.handle] || null
    }));
    return send(res, 200, { conversations: mine }), true;
  }

  if (what === "conv" && method === "POST") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;

    const kind = body.kind === "group" ? "group" : "dm";
    const members = Array.from(new Set(
      (Array.isArray(body.members) ? body.members : []).map((h) => String(h).toLowerCase())
    ));
    if (members.indexOf(me.handle) < 0) members.push(me.handle);

    if (members.length < 2) return send(res, 400, { error: "a conversation needs someone else in it" }), true;
    if (members.length > LIMITS.maxMembers) {
      return send(res, 400, { error: "too many members", detail: "max " + LIMITS.maxMembers }), true;
    }
    if (kind === "dm" && members.length !== 2) {
      return send(res, 400, { error: "a DM has exactly two people in it" }), true;
    }

    const users = readUsers();
    const unknown = members.filter((h) => !users[h]);
    if (unknown.length) return send(res, 404, { error: "no such handle: " + unknown.join(", ") }), true;

    /* The conversation key is wrapped client-side, once per member,
       so the server is handed a map it cannot read. A member with
       no key would silently never be able to read anything. */
    const keys = body.keys || {};
    const keyless = members.filter((h) => !keys[h]);
    if (keyless.length) {
      return send(res, 400, { error: "no wrapped key for: " + keyless.join(", "),
        detail: "every member needs the conversation key wrapped to their public key" }), true;
    }

    const c = {
      id: newId(), kind: kind,
      name: kind === "group" ? String(body.name || "").slice(0, 60) : null,
      members: members.sort(), keys: keys, keyEpoch: 1,
      createdAt: new Date().toISOString(), createdBy: me.handle
    };
    writeConvMeta(c);
    cursor++;
    wake();
    return send(res, 201, { id: c.id, keyEpoch: 1 }), true;
  }

  /* ---- send ---- */
  if (what === "send" && method === "POST") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;

    const c = convMeta(body.convId);
    if (!c) return send(res, 404, { error: "no such conversation" }), true;
    if (c.members.indexOf(me.handle) < 0) {
      /* Same answer as a missing conversation, so ids cannot be
         probed for existence. */
      return send(res, 404, { error: "no such conversation" }), true;
    }
    if (typeof body.ct !== "string" || !body.ct) {
      return send(res, 400, { error: "ct (the sealed message) is required" }), true;
    }
    if (body.ct.length > LIMITS.maxCiphertext) {
      return send(res, 413, { error: "message too large",
        detail: "max " + LIMITS.maxCiphertext + " bytes of ciphertext" }), true;
    }

    const entry = {
      id: newId(), seq: ++cursor, conv: c.id, from: me.handle,
      at: new Date().toISOString(), epoch: c.keyEpoch || 1, ct: body.ct
    };
    appendMessage(c.id, entry);
    wake();
    return send(res, 201, { id: entry.id, seq: entry.seq, at: entry.at }), true;
  }

  /* ---- poll ----
     Returns immediately if anything is already newer than `since`;
     otherwise parks until something arrives or the timeout expires.
     An empty answer is normal and not an error. */
  if (what === "poll" && method === "GET") {
    const since = Number(url.searchParams.get("since") || 0) || 0;

    const collect = () => {
      const convs = myConversations(me.handle);
      let msgs = [];
      convs.forEach((c) => { msgs = msgs.concat(readMessages(c.id, since)); });
      msgs.sort((a, b) => a.seq - b.seq);
      return { cursor: cursor, messages: msgs, conversations: convs.length };
    };

    const first = collect();
    if (first.messages.length || since >= cursor) {
      if (first.messages.length) return send(res, 200, first), true;
    }

    await new Promise((resolve) => {
      const w = {
        fire: () => { if (!w.done) { w.done = true; resolve(); } },
        timer: setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          w.fire();
        }, LIMITS.pollMs)
      };
      waiters.push(w);
      req.on("close", () => { clearTimeout(w.timer); w.fire(); });
    });

    if (res.writableEnded) return true;
    return send(res, 200, collect()), true;
  }

  /* ---- rotate the conversation key ----
     Used after a report resolves, and available any time a member
     wants a clean break. Bumping the epoch means messages sent
     from now on are sealed under a key the old escrow cannot open. */
  if (what === "rotate" && method === "POST") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;
    const c = convMeta(body.convId);
    if (!c || c.members.indexOf(me.handle) < 0) {
      return send(res, 404, { error: "no such conversation" }), true;
    }
    const keys = body.keys || {};
    const keyless = c.members.filter((h) => !keys[h]);
    if (keyless.length) {
      return send(res, 400, { error: "no wrapped key for: " + keyless.join(", ") }), true;
    }
    c.keys = keys;
    c.keyEpoch = (c.keyEpoch || 1) + 1;
    c.rotatedAt = new Date().toISOString();
    c.rotatedBy = me.handle;
    writeConvMeta(c);
    cursor++;
    wake();
    log("INFO", `messaging: ${me.handle} rotated the key for ${c.id.slice(0, 8)} (epoch ${c.keyEpoch})`);
    return send(res, 200, { keyEpoch: c.keyEpoch }), true;
  }

  /* ---- report ---- */
  if (what === "report" && method === "POST") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;

    const c = convMeta(body.convId);
    if (!c || c.members.indexOf(me.handle) < 0) {
      return send(res, 404, { error: "no such conversation" }), true;
    }
    const mods = adminList();
    if (!mods.length) {
      return send(res, 503, { error: "this relay has no moderators configured",
        detail: "nobody could open the report, so filing it would achieve nothing" }), true;
    }

    /* The escrow is the whole mechanism. Without a key wrapped to
       each moderator, a report is an accusation nobody can check. */
    const escrow = body.escrow || {};
    const missing = mods.filter((h) => !escrow[h]);
    if (missing.length) {
      return send(res, 400, { error: "no escrow key for moderator: " + missing.join(", "),
        detail: "the conversation key must be wrapped to every moderator's public key" }), true;
    }

    const report = {
      id: newId(), convId: c.id, kind: c.kind,
      by: me.handle, against: String(body.against || "").toLowerCase() || null,
      members: c.members,
      reason: String(body.reason || "").slice(0, LIMITS.reasonChars),
      at: new Date().toISOString(),
      epoch: c.keyEpoch || 1,
      escrow: escrow,
      status: "open", resolution: null
    };
    writeJson(path.join(REPORT_DIR, report.id + ".json"), report);
    log("WARN", `messaging: ${me.handle} reported conversation ${c.id.slice(0, 8)}` +
      (report.against ? " against " + report.against : ""));
    return send(res, 201, { id: report.id }), true;
  }

  /* ---- moderation ---- */
  if (what === "reports" && method === "GET") {
    if (!me.moderator) return send(res, 403, { error: "moderators only" }), true;
    let names = [];
    try { names = fs.readdirSync(REPORT_DIR); } catch (e) { /* none yet */ }
    const open = [];
    names.forEach((n) => {
      if (!n.endsWith(".json")) return;
      const r = readJson(path.join(REPORT_DIR, n));
      if (!r) return;
      open.push({
        id: r.id, convId: r.convId, kind: r.kind, by: r.by, against: r.against,
        members: r.members, reason: r.reason, at: r.at, status: r.status,
        resolution: r.resolution,
        /* Only this moderator's copy of the key, not everyone's. */
        myKey: r.status === "open" ? (r.escrow || {})[me.handle] || null : null
      });
    });
    open.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return send(res, 200, { reports: open }), true;
  }

  /* The conversation as it stood, for an open report only. Sealed —
     the moderator decrypts locally with the escrowed key. */
  if (what === "review" && method === "GET") {
    if (!me.moderator) return send(res, 403, { error: "moderators only" }), true;
    const id = url.searchParams.get("report") || "";
    const r = validId(id) ? readJson(path.join(REPORT_DIR, id + ".json")) : null;
    if (!r) return send(res, 404, { error: "no such report" }), true;
    if (r.status !== "open") {
      return send(res, 410, { error: "that report is resolved",
        detail: "access to the conversation ended when it was marked" }), true;
    }
    return send(res, 200, {
      report: { id: r.id, by: r.by, against: r.against, reason: r.reason, at: r.at },
      key: (r.escrow || {})[me.handle] || null,
      messages: readMessages(r.convId, 0)
    }), true;
  }

  /* Surfaced to moderators when they next open their copy, which is
     the only time anyone is in a position to act on it. */
  if (what === "signins" && method === "GET") {
    if (!me.moderator) return send(res, 403, { error: "moderators only" }), true;
    const rows = failureSummary();
    return send(res, 200, {
      failures: rows,
      /* Named rather than left to the reader. A run of failures
         against a handle that EXISTS is someone trying to get into a
         real account; the same against handles that do not exist is
         someone guessing at who is here. Different problems. */
      alerts: rows.filter((r) => r.lastDay >= 10 || (r.exists && r.lastHour >= 5))
        .map((r) => ({
          handle: r.handle,
          why: r.exists
            ? r.lastHour + " failed sign-in(s) in the last hour against a real account"
            : r.lastDay + " attempt(s) today on a handle that does not exist",
          sources: r.sources
        }))
    }), true;
  }

  if (what === "resolve" && method === "POST") {
    if (!me.moderator) return send(res, 403, { error: "moderators only" }), true;
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;

    const id = String(body.reportId || "");
    const file = validId(id) ? path.join(REPORT_DIR, id + ".json") : null;
    const r = file ? readStrict(file) : null;
    if (!r) return send(res, 404, { error: "no such report" }), true;
    if (r.status !== "open") return send(res, 409, { error: "already resolved" }), true;

    const action = ["none", "warn", "tempban", "ban"].indexOf(body.action) >= 0 ? body.action : "none";
    let banned = null;

    if (action === "tempban" || action === "ban") {
      const target = String(body.against || r.against || "").toLowerCase();
      const users = readUsers();
      if (!users[target]) return send(res, 400, { error: "no such handle to act on: " + target }), true;
      if (isAdmin(target, users)) {
        return send(res, 403, { error: "moderators cannot be banned from here",
          detail: isRoot(target) ? "remove them from config.json and restart instead"
            : "demote them first" }), true;
      }
      const days = Math.max(1, Math.min(3650, Number(body.days) || 7));
      users[target].banned = {
        until: action === "tempban" ? Date.now() + days * 86400000 : null,
        reason: String(body.note || "").slice(0, LIMITS.reasonChars),
        by: me.handle, at: new Date().toISOString()
      };
      writeUsers(users);
      banned = { handle: target, until: users[target].banned.until };

      /* No session sweep. whoami() re-reads the user record on every
         request, so the ban is already live on any session that is
         open — and leaving the session in place is what lets the
         next request say WHY rather than just failing. */
      log("WARN", `messaging: ${me.handle} ${action}ned ${target}`);
    }

    /* Escrow is destroyed here. Prospective only, and the client is
       told to rotate — see the header. */
    r.status = "resolved";
    r.resolution = { action: action, by: me.handle, at: new Date().toISOString(),
      note: String(body.note || "").slice(0, LIMITS.reasonChars), banned: banned };
    r.escrow = {};
    writeJson(file, r);
    cursor++;
    wake();

    return send(res, 200, {
      ok: true, action: action, banned: banned,
      rotate: r.convId,
      note: "escrow destroyed. Members should rotate the conversation key — until they do, " +
            "anyone who copied it can still read new messages."
    }), true;
  }

  /* ---- people: tiers, approval, admins ----
     The list is admins-only because it says who is unapproved and
     who is banned, which the public directory deliberately does not. */
  if (what === "people" && method === "GET") {
    if (!me.moderator) return send(res, 403, { error: "admins only" }), true;
    const users = readUsers();
    const roles = readRoles();
    const people = Object.keys(users).sort().map((h) => ({
      handle: h,
      displayName: users[h].displayName,
      createdAt: users[h].createdAt,
      tier: tierOf(h, users[h], roles),
      root: isRoot(h),
      approved: users[h].approved || null,
      madeAdmin: roles.admins[h] || null,
      banned: banState(users[h])
    }));
    return send(res, 200, { people: people, me: me.handle, root: me.root,
      requireApproval: !!cfg.requireApproval, audit: roles.audit.slice(-50).reverse() }), true;
  }

  if (what === "role" && method === "POST") {
    if (!me.moderator) return send(res, 403, { error: "admins only" }), true;
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "expected a JSON body" }), true;

    const target = String(body.handle || "").toLowerCase().trim();
    const action = String(body.action || "");
    if (["approve", "unapprove", "promote", "demote"].indexOf(action) < 0) {
      return send(res, 400, { error: "no such action",
        detail: "approve, unapprove, promote or demote" }), true;
    }

    const users = readUsers();
    const roles = readRoles();
    const user = users[target];
    if (!user) return send(res, 404, { error: "no such handle: " + target }), true;

    /* Nobody edits themselves. Self-promotion is meaningless and
       self-demotion is how the last usable admin disappears. */
    if (target === me.handle) {
      return send(res, 403, { error: "you cannot change your own role",
        detail: "ask another admin" }), true;
    }
    if (isRoot(target)) {
      return send(res, 403, { error: target + " is named in config.json and cannot be changed from here",
        detail: "edit messaging.moderators in config.json and restart" }), true;
    }

    const stamp = { by: me.handle, at: new Date().toISOString() };
    const wasAdmin = !!roles.admins[target];

    if (action === "approve") {
      if (banState(user)) return send(res, 409, { error: "that account is banned" }), true;
      if (!user.approved) user.approved = stamp;
    } else if (action === "unapprove") {
      if (wasAdmin) {
        return send(res, 409, { error: target + " is an admin", detail: "demote them first" }), true;
      }
      user.approved = null;
    } else if (action === "promote") {
      if (banState(user)) return send(res, 409, { error: "that account is banned" }), true;
      if (!user.approved) user.approved = stamp;
      if (!wasAdmin) roles.admins[target] = stamp;
    } else {
      if (!me.root) {
        return send(res, 403, { error: "only an admin named in config.json can demote an admin",
          detail: "any admin can make one; taking it away is kept to the owner" }), true;
      }
      if (!wasAdmin) return send(res, 409, { error: target + " is not an admin" }), true;
      delete roles.admins[target];
      stripEscrow(target);
    }

    audit(roles, me.handle, action, target);
    writeUsers(users);
    writeJson(ROLES, roles);
    log("WARN", `messaging: ${me.handle} ${action}d ${target}`);
    cursor++;
    wake();
    return send(res, 200, { ok: true, handle: target, tier: tierOf(target, user, roles) }), true;
  }

  /* Unreachable unless ROUTES_BY_NAME lists a name and method pair
     that nothing above actually handles — which is a coding error
     here, not a caller error, so it says so rather than blaming the
     request. */
  send(res, 500, { error: "/msg/" + what + " is declared but not implemented",
    saw: { method: method, path: url.pathname } });
  return true;
}

/* whoami is exported so relay/browse.js can accept a signed-in
   messaging account as a credential. OUTPOST has no vault and so no
   vault token, and the browser has to work there — this is the
   identity those users do have. It also means a banned account
   cannot browse, which falls out of banState() rather than needing
   a second rule. */
module.exports = { init, route, whoami, LIMITS, _internals: { hashSecret, banState, sessions, tierOf, adminList, isRoot } };
