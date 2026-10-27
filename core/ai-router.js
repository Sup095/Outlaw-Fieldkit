/* ============================================================
   FieldKit :: ai-router
   Routes every AI request to the best tier currently available,
   transparently to the caller (FIELDKIT_PROJECT.md §9).

     Tier 1  relay -> LM Studio on a real PC. Best answers.
     Tier 2  in-browser model (WebLLM). Not built yet — the
             Chromebook did acquire a WebGPU adapter, so this is
             viable later; the slot exists so adding it is a
             registration, not a refactor.
     Tier 3  heuristics. Zero dependencies, always available.

   Callers ask for a capability, not a tier. If the preferred tier
   is unreachable the request silently degrades rather than
   failing — that is the whole point of the design.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var lastTierUsed = null;
  var lastError = null;

  function tier3() { return FieldKit.service("aiTier3"); }
  function tier2() { return FieldKit.service("aiTier2"); }
  function relay() { return FieldKit.service("transportRelay"); }
  function store() { return FieldKit.service("store"); }

  /* Tier 1 needs three things at once: a configured relay, an
     unlocked vault (the auth token comes from it), and a healthy
     upstream target. Missing any of them means fall through. */
  async function tier1Available() {
    var r = relay(), s = store();
    if (!r || !r.url()) return false;
    if (!s || !s.isUnlocked()) return false;
    if (s.state() !== "ONLINE") return false;
    return true;
  }

  async function availability() {
    var out = {
      1: { name: "RELAY / LM STUDIO", available: false, detail: "" },
      2: { name: "IN-BROWSER MODEL", available: false, detail: "not built yet" },
      3: { name: "HEURISTIC", available: true, detail: "always available" }
    };

    var r = relay(), s = store();
    if (!r || !r.url()) out[1].detail = "relay not configured";
    else if (!s || !s.isUnlocked()) out[1].detail = "vault locked";
    else if (s.state() !== "ONLINE") out[1].detail = "offline";
    else {
      try {
        var targets = await r.aiTargets();
        var healthy = targets.filter(function (t) { return t.health && t.health.ok; });
        out[1].available = healthy.length > 0;
        out[1].detail = healthy.length
          ? healthy.map(function (t) { return t.name; }).join(", ")
          : "relay up, no AI target reachable";
        out[1].targets = targets;
      } catch (e) {
        out[1].detail = "relay error: " + e.message;
      }
    }

    var t2 = tier2();
    if (t2) {
      out[2].available = t2.available();
      out[2].detail = out[2].available ? "loaded" : "not loaded";
    }

    return out;
  }

  /* ---- core call ---------------------------------------------- */
  async function chat(messages, opts) {
    opts = opts || {};
    lastError = null;

    if (!opts.forceTier || opts.forceTier === 1) {
      if (await tier1Available()) {
        try {
          var payload = {
            messages: messages,
            temperature: opts.temperature === undefined ? 0.7 : opts.temperature
          };
          /* No cap unless a caller asks for one.

             There used to be a `|| 900` default here, and it was
             wrong in the worst way: a long answer stopped mid-sentence
             and nothing anywhere said why, so it read as the model
             being broken rather than as a limit being hit. The
             utility calls below (tag, summarise, classify) still pass
             their own small caps, because for those a long answer IS
             the failure. A conversation is the opposite.

             Omitted rather than sent as -1 or 0: for an
             OpenAI-compatible chat endpoint, absent means "until the
             model is done", and -1 is an LM Studio extension that a
             stricter server would reject outright. */
          if (opts.maxTokens) payload.max_tokens = opts.maxTokens;
          if (opts.target) payload.__target = opts.target;
          if (opts.model) payload.model = opts.model;

          var res = await relay().aiChat(payload);
          var choice = res && res.choices && res.choices[0];
          var content = choice && choice.message && choice.message.content;
          if (content) {
            lastTierUsed = 1;
            var ach = FieldKit.service("achievements");
            if (ach) ach.noteTier1();
            /* Belt and braces for the next time something upstream
               cuts a reply short — the model's own server, a context
               window, a proxy. `length` means it stopped because it
               ran out of room, not because it had finished, and the
               caller can say so instead of showing a half sentence. */
            var out = { content: content, tier: 1, raw: res };
            if (choice.finish_reason && choice.finish_reason !== "stop") {
              out.truncated = choice.finish_reason === "length";
              out.finishReason = choice.finish_reason;
            }
            return out;
          }
          lastError = "relay returned no completion";
        } catch (e) {
          lastError = e.message;
          FieldKit.log("warn", "ai-router", "tier 1 failed, degrading: " + e.message);
        }
      }
    }

    if (!opts.forceTier || opts.forceTier === 2) {
      var t2 = tier2();
      if (t2 && t2.available()) {
        try {
          var r2 = await t2.chat(messages);
          lastTierUsed = 2;
          return { content: r2.content, tier: 2 };
        } catch (e) {
          lastError = e.message;
          FieldKit.log("warn", "ai-router", "tier 2 failed, degrading: " + e.message);
        }
      }
    }

    var r3 = await tier3().chat(messages);
    lastTierUsed = 3;
    return { content: r3.content, tier: 3, degraded: true, reason: lastError };
  }

  /* ---- capabilities ------------------------------------------- */
  /* Each of these tries the model first and falls back to the
     heuristic implementation, so callers never branch on tier. */

  async function summarize(text, opts) {
    opts = opts || {};
    if (await tier1Available()) {
      try {
        var r = await chat([
          { role: "system", content: "You summarise developer notes. Be terse and concrete. No preamble." },
          { role: "user", content: "Summarise in " + (opts.sentences || 3) + " sentences:\n\n" + text }
        ], { temperature: 0.3, maxTokens: 300 });
        if (r.tier === 1) return { text: r.content, tier: 1 };
      } catch (e) { /* fall through */ }
    }
    return { text: tier3().summarize(text, opts.sentences || 3), tier: 3 };
  }

  async function tagText(text, opts) {
    opts = opts || {};
    var limit = opts.limit || 6;
    if (await tier1Available()) {
      try {
        var r = await chat([
          { role: "system", content: "Return ONLY a comma-separated list of lowercase tags. No other text." },
          { role: "user", content: "Give at most " + limit + " tags for:\n\n" + text }
        ], { temperature: 0.2, maxTokens: 80 });
        if (r.tier === 1) {
          var tags = r.content.split(",").map(function (t) {
            return t.trim().toLowerCase().replace(/^["'\-\s]+|["'.\s]+$/g, "");
          }).filter(Boolean).slice(0, limit);
          if (tags.length) return { tags: tags, tier: 1 };
        }
      } catch (e) { /* fall through */ }
    }
    return { tags: tier3().tag(text, limit), tier: 3 };
  }

  async function explainError(text) {
    var heuristic = tier3().explainError(text);
    if (await tier1Available()) {
      try {
        var r = await chat([
          { role: "system", content: "You explain error messages to an experienced developer. State the likely cause and the first thing to check. Be brief." },
          { role: "user", content: text }
        ], { temperature: 0.3, maxTokens: 400 });
        if (r.tier === 1) return { text: r.content, tier: 1, heuristic: heuristic.text };
      } catch (e) { /* fall through */ }
    }
    return { text: heuristic.text, tier: 3, matched: heuristic.matched };
  }

  /* ---- diagnostics -------------------------------------------- */
  async function selftest() {
    var avail = await availability();
    if (avail[1].available) {
      var r = await chat([{ role: "user", content: "Reply with exactly: FIELDKIT OK" }],
        { temperature: 0, maxTokens: 20 });
      if (r.tier !== 1) throw new Error("tier 1 reported available but did not answer");
      return "tier 1 round trip via " + avail[1].detail;
    }
    if (avail[2].available) return "tier 2 available, tier 1 down";
    return "tier 3 only — " + avail[1].detail;
  }

  FieldKit.provide("ai", {
    chat: chat,
    summarize: summarize,
    tag: tagText,
    explainError: explainError,
    availability: availability,
    selftest: selftest,
    lastTier: function () { return lastTierUsed; },
    lastError: function () { return lastError; },
    flavor: function (seed) { return tier3().flavor(seed); }
  });
})(window.FieldKit);
