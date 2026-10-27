/* ============================================================
   FieldKit :: relay-choice — which relay address, asked at boot

   A relay can answer on several addresses (several hostnames on one
   tunnel), because a network that blocks one name may not block
   another. So before either build connects, the boot screen shows
   the address it is about to use and offers to change it or add one,
   for a few seconds, then carries on by itself. Nothing to do on a
   machine where it works; one key on a machine where it does not.

   The addresses are kept in settings: relayUrl is the one in use,
   relayUrls the others someone has added. Both travel in the drive
   profile, so a stick that has learned a spare address keeps it.

   After the choice, reachable() checks the address in use and, if it
   does not answer, tries the saved ones in turn and switches to the
   first that does, saying so. A blocked name then costs a few
   seconds at boot, not a trip to SETTINGS.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var WAIT_S = 6;              /* the countdown before it carries on */
  var PROBE_MS = 4000;
  var MAX_SAVED = 12;

  /* "relay.example.com" -> "https://relay.example.com"; anything that
     is not an http(s) address with a host is null. */
  function clean(raw) {
    var s = String(raw || "").trim();
    if (!s) return null;
    if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname) return null;
    return (u.origin + u.pathname).replace(/\/+$/, "");
  }

  function shortHost(u) {
    try { return new URL(u).host; } catch (e) { return String(u || ""); }
  }

  /* Every address this machine knows, the one in use first. */
  function known(settings) {
    var cur = clean(settings.get("relayUrl"));
    var more = Array.isArray(settings.get("relayUrls")) ? settings.get("relayUrls") : [];
    var out = [];
    [cur].concat(more.map(clean)).forEach(function (u) { if (u && out.indexOf(u) < 0) out.push(u); });
    return out;
  }

  function save(settings, list, current) {
    var all = [];
    [current].concat(list).forEach(function (u) { if (u && all.indexOf(u) < 0) all.push(u); });
    settings.set("relayUrl", current || "");
    settings.set("relayUrls", all.filter(function (u) { return u !== current; }).slice(0, MAX_SAVED));
  }

  /* Does a relay answer here? Its /health is public and says little. */
  async function answers(url, ms) {
    if (typeof fetch !== "function") return false;
    var ac = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, ms || PROBE_MS);
    try {
      var r = await fetch(url + "/health", { cache: "no-store", signal: ac ? ac.signal : undefined });
      return !!(r && r.ok);
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  var CSS = [
    ".rc-box{margin:10px 0 6px;padding:10px 12px;border:1px solid var(--line2);max-width:560px}",
    ".rc-head{color:var(--accent);letter-spacing:.14em;font-size:11px;margin-bottom:6px}",
    ".rc-now{font-size:12px;margin-bottom:8px;word-break:break-all}",
    ".rc-row{display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap}",
    ".rc-addr{flex:1;min-width:180px;font-size:12px;word-break:break-all}",
    ".rc-addr.rc-in-use{color:var(--pass)}",
    ".rc-btn{background:transparent;border:1px solid var(--line2);color:var(--fg);font:inherit;font-size:11px;",
    "  letter-spacing:.08em;padding:4px 10px;cursor:pointer}",
    ".rc-btn:hover,.rc-btn:focus{border-color:var(--accent);color:var(--accent);outline:none}",
    ".rc-input{flex:1;min-width:180px;background:transparent;border:1px solid var(--line2);color:var(--fg);",
    "  font:inherit;font-size:12px;padding:4px 6px}",
    ".rc-note{font-size:11px;color:var(--fg-dimmer);margin-top:6px;min-height:1.3em}",
    ".rc-ok{color:var(--pass)} .rc-bad{color:var(--fail)}"
  ].join("\n");

  function style() {
    if (document.getElementById("fk-relay-choice-css")) return;
    var s = document.createElement("style");
    s.id = "fk-relay-choice-css";
    s.textContent = CSS;
    (document.head || document.body).appendChild(s);
  }

  /* Shows the choice in `host` (the boot console) and resolves once
     the person carries on, or the countdown runs out. opts.waitS
     overrides the countdown (0: wait for the person). */
  function ask(host, opts) {
    opts = opts || {};
    var ui = FieldKit.need("ui"), el = ui.el, settings = FieldKit.need("settings");
    style();
    return new Promise(function (resolve) {
      var box = el("div", { class: "rc-box" });
      host.appendChild(box);
      var left = opts.waitS != null ? opts.waitS : WAIT_S;
      var timer = null, done = false;
      var editing = false;

      function finish() {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        document.removeEventListener("keydown", onKey, true);
        ui.clear(box);
        box.className = "boot-line";
        var cur = clean(settings.get("relayUrl"));
        box.appendChild(el("span", { text: "RELAY ADDRESS: " + (cur ? shortHost(cur) : "none") }));
        resolve(cur);
      }

      /* Any touch stops the countdown: someone is deciding. */
      function hold() {
        if (timer) { clearInterval(timer); timer = null; }
      }

      function onKey(e) {
        if (done) return;
        if (editing) { if (e.key === "Escape") { editing = false; draw(); } return; }
        if (e.key === "Enter") { e.preventDefault(); finish(); }
        else if (e.key === "c" || e.key === "C") { e.preventDefault(); hold(); editing = true; draw(); }
      }

      function btn(text, fn, title) {
        return el("button", { class: "rc-btn", type: "button", text: text, title: title || "", onclick: function () { hold(); fn(); } });
      }

      function draw(note, noteClass) {
        ui.clear(box);
        var list = known(settings), cur = list[0] || null;
        box.appendChild(el("div", { class: "rc-head", text: "RELAY ADDRESS" }));
        if (!editing) {
          box.appendChild(el("div", { class: "rc-now", text: cur
            ? "Connecting to " + shortHost(cur) + (list.length > 1 ? " (" + (list.length - 1) + " other saved)" : "")
            : "No relay address is set. Add one to use messaging, the browser and RUNNER." }));
          var go = btn(cur ? "CONTINUE" : "CONTINUE WITHOUT ONE", finish);
          box.appendChild(el("div", { class: "rc-row" }, [
            go,
            btn(cur ? "CHANGE OR ADD ADDRESS" : "ADD AN ADDRESS", function () { editing = true; draw(); })
          ]));
          box.appendChild(el("div", { class: "rc-note", text: (timer ? "Continuing in " + left + " s. " : "") +
            "Enter continues, C changes." }));
          return;
        }
        /* The field first: adding a row must not move a ✕ under the pointer that just pressed ADD. */
        var input = el("input", { class: "rc-input", type: "text", placeholder: "relay.example.com",
          spellcheck: "false", autocomplete: "off" });
        function add(use) {
          var u = clean(input.value);
          if (!u) { draw("that is not an address: try relay.example.com", "rc-bad"); return; }
          save(settings, list.concat([u]), use || !cur ? u : cur);
          draw((use || !cur ? "now using " : "saved ") + shortHost(u), "rc-ok");
        }
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(true); } });
        box.appendChild(el("div", { class: "rc-row" }, [input,
          btn("ADD AND USE", function () { add(true); }), btn("ADD", function () { add(false); })]));
        list.forEach(function (u, i) {
          var row = el("div", { class: "rc-row" }, [
            el("span", { class: "rc-addr" + (i === 0 ? " rc-in-use" : ""), text: shortHost(u) + (i === 0 ? "  (in use)" : "") }),
            i === 0 ? null : btn("USE", function () { save(settings, list, u); draw("now using " + shortHost(u), "rc-ok"); }),
            btn("TEST", function () {
              draw("asking " + shortHost(u) + "…");
              answers(u).then(function (yes) {
                if (!done) draw(yes ? shortHost(u) + " answers" : shortHost(u) + " does not answer from here",
                  yes ? "rc-ok" : "rc-bad");
              });
            }),
            btn("✕", function () {
              var rest = list.filter(function (x) { return x !== u; });
              save(settings, rest, i === 0 ? rest[0] || "" : cur);
              draw("forgot " + shortHost(u));
            }, "forget this address")
          ].filter(Boolean));
          box.appendChild(row);
        });
        box.appendChild(el("div", { class: "rc-row" }, [btn("CONTINUE", finish)]));
        box.appendChild(el("div", { class: "rc-note" + (noteClass ? " " + noteClass : ""),
          text: note || "If the one in use does not answer at boot, the others are tried in turn." }));
        if (!note) setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
      }

      document.addEventListener("keydown", onKey, true);
      if (left > 0 && known(settings).length) {
        timer = setInterval(function () {
          left--;
          if (left <= 0) return finish();
          if (!editing) draw();
        }, 1000);
      }
      draw();
    });
  }

  /* The address in use if it answers; otherwise the first saved one
     that does, which becomes the one in use. `say(text, level)` is the
     boot screen's line(). Resolves to { url (null if none is set), ok }. */
  async function reachable(say, opts) {
    opts = opts || {};
    var settings = FieldKit.need("settings");
    var list = known(settings);
    if (!list.length) return { url: null, ok: false };
    if (await answers(list[0], opts.ms)) return { url: list[0], ok: true };
    if (list.length === 1) return { url: list[0], ok: false };   /* nothing else to try */
    if (say) say("  " + shortHost(list[0]) + " does not answer — trying the other saved addresses", "warn");
    for (var i = 1; i < list.length; i++) {
      if (await answers(list[i], opts.ms)) {
        save(settings, list, list[i]);
        if (say) say("  using " + shortHost(list[i]) + " instead", "pass");
        return { url: list[i], ok: true };
      }
    }
    if (say) say("  none of them answers from here", "fail");
    return { url: list[0], ok: false };
  }

  FieldKit.provide("relayChoice", { ask: ask, reachable: reachable, clean: clean, known: known, answers: answers });
})(window.FieldKit);
