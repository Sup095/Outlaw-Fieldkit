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

  /* Does a relay answer here? Its /health is public and says little.
     It must say it is a FieldKit relay: a school filter's "blocked" page
     can answer 200 too, and was taken for a working relay. */
  async function answers(url, ms) {
    if (typeof fetch !== "function") return false;
    var ac = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, ms || PROBE_MS);
    try {
      var r = await fetch(url + "/health", { cache: "no-store", signal: ac ? ac.signal : undefined });
      if (!r || !r.ok) return false;
      var j = null;
      try { j = await r.json(); } catch (e) { return false; }
      return !!(j && j.service === "fieldkit-relay");
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
    ".rc-ok{color:var(--pass)} .rc-bad{color:var(--fail)}",
    ".rc-ask{display:flex;gap:8px;align-items:flex-start;font-size:11px;cursor:pointer;margin:6px 0}",
    ".rc-ask input{accent-color:var(--accent);margin-top:2px}",
    ".rc-ask-note{display:block;font-size:10px;color:var(--fg-dimmer);margin-top:2px}"
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
            btn(cur ? "CHANGE OR ADD ADDRESS" : "ADD AN ADDRESS", function () { editing = true; draw(); }),
            /* For a drive that always uses the same relay: the countdown
               is then a few seconds lost at every start. */
            cur ? btn("DON'T ASK AT START", function () { settings.set("relayAskAtBoot", false); finish(); },
              "go straight to this address from now on; RELAY LINK can turn the question back on") : null
          ].filter(Boolean)));
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

  /* ---- learning the relay's addresses ---------------------------
     The relay reads its own tunnel and lists every hostname that
     reaches it (relay/addresses.js), for anyone signed in. After a
     sign-in (MESSAGES, or the vault) this asks for that list and:
       - keeps every address it gives, as a spare;
       - forgets a saved address on the same domain that it no longer
         gives: the owner deleted it, most likely because it was
         blocked;
       - if the one in use was among those, moves to the first given
         address that answers.
     Addresses on another domain are left alone: they may be another
     relay's, typed in by hand. Nothing changes on an empty list (a
     relay without a tunnel, or an old one). */
  var LEARN_GAP_MS = 60000, LEARN_EVERY_MS = 30 * 60000;
  var learntAt = 0, learning = null;

  function domainOf(u) {
    try { return new URL(u).hostname.toLowerCase().split(".").slice(-2).join("."); } catch (e) { return ""; }
  }

  /* The list itself, merged with what is saved: { list, current }. Pure,
     for the tests. */
  function merge(saved, current, given) {
    var domains = given.map(domainOf);
    var keep = saved.filter(function (u) { return given.indexOf(u) >= 0 || domains.indexOf(domainOf(u)) < 0; });
    given.forEach(function (u) { if (keep.indexOf(u) < 0) keep.push(u); });
    var gone = current && keep.indexOf(current) < 0;
    return { list: keep, current: gone ? null : current, dropped: saved.filter(function (u) { return keep.indexOf(u) < 0; }) };
  }

  async function askRelay() {
    var msg = FieldKit.service("messages");
    if (msg && typeof msg.relayAddresses === "function" && msg.signedIn && msg.signedIn()) {
      try { var a = await msg.relayAddresses(); if (a) return a; } catch (e) { /* the vault next */ }
    }
    var tr = FieldKit.service("transportRelay");
    if (tr && typeof tr.addresses === "function") {
      try { return await tr.addresses(); } catch (e) { return null; }
    }
    return null;
  }

  async function learn(opts) {
    opts = opts || {};
    if (learning) return learning;
    if (!opts.force && Date.now() - learntAt < LEARN_GAP_MS) return null;
    learning = (async function () {
      var settings = FieldKit.need("settings");
      var got = await askRelay();
      var given = (got && Array.isArray(got.addresses) ? got.addresses : []).map(clean).filter(Boolean);
      if (!given.length) return null;
      learntAt = Date.now();
      var saved = known(settings), current = saved[0] || null;
      var m = merge(saved, current, given);
      var use = m.current;
      if (!use) {
        for (var i = 0; i < given.length && !use; i++) if (await answers(given[i])) use = given[i];
        use = use || given[0];
      }
      var added = given.filter(function (u) { return saved.indexOf(u) < 0; });
      if (!added.length && !m.dropped.length && use === current) return { added: [], dropped: [], switched: null };
      save(settings, m.list, use);
      settings.set("relayAddressesAt", new Date().toISOString());
      FieldKit.log("info", "relay-choice", "learnt " + given.length + " address(es): +" + added.length + " −" + m.dropped.length);
      var ui = FieldKit.service("ui");
      if (ui && ui.toast && (added.length || use !== current)) {
        ui.toast(use !== current ? "NOW USING " + shortHost(use).toUpperCase() + " (THE OLD ADDRESS WAS REMOVED)"
          : added.length + " NEW RELAY ADDRESS" + (added.length > 1 ? "ES" : "") + " SAVED", "ok");
      }
      return { added: added, dropped: m.dropped, switched: use !== current ? use : null };
    })();
    try { return await learning; } finally { learning = null; }
  }

  /* After a sign-in either way, and now and then while open. And when
     the address in use changes, the vault moves to it at once rather
     than at the next restart (store.reconnect()). */
  if (FieldKit.on) {
    FieldKit.on("settings:changed", function (e) {
      if (!e || e.key !== "relayUrl") return;
      var u = clean(e.value);
      var tr = FieldKit.service("transportRelay"), store = FieldKit.service("store");
      if (!u || !tr || typeof tr.configure !== "function" || !store || typeof store.reconnect !== "function") return;
      if (tr.url && tr.url() === u) return;
      var st = FieldKit.service("settings");
      tr.configure(u, { provisionToken: (st && st.get("relayProvisionToken")) || "" });
      store.reconnect().catch(function () {});
    });
    FieldKit.on("messages:session", function () { learn().catch(function () {}); });
    FieldKit.on("store:state", function (e) { if (e && e.state === "ONLINE") learn().catch(function () {}); });
    if (typeof setInterval === "function") setInterval(function () { learn().catch(function () {}); }, LEARN_EVERY_MS);
  }

  /* What both boot screens do. When no saved address answers, the
     choice is shown again however DON'T ASK AT START is set, with a
     longer countdown: a blocked address used to leave a drive that had
     turned the question off with no way to type a new one but clearing
     the browser's site data. */
  var STUCK_WAIT_S = 30;
  async function choose(host, say) {
    var settings = FieldKit.need("settings");
    if (settings.get("relayAskAtBoot") !== false) await ask(host);
    var r = await reachable(say);
    if (r.url && !r.ok) {
      if (say) say("  it may be blocked on this network: add another address below, or carry on without the relay", "warn");
      await ask(host, { waitS: STUCK_WAIT_S });
      if (known(settings)[0] !== r.url) r = await reachable(say);
    }
    return r;
  }

  /* The same choice, after boot: RELAY LINK shows it in both builds. */
  function askToggle(settings) {
    var ui = FieldKit.need("ui"), el = ui.el;
    style();
    var input = el("input", { type: "checkbox" });
    input.checked = settings.get("relayAskAtBoot") !== false;
    input.addEventListener("change", function () {
      settings.set("relayAskAtBoot", input.checked);
      ui.toast(input.checked ? "THE ADDRESS IS ASKED AT START" : "STARTS STRAIGHT WITH THE ADDRESS IN USE", "ok");
    });
    return el("label", { class: "rc-ask" }, [input, el("span", {}, [
      el("span", { text: "ASK WHICH ADDRESS AT START" }),
      el("span", { class: "rc-ask-note", text: "a few seconds to change it before connecting; off goes straight to the one in use" })
    ])]);
  }

  FieldKit.provide("relayChoice", { askToggle: askToggle, ask: ask, reachable: reachable, clean: clean, known: known, save: save,
    answers: answers, learn: learn, merge: merge, choose: choose });
})(window.FieldKit);
