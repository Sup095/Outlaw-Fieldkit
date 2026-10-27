/* ============================================================
   PREFLIGHT.html

   The pre-boot gate. It runs on a machine nobody trusts, so the
   two things worth testing are the two that decide whether the
   user walks away from that machine:

     - the drive manifest it verifies against must be reproducible
       character for character, or every drive check cries wolf;
     - the "files that should not be here" classifier must not fire
       on the app's own hundreds of .js files, or the blocking
       verdict becomes something you click past.

   The page's code is extracted and evaluated here rather than
   copied, so these assertions are about the shipped file.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ROOT, bootstrap, makeRunner, fakeElement } = require("./harness");
const { ok, section, state } = makeRunner("preflight");

const PAGE = path.join(ROOT, "PREFLIGHT.html");
const html = fs.readFileSync(PAGE, "utf8");

/* ---- pull the page's script out and give it a DOM to load into -- */
bootstrap(["core/kernel.js"]);   // sets up window/document/localStorage/crypto

const IDS = ["out", "btnRun", "btnDrive", "btnRelay", "btnCopy", "btnSave",
  "ackChk", "btnLaunch", "verdict", "verdictBig", "verdictWhy",
  "ackBox", "ackText", "launchNote", "relayUrl", "fpBox", "fpVal", "fpNote",
  "tally", "report", "cPASS", "cFAIL", "cWARN", "cINFO", "cSKIP"];
IDS.forEach((id) => {
  const el = fakeElement("div");
  el.setAttribute("id", id);
  document.body.appendChild(el);
});

const scriptSrc = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1];

let PF = null, loadError = null;
try {
  PF = new Function(scriptSrc + `
    ;return { SUSPICIOUS, suspicionFor, BENIGN_DIRS, isNative, GROUPS,
              FK_PREFIX, FK_DB, sha256, hex, errStr, guard };`)();
} catch (e) {
  loadError = e;
}

(async function () {
  section("the page loads at all");
  {
    ok("there is exactly one script block", (html.match(/<script>/g) || []).length === 1);
    ok("it parses and runs", !loadError, loadError && loadError.message);
    if (!PF) {
      console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
      process.exit(1);
    }
    ok("it declares the sections it promises",
      PF.GROUPS.length === 6 && PF.GROUPS[0] === "THIS MACHINE", PF.GROUPS.join(" | "));
  }

  /* The whole file is the thing that vouches for the others, so it
     cannot lean on them. */
  section("it is self-contained");
  {
    ok("no external stylesheet or script", !/<link\b|<script[^>]+src=/i.test(html));

    /* The only two requests this page may ever make, and both only
       after the user typed a relay URL and pressed the button. A
       third fetch target appearing here is a page that phones
       somewhere from a machine the user does not trust. */
    const targets = (scriptSrc.match(/fetch\(\s*([^,)]+)/g) || [])
      .map((f) => f.replace(/^fetch\(\s*/, "").trim());
    ok("it makes exactly two kinds of request, both to the relay the user typed",
      targets.length === 2 &&
      targets.every((t) => t.startsWith("base +")) &&
      targets.join(" ").includes('"/health"') &&
      targets.join(" ").includes('"/vault"'),
      targets.join(" | "));
    ok("both live inside checkRelay, which only a button press reaches",
      (scriptSrc.split("async function checkRelay")[1] || "").split("async function checkCapability")[0]
        .match(/fetch\(/g).length === 2);
  }

  /* It runs on a machine the user does not trust, and it must not
     make that machine a worse place to have plugged the drive in. */
  section("it leaves nothing behind");
  {
    const writes = scriptSrc.match(/localStorage\.setItem\([^)]*\)/g) || [];
    ok("the only thing it writes to localStorage is its own probe key",
      writes.length === 1 && writes[0].includes("__fk_pf"), writes.join(" | "));
    ok("and it removes that key again", /localStorage\.removeItem\("__fk_pf"\)/.test(scriptSrc));

    const dbs = scriptSrc.match(/indexedDB\.open\([^)]*\)/g) || [];
    ok("the only database it opens is its own probe",
      dbs.every((d) => d.includes("__fk_pf")), dbs.join(" | "));
    ok("and it deletes that database again", /deleteDatabase\("__fk_pf"\)/.test(scriptSrc));

    ok("the relay URL is never persisted",
      !/setItem\([^)]*relay/i.test(scriptSrc));

    /* It must never be a place someone types a secret. There is no
       password field, and the only input it reads is the relay URL. */
    ok("there is no password field on the page", !/type\s*=\s*["']password["']/i.test(html));
    const reads = [...scriptSrc.matchAll(/getElementById\("([^"]+)"\)\.value/g)].map((m) => m[1]);
    ok("the only value it reads from the page is the relay URL and its own report",
      reads.every((id) => id === "relayUrl" || id === "report"), reads.join(", "));

    /* And it must not go near the vault's own machinery: no record
       routes, no auth header, no token. GET /vault returns only the
       wrapped header and is unauthenticated by design, which is why
       that one is allowed. */
    ok("it never calls an authenticated relay route",
      !/Authorization|Bearer|X-FieldKit-Provision|\/records/.test(scriptSrc));
  }

  section("what counts as a file that should not be here");
  {
    const S = PF.suspicionFor;
    const hard = (p) => { const h = S(p); return !!h && !!h.hard; };
    const soft = (p) => { const h = S(p); return !!h && !h.hard; };

    ok("autorun.inf at the root is a hard stop", hard("autorun.inf"));
    ok("a loose .exe is a hard stop", hard("setup.exe"));
    ok("an .exe buried in a folder is still a hard stop", hard("core/helper.exe"));
    ok("a .lnk shortcut is a hard stop", hard("Documents.lnk"));
    ok("a loose script at the root is a hard stop", hard("readme.js"));

    /* The cry-wolf test. The drive is mostly .js; if these fire,
       the blocking verdict is worthless. */
    ok("core/kernel.js is not flagged", S("core/kernel.js") === null);
    ok("modules/task-board.js is not flagged", S("modules/task-board.js") === null);
    ok("vendor/web-llm.js is not flagged", S("vendor/web-llm.js") === null);
    ok("FIELDKIT.html is not flagged", S("FIELDKIT.html") === null);
    ok("a note the user saved is not flagged", S("exports/notes-2026-08.txt") === null);

    ok("desktop.ini is evidence, not an attack", soft("desktop.ini"));
    ok("Thumbs.db is evidence, not an attack", soft("Thumbs.db"));
    ok("a macOS resource fork is evidence, not an attack", soft("._FIELDKIT.html"));

    ok("Windows' own folders are skipped, not reported",
      ["System Volume Information", "$RECYCLE.BIN", "RECYCLER", "found.000"]
        .every((d) => PF.BENIGN_DIRS.test(d)));
    ok("a folder that merely looks like one is not skipped",
      !PF.BENIGN_DIRS.test("System Volume Information Backup"));
  }

  section("tamper detection");
  {
    ok("a real browser method reads as native", PF.isNative(Math.max) === true);
    ok("a wrapper does not", PF.isNative(function () { return Math.max(); }) === false);
    /* The evasion the naive check misses. A bound function reports
       "[native code]" in every engine, so `subtle.encrypt =
       steal.bind(null)` would look untouched on toString alone. */
    ok("a bound wrapper stringifies as native — which is why toString alone is not enough",
      /\[native code\]/.test(Function.prototype.toString.call(Math.max.bind(Math))));
    ok("and it is caught anyway", PF.isNative(Math.max.bind(Math)) === false);
    ok("a function whose own toString lies is still caught",
      PF.isNative((() => { const f = function () {}; f.toString = () => "function(){ [native code] }"; return f; })()) === false);
    ok("a non-function is reported as absent rather than patched",
      PF.isNative(undefined) === null && PF.isNative(null) === null);
  }

  section("the drive manifest");
  {
    const manPath = path.join(ROOT, "drive-manifest.json");
    /* Not committed — it describes one particular copy of the
       payload. Skipped rather than failed when absent, but loudly,
       because everything in this section is unverified without it. */
    if (!fs.existsSync(manPath)) {
      console.log("  ....  SKIPPED — no drive-manifest.json here.");
      console.log("        Run `node build.js` first; this whole section is unchecked without it.");
      return honesty();
    }

    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    ok("it names its algorithm", man.algorithm === "SHA-256", man.algorithm);
    ok("it does not list itself", !man.files["drive-manifest.json"]);
    ok("it lists PREFLIGHT itself", !!man.files["PREFLIGHT.html"]);
    ok("it lists the app entry point", !!man.files["FIELDKIT.html"]);

    /* Every script FIELDKIT.html boots must be covered, or a
       modified core file would sail through the drive check. */
    const entry = fs.readFileSync(path.join(ROOT, "FIELDKIT.html"), "utf8");
    const boot = (/window\.FK_BOOT_MANIFEST\s*=\s*\[([\s\S]*?)\]/.exec(entry)[1])
      .split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const uncovered = boot.filter((f) => !man.files[f]);
    ok("every boot-manifest script is covered by the manifest",
      uncovered.length === 0, uncovered.join(", "));

    /* The parity that matters: PREFLIGHT recomputes the fingerprint
       by parsing this file and re-serialising it. If Node's writer
       and the browser's reader ever disagree about key order or
       spacing, every drive on earth reports as tampered with. */
    const body = { algorithm: man.algorithm, version: man.version, files: man.files };
    const round = JSON.stringify(body, null, 1);
    const recomputed = crypto.createHash("sha256").update(round).digest("hex");
    ok("the fingerprint survives a parse-and-reserialise round trip",
      recomputed === man.fingerprint,
      "stated " + String(man.fingerprint).slice(0, 16) + ", recomputed " + recomputed.slice(0, 16));

    const viaSubtle = await PF.sha256(new TextEncoder().encode(round));
    ok("and the page's own hash function agrees with build.js",
      viaSubtle === man.fingerprint, viaSubtle.slice(0, 16));

    /* Hashes have to actually describe the files. One spot check
       against a file that is definitely on the drive. */
    const target = "core/kernel.js";
    const real = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(ROOT, target))).digest("hex");
    ok("a listed hash matches the file it names",
      man.files[target] && man.files[target].sha256 === real);
    ok("and so does the size",
      man.files[target].size === fs.statSync(path.join(ROOT, target)).size);
  }

  honesty();

  function honesty() {
  section("the honesty rules");
  {
    /* These are load-bearing. A gate that overstates its reach gets
       someone to unlock a vault on a machine they would otherwise
       have walked away from, which is worse than having no gate. */
    ok("the page states what it cannot see", /WHAT THIS CANNOT SEE/.test(html));
    ok("it says plainly that it cannot detect a keylogger",
      /keylogger/i.test(html));
    ok("it says a clean result is not a guarantee",
      /not a promise|is not a guarantee|proves nothing/i.test(html));
    ok("a blocking verdict points at guest mode as the way out",
      /guest/i.test(html.split("DO NOT UNLOCK THE VAULT HERE")[1] || ""));
    ok("proceeding past a caution needs an explicit tick",
      /ackChk/.test(scriptSrc) && /launch\.disabled = !ackChk\.checked/.test(scriptSrc));
    ok("an unrun drive or relay check never reads as a pass",
      /driveChecked/.test(scriptSrc) && /unrun\.push/.test(scriptSrc));
  }

    console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
    if (state.failures.length) {
      console.log("\nFAILURES:");
      state.failures.forEach((f) => console.log("  - " + f));
    }
    process.exit(state.fail ? 1 : 0);
  }
})().catch((e) => {
  console.error("SUITE CRASHED: " + (e.stack || e.message));
  process.exit(1);
});
