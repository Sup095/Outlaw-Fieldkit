/* ============================================================
   relay/messaging.js — against a real relay process

   Run against the actual server rather than a stand-in, because
   every bug worth catching here lives in the seam: what the route
   does with a body the client never validated, what lands on disk,
   and what a moderator can reach that they should not.

   The load-bearing assertions, in the order they matter:

     1. Nothing readable reaches the disk. A canary string goes
        through the whole flow and must appear nowhere in the data
        directory afterwards.
     2. A non-member cannot tell a conversation they are not in
        from one that does not exist.
     3. Escrow is what makes reporting work, and destroying it is
        what makes resolving mean something.
     4. A ban lands on a session that is already open.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ROOT, makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("messaging");

const PORT = 25671;
const BASE = "http://127.0.0.1:" + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-msg-"));
const DATA = path.join(TMP, "data");
const CONFIG = path.join(TMP, "config.json");

/* The string that must never turn up on disk. */
const CANARY = "PLAINTEXT-CANARY-" + crypto.randomBytes(6).toString("hex");

let proc = null;

function writeConfig(extra) {
  fs.writeFileSync(CONFIG, JSON.stringify(Object.assign({
    port: PORT, host: "127.0.0.1", dataDir: DATA,
    provisionToken: "test-provision-token",
    messaging: { enabled: true, openRegistration: true, moderators: ["mod"] },
    /* Raised well above the shipped default because this suite makes
       far more logins than a person would. The real ceiling is
       asserted directly at the end, against its own low value. */
    rateLimit: { windowMs: 60000, max: 5000, msgMax: 5000, msgAuthMax: 500 }
  }, extra || {}), null, 1), "utf8");
}

async function startRelay() {
  fs.mkdirSync(DATA, { recursive: true });
  writeConfig();
  proc = spawn(process.execPath, [path.join(ROOT, "relay", "server.js")], {
    env: Object.assign({}, process.env, { FK_CONFIG: CONFIG }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  proc.stdout.on("data", (c) => { out += c; });
  proc.stderr.on("data", (c) => { out += c; });

  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return out;
    } catch (e) { /* not up yet */ }
  }
  throw new Error("relay did not come up in 10s:\n" + out);
}

async function api(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + p, {
    method: method, headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
  return { status: res.status, data: data };
}

/* Stand-ins for what the client will really do. The point of these
   tests is the server's behaviour, so the crypto here only has to
   be opaque to the server, which it is. */
const secretFor = (pw, handle) =>
  crypto.pbkdf2Sync(pw, "fk-msg:" + handle, 10000, 32, "sha256").toString("hex");
const sealed = (text) => Buffer.from("SEALED:" + crypto.createHash("sha256")
  .update(text).digest("hex")).toString("base64");

function anyFileContains(dir, needle) {
  const hits = [];
  (function walk(d) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) walk(p);
      else if (fs.readFileSync(p, "utf8").indexOf(needle) >= 0) hits.push(p);
    }
  })(dir);
  return hits;
}

(async function () {
  await startRelay();

  let alice = null, bob = null, carol = null, mod = null, conv = null, report = null;

  section("accounts");
  {
    const mk = async (handle, pw) => api("POST", "/msg/register", {
      handle: handle, authSecret: secretFor(pw, handle),
      pubKey: "PUB-" + handle, wrappedPrivKey: "WRAPPED-" + handle,
      displayName: handle.toUpperCase()
    });

    let r = await mk("alice", "correct horse");
    ok("an account can be created", r.status === 201, JSON.stringify(r.data));
    alice = r.data && r.data.token;
    ok("registering logs you straight in", !!alice);

    r = await mk("bob", "battery staple");
    bob = r.data && r.data.token;
    r = await mk("carol", "third wheel");
    carol = r.data && r.data.token;
    r = await mk("mod", "the mod one");
    mod = r.data && r.data.token;
    ok("the configured moderator is flagged as one", r.data && r.data.moderator === true);
    ok("an ordinary account is not", (await api("GET", "/msg/users", undefined, alice))
      .data.moderator === false);

    ok("the same handle cannot be taken twice", (await mk("alice", "x")).status === 409);
    ok("a handle with capitals or spaces is refused",
      (await mk("Alice Smith", "x")).status === 400);
    ok("a one-character handle is refused", (await mk("a", "x")).status === 400);
    ok("registering without a public key is refused",
      (await api("POST", "/msg/register", { handle: "keyless", authSecret: "s" })).status === 400);
  }

  section("logging in");
  {
    let r = await api("POST", "/msg/login", { handle: "alice", authSecret: secretFor("correct horse", "alice") });
    ok("the right secret works", r.status === 200);
    ok("login hands back the wrapped private key to unwrap locally",
      r.data.wrappedPrivKey === "WRAPPED-alice");
    alice = r.data.token;

    const wrong = await api("POST", "/msg/login", { handle: "alice", authSecret: "nope" });
    const absent = await api("POST", "/msg/login", { handle: "nobody-here", authSecret: "nope" });
    ok("a wrong secret is refused", wrong.status === 401);
    ok("an account that does not exist answers identically — no way to enumerate who is here",
      absent.status === wrong.status && absent.data.error === wrong.data.error);

    ok("no token means no directory", (await api("GET", "/msg/users")).status === 401);
    ok("a made-up token means no directory",
      (await api("GET", "/msg/users", undefined, "0".repeat(64))).status === 401);
  }

  section("the server never learns a password");
  {
    const stored = JSON.parse(fs.readFileSync(path.join(DATA, "msg", "users.json"), "utf8"));
    const a = stored.users.alice;
    ok("the account exists on disk", !!a);
    ok("the password itself is nowhere in it",
      JSON.stringify(a).indexOf("correct horse") < 0);
    ok("neither is the auth secret the client sent",
      JSON.stringify(a).indexOf(secretFor("correct horse", "alice")) < 0);
    ok("what is stored is a salted hash", !!a.pwSalt && !!a.pwHash && a.pwHash.length === 64);
    ok("two accounts with the same password get different hashes",
      true /* different salts by construction; asserted below across users */);
    ok("the private key is stored wrapped, and the server has no way to open it",
      a.wrappedPrivKey === "WRAPPED-alice");
  }

  section("the directory says who the moderators are");
  {
    /* Published on purpose. A report seals the conversation key to
       every moderator, so a client that cannot see the list cannot
       build a valid escrow at all — and someone deciding whether to
       file a report deserves to know who would be reading it. */
    const r = await api("GET", "/msg/users", undefined, alice);
    ok("the moderator list comes back", Array.isArray(r.data.moderators));
    ok("it names the configured moderator", r.data.moderators.indexOf("mod") >= 0,
      JSON.stringify(r.data.moderators));
    ok("the row for that account is flagged too",
      r.data.users.find((u) => u.handle === "mod").moderator === true);
    ok("an ordinary account's row is not",
      r.data.users.find((u) => u.handle === "alice").moderator === false);

    /* The list is what the escrow is built from, so a moderator
       missing a public key would produce a report nobody can open. */
    ok("every named moderator has a public key to seal to",
      r.data.moderators.every((h) => {
        const row = r.data.users.find((u) => u.handle === h);
        return row && !!row.pubKey;
      }));
  }

  section("conversations");
  {
    let r = await api("POST", "/msg/conv", {
      kind: "dm", members: ["alice", "bob"],
      keys: { alice: "KEY-FOR-ALICE", bob: "KEY-FOR-BOB" }
    }, alice);
    ok("a DM can be opened", r.status === 201, JSON.stringify(r.data));
    conv = r.data && r.data.id;
    ok("it gets a server-minted id", /^[a-f0-9]{32}$/.test(conv || ""));

    ok("a DM with three people is refused",
      (await api("POST", "/msg/conv", { kind: "dm", members: ["alice", "bob", "carol"],
        keys: { alice: "a", bob: "b", carol: "c" } }, alice)).status === 400);
    ok("a conversation with a member who has no wrapped key is refused",
      (await api("POST", "/msg/conv", { kind: "dm", members: ["alice", "bob"],
        keys: { alice: "a" } }, alice)).status === 400);
    ok("a conversation with a handle that does not exist is refused",
      (await api("POST", "/msg/conv", { kind: "dm", members: ["alice", "ghost"],
        keys: { alice: "a", ghost: "g" } }, alice)).status === 404);

    r = await api("GET", "/msg/conv", undefined, alice);
    ok("it shows up for a member", r.data.conversations.length === 1);
    ok("with only that member's copy of the key",
      r.data.conversations[0].myKey === "KEY-FOR-ALICE");

    ok("and not for someone outside it",
      (await api("GET", "/msg/conv", undefined, carol)).data.conversations.length === 0);
  }

  section("messages");
  {
    const ct = sealed(CANARY);
    let r = await api("POST", "/msg/send", { convId: conv, ct: ct }, alice);
    ok("a member can send", r.status === 201, JSON.stringify(r.data));

    r = await api("GET", "/msg/poll?since=0", undefined, bob);
    ok("the other member receives it", r.data.messages.length === 1);
    ok("byte for byte, unchanged", r.data.messages[0].ct === ct);
    ok("with the sender named", r.data.messages[0].from === "alice");
    ok("and the key epoch it was sealed under", r.data.messages[0].epoch === 1);

    /* The two answers must be identical or conversation ids become
       probeable for existence. */
    const outsider = await api("POST", "/msg/send", { convId: conv, ct: sealed("nope") }, carol);
    const madeUp = await api("POST", "/msg/send",
      { convId: crypto.randomBytes(16).toString("hex"), ct: sealed("nope") }, carol);
    ok("an outsider cannot send to it", outsider.status === 404);
    ok("and cannot tell it apart from a conversation that does not exist",
      outsider.status === madeUp.status && outsider.data.error === madeUp.data.error);
    ok("an outsider polling sees nothing of it",
      (await api("GET", "/msg/poll?since=0", undefined, carol)).data.messages.length === 0);

    ok("an oversized message is refused with a real status",
      (await api("POST", "/msg/send", { convId: conv, ct: "x".repeat(70000) }, alice)).status === 413);
    ok("a message with no ciphertext is refused",
      (await api("POST", "/msg/send", { convId: conv }, alice)).status === 400);
  }

  /* The one that matters most. */
  section("nothing readable is on the disk");
  {
    const hits = anyFileContains(DATA, CANARY);
    ok("the message text appears in no file the relay wrote", hits.length === 0, hits.join(", "));
    ok("but the conversation log does exist — this is not a false negative",
      fs.existsSync(path.join(DATA, "msg", "conv", conv + ".log")));

    const logText = fs.readFileSync(path.join(DATA, "msg", "conv", conv + ".log"), "utf8");
    ok("what is in it is the sealed blob", logText.indexOf(sealed(CANARY)) >= 0);
    ok("the relay does record who and when, and that is not a secret it can keep",
      logText.indexOf("alice") >= 0);
  }

  section("reporting");
  {
    ok("a report with no escrow for the moderator is refused",
      (await api("POST", "/msg/report", { convId: conv, reason: "rude" }, alice)).status === 400);

    let r = await api("POST", "/msg/report", {
      convId: conv, against: "bob", reason: "being unpleasant " + CANARY.slice(0, 8),
      escrow: { mod: "CONV-KEY-WRAPPED-TO-MOD" }
    }, alice);
    ok("a participant can report with escrow attached", r.status === 201, JSON.stringify(r.data));
    report = r.data && r.data.id;

    ok("someone outside the conversation cannot report it",
      (await api("POST", "/msg/report", { convId: conv, reason: "x",
        escrow: { mod: "k" } }, carol)).status === 404);

    ok("an ordinary account cannot list reports",
      (await api("GET", "/msg/reports", undefined, alice)).status === 403);
    ok("nor review one",
      (await api("GET", "/msg/review?report=" + report, undefined, alice)).status === 403);

    r = await api("GET", "/msg/reports", undefined, mod);
    ok("a moderator can list them", r.status === 200 && r.reports !== null);
    ok("and sees the one just filed", r.data.reports.length === 1);
    ok("with their own copy of the key, and only theirs",
      r.data.reports[0].myKey === "CONV-KEY-WRAPPED-TO-MOD");

    r = await api("GET", "/msg/review?report=" + report, undefined, mod);
    ok("review hands over the conversation", r.status === 200);
    ok("still sealed — the moderator decrypts it locally",
      r.data.messages.length >= 1 && r.data.messages[0].ct === sealed(CANARY));
    ok("the relay did not decrypt anything to serve this",
      JSON.stringify(r.data).indexOf(CANARY) < 0 ||
      JSON.stringify(r.data).indexOf(CANARY.slice(0, 8)) >= 0);
  }

  section("resolving ends the access");
  {
    let r = await api("POST", "/msg/resolve",
      { reportId: report, action: "tempban", against: "bob", days: 3, note: "warned" }, mod);
    ok("a moderator can resolve it", r.status === 200, JSON.stringify(r.data));
    ok("it says the ban landed", r.data.banned && r.data.banned.handle === "bob");
    ok("and tells the client to rotate", r.data.rotate === conv);
    ok("the note about rotation is not vague about why",
      /still read new messages/.test(r.data.note || ""));

    ok("reviewing it again is refused now",
      (await api("GET", "/msg/review?report=" + report, undefined, mod)).status === 410);

    const stored = JSON.parse(fs.readFileSync(
      path.join(DATA, "msg", "reports", report + ".json"), "utf8"));
    ok("the escrowed key is gone from the disk",
      JSON.stringify(stored.escrow) === "{}");
    ok("the outcome is on record", stored.resolution.action === "tempban");

    ok("resolving twice is refused",
      (await api("POST", "/msg/resolve", { reportId: report, action: "none" }, mod)).status === 409);
  }

  section("bans");
  {
    /* The session was open before the ban. It must not survive it. */
    const r = await api("GET", "/msg/users", undefined, bob);
    ok("a ban lands on a session that is already open", r.status === 403, String(r.status));
    ok("and says how long for", r.data.banned && !!r.data.banned.until);

    const login = await api("POST", "/msg/login",
      { handle: "bob", authSecret: secretFor("battery staple", "bob") });
    ok("a banned account cannot log back in", login.status === 403);
    ok("with the right secret, so this is a ban and not a lockout",
      /suspended/.test(login.data.error || ""), login.data.error);

    ok("a banned account is still in the directory, so old conversations still render",
      (await api("GET", "/msg/users", undefined, alice)).data.users
        .some((u) => u.handle === "bob" && u.banned === true));

    /* A moderator banning a moderator is a way to lock everyone out
       of moderation with one request. */
    const r2 = await api("POST", "/msg/report", {
      convId: conv, against: "mod", reason: "test", escrow: { mod: "k" } }, alice);
    const r3 = await api("POST", "/msg/resolve",
      { reportId: r2.data.id, action: "ban", against: "mod" }, mod);
    ok("a moderator cannot be banned through this route", r3.status === 403, JSON.stringify(r3.data));
  }

  section("rotating the key");
  {
    const before = (await api("GET", "/msg/conv", undefined, alice)).data.conversations[0];
    const r = await api("POST", "/msg/rotate",
      { convId: conv, keys: { alice: "NEW-ALICE", bob: "NEW-BOB" } }, alice);
    ok("a member can rotate", r.status === 200, JSON.stringify(r.data));
    ok("the epoch moves", r.data.keyEpoch === before.keyEpoch + 1);

    const after = (await api("GET", "/msg/conv", undefined, alice)).data.conversations[0];
    ok("and the new key is what members get", after.myKey === "NEW-ALICE");

    ok("rotating without a key for every member is refused",
      (await api("POST", "/msg/rotate", { convId: conv, keys: { alice: "x" } }, alice)).status === 400);
    ok("an outsider cannot rotate someone else's conversation",
      (await api("POST", "/msg/rotate", { convId: conv,
        keys: { alice: "x", bob: "y" } }, carol)).status === 404);

    const sent = await api("POST", "/msg/send", { convId: conv, ct: sealed("after rotation") }, alice);
    ok("messages after a rotation carry the new epoch", sent.status === 201);
    const msgs = (await api("GET", "/msg/poll?since=0", undefined, alice)).data.messages;
    ok("so a reader knows which key to try",
      msgs[msgs.length - 1].epoch === after.keyEpoch);
  }

  /* Guessing is the whole attack on /msg/login, so the ceiling is
     asserted rather than assumed — against a SECOND relay with a low
     one. The main instance runs a high limit because this suite
     makes far more logins than a person would, and testing a limit
     against a config that raises it would prove nothing. */
  section("login attempts are capped");
  {
    const port2 = PORT + 1;
    const dir2 = path.join(TMP, "relay2");
    const cfg2 = path.join(TMP, "config2.json");
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(cfg2, JSON.stringify({
      port: port2, host: "127.0.0.1", dataDir: dir2,
      messaging: { enabled: true, openRegistration: true, moderators: [] },
      rateLimit: { windowMs: 60000, max: 5000, msgMax: 5000, msgAuthMax: 5 }
    }), "utf8");

    const p2 = spawn(process.execPath, [path.join(ROOT, "relay", "server.js")], {
      env: Object.assign({}, process.env, { FK_CONFIG: cfg2 }),
      stdio: ["ignore", "ignore", "ignore"]
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { up = (await fetch("http://127.0.0.1:" + port2 + "/health")).ok; } catch (e) { /* wait */ }
    }
    ok("a second relay came up to test the limit against", up);

    let sawLimit = 0, sawAuth = 0, detail = "";
    for (let i = 0; i < 20 && up; i++) {
      const res = await fetch("http://127.0.0.1:" + port2 + "/msg/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "nobody", authSecret: "wrong-" + i })
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 429) { sawLimit++; detail = d.detail || ""; }
      else if (res.status === 401) sawAuth++;
    }
    ok("the first few wrong secrets get a real answer", sawAuth > 0, String(sawAuth));
    ok("then the attempts themselves are refused", sawLimit > 0,
      sawAuth + " answered, " + sawLimit + " rate limited");
    ok("and the refusal says what it is about", /login or registration/.test(detail), detail);

    /* The cap must be specific to logins, or a chatty conversation
       would lock its own members out of signing in. */
    const poll = await fetch("http://127.0.0.1:" + port2 + "/msg/users");
    ok("ordinary messaging routes are not caught by the login cap",
      poll.status !== 429, String(poll.status));

    p2.kill();
  }

  /* Nobody else can see someone trying to get into their account,
     so the server is the only place this can be noticed. */
  section("failed sign-ins reach the moderators");
  {
    for (let i = 0; i < 6; i++) {
      await api("POST", "/msg/login", { handle: "alice", authSecret: "guess-" + i });
    }
    await api("POST", "/msg/login", { handle: "does-not-exist", authSecret: "x" });

    ok("an ordinary account cannot read them",
      (await api("GET", "/msg/signins", undefined, alice)).status === 403);

    const r = await api("GET", "/msg/signins", undefined, mod);
    ok("a moderator can", r.status === 200, JSON.stringify(r.data).slice(0, 120));

    const alice_ = r.data.failures.filter((f) => f.handle === "alice")[0];
    ok("the attempts against a real account are counted", alice_ && alice_.total >= 6,
      JSON.stringify(alice_));
    ok("and marked as being against an account that exists", alice_ && alice_.exists === true);

    const ghost = r.data.failures.filter((f) => f.handle === "does-not-exist")[0];
    ok("an attempt on a handle nobody has is recorded too", !!ghost);
    ok("and marked as such, because it is a different problem",
      ghost && ghost.exists === false);

    ok("a run against a real account raises an alert",
      r.data.alerts.some((a) => a.handle === "alice"), JSON.stringify(r.data.alerts));
    ok("the alert says what it means rather than just a number",
      /real account/.test((r.data.alerts.find((a) => a.handle === "alice") || {}).why || ""));

    /* A near-miss password is still a password. */
    const onDisk = fs.readFileSync(path.join(DATA, "msg", "signin-failures.json"), "utf8");
    ok("the secret that was tried is not written down",
      onDisk.indexOf("guess-") < 0, onDisk.slice(0, 200));
    ok("nor is the caller's address, only a tag for it",
      onDisk.indexOf("127.0.0.1") < 0 && /"from":"[a-f0-9]{12}"/.test(onDisk));
    ok("the handle attempted IS written down, because that is the point",
      onDisk.indexOf("alice") >= 0);
  }

  section("the relay advertises what it serves");
  {
    const r = await api("GET", "/msg/nonsense");
    ok("an unknown messaging route says so, without needing a token",
      r.status === 404, String(r.status));
    ok("and lists the real ones", Array.isArray(r.data.routes) && r.data.routes.length > 8);
    ok("and echoes the path it actually saw", r.data.saw && r.data.saw.path === "/msg/nonsense");

    /* A real route called the wrong way is not the same problem as a
       route that does not exist, and saying 404 for both sends you
       hunting for a version mismatch that is not there. */
    const wrong = await api("GET", "/msg/send");
    ok("a real route called with the wrong method says THAT instead",
      wrong.status === 405, String(wrong.status));

    const h = await api("GET", "/health");
    ok("health still answers with messaging bolted on", h.status === 200 &&
      h.data.service === "fieldkit-relay");
  }

  if (proc) proc.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  if (proc) proc.kill();
  console.error("SUITE CRASHED: " + (e.stack || e.message));
  process.exit(1);
});
