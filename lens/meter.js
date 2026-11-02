/* ============================================================
   FieldKit lens :: meter — what the rented server has sent this month

   Lens runs on a small rented server so pages do not cross the home
   connection. Such servers bill by what they SEND (egress), and the
   owner set a ceiling of about $10 a month. The provider's own alarm
   arrives after the money is spent, so the ceiling is kept here, on
   bytes counted as they leave: when the month's allowance is used,
   new connections are refused and BROWSER falls back to the streamed
   browser (the relay tells everyone, and the notice clears itself
   when lens is back).

   Counted: every byte lens writes, to the person and to the internet.
   The second is small (requests), but it is egress too.

   One person may also have a share per day, so one long game cannot
   use up everybody's month by the 10th.

   The month total is kept on disk (jsonfile: survives a power cut),
   written at most once a minute and on close. Losing up to a minute
   of counting on a crash is accepted; the ceiling is set below the
   real limit for that reason.
   ============================================================ */
"use strict";

const jsonfile = require("../relay/jsonfile");

const SAVE_MS = 60 * 1000;
const NEAR = 0.8;

function monthOf(t) { return new Date(t).toISOString().slice(0, 7); }
function dayOf(t) { return new Date(t).toISOString().slice(0, 10); }

class Meter {
  /* opts: file, capBytes (per month; 0 = no ceiling), personDayBytes
     (0 = none), onState(state, view) where state is "ok" | "near" |
     "over", log, now (tests). */
  constructor(opts) {
    opts = opts || {};
    this.file = opts.file || null;
    this.capBytes = Math.max(0, Number(opts.capBytes) || 0);
    this.personDayBytes = Math.max(0, Number(opts.personDayBytes) || 0);
    this.onState = opts.onState || (() => {});
    this.log = opts.log || (() => {});
    this.now = opts.now || Date.now;

    const kept = this.file ? jsonfile.readSoft(this.file, null,
      () => this.log("WARN", "lens meter: the month's count was damaged; starting from the .bak or zero")) : null;
    const month = monthOf(this.now());
    this.month = month;
    this.used = kept && kept.month === month ? Math.max(0, Number(kept.used) || 0) : 0;
    this.day = dayOf(this.now());
    this.people = new Map();
    this.state = this._stateNow();
    this.dirty = false;
    this.timer = null;
    if (this.file) {
      this.timer = setInterval(() => this.save(), SAVE_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  _roll() {
    const t = this.now();
    const m = monthOf(t);
    if (m !== this.month) {
      this.log("INFO", "lens meter: " + this.month + " closed at " + this.used + " bytes");
      this.month = m;
      this.used = 0;
      this.dirty = true;
    }
    const d = dayOf(t);
    if (d !== this.day) { this.day = d; this.people.clear(); }
  }

  _stateNow() {
    if (!this.capBytes) return "ok";
    if (this.used >= this.capBytes) return "over";
    return this.used >= this.capBytes * NEAR ? "near" : "ok";
  }

  _check() {
    const s = this._stateNow();
    if (s === this.state) return;
    this.state = s;
    this.log(s === "ok" ? "INFO" : "WARN", "lens meter: " + s + " (" + this.used + " of " + this.capBytes + " bytes)");
    try { this.onState(s, this.view()); } catch (e) {}
  }

  /* n bytes sent on behalf of who. */
  add(who, n) {
    n = Number(n) || 0;
    if (n <= 0) return;
    this._roll();
    this.used += n;
    this.dirty = true;
    if (who) this.people.set(who, (this.people.get(who) || 0) + n);
    this._check();
  }

  /* What the provider itself counted this month (server.js asks
     Linode). It counts everything the machine sent, TLS and updates
     included, so when it is ahead of this count it is the truth: the
     count catches up, and is never pulled back. */
  seen(bytes) {
    bytes = Number(bytes) || 0;
    this._roll();
    if (bytes <= this.used) return false;
    this.log("INFO", "lens meter: the provider counts " + bytes + " bytes, " + (bytes - this.used) + " more than here; using theirs");
    this.used = bytes;
    this.dirty = true;
    this._check();
    return true;
  }

  /* May who open another connection? {ok} or {ok:false, why}. */
  allowed(who) {
    this._roll();
    this._check();
    if (this.capBytes && this.used >= this.capBytes) {
      return { ok: false, why: "this month's allowance for the lighter browser is used up" };
    }
    if (who && this.personDayBytes && (this.people.get(who) || 0) >= this.personDayBytes) {
      return { ok: false, why: "your share of the lighter browser for today is used up" };
    }
    return { ok: true };
  }

  view() {
    return {
      month: this.month,
      used: this.used,
      cap: this.capBytes,
      fraction: this.capBytes ? Math.min(1, this.used / this.capBytes) : 0,
      state: this.state,
      people: this.people.size
    };
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      jsonfile.write(this.file, { month: this.month, used: this.used, at: new Date(this.now()).toISOString() });
      this.dirty = false;
    } catch (e) { this.log("WARN", "lens meter: could not save the count: " + e.message); }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.save();
  }
}

module.exports = { Meter, monthOf, dayOf };
