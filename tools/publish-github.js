/* ============================================================
   FieldKit :: publish-github — the public copy on GitHub

     node tools/publish-github.js <path to a clone of the GitHub repo>

   Copies every file git tracks here into that clone, except the
   internal design logs, and removes from it anything no longer
   tracked here. Then it searches the result for anything that looks
   like a secret or a private detail and refuses if it finds one.
   Committing and pushing are left to you, so you can read the diff
   first.

   This repository's own history is never pushed: the GitHub repo has
   its own, made of these snapshots.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

/* The design logs: full of the specifics of one person's machines and
   network. Source comments cite their sections; the README says so. */
const EXCLUDE = new Set(["FIELDKIT_PROJECT.md", "RUNNER_PLAN.md"]);

/* Personal words (a user name, an email) are kept in
   tools/publish-private.json, which is gitignored, so that this file
   does not publish them itself:
     { "scrub": [["word", "replacement"]], "never": ["word"] }
   "scrub" changes a word on the way out; "never" stops the publish. */
const PRIVATE_FILE = path.join(__dirname, "publish-private.json");
const esc = (w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function privateRules() {
  let p = {};
  try { p = JSON.parse(fs.readFileSync(PRIVATE_FILE, "utf8")); } catch (e) {}
  return {
    scrub: (p.scrub || []).map((x) => [new RegExp(esc(x[0]), "g"), String(x[1])]),
    never: (p.never || []).map((w) => [new RegExp(esc(w), "i"), "a private word from publish-private.json"])
  };
}

/* Anything matching these stops the publish. A third item, when
   there is one, says whether a match is real. */
const LEAKS = [
  [/gh[opsu]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/AKIA[0-9A-Z]{16}/, "an AWS key"],
  [/tskey-[A-Za-z0-9-]{10,}/, "a Tailscale key"],
  [/eyJhIjoi[A-Za-z0-9+/=_-]{20,}/, "a Cloudflare tunnel token"],
  /* Tailnet addresses; x.x.0.x and the range's own edge are test data. */
  [/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?!0\.)\d{1,3}\.\d{1,3}\b/, "a tailnet address", (m) => m !== "100.127.255.255"],
  /* A network card's address; 02:00:5e:... are the stand-ins the tests use. */
  [/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i, "a network card address", (m) => !/^02:00:5e/i.test(m) && !/^(00:){5}00$/.test(m)],
  [/[A-Za-z0-9._%+-]+@gmail\.com/i, "an email address"]
];
/* Binary and vendored files are copied as they are. */
const SKIP_SCAN = /\.(png|jpg|ico|woff2?|wasm)$|^vendor\//;

function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
}

function walk(dir, base, out) {
  for (const n of fs.readdirSync(dir)) {
    if (base === "" && n === ".git") continue;
    const p = path.join(dir, n), rel = base ? base + "/" + n : n;
    if (fs.statSync(p).isDirectory()) walk(p, rel, out); else out.push(rel);
  }
  return out;
}

function publish(dest) {
  if (!fs.existsSync(path.join(dest, ".git"))) throw new Error(dest + " is not a git clone");
  const mine = privateRules();
  const leaks = LEAKS.concat(mine.never);
  const files = tracked().filter((f) => !EXCLUDE.has(f));
  const keep = new Set(files);
  let removed = 0;
  for (const f of walk(dest, "", [])) {
    if (!keep.has(f)) { fs.unlinkSync(path.join(dest, f)); removed++; }
  }
  const found = [];
  for (const f of files) {
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let buf = fs.readFileSync(path.join(ROOT, f));
    if (!SKIP_SCAN.test(f) && !buf.includes(0)) {
      let text = buf.toString("utf8");
      for (const [re, by] of mine.scrub) text = text.replace(re, by);
      for (const [re, what, real] of leaks) {
        const all = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || [];
        const hit = all.find((m) => !real || real(m));
        if (hit) found.push(f + ": " + what);
      }
      buf = Buffer.from(text, "utf8");
    }
    fs.writeFileSync(to, buf);
  }
  return { copied: files.length, removed, found, privateRules: mine.scrub.length + mine.never.length };
}

if (require.main === module) {
  const dest = process.argv[2];
  if (!dest) { console.error("usage: node tools/publish-github.js <path to the GitHub clone>"); process.exit(2); }
  const r = publish(path.resolve(dest));
  console.log("copied " + r.copied + " file(s), removed " + r.removed + " no longer here" +
    (r.privateRules ? "" : "\n(no tools/publish-private.json: personal words were not checked)"));
  if (r.found.length) {
    console.error("\nREFUSED: these look like secrets or private details:\n  " + r.found.join("\n  "));
    process.exit(1);
  }
  console.log("nothing that looks like a secret. Read `git diff` there, then commit and push.");
}

module.exports = { publish, EXCLUDE, LEAKS };
