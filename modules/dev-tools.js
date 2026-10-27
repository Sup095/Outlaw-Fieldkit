/* ============================================================
   FieldKit :: dev-tools
   Regex tester, JSON formatter, base64 and hex — four tools that
   are individually too small to deserve their own window.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, active = "REGEX";

  /* ---- regex --------------------------------------------------
     A user-supplied pattern can backtrack catastrophically and
     there is no way to interrupt a running regex in JS, so the
     subject length is capped rather than risking a frozen tab. */
  var REGEX_SUBJECT_CAP = 200000;

  function runRegex() {
    var out = nodes.rxOut;
    ui.clear(out);

    var pattern = nodes.rxPattern.value;
    var flags = nodes.rxFlags.value.trim();
    var subject = nodes.rxSubject.value;

    if (!pattern) { out.appendChild(el("div", { class: "dt-dim", text: "no pattern" })); return; }
    if (subject.length > REGEX_SUBJECT_CAP) {
      out.appendChild(el("div", { class: "lvl-fail",
        text: "subject over " + REGEX_SUBJECT_CAP + " chars — refusing to run, a bad pattern would hang the tab" }));
      return;
    }

    var re;
    try {
      re = new RegExp(pattern, flags.indexOf("g") >= 0 ? flags : flags + "g");
    } catch (e) {
      out.appendChild(el("div", { class: "lvl-fail", text: "INVALID: " + e.message }));
      return;
    }

    var matches = [], m, guard = 0;
    while ((m = re.exec(subject)) !== null) {
      matches.push({ text: m[0], index: m.index, groups: m.slice(1), named: m.groups || null });
      if (m[0] === "") re.lastIndex++;          // zero-length match, step forward
      if (++guard > 5000) break;
    }

    out.appendChild(ui.readout([
      { label: "MATCHES", value: matches.length + (guard > 5000 ? " (capped)" : ""),
        level: matches.length ? "pass" : "dim" }
    ]));

    if (matches.length) {
      /* Highlighted subject, built as nodes so the subject text
         can never be interpreted as markup. */
      var hl = el("div", { class: "dt-highlight" });
      var cursor = 0;
      matches.forEach(function (mm) {
        if (mm.index > cursor) hl.appendChild(document.createTextNode(subject.slice(cursor, mm.index)));
        hl.appendChild(el("mark", { class: "dt-mark", text: mm.text }));
        cursor = mm.index + mm.text.length;
      });
      if (cursor < subject.length) hl.appendChild(document.createTextNode(subject.slice(cursor)));
      out.appendChild(hl);

      var list = el("div", { class: "dt-matchlist" });
      matches.slice(0, 40).forEach(function (mm, i) {
        var parts = ["#" + i + "  @" + mm.index + "  " + JSON.stringify(mm.text)];
        if (mm.groups.length) parts.push("groups: " + JSON.stringify(mm.groups));
        if (mm.named) parts.push("named: " + JSON.stringify(mm.named));
        list.appendChild(el("div", { class: "dt-matchrow", text: parts.join("   ") }));
      });
      if (matches.length > 40) {
        list.appendChild(el("div", { class: "dt-dim", text: "...and " + (matches.length - 40) + " more" }));
      }
      out.appendChild(list);
    }
  }

  /* ---- json --------------------------------------------------- */
  function jsonAction(mode) {
    var out = nodes.jsonOut;
    ui.clear(out);
    var raw = nodes.jsonIn.value.trim();
    if (!raw) { out.appendChild(el("div", { class: "dt-dim", text: "nothing to parse" })); return; }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      /* Point at the failure — JSON.parse gives a character offset
         in most engines, which is far more useful as line:col. */
      var pos = /position (\d+)/.exec(e.message);
      var where = "";
      if (pos) {
        var upto = raw.slice(0, Number(pos[1]));
        var line = upto.split("\n").length;
        var col = upto.length - upto.lastIndexOf("\n");
        where = "  (line " + line + ", column " + col + ")";
      }
      out.appendChild(el("div", { class: "lvl-fail", text: "INVALID: " + e.message + where }));
      return;
    }

    var text = mode === "min" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
    nodes.jsonIn.value = text;

    function measure(v) {
      var counts = { objects: 0, arrays: 0, values: 0, depth: 0 };
      (function walk(x, d) {
        counts.depth = Math.max(counts.depth, d);
        if (Array.isArray(x)) { counts.arrays++; x.forEach(function (i) { walk(i, d + 1); }); }
        else if (x && typeof x === "object") {
          counts.objects++;
          Object.keys(x).forEach(function (k) { walk(x[k], d + 1); });
        } else counts.values++;
      })(v, 0);
      return counts;
    }
    var c = measure(parsed);
    out.appendChild(ui.readout([
      { label: "VALID", value: "YES", level: "pass" },
      { label: "SIZE", value: text.length + " chars", level: "dim" },
      { label: "OBJECTS / ARRAYS", value: c.objects + " / " + c.arrays, level: "dim" },
      { label: "SCALARS", value: c.values, level: "dim" },
      { label: "MAX DEPTH", value: c.depth, level: c.depth > 12 ? "warn" : "dim" }
    ]));
  }

  /* ---- base64 / hex ------------------------------------------- */
  function b64Encode(s) {
    return btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(s))));
  }
  function b64Decode(s) {
    var bin = atob(s.replace(/\s+/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function hexEncode(s) {
    return Array.from(new TextEncoder().encode(s))
      .map(function (b) { return b.toString(16).padStart(2, "0"); }).join(" ");
  }
  function hexDecode(s) {
    var clean = s.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
    if (clean.length % 2) throw new Error("odd number of hex digits");
    var bytes = new Uint8Array(clean.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  }

  function codec(kind, dir) {
    var inp = kind === "b64" ? nodes.b64In : nodes.hexIn;
    var out = kind === "b64" ? nodes.b64Out : nodes.hexOut;
    ui.clear(out);
    try {
      var fn = kind === "b64" ? (dir === "enc" ? b64Encode : b64Decode)
                              : (dir === "enc" ? hexEncode : hexDecode);
      var result = fn(inp.value);
      out.appendChild(el("textarea", { class: "fk-input dt-result", readonly: true, rows: "6", value: result }));
      out.appendChild(el("div", { class: "dt-actions" }, [
        ui.button("COPY", function () {
          ui.copy(result, { title: "RESULT" })
            .then(function (how) { if (how) ui.toast("COPIED", "ok"); });
        }),
        ui.button("USE AS INPUT", function () { inp.value = result; })
      ]));
    } catch (e) {
      out.appendChild(el("div", { class: "lvl-fail", text: "FAILED: " + e.message }));
    }
  }

  /* ---- tabs --------------------------------------------------- */
  var TABS = ["REGEX", "JSON", "BASE64", "HEX"];

  function showTab(name) {
    active = name;
    TABS.forEach(function (t) {
      nodes.panes[t].style.display = t === name ? "flex" : "none";
      nodes.tabs[t].classList.toggle("active", t === name);
    });
  }

  /* Probes run by the FULL SYSTEM EXERCISE while this module is
     mounted. They drive the real controls, so a broken tab shows up
     as a failed check rather than something noticed months later. */
  function selfcheck() {
    return [
      { name: "REGEX ENGINE", critical: false, run: async function () {
        nodes.rxPattern.value = "\\b(\\w+)@(\\w+)\\.com\\b";
        nodes.rxFlags.value = "g";
        nodes.rxSubject.value = "write to ada@example.com or grace@navy.com today";
        runRegex();
        var value = nodes.rxOut.querySelector(".fk-readout-value");
        if (!value) throw new Error("no match readout produced");
        if (value.textContent.trim() !== "2") {
          throw new Error("expected 2 matches, readout says " + value.textContent.trim());
        }
        var marks = nodes.rxOut.querySelectorAll(".dt-mark").length;
        if (marks !== 2) throw new Error("expected 2 highlights, got " + marks);
        return "2 matches found and highlighted";
      } },
      { name: "REGEX REJECTS BAD PATTERN", critical: false, run: async function () {
        nodes.rxPattern.value = "([unclosed";
        nodes.rxSubject.value = "anything";
        runRegex();
        if (!/INVALID/.test(nodes.rxOut.textContent)) {
          throw new Error("an invalid pattern was not reported");
        }
        return "reported rather than thrown";
      } },
      { name: "JSON FORMATTER", critical: false, run: async function () {
        nodes.jsonIn.value = '{"b":2,"a":[1,{"c":3}]}';
        jsonAction("format");
        var out = nodes.jsonOut.textContent;
        if (/INVALID|error/i.test(out)) throw new Error("valid JSON was rejected: " + out.slice(0, 60));
        nodes.jsonIn.value = '{"a": }';
        jsonAction("format");
        if (!/\d+:\d+|invalid|unexpected/i.test(nodes.jsonOut.textContent)) {
          throw new Error("malformed JSON was not reported");
        }
        return "formats valid input, locates the fault in bad input";
      } },
      { name: "BASE64 ROUNDTRIP", critical: false, run: async function () {
        var probe = "FieldKit — ünïcode ✱ probe";
        var enc = b64Encode(probe);
        if (b64Decode(enc) !== probe) throw new Error("roundtrip altered the text");
        if (!/^[A-Za-z0-9+/=]+$/.test(enc)) throw new Error("output is not base64");
        return enc.length + " chars, multi-byte safe";
      } },
      { name: "HEX ROUNDTRIP", critical: false, run: async function () {
        var probe = "FieldKit ✱";
        if (hexDecode(hexEncode(probe)) !== probe) throw new Error("roundtrip altered the text");
        var threw = false;
        try { hexDecode("abc"); } catch (e) { threw = true; }
        if (!threw) throw new Error("an odd number of hex digits was accepted");
        return "roundtrip clean, odd input refused";
      } },
      { name: "TAB SWITCHING", critical: false, run: async function () {
        var names = Object.keys(nodes.panes);
        var was = active;
        names.forEach(function (n) {
          showTab(n);
          if (nodes.panes[n].style.display === "none") throw new Error(n + " pane stayed hidden");
        });
        showTab(was);
        return names.length + " tabs shown and restored to " + was;
      } }
    ];
  }

  FieldKit.register("dev-tools", {
    group: "TOOLS",
    about: "Regex tester, JSON formatter, base64 and hex",
    keywords: "regex json base64 hex format developer",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "DEV TOOLS",
    icon: "⚙",
    width: 700,
    height: 540,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();
      nodes.panes = {}; nodes.tabs = {};

      /* regex pane */
      nodes.rxPattern = el("input", { class: "fk-input", placeholder: "pattern", oninput: runRegex });
      nodes.rxFlags = el("input", { class: "fk-input dt-flags", placeholder: "flags", value: "g", oninput: runRegex });
      nodes.rxSubject = el("textarea", { class: "fk-input dt-area", rows: "6", spellcheck: "false",
        placeholder: "test string", oninput: runRegex });
      nodes.rxOut = el("div", { class: "dt-out" });
      nodes.panes.REGEX = el("div", { class: "dt-pane" }, [
        el("div", { class: "dt-row" }, [nodes.rxPattern, nodes.rxFlags]),
        nodes.rxSubject, nodes.rxOut
      ]);

      /* json pane */
      nodes.jsonIn = el("textarea", { class: "fk-input dt-area", rows: "10", spellcheck: "false",
        placeholder: "paste JSON" });
      nodes.jsonOut = el("div", { class: "dt-out" });
      nodes.panes.JSON = el("div", { class: "dt-pane" }, [
        nodes.jsonIn,
        el("div", { class: "dt-actions" }, [
          ui.button("FORMAT", function () { jsonAction("pretty"); }, { primary: true }),
          ui.button("MINIFY", function () { jsonAction("min"); }),
          ui.button("CLEAR", function () { nodes.jsonIn.value = ""; ui.clear(nodes.jsonOut); })
        ]),
        nodes.jsonOut
      ]);

      /* base64 pane */
      nodes.b64In = el("textarea", { class: "fk-input dt-area", rows: "6", spellcheck: "false", placeholder: "text or base64" });
      nodes.b64Out = el("div", { class: "dt-out" });
      nodes.panes.BASE64 = el("div", { class: "dt-pane" }, [
        nodes.b64In,
        el("div", { class: "dt-actions" }, [
          ui.button("ENCODE", function () { codec("b64", "enc"); }, { primary: true }),
          ui.button("DECODE", function () { codec("b64", "dec"); })
        ]),
        nodes.b64Out
      ]);

      /* hex pane */
      nodes.hexIn = el("textarea", { class: "fk-input dt-area", rows: "6", spellcheck: "false", placeholder: "text or hex bytes" });
      nodes.hexOut = el("div", { class: "dt-out" });
      nodes.panes.HEX = el("div", { class: "dt-pane" }, [
        nodes.hexIn,
        el("div", { class: "dt-actions" }, [
          ui.button("ENCODE", function () { codec("hex", "enc"); }, { primary: true }),
          ui.button("DECODE", function () { codec("hex", "dec"); })
        ]),
        nodes.hexOut
      ]);

      var tabBar = el("div", { class: "dt-tabs" });
      TABS.forEach(function (t) {
        nodes.tabs[t] = el("button", { class: "dt-tab", type: "button", text: t,
          onclick: function () { showTab(t); } });
        tabBar.appendChild(nodes.tabs[t]);
      });

      host.appendChild(el("div", { class: "dt-wrap" },
        [tabBar].concat(TABS.map(function (t) { return nodes.panes[t]; }))));
      showTab(active);
    },

    unmount() { nodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("dt-style")) return;
    var s = document.createElement("style");
    s.id = "dt-style";
    s.textContent = `
.dt-wrap{display:flex;flex-direction:column;height:100%;min-height:0}
.dt-tabs{display:flex;gap:4px;flex:none;margin-bottom:8px}
.dt-tab{background:#11150f;border:1px solid var(--line2);color:var(--fg-dim);
  padding:5px 12px;font:inherit;font-size:10px;letter-spacing:.16em;cursor:pointer}
.dt-tab:hover{color:var(--accent)}
.dt-tab.active{color:var(--accent);border-color:var(--accent);background:rgba(var(--accent-glow),.1)}
.dt-pane{flex:1;display:flex;flex-direction:column;gap:8px;min-height:0}
.dt-row{display:flex;gap:6px;flex:none}
.dt-flags{max-width:90px}
.dt-area{flex:none;resize:vertical;line-height:1.5}
.dt-out{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);padding:9px;min-height:0}
.dt-actions{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.dt-dim{color:var(--fg-dimmer);font-size:11px}
.dt-highlight{margin-top:8px;padding:8px;background:#0b0e0c;border:1px solid var(--line);
  white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.dt-mark{background:rgba(var(--accent-glow),.28);color:var(--accent);padding:0 1px}
.dt-matchlist{margin-top:8px}
.dt-matchrow{font-size:10px;color:var(--fg-dim);padding:2px 0;border-bottom:1px dotted var(--line);
  white-space:pre-wrap;word-break:break-all}
.dt-result{margin-bottom:6px;resize:vertical}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
