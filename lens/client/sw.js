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

async function handleRequest(event) {
  try {
    await scramjet.loadConfig();
    if (scramjet.route(event)) return await scramjet.fetch(event);
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
