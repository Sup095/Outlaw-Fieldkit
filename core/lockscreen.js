/* ============================================================
   FieldKit :: lockscreen
   PIN screen lock for an already-open session.

   What this is: a barrier against someone walking up to an unlocked
   machine. Ctrl+L, or an idle timeout, drops a full-screen gate that
   needs a short PIN to clear.

   What this is NOT: a second layer of encryption. The vault is
   already open in memory when the screen locks, and the PIN hash
   lives inside that same vault — so it can only be checked while
   unlocked. That is fine for the threat it addresses and worthless
   against anyone who takes the drive, and the UI says so rather than
   implying more.

   The one real control: after MAX_ATTEMPTS the session is destroyed
   and the page reloads, forcing the master password again. Guessing
   a four-digit PIN is only cheap if you get unlimited tries.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "security";
  var KIND = "screenlock";
  var ITERATIONS = 200000;
  var MAX_ATTEMPTS = 5;
  var MIN_PIN = 4;
  var MAX_PIN = 12;

  var ui = FieldKit.need("ui");
  var el = ui.el;

  var overlay = null;
  var locked = false;
  var attempts = 0;
  var idleTimer = null;
  var cachedRecord = undefined;   // undefined = not looked up yet

  function store() { return FieldKit.service("store"); }
  function crypto_() { return FieldKit.need("crypto"); }

  /* ---- PIN record --------------------------------------------- */
  async function record() {
    if (cachedRecord !== undefined) return cachedRecord;
    var s = store();
    if (!s || !s.isUnlocked()) return (cachedRecord = null);
    try {
      var rows = await s.list(TYPE);
      var hit = rows.find(function (r) { return r.data && r.data.kind === KIND; });
      cachedRecord = hit || null;
    } catch (e) {
      cachedRecord = null;
    }
    return cachedRecord;
  }

  async function hasPin() { return !!(await record()); }

  async function derive(pin, saltB64, iterations) {
    var c = crypto_();
    var salt = c.fromB64(saltB64);
    var bits = await c.pbkdf2Bits(String(pin), salt, iterations);
    return c.toHex(bits);
  }

  async function setPin(pin) {
    pin = String(pin || "");
    if (!/^\d+$/.test(pin)) throw new Error("PIN must be digits only");
    if (pin.length < MIN_PIN || pin.length > MAX_PIN) {
      throw new Error("PIN must be " + MIN_PIN + "-" + MAX_PIN + " digits");
    }
    var c = crypto_();
    var saltB64 = c.toB64(c.randomBytes(16));
    var hash = await derive(pin, saltB64, ITERATIONS);

    var existing = await record();
    await store().put(TYPE, {
      kind: KIND, salt: saltB64, hash: hash, iterations: ITERATIONS,
      setAt: new Date().toISOString()
    }, { id: existing ? existing.id : undefined });

    cachedRecord = undefined;      // force a re-read next time
    FieldKit.log("info", "lockscreen", "screen lock PIN set");
    return true;
  }

  async function clearPin() {
    var existing = await record();
    if (existing) await store().remove(existing.id);
    cachedRecord = undefined;
    FieldKit.log("info", "lockscreen", "screen lock PIN cleared");
    return true;
  }

  async function verify(pin) {
    var rec = await record();
    if (!rec) return false;
    var got = await derive(pin, rec.data.salt, rec.data.iterations || ITERATIONS);
    return constantTimeEqual(got, rec.data.hash || "");
  }

  function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* ---- the gate ----------------------------------------------- */
  function burn(reason) {
    FieldKit.log("warn", "lockscreen", "session destroyed: " + reason);
    /* Reload is the whole point — it throws away the decrypted vault
       along with everything else in memory. */
    location.reload();
  }

  async function engage(opts) {
    opts = opts || {};
    if (locked) return;

    var s = store();
    if (!s || !s.isUnlocked()) return;              // nothing to protect yet
    if (!(await hasPin()) && !opts.force) {
      ui.toast("NO PIN SET — CONFIGURE ONE IN SETTINGS", "warn");
      return;
    }

    locked = true;
    attempts = 0;
    stopIdleTimer();
    injectCSS();

    var desktop = document.getElementById("fk-desktop");
    if (desktop) {
      desktop.classList.add("fk-blurred");
      /* inert keeps focus and clicks out of the app behind the gate;
         the overlay alone would only stop the mouse. */
      try { desktop.inert = true; } catch (e) { /* older engine, overlay still covers */ }
    }

    var input = el("input", {
      class: "lk-pin", type: "password", inputmode: "numeric",
      autocomplete: "off", spellcheck: "false", maxlength: String(MAX_PIN),
      "aria-label": "screen lock PIN"
    });
    var msg = el("div", { class: "lk-msg", text: opts.reason || "SESSION LOCKED" });
    var dots = el("div", { class: "lk-dots" });

    function renderDots() {
      ui.clear(dots);
      var n = input.value.length;
      for (var i = 0; i < Math.max(MIN_PIN, n); i++) {
        dots.appendChild(el("span", { class: "lk-dot" + (i < n ? " on" : "") }));
      }
    }

    async function submit() {
      var val = input.value;
      if (!val) return;
      input.disabled = true;
      msg.textContent = "CHECKING";
      msg.className = "lk-msg lk-dim";

      var ok = false;
      try { ok = await verify(val); }
      catch (e) { ok = false; }

      if (ok) { release(); return; }

      attempts++;
      input.value = "";
      renderDots();
      var left = MAX_ATTEMPTS - attempts;
      if (left <= 0) {
        msg.textContent = "TOO MANY ATTEMPTS — TERMINATING SESSION";
        msg.className = "lk-msg lk-fail";
        setTimeout(function () { burn("pin attempts exhausted"); }, 900);
        return;
      }
      msg.textContent = "INCORRECT — " + left + " ATTEMPT" + (left === 1 ? "" : "S") + " REMAINING";
      msg.className = "lk-msg lk-fail";
      input.disabled = false;
      input.focus();
    }

    input.addEventListener("input", function () {
      input.value = input.value.replace(/\D/g, "");
      renderDots();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    overlay = el("div", { id: "fk-lock" }, [
      el("div", { class: "lk-panel" }, [
        el("div", { class: "lk-brand", text: "FIELDKIT" }),
        el("div", { class: "lk-sub", text: "SESSION LOCKED" }),
        dots,
        input,
        msg,
        el("div", { class: "lk-actions" }, [
          ui.button("UNLOCK", submit, { primary: true }),
          ui.button("END SESSION", function () {
            if (confirm("End the session and return to the master password?")) {
              burn("user ended session from lock screen");
            }
          }, { danger: true })
        ]),
        el("div", { class: "lk-note", text:
          "The vault is still open in memory behind this screen. This stops someone " +
          "at the keyboard, not someone who takes the drive — use END SESSION for that." })
      ])
    ]);

    document.body.appendChild(overlay);
    renderDots();
    input.focus();
    FieldKit.emit("lock:engaged", {});
  }

  /* `inert` on #fk-desktop stops focus and clicks reaching the app,
     but it does nothing about listeners bound to `window` — and two
     of those exist by design, the command palette's Ctrl+K and the
     easter-egg watcher. Both fired straight through the lock. The
     palette even rendered *under* the overlay, so SYNC NOW and
     shell.open() ran against the unlocked vault with no visible
     sign anything had happened.

     Guarding each listener individually is the wrong shape: it puts
     the lock's rule in files that should not know the lock exists
     (easter-eggs.js is explicitly forbidden from reaching for it).
     One capture-phase swallow here covers every listener that will
     ever be added, because lockscreen.js loads before them all and
     a capture listener registered first runs first.

     Keystrokes originating inside the overlay are let through —
     that is the PIN field, which obviously still needs them. */
  function swallowKeys(e) {
    if (!locked) return;
    if (overlay && overlay.contains && overlay.contains(e.target)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  window.addEventListener("keydown", swallowKeys, true);
  window.addEventListener("keypress", swallowKeys, true);
  window.addEventListener("keyup", swallowKeys, true);

  function release() {
    if (!locked) return;
    locked = false;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    var desktop = document.getElementById("fk-desktop");
    if (desktop) {
      desktop.classList.remove("fk-blurred");
      try { desktop.inert = false; } catch (e) { /* nothing to undo */ }
    }
    startIdleTimer();
    FieldKit.emit("lock:released", {});
    ui.toast("SESSION RESUMED", "ok");
  }

  /* ---- idle auto-lock ----------------------------------------- */
  var ACTIVITY = ["mousedown", "keydown", "wheel", "touchstart"];

  function stopIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function startIdleTimer() {
    stopIdleTimer();
    var settings = FieldKit.service("settings");
    var mins = settings ? Number(settings.get("autoLockMinutes")) || 0 : 0;
    if (!mins || locked) return;
    idleTimer = setTimeout(function () {
      hasPin().then(function (yes) {
        if (yes) engage({ reason: "LOCKED AFTER " + mins + " MIN IDLE" });
        else startIdleTimer();
      });
    }, mins * 60000);
  }

  function bump() { if (!locked) startIdleTimer(); }

  /* ---- wiring ------------------------------------------------- */
  function init() {
    ACTIVITY.forEach(function (evt) {
      window.addEventListener(evt, bump, { passive: true, capture: true });
    });
    window.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        hasPin().then(function (yes) {
          if (yes) engage({});
          else ui.toast("NO PIN SET — CONFIGURE ONE IN SETTINGS", "warn");
        });
      }
    });
    FieldKit.on("settings:changed", function (e) {
      if (e && e.key === "autoLockMinutes") startIdleTimer();
    });
    /* A vault change means the PIN record may have changed with it. */
    FieldKit.on("store:ready", function () { cachedRecord = undefined; startIdleTimer(); });
    startIdleTimer();
  }

  function injectCSS() {
    if (document.getElementById("lk-style")) return;
    var s = document.createElement("style");
    s.id = "lk-style";
    s.textContent = `
#fk-desktop.fk-blurred{filter:blur(7px) saturate(.55) brightness(.5);pointer-events:none}
#fk-lock{position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at center,rgba(10,12,11,.86),rgba(6,8,7,.97))}
#fk-lock::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,.16) 0 1px,transparent 1px 3px)}
.lk-panel{position:relative;width:340px;max-width:calc(100vw - 32px);padding:26px 24px;
  border:1px solid var(--accent-dim);background:rgba(15,18,17,.96);text-align:center;
  box-shadow:0 0 0 1px rgba(var(--accent-glow),.12),0 24px 70px rgba(0,0,0,.8)}
.lk-brand{color:var(--accent);letter-spacing:.42em;font-size:13px;font-weight:700;
  text-shadow:0 0 16px rgba(var(--accent-glow),.4)}
.lk-sub{color:var(--fg-dimmer);letter-spacing:.28em;font-size:9px;margin-top:5px}
.lk-dots{display:flex;justify-content:center;gap:8px;margin:20px 0 14px;min-height:9px}
.lk-dot{width:9px;height:9px;border:1px solid var(--line2);border-radius:50%}
.lk-dot.on{background:var(--accent);border-color:var(--accent);
  box-shadow:0 0 8px rgba(var(--accent-glow),.6)}
.lk-pin{width:100%;background:#0b0e0c;border:1px solid var(--line2);color:var(--fg);
  padding:10px;text-align:center;letter-spacing:.7em;font-family:var(--mono);font-size:16px}
.lk-pin:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 1px rgba(var(--accent-glow),.3)}
.lk-pin:disabled{opacity:.5}
.lk-msg{min-height:1.5em;margin:12px 0 4px;font-size:10px;letter-spacing:.14em;color:var(--fg-dim)}
.lk-msg.lk-fail{color:var(--fail)}
.lk-msg.lk-dim{color:var(--fg-dimmer)}
.lk-actions{display:flex;gap:6px;margin-top:6px}
.lk-actions .fk-btn{flex:1}
.lk-note{margin-top:16px;font-size:9px;line-height:1.6;color:var(--fg-dimmer);text-align:left;
  border-left:2px solid var(--line2);padding-left:9px}
@media (prefers-reduced-motion: reduce){
  #fk-desktop.fk-blurred{filter:brightness(.4)}
}
`;
    document.head.appendChild(s);
  }

  FieldKit.provide("lockscreen", {
    init: init,
    engage: engage,
    release: release,
    setPin: setPin,
    clearPin: clearPin,
    hasPin: hasPin,
    verify: verify,
    isLocked: function () { return locked; },
    MIN_PIN: MIN_PIN,
    MAX_PIN: MAX_PIN,
    MAX_ATTEMPTS: MAX_ATTEMPTS
  });
})(window.FieldKit);
