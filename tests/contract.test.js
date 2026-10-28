/* ============================================================
   Module contract + self-test coverage.

   The point of this suite is to make the FULL SYSTEM EXERCISE
   self-maintaining. If a new module ships without a selfcheck(),
   this fails — so "the exercise tests everything" stays true
   instead of quietly rotting as features are added.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("contract");

const ROOT = path.join(__dirname, "..");
const MODULE_DIR = path.join(ROOT, "modules");

/* Read the boot manifest rather than guessing — this also proves the
   manifest and the filesystem have not drifted apart. */
const html = fs.readFileSync(path.join(ROOT, "FIELDKIT.html"), "utf8");
const manifest = /window\.FK_BOOT_MANIFEST\s*=\s*\[([\s\S]*?)\]/.exec(html)[1]
  .split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

section("boot manifest");
{
  const missing = manifest.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  ok("every manifest entry exists on disk", missing.length === 0, missing.join(", "));

  const onDisk = []
    .concat(fs.readdirSync(path.join(ROOT, "core")).map((f) => "core/" + f))
    .concat(fs.readdirSync(MODULE_DIR).map((f) => "modules/" + f))
    .filter((f) => f.endsWith(".js"));
  /* A file counts as wired up if ANY build boots it. OUTPOST
     (§14.1) has its own manifest and its own store, boot and
     settings module, and none of those belong in the full build's
     list — but a file in neither list is still what this check
     exists to catch: something written and never hooked up. */
    const outHtml = fs.readFileSync(path.join(ROOT, "OUTPOST.html"), "utf8");
    const outpost = /window\.FK_BOOT_MANIFEST\s*=\s*\[([\s\S]*?)\]/.exec(outHtml)[1]
      .split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const booted = new Set(manifest.concat(outpost));

    const orphans = onDisk.filter((f) => !booted.has(f));
    ok("no core or module file is missing from every manifest", orphans.length === 0,
      "orphaned: " + orphans.join(", "));

    /* The OUTPOST files must not creep into the full build either —
       two stores registering the same service is a coin flip over
       whether the vault or the plaintext one wins. */
    const bothStores = manifest.includes("core/store.js") && manifest.includes("core/store-outpost.js");
    const bothBoots = manifest.includes("core/boot.js") && manifest.includes("core/boot-outpost.js");
    ok("the full build has exactly one store and one boot sequence",
      !bothStores && !bothBoots);
    ok("and OUTPOST does too",
      !(outpost.includes("core/store.js") && outpost.includes("core/store-outpost.js")) &&
      !(outpost.includes("core/boot.js") && outpost.includes("core/boot-outpost.js")));

  ok("kernel loads first", manifest[0] === "core/kernel.js", manifest[0]);
  ok("boot loads after every core service it starts",
    manifest.indexOf("core/boot.js") > manifest.indexOf("core/shell.js") &&
    manifest.indexOf("core/boot.js") > manifest.indexOf("core/lockscreen.js") &&
    manifest.indexOf("core/boot.js") > manifest.indexOf("core/guest.js"));
  ok("every module loads after core/boot.js",
    manifest.filter((f) => f.startsWith("modules/"))
      .every((f) => manifest.indexOf(f) > manifest.indexOf("core/boot.js")));
}

/* Load the whole manifest under the fake window. Modules register
   themselves, which is what lets us inspect the real contract rather
   than a regex over source. */
section("registration");
let FieldKit, loadError = null;
try {
  FieldKit = bootstrap(manifest);
} catch (e) {
  loadError = e;
}
ok("the full manifest loads without throwing", !loadError, loadError && loadError.message);

if (loadError) {
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail));
  process.exit(1);
}

const mods = FieldKit.modules();
const ids = Object.keys(mods).sort();
const moduleFiles = fs.readdirSync(MODULE_DIR).filter((f) => f.endsWith(".js"));

/* OUTPOST has a few panels of its own (its SETTINGS, its RELAY LINK),
   not loaded here; that no file is in neither build is checked above. */
const fullModuleFiles = manifest.filter((f) => f.startsWith("modules/"));
ok("every module file registered a module", ids.length >= fullModuleFiles.length,
  ids.length + " registered vs " + fullModuleFiles.length + " files");
ok("no module failed to load", Object.keys(FieldKit.failedModules()).length === 0);
console.log("        registered: " + ids.join(", "));

section("module contract");
{
  const noMount = ids.filter((id) => typeof mods[id].mount !== "function");
  ok("every module has mount()", noMount.length === 0, noMount.join(", "));

  const noUnmount = ids.filter((id) => typeof mods[id].unmount !== "function");
  ok("every module has unmount()", noUnmount.length === 0, noUnmount.join(", "));

  const noTitle = ids.filter((id) => !mods[id].title || !mods[id].icon);
  ok("every module has a title and an icon", noTitle.length === 0, noTitle.join(", "));

  /* The launcher draws one labelled section per group. A module
     with no group, or with a group the launcher does not order,
     still appears — it lands in an unordered section at the end —
     but that is a slow drift back toward the flat alphabetical
     wall the grouping replaced, so it is caught here instead. */
  const LAUNCHER_GROUPS = ["ONLINE", "FILES", "PROJECT", "SERVERS", "TOOLS", "SYSTEM"];
  const ungrouped = ids.filter((id) => !mods[id].group);
  ok("every module declares a group", ungrouped.length === 0, ungrouped.join(", "));

  const strayGroup = ids.filter((id) =>
    mods[id].group && LAUNCHER_GROUPS.indexOf(String(mods[id].group).toUpperCase()) < 0);
  ok("no module invents a group the launcher does not order",
    strayGroup.length === 0,
    strayGroup.map((id) => id + "=" + mods[id].group).join(", "));

  /* A group holding half the console is the wall again with one
     heading on it. Six of thirty-one is roughly the ceiling where
     a section is still scannable at a glance. */
  const sizes = {};
  ids.forEach((id) => {
    const g = String(mods[id].group || "?").toUpperCase();
    sizes[g] = (sizes[g] || 0) + 1;
  });
  const bloated = Object.keys(sizes).filter((g) => sizes[g] > 8);
  ok("no group has grown past eight modules", bloated.length === 0,
    bloated.map((g) => g + "=" + sizes[g]).join(", "));

  /* The desktop's search finds an app by what it does (§21), from
     these. An app without them can still be found by name, which is
     exactly how "it isn't very easy to find stuff" started. */
  const noAbout = ids.filter((id) => !mods[id].inside &&
    (typeof mods[id].about !== "string" || mods[id].about.length < 12 || typeof mods[id].keywords !== "string"));
  ok("every app with a tile says what it does, and the words it is looked for by", noAbout.length === 0, noAbout.join(", "));

  const badGuest = ids.filter((id) => "guestSafe" in mods[id] && typeof mods[id].guestSafe !== "boolean");
  ok("guestSafe, where present, is a boolean", badGuest.length === 0, badGuest.join(", "));

  const badIndex = ids.filter((id) =>
    "searchIndex" in mods[id] && typeof mods[id].searchIndex !== "function");
  ok("searchIndex, where present, is a function", badIndex.length === 0, badIndex.join(", "));
}

/* ---- the rule that keeps the exercise honest ---- */
section("self-test coverage");
{
  const missing = ids.filter((id) => typeof mods[id].selfcheck !== "function");
  ok("EVERY registered module ships a selfcheck()", missing.length === 0,
    "missing on: " + missing.join(", ") + " — see FIELDKIT_PROJECT.md §10F");

  /* selfcheck() is called with the sandbox api; it must build its
     check list without touching module state that only exists after
     mount, or the exercise cannot even enumerate what it will run. */
  const stubApi = {
    sandbox: { track: (x) => x, put: async () => ({ id: "x" }), onCleanup: () => {}, host: () => null },
    host: () => null,
    probeType: "selftest-probe",
    preview: (s) => String(s)
  };

  let built = 0, broken = [];
  for (const id of ids) {
    if (typeof mods[id].selfcheck !== "function") continue;
    try {
      const checks = mods[id].selfcheck(stubApi);
      if (!Array.isArray(checks) || !checks.length) { broken.push(id + " (returned nothing)"); continue; }
      const bad = checks.find((c) => !c || typeof c.name !== "string" || typeof c.run !== "function");
      if (bad) { broken.push(id + " (malformed check)"); continue; }
      built += checks.length;
    } catch (e) {
      broken.push(id + " (threw: " + e.message + ")");
    }
  }
  ok("selfcheck() builds its check list without mounting", broken.length === 0, broken.join("; "));
  ok("modules contribute a meaningful number of probes", built >= 15, built + " probes");
  console.log("        " + built + " module probes across " + ids.length + " modules");
}

/* ---- the exercise suite itself ---- */
section("exercise suite composition");
{
  const st = FieldKit.need("selftest");
  ok("runExercise is exposed", typeof st.runExercise === "function");
  ok("asText is exposed for plain-text export", typeof st.asText === "function");
  ok("a premade AI prompt is defined", !!(st.AI_PROBE && st.AI_PROBE.prompt && st.AI_PROBE.expect));

  const sb = st._makeSandbox();
  const groups = st._buildExercise(sb);
  const flat = groups.reduce((a, g) => a.concat(g.checks.map((c) => ({ ...c, group: g.title }))), []);

  ok("the exercise builds a suite", flat.length > 0);
  console.log("        " + groups.length + " groups, " + flat.length + " checks");

  const titles = groups.map((g) => g.title);
  for (const want of ["PLATFORM", "CRYPTO", "STORE", "NETWORK", "AI", "ENGINES", "SECURITY", "INTERFACE"]) {
    ok("covers " + want, titles.includes(want), titles.join(" | "));
  }

  ok("every registered module gets its own group",
    ids.every((id) => titles.some((t) => t === "MODULE :: " + (mods[id].title || id))),
    titles.filter((t) => t.startsWith("MODULE")).join(" | "));

  ok("the AI group sends a real message",
    flat.some((c) => c.group === "AI" && /PREMADE MESSAGE/.test(c.name)));
  ok("the AI group verifies the heuristic floor separately",
    flat.some((c) => c.group === "AI" && /TIER 3 FLOOR/.test(c.name)));

  const names = flat.map((c) => c.group + "::" + c.name);
  ok("no two checks share a group and a name", new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(", "));
  ok("every check is runnable", flat.every((c) => typeof c.run === "function"));
  ok("the suite is substantial", flat.length >= 70, flat.length + " checks");
}

/* ---- plain-text export ---- */
section("plain-text report");
{
  const st = FieldKit.need("selftest");
  const report = {
    at: "2026-08-12T09:00:00.000Z", suite: "exercise", totalMs: 4210,
    passed: 2, failed: 1, skipped: 1, criticalFailed: 1, online: true,
    device: { platform: "Linux", cores: 4, memory: 4, origin: "file://", version: FieldKit.VERSION },
    results: [
      { name: "ONE", group: "ALPHA", pass: true, detail: "fine", critical: false, ms: 3 },
      { name: "TWO", group: "ALPHA", pass: true, detail: "also fine", critical: false, ms: 4 },
      { name: "THREE", group: "BETA", pass: false, detail: "it broke", critical: true, ms: 5 },
      { name: "FOUR", group: "BETA", pass: true, skipped: true, detail: "SKIPPED — n/a", critical: false, ms: 0 }
    ]
  };
  const text = st.asText(report);
  ok("starts with a recognisable header", text.startsWith("FIELDKIT SELF-TEST REPORT"));
  ok("records the device and build", text.includes("Linux") && text.includes(FieldKit.VERSION));
  ok("groups the results", text.includes("-- ALPHA") && text.includes("-- BETA"));
  ok("marks each state distinctly",
    /\bPASS\b/.test(text) && /\bFAIL\b/.test(text) && /\bSKIP\b/.test(text));
  ok("repeats failures in a summary block", text.includes("NEEDS ATTENTION") &&
    text.lastIndexOf("it broke") > text.indexOf("NEEDS ATTENTION"));
  ok("is plain text with no markup", !/<[a-z/]/i.test(text));
}

/* ============================================================
   The language is whole before any window is opened.

   TERMINAL used to register `say`, `read`, `help` and the rest
   inside mount(), so they did not exist until somebody had opened
   that window. Everything inside the terminal still worked —
   opening it is what registered them — so the hole was invisible
   from there. It showed up everywhere else that reads the registry:
   CRITTERSCRIPT listed a short command set, its selfcheck failed
   because its own documented recipes used commands that "did not
   exist", and its EXPORT — the artifact whose entire purpose is to
   be the complete specification — silently omitted them.

   This suite bootstraps the manifest and mounts nothing, which is
   exactly the state that used to be wrong.
   ============================================================ */
(async function () {
section("the command registry is complete without opening anything");
{
  const cs = FieldKit.service("critterscript");
  ok("the language loaded", !!cs);

  const names = cs.list().map((c) => c.name);
  /* One from each place commands come from, so a regression in any
     of the three registration sites is named rather than showing up
     as a count that moved. */
  const fromCore = ["list", "count", "sort", "field", "json"];
  const fromNet = ["fetch", "find", "ask", "sum-up", "services", "uptime"];
  const fromTerminal = ["say", "read", "help", "run", "note", "records"];

  [["core", fromCore], ["the networked set", fromNet], ["TERMINAL", fromTerminal]]
    .forEach(function (pair) {
      const missing = pair[1].filter((n) => names.indexOf(n) < 0);
      ok("commands from " + pair[0] + " are registered", missing.length === 0,
        missing.join(", "));
    });

  /* The one the documentation leans on hardest: it is in the second
     of the three rules and in the before/after that explains what
     the pipe changed. It did not exist until this was fixed. */
  ok("read exists, because the three rules use it as an example",
    !!cs.get("read"));
  /* Behaviour, not source. `read` has to ANSWER rather than print,
     or `read notes | count` — the example in the second of the
     three rules — cannot work: the pipe refuses a step with no
     answer, by design and with a message saying so. */
  FieldKit.provide("store", {
    isUnlocked: () => true,
    async list(t) {
      return t === "note"
        ? [{ id: "n1", meta: { id: "n1", type: "note" },
             data: { title: "notes", body: "one two three" } }]
        : [];
    }
  }, { replace: true });
  const piped = [];
  await cs.run("read notes | words | count", { print: (x) => piped.push(String(x)) });
  ok("read answers rather than prints, so the documented pipe works",
    piped.join("") === "3", piped.join(" | "));

  const ref = FieldKit.service("critterRef");
  ok("the reference module is loaded", !!ref);
  const md = ref.markdown();
  const absent = cs.list().filter((c) => md.indexOf("`" + c.name + "`") < 0)
    .map((c) => c.name);
  ok("the markdown export carries every registered command, unmounted",
    absent.length === 0, absent.join(", "));

  /* The tokenizer reads a token that starts with a digit as a
     number, so a bare 2026-08-21 is arithmetic. That is not going to
     change — division and glued negatives depend on it — so the
     reference has to say it out loud, or the only way to find out is
     to paste a date into a command and watch it come apart. */
  ok("the reference warns that a date needs quoting",
    /2026-08-21/.test(md) && /[Qq]uote/.test(md));

  const json = JSON.parse(ref.json());
  ok("and so does the json", json.commands.length === cs.list().length,
    json.commands.length + " vs " + cs.list().length);

  /* The reference's own checks, run here rather than only in the
     browser, because the failure they catch is invisible on screen:
     a complete-looking list that is missing a third of itself. */
  const def = mods["critter-ref"];
  for (const c of def.selfcheck({})) {
    let detail = "", passed = true;
    try { detail = c.run(); }
    catch (e) { passed = /^SKIPPED/.test(e.message); detail = e.message; }
    ok("reference selfcheck: " + c.name, passed, String(detail));
  }
}

/* ============================================================
   The manual can quote the language it documents.

   MANUAL's plain-text export check used to reject any angle
   bracket on the grounds that markup must not reach a .txt file.
   Then the scripting sections arrived, and CritterScript names an
   answer with `->` — the third of its three rules — while every
   usage line reads `read <name>`. The check failed on the manual's
   own correct content, which is the kind of failure that teaches
   people to ignore a red line.

   The guard still matters, so it is now by tag name. Both halves
   are asserted here: the arrow passes, a real <div> does not.
   ============================================================ */
section("the manual exports as plain text without banning its own notation");
{
  const def = mods["help"];
  ok("MANUAL is registered", !!def);

  const checks = def.selfcheck(FieldKit.context());
  const exportCheck = checks.filter((c) => /PLAIN TEXT EXPORT/.test(c.name))[0];
  ok("the export check exists", !!exportCheck);

  let detail = "", passed = true;
  try { detail = await exportCheck.run(); }
  catch (e) { passed = false; detail = e.message; }
  ok("the export check passes on the real manual", passed, String(detail));

  /* The line the fix turns on, tested directly rather than through
     the module, so a future loosening that lets <div> through is
     named here instead of discovered in a shipped export. */
  const TAG = /<\/?(?:a|b|i|p|br|hr|em|ul|ol|li|h[1-6]|div|span|pre|code|strong|table|tr|td|th|img|script|style)\b[^>]*>/i;
  ok("the arrow that names an answer is not markup", !TAG.test("split \"a,b\" , | count -> $n"));
  ok("and neither is a usage placeholder", !TAG.test("read <name>"));
  ok("a real tag still is", TAG.test("a <div class=x>leak</div>"));
  ok("and so is a bare one", TAG.test("line<br>break"));
}

console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
process.exit(state.fail ? 1 : 0);
})().catch(function (e) {
  console.log("\nSUITE CRASHED: " + (e.stack || e.message));
  console.log("RESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});
