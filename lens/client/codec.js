/* ============================================================
   FieldKit lens :: addresses that do not say where they go

   A school's monitor (Linewise and the like) reads every address a tab
   and its frames load. Scramjet's default puts the site in plain text,
   /scramjet/https%3A%2F%2Fwww.youtube.com%2F..., and a filter that sees
   YouTube there blocks the lens address itself. So the site is mixed
   with a fixed pattern and written as base64url under /c/: the monitor
   sees lens.<domain>/c/<letters> and nothing else. This is masking, not
   secrecy: anyone with this file can read it back.

   Scramjet runs encode and decode as text (it sends them to its service
   worker), so each must stand alone. decode() keeps what a page adds
   after the letters: a GET form replaces the query, as a browser would,
   and a #fragment replaces the fragment.

   Shared by the lens page (lens.js) and every slot (slot.js).
   ============================================================ */
(function (root) {
  "use strict";
  var CODEC = {
    encode: function (e) {
      if (!e) return e;
      /* Scramjet also sends a page's #fragment through here on its own.
         A fragment never leaves the browser, so it is left as it is, and
         decode() hands it back unchanged. */
      if (!/^[a-z][a-z0-9+.-]*:/i.test(e)) return e;
      var b = new TextEncoder().encode(e), s = "";
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ^ ((i * 31 + 7) & 255));
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    decode: function (e) {
      if (!e) return e;
      var cut = e.search(/[?#]/), head = cut < 0 ? e : e.slice(0, cut), tail = cut < 0 ? "" : e.slice(cut);
      var out;
      try {
        var s = atob(head.replace(/-/g, "+").replace(/_/g, "/")), b = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) ^ ((i * 31 + 7) & 255);
        out = new TextDecoder().decode(b);
      } catch (x) {
        try { return decodeURIComponent(e); } catch (y) { return e; }
      }
      if (!/^[a-z][a-z0-9+.-]*:/i.test(out)) { try { return decodeURIComponent(e); } catch (y) { return e; } }
      if (!tail) return out;
      var hashAt = out.indexOf("#");
      if (tail.charAt(0) === "#") return (hashAt < 0 ? out : out.slice(0, hashAt)) + tail;
      var base = hashAt < 0 ? out : out.slice(0, hashAt), q = base.indexOf("?");
      return (q < 0 ? base : base.slice(0, q)) + tail;
    }
  };

  /* The site an address belongs to, as a browser decides which pages may
     share storage: the registrable name (example.co.uk, someone.github.io),
     not the whole host. Close enough without the full public suffix list:
     the common two-part endings, and the hosting names where every
     customer is a site of their own. */
  var TWO_PART = /^(co|com|org|net|ac|gov|edu|ne|or|go|gob|mil|sch|nhs|ltd|plc|me|nom)\.[a-z]{2}$/;
  var SHARED_HOSTS = ["github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "web.app",
    "firebaseapp.com", "herokuapp.com", "glitch.me", "blogspot.com", "itch.io", "neocities.org", "replit.app",
    "repl.co", "onrender.com", "fly.dev", "azurewebsites.net", "cloudfront.net", "appspot.com", "wixsite.com",
    "weebly.com", "wordpress.com", "tumblr.com", "substack.com", "carrd.co", "surge.sh"];
  function siteOf(u) {
    var h;
    try { h = new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch (e) { return ""; }
    if (!h) return "";
    if (/^[\d.]+$/.test(h) || h.indexOf(":") >= 0 || h.indexOf(".") < 0) return h;
    var parts = h.split(".");
    for (var i = 0; i < SHARED_HOSTS.length; i++) {
      var s = SHARED_HOSTS[i];
      if (h === s) return h;
      if (h.slice(-s.length - 1) === "." + s) return parts.slice(-(s.split(".").length + 1)).join(".");
    }
    var last2 = parts.slice(-2).join(".");
    if (parts.length >= 3 && TWO_PART.test(last2)) return parts.slice(-3).join(".");
    return last2;
  }

  root.FK_LENS = { CODEC: CODEC, PREFIX: "/c/", siteOf: siteOf };
})(typeof self !== "undefined" ? self : this);
