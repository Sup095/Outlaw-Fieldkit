/* ============================================================
   FieldKit relay :: browser-route — one socket instead of hundreds

   The wire between the FieldKit panel and browser-engine.js.

   THIS FILE IS THE FIX FOR "IT SENDS A LOT OF REQUESTS"

   The old browser could not help it. Serving a page meant proxying
   every asset on that page: one news article was two or three
   hundred requests through /browse/p/…, each one counted by the
   rate limiter, each one a full HTTP round trip from a school
   Chromebook to a relay behind a tunnel. Searching twice was enough
   to trip a limit that exists for good reasons.

   A streamed browser makes exactly ONE connection. The page's two
   hundred requests happen inside the container, at container
   speed, and never touch the limiter. What crosses the tunnel is
   JPEG frames going out and input events coming back — and the
   frames go as BINARY, not base64 JSON, because base64 costs a
   third more bytes for nothing.

   AUTH, AND WHY THE TICKET SURVIVED THE REWRITE

   A browser cannot set an Authorization header on a WebSocket. So
   the credential is traded for a short-lived ticket over an
   ordinary authenticated POST, and the ticket rides in the query
   of the socket URL. Same shape as the old browse ticket and for
   the same reason.

   What is NEW is what the ticket names. It is bound to an ACCOUNT,
   and the account is the messaging one — sign in to MESSAGES and
   the browser is yours, with your cookies and your history and
   nobody else's. One account for both, which is what was asked
   for. A vault token still works and gets its own session, because
   OUTPOST has no messaging account and the full build's owner
   should not have to make one to open a web page.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const ws = require("./ws");
const { Engine, normaliseUrl } = require("./browser-engine");
const { Transcoder, findFfmpeg } = require("./video-encoder");
const { STEPS } = require("./fairness");

const TICKET_MS = 60 * 1000;         /* only has to survive the upgrade */
const MAX_MSG = 256 * 1024;
const INPUT_PER_SEC = 240;           /* generous for a dragged mouse */
/* Video to one panel: over this much waiting on its connection, new
   pictures are held back (the newest kept) until it drains. */
const VIDEO_HIGH = 1024 * 1024;
/* Binary frames: video is 0 or 1 (keyframe) first, a picture is a JPEG
   (0xFF first), and sound is 2 first. */
const AUDIO_TAG = Buffer.from([2]);
/* Each panel's own connection (RUNNER_PLAN.md §16, adaptive quality).
   The house step above follows the home upload; this follows one
   viewer's link and decoder. Three strains inside STRAIN_MS (frames
   held because its socket is backed up, or its decoder asking for a
   fresh start because it fell behind) take that viewer one step down;
   OWN_CALM_MS without one takes it back up. The lower of the two
   steps wins. A step costs a keyframe, so they are at least
   OWN_GAP_MS apart. */
const OWN = [1, 0.6, 0.35];
const STRAIN_MS = 6000, OWN_GAP_MS = 5000, OWN_CALM_MS = 30000;

let cfg = {};
let log = () => {};
let engine = null;
let fair = null;                 /* fairness.js: the browser's share and its line */
let fairTimer = null;
/* overflow.js: helpers on Bastion 2 that take new sessions when this
   relay is full. null when none are set, and on a helper itself. */
let overflow = null;
/* On a helper, the relay says which video step the house is on. */
let houseStep = 0;
const viewers = new Set();        /* every open panel, to step its video down or up */
const tickets = new Map();
/* Single-use links for a finished download and for the files a page
   asked for (RUNNER_PLAN.md §16), handed out over the stream, so the
   panel needs no sign-in of its own to use them. token -> link */
const links = new Map();
const LINK_MS = 10 * 60 * 1000;

function linkFor(kind, key, id) {
  const now = Date.now();
  for (const [k, l] of links) if (l.expires <= now) links.delete(k);
  const token = crypto.randomBytes(24).toString("hex");
  links.set(token, { kind, key: String(key), id, expires: now + LINK_MS, uses: 0 });
  return token;
}

function init(opts) {
  cfg = Object.assign({ enabled: false, searchUrl: "https://lite.duckduckgo.com/lite/?kp=1&q=" },
    opts.config || {});
  log = opts.log || (() => {});
  engine = new Engine({ config: cfg, log, filter: opts.filter });
  /* The browser as video (RUNNER_PLAN.md §23) when the image has
     ffmpeg and the setting is not off. Without it, pictures as before. */
  engine.videoBin = cfg.video === false ? null : findFfmpeg(cfg.ffmpeg);
  /* RUNNER_PLAN.md §22. Every 2 s: the meter, then the first in line
     is let in if there is room, and everyone waiting hears where they are. */
  fair = opts.fairness || null;
  overflow = opts.overflow || null;
  houseStep = 0;
  if (fairTimer) clearInterval(fairTimer);
  fairTimer = null;
  if (fair) {
    fairTimer = setInterval(() => {
      fair.sample();
      const was = fair.step, k = fair.videoKbps(cfg.videoKbps || 1500);
      if (fair.step !== was) log("INFO", "browser: video " + (fair.step > was ? "down" : "up") + " to " + k + " kbit/s (house upload " + Math.round(fair.upPct(0)) + "%)");
      for (const v of viewers) v.restep();
      if (overflow) {
        overflow.step = fair.step;
        /* The first in line, if a helper has room for them and this relay
           does not: told to connect again, which places them there. */
        const head = fair.ordered()[0];
        if (head && !fair.fits(head.tier, engine.hasRoom()) && overflow.pick(head.who, head.tier, fair)) {
          fair.leave(head);
          head.moved = true;
          head.go();
        }
      }
      fair.pump(engine.hasRoom());
      for (const e of fair.line) if (e.tell) e.tell(fair.place(e));
    }, 2000);
    if (fairTimer.unref) fairTimer.unref();
  }
  return engine;
}

function sweep() {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expires <= now) tickets.delete(k);
}

/* tier: guest, member or admin (the vault holder owns this relay, so
   admin). It decides whether a new session may have to wait. */
function issue(who, tier) {
  sweep();
  const id = crypto.randomBytes(24).toString("hex");
  tickets.set(id, { who, tier: tier || "admin", expires: Date.now() + TICKET_MS });
  return id;
}

function take(id) {
  sweep();
  const t = tickets.get(String(id || ""));
  if (!t) return null;
  tickets.delete(String(id));
  return t;
}

function spend(id) {
  sweep();
  const t = tickets.get(String(id || ""));
  if (!t) return null;
  /* Single use. A stream ticket that stayed valid would sit in the
     panel's URL bar, in a log, in a screenshot — and it is the
     whole session. */
  tickets.delete(String(id));
  return t.who;
}

/* ---- HTTP side --------------------------------------------------- */

async function route(req, res, url, helpers) {
  const seg = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] !== "browser") return false;

  const { send, authorise, readBody } = helpers;
  const what = seg[1] || "";
  const method = req.method;

  if (!cfg.enabled) {
    send(res, 503, { error: "the streamed browser is not enabled on this relay",
      detail: "set browser.enabled in config.json and restart" });
    return true;
  }

  /* A download, once, by its link. */
  if (what === "file" && method === "GET") {
    const l = links.get(seg[2] || "");
    links.delete(seg[2] || "");
    const sess = l && l.kind === "dl" && l.expires > Date.now() && engine.sessions.get(l.key);
    const d = sess && engine.download(sess, l.id);
    if (!d) { send(res, 404, { error: "that download has gone — download it again" }); return true; }
    if (fair) fair.count(d.size);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": d.size,
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(d.name),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(d.path).on("error", () => res.destroy()).pipe(res);
    return true;
  }

  /* A file for a page's "choose file": the raw bytes, its name in the
     query. The link names the session and is good for a few files. */
  if (what === "put" && method === "POST") {
    const l = links.get(seg[2] || "");
    const sess = l && l.kind === "up" && l.expires > Date.now() && engine.sessions.get(l.key);
    if (!sess || ++l.uses > 20) { send(res, 404, { error: "that upload link has gone — choose the file again" }); return true; }
    const max = (engine.cfg.uploadMaxMB || 50) * 1048576;
    const chunks = [];
    let size = 0, over = false;
    await new Promise((resolve) => {
      req.on("data", (c) => { if (over) return; size += c.length; if (size > max) { over = true; chunks.length = 0; } else chunks.push(c); });
      req.on("end", resolve);
      req.on("error", resolve);
    });
    if (over) { send(res, 413, { error: "that file is over " + engine.cfg.uploadMaxMB + " MB, the most a page can be sent" }); return true; }
    try {
      const id = engine.takeUpload(sess, url.searchParams.get("name") || "file", Buffer.concat(chunks));
      send(res, 201, { id });
    } catch (e) { send(res, 409, { error: e.message }); }
    return true;
  }

  /* status is readable by anyone who can already talk to the relay:
     it says whether the thing is up, not what anyone is doing. */
  if (what === "status" && method === "GET") {
    send(res, 200, overflow ? Object.assign(engine.status(), { helpers: overflow.view() }) : engine.status());
    return true;
  }

  /* The public half of the key passes to helpers are signed with
     (overflow.js). Public, like /runner/pubkey: a helper fetches it
     by itself. */
  if (what === "helper-key" && method === "GET" && overflow) {
    send(res, 200, { key: overflow.keys.publicPem });
    return true;
  }

  /* A download or a page's file on a helper, by the link it gave. */
  if (what === "via" && overflow && /^(file|put)$/.test(seg[3] || "") && seg[4]) {
    overflow.link(seg[2], seg[3] + "/" + seg[4] + (url.search || ""), req, res, fair ? (n) => fair.count(n) : null, send);
    return true;
  }

  const who = authorise(req);
  if (!who) {
    send(res, 401, { error: "sign in to MESSAGES, or unlock the vault, to use the browser" });
    return true;
  }

  if (what === "ticket" && method === "POST") {
    /* Starting the engine here rather than at the socket means the
       "chromium will not start" failure arrives as a JSON error the
       panel can print, instead of as a socket that closes. */
    const ok = await engine.start();
    if (!ok) {
      send(res, 503, { error: "the browser could not start",
        detail: engine.lastFailure || "see the relay log" });
      return true;
    }
    const tier = helpers.tierOf ? helpers.tierOf(req) : (who === "vault" ? "admin" : "guest");
    /* The tier is said so the panel knows to offer admin things (USAGE);
       the relay checks it again on every one of them. */
    send(res, 201, { ticket: issue(who, tier), expiresIn: TICKET_MS / 1000, tier: tier });
    return true;
  }

  /* What the browser costs, for an admin: Chromium, each session, and
     each open panel's bandwidth and encoder. Sampling CPU needs two
     readings, so the panel asks every few seconds while it shows this. */
  if (what === "usage" && method === "GET") {
    const tier = helpers.tierOf ? helpers.tierOf(req) : (who === "vault" ? "admin" : "guest");
    if (tier !== "admin") { send(res, 403, { error: "admins only" }); return true; }
    const u = engine.usage();
    u.viewers = Array.from(viewers).map((v) => v.stats ? v.stats() : null).filter(Boolean);
    u.upKbps = fair && fair.meter ? fair.meter.upKbps || null : null;
    if (overflow) u.helpers = await overflow.usage();
    send(res, 200, u);
    return true;
  }

  if (what === "clear" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const s = engine.sessions.get(String(who));
    const away = !s && overflow ? overflow.holding(who) : null;
    if (away) {
      const what = body && body.what === "cookies" ? "cookies" : "everything";
      try { await overflow.clear(away, who, what); } catch (e) { send(res, 502, { error: "the browser helper is not answering — " + e.message }); return true; }
      send(res, 200, { cleared: what });
      return true;
    }
    if (!s) { send(res, 200, { cleared: "nothing was open" }); return true; }
    if (body && body.what === "cookies") await engine.clearCookies(s);
    else await engine.clearAll(s);
    send(res, 200, { cleared: body && body.what === "cookies" ? "cookies" : "everything" });
    return true;
  }

  send(res, 404, { error: "no such browser route", saw: url.pathname });
  return true;
}

/* ---- the socket -------------------------------------------------- */

function isStreamUpgrade(url) {
  return String(url.pathname || "").replace(/\/+$/, "") === "/browser/stream";
}

async function upgrade(req, sock, head, url) {
  if (!cfg.enabled) { try { sock.destroy(); } catch (e) {} return; }

  const t = take(url.searchParams.get("t"));
  const who = t ? t.who : null, tier = t ? t.tier : null;
  if (!who) {
    try {
      sock.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      setTimeout(() => sock.destroy(), 2000).unref();
    } catch (e) {}
    return;
  }

  /* Here or on a helper (overflow.js). */
  const h = placeOf(String(who), tier);
  if (h) {
    return overflow.pipe(h, req, sock, head, who, tier, fair ? (n) => fair.count(n) : null,
      () => serve(req, sock, head, who, tier, {}).catch(() => { try { sock.destroy(); } catch (e) {} }));
  }
  return serve(req, sock, head, who, tier, {});
}

/* Which helper a new socket for this account goes to, or null for here
   (the order is in overflow.js). */
function placeOf(who, tier) {
  if (!overflow || !overflow.any() || engine.sessions.has(who)) return null;
  const held = overflow.holding(who);
  if (held) return held;
  const free = engine.sessions.size < engine.cfg.maxSessions;
  if (free && (!fair || tier === "admin" || (!fair.someoneAhead(tier) && fair.fits(tier, true)))) return null;
  return overflow.pick(who, tier, fair);
}

/* One panel's socket, served by this process. opts.linkBase is where
   its download and file links point: a helper's go back through the
   relay (/browser/via/<helper>/). */
async function serve(req, sock, head, who, tier, opts) {
  opts = opts || {};
  const linkBase = opts.linkBase || "/browser/";
  const socket = ws.accept(req, sock, { maxPayload: MAX_MSG, pingMs: 25000 });
  if (!socket) return;

  let session = null;
  let alive = true;
  let waiting = null;            /* a place in the browser's line */
  let inputWindow = Date.now();
  let inputCount = 0;

  const tell = (obj) => { if (alive) socket.send(JSON.stringify(obj)); };
  let held = null, heldTimer = null;
  /* Every frame out is counted: it is this relay's use of the home upload. */
  let sent = 0;
  const out = (b) => { sent += b.length; if (fair) fair.count(b.length); return socket.send(b); };
  const feed = (pic) => {
    const tx = viewer.video;
    if (!tx) return out(pic);
    if (socket.sock && socket.sock.writableLength > VIDEO_HIGH) {
      strained();
      held = pic;
      if (!heldTimer) heldTimer = setTimeout(() => { heldTimer = null; const p = held; held = null; if (p && alive) feed(p); }, 100);
      return;
    }
    calm();
    tx.feed(pic);
  };
  /* This viewer's step: { own, strains, at (last step), last (last strain) }. */
  const q = { own: 0, strains: [], at: 0, last: 0 };
  const kbpsNow = () => Math.round((cfg.videoKbps || 1500) * Math.min(fair ? STEPS[fair.step] : STEPS[houseStep] || 1, OWN[q.own]));
  function strained() {
    const now = Date.now();
    if (now - q.last < 500) return;          /* one backed-up spell is one strain */
    q.last = now;
    q.strains = q.strains.filter((t) => now - t < STRAIN_MS).concat(now);
    if (q.strains.length < 3 || q.own >= OWN.length - 1 || now - q.at < OWN_GAP_MS) return;
    q.own++; q.at = now; q.strains = [];
    viewer.restep();
    tell({ t: "quality", step: q.own, kbps: kbpsNow(), why: "your connection" });
    log("INFO", "browser: video for " + who + " down to " + kbpsNow() + " kbit/s to fit their connection");
  }
  function calm() {
    if (!q.own) return;
    const now = Date.now();
    if (now - q.last < OWN_CALM_MS || now - q.at < OWN_CALM_MS) return;
    q.own--; q.at = now;
    viewer.restep();
    tell({ t: "quality", step: q.own, kbps: kbpsNow() });
  }
  const since = Date.now();
  const rate = { sent: 0, at: since };
  const viewer = {
    video: null,       /* the encoder, when this panel asked for video */
    quality: q,
    /* For an admin's USAGE: what this panel has been sent since the
       last time it was asked, and what its encoder is using. */
    stats() {
      const now = Date.now();
      const kbps = now > rate.at ? Math.round((sent - rate.sent) * 8 / (now - rate.at)) : 0;
      rate.sent = sent; rate.at = now;
      const enc = viewer.video && viewer.video.usage ? viewer.video.usage() : null;
      return { who: String(who), tier: tier, sinceSec: Math.round((now - since) / 1000), video: !!viewer.video, sound: !!viewer.sound,
        kbps: kbps, capKbps: viewer.video ? kbpsNow() : null, step: q.own, sentMb: Math.round(sent / 104857.6) / 10,
        encCpu: enc ? enc.cpu : null, encMemMb: enc ? enc.memMb : null };
    },
    restep() {
      if (alive && viewer.video && viewer.video.setKbps(kbpsNow()) && session) engine.refresh(session).catch(() => {});
    },
    onFrame(base64) {
      if (!alive) return;
      /* Binary, not the base64 CDP handed us. One decode here saves
         a third of every frame on the wire. As a picture, the panel
         draws it from a Blob; as video, it goes through the encoder. */
      feed(Buffer.from(base64, "base64"));
    },
    onEvent(msg) {
      /* A finished download and a page asking for a file each carry a
         link of their own, for this panel only. */
      if (msg.t === "download" && msg.state === "completed" && session) {
        msg = Object.assign({}, msg, { url: linkBase + "file/" + linkFor("dl", session.key, msg.id) });
      } else if (msg.t === "choose-file" && session) {
        msg = Object.assign({}, msg, { url: linkBase + "put/" + linkFor("up", session.key, null) });
      }
      tell(msg);
    },
    onGone(why) { tell({ t: "gone", why }); socket.close(1000, why); },
    /* One Opus packet of this session's sound: 2 | packet. Dropped,
       not queued, while the socket is backed up: late sound is worse
       than a gap, and the picture matters more. */
    onAudio(pkt) {
      if (!alive || (socket.sock && socket.sock.writableLength > VIDEO_HIGH)) return;
      out(Buffer.concat([AUDIO_TAG, pkt]));
    }
  };

  viewers.add(viewer);
  socket.on("close", () => {
    alive = false;
    viewers.delete(viewer);
    if (waiting) { fair.leave(waiting); waiting.go(); }
    if (heldTimer) clearTimeout(heldTimer);
    if (viewer.video) { viewer.video.close(); viewer.video = null; }
    if (session) engine.detach(session, viewer).catch(() => {});
  });

  /* Video for this panel, if it can decode it and this relay can make it.
     Each frame goes out as  flags (1 = keyframe) | H.264 access unit,
     after a "video" message giving the size; a failure says
     { t: "video", off: true } and pictures resume. */
  function startVideo() {
    const tx = new Transcoder({ ffmpeg: engine.videoBin, kbps: kbpsNow(), maxFps: 30 });
    tx.on("start", (sz) => tell({ t: "video", w: sz.w, h: sz.h }));
    tx.on("frame", (au, key) => { if (alive) out(Buffer.concat([Buffer.from([key ? 1 : 0]), au])); });
    tx.on("fail", (why) => {
      log("WARN", "browser: video for " + who + " stopped, sending pictures instead — " + why);
      tx.close();
      if (viewer.video === tx) viewer.video = null;
      tell({ t: "video", off: true, why: why });
      if (session) engine.refresh(session).catch(() => {});
    });
    viewer.video = tx;
  }

  /* THE HANDLER GOES ON BEFORE THE AWAIT, AND THIS IS NOT STYLE.

     Getting a session can take a second or two — the first one on a
     cold relay is Chromium starting. The client sends `hello` the
     instant the socket opens, which is inside that window. With the
     listener attached after the await, that message was emitted to
     nobody and silently dropped, and since `hello` is what attaches
     the viewer, the session then ran with no one watching: commands
     worked, navigation happened, and not one frame was ever sent.

     So messages are taken from the first moment they can arrive and
     held until there is something to apply them to. */
  const backlog = [];
  let handle = (m) => backlog.push(m);

  socket.on("message", (data, binary) => {
    if (binary || !alive) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    handle(m);
  });

  /* A NEW session may have to wait its turn (RUNNER_PLAN.md §22);
     someone already browsing never does, nor does an admin. The panel
     is open, so it connects by itself when there is room. */
  if (fair && tier !== "admin" && !engine.sessions.has(String(who))) {
    const room = engine.hasRoom();
    if (fair.someoneAhead(tier) || !fair.fits(tier, room)) {
      const why = fair.someoneAhead(tier) ? "others are already waiting" : fair.why(tier, room);
      try { waiting = fair.join(who, tier); }
      catch (e) { tell({ t: "error", why: e.message }); socket.close(1013, "line full"); return; }
      waiting.tell = (p) => tell(Object.assign({ t: "queued", why: why }, p));
      waiting.tell(fair.place(waiting));
      log("INFO", "browser: " + who + " (" + tier + ") waits for a session — " + why);
      const w = waiting;
      await w.ready;
      waiting = null;
      if (!alive) return;
      /* A helper has room and this relay still has none: the panel
         connects again at once, and that lands it there. */
      if (w.moved) { tell({ t: "moved" }); socket.close(1012, "moved"); return; }
    }
  }

  try {
    session = await engine.sessionFor(who, { over: tier === "admin", tier: tier || "admin" });
  } catch (e) {
    tell({ t: "error", why: e.message });
    socket.close(1011, "no session");
    return;
  }
  if (!alive) return;

  handle = (m) => { onMessage(m).catch(() => {}); };
  for (const m of backlog.splice(0)) handle(m);

  async function onMessage(m) {
    if (!alive) return;

    /* One bucket for the things a person generates continuously.
       Not a security boundary — the socket is already authenticated
       — but a runaway mousemove loop in a page should not be able
       to saturate the container. */
    if (m.t === "mouse" || m.t === "key" || m.t === "find" || m.t === "copy") {
      const now = Date.now();
      if (now - inputWindow > 1000) { inputWindow = now; inputCount = 0; }
      if (++inputCount > INPUT_PER_SEC) return;
    }

    try {
      switch (m.t) {
        case "hello":
          if (m.video && engine.videoBin && !viewer.video) startVideo();
          /* Sound only if the panel asked and can play it; the panel's
             SOUND button changes it later. */
          viewer.sound = !!m.sound;
          await engine.resize(session, m.w, m.h, m.scale);
          await engine.attach(session, viewer);
          tell({ t: "ready", who, url: session.url, title: session.title, video: !!viewer.video, zoom: session.zoom || 1,
            sound: !!(engine.soundOn && session.host) });
          break;
        case "sound":
          tell({ t: "sound", on: engine.setSound(session, viewer, !!m.on) });
          break;
        case "keyframe":
          /* The panel's decoder lost its place: a fresh encoder and a
             fresh picture, which starts with a keyframe. */
          if (viewer.video) strained();
          if (!viewer.video || Date.now() - (viewer.keyAt || 0) < 1000) break;
          viewer.keyAt = Date.now();
          viewer.video.size = null;
          await engine.refresh(session);
          break;

        case "resize":
          await engine.resize(session, m.w, m.h, m.scale);
          break;

        case "nav": {
          const target = normaliseUrl(m.url);
          const go = target || searchUrlFor(m.url);
          const went = await engine.navigate(session, go);
          tell({ t: "nav", url: went, searched: !target });
          break;
        }

        case "back": await engine.back(session); break;
        case "fwd": await engine.forward(session); break;
        case "reload": await engine.reload(session); break;

        case "mouse":
          await engine.mouse(session, m);
          /* The pointer's shape over what is under it. */
          if (m.type === "mouseMoved") {
            const c = await engine.cursorAt(session, m.x, m.y);
            if (c) tell({ t: "cursor", c });
          }
          break;

        /* Tabs (§16). */
        case "tab": await engine.switchTab(session, String(m.id || "")); break;
        case "tab-new": {
          const target = m.url ? (normaliseUrl(m.url) || searchUrlFor(m.url)) : null;
          await engine.openTab(session, target);
          break;
        }
        case "tab-close": await engine.closeTab(session, String(m.id || "")); break;

        /* The files the panel sent for a page's "choose file". */
        case "files":
          tell({ t: "files-set", n: await engine.setFiles(session, m.ids) });
          break;
        case "key": await engine.key(session, m); break;

        case "dialog": await engine.answerDialog(session, m.accept, m.text); break;

        /* Copy, find and zoom act on the real page; the panel only
           has a picture of it. */
        case "copy":
          tell({ t: "copied", text: await engine.copyText(session) });
          /* A cut is a copy first, then the page's own Ctrl-X. */
          if (m.cut) {
            await engine.key(session, { type: "keydown", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 });
            await engine.key(session, { type: "keyup", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 });
          }
          break;
        case "find":
          tell({ t: "found", ok: await engine.find(session, m.text, !!m.back) });
          break;
        case "zoom":
          tell({ t: "zoomed", zoom: await engine.zoom(session, Number(m.zoom) || 1) });
          break;
        case "pause":
          if (m.on && viewer.video) viewer.video.hold();
          if (m.on) held = null;
          await engine.pause(session, viewer, !!m.on);
          break;

        case "clear":
          if (m.what === "cookies") {
            await engine.clearCookies(session);
            tell({ t: "cleared", what: "cookies" });
          } else {
            /* Destroying the context takes this socket's session
               with it, which is correct — "clear everything" that
               left the old page on screen would be a lie. */
            await engine.clearAll(session);
          }
          break;

        default: break;
      }
    } catch (e) {
      tell({ t: "error", why: e.message });
    }
  }
}

function searchUrlFor(text) {
  return String(cfg.searchUrl || "https://lite.duckduckgo.com/lite/?kp=1&q=") +
    encodeURIComponent(String(text || "").trim());
}

/* On a helper: the relay's word on the house video step. */
function setHouseStep(n) {
  n = Math.max(0, Math.min(STEPS.length - 1, n | 0));
  if (n === houseStep) return;
  houseStep = n;
  for (const v of viewers) v.restep();
}

module.exports = {
  init, route, upgrade, isStreamUpgrade, serve, setHouseStep,
  _internals: { tickets, links, linkFor, issue, spend, take, fair: () => fair, viewers, searchUrlFor, sweep,
    engine: () => engine, overflow: () => overflow, placeOf, TICKET_MS, INPUT_PER_SEC }
};
