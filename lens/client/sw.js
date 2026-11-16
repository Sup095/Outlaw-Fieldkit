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
importScripts("/v/scramjet-1.1.0-fk2/scramjet.all.js", "/codec.js");

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
async function pageLeaving() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const slot = all.find((c) => { try { return new URL(c.url).pathname === "/slot.html"; } catch (e) { return false; } });
  if (!slot) return false;
  return new Promise((done) => {
    const ch = new MessageChannel(), t = setTimeout(() => done(false), 500);
    ch.port1.onmessage = (e) => { clearTimeout(t); done(!!(e.data && e.data.leaving)); };
    slot.postMessage({ fk: "sw", t: "leaving?" }, [ch.port2]);
  });
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

async function handleRequest(event) {
  try {
    await scramjet.loadConfig();
    if (scramjet.route(event)) {
      const req = event.request;
      if (SITE && req.mode === "navigate") {
        const to = realOf(req.url);
        if (/^https?:/i.test(to) && L.siteOf(to) !== SITE && await pageLeaving()) return await handOver(to, req);
      }
      return await scramjet.fetch(event);
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
