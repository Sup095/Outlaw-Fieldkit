/* ============================================================
   FieldKit :: terminal
   A prompt over core/critterscript.js, plus the built-in command set.

   WHAT IT IS NOT: a shell. There is no process to talk to. Every
   command here drives FieldKit itself, and the module says so
   rather than letting someone discover it by typing `ls`.

   The command set is split into two jobs, and both matter:

     - doing things quickly     open, set, theme, note, files
     - finding out where you are  setup, doctor, vault, relay

   That second group is the reason this shipped now rather than
   later. Setting up the relay involves a provision token, a
   config file on another machine, a tunnel, and a password — and
   when it goes wrong the useful question is "which step am I
   actually on", which nothing else in FieldKit answers in one
   place.

   Scripts are saved as ordinary records, so they sync, they are
   encrypted, and they carry an author.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "script";
  var HISTORY_MAX = 200;

  var ctx, ui, el, cs, nodes = {}, history = [], histAt = -1;
  var scripts = [], running = false, registered = false;

  /* ---- output -------------------------------------------------- */
  function print(text, cls) {
    if (!nodes.out) return;
    var line = el("div", { class: "tm-line" + (cls ? " " + cls : ""), text: String(text) });
    nodes.out.appendChild(line);
    nodes.out.scrollTop = nodes.out.scrollHeight;
  }

  function printBlock(text, cls) {
    String(text).split("\n").forEach(function (l) { print(l, cls); });
  }

  function svc(n) { return FieldKit.service(n); }

  function isGuest() {
    var g = svc("guest");
    return !!(g && g.active && g.active());
  }

  /* ---- the built-in commands -----------------------------------
     Registered once per page, AT LOAD, and the difference matters
     more than it looks.

     This used to run inside mount(), which meant `say`, `read`,
     `help` and the rest did not exist until somebody had opened
     TERMINAL at least once. Everything inside the terminal still
     worked, because opening it is what registered them — but
     anything else that reads the command registry saw a language
     with a hole in it. CRITTERSCRIPT's command list came up short,
     its selfcheck failed because its own recipes used commands that
     "did not exist", and worst of all its EXPORT — the artifact
     whose entire purpose is to be the complete specification —
     silently omitted them. A reference that is complete only if you
     visited another window first is not a reference.

     The comment here already said "once per page rather than per
     mount". It was just being called from the wrong place.

     The command bodies still reach for the panel through module
     scope, which is correct: they only ever run when something
     invokes them, and the thing that invokes them is the mounted
     terminal. The two that touch the UI directly go through
     svc() so that registering early cannot capture an undefined. */
  function registerBuiltins() {
    if (registered) return;
    var cs = FieldKit.service("critterscript");
    if (!cs) return;               // no language in this build
    registered = true;
    var C = cs.command;

    /* -- output and basics -- */
    C({ name: "say", group: "basics", guestSafe: true, usage: "say <words...>",
      help: "Print something. Everything after the verb is printed as-is.",
      run: function (c) { c.print(c.raw.join(" ")); } });

    C({ name: "clear", group: "basics", guestSafe: true, usage: "clear",
      help: "Empty the output pane.",
      run: function () { svc("ui").clear(nodes.out); } });

    C({ name: "help", group: "basics", guestSafe: true, usage: "help [command]",
      help: "List every command, or explain one.",
      run: function (c) {
        var guest = isGuest();
        if (c.args.length) {
          var name = String(c.args[0]);
          var cmd = cs.get(name);
          if (!cmd) { c.print("no command called '" + name + "'", "bad"); return; }
          c.print(cmd.usage, "accent");
          c.print("  " + cmd.help);
          if (!cmd.guestSafe) c.print("  (not available in guest mode)", "dim");
          return;
        }
        var byGroup = Object.create(null);
        cs.list().forEach(function (cmd) {
          if (guest && !cmd.guestSafe) return;
          (byGroup[cmd.group] = byGroup[cmd.group] || []).push(cmd);
        });
        Object.keys(byGroup).sort().forEach(function (g) {
          c.print("");
          c.print(g.toUpperCase(), "accent");
          byGroup[g].forEach(function (cmd) {
            c.print("  " + cmd.name + new Array(Math.max(1, 14 - cmd.name.length)).join(" ") +
              " " + cmd.help.split(".")[0]);
          });
        });
        c.print("");
        c.print("help <command> for detail. 'language' for the syntax.", "dim");
      } });

    C({ name: "language", group: "basics", guestSafe: true, usage: "language",
      help: "Explain the script syntax.",
      run: function (c) {
        /* CRITTERSCRIPT holds the specification; this prints from
           it when it is loaded so the terminal's help and the
           reference module can never describe two different
           languages. The local text is the fallback for the build
           that has a terminal and no reference module. */
        var ref = svc("critterRef");
        printBlock(ref ? ref.plainText() : LANGUAGE_HELP, "dim");
        if (ref) c.print("", "dim");
      } });

    C({ name: "version", group: "basics", guestSafe: true, usage: "version",
      help: "FieldKit and script-language versions.",
      run: function (c) {
        c.print("FieldKit " + (FieldKit.VERSION || "?") +
          "   schema " + (FieldKit.SCHEMA_VERSION || "?") +
          "   critterscript v" + cs.VERSION);
      } });

    /* -- state, and the setup story -- */
    C({ name: "vault", group: "state", usage: "vault",
      help: "Vault state, transport and record counts.",
      run: async function (c) {
        var s = svc("store");
        if (!s) { c.print("no store service", "bad"); return; }
        c.print("state      " + s.state());
        c.print("transport  " + s.transportName());
        c.print("unlocked   " + (s.isUnlocked() ? "yes" : "no"));
        c.print("history    " + (s.canReadHistory() ? "fully loaded" : "partial — offline"));
        var author = s.author && s.author();
        c.print("author     " + (author || "(no display name set)"));
        try { c.print("queued     " + (await s.pendingCount()) + " write(s) waiting to upload"); }
        catch (e) { /* not fatal */ }
      } });

    C({ name: "relay", group: "state", usage: "relay",
      help: "Relay URL, reachability and features.",
      run: async function (c) {
        var r = svc("transportRelay");
        if (!r || !r.url()) {
          c.print("no relay configured.", "warn");
          c.print("Open RELAY LINK, or:  set relayUrl https://your-host", "dim");
          return;
        }
        c.print("url    " + r.url());
        try {
          var h = await r.health();
          c.print("health up=" + h.up + "  vault=" + (h.vaultProvisioned ? "provisioned" : "EMPTY"), "ok");
          if (h.features) c.print("features " + h.features.join(", "));
          else c.print("features (not reported — this relay predates the feature list)", "warn");
        } catch (e) {
          c.print("unreachable: " + e.message, "bad");
          c.print("Open LINK DOCTOR — it names which failure this is.", "dim");
        }
      } });

    C({ name: "setup", group: "state", usage: "setup",
      help: "Where you are in first-time setup, and the next step.",
      run: async function (c) { await runSetup(c); } });

    C({ name: "doctor", group: "state", usage: "doctor",
      help: "Run the quick self-test and summarise it.",
      run: async function (c) {
        var st = svc("selftest");
        if (!st) { c.print("no selftest service", "bad"); return; }
        c.print("running quick self-test...", "dim");
        var rep = await st.runQuick();
        rep.results.forEach(function (r) {
          var cls = r.skipped ? "dim" : (r.pass ? "ok" : (r.critical ? "bad" : "warn"));
          var mark = r.skipped ? "skip" : (r.pass ? " ok " : "FAIL");
          c.print("[" + mark + "] " + r.name + "  " + r.detail, cls);
        });
        c.print("");
        c.print(rep.passed + " passed, " + rep.failed + " failed, " + rep.skipped + " skipped" +
          "  (" + rep.totalMs + " ms)", rep.criticalFailed ? "bad" : "ok");
        if (rep.failed) c.print("DIAGNOSTICS -> FULL SYSTEM EXERCISE for the deep version.", "dim");
      } });

    C({ name: "time", group: "state", guestSafe: true, usage: "time",
      help: "The current time as this machine sees it.",
      run: function (c) { c.print(new Date().toString()); } });

    /* -- doing things -- */
    C({ name: "open", group: "do", usage: "open <module-id>",
      minArgs: 1,
      help: "Open a module window. 'modules' lists the ids.",
      run: function (c) {
        var sh = svc("shell");
        if (!sh) { c.print("no shell service", "bad"); return; }
        var id = String(c.args[0]);
        try { sh.open(id); c.print("opened " + id, "ok"); }
        catch (e) { c.print(e.message, "bad"); }
      } });

    C({ name: "modules", group: "do", guestSafe: true, usage: "modules",
      help: "List every module id you can open.",
      run: function (c) {
        /* FieldKit.modules() is an id->definition map, not a list. */
        var reg = FieldKit.modules ? FieldKit.modules() : {};
        var ids = Object.keys(reg).sort();
        var guest = isGuest();
        /* Grouped the same way the desktop groups them, so the two
           ways of finding a module agree with each other. A flat
           list here and headed sections there is how you end up
           looking for something under the wrong name. */
        var byGroup = Object.create(null);
        ids.forEach(function (id) {
          var g = String(reg[id].group || "TOOLS").toUpperCase();
          (byGroup[g] = byGroup[g] || []).push(id);
        });
        Object.keys(byGroup).sort().forEach(function (g) {
          c.print("");
          c.print(g, "accent");
          byGroup[g].forEach(function (id) {
            var m = reg[id];
            var sealed = guest && !m.guestSafe;
            c.print("  " + id + new Array(Math.max(1, 20 - id.length)).join(" ") +
              (m.title || "") + (sealed ? "   [sealed]" : ""), sealed ? "dim" : "");
          });
        });
        c.print("");
        c.print(ids.length + " module(s) in " + Object.keys(byGroup).length + " group(s)", "dim");
      } });

    C({ name: "theme", group: "do", guestSafe: true, usage: "theme [name]",
      help: "Show or change the colour theme.",
      run: function (c) {
        if (!c.args.length) {
          c.print("current: " + svc("ui").currentTheme());
          c.print("available: " + Object.keys(svc("ui").THEMES).join(", "), "dim");
          return;
        }
        var t = String(c.args[0]);
        if (!svc("ui").THEMES[t]) {
          c.print("no theme called '" + t + "'. Try: " +
            Object.keys(svc("ui").THEMES).join(", "), "bad");
          return;
        }
        svc("ui").applyTheme(t);
        var s = svc("settings");
        if (s) s.set("theme", t);
        c.print("theme -> " + t, "ok");
      } });

    C({ name: "get", group: "do", usage: "get <key>", minArgs: 1,
      help: "Read one setting.",
      run: function (c) {
        var s = svc("settings");
        if (!s) { c.print("no settings service", "bad"); return; }
        var k = String(c.args[0]);
        var v = s.get(k);
        c.print(v === undefined || v === null ? "(not set)" : cs.show(v));
      } });

    C({ name: "set", group: "do", usage: "set <key> <value...>", minArgs: 2,
      help: "Change one setting. Everything after the key is the value.",
      run: function (c) {
        var s = svc("settings");
        if (!s) { c.print("no settings service", "bad"); return; }
        var k = String(c.args[0]);
        var v = c.raw.slice(1).join(" ");
        if (v === "true") v = true;
        else if (v === "false") v = false;
        else if (v !== "" && !Number.isNaN(Number(v)) && /^-?[0-9.]+$/.test(v)) v = Number(v);
        s.set(k, v);
        c.print(k + " -> " + cs.show(v), "ok");
      } });

    C({ name: "settings", group: "do", usage: "settings",
      help: "List every setting and its value.",
      run: function (c) {
        var s = svc("settings");
        if (!s) { c.print("no settings service", "bad"); return; }
        var all = s.all ? s.all() : null;
        if (!all) { c.print("this build cannot enumerate settings", "warn"); return; }
        Object.keys(all).sort().forEach(function (k) {
          c.print("  " + k + new Array(Math.max(1, 22 - k.length)).join(" ") + cs.show(all[k]));
        });
      } });

    C({ name: "files", group: "do", usage: "files [search]",
      help: "List files stored in the vault.",
      run: async function (c) {
        var f = svc("files");
        if (!f) { c.print("file storage is not available", "bad"); return; }
        var caps = f.capabilities();
        if (!caps.available) {
          c.print("no blob transport — the relay needs the newer server.js", "warn");
          return;
        }
        var q = c.raw.join(" ").toLowerCase();
        var rows = await f.list();
        var shown = q ? rows.filter(function (r) {
          return (r.data.name || "").toLowerCase().indexOf(q) >= 0;
        }) : rows;
        if (!shown.length) { c.print(rows.length ? "no matches" : "no files stored", "dim"); return; }
        shown.forEach(function (r) {
          c.print("  " + f.fmtBytes(r.data.size) + "\t" + r.data.name +
            "   (" + (r.data.chunks || []).length + " chunks)");
        });
        c.print(shown.length + " of " + rows.length + " file(s)", "dim");
      } });

    C({ name: "records", group: "do", usage: "records [type]",
      help: "Count records, or list one type.",
      run: async function (c) {
        var s = svc("store");
        if (!s || !s.isUnlocked()) { c.print("vault is locked", "bad"); return; }
        var rows = await s.list(c.args.length ? String(c.args[0]) : undefined);
        if (!c.args.length) {
          var counts = Object.create(null);
          rows.forEach(function (r) { counts[r.meta.type] = (counts[r.meta.type] || 0) + 1; });
          Object.keys(counts).sort().forEach(function (t) {
            c.print("  " + t + new Array(Math.max(1, 18 - t.length)).join(" ") + counts[t]);
          });
          c.print(rows.length + " record(s) total", "dim");
          return;
        }
        rows.slice(0, 40).forEach(function (r) {
          c.print("  " + r.id.slice(0, 8) + "  " + (r.meta.updatedAt || "").slice(0, 16) +
            "  " + (r.meta.author || "-"));
        });
        c.print(rows.length + " record(s)", "dim");
      } });

    /* THE COMMAND THE DOCUMENTATION ALREADY DESCRIBED.

       `read notes | split " " | count` is the example in the second
       of the three rules and in the before/after that explains what
       the pipe changed — and `read` did not exist. The reference
       module's own selfcheck caught it, which is the whole reason
       that check is there.

       Adding it rather than rewriting the docs, because the gap was
       real: the language could fetch a page from the far side of the
       internet and could not read a note you wrote yesterday. It
       ANSWERS rather than prints, so it can be piped — that is the
       difference between it and `show`, which is for looking at a
       saved script.

       Matched by title, case-insensitively, longest-first so that a
       note called "design" does not shadow "design decisions" when
       you asked for the latter. An ambiguous name lists what it
       could have meant instead of guessing. */
    C({ name: "read", group: "do", usage: "read <name>", minArgs: 1,
      help: "The text of a note, by title. Answers rather than prints, so it pipes.",
      run: async function (c) {
        var st = svc("store");
        if (!st || !st.isUnlocked()) throw new Error("the vault is locked, so there is nothing to read");
        var want = c.raw.join(" ").trim().toLowerCase();
        if (!want) throw new Error("read needs the name of a note");

        var rows = await st.list("note");
        var named = rows.map(function (r) {
          return { r: r, title: String((r.data && r.data.title) || "").trim() };
        }).filter(function (x) { return x.title; });

        var exact = named.filter(function (x) { return x.title.toLowerCase() === want; });
        var hits = exact.length ? exact : named.filter(function (x) {
          return x.title.toLowerCase().indexOf(want) >= 0;
        });

        if (!hits.length) {
          throw new Error("no note called '" + c.raw.join(" ") + "'. " +
            (named.length ? "There are " + named.length + " note(s) — try  records note"
                          : "There are no notes yet."));
        }
        if (hits.length > 1) {
          /* Naming them rather than taking the first. Reading the
             wrong note and not knowing is worse than an error. */
          throw new Error("'" + c.raw.join(" ") + "' matches " + hits.length + " notes: " +
            hits.slice(0, 6).map(function (x) { return x.title; }).join(", ") +
            (hits.length > 6 ? ", …" : "") + ". Use more of the title.");
        }
        return String((hits[0].r.data && hits[0].r.data.body) || "");
      } });

    C({ name: "note", group: "do", usage: "note <text...>", minArgs: 1,
      help: "Append a quick note to the scratchpad without opening it.",
      run: async function (c) {
        var s = svc("store");
        if (!s || !s.isUnlocked()) { c.print("vault is locked", "bad"); return; }
        var text = c.raw.join(" ");
        var title = "terminal " + new Date().toISOString().slice(0, 16).replace("T", " ");
        await s.put("note", { title: title, body: text });
        /* `read` looks notes up by title, and this title is generated,
           so saying only "saved" hands you a note you have no name
           for. Naming it is what makes  read <that> | words | count
           possible without listing everything first.

           Quoted, and that is not decoration: a timestamp is digits
           with hyphens and a colon in it, and unquoted the tokenizer
           reads 2026-08-21 as arithmetic — 2026, minus 8, minus 21.
           An echoed command that does not run when you paste it back
           is worse than no echo at all. */
        c.print("saved as \"" + title + "\"", "ok");
        c.print("  read it back with   read \"" + title + "\"", "dim");
      } });

    /* -- scripts -- */
    C({ name: "scripts", group: "scripts", usage: "scripts",
      help: "List saved scripts.",
      run: function (c) {
        if (!scripts.length) { c.print("no saved scripts. Write one and use  save <name>", "dim"); return; }
        scripts.forEach(function (s) {
          var lines = String(s.data.body || "").split("\n").length;
          c.print("  " + s.data.name + new Array(Math.max(1, 18 - s.data.name.length)).join(" ") +
            lines + " line(s)   " + (s.meta.author || "-"));
        });
      } });

    C({ name: "show", group: "scripts", usage: "show <name>", minArgs: 1,
      help: "Print a saved script without running it.",
      run: function (c) {
        var s = findScript(String(c.args[0]));
        if (!s) { c.print("no script called '" + c.args[0] + "'", "bad"); return; }
        printBlock(s.data.body, "dim");
      } });

    C({ name: "run", group: "scripts", usage: "run <name>", minArgs: 1,
      help: "Run a saved script.",
      run: async function (c) {
        var s = findScript(String(c.args[0]));
        if (!s) { c.print("no script called '" + c.args[0] + "'", "bad"); return; }
        /* Runs in its own VARIABLE environment — sharing variables
           with the caller would make a script's behaviour depend on
           whatever you happened to type before it.

           But it prints through the CALLER's sink, not straight to
           the pane. Writing to the pane directly worked in the
           terminal and was wrong everywhere else: a nested `run`
           would bypass the caller's output cap, and anything
           driving the interpreter without a DOM got silence. */
        await cs.run(s.data.body, {
          print: function (t, cls) { c.print(t, cls); },
          guest: isGuest()
        });
      } });

    C({ name: "forget", group: "scripts", usage: "forget <name>", minArgs: 1,
      help: "Delete a saved script.",
      run: async function (c) {
        var s = findScript(String(c.args[0]));
        if (!s) { c.print("no script called '" + c.args[0] + "'", "bad"); return; }
        await svc("store").remove(s.id);
        await loadScripts();
        c.print("deleted", "warn");
      } });
  }

  function findScript(name) {
    var n = String(name).toLowerCase();
    return scripts.filter(function (s) {
      return String(s.data.name || "").toLowerCase() === n;
    })[0] || null;
  }

  /* ---- the setup walk-through ---------------------------------
     Reads live state rather than a stored checklist, so it cannot
     drift out of date and cannot be wrong after a restore. Each
     step reports done/not-done and, when not done, exactly one
     next action. */
  async function runSetup(c) {
    var s = svc("store");
    var r = svc("transportRelay");
    var f = svc("files");
    var settings = svc("settings");

    var steps = [];

    var hasRelay = !!(r && r.url());
    steps.push({
      ok: hasRelay, title: "Relay URL configured",
      todo: "Open RELAY LINK and enter the relay's address. If you have not deployed " +
            "the relay yet, upload relay/ to Pterodactyl first — see relay/README.md."
    });

    var relayUp = false, relayFeatures = null, relayHasVault = false;
    if (hasRelay) {
      try {
        var h = await r.health();
        relayUp = !!h.up;
        relayFeatures = h.features || null;
        relayHasVault = !!h.vaultProvisioned;
      } catch (e) { relayUp = false; }
    }
    steps.push({
      ok: relayUp, title: "Relay reachable",
      skip: !hasRelay,
      todo: "The address is set but nothing answered. Open LINK DOCTOR — it tells " +
            "blocked apart from refused, which is the difference between a firewall " +
            "and a relay that is not running."
    });

    steps.push({
      ok: relayHasVault, title: "Vault provisioned on the relay",
      skip: !relayUp,
      todo: "The relay is up but holds no vault. Set a master password in FieldKit — " +
            "you will need the provisionToken from the relay's config.json once, and " +
            "can blank it afterwards."
    });

    var unlocked = !!(s && s.isUnlocked());
    steps.push({
      ok: unlocked, title: "Vault unlocked in this session",
      skip: !relayHasVault,
      todo: "Enter your master password at the gate."
    });

    var name = settings && settings.get("displayName");
    steps.push({
      ok: !!name, title: "Display name set",
      todo: "Two people share this vault, so every record carries an author. Set yours:  " +
            "set displayName YourName"
    });

    var blobs = f && f.capabilities().available;
    steps.push({
      ok: !!blobs, title: "Encrypted file storage available",
      skip: !relayUp,
      todo: "The relay is running a build from before file storage existed. " +
            "Re-upload relay/server.js — nothing else changes."
    });

    var backup = svc("backup");
    var lastBackup = null;
    try { lastBackup = backup && backup.lastBackupAt && backup.lastBackupAt(); }
    catch (e) { lastBackup = null; }
    steps.push({
      ok: !!lastBackup, title: "A backup exists",
      skip: !unlocked,
      todo: "Open BACKUP and build an archive. Do this the first day there is anything " +
            "in the vault worth losing — snapshots live in the browser profile, not on the drive."
    });

    var ai = svc("ai");
    var aiOk = false;
    try {
      if (ai) {
        var av = await ai.availability();
        aiOk = av[1].available || av[2].available;
      }
    } catch (e) { aiOk = false; }
    steps.push({
      ok: aiOk, title: "An AI tier above heuristics is reachable", optional: true,
      todo: "Optional. Start LM Studio with 'Serve on Local Network' and add it to the " +
            "relay's aiTargets, or load a local model in AI LOCAL. Tier 3 heuristics work " +
            "regardless."
    });

    var done = 0, firstTodo = null;
    steps.forEach(function (st) {
      var cls = st.ok ? "ok" : (st.skip ? "dim" : (st.optional ? "warn" : "bad"));
      var mark = st.ok ? "[x]" : (st.skip ? "[ ]" : (st.optional ? "[~]" : "[ ]"));
      c.print(mark + " " + st.title, cls);
      if (st.ok) done++;
      else if (!st.skip && !firstTodo && !st.optional) firstTodo = st;
    });

    c.print("");
    c.print(done + " of " + steps.length + " complete", done === steps.length ? "ok" : "");
    if (firstTodo) {
      c.print("");
      c.print("NEXT: " + firstTodo.title, "accent");
      printBlock("  " + firstTodo.todo);
    } else if (done < steps.length) {
      c.print("Everything required is done. The rest is optional.", "ok");
    }
  }

  /* ---- running what was typed ---------------------------------- */
  async function submit() {
    if (running) return;
    var src = nodes.input.value;
    if (!src.trim()) return;

    history.unshift(src);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    histAt = -1;

    printBlock(src.split("\n").map(function (l) { return "> " + l; }).join("\n"), "echo");
    nodes.input.value = "";
    autosize();

    running = true;
    nodes.runBtn.disabled = true;
    var t0 = Date.now();
    try {
      var res = await cs.run(src, { print: print, guest: isGuest() });
      var ms = Date.now() - t0;
      if (ms > 400) print("(" + res.steps + " steps, " + ms + " ms)", "dim");
    } catch (e) {
      print(e.message, "bad");
    } finally {
      running = false;
      nodes.runBtn.disabled = false;
      nodes.input.focus();
    }
  }

  function autosize() {
    if (!nodes.input) return;
    nodes.input.style.height = "auto";
    nodes.input.style.height = Math.min(200, Math.max(28, nodes.input.scrollHeight)) + "px";
  }

  async function loadScripts() {
    try { scripts = await ctx.store.list(TYPE); }
    catch (e) { scripts = []; }
    renderScriptBar();
  }

  function renderScriptBar() {
    if (!nodes.bar) return;
    ui.clear(nodes.bar);
    scripts.slice(0, 12).forEach(function (s) {
      nodes.bar.appendChild(el("button", {
        class: "tm-chip", type: "button", text: s.data.name,
        onclick: function () {
          nodes.input.value = "run " + s.data.name;
          submit();
        }
      }));
    });
  }

  async function saveCurrent() {
    var body = nodes.input.value;
    if (!body.trim()) { ui.toast("NOTHING TO SAVE", "warn"); return; }
    var chk = cs.check(body);
    if (!chk.ok) {
      /* Refusing here is the point: a saved script that fails to
         parse next week is worse than one that never saved, and
         the error is right in front of you now. */
      ui.toast("WILL NOT SAVE A SCRIPT THAT DOES NOT PARSE", "fail");
      print(chk.error, "bad");
      return;
    }
    var name = prompt("Save this script as:");
    if (!name) return;
    name = String(name).trim().slice(0, 40);
    if (!name) return;

    var existing = findScript(name);
    if (existing && !confirm("Replace the saved script '" + name + "'?")) return;

    await ctx.store.put(TYPE, { name: name, body: body },
      { id: existing ? existing.id : undefined });
    await loadScripts();
    ui.toast("SAVED AS " + name.toUpperCase(), "ok");
  }

  var LANGUAGE_HELP = [
    "CRITTERSCRIPT — one rule: $name is a variable, everything else is a literal.",
    "",
    "  say hello world          prints: hello world",
    "  let count = 3            $count is now 3",
    "  say $count               prints: 3",
    "  say \"count is $count\"    quotes interpolate too",
    "  say (2 + 2 * 3)          brackets mean 'evaluate this'",
    "",
    "BLOCKS close with 'end':",
    "",
    "  if $count > 2",
    "    say lots",
    "  else",
    "    say few",
    "  end",
    "",
    "  repeat 3",
    "    say tick",
    "  end",
    "",
    "  while $count > 0",
    "    say $count",
    "    let count = $count - 1",
    "  end",
    "",
    "  for name in (list a b c)",
    "    say $name",
    "  end",
    "",
    "  if $n == 1",
    "    say one",
    "  elif $n == 2",
    "    say two",
    "  else",
    "    say many",
    "  end",
    "",
    "  break     leaves the loop        continue  skips to the next turn",
    "",
    "BRACKETS RUN A COMMAND and hand back its answer, which is how you",
    "use one command's result in another:",
    "",
    "  let n = (count (list a b c))     n is 3",
    "  say (upper hello)                prints: HELLO",
    "  for i in (range 1 5)             1 2 3 4 5",
    "",
    "  Without brackets a command prints its answer instead of",
    "  handing it back. That is the whole difference.",
    "",
    "YOUR OWN COMMANDS with def ... end:",
    "",
    "  def greet who",
    "    say hello $who",
    "  end",
    "  greet Ada                        prints: hello Ada",
    "",
    "  return hands a value back:  let x = (double 4)",
    "  A def has its own variables — it cannot see or change yours.",
    "  $args holds everything that was passed.",
    "",
    "WORKING WITH VALUES",
    "  list a b c        make a list        count $l      how many",
    "  item $l 2         the 2nd (1-based)  item $l -1    the last",
    "  add $l d          a longer copy      has $l b      true/false",
    "  split \"a b c\"     text into a list   join $l -     list into text",
    "  range 5           1..5               range 2 4     2..4",
    "  upper lower trim round",
    "",
    "OPERATORS  + - * / %   ==  !=  <  >  <=  >=   and  or  not",
    "COMMENTS   # to the end of the line",
    "",
    "TWO THINGS THAT CATCH PEOPLE OUT",
    "  Arguments are one word each, so  f $n - 1  passes three things.",
    "  For arithmetic, use brackets:    f ($n - 1)",
    "  A minus glued to digits is a negative number:  item $l -1",
    "",
    "Shift+Enter for a new line, Enter to run. Up/Down walks history.",
    "There are budgets: a runaway loop stops itself rather than hanging the tab."
  ].join("\n");

  function injectCSS() {
    if (document.getElementById("tm-style")) return;
    var s = document.createElement("style");
    s.id = "tm-style";
    s.textContent = [
      ".tm-wrap{display:flex;flex-direction:column;height:100%;gap:6px}",
      ".tm-out{flex:1 1 auto;overflow:auto;font-size:12.5px;line-height:1.5;padding:6px 8px;background:rgba(0,0,0,0.22);white-space:pre-wrap}",
      ".tm-line{white-space:pre-wrap;word-break:break-word}",
      ".tm-line.echo{opacity:.55}",
      ".tm-line.dim{opacity:.55}",
      ".tm-line.ok{color:var(--fk-ok)}",
      ".tm-line.warn{color:var(--fk-warn)}",
      ".tm-line.bad{color:var(--fk-fail)}",
      ".tm-line.accent{color:var(--fk-accent)}",
      ".tm-bar{display:flex;gap:4px;flex-wrap:wrap;flex:0 0 auto}",
      ".tm-chip{background:none;border:1px solid var(--fk-line);color:inherit;font:inherit;font-size:10px;letter-spacing:.05em;padding:1px 7px;cursor:pointer}",
      ".tm-chip:hover{border-color:var(--fk-accent);color:var(--fk-accent)}",
      ".tm-inputrow{display:flex;gap:6px;align-items:flex-end;flex:0 0 auto}",
      ".tm-input{flex:1;font:inherit;font-size:12.5px;resize:none;min-height:28px;line-height:1.45}",
      ".tm-actions{display:flex;gap:6px;flex:0 0 auto}"
    ].join("");
    document.head.appendChild(s);
  }

  function selfcheck(api) {
    var run = function (src) {
      var lines = [];
      return cs.run(src, { print: function (t) { lines.push(String(t)); } })
        .then(function () { return lines.join("\n"); });
    };

    return [
      { name: "THE ONE RULE HOLDS", critical: true, run: async function () {
        /* If bare words ever start resolving as variables, every
           script anyone writes silently changes meaning. */
        var out = await run('let name = Ada\nsay hello name\nsay hello $name');
        if (out !== "hello name\nhello Ada") {
          throw new Error("bare word / variable split is wrong: " + JSON.stringify(out));
        }
        return "$name is a variable, everything else is literal";
      } },

      { name: "ARITHMETIC AND COMPARISON", critical: false, run: async function () {
        var out = await run([
          "say (2 + 3 * 4)",
          "say (10 / 4)",
          "say (7 % 3)",
          "let a = 5",
          "if $a >= 5 and $a < 10",
          "  say inrange",
          "end",
          "if not ($a == 5)",
          "  say wrong",
          "else",
          "  say right",
          "end"
        ].join("\n"));
        if (out !== "14\n2.5\n1\ninrange\nright") {
          throw new Error("got " + JSON.stringify(out));
        }
        return "precedence, division, modulo, and/or/not, if/else";
      } },

      { name: "INTERPOLATION ONLY INSIDE QUOTES", critical: false, run: async function () {
        var out = await run('let n = 4\nsay "n is $n"\nsay n is $n');
        if (out !== "n is 4\nn is 4") throw new Error("got " + JSON.stringify(out));
        var miss = await run('say "x=$nope."');
        if (miss !== "x=.") throw new Error("unknown var in a string should vanish: " + JSON.stringify(miss));
        return "quoted and bare both interpolate; unknown names resolve empty";
      } },

      { name: "LOOPS RUN AND TERMINATE", critical: false, run: async function () {
        var out = await run("repeat 3\n  say tick\nend");
        if (out !== "tick\ntick\ntick") throw new Error("repeat: " + JSON.stringify(out));
        var w = await run("let i = 3\nwhile $i > 0\n  say $i\n  let i = $i - 1\nend");
        if (w !== "3\n2\n1") throw new Error("while: " + JSON.stringify(w));
        return "repeat and while both terminate correctly";
      } },

      { name: "A RUNAWAY LOOP STOPS ITSELF", critical: true, run: async function () {
        /* The property that makes this safe to hand to someone on
           a Chromebook. Without it, `while true` is a lost session
           — reload means re-entering the vault password. */
        var threw = null;
        try { await run("while true\n  let x = 1\nend"); }
        catch (e) { threw = e; }
        if (!threw) throw new Error("an infinite loop ran to completion, which is impossible");
        if (!/stopped|limit/i.test(threw.message)) {
          throw new Error("stopped, but unhelpfully: " + threw.message);
        }
        return "infinite loop halted with an explanation";
      } },

      { name: "OUTPUT IS CAPPED", critical: true, run: async function () {
        var threw = null;
        /* Deliberately under the iteration ceiling and far over the
           output one, so this proves the OUTPUT cap fires and not
           the loop cap. Derived from the module's own constants —
           a fixed number here silently stopped testing anything
           the moment MAX_LOOP was lowered. */
        var n = Math.min(cs.MAX_LOOP - 1, cs.MAX_OUTPUT * 5);
        try { await run("repeat " + n + "\n  say x\nend"); }
        catch (e) { threw = e; }
        if (!threw) throw new Error("unbounded output was allowed");
        if (!/lines/i.test(threw.message)) throw new Error("wrong cap hit: " + threw.message);
        return "output ceiling holds at " + cs.MAX_OUTPUT + " lines";
      } },

      { name: "ERRORS NAME THE LINE", critical: false, run: async function () {
        var threw = null;
        try { await run("say ok\nsay ok\nnosuchcommand\n"); }
        catch (e) { threw = e; }
        if (!threw) throw new Error("an unknown command did not fail");
        if (!/line 3/.test(threw.message)) {
          throw new Error("no line number: " + threw.message);
        }
        if (!/nosuchcommand/.test(threw.message)) {
          throw new Error("did not name the command: " + threw.message);
        }
        return "unknown command reported with its line";
      } },

      { name: "UNCLOSED BLOCKS ARE CAUGHT BEFORE RUNNING", critical: false, run: async function () {
        var r1 = cs.check("if true\n  say hi");
        if (r1.ok) throw new Error("an unclosed if parsed cleanly");
        if (!/never closed/i.test(r1.error)) throw new Error("unhelpful: " + r1.error);
        var r2 = cs.check("say hi\nend");
        if (r2.ok) throw new Error("a stray end parsed cleanly");
        var good = cs.check("if true\n  say hi\nend");
        if (!good.ok) throw new Error("valid script rejected: " + good.error);
        return "check() catches structure before anything executes";
      } },

      { name: "DIVISION BY ZERO IS AN ERROR, NOT INFINITY", critical: false, run: async function () {
        var threw = null;
        try { await run("say (1 / 0)"); } catch (e) { threw = e; }
        if (!threw) throw new Error("1/0 produced a value");
        if (!/divide by zero/i.test(threw.message)) throw new Error(threw.message);
        return "refuses rather than printing Infinity";
      } },

      { name: "COMMAND NAMES CANNOT COLLIDE WITH OBJECT KEYS", critical: true, run: async function () {
        /* The registry is keyed by user-supplied-ish strings. On a
           plain {} a command called "constructor" returns a
           function and the interpreter tries to call it. */
        var c = cs.get("constructor");
        if (c) throw new Error("'constructor' resolved to something");
        var t = cs.get("toString");
        if (t) throw new Error("'toString' resolved to something");
        return "null-prototype registry, no inherited keys";
      } },

      { name: "BRACKETS HAND BACK A VALUE INSTEAD OF PRINTING", critical: false, run: async function () {
        /* The single idea the rest of v2 rests on. If a call in
           expression position printed instead of returning, every
           `let x = (something)` on the drive would set x to
           nothing and spray the answer at the screen. */
        var out = await run("let n = (count (list a b c))\nsay $n");
        if (out !== "3") throw new Error("expected 3, got: " + JSON.stringify(out));
        var loose = await run("count (list a b c)");
        if (loose !== "3") throw new Error("a bare call should print: " + JSON.stringify(loose));
        return "( ) returns, a bare command prints";
      } },

      { name: "FOR AND ELIF PICK THE RIGHT BRANCH", critical: false, run: async function () {
        var out = await run("for i in (range 3)\n if $i == 1\n  say one\n elif $i == 2\n  say two\n else\n  say many\n end\nend");
        if (out !== "one\ntwo\nmany") throw new Error("chain mis-ordered: " + JSON.stringify(out));
        /* An elif chain that swallowed the statements after its
           own `end` would run the rest of the script only when
           the first condition was false — invisibly. */
        var after = await run("if true\n say a\nelif true\n say b\nend\nsay after");
        if (after !== "a\nafter") throw new Error("statements after the chain were captured: " + JSON.stringify(after));
        return "branches select correctly and the chain ends where it says";
      } },

      { name: "FUNCTIONS SHARE THE RUN'S BUDGETS", critical: true, run: async function () {
        /* If a call got a fresh allowance, runaway recursion would
           spin until the tab died — and on the Chromebook a dead
           tab costs the unlocked vault. */
        var threw = null;
        try { await run("def f\n return (f)\nend\nsay (f)"); } catch (e) { threw = e; }
        if (!threw) throw new Error("infinite recursion completed");
        if (!/nested more than|steps|budget/i.test(threw.message)) throw new Error(threw.message);
        var scoped = await run("let x = outer\ndef f\n let x = inner\nend\nf\nsay $x");
        if (scoped !== "outer") throw new Error("a def wrote into the caller's variables");
        return "depth capped at " + cs.MAX_CALL_DEPTH + ", scopes stay separate";
      } },

      { name: "A COMMAND NAME CANNOT BE QUIETLY TAKEN TWICE", critical: true, run: async function () {
        var threw = null;
        try { cs.command({ name: "say", run: function () {} }); } catch (e) { threw = e; }
        if (!threw) throw new Error("'say' was redefined without complaint");
        if (!/already exists/i.test(threw.message)) throw new Error(threw.message);
        var still = await run("say intact");
        if (still !== "intact") throw new Error("say is damaged: " + JSON.stringify(still));
        return "registration is first-come; replacing has to be declared";
      } },

      { name: "GUEST MODE SEALS THE UNSAFE COMMANDS", critical: true, run: async function () {
        var sealed = cs.list().filter(function (c) { return !c.guestSafe; });
        if (!sealed.length) throw new Error("every command is guest-safe, which cannot be right");
        var threw = null;
        try {
          await cs.run(sealed[0].name, { print: function () {}, guest: true });
        } catch (e) { threw = e; }
        if (!threw) throw new Error("'" + sealed[0].name + "' ran in guest mode");
        if (!/guest/i.test(threw.message)) throw new Error(threw.message);
        /* And through the expression form too. The statement and
           bracket paths were separate code once; the bracket one
           had no guest check, so `let x = (sealed)` walked past
           the whole read-only mode. */
        var viaBrackets = null;
        try {
          await cs.run("let x = (" + sealed[0].name + ")",
            { print: function () {}, guest: true });
        } catch (e) { viaBrackets = e; }
        if (!viaBrackets || !/guest/i.test(viaBrackets.message)) {
          throw new Error("'(" + sealed[0].name + ")' ran in guest mode inside brackets");
        }
        /* And the ones that ARE guest-safe must not touch the vault. */
        var risky = cs.list().filter(function (c) {
          return c.guestSafe && /^(set|get|note|records|files|run|forget|open)$/.test(c.name);
        });
        if (risky.length) {
          throw new Error("vault-touching commands marked guestSafe: " +
            risky.map(function (c) { return c.name; }).join(", "));
        }
        return sealed.length + " command(s) sealed, none of them leaky";
      } },

      { name: "SETUP READS LIVE STATE", critical: false, run: async function () {
        var lines = [];
        await cs.run("setup", { print: function (t) { lines.push(String(t)); } });
        var text = lines.join("\n");
        if (!/complete/.test(text)) throw new Error("setup printed no summary");
        if (!/\[x\]|\[ \]|\[~\]/.test(text)) throw new Error("setup printed no checklist");
        /* It must never claim a step is done when the underlying
           service says otherwise — that is the failure that sends
           someone hunting for a problem they already have. */
        var s = FieldKit.service("store");
        var claimsUnlocked = /\[x\] Vault unlocked/.test(text);
        if (claimsUnlocked && !(s && s.isUnlocked())) {
          throw new Error("setup claimed the vault is unlocked when it is not");
        }
        return "checklist derived from services, not stored";
      } },

      { name: "SAVED SCRIPTS ROUND TRIP", critical: false, run: async function () {
        var marker = "selftest" + Math.random().toString(36).slice(2, 7);
        var meta = await ctx.store.put(TYPE, { name: marker, body: "say fromscript" });
        api.sandbox.track(meta.id);
        await loadScripts();
        var lines = [];
        await cs.run("run " + marker, { print: function (t) { lines.push(String(t)); } });
        if (lines.join("\n") !== "fromscript") {
          throw new Error("saved script did not run: " + JSON.stringify(lines));
        }
        await ctx.store.remove(meta.id);
        await loadScripts();
        return "saved, listed, executed, deleted";
      } }
    ];
  }

  FieldKit.register("terminal", {
    group: "TOOLS",
    about: "Type commands to drive FieldKit, and run CritterScript",
    keywords: "terminal command line shell console prompt",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "TERMINAL",
    icon: "▮",
    width: 820,
    height: 560,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      cs = FieldKit.need("critterscript");
      injectCSS();
      registerBuiltins();     // a no-op after the first time; kept for a late load

      nodes.out = el("div", { class: "tm-out" });
      nodes.bar = el("div", { class: "tm-bar" });
      nodes.input = el("textarea", {
        class: "fk-input tm-input", spellcheck: "false", rows: "1",
        placeholder: "type a command — 'help' for the list, 'setup' for where you are"
      });

      nodes.input.addEventListener("input", autosize);
      nodes.input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); return; }
        /* History only when the caret is on the first/last line, so
           arrow keys still edit a multi-line script normally. */
        if (e.key === "ArrowUp" && this.selectionStart === 0 && history.length) {
          e.preventDefault();
          histAt = Math.min(histAt + 1, history.length - 1);
          this.value = history[histAt];
          autosize();
        }
        if (e.key === "ArrowDown" && this.selectionStart === this.value.length) {
          if (histAt <= 0) { histAt = -1; this.value = ""; }
          else { histAt--; this.value = history[histAt]; }
          e.preventDefault();
          autosize();
        }
      });

      nodes.runBtn = ui.button("RUN", submit, { primary: true });

      host.appendChild(el("div", { class: "tm-wrap" }, [
        nodes.out,
        nodes.bar,
        el("div", { class: "tm-inputrow" }, [
          nodes.input,
          el("div", { class: "tm-actions" }, [
            nodes.runBtn,
            ui.button("SAVE", saveCurrent),
            ui.button("CLEAR", function () { ui.clear(nodes.out); })
          ])
        ])
      ]));

      print("FieldKit terminal — critterscript v" + cs.VERSION, "accent");
      print("This drives FieldKit, not the machine. There is no shell here.", "dim");
      print("Try:  help   ·   setup   ·   language", "dim");
      print("");

      await loadScripts();
      nodes.input.focus();
    },

    unmount() {
      nodes = {}; history = []; histAt = -1; scripts = []; running = false;
    },

    searchIndex() {
      return [{
        id: "terminal", module: "terminal",
        title: "TERMINAL — critterscript",
        /* The spec, when CRITTERSCRIPT is loaded. Indexing the local
           fallback instead would let the palette answer questions
           about a version of the language that is no longer here. */
        body: "terminal command line script critterscript setup doctor " +
          (function () {
            var ref = svc("critterRef");
            return ref ? ref.plainText() : LANGUAGE_HELP;
          })()
      }].concat(scripts.map(function (s) {
        return { id: s.id, module: "terminal", title: "SCRIPT: " + s.data.name, body: s.data.body };
      }));
    }
  });

  /* At load. See the comment on registerBuiltins: anything that
     reads the command registry — CRITTERSCRIPT's list, its export,
     the command palette — has to see the whole language whether or
     not this window has ever been opened. */
  registerBuiltins();
})(window.FieldKit);
