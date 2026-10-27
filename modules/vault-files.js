/* ============================================================
   FieldKit :: vault-files
   The window over core/files.js — chunked encrypted storage for
   the things Git is bad at (§5, relay/LARGE-FILES.md).

   Its most important job is not uploading. It is telling you, at
   the moment you pick a file, whether this is the right place to
   put it. A .blend belongs here. A .tscn belongs in Git. Saying
   that at the point of decision is worth more than a document.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, files, nodes = {}, rows = [], filter = "", kindFilter = "";
  var busy = false, pending = null, offs = [];

  function fmt(n) { return files.fmtBytes(n); }

  function shortDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toISOString().slice(0, 16).replace("T", " "); }
    catch (e) { return "—"; }
  }

  async function load() {
    try { rows = await files.list(); }
    catch (e) { rows = []; }
    renderList();
    renderUsage();
  }

  /* ---- capability banner --------------------------------------
     Three distinct states that must not be conflated, because the
     right response to each is different:
       no blob support  → the relay is old, upload the new server.js
       local transport  → it works, but it is not durable storage
       relay            → good */
  function renderCaps() {
    var caps = files.capabilities();
    ui.clear(nodes.caps);

    if (!caps.available) {
      nodes.caps.appendChild(el("div", { class: "vf-banner bad" }, [
        el("strong", { text: "FILE STORAGE UNAVAILABLE" }),
        el("div", { text:
          "The current transport has no blob support. If you are connected to the relay, " +
          "it is running a build from before file storage existed — re-upload relay/server.js. " +
          "If you are offline, files need a connection." })
      ]));
      nodes.pick.disabled = true;
      return;
    }

    if (!caps.durable) {
      nodes.caps.appendChild(el("div", { class: "vf-banner warn" }, [
        el("strong", { text: "LOCAL STORAGE ONLY — NOT DURABLE" }),
        el("div", { text:
          "There is no relay connection, so files go to IndexedDB in this browser profile. " +
          "That does not travel with the drive and does not survive a powerwash. " +
          "Treat anything stored now as temporary and re-upload it when the relay is back." })
      ]));
      return;
    }

    nodes.caps.appendChild(el("div", { class: "vf-banner ok" }, [
      el("strong", { text: "ENCRYPTED FILE STORAGE READY" }),
      el("div", { text:
        "Files are split into " + fmt(caps.chunkBytes) + " chunks, each encrypted separately " +
        "before it leaves this machine. The relay stores unordered, unlabelled ciphertext — " +
        "it cannot tell which chunks belong to which file, or that a file exists at all." })
    ]));
  }

  async function renderUsage() {
    ui.clear(nodes.usage);
    var u;
    try { u = await files.usage(); }
    catch (e) {
      nodes.usage.appendChild(el("div", { class: "vf-dim", text: "usage unavailable: " + e.message }));
      return;
    }
    var readouts = [
      { label: "FILES", value: u.files },
      { label: "ORIGINAL SIZE", value: fmt(u.logicalBytes) },
      { label: "STORED (ENCRYPTED)", value: fmt(u.storedBytes) },
      { label: "CHUNKS", value: u.blobs }
    ];
    if (u.quotaBytes) {
      var pct = Math.round((u.storedBytes / u.quotaBytes) * 100);
      readouts.push({
        label: "QUOTA", value: pct + "% of " + fmt(u.quotaBytes),
        level: pct > 90 ? "fail" : (pct > 70 ? "warn" : "ok")
      });
    } else {
      /* A dash, not a zero — the local transport genuinely cannot
         know its own ceiling, and inventing one would be worse. */
      readouts.push({ label: "QUOTA", value: "—", level: "dim" });
    }
    nodes.usage.appendChild(ui.readout(readouts));
  }

  /* ---- picking ------------------------------------------------- */
  function onPicked(fileList) {
    var list = Array.prototype.slice.call(fileList || []);
    if (!list.length) return;
    pending = list;
    renderPending();
  }

  function renderPending() {
    ui.clear(nodes.pending);
    if (!pending || !pending.length) return;

    var totalBytes = pending.reduce(function (n, f) { return n + f.size; }, 0);
    var totalChunks = pending.reduce(function (n, f) {
      return n + Math.max(1, Math.ceil(f.size / files.capabilities().chunkBytes));
    }, 0);

    nodes.pending.appendChild(el("div", { class: "vf-pending-head" }, [
      el("strong", { text: pending.length + " FILE" + (pending.length === 1 ? "" : "S") + " READY" }),
      el("span", { class: "vf-dim", text: fmt(totalBytes) + " · " + totalChunks + " chunks" })
    ]));

    pending.forEach(function (f, i) {
      var a = files.advise(f.name, f.size);
      var row = el("div", { class: "vf-pending-row " + a.level }, [
        el("div", { class: "vf-pending-name" }, [
          el("span", { class: "vf-name", text: f.name }),
          el("span", { class: "vf-kind", text: files.classify(f.name).label })
        ]),
        el("span", { class: "vf-size", text: fmt(f.size) }),
        ui.button("REMOVE", function () {
          pending.splice(i, 1);
          renderPending();
        })
      ]);
      nodes.pending.appendChild(row);
      if (a.text) {
        nodes.pending.appendChild(el("div", { class: "vf-advice " + a.level, text: a.text }));
      }
    });

    nodes.pending.appendChild(el("div", { class: "vf-pending-actions" }, [
      nodes.uploadBtn, ui.button("CLEAR", function () { pending = null; renderPending(); })
    ]));
  }

  async function doUpload() {
    if (busy || !pending || !pending.length) return;
    busy = true;
    nodes.uploadBtn.disabled = true;

    var tags = nodes.tags.value.split(",").map(function (t) {
      return t.trim().toLowerCase();
    }).filter(Boolean);
    var note = nodes.note.value;
    var projectId = nodes.project.value || null;

    var okCount = 0, failed = [];
    for (var i = 0; i < pending.length; i++) {
      var f = pending[i];
      var label = "(" + (i + 1) + "/" + pending.length + ") " + f.name;
      try {
        /* eslint-disable no-loop-func */
        await files.upload(f, {
          tags: tags, note: note, projectId: projectId,
          onProgress: function (done, total, phase) {
            setProgress(label + " — " + phase + " " + done + "/" + total, done / Math.max(1, total));
          }
        });
        okCount++;
      } catch (e) {
        failed.push(f.name + ": " + e.message);
        ctx.warn("upload failed for " + f.name + ": " + e.message);
      }
    }

    setProgress("", 0);
    busy = false;
    nodes.uploadBtn.disabled = false;
    pending = null;
    nodes.note.value = "";
    renderPending();
    await load();

    if (failed.length) {
      ui.toast(okCount + " STORED, " + failed.length + " FAILED", "warn");
      ui.textDump(failed.join("\n"), { title: "UPLOAD FAILURES" });
    } else {
      ui.toast(okCount + " FILE" + (okCount === 1 ? "" : "S") + " STORED", "ok");
    }
  }

  function setProgress(text, frac) {
    if (!nodes.progress) return;
    if (!text) { nodes.progress.className = "vf-progress"; ui.clear(nodes.progress); return; }
    nodes.progress.className = "vf-progress on";
    ui.clear(nodes.progress);
    nodes.progress.appendChild(el("div", { class: "vf-progress-text", text: text }));
    var bar = el("div", { class: "vf-progress-bar" });
    var fill = el("div", { class: "vf-progress-fill" });
    fill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
    bar.appendChild(fill);
    nodes.progress.appendChild(bar);
  }

  /* ---- the stored list ----------------------------------------- */
  function matches(r) {
    if (kindFilter && r.data.kind !== kindFilter) return false;
    if (!filter) return true;
    var q = filter.toLowerCase();
    return [r.data.name, r.data.note, r.data.kind]
      .concat(r.data.tags || [])
      .join(" ").toLowerCase().indexOf(q) >= 0;
  }

  function renderList() {
    ui.clear(nodes.list);
    ui.clear(nodes.kinds);

    var counts = Object.create(null);
    rows.forEach(function (r) { counts[r.data.kind] = (counts[r.data.kind] || 0) + 1; });
    var kinds = Object.keys(counts).sort();
    if (kinds.length) {
      nodes.kinds.appendChild(el("button", {
        class: "vf-chip" + (kindFilter === "" ? " on" : ""), type: "button",
        text: "ALL " + rows.length,
        onclick: function () { kindFilter = ""; renderList(); }
      }));
      kinds.forEach(function (k) {
        nodes.kinds.appendChild(el("button", {
          class: "vf-chip" + (kindFilter === k ? " on" : ""), type: "button",
          text: k + " " + counts[k],
          onclick: function () { kindFilter = kindFilter === k ? "" : k; renderList(); }
        }));
      });
    }

    var shown = rows.filter(matches);
    if (!shown.length) {
      nodes.list.appendChild(el("div", { class: "vf-empty",
        text: rows.length ? "NO MATCHES" : "NO FILES STORED YET" }));
      return;
    }

    shown.forEach(function (r) {
      var d = r.data;
      var head = el("div", { class: "vf-row-head" }, [
        el("span", { class: "vf-name", text: d.name }),
        el("span", { class: "vf-kind", text: (files.classify(d.name)).label }),
        el("span", { class: "vf-size", text: fmt(d.size) })
      ]);
      var meta = el("div", { class: "vf-row-meta", text:
        shortDate(d.uploadedAt) +
        (r.meta.author ? " · " + r.meta.author : "") +
        " · " + (d.chunks || []).length + " chunks" +
        (d.tags && d.tags.length ? " · " + d.tags.join(", ") : "") });

      var actions = el("div", { class: "vf-row-actions" }, [
        ui.button("DOWNLOAD", function () { doDownload(r.id, d); }),
        ui.button("VERIFY", function () { doVerify(r.id, d); }),
        ui.button("DELETE", function () { doRemove(r.id, d); }, { danger: true })
      ]);

      var box = el("div", { class: "vf-row" }, [head, meta]);
      if (d.note) box.appendChild(el("div", { class: "vf-row-note", text: d.note }));
      box.appendChild(actions);
      nodes.list.appendChild(box);
    });
  }

  async function doDownload(id, d) {
    if (busy) return;
    busy = true;
    try {
      var blob = await files.download(id, {
        onProgress: function (done, total, phase) {
          setProgress(d.name + " — " + phase + " " + done + "/" + total, done / Math.max(1, total));
        }
      });
      setProgress("", 0);
      /* A download link, not the File System Access API — that does
         not exist on file:// (§2C). This route works everywhere. */
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = d.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      ui.toast("DOWNLOADED — CHECK YOUR DOWNLOADS FOLDER", "ok");
    } catch (e) {
      setProgress("", 0);
      ui.toast("DOWNLOAD FAILED", "fail");
      ui.textDump(e.message, { title: "DOWNLOAD FAILED — " + d.name });
    } finally { busy = false; }
  }

  async function doVerify(id, d) {
    try {
      var v = await files.verify(id);
      if (v.ok) {
        ui.toast("ALL " + v.chunks + " CHUNKS PRESENT", "ok");
        return;
      }
      ui.textDump(
        "FILE: " + d.name + "\n" +
        "CHUNKS: " + v.chunks + "\n" +
        (v.missing.length ? "MISSING: " + v.missing.join(", ") + "\n" : "") +
        (v.wrongSize.length ? "WRONG SIZE: " + v.wrongSize.join(", ") + "\n" : "") +
        "\nThis file cannot be rebuilt as it stands. If you still have the original, " +
        "upload it again and delete this record.",
        { title: "INTEGRITY PROBLEM" });
    } catch (e) {
      ui.toast("VERIFY FAILED: " + e.message, "fail");
    }
  }

  async function doRemove(id, d) {
    if (!confirm("Delete " + d.name + " and all " + (d.chunks || []).length +
                 " of its chunks? This cannot be undone.")) return;
    try {
      await files.remove(id);
      await load();
      ui.toast("DELETED", "warn");
    } catch (e) {
      ui.toast("DELETE FAILED: " + e.message, "fail");
    }
  }

  /* ---- housekeeping -------------------------------------------- */
  async function findOrphans() {
    var o;
    try { o = await files.orphans(); }
    catch (e) { ui.textDump(e.message, { title: "CANNOT CHECK FOR ORPHANS" }); return; }

    if (!o.orphans.length) {
      ui.toast("NO ORPHANS — " + o.referenced + " CHUNKS ALL ACCOUNTED FOR", "ok");
      return;
    }
    var keys = o.orphans.map(function (b) { return b.key; });
    if (!confirm(o.orphans.length + " orphaned chunk(s) found, " + fmt(o.bytes) +
                 ". These belong to no file record — usually a failed upload. Delete them?")) return;
    var n = await files.purgeOrphans(keys);
    await load();
    ui.toast("PURGED " + n + " ORPHANED CHUNK(S)", "ok");
  }

  /* ---- css ----------------------------------------------------- */
  function injectCSS() {
    if (document.getElementById("vf-style")) return;
    var s = document.createElement("style");
    s.id = "vf-style";
    s.textContent = [
      ".vf-wrap{display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;padding:2px}",
      ".vf-banner{border-left:3px solid var(--fk-accent);padding:8px 10px;font-size:12px;line-height:1.5;background:rgba(255,255,255,0.03)}",
      ".vf-banner.bad{border-left-color:var(--fk-fail)}",
      ".vf-banner.warn{border-left-color:var(--fk-warn)}",
      ".vf-banner.ok{border-left-color:var(--fk-ok)}",
      ".vf-banner strong{display:block;margin-bottom:3px;letter-spacing:.06em}",
      ".vf-drop{border:1px dashed var(--fk-line);padding:14px;text-align:center;font-size:12px}",
      ".vf-drop.over{border-color:var(--fk-accent);background:rgba(255,255,255,0.04)}",
      ".vf-row,.vf-pending-row{border:1px solid var(--fk-line);padding:8px 10px;margin-bottom:6px}",
      ".vf-row-head,.vf-pending-name{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}",
      ".vf-name{font-weight:600;word-break:break-all}",
      ".vf-kind{font-size:10px;letter-spacing:.08em;opacity:.65;border:1px solid var(--fk-line);padding:0 4px}",
      ".vf-size{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.8;font-size:11px}",
      ".vf-row-meta{font-size:11px;opacity:.6;margin-top:3px}",
      ".vf-row-note{font-size:12px;margin-top:5px;white-space:pre-wrap}",
      ".vf-row-actions,.vf-pending-actions{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}",
      ".vf-pending-row{display:flex;gap:8px;align-items:center}",
      ".vf-pending-row .vf-pending-name{flex:1;min-width:0}",
      ".vf-pending-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}",
      ".vf-advice{font-size:11px;line-height:1.5;padding:4px 8px;margin:-4px 0 8px;border-left:2px solid var(--fk-warn);opacity:.85}",
      ".vf-advice.ok{border-left-color:var(--fk-ok)}",
      ".vf-chips{display:flex;gap:4px;flex-wrap:wrap}",
      ".vf-chip{background:none;border:1px solid var(--fk-line);color:inherit;font:inherit;font-size:10px;padding:1px 6px;cursor:pointer;letter-spacing:.05em}",
      ".vf-chip.on{border-color:var(--fk-accent);color:var(--fk-accent)}",
      ".vf-empty,.vf-dim{opacity:.5;font-size:12px;padding:8px 0}",
      ".vf-progress{display:none}",
      ".vf-progress.on{display:block;margin:6px 0}",
      ".vf-progress-text{font-size:11px;margin-bottom:3px}",
      ".vf-progress-bar{height:4px;background:rgba(255,255,255,0.08)}",
      ".vf-progress-fill{height:100%;background:var(--fk-accent);transition:width .15s linear}",
      ".vf-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}",
      ".vf-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center}"
    ].join("");
    document.head.appendChild(s);
  }

  /* ---- selfcheck ----------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "CAPABILITY IS REPORTED HONESTLY", critical: false, run: async function () {
        var c = files.capabilities();
        if (typeof c.available !== "boolean") throw new Error("available is not a boolean");
        if (c.available && !c.chunkBytes) throw new Error("available but no chunk size");
        /* The banner must never claim durable storage on the local
           transport — that is the claim that would cost someone a
           file they thought was backed up. */
        if (c.transport === "local" && c.durable) {
          throw new Error("local transport reported as durable storage");
        }
        return c.available ? (c.transport + ", " + fmt(c.chunkBytes) + " chunks") : "unavailable";
      } },

      { name: "ADVICE STEERS SOURCE FILES TO GIT", critical: false, run: async function () {
        var scene = files.advise("level_01.tscn", 40 * 1024);
        if (!/git/i.test(scene.text)) throw new Error(".tscn was not pointed at Git");
        var blend = files.advise("character.blend", 80 * 1024 * 1024);
        if (blend.level !== "ok") throw new Error(".blend should be a fine thing to store");
        var imp = files.advise("tree.png.import", 900);
        if (!/gitignore/i.test(imp.text)) throw new Error(".import was not flagged as derived");
        return "tscn→git, blend→vault, import→ignore";
      } },

      { name: "CLASSIFICATION COVERS THE TOOLCHAIN", critical: false, run: async function () {
        var want = {
          "player.gd": "gdscript", "world.tscn": "godot-scene", "mat.tres": "godot-res",
          "rock.blend": "blender", "rock.glb": "model", "albedo.png": "texture",
          "step.wav": "audio", "notes.md": "doc"
        };
        var bad = [];
        Object.keys(want).forEach(function (n) {
          var got = files.classify(n).kind;
          if (got !== want[n]) bad.push(n + "→" + got);
        });
        if (bad.length) throw new Error("misclassified: " + bad.join(", "));
        return Object.keys(want).length + " extensions correct";
      } },

      { name: "A ROUND TRIP SURVIVES CHUNKING", critical: true, run: async function () {
        var c = files.capabilities();
        if (!c.available) throw new Error("SKIPPED — no blob transport in this session");

        /* Deliberately larger than one chunk would be if the chunk
           size were small — but the real chunk size is 4 MB, so
           this exercises the single-chunk path plus the manifest,
           hash and delete paths without moving megabytes during a
           self-test. The multi-chunk path is covered on the drive
           in tests/files.test.js. */
        var bytes = new Uint8Array(64 * 1024);
        window.crypto.getRandomValues(bytes);
        var name = "selftest-" + Math.random().toString(36).slice(2, 8) + ".bin";
        var file = new File([bytes], name, { type: "application/octet-stream" });

        var up = await files.upload(file, { note: "created by the system exercise" });
        api.sandbox.track(up.id);

        var v = await files.verify(up.id);
        if (!v.ok) throw new Error("freshly uploaded file failed verification");

        var back = await files.download(up.id);
        var got = new Uint8Array(await back.arrayBuffer());
        if (got.length !== bytes.length) {
          throw new Error("round trip changed the length: " + bytes.length + " → " + got.length);
        }
        for (var i = 0; i < got.length; i++) {
          if (got[i] !== bytes[i]) throw new Error("round trip corrupted byte " + i);
        }

        await files.remove(up.id);
        return "64 KB sealed, stored, verified, rebuilt byte-for-byte, deleted";
      } },

      { name: "A MISSING CHUNK FAILS LOUDLY", critical: true, run: async function () {
        var c = files.capabilities();
        if (!c.available) throw new Error("SKIPPED — no blob transport in this session");

        var file = new File([new Uint8Array(4096)], "gap-test.bin");
        var up = await files.upload(file, {});
        api.sandbox.track(up.id);

        /* Delete the chunk out from under the manifest. This is the
           real failure mode — a purge that went too far, a restore
           that brought records back but not blobs. It must not
           produce a silently truncated file. */
        var t = ctx.store.transport();
        await t.deleteBlob(up.manifest.chunks[0].key);

        var threw = null;
        try { await files.download(up.id); }
        catch (e) { threw = e; }
        await files.remove(up.id);

        if (!threw) throw new Error("a file with a missing chunk downloaded anyway");
        if (!/missing/i.test(threw.message)) {
          throw new Error("error did not say the chunk was missing: " + threw.message);
        }
        if (!/1 of 1/.test(threw.message)) {
          throw new Error("error did not name which chunk: " + threw.message);
        }
        return "refuses to rebuild, and names the chunk";
      } },

      { name: "ORPHAN SEARCH REFUSES A PARTIAL VIEW", critical: true, run: async function () {
        /* The dangerous case: offline, cache holds three records,
           and every chunk of every unloaded file looks orphaned.
           The natural next click deletes them. It must refuse. */
        if (ctx.store.canReadHistory()) {
          throw new Error("SKIPPED — record history is fully loaded in this session");
        }
        var threw = null;
        try { await files.orphans(); } catch (e) { threw = e; }
        if (!threw) throw new Error("orphan search ran against a partial record list");
        return "refuses without the full record list";
      } }
    ];
  }

  FieldKit.register("vault-files", {
    group: "FILES",
    about: "Large encrypted files stored on the relay: builds, art, recordings",
    keywords: "files upload download storage blobs large encrypted drive",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "VAULT FILES",
    icon: "▤",
    width: 940,
    height: 640,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      files = FieldKit.need("files");
      injectCSS();

      nodes.caps = el("div");
      nodes.usage = el("div");
      nodes.pending = el("div");
      nodes.progress = el("div", { class: "vf-progress" });
      nodes.list = el("div");
      nodes.kinds = el("div", { class: "vf-chips" });

      nodes.input = el("input", { type: "file", multiple: true, style: "display:none" });
      nodes.input.addEventListener("change", function (e) {
        onPicked(e.target.files);
        e.target.value = "";       // so picking the same file twice re-fires
      });

      nodes.pick = ui.button("CHOOSE FILES", function () { nodes.input.click(); }, { primary: true });
      nodes.uploadBtn = ui.button("ENCRYPT AND STORE", doUpload, { primary: true });

      nodes.drop = el("div", { class: "vf-drop", text: "CHOOSE FILES, OR DRAG THEM ONTO THIS PANEL" });
      ["dragenter", "dragover"].forEach(function (ev) {
        nodes.drop.addEventListener(ev, function (e) {
          e.preventDefault(); nodes.drop.classList.add("over");
        });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        nodes.drop.addEventListener(ev, function (e) {
          e.preventDefault(); nodes.drop.classList.remove("over");
        });
      });
      nodes.drop.addEventListener("drop", function (e) {
        if (e.dataTransfer && e.dataTransfer.files) onPicked(e.dataTransfer.files);
      });

      nodes.tags = el("input", { class: "fk-input", placeholder: "comma, separated, tags" });
      nodes.note = el("input", { class: "fk-input", placeholder: "what this is, and why it is here" });
      nodes.project = el("select", { class: "fk-input" });
      nodes.project.appendChild(el("option", { value: "", text: "— no project —" }));
      try {
        var projects = FieldKit.service("projects");
        if (projects) {
          var all = await projects.list();
          all.forEach(function (p) {
            nodes.project.appendChild(el("option", { value: p.id, text: p.data.name }));
          });
        }
      } catch (e) { ctx.warn("could not list projects: " + e.message); }

      nodes.search = el("input", { class: "fk-input", placeholder: "SEARCH STORED FILES",
        oninput: function (e) { filter = e.target.value; renderList(); } });

      host.appendChild(el("div", { class: "vf-wrap" }, [
        nodes.caps,
        nodes.usage,
        ui.panel("ADD FILES", [
          nodes.drop,
          el("div", { class: "vf-tools" }, [nodes.pick, nodes.input]),
          el("div", { class: "vf-grid" }, [
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "PROJECT" }), nodes.project]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "TAGS" }), nodes.tags]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "NOTE" }), nodes.note])
          ]),
          nodes.pending,
          nodes.progress
        ]),
        ui.panel("STORED", [
          nodes.search, nodes.kinds, nodes.list,
          el("div", { class: "vf-tools" }, [
            ui.button("REFRESH", load),
            ui.button("FIND ORPHANED CHUNKS", findOrphans)
          ])
        ])
      ]));

      renderCaps();
      await load();

      offs.push(ctx.on("store:state", function () { renderCaps(); renderUsage(); }));
    },

    unmount() {
      offs.forEach(function (f) { try { f(); } catch (e) {} });
      offs = [];
      nodes = {}; rows = []; pending = null; busy = false; filter = ""; kindFilter = "";
    },

    searchIndex() {
      return rows.map(function (r) {
        return {
          id: r.id, module: "vault-files",
          title: r.data.name,
          body: [r.data.note, r.data.kind].concat(r.data.tags || []).join(" ")
        };
      });
    }
  });
})(window.FieldKit);
