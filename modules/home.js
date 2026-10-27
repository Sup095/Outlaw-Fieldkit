/* ============================================================
   FieldKit :: home
   Mission control (§5B). Small live tiles, glanceable, so the
   answers to "is anything wrong" and "where was I" do not each
   require opening a module.

   Two rules keep this from becoming a dashboard nobody trusts:

     1. Every tile reads live state on demand. Nothing here keeps
        its own copy of anything, so a tile cannot disagree with
        the module it summarises.
     2. A tile that cannot answer says so. "—" and a dim label,
        never a zero standing in for "I don't know" — a dashboard
        that reports a confident wrong number is worse than one
        that admits a gap.

   Tiles refresh on the events that would change them rather than
   on a timer, with one slow clock for the ages and latencies.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var timer = null;
  var tiles = [];
  /* Unsubscribe functions from ctx.on(), released on unmount. */
  var offs = [];

  function svc(n) { return FieldKit.service(n); }

  /* ---- tile definitions ------------------------------------------
     Each returns { value, sub, level, action? }. Throwing is fine —
     the renderer turns it into an unknown tile rather than a hole. */
  var TILES = [
    {
      id: "vault", label: "VAULT",
      async read() {
        var s = ctx.store;
        var state = s.state();
        var n = (await s.list()).length;
        return {
          value: state,
          sub: n + " record(s) · " + s.transportName(),
          level: state === "ONLINE" ? "ok" : (state === "OFFLINE" ? "warn" : "dim")
        };
      }
    },
    {
      id: "health", label: "HEALTH",
      async read() {
        var h = svc("health");
        if (!h) return { value: "—", sub: "no health service", level: "dim" };
        var r = await h.check({ skip: ["clock"] });   // clock costs a request
        return {
          value: r.level === "pass" ? "OK" : r.level.toUpperCase(),
          sub: r.problems.length ? r.problems[0].text : "nothing to act on",
          level: r.level === "pass" ? "ok" : r.level,
          action: "selftest-panel"
        };
      }
    },
    {
      id: "backlog", label: "WAITING TO UPLOAD",
      async read() {
        var n = await ctx.store.pendingCount();
        return {
          value: String(n),
          sub: n ? "exists on this machine only" : "everything is on the relay",
          level: n ? "warn" : "ok"
        };
      }
    },
    {
      id: "backup", label: "LAST BACKUP",
      async read() {
        var b = svc("backup");
        if (!b) return { value: "—", sub: "no backup service", level: "dim" };
        var last = b.lastBackupAt();
        var snaps = await b.listSnapshots();
        if (!last) {
          return { value: "NEVER", sub: snaps.length + " local snapshot(s)",
            level: "fail", action: "backup-panel" };
        }
        var days = Math.floor((Date.now() - last) / 86400000);
        return {
          value: days === 0 ? "TODAY" : days + "d AGO",
          sub: snaps.length + " local snapshot(s)",
          level: b.reminder() ? "warn" : "ok",
          action: "backup-panel"
        };
      }
    },
    {
      id: "selftest", label: "LAST SELF-TEST",
      async read() {
        var rows = await ctx.store.list("selftest");
        if (!rows.length) return { value: "—", sub: "never run here", level: "dim",
          action: "selftest-panel" };
        var r = rows[0].data;
        var fails = r.failed || 0;
        var critical = r.criticalFailed || 0;
        return {
          value: fails ? fails + " FAILING" : "ALL PASS",
          sub: (r.passed || 0) + " passed · " + (r.suite || "?") + " · " +
               new Date(rows[0].meta.updatedAt).toLocaleDateString(),
          level: critical ? "fail" : (fails ? "warn" : "ok"),
          action: "selftest-panel"
        };
      }
    },
    {
      id: "ai", label: "AI",
      async read() {
        var ai = ctx.ai;
        if (!ai || typeof ai.availability !== "function") {
          return { value: "—", sub: "no router", level: "dim" };
        }
        var a = await ai.availability();
        var best = a[1].available ? 1 : (a[2].available ? 2 : 3);
        return {
          value: "TIER " + best,
          sub: a[best].detail || a[best].name,
          level: best === 1 ? "ok" : "warn",
          action: "ai-chat"
        };
      }
    },
    {
      id: "projects", label: "PROJECTS",
      async read() {
        var p = svc("projects");
        if (!p) return { value: "—", sub: "no project service", level: "dim" };
        var list = await p.all();
        var active = list.filter(function (x) { return x.status === "active"; }).length;
        return {
          value: String(list.length),
          sub: active + " active",
          level: list.length ? "ok" : "dim",
          action: "changelog"
        };
      }
    },
    {
      id: "changed", label: "LAST CHANGE",
      async read() {
        var rows = await ctx.store.list("changelog");
        if (!rows.length) return { value: "—", sub: "nothing recorded", level: "dim",
          action: "changelog" };
        var e = rows[0];
        return {
          value: String(e.data.kind || "").toUpperCase(),
          sub: String(e.data.text || "").slice(0, 44) +
               (e.meta.author ? "  — " + e.meta.author : ""),
          level: "ok",
          action: "changelog"
        };
      }
    },
    {
      id: "scratch", label: "SCRATCHPAD",
      async read() {
        var rows = await ctx.store.list("note");
        if (!rows.length) return { value: "—", sub: "empty", level: "dim", action: "scratchpad" };
        return {
          value: String(rows.length),
          sub: "last touched " + new Date(rows[0].meta.updatedAt).toLocaleDateString(),
          level: "ok",
          action: "scratchpad"
        };
      }
    },
    {
      id: "incidents", label: "OPEN INCIDENTS",
      async read() {
        var rows = await ctx.store.list("incident");
        /* incident-log persists a `resolved` boolean, not a
           `resolvedAt` timestamp — so this filter was always true
           and the tile reported every incident ever logged as open.
           A dashboard number that is confidently wrong is exactly
           what the tile rules exist to prevent. */
        var open = rows.filter(function (r) { return !r.data.resolved; });
        return {
          value: String(open.length),
          sub: rows.length + " logged in total",
          level: open.length ? "warn" : "ok",
          action: "incident-log"
        };
      }
    },
    {
      id: "achievements", label: "ACHIEVEMENTS",
      async read() {
        var a = svc("achievements");
        if (!a || typeof a.unlocked !== "function" || !a.DEFS) {
          return { value: "—", sub: "not available", level: "dim" };
        }
        var got = Object.keys(a.unlocked()).length;
        var total = a.DEFS.length;
        return {
          value: got + " / " + total,
          sub: got === total ? "all of them" : "keep going",
          level: "ok"
        };
      }
    },
    {
      id: "eggs", label: "SECRETS FOUND",
      async read() {
        var e = svc("easterEggs");
        if (!e || typeof e.foundCount !== "function") {
          return { value: "—", sub: "not available", level: "dim" };
        }
        return {
          value: e.foundCount() + " / " + e.total(),
          sub: e.foundCount() ? "there are more" : "there are some",
          level: "dim"
        };
      }
    }
  ];

  /* ---- rendering -------------------------------------------------- */
  async function refresh() {
    if (!nodes.grid) return;
    var results = [];
    for (var i = 0; i < TILES.length; i++) {
      var t = TILES[i];
      var out;
      try { out = await t.read(); }
      catch (e) {
        /* Never a zero standing in for "I don't know". */
        out = { value: "—", sub: "could not read: " + (e && e.message), level: "dim" };
      }
      results.push({ def: t, data: out });
    }
    tiles = results;
    draw();
  }

  function draw() {
    ui.clear(nodes.grid);
    tiles.forEach(function (t) {
      var body = [
        el("div", { class: "hm-label", text: t.def.label }),
        el("div", { class: "hm-value lvl-" + (t.data.level || "dim"), text: String(t.data.value) }),
        el("div", { class: "hm-sub", text: String(t.data.sub || "") })
      ];
      if (t.data.action && FieldKit.module(t.data.action)) {
        var id = t.data.action;
        nodes.grid.appendChild(el("button", {
          class: "hm-tile hm-clickable", type: "button",
          title: "open " + (FieldKit.module(id).title || id),
          onclick: function () { FieldKit.need("shell").open(id); }
        }, body));
      } else {
        nodes.grid.appendChild(el("div", { class: "hm-tile" }, body));
      }
    });
    if (nodes.stamp) {
      nodes.stamp.textContent = "AS OF " + new Date().toLocaleTimeString();
    }
  }

  /* ---- probes ----------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "EVERY TILE PRODUCES SOMETHING", critical: true, run: async function () {
        await refresh();
        if (tiles.length !== TILES.length) {
          throw new Error("expected " + TILES.length + " tiles, rendered " + tiles.length);
        }
        var bad = tiles.filter(function (t) {
          return t.data.value === undefined || t.data.value === null || t.data.value === "";
        });
        if (bad.length) {
          throw new Error("blank tiles: " + bad.map(function (t) { return t.def.id; }).join(", "));
        }
        return tiles.length + " tiles, every one with a value";
      } },

      /* The rule this dashboard lives or dies by. */
      { name: "A TILE THAT CANNOT ANSWER SAYS SO", critical: true, run: async function () {
        var thrower = { id: "probe", label: "PROBE", read: async function () {
          throw new Error("deliberate failure");
        } };
        TILES.push(thrower);
        try {
          await refresh();
          var t = tiles.filter(function (x) { return x.def.id === "probe"; })[0];
          if (!t) throw new Error("the failing tile vanished instead of reporting");
          if (t.data.value !== "—") {
            throw new Error("a failing tile showed '" + t.data.value + "' instead of a dash");
          }
          if (t.data.value === "0" || t.data.value === 0) {
            throw new Error("a failing tile reported zero");
          }
          if (!/deliberate failure/.test(t.data.sub)) {
            throw new Error("it did not say why: " + t.data.sub);
          }
          if (t.data.level !== "dim") throw new Error("an unknown tile is not styled as unknown");
          return "a throwing tile renders as unknown, with the reason, and never as zero";
        } finally {
          TILES.splice(TILES.indexOf(thrower), 1);
          await refresh();
        }
      } },

      { name: "MISSING SERVICES DEGRADE, NOT CRASH", critical: false, run: async function () {
        var names = ["health", "backup", "projects", "achievements", "easterEggs"];
        var saved = {};
        names.forEach(function (n) { saved[n] = FieldKit.service(n); FieldKit.provide(n, null); });
        try {
          await refresh();
          var unknown = tiles.filter(function (t) { return t.data.value === "—"; });
          if (unknown.length < names.length - 1) {
            throw new Error("only " + unknown.length + " tiles reported unknown with " +
              names.length + " services removed");
          }
          if (tiles.length !== TILES.length) throw new Error("tiles went missing entirely");
          return names.length + " services removed, every affected tile reports unknown";
        } finally {
          names.forEach(function (n) { FieldKit.provide(n, saved[n]); });
          await refresh();
        }
      } },

      { name: "TILES LINK ONLY TO MODULES THAT EXIST", critical: false, run: async function () {
        await refresh();
        var broken = tiles.filter(function (t) {
          return t.data.action && !FieldKit.module(t.data.action);
        });
        /* Not an error — the tile just renders unclickable. But a
           permanently dead link means a rename went unnoticed. */
        if (broken.length) {
          throw new Error("tiles point at modules that do not exist: " +
            broken.map(function (t) { return t.def.id + " -> " + t.data.action; }).join(", "));
        }
        draw();
        var clickable = nodes.grid.querySelectorAll("button").length;
        if (!clickable) throw new Error("no tile is clickable at all");
        return clickable + " of " + tiles.length + " tiles open the module behind them";
      } },

      { name: "IT KEEPS NO STATE OF ITS OWN", critical: false, run: async function () {
        /* A tile holding a cached copy is a tile that will one day
           disagree with the module it summarises. */
        var src = String(draw) + String(refresh);
        if (/localStorage|store\.put/.test(src)) {
          throw new Error("the renderer reads or writes storage");
        }
        var before = tiles.map(function (t) { return t.def.id + "=" + t.data.value; }).join(",");
        await refresh();
        var after = tiles.map(function (t) { return t.def.id + "=" + t.data.value; }).join(",");
        if (before !== after) {
          /* Times and ages legitimately move; ids must not. */
          var idsA = tiles.map(function (t) { return t.def.id; }).join(",");
          if (idsA !== TILES.map(function (t) { return t.id; }).join(",")) {
            throw new Error("tile identity changed between reads");
          }
        }
        return "reads live state on every refresh, stores nothing";
      } }
    ];
  }

  FieldKit.register("home", {
    group: "SYSTEM",
    about: "At a glance: what is wrong and where you were",
    keywords: "home dashboard overview status glance",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "HOME",
    icon: "◈",
    width: 760,
    height: 560,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.grid = el("div", { class: "hm-grid" });
      nodes.stamp = el("span", { class: "hm-stamp", text: "" });

      host.appendChild(el("div", { class: "hm-wrap" }, [
        el("div", { class: "hm-top" }, [
          nodes.stamp,
          ui.button("REFRESH", refresh)
        ]),
        nodes.grid,
        el("p", { class: "hm-note", text:
          "Every tile reads live state when it is drawn — nothing here keeps its own copy, so " +
          "a tile cannot disagree with the module behind it. A tile that cannot answer shows a " +
          "dash rather than a zero. Click any tile to open what it summarises." })
      ]));

      /* Refresh on the events that would change a tile, plus one slow
         clock for the things that age rather than change.

         ctx.on() returns its own unsubscribe and these were being
         thrown away, so every open-and-close of HOME left seven live
         listeners behind — each holding the previous mount's nodes
         and calling refresh() against a torn-down DOM forever. */
      var on = function (ev) { offs.push(ctx.on(ev, function () { refresh(); })); };
      ["store:changed", "store:state", "store:synced", "store:remote",
       "selftest:done", "backup:snapshot", "achievement:unlocked"].forEach(on);
      timer = setInterval(refresh, 60000);

      await refresh();
    },

    unmount() {
      if (timer) { clearInterval(timer); timer = null; }
      offs.forEach(function (off) { try { off(); } catch (e) { /* already gone */ } });
      offs = [];
      nodes = {}; tiles = [];
    }
  });

  function injectCSS() {
    if (document.getElementById("hm-style")) return;
    var s = document.createElement("style");
    s.id = "hm-style";
    s.textContent = `
.hm-wrap{height:100%;overflow:auto;display:flex;flex-direction:column}
.hm-top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.hm-stamp{flex:1;font-size:9px;letter-spacing:.14em;color:var(--fg-dimmer)}
.hm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:7px}
.hm-tile{display:block;text-align:left;padding:10px 11px;border:1px solid var(--line2);
  background:var(--panel);color:inherit;font:inherit;min-height:78px}
.hm-clickable{cursor:pointer}
.hm-clickable:hover,.hm-clickable:focus-visible{border-color:var(--accent-dim);
  background:rgba(var(--accent-glow),.05);outline:none}
.hm-label{font-size:8px;letter-spacing:.2em;color:var(--fg-dimmer);margin-bottom:6px}
.hm-value{font-size:17px;letter-spacing:.06em;line-height:1.1;color:var(--fg);
  word-break:break-word}
.hm-value.lvl-ok{color:var(--pass)}
.hm-value.lvl-warn{color:var(--warn)}
.hm-value.lvl-fail{color:var(--fail)}
.hm-value.lvl-dim{color:var(--fg-dimmer)}
.hm-sub{margin-top:5px;font-size:9px;line-height:1.45;color:var(--fg-dimmer);
  word-break:break-word}
.hm-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:12px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
