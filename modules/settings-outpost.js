/* ============================================================
   FieldKit :: SETTINGS (OUTPOST build)
   Appearance and behaviour, and nothing else.

   The full build's settings panel is not on this drive, and that is
   not a matter of hiding a section: most of what it does is vault
   work — change the passphrase, set the auto-lock, point at a relay,
   schedule snapshots. None of that exists here, so a panel with
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
  var OWNED = ["theme", "crt", "sound", "ambient", "perfMode", "wallpaper",
    "bootFlavor", "displayName"];

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
        /* No need to tell achievements — ui.applyTheme() emits
           "ui:theme" and the engine is already listening for it. */
      });
      wrap.appendChild(sw);
    });
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

      host.appendChild(el("div", { class: "so-wrap" }, [
        ui.panel("APPEARANCE", [
          row("ACCENT", "everything highlights in this colour", themes)
        ]),
        ui.panel("DISPLAY", [
          toggle("crt", "CRT OVERLAY", "scanlines and a little glow"),
          toggle("ambient", "AMBIENT EFFECTS", "background motion; costs frames"),
          row("PERFORMANCE", "how hard to work this machine", perf)
        ]),
        ui.panel("BEHAVIOUR", [
          toggle("sound", "SOUND", "clicks and confirmations"),
          toggle("bootFlavor", "BOOT QUOTES", "a line on the way in"),
          row("YOUR NAME", "shown on anything you sign", name)
        ]),
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
      ".so-chip{width:10px;height:10px;display:inline-block;border:1px solid rgba(0,0,0,.4)}",
      ".so-about{font-size:10px;color:var(--fg-dim);line-height:1.5;padding:2px 4px}",
      ".so-about.dim{color:var(--warn);margin-top:6px}"
    ].join("\n");
    document.head.appendChild(s);
  }
})(window.FieldKit);
