/* ============================================================
   FieldKit relay :: tiny-ai — small AI models for members, and the
   engine for the ones that run in a browser (SIMPLIFY_PLAN.md §4)

     GET  /ai/tiny          which server models there are (public)
     POST /ai/tiny/chat     { model, messages }, members and admins
     GET  /ai/engine.js     the in-browser engine, for an installer

   The models themselves run elsewhere: each is an OpenAI-compatible
   server (llama.cpp's, on Bastion 2 by default, runnerd/tiny-ai.sh)
   named in `tinyAi.models`. This only decides who may ask and how
   much, which is the expensive part to get wrong: a small model on a
   processor is still a processor. So one question at a time per
   person, `maxBusy` at a time overall, and answers kept short. A
   guest is told plainly; ASK offers them the models that run in their
   own browser, which cost nobody anything.

   The engine is here because a page cannot load it from a CDN as a
   classic script, and it is not in the standalone files: at 5.3 MB
   it is three times the size of everything else. The page hashes it
   against a number built into itself before running it, so this
   relay cannot hand it anything else.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const LIMITS = { maxTokens: 512, timeoutMs: 90000, maxMessages: 24, maxChars: 12000 };
const CONFIG_DEFAULTS = { enabled: false, models: [], maxBusy: 2 };

let cfg = Object.assign({}, CONFIG_DEFAULTS);
let whoami = () => null;
let upstream = null;
let log = () => {};
const asking = new Set();         /* handles with a question in progress */

function init(opts) {
  cfg = Object.assign({}, CONFIG_DEFAULTS, opts.config || {});
  cfg.models = (Array.isArray(cfg.models) ? cfg.models : [])
    .filter((m) => m && typeof m.id === "string" && typeof m.url === "string");
  whoami = opts.whoami || whoami;
  upstream = opts.upstream || upstream;
  log = opts.log || log;
  asking.clear();
  return { enabled: !!cfg.enabled && cfg.models.length > 0, models: cfg.models.length };
}

const enginePaths = () => [path.join(__dirname, "web-llm.js"), path.join(__dirname, "..", "vendor", "web-llm.js")];

function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = list.slice(-LIMITS.maxMessages).map((m) => ({
    role: m && m.role === "assistant" ? "assistant" : m && m.role === "system" ? "system" : "user",
    content: String((m && m.content) || "")
  }));
  return out.reduce((n, m) => n + m.content.length, 0) > LIMITS.maxChars ? null : out;
}

async function route(req, res, url, kit) {
  const send = kit.send, method = req.method;
  const on = !!cfg.enabled && cfg.models.length > 0;

  if (url.pathname === "/ai/engine.js" && method === "GET") {
    const file = enginePaths().find((f) => fs.existsSync(f));
    if (!file) { send(res, 404, { error: "this relay does not carry the in-browser engine" }); return true; }
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400",
      "Content-Length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  if (url.pathname === "/ai/tiny" && method === "GET") {
    send(res, 200, { enabled: on, models: on ? cfg.models.map((m) => ({ id: m.id, name: m.name || m.id, about: m.about || "" })) : [] });
    return true;
  }

  if (url.pathname === "/ai/tiny/chat" && method === "POST") {
    if (!on) { send(res, 503, { error: "this relay runs no AI models" }); return true; }
    const me = whoami(req);
    if (!me) { send(res, 401, { error: "sign in to MESSAGES to use the server's models" }); return true; }
    if (me.banned) { send(res, 403, { error: "this account cannot use the server's models while it is banned" }); return true; }
    if (me.tier !== "member" && me.tier !== "admin") {
      send(res, 403, { error: "the server's models are for members; models in your own browser are for everyone", members: true });
      return true;
    }
    const body = await kit.readBody(req).catch(() => null);
    const messages = cleanMessages(body && body.messages);
    if (!messages) { send(res, 400, { error: "that question is empty or too long" }); return true; }
    const model = cfg.models.find((m) => m.id === body.model) || cfg.models[0];
    if (asking.has(me.handle)) { send(res, 429, { error: "one question at a time" }); return true; }
    if (asking.size >= cfg.maxBusy) { send(res, 429, { error: "the server's models are busy; try again in a moment", busy: true }); return true; }

    asking.add(me.handle);
    try {
      const r = await upstream("POST", model.url.replace(/\/$/, "") + "/v1/chat/completions",
        { model: model.id, messages: messages, stream: false, temperature: 0.7, max_tokens: LIMITS.maxTokens }, LIMITS.timeoutMs);
      if (r.status < 200 || r.status >= 300) throw new Error("the model answered " + r.status);
      const answer = JSON.parse(r.text);
      const choice = answer.choices && answer.choices[0];
      send(res, 200, { content: (choice && choice.message && choice.message.content) || "", model: model.id,
        truncated: !!(choice && choice.finish_reason === "length") });
    } catch (e) {
      log("WARN", "tiny-ai: " + model.id + " failed: " + e.message);
      send(res, 502, { error: "the model did not answer" });
    } finally {
      asking.delete(me.handle);
    }
    return true;
  }
  return false;
}

const models = () => (cfg.enabled ? cfg.models.map((m) => ({ id: m.id, name: m.name || m.id })) : []);

module.exports = { init, route, models, enginePaths, LIMITS, _internals: { asking, cleanMessages } };
