/* ============================================================
   modules/browser.js — the client

   The server half is tested in tests/browse.test.js, and after the
   controls moved into the frame that is most of the behaviour. What
   is left on this side is small and specific:

     - the iframe's sandbox, which is the last thing standing if the
       relay's script stripper ever misses one, and which now has to
       grant exactly one capability rather than none;
     - that no credential reaches a URL, the entire reason the ticket
       mechanism exists;
     - that srcdoc and src never coexist, because when they did the
       whole panel silently did nothing;
     - that this side has not started steering the frame again, which
       is the mistake the server-rendered toolbar exists to prevent.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js", "modules/browser.js"
]);
const { ok, section, state } = makeRunner("browser");

const settings = FieldKit.need("settings");
const ui = FieldKit.need("ui");
const def = FieldKit.modules().browser;

const host = fakeElement("div");
const ctx = { settings, ui, log() {}, warn() {}, error() {}, on() {}, emit() {} };

function all(node) {
  const out = [];
  (function walk(n) {
    (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } });
  })(node);
  return out;
}
function byClass(c) {
  return all(host).filter((n) => String(n.className || "").split(/\s+/).includes(c));
}
function button(label) {
  return all(host).find((n) => n.tagName === "BUTTON" && n.textContent === label);
}
const settle = () => new Promise((r) => setTimeout(r, 30));

/* A ticket source, in the shape the real ones have: the credential's
   owner does the exchange and hands back only a ticket, so this
   module never holds anything that could do more than browse. */
let ticketsIssued = 0;
let ticketFails = null;
FieldKit.provide("store", { isUnlocked: () => true });
FieldKit.provide("transportRelay", {
  browseTicket: async () => {
    if (ticketFails) throw ticketFails;
    ticketsIssued++;
    return { ticket: "TESTTICKET" + ticketsIssued, expiresIn: 1800 };
  }
});

(async function () {
  section("the module declares itself honestly");
  {
    ok("it registered", !!def);
    ok("it is not offered to guests in the full build", def.guestSafe === false);
    ok("it brings selfchecks", typeof def.selfcheck === "function");
    ok("it unmounts", typeof def.unmount === "function");
  }

  section("with no relay it says so rather than showing a dead frame");
  {
    settings.set("relayUrl", "");
    await def.mount(host, ctx);
    ok("it explains the relay is missing",
      byClass("br-empty-h").some((n) => n.textContent === "NO RELAY CONFIGURED"));
    ok("and builds no frame at all", all(host).filter((n) => n.tagName === "IFRAME").length === 0);
    def.unmount();
    host.children.length = 0;
  }

  section("the frame");
  {
    settings.set("relayUrl", "https://relay.example");
    await def.mount(host, ctx);
    await settle();

    const frame = all(host).find((n) => n.tagName === "IFRAME");
    ok("an iframe is what renders the page", !!frame);

    const sandbox = frame.getAttribute("sandbox");
    ok("the sandbox attribute is present", sandbox !== null && sandbox !== undefined);
    /* Scripts run now. They did not used to, and the change is the
       whole reason most sites render at all — a modern page's HTML
       is a loading screen. What is asserted here is the shape of the
       trade, not that the trade was avoided. */
    ok("scripts can run, or the shim does not exist and neither does most of the web",
      /allow-scripts/.test(String(sandbox)));
    ok("the frame keeps a real origin, so localStorage returns instead of throwing",
      /allow-same-origin/.test(String(sandbox)));
    ok("forms can submit, which is what the served toolbar is made of",
      /allow-forms/.test(String(sandbox)), String(sandbox));
    ok("window.open works rather than returning null",
      /allow-popups/.test(String(sandbox)));

    /* The ones that would let a proxied page out of the frame. These
       stay absent, and with scripts running they are the only thing
       between the page and the rest of the machine. */
    ok("nothing can navigate the console out from under itself",
      !/allow-top-navigation/.test(String(sandbox)));
    ok("a popup cannot shed the sandbox on its way out",
      !/allow-popups-to-escape-sandbox/.test(String(sandbox)));
    ok("a page cannot write to the host with a download",
      !/allow-downloads/.test(String(sandbox)));
    ok("a page cannot freeze the console with a modal loop",
      !/allow-modals/.test(String(sandbox)));
    ok("no referrer goes upstream", frame.getAttribute("referrerpolicy") === "no-referrer");

    /* An equality, so a token nobody argued for cannot appear
       quietly. Adding one means editing this line and saying why.

       The three that were added, and why:

       A nested iframe can never hold more permission than the frame
       it sits in. Games embedded in proxied pages set their own
       sandbox asking for pointer lock and presentation, and got
       neither — the game loaded its page and then did nothing, which
       reads as a broken browser rather than a missing capability.
       All three are about what a page may do to ITSELF. The four
       still absent are about what it may do to FieldKit and to the
       machine, which is a different question and still answered no. */
    ok("and that is the whole set",
      String(sandbox).trim().split(/\s+/).filter(Boolean).sort().join(" ") ===
        ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups",
         "allow-pointer-lock", "allow-presentation", "allow-orientation-lock"].sort().join(" "),
      String(sandbox));

    /* Permissions Policy is a SEPARATE gate, and the reason adding
       sandbox tokens alone changed nothing: a cross-origin frame is
       denied every powerful feature until a parent delegates it. */
    const allow = String(frame.getAttribute("allow") || "");
    ok("fullscreen is delegated to the frame", /\bfullscreen\b/.test(allow), allow);
    ok("and so is the gamepad", /\bgamepad\b/.test(allow));
    ok("and autoplay, or a game starts muted and silent", /\bautoplay\b/.test(allow));
    ok("the old boolean spelling is there too, for older engines",
      frame.hasAttribute("allowfullscreen"));

    /* The ones a reader has no business asking this machine for. */
    ["camera", "microphone", "geolocation", "payment", "usb", "midi", "display-capture"]
      .forEach(function (feature) {
        ok("no " + feature + " is delegated",
          !new RegExp("\\b" + feature + "\\b").test(allow));
      });
  }

  section("mounting opens a session and points the frame at the relay's own UI");
  {
    const frame = all(host).find((n) => n.tagName === "IFRAME");
    ok("a ticket was fetched without being asked for", ticketsIssued >= 1);
    ok("the frame is pointed at the relay's browser UI",
      /^https:\/\/relay\.example\/browse\/ui\?t=TESTTICKET/.test(String(frame.src)),
      String(frame.src));
    ok("and srcdoc is not sitting on top of it, which would ignore src entirely",
      !frame.hasAttribute("srcdoc"), String(frame.srcdoc));
    ok("the ticket, not a token, is what is in that url",
      !/Bearer|Authorization/i.test(String(frame.src)));

    ok("the status line says the session is open",
      /session open/i.test(byClass("br-status")[0].textContent),
      byClass("br-status")[0].textContent);
  }

  section("this side does not steer the frame");
  {
    /* The point of moving the toolbar to the relay. Any address bar,
       back button or page URL out here is back on the wrong side of
       an origin boundary that cannot be crossed. */
    ok("there is no address bar in the panel", byClass("br-bar").length === 0);
    ok("no back button", !button("‹") && !button("◀"));
    ok("no forward button", !button("›") && !button("▶"));
    ok("no GO button", !button("GO"));

    /* Read from the file rather than from function sources: the
       module's own selfcheck contains the words `contentWindow` and
       `contentDocument` inside the regex that looks for them, so
       stringifying it matches itself. Excluding the selfchecks and
       the header comment leaves the code that would actually do it. */
    const fs = require("fs");
    const path = require("path");
    const file = fs.readFileSync(
      path.join(__dirname, "..", "modules", "browser.js"), "utf8");
    const body = file
      .slice(file.indexOf("(function (FieldKit)"), file.indexOf("function selfcheck()"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    ok("and nothing reaches into the frame's document",
      !/contentWindow|contentDocument/.test(body));
    ok("nor builds a page url, which is the toolbar's job now",
      !/\/browse\/p\//.test(body), (body.match(/.{0,40}\/browse\/p\/.{0,40}/) || [])[0]);

    /* What IS here: starting over, and the engine diagnostic, both
       of which are about the session rather than about a page. */
    ok("there is a NEW SESSION button", !!button("NEW SESSION"));
    ok("and an ENGINES button, since only the relay can answer that",
      !!button("ENGINES"));
  }

  section("srcdoc and src never coexist");
  {
    /* THE BUG THAT MADE THE WHOLE THING DO NOTHING.

       An iframe with a srcdoc attribute ignores src — spec, not a
       quirk, and silent. So the assertion is not "navigation sets
       src". It is that setting one clears the other, in both
       directions, because a frame that has shown a message must
       still be able to navigate afterwards. */
    const frame = all(host).find((n) => n.tagName === "IFRAME");

    ticketFails = new Error("no credential today");
    button("NEW SESSION").click();
    await settle();
    ok("a failure puts a message in the frame, through srcdoc",
      !!frame.srcdoc && /COULD NOT START/.test(String(frame.srcdoc)));
    ok("and clears the src beside it", !frame.hasAttribute("src"));

    ticketFails = null;
    button("NEW SESSION").click();
    await settle();
    ok("recovering removes the srcdoc, or nothing would have happened",
      !frame.hasAttribute("srcdoc"), "srcdoc=" + JSON.stringify(frame.srcdoc));
    ok("and the frame is pointed at the relay again",
      /\/browse\/ui\?t=/.test(String(frame.src)), String(frame.src));
    ok("with a NEW ticket, since that is what NEW SESSION means",
      /TESTTICKET2|TESTTICKET3/.test(String(frame.src)), String(frame.src));
  }

  section("the address readout comes from the relay, because it cannot come from the frame");
  {
    const frame = all(host).find((n) => n.tagName === "IFRAME");
    const asked = [];
    window.fetch = async (url) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => ({ url: "https://site.example/read", at: 1 }) };
    };

    frame.dispatchEvent({ type: "load", target: frame });
    await settle();
    ok("the load event triggers a question to the relay",
      asked.some((u) => /\/browse\/where\?t=/.test(u)), asked.join(" | "));
    ok("and the answer is shown as a readout",
      /site\.example\/read/.test(byClass("br-status")[0].textContent),
      byClass("br-status")[0].textContent);

    /* Our own message in the frame is not a page, and there is
       nothing on the relay to ask about it. */
    const before = asked.length;
    frame.removeAttribute("src");
    frame.srcdoc = "<body>a message</body>";
    frame.dispatchEvent({ type: "load", target: frame });
    await settle();
    ok("a message in the frame does not trigger a pointless round trip",
      asked.length === before, asked.slice(before).join(", "));

    delete window.fetch;
  }

  /* ============================================================
     Back, forward and reload, from OUT HERE.

     The module header says the controls had to move inside the
     frame because this side cannot see where the frame went. That
     is still true and these buttons do not contradict it: they
     never ask where "back" is. The history lives on the relay,
     keyed by the ticket this side is already holding, so the button
     says "back" to the thing that knows and points the frame at the
     answer. Reading is still impossible; commanding was always
     fine.
     ============================================================ */
  section("the panel can steer without being able to see");
  {
    const frame = all(host).find((n) => n.tagName === "IFRAME");
    const nav = (glyph) => all(host).find((n) =>
      String(n.className || "").indexOf("br-nav") >= 0 && n.textContent === glyph);

    const back = nav("◁"), fwd = nav("▷"), reload = nav("↻");
    ok("there is a back, a forward and a reload", !!back && !!fwd && !!reload);

    /* A control that is always lit teaches you that pressing it does
       nothing. Both start disabled and are told otherwise by the
       relay. */
    ok("back and forward start disabled", back.disabled === true && fwd.disabled === true);
    ok("reload does not, since there is always something to reload",
      reload.disabled !== true);

    /* The section above left our own message in the frame, and a
       message is not a page — onFrameLoad returns early on srcdoc
       rather than asking the relay about something it never
       served. Put a real page back first. */
    frame.removeAttribute("srcdoc");
    frame.src = "https://relay.example/browse/ui?t=TESTTICKET1";
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      url: "https://site.example/two", at: 2, canBack: true, canFwd: false }) });
    frame.dispatchEvent({ type: "load", target: frame });
    await settle();
    ok("the relay's answer lights back up", back.disabled === false);
    ok("and leaves forward alone, because there is nothing ahead", fwd.disabled === true);
    delete window.fetch;

    back.click();
    await settle();
    ok("pressing back points the frame at the relay's back route",
      /^https:\/\/relay\.example\/browse\/back\?t=/.test(String(frame.src)),
      String(frame.src));

    reload.click();
    await settle();
    ok("and reload at the reload route",
      /^https:\/\/relay\.example\/browse\/reload\?t=/.test(String(frame.src)),
      String(frame.src));

    /* The guarantee that makes all of this safe to add: this side
       still never constructs a page URL. If it started to, it would
       be guessing at state only the relay has. */
    ok("no page url was built out here", !/\/browse\/p\//.test(String(frame.src)));
  }

  section("it says what it is not");
  {
    const note = byClass("br-note")[0];
    const text = note ? note.textContent : "";
    ok("it says what happens to the page's scripts", /scripts/i.test(text));
    /* The limit that replaced "logins will not work". Sites mostly
       work now, so the honest warning is the one about all of them
       landing on a single origin together. */
    ok("it warns that every site here shares one origin",
      /shares? one origin/i.test(text), text);
    ok("it names something that still does not work", /websockets/i.test(text), text);
    ok("it says outright that this is not anonymity", /NOT anonymity/.test(text));
    ok("it says the relay sees every address", /relay sees every address/i.test(text));
    ok("it says the local network sees the session",
      /network you are on sees a connection/i.test(text));
    ok("and it says what it DOES do, so it is not just disclaimers",
      /hides what you read from the local network/i.test(text));
    ok("it also explains why the address bar is inside the page",
      /inside the page/i.test(text) && /different origins/i.test(text), text);
    /* The buttons out here are new and look like they contradict
       that paragraph, so the paragraph has to say why they do not. */
    ok("and why the buttons out here work anyway",
      /tell the relay to move/i.test(text), text);
    /* Games are the thing people will try next, so the honest limit
       belongs on screen rather than only in a commit message. */
    ok("it says a host can block the relay outright",
      /blocks? your relay's address/i.test(text), text);
    ok("and that nothing here tries to get past that",
      /past a block/i.test(text), text);
  }

  section("the module's own selfchecks");
  {
    const checks = def.selfcheck();
    ok("it exposes several", checks.length >= 5, String(checks.length));
    for (const c of checks) {
      let outcome;
      try { outcome = await c.run(); }
      catch (e) { outcome = /^SKIPPED/.test(e.message) ? "skipped" : e; }
      ok(c.name, !(outcome instanceof Error), outcome instanceof Error ? outcome.message : "");
    }
    const critical = checks.filter((c) => c.critical).map((c) => c.name);
    ok("the sandbox check is one of the critical ones",
      critical.includes("THE FRAME IS SANDBOXED TO A KNOWN SET"), critical.join(", "));
    ok("so is the one about the token staying out of urls",
      critical.includes("THE VAULT TOKEN NEVER GOES IN A URL"));
    ok("and so is the srcdoc one, since it fails silently and completely",
      critical.includes("A MESSAGE IN THE FRAME DOES NOT BLOCK NAVIGATION"));
  }

  section("unmounting stops the frame loading into a panel nobody can see");
  {
    const frame = all(host).find((n) => n.tagName === "IFRAME");
    frame.setAttribute("src", "https://relay.example/browse/ui?t=x");
    def.unmount();
    ok("the src is cleared", !frame.getAttribute("src"));
    ok("and so is any srcdoc", !frame.srcdoc);
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
