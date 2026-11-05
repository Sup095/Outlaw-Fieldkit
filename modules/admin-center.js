/* ============================================================
   FieldKit :: ADMIN CENTER
   One page for whoever runs the relay.

   Everything that used to take five panels to find out: is it all
   right, who is waiting, what has it refused, what went wrong. It reads
   GET /admin/overview (relay/admin.js) every 15 seconds while it is
   open and acts through the same routes the other panels use. RUNNER's
   own admin (files, punishments, the line) stays in RUNNER, and the
   button here opens it.

   Admins only: no tile, no search hit and no window for anyone else
   (core/shell.js), and the relay checks again on every request.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, alive;
  var nodes = {};
  var data = null, people = null, problem = null, timer = null;
  var said = "";            /* the announcement being written; it survives a refresh */
  var lensDraft = null;     /* the lens address being typed, likewise */
  var REFRESH_MS = 15000;

  function api(method, path, body) {
    var msg = FieldKit.service("messages");
    if (!msg || !msg.adminApi) throw new Error("this needs MESSAGES");
    return msg.adminApi(method, path, body);
  }

  async function load() {
    var mine = alive;
    try {
      var d = await api("GET", "/admin/overview");
      var p = null;
      try { p = await api("GET", "/msg/people"); } catch (e) { /* the page still works without it */ }
      if (!mine || !mine()) return;
      data = d; people = p; problem = null;
    } catch (e) {
      if (!mine || !mine()) return;
      problem = e.message || String(e);
    }
    render();
  }

  async function act(fn, done) {
    try {
      await fn();
      if (done) ui.toast(done, "ok");
    } catch (e) { ui.toast(e.message || String(e), "fail"); }
    load();
  }

  function ago(ms) {
    if (!ms) return "never";
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return s + " s ago";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }

  function upFor(sec) {
    if (sec < 5400) return Math.round(sec / 60) + " min";
    if (sec < 129600) return Math.round(sec / 3600) + " h";
    return Math.round(sec / 86400) + " days";
  }

  function row(left, right, level) {
    return el("div", { class: "ac-row" + (level ? " " + level : "") }, [
      el("span", { class: "k", text: left }), el("span", { class: "v", text: right })
    ]);
  }

  function box(title, kids, open) {
    return el("div", { class: "ac-box" }, [el("div", { class: "ac-h", text: title })].concat(kids.filter(Boolean)));
  }

  function headline(d) {
    var bad = [];
    if (d.browser && d.browser.enabled && !d.browser.available) bad.push("BROWSER is down");
    if (d.runner && d.runner.enabled && !d.runner.online) bad.push("RUNNER's server is offline");
    if ((d.browser.helpers || []).some(function (h) { return !h.up; })) bad.push("a browser helper is not answering");
    if (d.browser.lens && d.browser.lens.url && !d.browser.lens.usable) bad.push("the lighter browser is not in use");
    if (d.relay.disk && d.relay.disk.freeGb < 2) bad.push("the relay's disk is nearly full");
    if (d.blocking && d.blocking.lists.some(function (l) { return l.why; })) bad.push("a block list did not refresh");
    var line = el("div", { class: "ac-top " + (bad.length ? "warn" : "ok"),
      text: bad.length ? bad.join("  ·  ") : "EVERYTHING IS RUNNING" });
    return line;
  }

  function services(d) {
    var b = d.browser, kids = [];
    kids.push(row("RELAY", "up " + upFor(d.relay.uptimeSec) + "  ·  " + d.relay.memMb + " MB  ·  " + d.relay.node));
    if (d.relay.disk) kids.push(row("ITS DISK", d.relay.disk.freeGb + " GB free of " + d.relay.disk.totalGb, d.relay.disk.freeGb < 2 ? "bad" : ""));
    /* FieldKit's upload ceiling (relay/upcap.js): both machines together
       stay under it, so the house's other servers keep their share. */
    var up = d.upload;
    if (up) {
      var used = (up.relayKbps || 0) + (up.runnerKbps || 0), cap = up.capMbps * 1000;
      kids.push(row("UPLOAD", (used / 1000).toFixed(1) + " of " + up.capMbps + " Mbit/s  ·  relay " + (up.relayKbps / 1000).toFixed(1) +
        ", Bastion 2 by itself " + (up.runnerKbps / 1000).toFixed(1), used >= cap * 0.9 ? "warn" : ""));
    } else {
      kids.push(row("UPLOAD NOW", d.relay.upKbps == null ? "not measured" : (d.relay.upKbps / 1000).toFixed(1) + " Mbit/s"));
    }
    kids.push(row("BROWSER", !b.enabled ? "switched off" : (b.available ? (b.sessions || 0) + " of " + b.maxSessions + " sessions here" +
      (b.render ? "  ·  drawn on the " + (b.render === "gpu" ? "card" : "processor") : "") : "down"), b.enabled && !b.available ? "bad" : ""));
    (b.helpers || []).forEach(function (h) {
      kids.push(row(h.name.toUpperCase() + (h.gpu ? " (CARD)" : ""), h.up ? h.sessions + " sessions, room for " + h.free : "not answering", h.up ? "" : "bad"));
    });
    if (b.enabled) kids = kids.concat(lensRows(b.lens));
    var r = d.runner;
    kids.push(row("RUNNER", !r || !r.enabled ? "switched off" : (r.online ? (r.jobs || 0) + " running, " + (r.sessions || 0) + " connected" : (r.why || "offline")), r && r.enabled && !r.online ? "bad" : ""));
    /* Every address the relay answers on, read from its tunnel
       (relay/addresses.js); panels learn these by themselves. */
    var a = d.addresses;
    if (a) kids.push(row("ADDRESSES", a.list.length
      ? a.list.map(function (x) { return x.replace(/^https?:\/\//, ""); }).join(", ") + (a.error ? "  ·  last read failed: " + a.error : "")
      : (a.error || "none read yet"), a.list.length ? "" : "warn"));
    /* The tiny models kept on the relay (relay/model-shelf.js). */
    var sh = d.shelf;
    if (sh) kids.push(row("MODELS ON THE RELAY", (sh.models.length
      ? sh.models.map(function (x) { return x.id + " (" + x.mb + " MB)"; }).join(", ") : "none yet") +
      (sh.filling ? "  ·  fetching " + sh.filling : "") + (sh.error ? "  ·  " + sh.error : ""), sh.error ? "warn" : ""));
    var u = d.updates;
    if (u) kids.push(row("UPDATES", (u.serving ? "serving " + u.serving : "nothing to serve") + (u.error ? "  ·  " + u.error : ""), u.error ? "warn" : ""));
    kids.push(el("div", { class: "ac-btns" }, [
      ui.button("OPEN RUNNER'S ADMIN", function () { FieldKit.need("shell").open("runner"); }),
      ui.button("DIAGNOSTICS", function () { FieldKit.need("shell").open("selftest-panel"); }),
      ui.button("COPY A REPORT", function () { ui.copy(report(d)); })
    ]));
    return box("SERVICES", kids);
  }

  /* The lighter browser (lens, on the rented server): whether BROWSER
     can use it, how much of the month it has used, and its address,
     which is set here and kept by the relay (POST /admin/lens). */
  function lensRows(l) {
    var kids = [];
    var where = l && l.url ? l.url : "";
    if (!where) kids.push(row("LIGHTER BROWSER", "not set up: everyone gets the streamed one"));
    else kids.push(row("LIGHTER BROWSER", l.usable
      ? "in use  ·  " + Math.round((l.fraction || 0) * 1000) / 10 + "% of the month  ·  " + (l.open || 0) + " connected" + (l.state === "near" ? "  ·  close to the allowance" : "")
      : "not in use: " + (l.why || "unknown") + " (BROWSER uses the streamed one meanwhile)",
      !l.usable ? "warn" : l.state === "near" ? "warn" : ""));
    var addr = el("input", { class: "ac-in", type: "text", placeholder: "its address, such as https://lens.example.com", spellcheck: "false" });
    addr.value = lensDraft === null ? where : lensDraft;
    addr.addEventListener("input", function () { lensDraft = addr.value; });
    kids.push(el("div", { class: "ac-line" }, [addr,
      ui.button("SAVE", function () {
        var u = addr.value.trim();
        lensDraft = null;
        if (u) act(function () { return api("POST", "/admin/lens", { url: u }); }, "LIGHTER BROWSER SET");
      }),
      where ? ui.button("TURN IT OFF", function () {
        if (!window.confirm("Turn the lighter browser off? Everyone will use the streamed one.")) return;
        act(function () { return api("POST", "/admin/lens", { url: "" }); }, "LIGHTER BROWSER OFF");
      }) : null
    ].filter(Boolean)));
    return kids;
  }

  function peopleBox(d) {
    var c = d.people;
    if (!c) return box("PEOPLE", [el("div", { class: "ac-none", text: "Accounts are switched off on this relay." })]);
    var kids = [row("ACCOUNTS", c.total + "  ·  " + c.admins + " admin, " + c.members + " member, " + c.guests + " guest" + (c.banned ? ", " + c.banned + " banned" : ""))];
    if (c.reports) kids.push(row("OPEN REPORTS", String(c.reports), "warn"));
    var list = people && people.people ? people.people.filter(function (p) {
      return p.tier === "guest" && !p.banned;
    }) : [];
    if (c.requireApproval && list.length) {
      kids.push(el("div", { class: "ac-sub", text: "WAITING FOR APPROVAL" }));
      list.slice(0, 20).forEach(function (p) {
        kids.push(el("div", { class: "ac-line" }, [
          el("span", { class: "n", text: p.handle + (p.displayName && p.displayName !== p.handle ? " (" + p.displayName + ")" : "") }),
          ui.button("APPROVE", function () {
            act(function () { return api("POST", "/msg/role", { handle: p.handle, action: "approve" }); }, p.handle + " APPROVED");
          })
        ]));
      });
    }
    /* BROWSER's FULL MODE and RUNNER use the home connection: admins have
       them, and the members allowed here. Everyone else has the lighter mode. */
    var members = people && people.people ? people.people.filter(function (p) { return p.tier === "member" && !p.banned; }) : [];
    if (members.length) {
      kids.push(el("div", { class: "ac-sub", text: "FULL MODE AND RUNNER FOR MEMBERS" }));
      members.slice(0, 40).forEach(function (p) {
        kids.push(el("div", { class: "ac-line" }, [
          el("span", { class: "n", text: p.handle + (p.home ? "  ·  allowed" : "  ·  lighter mode only") }),
          p.home
            ? ui.button("TAKE AWAY", function () {
                act(function () { return api("POST", "/msg/role", { handle: p.handle, action: "deny-home" }); }, p.handle + ": LIGHTER MODE ONLY");
              }, { danger: true })
            : ui.button("ALLOW", function () {
                if (!window.confirm("Let " + p.handle + " use BROWSER's FULL MODE and RUNNER? They run on the home machines and use the home internet.")) return;
                act(function () { return api("POST", "/msg/role", { handle: p.handle, action: "allow-home" }); }, p.handle + ": FULL MODE AND RUNNER ALLOWED");
              })
        ]));
      });
    }
    var s = d.browser.sessionList || [];
    (d.browser.helpers || []).forEach(function (h) {
      (h.who || []).forEach(function (w) { s = s.concat([{ who: w, on: h.name }]); });
    });
    if (s.length) {
      kids.push(el("div", { class: "ac-sub", text: "IN THE BROWSER NOW" }));
      s.slice(0, 24).forEach(function (x) {
        kids.push(el("div", { class: "ac-line" }, [
          el("span", { class: "n", text: String(x.who).replace(/^msg:/, "") + (x.on ? "  ·  " + x.on : "") + (x.idleSec > 60 ? "  ·  idle " + Math.round(x.idleSec / 60) + " min" : "") }),
          ui.button("END", function () {
            if (!window.confirm("End this person's browser session?")) return;
            act(function () { return api("POST", "/admin/session", { who: x.who }); }, "SESSION ENDED");
          }, { danger: true })
        ]));
      });
    }
    kids.push(el("div", { class: "ac-btns" }, [ui.button("OPEN MESSAGES", function () { FieldKit.need("shell").open("messages"); })]));
    return box("PEOPLE", kids);
  }

  function blockingBox(d) {
    var b = d.blocking;
    if (!b) return box("BLOCKING", [el("div", { class: "ac-none", text: "The browser is switched off here." })]);
    var kids = [
      row("REFUSED SINCE IT STARTED", (b.blocked.ads || 0) + " ads  ·  " + (b.blocked.malware || 0) + " malware  ·  " + (b.blocked.adult || 0) + " adult"),
      row("NAMES ON THE LISTS", b.names.toLocaleString())
    ];
    b.lists.forEach(function (l) {
      kids.push(row(l.id, (l.names ? l.names.toLocaleString() + " names, " : "") + "fetched " + ago(l.at) + (l.why ? "  ·  " + l.why : ""), l.why ? "warn" : ""));
    });
    (b.reports || []).slice(0, 12).forEach(function (r) {
      kids.push(el("div", { class: "ac-line" }, [
        el("span", { class: "n", text: r.host + "  ·  reported by " + r.by }),
        ui.button("ALLOW", function () { act(function () { return api("POST", "/admin/block", { op: "allow", host: r.host }); }, r.host + " ALLOWED"); }),
        ui.button("KEEP BLOCKED", function () { act(function () { return api("POST", "/admin/block", { op: "dismiss", host: r.host }); }); })
      ]));
    });
    (b.allowed || []).forEach(function (h) {
      kids.push(el("div", { class: "ac-line" }, [
        el("span", { class: "n", text: h + "  ·  allowed" }),
        ui.button("REMOVE", function () { act(function () { return api("POST", "/admin/block", { op: "unallow", host: h }); }); })
      ]));
    });
    var name = el("input", { class: "ac-in", type: "text", placeholder: "a site to allow, such as example.com", spellcheck: "false" });
    kids.push(el("div", { class: "ac-line" }, [name,
      ui.button("ALLOW", function () {
        var h = name.value.trim();
        if (h) act(function () { return api("POST", "/admin/block", { op: "allow", host: h }); }, h + " ALLOWED");
      }),
      ui.button("FETCH THE LISTS NOW", function () { act(function () { return api("POST", "/admin/block", { op: "refresh" }); }, "FETCHING"); })
    ]));
    if (b.recent && b.recent.length) {
      kids.push(el("div", { class: "ac-sub", text: "LATELY REFUSED (SITES, NOT WHO)" }));
      b.recent.slice(0, 8).forEach(function (r) { kids.push(row(r.cat, r.host + "  ·  " + ago(r.at))); });
    }
    return box("BLOCKING", kids);
  }

  function announceBox(d) {
    var a = d.announcement;
    var text = el("textarea", { class: "ac-in ac-say", rows: "2", placeholder: "Shown to everyone, including people who are not signed in. Nothing private." });
    text.value = said;
    text.addEventListener("input", function () { said = text.value; });
    var hours = el("select", { class: "ac-in" });
    [["1", "1 hour"], ["4", "4 hours"], ["24", "1 day"], ["72", "3 days"], ["168", "1 week"]].forEach(function (o) {
      hours.appendChild(el("option", { value: o[0], text: o[1] }));
    });
    hours.value = "24";
    var level = el("select", { class: "ac-in" });
    [["info", "news"], ["warn", "warning"]].forEach(function (o) { level.appendChild(el("option", { value: o[0], text: o[1] })); });
    return box("TELL EVERYONE", [
      a ? row("SHOWING NOW", a.text + "  ·  until " + new Date(a.until).toLocaleString()) : null,
      a ? el("div", { class: "ac-btns" }, [ui.button("END IT", function () {
        act(function () { return api("POST", "/admin/announce", { end: true }); }, "ENDED");
      })]) : null,
      text,
      el("div", { class: "ac-line" }, [hours, level, ui.button("SHOW TO EVERYONE", function () {
        var t = text.value.trim();
        if (!t) return;
        said = "";
        act(function () { return api("POST", "/admin/announce", { text: t, level: level.value, hours: Number(hours.value) }); }, "IT IS UP");
      })]),
      (d.notices || []).filter(function (n) { return !n.announcement; }).length
        ? el("div", { class: "ac-sub", text: "SHOWN BY ITSELF RIGHT NOW" }) : null
    ].concat((d.notices || []).filter(function (n) { return !n.announcement; }).map(function (n) {
      return row(n.id, n.text, "warn");
    })));
  }

  function eventsBox(d) {
    var e = d.events || [];
    return box("WHAT WENT WRONG LATELY", e.length ? e.slice(0, 15).map(function (x) {
      return el("div", { class: "ac-ev " + (x.level === "ERROR" ? "bad" : "warn") }, [
        el("span", { class: "w", text: ago(x.at) }), el("span", { class: "m", text: x.msg })
      ]);
    }) : [el("div", { class: "ac-none", text: "No warnings or errors since the relay started." })]);
  }

  /* What /probe heard. A service worker is what a faster browser needs. */
  function devicesBox(d) {
    var st = FieldKit.service("settings");
    var base = String((st && st.get("relayUrl")) || "").replace(/\/+$/, "");
    var list = d.devices || [];
    return box("WHAT DEVICES ALLOW", [
      el("div", { class: "ac-none", text: "Open this on a device to find out what it allows: " + base + "/probe" }),
      ui.button("COPY THE ADDRESS", function () { ui.copy(base + "/probe"); })
    ].concat(list.map(function (x) {
      var c = x.checks || {};
      var fine = c.sw && c.swAnswers && c.wasm && c.webSocket;
      return row(x.platform + " " + (x.major || "") + "  ·  " + ago(x.at),
        (fine ? "all that is needed" : "missing: " + ["sw", "swAnswers", "wasm", "webSocket"].filter(function (k) { return !c[k]; }).join(", ")) +
        (c.wasmThreads ? "" : ", no threads") + (c.webgl ? "" : ", no WebGL"), fine ? "" : "warn");
    })));
  }

  /* For pasting into a message when asking for help. */
  function report(d) {
    return [
      "FIELDKIT RELAY  " + new Date(d.at).toISOString(),
      "up " + upFor(d.relay.uptimeSec) + ", " + d.relay.memMb + " MB, node " + d.relay.node,
      "browser: " + (d.browser.available ? "up" : "down") + ", " + (d.browser.sessions || 0) + " sessions, helpers " +
        (d.browser.helpers || []).map(function (h) { return h.name + (h.up ? " up" : " DOWN"); }).join(", "),
      "lens: " + (!d.browser.lens || !d.browser.lens.url ? "not set up" : d.browser.lens.usable ? "in use, " + Math.round((d.browser.lens.fraction || 0) * 100) + "% of the month" : "not in use, " + d.browser.lens.why),
      "runner: " + (d.runner && d.runner.online ? "online" : "offline"),
      "updates: " + (d.updates ? d.updates.serving : "none"),
      "recent:",
    ].concat((d.events || []).slice(0, 10).map(function (x) { return "  " + x.level + " " + x.msg; })).join("\n");
  }

  function render() {
    if (!nodes.root) return;
    /* What is being typed must survive the refresh. A field only: a
       button keeps the focus after a click, and the page would stop. */
    var a = document.activeElement;
    if (data && a && /^(INPUT|TEXTAREA|SELECT)$/.test(String(a.tagName)) && nodes.root.contains(a)) return;
    ui.clear(nodes.root);
    if (problem && !data) {
      nodes.root.appendChild(el("div", { class: "ac-none", text: "Could not ask the relay: " + problem }));
      return;
    }
    if (!data) { nodes.root.appendChild(el("div", { class: "ac-none", text: "ASKING THE RELAY..." })); return; }
    nodes.root.appendChild(headline(data));
    nodes.root.appendChild(el("div", { class: "ac-grid" }, [
      services(data), peopleBox(data), announceBox(data), blockingBox(data), devicesBox(data), eventsBox(data)
    ]));
    if (problem) nodes.root.appendChild(el("div", { class: "ac-none", text: "The last refresh failed: " + problem }));
  }

  function selfcheck() {
    return [
      { name: "IT IS ADMINS ONLY", critical: true, run: async function () {
        if (!FieldKit.module("admin-center").adminOnly) throw new Error("the app is not marked adminOnly");
        return "no tile and no window for anyone else; the relay checks again";
      } }
    ];
  }

  FieldKit.register("admin-center", {
    title: "ADMIN CENTER",
    icon: "⌂",
    group: "SYSTEM",
    about: "Is everything all right: services, people, blocking, announcements",
    keywords: "admin dashboard status overview approve accounts announce banner blocked sites logs errors control",
    width: 900,
    height: 640,
    adminOnly: true,
    guestSafe: false,
    selfcheck: selfcheck,

    mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      alive = FieldKit.mountGuard("admin-center");
      injectCSS();
      data = null; people = null; problem = null;
      nodes.root = el("div", { class: "ac-root" });
      host.appendChild(nodes.root);
      render();
      load();
      timer = setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
    },

    unmount() {
      if (timer) clearInterval(timer);
      timer = null;
      if (alive && alive.end) alive.end();
      nodes = {};
    }
  });

  function injectCSS() {
    if (document.getElementById("ac-style")) return;
    var s = document.createElement("style");
    s.id = "ac-style";
    s.textContent = [
      ".ac-root{display:flex;flex-direction:column;gap:8px;height:100%;overflow-y:auto;padding:2px}",
      ".ac-top{padding:7px 10px;font-size:12px;letter-spacing:.1em;border:1px solid var(--line2)}",
      ".ac-top.ok{color:var(--pass);border-color:var(--pass)}",
      ".ac-top.warn{color:var(--warn);border-color:var(--warn)}",
      ".ac-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:8px;align-items:start}",
      ".ac-box{border:1px solid var(--line2);padding:7px 9px;display:flex;flex-direction:column;gap:3px;min-width:0}",
      ".ac-h{font-size:10px;letter-spacing:.18em;color:var(--accent);margin-bottom:3px}",
      ".ac-sub{font-size:9px;letter-spacing:.16em;color:var(--fg-dimmer);margin-top:6px}",
      ".ac-row{display:flex;gap:10px;font-size:11px;justify-content:space-between}",
      ".ac-row .k{color:var(--fg-dimmer);flex:0 0 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ac-row .v{color:var(--fg);text-align:right;min-width:0;overflow-wrap:anywhere}",
      ".ac-row.bad .v{color:var(--fail)}.ac-row.warn .v{color:var(--warn)}",
      ".ac-line{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px}",
      ".ac-line .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ac-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}",
      ".ac-in{font:inherit;font-size:11px;background:#0c100e;color:var(--fg);border:1px solid var(--line);padding:3px 6px;min-width:0;flex:1}",
      ".ac-say{width:100%;box-sizing:border-box;resize:vertical}",
      ".ac-none{font-size:11px;color:var(--fg-dimmer);padding:4px 0}",
      ".ac-ev{display:flex;gap:8px;font-size:10px}.ac-ev .w{flex:0 0 70px;color:var(--fg-dimmer)}.ac-ev .m{min-width:0;overflow-wrap:anywhere}",
      ".ac-ev.bad .m{color:var(--fail)}.ac-ev.warn .m{color:var(--warn)}"
    ].join("\n");
    document.head.appendChild(s);
  }
})(window.FieldKit);
