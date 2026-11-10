/* ============================================================
   FieldKit relay :: mailer — sends one email, nothing else

   A small SMTP client on Node's own net and tls, so the relay needs no
   package and no mail server of its own: it hands each email to an
   ordinary mail account's outgoing server (Gmail with an app password,
   Brevo, or any SMTP service), the same way a mail app does.

     port 465   TLS from the first byte (Gmail's smtp.gmail.com:465)
     port 587   plain first, then STARTTLS; refused if the server will
                not switch to TLS, so the password is never sent in
                the clear

   Settings (config.local.json, "email"): host, port, user, pass, from.
   The password lives only there and in the generated config.json, both
   gitignored. Nothing here logs it.
   ============================================================ */
"use strict";

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

const TIMEOUT_MS = 20000;

/* Reads SMTP replies: "250-first\r\n250 last\r\n" is one reply. */
function reader(sock) {
  let buf = "", waiting = null, lines = [];
  const queue = [];
  function pump() {
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const r = { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join("\n") };
        lines = [];
        if (waiting) { const w = waiting; waiting = null; w.ok(r); } else queue.push(r);
      }
    }
  }
  const onData = (d) => { buf += d.toString("utf8"); if (buf.length > 65536) buf = buf.slice(-65536); pump(); };
  sock.on("data", onData);
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((ok, fail) => { waiting = { ok, fail }; });
    },
    fail(e) { if (waiting) { const w = waiting; waiting = null; w.fail(e); } },
    detach() { sock.removeListener("data", onData); }
  };
}

const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");
const encWord = (s) => /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64(s) + "?=";
const clean = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
function addrOf(from) { const m = /<([^>]+)>/.exec(from); return clean(m ? m[1] : from); }
function fromHeader(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(clean(from));
  if (!m || !m[1]) return addrOf(from);
  return encWord(m[1].replace(/"/g, "")) + " <" + m[2] + ">";
}

/* The whole message, headers and body, as text with CRLF line ends. */
function compose(o) {
  const id = crypto.randomBytes(12).toString("hex");
  const domain = (addrOf(o.from).split("@")[1] || "fieldkit.local").replace(/[^A-Za-z0-9.-]/g, "");
  const boundary = "fk-" + id;
  const head = [
    "From: " + fromHeader(o.from),
    "To: " + clean(o.to),
    "Subject: " + encWord(clean(o.subject)),
    "Date: " + new Date(o.now || Date.now()).toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + id + "@" + domain + ">",
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated"
  ];
  if (o.unsubscribe) {
    head.push("List-Unsubscribe: <" + clean(o.unsubscribe) + ">");
  }
  let body;
  if (o.html) {
    head.push("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"");
    body = "--" + boundary + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + wrap76(b64(o.text || "")) +
      "--" + boundary + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + wrap76(b64(o.html)) +
      "--" + boundary + "--\r\n";
  } else {
    head.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    body = wrap76(b64(o.text || ""));
  }
  return head.join("\r\n") + "\r\n\r\n" + body;
}

/* cfg: { host, port, user, pass, from }   mail: { to, subject, text, html, unsubscribe }
   Resolves { ok:true } or rejects with an Error whose message says which step failed. */
function send(cfg, mail, opts) {
  opts = opts || {};
  const port = Number(cfg.port) || 465;
  const secure = cfg.secure != null ? !!cfg.secure : port === 465;
  const host = String(cfg.host || "");
  const connect = opts.connect || ((o) => secure ? tls.connect(o) : net.connect(o));
  if (!host) return Promise.reject(new Error("no email host is set"));
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(clean(mail.to))) return Promise.reject(new Error("not an email address"));

  return new Promise((resolve, reject) => {
    let sock = connect({ host: host, port: port, servername: host, rejectUnauthorized: opts.insecure ? false : true });
    let rd = reader(sock), done = false, step = "connecting";
    const timer = setTimeout(() => finish(new Error("the mail server did not answer in time (" + step + ")")), opts.timeoutMs || TIMEOUT_MS);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.end(); sock.destroy(); } catch (e) { /* gone */ }
      if (err) reject(err); else resolve({ ok: true });
    }
    function wire(s) {
      s.on("error", (e) => { rd.fail(e); finish(new Error("mail server connection: " + e.message + " (" + step + ")")); });
      s.on("close", () => { rd.fail(new Error("closed")); });
    }
    wire(sock);
    const write = (line) => sock.write(line + "\r\n");
    async function expect(codes, what) {
      step = what;
      const r = await rd.next();
      if (codes.indexOf(r.code) < 0) throw new Error(what + ": the mail server said " + r.code + " " + r.text.split("\n")[0].slice(0, 160));
      return r;
    }
    const me = "fieldkit-relay";
    (async () => {
      await expect([220], "greeting");
      write("EHLO " + me);
      let ehlo = await expect([250], "EHLO");
      if (!secure) {
        if (!/STARTTLS/i.test(ehlo.text)) throw new Error("the mail server on port " + port + " does not offer STARTTLS; use port 465");
        write("STARTTLS");
        await expect([220], "STARTTLS");
        rd.detach();
        const plain = sock;
        sock = (opts.upgrade || ((o) => tls.connect(o)))({ socket: plain, servername: host, rejectUnauthorized: opts.insecure ? false : true });
        rd = reader(sock);
        wire(sock);
        await new Promise((ok, fail) => { if (opts.upgrade) return ok(); sock.once("secureConnect", ok); sock.once("error", fail); });
        write("EHLO " + me);
        ehlo = await expect([250], "EHLO after STARTTLS");
      }
      if (cfg.user) {
        write("AUTH PLAIN " + b64("\u0000" + cfg.user + "\u0000" + (cfg.pass || "")));
        await expect([235], "sign-in (check the user and app password)");
      }
      write("MAIL FROM:<" + addrOf(cfg.from || cfg.user) + ">");
      await expect([250], "MAIL FROM");
      write("RCPT TO:<" + clean(mail.to) + ">");
      await expect([250, 251], "RCPT TO");
      write("DATA");
      await expect([354], "DATA");
      const msg = compose(Object.assign({ from: cfg.from || cfg.user }, mail));
      sock.write(msg.replace(/\r\n\./g, "\r\n..") + "\r\n.\r\n");
      await expect([250], "sending the message");
      write("QUIT");
      finish(null);
    })().catch(finish);
  });
}

function configured(cfg) { return !!(cfg && cfg.host && cfg.from !== "" && (cfg.from || cfg.user)); }

module.exports = { send, compose, configured, _reader: reader };
