/* ============================================================
   core/shell.js — the launcher: tiles and folders

   Thirty-seven modules do not fit on a Chromebook screen at a size
   you can hit, so they live in folders. That turns a flat render
   into something with state — which folder is open — and state in a
   layer that gets torn down and rebuilt on every module event is
   exactly where the last layout bug came from.

   So the assertions here are mostly about the rebuild: a folder
   open when a module registers must still be open afterwards, must
   contain the new module, and must close rather than render empty
   if the group it named has gone. The rest is that a guest cannot
   open a sealed tile from inside a folder either — the folder is a
   second path to open() and a second path is a second place to
   forget the check.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js", "core/shell.js"
]);
const { ok, section, state } = makeRunner("launcher");

const shell = FieldKit.need("shell");

/* A store stub, because the tray's REFRESH button asks for one at
   build time and a missing service would fail the mount rather than
   anything this suite is about. */
FieldKit.provide("store", {
  state: () => "ONLINE", isUnlocked: () => true, hasVault: () => true,
  pendingCount: async () => 0, transportName: () => "local",
  async pull() { return { added: 0, updated: 0, removed: 0 }; }
});

function reg(id, group, extra) {
  FieldKit.register(id, Object.assign({
    id: id, title: id.toUpperCase().replace(/-/g, " "), icon: "◆",
    group: group, mount: function (root) { root.appendChild(document.createElement("div")); }
  }, extra || {}));
}

/* Two groups, and enough in the first that the 2x2 preview has to
   choose which four to show. */
["alpha-one", "alpha-two", "alpha-three", "alpha-four", "alpha-five"]
  .forEach((id) => reg(id, "PROJECT"));
reg("beta-one", "TOOLS");
reg("beta-two", "TOOLS");

const root = document.createElement("div");
document.body.appendChild(root);
shell.build(root);

const icons = () => document.getElementById("fk-icons");
const all = (sel) => icons().querySelectorAll(sel);
const named = (sel, text) =>
  all(sel).find((n) => n.querySelectorAll(".n").some((x) => x.textContent === text)) || null;

(function () {
  section("the home screen is folders, not a wall of modules");
  {
    ok("a folder exists per group", all(".fk-folder").length === 2,
      String(all(".fk-folder").length));
    ok("no app tile is loose on the home screen when nothing is recent",
      all(".fk-app").length === 0, String(all(".fk-app").length));

    const project = named(".fk-folder", "PROJECT");
    ok("the PROJECT folder is there", !!project);
    ok("it says how many are inside",
      project.querySelector(".c").textContent === "5",
      project.querySelector(".c").textContent);

    /* The preview is the thing that makes a folder recognisable
       without reading it, and it is capped — five glyphs in a 2x2
       would silently drop one into a fifth cell. */
    ok("the preview shows four glyphs, not all five",
      project.querySelectorAll(".p").length === 4,
      String(project.querySelectorAll(".p").length));
    const tools = named(".fk-folder", "TOOLS");
    ok("a folder with fewer than four shows only what it has",
      tools.querySelectorAll(".p").length === 2,
      String(tools.querySelectorAll(".p").length));
  }

  section("clicking a folder opens it");
  {
    ok("nothing is open to begin with", all(".fk-folder-open").length === 0);
    named(".fk-folder", "PROJECT").click();

    ok("a panel appears", all(".fk-folder-open").length === 1);
    ok("it is titled with the folder name",
      icons().querySelector(".fk-folder-head").querySelector(".t").textContent === "PROJECT");
    ok("every module in the group is a full tile inside it",
      icons().querySelector(".fk-folder-panel").querySelectorAll(".fk-app").length === 5,
      String(icons().querySelector(".fk-folder-panel").querySelectorAll(".fk-app").length));
    ok("the folder tile marks itself as the open one",
      named(".fk-folder", "PROJECT").className.indexOf("open") >= 0);

    /* #fk-icons sits under the windows so tiles never cover a panel.
       An open folder has to come out from under them, or clicking a
       folder while anything is open does nothing visible. */
    ok("the icon layer lifts above the windows while a folder is open",
      icons().classList.contains("folder-open"));
  }

  section("and closing it puts everything back");
  {
    icons().querySelector(".fk-folder-back").click();
    ok("the panel is gone", all(".fk-folder-open").length === 0);
    ok("the icon layer drops back under the windows",
      !icons().classList.contains("folder-open"));

    named(".fk-folder", "TOOLS").click();
    ok("a different folder opens", all(".fk-folder-open").length === 1);
    named(".fk-folder", "TOOLS").click();
    ok("clicking the same folder again closes it", all(".fk-folder-open").length === 0);

    named(".fk-folder", "PROJECT").click();
    window.dispatchEvent({ type: "keydown", key: "Escape" });
    ok("escape closes an open folder", all(".fk-folder-open").length === 0);
  }

  section("opening an app closes the folder behind it");
  {
    named(".fk-folder", "TOOLS").click();
    icons().querySelector(".fk-folder-panel").querySelectorAll(".fk-app")[0].click();
    ok("the module opened", shell.openWindows().indexOf("beta-one") >= 0,
      shell.openWindows().join(","));
    ok("and the folder did not stay open over it", all(".fk-folder-open").length === 0);
    shell.close("beta-one");
  }

  section("a rebuild while a folder is open");
  {
    /* refreshIcons() clears the whole layer, and the open folder is
       inside it. Re-rendering from the remembered name rather than
       leaving the node standing is what keeps a late-registering
       module from being cleared away with the panel it should have
       appeared in. */
    named(".fk-folder", "TOOLS").click();
    reg("beta-three", "TOOLS");
    ok("the folder is still open after a module registers",
      all(".fk-folder-open").length === 1);
    ok("and the new module is inside it",
      !!icons().querySelector(".fk-folder-panel").querySelectorAll(".fk-app")
        .find((n) => n.querySelector(".n").textContent === "BETA THREE"));
    ok("the count on the tile went up",
      named(".fk-folder", "TOOLS").querySelector(".c").textContent === "3");
    icons().querySelector(".fk-folder-back").click();
  }

  section("the apps you use most stay loose on the home screen");
  {
    const USAGE = "fieldkit.usage.v1";
    const tiles = () => all(".fk-shelves").length ? icons().querySelector(".fk-shelves").querySelectorAll(".fk-app") : [];
    localStorage.removeItem(USAGE);
    localStorage.removeItem("fieldkit.recent.v1");
    shell.refreshIcons();
    ok("nothing used yet (and none of the usual apps here): no loose tiles", tiles().length === 0, String(tiles().length));

    shell.open("alpha-one"); shell.close("alpha-one");
    for (let i = 0; i < 3; i++) { shell.open("alpha-two"); shell.close("alpha-two"); }
    shell.refreshIcons();
    ok("each app used appears", tiles().length === 2, String(tiles().length));
    ok("the most used first", tiles()[0].querySelector(".n").textContent === "ALPHA TWO",
      tiles()[0].querySelector(".n").textContent);
    ok("and they are still in their folder as well",
      named(".fk-folder", "PROJECT").querySelector(".c").textContent === "5");

    /* Often AND lately: five uses two months ago lose to two today. */
    const now = Date.now();
    localStorage.setItem(USAGE, JSON.stringify({
      "alpha-three": { n: 5, at: now - 60 * 86400000 }, "alpha-four": { n: 2, at: now }, "gone-module": { n: 50, at: now }
    }));
    shell.refreshIcons();
    ok("last term's habit gives way to this week's", tiles()[0].querySelector(".n").textContent === "ALPHA FOUR",
      tiles().map((t) => t.querySelector(".n").textContent).join(","));
    ok("an app that no longer exists is not a dead shortcut", tiles().length === 2);

    localStorage.removeItem(USAGE);
    localStorage.setItem("fieldkit.recent.v1", JSON.stringify(["beta-two", "alpha-five"]));
    shell.refreshIcons();
    ok("the old recent list seeds the counts, in its order",
      tiles().map((t) => t.querySelector(".n").textContent).join(",") === "BETA TWO,ALPHA FIVE",
      tiles().map((t) => t.querySelector(".n").textContent).join(","));
    localStorage.setItem(USAGE, "{not json");
    shell.refreshIcons();
    ok("a damaged record is not fatal", tiles().length === 2);
    localStorage.removeItem(USAGE);
    localStorage.removeItem("fieldkit.recent.v1");
    shell.refreshIcons();
  }

  section("modules that did not load get their own folder");
  {
    FieldKit.markFailed("broken-thing", new Error("SyntaxError: unexpected }"));
    const bad = named(".fk-folder", "DID NOT LOAD");
    ok("a fault folder appears", !!bad);
    ok("it is marked as bad rather than looking like any other folder",
      bad.className.indexOf("bad") >= 0, bad.className);

    bad.click();
    const tile = icons().querySelector(".fk-folder-panel").querySelector(".fk-app");
    ok("the broken module is listed inside", !!tile);
    ok("its tile is marked dead", tile.className.indexOf("dead") >= 0, tile.className);
    ok("and the reason is on the tile rather than in a console nobody has",
      /failed to load/.test(tile.attributes.title || ""), tile.attributes.title);
    icons().querySelector(".fk-folder-back").click();
  }

  section("a guest sees the folders and cannot open what is sealed");
  {
    let opened = null;
    FieldKit.provide("guest", {
      active: () => true,
      allowed: (m) => !!(m && m.guestSafe === true),
      end() {}
    });
    reg("safe-tool", "TOOLS", { guestSafe: true });
    shell.refreshIcons();

    /* Sealed modules stay visible on purpose — a guest should be
       able to see the console is bigger than what they were handed,
       without being able to open any of it. */
    named(".fk-folder", "PROJECT").click();
    const tiles = icons().querySelector(".fk-folder-panel").querySelectorAll(".fk-app");
    ok("the folder still lists everything", tiles.length === 5, String(tiles.length));
    ok("but every tile in it is sealed",
      tiles.every((t) => t.className.indexOf("sealed") >= 0));

    const before = shell.openWindows().length;
    tiles[0].click();
    ok("clicking a sealed tile opens nothing",
      shell.openWindows().length === before, shell.openWindows().join(","));
    ok("and the folder stays open, since nothing happened",
      all(".fk-folder-open").length === 1);
    icons().querySelector(".fk-folder-back").click();

    named(".fk-folder", "TOOLS").click();
    const safe = icons().querySelector(".fk-folder-panel").querySelectorAll(".fk-app")
      .find((n) => n.querySelector(".n").textContent === "SAFE TOOL");
    ok("a guest-safe module is not sealed", safe.className.indexOf("sealed") < 0, safe.className);
    safe.click();
    ok("and it opens", shell.openWindows().indexOf("safe-tool") >= 0);
    shell.close("safe-tool");
    void opened;
  }

  /* A module that says it lives inside another one is a tab, not a
     tile. Three panels about the Bastion network became one icon
     that way, without any of them being rewritten — see
     modules/bastion.js. The launcher is the only place that knows,
     so it is the only place this can be tested. */
  section("a module can declare itself a tab of another");
  {
    const before = named(".fk-folder", "TOOLS").querySelector(".c").textContent;
    /* guest-safe, because a guest session is still installed from
       the section above and a sealed tile would fail open() for a
       reason that has nothing to do with `inside`. */
    reg("beta-hosted", "TOOLS", { inside: "beta-one", guestSafe: true });
    const after = named(".fk-folder", "TOOLS").querySelector(".c").textContent;
    ok("registering it does not add a tile", after === before, before + " -> " + after);

    named(".fk-folder", "TOOLS").click();
    const panel = icons().querySelector(".fk-folder-panel");
    const hosted = panel.querySelectorAll(".fk-app")
      .find((n) => n.querySelector(".n").textContent === "BETA HOSTED");
    ok("and it is not in the open folder either", !hosted);

    /* It is still a module. The terminal's `open` and the command
       palette both reach open() by id, and a tab that could not be
       opened that way would be a module nothing can reach. */
    ok("but it is still registered", !!FieldKit.module("beta-hosted"));
    shell.open("beta-hosted");
    ok("and open() still puts it on screen",
      shell.openWindows().indexOf("beta-hosted") >= 0, shell.openWindows().join(","));
    shell.close("beta-hosted");
    icons().querySelector(".fk-folder-back").click();
  }

  /* ============================================================
     Windows you can actually resize.

     The bug this section exists for: both drag and resize listened
     for mousemove on `document`, which stops receiving events the
     moment the pointer crosses an <iframe> — the iframe's document
     gets them instead and this one is never told. BROWSER is a
     window that is almost entirely iframe, so dragging its edge
     inward moved a few pixels and froze. Nothing threw.

     The assertions are about the mechanism rather than about
     pixels, because the mechanism is the fix: pointer events
     captured on the handle are delivered to the handle no matter
     what is underneath.
     ============================================================ */
  section("a window can be resized even when it is full of iframe");
  {
    /* Its own module, guest-safe: a guest session is still installed
       from the section above, and a sealed module would return null
       from open() for a reason that has nothing to do with resizing. */
    reg("win-lab", "TOOLS", { guestSafe: true });
    const rec = shell.open("win-lab");
    const node = rec.node;

    /* The fake DOM has no layout, so the numbers the handler reads
       are supplied here. What is being tested is the arithmetic and
       the wiring, not the browser's box model. */
    node.offsetWidth = 500; node.offsetHeight = 340;
    node.offsetLeft = 100; node.offsetTop = 60;

    const se = node.querySelector(".fk-win-resize");
    const east = node.querySelector(".fk-win-grip.e");
    const west = node.querySelector(".fk-win-grip.w");
    const south = node.querySelector(".fk-win-grip.s");
    ok("there are edge handles, not just one corner",
      !!se && !!east && !!west && !!south);

    /* The whole fix, stated as an assertion: nothing listens on
       document. If this fails, resizing works right up until the
       pointer touches a page. */
    ok("the handles listen for pointer events",
      !!(se._listeners && se._listeners.pointerdown),
      Object.keys(se._listeners || {}).join(","));
    ok("and not for mousedown, which cannot survive an iframe",
      !(se._listeners && se._listeners.mousedown));

    function drag(handle, from, to) {
      const ev = (x, y) => ({ type: "", clientX: x, clientY: y, pointerId: 1, button: 0,
        target: handle, preventDefault() {}, stopPropagation() {} });
      handle.dispatchEvent(Object.assign(ev(from[0], from[1]), { type: "pointerdown" }));
      handle.dispatchEvent(Object.assign(ev(to[0], to[1]), { type: "pointermove" }));
      handle.dispatchEvent(Object.assign(ev(to[0], to[1]), { type: "pointerup" }));
    }

    drag(se, [600, 400], [800, 540]);
    ok("the corner grows both dimensions",
      node.style.width === "700px" && node.style.height === "480px",
      node.style.width + " x " + node.style.height);

    node.offsetWidth = 700; node.offsetHeight = 480;
    drag(east, [800, 200], [900, 999]);
    ok("the east edge changes width only",
      node.style.width === "800px" && node.style.height === "480px",
      node.style.width + " x " + node.style.height);

    node.offsetWidth = 800;
    drag(south, [400, 540], [999, 600]);
    ok("the south edge changes height only",
      node.style.width === "800px" && node.style.height === "540px",
      node.style.width + " x " + node.style.height);

    /* West moves the left edge, which means left and width have to
       change together — otherwise the window grows to the right
       while the pointer goes left. */
    node.offsetWidth = 800; node.offsetHeight = 540; node.offsetLeft = 100;
    drag(west, [100, 300], [40, 300]);
    ok("the west edge moves the left side rather than the right",
      node.style.width === "860px" && node.style.left === "40px",
      node.style.width + " @ " + node.style.left);

    /* A minimum, so a window cannot be dragged down to nothing and
       become unrecoverable. */
    node.offsetWidth = 860; node.offsetHeight = 540; node.offsetLeft = 40;
    drag(se, [900, 580], [0, 0]);
    ok("and it cannot be shrunk out of existence",
      node.style.width === "280px" && node.style.height === "150px",
      node.style.width + " x " + node.style.height);

    shell.close("win-lab");
  }

  section("maximise, and the size it puts back");
  {
    const rec = shell.open("win-lab");
    const node = rec.node;
    node.offsetWidth = 500; node.offsetHeight = 340;

    const btns = node.querySelectorAll(".fk-win-btn");
    ok("the title bar carries minimise, maximise, fullscreen and close",
      btns.length === 4, String(btns.length));

    const before = { w: node.style.width, h: node.style.height,
      l: node.style.left, t: node.style.top };

    shell.maximize("win-lab");
    ok("maximising is a class, so the CSS decides the geometry",
      node.classList.contains("maximized"));
    /* Cleared rather than set to the desktop's size: an inline width
       would win over the class the next time the desktop changed
       size, and a maximised window that does not follow the window
       is worse than one that never maximised. */
    ok("and the inline geometry is cleared out of its way",
      node.style.width === "" && node.style.height === "");

    /* Dragging a maximised window would leave it maximised and half
       off the screen, so it does not move. */
    const bar = rec.bar;
    node.offsetLeft = 0; node.offsetTop = 0;
    bar.dispatchEvent({ type: "pointerdown", clientX: 200, clientY: 8, pointerId: 2, button: 0,
      target: bar, preventDefault() {}, stopPropagation() {} });
    bar.dispatchEvent({ type: "pointermove", clientX: 500, clientY: 300, pointerId: 2,
      target: bar, preventDefault() {}, stopPropagation() {} });
    ok("a maximised window does not drag", node.style.left === "" || node.style.left === "0px",
      node.style.left);

    shell.maximize("win-lab");
    ok("restoring gives back the size it replaced, not a guess",
      node.style.width === before.w && node.style.height === before.h &&
      node.style.left === before.l && node.style.top === before.t,
      node.style.width + " x " + node.style.height + " @ " +
      node.style.left + "," + node.style.top);
    ok("and the class is gone", !node.classList.contains("maximized"));

    shell.close("win-lab");
  }

  section("fullscreen is the real API, and says when it is refused");
  {
    const rec = shell.open("win-lab");
    let asked = 0;
    rec.node.requestFullscreen = function () { asked++; return Promise.reject(new Error("blocked by policy")); };
    ok("the shell offers it to modules", typeof shell.fullscreen === "function");
    ok("and can be asked whether it is on", shell.isFullscreen() === false);
    shell.fullscreen("win-lab");
    ok("pressing it asks the element, not the document", asked === 1);
    shell.close("win-lab");
  }

  /* ============================================================
     The tray says which transport it is online through.

     ONLINE is a fact about the store answering, not about the relay
     being up: with no relay configured the store is perfectly online
     against IndexedDB, and the tray used to print RELAY ONLINE for
     that. It is the one line you would glance at to decide whether
     what you just wrote is reaching the other person, so it saying
     RELAY when there is no relay is worse than it saying nothing.
     ============================================================ */
  section("search finds an app by its name, by what it does, and by its group");
  {
    reg("browser", "ONLINE", { title: "BROWSER", about: "Browse the web through the relay", keywords: "web internet site google", guestSafe: true });
    reg("savecode", "FILES", { title: "SAVE CODES", about: "Decode, edit and compare a game's save codes", keywords: "save code decode game", guestSafe: true });
    reg("messages", "ONLINE", { title: "MESSAGES", about: "Encrypted chat with your people", keywords: "chat dm talk friends", guestSafe: true });
    const ids = (q) => shell.search(q).map((h) => h.id);
    ok("by the start of its name", ids("brow")[0] === "browser", ids("brow").join());
    ok("by a word it is known by", ids("internet")[0] === "browser" && ids("talk")[0] === "messages");
    ok("by what it does, every word counting", ids("edit save")[0] === "savecode" && ids("edit save").indexOf("browser") < 0,
      ids("edit save").join());
    ok("by its group", ids("online").indexOf("browser") >= 0 && ids("online").indexOf("messages") >= 0);
    ok("letters in order find a name", ids("svcd").indexOf("savecode") >= 0, ids("svcd").join());
    ok("nonsense finds nothing", ids("zqxj").length === 0);
    shell.search("");
    ok("an empty search shows the home screen", !icons().classList.contains("searching"));

    /* Typing on the desktop. */
    const input = icons().querySelector(".fk-search-in");
    const key = (k, target) => window.dispatchEvent({ type: "keydown", key: k, target: target || document.body });
    key("b"); key("r");
    ok("typing anywhere on the desktop goes into the search", input.value === "br", input.value);
    ok("and the home screen gives way to the results", icons().classList.contains("searching"));
    ok("the first result is marked as the one Enter opens",
      icons().querySelector(".fk-hit.sel").querySelector(".n").textContent === "BROWSER");
    ok("the last row offers the rest to Ctrl+K", !!icons().querySelector(".fk-hit.more"));
    input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
    ok("Enter opens the first hit", shell.openWindows().indexOf("browser") >= 0, shell.openWindows().join());
    ok("and clears the search", input.value === "" && !icons().classList.contains("searching"));

    const winNode = document.getElementById("fk-windows").querySelectorAll("div")[0];
    key("x", winNode);
    ok("typing inside a window stays in the window", input.value === "", input.value);
    const other = document.createElement("input");
    document.body.appendChild(other);
    key("x", other);
    ok("typing into a box stays in the box", input.value === "");
    window.dispatchEvent({ type: "keydown", key: "k", ctrlKey: true, target: document.body });
    ok("a shortcut is not typing", input.value === "");
    key("z");
    ok("with a window just opened, keys are the window's even when nothing in it has focus", input.value === "", input.value);
    const desk = document.getElementById("fk-desktop");
    desk.dispatchEvent({ type: "mousedown", target: icons() });
    key("z");
    ok("once the desktop itself is clicked, typing searches again", input.value === "z", input.value);
    input.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
    desk.dispatchEvent({ type: "mousedown", target: winNode });
    key("z");
    ok("and clicking back into the window gives it the keys", input.value === "", input.value);
    shell.close("browser");

    key("s"); key("a");
    input.dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault() {} });
    ok("arrows move the choice", icons().querySelectorAll(".fk-hit")[1].className.indexOf("sel") >= 0);
    input.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
    ok("Escape clears it", input.value === "" && !icons().classList.contains("searching"));

    const tiles = () => icons().querySelector(".fk-shelves").querySelectorAll(".fk-app");
    localStorage.removeItem("fieldkit.usage.v1");
    shell.refreshIcons();
    ok("with little used yet, the usual apps fill the top row",
      tiles().some((t) => t.querySelector(".n").textContent === "BROWSER") &&
      tiles().some((t) => t.querySelector(".n").textContent === "MESSAGES"),
      tiles().map((t) => t.querySelector(".n").textContent).join(","));
    const card = named(".fk-folder", "ONLINE");
    ok("a folder card says what is inside it", /BROWSER/.test(card.querySelector(".s").textContent) &&
      /MESSAGES/.test(card.querySelector(".s").textContent), card.querySelector(".s").textContent);
  }

  section("the tray names the transport, not just the state");
  {
    const tray = document.querySelector(".fk-status");
    const label = () => tray.querySelectorAll("span")
      .map((n) => n.textContent).join("").trim();

    /* The stub at the top of this file is a local transport. */
    ok("local storage is not announced as a live relay",
      label() !== "RELAY ONLINE", label());
    ok("and it says what it actually is", /LOCAL ONLY/.test(label()), label());
    ok("in the colour of a caveat, not an all-clear",
      /fk-status-warn/.test(tray.className), tray.className);

    FieldKit.provide("store", {
      state: () => "ONLINE", isUnlocked: () => true, hasVault: () => true,
      pendingCount: async () => 0, transportName: () => "relay",
      async pull() { return { added: 0, updated: 0, removed: 0 }; }
    }, { replace: true });
    FieldKit.emit("store:state", { state: "ONLINE" });
    ok("a real relay does get the green line", label() === "RELAY ONLINE", label());
    ok("and the all-clear colour with it",
      /fk-status-ok/.test(tray.className), tray.className);

    FieldKit.provide("store", {
      state: () => "ONLINE", isUnlocked: () => true, hasVault: () => true,
      pendingCount: async () => 0, transportName: () => "memory",
      async pull() { return { added: 0, updated: 0, removed: 0 }; }
    }, { replace: true });
    FieldKit.emit("store:state", { state: "ONLINE" });
    ok("a guest's memory store is named too", /MEMORY ONLY/.test(label()), label());

    /* Everything that is not ONLINE was already honest; check one so
       a rewrite of the map cannot quietly drop the rest. */
    FieldKit.emit("store:state", { state: "LOCKED" });
    ok("the other states are untouched", label() === "LOCKED", label());

    /* OUTPOST runs this same shell against a different store, and
       the first version of the label crashed its boot outright: the
       state map was a literal, so the ONLINE entry called
       transportName() on every render — including the renders of a
       page whose state is LOCAL and whose store had no such method.
       Both halves are asserted, because fixing only the missing
       method would leave the eager call waiting for the next store
       that does not have something. */
    FieldKit.provide("store", {
      state: () => "LOCAL", isUnlocked: () => true, hasVault: () => false,
      pendingCount: async () => 0,
      async pull() { return { added: 0, updated: 0, removed: 0 }; }
    }, { replace: true });
    let crashed = null;
    try { FieldKit.emit("store:state", { state: "LOCAL" }); }
    catch (e) { crashed = e.message; }
    ok("a store with no transportName does not take the tray down",
      crashed === null, String(crashed));
    ok("and the state it does have is still shown", label() === "LOCAL", label());
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures && state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(state.fail ? 1 : 0);
})();
