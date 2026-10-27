/* ============================================================
   FieldKit :: ambient-fx
   Drifting particles behind the desktop (§6).

   Canvas 2D, not WebGL — deliberately. The Phase 0 diagnostic
   found the target Chromebook has NO WebGL while WebGPU works,
   which is an unusual combination and would have made a WebGL
   implementation silently fall back to software rendering (§2C).

   Off by default. Gated on the performance budget, so a 4 GB
   Chromebook never runs it unless explicitly forced, and it
   pauses entirely when the tab is hidden.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var canvas = null, gctx = null, raf = null, particles = [], running = false;
  var lastFrame = 0, hidden = false;

  function settings() { return FieldKit.service("settings"); }

  function densityFor(budget, w, h) {
    var area = w * h;
    if (budget === "minimal") return 0;
    if (budget === "reduced") return Math.min(40, Math.round(area / 42000));
    return Math.min(110, Math.round(area / 16000));
  }

  function accent() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--accent-glow").trim();
    return v || "224,166,60";
  }

  function makeParticle(w, h, seedTop) {
    return {
      x: Math.random() * w,
      y: seedTop ? Math.random() * h : h + Math.random() * 40,
      r: 0.4 + Math.random() * 1.5,
      vy: -(4 + Math.random() * 16) / 1000,       // px per ms, upward drift
      vx: (Math.random() - 0.5) * 6 / 1000,
      a: 0.06 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2,
      wob: 0.2 + Math.random() * 0.8
    };
  }

  function resize() {
    if (!canvas) return;
    var host = canvas.parentNode;
    var w = host ? host.clientWidth : window.innerWidth;
    var h = host ? host.clientHeight : window.innerHeight;
    /* Cap the backing store on low-DPI-but-large screens; the
       effect is subtle enough that 1x is fine. */
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    var target = densityFor(settings().perfBudget(), w, h);
    particles = [];
    for (var i = 0; i < target; i++) particles.push(makeParticle(w, h, true));
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (hidden) { lastFrame = now; return; }

    var dt = lastFrame ? Math.min(now - lastFrame, 60) : 16;
    lastFrame = now;

    var w = canvas.width, h = canvas.height;
    gctx.clearRect(0, 0, w, h);
    var rgb = accent();

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.y += p.vy * dt;
      p.x += p.vx * dt + Math.sin((now / 1400) + p.phase) * p.wob * (dt / 1000) * 8;

      if (p.y < -10) {
        particles[i] = makeParticle(w, h, false);
        continue;
      }
      if (p.x < -10) p.x = w + 10;
      else if (p.x > w + 10) p.x = -10;

      gctx.beginPath();
      gctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      gctx.fillStyle = "rgba(" + rgb + "," + p.a.toFixed(3) + ")";
      gctx.fill();
    }
  }

  function start() {
    if (running) return false;
    if (!settings().get("ambient")) return false;
    if (settings().perfBudget() === "minimal") {
      FieldKit.log("info", "ambient-fx", "suppressed — performance budget is minimal");
      return false;
    }

    var shell = FieldKit.service("shell");
    var desktop = shell && shell.desktop();
    if (!desktop) return false;

    canvas = document.createElement("canvas");
    canvas.id = "fk-ambient";
    try { gctx = canvas.getContext("2d"); } catch (e) { gctx = null; }
    if (!gctx) {
      FieldKit.log("warn", "ambient-fx", "canvas 2d unavailable");
      canvas = null;
      return false;
    }

    injectCSS();
    desktop.insertBefore(canvas, desktop.firstChild);
    resize();

    running = true;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    FieldKit.log("info", "ambient-fx", "running with " + particles.length + " particles");
    return true;
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    gctx = null;
    particles = [];
  }

  function onVisibility() { hidden = document.hidden; }

  function refresh() {
    stop();
    if (settings().get("ambient")) start();
  }

  /* React to the toggle in the settings panel without a reload. */
  FieldKit.on("settings:changed", function (e) {
    if (e && (e.key === "ambient" || e.key === "perfMode")) refresh();
  });
  FieldKit.on("boot:done", function () {
    if (FieldKit.service("settings").get("ambient")) start();
  });

  function injectCSS() {
    if (document.getElementById("fx-style")) return;
    var s = document.createElement("style");
    s.id = "fx-style";
    s.textContent = `
#fk-ambient{position:absolute;inset:0;pointer-events:none;z-index:0}
@media (prefers-reduced-motion: reduce){ #fk-ambient{display:none} }
`;
    document.head.appendChild(s);
  }

  FieldKit.provide("ambientFx", {
    start: start,
    stop: stop,
    refresh: refresh,
    isRunning: function () { return running; },
    count: function () { return particles.length; }
  });
})(window.FieldKit);
