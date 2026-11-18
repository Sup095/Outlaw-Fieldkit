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

/* 3. A header past Latin-1 (0.20.4). libcurl hands headers over as text
      decoded from UTF-8, so a header a site sent as UTF-8 bytes (a file
      name, a title) has letters a Response cannot carry, and making the
      Response threw. It threw inside libcurl's own data callback, which
      stopped libcurl for good: every later request, to every site, hung.
      On Wikipedia (one of its pictures sends such a header) the first page
      never finished and nothing after it opened. The fix: such a value is
      passed on as its bytes, as a browser does; and a Response that still
      cannot be made fails that one request, which is let go of, instead
      of throwing into libcurl. */
const HDR_BEFORE = "      response_info.statusText = status_messages[response_info.status] || \"\";";
const HDR_AFTER = [
  HDR_BEFORE,
  "      if (Array.isArray(response_info.headers)) response_info.headers = response_info.headers.map((h) =>",
  "        Array.isArray(h) ? h.map((s) => typeof s === \"string\" && /[^\\x00-\\xff]/.test(s) ? unescape(encodeURIComponent(s)) : s) : h);"
].join("\n");
const MAKE_BEFORE = "          let response = this.constructor.create_response(stream, JSON.parse(response_json));";
const MAKE_AFTER = [
  "          let response;",
  "          try {",
  "            response = this.constructor.create_response(stream, JSON.parse(response_json));",
  "          } catch (e) {",
  "            try { stream.cancel(); } catch (x) {}",
  "            reject(e);",
  "            return;",
  "          }"
].join("\n");

/* 5. The same on the way out (0.20.4): a request's header past Latin-1 (a
      cookie YouTube sets with such letters) made the Request the transport
      builds only to read the body from throw, and that request failed. It
      is built from a copy holding the bytes; the headers sent are the
      page's own, which libcurl sends as UTF-8, as a browser would. */
const OPT_BEFORE = "      let request_obj = new Request(\"http://127.0.0.1/\", params);";
const OPT_AFTER = [
  "      let fk_h = params.headers, fk_p = params;",
  "      if (fk_h && typeof fk_h === \"object\" && !(fk_h instanceof Headers) && !Array.isArray(fk_h))",
  "        fk_p = Object.assign({}, params, { headers: Object.fromEntries(Object.entries(fk_h).map(([k, v]) =>",
  "          [k, typeof v === \"string\" && /[^\\x00-\\xff]/.test(v) ? unescape(encodeURIComponent(v)) : v])) });",
  "      let request_obj = new Request(\"http://127.0.0.1/\", fk_p);"
].join("\n");

const FIXES = [
  { name: "init() waits for the WebAssembly", before: BEFORE, after: AFTER },
  { name: "the WebSocket subprotocol is passed on", before: WS_BEFORE, after: WS_AFTER },
  { name: "a header past Latin-1 is passed on as its bytes", before: HDR_BEFORE, after: HDR_AFTER },
  { name: "a Response that cannot be made fails only its request", before: MAKE_BEFORE, after: MAKE_AFTER },
  { name: "a request header past Latin-1 is sent as UTF-8", before: OPT_BEFORE, after: OPT_AFTER }
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

module.exports = { patch, FIXES, BEFORE, AFTER, WS_BEFORE, WS_AFTER, HDR_BEFORE, HDR_AFTER, MAKE_BEFORE, MAKE_AFTER, OPT_BEFORE, OPT_AFTER };
