/* ============================================================
   tools/fetch-blocklist.js — download a blocklist for the relay

   Runs on the SSD, not on the relay, and that is deliberate. A
   relay that fetches its own blocklist on a schedule has to decide
   what to do when the list's host is down or slow, and the honest
   answers are "run unfiltered" or "refuse everything" — one is
   silently wrong and the other takes the browser out. Downloading
   here and uploading the file makes the relay's behaviour a
   function of files on disk, which is a thing you can look at.

     node tools/fetch-blocklist.js                 what is available
     node tools/fetch-blocklist.js light           download one
     node tools/fetch-blocklist.js light porn      download several

   Files land in release/blocklists/, ready to upload into the
   relay's data/blocklists/. Then in config.json:

     "browse": { "filter": { "enabled": true, "lists": ["light.txt"] } }

   WHAT THIS IS NOT. It blocks by hostname. It does not block a
   numeric address (browse.filter.blockIpLiterals covers that
   separately), it cannot block a host nobody has listed, and it
   will not stop somebody who is trying. It stops carelessness and
   the obvious cases. Anyone deploying it as a guarantee has
   misunderstood it, which is why this paragraph is here and not in
   a footnote.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT = path.join(__dirname, "..", "release", "blocklists");

/* Hosts-file and plain-domain sources. Deliberately a short list of
   well-known, long-lived ones rather than everything that exists —
   a blocklist is a thing you should be able to say the provenance
   of, and "it was in a script" is not provenance. */
const SOURCES = {
  light: {
    file: "light.txt",
    what: "StevenBlack unified: ads and malware. The default choice.",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"
  },
  porn: {
    file: "porn.txt",
    what: "StevenBlack unified + pornography.",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts"
  },
  gambling: {
    file: "gambling.txt",
    what: "StevenBlack unified + gambling.",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling/hosts"
  },
  social: {
    file: "social.txt",
    what: "StevenBlack unified + social media. Blunt — this blocks a lot.",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/social/hosts"
  },
  everything: {
    file: "everything.txt",
    what: "StevenBlack: ads, malware, fakenews, gambling, porn, social. Very blunt.",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-gambling-porn-social/hosts"
  }
};

function get(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error("too many redirects"));
    https.get(url, { headers: { "User-Agent": "FieldKit-fetch-blocklist/1" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/* Counted with the relay's own parser, so the number printed here
   is the number of hosts the relay will actually enforce — not the
   line count of a file that is mostly comments. */
function countWith(text) {
  const { _internals } = require("../relay/browse.js");
  return _internals.parseBlocklist(text).length;
}

function list() {
  console.log("BLOCKLISTS\n");
  Object.keys(SOURCES).forEach((k) => {
    console.log("  " + k.padEnd(12) + SOURCES[k].what);
  });
  console.log("\n  node tools/fetch-blocklist.js light");
  console.log("\nEach is cumulative, not additive — 'porn' already contains 'light'.");
  console.log("Pick ONE unless you know why you want more.");
}

async function main() {
  const want = process.argv.slice(2).filter((a) => a[0] !== "-");
  if (!want.length) return list();

  const unknown = want.filter((w) => !SOURCES[w]);
  if (unknown.length) {
    console.error("no such list: " + unknown.join(", "));
    console.error("run with no arguments to see what there is");
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  for (const key of want) {
    const src = SOURCES[key];
    process.stdout.write("fetching " + key + " … ");
    let text;
    try { text = await get(src.url); }
    catch (e) { console.log("FAILED — " + e.message); continue; }

    const hosts = countWith(text);
    if (hosts < 100) {
      /* A list that parses to almost nothing is a fetch that landed
         on an error page, and writing it would leave a config that
         claims to filter while filtering nothing. */
      console.log("REFUSED — parsed to only " + hosts + " hosts, that is not a blocklist");
      continue;
    }
    const dest = path.join(OUT, src.file);
    fs.writeFileSync(dest, text);
    console.log(hosts.toLocaleString() + " hosts -> release/blocklists/" + src.file +
      "  (" + (Buffer.byteLength(text) / 1048576).toFixed(1) + " MB)");
  }

  console.log("\nUpload the contents of release/blocklists/ into the relay's");
  console.log("data/blocklists/, then in config.json:\n");
  console.log('  "browse": { "filter": { "enabled": true, "lists": [' +
    want.map((w) => '"' + SOURCES[w].file + '"').join(", ") + "] } }\n");
  console.log("Restart the relay. It logs how many hosts it loaded, and logs an");
  console.log("ERROR if a list it was told to use is missing — a config that says");
  console.log("it filters while the file is absent is the failure worth shouting about.");
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { SOURCES };
