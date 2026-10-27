/* ============================================================
   FieldKit :: achievements
   Unlocks tied to real actions (§6), styled like the systems in
   Sup095's own games.

   Engine and panel live in one file on purpose: the engine has to
   run whenever FieldKit is open, not only when the panel is
   mounted, and splitting them would mean loading two files to get
   one behaviour.

   Progress is derived from the store on demand rather than kept as
   a running counter, so it stays correct even if records are added
   on another machine and synced in later. Event-driven ones (using
   the palette, trying every theme) are the exception and live in a
   small counters record.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "achievement";
  var COUNTERS_ID = "fk-counters";

  var unlocked = {};      // id -> {at}
  /* Counters that only ever go up. Listed in one place so a fresh
     vault — and a vault written by an older build that never heard of
     half of these — starts at a known shape rather than `undefined+1`. */
  function freshCounters() {
    return {
      paletteUses: 0, themesSeen: [], offlineWrites: 0, tier1Answers: 0,
      exerciseRuns: 0, cleanExercises: 0, snapshots: 0, overwrites: 0,
      remotePulls: 0, eggsFound: 0, locksEngaged: 0, tier2Loads: 0,
      modulesOpened: [], maxWindows: 0, syncedBatches: 0
    };
  }
  var counters = freshCounters();
  var countersRecordId = null;
  var ready = false;

  var DEFS = [
    { id: "first-light", name: "FIRST LIGHT", icon: "✦",
      desc: "Create the vault and save your first record.",
      test: function (s) { return s.records >= 1; } },
    { id: "notes-10", name: "FIELD NOTES", icon: "▤",
      desc: "Write 10 scratchpad notes.",
      test: function (s) { return s.notes >= 10; } },
    { id: "notes-50", name: "ARCHIVIST", icon: "▦",
      desc: "Write 50 scratchpad notes.",
      test: function (s) { return s.notes >= 50; } },
    { id: "versions-100", name: "REVISION HISTORY", icon: "⟲",
      desc: "Accumulate 100 note versions. Every save counts.",
      test: function (s) { return s.versions >= 100; } },
    { id: "snippets-10", name: "TOOLCHEST", icon: "❑",
      desc: "Store 10 snippets.",
      test: function (s) { return s.snippets >= 10; } },
    { id: "configs-5", name: "HARD-WON", icon: "🗝",
      desc: "Vault 5 known-good configs. Fixes you never have to rediscover.",
      test: function (s) { return s.configs >= 5; } },
    { id: "incidents-5", name: "INCIDENT RESPONSE", icon: "⚠",
      desc: "Log 5 incidents.",
      test: function (s) { return s.incidents >= 5; } },
    { id: "pattern-match", name: "SEEN IT BEFORE", icon: "◎",
      desc: "Log an incident similar to one already on record.",
      test: function (s) { return s.matchedIncident; } },
    { id: "clean-10", name: "TEN CLEAN BOOTS", icon: "✇",
      desc: "Pass 10 self-tests with zero failures.",
      test: function (s) { return s.cleanRuns >= 10; } },
    { id: "clean-100", name: "HUNDRED CLEAN BOOTS", icon: "✇",
      desc: "Pass 100 self-tests with zero failures.",
      test: function (s) { return s.cleanRuns >= 100; } },
    { id: "went-dark", name: "WENT DARK", icon: "◐",
      desc: "Create work with no relay, then sync it up later.",
      test: function (s) { return s.offlineWrites >= 1; } },
    { id: "uplink", name: "UPLINK", icon: "◈",
      desc: "Connect to the relay for the first time.",
      test: function (s) { return s.everOnline; } },
    { id: "real-model", name: "REAL INTELLIGENCE", icon: "◧",
      desc: "Get an answer from the tier 1 model instead of heuristics.",
      test: function (s) { return s.tier1Answers >= 1; } },
    { id: "palette-20", name: "KEYBOARD DRIVEN", icon: "⌘",
      desc: "Use the command palette 20 times.",
      test: function (s) { return s.paletteUses >= 20; } },
    { id: "all-themes", name: "REPAINTED", icon: "◍",
      desc: "Try every accent palette.",
      test: function (s) { return s.themesSeen >= 5; } },
    { id: "night-shift", name: "NIGHT SHIFT", icon: "☾",
      desc: "Save something between midnight and 4am.",
      test: function (s) { return s.nightSaves >= 1; } },

    /* ---- the clock ------------------------------------------------
       These are the ones worth having: nothing to grind, you either
       happened to be working then or you did not. NIGHT SHIFT is the
       template — the rest follow it around the dial and the calendar. */
    { id: "graveyard", name: "GRAVEYARD SHIFT", icon: "☾",
      desc: "Save 10 things between midnight and 4am. Once is a late night. Ten is a habit.",
      test: function (s) { return s.nightSaves >= 10; } },
    { id: "dawn-patrol", name: "DAWN PATROL", icon: "☀",
      desc: "Save something between 5am and 7am, before anyone else is up.",
      test: function (s) { return s.dawnSaves >= 1; } },
    { id: "both-ends", name: "BOTH ENDS OF THE DAY", icon: "◑",
      desc: "Save something before 7am and something after midnight. Sleep is optional, apparently.",
      test: function (s) { return s.dawnSaves >= 1 && s.nightSaves >= 1; } },
    { id: "weekend", name: "WEEKEND WARRIOR", icon: "◇",
      desc: "Save something on a Saturday or a Sunday.",
      test: function (s) { return s.weekendSaves >= 1; } },
    { id: "no-days-off", name: "NO DAYS OFF", icon: "◆",
      desc: "Work on 20 separate weekend days.",
      test: function (s) { return s.weekendDays >= 20; } },
    { id: "streak-7", name: "SEVEN DAYS RUNNING", icon: "▸",
      desc: "Save something on seven consecutive days.",
      test: function (s) { return s.longestStreak >= 7; } },
    { id: "streak-30", name: "STEADY HAND", icon: "▶",
      desc: "Save something on thirty consecutive days.",
      test: function (s) { return s.longestStreak >= 30; } },
    { id: "flow-state", name: "FLOW STATE", icon: "≋",
      desc: "Save 20 things inside a single hour.",
      test: function (s) { return s.bestHour >= 20; } },
    { id: "long-haul", name: "LONG HAUL", icon: "⌛",
      desc: "Touch the vault on 100 different days.",
      test: function (s) { return s.activeDays >= 100; } },
    { id: "anniversary", name: "ONE YEAR ON", icon: "✧",
      desc: "Keep a vault alive for a year.",
      test: function (s) { return s.vaultAgeDays >= 365; } },
    { id: "cold-storage", name: "COLD STORAGE", icon: "❄",
      desc: "Come back to a record you have not touched in 90 days.",
      test: function (s) { return s.revivedOld; } },

    /* ---- two people ---------------------------------------------- */
    { id: "two-hands", name: "TWO HANDS", icon: "⚯",
      desc: "Hold work written by both of you.",
      test: function (s) { return s.authors >= 2; } },
    { id: "postcard", name: "POSTCARD", icon: "✉",
      desc: "Pull down a change someone else made on another machine.",
      test: function (s) { return s.remotePulls >= 1; } },
    { id: "collision", name: "COLLISION", icon: "✖",
      desc: "Save over work the other person had already changed. The warning is the achievement.",
      test: function (s) { return s.overwrites >= 1; } },
    { id: "roadshow", name: "ROADSHOW", icon: "⌁",
      desc: "Write to the vault from three different machines.",
      test: function (s) { return s.devices >= 3; } },
    { id: "courier", name: "COURIER", icon: "⇅",
      desc: "Flush 25 queued writes up to the relay after working offline.",
      test: function (s) { return s.syncedBatches >= 25; } },

    /* ---- the work itself ----------------------------------------- */
    { id: "generalist", name: "GENERALIST", icon: "◈",
      desc: "Store work of ten different kinds.",
      test: function (s) { return s.distinctTypes >= 10; } },
    { id: "full-kit", name: "FULL KIT", icon: "◉",
      desc: "Store work of fifteen different kinds. Most of the drive, used for real.",
      test: function (s) { return s.distinctTypes >= 15; } },
    { id: "burndown", name: "BURNDOWN", icon: "▼",
      desc: "Move 25 tasks to DONE.",
      test: function (s) { return s.tasksDone >= 25; } },
    { id: "unblocked", name: "UNBLOCKED", icon: "⛏",
      desc: "Clear a task that had been sitting in BLOCKED.",
      test: function (s) { return s.unblocked; } },
    { id: "qa-pass", name: "QA PASS", icon: "✓",
      desc: "Take 10 playtest reports all the way to VERIFIED.",
      test: function (s) { return s.verifiedBugs >= 10; } },
    { id: "crash-course", name: "CRASH COURSE", icon: "☇",
      desc: "Find a crash, fix it, and verify the fix.",
      test: function (s) { return s.verifiedCrash; } },
    { id: "triage", name: "TRIAGE", icon: "⌗",
      desc: "Close 5 reports as WON'T FIX. Deciding not to fix is still deciding.",
      test: function (s) { return s.wontfix >= 5; } },
    { id: "ghost-hunt", name: "GHOST HUNT", icon: "◌",
      desc: "Close 3 reports as CANNOT REPRODUCE.",
      test: function (s) { return s.cantrepro >= 3; } },
    { id: "paper-trail", name: "PAPER TRAIL", icon: "§",
      desc: "Record 10 decisions, so nobody has to relitigate them.",
      test: function (s) { return s.decisions >= 10; } },
    { id: "asset-pipeline", name: "ASSET PIPELINE", icon: "▧",
      desc: "Catalogue 25 assets.",
      test: function (s) { return s.assets >= 25; } },
    { id: "build-server", name: "BUILD SERVER", icon: "⚙",
      desc: "Record 10 builds.",
      test: function (s) { return s.manifests >= 10; } },
    { id: "release-notes", name: "RELEASE NOTES", icon: "❧",
      desc: "Write 25 changelog entries.",
      test: function (s) { return s.changelog >= 25; } },
    { id: "scripted", name: "SCRIPTED", icon: "»",
      desc: "Save 5 CritterScript programs.",
      test: function (s) { return s.scripts >= 5; } },

    /* ---- looking after the thing --------------------------------- */
    { id: "full-sweep", name: "FULL SWEEP", icon: "✇",
      desc: "Run the full system exercise once.",
      test: function (s) { return s.exerciseRuns >= 1; } },
    { id: "spotless", name: "SPOTLESS", icon: "✇",
      desc: "Get a full system exercise through with nothing failing.",
      test: function (s) { return s.cleanExercises >= 1; } },
    { id: "belt-and-braces", name: "BELT AND BRACES", icon: "⎘",
      desc: "Take a backup snapshot.",
      test: function (s) { return s.snapshots >= 1; } },
    { id: "paranoid", name: "SUITABLY PARANOID", icon: "⎗",
      desc: "Take 10 backup snapshots.",
      test: function (s) { return s.snapshots >= 10; } },
    { id: "opsec", name: "OPSEC", icon: "⚿",
      desc: "Lock the screen before walking away. Five times.",
      test: function (s) { return s.locksEngaged >= 5; } },

    /* ---- how you drive it ---------------------------------------- */
    { id: "muscle-memory", name: "MUSCLE MEMORY", icon: "⌘",
      desc: "Use the command palette 200 times.",
      test: function (s) { return s.paletteUses >= 200; } },
    { id: "mission-control", name: "MISSION CONTROL", icon: "▦",
      desc: "Have six windows open at once.",
      test: function (s) { return s.maxWindows >= 6; } },
    { id: "grand-tour", name: "GRAND TOUR", icon: "✥",
      desc: "Open every module at least once.",
      test: function (s) { return s.modulesUnseen === 0 && s.modulesOpened > 0; } },
    { id: "curious", name: "CURIOUS", icon: "?",
      desc: "Find three things nobody told you were there.",
      test: function (s) { return s.eggsFound >= 3; } },
    { id: "local-intelligence", name: "LOCAL INTELLIGENCE", icon: "◨",
      desc: "Load the in-browser model and run it with no relay at all.",
      test: function (s) { return s.tier2Loads >= 1; } },
    { id: "regular-caller", name: "REGULAR CALLER", icon: "◧",
      desc: "Get 50 answers out of the tier 1 model.",
      test: function (s) { return s.tier1Answers >= 50; } }
  ];

  /* Fifty-odd rows in one flat column is a wall, so the panel groups
     them. Kept as a lookup rather than a field on every definition so
     the list above stays readable — and the selfcheck below fails if a
     new achievement is ever added without a home, which is the only
     way this can silently go stale. */
  var CATEGORIES = [
    { name: "THE VAULT", ids: ["first-light", "notes-10", "notes-50", "versions-100",
        "snippets-10", "configs-5", "incidents-5", "pattern-match",
        "generalist", "full-kit"] },
    { name: "THE CLOCK", ids: ["night-shift", "graveyard", "dawn-patrol", "both-ends",
        "weekend", "no-days-off", "streak-7", "streak-30", "flow-state",
        "long-haul", "anniversary", "cold-storage"] },
    { name: "TWO PEOPLE", ids: ["uplink", "went-dark", "two-hands", "postcard",
        "collision", "roadshow", "courier"] },
    { name: "THE WORK", ids: ["burndown", "unblocked", "qa-pass", "crash-course",
        "triage", "ghost-hunt", "paper-trail", "asset-pipeline", "build-server",
        "release-notes", "scripted"] },
    { name: "UPKEEP", ids: ["clean-10", "clean-100", "full-sweep", "spotless",
        "belt-and-braces", "paranoid", "opsec"] },
    { name: "HOW YOU DRIVE IT", ids: ["palette-20", "muscle-memory", "all-themes",
        "mission-control", "grand-tour", "curious", "real-model",
        "local-intelligence", "regular-caller"] }
  ];

  function byId(id) {
    for (var i = 0; i < DEFS.length; i++) if (DEFS[i].id === id) return DEFS[i];
    return null;
  }

  /* Categories in declared order, then anything uncategorised, so a
     definition that slips through still shows up for the person
     playing rather than vanishing from the panel. */
  function grouped() {
    var placed = {};
    var out = CATEGORIES.map(function (c) {
      var defs = c.ids.map(function (id) { placed[id] = true; return byId(id); }).filter(Boolean);
      return { name: c.name, defs: defs };
    }).filter(function (g) { return g.defs.length; });

    var rest = DEFS.filter(function (d) { return !placed[d.id]; });
    if (rest.length) out.push({ name: "UNSORTED", defs: rest });
    return out;
  }

  function store() { return FieldKit.service("store"); }

  /* ---- persistence -------------------------------------------- */
  async function loadState() {
    var s = store();
    if (!s || !s.isUnlocked()) return false;

    var rows = await s.list(TYPE);
    unlocked = {};
    /* Reset first. Merging onto whatever was in memory meant a second
       vault opened in the same session inherited the first one's
       tallies — which is somebody else's progress. */
    counters = freshCounters();
    rows.forEach(function (r) {
      if (r.data && r.data.kind === "counters") {
        countersRecordId = r.id;
        counters = Object.assign(freshCounters(), r.data.counters || {});
      } else if (r.data && r.data.achievementId) {
        unlocked[r.data.achievementId] = { at: r.data.at, id: r.id };
      }
    });
    ready = true;
    return true;
  }

  var saveTimer = null;
  function saveCounters() {
    /* Debounced — palette use fires often and each write is an
       encrypt plus a transport round trip. */
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async function () {
      var s = store();
      if (suspended || !s || !s.isUnlocked()) return;
      try {
        var meta = await s.put(TYPE, { kind: "counters", counters: counters },
          { id: countersRecordId || COUNTERS_ID });
        countersRecordId = meta.id;
      } catch (e) {
        FieldKit.log("warn", "achievements", "could not persist counters: " + e.message);
      }
    }, 4000);
  }

  /* ---- stats --------------------------------------------------
     Derived from the store every time rather than counted as things
     happen, so a vault that syncs down a year of the other person's
     work gets credit for it. Only the things the store cannot see —
     which buttons were pressed, which windows were open — come from
     `counters`. */
  var DAY_MS = 86400000;

  function localDay(iso) {
    /* Local, not UTC. A streak is about the days you sat down to
       work, and someone in UTC-5 working at 9pm would otherwise have
       every evening counted as the next day. */
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  /* Longest run of consecutive calendar days in a set of day keys. */
  function longestStreak(dayKeys) {
    var days = dayKeys.slice().sort();
    var best = 0, run = 0, prev = null;
    days.forEach(function (k) {
      var t = new Date(k + "T12:00:00").getTime();   // midday: immune to DST
      if (prev !== null && Math.round((t - prev) / DAY_MS) === 1) run++;
      else run = 1;
      prev = t;
      if (run > best) best = run;
    });
    return best;
  }

  /* Most saves inside any 60-minute window. A sliding window over the
     sorted timestamps rather than clock hours, so twenty saves from
     10:50 to 11:10 count as the burst they obviously are. */
  function busiestHour(times) {
    var t = times.slice().sort(function (a, b) { return a - b; });
    var best = 0, lo = 0;
    for (var hi = 0; hi < t.length; hi++) {
      while (t[hi] - t[lo] > 3600000) lo++;
      if (hi - lo + 1 > best) best = hi - lo + 1;
    }
    return best;
  }

  async function gather() {
    var s = store();
    if (!s || !s.isUnlocked()) return null;

    var all = await s.list();
    var count = function (t) { return all.filter(function (r) { return r.meta.type === t; }).length; };
    var selftests = all.filter(function (r) { return r.meta.type === "selftest"; });

    /* The engine's own bookkeeping records are not work, and counting
       them would mean unlocking things by unlocking things. */
    var real = all.filter(function (r) { return r.meta.type !== TYPE; });

    var nightSaves = 0, dawnSaves = 0, weekendSaves = 0, revivedOld = false;
    var days = {}, weekendDays = {}, times = [];
    var authors = {}, devices = {}, types = {};
    var oldest = null;

    real.forEach(function (r) {
      var m = r.meta || {};
      types[m.type] = true;
      if (m.author) authors[m.author] = true;
      if (m.deviceId) devices[m.deviceId] = true;

      var d = new Date(m.updatedAt);
      if (isNaN(d)) return;
      times.push(d.getTime());

      var h = d.getHours();
      if (h >= 0 && h < 4) nightSaves++;
      if (h >= 5 && h < 7) dawnSaves++;

      var key = localDay(m.updatedAt);
      if (key) {
        days[key] = true;
        var wd = d.getDay();
        if (wd === 0 || wd === 6) { weekendSaves++; weekendDays[key] = true; }
      }

      var created = m.createdAt ? new Date(m.createdAt) : null;
      if (created && !isNaN(created)) {
        if (oldest === null || created.getTime() < oldest) oldest = created.getTime();
        /* Picked up again long after it was written. The gap is
           between creation and the last edit, so it only counts once
           the record has actually been revisited. */
        if (d.getTime() - created.getTime() >= 90 * DAY_MS) revivedOld = true;
      }
    });

    /* Payload-derived counts. `data` is null for a record that did
       not decrypt, so every read goes through a guard — one bad row
       must not cost the whole stat. */
    var withData = function (type, fn) {
      return real.filter(function (r) {
        return r.meta.type === type && r.data && fn(r.data);
      }).length;
    };

    var tasksDone = withData("task", function (d) { return d.status === "done"; });
    /* A task that names what was blocking it and reached DONE anyway.
       `blockedBy` is the field the board writes; a task that never had
       one was never actually stuck. */
    var unblocked = real.some(function (r) {
      return r.meta.type === "task" && r.data &&
        r.data.status === "done" && !!String(r.data.blockedBy || "").trim();
    });

    var now = Date.now();
    var opened = (counters.modulesOpened || []);
    var known = Object.keys(FieldKit.modules() || {});

    return {
      records: real.length,
      notes: count("note"),
      versions: count("note-version"),
      snippets: count("snippet"),
      configs: count("config"),
      incidents: count("incident"),
      cleanRuns: selftests.filter(function (r) { return r.data && r.data.failed === 0; }).length,
      matchedIncident: !!counters.matchedIncident,
      offlineWrites: counters.offlineWrites || 0,
      everOnline: !!counters.everOnline,
      tier1Answers: counters.tier1Answers || 0,
      paletteUses: counters.paletteUses || 0,
      themesSeen: (counters.themesSeen || []).length,

      /* clock */
      nightSaves: nightSaves,
      dawnSaves: dawnSaves,
      weekendSaves: weekendSaves,
      weekendDays: Object.keys(weekendDays).length,
      activeDays: Object.keys(days).length,
      longestStreak: longestStreak(Object.keys(days)),
      bestHour: busiestHour(times),
      vaultAgeDays: oldest === null ? 0 : Math.floor((now - oldest) / DAY_MS),
      revivedOld: revivedOld,

      /* two people */
      authors: Object.keys(authors).length,
      devices: Object.keys(devices).length,
      remotePulls: counters.remotePulls || 0,
      overwrites: counters.overwrites || 0,
      syncedBatches: counters.syncedBatches || 0,

      /* the work */
      distinctTypes: Object.keys(types).length,
      tasksDone: tasksDone,
      unblocked: unblocked,
      verifiedBugs: withData("playtest", function (d) { return d.status === "verified"; }),
      verifiedCrash: real.some(function (r) {
        return r.meta.type === "playtest" && r.data &&
          r.data.status === "verified" && r.data.severity === "crash";
      }),
      wontfix: withData("playtest", function (d) { return d.status === "wontfix"; }),
      cantrepro: withData("playtest", function (d) { return d.status === "cantrepro"; }),
      decisions: count("decision"),
      assets: count("asset"),
      manifests: count("manifest"),
      changelog: count("changelog"),
      scripts: count("script"),

      /* upkeep and habits */
      exerciseRuns: counters.exerciseRuns || 0,
      cleanExercises: counters.cleanExercises || 0,
      snapshots: counters.snapshots || 0,
      locksEngaged: counters.locksEngaged || 0,
      eggsFound: counters.eggsFound || 0,
      tier2Loads: counters.tier2Loads || 0,
      maxWindows: counters.maxWindows || 0,
      modulesOpened: opened.length,
      /* Measured against the modules this build actually has rather
         than a hard-coded number, so a build with a new module in it
         is not already-toured on day one. Anything already unlocked
         stays unlocked — this only gates the award. */
      modulesUnseen: known.filter(function (id) { return opened.indexOf(id) < 0; }).length
    };
  }

  /* The self-test creates probe notes, snippets, and incidents and
     then deletes them. Awarding progress for that would be cheating
     on your behalf, so the exercise suspends this engine for its
     duration and the counts go back to reflecting real work. */
  var suspended = 0;
  function suspend() { suspended++; return function () { suspended = Math.max(0, suspended - 1); }; }
  function isSuspended() { return suspended > 0; }

  /* ---- OPENING FIELDKIT IS NOT AN ACHIEVEMENT ------------------

     Reported as "achievements pop up every time you open FieldKit",
     and the cause is not one bug — it is that several different
     things all announce during the first few seconds of a session
     and none of them is something you just did:

       - the boot evaluate, which was already silent;
       - the first sync, which fires store:changed and was not;
       - the shell opening HOME, which fires shell:open and was not;
       - the relay answering, which unlocks UPLINK on its own.

     Silencing them one at a time would be four fixes and a fifth
     one later. The rule that covers all of them and stays true is
     simpler: nothing announces while the session is still opening.

     An unlock during that window is still recorded, still dated,
     still shown in ACHIEVEMENTS. It just does not interrupt. An
     achievement you earned before you sat down is not news, and one
     earned by the act of sitting down is not something you did.

     The window closes on a timer rather than on a specific event
     because the last of those four has no event of its own — the
     relay can answer at any point in the first few seconds — and a
     rule that depends on which of them happened last would be back
     to being four rules. */
  var QUIET_MS = 6000;
  var openedAt = Date.now();
  var quiet = true;
  var quietTimer = setTimeout(function () { quiet = false; }, QUIET_MS);

  /* store:ready is the real beginning of the session — everything
     before it was the lock screen — so the window is measured from
     there when it arrives, not from when this file loaded. */
  function restartQuietWindow() {
    openedAt = Date.now();
    quiet = true;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(function () { quiet = false; }, QUIET_MS);
  }

  /* A guest is not the person these belong to. Awarding them is
     meaningless — the guest store is memory-only and empty, so the
     tallies are somebody else's or nothing at all — and announcing
     them to a stranger holding your drive is worse than meaningless. */
  function isGuest() {
    var g = FieldKit.service("guest");
    if (g && g.active && g.active()) return true;
    var s2 = store();
    return !!(s2 && s2.isGuest);
  }

  async function evaluate(opts) {
    opts = opts || {};
    if (suspended) return [];
    if (isGuest()) return [];
    if (!ready && !(await loadState())) return [];
    var stats = await gather();
    if (!stats) return [];

    var fresh = [];
    for (var i = 0; i < DEFS.length; i++) {
      var d = DEFS[i];
      if (unlocked[d.id]) continue;
      var hit = false;
      try { hit = !!d.test(stats); } catch (e) { hit = false; }
      if (!hit) continue;

      var at = new Date().toISOString();
      unlocked[d.id] = { at: at };
      fresh.push(d);
      try {
        var meta = await store().put(TYPE, { achievementId: d.id, at: at });
        unlocked[d.id].id = meta.id;
      } catch (e) {
        FieldKit.log("warn", "achievements", "could not persist unlock: " + e.message);
      }
    }

    /* The event fires either way. A module that wants to react to an
       unlock should not have to care whether it was announced —
       what is being suppressed here is the interruption, not the
       fact. */
    fresh.forEach(function (d) { FieldKit.emit("achievement:unlocked", d); });

    if (fresh.length && !opts.silent && !quiet) {
      var ui = FieldKit.service("ui");
      if (!ui) return fresh;
      /* THREE AT ONCE IS NOT THREE PIECES OF NEWS.

         Nine hundred milliseconds apart, five unlocks is four and a
         half seconds of the screen talking over whatever you were
         doing. Past two, it becomes one line that says how many and
         where to look — which is also the honest summary, because
         nobody reads the fourth toast in a queue anyway. */
      if (fresh.length > 2) {
        ui.toast(fresh.length + " ACHIEVEMENTS UNLOCKED — OPEN ACHIEVEMENTS", "ok");
      } else {
        fresh.forEach(function (d, i) {
          setTimeout(function () { ui.toast("ACHIEVEMENT :: " + d.name, "ok"); }, i * 900);
        });
      }
    }
    return fresh;
  }

  /* ---- event hooks -------------------------------------------- */
  FieldKit.on("store:ready", function () {
    /* The session starts here, not when this file was parsed. A slow
       unlock — a long PBKDF2 on a school laptop — would otherwise
       have burned the whole quiet window on the lock screen. */
    restartQuietWindow();
    loadState().then(function () { evaluate({ silent: true }); });
  });
  FieldKit.on("store:changed", function () { evaluate(); });
  FieldKit.on("store:state", function (e) {
    if (e && e.state === "ONLINE" && !counters.everOnline) { counters.everOnline = true; saveCounters(); }
    if (e && e.state === "OFFLINE") { /* nothing yet — the write itself counts */ }
  });

  function noteOfflineWrite() { counters.offlineWrites = (counters.offlineWrites || 0) + 1; saveCounters(); }
  function notePaletteUse() { counters.paletteUses = (counters.paletteUses || 0) + 1; saveCounters(); }
  function noteTier1() { counters.tier1Answers = (counters.tier1Answers || 0) + 1; saveCounters(); }
  function noteThemeSeen(id) {
    counters.themesSeen = counters.themesSeen || [];
    if (counters.themesSeen.indexOf(id) < 0) { counters.themesSeen.push(id); saveCounters(); }
  }
  function noteIncidentMatch() { counters.matchedIncident = true; saveCounters(); }

  FieldKit.on("ui:theme", function (e) { if (e && e.id) noteThemeSeen(e.id); });

  /* ---- the rest of the hooks -----------------------------------
     Everything below rides on events the app already emits, so no
     module had to be edited to make these reachable. Each one bumps a
     counter and asks for a re-evaluation; the debounce on
     saveCounters() keeps a burst of them to one write.

     bump() ignores everything while the self-test is suspended,
     because the exercise opens windows, runs suites and takes
     snapshots for real, and awarding MISSION CONTROL for the harness
     doing that would be awarding it to the harness. */
  function bump(key, by) {
    if (suspended) return;
    counters[key] = (counters[key] || 0) + (by == null ? 1 : by);
    saveCounters();
    evaluate();
  }

  FieldKit.on("store:remote", function (e) {
    /* Only a pull that actually brought something down. An empty poll
       every thirty seconds is not a postcard. */
    if (!e) return;
    var n = (e.added || 0) + (e.updated || 0) + (e.removed || 0);
    if (n > 0) bump("remotePulls");
  });
  FieldKit.on("store:overwrote", function () { bump("overwrites"); });
  FieldKit.on("store:synced", function (e) {
    if (e && e.pushed > 0) bump("syncedBatches", e.pushed);
  });
  FieldKit.on("backup:snapshot", function () { bump("snapshots"); });
  FieldKit.on("lock:engaged", function () { bump("locksEngaged"); });
  FieldKit.on("ai2:ready", function () { bump("tier2Loads"); });

  FieldKit.on("egg:found", function (e) {
    /* The egg engine already knows the running total and it is the
       honest source — a counter of its own would drift the first time
       one is found in a session that cannot write. */
    if (suspended || !e || !e.count) return;
    if ((counters.eggsFound || 0) >= e.count) return;
    counters.eggsFound = e.count;
    saveCounters();
    evaluate();
  });

  FieldKit.on("selftest:done", function (report) {
    if (suspended || !report || report.suite !== "exercise") return;
    counters.exerciseRuns = (counters.exerciseRuns || 0) + 1;
    if (!report.failed) counters.cleanExercises = (counters.cleanExercises || 0) + 1;
    saveCounters();
    evaluate();
  });

  FieldKit.on("shell:open", function (e) {
    if (suspended || !e || !e.id) return;
    var dirty = false;
    counters.modulesOpened = counters.modulesOpened || [];
    if (counters.modulesOpened.indexOf(e.id) < 0) { counters.modulesOpened.push(e.id); dirty = true; }

    var sh = FieldKit.service("shell");
    try {
      var open = (sh && sh.openWindows && sh.openWindows().length) || 0;
      if (open > (counters.maxWindows || 0)) { counters.maxWindows = open; dirty = true; }
    } catch (e2) { /* no shell here; the window count simply does not move */ }

    if (dirty) { saveCounters(); evaluate(); }
  });

  /* ---- panel -------------------------------------------------- */
  var panelNodes = {};

  FieldKit.register("achievements", {
    title: "ACHIEVEMENTS",
    icon: "✦",
    group: "SYSTEM",
    about: "Achievements you have unlocked, and the secrets still hidden",
    keywords: "achievements badges trophies secrets",
    width: 640,
    height: 560,

    selfcheck: function () {
      return [
        { name: "DEFINITIONS INTACT", critical: false, run: async function () {
          var ids = DEFS.map(function (d) { return d.id; });
          if (new Set(ids).size !== ids.length) throw new Error("duplicate achievement ids");
          var bad = DEFS.find(function (d) { return !d.id || !d.name || !d.desc || typeof d.test !== "function"; });
          if (bad) throw new Error("malformed definition: " + (bad && bad.id));
          return DEFS.length + " definitions, all well-formed";
        } },
        /* The two ways the category table rots: a new achievement
           added without one, and an id left behind in CATEGORIES after
           its definition was renamed. Both are invisible on screen —
           the first drops into UNSORTED, the second silently shortens
           a group — so they are asserted rather than eyeballed. */
        { name: "EVERY ACHIEVEMENT HAS A CATEGORY", critical: false, run: async function () {
          var placed = {};
          var dupes = [], unknown = [];
          CATEGORIES.forEach(function (c) {
            c.ids.forEach(function (id) {
              if (placed[id]) dupes.push(id);
              placed[id] = true;
              if (!DEFS.some(function (d) { return d.id === id; })) unknown.push(id);
            });
          });
          if (unknown.length) throw new Error("CATEGORIES names ids that do not exist: " + unknown.join(", "));
          if (dupes.length) throw new Error("listed in two categories: " + dupes.join(", "));
          var orphan = DEFS.filter(function (d) { return !placed[d.id]; }).map(function (d) { return d.id; });
          if (orphan.length) throw new Error("no category for: " + orphan.join(", "));
          return CATEGORIES.length + " categories covering all " + DEFS.length;
        } },
        /* Awarding something nobody can reach is worse than not having
           it — the panel shows a permanent LOCKED with no way in. Every
           test is run against a stat object with every key missing and
           then one with every key generously high; a definition that
           cannot flip between those two reads a key nothing supplies. */
        { name: "EVERY ACHIEVEMENT IS REACHABLE", critical: true, run: async function () {
          var keys = Object.keys((await gather()) || {});
          if (!keys.length) throw new Error("SKIPPED — vault is locked, no stats to shape a probe from");
          /* A couple of stats count what is MISSING, so "generous"
             for them is zero, not ten thousand. Getting this wrong
             makes the probe report a reachable achievement as dead. */
          var INVERTED = ["modulesUnseen"];
          var high = {}, low = {};
          keys.forEach(function (k) {
            high[k] = INVERTED.indexOf(k) >= 0 ? 0 : 10000;
            low[k] = 0;
          });
          var never = [], always = [];
          DEFS.forEach(function (d) {
            var hi, lo;
            try { hi = !!d.test(high); } catch (e) { hi = false; }
            try { lo = !!d.test(low); } catch (e) { lo = false; }
            if (!hi) never.push(d.id);
            if (lo) always.push(d.id);
          });
          if (never.length) throw new Error("cannot ever unlock: " + never.join(", "));
          if (always.length) throw new Error("unlocks on an empty vault: " + always.join(", "));
          return "all " + DEFS.length + " respond to the stats gather() actually produces";
        } },
        { name: "PROGRESS RENDERS", critical: false, run: async function () {
          var s = FieldKit.service("store");
          if (!s || !s.isUnlocked()) throw new Error("SKIPPED — vault is locked");
          if (!panelNodes.list || !panelNodes.list.children.length) {
            throw new Error("achievement list did not render");
          }
          var rows = panelNodes.list.querySelectorAll(".ac-item").length;
          var heads = panelNodes.list.querySelectorAll(".ac-cat").length;
          if (rows !== DEFS.length) {
            throw new Error("expected " + DEFS.length + " rows, rendered " + rows);
          }
          if (heads !== grouped().length) {
            throw new Error("expected " + grouped().length + " category headers, drew " + heads);
          }
          var got = Object.keys(unlocked).filter(function (k) {
            return DEFS.some(function (d) { return d.id === k; });
          }).length;
          return got + " / " + DEFS.length + " unlocked";
        } },
        { name: "EVALUATION IS IDEMPOTENT", critical: false, run: async function () {
          var s = FieldKit.service("store");
          if (!s || !s.isUnlocked()) throw new Error("SKIPPED — vault is locked");
          /* Running twice must not re-award anything, or the count
             drifts every time the panel is opened. */
          var before = Object.keys(unlocked).length;
          await evaluate({ silent: true });
          await evaluate({ silent: true });
          var after = Object.keys(unlocked).length;
          if (after !== before) throw new Error("count moved from " + before + " to " + after +
            " with no new activity");
          return "stable at " + after;
        } }
      ];
    },

    async mount(host, ctx) {
      var ui = ctx.ui, el = ui.el;
      injectCSS();

      var list = el("div", { class: "ac-list" });
      var summary = el("div");
      panelNodes = { list: list, summary: summary };

      async function render() {
        await evaluate({ silent: true });
        var got = Object.keys(unlocked).filter(function (k) {
          return DEFS.some(function (d) { return d.id === k; });
        }).length;

        ui.clear(summary);
        summary.appendChild(ui.readout([
          { label: "UNLOCKED", value: got + " / " + DEFS.length,
            level: got === DEFS.length ? "pass" : "info" },
          { label: "COMPLETION", value: Math.round((got / DEFS.length) * 100) + "%", level: "dim" }
        ]));

        var bar = el("div", { class: "ac-bar" }, [
          el("span", { class: "ac-bar-fill", style: { width: (got / DEFS.length * 100) + "%" } })
        ]);
        summary.appendChild(bar);

        ui.clear(list);
        grouped().forEach(function (g) {
          var have = g.defs.filter(function (d) { return unlocked[d.id]; }).length;
          list.appendChild(el("div", { class: "ac-cat" }, [
            el("span", { text: g.name }),
            el("span", { class: "ac-cat-n", text: have + "/" + g.defs.length })
          ]));
          g.defs.forEach(function (d) {
            var u = unlocked[d.id];
            list.appendChild(el("div", { class: "ac-item" + (u ? " got" : "") }, [
              el("span", { class: "ac-icon", text: u ? d.icon : "▢" }),
              el("span", { class: "ac-body" }, [
                /* A locked row keeps its description. Hiding the name
                   is the tease; hiding what it wants would just make
                   the panel useless. */
                el("span", { class: "ac-name", text: u ? d.name : "LOCKED" }),
                el("span", { class: "ac-desc", text: d.desc })
              ]),
              el("span", { class: "ac-when", text: u ? new Date(u.at).toLocaleDateString() : "" })
            ]));
          });
        });
      }

      host.appendChild(el("div", { class: "ac-wrap" }, [
        ui.panel("PROGRESS", [summary]),
        list
      ]));

      if (!ctx.store.isUnlocked()) {
        ui.clear(list);
        list.appendChild(el("div", { class: "ac-locked", text: "VAULT LOCKED — NO PROGRESS AVAILABLE" }));
        return;
      }
      await loadState();
      await render();
    },

    unmount() { panelNodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("ac-style")) return;
    var s = document.createElement("style");
    s.id = "ac-style";
    s.textContent = `
.ac-wrap{height:100%;overflow:auto}
.ac-bar{height:5px;background:#0b0e0c;border:1px solid var(--line2);margin-top:8px}
.ac-bar-fill{display:block;height:100%;background:var(--accent);
  box-shadow:0 0 8px rgba(var(--accent-glow),.6);transition:width .4s ease}
.ac-cat{display:flex;justify-content:space-between;align-items:baseline;
  margin:14px 0 2px;padding:3px 6px;font-size:9px;letter-spacing:.22em;
  color:var(--accent);border-bottom:1px solid var(--line2);
  background:linear-gradient(90deg,rgba(var(--accent-glow),.10),transparent)}
.ac-cat-n{color:var(--fg-dimmer);letter-spacing:.1em}
.ac-item{display:flex;align-items:flex-start;gap:10px;padding:8px 6px;
  border-bottom:1px solid var(--line);opacity:.45}
.ac-item.got{opacity:1}
.ac-icon{width:20px;flex:none;text-align:center;color:var(--fg-dimmer);font-size:15px}
.ac-item.got .ac-icon{color:var(--accent);text-shadow:0 0 10px rgba(var(--accent-glow),.6)}
.ac-body{flex:1;min-width:0}
.ac-name{display:block;font-size:11px;letter-spacing:.16em;color:var(--fg-dim)}
.ac-item.got .ac-name{color:var(--accent)}
.ac-desc{display:block;font-size:10px;color:var(--fg-dimmer);margin-top:2px;line-height:1.45}
.ac-when{flex:none;font-size:9px;color:var(--fg-dimmer)}
.ac-locked{padding:20px;text-align:center;color:var(--warn);font-size:10px;letter-spacing:.18em}
`;
    document.head.appendChild(s);
  }

  FieldKit.provide("achievements", {
    DEFS: DEFS,
    CATEGORIES: CATEGORIES,
    evaluate: evaluate,
    loadState: loadState,
    /* Exposed so the stats can be asserted directly. Every unlock is
       a one-line predicate over this object, so it is the only place
       a streak or a burst window can actually be got wrong. */
    stats: gather,
    /* Returns the resume function. Used by the self-test sandbox. */
    suspend: suspend,
    isSuspended: isSuspended,
    /* Exposed for the suite: "does opening FieldKit announce
       anything" is the question this file gets asked most, and it
       should be answerable without waiting six seconds. */
    isQuiet: function () { return quiet; },
    endQuietPeriod: function () { clearTimeout(quietTimer); quiet = false; },
    sessionAge: function () { return Date.now() - openedAt; },
    unlocked: function () { return Object.assign({}, unlocked); },
    noteOfflineWrite: noteOfflineWrite,
    notePaletteUse: notePaletteUse,
    noteTier1: noteTier1,
    noteIncidentMatch: noteIncidentMatch
  });
})(window.FieldKit);
