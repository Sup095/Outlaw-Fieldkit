/* ============================================================
   The recovery key is a credential, not a consolation prize.

   It unwraps the same master key the password does, so it already
   grants complete access to the plaintext. But it never sees the
   password, and the relay authenticates with a password-derived
   token — so for a long time a recovery unlock produced a vault
   that could read everything locally and could not talk to the
   relay at all.

   That was worse than it sounds, because it was unrecoverable in
   the literal sense. The escape hatch is "set a new password and
   upload the new header", and uploading a header authenticates
   with the token you already hold. No token, no upload. No upload,
   no new password. Forgetting your password cost you the relay
   permanently, and the boot screen suggested you reconnect.

   So the recovery key now derives its own relay credential under a
   separate HKDF label. These tests hold that line, and hold the
   two properties that make it safe: a password change must not
   invalidate the recovery key, and the two credentials must stay
   distinct.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js",
  "core/crypto.js", "core/store.js"
]);
const { ok, section, state } = makeRunner("recovery");
const crypto_ = FieldKit.need("crypto");

const PASSWORD = "correct-horse-battery-staple";
const ITERATIONS = 1000;          // fast; the KDF cost is not what is under test

(async function () {
  section("a new vault gives the recovery key its own relay credential");
  const made = await crypto_.createVault(PASSWORD, { iterations: ITERATIONS });
  const header = made.vault.header;

  ok("the header carries a recovery auth hash", !!header.recoveryAuthKeyHash);
  ok("it is not the same as the password auth hash",
    header.recoveryAuthKeyHash !== header.authKeyHash);
  ok("both are base64 SHA-256 digests",
    /^[A-Za-z0-9+/]{43}=$/.test(header.authKeyHash) &&
    /^[A-Za-z0-9+/]{43}=$/.test(header.recoveryAuthKeyHash));

  section("unlocking with the recovery key produces a usable token");
  const rec = await crypto_.unlockWithRecovery(header, made.recoveryKey);

  ok("it is not the all-zero token the old code produced",
    rec.authToken !== "0".repeat(64), rec.authToken.slice(0, 16));
  ok("the token is 64 hex characters", /^[0-9a-f]{64}$/.test(rec.authToken));
  ok("it is flagged as a recovery unlock", rec.openedWithRecovery === true);
  ok("it still asks for a new password to be set", rec.needsNewPassword === true);
  ok("it is not marked local-only, because this vault supports it",
    rec.recoveryOnlyLocal === false);

  /* The relay hashes the token it receives and compares. Same
     computation here: if these do not match, every authenticated
     call 401s and the session is the trap all over again. */
  const digest = await sha256B64(hexToBytes(rec.authToken));
  ok("its SHA-256 matches the header's recoveryAuthKeyHash",
    digest === header.recoveryAuthKeyHash, digest + " vs " + header.recoveryAuthKeyHash);
  ok("and does NOT match the password hash", digest !== header.authKeyHash);

  section("the password credential is unchanged by any of this");
  const byPass = await crypto_.unlockVault(header, PASSWORD);
  const passDigest = await sha256B64(hexToBytes(byPass.authToken));
  ok("the password token still matches authKeyHash", passDigest === header.authKeyHash);
  ok("the two credentials are different tokens", byPass.authToken !== rec.authToken);
  ok("a password unlock is not flagged as recovery", !byPass.openedWithRecovery);
  ok("and does not demand a new password", !byPass.needsNewPassword);

  section("both credentials open the same data");
  const box = await byPass.seal({ secret: "the same plaintext" });
  const viaRecovery = await rec.open(box);
  ok("the recovery key reads what the password wrote",
    viaRecovery && viaRecovery.secret === "the same plaintext");

  section("changing the password does not invalidate the recovery key");
  /* changePassword mutates the header in place, so these have to be
     captured by value first — comparing against `header` afterwards
     compares the object with itself and passes for the wrong reason. */
  const authBefore = header.authKeyHash;
  const recAuthBefore = header.recoveryAuthKeyHash;

  const NEW_PASSWORD = "an-entirely-different-passphrase";
  const updated = await byPass.changePassword(NEW_PASSWORD);

  ok("the password auth hash changed", updated.authKeyHash !== authBefore);
  ok("the recovery auth hash did NOT change",
    updated.recoveryAuthKeyHash === recAuthBefore);

  const recAfter = await crypto_.unlockWithRecovery(updated, made.recoveryKey);
  ok("the original recovery key still opens the vault", !!recAfter);
  const recAfterDigest = await sha256B64(hexToBytes(recAfter.authToken));
  ok("and still authenticates to the relay",
    recAfterDigest === updated.recoveryAuthKeyHash);

  const byNew = await crypto_.unlockVault(updated, NEW_PASSWORD);
  const newDigest = await sha256B64(hexToBytes(byNew.authToken));
  ok("the new password authenticates", newDigest === updated.authKeyHash);

  let oldRejected = false;
  try { await crypto_.unlockVault(updated, PASSWORD); }
  catch (e) { oldRejected = true; }
  ok("the old password no longer opens it", oldRejected);

  const stillReadable = await byNew.open(box);
  ok("data written under the old password is still readable",
    stillReadable && stillReadable.secret === "the same plaintext");

  section("a vault predating this is honest about it rather than broken");
  /* An old header has no recoveryAuthKeyHash. It must still unlock
     locally — the data is not lost — but it must SAY it cannot
     reach the relay, instead of arming a token that always 401s and
     then blaming the network. */
  const legacy = JSON.parse(JSON.stringify(header));
  delete legacy.recoveryAuthKeyHash;
  const legacyRec = await crypto_.unlockWithRecovery(legacy, made.recoveryKey);

  ok("it still unlocks", !!legacyRec);
  ok("it is flagged local-only", legacyRec.recoveryOnlyLocal === true);
  const legacyBox = await legacyRec.seal({ n: 1 });
  const legacyBack = await legacyRec.open(legacyBox);
  ok("local encryption still works", legacyBack && legacyBack.n === 1);

  section("a wrong recovery key is refused, with one clear message");
  /* Whether it is the wrong key, too short, or has a character the
     alphabet does not contain, the person typing it made the same
     mistake and should see the same sentence — not a base32
     decoder's internals. */
  const badKeys = [
    ["a well-formed but wrong key", "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789"],
    ["a key that is too short", "ABCD-EFGH"],
    ["a key with characters outside the alphabet", "!!!!-????-@@@@-####-$$$$-%%%%-^^^^-&&&&"],
    ["an empty key", ""]
  ];
  for (const [label, key] of badKeys) {
    let code = null, message = null;
    try { await crypto_.unlockWithRecovery(updated, key); }
    catch (e) { code = e.code; message = e.message; }
    ok(label + " is refused as BAD_RECOVERY", code === "BAD_RECOVERY",
      String(code) + " / " + String(message));
    ok(label + " does not leak decoder internals",
      message === "recovery key is not valid for this vault", String(message));
  }

  section("the recovery key never reaches the header");
  const raw = JSON.stringify(header);
  ok("the plain key is absent", raw.indexOf(made.recoveryKey) < 0);
  ok("the ungrouped key is absent", raw.indexOf(made.recoveryKey.replace(/-/g, "")) < 0);
  ok("neither derived token is in the header",
    raw.indexOf(rec.authToken) < 0 && raw.indexOf(byPass.authToken) < 0);

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + e.stack);
  console.log("\nRESULT  pass " + state.pass + "  fail " + (state.fail + 1));
  process.exit(1);
});

/* ---- helpers ---- */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function sha256B64(bytes) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}
