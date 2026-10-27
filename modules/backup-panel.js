/* ============================================================
   FieldKit :: backup-panel
   Where you take a backup and where you put one back (§7).

   Three operations, in descending order of how often you want them:
     EXPORT    write an encrypted archive you can keep anywhere
     INSPECT   open an archive and see what is in it, without
               committing to anything
     MERGE     pull an archive's records into the open vault

   The fourth, restoring into a dead relay's replacement, happens at
   the boot gate rather than here — by the time you need it there is
   no vault to open and no desktop to open it from.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var loaded = null;       // { archive, check, describe, sameVault }

  function backup() { return FieldKit.need("backup"); }

  /* ---- export --------------------------------------------------- */
  async function doExport() {
    nodes.exportBtn.disabled = true;
    nodes.exportBtn.textContent = "BUILDING...";
    try {
      var archive = await backup().build();
      var name = backup().download(archive);
      var d = backup().describe(archive);
      ui.toast("ARCHIVE WRITTEN — " + d.records + " RECORD(S)", "ok");
      renderStatus();
      showResult([
        { label: "FILE", value: name, level: "ok" },
        { label: "RECORDS", value: String(d.records) },
        { label: "CONTENTS", value: d.typeSummary || "(empty vault)", level: "dim" },
        { label: "SIZE", value: Math.round(d.sizeHint / 1024) + " KB", level: "dim" },
        { label: "STATE", value: "ENCRYPTED — OPENS ONLY WITH YOUR PASSWORD", level: "ok" }
      ]);
    } catch (e) {
      ui.toast("EXPORT FAILED: " + e.message, "fail");
      showResult([{ label: "EXPORT FAILED", value: e.message, level: "fail" }]);
    } finally {
      nodes.exportBtn.disabled = false;
      nodes.exportBtn.textContent = "EXPORT ENCRYPTED ARCHIVE";
    }
  }

  /* The dangerous one. Two confirmations, and the second makes you
     type the word — a misclick must not be able to write your notes
     to disk in the clear. */
  async function doPlaintextExport() {
    if (!confirm(
      "Export EVERYTHING as readable, unencrypted text?\n\n" +
      "This is not a backup. It is for moving your notes out of FieldKit.\n" +
      "Anyone who opens the file can read all of it.")) return;

    var typed = prompt("Type UNENCRYPTED to confirm:");
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== "UNENCRYPTED") {
      ui.toast("CANCELLED — CONFIRMATION DID NOT MATCH", "warn");
      return;
    }

    try {
      var plain = await backup().buildPlaintext();
      var blob = new Blob([JSON.stringify(plain, null, 1)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: "fieldkit-PLAINTEXT-" +
        plain.createdAt.replace(/[:.]/g, "-").slice(0, 19) + ".json" });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 6000);
      ui.toast("PLAINTEXT EXPORT WRITTEN — HANDLE IT CAREFULLY", "warn");
      showResult([
        { label: "RECORDS", value: String(plain.records.length) },
        { label: "STATE", value: "NOT ENCRYPTED — ANYONE CAN READ IT", level: "fail" }
      ]);
    } catch (e) {
      ui.toast("EXPORT FAILED: " + e.message, "fail");
    }
  }

  /* ---- inspect -------------------------------------------------- */
  async function handleFile(file) {
    if (!file) return;
    loaded = null;
    renderLoaded();
    try {
      var text = await backup().readFile(file);
      var archive = backup().parse(text);
      var check = await backup().verify(archive);
      var d = backup().describe(archive);
      var same = backup().sameVaultAs(archive, ctx.store.header());
      loaded = { archive: archive, check: check, describe: d, sameVault: same, filename: file.name };
      renderLoaded();
      ui.toast(check.ok ? "ARCHIVE LOADED — " + d.records + " RECORD(S)"
        : "ARCHIVE LOADED WITH WARNINGS", check.ok ? "ok" : "warn");
    } catch (e) {
      loaded = null;
      renderLoaded();
      showResult([{ label: "COULD NOT READ ARCHIVE", value: e.message, level: "fail" }]);
      ui.toast("COULD NOT READ ARCHIVE", "fail");
    }
  }

  async function doMerge(overwrite) {
    if (!loaded) return;
    if (!loaded.sameVault) {
      ui.toast("DIFFERENT VAULT — CANNOT MERGE", "fail");
      return;
    }
    if (!confirm(overwrite
      ? "Overwrite matching records with the archive's versions?"
      : "Merge this archive into the open vault?\n\nOnly missing or newer records are written.")) return;

    nodes.mergeBtn.disabled = true;
    nodes.overwriteBtn.disabled = true;
    try {
      var r = await backup().mergeIntoOpenVault(loaded.archive, { overwrite: overwrite });
      ui.toast("MERGED " + r.written + " RECORD(S)", "ok");
      showResult([
        { label: "IN ARCHIVE", value: String(r.inArchive) },
        { label: "ALREADY PRESENT", value: String(r.alreadyPresent), level: "dim" },
        { label: "WRITTEN", value: String(r.written), level: r.written ? "ok" : "dim" }
      ]);
    } catch (e) {
      ui.toast("MERGE FAILED: " + e.message, "fail");
      showResult([{ label: "MERGE FAILED", value: e.message, level: "fail" }]);
    } finally {
      nodes.mergeBtn.disabled = false;
      nodes.overwriteBtn.disabled = false;
    }
  }

  /* ---- local snapshots ------------------------------------------
     The ring core/backup.js keeps in IndexedDB. Presented as what it
     is: a free second copy that survives the relay dying, and does
     not survive this browser profile being wiped. */
  async function renderSnapshots() {
    if (!nodes.snaps) return;
    ui.clear(nodes.snaps);
    var list = await backup().listSnapshots();

    var mins = Number(ctx.settings.get("autoSnapshotMinutes"));
    nodes.snaps.appendChild(ui.readout([
      { label: "AUTOMATIC", value: mins ? "every " + mins + " min after a change" : "OFF",
        level: mins ? "ok" : "warn" },
      { label: "KEEPING", value: backup().snapshotKeepCount() + " most recent", level: "dim" },
      { label: "HELD NOW", value: list.length
          ? list.length + " (newest " + new Date(list[0].at).toLocaleString() + ")"
          : "NONE YET",
        level: list.length ? "ok" : "warn" }
    ]));

    if (!list.length) {
      nodes.snaps.appendChild(el("div", { class: "bk-none", text: "NO SNAPSHOTS YET" }));
    } else {
      var rows = el("div", { class: "bk-snaps" });
      list.forEach(function (s) {
        rows.appendChild(el("div", { class: "bk-snap" }, [
          el("div", { class: "bk-snap-when", text: new Date(s.at).toLocaleString() }),
          el("div", { class: "bk-snap-meta", text:
            s.records + " rec · " + Math.round(s.bytes / 1024) + " KB · " + s.reason }),
          ui.button("SAVE TO FILE", function () { saveSnapshot(s.at); }),
          ui.button("LOAD", function () { loadSnapshot(s.at); })
        ]));
      });
      nodes.snaps.appendChild(rows);
    }

    nodes.snaps.appendChild(el("p", { class: "bk-warn", text:
      "Snapshots live in this browser's storage on this machine. They survive the relay being " +
      "lost. They do not survive the profile being cleared or the Chromebook being reset — for " +
      "that you still want a file on the drive." }));
  }

  async function saveSnapshot(at) {
    try {
      var archive = await backup().getSnapshot(at);
      if (!archive) throw new Error("snapshot is no longer there");
      var name = backup().download(archive);
      ui.toast("SNAPSHOT WRITTEN — " + name, "ok");
      renderStatus();
    } catch (e) {
      ui.toast("COULD NOT SAVE SNAPSHOT: " + e.message, "fail");
    }
  }

  /* Loads it into the same slot a file would occupy, so INSPECT and
     MERGE work on a snapshot exactly as they do on an archive. */
  async function loadSnapshot(at) {
    try {
      var archive = await backup().getSnapshot(at);
      if (!archive) throw new Error("snapshot is no longer there");
      var check = await backup().verify(archive);
      loaded = {
        archive: archive, check: check, describe: backup().describe(archive),
        sameVault: backup().sameVaultAs(archive, ctx.store.header()),
        filename: "local snapshot · " + new Date(at).toLocaleString()
      };
      renderLoaded();
      ui.toast("SNAPSHOT LOADED — " + loaded.describe.records + " RECORD(S)",
        check.ok ? "ok" : "warn");
    } catch (e) {
      ui.toast("COULD NOT LOAD SNAPSHOT: " + e.message, "fail");
    }
  }

  async function takeSnapshotNow() {
    nodes.snapBtn.disabled = true;
    nodes.snapBtn.textContent = "SNAPSHOTTING...";
    try {
      var entry = await backup().takeSnapshot("manual");
      if (!entry) throw new Error("snapshot storage is unavailable here");
      ui.toast("SNAPSHOT TAKEN — " + entry.records + " RECORD(S)", "ok");
      await renderSnapshots();
    } catch (e) {
      ui.toast("SNAPSHOT FAILED: " + e.message, "fail");
    } finally {
      nodes.snapBtn.disabled = false;
      nodes.snapBtn.textContent = "SNAPSHOT NOW";
    }
  }

  /* ---- render --------------------------------------------------- */
  function showResult(rows) {
    ui.clear(nodes.result);
    nodes.result.appendChild(ui.readout(rows));
  }

  function renderStatus() {
    ui.clear(nodes.status);
    var last = backup().lastBackupAt();
    var rem = backup().reminder();
    var days = last ? Math.floor((Date.now() - last) / 86400000) : null;

    nodes.status.appendChild(ui.readout([
      { label: "VAULT", value: ctx.store.state() + " via " + ctx.store.transportName(),
        level: ctx.store.state() === "ONLINE" ? "ok" : "warn" },
      { label: "LAST BACKUP", value: last
          ? new Date(last).toLocaleString() + "  (" + (days === 0 ? "today" : days + " day(s) ago") + ")"
          : "NEVER",
        level: !last ? "fail" : (rem ? "warn" : "ok") },
      { label: "REMINDER", value: (function () {
          var d = ctx.settings.get("backupReminderDays");
          return d ? "every " + d + " day(s)" : "off";
        })(), level: "dim" }
    ]));

    if (ctx.store.state() !== "ONLINE") {
      nodes.status.appendChild(el("div", { class: "bk-warn", text:
        "Offline. An export can only include what the current transport holds — connect to the " +
        "relay first if you want a complete archive." }));
    }
  }

  function renderLoaded() {
    ui.clear(nodes.loaded);
    if (!loaded) {
      nodes.loaded.appendChild(el("div", { class: "bk-none", text: "NO ARCHIVE LOADED" }));
      nodes.mergeBtn.disabled = true;
      nodes.overwriteBtn.disabled = true;
      return;
    }

    var d = loaded.describe;
    nodes.loaded.appendChild(ui.readout([
      { label: "FILE", value: loaded.filename, level: "dim" },
      { label: "CREATED", value: new Date(d.createdAt).toLocaleString() },
      { label: "BUILT BY", value: "FieldKit v" + (d.appVersion || "?"), level: "dim" },
      { label: "RECORDS", value: String(d.records) },
      { label: "CONTENTS", value: d.typeSummary || "(none)", level: "dim" },
      { label: "INTEGRITY", value: loaded.check.intact ? "CHECKSUM OK" : "CHECKSUM MISMATCH",
        level: loaded.check.intact ? "ok" : "fail" },
      { label: "VAULT", value: loaded.sameVault ? "SAME AS THIS ONE" : "A DIFFERENT VAULT",
        level: loaded.sameVault ? "ok" : "warn" }
    ]));

    loaded.check.issues.forEach(function (msg) {
      nodes.loaded.appendChild(el("div", { class: "bk-warn", text: msg }));
    });

    if (!loaded.sameVault) {
      nodes.loaded.appendChild(el("div", { class: "bk-warn", text:
        "This archive was made from a different vault, so its records cannot be decrypted with " +
        "the password currently open. To restore it, point FieldKit at an empty relay and use " +
        "RESTORE FROM ARCHIVE on the boot screen, then unlock with that archive's password." }));
    }

    nodes.mergeBtn.disabled = !loaded.sameVault || !loaded.check.intact;
    nodes.overwriteBtn.disabled = !loaded.sameVault || !loaded.check.intact;
  }

  /* ---- probes --------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "ARCHIVE ROUND TRIP", critical: true, run: async function () {
        var probe = await api.sandbox.put(api.probeType, { marker: "backup-probe", n: Math.random() });
        var archive = await backup().build();
        if (!archive.records.some(function (r) { return r.id === probe.id; })) {
          throw new Error("the probe record is missing from the archive");
        }
        var round = backup().parse(JSON.stringify(archive));
        var check = await backup().verify(round);
        if (!check.intact) throw new Error("checksum failed after a round trip: " + check.issues.join("; "));
        return archive.records.length + " record(s), checksum verified";
      } },

      /* The property the whole feature rests on. */
      { name: "ARCHIVE CONTAINS NO PLAINTEXT", critical: true, run: async function () {
        var marker = "PLAINTEXT-CANARY-" + Math.random().toString(36).slice(2, 12);
        var probe = await api.sandbox.put(api.probeType, { secret: marker });
        var archive = await backup().build();
        var raw = JSON.stringify(archive);
        if (raw.indexOf(marker) >= 0) throw new Error("the canary appeared in the archive in the clear");
        if (raw.indexOf(probe.id) < 0) throw new Error("the probe record is not in the archive at all");
        return "a canary written just now is not readable anywhere in the archive";
      } },

      { name: "PROVISION TOKEN IS NEVER EXPORTED", critical: true, run: async function () {
        var s = ctx.settings;
        var was = s.get("relayProvisionToken");
        var canary = "TOKEN-CANARY-" + Math.random().toString(36).slice(2, 10);
        s.set("relayProvisionToken", canary);
        try {
          var archive = await backup().build();
          if (JSON.stringify(archive).indexOf(canary) >= 0) {
            throw new Error("the provision token was written into the archive");
          }
          if (!archive.settings) throw new Error("settings were not included at all — check the test, not the code");
          return "settings exported, token stripped";
        } finally {
          s.set("relayProvisionToken", was === undefined ? "" : was);
        }
      } },

      { name: "TAMPERING IS DETECTED", critical: true, run: async function () {
        var archive = await backup().build();
        var clone = JSON.parse(JSON.stringify(archive));
        if (!clone.records.length) {
          /* Nothing to corrupt — corrupt the header instead. */
          clone.vault.kdf.iterations = (clone.vault.kdf.iterations || 1000) + 1;
        } else {
          clone.records[0].box.ct = "AAAA" + String(clone.records[0].box.ct).slice(4);
        }
        var check = await backup().verify(clone);
        if (check.intact) throw new Error("an altered archive still passed verification");
        return "altered archive rejected: " + check.issues[0];
      } },

      { name: "A FOREIGN ARCHIVE IS REFUSED", critical: true, run: async function () {
        var archive = await backup().build();
        var foreign = JSON.parse(JSON.stringify(archive));
        foreign.vault = Object.assign({}, foreign.vault, { authKeyHash: "someone-elses-vault" });
        if (backup().sameVaultAs(foreign, ctx.store.header())) {
          throw new Error("a different vault was treated as the same one");
        }
        var threw = null;
        try { await backup().mergeIntoOpenVault(foreign, {}); }
        catch (e) { threw = e.message; }
        if (!threw) throw new Error("merging a foreign archive was allowed");
        return "refused: " + api.preview(threw, 48);
      } },

      { name: "GARBAGE IS REJECTED CLEANLY", critical: false, run: async function () {
        var cases = [
          ["not json at all", /JSON/],
          ['{"format":"something-else"}', /not a FieldKit archive/],
          ['{"format":"fieldkit-archive","v":99,"vault":{"kdf":{},"wrap":{}},"records":[]}', /newer/],
          ['{"format":"fieldkit-archive","v":1,"records":[]}', /vault header/],
          ['{"format":"fieldkit-archive","v":1,"vault":{"kdf":{},"wrap":{}}}', /record list/]
        ];
        for (var i = 0; i < cases.length; i++) {
          var threw = null;
          try { backup().parse(cases[i][0]); } catch (e) { threw = e.message; }
          if (!threw) throw new Error("case " + i + " was accepted");
          if (!cases[i][1].test(threw)) throw new Error("case " + i + " gave an unhelpful error: " + threw);
        }
        return cases.length + " malformed inputs, each with a specific message";
      } },

      { name: "MERGE IS IDEMPOTENT", critical: false, run: async function () {
        var probe = await api.sandbox.put(api.probeType, { marker: "merge-probe" });
        var archive = await backup().build();
        var first = await backup().mergeIntoOpenVault(archive, {});
        var second = await backup().mergeIntoOpenVault(archive, {});
        if (second.written !== 0) {
          throw new Error("merging the same archive twice wrote " + second.written + " record(s) the second time");
        }
        void probe; void first;
        return "second merge wrote nothing, as it should";
      } },

      { name: "LOCAL SNAPSHOT RING", critical: false, run: async function () {
        var snaps = FieldKit.service("snapshots");
        if (!snaps || !snaps.available) return "SKIPPED — no snapshot storage on this platform";
        var probe = await api.sandbox.put(api.probeType, { marker: "snapshot-probe" });
        var entry = await backup().takeSnapshot("selftest");
        if (!entry) return "SKIPPED — snapshots do not apply in this session";
        try {
          var back = await backup().getSnapshot(entry.at);
          if (!back) throw new Error("the snapshot could not be read back");
          if (!back.records.some(function (r) { return r.id === probe.id; })) {
            throw new Error("the probe record is missing from the snapshot");
          }
          if (!(await backup().verify(back)).intact) throw new Error("the stored snapshot does not verify");
          return entry.records + " record(s) stored and read back, checksum verified";
        } finally {
          await snaps.remove(entry.at);
        }
      } },

      { name: "SNAPSHOTS ARE SEALED AT REST", critical: true, run: async function () {
        var snaps = FieldKit.service("snapshots");
        if (!snaps || !snaps.available) return "SKIPPED — no snapshot storage on this platform";
        var marker = "SNAPSHOT-CANARY-" + Math.random().toString(36).slice(2, 12);
        await api.sandbox.put(api.probeType, { secret: marker });
        var entry = await backup().takeSnapshot("selftest");
        if (!entry) return "SKIPPED — snapshots do not apply in this session";
        try {
          var stored = await snaps.get(entry.at);
          if (JSON.stringify(stored).indexOf(marker) >= 0) {
            throw new Error("a canary written just now is readable in stored snapshot data");
          }
          return "a canary is not readable anywhere in what IndexedDB holds";
        } finally {
          await snaps.remove(entry.at);
        }
      } },

      /* Deliberately observational. Filling the ring to prove it
         prunes would delete the user's real snapshots, which is the
         one thing a diagnostic must not do to a safety net. */
      { name: "THE RING IS WITHIN ITS LIMIT", critical: false, run: async function () {
        var snaps = FieldKit.service("snapshots");
        if (!snaps || !snaps.available) return "SKIPPED — no snapshot storage on this platform";
        var keep = backup().snapshotKeepCount();
        var list = await backup().listSnapshots();
        if (list.length > keep) {
          throw new Error("holding " + list.length + " snapshots with a limit of " + keep +
            " — pruning is not running");
        }
        var ordered = list.every(function (s, i) { return i === 0 || list[i - 1].at > s.at; });
        if (!ordered) throw new Error("snapshots are not listed newest-first");
        var unique = new Set(list.map(function (s) { return s.at; })).size === list.length;
        if (!unique) throw new Error("two snapshots share a timestamp — one has overwritten another");
        return list.length + " of a maximum " + keep + ", newest first, no collisions";
      } },

      { name: "STATUS RENDERS", critical: false, run: async function () {
        renderStatus();
        if (!/LAST BACKUP/.test(nodes.status.textContent)) throw new Error("status did not render");
        return nodes.status.textContent.replace(/\s+/g, " ").trim().slice(0, 56);
      } }
    ];
  }

  FieldKit.register("backup-panel", {
    group: "FILES",
    about: "Take an encrypted backup of everything, or restore one",
    keywords: "backup restore export import archive snapshot",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "BACKUP",
    icon: "⛁",
    width: 720,
    height: 620,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.status = el("div");
      nodes.result = el("div");
      nodes.loaded = el("div");
      nodes.snaps = el("div");

      nodes.exportBtn = ui.button("EXPORT ENCRYPTED ARCHIVE", doExport, { primary: true });
      nodes.snapBtn = ui.button("SNAPSHOT NOW", takeSnapshotNow);
      nodes.mergeBtn = ui.button("MERGE INTO THIS VAULT", function () { doMerge(false); }, { primary: true });
      nodes.overwriteBtn = ui.button("OVERWRITE MATCHING", function () { doMerge(true); }, { danger: true });

      var fileInput = el("input", { type: "file", accept: ".json,application/json",
        style: { display: "none" },
        onchange: function (e) { handleFile(e.target.files[0]); e.target.value = ""; } });

      var reminderSel = el("select", { class: "fk-input bk-select" });
      [["0", "NEVER"], ["7", "EVERY 7 DAYS"], ["14", "EVERY 14 DAYS"], ["30", "EVERY 30 DAYS"]]
        .forEach(function (o) {
          reminderSel.appendChild(el("option", { value: o[0], text: o[1],
            selected: String(ctx.settings.get("backupReminderDays")) === o[0] ? true : null }));
        });
      reminderSel.addEventListener("change", function () {
        ctx.settings.set("backupReminderDays", Number(reminderSel.value));
        renderStatus();
      });

      var snapSel = el("select", { class: "fk-input bk-select" });
      [["0", "OFF"], ["10", "EVERY 10 MIN"], ["30", "EVERY 30 MIN"], ["120", "EVERY 2 HOURS"]]
        .forEach(function (o) {
          snapSel.appendChild(el("option", { value: o[0], text: o[1],
            selected: String(ctx.settings.get("autoSnapshotMinutes")) === o[0] ? true : null }));
        });
      snapSel.addEventListener("change", function () {
        ctx.settings.set("autoSnapshotMinutes", Number(snapSel.value));
        renderSnapshots();
      });
      var snapEveryWrap = el("label", { class: "fk-field bk-snapevery" }, [
        el("span", { class: "fk-field-label", text: "AUTOMATIC" }), snapSel
      ]);

      host.appendChild(el("div", { class: "bk-wrap" }, [
        ui.panel("STATUS", [nodes.status]),

        ui.panel("EXPORT", [
          el("p", { class: "bk-note", text:
            "An archive holds the vault header and every record, still sealed. It contains no " +
            "password, no key, and no readable content — it is exactly as strong as your master " +
            "password. Keep one on the drive." }),
          el("div", { class: "bk-actions" }, [nodes.exportBtn]),
          el("label", { class: "fk-field bk-reminder" }, [
            el("span", { class: "fk-field-label", text: "REMIND ME TO BACK UP" }), reminderSel
          ])
        ]),

        ui.panel("LOCAL SNAPSHOTS", [
          el("p", { class: "bk-note", text:
            "Sealed archives kept automatically on this machine, so that losing the relay does " +
            "not depend on anyone having remembered to press EXPORT. Same contents as a file " +
            "archive, same encryption." }),
          nodes.snaps,
          el("div", { class: "bk-actions" }, [nodes.snapBtn, snapEveryWrap])
        ]),

        ui.panel("RESTORE", [
          el("p", { class: "bk-note", text:
            "Load an archive to see what is in it. Nothing is written until you say so." }),
          el("div", { class: "bk-actions" }, [
            ui.button("LOAD ARCHIVE FILE", function () { fileInput.click(); })
          ]),
          nodes.loaded,
          el("div", { class: "bk-actions" }, [nodes.mergeBtn, nodes.overwriteBtn]),
          el("p", { class: "bk-note", text:
            "MERGE writes records that are missing or newer. OVERWRITE MATCHING replaces every " +
            "record the archive also has. If the relay itself is gone, use RESTORE FROM ARCHIVE " +
            "on the boot screen instead — there is no vault to merge into at that point." }),
          fileInput
        ]),

        ui.panel("RESULT", [nodes.result]),

        ui.panel("LEAVING FIELDKIT", [
          el("p", { class: "bk-danger", text:
            "A plaintext export is not a backup. It writes everything to disk in readable form, " +
            "for moving your notes to another tool. Anyone who opens the file can read all of it." }),
          el("div", { class: "bk-actions" }, [
            ui.button("EXPORT PLAINTEXT", doPlaintextExport, { danger: true })
          ])
        ])
      ]));

      nodes.result.appendChild(el("div", { class: "bk-none", text: "NOTHING RUN YET" }));
      renderStatus();
      renderLoaded();
      renderSnapshots();
    },

    unmount() { nodes = {}; loaded = null; }
  });

  function injectCSS() {
    if (document.getElementById("bk-style")) return;
    var s = document.createElement("style");
    s.id = "bk-style";
    s.textContent = `
.bk-wrap{height:100%;overflow:auto}
.bk-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.bk-actions .fk-btn{flex:1;min-width:150px}
.bk-note{font-size:10px;color:var(--fg-dimmer);line-height:1.6;margin:0 0 4px;
  border-left:2px solid var(--line2);padding-left:9px}
.bk-danger{font-size:10px;color:var(--fail);line-height:1.6;margin:0 0 4px;
  border-left:2px solid var(--fail);padding-left:9px}
.bk-warn{font-size:10px;color:var(--warn);line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--warn);padding-left:9px}
.bk-none{padding:10px;text-align:center;color:var(--fg-dimmer);font-size:10px;letter-spacing:.16em}
.bk-select{padding:8px 9px}
.bk-reminder{margin-top:12px;margin-bottom:0}
.bk-snapevery{flex:1;min-width:150px;margin:0}
.bk-snaps{margin-top:8px;border:1px solid var(--line2)}
.bk-snap{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--line2)}
.bk-snap:last-child{border-bottom:none}
.bk-snap-when{flex:1;font-size:10px;letter-spacing:.08em}
.bk-snap-meta{color:var(--fg-dimmer);font-size:9px;letter-spacing:.1em}
.bk-snap .fk-btn{flex:0 0 auto;padding:4px 8px;font-size:9px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
