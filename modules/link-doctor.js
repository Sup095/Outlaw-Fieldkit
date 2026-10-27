/* ============================================================
   FieldKit :: link-doctor
   Why can't I reach the relay?

   "Failed to fetch" is the only thing the browser will tell you, and
   it means all of: DNS did not resolve, the port is firewalled, the
   TLS handshake failed, the server refused, or CORS ate the reply.
   On a machine with no terminal that is a dead end.

   So this stops asking the browser what went wrong and infers it
   from behaviour instead. Three signals do most of the work:

     TIMING     a firewall dropping packets makes a probe hang until
                it times out. A host with nothing listening answers
                "refused" in milliseconds. That gap is the single
                most useful measurement here.
     REACH      probing a known-good public host separates "the
                network is broken" from "this host is blocked".
     SHAPE      no-cors mode still reports whether *something*
                answered, even when the body is unreadable. Something
                answering that is not the relay means a block page or
                a transparent proxy.

   Nothing here sends vault data anywhere. The probes are HEAD/GET
   requests to the relay's own /health plus one public 204 endpoint,
   and the report is safe to read out loud — see the selfcheck.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var running = false;
  var lastReport = null;

  /* Any reply at all proves the path is open. Google's generate_204
     is the standard captive-portal probe and is reachable from
     essentially anywhere with working internet. */
  var REACH_PROBE = "https://www.gstatic.com/generate_204";

  /* Below this, a failure is a refusal or a DNS miss — the stack
     answered. Above it, nothing answered and packets went nowhere. */
  /* Dynamic-DNS domains, which managed networks block by category
     rather than by anything the host actually does. Listed by suffix
     because these are all shared parent domains — the block lands on
     the parent, so every subdomain under it is gone at once. */
  var DYNAMIC_DNS = {
    "duckdns.org": "DuckDNS", "no-ip.com": "No-IP", "no-ip.org": "No-IP",
    "ddns.net": "No-IP", "hopto.org": "No-IP", "zapto.org": "No-IP",
    "sytes.net": "No-IP", "myftp.org": "No-IP", "serveo.net": "Serveo",
    "dynu.com": "Dynu", "afraid.org": "FreeDNS", "freedns.afraid.org": "FreeDNS",
    "trycloudflare.com": "Cloudflare quick-tunnel", "ngrok.io": "ngrok",
    "ngrok-free.app": "ngrok", "loca.lt": "localtunnel"
  };

  function dynamicDnsProvider(host) {
    host = String(host || "").toLowerCase();
    var hit = null;
    Object.keys(DYNAMIC_DNS).forEach(function (suffix) {
      if (host === suffix || host.slice(-(suffix.length + 1)) === "." + suffix) {
        hit = DYNAMIC_DNS[suffix];
      }
    });
    return hit;
  }

  var DROP_THRESHOLD_MS = 1500;
  var PROBE_TIMEOUT_MS = 8000;

  function relay() { return FieldKit.service("transportRelay"); }

  function parseUrl(raw) {
    try {
      var u = new URL(raw);
      return {
        ok: true, href: u.href, protocol: u.protocol, hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? "443" : "80"),
        explicitPort: !!u.port,
        isIpLiteral: /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.indexOf(":") >= 0
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* One probe. Returns how it ended and how long it took — the
     duration is the interesting half. */
  async function probe(url, opts) {
    opts = opts || {};
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeout || PROBE_TIMEOUT_MS);
    var t0 = (window.performance && performance.now()) ? performance.now() : Date.now();
    var elapsed = function () {
      var t1 = (window.performance && performance.now()) ? performance.now() : Date.now();
      return Math.round(t1 - t0);
    };
    try {
      var res = await fetch(url, {
        method: opts.method || "GET",
        mode: opts.mode || "cors",
        cache: "no-store",
        signal: ctl ? ctl.signal : undefined
      });
      return { outcome: "answered", status: res.status, type: res.type,
               ms: elapsed(), res: res };
    } catch (e) {
      var aborted = e && (e.name === "AbortError" || /abort/i.test(e.message || ""));
      return { outcome: aborted ? "timeout" : "failed", ms: elapsed(),
               error: e && e.message ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- the battery ---------------------------------------------- */
  async function diagnose(onStep) {
    var raw = (ctx.settings.get("relayUrl") || "").trim();
    var steps = [];
    function step(name, value, level, note) {
      var s = { name: name, value: value, level: level || "info", note: note || null };
      steps.push(s);
      if (onStep) onStep(s);
      return s;
    }

    if (!raw) {
      step("RELAY URL", "NOT SET", "fail", "Set it in RELAY LINK first.");
      return finish(steps, {
        verdict: "NO RELAY CONFIGURED",
        level: "fail",
        explain: "There is no relay URL to test.",
        advice: ["Open RELAY LINK and enter the relay's address."]
      }, raw);
    }

    var u = parseUrl(raw);
    if (!u.ok) {
      step("RELAY URL", raw, "fail", u.error);
      return finish(steps, {
        verdict: "THE URL IS NOT VALID",
        level: "fail",
        explain: u.error,
        advice: ["It should look like https://relay.example.com — scheme included, no trailing path."]
      }, raw);
    }

    step("RELAY URL", u.href, "info");
    step("SCHEME", u.protocol.replace(":", "").toUpperCase(),
      u.protocol === "https:" ? "pass" : "warn",
      u.protocol === "https:" ? null
        : "Plain HTTP. Filters treat this as low-trust, and some networks block it outright.");
    step("PORT", u.port + (u.explicitPort ? "" : " (implied)"),
      u.port === "443" ? "pass" : (u.port === "80" ? "warn" : "fail"),
      u.port === "443" ? null
        : "Most restrictive networks allow only 80 and 443 outbound. Anything else is dropped.");
    if (u.isIpLiteral) {
      step("HOSTNAME", u.hostname, "warn",
        "A bare IP address. Many filters block IP-literal destinations on principle.");
    } else if (dynamicDnsProvider(u.hostname)) {
      /* The one that cost a real afternoon. A tunnel was running,
         the relay was up, and the Chromebook still said the host
         was blocked — because a tunnel does not change which
         hostname the client asks for, and this one is on a
         dynamic-DNS domain that sits in the "dynamic DNS" category
         of essentially every school filter. No amount of tunnel
         fixes it, because Cloudflare will only serve hostnames in a
         zone you control, and you do not control duckdns.org. */
      step("HOSTNAME", u.hostname, "fail",
        "This is a " + dynamicDnsProvider(u.hostname) + " address. Managed networks block " +
        "dynamic-DNS domains as a category, by name, before anything about your server " +
        "matters. A Cloudflare tunnel does NOT fix this: the tunnel only serves hostnames " +
        "in a zone you have added to Cloudflare, and nobody can add duckdns.org. If the " +
        "tunnel is running and this is still the URL in SETTINGS, the tunnel is not " +
        "being used at all.");
    } else {
      step("HOSTNAME", u.hostname, "pass");
    }

    /* 1. Is there any internet at all? */
    var reach = await probe(REACH_PROBE, { mode: "no-cors", timeout: 6000 });
    var online = reach.outcome === "answered";
    step("PUBLIC INTERNET", online ? "REACHABLE (" + reach.ms + " ms)" : "UNREACHABLE",
      online ? "pass" : "fail",
      online ? null : "A known-good public address did not answer either.");

    if (!online) {
      return finish(steps, {
        verdict: "NO NETWORK AT ALL",
        level: "fail",
        explain: "A public address that answers from essentially anywhere did not answer here, " +
                 "so this is not about the relay.",
        advice: [
          "Check the wifi is actually connected and not sitting on a sign-in page.",
          "Open any ordinary website to confirm.",
          "If other sites work but this probe does not, a filter may be blocking it specifically."
        ]
      }, raw);
    }

    /* 2. Does the relay's own origin answer anything at all? A
          no-cors probe tells us a reply arrived without needing the
          reply to be readable. */
    var origin = u.protocol + "//" + u.hostname + (u.explicitPort ? ":" + u.port : "");
    var opaque = await probe(origin + "/health", { mode: "no-cors" });
    step("RELAY ORIGIN", describeOutcome(opaque), outcomeLevel(opaque),
      opaque.outcome === "timeout"
        ? "The probe hung for the full timeout. Nothing sent back a refusal — the packets went nowhere."
        : null);

    /* 3. The real request, the one the app makes. */
    var real = await probe(origin + "/health", { mode: "cors" });
    var body = null;
    if (real.outcome === "answered") {
      try { body = await real.res.json(); } catch (e) { body = null; }
    }
    step("HEALTH ENDPOINT", real.outcome === "answered"
      ? real.status + " in " + real.ms + " ms"
      : describeOutcome(real), outcomeLevel(real));

    if (body) {
      step("RESPONSE", body.up ? "up=" + body.up + (body.version ? "  v" + body.version : "") : JSON.stringify(body).slice(0, 60),
        body.up ? "pass" : "warn");
    }

    /* 4. Classify. */
    return finish(steps, classify({
      url: u, online: online, opaque: opaque, real: real, body: body
    }), raw);
  }

  function describeOutcome(p) {
    if (p.outcome === "answered") return "ANSWERED " + p.status + " in " + p.ms + " ms";
    if (p.outcome === "timeout") return "NO ANSWER — TIMED OUT AFTER " + p.ms + " ms";
    return "FAILED IN " + p.ms + " ms";
  }

  function outcomeLevel(p) {
    if (p.outcome === "answered") return "pass";
    if (p.outcome === "timeout") return "fail";
    return "warn";
  }

  /* The whole point of the module. */
  function classify(s) {
    var u = s.url;

    /* It works. */
    if (s.body && s.body.up) {
      return {
        verdict: "RELAY IS HEALTHY",
        level: "pass",
        explain: "The relay answered its health check on this network.",
        advice: u.port === "443" ? [] : [
          "It works here, but the port is still non-standard — expect this to fail on " +
          "networks that only allow 80 and 443."
        ]
      };
    }

    /* Something answered, but it was not the relay. */
    if (s.real.outcome === "answered" && !s.body) {
      return {
        verdict: "SOMETHING ANSWERED, BUT NOT THE RELAY",
        level: "fail",
        explain: "A reply came back with status " + s.real.status + ", but it was not the JSON " +
                 "the relay sends. That is the signature of a filter's block page or a " +
                 "transparent proxy answering on the relay's behalf.",
        advice: [
          "Open the relay URL directly in a browser tab and read what comes back.",
          "If it is a block page, the network is intercepting this destination by name.",
          "Moving to a real hostname on 443 over a tunnel changes what the filter sees."
        ]
      };
    }

    /* A reply arrived at the opaque probe but the CORS one failed:
       the network is fine and the relay is misconfigured. */
    if (s.opaque.outcome === "answered" && s.real.outcome !== "answered") {
      return {
        verdict: "REACHED IT — THE BROWSER DISCARDED THE REPLY",
        level: "fail",
        explain: "The origin answered when the reply did not have to be readable, and failed " +
                 "when it did. That is CORS: the relay is not returning the headers that let " +
                 "a file:// page read its response. This is a relay-side problem, not a " +
                 "network one.",
        advice: [
          "Check the relay is the current build — CORS handling is in server.js.",
          "A proxy in front of the relay can also strip these headers.",
          "TLS with a certificate the browser rejects looks like this too."
        ]
      };
    }

    /* Nothing answered. Timing tells us which kind of nothing. */
    var slowest = Math.max(s.opaque.ms, s.real.ms);
    var dropped = s.opaque.outcome === "timeout" || slowest >= DROP_THRESHOLD_MS;

    if (dropped) {
      return {
        verdict: "THE PORT LOOKS BLOCKED",
        level: "fail",
        explain: "The probe hung for " + slowest + " ms and nothing ever came back — not even a " +
                 "refusal. Packets are being dropped in transit rather than rejected by the " +
                 "far end. On port " + u.port + " that is almost always a firewall allowing only " +
                 "80 and 443.",
        advice: [
          "This is the common case and it is fixable: put the relay on 443 behind a tunnel.",
          "See relay/CONNECTIVITY.md — cloudflared, no port forward, real certificate.",
          "A hostname alone will not help. The port is what is being blocked.",
          "To confirm quickly: if the relay is reachable from your phone on mobile data " +
          "but not here, it is this."
        ]
      };
    }

    return {
      verdict: "CONNECTION REFUSED",
      level: "fail",
      explain: "The far end answered immediately — in " + slowest + " ms — with a refusal. " +
               "Something is reachable at " + u.hostname + ", but nothing is listening on " +
               "port " + u.port + ". A blocked port hangs; a refused one is instant, and this " +
               "was instant.",
      advice: [
        "Check the relay is actually running and did not exit at startup.",
        "Check the port matches what the container has allocated.",
        "If DNS points somewhere stale, this is what it looks like."
      ]
    };
  }

  function finish(steps, verdict, url) {
    lastReport = {
      at: new Date().toISOString(),
      url: url,
      steps: steps,
      verdict: verdict
    };
    return lastReport;
  }

  /* ---- plain text, because this is the thing you send on --------- */
  function asText(r) {
    if (!r) return "";
    var out = [];
    out.push("FIELDKIT — LINK DOCTOR");
    out.push(r.at);
    out.push("RELAY: " + (r.url || "(not set)"));
    out.push("");
    out.push("VERDICT: " + r.verdict.verdict);
    out.push("");
    wrap(r.verdict.explain).forEach(function (l) { out.push("  " + l); });
    if (r.verdict.advice && r.verdict.advice.length) {
      out.push("");
      out.push("WHAT TO DO:");
      r.verdict.advice.forEach(function (a) {
        var lines = wrap(a, 66);
        out.push("  - " + lines[0]);
        lines.slice(1).forEach(function (l) { out.push("    " + l); });
      });
    }
    out.push("");
    out.push("PROBES:");
    r.steps.forEach(function (s) {
      out.push("  " + pad(s.name, 20) + " " + s.value + (s.level === "fail" ? "   *** " : ""));
      if (s.note) wrap(s.note, 62).forEach(function (l) { out.push("      " + l); });
    });
    return out.join("\n");
  }

  function pad(s, n) { s = String(s); return s + new Array(Math.max(1, n - s.length + 1)).join(" "); }

  function wrap(text, width) {
    width = width || 68;
    var words = String(text || "").split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      if (!line.length) { line = w; return; }
      if (line.length + 1 + w.length > width) { lines.push(line); line = w; }
      else line += " " + w;
    });
    if (line.length) lines.push(line);
    return lines.length ? lines : [""];
  }

  /* ---- ui -------------------------------------------------------- */
  async function run() {
    if (running) return;
    running = true;
    nodes.runBtn.disabled = true;
    nodes.runBtn.textContent = "PROBING...";
    ui.clear(nodes.steps);
    ui.clear(nodes.verdict);
    setExportEnabled(false);

    try {
      var report = await diagnose(function (s) {
        nodes.steps.appendChild(ui.readout([
          { label: s.name, value: s.value, level: s.level }
        ]));
        if (s.note) nodes.steps.appendChild(el("div", { class: "ld-note", text: s.note }));
      });
      renderVerdict(report.verdict);
      setExportEnabled(true);
    } catch (e) {
      nodes.verdict.appendChild(el("div", { class: "ld-verdict lvl-fail",
        text: "THE DIAGNOSTIC ITSELF FAILED: " + e.message }));
    } finally {
      running = false;
      nodes.runBtn.disabled = false;
      nodes.runBtn.textContent = "RUN LINK DOCTOR";
    }
  }

  function renderVerdict(v) {
    ui.clear(nodes.verdict);
    nodes.verdict.appendChild(el("div", { class: "ld-verdict lvl-" + v.level, text: v.verdict }));
    nodes.verdict.appendChild(el("p", { class: "ld-explain", text: v.explain }));
    if (v.advice && v.advice.length) {
      nodes.verdict.appendChild(el("div", { class: "ld-advice-head", text: "WHAT TO DO" }));
      var list = el("ul", { class: "ld-advice" });
      v.advice.forEach(function (a) { list.appendChild(el("li", { text: a })); });
      nodes.verdict.appendChild(list);
    }
  }

  function setExportEnabled(on) {
    [nodes.copyBtn, nodes.rawBtn].forEach(function (b) { if (b) b.disabled = !on; });
  }

  function copyReport() {
    if (!lastReport) return;
    ui.copy(asText(lastReport), {
      title: "LINK DOCTOR",
      note: "Clipboard access is blocked here. Select this and press Ctrl+C."
    }).then(function (how) { if (how) ui.toast("REPORT COPIED", "ok"); });
  }

  function showRaw() {
    if (!lastReport) return;
    ui.textDump(asText(lastReport), "LINK DOCTOR", "Select and copy, or just read it here.");
  }

  /* ---- probes ---------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "IT RECOGNISES A DYNAMIC-DNS HOST", critical: false, run: async function () {
        /* Suffix matching, not substring. "notduckdns.org" is a
           different domain, and "duckdns.org.evil.com" is somebody
           else's entirely — matching either would put a red row on a
           host that is fine. */
        var must = ["bastion-1.duckdns.org", "duckdns.org", "x.hopto.org",
          "abc-def.trycloudflare.com"];
        var mustNot = ["relay.example.com", "notduckdns.org",
          "duckdns.org.example.com", "example.com"];
        must.forEach(function (h) {
          if (!dynamicDnsProvider(h)) throw new Error("missed " + h);
        });
        mustNot.forEach(function (h) {
          if (dynamicDnsProvider(h)) throw new Error("false positive on " + h);
        });
        return must.length + " recognised, " + mustNot.length + " correctly left alone";
      } },
      { name: "URL PARSING", critical: false, run: async function () {
        var cases = [
          ["https://relay.example.com", "443", true, false],
          ["https://relay.example.com:25569", "25569", true, false],
          ["http://relay.example.com", "80", false, false],
          ["http://192.168.1.50:8080", "8080", false, true]
        ];
        for (var i = 0; i < cases.length; i++) {
          var p = parseUrl(cases[i][0]);
          if (!p.ok) throw new Error(cases[i][0] + " did not parse");
          if (p.port !== cases[i][1]) {
            throw new Error(cases[i][0] + " -> port " + p.port + ", expected " + cases[i][1]);
          }
          if ((p.protocol === "https:") !== cases[i][2]) throw new Error(cases[i][0] + " scheme wrong");
          if (p.isIpLiteral !== cases[i][3]) throw new Error(cases[i][0] + " IP-literal detection wrong");
        }
        if (parseUrl("not a url").ok) throw new Error("garbage was accepted as a URL");
        return cases.length + " URLs parsed, including implied ports and IP literals";
      } },

      /* The distinction the whole module exists to make. */
      { name: "BLOCKED AND REFUSED ARE TOLD APART", critical: true, run: async function () {
        var base = { url: parseUrl("https://relay.example.com:25569"), online: true, body: null };

        var blocked = classify(Object.assign({}, base, {
          opaque: { outcome: "timeout", ms: 8000 },
          real: { outcome: "timeout", ms: 8000 }
        }));
        if (!/BLOCKED/.test(blocked.verdict)) {
          throw new Error("a probe that timed out was not called blocked: " + blocked.verdict);
        }

        var refused = classify(Object.assign({}, base, {
          opaque: { outcome: "failed", ms: 12 },
          real: { outcome: "failed", ms: 9 }
        }));
        if (!/REFUSED/.test(refused.verdict)) {
          throw new Error("an instant failure was not called refused: " + refused.verdict);
        }
        return "timeout -> blocked, instant failure -> refused";
      } },

      { name: "A BLOCK PAGE IS NOT MISTAKEN FOR THE RELAY", critical: true, run: async function () {
        var v = classify({
          url: parseUrl("http://relay.example.com:25569"), online: true,
          opaque: { outcome: "answered", status: 200, ms: 40 },
          real: { outcome: "answered", status: 200, ms: 42 },
          body: null
        });
        if (!/NOT THE RELAY/.test(v.verdict)) {
          throw new Error("a 200 with no relay JSON was accepted: " + v.verdict);
        }
        var good = classify({
          url: parseUrl("https://relay.example.com"), online: true,
          opaque: { outcome: "answered", status: 200, ms: 30 },
          real: { outcome: "answered", status: 200, ms: 31 },
          body: { up: true, version: "1.0" }
        });
        if (!/HEALTHY/.test(good.verdict)) throw new Error("a real relay was not recognised");
        return "a bare 200 is rejected; relay JSON is accepted";
      } },

      { name: "CORS IS NAMED AS A RELAY PROBLEM", critical: false, run: async function () {
        var v = classify({
          url: parseUrl("https://relay.example.com"), online: true,
          opaque: { outcome: "answered", status: 200, ms: 30 },
          real: { outcome: "failed", ms: 35 },
          body: null
        });
        if (!/DISCARDED/.test(v.verdict)) throw new Error("wrong verdict: " + v.verdict);
        if (!/relay-side/.test(v.explain)) throw new Error("it did not say whose problem this is");
        return "opaque success + cors failure is reported as a relay-side problem";
      } },

      { name: "A NON-STANDARD PORT IS FLAGGED EVEN WHEN IT WORKS",
        critical: false, run: async function () {
        var v = classify({
          url: parseUrl("http://relay.example.com:25569"), online: true,
          opaque: { outcome: "answered", status: 200, ms: 20 },
          real: { outcome: "answered", status: 200, ms: 21 },
          body: { up: true }
        });
        if (!/HEALTHY/.test(v.verdict)) throw new Error("a working relay was not called healthy");
        if (!v.advice.length) throw new Error("port 25569 working was reported with no caveat");
        return "works here, still warns it will not work everywhere";
      } },

      /* A diagnostic you cannot send on is useless, and one that
         leaks the vault is worse than useless. */
      { name: "THE REPORT CARRIES NO SECRETS", critical: true, run: async function () {
        var text = asText({
          at: new Date().toISOString(),
          url: "https://relay.example.com",
          steps: [{ name: "PORT", value: "443", level: "pass", note: null }],
          verdict: { verdict: "RELAY IS HEALTHY", level: "pass", explain: "fine", advice: [] }
        });
        var store = ctx.store;
        var forbidden = [];
        if (store.vault && store.vault() && store.vault().authToken) {
          forbidden.push(store.vault().authToken);
        }
        var tok = ctx.settings.get("relayProvisionToken");
        if (tok) forbidden.push(tok);
        for (var i = 0; i < forbidden.length; i++) {
          if (text.indexOf(forbidden[i]) >= 0) throw new Error("a secret appeared in the report");
        }
        if (!/LINK DOCTOR/.test(text)) throw new Error("the report is not what it claims to be");
        return "report contains the URL and probe results, no tokens";
      } },

      { name: "THE REPORT IS PLAIN TEXT", critical: false, run: async function () {
        var text = asText({
          at: "2026-08-12T00:00:00.000Z", url: "https://r.example.com",
          steps: [{ name: "PORT", value: "25569", level: "fail",
                    note: "Most restrictive networks allow only 80 and 443 outbound." }],
          verdict: { verdict: "THE PORT LOOKS BLOCKED", level: "fail",
                     explain: "Nothing came back.", advice: ["Put it on 443 behind a tunnel."] }
        });
        if (/[<>]/.test(text)) throw new Error("the report contains markup");
        if (!/VERDICT: THE PORT LOOKS BLOCKED/.test(text)) throw new Error("no verdict line");
        if (!/WHAT TO DO/.test(text)) throw new Error("advice was dropped");
        if (!/PROBES:/.test(text)) throw new Error("probe list was dropped");
        var longest = text.split("\n").reduce(function (m, l) { return Math.max(m, l.length); }, 0);
        if (longest > 90) throw new Error("lines are " + longest + " chars — will not paste cleanly");
        return text.split("\n").length + " lines, longest " + longest + " chars";
      } },

      { name: "IT NEVER SENDS ANYTHING ANYWHERE", critical: true, run: async function () {
        /* probe() is the only function here that touches the network,
           so it is the only one that has to be read. GETs to the
           relay's own health endpoint and one public 204, nothing
           else. If that ever changes, this fails. */
        var src = String(probe);
        if (/method:\s*["'](POST|PUT|DELETE|PATCH)/i.test(src)) {
          throw new Error("a probe uses a mutating method");
        }
        if (/\bbody\s*:/.test(src)) throw new Error("a probe sends a request body");
        if (/credentials\s*:/.test(src)) throw new Error("a probe sends credentials");
        if (REACH_PROBE.indexOf("https://") !== 0) throw new Error("the reach probe is not HTTPS");
        return "read-only probes, no request bodies, reach probe is " + REACH_PROBE;
      } },

      { name: "NO RELAY URL IS HANDLED, NOT CRASHED", critical: false, run: async function () {
        var was = ctx.settings.get("relayUrl");
        ctx.settings.set("relayUrl", "");
        try {
          var r = await diagnose();
          if (!/NO RELAY CONFIGURED/.test(r.verdict.verdict)) {
            throw new Error("wrong verdict with no URL: " + r.verdict.verdict);
          }
          return "reports that nothing is configured instead of probing nothing";
        } finally {
          ctx.settings.set("relayUrl", was === undefined ? "" : was);
        }
      } },

      { name: "PANEL RENDERS A VERDICT", critical: false, run: async function () {
        renderVerdict({ verdict: "TEST VERDICT", level: "warn",
          explain: "rendered by the self-test", advice: ["one", "two"] });
        var txt = nodes.verdict.textContent || "";
        if (!/TEST VERDICT/.test(txt)) throw new Error("the verdict did not render");
        ui.clear(nodes.verdict);
        return "verdict, explanation and advice all render";
      } }
    ];
  }

  FieldKit.register("link-doctor", {
    group: "SERVERS",
    about: "Find out why the relay cannot be reached",
    keywords: "network troubleshoot connection failed fetch dns",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "LINK DOCTOR",
    icon: "⚕",
    width: 700,
    height: 620,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.steps = el("div");
      nodes.verdict = el("div");

      nodes.runBtn = ui.button("RUN LINK DOCTOR", run, { primary: true });
      nodes.copyBtn = ui.button("COPY REPORT", copyReport);
      nodes.rawBtn = ui.button("SHOW RAW TEXT", showRaw);
      setExportEnabled(false);

      host.appendChild(el("div", { class: "ld-wrap" }, [
        el("p", { class: "ld-blurb", text:
          "The browser only ever says \"failed to fetch\", which covers DNS, firewalls, TLS, " +
          "refusals and CORS all at once. This runs a battery of probes and names which one " +
          "it is — the giveaway is timing: a blocked port hangs, a refused one answers " +
          "instantly." }),
        el("div", { class: "ld-actions" }, [nodes.runBtn]),
        ui.panel("VERDICT", [nodes.verdict]),
        ui.panel("PROBES", [nodes.steps]),
        el("div", { class: "ld-actions" }, [nodes.copyBtn, nodes.rawBtn]),
        el("p", { class: "ld-blurb", text:
          "Nothing here sends vault data anywhere. The probes are read-only requests to the " +
          "relay's own health endpoint plus one public address, and the report is safe to " +
          "show someone. Full background in relay/CONNECTIVITY.md on the drive." })
      ]));

      nodes.verdict.appendChild(el("div", { class: "ld-none", text: "NOT RUN YET" }));
    },

    unmount() { nodes = {}; running = false; lastReport = null; }
  });

  function injectCSS() {
    if (document.getElementById("ld-style")) return;
    var s = document.createElement("style");
    s.id = "ld-style";
    s.textContent = `
.ld-wrap{height:100%;overflow:auto}
.ld-actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.ld-actions .fk-btn{flex:1;min-width:150px}
.ld-blurb{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:0 0 4px;
  border-left:2px solid var(--line2);padding-left:9px}
.ld-note{font-size:10px;color:var(--warn);line-height:1.55;margin:2px 0 8px;padding-left:9px;
  border-left:2px solid var(--warn)}
.ld-verdict{font-size:13px;letter-spacing:.14em;padding:9px 10px;border:1px solid var(--line2);
  margin-bottom:8px}
.ld-verdict.lvl-pass{color:var(--pass);border-color:var(--pass)}
.ld-verdict.lvl-fail{color:var(--fail);border-color:var(--fail)}
.ld-verdict.lvl-warn{color:var(--warn);border-color:var(--warn)}
.ld-explain{font-size:11px;line-height:1.65;color:var(--fg-dim);margin:0 0 8px}
.ld-advice-head{font-size:10px;letter-spacing:.16em;color:var(--accent);margin-bottom:4px}
.ld-advice{margin:0;padding-left:18px;font-size:11px;line-height:1.7;color:var(--fg-dim)}
.ld-none{padding:10px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
