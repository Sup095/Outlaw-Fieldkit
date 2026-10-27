/* ============================================================
   core/relay-choice.js — the relay address, asked at boot
   (FIELDKIT_PROJECT.md §14.39).

   What matters:
     1. With an address set, boot carries on by itself after the
        countdown; Enter carries on at once; nothing is changed.
     2. C (or the button) opens the list: add an address, switch to a
        saved one, test one, forget one. Typed addresses are cleaned
        up ("relay.example.com" becomes https://relay.example.com);
        nonsense is refused.
     3. If the address in use does not answer, the saved ones are tried
        in turn and the first that answers becomes the one in use.
     4. Both builds ask, before they connect.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "core/relay-choice.js"]);
const { ok, section, state } = makeRunner("relay-choice");
const settings = FieldKit.need("settings");
const rc = FieldKit.need("relayChoice");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const keys = [];
document.addEventListener = (t, fn) => { if (t === "keydown") keys.push(fn); };
document.removeEventListener = (t, fn) => { const i = keys.indexOf(fn); if (i >= 0) keys.splice(i, 1); };
const press = (key) => keys.slice().forEach((fn) => fn({ key, preventDefault() {} }));

let up = new Set();
const asked = [];
global.fetch = async (url) => {
  asked.push(String(url));
  const base = String(url).replace(/\/health$/, "");
  if (up.has(base)) return { ok: true, status: 200 };
  throw new Error("no answer");
};

function all(node) {
  const out = [];
  (function walk(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } }); })(node);
  return out;
}
const text = (h) => all(h).map((n) => n.textContent || "").join(" | ");
const button = (h, label) => all(h).find((n) => n.tagName === "BUTTON" && n.textContent === label) || null;
const buttons = (h, label) => all(h).filter((n) => n.tagName === "BUTTON" && n.textContent === label);
const input = (h) => all(h).find((n) => n.tagName === "INPUT");

(async () => {
  section("cleaning addresses");
  ok("a bare name becomes https", rc.clean("relay.example.com") === "https://relay.example.com");
  ok("a trailing slash goes", rc.clean("https://relay.example.com/") === "https://relay.example.com");
  ok("nonsense and other schemes are refused", rc.clean("not an address") === null && rc.clean("ftp://x.y") === null && rc.clean("") === null);

  section("it carries on by itself");
  {
    settings.set("relayUrl", "https://a.example.com");
    settings.set("relayUrls", []);
    const host = fakeElement("div");
    let done = null;
    rc.ask(host, { waitS: 2 }).then((u) => { done = u; });
    await wait(10);
    ok("it shows the address it is about to use", /Connecting to a\.example\.com/.test(text(host)));
    ok("and the countdown", /Continuing in 2 s/.test(text(host)));
    await wait(2200);
    ok("then carries on, unchanged", done === "https://a.example.com" && settings.get("relayUrl") === "https://a.example.com");
    ok("leaving one line behind", /RELAY ADDRESS: a\.example\.com/.test(text(host)));
    ok("and no key listener", keys.length === 0);

    const h2 = fakeElement("div");
    let d2 = null;
    rc.ask(h2, { waitS: 30 }).then((u) => { d2 = u; });
    await wait(10);
    press("Enter");
    await wait(10);
    ok("Enter carries on at once", d2 === "https://a.example.com");
  }

  section("changing and adding");
  {
    const host = fakeElement("div");
    let done = null;
    rc.ask(host, { waitS: 30 }).then((u) => { done = u; });
    await wait(10);
    press("c");
    await wait(10);
    ok("C opens the list", !!input(host) && /a\.example\.com {2}\(in use\)/.test(text(host)));
    await wait(1200);
    ok("and stops the countdown", done === null);
    input(host).value = "b.example.com";
    button(host, "ADD").click();
    ok("ADD saves another without switching", settings.get("relayUrl") === "https://a.example.com" &&
      settings.get("relayUrls").indexOf("https://b.example.com") >= 0);
    input(host).value = "nonsense here";
    button(host, "ADD AND USE").click();
    ok("nonsense is refused, with a sentence", /not an address/.test(text(host)) && settings.get("relayUrls").length === 1);
    input(host).value = "c.example.com";
    button(host, "ADD AND USE").click();
    ok("ADD AND USE switches to it and keeps the old one", settings.get("relayUrl") === "https://c.example.com" &&
      ["https://a.example.com", "https://b.example.com"].every((u) => settings.get("relayUrls").indexOf(u) >= 0));
    up = new Set(["https://b.example.com"]);
    buttons(host, "TEST")[1].click();
    await wait(20);
    ok("TEST says whether one answers from here", /answers/.test(text(host)) || /does not answer/.test(text(host)));
    buttons(host, "USE")[0].click();
    ok("USE switches to a saved one", settings.get("relayUrl") === "https://a.example.com");
    buttons(host, "✕")[2].click();
    ok("✕ forgets one", rc.known(settings).length === 2);
    button(host, "CONTINUE").click();
    await wait(10);
    ok("CONTINUE carries on with the one in use", done === "https://a.example.com");
  }

  section("an address that does not answer");
  {
    settings.set("relayUrl", "https://a.example.com");
    settings.set("relayUrls", ["https://b.example.com", "https://c.example.com"]);
    up = new Set(["https://c.example.com"]);
    const said = [];
    const r = await rc.reachable((t, l) => said.push(l + ": " + t), { ms: 200 });
    ok("the saved ones are tried in turn, and the first that answers is used", r.ok && r.url === "https://c.example.com" &&
      settings.get("relayUrl") === "https://c.example.com");
    ok("and the boot screen says so", said.some((s) => /does not answer/.test(s)) && said.some((s) => /using c\.example\.com instead/.test(s)));
    ok("the one that did not answer stays saved", settings.get("relayUrls").indexOf("https://a.example.com") >= 0);
    up = new Set();
    const r2 = await rc.reachable(() => {}, { ms: 200 });
    ok("none answering: the one in use stays, marked not ok", !r2.ok && r2.url === "https://c.example.com");
    up = new Set(["https://c.example.com"]);
    asked.length = 0;
    const r3 = await rc.reachable(() => {}, { ms: 200 });
    ok("the one in use answering: nothing else is asked", r3.ok && asked.length === 1);
    settings.set("relayUrl", ""); settings.set("relayUrls", []);
    ok("none set: none", (await rc.reachable(() => {})).url === null);

    const host = fakeElement("div");
    let done = "x";
    rc.ask(host, { waitS: 2 }).then((u) => { done = u; });
    await wait(10);
    ok("with none set it asks for one and does not count down", /No relay address is set/.test(text(host)) && !/Continuing/.test(text(host)));
    button(host, "CONTINUE WITHOUT ONE").click();
    await wait(10);
    ok("and can carry on without", done === null);
  }

  section("both builds ask before connecting");
  {
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    ok("FIELDKIT and OUTPOST load it", ["FIELDKIT.html", "OUTPOST.html"].every((f) => /"core\/relay-choice\.js"/.test(read(f))));
    ok("the full boot asks before its first connection", /choice\.ask\(consoleEl\)[\s\S]*var relayUrl = settings\.get\("relayUrl"\)/.test(read("core/boot.js")));
    ok("OUTPOST asks too", /relayAddress\(\)/.test(read("core/boot-outpost.js")) && /choice\.ask\(consoleEl\)/.test(read("core/boot-outpost.js")));
    ok("spare addresses travel on the drive", /"relayUrls"/.test(read("core/drive-profile.js")));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
