/* ============================================================
   The streamed browser's tabs, downloads, uploads, pointer and
   session lifetimes (RUNNER_PLAN.md §16), against a stand-in for
   Chromium's debugging connection, then the route's single-use
   links over real HTTP. The same things were run against a real
   Chromium in the relay image (27 checks, FIELDKIT_PROJECT.md §14.26).

   What matters:
     1. A page that opens a window gets a tab and is shown; a tab we
        made ourselves is never adopted twice; there is a most.
     2. Only the tab on screen reaches the panel.
     3. A download over the cap is cancelled; a finished one is
        fetched once, by its link, and nothing else is.
     4. A file is taken only while a page is asking for one, under a
        name that is only a name.
     5. A guest's browser ends when it is closed; a member's sign-ins
        outlive an idle end, and never a request to wipe.
   ============================================================ */
"use strict";

const fs = require("fs");
const http = require("http");
const { EventEmitter } = require("events");
const { makeRunner } = require("./harness");
const { Engine, cleanName, CURSORS } = require("../relay/browser-engine");
const route = require("../relay/browser-route");

const { ok, section, state } = makeRunner("browser-tabs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return false; };

/* Enough of Chromium's debugging connection for the engine's tabs. */
function fakeCdp() {
  const c = new EventEmitter();
  c.calls = [];
  c.cookies = {};
  let n = 0;
  c.targets = new Map();          /* targetId -> browserContextId */
  c.send = async (method, p, sid) => {
    p = p || {};
    c.calls.push({ method, p, sid });
    switch (method) {
      case "Target.createBrowserContext": return { browserContextId: "ctx" + (++n) };
      case "Target.createTarget": {
        const id = "t" + (++n);
        c.targets.set(id, p.browserContextId);
        /* Chromium announces it before answering: the adopt race. */
        c.emit("Target.targetCreated", { targetInfo: { targetId: id, type: "page", browserContextId: p.browserContextId, url: "about:blank", title: "" } });
        await wait(5);
        return { targetId: id };
      }
      case "Target.attachToTarget": return { sessionId: "s-" + p.targetId };
      case "Target.closeTarget":
        c.targets.delete(p.targetId);
        setTimeout(() => c.emit("Target.targetDestroyed", { targetId: p.targetId }), 5);
        return {};
      case "Storage.getCookies": return { cookies: c.cookies[p.browserContextId] || [] };
      case "Storage.setCookies": c.cookies[p.browserContextId] = p.cookies; return {};
      case "Page.getNavigationHistory": return { currentIndex: 0, entries: [{ id: 1 }] };
      case "Page.getFrameTree": return { frameTree: { frame: { id: "f" } } };
      case "Page.createIsolatedWorld": return { executionContextId: 9 };
      case "Runtime.evaluate": return { result: { value: c.evalAnswer } };
      default: return {};
    }
  };
  c.session = (sid) => ({
    id: sid,
    send: (m, p) => c.send(m, p, sid),
    on: (ev, fn) => { c.on(sid + ":" + ev, fn); return () => c.off(sid + ":" + ev, fn); },
    off: (ev, fn) => c.off(sid + ":" + ev, fn)
  });
  /* A page Chromium opened by itself, as a pop-up does. */
  c.popup = (ctx, url) => {
    const id = "t" + (++n);
    c.targets.set(id, ctx);
    c.emit("Target.targetCreated", { targetInfo: { targetId: id, type: "page", browserContextId: ctx, url: url || "", title: "", openerId: "x" } });
    return id;
  };
  c.count = (m, sid) => c.calls.filter((x) => x.method === m && (sid === undefined || x.sid === sid)).length;
  return c;
}

function engineOn(cdp, config) {
  const eng = new Engine({ config: Object.assign({ enabled: false }, config || {}), log: () => {} });
  clearInterval(eng._sweep);
  eng.ready = true;
  eng.cdp = cdp;
  cdp.on("Target.targetCreated", (p) => { eng._adopt(p.targetInfo).catch(() => {}); });
  cdp.on("Target.targetDestroyed", (p) => { eng._tabGone(p.targetId).catch(() => {}); });
  cdp.on("Target.targetInfoChanged", (p) => eng._tabInfo(p.targetInfo));
  cdp.on("Browser.downloadWillBegin", (p) => eng._dlBegin(p));
  cdp.on("Browser.downloadProgress", (p) => eng._dlProgress(p));
  return eng;
}

const viewer = () => { const v = { got: [], frames: 0, onFrame() { v.frames++; }, onEvent(m) { v.got.push(m); }, onGone(w) { v.gone = w; } }; return v; };

(async () => {
  section("a page that opens a window gets a tab");
  {
    const cdp = fakeCdp();
    const eng = engineOn(cdp, { maxTabs: 3 });
    const s = await eng.sessionFor("msg:ann", { tier: "member" });
    await wait(30);
    ok("a new session has one tab, on screen", s.tabs.length === 1 && s.active === s.tabs[0] && s.page === s.active.page);
    ok("our own tab, announced before it was made, is not adopted twice", s.tabs.length === 1);
    const v = viewer();
    await eng.attach(s, v);
    ok("a panel is told the tabs on arrival", v.got.some((m) => m.t === "tabs" && m.tabs.length === 1));
    const first = s.active;
    const pop = cdp.popup(s.browserContextId, "https://example.com/");
    await until(() => s.tabs.length === 2 && s.active.id === pop);
    ok("a pop-up becomes a tab and is shown", s.tabs.length === 2 && s.active.id === pop);
    ok("the stream moved to it", cdp.count("Page.startScreencast", "s-" + pop) >= 1 && cdp.count("Page.stopScreencast", "s-" + first.id) >= 1);
    ok("it is sized like the others", cdp.count("Emulation.setDeviceMetricsOverride", "s-" + pop) === 1);
    ok("and a page's choose-file is caught there too", cdp.count("Page.setInterceptFileChooserDialog", "s-" + pop) === 1);

    cdp.popup("someone-elses-context", "https://x/");
    await wait(30);
    ok("a page in another context is not anybody's tab here", s.tabs.length === 2);

    /* Only the tab on screen reaches the panel. */
    v.frames = 0;
    cdp.emit("s-" + first.id + ":Page.screencastFrame", { data: "", sessionId: 1 });
    cdp.emit("s-" + pop + ":Page.screencastFrame", { data: "", sessionId: 2 });
    await wait(10);
    ok("pictures come only from the tab on screen", v.frames === 1);
    v.got.length = 0;
    cdp.emit("s-" + first.id + ":Page.frameNavigated", { frame: { url: "https://behind/" } });
    ok("a tab behind navigating is not shown as navigation", !v.got.some((m) => m.t === "nav") && first.url === "https://behind/");
    cdp.emit("s-" + first.id + ":Page.javascriptDialogOpening", { type: "alert", message: "hi" });
    ok("its dialog waits for it", !v.got.some((m) => m.t === "dialog") && first.dialog && first.dialog.message === "hi");
    await eng.switchTab(s, first.id);
    ok("and appears when it is shown", v.got.some((m) => m.t === "dialog" && m.dialog.message === "hi"));
    cdp.emit("Target.targetInfoChanged", { targetInfo: { targetId: pop, type: "page", title: "Example Domain", url: "https://example.com/" } });
    ok("a title change reaches the strip", v.got.some((m) => m.t === "tabs" && m.tabs.some((t) => t.title === "Example Domain")));

    cdp.popup(s.browserContextId, "https://three/");
    await until(() => s.tabs.length === 3);
    const v2 = v.got.length;
    cdp.popup(s.browserContextId, "https://four/");
    await wait(40);
    ok("past the most, a pop-up is closed and the person told", s.tabs.length === 3 &&
      v.got.slice(v2).some((m) => m.t === "note" && /most/.test(m.why)));

    await eng.closeTab(s, s.active.id);
    ok("closing the tab on screen shows another", s.tabs.length === 2 && s.tabs.indexOf(s.active) >= 0);
    await eng.closeTab(s, s.tabs[0].id);
    await eng.closeTab(s, s.tabs[0].id);
    await wait(30);
    ok("closing the last opens a blank one rather than nothing", s.tabs.length === 1 && s.active.url === "about:blank");
    await eng.openTab(s, null);
    ok("+TAB", s.tabs.length === 2 && s.active === s.tabs[1]);
    await eng.resize(s, 900, 500, 1);
    ok("a resize reaches every tab", s.tabs.every((t) => cdp.calls.some((c) => c.method === "Emulation.setDeviceMetricsOverride" && c.sid === "s-" + t.id && c.p.width === 900)));
  }

  section("downloads");
  {
    const cdp = fakeCdp();
    const eng = engineOn(cdp, { downloadMaxMB: 1 });
    const s = await eng.sessionFor("msg:bo", { tier: "member" });
    const v = viewer();
    await eng.attach(s, v);
    ok("each session downloads into its own folder", cdp.calls.some((c) => c.method === "Browser.setDownloadBehavior" &&
      c.p.browserContextId === s.browserContextId && c.p.downloadPath.indexOf(s.dir) === 0 && c.p.behavior === "allowAndName"));
    cdp.emit("Browser.downloadWillBegin", { guid: "g1", url: "https://x/a.zip", suggestedFilename: "../../a.zip", frameId: s.active.id });
    ok("it is told who it is for, by the tab that started it", s.downloads.has("g1") && s.downloads.get("g1").name === "a.zip");
    fs.writeFileSync(s.downloads.get("g1").path, "zipzip");
    cdp.emit("Browser.downloadProgress", { guid: "g1", receivedBytes: 6, totalBytes: 6, state: "completed" });
    ok("finished, the panel hears it", v.got.some((m) => m.t === "download" && m.state === "completed" && m.name === "a.zip"));
    const d = eng.download(s, "g1");
    ok("and it can be fetched", d && d.size === 6 && d.name === "a.zip");
    cdp.emit("Browser.downloadWillBegin", { guid: "g2", url: "https://x/big", suggestedFilename: "big.iso", frameId: s.active.id });
    cdp.emit("Browser.downloadProgress", { guid: "g2", receivedBytes: 2 * 1048576, totalBytes: 9 * 1048576, state: "inProgress" });
    ok("over the most, it is cancelled and the person told why",
      cdp.calls.some((c) => c.method === "Browser.cancelDownload" && c.p.guid === "g2") &&
      v.got.some((m) => m.t === "download" && m.id === "g2" && m.state === "canceled" && /1 MB/.test(m.why)));
    ok("an unfinished one cannot be fetched", eng.download(s, "g2") === null);
    s.downloads.get("g1").at = Date.now() - 16 * 60000;
    eng.evictIdle();
    ok("a finished one goes after 15 minutes", !s.downloads.has("g1") && !fs.existsSync(d.path));
  }

  section("a page's choose-file");
  {
    const cdp = fakeCdp();
    const eng = engineOn(cdp);
    const s = await eng.sessionFor("msg:cy", { tier: "member" });
    const v = viewer();
    await eng.attach(s, v);
    let refused = null;
    try { eng.takeUpload(s, "a.txt", Buffer.from("a")); } catch (e) { refused = e.message; }
    ok("no page asking: nothing is taken", /no page is asking/.test(refused || ""));
    cdp.emit("s-" + s.active.id + ":Page.fileChooserOpened", { backendNodeId: 42, mode: "selectSingle" });
    ok("a page asking reaches the panel", v.got.some((m) => m.t === "choose-file" && m.multiple === false));
    const id1 = eng.takeUpload(s, "..\\..\\Windows\\evil.exe", Buffer.from("x"));
    const id2 = eng.takeUpload(s, "second.txt", Buffer.from("y"));
    const up = s.uploads.find((u) => u.id === id1);
    ok("saved under its name only, inside the session's folder", up.file.indexOf(s.dir) === 0 && up.file.endsWith("evil.exe") &&
      fs.readFileSync(up.file, "utf8") === "x");
    const n = await eng.setFiles(s, [id1, id2, "made-up"]);
    const set = cdp.calls.find((c) => c.method === "DOM.setFileInputFiles");
    ok("a single-file box gets one, at the node that asked", n === 2 && set.p.backendNodeId === 42 && set.p.files.length === 1);
    ok("and the page is no longer asking", s.chooser === null);
    ok("names are only names", cleanName("../../x/y.txt") === "y.txt" && cleanName(".bashrc") === "bashrc" &&
      cleanName("a\u0000b<c>.txt") === "a_b_c_.txt" && cleanName("x".repeat(300) + ".png").length === 120 && /\.png$/.test(cleanName("x".repeat(300) + ".png")));
  }

  section("the pointer");
  {
    const cdp = fakeCdp();
    const eng = engineOn(cdp);
    const s = await eng.sessionFor("msg:di", { tier: "member" });
    cdp.evalAnswer = "pointer";
    ok("a shape the page asks for is passed on", (await eng.cursorAt(s, 10, 10)) === "pointer");
    cdp.evalAnswer = "text";
    ok("asked at most every 150 ms", (await eng.cursorAt(s, 10, 10)) === null);
    s.cursorAt = 0;
    ok("then again", (await eng.cursorAt(s, 10, 10)) === "text");
    s.cursorAt = 0;
    ok("an unchanged shape is not sent again", (await eng.cursorAt(s, 10, 10)) === null);
    s.cursorAt = 0;
    cdp.evalAnswer = "url(evil.png), auto";
    ok("anything not on the list is the arrow", (await eng.cursorAt(s, 10, 10)) === "default" && CURSORS.indexOf("url(evil.png)") < 0);
  }

  section("how long a session lasts");
  {
    const cdp = fakeCdp();
    const eng = engineOn(cdp, { guestGraceSec: 0.05 });
    const g = await eng.sessionFor("guest-1", { tier: "guest" });
    const v = viewer();
    await eng.attach(g, v);
    await eng.detach(g, v);
    ok("a guest's closed browser waits a moment, for a dropped connection", eng.sessions.has("guest-1"));
    await eng.attach(g, v);
    await wait(80);
    ok("back in time: still there", eng.sessions.has("guest-1"));
    await eng.detach(g, v);
    await until(() => !eng.sessions.has("guest-1"), 1000);
    ok("closed for good: gone", !eng.sessions.has("guest-1"));

    const m = await eng.sessionFor("msg:em", { tier: "member" });
    cdp.cookies[m.browserContextId] = [{ name: "sid", value: "1", domain: "x.com" }];
    const mv = viewer();
    await eng.attach(m, mv);
    await eng.detach(m, mv);
    await wait(80);
    ok("a member's closed browser stays", eng.sessions.has("msg:em"));
    await eng.destroy("msg:em", "idle");
    ok("ended for being idle, their sign-ins are kept in memory", eng.kept.has("msg:em"));
    const m2 = await eng.sessionFor("msg:em", { tier: "member" });
    ok("and put back in the next session", (cdp.cookies[m2.browserContextId] || []).some((c) => c.name === "sid"));
    ok("once", !eng.kept.has("msg:em"));
    await eng.destroy("msg:em", "idle");
    await eng.clearAll({ key: "msg:em", who: "msg:em" }).catch(() => {});
    ok("WIPE forgets them too", !eng.kept.has("msg:em"));
    eng.kept.set("msg:old", { cookies: [{}], at: Date.now() - 13 * 3600000 });
    eng.evictIdle();
    ok("and after 12 hours they are gone anyway", !eng.kept.has("msg:old"));
    const g2 = await eng.sessionFor("guest-2", { tier: "guest" });
    cdp.cookies[g2.browserContextId] = [{ name: "sid", value: "1" }];
    await eng.destroy("guest-2", "idle");
    ok("a guest's never are", !eng.kept.has("guest-2"));
  }

  section("the route's single-use links");
  {
    const cdp = fakeCdp();
    const eng = route.init({ config: { enabled: true, video: false, uploadMaxMB: 1 }, log: () => {} });
    eng.ready = true;
    eng.cdp = cdp;
    eng.start = async () => true;
    const s = await eng.sessionFor("msg:fi", { tier: "member" });
    fs.mkdirSync(s.dir + "/dl", { recursive: true });
    fs.writeFileSync(s.dir + "/dl/g9", "the bytes");
    s.downloads.set("g9", { id: "g9", name: "notes ü.txt", state: "completed", path: s.dir + "/dl/g9", at: Date.now() });

    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      const send = (r, code, body) => { r.writeHead(code, { "Content-Type": "application/json" }); r.end(JSON.stringify(body)); };
      if (!(await route.route(req, res, url, { send, authorise: () => null, readBody: async () => ({}) }))) send(res, 404, {});
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + srv.address().port;
    const tok = route._internals.linkFor("dl", s.key, "g9");
    const r1 = await fetch(base + "/browser/file/" + tok);
    const body = await r1.text();
    ok("a download's link gives its bytes, as an attachment under its name",
      r1.status === 200 && body === "the bytes" && /filename\*=UTF-8''notes%20%C3%BC\.txt/.test(r1.headers.get("content-disposition")),
      r1.status + " " + r1.headers.get("content-disposition"));
    const r2 = await fetch(base + "/browser/file/" + tok);
    ok("once", r2.status === 404);
    const r3 = await fetch(base + "/browser/file/" + route._internals.linkFor("dl", "msg:someone-else", "g9"));
    ok("a link for another session finds nothing here", r3.status === 404);
    const r4 = await fetch(base + "/browser/file/made-up");
    ok("a made-up link finds nothing, without signing in being the question", r4.status === 404);

    const put = (t, name, bytes) => fetch(base + "/browser/put/" + t + "?name=" + encodeURIComponent(name), { method: "POST", body: bytes });
    const up = route._internals.linkFor("up", s.key, null);
    const p0 = await put(up, "a.txt", "aaa");
    ok("an upload link with no page asking is refused", p0.status === 409);
    s.chooser = { tab: s.active, node: 7, multiple: true, at: Date.now() };
    const p1 = await put(up, "a.txt", "aaa");
    const j1 = await p1.json();
    ok("with a page asking, the file is taken", p1.status === 201 && typeof j1.id === "string" && s.uploads.some((u) => u.id === j1.id));
    const p2 = await put(up, "big.bin", Buffer.alloc(1048576 + 10));
    ok("over the most, refused with the reason", p2.status === 413 && /1 MB/.test((await p2.json()).error));
    const p3 = await put("nope", "a.txt", "a");
    ok("a made-up upload link is refused", p3.status === 404);
    await new Promise((r) => srv.close(r));
    await wait(400);          /* undici finishes closing; exiting sooner aborts Node on Windows */
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
