/* ============================================================
   FieldKit :: ai-chat-panel  ("Ask FieldKit")
   One chat surface over all three tiers. The router picks; this
   panel just shows which tier answered, so a degraded reply is
   always visibly degraded rather than quietly worse.

   AI output is untrusted text and is inserted as text nodes only.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, history = [], busy = false, models = null;
  var alive = function () { return false; };

  var TIER_LABEL = {
    1: { text: "RELAY", level: "pass" },
    2: { text: "LOCAL MODEL", level: "info" },
    3: { text: "HEURISTIC", level: "warn" }
  };

  function addMessage(role, content, tier, meta) {
    var head = [el("span", { class: "chat-role", text: role === "user" ? "OPERATOR" : "FIELDKIT" })];
    if (tier && TIER_LABEL[tier]) {
      head.push(el("span", { class: "chat-tier lvl-" + TIER_LABEL[tier].level, text: TIER_LABEL[tier].text }));
    }
    if (meta) head.push(el("span", { class: "chat-meta", text: meta }));

    var body = el("div", { class: "chat-body" });
    /* Text nodes per line — never innerHTML, this is model output. */
    String(content).split(/\n/).forEach(function (line, i) {
      if (i) body.appendChild(el("br"));
      body.appendChild(document.createTextNode(line));
    });

    var row = el("div", { class: "chat-msg chat-" + role }, [
      el("div", { class: "chat-head" }, head), body
    ]);
    nodes.log.appendChild(row);
    nodes.log.scrollTop = nodes.log.scrollHeight;
    return row;
  }

  /* One line: which answers you will get, and the rest under MODELS. */
  async function refreshAvailability() {
    var guard = alive;
    var a = await ctx.ai.availability();
    if (!guard() || !nodes.avail) return;
    ui.clear(nodes.avail);
    var who = a[1].available ? "YOUR HOME AI" : a.server.available ? "THE SERVER'S SMALL MODEL"
      : a[2].available ? "THE MODEL IN THIS BROWSER" : "OFFLINE RULES ONLY: GET A MODEL UNDER MODELS";
    nodes.avail.appendChild(el("div", { class: "chat-checking", text: "ANSWERS FROM " + who }));
    drawServer(a.server);
    drawInstalled();
  }

  /* ---- MODELS: the server's, and ones installed in this browser ---- */
  function drawServer(sv) {
    if (!nodes.server) return;
    ui.clear(nodes.server);
    if (!sv.models.length) {
      nodes.server.appendChild(el("div", { class: "chat-note", text: "SERVER MODELS: " + (sv.detail || "none") }));
      return;
    }
    var pick = el("select", { class: "fk-input chat-pick", onchange: function () { ctx.settings.set("askServerModel", pick.value); } },
      sv.models.map(function (m) { return el("option", { value: m.id, text: m.name + (m.about ? " — " + m.about : "") }); }));
    pick.value = ctx.settings.get("askServerModel") || sv.models[0].id;
    nodes.server.appendChild(el("div", { class: "chat-row" }, [el("span", { class: "chat-note", text: "SERVER MODEL" }), pick]));
  }

  function fmt(b) { return b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB"; }

  async function drawInstalled() {
    var inst = FieldKit.service("aiInstall");
    if (!nodes.browser || !inst) return;
    var guard = alive, ai2 = FieldKit.service("aiLocal");
    var have = [];
    try { have = await inst.installed(); } catch (e) { /* no storage here: the list stays empty */ }
    if (!guard() || !nodes.browser) return;
    ui.clear(nodes.browser);
    var running = ai2 && ai2.state().ready ? ai2.state().folder : null;
    have.forEach(function (m) {
      nodes.browser.appendChild(el("div", { class: "chat-row" }, [
        el("span", { class: "chat-name", text: m.id + " · " + fmt(m.bytes) }),
        running === m.id ? el("span", { class: "chat-note", text: "IN USE" })
          : ui.button("USE", function () { useModel(m.id); }, { primary: true }),
        ui.button("DELETE", function () {
          if (window.confirm("Delete " + m.id + " from this browser?")) inst.remove(m.id).then(drawInstalled);
        }, { danger: true })
      ]));
    });
    nodes.browser.appendChild(el("div", { class: "chat-row" }, [
      ui.button("GET A TINY MODEL", showCatalogue),
      inst.gpu() ? null : el("span", { class: "chat-note", text: "this browser has no WebGPU, so models here cannot run" })
    ]));
  }

  async function useModel(id) {
    say("Loading " + id + "…");
    try {
      await FieldKit.need("aiInstall").use(id);
      say("");
      await refreshAvailability();
    } catch (e) { say(String(e.message || e)); }
  }

  function say(text) { if (nodes.got) nodes.got.textContent = text; }

  async function showCatalogue() {
    var inst = FieldKit.need("aiInstall"), guard = alive;
    say("Fetching the list…");
    try {
      var list = await inst.catalogue();
      if (!guard() || !nodes.list) return;
      say("");
      ui.clear(nodes.list);
      list.forEach(function (m) {
        nodes.list.appendChild(el("div", { class: "chat-row" }, [
          el("span", { class: "chat-name", text: m.id + " · needs about " + m.mb + " MB" }),
          ui.button("INSTALL", function () { installModel(m); })
        ]));
      });
    } catch (e) { say(String(e.message || e)); }
  }

  async function installModel(m) {
    var guard = alive;
    try {
      await FieldKit.need("aiInstall").install(m, function (part, name, viaRelay) {
        if (guard()) say("Installing " + m.id + ": " + Math.round(part * 100) + "% " + (name || "") +
          (viaRelay ? " (through your relay, as this network blocks Hugging Face: slower)" : ""));
      });
      if (!guard()) return;
      say("Installed. Press USE.");
      if (nodes.list) ui.clear(nodes.list);
      await drawInstalled();
    } catch (e) { if (guard()) say(String(e.message || e)); }
  }

  async function send() {
    if (busy) return;
    var text = nodes.input.value.trim();
    if (!text) return;

    nodes.input.value = "";
    addMessage("user", text);
    history.push({ role: "user", content: text });

    busy = true;
    nodes.send.disabled = true;
    var thinking = addMessage("assistant", "...", null, "working");

    try {
      var t0 = performance.now();
      var res = await ctx.ai.chat(history.slice(-12), {});
      var ms = Math.round(performance.now() - t0);
      thinking.remove();
      addMessage("assistant", res.content, res.tier,
        ms + " ms" + (res.truncated ? " — CUT OFF" : ""));
      history.push({ role: "assistant", content: res.content });
      if (res.degraded && res.reason) {
        ui.toast("DEGRADED TO TIER " + res.tier + " — " + res.reason, "warn");
      }
      /* An answer that stops mid-sentence with nothing said about it
         reads as a broken model. Say it out loud and name the way
         out, because "ask it to continue" is not obvious when you do
         not know it was cut off in the first place. */
      if (res.truncated) {
        ui.toast("THE MODEL RAN OUT OF ROOM — ask it to continue", "warn");
      } else if (res.finishReason) {
        ui.toast("STOPPED EARLY: " + res.finishReason, "warn");
      }
    } catch (e) {
      thinking.remove();
      addMessage("assistant", "REQUEST FAILED: " + e.message, null, "error");
      ctx.error("chat failed: " + e.message);
    } finally {
      busy = false;
      nodes.send.disabled = false;
      nodes.input.focus();
    }
  }

  function selfcheck() {
    return [
      { name: "TIER READOUT", critical: false, run: async function () {
        if (!nodes.avail || !nodes.avail.textContent.trim()) {
          throw new Error("availability readout is empty");
        }
        return nodes.avail.textContent.replace(/\s+/g, " ").trim().slice(0, 70);
      } },
      /* Model output is untrusted input. If it ever renders as
         markup instead of text, that is a real vulnerability. */
      { name: "MODEL OUTPUT IS INERT", critical: true, run: async function () {
        var before = nodes.log.childNodes.length;
        var hostile = '<img src=x onerror="alert(1)"><script>alert(2)</' + "script>";
        addMessage("assistant", hostile, 1, "selftest");
        var row = nodes.log.lastChild;
        if (nodes.log.querySelector("img") || nodes.log.querySelector("script")) {
          throw new Error("model output was rendered as live elements");
        }
        if (row.textContent.indexOf("onerror") < 0) throw new Error("message text did not render at all");
        nodes.log.removeChild(row);
        if (nodes.log.childNodes.length !== before) throw new Error("probe message was not cleaned up");
        return "rendered as literal text, not elements";
      } },
      { name: "MULTILINE RENDERING", critical: false, run: async function () {
        addMessage("assistant", "line one\nline two\nline three", 3, "selftest");
        var row = nodes.log.lastChild;
        var brs = row.querySelectorAll("br").length;
        nodes.log.removeChild(row);
        if (brs !== 2) throw new Error("expected 2 line breaks, got " + brs);
        return "line breaks preserved";
      } }
    ];
  }

  FieldKit.register("ai-chat", {
    group: "ONLINE",
    about: "Ask questions: answered by the server's model, one in this browser, or offline rules",
    keywords: "ai chat assistant question llm gpt help ask model install webgpu",
    selfcheck: selfcheck,
    title: "ASK",
    icon: "◧",
    width: 660,
    height: 520,

    async mount(host, context) {
      ctx = context;
      ui = ctx.ui;
      el = ui.el;
      injectCSS();
      alive = FieldKit.mountGuard("ai-chat");

      nodes.log = el("div", { class: "chat-log" });
      nodes.avail = el("div", { class: "chat-avail" });
      nodes.input = el("textarea", {
        class: "fk-input chat-input", spellcheck: "false", rows: "3",
        placeholder: "Ask anything"
      });
      nodes.send = ui.button("SEND", send, { primary: true });

      nodes.input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
          e.preventDefault();
          send();
        }
      });

      nodes.server = el("div");
      nodes.browser = el("div");
      nodes.list = el("div");
      nodes.got = el("div", { class: "chat-note" });
      models = ui.moduleFold("ai-local", ctx, { label: "USE A MODEL FOLDER FROM THIS DRIVE" });
      host.appendChild(el("div", { class: "chat-wrap" }, [
        nodes.avail,
        ui.fold("MODELS", [nodes.server, nodes.browser, nodes.list, nodes.got, models]),
        nodes.log,
        el("div", { class: "chat-bar" }, [
          nodes.input,
          el("div", { class: "chat-actions" }, [
            nodes.send,
            ui.button("CHECK AGAIN", refreshAvailability),
            ui.button("CLEAR", function () {
              history = [];
              ui.clear(nodes.log);
              addMessage("assistant", "History cleared.", 3);
            })
          ])
        ])
      ]));

      addMessage("assistant",
        "Ask anything. The server's model answers if it can, then one in this browser, then " +
        "offline rules. The badge on each reply says which.", 3);

      await refreshAvailability();
      nodes.input.focus();
    },

    unmount() {
      alive.end();
      if (models) models.unmount();
      models = null;
      nodes = {}; busy = false;
    },

    searchIndex() {
      return history.map(function (m, i) {
        return { id: "chat-" + i, module: "ai-chat", title: m.role, body: m.content };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("chat-style")) return;
    var s = document.createElement("style");
    s.id = "chat-style";
    s.textContent = `
.chat-wrap{display:flex;flex-direction:column;height:100%;gap:8px;min-height:0}
.chat-avail{flex:none;border:1px solid var(--line);background:var(--bg2);padding:8px 10px}
.chat-checking{font-size:10px;letter-spacing:.2em;color:var(--fg-dimmer)}
.chat-log{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);padding:10px;min-height:0}
.chat-msg{margin-bottom:12px}
.chat-head{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.chat-role{font-size:10px;letter-spacing:.2em;color:var(--fg-dim)}
.chat-user .chat-role{color:var(--accent)}
.chat-tier{font-size:9px;letter-spacing:.14em;border:1px solid currentColor;padding:0 4px}
.chat-meta{font-size:9px;color:var(--fg-dimmer);letter-spacing:.1em}
.chat-body{white-space:pre-wrap;word-break:break-word;line-height:1.6}
.chat-user .chat-body{color:var(--fg)}
.chat-assistant .chat-body{color:var(--fg-dim)}
.chat-bar{flex:none;display:flex;flex-direction:column;gap:6px}
.chat-input{resize:none;line-height:1.5}
.chat-note{font-size:10px;color:var(--fg-dimmer);line-height:1.5}
.chat-row{display:flex;gap:6px;align-items:center;margin-bottom:4px}
.chat-name{flex:1;min-width:0;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-pick{flex:1;min-width:0;padding:4px;font-size:10px}
.chat-actions{display:flex;gap:6px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
