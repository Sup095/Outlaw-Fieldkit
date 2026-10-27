/* ============================================================
   FieldKit fk-wake — wakes Bastion 2 for the relay (RUNNER_PLAN.md §24)

   The relay runs in a container whose broadcasts never reach the home
   network, and a sleeping machine only hears a Wake-on-LAN "magic
   packet" sent as a broadcast on its own network. This runs beside
   it on Bastion 1, on the host's network, and does one thing: holds
   a request open to the relay's /runner/wake/wait, and when the
   answer says wake, sends the packet for the address the relay gives.

   Nothing comes in: it only makes outgoing requests, so no port is
   opened and no firewall changes. Run as a container from the relay's
   own image (it is in there):

     docker run -d --name fk-wake --restart unless-stopped --network host \
       --user 999:981 -v <relay data>/runner/wake:/k:ro \
       -e FK_WAKE_URL=https://relay.example.com \
       --entrypoint node fieldkit-relay:1 /opt/fieldkit/relay/fk-wake.js

   FK_WAKE_URL   the relay's public address
   FK_WAKE_KEY   the key, or else it is read from FK_WAKE_KEYFILE
                 (default /k/key: the folder the relay keeps it in)
   FK_WAKE_TARGETS, FK_WAKE_PORT   where the packet goes, for tests
   ============================================================ */
"use strict";

const dgram = require("dgram");
const fs = require("fs");
const os = require("os");

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/* Six 0xFF, then the address sixteen times. */
function magic(mac) {
  if (!MAC_RE.test(String(mac).toLowerCase())) throw new Error("not a network card address: " + mac);
  const m = Buffer.from(mac.toLowerCase().split(":").map((h) => parseInt(h, 16)));
  const out = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) m.copy(out, 6 + i * 6);
  return out;
}

/* Every broadcast address this machine has an IPv4 network for, and
   the all-ones one: on most home networks either reaches it. */
function targets(ifs) {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(ifs || os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || !a.netmask) continue;
      const ip = a.address.split(".").map(Number), nm = a.netmask.split(".").map(Number);
      if (ip.length !== 4 || nm.length !== 4 || a.netmask === "255.255.255.255") continue;
      if (ip[0] === 172 && ip[1] >= 16 && ip[1] < 32) continue;   /* Docker's own bridges */
      out.add(ip.map((b, i) => (b | (~nm[i] & 255))).join("."));
    }
  }
  return Array.from(out);
}

function send(mac, opts) {
  opts = opts || {};
  const pkt = magic(mac);
  const to = opts.targets || targets();
  const port = opts.port || 9;
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.on("error", () => {});
    s.bind(() => {
      s.setBroadcast(true);
      let left = to.length * 3, sent = 0;
      /* Three times, a second apart: a packet is easily lost and costs nothing. */
      for (let round = 0; round < 3; round++) {
        setTimeout(() => {
          for (const addr of to) s.send(pkt, port, addr, (e) => { if (!e) sent++; if (--left === 0) { s.close(); resolve({ sent, to }); } });
        }, round * (opts.gapMs == null ? 1000 : opts.gapMs));
      }
    });
  });
}

function key() {
  if (process.env.FK_WAKE_KEY) return process.env.FK_WAKE_KEY.trim();
  try { return fs.readFileSync(process.env.FK_WAKE_KEYFILE || "/k/key", "utf8").trim(); } catch (e) { return ""; }
}

const say = (m) => console.log(new Date().toISOString() + " fk-wake: " + m);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  const base = String(process.env.FK_WAKE_URL || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) { say("set FK_WAKE_URL to the relay's address"); process.exit(2); }
  let failing = 0, said = "";
  const tell = (m) => { if (m !== said) { say(m); said = m; } };
  for (;;) {
    const k = key();
    if (!k) { tell("no key yet: the relay makes it on its first start with this version"); await pause(30000); continue; }
    try {
      const res = await fetch(base + "/runner/wake/wait", { headers: { "X-FK-Wake-Key": k }, signal: AbortSignal.timeout(70000) });
      if (res.status === 401) { tell("the relay refused the key (was it reinstalled?); retrying"); await pause(30000); continue; }
      if (!res.ok) throw new Error("the relay said " + res.status);
      const body = await res.json();
      failing = 0;
      tell("waiting at " + base);
      if (body && body.wake && body.mac) {
        const r = await send(body.mac, { targets: process.env.FK_WAKE_TARGETS ? process.env.FK_WAKE_TARGETS.split(",") : null,
          port: Number(process.env.FK_WAKE_PORT) || 9 });
        say("woke " + body.mac + ": " + r.sent + " packet(s) to " + r.to.join(", "));
        said = "";
      }
    } catch (e) {
      failing++;
      tell("cannot reach the relay (" + e.message + "); retrying");
      await pause(Math.min(60000, 2000 * failing));
    }
  }
}

if (require.main === module) loop();

module.exports = { magic, targets, send };
