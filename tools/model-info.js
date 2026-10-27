/* ============================================================
   tools/model-info.js — what to download for AI LOCAL

   The `.wasm` trap is the reason this exists. A WebLLM model needs
   two downloads from two different places, and the compiled library
   is NOT always named after the model that uses it —
   Qwen2.5-Coder-1.5B runs on `Qwen2-1.5B-Instruct-...wasm`, and
   Llama-3.1-8B's file spells the version `3_1` rather than `3.1`.
   Guessing the filename gets you a 404 after a multi-gigabyte
   download, or worse, a model that silently reaches for the
   internet at load time.

   So nothing here is typed from memory. Every URL is read out of
   `vendor/web-llm.js` — the exact engine that will load the model —
   which means the answer cannot drift from the code. If the vendored
   engine is rebuilt against a newer WebLLM, this prints the newer
   answers with no edit.

     node tools/model-info.js                 list what runs on a small machine
     node tools/model-info.js --all           the whole catalogue
     node tools/model-info.js <search>        anything matching
     node tools/model-info.js <exact-id>      the download instructions

   No network. No npm. Reads one file.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "vendor", "web-llm.js");

/* The minified bundle stores the prebuilt list as object literals.
   Matching the whole record in one pass rather than scraping fields
   separately keeps a model's URL, library and size together — a
   mismatched pairing is exactly the bug this tool exists to stop. */
const RECORD = new RegExp(
  'model:[A-Za-z$_]*\\+?"?(https://huggingface\\.co/[^"]+)"' +
  ',model_id:"([^"]+)"' +
  ',model_lib:([A-Za-z$_+]*)"/([^"]+)"' +
  '[^}]*?vram_required_MB:([0-9.]+)',
  "g");

function readCatalogue() {
  if (!fs.existsSync(ENGINE)) {
    console.error("vendor/web-llm.js is not here.");
    console.error("Build it first:  node tools/build-webllm.js");
    process.exit(1);
  }
  const src = fs.readFileSync(ENGINE, "utf8");

  /* The library base and the version segment are separate variables
     in the bundle, so they are read separately and joined the same
     way the engine joins them. */
  const base = (src.match(/"(https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/[^"]*)"/) || [])[1];
  const ver = (src.match(/=("v\d+_\d+_\d+")[,;]/) || [])[1];
  const libBase = base ? base + (ver ? JSON.parse(ver) : "") : null;

  const rows = [];
  let m;
  while ((m = RECORD.exec(src))) {
    rows.push({
      id: m[2],
      repo: m[1],
      wasm: m[4],
      libUrl: libBase ? libBase + "/" + m[4] : null,
      vram: Math.round(Number(m[5]))
    });
  }
  if (!rows.length) {
    console.error("Could not read the model list out of vendor/web-llm.js.");
    console.error("The bundle's shape changed. Fix the RECORD regex in this file.");
    process.exit(1);
  }
  return rows;
}

/* Roughly what the machine has to spare, not what it has. A
   Chromebook reporting 4 GB is not offering 4 GB to one tab. */
function fits(row) { return row.vram <= 2000; }

function line(r) {
  return String(r.vram).padStart(6) + " MB   " + r.id;
}

function show(r) {
  const short = r.id.replace(/-MLC$/, "");
  console.log("\n" + r.id);
  console.log("  needs about " + r.vram + " MB of GPU memory while running\n");

  console.log("  1. THE WEIGHTS — the whole repo, not a few files:\n");
  console.log("     git lfs install");
  console.log("     git clone " + r.repo + "\n");

  console.log("  2. THE COMPILED LIBRARY — a separate download, and note");
  console.log("     the filename is not always the model's name:\n");
  console.log("     " + (r.libUrl || ("(base url not found in the bundle) " + r.wasm)) + "\n");
  console.log("     Save it INTO the folder from step 1, beside");
  console.log("     mlc-chat-config.json. AI LOCAL will not load a folder");
  console.log("     without it — without one, WebLLM's default is to fetch");
  console.log("     it from the internet, which is the opposite of what an");
  console.log("     offline tier is for.\n");

  console.log("  3. ON THE DRIVE — move the folder to:\n");
  console.log("     F:\\FieldKit\\models\\" + short.toLowerCase() + "\\\n");
  console.log("     then  node build.js --deploy <drive>");
  console.log("     and in FieldKit: AI LOCAL -> pick a model folder.\n");
}

function main() {
  const rows = readCatalogue();
  const arg = process.argv.slice(2).filter((a) => a !== "--all").join(" ").trim();
  const all = process.argv.indexOf("--all") >= 0;

  const exact = rows.find((r) => r.id.toLowerCase() === arg.toLowerCase());
  if (exact) return show(exact);

  let list = rows;
  if (arg) {
    list = rows.filter((r) => r.id.toLowerCase().indexOf(arg.toLowerCase()) >= 0);
    if (!list.length) {
      console.log('Nothing in the catalogue matches "' + arg + '".');
      console.log("Try:  node tools/model-info.js --all");
      return;
    }
  } else if (!all) {
    list = rows.filter(fits);
  }

  list.sort((a, b) => a.vram - b.vram || a.id.localeCompare(b.id));
  console.log(
    arg ? 'MATCHING "' + arg + '"'
        : all ? "EVERY MODEL THIS ENGINE KNOWS"
              : "MODELS THAT FIT IN ABOUT 2 GB (the school-Chromebook end)");
  console.log("");
  list.forEach((r) => console.log(line(r)));
  console.log("\n" + list.length + " of " + rows.length + " model(s).");
  console.log("Run it again with an exact id for the download instructions.");
  if (!arg && !all) console.log("--all for the rest, including ones that need a desktop GPU.");
}

if (require.main === module) main();
module.exports = { readCatalogue };
