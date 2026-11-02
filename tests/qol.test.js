/* ============================================================
   FieldKit tests :: qol — the small things on the desktop

   Windows that stay where they were left, Esc that leaves a page
   alone, snapping, what is offered after a reload or an update, and
   the settings that make it easier to see.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap([
  "core/kernel.js", "core/settings.js", "core/ui.js", "core/shell.js", "core/whats-new.js", "core/notices.js",
  "modules/admin-center.js"
]);
const { ok, section, state } = makeRunner("qol");

const shell = FieldKit.need("shell");
const ui = FieldKit.need("ui");
const settings = FieldKit.need("settings");

FieldKit.provide("store", {
  state: () => "ONLINE", isUnlocked: () => true, hasVault: () => true,
  pendingCount: async () => 0, transportName: () => "local",
  async pull() { return { added: 0, updated: 0, removed: 0 }; }
});

function reg(id, extra) {
  FieldKit.register(id, Object.assign({
    id: id, title: id.toUpperCase(), icon: "◆", group: "PROJECT",
    mount: function (root) { root.appendChild(document.createElement("div")); }
  }, extra || {}));
}
reg("one"); reg("two");

/* What a page left behind, before the desktop is built. */
localStorage.setItem("fieldkit.open.v1", JSON.stringify(["one", "gone-app"]));
localStorage.setItem("fieldkit.seenVersion", "0.0.1");

const root = document.createElement("div");
document.body.appendChild(root);
shell.build(root);

const layer = document.getElementById("fk-windows");
layer.clientWidth = 1000;
layer.clientHeight = 600;
const key = (k, target, more) => window.dispatchEvent(Object.assign({
  type: "keydown", key: k, target: target || document.body, preventDefault() {} }, more || {}));
const icons = () => document.getElementById("fk-icons");
const nodeOf = () => document.querySelectorAll(".fk-win")[0];

(function () {
  section("what is offered, once");
  {
    const rows = icons().querySelectorAll(".fk-attn-row");
    const txt = rows.map((r) => r.querySelector(".fk-attn-t").textContent);
    ok("the windows left open are offered, and not reopened by themselves",
      txt.some((t) => /Open again: ONE/.test(t)) && shell.openWindows().length === 0, txt.join(" / "));
    ok("an app that no longer exists is left out", !txt.some((t) => /gone-app/.test(t)));
    ok("an update says so", txt.some((t) => t.indexOf("Updated to " + FieldKit.VERSION) === 0), txt.join(" / "));
    ok("and only once", localStorage.getItem("fieldkit.seenVersion") === FieldKit.VERSION);
    ok("REOPEN brings them back", shell.reopen() === 2 && shell.openWindows().join() === "one");
    shell.close("one");
    ok("closing the last one leaves nothing to come back to", localStorage.getItem("fieldkit.open.v1") === "[]");
  }

  section("Esc leaves a page alone");
  {
    shell.open("one");
    const input = document.createElement("input");
    key("Escape", input);
    ok("not from a text field", shell.openWindows().includes("one"));
    const area = document.createElement("textarea");
    key("Escape", area);
    ok("nor a text area", shell.openWindows().includes("one"));
    const canvas = document.createElement("canvas");
    canvas.closest = (s) => s === "[data-fk-keys]" ? canvas : null;
    key("Escape", canvas);
    ok("nor a page or a program, whose menu may be on it", shell.openWindows().includes("one"));
    key("Escape", document.body);
    ok("but still from the window itself", !shell.openWindows().includes("one"));
  }

  section("a window stays where it was left");
  {
    shell.open("one");
    const n = nodeOf();
    n.style.left = "50px"; n.style.top = "60px"; n.style.width = "400px"; n.style.height = "300px";
    n.offsetLeft = 50; n.offsetTop = 60; n.offsetWidth = 400; n.offsetHeight = 300;
    shell.snap("one", "left");
    ok("snapped left it fills the left half", n.style.left === "0px" && n.style.top === "0px" &&
      n.style.width === "500px" && n.style.height === "600px", [n.style.left, n.style.width, n.style.height].join());
    shell.snap("one", "right");
    ok("and right, the right half", n.style.left === "500px" && n.style.width === "500px");
    layer.clientHeight = 548;
    FieldKit.emit("shell:resize", { id: null });
    ok("a notice line shrinks the desktop, and a snapped window goes with it", n.style.height === "548px", n.style.height);
    layer.clientHeight = 600;
    FieldKit.emit("shell:resize", { id: null });
    ok("and comes back with it", n.style.height === "600px", n.style.height);
    const kept = JSON.parse(localStorage.getItem("fieldkit.windows.v1")).one;
    ok("where it went is remembered", kept.x === 500 && kept.w === 500, JSON.stringify(kept));
    shell.close("one");
    shell.open("one");
    const again = nodeOf();
    ok("and it opens there next time", again.style.left === "500px" && again.style.width === "500px",
      again.style.left + " " + again.style.width);
    shell.close("one");
  }

  section("what was remembered may not fit any more");
  {
    localStorage.setItem("fieldkit.windows.v1", JSON.stringify({ one: { x: 9000, y: 9000, w: 5000, h: 5000 } }));
    shell.open("one");
    const n = nodeOf();
    ok("a window from a bigger screen comes back on this one",
      parseInt(n.style.left, 10) < 1000 && parseInt(n.style.top, 10) < 600 && parseInt(n.style.width, 10) <= 1000,
      [n.style.left, n.style.top, n.style.width].join());
    shell.close("one");
    localStorage.setItem("fieldkit.windows.v1", "not json at all");
    shell.open("one");
    ok("and a broken record is the same as none", shell.openWindows().includes("one"));
    shell.close("one");
    localStorage.removeItem("fieldkit.windows.v1");
  }

  section("keys for windows");
  {
    shell.open("one");
    const n = nodeOf();
    n.style.left = "10px"; n.style.top = "10px"; n.style.width = "300px"; n.style.height = "200px";
    key("ArrowLeft", document.body, { ctrlKey: true, shiftKey: true });
    ok("Ctrl+Shift+Left snaps", n.style.width === "500px" && n.style.left === "0px");
    key("ArrowRight", document.body, { ctrlKey: true, shiftKey: true });
    ok("Ctrl+Shift+Right snaps the other way", n.style.left === "500px");
    key("ArrowUp", document.body, { ctrlKey: true, shiftKey: true });
    ok("Ctrl+Shift+Up maximises", n.classList.contains("maximized"));
    key("ArrowUp", document.body, { ctrlKey: true, shiftKey: true });
    ok("and again restores", !n.classList.contains("maximized"));
    const bar = n.querySelector(".fk-win-bar");
    bar.dispatchEvent({ type: "dblclick", target: bar });
    ok("double-clicking the title bar maximises", n.classList.contains("maximized"));
    bar.dispatchEvent({ type: "dblclick", target: bar });
    ok("and restores", !n.classList.contains("maximized"));
    key("ArrowDown", document.body, { ctrlKey: true, shiftKey: true });
    ok("Ctrl+Shift+Down minimises", n.style.display === "none" || n.classList.contains("minimized"));
    shell.close("one");
  }

  section("the two sheets");
  {
    key("/", document.body, { ctrlKey: true });
    const sheet = document.getElementById("fk-sheet");
    ok("Ctrl+/ lists the keys", !!sheet && sheet.querySelectorAll(".fk-sheet-key").length >= 10);
    key("Escape", document.body);
    ok("Esc closes it", !document.getElementById("fk-sheet"));
    shell.showWhatsNew();
    ok("WHAT'S NEW opens", document.getElementById("fk-sheet").querySelectorAll(".fk-sheet-li").length > 0);
    key("Escape", document.body);
  }

  section("every release says what is in it");
  {
    const wn = FieldKit.need("whatsNew");
    ok("the newest entry is this version", wn.latest().v === FieldKit.VERSION, wn.latest().v + " / " + FieldKit.VERSION);
    ok("and it says something", wn.latest().items.length > 0);
    ok("each line is short enough to read", wn.notes().every((n) => n.items.every((i) => i.length < 170)));
  }

  section("easier to see");
  {
    settings.set("textSize", 130);
    settings.set("contrast", true);
    settings.set("calm", true);
    ui.applyLook(settings);
    ok("text size reaches the windows", document.body.style.getPropertyValue
      ? document.body.style.getPropertyValue("--fk-zoom") === "1.3" : true);
    ok("contrast is on", document.body.classList.contains("fk-contrast"));
    ok("so is less motion", document.body.classList.contains("fk-calm"));
    settings.set("contrast", false);
    settings.set("calm", false);
    ui.applyLook(settings);
    ok("and they come off", !document.body.classList.contains("fk-contrast") && !document.body.classList.contains("fk-calm"));
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    ok("OUTPOST may change them too", /"textSize", "contrast", "calm"/.test(read("modules/settings-outpost.js")));
    ok("and both apply them at boot", /ui\.applyLook\(settings\)/.test(read("core/boot.js")) &&
      /ui\.applyLook\(settings\)/.test(read("core/boot-outpost.js")));
    ok("a drive remembers them", /"textSize", "contrast", "calm"/.test(read("core/drive-profile.js")));
  }

  section("the line at the top goes away by itself");
  {
    const notices = FieldKit.need("notices");
    const bar = () => document.getElementById("fk-notices");
    const down = { id: "browser", since: 1, level: "warn", text: "BROWSER is having trouble" };
    notices.apply([down]);
    ok("what the relay lists is shown", bar().querySelectorAll(".fk-notice").length === 1);
    ok("and kept in the bell", notices.history()[0].text === down.text && notices.unseen() >= 1);
    const n = notices.history().length;
    notices.apply([down]);
    ok("the same occurrence is not news twice", notices.history().length === n);
    bar().querySelector(".x").click();
    ok("✕ hides it", bar().querySelectorAll(".fk-notice").length === 0);
    ok("while the relay still says it", notices.list().length === 1);
    notices.apply([]);
    ok("when the relay stops saying it, it is gone unseen", notices.list().length === 0);
    ok("with a word that it came back", notices.history()[0].text === "BROWSER IS BACK");
    notices.apply([Object.assign({}, down, { since: 2 })]);
    ok("a new occurrence shows again, though the last was hidden", bar().querySelectorAll(".fk-notice").length === 1);
    notices.apply(null);
    ok("a nonsense answer clears the line and does not break it", bar().querySelectorAll(".fk-notice").length === 0);
    ui.toast("SOMETHING SHORT", "info");
    ok("a toast stays in the bell", notices.history()[0].text === "SOMETHING SHORT");
    const count = notices.unseen();
    ok("and counts as unseen", count > 0);
    notices.togglePanel();
    ok("opening the bell marks them seen", notices.unseen() === 0);
    notices.togglePanel();
    notices.stop();
  }

  section("ADMIN CENTER");
  {
    const mod = FieldKit.module("admin-center");
    ok("it is admins only", mod.adminOnly === true);
    const calls = [];
    const data = () => ({
      at: Date.now(),
      relay: { uptimeSec: 7200, memMb: 200, node: "v22", disk: { freeGb: 1, totalGb: 50 }, upKbps: 12000 },
      browser: { enabled: true, available: true, sessions: 1, maxSessions: 4, render: "gpu",
        sessionList: [{ who: "msg:ana", tier: "member", tabs: 1, viewers: 1, idleSec: 0 }],
        helpers: [{ name: "bastion-1", up: false, who: [] }] },
      runner: { enabled: true, online: false, why: "the run server is offline" },
      people: { total: 3, admins: 1, members: 1, guests: 1, banned: 0, waiting: 1, reports: 2, requireApproval: true },
      blocking: { names: 5000, blocked: { ads: 3 }, lists: [{ id: "ads", names: 5000, at: Date.now(), why: "" }],
        reports: [{ host: "good.example", by: "ana", at: 1 }], allowed: [], recent: [{ cat: "ads", host: "x.example", at: 1 }] },
      updates: { serving: "0.6.0" }, notices: [], announcement: null,
      devices: [{ at: 1, platform: "ChromeOS", major: 140, checks: { sw: false, swAnswers: false, wasm: true, webSocket: true } }],
      events: [{ at: 1, level: "ERROR", msg: "it broke" }]
    });
    FieldKit.provide("messages", {
      adminApi: async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === "/admin/overview") return data();
        if (p === "/msg/people") return { people: [{ handle: "cy", tier: "guest" }] };
        return { ok: true };
      }
    });
    const hostEl = document.createElement("div");
    document.body.appendChild(hostEl);
    (async () => {
      mod.mount(hostEl, { ui: ui, settings: settings });
      await new Promise((r) => setTimeout(r, 30));
      const txt = () => hostEl.querySelectorAll(".v").map((n) => n.textContent || "").join(" | ");
      const btn = (label) => hostEl.querySelectorAll("button").find((b) => b.textContent === label);
      ok("the top line says what is wrong", /RUNNER's server is offline/.test(hostEl.querySelector(".ac-top").textContent) &&
        /browser helper/.test(hostEl.querySelector(".ac-top").textContent) && /disk/.test(hostEl.querySelector(".ac-top").textContent));
      ok("an offline run server is offline, not switched off", /the run server is offline/.test(txt()) && !/switched off/.test(txt()), txt());
      ok("a device with no service worker is shown as missing it", /missing: sw, swAnswers/.test(txt()), txt());
      ok("someone waiting can be approved", !!btn("APPROVE"));
      btn("APPROVE").click();
      await new Promise((r) => setTimeout(r, 20));
      ok("and APPROVE says who", calls.some((c) => c[1] === "/msg/role" && c[2].handle === "cy" && c[2].action === "approve"));
      const before = calls.filter((c) => c[1] === "/admin/overview").length;
      btn("ALLOW").focus();
      btn("ALLOW").click();
      await new Promise((r) => setTimeout(r, 20));
      ok("a button keeping the focus does not stop the page refreshing",
        calls.filter((c) => c[1] === "/admin/overview").length > before && !!hostEl.querySelector(".ac-top"));
      ok("ALLOW names the site", calls.some((c) => c[1] === "/admin/block" && c[2].op === "allow" && c[2].host === "good.example"));
      const say = hostEl.querySelector(".ac-say");
      say.value = "back at six";
      say.dispatchEvent({ type: "input", target: say });
      btn("OPEN MESSAGES").focus();
      btn("ALLOW").click();
      await new Promise((r) => setTimeout(r, 20));
      ok("an announcement half written survives a refresh", hostEl.querySelector(".ac-say").value === "back at six");
      mod.unmount();

      console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
      if (state.failures && state.failures.length) {
        console.log("\nFAILURES:");
        state.failures.forEach((f) => console.log("  - " + f));
      }
      process.exit(state.fail ? 1 : 0);
    })().catch((e) => { console.error("SUITE CRASHED: " + (e && e.stack || e)); process.exit(1); });
  }
})();
