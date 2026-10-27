/* ============================================================
   FieldKit runnerd :: limits — what each tier is allowed

   One table, so the answer to "what can a guest do" is in one
   place and the tests can read it.

   A GUEST is somebody nobody has vouched for. They get a small,
   short-lived sandbox that is destroyed the moment they leave,
   and never the GPU. A MEMBER keeps their files, their programs
   keep running after the panel closes, they get a saved folder
   (/save) and the web through the filter. Everything here is a
   ceiling the config can lower or raise per tier.
   ============================================================ */
"use strict";

const MB = 1024 * 1024, GB = 1024 * MB;

const DEFAULTS = {
  guest: {
    keepFiles: false,            /* wiped on disconnect */
    gpu: false,
    maxFileBytes: 32 * MB,
    quotaBytes: 64 * MB,
    maxFiles: 16,
    cpus: 1, memoryMb: 512, pids: 64, workMb: 64,
    timeoutSec: 120,
    outputBytes: 1 * MB,
    concurrentJobs: 1,
    keepRunning: false,          /* stopped when the connection closes */
    saveBytes: 0, saveFiles: 0,  /* no saved folder */
    internet: false,             /* RUNNER_PLAN.md §4a: an unapproved stranger, from this house's address */
    screen: false,               /* a window costs a CPU core and upload; members first */
    scrollbackBytes: 64 * 1024
  },
  member: {
    keepFiles: true,
    gpu: true,                   /* RUNNER_PLAN.md §4a: approval is the trust decision; an admin can say no per person */
    maxFileBytes: 1 * GB,
    quotaBytes: 5 * GB,
    maxFiles: 500,
    cpus: 2, memoryMb: 2048, pids: 256, workMb: 512,
    timeoutSec: 30 * 60,
    outputBytes: 16 * MB,
    concurrentJobs: 2,
    keepRunning: true,           /* until its time limit, with or without the panel */
    saveBytes: 1 * GB, saveFiles: 5000,
    internet: true,              /* through the filter, never directly */
    screen: true,                /* programs with a window, streamed (phase 6) */
    scrollbackBytes: 256 * 1024
  },
  admin: {
    keepFiles: true,
    gpu: true,
    maxFileBytes: 4 * GB,
    quotaBytes: 20 * GB,
    maxFiles: 2000,
    cpus: 2, memoryMb: 4096, pids: 512, workMb: 1024,
    timeoutSec: 2 * 60 * 60,
    outputBytes: 32 * MB,
    concurrentJobs: 4,
    keepRunning: true,
    saveBytes: 4 * GB, saveFiles: 20000,
    internet: true,
    screen: true,
    scrollbackBytes: 256 * 1024
  }
};

/* Whole-machine ceilings. Bastion 2 has eight threads and they are
   the scarce thing; these keep a queue of guests from starving a
   member, and everybody together from starving the machine. */
/* Screens: each is a CPU core encoding and ~1.5 Mbit/s of the house's
   ~20 Mbit/s upload, so two at once to begin with (RUNNER_PLAN.md §22
   replaces this with a live meter and a waiting line). */
const MACHINE = { maxJobs: 6, maxGuestJobs: 2, maxSessions: 24, maxGuestSessions: 8, maxScreens: 2 };

function build(overrides) {
  const o = overrides || {};
  const tiers = {};
  Object.keys(DEFAULTS).forEach((t) => {
    tiers[t] = Object.assign({}, DEFAULTS[t], (o.tiers || {})[t] || {});
    /* Not configurable. A guest sandbox that outlives its connection
       is not a guest sandbox, and the GPU for unapproved accounts is
       the one thing that was explicitly ruled out. */
    if (t === "guest") {
      tiers[t].keepFiles = false; tiers[t].gpu = false;
      tiers[t].keepRunning = false; tiers[t].saveBytes = 0; tiers[t].saveFiles = 0;
    }
  });
  return { tiers: tiers, machine: Object.assign({}, MACHINE, o.machine || {}) };
}

/* What the client is told, so it can refuse a file that is too big
   before uploading a byte of it. */
function publicView(l) {
  return { keepFiles: l.keepFiles, gpu: l.gpu, maxFileBytes: l.maxFileBytes,
    quotaBytes: l.quotaBytes, maxFiles: l.maxFiles, timeoutSec: l.timeoutSec,
    outputBytes: l.outputBytes, concurrentJobs: l.concurrentJobs,
    cpus: l.cpus, memoryMb: l.memoryMb,
    keepRunning: l.keepRunning, saveBytes: l.saveBytes, internet: l.internet, screen: !!l.screen };
}

module.exports = { DEFAULTS, MACHINE, build, publicView };
