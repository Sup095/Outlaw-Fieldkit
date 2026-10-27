/* ============================================================
   FieldKit :: critterscript
   A small command language for the terminal (§3).

   WHY A LANGUAGE AT ALL

   FieldKit cannot run shell commands — a file:// page has no
   process and no filesystem. So a "terminal" here can only ever
   drive FieldKit itself. That could have been a fixed list of
   buttons; a tiny language is better because it composes, can be
   saved and re-run, and gives every module a place to expose
   something without needing its own window.

   THE DESIGN, IN THREE RULES

     1.  $name is a variable. Everything else is a literal.
     2.  |  sends the answer along.
     3.  -> names the answer.

   Rule 1 removes the ambiguity that makes shell languages hard to
   learn — no quoting rules to memorise, no "when does this expand",
   no accidental globbing. `say hello` prints hello. `say $name`
   prints the variable. Done.

   Rules 2 and 3 came later and are the reason this reads unlike
   other small languages. Before them, counting the words in a note
   had to be written inside-out, in the order a parser likes:

     let words = (split (read notes) " ")
     let n = (count $words)

   Now it is written in the order the work happens, left to right,
   which is also the order somebody says it out loud:

     read notes | split " " | count -> $n

   The answer of each step becomes the FIRST argument of the next,
   unless that step mentions `$it`, in which case it goes there
   instead. One sentence, and it covers both `| count` (where first
   argument is obviously right) and `| say "there are $it words"`
   (where it obviously is not).

   Brackets still work and are still the right answer inside an `if`
   or a `let`. The pipe is for a line that is a sequence of steps,
   which is most lines.

   SHAPE

     # comments run to end of line
     let x = 5
     say hello world
     say "x is $x"

     list 3 1 2 | sort | join ", "
     read notes | lines | only TODO | count -> $todo

     if $x > 3
       say big
     else
       say small
     end

     repeat 3
       say tick
     end

     def greet who
       say "hello $who"
     end

   Line-oriented and block-structured, because that is what people
   can read at a glance and what a terminal can echo back sanely.

   VALUES

   Numbers, text, yes-or-no, lists, and records. A record is a plain
   object with named fields — and it is deliberately the same shape
   JSON parses into, so `fetch <url> | json | field title` works with
   nothing to convert in the middle. Everything can be printed;
   that is what makes it debuggable from a terminal.

   WHY THE BUDGETS EXIST

   This runs on the UI thread. `while true` with no ceiling is a
   hung tab and, on the school Chromebook, a reload — which on
   file:// means re-entering the vault password. So every run
   carries a step budget and an output cap, and hitting either is
   a clean error naming which one. That is not a limitation to
   apologise for; it is the difference between a mistake costing a
   line of feedback and costing a session.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var MAX_STEPS = 200000;      // total statements executed per run
  var MAX_OUTPUT = 2000;       // lines emitted per run
  /* Deliberately well under MAX_STEPS/2. A tight `while true` body
     is two statements per pass, so an equal ceiling means the step
     budget fires first and the error talks about steps when the
     useful thing to say is "your loop condition never goes false". */
  var MAX_LOOP = 50000;        // iterations of any single loop
  var MAX_DEPTH = 24;          // nested blocks
  var MAX_CALL_DEPTH = 60;     // nested function calls

  /* ---- tokenizer ----------------------------------------------
     One line at a time. Returns tokens tagged by kind so the
     parser never has to re-inspect characters. */
  /* Longest first, always: `<=` must not read as `<` then `=`,
     `->` must not read as `-` then `>`, and `||` must not read as
     two pipes. The scanner takes the first match in this order, so
     the order IS the rule. */
  var OPS = ["<=", ">=", "==", "!=", "&&", "||", "->",
             "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", ",", "|"];

  function tokenize(line) {
    var out = [], i = 0, n = line.length;
    while (i < n) {
      var c = line[i];

      if (c === " " || c === "\t") { i++; continue; }
      if (c === "#") break;                                  // comment to EOL

      /* Quoted string. Supports \" \\ \n \t and $var interpolation
         (resolved later, at evaluation, so the raw text survives
         into error messages). */
      if (c === '"' || c === "'") {
        var q = c, buf = "", closed = false;
        i++;
        while (i < n) {
          if (line[i] === "\\" && i + 1 < n) {
            var e = line[i + 1];
            buf += e === "n" ? "\n" : e === "t" ? "\t" : e;
            i += 2;
            continue;
          }
          if (line[i] === q) { closed = true; i++; break; }
          buf += line[i++];
        }
        if (!closed) throw new Error("unclosed string — add a matching " + q);
        out.push({ k: "str", v: buf });
        continue;
      }

      /* Variable. */
      if (c === "$") {
        var m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i));
        if (!m) throw new Error("$ must be followed by a name, like $count");
        out.push({ k: "var", v: m[1] });
        i += m[0].length;
        continue;
      }

      /* Number. Leading - is handled by the parser as an operator,
         so a bare -5 in an expression still works. */
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(line[i + 1] || ""))) {
        var nm = /^[0-9]*\.?[0-9]+/.exec(line.slice(i));
        out.push({ k: "num", v: Number(nm[0]) });
        i += nm[0].length;
        continue;
      }

      /* Operator. Two-character forms first so <= does not read
         as < followed by =. */
      var op = null;
      for (var o = 0; o < OPS.length; o++) {
        if (line.startsWith(OPS[o], i)) { op = OPS[o]; break; }
      }
      if (op) {
        /* Whitespace is the only thing that can tell `item $l -1`
           (minus one, one argument) from `down $n - 1` (n, minus,
           one — or subtraction if brackets say so). The tokenizer
           throws spacing away, so a sign glued to its digits is
           marked here and the argument scanner reads the mark.
           Expressions ignore it: inside brackets, - is always the
           operator. */
        var tok = { k: "op", v: op };
        if ((op === "-" || op === "+") && /[0-9.]/.test(line[i + 1] || "")) tok.glue = true;
        out.push(tok);
        i += op.length;
        continue;
      }

      /* Bare word — a literal string, by the one rule.
         `/` and `%` are allowed INSIDE a word but not at the start,
         which is what makes `set relayUrl https://host/health` work
         without quoting while `(6 / 2)` is still division. The
         operator branch above runs first, so a slash that begins a
         token is division; one glued to a word is part of it.

         `|` is excluded outright, because it is the pipe and a word
         that could swallow one would make `count $l|say` mean
         something different from `count $l | say`. Spacing should
         not change meaning. `-` is NOT excluded — command names have
         hyphens in them (`ai-chat`), and `->` only becomes an
         operator when it starts a token, which is to say after a
         space. */
      var w = /^[^\s"'$#(),=<>+*|]+/.exec(line.slice(i));
      if (!w) throw new Error("cannot read character '" + c + "'");
      out.push({ k: "word", v: w[0] });
      i += w[0].length;
    }
    return out;
  }

  /* ---- expression parser ---------------------------------------
     Precedence climbing. Small enough to read in one sitting,
     which matters more here than generality. */
  var PREC = {
    "||": 1, "&&": 2,
    "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4,
    "+": 5, "-": 5,
    "*": 6, "/": 6, "%": 6
  };

  function parseExpr(toks, pos, minPrec) {
    var r = parseUnary(toks, pos);
    var left = r.node;
    pos = r.pos;

    while (pos < toks.length && toks[pos].k === "op") {
      var op = toks[pos].v;
      var p = PREC[op];
      if (p === undefined || p < minPrec) break;
      /* An operator with nothing to its right is not an operator,
         it is a literal the caller wants: `join $l -` hands `-`
         to join as a separator. Without this the binary loop
         reaches past the `)` and reports "unexpected )", blaming
         the bracket for a minus sign three tokens back. */
      var nxt = toks[pos + 1];
      if (!nxt || (nxt.k === "op" && nxt.v === ")")) break;
      var rhs = parseExpr(toks, pos + 1, p + 1);
      left = { t: "bin", op: op, a: left, b: rhs.node };
      pos = rhs.pos;
    }
    return { node: left, pos: pos };
  }

  function parseUnary(toks, pos) {
    if (pos >= toks.length) throw new Error("expression ended early");
    var t = toks[pos];

    if (t.k === "op" && (t.v === "-" || t.v === "+")) {
      var u = parseUnary(toks, pos + 1);
      return { node: { t: "neg", a: u.node, sign: t.v }, pos: u.pos };
    }
    if (t.k === "word" && t.v === "not") {
      var nn = parseUnary(toks, pos + 1);
      return { node: { t: "not", a: nn.node }, pos: nn.pos };
    }
    if (t.k === "op" && t.v === "(") {
      /* Parentheses run a command and hand back its answer:
         (count $list). This one rule is what lets `let`, `for`
         and `if` use commands at all — without it the language
         has verbs that can only ever print, which is a toy.

         A leading word followed by a binary operator is still
         arithmetic, so (yes == $answer) keeps meaning what it
         looks like. Everything else after `(` is a call. */
      var n1 = toks[pos + 1];
      if (n1 && n1.k === "word" && n1.v !== "not" && n1.v !== "true" && n1.v !== "false") {
        var after = toks[pos + 2];
        if (!(after && after.k === "op" && PREC[after.v] !== undefined)) {
          var ca = argNodes(toks, pos + 2, true);
          if (ca.pos >= toks.length || toks[ca.pos].v !== ")") {
            throw new Error("missing closing ) after '" + n1.v + "'");
          }
          return { node: { t: "call", name: n1.v, args: ca.args }, pos: ca.pos + 1 };
        }
      }
      var inner = parseExpr(toks, pos + 1, 1);
      if (inner.pos >= toks.length || toks[inner.pos].v !== ")") {
        throw new Error("missing closing )");
      }
      return { node: inner.node, pos: inner.pos + 1 };
    }
    if (t.k === "num") return { node: { t: "lit", v: t.v }, pos: pos + 1 };
    if (t.k === "str") return { node: { t: "str", v: t.v }, pos: pos + 1 };
    if (t.k === "var") return { node: { t: "var", v: t.v }, pos: pos + 1 };
    if (t.k === "word") {
      if (t.v === "true") return { node: { t: "lit", v: true }, pos: pos + 1 };
      if (t.v === "false") return { node: { t: "lit", v: false }, pos: pos + 1 };
      if (t.v === "and") return { node: { t: "lit", v: t.v }, pos: pos + 1 };
      return { node: { t: "lit", v: t.v }, pos: pos + 1 };
    }
    throw new Error("unexpected '" + (t.v) + "' in an expression");
  }

  /* Arguments are one token each: `say hello world` is two
     arguments, not an expression. A `(` opts into a real
     expression, which is also how a nested call is written.
     Shared by the statement parser and the call parser so the
     two can never disagree about what an argument is. */
  function argNodes(toks, pos, stopAtParen) {
    var args = [];
    while (pos < toks.length) {
      var tk = toks[pos];
      if (stopAtParen && tk.k === "op" && tk.v === ")") break;
      if (tk.k === "op" && tk.v === "(") {
        var e = parseExpr(toks, pos, 1);
        args.push(e.node);
        pos = e.pos;
        continue;
      }
      /* A sign glued to its digits is part of the number, so
         `item $l -1` passes minus one rather than two arguments
         reading "-" and "1" — before this there was no way to
         hand a command a negative number at all. Spaced, it stays
         a separate token: `f $n - 1` is three arguments, and
         subtraction in an argument needs brackets, `f ($n - 1)`. */
      if (tk.glue && toks[pos + 1] && toks[pos + 1].k === "num") {
        args.push({ t: "lit", v: tk.v === "-" ? -toks[pos + 1].v : toks[pos + 1].v });
        pos += 2;
        continue;
      }
      if (tk.k === "num") args.push({ t: "lit", v: tk.v });
      else if (tk.k === "str") args.push({ t: "str", v: tk.v });
      else if (tk.k === "var") args.push({ t: "var", v: tk.v });
      else args.push({ t: "lit", v: tk.v });
      pos++;
    }
    return { args: args, pos: pos };
  }

  /* Does this stage refer to the value coming down the pipe?

     Strings count. `| say "there are $it words"` mentions $it inside
     quotes, where interpolation will find it at run time — and a
     scan that only looked at variable nodes would decide the stage
     does not use it, prepend the value as an argument, and print it
     twice. The bug would look like the language repeating itself for
     no reason. */
  function mentionsIt(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n) continue;
      if (n.t === "var" && n.v === "it") return true;
      if (n.t === "str" && String(n.v).indexOf("$it") >= 0) return true;
      if (n.t === "bin" && (mentionsIt([n.a]) || mentionsIt([n.b]))) return true;
      if ((n.t === "neg" || n.t === "not") && mentionsIt([n.a])) return true;
      if (n.t === "call" && mentionsIt(n.args)) return true;
    }
    return false;
  }

  /* The value after `let x =`, `for x in`, or `return`.

     A bare word here stays a literal — `let who = Ada` sets who to
     "Ada". An earlier draft made a bare word mean "run this command
     and use its answer" so that `let n = count $list` would work,
     which reads nicely right up until it silently contradicts the
     one rule the whole language rests on: $name is a variable,
     everything else is a literal. Calls in a value need brackets:
     `let n = (count $list)`. One extra pair, one rule kept. */
  function valueExpr(toks, from, n, what) {
    if (from >= toks.length) throw new Error("line " + n + ": " + what + " needs a value");
    var ex = parseExpr(toks, from, 1);
    if (ex.pos < toks.length) {
      throw new Error("line " + n + ": trailing '" + toks[ex.pos].v + "' after " + what);
    }
    return ex.node;
  }

  /* `and` / `or` as words, because they read better than && and
     nobody has to reach for the symbols. Normalised here so the
     evaluator only ever sees one form. */
  function normaliseWords(toks) {
    return toks.map(function (t) {
      if (t.k === "word" && t.v === "and") return { k: "op", v: "&&" };
      if (t.k === "word" && t.v === "or") return { k: "op", v: "||" };
      return t;
    });
  }

  /* ---- statement parser ----------------------------------------
     Blocks are found by scanning line by line for openers and
     `end`, which keeps the structure obvious in error messages:
     "if on line 4 was never closed" beats a parser stack dump. */
  /* A plain {} here is a real bug, not a style nit: OPENERS["constructor"]
     inherits a truthy function, so a line reading `constructor` parsed as
     a block opener and failed with "needs something after it" instead of
     "no such command". Same reason the command registry is null-prototype. */
  var OPENERS = Object.create(null);
  OPENERS["if"] = 1; OPENERS["repeat"] = 1; OPENERS["while"] = 1;

  function parse(src) {
    var lines = String(src).split(/\r?\n/);
    var prepared = [];
    for (var i = 0; i < lines.length; i++) {
      var toks;
      try { toks = normaliseWords(tokenize(lines[i])); }
      catch (e) { throw new Error("line " + (i + 1) + ": " + e.message); }
      prepared.push({ n: i + 1, toks: toks, text: lines[i] });
    }

    var pos = 0;

    function block(depth, stopWords) {
      if (depth > MAX_DEPTH) throw new Error("blocks nested more than " + MAX_DEPTH + " deep");
      var body = [];
      while (pos < prepared.length) {
        var L = prepared[pos];
        if (!L.toks.length) { pos++; continue; }
        var head = L.toks[0];
        var word = (head.k === "word") ? head.v : null;

        if (word && stopWords.indexOf(word) >= 0) return { body: body, stop: word, at: L.n };

        /* ---- for name in <expr> ----
           Parsed separately from the other openers because its
           header has a shape rather than just a condition. */
        if (word === "for") {
          var forLine = L.n;
          var ft = L.toks;
          if (ft.length < 4 || (ft[1].k !== "word" && ft[1].k !== "var") ||
              !(ft[2].k === "word" && ft[2].v === "in")) {
            throw new Error("line " + L.n + ": for needs   for name in <list>");
          }
          var varName = ft[1].v;
          var srcExpr = { node: valueExpr(ft, 3, L.n, "the list") };
          pos++;
          var fb = block(depth + 1, ["end"]);
          if (fb.stop !== "end") {
            throw new Error("line " + forLine + ": 'for' was never closed with 'end'");
          }
          pos++;
          body.push({ t: "for", n: forLine, name: varName, src: srcExpr.node, body: fb.body });
          continue;
        }

        /* ---- def name a b ... ----
           Functions were deliberately left out of v1 and are the
           thing that turned out to matter most: without them a
           script that does one job twice has to say it twice, and
           the terminal's whole value is composing small pieces. */
        if (word === "def") {
          var defLine = L.n;
          var dt = L.toks;
          if (dt.length < 2 || dt[1].k !== "word") {
            throw new Error("line " + L.n + ": def needs a name, like   def greet who");
          }
          var fname = dt[1].v;
          if (!/^[a-z][a-z0-9-]*$/.test(fname)) {
            throw new Error("line " + L.n + ": function names are lowercase words: '" + fname + "'");
          }
          var params = [];
          for (var pi = 2; pi < dt.length; pi++) {
            if (dt[pi].k !== "word" && dt[pi].k !== "var") {
              throw new Error("line " + L.n + ": parameter names must be plain words");
            }
            params.push(dt[pi].v);
          }
          pos++;
          var db = block(depth + 1, ["end"]);
          if (db.stop !== "end") {
            throw new Error("line " + defLine + ": 'def " + fname + "' was never closed with 'end'");
          }
          pos++;
          body.push({ t: "def", n: defLine, name: fname, params: params, body: db.body });
          continue;
        }

        if (word && OPENERS[word]) {
          var opener = word, openLine = L.n;
          var condToks = L.toks.slice(1);
          if (!condToks.length) {
            throw new Error("line " + L.n + ": '" + opener + "' needs something after it");
          }
          var cond = parseExpr(condToks, 0, 1);
          if (cond.pos < condToks.length) {
            throw new Error("line " + L.n + ": trailing '" +
              condToks[cond.pos].v + "' after the " + opener + " condition");
          }
          pos++;

          var stops = opener === "if" ? ["end", "else", "elif"] : ["end"];
          var inner = block(depth + 1, stops);
          var elseBody = null;

          if (opener !== "if") {
            if (inner.stop !== "end") {
              throw new Error("line " + openLine + ": '" + opener + "' was never closed with 'end'");
            }
            pos++;                                // consume the end
            body.push({ t: opener, n: openLine, cond: cond.node, body: inner.body, else: null });
            continue;
          }

          /* An if/elif/else chain is collected iteratively and then
             folded into plain nested ifs, so the evaluator needs no
             new node type.

             It is NOT parsed by rewriting `elif` into `if` and
             recursing, which is what this did first: the recursive
             call kept reading past the chain's own `end` and every
             following statement in the file landed inside the else
             branch. The whole rest of the script then ran only when
             the first condition was false — silently, with no parse
             error to point at. */
          var clauses = [{ n: openLine, cond: cond.node, body: inner.body }];
          var stop = inner.stop;

          while (stop === "elif") {
            var eLine = prepared[pos].n;
            var eToks = prepared[pos].toks.slice(1);
            if (!eToks.length) throw new Error("line " + eLine + ": 'elif' needs a condition");
            var eCond = parseExpr(eToks, 0, 1);
            if (eCond.pos < eToks.length) {
              throw new Error("line " + eLine + ": trailing '" +
                eToks[eCond.pos].v + "' after the elif condition");
            }
            pos++;
            var eb2 = block(depth + 1, ["end", "else", "elif"]);
            clauses.push({ n: eLine, cond: eCond.node, body: eb2.body });
            stop = eb2.stop;
          }

          if (stop === "else") {
            pos++;
            var eb = block(depth + 1, ["end"]);
            if (eb.stop !== "end") {
              throw new Error("line " + openLine + ": 'else' was never closed with 'end'");
            }
            elseBody = eb.body;
            stop = "end";
          }
          if (stop !== "end") {
            throw new Error("line " + openLine + ": 'if' was never closed with 'end'");
          }
          pos++;                                  // consume the end

          var folded = elseBody;
          for (var ci = clauses.length - 1; ci >= 0; ci--) {
            folded = [{ t: "if", n: clauses[ci].n, cond: clauses[ci].cond,
                        body: clauses[ci].body, else: folded }];
          }
          body.push(folded[0]);
          continue;
        }

        if (word === "else" || word === "end" || word === "elif") {
          throw new Error("line " + L.n + ": '" + word + "' with no matching if/repeat/while/for");
        }

        body.push(statement(L));
        pos++;
      }
      return { body: body, stop: null, at: 0 };
    }

    function statement(L) {
      var t = L.toks;
      var w0 = t[0].k === "word" ? t[0].v : null;

      /* let name = expression */
      if (w0 === "let") {
        if (t.length < 4 || (t[1].k !== "word" && t[1].k !== "var") ||
            !(t[2].k === "op" && t[2].v === "=")) {
          throw new Error("line " + L.n + ": let needs   let name = value");
        }
        var name = t[1].v;
        return { t: "let", n: L.n, name: name, value: valueExpr(t, 3, L.n, "the value") };
      }

      /* Loop control. Implemented as signals rather than exceptions
         thrown past the budget checks, so a `break` cannot be used
         to escape a runaway-loop guard. */
      if (w0 === "break" && t.length === 1) return { t: "break", n: L.n };
      if (w0 === "continue" && t.length === 1) return { t: "continue", n: L.n };

      /* return [expression] */
      if (w0 === "return") {
        if (t.length === 1) return { t: "return", n: L.n, value: null };
        return { t: "return", n: L.n, value: valueExpr(t, 1, L.n, "the returned value") };
      }

      if (!w0) throw new Error("line " + L.n + ": a line must start with a command name");

      return pipeline(L);
    }

    /* ---- pipelines and -> ----------------------------------------

       THE SECOND RULE OF THE LANGUAGE.

         rule 1   $name is a variable, everything else is a literal
         rule 2   |  sends the answer along
         rule 3   -> names the answer

       Three sentences, and between them they remove the thing that
       makes small scripting languages awkward at this size: needing
       brackets to use one command's answer in another. Before this,
       counting the words in a file read

         let words = (split (read notes.txt) " ")
         let n = (count $words)
         say $n

       inside-out, which is the order a parser likes and not the
       order a person thinks in. Now it reads left to right, in the
       order the work happens:

         read notes.txt | split " " | count -> $n

       The brackets still work and are still the right answer inside
       an `if` or a `let`. The pipe is for a line that is a sequence
       of steps, which is most of them.

       HOW THE ANSWER ARRIVES. It becomes the first argument of the
       next command — unless that command mentions `$it`, in which
       case it goes there instead and nothing is prepended. One
       sentence, and it covers both `| count` (where first-argument
       is obviously right) and `| say "there are $it words"` (where
       it obviously is not). */
    function pipeline(L) {
      var toks = L.toks;

      /* `-> name` at the end, before the split, so a pipe inside the
         target is impossible rather than merely unlikely. */
      var into = null;
      for (var i = 0; i < toks.length; i++) {
        if (toks[i].k === "op" && toks[i].v === "->") {
          var tgt = toks[i + 1];
          if (!tgt || (tgt.k !== "var" && tgt.k !== "word")) {
            throw new Error("line " + L.n + ": -> needs a name after it, like  -> $total");
          }
          if (toks.length > i + 2) {
            throw new Error("line " + L.n + ": nothing may follow  -> " +
              (tgt.k === "var" ? "$" : "") + tgt.v);
          }
          if (i === 0) throw new Error("line " + L.n + ": -> needs something to name");
          into = tgt.v;
          toks = toks.slice(0, i);
          break;
        }
      }

      /* Split on pipes that are not inside brackets. A `|` inside
         (…) belongs to the expression there, not to this line. */
      var stages = [], startAt = 0, depth = 0;
      for (var j = 0; j < toks.length; j++) {
        var tk = toks[j];
        if (tk.k === "op" && tk.v === "(") depth++;
        else if (tk.k === "op" && tk.v === ")") depth--;
        else if (tk.k === "op" && tk.v === "|" && depth === 0) {
          stages.push(toks.slice(startAt, j));
          startAt = j + 1;
        }
      }
      stages.push(toks.slice(startAt));

      var built = stages.map(function (sToks, idx) {
        if (!sToks.length) {
          throw new Error("line " + L.n + ": there is nothing " +
            (idx === 0 ? "before" : "after") + " a |");
        }
        if (sToks[0].k !== "word") {
          throw new Error("line " + L.n + ": each step of a pipeline starts with " +
            "a command name");
        }
        var args = argNodes(sToks, 1, false).args;
        return { name: sToks[0].v, args: args, usesIt: mentionsIt(args) };
      });

      if (built.length === 1 && !into) {
        return { t: "cmd", n: L.n, name: built[0].name, args: built[0].args };
      }
      return { t: "pipe", n: L.n, stages: built, into: into };
    }

    var top = block(0, []);
    if (top.stop) throw new Error("line " + top.at + ": stray '" + top.stop + "'");
    return top.body;
  }

  /* ---- values --------------------------------------------------
     Deliberately few. Numbers, strings, booleans, lists. No
     objects: a language whose values you cannot print is one you
     cannot debug from a terminal. */
  /* ---- records --------------------------------------------------

     A record is a plain object with named fields, and it is a plain
     object on purpose rather than a tagged wrapper: it means JSON
     that comes back from the relay IS a record already, with nothing
     to convert and nothing to unwrap. `fetch <url> | json | field
     title` works because the middle step produces exactly the shape
     the language already understands.

     The rule that keeps it honest is that a record must be
     PRINTABLE. Everything in this language can be shown as text —
     that is what makes it debuggable from a terminal — so show()
     renders a record as `name=Ada age=30` rather than [object
     Object], and nesting is rendered too rather than elided. */
  function isRecord(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (v === 0 || v === "") return false;
    if (v === "false" || v === "no" || v === "off") return false;
    if (Array.isArray(v)) return v.length > 0;
    if (isRecord(v)) return Object.keys(v).length > 0;
    return true;
  }

  function show(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) {
      return v.map(function (x) { return show(x, depth + 1); }).join(", ");
    }
    if (isRecord(v)) {
      /* Bounded, because a record fetched from somewhere else can
         be as deep as that somewhere else felt like making it, and
         a terminal line is not the place to find that out. */
      if (depth > 4) return "…";
      var ks = Object.keys(v);
      if (!ks.length) return "(empty record)";
      return ks.map(function (k) {
        var inner = show(v[k], depth + 1);
        return k + "=" + (Array.isArray(v[k]) || isRecord(v[k]) ? "[" + inner + "]" : inner);
      }).join(" ");
    }
    if (typeof v === "number") {
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
    }
    return String(v);
  }

  function numeric(v, op) {
    var n = typeof v === "number" ? v : Number(v);
    if (typeof v === "boolean") n = v ? 1 : 0;
    if (Number.isNaN(n)) throw new Error("'" + show(v) + "' is not a number, so " + op + " cannot use it");
    return n;
  }

  /* ---- the command registry ------------------------------------
     The extension point. A module calls command({...}) and its
     verb exists in every terminal from then on. Kept on a null
     prototype so a command called "constructor" is a command and
     not a disaster. */
  var commands = Object.create(null);

  function command(def) {
    if (!def || !def.name) throw new Error("a command needs a name");
    if (typeof def.run !== "function") throw new Error("command '" + def.name + "' needs run()");
    if (!/^[a-z][a-z0-9-]*$/.test(def.name)) {
      throw new Error("command names are lowercase words: '" + def.name + "'");
    }
    /* Registration is global and first-come. A second module
       quietly taking a name already in use would change what
       every existing script does — including saved ones — with
       nothing on screen to say so. Deliberate replacement is
       still possible, it just has to be said out loud. */
    if (commands[def.name] && !def.replace) {
      throw new Error("a command called '" + def.name + "' already exists. " +
        "Pass replace: true if that is really the intent.");
    }
    commands[def.name] = {
      name: def.name,
      help: def.help || "",
      usage: def.usage || def.name,
      group: def.group || "general",
      guestSafe: !!def.guestSafe,
      minArgs: def.minArgs || 0,
      run: def.run
    };
    return commands[def.name];
  }

  function list() {
    return Object.keys(commands).sort().map(function (k) { return commands[k]; });
  }

  function get(name) { return commands[name] || null; }

  /* ---- interpreter ---------------------------------------------
     `io` carries the host's output sink and its guest flag, so the
     same interpreter serves the terminal, a saved-script runner
     and the test suite without any of them knowing about the DOM. */
  function makeEnv(io) {
    var env = {
      vars: Object.create(null),
      fns: Object.create(null),
      steps: 0,
      lines: 0,
      depth: 0,
      ret: undefined,
      io: io || { print: function () {} },
      stop: false
    };
    env.parent = env;          // the budget root is itself
    return env;
  }

  function budget(env) {
    var root = env.parent || env;
    if (++root.steps > MAX_STEPS) {
      throw new Error("this script ran more than " + MAX_STEPS +
        " steps and was stopped. Check that every loop condition can become false.");
    }
  }

  function emit(env, text, cls) {
    var root = env.parent || env;
    if (++root.lines > MAX_OUTPUT) {
      throw new Error("this script printed more than " + MAX_OUTPUT +
        " lines and was stopped. Narrow it down, or write to a record instead.");
    }
    env.io.print(text, cls);
  }

  /* String interpolation. Only inside quotes, only $name, and an
     unknown name resolves to empty rather than throwing — the
     alternative makes every "$path/$file" a landmine. */
  function interpolate(s, env) {
    return String(s).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, function (m, name) {
      return name in env.vars ? show(env.vars[name]) : "";
    });
  }

  async function evalNode(node, env) {
    budget(env);
    switch (node.t) {
      case "lit": return node.v;
      case "str": return interpolate(node.v, env);
      case "var":
        if (!(node.v in env.vars)) {
          throw new Error("$" + node.v + " has not been set. Use:  let " + node.v + " = something");
        }
        return env.vars[node.v];
      case "neg": {
        var a = await evalNode(node.a, env);
        return node.sign === "-" ? -numeric(a, "-") : numeric(a, "+");
      }
      case "not": return !truthy(await evalNode(node.a, env));
      case "call": return await invoke(node.name, node.args, env);
      case "bin": {
        var op = node.op;
        /* Short-circuit before evaluating the right side. */
        if (op === "&&") return truthy(await evalNode(node.a, env)) ? truthy(await evalNode(node.b, env)) : false;
        if (op === "||") return truthy(await evalNode(node.a, env)) ? true : truthy(await evalNode(node.b, env));

        var x = await evalNode(node.a, env);
        var y = await evalNode(node.b, env);

        if (op === "==") return looseEq(x, y);
        if (op === "!=") return !looseEq(x, y);
        if (op === "+") {
          /* + concatenates when either side is a non-numeric
             string, which is what someone typing `say ($a + $b)`
             almost always means. */
          if (typeof x === "string" && Number.isNaN(Number(x))) return show(x) + show(y);
          if (typeof y === "string" && Number.isNaN(Number(y))) return show(x) + show(y);
          return numeric(x, "+") + numeric(y, "+");
        }
        var nx = numeric(x, op), ny = numeric(y, op);
        if (op === "-") return nx - ny;
        if (op === "*") return nx * ny;
        if (op === "/") {
          if (ny === 0) throw new Error("cannot divide by zero");
          return nx / ny;
        }
        if (op === "%") {
          if (ny === 0) throw new Error("cannot take a remainder by zero");
          return nx % ny;
        }
        if (op === "<") return nx < ny;
        if (op === ">") return nx > ny;
        if (op === "<=") return nx <= ny;
        if (op === ">=") return nx >= ny;
        throw new Error("unknown operator " + op);
      }
    }
    throw new Error("cannot evaluate " + node.t);
  }

  function looseEq(x, y) {
    if (typeof x === typeof y) return x === y;
    if (typeof x === "number" || typeof y === "number") {
      var a = Number(x), b = Number(y);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
    }
    return show(x) === show(y);
  }

  /* Control flow travels as a returned signal rather than a thrown
     exception. A thrown break would unwind past the budget checks
     in execStatement, which is exactly the sort of hole that turns
     a loop ceiling into a suggestion. Signals cannot skip a frame:
     every caller has to look at the value and decide.

       null        carry on
       "break"     leave the nearest loop
       "continue"  next iteration of the nearest loop
       "return"    leave the nearest function (env.ret holds the value) */
  async function execBlock(body, env) {
    /* Function declarations are hoisted within their block so a
       script reads top-down: calling a helper defined at the
       bottom of the file should not be an error. */
    for (var h = 0; h < body.length; h++) {
      if (body[h].t === "def") defineFn(body[h], env);
    }
    for (var i = 0; i < body.length; i++) {
      if (env.stop) return null;
      var sig = await execStatement(body[i], env);
      if (sig) return sig;
    }
    return null;
  }

  function defineFn(st, env) {
    env.fns[st.name] = { name: st.name, params: st.params, body: st.body, line: st.n };
  }

  /* A function call is a command call whose target happens to be
     user-defined. Looked up AFTER built-ins so a script cannot
     shadow `say` and quietly change what every other script does. */
  async function callFn(fn, args, env) {
    if (env.depth >= MAX_CALL_DEPTH) {
      throw new Error("functions nested more than " + MAX_CALL_DEPTH +
        " deep — a function is probably calling itself with no way out");
    }
    /* Its own variable scope. Sharing the caller's would make a
       helper's behaviour depend on what the caller happened to
       name things, which is the bug that makes shell functions
       miserable. Functions and commands are still shared, so a
       helper can call another helper. */
    var inner = {
      vars: Object.create(null),
      fns: env.fns,
      io: env.io,
      depth: env.depth + 1,
      ret: undefined,
      stop: env.stop,
      /* Budgets are shared by reference through the parent, so a
         recursive function cannot get a fresh allowance each call. */
      parent: env.parent || env
    };
    for (var i = 0; i < fn.params.length; i++) {
      inner.vars[fn.params[i]] = i < args.length ? args[i] : null;
    }
    inner.vars["args"] = args.slice();
    var sig = await execBlock(fn.body, inner);
    if (sig === "break" || sig === "continue") {
      throw new Error("'" + sig + "' outside a loop, inside function '" + fn.name + "'");
    }
    return inner.ret === undefined ? null : inner.ret;
  }

  /* One path for "run a named thing and produce a value", shared
     by the `cmd` statement and the ( ) call expression. Two copies
     of this is how the expression form ends up without the guest
     check the statement form has — the exact bug that turns a
     read-only mode into a suggestion. */
  async function invoke(name, nodes, env) {
    var c = commands[name];
    if (c && env.io.guest && !c.guestSafe) {
      throw new Error("'" + name + "' is not available in guest mode.");
    }
    /* Built-ins win. A script that could shadow `say` would quietly
       change what every other script on the drive does. */
    var fn = c ? null : env.fns[name];
    if (!c && !fn) {
      throw new Error("no command called '" + name + "'. Type  help  to see the list.");
    }

    var args = [];
    for (var a = 0; a < nodes.length; a++) args.push(await evalNode(nodes[a], env));

    if (fn) return await callFn(fn, args, env);
    if (args.length < c.minArgs) {
      throw new Error("'" + name + "' needs " + c.minArgs +
        " argument(s).  Usage: " + c.usage);
    }
    return await c.run({
      args: args,
      raw: args.map(show),
      env: env,
      print: function (t, cls) { emit(env, t, cls); },
      show: show
    });
  }

  async function execStatement(st, env) {
    budget(env);
    try {
      if (st.t === "def") { defineFn(st, env); return null; }

      if (st.t === "let") {
        env.vars[st.name] = await evalNode(st.value, env);
        return null;
      }
      if (st.t === "break") return "break";
      if (st.t === "continue") return "continue";
      if (st.t === "return") {
        env.ret = st.value ? await evalNode(st.value, env) : null;
        return "return";
      }
      if (st.t === "if") {
        if (truthy(await evalNode(st.cond, env))) return await execBlock(st.body, env);
        if (st.else) return await execBlock(st.else, env);
        return null;
      }
      if (st.t === "repeat") {
        var count = numeric(await evalNode(st.cond, env), "repeat");
        if (count < 0) throw new Error("repeat needs a count of zero or more");
        if (count > MAX_LOOP) {
          throw new Error("repeat " + count + " is over the " + MAX_LOOP + " iteration limit");
        }
        for (var r = 0; r < count && !env.stop; r++) {
          var rs = await execBlock(st.body, env);
          if (rs === "break") break;
          if (rs === "return") return rs;
        }
        return null;
      }
      if (st.t === "for") {
        var src = await evalNode(st.src, env);
        var items = Array.isArray(src) ? src : (src === null || src === "" ? [] : [src]);
        if (items.length > MAX_LOOP) {
          throw new Error("for over " + items.length + " items is past the " +
            MAX_LOOP + " iteration limit");
        }
        for (var fi = 0; fi < items.length && !env.stop; fi++) {
          env.vars[st.name] = items[fi];
          var fs = await execBlock(st.body, env);
          if (fs === "break") break;
          if (fs === "return") return fs;
        }
        return null;
      }
      if (st.t === "while") {
        var guard = 0;
        while (!env.stop && truthy(await evalNode(st.cond, env))) {
          if (++guard > MAX_LOOP) {
            throw new Error("this while loop passed " + MAX_LOOP +
              " iterations and was stopped. Check that the condition can become false.");
          }
          var ws = await execBlock(st.body, env);
          if (ws === "break") break;
          if (ws === "return") return ws;
        }
        return null;
      }
      if (st.t === "cmd") {
        /* A statement prints its answer; an expression keeps it.
           That is the only difference between the two forms. */
        var out = await invoke(st.name, st.args, env);
        if (out !== undefined && out !== null && out !== "") emit(env, show(out));
        return null;
      }
      if (st.t === "pipe") {
        var val = null;
        /* $it belongs to the pipeline, not to the script. Left set
           afterwards it would read as an ordinary variable on every
           later line, and a stale one — the answer of whichever
           chain happened to run last. Saved and put back rather
           than deleted, so a pipeline inside a pipeline's argument
           does not eat the outer one's $it. */
        var hadIt = Object.prototype.hasOwnProperty.call(env.vars, "it");
        var outerIt = env.vars["it"];
        try {
        for (var pi2 = 0; pi2 < st.stages.length; pi2++) {
          var stg = st.stages[pi2];
          var argv = stg.args;
          if (pi2 > 0) {
            /* $it is set for every stage past the first, whether or
               not this one uses it, so a later stage can still reach
               back for it in a string. */
            env.vars["it"] = val;
            /* Already a value, so it goes in as a `lit` — which
               evalNode hands straight back. Wrapping it as a `str`
               would run it through interpolation a second time and
               eat any $ a fetched page happened to contain. */
            if (!stg.usesIt) argv = [{ t: "lit", v: val }].concat(stg.args);
          }
          val = await invoke(stg.name, argv, env);

          /* A step that answers nothing cannot be piped from, and
             saying so is much better than what happened otherwise:
             `say hello | upper` quietly printed "hello" and then
             uppercased an empty string, which looks like `upper` is
             broken. undefined means "no answer"; null means "the
             answer is nothing", which is a real value and passes. */
          if (val === undefined && pi2 < st.stages.length - 1) {
            throw new Error("'" + stg.name + "' does not have an answer to pass along. " +
              "Only a step that produces a value can be followed by |. " +
              "Try putting it at the end of the line.");
          }
        }
        } finally {
          if (hadIt) env.vars["it"] = outerIt;
          else delete env.vars["it"];
        }
        if (st.into) { env.vars[st.into] = val === undefined ? null : val; return null; }
        if (val !== undefined && val !== null && val !== "") emit(env, show(val));
        return null;
      }
      throw new Error("cannot execute " + st.t);
    } catch (e) {
      /* Attach the line number once, at the innermost frame that
         has one. A stack of "line 4: line 4: line 4:" helps nobody. */
      if (e && !e.fkLine && st.n) {
        e.fkLine = st.n;
        e.message = "line " + st.n + ": " + e.message;
      }
      throw e;
    }
  }

  async function run(src, io) {
    var env = makeEnv(io);
    var ast = parse(src);
    var sig = await execBlock(ast, env);
    if (sig === "break" || sig === "continue") {
      throw new Error("'" + sig + "' used outside a loop");
    }
    return {
      steps: env.steps, lines: env.lines, vars: env.vars,
      functions: Object.keys(env.fns), returned: env.ret
    };
  }

  /* Check a script without running it. The terminal uses this to
     refuse to save something that cannot parse, which is worth
     doing because a saved script that fails on line 1 next week
     is worse than one that never saved. */
  function check(src) {
    try { parse(src); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  /* ---- the value-shaping built-ins ----------------------------
     Registered here rather than in the terminal because they are
     part of the language, not part of the console. `for` is
     useless without a way to make a list, and a language whose
     only data type is "one string" runs out of road immediately.

     All guest-safe: none of them touch the vault, the relay or a
     setting. They shape values and nothing else. */
  function registerCore() {
    command({ name: "list", group: "values", guestSafe: true, usage: "list <items...>",
      help: "Make a list from the arguments.",
      run: function (c) { return c.args.slice(); } });

    command({ name: "split", group: "values", guestSafe: true, usage: "split <text> [separator]",
      minArgs: 1, help: "Split text into a list. Separator defaults to a space.",
      run: function (c) {
        var sep = c.args.length > 1 ? show(c.args[1]) : " ";
        return show(c.args[0]).split(sep).filter(function (x) { return x !== ""; });
      } });

    command({ name: "join", group: "values", guestSafe: true, usage: "join <list> [separator]",
      minArgs: 1, help: "Join a list into text. Separator defaults to a space.",
      run: function (c) {
        var v = c.args[0];
        var sep = c.args.length > 1 ? show(c.args[1]) : " ";
        return (Array.isArray(v) ? v : [v]).map(show).join(sep);
      } });

    command({ name: "count", group: "values", guestSafe: true, usage: "count <list-or-text>",
      minArgs: 1, help: "How many items in a list, or characters in text.",
      run: function (c) {
        var v = c.args[0];
        return Array.isArray(v) ? v.length : show(v).length;
      } });

    command({ name: "item", group: "values", guestSafe: true, usage: "item <list> <n>",
      minArgs: 2, help: "One item from a list, counting from 1. Negative counts from the end.",
      run: function (c) {
        var v = Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]];
        var n = numeric(c.args[1], "item");
        /* One-based, because this is a language for people who
           have not written code before and "the first item is
           number 0" is a tax with no benefit at this size. */
        var i = n < 0 ? v.length + n : n - 1;
        if (i < 0 || i >= v.length) {
          throw new Error("there is no item " + n + " — the list has " + v.length);
        }
        return v[i];
      } });

    command({ name: "add", group: "values", guestSafe: true, usage: "add <list> <items...>",
      minArgs: 2, help: "A copy of the list with more items on the end.",
      run: function (c) {
        var v = Array.isArray(c.args[0]) ? c.args[0].slice() : [c.args[0]];
        return v.concat(c.args.slice(1));
      } });

    command({ name: "upper", group: "values", guestSafe: true, usage: "upper <text>",
      minArgs: 1, help: "Uppercase.",
      run: function (c) { return c.raw.join(" ").toUpperCase(); } });

    command({ name: "lower", group: "values", guestSafe: true, usage: "lower <text>",
      minArgs: 1, help: "Lowercase.",
      run: function (c) { return c.raw.join(" ").toLowerCase(); } });

    command({ name: "trim", group: "values", guestSafe: true, usage: "trim <text>",
      minArgs: 1, help: "Remove surrounding whitespace.",
      run: function (c) { return c.raw.join(" ").trim(); } });

    command({ name: "has", group: "values", guestSafe: true, usage: "has <haystack> <needle>",
      minArgs: 2, help: "true if the text or list contains the second argument.",
      run: function (c) {
        var hay = c.args[0], needle = c.args[1];
        if (Array.isArray(hay)) return hay.some(function (x) { return looseEq(x, needle); });
        return show(hay).indexOf(show(needle)) >= 0;
      } });

    command({ name: "round", group: "values", guestSafe: true, usage: "round <number> [places]",
      minArgs: 1, help: "Round a number.",
      run: function (c) {
        var n = numeric(c.args[0], "round");
        var p = c.args.length > 1 ? numeric(c.args[1], "round") : 0;
        var f = Math.pow(10, Math.max(0, Math.min(10, p)));
        return Math.round(n * f) / f;
      } });

    command({ name: "range", group: "values", guestSafe: true, usage: "range <n> | range <from> <to>",
      minArgs: 1, help: "A list of numbers, for use with 'for'.",
      run: function (c) {
        var from = c.args.length > 1 ? numeric(c.args[0], "range") : 1;
        var to = c.args.length > 1 ? numeric(c.args[1], "range") : numeric(c.args[0], "range");
        if (to - from + 1 > MAX_LOOP) {
          throw new Error("that range is longer than the " + MAX_LOOP + " item limit");
        }
        var out = [];
        for (var i = from; i <= to; i++) out.push(i);
        return out;
      } });
  }
  registerCore();

  /* ---- the rest of the standard library -------------------------

     Split from registerCore only because that function was already
     long, not because these are second class. Every one of them is
     guest-safe: they shape values and touch nothing else.

     The selection rule is "what a line of a pipeline wants to be".
     Once the pipe existed the gaps in the old set became obvious —
     there was no way to sort anything, no way to take the first
     three of something, and no way to turn a page of text into
     lines. Those are not exotic; they are most of what a small
     script does. */
  function registerMore() {
    var V = { group: "values", guestSafe: true };
    function def(extra) { command(Object.assign({}, V, extra)); }
    function asList(v) { return Array.isArray(v) ? v : (v === null || v === "" ? [] : [v]); }

    def({ name: "sort", usage: "sort <list> [down]", minArgs: 1,
      help: "Sort a list. Numbers sort as numbers, text as text. Add 'down' to reverse.",
      run: function (c) {
        var v = asList(c.args[0]).slice();
        var down = c.args.length > 1 && /^(down|desc|reverse|yes|true)$/i.test(show(c.args[1]));
        /* Numbers as numbers is the whole point: sorting 2, 10, 9 as
           text gives 10, 2, 9, which looks like the sort is broken. */
        var allNum = v.length > 0 && v.every(function (x) {
          return x !== "" && x !== null && !Number.isNaN(Number(x));
        });
        v.sort(allNum
          ? function (a, b) { return Number(a) - Number(b); }
          : function (a, b) { return show(a) < show(b) ? -1 : show(a) > show(b) ? 1 : 0; });
        return down ? v.reverse() : v;
      } });

    def({ name: "reverse", usage: "reverse <list-or-text>", minArgs: 1,
      help: "Backwards.",
      run: function (c) {
        var v = c.args[0];
        return Array.isArray(v) ? v.slice().reverse() : show(v).split("").reverse().join("");
      } });

    def({ name: "unique", usage: "unique <list>", minArgs: 1,
      help: "The list with repeats removed, keeping the first of each.",
      run: function (c) {
        var seen = Object.create(null), out = [];
        asList(c.args[0]).forEach(function (x) {
          var k = show(x);
          if (!(k in seen)) { seen[k] = 1; out.push(x); }
        });
        return out;
      } });

    def({ name: "first", usage: "first <list> [how-many]", minArgs: 1,
      help: "The first item, or the first n as a list.",
      run: function (c) {
        var v = asList(c.args[0]);
        if (c.args.length < 2) return v.length ? v[0] : null;
        return v.slice(0, Math.max(0, numeric(c.args[1], "first")));
      } });

    def({ name: "last", usage: "last <list> [how-many]", minArgs: 1,
      help: "The last item, or the last n as a list.",
      run: function (c) {
        var v = asList(c.args[0]);
        if (c.args.length < 2) return v.length ? v[v.length - 1] : null;
        var n = Math.max(0, numeric(c.args[1], "last"));
        return n === 0 ? [] : v.slice(-n);
      } });

    def({ name: "slice", usage: "slice <list> <from> [to]", minArgs: 2,
      help: "Part of a list, counting from 1. 'to' is included. Negative counts from the end.",
      run: function (c) {
        var v = asList(c.args[0]);
        var from = numeric(c.args[1], "slice");
        var to = c.args.length > 2 ? numeric(c.args[2], "slice") : v.length;
        if (from < 0) from = v.length + from + 1;
        if (to < 0) to = v.length + to + 1;
        return v.slice(Math.max(0, from - 1), Math.max(0, to));
      } });

    def({ name: "without", usage: "without <list> <items...>", minArgs: 2,
      help: "A copy of the list with those items taken out.",
      run: function (c) {
        var drop = c.args.slice(1).map(show);
        return asList(c.args[0]).filter(function (x) { return drop.indexOf(show(x)) < 0; });
      } });

    def({ name: "only", usage: "only <list> <text>", minArgs: 2,
      help: "Just the items that contain that text.",
      run: function (c) {
        var needle = show(c.args[1]);
        return asList(c.args[0]).filter(function (x) { return show(x).indexOf(needle) >= 0; });
      } });

    def({ name: "where", usage: "where <list-of-records> <field> <value>", minArgs: 3,
      help: "Just the records whose field equals that value.",
      run: function (c) {
        var key = show(c.args[1]), want = c.args[2];
        return asList(c.args[0]).filter(function (r) {
          return isRecord(r) && looseEq(r[key], want);
        });
      } });

    def({ name: "pluck", usage: "pluck <list-of-records> <field>", minArgs: 2,
      help: "One field out of every record, as a list.",
      run: function (c) {
        var key = show(c.args[1]);
        return asList(c.args[0]).map(function (r) {
          return isRecord(r) && r[key] !== undefined ? r[key] : null;
        });
      } });

    def({ name: "sum", usage: "sum <list>", minArgs: 1,
      help: "Add up a list of numbers.",
      run: function (c) {
        return asList(c.args[0]).reduce(function (t, x) { return t + numeric(x, "sum"); }, 0);
      } });

    def({ name: "min", usage: "min <list> | min <a> <b> ...", minArgs: 1,
      help: "The smallest number.",
      run: function (c) {
        var v = c.args.length > 1 ? c.args : asList(c.args[0]);
        if (!v.length) throw new Error("min needs at least one number");
        return Math.min.apply(null, v.map(function (x) { return numeric(x, "min"); }));
      } });

    def({ name: "max", usage: "max <list> | max <a> <b> ...", minArgs: 1,
      help: "The largest number.",
      run: function (c) {
        var v = c.args.length > 1 ? c.args : asList(c.args[0]);
        if (!v.length) throw new Error("max needs at least one number");
        return Math.max.apply(null, v.map(function (x) { return numeric(x, "max"); }));
      } });

    def({ name: "lines", usage: "lines <text>", minArgs: 1,
      help: "Split text into a list of lines, dropping the blank ones.",
      run: function (c) {
        return show(c.args[0]).split(/\r?\n/)
          .map(function (l) { return l.trim(); })
          .filter(function (l) { return l !== ""; });
      } });

    def({ name: "words", usage: "words <text>", minArgs: 1,
      help: "Split text into a list of words.",
      run: function (c) {
        return show(c.args[0]).split(/\s+/).filter(function (w) { return w !== ""; });
      } });

    def({ name: "replace", usage: "replace <text> <find> <with>", minArgs: 3,
      help: "Swap every occurrence. Plain text, not a pattern.",
      run: function (c) {
        return show(c.args[0]).split(show(c.args[1])).join(show(c.args[2]));
      } });

    def({ name: "starts", usage: "starts <text> <prefix>", minArgs: 2,
      help: "true if the text begins with that.",
      run: function (c) { return show(c.args[0]).indexOf(show(c.args[1])) === 0; } });

    def({ name: "ends", usage: "ends <text> <suffix>", minArgs: 2,
      help: "true if the text finishes with that.",
      run: function (c) {
        var h = show(c.args[0]), n = show(c.args[1]);
        return n === "" || h.slice(-n.length) === n;
      } });

    def({ name: "number", usage: "number <text>", minArgs: 1,
      help: "Turn text into a number. Fails loudly if it is not one.",
      run: function (c) { return numeric(c.args[0], "number"); } });

    def({ name: "text", usage: "text <anything>", minArgs: 1,
      help: "Turn anything into its printed form.",
      run: function (c) { return show(c.args[0]); } });

    /* ---- records ----------------------------------------------- */

    def({ name: "record", usage: "record <name> <value> ...", minArgs: 2,
      help: "Build a record from name/value pairs.",
      run: function (c) {
        if (c.args.length % 2 !== 0) {
          throw new Error("record needs pairs — a name and a value for each field");
        }
        var r = {};
        for (var i = 0; i < c.args.length; i += 2) r[show(c.args[i])] = c.args[i + 1];
        return r;
      } });

    def({ name: "field", usage: "field <record> <name>", minArgs: 2,
      help: "One field out of a record.",
      run: function (c) {
        var r = c.args[0], k = show(c.args[1]);
        if (!isRecord(r)) throw new Error("field needs a record, not " + describe(r));
        if (!(k in r)) {
          /* Naming what IS there. A silent empty here is how one
             typo in a field name becomes an hour of confusion. */
          var ks = Object.keys(r);
          throw new Error("that record has no field called '" + k + "'. It has: " +
            (ks.length ? ks.join(", ") : "nothing"));
        }
        return r[k];
      } });

    def({ name: "fields", usage: "fields <record>", minArgs: 1,
      help: "The names of a record's fields, as a list.",
      run: function (c) {
        if (!isRecord(c.args[0])) {
          throw new Error("fields needs a record, not " + describe(c.args[0]));
        }
        return Object.keys(c.args[0]);
      } });

    def({ name: "with", usage: "with <record> <name> <value>", minArgs: 3,
      help: "A copy of the record with one field set.",
      run: function (c) {
        if (!isRecord(c.args[0])) {
          throw new Error("with needs a record, not " + describe(c.args[0]));
        }
        var out = Object.assign({}, c.args[0]);
        out[show(c.args[1])] = c.args[2];
        return out;
      } });

    def({ name: "json", usage: "json <text>", minArgs: 1,
      help: "Read JSON text into records and lists.",
      run: function (c) {
        try { return JSON.parse(show(c.args[0]).trim()); }
        catch (e) { throw new Error("that is not JSON — " + e.message); }
      } });

    def({ name: "kind", usage: "kind <anything>", minArgs: 1,
      help: "What sort of value this is: number, text, list, record, yes-or-no.",
      run: function (c) { return describe(c.args[0]); } });
  }

  /* Used by the messages above, so "field needs a record" can say
     what it got instead. A message naming only what was expected
     leaves you guessing at what you actually passed. */
  function describe(v) {
    if (v === null || v === undefined) return "nothing";
    if (Array.isArray(v)) return "a list";
    if (isRecord(v)) return "a record";
    if (typeof v === "number") return "a number";
    if (typeof v === "boolean") return "yes-or-no";
    return "text";
  }
  registerMore();

  FieldKit.provide("critterscript", {
    VERSION: "3",
    NAME: "CritterScript",
    MAX_STEPS: MAX_STEPS,
    MAX_OUTPUT: MAX_OUTPUT,
    MAX_LOOP: MAX_LOOP,
    MAX_CALL_DEPTH: MAX_CALL_DEPTH,
    command: command,
    isRecord: isRecord,
    describe: describe,
    list: list,
    get: get,
    run: run,
    check: check,
    parse: parse,
    tokenize: tokenize,
    show: show,
    truthy: truthy
  });
})(window.FieldKit);
