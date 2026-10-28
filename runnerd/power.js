/* ============================================================
   FieldKit runnerd :: power — what Bastion 2 draws (RUNNER_PLAN.md §24)

   The processor's energy counter needs root, and runnerd runs in a
   container without it, so a small root service on the host (fk-power,
   installed by setup.sh) writes the readings to a file once a minute:
   the CPU package's watts from its own counter (RAPL), and the card's
   from nvidia-smi. This reads that file, keeps a day of it, and turns
   it into what ADMIN shows: watts now, the day's average, and a
   month's kWh and cost at that average.

   NOT measured: the board, disk, fans and the power supply's own
   losses. An admin sets an estimate for those ("the rest of the PC",
   30 W to start), and ADMIN says it is an estimate. The price per kWh
   is set in ADMIN too, so nobody edits a file on Bastion 2 for it.

   The file is written by root, but it is still only believed for
   numbers in a sane range: it is the one thing here that comes from
   outside runnerd's own process.
   ============================================================ */
"use strict";

const fs = require("fs");
const jf = require("../relay/jsonfile");

const DAY = 24 * 3600 * 1000;
const STALE_MS = 5 * 60 * 1000;
const HOURS_PER_MONTH = 730;
const num = (v, max) => (typeof v === "number" && isFinite(v) && v >= 0 && v <= max ? v : null);

class Power {
  constructor(opts) {
    this.file = opts.file;
    this.settingsFile = opts.settingsFile;
    this.now = opts.now || Date.now;
    this.samples = [];          /* { at, w }, the last day */
    this.last = null;
  }

  settings() {
    let s = {};
    try { s = jf.read(this.settingsFile, {}) || {}; } catch (e) {}
    return {
      pricePerKwh: num(s.pricePerKwh, 100) || 0,
      otherWatts: num(s.otherWatts, 1000) == null ? 30 : s.otherWatts,
      currency: typeof s.currency === "string" && /^[^\s<>"'&]{1,4}$/.test(s.currency) ? s.currency : "$"
    };
  }

  /* An admin's change, checked field by field. Returns what is now set. */
  set(change) {
    const cur = this.settings();
    if (change.pricePerKwh != null) {
      const p = Number(change.pricePerKwh);
      if (!(p >= 0 && p <= 100)) throw new Error("a price per kWh is between 0 and 100");
      cur.pricePerKwh = Math.round(p * 10000) / 10000;
    }
    if (change.otherWatts != null) {
      const w = Number(change.otherWatts);
      if (!(w >= 0 && w <= 1000)) throw new Error("the rest of the PC is between 0 and 1000 W");
      cur.otherWatts = Math.round(w);
    }
    if (change.currency != null) {
      const c = String(change.currency).trim();
      if (!/^[^\s<>"'&]{1,4}$/.test(c)) throw new Error("a currency is a symbol or code of up to 4 characters");
      cur.currency = c;
    }
    jf.write(this.settingsFile, cur);
    return cur;
  }

  read() {
    let r;
    try { r = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { return null; }
    if (!r || typeof r !== "object") return null;
    const at = num(r.at, 1e11);
    if (at == null) return null;
    return {
      at: at * 1000,
      cpuW: num(r.cpuW, 2000),
      gpuW: num(r.gpuW, 2000),
      gpuState: typeof r.gpuState === "string" && /^P\d{1,2}$/.test(r.gpuState) ? r.gpuState : null,
      gpuTempC: num(r.gpuTempC, 150)
    };
  }

  /* Called once a minute. A reading counts once, and only while fresh:
     a stopped fk-power must not look like a steady draw. */
  sample() {
    const r = this.read();
    const now = this.now();
    this.samples = this.samples.filter((x) => now - x.at < DAY);
    if (!r || now - r.at > STALE_MS) { this.last = r; return false; }
    this.last = r;
    if (this.samples.length && this.samples[this.samples.length - 1].at === r.at) return false;
    if (r.cpuW == null && r.gpuW == null) return false;
    this.samples.push({ at: r.at, w: (r.cpuW || 0) + (r.gpuW || 0) });
    return true;
  }

  view() {
    const s = this.settings();
    const r = this.last;
    const fresh = !!r && this.now() - r.at <= STALE_MS;
    if (!fresh) {
      return { ok: false, settings: s,
        why: r ? "the last reading is " + Math.round((this.now() - r.at) / 60000) + " minutes old: fk-power has stopped on Bastion 2"
          : "no readings yet: they start once setup.sh has been rerun on Bastion 2 (it installs fk-power)" };
    }
    const n = this.samples.length;
    const measuredAvg = n ? this.samples.reduce((a, x) => a + x.w, 0) / n : (r.cpuW || 0) + (r.gpuW || 0);
    const avgW = measuredAvg + s.otherWatts;
    const monthKwh = avgW * HOURS_PER_MONTH / 1000;
    const span = n > 1 ? this.samples[n - 1].at - this.samples[0].at : 0;
    return {
      ok: true, settings: s,
      now: { cpuW: r.cpuW, gpuW: r.gpuW, gpuState: r.gpuState, gpuTempC: r.gpuTempC, at: r.at },
      avgW: Math.round(avgW * 10) / 10,
      overHours: Math.round(span / 360000) / 10,
      monthKwh: Math.round(monthKwh * 10) / 10,
      monthCost: s.pricePerKwh > 0 ? Math.round(monthKwh * s.pricePerKwh * 100) / 100 : null
    };
  }
}

module.exports = { Power, STALE_MS };
