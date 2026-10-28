/* ============================================================
   build.js — the payload boundary and the generated config

   Two things here, and the first one is the one that would hurt.

   NOTHING SECRET REACHES THE DRIVE. The thumb drive gets carried
   into a school and plugged into machines nobody controls. The
   relay's config holds a provision token, a Cloudflare tunnel
   credential and a moderator list; the release key signs builds
   that FieldKit will install without asking. None of that has any
   business on the stick, and "relay/ is not in PAYLOAD" is true by
   construction today — which is exactly the sort of thing that
   stops being true in a hurry when somebody adds a directory to a
   list. So it is asserted rather than assumed.

   THE GENERATED CONFIG. `node build.js` merges the committed,
   annotated example with a gitignored file of real values. The
   merge has to reach settings the local file never mentions —
   otherwise adding a setting silently leaves the live relay
   without it, which is the failure the generator exists to stop.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { makeRunner, ROOT } = require("./harness");
const build = require("../build.js");
const { ok, section, state } = makeRunner("build");

(async function () {
  section("nothing secret can reach the drive");
  {
    const payload = build.payloadList();
    ok("the payload is a list of names, not a glob", Array.isArray(payload) && payload.length > 0);

    /* Named individually. A loop over "anything with relay in it"
       would pass while somebody added "relay" itself. */
    ["relay", "relay/", "relay/config.json", "relay/config.local.json",
     "release-key.json", "release", "release/", "node_modules", ".git",
     "tests", "tools"].forEach((bad) => {
      ok("the payload does not carry " + bad,
        !payload.some((p) => p === bad || p === bad.replace(/\/$/, "")));
    });

    /* The stronger version: walk what the payload would actually
       copy and look for anything that smells like a credential. This
       catches a secret that arrived somewhere legitimate — a token
       pasted into a core file, say — rather than only a bad entry in
       the list. */
    const files = [];
    const visit = (rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return;
      const st = fs.statSync(abs);
      if (st.isDirectory()) fs.readdirSync(abs).forEach((e) => visit(path.join(rel, e)));
      else files.push(rel.split(path.sep).join("/"));
    };
    payload.forEach(visit);
    ok("the payload resolves to real files", files.length > 20, String(files.length));

    const localPath = path.join(ROOT, "relay", "config.local.json");
    const keyPath = path.join(ROOT, "release-key.json");
    const secrets = [];
    if (fs.existsSync(localPath)) {
      const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
      if (local.provisionToken) secrets.push(["the provision token", local.provisionToken]);
      if (local.cloudflared && local.cloudflared.token) {
        secrets.push(["the cloudflared token", local.cloudflared.token]);
      }
    }
    if (fs.existsSync(keyPath)) {
      const k = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      secrets.push(["the release private key", k.privateKeyPkcs8B64]);
    }

    if (!secrets.length) {
      ok("SKIPPED — no local secrets on this machine to search for", true);
    } else {
      secrets.forEach(([what, value]) => {
        const found = files.filter((f) => {
          try { return fs.readFileSync(path.join(ROOT, f), "utf8").indexOf(value) >= 0; }
          catch (e) { return false; }   // binary, and a token is not hiding in a font
        });
        ok(what + " appears in no file the drive would carry",
          found.length === 0, found.join(", "));
      });
    }

    /* The public half is supposed to ship — that is the whole design
       — so its absence would be the bug, not its presence. */
    ok("the public update key DOES ship, since the app verifies with it",
      files.indexOf("core/update-key.js") >= 0);
  }

  section("the config merge");
  {
    const m = build.mergeConfig;

    ok("a local value wins over the example's placeholder",
      m({ provisionToken: "CHANGE-ME" }, { provisionToken: "real" }).provisionToken === "real");

    /* The one that matters. Adding browse.blockHosts to the example
       must reach the generated config even though config.local only
       mentions browse.enabled — otherwise a new setting silently
       never arrives on the relay. */
    const nested = m(
      { browse: { enabled: false, allowHosts: [], blockHosts: [] } },
      { browse: { enabled: true } });
    ok("a nested object is merged, not replaced", nested.browse.enabled === true);
    ok("and settings the local file never mentions survive",
      Array.isArray(nested.browse.blockHosts));

    /* Arrays replace whole. A half-merged moderator list or a
       half-merged list of AI targets is worse than either of them. */
    const arr = m({ moderators: ["a", "b"] }, { moderators: ["c"] });
    ok("an array is replaced rather than concatenated",
      arr.moderators.join(",") === "c");

    ok("the example's annotations survive the merge",
      m({ _browse: "note", browse: { enabled: false } }, { browse: { enabled: true } })._browse === "note");

    /* config.local's own notes to the reader are not settings and
       must not end up in the relay's config. */
    const notes = m({ port: 1 }, { _: "hello", _how: "there", port: 2 });
    ok("config.local's own header notes are not copied through",
      !("_" in notes) && !("_how" in notes));
    ok("but real values beside them are", notes.port === 2);

    ok("a setting present only in the example comes through untouched",
      m({ aiTimeoutMs: 120000 }, {}).aiTimeoutMs === 120000);
  }

  section("what the build actually generated");
  {
    const gen = path.join(ROOT, "relay", "config.json");
    if (!fs.existsSync(gen)) {
      ok("SKIPPED — no relay/config.json generated on this machine", true);
    } else {
      const text = fs.readFileSync(gen, "utf8");
      let cfg = null;
      try { cfg = JSON.parse(text); } catch (e) { /* asserted below */ }
      ok("it is valid JSON — the generator cannot emit what broke the relay", !!cfg);
      ok("it says it is generated and where to edit instead",
        cfg && /Edit config.local.json/.test(cfg._generated || ""));
      ok("it warns against uploading the private key",
        cfg && /never upload config.local.json or release-key.json/i.test(cfg._generated || ""));

      /* Every key the relay reads, present. A generated config
         missing one is a setting silently running on a default. */
      ["port", "host", "provisionToken", "dataDir", "aiTargets", "trustProxy",
       "cloudflared", "actions", "messaging", "browse", "updates", "rateLimit"
      ].forEach((k) => ok("it carries " + k, cfg && k in cfg));

      ["windowMs", "max", "authedMax", "vaultMax", "authFailMax", "actionMax",
       "blobMax", "msgMax", "msgAuthMax", "browseMax", "browseTicketMax", "updateMax"
      ].forEach((k) => ok("rateLimit carries " + k, cfg && cfg.rateLimit && k in cfg.rateLimit));

      /* Moderator handles are lowercased by the relay before they are
         compared, so a capital here never matches a real account and
         reporting quietly cannot work. */
      const mods = (cfg && cfg.messaging && cfg.messaging.moderators) || [];
      ok("every moderator handle is a quoted lowercase string",
        mods.every((h) => typeof h === "string" && h === h.toLowerCase() && h.length >= 3),
        JSON.stringify(mods));

      ok("no placeholder survived into the generated config",
        !/CHANGE-ME/.test(text), (text.match(/"[^"]*CHANGE-ME[^"]*"/g) || []).join(", "));
    }
  }

  section("the example stays shareable");
  {
    const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "relay", "config.example.json"), "utf8"));
    ok("the example has no real provision token", /CHANGE-ME/.test(ex.provisionToken));
    ok("no tunnel credential", !ex.cloudflared.token);
    ok("no moderators listed", ex.messaging.moderators.length === 0);
    /* Off by default in the shared copy. Someone starting from this
       should have to decide to turn on registration-accepting
       messaging and a fetch-on-your-behalf proxy. */
    ok("messaging is off by default", ex.messaging.enabled === false);
    ok("browse is off by default", ex.browse.enabled === false);
    ok("updates are on, following the public GitHub repo (they are public builds)", ex.updates.enabled === true && /^[\w.-]+\/[\w.-]+$/.test(ex.updates.githubRepo));

    const local = path.join(ROOT, "relay", "config.local.json");
    if (fs.existsSync(local)) {
      const l = JSON.parse(fs.readFileSync(local, "utf8"));
      ok("the example does not contain the local provision token",
        !l.provisionToken || JSON.stringify(ex).indexOf(l.provisionToken) < 0);
      ok("nor the local tunnel token",
        !(l.cloudflared && l.cloudflared.token) ||
        JSON.stringify(ex).indexOf(l.cloudflared.token) < 0);
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
