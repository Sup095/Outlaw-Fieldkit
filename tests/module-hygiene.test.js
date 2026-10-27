/* ============================================================
   Module hygiene — every module, mounted for real

   This suite exists because of a bug report that could not be
   narrowed down by hand: after a FULL SYSTEM EXERCISE, SETTINGS
   and other panels came back with their layout subtly wrong, and
   a refresh fixed it. Forty modules is too many to check by
   inspection, so this checks them instead.

   It does what the exercise does — mount every module for real,
   unmount it, and look at what changed — and then does the thing
   the exercise does not: mounts each one a SECOND time, the way
   reopening a window does, and requires the result to be
   identical.

   The bug it found is worth stating, because the fix looks wrong
   until you have seen it:

     1. The exercise mounts SETTINGS offscreen. Something async
        starts.
     2. A millisecond later the exercise unmounts it.
     3. The user opens SETTINGS for real. `nodes` — module scope,
        not per-mount — now points at the live panel.
     4. The async work from step 1 resolves and writes into it.

   A live panel with a section cleared or rows appended twice. It
   survives closing and reopening the window, because the damage is
   already on screen, and it goes away on refresh. Exactly the
   report.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner, fakeElement, ROOT } = require("./harness");

/* The real boot manifest, so a module added to the app is covered
   here without anyone remembering to add it. */
const html = fs.readFileSync(path.join(ROOT, "FIELDKIT.html"), "utf8");
const list = /window\.FK_BOOT_MANIFEST\s*=\s*\[([\s\S]*?)\]/.exec(html)[1]
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  .split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

const FieldKit = bootstrap(list);
const { ok, section, state } = makeRunner("module-hygiene");

global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
global.atob = (s) => Buffer.from(s, "base64").toString("binary");

const settings = FieldKit.service("settings");
const ui = FieldKit.service("ui");
const mods = FieldKit.modules();

const fallback = { settings, ui, log() {}, warn() {}, error() {}, on() {}, emit() {} };
function context() {
  try { return FieldKit.context(); } catch (e) { return fallback; }
}

/* Unhandled rejections are the symptom this whole suite is about:
   a continuation that fired after unmount and threw where nothing
   was listening. Collected rather than ignored. */
const stray = [];
process.on("unhandledRejection", (e) => stray.push(String((e && e.message) || e)));

function snapshot() {
  return {
    settings: JSON.stringify(settings.all()),
    bodyKids: document.body.children.length,
    bodyClass: document.body.className
  };
}

function shape(node) {
  const out = [];
  (function walk(n, d) {
    (n.children || []).forEach((c) => {
      if (!c || c.nodeType === 3) return;
      out.push(d + "|" + c.tagName + "|" + (c.className || ""));
      walk(c, d + 1);
    });
  })(node, 0);
  return out;
}

(async function () {
  const ids = Object.keys(mods).filter((id) => typeof mods[id].mount === "function").sort();

  section("every module mounts");
  {
    ok("the real boot manifest was read, not a hand-kept list", list.length > 40, String(list.length));
    ok("modules registered", ids.length > 30, String(ids.length));
  }

  section("nothing leaks out of its own panel");
  const leaked = [];
  const remountBroken = [];
  {
    for (const id of ids) {
      const mod = mods[id];
      const before = snapshot();

      const h1 = fakeElement("div");
      let e1 = null;
      try { await mod.mount(h1, context()); } catch (e) { e1 = e.message; }
      const s1 = shape(h1);
      try { if (mod.unmount) mod.unmount(); } catch (e) { /* reported via remount below */ }

      const after = snapshot();
      const diff = [];
      if (before.settings !== after.settings) {
        const b = JSON.parse(before.settings), a = JSON.parse(after.settings);
        Object.keys(a).forEach((k) => {
          if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) diff.push("setting " + k);
        });
      }
      if (before.bodyKids !== after.bodyKids) diff.push("appended to <body>");
      if (before.bodyClass !== after.bodyClass) diff.push("changed <body> class");
      if (diff.length) leaked.push(id + ": " + diff.join(", "));

      /* Reopening. The exercise leaves every module in the
         mounted-then-unmounted state, and the next thing that
         happens is somebody opening one. */
      const h2 = fakeElement("div");
      let e2 = null;
      try { await mod.mount(h2, context()); } catch (e) { e2 = e.message; }
      const s2 = shape(h2);
      try { if (mod.unmount) mod.unmount(); } catch (e) { /* below */ }

      if (e1 !== e2) {
        remountBroken.push(id + ": mount threw differently the second time (" +
          e1 + " -> " + e2 + ")");
      } else if (!e1) {
        if (s1.length !== s2.length) {
          remountBroken.push(id + ": reopened with " + s2.length + " nodes, first had " + s1.length);
        } else if (s1.join("\n") !== s2.join("\n")) {
          const i = s1.findIndex((x, n) => x !== s2[n]);
          remountBroken.push(id + ": differs at node " + i + " (" + s1[i] + " vs " + s2[i] + ")");
        }
      }
    }

    /* Settings and stray <body> nodes are what the exercise's
       restoreEnvironment() puts back. An empty list here means the
       safety net is not carrying anything. */
    ok("no module changes a setting or touches <body> outside its host",
      leaked.length === 0, leaked.join(" | "));
    ok("every module renders identically when reopened",
      remountBroken.length === 0, remountBroken.join(" | "));
  }

  section("nothing is still writing after it was unmounted");
  {
    /* Everything above has been mounted and unmounted twice. Any
       async work started at mount has had every opportunity to
       resolve into a panel that is gone. */
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 10));

    const real = stray.filter((m) => !/SKIPPED/.test(m));
    ok("no continuation threw into a panel that no longer exists",
      real.length === 0, real.slice(0, 3).join(" | "));
  }

  section("the guard behind that");
  {
    /* Tested directly, because both of its rules are easy to get
       wrong and the wrong version looks correct. */
    const a = FieldKit.mountGuard("probe");
    ok("a fresh mount's guard is alive", a() === true);

    const b = FieldKit.mountGuard("probe");
    ok("mounting again invalidates the older guard", a() === false);
    ok("and the newer one is alive", b() === true);

    /* The case the first version of this missed: closed, and
       nothing opened after it. The counter still matched, so the
       continuation sailed through and wrote into an emptied
       `nodes`. */
    b.end();
    ok("releasing on unmount invalidates it even with no newer mount", b() === false);
    ok("releasing twice is harmless", (b.end(), b() === false));

    const c = FieldKit.mountGuard("other-module");
    ok("guards are per module, not global", c() === true && b() === false);

    /* And the trap: reading the module-scope variable inside a
       continuation reads whichever mount is CURRENT, which always
       passes. Modules must capture it in a local. */
    const users = ["modules/selftest-panel.js", "modules/settings-panel.js",
      "modules/build-manifest.js"];
    users.forEach((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      ok(f.split("/").pop() + " claims a guard at mount", /mountGuard\(/.test(src));
      ok(f.split("/").pop() + " releases it at unmount", /alive\.end\(\)/.test(src));
      /* A guard checked but never captured is the broken version. */
      if (/if \(!alive\(\)\) return;/.test(src)) {
        ok(f.split("/").pop() + " captures the guard rather than reading it live", false,
          "uses alive() directly inside a continuation — capture it in a local first");
      } else {
        ok(f.split("/").pop() + " captures the guard rather than reading it live", true);
      }
    });
  }

  /* ---------------------------------------------------------------
     No stray control characters anywhere in the source.

     This has now cost real time twice, and both times it was silent.
     Editing these files from a Python heredoc turns `\b` in the
     replacement text into an actual backspace byte, because that is
     what `\b` means in a Python string. The result reads correctly
     in every editor and diff — a backspace renders as nothing — and
     the regex it lands in simply never matches again.

     Two live examples found by looking rather than by failing:
     `/\brate limited\b/i` in core/selftest.js, dead since whenever,
     so a rate-limit error without a numeric status went unrecognised;
     and `/<a\b[^>]*href/` in relay/browse.js, which scored a page of
     real search results as zero links and reported a working engine
     as broken.

     Tab, newline and carriage return are the only control characters
     with any business being in a source file.
     --------------------------------------------------------------- */
  section("no invisible control characters in the source");
  {
    const ALLOWED = new Set([0x09, 0x0a, 0x0d]);
    const roots = ["core", "modules", "relay", "tools", "tests"];
    const offenders = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + "/" + entry.name;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "data" ||
              entry.name.endsWith("-bin")) continue;
          walk(rel);
          continue;
        }
        if (!/\.(js|json|md)$/.test(entry.name)) continue;
        const buf = fs.readFileSync(path.join(ROOT, rel));
        for (let i = 0; i < buf.length; i++) {
          const b = buf[i];
          if (b < 0x20 && !ALLOWED.has(b)) {
            const line = buf.slice(0, i).toString("utf8").split("\n").length;
            offenders.push(rel + ":" + line + " has 0x" + b.toString(16).padStart(2, "0"));
            break;                       // one report per file is enough to act on
          }
        }
      }
    };
    roots.forEach((r) => { if (fs.existsSync(path.join(ROOT, r))) walk(r); });

    ok("nothing in the tree carries a control character",
      offenders.length === 0, offenders.join("; "));

    /* And the two that were actually broken, by name, so a
       reintroduction says which regex died rather than only that
       something somewhere did. */
    const selftest = fs.readFileSync(path.join(ROOT, "core/selftest.js"), "utf8");
    ok("selftest's rate-limit regex has real word boundaries",
      selftest.indexOf("/\\brate limited\\b/i") >= 0);
    const browse = fs.readFileSync(path.join(ROOT, "relay/browse.js"), "utf8");
    ok("browse's link counter has a real word boundary",
      /<a\\b\[\^>\]/.test(browse));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + (e.stack || e.message));
  process.exit(1);
});
