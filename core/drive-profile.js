/* ============================================================
   FieldKit :: drive-profile
   Settings that travel with the stick instead of with the machine.

   THE PROBLEM. Everything in core/settings.js lives in
   localStorage, which belongs to the browser profile on one PC.
   Plug the drive into a machine you have not used before and the
   relay URL is gone, your display name is gone, the theme is gone
   — you set it all up again, at exactly the moment you least want
   to (a borrowed laptop, twenty minutes before you need the
   notes). The drive is the thing you carry; it should be the thing
   that remembers.

   WHY IT IS A SCRIPT AND NOT A JSON FILE. `fetch()` and
   XMLHttpRequest are both blocked on `file://` (§2C), so the app
   cannot read a file sitting beside it. A classic <script src> is
   the one thing that does work — the same fact the whole module
   loader is built on. So the profile is a script that assigns a
   global, listed in FK_OPTIONAL_MANIFEST where a missing file is
   the normal state rather than a fault.

   WRITING IT BACK is the half the browser makes awkward. Two
   routes, tried in order:
     1. showSaveFilePicker(), if this browser allows it here. Writes
        straight to the drive.
     2. An ordinary download, and the user drops the file into
        config/ themselves.
   Neither is guaranteed on a locked-down machine, so save() reports
   which one happened rather than claiming success.

   WHAT MUST NEVER GO IN IT. No passwords, no vault tokens, no
   recovery key, no messaging auth secret. The drive is the thing
   most likely to be lost, and a profile carrying a credential
   would turn losing it from "annoying" into "they have everything".
   PORTABLE below is a whitelist, not a filter, and
   tests/drive-profile.test.js asserts nothing else gets through.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var FILE = "config/drive-profile.js";
  var VERSION = 1;

  /* A whitelist, deliberately. A blacklist would mean every new
     setting is portable until someone remembers it should not be,
     and the failure mode of forgetting is a credential on a stick. */
  var PORTABLE = [
    "relayUrl",        // where the vault lives. Not a credential by itself.
    "displayName",     // who you are on a shared vault
    "theme", "crt", "ambient", "sound", "wallpaper", "bootFlavor",
    "perfMode",
    "pullSeconds", "autoLockMinutes",
    "backupReminderDays", "autoSnapshotMinutes", "autoSnapshotKeep",
    "msgHandle"        // messaging account name. The secret is NOT here.
  ];

  /* Belt and braces over the whitelist: even if one of the names
     above is ever reused for something sensitive, a value that
     looks like a credential does not travel. */
  var FORBIDDEN_KEY = /pass|secret|token|key$|recovery|auth/i;

  var loaded = null;      // what came off the drive this boot
  var applied = [];       // which settings it actually set

  function fromDrive() {
    var p = window.FK_DRIVE_PROFILE;
    if (!p || typeof p !== "object") return null;
    return p;
  }

  /* Values the drive supplies are a starting point, not an
     override. If this machine has its own setting for something,
     the machine wins — someone who turned effects off on a slow
     laptop meant it, and having the stick undo that every launch
     would be worse than not remembering at all.

     The exception is a setting the machine has never been told
     about, which is the entire case this exists for. */
  function apply() {
    var p = fromDrive();
    loaded = p;
    applied = [];
    if (!p) return { loaded: false, applied: [] };

    var settings = FieldKit.service("settings");
    if (!settings) return { loaded: true, applied: [], error: "settings service not up yet" };

    var values = p.settings || {};
    Object.keys(values).forEach(function (k) {
      if (PORTABLE.indexOf(k) < 0) return;
      if (FORBIDDEN_KEY.test(k)) return;
      if (settings.isSetLocally && settings.isSetLocally(k)) return;   // this machine decided already
      try {
        settings.set(k, values[k], { fromDrive: true });
        applied.push(k);
      } catch (e) {
        FieldKit.log("warn", "drive-profile", "could not apply " + k + ": " + e.message);
      }
    });

    FieldKit.log("info", "drive-profile",
      "drive profile v" + (p.version || "?") + ": applied " + applied.length + " setting(s)");
    return { loaded: true, applied: applied, savedAt: p.savedAt || null, label: p.label || null };
  }

  /* ---- writing -------------------------------------------------- */
  function collect(extra) {
    var settings = FieldKit.need("settings");
    var values = {};
    PORTABLE.forEach(function (k) {
      if (FORBIDDEN_KEY.test(k)) return;
      var v = settings.get(k);
      if (v === undefined || v === null || v === "") return;
      values[k] = v;
    });
    Object.keys(extra || {}).forEach(function (k) {
      if (PORTABLE.indexOf(k) >= 0 && !FORBIDDEN_KEY.test(k)) values[k] = extra[k];
    });
    return values;
  }

  function serialise(extra) {
    var body = {
      version: VERSION,
      savedAt: new Date().toISOString(),
      label: (FieldKit.service("settings") &&
        FieldKit.service("settings").get("displayName")) || "",
      settings: collect(extra)
    };

    /* A comment block at the top because this file will be opened by
       a person at some point — most likely because something went
       wrong — and it should explain itself without them having to
       find the docs. */
    return [
      "/* FieldKit drive profile — written by SETTINGS -> SAVE TO DRIVE.",
      "   Lives at " + FILE + " and travels with the stick, so a machine",
      "   you have never used before comes up already configured.",
      "",
      "   Safe to read, safe to edit, safe to delete: it holds no password,",
      "   no vault token and no recovery key, and deleting it only means the",
      "   next new machine starts from defaults.",
      "",
      "   Saved " + body.savedAt + " */",
      "window.FK_DRIVE_PROFILE = " + JSON.stringify(body, null, 2) + ";",
      ""
    ].join("\n");
  }

  /* Returns how it went, never a bare boolean. On a machine where
     both routes are blocked the honest answer is "neither worked",
     and a caller that got `true` would tell the user their settings
     were saved when they were not. */
  async function save(extra) {
    var text = serialise(extra);
    var ui = FieldKit.service("ui");

    if (typeof window.showSaveFilePicker === "function") {
      try {
        var handle = await window.showSaveFilePicker({
          suggestedName: "drive-profile.js",
          types: [{ description: "FieldKit drive profile", accept: { "text/javascript": [".js"] } }]
        });
        var w = await handle.createWritable();
        await w.write(text);
        await w.close();
        return { ok: true, how: "picker", detail: "written straight to the drive" };
      } catch (e) {
        if (e && e.name === "AbortError") {
          return { ok: false, how: "cancelled", detail: "you closed the save dialog" };
        }
        FieldKit.log("warn", "drive-profile", "save picker failed: " + e.message);
        /* Fall through to the download. A blocked picker is the
           normal case on a managed machine, not an error worth
           stopping for. */
      }
    }

    if (ui && ui.download) {
      try {
        ui.download("drive-profile.js", text, "text/javascript");
        return { ok: true, how: "download",
          detail: "downloaded — move it into " + FILE + " on the drive" };
      } catch (e) {
        return { ok: false, how: "blocked", detail: e.message };
      }
    }
    return { ok: false, how: "blocked", detail: "no way to write a file on this machine" };
  }

  function status() {
    return {
      file: FILE,
      loaded: !!loaded,
      applied: applied.slice(),
      savedAt: loaded && loaded.savedAt,
      label: loaded && loaded.label,
      canWriteDirectly: typeof window.showSaveFilePicker === "function"
    };
  }

  FieldKit.provide("driveProfile", {
    FILE: FILE,
    PORTABLE: PORTABLE,
    apply: apply,
    save: save,
    status: status,
    serialise: serialise,
    collect: collect
  });
})(window.FieldKit);
