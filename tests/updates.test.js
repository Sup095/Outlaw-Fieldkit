/* ============================================================
   Auto-update, end to end (§14.4)

   The point of this suite is that it runs BOTH halves: the signer
   from build.js in Node, and the verifier from modules/updater.js
   under crypto.subtle. A test that only exercised one would pass
   happily while the two disagreed about what gets signed — and
   that disagreement is invisible until someone's update fails on a
   machine that is not this one.

   So the assertions are mostly of one shape: sign something for
   real, change one thing about it, and require the verifier to
   refuse. A verifier that says yes to everything is worse than no
   verifier at all, because it looks like protection.
   ============================================================ */
"use strict";

const nodeCrypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner, fakeElement, ROOT } = require("./harness");

const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js",
  "core/update-key.js", "modules/updater.js"
]);
const { ok, section, state } = makeRunner("updates");

global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
global.atob = (s) => Buffer.from(s, "base64").toString("binary");

const build = require("../build.js");
const updatesRoute = require("../relay/updates.js");
const key = FieldKit.need("updateKey");
const def = FieldKit.modules().updater;

/* A throwaway keypair for the "signed by someone else" cases, so
   the real one is never used to prove a negative. */
const other = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

/* The real private key, if it exists on this machine. It is
   gitignored, so a fresh clone will not have one — and the suite
   says which half it could run rather than quietly skipping. */
const KEY_FILE = path.join(ROOT, "release-key.json");
const realKey = fs.existsSync(KEY_FILE) ? JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) : null;

function signWith(privateKey, rel) {
  return nodeCrypto.sign("sha256", Buffer.from(build.signingPayload(rel), "utf8"),
    { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
}

function sampleRelease() {
  return {
    version: "9.9.9",
    publishedAt: "2026-08-16T12:00:00.000Z",
    notes: "a test release",
    algorithm: "ECDSA-P256-SHA256",
    keyFingerprint: key.fingerprint,
    files: [
      { name: "FIELDKIT-STANDALONE.html", build: "FIELDKIT", size: 12,
        sha256: nodeCrypto.createHash("sha256").update("hello world!").digest("hex") }
    ]
  };
}

/* The verifier lives inside the module's closure, so it is reached
   the way the app reaches it: mount, then run the selfchecks, plus
   a direct exercise of verify through a stubbed relay. */
/* No network in the suite: every fetch goes here. Until a test sets
   routes, nothing answers, as on a network that blocks everything. */
let routes = {};
global.fetch = async (u) => {
  const key = Object.keys(routes).find((k) => String(u).indexOf(k) >= 0);
  if (!key) throw new TypeError("Failed to fetch");
  const v = routes[key];
  const body = typeof v === "function" ? v(u) : v;
  const status = body && body.__status || 200;
  const text = Buffer.isBuffer(body) ? body.toString("binary") : JSON.stringify(body);
  return { ok: status < 400, status,
    text: async () => text, json: async () => JSON.parse(text),
    arrayBuffer: async () => Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length) : Buffer.from(text).buffer };
};

const host = fakeElement("div");
const settings = FieldKit.need("settings");
const ctx = { settings, ui: FieldKit.need("ui"), version: "0.1.0",
  log() {}, warn() {}, error() {}, on() {}, emit() {} };

(async function () {
  section("the shipped key and the private key are a pair");
  {
    ok("a public key ships in the build", !!key && !!key.spki);
    ok("it names its algorithm", key.algorithm === "ECDSA-P256-SHA256");
    ok("it carries a fingerprint to read aloud",
      /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/.test(key.fingerprint), key.fingerprint);

    if (!realKey) {
      ok("SKIPPED — no release-key.json on this machine, so the pairing cannot be checked", true);
    } else {
      ok("the private key file names the same fingerprint", realKey.fingerprint === key.fingerprint);
      /* The failure this catches: signing with a key whose public
         half was never shipped. Every client rejects the release and
         nothing on the relay side looks wrong. */
      ok("and carries the public half that shipped", realKey.publicKeySpkiB64 === key.spki);

      const priv = nodeCrypto.createPrivateKey({
        key: Buffer.from(realKey.privateKeyPkcs8B64, "base64"), format: "der", type: "pkcs8" });
      const pub = nodeCrypto.createPublicKey({
        key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
      const msg = Buffer.from("round trip", "utf8");
      const sig = nodeCrypto.sign("sha256", msg, { key: priv, dsaEncoding: "ieee-p1363" });
      ok("a signature from the private half verifies against the shipped public half",
        nodeCrypto.verify("sha256", msg, { key: pub, dsaEncoding: "ieee-p1363" }, sig));
    }
  }

  section("what gets signed");
  {
    const a = { version: "1.0.0", publishedAt: "T",
      files: [{ name: "n", size: 1, sha256: "h" }] };
    const b = { files: [{ sha256: "h", size: 1, name: "n" }], publishedAt: "T", version: "1.0.0" };
    ok("the payload does not depend on object key order",
      build.signingPayload(a) === build.signingPayload(b));

    const p = build.signingPayload(sampleRelease());
    ok("the version is covered", p.indexOf("9.9.9") >= 0);
    ok("the publish time is covered", p.indexOf("2026-08-16T12:00:00.000Z") >= 0);
    ok("each file's name, size and hash are covered",
      p.indexOf("FIELDKIT-STANDALONE.html:12:") >= 0);

    /* Notes are NOT signed, and that is deliberate rather than an
       oversight: they are prose for a human, they change nothing
       about what gets installed, and putting free text inside a
       signature invites someone to try to make the signature depend
       on how it was encoded. The client must therefore never make a
       decision from them. */
    const withNotes = sampleRelease(); withNotes.notes = "totally different text";
    ok("the notes are not part of the signature",
      build.signingPayload(withNotes) === build.signingPayload(sampleRelease()));

    /* Changing any signed field must change the payload, or the
       signature covers nothing useful. */
    [["version", "9.9.10"], ["publishedAt", "2027-01-01T00:00:00.000Z"]].forEach(([f, v]) => {
      const m = sampleRelease(); m[f] = v;
      ok("changing " + f + " changes what is signed",
        build.signingPayload(m) !== build.signingPayload(sampleRelease()));
    });
    const swapped = sampleRelease();
    swapped.files[0].sha256 = "b".repeat(64);
    ok("changing a file hash changes what is signed",
      build.signingPayload(swapped) !== build.signingPayload(sampleRelease()));
    const resized = sampleRelease();
    resized.files[0].size = 13;
    ok("changing a file size changes what is signed",
      build.signingPayload(resized) !== build.signingPayload(sampleRelease()));
  }

  section("the verifier, against real signatures");
  {
    await def.mount(host, ctx);
    const checks = def.selfcheck();

    for (const c of checks) {
      let failed = null, out = null;
      try { out = await c.run(); }
      catch (e) { if (/^SKIPPED/.test(e.message)) out = e.message; else failed = e.message; }
      ok(c.name, failed === null, failed || String(out).slice(0, 70));
    }

    /* The selfchecks prove forgeries are refused. This proves the
       other direction — that a genuinely signed release is
       ACCEPTED — which no amount of rejecting proves, and which is
       the half that breaks when the two payload builders drift. */
    if (realKey) {
      const priv = nodeCrypto.createPrivateKey({
        key: Buffer.from(realKey.privateKeyPkcs8B64, "base64"), format: "der", type: "pkcs8" });
      const rel = sampleRelease();
      rel.signature = signWith(priv, rel);

      let accepted = false, why = null;
      /* GitHub answers, with the record in the notes and GitHub's
         own hashes on the files; the relay answers too. */
      routes = {
        "api.github.com/repos/": { tag_name: "v9.9.9", body: build.releaseBody(rel),
          assets: rel.files.map((f) => ({ name: f.name, digest: "sha256:" + f.sha256,
            browser_download_url: "https://github.com/x/releases/download/v9.9.9/" + f.name })) },
        "relay.example/updates/latest": rel
      };
      settings.set("relayUrl", "https://relay.example");

      /* Driven through the panel, because "check" is the path a user
         takes and the only one that decides what the screen says. */
      const btn = (function find(n) {
        const out = [];
        (function walk(x) {
          (x.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } });
        })(n);
        return out.find((e) => e.tagName === "BUTTON" && /CHECK/.test(e.textContent));
      })(host);
      ok("the panel offers a check button", !!btn);
      btn.click();
      for (let i = 0; i < 200 && !accepted; i++) {
        await new Promise((r) => setTimeout(r, 10));
        const texts = [];
        (function walk(x) {
          (x.children || []).forEach((c) => {
            if (!c || c.nodeType === 3) return;
            texts.push(String(c.textContent || "")); walk(c);
          });
        })(host);
        if (texts.some((t) => t === "VERIFIED")) accepted = true;
        const bad = texts.find((t) => /NO UPDATE OFFERED/.test(t));
        if (bad) { why = texts.join(" | ").slice(0, 200); break; }
      }
      ok("a genuinely signed release is accepted and shown as VERIFIED", accepted, why);
      const allText = () => { const t = []; (function walk(x) { (x.children || []).forEach((c) => { if (c && c.nodeType !== 3) { t.push(String(c.textContent || "")); walk(c); } }); })(host); return t.join(" | "); };
      ok("it says it came from GitHub, and the relay's copy is current",
        /GITHUB \(FILES MATCH/.test(allText()) && /UP TO DATE/.test(allText()), allText().slice(0, 300));
      ok("each file can be fetched through the relay and checked, or taken from GitHub",
        /DOWNLOAD \(CHECKED\)/.test(allText()) && /FROM GITHUB/.test(allText()) && /CHECK A DOWNLOADED FILE/.test(allText()));

      const clickCheck = async () => {
        const b = [];
        (function walk(x) { (x.children || []).forEach((c) => { if (c && c.nodeType !== 3) { b.push(c); walk(c); } }); })(host);
        b.find((e) => e.tagName === "BUTTON" && /^CHECK/.test(e.textContent) && !/DOWNLOADED/.test(e.textContent)).click();
        for (let i = 0; i < 200; i++) {
          await new Promise((r) => setTimeout(r, 10));
          const parts = allText().split(" | ");
          if (parts.some((p) => /^NO UPDATE OFFERED/.test(p)) || parts.indexOf("VERIFIED") >= 0) break;
        }
        return allText();
      };

      /* GitHub blocked: the relay is the fallback. */
      delete routes["api.github.com/repos/"];
      let t = await clickCheck();
      ok("with GitHub blocked, the relay's copy is used, and it says so",
        /THE RELAY/.test(t) && /used the relay instead/.test(t), t.slice(0, 300));

      /* GitHub holding a file that is not the one signed. */
      routes["api.github.com/repos/"] = { tag_name: "v9.9.9", body: build.releaseBody(rel),
        assets: rel.files.map((f) => ({ name: f.name, digest: "sha256:" + "d".repeat(64), browser_download_url: "x" })) };
      delete routes["relay.example/updates/latest"];
      t = await clickCheck();
      ok("GitHub's file not matching the signature means nothing is offered", /NO UPDATE OFFERED/.test(t) && /not the file that was signed/.test(t), t.slice(0, 300));

      /* Notes edited on GitHub: the record no longer verifies. */
      const forged = JSON.parse(JSON.stringify(rel)); forged.files[0].sha256 = "e".repeat(64);
      routes["api.github.com/repos/"] = { tag_name: "v9.9.9", body: build.releaseBody(forged), assets: [] };
      t = await clickCheck();
      ok("a record edited on GitHub is refused", /NO UPDATE OFFERED/.test(t) && /SIGNATURE DOES NOT MATCH/.test(t), t.slice(0, 300));
      routes = {};

      /* One byte of the signature flipped. Same release, same key,
         and it must not pass. */
      const tampered = sampleRelease();
      const sigBytes = Buffer.from(signWith(priv, tampered), "base64");
      sigBytes[0] ^= 1;
      tampered.signature = sigBytes.toString("base64");
      const pub = nodeCrypto.createPublicKey({
        key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
      ok("a single flipped bit in the signature does not verify",
        !nodeCrypto.verify("sha256", Buffer.from(build.signingPayload(tampered), "utf8"),
          { key: pub, dsaEncoding: "ieee-p1363" }, sigBytes));

      /* The realistic attack: keep the signature, swap the hash of
         the file that will be downloaded. */
      const swapped = sampleRelease();
      swapped.signature = signWith(priv, swapped);
      swapped.files[0].sha256 = "c".repeat(64);
      ok("swapping a file hash after signing does not verify",
        !nodeCrypto.verify("sha256", Buffer.from(build.signingPayload(swapped), "utf8"),
          { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(swapped.signature, "base64")));

      /* Signed correctly, by the wrong person. */
      const foreign = sampleRelease();
      foreign.signature = signWith(other.privateKey, foreign);
      ok("a release signed with a different key does not verify",
        !nodeCrypto.verify("sha256", Buffer.from(build.signingPayload(foreign), "utf8"),
          { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(foreign.signature, "base64")));
    } else {
      ok("SKIPPED — no private key here, so the accept path cannot be exercised", true);
    }
  }

  section("the relay serves, and is not trusted");
  {
    const sent = [];
    const send = (r, status, body) => sent.push({ status, body });
    const res = { writeHead() {}, end() {} };

    updatesRoute.init({ dataDir: path.join(ROOT, "release", "__none__"),
      config: { enabled: false }, log: () => {} });
    sent.length = 0;
    await updatesRoute.route({ method: "GET", headers: {} }, res,
      { pathname: "/updates/latest", searchParams: new URLSearchParams("") },
      { send, authorise: () => "vault" });
    ok("disabled means 503 before anything else", sent[0] && sent[0].status === 503);

    updatesRoute.init({ dataDir: path.join(ROOT, "release", "__none__"),
      config: { enabled: true }, log: () => {} });

    sent.length = 0;
    await updatesRoute.route({ method: "GET", headers: {} }, res,
      { pathname: "/updates/latest", searchParams: new URLSearchParams("") },
      { send, authorise: () => null });
    ok("no token is needed (the builds are public); with nothing to offer it says so",
      sent[0] && sent[0].status === 503 && /no release/.test(sent[0].body.error), JSON.stringify(sent[0]));

    sent.length = 0;
    await updatesRoute.route({ method: "GET", headers: {} }, res,
      { pathname: "/updates/nonsense", searchParams: new URLSearchParams("") },
      { send, authorise: () => null });
    ok("an unknown route 404s before asking for a credential",
      sent[0] && sent[0].status === 404);

    sent.length = 0;
    await updatesRoute.route({ method: "POST", headers: {} }, res,
      { pathname: "/updates/latest", searchParams: new URLSearchParams("") },
      { send, authorise: () => null });
    ok("a real route called the wrong way says 405", sent[0] && sent[0].status === 405);

    ok("a path that is not /updates is not ours",
      (await updatesRoute.route({ method: "GET", headers: {} }, {},
        { pathname: "/health", searchParams: new URLSearchParams("") }, {})) === false);

    /* Filenames come from a URL. The defence is an allow list — the
       name has to be one release.json actually lists — which is
       stronger than any amount of scrubbing, because it cannot be
       out-thought by an encoding nobody considered. */
    const rel = { files: [{ name: "FIELDKIT-STANDALONE.html", size: 1, sha256: "x" }] };
    const I = updatesRoute._internals;
    ok("a listed name resolves", !!I.fileNamed(rel, "FIELDKIT-STANDALONE.html"));
    ["../config.json", "..\\config.json", "/etc/passwd", "release.json",
     "FIELDKIT-STANDALONE.html/../../x", "", "a".repeat(200)].forEach((n) => {
      ok("refused: " + JSON.stringify(n.slice(0, 30)), !I.fileNamed(rel, n));
    });
    /* release.json specifically: it is in the folder but not in the
       file list, and serving it from this route would be harmless
       today and a habit worth not forming. */
    ok("even a real file in the folder is refused if the release does not list it",
      !I.fileNamed(rel, "release.json"));
  }

  section("the release folder that --release produces");
  {
    const dir = path.join(ROOT, "release");
    if (!fs.existsSync(path.join(dir, "release.json"))) {
      ok("SKIPPED — no release/ built here yet, run `node build.js --release`", true);
    } else {
      const rel = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
      ok("release.json carries a signature", typeof rel.signature === "string" && rel.signature.length > 40);
      ok("it names the key that signed it", rel.keyFingerprint === key.fingerprint);
      ok("every file it lists is actually in the folder",
        rel.files.every((f) => fs.existsSync(path.join(dir, f.name))));

      /* The hash in the signature must match the bytes on disk, or
         the client refuses the download after spending the
         bandwidth. */
      const wrong = rel.files.filter((f) => {
        const buf = fs.readFileSync(path.join(dir, f.name));
        return nodeCrypto.createHash("sha256").update(buf).digest("hex") !== f.sha256
          || buf.length !== f.size;
      });
      ok("and matches the hash and size inside the signature",
        wrong.length === 0, wrong.map((f) => f.name).join(", "));

      const pub = nodeCrypto.createPublicKey({
        key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
      ok("the real release verifies against the shipped public key",
        nodeCrypto.verify("sha256", Buffer.from(build.signingPayload(rel), "utf8"),
          { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(rel.signature, "base64")));

      /* The private key must never be in the folder that gets
         uploaded. This is the one mistake with no recovery. */
      ok("the private key is NOT staged for upload",
        !fs.existsSync(path.join(dir, "release-key.json")));
      ok("nothing in release/ contains the private key material",
        !fs.readdirSync(dir).some((n) => {
          if (!realKey) return false;
          try { return fs.readFileSync(path.join(dir, n), "utf8")
            .indexOf(realKey.privateKeyPkcs8B64) >= 0; } catch (e) { return false; }
        }));
    }
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
