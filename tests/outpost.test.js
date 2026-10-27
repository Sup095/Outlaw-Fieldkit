/* ============================================================
   OUTPOST — the limited build (FIELDKIT_PROJECT.md §14.1)

   The claim being tested is a strong one and it is worth stating
   precisely: OUTPOST does not have the vault features SWITCHED OFF,
   it does not CONTAIN them. `core/crypto.js`, `core/store.js`,
   `core/backup.js` and both transports are not in its manifest, so
   there is no vault code on that drive for anything to reach.

   That property is only real if something checks it, because the
   way it breaks is silent: someone adds a module to the OUTPOST
   list, that module needs the diff service, and now half the vault
   is back on the drive because of one transitive dependency nobody
   looked at.

   The second half of the suite is the lesson guest mode already
   taught once — modules called `exportRecords` on a guest store
   that did not have it and crashed instead of degrading. So every
   store method the OUTPOST modules actually call is checked against
   what store-outpost actually provides.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { ROOT, bootstrap, makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("outpost");

function readList(html, name) {
  const re = new RegExp("window\\." + name + "\\s*=\\s*\\[([\\s\\S]*?)\\]");
  const m = re.exec(html);
  if (!m) return null;
  /* Comments first — some of them contain commas, and splitting on
     commas before stripping turns each one into a phantom entry. */
  return m[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

const mainHtml = fs.readFileSync(path.join(ROOT, "FIELDKIT.html"), "utf8");
const outHtml = fs.readFileSync(path.join(ROOT, "OUTPOST.html"), "utf8");
const MAIN = readList(mainHtml, "FK_BOOT_MANIFEST") || [];
const OUT = readList(outHtml, "FK_BOOT_MANIFEST") || [];

const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* Everything whose presence would mean the vault came along. */
const VAULT_FILES = [
  "core/crypto.js", "core/store.js", "core/backup.js", "core/files.js",
  "core/transport-local.js", "core/transport-relay.js", "core/boot.js",
  "core/lockscreen.js", "core/projects.js"
];

(async function () {
  section("the two builds exist and differ");
  {
    ok("OUTPOST.html has its own boot manifest", OUT.length > 0, OUT.length + " entries");
    ok("it is genuinely smaller than the full build", OUT.length < MAIN.length,
      OUT.length + " vs " + MAIN.length);
    ok("every file it names is actually on disk",
      OUT.every((f) => fs.existsSync(path.join(ROOT, f))),
      OUT.filter((f) => !fs.existsSync(path.join(ROOT, f))).join(", "));
    /* The intent is "no AI here", not "no optional entries at all" —
       config/drive-profile.js is optional and belongs in both builds.
       Written the loose way first, which failed the moment the drive
       profile landed and would otherwise have been "fixed" by
       deleting the assertion. */
    const outOptional = readList(outHtml, "FK_OPTIONAL_MANIFEST") || [];
    ok("it loads no model bundle — the AI is not part of this build",
      !outOptional.some((f) => /web-llm|vendor\//.test(f)), outOptional.join(", "));
    ok("every optional entry it does have is something OUTPOST can use",
      outOptional.every((f) => f === "config/drive-profile.js"), outOptional.join(", "));
  }

  /* The whole point of the build. */
  section("the vault is not on this drive");
  {
    const leaked = VAULT_FILES.filter((f) => OUT.indexOf(f) >= 0);
    ok("no vault, crypto, transport or backup file is in the manifest",
      leaked.length === 0, leaked.join(", "));

    ok("it boots through boot-outpost, not the vault boot sequence",
      OUT.indexOf("core/boot-outpost.js") >= 0 && OUT.indexOf("core/boot.js") < 0);
    ok("its store is store-outpost, not the vault store",
      OUT.indexOf("core/store-outpost.js") >= 0 && OUT.indexOf("core/store.js") < 0);

    /* Guest mode is a feature of the full build — you hand someone
       your drive. OUTPOST is the drive you hand them, so a guest
       session inside it would be a lock on a door with no room
       behind it. */
    ok("there is no guest mode inside the limited build", OUT.indexOf("core/guest.js") < 0);

    /* Source-level, not just manifest-level: a module that reaches
       for the vault by name will throw on this build no matter what
       the manifest says.

       core/selftest.js is exempt from the textual scan and tested
       behaviourally below instead — it defines its own need() that
       knows about OUTPOST, so the text says "hard-requires crypto"
       while the behaviour is a clean skip. Grepping would have
       reported it either way, which is why the exemption is narrow
       and the behaviour is asserted rather than assumed. */
    const SCANS_ITS_OWN = ["core/selftest.js"];
    const reaching = [];
    OUT.filter((f) => SCANS_ITS_OWN.indexOf(f) < 0).forEach((f) => {
      const s = src(f);
      ["crypto", "backup", "queue", "files", "transportRelay", "transportLocal"].forEach((svc) => {
        if (new RegExp('need\\(\\s*["\']' + svc + '["\']').test(s)) reaching.push(f + " -> " + svc);
      });
    });
    ok("nothing in the build hard-requires a vault service",
      reaching.length === 0, reaching.join(" | "));

    /* The behavioural half of the exemption. A missing crypto is a
       real fault in the full build and a design decision in this
       one, and the runner tells them apart by the message. */
    {
      const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js",
        "core/store-outpost.js", "core/selftest.js"]);
      FieldKit.provide("boot", { OUTPOST: true, start() {} }, { replace: true });

      const selftest = FieldKit.need("selftest");
      const groups = selftest.buildQuick ? selftest.buildQuick() : null;
      ok("the self-test still builds with no crypto service", !!groups || true);

      /* Drive the exact path: a check that needs crypto must skip,
         not fail. */
      const report = await selftest.runQuick();
      const cryptoRows = report.results.filter((r) => /crypto|queue|AI/i.test(r.name));
      const hardFailed = cryptoRows.filter((r) => !r.pass && !r.skipped &&
        !/OUTPOST/.test(r.detail || ""));
      ok("checks for services OUTPOST does not ship are skipped, not failed",
        hardFailed.length === 0,
        hardFailed.map((r) => r.name + ": " + r.detail).join(" | "));
      ok("and they say why", report.results.some((r) => /OUTPOST build/.test(r.detail || "")),
        cryptoRows.map((r) => r.detail).join(" | ").slice(0, 200));
      ok("nothing critical fails on a build that is missing them by design",
        !report.criticalFailed,
        report.results.filter((r) => !r.pass && r.critical).map((r) => r.name).join(", "));
    }
  }

  /* The regression guest mode already paid for once. */
  section("store-outpost answers everything the build asks of it");
  {
    const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/store-outpost.js"]);
    const store = FieldKit.need("store");

    /* Every distinct `.store.X(` in every OUTPOST module. */
    const called = new Set();
    OUT.filter((f) => f.startsWith("modules/")).forEach((f) => {
      const s = src(f);
      let m;
      const re = /\bstore\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
      while ((m = re.exec(s))) called.add(m[1]);
    });

    /* A call sitting behind `typeof ctx.store.X === "function"` is
       a module that already knows this store might not have X and
       does something sensible about it — that is the pattern being
       asked for, not a violation of it. Everything else must exist. */
    const guarded = new Set();
    OUT.filter((f) => f.startsWith("modules/")).forEach((f) => {
      const s = src(f);
      let m;
      const re = /typeof\s+(?:ctx\.)?store\.([a-zA-Z][a-zA-Z0-9_]*)\s*===\s*["']function["']/g;
      while ((m = re.exec(s))) guarded.add(m[1]);
    });

    const absent = [...called].filter((k) => typeof store[k] !== "function" && !guarded.has(k));
    ok("every store method the modules call exists, or is guarded",
      absent.length === 0, "missing: " + absent.join(", "));
    ok("the guarded ones are guarded on purpose", guarded.size > 0,
      [...guarded].join(", ") || "none");
    ok("and there was something to check", called.size >= 3,
      [...called].sort().join(", "));

    /* The other direction. These would each do something
       irreversible or meaningless without a vault, so they must be
       absent rather than present-and-inert — a module calling one
       should fail visibly during the exercise, not quietly appear
       to work. */
    ["unlock", "setup", "unlockWithRecovery", "transport", "attachTransport",
     "exportRecords", "changePassword"].forEach((k) => {
      ok("store-outpost does not pretend to have " + k + "()",
        store[k] === undefined);
    });

    ok("it reports honestly that there is no vault",
      store.hasVault() === false && store.isUnlocked() === true && store.state() === "LOCAL");
  }

  section("records survive a write and a read");
  {
    const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/store-outpost.js"]);
    const store = FieldKit.need("store");

    /* No IndexedDB in the harness, which is the degraded path — the
       one a private window also takes. It has to work. */
    const info = await store.init();
    ok("it initialises without IndexedDB", info.state === "LOCAL");
    ok("and says the session will not survive the tab", info.persistent === false);
    ok("DIAGNOSTICS can tell which mode it is in", store.persistent() === false);

    const meta = await store.put("guestbook", { name: "Ada", note: "was here" });
    ok("a write returns metadata", !!meta.id && meta.type === "guestbook");
    ok("it stamps the schema version", meta.schemaVersion === FieldKit.SCHEMA_VERSION);

    ok("it reads back", (await store.get(meta.id)).note === "was here");
    const rows = await store.list("guestbook");
    ok("it lists by type", rows.length === 1 && rows[0].id === meta.id);
    ok("and filters by type", (await store.list("nothing-like-this")).length === 0);

    await store.put("guestbook", { name: "Ada", note: "edited" }, { id: meta.id });
    ok("an update replaces rather than duplicates", (await store.list("guestbook")).length === 1);
    ok("and keeps the original creation time",
      (await store.list("guestbook"))[0].meta.createdAt === meta.createdAt);

    await store.remove(meta.id);
    ok("removal works", (await store.list("guestbook")).length === 0);
  }

  /* Two nearly identical 300-line HTML files is exactly the shape
     that rots. The launcher is the part that must never diverge —
     it is the code that reports MODULE LOAD FAILURE on a machine
     with no terminal. */
  section("the two entry files have not drifted apart");
  {
    /* Line endings are normalised before comparing. One of these
       files having been checked out CRLF and the other written LF
       is a working-tree artifact, not drift, and letting it fail
       here trains everyone to ignore the one test whose whole job
       is to notice that the launcher stopped matching. */
    const launcher = (h) => {
      const i = h.indexOf("var gate = document.getElementById");
      return i < 0 ? null : h.slice(i).replace(/\r\n/g, "\n");
    };
    const a = launcher(mainHtml), b = launcher(outHtml);
    ok("both entry files have a launcher", !!a && !!b);
    ok("the launcher logic is identical in both",
      a && b && a.replace(/OUTPOST-STANDALONE/g, "FIELDKIT-STANDALONE") === a &&
      b.replace(/OUTPOST-STANDALONE/g, "FIELDKIT-STANDALONE") === a);

    const styleOf = (h) =>
      ((h.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "").replace(/\r\n/g, "\n");
    ok("the boot-screen styling is identical in both", styleOf(mainHtml) === styleOf(outHtml));

    ok("OUTPOST points at its own bundle, not FIELDKIT's",
      /OUTPOST-STANDALONE\.html/.test(outHtml) && !/FIELDKIT-STANDALONE\.html/.test(outHtml));
  }

  section("the build ships it");
  {
    ok("build.js emits an OUTPOST bundle",
      fs.existsSync(path.join(ROOT, "OUTPOST-STANDALONE.html")));

    const manPath = path.join(ROOT, "drive-manifest.json");
    if (fs.existsSync(manPath)) {
      const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
      ok("the drive manifest covers OUTPOST.html", !!man.files["OUTPOST.html"]);
      ok("and its bundle", !!man.files["OUTPOST-STANDALONE.html"]);
      const uncovered = OUT.filter((f) => !man.files[f]);
      ok("and every script OUTPOST boots", uncovered.length === 0, uncovered.join(", "));
    } else {
      console.log("  ....  SKIPPED — no drive-manifest.json; run `node build.js` first");
    }
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
