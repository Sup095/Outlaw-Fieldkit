/* ============================================================
   core/lockscreen.js — PIN derivation, verification, and the
   record it keeps.

   The DOM half (overlay, focus, inert) is not covered here; the
   harness has no real DOM. What is covered is everything that
   decides whether a PIN is accepted, plus the shape of what gets
   written into the vault.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js",
  "core/crypto.js", "core/lockscreen.js"
]);
const { ok, section, state } = makeRunner("lockscreen");

/* Minimal in-memory store standing in for the vault. */
function makeStore(unlocked) {
  const mem = new Map();
  let seq = 0;
  return {
    _mem: mem,
    async put(type, data, opts) {
      const id = (opts && opts.id) || "rec-" + (++seq);
      mem.set(id, { type, data });
      return { id, type };
    },
    async get(id) { const r = mem.get(id); return r ? r.data : null; },
    async list(type) {
      const out = [];
      mem.forEach((r, id) => { if (!type || r.type === type) out.push({ id, meta: { type: r.type }, data: r.data }); });
      return out;
    },
    async remove(id) { mem.delete(id); return true; },
    isUnlocked: () => unlocked,
    state: () => (unlocked ? "ONLINE" : "LOCKED")
  };
}

const lock = FieldKit.need("lockscreen");

(async function () {
  section("with no vault open");
  FieldKit.provide("store", makeStore(false));
  ok("hasPin() is false when the vault is locked", (await lock.hasPin()) === false);
  ok("verify() refuses when there is no PIN record", (await lock.verify("1234")) === false);
  ok("the lock is not engaged at rest", lock.isLocked() === false);

  section("setting a PIN");
  const store = makeStore(true);
  FieldKit.provide("store", store);
  FieldKit.emit("store:ready", {});         // clears the cached lookup

  for (const bad of ["", "12", "123", "abcd", "12a4", "1234567890123", "12 34", "-123"]) {
    let threw = false;
    try { await lock.setPin(bad); } catch (e) { threw = true; }
    if (!threw) { ok("rejects invalid PIN " + JSON.stringify(bad), false); break; }
  }
  ok("rejects PINs that are too short, too long, or not digits", true);

  await lock.setPin("4821");
  ok("hasPin() is true after setting one", (await lock.hasPin()) === true);

  const rows = await store.list("security");
  ok("exactly one security record was written", rows.length === 1, "got " + rows.length);
  const rec = rows[0].data;
  ok("the record is tagged as a screen lock", rec.kind === "screenlock");
  ok("the record has a salt", typeof rec.salt === "string" && rec.salt.length > 0);
  ok("the record records its iteration count", rec.iterations >= 100000, String(rec.iterations));
  ok("the record has a setAt timestamp", !isNaN(Date.parse(rec.setAt || "")));

  /* The whole point of hashing: the PIN itself must not be in there. */
  const serialised = JSON.stringify(rec);
  ok("the plaintext PIN is not stored anywhere in the record",
    serialised.indexOf("4821") < 0, serialised);
  ok("the stored hash is a 256-bit hex digest",
    /^[0-9a-f]{64}$/.test(rec.hash || ""), String(rec.hash).slice(0, 20));

  section("verifying");
  ok("the correct PIN verifies", (await lock.verify("4821")) === true);
  ok("a wrong PIN of the same length fails", (await lock.verify("4822")) === false);
  ok("a wrong PIN of a different length fails", (await lock.verify("482")) === false);
  ok("an empty PIN fails", (await lock.verify("")) === false);
  ok("a numeric argument verifies the same as its string form",
    (await lock.verify(4821)) === true);

  section("changing and clearing");
  await lock.setPin("903117");
  ok("changing the PIN reuses the same record", (await store.list("security")).length === 1);
  ok("the old PIN no longer verifies", (await lock.verify("4821")) === false);
  ok("the new PIN verifies", (await lock.verify("903117")) === true);

  const newSalt = (await store.list("security"))[0].data.salt;
  ok("changing the PIN generates a fresh salt", newSalt !== rec.salt);

  await lock.clearPin();
  ok("clearPin removes the record", (await store.list("security")).length === 0);
  ok("hasPin() is false after clearing", (await lock.hasPin()) === false);
  ok("verify() fails after clearing", (await lock.verify("903117")) === false);

  section("salt independence");
  /* Two vaults with the same PIN must not produce the same hash,
     or one leaked hash would tell you about the other. */
  const s1 = makeStore(true);
  FieldKit.provide("store", s1);
  FieldKit.emit("store:ready", {});
  await lock.setPin("1234");
  const h1 = (await s1.list("security"))[0].data;

  const s2 = makeStore(true);
  FieldKit.provide("store", s2);
  FieldKit.emit("store:ready", {});
  await lock.setPin("1234");
  const h2 = (await s2.list("security"))[0].data;

  ok("the same PIN under different salts yields different hashes",
    h1.hash !== h2.hash, h1.hash.slice(0, 12) + " vs " + h2.hash.slice(0, 12));
  ok("the salts themselves differ", h1.salt !== h2.salt);

  section("published limits");
  ok("MAX_ATTEMPTS is a small finite number", lock.MAX_ATTEMPTS > 0 && lock.MAX_ATTEMPTS <= 10,
    String(lock.MAX_ATTEMPTS));
  ok("MIN_PIN is at least 4", lock.MIN_PIN >= 4);
  ok("MAX_PIN leaves room for a long PIN", lock.MAX_PIN >= 8);

  /* The lock inerts #fk-desktop, which does nothing about listeners
     bound to window — and the command palette and the easter-egg
     watcher are both there by design. Ctrl+K went straight through:
     the palette rendered UNDER the overlay (z-index 9500 vs 9600)
     while SYNC NOW, CLOSE ALL WINDOWS and shell.open() all ran
     against the still-unlocked vault, with no visible sign anything
     had happened. The guard has to be here, in one place, because
     easter-eggs.js is forbidden by its own blast-radius rule from
     even asking whether the screen is locked. */
  section("the lock actually stops keystrokes reaching the app");
  {
    const s = makeStore(true);
    FieldKit.provide("store", s);
    FieldKit.emit("store:ready", {});
    await lock.setPin("5150");
    await lock.engage({});
    ok("it is locked", lock.isLocked() === true);

    let reachedApp = 0;
    const spy = () => { reachedApp++; };
    global.window.addEventListener("keydown", spy, true);

    /* A key pressed at the desktop, exactly as Ctrl+K would arrive. */
    const desktop = global.document.getElementById("fk-desktop") || global.document.body;
    global.window.dispatchEvent({ type: "keydown", key: "k", ctrlKey: true,
      target: desktop, preventDefault() {}, stopImmediatePropagation() { this._stopped = true; } });
    ok("a keystroke aimed at the desktop never reaches a window listener",
      reachedApp === 0, "reached " + reachedApp + " time(s)");

    /* The PIN field must still receive its digits, or the lock can
       never be dismissed — a guard that swallowed everything would
       be a very secure brick. */
    const overlay = global.document.getElementById("fk-lock");
    ok("the lock overlay is in the document", !!overlay);
    const pinField = overlay && overlay.querySelector(".lk-pin");
    ok("the PIN field is inside it", !!pinField);

    let reachedPin = 0;
    const pinSpy = () => { reachedPin++; };
    global.window.addEventListener("keydown", pinSpy, true);
    global.window.dispatchEvent({ type: "keydown", key: "5", target: pinField,
      preventDefault() {}, stopImmediatePropagation() {} });
    ok("a keystroke inside the lock overlay is let through", reachedPin > 0,
      "reached " + reachedPin);
    global.window.removeEventListener("keydown", pinSpy, true);

    global.window.removeEventListener("keydown", spy, true);
    lock.release();
    reachedApp = 0;
    global.window.addEventListener("keydown", spy, true);
    global.window.dispatchEvent({ type: "keydown", key: "k", ctrlKey: true,
      target: desktop, preventDefault() {}, stopImmediatePropagation() {} });
    ok("keystrokes flow again once released", reachedApp > 0);
    global.window.removeEventListener("keydown", spy, true);
  }

  section("engage() refuses when it would be pointless");
  FieldKit.provide("store", makeStore(false));
  FieldKit.emit("store:ready", {});
  await lock.engage({});
  ok("engage() does nothing while the vault is locked", lock.isLocked() === false);

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + e.stack);
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});
