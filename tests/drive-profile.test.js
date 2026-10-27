/* ============================================================
   core/drive-profile.js

   Settings that travel on the stick instead of on the machine.

   Two things are worth testing and one of them is the whole point:

     1. NOTHING SECRET TRAVELS. The drive is the thing most likely
        to be lost, and a profile carrying a credential turns losing
        it from annoying into catastrophic. The whitelist is checked
        against the real settings list, so a future setting called
        something like `msgAuthSecret` cannot quietly become
        portable by being added to DEFAULTS.

     2. THE MACHINE WINS. A value from the drive fills in a blank;
        it never overwrites a decision made here. Otherwise a stick
        would undo someone's choice to turn effects off on a slow
        laptop, every single launch.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { ROOT, bootstrap, makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("drive-profile");

const CORE = ["core/kernel.js", "core/settings.js", "core/ui.js", "core/drive-profile.js"];

function boot(profile) {
  const FieldKit = bootstrap(CORE);
  if (profile !== undefined) window.FK_DRIVE_PROFILE = profile;
  else delete window.FK_DRIVE_PROFILE;
  return FieldKit;
}

(async function () {
  section("nothing secret travels");
  {
    const FieldKit = boot();
    const dp = FieldKit.need("driveProfile");

    /* Every key the settings module actually has, versus the ones
       marked portable. A new setting is non-portable by default —
       that is the safe direction — but a new SECRET one that
       somebody adds to the whitelist must fail loudly. */
    const src = fs.readFileSync(path.join(ROOT, "core", "settings.js"), "utf8");
    const defaults = /var DEFAULTS = \{([\s\S]*?)\n  \};/.exec(src)[1];
    const allKeys = [...defaults.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)].map((m) => m[1]);
    ok("the settings list was found", allKeys.length > 8, allKeys.join(", "));

    const risky = dp.PORTABLE.filter((k) => /pass|secret|token|recovery|auth|pin/i.test(k));
    ok("no portable setting is named like a credential", risky.length === 0, risky.join(", "));

    const unknown = dp.PORTABLE.filter((k) =>
      allKeys.indexOf(k) < 0 && k !== "msgHandle");
    ok("every portable setting is a real setting", unknown.length === 0, unknown.join(", "));

    /* The serialiser is the thing that actually decides what leaves,
       so it is checked directly rather than by reading the list. */
    const settings = FieldKit.need("settings");
    settings.set("relayUrl", "https://relay.example.com");
    settings.set("displayName", "Sup095");
    settings.set("theme", "cyan");

    const text = dp.serialise();
    ["hunter2", "correct horse", "s3cret"].forEach((secret) => {
      settings.set("displayName", "Sup095");
      ok("a value never set is never emitted (" + secret + ")",
        dp.serialise().indexOf(secret) < 0);
    });

    ok("what it does carry is there", /relay\.example\.com/.test(text) && /Sup095/.test(text));
    ok("it is a script that assigns a global, because file:// cannot fetch",
      /^\/\*/.test(text) && /window\.FK_DRIVE_PROFILE = \{/.test(text));
    ok("and it explains itself to whoever opens it",
      /no password/.test(text) && /safe to delete/i.test(text));

    /* The direct attack: put a credential in settings under a
       portable-looking name and confirm it does not travel. */
    settings.set("authToken", "SHOULD-NEVER-TRAVEL");
    settings.set("recoveryKey", "SHOULD-NEVER-TRAVEL");
    ok("a credential sitting in settings is not picked up",
      dp.serialise().indexOf("SHOULD-NEVER-TRAVEL") < 0);

    /* And through the one door that takes caller-supplied values. */
    const forced = dp.serialise({ authToken: "SNEAKY", relayUrl: "https://ok.example" });
    ok("nor can one be forced in through the extras argument",
      forced.indexOf("SNEAKY") < 0 && forced.indexOf("ok.example") >= 0);
  }

  section("the machine wins");
  {
    const FieldKit = boot({
      version: 1, savedAt: "2026-08-01T00:00:00.000Z", label: "the stick",
      settings: { relayUrl: "https://from-drive.example", theme: "violet", ambient: true }
    });
    const settings = FieldKit.need("settings");
    const dp = FieldKit.need("driveProfile");

    /* This machine has an opinion about the theme and none about
       the relay — the exact split the whole feature is about. */
    settings.set("theme", "rust");

    const r = dp.apply();
    ok("the profile was seen", r.loaded === true);
    ok("a setting this machine never chose is filled in from the drive",
      settings.get("relayUrl") === "https://from-drive.example");
    ok("a setting this machine DID choose is left alone",
      settings.get("theme") === "rust", settings.get("theme"));
    ok("it reports which ones it touched",
      r.applied.indexOf("relayUrl") >= 0 && r.applied.indexOf("theme") < 0,
      r.applied.join(", "));

    /* A drive value must not itself count as a local decision, or
       the drive could never update it again. */
    ok("a value applied from the drive does not become a local choice",
      settings.isSetLocally("relayUrl") === false);
    ok("but one set here does", settings.isSetLocally("theme") === true);
  }

  section("a setting the drive has no business carrying is ignored on the way in");
  {
    const FieldKit = boot({
      version: 1,
      settings: { relayUrl: "https://ok.example", authToken: "NOPE", provisionToken: "NOPE" }
    });
    const settings = FieldKit.need("settings");
    const r = FieldKit.need("driveProfile").apply();
    ok("the allowed one lands", settings.get("relayUrl") === "https://ok.example");
    ok("a credential planted in the file is refused",
      settings.get("authToken") === undefined && settings.get("provisionToken") === undefined);
    ok("and is not reported as applied",
      r.applied.indexOf("authToken") < 0 && r.applied.indexOf("provisionToken") < 0);
  }

  section("a drive with no profile is the normal state");
  {
    const FieldKit = boot();
    const dp = FieldKit.need("driveProfile");
    const r = dp.apply();
    ok("apply() does not throw with nothing there", r.loaded === false);
    ok("and reports it plainly", r.applied.length === 0);
    ok("status() says there is none", dp.status().loaded === false);
    ok("and names the file to create", dp.status().file === "config/drive-profile.js");
  }

  section("a corrupted profile does not take the boot down");
  {
    [null, "a string", 42, [], { settings: "not an object" }, { settings: null }].forEach((bad, i) => {
      const FieldKit = boot(bad);
      let threw = null;
      try { FieldKit.need("driveProfile").apply(); } catch (e) { threw = e.message; }
      ok("a malformed profile (case " + i + ") is survived", threw === null, threw);
    });
  }

  section("both builds carry it");
  {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
    ["FIELDKIT.html", "OUTPOST.html"].forEach((f) => {
      const html = read(f);
      ok(f + " boots the drive-profile code", /"core\/drive-profile\.js"/.test(html));
      ok(f + " loads the data file optionally, so a fresh drive is not a fault",
        /FK_OPTIONAL_MANIFEST[\s\S]*config\/drive-profile\.js/.test(html));
    });

    /* The data file must never be in the REQUIRED manifest: a
       missing entry there is a fatal boot error, and a fresh drive
       does not have one. */
    ["FIELDKIT.html", "OUTPOST.html"].forEach((f) => {
      const html = read(f);
      const boot = /window\.FK_BOOT_MANIFEST\s*=\s*\[([\s\S]*?)\]/.exec(html)[1];
      ok(f + " does not require the data file to exist",
        boot.indexOf("config/drive-profile.js") < 0);
    });
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
