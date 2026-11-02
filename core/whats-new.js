/* ============================================================
   FieldKit :: whats-new
   What changed, in the words of someone using it.

   Shown once after an update, from the desktop, and any time from
   Ctrl+K. A test ties the first entry to the version in core/kernel.js,
   so a release cannot go out without saying what is in it.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var NOTES = [
    { v: "0.9.0", items: [
      "FULL MODE can run on FieldKit's cloud server: its video then does not use the home internet, which stays free for everything else.",
      "YouTube still plays at home, because it refuses rented servers. PLAY AT HOME on the note moves a video there.",
      "DATA SAVER under ⋯ lowers FULL MODE's video. On AUTO it does this for YouTube at home only.",
      "If a network does not reach the cloud server, FULL MODE runs at home by itself. DIAGNOSTICS and PREFLIGHT check it.",
      "ADMIN CENTER sets the cloud server's address under SERVICES."
    ] },
    { v: "0.8.0", items: [
      "BROWSER has a lighter mode: pages run in your own browser, sharp and quick to scroll, through FieldKit's new server. It is used by itself when set up.",
      "In the lighter mode, ★ keeps a bookmark and PLACES opens your bookmarks and history; TAB opens the page in a tab of its own.",
      "YouTube opens in FULL MODE, the streamed browser, by itself. Use FULL MODE for anything you sign in to too; LIGHT MODE under ⋯ goes back.",
      "If the lighter mode does not load on a network, BROWSER moves to FULL MODE by itself.",
      "ADMIN CENTER shows the lighter mode and how much of the month it has used, and sets its address. DIAGNOSTICS checks this network reaches it."
    ] },
    { v: "0.7.1", items: [
      "When a newer version is out, a popup says so at start, with a button to get it. TELL ME ABOUT UPDATES in SETTINGS turns it off.",
      "GET A TINY MODEL works on a network that blocks Hugging Face: the model comes through your relay instead.",
      "BROWSER no longer blames the content filter for a site that does not exist; it checks a second time without the filter and says which it was.",
      "YouTube's video and picture servers can never be blocked by a list by mistake, and a site an admin allows now gets past the DNS filter too.",
      "If the content filter's servers stop answering, a second filter of the same kind takes over, so pages do not all fail at once."
    ] },
    { v: "0.7.0", items: [
      "FieldKit's servers now have a hard ceiling on what they send, 12 Mbit/s unless an admin changes it, so the rest of the house's upload stays free.",
      "Right-click an app to pin it to YOUR APPS, where it stays put, or to read how it works. On a touch screen, hold it.",
      "Right-click a window's button in the taskbar to snap, maximise or close it; the middle button closes it.",
      "Ctrl+Shift+D, or SHOW DESKTOP in Ctrl+K, moves every window aside, and again brings them back.",
      "The clock shows the date when you point at it, and SETTINGS has a 12-hour option.",
      "An app that needs a relay address says so the same way everywhere, with one button to set it, and works as soon as it is set.",
      "The relay question at start can be switched off, and back on in RELAY LINK.",
      "NOTES counts words and can save a note as a .md file. COPY buttons say when they have copied.",
      "OUTPOST has the wallpapers too, and TOPOLOGY's starting picture matches how FieldKit is really set up.",
      "Fixed: SETTINGS could show its rows squeezed into columns after NOTES had been opened."
    ] },
    { v: "0.6.0", items: [
      "ADMIN CENTER: one page for admins, with services, people waiting, what was blocked, and a way to tell everyone something.",
      "If a service is down, a line at the top says so, and it goes away by itself when the service is back.",
      "◉ in the taskbar lists what happened, so a message you missed is still there.",
      "BROWSER blocks ads, trackers, malware and adult sites from lists that keep themselves up to date. If a site was blocked by mistake, press THIS IS WRONG.",
      "Windows remember where you left them, snap to the sides of the screen, and can come back after a reload.",
      "Esc no longer closes BROWSER while you are using a page.",
      "A new tab in BROWSER shows your bookmarks and recent sites, and a closed tab can be reopened.",
      "SETTINGS: bigger text, higher contrast and less motion.",
      "RUNNER stops sending pictures of a window you cannot see."
    ] }
  ];

  FieldKit.provide("whatsNew", {
    notes: function () { return NOTES.slice(); },
    latest: function () { return NOTES[0]; }
  });
})(window.FieldKit);
