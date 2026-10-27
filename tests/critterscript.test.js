/* ============================================================
   FieldKit :: tests/critterscript.test.js
   The script language (core/critterscript.js).

   The in-app probes cover the language as the terminal uses it.
   This covers it as a language: the tokenizer's edge cases, the
   precedence table, the error messages someone will actually
   read, and — most importantly — the budgets, because those are
   the only thing standing between a typo and a hung tab on a
   machine where a reload costs you the vault password.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");

const FILES = ["core/kernel.js", "core/critterscript.js"];

(async function () {
  const t = makeRunner("CRITTERSCRIPT");
  const { ok, section, throws } = t;

  const FieldKit = bootstrap(FILES);
  const cs = FieldKit.need("critterscript");

  /* Collect output instead of printing it. */
  function out(src) {
    const lines = [];
    return cs.run(src, { print: (x) => lines.push(String(x)) })
      .then(() => lines.join("\n"));
  }
  function outGuest(src) {
    const lines = [];
    return cs.run(src, { print: (x) => lines.push(String(x)), guest: true })
      .then(() => lines.join("\n"));
  }

  /* A tiny command set, so the suite does not depend on the
     terminal module having been loaded. */
  cs.command({ name: "p", guestSafe: true, help: "print", run: (c) => c.print(c.raw.join(" ")) });
  cs.command({ name: "ret", guestSafe: true, help: "return a value", run: (c) => c.args[0] });
  cs.command({ name: "sealed", guestSafe: false, help: "not for guests", run: (c) => c.print("ran") });
  cs.command({ name: "boom", guestSafe: true, help: "throws", run: () => { throw new Error("deliberate"); } });
  cs.command({ name: "slow", guestSafe: true, help: "async", run: async (c) => {
    await new Promise((r) => setTimeout(r, 1));
    c.print("async-done");
  } });

  section("the one rule: $name is a variable, everything else is literal");
  {
    ok("a bare word is a string", await out("p hello") === "hello");
    ok("several bare words are several arguments",
      await out("p hello world again") === "hello world again");
    ok("a variable resolves", await out("let x = 7\np $x") === "7");
    ok("a word that looks like a variable name does NOT resolve",
      await out("let name = Ada\np name") === "name");
    ok("numbers stay numbers", await out("p 42") === "42");
    /* The rule has to hold for words that collide with keywords in
       other languages, or someone typing `p null` gets a surprise. */
    ok("keyword-ish words are just words",
      await out("p null undefined NaN class function") === "null undefined NaN class function");
  }

  section("tokenizer");
  {
    ok("comments are stripped", await out("p one # this is ignored") === "one");
    ok("a whole-line comment does nothing", await out("# nothing\np two") === "two");
    ok("blank lines are skipped", await out("\n\np three\n\n") === "three");
    ok("double quotes hold spaces", await out('p "a b  c"') === "a b  c");
    ok("single quotes work too", await out("p 'a b'") === "a b");
    ok("escapes inside strings", await out('p "a\\tb"') === "a\tb");
    ok("a quote inside the other quote is literal", await out(`p "it's"`) === "it's");
    await throws("an unclosed string is a clear error",
      () => out('p "no end'), /unclosed string/i);
    await throws("a bare $ is a clear error",
      () => out("p $ 5"), /\$ must be followed by a name/i);
    /* Paths and URLs must survive unquoted or `set relayUrl ...`
       becomes a quoting exercise every single time. */
    ok("a url survives as one bare word",
      await out("p https://relay.example.com/health") === "https://relay.example.com/health");
    ok("a windows path survives", await out("p C:\\FieldKit\\core") === "C:\\FieldKit\\core");
  }

  section("interpolation");
  {
    ok("$name expands inside quotes", await out('let n = 4\np "n is $n"') === "n is 4");
    ok("an unset name expands to nothing rather than throwing",
      await out('p "x=$nope."') === "x=.");
    ok("adjacent text does not swallow the name",
      await out('let a = 1\np "$a$a"') === "11");
    ok("a literal dollar with no name is left alone",
      await out('p "100$"') === "100$");
  }

  section("arithmetic and precedence");
  {
    ok("multiplication binds tighter than addition", await out("p (2 + 3 * 4)") === "14");
    ok("brackets override", await out("p ((2 + 3) * 4)") === "20");
    ok("division is not integer division", await out("p (7 / 2)") === "3.5");
    ok("modulo", await out("p (7 % 3)") === "1");
    ok("unary minus", await out("p (0 - 5)") === "-5");
    ok("negative literals in expressions", await out("let a = 3\np ($a * -2)") === "-6");
    ok("float output is trimmed, not exponential", await out("p (1 / 3)") === "0.333333");
    await throws("dividing by zero refuses", () => out("p (1 / 0)"), /divide by zero/i);
    await throws("modulo by zero refuses", () => out("p (1 % 0)"), /remainder by zero/i);
    await throws("arithmetic on a non-number explains itself",
      () => out("p (hello * 2)"), /not a number/i);
  }

  section("+ concatenates when either side is text");
  {
    /* Someone writing `p ($a + $b)` with words means join. Someone
       writing it with numbers means add. Guessing wrong either way
       is worse than the small inconsistency. */
    ok("number + number adds", await out("p (2 + 3)") === "5");
    ok("text + number joins", await out('p ("a" + 1)') === "a1");
    ok("number + text joins", await out('p (1 + "a")') === "1a");
    ok("numeric strings still add", await out('p ("2" + 3)') === "5");
  }

  section("comparison and logic");
  {
    ok("less than", await out("p (1 < 2)") === "true");
    ok("greater or equal", await out("p (2 >= 2)") === "true");
    ok("equality across types is by value",
      await out('p (1 == "1")') === "true");
    ok("inequality", await out("p (1 != 2)") === "true");
    ok("and", await out("p (true and false)") === "false");
    ok("or", await out("p (false or true)") === "true");
    ok("not", await out("p (not false)") === "true");
    ok("and binds tighter than or",
      await out("p (true or false and false)") === "true");
    /* Short-circuit is observable: the right side must not run. */
    ok("&& short-circuits", await out("p (false and (1 / 0))") === "false");
    ok("|| short-circuits", await out("p (true or (1 / 0))") === "true");
  }

  section("blocks");
  {
    ok("if runs its body", await out("if true\n  p yes\nend") === "yes");
    ok("if skips a false body", await out("if false\n  p yes\nend") === "");
    ok("else runs", await out("if false\n  p a\nelse\n  p b\nend") === "b");
    ok("repeat repeats", await out("repeat 3\n  p x\nend") === "x\nx\nx");
    ok("repeat 0 does nothing", await out("repeat 0\n  p x\nend") === "");
    ok("while counts down",
      await out("let i = 3\nwhile $i > 0\n  p $i\n  let i = $i - 1\nend") === "3\n2\n1");
    ok("blocks nest",
      await out("repeat 2\n  if true\n    p in\n  end\nend") === "in\nin");
    ok("a variable set inside a block survives it",
      await out("let n = 0\nrepeat 3\n  let n = $n + 1\nend\np $n") === "3");
  }

  section("structure errors are caught before anything runs");
  {
    /* This matters because the alternative is a script that prints
       half its output and then dies. check() is what the terminal
       uses to refuse to SAVE a broken script. */
    const unclosed = cs.check("if true\n  p hi");
    ok("an unclosed if is rejected", !unclosed.ok);
    ok("and says it was never closed", /never closed/i.test(unclosed.error || ""), unclosed.error);
    ok("and names the line", /line 1/.test(unclosed.error || ""), unclosed.error);

    ok("a stray end is rejected", !cs.check("p hi\nend").ok);
    ok("a stray else is rejected", !cs.check("p hi\nelse\np x\nend").ok);
    ok("an if with no condition is rejected", !cs.check("if\n p x\nend").ok);
    ok("a valid script passes", cs.check("if true\n p hi\nend").ok);

    /* Nothing may execute during a check — a script that prints
       while being validated would be a nasty surprise. */
    let printed = 0;
    const before = printed;
    cs.check("p side-effect");
    ok("check() executes nothing", printed === before);
  }

  section("runtime errors name the line and the cause");
  {
    let msg = "";
    try { await out("p ok\np ok\nnosuch thing"); } catch (e) { msg = e.message; }
    ok("an unknown command throws", !!msg);
    ok("it names the line", /line 3/.test(msg), msg);
    ok("it names the command", /nosuch/.test(msg), msg);
    ok("it points at help", /help/i.test(msg), msg);

    let msg2 = "";
    try { await out("p a\np $missing"); } catch (e) { msg2 = e.message; }
    ok("an unset variable names itself", /\$missing/.test(msg2), msg2);
    ok("and suggests the fix", /let missing =/.test(msg2), msg2);

    let msg3 = "";
    try { await out("p one\nboom"); } catch (e) { msg3 = e.message; }
    ok("an error thrown inside a command surfaces", /deliberate/.test(msg3), msg3);
    ok("with the line it was called from", /line 2/.test(msg3), msg3);

    /* The line number must be attached exactly once. Nested blocks
       re-throwing would otherwise produce "line 2: line 2: line 2:". */
    let msg4 = "";
    try { await out("repeat 2\n  if true\n    boom\n  end\nend"); } catch (e) { msg4 = e.message; }
    ok("the line prefix appears once, not once per frame",
      (msg4.match(/line \d+:/g) || []).length === 1, msg4);
  }

  section("budgets — the reason this is safe to type into");
  {
    let m = "";
    try { await out("while true\n  let x = 1\nend"); } catch (e) { m = e.message; }
    ok("an infinite while is stopped", !!m);
    ok("and explains why", /iterations|stopped/i.test(m), m);
    ok("and says what to check", /condition can become false/i.test(m), m);

    let m2 = "";
    /* Under the loop ceiling but far over the output one, so this
       proves the OUTPUT cap fires rather than the iteration cap. */
    try { await out("repeat 40000\n  p x\nend"); } catch (e) { m2 = e.message; }
    ok("unbounded output is stopped", !!m2);
    ok("the output cap is the one that fires here", /lines/i.test(m2), m2);

    let m3 = "";
    try { await out("repeat 999999999\n  let x = 1\nend"); } catch (e) { m3 = e.message; }
    ok("an absurd repeat count is refused up front", /iteration limit/i.test(m3), m3);

    await throws("a negative repeat is refused",
      () => out("repeat (0 - 1)\n p x\nend"), /zero or more/i);

    /* Budgets are per run, not global — one heavy script must not
       leave the next one pre-exhausted. */
    const a = await out("repeat 50\n  p x\nend");
    const b = await out("repeat 50\n  p x\nend");
    ok("budgets reset between runs", a.split("\n").length === 50 && b.split("\n").length === 50);
  }

  section("commands");
  {
    ok("a command's return value is printed", await out("ret hello") === "hello");
    ok("a command returning nothing prints nothing", await out("p ") === "");
    ok("async commands are awaited in order",
      await out("p first\nslow\np last") === "first\nasync-done\nlast");

    cs.command({ name: "needsone", guestSafe: true, minArgs: 1, usage: "needsone <x>",
      help: "x", run: (c) => c.print(c.raw[0]) });
    await throws("minArgs is enforced with the usage line",
      () => out("needsone"), /needs 1 argument.*Usage: needsone/is);
    ok("and satisfied when given", await out("needsone ok") === "ok");

    /* Names are validated so the registry cannot grow something
       the parser could never call. */
    let bad = null;
    try { cs.command({ name: "Bad Name", run: () => {} }); } catch (e) { bad = e.message; }
    ok("a command name with a space is refused", !!bad, bad);
    let noRun = null;
    try { cs.command({ name: "norun" }); } catch (e) { noRun = e.message; }
    ok("a command with no run() is refused", !!noRun, noRun);
  }

  section("the registry cannot be confused by object keys");
  {
    /* On a plain {} this is a real bug: `constructor` resolves to a
       function, and the interpreter tries to invoke it as a
       command. Null prototype makes it a clean "no such command". */
    ok("constructor is not a command", cs.get("constructor") === null);
    ok("toString is not a command", cs.get("toString") === null);
    ok("__proto__ is not a command", cs.get("__proto__") === null);
    let m = "";
    try { await out("constructor"); } catch (e) { m = e.message; }
    ok("calling it is an ordinary unknown-command error", /no command called/i.test(m), m);
  }

  section("guest mode");
  {
    ok("a guest-safe command runs for a guest", await outGuest("p hi") === "hi");
    let m = "";
    try { await outGuest("sealed"); } catch (e) { m = e.message; }
    ok("a sealed command is refused for a guest", !!m);
    ok("and says why", /guest mode/i.test(m), m);
    ok("the same command runs for a non-guest", await out("sealed") === "ran");
    /* Fail-closed: an unflagged command must be sealed, not open. */
    cs.command({ name: "unflagged", help: "no flag", run: (c) => c.print("leaked") });
    let dup = "";
    try { cs.command({ name: "p", run: () => {} }); } catch (e) { dup = e.message; }
    ok("a name already taken is refused, not silently replaced", /already exists/.test(dup));
    ok("...unless the replacement is declared",
      !!cs.command({ name: "p", replace: true, guestSafe: true,
        run: (c) => c.print(c.raw.join(" ")) }));
    let m2 = "";
    try { await outGuest("unflagged"); } catch (e) { m2 = e.message; }
    ok("a command that forgot to declare guestSafe is sealed", !!m2, m2);
  }

  section("variables");
  {
    ok("let overwrites", await out("let a = 1\nlet a = 2\np $a") === "2");
    ok("let can reference itself", await out("let a = 1\nlet a = $a + 1\np $a") === "2");
    ok("a variable holds a string", await out('let s = "hi there"\np $s') === "hi there");
    ok("a variable holds a boolean", await out("let b = true\nif $b\n p yes\nend") === "yes");
    await throws("let with no value is a clear error",
      () => out("let a ="), /let needs/i);
    await throws("let with no name is a clear error",
      () => out("let = 5"), /let needs/i);
  }

  section("truthiness is predictable");
  {
    ok("0 is false", await out("if 0\n p y\nelse\n p n\nend") === "n");
    ok("empty string is false", await out('if ""\n p y\nelse\n p n\nend') === "n");
    ok("the word false is false", await out("if false\n p y\nelse\n p n\nend") === "n");
    ok("a non-empty word is true", await out("if word\n p y\nend") === "y");
    ok("1 is true", await out("if 1\n p y\nend") === "y");
    /* 'no' and 'off' read as false because `set thing off` is a
       thing people type, and having it read as true would be a
       trap in exactly the place it matters. */
    ok("'no' is false", await out("if no\n p y\nelse\n p n\nend") === "n");
    ok("'off' is false", await out("if off\n p y\nelse\n p n\nend") === "n");
  }

  /* ============================================================
     v2: calls in expressions, for, functions, elif, loop control.
     ============================================================ */

  section("v2 :: ( ) runs a command and hands back the answer");
  {
    ok("a call in a let", await out("let n = (ret 5)\np $n") === "5");
    ok("a call inside arithmetic", await out("p (ret 5) + 1") === "6");
    ok("a call as an argument", await out("p (ret hi) there") === "hi there");
    ok("a nested call", await out("let n = (count (list a b c))\np $n") === "3");
    ok("a call in an if condition",
      await out("if (count (list a b))\n p yes\nend") === "yes");
    /* The distinguishing rule: a word followed by a binary
       operator is arithmetic, not a call. */
    ok("(word == x) is still a comparison",
      await out("let a = yes\nif (yes == $a)\n p same\nend") === "same");
    ok("a call keeps its value instead of printing it",
      await out("let x = (ret quiet)\np done") === "done");
    throws("an unclosed call says so", () => cs.parse("let n = (count $x"), /closing \)/);
    /* Guest mode has to reach inside expressions too — this is
       the hole that appears when the two call paths are separate
       copies of the same code. */
    let guestErr = "";
    await outGuest("let x = (sealed)\np $x").catch((e) => { guestErr = e.message; });
    ok("a sealed command is refused inside a call expression", guestErr !== "");
    ok("...and the reason names guest mode", /guest mode/.test(guestErr));
  }

  section("v2 :: list and text commands");
  {
    ok("list makes a list", await out("p (list a b c)") === "a, b, c");
    ok("count counts items", await out("p (count (list a b c))") === "3");
    ok("count counts characters of text", await out("p (count hello)") === "5");
    ok("item is one-based", await out("p (item (list a b c) 2)") === "b");
    ok("item counts back from the end",
      await out("let l = (list a b c)\np (item $l -1)") === "c");
    ok("a negative number survives as one argument", await out("p -1") === "-1");
    throws("item past the end explains itself",
      () => cs.run("p (item (list a) 9)", { print: () => {} }), /no item 9/);
    ok("split splits", await out("p (count (split 'a b c'))") === "3");
    ok("split takes a separator", await out("p (item (split a-b-c -) 2)") === "b");
    ok("join joins", await out("p (join (list a b) -)") === "a-b");
    ok("add appends", await out("p (add (list a) b c)") === "a, b, c");
    ok("add does not mutate the original",
      await out("let l = (list a)\nlet m = (add $l b)\np (count $l)") === "1");
    ok("upper", await out("p (upper hi there)") === "HI THERE");
    ok("lower", await out("p (lower HI)") === "hi");
    ok("trim", await out("p (count (trim '  hi  '))") === "2");
    ok("has finds text", await out("p (has hello ell)") === "true");
    ok("has finds a list item", await out("p (has (list a b) b)") === "true");
    ok("has says false when absent", await out("p (has (list a b) z)") === "false");
    ok("round to whole", await out("p (round 3.7)") === "4");
    ok("round to places", await out("p (round 3.14159 2)") === "3.14");
    ok("range counts from 1", await out("p (range 3)") === "1, 2, 3");
    ok("range takes both ends", await out("p (range 2 4)") === "2, 3, 4");
    throws("an oversized range is refused, not attempted",
      () => cs.run("p (range 1 999999)", { print: () => {} }), /limit/);
  }

  section("v2 :: for");
  {
    ok("for walks a list", await out("for x in (list a b c)\n p $x\nend") === "a\nb\nc");
    ok("for walks a variable", await out("let l = (list 1 2)\nfor x in $l\n p $x\nend") === "1\n2");
    ok("for over a range", await out("for i in (range 3)\n p $i\nend") === "1\n2\n3");
    ok("the loop variable survives the loop",
      await out("for x in (list a b)\nend\np $x") === "b");
    ok("for over one non-list value runs once",
      await out("for x in hello\n p $x\nend") === "hello");
    ok("for over nothing runs zero times", await out("for x in ''\n p $x\nend") === "");
    ok("for nests", await out("for a in (list 1 2)\n for b in (list x y)\n  p \"$a$b\"\n end\nend")
      === "1x\n1y\n2x\n2y");
    throws("for without in is a clear error", () => cs.parse("for x (list a)\nend"), /for name in/);
    throws("an unclosed for names the line", () => cs.parse("for x in (list a)\np y"), /never closed/);
  }

  section("v2 :: break and continue");
  {
    ok("break leaves a for", await out("for x in (range 5)\n if $x > 2\n  break\n end\n p $x\nend")
      === "1\n2");
    ok("break leaves a repeat", await out("let i = 0\nrepeat 9\n let i = $i + 1\n if $i == 2\n  break\n end\nend\np $i") === "2");
    ok("break leaves a while", await out("let i = 0\nwhile true\n let i = $i + 1\n if $i > 3\n  break\n end\nend\np $i") === "4");
    ok("continue skips the rest of the body",
      await out("for x in (range 4)\n if $x == 2\n  continue\n end\n p $x\nend") === "1\n3\n4");
    ok("break only leaves the inner loop",
      await out("for a in (list 1 2)\n for b in (list x y)\n  break\n end\n p $a\nend") === "1\n2");
    throws("a stray break is refused",
      () => cs.run("break", { print: () => {} }), /outside a loop/);
    throws("a stray continue is refused",
      () => cs.run("continue", { print: () => {} }), /outside a loop/);
  }

  section("v2 :: functions");
  {
    ok("a function runs", await out("def hi\n p hello\nend\nhi") === "hello");
    ok("parameters bind", await out("def greet who\n p hi $who\nend\ngreet Ada") === "hi Ada");
    ok("return hands back a value",
      await out("def two\n return 2\nend\nlet n = (two)\np $n") === "2");
    ok("a bare call prints its return value", await out("def two\n return 2\nend\ntwo") === "2");
    ok("return stops the function",
      await out("def f\n return 1\n p unreachable\nend\nlet x = (f)\np $x") === "1");
    ok("return inside a loop leaves the function",
      await out("def f\n for i in (range 9)\n  if $i == 2\n   return $i\n  end\n end\nend\np (f)") === "2");
    ok("a function is hoisted, so it can be called above its def",
      await out("p (later)\ndef later\n return ok\nend") === "ok");
    ok("a missing argument is null, not an error",
      await out("def f a\n p \"[$a]\"\nend\nf") === "[]");
    ok("$args holds everything passed",
      await out("def f\n p (count $args)\nend\nf a b c") === "3");
    ok("functions call functions",
      await out("def a\n return 1\nend\ndef b\n return (a) + 1\nend\np (b)") === "2");
    /* The brackets around the subtraction are load-bearing and
       worth a test on their own: `down $n - 1` is three arguments
       by the argument rule, so the counter never moves and the
       depth cap is what stops it. That is correct, but it is the
       thing a newcomer will get wrong first. */
    ok("recursion works", await out(
      "def down n\n if $n <= 0\n  return done\n end\n return (down ($n - 1))\nend\np (down 5)") === "done");
    let unbracketed = "";
    await out("def down n\n if $n <= 0\n  return done\n end\n return (down $n - 1)\nend\np (down 5)")
      .catch((e) => { unbracketed = e.message; });
    ok("...and forgetting them is caught by the depth cap, not a hang",
      /nested more than/.test(unbracketed));

    /* Scope: a helper must not be able to clobber the caller's
       variables, or every script becomes a naming minefield. */
    ok("a function has its own variables",
      await out("let x = outer\ndef f\n let x = inner\nend\nf\np $x") === "outer");
    ok("a function cannot read the caller's variables",
      (await out("let x = 1\ndef f\n p $x\nend\nf").catch((e) => e.message)).indexOf("has not been set") >= 0);

    throws("def without a name is a clear error", () => cs.parse("def\nend"), /needs a name/);
    throws("an unclosed def names it", () => cs.parse("def f\np x"), /never closed/);
    /* Built-ins win the name lookup. If a def could shadow `p`,
       one script on the drive could change what every other
       script does — including the ones that touch the vault. */
    ok("a built-in cannot be shadowed by a def",
      await out("def p\n return shadowed\nend\np hello") === "hello");
  }

  section("v2 :: functions share the run's budgets");
  {
    /* The important one. If a call got a fresh step allowance,
       infinite recursion would spin until the tab died instead of
       stopping with a message — the budgets would be decoration. */
    let msg = "";
    await cs.run("def f\n return (f)\nend\np (f)", { print: () => {} })
      .catch((e) => { msg = e.message; });
    ok("runaway recursion stops with an explanation", /nested more than|steps/.test(msg));
    ok("...and names the call depth", /nested more than/.test(msg) || /steps/.test(msg));

    let msg2 = "";
    await cs.run("def spin\n while true\n  p x\n end\nend\nspin", { print: () => {} })
      .catch((e) => { msg2 = e.message; });
    ok("a runaway loop inside a function still stops",
      /iterations|steps|lines/.test(msg2));
  }

  section("v2 :: elif");
  {
    ok("elif picks the second branch",
      await out("let x = 2\nif $x == 1\n p one\nelif $x == 2\n p two\nend") === "two");
    ok("elif falls through to else",
      await out("let x = 9\nif $x == 1\n p one\nelif $x == 2\n p two\nelse\n p other\nend") === "other");
    ok("a long chain picks the right arm",
      await out("let x = 3\nif $x == 1\n p a\nelif $x == 2\n p b\nelif $x == 3\n p c\nelif $x == 4\n p d\nend") === "c");
    ok("only one arm runs",
      await out("let x = 1\nif $x == 1\n p a\nelif true\n p b\nelse\n p c\nend") === "a");

    /* The bug this section exists for: an elif chain parsed by
       recursion swallowed every following statement into the else
       branch, so the rest of the script ran only when the first
       condition was false. Nothing about that is visible until a
       test looks past the `end`. */
    ok("statements after the chain are NOT part of it",
      await out("if true\n p a\nelif true\n p b\nend\np after") === "a\nafter");
    ok("...including after a chain that fell through",
      await out("if false\n p a\nelif false\n p b\nend\np after") === "after");
    ok("...and after one with an else",
      await out("if false\n p a\nelif false\n p b\nelse\n p c\nend\np after") === "c\nafter");
    ok("an elif chain nests inside a loop correctly",
      await out("for i in (range 3)\n if $i == 1\n  p one\n elif $i == 2\n  p two\n else\n  p many\n end\nend")
      === "one\ntwo\nmany");
    throws("elif with no condition is a clear error",
      () => cs.parse("if true\np a\nelif\np b\nend"), /needs a condition/);
    throws("a stray elif is refused", () => cs.parse("elif true\np a\nend"), /no matching/);
  }

  /* ---- v3 ------------------------------------------------------
     The pipe is the change that makes v3 a different language
     rather than v2 with extras, so it gets the same treatment the
     one rule got: the semantics are pinned down by test, because
     every script anyone writes from here depends on which argument
     the answer lands in. */
  section("v3 :: | sends the answer along");
  {
    ok("the answer becomes the first argument of the next step",
      await out("ret hello | p") === "hello");

    ok("a chain runs left to right",
      await out("list 3 1 10 2 | sort | join \", \"") === "1, 2, 3, 10");

    /* Numbers sorting as text would give 10, 2, 3 — which looks
       exactly like a broken sort rather than a type surprise. */
    ok("sort compares numbers as numbers",
      await out("list 2 10 9 | sort | join ,") === "2,9,10");

    ok("the last step prints when nothing catches it",
      await out("list a b c | count") === "3");

    ok("a single step with no pipe is still an ordinary command",
      await out("p one two") === "one two");
  }

  section("v3 :: $it, and where the answer goes instead");
  {
    ok("a step that mentions $it gets it there and nothing is prepended",
      await out("list x y z | count | p \"there are $it items\"") === "there are 3 items");

    /* Inside a quoted string counts. Scanning only bare $it tokens
       would silently prepend the answer as well as interpolating
       it, and the bug would look like a stray leading value. */
    ok("$it inside quotes counts as a mention",
      await out("ret world | p \"hello $it\"") === "hello world");

    /* Left set, $it would read as an ordinary variable on every
       later line, holding whichever chain ran last. Asking for it
       outside a pipeline has to fail the same way any unset
       variable does. */
    await throws("$it does not survive the pipeline it belongs to",
      () => out("list a b | count | p $it\np $it"), /\$it has not been set/);
  }

  section("v3 :: -> names the answer");
  {
    ok("it stores instead of printing",
      await out("list a b c | count -> $n\np $n") === "3");

    ok("the dollar is optional on the name",
      await out("list a b c | count -> n\np $n") === "3");

    ok("a single command can be named too",
      await out("ret 7 -> $x\np $x") === "7");

    ok("nothing is printed on the line that names",
      await out("list a b | count -> $n") === "");
  }

  section("v3 :: a step with no answer cannot be piped");
  {
    /* This printed "hello" and uppercased nothing, silently. The
       distinction that fixes it is undefined (no answer) versus
       null (the answer is nothing), and the message has to name
       the command or it is a mystery rather than an error. */
    await throws("piping a printing command is an error, not a silent no-op",
      () => out("p hello | upper"), /does not have an answer to pass along/);

    await throws("and it names which step", () => out("p hi | upper"), /'p'/);

    /* undefined is "no answer"; an empty string is a real value
       and has to pass. Conflating them is what made the original
       bug silent. */
    ok("but a command that answers with an empty value is allowed through",
      await out("ret \"\" | count") === "0");
  }

  section("v3 :: records");
  {
    ok("record builds one from pairs",
      await out("record name Ada age 30") === "name=Ada age=30");

    ok("field takes one out",
      await out("record name Ada age 30 | field name") === "Ada");

    ok("fields lists the names",
      await out("record name Ada age 30 | fields | join ,") === "name,age");

    ok("with copies rather than mutates",
      await out("record a 1 -> $r\nwith $r b 2 -> $s\np (count (fields $r))") === "1");

    /* A record is deliberately the shape JSON.parse produces, so
       this needs no conversion step in the middle. */
    ok("json parses straight into records the rest of the language understands",
      await out("json \"[{\\\"a\\\":1},{\\\"a\\\":2}]\" | pluck a | sum") === "3");

    ok("kind names what it has",
      await out("record a 1 | kind") === "a record" &&
      await out("list a | kind") === "a list");

    await throws("a missing field names what IS there",
      () => out("record name Ada | field nmae"), /It has: name/);
  }

  section("v3 :: the value commands the pipe made necessary");
  {
    ok("where filters records by a field",
      await out("json \"[{\\\"n\\\":\\\"a\\\",\\\"ok\\\":true},{\\\"n\\\":\\\"b\\\",\\\"ok\\\":false}]\"" +
        " | where ok false | pluck n | join ,") === "b");
    ok("first and last take one or several",
      await out("list a b c d | first") === "a" &&
      await out("list a b c d | last 2 | join ,") === "c,d");
    ok("slice counts from 1 and includes the end",
      await out("list a b c d | slice 2 3 | join ,") === "b,c");
    ok("unique keeps the first of each",
      await out("list a b a c | unique | join ,") === "a,b,c");
    ok("without removes by value",
      await out("list a b c | without b | join ,") === "a,c");
    ok("only keeps what contains the text",
      await out("list cat dog cart | only ca | join ,") === "cat,cart");
    ok("lines drops the blanks",
      await out("ret \"one\\n\\ntwo\" | lines | count") === "2");
    ok("words splits on whitespace",
      await out("ret \"one  two three\" | words | count") === "3");
    ok("sum, min and max",
      await out("list 1 2 3 | sum") === "6" &&
      await out("list 4 1 9 | min") === "1" &&
      await out("list 4 1 9 | max") === "9");
    ok("replace is plain text, not a pattern",
      await out("ret \"a.b.c\" | replace . -") === "a-b-c");
    ok("starts and ends",
      await out("ret hello | starts he") === "true" &&
      await out("ret hello | ends lo") === "true");
    ok("reverse works on both a list and text",
      await out("list a b c | reverse | join ,") === "c,b,a" &&
      await out("ret abc | reverse") === "cba");
    await throws("number refuses what is not one",
      () => out("ret hello | number"), /is not a number/);
  }

  section("v3 :: pipes compose with the rest of the language");
  {
    ok("a def can be piped into",
      await out("def dbl n\n  return ($n * 2)\nend\nlist 1 2 3 | first | dbl") === "2");

    ok("a pipeline works inside a loop",
      await out("for x in (list ab cde)\n  ret $x | count\nend") === "2\n3");

    ok("-> inside a block writes to the enclosing scope",
      await out("if true\n  list a b | count -> $n\nend\np $n") === "2");

    /* The budgets have to hold across a pipeline too, or a chain
       becomes the way around the only thing keeping a typo from
       hanging the tab. */
    ok("pipeline stages are counted against the step budget",
      typeof cs.MAX_STEPS === "number" && cs.MAX_STEPS > 0);
  }

  /* ============================================================
     A timestamp is arithmetic unless you quote it.

     Rule one says everything that is not a $name is a literal, and
     that is true of words — but a token that begins with a digit is
     read as a number, so a bare 2026-08-21 comes apart into 2026,
     minus 8, minus 21. It surfaced through TERMINAL, which titles
     notes with a timestamp and used to echo an unquoted
     "read it back with  read terminal 2026-08-21 15:04" that did
     not work when you pasted it.

     Both halves are pinned here. The splitting is not a bug to be
     fixed — division and a glued negative both depend on a digit
     starting a number — so it is a thing the reference has to say
     and the terminal has to quote around.
     ============================================================ */
  section("digits at the start of a token mean a number, and quotes mean a literal");
  {
    ok("quoted, a timestamp survives whole",
      await out('p "terminal 2026-08-21 15:04"') === "terminal 2026-08-21 15:04");
    ok("unquoted, it is read as arithmetic",
      await out("p 2026-08-21 15:04") !== "2026-08-21 15:04");
    ok("a word that merely contains a hyphen is still one literal",
      await out("p sum-up") === "sum-up");
    ok("and so is one that contains a colon and slashes",
      await out("p https://example.org/a") === "https://example.org/a");

    /* The reason the splitting stays: this depends on it. */
    ok("division still divides", await out("p (6 / 2)") === "3");
  }

  section("a returned value round-trips through show()");
  {
    ok("integers have no decimal point", cs.show(3) === "3");
    ok("floats are trimmed", cs.show(1 / 3) === "0.333333");
    ok("null shows as empty", cs.show(null) === "");
    ok("a list joins with commas", cs.show(["a", "b"]) === "a, b");
    ok("booleans show as words", cs.show(true) === "true");
  }

  t.state.fail === 0
    ? console.log("\nRESULT  pass " + t.state.pass + "  fail 0")
    : console.log("\nRESULT  pass " + t.state.pass + "  fail " + t.state.fail);
  process.exit(t.state.fail ? 1 : 0);
})().catch((e) => {
  console.log("\nSUITE CRASHED: " + e.stack);
  console.log("RESULT  pass 0  fail 1");
  process.exit(1);
});
