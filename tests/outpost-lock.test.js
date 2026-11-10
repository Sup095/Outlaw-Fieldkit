/* ============================================================
   OUTPOST's screen lock, sign-in at start and DEEPHOLD (0.16.2).

   What matters:
     1. OUTPOST carries DEEPHOLD and the PIN lock, like FieldKit.
     2. With no vault and no core/crypto.js the PIN still works: it is a
        salted hash in OUTPOST's own store, right PIN opens, wrong is
        refused.
     3. Its idle time is its own setting, never the full build's.
     4. Running out of tries signs out of the gamertag before reloading.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js"]);
const { ok, section, state } = makeRunner("outpost-lock");
const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

(async () => {
  section("OUTPOST carries them");
  {
    const out = rd("OUTPOST.html");
    ok("DEEPHOLD, with its picture", /"modules\/colony\.js"/.test(out) && /"core\/colony-scene\.js"/.test(out) && /"core\/colony-sprites\.js"/.test(out));
    ok("the PIN lock, started when the desktop is up", /"core\/lockscreen\.js"/.test(out) && /lock\.init\(\)/.test(rd("core/boot-outpost.js")));
    ok("SETTINGS has the lock and the sign-in question", /lockPanel\(\)/.test(rd("modules/settings-outpost.js")) && /"outpostLockMinutes", "signInAtBoot"/.test(rd("modules/settings-outpost.js")));
    ok("and the sign-in at start is no longer FieldKit only", !/d && d\.outpost\) return/.test(rd("modules/messages.js")));
  }

  section("a PIN with no vault");
  {
    /* OUTPOST's store, as far as the lock uses it */
    const rows = [];
    FieldKit.provide("store", {
      isUnlocked: () => true,
      list: async (type) => rows.filter((r) => r.type === type),
      put: async (type, data, o) => { const id = (o && o.id) || "r" + rows.length; const i = rows.findIndex((r) => r.id === id); const r = { id, type, data }; if (i >= 0) rows[i] = r; else rows.push(r); return r; },
      remove: async (id) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); }
    });
    FieldKit.provide("boot", { OUTPOST: true });
    const src = rd("core/lockscreen.js");
    new Function("window", src)(global.window || globalThis);
    const lock = FieldKit.need("lockscreen");
    ok("there is no crypto service to lean on", !FieldKit.service("crypto"));
    ok("no PIN to begin with", (await lock.hasPin()) === false);
    await lock.setPin("4821");
    ok("a PIN is kept as a salted hash, never the digits", rows.length === 1 && rows[0].data.hash && rows[0].data.salt && !JSON.stringify(rows[0]).includes("4821"));
    ok("the right PIN opens", (await lock.verify("4821")) === true);
    ok("a wrong one does not", (await lock.verify("4822")) === false);
    let bad = null; try { await lock.setPin("12"); } catch (e) { bad = e; }
    ok("too short is refused", !!bad);
    await lock.clearPin();
    ok("and it can be removed", (await lock.hasPin()) === false);
    ok("its idle time is OUTPOST's own setting", /outpostLockMinutes/.test(src) && /minutesKey\(\)/.test(src));
    ok("running out of tries forgets the gamertag before the reload", /removeItem\("fk\.deephold"\)/.test(src));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
