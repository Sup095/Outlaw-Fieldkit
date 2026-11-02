/* ============================================================
   FieldKit :: notices
   What the relay wants everyone to know, and what you missed.

   THE BANNER shows exactly what GET /notices last said (relay/
   notices.js). Nothing is stored: the relay stops listing a thing the
   moment it stops being true, and it is gone from here on the next
   ask, whether or not anyone read it. ✕ hides that one occurrence for
   this session; a new occurrence is a new notice.

   THE BELL in the tray is the same idea for this machine: every toast
   and notice since the page opened, with its time, because a toast is
   gone in four seconds and you may have been looking at something else.
   Memory only; it goes with the page.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ui = FieldKit.need("ui");
  var el = ui.el;

  var POLL_MS = 60000;
  var HISTORY_MAX = 100;
  /* What to say when one that was on screen clears. */
  var BACK = { browser: "BROWSER IS BACK", runner: "RUNNER IS BACK", helpers: "BROWSER HAS ITS FULL ROOM AGAIN", lens: "THE FAST BROWSER IS BACK" };

  var current = [];         /* the relay's list, as last given */
  var hidden = {};          /* id|since -> true */
  var history = [];
  var unseen = 0;
  var bar, bell, panel, timer, desktop;

  function relayBase() {
    var st = FieldKit.service("settings");
    var u = String((st && st.get("relayUrl")) || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }

  function key(n) { return n.id + "|" + n.since; }

  function remember(text, level) {
    history.unshift({ at: Date.now(), text: String(text), level: level || "info" });
    if (history.length > HISTORY_MAX) history.pop();
    unseen++;
    drawBell();
  }

  function drawBell() {
    if (!bell) return;
    bell.textContent = unseen ? "◉ " + Math.min(unseen, 99) : "◉";
    bell.classList.toggle("on", unseen > 0);
    if (panel && panel.parentNode) fillPanel();
  }

  function drawBar() {
    if (!bar) return;
    ui.clear(bar);
    var shown = current.filter(function (n) { return !hidden[key(n)]; });
    shown.forEach(function (n) {
      bar.appendChild(el("div", { class: "fk-notice lvl-" + n.level }, [
        el("span", { class: "t", text: n.text }),
        el("button", { class: "x", type: "button", text: "✕", title: "hide this until it happens again",
          onclick: function () { hidden[key(n)] = true; drawBar(); } })
      ]));
    });
    if (desktop) {
      desktop.classList.toggle("has-notices", shown.length > 0);
      if (desktop.style && desktop.style.setProperty) desktop.style.setProperty("--fk-notices", (shown.length * 26) + "px");
    }
    FieldKit.emit("shell:resize", { id: null });
  }

  /* Takes the relay's list as it is. What was on screen and is no
     longer listed has cleared; the rest of the rule is the relay's. */
  function apply(list) {
    var was = current;
    current = Array.isArray(list) ? list.filter(function (n) {
      return n && n.id && n.text;
    }) : [];
    current.forEach(function (n) {
      if (!was.some(function (o) { return key(o) === key(n); })) remember(n.text, n.level);
    });
    was.forEach(function (o) {
      if (current.some(function (n) { return n.id === o.id; })) return;
      delete hidden[key(o)];
      if (BACK[o.id]) { remember(BACK[o.id], "ok"); ui.toast(BACK[o.id], "ok"); }
    });
    drawBar();
  }

  async function poll() {
    if (document.hidden) return;
    var base = relayBase();
    if (!base) return apply([]);
    try {
      var r = await fetch(base + "/notices", { cache: "no-store" });
      if (!r.ok) return;
      var j = await r.json();
      apply(j && j.notices);
    } catch (e) { /* the tray already says the relay is not answering */ }
  }

  function fillPanel() {
    ui.clear(panel);
    panel.appendChild(el("div", { class: "h" }, [
      el("span", { text: "WHAT HAPPENED" }),
      el("button", { class: "fk-task", type: "button", text: "CLEAR", onclick: function () { history = []; unseen = 0; drawBell(); } }),
      el("button", { class: "fk-task", type: "button", text: "CLOSE", onclick: closePanel })
    ]));
    if (!history.length) panel.appendChild(el("div", { class: "n", text: "Nothing yet." }));
    history.forEach(function (h) {
      var d = new Date(h.at);
      panel.appendChild(el("div", { class: "r lvl-" + h.level }, [
        el("span", { class: "w", text: String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") }),
        el("span", { class: "m", text: h.text })
      ]));
    });
  }

  function closePanel() { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); }

  function togglePanel() {
    if (panel && panel.parentNode) return closePanel();
    panel = el("div", { class: "fk-bell-panel" });
    unseen = 0;
    drawBell();
    fillPanel();
    desktop.appendChild(panel);
  }

  /* Called once by the shell, when there is a desktop to put them on. */
  function attach(desk, tray) {
    desktop = desk;
    bar = el("div", { id: "fk-notices" });
    desk.appendChild(bar);
    bell = el("button", { class: "fk-task fk-bell", type: "button", text: "◉",
      title: "what happened: messages from FieldKit you may have missed", onclick: togglePanel });
    tray.insertBefore(bell, tray.firstChild);
    FieldKit.on("ui:toast", function (t) { remember(t.text, t.level); });
    poll();
    timer = setInterval(poll, POLL_MS);
    if (document.addEventListener) document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
  }

  FieldKit.provide("notices", {
    attach: attach,
    poll: poll,
    apply: apply,
    list: function () { return current.slice(); },
    history: function () { return history.slice(); },
    unseen: function () { return unseen; },
    togglePanel: togglePanel,
    stop: function () { if (timer) clearInterval(timer); timer = null; }
  });
})(window.FieldKit);
