/* ============================================================
   FieldKit relay :: proc-usage — what a process (and its children)
   is using, read from /proc

   For RUNNER_PLAN.md §17, "measure first": the browser's Chromium is
   one program with many processes (a renderer per site, a GPU process
   that draws in software, a network service), and each viewer's
   encoder is one ffmpeg. An admin asking "what does the browser cost"
   needs the sum.

   Linux only, because that is where the relay runs. Elsewhere every
   reading is null and nothing breaks. Nothing here is ever written,
   and a process that exits between two reads is simply not counted.
   ============================================================ */
"use strict";

const fs = require("fs");

const HZ = 100;                  /* USER_HZ: 100 on every Linux the relay runs on */
const PAGE = 4096;

/* { ppid, ticks (user + system), rssBytes } or null. The command name
   is in brackets and may hold spaces, so the fields are counted from
   after the last ")". */
function readStat(pid) {
  let s;
  try { s = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); } catch (e) { return null; }
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  /* f[0] is field 3 (state): field n is f[n - 3]. */
  const ppid = Number(f[1]), utime = Number(f[11]), stime = Number(f[12]), rss = Number(f[21]);
  if (!isFinite(ppid) || !isFinite(utime)) return null;
  return { ppid: ppid, ticks: utime + stime, rssBytes: rss * PAGE };
}

/* The process and everything under it. */
function tree(root) {
  if (!root || process.platform !== "linux") return [];
  let names;
  try { names = fs.readdirSync("/proc"); } catch (e) { return []; }
  const kids = new Map();
  const stats = new Map();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const st = readStat(n);
    if (!st) continue;
    stats.set(Number(n), st);
    if (!kids.has(st.ppid)) kids.set(st.ppid, []);
    kids.get(st.ppid).push(Number(n));
  }
  const out = [];
  const walk = (p) => {
    const st = stats.get(p);
    if (!st) return;
    out.push(Object.assign({ pid: p }, st));
    (kids.get(p) || []).forEach(walk);
  };
  walk(Number(root));
  return out;
}

/* Cores in use since the last reading (1 = one whole core). The first
   reading has nothing to compare with, so its cpu is null. */
class Meter {
  constructor() { this.last = null; }
  read(root) {
    const procs = tree(root);
    if (!procs.length) { this.last = null; return null; }
    const ticks = procs.reduce((n, p) => n + p.ticks, 0);
    const at = Date.now();
    let cpu = null;
    if (this.last && this.last.root === root && at > this.last.at) {
      cpu = Math.max(0, Math.round(((ticks - this.last.ticks) / HZ) / ((at - this.last.at) / 1000) * 100) / 100);
    }
    this.last = { root: root, ticks: ticks, at: at };
    return { cpu: cpu, memMb: Math.round(procs.reduce((n, p) => n + p.rssBytes, 0) / 1048576), procs: procs.length };
  }
}

module.exports = { readStat, tree, Meter };
