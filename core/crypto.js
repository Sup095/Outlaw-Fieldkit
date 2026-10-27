/* ============================================================
   FieldKit :: crypto
   Zero-knowledge vault. The relay stores ciphertext and never
   sees a key. See FIELDKIT_PROJECT.md §9C.

   Envelope design:
     MDK           random 256-bit AES-GCM master data key.
                   Everything in the store is encrypted with this.
     passKEK       PBKDF2(password, salt) -> HKDF -> wrapping key.
     authKey       PBKDF2(password, salt) -> HKDF -> bits sent to relay.
                   Relay stores only SHA-256(authKey).
     recKEK        HKDF(recoveryKeyBytes, salt) -> wrapping key.

   The MDK is wrapped twice, once under passKEK and once under
   recKEK. That means: password changes never re-encrypt the data,
   and losing the password is survivable with the recovery key.
   Losing BOTH is unrecoverable, by design.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var subtle = (window.crypto && window.crypto.subtle) || null;

  var HEADER_VERSION = 1;
  /* Measured 2026-08-11 on the target Chromebook (CrOS, 4 cores,
     4 GB): 250k iterations = 94 ms. 600k lands near 225 ms, which
     is imperceptible at unlock and matches current OWASP guidance
     for PBKDF2-SHA256. Existing vaults keep whatever count is
     recorded in their own header, so raising this only affects
     newly created vaults. */
  var DEFAULT_ITERATIONS = 600000;
  var IV_BYTES = 12;
  var RECOVERY_BYTES = 20;           // 160 bits -> 32 base32 chars

  /* Crockford base32 — no I, L, O, U, so it survives handwriting. */
  var B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  /* ---- encoding helpers --------------------------------------- */
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function bytes(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }

  function toB64(buf) {
    var b = bytes(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }

  function fromB64(s) {
    var bin = atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  function toHex(buf) {
    var b = bytes(buf), s = "";
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
  }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    window.crypto.getRandomValues(b);
    return b;
  }

  /* ---- recovery key formatting -------------------------------- */
  function encodeRecovery(b) {
    var bits = 0, value = 0, outp = "";
    for (var i = 0; i < b.length; i++) {
      value = (value << 8) | b[i];
      bits += 8;
      while (bits >= 5) { outp += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) outp += B32[(value << (5 - bits)) & 31];
    return (outp.match(/.{1,4}/g) || []).join("-");
  }

  function decodeRecovery(str) {
    var clean = String(str).toUpperCase().replace(/[^0-9A-Z]/g, "")
      .replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
    var bits = 0, value = 0, outp = [];
    for (var i = 0; i < clean.length; i++) {
      var idx = B32.indexOf(clean[i]);
      if (idx < 0) throw new Error("recovery key contains an invalid character");
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) { outp.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    if (outp.length < RECOVERY_BYTES) throw new Error("recovery key is too short");
    return new Uint8Array(outp.slice(0, RECOVERY_BYTES));
  }

  /* ---- key derivation ----------------------------------------- */
  async function pbkdf2Bits(password, salt, iterations) {
    var base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    return subtle.deriveBits(
      { name: "PBKDF2", salt: salt, iterations: iterations, hash: "SHA-256" }, base, 256);
  }

  async function hkdfWrapKey(baseBits, salt, info) {
    var base = await subtle.importKey("raw", baseBits, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: salt, info: enc.encode(info) },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function hkdfBits(baseBits, salt, info, length) {
    var base = await subtle.importKey("raw", baseBits, "HKDF", false, ["deriveBits"]);
    return subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt, info: enc.encode(info) }, base, length);
  }

  /* ---- primitive encrypt/decrypt ------------------------------ */
  async function sealBytes(key, plainBytes) {
    var iv = randomBytes(IV_BYTES);
    var ct = await subtle.encrypt({ name: "AES-GCM", iv: iv }, key, plainBytes);
    return { iv: toB64(iv), ct: toB64(ct) };
  }

  async function openBytes(key, box) {
    var pt = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct));
    return new Uint8Array(pt);
  }

  /* ---- a live, unlocked vault --------------------------------- */
  /* `raw` is kept alongside the CryptoKey purely so the MDK can be
     re-wrapped on password change without re-encrypting the data.
     The CryptoKey itself is non-extractable. */
  function Vault(mdk, raw, header, authKeyBits) {
    this.header = header;
    this.authToken = toHex(authKeyBits);   // sent to relay on every request
    this._mdk = mdk;
    this._raw = raw;
  }

  /* Encrypt an arbitrary JSON-serialisable value. */
  Vault.prototype.seal = function (value) {
    return sealBytes(this._mdk, enc.encode(JSON.stringify(value)));
  };

  Vault.prototype.open = async function (box) {
    var raw = await openBytes(this._mdk, box);
    return JSON.parse(dec.decode(raw));
  };

  /* ---- raw bytes, for blobs ------------------------------------
     seal() goes through JSON and base64, which is right for a
     record and catastrophic for a file: a 4 MB chunk becomes a
     5.3 MB string that has to exist in memory alongside the
     original and the ciphertext. These two skip both.

     Layout is [12-byte IV][ciphertext]. Prefixing the IV rather
     than carrying it beside the data means a chunk is one opaque
     buffer end to end — the relay stores exactly what it is given
     and there is no second field to lose. */
  Vault.prototype.sealRaw = async function (bytes) {
    var iv = randomBytes(IV_BYTES);
    var ct = await subtle.encrypt({ name: "AES-GCM", iv: iv }, this._mdk, bytes);
    var out = new Uint8Array(IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), IV_BYTES);
    return out;
  };

  Vault.prototype.openRaw = async function (bytes) {
    if (!bytes || bytes.length <= IV_BYTES) {
      throw new Error("blob is too short to contain an IV and any ciphertext");
    }
    var iv = bytes.subarray(0, IV_BYTES);
    var ct = bytes.subarray(IV_BYTES);
    var pt = await subtle.decrypt({ name: "AES-GCM", iv: iv }, this._mdk, ct);
    return new Uint8Array(pt);
  };

  /* Re-wrap the MDK under a new password. Data is untouched. */
  Vault.prototype.changePassword = async function (newPassword) {
    var salt = fromB64(this.header.kdf.salt);
    var iterations = this.header.kdf.iterations;
    var bits = await pbkdf2Bits(newPassword, salt, iterations);
    var kek = await hkdfWrapKey(bits, salt, "fk-wrap-v1");
    var authBits = await hkdfBits(bits, salt, "fk-auth-v1", 256);
    this.header.wrap.password = await sealBytes(kek, this._raw);
    this.header.authKeyHash = toB64(await subtle.digest("SHA-256", authBits));
    this.authToken = toHex(authBits);
    return this.header;
  };

  /* ---- vault lifecycle ---------------------------------------- */
  async function createVault(password, opts) {
    opts = opts || {};
    var iterations = opts.iterations || DEFAULT_ITERATIONS;
    var salt = randomBytes(16);

    /* Generate the MDK extractable so it can be wrapped, then keep a
       non-extractable copy for actual use. */
    var mdkKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    var rawMdk = new Uint8Array(await subtle.exportKey("raw", mdkKey));

    var passBits = await pbkdf2Bits(password, salt, iterations);
    var passKek = await hkdfWrapKey(passBits, salt, "fk-wrap-v1");
    var authBits = await hkdfBits(passBits, salt, "fk-auth-v1", 256);

    var recoveryBytes = randomBytes(RECOVERY_BYTES);
    var recoveryKeyString = encodeRecovery(recoveryBytes);
    var recKek = await hkdfWrapKey(recoveryBytes, salt, "fk-recovery-v1");

    /* The recovery key gets its own relay credential.

       It did not, originally, and that made the recovery path a
       trap: recovery unwraps the MDK so it can read everything
       locally, but it never sees the password, so it could not
       derive the relay token. The session came up armed with 32
       zero bytes, every authenticated call 401'd, and the only fix
       — set a new password and upload the header — needed the old
       token to authorise the upload. Forgetting your password meant
       losing the relay, permanently, with the boot screen
       cheerfully suggesting you reconnect.

       Denying the recovery key relay access bought nothing anyway:
       it already grants complete access to the plaintext. A
       separate HKDF label keeps the two credentials distinct, so
       the relay can tell which one is in use and a password change
       does not invalidate the recovery key. */
    var recAuthBits = await hkdfBits(recoveryBytes, salt, "fk-recovery-auth-v1", 256);

    var header = {
      v: HEADER_VERSION,
      createdAt: new Date().toISOString(),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: iterations, salt: toB64(salt) },
      wrap: {
        password: await sealBytes(passKek, rawMdk),
        recovery: await sealBytes(recKek, rawMdk)
      },
      authKeyHash: toB64(await subtle.digest("SHA-256", authBits)),
      recoveryAuthKeyHash: toB64(await subtle.digest("SHA-256", recAuthBits))
    };

    var usable = await subtle.importKey("raw", rawMdk, "AES-GCM", false, ["encrypt", "decrypt"]);
    recoveryBytes.fill(0);

    return {
      vault: new Vault(usable, rawMdk, header, authBits),
      recoveryKey: recoveryKeyString
    };
  }

  async function unlockVault(header, password) {
    var salt = fromB64(header.kdf.salt);
    var bits = await pbkdf2Bits(password, salt, header.kdf.iterations);
    var kek = await hkdfWrapKey(bits, salt, "fk-wrap-v1");
    var raw;
    try {
      raw = await openBytes(kek, header.wrap.password);
    } catch (e) {
      /* AES-GCM's auth tag is the password check — a failure here
         means wrong password, not corruption (usually). */
      var err = new Error("incorrect password");
      err.code = "BAD_PASSWORD";
      throw err;
    }
    var mdk = await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    var authBits = await hkdfBits(bits, salt, "fk-auth-v1", 256);
    return new Vault(mdk, raw, header, authBits);
  }

  async function unlockWithRecovery(header, recoveryKeyString) {
    var salt = fromB64(header.kdf.salt);

    /* Decoding is inside the same guard as decryption on purpose.
       A key that is too short and a key that is simply wrong are
       the same situation to whoever typed it — they got it wrong —
       and the boot gate should say one clear thing either way
       rather than leaking "recovery key is too short" from a
       base32 decoder. */
    var recBytes, raw;
    try {
      recBytes = decodeRecovery(recoveryKeyString);
      var kek = await hkdfWrapKey(recBytes, salt, "fk-recovery-v1");
      raw = await openBytes(kek, header.wrap.recovery);
    } catch (e) {
      var err = new Error("recovery key is not valid for this vault");
      err.code = "BAD_RECOVERY";
      throw err;
    }
    var mdk = await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

    /* Vaults created before recoveryAuthKeyHash existed have no
       relay credential for this key. Say so honestly rather than
       arming the transport with zeros and letting every call 401 —
       the caller checks recoveryOnlyLocal and explains it. */
    var legacy = !header.recoveryAuthKeyHash;
    var recAuthBits = legacy
      ? new Uint8Array(32)
      : await hkdfBits(recBytes, salt, "fk-recovery-auth-v1", 256);

    var v = new Vault(mdk, raw, header, recAuthBits);
    /* You unlocked without the password, so you still do not have
       one you know. Prompt for a new one — but the session works
       either way now. */
    v.needsNewPassword = true;
    v.openedWithRecovery = true;
    v.recoveryOnlyLocal = legacy;
    return v;
  }

  /* Measure how long this machine takes to derive, so the boot
     screen can warn and §9C's iteration count can be tuned. */
  async function benchmark(iterations) {
    var t0 = performance.now();
    await pbkdf2Bits("benchmark-probe", randomBytes(16), iterations || DEFAULT_ITERATIONS);
    return Math.round(performance.now() - t0);
  }

  FieldKit.provide("crypto", {
    available: !!subtle,
    DEFAULT_ITERATIONS: DEFAULT_ITERATIONS,
    createVault: createVault,
    unlockVault: unlockVault,
    unlockWithRecovery: unlockWithRecovery,
    benchmark: benchmark,
    randomBytes: randomBytes,
    /* Exposed so the screen lock can hash a PIN without growing a
       second key-derivation implementation. */
    pbkdf2Bits: pbkdf2Bits,
    toB64: toB64,
    fromB64: fromB64,
    toHex: toHex,
    encodeRecovery: encodeRecovery,
    decodeRecovery: decodeRecovery
  });

  if (!subtle) {
    FieldKit.log("error", "crypto",
      "crypto.subtle unavailable on this origin — the vault cannot be opened here");
  }
})(window.FieldKit);
