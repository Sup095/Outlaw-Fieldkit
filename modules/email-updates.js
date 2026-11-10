/* ============================================================
   FieldKit :: email-updates — EMAIL UPDATES
   Optional. Get an email when something happens while you are away:
   a message, a POOL HALL challenge or your shot, your DEEPHOLD colony
   or the Civilization, a new FieldKit version or an announcement.

   Everything is decided by the relay (relay/mail-updates.js): it waits
   a few minutes so several things go in one email, drops what you have
   already seen in FieldKit, and never puts a message's words in an
   email (it cannot read them). This panel only says who you are, which
   address, and what you want.

   WHO YOU ARE is whatever you are signed in as: MESSAGES, your gamertag
   (DEEPHOLD and POOL HALL), or both, and one address serves both.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var GAMES = "fk.deephold";
  var CATS = [
    { k: "messages", t: "MESSAGES", d: "someone wrote to you (who, never what)", need: "msg" },
    { k: "games", t: "GAMES", d: "POOL HALL challenges, your shot, results", need: "tag" },
    { k: "deephold", t: "DEEPHOLD", d: "your colony, new stages, waves", need: "tag" },
    { k: "fieldkit", t: "FIELDKIT", d: "a new version, admin announcements", need: "" }
  ];
  var ctx, el, host = null, state = null, busy = false, note = "", gone = true;

  function relayBase() {
    var st = FieldKit.service("settings");
    var u = String((st && st.get("relayUrl")) || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }
  function msgs() { var m = FieldKit.service("messages"); return m && m.signedIn && m.signedIn() ? m : null; }
  function game() {
    var dh = FieldKit.service("deephold");
    if (dh && dh.session) { var s = dh.session(); if (s) return s; }
    try { var st = JSON.parse(window.localStorage.getItem(GAMES) || "null"); if (st && st.token && st.tag) return { token: st.token, tag: st.tag }; } catch (e) { /* none */ }
    return null;
  }

  /* Through MESSAGES when signed in there (its token never leaves that
     module); the gamertag rides along in the body. Otherwise straight
     to the relay with the gamertag. */
  async function api(path, body) {
    body = body || {};
    var g = game();
    if (g) body.gameToken = g.token;
    var m = msgs();
    if (m && m.email) return m.email("POST", "/email/" + path, body);
    var base = relayBase();
    if (!base) throw new Error("no relay is set up; add one in RELAY LINK first");
    var headers = { "Content-Type": "application/json" };
    if (g) headers.Authorization = "Bearer " + g.token;
    var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 20000);
    try {
      var res = await window.fetch(base + "/email/" + path, { method: "POST", headers: headers, mode: "cors", cache: "no-store", signal: ac.signal, body: JSON.stringify(body) });
      var text = await res.text(), data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
      if (!res.ok) { var err = new Error((data && data.error) || ("the relay answered " + res.status)); err.status = res.status; err.data = data; throw err; }
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("the relay did not answer in time");
      throw e;
    } finally { clearTimeout(timer); }
  }

  async function load() {
    note = "";
    if (!relayBase()) { state = { noRelay: true }; paint(); return; }
    try { state = await api("me"); }
    catch (e) { state = { error: e.message }; }
    paint();
  }
  async function act(path, body, okNote) {
    if (busy) return;
    busy = true; note = "WORKING..."; paint();
    try {
      var r = await api(path, body);
      if (state) state.sub = r.sub === undefined ? state.sub : r.sub;
      note = okNote || "";
      if (r.sentCode) note = "A CODE IS ON ITS WAY TO " + r.sub.email.toUpperCase() + ". CHECK SPAM TOO.";
    } catch (e) {
      if (e.data && e.data.sub !== undefined && state) state.sub = e.data.sub;
      note = "! " + e.message;
    }
    busy = false;
    paint();
  }

  function catBoxes(cur, me, onChange) {
    var box = el("div", { class: "eu-cats" });
    CATS.forEach(function (c) {
      var off = (c.need === "msg" && !me.msg) || (c.need === "tag" && !me.tag);
      var input = el("input", { type: "checkbox" });
      input.checked = !off && !!(cur ? cur[c.k] : true);
      if (off) input.disabled = true;
      input.dataset.k = c.k;
      if (onChange) input.addEventListener("change", onChange);
      var lab = el("label", { class: "eu-cat" + (off ? " off" : "") }, [
        input, el("span", { class: "eu-ct", text: c.t }),
        el("span", { class: "eu-cd", text: off ? (c.need === "msg" ? "sign in to MESSAGES for this" : "needs your gamertag (POOL HALL or DEEPHOLD)") : c.d })
      ]);
      box.appendChild(lab);
    });
    return box;
  }
  function readCats(box) {
    var out = {};
    Array.prototype.forEach.call(box.querySelectorAll ? box.querySelectorAll("input") : [], function (i) { out[i.dataset.k] = !!i.checked; });
    return out;
  }
  function btn(label, fn, cls) { return el("button", { class: "fk-btn" + (cls ? " " + cls : ""), text: label, disabled: busy, onclick: fn }); }
  function open(id) { var sh = FieldKit.service("shell"); if (sh && sh.open) sh.open(id); }

  function paint() {
    if (!host || gone) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    var root = el("div", { class: "eu-root" });
    host.appendChild(root);
    root.appendChild(el("div", { class: "eu-head" }, [el("span", { class: "eu-logo", text: "✉ EMAIL UPDATES" }), el("span", { class: "eu-sub", text: "OPTIONAL · ALONGSIDE FIELDKIT'S OWN NOTICES" })]));
    var body = el("div", { class: "eu-body" });
    root.appendChild(body);
    var how = el("p", { class: "eu-p", text: "Get an email when something happens while you are away. The relay waits about 5 minutes after the first thing so everything goes in one email, sends at most one every 15 minutes, and skips anything you have already seen in FieldKit." });

    if (!state) { body.appendChild(el("p", { class: "eu-p", text: "LOOKING..." })); return; }
    if (state.noRelay) { body.appendChild(how); body.appendChild(el("p", { class: "eu-warn", text: "No relay is set up. Add one in RELAY LINK first." })); body.appendChild(el("div", { class: "eu-row" }, [btn("OPEN RELAY LINK", function () { open("relay-link"); })])); return; }
    if (state.error) { body.appendChild(el("p", { class: "eu-warn", text: "! " + state.error })); body.appendChild(el("div", { class: "eu-row" }, [btn("TRY AGAIN", load)])); return; }
    body.appendChild(how);
    if (!state.up) { body.appendChild(el("p", { class: "eu-warn", text: "This relay does not send email yet. Its admin turns it on with an email account in the relay's settings (relay/README.md, EMAIL UPDATES)." })); return; }

    var me = state.me || {};
    var who = [];
    if (me.msg) who.push("MESSAGES @" + me.msg);
    if (me.tag) who.push("GAMERTAG " + me.tag);
    body.appendChild(el("div", { class: "eu-who", text: who.length ? "SIGNED IN AS: " + who.join("  ·  ") : "NOT SIGNED IN" }));
    if (!me.msg || !me.tag) {
      var row = el("div", { class: "eu-row" });
      if (!me.msg) row.appendChild(btn("SIGN IN TO MESSAGES", async function () { var m = FieldKit.service("messages"); if (m && m.promptSignIn) { try { await m.promptSignIn("for email updates"); } catch (e) { /* closed */ } } load(); }));
      if (!me.tag) row.appendChild(btn("GET A GAMERTAG (POOL HALL)", function () { open("pool"); }));
      row.appendChild(btn("REFRESH", load));
      body.appendChild(row);
      if (!who.length) { body.appendChild(el("p", { class: "eu-p dim", text: "Sign in with either one (or both) so the relay knows whose updates these are." })); return; }
    }

    var s = state.sub;
    if (!s) {
      var mail = el("input", { class: "fk-input eu-mail", type: "email", placeholder: "you@example.com", autocomplete: "email" });
      var cats = catBoxes(null, me);
      body.appendChild(el("div", { class: "eu-card" }, [
        el("div", { class: "eu-h", text: "WHERE TO SEND THEM" }), mail,
        el("div", { class: "eu-h", text: "WHAT TO SEND" }), cats,
        el("div", { class: "eu-row" }, [btn("SEND ME A CODE", function () { act("subscribe", { email: mail.value.trim(), cats: readCats(cats) }); }, "eu-go")]),
        el("p", { class: "eu-p dim", text: "The relay emails a 6-digit code to prove the address is yours. Your address is kept only on this relay and only used for these updates." })
      ]));
    } else if (!s.verified) {
      var code = el("input", { class: "fk-input eu-code", type: "text", inputmode: "numeric", maxlength: "6", placeholder: "123456", autocomplete: "one-time-code" });
      code.addEventListener("keydown", function (e) { if (e.key === "Enter") act("verify", { code: code.value }, "DONE. EMAIL UPDATES ARE ON."); });
      body.appendChild(el("div", { class: "eu-card" }, [
        el("div", { class: "eu-h", text: "TYPE THE CODE SENT TO " + s.email.toUpperCase() }), code,
        el("div", { class: "eu-row" }, [
          btn("CONFIRM", function () { act("verify", { code: code.value }, "DONE. EMAIL UPDATES ARE ON."); }, "eu-go"),
          btn("SEND IT AGAIN", function () { act("resend", {}, "SENT AGAIN. CHECK SPAM TOO."); }),
          btn("USE ANOTHER ADDRESS", function () { act("stop", {}, ""); })
        ])
      ]));
    } else {
      var cats2 = catBoxes(s.cats, me, function () { act("settings", { cats: readCats(cats2) }, "SAVED."); });
      body.appendChild(el("div", { class: "eu-card" }, [
        el("div", { class: "eu-on", text: "● ON — SENDING TO " + s.email.toUpperCase() }),
        el("div", { class: "eu-h", text: "WHAT TO SEND (SAVED WHEN YOU CLICK)" }), cats2,
        el("p", { class: "eu-p dim", text: s.waiting ? s.waiting + " update(s) waiting for the next email." : "Nothing waiting right now." + (s.last ? " Last email " + new Date(s.last).toLocaleString() + "." : "") }),
        el("div", { class: "eu-row" }, [
          btn("SEND A TEST EMAIL", function () { act("test", {}, "TEST SENT. IT CAN TAKE A MINUTE."); }),
          btn("CHANGE ADDRESS", function () { state.sub = null; note = ""; paint(); }),
          btn("TURN OFF EMAILS", function () { if (!window.confirm || window.confirm("Stop all email updates to " + s.email + "?")) act("stop", {}, "EMAIL UPDATES ARE OFF."); }, "eu-stop")
        ])
      ]));
    }
    if (note) body.appendChild(el("div", { class: note.charAt(0) === "!" ? "eu-warn" : "eu-note", text: note }));
  }

  function css() {
    if (document.getElementById("eu-css")) return;
    var s = document.createElement("style"); s.id = "eu-css";
    s.textContent = [
      ".eu-root{position:absolute;inset:0;display:flex;flex-direction:column;color:var(--fg);font-size:12px;overflow:hidden}",
      ".eu-head{display:flex;gap:10px;align-items:center;padding:9px 14px;border-bottom:1px solid var(--line)}",
      ".eu-logo{letter-spacing:.28em;font-weight:bold;color:#9fe0b8}.eu-sub{color:var(--fg-dimmer);font-size:10px;letter-spacing:.12em}",
      ".eu-body{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;max-width:640px}",
      ".eu-p{margin:0;line-height:1.55;color:var(--fg-dim)}.eu-p.dim{color:var(--fg-dimmer);font-size:11px}",
      ".eu-who{letter-spacing:.12em;font-size:11px;color:var(--fg)}",
      ".eu-card{border:1px solid var(--line2);background:rgba(0,0,0,.25);padding:12px;display:flex;flex-direction:column;gap:8px}",
      ".eu-h{letter-spacing:.16em;font-size:10px;color:#e8b14a}",
      ".eu-cats{display:flex;flex-direction:column;gap:5px}.eu-cat{display:flex;gap:8px;align-items:center;cursor:pointer}",
      ".eu-cat.off{opacity:.55}.eu-ct{min-width:84px;letter-spacing:.12em}.eu-cd{color:var(--fg-dimmer);font-size:11px}",
      ".eu-row{display:flex;gap:6px;flex-wrap:wrap}.eu-mail,.eu-code{max-width:340px}.eu-code{letter-spacing:.4em;font-size:16px}",
      ".eu-on{color:#6fdc90;letter-spacing:.12em}.eu-warn{color:#ff9a7a;line-height:1.5}.eu-note{color:#9fe0b8;letter-spacing:.08em}",
      ".fk-btn.eu-go{border-color:#6fdc90;color:#9fe0b8}.fk-btn.eu-stop{border-color:#c0453a;color:#ff9a7a}"
    ].join("\n");
    document.head.appendChild(s);
  }

  FieldKit.provide("emailUpdates", { _state: function () { return state; }, _load: load, _act: act });

  FieldKit.register("email-updates", {
    title: "EMAIL UPDATES",
    icon: "✉",
    group: "ONLINE",
    about: "Optional emails when someone messages you, challenges you, or your colony needs you",
    keywords: "email mail notify notifications updates alerts digest inbox challenge messages deephold pool",
    width: 620,
    height: 560,
    guestSafe: true,
    selfcheck: function () {
      return [{ name: "EMAIL UPDATES ON THIS RELAY", critical: false, run: async function () {
        var base = relayBase();
        if (!base) return "no relay set up, so no email updates";
        var res = await window.fetch(base + "/email/status", { cache: "no-store", mode: "cors" });
        if (res.status === 404) return "this relay is older than email updates";
        var d = JSON.parse((await res.text()) || "{}");
        return d.up ? "on: people can sign up in EMAIL UPDATES" : "off: the relay has no email account set";
      } }];
    },
    async mount(h, context) {
      ctx = context; el = ctx.ui.el; host = h; gone = false; state = null; note = "";
      css();
      paint();
      await load();
    },
    unmount() { gone = true; host = null; }
  });
})(window.FieldKit);
