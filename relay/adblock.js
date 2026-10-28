/* ============================================================
   FieldKit relay :: adblock — ads and trackers, refused by name

   The streamed browser's biggest cost was not the page, it was the
   ads around it. Measured on CrazyGames (2026-10-28): one game page
   opened a dozen ad and tracker frames, each its own Chromium
   process, and the session reached about 4 GB of memory. The
   container has 4.5 GB, so one game took the browser down.

   So the guard refuses ad and tracker hosts before a connection is
   made. A refused frame never starts a process, never downloads,
   never draws: it saves memory, CPU and the home upload at once, for
   every session, with nothing to install in Chromium.

   THE LIST. adblock/hosts.txt, fetched when the image is built
   (fetch-adblock.js: the StevenBlack unified hosts list, ads and
   malware, MIT licence). If it is missing, a short list of the
   largest ad networks below is still used, so a build without the
   network is never a browser without a blocker. config.json:
   browser.adblock false switches it off; browser.adblockAllow names
   hosts it must never block.

   Matching is by name and every parent name: a.ads.example.com is
   blocked if ads.example.com is listed. A Set lookup per label, so
   eighty thousand names cost a few milliseconds to load and nothing
   to ask.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

/* The fallback: the networks that turned up on every page measured. */
const CORE = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com", "pagead2.googlesyndication.com",
  "googletagservices.com", "google-analytics.com", "googletagmanager.com", "adnxs.com", "criteo.com", "criteo.net",
  "amazon-adsystem.com", "pubmatic.com", "openx.net", "rubiconproject.com", "smartadserver.com", "the-ozone-project.com",
  "taboola.com", "outbrain.com", "adsrvr.org", "casalemedia.com", "3lift.com", "sharethrough.com", "teads.tv",
  "yieldmo.com", "media.net", "moatads.com", "scorecardresearch.com", "quantserve.com", "adform.net", "bidswitch.net",
  "sonobi.com", "indexww.com", "33across.com", "lijit.com", "contextweb.com", "advertising.com", "spotxchange.com",
  "rlcdn.com", "demdex.net", "everesttech.net", "agkn.com", "id5-sync.com", "adsafeprotected.com", "doubleverify.com",
  "hotjar.com", "mixpanel.com", "segment.io", "zemanta.com", "mgid.com", "propellerads.com", "popads.net", "exoclick.com"
];

class AdBlock {
  constructor(opts) {
    opts = opts || {};
    this.on = opts.enabled !== false;
    this.names = new Set();
    this.allow = new Set((opts.allow || []).map((h) => String(h).toLowerCase().trim()).filter(Boolean));
    this.blocked = 0;
    this.source = "off";
    if (!this.on) return;
    const files = opts.files || [path.join(__dirname, "adblock", "hosts.txt")];
    let fromFiles = 0;
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
      fromFiles += this.add(text);
    }
    CORE.forEach((h) => this.names.add(h));
    this.source = fromFiles ? fromFiles + " names from the list, and the built-in ones" : "the built-in list only (" + CORE.length + " ad networks)";
  }

  /* Hosts-file lines ("0.0.0.0 ads.example.com") or bare names. */
  add(text) {
    let n = 0;
    for (const raw of String(text).split("\n")) {
      const line = raw.replace(/#.*/, "").trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const host = (parts.length > 1 ? parts[1] : parts[0]).toLowerCase();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || host === "localhost" || host.endsWith(".localdomain")) continue;
      if (!this.names.has(host)) { this.names.add(host); n++; }
    }
    return n;
  }

  /* Is this host, or a name it sits under, an ad or tracker host? */
  match(hostname) {
    if (!this.on) return false;
    let h = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!h || this.allow.has(h)) return false;
    for (;;) {
      if (this.allow.has(h)) return false;
      if (this.names.has(h)) { this.blocked++; return true; }
      const i = h.indexOf(".");
      if (i < 0 || h.indexOf(".", i + 1) < 0) return false;   /* stop at the registrable-ish name */
      h = h.slice(i + 1);
    }
  }

  view() { return { on: this.on, names: this.names.size, blocked: this.blocked, source: this.source }; }
}

module.exports = { AdBlock, CORE };
