/* ============================================================
   FieldKit runnerd :: sleep — Bastion 2 asleep when nobody needs it
   (RUNNER_PLAN.md §24)

   A PC with a workstation card idles at 60-90 W and sleeps at ~3 W,
   and most hours nobody is using RUNNER. So after a quiet spell this
   machine suspends, and the relay wakes it with Wake-on-LAN when
   somebody opens RUNNER.

   Who does what:
     runnerd (here)  decides. It knows what is running, who is
                     connected and who is waiting. Once a minute it
                     writes its plan to a file in the store.
     fk-sleep        a small root service on the host (setup.sh
                     installs it), because suspending needs root. It
                     reads the plan, arms Wake-on-LAN on the network
                     card and suspends. It writes what it sees back:
                     the card, its address, whether it can wake the
                     machine, whether someone is logged in.
     the relay       learns the card's address from /health, keeps
                     it, and when somebody opens RUNNER while this is
                     asleep, has its helper on Bastion 1 send the
                     magic packet.

   ANNOUNCED FIRST. The plan says "sleeping soon" for ANNOUNCE_MS
   before it says "sleep", so the relay's health check (every 30 s)
   sees it coming and can tell the panel "asleep" rather than
   "offline".

   OFF BY DEFAULT. If Wake-on-LAN is not switched on in the BIOS, a
   machine that goes to sleep stays asleep until somebody presses its
   power button. An admin switches it on in ADMIN, after checking the
   lines above the switch.
   ============================================================ */
"use strict";

const fs = require("fs");

const ANNOUNCE_MS = 45 * 1000;
const HOST_STALE_MS = 3 * 60 * 1000;
const QUIET_IDLE_MIN = 5;          /* in quiet hours it goes sooner */
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/* The hour now in a time zone, 0-23. A zone this Node does not know
   counts as UTC rather than throwing. */
function hourIn(tz, now) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz || "UTC" })
      .format(new Date(now))) % 24;
  } catch (e) { return new Date(now).getUTCHours(); }
}

/* Quiet hours run from `from` up to `to`, across midnight if from > to.
   Equal or missing means there are none. */
function inQuiet(q, now) {
  if (!q || q.from == null || q.to == null || q.from === q.to) return false;
  const h = hourIn(q.tz, now);
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

const hour = (v) => (v === null || v === "" || v === undefined ? null
  : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? Number(v) : undefined);
const zoneOk = (z) => {
  if (typeof z !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(z)) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: z }); return true; } catch (e) { return false; }
};

class Sleep {
  constructor(opts) {
    this.settingsFile = opts.settingsFile;
    this.planFile = opts.planFile;
    this.hostFile = opts.hostFile;
    this.now = opts.now || Date.now;
    this.lastActive = this.now();
    this.planAt = null;
    this.force = null;          /* an admin's SLEEP NOW: { at, by } */
    this.seenResume = null;
    this.last = { sleep: false, why: "starting" };
  }

  settings() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(this.settingsFile, "utf8")) || {}; } catch (e) {}
    const idle = Number(s.idleMinutes);
    return {
      enabled: s.enabled === true,
      idleMinutes: Number.isInteger(idle) && idle >= 5 && idle <= 720 ? idle : 20,
      quietFrom: hour(s.quietFrom) == null ? null : hour(s.quietFrom),
      quietTo: hour(s.quietTo) == null ? null : hour(s.quietTo),
      tz: zoneOk(s.tz) ? s.tz : "UTC"
    };
  }

  /* An admin's change, checked field by field. */
  set(change) {
    const cur = this.settings();
    if (change.enabled != null) cur.enabled = change.enabled === true;
    if (change.idleMinutes != null) {
      const m = Number(change.idleMinutes);
      if (!(Number.isInteger(m) && m >= 5 && m <= 720)) throw new Error("idle minutes are a whole number from 5 to 720");
      cur.idleMinutes = m;
    }
    for (const k of ["quietFrom", "quietTo"]) {
      if (change[k] === undefined) continue;
      const h = hour(change[k]);
      if (h === undefined) throw new Error("quiet hours are whole hours from 0 to 23, or empty for none");
      cur[k] = h;
    }
    if ((cur.quietFrom == null) !== (cur.quietTo == null)) throw new Error("quiet hours need both a start and an end, or neither");
    if (change.tz != null) {
      if (!zoneOk(change.tz)) throw new Error("that time zone is not one this server knows");
      cur.tz = change.tz;
    }
    const tmp = this.settingsFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cur), "utf8");
    fs.renameSync(tmp, this.settingsFile);
    if (!cur.enabled) this.planAt = null;
    return cur;
  }

  quiet() {
    const s = this.settings();
    return s.quietFrom == null ? null : { from: s.quietFrom, to: s.quietTo, tz: s.tz };
  }

  /* What fk-sleep last wrote. Believed only in shape, like power.json. */
  host() {
    let r;
    try { r = JSON.parse(fs.readFileSync(this.hostFile, "utf8")); } catch (e) { return null; }
    if (!r || typeof r !== "object" || !(r.at > 0)) return null;
    const mac = typeof r.mac === "string" ? r.mac.toLowerCase() : "";
    return {
      at: r.at * 1000,
      fresh: this.now() - r.at * 1000 < HOST_STALE_MS,
      iface: typeof r.iface === "string" && /^[\w.@-]{1,32}$/.test(r.iface) ? r.iface : null,
      mac: MAC_RE.test(mac) ? mac : null,
      supports: typeof r.supports === "string" ? r.supports.replace(/[^a-z]/gi, "").slice(0, 16) : "",
      wol: typeof r.wol === "string" ? r.wol.replace(/[^a-z]/gi, "").slice(0, 16) : "",
      blocked: typeof r.blocked === "string" && r.blocked ? r.blocked.slice(0, 120) : null,
      resumedAt: r.resumedAt > 0 ? r.resumedAt * 1000 : null
    };
  }

  /* Something happened: a message from a connected panel, a job, a
     place in the line. */
  touch() { this.lastActive = this.now(); }

  sleepNow(by) {
    const h = this.host();
    if (!h || !h.fresh) throw new Error("fk-sleep is not running on Bastion 2, so it cannot sleep: rerun setup.sh");
    if (!h.mac || h.supports.indexOf("g") < 0) throw new Error("its network card cannot wake it, so it would not come back by itself");
    this.force = { at: this.now(), by: by };
    this.planAt = null;
  }
  cancel() { this.force = null; this.planAt = null; this.lastActive = this.now(); }

  /* Every 15 s. `busy` is { jobs, line }; a connected panel only counts
     through touch(), so a RUNNER left open in a corner does not keep
     the machine up all night. */
  tick(busy) {
    const now = this.now();
    const s = this.settings();
    const h = this.host();
    if (h && h.resumedAt && h.resumedAt !== this.seenResume) {
      /* Just woken: give whoever woke it the full spell to connect. */
      this.seenResume = h.resumedAt;
      this.lastActive = now;
      this.force = null;
      this.planAt = null;
    }
    if (busy.jobs > 0 || busy.line > 0) this.lastActive = now;
    const quiet = inQuiet(this.quiet(), now);
    const limit = (quiet ? Math.min(s.idleMinutes, QUIET_IDLE_MIN) : s.idleMinutes) * 60000;
    let why = null;
    if (!s.enabled && !this.force) why = "sleeping when idle is switched off";
    else if (!h || !h.fresh) why = "fk-sleep is not running on Bastion 2 (setup.sh installs it)";
    else if (!h.mac || h.supports.indexOf("g") < 0) why = "its network card cannot wake it";
    else if (busy.jobs > 0) why = "something is running";
    else if (busy.line > 0) why = "people are waiting";
    else if (!this.force && now - this.lastActive < limit) {
      why = "idle for " + Math.floor((now - this.lastActive) / 60000) + " of " + Math.round(limit / 60000) + " minutes";
    }
    if (why) this.planAt = null;
    else if (!this.planAt) this.planAt = now;
    const sleep = !why && now - this.planAt >= ANNOUNCE_MS;
    this.last = { sleep: sleep, soon: !why, why: why, quiet: quiet, at: now };
    try {
      const tmp = this.planFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ at: Math.floor(now / 1000), sleep: sleep, soon: !why,
        why: why || (sleep ? "sleeping" : "sleeping in " + Math.ceil((ANNOUNCE_MS - (now - this.planAt)) / 1000) + " s") }), "utf8");
      fs.renameSync(tmp, this.planFile);
    } catch (e) { /* the store is gone; nothing sleeps, which is the safe way to fail */ }
    return this.last;
  }

  /* For the relay, on /health: enough to wake this machine and to say
     "asleep" rather than "offline". */
  forRelay() {
    const h = this.host();
    const s = this.settings();
    return { mac: h && h.mac, can: !!(h && h.mac && h.supports.indexOf("g") >= 0),
      on: s.enabled, soon: !!this.last.soon, quiet: this.quiet() };
  }

  /* For ADMIN. `helperSec` is how long ago the relay last heard from
     its wake helper, as the relay reports it (-1: never). */
  view(helperSec) {
    const h = this.host();
    return { settings: this.settings(), host: h, state: this.last, force: this.force,
      idleSec: Math.round((this.now() - this.lastActive) / 1000), helperSec: helperSec == null ? null : helperSec };
  }
}

module.exports = { Sleep, inQuiet, hourIn, ANNOUNCE_MS, HOST_STALE_MS, MAC_RE };
