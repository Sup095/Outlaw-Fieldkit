/* ============================================================
   FieldKit :: settings-panel
   Theme, wallpaper, ambient toggles, performance.

   Wallpaper presets are CSS gradients rather than image files, so
   the drive carries no art it doesn't need and they retint with
   the accent colour. Uploads are capped, because settings live in
   localStorage and a 4 MB data URL would blow the quota and take
   every other preference down with it.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  /* Set at every mount. Async work started by one mount must not
     write into the panel belonging to the next one — see
     FieldKit.mountGuard in core/kernel.js. */
  var alive = function () { return false; };

  var WALLPAPER_CAP = 1500000;   // ~1.5 MB as a data URL

  var PRESETS = [
    { id: "none", name: "NONE", css: null },
    { id: "grid", name: "GRID", css:
      "linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px)," +
      "linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px)" },
    { id: "deep", name: "DEEP FIELD", css:
      "radial-gradient(ellipse at 20% 10%, rgba(var(--accent-glow),.13), transparent 55%)," +
      "radial-gradient(ellipse at 80% 90%, rgba(40,70,90,.22), transparent 55%)" },
    { id: "scan", name: "SCANLINES", css:
      "repeating-linear-gradient(0deg, rgba(255,255,255,.03) 0 1px, transparent 1px 4px)" },
    { id: "ember", name: "EMBER", css:
      "radial-gradient(circle at 50% 120%, rgba(var(--accent-glow),.2), transparent 60%)" },
    { id: "topo", name: "TOPO", css:
      "repeating-radial-gradient(circle at 30% 40%, transparent 0 18px, rgba(255,255,255,.022) 18px 19px)" }
  ];

  function applyWallpaper(value) {
    var shell = FieldKit.service("shell");
    if (shell) shell.setWallpaper(value || null);
  }

  function setWallpaper(value) {
    ctx.settings.set("wallpaper", value || null);
    applyWallpaper(value);
    renderWallpapers();
  }

  function renderWallpapers() {
    ui.clear(nodes.walls);
    var current = ctx.settings.get("wallpaper");
    PRESETS.forEach(function (p) {
      var active = (p.css || null) === (current || null);
      var swatch = el("button", {
        class: "sp-wall" + (active ? " on" : ""), type: "button", title: p.name,
        onclick: function () { setWallpaper(p.css); }
      }, [el("span", { class: "sp-wall-name", text: p.name })]);
      if (p.css) {
        swatch.style.backgroundImage = p.css;
        swatch.style.backgroundSize = p.id === "grid" ? "22px 22px" : "cover";
      }
      nodes.walls.appendChild(swatch);
    });

    if (current && current.indexOf("data:") === 0) {
      var custom = el("button", { class: "sp-wall on", type: "button", title: "custom upload",
        onclick: function () { setWallpaper(current); } },
        [el("span", { class: "sp-wall-name", text: "CUSTOM" })]);
      custom.style.backgroundImage = 'url("' + current + '")';
      custom.style.backgroundSize = "cover";
      nodes.walls.appendChild(custom);
    }
  }

  function handleUpload(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { ui.toast("NOT AN IMAGE", "fail"); return; }
    if (file.size > WALLPAPER_CAP) {
      ui.toast("TOO LARGE — " + Math.round(file.size / 1024) + " KB, limit " +
        Math.round(WALLPAPER_CAP / 1024) + " KB", "fail");
      return;
    }
    var fr = new FileReader();
    fr.onload = function () {
      try {
        setWallpaper(fr.result);
        ui.toast("WALLPAPER SET", "ok");
      } catch (e) {
        /* localStorage quota is the realistic failure here. */
        ui.toast("COULD NOT STORE WALLPAPER: " + e.message, "fail");
      }
    };
    fr.onerror = function () { ui.toast("COULD NOT READ FILE", "fail"); };
    fr.readAsDataURL(file);
  }

  function toggle(label, key, note, onChange) {
    var input = el("input", { type: "checkbox" });
    input.checked = !!ctx.settings.get(key);
    input.addEventListener("change", function () {
      ctx.settings.set(key, input.checked);
      if (onChange) onChange(input.checked);
    });
    return el("label", { class: "sp-toggle" }, [
      input,
      el("span", {}, [
        el("span", { class: "sp-toggle-label", text: label }),
        note ? el("span", { class: "sp-toggle-note", text: note }) : null
      ])
    ]);
  }

  function selfcheck() {
    return [
      { name: "PALETTE SWATCHES", critical: false, run: async function () {
        var n = nodes.themes.children.length;
        var themes = Object.keys(ui.THEMES).length;
        if (n !== themes) throw new Error("expected " + themes + " palettes, rendered " + n);
        return n + " palettes offered";
      } },
      { name: "WALLPAPER PRESETS", critical: false, run: async function () {
        if (nodes.walls.children.length < PRESETS.length) {
          throw new Error("expected at least " + PRESETS.length + " presets, rendered " +
            nodes.walls.children.length);
        }
        return nodes.walls.children.length + " presets, upload capped at " +
          Math.round(WALLPAPER_CAP / 1024) + " KB";
      } },
      { name: "PERFORMANCE READOUT", critical: false, run: async function () {
        if (!/EFFECTIVE BUDGET/.test(nodes.perfInfo.textContent)) {
          throw new Error("performance readout did not render");
        }
        return ctx.settings.perfBudget().toUpperCase();
      } },
      { name: "SCREEN LOCK SECTION", critical: false, run: async function () {
        if (!nodes.lockState.textContent.trim()) throw new Error("screen lock state did not render");
        return nodes.lockState.textContent.replace(/\s+/g, " ").trim().slice(0, 60);
      } },
      /* Settings live in localStorage and must survive a write. */
      { name: "PREFERENCE PERSISTS", critical: false, run: async function () {
        var was = ctx.settings.get("bootFlavor");
        ctx.settings.set("bootFlavor", !was);
        var flipped = ctx.settings.get("bootFlavor");
        ctx.settings.set("bootFlavor", was);
        if (flipped === was) throw new Error("setting did not change");
        if (ctx.settings.get("bootFlavor") !== was) throw new Error("setting did not restore");
        return "written and restored";
      } }
    ];
  }

  FieldKit.register("settings-panel", {
    group: "SYSTEM",
    about: "Theme, wallpaper, sounds and performance",
    keywords: "settings preferences theme wallpaper options appearance",
    selfcheck: selfcheck,
    title: "SETTINGS",
    icon: "◍",
    width: 620,
    height: 560,

    async mount(host, context) {
      alive = FieldKit.mountGuard("settings-panel");
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      /* themes */
      nodes.themes = el("div", { class: "sp-themes" });
      Object.keys(ui.THEMES).forEach(function (id) {
        var t = ui.THEMES[id];
        var b = el("button", {
          class: "sp-theme" + (ui.currentTheme() === id ? " on" : ""), type: "button",
          onclick: function () {
            ui.applyTheme(id);
            ctx.settings.set("theme", id);
            [].forEach.call(nodes.themes.children, function (c) { c.classList.remove("on"); });
            b.classList.add("on");
          }
        }, [
          el("span", { class: "sp-swatch", style: { background: t.accent } }),
          el("span", { text: t.name })
        ]);
        nodes.themes.appendChild(b);
      });

      /* wallpaper */
      nodes.walls = el("div", { class: "sp-walls" });
      var fileInput = el("input", { type: "file", accept: "image/*", style: { display: "none" },
        onchange: function (e) { handleUpload(e.target.files[0]); e.target.value = ""; } });

      /* perf */
      var perfSel = el("select", { class: "fk-input sp-select" });
      [["auto", "AUTO (detect)"], ["on", "FULL"], ["off", "MINIMAL"]].forEach(function (o) {
        perfSel.appendChild(el("option", { value: o[0], text: o[1],
          selected: ctx.settings.get("perfMode") === o[0] ? true : null }));
      });
      perfSel.addEventListener("change", function () {
        ctx.settings.set("perfMode", perfSel.value);
        renderPerf();
      });
      nodes.perfInfo = el("div");

      function renderPerf() {
        ui.clear(nodes.perfInfo);
        nodes.perfInfo.appendChild(ui.readout([
          { label: "EFFECTIVE BUDGET", value: ctx.settings.perfBudget().toUpperCase(), level: "info" },
          { label: "CPU THREADS", value: navigator.hardwareConcurrency || "unreported", level: "dim" },
          { label: "DEVICE MEMORY", value: navigator.deviceMemory ? navigator.deviceMemory + " GB" : "unreported", level: "dim" },
          { label: "REDUCED MOTION", value: matchMedia("(prefers-reduced-motion: reduce)").matches ? "REQUESTED" : "NO", level: "dim" }
        ]));
      }

      /* screen lock */
      var lock = FieldKit.service("lockscreen");
      nodes.lockState = el("div");
      var pinIn = el("input", { class: "fk-input", type: "password", inputmode: "numeric",
        placeholder: lock ? lock.MIN_PIN + "-" + lock.MAX_PIN + " digits" : "", autocomplete: "off" });
      var idleSel = el("select", { class: "fk-input sp-select" });
      [["0", "NEVER"], ["1", "1 MINUTE"], ["5", "5 MINUTES"], ["15", "15 MINUTES"], ["30", "30 MINUTES"]]
        .forEach(function (o) {
          idleSel.appendChild(el("option", { value: o[0], text: o[1],
            selected: String(ctx.settings.get("autoLockMinutes")) === o[0] ? true : null }));
        });
      idleSel.addEventListener("change", function () {
        ctx.settings.set("autoLockMinutes", Number(idleSel.value));
        ui.toast(idleSel.value === "0" ? "AUTO-LOCK OFF" : "AUTO-LOCK: " + idleSel.value + " MIN", "info");
      });

      async function renderLock() {
        ui.clear(nodes.lockState);
        if (!lock) {
          nodes.lockState.appendChild(ui.readout([{ label: "SCREEN LOCK", value: "UNAVAILABLE", level: "fail" }]));
          return;
        }
        var set = await lock.hasPin();
        nodes.lockState.appendChild(ui.readout([
          { label: "PIN", value: set ? "SET" : "NOT SET", level: set ? "ok" : "warn" },
          { label: "HOTKEY", value: "CTRL + L", level: "dim" },
          { label: "FAILED ATTEMPTS ALLOWED", value: String(lock.MAX_ATTEMPTS), level: "dim" }
        ]));
      }

      /* ---- shared vault ---- */
      var nameIn = ui.field("YOUR NAME", { placeholder: "leave blank to use the device id" });
      nameIn.input.value = ctx.settings.get("displayName") || "";
      nameIn.input.addEventListener("change", function () {
        ctx.settings.set("displayName", nameIn.input.value.trim().slice(0, 40));
        ui.toast("NAME SET — IT WILL APPEAR ON RECORDS YOU WRITE FROM NOW ON", "ok");
      });

      var pullSel = el("select", { class: "fk-input" });
      [["0", "NEVER — SOLO VAULT"], ["20", "EVERY 20 SECONDS"], ["60", "EVERY MINUTE"],
       ["300", "EVERY 5 MINUTES"]].forEach(function (o) {
        pullSel.appendChild(el("option", { value: o[0], text: o[1],
          selected: String(ctx.settings.get("pullSeconds")) === o[0] ? true : null }));
      });
      pullSel.addEventListener("change", function () {
        ctx.settings.set("pullSeconds", Number(pullSel.value));
        if (ctx.store.startAutoPull) ctx.store.startAutoPull();
        ui.toast(Number(pullSel.value) ? "BACKGROUND PULL ON" : "BACKGROUND PULL OFF", "ok");
      });

      /* ---- master password ----
         Vault.changePassword existed from the start and was reachable
         from nowhere, which made the recovery key a one-way door:
         unlocking with it left you without a password you knew, and
         no way to set one. */
      var pw1 = ui.field("NEW PASSWORD", { type: "password", autocomplete: "new-password" });
      var pw2 = ui.field("AGAIN", { type: "password", autocomplete: "new-password" });
      nodes.pwNotice = el("div");

      /* A recovery unlock means there is no password anybody knows.
         Say so at the top of the panel rather than leaving it to be
         discovered at the next boot. */
      if (ctx.store.openedWithRecovery && ctx.store.openedWithRecovery()) {
        nodes.pwNotice.appendChild(el("div", { class: "sp-alert", text:
          "This session was opened with the recovery key, so there is no password anyone " +
          "knows. Set one now — the recovery key keeps working either way, but you should " +
          "not have to reach for it every time." }));
      }

      function changePassword() {
        var a = pw1.input.value, b = pw2.input.value;
        if (!a) { ui.toast("ENTER A NEW PASSWORD", "warn"); return; }
        if (a !== b) { ui.toast("THE TWO ENTRIES DO NOT MATCH", "warn"); return; }
        if (a.length < 8) { ui.toast("AT LEAST 8 CHARACTERS", "warn"); return; }
        if (!confirm("Change the master password?\n\n" +
            "Everyone who shares this vault will need the new one. Your recovery key is " +
            "unaffected and still works.")) return;

        /* Changing a password takes two PBKDF2 passes and a round
           trip; the panel can easily be closed before it lands.
           Without this the confirmation writes into whatever `nodes`
           points at by then, which after a FULL SYSTEM EXERCISE is a
           different SETTINGS panel entirely.

           Captured here rather than read inside the continuation:
           `alive` is module scope and the next mount reassigns it,
           so reading it there reads a guard that is always current,
           which passes exactly when it should fail. */
        var stillMine = alive;
        ctx.store.changePassword(a).then(function () {
          if (!stillMine()) return;
          pw1.input.value = "";
          pw2.input.value = "";
          ui.clear(nodes.pwNotice);
          ui.toast("PASSWORD CHANGED — TELL WHOEVER SHARES THIS VAULT", "ok");
        }).catch(function (e) {
          /* Never a bare toast here: if this failed the user needs
             to know their old password still works. */
          ui.textDump("The password was NOT changed.\n\n" + (e.message || String(e)) +
            "\n\nYour existing password still works. Nothing has been altered.",
            "PASSWORD CHANGE FAILED");
        });
      }

      /* ---- portable settings ----
         Preferences live in localStorage, which is per-profile and
         per-machine. Cloning a drive does not clone them. This is
         the one file that carries "how it looks and behaves" to a
         second machine — deliberately NOT the vault, and carrying
         nothing secret. */
      var SETTINGS_FORMAT = "fieldkit-settings";
      var SETTINGS_DENY = ["relayProvisionToken"];

      function buildSettingsFile() {
        var all = ctx.settings.all();
        SETTINGS_DENY.forEach(function (k) { delete all[k]; });
        /* A multi-megabyte data URL is not portable and is not a
           preference anyone wants to email around. */
        if (typeof all.wallpaper === "string" && all.wallpaper.indexOf("data:") === 0) {
          all.wallpaper = null;
          all._wallpaperOmitted = true;
        }
        return {
          format: SETTINGS_FORMAT, v: 1,
          createdAt: new Date().toISOString(),
          appVersion: ctx.version,
          settings: all
        };
      }

      function applySettingsFile(text) {
        var obj;
        try { obj = JSON.parse(text); }
        catch (e) { throw new Error("not valid JSON — is this a settings file?"); }
        if (!obj || obj.format !== SETTINGS_FORMAT) throw new Error("not a FieldKit settings file");
        if (obj.v > 1) throw new Error("this file is newer than this build understands");
        if (!obj.settings || typeof obj.settings !== "object") throw new Error("no settings in it");

        /* Only keys this build actually knows. An unknown key from a
           newer build is ignored rather than stored forever, and a
           denied key cannot be smuggled in through a file. */
        var known = Object.keys(ctx.settings.DEFAULTS);
        var applied = 0, skipped = [];
        Object.keys(obj.settings).forEach(function (k) {
          if (SETTINGS_DENY.indexOf(k) >= 0) { skipped.push(k); return; }
          if (known.indexOf(k) < 0) { skipped.push(k); return; }
          if (typeof obj.settings[k] !== typeof ctx.settings.DEFAULTS[k] &&
              obj.settings[k] !== null) { skipped.push(k); return; }
          ctx.settings.set(k, obj.settings[k]);
          applied++;
        });
        return { applied: applied, skipped: skipped };
      }

      var settingsFileInput = el("input", { type: "file", accept: ".json,application/json",
        style: { display: "none" },
        onchange: function (e) {
          var f = e.target.files[0];
          e.target.value = "";
          if (!f) return;
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var r = applySettingsFile(String(fr.result));
              ui.toast("APPLIED " + r.applied + " SETTING(S)" +
                (r.skipped.length ? " — " + r.skipped.length + " IGNORED" : ""), "ok");
              ui.applyTheme(ctx.settings.get("theme"));
              document.body.classList.toggle("crt", !!ctx.settings.get("crt"));
              ui.toast("SOME CHANGES NEED A RELOAD TO TAKE FULL EFFECT", "info");
            } catch (err) {
              ui.toast(err.message.toUpperCase(), "fail");
            }
          };
          fr.onerror = function () { ui.toast("COULD NOT READ THAT FILE", "fail"); };
          fr.readAsText(f);
        } });

      /* Says what the drive currently knows, so "did that save
         work?" is answerable without plugging into another PC. */
      function renderDriveStatus() {
        var box = document.getElementById("sp-drive-status");
        if (!box) return;
        var dp = FieldKit.service("driveProfile");
        var st = dp && dp.status();
        if (!st) { box.textContent = ""; return; }
        box.textContent = st.loaded
          ? "This drive remembers a setup" + (st.label ? " from " + st.label : "") +
            ", saved " + String(st.savedAt || "").slice(0, 10) + "." +
            (st.applied.length
              ? " " + st.applied.length + " setting(s) came from it this launch."
              : " Everything here was already set on this machine, so none was applied.")
          : "This drive remembers nothing yet. Saving writes " + st.file + ".";
      }

      host.appendChild(el("div", { class: "sp-wrap" }, [
        ui.panel("THIS DRIVE REMEMBERS", [
          el("p", { class: "sp-note", text:
            "Preferences live in this browser profile, not on the drive — so a machine you " +
            "have never used before starts blank, relay URL and all. SAVE TO DRIVE writes " +
            "them to the stick instead, and the next new machine comes up already set up." }),
          el("p", { class: "sp-note", text:
            "It holds no password, no vault token and no recovery key, so it is safe to read " +
            "and safe to delete. A setting you have already chosen on a machine is never " +
            "overwritten by the drive — the drive only fills in blanks." }),
          el("div", { class: "sp-actions" }, [
            ui.button("SAVE TO DRIVE", async function () {
              var dp = FieldKit.service("driveProfile");
              if (!dp) return ui.toast("DRIVE PROFILE NOT AVAILABLE", "warn");
              var r = await dp.save();
              if (!r.ok) {
                return ui.toast("NOT SAVED — " + r.detail, r.how === "cancelled" ? "info" : "fail");
              }
              ui.toast(r.how === "picker" ? "SAVED TO THE DRIVE"
                : "DOWNLOADED — MOVE IT INTO config/ ON THE DRIVE", "ok");
              renderDriveStatus();
            })
          ]),
          el("div", { class: "sp-note", id: "sp-drive-status" })
        ]),
        ui.panel("PORTABLE SETTINGS FILE", [
          el("p", { class: "sp-note", text:
            "The older, manual route: an export you carry yourself. Still here because it " +
            "works on a machine where nothing may write to the drive at all." }),
          el("div", { class: "sp-actions" }, [
            ui.button("EXPORT SETTINGS", function () {
              var file = buildSettingsFile();
              var text = JSON.stringify(file, null, 1);
              var name = "fieldkit-settings-" +
                file.createdAt.replace(/[:.]/g, "-").slice(0, 19) + ".json";
              if (ui.download(text, name)) {
                ui.toast("SAVE ATTEMPTED — CHECK DOWNLOADS FOR " + name, "info");
              } else {
                ui.textDump(text, "PORTABLE SETTINGS",
                  "Downloads are blocked here. Copy this and save it yourself.");
              }
            }),
            ui.button("IMPORT SETTINGS", function () { settingsFileInput.click(); }),
            ui.button("SHOW AS TEXT", function () {
              ui.textDump(JSON.stringify(buildSettingsFile(), null, 1), "PORTABLE SETTINGS",
                "Select and copy, or just read what would be exported.");
            })
          ]),
          settingsFileInput
        ]),
        ui.panel("SHARED VAULT", [
          el("p", { class: "sp-note", text:
            "A vault is tied to a password, not to a device or a drive. Anyone with the master " +
            "password — or the recovery key — sees the same data from their own machine. " +
            "Nothing needs enabling for that; these settings just make working together less " +
            "confusing." }),
          nameIn,
          el("p", { class: "sp-note", text:
            "Stamped inside the encrypted record, not on the metadata the relay can read. It is " +
            "a label and not a login: anyone with the password can set any name." }),
          el("label", { class: "fk-field", style: { marginTop: "10px" } }, [
            el("span", { class: "fk-field-label", text: "CHECK FOR OTHER PEOPLE'S CHANGES" }), pullSel
          ]),
          el("p", { class: "sp-note", text:
            "Only what changed is fetched, so this is cheap even on a large vault. If two of you " +
            "save the same record, the newer write wins and you are told rather than left to " +
            "notice later." })
        ]),
        ui.panel("MASTER PASSWORD", [
          nodes.pwNotice,
          pw1, pw2,
          ui.button("CHANGE PASSWORD", changePassword, { primary: true }),
          el("p", { class: "sp-note", text:
            "Only the small wrapper around the master key is re-made, so this is instant " +
            "however much is in the vault — nothing is re-encrypted and nothing is re-uploaded." }),
          el("p", { class: "sp-note", text:
            "Your recovery key still works afterwards. It is derived separately and a password " +
            "change does not touch it." }),
          el("p", { class: "sp-warn-note", text:
            "The new header has to reach the relay for this to stick. If the relay refuses it, " +
            "the change is rolled back and your old password still works — you will be told " +
            "rather than left with a password that opens the drive and not the server." })
        ]),
        ui.panel("ACCENT PALETTE", [
          nodes.themes,
          el("p", { class: "sp-note", text: "All palettes stay dark. Accent drives highlights, active windows, and status readouts." })
        ]),
        ui.panel("WALLPAPER", [
          nodes.walls,
          el("div", { class: "sp-actions" }, [
            ui.button("UPLOAD IMAGE", function () { fileInput.click(); }),
            ui.button("CLEAR", function () { setWallpaper(null); })
          ]),
          el("p", { class: "sp-note", text:
            "Presets are CSS, so they retint with the accent colour and cost the drive nothing. Uploads are capped at " +
            Math.round(WALLPAPER_CAP / 1024) + " KB because settings live in browser storage." }),
          fileInput
        ]),
        ui.panel("EFFECTS", [
          toggle("CRT SCANLINES", "crt", "overlay + subtle flicker", function (on) {
            document.body.classList.toggle("crt", on);
          }),
          toggle("AMBIENT PARTICLES", "ambient", "canvas-2D — the Chromebook has no WebGL"),
          toggle("SOUND", "sound", "terminal beeps, off by default"),
          toggle("BOOT FLAVOUR TEXT", "bootFlavor", "random line on each launch")
        ]),
        ui.panel("PERFORMANCE", [
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "MODE" }), perfSel
          ]),
          nodes.perfInfo,
          el("p", { class: "sp-note", text:
            "MINIMAL skips boot animation timing and disables ambient effects. AUTO decides from cores, memory, and the reduced-motion preference." })
        ]),
        ui.panel("SCREEN LOCK", [
          nodes.lockState,
          el("label", { class: "fk-field", style: { marginTop: "10px" } }, [
            el("span", { class: "fk-field-label", text: "PIN" }), pinIn
          ]),
          el("div", { class: "sp-actions" }, [
            ui.button("SET PIN", async function () {
              if (!lock) return;
              try {
                await lock.setPin(pinIn.value);
                pinIn.value = "";
                ui.toast("PIN SET", "ok");
                await renderLock();
              } catch (e) {
                ui.toast(e.message.toUpperCase(), "fail");
              }
            }, { primary: true }),
            ui.button("LOCK NOW", async function () {
              if (!lock) return;
              if (!(await lock.hasPin())) { ui.toast("SET A PIN FIRST", "warn"); return; }
              lock.engage({});
            }),
            ui.button("REMOVE PIN", async function () {
              if (!lock) return;
              if (!confirm("Remove the screen lock PIN?")) return;
              await lock.clearPin();
              ui.toast("PIN REMOVED", "warn");
              await renderLock();
            }, { danger: true })
          ]),
          el("label", { class: "fk-field", style: { marginTop: "12px" } }, [
            el("span", { class: "fk-field-label", text: "AUTO-LOCK WHEN IDLE" }), idleSel
          ]),
          el("p", { class: "sp-note", text:
            "This locks the screen over a session that is already open — it is not a second layer " +
            "of encryption, and the PIN itself lives inside the vault. It stops someone at the " +
            "keyboard. After " + (lock ? lock.MAX_ATTEMPTS : 5) + " wrong tries the session is " +
            "destroyed and the master password is required again." })
        ]),
        ui.panel("DANGER", [
          el("div", { class: "sp-actions" }, [
            ui.button("RESET ALL SETTINGS", function () {
              if (!confirm("Reset every preference to defaults? Your vault and notes are untouched.")) return;
              ctx.settings.reset();
              ui.applyTheme(ctx.settings.get("theme"));
              applyWallpaper(null);
              document.body.classList.remove("crt");
              ui.toast("SETTINGS RESET", "warn");
              FieldKit.service("shell").close("settings-panel");
            }, { danger: true })
          ]),
          el("p", { class: "sp-note", text: "Preferences only. This never touches encrypted data." })
        ])
      ]));

      renderWallpapers();
      renderPerf();
      renderDriveStatus();
      await renderLock();
    },

    unmount() { alive.end(); nodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("sp-style")) return;
    var s = document.createElement("style");
    s.id = "sp-style";
    s.textContent = `
.sp-wrap{height:100%;overflow:auto}
.sp-themes{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.sp-theme{display:flex;align-items:center;gap:6px;background:#11150f;border:1px solid var(--line2);
  color:var(--fg-dim);font:inherit;font-size:10px;letter-spacing:.12em;padding:5px 9px;cursor:pointer}
.sp-theme:hover{color:var(--accent);border-color:var(--accent-dim)}
.sp-theme.on{border-color:var(--accent);color:var(--accent)}
.sp-swatch{width:11px;height:11px;border:1px solid rgba(0,0,0,.5)}
.sp-walls{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.sp-wall{width:92px;height:56px;border:1px solid var(--line2);background-color:#0c0f0d;cursor:pointer;
  position:relative;padding:0;display:flex;align-items:flex-end;justify-content:center}
.sp-wall:hover{border-color:var(--accent-dim)}
.sp-wall.on{border-color:var(--accent);box-shadow:0 0 0 1px rgba(var(--accent-glow),.3)}
.sp-wall-name{font-size:8px;letter-spacing:.1em;color:var(--fg-dim);background:rgba(6,8,7,.8);
  width:100%;padding:2px 0;text-align:center}
.sp-wall.on .sp-wall-name{color:var(--accent)}
.sp-actions{display:flex;gap:6px;flex-wrap:wrap}
.sp-note{color:var(--fg-dimmer);font-size:10px;line-height:1.5;margin:8px 0 0}
.sp-warn-note{color:var(--warn);font-size:10px;line-height:1.6;margin:8px 0 0;
  border-left:2px solid var(--warn);padding-left:9px}
.sp-alert{color:var(--accent);font-size:10px;line-height:1.6;margin:0 0 10px;
  border:1px dashed var(--accent);padding:8px 9px}
.sp-toggle{display:flex;align-items:flex-start;gap:9px;padding:5px 0;cursor:pointer}
.sp-toggle-label{display:block;font-size:10px;letter-spacing:.14em;color:var(--fg)}
.sp-toggle-note{display:block;font-size:9px;color:var(--fg-dimmer);margin-top:1px}
.sp-select{padding:8px 9px}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
