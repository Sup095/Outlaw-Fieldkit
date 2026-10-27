/* ============================================================
   FieldKit :: tests/critter-net.test.js
   The commands that leave the drive, and the reference that
   documents them.

   Two things are being defended here.

   The first is the boundary. core/critterscript-net.js is the only
   place where a script can reach past the machine it is running
   on, and the promise made about it — in its own header, in the
   reference module, and to the person who asked for it — is that
   nothing in it can CHANGE anything. That promise is worth exactly
   as much as a test that fails when somebody adds a `restart`
   command in six months, so that test is here.

   The second is the export. modules/critter-ref.js exists so the
   language can be lifted out and rebuilt somewhere else. An export
   that quietly drops a command, or that says v3 while the language
   says v4, would not look broken — it would look fine and be
   wrong, which is the worst kind of wrong for the one artifact you
   would trust when starting over.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");

const FILES = [
  "core/kernel.js",
  "core/critterscript.js",
  "core/critterscript-net.js",
  "modules/critter-ref.js"
];

(async function () {
  const t = makeRunner("CRITTER-NET");
  const { ok, section } = t;

  const FieldKit = bootstrap(FILES);
  const cs = FieldKit.need("critterscript");

  /* ---- fakes ----------------------------------------------------
     Recording rather than asserting inline, so a test can say what
     the relay was actually asked for. A stub that only returns the
     right answer proves the command parses; one that remembers the
     call proves it asked the right question. */
  const calls = [];
  let relayUrl = "https://relay.example";
  let unlocked = true;

  FieldKit.provide("transportRelay", {
    url: () => relayUrl,
    browseText(u) {
      calls.push(["browseText", u]);
      return Promise.resolve({
        ok: true, url: u, status: 200, type: "text/html",
        title: "A Page", text: "first line\nsecond line",
        links: [{ text: "onward", url: "https://elsewhere.example/x" }],
        truncated: false
      });
    },
    browseFind(q) {
      calls.push(["browseFind", q]);
      return Promise.resolve({
        ok: true, query: q, engine: "www.bing.com",
        results: [
          { title: "First hit", url: "https://one.example/" },
          { title: "Second hit", url: "https://two.example/" }
        ]
      });
    },
    status() {
      calls.push(["status"]);
      return Promise.resolve({
        total: 2, up: 1,
        services: [
          { name: "wiki", ok: true, kind: "http", status: 200, ms: 12, note: "" },
          { name: "git", ok: false, kind: "http", error: "refused", ms: 900, note: "internal" }
        ]
      });
    },
    health() {
      calls.push(["health"]);
      return Promise.resolve({
        up: true, version: 1, vaultProvisioned: true,
        features: ["records", "ai"], time: "2026-08-20T00:00:00.000Z"
      });
    }
  });

  FieldKit.provide("store", { isUnlocked: () => unlocked });

  FieldKit.provide("ai", {
    chat(messages) {
      calls.push(["chat", messages[0].content]);
      return Promise.resolve({ text: "  an answer  ", tier: 1 });
    },
    summarize(text) {
      calls.push(["summarize", text]);
      return Promise.resolve({ text: "shorter", tier: 2 });
    }
  });

  /* Errors are returned as text rather than thrown, because half of
     what is being tested here IS the error text — a script that
     cannot reach the relay has to say something a person can act on,
     and the only way to assert that is to read it. This is what the
     terminal does with a failed run, too. */
  function collect(src, io) {
    const lines = [];
    io.print = (x) => lines.push(String(x));
    return cs.run(src, io)
      .then(() => lines.join("\n"))
      .catch((e) => lines.concat("!! " + e.message).join("\n"));
  }
  /* `say` and `read` are the terminal's, not the language's, and
     the terminal module is not loaded here — it drags in the whole
     UI. The recipes in the reference use both, so the reference's
     own "every documented command still exists" check would fail
     for a reason that is an artifact of this suite rather than a
     fault in anything. Stubs, registered before that check runs. */
  cs.command({ name: "say", guestSafe: true, usage: "say <words...>",
    help: "stub for the suite", run: (c) => c.print(c.raw.join(" ")) });
  cs.command({ name: "read", guestSafe: false, usage: "read <name>",
    help: "stub for the suite", run: () => "line one\nline two" });

  function out(src) { return collect(src, {}); }
  function outGuest(src) { return collect(src, { guest: true }); }

  /* ---------------------------------------------------------------- */
  section("the boundary: nothing here can change anything");
  {
    const net = FieldKit.need("critterscriptNet");
    ok("the module registered and says what it registered",
      Array.isArray(net.commands) && net.commands.length === 6, net.commands.join(" "));

    /* The list is the contract. If a command is added to that file
       it has to be added here too, and adding it here is the moment
       somebody has to look at this comment and decide whether it
       still only reads. */
    const allowed = ["fetch", "find", "ask", "sum-up", "services", "uptime"];
    ok("and it is exactly the read-only set",
      net.commands.slice().sort().join(" ") === allowed.slice().sort().join(" "));

    const forbidden = ["restart", "reboot", "stop", "start", "deploy", "delete",
      "action", "actions", "run-action", "config", "provision", "upload", "publish"];
    const present = forbidden.filter((n) => cs.get(n));
    ok("no command that could change relay state exists at all",
      present.length === 0, present.join(", ") || "none");

    ok("every networked command is sealed from guests",
      net.commands.every((n) => cs.get(n) && !cs.get(n).guestSafe));
  }

  section("guest mode refuses them by name");
  {
    const said = await outGuest("fetch example.com");
    ok("a guest is told which command is sealed, not just 'denied'",
      /'fetch' is not available in guest mode/.test(said), said);
  }

  section("fetch");
  {
    ok("a bare host becomes https",
      (await out("fetch example.com | field url")) === "https://example.com" ||
      calls.some((c) => c[0] === "browseText" && c[1] === "https://example.com"),
      JSON.stringify(calls[calls.length - 1]));

    ok("it hands back a record, not a page",
      (await out("fetch https://example.com | kind")) === "a record");

    ok("the title is a field", (await out("fetch https://example.com | field title")) === "A Page");

    ok("the text pipes into the rest of the language",
      (await out("fetch https://example.com | field text | lines | count")) === "2");

    /* Links keep their own shape on purpose — a link's words are
       not a title, and renaming the field to match find's results
       would make `pluck title` silently work on one and not the
       other. */
    ok("links keep text/url rather than borrowing find's shape",
      (await out("fetch https://example.com | field links | first | fields | join ,")) === "text,url");

    const bad = await out("fetch not-a-url");
    ok("a word that is not an address says so, and points at find",
      /is not a web address/.test(bad) && /find/.test(bad), bad);
  }

  section("find");
  {
    ok("it hands back a list of records",
      (await out("find godot navmesh | count")) === "2");
    ok("several words are one query, not several arguments",
      calls.some((c) => c[0] === "browseFind" && c[1] === "godot navmesh"));
    ok("a result pipes straight into fetch",
      (await out("find anything | first | field url | fetch $it | field title")) === "A Page");
    ok("and the whole list plucks",
      (await out("find anything | pluck title | join \" / \"")) === "First hit / Second hit");
  }

  section("ask and sum-up");
  {
    ok("ask returns the model's words, trimmed",
      (await out("ask what is the airspeed of a swallow")) === "an answer");
    ok("the question arrives as one question",
      calls.some((c) => c[0] === "chat" && c[1] === "what is the airspeed of a swallow"));
    ok("sum-up shortens what it is piped",
      (await out("fetch https://example.com | field text | sum-up")) === "shorter");
    ok("and it was handed the text rather than the record",
      calls.some((c) => c[0] === "summarize" && c[1] === "first line\nsecond line"));
  }

  section("services and uptime");
  {
    ok("services is a list of records",
      (await out("services | count")) === "2");
    /* The example printed in the reference module's own docs. If
       this breaks, the documentation is lying. */
    ok("the documented example works: which ones are down",
      (await out("services | where ok false | pluck name | join ,")) === "git");
    ok("uptime reports the relay's clock",
      (await out("uptime | field time")) === "2026-08-20T00:00:00.000Z");
  }

  section("failing without a relay says what to do about it");
  {
    relayUrl = "";
    const noRelay = await out("fetch example.com");
    ok("no relay names RELAY LINK", /RELAY LINK/.test(noRelay), noRelay);
    relayUrl = "https://relay.example";

    unlocked = false;
    const locked = await out("find anything");
    ok("a locked vault says to unlock rather than reporting a network error",
      /[Uu]nlock/.test(locked) && !/network|fetch failed/i.test(locked), locked);
    unlocked = true;
  }

  /* ---------------------------------------------------------------- */
  section("the reference exports the whole language");
  {
    const ref = FieldKit.need("critterRef");
    const md = ref.markdown();
    const json = JSON.parse(ref.json());

    const missing = cs.list().filter((c) => md.indexOf("`" + c.name + "`") < 0)
      .map((c) => c.name);
    ok("markdown names every registered command", missing.length === 0,
      missing.join(", ") || cs.list().length + " commands");

    ok("json carries them as data, not prose",
      Array.isArray(json.commands) && json.commands.length === cs.list().length,
      json.commands.length + " vs " + cs.list().length);

    ok("and each carries what a reimplementation would need",
      json.commands.every((c) =>
        typeof c.name === "string" && typeof c.usage === "string" &&
        typeof c.group === "string" && typeof c.guestSafe === "boolean" &&
        typeof c.minArgs === "number"));

    ok("the version in the export is the version of the language",
      String(json.version) === String(cs.VERSION), "v" + json.version);

    ok("the three rules are three", Array.isArray(json.rules) && json.rules.length === 3);

    ok("the budgets are exported as numbers, not described in words",
      json.limits.maxSteps === cs.MAX_STEPS && json.limits.maxLoop === cs.MAX_LOOP);

    /* The networked commands are the ones most likely to be
       described and then quietly removed, because they depend on a
       server that might change. */
    ok("the networked commands are documented too",
      ["fetch", "find", "ask", "sum-up", "services", "uptime"]
        .every((n) => md.indexOf("`" + n + "`") >= 0));

    ok("guest-safety is visible in the markdown table, not just the json",
      /\| `say` \|[\s\S]*?\| yes \|/.test(md) || md.indexOf("| yes |") >= 0);

    ok("the plain text the terminal prints comes from the same spec",
      ref.plainText().indexOf("$name is a variable") >= 0);
  }

  section("the reference's own selfchecks pass");
  {
    const def = FieldKit.modules()["critter-ref"];
    ok("the module registered", !!def && typeof def.selfcheck === "function");
    const checks = def.selfcheck({});
    ok("it brings more than one check", checks.length >= 3, String(checks.length));
    for (const c of checks) {
      let detail = "";
      let passed = true;
      try { detail = await c.run(); }
      catch (e) { passed = /^SKIPPED/.test(e.message); detail = e.message; }
      ok("selfcheck: " + c.name, passed, detail);
    }
  }

  console.log("\nRESULT  pass " + t.state.pass + "  fail " + t.state.fail);
  process.exit(t.state.fail ? 1 : 0);
})().catch((e) => {
  console.log("\nSUITE CRASHED: " + e.stack);
  console.log("RESULT  pass 0  fail 1");
  process.exit(1);
});
