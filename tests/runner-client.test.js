/* ============================================================
   modules/runner.js — the panel, driven the way a person drives
   it, against a REAL run server.

   tests/runner.test.js proves the server. This proves the two fit:
   the panel's own upload code hashes a file, sends it, and the real
   runnerd accepts the hash; the RUN button produces output on the
   screen. A stub server would only prove the panel agrees with the
   stub.

   The run server uses the unsandboxed test driver, as in the other
   suite. The relay is two stubs: a status answer and a ticket.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "modules/runner.js"]);
const runnerd = require("../runnerd/server");
const ticket = require("../runnerd/ticket");

const { ok, section, state } = makeRunner("runner-client");
const settings = FieldKit.need("settings");
const ui = FieldKit.need("ui");
const def = FieldKit.modules().runner;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-client-"));
const pair = crypto.generateKeyPairSync("ed25519");

/* ---- the world the panel sees ---- */
let relayStatus = { enabled: true, online: false, why: "the run server is offline" };
let statusCalls = 0, signedIn = false, tier = "guest", port = 0;

global.window.fetch = async (url) => {
  if (/\/runner\/status$/.test(url)) {
    statusCalls++;
    return { status: 200, ok: true, text: async () => JSON.stringify(relayStatus) };
  }
  throw new Error("the panel fetched something unexpected: " + url);
};
global.window.WebSocket = WebSocket;
global.window.confirm = () => true;
global.window.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((ab) => { this.result = ab; this.onload(); }, () => this.onerror());
  }
};
let wakes = 0, wakeAnswer = () => ({ waking: true });
FieldKit.provide("messages", {
  signedIn: () => signedIn,
  runnerWake: async () => { wakes++; const a = wakeAnswer(); if (a instanceof Error) throw a; return a; },
  runnerTicket: async () => ({ url: "http://127.0.0.1:" + port, tier: tier,
    ticket: ticket.sign(pair.privateKey, { handle: "tester", tier: tier, exp: Date.now() + 30000 }) })
});

const ctx = { settings, ui, log() {}, warn() {}, error() {}, on() {}, emit() {}, version: "test", store: null };
let host = fakeElement("div");

function all(node) {
  const out = [];
  (function walk(n) {
    (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } });
  })(node);
  return out;
}
const text = () => all(host).map((n) => n.textContent || "").join(" | ");
const button = (label) => all(host).find((n) => n.tagName === "BUTTON" && n.textContent === label) || null;
const byClass = (c) => all(host).filter((n) => String(n.className || "").split(/\s+/).includes(c));
async function until(fn, ms) {
  const stop = Date.now() + (ms || 8000);
  while (Date.now() < stop) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}
const fire = (node, type, extra) => node.dispatchEvent(Object.assign({ type, preventDefault() {}, stopPropagation() {} }, extra || {}));
const remount = () => { def.unmount(); host = fakeElement("div"); def.mount(host, ctx); };

(async () => {
  const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
    storePath: path.join(TMP, "store"), driver: "process", dev: true,
    ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
    tiers: { guest: { maxFileBytes: 2000 } } }), () => {});
  port = await app.listen();
  settings.set("relayUrl", "http://relay.test");

  section("the module declares itself honestly");
  {
    ok("it registered", !!def && def.title === "RUNNER");
    ok("it is not offered to the full build's guest mode", def.guestSafe === false);
    const checks = def.selfcheck();
    let bad = [];
    for (const c of checks) { try { await c.run(); } catch (e) { bad.push(c.name + ": " + e.message); } }
    ok("all " + checks.length + " of its own selfchecks pass", bad.length === 0, bad.join("; "));
  }

  section("when the run server is away");
  {
    def.mount(host, ctx);
    await until(() => /OFFLINE/.test(text()));
    ok("it says so in words", /THE RUN SERVER IS OFFLINE/.test(text()), text().slice(0, 200));
    ok("and says nothing can be uploaded", /Nothing can be uploaded or run/.test(text()));
    ok("there is no drop area to drop a file on", byClass("rn-drop").length === 0);
    ok("there is a button to check again", !!button("CHECK AGAIN"));
    const before = statusCalls;
    await new Promise((r) => setTimeout(r, 300));
    ok("it does not hammer the relay while it waits", statusCalls === before, String(statusCalls - before));

    relayStatus = { enabled: false, online: false, why: "RUNNER is switched off on this relay" };
    fire(button("CHECK AGAIN"), "click");
    await until(() => /NOT AVAILABLE/.test(text()));
    ok("a relay with RUNNER switched off says that instead", /switched off on this relay/.test(text()));
  }

  section("without an account");
  {
    relayStatus = { enabled: true, online: true, ready: true };
    signedIn = false;
    remount();
    await until(() => /SIGN IN TO USE RUNNER/.test(text()));
    ok("it asks for a MESSAGES account, and says why", /limits and saved files are per person/.test(text()));
    ok("and does not connect to anything", app._internals.sessions.size === 0);
  }

  section("when the run server is asleep");
  {
    relayStatus = { enabled: true, online: false, asleep: true, wakeable: true, why: "the run server is asleep to save power" };
    signedIn = false;
    remount();
    await until(() => /ASLEEP/.test(text()));
    ok("signed out: it says it is asleep, and to sign in to wake it", /THE RUN SERVER IS ASLEEP/.test(text()) &&
      /Sign in to MESSAGES to wake it/.test(text()) && wakes === 0, text().slice(0, 300));
    signedIn = true; tier = "member";
    remount();
    await until(() => /WAKING THE RUN SERVER/.test(text()));
    ok("signed in: opening RUNNER wakes it, once", wakes === 1, String(wakes));
    ok("and says how long that takes", /20 to 40 seconds/.test(text()));
    relayStatus = { enabled: true, online: true, ready: true };
    await until(() => byClass("rn-drop").length === 1, 9000);
    ok("once it answers, it connects as usual", byClass("rn-drop").length === 1 && wakes === 1);

    relayStatus = { enabled: true, online: false, asleep: true, wakeable: true, why: "the run server is asleep to save power",
      quiet: { from: 1, to: 7, tz: "UTC" } };
    remount();
    await until(() => /ASLEEP/.test(text()));
    ok("in quiet hours it does not wake it by itself, and says why", wakes === 1 &&
      /stays asleep from 1:00 to 7:00 unless an admin wakes it/.test(text()) && !!button("WAKE IT"), text().slice(0, 300));
    wakeAnswer = () => Object.assign(new Error("only an admin can wake it then"), { status: 403 });
    fire(button("WAKE IT"), "click");
    await until(() => /Not woken/.test(text()));
    ok("a refusal is said in words, with the reason", wakes === 2 && /Not woken: only an admin can wake it then/.test(text()));
    relayStatus = { enabled: true, online: true, ready: true };
    tier = "guest";
  }

  section("a guest: upload, run, and what happens on the way out");
  {
    signedIn = true; tier = "guest";
    remount();
    await until(() => byClass("rn-drop").length === 1);
    ok("the drop area appears once connected", byClass("rn-drop").length === 1);
    ok("the guest is told plainly that nothing is kept",
      /GUEST SANDBOX/.test(text()) && /deleted when you close this panel/.test(text()), text().slice(0, 160));
    ok("and that there is no GPU", /no GPU/.test(text()));

    const drop = byClass("rn-drop")[0];
    const src = "console.log('ran with ' + process.argv.slice(2).join('+'));";
    fire(drop, "drop", { dataTransfer: { files: [new File([src], "hello.js")] } });
    await until(() => byClass("rn-file").length === 1);
    ok("a dropped file is hashed, uploaded and listed", byClass("rn-file").length === 1 &&
      /hello\.js/.test(text()));
    ok("the server agreed with the panel's own hash",
      Array.from(app._internals.sessions.values())[0].owner.files &&
      Object.keys(Array.from(app._internals.sessions.values())[0].owner.files).length === 1);

    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File(["x".repeat(5000)], "big.js")] } });
    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File(["hi"], "notes.docx")] } });
    await new Promise((r) => setTimeout(r, 400));
    ok("a file over the limit, and one it cannot run, never leave the panel",
      byClass("rn-file").length === 1 && fs.readdirSync(path.join(TMP, "store", "tmp")).length === 0);

    const args = byClass("rn-args")[0];
    args.value = "a b";
    fire(button("RUN"), "click");
    await until(() => /ran with a\+b/.test(text()));
    ok("RUN shows the program's output on screen", /ran with a\+b/.test(text()), text().slice(-200));
    await until(() => /finished with code 0/.test(text()));
    ok("and how it ended", /finished with code 0/.test(text()));

    const guests = path.join(TMP, "store", "guests");
    ok("the guest's file is on the server while they are here", fs.readdirSync(guests).length === 1);
    def.unmount();
    await until(() => fs.readdirSync(guests).length === 0, 5000);
    ok("closing the panel deletes it", fs.readdirSync(guests).length === 0);
    ok("and leaves no connection behind", app._internals.sessions.size === 0);
  }

  section("a member");
  {
    tier = "member";
    host = fakeElement("div");
    def.mount(host, ctx);
    await until(() => byClass("rn-drop").length === 1);
    ok("a member is told their files are kept", /MEMBER\. Your files are kept/.test(text()), text().slice(0, 120));
    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File(["console.log(1)"], "keep.js")] } });
    await until(() => byClass("rn-file").length === 1);
    remount();
    await until(() => byClass("rn-file").length === 1);
    ok("and they are, across closing and reopening the panel", /keep\.js/.test(text()));
    fire(button("DELETE"), "click");
    await until(() => byClass("rn-file").length === 0);
    ok("DELETE removes it", byClass("rn-file").length === 0 && /NO FILES YET/.test(text()));

    /* An admin's ADMIN screen draws: power, sleeping, the line. */
    tier = "admin";
    remount();
    await until(() => !!button("ADMIN"));
    fire(button("ADMIN"), "click");
    await until(() => /SLEEP WHEN IDLE/.test(text()));
    ok("ADMIN shows POWER, SLEEP WHEN IDLE and the line", /POWER/.test(text()) && /SLEEP WHEN IDLE/.test(text()) &&
      /LOAD AND THE LINE/.test(text()), text().slice(0, 200));
    ok("with what is missing before it can sleep", /fk-sleep has not reported: rerun setup\.sh/.test(text()) &&
      /wake helper/.test(text()) && /BIOS/.test(text()));
    ok("and says it is awake, and why", /Awake: sleeping when idle is switched off\./.test(text()), text().slice(-600));
    ok("SLEEP NOW is offered", !!button("SLEEP NOW"));
    fire(button("SLEEP NOW"), "click");
    await new Promise((r) => setTimeout(r, 200));
    ok("and without fk-sleep it is refused, so nothing sleeps", !app.sleep.force);
    fire(button("BACK"), "click");
    tier = "member";

    await app.close();
    await until(() => /DISCONNECTED/.test(text()));
    ok("the server going away mid-session is a message with a RECONNECT button, not a crash",
      /DISCONNECTED/.test(text()) && !!button("RECONNECT"));
    def.unmount();
  }

  await new Promise((r) => setTimeout(r, 400));   /* let sockets finish closing (a libuv assert on Windows otherwise) */
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
