/* ============================================================
   Tiers, approval and admins made in the app (RUNNER_PLAN.md §4a,
   §8a) — against a real relay process, like messaging.test.js.

   The assertions that matter, in order:

     1. A new account is a guest, and only an admin can change that.
     2. Any admin can make an admin. Only one named in config.json
        can unmake one, and nothing in the app can touch a root.
     3. An admin made here really is one: reports must be sealed to
        them, and they can open the moderation routes.
     4. Demoting takes away the escrowed keys they already held.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { ROOT, makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("roles");

const PORT = 25673;
const BASE = "http://127.0.0.1:" + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-roles-"));
const DATA = path.join(TMP, "data");
const CONFIG = path.join(TMP, "config.json");

let proc = null;

async function startRelay(messaging) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({
    port: PORT, host: "127.0.0.1", dataDir: DATA,
    provisionToken: "test-provision-token",
    messaging: Object.assign({ enabled: true, openRegistration: true,
      moderators: ["owner"] }, messaging || {}),
    rateLimit: { windowMs: 60000, max: 5000, msgMax: 5000, msgAuthMax: 500 }
  }, null, 1), "utf8");
  proc = spawn(process.execPath, [path.join(ROOT, "relay", "server.js")], {
    env: Object.assign({}, process.env, { FK_CONFIG: CONFIG }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  proc.stdout.on("data", (c) => { out += c; });
  proc.stderr.on("data", (c) => { out += c; });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { if ((await fetch(BASE + "/health")).ok) return out; } catch (e) { /* not up yet */ }
  }
  throw new Error("relay did not come up in 10s:\n" + out);
}

function stopRelay() {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    proc.once("exit", () => resolve());
    proc.kill();
    proc = null;
  });
}

async function api(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + p, { method: method, headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
  return { status: res.status, data: data };
}

const mk = (handle) => api("POST", "/msg/register", {
  handle: handle, authSecret: "secret-" + handle,
  pubKey: "PUB-" + handle, wrappedPrivKey: "WRAPPED-" + handle });
const login = (handle) => api("POST", "/msg/login",
  { handle: handle, authSecret: "secret-" + handle });
const role = (token, handle, action) =>
  api("POST", "/msg/role", { handle: handle, action: action }, token);
const tierOf = async (token, handle) =>
  ((await api("GET", "/msg/people", undefined, token)).data.people
    .filter((p) => p.handle === handle)[0] || {}).tier;

(async function () {
  await startRelay();
  let owner, ann, ben, cy;

  section("a new account is a guest until somebody vouches for it");
  {
    let r = await mk("owner");
    owner = r.data.token;
    ok("the admin named in config.json is an admin from the start",
      r.data.tier === "admin" && r.data.root === true, JSON.stringify(r.data));
    r = await mk("ann"); ann = r.data.token;
    ok("anybody else registers as a guest", r.data.tier === "guest", r.data.tier);
    ben = (await mk("ben")).data.token;
    cy = (await mk("cyd")).data.token;

    ok("a guest can still sign in and use messaging",
      (await api("GET", "/msg/users", undefined, ann)).status === 200);
    ok("the directory tells a guest their own tier",
      (await api("GET", "/msg/users", undefined, ann)).data.tier === "guest");
    ok("a guest cannot see the people list",
      (await api("GET", "/msg/people", undefined, ann)).status === 403);
    ok("a guest cannot approve anybody, themselves included",
      (await role(ann, "ann", "approve")).status === 403 &&
      (await role(ann, "ben", "approve")).status === 403);
  }

  section("approval");
  {
    const r = await role(owner, "ann", "approve");
    ok("an admin approves a guest and they become a member",
      r.status === 200 && r.data.tier === "member", JSON.stringify(r.data));
    ok("it lands on a session that was already open",
      (await api("GET", "/msg/users", undefined, ann)).data.tier === "member");
    ok("and at the next sign-in", (await login("ann")).data.tier === "member");
    ok("a member is still not an admin",
      (await api("GET", "/msg/people", undefined, ann)).status === 403);
    ok("approval can be taken back",
      (await role(owner, "ann", "unapprove")).data.tier === "guest");
    await role(owner, "ann", "approve");

    ok("an action nobody defined is refused",
      (await role(owner, "ann", "crown")).status === 400);
    ok("a handle that does not exist is refused",
      (await role(owner, "nobody-here", "approve")).status === 404);
  }

  section("admins made in the app");
  {
    const r = await role(owner, "ann", "promote");
    ok("an admin makes another admin, with no config file involved",
      r.status === 200 && r.data.tier === "admin", JSON.stringify(r.data));
    const l = await login("ann");
    ok("the new admin is told so, and told they are not a root",
      l.data.moderator === true && l.data.root === false);
    ok("the moderation routes open for them",
      (await api("GET", "/msg/reports", undefined, ann)).status === 200);
    const dir = (await api("GET", "/msg/users", undefined, ben)).data;
    ok("reports will now be sealed to them as well",
      dir.moderators.indexOf("ann") >= 0 && dir.moderators.indexOf("owner") >= 0,
      JSON.stringify(dir.moderators));

    ok("an admin made here can approve people",
      (await role(ann, "ben", "approve")).data.tier === "member");
    ok("and can make further admins — nobody needs the panel",
      (await role(ann, "ben", "promote")).data.tier === "admin");
    ok("promoting a guest approves them on the way",
      (await role(ann, "cyd", "promote")).data.tier === "admin");
  }

  section("what an admin made in the app cannot do");
  {
    let r = await role(ann, "ben", "demote");
    ok("they cannot unmake another admin", r.status === 403, JSON.stringify(r.data));
    r = await role(ann, "owner", "demote");
    ok("they cannot touch the one named in config.json", r.status === 403);
    r = await role(owner, "owner", "demote");
    ok("nobody changes their own role, the owner included", r.status === 403);
    r = await role(ann, "ann", "unapprove");
    ok("nor theirs", r.status === 403);
    r = await role(owner, "ben", "unapprove");
    ok("an admin has to be demoted before approval can be withdrawn", r.status === 409);
    ok("after all of that everybody is what they were",
      await tierOf(owner, "ben") === "admin" && await tierOf(owner, "owner") === "admin");
  }

  section("taking admin away");
  {
    const dee = (await mk("dee")).data.token;
    const conv = (await api("POST", "/msg/conv", { kind: "dm", members: ["dee", "cyd"],
      keys: { dee: "K-dee", cyd: "K-cyd" } }, dee)).data.id;

    const short = await api("POST", "/msg/report", { convId: conv, against: "cyd",
      reason: "x", escrow: { owner: "E-owner" } }, dee);
    ok("a report that leaves out an admin made in the app is refused",
      short.status === 400 && /ann/.test(short.data.error), JSON.stringify(short.data));

    const rep = await api("POST", "/msg/report", { convId: conv, against: "cyd", reason: "x",
      escrow: { owner: "E-owner", ann: "E-ann", ben: "E-ben", cyd: "E-cyd" } }, dee);
    ok("sealed to every admin, it is accepted", rep.status === 201, JSON.stringify(rep.data));
    const file = path.join(DATA, "msg", "reports", rep.data.id + ".json");

    let r = await api("POST", "/msg/resolve",
      { reportId: rep.data.id, action: "ban", against: "ben" }, owner);
    ok("an admin cannot be banned while they are one",
      r.status === 403 && /demote/.test(r.data.detail), JSON.stringify(r.data));

    r = await role(owner, "cyd", "demote");
    ok("the admin named in config.json can take admin away",
      r.status === 200 && r.data.tier === "member", JSON.stringify(r.data));
    ok("the moderation routes close on a session that was already open",
      (await api("GET", "/msg/reports", undefined, cy)).status === 403);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    ok("their copy of the escrowed key is destroyed",
      !onDisk.escrow.cyd && onDisk.escrow.owner === "E-owner" && onDisk.escrow.ann === "E-ann",
      JSON.stringify(Object.keys(onDisk.escrow)));
    ok("and reports are no longer sealed to them",
      (await api("GET", "/msg/users", undefined, dee)).data.moderators.indexOf("cyd") < 0);
    ok("demoting somebody who is not an admin says so",
      (await role(owner, "cyd", "demote")).status === 409);

    r = await api("POST", "/msg/resolve",
      { reportId: rep.data.id, action: "ban", against: "cyd" }, owner);
    ok("once demoted they can be banned like anybody else", r.status === 200);
    ok("and a banned account cannot be approved or promoted",
      (await role(owner, "cyd", "promote")).status === 409);
  }

  section("it is written down, and it survives a restart");
  {
    const p = (await api("GET", "/msg/people", undefined, owner)).data;
    ok("every change is in the audit log with who made it",
      p.audit.some((a) => a.action === "promote" && a.by === "ann" && a.target === "ben") &&
      p.audit.some((a) => a.action === "demote" && a.by === "owner" && a.target === "cyd"),
      JSON.stringify(p.audit.slice(0, 3)));
    ok("newest first", p.audit[0].at >= p.audit[p.audit.length - 1].at);

    await stopRelay();
    await startRelay();
    const o = (await login("owner")).data.token;
    ok("an admin made in the app is still one after a restart",
      await tierOf(o, "ann") === "admin" && await tierOf(o, "ben") === "admin");
    ok("and a guest is still a guest", await tierOf(o, "dee") === "guest");
  }

  section("a relay that does not want approval");
  {
    await stopRelay();
    await startRelay({ requireApproval: false });
    const o = (await login("owner")).data.token;
    ok("everybody who is not an admin is a member", await tierOf(o, "dee") === "member");
    ok("a new account is a member straight away", (await mk("eve")).data.tier === "member");
  }

  await stopRelay();
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
