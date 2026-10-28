/* ============================================================
   FieldKit runnerd :: access — how full the machine is, who gets in,
   and the line for everyone else (RUNNER_PLAN.md §22, phase 7b)

   THE METER. Every two seconds: the whole machine's processor use
   (/proc/stat — a container sees the host's), its memory
   (/proc/meminfo), and the upload: what this server is sending to
   viewers, against the house upload an admin has said it is
   (20 Mbit/s measured on 2026-10-27).

   WHO GETS IN. Each kind of run has a cost known before it starts (a
   console program, a program with a window). It starts only if the
   machine plus that cost stays under the person's tier:

     guest    processor and memory under 60 %, upload under 50 %
     member   under 85 %, upload under 85 %
     admin    always, at once. The room above the members' line is
              kept for admins, so there is always some.

   The machine-wide counts (maxJobs, maxScreens, maxGuestJobs) still
   apply to everybody but admins.

   THE LINE. Anything that does not fit waits instead of being
   refused: members ahead of every guest, first come first served
   inside a tier, one line per kind so waiting for a window does not
   hold up a console program. When there is room for the first in
   line they are offered it and have 60 seconds to press START; the
   room is held for them meanwhile. A member who loses the connection
   keeps their place for two minutes. A guest's place goes with their
   files, the moment the connection does.

   While anyone waits, guests' runs of that kind are held to 20
   minutes and members' to 60 (with a warning two minutes before), and
   a window nobody has touched for 5 minutes is ended, so the line
   moves. Admins are never held to either.

   Everything here is plain logic over a clock and a meter, so the
   tests drive it with fake load.
   ============================================================ */
"use strict";

const fs = require("fs");
const jf = require("../relay/jsonfile");
const crypto = require("crypto");

const KINDS = ["console", "screen"];
const RANK = { admin: 0, member: 1, guest: 2 };
const LINE_MAX = 60, GUEST_LINE_MAX = 20;
const DEFAULTS = {
  guest: { load: 60, upload: 50 },
  member: { load: 85, upload: 85 },
  uploadMbps: 20,
  turnSec: 60,
  graceSec: 120,
  /* What a run costs before it starts: share of the whole machine's
     processor, and upload. A window measured at ~1.2 cores of 8 under
     gVisor, encoded on the processor, plus its video. */
  costs: { console: { cpu: 4, kbps: 0 }, screen: { cpu: 15, kbps: 1500 } },
  whenWaiting: { guestMin: 20, memberMin: 60, idleMin: 5 }
};

/* A window's video, as a share of the full bitrate: full, then two
   steps down while the house upload is busy or anyone waits (§22
   point 5). The relay does the same for its browser (fairness.js). */
const STEPS = [1, 0.67, 0.4];
const CALM_MS = 30000;
/* A console program counts as idle only when, besides no input and no
   output, it is using next to none of a processor: one that is quietly
   working is never ended for being quiet. */
const IDLE_CPU = 2;

const prio = (e) => (e.bumped ? -1 : RANK[e.tier]);
const clampNum = (v, lo, hi) => { const n = Number(v); return n >= lo && n <= hi ? n : null; };

/* ---- the meter ---- */
function readProc() {
  const out = { cpu: null, mem: null };
  try {
    const l = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    out.cpuTotal = l.reduce((a, b) => a + b, 0);
    out.cpuIdle = (l[3] || 0) + (l[4] || 0);
  } catch (e) {}
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8");
    const total = Number((/MemTotal:\s+(\d+)/.exec(m) || [])[1]);
    const avail = Number((/MemAvailable:\s+(\d+)/.exec(m) || [])[1]);
    if (total > 0 && avail >= 0) out.mem = Math.round((1 - avail / total) * 1000) / 10;
  } catch (e) {}
  return out;
}

class Access {
  constructor(opts) {
    this.settingsFile = opts.settingsFile;
    this.now = opts.now || Date.now;
    this.read = opts.read || readProc;
    this.sent = opts.sent || (() => 0);       /* bytes sent to viewers so far */
    this.other = opts.other || (() => 0);     /* the relay's upload, kbit/s: one home line */
    this.otherWaiting = opts.otherWaiting || (() => 0);   /* waiting for the relay's browser */
    this.otherAt = opts.otherAt || (() => 0); /* when the relay last reported */
    this.step = 0;                            /* index into STEPS */
    this.calmAt = 0;
    this.prev = null;
    this.meter = { cpu: 0, mem: 0, upKbps: 0, at: 0 };
    this.line = [];
    this.ran = { console: [], screen: [] };   /* how long recent runs lasted, ms */
    this.n = 0;
  }

  /* ---- settings an admin changes in ADMIN ---- */
  settings() {
    let s = {};
    try { s = jf.read(this.settingsFile, {}) || {}; } catch (e) {}
    const pick = (v, lo, hi, d) => { const n = clampNum(v, lo, hi); return n == null ? d : n; };
    const g = s.guest || {}, m = s.member || {};
    return {
      guest: { load: pick(g.load, 0, 100, DEFAULTS.guest.load), upload: pick(g.upload, 0, 100, DEFAULTS.guest.upload) },
      member: { load: pick(m.load, 0, 100, DEFAULTS.member.load), upload: pick(m.upload, 0, 100, DEFAULTS.member.upload) },
      uploadMbps: pick(s.uploadMbps, 1, 10000, DEFAULTS.uploadMbps),
      turnSec: DEFAULTS.turnSec, graceSec: DEFAULTS.graceSec,
      costs: DEFAULTS.costs, whenWaiting: DEFAULTS.whenWaiting
    };
  }

  set(change) {
    const cur = this.settings();
    const out = { guest: cur.guest, member: cur.member, uploadMbps: cur.uploadMbps };
    for (const t of ["guest", "member"]) {
      if (!change[t]) continue;
      for (const k of ["load", "upload"]) {
        if (change[t][k] == null) continue;
        const n = clampNum(change[t][k], 0, 100);
        if (n == null) throw new Error("a threshold is a percentage, 0 to 100");
        out[t] = Object.assign({}, out[t], { [k]: Math.round(n) });
      }
    }
    if (out.guest.load > out.member.load || out.guest.upload > out.member.upload) {
      throw new Error("guests cannot be let in later than members");
    }
    if (change.uploadMbps != null) {
      const n = clampNum(change.uploadMbps, 1, 10000);
      if (n == null) throw new Error("the upload is in Mbit/s, 1 to 10000");
      out.uploadMbps = Math.round(n * 10) / 10;
    }
    jf.write(this.settingsFile, out);
    return this.settings();
  }

  /* ---- the meter ---- */
  sample() {
    const r = this.read() || {};
    const now = this.now(), sent = this.sent();
    const p = this.prev;
    if (p && r.cpuTotal != null && p.cpuTotal != null && r.cpuTotal > p.cpuTotal) {
      const busy = (r.cpuTotal - p.cpuTotal) - (r.cpuIdle - p.cpuIdle);
      this.meter.cpu = Math.max(0, Math.min(100, Math.round(busy / (r.cpuTotal - p.cpuTotal) * 1000) / 10));
    }
    if (r.mem != null) this.meter.mem = r.mem;
    if (p && now > p.at) this.meter.upKbps = Math.max(0, Math.round((sent - p.sent) * 8 / (now - p.at)));
    this.meter.at = now;
    this.prev = { cpuTotal: r.cpuTotal, cpuIdle: r.cpuIdle, sent: sent, at: now };
    return this.meter;
  }

  /* The bitrate a window should have now, from `full`. Down at once
     when the upload passes the guests' line or anyone waits on either
     machine, again past the members' line; back up one step at a time
     after 30 s of calm, and only if the step up would itself stay
     under the line (each change is a fresh encoder and a keyframe). */
  videoKbps(full) {
    const s = this.settings(), now = this.now(), pct = this.upPct(0);
    const waiting = this.line.length > 0 || this.otherWaiting() > 0;
    const want = pct >= s.member.upload ? 2 : (pct >= s.guest.upload || waiting) ? 1 : 0;
    if (want >= this.step) {
      this.step = want;
      this.calmAt = now;
    } else if (now - this.calmAt >= CALM_MS) {
      const up = this.step - 1;
      const mine = this.meter.upKbps * STEPS[up] / STEPS[this.step];
      const then = (mine + (this.other() || 0)) / (s.uploadMbps * 10);
      const line = up === 0 ? s.guest.upload : s.member.upload;
      if (then < line - 5 && !(up === 0 && waiting)) {
        this.step = up;
        this.calmAt = now;
      }
    }
    return Math.round(full * STEPS[this.step]);
  }

  /* Upload as a share of the house line: this machine's, the relay's
     (its browser), and what the run would add. */
  upPct(extraKbps) {
    return (this.meter.upKbps + (this.other() || 0) + (extraKbps || 0)) / (this.settings().uploadMbps * 10);
  }

  /* Would a run of this kind fit under this tier's line right now?
     `counts` is the machine-wide count check, done by the caller. */
  fits(tier, kind, countsOk) {
    if (tier === "admin") return true;
    if (!countsOk) return false;
    const s = this.settings(), t = s[tier] || s.guest, cost = s.costs[kind] || s.costs.console;
    return this.meter.cpu + cost.cpu <= t.load && this.meter.mem <= t.load && this.upPct(cost.kbps) <= t.upload;
  }

  /* The reason, for the panel and for ADMIN. */
  why(tier, kind, countsOk) {
    if (!countsOk) return "every " + (kind === "screen" ? "screen" : "slot") + " is in use";
    const s = this.settings(), t = s[tier] || s.guest, cost = s.costs[kind] || s.costs.console;
    if (this.upPct(cost.kbps) > t.upload) return "the home internet's upload is busy";
    if (this.meter.mem > t.load) return "the server's memory is nearly full";
    return "the server is busy";
  }

  /* ---- the line ---- */
  /* In order: moved up by an admin, then tier, then when they joined. */
  ordered(kind) {
    return this.line.filter((e) => !kind || e.kind === kind)
      .sort((a, b) => (prio(a) - prio(b)) || (a.at - b.at) || (a.n - b.n));
  }

  /* Is anyone of this tier or better already waiting for this kind?
     If so a newcomer goes behind them rather than past them. */
  someoneAhead(tier, kind, who) {
    return this.line.some((e) => e.kind === kind && e.who !== who && prio(e) <= RANK[tier]);
  }

  mine(who) { return this.line.filter((e) => e.who === who); }

  join(p) {
    const old = this.line.find((e) => e.who === p.who && e.kind === p.kind);
    if (old) { old.req = p.req; old.gone = null; return old; }
    if (this.line.length >= LINE_MAX) throw new Error("the line is full — try again later");
    if (p.tier === "guest" && this.line.filter((e) => e.tier === "guest").length >= GUEST_LINE_MAX) {
      throw new Error("the guest line is full — try again later");
    }
    const e = { id: crypto.randomBytes(6).toString("hex"), who: p.who, handle: p.handle, tier: p.tier,
      kind: p.kind, req: p.req, owner: p.owner, at: this.now(), n: ++this.n,
      offered: null, gone: null, bumped: false };
    this.line.push(e);
    return e;
  }

  leave(id) {
    const i = this.line.findIndex((e) => e.id === id);
    if (i < 0) return null;
    return this.line.splice(i, 1)[0];
  }

  /* ADMIN: to the very front, ahead of every tier (but still let in
     at their own tier's threshold). */
  bump(id) {
    const e = this.line.find((x) => x.id === id);
    if (!e) return null;
    const first = this.ordered(e.kind)[0];
    e.bumped = true;
    if (first && first !== e) e.at = Math.min(e.at, first.at - 1);
    return e;
  }

  /* The place, how many are ahead, and a guess at the wait. */
  place(e, runningOfKind) {
    const ord = this.ordered(e.kind);
    const i = ord.indexOf(e);
    const avg = this.avgMs(e.kind);
    const slots = Math.max(1, runningOfKind || 1);
    return { id: e.id, kind: e.kind, name: e.req && e.req.name ? String(e.req.name) : null,
      place: i + 1, ahead: i, of: ord.length,
      etaSec: Math.round((i + 1) * avg / slots / 1000),
      /* Seconds left to press START, when it is their turn: a count,
         not a time, so a Chromebook's clock being off does not matter. */
      turnLeft: e.offered ? Math.max(0, Math.round((e.offered + this.settings().turnSec * 1000 - this.now()) / 1000)) : null };
  }

  ended(kind, ms) {
    const r = this.ran[kind] || (this.ran[kind] = []);
    r.push(ms);
    if (r.length > 20) r.shift();
  }

  avgMs(kind) {
    const r = this.ran[kind] || [];
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 10 * 60000;
  }

  /* Moves the line along. Returns what happened, for the server to
     act on: offers to make, places that lapsed, and runs to warn or
     end because people are waiting. `ctx`:
       countsOk(kind, tier)   the machine-wide counts allow one more
       online(who)            that person has a connection open
       running()              [{ id, kind, tier, startedAt, lastInput, warned }]  */
  pump(ctx) {
    const now = this.now(), s = this.settings();
    const out = { offer: [], lapsed: [], warn: [], end: [], quiet: [] };
    for (const e of this.line.slice()) {
      if (e.offered && now - e.offered > s.turnSec * 1000) {
        this.leave(e.id); out.lapsed.push({ e: e, why: "your turn passed: START was not pressed within " + s.turnSec + " seconds" });
      } else if (!ctx.online(e.who)) {
        if (e.tier === "guest") { this.leave(e.id); out.lapsed.push({ e: e, why: "you left" }); continue; }
        if (!e.gone) e.gone = now;
        else if (now - e.gone > s.graceSec * 1000 && !e.offered) {
          this.leave(e.id); out.lapsed.push({ e: e, why: "you were away for more than " + Math.round(s.graceSec / 60) + " minutes" });
        }
      } else e.gone = null;
    }
    for (const kind of KINDS) {
      const ord = this.ordered(kind);
      if (!ord.length) continue;
      const head = ord[0];
      /* One offer at a time per kind: the room is held for it. */
      if (!head.offered && this.fits(head.tier, kind, ctx.countsOk(kind, head.tier))) {
        head.offered = now;
        out.offer.push(head);
      }
      /* People are waiting for this kind: hold others' runs to their
         share. Admins' are never touched. */
      const w = s.whenWaiting;
      for (const r of ctx.running()) {
        if (r.kind !== kind || r.tier === "admin") continue;
        const cap = (r.tier === "guest" ? w.guestMin : w.memberMin) * 60000;
        const age = now - r.startedAt;
        if (age >= cap) { out.end.push({ id: r.id, why: "others are waiting, and " + Math.round(cap / 60000) + " minutes is the limit while they do" }); continue; }
        if (kind === "screen" && now - (r.lastInput || r.startedAt) >= w.idleMin * 60000) {
          out.end.push({ id: r.id, why: "nobody had touched it for " + w.idleMin + " minutes, and others are waiting" }); continue;
        }
        /* A console program with no input and no output for as long:
           a candidate, which the server ends only if its processor
           use says it is really doing nothing (IDLE_CPU). */
        if (kind === "console" && now - Math.max(r.lastInput || 0, r.lastOut || 0, r.startedAt) >= w.idleMin * 60000) {
          out.quiet.push({ id: r.id, why: "it had done nothing for " + w.idleMin + " minutes (no input, no output, no processor), and others are waiting" });
        }
        if (age >= cap - 120000 && !r.warned) out.warn.push({ id: r.id, text: "Others are waiting: this ends in about 2 minutes." });
      }
    }
    return out;
  }

  /* For ADMIN. */
  view(runningCount) {
    const s = this.settings();
    return {
      meter: Object.assign({}, this.meter, { relayUpKbps: Math.round(this.other() || 0), upPct: Math.round(this.upPct(0) * 10) / 10,
        relaySeenSec: this.otherAt() ? Math.max(0, Math.round((this.now() - this.otherAt()) / 1000)) : null,
        relayWaiting: this.otherWaiting() | 0, videoStep: this.step }),
      settings: { guest: s.guest, member: s.member, uploadMbps: s.uploadMbps },
      line: this.ordered().map((e) => Object.assign({ handle: e.tier === "guest" ? "a guest" : e.handle, tier: e.tier,
        away: !!e.gone, bumped: e.bumped }, this.place(e, runningCount ? runningCount(e.kind) : 1)))
    };
  }
}

module.exports = { Access, DEFAULTS, RANK, KINDS, STEPS, IDLE_CPU, readProc };
