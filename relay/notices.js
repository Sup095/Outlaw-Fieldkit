/* ============================================================
   FieldKit relay :: notices — what everyone should be told now

   WHY THIS IS NOT A MESSAGE. "The browser is down" sent as a message
   would sit in someone's inbox long after it stopped being true, and
   clearing it would need everyone to have seen it. So a notice is not
   stored anywhere: the relay works out, from what it can see now, what
   is wrong, and GET /notices answers with exactly that. A client shows
   exactly the list it was last given. The moment the cause is gone the
   list no longer has it and it is gone, for people who saw it, people
   who did not, and people whose FieldKit was closed the whole time.

   BLIPS ARE NOT NEWS. A condition has to hold for holdMs before it is
   shown, and has to have been clear for holdMs before it goes, and once
   shown it stays at least minMs. A service that restarts in ten seconds
   says nothing; one that flaps does not make a banner flash.

   AN ANNOUNCEMENT is the one thing here that is stored: words an admin
   wrote, shown to everyone until its time is up or the admin ends it.
   /notices is public, like /browser/status, so an announcement must
   not hold anything private, and the box it is written in says so.
   ============================================================ */
"use strict";

const jf = require("./jsonfile");

const HOLD_MS = 30000;
const MIN_MS = 60000;
const TICK_MS = 10000;
const TEXT_MAX = 300;
const LEVELS = ["info", "warn", "fail"];

class Notices {
  /* opts: { file, now, holdMs, minMs, log } */
  constructor(opts) {
    opts = opts || {};
    this.file = opts.file || null;
    this.now = opts.now || Date.now;
    this.holdMs = opts.holdMs == null ? HOLD_MS : opts.holdMs;
    this.minMs = opts.minMs == null ? MIN_MS : opts.minMs;
    this.log = opts.log || (() => {});
    this.watches = new Map();     /* id -> async () => null | { level, text } */
    this.state = new Map();       /* id -> { badAt, goodAt, shownAt, level, text } */
    this.said = null;
    this.timer = null;
    if (this.file) {
      try { this.said = jf.read(this.file, null); } catch (e) { this.said = null; }
    }
  }

  /* fn says what is wrong right now, or null. */
  watch(id, fn) { this.watches.set(id, fn); }

  /* Feeding one reading, so the rules above can be tested without the
     clock and without the things being watched. */
  report(id, bad) {
    const now = this.now();
    let s = this.state.get(id);
    if (bad) {
      if (!s) { s = { badAt: now, goodAt: 0, shownAt: 0 }; this.state.set(id, s); }
      s.goodAt = 0;
      s.level = LEVELS.indexOf(bad.level) >= 0 ? bad.level : "warn";
      s.text = String(bad.text || "").slice(0, TEXT_MAX);
      if (!s.shownAt && now - s.badAt >= this.holdMs) {
        s.shownAt = now;
        this.log("INFO", "notice on: " + id + " — " + s.text);
      }
      return;
    }
    if (!s) return;
    if (!s.shownAt) { this.state.delete(id); return; }
    if (!s.goodAt) s.goodAt = now;
    if (now - s.goodAt >= this.holdMs && now - s.shownAt >= this.minMs) {
      this.state.delete(id);
      this.log("INFO", "notice off: " + id);
    }
  }

  async tick() {
    for (const [id, fn] of this.watches) {
      let bad = null;
      try { bad = await fn(); }
      catch (e) { this.log("WARN", "notice " + id + " could not be checked: " + e.message); continue; }
      this.report(id, bad);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, TICK_MS);
    if (this.timer.unref) this.timer.unref();
    this.tick().catch(() => {});
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  announcement() {
    const a = this.said;
    if (!a || !a.text) return null;
    if (a.until && this.now() >= a.until) return null;
    return a;
  }

  announce(text, level, hours, by) {
    const t = String(text || "").trim().slice(0, TEXT_MAX);
    if (!t) throw new Error("say something");
    const h = Math.max(0.1, Math.min(24 * 14, Number(hours) || 24));
    this.said = { text: t, level: LEVELS.indexOf(level) >= 0 ? level : "info", at: this.now(),
      until: this.now() + h * 3600000, by: String(by || "") };
    this._save();
    return this.said;
  }

  endAnnouncement() {
    this.said = null;
    this._save();
  }

  _save() {
    if (!this.file) return;
    try { jf.write(this.file, this.said || {}); } catch (e) { this.log("WARN", "notices: could not save: " + e.message); }
  }

  /* What GET /notices answers. `id` and `since` together name one
     occurrence, so a person who closes a banner is not shown it again
     until it is a new one. */
  list() {
    const out = [];
    const a = this.announcement();
    if (a) out.push({ id: "announce", level: a.level, text: a.text, since: a.at, announcement: true });
    for (const [id, s] of this.state) {
      if (s.shownAt) out.push({ id: id, level: s.level, text: s.text, since: s.shownAt });
    }
    return out;
  }
}

module.exports = { Notices, HOLD_MS, MIN_MS, TEXT_MAX };
