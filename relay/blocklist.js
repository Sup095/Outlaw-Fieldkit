/* ============================================================
   FieldKit relay :: blocklist — what the browser will not open

   The streamed browser's biggest cost was not the page, it was the
   ads around it. Measured on CrazyGames (2026-10-28): one game page
   opened a dozen ad and tracker frames, each its own Chromium
   process, and the session reached about 4 GB of memory. So the guard
   refuses ad and tracker hosts before a connection is made. A refused
   frame never starts a process, never downloads, never draws: it
   saves memory, CPU and the home upload at once, for every session.

   The same place refuses malware, scam and adult sites, for everyone,
   admins included. The DNS filter in guard.js is a second layer behind
   this, and catches names no list has.

   WHAT IS IN IT, strongest first:
     - lists fetched while the relay runs (SOURCES), kept in
       data/blocklists/ with the last good copy of each. They are other
       people's data under their own licences (HaGeZi's are GPL-3.0):
       fetched here, never part of this repository or an image;
     - adblock/hosts.txt, fixed when the image is built (the StevenBlack
       list, fetch-adblock.js, MIT), so a relay that has never reached
       GitHub still blocks;
     - CORE below, so a build with no network is still not a browser
       with no blocker.

   A LIST THAT LOOKS WRONG IS NOT USED. A download that fails keeps the
   last good copy. One that parses to almost nothing, or to under half
   of what it was, is an error page or a damaged file and is refused:
   "blocks less than it did, silently" is the failure worth stopping.

   ALLOW beats every list: a name an admin allows, and everything under
   it, is never refused. It reaches the helpers with each state poll.

   SMALL. Half a million names as a Set of strings is 50 MB or more in
   every relay and helper. Here a name is 8 bytes of hash and a byte of
   category in one flat table: about 9 MB for the same half a million,
   and a lookup per label of the host. Two different names sharing all
   64 bits is not a real risk at this size, and the worst case is one
   wrongly blocked site, which is what ALLOW is for.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const ADS = 1, ADULT = 2, MALWARE = 3;           /* the higher one wins */
const CATS = { ads: ADS, adult: ADULT, malware: MALWARE };
const NAMES = [null, "ads", "adult", "malware"];

const HAGEZI = "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/";
const SOURCES = [
  { id: "hagezi-pro", cat: "ads", url: HAGEZI + "pro.txt" },
  { id: "hagezi-tif", cat: "malware", url: HAGEZI + "tif.medium.txt" },
  { id: "hagezi-nsfw", cat: "adult", url: HAGEZI + "nsfw.txt" }
];

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

/* Never refused, by any list or by the DNS filter (guard.js asks
   allows()). Each one only carries a big, ordinary site's own pages,
   video, pictures or code, so refusing it never stops an ad: it only
   breaks the site. A list that one day lists one of these by mistake
   would break YouTube for everybody until an admin noticed; this
   makes that impossible. Everything under each name is kept too. */
const KEEP = [
  "googlevideo.com", "ytimg.com", "ggpht.com", "www.youtube.com", "m.youtube.com", "youtubei.googleapis.com",
  "youtube-nocookie.com", "gstatic.com", "wikipedia.org", "wikimedia.org", "github.com", "githubusercontent.com",
  "githubassets.com", "jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com", "huggingface.co", "hf.co"
];
const KEEP_SET = new Set(KEEP);

const WHY = {
  ads: "an ad or tracker",
  malware: "on a list of malware and scam sites",
  adult: "on a list of adult sites"
};

const REFRESH_HOURS = 8;
const MIN_NAMES = 1000;
const MAX_BYTES = 64 * 1024 * 1024;
const FETCH_MS = 120000;
const RECENT_MAX = 40;
const ALLOW_MAX = 500;
const YIELD_EVERY = 20000;
const NAME_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.[a-z][a-z0-9-]+$/;

/* Hosts-file lines ("0.0.0.0 ads.example.com"), bare names, and Adblock
   host rules ("||ads.example.com^"). Anything else, such as a rule with
   a path or a cosmetic rule, is not a name and is skipped. */
function nameIn(raw) {
  let line = raw.trim();
  if (!line || line[0] === "!" || line[0] === "#" || line[0] === "[") return null;
  if (line.startsWith("||")) {
    line = line.slice(2).replace(/\^.*$/, "");
  } else {
    line = line.replace(/\s#.*$/, "").trim();
    const parts = line.split(/\s+/);
    line = parts.length > 1 ? parts[1] : parts[0];
  }
  const host = line.toLowerCase();
  if (host === "localhost" || host.endsWith(".localdomain") || !NAME_RE.test(host)) return null;
  return host;
}

let hashA = 0, hashB = 0;
function hash(s) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  hashA = a >>> 0;
  hashB = b >>> 0;
}

class Table {
  constructor(want) {
    let size = 1024;
    while (size < want * 1.6) size *= 2;
    this.mask = size - 1;
    this.a = new Uint32Array(size);
    this.b = new Uint32Array(size);
    this.cat = new Uint8Array(size);
    this.count = 0;
  }
  add(name, cat) {
    hash(name);
    let i = hashA & this.mask;
    while (this.cat[i]) {
      if (this.a[i] === hashA && this.b[i] === hashB) {
        if (cat > this.cat[i]) this.cat[i] = cat;
        return;
      }
      i = (i + 1) & this.mask;
    }
    this.a[i] = hashA; this.b[i] = hashB; this.cat[i] = cat;
    this.count++;
  }
  get(name) {
    hash(name);
    let i = hashA & this.mask;
    while (this.cat[i]) {
      if (this.a[i] === hashA && this.b[i] === hashB) return this.cat[i];
      i = (i + 1) & this.mask;
    }
    return 0;
  }
}

function fetchText(url, etag, hops) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ "User-Agent": "FieldKit-blocklist/1" }, etag ? { "If-None-Match": etag } : {}), timeout: FETCH_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.statusCode !== 304 && res.headers.location && (hops | 0) < 3) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).href, etag, (hops | 0) + 1));
      }
      if (res.statusCode === 304) { res.resume(); return resolve({ status: 304 }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const chunks = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > MAX_BYTES) { req.destroy(new Error("too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: 200, etag: res.headers.etag || null, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

class Blocklist {
  constructor(opts) {
    opts = opts || {};
    this.log = opts.log || (() => {});
    this.on = opts.enabled !== false;
    this.adsOn = opts.ads !== false;
    this.dir = opts.dir || null;
    this.sources = (opts.sources || SOURCES).filter((s) => CATS[s.cat] && (this.adsOn || s.cat !== "ads"));
    this.baseFiles = opts.baseFiles || [path.join(__dirname, "adblock", "hosts.txt")];
    this.fetch = opts.fetch || fetchText;
    this.now = opts.now || Date.now;
    this.refreshMs = (opts.refreshHours || REFRESH_HOURS) * 3600000;
    this.allow = new Set();
    this.setAllow(opts.allow || []);
    this.blocked = { ads: 0, adult: 0, malware: 0 };
    this.recent = [];
    this.lists = {};           /* id -> { names, at, etag, why } */
    this.timer = null;
    this.busy = null;
    this.table = new Table(CORE.length);
    if (this.adsOn) CORE.forEach((h) => this.table.add(h, ADS));
  }

  /* Names as written by an admin: lower case, no scheme, no path. */
  setAllow(list) {
    const next = new Set();
    for (const raw of Array.isArray(list) ? list.slice(0, ALLOW_MAX) : []) {
      const h = String(raw).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
      if (h && h.length < 254) next.add(h);
    }
    this.allow = next;
  }

  /* An admin's ALLOW or KEEP covers this host, or a name it is under. */
  allows(hostname) {
    const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    for (let w = h; ; w = w.slice(w.indexOf(".") + 1)) {
      if (this.allow.has(w) || KEEP_SET.has(w)) return true;
      if (w.indexOf(".") < 0) return false;
    }
  }

  /* A refusal that was not a list's (the DNS filter's), kept with the
     rest so ADMIN CENTER shows it and an admin can ALLOW it. */
  noteRefused(hostname, cat) {
    this.recent.unshift({ host: String(hostname).slice(0, 120), cat: cat || "filter", at: this.now() });
    if (this.recent.length > RECENT_MAX) this.recent.pop();
  }

  /* What a host is, without counting it. null if it is not blocked. */
  check(hostname) {
    if (!this.on) return null;
    let h = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!h || this.allows(h)) return null;
    for (;;) {
      const c = this.table.get(h);
      if (c) return { cat: NAMES[c], why: WHY[NAMES[c]], name: h };
      const i = h.indexOf(".");
      if (i < 0 || h.indexOf(".", i + 1) < 0) return null;   /* stop at the registrable-ish name */
      h = h.slice(i + 1);
    }
  }

  /* The same, for a connection being refused: counted, and remembered
     for ADMIN, by name and never by who asked. */
  match(hostname) {
    const hit = this.check(hostname);
    if (!hit) return null;
    this.blocked[hit.cat]++;
    if (hit.cat !== "ads") {
      this.recent.unshift({ host: String(hostname).slice(0, 120), cat: hit.cat, at: this.now() });
      if (this.recent.length > RECENT_MAX) this.recent.pop();
    }
    return hit;
  }

  _file(id) { return path.join(this.dir, id + ".txt"); }
  _stateFile() { return path.join(this.dir, "lists.json"); }

  /* Reads every list there is into a new table, then swaps it in, so a
     lookup never sees a half-built one. Yields now and then: a table of
     half a million names must not hold up the pages being served. */
  async _rebuild() {
    const texts = [];
    for (const f of this.adsOn ? this.baseFiles : []) {
      try { texts.push({ text: fs.readFileSync(f, "utf8"), cat: ADS }); } catch (e) {}
    }
    for (const s of this.sources) {
      if (!this.dir) continue;
      try { texts.push({ text: fs.readFileSync(this._file(s.id), "utf8"), cat: CATS[s.cat] }); } catch (e) {}
    }
    let lines = 0;
    const split = texts.map((t) => { const l = t.text.split("\n"); lines += l.length; t.text = null; return { l: l, cat: t.cat }; });
    const table = new Table(lines + CORE.length);
    if (this.adsOn) CORE.forEach((h) => table.add(h, ADS));
    let n = 0;
    for (const t of split) {
      for (const raw of t.l) {
        const h = nameIn(raw);
        if (h) table.add(h, t.cat);
        if (++n % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      }
    }
    this.table = table;
    return table.count;
  }

  _readState() {
    try { return JSON.parse(fs.readFileSync(this._stateFile(), "utf8")) || {}; } catch (e) { return {}; }
  }

  async refresh() {
    if (!this.dir || !this.on) return false;
    if (this.busy) return this.busy;
    this.busy = this._refresh().finally(() => { this.busy = null; });
    return this.busy;
  }

  async _refresh() {
    let changed = false;
    for (const s of this.sources) {
      const was = this.lists[s.id] || {};
      try {
        const r = await this.fetch(s.url, was.etag);
        if (r.status === 304) { this.lists[s.id] = Object.assign(was, { at: this.now(), why: null }); continue; }
        let names = 0;
        for (const raw of r.text.split("\n")) if (nameIn(raw)) names++;
        if (names < MIN_NAMES) throw new Error("only " + names + " names in it, so it was not used");
        if (was.names && names < was.names / 2) throw new Error("it shrank from " + was.names + " to " + names + " names, so it was not used");
        const tmp = this._file(s.id) + ".new";
        fs.writeFileSync(tmp, r.text);
        fs.renameSync(tmp, this._file(s.id));
        this.lists[s.id] = { names: names, at: this.now(), etag: r.etag || null, why: null };
        changed = true;
      } catch (e) {
        this.lists[s.id] = Object.assign(was, { why: e.message, tried: this.now() });
        this.log("WARN", "blocklist: " + s.id + " not refreshed, keeping what it had: " + e.message);
      }
    }
    try { fs.writeFileSync(this._stateFile(), JSON.stringify(this.lists)); } catch (e) {}
    if (changed) {
      const n = await this._rebuild();
      this.log("INFO", "blocklist: " + n + " names after a refresh");
    }
    return changed;
  }

  /* Start from what is on disk at once, then bring it up to date. */
  async start() {
    if (!this.on) return;
    if (this.dir) {
      try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { this.dir = null; }
    }
    if (this.dir) this.lists = this._readState();
    const n = await this._rebuild();
    this.log("INFO", "blocklist: " + n + " names loaded");
    if (!this.dir) return;
    const oldest = Math.min(...this.sources.map((s) => (this.lists[s.id] || {}).at || 0));
    const due = this.now() - oldest >= this.refreshMs;
    this.timer = setInterval(() => { this.refresh().catch(() => {}); }, this.refreshMs);
    if (this.timer.unref) this.timer.unref();
    if (due) this.refresh().catch(() => {});
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  view() {
    return { on: this.on, names: this.table.count, blocked: Object.assign({}, this.blocked),
      lists: this.sources.map((s) => {
        const l = this.lists[s.id] || {};
        return { id: s.id, cat: s.cat, names: l.names || 0, at: l.at || 0, why: l.why || null };
      }),
      allow: Array.from(this.allow), recent: this.recent.slice(0, RECENT_MAX) };
  }
}

module.exports = { Blocklist, CORE, SOURCES, KEEP, nameIn, Table, ALLOW_MAX };
