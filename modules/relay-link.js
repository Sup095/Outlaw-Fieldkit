/* ============================================================
   FieldKit :: RELAY LINK (§14.43)
   The relay's address, after boot.

   The boot screen asks which address to use (core/relay-choice.js),
   for a few seconds. This is the same list, any time: add an address,
   switch to another, test them all, forget one, and see what the
   relay in use offers from this network: messaging, WebSockets, the
   streamed browser, RUNNER, updates. And a QR code of the address, so
   a friend's drive can be pointed at it without typing.

   Both builds. Nothing here needs the vault: every route it asks is
   public, and the address list is the one the boot chooser keeps.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var results = {};          /* address -> { ok, ms } from TEST */
  var services = null;       /* the last service check of the address in use */
  var busy = false;

  function rc() { return FieldKit.need("relayChoice"); }
  function list() { return rc().known(ctx.settings); }
  function host(u) { try { return new URL(u).host; } catch (e) { return String(u || ""); } }

  async function getJson(url, ms) {
    var ac = typeof AbortController === "function" ? new AbortController() : null;
    var t = setTimeout(function () { if (ac) ac.abort(); }, ms || 8000);
    try {
      var r = await fetch(url, { cache: "no-store", signal: ac ? ac.signal : undefined });
      if (!r.ok) { var e = new Error("answered " + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("no answer in time");
      if (e instanceof TypeError) throw new Error("cannot be reached from this network");
      throw e;
    } finally { clearTimeout(t); }
  }

  async function test(u) {
    var t0 = Date.now();
    var yes = await rc().answers(u, 6000);
    results[u] = { ok: yes, ms: Date.now() - t0 };
    return yes;
  }

  async function testAll() {
    if (busy) return;
    busy = true; render("testing every address…");
    var l = list();
    await Promise.all(l.map(test));
    busy = false;
    var good = l.filter(function (u) { return results[u] && results[u].ok; });
    render(good.length + " of " + l.length + " answer from here" +
      (good.length && !(results[l[0]] && results[l[0]].ok) ? ". The one in use does not: press USE on one that does." : "."));
  }

  function wsCheck(base) {
    return new Promise(function (resolve, reject) {
      if (typeof WebSocket !== "function") return reject(new Error("this browser has no WebSocket"));
      var done = false, ws;
      var t = setTimeout(function () { finish(new Error("no answer in 8 s: this network may block WebSockets")); }, 8000);
      function finish(e, v) { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch (x) {} if (e) reject(e); else resolve(v); }
      try { ws = new WebSocket(base.replace(/^http/i, "ws") + "/ws-check"); } catch (e) { return finish(e); }
      ws.onmessage = function (m) { finish(null, m.data === "fieldkit-ws-ok" ? "get through this network" : "answered oddly"); };
      ws.onerror = function () { finish(new Error("refused: this network blocks them, or the relay is older")); };
    });
  }

  /* What the relay in use offers, each asked separately so one that
     fails says which. */
  async function checkServices() {
    var base = list()[0];
    if (!base || busy) return;
    busy = true;
    services = { base: base, rows: [] };
    render("asking " + host(base) + "…");
    var rows = [
      ["RELAY", async function () {
        var t0 = Date.now();
        var h = await getJson(base + "/health");
        if (!h || !h.up) throw new Error("answered, but not as a FieldKit relay");
        return "answers in " + (Date.now() - t0) + " ms" + (h.vaultProvisioned ? ", vault set up" : "");
      }],
      ["WEBSOCKETS", function () { return wsCheck(base); }],
      ["MESSAGING", async function () {
        var h = await getJson(base + "/health");
        return (h.features || []).length ? "on" : "on (older relay)";
      }],
      ["STREAMED BROWSER", async function () {
        var b = await getJson(base + "/browser/status");
        if (!b.enabled) throw new Error("switched off on this relay");
        return (b.available === false ? "busy" : "available") + ", " + (b.sessions || 0) + " of " + (b.maxSessions || "?") + " in use";
      }],
      ["RUNNER", async function () {
        var r = await getJson(base + "/runner/status");
        if (!r.enabled) throw new Error("not on this relay");
        if (!r.online || r.ready === false) throw new Error(r.why || "the run server is offline");
        return "ready";
      }],
      ["UPDATES", async function () {
        var u;
        try { u = await getJson(base + "/updates/status"); }
        catch (e) { if (e.status === 404) throw new Error("this relay is older than its update copy: rebuild it"); throw e; }
        if (!u.serving) throw new Error((u.github && u.github.error) || "nothing to offer yet");
        return "offers " + u.serving + (u.source === "github" ? ", copied from GitHub" : "");
      }]
    ];
    await Promise.all(rows.map(function (r, i) {
      services.rows[i] = { name: r[0], level: "dim", text: "…" };
      return Promise.resolve().then(r[1]).then(function (v) {
        services.rows[i] = { name: r[0], level: "pass", text: String(v) };
      }, function (e) {
        services.rows[i] = { name: r[0], level: /not on this|switched off/.test(e.message) ? "dim" : "fail", text: e.message };
      });
    }));
    busy = false;
    render();
  }

  function use(u) {
    var l = list();
    rc().save(ctx.settings, l, u);
    services = null;
    render("now using " + host(u) + ". Windows already open keep the old address until FieldKit is reloaded.");
  }

  function add(raw, andUse) {
    var u = rc().clean(raw);
    if (!u) { render("that is not an address: try relay.example.com", true); return; }
    var l = list();
    var cur = l[0] || null;
    rc().save(ctx.settings, l.concat([u]), andUse || !cur ? u : cur);
    if (andUse || !cur) services = null;
    render((andUse || !cur ? "now using " : "saved ") + host(u));
    test(u).then(function () { render(); });
  }

  function forget(u) {
    var l = list();
    var rest = l.filter(function (x) { return x !== u; });
    rc().save(ctx.settings, rest, l[0] === u ? rest[0] || "" : l[0]);
    delete results[u];
    if (l[0] === u) services = null;
    render("forgot " + host(u));
  }

  function qrImg(text) {
    var qr = FieldKit.service("qr");
    if (!qr) return null;
    try {
      var svg = qr.toSVG(qr.encode(text), { scale: 4, quiet: 2 });
      return el("img", { class: "rl-qr", alt: "QR code of " + text,
        src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg) });
    } catch (e) { return null; }
  }

  function render(note, bad) {
    if (!nodes.root) return;
    ui.clear(nodes.root);
    var l = list(), cur = l[0] || null;
    nodes.root.appendChild(el("div", { class: "rl-h", text: "RELAY LINK" }));
    nodes.root.appendChild(el("div", { class: "rl-p", text: cur
      ? "This drive connects to " + host(cur) + ". Messaging, the browser, RUNNER and updates all go through it."
      : "No relay address is set. Add the one you were given to use messaging, the browser and RUNNER." }));

    var input = el("input", { class: "rl-input", type: "text", placeholder: "relay.example.com",
      spellcheck: "false", autocomplete: "off" });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(input.value, true); } });
    nodes.root.appendChild(el("div", { class: "rl-row" }, [input,
      ui.button("ADD AND USE", function () { add(input.value, true); }, { primary: true }),
      ui.button("ADD", function () { add(input.value, false); })]));

    var box = el("div", { class: "rl-list" });
    l.forEach(function (u, i) {
      var r = results[u];
      box.appendChild(el("div", { class: "rl-addr" + (i === 0 ? " in-use" : "") }, [
        el("span", { class: "rl-name", text: host(u) + (i === 0 ? "  (in use)" : "") }),
        el("span", { class: "rl-res " + (r ? (r.ok ? "ok" : "bad") : ""), text: r ? (r.ok ? "answers, " + r.ms + " ms" : "does not answer") : "" }),
        i === 0 ? null : ui.button("USE", function () { use(u); }),
        ui.button("TEST", function () { render("asking " + host(u) + "…"); test(u).then(function () { render(); }); }),
        ui.button("✕", function () { forget(u); }, { title: "forget this address" })
      ].filter(Boolean)));
    });
    if (l.length) nodes.root.appendChild(box);

    if (cur) {
      nodes.root.appendChild(el("div", { class: "rl-row" }, [
        l.length > 1 ? ui.button("TEST ALL", testAll) : null,
        ui.button(services ? "CHECK AGAIN" : "CHECK WHAT IT OFFERS", checkServices),
        ui.button("COPY ADDRESS", function () {
          ui.copy(cur, { title: "relay address" }).then(function (how) { if (how) ui.toast("ADDRESS COPIED", "ok"); });
        }),
        ui.button("RELOAD FIELDKIT", function () { location.reload(); }, { title: "so open windows use the address in use" })
      ].filter(Boolean)));
    }

    if (services && services.base === cur) {
      nodes.root.appendChild(ui.readout(services.rows.map(function (r) {
        return { label: r.name, value: r.text.toUpperCase(), level: r.level };
      })));
    }

    if (cur) {
      var img = qrImg(cur);
      if (img) {
        nodes.root.appendChild(el("div", { class: "rl-share" }, [img,
          el("div", { class: "rl-p", text: "Scan this on a phone to send the address to a friend, " +
            "or read it out: " + host(cur) + ". On their drive it goes in here, or at boot (press C)." })]));
      }
    }

    nodes.root.appendChild(el("div", { class: "rl-note" + (bad ? " bad" : ""), text: note ||
      "If the address in use does not answer at boot, the others are tried in turn." }));
  }

  function selfcheck() {
    return [
      { name: "THE ADDRESS LIST IS THE BOOT CHOOSER'S", critical: true, run: async function () {
        var r = FieldKit.need("relayChoice");
        if (typeof r.save !== "function" || typeof r.known !== "function") throw new Error("relayChoice cannot save or list");
        return "one list, kept in settings (relayUrl, relayUrls)";
      } },
      { name: "A NON-ADDRESS IS REFUSED", critical: false, run: async function () {
        var r = FieldKit.need("relayChoice");
        if (r.clean("not a url at all") || r.clean("ftp://x.example") || r.clean("")) throw new Error("accepted something that is not an http(s) address");
        if (r.clean("relay.example.com") !== "https://relay.example.com") throw new Error("a bare name is not made https");
        return "bare names become https; anything else is refused";
      } }
    ];
  }

  FieldKit.register("relay-link", {
    title: "RELAY LINK",
    icon: "⇄",
    group: "SYSTEM",
    about: "The relay address: add, switch, test, and see what it offers",
    keywords: "relay address link url connect server network share qr",
    width: 620,
    height: 560,
    guestSafe: true,
    selfcheck: selfcheck,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();
      nodes.root = el("div", { class: "rl-root" });
      host.appendChild(nodes.root);
      render();
      if (list().length && typeof fetch === "function") checkServices();
    },

    unmount() { nodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("rl-style")) return;
    var s = document.createElement("style");
    s.id = "rl-style";
    s.textContent = [
      ".rl-root{display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto}",
      ".rl-h{font-size:12px;letter-spacing:.2em;color:var(--accent)}",
      ".rl-p{font-size:10px;color:var(--fg-dim);line-height:1.6}",
      ".rl-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
      ".rl-input{flex:1;min-width:180px;background:transparent;border:1px solid var(--line2);color:var(--fg);",
      "  font:inherit;font-size:12px;padding:5px 7px}",
      ".rl-list{display:flex;flex-direction:column;gap:4px}",
      ".rl-addr{display:flex;gap:8px;align-items:center;border:1px solid var(--line);padding:5px 8px;font-size:11px}",
      ".rl-addr.in-use{border-color:var(--accent)}",
      ".rl-name{flex:1;word-break:break-all;color:var(--fg)}",
      ".rl-addr.in-use .rl-name{color:var(--pass)}",
      ".rl-res{font-size:10px;color:var(--fg-dimmer)}",
      ".rl-res.ok{color:var(--pass)} .rl-res.bad{color:var(--fail)}",
      ".rl-share{display:flex;gap:12px;align-items:center}",
      ".rl-qr{width:132px;height:132px;image-rendering:pixelated;background:#fff;flex:none}",
      ".rl-note{font-size:10px;color:var(--fg-dimmer);line-height:1.5;min-height:1.4em}",
      ".rl-note.bad{color:var(--fail)}"
    ].join("\n");
    document.head.appendChild(s);
  }
})(window.FieldKit);
