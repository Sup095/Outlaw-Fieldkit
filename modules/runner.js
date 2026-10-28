/* ============================================================
   FieldKit :: RUNNER
   Upload a file, run it on the run server, watch what it prints.
   The client half of RUNNER_PLAN.md. Runs in both builds.

   ---- WHO DOES WHAT -------------------------------------------

   The RELAY knows who you are. It is asked two things: is the run
   server up, and may I have a ticket. The ticket is a one-minute
   signed note saying which MESSAGES account this is and what tier.

   The RUN SERVER (Bastion 2) runs the file. This panel carries the
   ticket straight to it and opens ONE WebSocket. The upload, the
   commands, what you type and what the program prints all travel
   on that one connection. Nothing goes through the relay again.

   THIS PANEL does everything that does not need the server: it
   checks the file against your limits before sending a byte,
   hashes it, shows progress, and keeps the scrollback. The hash is
   computed a megabyte at a time, so a large file never has to fit
   in memory — this has to work on a 4 GB Chromebook.

   ---- WHAT IS NEVER HERE --------------------------------------

   No credential. The MESSAGES module does the ticket exchange and
   hands back only the ticket, the same way it does for BROWSER.
   Nothing is persisted: closing the panel closes the connection,
   and for a guest that deletes everything on the server too.

   ---- PROGRAMS WITH A WINDOW ----------------------------------

   RUN IN WINDOW starts the program on a virtual screen on the run
   server. Its picture comes back as H.264 video and its sound as
   Opus, in binary frames on the same connection, and the browser's
   own decoders (WebCodecs) turn them into pixels and samples, in
   hardware on a Chromebook. Mouse and keys go back batched, a few
   dozen times a second. Nothing is decoded in JavaScript.

   ---- WHEN THE SERVER IS OFF ----------------------------------

   The run server is a machine in a house. When it is unplugged the
   panel says so in a sentence and the drop area is disabled. It is
   checked when the panel opens and then only every 20 seconds
   while it is down — not at all while it is up, because the open
   connection already says so.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var alive = function () { return true; };   // replaced per mount

  var info = null;          // the relay's last /runner/status answer
  var conn = null;          // { sock, ready, tier, limits, files, usage, jobs }
  var phase = "checking";   // checking | off | offline | signin | connecting | ready | lost
  var problem = "";         // the sentence shown for off / offline / lost
  var busy = null;          // { name, done, total, what } while hashing or uploading
  var scroll = [];          // terminal scrollback, as { k, d } pieces
  var scrollChars = 0;
  var retry = null;
  var goodUrl = null;       // the run server address that last answered, tried first
  var renewTimer = null;
  var adminView = false;    // an admin looking at the ADMIN screen
  var adminUser = null;     // whose files that screen is showing
  var saveOpen = false;     // the saved-folder list is showing
  var saveList = null;      // and what it last said
  var players = {};         // job id -> the player for a job with a screen
  var zipPick = null;       // { id, list, screen, args } while asking which file in a zip to run
  var cardEdit = null;      // the library file whose card an admin is editing

  var SCROLL_MAX = 200000;  // characters kept on screen
  var CHUNK = 256 * 1024;   // one upload frame
  var HASH_SLICE = 1024 * 1024;
  var RETRY_MS = 20000;
  /* The run server closes a session whose ticket is not renewed
     within 20 minutes. That is how a ban made in MESSAGES reaches a
     session that is already open. */
  var RENEW_MS = 10 * 60 * 1000;

  function relayBase() {
    var u = String(ctx.settings.get("relayUrl") || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
    return (n / 1073741824).toFixed(1) + " GB";
  }

  function fmtTime(sec) {
    if (sec < 90) return sec + " seconds";
    if (sec < 5400) return Math.round(sec / 60) + " minutes";
    return (sec / 3600).toFixed(1).replace(/\.0$/, "") + " hours";
  }

  /* What RUNNER can run, decided the same way the server decides it,
     so a file it would refuse is refused here before it is uploaded. */
  function kindOf(name, firstBytes) {
    var b = firstBytes || [];
    var ext = (/\.([A-Za-z0-9]+)$/.exec(String(name)) || ["", ""])[1].toLowerCase();
    if ((b[0] === 0x4d && b[1] === 0x5a) || ext === "exe") return "windows";
    /* A folder of files, zipped: unpacked in the sandbox at each run. */
    if ((b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) || ext === "zip") return "zip";
    if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return "linux";
    if (ext === "py") return "python";
    if (ext === "js" || ext === "mjs" || ext === "cjs") return "javascript";
    if (ext === "sh" || ext === "bash") return "shell";
    if (b[0] === 0x23 && b[1] === 0x21) return "script";
    return null;
  }

  /* Returns a sentence if this file must not be uploaded, or "". */
  function whyNot(file, kind, state) {
    if (!state || !state.limits) return "not connected to the run server";
    var L = state.limits, use = state.usage || { files: 0, bytes: 0 };
    if (!file.size) return "that file is empty";
    if (!kind) {
      return "RUNNER cannot run that kind of file. It runs Python (.py), JavaScript (.js), " +
        "shell scripts (.sh), Linux programs, Windows programs (.exe), and any of those in a .zip.";
    }
    if (kind === "windows" && !state.windows) {
      return "Windows programs are not switched on for this server yet.";
    }
    if (file.size > L.maxFileBytes) {
      return "that file is " + fmtBytes(file.size) + ", and your account can upload " +
        fmtBytes(L.maxFileBytes) + " at most.";
    }
    if (use.files >= L.maxFiles) return "you have too many files here. Delete some first.";
    if (use.bytes + file.size > L.quotaBytes) {
      return "that would go over your storage limit of " + fmtBytes(L.quotaBytes) + ".";
    }
    return "";
  }

  /* ---- SHA-256, a piece at a time --------------------------------
     crypto.subtle.digest wants the whole file in one buffer, which
     for a 1 GB upload means 1 GB of memory on a machine that has
     four. This takes it in slices and holds 64 bytes between them.

     The constants are derived rather than typed: the first 32 bits
     of the fractional parts of the square and cube roots of the
     first primes, which is how the standard defines them. A typo in
     a table of 64 hex numbers is invisible; a wrong derivation fails
     the selfcheck's known answer immediately. */
  var SHA_K = null, SHA_H0 = null;
  function shaTables() {
    if (SHA_K) return;
    var primes = [], n = 2;
    while (primes.length < 64) {
      var isPrime = true;
      for (var i = 0; i < primes.length && primes[i] * primes[i] <= n; i++) {
        if (n % primes[i] === 0) { isPrime = false; break; }
      }
      if (isPrime) primes.push(n);
      n++;
    }
    var frac = function (x) { return Math.floor((x - Math.floor(x)) * 4294967296) >>> 0; };
    SHA_K = new Uint32Array(64);
    SHA_H0 = new Uint32Array(8);
    for (var k = 0; k < 64; k++) SHA_K[k] = frac(Math.cbrt(primes[k]));
    for (var h = 0; h < 8; h++) SHA_H0[h] = frac(Math.sqrt(primes[h]));
  }

  function Sha256() {
    shaTables();
    this.h = new Uint32Array(SHA_H0);
    this.block = new Uint8Array(64);
    this.fill = 0;
    this.bytes = 0;
    this.w = new Uint32Array(64);
  }

  Sha256.prototype._round = function () {
    var w = this.w, b = this.block, h = this.h, i, s0, s1;
    for (i = 0; i < 16; i++) {
      w[i] = ((b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3]) >>> 0;
    }
    for (i = 16; i < 64; i++) {
      s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7], t1, t2;
    for (i = 0; i < 64; i++) {
      s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      t1 = (hh + s1 + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      t2 = (s0 + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  };

  Sha256.prototype.update = function (bytes) {
    var i = 0, n = bytes.length, take;
    this.bytes += n;
    while (i < n) {
      take = Math.min(64 - this.fill, n - i);
      this.block.set(bytes.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === 64) { this._round(); this.fill = 0; }
    }
    return this;
  };

  Sha256.prototype.hex = function () {
    var bits = this.bytes * 8, b = this.block;
    b[this.fill++] = 0x80;
    if (this.fill > 56) { while (this.fill < 64) b[this.fill++] = 0; this._round(); this.fill = 0; }
    while (this.fill < 56) b[this.fill++] = 0;
    /* The length is 64 bits. The high half is computed by division
       because << on a number above 2^32 quietly wraps. */
    var hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
    b[56] = hi >>> 24; b[57] = (hi >>> 16) & 255; b[58] = (hi >>> 8) & 255; b[59] = hi & 255;
    b[60] = lo >>> 24; b[61] = (lo >>> 16) & 255; b[62] = (lo >>> 8) & 255; b[63] = lo & 255;
    this._round();
    var out = "";
    for (var i = 0; i < 8; i++) out += ("00000000" + this.h[i].toString(16)).slice(-8);
    return out;
  };

  /* ---- the relay: status, and a ticket --------------------------- */
  async function checkStatus() {
    var base = relayBase();
    if (!base) return { enabled: false, online: false, why: "no relay is configured. Set one in SETTINGS first." };
    try {
      var ac = new AbortController();
      var timer = setTimeout(function () { ac.abort(); }, 9000);
      var res = await window.fetch(base + "/runner/status", { signal: ac.signal, cache: "no-store" });
      clearTimeout(timer);
      if (res.status === 404) return { enabled: false, online: false, why: "this relay is too old to have RUNNER." };
      var body = JSON.parse(await res.text());
      return body && typeof body === "object" ? body : { online: false, why: "the relay sent something unreadable." };
    } catch (e) {
      return { enabled: true, online: false, why: "the relay is not answering." };
    }
  }

  function account() {
    var msg = FieldKit.service("messages");
    return msg && msg.signedIn && msg.signedIn() && typeof msg.runnerTicket === "function" ? msg : null;
  }

  function stopRetry() { if (retry) { clearTimeout(retry); retry = null; } }

  /* Decides which screen to show. Called on mount, on RETRY, and by
     the slow timer while the server is down. */
  async function refresh(guard) {
    stopRetry();
    info = await checkStatus();
    if (!guard()) return;

    if (!info.enabled) { phase = "off"; problem = info.why || "RUNNER is switched off on this relay."; }
    else if (!info.online || info.ready === false) {
      phase = "offline";
      problem = info.why || "the run server is offline";
      /* Only while it is down. Once connected, the socket itself is
         the signal and nothing polls. */
      retry = setTimeout(function () { if (guard()) refresh(guard); }, RETRY_MS);
    }
    else if (!account()) { phase = "signin"; problem = ""; }
    else { phase = "connecting"; problem = ""; render(); return open(guard); }
    render();
  }

  function closeConn() {
    if (!conn) return;
    try { conn.sock.onclose = null; conn.sock.onmessage = null; conn.sock.close(); } catch (e) {}
    dropPlayers();
    if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    conn = null;
    busy = null;
  }

  async function open(guard) {
    closeConn();
    var t;
    try { t = await account().runnerTicket(); }
    catch (e) {
      if (!guard()) return;
      phase = e && e.status === 503 ? "offline" : "lost";
      problem = (e && e.message) || "the relay would not issue a ticket";
      return render();
    }
    if (!guard()) return;

    /* The run server may answer on more than one address (the relay's
       runner.alsoUrls), in case one is blocked where this panel is. Each
       is tried in turn until one opens, the last one that did first. The
       ticket is only spent by a run server that was reached. */
    var urls = (Array.isArray(t.urls) && t.urls.length ? t.urls : [t.url]).map(String).filter(Boolean);
    /* The relay passes RUNNER through to Bastion 2 (runner.innerUrl), so
       the address this panel reached the relay by comes first. */
    if (t.viaRelay && relayBase()) urls = [relayBase() + "/runner"].concat(urls.filter(function (u) { return u !== relayBase() + "/runner"; }));
    if (!urls.length) { conn = null; phase = "offline"; problem = "the run server has no address"; return render(); }
    if (goodUrl && urls.indexOf(goodUrl) > 0) urls = [goodUrl].concat(urls.filter(function (u) { return u !== goodUrl; }));
    var mine = { sock: null, ready: false, opened: false, tier: t.tier, limits: null, files: [], usage: null,
      jobs: {}, waiting: {}, windows: false };
    conn = mine;
    dial(0);
    function dial(i) {
      var url = urls[i].replace(/^http:/i, "ws:").replace(/^https:/i, "wss:") + "/attach?t=" + encodeURIComponent(t.ticket);
      var sock;
      try { sock = new window.WebSocket(url); }
      catch (e) {
        if (i + 1 < urls.length) return dial(i + 1);
        conn = null; phase = "lost"; problem = "could not reach the run server"; return render();
      }
      sock.binaryType = "arraybuffer";
      mine.sock = sock;
      sock.onopen = function () { mine.opened = true; goodUrl = urls[i]; sock.send(JSON.stringify({ t: "hello" })); };
      sock.onmessage = function (e) {
        if (conn !== mine) return;
        if (typeof e.data !== "string") return onFrame(e.data);
        var m;
        try { m = JSON.parse(e.data); } catch (x) { return; }
        onMessage(mine, m);
      };
      sock.onclose = function () {
        if (conn !== mine) return;
        if (!mine.opened && i + 1 < urls.length) return dial(i + 1);
        closed();
      };
    }
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = setInterval(function () {
      var a = account();
      if (conn !== mine || !a) return;
      /* A refusal here is not handled: if the relay will not renew,
         the run server ends the session and says why. */
      a.runnerTicket().then(function (t) { if (conn === mine) say({ t: "renew", ticket: t.ticket }); },
        function () {});
    }, RENEW_MS);

    function closed() {
      conn = null; busy = null;
      if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
      if (!guard()) return;
      if (mine.reconnect) {
        /* Approved (or the reverse) while connected. Starting over is
           the whole fix, so it happens without a button. */
        ui.toast(String(mine.reconnect).toUpperCase(), "ok");
        phase = "checking"; render();
        return refresh(guard);
      }
      phase = "lost";
      problem = mine.denied ? mine.denied : mine.ready
        ? (mine.tier === "guest"
          ? "the connection closed. Guest files are deleted when that happens."
          : "the connection closed. Your files are still on the server.")
        : "could not connect to the run server";
      render();
    }
  }

  /* ---- what the run server says ---------------------------------- */
  function say(o) {
    if (conn && conn.sock.readyState === 1) conn.sock.send(JSON.stringify(o));
  }

  function print(kind, text) {
    scroll.push({ k: kind, d: text });
    scrollChars += text.length;
    while (scrollChars > SCROLL_MAX && scroll.length > 1) scrollChars -= scroll.shift().d.length;
    drawScroll(kind, text);
  }

  function onMessage(c, m) {
    switch (m.t) {
      case "ready":
      case "files":
        c.ready = true;
        c.tier = m.tier; c.limits = m.limits; c.files = m.files || []; c.usage = m.usage;
        c.windows = !!m.windows;
        c.library = m.library || []; c.notices = m.notices || c.notices || [];
        c.pressure = m.pressure || "ok"; c.ttlDays = m.ttlDays || 30;
        c.save = m.save || null;
        c.screens = !!m.screens;
        c.internet = !!m.internet;
        if (m.line) setLine(c, m.line);
        attachJobs(c, m);
        phase = "ready";
        return render();

      case "renewed":
        if (m.tier !== c.tier) { c.tier = m.tier; render(); }
        return;
      case "reconnect": c.reconnect = m.why; return;
      case "denied": c.denied = m.why; return;

      case "put-ok": case "put-ack": case "put-done": case "put-cancelled": case "job":
      case "adm": case "adm-done": case "save": case "zip":
        return settle(c, m.ref, m);

      /* A download from the saved folder: a header, then pieces. */
      case "save-file":
        c.dl = c.dl || {};
        c.dl[m.ref] = { path: String(m.path), parts: [] };
        return;
      case "save-chunk": {
        var dl = c.dl && c.dl[m.ref];
        if (!dl) return;
        dl.parts.push(fromB64(m.d));
        if (!m.end) return;
        delete c.dl[m.ref];
        saveBlob(dl.path.split("/").pop(), dl.parts);
        return settle(c, m.ref, { t: "save-done" });
      }

      case "error":
        if (m.ref && c.waiting[m.ref]) return settle(c, m.ref, m);
        return ui.toast(String(m.why || "the run server refused that").toUpperCase(), "fail");

      /* The line (RUNNER_PLAN.md §22). */
      case "line":
        /* Sent every 2 s while you wait: redrawn only when it changed. */
        return setLine(c, m.entries || []) ? drawLine() : lineTick();
      case "turn":
        setLine(c, (c.line || []).map(function (e) {
          return e.id === m.id ? Object.assign({}, e, { turnLeft: m.seconds }) : e;
        }));
        chime();
        ui.toast("YOUR TURN: PRESS START WITHIN " + m.seconds + " SECONDS", "ok");
        return drawLine();
      case "line-gone":
        setLine(c, (c.line || []).filter(function (e) { return e.id !== m.id; }));
        ui.toast(String(m.why || "you left the line").toUpperCase(), "warn");
        return drawLine();

      case "removed":
        c.usage = m.usage || c.usage;
        c.files = c.files.filter(function (f) { return f.id !== m.file; });
        return render();

      case "out":
        return print(m.s === "stderr" ? "err" : "out", String(m.d));

      /* What a program of yours is using, every 10 s. Written into its
         row in place: a whole render would cost the terminal its
         scroll position. */
      case "use":
        if (!c.jobs[m.job]) return;
        c.jobs[m.job].use = { cpu: m.cpu, memMb: m.memMb, memLimitMb: m.memLimitMb };
        if (nodes.use && nodes.use[m.job]) nodes.use[m.job].textContent = useText(c.jobs[m.job].use);
        return;

      case "screen":
        if (c.jobs[m.job]) c.jobs[m.job].screen = m.screen;
        if (players[m.job]) players[m.job].resize(m.screen);
        return;

      case "exit": {
        var j = c.jobs[m.job];
        delete c.jobs[m.job];
        if (players[m.job]) { players[m.job].end(); delete players[m.job]; }
        print("note", "\n[" + (j ? j.name : "job") + " " +
          (m.why ? "stopped: " + m.why : "finished with code " + m.code) +
          ", after " + (m.ms / 1000).toFixed(1) + " s]\n");
        return render();
      }
      default: return;
    }
  }

  /* What "hello" brings back: the jobs still running under this
     account (attached now, with their recent output) and the results
     of any that ended while nobody was watching. */
  function attachJobs(c, m) {
    var had = c.jobs;
    c.jobs = {};
    (m.jobs || []).forEach(function (j) {
      c.jobs[j.id] = j;
      if (had[j.id] || !j.tail) return;
      print("note", "\n[" + j.name + " is still running; re-attached. Its recent output:]\n");
      j.tail.forEach(function (p) { print(p.s === "stderr" ? "err" : "out", String(p.d)); });
    });
    Object.keys(players).forEach(function (id) { if (!c.jobs[id]) { players[id].end(); delete players[id]; } });
    (m.finished || []).forEach(function (r) {
      var when = ago(r.endedAt);
      print("note", "\n[" + r.name + " ended while RUNNER was closed, " + (when === "just now" ? when : when + " ago") + ". Its last output:]\n");
      (r.tail || []).forEach(function (p) { print(p.s === "stderr" ? "err" : "out", String(p.d)); });
      print("note", "\n[" + r.name + " " + (r.why ? "stopped: " + r.why : "finished with code " + r.code) +
        ", after " + (r.ms / 1000).toFixed(1) + " s]\n");
    });
  }

  function fromB64(d) {
    var bin = window.atob(String(d || "")), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function saveBlob(name, parts) {
    var url = window.URL.createObjectURL(new window.Blob(parts, { type: "application/octet-stream" }));
    var a = el("a", { href: url, download: name || "download" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { window.URL.revokeObjectURL(url); }, 30000);
  }

  /* One reply per request, matched by a ref this side chose. */
  function ask(c, ref, message) {
    return new Promise(function (resolve) {
      c.waiting[ref] = resolve;
      if (message) say(message);
    });
  }
  function settle(c, ref, m) {
    var w = c.waiting[ref];
    if (m.t === "put-ack") { if (busy) { busy.done = m.got; drawBusy(); } return; }
    if (!w) return;
    delete c.waiting[ref];
    w(m);
  }

  /* ---- uploading -------------------------------------------------- */
  function readSlice(file, from, to) {
    return new Promise(function (resolve, reject) {
      var fr = new window.FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(new Error("could not read that file")); };
      fr.readAsArrayBuffer(file.slice(from, to));
    });
  }

  async function upload(file, guard) {
    var c = conn;
    if (!c || !c.ready) return ui.toast("NOT CONNECTED TO THE RUN SERVER", "fail");
    if (busy) return ui.toast("ONE UPLOAD AT A TIME", "warn");

    var head = file.size ? await readSlice(file, 0, Math.min(4, file.size)) : [];
    var no = whyNot(file, kindOf(file.name, head), c);
    if (no) return ui.toast(no.toUpperCase(), "fail");

    try {
      busy = { name: file.name, done: 0, total: file.size, what: "CHECKING" };
      drawBusy();
      var sha = new Sha256();
      for (var at = 0; at < file.size; at += HASH_SLICE) {
        sha.update(await readSlice(file, at, Math.min(file.size, at + HASH_SLICE)));
        if (conn !== c || !guard()) return;
        busy.done = Math.min(file.size, at + HASH_SLICE);
        drawBusy();
      }

      var ref = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var first = await ask(c, ref, { t: "put", ref: ref, name: file.name, size: file.size, sha256: sha.hex() });
      if (first.t === "error") throw new Error(first.why);
      if (first.t === "put-done") {
        /* The server already had these exact bytes on your list. */
        ui.toast("ALREADY UPLOADED AS " + String(first.file.name).toUpperCase(), "ok");
        return;
      }

      busy.what = "UPLOADING"; busy.done = 0;
      drawBusy();
      var done = ask(c, ref, null);
      for (var p = 0; p < file.size; p += CHUNK) {
        if (conn !== c) return;
        c.sock.send(await readSlice(file, p, Math.min(file.size, p + CHUNK)));
        /* Wait for the socket to drain rather than queueing the whole
           file in memory behind a slow link. */
        while (conn === c && c.sock.bufferedAmount > 4 * CHUNK) {
          await new Promise(function (r) { setTimeout(r, 30); });
        }
      }
      var last = await done;
      if (last.t === "error") throw new Error(last.why);
      c.files.unshift(last.file);
      c.usage = last.usage || c.usage;
      ui.toast("UPLOADED " + file.name.toUpperCase(), "ok");
    } catch (e) {
      ui.toast("NOT UPLOADED: " + String(e.message || e).toUpperCase(), "fail");
    } finally {
      if (conn === c) { busy = null; if (guard()) render(); }
    }
  }

  /* An admin's form for a library title's card (runnerd/admin.js,
     adm-lib-set). Empty fields clear the card. */
  function cardForm(f, go) {
    var card = f.card || {};
    var field = function (ph, v, max) { return el("input", { class: "rn-args rn-card-in", type: "text", placeholder: ph, value: v || "", maxlength: String(max) }); };
    var title = field("title, as members see it", card.title, 60);
    var about = field("one line about it", card.about, 200);
    var args = field("arguments PLAY uses (optional)", card.args, 200);
    var entry = field(/\.zip$/i.test(f.name) ? "the file inside the zip PLAY starts, e.g. Game/game.exe" : "(only for a .zip)", card.entry, 240);
    if (!/\.zip$/i.test(f.name)) entry.disabled = true;
    var win = el("input", { type: "checkbox" });
    win.checked = !!card.window;
    return el("div", { class: "rn-cardform" }, [
      title, about, args, entry,
      el("label", { class: "rn-dim" }, [win, el("span", { text: " opens a window (PLAY uses RUN IN WINDOW)" })]),
      el("div", { class: "rn-zip-list" }, [
        ui.button("SAVE CARD", function () {
          cardEdit = null;
          go({ t: "adm-lib-set", file: f.id, title: title.value, about: about.value, args: args.value,
            entry: entry.disabled ? "" : entry.value, window: win.checked })();
        }, { primary: true }),
        ui.button("CLEAR", function () { cardEdit = null; go({ t: "adm-lib-set", file: f.id })(); })
      ])
    ]);
  }

  /* "1.0 core · 97 MB of 2048 MB", or nothing before the first sample. */
  function useText(u) {
    if (!u || u.cpu == null) return "";
    return (u.cpu >= 0.995 || u.cpu === 0 ? u.cpu.toFixed(1) : u.cpu.toFixed(2)) + " core · " + u.memMb + " MB" +
      (u.memLimitMb ? " of " + u.memLimitMb + " MB" : "");
  }

  /* The file inside a zip that was run last, per zip, on this computer. */
  function zipLast(id, entry) {
    var k = "fieldkit.runner.zipEntry." + id;
    try { if (entry) localStorage.setItem(k, entry); return localStorage.getItem(k) || ""; } catch (e) { return ""; }
  }

  async function run(f, argText, screen, entry) {
    var c = conn;
    if (!c || !c.ready) return;
    if (screen && !canScreen()) {
      return ui.toast("THIS BROWSER CANNOT SHOW PROGRAM WINDOWS (IT NEEDS WEBCODECS: CHROME 94 OR NEWER)", "fail");
    }
    var args = String(argText || "").trim() ? String(argText).trim().split(/\s+/) : [];
    var ref = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (/\.zip$/i.test(f.name) && !entry) {
      /* Which file inside? Asked of the server, which reads only the zip's index. */
      var ls = await ask(c, ref, { t: "zip-ls", ref: ref, file: f.id });
      if (ls.t === "error") return ui.toast(String(ls.why).toUpperCase(), "fail");
      if (!ls.runnable.length) return ui.toast("NOTHING IN " + f.name.toUpperCase() + " THAT RUNNER CAN START (.EXE, .PY, .JS OR .SH)", "fail");
      if (ls.total > ls.room) {
        return ui.toast(f.name.toUpperCase() + " UNPACKS TO " + fmtBytes(ls.total) + ", MORE THAN THE " + fmtBytes(ls.room) +
          " YOUR SANDBOX HAS ROOM FOR", "fail");
      }
      if (ls.runnable.length === 1) return run(f, argText, screen, ls.runnable[0]);
      var last = zipLast(f.id);
      zipPick = { id: f.id, screen: !!screen, args: argText,
        list: ls.runnable.slice().sort(function (a, b) { return (b === last) - (a === last); }) };
      return render();
    }
    zipPick = null;
    if (entry) zipLast(f.id, entry);
    var out = await ask(c, ref, { t: "run", ref: ref, file: f.id, args: args, screen: !!screen, entry: entry || undefined });
    if (out.t === "error") return ui.toast(String(out.why).toUpperCase(), "fail");
    if (out.queued) {
      /* Not refused: a place in line (RUNNER_PLAN.md §22). */
      setLine(c, (c.line || []).filter(function (e) { return e.id !== out.queued.id; }).concat([out.queued]));
      print("note", "\n[" + f.name + " is waiting in line: " + out.why + ". You are " + ordinal(out.queued.place) +
        ". It starts when you press START, which appears when it is your turn.]\n");
      return drawLine();
    }
    started(c, out.job, args);
  }

  function started(c, job, args) {
    c.jobs[job.id] = job;
    print("note", "\n[running " + job.name + (args && args.length ? " " + args.join(" ") : "") +
      (job.screen ? " in a window (click the picture to use it)" : "") +
      ", time limit " + fmtTime(job.timeoutSec) +
      (job.keepRunning ? "; it keeps running if you close RUNNER" : "") + "]\n");
    render();
  }

  /* ---- the line ----
     Your places, each with a turn countdown when it is your turn. Only
     the countdown's text changes each second: rebuilding the box would
     replace START under the pointer and lose a click in progress. */
  var lineTimer = null;
  function setLine(c, entries) {
    var sig = function (l) {
      return (l || []).map(function (e) { return [e.id, e.place, e.ahead, Math.round((e.etaSec || 0) / 60), e.turnLeft != null || !!e.until].join(":"); }).join("|");
    };
    var before = sig(c.line);
    c.line = (entries || []).map(function (e) {
      var old = (c.line || []).filter(function (o) { return o.id === e.id; })[0];
      var until = e.turnLeft != null ? Date.now() + e.turnLeft * 1000 : null;
      /* Keep the countdown already running rather than restart it. */
      if (until && old && old.until && old.until < until) until = old.until;
      return Object.assign({}, e, { until: until });
    });
    var counting = c.line.some(function (e) { return !!e.until; });
    if (counting && !lineTimer) lineTimer = setInterval(lineTick, 1000);
    if (!counting && lineTimer) { clearInterval(lineTimer); lineTimer = null; }
    return sig(c.line) !== before;
  }

  function ordinal(n) {
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  var lineText = {};
  function turnText(e) {
    var what = e.kind === "screen" ? "a window" : "a program";
    return "YOUR TURN for " + what + (e.name ? " (" + e.name + ")" : "") + ": press START within " +
      Math.max(0, Math.round((e.until - Date.now()) / 1000)) + " s";
  }
  function lineTick() {
    var c = conn;
    (c && c.line || []).forEach(function (e) {
      if (e.until && lineText[e.id]) lineText[e.id].textContent = turnText(e);
    });
  }

  function drawLine() {
    var c = conn;
    if (!nodes.line || !c) return;
    ui.clear(nodes.line);
    lineText = {};
    (c.line || []).forEach(function (e) {
      var what = e.kind === "screen" ? "a window" : "a program";
      var leave = ui.button("LEAVE THE LINE", function () { say({ t: "leave", id: e.id }); });
      if (e.until) {
        lineText[e.id] = el("span", { class: "rn-line-t", text: turnText(e) });
        nodes.line.appendChild(el("div", { class: "rn-line turn" }, [
          lineText[e.id],
          ui.button("START", function () { take(c, e); }, { primary: true }), leave
        ]));
        return;
      }
      var mins = Math.max(1, Math.round((e.etaSec || 0) / 60));
      nodes.line.appendChild(el("div", { class: "rn-line" }, [
        el("span", { class: "rn-line-t", text: "WAITING IN LINE for " + what + (e.name ? " (" + e.name + ")" : "") + ": " +
          ordinal(e.place) + (e.ahead ? ", " + e.ahead + " ahead of you" : ", you are next") +
          ", about " + mins + " min. Members go ahead of guests; admins never wait." }),
        leave
      ]));
    });
  }

  async function take(c, e) {
    var ref = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var out = await ask(c, ref, { t: "take", ref: ref, id: e.id });
    if (out.t === "error") return ui.toast(String(out.why).toUpperCase(), "fail");
    setLine(c, (c.line || []).filter(function (x) { return x.id !== e.id; }));
    started(c, out.job, (e.args || []));
  }

  /* Two short notes, for "it's your turn" while looking elsewhere. A
     browser may keep sound off until the page has been clicked; then
     the toast and the box are the signal. */
  function chime() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var a = chime.ctx || (chime.ctx = new AC());
      if (a.resume) a.resume();
      [0, 0.18].forEach(function (at, i) {
        var o = a.createOscillator(), g = a.createGain();
        o.frequency.value = i ? 1318.5 : 987.8;
        g.gain.setValueAtTime(0.0001, a.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.2, a.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + 0.16);
        o.connect(g); g.connect(a.destination);
        o.start(a.currentTime + at); o.stop(a.currentTime + at + 0.18);
      });
    } catch (err) { /* silent is fine */ }
  }

  /* ---- drawing ---------------------------------------------------- */
  function drawScroll(kind, text) {
    if (!nodes.term) return;
    nodes.term.appendChild(el("span", { class: "rn-" + kind, text: text }));
    while (nodes.term.childNodes && nodes.term.childNodes.length > scroll.length) {
      nodes.term.removeChild(nodes.term.firstChild);
    }
    nodes.term.scrollTop = nodes.term.scrollHeight;
  }

  function drawBusy() {
    if (!nodes.busy) return;
    nodes.busy.textContent = busy
      ? busy.what + " " + busy.name + "  " + fmtBytes(busy.done) + " / " + fmtBytes(busy.total) +
        "  (" + Math.floor(100 * busy.done / Math.max(1, busy.total)) + "%)"
      : "";
  }

  function daysUntil(iso) {
    var d = Math.ceil((Date.parse(iso) - Date.now()) / 86400000);
    return d <= 1 ? "under a day" : d + " days";
  }

  function notice(title, sentence, buttons) {
    return el("div", { class: "rn-notice" }, [
      el("div", { class: "rn-notice-h", text: title }),
      sentence ? el("div", { class: "rn-notice-p", text: sentence }) : null,
      el("div", { class: "rn-actions" }, buttons || [])
    ]);
  }

  function tierLine(c) {
    var L = c.limits;
    if (c.tier === "guest") {
      return "GUEST SANDBOX. Your files and anything running are deleted when you close this " +
        "panel, sign out or lose connection. Up to " + fmtBytes(L.maxFileBytes) + " per file, " +
        fmtTime(L.timeoutSec) + " per run, no GPU. An admin can approve your account to lift this.";
    }
    return c.tier.toUpperCase() + ". Your files are kept. Using " + fmtBytes(c.usage ? c.usage.bytes : 0) +
      " of " + fmtBytes(L.quotaBytes) + ". Up to " + fmtBytes(L.maxFileBytes) + " per file, " +
      fmtTime(L.timeoutSec) + " per run. " + (L.keepRunning
        ? "Programs keep running if you close this panel, and reconnect when you open it again" +
          (L.internet && c.internet ? "; they can reach the web through the content filter" : "") +
          (L.saveBytes ? ", and keep files in /save" : "") + "."
        : "Programs stop when you close this panel.");
  }

  function render() {
    if (!nodes.root) return;
    var guard = alive;
    ui.clear(nodes.root);
    nodes.term = nodes.busy = nodes.line = null;
    var again = ui.button("CHECK AGAIN", function () { phase = "checking"; render(); refresh(guard); });

    if (phase === "checking") return void nodes.root.appendChild(notice("CHECKING THE RUN SERVER...", ""));
    if (phase === "connecting") return void nodes.root.appendChild(notice("CONNECTING...", ""));
    if (phase === "off") return void nodes.root.appendChild(notice("RUNNER IS NOT AVAILABLE", problem, [again]));
    if (phase === "offline") {
      return void nodes.root.appendChild(notice("THE RUN SERVER IS OFFLINE",
        "Nothing can be uploaded or run until it is back (" + problem + "). " +
        "This checks again by itself every " + (RETRY_MS / 1000) + " seconds.", [again]));
    }
    if (phase === "signin") {
      return void nodes.root.appendChild(notice("SIGN IN TO USE RUNNER",
        "RUNNER needs a MESSAGES account, because limits and saved files are per person. " +
        "Open MESSAGES, sign in or create an account, then come back.", [
          ui.button("OPEN MESSAGES", function () {
            var shell = FieldKit.service("shell");
            if (shell && shell.open) shell.open("messages");
          }, { primary: true }),
          ui.button("I HAVE SIGNED IN", function () { phase = "checking"; render(); refresh(guard); })
        ]));
    }
    if (phase === "lost" || !conn) {
      return void nodes.root.appendChild(notice("DISCONNECTED", problem,
        [ui.button("RECONNECT", function () { phase = "checking"; render(); refresh(guard); }, { primary: true })]));
    }
    if (adminView && conn.tier === "admin") return renderAdmin(guard);
    adminView = false;
    renderReady(guard);
  }

  function renderReady(guard) {
    var c = conn;
    var picker = el("input", { type: "file", class: "rn-picker" });
    picker.addEventListener("change", function () {
      if (picker.files && picker.files[0]) upload(picker.files[0], guard);
      picker.value = "";
    });

    var drop = el("div", { class: "rn-drop", tabindex: "0",
      text: "DROP A FILE HERE, OR CLICK TO CHOOSE ONE" });
    drop.addEventListener("click", function () { picker.click(); });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.className = "rn-drop over"; });
    drop.addEventListener("dragleave", function () { drop.className = "rn-drop"; });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.className = "rn-drop";
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) upload(f, guard);
    });

    nodes.busy = el("div", { class: "rn-busy" });

    function pickRow(f) {
      if (!zipPick || zipPick.id !== f.id) return null;
      var p = zipPick;
      return el("div", { class: "rn-zip" }, [
        el("div", { class: "rn-zip-q", text: "Which file inside " + f.name + " should " + (p.screen ? "open in a window" : "run") + "?" }),
        el("div", { class: "rn-zip-list" }, p.list.slice(0, 24).map(function (name) {
          return ui.button(name, function () { run(f, p.args, p.screen, name); });
        }).concat(p.list.length > 24 ? [el("span", { class: "rn-dim", text: "and " + (p.list.length - 24) + " more" })] : [])),
        ui.button("CANCEL", function () { zipPick = null; render(); })
      ]);
    }

    var files = el("div", { class: "rn-files" });
    if (!c.files.length) files.appendChild(el("div", { class: "rn-none", text: "NO FILES YET" }));
    c.files.forEach(function (f) {
      var args = el("input", { class: "rn-args", type: "text", placeholder: "arguments (optional)" });
      args.addEventListener("keydown", function (e) { if (e.key === "Enter") run(f, args.value); });
      files.appendChild(el("div", { class: "rn-file" }, [
        el("span", { class: "rn-name", text: f.name, title: f.name }),
        el("span", { class: "rn-size", text: fmtBytes(f.size) }),
        f.expiringSoon ? el("span", { class: "rn-exp", title: "files nobody runs for " + (c.ttlDays || 30) +
          " days are deleted; running it resets the clock",
          text: "deleted in " + daysUntil(f.expiresAt) + " unless run" }) : null,
        args,
        ui.button("RUN", function () { run(f, args.value); }, { primary: true }),
        c.screens ? ui.button("RUN IN WINDOW", function () { run(f, args.value, true); }) : null,
        ui.button("DELETE", function () {
          if (window.confirm("Delete " + f.name + " from the run server?")) say({ t: "rm", file: f.id });
        }, { danger: true })
      ]));
      var q = pickRow(f);
      if (q) files.appendChild(q);
    });

    /* Files an admin made permanent. Anyone can run them; nobody but
       an admin can remove them, so there is no DELETE here. */
    var lib = null;
    if ((c.library || []).length) {
      lib = el("div", { class: "rn-files rn-lib" }, [el("div", { class: "rn-lib-h", text: "SHARED LIBRARY" })]);
      c.library.forEach(function (f) {
        /* An admin's card says what it is and how PLAY starts it. */
        var card = f.card || null;
        var a2 = el("input", { class: "rn-args", type: "text", placeholder: "arguments (optional)" });
        a2.addEventListener("keydown", function (e) { if (e.key === "Enter") run(f, a2.value); });
        var canPlay = card && (!card.window || c.screens);
        lib.appendChild(el("div", { class: "rn-file" + (card ? " rn-card" : "") }, [
          el("span", { class: "rn-name", text: (card && card.title) || f.name, title: f.name }),
          f.playing ? el("span", { class: "rn-playing", text: f.playing + " PLAYING" }) : null,
          el("span", { class: "rn-size", text: fmtBytes(f.size) }),
          canPlay ? ui.button(card.window ? "PLAY" : "START", function () {
            run(f, card.args || "", !!card.window, card.entry || undefined);
          }, { primary: true }) : null,
          card && card.window && !c.screens ? el("span", { class: "rn-dim", text: "opens a window: members only" }) : null,
          a2, ui.button("RUN", function () { run(f, a2.value); }, { primary: !canPlay }),
          c.screens ? ui.button("RUN IN WINDOW", function () { run(f, a2.value, true); }) : null
        ]));
        if (card && card.about) lib.appendChild(el("div", { class: "rn-about", text: card.about }));
        var q = pickRow(f);
        if (q) lib.appendChild(q);
      });
    }

    var notes = (c.notices || []).map(function (n) {
      return el("div", { class: "rn-notice-bar", text: n.kind === "warning"
        ? "AN ADMIN WARNED YOU: " + n.reason
        : "YOU CANNOT START PROGRAMS UNTIL " + new Date(n.until).toLocaleString() + ": " + n.reason });
    });
    if (c.pressure === "full" && c.tier !== "admin") {
      notes.push(el("div", { class: "rn-notice-bar", text: "THE SERVER'S DISK IS NEARLY FULL. Uploads are paused; running still works." }));
    }

    var saved = c.save ? renderSave(c, guard) : null;

    var running = Object.keys(c.jobs).map(function (id) { return c.jobs[id]; });
    var screens = running.filter(function (j) { return !!j.screen; }).map(function (j) { return player(j).box; });
    nodes.use = {};
    var jobs = el("div", { class: "rn-jobs" }, running.map(function (j) {
      nodes.use[j.id] = el("span", { class: "rn-use", text: useText(j.use) });
      return el("span", { class: "rn-job" }, [
        el("span", { text: "RUNNING " + j.name + "  " }),
        nodes.use[j.id],
        ui.button("STOP", function () { say({ t: "kill", job: j.id }); }, { danger: true })
      ]);
    }));

    nodes.line = el("div", { class: "rn-lines" });

    nodes.term = el("pre", { class: "rn-term" });
    scroll.forEach(function (s) { nodes.term.appendChild(el("span", { class: "rn-" + s.k, text: s.d })); });

    var input = el("input", { class: "rn-input", type: "text",
      placeholder: running.length ? "type here and press Enter to send it to the program"
        : "input goes here while something is running" });
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var ids = Object.keys(c.jobs);
      if (!ids.length) return;
      /* The newest job is the one somebody is looking at. */
      say({ t: "in", job: ids[ids.length - 1], d: input.value + "\n" });
      print("in", input.value + "\n");
      input.value = "";
    });

    nodes.root.appendChild(el("div", { class: "rn-wrap" }, [
      el("div", { class: "rn-top" }, [
        el("div", { class: "rn-tier" + (c.tier === "guest" ? " guest" : ""), text: tierLine(c) }),
        c.tier === "admin" ? ui.button("ADMIN", function () { adminView = true; render(); }) : null
      ])
    ].concat(notes, [drop, picker, nodes.busy, nodes.line, files, lib, saved, jobs], screens, [nodes.term,
      el("div", { class: "rn-inrow" }, [input,
        ui.button("CLEAR", function () { scroll = []; scrollChars = 0; if (nodes.term) ui.clear(nodes.term); })])
    ])));
    drawBusy();
    drawLine();
    nodes.term.scrollTop = nodes.term.scrollHeight;
  }

  /* ---- screens (phase 6) --------------------------------------------
     One player per running job that has a window. Its parts are made
     once and moved into each new render, because a canvas rebuilt on
     every redraw would lose its picture and its decoder. */
  function canScreen() {
    return typeof window.VideoDecoder === "function" && typeof window.EncodedVideoChunk === "function";
  }

  /* kind (1 video, 2 sound) | flags (1 keyframe) | id length | id | payload */
  function onFrame(buf) {
    var b = new Uint8Array(buf);
    if (b.length < 4) return;
    var len = b[2], id = "";
    for (var i = 0; i < len; i++) id += String.fromCharCode(b[3 + i]);
    var p = players[id];
    if (!p) return;
    var data = b.subarray(3 + len);
    if (b[0] === 1) p.video(data, (b[1] & 1) === 1);
    else if (b[0] === 2) p.audio(data);
  }

  function dropPlayers() {
    Object.keys(players).forEach(function (id) { players[id].end(); });
    players = {};
  }

  function player(j) {
    if (players[j.id]) return players[j.id];
    var sc = { w: (j.screen && j.screen.w) || 1280, h: (j.screen && j.screen.h) || 720 };
    var canvas = el("canvas", { class: "rn-screen", tabindex: "0", "data-fk-keys": "1", title: "click to use the program; Esc leaves full screen" });
    canvas.width = sc.w; canvas.height = sc.h;
    var g = canvas.getContext("2d");
    /* Wine starts slowly inside the sandbox: about 15 seconds before a
       Windows program's window exists to show. */
    var label = el("span", { class: "rn-scr-l", text: /.exe$/i.test(j.name || "")
      ? "STARTING… WINDOWS PROGRAMS TAKE ABOUT 20 SECONDS TO APPEAR" : "WAITING FOR THE PICTURE…" });
    var p = { id: j.id, sc: sc, canvas: canvas, dec: null, adec: null, actx: null, keyWait: true,
      ts: 0, ats: 0, nextT: 0, q: [], qTimer: null, held: {}, frames: 0, ended: false, muted: false };

    function decoder() {
      try {
        p.dec = new window.VideoDecoder({
          output: function (fr) {
            try { g.drawImage(fr, 0, 0, canvas.width, canvas.height); } finally { fr.close(); }
            if (!p.frames++) label.textContent = sc.w + "×" + sc.h + (j.screen && j.screen.enc === "gpu" ? " · GPU" : "") +
              (j.screen && j.screen.sound ? " · SOUND: CLICK THE PICTURE" : "");
          },
          error: function () { p.dec = null; p.keyWait = true; }
        });
        /* Constrained baseline, level 3.1: what the server's encoder makes. */
        p.dec.configure({ codec: "avc1.42E01F", optimizeForLatency: true });
      } catch (e) { p.dec = null; label.textContent = "THIS BROWSER COULD NOT DECODE THE PICTURE: " + e.message; }
    }

    p.video = function (data, key) {
      if (p.ended) return;
      if (!p.dec || p.dec.state === "closed") { if (!key) return; decoder(); if (!p.dec) return; }
      if (p.keyWait && !key) return;
      /* Behind (a slow machine or a busy tab): skip to the next keyframe
         rather than play a growing backlog late. */
      if (!key && p.dec.decodeQueueSize > 4) { p.keyWait = true; return; }
      p.keyWait = false;
      try {
        p.dec.decode(new window.EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: (p.ts += 33333), data: data }));
      } catch (e) { p.keyWait = true; }
    };

    function play(ad) {
      try {
        if (!p.actx || p.muted) return;
        var frames = ad.numberOfFrames, chans = Math.min(2, ad.numberOfChannels);
        var ab = p.actx.createBuffer(chans, frames, ad.sampleRate);
        for (var i = 0; i < chans; i++) {
          var plane = new Float32Array(frames);
          ad.copyTo(plane, { planeIndex: i, format: "f32-planar" });
          ab.copyToChannel(plane, i);
        }
        /* A short cushion, and never more than a few hundred ms behind:
           late sound is worse than a skipped packet. */
        var now = p.actx.currentTime;
        if (p.nextT < now + 0.02 || p.nextT > now + 0.35) p.nextT = now + 0.08;
        var src = p.actx.createBufferSource();
        src.buffer = ab;
        src.connect(p.actx.destination);
        src.start(p.nextT);
        p.nextT += ab.duration;
      } catch (e) {} finally { ad.close(); }
    }

    p.audio = function (data) {
      if (p.ended || !p.actx || p.muted || typeof window.AudioDecoder !== "function") return;
      if (!p.adec || p.adec.state === "closed") {
        try {
          p.adec = new window.AudioDecoder({ output: play, error: function () { p.adec = null; } });
          p.adec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
        } catch (e) { p.adec = null; return; }
      }
      try { p.adec.decode(new window.EncodedAudioChunk({ type: "key", timestamp: (p.ats += 20000), data: data })); } catch (e) {}
    };

    /* Sound may only start from a click, so the first click starts it. */
    function sound() {
      if (p.actx || p.muted) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { p.actx = new AC({ sampleRate: 48000, latencyHint: "interactive" }); } catch (e) { p.actx = null; }
      if (p.actx && j.screen && j.screen.sound) label.textContent = sc.w + "×" + sc.h + " · SOUND ON";
    }

    /* ---- input: batched, and a move replaces the move before it */
    function flush() {
      if (p.qTimer) { clearTimeout(p.qTimer); p.qTimer = null; }
      if (!p.q.length || p.ended) return;
      say({ t: "ui", job: p.id, e: p.q.splice(0, 64) });
    }
    function push(e) {
      var last = p.q[p.q.length - 1];
      if (e.t === "m" && last && last.t === "m") p.q[p.q.length - 1] = e;
      else p.q.push(e);
      if (p.q.length >= 48) flush();
      else if (!p.qTimer) p.qTimer = setTimeout(flush, 25);
    }
    /* Where on the program's screen, allowing for letterboxing when the
       picture is scaled to fit (full screen, or a narrow panel). */
    function at(e) {
      var r = canvas.getBoundingClientRect();
      var k = Math.min(r.width / sc.w, r.height / sc.h) || 1;
      var ox = r.left + (r.width - sc.w * k) / 2, oy = r.top + (r.height - sc.h * k) / 2;
      return { t: "m", x: Math.round((e.clientX - ox) / k), y: Math.round((e.clientY - oy) / k) };
    }
    var BTN = { 0: 1, 1: 2, 2: 3 };
    canvas.addEventListener("mousemove", function (e) { push(at(e)); });
    canvas.addEventListener("mousedown", function (e) {
      e.preventDefault();
      canvas.focus();
      sound();
      push(at(e));
      if (BTN[e.button]) push({ t: "b", b: BTN[e.button], d: 1 });
    });
    canvas.addEventListener("mouseup", function (e) { if (BTN[e.button]) push({ t: "b", b: BTN[e.button], d: 0 }); });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    canvas.addEventListener("wheel", function (e) { e.preventDefault(); if (e.deltaY) push({ t: "w", y: e.deltaY }); }, { passive: false });
    /* Keys pressed on the picture are the program's: not the page's,
       and not the desktop's shortcuts. */
    canvas.addEventListener("keydown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || !e.code) return;
      p.held[e.code] = 1;
      push({ t: "k", c: e.code, d: 1 });
    });
    canvas.addEventListener("keyup", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.code) return;
      delete p.held[e.code];
      push({ t: "k", c: e.code, d: 0 });
    });
    /* Leaving the picture lets go of every key, so none sticks down. */
    canvas.addEventListener("blur", function () {
      Object.keys(p.held).forEach(function (c) { push({ t: "k", c: c, d: 0 }); });
      p.held = {};
    });

    p.resize = function (s2) {
      if (!s2) return;
      j.screen = s2;
      if (s2.w !== sc.w || s2.h !== sc.h) { sc.w = s2.w; sc.h = s2.h; canvas.width = sc.w; canvas.height = sc.h; }
    };
    p.end = function () {
      p.ended = true;
      flush();
      try { if (p.dec && p.dec.state !== "closed") p.dec.close(); } catch (e) {}
      try { if (p.adec && p.adec.state !== "closed") p.adec.close(); } catch (e) {}
      try { if (p.actx) p.actx.close(); } catch (e) {}
      p.dec = p.adec = p.actx = null;
    };

    var muteBtn = ui.button("MUTE", function () {
      p.muted = !p.muted;
      muteBtn.textContent = p.muted ? "UNMUTE" : "MUTE";
      if (p.muted && p.actx) { try { p.actx.close(); } catch (e) {} p.actx = null; }
      if (!p.muted) sound();
    });
    p.box = el("div", { class: "rn-scr" }, [
      el("div", { class: "rn-scr-h" }, [
        el("span", { class: "rn-scr-n", text: j.name }), label,
        muteBtn,
        ui.button("FULL SCREEN", function () {
          canvas.focus();
          sound();
          if (canvas.requestFullscreen) canvas.requestFullscreen().catch(function () {});
        })
      ]),
      canvas
    ]);
    players[j.id] = p;
    return p;
  }

  /* ---- the saved folder (/save) -------------------------------------
     What members' programs keep between runs. The list is fetched when
     opened, not on every refresh: it can be long and nobody needs it
     unless they ask. */
  function sfRef() { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  async function saveDo(cmd, guard) {
    var c = conn;
    if (!c) return;
    var ref = sfRef();
    cmd.ref = ref;
    var out = await ask(c, ref, cmd);
    if (out.t === "error") return ui.toast(String(out.why).toUpperCase(), "fail");
    if (out.t === "save") { saveList = out.files; c.save = out.usage; }
    if (guard() && conn === c) render();
  }

  function renderSave(c, guard) {
    var u = c.save;
    var box = el("div", { class: "rn-files rn-lib" }, [
      el("div", { class: "rn-top" }, [
        el("div", { class: "rn-lib-h", text: "SAVED FOLDER (/save): " + fmtBytes(u.bytes || 0) + " of " +
          fmtBytes(u.limitBytes) + ", " + (u.files || 0) + " item(s)" }),
        ui.button(saveOpen ? "HIDE" : "SHOW", function () {
          saveOpen = !saveOpen;
          if (saveOpen) saveDo({ t: "save-ls" }, guard); else render();
        })
      ])
    ]);
    if (!saveOpen) return box;
    var list = saveList || [];
    if (!list.length) box.appendChild(el("div", { class: "rn-none", text: "EMPTY. Programs can write to /save to keep things between runs." }));
    list.forEach(function (x) {
      box.appendChild(el("div", { class: "rn-file" }, [
        el("span", { class: "rn-name", text: x.path, title: x.path }),
        el("span", { class: "rn-size", text: x.special ? "link" : fmtBytes(x.size) }),
        x.special ? null : ui.button("DOWNLOAD", function () { saveDo({ t: "save-get", path: x.path }, guard); }),
        ui.button("DELETE", function () {
          if (window.confirm("Delete " + x.path + " from your saved folder?")) saveDo({ t: "save-rm", path: x.path }, guard);
        }, { danger: true })
      ]));
    });
    if (list.length) {
      box.appendChild(el("div", { class: "rn-actions" }, [
        ui.button("EMPTY THE FOLDER", function () {
          if (window.confirm("Delete everything in your saved folder? This cannot be undone.")) saveDo({ t: "save-clear" }, guard);
        }, { danger: true })
      ]));
    }
    return box;
  }

  /* ---- the ADMIN screen ---------------------------------------------
     Admins only, and only as a convenience: every command is checked
     again by the run server against the tier the relay signed. */
  function admRef() { return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  async function adminDo(cmd, guard, ask1) {
    var c = conn;
    if (!c) return;
    if (ask1) {
      var why = window.prompt(ask1);
      if (why === null) return;
      if (!String(why).trim()) return ui.toast("NOTHING DONE: A REASON IS NEEDED", "warn");
      cmd.reason = String(why).trim();
    }
    var ref = admRef();
    cmd.ref = ref;
    var out = await ask(c, ref, cmd);
    if (out.t === "error") ui.toast(String(out.why).toUpperCase(), "fail");
    else ui.toast(String(out.done || "DONE").toUpperCase(), "ok");
    /* The library and the file list may have changed under it. */
    if (out.t !== "error") say({ t: "ls" });
    if (guard() && adminView) render();
  }

  function renderAdmin(guard) {
    var c = conn;
    var box = el("div", { class: "rn-adm" }, [
      el("div", { class: "rn-top" }, [
        el("div", { class: "rn-notice-h", text: "RUNNER ADMIN" }),
        ui.button("REFRESH", function () { render(); }),
        ui.button("BACK", function () { adminView = false; adminUser = null; say({ t: "ls" }); render(); })
      ]),
      el("div", { class: "rn-dim", text: "loading..." })
    ]);
    nodes.root.appendChild(box);
    var ref = admRef();
    ask(c, ref, { t: "adm-overview", ref: ref }).then(function (out) {
      if (!guard() || conn !== c || !adminView) return;
      box.removeChild(box.children[box.children.length - 1]);
      if (out.t === "error") return box.appendChild(el("div", { class: "rn-notice-p", text: out.why }));
      drawAdmin(box, out.data, guard);
    });
  }

  function row(children) { return el("div", { class: "rn-adm-row" }, children); }
  function head(text) { return el("div", { class: "rn-adm-h", text: text }); }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? "just now" : m < 90 ? m + " min" : Math.round(m / 60) + " h";
  }

  /* How full the machine is, the line, and who gets in (RUNNER_PLAN.md
     §22). Admins never wait; these numbers are for everyone else. */
  function drawAccess(box, a, go) {
    if (!a) return;
    var m = a.meter || {}, s = a.settings || {};
    box.appendChild(head("LOAD AND THE LINE"));
    [["processor", m.cpu], ["memory", m.mem], ["upload", m.upPct]].forEach(function (x) {
      var pct = Math.max(0, Math.min(100, Math.round(x[1] || 0)));
      box.appendChild(el("div", { class: "rn-meter" }, [
        el("span", { class: "rn-meter-l", text: x[0] + " " + pct + "%" + (x[0] === "upload" ? " of " + s.uploadMbps + " Mbit/s" : "") }),
        el("div", { class: "rn-gauge" + (pct >= (s.member ? s.member.load : 85) ? " hot" : "") }, [el("div", { style: { width: pct + "%" } })])
      ]));
    });
    /* The relay's browser shares the home upload (§14.23); its report
       says how much it uses, and windows' video steps down when busy. */
    box.appendChild(el("div", { class: "rn-dim", text: (m.relaySeenSec == null || m.relaySeenSec > 120
      ? "The relay has not reported its browser's upload lately, so only this machine's is counted."
      : "The relay's browser is using " + (m.relayUpKbps || 0) + " kbit/s of it" + (m.relayWaiting ? ", with " + m.relayWaiting + " waiting" : "") +
        " (reported " + m.relaySeenSec + " s ago).") +
      (m.videoStep ? " Windows' video is turned down (" + (m.videoStep === 1 ? "a little" : "a lot") + ") to fit." : "") }));
    box.appendChild(el("div", { class: "rn-dim", text: "Guests get in while load is under " + s.guest.load + "% and upload under " +
      s.guest.upload + "%; members under " + s.member.load + "% and " + s.member.upload + "%. Everyone else waits in line; admins never do." }));
    if (!a.line.length) box.appendChild(el("div", { class: "rn-dim", text: "nobody is waiting" }));
    a.line.forEach(function (e) {
      box.appendChild(row([
        el("span", { class: "rn-name", text: e.place + ". " + e.handle + " (" + e.tier + (e.bumped ? ", moved up" : "") + ")" }),
        el("span", { class: "rn-dim", text: (e.kind === "screen" ? "a window" : "a program") + (e.name ? ": " + e.name : "") +
          (e.turnLeft != null ? ", THEIR TURN NOW" : "") + (e.away ? ", away" : "") }),
        e.place > 1 ? ui.button("MOVE TO FRONT", go({ t: "adm-line-up", id: e.id })) : null,
        ui.button("REMOVE", go({ t: "adm-line-rm", id: e.id }, "Why are you taking them out of the line? They are shown this."), { danger: true })
      ]));
    });
    var num = function (v, w) { return el("input", { class: "rn-input", type: "number", min: "0", max: "100", value: v, style: { width: w || "56px", flex: "0 0 auto" } }); };
    var gl = num(s.guest.load), gu = num(s.guest.upload), ml = num(s.member.load), mu = num(s.member.upload), up = num(s.uploadMbps, "64px");
    up.max = "10000";
    box.appendChild(row([el("span", { class: "rn-dim", text: "guests: load %" }), gl, el("span", { class: "rn-dim", text: "upload %" }), gu,
      el("span", { class: "rn-dim", text: "members: load %" }), ml, el("span", { class: "rn-dim", text: "upload %" }), mu,
      el("span", { class: "rn-dim", text: "upload Mbit/s" }), up,
      ui.button("SAVE", function () {
        go({ t: "adm-access", guest: { load: Number(gl.value), upload: Number(gu.value) },
          member: { load: Number(ml.value), upload: Number(mu.value) }, uploadMbps: Number(up.value) })();
      })]));
  }

  /* What Bastion 2 draws (RUNNER_PLAN.md §24): measured CPU and card,
     an estimate for the rest, and what a month costs at the day's
     average. The price is set here rather than in a file on Bastion 2. */
  function drawPower(box, p, go) {
    box.appendChild(head("POWER"));
    if (!p) return box.appendChild(el("div", { class: "rn-dim", text: "this run server is too old to say" }));
    var s = p.settings || {};
    if (!p.ok) {
      box.appendChild(el("div", { class: "rn-dim", text: p.why }));
    } else {
      var n = p.now || {};
      var parts = [];
      parts.push(n.cpuW != null ? "processor " + Math.round(n.cpuW) + " W" : "processor not measured");
      parts.push(n.gpuW != null ? "graphics card " + Math.round(n.gpuW) + " W" + (n.gpuState ? " (" + n.gpuState + (n.gpuTempC != null ? ", " + n.gpuTempC + "°C" : "") + ")" : "")
        : "no graphics card reading");
      parts.push("about " + s.otherWatts + " W for the rest of the PC (an estimate)");
      box.appendChild(el("div", { class: "rn-dim", text: "Now: " + parts.join(", ") + "." }));
      box.appendChild(el("div", { class: "rn-dim", text: "Average " + p.avgW + " W" +
        (p.overHours >= 0.1 ? " over the last " + p.overHours + " h" : " (just started measuring)") +
        ", which is about " + p.monthKwh + " kWh a month" +
        (p.monthCost != null ? ", or " + s.currency + p.monthCost.toFixed(2) + " a month at " + s.currency + s.pricePerKwh + " per kWh."
          : ". Set your price per kWh below to see what that costs.") }));
    }
    var price = el("input", { class: "rn-input", type: "number", min: "0", step: "0.01", value: s.pricePerKwh || "", placeholder: "price per kWh", style: { width: "110px", flex: "0 0 auto" } });
    var other = el("input", { class: "rn-input", type: "number", min: "0", step: "1", value: s.otherWatts != null ? s.otherWatts : 30, style: { width: "70px", flex: "0 0 auto" } });
    var cur = el("input", { class: "rn-input", type: "text", maxlength: "4", value: s.currency || "$", style: { width: "44px", flex: "0 0 auto" } });
    box.appendChild(row([el("span", { class: "rn-dim", text: "price per kWh" }), cur, price,
      el("span", { class: "rn-dim", text: "rest of the PC, W" }), other,
      ui.button("SAVE", function () {
        go({ t: "adm-power", price: price.value === "" ? 0 : Number(price.value), other: Number(other.value), currency: cur.value })();
      })]));
  }

  function drawAdmin(box, d, guard) {
    var go = function (cmd, why) { return function () { adminDo(cmd, guard, why); }; };
    var pct = Math.round((d.disk.pct || 0) * 100);
    box.appendChild(head("DISK"));
    box.appendChild(el("div", { class: "rn-gauge" + (pct >= 80 ? " hot" : "") }, [el("div", { style: { width: pct + "%" } })]));
    box.appendChild(el("div", { class: "rn-dim", text: fmtBytes(d.disk.used) + " of " + fmtBytes(d.disk.total) +
      " used (" + pct + "%). Unused files are deleted after " + d.ttlDays + " days." +
      (d.pressure === "full" ? " Uploads are paused for everyone but admins." : "") }));
    box.appendChild(ui.button("RUN THE CLEAN-UP NOW", go({ t: "adm-sweep" })));

    /* A record the run server could not read (a power cut, a full disk):
       first, because nothing that touches it can be changed until it is fixed. */
    if (d.damaged && d.damaged.length) {
      box.appendChild(head("DAMAGED RECORDS"));
      d.damaged.forEach(function (w) { box.appendChild(el("div", { class: "rn-dim", text: "✗ " + w })); });
    }
    drawPower(box, d.power, go);
    drawAccess(box, d.access, go);

    box.appendChild(head("RUNNING NOW (" + d.jobs.length + ")"));
    if (!d.jobs.length) box.appendChild(el("div", { class: "rn-dim", text: "nothing" }));
    /* Busiest first: the one to look at is at the top. */
    d.jobs.slice().sort(function (a, b) { return (b.cpu || 0) - (a.cpu || 0); }).forEach(function (j) {
      box.appendChild(row([el("span", { class: "rn-name", text: j.name + "  (" + j.handle + ", " + ago(j.startedAt) + ")" }),
        el("span", { class: "rn-use", text: useText(j) + (j.outKb ? "  ·  " + j.outKb + " KB out" : "") }),
        ui.button("STOP", go({ t: "adm-kill", job: j.id }), { danger: true })]));
    });

    box.appendChild(head("PEOPLE"));
    var who = {};
    d.users.forEach(function (u) { who[u.handle] = u; });
    d.sessions.forEach(function (s) {
      if (!who[s.handle]) who[s.handle] = { handle: s.handle, files: 0, bytes: 0, online: true };
    });
    /* No punishing yourself: the server refuses it, so do not offer it. */
    var msgs = FieldKit.service("messages"), me = msgs && msgs.handle ? msgs.handle() : null;
    Object.keys(who).sort().forEach(function (h) {
      var u = who[h], other = h !== me;
      var status = (u.online ? "online" : "offline") + ", " + u.files + " file(s), " + fmtBytes(u.bytes) +
        (u.suspended ? ", SUSPENDED: " + u.suspended.reason : "") + (u.cooldown ? ", COOLDOWN: " + u.cooldown.reason : "") +
        (u.noGpu ? ", NO GPU: " + u.noGpu.reason : "");
      box.appendChild(row([
        el("span", { class: "rn-name", text: h }), el("span", { class: "rn-dim", text: status }),
        ui.button("FILES", function () { adminUser = h; showUser(box, h, guard); }),
        other && ui.button("WARN", go({ t: "adm-punish", handle: h, action: "warn" }, "Warn " + h + ". What should they be told?")),
        other && ui.button("COOLDOWN 1H", go({ t: "adm-punish", handle: h, action: "cooldown", minutes: 60 },
          "No new runs for an hour. Why? They are shown this.")),
        other && ui.button("SUSPEND 7D", go({ t: "adm-punish", handle: h, action: "suspend", days: 7 },
          "Suspend " + h + " from RUNNER for 7 days. Why?"), { danger: true }),
        (u.suspended || u.cooldown) ? ui.button("LIFT", go({ t: "adm-punish", handle: h, action: "clear" })) : null,
        other && !u.noGpu ? ui.button("NO GPU", go({ t: "adm-punish", handle: h, action: "nogpu" },
          "Stop " + h + " using the graphics card. Why? They are shown this.")) : null,
        u.noGpu ? ui.button("GPU BACK", go({ t: "adm-punish", handle: h, action: "gpu" })) : null,
        u.online && other ? ui.button("DISCONNECT", go({ t: "adm-kick", handle: h })) : null
      ]));
    });
    box.appendChild(el("div", { class: "rn-dim",
      text: "Banning an account outright is done in MESSAGES (REPORTS). It reaches RUNNER within 20 minutes." }));

    box.appendChild(head("SHARED LIBRARY (" + d.library.length + ")"));
    d.library.forEach(function (f) {
      var from = (f.origin && f.origin.handle) || "unknown";
      box.appendChild(row([el("span", { class: "rn-name", text: ((f.card && f.card.title) ? f.card.title + " = " : "") +
          f.name + "  (" + fmtBytes(f.size) + ", from " + from + ")" }),
        ui.button(cardEdit === f.id ? "CLOSE CARD" : "CARD", function () { cardEdit = cardEdit === f.id ? null : f.id; render(); }),
        ui.button("UNPIN", go({ t: "adm-unpin", file: f.id })),
        ui.button("DELETE", go({ t: "adm-lib-rm", file: f.id }), { danger: true }),
        ui.button("BLOCK", go({ t: "adm-block", file: f.id }, "Block " + f.name + " everywhere, for good? Why?"), { danger: true })]));
      if (cardEdit === f.id) box.appendChild(cardForm(f, go));
    });

    box.appendChild(head("BIN (can be restored)"));
    if (!d.trash.length) box.appendChild(el("div", { class: "rn-dim", text: "empty" }));
    d.trash.forEach(function (x) {
      box.appendChild(row([el("span", { class: "rn-name", text: x.name + "  (" + x.from + ": " + x.reason + ")" }),
        ui.button("RESTORE", go({ t: "adm-restore", file: x.id }))]));
    });

    if (d.blocked.length) {
      box.appendChild(head("BLOCKED FILES"));
      d.blocked.forEach(function (b) {
        box.appendChild(row([el("span", { class: "rn-name", text: (b.name || b.sha256.slice(0, 16)) + ": " + b.reason + " (" + b.by + ")" }),
          ui.button("UNBLOCK", go({ t: "adm-unblock", sha256: b.sha256 }))]));
      });
    }

    box.appendChild(head("RECENT ACTIONS"));
    if (!d.audit.length) box.appendChild(el("div", { class: "rn-dim", text: "none yet" }));
    d.audit.slice(0, 25).forEach(function (a) {
      box.appendChild(el("div", { class: "rn-dim", text: String(a.at).slice(0, 16).replace("T", " ") + "  " + a.by + "  " +
        a.action + (a.target ? "  " + a.target : "") + (a.detail ? "  (" + a.detail + ")" : "") }));
    });
    if (adminUser) showUser(box, adminUser, guard);
  }

  /* One person's files, shown above everything else on the screen. */
  function showUser(box, h, guard) {
    var c = conn, ref = admRef();
    if (nodes.userPart && nodes.userPart.parentNode) nodes.userPart.parentNode.removeChild(nodes.userPart);
    var part = el("div", { class: "rn-user" }, [head("FILES BELONGING TO " + h.toUpperCase())]);
    nodes.userPart = part;
    box.insertBefore(part, box.children[1] || null);
    var go = function (cmd, why) { return function () { adminDo(cmd, guard, why); }; };
    ask(c, ref, { t: "adm-user", ref: ref, handle: h }).then(function (out) {
      if (!guard() || conn !== c) return;
      if (out.t === "error" || !out.files.length) {
        return part.appendChild(el("div", { class: "rn-dim", text: out.why || "none" }));
      }
      out.files.forEach(function (f) {
        part.appendChild(row([el("span", { class: "rn-name", text: f.name + "  (" + fmtBytes(f.size) +
            (f.expiringSoon ? ", deleted in " + daysUntil(f.expiresAt) : "") + ")" }),
          ui.button("MAKE PERMANENT", go({ t: "adm-pin", handle: h, file: f.id })),
          ui.button("DELETE", go({ t: "adm-rm", handle: h, file: f.id }), { danger: true }),
          ui.button("BLOCK", go({ t: "adm-block", handle: h, file: f.id },
            "Block " + f.name + " everywhere, for good? Why?"), { danger: true })]));
      });
      part.appendChild(ui.button("MOVE ALL OF THESE TO THE BIN", function () {
        if (window.confirm("Move every file " + h + " has to the bin?")) adminDo({ t: "adm-purge", handle: h }, guard);
      }, { danger: true }));
    });
  }

  function injectCSS() {
    if (document.getElementById("rn-style")) return;
    var s = document.createElement("style");
    s.id = "rn-style";
    s.textContent = [
      ".rn-root{height:100%;display:flex;flex-direction:column}",
      ".rn-wrap{display:flex;flex-direction:column;gap:6px;height:100%;min-height:0;overflow:auto}",
      ".rn-wrap>*{flex-shrink:0}.rn-wrap>.rn-term{flex-shrink:1}",
      ".rn-notice{margin:auto;max-width:520px;text-align:center;padding:24px}",
      ".rn-notice-h{font-size:13px;letter-spacing:.16em;color:var(--accent);margin-bottom:10px}",
      ".rn-notice-p{font-size:11px;line-height:1.6;color:var(--fg-dim);margin-bottom:14px}",
      ".rn-actions{display:flex;gap:6px;justify-content:center;flex-wrap:wrap}",
      ".rn-tier{font-size:10px;line-height:1.5;color:var(--fg-dim);border-left:2px solid var(--accent);padding:2px 8px}",
      ".rn-tier.guest{border-left-color:var(--warn);color:var(--warn)}",
      ".rn-drop{border:1px dashed var(--line);padding:14px;text-align:center;font-size:11px;",
      "  letter-spacing:.12em;color:var(--fg-dim);cursor:pointer}",
      ".rn-drop.over,.rn-drop:hover{border-color:var(--accent);color:var(--accent)}",
      ".rn-picker{display:none}",
      ".rn-busy{font-size:10px;color:var(--accent);min-height:12px}",
      ".rn-files{max-height:150px;overflow:auto;border:1px solid var(--line)}",
      ".rn-file{display:flex;gap:6px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--line)}",
      ".rn-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}",
      ".rn-size{font-size:10px;color:var(--fg-dimmer);width:64px;text-align:right}",
      ".rn-args{width:150px}",
      ".rn-none{padding:10px;font-size:10px;color:var(--fg-dimmer);text-align:center}",
      ".rn-jobs{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--accent)}",
      ".rn-term{flex:1;min-height:80px;margin:0;overflow:auto;background:#000;color:var(--fg);",
      "  border:1px solid var(--line);padding:6px;font-size:11px;white-space:pre-wrap;word-break:break-all}",
      ".rn-err{color:var(--warn)}.rn-note{color:var(--fg-dimmer)}.rn-in{color:var(--accent)}",
      ".rn-inrow{display:flex;gap:6px}.rn-input{flex:1}",
      ".rn-top{display:flex;gap:8px;align-items:flex-start}.rn-top .rn-tier{flex:1}",
      ".rn-exp{font-size:10px;color:var(--warn);white-space:nowrap}",
      ".rn-lib-h{font-size:10px;letter-spacing:.14em;color:var(--accent);padding:4px 6px;border-bottom:1px solid var(--line)}",
      ".rn-notice-bar{font-size:10px;color:var(--warn);border:1px solid var(--warn);padding:4px 8px}",
      ".rn-lines{display:flex;flex-direction:column;gap:4px}",
      ".rn-line{display:flex;gap:8px;align-items:center;font-size:10px;color:var(--fg-dim);border:1px solid var(--line2);padding:4px 8px}",
      ".rn-line.turn{border-color:var(--accent);color:var(--accent)}",
      ".rn-line-t{flex:1;min-width:0}",
      ".rn-meter{display:flex;gap:10px;align-items:center;font-size:10px;color:var(--fg-dim)}",
      ".rn-meter .rn-gauge{flex:1}",
      ".rn-meter-l{flex:0 0 120px}",
      ".rn-adm{display:flex;flex-direction:column;gap:8px;height:100%;overflow:auto}",
      ".rn-adm-h{font-size:11px;letter-spacing:.14em;color:var(--accent);margin-top:4px}",
      ".rn-adm-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:3px 6px;border-bottom:1px solid var(--line);font-size:11px}",
      ".rn-adm-row .rn-name{flex:1}",
      ".rn-gauge{height:8px;border:1px solid var(--line);position:relative}",
      ".rn-gauge>div{height:100%;background:var(--accent)}.rn-gauge.hot>div{background:var(--warn)}",
      ".rn-dim{color:var(--fg-dimmer);font-size:10px}",
      ".rn-zip{display:flex;flex-direction:column;gap:5px;padding:6px 6px 8px 18px;border-bottom:1px solid var(--line);font-size:11px}",
      ".rn-zip-list{display:flex;flex-wrap:wrap;gap:4px;align-items:center}",
      ".rn-use{font-size:10px;color:var(--fg-dimmer);margin-right:6px}",
      ".rn-card .rn-name{color:var(--accent);font-weight:bold}",
      ".rn-about{font-size:10px;color:var(--fg-dimmer);padding:0 6px 4px 12px;border-bottom:1px solid var(--line)}",
      ".rn-playing{font-size:9px;letter-spacing:.12em;color:var(--ok, var(--accent));border:1px solid currentColor;padding:0 4px}",
      ".rn-cardform{display:flex;flex-direction:column;gap:4px;padding:6px 6px 8px 18px;border-bottom:1px solid var(--line)}",
      ".rn-card-in{width:100%}",
      ".rn-scr{border:1px solid var(--line);background:#000;display:flex;flex-direction:column;flex:none}",
      ".rn-scr-h{display:flex;gap:8px;align-items:center;padding:3px 6px;font-size:10px;border-bottom:1px solid var(--line)}",
      ".rn-scr-n{color:var(--accent);letter-spacing:.1em}.rn-scr-l{flex:1;color:var(--fg-dimmer)}",
      ".rn-screen{display:block;max-width:100%;max-height:52vh;margin:0 auto;background:#000;outline:none;cursor:default}",
      ".rn-screen:focus{box-shadow:0 0 0 1px var(--accent)}",
      ".rn-screen:fullscreen{width:100vw;height:100vh;max-height:none;object-fit:contain;box-shadow:none}"
    ].join("\n");
    document.head.appendChild(s);
  }

  /* ---- selfcheck --------------------------------------------------- */
  function selfcheck() {
    var asBytes = function (s) {
      var b = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    };
    var state = { limits: { maxFileBytes: 1000, quotaBytes: 1500, maxFiles: 2 },
      usage: { files: 1, bytes: 600 }, windows: false };
    return [
      { name: "THE HASH MATCHES THE STANDARD'S KNOWN ANSWER", critical: true, run: async function () {
        var want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        var got = new Sha256().update(asBytes("abc")).hex();
        if (got !== want) throw new Error("sha256('abc') came out as " + got);
        var long = "";
        for (var i = 0; i < 300; i++) long += "fieldkit runner ";
        var whole = new Sha256().update(asBytes(long)).hex();
        var parts = new Sha256(), b = asBytes(long);
        for (var p = 0; p < b.length; p += 77) parts.update(b.subarray(p, p + 77));
        if (parts.hex() !== whole) throw new Error("hashing in slices gives a different answer");
        return "correct, and the same whether fed whole or in pieces";
      } },
      { name: "NOTHING UPLOADS WHILE THE SERVER IS AWAY", critical: true, run: async function () {
        if (!whyNot({ name: "a.py", size: 10 }, "python", null)) {
          throw new Error("a file was allowed with no connection");
        }
        return "an upload with no connection is refused here, before it starts";
      } },
      { name: "A FILE OVER THE LIMIT IS REFUSED BEFORE IT IS SENT", critical: true, run: async function () {
        if (!/at most/.test(whyNot({ name: "a.py", size: 2000 }, "python", state))) throw new Error("oversize allowed");
        if (!/storage limit/.test(whyNot({ name: "a.py", size: 950 }, "python", state))) throw new Error("quota ignored");
        if (!/empty/.test(whyNot({ name: "a.py", size: 0 }, "python", state))) throw new Error("empty allowed");
        if (whyNot({ name: "a.py", size: 100 }, "python", state)) throw new Error("a good file was refused");
        return "size, quota and empty files are all caught on this side";
      } },
      { name: "FILE TYPES ARE JUDGED BY THEIR BYTES", critical: false, run: async function () {
        if (kindOf("totally.txt", [0x7f, 0x45, 0x4c, 0x46]) !== "linux") throw new Error("ELF not recognised");
        if (kindOf("innocent.py", [0x4d, 0x5a]) !== "windows") throw new Error("a renamed .exe passed as Python");
        if (kindOf("notes.docx", [0x50, 0x4b]) !== null) throw new Error("a document was called runnable");
        if (!/not switched on/.test(whyNot({ name: "g.exe", size: 10 }, "windows", state))) {
          throw new Error("a Windows program was allowed while Windows is off");
        }
        return "a renamed file is still what its first bytes say it is";
      } },
      { name: "NO CREDENTIAL IS HELD OR STORED HERE", critical: true, run: async function () {
        var src = String(open) + String(refresh) + String(upload) + String(run) + String(checkStatus);
        if (/localStorage|sessionStorage|settings\.set|store\.put/.test(src)) {
          throw new Error("something on the connection path writes to storage");
        }
        if (/Authorization|token/i.test(src.replace(/runnerTicket|t\.ticket|ticket/g, ""))) {
          throw new Error("the panel is handling a credential itself");
        }
        return "only a one-minute ticket passes through, and it is never written down";
      } }
    ];
  }

  FieldKit.register("runner", {
    title: "RUNNER",
    icon: "▶",
    group: "ONLINE",
    about: "Upload a program and run it on the run server, window and all",
    keywords: "run execute exe python program game server upload bastion 2 wine",
    width: 820,
    height: 620,
    guestSafe: false,
    selfcheck: selfcheck,

    mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      alive = FieldKit.mountGuard("runner");
      injectCSS();
      nodes.root = el("div", { class: "rn-root" });
      host.appendChild(nodes.root);
      phase = "checking";
      render();
      refresh(alive);
    },

    unmount() {
      /* Closing the panel closes the connection. For a guest that is
         what deletes their sandbox, so it must not be left open by a
         panel nobody can see. */
      stopRetry();
      closeConn();
      dropPlayers();
      if (alive && alive.end) alive.end();
      scroll = []; scrollChars = 0;
      phase = "checking";
      nodes = {};
    }
  });
})(window.FieldKit);
