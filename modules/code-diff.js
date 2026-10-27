/* ============================================================
   FieldKit :: code-diff
   Paste two versions, get a coloured diff. Useful precisely
   because single-file projects don't always live in git (§3).
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, collapsed = true;

  function run() {
    var diff = FieldKit.need("diff");
    var rows = diff.diffLines(nodes.a.value, nodes.b.value);
    var s = diff.stats(rows);
    var shown = collapsed ? diff.collapse(rows, 3) : rows;

    ui.clear(nodes.out);
    nodes.out.appendChild(ui.readout([
      { label: "ADDED", value: "+" + s.added, level: s.added ? "pass" : "dim" },
      { label: "REMOVED", value: "-" + s.removed, level: s.removed ? "fail" : "dim" },
      { label: "UNCHANGED", value: s.unchanged, level: "dim" }
    ]));

    if (!s.added && !s.removed) {
      nodes.out.appendChild(el("div", { class: "cd-same", text: "FILES ARE IDENTICAL" }));
      return;
    }

    var body = el("div", { class: "cd-body" });
    shown.forEach(function (r) {
      if (r.type === "skip" || r.type === "note") {
        body.appendChild(el("div", { class: "cd-row cd-skip", text: r.text }));
        return;
      }
      var sign = r.type === "add" ? "+" : (r.type === "del" ? "-" : " ");
      body.appendChild(el("div", { class: "cd-row cd-" + r.type }, [
        el("span", { class: "cd-num", text: r.aLine == null ? "" : String(r.aLine) }),
        el("span", { class: "cd-num", text: r.bLine == null ? "" : String(r.bLine) }),
        el("span", { class: "cd-sign", text: sign }),
        el("span", { class: "cd-text", text: r.text })
      ]));
    });
    nodes.out.appendChild(body);
  }

  function swap() {
    var t = nodes.a.value;
    nodes.a.value = nodes.b.value;
    nodes.b.value = t;
    run();
  }

  function selfcheck() {
    return [
      { name: "DIFF RENDERS", critical: false, run: async function () {
        nodes.a.value = "alpha\nbravo\ncharlie\ndelta";
        nodes.b.value = "alpha\nbravo changed\ncharlie\nfoxtrot\ndelta";
        run();
        var adds = nodes.out.querySelectorAll(".cd-add").length;
        var dels = nodes.out.querySelectorAll(".cd-del").length;
        if (!adds || !dels) throw new Error("expected both additions and removals, got +" + adds + " -" + dels);
        return adds + " added row(s), " + dels + " removed row(s)";
      } },
      { name: "IDENTICAL INPUT", critical: false, run: async function () {
        nodes.a.value = nodes.b.value = "same\nlines\nhere";
        run();
        if (!/IDENTICAL/.test(nodes.out.textContent)) {
          throw new Error("identical files were not reported as identical");
        }
        return "reported as identical";
      } },
      { name: "SWAP SIDES", critical: false, run: async function () {
        nodes.a.value = "left";
        nodes.b.value = "right";
        swap();
        if (nodes.a.value !== "right" || nodes.b.value !== "left") throw new Error("swap did not exchange the panes");
        swap();
        if (nodes.a.value !== "left") throw new Error("swapping twice did not restore");
        nodes.a.value = nodes.b.value = "";
        run();
        return "swaps and restores";
      } }
    ];
  }

  FieldKit.register("code-diff", {
    group: "PROJECT",
    about: "Paste two versions of a file and see what changed",
    keywords: "diff compare code changes versions",
    guestSafe: true,
    selfcheck: selfcheck,
    title: "CODE DIFF",
    icon: "⇄",
    width: 760,
    height: 560,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.a = el("textarea", { class: "fk-input cd-in", spellcheck: "false", placeholder: "OLD VERSION" });
      nodes.b = el("textarea", { class: "fk-input cd-in", spellcheck: "false", placeholder: "NEW VERSION" });
      nodes.out = el("div", { class: "cd-out" });

      var toggle = ui.button("SHOW ALL LINES", function () {
        collapsed = !collapsed;
        toggle.textContent = collapsed ? "SHOW ALL LINES" : "COLLAPSE UNCHANGED";
        run();
      });

      host.appendChild(el("div", { class: "cd-wrap" }, [
        el("div", { class: "cd-inputs" }, [nodes.a, nodes.b]),
        el("div", { class: "cd-actions" }, [
          ui.button("DIFF", run, { primary: true }),
          toggle,
          ui.button("SWAP", swap),
          ui.button("CLEAR", function () {
            nodes.a.value = ""; nodes.b.value = ""; ui.clear(nodes.out);
          })
        ]),
        nodes.out
      ]));
    },

    unmount() { nodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("cd-style")) return;
    var s = document.createElement("style");
    s.id = "cd-style";
    s.textContent = `
.cd-wrap{display:flex;flex-direction:column;height:100%;gap:8px;min-height:0}
.cd-inputs{display:flex;gap:8px;flex:none;height:34%}
.cd-in{flex:1;resize:none;font-size:12px;line-height:1.45}
.cd-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap}
.cd-out{flex:1;overflow:auto;border:1px solid var(--line);background:var(--bg2);padding:8px;min-height:0}
.cd-body{margin-top:8px;font-size:12px;line-height:1.5}
.cd-row{display:flex;align-items:baseline;white-space:pre-wrap;word-break:break-word;padding:0 2px}
.cd-num{width:38px;flex:none;color:var(--fg-dimmer);font-size:10px;text-align:right;padding-right:6px;
  user-select:none}
.cd-sign{width:12px;flex:none;user-select:none}
.cd-text{flex:1}
.cd-eq{color:var(--fg-dim)}
.cd-add{background:rgba(79,191,106,.11);color:var(--pass)}
.cd-del{background:rgba(224,80,60,.11);color:var(--fail)}
.cd-skip{color:var(--fg-dimmer);font-size:10px;letter-spacing:.1em;padding:4px 0 4px 50px;
  border-top:1px dotted var(--line);border-bottom:1px dotted var(--line);margin:3px 0}
.cd-same{margin-top:10px;color:var(--pass);letter-spacing:.2em;font-size:11px;text-align:center}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
