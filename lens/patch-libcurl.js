"use strict";
/* FieldKit lens :: our fixes to libcurl-transport 1.5.2, made when the image is built.

   1. The transport's init() makes its HTTP session BEFORE it checks that
   libcurl's WebAssembly has loaded, and the session throws "wasm not
   loaded yet" when it has not. bare-mux calls init() on the first
   requests after a page starts, while the WebAssembly is still being
   compiled: those requests fail. The first page showed Scramjet's error,
   or, when the page itself got through, its stylesheets and scripts did
   not: YouTube came up unstyled and CrazyGames' games never loaded.

   The fix: init() first waits for the WebAssembly (up to 30 s), every
   caller on the same wait, and makes the session once.

   Usage: node patch-libcurl.js <index.mjs> [<index.js> ...]. Refuses, and
   so fails the build, if the code it fixes is not there exactly once. */
const fs = require("fs");

const BEFORE = [
  "    libcurl.set_websocket(this.wisp);",
  "    this.session = new libcurl.HTTPSession({"
].join("\n");
const AFTER = [
  "    libcurl.set_websocket(this.wisp);",
  "    for (let waited = 0; !libcurl.ready; waited += 25) {",
  "      if (waited > 30000) throw new Error(\"libcurl.js did not load\");",
  "      await new Promise((r) => setTimeout(r, 25));",
  "    }",
  "    if (this.session) { this.ready = true; return; }",
  "    this.session = new libcurl.HTTPSession({"
].join("\n");

/* 2. A WebSocket's subprotocol. The transport tells the page its socket
      opened with protocol "" whatever was asked for, so ws.protocol is
      always empty. Games that ask for one (Photon, behind most
      CrazyGames multiplayer games, asks for GpBinaryV16) read that as
      the server refusing it. The fix: pass on the protocol the socket
      opened with. */
const WS_BEFORE = [
  "    socket.onopen = (event) => {",
  "      onopen(\"\");"
].join("\n");
const WS_AFTER = [
  "    socket.onopen = (event) => {",
  "      onopen(socket.protocol || \"\");"
].join("\n");

const FIXES = [
  { name: "init() waits for the WebAssembly", before: BEFORE, after: AFTER },
  { name: "the WebSocket subprotocol is passed on", before: WS_BEFORE, after: WS_AFTER }
];

function patch(text) {
  const nl = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  for (const f of FIXES) {
    const b = f.before.split("\n").join(nl), a = f.after.split("\n").join(nl);
    const at = text.indexOf(b);
    if (at < 0 || text.indexOf(b, at + 1) >= 0) return null;
    text = text.slice(0, at) + a + text.slice(at + b.length);
  }
  return text;
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("patch-libcurl: name the transport file(s)"); process.exit(1); }
  for (const file of files) {
    const out = patch(fs.readFileSync(file, "utf8"));
    if (!out) { console.error("patch-libcurl: the code it fixes was not found once in " + file); process.exit(1); }
    fs.writeFileSync(file, out);
    console.log("patch-libcurl: " + FIXES.map((f) => f.name).join(" and ") + " in " + file);
  }
}

module.exports = { patch, FIXES, BEFORE, AFTER, WS_BEFORE, WS_AFTER };
