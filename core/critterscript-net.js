/* ============================================================
   FieldKit :: critterscript-net
   The commands that leave the drive.

   Everything in core/critterscript.js runs on the machine in front
   of you. These do not: each one is a round trip to the relay, and
   each one does something the drive is physically incapable of.
   That is the entry requirement for being in this file rather than
   that one. `fetch` is here not because reading a page is a big
   feature but because a script on a file:// page cannot read one
   line of the web at any length of code — no cross-origin fetch
   exists there to write. The relay can, so through the relay it
   becomes one word.

   WHAT IS DELIBERATELY ABSENT
   There is no command here that changes anything on the relay.
   No restart, no action runner, no config write, no delete. The
   relay has routes for some of that and this file does not call
   them, on purpose: a script is a thing you paste from a chat
   window and run to see what it does, and that has to stay a safe
   thing to do. Reading is safe to be curious with. Restarting a
   service somebody is using is not, and no amount of confirmation
   prompt fixes that once the command exists to be typed.

   NONE OF THESE ARE GUEST-SAFE
   Every one spends somebody's credential — the vault token, the
   relay's rate budget, an AI provider's quota. Guest mode gets the
   whole language and none of this, and says so by name when a
   guest tries.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var cs = FieldKit.service("critterscript");
  if (!cs) return;                    /* OUTPOST has no language at all */

  function relay() { return FieldKit.service("transportRelay"); }

  /* One place to fail, in words, rather than nine copies of
     "Cannot read properties of null". The three things that can be
     missing are missing for three different reasons and each has a
     different next action, so each gets its own sentence. */
  function needRelay() {
    var r = relay();
    if (!r || !r.url()) {
      throw new Error("this command goes through the relay, and no relay is set. " +
        "Open RELAY LINK and enter its address.");
    }
    var store = FieldKit.service("store");
    if (!store || !store.isUnlocked || !store.isUnlocked()) {
      throw new Error("this command goes through the relay, which needs the vault " +
        "open to prove who you are. Unlock first.");
    }
    return r;
  }

  /* A bare word is a host, not a search. Typing `fetch example.com`
     and getting "invalid url" would be the wrong lesson to teach in
     the first minute. */
  function asUrl(v) {
    var s = String(v === null || v === undefined ? "" : v).trim();
    if (!s) throw new Error("fetch needs a web address.");
    if (!/^https?:\/\//i.test(s)) {
      if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?)/i.test(s)) s = "https://" + s;
      else throw new Error("'" + s + "' is not a web address. Try something like " +
        "https://example.com — or use find if you meant to search for it.");
    }
    return s;
  }

  /* The relay answers with {error, detail}. Both matter: the error
     says what happened and the detail says what to do about it, and
     dropping the second is how a message becomes useless. */
  function relayError(e, what) {
    var msg = (e && e.message) || String(e);
    if (e && e.data && e.data.detail) msg += " " + e.data.detail;
    return new Error(what + " failed: " + msg);
  }

  var NET = { group: "web", guestSafe: false };
  var AI = { group: "ask", guestSafe: false };

  /* ---- the web, as values ---------------------------------------
     Both of these hand back the shapes the rest of the language
     already knows how to chew on — a record and a list of records —
     so nothing new has to be learned to use them. The whole reason
     `field`, `pluck` and `where` exist is so that these two
     commands need no special syntax of their own. */

  cs.command(Object.assign({
    name: "fetch",
    usage: "fetch <url>",
    minArgs: 1,
    help: "Read a web page and hand back a record: title, text, links, status. " +
      "Try: fetch example.com | field title",
    run: async function (c) {
      var r = needRelay();
      var target = asUrl(c.args[0]);
      var data;
      try { data = await r.browseText(target); }
      catch (e) { throw relayError(e, "fetch"); }
      if (!data || !data.ok) {
        throw new Error("fetch got nothing back from " + target +
          ((data && data.error) ? " — " + data.error : ""));
      }
      /* links arrive as {text, url} and stay that way. Renaming the
         field to `title` to match find's results was tempting and
         wrong: a link's words are not a title, and pretending they
         are makes `pluck title` silently work on one and not the
         other. */
      return {
        url: data.url,
        status: data.status,
        type: data.type || "",
        title: data.title || "",
        text: data.text || "",
        links: Array.isArray(data.links) ? data.links : [],
        truncated: !!data.truncated
      };
    }
  }, NET));

  cs.command(Object.assign({
    name: "find",
    usage: "find <words...>",
    minArgs: 1,
    help: "Search the web. Hands back a list of records with title and url. " +
      "Try: find godot navmesh | first | field url | fetch $it",
    run: async function (c) {
      var r = needRelay();
      var q = c.args.map(function (a) { return cs.show(a); }).join(" ").trim();
      if (!q) throw new Error("find needs something to search for.");
      var data;
      try { data = await r.browseFind(q); }
      catch (e) { throw relayError(e, "find"); }
      if (!data || !data.ok) throw new Error("the search came back empty-handed.");
      return Array.isArray(data.results) ? data.results : [];
    }
  }, NET));

  /* ---- the model ------------------------------------------------
     ai-router picks the tier; nothing here does. That means `ask`
     keeps working when the relay's AI is down, because tiers 2 and 3
     run locally — the answer gets worse and the script does not
     break, which is the right failure for a command you might have
     in the middle of a loop. */

  function ai() {
    var a = FieldKit.service("ai");
    if (!a) throw new Error("the AI router is not loaded in this build.");
    return a;
  }

  cs.command(Object.assign({
    name: "ask",
    usage: "ask <question...>",
    minArgs: 1,
    help: "Put a question to the AI and hand back its answer as text. " +
      "Try: fetch $url | field text | ask \"summarise this: $it\"",
    run: async function (c) {
      var q = c.args.map(function (a) { return cs.show(a); }).join(" ").trim();
      if (!q) throw new Error("ask needs a question.");
      /* Capped, and low: an answer that arrives as forty paragraphs
         is unusable in a pipeline and expensive to have been wrong
         about. Ask again for more rather than paying for it every
         time by default. */
      var out = await ai().chat([{ role: "user", content: q }], { maxTokens: 700 });
      return (out && out.text) ? String(out.text).trim() : "";
    }
  }, AI));

  cs.command(Object.assign({
    name: "sum-up",
    usage: "sum-up <text>",
    minArgs: 1,
    help: "Shorten a long piece of text to its point. " +
      "Try: fetch $url | field text | sum-up",
    run: async function (c) {
      var t = cs.show(c.args[0]);
      if (!t.trim()) return "";
      var out = await ai().summarize(t, { maxTokens: 400 });
      return (out && out.text) ? String(out.text).trim() : "";
    }
  }, AI));

  /* ---- the network it can see -----------------------------------
     Read-only by construction: the relay's /status route probes and
     reports and has no way to change a service, so there is nothing
     to be careful about here beyond not pretending an unreachable
     service is a fault in the script. */

  cs.command(Object.assign({
    name: "services",
    group: "web",
    guestSafe: false,
    usage: "services",
    help: "The Bastion services the relay can see, as a list of records. " +
      "Try: services | where ok false | pluck name",
    run: async function () {
      var r = needRelay();
      var data;
      try { data = await r.status(); }
      catch (e) { throw relayError(e, "services"); }
      var list = (data && Array.isArray(data.services)) ? data.services : [];
      return list.map(function (s) {
        return {
          name: s.name || "",
          ok: !!s.ok,
          kind: s.kind || "",
          status: s.status === undefined ? null : s.status,
          ms: s.ms === undefined ? null : s.ms,
          note: s.note || "",
          error: s.error || ""
        };
      });
    }
  }));

  /* Named `uptime` rather than `relay` because the terminal already
     has a `relay` command that prints a human status panel, and two
     things with one name is how you get a bug report nobody can
     reproduce. */
  cs.command({
    name: "uptime",
    group: "web",
    guestSafe: false,
    usage: "uptime",
    help: "Ask the relay how it is: version, features, its clock. " +
      "Try: uptime | field time",
    run: async function () {
      var r = needRelay();
      var h;
      try { h = await r.health(); }
      catch (e) { throw relayError(e, "uptime"); }
      return {
        up: !!(h && h.up),
        version: (h && h.version) || 0,
        vault: !!(h && h.vaultProvisioned),
        features: (h && Array.isArray(h.features)) ? h.features : [],
        time: (h && h.time) || ""
      };
    }
  });

  FieldKit.provide("critterscriptNet", {
    /* Nothing here needs calling from outside. The export exists so
       the self-test can assert the file loaded and registered, which
       is otherwise invisible until somebody types `fetch`. */
    commands: ["fetch", "find", "ask", "sum-up", "services", "uptime"]
  });
})(window.FieldKit);
