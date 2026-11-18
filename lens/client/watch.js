/* FieldKit lens :: a YouTube video in YouTube's own embedded player (0.20.6).

   YouTube stops a video played through lens after about a minute: its player
   checks it runs in an ordinary browser, and a page run through lens is not
   one (lens.js, handOff). YouTube's embedded player is how YouTube itself
   lets a video be shown in another page (Google Slides' "insert video" is
   the same thing). It runs here, in this browser, straight from YouTube, so
   that check is passed honestly, as on any site with a video in it.

   watch.html?v=<id>[&t=<seconds>][&list=<playlist>] . The lens server sends
   this page without the isolation headers the lens page needs (they would
   keep YouTube's player out) and with a referrer policy that names this
   site, which YouTube's player asks for. A video whose owner does not allow
   it to be shown elsewhere says so, with its address on YouTube. */
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var ID = /^[A-Za-z0-9_-]{11}$/;
  var v = String(q.get("v") || ""), list = String(q.get("list") || ""), t = Math.max(0, Math.floor(Number(q.get("t")) || 0));
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(list)) list = "";
  var outUrl = "https://www.youtube.com/watch?v=" + encodeURIComponent(v) + (t ? "&t=" + t + "s" : "") + (list ? "&list=" + encodeURIComponent(list) : "");
  document.getElementById("out").href = ID.test(v) ? outUrl : "https://www.youtube.com/";

  function note(head, say) {
    document.getElementById("player").style.display = "none";
    document.getElementById("note").style.display = "block";
    document.getElementById("head").textContent = head;
    document.getElementById("say").textContent = say;
    tell({ t: "error", head: head });
  }
  /* What the panel holding this page is told (BROWSER shows the title). */
  function tell(m) {
    m.fk = "watch";
    try { if (window.parent !== window) window.parent.postMessage(m, "*"); } catch (e) {}
  }
  if (!ID.test(v)) return note("That is not a YouTube video address", "Open the video on YouTube's site and copy its address again.");

  /* YouTube's codes: 2 a bad address, 5 the player could not play it here,
     100 removed or private, 101 and 150 its owner keeps it on YouTube only,
     152 and 153 the page's settings (should not happen here). */
  var WHY = {
    2: ["That video address is not right", "Copy it again from YouTube."],
    5: ["This video does not play in this browser", "Open it on YouTube instead."],
    100: ["This video is not there", "It was removed or made private."],
    101: ["Its owner shows it on YouTube only", "Whoever posted it does not allow it to play in other pages. It plays on YouTube itself."],
    150: ["Its owner shows it on YouTube only", "Whoever posted it does not allow it to play in other pages. It plays on YouTube itself."]
  };

  window.onYouTubeIframeAPIReady = function () {
    var vars = { autoplay: 1, rel: 0, playsinline: 1, origin: location.origin };
    if (t) vars.start = t;
    if (list) { vars.list = list; vars.listType = "playlist"; }
    /* The player is YouTube's; it is given the whole page, nothing laid
       over it, as YouTube's rules for embedded players ask. */
    new window.YT.Player("player", {
      host: "https://www.youtube-nocookie.com",
      videoId: v,
      playerVars: vars,
      events: {
        onReady: function (e) {
          var d = {};
          try { d = e.target.getVideoData() || {}; } catch (x) {}
          if (d.title) document.title = d.title;
          tell({ t: "ready", title: d.title || "", v: v });
        },
        onError: function (e) {
          var w = WHY[e.data] || ["This video did not play here", "Open it on YouTube instead."];
          note(w[0], w[1]);
        }
      }
    });
  };
  var s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  s.onerror = function () {
    note("YouTube's player did not load", "This network may not allow YouTube's player. It is the one Google Slides and other sites use, so if videos play there they should play here.");
  };
  document.head.appendChild(s);
})();
