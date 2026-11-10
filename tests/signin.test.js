/* ============================================================
   One sign-in for FieldKit (modules/messages.js signInForm and
   promptSignIn), used at start, by RUNNER and by BROWSER.

   What matters:
     1. When the desktop opens with a relay and nobody signed in, the
        sign-in is offered once; NOT NOW closes it; it can be turned off.
     2. The form signs in or creates an account without the MESSAGES
        panel ever being opened, and forgets the password after.
     3. Without a relay nothing is offered.
     4. RUNNER and BROWSER use the same form instead of sending people
        off to another panel.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "core/msg-crypto.js", "modules/messages.js"]);
const { ok, section, state } = makeRunner("signin");

global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
global.atob = (s) => Buffer.from(s, "base64").toString("binary");

const settings = FieldKit.need("settings");
const msg = FieldKit.need("messages");
const users = {};
const asked = [];
const reply = (status, body) => Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
global.window.fetch = function (url, opts) {
  opts = opts || {};
  const p = new URL(String(url)).pathname;
  const body = opts.body ? JSON.parse(opts.body) : null;
  asked.push(p + " " + String(opts.body || ""));
  if (p === "/msg/register") { users[body.handle] = body; return reply(201, { handle: body.handle, token: "tok-" + body.handle, tier: "member" }); }
  if (p === "/msg/login") {
    const u = users[body.handle];
    if (!u || u.authSecret !== body.authSecret) return reply(401, { error: "handle or password is wrong" });
    return reply(200, { handle: u.handle, token: "tok-" + u.handle, pubKey: u.pubKey, wrappedPrivKey: u.wrappedPrivKey, tier: "member" });
  }
  if (p === "/msg/logout") return reply(200, { ok: true });
  return reply(200, {});
};

function all(node) {
  const out = [];
  (function walk(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } }); })(node);
  return out;
}
const overlay = () => all(document.body).find((n) => /fk-signin-over/.test(n.className)) || null;
const btn = (root, label) => all(root).find((n) => n.tagName === "BUTTON" && n.textContent === label);
const press = (b) => (b.onclick ? b.onclick({ type: "click", preventDefault() {}, stopPropagation() {} }) : b.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return false; };

(async () => {
  section("at start");
  {
    settings.set("relayUrl", "");
    ok("with no relay, nothing is offered", msg.promptSignIn() === null);
    settings.set("relayUrl", "https://relay.test");
    FieldKit.emit("boot:done", {});
    await until(() => !!overlay(), 2000);
    ok("the desktop opening offers the sign-in", !!overlay() && /SIGN IN TO FIELDKIT/.test(all(overlay()).map((n) => n.textContent).join(" ")));
    ok("only once, however often it is asked", msg.promptSignIn() === null && all(document.body).filter((n) => /fk-signin-over/.test(n.className)).length === 1);
    press(btn(overlay(), "NOT NOW"));
    ok("NOT NOW closes it", !overlay());
    settings.set("signInAtBoot", false);
    FieldKit.emit("boot:done", {});
    await wait(800);
    ok("turned off, it is not offered at start", !overlay());
    settings.set("signInAtBoot", true);
    FieldKit.emit("boot:done", { outpost: true });
    await until(() => !!overlay(), 2000);
    ok("OUTPOST offers it at start too", !!overlay());
    press(btn(overlay(), "NOT NOW"));
  }

  section("the form");
  {
    let done = null;
    const form = msg.signInForm({ onDone: (s) => { done = s; } });
    const inputs = all(form).filter((n) => n.tagName === "INPUT");
    const [handle, pw, name] = inputs;
    ok("it has a handle, a password and a display name", inputs.length === 3 && (pw.type || pw.attributes.type) === "password");
    handle.value = "Ada"; pw.value = "short";
    press(btn(form, "CREATE ACCOUNT"));
    await until(() => /too short/.test(all(form).map((n) => n.textContent).join(" ")));
    ok("a short password is explained", /too short/.test(all(form).map((n) => n.textContent).join(" ")) && !msg.signedIn());
    pw.value = "a long enough password"; name.value = "Ada L";
    press(btn(form, "CREATE ACCOUNT"));
    await until(() => !!done);
    ok("an account is made without opening MESSAGES", msg.signedIn() && msg.handle() === "ada" && done && done.handle === "ada");
    ok("the password is not kept in the form", pw.value === "");
    ok("the password never went over the wire", asked.every((a) => !a.includes("a long enough password")));
    ok("the handle is remembered for next time", settings.get("msgHandle") === "ada");
    ok("a signed-in person is not asked again", msg.promptSignIn() === null);
  }

  section("used where an account is needed");
  {
    const root = path.join(__dirname, "..");
    const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
    ok("RUNNER shows the form instead of sending you to MESSAGES", /signInForm\(/.test(rd("modules/runner.js")));
    ok("BROWSER offers it when it cannot prove who you are", /promptSignIn\(/.test(rd("modules/browser.js")));
    ok("the setting has a default", /signInAtBoot: true/.test(rd("core/settings.js")));
    ok("the form never builds markup from text", !/innerHTML/.test(rd("modules/messages.js").split("function signInForm")[1].split("FieldKit.on(\"boot:done\"")[0]));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
