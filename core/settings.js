/* ============================================================
   FieldKit :: settings
   Non-secret preferences (theme, CRT, sound, wallpaper choice).

   These live in localStorage, not the vault, on purpose: they are
   needed *before* unlock to draw the boot screen correctly, and
   none of it is sensitive. Anything sensitive belongs in store.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var KEY = "fieldkit.settings.v1";

  var DEFAULTS = {
    theme: "amber",
    crt: false,
    sound: false,
    ambient: false,
    perfMode: "auto",        // auto | on | off
    wallpaper: null,
    bootFlavor: true,
    relayUrl: "",
    relayUrls: [],           // other addresses for a relay, tried when relayUrl does not answer (core/relay-choice.js)
    relayAskAtBoot: true,    // show the address and offer to change it before connecting
    autoLockMinutes: 0,      // 0 = never; screen lock only, see core/lockscreen.js
    backupReminderDays: 14,  // 0 = never nag; see core/backup.js
    autoSnapshotMinutes: 30, // 0 = off; local sealed snapshot ring
    autoSnapshotKeep: 3,
    /* Shared vaults. displayName is stamped inside the sealed box,
       not on the plaintext metadata — see core/store.js. It is a
       label, not a login: anyone with the password can set any name.
       pullSeconds 0 = never pull in the background, right for a
       vault only one person uses. */
    displayName: "",
    pullSeconds: 0
  };

  var data = Object.assign({}, DEFAULTS);

  /* Which keys THIS machine has actually chosen, as opposed to
     which ones are sitting on a default. The difference is invisible
     from `get()` — both answer with a value — and core/drive-profile.js
     needs it: a setting the drive carries should fill in a blank, but
     must never overwrite a decision someone made on this machine.
     Someone who turned effects off on a slow laptop meant it, and a
     stick that undid that on every launch would be worse than one
     that remembered nothing. */
  var localKeys = Object.create(null);

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var stored = JSON.parse(raw);
        Object.keys(stored).forEach(function (k) { localKeys[k] = true; });
        data = Object.assign({}, DEFAULTS, stored);
      }
    } catch (e) {
      FieldKit.log("warn", "settings", "could not read settings, using defaults: " + e.message);
    }
    return data;
  }

  function isSetLocally(k) { return !!localKeys[k]; }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { FieldKit.log("warn", "settings", "could not persist settings: " + e.message); }
    return data;
  }

  function get(k) { return typeof k === "undefined" ? Object.assign({}, data) : data[k]; }

  function set(k, v, opts) {
    data[k] = v;
    /* A value applied FROM the drive is not a decision this machine
       made, so it does not become one. Otherwise the first launch on
       a new PC would stamp every drive value as local, and the drive
       could never update any of them again. */
    if (!(opts && opts.fromDrive)) localKeys[k] = true;
    save();
    FieldKit.emit("settings:changed", { key: k, value: v });
    return v;
  }

  /* Decide whether to run heavy visuals. §10F: a 4GB Chromebook
     should not be trying to render ambient particles. */
  function perfBudget() {
    if (data.perfMode === "on") return "full";
    if (data.perfMode === "off") return "minimal";
    var cores = navigator.hardwareConcurrency || 2;
    var mem = navigator.deviceMemory || 2;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "minimal";
    if (cores <= 2 || mem <= 2) return "minimal";
    if (cores <= 4 || mem <= 4) return "reduced";
    return "full";
  }

  load();

  FieldKit.provide("settings", {
    DEFAULTS: DEFAULTS,
    get: get,
    set: set,
    all: function () { return Object.assign({}, data); },
    reset: function () { data = Object.assign({}, DEFAULTS); save(); return data; },
    perfBudget: perfBudget,
    isSetLocally: isSetLocally
  });
})(window.FieldKit);
