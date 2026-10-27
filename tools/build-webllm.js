#!/usr/bin/env node
/* ============================================================
   FieldKit :: tools/build-webllm.js

   Produces vendor/web-llm.js — a CLASSIC-SCRIPT build of WebLLM
   that FIELDKIT.html can load from file://.

   WHY THIS SCRIPT HAS TO EXIST

   WebLLM ships as an ES module. <script type="module"> is
   CORS-blocked from file:// (§2C), which is the same wall that
   made all of FieldKit classic scripts in the first place. So the
   library has to be flattened into a single IIFE that exposes a
   global, ahead of time, on a machine that has npm.

   That machine is the SSD, not the thumb drive and not the
   Chromebook. Run this once; the output is committed and rides
   along in the deploy payload like any other file.

   USAGE

     node tools/build-webllm.js

   It installs nothing globally and writes nothing outside the
   repo. It needs network access for the npm fetch, and roughly a
   minute.

   AFTERWARDS

     - vendor/web-llm.js appears (expect 2-6 MB)
     - FIELDKIT.html's manifest already lists it; the loader skips
       a missing vendor file without complaint, so the entry is
       harmless before you run this and live afterwards
     - node build.js            (re-inline the standalone build)
     - node build.js --deploy X (copy to the stick)

   WHAT IT DOES NOT DO

   It does not download a model. Weights are gigabytes and do not
   belong in a git repo. Get those from the MLC model list, put
   the folder anywhere convenient, and point AI LOCAL at it.
   ============================================================ */
"use strict";

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor");
const OUT = path.join(VENDOR, "web-llm.js");

/* Pinned rather than floating. A silent major-version bump in a
   file that cannot be debugged from the target machine is not a
   trade worth making — bump it here deliberately, rebuild, and
   test before deploying. */
const PKG = "@mlc-ai/web-llm@0.2.79";
const ESBUILD = "esbuild@0.24.0";

function say(msg) { process.stdout.write(msg + "\n"); }
function die(msg) { process.stderr.write("\nBUILD FAILED: " + msg + "\n"); process.exit(1); }

function have(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd],
    { stdio: "ignore", shell: false });
  return r.status === 0;
}

say("FieldKit :: building a classic-script WebLLM bundle");
say("");

if (!have("npx")) {
  die("npx is not on PATH. This needs Node with npm — run it on your PC, not the Chromebook.");
}

fs.mkdirSync(VENDOR, { recursive: true });

/* A scratch directory outside the repo, so a failed run leaves no
   node_modules behind for build.js to trip over or for --deploy to
   copy onto a 15.9 GB stick. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fk-webllm-"));
say("work dir: " + work);

try {
  fs.writeFileSync(path.join(work, "package.json"),
    JSON.stringify({ name: "fk-webllm-build", private: true, version: "1.0.0" }, null, 2));

  /* The entry point re-exports the library under one namespace.
     `globalName` in esbuild then hangs that namespace off window,
     which is precisely the shape ai-tier2-local.js detects. */
  fs.writeFileSync(path.join(work, "entry.js"),
    'export * from "@mlc-ai/web-llm";\n');

  say("installing " + PKG + " …");
  execSync(`npm install --no-audit --no-fund --loglevel=error ${PKG}`,
    { cwd: work, stdio: "inherit" });

  say("bundling with " + ESBUILD + " …");
  execSync(
    `npx --yes ${ESBUILD} entry.js --bundle --format=iife --global-name=webllm ` +
    `--platform=browser --target=es2020 --minify --outfile="${OUT}"`,
    { cwd: work, stdio: "inherit" });

  const size = fs.statSync(OUT).size;
  const src = fs.readFileSync(OUT, "utf8");

  /* Two assertions, because a bundle that loads and then does not
     expose the entry point fails deep inside the engine loader
     with a message that means nothing on a machine with no
     console. Catch it here, where there is a terminal. */
  if (!/\bwebllm\b/.test(src.slice(0, 4000))) {
    die("the bundle does not appear to assign a `webllm` global. " +
        "esbuild's --global-name may have been ignored.");
  }
  if (!/CreateMLCEngine/.test(src)) {
    die("CreateMLCEngine is not in the bundle. The package layout may have changed; " +
        "check the pinned version at the top of this script.");
  }

  say("");
  say("wrote " + path.relative(ROOT, OUT) + "  (" + (size / 1048576).toFixed(1) + " MB)");
  say("");
  say("Next:");
  say("  1. node build.js                 re-inline the standalone build");
  say("  2. node build.js --deploy E:\\    copy to the stick");
  say("  3. open FieldKit, AI LOCAL, and point it at a model folder");
  say("");
  say("Model weights are NOT included and should not be committed.");
  say("Get an MLC-format model (a folder containing mlc-chat-config.json,");
  say("ndarray-cache.json and params_shard_*.bin) and keep it anywhere");
  say("you can reach with a file picker.");
} catch (e) {
  die(e.message);
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* leave it */ }
}
