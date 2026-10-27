/* ============================================================
   FieldKit :: msg-crypto
   The crypto behind messaging (§14.2). Standalone on purpose.

   WHY IT IS NOT core/crypto.js. That file is the vault's, and
   OUTPOST does not carry it — the whole point of that build is
   that there is no vault code on the drive. Messaging has to work
   in both builds, so it brings its own. The primitives are the same
   ones the vault uses (PBKDF2, HKDF, AES-GCM) and the shapes are
   deliberately familiar, but nothing here imports anything there.

   ---- THE THREE KEYS ------------------------------------------

   1. ACCOUNT KEY, from the password. One PBKDF2 pass, split by
      HKDF into two things that cannot be derived from each other:
        - `authSecret`, which goes to the server and is all it ever
          learns about your password;
        - `wrapKey`, which never leaves the machine and unwraps your
          private key.
      One pass rather than two because 600k iterations is the
      expensive part and doing it twice would double the unlock
      wait for no gain.

   2. IDENTITY KEYPAIR, ECDH P-256. The public half goes to the
      server and is public by definition — you need someone's to
      start a conversation with them. The private half is sealed
      under `wrapKey` and stored on the server in that state, so it
      travels between machines without the server being able to open
      it. That is what makes logging in on a new PC work at all.

   3. CONVERSATION KEY, AES-GCM 256, random per conversation. It is
      sealed once to each member's public key. The server holds a
      map of blobs it cannot read.

   ---- SEALING TO A PUBLIC KEY ---------------------------------

   A sealed box, the standard construction: generate a throwaway
   keypair, ECDH it against the recipient's public key, run the
   shared secret through HKDF, encrypt with the result, and send the
   throwaway public key along. The recipient does the same ECDH from
   the other side. Forward secrecy is NOT claimed — the recipient's
   long-term key opens every box ever sealed to it, which is exactly
   what makes reading your history on a new machine possible.

   ---- WHAT THIS DELIBERATELY DOES NOT DO ----------------------

   No ratcheting, no per-message keys, no deniability. This is not
   Signal and should not be described as if it were. What it is: the
   relay cannot read your messages, and neither can anyone who takes
   the disk. Losing the password loses the account's history, because
   the private key is sealed under it and nothing else can open it.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ITERATIONS = 600000;
  var CURVE = "P-256";
  var VERSION = 1;

  var subtle = (window.crypto && window.crypto.subtle) || null;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function available() { return !!subtle; }

  function requireSubtle() {
    if (!subtle) {
      throw new Error("crypto.subtle is unavailable on this origin — messaging cannot run here");
    }
    return subtle;
  }

  /* ---- encoding ------------------------------------------------
     base64 rather than hex for anything that travels: these are
     mostly 32-96 byte blobs and hex would make every message a
     third larger for no benefit. */
  function b64(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(String(str));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function hex(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  /* ---- 1. the account key -------------------------------------- */
  async function accountKeys(password, handle) {
    var s = requireSubtle();
    handle = String(handle || "").toLowerCase();
    if (!password) throw new Error("a password is required");
    if (!handle) throw new Error("a handle is required");

    /* The salt is derived from the handle rather than fetched from
       the server. Fetching one would mean asking "does this handle
       exist" before login, which hands out exactly the enumeration
       the login route is careful not to leak. Handles are unique, so
       two accounts never share a salt — which is the property that
       actually matters here. */
    var base = await s.importKey("raw", enc.encode(String(password)), "PBKDF2",
      false, ["deriveBits"]);
    var master = await s.deriveBits({
      name: "PBKDF2", salt: enc.encode("fieldkit-msg:" + handle),
      iterations: ITERATIONS, hash: "SHA-256"
    }, base, 256);

    var hk = await s.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);

    /* Two independent outputs from one pass. The server gets the
       first and can do nothing with it but recognise you; the second
       never leaves this machine. */
    var authBits = await s.deriveBits({
      name: "HKDF", hash: "SHA-256",
      salt: enc.encode("fieldkit-msg-salt"), info: enc.encode("auth")
    }, hk, 256);

    var wrapKey = await s.deriveKey({
      name: "HKDF", hash: "SHA-256",
      salt: enc.encode("fieldkit-msg-salt"), info: enc.encode("wrap")
    }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

    return { authSecret: hex(authBits), wrapKey: wrapKey };
  }

  /* ---- 2. the identity keypair --------------------------------- */
  async function newIdentity() {
    var s = requireSubtle();
    var pair = await s.generateKey({ name: "ECDH", namedCurve: CURVE }, true,
      ["deriveBits", "deriveKey"]);
    return pair;
  }

  async function exportPublic(pair) {
    var s = requireSubtle();
    return b64(await s.exportKey("raw", pair.publicKey));
  }

  async function importPublic(str) {
    var s = requireSubtle();
    return s.importKey("raw", unb64(str), { name: "ECDH", namedCurve: CURVE }, true, []);
  }

  /* The private key sealed under the password-derived key, in the
     form the server stores and hands back at login. */
  async function wrapPrivate(pair, wrapKey) {
    var s = requireSubtle();
    var pkcs8 = await s.exportKey("pkcs8", pair.privateKey);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await s.encrypt({ name: "AES-GCM", iv: iv }, wrapKey, pkcs8);
    return JSON.stringify({ v: VERSION, iv: b64(iv), ct: b64(ct) });
  }

  async function unwrapPrivate(wrapped, wrapKey) {
    var s = requireSubtle();
    var box;
    try { box = JSON.parse(String(wrapped)); }
    catch (e) { throw new Error("the stored private key is not readable"); }
    if (!box || !box.iv || !box.ct) throw new Error("the stored private key is malformed");

    var pkcs8;
    try {
      pkcs8 = await s.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, wrapKey, unb64(box.ct));
    } catch (e) {
      /* The only thing that reaches here in practice is a wrong
         password, and saying so plainly beats "operation failed". */
      throw new Error("WRONG_PASSWORD");
    }
    return s.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: CURVE }, true,
      ["deriveBits", "deriveKey"]);
  }

  /* ---- 3. conversation keys ------------------------------------ */
  async function newConversationKey() {
    var s = requireSubtle();
    return s.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  }

  async function sharedWrapKey(privateKey, publicKey, salt) {
    var s = requireSubtle();
    var bits = await s.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
    var hk = await s.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return s.deriveKey({
      name: "HKDF", hash: "SHA-256", salt: salt, info: enc.encode("fieldkit-msg-box")
    }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  /* Seal a conversation key to one member's public key. */
  async function sealTo(convKey, recipientPublicB64) {
    var s = requireSubtle();
    var recipient = await importPublic(recipientPublicB64);
    var eph = await s.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"]);

    var salt = crypto.getRandomValues(new Uint8Array(16));
    var kek = await sharedWrapKey(eph.privateKey, recipient, salt);

    var raw = await s.exportKey("raw", convKey);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await s.encrypt({ name: "AES-GCM", iv: iv }, kek, raw);

    return JSON.stringify({
      v: VERSION, epk: b64(await s.exportKey("raw", eph.publicKey)),
      salt: b64(salt), iv: b64(iv), ct: b64(ct)
    });
  }

  async function openSealed(box, myPrivateKey) {
    var s = requireSubtle();
    var b;
    try { b = JSON.parse(String(box)); }
    catch (e) { throw new Error("that key blob is not readable"); }
    if (!b || !b.epk || !b.iv || !b.ct) throw new Error("that key blob is malformed");

    var eph = await importPublic(b.epk);
    var kek = await sharedWrapKey(myPrivateKey, eph, unb64(b.salt));
    var raw;
    try {
      raw = await s.decrypt({ name: "AES-GCM", iv: unb64(b.iv) }, kek, unb64(b.ct));
    } catch (e) {
      throw new Error("NOT_FOR_ME");
    }
    return s.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true,
      ["encrypt", "decrypt"]);
  }

  /* ---- messages ------------------------------------------------- */
  async function sealMessage(convKey, payload) {
    var s = requireSubtle();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await s.encrypt({ name: "AES-GCM", iv: iv }, convKey,
      enc.encode(JSON.stringify(payload)));
    return JSON.stringify({ v: VERSION, iv: b64(iv), ct: b64(ct) });
  }

  async function openMessage(convKey, sealed) {
    var s = requireSubtle();
    var b;
    try { b = JSON.parse(String(sealed)); }
    catch (e) { throw new Error("UNREADABLE"); }
    if (!b || !b.iv || !b.ct) throw new Error("UNREADABLE");
    var plain;
    try {
      plain = await s.decrypt({ name: "AES-GCM", iv: unb64(b.iv) }, convKey, unb64(b.ct));
    } catch (e) {
      /* Usually the wrong epoch — the key was rotated and this
         message predates it, or postdates it. The caller can try
         another epoch's key rather than showing an error. */
      throw new Error("WRONG_KEY");
    }
    try { return JSON.parse(dec.decode(plain)); }
    catch (e) { throw new Error("UNREADABLE"); }
  }

  /* A short, stable fingerprint of a public key, for showing next to
     a handle. Two people can read four groups aloud and know they
     are talking to who they think — the only defence there is
     against a relay that hands out the wrong public key, and the one
     thing the server genuinely could lie about. */
  async function fingerprint(publicB64) {
    var s = requireSubtle();
    var d = hex(await s.digest("SHA-256", unb64(publicB64)));
    return d.slice(0, 16).toUpperCase().replace(/(.{4})/g, "$1 ").trim();
  }

  FieldKit.provide("msgCrypto", {
    VERSION: VERSION,
    ITERATIONS: ITERATIONS,
    available: available,
    accountKeys: accountKeys,
    newIdentity: newIdentity,
    exportPublic: exportPublic,
    importPublic: importPublic,
    wrapPrivate: wrapPrivate,
    unwrapPrivate: unwrapPrivate,
    newConversationKey: newConversationKey,
    sealTo: sealTo,
    openSealed: openSealed,
    sealMessage: sealMessage,
    openMessage: openMessage,
    fingerprint: fingerprint,
    _b64: b64, _unb64: unb64
  });
})(window.FieldKit);
