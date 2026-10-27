/* ============================================================
   RUNNER — programs that come as a .zip (RUNNER_PLAN.md phase 7).

   The order of what matters:
     1. Reading a zip's index never trusts its numbers: a broken or
        lying zip is refused with a sentence, not a crash.
     2. Only a plain relative name inside the zip can be chosen to run:
        nothing absolute, nothing with "..".
     3. Unpacking happens in the box, and a zip that would unpack to
        more than the box has room for is stopped before it writes.
     4. The chosen file starts from its own folder, beside its data.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { makeRunner } = require("./harness");
const { connect, wait, makeZip } = require("./runner-kit");
const ticket = require("../runnerd/ticket");
const runnerd = require("../runnerd/server");
const sandbox = require("../runnerd/sandbox");
const zip = require("../runnerd/zip");

const { ok, section, state } = makeRunner("runner-zip");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fk-runner-zip-"));
const STORE = path.join(TMP, "store");
const pair = crypto.generateKeyPairSync("ed25519");
const sign = (handle, tier) => ticket.sign(pair.privateKey, { handle, tier, exp: Date.now() + 30000 });

const onDisk = (name, buf) => { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; };
const refuses = (fn) => { try { fn(); return ""; } catch (e) { return e.message || "x"; } };

/* The folder a program might come in. */
const GAME = makeZip([
  { name: "Game/", data: "" },
  { name: "Game/play.py", deflate: true, data:
    "import os, sys\nprint('cwd ' + os.path.basename(os.getcwd()))\n" +
    "print('level ' + open(os.path.join('data', 'level.txt')).read().strip())\nprint('args ' + ' '.join(sys.argv[1:]))\n" },
  { name: "Game/data/level.txt", data: "seven\n" },
  { name: "Game/tools/fix.sh", data: "echo fixed\n", exec: true },
  { name: "readme.txt", data: "hello" },
  { name: "__MACOSX/Game/._play.py", data: "junk" },
  { name: "../escape.py", data: "print('out')" }
]);

section("reading the index");
{
  const l = zip.list(onDisk("game.zip", GAME));
  ok("files are listed, folders are not", l.entries.length === 6 && !l.entries.some((e) => e.name.endsWith("/")),
    JSON.stringify(l.entries.map((e) => e.name)));
  ok("with their unpacked sizes, added up", l.total === l.entries.reduce((a, e) => a + e.size, 0) && l.total > 100);
  const r = zip.runnable(l.entries);
  ok("runnable files are offered, shallow first", r.join(",") === "Game/play.py,Game/tools/fix.sh", r.join(","));
  ok("never the mac junk, never a name with ..", !r.some((n) => /MACOSX|\.\./.test(n)));
  ok("a zip is known by its first bytes", zip.isZip(GAME) && !zip.isZip(Buffer.from("MZ..")));

  ok("a file that is not a zip is refused with a sentence",
    /no index/.test(refuses(() => zip.list(onDisk("not.zip", Buffer.alloc(200, 7))))));
  ok("so is one too short to be anything", /not a zip/.test(refuses(() => zip.list(onDisk("tiny.zip", Buffer.from("PK"))))));
  ok("an index that points past the end is refused",
    /past its end/.test(refuses(() => zip.list(onDisk("lie.zip", makeZip([{ name: "a.py", data: "1" }], { cdOff: 1e8 }))))));
  const cut = GAME.subarray(0, GAME.length - 30);
  ok("a cut-off download is refused, not misread", refuses(() => zip.list(onDisk("cut.zip", cut))) !== "");
}

section("which names may be chosen");
{
  ok("plain relative names are fine", zip.cleanEntry("Game/play.py") === "Game/play.py");
  ok("backslashes become slashes", zip.cleanEntry("Game\\play.py") === "Game/play.py");
  for (const bad of ["../x.py", "a/../../x.py", "/etc/passwd", "C:/x.exe", "./x.py", "dir/", "", "a\nb", "x".repeat(300)]) {
    ok("refused: " + JSON.stringify(bad.slice(0, 20)), zip.cleanEntry(bad) === null);
  }
}

section("the plan for a zip");
{
  ok("without a chosen file, it refuses", /choose which file/.test(refuses(() => sandbox.plan("g.zip", "zip", [], "/job"))));
  const p = sandbox.plan("g.zip", "zip", ["--fast"], "/job", false, { entry: "Game/play.py", capBytes: 1000 });
  ok("Python unpacks it inside the box", p.argv[0] === "python3" && p.argv[1] === "-c" && /extractall/.test(p.argv[2]));
  ok("then the zip, the file, the room, where, and the program's arguments",
    p.argv.slice(3).join(" ") === "/job/g.zip Game/play.py 1000 /work/app --fast", p.argv.slice(3).join(" "));
  ok("a script runs in the plain image", p.image === "base");
  const w = sandbox.plan("g.zip", "zip", [], "/job", false, { entry: "Bin/Game.exe", capBytes: 1000 });
  ok("an .exe inside runs in the Windows image", w.image === "wine");
  const s = sandbox.plan("g.zip", "zip", [], "/job", true, { entry: "Bin/Game.exe", capBytes: 1000 });
  ok("and can have a window (the screen box has Wine and Python too)", s.screen === true && s.image === "screen" && s.argv[0] === "fk-screen");
  ok("the unpacker refuses a zip that would not fit before writing", /total > cap/.test(p.argv[2]) && /sys\.exit\(97\)/.test(p.argv[2]));
}

/* The real thing, through the run server with the process driver.
   It needs a python3; the run server's images always have one. */
const PY = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).stdout === "1\n" ||
  spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).stdout === "1\r\n";

(async () => {
  const app = runnerd.create(Object.assign({}, runnerd.DEFAULTS, { host: "127.0.0.1", port: 0,
    storePath: STORE, driver: "process", dev: true,
    ticketPublicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), () => {});
  const port = await app.listen();
  const realDisk = app.store.disk.bind(app.store);
  app.store.disk = () => Object.assign(realDisk(), { pct: 0.5 });
  const as = async (h, tier) => { const c = await connect(port, sign(h, tier)); c.ready = await c.hello(); return c; };

  section("the server tells the panel what is inside");
  const alice = await as("alice", "member");
  const up = await alice.put("game.zip", GAME);
  ok("a zip uploads, and is known as one", up.t === "put-done" && app.store.sniff({ kind: "member", handle: "alice" }, up.file.id) === "zip",
    JSON.stringify(up).slice(0, 200));
  const ls = await alice.ask({ t: "zip-ls", file: up.file.id });
  ok("zip-ls lists what can be run", ls.t === "zip" && ls.runnable.join(",") === "Game/play.py,Game/tools/fix.sh",
    JSON.stringify(ls).slice(0, 300));
  ok("with the size it unpacks to and the room there is", ls.total > 0 && ls.room > ls.total && ls.files === 6);
  const txt = await alice.put("notes.txt", "just words");
  const nz = await alice.ask({ t: "zip-ls", file: txt.file && txt.file.id });
  ok("asking about a file that is not a zip is refused", nz.t === "error" && /not a zip/.test(nz.why), JSON.stringify(nz));
  const bob = await as("bob", "member");
  const other = await bob.ask({ t: "zip-ls", file: up.file.id });
  ok("and nobody can look inside someone else's zip", other.t === "error", JSON.stringify(other));

  section("choosing the file to run");
  const none = await alice.run(up.file.id, []);
  ok("running a zip without choosing is refused", none.t === "error" && /choose which file/.test(none.why), JSON.stringify(none));
  const esc = await alice.run(up.file.id, [], { entry: "../escape.py" });
  ok("choosing a name with .. is refused", esc.t === "error", JSON.stringify(esc));

  if (!PY) {
    ok("(no python3 on this computer: the unpack-and-run checks are skipped)", true);
  } else {
    section("it unpacks in the box and runs from its own folder");
    const r = await alice.run(up.file.id, ["fast", "loud"], { entry: "Game/play.py" });
    ok("it starts", r.t === "job", JSON.stringify(r));
    const outs = [];
    const ex = await alice.next((m) => {
      if (m.t === "out" && m.job === r.job.id) outs.push(m.d);
      return m.t === "exit" && m.job === r.job.id;
    }, 15000);
    const text = outs.join("") + alice.got.filter((m) => m.t === "out" && m.job === r.job.id).map((m) => m.d).join("");
    ok("it finished cleanly", ex.code === 0, JSON.stringify(ex) + " " + text);
    ok("in its own folder", /cwd Game/.test(text), text);
    ok("and found its data beside it", /level seven/.test(text), text);
    ok("with the arguments it was given", /args fast loud/.test(text), text);

    section("a zip bomb meets the box's limit before it writes");
    const g = await as("stranger", "guest");
    /* 80 MB of zeros squeezes to well under a megabyte; a guest's box
       has 64 MB. */
    const bomb = makeZip([{ name: "run.py", data: "print('never')" },
      { name: "fill.bin", deflate: true, data: Buffer.alloc(80 * 1048576) }]);
    const bu = await g.put("bomb.zip", bomb);
    ok("it uploads (it is small)", bu.t === "put-done", JSON.stringify(bu).slice(0, 200));
    const bl = await g.ask({ t: "zip-ls", file: bu.file.id });
    ok("the panel is told it will not fit", bl.total > bl.room, JSON.stringify(bl));
    const br = await g.run(bu.file.id, [], { entry: "run.py" });
    const bouts = [];
    const bex = await g.next((m) => {
      if (m.t === "out" && m.job === br.job.id) bouts.push(m.d);
      return m.t === "exit" && m.job === br.job.id;
    }, 15000);
    const btext = bouts.join("");
    ok("the box stops it with a sentence", bex.code === 97 && /more than the \d+ MB/.test(btext), JSON.stringify(bex) + " " + btext);
    ok("and the program never ran", !/never/.test(btext));
    await g.close();
  }

  await alice.close();
  await bob.close();
  await app.close();
  await wait(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }
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
