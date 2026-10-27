/* ============================================================
   FieldKit :: critter-ref
   CritterScript, written down.

   This module is the language's documentation AND its export
   route, and it exists as a module rather than a help section for
   one reason: the language is meant to outlive this drive. If
   CritterScript is ever going to be picked up and made real
   somewhere else, whoever does that needs the whole specification
   in one place, in one file, in a format a tool can read — not
   spread across a terminal help string, a source file's comments
   and somebody's memory.

   So: EXPORT is not a convenience tab bolted on the end. It is the
   point of the module. Everything else here is the same data
   rendered for a person instead of for a parser.

   THE COMMAND LIST IS NOT WRITTEN DOWN HERE

   It is read from the live registry at render time. A hand-kept
   list of commands in a documentation file is wrong the first time
   anybody adds a command and silently wrong forever after, and
   this is precisely the file where being silently wrong does the
   most damage — it is the file you would trust when rebuilding the
   language from scratch.

   The prose, the rules and the recipes ARE written down here,
   because there is nowhere to read them from. They are the part
   that has to be maintained by hand, and keeping them in one
   object at the top of one file is the cheapest way to make that
   maintainable.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, tab = "learn", filter = "";

  function cs() { return FieldKit.service("critterscript"); }

  /* ---- the specification ----------------------------------------
     Data, not markup. Everything on screen and everything in both
     exports is rendered from this, so there is exactly one copy of
     each sentence and no way for the tab you are reading to
     disagree with the file you exported. */
  var SPEC = {
    name: "CritterScript",
    tagline: "A small language you can read out loud.",

    intro: [
      "CritterScript is the language built into FieldKit's terminal. It was written " +
      "for two people who write Godot code all day and did not want a second real " +
      "programming language to keep in their heads — so it has no types, no " +
      "declarations, no punctuation to balance, and three rules total.",
      "It is deliberately unlike other languages in one specific way: there is no " +
      "syntax for 'this is a string'. Everything is text unless it starts with a " +
      "dollar sign. That single decision removes quoting from about ninety percent " +
      "of the lines you will ever write."
    ],

    rules: [
      {
        rule: "$name is a variable. Everything else is a literal.",
        why: "No quotes around ordinary words, ever. The dollar sign is the only " +
          "thing that means 'look this up'.",
        code: [
          "say hello world          # prints: hello world",
          "let who = Ada",
          "say hello $who           # prints: hello Ada",
          "say \"hello, $who!\"       # quotes interpolate too"
        ]
      },
      {
        rule: "| sends the answer along.",
        why: "The answer of the step on the left becomes the first argument of the " +
          "step on the right. If the right-hand step mentions $it, the answer goes " +
          "there instead and nothing is prepended.",
        code: [
          "list 3 1 10 2 | sort | join \", \"      # 1, 2, 3, 10",
          "read notes | lines | count             # how many lines",
          "list x y z | count | say \"there are $it items\""
        ]
      },
      {
        rule: "-> names the answer.",
        why: "At the end of a line, -> puts the result in a variable instead of " +
          "printing it. It replaces most uses of let.",
        code: [
          "split \"a,b,c\" , | count -> $n",
          "say \"there are $n\"",
          "find godot navmesh | first -> $top"
        ]
      }
    ],

    /* Why this is worth a section of its own: it is the change that
       makes v3 a different language rather than v2 with extras. The
       before/after is the fastest way to show that. */
    shape: {
      title: "What the pipe changed",
      body: [
        "Version 2 had brackets and let, and read inside-out like every other " +
        "language — the first thing that happens is buried deepest:"
      ],
      before: [
        "let words = (split (read notes) \" \")",
        "let n = (count $words)",
        "say \"there are $n words\""
      ],
      after: [
        "read notes | split \" \" | count -> $n",
        "say \"there are $n words\""
      ],
      tail: [
        "Both still work. Brackets did not go away and neither did let — a bracket " +
        "is still how you use one command's answer in the middle of an expression. " +
        "But left-to-right is now the normal way to write a line, and it happens to " +
        "be the order the work actually occurs in."
      ]
    },

    sections: [
      {
        id: "values",
        title: "Values",
        body: [
          "There are six kinds of value: text, numbers, yes-or-no, lists, records, " +
          "and nothing. You never declare which one you have — kind tells you.",
          "A record is a plain set of named fields, and it is deliberately the same " +
          "shape JSON parses into, so json hands you something the rest of the " +
          "language already understands with no conversion step."
        ],
        code: [
          "list a b c            # a list",
          "record name Ada age 30",
          "kind (list a b)       # a list",
          "json \"{\\\"a\\\": 1}\"    # a record"
        ]
      },
      {
        id: "quotes",
        title: "Quotes and spaces",
        body: [
          "Quotes are only needed when a value contains a space, or when you want " +
          "$name substituted inside a longer sentence. Both \"double\" and 'single' " +
          "quotes work and both interpolate.",
          "Arguments are one word each. This catches everybody once: writing " +
          "f $n - 1 passes three separate arguments, not a subtraction. Put " +
          "arithmetic in brackets."
        ],
        code: [
          "say \"two words\"        # one argument",
          "say two words          # two arguments, same output",
          "f ($n - 1)             # one argument: the number",
          "item $l -1             # a minus glued to digits is a negative number"
        ]
      },
      {
        id: "brackets",
        title: "Brackets run a command and hand back its answer",
        body: [
          "Without brackets a command prints its answer. With brackets it hands the " +
          "answer back to whatever is around it. That is the entire difference, and " +
          "it is why say (upper hello) prints HELLO while upper hello prints it too " +
          "but cannot be used in a bigger expression."
        ],
        code: [
          "let n = (count (list a b c))    # n is 3",
          "say (upper hello)               # HELLO",
          "for i in (range 1 5)            # 1 2 3 4 5"
        ]
      },
      {
        id: "blocks",
        title: "Blocks close with end",
        body: [
          "if / elif / else, repeat, while and for all close with end. There are no " +
          "braces and indentation is for you, not for the parser."
        ],
        code: [
          "if $n == 1",
          "  say one",
          "elif $n == 2",
          "  say two",
          "else",
          "  say many",
          "end",
          "",
          "repeat 3",
          "  say tick",
          "end",
          "",
          "while $n > 0",
          "  say $n",
          "  let n = $n - 1",
          "end",
          "",
          "for name in (list a b c)",
          "  say $name",
          "end",
          "",
          "break     # leave the loop",
          "continue  # skip to the next turn"
        ]
      },
      {
        id: "def",
        title: "Your own commands",
        body: [
          "def ... end makes a command that behaves exactly like a built-in one, " +
          "brackets and pipes included. A def has its own variables and cannot see " +
          "or change yours — that is on purpose, and it is why a script you pasted " +
          "from somewhere cannot quietly rewrite your $count.",
          "$args holds everything that was passed, as a list."
        ],
        code: [
          "def greet who",
          "  say hello $who",
          "end",
          "greet Ada              # hello Ada",
          "",
          "def double n",
          "  return ($n * 2)",
          "end",
          "let x = (double 4)     # 8",
          "list 1 2 3 | first | double"
        ]
      },
      {
        id: "operators",
        title: "Operators and comments",
        body: [
          "Arithmetic and comparison work as you would expect, inside brackets or " +
          "after let. Dividing by zero is an error rather than infinity, because " +
          "infinity is never the answer anybody wanted."
        ],
        code: [
          "+  -  *  /  %",
          "==  !=  <  >  <=  >=",
          "and  or  not",
          "# a hash comments out the rest of the line"
        ]
      },
      {
        id: "budgets",
        title: "It stops itself",
        body: [
          "Every run has budgets: a step ceiling, a loop ceiling, an output ceiling " +
          "and a call-depth ceiling. A runaway loop stops with a message naming the " +
          "line instead of hanging the tab. This matters more than it sounds like " +
          "it should — the terminal runs on the same page as the vault, and a script " +
          "that can freeze the tab is a script that can lose unsaved work."
        ],
        code: []
      },
      {
        id: "net",
        title: "The commands that leave the drive",
        body: [
          "fetch, find, ask, sum-up, services and uptime go through the relay. They " +
          "are the reason the language is worth having on a USB stick: a page opened " +
          "from a file:// URL cannot read one line of the web at any length of code, " +
          "because no cross-origin fetch exists there to write. Through the relay it " +
          "becomes one word.",
          "None of them change anything. There is no restart, no action runner, no " +
          "config write — a script is something you paste from a chat window and run " +
          "to see what it does, and that has to stay a safe thing to do.",
          "All of them need the vault open, and none of them work in guest mode."
        ],
        code: [
          "fetch example.com | field title",
          "find godot navmesh | first | field url | fetch $it | field text | sum-up",
          "services | where ok false | pluck name"
        ]
      }
    ],

    recipes: [
      {
        title: "Count the words in a note",
        code: ["read notes | words | count"]
      },
      {
        title: "The five longest lines of a file",
        code: [
          "read design.md | lines -> $l",
          "for line in $l",
          "  say (count $line)",
          "end"
        ]
      },
      {
        title: "Ask the web a question and keep the answer short",
        code: [
          "find how to bake sourdough | first -> $hit",
          "say (field $hit title)",
          "fetch (field $hit url) | field text | sum-up"
        ]
      },
      {
        title: "Which Bastion services are down",
        code: ["services | where ok false | pluck name -> $bad", "say \"down: $bad\""]
      },
      {
        title: "Pull one field out of a JSON API",
        code: ["fetch https://example.com/api.json | field text | json | field version"]
      },
      {
        title: "Read a page and have the AI pick out the steps",
        code: [
          "fetch $url | field text -> $page",
          "ask \"list the steps in this, one per line: $page\" | lines"
        ]
      },
      {
        title: "Turn a list of records into a table you can paste",
        code: ["find godot tilemap | first 5 -> $r", "for x in $r", "  say (field $x url)", "end"]
      }
    ],

    gotchas: [
      "Arguments are one word each. f $n - 1 is three arguments; f ($n - 1) is one.",
      "A command with no answer cannot be piped — say prints, it does not produce. " +
      "The error says so by name rather than silently passing nothing along.",
      "$it only exists inside a pipeline, and only after the first step.",
      "Command names are lowercase and may contain hyphens: sum-up is one word.",
      "Quote anything that starts with a digit and then is not just digits. " +
      "A bare 2026-08-21 reads as arithmetic — 2026, minus 8, minus 21 — because " +
      "a token beginning with a digit is a number. Dates, times, versions and ids " +
      "want quotes: read \"terminal 2026-08-21 15:04\".",
      "Registering a command name that already exists is an error, not a silent " +
      "replacement, because a quiet replacement changes what every saved script does."
    ]
  };

  /* ---- rendering the same data three ways ------------------------ */

  function commandList() {
    var c = cs();
    if (!c) return [];
    return c.list().map(function (x) {
      return {
        name: x.name,
        group: x.group || "general",
        usage: x.usage || x.name,
        help: x.help || "",
        guestSafe: !!x.guestSafe,
        minArgs: x.minArgs || 0
      };
    });
  }

  function grouped() {
    var out = {}, order = [];
    commandList().forEach(function (c) {
      if (!out[c.group]) { out[c.group] = []; order.push(c.group); }
      out[c.group].push(c);
    });
    order.sort();
    return order.map(function (g) { return { group: g, commands: out[g] }; });
  }

  function limits() {
    var c = cs();
    if (!c) return {};
    return {
      version: c.VERSION,
      maxSteps: c.MAX_STEPS,
      maxOutput: c.MAX_OUTPUT,
      maxLoop: c.MAX_LOOP,
      maxCallDepth: c.MAX_CALL_DEPTH
    };
  }

  /* ---- export: markdown ------------------------------------------
     Markdown rather than HTML because the destination is a repo, a
     wiki or another chat window, and all three take Markdown. The
     command table is a real table so it survives being pasted
     somewhere that renders it. */
  function toMarkdown() {
    var L = limits();
    var out = [];
    function p(s) { out.push(s === undefined ? "" : s); }
    function code(lines) {
      if (!lines || !lines.length) return;
      p("```"); lines.forEach(p); p("```"); p();
    }

    p("# " + SPEC.name + " v" + (L.version || "?"));
    p();
    p("> " + SPEC.tagline);
    p();
    SPEC.intro.forEach(function (t) { p(t); p(); });

    p("## The three rules");
    p();
    SPEC.rules.forEach(function (r, i) {
      p("### " + (i + 1) + ". " + r.rule);
      p();
      p(r.why);
      p();
      code(r.code);
    });

    p("## " + SPEC.shape.title);
    p();
    SPEC.shape.body.forEach(function (t) { p(t); p(); });
    p("Before:");
    p();
    code(SPEC.shape.before);
    p("After:");
    p();
    code(SPEC.shape.after);
    SPEC.shape.tail.forEach(function (t) { p(t); p(); });

    SPEC.sections.forEach(function (s) {
      p("## " + s.title);
      p();
      s.body.forEach(function (t) { p(t); p(); });
      code(s.code);
    });

    p("## Every command");
    p();
    p("Read from the live registry at export time, so this list cannot drift out " +
      "of date. `guest` marks the commands that stay available in guest mode — " +
      "everything unmarked touches the vault, the relay or the machine.");
    p();
    grouped().forEach(function (g) {
      p("### " + g.group);
      p();
      p("| command | usage | guest | what it does |");
      p("| --- | --- | --- | --- |");
      g.commands.forEach(function (c) {
        p("| `" + c.name + "` | `" + c.usage.replace(/\|/g, "\\|") + "` | " +
          (c.guestSafe ? "yes" : "no") + " | " + c.help.replace(/\|/g, "\\|") + " |");
      });
      p();
    });

    p("## Recipes");
    p();
    SPEC.recipes.forEach(function (r) {
      p("**" + r.title + "**");
      p();
      code(r.code);
    });

    p("## Things that catch people out");
    p();
    SPEC.gotchas.forEach(function (g) { p("- " + g); });
    p();

    p("## Limits");
    p();
    p("Every run is bounded. These are the ceilings, not suggestions.");
    p();
    p("| budget | value |");
    p("| --- | --- |");
    p("| steps | " + L.maxSteps + " |");
    p("| output lines | " + L.maxOutput + " |");
    p("| loop turns | " + L.maxLoop + " |");
    p("| call depth | " + L.maxCallDepth + " |");
    p();

    return out.join("\n");
  }

  /* ---- export: json ----------------------------------------------
     The machine-readable half. Shaped so a future implementation
     can be driven from it: the spec text and the command registry
     are separate top-level keys, because whoever rebuilds this will
     want the command table and will write their own prose. */
  function toJSON() {
    return JSON.stringify({
      language: SPEC.name,
      version: limits().version,
      exportedAt: new Date().toISOString(),
      tagline: SPEC.tagline,
      intro: SPEC.intro,
      rules: SPEC.rules,
      shape: SPEC.shape,
      sections: SPEC.sections,
      recipes: SPEC.recipes,
      gotchas: SPEC.gotchas,
      limits: limits(),
      commands: commandList()
    }, null, 2);
  }

  /* ---- export: plain text ----------------------------------------
     What the terminal's `language` command prints. Same source, so
     the help you get in the terminal cannot describe a different
     language than the one the reference tab describes. */
  function toPlainText() {
    var L = limits();
    var out = [];
    out.push(SPEC.name.toUpperCase() + " v" + (L.version || "?") + " — " + SPEC.tagline);
    out.push("");
    out.push("THREE RULES");
    SPEC.rules.forEach(function (r, i) {
      out.push("  " + (i + 1) + ". " + r.rule);
      r.code.forEach(function (c) { out.push("       " + c); });
      out.push("");
    });
    SPEC.sections.forEach(function (s) {
      out.push(s.title.toUpperCase());
      s.code.forEach(function (c) { out.push("  " + c); });
      if (!s.code.length) out.push("  " + s.body[0]);
      out.push("");
    });
    out.push("Open CRITTERSCRIPT for the full reference, every command, and export.");
    return out.join("\n");
  }

  /* ---- ui -------------------------------------------------------- */

  function show(which) {
    tab = which;
    ["learn", "commands", "recipes", "export"].forEach(function (t) {
      if (nodes["pane_" + t]) nodes["pane_" + t].style.display = (t === which) ? "" : "none";
      if (nodes["tab_" + t]) nodes["tab_" + t].className = "cr-tab" + (t === which ? " on" : "");
    });
  }

  function codeBlock(lines) {
    return el("pre", { class: "cr-code", text: lines.join("\n") });
  }

  function renderLearn() {
    var host = nodes.pane_learn;
    if (!host) return;
    ui.clear(host);
    var L = limits();

    host.appendChild(el("div", { class: "cr-title", text:
      SPEC.name + " v" + (L.version || "?") + " — " + SPEC.tagline }));
    SPEC.intro.forEach(function (t) {
      host.appendChild(el("p", { class: "cr-p", text: t }));
    });

    host.appendChild(el("div", { class: "cr-h", text: "THE THREE RULES" }));
    SPEC.rules.forEach(function (r, i) {
      host.appendChild(el("div", { class: "cr-rule" }, [
        el("div", { class: "cr-rule-n", text: String(i + 1) }),
        el("div", { class: "cr-rule-body" }, [
          el("div", { class: "cr-rule-t", text: r.rule }),
          el("div", { class: "cr-p", text: r.why }),
          codeBlock(r.code)
        ])
      ]));
    });

    host.appendChild(el("div", { class: "cr-h", text: SPEC.shape.title.toUpperCase() }));
    SPEC.shape.body.forEach(function (t) {
      host.appendChild(el("p", { class: "cr-p", text: t }));
    });
    host.appendChild(el("div", { class: "cr-ba" }, [
      el("div", {}, [el("div", { class: "cr-lbl", text: "BEFORE" }), codeBlock(SPEC.shape.before)]),
      el("div", {}, [el("div", { class: "cr-lbl", text: "AFTER" }), codeBlock(SPEC.shape.after)])
    ]));
    SPEC.shape.tail.forEach(function (t) {
      host.appendChild(el("p", { class: "cr-p", text: t }));
    });

    SPEC.sections.forEach(function (s) {
      host.appendChild(el("div", { class: "cr-h", text: s.title.toUpperCase() }));
      s.body.forEach(function (t) { host.appendChild(el("p", { class: "cr-p", text: t })); });
      if (s.code.length) host.appendChild(codeBlock(s.code));
    });

    host.appendChild(el("div", { class: "cr-h", text: "THINGS THAT CATCH PEOPLE OUT" }));
    var ul = el("ul", { class: "cr-list" });
    SPEC.gotchas.forEach(function (g) { ul.appendChild(el("li", { text: g })); });
    host.appendChild(ul);
  }

  function renderCommands() {
    var host = nodes.cmdResults;
    if (!host) return;
    ui.clear(host);

    var q = filter.trim().toLowerCase();
    var groups = grouped();
    var shown = 0;

    groups.forEach(function (g) {
      var hits = g.commands.filter(function (c) {
        if (!q) return true;
        return (c.name + " " + c.usage + " " + c.help + " " + c.group).toLowerCase().indexOf(q) >= 0;
      });
      if (!hits.length) return;
      shown += hits.length;
      host.appendChild(el("div", { class: "cr-h", text: g.group.toUpperCase() +
        "  (" + hits.length + ")" }));
      var table = el("div", { class: "cr-table" });
      hits.forEach(function (c) {
        table.appendChild(el("div", { class: "cr-row" }, [
          el("div", { class: "cr-cmd", text: c.usage }),
          el("div", { class: "cr-help", text: c.help }),
          el("div", { class: "cr-flag" + (c.guestSafe ? " ok" : ""),
            text: c.guestSafe ? "guest" : "vault" })
        ]));
      });
      host.appendChild(table);
    });

    if (!shown) {
      host.appendChild(el("div", { class: "cr-p", text:
        q ? "No command matches \"" + filter + "\"." :
            "The language did not load — this build has no terminal." }));
    }
    nodes.count.textContent = commandList().length + " COMMANDS";
  }

  function renderRecipes() {
    var host = nodes.pane_recipes;
    if (!host) return;
    ui.clear(host);
    host.appendChild(el("p", { class: "cr-p", text:
      "Whole scripts, short enough to read in one go. Copy one, open TERMINAL, " +
      "paste it and press Enter." }));
    SPEC.recipes.forEach(function (r) {
      var pre = codeBlock(r.code);
      host.appendChild(el("div", { class: "cr-recipe" }, [
        el("div", { class: "cr-recipe-head" }, [
          el("div", { class: "cr-lbl", text: r.title }),
          ui.button("COPY", function () {
            ui.copy(r.code.join("\n"), { title: r.title }).then(function (h) {
              if (h) ui.toast("COPIED", "ok");
            });
          }, { small: true })
        ]),
        pre
      ]));
    });
  }

  function renderExport() {
    var host = nodes.pane_export;
    if (!host) return;
    ui.clear(host);

    host.appendChild(el("p", { class: "cr-p", text:
      "The whole language in one file: the three rules, every syntax section, every " +
      "recipe, and the complete command table read live from the registry. This is " +
      "the tab to use if CritterScript is ever going to be rebuilt somewhere else." }));

    nodes.exportOut = el("textarea", { class: "fk-input cr-out", rows: "16", readonly: true });

    function put(text, what) {
      nodes.exportOut.value = text;
      nodes.exportLbl.textContent = what + " — " + text.length.toLocaleString() + " CHARS";
    }

    nodes.exportLbl = el("div", { class: "cr-lbl", text: "NOTHING GENERATED YET" });

    host.appendChild(el("div", { class: "cr-actions" }, [
      ui.button("MARKDOWN", function () { put(toMarkdown(), "MARKDOWN"); }),
      ui.button("JSON", function () { put(toJSON(), "JSON"); }),
      ui.button("COPY", function () {
        if (!nodes.exportOut.value) { ui.toast("GENERATE ONE FIRST", "warn"); return; }
        ui.copy(nodes.exportOut.value, { title: "CRITTERSCRIPT" }).then(function (h) {
          if (h) ui.toast("COPIED", "ok");
        });
      }),
      ui.button("SAVE FILE", function () {
        var v = nodes.exportOut.value;
        if (!v) { ui.toast("GENERATE ONE FIRST", "warn"); return; }
        var json = v.charAt(0) === "{";
        var okd = ui.download(v, json ? "critterscript.json" : "CRITTERSCRIPT.md",
          json ? "application/json" : "text/markdown");
        ui.toast(okd ? "SAVED" : "DOWNLOAD BLOCKED — USE COPY", okd ? "ok" : "warn");
      })
    ]));
    host.appendChild(nodes.exportLbl);
    host.appendChild(nodes.exportOut);
    host.appendChild(el("div", { class: "cr-p cr-dim", text:
      "Markdown is for a repo or a wiki. JSON keeps the spec text and the command " +
      "registry as separate keys, so a future implementation can be driven from the " +
      "command table without parsing any prose." }));
  }

  /* ---- selfcheck -------------------------------------------------
     The two things that would make this module quietly useless: an
     export that does not actually contain the commands, and a
     command list that came from somewhere other than the registry. */
  function selfcheck(api) {
    return [
      { name: "THE COMMAND LIST COMES FROM THE REGISTRY", critical: true, run: function () {
        var c = cs();
        if (!c) throw new Error("SKIPPED — no language in this build");
        var live = c.list().length;
        var mine = commandList().length;
        if (live !== mine) throw new Error("registry has " + live + ", reference shows " + mine);
        return live + " commands, read live";
      } },

      { name: "MARKDOWN EXPORT CARRIES EVERY COMMAND", critical: true, run: function () {
        var c = cs();
        if (!c) throw new Error("SKIPPED — no language in this build");
        var md = toMarkdown();
        var missing = c.list().filter(function (x) {
          return md.indexOf("`" + x.name + "`") < 0;
        }).map(function (x) { return x.name; });
        if (missing.length) {
          throw new Error("absent from the export: " + missing.join(", "));
        }
        return md.length.toLocaleString() + " chars, " + c.list().length + " commands";
      } },

      { name: "JSON EXPORT PARSES BACK", critical: true, run: function () {
        var c = cs();
        if (!c) throw new Error("SKIPPED — no language in this build");
        var o = JSON.parse(toJSON());
        if (!Array.isArray(o.commands) || !o.commands.length) throw new Error("no commands key");
        if (!Array.isArray(o.rules) || o.rules.length !== 3) throw new Error("the three rules are not three");
        if (String(o.version) !== String(c.VERSION)) {
          throw new Error("export says v" + o.version + ", language says v" + c.VERSION);
        }
        return "v" + o.version + ", " + o.commands.length + " commands, " +
          o.sections.length + " sections";
      } },

      { name: "EVERY DOCUMENTED COMMAND STILL EXISTS", critical: false, run: function () {
        var c = cs();
        if (!c) throw new Error("SKIPPED — no language in this build");
        /* Prose naming a command that was renamed or removed is the
           failure mode documentation always has. The recipes are
           the part most likely to rot, so they are what is checked:
           every first word of every recipe line has to be real. */
        var bad = [];
        SPEC.recipes.forEach(function (r) {
          r.code.forEach(function (line) {
            line.split("|").forEach(function (part) {
              var w = part.trim().replace(/^\(/, "").split(/\s+/)[0];
              if (!w || /^[$#"']/.test(w)) return;
              if (/^(if|elif|else|end|for|while|repeat|def|return|break|continue|let|in)$/.test(w)) return;
              if (!c.get(w) && bad.indexOf(w) < 0) bad.push(w);
            });
          });
        });
        if (bad.length) throw new Error("recipes use commands that do not exist: " + bad.join(", "));
        return SPEC.recipes.length + " recipes check out";
      } }
    ];
  }

  FieldKit.register("critter-ref", {
    group: "TOOLS",
    about: "The CritterScript language: reference and examples",
    keywords: "critterscript scripting language reference docs",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "CRITTERSCRIPT",
    icon: "≫",
    width: 940,
    height: 680,
    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.pane_learn = el("div", { class: "cr-pane" });
      nodes.pane_commands = el("div", { class: "cr-pane" });
      nodes.pane_recipes = el("div", { class: "cr-pane" });
      nodes.pane_export = el("div", { class: "cr-pane" });

      nodes.search = el("input", { class: "fk-input cr-search", type: "search",
        placeholder: "filter commands", oninput: function (e) {
          filter = e.target.value || "";
          renderCommands();
        } });
      nodes.count = el("div", { class: "cr-lbl", text: "" });

      /* The filter row sits above the results and has to survive a
         re-render, so the results get their own host inside the
         pane rather than the pane being cleared out from under it. */
      nodes.cmdResults = el("div");
      nodes.pane_commands.appendChild(el("div", { class: "cr-searchrow" },
        [nodes.search, nodes.count]));
      nodes.pane_commands.appendChild(nodes.cmdResults);

      nodes.tab_learn = el("button", { class: "cr-tab on", type: "button", text: "LEARN",
        onclick: function () { show("learn"); } });
      nodes.tab_commands = el("button", { class: "cr-tab", type: "button", text: "COMMANDS",
        onclick: function () { show("commands"); renderCommands(); } });
      nodes.tab_recipes = el("button", { class: "cr-tab", type: "button", text: "RECIPES",
        onclick: function () { show("recipes"); } });
      nodes.tab_export = el("button", { class: "cr-tab", type: "button", text: "EXPORT",
        onclick: function () { show("export"); } });

      host.appendChild(el("div", { class: "cr-wrap" }, [
        el("div", { class: "cr-tabs" },
          [nodes.tab_learn, nodes.tab_commands, nodes.tab_recipes, nodes.tab_export]),
        nodes.pane_learn, nodes.pane_commands, nodes.pane_recipes, nodes.pane_export
      ]));

      renderLearn();
      renderRecipes();
      renderExport();
      renderCommands();
      show("learn");
    },

    unmount() { nodes = {}; tab = "learn"; filter = ""; },

    /* One row per command, so Ctrl+K finds a command by what it
       DOES rather than only by its name — which is the search you
       actually want when you have forgotten whether the one that
       takes records apart is called field, pluck or fields. */
    searchIndex() {
      return [{
        id: "critterscript", module: "critter-ref",
        title: "CRITTERSCRIPT — the language",
        body: "critterscript language reference syntax pipe pipeline tutorial " +
          "export markdown json script terminal " +
          SPEC.rules.map(function (r) { return r.rule; }).join(" ")
      }].concat(commandList().map(function (c) {
        return {
          id: "cs:" + c.name, module: "critter-ref",
          title: "COMMAND: " + c.usage,
          body: c.help + " " + c.group + (c.guestSafe ? " guest-safe" : " needs the vault")
        };
      }));
    }
  });

  /* Exported so the terminal's `language` command and HELP can print
     the same words this module shows, rather than keeping a second
     copy of the language description that drifts. */
  FieldKit.provide("critterRef", {
    spec: SPEC,
    commands: commandList,
    grouped: grouped,
    limits: limits,
    markdown: toMarkdown,
    json: toJSON,
    plainText: toPlainText
  });

  function injectCSS() {
    if (document.getElementById("cr-style")) return;
    var s = document.createElement("style");
    s.id = "cr-style";
    s.textContent = [
      ".cr-wrap{display:flex;flex-direction:column;gap:8px;height:100%}",
      ".cr-tabs{display:flex;gap:4px;flex:0 0 auto}",
      ".cr-tab{font:inherit;font-size:9px;letter-spacing:.14em;background:none;",
      "  border:1px solid var(--line2);color:var(--fg-dim);padding:4px 12px;cursor:pointer}",
      ".cr-tab.on,.cr-tab:hover{border-color:var(--accent);color:var(--accent)}",
      ".cr-pane{display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1 1 auto;min-height:0}",
      ".cr-title{font-size:13px;letter-spacing:.06em;color:var(--accent)}",
      ".cr-h{font-size:9px;letter-spacing:.16em;color:var(--fg-dimmer);",
      "  border-bottom:1px solid var(--line2);padding-bottom:3px;margin-top:10px}",
      ".cr-p{font-size:11px;line-height:1.65;color:var(--fg-dim);margin:0}",
      ".cr-dim{color:var(--fg-dimmer);font-size:10px}",
      ".cr-code{font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.6;",
      "  white-space:pre;overflow-x:auto;background:rgba(0,0,0,.28);border:1px solid var(--line2);",
      "  padding:7px 9px;margin:4px 0;color:var(--fg)}",
      ".cr-rule{display:flex;gap:10px;margin:6px 0}",
      ".cr-rule-n{flex:0 0 auto;font-size:20px;color:var(--accent);line-height:1}",
      ".cr-rule-body{flex:1 1 auto;min-width:0}",
      ".cr-rule-t{font-size:12px;color:var(--fg);margin-bottom:3px}",
      ".cr-ba{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".cr-lbl{font-size:9px;letter-spacing:.14em;color:var(--fg-dimmer)}",
      ".cr-list{font-size:11px;line-height:1.7;color:var(--fg-dim);margin:2px 0;padding-left:16px}",
      ".cr-searchrow{display:flex;gap:8px;align-items:center;flex:0 0 auto}",
      ".cr-search{flex:1 1 auto}",
      ".cr-table{display:flex;flex-direction:column}",
      ".cr-row{display:grid;grid-template-columns:230px 1fr 44px;gap:8px;padding:3px 0;",
      "  border-bottom:1px solid rgba(255,255,255,.05);align-items:baseline}",
      ".cr-cmd{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--accent)}",
      ".cr-help{font-size:10.5px;color:var(--fg-dim);line-height:1.5}",
      ".cr-flag{font-size:8px;letter-spacing:.1em;color:var(--fg-dimmer);text-align:right}",
      ".cr-flag.ok{color:var(--fk-ok,var(--accent))}",
      ".cr-recipe{border:1px solid var(--line2);padding:7px 8px;margin-bottom:6px}",
      ".cr-recipe-head{display:flex;justify-content:space-between;align-items:center;gap:8px}",
      ".cr-actions{display:flex;gap:6px;flex-wrap:wrap}",
      ".cr-out{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;white-space:pre;",
      "  flex:1 1 auto;min-height:180px}"
    ].join("");
    document.head.appendChild(s);
  }
})(window.FieldKit);
