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
const { makeZip } = require("./runner-kit");

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
const dialed = [];
/* The relay's address HANGS: it neither opens nor refuses, as on a
   network that drops packets (and as relay.test did on GitHub's
   machines). The panel must give up on it and try the next. */
const hung = [];
global.window.WebSocket = class extends WebSocket {
  constructor(u) {
    dialed.push(String(u));
    if (/relay\.test/.test(String(u))) { const s = { closed: false, send() {}, close() { s.closed = true; } }; hung.push(s); return s; }
    super(u);
  }
};
global.window.confirm = () => true;
global.window.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((ab) => { this.result = ab; this.onload(); }, () => this.onerror());
  }
};
FieldKit.provide("messages", {
  signedIn: () => signedIn,
  /* The relay passes RUNNER through (viaRelay), so its own address comes
     first; here neither it nor the run server's first address answers
     (blocked, say), and the panel tries the next. */
  runnerTicket: async () => ({ viaRelay: true, url: "http://127.0.0.1:1", urls: ["http://127.0.0.1:1", "http://127.0.0.1:" + port], tier: tier,
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
/* Each row's arguments and DELETE are under its ⋯; this opens them all. */
const openRows = () => {
  for (let i = 0; i < 50; i++) {
    const shut = byClass("rn-more").find((n) => !String(n.className).split(/\s+/).includes("open"));
    if (!shut) return;
    fire(shut, "click");
  }
};
const del = () => { openRows(); fire(button("DELETE"), "click"); };
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

  section("a guest: upload, run, and what happens on the way out");
  {
    signedIn = true; tier = "guest";
    remount();
    const t0 = Date.now();
    await until(() => byClass("rn-drop").length === 1, 30000);
    ok("the drop area appears once connected, through the run server's second address: the first answers nothing (FIELDKIT_PROJECT.md §14.39)",
      byClass("rn-drop").length === 1);
    ok("an address that hangs is given up on after a few seconds, and closed",
      hung.length >= 1 && hung[0].closed && Date.now() - t0 < 15000, (Date.now() - t0) + " ms");
    ok("the relay's own address was tried first (RUNNER through the relay)", dialed[0] && dialed[0].indexOf("ws://relay.test/runner/attach?t=") === 0 &&
      dialed[1].indexOf("ws://127.0.0.1:1/attach") === 0, dialed.slice(0, 3).join(" "));
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

    ok("a row shows RUN and keeps its arguments under ⋯", !!button("RUN") && byClass("rn-args").length === 0 &&
      byClass("rn-more").length === 1);
    openRows();
    const args = byClass("rn-args")[0];
    ok("⋯ opens the arguments field", !!args);
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
    del();
    await until(() => byClass("rn-file").length === 0);
    ok("DELETE removes it", byClass("rn-file").length === 0 && /NO FILES YET/.test(text()));

    /* What a running program is using, in its row. */
    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File(["setTimeout(() => console.log('slow done'), 1500)"], "slow.js")] } });
    await until(() => byClass("rn-file").length === 1);
    fire(button("RUN"), "click");
    await until(() => app._internals.jobs.size === 1 && /RUNNING slow.js/.test(text()));
    const jid = Array.from(app._internals.jobs.keys())[0];
    app._internals.driver.fakeStats = { [jid]: { cpu: 0.5, memMb: 30 } };
    await app._internals.sampleUse();
    await until(() => /0\.50 core · 30 MB of 2048 MB/.test(text()));
    ok("a running program's row says what it is using", /0\.50 core · 30 MB of 2048 MB/.test(text()), text().slice(0, 300));
    await until(() => /slow done/.test(text()) && app._internals.jobs.size === 0, 5000);
    app._internals.driver.fakeStats = null;
    del();
    await until(() => byClass("rn-file").length === 0);

    /* A program that is a folder, zipped. */
    const two = makeZip([{ name: "a/one.js", data: "console.log('one ran')" },
      { name: "b/two.js", data: "console.log('two ran in ' + require('path').basename(process.cwd()))" },
      { name: "b/data.txt", data: "x" }]);
    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File([two], "pair.zip")] } });
    await until(() => byClass("rn-file").length === 1);
    ok("a .zip is taken", /pair\.zip/.test(text()), text().slice(0, 200));
    fire(button("RUN"), "click");
    await until(() => byClass("rn-zip").length === 1);
    ok("RUN on a zip with two programs asks which", /Which file inside pair\.zip should run\?/.test(text()) &&
      !!button("a/one.js") && !!button("b/two.js"), text().slice(-300));
    fire(button("b/two.js"), "click");
    await until(() => /two ran in b/.test(text()));
    ok("choosing one runs it, from its own folder", /two ran in b/.test(text()), text().slice(-200));
    ok("and the question goes away", byClass("rn-zip").length === 0);
    fire(button("RUN"), "click");
    await until(() => byClass("rn-zip").length === 1);
    const firstPick = byClass("rn-zip")[0] && all(byClass("rn-zip")[0]).find((n) => n.tagName === "BUTTON");
    ok("next time the last choice comes first", firstPick && firstPick.textContent === "b/two.js");
    fire(button("CANCEL"), "click");
    await until(() => byClass("rn-zip").length === 0);
    ok("CANCEL puts the question away", byClass("rn-zip").length === 0);
    del();
    await until(() => byClass("rn-file").length === 0);

    const one = makeZip([{ name: "tool/go.js", data: "console.log('only one')" }, { name: "tool/x.dat", data: "1" }]);
    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File([one], "one.zip")] } });
    await until(() => byClass("rn-file").length === 1);
    fire(button("RUN"), "click");
    await until(() => /only one/.test(text()));
    ok("a zip with one program in it just runs", /only one/.test(text()) && byClass("rn-zip").length === 0);
    const empty = makeZip([{ name: "notes.txt", data: "hi" }]);
    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File([empty], "notes.zip")] } });
    await until(() => byClass("rn-file").length === 2);
    const row = byClass("rn-file").find((r) => /notes\.zip/.test(r.textContent || all(r).map((n) => n.textContent).join(" ")));
    const toasts = [];
    const realToast = ui.toast;
    ui.toast = (m) => { toasts.push(m); };
    fire(all(row).find((n) => n.tagName === "BUTTON" && n.textContent === "RUN"), "click");
    await until(() => toasts.length > 0);
    ui.toast = realToast;
    ok("one with nothing runnable says so", /NOTHING IN NOTES\.ZIP/.test(toasts.join(" ")), toasts.join(" "));
    openRows();
    for (const b of all(host).filter((n) => n.tagName === "BUTTON" && n.textContent === "DELETE")) fire(b, "click");
    await until(() => byClass("rn-file").length === 0);

    /* An admin's ADMIN screen draws: power and the line, and no sleeping. */
    tier = "admin";
    remount();
    await until(() => !!button("ADMIN"));
    fire(button("ADMIN"), "click");
    await until(() => /LOAD AND THE LINE/.test(text()));
    ok("ADMIN shows POWER and the line, and nothing about sleeping", /POWER/.test(text()) && !/SLEEP/.test(text()) &&
      /LOAD AND THE LINE/.test(text()), text().slice(0, 200));
    /* A library title gets a card, and members get a START for it. */
    fire(button("BACK"), "click");
    await until(() => byClass("rn-drop").length === 1);
    fire(byClass("rn-drop")[0], "drop", { dataTransfer: { files: [new File(["console.log('took off with ' + process.argv.slice(2).join(' '))"], "rocket.js")] } });
    await until(() => byClass("rn-file").length === 1);
    const mine = app.store.list({ kind: "user", handle: "tester" })[0];
    app.store.pin("tester", mine.id, "tester");
    fire(button("ADMIN"), "click");
    await until(() => !!button("CARD"));
    ok("each library title in ADMIN has a CARD button", !!button("CARD"));
    fire(button("CARD"), "click");
    await until(() => byClass("rn-card-in").length === 4);
    const [cTitle, cAbout, cArgs, cEntry] = byClass("rn-card-in");
    ok("the form asks for a title, a line about it and arguments; the file inside only for a zip",
      !!cTitle && !!cAbout && !!cArgs && cEntry.disabled === true);
    cTitle.value = "Rocket"; cAbout.value = "A small test of taking off."; cArgs.value = "at dawn";
    fire(button("SAVE CARD"), "click");
    await until(() => /Rocket = rocket\.js/.test(text()));
    ok("saving shows the title in ADMIN", /Rocket = rocket\.js/.test(text()), text().slice(-400));
    fire(button("BACK"), "click");
    await until(() => !!button("START"));
    ok("members see the title, the line about it, and START", !!button("START") && /Rocket/.test(text()) &&
      /A small test of taking off\./.test(text()), text().slice(0, 400));
    fire(button("START"), "click");
    await until(() => /took off with at dawn/.test(text()));
    ok("START runs it with the card's arguments", /took off with at dawn/.test(text()), text().slice(-200));
    await until(() => /finished with code 0/.test(text()));
    app.store.libRemove(mine.id, "tester");
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
