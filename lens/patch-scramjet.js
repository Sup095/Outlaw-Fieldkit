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

const FIXES = [
  { name: "the cookie wait", before: BEFORE, after: AFTER },
  { name: "the empty url() swallowing a bracket", before: CSS_BEFORE, after: CSS_AFTER },
  { name: "a page's own module script without its mark", before: MOD_BEFORE, after: MOD_AFTER },
  { name: "a frame without a Referer", before: REF_BEFORE, after: REF_AFTER },
  { name: "a WebSocket's lost subprotocol", before: WS_BEFORE, after: WS_AFTER },
  { name: "a WebSocket that knows its frame", before: REALM1_BEFORE, after: REALM1_AFTER },
  { name: "a WebSocket message in its frame's own types", before: REALM2_BEFORE, after: REALM2_AFTER }
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

module.exports = { patch, patchAll, FIXES, BEFORE, AFTER, CSS_BEFORE, CSS_AFTER, MOD_BEFORE, MOD_AFTER, REF_BEFORE, REF_AFTER, WS_BEFORE, WS_AFTER, REALM1_BEFORE, REALM1_AFTER, REALM2_BEFORE, REALM2_AFTER };
