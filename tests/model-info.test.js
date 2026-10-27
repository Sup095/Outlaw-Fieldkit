/* ============================================================
   tools/model-info.js — the model download helper

   The point of this tool is that it does not repeat anything. Every
   URL it prints is scraped out of vendor/web-llm.js, so the answer
   cannot drift from the engine that will load the model. That
   property is worth exactly as much as the regex holding, and a
   minified bundle's shape changes whenever it is rebuilt — so this
   suite is really one assertion in several forms: the scrape still
   works, and the pairings it produces are the ones the engine uses.

   The pairing is the part that matters. Qwen2.5-Coder-1.5B runs on
   a library named Qwen2-1.5B, and a scrape that drifted by one
   record would hand out a plausible wrong filename — a 404 after
   the multi-gigabyte download has already finished.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { makeRunner } = require("./harness");
const { ok, section, state } = makeRunner("model-info");

const ENGINE = path.join(__dirname, "..", "vendor", "web-llm.js");

if (!fs.existsSync(ENGINE)) {
  console.log("  SKIP  vendor/web-llm.js is not present — build it with tools/build-webllm.js");
  console.log("\nRESULT  pass 0  fail 0");
  process.exit(0);
}

const { readCatalogue } = require("../tools/model-info.js");

(function () {
  const rows = readCatalogue();

  section("the catalogue comes out of the bundle");
  {
    ok("something was found", rows.length > 50, String(rows.length));
    ok("every row has an id", rows.every((r) => r.id && r.id.length > 3));
    ok("every row has a weights repo on hugging face",
      rows.every((r) => /^https:\/\/huggingface\.co\/[^ ]+$/.test(r.repo)),
      (rows.find((r) => !/^https:\/\/huggingface\.co\//.test(r.repo)) || {}).repo);
    ok("every row has a compiled library url",
      rows.every((r) => r.libUrl && /\.wasm$/.test(r.libUrl)),
      (rows.find((r) => !r.libUrl) || {}).id);
    ok("the library url carries a version segment, not just the repo root",
      rows.every((r) => /\/v\d+_\d+_\d+\//.test(r.libUrl)),
      (rows.find((r) => !/\/v\d+_\d+_\d+\//.test(r.libUrl)) || {}).libUrl);
    ok("every row has a memory figure that is not zero",
      rows.every((r) => r.vram > 100), String((rows.find((r) => r.vram <= 100) || {}).vram));
    ok("ids are unique", new Set(rows.map((r) => r.id)).size === rows.length);
  }

  section("the pairings match the bundle, not a guess");
  {
    const src = fs.readFileSync(ENGINE, "utf8");

    /* Read straight back out of the raw text for a handful of
       models, independently of the tool's own regex. If the scrape
       has slipped by a record these disagree. */
    function libFromSource(id) {
      const at = src.indexOf('model_id:"' + id + '"');
      if (at < 0) return null;
      const m = /model_lib:[A-Za-z$_+]*"\/([^"]+)"/.exec(src.slice(at, at + 400));
      return m ? m[1] : null;
    }

    const sample = ["Llama-3.2-1B-Instruct-q4f16_1-MLC",
      "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
      "Qwen2.5-3B-Instruct-q4f16_1-MLC"];
    sample.forEach((id) => {
      const row = rows.find((r) => r.id === id);
      ok(id + " is in the catalogue", !!row);
      if (!row) return;
      const direct = libFromSource(id);
      ok("its library matches what the bundle says",
        !!direct && row.libUrl.slice(-direct.length) === direct,
        row.libUrl + " vs " + direct);
    });

    /* The named example in MODELS.md, because a document that tells
       you the filename differs from the model name is worth nothing
       if the example it uses has stopped being true. */
    const coder = rows.find((r) => r.id === "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC");
    ok("the documented trap is still real: Coder-1.5B runs on a Qwen2-1.5B library",
      coder && /Qwen2-1\.5B-Instruct/.test(coder.libUrl), coder && coder.libUrl);
    ok("and its weights repo is the one MODELS.md links to",
      coder && coder.repo === "https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
      coder && coder.repo);
  }

  section("the sizes the guide quotes");
  {
    /* MODELS.md names three models and three numbers. A guide that
       recommends a model by how much memory it needs is wrong the
       moment the engine is rebuilt with different figures, and
       nobody re-reads a markdown file to check. */
    const guide = fs.readFileSync(path.join(__dirname, "..", "MODELS.md"), "utf8");
    [["Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC", 1630],
     ["Llama-3.2-1B-Instruct-q4f16_1-MLC", 879],
     ["Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC", 5107]].forEach(([id, mb]) => {
      const row = rows.find((r) => r.id === id);
      ok(id + " still needs " + mb + " MB", row && row.vram === mb,
        row ? String(row.vram) : "not in the catalogue");
      ok("and MODELS.md quotes that number", guide.indexOf(String(mb)) >= 0);
    });
    ok("MODELS.md names the model it recommends",
      guide.indexOf("Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC") >= 0);
    ok("and links the repo rather than describing where to search",
      /https:\/\/huggingface\.co\/mlc-ai\/Qwen2\.5-Coder-1\.5B/.test(guide));
  }

  section("the small end is genuinely small");
  {
    /* The default listing exists so that someone on a Chromebook is
       not handed a 70B model as the first thing they read. */
    const small = rows.filter((r) => r.vram <= 2000);
    ok("there is a usable set under 2 GB", small.length >= 10, String(small.length));
    ok("and it is not the whole catalogue", small.length < rows.length);
    ok("the biggest model is well past what a chromebook has",
      Math.max(...rows.map((r) => r.vram)) > 20000,
      String(Math.max(...rows.map((r) => r.vram))));
  }

  console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
  if (state.failures && state.failures.length) {
    console.log("\nFAILURES:");
    state.failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(state.fail ? 1 : 0);
})();
