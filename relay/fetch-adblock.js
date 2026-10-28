/* ============================================================
   FieldKit relay :: fetch-adblock — the ad blocker's list, at build

   Run by the image's Dockerfile, like fetch-cloudflared.js: the list
   is part of the image, fixed at build time, so what the browser
   blocks is a file you can look at, not something fetched while it
   runs. Rebuilding the image refreshes it.

   The StevenBlack unified hosts list (ads and malware, MIT licence,
   https://github.com/StevenBlack/hosts). Only lines that are a
   blocking address and a hostname are kept, so whatever else the
   download holds cannot reach the browser. If the download fails the
   build still succeeds: adblock.js falls back to its built-in list.

     node fetch-adblock.js        writes adblock/hosts.txt
   ============================================================ */
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const URL_ = "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts";
const OUT = path.join(__dirname, "adblock", "hosts.txt");
const MAX = 20 * 1024 * 1024;

function get(url, hops) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "FieldKit-fetch-adblock/1" }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const parts = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > MAX) { res.destroy(); reject(new Error("too large")); } else parts.push(c); });
      res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("timed out")); });
  });
}

/* Keeps "0.0.0.0 name" lines only, as bare names. */
function clean(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+\.[a-z]{2,})\s*(?:#.*)?$/i.exec(raw);
    if (m && m[1] !== "localhost" && !/\.localdomain$/i.test(m[1])) out.push(m[1].toLowerCase());
  }
  return out;
}

if (require.main === module) {
  get(URL_, 0).then((text) => {
    const names = clean(text);
    if (names.length < 1000) throw new Error("only " + names.length + " names: not the list expected");
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, "# StevenBlack unified hosts (ads + malware), MIT licence, fetched " + new Date().toISOString() + "\n" + names.join("\n") + "\n");
    console.log("fetch-adblock: " + names.length + " names -> " + OUT);
  }).catch((e) => {
    console.log("fetch-adblock: could not fetch the list (" + e.message + "); the built-in list will be used");
  });
}

module.exports = { clean };
