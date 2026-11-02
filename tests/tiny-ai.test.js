/* ============================================================
   ASK's models (SIMPLIFY_PLAN.md §4): who may use the server's,
   how much, and that the installer's engine is the one in vendor/.

   The limits are the point of relay/tiny-ai.js: a small model on a
   processor still eats the processor, so a second question from one
   person, or a third from anybody, must be refused and not queued.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ROOT, bootstrap, makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("tiny-ai");
const tiny = require("../relay/tiny-ai.js");

const kit = (body) => ({
  send(res, code, data) { res.code = code; res.body = data; },
  readBody: async () => body
});
async function call(method, pathname, body) {
  const res = { code: 0, body: null };
  const handled = await tiny.route({ method }, res, new URL("http://x" + pathname), kit(body));
  return { handled, code: res.code, body: res.body };
}

let who = null, calls = [], hold = null;
const upstream = async (method, url, body) => {
  calls.push({ method, url, body });
  if (hold) await hold;
  return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }] }) };
};
const setup = (config) => tiny.init({ config, whoami: () => who, upstream, log() {} });
const ON = { enabled: true, maxBusy: 2, models: [
  { id: "small", name: "Small", url: "http://b2:8091/", about: "quick" },
  { id: "big", url: "http://b2:8092" }, { name: "no id or url" }] };
const ASK = { model: "big", messages: [{ role: "user", content: "hi" }] };

(async function () {
  section("off unless asked for");
  {
    const r = setup({});
    ok("no config means no models", !r.enabled);
    const l = await call("GET", "/ai/tiny");
    ok("the list says so", l.code === 200 && l.body.enabled === false && l.body.models.length === 0);
    who = { handle: "a", tier: "member" };
    ok("asking gets a plain refusal", (await call("POST", "/ai/tiny/chat", ASK)).code === 503);
    ok("other paths are left alone", (await call("GET", "/ai/other")).handled === false);
  }

  section("who may ask");
  {
    const r = setup(ON);
    ok("models without an id and url are dropped", r.enabled && r.models === 2);
    const l = await call("GET", "/ai/tiny");
    ok("the list never shows where a model runs", !JSON.stringify(l.body).includes("b2:80"));
    ok("the list carries names", l.body.models[0].name === "Small" && l.body.models[1].name === "big");
    who = null;
    ok("nobody signed in: 401", (await call("POST", "/ai/tiny/chat", ASK)).code === 401);
    who = { handle: "g", tier: "guest" };
    const g = await call("POST", "/ai/tiny/chat", ASK);
    ok("a guest is pointed at their own browser", g.code === 403 && g.body.members === true);
    who = { handle: "b", tier: "member", banned: true };
    ok("banned: 403", (await call("POST", "/ai/tiny/chat", ASK)).code === 403);
    ok("nothing reached a model", calls.length === 0);
    who = { handle: "m", tier: "member" };
    const m = await call("POST", "/ai/tiny/chat", ASK);
    ok("a member gets an answer", m.code === 200 && m.body.content === "hello" && m.body.model === "big");
    who = { handle: "z", tier: "admin" };
    ok("so does an admin", (await call("POST", "/ai/tiny/chat", ASK)).code === 200);
    ok("the right server was asked", calls[0].url === "http://b2:8092/v1/chat/completions");
    ok("answers are kept short", calls[0].body.max_tokens === tiny.LIMITS.maxTokens);
    await call("POST", "/ai/tiny/chat", { messages: ASK.messages, model: "nope" });
    ok("an unknown model falls to the first", calls[calls.length - 1].url.includes(":8091/v1"));
  }

  section("how much");
  {
    setup(ON);
    let release;
    hold = new Promise((r) => { release = r; });
    who = { handle: "a", tier: "member" };
    const first = call("POST", "/ai/tiny/chat", ASK);
    await new Promise((r) => setImmediate(r));
    const twice = await call("POST", "/ai/tiny/chat", ASK);
    ok("one question at a time per person", twice.code === 429 && !twice.body.busy);
    who = { handle: "b", tier: "member" };
    const second = call("POST", "/ai/tiny/chat", ASK);
    await new Promise((r) => setImmediate(r));
    who = { handle: "c", tier: "member" };
    const third = await call("POST", "/ai/tiny/chat", ASK);
    ok("maxBusy overall", third.code === 429 && third.body.busy === true);
    release(); hold = null;
    await first; await second;
    ok("the slots come back", tiny._internals.asking.size === 0);

    const clean = tiny._internals.cleanMessages;
    ok("too long is refused", clean([{ role: "user", content: "x".repeat(tiny.LIMITS.maxChars + 1) }]) === null);
    ok("empty is refused", clean([]) === null && clean("hi") === null);
    const many = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: "m" + i }));
    ok("only the last messages travel", clean(many).length === tiny.LIMITS.maxMessages && clean(many).pop().content === "m59");
    ok("odd roles become user", clean([{ role: "tool", content: "x" }])[0].role === "user");

    tiny.init({ config: ON, whoami: () => who, upstream: async () => ({ status: 500, text: "" }), log() {} });
    const down = await call("POST", "/ai/tiny/chat", ASK);
    ok("a dead model is a 502, and frees the slot", down.code === 502 && tiny._internals.asking.size === 0);
  }

  section("the engine the installer will accept");
  {
    const engine = fs.readFileSync(path.join(ROOT, "vendor", "web-llm.js"));
    const hash = crypto.createHash("sha256").update(engine).digest("hex");
    const src = fs.readFileSync(path.join(ROOT, "core", "ai-install.js"), "utf8");
    ok("ENGINE_SHA256 is vendor/web-llm.js's", src.includes('"' + hash + '"'));
    const deploy = fs.readFileSync(path.join(ROOT, "tools", "make-deploy.js"), "utf8");
    ok("the relay image carries it", deploy.includes('"web-llm.js"') && deploy.includes('"tiny-ai.js"'));
    ok("no carriage returns for a deploy to strip", !engine.includes(13));
  }

  section("a network that blocks Hugging Face gets the model through the relay");
  {
    const FK = bootstrap(["core/kernel.js", "core/settings.js", "core/ai-install.js"]);
    const inst = FK.need("aiInstall");
    const asked = [];
    let hfBlocked = true;
    global.fetch = async (u) => {
      asked.push(String(u));
      if (/^https:\/\/huggingface\.co\//.test(u)) {
        if (hfBlocked) throw new TypeError("Failed to fetch");
        return { ok: true, status: 200 };
      }
      if (/\/ai\/mirror\?u=/.test(u)) return { ok: true, status: 200, via: "relay" };
      throw new TypeError("Failed to fetch");
    };
    const HF = "https://huggingface.co/mlc-ai/Tiny/resolve/main/";
    let threw = null;
    try { await inst.fetchModelFile(HF + "a.bin", { relay: false }); } catch (e) { threw = e.message; }
    ok("blocked and no relay: says to add one", /no relay to fetch it through/.test(threw || ""), threw);
    FK.need("settings").set("relayUrl", "https://relay.example/");
    const how = { relay: false };
    const r = await inst.fetchModelFile(HF + "a.bin", how);
    ok("blocked: the same file through the relay", r.via === "relay" && how.relay === true &&
      asked[asked.length - 1] === "https://relay.example/ai/mirror?u=" + encodeURIComponent(HF + "a.bin"), asked[asked.length - 1]);
    asked.length = 0;
    await inst.fetchModelFile(HF + "b.bin", how);
    ok("and the rest of the model straight to the relay, without waiting on the block again",
      asked.length === 1 && /\/ai\/mirror/.test(asked[0]));
    hfBlocked = false;
    asked.length = 0;
    const d = await inst.fetchModelFile(HF + "c.bin", { relay: false });
    ok("where Hugging Face is open, it is used directly and the relay's upload is spared",
      asked.length === 1 && asked[0] === HF + "c.bin" && d.via !== "relay");
    const src = fs.readFileSync(path.join(ROOT, "core", "ai-install.js"), "utf8");
    ok("a file is kept only at the size Hugging Face lists", /blobs=true/.test(src) && /arrived at the wrong size/.test(src));
    delete global.fetch;
  }

  section("what the relay tells TOPOLOGY");
  {
    const topology = require("../relay/topology.js");
    const res = {};
    await topology.route({}, res, null, kit());
    topology.init({
      browser: () => ({ enabled: true, ready: true, sessions: 2, helpers: [{ name: "b2", up: false, sessions: 0 }] }),
      runner: async () => ({ online: false, why: "the run server is offline" }),
      targets: () => [{ name: "home-pc", ok: true, checked: true }, { name: "spare", ok: false, checked: false }],
      tiny: () => [{ id: "small", name: "Small" }]
    });
    const r = await topology.report();
    const by = Object.fromEntries(r.parts.map((p) => [p.id, p]));
    ok("the relay is always up", by.relay.up === true);
    ok("the browser and its helper", by.browser.up && by["browser-helper-1"].up === false && by["browser-helper-1"].link === "browser");
    ok("runner down, with the reason", by.runner.up === false && by.runner.note.includes("offline"));
    ok("a target nobody has asked yet says so", by["ai-target-2"].note === "not checked yet");
    ok("the server's models", by["tiny-small"].label === "SMALL");
    ok("only names and states go out", r.parts.every((p) => Object.keys(p).every((k) => ["id", "label", "kind", "link", "up", "note"].includes(k))));
    topology.init({ runner: async () => ({ enabled: false, online: false }) });
    ok("a feature that is off is not drawn", (await topology.report()).parts.length === 1);
    const code = fs.readFileSync(path.join(ROOT, "relay", "server.js"), "utf8");
    ok("the relay wires it up", code.includes("topology.init(") && code.includes("topology.route("));
  }

  section("the router asks the server after the home AI");
  {
    const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ai-tier3-heuristics.js",
      "core/ai-tier2-local.js", "core/ai-router.js"]);
    const asked = [];
    let tier = "member", signed = true, fail = false;
    FieldKit.provide("messages", {
      signedIn: () => signed, tier: () => tier,
      tinyModels: async () => ({ enabled: true, models: [{ id: "small", name: "Small" }] }),
      tinyChat: async (m) => {
        asked.push(m);
        if (fail) throw new Error("busy");
        return { content: "from server", model: "small" };
      }
    });
    const ai = FieldKit.need("ai");
    const hi = [{ role: "user", content: "hi" }];
    const said = await ai.chat(hi);
    ok("a member's question goes to the server model", said.server === true && said.content === "from server");
    let a = await ai.availability();
    ok("availability lists the models", a.server.available && a.server.models.length === 1);
    FieldKit.need("settings").set("askServerModel", "small");
    await ai.chat(hi);
    ok("the chosen model is the one asked for", asked[asked.length - 1] === "small");
    fail = true;
    ok("a failed server model falls to the rules", (await ai.chat(hi)).tier === 3);
    fail = false; tier = "guest"; asked.length = 0;
    const guest = await ai.chat(hi);
    ok("a guest is never sent to it", guest.tier === 3 && asked.length === 0);
    a = await ai.availability();
    ok("and is told why", !a.server.available && a.server.detail === "for members");
    tier = "member"; signed = false;
    await ai.chat(hi);
    ok("signed out, likewise", asked.length === 0);
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.log("\nSUITE CRASHED: " + e.stack);
  console.log("RESULT  pass 0  fail 1");
  process.exit(1);
});
