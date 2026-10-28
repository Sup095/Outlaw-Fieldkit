/* ============================================================
   Abuse (RUNNER_PLAN.md phase 9, FIELDKIT_PROJECT.md §14.41).

   A hostile client, not a careless one: forged and replayed tickets,
   garbage frames, floods, names that try to escape, other people's
   file ids, and the relay's pass-through poked at. What matters:
   every one is refused in words or ignored, the run server stays up,
   and an honest client connected the whole time is unaffected.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { makeRunner } = require("./harness");
const { connect, wait, sha } = require("./runner-kit");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");
const relayRunner = require("../relay/runner");
const { ok, section, state } = makeRunner("runner-abuse");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-abuse-"));
const pair = crypto.generateKeyPairSync("ed25519");
const other = crypto.generateKeyPairSync("ed25519");
const sign = (handle, tier, o) => ticket.sign((o && o.key) || pair.privateKey,
  Object.assign({ handle, tier, exp: Date.now() + 30000 }, (o && o.claims) || {}));

/* A raw upgrade, for answers a WebSocket client hides. */
function rawUpgrade(port, p, extra) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write("GET " + p + " HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" + (extra || "") + "\r\n"));
    let got = "";
    s.on("data", (d) => { got += d.toString("latin1"); if (got.indexOf("\r\n") > 0) { s.destroy(); resolve(got.split("\r\n")[0]); } });
    s.on("error", () => resolve(got.split("\r\n")[0] || "error"));
    s.on("close", () => resolve(got.split("\r\n")[0] || "closed"));
    setTimeout(() => { s.destroy(); resolve("timeout"); }, 5000);
  });
}

(async () => {
  const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
    storePath: path.join(TMP, "store"), driver: "process", dev: true,
    ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
    machine: { maxSessions: 6, maxGuestSessions: 2 } }), () => {});
  const port = await app.listen();
  const alive = async () => { try { return (await fetch("http://127.0.0.1:" + port + "/health")).ok; } catch (e) { return false; } };

  /* The honest one, connected throughout. */
  const honest = await connect(port, sign("honest", "member"));
  await honest.hello();
  const hput = await honest.put("mine.js", "console.log('still fine')");

  section("tickets");
  {
    ok("no ticket", /401/.test(await rawUpgrade(port, "/attach")));
    ok("a made-up ticket", /401/.test(await rawUpgrade(port, "/attach?t=abc.def")));
    ok("signed by somebody else's key", /401/.test(await rawUpgrade(port, "/attach?t=" + encodeURIComponent(sign("x", "admin", { key: other.privateKey })))));
    ok("expired", /401/.test(await rawUpgrade(port, "/attach?t=" + encodeURIComponent(sign("x", "member", { claims: { exp: Date.now() - 1000 } })))));
    const t = sign("replay", "member");
    const first = await connect(port, t);
    ok("a good ticket works once", first.open);
    ok("and is refused the second time", /401/.test(await rawUpgrade(port, "/attach?t=" + encodeURIComponent(t))));
    await first.close();
    const forged = Buffer.from(JSON.stringify({ v: 1, aud: "fieldkit-runner", handle: "boss", tier: "admin", exp: Date.now() + 30000, n: "1" })).toString("base64url");
    ok("a ticket with its body changed (tier: admin)", /401/.test(await rawUpgrade(port, "/attach?t=" + forged + "." + t.split(".")[1])));
    ok("any other path", /404/.test(await rawUpgrade(port, "/attach/../admin?t=" + encodeURIComponent(sign("y", "admin")))));
  }

  section("garbage and floods");
  {
    const c = await connect(port, sign("mallory", "member"));
    await c.hello();
    for (const junk of ["not json", "[]", "null", "42", "{\"t\":5}", "{\"t\":null}", "{}", "{\"t\":\"" + "x".repeat(5000) + "\"}", "{\"t\":\"adm-sweep\"}"]) c.sock.send(junk);
    await wait(200);
    ok("junk messages get no crash, and admin commands are refused", c.got.some((m) => m.t === "error" && /admins only/.test(m.why)) && await alive());
    c.sock.send("{\"t\":\"ls\",\"pad\":\"" + "y".repeat(140 * 1024) + "\"}");
    const big = await c.next((m) => m.t === "error" && /too large/.test(m.why)).catch(() => null);
    ok("a command over the size limit is refused in words", !!big);
    c.sock.send(Buffer.from("bytes with no upload"));
    const nb = await c.next((m) => m.t === "error").catch(() => null);
    ok("bytes with no upload going are refused", !!nb);
    let deep = ""; for (let i = 0; i < 5000; i++) deep += "["; c.sock.send("{\"t\":\"ls\",\"d\":" + deep + "}");
    await wait(100);
    ok("deeply nested JSON does not take it down", await alive());
    const before = c.got.length;
    for (let i = 0; i < 2000; i++) c.sock.send("{\"t\":\"ls\"}");
    await wait(1500);
    const answered = c.got.length - before;
    ok("a flood is cut to the per-second limit", answered > 0 && answered <= 130, String(answered));
    c.say({ t: "ui", job: "nope", ev: new Array(10000).fill({ t: "m", x: 1e9, y: NaN }) });
    await wait(100);
    ok("a giant input batch for no job is harmless", await alive());
    await c.close();
  }

  section("names and other people's things");
  {
    const c = await connect(port, sign("mallory2", "member"));
    await c.hello();
    const bad = ["../../etc/passwd", "..\\..\\boot.ini", "/abs/path", "nul\u0000byte.js", "CON", "a".repeat(600), "", ".", ".."];
    const names = [];
    for (const n of bad) { const r = await c.put(n, "x"); if (r.t === "put-done") names.push(r.file ? r.file.name : r.name); }
    const ls = (c.say({ t: "ls" }), await c.next("files"));
    const all = (ls.files || []).map((f) => f.name);
    ok("no stored name can climb out of its folder or carry a NUL", all.every((n) => !/[\/\\\u0000]/.test(n) && n !== ".." && n !== "." && n.length <= 255), JSON.stringify(all));
    const ids = { file: hput.file ? hput.file.id : (hput.id || "") };
    for (const t of ["run", "rm", "take", "zip-ls"]) c.say({ t, file: ids.file, id: ids.file, ref: "o" + t });
    await wait(400);
    const hl = (honest.say({ t: "ls" }), await honest.next("files"));
    ok("someone else's file id cannot be run, deleted or opened", (hl.files || []).some((f) => f.name === "mine.js") &&
      !c.got.some((m) => m.t === "job"));
    c.say({ t: "save-get", path: "../../../../etc/passwd", ref: "sv" });
    const sv = await c.next((m) => m.ref === "sv" || (m.t === "error" && m.ref === "sv")).catch(() => ({ t: "none" }));
    ok("the saved folder cannot be read outside itself", sv.t !== "save-file", JSON.stringify(sv).slice(0, 160));
    await wait(200); c.got.length = 0;   /* the refusals above, answered */
    const big = Buffer.alloc(1000, 1);
    c.say({ t: "put", ref: "lie", name: "lie.bin", size: 10, sha256: sha(big) });
    await c.next((m) => m.t === "put-ok" || m.t === "error");
    c.sock.send(big);
    const lie = await c.next((m) => m.t === "error" || m.t === "put-done");
    ok("more bytes than declared are refused", lie.t === "error" && /more bytes/.test(lie.why), JSON.stringify(lie));
    const r2 = await c.put("wrong.txt", "abc", "0".repeat(64));
    ok("a wrong hash is refused, and nothing is kept", r2.t === "error" && /hash/.test(r2.why), JSON.stringify(r2));
    await c.close();
  }

  section("too many at once");
  {
    const gs = [];
    for (let i = 0; i < 4; i++) gs.push(await connect(port, sign("guest" + i, "guest")));
    ok("guests beyond their share are turned away at the door", gs.filter((g) => g.open && !g.closed).length === 2);
    for (const g of gs) await g.close();
  }

  section("the relay's pass-through");
  {
    relayRunner.init({ dataDir: path.join(TMP, "relay"), log: () => {}, whoami: () => null,
      config: { enabled: true, innerUrl: "http://127.0.0.1:" + port } });
    const relay = http.createServer((q, s) => { s.writeHead(404); s.end(); });
    relay.on("upgrade", (q, sock, head) => {
      const u = new URL(q.url, "http://relay");
      if (relayRunner.isAttach(u)) return relayRunner.attach(q, sock, head, u);
      sock.destroy();
    });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    const rp = relay.address().port;
    ok("a forged ticket through the relay is refused by the run server", /401/.test(await rawUpgrade(rp, "/runner/attach?t=" + encodeURIComponent(sign("x", "admin", { key: other.privateKey })))));
    ok("the path cannot be bent to another route", /404/.test(await rawUpgrade(rp, "/runner/attach?t=x&/../health")) || /401/.test(await rawUpgrade(rp, "/runner/attach?t=x&/../health")));
    ok("headers smuggled in the query do not reach it", /401/.test(await rawUpgrade(rp, "/runner/attach?t=x%0d%0aX-Evil:%201")));
    const slow = net.connect(rp, "127.0.0.1"); slow.write("GET /runner/attach HTTP/1.1\r\n");
    await wait(200); slow.destroy();
    ok("a half-sent request leaves nothing broken", await alive() && /401/.test(await rawUpgrade(rp, "/runner/attach?t=x")));
    await new Promise((r) => relay.close(r));
  }

  section("the honest client never noticed");
  {
    const r = await honest.run(hput.file ? hput.file.id : hput.id);
    const out = r.t === "job" ? await honest.next((m) => m.t === "out" && /still fine/.test(m.d || "")).catch(() => null) : null;
    ok("its program still runs, with its output", r.t === "job" && !!out, JSON.stringify(r).slice(0, 160));
    ok("and the run server is up", await alive());
  }

  await honest.close();
  await app.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
