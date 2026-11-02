/* FieldKit lens :: the service worker. Scramjet's, as its own example
   app has it: requests under its prefix are rewritten and fetched over
   the transport (Wisp, through FieldKit's lens server); anything else
   is this site's own files. */
importScripts("/v/scramjet-1.1.0-fk1/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
