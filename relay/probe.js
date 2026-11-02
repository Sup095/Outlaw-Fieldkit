/* ============================================================
   FieldKit relay :: probe — what a device will allow

   A plain page anyone can open at /probe, on a school Chromebook or
   anywhere else, that tries what a browser running inside this page
   would need: a service worker, WebAssembly, storage, WebGL, a
   WebSocket. FieldKit itself cannot find out, because a page opened
   from file:// is not allowed a service worker at all. This one is on
   the relay's https address, where the answer means something.

   It reports yes or no for each thing, and the browser's family and
   major version. No name, no address, no page, no account: the answer
   is about the machine's rules, not who was at it. ADMIN CENTER shows
   the last few, and they go when the relay restarts.

     GET  /probe          the page
     GET  /probe/sw.js    the service worker it tries to register
     POST /probe/result   { checks: { name: boolean, ... }, platform, major }
   ============================================================ */
"use strict";

const KEEP = 30;
const CHECKS = ["secure", "sw", "swAnswers", "wasm", "wasmThreads", "indexedDb", "webgl", "webgl2",
  "webcodecs", "isolated", "webSocket", "storageKept"];
const PLATFORMS = ["ChromeOS", "Windows", "macOS", "Linux", "Android", "iOS", "other"];

const results = [];

const SW = `self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  if (new URL(e.request.url).pathname.endsWith("/probe/ping")) {
    e.respondWith(new Response("pong", { headers: { "Content-Type": "text/plain" } }));
  }
});`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FieldKit: what this device allows</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0a0c0b;color:#c2cdc4;font:14px/1.5 ui-monospace,Consolas,monospace;padding:24px 16px}
main{max-width:560px;margin:0 auto}
h1{font-size:15px;letter-spacing:.14em;color:#e0a83e;margin:0 0 6px}
p{margin:6px 0;color:#9aa89e}
ul{list-style:none;padding:0;margin:14px 0}
li{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid #242b27}
.yes{color:#7bc47f}.no{color:#e0705c}.wait{color:#7c8a80}
#done{color:#c2cdc4;margin-top:12px}
</style></head><body><main>
<h1>WHAT THIS DEVICE ALLOWS</h1>
<p>This tries a few things a faster BROWSER would need. It takes a few seconds and changes nothing on this device.</p>
<p>It sends the relay yes or no for each line, and the kind of device. Nothing about you.</p>
<ul id="list"></ul>
<p id="done"></p>
</main><script>
(function () {
  "use strict";
  var NAMES = { secure: "secure page", sw: "service worker registers", swAnswers: "service worker answers",
    wasm: "WebAssembly", wasmThreads: "WebAssembly threads", indexedDb: "storage (IndexedDB)", webgl: "WebGL",
    webgl2: "WebGL 2", webcodecs: "video decoding", isolated: "cross-origin isolation", webSocket: "WebSocket to this relay",
    storageKept: "storage can be kept" };
  var out = {};
  var list = document.getElementById("list");
  function show(k, v) {
    out[k] = !!v;
    var li = document.createElement("li");
    var a = document.createElement("span"); a.textContent = NAMES[k];
    var b = document.createElement("span"); b.textContent = v ? "yes" : "no"; b.className = v ? "yes" : "no";
    li.appendChild(a); li.appendChild(b); list.appendChild(li);
  }
  function limit(p, ms) {
    return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(false); }, ms); })]).catch(function () { return false; });
  }
  async function sw() {
    if (!navigator.serviceWorker) return [false, false];
    var reg;
    try { reg = await navigator.serviceWorker.register("/probe/sw.js", { scope: "/probe/" }); } catch (e) { return [false, false]; }
    var worker = reg.installing || reg.waiting || reg.active;
    if (worker && worker.state !== "activated") {
      await new Promise(function (r) {
        worker.addEventListener("statechange", function () { if (worker.state === "activated") r(); });
        setTimeout(r, 4000);
      });
    }
    var frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.src = "/probe/blank";
    document.body.appendChild(frame);
    await new Promise(function (r) { frame.onload = r; setTimeout(r, 3000); });
    var ok = false;
    try { ok = await limit(frame.contentWindow.fetch("/probe/ping").then(function (x) { return x.text(); }).then(function (t) { return t === "pong"; }), 3000); } catch (e) { ok = false; }
    frame.remove();
    await reg.unregister().catch(function () {});
    return [true, ok];
  }
  function gl(kind) {
    try { return !!document.createElement("canvas").getContext(kind); } catch (e) { return false; }
  }
  function wasmThreads() {
    try {
      var m = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      return typeof SharedArrayBuffer === "function" && m.buffer instanceof SharedArrayBuffer;
    } catch (e) { return false; }
  }
  function idb() {
    return new Promise(function (r) {
      try {
        var q = indexedDB.open("fk-probe");
        q.onsuccess = function () { q.result.close(); indexedDB.deleteDatabase("fk-probe"); r(true); };
        q.onerror = function () { r(false); };
      } catch (e) { r(false); }
    });
  }
  function ws() {
    return new Promise(function (r) {
      try {
        var s = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws-check");
        s.onmessage = function () { s.close(); r(true); };
        s.onerror = function () { r(false); };
      } catch (e) { r(false); }
    });
  }
  function platform() {
    var u = navigator.userAgent;
    if (/CrOS/.test(u)) return "ChromeOS";
    if (/Android/.test(u)) return "Android";
    if (/iPhone|iPad/.test(u)) return "iOS";
    if (/Windows/.test(u)) return "Windows";
    if (/Mac OS/.test(u)) return "macOS";
    if (/Linux/.test(u)) return "Linux";
    return "other";
  }
  (async function () {
    show("secure", window.isSecureContext);
    var s = await limit(sw(), 12000);
    show("sw", s && s[0]);
    show("swAnswers", s && s[1]);
    show("wasm", typeof WebAssembly === "object");
    show("wasmThreads", wasmThreads());
    show("indexedDb", await limit(idb(), 3000));
    show("webgl", gl("webgl"));
    show("webgl2", gl("webgl2"));
    show("webcodecs", typeof VideoDecoder === "function");
    show("isolated", !!window.crossOriginIsolated);
    show("webSocket", await limit(ws(), 5000));
    show("storageKept", !!(navigator.storage && navigator.storage.persist));
    var m = /Chrome\\/(\\d+)/.exec(navigator.userAgent);
    var done = document.getElementById("done");
    try {
      var r = await fetch("/probe/result", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checks: out, platform: platform(), major: m ? Number(m[1]) : 0 }) });
      done.textContent = r.ok ? "Done. Thanks: you can close this." : "Finished, but the relay did not take the answer. Nothing is wrong with this device.";
    } catch (e) { done.textContent = "Finished, but the answer did not reach the relay."; }
  })();
})();
</script></body></html>`;

function clean(body) {
  const checks = {};
  const given = (body && body.checks) || {};
  for (const k of CHECKS) checks[k] = given[k] === true;
  const major = Number(body && body.major);
  return { at: Date.now(), checks,
    platform: PLATFORMS.indexOf(body && body.platform) >= 0 ? body.platform : "other",
    major: Number.isInteger(major) && major > 0 && major < 1000 ? major : 0 };
}

/* helpers: { send, readBody, sendRaw(res, status, type, text, headers) } */
async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "probe") return false;
  const what = seg[1] || "";
  /* What cross-origin isolation asks for, so that line can say yes. */
  const ISOLATED = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  if (req.method === "GET" && !what) { helpers.sendRaw(res, 200, "text/html; charset=utf-8", PAGE, ISOLATED); return true; }
  if (req.method === "GET" && what === "sw.js") { helpers.sendRaw(res, 200, "text/javascript", SW, { "Service-Worker-Allowed": "/probe/" }); return true; }
  if (req.method === "GET" && what === "blank") { helpers.sendRaw(res, 200, "text/html; charset=utf-8", "<!doctype html><title>probe</title>", ISOLATED); return true; }
  if (req.method === "POST" && what === "result") {
    const body = await helpers.readBody(req).catch(() => null);
    if (!body) { helpers.send(res, 400, { error: "expected a JSON body" }); return true; }
    results.unshift(clean(body));
    if (results.length > KEEP) results.pop();
    helpers.send(res, 200, { ok: true });
    return true;
  }
  helpers.send(res, 404, { error: "no such route" });
  return true;
}

module.exports = { route, list: () => results.slice(), CHECKS };
