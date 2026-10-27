/* ============================================================
   FieldKit :: savecode
   Decode, edit, re-encode and compare a game's save codes (§3).

   This was blocked for weeks on "we need a real IRONMARCH save
   code to write the decoder against". That framing was the bug.
   Hardcoding one decoder per game means a new decoder for every
   game, written from a sample nobody has to hand.

   So instead: you describe the format once, as a schema, and the
   decoder comes for free. IRONMARCH, PANTHEON, whatever comes
   next — all the same module. The schema lives in the vault with
   everything else, so a format you worked out at 1am is not lost.

   Codecs cover the shapes people actually ship:
     json        the code IS json
     base64      base64 of json, standard or url-safe
     hex         hex of json
     delimited   fields separated by a character — the classic
                 "v1|100|50|3" that half of these turn out to be

   Nothing here executes what it decodes. A save code is data.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "savecodeschema";

  var CODECS = [
    { id: "json",      label: "RAW JSON",        hint: "the code is json already" },
    { id: "base64",    label: "BASE64 → JSON",   hint: "standard or url-safe" },
    { id: "hex",       label: "HEX → JSON",      hint: "hex-encoded json" },
    { id: "delimited", label: "DELIMITED FIELDS", hint: "v1|100|50|3" }
  ];

  var TYPES = ["string", "number", "boolean", "json"];

  var ctx, ui, el, nodes = {};
  var projects = [];
  var schemas = [];
  var currentSchema = null;
  var decoded = null;

  function svc() { return FieldKit.need("projects"); }

  /* ---- codecs ----------------------------------------------------
     Every decode returns { ok, value, error } rather than throwing,
     because the normal case here is a code that is slightly wrong
     and the useful output is *why*. */
  function b64decode(s) {
    /* URL-safe alphabet and missing padding are both common. */
    s = String(s).trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function b64encode(text, urlSafe) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var out = btoa(bin);
    return urlSafe ? out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : out;
  }

  function hexDecode(s) {
    s = String(s).trim().replace(/\s+/g, "").replace(/^0x/i, "");
    if (s.length % 2) throw new Error("hex has an odd number of digits");
    if (/[^0-9a-f]/i.test(s)) throw new Error("hex contains a non-hex digit");
    var bytes = new Uint8Array(s.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(s.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  }

  function hexEncode(text) {
    var bytes = new TextEncoder().encode(text);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  function coerce(raw, type) {
    if (type === "number") {
      var n = Number(raw);
      if (!isFinite(n)) throw new Error("'" + raw + "' is not a number");
      return n;
    }
    if (type === "boolean") {
      var s = String(raw).trim().toLowerCase();
      if (["1", "true", "yes", "y", "t"].indexOf(s) >= 0) return true;
      if (["0", "false", "no", "n", "f", ""].indexOf(s) >= 0) return false;
      throw new Error("'" + raw + "' is not a true/false value");
    }
    if (type === "json") {
      try { return JSON.parse(raw); }
      catch (e) { throw new Error("'" + String(raw).slice(0, 20) + "' is not valid json"); }
    }
    return String(raw);
  }

  function decode(schema, code) {
    code = String(code == null ? "" : code).trim();
    if (!code) return { ok: false, error: "there is no code to decode" };

    try {
      if (schema.codec === "delimited") {
        var sep = schema.separator || "|";
        var parts = code.split(sep);
        var fields = schema.fields || [];
        if (!fields.length) return { ok: false, error: "this schema has no fields defined" };
        if (parts.length !== fields.length) {
          return { ok: false,
            error: "expected " + fields.length + " field(s) separated by '" + sep +
                   "', found " + parts.length,
            partial: parts };
        }
        var obj = {};
        for (var i = 0; i < fields.length; i++) {
          obj[fields[i].key] = coerce(parts[i], fields[i].type);
        }
        return { ok: true, value: obj, shape: "object" };
      }

      var text = code;
      if (schema.codec === "base64") text = b64decode(code);
      else if (schema.codec === "hex") text = hexDecode(code);

      var parsed;
      try { parsed = JSON.parse(text); }
      catch (e) {
        return { ok: false,
          error: "decoded fine, but the result is not valid json: " + e.message,
          rawText: text.slice(0, 400) };
      }
      return { ok: true, value: parsed, shape: Array.isArray(parsed) ? "array" : typeof parsed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function encode(schema, value) {
    if (schema.codec === "delimited") {
      var sep = schema.separator || "|";
      return (schema.fields || []).map(function (f) {
        var v = value[f.key];
        if (v === undefined || v === null) return "";
        if (f.type === "json") return JSON.stringify(v);
        if (f.type === "boolean") return v ? "1" : "0";
        var s = String(v);
        if (s.indexOf(sep) >= 0) {
          throw new Error("field '" + f.key + "' contains the separator '" + sep + "'");
        }
        return s;
      }).join(sep);
    }
    var text = JSON.stringify(value);
    if (schema.codec === "base64") return b64encode(text, !!schema.urlSafe);
    if (schema.codec === "hex") return hexEncode(text);
    return text;
  }

  /* Flattens whatever came out into rows a table can show, so a
     nested object is inspectable without a tree widget. */
  function rowsOf(value, prefix, out, depth) {
    out = out || [];
    prefix = prefix || "";
    depth = depth || 0;
    if (depth > 6) { out.push({ key: prefix, value: "(too deep)", type: "…" }); return out; }

    if (value === null || typeof value !== "object") {
      out.push({ key: prefix || "(value)", value: String(value), type: typeof value });
      return out;
    }
    if (Array.isArray(value)) {
      if (!value.length) out.push({ key: prefix, value: "(empty array)", type: "array" });
      value.forEach(function (v, i) { rowsOf(v, prefix + "[" + i + "]", out, depth + 1); });
      return out;
    }
    var keys = Object.keys(value);
    if (!keys.length) out.push({ key: prefix, value: "(empty object)", type: "object" });
    keys.forEach(function (k) {
      rowsOf(value[k], prefix ? prefix + "." + k : k, out, depth + 1);
    });
    return out;
  }

  /* ---- schemas --------------------------------------------------- */
  function normalise(d, id) {
    return {
      id: id,
      name: String(d.name || "").trim().slice(0, 60),
      projectId: d.projectId || null,
      codec: CODECS.some(function (c) { return c.id === d.codec; }) ? d.codec : "json",
      separator: String(d.separator || "|").slice(0, 3),
      urlSafe: !!d.urlSafe,
      notes: String(d.notes || "").slice(0, 2000),
      fields: Array.isArray(d.fields) ? d.fields.map(function (f) {
        return {
          key: String(f.key || "").trim().slice(0, 40),
          label: String(f.label || f.key || "").slice(0, 60),
          type: TYPES.indexOf(f.type) >= 0 ? f.type : "string"
        };
      }).filter(function (f) { return f.key; }) : []
    };
  }

  async function loadSchemas() {
    var rows = await ctx.store.list(TYPE);
    schemas = rows.map(function (r) { return normalise(r.data, r.id); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (currentSchema) {
      currentSchema = schemas.filter(function (s) { return s.id === currentSchema.id; })[0] || null;
    }
    if (!currentSchema && schemas.length) currentSchema = schemas[0];
    return schemas;
  }

  async function saveSchema(patch) {
    if (!currentSchema) throw new Error("no schema selected");
    var next = normalise(Object.assign({}, currentSchema, patch), currentSchema.id);
    await ctx.store.put(TYPE, next, { id: currentSchema.id });
    await refresh();
  }

  /* ---- ui -------------------------------------------------------- */
  async function refresh() {
    projects = await svc().all();
    await loadSchemas();
    renderSchemaList();
    renderEditor();
  }

  function renderSchemaList() {
    if (!nodes.schemaSel) return;
    ui.clear(nodes.schemaSel);
    if (!schemas.length) {
      nodes.schemaSel.appendChild(el("option", { value: "", text: "NO FORMATS DEFINED" }));
    }
    schemas.forEach(function (s) {
      var proj = projects.filter(function (p) { return p.id === s.projectId; })[0];
      nodes.schemaSel.appendChild(el("option", {
        value: s.id, text: s.name + (proj ? "  (" + proj.name + ")" : ""),
        selected: currentSchema && s.id === currentSchema.id ? true : null
      }));
    });
  }

  function renderEditor() {
    ui.clear(nodes.editor);
    if (!currentSchema) {
      nodes.editor.appendChild(el("div", { class: "sc-none",
        text: "DEFINE A FORMAT TO START DECODING" }));
      return;
    }
    var s = currentSchema;

    var codecSel = el("select", { class: "fk-input" });
    CODECS.forEach(function (c) {
      codecSel.appendChild(el("option", { value: c.id, text: c.label + " — " + c.hint,
        selected: c.id === s.codec ? true : null }));
    });
    codecSel.addEventListener("change", function () { saveSchema({ codec: codecSel.value }); });

    var projSel = el("select", { class: "fk-input" });
    projSel.appendChild(el("option", { value: "", text: "(no project)" }));
    projects.forEach(function (p) {
      projSel.appendChild(el("option", { value: p.id, text: p.name,
        selected: p.id === s.projectId ? true : null }));
    });
    projSel.addEventListener("change", function () { saveSchema({ projectId: projSel.value || null }); });

    nodes.editor.appendChild(el("div", { class: "sc-grid" }, [
      el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: "ENCODING" }), codecSel
      ]),
      el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: "PROJECT" }), projSel
      ])
    ]));

    if (s.codec === "delimited") {
      var sepIn = el("input", { class: "fk-input", value: s.separator, maxlength: "3" });
      sepIn.addEventListener("change", function () {
        saveSchema({ separator: sepIn.value || "|" });
      });
      nodes.editor.appendChild(el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: "SEPARATOR" }), sepIn
      ]));

      nodes.editor.appendChild(el("div", { class: "sc-fieldhead", text:
        "FIELDS — IN THE ORDER THEY APPEAR IN THE CODE" }));
      var list = el("div", { class: "sc-fields" });
      s.fields.forEach(function (f, i) {
        var typeSel = el("select", { class: "fk-input sc-typesel" });
        TYPES.forEach(function (t) {
          typeSel.appendChild(el("option", { value: t, text: t,
            selected: t === f.type ? true : null }));
        });
        typeSel.addEventListener("change", function () {
          var next = s.fields.slice();
          next[i] = Object.assign({}, f, { type: typeSel.value });
          saveSchema({ fields: next });
        });
        list.appendChild(el("div", { class: "sc-fieldrow" }, [
          el("span", { class: "sc-fieldn", text: String(i + 1) }),
          el("span", { class: "sc-fieldkey", text: f.key }),
          typeSel,
          ui.button("×", function () {
            saveSchema({ fields: s.fields.filter(function (_, j) { return j !== i; }) });
          }, { title: "remove" })
        ]));
      });
      if (!s.fields.length) {
        list.appendChild(el("div", { class: "sc-none", text: "NO FIELDS YET" }));
      }
      nodes.editor.appendChild(list);
      nodes.editor.appendChild(el("div", { class: "sc-actions" }, [
        ui.button("ADD FIELD", function () {
          var key = prompt("Field key (as it should appear in the decoded object):");
          if (key === null) return;
          key = String(key).trim();
          if (!key) return;
          if (s.fields.some(function (f) { return f.key === key; })) {
            ui.toast("THAT FIELD ALREADY EXISTS", "warn");
            return;
          }
          saveSchema({ fields: s.fields.concat([{ key: key, label: key, type: "string" }]) });
        })
      ]));
    } else if (s.codec === "base64") {
      var urlBox = el("input", { type: "checkbox" });
      urlBox.checked = !!s.urlSafe;
      urlBox.addEventListener("change", function () { saveSchema({ urlSafe: urlBox.checked }); });
      nodes.editor.appendChild(el("label", { class: "sc-check" }, [
        urlBox, el("span", { text: "URL-SAFE ALPHABET WHEN ENCODING (- and _ instead of + and /)" })
      ]));
      nodes.editor.appendChild(el("p", { class: "sc-note", text:
        "Decoding accepts either alphabet and missing padding regardless — this only affects " +
        "what gets produced when you encode." }));
    }
  }

  function renderDecoded() {
    ui.clear(nodes.out);
    if (!decoded) {
      nodes.out.appendChild(el("div", { class: "sc-none", text: "NOTHING DECODED YET" }));
      return;
    }
    if (!decoded.ok) {
      nodes.out.appendChild(el("div", { class: "sc-error", text: decoded.error }));
      if (decoded.partial) {
        nodes.out.appendChild(el("div", { class: "sc-note", text:
          "What it split into: " + decoded.partial.map(function (p, i) {
            return "[" + i + "] " + p;
          }).join("   ") }));
      }
      if (decoded.rawText) {
        nodes.out.appendChild(el("pre", { class: "sc-raw", text: decoded.rawText }));
      }
      return;
    }

    var rows = rowsOf(decoded.value);
    nodes.out.appendChild(ui.readout([
      { label: "SHAPE", value: decoded.shape, level: "dim" },
      { label: "FIELDS", value: String(rows.length), level: "ok" }
    ]));
    var table = el("div", { class: "sc-rows" });
    rows.forEach(function (r) {
      table.appendChild(el("div", { class: "sc-row" }, [
        el("span", { class: "sc-rkey", text: r.key }),
        el("span", { class: "sc-rtype", text: r.type }),
        el("span", { class: "sc-rval", text: r.value })
      ]));
    });
    nodes.out.appendChild(table);
  }

  function doDecode() {
    if (!currentSchema) { ui.toast("DEFINE A FORMAT FIRST", "warn"); return; }
    decoded = decode(currentSchema, nodes.codeIn.value);
    renderDecoded();
    if (decoded.ok) ui.toast("DECODED", "ok");
  }

  function doCompare() {
    if (!currentSchema) { ui.toast("DEFINE A FORMAT FIRST", "warn"); return; }
    var a = decode(currentSchema, nodes.codeIn.value);
    var b = decode(currentSchema, nodes.codeIn2.value);
    ui.clear(nodes.out);
    if (!a.ok || !b.ok) {
      nodes.out.appendChild(el("div", { class: "sc-error",
        text: (!a.ok ? "FIRST CODE: " + a.error : "SECOND CODE: " + b.error) }));
      return;
    }
    var diff = FieldKit.need("diff");
    var rows = diff.diffLines(JSON.stringify(a.value, null, 2), JSON.stringify(b.value, null, 2));
    var st = diff.stats(rows);
    nodes.out.appendChild(ui.readout([
      { label: "ADDED", value: String(st.added), level: st.added ? "ok" : "dim" },
      { label: "REMOVED", value: String(st.removed), level: st.removed ? "fail" : "dim" },
      { label: "UNCHANGED", value: String(st.unchanged), level: "dim" }
    ]));
    if (!st.added && !st.removed) {
      nodes.out.appendChild(el("div", { class: "sc-note", text:
        "These two codes mean exactly the same thing, however differently they are spelled." }));
      return;
    }
    var pane = el("div", { class: "sc-diff" });
    var MARK = { add: "+", del: "-", eq: " ", skip: "" };
    diff.collapse(rows, 2).forEach(function (r) {
      pane.appendChild(el("div", { class: "sc-dline sc-" + r.type }, [
        el("span", { class: "sc-dmark", text: MARK[r.type] === undefined ? " " : MARK[r.type] }),
        el("span", { class: "sc-dtext", text: r.text })
      ]));
    });
    nodes.out.appendChild(pane);
  }

  function doEncode() {
    if (!currentSchema) { ui.toast("DEFINE A FORMAT FIRST", "warn"); return; }
    var text = nodes.jsonIn.value.trim();
    if (!text) { ui.toast("NOTHING TO ENCODE", "warn"); return; }
    var value;
    try { value = JSON.parse(text); }
    catch (e) { ui.toast("NOT VALID JSON: " + e.message.toUpperCase(), "fail"); return; }
    try {
      var code = encode(currentSchema, value);
      nodes.codeIn.value = code;
      ui.clear(nodes.out);
      nodes.out.appendChild(ui.readout([
        { label: "ENCODED", value: code.length + " characters", level: "ok" }
      ]));
      nodes.out.appendChild(el("pre", { class: "sc-raw", text: code }));
      ui.toast("ENCODED — ALSO PUT IN THE CODE BOX", "ok");
    } catch (e) {
      ui.toast(e.message.toUpperCase(), "fail");
    }
  }

  async function newSchema() {
    var name = prompt("Format name (e.g. IRONMARCH save v1):");
    if (name === null) return;
    name = String(name).trim();
    if (!name) return;
    var rec = await ctx.store.put(TYPE, normalise({ name: name, codec: "base64" }));
    currentSchema = normalise({ name: name, codec: "base64" }, rec.id);
    await refresh();
    ui.toast("FORMAT CREATED", "ok");
  }

  /* ---- probes ---------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "BASE64 SURVIVES A ROUND TRIP", critical: true, run: async function () {
        var schema = normalise({ name: "t", codec: "base64" });
        var value = { hp: 100, name: "café ✱", flags: [true, false], nested: { a: 1 } };
        var code = encode(schema, value);
        var back = decode(schema, code);
        if (!back.ok) throw new Error("decode failed: " + back.error);
        if (JSON.stringify(back.value) !== JSON.stringify(value)) {
          throw new Error("value changed: " + JSON.stringify(back.value));
        }

        /* Both alphabets and missing padding must decode. */
        var urlSafe = encode(normalise({ name: "t", codec: "base64", urlSafe: true }), value);
        if (/[+/=]/.test(urlSafe)) throw new Error("url-safe output still has +, / or =");
        var back2 = decode(schema, urlSafe);
        if (!back2.ok || JSON.stringify(back2.value) !== JSON.stringify(value)) {
          throw new Error("url-safe form did not decode");
        }
        var unpadded = code.replace(/=+$/, "");
        if (!decode(schema, unpadded).ok) throw new Error("missing padding was not tolerated");
        return "standard, url-safe and unpadded all round trip, multi-byte text intact";
      } },

      { name: "HEX SURVIVES A ROUND TRIP", critical: false, run: async function () {
        var schema = normalise({ name: "t", codec: "hex" });
        var value = { level: 7, seed: "abc" };
        var back = decode(schema, encode(schema, value));
        if (!back.ok || JSON.stringify(back.value) !== JSON.stringify(value)) {
          throw new Error("hex round trip failed");
        }
        if (!decode(schema, "0x" + encode(schema, value)).ok) {
          throw new Error("a 0x prefix was rejected");
        }
        var odd = decode(schema, "abc");
        if (odd.ok || !/odd number/.test(odd.error)) throw new Error("odd-length hex was accepted");
        var bad = decode(schema, "zzzz");
        if (bad.ok || !/non-hex/.test(bad.error)) throw new Error("non-hex digits were accepted");
        return "round trip, 0x prefix, odd length and bad digits all handled";
      } },

      { name: "DELIMITED FIELDS DECODE BY POSITION", critical: true, run: async function () {
        var schema = normalise({
          name: "t", codec: "delimited", separator: "|",
          fields: [
            { key: "version", type: "string" },
            { key: "hp", type: "number" },
            { key: "gold", type: "number" },
            { key: "cleared", type: "boolean" }
          ]
        });
        var back = decode(schema, "v1|100|50|1");
        if (!back.ok) throw new Error("decode failed: " + back.error);
        if (back.value.version !== "v1") throw new Error("version wrong");
        if (back.value.hp !== 100) throw new Error("hp is not a number: " + typeof back.value.hp);
        if (back.value.cleared !== true) throw new Error("boolean not coerced");

        var re = encode(schema, back.value);
        if (re !== "v1|100|50|1") throw new Error("re-encode changed the code: " + re);

        /* The count mismatch is the common real failure and has to
           say what it saw, not just "invalid". */
        var short = decode(schema, "v1|100");
        if (short.ok) throw new Error("a short code was accepted");
        if (!/expected 4/.test(short.error)) throw new Error("unhelpful error: " + short.error);
        if (!short.partial || short.partial.length !== 2) {
          throw new Error("it did not show what it split into");
        }

        var bad = decode(schema, "v1|not-a-number|50|1");
        if (bad.ok) throw new Error("a non-numeric number field was accepted");
        if (bad.error.indexOf("not-a-number") < 0) {
          throw new Error("the error does not name the bad value: " + bad.error);
        }
        return "positional decode, type coercion, and both failure modes named";
      } },

      { name: "A SEPARATOR INSIDE A FIELD IS CAUGHT", critical: true, run: async function () {
        /* Silently producing a code that decodes to something else
           is the worst possible outcome for this module. */
        var schema = normalise({ name: "t", codec: "delimited", separator: "|",
          fields: [{ key: "a", type: "string" }, { key: "b", type: "string" }] });
        var threw = null;
        try { encode(schema, { a: "has|pipe", b: "fine" }); } catch (e) { threw = e.message; }
        if (!threw) throw new Error("a field containing the separator was encoded anyway");
        if (threw.indexOf("a") < 0) throw new Error("the error does not name the field");
        return "refuses to produce a code that would decode to something else";
      } },

      { name: "GARBAGE IS REPORTED, NOT THROWN", critical: true, run: async function () {
        var cases = [
          [normalise({ name: "t", codec: "json" }), "", /no code/],
          [normalise({ name: "t", codec: "json" }), "not json", /not valid json/],
          [normalise({ name: "t", codec: "base64" }), "!!!!not base64!!!!", /./],
          [normalise({ name: "t", codec: "base64" }), b64encodeSafe("still not json"), /not valid json/],
          [normalise({ name: "t", codec: "delimited", fields: [] }), "a|b", /no fields/]
        ];
        for (var i = 0; i < cases.length; i++) {
          var r;
          try { r = decode(cases[i][0], cases[i][1]); }
          catch (e) { throw new Error("case " + i + " threw instead of reporting: " + e.message); }
          if (r.ok) throw new Error("case " + i + " was accepted");
          if (!r.error || !cases[i][2].test(r.error)) {
            throw new Error("case " + i + " gave an unhelpful error: " + r.error);
          }
        }
        return cases.length + " malformed inputs, each reported with a reason";
      } },

      { name: "NESTED DATA FLATTENS FOR DISPLAY", critical: false, run: async function () {
        var rows = rowsOf({ hp: 10, inv: [{ id: "sword" }, { id: "rope" }], meta: { seed: 42 } });
        var keys = rows.map(function (r) { return r.key; });
        ["hp", "inv[0].id", "inv[1].id", "meta.seed"].forEach(function (k) {
          if (keys.indexOf(k) < 0) throw new Error("missing row: " + k + " (got " + keys.join(",") + ")");
        });
        if (rowsOf([]).length !== 1) throw new Error("an empty array produced no row");
        if (rowsOf({}).length !== 1) throw new Error("an empty object produced no row");

        /* Depth guard: a cyclic-looking deep structure must not hang. */
        var deep = { a: {} }, cur = deep.a;
        for (var i = 0; i < 40; i++) { cur.n = {}; cur = cur.n; }
        var out = rowsOf(deep);
        if (!out.some(function (r) { return /too deep/.test(r.value); })) {
          throw new Error("no depth guard fired on a 40-deep object");
        }
        return "nested objects, arrays, empties and a depth guard";
      } },

      { name: "IT NEVER EXECUTES WHAT IT DECODES", critical: true, run: async function () {
        var src = String(decode) + String(encode) + String(coerce) + String(rowsOf);
        if (/\beval\s*\(/.test(src)) throw new Error("eval appears in the decode path");
        if (/new\s+Function/.test(src)) throw new Error("new Function appears in the decode path");
        if (/innerHTML/.test(src)) throw new Error("innerHTML appears in the decode path");

        /* And a payload that looks like code stays a string. */
        var schema = normalise({ name: "t", codec: "json" });
        var r = decode(schema, '{"x":"<script>alert(1)</script>"}');
        if (!r.ok) throw new Error("a legitimate payload was rejected");
        if (typeof r.value.x !== "string") throw new Error("markup did not stay a string");
        var rows = rowsOf(r.value);
        if (rows[0].value.indexOf("<script>") < 0) throw new Error("the value was mangled");
        return "no eval, no Function, no innerHTML — a save code is data";
      } },

      { name: "A SCHEMA ROUND TRIPS THROUGH THE VAULT", critical: false, run: async function () {
        var name = "SELFTEST FORMAT " + Math.random().toString(36).slice(2, 8).toUpperCase();
        var rec = await api.sandbox.put(TYPE, normalise({
          name: name, codec: "delimited", separator: ";",
          fields: [{ key: "a", type: "number" }, { key: "b", type: "boolean" }]
        }));
        var raw = await ctx.store.get(rec.id);
        var back = normalise(raw, rec.id);
        if (back.name !== name) throw new Error("the name did not survive");
        if (back.separator !== ";") throw new Error("the separator did not survive");
        if (back.fields.length !== 2) throw new Error("the fields did not survive");
        if (back.fields[0].type !== "number") throw new Error("a field type did not survive");

        /* And an unknown codec falls back rather than breaking. */
        var weird = normalise({ name: "x", codec: "rot13", fields: [{ key: "" }] });
        if (weird.codec !== "json") throw new Error("an unknown codec was kept");
        if (weird.fields.length !== 0) throw new Error("a keyless field was kept");
        return "schema persisted and read back; unknown values fall back safely";
      } }
    ];
  }

  /* Local helper the probes need without touching module state. */
  function b64encodeSafe(text) { return b64encode(text, false); }

  FieldKit.register("savecode", {
    group: "FILES",
    about: "Decode, edit and compare a game's save codes",
    keywords: "save code decode edit game ironmarch",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "SAVE CODES",
    icon: "⛭",
    width: 780,
    height: 680,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.editor = el("div");
      nodes.out = el("div", { class: "sc-out" });
      nodes.schemaSel = el("select", { class: "fk-input" });
      nodes.schemaSel.addEventListener("change", function () {
        currentSchema = schemas.filter(function (s) { return s.id === nodes.schemaSel.value; })[0] || null;
        decoded = null;
        renderEditor();
        renderDecoded();
      });

      nodes.codeIn = el("textarea", { class: "fk-input sc-code", rows: "3", spellcheck: "false",
        placeholder: "paste a save code here" });
      nodes.codeIn2 = el("textarea", { class: "fk-input sc-code", rows: "3", spellcheck: "false",
        placeholder: "a second code, to compare against the first" });
      nodes.jsonIn = el("textarea", { class: "fk-input sc-code", rows: "4", spellcheck: "false",
        placeholder: '{ "hp": 100, "gold": 50 }' });

      host.appendChild(el("div", { class: "sc-wrap" }, [
        el("div", { class: "sc-toprow" }, [
          el("label", { class: "fk-field sc-schemafield" }, [
            el("span", { class: "fk-field-label", text: "FORMAT" }), nodes.schemaSel
          ]),
          ui.button("NEW FORMAT", newSchema)
        ]),

        ui.panel("FORMAT DEFINITION", [
          el("p", { class: "sc-note", text:
            "Describe the format once and every code in it decodes. That is the whole point — " +
            "a new game needs a new schema, not a new decoder." }),
          nodes.editor
        ]),

        ui.panel("DECODE", [
          nodes.codeIn,
          el("div", { class: "sc-actions" }, [
            ui.button("DECODE", doDecode, { primary: true }),
            ui.button("COPY CODE", function () {
              ui.copy(nodes.codeIn.value, { title: "SAVE CODE" })
                .then(function (how) { if (how) ui.toast("COPIED", "ok"); });
            })
          ])
        ]),

        ui.panel("COMPARE TWO CODES", [
          nodes.codeIn2,
          el("p", { class: "sc-note", text:
            "Decodes both and diffs the results, so you are comparing what the code means " +
            "rather than how it happens to be spelled." }),
          el("div", { class: "sc-actions" }, [ui.button("COMPARE", doCompare)])
        ]),

        ui.panel("ENCODE", [
          nodes.jsonIn,
          el("div", { class: "sc-actions" }, [ui.button("ENCODE", doEncode)])
        ]),

        ui.panel("RESULT", [nodes.out])
      ]));

      await refresh();
      renderDecoded();
    },

    unmount() { nodes = {}; schemas = []; currentSchema = null; decoded = null; projects = []; }
  });

  function injectCSS() {
    if (document.getElementById("sc-style")) return;
    var s = document.createElement("style");
    s.id = "sc-style";
    s.textContent = `
.sc-wrap{height:100%;overflow:auto}
.sc-toprow{display:flex;gap:6px;align-items:flex-end;margin-bottom:10px}
.sc-schemafield{flex:1;margin:0}
.sc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px}
.sc-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:0 0 8px;
  border-left:2px solid var(--line2);padding-left:9px}
.sc-code{width:100%;font-size:10px;line-height:1.5;resize:vertical;word-break:break-all}
.sc-actions{display:flex;gap:6px;margin-top:8px}
.sc-actions .fk-btn{flex:1}
.sc-check{display:flex;gap:8px;align-items:center;margin-top:8px;font-size:10px;
  color:var(--fg-dim);letter-spacing:.06em}
.sc-fieldhead{font-size:9px;letter-spacing:.18em;color:var(--accent-dim);margin:12px 0 5px}
.sc-fields{border:1px solid var(--line2)}
.sc-fieldrow{display:flex;gap:8px;align-items:center;padding:4px 7px;
  border-bottom:1px solid var(--line2)}
.sc-fieldrow:last-child{border-bottom:none}
.sc-fieldn{flex:0 0 18px;color:var(--fg-dimmer);font-size:9px}
.sc-fieldkey{flex:1;font-size:10px;color:var(--fg);letter-spacing:.06em}
.sc-typesel{flex:0 0 92px;padding:3px 5px;font-size:9px}
.sc-fieldrow .fk-btn{padding:1px 7px;font-size:11px;line-height:1}
.sc-out{max-height:300px;overflow:auto}
.sc-error{font-size:10px;color:var(--fail);line-height:1.6;border-left:2px solid var(--fail);
  padding-left:9px}
.sc-raw{background:var(--bg2);border:1px solid var(--line2);padding:8px;font-size:10px;
  line-height:1.5;color:var(--fg-dim);overflow-x:auto;white-space:pre-wrap;word-break:break-all;
  margin:8px 0 0}
.sc-rows{margin-top:8px;border:1px solid var(--line2)}
.sc-row{display:flex;gap:9px;padding:3px 8px;font-size:10px;border-bottom:1px solid var(--line)}
.sc-row:last-child{border-bottom:none}
.sc-rkey{flex:0 0 180px;color:var(--accent-dim);word-break:break-all}
.sc-rtype{flex:0 0 54px;color:var(--fg-dimmer);font-size:9px}
.sc-rval{flex:1;color:var(--fg-dim);word-break:break-all}
.sc-diff{margin-top:8px;border:1px solid var(--line2);font-size:10px;line-height:1.5}
.sc-dline{display:flex;gap:6px;padding:0 6px}
.sc-dmark{flex:0 0 10px;color:var(--fg-dimmer)}
.sc-dtext{flex:1;white-space:pre-wrap;word-break:break-all}
.sc-add{background:rgba(79,191,106,.09)}
.sc-add .sc-dmark{color:var(--pass)}
.sc-del{background:rgba(224,80,60,.09)}
.sc-del .sc-dmark{color:var(--fail)}
.sc-skip{color:var(--fg-dimmer);font-size:9px;letter-spacing:.1em;padding:2px 6px}
.sc-none{padding:12px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
