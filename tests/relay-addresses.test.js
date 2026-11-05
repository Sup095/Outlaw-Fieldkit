/* ============================================================
   relay/addresses.js and relay/model-shelf.js — the relay's own
   addresses read from its tunnel, and the models it keeps whole.

   What matters:
     1. Only hostnames that point at this relay's port are candidates,
        and only those that really reach THIS relay (the probe) are
        listed. A tunnel that cannot be read keeps the last good list.
     2. The list is for someone signed in, not the public.
     3. The shelf serves only what its manifests name, by number, with
        nothing of the model's name in the address.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("relay-addresses");
const addresses = require("../relay/addresses");
const shelf = require("../relay/model-shelf");

function call(route, p, helpers, method) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const send = (r, status, body) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(body)); };
      const done = await route(req, res, new URL(req.url, "http://relay"), Object.assign({ send }, helpers || {}));
      if (!done) send(res, 418, { unhandled: true });
    });
    srv.listen(0, "127.0.0.1", () => {
      http.request({ host: "127.0.0.1", port: srv.address().port, path: p, method: method || "GET" }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { srv.close(); const b = Buffer.concat(chunks); let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
      }).end();
    });
  });
}

(async () => {
  section("which hostnames are this relay's");
  {
    const ingress = [
      { hostname: "save.example.com", service: "http://127.0.0.1:25569" },
      { hostname: "learn.example.com", service: "http://localhost:25569/" },
      { hostname: "other.example.com", service: "http://127.0.0.1:8080" },
      { hostname: "*.example.com", service: "http://127.0.0.1:25569" },
      { hostname: "part.example.com", path: "/x", service: "http://127.0.0.1:25569" },
      { service: "http_status:404" }
    ];
    const h = addresses.hostsFor(ingress, 25569);
    ok("the ones pointing at this port, in order", h.join() === "save.example.com,learn.example.com", h.join());
    ok("not another port, a wildcard, a path, or the catch-all", h.length === 2);
  }

  section("the list is checked against this relay");
  {
    let tunnel = { version: 3, config: { ingress: [
      { hostname: "a.example.com", service: "http://127.0.0.1:9000" },
      { hostname: "run.example.com", service: "http://127.0.0.1:9000" },
      { hostname: "b.example.com", service: "http://127.0.0.1:9000" } ] } };
    const probed = [];
    addresses.init({ port: 9000, start: false, config: { extra: ["direct.example.org"] },
      readConfig: async () => { if (!tunnel) throw new Error("cloudflared is not answering"); return tunnel; },
      probe: async (o, n) => { probed.push(n); return o !== "https://run.example.com"; } });
    await addresses.refresh();
    ok("a hostname whose DNS goes elsewhere (run.) is left out", addresses.state.addresses.indexOf("https://run.example.com") < 0);
    ok("the rest, in the tunnel's order, then the extra ones",
      addresses.state.addresses.join() === "https://a.example.com,https://b.example.com,https://direct.example.org", addresses.state.addresses.join());
    addresses.init({ port: 9000, start: false, config: { private: ["b.example.com"] },
      readConfig: async () => tunnel, probe: async (o) => o !== "https://run.example.com" });
    await addresses.refresh();
    ok("a private hostname (for the servers only) is never offered", addresses.state.addresses.join() === "https://a.example.com");
    addresses.init({ port: 9000, start: false, config: { extra: ["direct.example.org"] },
      readConfig: async () => { if (!tunnel) throw new Error("cloudflared is not answering"); return tunnel; },
      probe: async (o, n) => { probed.push(n); return o !== "https://run.example.com"; } });
    await addresses.refresh();
    ok("every probe has its own number", new Set(probed).size === probed.length && probed.every((n) => /^[0-9a-f]{24}$/.test(n)));
    tunnel = null;
    await addresses.refresh();
    ok("a tunnel that cannot be read keeps the last list", addresses.state.addresses.length === 3 && /not answering/.test(addresses.state.error));

    const no = await call(addresses.route, "/relay/addresses", { authorise: () => null });
    ok("not signed in: 401", no.status === 401 && !no.body.addresses);
    const yes = await call(addresses.route, "/relay/addresses", { authorise: () => "msg:sam" });
    ok("signed in: the list", yes.status === 200 && yes.body.addresses.length === 3);
    const pr = await call(addresses.route, "/relay/probe/abc", {});
    ok("a probe this relay did not send is a 404", pr.status === 404);

    /* The real probe: a number is known only while it is being asked. */
    addresses.init({ port: 9000, start: false, readConfig: async () => ({ config: { ingress: [] } }) });
    const srv = http.createServer((req, res) => addresses.route(req, res, new URL(req.url, "http://x"), { send: () => {} }));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    addresses.init({ port: 9000, start: false, config: { extra: ["http://127.0.0.1:" + srv.address().port] },
      readConfig: async () => ({ config: { ingress: [] } }) });
    await addresses.refresh();
    ok("an address that reaches this relay passes the real probe", addresses.state.addresses.length === 1, JSON.stringify(addresses.state));
    srv.close();
    addresses.stop();
  }

  section("the model shelf");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-shelf-"));
    const into = path.join(dir, "shelf", "Tiny-Model-MLC");
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(path.join(into, "params_shard_0.bin"), Buffer.alloc(1000, 7));
    fs.writeFileSync(path.join(into, "model.wasm"), Buffer.from("wasm"));
    fs.writeFileSync(path.join(into, "manifest.json"), JSON.stringify({ id: "Tiny-Model-MLC", bytes: 1004,
      files: [{ name: "params_shard_0.bin", size: 1000, sha256: "x" }, { name: "model.wasm", size: 4, sha256: "y" }] }));
    shelf.init({ dataDir: dir, start: false, config: { models: ["Tiny-Model-MLC", "Not-Here-Yet-MLC"] } });
    const l = await call(shelf.route, "/k/list", {});
    ok("only a model with its manifest is listed", l.status === 200 && l.body.models.length === 1 && l.body.models[0].id === "Tiny-Model-MLC");
    ok("its files by number", l.body.models[0].files.map((f) => f.i + ":" + f.name).join() === "0:params_shard_0.bin,1:model.wasm");
    const f = await call(shelf.route, "/k/0/0", { clientIp: () => "1.2.3.4" });
    ok("a file is served whole", f.status === 200 && f.raw.length === 1000 && f.raw[0] === 7);
    ok("past the end is a 404", (await call(shelf.route, "/k/0/9", {})).status === 404 && (await call(shelf.route, "/k/5/0", {})).status === 404);
    ok("names and paths are not routes", (await call(shelf.route, "/k/0/..%2Fmanifest.json", {})).status === 418);
    shelf.init({ dataDir: dir, start: false, config: { models: [] } });
    await shelf.fillAll();
    ok("a model taken off the list is deleted from the disk", !fs.existsSync(into) && (await call(shelf.route, "/k/list", {})).body.models.length === 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  section("servers that fetch the relay's key try every address");
  {
    const { RelayKey, relayBases } = require("../relay/browser-helper");
    ok("one address, a list, or an array", relayBases("https://a.x/").join() === "https://a.x" &&
      relayBases("https://a.x, https://b.x").join() === "https://a.x,https://b.x" && relayBases(["https://c.x"]).join() === "https://c.x");
    const pem = require("crypto").generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const asked = [];
    const k = new RelayKey("https://gone.x,https://alive.x", async (u) => {
      asked.push(u);
      if (u.startsWith("https://gone.x")) throw new Error("fetch failed");
      return { ok: true, json: async () => ({ key: pem }) };
    });
    ok("a deleted first address: the next one gives the key", (await k.load()) === true && k.base === "https://alive.x");
    asked.length = 0;
    await k.load();
    ok("and the one that worked is asked first after that", asked[0] === "https://alive.x/browser/helper-key" && asked.length === 1);
    const src = fs.readFileSync(path.join(__dirname, "..", "runnerd", "server.js"), "utf8");
    ok("runnerd takes a list too, and FK_RELAY_URL over its file", /split\(\/\[\\s,\]\+\/\)/.test(src) && /process\.env\.FK_RELAY_URL/.test(src));
  }

  section("wired into the relay");
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "relay", "server.js"), "utf8");
    ok("server.js routes /k and /relay", /modelShelf\.route\(/.test(src) && /addresses\.route\(/.test(src));
    const deploy = fs.readFileSync(path.join(__dirname, "..", "tools", "make-deploy.js"), "utf8");
    ok("and both ship in the relay image", /"model-shelf\.js"/.test(deploy) && /"addresses\.js"/.test(deploy));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
