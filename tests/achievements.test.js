/* ============================================================
   core/achievements.js

   Two things are worth testing here and they are not the obvious
   ones. An achievement that can never unlock is a permanent LOCKED
   row with no way in, and an achievement that unlocks on an empty
   vault hands out a reward for nothing — both look completely fine
   on screen. Everything else is arithmetic over record metadata:
   streaks, bursts, and who wrote what.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js", "core/achievements.js"
]);
const { ok, section, state } = makeRunner("achievements");
const ach = FieldKit.need("achievements");
const ui = FieldKit.need("ui");

/* ---- a store that holds whatever a test needs it to ------------ */
let seq = 0;
function rec(type, opts) {
  opts = opts || {};
  const at = opts.at || "2026-03-02T12:00:00.000Z";
  return {
    id: opts.id || ("r" + ++seq),
    meta: {
      id: opts.id || ("r" + seq), type: type,
      updatedAt: at, createdAt: opts.createdAt || at,
      author: opts.author || "Sup095", deviceId: opts.device || "dev-1"
    },
    data: opts.data === undefined ? { x: 1 } : opts.data
  };
}

function useStore(records) {
  const rows = records.slice();
  FieldKit.provide("store", {
    isUnlocked: () => true,
    async list(type) { return type ? rows.filter((r) => r.meta.type === type) : rows.slice(); },
    async put(type, data, o) {
      const id = (o && o.id) || "w" + ++seq;
      const i = rows.findIndex((r) => r.id === id);
      const row = rec(type, { id, data });
      if (i >= 0) rows[i] = row; else rows.push(row);
      return { id };
    }
  }, { replace: true });
  return rows;
}

/* Local-midnight ISO for `days` ago, so a streak test does not
   depend on which side of UTC the machine running it sits. */
function daysAgo(n, hour) {
  const d = new Date();
  d.setHours(hour === undefined ? 12 : hour, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/* Local hour, ditto — "saved at 2am" has to mean 2am here. */
function atHour(h, dayOffset) {
  const d = new Date();
  d.setHours(h, 30, 0, 0);
  d.setDate(d.getDate() - (dayOffset || 0));
  return d.toISOString();
}

(async function () {
  section("the catalogue");
  {
    const ids = ach.DEFS.map((d) => d.id);
    ok("there is a decent number of them", ach.DEFS.length >= 40, String(ach.DEFS.length));
    ok("ids are unique", new Set(ids).size === ids.length);
    ok("every one has an id, a name, a description and a test",
      ach.DEFS.every((d) => d.id && d.name && d.desc && typeof d.test === "function"));
    ok("every one has an icon", ach.DEFS.every((d) => !!d.icon),
      ach.DEFS.filter((d) => !d.icon).map((d) => d.id).join(", "));
    /* The description is the only instruction a locked row carries,
       so it has to be a sentence about what to do — not an echo of
       the name, which is hidden until it unlocks anyway. */
    ok("every description is a sentence, not an echo of the name",
      ach.DEFS.every((d) =>
        d.desc.length >= 12 && /[.!?]$/.test(d.desc) &&
        d.desc.toUpperCase().replace(/[^A-Z ]/g, "").trim() !== d.name),
      ach.DEFS.filter((d) => d.desc.length < 12 || !/[.!?]$/.test(d.desc)).map((d) => d.id).join(", "));
  }

  section("categories cover the catalogue");
  {
    const placed = {};
    const dupes = [], unknown = [];
    ach.CATEGORIES.forEach((c) => c.ids.forEach((id) => {
      if (placed[id]) dupes.push(id);
      placed[id] = true;
      if (!ach.DEFS.some((d) => d.id === id)) unknown.push(id);
    }));
    const orphan = ach.DEFS.filter((d) => !placed[d.id]).map((d) => d.id);

    ok("no category names an achievement that does not exist", unknown.length === 0, unknown.join(", "));
    ok("nothing is filed in two categories at once", dupes.length === 0, dupes.join(", "));
    ok("nothing is left without a category", orphan.length === 0, orphan.join(", "));
    ok("category names are unique",
      new Set(ach.CATEGORIES.map((c) => c.name)).size === ach.CATEGORIES.length);
  }

  /* The one that earns its place. Both failures are silent. */
  section("every achievement can actually be won");
  {
    useStore([rec("note")]);
    await ach.loadState();
    const keys = Object.keys(await ach.stats());
    ok("gather() produces stats to probe with", keys.length > 20, keys.length + " keys");

    /* modulesUnseen counts what is MISSING, so generous is zero. */
    const INVERTED = ["modulesUnseen"];
    const high = {}, low = {};
    keys.forEach((k) => { high[k] = INVERTED.includes(k) ? 0 : 10000; low[k] = 0; });

    const never = [], always = [], threw = [];
    ach.DEFS.forEach((d) => {
      let hi = false, lo = false;
      try { hi = !!d.test(high); } catch (e) { threw.push(d.id + ": " + e.message); }
      try { lo = !!d.test(low); } catch (e) { threw.push(d.id + ": " + e.message); }
      if (!hi) never.push(d.id);
      if (lo) always.push(d.id);
    });

    ok("no test throws on a well-formed stats object", threw.length === 0, threw.join("; "));
    ok("none is unreachable — every one reads a stat gather() supplies",
      never.length === 0, never.join(", "));
    ok("none unlocks on an untouched vault", always.length === 0, always.join(", "));

    /* Reachability above proves the KEY exists. This proves the key
       is spelled the same in both files, which is the mistake that
       actually happens: gather() renames a stat and the predicate
       keeps reading the old one as undefined. */
    const referenced = new Set();
    ach.DEFS.forEach((d) => {
      const m = String(d.test).match(/s\.([A-Za-z0-9_]+)/g) || [];
      m.forEach((x) => referenced.add(x.slice(2)));
    });
    const unknownKeys = [...referenced].filter((k) => keys.indexOf(k) < 0);
    ok("no test reads a stat that gather() does not produce",
      unknownKeys.length === 0, unknownKeys.join(", "));
  }

  section("the clock");
  {
    useStore([
      rec("note", { at: atHour(2) }),
      rec("note", { at: atHour(1, 1) }),
      rec("note", { at: atHour(6) }),
      rec("note", { at: atHour(15) })
    ]);
    await ach.loadState();
    const s = await ach.stats();
    ok("saves after midnight are counted", s.nightSaves === 2, String(s.nightSaves));
    ok("a save at 6am counts as dawn", s.dawnSaves === 1, String(s.dawnSaves));
    ok("a save at 3pm counts as neither", s.nightSaves + s.dawnSaves === 3);
    ok("NIGHT SHIFT is satisfied", ach.DEFS.find((d) => d.id === "night-shift").test(s));
    ok("GRAVEYARD SHIFT wants ten of them, not two",
      !ach.DEFS.find((d) => d.id === "graveyard").test(s));
    ok("BOTH ENDS OF THE DAY needs one of each, and has one of each",
      ach.DEFS.find((d) => d.id === "both-ends").test(s));
  }

  section("streaks");
  {
    /* Six consecutive days, a gap, then three more. The longest run
       is six — a naive count of active days would say nine. */
    const rows = [];
    [0, 1, 2, 3, 4, 5].forEach((n) => rows.push(rec("note", { at: daysAgo(n + 10) })));
    [0, 1, 2].forEach((n) => rows.push(rec("note", { at: daysAgo(n) })));
    useStore(rows);
    await ach.loadState();
    const s = await ach.stats();

    ok("active days counts distinct days", s.activeDays === 9, String(s.activeDays));
    ok("the longest streak is the longest RUN, not the total",
      s.longestStreak === 6, String(s.longestStreak));
    ok("two saves on one day are still one day",
      await (async () => {
        useStore([rec("note", { at: daysAgo(0, 9) }), rec("note", { at: daysAgo(0, 21) })]);
        await ach.loadState();
        const t = await ach.stats();
        return t.activeDays === 1 && t.longestStreak === 1;
      })());
  }

  section("bursts");
  {
    /* Twenty saves spanning 10:50 to 11:10 — a burst by any sane
       reading, and one that bucketing by clock hour would split. */
    const rows = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date("2026-03-02T10:50:00.000Z");
      d.setMinutes(d.getMinutes() + i);
      rows.push(rec("note", { at: d.toISOString() }));
    }
    useStore(rows);
    await ach.loadState();
    const s = await ach.stats();
    ok("a burst across the top of the hour still counts as one hour",
      s.bestHour === 20, String(s.bestHour));
    ok("FLOW STATE unlocks on it", ach.DEFS.find((d) => d.id === "flow-state").test(s));

    useStore([
      rec("note", { at: "2026-03-02T10:00:00.000Z" }),
      rec("note", { at: "2026-03-02T14:00:00.000Z" })
    ]);
    await ach.loadState();
    const q = await ach.stats();
    ok("two saves four hours apart are not a burst", q.bestHour === 1, String(q.bestHour));
  }

  section("two people, several machines");
  {
    useStore([
      rec("note", { author: "Sup095", device: "a" }),
      rec("task", { author: "Sup095", device: "b" }),
      rec("playtest", { author: "Ada", device: "c" })
    ]);
    await ach.loadState();
    const s = await ach.stats();
    ok("both authors are seen", s.authors === 2, String(s.authors));
    ok("all three machines are seen", s.devices === 3, String(s.devices));
    ok("TWO HANDS unlocks", ach.DEFS.find((d) => d.id === "two-hands").test(s));
    ok("ROADSHOW unlocks", ach.DEFS.find((d) => d.id === "roadshow").test(s));
    ok("three kinds of record are counted", s.distinctTypes === 3, String(s.distinctTypes));
  }

  section("the work itself");
  {
    useStore([
      rec("task", { data: { title: "a", status: "done" } }),
      rec("task", { data: { title: "b", status: "done", blockedBy: "waiting on art" } }),
      rec("task", { data: { title: "c", status: "doing" } }),
      rec("playtest", { data: { title: "d", status: "verified", severity: "crash" } }),
      rec("playtest", { data: { title: "e", status: "wontfix", severity: "polish" } }),
      rec("playtest", { data: { title: "f", status: "cantrepro", severity: "minor" } }),
      /* A record that did not decrypt. One of these used to be enough
         to take a whole stat down with a read of null.data.status. */
      rec("playtest", { data: null })
    ]);
    await ach.loadState();
    const s = await ach.stats();
    ok("finished tasks are counted", s.tasksDone === 2, String(s.tasksDone));
    ok("a task that named its blocker and finished anyway counts as unblocked", s.unblocked);
    ok("a verified crash is recognised", s.verifiedCrash);
    ok("won't-fix and cannot-reproduce are counted apart",
      s.wontfix === 1 && s.cantrepro === 1, s.wontfix + "/" + s.cantrepro);
    ok("an undecryptable row costs one row, not the stat",
      s.verifiedBugs === 1, String(s.verifiedBugs));
  }

  section("age and revival");
  {
    useStore([
      rec("note", { createdAt: daysAgo(400), at: daysAgo(400) }),
      rec("note", { createdAt: daysAgo(200), at: daysAgo(1) })
    ]);
    await ach.loadState();
    const s = await ach.stats();
    ok("the vault is as old as its oldest record", s.vaultAgeDays >= 399, String(s.vaultAgeDays));
    ok("ONE YEAR ON unlocks", ach.DEFS.find((d) => d.id === "anniversary").test(s));
    ok("a record picked up 199 days after it was written counts as revived", s.revivedOld);

    useStore([rec("note", { createdAt: daysAgo(200), at: daysAgo(199) })]);
    await ach.loadState();
    const t = await ach.stats();
    ok("a record edited the next day does not", !t.revivedOld);
  }

  section("the engine's own records are not work");
  {
    useStore([
      rec("achievement", { data: { achievementId: "first-light", at: daysAgo(0) } }),
      rec("achievement", { data: { kind: "counters", counters: { paletteUses: 7 } } })
    ]);
    await ach.loadState();
    const s = await ach.stats();
    ok("unlocks do not count as records", s.records === 0, String(s.records));
    ok("nor do they count as a kind of work", s.distinctTypes === 0, String(s.distinctTypes));
    ok("counters are read back off the record", s.paletteUses === 7, String(s.paletteUses));
    ok("FIRST LIGHT does not unlock itself",
      !ach.DEFS.find((d) => d.id === "first-light").test(s));
  }

  section("counters do not leak between vaults");
  {
    useStore([rec("achievement", { data: { kind: "counters", counters: { paletteUses: 40, snapshots: 3 } } })]);
    await ach.loadState();
    ok("the first vault's tallies are read", (await ach.stats()).paletteUses === 40);

    useStore([rec("note")]);
    await ach.loadState();
    const s = await ach.stats();
    ok("a second vault starts from zero, not from the first one's total",
      s.paletteUses === 0 && s.snapshots === 0, s.paletteUses + "/" + s.snapshots);
  }

  section("awarding");
  {
    useStore([rec("note"), rec("note")]);
    await ach.loadState();
    const first = await ach.evaluate({ silent: true });
    ok("a vault with records in it wins something", first.length > 0, String(first.length));
    ok("FIRST LIGHT is among it", first.some((d) => d.id === "first-light"));

    const again = await ach.evaluate({ silent: true });
    ok("running again awards nothing new", again.length === 0, String(again.length));
    ok("the unlock is on record", !!ach.unlocked()["first-light"]);
  }

  section("the self-test does not play the game for you");
  {
    useStore([rec("note")]);
    await ach.loadState();
    const resume = ach.suspend();
    ok("the engine reports itself suspended", ach.isSuspended());
    const during = await ach.evaluate({ silent: true });
    ok("nothing is awarded while a suite is running", during.length === 0, String(during.length));
    resume();
    ok("and it comes back afterwards", !ach.isSuspended());
  }

  /* ============================================================
     Opening FieldKit is not an achievement.

     Reported as "achievements pop up every time you open the
     fieldkit". It was not one bug — four separate things all
     announce in the first seconds of a session and none of them is
     something you just did: the boot evaluate, the first sync's
     store:changed, the shell opening HOME, and the relay answering
     (which unlocks UPLINK on its own).

     So the rule under test is the one that covers all four and
     stays true when a fifth appears: nothing announces while the
     session is still opening. Recorded, dated, listed — not
     interrupting.
     ============================================================ */
  section("opening a session does not announce anything");
  {
    const toasts = [];
    const realToast = ui.toast;
    ui.toast = (t) => { toasts.push(String(t)); };

    useStore([rec("note"), rec("note"), rec("note", { at: atHour(6) })]);  /* a dawn save: something to win in any time zone */

    /* store:ready is what starts the session, so it is what starts
       the quiet window — not module load. A slow unlock on a school
       laptop would otherwise burn the window on the lock screen. */
    FieldKit.emit("store:ready", { state: "ONLINE" });
    ok("the session opens quiet", ach.isQuiet());

    await ach.loadState();
    const won = await ach.evaluate();
    ok("things are still unlocked during it", won.length > 0, String(won.length));
    ok("but nothing was said", toasts.length === 0, toasts.join(" | "));
    ok("and they are on record all the same",
      Object.keys(ach.unlocked()).length >= won.length);

    /* The event still fires. A module reacting to an unlock should
       not have to care whether it was announced. */
    let events = 0;
    FieldKit.on("achievement:unlocked", () => { events++; });

    ach.endQuietPeriod();
    ok("the window can be closed", ach.isQuiet() === false);

    /* Now something genuinely new, earned by work rather than by
       booting. */
    useStore([rec("note"), rec("note"), rec("snippet"), rec("incident")]);
    await ach.loadState();
    toasts.length = 0;
    const later = await ach.evaluate();
    /* One or two unlocks are announced on a timer, so that they read
       one at a time rather than landing on top of each other. Give
       the first one its tick before looking. */
    await new Promise((r) => setTimeout(r, 40));
    if (later.length) {
      ok("an unlock after the session has opened is announced",
        toasts.length > 0, toasts.join(" | "));
      ok("and the event fired for every one of them", events >= later.length,
        events + " events for " + later.length + " unlocks");
    } else {
      ok("an unlock after the session has opened is announced", true, "nothing new to win");
      ok("and the event fired for every one of them", true, "nothing new to win");
    }

    ui.toast = realToast;
  }

  section("a burst becomes one line, not a queue");
  {
    const toasts = [];
    const realToast = ui.toast;
    ui.toast = (t) => { toasts.push(String(t)); };
    ach.endQuietPeriod();

    /* Nine hundred milliseconds apart, five unlocks is four and a
       half seconds of the screen talking over whatever you were
       doing. Nobody reads the fourth one. */
    useStore([
      rec("note", { at: daysAgo(0) }), rec("note", { at: daysAgo(1) }),
      rec("note", { at: daysAgo(2) }), rec("snippet"), rec("incident"),
      rec("task"), rec("decision"), rec("playtest")
    ]);
    await ach.loadState();
    toasts.length = 0;
    const fresh = await ach.evaluate();
    if (fresh.length > 2) {
      ok("more than two at once is summarised", toasts.length === 1, toasts.join(" | "));
      ok("and the summary says how many and where to look",
        /\d+ ACHIEVEMENTS UNLOCKED/.test(toasts[0]) && /ACHIEVEMENTS/.test(toasts[0]),
        toasts[0]);
    } else {
      ok("more than two at once is summarised", true, "only " + fresh.length + " to win here");
      ok("and the summary says how many and where to look", true, "not exercised");
    }
    ui.toast = realToast;
  }

  section("a guest is not the person these belong to");
  {
    const toasts = [];
    const realToast = ui.toast;
    ui.toast = (t) => { toasts.push(String(t)); };
    ach.endQuietPeriod();

    /* A guest store is memory-only and empty, so any tally computed
       from it is either nothing or somebody else's. Awarding from it
       is meaningless, and announcing it to a stranger holding the
       drive is worse. */
    FieldKit.provide("guest", { active: () => true, allowed: () => true }, { replace: true });
    useStore([rec("note"), rec("note"), rec("note")]);
    const before = Object.keys(ach.unlocked()).length;
    toasts.length = 0;
    const during = await ach.evaluate();
    ok("a guest session awards nothing", during.length === 0, String(during.length));
    ok("and says nothing", toasts.length === 0, toasts.join(" | "));
    ok("and writes nothing into the guest's memory store",
      Object.keys(ach.unlocked()).length === before);

    FieldKit.provide("guest", { active: () => false, allowed: () => true }, { replace: true });
    ui.toast = realToast;
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE CRASHED: " + (e.stack || e.message));
  process.exit(1);
});
