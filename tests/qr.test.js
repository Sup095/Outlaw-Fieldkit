/* ============================================================
   core/qr.js — Reed-Solomon math, format information, and the
   module matrix.

   The strongest checks here are the ones that cannot pass by
   accident: RS syndromes over the real generator, the published
   format-string table, and the exact free-module count per version.
   A cross-check against an independent encoder lives outside the
   drive (it needs an npm package); see FIELDKIT_PROJECT.md §10F.
   ============================================================ */
"use strict";

const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/qr.js"]);
const QR = FieldKit.need("qr");
const { ok, section, state } = makeRunner("qr");

/* Independent GF(256) exponent table, built here rather than
   imported, so the tests are not checking qr.js against itself. */
const EXP = [];
{ let x = 1; for (let i = 0; i < 255; i++) { EXP.push(x); x <<= 1; if (x & 0x100) x ^= 0x11d; } }
function evalPoly(g, x) { let y = 0; for (const c of g) y = QR._gmul(y, x) ^ c; return y; }

/* ---------- GF(256) ---------- */
section("GF(256) arithmetic");
{
  let allInv = true;
  for (let a = 1; a < 256 && allInv; a++) {
    let found = false;
    for (let b = 1; b < 256; b++) if (QR._gmul(a, b) === 1) { found = true; break; }
    if (!found) allInv = false;
  }
  ok("every nonzero element has a multiplicative inverse", allInv);

  let comm = true, dist = true;
  for (let a = 0; a < 256; a += 7) for (let b = 0; b < 256; b += 11) {
    if (QR._gmul(a, b) !== QR._gmul(b, a)) comm = false;
    for (let c = 1; c < 256; c += 29) {
      if (QR._gmul(a, b ^ c) !== (QR._gmul(a, b) ^ QR._gmul(a, c))) dist = false;
    }
  }
  ok("multiplication is commutative", comm);
  ok("multiplication distributes over XOR", dist);
  ok("zero annihilates", QR._gmul(0, 137) === 0 && QR._gmul(137, 0) === 0);
}

/* ---------- generator polynomials ---------- */
section("Reed-Solomon generator polynomials");
{
  let allRoots = true, allMonic = true, allDeg = true;
  for (const n of [10, 16, 18, 22, 24, 26]) {
    const g = QR._genPoly(n);
    if (g.length !== n + 1) allDeg = false;
    if (g[0] !== 1) allMonic = false;
    for (let i = 0; i < n; i++) if (evalPoly(g, EXP[i]) !== 0) allRoots = false;
  }
  ok("generator has degree n", allDeg);
  ok("generator is monic", allMonic);
  ok("a^0 .. a^(n-1) are all roots of the generator", allRoots);
  ok("g(2) == [1,3,2]", JSON.stringify(QR._genPoly(2)) === "[1,3,2]", JSON.stringify(QR._genPoly(2)));
}

/* ---------- RS remainder ---------- */
section("Reed-Solomon codeword generation");
{
  let allDivisible = true, allLen = true;
  for (const [dataLen, ecLen] of [[16, 10], [28, 16], [44, 26], [32, 18], [43, 24], [27, 16]]) {
    const data = [];
    for (let i = 0; i < dataLen; i++) data.push((i * 37 + 11) & 0xff);
    const ec = QR._ecCodewords(data, ecLen);
    if (ec.length !== ecLen) allLen = false;
    const full = data.concat(ec);
    for (let i = 0; i < ecLen; i++) if (evalPoly(full, EXP[i]) !== 0) allDivisible = false;
  }
  ok("EC block has the requested length", allLen);
  ok("data+EC is divisible by the generator (syndromes all zero)", allDivisible);

  const data = Array.from({ length: 16 }, (_, i) => (i * 13) & 0xff);
  const full = data.concat(QR._ecCodewords(data, 10));
  full[5] ^= 0x5a;
  let nonzero = false;
  for (let i = 0; i < 10; i++) if (evalPoly(full, EXP[i]) !== 0) nonzero = true;
  ok("a corrupted codeword yields a nonzero syndrome", nonzero);
}

/* ---------- format information ---------- */
section("format information (BCH 15,5)");
{
  ok("M / mask 0 == 101010000010010",
    QR._formatBits(0, 0).toString(2).padStart(15, "0") === "101010000010010",
    QR._formatBits(0, 0).toString(2).padStart(15, "0"));
  ok("L / mask 0 == 111011111000100",
    QR._formatBits(1, 0).toString(2).padStart(15, "0") === "111011111000100",
    QR._formatBits(1, 0).toString(2).padStart(15, "0"));

  const all = [];
  for (let ec = 0; ec < 4; ec++) for (let mk = 0; mk < 8; mk++) all.push(QR._formatBits(ec, mk));
  let minD = 99;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    let x = all[i] ^ all[j], d = 0;
    while (x) { d += x & 1; x >>>= 1; }
    if (d < minD) minD = d;
  }
  ok("minimum Hamming distance across all 32 format strings is 7", minD === 7, "got " + minD);
  ok("all 32 format strings are distinct", new Set(all).size === 32);
  ok("every format string fits in 15 bits", all.every((v) => v >= 0 && v < 32768));
}

/* ---------- version selection ---------- */
section("version selection");
{
  const caps = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106 };
  let boundaries = true;
  for (const v of Object.keys(caps).map(Number)) {
    if (QR._pickVersion(caps[v]) !== v) boundaries = false;
    if (v > 1 && QR._pickVersion(caps[v - 1] + 1) !== v) boundaries = false;
  }
  ok("each capacity boundary selects the expected version", boundaries);
  ok("over capacity returns null", QR._pickVersion(107) === null);
  ok("MAX_BYTES matches the version 6 capacity", QR.MAX_BYTES === 106);

  let threw = false;
  try { QR.encode("x".repeat(107)); } catch (e) { threw = /too long/.test(e.message); }
  ok("encoding an over-long payload throws a clear error", threw);

  let threwEmpty = false;
  try { QR.encode(""); } catch (e) { threwEmpty = true; }
  ok("encoding an empty payload throws", threwEmpty);
}

/* ---------- structure ---------- */
section("matrix structure");
{
  const samples = ["https://github.com/example/fieldkit", "FK",
    "x".repeat(30), "x".repeat(50), "x".repeat(70), "x".repeat(106)];

  let sizeOk = true, finderOk = true, timingOk = true, darkOk = true,
      completeOk = true, versions = new Set();

  for (const text of samples) {
    const qr = QR.encode(text);
    versions.add(qr.version);
    const n = qr.size;
    if (n !== 17 + qr.version * 4) sizeOk = false;

    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        const want = (r === 0 || r === 6 || c === 0 || c === 6) ||
                     (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        if (qr.get(r0 + r, c0 + c) !== want) finderOk = false;
      }
    }
    for (let i = 8; i < n - 8; i++) {
      if (qr.get(6, i) !== (i % 2 === 0)) timingOk = false;
      if (qr.get(i, 6) !== (i % 2 === 0)) timingOk = false;
    }
    if (qr.get(n - 8, 8) !== true) darkOk = false;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.modules[r][c] !== 0 && qr.modules[r][c] !== 1) completeOk = false;
    }
  }
  ok("size is 17 + 4*version for every sample", sizeOk);
  ok("all three finder patterns are correct", finderOk);
  ok("timing patterns alternate correctly", timingOk);
  ok("the fixed dark module is set", darkOk);
  ok("no module is left unset after encoding", completeOk);
  ok("samples exercised at least four versions", versions.size >= 4, "versions " + [...versions].join(","));
}

/* ---------- free-module count ---------- */
/* Re-derives the reservation map from geometry and compares against
   the published capacity. Off-by-one anywhere in the reserved areas
   and this number moves. */
section("data capacity of the reserved map");
{
  const expected = { 1: 208, 2: 359, 3: 567, 4: 807, 5: 1079, 6: 1383 };
  const samples = { 1: "FK", 2: "x".repeat(20), 3: "x".repeat(30),
    4: "x".repeat(50), 5: "x".repeat(70), 6: "x".repeat(106) };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

  let allMatch = true; const detail = [];
  for (const v of [1, 2, 3, 4, 5, 6]) {
    const qr = QR.encode(samples[v]);
    if (qr.version !== v) { allMatch = false; detail.push("v" + v + " picked " + qr.version); continue; }
    const n = qr.size;
    const res = Array.from({ length: n }, () => new Uint8Array(n));
    const mark = (r, c) => { if (r >= 0 && r < n && c >= 0 && c < n) res[r][c] = 1; };

    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c);
    }
    const centres = ALIGN[v];
    if (centres.length) {
      const last = centres[centres.length - 1];
      for (const r of centres) for (const c of centres) {
        if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
      }
    }
    for (let i = 8; i < n - 8; i++) { mark(6, i); mark(i, 6); }
    for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
    for (let i = 0; i < 8; i++) { mark(8, n - 1 - i); mark(n - 1 - i, 8); }

    let free = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!res[r][c]) free++;
    if (free !== expected[v]) { allMatch = false; detail.push("v" + v + ": " + free + " != " + expected[v]); }
  }
  ok("free-module count matches the specification for versions 1-6", allMatch, detail.join("; "));
}

/* ---------- format info read back out of the matrix ---------- */
section("format information as placed in the matrix");
{
  let agree = true, matches = true;
  for (const text of ["FK", "https://example.com/a", "x".repeat(90)]) {
    const qr = QR.encode(text);
    const n = qr.size;
    let v1 = 0, v2 = 0;
    for (let i = 0; i < 15; i++) {
      const b1 = i < 6 ? qr.get(i, 8) : i < 8 ? qr.get(i + 1, 8) : qr.get(n - 15 + i, 8);
      const b2 = i < 8 ? qr.get(8, n - 1 - i) : i === 8 ? qr.get(8, 7) : qr.get(8, 14 - i);
      if (b1) v1 |= (1 << i);
      if (b2) v2 |= (1 << i);
    }
    if (v1 !== v2) agree = false;
    if (v1 !== QR._formatBits(0, qr.mask)) matches = false;
  }
  ok("both format-info copies carry the same bits", agree);
  ok("placed format info decodes to level M and the chosen mask", matches);
}

/* ---------- masking ---------- */
section("mask selection");
{
  const masks = new Set();
  for (let i = 0; i < 24; i++) masks.add(QR.encode("payload-" + i + "-" + "y".repeat(i)).mask);
  ok("mask id is always 0-7", [...masks].every((m) => m >= 0 && m <= 7));
  ok("mask selection is not stuck on one value", masks.size >= 3, "saw " + [...masks].join(","));

  const a = QR.encode("https://github.com/example/fieldkit");
  const b = QR.encode("https://github.com/example/fieldkit");
  let same = a.mask === b.mask && a.size === b.size;
  for (let r = 0; r < a.size && same; r++) for (let c = 0; c < a.size; c++) {
    if (a.get(r, c) !== b.get(r, c)) { same = false; break; }
  }
  ok("encoding is deterministic", same);
}

/* ---------- payload + SVG ---------- */
section("payload encoding and SVG output");
{
  /* "cafe' *" here is 6 characters but 9 UTF-8 bytes. */
  const multi = QR.encode("café ✱");
  ok("multi-byte text encodes without throwing", multi.size > 0);
  ok("byte length reflects UTF-8, not character count", multi.bytes === 9, "got " + multi.bytes);

  const qr = QR.encode("https://example.com");
  const svg = QR.toSVG(qr, { scale: 4, quiet: 4 });
  const dim = (qr.size + 8) * 4;
  ok("svg declares the right dimensions",
    svg.includes('width="' + dim + '"') && svg.includes('height="' + dim + '"'));
  ok("svg has a light background rect", svg.includes("<rect"));

  let dark = 0;
  for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (qr.get(r, c)) dark++;
  ok("svg draws one sub-path per dark module",
    (svg.match(/M/g) || []).length === dark, (svg.match(/M/g) || []).length + " vs " + dark);
  ok("svg contains no script or external reference",
    !/script|href|xlink/.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")));
}

console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
process.exit(state.fail ? 1 : 0);
