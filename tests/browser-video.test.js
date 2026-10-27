/* ============================================================
   The streamed browser as video (RUNNER_PLAN.md §23) — the encoder
   wrapper and the route's choice between video and pictures, with
   tests/fake-ffmpeg.js standing in for ffmpeg. The real encoder was
   measured against a real Chromium in the relay image; the numbers
   are in FIELDKIT_PROJECT.md §14.18.

   What matters:
     1. A frame gets out without waiting for the next one, and a page
        that stops moving ends on its last picture, sharpened.
     2. Busy pages are held to 30 encodes a second, the newest kept.
     3. A panel that did not ask for video, or a relay whose encoder
        fails, gets the pictures it always got.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { makeRunner } = require("./harness");
const venc = require("../relay/video-encoder");
const route = require("../relay/browser-route");

const { ok, section, state } = makeRunner("browser-video");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-browser-video-"));
const FAKE = [process.execPath, path.join(__dirname, "fake-ffmpeg.js")];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 4000); while (Date.now() < end) { if (fn()) return true; await wait(25); } return false; };

/* The smallest JPEG header jpegSize has to read: SOI, an APP0, a SOF0
   with the size, then filler, ending in a 4-byte tag. */
function jpeg(w, h, tag, sof) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sofm = Buffer.from([0xff, sof || 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const t = Buffer.alloc(4); t.writeUInt32BE(tag >>> 0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofm, Buffer.alloc(64, 0x55), t]);
}
const tagOf = (au) => au.readUInt32BE(au.length - 4);

(async () => {
  section("reading a picture's size from its header");
  {
    ok("baseline", JSON.stringify(venc.jpegSize(jpeg(1000, 600, 1))) === '{"h":600,"w":1000}');
    ok("progressive", JSON.stringify(venc.jpegSize(jpeg(321, 123, 1, 0xc2))) === '{"h":123,"w":321}');
    ok("not a JPEG", venc.jpegSize(Buffer.from("GIF89a....")) === null);
    ok("cut short", venc.jpegSize(jpeg(10, 10, 1).subarray(0, 24)) === null);
  }

  section("finding whole frames in H.264");
  {
    const A = (n, key) => Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, key ? 0x65 : 0x41, n]);
    ok("a keyframe is recognised", venc.isKey(A(1, true)) && !venc.isKey(A(1, false)));
    const got = [];
    const sp = venc.splitter((au, key) => got.push([au[au.length - 1], key]), 30);
    const all = Buffer.concat([Buffer.from([7, 7]), A(1, true), A(2, false), A(3, false)]);
    sp.push(all.subarray(0, 9)); sp.push(all.subarray(9, 20)); sp.push(all.subarray(20));
    ok("frames split at their markers, whatever the chunking", got.length === 2 && got[0][0] === 1 && got[0][1] && got[1][0] === 2);
    await wait(80);
    ok("the last frame comes out when the encoder goes quiet", got.length === 3 && got[2][0] === 3);
    ok("bytes before the first marker are dropped", !got.some((g) => g[0] === 7));
  }

  section("the encoder wrapper");
  {
    const LOG = path.join(TMP, "ff1.log");
    process.env.FK_FAKE_FFMPEG_LOG = LOG;
    const tx = new venc.Transcoder({ ffmpeg: FAKE, kbps: 900, maxFps: 30 });
    const starts = [], frames = [];
    tx.on("start", (s) => starts.push(s));
    tx.on("frame", (au, key) => frames.push({ tag: tagOf(au), key }));
    tx.feed(jpeg(1001, 601, 1));
    ok("it starts at once, at an even size", starts.length === 1 && starts[0].w === 1000 && starts[0].h === 600);
    await until(() => frames.length >= 1);
    ok("the first picture comes out as a keyframe, without waiting for a second", frames[0] && frames[0].key && frames[0].tag === 1);
    const lines = () => fs.readFileSync(LOG, "utf8").trim().split("\n");
    ok("cropped to that size and capped at the bitrate", /crop=1000:600/.test(lines()[0]) && /-maxrate 900k/.test(lines()[0]));

    for (let i = 2; i <= 11; i++) tx.feed(jpeg(1001, 601, i));
    await until(() => frames.some((f) => f.tag === 11), 2000);
    /* The first of the ten can go straight in (a frame's time has passed
       since picture 1); the eight in between are never encoded. */
    ok("ten pictures inside a frame's time: the in-between ones are skipped, the newest encoded a moment later",
      frames.some((f) => f.tag === 11) && !frames.some((f) => f.tag >= 3 && f.tag <= 10));

    const before = frames.length;
    await wait(1600);
    const settled = frames.slice(before);
    ok("when the page stops, its last picture is encoded again to sharpen it (" + settled.length + " passes)",
      settled.length === 10 && settled.every((f) => f.tag === 11));
    await wait(400);
    ok("and then nothing more is sent", frames.length === before + 10);

    tx.feed(jpeg(800, 500, 99));
    await until(() => starts.length === 2 && lines().filter((l) => /^start /.test(l)).length === 2);
    ok("a new size starts a fresh encoder, which says so", starts.length === 2 && starts[1].w === 800 &&
      lines().filter((l) => /^start /.test(l)).length === 2);
    await until(() => frames.some((f) => f.tag === 99));
    ok("whose first frame is a keyframe", frames.find((f) => f.tag === 99).key === true);
    await wait(1700);
    const held0 = frames.length;
    tx.feed(jpeg(800, 500, 100));
    await until(() => frames.some((f) => f.tag === 100));
    tx.hold();
    await wait(1600);
    ok("held (the panel was hidden): no sharpening passes", frames.length === held0 + 1, (frames.length - held0) + " frames");
    tx.close();
    const n = frames.length;
    await wait(500);
    ok("closed means closed: no settle passes after", frames.length === n);
  }

  section("an encoder that fails");
  {
    process.env.FK_FAKE_FFMPEG_DIE = "2";
    const tx = new venc.Transcoder({ ffmpeg: FAKE, maxFps: 1000 });
    let why = null;
    tx.on("fail", (w) => { why = w; });
    tx.on("frame", () => {});
    tx.feed(jpeg(100, 100, 1));
    await wait(60);
    tx.feed(jpeg(100, 100, 2));
    await until(() => why, 3000);
    ok("says so, with what it said", /fake failure/.test(why || ""));
    tx.close();
    delete process.env.FK_FAKE_FFMPEG_DIE;
  }

  section("the route: video for panels that ask, pictures for the rest");
  {
    process.env.FK_FAKE_FFMPEG_LOG = path.join(TMP, "ff2.log");
    const eng = route.init({ config: { enabled: true, ffmpeg: FAKE }, log: () => {} });
    const viewers = [];
    let refreshes = 0;
    const fakeSession = { url: "about:blank", title: "" };
    eng.sessionFor = async () => fakeSession;
    eng.resize = async () => {};
    eng.attach = async (s, v) => { viewers.push(v); };
    eng.detach = async () => {};
    eng.refresh = async () => { refreshes++; };
    ok("the relay offers video when it has an encoder", eng.videoBin === FAKE);

    const srv = http.createServer();
    srv.on("upgrade", (req, sock, head) => route.upgrade(req, sock, head, new URL(req.url, "http://x")));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const open = async (video) => {
      const sock = new WebSocket("ws://127.0.0.1:" + port + "/browser/stream?t=" + route._internals.issue("u-" + video));
      sock.binaryType = "arraybuffer";
      const c = { sock, text: [], bin: [] };
      sock.addEventListener("message", (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); else c.bin.push(Buffer.from(e.data)); });
      await new Promise((r) => sock.addEventListener("open", r));
      sock.send(JSON.stringify({ t: "hello", w: 1000, h: 600, video: video }));
      await until(() => c.text.some((m) => m.t === "ready"));
      c.viewer = viewers[viewers.length - 1];
      return c;
    };

    const v = await open(true);
    ok("a panel that asks gets video", v.text.find((m) => m.t === "ready").video === true && !!v.viewer.video);
    v.viewer.onFrame(jpeg(1000, 600, 5).toString("base64"));
    await until(() => v.bin.length >= 1);
    ok("the size comes first, then frames flagged as keyframes", JSON.stringify(v.text.find((m) => m.t === "video")) === '{"t":"video","w":1000,"h":600}' &&
      v.bin[0][0] === 1 && v.bin[0].indexOf(venc.AUD) === 1);

    const p = await open(false);
    ok("a panel that does not ask gets pictures", p.text.find((m) => m.t === "ready").video === false && !p.viewer.video);
    const pic = jpeg(1000, 600, 6);
    p.viewer.onFrame(pic.toString("base64"));
    await until(() => p.bin.length >= 1);
    ok("the picture itself, byte for byte", p.bin[0].equals(pic));

    v.sock.send(JSON.stringify({ t: "keyframe" }));
    v.sock.send(JSON.stringify({ t: "keyframe" }));
    v.sock.send(JSON.stringify({ t: "keyframe" }));
    await wait(300);
    ok("a decoder that lost its place gets a fresh start, at most once a second", refreshes === 1);
    ok("several asks at once are one strain, not a step down", v.viewer.quality.own === 0);

    /* This viewer's own connection: three strains apart, a step down. */
    for (let i = 0; i < 3; i++) { v.sock.send(JSON.stringify({ t: "keyframe" })); await wait(560); }
    await until(() => v.text.some((m) => m.t === "quality"));
    ok("a panel that keeps falling behind gets its own video turned down", v.viewer.quality.own === 1 && v.viewer.video.kbps === 900,
      JSON.stringify(v.viewer.quality));
    ok("and is told why", v.text.some((m) => m.t === "quality" && m.step === 1 && m.kbps === 900 && /connection/.test(m.why)));
    v.viewer.quality.last = v.viewer.quality.at = Date.now() - 31000;
    v.viewer.onFrame(jpeg(1000, 600, 9).toString("base64"));
    await until(() => v.text.some((m) => m.t === "quality" && m.step === 0));
    ok("after half a minute of calm it goes back up", v.viewer.quality.own === 0 && v.viewer.video.kbps === 1500);

    process.env.FK_FAKE_FFMPEG_DIE = "1";
    const f = await open(true);
    f.viewer.onFrame(jpeg(1000, 600, 7).toString("base64"));
    await until(() => f.text.some((m) => m.t === "video" && m.off), 3000);
    ok("an encoder that fails falls back to pictures, and the panel is told", f.text.some((m) => m.t === "video" && m.off) && !f.viewer.video);
    const pic2 = jpeg(1000, 600, 8);
    f.viewer.onFrame(pic2.toString("base64"));
    await until(() => f.bin.some((b) => b.equals(pic2)));
    ok("after which pictures flow", f.bin.some((b) => b.equals(pic2)));
    delete process.env.FK_FAKE_FFMPEG_DIE;

    [v, p, f].forEach((c) => c.sock.close());
    await wait(200);
    ok("closing the panel stops its encoder", !v.viewer.video);
    srv.close();
  }

  section("everything the relay loads ships in its image");
  {
    /* The relay is baked into an image from an allow list in
       tools/make-deploy.js. A module missing from it is a relay that
       starts here and crashes on Bastion 1. */
    const src = fs.readFileSync(path.join(__dirname, "..", "tools", "make-deploy.js"), "utf8");
    const list = JSON.parse("[" + /const RELAY_CODE = \[([^\]]*)\]/.exec(src)[1].replace(/\s+/g, " ") + "]");
    const seen = new Set(), todo = ["start.js", "server.js"];
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      const code = fs.readFileSync(path.join(__dirname, "..", "relay", f), "utf8");
      const re = /require\(["']\.\/([\w.-]+?)(?:\.js)?["']\)/g;
      let m;
      while ((m = re.exec(code))) todo.push(m[1] + ".js");
    }
    const missing = [...seen].filter((f) => list.indexOf(f) < 0);
    ok("every module start.js and server.js load is in the image (" + seen.size + ")", missing.length === 0, missing.join(", "));
    ok("including the video encoder", list.indexOf("video-encoder.js") >= 0);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
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
