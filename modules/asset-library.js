/* ============================================================
   FieldKit :: asset-library
   The catalogue for reusable art, sprites and audio. (§3)

   The single most important thing about this module is what it
   does NOT do: it does not store the files.

   §1 decided the drive carries bulk and the relay carries secrets.
   Assets are bulk — a sprite sheet is megabytes, the encrypted
   store is not built for that, and pushing a PNG through envelope
   encryption to a relay is a slow way to fill somebody's disk. So
   the bytes stay in `assets/assets-library/` on the drive, and what
   lives in the vault is the CATALOGUE: where each file is, what it
   is for, who made it, and whether you are allowed to ship it.

   That last one matters more than it sounds. An asset library
   without licence tracking is how a game ends up shipping someone
   else's art, and by then nobody remembers where the file came
   from. Entries with no licence are flagged, permanently, until
   somebody answers the question.

   The catalogue's failure mode is rot: files get moved or renamed
   and the index quietly points at nothing. VERIFY walks every
   entry and reports what no longer resolves — and, crucially,
   distinguishes "this file is gone" from "a file:// page cannot
   check this kind of file". Those are different facts and the
   module never blurs them.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "asset";
  var ROOT = "assets/assets-library/";

  /* What a file:// page can actually load, and therefore verify. */
  var KINDS = {
    image: { label: "IMAGE", exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"],
      verifiable: true },
    audio: { label: "AUDIO", exts: ["wav", "mp3", "ogg", "flac", "m4a", "aac"],
      verifiable: true },
    video: { label: "VIDEO", exts: ["mp4", "webm", "ogv", "mov"], verifiable: true },
    font:  { label: "FONT",  exts: ["ttf", "otf", "woff", "woff2"], verifiable: true },
    /* Everything else — .aseprite, .tmx, .json, .blend, .fbx. These
       are real assets and belong in the catalogue; they simply
       cannot be probed from here, and the module says so rather
       than reporting a confident "missing". */
    data:  { label: "DATA",  exts: [], verifiable: false }
  };

  /* Licences worth distinguishing. The point is not legal advice,
     it is forcing the question to be answered once, at import,
     while the answer is still known. */
  var LICENCES = [
    { id: "", label: "— UNANSWERED —", ship: false },
    { id: "own", label: "MINE — made it myself", ship: true },
    { id: "cc0", label: "CC0 / public domain", ship: true },
    { id: "ccby", label: "CC-BY — attribution required", ship: true, attribution: true },
    { id: "ccbysa", label: "CC-BY-SA — attribution + share-alike", ship: true, attribution: true },
    { id: "bought", label: "PURCHASED — licence on file", ship: true },
    { id: "nc", label: "NON-COMMERCIAL ONLY", ship: true, restricted: true },
    { id: "unknown", label: "UNKNOWN — do not ship", ship: false }
  ];

  var ctx, ui, el, nodes = {};
  var assets = [];
  var projects = [];
  var filter = { text: "", tag: null, kind: null, project: null, problems: false };
  var verdicts = Object.create(null);
  var savePaused = false;

  /* ---- model -------------------------------------------------- */
  function extOf(path) {
    var m = String(path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function kindFor(path) {
    var e = extOf(path);
    var found = "data";
    Object.keys(KINDS).forEach(function (k) {
      if (KINDS[k].exts.indexOf(e) >= 0) found = k;
    });
    return found;
  }

  /* Paths are relative to the drive root and stay that way. An
     absolute path or a `..` escape would point outside the drive,
     which defeats the entire point of a portable catalogue — the
     path has to mean the same thing on both machines. */
  function cleanPath(p) {
    /* Order matters here. The drive letter has to go before the
       split, or `C:` survives as an ordinary segment and stripping
       it afterwards leaves a leading slash behind — an absolute
       path, which is exactly what this function exists to prevent.
       Filtering empty segments then handles leading slashes,
       doubled slashes and `./` in one pass.

       Decoding comes first, because the path is eventually handed
       to the browser as a src, and the browser decodes it. Matching
       a literal ".." while %2e%2e sailed through made the critical
       "paths cannot escape the drive" claim false for exactly the
       input someone would use to break it. decodeURIComponent
       throws on a malformed escape, so it is guarded and the raw
       string is used when it cannot be decoded — a path that is not
       valid encoding is not a traversal either. */
    var s = String(p || "").trim();
    for (var pass = 0; pass < 3; pass++) {
      var before = s;
      try { s = decodeURIComponent(s); } catch (e) { break; }
      if (s === before) break;      // fully decoded
    }
    s = s.replace(/\\/g, "/").replace(/^[a-zA-Z]:/, "");
    s = s.split("/").filter(function (seg) {
      return seg && seg !== "." && seg !== "..";
    }).join("/");
    return s.slice(0, 300);
  }

  function normalise(d, id) {
    d = d || {};
    var path = cleanPath(d.path);
    return {
      id: id,
      path: path,
      name: String(d.name || path.split("/").pop() || "UNNAMED").slice(0, 80),
      kind: KINDS[d.kind] ? d.kind : kindFor(path),
      tags: (Array.isArray(d.tags) ? d.tags : [])
        .map(function (t) { return String(t).toLowerCase().trim().slice(0, 30); })
        .filter(function (t, i, arr) { return t && arr.indexOf(t) === i; })
        .slice(0, 12),
      project: d.project ? String(d.project).slice(0, 60) : null,
      licence: LICENCES.some(function (l) { return l.id === d.licence; }) ? d.licence : "",
      source: String(d.source || "").slice(0, 300),
      note: String(d.note || "").slice(0, 600)
    };
  }

  function licenceFor(id) {
    return LICENCES.filter(function (l) { return l.id === id; })[0] || LICENCES[0];
  }

  function fullPath(a) { return ROOT + a.path; }

  /* ---- the problems worth surfacing ---------------------------- */
  function problems(a) {
    var out = [];
    var lic = licenceFor(a.licence);
    if (!a.licence) {
      out.push({ level: "warn", text:
        "No licence recorded. Answer it now, while you still remember where this came from." });
    } else if (!lic.ship) {
      out.push({ level: "fail", text:
        "Licence is " + lic.label + " — this must not go into a shipped build." });
    } else if (lic.attribution && !String(a.source || "").trim()) {
      out.push({ level: "warn", text:
        "This licence requires attribution but no source is recorded, so there is nothing " +
        "to credit." });
    } else if (lic.restricted) {
      out.push({ level: "warn", text:
        "Non-commercial only. Fine for a jam, not for anything sold." });
    }
    if (!a.path) out.push({ level: "fail", text: "No path — this entry points at nothing." });
    if (!a.tags.length) {
      out.push({ level: "warn", text:
        "No tags. An untagged asset is one you will never find again." });
    }
    var v = verdicts[a.id];
    if (v && v.state === "missing") {
      out.push({ level: "fail", text: "Last verify could not load " + fullPath(a) + "." });
    }
    return out;
  }

  function anyProblem(a) { return problems(a).length > 0; }

  /* ---- verification --------------------------------------------
     Three outcomes, and keeping them distinct is the whole job:

       ok           the browser loaded it, so it is there
       missing      the browser tried and failed
       unverifiable this kind cannot be probed from a file:// page

     Reporting the third as "missing" would send someone hunting
     for a file that is sitting right where it should be. */
  function verifyOne(a) {
    return new Promise(function (resolve) {
      var kind = KINDS[a.kind] || KINDS.data;
      if (!a.path) return resolve({ state: "missing", why: "no path recorded" });
      if (!kind.verifiable) {
        return resolve({ state: "unverifiable", why:
          "a file:// page cannot probe " + kind.label.toLowerCase() + " files" });
      }

      var url = fullPath(a);
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ state: "unverifiable", why: "the load never settled" });
      }, 4000);

      function finish(state, why) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ state: state, why: why });
      }

      try {
        if (a.kind === "image") {
          var img = new Image();
          img.onload = function () {
            finish("ok", img.naturalWidth + "×" + img.naturalHeight);
          };
          img.onerror = function () { finish("missing", "the image did not load"); };
          img.src = url;
        } else if (a.kind === "font") {
          if (typeof FontFace === "undefined" || !document.fonts) {
            return finish("unverifiable", "this browser has no FontFace API");
          }
          new FontFace("fk-probe", "url(" + JSON.stringify(url) + ")").load()
            .then(function () { finish("ok", "font parsed"); })
            .catch(function () { finish("missing", "the font did not load"); });
        } else {
          var m = document.createElement(a.kind === "video" ? "video" : "audio");
          m.preload = "metadata";
          m.onloadedmetadata = function () { finish("ok", "metadata read"); };
          m.onerror = function () { finish("missing", "the media did not load"); };
          m.src = url;
          try { m.load(); } catch (e) { /* some engines have no load() */ }
        }
      } catch (e) {
        finish("unverifiable", "the browser refused the probe: " + e.message);
      }
    });
  }

  async function verifyAll() {
    if (nodes.verifyBtn) {
      nodes.verifyBtn.disabled = true;
      nodes.verifyBtn.textContent = "VERIFYING…";
    }
    try {
      /* Snapshot first. `assets` is reassigned wholesale by load(),
         and each verifyOne awaits a media load of up to 4 seconds —
         so a save or a removal partway through a long run used to
         shift the array under the index, skipping entries while the
         toast still reported a complete sweep. A verification that
         quietly checks less than it says is worse than none. */
      var batch = assets.slice();
      for (var i = 0; i < batch.length; i++) {
        verdicts[batch[i].id] = await verifyOne(batch[i]);
      }
    } finally {
      if (nodes.verifyBtn) {
        nodes.verifyBtn.disabled = false;
        nodes.verifyBtn.textContent = "VERIFY ALL";
      }
    }
    render();
    var counts = summary();
    ui.toast(counts.missing
      ? counts.missing + " ASSET(S) MISSING"
      : "ALL RESOLVABLE ENTRIES FOUND", counts.missing ? "fail" : "ok");
  }

  function summary() {
    var out = { ok: 0, missing: 0, unverifiable: 0, unchecked: 0 };
    assets.forEach(function (a) {
      var v = verdicts[a.id];
      if (!v) out.unchecked++;
      else out[v.state === "ok" ? "ok" : v.state === "missing" ? "missing" : "unverifiable"]++;
    });
    return out;
  }

  /* ---- store ---------------------------------------------------- */
  /* Serialised like the other editors. Here the window is smaller —
     saving goes through a dialog you have to reopen — but the shape
     is identical: save() awaits before a.id is set, so two in
     flight on a new entry would file the same asset twice. */
  var saveChain = Promise.resolve();

  function save(a) {
    /* Decided at call time — see the note in topology.js. */
    if (savePaused) return saveChain;
    saveChain = saveChain.then(function () { return doSave(a); },
      function () { return doSave(a); }).catch(function (e) {
        var msg = (e && e.message) || String(e);
        FieldKit.log("error", "asset-library", "save failed: " + msg);
        if (ui && ui.toast) ui.toast("NOT SAVED — " + msg, "fail");
      });
    return saveChain;
  }

  async function doSave(a) {
    if (savePaused) return;
    var payload = { path: a.path, name: a.name, kind: a.kind, tags: a.tags,
      project: a.project, licence: a.licence, source: a.source, note: a.note };
    if (a.id) await ctx.store.put(TYPE, payload, { id: a.id });
    else { var rec = await ctx.store.put(TYPE, payload); a.id = rec.id; }
    await load();
  }

  async function load() {
    var rows = await ctx.store.list(TYPE);
    assets = rows.map(function (r) {
      var a = normalise(r.data, r.id);
      a.author = r.meta && r.meta.author || null;
      return a;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });

    var reg = FieldKit.service("projects");
    if (reg) {
      try { projects = await reg.all(); } catch (e) { projects = []; }
    }
    render();
  }

  /* ---- filtering ------------------------------------------------- */
  function visible() {
    var q = filter.text.toLowerCase().trim();
    return assets.filter(function (a) {
      if (filter.kind && a.kind !== filter.kind) return false;
      if (filter.tag && a.tags.indexOf(filter.tag) < 0) return false;
      if (filter.project && a.project !== filter.project) return false;
      if (filter.problems && !anyProblem(a)) return false;
      if (!q) return true;
      return (a.name + " " + a.path + " " + a.tags.join(" ") + " " + a.note + " " + a.source)
        .toLowerCase().indexOf(q) >= 0;
    });
  }

  /* A bare {} inherits Object.prototype, so a tag literally called
     "constructor" or "toString" reads back as a function rather
     than a count and renders as garbage. Tags come from user input,
     and "constructor" is a perfectly ordinary word to tag a code
     asset with. Object.create(null) has no prototype to collide
     with. Same fix wherever a user-supplied string is a key. */
  function allTags() {
    var counts = Object.create(null);
    assets.forEach(function (a) {
      a.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    return Object.keys(counts).sort(function (x, y) {
      return counts[y] - counts[x] || x.localeCompare(y);
    }).map(function (t) { return { tag: t, n: counts[t] }; });
  }

  /* ---- export ----------------------------------------------------
     A build manifest, so a game can consume the catalogue rather
     than someone retyping paths. Entries that must not ship are
     excluded from `assets` and listed separately under `excluded`
     with the reason — silently dropping them would hide the very
     problem the licence field exists to surface. */
  function toManifest() {
    var include = [], excluded = [], credits = [];
    assets.forEach(function (a) {
      var lic = licenceFor(a.licence);
      if (!lic.ship) {
        excluded.push({ path: fullPath(a), name: a.name,
          reason: a.licence ? lic.label : "no licence recorded" });
        return;
      }
      include.push({ id: a.id, name: a.name, path: fullPath(a), kind: a.kind,
        tags: a.tags, project: a.project || null, licence: a.licence });
      if (lic.attribution) {
        credits.push({ name: a.name, licence: lic.label, source: a.source || "SOURCE UNKNOWN" });
      }
    });
    return {
      format: "fieldkit-asset-manifest", v: 1,
      root: ROOT,
      generated: "see the record timestamps — this file carries no clock",
      assets: include,
      excluded: excluded,
      credits: credits,
      note: "Paths are relative to the drive root. Anything under `excluded` is catalogued " +
            "but must not be shipped; the reason is given. `credits` lists every asset whose " +
            "licence requires attribution."
    };
  }

  function creditsText() {
    var m = toManifest();
    if (!m.credits.length) return "No asset in this library requires attribution.";
    var L = ["CREDITS", ""];
    m.credits.forEach(function (c) {
      L.push("- " + c.name + " — " + c.licence + " — " + c.source);
    });
    return L.join("\n");
  }

  /* ---- rendering --------------------------------------------------- */
  function render() {
    if (!nodes.body) return;
    ui.clear(nodes.body);
    renderBar();

    var rows = visible();
    var s = summary();

    nodes.body.appendChild(ui.readout([
      { label: "CATALOGUED", value: String(assets.length), level: "dim" },
      { label: "SHOWING", value: String(rows.length), level: "dim" },
      { label: "FOUND ON DRIVE", value: String(s.ok), level: s.ok ? "ok" : "dim" },
      { label: "MISSING", value: String(s.missing), level: s.missing ? "fail" : "ok" },
      { label: "CANNOT BE CHECKED HERE", value: String(s.unverifiable), level: "dim" },
      { label: "NEVER VERIFIED", value: String(s.unchecked),
        level: s.unchecked ? "warn" : "ok" }
    ]));

    var unlicensed = assets.filter(function (a) { return !licenceFor(a.licence).ship; });
    if (unlicensed.length) {
      nodes.body.appendChild(el("div", { class: "al-warn", text:
        unlicensed.length + " asset(s) have no usable licence and are excluded from the build " +
        "manifest. Answer the licence question while you still remember the answer — it is " +
        "much harder six months later." }));
    }

    if (!assets.length) {
      nodes.body.appendChild(el("div", { class: "al-empty", text:
        "Nothing catalogued yet. Drop files into " + ROOT + " on the drive, then add an " +
        "entry here for each one. This module holds the index; the bytes stay on the drive." }));
      return;
    }

    var grid = el("div", { class: "al-grid" });
    rows.forEach(function (a) { grid.appendChild(card(a)); });
    if (!rows.length) {
      grid.appendChild(el("div", { class: "al-empty", text: "Nothing matches that filter." }));
    }
    nodes.body.appendChild(grid);
  }

  function renderBar() {
    if (!nodes.tags) return;
    ui.clear(nodes.tags);
    var tags = allTags();
    if (!tags.length) return;
    tags.slice(0, 24).forEach(function (t) {
      var b = ui.button(t.tag + " " + t.n, function () {
        filter.tag = filter.tag === t.tag ? null : t.tag;
        render();
      });
      b.className += " al-tag" + (filter.tag === t.tag ? " fk-btn-primary" : "");
      nodes.tags.appendChild(b);
    });
  }

  function card(a) {
    var v = verdicts[a.id];
    var lic = licenceFor(a.licence);
    var probs = problems(a);

    var box = el("article", { class: "al-card" + (probs.some(function (p) {
      return p.level === "fail"; }) ? " al-bad" : "") });

    /* Preview only for things a browser can render, and only ever
       by setting src to a path. Nothing here builds markup. */
    if (a.kind === "image" && a.path) {
      var img = el("img", { class: "al-thumb", alt: a.name, loading: "lazy" });
      img.src = fullPath(a);
      img.addEventListener("error", function () {
        img.replaceWith(el("div", { class: "al-thumb al-nothumb", text: "NOT FOUND" }));
      });
      box.appendChild(img);
    } else {
      box.appendChild(el("div", { class: "al-thumb al-nothumb",
        text: (KINDS[a.kind] || KINDS.data).label }));
    }

    box.appendChild(el("div", { class: "al-name", text: a.name }));
    box.appendChild(el("code", { class: "al-path", text: fullPath(a) }));

    var meta = el("div", { class: "al-meta" });
    meta.appendChild(el("span", { class: "al-chip", text: (KINDS[a.kind] || KINDS.data).label }));
    if (a.project) meta.appendChild(el("span", { class: "al-chip al-proj", text: a.project }));
    meta.appendChild(el("span", {
      class: "al-chip " + (lic.ship ? "al-lic-ok" : "al-lic-bad"),
      text: a.licence ? lic.label.split(" —")[0] : "NO LICENCE" }));
    if (v) {
      meta.appendChild(el("span", {
        class: "al-chip al-v-" + v.state,
        text: v.state === "ok" ? "FOUND" : v.state === "missing" ? "MISSING" : "UNCHECKABLE",
        title: v.why }));
    }
    box.appendChild(meta);

    if (a.tags.length) {
      var tw = el("div", { class: "al-tags" });
      a.tags.forEach(function (t) {
        var b = ui.button(t, function () {
          filter.tag = filter.tag === t ? null : t; render();
        });
        b.className += " al-tag";
        tw.appendChild(b);
      });
      box.appendChild(tw);
    }

    if (a.note) box.appendChild(el("p", { class: "al-note", text: a.note }));
    probs.forEach(function (p) {
      box.appendChild(el("div", { class: p.level === "fail" ? "al-pfail" : "al-pwarn",
        text: p.text }));
    });

    box.appendChild(el("div", { class: "al-actions" }, [
      ui.button("EDIT", function () { editor(a); }),
      ui.button("COPY PATH", function () {
        ui.copy(fullPath(a), { title: "ASSET PATH" }).then(function (how) {
          if (how) ui.toast("PATH COPIED", "ok");
        });
      }),
      ui.button("REMOVE", async function () {
        if (!confirm("Remove \"" + a.name + "\" from the catalogue?\n\n" +
          "This deletes the index entry only. The file on the drive is untouched.")) return;
        await ctx.store.remove(a.id);
        delete verdicts[a.id];
        await load();
      }, { danger: true })
    ]));

    return box;
  }

  function editor(a) {
    var isNew = !a;
    a = a || normalise({}, null);
    var draft = JSON.parse(JSON.stringify(a));

    var pathIn = ui.field("PATH UNDER " + ROOT, { value: draft.path,
      placeholder: "sprites/hero-idle.png" });
    var nameIn = ui.field("NAME", { value: draft.name });
    var tagsIn = ui.field("TAGS (comma separated)", { value: draft.tags.join(", ") });
    var srcIn = ui.field("SOURCE / AUTHOR", { value: draft.source,
      placeholder: "who made it, where it came from" });

    var kindSel = el("select", { class: "fk-input" });
    Object.keys(KINDS).forEach(function (k) {
      kindSel.appendChild(el("option", { value: k, text: KINDS[k].label,
        selected: draft.kind === k ? true : null }));
    });

    var licSel = el("select", { class: "fk-input" });
    LICENCES.forEach(function (l) {
      licSel.appendChild(el("option", { value: l.id, text: l.label,
        selected: draft.licence === l.id ? true : null }));
    });

    var projSel = el("select", { class: "fk-input" });
    projSel.appendChild(el("option", { value: "", text: "— none —" }));
    projects.forEach(function (p) {
      projSel.appendChild(el("option", { value: p.slug, text: p.name,
        selected: draft.project === p.slug ? true : null }));
    });

    var noteIn = el("textarea", { class: "fk-input al-ta", rows: "3", value: draft.note });
    noteIn.value = draft.note;

    /* Kind follows the extension unless it has been set by hand. */
    pathIn.input.addEventListener("input", function () {
      var k = kindFor(cleanPath(pathIn.input.value));
      if (!isNew && draft.kind !== kindFor(draft.path)) return;
      kindSel.value = k;
    });

    var body = el("div", {}, [
      pathIn, nameIn,
      el("div", { class: "al-egrid" }, [
        el("label", { class: "fk-field" }, [
          el("span", { class: "fk-field-label", text: "KIND" }), kindSel ]),
        el("label", { class: "fk-field" }, [
          el("span", { class: "fk-field-label", text: "PROJECT" }), projSel ])
      ]),
      el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: "LICENCE" }), licSel ]),
      srcIn, tagsIn,
      el("label", { class: "fk-field" }, [
        el("span", { class: "fk-field-label", text: "NOTE" }), noteIn ]),
      el("p", { class: "al-hint", text:
        "The file itself is never copied into the vault — only this entry is. Put the file " +
        "in " + ROOT + " on the drive and point at it from here." })
    ]);

    var dlg = el("div", { class: "al-dlg" }, [
      el("div", { class: "al-dlg-box" }, [
        el("h3", { class: "al-dlg-h", text: isNew ? "ADD ASSET" : "EDIT ASSET" }),
        body,
        el("div", { class: "al-dlg-actions" }, [
          ui.button("CANCEL", closeDialog),
          ui.button("SAVE", async function () {
            var next = normalise({
              path: pathIn.input.value,
              name: nameIn.input.value,
              kind: kindSel.value,
              tags: tagsIn.input.value.split(","),
              project: projSel.value || null,
              licence: licSel.value,
              source: srcIn.input.value,
              note: noteIn.value
            }, a.id);
            if (!next.path) { ui.toast("AN ASSET NEEDS A PATH", "warn"); return; }
            var clash = assets.filter(function (x) {
              return x.path === next.path && x.id !== next.id;
            })[0];
            if (clash) {
              ui.toast("THAT PATH IS ALREADY CATALOGUED AS " + clash.name, "warn");
              return;
            }
            closeDialog();
            delete verdicts[next.id];
            await save(next);
          }, { primary: true })
        ])
      ])
    ]);

    /* The dialog lives on document.body, outside the module's own
       host element — so closing the window took the module down and
       left a full-screen z-index:60 overlay sitting over the whole
       desktop, swallowing every click, with no Escape handler and
       no way back short of reloading the page. On a file:// console
       a reload means re-entering the vault password.

       Three closes now: the buttons, Escape, and clicking the
       backdrop. And unmount() takes it with the module. */
    dlg.addEventListener("mousedown", function (ev) {
      if (ev.target === dlg) closeDialog();
    });
    dlg.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.preventDefault(); closeDialog(); }
    });

    nodes.dlg = dlg;
    document.body.appendChild(dlg);
    try { pathIn.input.focus(); } catch (e) { /* fine */ }
  }

  function closeDialog() {
    if (!nodes.dlg) return;
    try { nodes.dlg.remove(); } catch (e) { /* already gone */ }
    nodes.dlg = null;
  }

  /* ---- probes ---------------------------------------------------- */
  function selfcheck(api) {
    return [
      /* The load-bearing promise of this module. If bytes ever start
         going into the vault, the encrypted store becomes a file
         server and everything about §1 stops being true. */
      { name: "IT CATALOGUES PATHS, NEVER BYTES", critical: true, run: async function () {
        var a = normalise({ path: "sprites/hero.png", name: "Hero",
          data: "AAAA", bytes: [1, 2, 3], blob: "x" }, null);
        ["data", "bytes", "blob", "content", "b64"].forEach(function (k) {
          if (k in a) throw new Error("normalise now carries a '" + k + "' field");
        });
        var src = String(save) + String(normalise);
        [/FileReader/, /readAsDataURL/, /toDataURL/, /createObjectURL/, /\bBlob\s*\(/]
          .forEach(function (re) {
            if (re.test(src)) throw new Error("the save path now touches " + re.source);
          });
        var payload = JSON.stringify(a);
        if (payload.length > 1200) {
          throw new Error("a catalogue entry is " + payload.length +
            " bytes — something bulky got in");
        }
        return "an entry is metadata and a path, and the save path cannot read a file";
      } },

      /* Three states, not two. Collapsing them sends people hunting
         for files that were never missing. */
      { name: "UNVERIFIABLE IS NOT MISSING", critical: true, run: async function () {
        var v = await verifyOne(normalise({ path: "levels/world1.tmx" }, "p1"));
        if (v.state !== "unverifiable") {
          throw new Error("a .tmx came back as '" + v.state + "' rather than unverifiable");
        }
        if (!/cannot probe/i.test(v.why)) throw new Error("it did not explain why");

        var none = await verifyOne(normalise({ path: "" }, "p2"));
        if (none.state !== "missing") {
          throw new Error("an entry with no path was not called missing");
        }

        var was = assets, wasV = verdicts;
        try {
          assets = [normalise({ path: "a.tmx" }, "x1"), normalise({ path: "b.png" }, "x2")];
          verdicts = { x1: { state: "unverifiable" }, x2: { state: "missing" } };
          var s = summary();
          if (s.missing !== 1 || s.unverifiable !== 1) {
            throw new Error("the summary merged the two states: " + JSON.stringify(s));
          }
        } finally { assets = was; verdicts = wasV; }
        return "unprobeable, absent and unchecked are three separate answers";
      } },

      { name: "PATHS CANNOT ESCAPE THE DRIVE", critical: true, run: async function () {
        var cases = [
          ["../../windows/system32/config", "windows/system32/config"],
          ["/etc/passwd", "etc/passwd"],
          ["C:\\Users\\me\\secret.png", "Users/me/secret.png"],
          ["./sprites/./hero.png", "sprites/hero.png"],
          ["sprites\\hero.png", "sprites/hero.png"]
        ];
        cases.forEach(function (c) {
          var got = cleanPath(c[0]);
          if (got !== c[1]) {
            throw new Error("cleanPath(" + JSON.stringify(c[0]) + ") gave " +
              JSON.stringify(got) + ", expected " + JSON.stringify(c[1]));
          }
        });
        if (cleanPath("..").length) throw new Error("a bare .. survived");
        var full = fullPath(normalise({ path: "../../../evil.png" }, null));
        if (full.indexOf("..") >= 0) throw new Error("a traversal survived into the full path");
        if (full.indexOf(ROOT) !== 0) throw new Error("the full path left the library root");
        return "traversals, drive letters and leading slashes are all stripped";
      } },

      { name: "UNLICENSED ASSETS NEVER REACH A BUILD", critical: true, run: async function () {
        var was = assets;
        try {
          assets = [
            normalise({ path: "a.png", name: "Mine", licence: "own", tags: ["t"] }, "1"),
            normalise({ path: "b.png", name: "Unanswered", tags: ["t"] }, "2"),
            normalise({ path: "c.png", name: "Unknown", licence: "unknown", tags: ["t"] }, "3"),
            normalise({ path: "d.png", name: "Attributed", licence: "ccby",
              source: "somebody", tags: ["t"] }, "4")
          ];
          var m = toManifest();
          var shipped = m.assets.map(function (x) { return x.name; });
          if (shipped.indexOf("Unanswered") >= 0) {
            throw new Error("an asset with no licence was put in the manifest");
          }
          if (shipped.indexOf("Unknown") >= 0) {
            throw new Error("an asset marked do-not-ship was put in the manifest");
          }
          if (shipped.indexOf("Mine") < 0) throw new Error("my own work was excluded");
          if (m.excluded.length !== 2) {
            throw new Error("excluded assets were dropped silently rather than listed");
          }
          if (!m.excluded.every(function (e) { return e.reason; })) {
            throw new Error("an exclusion carries no reason");
          }
          if (m.credits.length !== 1 || m.credits[0].name !== "Attributed") {
            throw new Error("attribution-required assets did not reach the credits");
          }
          return "two excluded with reasons, one credited, nothing shipped by accident";
        } finally { assets = was; }
      } },

      { name: "AN UNCREDITED CC-BY ASSET IS FLAGGED", critical: false, run: async function () {
        var bare = problems(normalise({ path: "a.png", licence: "ccby", tags: ["x"] }, "1"));
        if (!bare.some(function (p) { return /attribution/i.test(p.text); })) {
          throw new Error("CC-BY with no source was not flagged");
        }
        var credited = problems(normalise({ path: "a.png", licence: "ccby",
          source: "Kenney", tags: ["x"] }, "1"));
        if (credited.some(function (p) { return /attribution/i.test(p.text); })) {
          throw new Error("CC-BY with a source was still flagged");
        }
        var nc = problems(normalise({ path: "a.png", licence: "nc", tags: ["x"] }, "1"));
        if (!nc.some(function (p) { return /commercial/i.test(p.text); })) {
          throw new Error("a non-commercial asset carried no caveat");
        }
        var m = creditsText();
        if (!/No asset/.test(m) && !/CREDITS/.test(m)) {
          throw new Error("the credits text is neither a list nor an honest empty");
        }
        return "attribution, share-alike and non-commercial all say something useful";
      } },

      { name: "KINDS FOLLOW THE FILE", critical: false, run: async function () {
        var map = { "a.png": "image", "b.WAV": "audio", "c.mp4": "video",
          "d.woff2": "font", "e.aseprite": "data", "f": "data", "g.tmx": "data" };
        Object.keys(map).forEach(function (p) {
          var got = kindFor(p);
          if (got !== map[p]) throw new Error(p + " was read as " + got + ", not " + map[p]);
        });
        if (KINDS.data.verifiable) throw new Error("data files are claimed to be verifiable");
        return "extensions map to kinds, and the unverifiable kind admits it";
      } },

      { name: "SEARCH AND FILTERS ACTUALLY NARROW", critical: false, run: async function () {
        var wasA = assets, wasF = filter;
        try {
          assets = [
            normalise({ path: "a.png", name: "Hero idle", tags: ["hero", "sprite"],
              project: "gamejam", licence: "own" }, "1"),
            normalise({ path: "b.wav", name: "Jump sound", tags: ["sfx"],
              project: "gamejam", licence: "own" }, "2"),
            normalise({ path: "c.png", name: "Tileset", tags: ["sprite"], licence: "" }, "3")
          ];
          filter = { text: "", tag: null, kind: null, project: null, problems: false };
          if (visible().length !== 3) throw new Error("an empty filter hid something");
          filter.text = "jump";
          if (visible().length !== 1) throw new Error("text search did not narrow to one");
          filter.text = ""; filter.tag = "sprite";
          if (visible().length !== 2) throw new Error("tag filter is wrong");
          filter.tag = null; filter.kind = "audio";
          if (visible().length !== 1) throw new Error("kind filter is wrong");
          filter.kind = null; filter.project = "gamejam";
          if (visible().length !== 2) throw new Error("project filter is wrong");
          filter.project = null; filter.problems = true;
          var probs = visible();
          if (!probs.some(function (a) { return a.name === "Tileset"; })) {
            throw new Error("the unlicensed asset is not in the problems view");
          }
          if (probs.some(function (a) { return a.name === "Hero idle"; })) {
            throw new Error("a clean asset showed up in the problems view");
          }
          var tags = allTags();
          if (tags[0].tag !== "sprite" || tags[0].n !== 2) {
            throw new Error("tag counts are wrong: " + JSON.stringify(tags));
          }
          return "text, tag, kind, project and problems all narrow correctly";
        } finally { assets = wasA; filter = wasF; }
      } },

      { name: "A PREVIEW IS A SRC, NEVER MARKUP", critical: true, run: async function () {
        var src = String(card) + String(render) + String(editor);
        [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/]
          .forEach(function (re) {
            if (re.test(src)) throw new Error("the render path now uses " + re.source);
          });
        var was = assets;
        try {
          assets = [normalise({ path: "x.png", name: "<img onerror=alert(1)>",
            tags: ["<b>"], note: "<script>", licence: "own" }, "1")];
          var c = card(assets[0]);

          /* Ask the DOM, not the serialiser. outerHTML does not
             escape < and > inside attribute values, so a hostile
             string sitting harmlessly in alt="" looks identical to
             a live tag when you scan the markup as a string. The
             tree knows the difference. */
          if (c.querySelectorAll("script").length) {
            throw new Error("a note was parsed into a script element");
          }
          var imgs = c.querySelectorAll("img");
          for (var i = 0; i < imgs.length; i++) {
            if (imgs[i].getAttribute("onerror") || imgs[i].getAttribute("onload")) {
              throw new Error("an inline event handler reached the page");
            }
          }
          /* If the name had been parsed as markup, the angle
             brackets would be gone from textContent. They are only
             still there because it was inserted as text. */
          if ((c.textContent || "").indexOf("<img onerror=alert(1)>") < 0) {
            throw new Error("the hostile name did not survive as literal text");
          }
          return "no HTML sinks in the render path, and hostile text stays text";
        } finally { assets = was; }
      } },

      { name: "DUPLICATE PATHS ARE REFUSED", critical: false, run: async function () {
        var was = assets;
        try {
          assets = [normalise({ path: "sprites/hero.png", name: "First" }, "1")];
          var next = normalise({ path: "./sprites/hero.png", name: "Second" }, "2");
          var clash = assets.filter(function (x) {
            return x.path === next.path && x.id !== next.id;
          })[0];
          if (!clash) throw new Error("the same path under a different spelling was not caught");
          return "two entries cannot point at one file, whatever the spelling";
        } finally { assets = was; }
      } },

      { name: "PROBES DO NOT PERSIST ANYTHING", critical: true, run: async function () {
        var before = (await ctx.store.list(TYPE)).length;
        savePaused = true;
        try {
          await save(normalise({ path: "probe/nothing.png", name: "probe" }, null));
        } finally { savePaused = false; }
        var after = (await ctx.store.list(TYPE)).length;
        if (after !== before) throw new Error("a probe wrote " + (after - before) + " entry(s)");
        return "drove the save path with the guard on, wrote nothing";
      } }
    ];
  }

  function searchIndex() {
    return assets.map(function (a) {
      return { id: a.id, title: a.name,
        body: [fullPath(a), a.tags.join(" "), a.project, a.note, a.source]
          .filter(Boolean).join(" ") };
    });
  }

  FieldKit.register("asset-library", {
    group: "FILES",
    about: "A catalogue of your art, sprites and sounds and where they live",
    keywords: "assets art sprites audio images catalogue",
    guestSafe: false,
    selfcheck: selfcheck,
    searchIndex: searchIndex,
    title: "ASSET LIBRARY",
    icon: "▦",
    width: 900,
    height: 740,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      var search = ui.field("SEARCH", { placeholder: "name, path, tag, note" });
      search.input.addEventListener("input", function () {
        filter.text = search.input.value; render();
      });

      var kindSel = el("select", { class: "fk-input" });
      kindSel.appendChild(el("option", { value: "", text: "ALL KINDS" }));
      Object.keys(KINDS).forEach(function (k) {
        kindSel.appendChild(el("option", { value: k, text: KINDS[k].label }));
      });
      kindSel.addEventListener("change", function () {
        filter.kind = kindSel.value || null; render();
      });

      var probBox = el("input", { type: "checkbox" });
      probBox.addEventListener("change", function () {
        filter.problems = !!probBox.checked; render();
      });

      nodes.verifyBtn = ui.button("VERIFY ALL", verifyAll);
      nodes.tags = el("div", { class: "al-tagbar" });
      nodes.body = el("div", { class: "al-body" });

      host.appendChild(el("div", { class: "al-wrap" }, [
        el("p", { class: "al-intro", text:
          "This is the index, not the store. The files live in " + ROOT + " on the drive; " +
          "what is encrypted here is where each one is, what it is for, and whether you are " +
          "allowed to ship it." }),

        el("div", { class: "al-bar" }, [
          search,
          el("label", { class: "fk-field al-kindfield" }, [
            el("span", { class: "fk-field-label", text: "KIND" }), kindSel ]),
          el("label", { class: "fk-field al-check" }, [
            probBox, el("span", { class: "fk-field-label", text: "PROBLEMS ONLY" }) ])
        ]),

        nodes.tags,

        el("div", { class: "al-actions al-top" }, [
          ui.button("ADD ASSET", function () { editor(null); }, { primary: true }),
          nodes.verifyBtn,
          ui.button("COPY MANIFEST", function () {
            ui.copy(JSON.stringify(toManifest(), null, 1), { title: "ASSET MANIFEST",
              note: "Clipboard access is blocked here. Select this and press Ctrl+C." })
              .then(function (how) { if (how) ui.toast("MANIFEST COPIED", "ok"); });
          }),
          ui.button("COPY CREDITS", function () {
            ui.copy(creditsText(), { title: "CREDITS" }).then(function (how) {
              if (how) ui.toast("CREDITS COPIED", "ok");
            });
          })
        ]),

        nodes.body
      ]));

      await load();
    },

    unmount() {
      /* Before clearing nodes — the dialog reference lives there,
         and it is parented to document.body, so nothing else can
         take it down. */
      closeDialog();
      nodes = {}; assets = []; projects = []; verdicts = Object.create(null);
      filter = { text: "", tag: null, kind: null, project: null, problems: false };
    }
  });

  function injectCSS() {
    if (document.getElementById("al-style")) return;
    var s = document.createElement("style");
    s.id = "al-style";
    s.textContent = `
.al-wrap{height:100%;overflow:auto}
.al-intro{font-size:11px;color:var(--fg-dim);line-height:1.7;margin:0 0 10px;
  border-left:2px solid var(--line2);padding-left:9px}
.al-bar{display:grid;grid-template-columns:2fr 1fr auto;gap:6px;align-items:end}
.al-bar .fk-field{margin:0}
.al-kindfield{min-width:120px}
.al-check{display:flex;flex-direction:row;align-items:center;gap:6px;padding-bottom:7px}
.al-tagbar{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0}
.al-tag{font-size:9px;padding:2px 7px;letter-spacing:.06em}
.al-actions{display:flex;gap:6px;flex-wrap:wrap}
.al-actions .fk-btn{flex:1;min-width:110px}
.al-top{margin:8px 0 12px}
.al-body{margin-top:10px}
.al-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:9px;
  margin-top:10px}
.al-card{border:1px solid var(--line);background:var(--panel);padding:8px}
.al-card.al-bad{border-color:var(--fail)}
.al-thumb{display:block;width:100%;height:96px;object-fit:contain;background:var(--bg2);
  border:1px solid var(--line2)}
.al-nothumb{display:flex;align-items:center;justify-content:center;color:var(--fg-dimmer);
  font-size:9px;letter-spacing:.14em}
.al-name{font-size:11px;color:var(--fg);margin-top:6px;word-break:break-word}
.al-path{display:block;font-size:9px;color:var(--fg-dimmer);word-break:break-all;margin-top:2px}
.al-meta{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.al-chip{font-size:8px;letter-spacing:.1em;border:1px solid var(--line2);padding:0 4px;
  color:var(--fg-dimmer)}
.al-proj{color:var(--info);border-color:var(--info)}
.al-lic-ok{color:var(--pass);border-color:var(--pass)}
.al-lic-bad{color:var(--fail);border-color:var(--fail)}
.al-v-ok{color:var(--pass);border-color:var(--pass)}
.al-v-missing{color:var(--fail);border-color:var(--fail)}
.al-v-unverifiable{color:var(--warn);border-color:var(--warn)}
.al-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.al-note{font-size:10px;color:var(--fg-dim);line-height:1.6;margin:6px 0 0}
.al-pwarn{font-size:9px;color:var(--warn);line-height:1.5;margin-top:6px;
  border-left:2px solid var(--warn);padding-left:7px}
.al-pfail{font-size:9px;color:var(--fail);line-height:1.5;margin-top:6px;
  border-left:2px solid var(--fail);padding-left:7px}
.al-card .al-actions{margin-top:8px}
.al-card .al-actions .fk-btn{font-size:9px;padding:3px 6px;min-width:0}
.al-warn{font-size:10px;color:var(--warn);line-height:1.6;margin:10px 0 0;
  border-left:2px solid var(--warn);padding-left:9px}
.al-empty{color:var(--fg-dimmer);font-size:10px;line-height:1.7;padding:18px 4px;
  grid-column:1/-1}
.al-dlg{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;
  justify-content:center;z-index:60;padding:16px}
.al-dlg-box{background:var(--panel);border:1px solid var(--accent-dim);padding:14px;
  max-width:520px;width:100%;max-height:90vh;overflow:auto}
.al-dlg-h{margin:0 0 10px;font-size:11px;letter-spacing:.16em;color:var(--accent);
  font-weight:normal}
.al-dlg-actions{display:flex;gap:6px;margin-top:12px}
.al-dlg-actions .fk-btn{flex:1}
.al-egrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.al-egrid .fk-field{margin:0}
.al-ta{resize:vertical;font-family:inherit}
.al-hint{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--line2);padding-left:9px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
