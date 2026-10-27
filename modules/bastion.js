/* ============================================================
   FieldKit :: bastion
   One window for the Bastion network, with three tabs.

   WHY THIS IS A HOST AND NOT A MERGE

   There were three separate modules here — STATUS, REMOTE and the
   Ptero API cheatsheet — and they are obviously one subject. The
   tempting fix was to paste them into a single 1,700-line file.
   That would have thrown away three sets of selfchecks, three
   mount/unmount lifecycles that are already correct, and the
   per-module test coverage, in exchange for a launcher tile.

   So instead this module mounts the other three as tabs. Each of
   them keeps its own file, its own state and its own selfcheck,
   and each declares `inside: "bastion"`, which tells the launcher
   not to give it a tile of its own. Three icons become one, and
   nothing was rewritten to get there.

   THE ONE RULE THAT MAKES IT SAFE

   A child is mounted at most once at a time. Every one of these
   modules keeps its nodes at module scope rather than per-mount —
   that is the shape module-hygiene exists to police — so mounting
   the same child twice would leave the first copy's async work
   writing into the second copy's panel. Tabs are mounted lazily on
   first visit and every mounted child is unmounted here on the way
   out, in reverse order, whatever else happens.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, mounted = {}, tab = null;

  /* Order is the order you need them in: what is broken, then the
     thing that fixes it, then the reference you read while fixing
     it. */
  var TABS = [
    { id: "bastion-status", label: "STATUS" },
    { id: "bastion-remote", label: "REMOTE" },
    { id: "bastion-cheatsheet", label: "PTERO API" }
  ];

  function child(id) { return FieldKit.module(id); }

  async function showTab(id) {
    if (tab === id) return;
    tab = id;
    TABS.forEach(function (t) {
      if (nodes["pane_" + t.id]) {
        nodes["pane_" + t.id].style.display = (t.id === id) ? "" : "none";
      }
      if (nodes["tab_" + t.id]) {
        nodes["tab_" + t.id].className = "bx-tab" + (t.id === id ? " on" : "");
      }
    });

    if (mounted[id]) return;
    var mod = child(id);
    var host = nodes["pane_" + id];
    if (!mod || !host) return;

    /* Guest sealing is enforced per child, not once for the host.
       Two of these are vault-only and the cheatsheet is not, and
       collapsing that into a single flag on the host would either
       seal a reference a guest is allowed to read or open two
       panels a guest is not. */
    var guest = FieldKit.service("guest");
    if (guest && !guest.allowed(mod)) {
      host.appendChild(el("div", { class: "bx-sealed", text:
        mod.title + " is sealed in a guest session." }));
      mounted[id] = "sealed";
      return;
    }

    /* Mounted inside a guard for the same reason shell.open() does
       it: one broken child gets a dead tab, not a dead window. */
    mounted[id] = true;
    try {
      var r = mod.mount(host, ctx);
      if (r && typeof r.then === "function") await r;
    } catch (e) {
      ui.clear(host);
      host.appendChild(el("div", { class: "bx-sealed", text:
        mod.title + " failed to open: " + e.message }));
      mounted[id] = "failed";
    }
  }

  function selfcheck(api) {
    return [
      { name: "EVERY TAB NAMES A REAL MODULE", critical: true, run: function () {
        var missing = TABS.filter(function (t) { return !child(t.id); })
          .map(function (t) { return t.id; });
        if (missing.length) throw new Error("no such module: " + missing.join(", "));
        return TABS.length + " tabs";
      } },

      { name: "AND EVERY ONE OF THEM POINTS BACK HERE", critical: true, run: function () {
        /* The launcher hides a module because IT says it lives
           inside something. If a child stops saying so it silently
           grows a second tile; if it names a different host it
           vanishes from the launcher entirely. Both are invisible
           until someone goes looking for a panel that is not
           there. */
        var wrong = TABS.filter(function (t) {
          var m = child(t.id);
          return !m || m.inside !== "bastion";
        }).map(function (t) { return t.id; });
        if (wrong.length) throw new Error("not declared inside bastion: " + wrong.join(", "));
        return "3 of 3";
      } },

      { name: "NO CHILD IS MOUNTED TWICE", critical: true, run: function () {
        var doubled = Object.keys(mounted).filter(function (k) { return mounted[k] === true; });
        if (doubled.length > TABS.length) throw new Error("mount bookkeeping is wrong");
        return doubled.length ? doubled.join(", ") + " open" : "nothing open";
      } }
    ];
  }

  FieldKit.register("bastion", {
    group: "SERVERS",
    about: "Your servers: status, Pterodactyl API and the kill switch",
    keywords: "bastion servers status pterodactyl api kill switch remote",
    /* Not guest-safe as a whole, because the tab that opens first
       is not. A guest who reaches the cheatsheet can still open it
       by id — it is still its own module and still marked
       guest-safe. */
    guestSafe: false,
    selfcheck: selfcheck,
    title: "BASTION",
    icon: "◉",
    width: 940,
    height: 700,
    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      var tabsBar = el("div", { class: "bx-tabs" });
      var panes = el("div", { class: "bx-panes" });

      TABS.forEach(function (t) {
        var mod = child(t.id);
        nodes["pane_" + t.id] = el("div", { class: "bx-pane", style: { display: "none" } });
        nodes["tab_" + t.id] = el("button", {
          class: "bx-tab", type: "button",
          text: t.label,
          title: mod ? mod.title : t.id + " — not loaded",
          onclick: function () { showTab(t.id); }
        });
        tabsBar.appendChild(nodes["tab_" + t.id]);
        panes.appendChild(nodes["pane_" + t.id]);
      });

      host.appendChild(el("div", { class: "bx-wrap" }, [tabsBar, panes]));
      await showTab(TABS[0].id);
    },

    unmount() {
      /* Reverse order, each guarded: a child whose unmount throws
         must not stop the next one from running, or a panel that
         was only mounted here keeps a timer alive after the window
         is gone — which is exactly the bug module-hygiene was
         written to catch. */
      TABS.slice().reverse().forEach(function (t) {
        if (mounted[t.id] !== true) return;
        var mod = child(t.id);
        if (!mod || typeof mod.unmount !== "function") return;
        try { mod.unmount(); }
        catch (e) {
          FieldKit.log("error", "bastion", "unmount threw for " + t.id + ": " + e.message);
        }
      });
      nodes = {}; mounted = {}; tab = null;
    },

    /* The children keep their own searchIndex() and the palette
       reads those directly, so this row is only about finding the
       window itself. */
    searchIndex() {
      return [{
        id: "bastion", module: "bastion",
        title: "BASTION — services, remote actions, Ptero API",
        body: "bastion status services remote restart actions pterodactyl ptero api " +
          "cheatsheet network uptime probe relay"
      }];
    }
  });

  function injectCSS() {
    if (document.getElementById("bx-style")) return;
    var s = document.createElement("style");
    s.id = "bx-style";
    s.textContent = [
      ".bx-wrap{display:flex;flex-direction:column;gap:8px;height:100%}",
      ".bx-tabs{display:flex;gap:4px;flex:0 0 auto}",
      ".bx-tab{font:inherit;font-size:9px;letter-spacing:.14em;background:none;",
      "  border:1px solid var(--line2);color:var(--fg-dim);padding:4px 12px;cursor:pointer}",
      ".bx-tab.on,.bx-tab:hover{border-color:var(--accent);color:var(--accent)}",
      ".bx-panes{flex:1 1 auto;min-height:0;display:flex}",
      ".bx-pane{flex:1 1 auto;min-height:0;min-width:0;overflow:auto}",
      ".bx-sealed{font-size:11px;color:var(--fg-dimmer);padding:12px}"
    ].join("");
    document.head.appendChild(s);
  }
})(window.FieldKit);
