/* ============================================================
   FieldKit :: easter-eggs
   The hidden layer (§6). Three ways in:

     · the Konami code           → flips CRT mode
     · typing a secret word      → whatever that word does
     · a hidden command palette
       entry once you've found
       at least one              → the credits reel

   Everything here is cosmetic on purpose. Nothing an easter egg
   does may touch the vault, the relay, or a setting the user would
   be upset to find changed — a surprise that edits your data is
   not a surprise, it is a bug.

   Discoveries are remembered in localStorage rather than the vault,
   so finding one does not require being unlocked and does not
   pollute the record store.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var KEY = "fieldkit.eggs.v1";

  var KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
                "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

  var found = {};
  var konamiAt = 0;
  var typed = "";
  var TYPED_MAX = 24;

  function ui() { return FieldKit.need("ui"); }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) found = JSON.parse(raw) || {};
    } catch (e) { found = {}; }
    return found;
  }

  function remember(id) {
    var first = !found[id];
    found[id] = found[id] || new Date().toISOString();
    try { localStorage.setItem(KEY, JSON.stringify(found)); } catch (e) { /* fine */ }
    if (first) FieldKit.emit("egg:found", { id: id, count: Object.keys(found).length });
    return first;
  }

  function announce(id, text) {
    var first = remember(id);
    ui().toast((first ? "DISCOVERED :: " : "") + text, first ? "ok" : "info");
    var sfx = FieldKit.service("sound");
    if (sfx && sfx.enabled()) { try { sfx.tone(first ? 880 : 620, 0.09); } catch (e) { /* silent */ } }
  }

  /* ---- the eggs ------------------------------------------------ */
  /* Each is { id, name, hint, run }. `hint` is what the credits reel
     shows for one you have not found — enough to be a nudge, not a
     giveaway. */
  var EGGS = [
    {
      id: "konami", name: "THE OLD WAYS", hint: "Thirty lives. You know the one.",
      run: function () {
        document.body.classList.toggle("crt");
        var on = document.body.classList.contains("crt");
        var s = FieldKit.service("settings");
        if (s) s.set("crt", on);
        announce("konami", "CRT MODE " + (on ? "ENGAGED" : "DISENGAGED"));
      }
    },
    {
      id: "outlaw", name: "HOUSE STYLE", hint: "Type the name on the boot screen.",
      word: "outlaw",
      run: function () {
        announce("outlaw", "OUTLAW SYSTEMS — STILL RUNNING");
        flash("OUTLAW SYSTEMS");
      }
    },
    {
      id: "bastion", name: "HOME NETWORK", hint: "Type the name of the network this thing serves.",
      word: "bastion",
      run: function () {
        announce("bastion", "BASTION ACKNOWLEDGED");
        flash("BASTION ONLINE");
      }
    },
    {
      id: "credits", name: "ROLL IT", hint: "Type what you'd type to see who made something.",
      word: "credits",
      run: function () {
        remember("credits");
        showCredits();
      }
    },
    {
      id: "hello", name: "MANNERS", hint: "Greet it the way you'd greet anyone.",
      word: "hello",
      run: function () {
        var ai = FieldKit.service("ai");
        var line = ai ? ai.flavor("hello-" + new Date().toDateString()) : "hello yourself";
        announce("hello", String(line).toUpperCase().slice(0, 60));
      }
    }
  ];

  function byWord(w) {
    return EGGS.filter(function (e) { return e.word; })
      .find(function (e) { return e.word === w; });
  }

  /* ---- flash overlay ------------------------------------------- */
  function flash(text) {
    injectCSS();
    var el = ui().el;
    var node = el("div", { class: "egg-flash" }, [el("span", { text: text })]);
    document.body.appendChild(node);
    setTimeout(function () {
      node.classList.add("out");
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 500);
    }, 1100);
  }

  /* ---- credits reel -------------------------------------------- */
  var creditsOpen = false;

  function showCredits() {
    if (creditsOpen) return;
    creditsOpen = true;
    injectCSS();
    var el = ui().el;

    var total = EGGS.length;
    var got = EGGS.filter(function (e) { return found[e.id]; }).length;

    var lines = [
      { t: "F I E L D K I T", cls: "egg-title" },
      { t: "portable command console", cls: "egg-sub" },
      { t: "v" + FieldKit.VERSION + " · OUTLAW SYSTEMS", cls: "egg-sub" },
      { t: "", cls: "" },
      { t: "BUILT FOR", cls: "egg-head" },
      { t: "a school Chromebook with no terminal,", cls: "egg-line" },
      { t: "a Pterodactyl box on the other end of a tailnet,", cls: "egg-line" },
      { t: "and a USB stick that has to work anywhere.", cls: "egg-line" },
      { t: "", cls: "" },
      { t: "PRINCIPLES", cls: "egg-head" },
      { t: "the server never learns your password", cls: "egg-line" },
      { t: "offline is a mode, not an error", cls: "egg-line" },
      { t: "a broken module gets a dead window, not a dead desktop", cls: "egg-line" },
      { t: "nothing is claimed that was not tested", cls: "egg-line" },
      { t: "", cls: "" },
      { t: "COUNTS", cls: "egg-head" },
      { t: Object.keys(FieldKit.modules()).length + " modules", cls: "egg-line" },
      { t: FieldKit.logs().length + " log lines this session", cls: "egg-line" },
      { t: got + " of " + total + " secrets found", cls: "egg-line" },
      { t: "", cls: "" },
      { t: "STILL HIDDEN", cls: "egg-head" }
    ];

    EGGS.forEach(function (e) {
      if (found[e.id]) lines.push({ t: "✔ " + e.name, cls: "egg-got" });
      else lines.push({ t: "· " + e.hint, cls: "egg-hint" });
    });

    lines.push({ t: "", cls: "" });
    lines.push({ t: "press ESC to close", cls: "egg-sub" });

    var reel = el("div", { class: "egg-reel" },
      lines.map(function (l) { return el("div", { class: l.cls || "egg-line", text: l.t }); }));

    var overlay = el("div", { class: "egg-overlay" }, [
      el("div", { class: "egg-window" }, [reel])
    ]);

    function close() {
      creditsOpen = false;
      window.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    }

    overlay.addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
  }

  /* ---- input watching ------------------------------------------ */
  /* Ignores keystrokes aimed at a field — typing "credits" into the
     scratchpad should write the word, not fire an egg. */
  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || "").toUpperCase();
    /* data-fk-keys: an element whose keys belong to something else,
       like a program window streamed from the run server. */
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable ||
      !!(t.closest && t.closest("[data-fk-keys]"));
  }

  /* This file deliberately knows about nothing — see the blast-radius
     rule in tests/eggs.test.js. It does not need a lock check of its
     own: core/lockscreen.js loads first and swallows keystrokes at
     capture on window while locked, so this handler never runs
     behind the lock screen. */
  function onKeydown(e) {
    if (isTyping(e)) { konamiAt = 0; typed = ""; return; }

    /* Konami: arrows are meaningless anywhere else on the desktop. */
    var want = KONAMI[konamiAt];
    if (e.key === want || (want.length === 1 && e.key.toLowerCase() === want)) {
      konamiAt++;
      if (konamiAt === KONAMI.length) {
        konamiAt = 0;
        EGGS[0].run();
        return;
      }
    } else {
      konamiAt = (e.key === KONAMI[0]) ? 1 : 0;
    }

    /* Typed words. */
    if (e.key.length === 1 && /[a-z]/i.test(e.key)) {
      typed = (typed + e.key.toLowerCase()).slice(-TYPED_MAX);
      var hit = EGGS.filter(function (x) { return x.word; })
        .find(function (x) { return typed.endsWith(x.word); });
      if (hit) { typed = ""; hit.run(); }
    } else if (e.key !== "Shift") {
      typed = "";
    }
  }

  function init() {
    load();
    window.addEventListener("keydown", onKeydown, true);
    FieldKit.log("info", "easter-eggs", "watching (" + Object.keys(found).length + " already found)");
  }

  function injectCSS() {
    if (document.getElementById("egg-style")) return;
    var s = document.createElement("style");
    s.id = "egg-style";
    s.textContent = `
.egg-flash{position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;
  pointer-events:none;background:radial-gradient(circle,rgba(var(--accent-glow),.1),transparent 60%)}
.egg-flash span{color:var(--accent);font-family:var(--mono);font-size:34px;letter-spacing:.36em;
  text-shadow:0 0 30px rgba(var(--accent-glow),.7);animation:egg-in .4s ease-out}
.egg-flash.out{opacity:0;transition:opacity .5s}
@keyframes egg-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}

.egg-overlay{position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;
  background:rgba(6,8,7,.93);cursor:pointer}
.egg-window{width:520px;max-width:calc(100vw - 40px);max-height:calc(100vh - 80px);overflow:hidden;
  border:1px solid var(--accent-dim);background:#0b0e0c;padding:26px 28px;
  box-shadow:0 0 0 1px rgba(var(--accent-glow),.12),0 26px 80px rgba(0,0,0,.85)}
.egg-reel{font-family:var(--mono);text-align:center;animation:egg-roll .6s ease-out}
@keyframes egg-roll{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.egg-title{color:var(--accent);font-size:17px;letter-spacing:.42em;
  text-shadow:0 0 18px rgba(var(--accent-glow),.4)}
.egg-sub{color:var(--fg-dimmer);font-size:9px;letter-spacing:.24em;margin-top:4px}
.egg-head{color:var(--accent);font-size:9px;letter-spacing:.28em;margin:14px 0 5px}
.egg-line{color:var(--fg-dim);font-size:11px;line-height:1.7}
.egg-got{color:var(--pass);font-size:11px;line-height:1.7;letter-spacing:.1em}
.egg-hint{color:var(--fg-dimmer);font-size:10px;line-height:1.7;font-style:italic}
@media (prefers-reduced-motion: reduce){
  .egg-reel,.egg-flash span{animation:none}
}
`;
    document.head.appendChild(s);
  }

  FieldKit.provide("easterEggs", {
    init: init,
    EGGS: EGGS,
    KONAMI: KONAMI,
    found: function () { return Object.assign({}, found); },
    foundCount: function () { return Object.keys(found).length; },
    total: function () { return EGGS.length; },
    showCredits: showCredits,
    /* exposed so the command palette can offer the reel once at
       least one secret has been found — and not before. */
    unlocked: function () { return Object.keys(found).length > 0; },
    /* target lets a test prove the typing-into-a-field guard works. */
    _feed: function (key, target) { onKeydown({ key: key, target: target || null }); },
    _reset: function () {
      found = {};
      try { localStorage.removeItem(KEY); } catch (e) { /* fine */ }
    }
  });
})(window.FieldKit);
