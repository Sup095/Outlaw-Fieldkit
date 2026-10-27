/* ============================================================
   FieldKit runnerd :: ticket — who the relay says you are

   runnerd has no accounts. It never sees a password, a session
   token or the user list. The relay — which does have all three —
   signs a short statement: this handle, this tier, good for one
   minute. runnerd checks the signature against the relay's PUBLIC
   key and believes exactly that much.

   That is the whole trust relationship between the two machines,
   and it only runs one way. Nothing on Bastion 2 can sign a ticket,
   so a job that escaped its sandbox could not mint itself an admin.
   Nothing on Bastion 2 can decrypt the vault either, because the
   key for that was never on either server.

   A ticket is spent on use. It rides in a URL, which is the one
   place a credential should never be allowed to stay valid.
   ============================================================ */
"use strict";

const crypto = require("crypto");

const AUDIENCE = "fieldkit-runner";
const TIERS = ["guest", "member", "admin"];
const HANDLE_RE = /^[a-z0-9._-]{3,24}$/;
const MAX_LIFE_MS = 5 * 60 * 1000;      /* a ticket claiming longer is refused */

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(privateKey, claims) {
  const body = b64u(JSON.stringify(Object.assign({ v: 1, aud: AUDIENCE,
    n: crypto.randomBytes(12).toString("hex") }, claims)));
  const sig = crypto.sign(null, Buffer.from(body), privateKey);
  return body + "." + b64u(sig);
}

/* Returns { ok: true, claims } or { ok: false, why }. Never throws:
   a ticket is attacker-controlled text and every way it can be
   wrong has to end in the same quiet refusal. */
function verify(publicKey, text, now) {
  now = now || Date.now();
  const parts = String(text || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, why: "not a ticket" };
  if (text.length > 2048) return { ok: false, why: "not a ticket" };

  let good = false;
  try {
    good = crypto.verify(null, Buffer.from(parts[0]), publicKey,
      Buffer.from(parts[1], "base64url"));
  } catch (e) { good = false; }
  if (!good) return { ok: false, why: "the signature does not match the relay's key" };

  let c;
  try { c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch (e) { return { ok: false, why: "not a ticket" }; }

  if (!c || c.v !== 1 || c.aud !== AUDIENCE) return { ok: false, why: "that ticket is for something else" };
  if (typeof c.exp !== "number" || c.exp <= now) return { ok: false, why: "that ticket has expired" };
  if (c.exp - now > MAX_LIFE_MS) return { ok: false, why: "that ticket claims to last too long" };
  if (!HANDLE_RE.test(String(c.handle || ""))) return { ok: false, why: "no handle" };
  if (TIERS.indexOf(c.tier) < 0) return { ok: false, why: "no tier" };
  if (typeof c.n !== "string" || c.n.length < 16) return { ok: false, why: "no nonce" };
  return { ok: true, claims: c };
}

/* Remembers which tickets were used, only for as long as they could
   still be replayed. */
class Spent {
  constructor() { this.seen = new Map(); }
  use(claims, now) {
    now = now || Date.now();
    for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
    if (this.seen.has(claims.n)) return false;
    this.seen.set(claims.n, claims.exp);
    return true;
  }
}

function loadPublicKey(pem) { return crypto.createPublicKey(pem); }

/* The relay's report of its own upload (RUNNER_PLAN.md §22): the two
   machines share one home line, so each needs the other's use. Signed
   with the same key as tickets but for a different audience, so a
   report can never be used as a ticket or the other way round. Only a
   number comes out of it. */
const REPORT_AUDIENCE = "fieldkit-load";
const REPORT_LIFE_MS = 60 * 1000;
function verifyReport(publicKey, text, now) {
  now = now || Date.now();
  const parts = String(text || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || text.length > 1024) return { ok: false };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(parts[0]), publicKey, Buffer.from(parts[1], "base64url")); }
  catch (e) { good = false; }
  if (!good) return { ok: false };
  let c;
  try { c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (e) { return { ok: false }; }
  if (!c || c.v !== 1 || c.aud !== REPORT_AUDIENCE) return { ok: false };
  if (typeof c.exp !== "number" || c.exp <= now || c.exp - now > REPORT_LIFE_MS) return { ok: false };
  if (typeof c.up !== "number" || !(c.up >= 0 && c.up <= 1e7)) return { ok: false };
  if (typeof c.n !== "string" || c.n.length < 16) return { ok: false };
  return { ok: true, claims: c };
}

module.exports = { sign, verify, verifyReport, Spent, loadPublicKey, AUDIENCE, REPORT_AUDIENCE, TIERS, HANDLE_RE, MAX_LIFE_MS };
