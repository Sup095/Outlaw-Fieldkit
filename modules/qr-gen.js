/* ============================================================
   FieldKit :: qr-gen
   QR generator (§6). Point a phone at the screen and get the
   GitHub repo, the hosted build, or a Wi-Fi network without
   anyone typing anything.

   Encoding lives in core/qr.js; this is presentation, presets,
   and export. Saved payloads go through the encrypted store like
   everything else.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "qr-payload";

  /* Payload builders. Each returns the exact string that gets
     encoded — the formats below are what phone cameras act on. */
  var FORMATS = {
    url: {
      label: "URL / LINK",
      fields: [{ key: "url", label: "ADDRESS", placeholder: "https://github.com/you/fieldkit" }],
      build: function (v) {
        var u = (v.url || "").trim();
        if (!u) return "";
        /* A bare host will not open as a link on most phones. */
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
        return u;
      },
      hint: "opens directly in the phone's browser"
    },
    text: {
      label: "PLAIN TEXT",
      fields: [{ key: "text", label: "TEXT", placeholder: "anything at all", multiline: true }],
      build: function (v) { return (v.text || "").trim(); },
      hint: "shown as text, no action taken"
    },
    wifi: {
      label: "WI-FI JOIN",
      fields: [
        { key: "ssid", label: "NETWORK NAME (SSID)", placeholder: "BASTION-AP" },
        { key: "pass", label: "PASSPHRASE", placeholder: "leave blank if open" },
        { key: "type", label: "SECURITY", options: ["WPA", "WEP", "nopass"] },
        { key: "hidden", label: "HIDDEN NETWORK", options: ["false", "true"] }
      ],
      build: function (v) {
        if (!v.ssid) return "";
        var esc = function (s) { return String(s || "").replace(/([\\;,:"])/g, "\\$1"); };
        var type = v.type || "WPA";
        return "WIFI:T:" + type + ";S:" + esc(v.ssid) + ";" +
          (type === "nopass" ? "" : "P:" + esc(v.pass) + ";") +
          (v.hidden === "true" ? "H:true;" : "") + ";";
      },
      hint: "phones offer to join the network on scan"
    },
    contact: {
      label: "CONTACT CARD",
      fields: [
        { key: "name", label: "NAME", placeholder: "Ada Lovelace" },
        { key: "email", label: "EMAIL", placeholder: "you@example.com" },
        { key: "url", label: "SITE", placeholder: "https://example.com" }
      ],
      build: function (v) {
        if (!v.name && !v.email) return "";
        /* Deliberately minimal vCard — every extra field costs modules. */
        return "BEGIN:VCARD\nVERSION:3.0\nFN:" + (v.name || "") +
          (v.email ? "\nEMAIL:" + v.email : "") +
          (v.url ? "\nURL:" + v.url : "") + "\nEND:VCARD";
      },
      hint: "offered as a new contact on scan"
    }
  };

  var ctx, ui, el, qr;
  var nodes = {};
  var format = "url";
  var values = {};
  var current = null;      // last successful encode
  var saved = [];
  var scale = 6;

  /* ---- encode + render ---------------------------------------- */
  function payload() {
    try { return FORMATS[format].build(values) || ""; }
    catch (e) { return ""; }
  }

  function render() {
    var text = payload();
    ui.clear(nodes.canvasWrap);
    current = null;

    if (!text) {
      nodes.canvasWrap.appendChild(el("div", { class: "qg-empty", text: "AWAITING PAYLOAD" }));
      status("STANDBY", "warn", [
        { label: "PAYLOAD", value: "--" },
        { label: "VERSION", value: "--" },
        { label: "MASK", value: "--" },
        { label: "CAPACITY", value: "0 / " + qr.MAX_BYTES + " BYTES" }
      ]);
      setExportEnabled(false);
      return;
    }

    var code;
    try {
      code = qr.encode(text);
    } catch (e) {
      nodes.canvasWrap.appendChild(el("div", { class: "qg-empty qg-err", text: "CANNOT ENCODE" }));
      var over = new TextEncoder().encode(text).length;
      status("OVERFLOW", "fail", [
        { label: "PAYLOAD", value: over + " BYTES", level: "fail" },
        { label: "LIMIT", value: qr.MAX_BYTES + " BYTES" },
        { label: "REASON", value: e.message.toUpperCase().slice(0, 28), level: "fail" },
        { label: "ADVICE", value: "SHORTEN THE PAYLOAD" }
      ]);
      setExportEnabled(false);
      return;
    }

    current = { code: code, text: text };
    nodes.canvasWrap.appendChild(drawCanvas(code));

    var used = code.bytes;
    var cap = qr.VERSIONS[code.version].capacity;
    status("READY", "ok", [
      { label: "PAYLOAD", value: used + " BYTES" },
      { label: "VERSION", value: String(code.version) + "  (" + code.size + "x" + code.size + ")" },
      { label: "MASK", value: "PATTERN " + code.mask },
      { label: "ERROR CORRECTION", value: "LEVEL M  (~15% RECOVERABLE)" },
      { label: "CAPACITY", value: used + " / " + cap + " BYTES",
        level: used > cap * 0.9 ? "warn" : "ok" }
    ]);
    setExportEnabled(true);
  }

  function status(state, level, rows) {
    ui.clear(nodes.status);
    nodes.status.appendChild(ui.statusDot(
      level === "ok" ? "ok" : level === "fail" ? "bad" : "warn", state));
    nodes.status.appendChild(ui.readout(rows));
  }

  function setExportEnabled(on) {
    ["copySvg", "saveSvg", "savePng", "copyText"].forEach(function (k) {
      if (nodes[k]) nodes[k].disabled = !on;
    });
  }

  /* Drawn straight from the module matrix rather than rasterising
     the SVG — no image loading, no canvas tainting, works offline. */
  function drawCanvas(code, forScale) {
    var s = forScale || scale;
    var quiet = 4;
    var dim = (code.size + quiet * 2) * s;
    var cv = el("canvas", { class: "qg-canvas", width: dim, height: dim });
    var g = cv.getContext("2d");
    /* The light background is not optional — scanners need the
       contrast, and a transparent PNG on a dark page will not read. */
    g.fillStyle = "#c2cdc4";
    g.fillRect(0, 0, dim, dim);
    g.fillStyle = "#0a0c0b";
    for (var r = 0; r < code.size; r++) {
      for (var c = 0; c < code.size; c++) {
        if (code.get(r, c)) g.fillRect((c + quiet) * s, (r + quiet) * s, s, s);
      }
    }
    return cv;
  }

  /* ---- export ------------------------------------------------- */
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function slug() {
    return "fieldkit-qr-" + format + "-" +
      new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  }

  function copy(text, what) {
    ui.copy(text, { title: what })
      .then(function (how) { if (how) ui.toast(what + " COPIED", "ok"); });
  }

  function exportSvg(copyInstead) {
    if (!current) return;
    var svg = qr.toSVG(current.code, { scale: 8, quiet: 4 });
    if (copyInstead) copy(svg, "SVG");
    else download(new Blob([svg], { type: "image/svg+xml" }), slug() + ".svg");
  }

  function exportPng() {
    if (!current) return;
    /* Fixed export scale so a printed code stays usable regardless of
       whatever the on-screen preview happens to be set to. */
    var cv = drawCanvas(current.code, 10);
    cv.toBlob(function (blob) {
      if (!blob) { ui.toast("PNG EXPORT FAILED", "fail"); return; }
      download(blob, slug() + ".png");
      ui.toast("PNG EXPORTED", "ok");
    }, "image/png");
  }

  /* ---- saved payloads ----------------------------------------- */
  async function loadSaved() {
    try { saved = await ctx.store.list(TYPE); }
    catch (e) { saved = []; }
    renderSaved();
  }

  async function savePayload() {
    var text = payload();
    if (!text) { ui.toast("NOTHING TO SAVE", "warn"); return; }
    var name = prompt("Name this code:", suggestName());
    if (name === null) return;
    await ctx.store.put(TYPE, {
      name: (name || "").trim() || suggestName(),
      format: format,
      values: JSON.parse(JSON.stringify(values))
    });
    ui.toast("PAYLOAD SAVED", "ok");
    await loadSaved();
  }

  function suggestName() {
    if (format === "url") return (values.url || "link").replace(/^https?:\/\//, "").slice(0, 32);
    if (format === "wifi") return values.ssid || "wifi";
    if (format === "contact") return values.name || "contact";
    return (values.text || "text").slice(0, 32);
  }

  function renderSaved() {
    ui.clear(nodes.saved);
    if (!saved.length) {
      nodes.saved.appendChild(el("div", { class: "qg-none", text: "NO SAVED CODES" }));
      return;
    }
    saved.forEach(function (rec) {
      nodes.saved.appendChild(el("div", { class: "qg-saved-item" }, [
        el("button", {
          class: "qg-saved-main", type: "button",
          onclick: function () {
            format = rec.data.format in FORMATS ? rec.data.format : "url";
            values = JSON.parse(JSON.stringify(rec.data.values || {}));
            nodes.formatSel.value = format;
            renderFields();
            render();
          }
        }, [
          el("span", { class: "qg-saved-name", text: rec.data.name || "(unnamed)" }),
          el("span", { class: "qg-saved-fmt",
            text: (FORMATS[rec.data.format] || {}).label || rec.data.format || "?" })
        ]),
        el("button", {
          class: "qg-saved-del", type: "button", text: "×", title: "delete",
          onclick: async function () {
            await ctx.store.remove(rec.id);
            await loadSaved();
            ui.toast("DELETED", "warn");
          }
        })
      ]));
    });
  }

  /* ---- form --------------------------------------------------- */
  function renderFields() {
    ui.clear(nodes.fields);
    var spec = FORMATS[format];

    spec.fields.forEach(function (f) {
      var input;
      if (f.options) {
        input = el("select", { class: "fk-input qg-select" });
        f.options.forEach(function (o) {
          input.appendChild(el("option", { value: o, text: o.toUpperCase() }));
        });
        input.value = values[f.key] || f.options[0];
        values[f.key] = input.value;
      } else if (f.multiline) {
        input = el("textarea", {
          class: "fk-input qg-textarea", spellcheck: "false",
          placeholder: f.placeholder || ""
        });
        input.value = values[f.key] || "";
      } else {
        input = el("input", {
          class: "fk-input", type: "text",
          placeholder: f.placeholder || "", spellcheck: "false", autocomplete: "off"
        });
        input.value = values[f.key] || "";
      }

      var handler = function (e) { values[f.key] = e.target.value; render(); };
      input.addEventListener("input", handler);
      input.addEventListener("change", handler);

      nodes.fields.appendChild(el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: f.label }), input
      ]));
    });

    nodes.hint.textContent = spec.hint;
  }

  function selfcheck() {
    return [
      { name: "URL ENCODES", critical: false, run: async function () {
        format = "url";
        values = { url: "github.com/example/fieldkit" };
        nodes.formatSel.value = "url";
        renderFields();
        render();
        if (!current) throw new Error("nothing was encoded");
        if (current.text.indexOf("https://") !== 0) throw new Error("bare host was not promoted to https");
        if (!nodes.canvasWrap.querySelector("canvas")) throw new Error("no canvas rendered");
        return "v" + current.code.version + " " + current.code.size + "x" + current.code.size +
          ", " + current.code.bytes + " bytes";
      } },
      { name: "WI-FI PAYLOAD", critical: false, run: async function () {
        format = "wifi";
        values = { ssid: "BASTION-AP", pass: "hunter;2", type: "WPA", hidden: "false" };
        renderFields();
        render();
        if (!current) throw new Error("Wi-Fi payload did not encode");
        if (current.text.indexOf("WIFI:T:WPA;S:BASTION-AP;") !== 0) {
          throw new Error("unexpected Wi-Fi string: " + current.text.slice(0, 40));
        }
        /* A semicolon in the passphrase must be escaped or the
           scanner truncates the credential. */
        if (current.text.indexOf("hunter\\;2") < 0) throw new Error("semicolon in the passphrase was not escaped");
        return "escaped and encoded correctly";
      } },
      { name: "OVERFLOW HANDLED", critical: false, run: async function () {
        format = "text";
        values = { text: "z".repeat(FieldKit.need("qr").MAX_BYTES + 40) };
        renderFields();
        render();
        if (current) throw new Error("an over-capacity payload was encoded anyway");
        if (!/CANNOT ENCODE/.test(nodes.canvasWrap.textContent)) {
          throw new Error("no overflow message shown");
        }
        return "refused with a readable message";
      } },
      { name: "SVG EXPORT", critical: false, run: async function () {
        format = "url";
        values = { url: "https://example.com" };
        renderFields();
        render();
        if (!current) throw new Error("nothing to export");
        var svg = FieldKit.need("qr").toSVG(current.code, { scale: 6 });
        if (svg.indexOf("<svg") !== 0 || svg.indexOf("</svg>") < 0) throw new Error("malformed svg");
        values = {};
        render();
        return Math.round(svg.length / 1024 * 10) / 10 + " KB";
      } }
    ];
  }

  FieldKit.register("qr-gen", {
    group: "TOOLS",
    about: "Make a QR code for a link or a Wi-Fi network",
    keywords: "qr code wifi link phone scan",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "QR FORGE",
    icon: "▚",
    width: 860,
    height: 600,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      qr = FieldKit.need("qr");
      injectCSS();

      nodes.formatSel = el("select", { class: "fk-input qg-select",
        onchange: function (e) { format = e.target.value; renderFields(); render(); } });
      Object.keys(FORMATS).forEach(function (k) {
        nodes.formatSel.appendChild(el("option", { value: k, text: FORMATS[k].label }));
      });
      nodes.formatSel.value = format;

      nodes.fields = el("div", { class: "qg-fields" });
      nodes.hint = el("div", { class: "qg-hint" });
      nodes.canvasWrap = el("div", { class: "qg-preview" });
      nodes.status = el("div", { class: "qg-status" });
      nodes.saved = el("div", { class: "qg-saved" });

      nodes.zoom = el("input", {
        type: "range", min: "3", max: "12", step: "1", value: String(scale),
        class: "qg-range",
        oninput: function (e) { scale = Number(e.target.value); render(); }
      });

      nodes.copyText = ui.button("COPY PAYLOAD", function () { copy(payload(), "PAYLOAD"); });
      nodes.copySvg = ui.button("COPY SVG", function () { exportSvg(true); });
      nodes.saveSvg = ui.button("EXPORT SVG", function () { exportSvg(false); });
      nodes.savePng = ui.button("EXPORT PNG", exportPng);

      host.appendChild(el("div", { class: "qg-wrap" }, [
        el("div", { class: "qg-left" }, [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "PAYLOAD TYPE" }), nodes.formatSel
          ]),
          nodes.fields,
          nodes.hint,
          el("div", { class: "qg-actions" }, [
            ui.button("SAVE PAYLOAD", savePayload, { primary: true }),
            nodes.copyText
          ]),
          el("div", { class: "fk-panel qg-savedpanel" }, [
            el("div", { class: "fk-panel-title", text: "SAVED CODES" }), nodes.saved
          ])
        ]),
        el("div", { class: "qg-right" }, [
          nodes.canvasWrap,
          el("div", { class: "qg-zoomrow" }, [
            el("span", { class: "qg-zoomlabel", text: "SCALE" }), nodes.zoom
          ]),
          nodes.status,
          el("div", { class: "qg-actions" }, [nodes.saveSvg, nodes.savePng, nodes.copySvg])
        ])
      ]));

      renderFields();
      render();
      await loadSaved();
    },

    unmount() {
      nodes = {}; current = null; saved = []; values = {}; format = "url";
    },

    searchIndex() {
      return saved.map(function (rec) {
        return {
          id: rec.id, module: "qr-gen",
          title: rec.data.name || "(unnamed)",
          body: "qr " + (rec.data.format || "") + " " +
            Object.keys(rec.data.values || {}).map(function (k) { return rec.data.values[k]; }).join(" ")
        };
      });
    }
  });

  function injectCSS() {
    if (document.getElementById("qg-style")) return;
    var s = document.createElement("style");
    s.id = "qg-style";
    s.textContent = `
.qg-wrap{display:flex;gap:14px;height:100%;min-height:0}
.qg-left{width:320px;flex:none;display:flex;flex-direction:column;min-height:0;overflow:auto}
.qg-right{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}
.qg-fields{flex:none}
.qg-select{padding:8px 9px}
.qg-textarea{min-height:96px;resize:vertical;line-height:1.5}
.qg-hint{font-size:9px;letter-spacing:.12em;color:var(--fg-dimmer);margin:-4px 0 12px;
  border-left:2px solid var(--line2);padding-left:8px}
.qg-actions{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.qg-actions .fk-btn{flex:1;min-width:104px}
.qg-savedpanel{margin-top:12px;flex:none}
.qg-saved{max-height:170px;overflow:auto}
.qg-saved-item{display:flex;border-bottom:1px solid var(--line)}
.qg-saved-item:hover{background:rgba(var(--accent-glow),.07)}
.qg-saved-main{flex:1;text-align:left;background:none;border:0;padding:6px 9px;cursor:pointer;min-width:0}
.qg-saved-name{display:block;font-size:11px;color:var(--fg);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.qg-saved-fmt{display:block;font-size:8px;letter-spacing:.14em;color:var(--fg-dimmer);margin-top:2px}
.qg-saved-del{flex:none;background:none;border:0;border-left:1px solid var(--line);
  color:var(--fg-dimmer);font:inherit;font-size:14px;line-height:1;padding:0 10px;cursor:pointer}
.qg-saved-del:hover{color:var(--fail);background:rgba(224,80,60,.1)}
.qg-none{padding:12px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}

.qg-preview{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;
  border:1px solid var(--line);background:
    repeating-conic-gradient(#0d100e 0% 25%, #0a0c0b 0% 50%) 50%/16px 16px;
  padding:10px;overflow:auto}
.qg-canvas{image-rendering:pixelated;max-width:100%;max-height:100%;
  box-shadow:0 0 0 1px var(--line2),0 10px 30px rgba(0,0,0,.6)}
.qg-empty{color:var(--fg-dimmer);font-size:10px;letter-spacing:.28em}
.qg-empty.qg-err{color:var(--fail)}
.qg-zoomrow{display:flex;align-items:center;gap:10px;flex:none}
.qg-zoomlabel{font-size:9px;letter-spacing:.2em;color:var(--fg-dim);flex:none}
.qg-range{flex:1;accent-color:var(--accent);background:transparent}
.qg-status{flex:none;border:1px solid var(--line);background:var(--bg2);padding:8px 10px}
.qg-status .fk-status{margin-bottom:6px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
