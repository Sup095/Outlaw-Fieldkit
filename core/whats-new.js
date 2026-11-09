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
    { v: "0.14.0", items: [
      "POOL HALL: eight-ball with real spin (draw, follow, side), against the computer, a friend on the same screen, or alone to practise.",
      "Play friends online: challenge a gamertag (the same as DEEPHOLD) or post an open challenge. FieldKit tells you when it is your shot.",
      "The relay plays every online shot itself, so nobody can fake one and both screens always agree."
    ] },
    { v: "0.13.1", items: [
      "DEEPHOLD: digging is in the picture. Click the dig site under your deepest layer, or DIG DEEPER, to see the cost and dig.",
      "A boring rig cuts each new tunnel, and the rock below the colony has seams and strata instead of a blank edge.",
      "When you cannot dig yet, the dig site and the advisor say which Civilization stage opens the next layer.",
      "The Imperial garrison is redone: a buried gothic fortress with red-glass windows, banners, braziers and a spired gatehouse that mend as you repair it."
    ] },
    { v: "0.13.0", items: [
      "DEEPHOLD rebuilt: a live picture of your colony, digging down with workers walking its tunnels. Click a plot to build or inspect.",
      "DEEPHOLD has its own gamertags, separate from MESSAGES, so only people who play are counted. Typing and clicks no longer get lost.",
      "An advisor says what your colony needs and builds it in one click. Buildings are sorted into categories, with the useful ones starred.",
      "Shipping rules: SEND ALL, SEND SURPLUS, SEND A LITTLE or KEEP ALL, for everything or one thing. They follow what is needed.",
      "Stages 4 to 6 are ready. Warnings (waves, hunger, a new stage) appear in the notices even with the game closed.",
      "Admins can pause the game and start in a ruined Imperial garrison. Colonies unseen for a week pause and stop counting.",
      "FieldKit offers to sign you in when it starts, and RUNNER and BROWSER sign you in where you are."
    ] },
    { v: "0.12.1", items: [
      "Fixed: sites that said 'Forbidden' for a few seconds after one lost DNS answer. The relay now asks again.",
      "Fixed: a bad request could make DEEPHOLD answer with an error; a game bug can no longer stop the relay."
    ] },
    { v: "0.12.0", items: [
      "New: DEEPHOLD, a game everyone on the relay shares. Build an underground colony; what it ships up becomes one Civilization that levels up.",
      "You never dig by hand. Buildings work while you are away: what they ship reaches the Civilization in full, and you keep 30% of the rest.",
      "Each stage of the Civilization unlocks new buildings for everyone. There is a war: arms and turrets hold it, and it can fall, but not easily.",
      "Costs follow how many people are playing, and more places to start open as more join. Needs an approved account (member or admin)."
    ] },
    { v: "0.11.0", items: [
      "New relay addresses arrive by themselves: after you sign in, the relay's list is saved and deleted addresses are forgotten.",
      "If the address in use is blocked, the address question at start comes back even if you turned it off.",
      "Changing the address no longer needs a restart, and the bar at the bottom names the address in use. Click it for RELAY LINK.",
      "In OUTPOST the bar now says whether the relay answers, instead of always LOCAL ONLY.",
      "A few tiny models are kept on the relay: GET A TINY MODEL lists them first (ON YOUR RELAY), and they never touch Hugging Face.",
      "BROWSER's lighter mode no longer shows the site you are on in its addresses or the tab's title.",
      "A new version is noticed while FieldKit stays open, not only at start, and the relay picks up a release within minutes."
    ] },
    { v: "0.10.1", items: [
      "FULL MODE keeps going: a video no longer stops when nobody has looked for a while, and your session is not ended to make room for someone else.",
      "If the connection drops, FULL MODE connects again by itself and carries on where it was.",
      "RUNNER is now for admins and the members an admin allows, like FULL MODE. The ALLOW button under PEOPLE gives both."
    ] },
    { v: "0.10.0", items: [
      "YouTube plays in BROWSER's lighter mode, in your own browser, without using the home internet.",
      "The lighter mode is not private: it says so at the top, and again if you click a password box. Do not sign in to anything there.",
      "FULL MODE is now for admins and the members an admin allows (ADMIN CENTER or MESSAGES, PEOPLE). Everyone else has the lighter mode.",
      "DATA SAVER under ⋯ in FULL MODE lowers the video, by itself for YouTube.",
      "0.9.0's FULL MODE on a rented server is gone: it cost too much for what it added."
    ] },
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
