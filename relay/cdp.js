/* ============================================================
   FieldKit relay :: cdp — talking to Chromium

   A minimal Chrome DevTools Protocol client over the WebSocket in
   ws.js. CDP is a JSON-RPC: every command is {id, method, params}
   and comes back as {id, result} or {id, error}; anything without
   an id is an event.

   THE ONE THING THAT IS NOT OBVIOUS is sessions. A single socket
   carries every target in the browser — each tab, each iframe that
   got its own process, each worker. A command with no sessionId
   goes to the BROWSER (create a context, open a tab, close it). A
   command with one goes to that page. Events come back carrying
   the sessionId they belong to, and routing them is the difference
   between "this user's screencast" and "somebody's screencast".

   Flat mode (`flatten: true` on attach) is what makes that work on
   one socket instead of nested Target.sendMessageToTarget wrapping,
   which is the old shape and is genuinely miserable.

   WHY NOT PUPPETEER. It is the obvious answer and it is the wrong
   one here: it is ~300 MB of node_modules plus its own Chromium
   download, in a container with no shell and a relay that has zero
   dependencies on purpose. What is actually needed is perhaps
   fifteen CDP methods. This is that.
   ============================================================ */
"use strict";

const http = require("http");
const { EventEmitter } = require("events");
const ws = require("./ws");

/* Ask Chromium where its debugger socket is. Also the readiness
   check: Chromium binds the HTTP endpoint only once it is actually
   up, so retrying this IS waiting for launch. */
function version(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: host || "127.0.0.1", port, path: "/json/version",
      headers: { Host: "localhost" } }, (res) => {
      const c = [];
      res.on("data", (x) => c.push(x));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); }
        catch (e) { reject(new Error("chromium answered /json/version with something unparseable")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(4000, () => { req.destroy(new Error("timed out")); });
  });
}

/* `Host: localhost` above is not decoration. Chromium refuses
   DevTools HTTP requests whose Host header is a bare IP, as a
   defence against DNS rebinding reaching the debugger from a web
   page. Node sets Host to the IP by default, so without this the
   endpoint answers 500 and the failure looks like "Chromium did not
   start". */

class CDP extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    sock.on("message", (data, binary) => {
      if (binary) return;
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const e = new Error(msg.error.message || "CDP error");
          e.code = msg.error.code;
          e.method = p.method;
          return p.reject(e);
        }
        return p.resolve(msg.result || {});
      }

      if (msg.method) {
        /* Two shapes on purpose. The bare method name is what
           browser-level code listens for; the sessionId-qualified
           one is how a page's own listener gets only its own
           events without filtering by hand at every call site. */
        this.emit(msg.method, msg.params || {}, msg.sessionId);
        if (msg.sessionId) this.emit(msg.sessionId + ":" + msg.method, msg.params || {});
      }
    });

    sock.on("close", () => this._down("the devtools socket closed"));
    sock.on("error", (e) => this._down(e.message));
  }

  static async open(port, opts) {
    const host = (opts && opts.host) || "127.0.0.1";
    const v = await version(port, host);
    if (!v.webSocketDebuggerUrl) throw new Error("chromium gave no debugger url");

    /* THE URL CHROMIUM HANDS BACK IS NOT USABLE AS GIVEN.

       It builds it from the Host header of the request that asked,
       and the request that asked had to say `Host: localhost` or
       Chromium would have refused it outright (its DNS-rebinding
       defence). So what comes back is
       ws://localhost/devtools/browser/<id> — no port at all — and
       connecting to it lands on port 80 and is refused.

       The path is the only part worth keeping. The address is
       already known: it is the port we launched on, on loopback. */
    let dpath = "/";
    try { dpath = new URL(v.webSocketDebuggerUrl).pathname; }
    catch (e) { throw new Error("chromium gave an unparseable debugger url"); }

    const sock = await ws.connect("ws://" + host + ":" + port + dpath, {
      /* A screencast frame is base64 JPEG inside JSON, so the
         ceiling has to clear a full-page image comfortably. */
      maxPayload: (opts && opts.maxPayload) || 32 * 1024 * 1024,
      pingMs: 20000
    });
    const c = new CDP(sock);
    c.info = v;
    return c;
  }

  send(method, params, sessionId) {
    if (this.closed) return Promise.reject(new Error("cdp is closed"));
    const id = this.nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      /* Every command gets a timeout. A CDP call that never comes
         back is not rare — a page can be mid-navigation, a target
         can die between the check and the call — and without this
         the promise is held forever and so is everything awaiting
         it, which shows up much later as a session that will not
         close. */
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + " did not answer in time"));
      }, 20000);
      if (timer.unref) timer.unref();

      this.pending.set(id, { resolve, reject, timer, method });
      if (!this.sock.send(JSON.stringify(msg))) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("could not write to the devtools socket"));
      }
    });
  }

  /* A session handle: the same API with the id baked in, so page
     code never has to remember to pass it and cannot pass the
     wrong one. */
  session(sessionId) {
    const self = this;
    return {
      id: sessionId,
      send: (m, p) => self.send(m, p, sessionId),
      on: (event, fn) => { self.on(sessionId + ":" + event, fn); return () => self.off(sessionId + ":" + event, fn); },
      off: (event, fn) => self.off(sessionId + ":" + event, fn)
    };
  }

  close() {
    if (this.closed) return;
    try { this.sock.close(1000, "done"); } catch (e) {}
    this._down("closed locally");
  }

  _down(why) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("chromium went away: " + why));
    }
    this.pending.clear();
    this.emit("disconnected", why);
  }
}

module.exports = { CDP, version };
