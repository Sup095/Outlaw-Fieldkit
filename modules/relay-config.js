/* ============================================================
   FieldKit :: relay-config
   Point the client at the relay, provision the vault the first
   time, and read back link + AI target health.

   Every hop gets its own readout line (§10): USB -> relay is a
   separate, separately-failing step from relay -> PC.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};

  /* The relay classifies an unreachable AI target rather than
     reporting every failure as DOWN. These are its verdicts in the
     words someone can act on: "NOT LISTENING" means start LM
     Studio, "NO ROUTE" means the address was never reachable from
     that container and restarting anything will not help. */
  var KIND_LABEL = {
    refused: "NOT LISTENING",
    dns: "NAME WILL NOT RESOLVE",
    unroutable: "NO ROUTE",
    timeout: "NO ANSWER (DROPPED)",
    reset: "CONNECTION DROPPED",
    http: "WRONG SERVICE"
  };

  function settings() { return ctx.settings; }
  function relay() { return FieldKit.service("transportRelay"); }

  function status(msg, level) {
    ui.clear(nodes.status);
    nodes.status.appendChild(ui.readout([{ label: "STATUS", value: msg, level: level || "dim" }]));
  }

  async function testLink() {
    var url = nodes.url.input.value.trim();
    if (!url) { status("NO URL SET", "fail"); return; }
    relay().configure(url, { provisionToken: nodes.token.input.value.trim() });
    settings().set("relayUrl", url);

    ui.clear(nodes.hops);
    var hop1 = { label: "USB -> RELAY", value: "PROBING", level: "warn" };
    var hop2 = { label: "RELAY -> PC", value: "PENDING", level: "dim" };
    var render = function () { ui.clear(nodes.hops); nodes.hops.appendChild(ui.readout([hop1, hop2])); };
    render();

    var health;
    try {
      health = await relay().health();
      hop1.value = "ONLINE" + (health.vaultProvisioned ? " / VAULT PRESENT" : " / NO VAULT YET");
      hop1.level = "pass";
    } catch (e) {
      hop1.value = "UNREACHABLE — " + e.message;
      hop1.level = "fail";
      hop2.value = "SKIPPED";
      render();
      return;
    }
    render();

    /* AI targets need auth, so this only works once unlocked. */
    if (!ctx.store.isUnlocked()) {
      hop2.value = "UNLOCK FIRST";
      hop2.level = "warn";
      render();
      return;
    }

    try {
      var targets = await relay().aiTargets();
      ui.clear(nodes.hops);
      var rows = [hop1];
      if (!targets.length) {
        rows.push({ label: "RELAY -> PC", value: "NO TARGETS CONFIGURED", level: "warn" });
      } else {
        targets.forEach(function (t) {
          var h = t.health || {};
          var ok = h.ok;
          /* "DOWN" is not a diagnosis — the relay now classifies why,
             and the reason is the only part worth reading. */
          var label = ok ? "REACHABLE" : (KIND_LABEL[h.kind] || "DOWN");
          rows.push({
            label: "AI :: " + t.name.toUpperCase(),
            value: label + "  (priority " + t.priority + ")",
            level: ok ? "pass" : (h.kind === "refused" ? "warn" : "fail")
          });
          if (!ok && h.hint) {
            rows.push({ label: "", value: h.hint, level: "dim" });
          }
        });
      }
      nodes.hops.appendChild(ui.readout(rows));
    } catch (e) {
      hop2.value = "AUTH OR PROXY FAILED — " + e.message;
      hop2.level = "fail";
      render();
    }
  }

  function saveConfig() {
    var url = nodes.url.input.value.trim();
    var tok = nodes.token.input.value.trim();
    settings().set("relayUrl", url);
    settings().set("relayProvisionToken", tok);
    relay().configure(url, { provisionToken: tok });
    status("SAVED — RESTART FIELDKIT TO CONNECT ON BOOT", "pass");
    ui.toast("RELAY CONFIG SAVED", "ok");
  }

  /* ---- provisioning an already-open vault onto a relay ----------
     The gap this closes: a vault's active transport is decided ONCE,
     at boot, by whatever was in settings before the vault existed.
     A brand new drive has no relay URL yet — RELAY LINK is a module,
     and modules are unreachable until a vault exists — so the very
     first vault anyone creates is local-only, unconditionally. SAVE
     above only writes settings for the *next* boot; it was never the
     thing that puts data on the relay. Nothing else did either. The
     visible symptom was a session that says TRANSPORT: RELAY and
     STORE STATE: ONLINE while every write silently queues, because
     the relay genuinely has no vault to write to.

     This pushes the vault that is open RIGHT NOW onto the relay: the
     header first (so it exists to authenticate against), then every
     record, via the same code path a disaster-recovery restore uses
     — uploading a vault a relay has never seen is that operation
     with a kinder name. It does not touch the local copy. */
  async function provisionRelay() {
    var url = nodes.url.input.value.trim();
    var tok = nodes.token.input.value.trim();
    if (!url) { status("SET A RELAY URL FIRST", "fail"); return; }
    if (!ctx.store.isUnlocked()) { status("UNLOCK THE VAULT FIRST", "fail"); return; }

    var backup = FieldKit.service("backup");
    if (!backup) { status("BACKUP SERVICE UNAVAILABLE — CANNOT BUILD AN ARCHIVE", "fail"); return; }

    var r = relay();
    r.configure(url, { provisionToken: tok });

    status("CHECKING THE RELAY...", "warn");
    var health;
    try { health = await r.health(); }
    catch (e) { status("RELAY UNREACHABLE — " + e.message, "fail"); return; }

    if (health.vaultProvisioned) {
      status("THIS RELAY ALREADY HAS A VAULT — refusing to overwrite. " +
        "Point it at a fresh relay, or wipe its data dir first if this one is meant to be replaced.", "fail");
      return;
    }
    if (!tok) {
      status("NO PROVISION TOKEN — set the one from this relay's config.json", "fail");
      return;
    }

    status("BUILDING ARCHIVE OF THE OPEN VAULT...", "warn");
    var archive;
    try {
      /* Read from the transport that actually holds the records.
         When a relay is reachable but unprovisioned the store falls
         back to the local copy, so that is where the vault lives —
         and asking the relay for them would fail by definition. */
      archive = await backup.build({ from: ctx.store.transport() });
    } catch (e) { status("COULD NOT READ THE VAULT — " + e.message, "fail"); return; }

    status("UPLOADING HEADER + " + archive.records.length + " RECORD(S)...", "warn");
    try {
      /* The record uploads authenticate as an ordinary client, not
         with the provision token — which is only good for the
         header. The vault is open here, so the token exists. */
      await backup.restoreToTransport(archive, r, function (n, total) {
        status("UPLOADING " + n + " / " + total, "warn");
      }, { token: ctx.store.vault().authToken });
    } catch (e) {
      status("UPLOAD FAILED — " + e.message, "fail");
      return;
    }

    await ctx.store.attachTransport(r);
    settings().set("relayUrl", url);
    settings().set("relayProvisionToken", "");
    nodes.token.input.value = "";

    status(archive.records.length + " RECORD(S) NOW ON THE RELAY — THIS SESSION IS LIVE ON IT", "pass");
    ui.toast("VAULT PROVISIONED ON RELAY", "ok");
  }

  function clearToken() {
    settings().set("relayProvisionToken", "");
    nodes.token.input.value = "";
    relay().configure(nodes.url.input.value.trim(), { provisionToken: "" });
    status("PROVISION TOKEN CLEARED", "pass");
  }

  function selfcheck() {
    return [
      { name: "CONFIG LOADED", critical: false, run: async function () {
        var url = nodes.url.input.value.trim();
        return url ? url : "no relay URL set — configure one here";
      } },
      { name: "STATUS READOUT", critical: false, run: async function () {
        status("SELF-TEST PROBE", "dim");
        if (!/SELF-TEST PROBE/.test(nodes.status.textContent)) {
          throw new Error("status readout did not update");
        }
        status(nodes.url.input.value.trim() ? "READY" : "NO URL SET",
          nodes.url.input.value.trim() ? "pass" : "warn");
        return "renders and clears";
      } },
      /* The provision token is a bearer secret. It must never be
         written to a settings value that gets rendered anywhere, and
         the field must be masked. */
      { name: "TOKEN FIELD IS MASKED", critical: true, run: async function () {
        if (nodes.token.input.type !== "password") {
          throw new Error("provision token field is not a password input");
        }
        return "masked";
      } }
    ];
  }

  FieldKit.register("relay-config", {
    group: "SERVERS",
    about: "Connect this drive to your relay and check the link",
    keywords: "relay url connect link setup provision server",
    selfcheck: selfcheck,
    title: "RELAY LINK",
    icon: "◈",
    width: 560,
    height: 460,

    async mount(host, context) {
      ctx = context;
      ui = ctx.ui;
      el = ui.el;

      var s = settings();
      nodes.url = ui.field("RELAY URL", {
        placeholder: "https://relay.example.ts.net",
        value: s.get("relayUrl") || ""
      });
      nodes.token = ui.field("PROVISION TOKEN (first run only)", {
        type: "password",
        placeholder: "from relay config.json",
        value: s.get("relayProvisionToken") || ""
      });
      nodes.status = el("div");
      nodes.hops = el("div");

      host.appendChild(el("div", {}, [
        ui.panel("LINK CONFIGURATION", [
          nodes.url,
          nodes.token,
          el("p", { class: "rc-note", text:
            "The provision token creates the vault once and is useless afterwards. Clear it when setup is done." }),
          el("div", { class: "rc-actions" }, [
            ui.button("SAVE", saveConfig, { primary: true }),
            ui.button("TEST LINK", testLink),
            ui.button("CLEAR TOKEN", clearToken, { danger: true })
          ]),
          el("p", { class: "rc-note", text:
            "Vault already open and this relay has never seen it? PROVISION pushes " +
            "everything currently in the vault onto it — header and records — without " +
            "a restart. This is the step SAVE does not do." }),
          el("div", { class: "rc-actions" }, [
            ui.button("PROVISION THIS VAULT ON THE RELAY", provisionRelay, { primary: true })
          ]),
          nodes.status
        ]),
        ui.panel("CONNECTION HOPS", [nodes.hops]),
        ui.panel("CURRENT SESSION", [
          ui.readout([
            { label: "TRANSPORT", value: ctx.store.transportName().toUpperCase(),
              level: ctx.store.transportName() === "relay" ? "pass" : "warn" },
            { label: "STORE STATE", value: ctx.store.state(),
              level: ctx.store.state() === "ONLINE" ? "pass" : "warn" },
            { label: "HISTORY READABLE", value: ctx.store.canReadHistory() ? "YES" : "NO (OFFLINE)",
              level: ctx.store.canReadHistory() ? "pass" : "warn" },
            { label: "DEVICE ID", value: ctx.store.deviceId(), level: "dim" }
          ])
        ])
      ]));

      injectCSS();
      status(s.get("relayUrl") ? "CONFIGURED — PRESS TEST LINK" : "NOT CONFIGURED — LOCAL VAULT IN USE",
        s.get("relayUrl") ? "dim" : "warn");
    },

    unmount() { nodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("rc-style")) return;
    var st = document.createElement("style");
    st.id = "rc-style";
    st.textContent = `
.rc-note{color:var(--fg-dimmer);font-size:10px;line-height:1.5;margin:0 0 10px}
.rc-actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
`;
    document.head.appendChild(st);
  }
})(window.FieldKit);
