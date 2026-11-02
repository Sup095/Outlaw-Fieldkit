/* ============================================================
   FieldKit relay :: lens-link — the relay's side of the lighter browser

   Lens (lens/ in this repository) runs on a rented server, not here.
   The relay keeps three things about it:

     - whether it can be used now: it asks the lens server's
       /lens/status every 15 seconds. Down, not answering, or over the
       month's ceiling, and BROWSER uses the streamed browser instead;
     - a PASS for each person who asks (POST /browser/lens), signed
       with the same key as the browser helpers' passes but for lens
       only, naming the account so lens can keep its per-person limits;
     - the notice that BROWSER has fallen back. It is derived, like
       every notice (notices.js): it goes for everyone, including those
       who never saw it, the moment lens is usable again.

   Configured by browser.lens.url in config.json. Without it nothing
   here runs, and BROWSER is the streamed browser, as before.
   ============================================================ */
"use strict";

const { sign } = require("./overflow");

const AUD = "fieldkit-lens";
const PASS_MS = 12 * 60 * 60 * 1000;
const passOptions = { aud: AUD, life: PASS_MS };
const EVERY_MS = 15000;
const TIMEOUT_MS = 5000;

/* An https address, or http on a private network for a test. */
function parseLensUrl(u) {
  let x;
  try { x = new URL(String(u || "").trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(x.protocol) || !x.hostname || x.search || x.username) return null;
  const base = x.origin + x.pathname.replace(/\/+$/, "");
  return { base, wisp: base.replace(/^http/, "ws") + "/wisp/" };
}

class LensLink {
  /* opts: url, keys ({ privateKey, publicPem }: overflow.loadKeys), log,
     fetch, now, everyMs */
  constructor(opts) {
    opts = opts || {};
    this.where = parseLensUrl(opts.url);
    this.keys = opts.keys || null;
    this.log = opts.log || (() => {});
    this.now = opts.now || Date.now;
    this.everyMs = opts.everyMs || EVERY_MS;
    this.fetch = opts.fetch || ((u) => fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" }));
    this.status = null;          /* last answer: { up, state, fraction, open, at } or { up: false, why, at } */
    this.timer = null;
    this.said = null;
    if (opts.url && !this.where) this.log("WARN", "lens: browser.lens.url is not an http(s) address, so lens is off");
  }

  configured() { return !!(this.where && this.keys); }

  /* ADMIN CENTER sets the address (admin.js keeps it in data/lens.json),
     so turning lens on or moving it needs no config upload and no
     restart. Empty turns it off. Returns false for an address that is
     not one. */
  setUrl(u) {
    const s = String(u || "").trim();
    const where = s ? parseLensUrl(s) : null;
    if (s && !where) return false;
    this.where = where;
    this.status = null;
    this.said = null;
    this.stop();
    if (where) this.start();
    else this.log("INFO", "lens: off");
    return true;
  }

  url() { return this.where ? this.where.base : ""; }

  async poll() {
    if (!this.where) return null;
    const at = this.now();
    try {
      const r = await this.fetch(this.where.base + "/lens/status");
      if (!r.ok) throw new Error("it answered " + r.status);
      const j = await r.json();
      this.status = { up: !!j.up, state: String(j.state || "ok"), fraction: Number(j.fraction) || 0,
        open: Number(j.open) || 0, key: !!j.key, at };
    } catch (e) {
      this.status = { up: false, why: e.message || String(e), at };
    }
    const now = this.usable() ? "usable" : this.why();
    if (now !== this.said) this.log(now === "usable" ? "INFO" : "WARN", "lens: " + now);
    this.said = now;
    return this.status;
  }

  start() {
    if (!this.where || this.timer) return;
    this.poll().catch(() => {});
    this.timer = setInterval(() => this.poll().catch(() => {}), this.everyMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /* Up, under the ceiling, holding the relay's key, and heard from
     recently: a reading three polls old is no reading. */
  usable() {
    const s = this.status;
    return !!(this.configured() && s && s.up && s.key && s.state !== "over" && this.now() - s.at < this.everyMs * 3);
  }

  why() {
    const s = this.status;
    if (!this.configured()) return "not set up";
    if (!s) return "not heard from yet";
    if (!s.up) return "not answering (" + s.why + ")";
    if (s.state === "over") return "this month's allowance is used up";
    if (!s.key) return "it does not have this relay's key yet";
    if (this.now() - s.at >= this.everyMs * 3) return "not heard from for a while";
    return "usable";
  }

  /* What a person's BROWSER panel is told to use. */
  offer(who, tier) {
    if (!this.usable()) return { mode: "stream", why: this.why() };
    const pass = sign(this.keys.privateKey, { what: "lens", who: String(who), tier: String(tier || "guest") }, this.now(), passOptions);
    /* The page is opened with the pass in its fragment (#p=), never in
       its query, so it reaches no server log. The Wisp address carries
       it in the path, because libcurl.js wants one ending in "/". */
    return { mode: "lens", page: this.where.base + "/", pass: pass, wisp: this.where.wisp + encodeURIComponent(pass) + "/",
      expiresIn: PASS_MS / 1000, near: !!(this.status && this.status.state === "near") };
  }

  /* For notices.watch("lens", …): null while lens can be used, or
     while it is not set up at all (then there is nothing to fall back
     FROM, and nothing to say). */
  notice() {
    if (!this.configured() || this.usable() || !this.status) return null;
    const over = this.status.up && this.status.state === "over";
    return { level: "info", text: over
      ? "BROWSER is using its streamed mode until next month (the lighter mode's allowance is used up). Pages may be slower to move."
      : "BROWSER is using its streamed mode for now, because the lighter mode is not answering. It switches back by itself." };
  }

  /* For ADMIN CENTER. */
  view() {
    return { configured: this.configured(), usable: this.usable(), why: this.why(),
      state: this.status && this.status.state || null, fraction: this.status && this.status.fraction || 0,
      open: this.status && this.status.open || 0, at: this.status && this.status.at || 0 };
  }
}

module.exports = { LensLink, parseLensUrl, passOptions, AUD, PASS_MS };
