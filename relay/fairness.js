/* ============================================================
   FieldKit relay :: fairness — the streamed browser's share of this
   container and of the home upload (RUNNER_PLAN.md §22, phase 7b)

   RUNNER on Bastion 2 already lets each tier in only under its own
   line and keeps a waiting line. This is the same for the browser on
   Bastion 1, with two differences:

   - What is measured is THIS CONTAINER against its own limits (the
     relay runs in a Pterodactyl container capped at 3 processors and
     4.4 GB), from its cgroup, not the whole machine.
   - The upload is the house's: the relay's browser and RUNNER's
     windows go out over the same home line. runner.js trades numbers
     with Bastion 2 (a signed report of ours on its health check; its
     own in the answer), and the thresholds are the ones an admin set
     in RUNNER's ADMIN, so there is one set of rules for both.

   Only a NEW browser session is ever made to wait: someone already
   browsing keeps their session. Admins (and the vault holder, who
   owns this relay) never wait. The others wait in line, members
   ahead of guests, and the panel connects by itself when there is
   room: it is open and in front of them, so there is no START.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");

const RANK = { admin: 0, member: 1, guest: 2 };
const DEFAULTS = { guest: { load: 60, upload: 50 }, member: { load: 85, upload: 85 }, uploadMbps: 20 };
/* One browser session: Chromium's share while in use, and its video
   while the page moves (0.5-0.8 Mbit/s measured scrolling). */
const COST = { cpu: 10, mem: 6, kbps: 800, pids: 20 };
const LINE_MAX = 40;
/* Video quality, as a share of the full bitrate: full, then two steps
   down while the house upload is busy or anyone waits (§22 point 5). */
const STEPS = [1, 0.67, 0.4];
const CALM_MS = 30000;

const num = (t) => { const n = Number(String(t).trim()); return isFinite(n) ? n : null; };
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return null; } };

/* The container's processor time (microseconds), its share of
   processors, and its memory use and limit, from cgroup v2 or v1;
   the whole machine's if neither is readable. */
function readCgroup() {
  const out = {};
  const v2 = readText("/sys/fs/cgroup/cpu.stat");
  if (v2) {
    out.cpuUsec = num((/usage_usec (\d+)/.exec(v2) || [])[1]);
    const max = (readText("/sys/fs/cgroup/cpu.max") || "").trim().split(/\s+/);
    out.cpus = max[0] && max[0] !== "max" ? num(max[0]) / num(max[1] || 100000) : os.cpus().length;
    const cur = num(readText("/sys/fs/cgroup/memory.current")), lim = readText("/sys/fs/cgroup/memory.max");
    const stat = readText("/sys/fs/cgroup/memory.stat") || "";
    const inactive = num((/inactive_file (\d+)/.exec(stat) || [])[1]) || 0;
    out.memUsed = cur != null ? Math.max(0, cur - inactive) : null;
    out.memLimit = lim && lim.trim() !== "max" ? num(lim) : os.totalmem();
    out.pidsUsed = num(readText("/sys/fs/cgroup/pids.current"));
    out.pidsLimit = num(readText("/sys/fs/cgroup/pids.max"));
    return out;
  }
  const v1 = readText("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  if (v1) {
    out.cpuUsec = num(v1) / 1000;
    const q = num(readText("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")), p = num(readText("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
    out.cpus = q > 0 && p > 0 ? q / p : os.cpus().length;
    const used = num(readText("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
    const lim = num(readText("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    out.memUsed = used;
    out.memLimit = lim && lim < os.totalmem() * 4 ? lim : os.totalmem();
    return out;
  }
  /* Not a container (a PC running the relay to test it): the machine. */
  const t = os.cpus().reduce((a, c) => { const x = c.times; a.busy += x.user + x.nice + x.sys + x.irq; return a; }, { busy: 0 });
  out.cpuUsec = t.busy * 1000;
  out.cpus = os.cpus().length;
  out.memUsed = os.totalmem() - os.freemem();
  out.memLimit = os.totalmem();
  return out;
}

const SHARED_MS = 15000;

class Fairness {
  constructor(opts) {
    opts = opts || {};
    this.now = opts.now || Date.now;
    this.read = opts.read || readCgroup;
    this.peer = opts.peer || (() => null);   /* Bastion 2's { upKbps, settings, at } */
    this.sent = 0;                           /* bytes the browser has sent to panels */
    this.prev = null;
    this.meter = { cpu: 0, avg: null, mem: 0, pids: 0, upKbps: 0, at: 0 };
    this.sessions = opts.sessions || (() => 0);   /* how many sessions the meter is seeing */
    this.line = [];
    this.n = 0;
    this.step = 0;                           /* index into STEPS */
    this.calmAt = 0;
  }

  /* Called by the browser route for every frame it sends. */
  count(bytes) { this.sent += bytes; }

  sample() {
    const r = this.read() || {}, now = this.now(), p = this.prev;
    if (p && r.cpuUsec != null && p.cpuUsec != null && now > p.at && r.cpus > 0) {
      const used = (r.cpuUsec - p.cpuUsec) / ((now - p.at) * 1000 * r.cpus);
      this.meter.cpu = Math.max(0, Math.min(100, Math.round(used * 1000) / 10));
      /* Who gets in follows a smoothed reading: a page loading is a
         spike, a game is a level. */
      this.meter.avg = this.meter.avg === null ? this.meter.cpu : Math.round((this.meter.avg * 0.7 + this.meter.cpu * 0.3) * 10) / 10;
    }
    if (r.pidsUsed > 0 && r.pidsLimit > 0) this.meter.pids = Math.round(r.pidsUsed / r.pidsLimit * 1000) / 10;
    if (r.memUsed != null && r.memLimit > 0) this.meter.mem = Math.round(r.memUsed / r.memLimit * 1000) / 10;
    if (p && now > p.at) this.meter.upKbps = Math.max(0, Math.round((this.sent - p.sent) * 8 / (now - p.at)));
    this.meter.at = now;
    this.prev = { cpuUsec: r.cpuUsec, sent: this.sent, at: now };
    return this.meter;
  }

  /* Bastion 2's word on the thresholds, if it has spoken lately. */
  settings() {
    const p = this.peer();
    const s = p && p.settings && this.now() - p.at < 60000 ? p.settings : null;
    const ok = (t) => t && num(t.load) != null && num(t.upload) != null;
    return {
      guest: s && ok(s.guest) ? s.guest : DEFAULTS.guest,
      member: s && ok(s.member) ? s.member : DEFAULTS.member,
      uploadMbps: s && num(s.uploadMbps) > 0 ? s.uploadMbps : DEFAULTS.uploadMbps
    };
  }

  /* Bastion 2 as a whole, RUNNER, the browser, and anything else on it:
     { cpu, mem }, while its report is fresh. */
  machine() {
    const p = this.peer();
    return p && p.machine && this.now() - p.at < SHARED_MS ? p.machine : null;
  }

  /* What one more session is likely to cost: what the ones running
     really use, and at least the guess. Six sessions of games and six
     of text are not the same six. */
  costNow() {
    const n = this.sessions(), cpu = this.meter.avg === null ? this.meter.cpu : this.meter.avg;
    return { cpu: Math.max(COST.cpu, n ? cpu / n : 0), mem: Math.max(COST.mem, n ? this.meter.mem / n : 0), kbps: COST.kbps, pids: n ? this.meter.pids / n : COST.pids };
  }

  /* RUNNER's upload, while its report is fresh. */
  peerUp() {
    const p = this.peer();
    return p && this.now() - p.at < 30000 ? Math.max(0, Number(p.upKbps) || 0) : 0;
  }

  /* Someone waiting on Bastion 2, by its last report. */
  peerWaiting() {
    const p = this.peer();
    return !!(p && this.now() - p.at < 30000 && p.waiting > 0);
  }

  /* The bitrate every browser panel should have, from `full`. Down at
     once when the upload passes the guests' line or anyone waits, and
     down again past the members' line; back up one step at a time,
     only after 30 s of calm, and only if the step up would itself stay
     under the line, so it does not see-saw (each change costs a fresh
     keyframe). */
  videoKbps(full) {
    const s = this.settings(), now = this.now(), pct = this.upPct(0);
    const want = pct >= s.member.upload ? 2 : (pct >= s.guest.upload || this.line.length || this.peerWaiting()) ? 1 : 0;
    if (want >= this.step) {
      this.step = want;
      this.calmAt = now;
    } else if (now - this.calmAt >= CALM_MS) {
      const up = this.step - 1;
      const mine = this.meter.upKbps * STEPS[up] / STEPS[this.step];
      const then = (mine + this.peerUp()) / (s.uploadMbps * 10);
      const line = up === 0 ? s.guest.upload : s.member.upload;
      if (then < line - 5 && !(up === 0 && (this.line.length || this.peerWaiting()))) {
        this.step = up;
        this.calmAt = now;
      }
    }
    return Math.round(full * STEPS[this.step]);
  }

  upPct(extra) {
    return (this.meter.upKbps + this.peerUp() + (extra || 0)) / (this.settings().uploadMbps * 10);
  }

  fits(tier, slotFree) {
    if (tier === "admin") return true;
    if (!slotFree) return false;
    const t = this.settings()[tier] || this.settings().guest, c = this.costNow();
    const cpu = this.meter.avg === null ? this.meter.cpu : this.meter.avg;
    return cpu + c.cpu <= t.load && this.meter.mem + c.mem <= t.load && this.meter.pids + c.pids <= t.load && this.upPct(COST.kbps) <= t.upload;
  }

  why(tier, slotFree) {
    if (!slotFree) return "every browser session is in use";
    const t = this.settings()[tier] || this.settings().guest;
    if (this.upPct(COST.kbps) > t.upload) return "the home internet's upload is busy";
    if (this.meter.mem + this.costNow().mem > t.load) return "the relay's memory is nearly full";
    return "the relay is busy";
  }

  /* ---- the line ---- */
  ordered() {
    return this.line.slice().sort((a, b) => (RANK[a.tier] - RANK[b.tier]) || (a.n - b.n));
  }

  someoneAhead(tier) {
    return this.line.some((e) => RANK[e.tier] <= RANK[tier]) || this.shared() && this.peer().line.hold.includes(tier);
  }

  /* Is Bastion 2 keeping the one line (SIMPLIFY_PLAN.md §2)? Yes while
     its answers are fresh. If it stops answering, this relay moves its
     own line along as it always did, and nobody is stranded. */
  shared() {
    const p = this.peer();
    return !!(p && p.line && Array.isArray(p.line.hold) && this.now() - p.at < SHARED_MS);
  }

  /* The report's share of this: who is waiting, and who could start. */
  report(canStart) {
    return { line: this.ordered().slice(0, 40).map((e) => ({ id: e.n, t: e.tier, h: e.tier === "guest" ? undefined : e.who })),
      free: { guest: canStart("guest"), member: canStart("member") } };
  }

  /* Bastion 2's answer: places, and who goes. Returns who to let in. */
  answer(a) {
    const byId = new Map(this.line.map((e) => [String(e.n), e]));
    for (const id of Object.keys(a.places || {})) if (byId.has(id)) byId.get(id).far = a.places[id];
    for (const id of a.drop || []) {
      const e = byId.get(String(id));
      if (e) { e.dropped = true; this.leave(e); e.go(); }
    }
    return (a.go || []).map((id) => byId.get(String(id))).filter((e) => e && this.line.includes(e));
  }

  join(who, tier) {
    if (this.line.length >= LINE_MAX) throw new Error("the line for the browser is full — try again later");
    const e = { who: who, tier: tier, n: ++this.n, at: this.now(), go: null };
    e.ready = new Promise((resolve) => { e.go = resolve; });
    this.line.push(e);
    return e;
  }

  leave(e) {
    const i = this.line.indexOf(e);
    if (i >= 0) this.line.splice(i, 1);
  }

  place(e) {
    if (e.far && this.shared()) return e.far;
    const o = this.ordered(), i = o.indexOf(e);
    return { place: i + 1, ahead: i, of: o.length };
  }

  /* Lets the first in line in when there is room. One at a time: the
     next is looked at on the next sample, once the meter has seen the
     session that was just let in. */
  pump(slotFree) {
    const head = this.ordered()[0];
    if (!head || !this.fits(head.tier, slotFree)) return null;
    this.leave(head);
    head.go();
    return head;
  }

  view() {
    return { meter: Object.assign({}, this.meter, { peerUpKbps: this.peerUp(), upPct: Math.round(this.upPct(0) * 10) / 10 }),
      waiting: this.line.length, videoStep: this.step };
  }
}

module.exports = { Fairness, readCgroup, DEFAULTS, COST, STEPS };
