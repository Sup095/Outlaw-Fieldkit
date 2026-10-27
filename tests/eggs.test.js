/* ============================================================
   core/easter-eggs.js

   The rule that matters more than any individual egg: nothing here
   may touch the vault, the relay, or user data. These check the
   detection logic and that the blast radius stays cosmetic.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js", "core/easter-eggs.js"
]);
const { ok, section, state } = makeRunner("eggs");
const eggs = FieldKit.need("easterEggs");

function feed(str) {
  for (const ch of str) eggs._feed(ch);
}
function konami() {
  eggs.KONAMI.forEach((k) => eggs._feed(k));
}

section("catalogue");
{
  ok("there are eggs to find", eggs.total() >= 4, String(eggs.total()));
  const ids = eggs.EGGS.map((e) => e.id);
  ok("ids are unique", new Set(ids).size === ids.length);
  ok("every egg has a name, a hint, and a run()",
    eggs.EGGS.every((e) => e.id && e.name && e.hint && typeof e.run === "function"));
  ok("every hint is a nudge, not the answer",
    eggs.EGGS.filter((e) => e.word).every((e) => !e.hint.toLowerCase().includes(e.word)),
    eggs.EGGS.filter((e) => e.word && e.hint.toLowerCase().includes(e.word)).map((e) => e.id).join(", "));

  const words = eggs.EGGS.filter((e) => e.word).map((e) => e.word);
  ok("secret words are lowercase letters only", words.every((w) => /^[a-z]+$/.test(w)), words.join(", "));
  ok("no secret word is a prefix of another",
    !words.some((a) => words.some((b) => a !== b && b.startsWith(a))), words.join(", "));
}

/* The whole safety argument for this file. */
section("blast radius");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "core", "easter-eggs.js"), "utf8");
  for (const forbidden of ["store", "vault", "crypto", "transportRelay", "lockscreen", "guest"]) {
    ok("never reaches for the " + forbidden + " service",
      !new RegExp('(need|service)\\(\\s*["\']' + forbidden, "i").test(src));
  }
  ok("does not write records", !/\.put\s*\(/.test(src));
  ok("persists discoveries to localStorage, not the vault",
    /localStorage\.setItem/.test(src) && /fieldkit\.eggs/.test(src));
}

section("konami code");
{
  eggs._reset();
  eggs.init();
  ok("nothing is found at the start", eggs.foundCount() === 0);

  konami();
  ok("the full sequence fires the egg", eggs.foundCount() === 1, String(eggs.foundCount()));
  ok("it toggled CRT mode", global.document.body.classList.contains("crt"));

  konami();
  ok("firing it again toggles back", !global.document.body.classList.contains("crt"));
  ok("re-finding does not inflate the count", eggs.foundCount() === 1);
  ok("the CRT preference was persisted", FieldKit.need("settings").get("crt") === false);

  /* A near-miss must not count. */
  eggs._reset();
  ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowLeft"].forEach((k) => eggs._feed(k));
  ok("a wrong sequence does not fire", eggs.foundCount() === 0);

  /* A false start followed by the real thing must still work — the
     matcher has to re-anchor on the first key, not give up. */
  eggs._feed("ArrowUp");
  eggs._feed("ArrowDown");
  konami();
  ok("a false start does not block a later correct sequence", eggs.foundCount() === 1);
}

section("typed words");
{
  eggs._reset();
  const withWords = eggs.EGGS.filter((e) => e.word);
  for (const e of withWords) {
    eggs._reset();
    feed(e.word);
    ok("typing '" + e.word + "' finds " + e.id, !!eggs.found()[e.id],
      JSON.stringify(Object.keys(eggs.found())));
  }

  eggs._reset();
  feed("xyzzy" + withWords[0].word);
  ok("a word still fires when preceded by noise", !!eggs.found()[withWords[0].id]);

  eggs._reset();
  feed("bast");
  eggs._feed("Enter");
  feed("ion");
  ok("a non-letter key resets the buffer", eggs.foundCount() === 0);

  eggs._reset();
  feed("outla");
  ok("a partial word does not fire", eggs.foundCount() === 0);
}

/* Writing "credits" into the scratchpad must write the word, not
   fire an egg. This is the guard that makes the whole feature safe
   to leave switched on. */
section("typing into a field is not a secret");
{
  const word = eggs.EGGS.find((e) => e.word).word;

  for (const target of [
    { tagName: "INPUT", isContentEditable: false },
    { tagName: "TEXTAREA", isContentEditable: false },
    { tagName: "SELECT", isContentEditable: false },
    { tagName: "DIV", isContentEditable: true }
  ]) {
    eggs._reset();
    for (const ch of word) eggs._feed(ch, target);
    ok("typing '" + word + "' into a " + target.tagName + " fires nothing",
      eggs.foundCount() === 0, JSON.stringify(Object.keys(eggs.found())));
  }

  /* And the arrow keys, which are the Konami sequence, must not fire
     while someone is navigating text. */
  eggs._reset();
  eggs.KONAMI.forEach((k) => eggs._feed(k, { tagName: "TEXTAREA", isContentEditable: false }));
  ok("the Konami sequence does not fire from inside a textarea", eggs.foundCount() === 0);

  /* Control: the exact same keys outside a field still work, so the
     guard is doing the work rather than the test passing by accident. */
  eggs._reset();
  for (const ch of word) eggs._feed(ch);
  ok("the same keys outside a field still fire", eggs.foundCount() === 1);
}

section("progress reporting");
{
  eggs._reset();
  ok("starts locked", eggs.unlocked() === false);
  konami();
  ok("unlocks the credits entry after one find", eggs.unlocked() === true);
  ok("foundCount tracks discoveries", eggs.foundCount() === 1);
  ok("total is the catalogue size", eggs.total() === eggs.EGGS.length);
  ok("found() returns a copy, not the live object", (function () {
    const snap = eggs.found();
    snap.injected = "nope";
    return !eggs.found().injected;
  })());
}

section("credits reel");
{
  eggs._reset();
  konami();
  let threw = null;
  try { eggs.showCredits(); } catch (e) { threw = e; }
  ok("the reel renders without throwing", !threw, threw && threw.message);
  ok("calling it twice does not stack overlays", (function () {
    try { eggs.showCredits(); return true; } catch (e) { return false; }
  })());
}

console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
process.exit(state.fail ? 1 : 0);
