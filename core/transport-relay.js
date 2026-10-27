/* ============================================================
   FieldKit :: transport-relay
   Talks to the Pterodactyl relay. Same interface as
   transport-local, so store.js does not care which one it got.

   The relay only ever receives ciphertext plus the plaintext
   metadata sync needs (id, type, updatedAt). See §9C.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var baseUrl = "";
  var token = null;           // hex(authKey), set by store after unlock
  var provisionToken = "";
  var lastError = null;

  function url(p) { return baseUrl.replace(/\/$/, "") + p; }

  function authHeaders(extra) {
    var h = Object.assign({ "Content-Type": "application/json" }, extra || {});
    if (token) h["Authorization"] = "Bearer " + token;
    return h;
  }

  /* Every request is time-boxed. A hung relay must degrade to
     offline mode quickly, not hold the boot sequence open. */
  async function call(method, p, body, opts) {
    opts = opts || {};
    if (!baseUrl) throw new Error("relay url is not configured");

    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, opts.timeout || 8000);
    try {
      var res = await fetch(url(p), {
        method: method,
        headers: authHeaders(opts.headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
        cache: "no-store",
        mode: "cors"
      });
      var text = await res.text();
      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }

      if (!res.ok) {
        var err = new Error((data && data.error) || ("relay returned " + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      lastError = null;
      return data;
    } catch (e) {
      if (e.name === "AbortError") {
        lastError = "timeout";
        throw new Error("relay timed out after " + (opts.timeout || 8000) + "ms");
      }
      /* Kept on the error rather than only in the message, because
         callers that need to tell "rate limited" from "broken" —
         the self-test above, most of all — should not have to
         pattern-match English to do it. */
      if (e.status === 429 && e.data && e.data.detail) e.message += " — " + e.data.detail;
      lastError = e.message;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  var RelayTransport = {
    name: "relay",
    label: "PTERODACTYL RELAY",

    configure: function (u, opts) {
      baseUrl = u || "";
      if (opts && typeof opts.provisionToken === "string") provisionToken = opts.provisionToken;
      return baseUrl;
    },

    setToken: function (t) { token = t || null; },

    /* BROWSER (§14.3) needs something an iframe can put in a URL,
       and the vault token is not it. This does the exchange here so
       the token stays behind this module — a `token()` getter would
       have been two lines shorter and would have put the credential
       that reads the vault into a second place for no reason. */
    async browseTicket() {
      return call("POST", "/browse/ticket", undefined, { timeout: 8000 });
    },

    /* The streamed browser (§14.11) trades the same credential for a
       different, shorter-lived ticket: this one names an ACCOUNT and
       opens a websocket, where the browse one named a proxy session.
       Separate route so that turning one browser off does not hand
       out passes for the other. */
    async streamTicket() {
      return call("POST", "/browser/ticket", undefined, { timeout: 20000 });
    },

    /* A page as DATA rather than as a page — title, readable text,
       links — and a search the same way. These are what let a
       CritterScript line read the web, which the drive cannot do at
       all: file:// has no cross-origin fetch, so without the relay
       there is no length of code that reads one line of anything.

       They authenticate with the vault token like every other call
       here rather than trading for a browse ticket, because nothing
       renders them — no iframe is involved, so no credential has to
       survive being put in a URL. Generous timeouts: the relay is
       fetching somebody else's server before it can answer. */
    async browseText(target) {
      return call("GET", "/browse/text?url=" + encodeURIComponent(String(target)),
        undefined, { timeout: 35000 });
    },

    async browseFind(q) {
      return call("GET", "/browse/find?q=" + encodeURIComponent(String(q)),
        undefined, { timeout: 45000 });
    },

    /* UPDATE (§14.4). Same reasoning as browseTicket: the token
       stays behind this module. */
    async updateLatest() {
      return call("GET", "/updates/latest", undefined, { timeout: 15000 });
    },

    /* Bytes, not JSON — this is a whole build. `call` parses every
       response as text and would corrupt nothing here (the payload
       is HTML) but would also cost a full extra copy of a 1.4 MB
       string, so it goes straight to fetch with the same header. */
    async updateFile(name) {
      if (!baseUrl) throw new Error("relay url is not configured");
      var res = await fetch(url("/updates/file?name=" + encodeURIComponent(name)), {
        method: "GET", headers: authHeaders(), cache: "no-store", mode: "cors"
      });
      if (!res.ok) {
        var text = await res.text();
        var data = null;
        try { data = JSON.parse(text); } catch (e) { /* not json, use the status */ }
        var err = new Error((data && data.error) || ("relay returned " + res.status));
        err.status = res.status;
        throw err;
      }
      return await res.arrayBuffer();
    },

    url: function () { return baseUrl; },
    lastError: function () { return lastError; },

    async ping() {
      if (!baseUrl) return false;
      try {
        var h = await call("GET", "/health", undefined, { timeout: 4000 });
        return !!(h && h.up);
      } catch (e) {
        return false;
      }
    },

    async health() {
      return call("GET", "/health", undefined, { timeout: 4000 });
    },

    async loadHeader() {
      /* Unauthenticated on purpose — the header is what lets the
         client derive the token in the first place. */
      try {
        return await call("GET", "/vault");
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    async saveHeader(header) {
      /* First write provisions the vault and needs the one-time
         provision token. Later writes are password changes and
         authenticate normally. */
      try {
        await call("PUT", "/vault", header);
        return header;
      } catch (e) {
        if (e.status !== 401 && e.status !== 404 && e.status !== 400) throw e;
        if (!provisionToken) {
          throw new Error("relay has no vault and no provision token was supplied");
        }
        await call("POST", "/vault", header, { headers: { "X-FieldKit-Provision": provisionToken } });
        return header;
      }
    },

    async listRecords() {
      return (await call("GET", "/records")) || [];
    },

    async getRecord(id) {
      try { return await call("GET", "/records/" + encodeURIComponent(id)); }
      catch (e) { if (e.status === 404) return null; throw e; }
    },

    async putRecord(rec) {
      await call("PUT", "/records/" + encodeURIComponent(rec.id), rec, { timeout: 15000 });
      return rec;
    },

    async deleteRecord(id) {
      await call("DELETE", "/records/" + encodeURIComponent(id));
      return true;
    },

    /* ---- blobs: raw encrypted chunks ----
       These bypass call() entirely, because call() JSON-stringifies
       the body and JSON.parses the reply. A blob is neither. Going
       through call() would base64 every chunk twice over and undo
       the whole reason blobs exist.

       Generous timeouts: a chunk is megabytes, and the link this
       has to survive is school wifi. */
    async putBlob(key, bytes, opts) {
      opts = opts || {};
      if (!baseUrl) throw new Error("relay url is not configured");
      var ac = new AbortController();
      var timer = setTimeout(function () { ac.abort(); }, opts.timeout || 60000);
      try {
        var headers = { "Content-Type": "application/octet-stream" };
        if (token) headers["Authorization"] = "Bearer " + token;
        var res = await fetch(url("/blobs/" + encodeURIComponent(key)), {
          method: "PUT", headers: headers, body: bytes,
          signal: ac.signal, cache: "no-store", mode: "cors"
        });
        if (!res.ok) {
          var data = null;
          try { data = JSON.parse(await res.text()); } catch (e) { data = null; }
          var err = new Error((data && data.error) || ("relay returned " + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return true;
      } catch (e) {
        if (e.name === "AbortError") throw new Error("blob upload timed out");
        throw e;
      } finally { clearTimeout(timer); }
    },

    async getBlob(key, opts) {
      opts = opts || {};
      if (!baseUrl) throw new Error("relay url is not configured");
      var ac = new AbortController();
      var timer = setTimeout(function () { ac.abort(); }, opts.timeout || 60000);
      try {
        var headers = {};
        if (token) headers["Authorization"] = "Bearer " + token;
        var res = await fetch(url("/blobs/" + encodeURIComponent(key)), {
          method: "GET", headers: headers,
          signal: ac.signal, cache: "no-store", mode: "cors"
        });
        if (res.status === 404) return null;
        if (!res.ok) {
          var err = new Error("relay returned " + res.status);
          err.status = res.status;
          throw err;
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (e.name === "AbortError") throw new Error("blob download timed out");
        throw e;
      } finally { clearTimeout(timer); }
    },

    async deleteBlob(key) {
      await call("DELETE", "/blobs/" + encodeURIComponent(key), undefined, { timeout: 15000 });
      return true;
    },

    async listBlobs() {
      return call("GET", "/blobs", undefined, { timeout: 20000 });
    },

    /* ---- Bastion service status (read-only) ---- */
    /* Authenticated: the service list is a map of the internal
       network. Generous timeout because the relay probes several
       hosts sequentially before it can answer. */
    async status() {
      return call("GET", "/status", undefined, { timeout: 20000 });
    },

    /* ---- whitelisted actions (§9D) ----
       Tailnet-only at the relay, so a 403 here is the expected
       answer over the public leg rather than a fault. It is passed
       through with its detail intact so the panel can explain
       itself instead of showing "403". */
    async listActions() {
      return call("GET", "/actions", undefined, { timeout: 8000 });
    },

    /* The body carries an id and nothing else, deliberately — the
       relay reads no other field, and sending more would only
       create the impression that a client can shape a command.

       The timeout follows the relay's own budget for the action
       plus a margin for the round trip. A fixed client timeout
       shorter than the server's would abort a command that is still
       running and report it as failed — the worst possible answer
       for a restart, because it invites pressing the button again. */
    async runAction(id, budgetMs) {
      var ms = Number(budgetMs) > 0 ? Number(budgetMs) + 10000 : 45000;
      return call("POST", "/actions", { id: id }, { timeout: Math.min(ms, 300000) });
    },

    /* ---- usage counters (§9 Relay/AI extras) ---- */
    async usage() {
      return call("GET", "/usage", undefined, { timeout: 8000 });
    },

    /* ---- AI (Phase 4 surface, used by ai-router later) ---- */
    async aiTargets() {
      return call("GET", "/ai/targets", undefined, { timeout: 10000 });
    },

    async aiChat(payload) {
      return call("POST", "/ai/chat", payload, { timeout: 125000 });
    }
  };

  FieldKit.provide("transportRelay", RelayTransport);
})(window.FieldKit);
