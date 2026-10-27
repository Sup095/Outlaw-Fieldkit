/* ============================================================
   FieldKit runnerd :: egress — the one way out of a sandbox

   A member's job that is allowed online is put on a private network
   of its own (made per job by sandbox.js) whose only other member is
   this container. It has no route anywhere else. What it can reach
   is this proxy, and what this proxy will open is decided by the
   relay's guard.js — the same code that is the only way out of the
   streamed browser:

     every name is looked up through the DNS filter (CleanBrowsing,
     adult + malware by default; FK_DNS_FILTER changes it)
     every address it resolves to is checked, and private ones —
     this house, the tailnet, the other containers — are refused,
     which also covers a literal IP typed instead of a name
     only web ports: 80, 443, 8080, 8443

   And, for RUNNER only, a ceiling per sandbox: a few connections at
   once and a share of the house's upload and download, so one job
   pulling a large file cannot take the line from everyone else.

   Programs reach it because the job's environment says
   HTTP_PROXY / HTTPS_PROXY. Anything that ignores those simply has
   no internet, which is the safe way round.

   Zero dependencies; runs from the runnerd image, unprivileged.
   ============================================================ */
"use strict";

const { Guard, DNS_PRESETS } = require("../relay/guard");

const env = (k, d) => (process.env[k] == null || process.env[k] === "" ? d : process.env[k]);
const num = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) && v > 0 ? v : d; };

function settings() {
  const filter = env("FK_DNS_FILTER", "adult");
  return {
    dnsFilter: DNS_PRESETS[filter] ? filter : "adult",
    port: num("FK_EGRESS_PORT", 3128),
    perClient: {
      maxConns: num("FK_EGRESS_CONNS", 16),
      /* House line, measured: ~20 Mbit/s up. 1 Mbit/s up and 8 down per
         job leaves room for everything else that uses it. */
      upBps: num("FK_EGRESS_UP_KBPS", 128) * 1024,
      downBps: num("FK_EGRESS_DOWN_KBPS", 1024) * 1024
    }
  };
}

if (require.main === module) {
  const log = (lvl, msg) => console.log(new Date().toISOString() + " [" + lvl + "] " + msg);
  const s = settings();
  const g = new Guard({ log: log, dnsFilter: s.dnsFilter, host: "0.0.0.0", port: s.port, perClient: s.perClient,
    words: { place: "run server", who: "a RUNNER program" } });
  g.listen().then(() => {
    log("INFO", "egress: per sandbox " + s.perClient.maxConns + " connections, " +
      Math.round(s.perClient.upBps / 1024) + " KB/s up, " + Math.round(s.perClient.downBps / 1024) + " KB/s down");
  }).catch((e) => { log("ERROR", "egress: could not start — " + e.message); process.exit(1); });
  const bye = () => { g.close(); process.exit(0); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

module.exports = { settings };
