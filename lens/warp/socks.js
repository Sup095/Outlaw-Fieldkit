/* ============================================================
   FieldKit lens :: warp/socks — a SOCKS5 door into Cloudflare WARP

   Runs inside the fk-warp container, whose only way out is a WARP
   WireGuard tunnel (start.sh). Lens (egress.js) asks it for the
   connections YouTube needs, so YouTube sees a Cloudflare address
   instead of the rented server's, which it refuses.

   Deliberately small: CONNECT only, to an ADDRESS only (lens's guard
   has already resolved and judged the name), never to a private or
   local one, no login (it listens on the host's 127.0.0.1 only).

   It also watches the tunnel: if Cloudflare cannot be reached through
   it three minutes running, it exits and Docker starts the container
   again, which builds the tunnel afresh.
   ============================================================ */
"use strict";

const net = require("net");

const PORT = Number(process.env.FK_SOCKS_PORT) || 1080;
const CHECK_MS = 60 * 1000;

function log(level, msg) { console.log(new Date().toISOString() + " " + level + " warp: " + msg); }

/* Never inside: loopback, private, link-local, carrier NAT, multicast. */
function privateAddress(a) {
  if (net.isIPv4(a)) {
    const [x, y] = a.split(".").map(Number);
    return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y < 128) ||
      (x === 169 && y === 254) || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168);
  }
  const s = a.toLowerCase();
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || /^::ffff:/.test(s);
}

function v6(b) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(i).toString(16));
  return g.join(":");
}

/* opts.allowLocal: tests only, so loopback sites can stand in. */
function createServer(opts) { const allowLocal = !!(opts && opts.allowLocal); return net.createServer((c) => {
  let buf = Buffer.alloc(0), step = 0, up = null;
  c.setTimeout(15000, () => c.destroy());
  const reply = (code) => { try { c.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (e) {} };
  c.on("error", () => { if (up) up.destroy(); });
  c.on("close", () => { if (up) up.destroy(); });
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 512) return c.destroy();
    if (step === 0) {
      if (buf.length < 2 || buf.length < 2 + buf[1]) return;
      if (buf[0] !== 5 || !buf.subarray(2, 2 + buf[1]).includes(0)) { c.end(Buffer.from([5, 0xff])); return; }
      buf = buf.subarray(2 + buf[1]);
      c.write(Buffer.from([5, 0]));
      step = 1;
    }
    if (step === 1) {
      if (buf.length < 4) return;
      if (buf[0] !== 5 || buf[1] !== 1) return reply(7);           /* CONNECT only */
      const atyp = buf[3];
      const len = atyp === 1 ? 10 : atyp === 4 ? 22 : 0;
      if (!len) return reply(8);                                   /* addresses only, no names */
      if (buf.length < len) return;
      const host = atyp === 1 ? Array.from(buf.subarray(4, 8)).join(".") : v6(buf.subarray(4, 20));
      const port = buf.readUInt16BE(len - 2);
      const rest = buf.subarray(len);
      if ((!allowLocal && privateAddress(host)) || !port) return reply(2);   /* not allowed */
      step = 2;
      c.removeListener("data", onData);
      c.pause();
      up = net.connect({ host, port });
      up.setTimeout(10000, () => { up.destroy(); reply(4); });
      up.on("connect", () => {
        step = 4;
        up.setTimeout(0);
        c.setTimeout(0);
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) up.write(rest);
        c.pipe(up); up.pipe(c);
        c.resume();
      });
      up.on("error", (e) => { if (step === 2) { step = 3; reply(e.code === "ECONNREFUSED" ? 5 : 4); } else c.destroy(); });
      up.on("close", () => c.destroy());
    }
  };
  c.on("data", onData);
}); }

/* The tunnel's health: Cloudflare must say warp=on. */
let misses = 0;
async function check() {
  try {
    const r = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(10000) });
    const t = await r.text();
    if (!/warp=(on|plus)/.test(t)) throw new Error("not through WARP");
    if (misses) log("INFO", "tunnel back");
    misses = 0;
  } catch (e) {
    misses++;
    log("WARN", "tunnel check failed (" + e.message + "), " + misses + " of 3");
    if (misses >= 3) { log("ERROR", "tunnel down; restarting"); process.exit(1); }
  }
}
module.exports = { privateAddress, createServer };

if (require.main === module) {
  const server = createServer();
  server.on("error", (e) => { log("ERROR", e.message); process.exit(1); });
  server.listen(PORT, "0.0.0.0", () => log("INFO", "SOCKS5 on " + PORT));
  setTimeout(check, 5000);
  setInterval(check, CHECK_MS);
}
