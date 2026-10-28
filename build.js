#!/usr/bin/env node
/* ============================================================
   FieldKit build
   Inlines every script in FK_BOOT_MANIFEST into a single
   self-contained HTML file.

   This exists as the escape hatch: if a machine blocks separate
   script files from local media, the bundle still runs. It is a
   build artifact, not a runtime mode (FIELDKIT_PROJECT.md §8).

     node build.js
     node build.js --deploy E:\                  copy the drive payload
     node build.js --only OUTPOST --deploy E:\   a drive with no FieldKit on it
     node build.js --release "notes"             sign a release (§14.4)
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const MANIFEST = "drive-manifest.json";

/* Two builds off one tree. OUTPOST (§14.1) is the limited one, and
   the property that makes it limited is that core/crypto.js,
   core/store.js and the transports are not in its manifest — there
   is no vault code on that drive to reach. Both are built every
   time, because a second build that is only made sometimes is a
   second build that is broken most of the time. */
const ALL_BUILDS = [
  { entry: "FIELDKIT.html", out: "FIELDKIT-STANDALONE.html", label: "FIELDKIT" },
  { entry: "OUTPOST.html", out: "OUTPOST-STANDALONE.html", label: "OUTPOST" }
];

/* `--only OUTPOST` makes a drive for somebody who is not on the
   team: OUTPOST.html and its standalone, and no FIELDKIT.html at
   all. The point is worth being precise about — OUTPOST's security
   property has always been ABSENCE, not a flag. It cannot reach a
   vault because core/crypto.js and core/store.js are not in its
   manifest. Leaving FIELDKIT.html beside it on the same stick does
   not break that, but it does hand someone a lock to pick, and
   there is no reason to.

   Both are still BUILT every time. A second build that is only made
   sometimes is a second build that is broken most of the time; what
   --only changes is what gets DEPLOYED and what the drive manifest
   covers. */
function selectedBuilds() {
  const i = process.argv.indexOf("--only");
  if (i < 0) return ALL_BUILDS;
  const want = String(process.argv[i + 1] || "").toUpperCase();
  const hit = ALL_BUILDS.filter((b) => b.label === want);
  if (!hit.length) {
    throw new Error("--only takes " + ALL_BUILDS.map((b) => b.label).join(" or ") +
      ", not " + JSON.stringify(process.argv[i + 1] || ""));
  }
  return hit;
}

const BUILDS = ALL_BUILDS;
const DEPLOY_BUILDS = selectedBuilds();
const OUTPOST_ONLY = DEPLOY_BUILDS.length === 1 && DEPLOY_BUILDS[0].label === "OUTPOST";

const ENTRY = path.join(ROOT, "FIELDKIT.html");
const OUT = path.join(ROOT, "FIELDKIT-STANDALONE.html");

/* Files/dirs that belong on the USB. Some are optional and simply
   may not exist — `vendor` only appears after tools/build-webllm.js
   has been run, and `assets` has never been created.

   `models` holds MLC model weights for AI LOCAL, and is optional in
   a stronger sense: it is gigabytes. See MODELS below for why it is
   copied but deliberately NOT hashed into the drive manifest. */
const PAYLOAD_BASE = ["PREFLIGHT.html", "core", "modules", "assets", "vendor", "models"];

function payloadFor(builds) {
  return builds.map((b) => b.entry).concat(PAYLOAD_BASE);
}

const PAYLOAD = payloadFor(DEPLOY_BUILDS);

/* Weights are gigabytes, and hashing them on every build would make
   the build unusable — a four-minute wait to learn that a file
   nobody edited still has the same contents. So models/ is copied to
   the drive and left out of the manifest, which means PREFLIGHT does
   not cover it. Said out loud rather than left to be discovered: a
   tampered model is a real risk, just a much smaller one than
   tampered code, and the honest trade is to name the gap. */
const UNHASHED = ["models"];

/* Things it would be actively wrong to copy. `relay/` goes to the
   Pterodactyl container by hand and carries ~110 MB of binaries;
   `tests/` and `tools/` only ever run on the SSD. Listed
   explicitly so a future PAYLOAD edit cannot quietly include them. */
const NEVER_DEPLOY = ["relay", "tests", "tools", "node_modules", ".git"];

/* The manifests are real JS arrays carrying real comments, and some
   of those comments contain commas. Splitting on commas first turned
   each comma inside a comment into a phantom entry. build.js survived
   that by accident — a phantom path does not exist, so the existence
   filter dropped it — but anything asserting on the list itself saw
   junk. Strip first, split second. */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function readList(html, name) {
  const re = new RegExp("window\\." + name + "\\s*=\\s*\\[([\\s\\S]*?)\\]");
  const m = re.exec(html);
  if (!m) return null;
  return stripComments(m[1])
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function readManifest(html) {
  const list = readList(html, "FK_BOOT_MANIFEST");
  if (!list) throw new Error("FK_BOOT_MANIFEST not found in the entry file");
  return list;
}

/* Optional bundles. Absent by design, so they are never a build
   error — but if one IS present on the SSD it must reach the
   drive, or the app silently loses a feature that worked in dev. */
function readOptional(html) {
  return readList(html, "FK_OPTIONAL_MANIFEST") || [];
}

/* A literal </script> inside inlined source would terminate the
   surrounding tag. Only that sequence needs neutralising. */
function safeInline(src) {
  return src.replace(/<\/script/gi, "<\\/script");
}

function build(spec) {
  const entry = path.join(ROOT, spec.entry);
  const outFile = path.join(ROOT, spec.out);
  const html = fs.readFileSync(entry, "utf8");
  const manifest = readManifest(html);

  const missing = manifest.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) throw new Error(spec.entry + " references missing files: " + missing.join(", "));

  let bytes = 0;
  const blocks = manifest.map((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    bytes += Buffer.byteLength(src);
    return `<script data-fk-module="${f}">\n${safeInline(src)}\n</script>`;
  });

  const bundle =
    `<script>window.FK_INLINED = true;</script>\n` + blocks.join("\n");

  /* Insert before the launcher script so FK_INLINED is set by the
     time the gate handler checks for it.

     Matched by regex rather than an exact string because the exact
     string carried a bare \n, and a single tool writing the file
     with Windows line endings turned every build into "could not
     locate the launcher script block" — a message that names the
     symptom and hides the cause. */
  const markerRe = /<script>\r?\n\/\* ====/;
  const found = markerRe.exec(html);
  if (!found) throw new Error("could not locate the launcher script block in " + spec.entry);
  const at = found.index;

  const outHtml = html.slice(0, at) + bundle + "\n" + html.slice(at);
  fs.writeFileSync(outFile, outHtml, "utf8");

  const total = Buffer.byteLength(outHtml);
  console.log(`${spec.label}: bundled ${manifest.length} module(s), ${(bytes / 1024).toFixed(1)} KB of source`);
  console.log(`  wrote ${path.relative(ROOT, outFile)}  (${(total / 1024).toFixed(1)} KB)`);

  /* Optional bundles are NOT inlined, and that is a deliberate
     trade rather than an oversight — so it gets said out loud.
     web-llm.js is 5.3 MB against a 1.2 MB app, and the standalone
     file exists for machines locked down enough to refuse separate
     script files. Those are not machines anyone is about to load a
     two-gigabyte model on. The normal FIELDKIT.html path loads it
     from vendor/ as usual. */
  const optional = readOptional(html).filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (optional.length) {
    console.log("");
    optional.forEach((f) => {
      const mb = (fs.statSync(path.join(ROOT, f)).size / 1048576).toFixed(1);
      console.log(`note: ${f} (${mb} MB) is NOT inlined into the standalone build.`);
    });
    console.log("      It ships as a separate file and works from FIELDKIT.html.");
  }

  return outFile;
}

/* Every payload item, plus both standalone bundles. Kept in one
   place because PREFLIGHT hashes exactly this list and a file that
   ships without being in it is a file nothing verifies. */
function payloadList() {
  return PAYLOAD.concat(DEPLOY_BUILDS.map((b) => b.out));
}

/* What the manifest covers: the payload minus the things too large
   to hash. Separate from payloadList() so the difference between
   "copied" and "verified" is visible rather than implied. */
function manifestList() {
  return payloadList().filter((p) => UNHASHED.indexOf(p) < 0);
}

/* ---- the relay config -------------------------------------------
   Three files, and only one of them is written by hand twice.

     config.example.json   committed. The annotated schema, with
                           placeholders where secrets go. This is
                           what somebody else would start from.
     config.local.json     gitignored. Only the values that are
                           actually this deployment's — tokens, the
                           tunnel credential, the moderator list.
     config.json           gitignored, GENERATED here from the two.

   The reason this exists: adding a setting used to mean editing the
   example AND hand-merging the same block into a live config that
   already held secrets. That merge is where `"moderators": [Sup095]`
   came from — one unquoted string, and the relay discarded the
   entire config and silently reverted to defaults. Now a new setting
   is added to the example only, and the real config regenerates with
   it while keeping every local value.

   Nothing in relay/ is in PAYLOAD, so none of this has ever gone
   near the drive; tests/build.test.js asserts that rather than
   leaving it to be true by accident. */
const CONFIG_EXAMPLE = path.join(ROOT, "relay", "config.example.json");
const CONFIG_LOCAL = path.join(ROOT, "relay", "config.local.json");
const CONFIG_OUT = path.join(ROOT, "relay", "config.json");

/* Local wins, but only where local actually says something. A nested
   object is merged rather than replaced, so adding `browse.blockHosts`
   to the example reaches the generated file even though config.local
   only mentions `browse.enabled`. Arrays are replaced whole — a
   half-merged list of moderators or AI targets is worse than either
   version of it. */
function mergeConfig(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  Object.keys(over || {}).forEach((k) => {
    if (k === "_" || k === "_how") return;      // notes to the reader, not settings
    const b = out[k], o = over[k];
    out[k] = (b && o && typeof b === "object" && typeof o === "object" &&
              !Array.isArray(b) && !Array.isArray(o)) ? mergeConfig(b, o) : o;
  });
  return out;
}

function writeRelayConfig() {
  let example;
  try { example = JSON.parse(fs.readFileSync(CONFIG_EXAMPLE, "utf8")); }
  catch (e) { throw new Error("relay/config.example.json is unreadable: " + e.message); }

  if (!fs.existsSync(CONFIG_LOCAL)) {
    console.log("");
    console.log("relay config: no relay/config.local.json, so config.json was not written.");
    console.log("  Copy config.example.json to config.local.json, strip it down to the");
    console.log("  values that are actually yours, and it will be generated from then on.");
    return null;
  }

  let local;
  try { local = JSON.parse(fs.readFileSync(CONFIG_LOCAL, "utf8")); }
  catch (e) {
    /* The same failure that started all this, caught here where it
       costs nothing instead of on the relay where it turns
       everything off at once. */
    throw new Error("relay/config.local.json is not valid JSON: " + e.message +
      "\n  Common causes: an unquoted string (moderators must be [\"name\"]," +
      "\n  not [name]), a trailing comma, or a comment.");
  }

  const merged = mergeConfig(example, local);
  const out = Object.assign({
    "_generated": "Written by `node build.js` from relay/config.example.json plus " +
      "relay/config.local.json. Edit config.local.json — anything changed here is " +
      "overwritten on the next build. Upload this file; never upload config.local.json " +
      "or release-key.json."
  }, merged);

  const text = JSON.stringify(out, null, 2) + "\n";
  JSON.parse(text);   // a generator that emits broken JSON is the whole bug, twice
  fs.writeFileSync(CONFIG_OUT, text, "utf8");

  /* Settings present in the example but never mentioned locally are
     running on the example's value, which for a secret is a
     placeholder that will not work. Worth naming. */
  const placeholders = Object.keys(merged).filter((k) =>
    typeof merged[k] === "string" && /CHANGE-ME/.test(merged[k]));

  console.log("");
  console.log("relay config: wrote relay/config.json  (" + fmt(text.length) + ")");
  console.log("  from config.example.json + config.local.json — both gitignored except the example");
  const on = ["messaging", "browse", "browser", "runner", "updates"]
    .filter((k) => merged[k] && merged[k].enabled).join(", ");
  console.log("  enabled: " + (on || "none of messaging, browse, browser, runner or updates"));
  if (placeholders.length) {
    console.log("  STILL A PLACEHOLDER: " + placeholders.join(", ") +
      " — set these in config.local.json");
  }
  return merged;
}

function buildAll() {
  BUILDS.forEach((spec, i) => { if (i) console.log(""); build(spec); });

  /* Written on the SSD too, so PREFLIGHT can be exercised here
     without a stick in hand. deploy() recomputes it against what
     actually landed rather than copying this one. */
  const man = writeManifest(ROOT, manifestList(), appVersion());
  console.log("");
  console.log(`drive manifest: ${man.count} files, ${fmt(man.bytes)}`);
  console.log(`  fingerprint ${man.fingerprint.slice(0, 16)}...`);
  return man;
}

/* ---- drive manifest ------------------------------------------
   PREFLIGHT.html reads this off the drive and re-hashes every file
   before FieldKit is ever opened. What it catches is a machine that
   WROTE to the stick: an autorun dropper, a modified core file, a
   half-finished copy. What it cannot catch is a machine that only
   read from it, or an attacker who knows FieldKit is here and
   regenerates the manifest after editing a file — which is why
   PREFLIGHT shows the manifest's own fingerprint and tells you to
   keep a copy of it somewhere that is not the drive.

   A weaker check that is honest about its edges beats a stronger
   claim that is not. */
function walkFiles(base, entries) {
  const out = [];
  const visit = (rel) => {
    const abs = path.join(base, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs).sort()) visit(path.join(rel, e));
    } else if (path.basename(rel) !== MANIFEST) {
      out.push(rel.split(path.sep).join("/"));
    }
  };
  entries.forEach(visit);
  return out;
}

function writeManifest(base, entries, version) {
  const files = {};
  let bytes = 0;
  for (const rel of walkFiles(base, entries)) {
    const buf = fs.readFileSync(path.join(base, rel));
    bytes += buf.length;
    files[rel] = { size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
  }

  /* Sorted keys and no timestamp inside the hashed part, so the same
     payload always fingerprints the same. A fingerprint that changed
     on every build would train you to ignore it. */
  const body = { algorithm: "SHA-256", version: version, files: files };
  const json = JSON.stringify(body, null, 1);
  const fingerprint = crypto.createHash("sha256").update(json).digest("hex");

  fs.writeFileSync(path.join(base, MANIFEST),
    JSON.stringify(Object.assign({ generated: new Date().toISOString(), fingerprint }, body), null, 1),
    "utf8");

  return { count: Object.keys(files).length, bytes, fingerprint };
}

function appVersion() {
  const src = fs.readFileSync(path.join(ROOT, "core", "kernel.js"), "utf8");
  const m = /var VERSION\s*=\s*["']([^"']+)["']/.exec(src);
  return m ? m[1] : "unknown";
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.copyFileSync(src, dest);
  }
}

function dirSize(p) {
  let bytes = 0, files = 0;
  (function walk(q) {
    const st = fs.statSync(q);
    if (st.isDirectory()) { for (const e of fs.readdirSync(q)) walk(path.join(q, e)); }
    else { bytes += st.size; files++; }
  })(p);
  return { bytes, files };
}

function fmt(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

/* Deploy, then PROVE it. The old version copied whatever happened
   to exist and reported a count of directories, which is exactly
   the shape of report that looks fine while the drive is missing
   the one file the app needs. It now reads the manifest back and
   checks every entry actually landed, byte-for-byte in size.

   This matters more than it sounds: the failure it catches is a
   half-copied stick that boots to MODULE LOAD FAILURE on a machine
   with no terminal to diagnose it. */
function deploy(target) {
  if (!target) throw new Error("--deploy needs a target path, e.g. --deploy E:\\");
  if (!fs.existsSync(target)) throw new Error("target does not exist: " + target);

  const entries = DEPLOY_BUILDS.map((b) => ({
    spec: b, html: fs.readFileSync(path.join(ROOT, b.entry), "utf8")
  }));
  const manifest = entries[0] ? readManifest(entries[0].html) : [];
  const optional = readOptional(entries[0].html);

  const dest = path.join(target, "FieldKit");
  fs.mkdirSync(dest, { recursive: true });

  const copied = [];
  const absent = [];
  for (const item of payloadList()) {
    if (NEVER_DEPLOY.indexOf(item) >= 0) {
      throw new Error(`refusing to deploy '${item}' — it belongs on the SSD or the server`);
    }
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) { absent.push(item); continue; }
    copyRecursive(from, path.join(dest, item));
    copied.push(item);
  }

  /* ---- verification ----
     Every build's manifest, not just the first. An OUTPOST that is
     missing a script fails exactly the same way FIELDKIT would, on
     exactly the same kind of machine, and checking only one of them
     would mean the limited build ships unverified. */
  const missing = [];
  const wrongSize = [];
  const seen = new Set();
  for (const e of entries) {
    for (const f of readManifest(e.html)) {
      if (seen.has(f)) continue;
      seen.add(f);
      const src = path.join(ROOT, f);
      const dst = path.join(dest, f);
      if (!fs.existsSync(dst)) { missing.push(f); continue; }
      if (fs.statSync(dst).size !== fs.statSync(src).size) wrongSize.push(f);
    }
    if (!fs.existsSync(path.join(dest, e.spec.entry))) missing.push(e.spec.entry);
    if (!fs.existsSync(path.join(dest, e.spec.out))) missing.push(e.spec.out);
  }

  if (missing.length || wrongSize.length) {
    console.error("");
    console.error("DEPLOY INCOMPLETE — the drive would not boot:");
    missing.forEach((f) => console.error("  MISSING       " + f));
    wrongSize.forEach((f) => console.error("  SIZE MISMATCH " + f));
    console.error("");
    console.error("The usual cause is the drive filling up or being pulled mid-copy.");
    throw new Error(`${missing.length} missing, ${wrongSize.length} truncated`);
  }

  /* Hashed from what actually landed on the drive, not from the SSD
     sources — the whole point is to describe the stick. */
  const man = writeManifest(dest, manifestList(), appVersion());

  const { bytes, files } = dirSize(dest);
  console.log("");
  console.log(`deployed to ${dest}`);
  console.log(`  ${files} files, ${fmt(bytes)}`);
  console.log(`  ${seen.size} boot-manifest scripts verified present and complete, across ${entries.length} builds`);
  console.log(`  ${man.count} files hashed into ${MANIFEST}`);

  /* Optional bundles are absent by design, but a present one that
     failed to copy is a silent feature regression — the app works
     on the SSD and quietly does not on the stick. */
  const optHere = optional.filter((f) => fs.existsSync(path.join(ROOT, f)));
  const optThere = optHere.filter((f) => fs.existsSync(path.join(dest, f)));
  if (optHere.length) {
    console.log(`  ${optThere.length}/${optHere.length} optional bundle(s) copied` +
      (optThere.length < optHere.length
        ? "  <-- one did not land; check the PAYLOAD list" : ""));
  } else if (optional.length) {
    console.log(`  ${optional.length} optional bundle(s) not built — normal ` +
      "(run tools/build-webllm.js if you want tier 2)");
  }

  if (absent.length) {
    console.log(`  not present, skipped: ${absent.join(", ")}`);
  }

  /* Free space, because the whole point of the stick is that it is
     small and the whole point of this project is that it barely
     uses it. Worth showing so the number stays honest. */
  console.log("");
  if (OUTPOST_ONLY) {
    console.log("");
    console.log("OUTPOST-ONLY DRIVE. FIELDKIT.html is not on it, and neither is its");
    console.log("standalone build. There is no vault code here to reach: core/crypto.js,");
    console.log("core/store.js and the transports are absent from OUTPOST's manifest,");
    console.log("which is the whole of how that build is limited — not a flag anyone");
    console.log("could turn back on.");
    console.log("");
    console.log("Hand this one out. OUTPOST cannot fetch updates, so re-run");
    console.log("`node build.js --only OUTPOST --deploy <drive>` when you want it current.");
  }

  if (fs.existsSync(path.join(dest, "models"))) {
    console.log("");
    console.log("models/ was copied but is NOT in the drive manifest — weights are");
    console.log("gigabytes and hashing them every build would make the build unusable.");
    console.log("PREFLIGHT therefore does not verify them. See MODELS.md.");
  }

  console.log("");
  console.log("DRIVE FINGERPRINT  " + man.fingerprint.slice(0, 16));
  console.log("  Write the first 8 characters down somewhere that is NOT this drive.");
  console.log("  PREFLIGHT.html shows the same value; if it ever differs, the drive");
  console.log("  was written to by a machine you did not intend to write to it.");

  console.log("");
  console.log("Remember: the drive is a COPY. Edit on the SSD and re-run this.");
  console.log("The relay is separate again — upload relay/ to Pterodactyl by hand.");
}

/* ---- release (§14.4) -------------------------------------------
   Auto-update is a remote-code path into the application that holds
   the vault, so the release is signed and the relay is not trusted
   to vouch for it. Signing happens HERE, on the SSD, with a key that
   is not on the relay and not in the repo — which is what lets the
   relay be compromised completely without being able to produce a
   build FieldKit will accept.

   What is shipped is the standalone HTML, not the 74-file payload.
   `file://` cannot write to the drive, so an update ends with the
   user saving one file over another; that only works if it IS one
   file. The full payload still goes over by `--deploy`. */
const RELEASE_DIR = path.join(ROOT, "release");
const KEY_FILE = path.join(ROOT, "release-key.json");

/* Signed as a canonical string rather than as an object, because
   two JSON serialisers can disagree about key order and a
   signature over "whatever JSON.stringify did that day" is a
   signature that verifies only by luck. The client rebuilds this
   exact string from the fields it read and checks that. */
function signingPayload(rel) {
  return [
    rel.version,
    rel.publishedAt,
    rel.files.map((f) => f.name + ":" + f.size + ":" + f.sha256).join("|")
  ].join("\n");
}

function release(notes) {
  if (!fs.existsSync(KEY_FILE)) {
    throw new Error("no release-key.json — run `node tools/make-release-key.js` first.\n" +
      "  An unsigned release channel is a way to hand someone a modified\n" +
      "  core/crypto.js, so this refuses to produce one.");
  }
  const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));

  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  /* PREFLIGHT goes with them: it is the third file in every release
     (README, "Three files"), and signing it means the updater can
     check it like the other two. */
  const files = BUILDS.concat([{ out: "PREFLIGHT.html", label: "PREFLIGHT" }]).map((b) => {
    const buf = fs.readFileSync(path.join(ROOT, b.out));
    fs.writeFileSync(path.join(RELEASE_DIR, b.out), buf);
    return {
      name: b.out,
      build: b.label,
      size: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex")
    };
  });

  const rel = {
    version: appVersion(),
    publishedAt: new Date().toISOString(),
    notes: String(notes || "").slice(0, 500).replace(/-->/g, "->"),
    algorithm: key.algorithm,
    keyFingerprint: key.fingerprint,
    files: files
  };

  const priv = crypto.createPrivateKey({
    key: Buffer.from(key.privateKeyPkcs8B64, "base64"), format: "der", type: "pkcs8"
  });
  /* ieee-p1363 rather than Node's default DER: that is the raw r||s
     form WebCrypto's verify() expects, and converting in the browser
     would be code whose only job is to undo a choice made here. */
  rel.signature = crypto.sign("sha256", Buffer.from(signingPayload(rel), "utf8"),
    { key: priv, dsaEncoding: "ieee-p1363" }).toString("base64");

  fs.writeFileSync(path.join(RELEASE_DIR, "release.json"),
    JSON.stringify(rel, null, 2), "utf8");

  /* Verified here, immediately, with the public half. A release that
     does not verify on the machine that just signed it will not
     verify anywhere, and finding that out now beats finding out from
     someone whose update failed. */
  const pub = crypto.createPublicKey({
    key: Buffer.from(key.publicKeySpkiB64, "base64"), format: "der", type: "spki"
  });
  const good = crypto.verify("sha256", Buffer.from(signingPayload(rel), "utf8"),
    { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(rel.signature, "base64"));
  if (!good) throw new Error("the release did not verify against its own public key");

  /* The shipped public key must be the one that signed this, or
     every client rejects the release and the reason is invisible
     from the relay's side. */
  const shipped = fs.readFileSync(path.join(ROOT, "core", "update-key.js"), "utf8");
  if (shipped.indexOf(key.publicKeySpkiB64) < 0) {
    throw new Error("core/update-key.js does not carry the public half of release-key.json.\n" +
      "  The build would be signed with a key no client has. Re-run\n" +
      "  tools/make-release-key.js, or restore the matching key file.");
  }

  /* The GitHub release's notes. The signed record rides inside an
     HTML comment, which GitHub keeps but does not show: the updater
     and the relay's mirror read it from the API (relay/updates.js,
     modules/updater.js, parseReleaseBody). */
  fs.writeFileSync(path.join(RELEASE_DIR, "BODY.md"), releaseBody(rel), "utf8");

  console.log("");
  console.log("RELEASE  v" + rel.version + "  signed and self-verified");
  files.forEach((f) => {
    console.log("  " + f.name.padEnd(26) + fmt(f.size) + "   " + f.sha256.slice(0, 16) + "…");
  });
  console.log("  key fingerprint  " + rel.keyFingerprint);
  console.log("");
  console.log("Publish on GitHub (the relay mirrors it from there):");
  console.log("  gh release create v" + rel.version + " " + files.map((f) => "release/" + f.name).join(" ") +
    " --notes-file release/BODY.md");
  console.log("Or upload the contents of release/ to the relay's data/updates/ folder.");
  console.log("");
  console.log("The private key stays here. Do not upload release-key.json.");
  return rel;
}

function releaseBody(rel) {
  return [
    "## FieldKit " + rel.version,
    "",
    rel.notes || "",
    "",
    "Three files: **PREFLIGHT.html** (open first: checks this machine and the relay), " +
      "**FIELDKIT-STANDALONE.html** (the full console) and **OUTPOST-STANDALONE.html** (no vault). " +
      "See the README.",
    "",
    "Signed with key `" + rel.keyFingerprint + "`. UPDATE inside FieldKit checks the signature and each file's hash.",
    "",
    "<!-- FIELDKIT-RELEASE",
    JSON.stringify(rel, null, 1),
    "FIELDKIT-RELEASE -->",
    ""
  ].join("\n");
}

/* Only when run as a command. The test suite imports this file for
   signingPayload() and mergeConfig(), and an import that rebuilt
   everything as a side effect would mean running one test rewrote
   the standalone builds, the manifest and the relay config —
   sometimes usefully, which is worse, because it would hide a
   failure to run the build at all. */
if (require.main === module) {
  try {
    buildAll();
    writeRelayConfig();
    const r = process.argv.indexOf("--release");
    if (r >= 0) release(process.argv[r + 1]);
    const i = process.argv.indexOf("--deploy");
    if (i >= 0) deploy(process.argv[i + 1]);
  } catch (e) {
    console.error("BUILD FAILED: " + e.message);
    process.exit(1);
  }
}

module.exports = { signingPayload, releaseBody, appVersion, mergeConfig, PAYLOAD, payloadList };
