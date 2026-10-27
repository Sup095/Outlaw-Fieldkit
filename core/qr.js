/* ============================================================
   FieldKit :: qr
   QR encoder, written from scratch — no dependency, works offline
   from the drive (§6: "encodes a link to GitHub or the hosted
   version, for friends to pull up on a phone").

   Scope, deliberately narrow: byte mode, error correction level M,
   versions 1-6 (up to 106 bytes). Version 7 and above additionally
   require a BCH-coded version-information block; stopping at 6
   avoids that entire mechanism while still comfortably fitting any
   URL. Anything longer is refused with a clear error rather than
   silently mis-encoded.

   References implemented here: GF(256) arithmetic with primitive
   0x11D, Reed-Solomon remainder, block interleaving, the eight
   mask patterns with the four penalty rules, and the 15-bit BCH
   format information XORed with 0x5412.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  /* ---- GF(256) ------------------------------------------------ */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  /* Generator polynomial for n EC codewords: (x+a^0)...(x+a^(n-1)) */
  function genPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function ecCodewords(data, ecLen) {
    var g = genPoly(ecLen);
    var res = data.slice().concat(new Array(ecLen).fill(0));
    for (var i = 0; i < data.length; i++) {
      var coef = res[i];
      if (coef === 0) continue;
      for (var j = 0; j < g.length; j++) res[i + j] ^= gmul(g[j], coef);
    }
    return res.slice(data.length);
  }

  /* ---- version tables (error correction level M) --------------- */
  /* [ecPerBlock, [ [blockCount, dataCodewordsPerBlock], ... ] ]    */
  var VERSIONS = {
    1: { ec: 10, blocks: [[1, 16]], capacity: 14 },
    2: { ec: 16, blocks: [[1, 28]], capacity: 26 },
    3: { ec: 26, blocks: [[1, 44]], capacity: 42 },
    4: { ec: 18, blocks: [[2, 32]], capacity: 62 },
    5: { ec: 24, blocks: [[2, 43]], capacity: 84 },
    6: { ec: 16, blocks: [[4, 27]], capacity: 106 }
  };
  var MAX_VERSION = 6;

  /* Alignment pattern centre coordinates per version. */
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

  var EC_LEVEL_M = 0;   // format-info bits for level M

  function pickVersion(byteLen) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      if (byteLen <= VERSIONS[v].capacity) return v;
    }
    return null;
  }

  /* ---- bit stream --------------------------------------------- */
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.toBytes = function () {
    var out = [];
    for (var i = 0; i < this.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      out.push(b);
    }
    return out;
  };

  function buildCodewords(bytes, version) {
    var spec = VERSIONS[version];
    var totalData = spec.blocks.reduce(function (s, b) { return s + b[0] * b[1]; }, 0);

    var buf = new BitBuffer();
    buf.put(4, 4);                    // byte mode
    buf.put(bytes.length, 8);         // count indicator: 8 bits for versions 1-9
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    /* Terminator, then pad to a byte boundary, then alternating
       pad codewords until the block is full. */
    var capacityBits = totalData * 8;
    var terminator = Math.min(4, capacityBits - buf.bits.length);
    buf.put(0, terminator);
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    var data = buf.toBytes();
    var pad = [0xec, 0x11], p = 0;
    while (data.length < totalData) data.push(pad[p++ % 2]);

    /* Split into blocks, compute EC per block, then interleave. */
    var dataBlocks = [], ecBlocks = [], offset = 0;
    spec.blocks.forEach(function (grp) {
      for (var b = 0; b < grp[0]; b++) {
        var chunk = data.slice(offset, offset + grp[1]);
        offset += grp[1];
        dataBlocks.push(chunk);
        ecBlocks.push(ecCodewords(chunk, spec.ec));
      }
    });

    var result = [];
    var maxData = Math.max.apply(null, dataBlocks.map(function (b) { return b.length; }));
    for (i = 0; i < maxData; i++) {
      for (var b2 = 0; b2 < dataBlocks.length; b2++) {
        if (i < dataBlocks[b2].length) result.push(dataBlocks[b2][i]);
      }
    }
    for (i = 0; i < spec.ec; i++) {
      for (b2 = 0; b2 < ecBlocks.length; b2++) result.push(ecBlocks[b2][i]);
    }
    return result;
  }

  /* ---- matrix ------------------------------------------------- */
  function makeMatrix(size) {
    var m = [];
    for (var r = 0; r < size; r++) m.push(new Int8Array(size).fill(-1));
    return m;
  }

  function placeFinder(m, res, size, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[rr][cc] = on ? 1 : 0;
        res[rr][cc] = 1;
      }
    }
  }

  function placeAlignment(m, res, size, version) {
    var centres = ALIGN[version];
    if (!centres.length) return;
    var last = centres[centres.length - 1];
    for (var i = 0; i < centres.length; i++) {
      for (var j = 0; j < centres.length; j++) {
        var r = centres[i], c = centres[j];
        /* Skip the three that would collide with finder patterns. */
        if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            m[r + dr][c + dc] = on ? 1 : 0;
            res[r + dr][c + dc] = 1;
          }
        }
      }
    }
  }

  function placeTiming(m, res, size) {
    for (var i = 8; i < size - 8; i++) {
      var on = (i % 2 === 0) ? 1 : 0;
      if (res[6][i] !== 1) { m[6][i] = on; res[6][i] = 1; }
      if (res[i][6] !== 1) { m[i][6] = on; res[i][6] = 1; }
    }
  }

  function reserveFormat(res, size) {
    for (var i = 0; i < 9; i++) {
      if (i !== 6) { res[8][i] = 1; res[i][8] = 1; }
    }
    for (i = 0; i < 8; i++) {
      res[8][size - 1 - i] = 1;
      res[size - 1 - i][8] = 1;
    }
    res[8][6] = 1;
    res[6][8] = 1;
  }

  function placeData(m, res, size, codewords) {
    var bits = [];
    codewords.forEach(function (b) {
      for (var i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
    });

    var idx = 0, up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;                 // skip the vertical timing column
      for (var i = 0; i < size; i++) {
        var row = up ? size - 1 - i : i;
        for (var k = 0; k < 2; k++) {
          var c = col - k;
          if (res[row][c] === 1) continue;
          m[row][c] = idx < bits.length ? bits[idx] : 0;
          idx++;
        }
      }
      up = !up;
    }
  }

  function maskFn(id, r, c) {
    switch (id) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function applyMask(m, res, size, id) {
    var out = m.map(function (row) { return Int8Array.from(row); });
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (res[r][c] === 1) continue;
        if (maskFn(id, r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  /* The four penalty rules from the specification. Lower is better. */
  function penalty(m, size) {
    var score = 0, r, c, i, run, prev;

    /* Rule 1: runs of five or more same-coloured modules. */
    for (r = 0; r < size; r++) {
      run = 1; prev = m[r][0];
      for (c = 1; c < size; c++) {
        if (m[r][c] === prev) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; prev = m[r][c]; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (c = 0; c < size; c++) {
      run = 1; prev = m[0][c];
      for (r = 1; r < size; r++) {
        if (m[r][c] === prev) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; prev = m[r][c]; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    /* Rule 2: 2x2 blocks of one colour. */
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    /* Rule 3: finder-like 1:1:3:1:1 patterns with four light modules. */
    var p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, len, pat) {
      var hits = 0;
      for (var s = 0; s + pat.length <= len; s++) {
        var ok = true;
        for (var k = 0; k < pat.length; k++) if (get(s + k) !== pat[k]) { ok = false; break; }
        if (ok) hits++;
      }
      return hits;
    }
    for (r = 0; r < size; r++) {
      (function (rr) {
        var get = function (i) { return m[rr][i]; };
        score += 40 * (matches(get, size, p1) + matches(get, size, p2));
      })(r);
    }
    for (c = 0; c < size; c++) {
      (function (cc) {
        var get = function (i) { return m[i][cc]; };
        score += 40 * (matches(get, size, p1) + matches(get, size, p2));
      })(c);
    }

    /* Rule 4: deviation from an even balance of dark and light. */
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c] === 1) dark++;
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  /* 15-bit BCH format information, XORed with the fixed mask. */
  function formatBits(ecLevel, mask) {
    var d = (ecLevel << 3) | mask;
    var rem = d;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    return (((d << 10) | rem) ^ 0x5412) & 0x7fff;
  }

  function placeFormat(m, size, ecLevel, mask) {
    var bits = formatBits(ecLevel, mask);
    for (var i = 0; i < 15; i++) {
      var bit = (bits >>> i) & 1;

      /* Copy one, vertical: down column 8, stepping over the timing
         module at row 6, then continuing in the bottom-left strip. */
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;

      /* Copy two, horizontal: along row 8, right to left, stepping
         over the timing module at column 6. */
      if (i < 8) m[8][size - 1 - i] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
    }
    m[size - 8][8] = 1;    // the always-dark module
  }

  /* ---- public ------------------------------------------------- */
  function encode(text, opts) {
    opts = opts || {};
    var bytes = Array.from(new TextEncoder().encode(String(text == null ? "" : text)));
    if (!bytes.length) throw new Error("nothing to encode");

    var version = opts.version || pickVersion(bytes.length);
    if (!version) {
      throw new Error("too long — " + bytes.length + " bytes, limit is " +
        VERSIONS[MAX_VERSION].capacity + " at this error correction level");
    }

    var size = 17 + version * 4;
    var m = makeMatrix(size);
    var res = makeMatrix(size);
    for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) res[r][c] = 0;

    placeFinder(m, res, size, 0, 0);
    placeFinder(m, res, size, 0, size - 7);
    placeFinder(m, res, size, size - 7, 0);
    placeAlignment(m, res, size, version);
    placeTiming(m, res, size);
    reserveFormat(res, size);
    res[size - 8][8] = 1;

    placeData(m, res, size, buildCodewords(bytes, version));

    /* Try every mask, keep the lowest penalty. */
    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mk = 0; mk < 8; mk++) {
      var cand = applyMask(m, res, size, mk);
      placeFormat(cand, size, EC_LEVEL_M, mk);
      var s = penalty(cand, size);
      if (s < bestScore) { bestScore = s; best = cand; bestMask = mk; }
    }

    return {
      size: size,
      version: version,
      mask: bestMask,
      penalty: bestScore,
      bytes: bytes.length,
      get: function (row, col) { return best[row][col] === 1; },
      modules: best
    };
  }

  /* SVG rather than canvas: sharp at any size, and it can be saved
     or printed without a raster step. */
  function toSVG(qr, opts) {
    opts = opts || {};
    var scale = opts.scale || 8;
    var quiet = opts.quiet === undefined ? 4 : opts.quiet;
    var dim = (qr.size + quiet * 2) * scale;
    var dark = opts.dark || "#0a0c0b";
    var light = opts.light || "#c2cdc4";

    var path = [];
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (!qr.get(r, c)) continue;
        path.push("M" + ((c + quiet) * scale) + "," + ((r + quiet) * scale) +
                  "h" + scale + "v" + scale + "h" + (-scale) + "z");
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
      '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path d="' + path.join("") + '" fill="' + dark + '"/></svg>';
  }

  FieldKit.provide("qr", {
    encode: encode,
    toSVG: toSVG,
    MAX_BYTES: VERSIONS[MAX_VERSION].capacity,
    VERSIONS: VERSIONS,
    /* exposed for tests */
    _gmul: gmul,
    _genPoly: genPoly,
    _ecCodewords: ecCodewords,
    _formatBits: formatBits,
    _pickVersion: pickVersion
  });
})(window.FieldKit);
