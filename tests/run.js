#!/usr/bin/env node
/* ============================================================
   FieldKit test runner

     node tests/run.js            run everything
     node tests/run.js qr guest   run matching suites only

   Each suite runs in its own child process because the harness
   installs globals — sharing one process would let a suite's fake
   window leak into the next one.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = __dirname;
const filter = process.argv.slice(2);

const suites = fs.readdirSync(DIR)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !filter.length || filter.some((k) => f.includes(k)))
  .sort();

if (!suites.length) {
  console.error(filter.length ? "no suites matched: " + filter.join(", ") : "no suites found");
  process.exit(1);
}

let totalPass = 0, totalFail = 0;
const broken = [];

for (const suite of suites) {
  console.log("\n" + "─".repeat(60));
  console.log("SUITE  " + suite);
  console.log("─".repeat(60));

  const r = spawnSync(process.execPath, [path.join(DIR, suite)], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8"
  });

  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);

  const m = /RESULT\s+pass\s+(\d+)\s+fail\s+(\d+)/.exec(r.stdout || "");
  if (m) {
    totalPass += Number(m[1]);
    totalFail += Number(m[2]);
  } else {
    /* A suite that crashed before printing its tally is a failure in
       its own right — never let it vanish from the count. */
    broken.push(suite);
  }
  if (r.status !== 0 && m && Number(m[2]) === 0) broken.push(suite + " (nonzero exit)");
}

console.log("\n" + "=".repeat(60));
console.log("TOTAL  pass " + totalPass + "   fail " + totalFail +
  (broken.length ? "   broken suites: " + broken.join(", ") : ""));
console.log("=".repeat(60));

process.exit(totalFail || broken.length ? 1 : 0);
