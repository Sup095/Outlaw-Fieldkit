/* ============================================================
   modules/messages.js — the client

   tests/messaging.test.js already spawns a real relay and proves
   the server end. This suite proves the half that matters most and
   that no server test can reach: what the CLIENT sends.

   The relay here is a stub that records everything it is handed.
   That is the point — every assertion below is of the form "the
   thing the relay received was sealed / was not the password / was
   openable only by the right person". A test against the real relay
   cannot make those claims, because the real relay is exactly the
   party we are asserting cannot read any of it.

   It is driven through the DOM rather than through exported
   internals, because the module deliberately exports none. Clicking
   the button is the only way in, and it is also the way a user gets
   there, so the path under test is the real one.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js",
  "core/msg-crypto.js", "modules/messages.js"
]);
const { ok, section, state } = makeRunner("messages");

global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
global.atob = (s) => Buffer.from(s, "base64").toString("binary");

const mc = FieldKit.need("msgCrypto");
const settings = FieldKit.need("settings");
const ui = FieldKit.need("ui");

/* ---- the stub relay -------------------------------------------
   Small on purpose. It implements only what the client calls, and
   it keeps every request so the assertions can look at them. */
const relay = {
  users: {}, convs: {}, msgs: [], reports: {}, seq: 0,
  requests: [], moderators: ["mod"]
};

function reply(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

global.window.fetch = function (url, opts) {
  opts = opts || {};
  const u = new URL(String(url));
  const p = u.pathname;
  let body = null;
  if (opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = { raw: opts.body }; } }
  relay.requests.push({ path: p, raw: String(opts.body || ""), body,
    headers: JSON.stringify(opts.headers || {}) });

  const who = String((opts.headers || {}).Authorization || "").replace(/^Bearer /, "");

  if (p === "/msg/register") {
    relay.users[body.handle] = {
      handle: body.handle, displayName: body.displayName || body.handle,
      authSecret: body.authSecret, pubKey: body.pubKey, wrappedPrivKey: body.wrappedPrivKey
    };
    return reply(201, { handle: body.handle, token: "tok-" + body.handle,
      moderator: relay.moderators.indexOf(body.handle) >= 0 });
  }

  if (p === "/msg/login") {
    const u2 = relay.users[body.handle];
    if (!u2 || u2.authSecret !== body.authSecret) return reply(401, { error: "handle or password is wrong" });
    return reply(200, { handle: u2.handle, token: "tok-" + u2.handle, pubKey: u2.pubKey,
      wrappedPrivKey: u2.wrappedPrivKey, displayName: u2.displayName,
      moderator: relay.moderators.indexOf(u2.handle) >= 0 });
  }

  if (p === "/msg/users") {
    return reply(200, {
      users: Object.keys(relay.users).sort().map((h) => ({
        handle: h, displayName: relay.users[h].displayName, pubKey: relay.users[h].pubKey,
        moderator: relay.moderators.indexOf(h) >= 0, banned: false
      })),
      me: who.replace(/^tok-/, ""),
      moderators: relay.moderators.slice()
    });
  }

  const me = who.replace(/^tok-/, "");

  if (p === "/msg/conv" && opts.method === "GET") {
    return reply(200, {
      conversations: Object.keys(relay.convs).map((id) => relay.convs[id])
        .filter((c) => c.members.indexOf(me) >= 0)
        .map((c) => ({ id: c.id, kind: c.kind, name: c.name, members: c.members,
          keyEpoch: c.keyEpoch, myKey: c.keys[me] || null }))
    });
  }

  if (p === "/msg/conv" && opts.method === "POST") {
    const id = "conv" + (Object.keys(relay.convs).length + 1);
    relay.convs[id] = { id, kind: body.kind, name: body.name, members: body.members.slice().sort(),
      keys: body.keys, keyEpoch: 1 };
    relay.seq++;
    return reply(201, { id, keyEpoch: 1 });
  }

  if (p === "/msg/send") {
    const c = relay.convs[body.convId];
    const entry = { id: "m" + (relay.msgs.length + 1), seq: ++relay.seq, conv: c.id,
      from: me, at: "2026-08-16T12:00:00.000Z", epoch: c.keyEpoch, ct: body.ct };
    relay.msgs.push(entry);
    return reply(201, { id: entry.id, seq: entry.seq, at: entry.at });
  }

  if (p === "/msg/poll") {
    const since = Number(u.searchParams.get("since") || 0);
    const mine = relay.msgs.filter((m) =>
      m.seq > since && relay.convs[m.conv].members.indexOf(me) >= 0);
    return reply(200, { cursor: relay.seq, messages: mine });
  }

  if (p === "/msg/rotate") {
    const c = relay.convs[body.convId];
    c.keys = body.keys;
    c.keyEpoch++;
    relay.seq++;
    return reply(200, { keyEpoch: c.keyEpoch });
  }

  if (p === "/msg/report") {
    const missing = relay.moderators.filter((h) => !(body.escrow || {})[h]);
    if (missing.length) return reply(400, { error: "no escrow key for moderator: " + missing.join(", ") });
    const id = "rep" + (Object.keys(relay.reports).length + 1);
    relay.reports[id] = { id, convId: body.convId, by: me, against: body.against,
      reason: body.reason, escrow: body.escrow, status: "open",
      epoch: relay.convs[body.convId].keyEpoch };
    return reply(201, { id });
  }

  if (p === "/msg/logout") return reply(200, { ok: true });

  return reply(404, { error: "the stub relay does not implement " + p });
};

/* ---- driving the panel ----------------------------------------- */
const host = fakeElement("div");
const def = FieldKit.modules().messages;

const ctx = {
  settings, ui,
  log() {}, warn() {}, error() {}, on() {}, emit() {},
  version: "test", store: null
};

function all(node) {
  const out = [];
  (function walk(n) {
    (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } });
  })(node);
  return out;
}
function byClass(c) { return all(host).filter((n) => String(n.className || "").split(/\s+/).includes(c)); }
function button(label) {
  return all(host).find((n) => n.tagName === "BUTTON" && n.textContent === label) || null;
}
function placeholder(p) {
  return all(host).find((n) => n.attributes && n.attributes.placeholder === p) || null;
}
/* PBKDF2 at 600k is genuinely slow; these waits are for real work,
   not for a race. */
async function settle(ms) {
  const until = Date.now() + (ms || 4000);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 25));
    if (arguments[1] && arguments[1]()) return true;
  }
  return false;
}
async function until(fn, ms) {
  const stop = Date.now() + (ms || 8000);
  while (Date.now() < stop) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/* Two other accounts, seeded straight into the stub so the suite
   does not spend two more 600k-iteration derivations on people whose
   sign-up is not what is being tested. They exist before alice signs
   up because the client loads the directory once at sign-in. */
let bob, mod;

(async function () {
  bob = await mc.newIdentity();
  mod = await mc.newIdentity();
  relay.users.bob = { handle: "bob", displayName: "bob", authSecret: "x",
    pubKey: await mc.exportPublic(bob), wrappedPrivKey: "n/a" };
  relay.users.mod = { handle: "mod", displayName: "mod", authSecret: "x",
    pubKey: await mc.exportPublic(mod), wrappedPrivKey: "n/a" };

  section("the module declares itself honestly");
  {
    ok("it registered", !!def);
    ok("it is not offered to guests in the full build", def.guestSafe === false);
    ok("it brings its own selfchecks", typeof def.selfcheck === "function");
    ok("it can be unmounted", typeof def.unmount === "function");
  }

  section("it refuses to run rather than half-running");
  {
    settings.set("relayUrl", "");
    await def.mount(host, ctx);
    const heads = byClass("mg-empty-h").map((n) => n.textContent);
    ok("with no relay it says so instead of showing a login box",
      heads.indexOf("NO RELAY CONFIGURED") >= 0, heads.join("|"));
    ok("and offers no password field to type into", !placeholder("password"));
  }

  section("signing up");
  {
    settings.set("relayUrl", "https://stub.invalid");
    def.unmount();
    host.children.length = 0;
    await def.mount(host, ctx);

    ok("the sign-in view appeared", !!placeholder("password"));

    /* The rule is stated before it is enforced, so it cannot be a
       surprise after a slow derivation. */
    placeholder("handle").value = "alice";
    placeholder("password").value = "short";
    button("CREATE ACCOUNT").click();
    await until(() => byClass("mg-note").some((n) => /too short/.test(n.textContent)), 3000);
    ok("a short password is refused, with the reason and the number",
      byClass("mg-note").some((n) => /at least 8 characters/.test(n.textContent)));
    /* The same number as the vault's, deliberately, and read from
       the vault's own source rather than written down twice. Two
       different password minimums in one app is a thing people hit
       at the worst possible moment. */
    const vaultRule = require("fs")
      .readFileSync(require("path").join(require("./harness").ROOT, "core/store.js"), "utf8")
      .match(/at least (\d+) characters/);
    ok("the vault states a minimum too", !!vaultRule);
    ok("and messaging asks for the same number, not a second standard",
      byClass("mg-note").some((n) =>
        n.textContent.indexOf("at least " + vaultRule[1] + " characters") >= 0),
      "vault says " + (vaultRule && vaultRule[1]));
    ok("and nothing was sent to the relay for it", relay.requests.length === 0);

    placeholder("handle").value = "Alice Smith";
    placeholder("password").value = "a long enough password";
    button("CREATE ACCOUNT").click();
    await until(() => byClass("mg-note").some((n) => /handle/.test(n.textContent)), 3000);
    ok("a handle the relay would reject is caught here first",
      byClass("mg-note").some((n) => /lowercase letters/.test(n.textContent)));
    ok("and still nothing was sent", relay.requests.length === 0);

    placeholder("handle").value = "alice";
    placeholder("password").value = "a long enough password";
    button("CREATE ACCOUNT").click();
    ok("the panel says it is working rather than looking frozen",
      byClass("mg-note").some((n) => /deriving your key/.test(n.textContent)));

    const inn = await until(() => byClass("mg-wrap").length > 0, 20000);
    ok("the account was created and the panel switched to the conversation view", inn);
  }

  section("what the relay actually received");
  {
    const reg = relay.requests.find((r) => r.path === "/msg/register");
    ok("a registration was sent", !!reg);
    ok("it did not contain the password",
      reg.raw.indexOf("a long enough password") < 0);
    ok("it sent a derived auth secret instead",
      typeof reg.body.authSecret === "string" && reg.body.authSecret.length === 64);
    ok("it sent the public half of the identity key", !!reg.body.pubKey);
    ok("and the private half only in sealed form", !!reg.body.wrappedPrivKey);

    /* The claim in the header: the relay holds the private key and
       cannot open it. Proven rather than asserted — a wrong password
       must fail, and the right one must work. */
    const right = await mc.accountKeys("a long enough password", "alice");
    const wrong = await mc.accountKeys("a long enough passworD", "alice");
    let opened = null;
    try { opened = await mc.unwrapPrivate(reg.body.wrappedPrivKey, wrong.wrapKey); } catch (e) { opened = e.message; }
    ok("the stored private key does not open under a near-miss password", opened === "WRONG_PASSWORD", opened);
    ok("it does open under the real one", !!(await mc.unwrapPrivate(reg.body.wrappedPrivKey, right.wrapKey)));

    ok("the auth secret the relay stores cannot unwrap the private key",
      reg.body.wrappedPrivKey.indexOf(reg.body.authSecret) < 0);
  }

  section("starting a conversation");
  {
    button("NEW").click();
    await until(() => byClass("mg-pick").length > 0, 3000);
    const pick = byClass("mg-pick")[0];
    ok("the picker opened, which it could not do before this suite existed", !!pick);

    const names = pick.children.map((o) => o.textContent);
    ok("everyone but me is listed", names.length === 2, names.join("|"));
    ok("a moderator is marked as one, so you know who could read a report",
      names.some((n) => /^mod\b.*\[moderator\]/.test(n)), names.join("|"));
    ok("I am not in my own picker", !names.some((n) => /^alice/.test(n)));

    pick.children.find((o) => o.value === "bob").selected = true;
    button("START").click();
    const made = await until(() => Object.keys(relay.convs).length === 1, 5000);
    ok("the conversation was created", made);

    const c = relay.convs.conv1;
    ok("both members are in it", c.members.join(",") === "alice,bob");
    ok("the relay was handed a wrapped key for every member",
      !!c.keys.alice && !!c.keys.bob);

    /* The property that makes the whole thing worth doing. */
    const bobKey = await mc.openSealed(c.keys.bob, bob.privateKey);
    ok("bob can open the key sealed to him", !!bobKey);
    let e = null;
    try { await mc.openSealed(c.keys.alice, bob.privateKey); } catch (err) { e = err.message; }
    ok("but not the one sealed to alice", e === "NOT_FOR_ME", e);
    e = null;
    try { await mc.openSealed(c.keys.bob, mod.privateKey); } catch (err) { e = err.message; }
    ok("and a moderator, uninvolved, can open neither", e === "NOT_FOR_ME", e);
  }

  section("sending");
  {
    await until(() => byClass("mg-conv").length > 0, 5000);
    byClass("mg-conv")[0].click();
    await until(() => byClass("mg-send").length > 0, 3000);

    byClass("mg-send")[0].value = "the relay must not be able to read this";
    button("SEND").click();
    const sent = await until(() => relay.msgs.length === 1, 5000);
    ok("the message reached the relay", sent);

    const stored = relay.msgs[0];
    ok("what it stored is not the message",
      stored.ct.indexOf("must not be able to read") < 0);
    ok("it is a sealed envelope", !!JSON.parse(stored.ct).ct && !!JSON.parse(stored.ct).iv);
    ok("it recorded which key epoch sealed it", stored.epoch === 1);

    const bobKey = await mc.openSealed(relay.convs.conv1.keys.bob, bob.privateKey);
    const seen = await mc.openMessage(bobKey, stored.ct);
    ok("bob, who is in it, can read it", seen.text === "the relay must not be able to read this");

    const showed = await until(() =>
      byClass("mg-text").some((n) => /must not be able to read/.test(n.textContent)), 6000);
    ok("and it came back down the poll and rendered for the sender too", showed);
  }

  section("reporting hands over the conversation, and says so first");
  {
    button("REPORT").click();
    await until(() => byClass("mg-warnbox").length > 0, 3000);
    const warn = byClass("mg-warnbox")[0].textContent;

    ok("the warning appears before anything is sent", !!warn);
    ok("it says the moderators will read every message", /read EVERY message/.test(warn));
    ok("it says the reporter's own messages are included", /including yours/i.test(warn));
    ok("it says resolving cannot undo what was read", /cannot undo/i.test(warn));
    ok("it says the key gets changed afterwards", /key is changed/i.test(warn));
    ok("it says an outcome is recorded", /outcome is recorded/i.test(warn));
    ok("it names who will be able to read it",
      byClass("mg-note").some((n) => /readable by: mod/.test(n.textContent)));

    ok("nothing has been filed yet", Object.keys(relay.reports).length === 0);

    const why = all(host).find((n) => n.tagName === "TEXTAREA");
    ok("an empty reason cannot be filed", (function () {
      button("SEND REPORT").click();
      return Object.keys(relay.reports).length === 0;
    })());

    why.value = "kept sending the same thing after being asked to stop";
    button("SEND REPORT").click();
    const filed = await until(() => Object.keys(relay.reports).length === 1, 6000);
    ok("with a reason, it files", filed);

    const r = relay.reports.rep1;
    ok("it names who it is against", r.against === "bob");
    ok("it carried the reason in the clear — the moderator has to read it", /asked to stop/.test(r.reason));
    ok("the escrow is sealed to the moderator", !!r.escrow.mod);
    ok("and to nobody else", Object.keys(r.escrow).join(",") === "mod");

    /* The moderator can genuinely read it. An escrow that did not
       open would make the whole report mechanism theatre. */
    const modKey = await mc.openSealed(r.escrow.mod, mod.privateKey);
    const read = await mc.openMessage(modKey, relay.msgs[0].ct);
    ok("the moderator can open the conversation with it",
      read.text === "the relay must not be able to read this");

    /* And nobody else can, including the person reported. */
    let e = null;
    try { await mc.openSealed(r.escrow.mod, bob.privateKey); } catch (err) { e = err.message; }
    ok("the reported person cannot open the escrow", e === "NOT_FOR_ME", e);
  }

  section("rotating actually cuts the moderator off");
  {
    const modKey = await mc.openSealed(relay.reports.rep1.escrow.mod, mod.privateKey);

    button("ROTATE KEY").click();
    await until(() => byClass("mg-warnbox").length > 0, 3000);
    const warn = byClass("mg-warnbox").map((n) => n.textContent).join("\n");
    ok("it warns that old messages stay readable to whoever already read them",
      /stay readable to whoever could already read them/.test(warn));
    ok("and that the history goes at the next sign-in, since the old key is kept nowhere",
      /next time you sign in/.test(warn) && /stay that\nway/.test(warn));

    button("CHANGE THE KEY").click();
    const rotated = await until(() => relay.convs.conv1.keyEpoch === 2, 6000);
    ok("the epoch moved", rotated);
    ok("every member got a new wrapped key",
      !!relay.convs.conv1.keys.alice && !!relay.convs.conv1.keys.bob);

    const newBobKey = await mc.openSealed(relay.convs.conv1.keys.bob, bob.privateKey);
    const oldBobKey = await mc.openSealed(relay.reports.rep1.escrow.mod, mod.privateKey);
    ok("the new key is not the old one", (await mc.sealMessage(newBobKey, { text: "x" })) !==
      (await mc.sealMessage(oldBobKey, { text: "x" })));

    await until(() => byClass("mg-send").length > 0, 3000);
    byClass("mg-send")[0].value = "after the rotation";
    button("SEND").click();
    const sent2 = await until(() => relay.msgs.length === 2, 6000);
    ok("a second message went out", sent2);
    ok("it is stamped with the new epoch", relay.msgs[1].epoch === 2);

    let e = null;
    try { await mc.openMessage(modKey, relay.msgs[1].ct); } catch (err) { e = err.message; }
    ok("the escrowed key from before the rotation cannot read it", e === "WRONG_KEY", e);
    ok("bob's new key can", (await mc.openMessage(newBobKey, relay.msgs[1].ct)).text === "after the rotation");

    /* The honest limit, asserted so nobody later claims otherwise. */
    ok("the escrowed key still reads what came before it — rotation is prospective only",
      (await mc.openMessage(modKey, relay.msgs[0].ct)).text ===
        "the relay must not be able to read this");

    /* An open window keeps what it already decrypted — rotating does
       not blank out the conversation you are looking at. What it
       cannot do is get it back, which is what the warning says and
       what the next block proves. */
    ok("messages already on screen survive the rotation",
      byClass("mg-text").some((n) => /must not be able to read/.test(n.textContent)));

    /* A message arriving under an epoch whose key is gone is named,
       not silently dropped — a blank row would read as a lost
       message rather than a rotated one. */
    relay.msgs.push({ id: "m99", seq: ++relay.seq, conv: "conv1", from: "bob",
      at: "2026-08-16T12:05:00.000Z", epoch: 1, ct: relay.msgs[0].ct });
    const gap = await until(() =>
      byClass("mg-text").some((n) => /older key/.test(n.textContent)), 8000);
    ok("a message from before the rotation arrives named as unreadable, not blank", gap);
  }

  section("the module's own selfchecks");
  {
    const checks = def.selfcheck();
    ok("it exposes several", checks.length >= 5);
    for (const c of checks) {
      let outcome;
      try { outcome = await c.run(); }
      catch (e) {
        outcome = /^SKIPPED/.test(e.message) ? "skipped: " + e.message : null;
        if (outcome === null) { ok(c.name, false, e.message); continue; }
      }
      ok(c.name, true, typeof outcome === "string" ? outcome.slice(0, 70) : "");
    }
    ok("the sign-in handle survived the password probe's save/restore",
      settings.get("msgHandle") === "alice", settings.get("msgHandle"));
  }

  section("signing out leaves nothing behind");
  {
    button("SIGN OUT").click();
    await until(() => byClass("mg-signin").length > 0, 5000);
    ok("the sign-in view is back", byClass("mg-signin").length > 0);
    ok("no message text is left rendered", byClass("mg-text").length === 0);
    ok("the handle is remembered so you do not retype it",
      placeholder("handle").value === "alice");
    ok("but the password box is empty", !placeholder("password").value);

    /* localStorage is where settings live, and it is the thing that
       survives the tab. A token in it would survive with it. */
    const dump = JSON.stringify(global.localStorage.getItem("fieldkit.settings") || "");
    ok("no session token was written to storage", dump.indexOf("tok-alice") < 0, dump.slice(0, 120));
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
