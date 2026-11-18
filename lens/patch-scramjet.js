"use strict";
/* FieldKit lens :: our fixes to Scramjet 1.1.0, made when the image is built.

   1. The cookie wait. Scramjet's service worker, on a response that sets
      a cookie for a script or a stylesheet, posts the cookie to the page
      that asked and WAITS for the page to answer. But a browser holds
      messages to a page's navigator.serviceWorker until that page has
      finished parsing, and a script in <head> stops the parsing until it
      arrives: each waits for the other and the page stays white.
      Wikipedia, and any site whose scripts come with a cookie, did
      exactly this. The fix: do not wait. The worker still keeps the
      cookie in its own store (the next request carries it) and still
      tells the page, which hears it as soon as parsing ends.

   2. The empty url(). Scramjet finds a stylesheet's addresses with
      /url\(['"]?(.+?)['"]?\)/, which needs at least one character, so on
      an empty url() (YouTube writes var(--x,url()) in its main
      stylesheet) it takes the closing bracket for the address and
      swallows it. The bracket left open hides every rule after it: half
      of YouTube's stylesheet was lost and the site came up unstyled. The
      fix: an empty url(), url("") or url('') is left alone.

   3. A module script made by a page's own code. Scramjet marks every
      module's address with ?type=module (its worker then rewrites the
      file as a module), in the page's HTML and in import statements,
      but not when a script asks for one with setAttribute("src") or
      .src. So a module the page adds itself, then imports again from
      another module, has two addresses: the browser runs it twice and
      the two copies do not share anything. CrazyGames' game frame adds
      its bundle this way and stopped with "useContext of null" (two
      Reacts), so no game started. The fix: such a src gets the mark
      too, when the script is already type="module".

   4. No Referer on a frame. Scramjet's worker writes the Referer from
      the window that asked; a frame being loaded has no such window
      yet, so frames went out with no Referer at all. CrazyGames' game
      files answer that with "Sorry, you have been blocked". The fix:
      a page or frame being loaded takes its Referer from the address
      the browser gives as its referrer (the lens address of the page
      around it, read back to the real site), as a browser would send.

   5. A WebSocket's subprotocol. Scramjet's WebSocket keeps protocol ""
      for ever, even when the server accepted the one asked for. Photon
      (the multiplayer behind many CrazyGames games) asks for
      GpBinaryV16 and does not go on without it. The fix: when the
      socket opens, protocol is what it opened with (with
      patch-libcurl.js, which passes it on).

   6. A WebSocket message from the wrong window. Scramjet hands a binary
      message over as an ArrayBuffer (or Blob) of the window its own code
      came from, which for a frame inside a frame is not the frame's.
      "data instanceof ArrayBuffer" is then false in the game, and
      Photon throws every message away: CrazyGames' multiplayer games
      sat at "Loading..." for ever. The fix: the frame's own ArrayBuffer
      and Blob.

   Usage: node patch-scramjet.js <scramjet.all.js>. Refuses, and so fails
   the build, if any code it fixes is not there exactly once: a new
   Scramjet must be looked at again, not patched blind. */
const fs = require("fs");

const BEFORE = '"document"!==n&&"iframe"!==n&&await r';
const AFTER = '"document"!==n&&"iframe"!==n&&void r';

const CSS_BEFORE = "replace(/url\\(['\"]?(.+?)['\"]?\\)/gm,";
const CSS_AFTER = "replace(/url\\((?!\\s*(?:\"\"|''|)\\s*\\))['\"]?(.+?)['\"]?\\)/gm,";

const MOD_BEFORE = 'if(a){let n=a.fn(i,e.meta,e.cookieStore);if(null==n){';
const MOD_AFTER = 'if(a){let n=a.fn(i,e.meta,e.cookieStore);null!=n&&"SCRIPT"===t.this.tagName&&"src"===r.toLowerCase()&&' +
  '"module"===String(e.natives.call("Element.prototype.getAttribute",t.this,"type")).toLowerCase()&&' +
  '-1===String(n).indexOf("type=module")&&(n+=(String(n).indexOf("?")<0?"?":"&")+"type=module");if(null==n){';

const REF_BEFORE = 'if(t&&new URL(t.url).pathname.startsWith(c.$W.prefix)){let e=new URL((0,s.v2)(t.url));e.toString().includes("youtube.com")||(m.set("Referer",e.href),m.set("Origin",e.origin))}';
const REF_AFTER = REF_BEFORE + 'else if(!t&&"navigate"===e.mode&&"string"==typeof e.referrer&&e.referrer.startsWith(location.origin+c.$W.prefix)){' +
  'let r=new URL((0,s.v2)(e.referrer));r.toString().includes("youtube.com")||m.set("Referer",r.href)}';

const WS_BEFORE = 'a.addEventListener("open",()=>{o(new Event("open"))})';
const WS_AFTER = 'a.addEventListener("open",()=>{"string"==typeof a.protocols&&(s.protocol=a.protocols);o(new Event("open"))})';

const REALM1_BEFORE = 'binaryType:"blob",barews:a,';
const REALM1_AFTER = 'binaryType:"blob",fkWin:t,barews:a,';
const REALM2_BEFORE = 'a.addEventListener("message",async e=>{let t=e.data;"string"==typeof t||("byteLength"in t?"blob"===s.binaryType?t=new Blob([t]):Object.setPrototypeOf(t,ArrayBuffer.prototype):"arrayBuffer"in t&&"arraybuffer"===s.binaryType&&Object.setPrototypeOf(t=await t.arrayBuffer(),ArrayBuffer.prototype))';
const REALM2_AFTER = 'a.addEventListener("message",async e=>{let t=e.data,W=s.fkWin||self;"string"==typeof t||("byteLength"in t?"blob"===s.binaryType?t=new W.Blob([t]):Object.setPrototypeOf(t,W.ArrayBuffer.prototype):"arrayBuffer"in t&&"arraybuffer"===s.binaryType&&Object.setPrototypeOf(t=await t.arrayBuffer(),W.ArrayBuffer.prototype))';

/* A page the slot itself opens (an address typed, a site handed over from
   another slot, a sign-in form posted back) is the slot's top page, but the
   browser asks for it as a frame, and Scramjet only calls a navigation a
   "document" when it can follow a referrer back to one. With none it sent
   Sec-Fetch-Dest: iframe, and sign-in pages that refuse to be framed answer
   that with an error: Google's said "Error 401 (Bad Request)" to every
   sign-in, Gmail and Docs (0.20.3). A navigation whose referrer is not a
   proxied page is the slot's own, so it goes as a document; frames inside a
   site's pages have that page as their referrer and are left as they were. */
const DEST_BEFORE = 'v?(m.set("Sec-Fetch-Dest","document")';
const DEST_AFTER = '(v||"navigate"===e.mode&&"iframe"===e.destination&&!(e.referrer&&e.referrer.includes(c.$W.prefix)))?(m.set("Sec-Fetch-Dest","document")';

/* A service worker never sees Accept-Language (the browser adds it after),
   so every proxied request went without one, which no real browser does:
   sites served the wrong language, and some count it toward "a bot". It is
   the person's own list, as their browser would send it (0.20.3). */
const LANG_BEFORE = 'let w=this.cookieStore.getCookies(h,!1);';
const LANG_AFTER = 'e.headers.has("accept-language")||m.set("Accept-Language",(self.navigator&&navigator.languages&&navigator.languages.length?' +
  'navigator.languages:["en-US","en"]).slice(0,4).map((l,i)=>i?l+";q=0."+(10-i):l).join(","));' + LANG_BEFORE;

/* Scramjet writes a call to its own $scramjet$pushsourcemap at the top of
   every script it rewrites, for when the script runs. A script that runs
   where that is not defined (a fresh frame, a worker, before the page is
   hooked) stopped there with a ReferenceError, all of it: Bing's script that
   shows its results never ran, so a search came up blank (0.20.3). The call
   is now made only when there is something to call. (Turning source maps
   off instead breaks Scramjet 1.1 elsewhere: "reading 'url'".) */
const MAP_BEFORE = 'let e=`${n.$W.globals.pushsourcemapfn}([${s.map.join(",")}], "${s.tag}");`';
const MAP_AFTER = 'let e=`typeof ${n.$W.globals.pushsourcemapfn}=="function"&&${n.$W.globals.pushsourcemapfn}([${s.map.join(",")}], "${s.tag}");`';

/* window.postMessage, hooked: Scramjet reads the sending page's address
   from the Scramjet client of the realm the message was made in. A message
   made in a realm Scramjet never hooked (an about:blank frame a page builds
   for itself) has none, so postMessage threw "reading 'url'" and the page's
   own message never went: Bing schedules its work that way, and its results
   stayed hidden (0.20.3). Such a message now goes as this window's. */
const PM_BEFORE = 'r=t("return globalThis")()[i.pX],n=t("...args","this(...args)");';
const PM_AFTER = 'r=t("return globalThis")()[i.pX]||globalThis[i.pX],n=t("...args","this(...args)");';

/* A header the site sent as UTF-8 bytes (a file name, a title) reaches the
   worker as text with letters past Latin-1, which a Response cannot carry:
   making the page's answer threw, and the body that answer held was never
   read. Over HTTP/2 one unread body stalls the whole connection, so every
   later request to that site hung: on Wikipedia the page never finished
   and no link, typed address or back worked (0.20.4). Such a value is sent
   on as its bytes, as a browser does, and an answer that still cannot be
   made lets go of its body. */
const HDR_BEFORE = 'let E=new w(y,v,l.status,l.statusText,n,e,l,h);return f.dispatchEvent(E),g(l)||await (0,a.Sn)(e.toString()),new Response(E.responseBody,{headers:E.responseHeaders,status:E.status,statusText:E.statusText})';
const HDR_AFTER = 'let E=new w(y,v,l.status,l.statusText,n,e,l,h);f.dispatchEvent(E),g(l)||await (0,a.Sn)(e.toString());' +
  'let fkH=E.responseHeaders,fkL=s=>"string"==typeof s&&/[^\\x00-\\xff]/.test(s)?unescape(encodeURIComponent(s)):s;' +
  'if(fkH&&"object"==typeof fkH&&!(fkH instanceof Headers))for(let k in fkH)fkH[k]=fkL(fkH[k]);' +
  'try{return new Response(E.responseBody,{headers:fkH,status:E.status,statusText:fkL(E.statusText)})}' +
  'catch(fkX){try{E.responseBody&&"function"==typeof E.responseBody.cancel&&E.responseBody.cancel()}catch(fkQ){}throw fkX}';

/* The other way: a header a page's request carries past Latin-1 (a cookie
   YouTube sets with such letters in it) made bare-mux's fetch throw while
   it made a Request it only reads the method and body from, so that request
   failed (0.20.4). The Request is made from a copy holding the bytes; the
   headers handed to the transport are the page's own, which it sends as
   UTF-8, as a browser would. */
const REQ_BEFORE = "async fetch(e,t){let r=new Request(e,t),";
const REQ_AFTER = "async fetch(e,t){let r=new Request(e,t&&t.headers&&\"object\"==typeof t.headers&&!(t.headers instanceof Headers)&&!Array.isArray(t.headers)?" +
  "Object.assign({},t,{headers:Object.fromEntries(Object.entries(t.headers).map(([k,v])=>[k,\"string\"==typeof v&&/[^\\x00-\\xff]/.test(v)?unescape(encodeURIComponent(v)):v]))}):t),";

const FIXES = [
  { name: "the cookie wait", before: BEFORE, after: AFTER },
  { name: "the empty url() swallowing a bracket", before: CSS_BEFORE, after: CSS_AFTER },
  { name: "a page's own module script without its mark", before: MOD_BEFORE, after: MOD_AFTER },
  { name: "a frame without a Referer", before: REF_BEFORE, after: REF_AFTER },
  { name: "a WebSocket's lost subprotocol", before: WS_BEFORE, after: WS_AFTER },
  { name: "a WebSocket that knows its frame", before: REALM1_BEFORE, after: REALM1_AFTER },
  { name: "a WebSocket message in its frame's own types", before: REALM2_BEFORE, after: REALM2_AFTER },
  { name: "the slot's own page sent as a frame", before: DEST_BEFORE, after: DEST_AFTER },
  { name: "no Accept-Language", before: LANG_BEFORE, after: LANG_AFTER },
  { name: "a script stopped by a missing source map call", before: MAP_BEFORE, after: MAP_AFTER },
  { name: "a message from a frame Scramjet never hooked", before: PM_BEFORE, after: PM_AFTER },
  { name: "a header past Latin-1 stalling the site", before: HDR_BEFORE, after: HDR_AFTER },
  { name: "a request header past Latin-1 failing the request", before: REQ_BEFORE, after: REQ_AFTER }
];

function once(text, s) {
  const at = text.indexOf(s);
  return at >= 0 && text.indexOf(s, at + 1) < 0 ? at : -1;
}

/* Every fix, or null with the name of the one that did not fit. */
function patchAll(text) {
  for (const f of FIXES) {
    const at = once(text, f.before);
    if (at < 0) return { text: null, missing: f.name };
    text = text.slice(0, at) + f.after + text.slice(at + f.before.length);
  }
  return { text, missing: null };
}

function patch(text) { return patchAll(text).text; }

if (require.main === module) {
  const file = process.argv[2];
  const r = file ? patchAll(fs.readFileSync(file, "utf8")) : { text: null, missing: "a file to patch" };
  if (!r.text) { console.error("patch-scramjet: " + r.missing + " was not found once in " + file); process.exit(1); }
  fs.writeFileSync(file, r.text);
  console.log("patch-scramjet: " + FIXES.map((f) => f.name).join(" and ") + " fixed in " + file);
}

module.exports = { patch, patchAll, FIXES, BEFORE, AFTER, CSS_BEFORE, CSS_AFTER, MOD_BEFORE, MOD_AFTER, REF_BEFORE, REF_AFTER, WS_BEFORE, WS_AFTER, REALM1_BEFORE, REALM1_AFTER, REALM2_BEFORE, REALM2_AFTER, DEST_BEFORE, DEST_AFTER, LANG_BEFORE, LANG_AFTER, MAP_BEFORE, MAP_AFTER, PM_BEFORE, PM_AFTER, HDR_BEFORE, HDR_AFTER, REQ_BEFORE, REQ_AFTER };
