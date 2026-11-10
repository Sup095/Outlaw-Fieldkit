/* ============================================================
   EMAIL UPDATES: the SMTP client (relay/mail-updates' mailer.js), the
   relay's opt-in digest (relay/mail-updates.js), its hooks in POOL HALL
   and DEEPHOLD, and the panel (modules/email-updates.js).

   What matters:
     1. Nothing is sent to an address that has not proved it is theirs.
     2. Several things become ONE email, after a short wait, and no
        address is flooded.
     3. What you have already seen in FieldKit is not emailed.
     4. One click in any email stops them.
     5. The mail client speaks SMTP properly and never sends a password
        over a connection that is not encrypted.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "core/pool-engine.js", "modules/email-updates.js"]);
const { ok, section, state } = makeRunner("mail-updates");
const mailer = require("../relay/mailer");
const mail = require("../relay/mail-updates");
const players = require("../relay/colony-players");
const pool = require("../relay/pool");
const E = require("../relay/colony-engine");

/* A tiny SMTP server that records what it is told. */
function fakeSmtp(opts) {
  opts = opts || {};
  const got = { lines: [], data: "", auth: null };
  const srv = net.createServer((sock) => {
    let buf = "", inData = false;
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; sock.write("250 queued\r\n"); } else got.data += line + "\r\n";
          continue;
        }
        got.lines.push(line);
        if (/^EHLO/.test(line)) sock.write("250-fake\r\n" + (opts.starttls ? "250-STARTTLS\r\n" : "") + "250 AUTH PLAIN\r\n");
        else if (/^AUTH PLAIN /.test(line)) { got.auth = Buffer.from(line.slice(11), "base64").toString("utf8"); sock.write(opts.badAuth ? "535 bad credentials\r\n" : "235 ok\r\n"); }
        else if (/^MAIL FROM/.test(line) || /^RCPT TO/.test(line)) sock.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (line === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("500 what\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((ok2) => srv.listen(0, "127.0.0.1", () => ok2({ srv, got, port: srv.address().port })));
}

(async () => {
  section("the mail client");
  {
    const s = await fakeSmtp();
    const cfg = { host: "127.0.0.1", port: s.port, secure: true, user: "relay@example.com", pass: "app-pass-1234", from: "FieldKit <relay@example.com>" };
    /* secure:true with a plain socket stands in for TLS here */
    const r = await mailer.send(cfg, { to: "ava@example.com", subject: "Héllo — test", text: "line one\n.\nline three", html: "<p>hi</p>", unsubscribe: "https://relay.example/email/off?id=1&t=2" }, { connect: (o) => net.connect(o) });
    ok("it sends a message", r.ok === true);
    ok("it signs in with the account and app password", s.got.auth === "\u0000relay@example.com\u0000app-pass-1234");
    ok("from and to are the right addresses", s.got.lines.indexOf("MAIL FROM:<relay@example.com>") >= 0 && s.got.lines.indexOf("RCPT TO:<ava@example.com>") >= 0);
    ok("the subject is encoded so any language survives", /Subject: =\?UTF-8\?B\?/.test(s.got.data));
    ok("there is a plain and an HTML version, and a one-click stop header", /multipart\/alternative/.test(s.got.data) && /text\/plain/.test(s.got.data) && /text\/html/.test(s.got.data) && /List-Unsubscribe: <https:\/\/relay\.example/.test(s.got.data));
    const part = s.got.data.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
    ok("the body arrives intact, even a line with only a dot", Buffer.from(part, "base64").toString("utf8") === "line one\n.\nline three");
    s.srv.close();

    const s2 = await fakeSmtp();
    let err = null;
    try { await mailer.send({ host: "127.0.0.1", port: s2.port, secure: false, user: "u", pass: "secret-pw", from: "a@b.co" }, { to: "x@y.co", subject: "s", text: "t" }); } catch (e) { err = e; }
    ok("on a server without STARTTLS it refuses rather than send the password in the clear", err && /STARTTLS/.test(err.message) && s2.got.auth === null);
    s2.srv.close();

    const s3 = await fakeSmtp({ badAuth: true });
    err = null;
    try { await mailer.send({ host: "127.0.0.1", port: s3.port, secure: true, user: "u", pass: "wrong", from: "a@b.co" }, { to: "x@y.co", subject: "s", text: "t" }, { connect: (o) => net.connect(o) }); } catch (e) { err = e; }
    ok("a wrong app password says so", err && /sign-in/.test(err.message) && /535/.test(err.message));
    s3.srv.close();
    err = null;
    try { await mailer.send({ host: "127.0.0.1", port: 1, secure: true, from: "a@b.co" }, { to: "not an address", subject: "s", text: "t" }); } catch (e) { err = e; }
    ok("a bad address is refused before connecting", err && /not an email address/.test(err.message));
    const raw = mailer.compose({ from: "FieldKit <a@b.co>", to: "x@y.co", subject: "Line\r\nBcc: evil@z.co", text: "t" });
    ok("a subject cannot add headers", !/\r\nBcc:/.test(raw));
  }

  section("signing up");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-mail-"));
  let now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const sent = [];
  let failNext = false;
  const sender = async (m) => { if (failNext) { failNext = false; throw new Error("connection refused"); } sent.push(m); return { ok: true }; };
  mail.init({ dataDir: dir, config: {}, start: false, now: () => now, send: sender });
  ok("without email settings it is off", mail.up() === false);
  let version = "0.14.0";
  mail.init({ dataDir: dir, config: { host: "smtp.example.com", port: 465, user: "relay@example.com", pass: "x", from: "FieldKit <relay@example.com>", publicUrl: "https://relay.example.org/", maxPerDay: 50 }, start: false, now: () => now, send: sender, version: () => version });
  ok("with them it is on", mail.up() === true);
  players.init({ dataDir: dir, now: () => now });
  pool.init({ dataDir: dir, start: false, now: () => now });
  const tok = {};
  for (const [t, ip] of [["Ava", "1.1.1.1"], ["Ben", "1.1.1.2"]]) tok[t] = players.register(t, "pool-pass-" + t, ip).token;
  const whoOf = (h) => (h.tag ? { msg: h.msg || null, tag: players.keyOf(h.tag), tagName: h.tag } : { msg: h.msg || null, tag: null, tagName: null });
  const call = async (method, p, as, body) => {
    const u = new URL("http://relay" + p);
    let out = null;
    const res = { writeHead(c, h) { out = { status: c, headers: h, html: "" }; }, end(t) { out.html = t; } };
    await mail.route({ method, headers: {}, url: u.pathname + u.search }, res, u, { send: (r, status, b) => { out = { status, b }; return true; }, readBody: async () => JSON.parse(JSON.stringify(body || {})), ip: () => "5.5.5.5", who: () => whoOf(as || {}) });
    return out;
  };
  ok("anyone can ask whether it is on", (await call("GET", "/email/status")).b.up === true);
  ok("signing up needs a sign-in", (await call("POST", "/email/subscribe", {}, { email: "a@b.co" })).status === 401);
  ok("a bad address is refused", (await call("POST", "/email/subscribe", { tag: "Ava" }, { email: "not-an-email" })).status === 400);
  const sub = await call("POST", "/email/subscribe", { tag: "Ava", msg: "ava" }, { email: "ava@example.com", cats: { messages: true, games: true, deephold: true, fieldkit: true } });
  ok("a good one is sent a six-digit code", sub.status === 200 && sub.b.sentCode && sent.length === 1 && /\b\d{6}\b/.test(sent[0].subject));
  const code = /(\d{6})/.exec(sent[0].subject)[1];
  mail.notify({ tag: players.keyOf("Ava") }, { cat: "games", text: "early" });
  ok("nothing is queued for an address not yet proved", mail._data().subs[Object.keys(mail._data().subs)[0]].pending.length === 0);
  const bad = await call("POST", "/email/verify", { tag: "Ava" }, { code: code === "000000" ? "111111" : "000000" });
  ok("a wrong code is refused and says how many tries are left", bad.status === 400 && /tries left/.test(bad.b.error));
  const good = await call("POST", "/email/verify", { tag: "Ava" }, { code: code });
  ok("the right code turns it on", good.status === 200 && good.b.sub.verified === true);
  const me = await call("POST", "/email/me", { msg: "ava" }, {});
  ok("signed in either way it is the same subscription", me.b.sub && me.b.sub.email === "ava@example.com" && me.b.sub.tag === "Ava");
  ok("nobody else sees it", (await call("POST", "/email/me", { tag: "Ben" }, {})).b.sub === null);
  ok("the code is not kept in the clear", !JSON.stringify(mail._data()).includes("\"" + code + "\""));

  section("one email, a few minutes later");
  sent.length = 0;
  mail.check("test", (it) => it.chk.still !== false);
  mail.notify({ msg: "ava" }, { cat: "messages", key: "msg:c1", text: "New message from @ben.", many: "{n} new messages from @ben.", chk: { k: "test" } });
  now += 60000;
  mail.notify({ msg: "ava" }, { cat: "messages", key: "msg:c1", text: "New message from @ben.", many: "{n} new messages from @ben.", chk: { k: "test" } });
  mail.notify({ msg: "ava" }, { cat: "messages", key: "msg:c1", text: "New message from @ben.", many: "{n} new messages from @ben.", chk: { k: "test" } });
  mail.notify({ tag: players.keyOf("Ava") }, { cat: "deephold", text: "Layer 3 is open." });
  await mail.tick();
  ok("nothing goes out straight away", sent.length === 0);
  now += mail.WAIT_MS + 1000;
  await mail.tick();
  ok("after the wait, one email carries everything", sent.length === 1 && /2 updates/.test(sent[0].subject));
  ok("repeats are folded into one line with a count", /3 new messages from @ben/.test(sent[0].text) && (sent[0].text.match(/@ben/g) || []).length === 1);
  ok("grouped under headings", /MESSAGES/.test(sent[0].text) && /DEEPHOLD/.test(sent[0].text) && /<li/.test(sent[0].html));
  ok("and every email has its stop link", /https:\/\/relay\.example\.org\/email\/off\?id=/.test(sent[0].text) && sent[0].unsubscribe);
  mail.notify({ msg: "ava" }, { cat: "messages", text: "again" });
  now += mail.WAIT_MS + 1000;
  await mail.tick();
  ok("no address gets two emails within fifteen minutes", sent.length === 1);
  now += mail.GAP_MS;
  await mail.tick();
  ok("it comes once the gap is over", sent.length === 2);
  let i0 = sent.length;
  for (let k = 0; k < 6; k++) { mail.notify({ msg: "ava" }, { cat: "messages", text: "steady " + k }); now += 4 * 60000; await mail.tick(); }
  ok("a steady stream still waits at most fifteen minutes from the first", sent.length - i0 === 1);
  now += mail.GAP_MS + mail.MAX_WAIT_MS; await mail.tick();
  mail.notify({ msg: "ava" }, { cat: "messages", text: "seen already", chk: { k: "test", still: false } });
  now += mail.GAP_MS + mail.MAX_WAIT_MS; i0 = sent.length;
  await mail.tick();
  ok("what was already seen is dropped, and an empty email is never sent", sent.length === i0 && mail._data().subs[Object.keys(mail._data().subs)[0]].pending.length === 0);

  section("what you chose, and only that");
  await call("POST", "/email/settings", { tag: "Ava" }, { cats: { deephold: false } });
  i0 = sent.length;
  mail.notify({ tag: players.keyOf("Ava") }, { cat: "deephold", text: "not wanted" });
  now += mail.GAP_MS + mail.MAX_WAIT_MS; await mail.tick();
  ok("a kind switched off is not emailed", sent.length === i0);
  await call("POST", "/email/settings", { tag: "Ava" }, { cats: { deephold: true } });

  section("POOL HALL and DEEPHOLD say what happened");
  const pcall = async (method, p, who, body) => {
    const u = new URL("http://relay" + p);
    let out = null;
    await pool.route({ method, headers: { authorization: "Bearer " + tok[who] }, url: u.pathname + u.search }, {}, u, { send: (r, status, b) => { out = { status, b }; return true; }, readBody: async () => body || {}, ip: () => "9.9.9.9" });
    return out;
  };
  now += mail.GAP_MS + mail.MAX_WAIT_MS;
  const ch = await pcall("POST", "/pool/challenge", "Ben", { to: "Ava" });
  now += mail.WAIT_MS + 1000; i0 = sent.length;
  await mail.tick();
  ok("a challenge is emailed to the one challenged", sent.length === i0 + 1 && /Ben challenged you/.test(sent[sent.length - 1].text) && /GAMES/.test(sent[sent.length - 1].text));
  now += mail.GAP_MS;
  const acc = await pcall("POST", "/pool/accept", "Ava", { id: ch.b.match.id });
  const s1 = await pcall("POST", "/pool/shot", "Ava", { id: ch.b.match.id, seq: 0, shot: { dx: 1, dy: 0.002, power: 1, sx: 0, sy: 0, cue: { x: 2.54 / 4 - 0.12, y: 1.27 / 2 } } });
  ok("(a match is under way)", acc.status === 200 && s1.status === 200);
  now += 1000;
  await pcall("GET", "/pool/lobby", "Ava");
  now += mail.WAIT_MS + 1000; i0 = sent.length;
  await mail.tick();
  ok("news about a match she has looked at since is not emailed", sent.length === i0);
  /* DEEPHOLD: a world with Ava's colony */
  const colony = require("../relay/colony");
  colony.init({ dataDir: dir, start: false, now: () => now });
  const world = colony._world();
  world.colonies[players.keyOf("Ava")] = E.newColony(players.keyOf("Ava"), Object.keys(E.BIOMES)[0], "Ava's hold", now - 3600000);
  world.colonies[players.keyOf("Ava")].lastSeen = now - 3600000;
  E.emit(world, now, players.keyOf("Ava"), "ok", "Layer 3 is open. Room to build.", "dig");
  E.emit(world, now, null, "bad", "A WAVE ARRIVES IN TEN MINUTES.", "war");
  E.emit(world, now, null, "ok", "STAGE 2 REACHED: TEST.", "stage");
  const subNow = mail._data().subs[Object.keys(mail._data().subs)[0]];
  ok("DEEPHOLD's own news reaches the queue, and the Civilization's big moments", subNow.pending.some((p) => /Layer 3 is open/.test(p.text)) && subNow.pending.some((p) => /STAGE 2 REACHED/.test(p.text)));
  ok("but not the ten-minute warning", !subNow.pending.some((p) => /TEN MINUTES/.test(p.text)));
  world.colonies[players.keyOf("Ava")].lastSeen = now + 1000;
  now += mail.GAP_MS + mail.MAX_WAIT_MS; i0 = sent.length;
  await mail.tick();
  ok("and once she has opened DEEPHOLD since, it is not emailed", sent.length === i0 && !subNow.pending.length);

  section("FieldKit news");
  subNow.pending = []; subNow.first = 0; subNow.due = 0;
  now += mail.GAP_MS + mail.MAX_WAIT_MS;
  await mail.tick();
  ok("the version the relay first sees is only remembered", mail._data().announced === "0.14.0" && !subNow.pending.length);
  version = "0.15.0";
  await mail.tick();
  ok("a new one is news for everyone who wants FieldKit news", subNow.pending.some((p) => /FieldKit 0\.15\.0 is out/.test(p.text)));
  await mail.tick();
  ok("and only once", subNow.pending.filter((p) => /0\.15\.0/.test(p.text)).length === 1 && (subNow.pending[0].n || 1) === 1);

  section("trouble sending");
  now += mail.GAP_MS + mail.MAX_WAIT_MS; i0 = sent.length;
  failNext = true;
  await mail.tick();
  ok("a failed send keeps the items and tries again later", sent.length === i0 && subNow.pending.length === 1 && mail.summary().error && /refused/.test(mail.summary().error.text));
  now += 11 * 60000;
  await mail.tick();
  ok("and then it goes", sent.length === i0 + 1 && !subNow.pending.length && mail.summary().error === null);

  section("stopping");
  const off = /https:\/\/relay\.example\.org(\/email\/off\?id=[^\s]+)/.exec(sent[sent.length - 1].text)[1];
  const look = await call("GET", off);
  ok("the link in an email asks first (a link checker cannot stop them by visiting)", /STOP THE EMAILS/.test(look.html) && Object.keys(mail._data().subs).length === 1);
  ok("that page loads nothing from anywhere", /default-src 'none'/.test(look.headers["Content-Security-Policy"]));
  const wrong = await call("GET", off.replace(/t=[0-9a-f]+/, "t=" + "0".repeat(32)));
  ok("a made-up link does nothing", /already off/.test(wrong.html) && Object.keys(mail._data().subs).length === 1);
  const done = await call("GET", off + "&yes=1");
  ok("one click on the button stops them", /Done/.test(done.html) && Object.keys(mail._data().subs).length === 0);
  mail.notify({ msg: "ava" }, { cat: "messages", text: "x" });
  ok("and nothing is queued for them after", Object.keys(mail._data().subs).length === 0);

  section("limits");
  sent.length = 0;
  let codes = 0;
  for (let k = 0; k < 5; k++) if ((await call("POST", "/email/subscribe", { tag: "Ben" }, { email: "ben" + k + "@example.com" })).b.sentCode) codes++;
  ok("an address change sends a new code, but no more than three an hour", codes === 3);
  const flood = await call("POST", "/email/resend", { tag: "Ben" }, {});
  ok("resending is held to the same limit", flood.status === 429);
  mail.flush();
  mail.init({ dataDir: dir, config: { host: "smtp.example.com", from: "a@b.co", maxPerDay: 2 }, start: false, now: () => now, send: sender });
  ok("subscriptions survive a restart", Object.keys(mail._data().subs).length === 1);
  ok("the relay keeps to its daily limit", mail.summary().sentToday >= 2 && (await call("POST", "/email/resend", { tag: "Ben" }, {})).status >= 429);

  section("the panel");
  {
    mail.init({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fk-mail2-")), config: { host: "smtp.example.com", from: "a@b.co" }, start: false, now: () => now, send: sender });
    sent.length = 0;
    const ui = FieldKit.need("ui");
    FieldKit.need("settings").set("relayUrl", "https://relay.test");
    if (!window.localStorage) window.localStorage = global.localStorage;
    window.localStorage.setItem("fk.deephold", JSON.stringify({ token: tok.Ava, tag: "Ava" }));
    window.fetch = async (url, o) => {
      const u = new URL(url), body = JSON.parse(o.body || "{}");
      let out = null;
      const auth = (o.headers || {}).Authorization || "";
      const g = players.authToken(auth.slice(7)) || players.authToken(body.gameToken);
      await mail.route({ method: o.method || "GET", headers: {}, url: u.pathname }, {}, u, { send: (r, status, b) => { out = { status, b }; return true; }, readBody: async () => body, ip: () => "6.6.6.6", who: () => ({ msg: null, tag: g ? g.key : null, tagName: g ? g.tag : null }) });
      const t = JSON.stringify(out.b);
      return { ok: out.status < 400, status: out.status, text: async () => t };
    };
    const host = fakeElement("div");
    const all = (node) => { const out = []; (function w(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); w(c); } }); })(node); return out; };
    const text = () => all(host).map((n) => n.textContent || "").join(" | ");
    const def = FieldKit.modules()["email-updates"];
    await def.mount(host, { settings: FieldKit.need("settings"), ui, log() {}, warn() {}, error() {}, on() {}, emit() {} });
    ok("it opens on the sign-up, signed in with the gamertag", /GAMERTAG Ava/.test(text()) && /SEND ME A CODE/.test(text()));
    ok("MESSAGES updates say they need a MESSAGES sign-in", /sign in to MESSAGES for this/.test(text()));
    const P = FieldKit.service("emailUpdates");
    await P._act("subscribe", { email: "ava@example.com", cats: { games: true } });
    ok("asking for a code shows the code box", /TYPE THE CODE SENT TO AVA@EXAMPLE.COM/.test(text()) && sent.length === 1);
    await P._act("verify", { code: /(\d{6})/.exec(sent[0].subject)[1] });
    ok("the right code turns it on", /ON — SENDING TO AVA@EXAMPLE.COM/.test(text()) && /SEND A TEST EMAIL/.test(text()));
    await P._act("test", {});
    ok("a test email is sent at once", sent.length === 2 && /This is a test/.test(sent[1].text));
    await P._act("stop", {});
    ok("turning it off goes back to the sign-up", /SEND ME A CODE/.test(text()));
    def.unmount();
  }

  section("wired into FieldKit");
  {
    const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    ok("both builds carry the panel", ["FIELDKIT.html", "OUTPOST.html"].every((f) => /"modules\/email-updates\.js"/.test(rd(f))));
    ok("the relay routes /email and the deploy ships both files", /seg\[0\] === "email"/.test(rd("relay/server.js")) && /"mail-updates\.js"/.test(rd("tools/make-deploy.js")) && /"mailer\.js"/.test(rd("tools/make-deploy.js")));
    ok("MESSAGES says who wrote, never what", /mailUpdates\.notify\(\{ msg: h \}/.test(rd("relay/messaging.js")) && !/body\.ct[^;]*mailUpdates|mailUpdates[^;]*\bct\b/.test(rd("relay/messaging.js")));
    ok("the panel never builds markup from text", !/innerHTML/.test(rd("modules/email-updates.js")));
    ok("the example settings show where the email account goes, with no real password", /"email"/.test(rd("relay/config.example.json")) && /smtp\.gmail\.com/.test(rd("relay/config.example.json")));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
