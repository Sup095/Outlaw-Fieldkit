/* ============================================================
   FieldKit :: bastion-remote
   The kill switch, and the counter that says how much any of this
   gets used. (§9D, §9 Relay/AI extras)

   Two panels that belong together because they answer the two
   questions you have when you pick the drive up: can I fix the
   thing from here, and has any of this been worth building.

   ACTIONS is deliberately thin. It lists what the relay says it
   can do, and posts an id back. It does not know what the commands
   are, cannot compose one, and cannot add to the list — every one
   of those is a decision made in a file on the server. A client
   that could invent an action would make the whitelist decorative.

   The failure everyone hits first is the tailnet gate. Mutating
   actions do not ride the public leg (§9D), so away from the
   tailnet this panel gets a 403 — which is the system working.
   The panel says exactly that rather than rendering an error, and
   it says it before you have gone looking for a bug that is not
   there.

   USAGE is counters. No prompts, no record contents, nothing about
   who. That is a property of the relay, not a promise made here,
   and the panel repeats it so the claim travels with the numbers.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var actions = [];
  var actionState = null;   // null | "ok" | "tailnet" | "unconfigured" | "error"
  var actionDetail = "";
  var usage = null;
  var busy = null;
  var running = false;

  function relay() { return FieldKit.service("transportRelay"); }

  function configured() {
    var r = relay();
    return !!(r && r.url && r.url());
  }

  /* ---- loading ---------------------------------------------------- */
  async function loadActions() {
    actions = [];
    if (!configured()) {
      actionState = "unconfigured";
      actionDetail = "No relay is configured. Set one up in RELAY LINK first.";
      return;
    }
    try {
      var r = await relay().listActions();
      actions = Array.isArray(r && r.actions) ? r.actions : [];
      actionState = "ok";
      actionDetail = actions.length ? "" :
        "The relay is reachable and has no actions configured. Add them to `actions` in " +
        "config.json on the server — until then this relay cannot change anything, which " +
        "is the safe default.";
    } catch (e) {
      /* 403 is the tailnet gate and is not a fault. Saying so
         plainly is the entire value of this branch. */
      if (e.status === 403) {
        actionState = "tailnet";
        actionDetail = (e.data && e.data.detail) ||
          "Actions require being on the tailnet.";
      } else if (e.status === 401) {
        actionState = "error";
        actionDetail = "The relay rejected the token. Unlock the vault, or re-check the " +
          "relay URL in RELAY LINK.";
      } else {
        actionState = "error";
        actionDetail = e.message || String(e);
      }
    }
  }

  async function loadUsage() {
    usage = null;
    if (!configured()) return;
    try { usage = await relay().usage(); }
    catch (e) { usage = { error: e.status === 403 ? "refused" : (e.message || String(e)) }; }
  }

  async function refresh() {
    if (nodes.refreshBtn) {
      nodes.refreshBtn.disabled = true;
      nodes.refreshBtn.textContent = "CHECKING…";
    }
    try {
      await loadActions();
      await loadUsage();
    } finally {
      if (nodes.refreshBtn) {
        nodes.refreshBtn.disabled = false;
        nodes.refreshBtn.textContent = "REFRESH";
      }
    }
    render();
  }

  /* ---- running ------------------------------------------------------
     Two gates on this side too, and neither is security — the relay
     is the boundary. They are here because a mis-click that
     restarts a server people are playing on is a bad afternoon.
     A confirm that names the action, and a lock so a double-tap
     cannot fire twice. */
  async function run(a) {
    if (running) return;
    if (!confirm("Run \"" + (a.label || a.id) + "\" on the relay?\n\n" +
        (a.note ? a.note + "\n\n" : "") +
        "This runs a real command on the server.")) return;

    running = true;
    busy = a.id;
    render();
    var result;
    try {
      result = await relay().runAction(a.id, a.timeoutMs);
      ui.toast(result && result.ok ? "ACTION COMPLETED" : "ACTION FAILED",
        result && result.ok ? "ok" : "fail");
    } catch (e) {
      /* The relay answers a failed action with 500 AND a full body —
         exit code, stdout, stderr, how long it took. The transport
         turns any non-2xx into a throw, so landing here used to
         discard all of it and show a bare "failed", meaning you got
         diagnostics only when nothing had gone wrong. Keep the
         server's own result when it sent one. */
      var d = e.data;
      result = (d && typeof d === "object" && ("stdout" in d || "ok" in d))
        ? d
        : { ok: false, id: a.id, error: e.message || String(e), status: e.status };
      if (!result.error) result.error = e.message || String(e);
      if (e.status === 429) {
        result.error = (e.data && e.data.detail) || "rate limited or still cooling down";
      }
      /* An abort is not a failure — the command is very likely still
         running on the relay, and saying "failed" would invite
         someone to press it again. */
      if (/timed out/i.test(String(e.message))) {
        result.error = "no answer within the client timeout. The action may still be " +
          "running on the relay — press REFRESH before trying again.";
        result.pending = true;
      }
      ui.toast(result.pending ? "NO ANSWER YET" : "ACTION FAILED",
        result.pending ? "warn" : "fail");
    } finally {
      running = false;
      busy = null;
    }
    showResult(a, result);
    await loadActions();
    await loadUsage();
    render();
  }

  function showResult(a, result) {
    if (!nodes.result) return;
    ui.clear(nodes.result);
    var okness = result && result.ok;
    var pending = result && result.pending;
    nodes.result.appendChild(el("div", {
      class: okness ? "br-rok" : (pending ? "br-rpending" : "br-rfail"),
      text: (a.label || a.id) + " — " +
        (okness ? "completed" : pending ? "no answer yet" : "failed") +
        (result && result.ms ? " in " + result.ms + " ms" : "") +
        (result && typeof result.exitCode === "number" && !okness
          ? " (exit " + result.exitCode + ")" : "") +
        (result && result.error ? ": " + result.error : "")
    }));
    if (result && result.stdout) {
      nodes.result.appendChild(el("pre", { class: "br-out", text: result.stdout }));
    }
    if (result && result.stderr) {
      nodes.result.appendChild(el("pre", { class: "br-out br-err", text: result.stderr }));
    }
    if (result && result.truncated) {
      nodes.result.appendChild(el("p", { class: "br-note", text:
        "Output was longer than the relay will return and has been cut short." }));
    }
  }

  /* ---- rendering ---------------------------------------------------- */
  function render() {
    if (!nodes.actions) return;
    renderActions();
    renderUsage();
  }

  function renderActions() {
    ui.clear(nodes.actions);

    if (actionState === "tailnet") {
      nodes.actions.appendChild(el("div", { class: "br-gate" }, [
        el("div", { class: "br-gate-h", text: "TAILNET ONLY — THIS IS NOT A FAULT" }),
        el("p", { class: "br-gate-p", text: actionDetail }),
        el("p", { class: "br-gate-p", text:
          "Reading status, syncing the vault and asking the AI all work from anywhere. " +
          "Anything that changes a server's state deliberately does not, because the " +
          "public leg of the relay is reachable by anyone who finds the address. Join the " +
          "tailnet on this machine and the actions appear." })
      ]));
      return;
    }

    if (actionState !== "ok") {
      nodes.actions.appendChild(el("div", {
        class: actionState === "unconfigured" ? "br-note" : "br-fail",
        text: actionDetail || "Not checked yet — press REFRESH." }));
      return;
    }

    if (!actions.length) {
      nodes.actions.appendChild(el("div", { class: "br-note", text: actionDetail }));
      return;
    }

    actions.forEach(function (a) {
      var row = el("div", { class: "br-action" + (a.ready ? "" : " br-cooling") }, [
        el("div", { class: "br-a-head" }, [
          el("span", { class: "br-a-label", text: a.label || a.id }),
          el("code", { class: "br-a-id", text: a.id })
        ])
      ]);
      if (a.note) row.appendChild(el("p", { class: "br-a-note", text: a.note }));

      var meta = [];
      if (a.cooldownS) meta.push("cooldown " + a.cooldownS + "s");
      if (a.lastRunAt) meta.push("last run " + relTime(a.lastRunAt));
      if (meta.length) row.appendChild(el("div", { class: "br-a-meta", text: meta.join(" · ") }));

      var btn = ui.button(busy === a.id ? "RUNNING…" : (a.ready ? "RUN" : "COOLING DOWN"),
        function () { run(a); }, { danger: true });
      btn.disabled = running || !a.ready;
      row.appendChild(btn);
      nodes.actions.appendChild(row);
    });

    nodes.actions.appendChild(el("p", { class: "br-note", text:
      "This list comes from the relay's config file. FieldKit cannot add to it, cannot pass " +
      "arguments, and cannot run anything that is not on it — a request carries an id and " +
      "nothing else." }));
  }

  function renderUsage() {
    ui.clear(nodes.usage);
    /* Counters we already hold get drawn whatever the relay is
       doing now. Checking the connection first would blank the
       panel the moment the relay went away, which is exactly when
       you would want to look at the last numbers it gave you. */
    if (!usage) {
      nodes.usage.appendChild(el("div", { class: "br-note",
        text: configured() ? "Not checked yet." : "No relay configured." }));
      return;
    }
    if (usage.error) {
      nodes.usage.appendChild(el("div", { class: "br-fail",
        text: "Could not read the counters: " + usage.error }));
      return;
    }
    if (usage.enabled === false) {
      nodes.usage.appendChild(el("div", { class: "br-note",
        text: usage.detail || "Counting is switched off on the relay." }));
      return;
    }

    var ai = usage.ai || { requests: 0, targets: [] };
    nodes.usage.appendChild(ui.readout([
      { label: "COUNTING SINCE", value: shortDate(usage.since), level: "dim" },
      { label: "AI REQUESTS", value: String(ai.requests || 0),
        level: ai.requests ? "ok" : "dim" },
      { label: "FELL BACK TO A LOWER TIER", value: String(ai.fellBack || 0),
        level: ai.fellBack ? "warn" : "dim" },
      { label: "NO TARGET REACHABLE", value: String(ai.exhausted || 0),
        level: ai.exhausted ? "fail" : "ok" },
      { label: "RELAY RESTARTS", value: String(usage.restarts || 0), level: "dim" }
    ]));

    var targets = Array.isArray(ai.targets) ? ai.targets : [];
    if (targets.length) {
      var t = el("div", { class: "br-targets" });
      targets.forEach(function (x) {
        t.appendChild(el("div", { class: "br-target" }, [
          el("span", { class: "br-t-name", text: x.name }),
          el("span", { class: "br-bar" }, [
            el("span", { class: "br-bar-fill", style: { width: Math.max(1, x.share) + "%" } })
          ]),
          el("span", { class: "br-t-n",
            text: x.ok + " ok" + (x.failed ? " / " + x.failed + " failed" : "") +
              (x.avgMs ? " · " + x.avgMs + " ms" : "") })
        ]));
      });
      nodes.usage.appendChild(t);
    }

    var days = usage.days || {};
    var keys = Object.keys(days).sort().slice(-14);
    if (keys.length > 1) {
      var max = Math.max.apply(null, keys.map(function (k) { return days[k]; }));
      var chart = el("div", { class: "br-days" });
      keys.forEach(function (k) {
        chart.appendChild(el("span", { class: "br-day",
          title: k + ": " + days[k] + " requests",
          style: { height: Math.max(2, Math.round((days[k] / max) * 40)) + "px" } }));
      });
      nodes.usage.appendChild(chart);
      nodes.usage.appendChild(el("div", { class: "br-daylabel",
        text: keys[0] + " → " + keys[keys.length - 1] + ", peak " + max + " requests/day" }));
    }

    var routes = usage.routes || {};
    var rk = Object.keys(routes).sort(function (a, b) { return routes[b] - routes[a]; });
    if (rk.length) {
      var list = el("div", { class: "br-routes" });
      rk.slice(0, 10).forEach(function (k) {
        list.appendChild(el("div", { class: "br-route" }, [
          el("code", { text: k }), el("span", { text: String(routes[k]) })
        ]));
      });
      nodes.usage.appendChild(list);
    }

    var acts = usage.actions || {};
    var ak = Object.keys(acts);
    if (ak.length) {
      var al = el("div", { class: "br-routes" });
      ak.forEach(function (k) {
        var a = acts[k];
        al.appendChild(el("div", { class: "br-route" }, [
          el("code", { text: k }),
          el("span", { text: a.ok + " ok · " + a.failed + " failed · " + a.refused + " refused" })
        ]));
      });
      nodes.usage.appendChild(el("div", { class: "br-sub", text: "ACTIONS" }));
      nodes.usage.appendChild(al);
    }

    nodes.usage.appendChild(el("p", { class: "br-note", text: usage.note ||
      "Counters only — no prompts, no record contents, no addresses." }));
    if (usage.lastFlush) {
      nodes.usage.appendChild(el("p", { class: "br-note", text:
        "The relay writes these to disk every 30 seconds, so a crash loses at most that " +
        "much counting. Last written " + relTime(usage.lastFlush) + "." }));
    }
  }

  function shortDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return isNaN(d) ? "—" : d.toISOString().slice(0, 10);
  }

  function relTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "unknown";
    var s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 0) return "in the future — check the clocks";
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  /* ---- probes ---------------------------------------------------- */
  function selfcheck(api) {
    return [
      /* The whole safety story of this module in one check: it can
         name an action, and it cannot describe one. */
      { name: "THE CLIENT CANNOT INVENT AN ACTION", critical: true, run: async function () {
        var r = relay();
        if (!r || typeof r.runAction !== "function") {
          throw new Error("the relay transport has no runAction");
        }
        var src = String(r.runAction);
        if (!/\{\s*id:\s*id\s*\}/.test(src)) {
          throw new Error("runAction no longer sends exactly { id }");
        }
        [/cmd/, /args/, /shell/, /command/].forEach(function (re) {
          if (re.test(src)) throw new Error("runAction now mentions " + re.source);
        });
        var mine = String(run);
        if (/cmd|args|shell/.test(mine.replace(/\/\*[\s\S]*?\*\//g, ""))) {
          throw new Error("the panel now builds part of a command");
        }
        return "the request body is an id and nothing else, on both sides";
      } },

      /* Getting this wrong turns a working safety feature into a
         support call. It must read as a rule, not a breakage. */
      { name: "THE TAILNET REFUSAL READS AS A RULE", critical: true, run: async function () {
        var was = { s: actionState, d: actionDetail };
        try {
          actionState = "tailnet";
          actionDetail = "Actions are tailnet-only.";
          renderActions();
          var text = flatten(nodes.actions);
          if (!/NOT A FAULT/i.test(text)) {
            throw new Error("the panel no longer says this is expected");
          }
          if (!/tailnet/i.test(text)) throw new Error("it does not say what is needed");
          if (!/status|sync|AI/i.test(text)) {
            throw new Error("it does not say what still works from here");
          }
          if (/error|failed/i.test(text)) {
            throw new Error("it presents the gate as a failure");
          }
          return "the gate explains itself instead of reporting an error";
        } finally { actionState = was.s; actionDetail = was.d; renderActions(); }
      } },

      { name: "A COOLING ACTION CANNOT BE FIRED", critical: false, run: async function () {
        var was = actions, wasS = actionState;
        try {
          actionState = "ok";
          actions = [
            { id: "a", label: "Ready one", ready: true, cooldownS: 0 },
            { id: "b", label: "Cooling one", ready: false, cooldownS: 300,
              lastRunAt: new Date().toISOString() }
          ];
          renderActions();
          var btns = nodes.actions.querySelectorAll("button");
          if (btns.length < 2) throw new Error("the actions did not render buttons");
          var disabled = 0;
          for (var i = 0; i < btns.length; i++) if (btns[i].disabled) disabled++;
          if (disabled !== 1) {
            throw new Error("expected exactly one disabled button, got " + disabled);
          }
          if (!/COOLING DOWN/.test(flatten(nodes.actions))) {
            throw new Error("a cooling action does not say why it cannot run");
          }
          return "the ready one is live, the cooling one is not";
        } finally { actions = was; actionState = wasS; renderActions(); }
      } },

      { name: "AN EMPTY WHITELIST IS EXPLAINED", critical: false, run: async function () {
        var was = actions, wasS = actionState, wasD = actionDetail;
        try {
          actionState = "ok";
          actions = [];
          actionDetail = "The relay is reachable and has no actions configured. Add them to " +
            "`actions` in config.json on the server — until then this relay cannot change " +
            "anything, which is the safe default.";
          renderActions();
          var t = flatten(nodes.actions);
          if (!/config\.json/.test(t)) throw new Error("it does not say where to add them");
          if (!/safe default/i.test(t)) {
            throw new Error("it does not say that an empty list is fine");
          }
          return "an unconfigured relay reads as unconfigured, not broken";
        } finally { actions = was; actionState = wasS; actionDetail = wasD; renderActions(); }
      } },

      { name: "COMMAND OUTPUT IS TEXT, NEVER MARKUP", critical: true, run: async function () {
        var src = String(showResult) + String(renderActions) + String(renderUsage);
        [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/]
          .forEach(function (re) {
            if (re.test(src)) throw new Error("the render path now uses " + re.source);
          });
        showResult({ id: "x", label: "X" },
          { ok: false, error: "<b>boom</b>", stdout: "<script>alert(1)</script>" });
        if (nodes.result.querySelectorAll("script").length) {
          throw new Error("stdout was parsed into a script element");
        }
        if ((nodes.result.textContent || "").indexOf("<script>alert(1)</script>") < 0) {
          throw new Error("stdout did not survive as literal text");
        }
        ui.clear(nodes.result);
        return "a server that returns HTML cannot inject it into this panel";
      } },

      { name: "THE COUNTERS CARRY THEIR OWN PRIVACY CLAIM", critical: true,
        run: async function () {
          var was = usage;
          try {
            usage = { enabled: true, since: "2026-01-01T00:00:00.000Z", restarts: 2,
              routes: { "GET /health": 40 }, days: { "2026-08-11": 10, "2026-08-12": 12 },
              ai: { requests: 9, fellBack: 1, exhausted: 0,
                targets: [{ name: "lm-studio", ok: 8, failed: 1, avgMs: 1200, share: 89 }] },
              actions: { "restart-mc": { ok: 1, failed: 0, refused: 2 } },
              note: "Counters only. No prompts, no record contents, no client addresses." };
            renderUsage();
            var t = flatten(nodes.usage);
            if (!/No prompts/i.test(t)) {
              throw new Error("the privacy note is not shown with the numbers");
            }
            if (!/lm-studio/.test(t)) throw new Error("the target breakdown is missing");
            if (!/9/.test(t)) throw new Error("the request count is missing");
            if (!/restart-mc/.test(t)) throw new Error("the action counters are missing");
            return "numbers and the claim about what is not counted travel together";
          } finally { usage = was; renderUsage(); }
        } },

      /* The relay answers a failed action with 500 AND the full
         diagnostics. The transport turns any non-2xx into a throw,
         so the catch used to discard them — you got stdout only
         when nothing had gone wrong, which is precisely backwards. */
      { name: "A FAILED ACTION STILL SHOWS ITS OUTPUT", critical: false, run: async function () {
        var r = relay();
        var orig = r.runAction;
        var wasRunning = running;
        var realConfirm = window.confirm;
        r.runAction = function () {
          var e = new Error("relay returned 500");
          e.status = 500;
          e.data = { ok: false, id: "boom", label: "Boom", ms: 42, exitCode: 3,
            stdout: "partial work done", stderr: "systemctl: unit not found" };
          return Promise.reject(e);
        };
        window.confirm = function () { return true; };
        try {
          running = false;
          await run({ id: "boom", label: "Boom", ready: true });
          var text = flatten(nodes.result);
          if (!/systemctl: unit not found/.test(text)) {
            throw new Error("stderr from a failed action was thrown away");
          }
          if (!/partial work done/.test(text)) throw new Error("stdout was thrown away");
          if (!/exit 3/.test(text)) throw new Error("the exit code was not shown");
          if (!/42 ms/.test(text)) throw new Error("the duration was thrown away");
          return "exit code, stdout, stderr and duration all survive a failure";
        } finally {
          r.runAction = orig;
          window.confirm = realConfirm;
          running = wasRunning;
          ui.clear(nodes.result);
        }
      } },

      /* A client timeout shorter than the relay's own budget reports
         "failed" for a command that is still running — the worst
         possible answer for a restart, because it invites a retry. */
      { name: "A TIMEOUT IS NOT REPORTED AS A FAILURE", critical: false, run: async function () {
        var r = relay();
        var orig = r.runAction;
        var seen = null;
        var wasRunning = running;
        var realConfirm = window.confirm;
        r.runAction = function (id, budget) {
          seen = budget;
          return Promise.reject(new Error("relay timed out after 45000ms"));
        };
        window.confirm = function () { return true; };
        try {
          running = false;
          await run({ id: "slow", label: "Slow", ready: true, timeoutMs: 120000 });
          if (seen !== 120000) {
            throw new Error("the action's advertised budget was not passed through: " + seen);
          }
          var text = flatten(nodes.result);
          if (!/no answer yet/i.test(text)) {
            throw new Error("a timeout was presented as a flat failure");
          }
          if (!/may still be running/i.test(text)) {
            throw new Error("it does not say the command might still be going");
          }
          if (!/REFRESH/.test(text)) throw new Error("it does not say what to do next");
          return "a timeout says 'still running, press REFRESH' rather than 'failed'";
        } finally {
          r.runAction = orig;
          window.confirm = realConfirm;
          running = wasRunning;
          ui.clear(nodes.result);
        }
      } },

      { name: "NO RELAY IS NOT AN ERROR", critical: false, run: async function () {
        var wasS = actionState, wasD = actionDetail, wasU = usage;
        try {
          actionState = "unconfigured";
          actionDetail = "No relay is configured. Set one up in RELAY LINK first.";
          usage = null;
          render();
          var t = flatten(nodes.actions) + " " + flatten(nodes.usage);
          if (!/RELAY LINK/.test(t)) throw new Error("it does not point anywhere useful");
          if (/failed|error/i.test(flatten(nodes.actions))) {
            throw new Error("an unconfigured relay is presented as a failure");
          }
          return "it points at RELAY LINK rather than reporting a fault";
        } finally { actionState = wasS; actionDetail = wasD; usage = wasU; render(); }
      } },

      { name: "RELATIVE TIMES DO NOT LIE", critical: false, run: async function () {
        if (relTime(new Date(Date.now() - 5000).toISOString()) !== "5s ago") {
          throw new Error("seconds are wrong");
        }
        if (!/min ago/.test(relTime(new Date(Date.now() - 300000).toISOString()))) {
          throw new Error("minutes are wrong");
        }
        if (!/h ago/.test(relTime(new Date(Date.now() - 7200000).toISOString()))) {
          throw new Error("hours are wrong");
        }
        if (relTime("not a date") !== "unknown") {
          throw new Error("garbage was rendered as a time");
        }
        /* A future timestamp means a clock is wrong somewhere, and
           saying "in -3s" would send someone hunting the wrong bug. */
        if (!/clocks/.test(relTime(new Date(Date.now() + 60000).toISOString()))) {
          throw new Error("a future timestamp did not point at the clocks");
        }
        return "seconds, minutes, hours, garbage and a skewed clock all handled";
      } },

      { name: "IT NEVER RUNS ANYTHING BY ITSELF", critical: true, run: async function () {
        var r = relay();
        var calls = 0;
        var orig = r.runAction;
        r.runAction = function () { calls++; return Promise.resolve({ ok: true }); };
        try {
          await loadActions();
          await loadUsage();
          render();
          if (calls) throw new Error("loading the panel ran " + calls + " action(s)");
        } finally { r.runAction = orig; }
        return "opening, refreshing and rendering never post an action";
      } }
    ];
  }

  function flatten(node) {
    if (!node) return "";
    var out = [];
    (function walk(n) {
      if (!n) return;
      if (n.textContent) out.push(n.textContent);
      var kids = n.children;
      if (!kids) return;
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(node);
    return out.join(" ");
  }

  FieldKit.register("bastion-remote", {
    group: "SERVERS",
    about: "The kill switch and usage counters",
    keywords: "kill switch actions usage",
    /* A tab of BASTION rather than a tile of its own — see
       modules/bastion.js. It is still a whole module: it keeps its
       own selfchecks, its own lifecycle and its own id, and open()
       still reaches it. `inside` only tells the launcher not to
       draw a second icon for something already on screen. */
    inside: "bastion",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "BASTION REMOTE",
    icon: "⏻",
    width: 780,
    height: 700,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.actions = el("div");
      nodes.usage = el("div");
      nodes.result = el("div", { class: "br-result" });
      nodes.refreshBtn = ui.button("REFRESH", refresh);

      host.appendChild(el("div", { class: "br-wrap" }, [
        el("p", { class: "br-intro", text:
          "Quick actions run on the relay, from a list the relay itself defines. They are " +
          "tailnet-only: away from the tailnet this panel will say so, and that is the " +
          "design rather than a fault." }),
        el("div", { class: "br-top" }, [nodes.refreshBtn]),
        ui.panel("QUICK ACTIONS", [nodes.actions, nodes.result]),
        ui.panel("RELAY USAGE", [nodes.usage])
      ]));

      await refresh();
    },

    unmount() {
      nodes = {}; actions = []; usage = null; actionState = null;
      actionDetail = ""; busy = null; running = false;
    }
  });

  function injectCSS() {
    if (document.getElementById("br-style")) return;
    var s = document.createElement("style");
    s.id = "br-style";
    s.textContent = `
.br-wrap{height:100%;overflow:auto}
.br-intro{font-size:11px;color:var(--fg-dim);line-height:1.7;margin:0 0 10px;
  border-left:2px solid var(--line2);padding-left:9px}
.br-top{display:flex;gap:6px;margin-bottom:10px}
.br-top .fk-btn{flex:1}
.br-gate{border:1px dashed var(--info);padding:10px 11px}
.br-gate-h{font-size:10px;letter-spacing:.14em;color:var(--info);margin-bottom:7px}
.br-gate-p{font-size:10px;color:var(--fg-dim);line-height:1.7;margin:0 0 7px}
.br-gate-p:last-child{margin-bottom:0}
.br-action{border:1px solid var(--line);background:var(--panel2);padding:8px 9px;
  margin-bottom:7px}
.br-action.br-cooling{opacity:.6}
.br-a-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.br-a-label{font-size:11px;color:var(--fg)}
.br-a-id{font-size:9px;color:var(--accent)}
.br-a-note{font-size:10px;color:var(--fg-dim);line-height:1.6;margin:5px 0 0}
.br-a-meta{font-size:9px;color:var(--fg-dimmer);letter-spacing:.06em;margin-top:5px}
.br-action .fk-btn{margin-top:7px;width:100%}
.br-result{margin-top:8px}
.br-rok{font-size:10px;color:var(--pass);line-height:1.6;border-left:2px solid var(--pass);
  padding-left:9px}
.br-rfail{font-size:10px;color:var(--fail);line-height:1.6;border-left:2px solid var(--fail);
  padding-left:9px}
.br-rpending{font-size:10px;color:var(--warn);line-height:1.6;border-left:2px solid var(--warn);
  padding-left:9px}
.br-out{font-size:10px;color:var(--fg-dim);background:var(--bg2);border:1px solid var(--line2);
  padding:7px;margin:7px 0 0;max-height:180px;overflow:auto;white-space:pre-wrap;
  word-break:break-word}
.br-out.br-err{color:var(--fail);border-color:var(--fail)}
.br-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:9px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
.br-fail{font-size:10px;color:var(--fail);line-height:1.6;border-left:2px solid var(--fail);
  padding-left:9px}
.br-targets{margin-top:9px}
.br-target{display:flex;align-items:center;gap:7px;padding:3px 0}
.br-t-name{font-size:10px;color:var(--fg-dim);min-width:90px}
.br-bar{flex:1;height:6px;background:var(--bg2);border:1px solid var(--line2);display:block}
.br-bar-fill{display:block;height:100%;background:var(--accent)}
.br-t-n{font-size:9px;color:var(--fg-dimmer);white-space:nowrap}
.br-days{display:flex;align-items:flex-end;gap:2px;height:44px;margin-top:12px;
  border-bottom:1px solid var(--line2);padding-bottom:1px}
.br-day{flex:1;background:var(--accent-dim);min-height:2px}
.br-daylabel{font-size:9px;color:var(--fg-dimmer);letter-spacing:.06em;margin-top:4px}
.br-sub{font-size:9px;letter-spacing:.14em;color:var(--fg-dim);margin:11px 0 4px}
.br-routes{margin-top:8px}
.br-route{display:flex;justify-content:space-between;gap:8px;font-size:10px;
  color:var(--fg-dim);padding:2px 0;border-top:1px solid var(--line)}
.br-route code{color:var(--fg-dimmer)}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
