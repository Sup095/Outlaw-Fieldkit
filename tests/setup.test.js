/* ============================================================
   tools/setup.js: a relay of your own from a handful of answers.

   What matters:
     1. It writes only what is yours, keeps what was already there, and
        never loses or weakens a secret.
     2. The two safe pairs, and only those: a tunnel means host 127.0.0.1
        with trustProxy "loopback"; no tunnel means 0.0.0.0 with false.
        The relay must never believe the forwarded header while anything
        but its own tunnel can reach it.
     3. --check says in plain words what is wrong, and calls the
        dangerous combination dangerous.
     4. Nothing it prints for a bug report shows a secret.
     5. The example config a newcomer starts from has no pretend servers
        or commands in it.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { makeRunner, ROOT } = require("./harness");
const setup = require("../tools/setup.js");
const build = require("../build.js");
const { ok, section, state } = makeRunner("setup");

(async function () {
  section("answers become settings");
  {
    const p = setup.plan({ admin: "Kay", port: 8080 }, null, {});
    ok("the admin is named, in small letters, and accounts are on", p.local.messaging.enabled === true && p.local.messaging.moderators.join() === "kay" && p.local.messaging.requireApproval === true);
    ok("a provision token is made, long and random", typeof p.local.provisionToken === "string" && p.local.provisionToken.length >= 30 && p.local.provisionToken !== setup.plan({ admin: "kay" }, null, {}).local.provisionToken);
    ok("no tunnel: every address, and the forwarded header is not believed", p.local.host === "0.0.0.0" && p.local.trustProxy === false);
    ok("the example's pretend lists are not inherited", Array.isArray(p.local.aiTargets) && !p.local.aiTargets.length && !p.local.statusServices.length && !p.local.actions.length);
    ok("GAME MODE is on unless left out", p.gamesLocal.gameMode === "on" && setup.plan({ admin: "kay", gameMode: "off" }, null, {}).gamesLocal.gameMode === "off");

    const t = setup.plan({ admin: "kay", tunnelToken: "eyTESTTOKENxxxxxxxxxxxxxxxxxxxxxxxx" }, null, {});
    ok("a tunnel: this computer only, and its header is believed, together", t.local.host === "127.0.0.1" && t.local.trustProxy === "loopback" && t.local.cloudflared.token === "eyTESTTOKENxxxxxxxxxxxxxxxxxxxxxxxx");
    const back = setup.plan({ tunnelToken: "" }, t.local, {});
    ok("taking the tunnel away puts both back, together", back.local.host === "0.0.0.0" && back.local.trustProxy === false);

    const old = { provisionToken: "a-real-token-that-was-set-before-1234", port: 9000, runner: { enabled: true, innerUrl: "http://10.0.0.9:25580" },
      aiTargets: [{ name: "pc", url: "http://10.0.0.5:1234", priority: 1 }], messaging: { enabled: true, moderators: ["first", "second"], openRegistration: false }, _how: "old note" };
    const again = setup.plan({ admin: "second" }, old, { source: "somewhere", gameMode: "off" });
    ok("running it again keeps the token, the port and everything it does not ask about", again.local.provisionToken === old.provisionToken && again.local.port === 9000 && again.local.runner.innerUrl === old.runner.innerUrl && again.local.aiTargets.length === 1 && again.local.messaging.openRegistration === false);
    ok("the other admins stay, the named one first", again.local.messaging.moderators.join() === "second,first");
    ok("and so does what games.local.json already remembered", again.gamesLocal.source === "somewhere" && again.gamesLocal.gameMode === "off");
    ok("the answers shown next time are the ones given", setup.current(again.local, again.gamesLocal).admin === "second" && setup.current(again.local, again.gamesLocal).port === 9000 && setup.current(again.local, again.gamesLocal).gameMode === "off");
    ok("a placeholder token is replaced", setup.plan({ admin: "kay" }, { provisionToken: "CHANGE-ME-generate-a-long-random-string" }, {}).local.provisionToken.indexOf("CHANGE-ME") < 0);
    for (const bad of ["", "ab", "has space", "UPPER!", "x".repeat(30)]) {
      let e = null; try { setup.plan({ admin: bad }, null, {}); } catch (err) { e = err; }
      ok("an admin name that could not be an account is refused: " + JSON.stringify(bad.slice(0, 12)), !!e);
    }
    let pe = null; try { setup.plan({ admin: "kay", port: 99999 }, null, {}); } catch (err) { pe = err; }
    ok("and so is a port that is not one", !!pe);
    ok("the account-name rule is the relay's own", fs.readFileSync(path.join(ROOT, "relay", "messaging.js"), "utf8").indexOf(String(setup.HANDLE).slice(1, -1)) >= 0);
  }

  section("what it writes makes a config the relay accepts");
  {
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, "relay", "config.example.json"), "utf8"));
    const p = setup.plan({ admin: "kay", port: 8123 }, null, {});
    const merged = build.mergeConfig(example, p.local);
    ok("merged over the example, the answers win", merged.port === 8123 && merged.messaging.enabled === true && merged.messaging.moderators.join() === "kay" && merged.trustProxy === false);
    ok("and every other setting comes from the example", merged.rateLimit && merged.rateLimit.max === example.rateLimit.max && merged.updates.enabled === true);
    ok("the example a newcomer starts from has no pretend servers or commands", example.aiTargets.length === 0 && example.statusServices.length === 0 && example.actions.length === 0);
    ok("but still shows the shape of each", Array.isArray(example._aiTargets_example) && Array.isArray(example._statusServices_example) && Array.isArray(example._actions_example));
    ok("its note says so", /config\.example\.json explains every one/.test(p.local._) && /Never upload or publish/.test(p.local._));
  }

  section("--check, in plain words");
  {
    const env = (over) => Object.assign({ exists: () => true, nodeMajor: 22, platform: "linux", gamesLocal: {}, mtime: (p) => (p === "relay/config.json" ? 2 : 1) }, over);
    const levels = (found, lvl) => found.filter((f) => f.level === lvl).map((f) => f.text).join(" || ");
    const good = setup.plan({ admin: "kay" }, null, {}).local;
    ok("a fresh setup has nothing to fix", !levels(setup.check(good, env()), "bad"));
    ok("no settings yet: it says which command", /node tools\/setup\.js/.test(levels(setup.check(null, env()), "bad")));
    ok("broken JSON is named as that", /not valid JSON/.test(levels(setup.check({ __broken: "Unexpected token" }, env()), "bad")));
    const danger = Object.assign({}, good, { host: "0.0.0.0", trustProxy: "loopback" });
    ok("believing the forwarded header on an open port is called dangerous", /DANGEROUS/.test(levels(setup.check(danger, env()), "bad")));
    ok("the same header behind the tunnel only is fine", !levels(setup.check(setup.plan({ admin: "kay", tunnelToken: "eyTESTTOKENxxxxxxxxxxxxxxxxxxxxxxxx" }, null, {}).local, env()), "bad"));
    ok("a tunnel token with no tunnel program says how to get it", /fetch-cloudflared/.test(levels(setup.check(setup.plan({ admin: "kay", tunnelToken: "eyTESTTOKENxxxxxxxxxxxxxxxxxxxxxxxx" }, null, {}).local, env({ exists: () => false })), "bad")));
    const noAdmin = JSON.parse(JSON.stringify(good)); noAdmin.messaging.moderators = [];
    ok("accounts with no admin is a thing to fix", /nobody is the admin/.test(levels(setup.check(noAdmin, env()), "bad")));
    const badName = JSON.parse(JSON.stringify(good)); badName.messaging.moderators = ["Kay Smith"];
    ok("an admin name that cannot be an account is caught", /cannot be account names/.test(levels(setup.check(badName, env()), "bad")));
    ok("a placeholder token is caught", /provisionToken/.test(levels(setup.check(Object.assign({}, good, { provisionToken: "CHANGE-ME-x" }), env()), "bad")));
    ok("settings newer than the built config: run the build", /node build\.js/.test(levels(setup.check(good, env({ mtime: (p) => (p === "relay/config.json" ? 1 : 2) })), "bad")));
    ok("an old Node is caught", /Node\.js 22/.test(levels(setup.check(good, env({ nodeMajor: 18 })), "bad")));
    ok("RUNNER on with nowhere to run is caught", /RUNNER is on/.test(levels(setup.check(Object.assign({}, good, { runner: { enabled: true } }), env()), "bad")));
    ok("GAME MODE with no games is a note, not a fault", /no games yet/.test(levels(setup.check(good, env({ exists: () => false })), "note")) && !/games/.test(levels(setup.check(good, env({ exists: () => false })), "bad")));
    ok("GAME MODE left out is fine", /left out/.test(levels(setup.check(good, env({ gamesLocal: { gameMode: "off" } })), "ok")));
  }

  section("nothing it shows is a secret");
  {
    const secret = { provisionToken: "PROVISION-SECRET-VALUE-123456", cloudflared: { token: "eyTUNNEL-SECRET-VALUE-abcdefgh" }, lens: { passKey: "LENS-KEY-SECRET-1" }, messaging: { moderators: ["kay"] }, nested: { apiToken: "DEEP-SECRET-2" } };
    const shown = JSON.stringify(setup.redact(secret));
    ok("--show hides every token, key and password", !/SECRET/.test(shown) && /\(set, \d+ characters\)/.test(shown) && /"kay"/.test(shown));
    ok("and leaves the real settings alone", secret.provisionToken === "PROVISION-SECRET-VALUE-123456");
    const steps = setup.nextSteps({ admin: "kay", port: 8080, tunnelToken: "eyTUNNEL-SECRET-VALUE-abcdefgh", gameMode: "on" }, "https://relay.example.com").join("\n");
    ok("the next steps never print the tunnel token", !/SECRET/.test(steps) && /relay\.example\.com\/health/.test(steps) && /kay/.test(steps));
    ok("an address is tidied, and nonsense is no address", setup.cleanAddress("relay.example.com/") === "https://relay.example.com" && setup.cleanAddress("none") === "" && setup.cleanAddress("ftp://x") === "");
    const f = setup.flags(["--admin", "kay", "--port", "81", "--game-mode", "off", "--browser", "on", "--approve", "no", "--tunnel-token", "none", "--address", "r.example.com"]);
    ok("the no-questions flags are read", f.answers.admin === "kay" && f.answers.port === 81 && f.answers.gameMode === "off" && f.answers.browser === true && f.answers.approve === false && f.answers.tunnelToken === "" && f.address === "r.example.com");
    const src = fs.readFileSync(path.join(ROOT, "tools", "setup.js"), "utf8");
    ok("setup talks to nothing but this computer", !/https?\.request|fetch\(|net\.connect/.test(src));
    ok("your settings and the GAME MODE choice are never committed", /^relay\/config\.local\.json$/m.test(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")) && /^games\.local\.json$/m.test(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")));
  }

  section("the questions, answered at a keyboard or piped in");
  {
    const os = require("os");
    const { spawnSync } = require("child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fk-setup-"));
    fs.mkdirSync(path.join(tmp, "relay"), { recursive: true });
    const run = (input, args) => spawnSync(process.execPath, [path.join(ROOT, "tools", "setup.js"), "--no-build"].concat(args || []),
      { input: input, encoding: "utf8", env: Object.assign({}, process.env, { FK_SETUP_ROOT: tmp }) });
    const local = () => JSON.parse(fs.readFileSync(path.join(tmp, "relay", "config.local.json"), "utf8"));
    const gl = () => JSON.parse(fs.readFileSync(path.join(tmp, "games.local.json"), "utf8"));
    const before = fs.existsSync(path.join(ROOT, "relay", "config.local.json")) ? fs.readFileSync(path.join(ROOT, "relay", "config.local.json"), "utf8") : null;

    let r = run("Kay\n8111\n\nn\nn\nn\n");
    ok("six answers, all at once, are each read", r.status === 0 && local().port === 8111 && local().messaging.moderators.join() === "kay" &&
      local().messaging.requireApproval === false && local().browser.enabled === false && gl().gameMode === "off", (r.stderr || "").slice(0, 200));
    ok("it prints the next steps with the answers in them", /DONE/.test(r.stdout) && /localhost:8111\/health/.test(r.stdout) && /name:\s+kay/.test(r.stdout));
    const token = local().provisionToken;
    r = run("");
    ok("run again with nothing typed: every answer is kept, and so is the token", r.status === 0 && local().port === 8111 && local().messaging.requireApproval === false && gl().gameMode === "off" && local().provisionToken === token);
    r = run("\n\neyTESTTOKEN0000000000000000000000\nrelay.example.com\n");
    ok("a tunnel token typed at question 3 closes the relay to all but the tunnel", local().host === "127.0.0.1" && local().trustProxy === "loopback" && /relay\.example\.com\/health/.test(r.stdout) && r.stdout.indexOf("eyTESTTOKEN") < 0);
    r = run("", ["--game-mode", "on", "--tunnel-token", "none"]);
    ok("flags change one thing and leave the rest", gl().gameMode === "on" && local().host === "0.0.0.0" && local().trustProxy === false && local().port === 8111 && local().messaging.moderators[0] === "kay");
    r = run("bad name!\n\n");
    ok("a name that cannot be an account is asked for again, and nothing is written when it never comes", r.status !== 0 || local().messaging.moderators[0] === "kay");
    r = spawnSync(process.execPath, [path.join(ROOT, "tools", "setup.js"), "--check"], { encoding: "utf8", env: Object.assign({}, process.env, { FK_SETUP_ROOT: tmp }) });
    ok("--check on it names the build as the next thing", r.status === 1 && /node build\.js/.test(r.stdout));
    r = spawnSync(process.execPath, [path.join(ROOT, "tools", "setup.js"), "--show"], { encoding: "utf8", env: Object.assign({}, process.env, { FK_SETUP_ROOT: tmp }) });
    ok("--show prints the settings without the token", r.status === 0 && r.stdout.indexOf(token) < 0 && /"kay"/.test(r.stdout));
    const after = fs.existsSync(path.join(ROOT, "relay", "config.local.json")) ? fs.readFileSync(path.join(ROOT, "relay", "config.local.json"), "utf8") : null;
    ok("none of this touched the real settings", before === after);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
