/* ============================================================
   Updates from GitHub, through the relay, and RELAY LINK (§14.43).

   What matters:
     1. The relay copies the latest GitHub release only when every
        file matches the signed record in its notes; anything else
        leaves what it had.
     2. The newer of the GitHub copy and a hand upload is served,
        to anyone (the builds are public).
     3. The client and the relay read the record the same way.
     4. OUTPOST carries UPDATE and RELAY LINK, and still no vault.
     5. RELAY LINK edits the boot chooser's list, and reports what
        the relay in use offers.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const nodeCrypto = require("crypto");
const { bootstrap, makeRunner, fakeElement, ROOT } = require("./harness");
const build = require("../build.js");
const updates = require("../relay/updates.js");
const { ok, section, state } = makeRunner("update-mirror");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-mirror-"));
const sha = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");
const key = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function makeRelease(version, files) {
  const rel = { version, publishedAt: "2026-10-27T00:00:00.000Z", notes: "n", algorithm: "ECDSA-P256-SHA256",
    keyFingerprint: "TEST", files: files.map(([name, buf]) => ({ name, build: name.split("-")[0], size: buf.length, sha256: sha(buf) })) };
  rel.signature = nodeCrypto.sign("sha256", Buffer.from(build.signingPayload(rel)), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return rel;
}

/* A GitHub that answers from a table. */
function github(rel, bytes, opts) {
  opts = opts || {};
  const calls = [];
  const fetcher = async (u) => {
    calls.push(u);
    if (opts.down) throw new TypeError("fetch failed");
    if (/api\.github\.com/.test(u)) {
      const body = { tag_name: "v" + rel.version, body: opts.body != null ? opts.body : build.releaseBody(rel),
        assets: rel.files.map((f) => ({ name: f.name, digest: opts.digest ? "sha256:" + opts.digest : "sha256:" + f.sha256,
          browser_download_url: "https://github.com/dl/" + f.name })) };
      return { ok: true, status: 200, json: async () => body };
    }
    const name = u.split("/").pop();
    const b = opts.swap && opts.swap[name] ? opts.swap[name] : bytes[name];
    return { ok: !!b, status: b ? 200 : 404, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  };
  fetcher.calls = calls;
  return fetcher;
}

async function ask(pathname, query) {
  const sent = [];
  let head = null, body = null;
  const res = { writeHead(s, h) { head = { s, h }; }, end(b) { body = b; } };
  await updates.route({ method: "GET", headers: {} }, res,
    { pathname, searchParams: new URLSearchParams(query || "") },
    { send: (r, status, b) => sent.push({ status, body: b }) });
  return sent[0] || { status: head && head.s, headers: head && head.h, bytes: body };
}

(async () => {
  const A = Buffer.from("<html>fieldkit 0.3.0</html>"), B = Buffer.from("<html>outpost 0.3.0</html>");
  const bytes = { "FIELDKIT-STANDALONE.html": A, "OUTPOST-STANDALONE.html": B };
  const rel = makeRelease("0.3.0", [["FIELDKIT-STANDALONE.html", A], ["OUTPOST-STANDALONE.html", B]]);
  const data = path.join(TMP, "data");
  const logs = [];
  updates.init({ dataDir: data, config: { enabled: true, githubRepo: "Owner/repo" }, log: (l, m) => logs.push(l + " " + m), mirror: false });

  section("the release notes carry the record");
  {
    const body = build.releaseBody(rel);
    ok("the record is inside an HTML comment GitHub keeps but does not show", /<!-- FIELDKIT-RELEASE[\s\S]*FIELDKIT-RELEASE -->/.test(body));
    ok("and reads back exactly", JSON.stringify(updates.parseReleaseBody(body)) === JSON.stringify(rel));
    ok("with Windows line endings too (GitHub's editor)", updates.parseReleaseBody(body.replace(/\n/g, "\r\n")).signature === rel.signature);
    ok("notes with no record, or a broken one, read as nothing",
      updates.parseReleaseBody("just notes") === null && updates.parseReleaseBody("<!-- FIELDKIT-RELEASE {nope FIELDKIT-RELEASE -->") === null);
    const re = (f) => (/var BODY_RE = (.*);|const BODY_RE = (.*);/.exec(fs.readFileSync(path.join(ROOT, f), "utf8")) || []).slice(1).filter(Boolean)[0];
    ok("the client and the relay read it the same way", re("modules/updater.js") && re("modules/updater.js") === re("relay/updates.js"));
    const src = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
    ok("releases carry PREFLIGHT, signed like the builds", /out: "PREFLIGHT\.html"/.test(src) && /BODY\.md/.test(src));
  }

  section("nothing is served before there is something");
  {
    const r = await ask("/updates/latest");
    ok("503 with the reason", r.status === 503 && /no release/.test(r.body.error));
    const s = await ask("/updates/status");
    ok("status says nothing is served, and which repo it follows", s.status === 200 && s.body.serving === null && s.body.github.repo === "Owner/repo");
  }

  section("the GitHub copy");
  {
    await updates.mirror(github(rel, bytes, { down: true }));
    ok("GitHub unreachable: an error is kept, nothing is served", /fetch failed/.test(updates._internals.mirrorState.error) && (await ask("/updates/latest")).status === 503);

    await updates.mirror(github(rel, bytes, { body: "no record here" }));
    ok("a release with no signed record is not copied", /no signed FieldKit record/.test(updates._internals.mirrorState.error));

    await updates.mirror(github(rel, bytes, { digest: "0".repeat(64) }));
    ok("GitHub's hash disagreeing with the record: not copied", /does not match the signed record/.test(updates._internals.mirrorState.error));

    await updates.mirror(github(rel, bytes, { swap: { "OUTPOST-STANDALONE.html": Buffer.from("<html>evil</html>") } }));
    ok("a downloaded file that does not match: not copied", /downloaded OUTPOST-STANDALONE\.html does not match/.test(updates._internals.mirrorState.error) &&
      (await ask("/updates/latest")).status === 503);
    ok("and nothing half-copied is left being served", !fs.existsSync(path.join(data, "updates", "github", "release.json")));

    const gh = github(rel, bytes);
    await updates.mirror(gh);
    ok("a good release is copied", updates._internals.mirrorState.error === null && updates._internals.mirrorState.version === "0.3.0", updates._internals.mirrorState.error);
    const latest = await ask("/updates/latest");
    ok("and served to anyone, exactly as signed", latest.status === 200 && latest.body.signature === rel.signature);
    const file = await ask("/updates/file", "name=OUTPOST-STANDALONE.html");
    ok("with its files, as downloads", file.status === 200 && Buffer.compare(file.bytes, B) === 0 && /attachment/.test(file.headers["Content-Disposition"]));
    ok("release.json itself is not a file you can ask for", (await ask("/updates/file", "name=release.json")).status === 404);
    const n = gh.calls.length;
    await updates.mirror(gh);
    ok("asking again when nothing changed downloads nothing", gh.calls.length === n + 1);

    const s = await ask("/updates/status");
    ok("status says what is served and where from", s.body.serving === "0.3.0" && s.body.source === "github");

    await updates.mirror(github(rel, bytes, { down: true }));
    ok("GitHub going away later keeps the copy it had", (await ask("/updates/latest")).status === 200);
  }

  section("a hand upload still works, and the newer wins");
  {
    const dir = path.join(data, "updates");
    const C = Buffer.from("<html>0.3.1</html>");
    const newer = makeRelease("0.3.1", [["FIELDKIT-STANDALONE.html", C]]);
    fs.writeFileSync(path.join(dir, "FIELDKIT-STANDALONE.html"), C);
    fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(newer));
    ok("an uploaded 0.3.1 beats GitHub's 0.3.0", (await ask("/updates/latest")).body.version === "0.3.1");
    ok("and its file is served from the upload", Buffer.compare((await ask("/updates/file", "name=FIELDKIT-STANDALONE.html")).bytes, C) === 0);
    const older = makeRelease("0.2.0", [["FIELDKIT-STANDALONE.html", C]]);
    fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(older));
    ok("an uploaded 0.2.0 loses to GitHub's 0.3.0", (await ask("/updates/latest")).body.version === "0.3.0");
    fs.writeFileSync(path.join(dir, "FIELDKIT-STANDALONE.html"), "tampered");
    fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(newer));
    ok("a stored file that no longer matches is refused, not served", (await ask("/updates/file", "name=FIELDKIT-STANDALONE.html")).status === 409);
  }

  section("the relay's config");
  {
    const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "relay", "config.example.json"), "utf8"));
    ok("updates are on, following the public repo", ex.updates.enabled === true && ex.updates.githubRepo === "Sup095/Outlaw-Fieldkit");
    updates.init({ dataDir: data, config: { enabled: true, githubRepo: "not a repo" }, log: (l, m) => logs.push(l + " " + m), mirror: false });
    ok("a repo that is not owner/name is named, not followed", logs.some((m) => /owner\/name/.test(m)));
    updates.stop();
  }

  section("OUTPOST carries UPDATE and RELAY LINK");
  {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
    const list = (h) => JSON.parse(/FK_BOOT_MANIFEST = (\[[\s\S]*?\]);/.exec(h)[1]);
    const out = list(read("OUTPOST.html")), full = list(read("FIELDKIT.html"));
    ok("both builds have UPDATE and the key to check releases",
      ["core/update-key.js", "modules/updater.js"].every((f) => out.indexOf(f) >= 0 && full.indexOf(f) >= 0));
    ok("OUTPOST has its own RELAY LINK; the full build keeps the one that provisions the vault",
      out.indexOf("modules/relay-link.js") >= 0 && full.indexOf("modules/relay-link.js") < 0 && full.indexOf("modules/relay-config.js") >= 0 && out.indexOf("modules/relay-config.js") < 0);
    ok("the key loads before the updater", out.indexOf("core/update-key.js") < out.indexOf("modules/updater.js"));
    const up = read("modules/updater.js");
    ok("the updater needs no vault service", !/need\(\s*["'](transportRelay|crypto|store)["']/.test(up) && !/service\(\s*["']transportRelay["']/.test(up));
    ok("it asks GitHub first and the relay second", up.indexOf("fromGithub()") < up.indexOf("fromRelay()") && /api\.github\.com\/repos\//.test(up));
    ok("PREFLIGHT is for this version", /var FOR_VERSION = "(.*)"/.exec(read("PREFLIGHT.html"))[1] === /var VERSION = "(.*)"/.exec(read("core/kernel.js"))[1]);
  }

  section("RELAY LINK");
  {
    const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/relay-choice.js", "core/ui.js", "core/qr.js", "modules/relay-link.js"]);
    const settings = FieldKit.need("settings");
    settings.set("relayUrl", "https://one.example");
    settings.set("relayUrls", ["https://two.example"]);
    const answers = { "https://one.example/health": { up: true, vaultProvisioned: true, features: ["records"] },
      "https://two.example/health": { up: true },
      "https://one.example/browser/status": { enabled: true, available: true, sessions: 1, maxSessions: 4 },
      "https://one.example/runner/status": { enabled: true, online: true, ready: true },
      "https://one.example/updates/status": { serving: "0.3.0", source: "github" } };
    global.fetch = async (u) => {
      const v = answers[String(u)];
      if (!v) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) };
    };
    global.WebSocket = function (u) { const w = this; w.close = () => {}; setTimeout(() => w.onmessage && w.onmessage({ data: "fieldkit-ws-ok" }), 5); };
    const def = FieldKit.modules()["relay-link"];
    const host = fakeElement("div");
    const ctx = { settings, ui: FieldKit.need("ui"), log() {}, warn() {}, error() {}, on() {}, emit() {} };
    await def.mount(host, ctx);
    const texts = () => { const t = []; (function walk(x) { (x.children || []).forEach((c) => { if (c && c.nodeType !== 3) { t.push(String(c.textContent || "")); walk(c); } }); })(host); return t; };
    const btn = (re, nth) => { const b = []; (function walk(x) { (x.children || []).forEach((c) => { if (c && c.nodeType !== 3) { b.push(c); walk(c); } }); })(host); return b.filter((e) => e.tagName === "BUTTON" && re.test(e.textContent))[nth || 0]; };
    for (let i = 0; i < 100 && !texts().some((t) => /^OFFERS 0\.3\.0/.test(t)); i++) await new Promise((r) => setTimeout(r, 10));
    const all = texts().join(" | ");
    ok("opening it shows what the relay in use offers", /ANSWERS IN \d+ MS, VAULT SET UP/.test(all) && /GET THROUGH THIS NETWORK/.test(all) &&
      /AVAILABLE, 1 OF 4 IN USE/.test(all) && /^READY$|\| READY \|/.test(all) && /OFFERS 0\.3\.0, COPIED FROM GITHUB/.test(all), all.slice(0, 400));
    ok("it lists both addresses, the one in use first", texts().some((t) => t === "one.example  (in use)") && texts().some((t) => t === "two.example"));
    ok("with a QR code of the address", (function find(n) { return (n.children || []).some((c) => c && (c.tagName === "IMG" && /^data:image\/svg/.test(c.getAttribute ? c.getAttribute("src") || c.src || "" : c.src || "") || find(c))); })(host));
    btn(/^USE$/).click();
    ok("USE switches the address in use and keeps the other", settings.get("relayUrl") === "https://two.example" && settings.get("relayUrls").indexOf("https://one.example") >= 0);
    btn(/TEST ALL/).click();
    for (let i = 0; i < 100 && !texts().some((t) => /answer from here/.test(t)); i++) await new Promise((r) => setTimeout(r, 10));
    ok("TEST ALL says how many answer", texts().some((t) => /^2 of 2 answer from here/.test(t)), texts().filter((t) => /answer/.test(t)).join(" | "));
    const input = (function find(n) { for (const c of n.children || []) { if (c && c.tagName === "INPUT") return c; const r = c && find(c); if (r) return r; } return null; })(host);
    input.value = "not an address !";
    btn(/^ADD$/).click();
    ok("a non-address is refused with a sentence", texts().some((t) => /that is not an address/.test(t)) && settings.get("relayUrls").length === 1);
    const input2 = (function find(n) { for (const c of n.children || []) { if (c && c.tagName === "INPUT") return c; const r = c && find(c); if (r) return r; } return null; })(host);
    input2.value = "three.example";
    btn(/^ADD AND USE$/).click();
    ok("ADD AND USE adds it as https and uses it", settings.get("relayUrl") === "https://three.example" && settings.get("relayUrls").length === 2);
    btn(/✕/).click();
    ok("✕ on the one in use forgets it and moves to the next", settings.get("relayUrl") !== "https://three.example" && !settings.get("relayUrls").some((u) => /three/.test(u)));
    for (const c of def.selfcheck()) {
      let err = null; try { await c.run(); } catch (e) { err = e.message; }
      ok("selfcheck: " + c.name, !err, err);
    }
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
