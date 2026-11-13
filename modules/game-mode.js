/* ============================================================
   FieldKit :: game-mode — GAME MODE
   A library of games and apps, opened from FieldKit or OUTPOST: full
   screen with one thin bar to come back, or in a window like any other
   app. A copy of FieldKit can hold either or both of two libraries:

     games/library/         your own games: any folder of HTML games, made
                            into a library by `node tools/add-games.js`
     games/outlaw-engine/   the Outlaw Engine, the hub of games and apps
                            this was first made for (tools/sync-games.js,
                            or its pack unzipped into games/)

   Your own library is opened first when there is one, and its page links
   to the Outlaw Engine if that is there too. A copy with neither says so
   and says how to add some. (A build can also leave GAME MODE out
   altogether: build.js, --no-game-mode.)

   NOTHING IN A LIBRARY IS CHANGED OR MERGED. It runs in a frame exactly
   as it is in its own folder: its look, its settings and, for the Outlaw
   Engine, its own diagnostics (SYSTEM CHECK, DIAG, FULL SCAN) stay its
   own. FieldKit only finds a copy and opens it.

   WHERE THE COPY COMES FROM, first that works:
     1. DRIVE: the folders above beside FIELDKIT.html or OUTPOST.html,
        put there by `node build.js --deploy`. Found by loading the
        folder's fieldkit-games.js with a <script> tag, which works from
        file:// where fetch does not.
     2. RELAY: the same files on the relay (relay/games.js), for someone
        signed in to MESSAGES or with a gamertag: the relay hands out a
        ticket good for twelve hours and the frame opens that.

   The frame is another origin (another file, or the relay), so a game
   cannot reach FieldKit, its vault or its sign-ins.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var LOCALS = ["games/library/", "games/outlaw-engine/"];   /* your own first */
  var GAMES = "fk.deephold";
  var ctx, el, host = null, gone = true, local = null, localTried = false, relayInfo = null, relayUp = null, note = "", overlay = null;

  /* What the library calls itself: "Outlaw Engine", or the name given to tools/add-games.js. */
  function libName(info) { return String((info && (info.engine || info.name)) || "GAME MODE").slice(0, 40); }

  function ui() { return FieldKit.service("ui"); }
  function relayBase() {
    var st = FieldKit.service("settings");
    var u = String((st && st.get("relayUrl")) || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }
  function msgs() { var m = FieldKit.service("messages"); return m && m.signedIn && m.signedIn() ? m : null; }
  function game() {
    var dh = FieldKit.service("deephold");
    if (dh && dh.session) { var s = dh.session(); if (s) return s; }
    try { var st = JSON.parse(window.localStorage.getItem(GAMES) || "null"); if (st && st.token && st.tag) return { token: st.token, tag: st.tag }; } catch (e) { /* none */ }
    return null;
  }

  /* 1. a copy beside this page? */
  function findIn(folder) {
    return new Promise(function (resolve) {
      var base;
      try { base = new URL(folder, document.baseURI || window.location.href).href; } catch (e) { return resolve(null); }
      if (!/^(file|https?):/.test(base)) return resolve(null);
      var s = document.createElement("script"), done = false;
      try { delete window.FK_GAMES; } catch (e) { window.FK_GAMES = undefined; }
      var finish = function (ok) {
        if (done) return; done = true;
        var hit = ok && window.FK_GAMES ? { url: base + "index.html", info: window.FK_GAMES } : null;
        try { s.parentNode && s.parentNode.removeChild(s); } catch (e) { /* gone */ }
        resolve(hit);
      };
      s.onload = function () { finish(true); };
      s.onerror = function () { finish(false); };
      setTimeout(function () { finish(false); }, 4000);
      s.src = base + "fieldkit-games.js";
      document.head.appendChild(s);
    });
  }
  function indexOf(folder) {
    return new Promise(function (resolve) {
      var base;
      try { base = new URL(folder, document.baseURI || window.location.href).href; } catch (e) { return resolve(null); }
      if (!/^(file|https?):/.test(base)) return resolve(null);
      var s = document.createElement("script"), done = false;
      try { delete window.FK_GAMES_INDEX; } catch (e) { window.FK_GAMES_INDEX = undefined; }
      var finish = function () {
        if (done) return; done = true;
        var v = Array.isArray(window.FK_GAMES_INDEX) ? window.FK_GAMES_INDEX.map(String) : null;
        try { s.parentNode && s.parentNode.removeChild(s); } catch (e) { /* gone */ }
        resolve(v);
      };
      s.onload = finish; s.onerror = finish;
      setTimeout(finish, 4000);
      s.src = base + "fieldkit-index.js";
      document.head.appendChild(s);
    });
  }
  var finding = null;
  function findLocal() {
    if (localTried) return Promise.resolve(local);
    if (!finding) finding = (async function () {
      /* games/fieldkit-index.js says which libraries are there (sync-games.js and add-games.js write it); without it,
         a games pack unzipped by hand, only the engine is looked for. Asking for a folder that is not there was a red
         error in the console every time GAME MODE opened. */
      var idx = await indexOf("games/"), look = idx ? LOCALS.filter(function (f) { return idx.indexOf(f.split("/")[1]) >= 0; }) : ["games/outlaw-engine/"];
      for (var i = 0; i < look.length && !local; i++) local = await findIn(look[i]);
      localTried = true; finding = null;
      return local;
    })();
    return finding;
  }

  /* 2. a ticket from the relay */
  async function relayTicket() {
    var base = relayBase();
    if (!base) throw new Error("no relay is set up (RELAY LINK)");
    var m = msgs(), data = null;
    if (m && m.gamesTicket) data = await m.gamesTicket();
    else {
      var g = game();
      if (!g) { var e0 = new Error("sign in to MESSAGES, or with your gamertag (POOL HALL or DEEPHOLD), to play through the relay"); e0.needsSignIn = true; throw e0; }
      var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 15000);
      try {
        var res = await window.fetch(base + "/games/ticket", { method: "POST", headers: { Authorization: "Bearer " + g.token }, mode: "cors", cache: "no-store", signal: ac.signal });
        var text = await res.text();
        try { data = JSON.parse(text || "{}"); } catch (e) { data = {}; }
        if (!res.ok) { var e1 = new Error(data.error || ("the relay answered " + res.status)); e1.needsSignIn = !!data.needsSignIn; throw e1; }
      } catch (e) { if (e.name === "AbortError") throw new Error("the relay did not answer in time"); throw e; }
      finally { clearTimeout(timer); }
    }
    relayInfo = data.info || relayInfo;
    return { url: base + data.path, info: data.info || null };
  }
  async function relayStatus() {
    var base = relayBase();
    if (!base) return null;
    try {
      var res = await window.fetch(base + "/games/status", { cache: "no-store", mode: "cors" });
      if (!res.ok) return null;
      var j = JSON.parse((await res.text()) || "{}");
      relayUp = !!j.up;
      return j;
    } catch (e) { return null; }
  }
  /* Known for sure that nothing can open: no copy here, and no relay or a relay with none. */
  function empty() { return localTried && !local && (!relayBase() || relayUp === false); }

  /* where to open, or why not */
  async function source() {
    var l = await findLocal();
    if (l) return { url: l.url, info: l.info, from: "DRIVE" };
    var r = await relayTicket();
    return { url: r.url, info: r.info, from: "RELAY" };
  }

  /* ---- the shelf: games kept on this device --------------------------------
     Someone ticks the games they want and they are saved inside this
     browser (IndexedDB), each as one self-contained page (tools/shelf.js
     made them). They play from here with no drive and no relay, and a new
     FIELDKIT.html or OUTPOST.html finds them again, because the shelf
     belongs to the browser, not to the file. They come from:
       - the relay, for someone signed in (the same ticket as the library),
       - a games pack file (OUTLAW-ENGINE-GAMES.zip from the release page),
         read right here: nothing is unzipped by hand.
     Each has a short sha256; when the relay or a newer pack has another,
     the game says UPDATE READY. Removing a game frees its space; its saves
     stay, so getting it again picks up where it was.

     A shelf game runs in a SANDBOXED frame: its own blank origin, so it
     cannot reach FieldKit, its vault or its sign-ins, exactly like a game
     from a drive or the relay. A blank origin has no storage of its own,
     so a small stand-in (shelfShim) gives the game a localStorage seeded
     with the shelf's saves, and every change is handed back here and kept
     in the shelf's own "saves" store. All shelf games share those saves,
     as the games in one folder share one localStorage. */
  var SANDBOX = "allow-scripts allow-pointer-lock allow-modals allow-downloads allow-forms allow-popups allow-popups-to-escape-sandbox";
  var ID_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
  var shelf = { ok: null, games: [], avail: null, from: "", pick: {}, drop: {}, busy: "", used: 0 };
  var live = null;                       /* { frame, id } of the shelf game that is open */

  var dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var r;
      try { if (!window.indexedDB) throw new Error("no IndexedDB"); r = window.indexedDB.open("fk-shelf", 1); } catch (e) { reject(new Error("this browser cannot keep games")); return; }
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore("games", { keyPath: "id" }); d.createObjectStore("files"); d.createObjectStore("saves"); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("this browser cannot keep games here")); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  /* one transaction; fn(stores) may return a request whose result is the answer */
  function tx(names, mode, fn) {
    return idb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(names, mode), st = {}, out, req;
        names.forEach(function (n) { st[n] = t.objectStore(n); });
        req = fn(st);
        t.oncomplete = function () { resolve(req && "result" in req ? req.result : out); };
        t.onerror = t.onabort = function () { reject(t.error || new Error("the shelf could not be written (is this device full?)")); };
      });
    });
  }
  function shelfLoad() {
    return tx(["games"], "readonly", function (s) { return s.games.getAll(); }).then(function (list) {
      shelf.ok = true;
      shelf.games = (list || []).filter(function (g) { return g && ID_RE.test(g.id); }).sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
      shelf.used = shelf.games.reduce(function (n, g) { return n + (g.size || 0); }, 0);
      return shelf.games;
    }, function () { shelf.ok = false; shelf.games = []; return []; });
  }
  function savesAll() {
    return tx(["saves"], "readonly", function (s) {
      var out = {}, c = s.saves.openCursor();
      c.onsuccess = function () { var cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } };
      return { get result() { return out; } };
    });
  }
  var pending = [], flushT = 0;
  function queueSave(op) {
    pending.push(op);
    if (!flushT) flushT = setTimeout(flushSaves, 600);
  }
  function flushSaves() {
    clearTimeout(flushT); flushT = 0;
    if (!pending.length) return Promise.resolve();
    var ops = pending; pending = [];
    return tx(["saves"], "readwrite", function (s) {
      ops.forEach(function (o) { if (o[0] === "set") s.saves.put(o[2], o[1]); else if (o[0] === "del") s.saves.delete(o[1]); else if (o[0] === "clear") s.saves.clear(); });
    }).catch(function () { /* a save that cannot be kept is lost, as a full localStorage would lose it */ });
  }

  /* The stand-in storage, run first inside the sandboxed game. Written as a
     plain function so its text can be put into the page (shelfPage). */
  function shelfShim(seed) {
    "use strict";
    var data = Object.create(null), used = 0, LIMIT = 32 * 1048576;
    Object.keys(seed || {}).forEach(function (k) { data[k] = String(seed[k]); used += k.length + data[k].length; });
    var post = function (m) { m.fkShelf = 1; try { window.parent.postMessage(m, "*"); } catch (e) { /* no host */ } };
    function make(keep) {
      var d = keep ? data : Object.create(null);
      var api = {
        getItem: function (k) { k = String(k); return k in d ? d[k] : null; },
        setItem: function (k, v) {
          k = String(k); v = String(v);
          if (keep) {
            var was = k in d ? k.length + d[k].length : 0;
            if (used - was + k.length + v.length > LIMIT) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
            used += k.length + v.length - was;
          }
          d[k] = v; if (keep) post({ op: "set", k: k, v: v });
        },
        removeItem: function (k) { k = String(k); if (!(k in d)) return; if (keep) used -= k.length + d[k].length; delete d[k]; if (keep) post({ op: "del", k: k }); },
        clear: function () { Object.keys(d).forEach(function (k) { delete d[k]; }); if (keep) { used = 0; post({ op: "clear" }); } },
        key: function (i) { var ks = Object.keys(d); return i >= 0 && i < ks.length ? ks[i] : null; }
      };
      return new Proxy({}, {
        get: function (t, p) {
          if (p === "length") return Object.keys(d).length;
          if (typeof p !== "string") return undefined;
          if (Object.prototype.hasOwnProperty.call(api, p)) return api[p];
          return p in d ? d[p] : undefined;
        },
        set: function (t, p, v) { api.setItem(p, v); return true; },
        deleteProperty: function (t, p) { api.removeItem(p); return true; },
        has: function (t, p) { return typeof p === "string" && (p in d || Object.prototype.hasOwnProperty.call(api, p)); },
        ownKeys: function () { return Object.keys(d); },
        getOwnPropertyDescriptor: function (t, p) { return typeof p === "string" && p in d ? { value: d[p], enumerable: true, configurable: true, writable: true } : undefined; }
      });
    }
    var put = function (o, k, v) { try { Object.defineProperty(o, k, { value: v, configurable: true, enumerable: true }); } catch (e) { /* left as it is */ } };
    put(window, "localStorage", make(true));
    put(window, "sessionStorage", make(false));
    /* a blank origin may not ask for a service worker; say there is none instead of throwing */
    put(navigator, "serviceWorker", { controller: null, ready: new Promise(function () {}), register: function () { return Promise.reject(new Error("not on a shelf")); }, getRegistration: function () { return Promise.resolve(undefined); }, getRegistrations: function () { return Promise.resolve([]); }, addEventListener: function () {} });
    /* one game opening another (Metro Fall to Metro Fall 2) asks FieldKit for it */
    window.FK_SHELF = { open: function (id) { post({ op: "open", id: String(id || "").replace(/\.html?$/, "").split("/").pop() }); } };
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null, h = a ? a.getAttribute("href") || "" : "";
      if (a && !a.target && /^[\w./-]+\.html?$/i.test(h) && !/^[a-z]+:/i.test(h)) { e.preventDefault(); window.FK_SHELF.open(h); }
    }, true);
  }
  /* the game's page with the stand-in first in it */
  function shelfPage(html, seed) {
    var tag = "<script>(" + shelfShim.toString() + ")(" + JSON.stringify(seed || {}).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + ");</script>";
    var m = /<head\b[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
    return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
  }
  function onShelfMessage(e) {
    var d = e.data;
    if (!d || d.fkShelf !== 1 || !live || !live.frame || e.source !== live.frame.contentWindow) return;
    if (d.op === "set" && typeof d.k === "string" && typeof d.v === "string" && d.k.length <= 2048) queueSave(["set", d.k, d.v]);
    else if (d.op === "del" && typeof d.k === "string") queueSave(["del", d.k]);
    else if (d.op === "clear") queueSave(["clear"]);
    else if (d.op === "open" && typeof d.id === "string") {
      var id = d.id.toLowerCase(), had = !!overlay;
      if (shelf.games.some(function (g) { return g.id === id; })) { playShelf(id, had ? "full" : "window"); return; }
      var name = id.replace(/-/g, " ").toUpperCase();
      leave(); note = "! " + name + " is not on this device yet. Tick it under GET GAMES and press DOWNLOAD."; paint();
    }
  }
  try { window.addEventListener("message", onShelfMessage); } catch (e) { /* no window events in a test */ }

  async function playShelf(id, where) {
    note = "OPENING..."; paint();
    try {
      await flushSaves();
      var meta = shelf.games.filter(function (g) { return g.id === id; })[0];
      var html = await tx(["files"], "readonly", function (s) { return s.files.get(id); });
      if (!meta || typeof html !== "string") throw new Error("that game is not on this device any more");
      var src = { doc: shelfPage(html, await savesAll()), id: id, info: { name: meta.title }, from: "SHELF" };
      note = "";
      if (where === "window") { leave(); paint(src); } else { enter(src); paint(); }
    } catch (e) { note = "! " + e.message; paint(); }
  }

  /* -- where games come from: the relay, or a pack file -- */
  function sha16(buf) {
    try {
      if (!window.crypto || !window.crypto.subtle) return Promise.resolve(null);
      return window.crypto.subtle.digest("SHA-256", buf).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("").slice(0, 16);
      }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function cleanList(j) {
    if (!j || j.v !== 1 || !Array.isArray(j.games)) throw new Error("that is not a games shelf list");
    return j.games.filter(function (g) { return g && ID_RE.test(g.id) && /^[0-9a-f]{16}$/.test(g.sha) && g.file === g.id + ".html"; }).map(function (g) {
      return { id: g.id, title: String(g.title || g.id).slice(0, 80), desc: String(g.desc || "").slice(0, 400), group: g.group === "APPS" ? "APPS" : "GAMES", section: String(g.section || "").slice(0, 60), size: Math.max(0, +g.size || 0), sha: g.sha, file: g.file };
    });
  }
  async function fromRelay() {
    var t = await relayTicket();
    /* the library the ticket opens (an own library, or the engine), then the engine beside it */
    var dir = t.url.replace(/index\.html$/, ""), root = t.url.replace(/(library\/)?index\.html$/, "");
    var tries = [dir + "shelf/"], all = [], bases = {}, last = null;
    if (tries.indexOf(root + "outlaw-engine/shelf/") < 0) tries.push(root + "outlaw-engine/shelf/");
    for (var i = 0; i < tries.length; i++) {
      try {
        var res = await window.fetch(tries[i] + "shelf.json", { cache: "no-store", mode: "cors", referrerPolicy: "no-referrer" });
        if (!res.ok) continue;
        cleanList(JSON.parse(await res.text())).forEach(function (g) { if (!bases[g.id]) { bases[g.id] = tries[i]; all.push(g); } });
      } catch (e) { last = e; }
    }
    if (!all.length) throw last || new Error("the relay's games have no shelf yet (its owner runs node tools/sync-games.js or tools/add-games.js, and rebuilds the relay)");
    return { from: "THE RELAY", games: all, get: function (g) { return window.fetch(bases[g.id] + g.file, { cache: "no-store", mode: "cors", referrerPolicy: "no-referrer" }).then(function (r) { if (!r.ok) throw new Error("the relay answered " + r.status + " for " + g.title); return r.arrayBuffer(); }); } };
  }
  /* A zip read in the page: its list at the end, then only the files asked for. */
  function readZip(ab) {
    var u8 = new Uint8Array(ab), dv = new DataView(ab), end = -1, dec = new TextDecoder();
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error("that file is not a zip");
    var n = dv.getUint16(end + 10, true), p = dv.getUint32(end + 16, true), files = {};
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("that zip is damaged");
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el2 = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      files[dec.decode(u8.subarray(p + 46, p + 46 + nl))] = { method: method, csize: csize, off: off };
      p += 46 + nl + el2 + cl;
    }
    return {
      names: Object.keys(files),
      get: function (name) {
        var f = files[name];
        if (!f) return Promise.reject(new Error("not in the zip: " + name));
        var at = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true), body = u8.slice(at, at + f.csize);
        if (f.method === 0) return Promise.resolve(body.buffer);
        if (f.method !== 8 || typeof DecompressionStream !== "function") return Promise.reject(new Error("this browser cannot open that zip"));
        return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      }
    };
  }
  async function fromPack(file) {
    var z = readZip(await file.arrayBuffer());
    var list = z.names.filter(function (n) { return /(^|\/)shelf\/shelf\.json$/.test(n); }).sort(function (a, b) { return a.length - b.length; })[0];
    if (!list) throw new Error("that zip has no games shelf in it: use OUTLAW-ENGINE-GAMES.zip from FieldKit 0.20.0 or later");
    var dir = list.slice(0, list.length - "shelf.json".length);
    var games = cleanList(JSON.parse(new TextDecoder().decode(await z.get(list))));
    return { from: "THE PACK FILE", games: games, get: function (g) { return z.get(dir + g.file); } };
  }
  async function getAvail(how, file) {
    shelf.busy = how === "relay" ? "ASKING THE RELAY..." : "READING THE PACK..."; note = ""; paint();
    try {
      var a = how === "relay" ? await fromRelay() : await fromPack(file);
      shelf.avail = a; shelf.pick = {};
      a.games.forEach(function (g) { if (!have(g.id)) shelf.pick[g.id] = false; });
    } catch (e) { note = "! " + e.message; if (e.needsSignIn) shelf.needsSignIn = true; }
    shelf.busy = ""; paint();
  }
  function have(id) { return shelf.games.filter(function (g) { return g.id === id; })[0] || null; }
  function newer(g) { var h = have(g.id); return !!(h && h.sha !== g.sha); }
  async function download(list) {
    if (!shelf.avail || !list.length) return;
    var a = shelf.avail, done = 0, failed = [];
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      shelf.busy = "DOWNLOADING " + (i + 1) + " OF " + list.length + ": " + g.title.toUpperCase(); paint();
      try {
        var buf = await a.get(g), sum = await sha16(buf);
        if (sum && sum !== g.sha) throw new Error("it did not arrive whole");
        var html = new TextDecoder().decode(buf), meta = { id: g.id, title: g.title, desc: g.desc, group: g.group, section: g.section, size: buf.byteLength, sha: g.sha, from: a.from, at: Date.now() };
        await tx(["games", "files"], "readwrite", function (s) { s.games.put(meta); s.files.put(html, g.id); });
        done++;
      } catch (e) { failed.push(g.title + " (" + e.message + ")"); }
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* asked once is enough */ }
    await shelfLoad();
    shelf.busy = ""; shelf.pick = {};
    note = failed.length ? "! " + done + " kept; not kept: " + failed.join("; ") : done + (done === 1 ? " GAME IS" : " GAMES ARE") + " NOW ON THIS DEVICE.";
    paint();
  }
  async function removeGames(ids) {
    if (!ids.length) return;
    var ok = !window.confirm || window.confirm("Remove " + ids.length + (ids.length === 1 ? " game" : " games") + " from this device? Their saves stay, so getting them again picks up where you were.");
    if (!ok) return;
    await tx(["games", "files"], "readwrite", function (s) { ids.forEach(function (id) { s.games.delete(id); s.files.delete(id); }); }).catch(function () {});
    shelf.drop = {};
    await shelfLoad();
    note = ids.length + (ids.length === 1 ? " GAME" : " GAMES") + " REMOVED."; paint();
  }
  function mb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  /* quietly see whether the relay has newer copies of what is kept here */
  function quietCheck() {
    if (!shelf.games.length || shelf.avail || !relayBase() || (!msgs() && !game())) return;
    fromRelay().then(function (a) { shelf.avail = a; shelf.pick = {}; paint(); }, function () { /* later */ });
  }

  /* -- the shelf's part of the panel -- */
  function paintShelf(body) {
    if (shelf.ok === false) {
      body.appendChild(el("p", { class: "gx-p dim", text: "This browser cannot keep games on the device (private window, or storage turned off), so they open from a drive or the relay instead." }));
      return;
    }
    var kept = shelf.games;
    if (kept.length) {
      var ups = shelf.avail ? shelf.avail.games.filter(newer) : [];
      var dropIds = Object.keys(shelf.drop).filter(function (k) { return shelf.drop[k]; });
      body.appendChild(el("div", { class: "gx-h" }, [
        el("span", { text: "ON THIS DEVICE · " + kept.length + (kept.length === 1 ? " GAME" : " GAMES") + " · " + mb(shelf.used) }),
        ups.length ? el("button", { class: "gx-btn hot", type: "button", text: "⟳ UPDATE ALL (" + ups.length + ")", disabled: !!shelf.busy, onclick: function () { download(ups); } }) : null,
        dropIds.length ? el("button", { class: "gx-btn", type: "button", text: "✕ REMOVE SELECTED (" + dropIds.length + ")", onclick: function () { removeGames(dropIds); } }) : null
      ].filter(Boolean)));
      var grid = el("div", { class: "gx-shelf" });
      kept.forEach(function (g) {
        var up = shelf.avail && shelf.avail.games.filter(function (a) { return a.id === g.id && a.sha !== g.sha; })[0];
        var box = el("input", { type: "checkbox", title: "select to remove", onchange: function () { shelf.drop[g.id] = !!box.checked; paint(); } });
        box.checked = !!shelf.drop[g.id];
        grid.appendChild(el("div", { class: "gx-card" + (up ? " up" : "") }, [
          el("div", { class: "gx-card-t", text: g.title }),
          el("div", { class: "gx-card-s", text: (g.section || g.group || "") + " · " + mb(g.size || 0) + (up ? " · UPDATE READY" : "") }),
          el("div", { class: "gx-row" }, [
            el("button", { class: "gx-play sm", type: "button", text: "▶ PLAY", onclick: function () { playShelf(g.id, "full"); } }),
            el("button", { class: "gx-btn", type: "button", text: "IN A WINDOW", onclick: function () { playShelf(g.id, "window"); } }),
            up ? el("button", { class: "gx-btn hot", type: "button", text: "⟳ UPDATE", onclick: function () { download([up]); } }) : null,
            el("label", { class: "gx-sel" }, [box, el("span", { text: "remove" })])
          ].filter(Boolean))
        ]));
      });
      body.appendChild(grid);
    }
    /* GET GAMES */
    var input = el("input", { type: "file", accept: ".zip,application/zip", class: "gx-file", onchange: function () { var f = input.files && input.files[0]; if (f) getAvail("pack", f); input.value = ""; } });
    body.appendChild(el("div", { class: "gx-h" }, [el("span", { text: kept.length ? "GET MORE GAMES" : "GET GAMES ONTO THIS DEVICE" })]));
    body.appendChild(el("p", { class: "gx-p", text: "Pick the games you want and they are kept in this browser: they play with no drive and no relay, stay through FieldKit updates, and can be removed one at a time." }));
    body.appendChild(el("div", { class: "gx-row" }, [
      relayBase() ? el("button", { class: "gx-btn", type: "button", text: "FROM MY RELAY", disabled: !!shelf.busy, onclick: function () { getAvail("relay"); } }) : null,
      el("label", { class: "gx-btn" }, [el("span", { text: "FROM A GAMES PACK FILE (.zip)" }), input])
    ].filter(Boolean)));
    if (!relayBase()) body.appendChild(el("p", { class: "gx-p dim", text: "The pack file is OUTLAW-ENGINE-GAMES.zip on the FieldKit release page (github.com/Sup095/Outlaw-Fieldkit/releases). Download it, then pick it here; nothing has to be unzipped." }));
    if (shelf.busy) body.appendChild(el("p", { class: "gx-p", text: shelf.busy }));
    if (shelf.avail) {
      var a = shelf.avail, fresh = a.games.filter(function (g) { return !have(g.id); });
      var chosen = fresh.filter(function (g) { return shelf.pick[g.id]; }), size = chosen.reduce(function (n, g) { return n + g.size; }, 0);
      body.appendChild(el("div", { class: "gx-h" }, [
        el("span", { text: "FROM " + a.from + ": " + a.games.length + " · " + (fresh.length ? fresh.length + " NOT ON THIS DEVICE" : "ALL ON THIS DEVICE") }),
        fresh.length ? el("button", { class: "gx-btn", type: "button", text: chosen.length === fresh.length ? "SELECT NONE" : "SELECT ALL", onclick: function () { var all = chosen.length !== fresh.length; fresh.forEach(function (g) { shelf.pick[g.id] = all; }); paint(); } }) : null,
        chosen.length ? el("button", { class: "gx-play sm", type: "button", text: "⬇ DOWNLOAD " + chosen.length + " (" + mb(size) + ")", disabled: !!shelf.busy, onclick: function () { download(chosen); } }) : null
      ].filter(Boolean)));
      var lst = el("div", { class: "gx-avail" });
      a.games.forEach(function (g) {
        var h = have(g.id), cb = el("input", { type: "checkbox", disabled: !!h, onchange: function () { shelf.pick[g.id] = !!cb.checked; paint(); } });
        cb.checked = !!h || !!shelf.pick[g.id];
        lst.appendChild(el("label", { class: "gx-av" + (h ? " have" : ""), title: g.desc }, [
          cb, el("span", { class: "gx-av-t", text: g.title }),
          el("span", { class: "gx-av-s", text: (h ? (h.sha !== g.sha ? "UPDATE READY" : "ON THIS DEVICE") : g.section) + " · " + mb(g.size) })
        ]));
      });
      body.appendChild(lst);
    }
  }

  /* ---- full screen: the engine and one thin bar --------------------------- */
  /* a frame for a source: a drive or relay address, or a shelf game's page in a sandbox */
  function frameFor(src) {
    var frame = document.createElement("iframe");
    frame.className = "gx-frame";
    frame.setAttribute("title", libName(src.info));
    frame.setAttribute("allow", "fullscreen; autoplay; gamepad; clipboard-write");
    frame.setAttribute("referrerpolicy", "no-referrer");
    if (src.doc != null) {
      frame.setAttribute("sandbox", SANDBOX);
      frame.srcdoc = src.doc;
      live = { frame: frame, id: src.id };
    } else frame.src = src.url;
    return frame;
  }
  function enter(src) {
    leave();
    css();
    el = el || ui().el;
    var frame = frameFor(src);
    var back = el("button", { class: "gx-btn", type: "button", text: "◂ BACK TO " + appName(), onclick: function () { leave(); } });
    var fs = el("button", { class: "gx-btn", type: "button", text: "⛶ FULL SCREEN", onclick: function () { toggleFull(); } });
    var bar = el("div", { class: "gx-bar" }, [
      back,
      el("span", { class: "gx-title", text: libName(src.info).toUpperCase() + (src.info && src.info.version ? " v" + src.info.version : "") + (src.info ? " · GAME MODE" : "") }),
      el("span", { class: "gx-from", text: src.from === "DRIVE" ? "FROM THIS DRIVE" : src.from === "SHELF" ? "ON THIS DEVICE" : "THROUGH THE RELAY" }),
      fs
    ]);
    overlay = el("div", { class: "gx-overlay" }, [bar, frame]);
    overlay.addEventListener("keydown", function (e) { if (e.key === "Escape" && e.target === overlay) leave(); });
    document.body.appendChild(overlay);
    try { overlay.requestFullscreen && overlay.requestFullscreen().catch(function () { /* the bar is enough */ }); } catch (e) { /* not allowed here */ }
    setTimeout(function () { try { frame.focus(); } catch (e) { /* fine */ } }, 50);
  }
  function leave() {
    if (!overlay) return;
    try { if (document.fullscreenElement === overlay && document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) { /* fine */ }
    var f = overlay.querySelector ? overlay.querySelector("iframe") : null;
    if (f) { if (f.srcdoc) f.removeAttribute("srcdoc"); f.src = "about:blank"; }   /* stops the game and its sound */
    if (live && live.frame === f) { live = null; flushSaves(); }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }
  function toggleFull() {
    if (!overlay) return;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (overlay.requestFullscreen) overlay.requestFullscreen();
    } catch (e) { /* not here */ }
  }
  function appName() {
    var b = FieldKit.service("boot");
    return b && b.OUTPOST ? "OUTPOST" : "FIELDKIT";
  }

  /* ---- the panel ----------------------------------------------------------- */
  async function go(where) {
    note = "OPENING..."; paint();
    try {
      var src = await source();
      note = "";
      if (where === "window") {
        paint(src);
      } else { enter(src); paint(); }
    } catch (e) {
      note = "! " + e.message;
      paint(null, !!e.needsSignIn);
    }
  }

  function paint(inWindow, wantSignIn) {
    if (!host || gone) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    var root = el("div", { class: "gx-root" });
    host.appendChild(root);
    if (inWindow) {
      var fr = frameFor(inWindow);
      root.appendChild(el("div", { class: "gx-bar" }, [
        el("button", { class: "gx-btn", type: "button", text: "◂ BACK", onclick: function () { if (live && live.frame === fr) { live = null; flushSaves(); } paint(); } }),
        el("span", { class: "gx-title", text: libName(inWindow.info).toUpperCase() + (inWindow.info ? " · GAME MODE" : "") }),
        el("button", { class: "gx-btn", type: "button", text: "⛶ GO FULL SCREEN", onclick: function () { enter(inWindow); paint(); } })
      ]));
      root.appendChild(fr);
      return;
    }
    if (live && !overlay) { live = null; flushSaves(); }
    var info = (local && local.info) || relayInfo;
    var body = el("div", { class: "gx-body" });
    root.appendChild(body);
    var outlaw = !info || /^outlaw engine$/i.test(libName(info));
    body.appendChild(el("div", { class: "gx-logo", text: libName(info).toUpperCase() }));
    body.appendChild(el("div", { class: "gx-sub", text: (info ? "GAME MODE · " : "") + "YOUR GAMES AND APPS" + (info && info.version ? " · v" + info.version : "") }));
    if (note && (shelf.games.length || empty())) body.appendChild(el("p", { class: note.charAt(0) === "!" ? "gx-warn" : "gx-p", text: note }));
    paintShelf(body);
    if (empty()) {
      if (shelf.games.length) return;
      /* Nothing to open, and it is known: say so, and say how games get here. */
      body.appendChild(el("div", { class: "gx-h" }, [el("span", { text: "THE WHOLE LIBRARY" })]));
      body.appendChild(el("p", { class: "gx-warn", text: "THERE ARE NO GAMES IN THIS COPY YET." }));
      body.appendChild(el("p", { class: "gx-p", text: "GAME MODE opens a library of games from a games folder beside this file (a FieldKit drive), or from your relay while you are signed in. This copy has neither" + (relayBase() ? ": the relay answered that it has none." : ", and no relay is set up (RELAY LINK).") }));
      body.appendChild(el("p", { class: "gx-p", text: "To add some, whoever builds your FieldKit runs  node tools/add-games.js <a folder of HTML games>  and then builds the drive or the relay again. The README's GAME MODE part has the steps." }));
      body.appendChild(el("div", { class: "gx-row" }, [
        el("button", { class: "gx-btn", type: "button", text: "LOOK AGAIN", onclick: function () { localTried = false; local = null; relayUp = null; note = "LOOKING..."; paint(); findLocal().then(function () { return local ? null : relayStatus(); }).then(function () { note = ""; paint(); }); } })
      ]));
      return;
    }
    body.appendChild(el("div", { class: "gx-h" }, [el("span", { text: "THE WHOLE LIBRARY" + (info && info.library ? "" : "") })]));
    body.appendChild(el("div", { class: "gx-row" }, [
      el("button", { class: "gx-play", type: "button", text: "▶ ENTER GAME MODE", onclick: function () { go("full"); } }),
      el("button", { class: "gx-btn", type: "button", text: "PLAY IN THIS WINDOW", onclick: function () { go("window"); } })
    ]));
    var where = local ? "Opens from this drive (the games folder beside this file)." : localTried ? "No copy on this drive, so it opens through the relay while you are signed in." : "";
    if (where) body.appendChild(el("p", { class: "gx-p", text: where }));
    if (note && !shelf.games.length) body.appendChild(el("p", { class: note.charAt(0) === "!" ? "gx-warn" : "gx-p", text: note }));
    if (wantSignIn || shelf.needsSignIn) {
      shelf.needsSignIn = false;
      body.appendChild(el("div", { class: "gx-row" }, [
        el("button", { class: "gx-btn", type: "button", text: "SIGN IN TO MESSAGES", onclick: async function () { var m = FieldKit.service("messages"); if (m && m.promptSignIn) { try { await m.promptSignIn("for GAME MODE"); } catch (e) { /* closed */ } } note = ""; paint(); } }),
        el("button", { class: "gx-btn", type: "button", text: "GET A GAMERTAG (POOL HALL)", onclick: function () { var sh = FieldKit.service("shell"); if (sh && sh.open) sh.open("pool"); } })
      ]));
    }
    if (info && info.library && info.library.sections) {
      body.appendChild(el("div", { class: "gx-count", text: [["games", "GAMES"], ["apps", "APPS"], ["workshop", "WORKSHOP"], ["legacy", "LEGACY"]]
        .filter(function (k) { return info.library[k[0]] > 0; }).map(function (k) { return info.library[k[0]] + " " + k[1]; }).join(" · ") }));
      var list = el("div", { class: "gx-lib" });
      info.library.sections.forEach(function (s) {
        if (s.group === "LEGACY") return;
        list.appendChild(el("div", { class: "gx-sec" }, [
          el("div", { class: "gx-sec-h", text: s.label }),
          el("div", { class: "gx-sec-t", text: s.titles.join(" · ") })
        ]));
      });
      body.appendChild(list);
    }
    body.appendChild(el("p", { class: "gx-p dim", text: outlaw
      ? "Everything inside is the Outlaw Engine as it is: its own look, settings and SYSTEM CHECK. In full screen, the bar at the top brings you back. © Outlaw Systems."
      : "Everything inside is this copy's own library, as it was added (tools/add-games.js). Each game keeps its own look and saves. In full screen, the bar at the top brings you back." }));
  }

  function css() {
    if (document.getElementById("gx-css")) return;
    var s = document.createElement("style"); s.id = "gx-css";
    s.textContent = [
      ".gx-overlay{position:fixed;inset:0;z-index:2147483000;background:#000;display:flex;flex-direction:column}",
      ".gx-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#020604;color:#7dffa0;font-family:Consolas,'Courier New',monospace;overflow:hidden}",
      ".gx-bar{display:flex;align-items:center;gap:10px;height:30px;padding:0 8px;background:#020a05;border-bottom:1px solid #1d5a2e;color:#5fe08a;font:12px Consolas,'Courier New',monospace;flex:none}",
      ".gx-title{flex:1;letter-spacing:.25em;text-shadow:0 0 6px rgba(80,255,140,.5)}.gx-from{color:#3a8a55;font-size:10px;letter-spacing:.15em}",
      ".gx-btn{font:inherit;font-size:11px;letter-spacing:.12em;background:#03140a;color:#7dffa0;border:1px solid #1d5a2e;padding:4px 10px;cursor:pointer}",
      ".gx-btn:hover,.gx-play:hover{background:#0a2a15;border-color:#4fe07f}",
      ".gx-frame{flex:1;width:100%;border:0;background:#000;display:block}",
      ".gx-body{flex:1;overflow:auto;padding:22px;display:flex;flex-direction:column;gap:12px;background:radial-gradient(ellipse at 50% 0,#06200f,#020604 70%)}",
      ".gx-logo{font-size:30px;letter-spacing:.35em;font-weight:bold;color:#8dffaf;text-shadow:0 0 14px rgba(80,255,140,.6)}",
      ".gx-sub{letter-spacing:.2em;font-size:11px;color:#4fbf72}",
      ".gx-row{display:flex;gap:8px;flex-wrap:wrap}",
      ".gx-play{font:inherit;font-size:15px;letter-spacing:.2em;padding:10px 20px;background:#063018;color:#b0ffc8;border:1px solid #4fe07f;cursor:pointer;box-shadow:0 0 12px rgba(80,255,140,.25)}",
      ".gx-p{margin:0;color:#5fbf80;line-height:1.5;font-size:12px}.gx-p.dim{color:#3a7a52;font-size:11px}.gx-warn{margin:0;color:#ffb07a;font-size:12px}",
      ".gx-count{letter-spacing:.18em;font-size:11px;color:#8dffaf;margin-top:6px}",
      ".gx-lib{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}",
      ".gx-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-bottom:4px;border-bottom:1px solid #154a26;letter-spacing:.18em;font-size:11px;color:#e8d070}.gx-h span{flex:1;min-width:180px}",
      ".gx-btn.hot{border-color:#e8d070;color:#ffe9a0}.gx-btn[disabled],.gx-play[disabled]{opacity:.5;cursor:default}.gx-play.sm{font-size:12px;padding:5px 12px;letter-spacing:.14em}",
      "label.gx-btn{display:inline-flex;align-items:center;position:relative;overflow:hidden}.gx-file{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%}",
      ".gx-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}",
      ".gx-card{border:1px solid #1d5a2e;background:rgba(0,24,10,.7);padding:9px;display:flex;flex-direction:column;gap:6px}.gx-card.up{border-color:#8a7a30}",
      ".gx-card-t{font-size:14px;color:#b0ffc8;letter-spacing:.06em}.gx-card-s{font-size:10px;color:#4f9f6a;letter-spacing:.12em}",
      ".gx-sel{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:#3a8a55;margin-left:auto;cursor:pointer}",
      ".gx-avail{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:4px}",
      ".gx-av{display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid #123d20;background:rgba(0,16,6,.6);cursor:pointer;font-size:12px}.gx-av.have{opacity:.6;cursor:default}",
      ".gx-av-t{flex:1;color:#9dffbb}.gx-av-s{font-size:10px;color:#4f9f6a;letter-spacing:.08em;text-align:right}",
      "@media (max-width:560px){.gx-body{padding:12px}.gx-logo{font-size:22px}.gx-shelf,.gx-avail{grid-template-columns:1fr}}",
      ".gx-sec{border:1px solid #154a26;background:rgba(0,20,8,.6);padding:8px}.gx-sec-h{font-size:10px;letter-spacing:.18em;color:#e8d070;margin-bottom:4px}.gx-sec-t{font-size:11px;color:#6fd890;line-height:1.5}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function selfcheck() {
    return [{ name: "GAME MODE CAN FIND THE GAMES", critical: false, run: async function () {
      var kept = await shelfLoad();
      var l = await findLocal();
      if (!l && kept.length) return kept.length + " kept on this device (GAME MODE's shelf)" + (relayBase() ? "; the whole library opens through the relay" : "");
      if (l) return (kept.length ? kept.length + " kept on this device; " : "") + "on this drive: " + libName(l.info) + (l.info.version ? " v" + l.info.version : "") + ", " + (l.info.files || "?") + " files";
      var r = await relayStatus();
      if (r && r.up) return "not on this drive; the relay has them (" + (r.name || "Outlaw Engine") + (r.version ? " v" + r.version : "") + ") for signed-in people";
      if (!relayBase()) return "no games on this drive and no relay set up: GAME MODE says so and how to add some (tools/add-games.js)";
      throw new Error("SKIPPED — no games on this drive, and this relay has none (tools/add-games.js adds some)");
    } }];
  }

  FieldKit.provide("gameMode", { _source: source, _enter: enter, _leave: leave, _local: findLocal, _open: function () { return !!overlay; },
    _shelfShim: shelfShim, _shelfPage: shelfPage, _readZip: readZip, _cleanList: cleanList, _shelf: shelf, SANDBOX: SANDBOX });

  FieldKit.register("game-mode", {
    title: "GAME MODE",
    icon: "▶",
    group: "GAMES",
    about: "Your library of games and apps, full screen",
    keywords: "game mode games outlaw engine arcade play library apps steam console fullscreen own",
    width: 980,
    height: 700,
    guestSafe: true,
    selfcheck: selfcheck,
    async mount(h, context) {
      ctx = context; el = ctx.ui.el; host = h; gone = false; note = "";
      css();
      paint();
      shelfLoad().then(function () { paint(); quietCheck(); });
      await findLocal();
      if (!local) relayStatus().then(function (r) { if (r && r.up && !relayInfo) relayInfo = { engine: r.name || "Outlaw Engine", version: r.version, library: null }; paint(); });
      paint();
    },
    unmount() { gone = true; host = null; }
  });
})(window.FieldKit);
