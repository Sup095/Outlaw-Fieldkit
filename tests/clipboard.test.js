/* ============================================================
   ui.copy / ui.download / ui.textDump — getting text off a
   machine you do not control.

   This exists because the diagnostic worked at school and the
   report could not be copied off it. The original bug: on a
   platform with no `navigator.clipboard` at all, `.writeText`
   throws a TypeError synchronously, so the `.catch()` that was
   supposed to handle "clipboard blocked" never ran and the
   button silently did nothing.

   The rule these tests enforce: no matter what the platform
   takes away, there is always a route to the text.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js"]);
const { ok, section, state } = makeRunner("clipboard");
const ui = FieldKit.need("ui");

const doc = global.document;
const nav = global.navigator;

function dump() { return doc.getElementById("fk-textdump"); }
function closeDump() { const d = dump(); if (d && d.parentNode) d.parentNode.removeChild(d); }
function dumpText() {
  const d = dump();
  if (!d) return null;
  const ta = d.querySelector("textarea");
  return ta ? ta.value : null;
}
/* The fake DOM does not aggregate textContent up the tree, so read
   the leaves directly rather than pretending it is a browser. */
function dumpWords() {
  const d = dump();
  if (!d) return "";
  const out = [];
  (function walk(n) {
    if (n.textContent) out.push(n.textContent);
    (n.children || []).forEach(walk);
  })(d);
  return out.join(" ");
}

/* Each of these is a platform we have to survive. */
function platformWithClipboard(behaviour) {
  nav.clipboard = { writeText: behaviour };
}
function platformWithNoClipboardAtAll() { delete nav.clipboard; }
function platformWithBrokenClipboardObject() { nav.clipboard = {}; }

let execResult = true, execCalls = 0, execSaw = null;
doc.execCommand = function (cmd) {
  execCalls++;
  if (cmd === "copy") {
    const ta = doc.activeElement;
    execSaw = ta && typeof ta.value === "string" ? ta.value : null;
  }
  return execResult;
};

(async function () {
  const TEXT = "FIELDKIT SELF-TEST REPORT\nline two\nline three";

  section("the happy path");
  {
    let got = null;
    platformWithClipboard(async (t) => { got = t; });
    const how = await ui.copy(TEXT);
    ok("it uses the clipboard API when it works", how === "clipboard", String(how));
    ok("the text arrived intact", got === TEXT);
    ok("nothing was shown on screen", !dump());
  }

  section("no clipboard object at all — the original bug");
  {
    /* Before the fix this threw a TypeError out of copyReport and
       the button did nothing at all. */
    platformWithNoClipboardAtAll();
    execResult = true; execCalls = 0; execSaw = null;
    let threw = null;
    let how;
    try { how = await ui.copy(TEXT); } catch (e) { threw = e; }
    ok("it does not throw", !threw, threw && threw.message);
    ok("it falls back to execCommand", how === "execCommand", String(how));
    ok("execCommand was actually called", execCalls === 1);
    ok("execCommand received the full text", execSaw === TEXT);
    ok("the scratch textarea was cleaned up",
      [...doc.querySelectorAll("textarea")].every((t) => t.value !== TEXT || dump()));
  }

  section("a clipboard object with no writeText");
  {
    platformWithBrokenClipboardObject();
    execResult = true; execCalls = 0;
    const how = await ui.copy(TEXT);
    ok("it is treated as absent, not called", how === "execCommand" && execCalls === 1);
  }

  section("clipboard present but refused");
  {
    platformWithClipboard(async () => { throw new Error("NotAllowedError"); });
    execResult = true; execCalls = 0;
    const how = await ui.copy(TEXT);
    ok("a rejected promise falls through to execCommand", how === "execCommand");
    ok("execCommand ran once", execCalls === 1);
  }

  section("clipboard throws synchronously");
  {
    nav.clipboard = { get writeText() { throw new Error("blocked by policy"); } };
    execResult = true; execCalls = 0;
    let threw = null, how;
    try { how = await ui.copy(TEXT); } catch (e) { threw = e; }
    ok("a throwing getter does not escape", !threw, threw && threw.message);
    ok("it still reaches a working route", how === "execCommand");
  }

  section("everything is blocked — the route that cannot fail");
  {
    platformWithNoClipboardAtAll();
    execResult = false;
    closeDump();
    const how = await ui.copy(TEXT, { title: "SELF-TEST REPORT", note: "clipboard is blocked" });
    ok("it reports that nothing copied", how === null, String(how));
    ok("the text is put on screen instead", !!dump());
    ok("the whole text is there, unaltered", dumpText() === TEXT);
    ok("the box says what it is", /SELF-TEST REPORT/.test(dumpWords()), dumpWords().slice(0, 120));
    ok("it explains why", /clipboard is blocked/.test(dumpWords()));
    ok("the textarea is not read-only — selecting must work",
      dump().querySelector("textarea").readOnly !== true);

    const buttons = [...dump().querySelectorAll("button")].map((b) => b.textContent);
    ok("it offers to select everything", buttons.some((t) => /SELECT ALL/.test(t)));
    ok("it offers to try again", buttons.some((t) => /TRY COPY AGAIN/.test(t)));
    ok("it can be closed", buttons.some((t) => /CLOSE/.test(t)));

    [...dump().querySelectorAll("button")].find((b) => /CLOSE/.test(b.textContent)).click();
    ok("closing removes it", !dump());
  }

  section("silent mode, for text that must not go on screen");
  {
    /* A vault secret that failed to copy must not be dumped into a
       modal where it sits visible until someone closes it. */
    platformWithNoClipboardAtAll();
    execResult = false;
    closeDump();
    const how = await ui.copy("ptlc_a-real-looking-secret", { silent: true });
    ok("it still reports failure", how === null);
    ok("nothing was rendered", !dump());
  }

  section("opening a second dump does not stack overlays");
  {
    platformWithNoClipboardAtAll();
    execResult = false;
    closeDump();
    ui.textDump("first", "ONE");
    ui.textDump("second", "TWO");
    ok("only one overlay exists", doc.querySelectorAll("#fk-textdump").length === 1);
    ok("it shows the newest text", dumpText() === "second");
    closeDump();
  }

  section("odd payloads");
  {
    platformWithNoClipboardAtAll();
    execResult = false;
    const cases = [
      ["", "an empty report"],
      ["a".repeat(200000), "a very long report"],
      ["tab\there\nnewline\r\nwindows", "whitespace and line endings"],
      ["unicode: § · — ✱ é", "non-ASCII"],
      ["</textarea><script>alert(1)</script>", "text that looks like markup"]
    ];
    let allIntact = true, detail = "";
    for (const [text, label] of cases) {
      closeDump();
      await ui.copy(text);
      if (dumpText() !== text) { allIntact = false; detail = label; break; }
    }
    ok("every payload survives the round trip unaltered", allIntact, detail);

    closeDump();
    await ui.copy("</textarea><script>alert(1)</script>");
    ok("markup is text, not DOM — nothing was injected",
      dump().querySelectorAll("script").length === 0);
    closeDump();

    let threw = null;
    try { await ui.copy(null); await ui.copy(undefined); } catch (e) { threw = e; }
    ok("null and undefined do not throw", !threw, threw && threw.message);
    closeDump();
  }

  section("download");
  {
    const clicks = [];
    const realCreate = doc.createElement.bind(doc);
    doc.createElement = function (tag) {
      const node = realCreate(tag);
      /* ui.el routes unknown attributes through setAttribute, so the
         filename lands in attributes, not on the node. */
      if (String(tag).toLowerCase() === "a") {
        node.click = function () { clicks.push(node.attributes.download); };
      }
      return node;
    };

    global.URL = global.URL || {};
    global.URL.createObjectURL = () => "blob:fake";
    global.URL.revokeObjectURL = () => {};
    global.Blob = global.Blob || function (parts) { this.parts = parts; };

    ok("a working download reports true", ui.download("hello", "report.txt") === true);
    ok("the filename is carried through", clicks[clicks.length - 1] === "report.txt");

    global.URL.createObjectURL = () => { throw new Error("blocked"); };
    ok("a blocked download reports false rather than throwing",
      ui.download("hello", "report.txt") === false);

    doc.createElement = realCreate;
  }

  section("no module reaches for the clipboard directly any more");
  {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..");
    const offenders = [];
    for (const dir of ["core", "modules"]) {
      for (const f of fs.readdirSync(path.join(root, dir))) {
        if (!f.endsWith(".js")) continue;
        const src = fs.readFileSync(path.join(root, dir, f), "utf8");
        if (f === "ui.js") continue;
        if (/navigator\.clipboard/.test(src)) offenders.push(dir + "/" + f);
      }
    }
    ok("every caller goes through ui.copy", offenders.length === 0, offenders.join(", "));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + e.stack);
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});
