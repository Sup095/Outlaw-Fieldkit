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
