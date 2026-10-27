/* ============================================================
   FieldKit :: bastion-cheatsheet
   Pterodactyl API cheat-sheet and request builder (§4).

   The point is that it works when nothing else does: no Tailscale,
   no relay, no network at all. You fill in the fields, it shows you
   the exact curl and fetch equivalents, and you copy one into
   whatever machine can actually reach the panel.

   It deliberately does NOT send the request. That would need your
   API key in this tab, over a network that may not be yours, from a
   school-managed machine. Building the command is the useful part;
   running it is the part that belongs somewhere you trust.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "bastion-endpoint";

  /* Two distinct APIs on a Pterodactyl panel, with different keys and
     different base paths. Mixing them up is the single most common
     way to get a confusing 404, so the UI keeps them visibly apart. */
  var APIS = {
    client: {
      label: "CLIENT API",
      base: "/api/client",
      keyName: "Client API key",
      keyHint: "Account → API Credentials. Starts ptlc_",
      note: "What you get as a normal user. Scoped to servers you can see."
    },
    application: {
      label: "APPLICATION API",
      base: "/api/application",
      keyName: "Application API key",
      keyHint: "Admin → Application API. Starts ptla_",
      note: "Admin-level. Creates users and servers. Treat it like root."
    }
  };

  /* Curated rather than exhaustive: the calls actually reached for
     when something is on fire, plus the ones that are easy to get
     wrong. `path` uses {server} / {id} placeholders. */
  var ENDPOINTS = [
    { api: "client", group: "SERVER", method: "GET", path: "/servers",
      title: "List my servers", desc: "Every server this key can see. Start here for the identifier." },
    { api: "client", group: "SERVER", method: "GET", path: "/servers/{server}",
      title: "Server details", desc: "Limits, allocations, current state." },
    { api: "client", group: "SERVER", method: "GET", path: "/servers/{server}/resources",
      title: "Live resource usage", desc: "CPU, memory, disk, uptime, and the current power state." },
    { api: "client", group: "POWER", method: "POST", path: "/servers/{server}/power",
      title: "Power signal", body: '{\n  "signal": "restart"\n}',
      desc: "signal is one of start · stop · restart · kill. kill does not save anything." },
    { api: "client", group: "CONSOLE", method: "POST", path: "/servers/{server}/command",
      title: "Send a console command", body: '{\n  "command": "say hello"\n}',
      desc: "Same as typing into the console. Fails with 502 if the server is offline." },
    { api: "client", group: "FILES", method: "GET", path: "/servers/{server}/files/list?directory=%2F",
      title: "List files", desc: "directory is URL-encoded. %2F is /." },
    { api: "client", group: "FILES", method: "GET", path: "/servers/{server}/files/contents?file=%2Fconfig.json",
      title: "Read a file", desc: "Returns raw contents, not JSON. Good for checking a config landed." },
    { api: "client", group: "FILES", method: "POST", path: "/servers/{server}/files/write?file=%2Fconfig.json",
      title: "Write a file", body: '{ "port": 25569 }',
      desc: "Body is the raw file content. Content-Type stays application/json for the API itself." },
    { api: "client", group: "FILES", method: "POST", path: "/servers/{server}/files/rename",
      title: "Rename / move", body: '{\n  "root": "/",\n  "files": [{ "from": "old.js", "to": "new.js" }]\n}',
      desc: "Also how you move a file — change the path in \"to\"." },
    { api: "client", group: "BACKUP", method: "GET", path: "/servers/{server}/backups",
      title: "List backups", desc: "Check one exists before you do anything irreversible." },
    { api: "client", group: "BACKUP", method: "POST", path: "/servers/{server}/backups",
      title: "Create a backup", body: '{\n  "name": "pre-change"\n}',
      desc: "Counts against the server's backup limit." },
    { api: "client", group: "NETWORK", method: "GET", path: "/servers/{server}/network/allocations",
      title: "List allocations", desc: "Which ports this server actually has. Confirms the forwarded one." },
    { api: "client", group: "STARTUP", method: "GET", path: "/servers/{server}/startup",
      title: "Startup variables", desc: "The egg variables and the current startup command." },
    { api: "client", group: "STARTUP", method: "PUT", path: "/servers/{server}/startup/variable",
      title: "Set a startup variable", body: '{\n  "key": "MAIN_FILE",\n  "value": "start.js"\n}',
      desc: "Changing this is usually what you want instead of editing the startup command." },
    { api: "application", group: "ADMIN", method: "GET", path: "/servers",
      title: "List all servers", desc: "Admin view. Includes servers your client key cannot see." },
    { api: "application", group: "ADMIN", method: "GET", path: "/nodes",
      title: "List nodes", desc: "Node capacity and allocation counts." },
    { api: "application", group: "ADMIN", method: "GET", path: "/users",
      title: "List users", desc: "Admin only. Returns email addresses — be careful where you paste output." }
  ];

  var ctx, ui, el, nodes = {};
  var selected = ENDPOINTS[0];
  var filter = "";
  var saved = [];

  /* ---- request building ---------------------------------------- */
  function values() {
    return {
      panel: (nodes.panel.value || "").trim().replace(/\/+$/, ""),
      server: (nodes.server.value || "").trim(),
      key: (nodes.key.value || "").trim(),
      body: nodes.body.value
    };
  }

  function resolvedPath(v) {
    return selected.path
      .replace(/\{server\}/g, v.server || "SERVER_ID")
      .replace(/\{id\}/g, v.server || "ID");
  }

  function fullUrl(v) {
    var base = v.panel || "https://panel.example.com";
    return base + APIS[selected.api].base + resolvedPath(v);
  }

  /* The key is never interpolated into what gets displayed or
     copied. A placeholder goes in instead, so a shared screenshot or
     a pasted command cannot leak it. */
  var KEY_PLACEHOLDER = "$PTERO_KEY";

  function buildCurl(v) {
    var L = [];
    L.push("curl -sS -X " + selected.method + " '" + fullUrl(v) + "' \\");
    L.push("  -H 'Authorization: Bearer " + KEY_PLACEHOLDER + "' \\");
    L.push("  -H 'Accept: application/json' \\");
    if (selected.body) {
      L.push("  -H 'Content-Type: application/json' \\");
      L.push("  -d '" + compact(v.body) + "'");
    } else {
      L[L.length - 1] = L[L.length - 1].replace(/ \\$/, "");
    }
    return L.join("\n");
  }

  function buildFetch(v) {
    var L = [];
    L.push("await fetch(" + JSON.stringify(fullUrl(v)) + ", {");
    L.push("  method: " + JSON.stringify(selected.method) + ",");
    L.push("  headers: {");
    L.push("    Authorization: `Bearer ${process.env.PTERO_KEY}`,");
    L.push("    Accept: \"application/json\"" + (selected.body ? "," : ""));
    if (selected.body) L.push("    \"Content-Type\": \"application/json\"");
    L.push("  }" + (selected.body ? "," : ""));
    if (selected.body) L.push("  body: JSON.stringify(" + compact(v.body) + ")");
    L.push("});");
    return L.join("\n");
  }

  function compact(s) {
    try { return JSON.stringify(JSON.parse(s)); }
    catch (e) { return String(s || "").replace(/\s+/g, " ").trim(); }
  }

  function bodyIsValid(v) {
    if (!selected.body) return true;
    if (!v.body.trim()) return false;
    try { JSON.parse(v.body); return true; } catch (e) { return false; }
  }

  /* ---- render --------------------------------------------------- */
  function renderList() {
    ui.clear(nodes.list);
    var f = filter.toLowerCase();
    var shown = ENDPOINTS.filter(function (e) {
      if (!f) return true;
      return (e.title + " " + e.path + " " + e.method + " " + e.group + " " + (e.desc || ""))
        .toLowerCase().indexOf(f) >= 0;
    });

    if (!shown.length) {
      nodes.list.appendChild(el("div", { class: "bc-none", text: "NO MATCHES" }));
      return;
    }

    var lastGroup = null;
    shown.forEach(function (e) {
      var g = APIS[e.api].label + " · " + e.group;
      if (g !== lastGroup) {
        lastGroup = g;
        nodes.list.appendChild(el("div", { class: "bc-group", text: g }));
      }
      nodes.list.appendChild(el("button", {
        class: "bc-item" + (e === selected ? " active" : ""), type: "button",
        onclick: function () { select(e); }
      }, [
        el("span", { class: "bc-method m-" + e.method, text: e.method }),
        el("span", { class: "bc-item-body" }, [
          el("span", { class: "bc-item-title", text: e.title }),
          el("span", { class: "bc-item-path", text: e.path })
        ])
      ]));
    });
  }

  function select(e) {
    selected = e;
    nodes.body.value = e.body || "";
    nodes.bodyField.style.display = e.body ? "flex" : "none";
    renderList();
    renderRequest();
  }

  function renderRequest() {
    var v = values();
    var api = APIS[selected.api];

    ui.clear(nodes.meta);
    nodes.meta.appendChild(ui.readout([
      { label: "API", value: api.label, level: selected.api === "application" ? "warn" : "info" },
      { label: "METHOD", value: selected.method, level: selected.method === "GET" ? "dim" : "warn" },
      { label: "KEY REQUIRED", value: api.keyName, level: "dim" },
      { label: "BODY", value: selected.body ? (bodyIsValid(v) ? "VALID JSON" : "INVALID JSON") : "NONE",
        level: !selected.body ? "dim" : (bodyIsValid(v) ? "ok" : "fail") }
    ]));

    ui.clear(nodes.desc);
    nodes.desc.appendChild(el("div", { class: "bc-desc", text: selected.desc || "" }));
    if (selected.api === "application") {
      nodes.desc.appendChild(el("div", { class: "bc-danger",
        text: "Application key — admin level. Anything here can affect the whole panel." }));
    }
    if (!v.server && /\{server\}/.test(selected.path)) {
      nodes.desc.appendChild(el("div", { class: "bc-warn",
        text: "No server identifier set — the URL below has a placeholder in it." }));
    }

    nodes.url.textContent = fullUrl(v);
    nodes.curl.value = buildCurl(v);
    nodes.fetch.value = buildFetch(v);
  }

  function copy(text, what) {
    ui.copy(text, { title: what })
      .then(function (how) { if (how) ui.toast(what + " COPIED", "ok"); });
  }

  /* ---- saved panels --------------------------------------------- */
  async function loadSaved() {
    try { saved = await ctx.store.list(TYPE); }
    catch (e) { saved = []; }
    renderSaved();
  }

  async function savePanel() {
    var v = values();
    if (!v.panel) { ui.toast("PANEL URL REQUIRED", "warn"); return; }
    var name = prompt("Name this panel:", shortHost(v.panel));
    if (name === null) return;
    /* Panel URL and server id only. The API key is never persisted —
       it is a bearer credential and this is not where it lives. */
    await ctx.store.put(TYPE, {
      name: (name || "").trim() || shortHost(v.panel),
      panel: v.panel,
      server: v.server
    });
    ui.toast("PANEL SAVED (KEY NOT STORED)", "ok");
    await loadSaved();
  }

  function shortHost(u) {
    try { return new URL(u).host; } catch (e) { return String(u || "").slice(0, 24); }
  }

  function renderSaved() {
    ui.clear(nodes.saved);
    if (!saved.length) {
      nodes.saved.appendChild(el("div", { class: "bc-none", text: "NO SAVED PANELS" }));
      return;
    }
    saved.forEach(function (rec) {
      nodes.saved.appendChild(el("div", { class: "bc-saved-item" }, [
        el("button", {
          class: "bc-saved-main", type: "button",
          onclick: function () {
            nodes.panel.value = rec.data.panel || "";
            nodes.server.value = rec.data.server || "";
            renderRequest();
          }
        }, [
          el("span", { class: "bc-saved-name", text: rec.data.name || "(unnamed)" }),
          el("span", { class: "bc-saved-sub",
            text: (rec.data.server ? rec.data.server + " @ " : "") + shortHost(rec.data.panel || "") })
        ]),
        el("button", {
          class: "bc-saved-del", type: "button", text: "×", title: "delete",
          onclick: async function () {
            await ctx.store.remove(rec.id);
            await loadSaved();
            ui.toast("DELETED", "warn");
          }
        })
      ]));
    });
  }

  /* ---- probes --------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "URL COMPOSITION", critical: false, run: async function () {
        nodes.panel.value = "https://panel.example.com/";
        nodes.server.value = "a1b2c3d4";
        select(ENDPOINTS.find(function (e) { return /\{server\}\/resources/.test(e.path); }));
        var got = nodes.url.textContent;
        var want = "https://panel.example.com/api/client/servers/a1b2c3d4/resources";
        if (got !== want) throw new Error("built " + got);
        return "trailing slash stripped, placeholder substituted";
      } },
      /* The one rule this module must never break. */
      { name: "API KEY NEVER APPEARS IN OUTPUT", critical: true, run: async function () {
        var secret = "ptlc_SUPERSECRET" + Math.random().toString(36).slice(2);
        nodes.key.value = secret;
        renderRequest();
        var out = nodes.curl.value + "\n" + nodes.fetch.value + "\n" + nodes.url.textContent;
        if (out.indexOf(secret) >= 0) throw new Error("the key was interpolated into the output");
        if (out.indexOf("$PTERO_KEY") < 0 && out.indexOf("PTERO_KEY") < 0) {
          throw new Error("no key placeholder present — the command would not authenticate");
        }
        nodes.key.value = "";
        renderRequest();
        return "placeholder used, secret never rendered";
      } },
      { name: "BODY VALIDATION", critical: false, run: async function () {
        var withBody = ENDPOINTS.find(function (e) { return e.body; });
        select(withBody);
        if (!/VALID JSON/.test(nodes.meta.textContent)) throw new Error("a valid default body was rejected");
        nodes.body.value = "{ not json";
        renderRequest();
        if (!/INVALID JSON/.test(nodes.meta.textContent)) throw new Error("malformed JSON was not flagged");
        select(withBody);
        return "accepts valid JSON, flags malformed";
      } },
      { name: "CURL AND FETCH AGREE", critical: false, run: async function () {
        nodes.panel.value = "https://panel.example.com";
        nodes.server.value = "srv123";
        select(ENDPOINTS.find(function (e) { return e.method === "POST" && e.body; }));
        var url = nodes.url.textContent;
        if (nodes.curl.value.indexOf(url) < 0) throw new Error("curl does not target the shown URL");
        if (nodes.fetch.value.indexOf(url) < 0) throw new Error("fetch does not target the shown URL");
        if (nodes.curl.value.indexOf("-X POST") < 0) throw new Error("curl is missing the method");
        if (nodes.fetch.value.indexOf('"POST"') < 0) throw new Error("fetch is missing the method");
        return "both target the same URL with the same method";
      } },
      { name: "SAVE / DELETE PANEL", critical: false, run: async function () {
        var marker = "SELFTEST-PANEL-" + Math.random().toString(36).slice(2, 8);
        await ctx.store.put(TYPE, { name: marker, panel: "https://p.example.com", server: "x1" });
        await loadSaved();
        var mine = saved.filter(function (s) { return s.data.name === marker; });
        if (mine.length !== 1) throw new Error("expected 1 saved panel, found " + mine.length);
        api.sandbox.track(mine[0].id);
        if ("key" in mine[0].data) throw new Error("an API key was persisted — it must never be");
        await ctx.store.remove(mine[0].id);
        await loadSaved();
        return "saved without the key, then removed";
      } },
      { name: "ENDPOINT CATALOGUE", critical: false, run: async function () {
        var bad = ENDPOINTS.find(function (e) {
          return !APIS[e.api] || !e.method || !/^\//.test(e.path) || !e.title;
        });
        if (bad) throw new Error("malformed entry: " + JSON.stringify(bad).slice(0, 60));
        filter = "backup";
        renderList();
        var hits = nodes.list.querySelectorAll(".bc-item").length;
        filter = "";
        renderList();
        if (!hits) throw new Error("search found nothing for a known term");
        return ENDPOINTS.length + " endpoints, search returned " + hits + " for 'backup'";
      } }
    ];
  }

  FieldKit.register("bastion-cheatsheet", {
    group: "SERVERS",
    about: "Build Pterodactyl API requests by hand",
    keywords: "pterodactyl api requests",
    /* A tab of BASTION rather than a tile of its own — see
       modules/bastion.js. It is still a whole module: it keeps its
       own selfchecks, its own lifecycle and its own id, and open()
       still reaches it. `inside` only tells the launcher not to
       draw a second icon for something already on screen. */
    inside: "bastion",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "PTERO API",
    icon: "⌥",
    width: 940,
    height: 640,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.search = el("input", { class: "fk-input bc-search", placeholder: "SEARCH ENDPOINTS",
        oninput: function (e) { filter = e.target.value; renderList(); } });
      nodes.list = el("div", { class: "bc-list" });
      nodes.saved = el("div", { class: "bc-saved" });

      nodes.panel = el("input", { class: "fk-input", spellcheck: "false", autocomplete: "off",
        placeholder: "https://panel.example.com", oninput: renderRequest });
      nodes.server = el("input", { class: "fk-input", spellcheck: "false", autocomplete: "off",
        placeholder: "a1b2c3d4", oninput: renderRequest });
      nodes.key = el("input", { class: "fk-input", type: "password", autocomplete: "off",
        placeholder: "kept in this field only", oninput: renderRequest });

      nodes.body = el("textarea", { class: "fk-input bc-body", spellcheck: "false",
        oninput: renderRequest });
      nodes.bodyField = el("label", { class: "fk-field bc-bodyfield" }, [
        el("span", { class: "fk-field-label", text: "REQUEST BODY (JSON)" }), nodes.body
      ]);

      nodes.meta = el("div");
      nodes.desc = el("div");
      nodes.url = el("div", { class: "bc-url" });
      nodes.curl = el("textarea", { class: "fk-input bc-out", readonly: true, spellcheck: "false" });
      nodes.fetch = el("textarea", { class: "fk-input bc-out", readonly: true, spellcheck: "false" });

      host.appendChild(el("div", { class: "bc-wrap" }, [
        el("div", { class: "bc-side" }, [
          nodes.search, nodes.list,
          el("div", { class: "fk-panel bc-savedpanel" }, [
            el("div", { class: "fk-panel-title", text: "SAVED PANELS" }), nodes.saved
          ])
        ]),
        el("div", { class: "bc-main" }, [
          el("div", { class: "bc-row" }, [
            el("label", { class: "fk-field bc-f2" }, [
              el("span", { class: "fk-field-label", text: "PANEL URL" }), nodes.panel
            ]),
            el("label", { class: "fk-field bc-f1" }, [
              el("span", { class: "fk-field-label", text: "SERVER ID" }), nodes.server
            ]),
            el("label", { class: "fk-field bc-f1" }, [
              el("span", { class: "fk-field-label", text: "API KEY (NOT SAVED)" }), nodes.key
            ])
          ]),
          nodes.meta,
          nodes.desc,
          el("div", { class: "bc-urlrow" }, [
            nodes.url,
            ui.button("COPY URL", function () { copy(nodes.url.textContent, "URL"); })
          ]),
          nodes.bodyField,
          el("label", { class: "fk-field bc-outfield" }, [
            el("span", { class: "fk-field-label", text: "CURL" }), nodes.curl
          ]),
          el("label", { class: "fk-field bc-outfield" }, [
            el("span", { class: "fk-field-label", text: "FETCH" }), nodes.fetch
          ]),
          el("div", { class: "bc-actions" }, [
            ui.button("COPY CURL", function () { copy(nodes.curl.value, "CURL"); }, { primary: true }),
            ui.button("COPY FETCH", function () { copy(nodes.fetch.value, "FETCH"); }),
            ui.button("SAVE PANEL", savePanel)
          ]),
          el("p", { class: "bc-footnote", text:
            "This never sends the request. The key stays in the field above and is replaced by a " +
            "placeholder in everything you copy, so a pasted command cannot leak it — set PTERO_KEY " +
            "in the shell that actually runs it." })
        ])
      ]));

      select(selected);
      renderList();
      await loadSaved();
    },

    unmount() { nodes = {}; saved = []; filter = ""; selected = ENDPOINTS[0]; },

    searchIndex() {
      return ENDPOINTS.map(function (e, i) {
        return {
          id: "ptero-" + i, module: "bastion-cheatsheet",
          title: e.title,
          body: e.method + " " + e.path + " " + e.group + " pterodactyl " + (e.desc || "")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("bc-style")) return;
    var s = document.createElement("style");
    s.id = "bc-style";
    s.textContent = `
.bc-wrap{display:flex;gap:12px;height:100%;min-height:0}
.bc-side{width:290px;flex:none;display:flex;flex-direction:column;gap:7px;min-height:0}
.bc-search{padding:6px 8px;font-size:11px;letter-spacing:.1em;flex:none}
.bc-list{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);min-height:0}
.bc-group{padding:5px 8px;background:#101412;border-bottom:1px solid var(--line);
  color:var(--accent);font-size:8px;letter-spacing:.2em;position:sticky;top:0}
.bc-item{display:flex;align-items:flex-start;gap:7px;width:100%;text-align:left;background:none;
  border:0;border-bottom:1px solid var(--line);padding:6px 8px;cursor:pointer}
.bc-item:hover{background:rgba(var(--accent-glow),.07)}
.bc-item.active{background:rgba(var(--accent-glow),.13);border-left:2px solid var(--accent)}
.bc-method{flex:none;font-size:8px;letter-spacing:.06em;font-weight:700;padding:1px 4px;
  border:1px solid var(--line2);color:var(--fg-dimmer);min-width:34px;text-align:center}
.bc-method.m-GET{color:var(--info);border-color:rgba(74,154,212,.5)}
.bc-method.m-POST{color:var(--pass);border-color:rgba(79,191,106,.5)}
.bc-method.m-PUT{color:var(--warn);border-color:rgba(224,166,60,.5)}
.bc-method.m-DELETE{color:var(--fail);border-color:rgba(224,80,60,.5)}
.bc-item-body{flex:1;min-width:0}
.bc-item-title{display:block;font-size:10px;color:var(--fg);letter-spacing:.06em}
.bc-item.active .bc-item-title{color:var(--accent)}
.bc-item-path{display:block;font-size:9px;color:var(--fg-dimmer);margin-top:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bc-savedpanel{flex:none;margin:0}
.bc-saved{max-height:132px;overflow:auto}
.bc-saved-item{display:flex;border-bottom:1px solid var(--line)}
.bc-saved-item:hover{background:rgba(var(--accent-glow),.07)}
.bc-saved-main{flex:1;text-align:left;background:none;border:0;padding:5px 8px;cursor:pointer;min-width:0}
.bc-saved-name{display:block;font-size:10px;color:var(--fg);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.bc-saved-sub{display:block;font-size:8px;color:var(--fg-dimmer);margin-top:1px}
.bc-saved-del{flex:none;background:none;border:0;border-left:1px solid var(--line);
  color:var(--fg-dimmer);font:inherit;font-size:13px;line-height:1;padding:0 9px;cursor:pointer}
.bc-saved-del:hover{color:var(--fail);background:rgba(224,80,60,.1)}
.bc-none{padding:12px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}

.bc-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto}
.bc-row{display:flex;gap:8px;flex:none}
.bc-f1{flex:1;min-width:0} .bc-f2{flex:2;min-width:0}
.bc-desc{font-size:10px;color:var(--fg-dim);line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
.bc-danger{font-size:10px;color:var(--fail);line-height:1.6;margin:6px 0 0;
  border-left:2px solid var(--fail);padding-left:9px}
.bc-warn{font-size:10px;color:var(--warn);line-height:1.6;margin:6px 0 0;
  border-left:2px solid var(--warn);padding-left:9px}
.bc-urlrow{display:flex;gap:6px;align-items:stretch;margin:10px 0;flex:none}
.bc-url{flex:1;min-width:0;border:1px solid var(--line2);background:#0b0e0c;padding:8px 10px;
  font-size:10px;color:var(--accent);word-break:break-all;user-select:all}
.bc-bodyfield{display:flex;flex-direction:column;flex:none}
.bc-body{min-height:74px;resize:vertical;font-size:11px;line-height:1.5}
.bc-outfield{display:flex;flex-direction:column;flex:none}
.bc-out{min-height:88px;resize:vertical;font-size:10px;line-height:1.55;color:var(--fg-dim);
  white-space:pre;overflow-x:auto}
.bc-actions{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.bc-footnote{font-size:9px;color:var(--fg-dimmer);line-height:1.6;margin:10px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
