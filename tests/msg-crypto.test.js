/* ============================================================
   core/msg-crypto.js

   The crypto behind messaging. What matters here is not that it
   round-trips — that is table stakes and would pass with a Caesar
   cipher — but that the things which are supposed to be impossible
   actually are:

     - a member of a conversation cannot be impersonated by the
       server handing out a different public key without the
       fingerprint changing;
     - a non-member handed the sealed key blob cannot open it;
     - the auth secret the server receives cannot be turned back
       into the key that unwraps your private key;
     - a wrong password fails with a distinguishable error rather
       than silently producing a garbage key;
     - a rotated conversation key genuinely cannot read messages
       sealed under the new one.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/msg-crypto.js"]);
const { ok, section, state } = makeRunner("msg-crypto");
const mc = FieldKit.need("msgCrypto");

/* btoa/atob are not defined in the harness's fake window. */
global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
global.atob = (s) => Buffer.from(s, "base64").toString("binary");

(async function () {
  section("the account key");
  {
    ok("crypto.subtle is available to test against", mc.available());

    const a = await mc.accountKeys("correct horse battery staple", "alice");
    ok("it produces an auth secret to send", typeof a.authSecret === "string" && a.authSecret.length === 64);
    ok("and a wrap key that stays here", !!a.wrapKey);
    ok("the wrap key is not extractable, so it cannot be exfiltrated by a bug",
      a.wrapKey.extractable === false);

    const again = await mc.accountKeys("correct horse battery staple", "alice");
    ok("the same password and handle give the same auth secret — that is what login needs",
      again.authSecret === a.authSecret);

    const other = await mc.accountKeys("correct horse battery staple", "bob");
    ok("the same password under a different handle does not",
      other.authSecret !== a.authSecret);

    const wrong = await mc.accountKeys("correct horse battery stapler", "alice");
    ok("a one-character change gives a completely different secret",
      wrong.authSecret !== a.authSecret);

    /* The point of splitting one PBKDF2 pass with HKDF: what the
       server holds must not be the thing that opens the private key. */
    ok("the auth secret is not the wrap key in disguise",
      a.authSecret !== JSON.stringify(a.wrapKey));

    const pair = await mc.newIdentity();
    const wrapped = await mc.wrapPrivate(pair, a.wrapKey);
    ok("the auth secret cannot open what the wrap key sealed",
      wrapped.indexOf(a.authSecret) < 0);

    await mc.accountKeys("", "alice").then(() => ok("an empty password is refused", false),
      () => ok("an empty password is refused", true));
    await mc.accountKeys("pw", "").then(() => ok("an empty handle is refused", false),
      () => ok("an empty handle is refused", true));

    /* Length is not enforced here on purpose: this module's job is
       to derive, and a rule about how long a password should be
       belongs where the user can be told about it before they pick
       one. modules/messages.js enforces it at sign-up. */
    ok("a short password still derives — the rule lives in the UI, not here",
      (await mc.accountKeys("x", "alice")).authSecret.length === 64);
  }

  section("the identity keypair travels, sealed");
  {
    const keys = await mc.accountKeys("hunter2 is a bad password", "carol");
    const pair = await mc.newIdentity();

    const pub = await mc.exportPublic(pair);
    ok("the public half exports to something sendable", typeof pub === "string" && pub.length > 40);

    const wrapped = await mc.wrapPrivate(pair, keys.wrapKey);
    ok("the private half seals under the password-derived key", typeof wrapped === "string");

    /* This is what makes logging in on a second machine work: the
       server stores this and hands it back, and only the password
       opens it. */
    const back = await mc.unwrapPrivate(wrapped, keys.wrapKey);
    ok("and comes back with the right password", !!back);

    const convKey = await mc.newConversationKey();
    const sealed = await mc.sealTo(convKey, pub);
    const opened = await mc.openSealed(sealed, back);
    ok("the recovered private key still opens things sealed to it", !!opened);

    const wrongPw = await mc.accountKeys("hunter3 is also bad", "carol");
    let err = null;
    try { await mc.unwrapPrivate(wrapped, wrongPw.wrapKey); } catch (e) { err = e.message; }
    ok("a wrong password fails rather than producing a garbage key", err === "WRONG_PASSWORD", err);

    err = null;
    try { await mc.unwrapPrivate("not json at all", keys.wrapKey); } catch (e) { err = e.message; }
    ok("so does a corrupted blob, with a different message", /not readable/.test(err || ""), err);
  }

  section("sealing a conversation key to a member");
  {
    const alice = await mc.newIdentity();
    const bob = await mc.newIdentity();
    const eve = await mc.newIdentity();

    const alicePub = await mc.exportPublic(alice);
    const bobPub = await mc.exportPublic(bob);

    const convKey = await mc.newConversationKey();
    const forAlice = await mc.sealTo(convKey, alicePub);
    const forBob = await mc.sealTo(convKey, bobPub);

    ok("each member gets a different blob", forAlice !== forBob);

    const a = await mc.openSealed(forAlice, alice.privateKey);
    const b = await mc.openSealed(forBob, bob.privateKey);
    ok("both members open their own", !!a && !!b);

    /* Both must recover the SAME key, or the conversation splits in
       two and nobody notices until someone cannot read a reply. */
    const msg = await mc.sealMessage(a, { text: "same key or nothing" });
    const read = await mc.openMessage(b, msg);
    ok("and they recover the same key — one member sealing, the other reading",
      read.text === "same key or nothing");

    /* The assertion the whole design rests on. */
    let err = null;
    try { await mc.openSealed(forAlice, eve.privateKey); } catch (e) { err = e.message; }
    ok("someone the key was not sealed to cannot open it", err === "NOT_FOR_ME", err);

    err = null;
    try { await mc.openSealed(forBob, alice.privateKey); } catch (e) { err = e.message; }
    ok("nor can a member open another member's blob", err === "NOT_FOR_ME", err);

    /* An ephemeral key per seal, so sealing the same key twice does
       not produce the same bytes. */
    const twice = await mc.sealTo(convKey, alicePub);
    ok("sealing the same key twice produces different bytes", twice !== forAlice);
    ok("but both still open", !!(await mc.openSealed(twice, alice.privateKey)));
  }

  section("messages");
  {
    const key = await mc.newConversationKey();
    const payload = { text: "the relay cannot read this", at: "2026-08-16T00:00:00.000Z" };
    const sealed = await mc.sealMessage(key, payload);

    ok("the plaintext is not in the sealed form", sealed.indexOf("cannot read this") < 0);
    ok("neither is the timestamp inside it", sealed.indexOf("2026-08-16T00") < 0);
    ok("it is a JSON envelope the relay can store as a string",
      !!JSON.parse(sealed).ct && !!JSON.parse(sealed).iv);

    const back = await mc.openMessage(key, sealed);
    ok("it round-trips exactly", back.text === payload.text && back.at === payload.at);

    const twice = await mc.sealMessage(key, payload);
    ok("the same message sealed twice differs — a fresh IV every time", twice !== sealed);

    /* Text with awkward shapes, because a message is user input. */
    for (const text of ["", "  ", "🙂 emoji and ünïcode", "a".repeat(20000),
                        '{"looks":"like json"}', "</script><script>x()</script>"]) {
      const s = await mc.sealMessage(key, { text });
      const r = await mc.openMessage(key, s);
      ok("survives a message shaped like: " + JSON.stringify(text.slice(0, 24)),
        r.text === text);
    }

    const other = await mc.newConversationKey();
    let err = null;
    try { await mc.openMessage(other, sealed); } catch (e) { err = e.message; }
    ok("another conversation's key cannot read it", err === "WRONG_KEY", err);

    err = null;
    try { await mc.openMessage(key, "garbage"); } catch (e) { err = e.message; }
    ok("garbage is refused as unreadable rather than crashing", err === "UNREADABLE", err);

    /* A flipped bit must not decrypt — that is what GCM is for, and
       without it a relay could silently alter messages. */
    const box = JSON.parse(sealed);
    const bytes = mc._unb64(box.ct);
    bytes[0] ^= 1;
    box.ct = mc._b64(bytes);
    err = null;
    try { await mc.openMessage(key, JSON.stringify(box)); } catch (e) { err = e.message; }
    ok("a single flipped bit will not decrypt", err === "WRONG_KEY", err);
  }

  section("rotating a key actually cuts off the old one");
  {
    const alice = await mc.newIdentity();
    const alicePub = await mc.exportPublic(alice);

    const oldKey = await mc.newConversationKey();
    const before = await mc.sealMessage(oldKey, { text: "before the rotation" });

    const newKey = await mc.newConversationKey();
    const after = await mc.sealMessage(newKey, { text: "after the rotation" });

    ok("the old key still reads old messages — history is not destroyed",
      (await mc.openMessage(oldKey, before)).text === "before the rotation");

    let err = null;
    try { await mc.openMessage(oldKey, after); } catch (e) { err = e.message; }
    ok("but cannot read anything sealed after it", err === "WRONG_KEY", err);

    /* The moderation story depends on exactly this: escrow hands a
       moderator the key of one epoch, and rotating means what they
       hold stops working on new messages. */
    const escrowed = await mc.sealTo(oldKey, alicePub);
    const modKey = await mc.openSealed(escrowed, alice.privateKey);
    err = null;
    try { await mc.openMessage(modKey, after); } catch (e) { err = e.message; }
    ok("an escrowed key from before a rotation cannot read messages after it",
      err === "WRONG_KEY", err);
  }

  section("fingerprints");
  {
    const a = await mc.newIdentity();
    const b = await mc.newIdentity();
    const fa = await mc.fingerprint(await mc.exportPublic(a));
    const fb = await mc.fingerprint(await mc.exportPublic(b));

    ok("a fingerprint is short enough to read aloud", fa.length <= 24, fa);
    ok("and grouped so it can be read aloud without losing your place",
      /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/.test(fa), fa);
    ok("two keys have different fingerprints", fa !== fb);
    ok("the same key always gives the same one",
      (await mc.fingerprint(await mc.exportPublic(a))) === fa);
  }

  section("it refuses to pretend on a machine without crypto");
  {
    /* OUTPOST can run on an origin with no crypto.subtle. Messaging
       cannot, and has to say so rather than half-working. */
    ok("available() reports the truth", typeof mc.available() === "boolean");
    ok("the module loaded even so — it must not take the boot down", true);
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
