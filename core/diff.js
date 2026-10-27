/* ============================================================
   FieldKit :: diff
   Line diff engine, shared by code-diff and (later) the save-code
   inspector. Kept in core/ precisely so there is one implementation
   rather than one per module.

   Strategy: trim the common prefix and suffix first — in practice
   most edits touch a small middle — then run an LCS table over
   whatever is left. That keeps the quadratic part small enough to
   stay interactive on realistic files, and the size cap refuses
   the pathological case rather than freezing the tab.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var MAX_CELLS = 4000000;   // ~2000x2000 changed lines

  function splitLines(text) {
    return String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  }

  function lcsTable(a, b) {
    var n = a.length, m = b.length;
    /* One row at a time would halve memory but we need the full
       table to walk the path back out. */
    var t = new Array(n + 1);
    for (var i = 0; i <= n; i++) t[i] = new Int32Array(m + 1);
    for (i = n - 1; i >= 0; i--) {
      var row = t[i], next = t[i + 1];
      for (var j = m - 1; j >= 0; j--) {
        row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
      }
    }
    return t;
  }

  function diffLines(oldText, newText) {
    var a = splitLines(oldText), b = splitLines(newText);

    var head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;

    var tail = 0;
    while (tail < (a.length - head) && tail < (b.length - head) &&
           a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

    var aMid = a.slice(head, a.length - tail);
    var bMid = b.slice(head, b.length - tail);

    var out = [];
    var ai = 0, bi = 0;
    for (var i = 0; i < head; i++) out.push({ type: "eq", text: a[i], aLine: i + 1, bLine: i + 1 });

    if (aMid.length * bMid.length > MAX_CELLS) {
      /* Too big to diff precisely. Report it honestly as a whole
         block replacement rather than pretending or hanging. */
      out.push({ type: "note", text: "— region too large to diff precisely (" +
        aMid.length + " x " + bMid.length + " lines) —" });
      aMid.forEach(function (l, k) { out.push({ type: "del", text: l, aLine: head + k + 1, bLine: null }); });
      bMid.forEach(function (l, k) { out.push({ type: "add", text: l, aLine: null, bLine: head + k + 1 }); });
    } else if (aMid.length || bMid.length) {
      var t = lcsTable(aMid, bMid);
      while (ai < aMid.length && bi < bMid.length) {
        if (aMid[ai] === bMid[bi]) {
          out.push({ type: "eq", text: aMid[ai], aLine: head + ai + 1, bLine: head + bi + 1 });
          ai++; bi++;
        } else if (t[ai + 1][bi] >= t[ai][bi + 1]) {
          out.push({ type: "del", text: aMid[ai], aLine: head + ai + 1, bLine: null });
          ai++;
        } else {
          out.push({ type: "add", text: bMid[bi], aLine: null, bLine: head + bi + 1 });
          bi++;
        }
      }
      while (ai < aMid.length) { out.push({ type: "del", text: aMid[ai], aLine: head + ai + 1, bLine: null }); ai++; }
      while (bi < bMid.length) { out.push({ type: "add", text: bMid[bi], aLine: null, bLine: head + bi + 1 }); bi++; }
    }

    for (i = 0; i < tail; i++) {
      out.push({ type: "eq", text: a[a.length - tail + i],
        aLine: a.length - tail + i + 1, bLine: b.length - tail + i + 1 });
    }

    return out;
  }

  function stats(rows) {
    return {
      added: rows.filter(function (r) { return r.type === "add"; }).length,
      removed: rows.filter(function (r) { return r.type === "del"; }).length,
      unchanged: rows.filter(function (r) { return r.type === "eq"; }).length
    };
  }

  /* Collapse long runs of unchanged lines, keeping `context` on
     each side of every change — the usual unified-diff behaviour. */
  function collapse(rows, context) {
    context = context === undefined ? 3 : context;
    var keep = new Array(rows.length).fill(false);
    rows.forEach(function (r, i) {
      if (r.type === "eq") return;
      for (var k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
    });
    var out = [], skipped = 0;
    rows.forEach(function (r, i) {
      if (keep[i]) {
        if (skipped) { out.push({ type: "skip", text: "⋯ " + skipped + " unchanged line(s)" }); skipped = 0; }
        out.push(r);
      } else skipped++;
    });
    if (skipped) out.push({ type: "skip", text: "⋯ " + skipped + " unchanged line(s)" });
    return out;
  }

  FieldKit.provide("diff", {
    diffLines: diffLines,
    splitLines: splitLines,
    stats: stats,
    collapse: collapse,
    MAX_CELLS: MAX_CELLS
  });
})(window.FieldKit);
