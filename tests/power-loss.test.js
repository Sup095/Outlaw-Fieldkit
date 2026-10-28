/* ============================================================
   Power cuts (RUNNER_PLAN.md phase 9, FIELDKIT_PROJECT.md §14.41).

   What a power cut can leave behind: a record cut short, a temp file
   that never got renamed, an upload half written. What matters:
     1. A damaged record is read from its .bak copy.
     2. Damaged with no good copy: whatever was about to change it
        stops, and nothing is saved over it. Before this, a damaged
        file read as empty and the next write made that permanent:
        a users.json became a one-account list, a file list lost
        everything but the newest upload, a ban list emptied.
     3. A deleted record does not come back from its backup.
     4. The run server, killed mid-upload, starts again with every
        finished file and none of the half one.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { makeRunner } = require("./harness");
const jf = require("../relay/jsonfile");
const { Store } = require("../runnerd/store");
const { Admin } = require("../runnerd/admin");
const ticket = require("../runnerd/ticket");
const { connect } = require("./runner-kit");
const { ok, section, state } = makeRunner("power-loss");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-power-loss-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (f) => { const t = fs.readFileSync(f, "utf8"); fs.writeFileSync(f, t.slice(0, Math.floor(t.length / 2))); };

(async () => {
  section("jsonfile: one whole copy always");
  {
    const f = path.join(TMP, "a.json");
    ok("a file that is not there is the empty value", JSON.stringify(jf.read(f, { n: 0 })) === "{\"n\":0}");
    jf.write(f, { n: 1 });
    jf.write(f, { n: 2 });
    ok("the previous good copy is kept as .bak", jf.read(f + ".bak", null).n === 1 && jf.read(f, null).n === 2);
    ok("no temp file is left", !fs.existsSync(f + ".tmp"));
    cut(f);
    const r = jf.readInfo(f, null);
    ok("a damaged file is read from its .bak", r.from === "bak" && r.value.n === 1);
    jf.write(f, { n: 3 });
    ok("a damaged file never becomes the backup", jf.read(f + ".bak", null).n === 1 && jf.read(f, null).n === 3);
    cut(f); cut(f + ".bak");
    let threw = null;
    try { jf.read(f, {}); } catch (e) { threw = e; }
    ok("both damaged: it says so instead of reading empty", threw && threw.damaged && /damaged/.test(threw.message));
    let said = null;
    ok("readSoft gives the empty value and reports it", JSON.stringify(jf.readSoft(f, [], (e) => { said = e; })) === "[]" && !!said);
    jf.write(f, { n: 9 });
    jf.remove(f);
    ok("a removed record stays removed (its .bak is not used)", jf.read(f, null) === null && !fs.existsSync(f + ".bak"));
    jf.write(f, { n: 1 });
    fs.unlinkSync(f);
    ok("and a missing file with a .bak beside it reads as missing", jf.read(f, null) === null);
  }

  section("the run server's file lists");
  {
    const root = path.join(TMP, "store");
    const store = new Store(root);
    store.open();
    const me = { kind: "user", handle: "dana" };
    const L = { maxFileBytes: 1e6, maxFiles: 50, quotaBytes: 1e7 };
    const up = (name, body) => { const b = Buffer.from(body); const h = store.begin(me, { name, size: b.length, sha256: sha(b) }, L); h.write(b); return h.finish(); };
    up("one.txt", "1"); up("two.txt", "22"); up("three.txt", "333");
    const file = path.join(root, "users", "dana.json");
    cut(file);
    ok("a list cut short is read from its .bak (only the newest file is missing)", store.list(me).length === 2);
    up("four.txt", "4444");
    cut(file); cut(file + ".bak");
    let refused = null;
    try { up("five.txt", "55555"); } catch (e) { refused = e.message; }
    ok("with no good copy, an upload is refused in words", /damaged/.test(refused || ""), refused);
    ok("and nothing was saved over the damaged list", fs.readFileSync(file, "utf8").length > 0 && (() => { try { JSON.parse(fs.readFileSync(file, "utf8")); return false; } catch (e) { return true; } })());
    const r = store.sweep(Date.now() + 400 * 86400000, 1, 1);
    ok("the expiry sweep leaves a damaged list alone", r.expired.length === 0 && /damaged/.test(store.damaged || ""));
    ok("and no file it lists can be deleted as unused", store._blobInUse(sha(Buffer.from("1"))));

    const lib = path.join(root, "library.json");
    jf.write(lib, { version: 1, files: { abc: { id: "abc", name: "game", sha256: "0".repeat(64), size: 1 } } });
    cut(lib); fs.writeFileSync(lib + ".bak", "{");
    ok("a damaged library shows as empty instead of breaking every list", store.library().length === 0);
  }

  section("bans survive a damaged record");
  {
    const root = path.join(TMP, "admin");
    fs.mkdirSync(root, { recursive: true });
    const a = new Admin(root);
    jf.write(a.files.people, { version: 1, people: { eve: { suspended: { until: null, reason: "x" } } } });
    cut(a.files.people); fs.writeFileSync(a.files.people + ".bak", "{");
    const b = new Admin(root);
    b._read("people", {});
    ok("ADMIN is told the record is damaged", Object.keys(b.damaged).length === 1);
    let refused = null;
    try { b._write("people", { version: 1, people: {} }); } catch (e) { refused = e.message; }
    ok("and an empty list is not saved over it", /damaged/.test(refused || ""));
    jf.write(b.files.audit, [1]); cut(b.files.audit); fs.writeFileSync(b.files.audit + ".bak", "[");
    b._write("audit", [2]);
    ok("the audit log, being only a log, is set aside and started again",
      jf.read(b.files.audit, null)[0] === 2 && fs.readdirSync(root).some((n) => /audit\.json\.damaged-/.test(n)));
  }

  section("the run server, killed mid-upload");
  {
    const pair = crypto.generateKeyPairSync("ed25519");
    const pub = pair.publicKey.export({ type: "spki", format: "pem" });
    const storePath = path.join(TMP, "killed");
    const cfgFile = path.join(TMP, "killed.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ host: "127.0.0.1", port: 0, storePath, driver: "process", dev: true, ticketPublicKey: pub }));
    const start = () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(__dirname, "..", "runnerd", "server.js")], { stdio: ["ignore", "pipe", "pipe"], env: Object.assign({}, process.env, { FK_RUNNER_CONFIG: cfgFile }) });
      let out = "";
      const on = (d) => { out += d; const m = /listening on [^:]+:(\d+)/.exec(out); if (m) resolve({ p, port: Number(m[1]) }); };
      p.stdout.on("data", on); p.stderr.on("data", on);
      p.on("exit", () => reject(new Error("runnerd exited: " + out.slice(-400))));
      setTimeout(() => reject(new Error("runnerd did not start: " + out.slice(-400))), 15000);
    });
    const t = () => ticket.sign(pair.privateKey, { handle: "fred", tier: "member", exp: Date.now() + 30000 });
    let s;
    try { s = await start(); } catch (e) { ok("runnerd starts from its own entrypoint", false, e.message); }
    if (s) {
      const c = await connect(s.port, t());
      await c.hello();
      const done = await c.put("kept.txt", "kept");
      ok("a finished upload", done.t === "put-done");
      const big = Buffer.alloc(300000, 7);
      c.say({ t: "put", ref: "half", name: "half.bin", size: big.length, sha256: sha(big) });
      await c.next((m) => m.t === "put-ok");
      c.sock.send(big.subarray(0, 100000));
      await wait(300);
      s.p.kill("SIGKILL");
      await wait(300);
      const s2 = await start();
      const c2 = await connect(s2.port, t());
      await c2.hello();
      c2.say({ t: "ls" });
      const ls = await c2.next("files");
      const names = (ls.files || []).map((f) => f.name);
      ok("after the kill: the finished file is there and the half one is not", names.includes("kept.txt") && !names.includes("half.bin"), JSON.stringify(names));
      ok("and the half-written bytes were cleaned up", fs.readdirSync(path.join(storePath, "tmp")).length === 0);
      await c2.close();
      s2.p.kill();
    }
  }

  section("the relay's accounts and vault");
  {
    const DATA = path.join(TMP, "relay-data"), CONFIG = path.join(TMP, "relay.json"), PORT = 25689;
    const BASE = "http://127.0.0.1:" + PORT;
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ port: PORT, host: "127.0.0.1", dataDir: DATA, provisionToken: "pt",
      messaging: { enabled: true, openRegistration: true, moderators: [] },
      rateLimit: { windowMs: 60000, max: 5000, msgMax: 5000, msgAuthMax: 500 } }));
    let proc = null, out = "";
    const up = async () => {
      out = "";
      proc = spawn(process.execPath, [path.join(__dirname, "..", "relay", "server.js")],
        { env: Object.assign({}, process.env, { FK_CONFIG: CONFIG }), stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (c) => { out += c; }); proc.stderr.on("data", (c) => { out += c; });
      for (let i = 0; i < 100; i++) { await wait(100); try { if ((await fetch(BASE + "/health")).ok) return true; } catch (e) {} }
      return false;
    };
    const down = () => new Promise((r) => { proc.on("exit", r); proc.kill(); });
    const reg = (h) => fetch(BASE + "/msg/register", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: h, authSecret: "s".repeat(64), pubKey: "PUB-" + h, wrappedPrivKey: "W-" + h }) });
    ok("a relay starts", await up(), out.slice(-300));
    for (const h of ["anna", "bert", "cleo"]) await reg(h);
    await fetch(BASE + "/vault", { method: "POST", headers: { "Content-Type": "application/json", "X-FieldKit-Provision": "pt" },
      body: JSON.stringify({ authKeyHash: "x", kdf: {}, wrap: {} }) });
    await down();
    const USERS = path.join(DATA, "msg", "users.json"), VAULT = fs.readdirSync(DATA).find((n) => /vault/.test(n) && n.endsWith(".json"));
    cut(USERS); fs.writeFileSync(USERS + ".bak", "{");
    if (VAULT) { cut(path.join(DATA, VAULT)); try { fs.unlinkSync(path.join(DATA, VAULT + ".bak")); } catch (e) {} }
    ok("it still starts with both damaged", await up(), out.slice(-300));
    ok("and says the vault header is damaged", !VAULT || /DAMAGED/.test(out), out.slice(-400));
    const r = await reg("dora");
    ok("a new account is refused while the account list is damaged", r.status >= 500, String(r.status));
    ok("and the damaged list was not replaced by a one-account list", (() => { try { JSON.parse(fs.readFileSync(USERS, "utf8")); return false; } catch (e) { return true; } })());
    const h = await (await fetch(BASE + "/health")).json();
    ok("a damaged vault header is not offered for setting up again", h.vaultProvisioned === true);
    const again = await fetch(BASE + "/vault", { method: "POST", headers: { "Content-Type": "application/json", "X-FieldKit-Provision": "pt" },
      body: JSON.stringify({ authKeyHash: "y", kdf: {}, wrap: {} }) });
    ok("and provisioning over it is refused", again.status !== 201, String(again.status));
    await down();
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
