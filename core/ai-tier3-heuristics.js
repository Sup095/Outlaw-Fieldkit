/* ============================================================
   FieldKit :: ai tier 3 — heuristics
   No model, no network, no dependencies. Always available.

   Per FIELDKIT_PROJECT.md §9, this tier does most of the actual
   day-to-day automation: tagging, extractive summaries, error
   pattern matching, boot flavour text, and anomaly flags. It is
   the floor the router can always fall back to.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var STOP = new Set(("a an the and or but if then than that this these those of in on at to for with " +
    "from by as is are was were be been being it its it's i you he she they we me my your our their " +
    "not no so just very can could would should will shall do does did done have has had having " +
    "there here when where what which who whom how why all any both each few more most other some " +
    "such only own same too s t don now up down out off over under again further once about into " +
    "through during before after above below between because while until").split(" "));

  function words(text) {
    return String(text || "").toLowerCase()
      .replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>{}\[\]\\/]/g, " ")
      .split(/\s+/).filter(function (w) { return w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w); });
  }

  function frequency(text) {
    var f = new Map();
    words(text).forEach(function (w) { f.set(w, (f.get(w) || 0) + 1); });
    return f;
  }

  /* ---- tagging ------------------------------------------------ */
  /* Frequency-ranked keywords, with a bonus for terms that look
     technical (dotted paths, snake_case, versions) since that is
     what this toolkit's notes are mostly about. */
  function technicalBoost(w) {
    if (/[._-]/.test(w)) return 1.6;
    if (/\d/.test(w)) return 1.3;
    return 1;
  }

  function tag(text, limit) {
    limit = limit || 6;
    var f = frequency(text);
    var scored = [];
    f.forEach(function (count, w) { scored.push({ w: w, score: count * technicalBoost(w) }); });
    scored.sort(function (a, b) { return b.score - a.score || a.w.localeCompare(b.w); });
    return scored.slice(0, limit).map(function (s) { return s.w; });
  }

  /* ---- extractive summary ------------------------------------- */
  /* Scores each sentence by the keywords it contains, then returns
     the best few *in their original order* so the result still
     reads like prose rather than a ranked list. */
  function sentences(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 12; });
  }

  function summarize(text, maxSentences) {
    maxSentences = maxSentences || 3;
    var sents = sentences(text);
    if (sents.length <= maxSentences) return sents.join(" ");

    var f = frequency(text);
    var max = 0;
    f.forEach(function (v) { if (v > max) max = v; });

    var scored = sents.map(function (s, i) {
      var ws = words(s);
      if (!ws.length) return { i: i, s: s, score: 0 };
      var sum = ws.reduce(function (acc, w) { return acc + (f.get(w) || 0) / max; }, 0);
      /* Slight lead bias — first sentences usually carry the point. */
      var position = i === 0 ? 1.25 : (i === 1 ? 1.1 : 1);
      return { i: i, s: s, score: (sum / ws.length) * position };
    });

    return scored.slice().sort(function (a, b) { return b.score - a.score; })
      .slice(0, maxSentences)
      .sort(function (a, b) { return a.i - b.i; })
      .map(function (x) { return x.s; }).join(" ");
  }

  /* ---- error explanation -------------------------------------- */
  var ERROR_PATTERNS = [
    { re: /cannot read propert(y|ies) .*(of|from) (undefined|null)/i,
      say: "Something in the chain was undefined before you indexed into it. Log the parent object, not the leaf." },
    { re: /is not a function/i,
      say: "The name resolved, but not to a function — usually a typo, a missing export, or a module that loaded in the wrong order." },
    { re: /unexpected token/i,
      say: "Parser gave up. Look immediately BEFORE the reported position — the real fault is usually one line earlier." },
    { re: /failed to fetch|networkerror|err_connection/i,
      say: "The request never completed. Check the URL, whether the host is up, and whether CORS or a policy blocked it." },
    { re: /cors|cross-origin|access-control-allow-origin/i,
      say: "The server did not return permissive CORS headers. A file:// page sends Origin: null, which the server must explicitly allow." },
    { re: /quota|storage full|exceeded/i,
      say: "Storage limit hit. Check navigator.storage.estimate() and clear old backups." },
    { re: /operation is insecure|securityerror/i,
      say: "Blocked by origin policy. Usually means this API needs a secure context, or the origin is opaque." },
    { re: /econnrefused/i,
      say: "Nothing is listening on that host:port. The service is down, bound to a different interface, or the port is wrong." },
    { re: /etimedout|timeout/i,
      say: "The peer never answered. Firewall, wrong address, or the service is hung rather than down." },
    { re: /401|unauthorized/i,
      say: "Credentials were missing or rejected. For FieldKit that means the vault is locked or the token is stale." },
    { re: /429|rate limit/i,
      say: "You tripped a rate limit. Wait for the window to pass — the relay's is 60 seconds." },
    { re: /decrypt|operationerror/i,
      say: "AES-GCM refused to decrypt. Wrong key, or the ciphertext was altered. For FieldKit that usually means the wrong password." }
  ];

  function explainError(text) {
    var hits = ERROR_PATTERNS.filter(function (p) { return p.re.test(String(text || "")); });
    if (!hits.length) {
      return { matched: false, text: "No known pattern matched. Search the exact message, and check what changed most recently." };
    }
    return { matched: true, text: hits.map(function (h) { return h.say; }).join("\n\n") };
  }

  /* ---- anomaly flags ------------------------------------------ */
  /* "This error matches N others recently" — §9's example. Uses
     token overlap, which is crude but needs no model and is
     genuinely useful on a small corpus. */
  function similarity(a, b) {
    var A = new Set(words(a)), B = new Set(words(b));
    if (!A.size || !B.size) return 0;
    var shared = 0;
    A.forEach(function (w) { if (B.has(w)) shared++; });
    return shared / Math.min(A.size, B.size);
  }

  function findSimilar(text, corpus, threshold) {
    threshold = threshold || 0.45;
    return corpus
      .map(function (c) { return { item: c, score: similarity(text, c.text || c.body || "") }; })
      .filter(function (x) { return x.score >= threshold; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  /* ---- flavour text ------------------------------------------- */
  var FLAVOR_SUBJECT = ["the drive", "the relay", "this terminal", "the vault", "the link", "the operator"];
  var FLAVOR_VERB = ["remembers", "forgets", "logs", "distrusts", "outlives", "waits on"];
  var FLAVOR_OBJECT = ["everything you type", "the last good boot", "what the network denies",
    "a password nobody wrote down", "every failed handshake", "the quiet hours"];

  function flavor(seed) {
    /* Deterministic when seeded, so a boot can reproduce its line. */
    var n = typeof seed === "number" ? seed : Math.floor(Math.random() * 1e9);
    function pick(arr, salt) { return arr[(n + salt) % arr.length]; }
    return pick(FLAVOR_SUBJECT, 0) + " " + pick(FLAVOR_VERB, 7) + " " + pick(FLAVOR_OBJECT, 13);
  }

  /* Stats worth surfacing on the home screen without a model. */
  function corpusStats(items) {
    var all = items.map(function (i) { return i.text || i.body || ""; }).join(" ");
    var f = frequency(all);
    var top = [];
    f.forEach(function (v, k) { top.push([k, v]); });
    top.sort(function (a, b) { return b[1] - a[1]; });
    return {
      items: items.length,
      words: words(all).length,
      uniqueWords: f.size,
      topTerms: top.slice(0, 10).map(function (t) { return { term: t[0], count: t[1] }; })
    };
  }

  FieldKit.provide("aiTier3", {
    tier: 3,
    name: "HEURISTIC",
    available: function () { return true; },
    tag: tag,
    summarize: summarize,
    explainError: explainError,
    similarity: similarity,
    findSimilar: findSimilar,
    flavor: flavor,
    corpusStats: corpusStats,
    words: words,

    /* The router calls this for freeform chat. Tier 3 cannot
       converse, so it answers honestly rather than pretending. */
    async chat(messages) {
      var last = messages[messages.length - 1] || {};
      var text = last.content || "";
      var err = explainError(text);
      var parts = [];
      parts.push("[HEURISTIC TIER — no model available]");
      if (err.matched) parts.push(err.text);
      else if (text.length > 220) parts.push("Summary of what you sent:\n" + summarize(text, 3));
      else parts.push("No model is reachable, so I can only pattern-match. Connect the relay for a real answer.");
      var tags = tag(text, 5);
      if (tags.length) parts.push("Keywords: " + tags.join(", "));
      return { content: parts.join("\n\n"), tier: 3 };
    }
  });
})(window.FieldKit);
