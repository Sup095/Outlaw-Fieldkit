"use strict";
/* FieldKit lens :: one fix to Scramjet 1.1.0, made when the image is built.

   Scramjet's service worker, on a response that sets a cookie for a
   script or a stylesheet, posts the cookie to the page that asked and
   WAITS for the page to answer. But a browser holds messages to a page's
   navigator.serviceWorker until that page has finished parsing, and a
   script in <head> stops the parsing until it arrives: each waits for
   the other and the page stays white. Wikipedia, and any site whose
   scripts come with a cookie, did exactly this.

   The fix: do not wait. The worker still keeps the cookie in its own
   store (the next request carries it) and still tells the page, which
   hears it as soon as parsing ends.

   Usage: node patch-scramjet.js <scramjet.all.js>. Refuses, and so fails
   the build, if the code it fixes is not there exactly once: a new
   Scramjet must be looked at again, not patched blind. */
const fs = require("fs");

const BEFORE = '"document"!==n&&"iframe"!==n&&await r';
const AFTER = '"document"!==n&&"iframe"!==n&&void r';

function patch(text) {
  const at = text.indexOf(BEFORE);
  if (at < 0 || text.indexOf(BEFORE, at + 1) >= 0) return null;
  return text.slice(0, at) + AFTER + text.slice(at + BEFORE.length);
}

if (require.main === module) {
  const file = process.argv[2];
  const out = file && patch(fs.readFileSync(file, "utf8"));
  if (!out) { console.error("patch-scramjet: the cookie wait was not found once in " + file); process.exit(1); }
  fs.writeFileSync(file, out);
  console.log("patch-scramjet: the cookie wait is gone from " + file);
}

module.exports = { patch, BEFORE, AFTER };
