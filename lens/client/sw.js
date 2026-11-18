/* FieldKit lens :: the service worker. Scramjet's, as its own example
   app has it: requests under its prefix are rewritten and fetched over
   the transport (Wisp, through FieldKit's lens server); anything else
   is this site's own files.

   A request straight to another site is one Scramjet failed to rewrite
   (an icon set from a page's script, a picture in a style it built).
   Let through, it would go from this computer to that site in plain
   sight, carrying the real address the lens is meant to keep apart. A
   picture, a font, a sound or a style is fetched through the lens as if
   it had been rewritten; anything else (a script, a page, a worker) is
   refused as a broken link would be, since it would run unwatched. A
   request cut short (a page stopped, a frame closed) ends quietly. */
importScripts("/v/scramjet-1.1.0-fk4/scramjet.all.js", "/codec.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const L = self.FK_LENS;
const RESCUE = ["image", "font", "audio", "video", "track", "style", "manifest"];

/* ANOTHER SITE'S PAGE, ASKED FOR IN THIS SLOT (0.20.2). The slot registers
   this worker as /sw.js?site=<its site>. When the slot's page moves to
   another site (a link, a form, a redirect: every sign-in with Google,
   Microsoft, Discord and the like), that request is not sent from here.
   Sent from here it would carry this slot's cookies, not that site's, and
   a sign-in code in it would be spent in the wrong space, so the right
   one then failed with "code already used". The page gets a small note
   instead, which hands the address (and a form's fields, for a sign-in
   that comes back as a form post) to the lens page, which opens it once,
   in that site's own slot. Frames inside a page (a video, a sign-in
   button) are left alone: the slot answers whether its page is the one
   leaving, and a slot that does not answer in time counts as no. */
const SITE = new URL(self.location.href).searchParams.get("site") || "";
const FORM = "application/x-www-form-urlencoded";

function realOf(href) {
  try {
    const u = new URL(href);
    if (u.origin !== self.location.origin || u.pathname.indexOf(L.PREFIX) !== 0) return "";
    return L.CODEC.decode(u.pathname.slice(L.PREFIX.length) + u.search + u.hash);
  } catch (e) { return ""; }
}
/* Every slot page of this site is asked (FieldKit open twice on the same
   site is two of them); one that is leaving is enough. */
async function pageLeaving() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const slots = all.filter((c) => { try { return new URL(c.url).pathname === "/slot.html"; } catch (e) { return false; } });
  const ask = (slot) => new Promise((done) => {
    const ch = new MessageChannel(), t = setTimeout(() => done(false), 500);
    ch.port1.onmessage = (e) => { clearTimeout(t); done(!!(e.data && e.data.leaving)); };
    try { slot.postMessage({ fk: "sw", t: "leaving?" }, [ch.port2]); } catch (e) { clearTimeout(t); done(false); }
  });
  return (await Promise.all(slots.map(ask))).some(Boolean);
}
async function handOver(to, req) {
  let post = null;
  if (req.method === "POST") {
    const type = String(req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const body = await req.clone().text();
    if (type === FORM && body.length <= 65536) post = { body, ctype: FORM };
  }
  const msg = JSON.stringify({ fk: "slot-sw", t: "foreign", url: to, post }).replace(/</g, "\\u003c");
  return new Response("<!doctype html><meta charset=utf-8><script>parent.postMessage(" + msg + ", location.origin)</script>", {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" } });
}

/* A PAGE THAT COULD NOT BE REACHED (0.20.3). When the connection to the
   lens server is away (a laptop waking up, a network change, the server
   restarting), Scramjet answered a page with its own error screen, titled
   "Scramjet", with a code and a stack, and nothing tried again. A page the
   person asked for gets a short note instead that tries again by itself
   (after 3, 5, 10, 20, 30 and 60 s) and has a button to try at once. */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function friendlier(res, req) {
  if (res.status !== 500 || req.mode !== "navigate" || req.method !== "GET" || !/text\/html/.test(res.headers.get("content-type") || "")) return res;
  let text = "";
  try { text = await res.clone().text(); } catch (e) { return res; }
  if (text.indexOf("<title>Scramjet</title>") < 0) return res;
  const host = (() => { try { return new URL(realOf(req.url)).hostname; } catch (e) { return "this site"; } })();
  const why = (/Message: ([^\n<]{0,200})/.exec(text) || [])[1] || "";
  /* What went wrong decides what is said, and whether trying again helps:
     a secure connection the lens cannot make (libcurl 35, 60 and the like:
     a site whose encryption it does not speak) and a name that does not
     exist will not come right by themselves; a dropped connection will. */
  const code = Number((/error code (\d+)/.exec(why) || [])[1] || 0);
  const kind = [35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91].indexOf(code) >= 0 || /SSL|TLS|certificate/i.test(why) ? "tls"
    : code === 6 || /resolve host/i.test(why) ? "dns" : "net";
  const head = kind === "tls" ? "The lighter mode cannot open " + host + " securely" : kind === "dns" ? host + " was not found" : host + " did not answer";
  const say = kind === "tls" ? "This site uses a kind of secure connection the lighter mode cannot make. Open it in BROWSER's FULL MODE if you have it, or in your own browser."
    : kind === "dns" ? "There is no site at this address. Check the spelling."
    : "The connection dropped for a moment (often after the computer wakes up or changes network). Trying again…";
  const key = JSON.stringify("fk-retry:" + req.url);
  const page = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>" + escapeHtml(host) + "</title>" +
    "<body style='font:15px/1.5 system-ui,sans-serif;margin:0;padding:40px 24px;background:#1e1f22;color:#e6e6e6'>" +
    "<div style='max-width:560px;margin:auto'><h2 style='margin:0 0 8px'>" + escapeHtml(head) + "</h2>" +
    "<p id=say>" + escapeHtml(say) + "</p>" +
    "<p><button id=now style='font:inherit;padding:8px 16px;cursor:pointer'>TRY AGAIN</button></p>" +
    "<p style='opacity:.55;font-size:12px'>" + escapeHtml(why) + "</p></div><script>" +
    "var k=" + key + ",n=0;try{var v=String(sessionStorage.getItem(k)||'0|0').split('|');n=Date.now()-Number(v[1])<120000?Number(v[0])||0:0}catch(e){}" +
    "function again(){try{sessionStorage.setItem(k,(n+1)+'|'+Date.now())}catch(e){}location.reload()}" +
    "document.getElementById('now').onclick=function(){n=0;again()};" +
    (kind !== "net" ? "" :
    "var waits=[3,5,10,20,30,60];if(n<waits.length){var s=waits[n];document.getElementById('say').textContent='The connection dropped for a moment (often after the computer wakes up or changes network). Trying again in '+s+' s…';setTimeout(again,s*1000)}" +
    "else{document.getElementById('say').textContent='It still does not answer. The site may be down or blocked here, or this network may be blocking the lens.'}") +
    "</script></body>";
  return new Response(page, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" } });
}

async function handleRequest(event) {
  try {
    await scramjet.loadConfig();
    if (scramjet.route(event)) {
      const req = event.request;
      if (SITE && req.mode === "navigate") {
        const to = realOf(req.url);
        if (/^https?:/i.test(to) && L.siteOf(to) !== SITE && await pageLeaving()) return await handOver(to, req);
      }
      return await friendlier(await scramjet.fetch(event), req);
    }
    const req = event.request, u = new URL(req.url);
    if (u.origin === self.location.origin) return await fetch(req);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || req.method !== "GET" || RESCUE.indexOf(req.destination) < 0) return Response.error();
    const through = new Request(self.location.origin + L.PREFIX + L.CODEC.encode(u.href), { method: "GET", headers: req.headers });
    return await scramjet.fetch({ request: through, clientId: event.clientId });
  } catch (e) {
    return Response.error();
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
