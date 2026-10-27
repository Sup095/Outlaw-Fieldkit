/* ============================================================
   The streamed browser's sound (FIELDKIT_PROJECT.md §14.37).

   The real thing (PulseAudio, a Chromium per session, ffmpeg) is
   proven on Linux in the relay's own image; this suite proves the
   parts that decide what is sent, on any machine:
     1. Opus packets come out of Ogg whole, however the bytes arrive,
        and the two header packets never reach a panel.
     2. Sound is encoded only while someone is listening: a panel that
        asked for it and is not hidden. Silence is not sent.
     3. Each session's sound goes to that session's panels only.
     4. Without a sound server, nothing changes: one muted Chromium.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeRunner } = require("./harness");
const { page } = require("./ogg-pages");
const { OggOpus } = require("../relay/ogg-opus");
const { Engine } = require("../relay/browser-engine");
const { Pulse } = require("../relay/pulse");

const { ok, section, state } = makeRunner("browser-sound");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await wait(20); } return false; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-sound-"));
const LOG = path.join(TMP, "audio.log");
const FAKE = [process.execPath, path.join(__dirname, "fake-ogg-audio.js")];

(async () => {
  section("Opus packets out of Ogg");
  {
    const got = [];
    const o = new OggOpus((p) => got.push(p));
    const head = page([Buffer.from("OpusHead....."), Buffer.from("OpusTags....")], 0);
    const big = Buffer.alloc(600, 7);
    const stream = Buffer.concat([
      Buffer.from("rubbish before the first page"),
      head,
      page([Buffer.alloc(40, 1), Buffer.alloc(255, 2)], 1),       /* exactly 255: laced as 255 then 0 */
      page([big.subarray(0, 510)], 2, { open: true }),             /* a packet that goes on... */
      page([big.subarray(510)], 3, { continued: true })            /* ...onto the next page */
    ]);
    for (let i = 0; i < stream.length; i += 7) o.push(stream.subarray(i, i + 7));
    ok("the two header packets are skipped", !got.some((p) => /Opus(Head|Tags)/.test(p.toString("latin1"))));
    ok("packets come out whole, in order, however the bytes arrive",
      got.length === 3 && got[0].length === 40 && got[1].length === 255 && got[2].length === 600, got.map((p) => p.length).join());
    ok("a packet that spans two pages is joined", got[2] && got[2].equals(big));
    const o2 = new OggOpus(() => {});
    o2.push(Buffer.alloc(300 * 1024, 0x20));
    ok("bytes that are never a page are not held", o2.buf.length === 0 || o2.buf.length < 27);
  }

  section("without a sound server, nothing changes");
  {
    const p = new Pulse({ bin: path.join(TMP, "no-pulseaudio"), pactl: path.join(TMP, "no-pactl") });
    ok("a missing PulseAudio is simply not available", !p.available());
    ok("and starting it says no, without throwing", (await p.start()) === false);
    const e = new Engine({ config: { enabled: true, sound: true, pulse: path.join(TMP, "no-pulseaudio") }, log: () => {} });
    clearInterval(e._sweep);
    ok("the engine runs without sound", e.soundOn === false && e.status().sound === false);
  }

  section("encoded only while someone listens");
  const eng = new Engine({ config: { enabled: true }, log: () => {} });
  clearInterval(eng._sweep);
  eng.soundOn = true;
  eng.videoBin = FAKE;
  process.env.FK_FAKE_AUDIO_LOG = LOG;
  process.env.FK_FAKE_AUDIO_SIZES = "3,80,5,120";
  const mk = (key) => {
    const s = { key, who: key, viewers: new Set(), host: { sink: { name: "fk_" + key } }, audio: null, audioFails: 0 };
    eng.sessions.set(key, s);
    return s;
  };
  const viewer = (sound) => { const v = { sound, paused: false, got: [] }; v.onAudio = (p) => v.got.push(p); return v; };
  const starts = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).length : 0);
  {
    const a = mk("alice");
    const quiet = viewer(false);
    a.viewers.add(quiet);
    eng._audioCheck(a);
    ok("a panel that did not ask for sound starts no encoder", !a.audio && starts() === 0);

    const loud = viewer(true);
    a.viewers.add(loud);
    eng._audioCheck(a);
    ok("one that asks starts one", !!a.audio && (await until(() => starts() === 1)));
    const args = JSON.parse(fs.readFileSync(LOG, "utf8").trim().split("\n")[0]);
    ok("recording this session's own sink, to Opus at the set rate",
      args[args.indexOf("-i") + 1] === "fk_alice.monitor" && args.indexOf("libopus") > 0 && args[args.indexOf("-b:a") + 1] === "48k",
      JSON.stringify(args));
    await until(() => loud.got.length >= 4, 3000);
    ok("the listener gets packets", loud.got.length >= 4);
    ok("but never silence (packets of a few bytes)", loud.got.every((p) => p.length > 12), loud.got.map((p) => p.length).join());
    ok("and the panel that did not ask gets nothing", quiet.got.length === 0);

    const b = mk("bob");
    const bobs = viewer(true);
    b.viewers.add(bobs);
    eng._audioCheck(b);
    await until(() => bobs.got.length >= 2, 3000);
    ok("another session has its own encoder, on its own sink", starts() === 2 && !!b.audio && b.audio !== a.audio);
    const n = loud.got.length;
    await wait(120);
    ok("and each session's sound reaches only its own panels", bobs.got.length >= 2 && loud.got.length > n &&
      !bobs.got.some((p) => loud.got.includes(p)));

    loud.paused = true;
    eng._audioCheck(a);
    ok("hidden, the only listener stops the encoder", !a.audio);
    loud.paused = false;
    const v2 = eng.setSound(a, loud, true);
    ok("shown again, it starts again", !!a.audio && v2 === true);
    eng.setSound(a, loud, false);
    ok("SOUND OFF in the panel stops it", !a.audio && loud.sound === false);
    eng.setSound(a, loud, true);
    await eng.destroy("alice", "test");
    ok("a session that ends takes its encoder with it", !a.audio);
    a.viewers.add(loud);
    eng._audioCheck(a);
    ok("and an ended session never starts one again", !a.audio);
    eng.soundOn = false;
    eng._audioCheck(b);
    ok("an engine without sound stops what is running", !b.audio);
  }

  section("the stand-in for a session without a sink");
  {
    eng.soundOn = true;
    const c = { key: "carol", who: "carol", viewers: new Set([viewer(true)]), host: null, audio: null, audioFails: 0 };
    eng.sessions.set("carol", c);
    eng._audioCheck(c);
    ok("a session on the shared, muted Chromium has no sound to send", !c.audio);
    ok("and the panel is told so", eng.setSound(c, [...c.viewers][0], true) === false);
  }

  await wait(100);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }
  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED: " + (e.stack || e.message)); process.exit(1); });
