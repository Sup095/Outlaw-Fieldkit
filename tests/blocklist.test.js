/* ============================================================
   FieldKit tests :: blocklist — what the browser will not open

   node tests/blocklist.test.js
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Blocklist, nameIn, Table, CORE, SOURCES } = require("../relay/blocklist");
const { Guard } = require("../relay/guard");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra ? "\n        " + extra : "")); }
}
function section(s) { console.log("\n== " + s + " =="); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-block-"));
const many = (word, n) => Array.from({ length: n }, (_, i) => "||" + word + i + ".example.net^").join("\n") + "\n";
const SRC = [
  { id: "ads", cat: "ads", url: "https://list.test/ads" },
  { id: "bad", cat: "malware", url: "https://list.test/bad" },
  { id: "adult", cat: "adult", url: "https://list.test/adult" }
];

(async () => {
  section("reading a line");
  {
    ok("an Adblock host rule", nameIn("||ads.example.com^") === "ads.example.com");
    ok("a hosts line", nameIn("0.0.0.0 ads.example.com") === "ads.example.com");
    ok("with a trailing comment", nameIn("0.0.0.0 ads.example.com # why") === "ads.example.com");
    ok("a bare name", nameIn("Ads.Example.COM") === "ads.example.com");
    ok("punycode", nameIn("||xn--bcher-kva.example^") === "xn--bcher-kva.example");
    ok("comments and headers are not names", !nameIn("! Title: x") && !nameIn("# c") && !nameIn("[Adblock Plus]"));
    ok("a rule with a path is not a name", !nameIn("||example.com/ads/*") && !nameIn("example.com##.ad"));
    ok("localhost is never a name", !nameIn("127.0.0.1 localhost") && !nameIn("0.0.0.0 0.0.0.0"));
  }

  section("the table");
  {
    const t = new Table(100);
    t.add("a.example", 1);
    t.add("b.example", 3);
    t.add("a.example", 2);
    ok("it finds what it holds", t.get("b.example") === 3);
    ok("a higher category wins", t.get("a.example") === 2);
    ok("a lower one does not take it back", (t.add("a.example", 1), t.get("a.example")) === 2);
    ok("each name counts once", t.count === 2);
    ok("anything else is not there", t.get("c.example") === 0);
    const big = new Table(600000);
    for (let i = 0; i < 600000; i++) big.add("host" + i + ".example.org", 1 + (i % 3));
    let wrong = 0;
    for (let i = 0; i < 600000; i += 997) if (big.get("host" + i + ".example.org") !== 1 + (i % 3)) wrong++;
    for (let i = 0; i < 200000; i++) if (big.get("nobody" + i + ".example.org")) wrong++;
    ok("600,000 names: every one found, none invented", wrong === 0 && big.count === 600000, String(wrong));
    const bytes = big.a.byteLength + big.b.byteLength + big.cat.byteLength;
    ok("in a flat table of a sensible size", bytes < 24 * 1024 * 1024, bytes + " bytes");
  }

  section("categories, parents, allow");
  {
    const dir = path.join(TMP, "a");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "ads.txt"), "||ads.example.com^\n||both.example.com^\n");
    fs.writeFileSync(path.join(dir, "bad.txt"), "||malware.example.com^\n||both.example.com^\n");
    fs.writeFileSync(path.join(dir, "adult.txt"), "||adult.example.com^\n");
    fs.writeFileSync(path.join(dir, "lists.json"), JSON.stringify({ ads: { at: Date.now() }, bad: { at: Date.now() }, adult: { at: Date.now() } }));
    const b = new Blocklist({ dir, sources: SRC, baseFiles: [], fetch: async () => { throw new Error("not due"); } });
    await b.start();
    ok("an ad host says it is one", b.check("ads.example.com").cat === "ads");
    ok("malware says so", /malware/.test(b.check("malware.example.com").why) && b.check("malware.example.com").cat === "malware");
    ok("adult says so", b.check("adult.example.com").cat === "adult");
    ok("a host on two lists is the more serious one", b.check("both.example.com").cat === "malware");
    ok("anything under a listed name", b.check("a.b.adult.example.com").name === "adult.example.com");
    ok("not its parent", !b.check("example.com"));
    ok("nor a look-alike", !b.check("notads.example.com"));
    ok("an unlisted site is fine", !b.check("www.wikipedia.org"));
    ok("the case and a trailing dot do not matter", b.check("ADS.Example.com.").cat === "ads");

    b.setAllow(["adult.example.com", "https://Ads.Example.com/page", "both.example.com"]);
    ok("an allowed name is never refused", !b.check("adult.example.com"));
    ok("nor anything under it", !b.check("x.adult.example.com"));
    ok("written as an address it still counts", !b.check("ads.example.com"));
    ok("allow beats malware too: it is the owner's call", !b.check("both.example.com"));
    b.setAllow([]);

    ok("check counts nothing", b.view().blocked.ads === 0);
    b.match("ads.example.com"); b.match("ads.example.com"); b.match("adult.example.com");
    const v = b.view();
    ok("match counts by category", v.blocked.ads === 2 && v.blocked.adult === 1);
    ok("the serious ones are remembered, by site", v.recent.length === 1 && v.recent[0].host === "adult.example.com");
    ok("and never by who asked", !/who|handle|user/.test(JSON.stringify(v.recent)));
    const off = new Blocklist({ ads: false, baseFiles: [] });
    ok("ad blocking off leaves the built-in ad list out", !off.check(CORE[0]));
    ok("the real sources name a category each", SOURCES.length >= 3 && SOURCES.every((s) => /^https:/.test(s.url) && s.cat));
    ok("the lists are malware, adult and ads", ["ads", "adult", "malware"].every((c) => SOURCES.some((s) => s.cat === c)));
  }

  section("fetching, and what happens when it goes wrong");
  {
    const dir = path.join(TMP, "b");
    const body = { ads: many("ad", 2000), bad: many("bad", 2000), adult: many("x", 3000) };
    const asked = [];
    let mode = "ok";
    const fetch = async (url, etag) => {
      const id = url.split("/").pop();
      asked.push({ id, etag });
      if (mode === "down") throw new Error("HTTP 503");
      if (mode === "same") return { status: 304 };
      if (mode === "html" && id === "bad") return { status: 200, text: "<html>an error page</html>" };
      if (mode === "shrunk" && id === "adult") return { status: 200, text: many("x", 1200) };
      return { status: 200, etag: "e-" + id, text: body[id] };
    };
    const logs = [];
    const b = new Blocklist({ dir, sources: SRC, baseFiles: [], fetch, log: (l, m) => logs.push(m) });
    await b.start();
    await b.busy;
    ok("a first start fetches every list", asked.length === 3);
    ok("and writes them", fs.existsSync(path.join(dir, "ads.txt")) && fs.existsSync(path.join(dir, "lists.json")));
    ok("what it fetched is in force", b.check("bad7.example.net").cat === "malware" && b.check("x9.example.net").cat === "adult");
    ok("the view says how many, per list", b.view().lists.find((l) => l.id === "bad").names === 2000);

    asked.length = 0;
    mode = "same";
    ok("nothing changed: nothing rebuilt", (await b.refresh()) === false);
    ok("and it asked with what it had", asked.every((a) => a.etag === "e-" + a.id));

    mode = "down";
    await b.refresh();
    ok("a list that cannot be reached is kept", b.check("bad7.example.net").cat === "malware");
    ok("and the view says what went wrong", /503/.test(b.view().lists[0].why));
    ok("in the log too", logs.some((m) => /keeping what it had/.test(m)));

    mode = "html";
    await b.refresh();
    ok("an error page is not a list", b.check("bad7.example.net").cat === "malware" && /only 0 names/.test(b.view().lists.find((l) => l.id === "bad").why));

    mode = "shrunk";
    await b.refresh();
    ok("a list that shrinks by half is refused", b.check("x1999.example.net").cat === "adult" && /shrank/.test(b.view().lists.find((l) => l.id === "adult").why));

    mode = "ok";
    await b.refresh();
    ok("and a good one clears the complaint", !b.view().lists.find((l) => l.id === "adult").why);
    b.stop();

    const fresh = new Blocklist({ dir, sources: SRC, baseFiles: [], fetch: async () => { throw new Error("offline"); } });
    await fresh.start();
    await fresh.busy;
    ok("a restart with no network starts from the last good copies", fresh.check("bad7.example.net").cat === "malware" && fresh.view().lists[1].names === 2000);
    fresh.stop();

    const noDir = new Blocklist({ dir: path.join(TMP, "file-not-dir", "x"), sources: SRC, baseFiles: [] });
    fs.writeFileSync(path.join(TMP, "file-not-dir"), "x");
    await noDir.start();
    ok("somewhere it cannot write: it still works from what it has", !!noDir.check(CORE[1]));
  }

  section("through the guard");
  {
    const lists = new Blocklist({ baseFiles: [] });
    lists.table.add("bad.example.net", 3);
    lists.table.add("adult.example.net", 2);
    const logs = [];
    const g = new Guard({ log: (l, m) => logs.push(m), dnsFilter: "system", lists });
    const a = await g.place("bad.example.net");
    ok("malware is refused with the reason", !a.ok && a.kind === "malware" && /malware/.test(a.why));
    ok("and leaves its reason for the panel", g.whyRefused().kind === "malware");
    const b = await g.place("sub.adult.example.net");
    ok("adult likewise", !b.ok && b.kind === "adult" && !b.quiet);
    const c = await g.place("doubleclick.net");
    ok("ads stay quiet: a page asks for dozens a second", !c.ok && c.quiet && g.stats.refusedAds === 1);
    ok("the counts add up", lists.view().blocked.malware === 1 && lists.view().blocked.adult === 1 && lists.view().blocked.ads === 1);
    g.close();
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\nRESULT  pass " + pass + "  fail " + fail);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e)); process.exit(1); });
