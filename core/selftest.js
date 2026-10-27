/* ============================================================
   FieldKit :: selftest
   Three tiers, each a superset of the ambition of the last:

     QUICK       runs at every boot, before the desktop appears.
                 Must stay fast and must never write anything.
     FULL        manual. Adds crypto round-trips, store I/O, and
                 relay/AI reachability.
     EXERCISE    manual, slow, and the point of this file: it
                 actually *drives every feature* — mounts each
                 module for real, sends a premade message to the
                 AI, encodes a QR, opens and closes a window —
                 then puts everything back exactly as it found it.

   EXERCISE exists so the drive can be tested somewhere with no
   terminal and no dev tools. Run it, read the verdict, hit COPY
   REPORT, and you have a complete picture of what works.

   Adding a feature? Two options, and the second is preferred:
     1. Add a check to the relevant group in buildExercise().
     2. Give the module a `selfcheck()` — the exercise suite mounts
        every registered module and runs whatever probes it returns,
        so a module ships its own tests and nothing central needs
        editing. tests/contract.test.js fails the build if a module
        forgets. See FIELDKIT_PROJECT.md §10F.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var PROBE_TYPE = "selftest-probe";

  function check(name, critical, fn) {
    return { name: name, critical: !!critical, run: fn };
  }

  function group(title, checks) {
    return { title: title, checks: checks.filter(Boolean) };
  }

  function flatten(groups) {
    var out = [];
    groups.forEach(function (g) {
      g.checks.forEach(function (c) {
        out.push({ name: c.name, group: g.title, critical: c.critical, run: c.run });
      });
    });
    return out;
  }

  /* ---- shared helpers ----------------------------------------- */
  function svc(n) { return FieldKit.service(n); }
  /* A missing service is two different situations and they deserve
     two different verdicts.

     In the full build, `crypto` or `store` being absent means the
     boot went wrong and the check should fail loudly. In OUTPOST
     (§14.1) those files are not in the manifest at all — that is the
     entire design — so the same absence is not a fault and must not
     be reported as one. A build that shows nine red rows for
     features it was deliberately built without teaches you to ignore
     red rows.

     "SKIPPED — " is the existing convention the runner already reads,
     so naming the absence is all this has to do. */
  var NOT_IN_OUTPOST = ["crypto", "queue", "ai", "aiTier3", "aiTier2", "diff", "backup", "files"];

  function onOutpost() {
    var boot = FieldKit.service("boot");
    return !!(boot && boot.OUTPOST);
  }

  /* Call before reporting a missing service as a fault. Returns if
     the absence is a real problem; throws a SKIPPED the runner
     understands if the service was never meant to be in this build. */
  function absenceIsFine(n) {
    if (onOutpost() && NOT_IN_OUTPOST.indexOf(n) >= 0) {
      throw new Error("SKIPPED — '" + n + "' is not part of the OUTPOST build");
    }
  }

  function need(n) {
    var s = FieldKit.service(n);
    if (!s) {
      absenceIsFine(n);
      throw new Error("service '" + n + "' is not registered");
    }
    return s;
  }
  function store() { return need("store"); }

  function requireUnlocked() {
    var s = store();
    if (!s.isUnlocked()) throw new Error("vault is locked");
    return s;
  }

  /* A guest session has no vault, so vault-dependent checks are
     skipped rather than reported as failures. */
  function isGuest() {
    var g = svc("guest");
    return !!(g && g.active());
  }

  function skipIfGuest() {
    if (isGuest()) throw new Error("SKIPPED — guest session has no vault");
  }

  /* ---- QUICK: boot, fast, read-only --------------------------- */
  var QUICK_GROUPS = [
    group("PLATFORM", [
      check("SECURE CONTEXT", true, async function () {
        if (!window.isSecureContext) throw new Error("origin is not a secure context");
        return "ok";
      }),
      check("CRYPTO SUBSYSTEM", true, async function () {
        var c = svc("crypto");
        if (!c) absenceIsFine("crypto");
        if (!c || !c.available) throw new Error("crypto.subtle unavailable");
        return "subtle present";
      }),
      check("LOCAL STORAGE", true, async function () {
        localStorage.setItem("__fk_t", "1");
        if (localStorage.getItem("__fk_t") !== "1") throw new Error("readback mismatch");
        localStorage.removeItem("__fk_t");
        return "read/write";
      }),
      check("INDEXED DB", true, async function () {
        var t = svc("transportLocal");
        if (!t) {
          /* OUTPOST has no vault transport, but it does keep its
             local store in IndexedDB, and whether that opened is
             exactly as worth knowing here — it is the difference
             between a session that survives a reload and one that
             does not. */
          var s = svc("store");
          if (onOutpost() && s && s.persistent) {
            if (!s.persistent()) {
              throw new Error("SKIPPED — memory only: " +
                ((s.storageError && s.storageError()) || "storage is unavailable here"));
            }
            return "open (outpost local store)";
          }
          throw new Error("local transport missing");
        }
        if (!(await t.ping())) throw new Error("could not open database");
        return "open";
      }),
      check("MODULE REGISTRY", false, async function () {
        var n = Object.keys(FieldKit.modules()).length;
        var dead = Object.keys(FieldKit.failedModules()).length;
        if (dead) throw new Error(dead + " module(s) failed to load");
        return n + " loaded";
      }),
      /* QUICK runs BEFORE boot reaches connect(), so at boot this
         store has not been asked about anything yet. Reporting that
         as "no vault yet — first run" was wrong on every launch that
         had a vault, which is all of them after the first — and it
         is the kind of wrong that trains you to ignore the row.

         Run from DIAGNOSTICS later, the store is initialised and the
         same check means what it says. */
      check("VAULT HEADER", false, async function () {
        var s = svc("store");
        if (!s) throw new Error("store not initialised");
        if (s.initialised && !s.initialised()) {
          throw new Error("SKIPPED — the vault has not been reached yet at this point in boot");
        }
        if (!s.hasVault()) throw new Error("no vault yet — first run");
        return "present";
      })
    ])
  ];

  /* ---- FULL: manual, allowed to be slow ----------------------- */
  var FULL_GROUPS = QUICK_GROUPS.concat([
    group("CRYPTO", [
      check("KDF BENCHMARK", false, async function () {
        var ms = await need("crypto").benchmark();
        if (ms > 3000) throw new Error(ms + " ms — too slow, lower the iteration count");
        return ms + " ms";
      }),
      check("ENCRYPT ROUNDTRIP", true, async function () {
        skipIfGuest();
        var v = requireUnlocked().vault();
        var probe = { probe: true, at: Date.now(), nonce: Math.floor(performance.now()) };
        var back = await v.open(await v.seal(probe));
        if (back.nonce !== probe.nonce) throw new Error("roundtrip mismatch");
        return "verified";
      })
    ]),
    group("STORE", [
      check("STORE WRITE/READ/DELETE", true, async function () {
        var s = requireUnlocked();
        var meta = await s.put(PROBE_TYPE, { hello: "fieldkit", at: Date.now() });
        var back = await s.get(meta.id);
        if (!back || back.hello !== "fieldkit") throw new Error("readback failed");
        await s.remove(meta.id);
        return "verified";
      }),
      check("OFFLINE QUEUE", false, async function () {
        var n = await need("queue").count();
        return n === 0 ? "empty" : n + " op(s) pending";
      })
    ]),
    group("NETWORK", [
      check("RELAY REACHABILITY", false, async function () {
        var relay = svc("transportRelay");
        if (!relay) throw new Error("relay transport not registered");
        var url = svc("settings") && svc("settings").get("relayUrl");
        if (!url) throw new Error("no relay URL configured — set one in RELAY LINK");
        var t0 = performance.now();
        var up = await relay.ping();
        var ms = Math.round(performance.now() - t0);
        if (!up) throw new Error("unreachable after " + ms + " ms");
        return "reachable in " + ms + " ms";
      }),
      check("AI ROUND TRIP", false, async function () {
        return await withDeadline(AI_DEADLINE_MS, need("ai").selftest(),
          "The model is reachable but slower than this check waits. " +
          "Open AI CHAT and ask it something — if that answers, nothing is wrong here.");
      })
    ])
  ]);

  /* ============================================================
     EXERCISE
     ============================================================ */

  /* Everything the exercise creates is registered here and undone in
     a finally block, so a failure halfway through still leaves the
     vault and the desktop exactly as they were. */
  function makeSandbox() {
    var records = [], nodes = [], undo = [];

    return {
      async put(type, data, opts) {
        var meta = await store().put(type, data, opts);
        records.push(meta.id);
        return meta;
      },
      track: function (id) { records.push(id); return id; },
      onCleanup: function (fn) { undo.push(fn); },

      /* Offscreen but laid out: modules that measure themselves need
         real geometry, so this is positioned away rather than hidden.
         `inert` keeps it out of the focus order. */
      host: function () {
        var d = document.createElement("div");
        d.className = "fk-selftest-host";
        d.setAttribute("aria-hidden", "true");
        d.style.cssText = "position:fixed;left:-100000px;top:0;width:900px;height:620px;" +
          "overflow:hidden;pointer-events:none;opacity:0";
        try { d.inert = true; } catch (e) { /* older engine, offscreen is enough */ }
        document.body.appendChild(d);
        nodes.push(d);
        return d;
      },

      async cleanup() {
        var errs = 0;
        for (var i = undo.length - 1; i >= 0; i--) {
          try { await undo[i](); }
          catch (e) { errs++; FieldKit.log("warn", "selftest", "cleanup step failed: " + e.message); }
        }
        nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
        var s = svc("store");
        if (s && s.isUnlocked()) {
          for (var j = 0; j < records.length; j++) {
            try { await s.remove(records[j]); }
            catch (e) { errs++; }
          }
        }
        FieldKit.log("info", "selftest", "sandbox cleaned: " + records.length +
          " record(s), " + nodes.length + " node(s), " + errs + " error(s)");
        return { records: records.length, nodes: nodes.length, errors: errs };
      }
    };
  }

  function preview(text, n) {
    var t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    n = n || 60;
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  /* The message the AI actually gets. Deliberately something with a
     checkable answer, so "the model replied" and "the model replied
     with sense" are different results. */
  var AI_PROBE = {
    prompt: "Reply with exactly the word FIELDKIT in capitals, and nothing else.",
    expect: /FIELDKIT/i
  };

  /* How long any one AI check waits before it stops waiting.

     The relay transport caps a request at 125 seconds, which is the
     right ceiling for a real conversation and the wrong one here:
     four AI checks each waiting that long is eight minutes of a
     panel that looks frozen, with nothing on screen to say whether
     the model is thinking or the request died. A model being slower
     than this is not a fault in FieldKit, so hitting it is a skip
     with an explanation rather than a red row. */
  var AI_DEADLINE_MS = 60000;

  function withDeadline(ms, promise, hint) {
    var timer = null;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        timer = setTimeout(function () {
          reject(new Error("SKIPPED — no answer within " + Math.round(ms / 1000) +
            " s. " + hint));
        }, ms);
      })
    ]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  /* Reasoning models emit their working first, inside <think> tags,
     and the answer after it. Stripping matters in both directions: a
     check that searched the whole reply would pass on a model that
     merely thought about the right answer, and a preview that shows
     the working is unreadable in a one-line row. */
  function stripReasoning(text) {
    var t = String(text == null ? "" : text);
    t = t.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
    /* A stray closing tag with no opener means the opener was eaten
       somewhere upstream; everything before it is still working. */
    t = t.replace(/^[\s\S]*<\/(?:think|thinking|reasoning)>/i, "");
    return t.trim();
  }

  /* Returns the same groups minus the named checks. */
  function without(groups, names) {
    return groups.map(function (g) {
      return group(g.title, g.checks.filter(function (c) {
        return names.indexOf(c.name) < 0;
      }));
    }).filter(function (g) { return g.checks.length; });
  }

  /* ============================================================
     PUTTING THE ROOM BACK

     The exercise mounts every module for real, one after another,
     into an offscreen host. That is the only way to test them, and
     it has a cost: a module is written on the assumption that it is
     the visible one, so mounting it can touch things that live
     outside its own host — a setting, a class on <body>, an overlay
     appended to the document rather than to the panel.

     Individually each is harmless. Run forty of them in a row and
     the desktop comes back subtly wrong: SETTINGS laid out oddly,
     a stray absolutely-positioned element over the top, the wrong
     theme. Refreshing fixed it, which is exactly the kind of "just
     restart it" that should not be the answer.

     So the exercise snapshots the environment before it starts and
     puts it back afterwards — and, more usefully, SAYS what it had
     to put back, because a module that needs this is a module with
     a bug worth finding rather than one to keep papering over. */
  function snapshotEnvironment() {
    var s = svc("settings");
    return {
      settings: s ? s.all() : null,
      bodyClass: document.body.className,
      rootStyle: document.documentElement.getAttribute("style") || "",
      theme: document.documentElement.getAttribute("data-theme") || "",
      /* Direct children only. Anything deeper belongs to something
         that owns it; anything appended straight to <body> during
         the exercise is a leak. */
      bodyChildren: Array.prototype.slice.call(document.body.children)
    };
  }

  function restoreEnvironment(snap) {
    var changed = [];
    var s = svc("settings");

    if (snap.settings && s) {
      var now = s.all();
      Object.keys(snap.settings).forEach(function (k) {
        if (JSON.stringify(now[k]) !== JSON.stringify(snap.settings[k])) {
          changed.push("setting '" + k + "'");
          s.set(k, snap.settings[k]);
        }
      });
      /* A key that did not exist before and does now. Set back to
         its default rather than left, since there is no "unset". */
      Object.keys(now).forEach(function (k) {
        if (!(k in snap.settings)) {
          changed.push("new setting '" + k + "'");
          s.set(k, s.DEFAULTS[k]);
        }
      });
    }

    if (document.body.className !== snap.bodyClass) {
      changed.push("a class on <body>");
      document.body.className = snap.bodyClass;
    }
    if ((document.documentElement.getAttribute("style") || "") !== snap.rootStyle) {
      changed.push("an inline style on <html>");
      if (snap.rootStyle) document.documentElement.setAttribute("style", snap.rootStyle);
      else document.documentElement.removeAttribute("style");
    }
    if ((document.documentElement.getAttribute("data-theme") || "") !== snap.theme) {
      changed.push("the theme");
      if (snap.theme) document.documentElement.setAttribute("data-theme", snap.theme);
    }

    /* Stray nodes. The sandbox removes the hosts it created; this
       catches anything a module appended to <body> itself — a modal
       overlay, a toast host, a measuring div — which is the one that
       actually shows up as "the layout is messed up". */
    Array.prototype.slice.call(document.body.children).forEach(function (n) {
      if (snap.bodyChildren.indexOf(n) >= 0) return;
      /* Toasts are the app talking to the user about the run that
         just finished. Leaving them is correct. */
      if (n.id === "fk-toasts") return;
      changed.push("<" + n.tagName.toLowerCase() + (n.className ? " class=" + n.className : "") + ">");
      if (n.parentNode) n.parentNode.removeChild(n);
    });

    /* Re-apply the theme through the real path so anything derived
       from it is recomputed rather than left half-swapped. */
    var u = svc("ui");
    if (u && typeof u.applyTheme === "function" && snap.settings && snap.settings.theme) {
      try { u.applyTheme(snap.settings.theme); } catch (e) { /* cosmetic */ }
    }

    return changed;
  }

  function buildExercise(sb) {
    /* The quick pass's AI ROUND TRIP and the exercise's PREMADE
       MESSAGE ROUND TRIP prove the same thing with the same model
       call. Running both means waiting for the model twice and
       spending two requests against the relay's rate limit to learn
       one fact — and on a slow model that is most of why the
       exercise felt like it had hung. The exercise keeps the one
       that shows you the answer. */
    var groups = without(QUICK_GROUPS, ["AI ROUND TRIP"]);

    /* ---- crypto ---- */
    groups.push(group("CRYPTO", [
      check("KDF BENCHMARK", false, async function () {
        var ms = await need("crypto").benchmark();
        if (ms > 3000) throw new Error(ms + " ms — too slow for this machine");
        return ms + " ms per derivation";
      }),
      check("SEAL / OPEN ROUNDTRIP", true, async function () {
        skipIfGuest();
        var v = requireUnlocked().vault();
        var probe = { nested: { list: [1, 2, 3], when: new Date().toISOString() }, n: Math.random() };
        var back = await v.open(await v.seal(probe));
        if (JSON.stringify(back) !== JSON.stringify(probe)) throw new Error("roundtrip altered the value");
        return "structure preserved";
      }),
      check("CIPHERTEXT IS OPAQUE", true, async function () {
        skipIfGuest();
        var v = requireUnlocked().vault();
        var marker = "MARKER-" + Math.random().toString(36).slice(2);
        var box = await v.seal({ secret: marker });
        if (JSON.stringify(box).indexOf(marker) >= 0) throw new Error("plaintext visible in the sealed box");
        return "no plaintext in the box";
      }),
      check("TAMPER DETECTION", true, async function () {
        skipIfGuest();
        var v = requireUnlocked().vault();
        var box = await v.seal({ value: "authentic" });
        /* Flip one character of the ciphertext — AES-GCM must refuse
           it rather than returning garbage. */
        var i = Math.floor(box.ct.length / 2);
        var swapped = box.ct[i] === "A" ? "B" : "A";
        var bad = { iv: box.iv, ct: box.ct.slice(0, i) + swapped + box.ct.slice(i + 1) };
        var opened = null;
        try { opened = await v.open(bad); } catch (e) { return "modified ciphertext rejected"; }
        throw new Error("tampered ciphertext decrypted to " + preview(JSON.stringify(opened), 40));
      }),
      check("RECOVERY KEY CODEC", false, async function () {
        var c = need("crypto");
        var bytes = c.randomBytes(20);
        var str = c.encodeRecovery(bytes);
        var back = c.decodeRecovery(str);
        for (var i = 0; i < bytes.length; i++) {
          if (bytes[i] !== back[i]) throw new Error("decode mismatch at byte " + i);
        }
        if (/[ILOU]/.test(str.replace(/-/g, ""))) throw new Error("ambiguous characters in the alphabet");
        return str.split("-").length + " blocks, roundtrip clean";
      })
    ]));

    /* ---- store ---- */
    groups.push(group("STORE", [
      check("WRITE / READ / DELETE", true, async function () {
        var s = requireUnlocked();
        var meta = await sb.put(PROBE_TYPE, { hello: "fieldkit", at: Date.now() });
        var back = await s.get(meta.id);
        if (!back || back.hello !== "fieldkit") throw new Error("readback failed");
        await s.remove(meta.id);
        if (await s.get(meta.id)) throw new Error("record survived deletion");
        return "verified";
      }),
      check("UPDATE KEEPS THE SAME ID", true, async function () {
        var s = requireUnlocked();
        var first = await sb.put(PROBE_TYPE, { v: 1 });
        var second = await store().put(PROBE_TYPE, { v: 2 }, { id: first.id });
        if (second.id !== first.id) throw new Error("update created a new record");
        var back = await s.get(first.id);
        if (!back || back.v !== 2) throw new Error("update did not take");
        return "id stable across update";
      }),
      check("LIST FILTERS BY TYPE", false, async function () {
        var s = requireUnlocked();
        await sb.put(PROBE_TYPE, { marker: true });
        var mine = await s.list(PROBE_TYPE);
        if (!mine.length) throw new Error("probe record not listed");
        if (mine.some(function (r) { return r.meta.type !== PROBE_TYPE; })) {
          throw new Error("list returned records of another type");
        }
        return mine.length + " probe record(s) isolated";
      }),
      check("SCHEMA VERSION STAMPED", false, async function () {
        var s = requireUnlocked();
        var meta = await sb.put(PROBE_TYPE, { x: 1 });
        var all = await s.list(PROBE_TYPE);
        var row = all.find(function (r) { return r.id === meta.id; });
        if (!row || row.meta.schemaVersion !== FieldKit.SCHEMA_VERSION) {
          throw new Error("expected schemaVersion " + FieldKit.SCHEMA_VERSION +
            ", got " + (row && row.meta.schemaVersion));
        }
        return "v" + FieldKit.SCHEMA_VERSION;
      }),
      check("STORE STATE", false, async function () {
        var s = store();
        return s.state() + " via " + s.transportName() +
          (s.canReadHistory() ? ", history readable" : ", history not loaded");
      }),
      check("OFFLINE QUEUE", false, async function () {
        var n = await need("queue").count();
        return n === 0 ? "empty" : n + " op(s) awaiting upload";
      })
    ]));

    /* ---- network ----
       DIAGNOSTICS is guestSafe, so a guest can run the exercise and
       read the report. Every other group that touches owner state
       guards for that — CRYPTO skips, MODULE groups check
       allowed(), SECURITY skips — and this one did not, so the
       report handed a guest the relay's private tailnet address and
       then confirmed it was live from their network. RELAY LINK,
       whose whole job is that URL, is correctly sealed; printing it
       here went around the seal. */
    groups.push(group("NETWORK", [
      check("ACTIVE TRANSPORT", false, async function () {
        return store().transportName();
      }),
      check("RELAY CONFIGURED", false, async function () {
        skipIfGuest();
        var url = svc("settings") && svc("settings").get("relayUrl");
        if (!url) throw new Error("no relay URL set — configure it in RELAY LINK");
        return url;
      }),
      check("RELAY PING", false, async function () {
        skipIfGuest();
        var relay = svc("transportRelay");
        if (!relay) throw new Error("relay transport not registered");
        if (!(svc("settings") && svc("settings").get("relayUrl"))) throw new Error("no relay URL set");
        var t0 = performance.now();
        var up = await relay.ping();
        var ms = Math.round(performance.now() - t0);
        if (!up) throw new Error("unreachable after " + ms + " ms");
        return "reachable in " + ms + " ms";
      }),
      check("RELAY RECORD ROUNDTRIP", false, async function () {
        skipIfGuest();
        var s = requireUnlocked();
        if (s.transportName() !== "relay") throw new Error("not running against the relay");
        var meta = await sb.put(PROBE_TYPE, { relayProbe: true, at: Date.now() });
        await s.hydrate();
        var back = await s.get(meta.id);
        if (!back || !back.relayProbe) throw new Error("record did not survive a relay round trip");
        return "written, re-fetched, decrypted";
      }),
      check("SYNC", false, async function () {
        var r = await store().sync();
        if (r.skipped) return "skipped: " + r.skipped;
        return r.pushed + " pushed, " + r.failed + " failed";
      })
    ]));

    /* ---- AI: the headline group ---- */
    groups.push(group("AI", [
      check("ROUTER PRESENT", false, async function () {
        need("ai");
        return "registered";
      }),
      check("TIER AVAILABILITY", false, async function () {
        /* availability() is keyed by tier number, not an array. */
        var tiers = await need("ai").availability();
        var keys = Object.keys(tiers);
        if (!keys.length) throw new Error("availability returned nothing");
        return keys.map(function (k) {
          var t = tiers[k];
          return "T" + k + " " + (t.available ? "UP" : "down") +
            (t.detail ? " (" + t.detail + ")" : "");
        }).join("  ·  ");
      }),
      /* The one the whole exercise exists for: a real message, sent
         for real, with the answer shown. */
      check("PREMADE MESSAGE ROUND TRIP", false, async function () {
        var t0 = performance.now();
        /* No maxTokens, and its absence is the fix.

           There was a 40-token cap here and it was the whole reason
           this row warned against a model that works fine in AI CHAT:
           a model that opens with a sentence of preamble, or one that
           thinks out loud first, spends the budget before it ever
           reaches the word — so the check reported "off-prompt" for a
           model that was about to be right. The prompt asks for one
           word. Trust it, and bound the WAIT instead of the LENGTH. */
        var r = await withDeadline(AI_DEADLINE_MS,
          need("ai").chat([{ role: "user", content: AI_PROBE.prompt }], { temperature: 0 }),
          "That is a slow model, not a broken one — AI CHAT will still answer.");
        var ms = Math.round(performance.now() - t0);
        if (!r || !r.content) throw new Error("no content returned after " + ms + " ms");

        if (r.tier === 3) {
          /* Not a failure — this is the designed floor. It is a
             warning because it means no model answered. */
          throw new Error("answered by tier 3 heuristics in " + ms + " ms" +
            (r.reason ? " — " + r.reason : " — no model reachable"));
        }

        var answer = stripReasoning(r.content);
        if (!AI_PROBE.expect.test(answer)) {
          /* Three different diagnoses, and they were all one message
             before. Cut off, still thinking, and genuinely off-prompt
             need different things done about them. */
          if (r.truncated) {
            throw new Error("tier " + r.tier + " was cut off after " + ms +
              " ms before it answered — something upstream capped the reply " +
              "(finish_reason: " + (r.finishReason || "length") + ")");
          }
          if (!answer && r.content) {
            throw new Error("tier " + r.tier + " spent all " + ms +
              " ms reasoning and never got to an answer");
          }
          throw new Error("tier " + r.tier + " replied in " + ms + " ms but off-prompt: \"" +
            preview(answer, 50) + "\"");
        }
        return "tier " + r.tier + " in " + ms + " ms: \"" + preview(answer, 40) + "\"";
      }),
      check("CAPABILITY: SUMMARIZE", false, async function () {
        var text = "The relay went down at 09:14 after the container restarted. " +
          "Tailscale came up in userspace mode but the proxy port was not yet listening. " +
          "Retrying the health check after ten seconds succeeded. " +
          "Root cause was start ordering, not networking.";
        var out = await withDeadline(AI_DEADLINE_MS,
          need("ai").summarize(text, { sentences: 2 }),
          "Summarising is a longer generation than the probe — a slow model will lose this one first.");
        if (!out || typeof out.text !== "string" || !out.text.trim()) {
          throw new Error("no summary text returned");
        }
        if (out.text.length >= text.length) throw new Error("summary was not shorter than the input");
        return "tier " + out.tier + ": \"" + preview(out.text, 50) + "\"";
      }),
      check("CAPABILITY: TAG", false, async function () {
        var out = await withDeadline(AI_DEADLINE_MS,
          need("ai").tag("nginx reverse proxy returned 502 after the docker container restarted",
            { limit: 5 }),
          "A slow model, not a broken one.");
        if (!out || !Array.isArray(out.tags) || !out.tags.length) throw new Error("no tags produced");
        if (out.tags.length > 5) throw new Error("limit ignored — got " + out.tags.length + " tags");
        return "tier " + out.tier + ": " + out.tags.join(", ");
      }),
      check("TIER 3 FLOOR (FORCED)", true, async function () {
        /* The floor must work with no network at all — force past
           tiers 1 and 2 and confirm something still comes back. */
        var r = await need("ai").chat([{ role: "user", content: "TypeError: undefined is not a function" }],
          { forceTier: 3 });
        if (!r || !r.content) throw new Error("heuristic tier returned nothing");
        if (r.tier !== 3) throw new Error("forceTier ignored — answered by tier " + r.tier);
        return "\"" + preview(r.content, 50) + "\"";
      }),
      check("HEURISTIC SIMILARITY", false, async function () {
        var t3 = need("aiTier3");
        var a = "relay unreachable after container restart";
        var near = t3.similarity(a, "relay was unreachable once the container restarted");
        var far = t3.similarity(a, "the wallpaper gradient looks wrong in violet");
        if (!(near > far)) throw new Error("similar text did not score above unrelated text (" +
          near.toFixed(2) + " vs " + far.toFixed(2) + ")");
        return "related " + near.toFixed(2) + " > unrelated " + far.toFixed(2);
      })
    ]));

    /* ---- engines ---- */
    groups.push(group("ENGINES", [
      check("DIFF RECONSTRUCTION", true, async function () {
        var d = need("diff");
        var A = "alpha\nbravo\ncharlie\ndelta\necho";
        var B = "alpha\nbravo modified\ncharlie\nfoxtrot\ndelta\necho";
        var rows = d.diffLines(A, B);
        /* The real test of a diff engine: both sides must be exactly
           rebuildable from its output. Unchanged rows are "eq". */
        var left = rows.filter(function (r) { return r.type === "eq" || r.type === "del"; })
          .map(function (r) { return r.text; }).join("\n");
        var right = rows.filter(function (r) { return r.type === "eq" || r.type === "add"; })
          .map(function (r) { return r.text; }).join("\n");
        if (left !== A) throw new Error("left side did not reconstruct");
        if (right !== B) throw new Error("right side did not reconstruct");
        var st = d.stats(rows);
        return st.added + " added, " + st.removed + " removed, both sides exact";
      }),
      check("QR ENCODE", true, async function () {
        var qr = need("qr");
        var code = qr.encode("https://github.com/example/fieldkit");
        if (code.size !== 17 + code.version * 4) throw new Error("size does not match version");
        if (!code.get(0, 0) || !code.get(0, code.size - 1)) throw new Error("finder patterns missing");
        if (!code.get(code.size - 8, 8)) throw new Error("fixed dark module missing");
        return "v" + code.version + " " + code.size + "x" + code.size + ", mask " + code.mask;
      }),
      check("QR OVERFLOW REFUSED", false, async function () {
        var qr = need("qr");
        try { qr.encode("x".repeat(qr.MAX_BYTES + 1)); }
        catch (e) { return "refused with: " + preview(e.message, 46); }
        throw new Error("an over-capacity payload was accepted");
      }),
      check("QR SVG OUTPUT", false, async function () {
        var qr = need("qr");
        var svg = qr.toSVG(qr.encode("FIELDKIT"), { scale: 4 });
        if (svg.indexOf("<svg") !== 0) throw new Error("not an svg document");
        if (/script|xlink/i.test(svg)) throw new Error("svg contains unexpected markup");
        return Math.round(svg.length / 1024 * 10) / 10 + " KB, self-contained";
      })
    ]));

    /* ---- security ---- */
    groups.push(group("SECURITY", [
      check("GUEST GATING FAILS CLOSED", true, async function () {
        var g = svc("guest");
        if (!g) throw new Error("guest service not registered");
        if (g.active()) return "guest session active — all unflagged modules sealed";
        /* Not in a guest session, so verify the rule itself rather
           than its effect. */
        var mods = FieldKit.modules();
        var unflagged = Object.keys(mods).filter(function (id) { return !mods[id].guestSafe; });
        return unflagged.length + " module(s) would be sealed for a guest";
      }),
      check("SCREEN LOCK", false, async function () {
        var lock = svc("lockscreen");
        if (!lock) throw new Error("lockscreen not registered");
        if (isGuest()) throw new Error("SKIPPED — no vault in a guest session");
        requireUnlocked();

        if (await lock.hasPin()) {
          /* Never overwrite a real PIN: the hash cannot be reversed,
             so setting a probe PIN would lock the user out of their
             own screen lock. Verify negatively instead. */
          if (await lock.verify("000000")) throw new Error("a placeholder PIN was accepted");
          return "PIN set — wrong PIN correctly rejected (real PIN left untouched)";
        }

        var probePin = "482913";
        await lock.setPin(probePin);
        sb.onCleanup(function () { return lock.clearPin(); });
        if (!(await lock.verify(probePin))) throw new Error("correct PIN was rejected");
        if (await lock.verify("482914")) throw new Error("wrong PIN was accepted");
        await lock.clearPin();
        return "set, verified, rejected a wrong PIN, cleared";
      }),
      check("VAULT METADATA EXPOSURE", false, async function () {
        skipIfGuest();
        var s = requireUnlocked();
        var rows = await s.list();
        /* Documented and deliberate: metadata is plaintext so sync
           can work. Stated here so it stays a known quantity. */
        return rows.length + " record(s); type and timestamps are plaintext by design, content is not";
      })
    ]));

    /* ---- interface ---- */
    groups.push(group("INTERFACE", [
      check("THEME SWITCHING", false, async function () {
        var ui = need("ui");
        var was = ui.currentTheme();
        sb.onCleanup(function () { ui.applyTheme(was); });
        var ids = Object.keys(ui.THEMES);
        for (var i = 0; i < ids.length; i++) {
          if (ui.applyTheme(ids[i]) !== ids[i]) throw new Error("theme " + ids[i] + " did not apply");
        }
        ui.applyTheme(was);
        return ids.length + " palettes applied and restored to " + was.toUpperCase();
      }),
      check("WALLPAPER", false, async function () {
        var shell = svc("shell");
        if (!shell || !shell.desktop()) throw new Error("desktop not built");
        var settings = need("settings");
        var was = settings.get("wallpaper");
        sb.onCleanup(function () { shell.setWallpaper(was || null); });
        shell.setWallpaper("radial-gradient(circle, rgba(255,255,255,.05), transparent 60%)");
        var applied = shell.desktop().classList.contains("has-wallpaper");
        shell.setWallpaper(was || null);
        if (!applied) throw new Error("wallpaper did not apply");
        return "set and restored";
      }),
      check("WINDOW LIFECYCLE", true, async function () {
        var shell = svc("shell");
        if (!shell || !shell.desktop()) throw new Error("desktop not built");
        var ids = Object.keys(FieldKit.modules());
        var target = ids.indexOf("dev-tools") >= 0 ? "dev-tools" : ids[0];
        if (!target) throw new Error("no modules registered");
        var alreadyOpen = shell.openWindows().indexOf(target) >= 0;
        if (alreadyOpen) return "SKIPPED — " + target + " is already open";

        var rec = shell.open(target);
        if (!rec) throw new Error("open() returned nothing for " + target);
        shell.focus(target);
        shell.minimize(target);
        shell.focus(target);
        var seen = shell.openWindows().indexOf(target) >= 0;
        shell.close(target);
        if (!seen) throw new Error("window never appeared in the window list");
        if (shell.openWindows().indexOf(target) >= 0) throw new Error("window survived close()");
        return "open → focus → minimise → focus → close on " + target;
      }),
      check("TOAST", false, async function () {
        var t = need("ui").toast("SELF-TEST PROBE", "info");
        if (!t || !t.parentNode) throw new Error("toast was not attached");
        if (t.parentNode) t.parentNode.removeChild(t);
        return "rendered";
      }),
      check("SOUND ENGINE", false, async function () {
        var s = svc("sound");
        if (!s) throw new Error("sound service not registered");
        /* Deliberately does not make a noise — just proves the engine
           can be driven without throwing when it is switched off. */
        return s.enabled() ? "enabled" : "present, currently off";
      }),
      check("AMBIENT FX", false, async function () {
        var fx = svc("ambientFx");
        if (!fx) throw new Error("ambient service not registered");
        var was = fx.isRunning();
        sb.onCleanup(function () { if (!was) fx.stop(); });
        if (!was) {
          fx.start();
          var n = fx.count();
          fx.stop();
          return "started with " + n + " particles, stopped";
        }
        return "already running with " + fx.count() + " particles";
      }),
      check("ACHIEVEMENTS ENGINE", false, async function () {
        var a = svc("achievements");
        if (!a) throw new Error("achievements not registered");
        if (isGuest()) throw new Error("SKIPPED — guest session");
        if (typeof a.evaluate === "function") await a.evaluate();
        var got = Object.keys(a.unlocked() || {}).length;
        return got + " of " + (a.DEFS ? a.DEFS.length : "?") + " unlocked";
      }),
      check("COMMAND PALETTE", false, async function () {
        need("commandPalette");
        return "registered (Ctrl+K)";
      })
    ]));

    /* ---- modules: mount each one for real ----

       A module is a singleton holding its own DOM references in
       module-level variables. Mounting one that is ALREADY OPEN
       repoints those variables at the sandbox host, and the
       following unmount() sets them to nothing — so the window
       still sitting on the desktop keeps its pixels and loses its
       wiring. Every button on it then operates on an element that
       was removed.

       The module this bit hardest was the one running the test.
       DIAGNOSTICS mounts itself, unmounts itself, and then tries to
       draw the report into `nodes.report` — which its own unmount
       just cleared. That is why FULL SYSTEM EXERCISE completed and
       showed nothing while QUICK and COMPREHENSIVE, which mount
       nothing, printed their reports fine.

       So an open module is skipped and says so. Coverage lost is
       real but recoverable — close the window and re-run — whereas
       silently breaking the window someone is looking at is not
       something they can even diagnose. */
    var shellSvc = svc("shell");
    var openNow = {};
    try {
      ((shellSvc && shellSvc.openWindows && shellSvc.openWindows()) || [])
        .forEach(function (id) { openNow[id] = true; });
    } catch (e) { /* no shell in a headless run; nothing is open */ }

    var mods = FieldKit.modules();
    Object.keys(mods).sort().forEach(function (id) {
      var mod = mods[id];
      var mounted = false;
      var host = null;

      var checks = [
        check("MOUNT", true, async function () {
          var g = svc("guest");
          if (g && g.active() && !g.allowed(mod)) throw new Error("SKIPPED — sealed in a guest session");
          if (openNow[id]) {
            throw new Error("SKIPPED — open on the desktop. Mounting it again would " +
              "repoint this module at the test host and break the window you have open. " +
              "Close it and re-run to include it.");
          }
          host = sb.host();
          await mod.mount(host, FieldKit.context());
          mounted = true;
          sb.onCleanup(function () {
            if (!mounted) return;
            mounted = false;
            try { if (typeof mod.unmount === "function") mod.unmount(); } catch (e) { /* reported below */ }
          });
          if (!host.childNodes.length) throw new Error("mounted but produced no DOM");
          var controls = host.querySelectorAll("button, input, textarea, select").length;
          return host.childNodes.length + " root node(s), " + controls + " control(s)";
        }),
        check("SEARCH INDEX", false, async function () {
          if (!mounted) throw new Error("SKIPPED — module did not mount");
          if (typeof mod.searchIndex !== "function") return "not indexed";
          var rows = mod.searchIndex();
          if (!Array.isArray(rows)) throw new Error("searchIndex() did not return an array");
          var bad = rows.find(function (r) { return !r || !r.id || typeof r.title !== "string"; });
          if (bad) throw new Error("malformed index row: " + preview(JSON.stringify(bad), 40));
          return rows.length + " searchable item(s)";
        })
      ];

      /* A module's own probes, run while it is mounted. This is the
         extension point — see the header comment. */
      if (typeof mod.selfcheck === "function") {
        var own = [];
        /* Probes get the sandbox so anything they persist is tracked
           and removed even if the check throws halfway through. */
        var api = {
          sandbox: sb,
          host: function () { return host; },
          probeType: PROBE_TYPE,
          preview: preview
        };
        try { own = mod.selfcheck(api) || []; }
        catch (e) {
          own = [check("SELFCHECK DEFINITION", false, async function () {
            throw new Error("selfcheck() threw while building: " + e.message);
          })];
        }
        own.forEach(function (c) {
          if (!c || typeof c.run !== "function") return;
          checks.push(check(c.name, c.critical, async function () {
            if (!mounted) throw new Error("SKIPPED — module did not mount");
            return await c.run();
          }));
        });
      }

      checks.push(check("UNMOUNT", false, async function () {
        if (!mounted) throw new Error("SKIPPED — module did not mount");
        if (typeof mod.unmount !== "function") { mounted = false; return "no unmount() defined"; }
        mod.unmount();
        mounted = false;
        return "clean";
      }));

      groups.push(group("MODULE :: " + (mod.title || id), checks));
    });

    return groups;
  }

  /* ---- runner -------------------------------------------------- */
  async function run(suite, onStep, label) {
    var t0 = performance.now();
    var results = [];
    for (var i = 0; i < suite.length; i++) {
      var c = suite[i];
      if (onStep) onStep(i, suite.length, c.name, c.group);
      var s0 = performance.now();
      try {
        var detail = await c.run();
        results.push({ name: c.name, group: c.group || "GENERAL", pass: true,
          detail: String(detail), critical: c.critical,
          ms: Math.round(performance.now() - s0) });
      } catch (e) {
        /* A check that says SKIPPED is reporting a precondition, not
           a fault — it must never read as a failure.

           A 429 is the same kind of thing wearing a different hat.
           The exercise drives every module against the relay for
           real, and if it outruns the limit then everything after
           that point fails for a reason that has nothing to do with
           the feature being tested — which reads as "the AI is
           broken" when the AI is fine. The relay's authedMax was
           raised so this should now be rare, but "rare" is not
           "never": a shared address, or two people running the
           exercise at once, still gets there. */
        var limited = e.status === 429 || /\brate limited\b/i.test(e.message || "");
        if (limited) {
          e = new Error("SKIPPED — the relay rate limited this request. " +
            "Not a fault in this feature; wait a minute and re-run.");
        }
        var skipped = /^SKIPPED/.test(e.message);
        results.push({ name: c.name, group: c.group || "GENERAL",
          pass: skipped, skipped: skipped,
          detail: e.message, critical: c.critical && !skipped,
          ms: Math.round(performance.now() - s0) });
      }
    }

    var failed = results.filter(function (r) { return !r.pass; });
    var report = {
      at: new Date().toISOString(),
      suite: label,
      totalMs: Math.round(performance.now() - t0),
      results: results,
      passed: results.filter(function (r) { return r.pass && !r.skipped; }).length,
      skipped: results.filter(function (r) { return r.skipped; }).length,
      failed: failed.length,
      criticalFailed: failed.filter(function (r) { return r.critical; }).length,
      online: (svc("store") && svc("store").state()) === "ONLINE",
      device: {
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "unknown",
        cores: navigator.hardwareConcurrency || null,
        memory: navigator.deviceMemory || null,
        origin: location.protocol === "file:" ? "file://" : location.origin,
        version: FieldKit.VERSION
      }
    };
    FieldKit.emit("selftest:done", report);
    return report;
  }

  async function runExercise(onStep) {
    var sb = makeSandbox();

    /* Probe notes, snippets, and incidents would otherwise push the
       achievement counters up for work nobody did. */
    var ach = svc("achievements");
    var resumeAchievements = ach && typeof ach.suspend === "function" ? ach.suspend() : null;

    /* Taken before anything mounts, restored in the finally so a
       crash halfway through still puts the desktop back. */
    var env = snapshotEnvironment();

    try {
      var report = await run(flatten(buildExercise(sb)), onStep, "exercise");
      var changed = restoreEnvironment(env);
      if (changed.length) {
        /* Reported rather than silently fixed. A module that leaves
           something behind has a bug, and the restore is a safety
           net rather than a licence to keep leaving things. */
        report.restored = changed;
        FieldKit.log("warn", "selftest",
          "the exercise put " + changed.length + " thing(s) back afterwards: " +
          changed.join(", "));
      }
      return report;
    } finally {
      await sb.cleanup();
      /* Twice on the failure path is deliberate and harmless: the
         call above never ran if run() threw, and a second call with
         nothing left to change returns an empty list. */
      restoreEnvironment(env);
      if (resumeAchievements) resumeAchievements();
    }
  }

  /* Logged only when the vault is open — there is nowhere else to
     put it, and buffering it unencrypted would defeat the point.
     Exercise reports are trimmed: the full detail strings are for
     reading now, not for keeping forever. */
  async function log(report) {
    var s = svc("store");
    if (!s || !s.isUnlocked()) return null;
    var payload = report;
    if (report.suite === "exercise") {
      payload = Object.assign({}, report, {
        results: report.results.map(function (r) {
          return { name: r.name, group: r.group, pass: r.pass, skipped: !!r.skipped,
            critical: r.critical, ms: r.ms, detail: preview(r.detail, 120) };
        })
      });
    }
    try { return await s.put("selftest", payload); }
    catch (e) {
      FieldKit.log("warn", "selftest", "could not log result: " + e.message);
      return null;
    }
  }

  /* Plain text, for pasting somewhere with no clipboard formatting —
     which is the whole situation this is meant for. */
  function asText(report) {
    var L = [];
    L.push("FIELDKIT SELF-TEST REPORT");
    L.push("=========================");
    L.push("suite     : " + String(report.suite).toUpperCase());
    L.push("when      : " + report.at);
    L.push("result    : " + report.passed + " pass, " + report.failed + " fail" +
      (report.skipped ? ", " + report.skipped + " skipped" : "") +
      "  of " + report.results.length);
    L.push("critical  : " + report.criticalFailed);
    L.push("elapsed   : " + report.totalMs + " ms");
    L.push("mode      : " + (report.online ? "ONLINE" : "OFFLINE"));
    if (report.device) {
      L.push("device    : " + report.device.platform +
        ", " + (report.device.cores || "?") + " cores" +
        ", " + (report.device.memory ? report.device.memory + " GB" : "memory unreported") +
        ", " + report.device.origin + ", v" + report.device.version);
    }
    L.push("");

    var lastGroup = null;
    report.results.forEach(function (r) {
      if (r.group !== lastGroup) {
        lastGroup = r.group;
        L.push("");
        L.push("-- " + lastGroup + " " + "-".repeat(Math.max(0, 52 - lastGroup.length)));
      }
      var flag = r.skipped ? "SKIP" : r.pass ? "PASS" : (r.critical ? "FAIL" : "WARN");
      L.push("  " + flag + "  " + r.name.padEnd(30) + "  " + r.detail + "  (" + r.ms + "ms)");
    });

    var bad = report.results.filter(function (r) { return !r.pass; });
    if (bad.length) {
      L.push("");
      L.push("-- NEEDS ATTENTION " + "-".repeat(37));
      bad.forEach(function (r) {
        L.push("  " + (r.critical ? "FAIL" : "WARN") + "  [" + r.group + "] " + r.name + ": " + r.detail);
      });
    }
    L.push("");
    return L.join("\n");
  }

  FieldKit.provide("selftest", {
    QUICK: flatten(QUICK_GROUPS),
    FULL: flatten(FULL_GROUPS),
    runQuick: function (onStep) { return run(flatten(QUICK_GROUPS), onStep, "quick"); },
    runFull: function (onStep) { return run(flatten(FULL_GROUPS), onStep, "comprehensive"); },
    runExercise: runExercise,
    log: log,
    asText: asText,
    AI_PROBE: AI_PROBE,
    /* exposed so tests can count what the exercise would cover */
    _buildExercise: buildExercise,
    _makeSandbox: makeSandbox
  });
})(window.FieldKit);
