/* ============================================================
   FieldKit relay :: topology — what this relay can see of itself,
   for the TOPOLOGY app to draw

     GET /topology     { at, parts:[{ id, label, kind, link, up, note }] }

   The relay already asks the run server, the browser helpers and the
   AI targets whether they are there, so the map is those same answers
   in one place. Public like /runner/status and /browser/status, which
   say as much: names and up or down, never an address.
   ============================================================ */
"use strict";

let src = null;

function init(sources) { src = sources; }

async function report() {
  const parts = [{ id: "relay", label: "RELAY", kind: "service", up: true, note: "answering" }];
  const add = (id, label, kind, link, up, note) => parts.push({ id, label, kind, link, up: !!up, note: note || "" });

  const br = src.browser ? src.browser() : null;
  if (br && br.enabled) {
    add("browser", "BROWSER", "service", "relay", br.ready, br.ready ? br.sessions + " in use" : br.lastFailure ? "not running" : "starting");
    (br.helpers || []).forEach((h, i) => add("browser-helper-" + (i + 1), String(h.name || "HELPER " + (i + 1)).toUpperCase().slice(0, 24),
      "service", "browser", h.up, h.up ? h.sessions + " in use" : "offline"));
  }

  const run = src.runner ? await src.runner() : null;
  if (run && run.enabled !== false) add("runner", "RUNNER", "host", "relay", run.online && run.ready !== false,
    run.online ? (run.sessions || 0) + " running" : run.why);

  (src.targets ? src.targets() : []).forEach((t, i) => add("ai-target-" + (i + 1), String(t.name).toUpperCase().slice(0, 24), "service", "relay",
    t.ok, t.ok ? "answering" : t.checked ? "not answering" : "not checked yet"));

  (src.tiny ? src.tiny() : []).forEach((m) => add("tiny-" + m.id, m.name.toUpperCase().slice(0, 24), "service", "relay", true, "for members"));

  return { at: new Date().toISOString(), parts };
}

async function route(req, res, url, kit) {
  if (!src) { kit.send(res, 503, { error: "the relay is still starting" }); return true; }
  kit.send(res, 200, await report());
  return true;
}

module.exports = { init, route, report };
