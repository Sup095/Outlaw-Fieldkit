/* ============================================================
   modules/browser.js — the streamed browser's panel (renderLive),
   against a stand-in relay: a status answer, a ticket, and a socket
   the test speaks for. The relay's side is proven in
   tests/browser-tabs.test.js and against a real Chromium; this is the
   panel doing its part with what the relay says.

   What matters:
     1. Tabs, downloads and "choose file" turn into the right
        messages, and only a fixed list of pointer shapes is used.
     2. Touch becomes the same wheel and click messages a mouse sends.
     3. Bookmarks and history live in the vault and nowhere else: with
        it locked nothing is kept, "keep" off stops history, and the
        relay is never sent them.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "modules/browser.js"]);
const { ok, section, state } = makeRunner("browser-live");
const settings = FieldKit.need("settings");
const ui = FieldKit.need("ui");
const def = FieldKit.modules().browser;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- the world the panel sees ---- */
const box = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
const make = document.createElement;
document.createElement = (t) => { const n = make(t); n.getBoundingClientRect = box; return n; };
document.removeEventListener = () => {};
global.requestAnimationFrame = (fn) => setTimeout(fn, 1);
global.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = global.requestAnimationFrame;
window.cancelAnimationFrame = global.cancelAnimationFrame;

const fetched = [];
global.fetch = async (url, opts) => {
  fetched.push({ url: String(url), method: (opts && opts.method) || "GET" });
  if (/\/browser\/status$/.test(url)) return { ok: true, json: async () => ({ enabled: true, available: true }) };
  if (/\/browser\/file\//.test(url)) return { ok: true, status: 200, blob: async () => new Blob(["file bytes"]) };
  if (/\/browser\/put\//.test(url)) return { ok: true, status: 201, json: async () => ({ id: "up" + fetched.length }) };
  throw new Error("unexpected fetch " + url);
};

const socks = [];
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; socks.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  say(m) { this.onmessage({ data: JSON.stringify(m) }); }
}
global.WebSocket = FakeWS;

/* The vault's store: records in memory, and a switch for locked. */
let unlocked = true;
const recs = new Map();
let nid = 0;
FieldKit.provide("store", {
  isUnlocked: () => unlocked,
  async list(type) { return [...recs.values()].filter((r) => r.type === type).map((r) => ({ id: r.id, meta: { type: r.type }, data: r.data })); },
  async get(id) { return recs.has(id) ? recs.get(id).data : null; },
  async put(type, data, opts) { const id = (opts && opts.id) || "r" + (++nid); recs.set(id, { id, type, data: JSON.parse(JSON.stringify(data)) }); return { id, type }; },
  async remove(id) { recs.delete(id); return true; }
});
FieldKit.provide("transportRelay", { streamTicket: async () => ({ ticket: "TICKET" }) });
const uploads = [];
FieldKit.provide("files", { upload: async (file) => { uploads.push(file); return { id: "f1" }; } });

const ctx = { settings, ui, log() {}, warn() {}, error() {}, on() {}, emit() {}, confirm: () => true };
let host = fakeElement("div");
function all(node) {
  const out = [];
  (function walk(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); walk(c); } }); })(node);
  return out;
}
const text = () => all(host).map((n) => n.textContent || "").join(" | ");
const byClass = (c) => all(host).filter((n) => String(n.className || "").split(/\s+/).includes(c));
const button = (label) => all(host).find((n) => n.tagName === "BUTTON" && n.textContent === label) || null;
const click = (n) => n.onclick ? n.onclick({ type: "click", preventDefault() {}, stopPropagation() {} }) : n.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
const fire = (n, type, extra) => n.dispatchEvent(Object.assign({ type, preventDefault() {}, stopPropagation() {} }, extra || {}));
const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return false; };

(async () => {
  settings.set("relayUrl", "http://relay.test");

  await def.mount(host, ctx);
  await until(() => socks.length === 1 && socks[0].sent.length > 0);
  const ws = socks[0];
  const sent = (t) => ws.sent.filter((m) => m.t === t);
  ws.say({ t: "ready", zoom: 1 });
  const canvas = byClass("br-canvas")[0];

  section("it connects and says hello");
  {
    ok("a stream ticket, in the socket's address", /\/browser\/stream\?t=TICKET$/.test(ws.url), ws.url);
    ok("and hello with the panel's size", sent("hello").length === 1 && sent("hello")[0].w > 0);
  }

  section("tabs");
  {
    ws.say({ t: "tabs", active: "B", tabs: [{ id: "A", url: "https://a.test/", title: "Page A" }, { id: "B", url: "https://b.test/", title: "" }] });
    const strip = byClass("br-tabs")[0];
    ok("two tabs: the strip shows both", strip.style.display === "" && byClass("br-tab").length === 2);
    ok("the one on screen is marked, an untitled one by its address", byClass("br-tab")[1].className.includes("on") && /b\.test/.test(text()));
    click(all(byClass("br-tab")[0]).find((n) => n.className === "br-tab-t"));
    ok("clicking a tab switches to it", sent("tab").slice(-1)[0].id === "A");
    click(all(byClass("br-tab")[1]).find((n) => n.className === "br-tab-x"));
    ok("its ✕ closes it", sent("tab-close").slice(-1)[0].id === "B");
    ws.say({ t: "tabs", active: "A", tabs: [{ id: "A", url: "https://a.test/", title: "Page A" }] });
    ok("one tab: no strip", strip.style.display === "none");
  }

  section("the pointer");
  {
    ws.say({ t: "cursor", c: "pointer" });
    ok("a hand over a link", canvas.style.cursor === "pointer");
    ws.say({ t: "cursor", c: "url(https://evil.test/x.png), auto" });
    ok("anything off the list is the arrow, never a page's own value", canvas.style.cursor === "default");
  }

  section("downloads");
  {
    ws.say({ t: "download", id: "d1", name: "report.pdf", state: "inProgress", got: 512, total: 2048 });
    ok("progress is shown", /downloading report\.pdf — 25% of 2 KB/.test(text()), text().slice(0, 300));
    ws.say({ t: "download", id: "d1", name: "report.pdf", state: "completed", got: 2048, url: "/browser/file/tok1" });
    ok("done: both ways to keep it", !!button("SAVE TO THIS DEVICE") && !!button("SAVE TO VAULT FILES") && /downloaded report\.pdf \(2 KB\)/.test(text()));
    click(button("SAVE TO VAULT FILES"));
    await until(() => uploads.length === 1);
    ok("SAVE TO VAULT FILES fetches it once and hands it to VAULT FILES under its name",
      uploads.length === 1 && uploads[0].name === "report.pdf" && fetched.filter((f) => /tok1/.test(f.url)).length === 1);
    await until(() => /is in VAULT FILES/.test(text()));
    ok("and says so", /report\.pdf is in VAULT FILES/.test(text()));
    ws.say({ t: "download", id: "d2", name: "big.iso", state: "canceled", why: "over the 200 MB limit" });
    ok("a stopped one says why", /download of big\.iso stopped: over the 200 MB limit/.test(text()));
    click(button("OK"));
    ok("and can be dismissed", !/big\.iso/.test(text()));
  }

  section("a page's choose file");
  {
    ws.say({ t: "choose-file", multiple: false, url: "/browser/put/tok2" });
    ok("the page asking is shown, with a button for the picker", /the page wants a file/.test(text()) && !!button("CHOOSE FILE"));
    const input = all(host).find((n) => n.tagName === "INPUT" && (n.type || n.attributes.type) === "file");
    input.files = [new File(["hello"], "notes.txt")];
    fire(input, "change");
    await until(() => sent("files").length === 1);
    const put = fetched.find((f) => /\/browser\/put\/tok2\?name=notes\.txt$/.test(f.url));
    ok("the file is posted to the link the relay gave, named", put && put.method === "POST", JSON.stringify(fetched.slice(-2)));
    ok("then the page is given it", sent("files")[0].ids.length === 1);
    ok("and the note goes", !/the page wants a file/.test(text()));
  }

  section("touch");
  {
    const t = (x, y) => ({ clientX: x, clientY: y });
    const before = ws.sent.length;
    fire(canvas, "touchstart", { touches: [t(100, 300)] });
    fire(canvas, "touchmove", { touches: [t(100, 280)] });
    fire(canvas, "touchmove", { touches: [t(100, 200)] });
    await wait(20);
    fire(canvas, "touchend", { touches: [] });
    await wait(20);
    const wheels = ws.sent.slice(before).filter((m) => m.t === "mouse" && m.type === "mouseWheel");
    const down = wheels.reduce((a, m) => a + m.deltaY, 0);
    ok("a finger dragged up scrolls the page down", wheels.length >= 1 && down >= 80, JSON.stringify(wheels));
    ok("and is not a click", !ws.sent.slice(before).some((m) => m.type === "mousePressed"));
    const b2 = ws.sent.length;
    fire(canvas, "touchstart", { touches: [t(50, 60)] });
    fire(canvas, "touchend", { touches: [] });
    const tap = ws.sent.slice(b2).filter((m) => m.t === "mouse");
    ok("a tap is a click where it was", tap.map((m) => m.type).join() === "mouseMoved,mousePressed,mouseReleased" && tap[1].x === 50 && tap[1].y === 60);
    const b3 = ws.sent.length;
    fire(canvas, "touchstart", { touches: [t(100, 100), t(200, 100)] });
    fire(canvas, "touchmove", { touches: [t(80, 100), t(230, 100)] });
    fire(canvas, "touchend", { touches: [] });
    const z = ws.sent.slice(b3).filter((m) => m.t === "zoom");
    ok("two fingers spread zoom in, to the nearest step", z.length === 1 && z[0].zoom === 1.5, JSON.stringify(z));
    ok("and do not scroll or click", !ws.sent.slice(b3).some((m) => m.t === "mouse"));
  }

  section("bookmarks and history, in the vault");
  {
    const star = button("☆");
    ws.say({ t: "nav", url: "https://example.com/" });
    ws.say({ t: "loaded", url: "https://example.com/", title: "Example Domain" });
    click(star);
    await until(() => star.textContent === "★");
    const marks = [...recs.values()].filter((r) => r.type === "browser-bookmark");
    ok("☆ keeps the page as a record in the vault", marks.length === 1 && marks[0].data.url === "https://example.com/" && marks[0].data.title === "Example Domain");
    ok("and turns into ★", star.textContent === "★");
    ok("nothing about it is sent to the relay", !ws.sent.some((m) => /bookmark|example\.com\/?"?$/.test(JSON.stringify(m)) && m.t !== "nav"));
    ws.say({ t: "loaded", url: "https://example.org/a", title: "Org A" });
    ok("another page: ☆ again", star.textContent === "☆");
    ws.say({ t: "loaded", url: "https://example.org/a", title: "Org A (titled)" });
    ws.say({ t: "loaded", url: "data:text/html,hi", title: "data" });

    const addr = byClass("br-addr")[0];
    addr.value = "domain";
    fire(addr, "input");
    const list = all(host).find((n) => n.tagName === "DATALIST");
    ok("typing in the address suggests from bookmarks and history", list && addr.attributes.list === list.id &&
      list.children.length === 1 && list.children[0].value === "https://example.com/", JSON.stringify(list && list.children.map((c) => c.value)));

    click(button("PLACES"));
    await until(() => byClass("br-place").length > 0);
    ok("PLACES lists the bookmark", byClass("br-place").length === 1 && /Example Domain/.test(text()));
    click(all(host).find((n) => n.tagName === "BUTTON" && /^HISTORY/.test(n.textContent)));
    const rows = byClass("br-place-u").map((n) => n.textContent);
    ok("HISTORY: newest first, a repeat visit once, and only web pages", rows.join() === "https://example.org/a,https://example.com/", rows.join());
    ok("a later title replaces an earlier one", /Org A \(titled\)/.test(text()));
    click(byClass("br-place-go")[1]);
    ok("clicking one goes there", sent("nav").slice(-1)[0].url === "https://example.com/");

    def.unmount();
    const h = recs.get("browser-history");
    ok("closing the panel saves history to the vault, not before", h && h.data.items.length === 2 && h.data.items[0].u === "https://example.org/a");

    host = fakeElement("div");
    await def.mount(host, ctx);
    await until(() => socks.length === 2);
    const ws2 = socks[1];
    ws2.say({ t: "ready", zoom: 1 });
    await wait(20);
    ws2.say({ t: "loaded", url: "https://example.com/", title: "Example Domain" });
    ok("the next time, ★ is remembered", button("★") !== null);
    click(button("PLACES"));
    await until(() => byClass("br-place").length > 0);
    click(all(host).find((n) => n.tagName === "BUTTON" && /^HISTORY/.test(n.textContent)));
    const keep = all(host).find((n) => n.tagName === "INPUT" && (n.type || n.attributes.type) === "checkbox");
    keep.checked = false;
    fire(keep, "change");
    await wait(10);
    ws2.say({ t: "loaded", url: "https://private.test/", title: "Private" });
    def.unmount();
    const h2 = recs.get("browser-history");
    ok("with keep off, nothing new is remembered", h2.data.off === true && !h2.data.items.some((x) => /private/.test(x.u)));

    unlocked = false;
    /* Someone with an account and no vault: the browser, but nowhere to keep places. */
    FieldKit.provide("messages", { signedIn: () => true, streamTicket: async () => ({ ticket: "ACCOUNT" }) });
    host = fakeElement("div");
    await def.mount(host, ctx);
    await until(() => socks.length === 3);
    const ws3 = socks[2];
    ws3.say({ t: "ready", zoom: 1 });
    ws3.say({ t: "loaded", url: "https://locked.test/", title: "Locked" });
    click(button("☆"));
    await wait(20);
    ok("vault locked: ☆ says to unlock it", /unlock the vault to keep bookmarks/.test(text()));
    click(button("PLACES"));
    await wait(20);
    ok("and PLACES says nothing is kept until then", /Nothing is kept until then/.test(text()));
    def.unmount();
    const h3 = recs.get("browser-history");
    ok("and nothing was written while locked", !h3.data.items.some((x) => /locked/.test(x.u)) &&
      [...recs.values()].filter((r) => r.type === "browser-bookmark").length === 1);
  }

  await wait(50);
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
