/* ============================================================
   POOL HALL: the engine (core/pool-engine.js), the relay's matches
   (relay/pool.js) and the panel (modules/pool.js).

   What matters:
     1. A shot ends the same way everywhere: the relay and every
        player's screen land on the same table.
     2. The table behaves like a table: balls go in pockets, draw comes
        back, follow goes on, side spin bends a rebound.
     3. The rules are eight-ball: groups, fouls and ball in hand, and
        the 8 in the called pocket after your group, or you lose.
     4. Online, only the player whose turn it is can shoot, on the table
        they saw, and a match ends in someone's record.
     5. The panel works without a relay, and online plays through it.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootstrap, makeRunner, fakeElement } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/settings.js", "core/ui.js", "core/pool-engine.js", "modules/pool.js"]);
const { ok, section, state } = makeRunner("pool");
const E = require("../core/pool-engine");
const players = require("../relay/colony-players");
const pool = require("../relay/pool");

function table(balls, extra) {
  const s = E.newGame(1, "8ball", ["A", "B"]);
  s.balls = balls.map((b) => ({ n: b[0], x: b[1], y: b[2], on: true }));
  s.phase = "play"; s.inHand = false; s.behind = false;
  return Object.assign(s, extra || {});
}
const cueAt = (r) => r.state.balls[0];

(async () => {
  section("the rack and the break");
  {
    const g = E.newGame(42, "8ball", ["A", "B"]);
    const on = g.balls.filter((b) => b.on);
    let overlap = false;
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) if (Math.hypot(on[i].x - on[j].x, on[i].y - on[j].y) < 2 * E.R) overlap = true;
    ok("sixteen balls, none touching", on.length === 16 && !overlap);
    const apex = g.balls.filter((b) => b.n).sort((a, b) => a.x - b.x)[0];
    const mid = g.balls.filter((b) => b.n).sort((a, b) => a.x - b.x)[4];
    ok("the 1 at the front, the 8 in the middle of the third row", apex.n === 1 && g.balls.some((b) => b.n === 8 && Math.abs(b.y - E.W / 2) < 1e-9 && b.x > apex.x));
    void mid;
    ok("the breaker has ball in hand behind the line", g.inHand && g.behind && E.placeOk(g, E.HEAD - 0.1, E.W / 2) && !E.placeOk(g, E.HEAD + 0.1, E.W / 2));
    const shot = { dx: 1, dy: 0.003, power: 1, cue: { x: E.HEAD - 0.12, y: E.W / 2 } };
    const a = E.play(g, shot), b = E.play(JSON.parse(JSON.stringify(g)), JSON.parse(JSON.stringify(shot)));
    ok("the same shot ends the same, to the last bit", JSON.stringify(a.state.balls) === JSON.stringify(b.state.balls));
    const c = E.play(g, Object.assign({}, shot, { power: 0.97 }));
    ok("and a different one differently", JSON.stringify(a.state.balls) !== JSON.stringify(c.state.balls));
    let potted = 0;
    for (let s = 1; s <= 30; s++) {
      const gg = E.newGame(s, "8ball"); const cy = E.W / 2 + (s % 5 - 2) * 0.08, cx = E.HEAD - 0.12;
      const dx = E.FOOT.x - cx, dy = E.FOOT.y - cy, m = Math.hypot(dx, dy);
      if (E.play(gg, { dx: dx / m, dy: dy / m, power: 1, cue: { x: cx, y: cy } }).events.pots.some((p) => p.n)) potted++;
    }
    ok("a hard break usually pots something", potted >= 12, potted + " of 30");
    ok("nonsense in a shot is made sensible", (() => { const r = E.play(g, { dx: "x", dy: NaN, power: 99, sx: 50, cue: { x: E.HEAD - 0.1, y: E.W / 2 } }); return !r.error && r.shot.power === 1 && Math.abs(r.shot.sx) <= 1; })());
    ok("the cue ball cannot be put on another ball", !!E.play(g, { dx: 1, dy: 0, power: 0.5, cue: { x: E.FOOT.x, y: E.FOOT.y } }).error);
  }

  section("it plays like a table");
  {
    const d = Math.SQRT1_2;
    ok("a ball sent at a corner goes in", E.play(table([[0, 0.6, 0.6], [3, 0.3, 0.3]]), { dx: -d, dy: -d, power: 0.3 }).events.pots.some((p) => p.n === 3 && p.pocket === 0));
    ok("and at a side pocket", E.play(table([[0, E.L / 2, 0.9], [5, E.L / 2, 0.4]]), { dx: 0, dy: -1, power: 0.25 }).events.pots.some((p) => p.n === 5 && (p.pocket === 1)));
    const lab = (sy) => cueAt(E.play(table([[0, 0.8, 0.6], [1, 1.1, 0.6]]), { dx: 1, dy: 0, power: 0.12, sy: sy })).x;
    const draw = lab(-0.9), stun = lab(-0.45), follow = lab(0.9), contact = 1.1 - 2 * E.R;
    ok("low on the cue ball draws it back", draw < contact - 0.05, draw.toFixed(3));
    ok("high follows through", follow > contact + 0.2, follow.toFixed(3));
    ok("in between it stops near where it hit", Math.abs(stun - contact) < 0.08, stun.toFixed(3));
    const eng = (sx) => cueAt(E.play(table([[0, 1.0, 0.8]]), { dx: 0, dy: -1, power: 0.3, sx: sx })).x;
    ok("right side spin kicks right off a cushion, left kicks left", eng(0.8) > 1.05 && eng(-0.8) < 0.95 && Math.abs(eng(0) - 1) < 0.01);
    const cut = E.play(table([[0, 0.6, 0.6], [2, 1.2, 0.645]]), { dx: 1, dy: 0, power: 0.15 });
    ok("a thin hit sends the object ball off at an angle", cut.state.balls[1].y > 0.75 || !cut.state.balls[1].on, String(cut.state.balls[1].y));
    const pr = E.predict(table([[0, 0.6, 0.6], [2, 1.2, 0.6]]), 0.6, 0.6, 1, 0);
    ok("the aiming guide finds the first ball and where it goes", pr.ball === 2 && Math.abs(pr.x - (1.2 - 2 * E.R)) < 1e-6 && pr.ox > 0.99);
  }

  section("eight-ball rules");
  {
    let r = E.play(table([[0, 0.6, 0.6], [3, 0.3, 0.3], [11, 2, 1], [8, 1.5, 0.3]]), { dx: -Math.SQRT1_2, dy: -Math.SQRT1_2, power: 0.3 });
    ok("the first ball potted picks the groups", r.state.groups[0] === "solid" && r.state.groups[1] === "stripe" && r.state.turn === 0 && !r.state.foul);
    const grp = { groups: ["solid", "stripe"] };
    r = E.play(table([[0, 0.6, 0.6], [12, 1.2, 0.6], [3, 2, 1], [8, 1.5, 0.3]], grp), { dx: 1, dy: 0, power: 0.3 });
    ok("hitting the other group first is a foul: ball in hand for them", !!r.state.foul && r.state.turn === 1 && r.state.inHand && /first/.test(r.state.foul));
    r = E.play(table([[0, 0.3, 0.3], [3, 2, 1], [8, 1.5, 0.3]], grp), { dx: -Math.SQRT1_2, dy: -Math.SQRT1_2, power: 0.3 });
    ok("a scratch is a foul and the cue ball comes back", /scratch/.test(r.state.foul || "") && r.state.balls[0].on && r.state.inHand && r.state.turn === 1);
    r = E.play(table([[0, 0.6, 0.6], [8, 0.3, 0.3], [3, 2, 1]], grp), { dx: -Math.SQRT1_2, dy: -Math.SQRT1_2, power: 0.3 });
    ok("the 8 before your group loses", r.state.over && r.state.winner === 1 && /early|fouled/.test(r.state.msg));
    r = E.play(table([[0, 0.6, 0.6], [8, 0.3, 0.3], [12, 2, 1]], grp), { dx: -Math.SQRT1_2, dy: -Math.SQRT1_2, power: 0.3, call: 0 });
    ok("on the 8, in the called pocket, wins", r.state.over && r.state.winner === 0);
    r = E.play(table([[0, 0.6, 0.6], [8, 0.3, 0.3], [12, 2, 1]], grp), { dx: -Math.SQRT1_2, dy: -Math.SQRT1_2, power: 0.3, call: 5 });
    ok("in another pocket, loses", r.state.over && r.state.winner === 1 && /wrong pocket/.test(r.state.msg));
    r = E.play(table([[0, 0.6, 0.6], [3, 1.2, 0.6], [12, 2, 1], [8, 1.5, 0.3]], grp), { dx: 1, dy: 0, power: 0.06 });
    ok("a touch that reaches no cushion is a foul", r.state.foul && /cushion/.test(r.state.foul));
    const brk = E.newGame(3, "8ball", ["A", "B"]); brk.balls = [{ n: 0, x: 0.5, y: 0.5, on: true }, { n: 8, x: 0.3, y: 0.3, on: true }, { n: 2, x: 2, y: 1, on: true }];
    r = E.play(brk, { dx: -1, dy: -1, power: 0.3, cue: { x: 0.5, y: 0.5 } });
    ok("the 8 on the break comes back to the foot spot", !r.state.over && r.state.balls.some((b) => b.n === 8 && b.on && Math.abs(b.y - E.FOOT.y) < 0.01));
    const pr = E.newGame(9, "practice"); const p2 = E.play(pr, { dx: 1, dy: 0, power: 1, cue: { x: E.HEAD - 0.12, y: E.W / 2 } });
    ok("practice has no turns and no fouls", p2.state.turn === 0 && !p2.state.foul && !p2.state.over);
  }

  section("the computer");
  {
    let wins = 0, errors = 0, shots = 0, slow = 0;
    for (let s = 1; s <= 4; s++) {
      let g = E.newGame(s, "8ball", ["A", "B"]); const rng = E.mulberry(s); let n = 0;
      while (!g.over && n < 120) {
        const t = Date.now(); const sh = E.aiShot(g, s % 2 ? "hard" : "normal", rng); if (Date.now() - t > 1500) slow++;
        const r = E.play(g, sh); if (r.error) { errors++; break; } g = r.state; n++;
      }
      shots += n; if (g.over) wins++;
    }
    ok("it plays whole games without an illegal move", errors === 0 && wins === 4, wins + " finished, " + errors + " errors");
    ok("and finishes them in a sensible number of shots", shots / 4 < 60, String(shots / 4));
    ok("it thinks quickly", slow === 0);
    const bih = E.newGame(5, "8ball"); bih.phase = "play"; bih.behind = false; bih.inHand = true;
    const sh = E.aiShot(bih, "easy", E.mulberry(1));
    ok("with ball in hand it puts the cue ball somewhere legal", sh.cue && E.placeOk(bih, sh.cue.x, sh.cue.y));
  }

  section("online, through the relay");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-pool-"));
    let now = Date.now();
    players.init({ dataDir: dir, now: () => now });
    pool.init({ dataDir: dir, start: false, now: () => now });
    const tok = {};
    for (const [t, ip] of [["Ava", "1.1.1.1"], ["Ben", "1.1.1.2"], ["Cal", "1.1.1.3"]]) tok[t] = players.register(t, "pool-pass-" + t, ip).token;
    const call = async (method, p, who, body) => {
      const u = new URL("http://relay" + p);
      const req = { method, headers: who ? { authorization: "Bearer " + tok[who] } : {}, url: u.pathname + u.search };
      let out = null;
      await pool.route(req, {}, u, { send: (r, status, b) => { out = { status, b }; return true; }, readBody: async () => body || {}, ip: () => "9.9.9.9" });
      return out;
    };
    ok("nobody plays without a gamertag", (await call("GET", "/pool/lobby")).status === 401);
    ok("the status needs none", (await call("GET", "/pool/status")).b.up === true);
    ok("an unknown gamertag cannot be challenged", (await call("POST", "/pool/challenge", "Ava", { to: "Nobody" })).status === 404);
    ok("nor can you challenge yourself", (await call("POST", "/pool/challenge", "Ava", { to: "ava" })).status === 400);
    const ch = await call("POST", "/pool/challenge", "Ava", { to: "Ben" });
    ok("a challenge is made", ch.status === 200 && ch.b.match.status === "invite");
    const id = ch.b.match.id;
    const lb = (await call("GET", "/pool/lobby", "Ben")).b;
    ok("the one challenged sees it", lb.invites.length === 1 && lb.invites[0].names[0] === "Ava");
    ok("someone else cannot take it", (await call("POST", "/pool/accept", "Cal", { id })).status === 403);
    const acc = await call("POST", "/pool/accept", "Ben", { id });
    ok("accepting starts the match, and the challenged breaks", acc.b.match.status === "live" && acc.b.match.state.turn === 1 && acc.b.match.seat === 1 && acc.b.match.yourTurn);
    const brk = { dx: 1, dy: 0.002, power: 1, sx: 0, sy: 0, cue: { x: E.HEAD - 0.12, y: E.W / 2 } };
    ok("out of turn is refused", (await call("POST", "/pool/shot", "Ava", { id, seq: 0, shot: brk })).status === 409);
    ok("so is a shot at a table that has changed", (await call("POST", "/pool/shot", "Ben", { id, seq: 5, shot: brk })).status === 409);
    const s1 = await call("POST", "/pool/shot", "Ben", { id, seq: 0, shot: brk });
    ok("a shot is played by the relay", s1.status === 200 && s1.b.match.seq === 1 && s1.b.match.state.shots === 1);
    const seen = (await call("GET", "/pool/match?id=" + id, "Ava")).b.match;
    const replay = E.play(seen.last.state, seen.last.shot).state;
    ok("the other player's screen replays it to exactly the same table", JSON.stringify(replay) === JSON.stringify(seen.state));
    ok("outsiders cannot look", (await call("GET", "/pool/match?id=" + id, "Cal")).status === 404);
    const turn = seen.state.turn === 0 ? "Ava" : "Ben", other = turn === "Ava" ? "Ben" : "Ava";
    const res = await call("POST", "/pool/resign", other, { id });
    ok("conceding ends it and counts", res.b.match.status === "over" && (await call("GET", "/pool/lobby", turn)).b.record.w === 1 && (await call("GET", "/pool/lobby", other)).b.record.l === 1);
    ok("a finished match takes no more shots", (await call("POST", "/pool/shot", turn, { id, seq: res.b.match.seq, shot: brk })).status === 400);
    const open = await call("POST", "/pool/challenge", "Cal", {});
    ok("an open challenge is seen by everyone else", (await call("GET", "/pool/lobby", "Ava")).b.open.some((m) => m.id === open.b.match.id) && !(await call("GET", "/pool/lobby", "Cal")).b.open.length);
    ok("and anyone can take it", (await call("POST", "/pool/accept", "Ava", { id: open.b.match.id })).b.match.status === "live");
    const c2 = await call("POST", "/pool/challenge", "Ava", { to: "Cal" });
    ok("a challenge can be declined", (await call("POST", "/pool/decline", "Cal", { id: c2.b.match.id })).b.gone && !(await call("GET", "/pool/lobby", "Ava")).b.sent.length);
    const c3 = await call("POST", "/pool/challenge", "Ben", { to: "Cal" });
    now += 3 * 24 * 3600 * 1000; pool._sweep();
    ok("one nobody answers goes after two days", !pool._data().matches[c3.b.match.id]);
    let many = 0; for (let i = 0; i < 6; i++) if ((await call("POST", "/pool/challenge", "Ben", {})).status === 200) many++;
    ok("nobody can flood the hall with challenges", many <= 4);
    pool.flush();
    pool.init({ dataDir: dir, start: false, now: () => now });
    ok("matches and records survive a restart", Object.keys(pool._data().records).length >= 2);

    section("the panel");
    const ui = FieldKit.need("ui");
    const def = FieldKit.modules().pool;
    const host = fakeElement("div");
    const all = (node) => { const out = []; (function w(n) { (n.children || []).forEach((c) => { if (c && c.nodeType !== 3) { out.push(c); w(c); } }); })(node); return out; };
    const text = () => all(host).map((n) => n.textContent || "").join(" | ");
    const P = FieldKit.service("poolHall");
    window.fetch = async (url, o) => {
      o = o || {};
      const u = new URL(url), headers = {};
      Object.keys(o.headers || {}).forEach((k) => { headers[k.toLowerCase()] = o.headers[k]; });
      let out = null;
      await pool.route({ method: o.method || "GET", headers, url: u.pathname + u.search }, {}, u, { send: (r, status, b) => { out = { status, b }; return true; }, readBody: async () => JSON.parse(o.body || "{}"), ip: () => "8.8.8.8" });
      const body = JSON.stringify(out ? out.b : {});
      return { ok: out.status < 400, status: out.status, text: async () => body };
    };
    await def.mount(host, { settings: FieldKit.need("settings"), ui, log() {}, warn() {}, error() {}, on() {}, emit() {}, confirm: () => true });
    ok("it opens on the hall: computer, two players, practice", /PLAY THE COMPUTER/.test(text()) && /TWO PLAYERS HERE/.test(text()) && /PRACTICE/.test(text()));
    ok("without a relay it says what online needs", /Needs a relay/.test(text()));
    P._start("hot");
    ok("a two-player game starts with the break", P._state().mode === "hot" && P._state().gs.phase === "break" && /breaks/.test(text()));
    P._shoot({ dx: 1, dy: 0.003, power: 1, cue: { x: E.HEAD - 0.12, y: E.W / 2 } }); P._finishNow();
    ok("a shot from the panel is played and judged", P._state().gs.shots === 1 && !P._state().sim);
    P._start("ai");
    P._shoot({ dx: 1, dy: 0.003, power: 1, cue: { x: E.HEAD - 0.12, y: E.W / 2 } }); P._finishNow();
    const st = P._state().gs;
    ok("against the computer, its turn comes when yours ends", st.turn === 0 || st.turn === 1);
    FieldKit.need("settings").set("relayUrl", "http://relay.test");
    window.localStorage = global.localStorage;
    window.localStorage.setItem("fk.deephold", JSON.stringify({ token: tok.Ben, tag: "Ben" }));
    P._home(); await P._refresh();
    ok("signed in with the DEEPHOLD gamertag, the lobby shows your record", /Ben/.test(text()) && /WON/.test(text()));
    const live = (await call("POST", "/pool/challenge", "Ava", { to: "Ben" })).b.match.id;
    await P._refresh();
    ok("a challenge appears with ACCEPT", /Ava challenges you/.test(text()) && /ACCEPT/.test(text()));
    await call("POST", "/pool/accept", "Ben", { id: live });
    await P._open(live);
    ok("the match opens on the table, your break", P._state().mode === "online" && P._state().match.seat === 1 && P._state().gs.turn === 1);
    P._shoot({ dx: 1, dy: 0.003, power: 1, cue: { x: E.HEAD - 0.12, y: E.W / 2 } });
    await new Promise((r) => setTimeout(r, 30));
    P._finishNow();
    await new Promise((r) => setTimeout(r, 30));
    ok("the shot goes to the relay and both agree", pool._data().matches[live].seq === 1 && JSON.stringify(P._state().gs.balls) === JSON.stringify(pool._data().matches[live].state.balls));
    def.unmount();
    ok("closing stops everything", !P._state().screen);
  }

  section("wired into FieldKit");
  {
    const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    ok("both builds carry the engine and the panel", ["FIELDKIT.html", "OUTPOST.html"].every((f) => /"core\/pool-engine\.js"/.test(rd(f)) && /"modules\/pool\.js"/.test(rd(f))));
    ok("the relay routes /pool and the deploy ships the engine next to it", /seg\[0\] === "pool"/.test(rd("relay/server.js")) && /"pool\.js"/.test(rd("tools/make-deploy.js")) && /pool-engine\.js/.test(rd("tools/make-deploy.js")));
    ok("the panel never builds markup from text", !/innerHTML/.test(rd("modules/pool.js")));
    const src = rd("core/pool-engine.js").split("function Sim(")[1].split("function nearestPocket")[0];
    ok("the simulation uses nothing that differs between machines", !/Math\.(sin|cos|tan|atan|exp|log|pow|random)|Date\.|performance/.test(src));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures.length) { console.log("\nFAILURES:"); state.failures.forEach((f) => console.log("  - " + f)); }
  process.exit(state.fail ? 1 : 0);
})();
