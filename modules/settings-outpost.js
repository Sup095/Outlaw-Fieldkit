/* ============================================================
   FieldKit :: SETTINGS (OUTPOST build)
   Appearance and behaviour, and nothing else.

   The full build's settings panel is not on this drive, and that is
   not a matter of hiding a section: most of what it does is vault
   work — change the passphrase, point at a relay, schedule snapshots.
   The screen lock is here (its own PIN and idle time, never the
   full build's autoLockMinutes). None of that exists here, so a panel with
   those controls greyed out would be a panel making promises about
   a build that cannot keep them (§14.1).

   What is left is genuinely everything an OUTPOST user needs: how it
   looks, how it sounds, how hard it works the machine, and the name
   they sign things with.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};

  /* Preferences this build is allowed to touch. Anything not on
     this list is a vault or relay setting and is left alone —
     OUTPOST shares the settings key with the full build, because a
     drive carrying both should not forget your theme depending on
     which file you opened. Writing a relay URL from here would mean
     the limited build could reconfigure the real one. */
  var OWNED = ["theme", "crt", "textSize", "contrast", "calm", "sound", "perfMode",
    "wallpaper", "bootFlavor", "displayName", "clock24", "updateCheckAtStart",
    "outpostLockMinutes", "signInAtBoot"];

  function set(key, value) {
    if (OWNED.indexOf(key) < 0) {
      throw new Error("OUTPOST does not own the '" + key + "' setting");
    }
    ctx.settings.set(key, value);
  }

  function row(label, note, control) {
    return el("div", { class: "so-row" }, [
      el("div", { class: "so-label" }, [
        el("span", { class: "so-name", text: label }),
        note ? el("span", { class: "so-note", text: note }) : el("span")
      ]),
      el("div", { class: "so-control" }, [control])
    ]);
  }

  function toggle(key, label, note) {
    var b = ui.button(ctx.settings.get(key) ? "ON" : "OFF", function () {
      var next = !ctx.settings.get(key);
      set(key, next);
      b.textContent = next ? "ON" : "OFF";
      b.classList.toggle("on", next);
      apply();
    });
    b.classList.toggle("on", !!ctx.settings.get(key));
    b.className += " so-toggle";
    return row(label, note, b);
  }

  /* Re-applied live rather than on reload, because a theme you have
     to restart to see is a theme nobody tries. */
  function apply() {
    ui.applyTheme(ctx.settings.get("theme"));
    var shell = FieldKit.service("shell");
    if (shell && shell.setWallpaper) shell.setWallpaper(ctx.settings.get("wallpaper"));
    document.body.classList.toggle("crt", !!ctx.settings.get("crt"));
    ui.applyLook(ctx.settings);
  }

  function themeGrid() {
    var wrap = el("div", { class: "so-themes" });
    Object.keys(ui.THEMES).forEach(function (id) {
      var t = ui.THEMES[id];
      var sw = el("button", {
        class: "so-theme" + (ctx.settings.get("theme") === id ? " sel" : ""),
        title: id
      }, [
        el("span", { class: "so-chip", style: { background: t.accent || "#e0a63c" } }),
        el("span", { text: id.toUpperCase() })
      ]);
      sw.addEventListener("click", function () {
        set("theme", id);
        apply();
        Array.prototype.forEach.call(wrap.children, function (c) { c.classList.remove("sel"); });
        sw.classList.add("sel");
        /* ui.applyTheme() emits
           "ui:theme" and the engine is already listening for it. */
      });
      wrap.appendChild(sw);
    });
    return wrap;
  }

  /* The same presets as the full build. Uploading a picture is left to
     the full build: it lives in localStorage, unencrypted, on a machine
     that may be someone else's. */
  function wallGrid() {
    var wrap = el("div", { class: "so-walls" });
    function draw() {
      ui.clear(wrap);
      var current = ctx.settings.get("wallpaper") || null;
      ui.WALLPAPERS.forEach(function (p) {
        var sw = el("button", { class: "so-wall" + ((p.css || null) === current ? " on" : ""), type: "button",
          title: p.name, onclick: function () { set("wallpaper", p.css || null); apply(); draw(); } },
          [el("span", { class: "so-wall-name", text: p.name })]);
        if (p.css) {
          sw.style.backgroundImage = p.css;
          sw.style.backgroundSize = p.id === "grid" ? "22px 22px" : "cover";
        }
        wrap.appendChild(sw);
      });
    }
    draw();
    return wrap;
  }

  /* The drive is the thing you carry, so it should be the thing
     that remembers. Reports which route worked rather than claiming
     success, because on a locked-down machine neither may. */
  async function saveToDrive() {
    var dp = FieldKit.service("driveProfile");
    if (!dp) return ui.toast("DRIVE PROFILE NOT AVAILABLE", "warn");
    var r = await dp.save();
    if (!r.ok) return ui.toast("NOT SAVED — " + r.detail, r.how === "cancelled" ? "info" : "fail");
    ui.toast(r.how === "picker" ? "SAVED TO THE DRIVE" : "DOWNLOADED — MOVE IT INTO config/", "ok");
    renderDriveStatus();
  }

  function renderDriveStatus() {
    var box = document.getElementById("so-drive-status");
    if (!box) return;
    var dp = FieldKit.service("driveProfile");
    var st = dp && dp.status();
    box.textContent = !st ? ""
      : st.loaded
        ? "This drive remembers a setup" + (st.label ? " from " + st.label : "") +
          ", saved " + String(st.savedAt || "").slice(0, 10) + "." +
          (st.applied.length ? " " + st.applied.length + " setting(s) came from it this launch."
                             : " Everything here was already set on this machine.")
        : "This drive remembers nothing yet. Saving writes " + st.file +
          ", which holds no password and is safe to delete.";
  }

  function selfcheck() {
    return [
      { name: "EVERY THEME IS OFFERED", critical: false, run: async function () {
        if (!nodes.themes) throw new Error("SKIPPED — panel is not mounted");
        var n = nodes.themes.children.length;
        var want = Object.keys(ui.THEMES).length;
        if (n !== want) throw new Error("offered " + n + " of " + want + " themes");
        return want + " themes, all selectable";
      } },
      /* The property that keeps this build limited. A settings panel
         is the obvious place for scope to leak back in one control at
         a time, so the boundary is asserted rather than remembered. */
      { name: "IT CANNOT WRITE A VAULT OR RELAY SETTING", critical: true, run: async function () {
        var blocked = ["relayUrl", "autoLockMinutes", "pullSeconds",
          "autoSnapshotMinutes", "backupReminderDays"];
        var leaked = [];
        blocked.forEach(function (k) {
          var before = ctx.settings.get(k);
          try { set(k, "tampered"); leaked.push(k); }
          catch (e) { /* refused, which is the point */ }
          if (ctx.settings.get(k) !== before) leaked.push(k + " (changed anyway)");
        });
        if (leaked.length) throw new Error("OUTPOST wrote: " + leaked.join(", "));
        return blocked.length + " vault/relay settings refused";
      } },
      { name: "THE VAULT IS NOT REACHABLE FROM HERE", critical: true, run: async function () {
        if (ctx.store.hasVault && ctx.store.hasVault()) {
          throw new Error("a vault is present in a build that should not have one");
        }
        if (typeof ctx.store.changePassword === "function") {
          throw new Error("the store exposes changePassword() on the limited build");
        }
        return "no vault, and no way to ask for one";
      } }
    ];
  }

  /* SCREEN LOCK: a PIN, Ctrl+L, and locking by itself when left alone. */
  function lockPanel() {
    var lock = FieldKit.service("lockscreen");
    var state = el("div", { class: "so-about" });
    nodes.lockState = state;
    async function render() {
      ui.clear(state);
      if (!lock) { state.textContent = "The screen lock is not part of this copy."; return; }
      var has = await lock.hasPin();
      state.textContent = has ? "PIN SET · Ctrl+L locks now · " + lock.MAX_ATTEMPTS + " wrong tries sign you out of everything"
                              : "NO PIN YET · set one to lock with Ctrl+L or when idle";
    }
    var pin = el("input", { class: "so-input", type: "password", inputmode: "numeric", autocomplete: "off",
      placeholder: lock ? lock.MIN_PIN + "-" + lock.MAX_PIN + " digits" : "" });
    var idle = el("select", { class: "so-input" });
    [["0", "NEVER"], ["1", "AFTER 1 MINUTE"], ["5", "AFTER 5 MINUTES"], ["15", "AFTER 15 MINUTES"], ["30", "AFTER 30 MINUTES"]].forEach(function (o) {
      var opt = el("option", { value: o[0], text: o[1] });
      if (String(ctx.settings.get("outpostLockMinutes") || 0) === o[0]) opt.selected = true;
      idle.appendChild(opt);
    });
    idle.addEventListener("change", function () {
      set("outpostLockMinutes", Number(idle.value));
      ui.toast(idle.value === "0" ? "AUTO-LOCK OFF" : "AUTO-LOCK: " + idle.value + " MIN", "info");
    });
    var ask = ui.button(ctx.settings.get("signInAtBoot") !== false ? "ON" : "OFF", function () {
      var next = ctx.settings.get("signInAtBoot") === false;
      set("signInAtBoot", next);
      ask.textContent = next ? "ON" : "OFF"; ask.classList.toggle("on", next);
    });
    ask.className += " so-toggle"; ask.classList.toggle("on", ctx.settings.get("signInAtBoot") !== false);
    render();
    return ui.panel("SCREEN LOCK AND SIGN-IN", [
      state,
      row("PIN", "digits only; stays on this machine as a salted hash", pin),
      el("div", { class: "so-row" }, [
        ui.button("SET PIN", async function () {
          if (!lock) return;
          try { await lock.setPin(pin.value); pin.value = ""; ui.toast("PIN SET", "ok"); render(); }
          catch (e) { ui.toast(String(e.message).toUpperCase(), "fail"); }
        }, { primary: true }),
        ui.button("LOCK NOW", async function () {
          if (!lock) return;
          if (!(await lock.hasPin())) { ui.toast("SET A PIN FIRST", "warn"); return; }
          lock.engage({});
        }),
        ui.button("REMOVE PIN", async function () {
          if (!lock || !window.confirm("Remove the screen lock PIN?")) return;
          await lock.clearPin(); ui.toast("PIN REMOVED", "warn"); render();
        }, { danger: true })
      ]),
      row("AUTO-LOCK", "lock by itself when nobody has touched it", idle),
      row("ASK ME TO SIGN IN AT START", "MESSAGES, BROWSER and RUNNER ready when you open them", ask)
    ]);
  }

  FieldKit.register("settings-outpost", {
    title: "SETTINGS",
    icon: "⚙",
    group: "SYSTEM",
    about: "Theme, wallpaper, sounds and performance",
    keywords: "settings preferences theme wallpaper options appearance",
    guestSafe: true,
    width: 620,
    height: 560,
    selfcheck: selfcheck,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      var themes = themeGrid();
      nodes = { themes: themes };

      var name = el("input", { class: "so-input", type: "text",
        value: ctx.settings.get("displayName") || "",
        placeholder: "what to sign things with" });
      name.addEventListener("change", function () {
        set("displayName", name.value.trim());
        ui.toast("NAME SET", "ok");
      });

      var perf = el("select", { class: "so-input" });
      [["auto", "AUTO — decide from this machine"],
       ["on", "PERFORMANCE — effects off"],
       ["off", "FULL — everything on"]].forEach(function (o) {
        var opt = el("option", { value: o[0], text: o[1] });
        if (ctx.settings.get("perfMode") === o[0]) opt.selected = true;
        perf.appendChild(opt);
      });
      perf.addEventListener("change", function () { set("perfMode", perf.value); });

      var size = el("select", { class: "so-input" });
      [[100, "NORMAL"], [115, "LARGER"], [130, "LARGE"], [150, "LARGEST"]].forEach(function (o) {
        var opt = el("option", { value: String(o[0]), text: o[1] });
        if (Number(ctx.settings.get("textSize")) === o[0]) opt.selected = true;
        size.appendChild(opt);
      });
      size.addEventListener("change", function () { set("textSize", Number(size.value)); apply(); });

      host.appendChild(el("div", { class: "so-wrap" }, [
        ui.panel("APPEARANCE", [
          row("ACCENT", "everything highlights in this colour", themes),
          row("WALLPAPER", "behind the windows", wallGrid())
        ]),
        ui.panel("DISPLAY", [
          row("TEXT SIZE", "everything inside windows, and the icons", size),
          toggle("contrast", "HIGHER CONTRAST", "brighter text and lines on black"),
          toggle("calm", "LESS MOTION", "no animation or fading"),
          toggle("crt", "CRT OVERLAY", "scanlines and a little glow"),
          toggle("clock24", "24-HOUR CLOCK", "off shows the time with AM and PM"),
          row("PERFORMANCE", "how hard to work this machine", perf)
        ]),
        ui.panel("BEHAVIOUR", [
          toggle("sound", "SOUND", "clicks and confirmations"),
          toggle("bootFlavor", "BOOT QUOTES", "a line on the way in"),
          toggle("updateCheckAtStart", "TELL ME ABOUT UPDATES", "at start, a popup when a newer signed release is out"),
          row("YOUR NAME", "shown on anything you sign", name)
        ]),
        lockPanel(),
        ui.panel("THIS DRIVE", [
          row("SAVE TO DRIVE", "so a machine you have never used comes up configured",
            ui.button("SAVE PROFILE", saveToDrive)),
          el("div", { class: "so-about", id: "so-drive-status" })
        ]),
        ui.panel("THIS BUILD", [
          el("div", { class: "so-about", text:
            "OUTPOST carries no vault. There is no passphrase to set, and nothing on " +
            "this drive that can read anyone's private notes — those files are not part " +
            "of this build at all. The relay address is in RELAY LINK; updates are in UPDATE." }),
          el("div", { class: "so-about dim", text:
            "Anything you save here stays on this machine, unencrypted, and is readable " +
            "by anyone who uses it. Do not keep secrets in OUTPOST." })
        ])
      ]));

      apply();
      renderDriveStatus();
    },

    unmount() { nodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("so-style")) return;
    var s = document.createElement("style");
    s.id = "so-style";
    s.textContent = [
      ".so-wrap{height:100%;overflow:auto;display:flex;flex-direction:column;gap:10px}",
      ".so-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;",
      "  padding:7px 4px;border-bottom:1px solid var(--line)}",
      ".so-row:last-child{border-bottom:0}",
      ".so-label{min-width:0;flex:1}",
      ".so-name{display:block;font-size:11px;letter-spacing:.14em;color:var(--fg)}",
      ".so-note{display:block;font-size:10px;color:var(--fg-dimmer);margin-top:2px}",
      ".so-control{flex:none;max-width:60%}",
      ".so-toggle.on{border-color:var(--accent);color:var(--accent)}",
      ".so-input{background:#0e1210;color:var(--fg);border:1px solid var(--line2);",
      "  padding:6px 8px;font:inherit;font-size:11px;min-width:200px}",
      ".so-themes{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}",
      ".so-theme{display:flex;align-items:center;gap:6px;background:#171c19;color:var(--fg-dim);",
      "  border:1px solid var(--line2);padding:5px 9px;font:inherit;font-size:10px;",
      "  letter-spacing:.12em;cursor:pointer}",
      ".so-theme.sel{border-color:var(--accent);color:var(--accent)}",
      ".so-walls{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}",
      ".so-wall{position:relative;width:78px;height:48px;border:1px solid var(--line2);background-color:#0c0f0d;cursor:pointer;padding:0}",
      ".so-wall:hover{border-color:var(--accent-dim)}",
      ".so-wall.on{border-color:var(--accent);box-shadow:0 0 0 1px rgba(var(--accent-glow),.3)}",
      ".so-wall-name{position:absolute;left:0;right:0;bottom:0;font-size:8px;letter-spacing:.1em;",
      "  color:var(--fg-dim);background:rgba(6,8,7,.8);padding:2px 0;text-align:center}",
      ".so-wall.on .so-wall-name{color:var(--accent)}",
      ".so-chip{width:10px;height:10px;display:inline-block;border:1px solid rgba(0,0,0,.4)}",
      ".so-about{font-size:10px;color:var(--fg-dim);line-height:1.5;padding:2px 4px}",
      ".so-about.dim{color:var(--warn);margin-top:6px}"
    ].join("\n");
    document.head.appendChild(s);
  }
})(window.FieldKit);
