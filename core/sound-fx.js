/* ============================================================
   FieldKit :: sound-fx
   Terminal beeps and mechanical clicks (§6). OFF by default.

   Synthesised with WebAudio rather than shipped as files: no
   assets on the drive, no decode cost, and the tones retune
   trivially. The AudioContext is created lazily and only after a
   user gesture, because browsers refuse to start one otherwise.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var actx = null, master = null, unlocked = false;

  function enabled() {
    var s = FieldKit.service("settings");
    return !!(s && s.get("sound"));
  }

  function ensureContext() {
    if (actx) return actx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.16;          // deliberately quiet
      master.connect(actx.destination);
    } catch (e) {
      FieldKit.log("warn", "sound-fx", "could not create audio context: " + e.message);
      actx = null;
    }
    return actx;
  }

  /* A short shaped tone. Envelope matters more than waveform for
     making this read as "terminal" rather than "video game". */
  function tone(freq, ms, type, gain, sweepTo) {
    if (!enabled()) return;
    var ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(function () {});

    var t0 = ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();

    osc.type = type || "square";
    osc.frequency.setValueAtTime(freq, t0);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + ms / 1000);

    var peak = (gain === undefined ? 0.5 : gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);

    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  }

  /* Filtered noise burst — a keyswitch, not a tone. */
  function click(intensity) {
    if (!enabled()) return;
    var ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(function () {});

    var dur = 0.035;
    var frames = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 7);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;

    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1900 + Math.random() * 700;
    bp.Q.value = 1.1;

    var g = ctx.createGain();
    g.gain.value = (intensity === undefined ? 0.6 : intensity);

    src.connect(bp); bp.connect(g); g.connect(master);
    src.start();
  }

  var SFX = {
    beep:    function () { tone(880, 70, "square", 0.35); },
    ok:      function () { tone(660, 60, "square", 0.3); setTimeout(function () { tone(990, 90, "square", 0.3); }, 65); },
    warn:    function () { tone(420, 130, "sawtooth", 0.3); },
    error:   function () { tone(260, 220, "sawtooth", 0.35, 110); },
    open:    function () { tone(520, 55, "triangle", 0.3, 780); },
    close:   function () { tone(520, 55, "triangle", 0.25, 300); },
    key:     function () { click(0.5); },
    boot:    function () {
      [0, 90, 180].forEach(function (d, i) {
        setTimeout(function () { tone(440 + i * 220, 70, "square", 0.28); }, d);
      });
    },
    unlock:  function () {
      [0, 70, 140, 220].forEach(function (d, i) {
        setTimeout(function () { tone(330 + i * 165, 85, "triangle", 0.3); }, d);
      });
    }
  };

  /* Wire to shell and toast events so modules never call sound
     directly — the effect stays a system-level concern. */
  FieldKit.on("shell:open", function () { SFX.open(); });
  FieldKit.on("shell:close", function () { SFX.close(); });
  FieldKit.on("boot:done", function () { SFX.boot(); });
  FieldKit.on("achievement:unlocked", function () { SFX.unlock(); });
  FieldKit.on("store:state", function (e) {
    if (!e) return;
    if (e.state === "ONLINE") SFX.ok();
    else if (e.state === "OFFLINE") SFX.warn();
  });

  /* Browsers only allow audio to start after a gesture; the boot
     screen's "press any key" already provides one, but a listener
     here means the context resumes if the user interacted later. */
  function markUnlocked() {
    if (unlocked) return;
    unlocked = true;
    if (enabled()) ensureContext();
  }
  window.addEventListener("keydown", markUnlocked, { once: true });
  window.addEventListener("pointerdown", markUnlocked, { once: true });

  FieldKit.provide("sound", Object.assign({}, SFX, {
    enabled: enabled,
    tone: tone,
    click: click,
    /* Used by the settings panel to preview without toggling. */
    test: function () {
      var s = FieldKit.service("settings");
      var was = s.get("sound");
      s.set("sound", true);
      SFX.unlock();
      if (!was) setTimeout(function () { s.set("sound", false); }, 700);
    },
    available: function () { return !!(window.AudioContext || window.webkitAudioContext); }
  }));
})(window.FieldKit);
