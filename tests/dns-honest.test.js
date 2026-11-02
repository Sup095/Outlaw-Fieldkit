/* ============================================================
   FieldKit tests :: dns-honest — the guard says what really happened,
   and tiny models reach a network that blocks Hugging Face

   node tests/dns-honest.test.js

   Found 2026-11-02: YouTube's player tries video hosts that do not
   exist anywhere, and the guard blamed the content filter. These
   check the second opinion, KEEP, ALLOW past the DNS filter, the
   cache, the log, and relay/model-mirror.js.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Guard, DNS_PRESETS } = require("../relay/guard");
const { Blocklist, KEEP } = require("../relay/blocklist");
const mirror = require("../relay/model-mirror");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra ? "\n        " + extra : "")); }
}
function section(s) { console.log("\n== " + s + " =="); }

/* A resolver from a table: an array is an answer, "missing" is no such
   name, "down" is nobody answering. Counts what it was asked. */
function fake(table) {
  const r = { asked: 0 };
  const go = (host, six) => {
    r.asked++;
    const v = table[host];
    const err = (code) => Promise.reject(Object.assign(new Error(code), { code }));
    if (v === "down") return err("ETIMEOUT");
    if (!v || v === "missing") return err("ENOTFOUND");
    const list = v.filter((a) => (a.indexOf(":") >= 0) === six);
    return list.length ? Promise.resolve(list) : err("ENODATA");
  };
  r.resolve4 = (h) => go(h, false);
  r.resolve6 = (h) => go(h, true);
  return r;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-dns-"));

(async () => {
  section("a name that exists nowhere is not blamed on the filter");
  {
    const filt = fake({ "rr3---sn-q4fzen7r.googlevideo.com": "missing", "bad.example": "missing", "flaky.example": "missing" });
    const plain = fake({ "rr3---sn-q4fzen7r.googlevideo.com": "missing", "bad.example": ["93.184.216.34"], "flaky.example": "down" });
    const logs = [];
    const g = new Guard({ log: (l, m) => logs.push(m), dnsFilter: "adult", resolver: filt, plainResolver: plain, lists: new Blocklist({ baseFiles: [] }) });
    const a = await g.place("rr3---sn-q4fzen7r.googlevideo.com");
    ok("missing everywhere: says so", !a.ok && a.kind === "missing" && /does not exist/.test(a.why) && /not the filter/.test(a.why), a.why);
    ok("and never says the filter refused it", !/filter (blocks|refused)/.test(a.why));
    const b = await g.place("bad.example");
    ok("refused by the filter but real elsewhere: names the filter", !b.ok && b.kind === "filtered" && /content filter/.test(b.why), b.why);
    ok("…and is shown to the admins, who can ALLOW it", g.lists.view().recent.some((r) => r.host === "bad.example" && r.cat === "filter"));
    const c = await g.place("flaky.example");
    ok("the unfiltered resolver silent: does not pretend to know which", !c.ok && c.kind === "dns" && /or the content filter/.test(c.why), c.why);
    g.close();
  }

  section("what is allowed opens even when the DNS filter says no");
  {
    const filt = fake({ "rr1---sn-x.googlevideo.com": "missing", "school.example": "missing", "inside.example": "missing" });
    const plain = fake({ "rr1---sn-x.googlevideo.com": ["142.250.1.1"], "school.example": ["93.184.216.34"], "inside.example": ["10.0.0.5"] });
    const lists = new Blocklist({ baseFiles: [], allow: ["school.example", "inside.example"] });
    const logs = [];
    const g = new Guard({ log: (l, m) => logs.push(m), dnsFilter: "adult", resolver: filt, plainResolver: plain, lists });
    const v = await g.place("rr1---sn-x.googlevideo.com");
    ok("a video host (KEEP) opens with the unfiltered answer", v.ok && v.address === "142.250.1.1", JSON.stringify(v));
    const s = await g.place("school.example");
    ok("an admin's ALLOW now gets past the DNS filter too", s.ok && s.address === "93.184.216.34");
    const i = await g.place("inside.example");
    ok("but still never to a private address", !i.ok && i.kind === "private");
    ok("and it is in the log, once", logs.filter((m) => /which is allowed/.test(m)).length === 2, logs.join(" | "));
    g.close();
  }

  section("KEEP: the hosts a big site's media lives on are never listed");
  {
    const lists = new Blocklist({ baseFiles: [] });
    lists.table.add("googlevideo.com", 1);
    lists.table.add("rr5---sn-abc.googlevideo.com", 3);
    lists.table.add("i.ytimg.com", 2);
    ok("YouTube's video hosts are kept whatever a list says", !lists.check("rr5---sn-abc.googlevideo.com") && !lists.check("i.ytimg.com"));
    ok("the list covers YouTube's video, pictures and API", ["googlevideo.com", "ytimg.com", "youtubei.googleapis.com"].every((h) => KEEP.indexOf(h) >= 0));
    ok("but not the ad networks", !lists.allows("doubleclick.net") && !!lists.check("doubleclick.net"));
    ok("and not youtube.com itself, whose ad hosts stay blockable", !lists.allows("ads.youtube.com"));
    ok("a look-alike is not kept", !lists.allows("googlevideo.com.evil.example") && !lists.allows("notgooglevideo.com"));
  }

  section("answers are kept a minute, and a timeout is not");
  {
    const filt = fake({ "www.example.com": ["93.184.216.34"], "slow.example": "down" });
    const g = new Guard({ log: () => {}, dnsFilter: "adult", resolver: filt, plainResolver: fake({}) });
    await g.place("www.example.com"); await g.place("www.example.com"); await g.place("www.example.com");
    ok("three opens of one host: one lookup", filt.asked === 1, String(filt.asked));
    filt.asked = 0;
    await g.place("slow.example"); await g.place("slow.example");
    ok("nobody answering is asked again next time", filt.asked >= 4, String(filt.asked));
    g.cache.get("www.example.com").at -= 61000;
    filt.asked = 0;
    await g.place("www.example.com");
    ok("an old answer is asked again", filt.asked === 1);
    g.close();
  }

  section("a failed page is explained only by its own refusal");
  {
    const g = new Guard({ log: () => {}, dnsFilter: "adult", resolver: fake({ "ghost.example": "missing" }), plainResolver: fake({}) });
    await g.place("ghost.example");
    ok("a refusal of another host is not the reason", g.whyRefused(null, "www.youtube.com") === null);
    ok("one of the same host is", (g.whyRefused(null, "ghost.example") || {}).kind === "missing");
    ok("asked without a host, as before", !!g.whyRefused());
    g.close();
  }

  section("the same refusal is logged once a minute");
  {
    const logs = [];
    const g = new Guard({ log: (l, m) => logs.push(m), dnsFilter: "adult", resolver: fake({}), plainResolver: fake({}) });
    for (let i = 0; i < 6; i++) g._note("INFO", "x.example", "guard: refused CONNECT x.example — gone");
    g._note("INFO", "y.example", "guard: refused CONNECT y.example — gone");
    ok("six of one, one of another: two lines", logs.length === 2, String(logs.length));
    g.close();
  }

  section("every filter has a second of the same kind behind it");
  {
    ok("adult: CleanBrowsing, then Cloudflare for Families", DNS_PRESETS.adult.servers.slice(2).join() === "1.1.1.3,1.0.0.3");
    ok("security: then Quad9", DNS_PRESETS.security.servers.indexOf("9.9.9.9") === 2);
    ok("CleanBrowsing is still asked first", DNS_PRESETS.adult.servers[0] === "185.228.168.10");
    ok("no unfiltered resolver is ever in a filter's list",
      ["adult", "family", "security"].every((k) => DNS_PRESETS[k].servers.every((s) => s !== "1.1.1.1" && s !== "8.8.8.8")));
  }

  section("model mirror: only the engine's own models");
  {
    const eng = path.join(TMP, "web-llm.js");
    fs.writeFileSync(eng, 'var a={model:"https://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC"};');
    mirror.init({ dataDir: TMP, engineFiles: () => [eng] });
    const A = mirror.allowed;
    ok("a model's file list", (A("https://huggingface.co/api/models/mlc-ai/Tiny-q4f16_1-MLC?blobs=true") || {}).kind === "list");
    ok("a model's file", (A("https://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/params_shard_0.bin") || {}).kind === "file");
    ok("a model library", (A("https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_48/Tiny-webgpu.wasm") || {}).kind === "lib");
    ok("a repository the engine does not name: no", !A("https://huggingface.co/someone/anything/resolve/main/x.bin"));
    ok("another site: no", !A("https://example.com/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/x.bin"));
    ok("plain http: no", !A("http://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/x.bin"));
    ok("climbing out of the folder: no", !A("https://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/%2e%2e/x") &&
      !A("https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/../../x.wasm"));
    ok("another branch: no", !A("https://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC/resolve/dev/x.bin"));
    ok("only .wasm from GitHub", !A("https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/x.js"));
    ok("a userinfo or port trick: no", !A("https://huggingface.co@evil.example/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/x") &&
      !A("https://huggingface.co:8443/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/x"));

    const want = "https://huggingface.co/mlc-ai/Tiny-q4f16_1-MLC/resolve/main/tokenizer.json";
    fs.writeFileSync(mirror._internals.cachePath(want), "kept-bytes");
    const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const srv = http.createServer((req, res) => {
      mirror.route(req, res, new URL(req.url, "http://x"), { send, clientIp: () => "1.2.3.4" })
        .then((handled) => { if (!handled) send(res, 404, {}); });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const get = (p) => new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    }));
    const hit = await get("/ai/mirror?u=" + encodeURIComponent(want));
    ok("a file already fetched comes from the relay's disk", hit.status === 200 && hit.body === "kept-bytes", hit.status + " " + hit.body);
    const no = await get("/ai/mirror?u=" + encodeURIComponent("https://example.com/x"));
    ok("anything else is refused, with a reason", no.status === 403 && /not a file of a model/.test(no.body));
    ok("another path is not this route's", (await get("/ai/other")).status === 404);
    srv.close();

    /* The cache fits its cap, oldest out first. */
    mirror.init({ dataDir: TMP, engineFiles: () => [eng], config: { cacheGB: 20 / 1073741824 } });
    const dir = path.join(TMP, "model-cache");
    fs.readdirSync(dir).forEach((n) => fs.unlinkSync(path.join(dir, n)));
    fs.writeFileSync(path.join(dir, "old"), "0123456789");
    fs.utimesSync(path.join(dir, "old"), new Date(1000), new Date(1000));
    fs.writeFileSync(path.join(dir, "new"), "0123456789abcde");
    mirror._internals.trim();
    ok("past its size, the oldest file goes first", !fs.existsSync(path.join(dir, "old")) && fs.existsSync(path.join(dir, "new")));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\nRESULT  pass " + pass + "  fail " + fail);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e)); process.exit(1); });
