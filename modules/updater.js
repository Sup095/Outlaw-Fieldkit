/* ============================================================
   FieldKit :: UPDATE
   The client half of §14.4. Full build only.

   ---- THE ONE RULE --------------------------------------------

   Nothing is described as an update until its signature has been
   checked against the key that shipped inside this file's
   neighbour, core/update-key.js. Not "downloaded", not "available",
   not "ready" — the word update is earned by verifying.

   That matters more here than anywhere else in FieldKit, because
   this is the only remote-code path into an application that holds
   a vault. Whoever decides what gets downloaded next can hand over
   a modified core/crypto.js, and the build that quietly copies your
   passphrase looks exactly like the build that does not. The relay
   is therefore assumed hostile: it can withhold a release, serve a
   stale one, or serve rubbish, and the worst any of those achieves
   is leaving you on the version you already have.

   ---- WHY THE LAST STEP IS MANUAL -----------------------------

   `file://` cannot write to the drive it was loaded from. There is
   no API for it and there should not be — a page that could
   overwrite its own origin on disk is a worse problem than the one
   it solves. So FieldKit downloads the new build, proves it is
   genuine, and then hands it to you to save over the old one. The
   awkward step is the honest one.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var state = { phase: "idle", release: null, error: null, verified: null,
    source: null, assets: null, relayVersion: null, sideNote: null, checkedFile: null };

  /* Where releases are published (§14.43). The signed record rides in
     the release notes; GitHub is asked first, the relay second. */
  var DEFAULT_REPO = "Sup095/Outlaw-Fieldkit";

  function relayBase() {
    var u = String(ctx.settings.get("relayUrl") || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }

  function repo() {
    var r = String(ctx.settings.get("updateRepo") || DEFAULT_REPO).trim();
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) ? r : DEFAULT_REPO;
  }

  /* The signed record inside a GitHub release's notes, written there
     by `node build.js --release`. Kept identical to parseReleaseBody()
     in relay/updates.js; tests/updates.test.js runs both. */
  var BODY_RE = /<!--\s*FIELDKIT-RELEASE\s*([\s\S]*?)\s*FIELDKIT-RELEASE\s*-->/;
  function parseReleaseBody(body) {
    var m = BODY_RE.exec(String(body || ""));
    if (!m) return null;
    try {
      var rel = JSON.parse(m[1]);
      return rel && typeof rel === "object" && Array.isArray(rel.files) ? rel : null;
    } catch (e) { return null; }
  }

  /* ---- the signature ---------------------------------------------
     Rebuilt from the fields that were read, in the order the signer
     used, rather than by re-serialising the object. Two JSON
     serialisers can disagree about key order, and a signature over
     "whatever JSON.stringify produced that day" verifies by luck.
     Kept identical to signingPayload() in build.js — the pair is
     asserted by tests/updates.test.js, which runs both. */
  function signingPayload(rel) {
    return [
      rel.version,
      rel.publishedAt,
      (rel.files || []).map(function (f) {
        return f.name + ":" + f.size + ":" + f.sha256;
      }).join("|")
    ].join("\n");
  }

  function b64ToBytes(s) {
    var raw = atob(String(s));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function hex(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  async function verifyRelease(rel) {
    var keyDef = FieldKit.service("updateKey");
    if (!keyDef) throw new Error("this build carries no update key, so it cannot check a release");
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("crypto.subtle is unavailable here, so a signature cannot be checked. " +
        "Nothing will be offered — an unverified build is not an update.");
    }
    if (!rel || !rel.signature || !rel.files || !rel.files.length) {
      throw new Error("that release is missing its signature or its file list");
    }
    if (rel.algorithm && rel.algorithm !== keyDef.algorithm) {
      /* A release naming a different algorithm is either a key
         rotation nobody shipped or someone trying one on. Either
         way it is not something to work around. */
      throw new Error("that release is signed with " + rel.algorithm +
        " but this build only accepts " + keyDef.algorithm);
    }

    var key = await window.crypto.subtle.importKey(
      "spki", b64ToBytes(keyDef.spki),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

    var ok = await window.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key,
      b64ToBytes(rel.signature),
      new TextEncoder().encode(signingPayload(rel)));

    if (!ok) {
      throw new Error("THE SIGNATURE DOES NOT MATCH. This release was not made with the key " +
        "this build trusts. Do not install it, and do not work around this message — " +
        "either the relay is serving something it did not get from the SSD, or the " +
        "signing key was rotated without shipping the new public half.");
    }
    return true;
  }

  /* ---- asking ------------------------------------------------------ */
  async function getJson(url, ms, headers) {
    var ac = typeof AbortController === "function" ? new AbortController() : null;
    var t = setTimeout(function () { if (ac) ac.abort(); }, ms || 15000);
    try {
      var r = await fetch(url, { cache: "no-store", headers: headers || {}, signal: ac ? ac.signal : undefined });
      var text = await r.text();
      var data = null;
      try { data = JSON.parse(text); } catch (e) { /* not json */ }
      if (!r.ok) {
        var err = new Error((data && (data.error || data.message)) || ("answered " + r.status));
        err.status = r.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("no answer in time");
      if (e instanceof TypeError) throw new Error("could not be reached from this network");
      throw e;
    } finally { clearTimeout(t); }
  }

  /* GitHub: the latest release, its signed record, and its files.
     GitHub's own sha256 for each file must agree with the signed one:
     a mismatch means GitHub is holding something other than what was
     signed, and nothing from there is offered. */
  async function fromGithub() {
    var gh = await getJson("https://api.github.com/repos/" + repo() + "/releases/latest", 15000,
      { "Accept": "application/vnd.github+json" });
    var rel = parseReleaseBody(gh && gh.body);
    if (!rel) throw new Error("the latest release (" + ((gh && gh.tag_name) || "?") + ") carries no signed record");
    await verifyRelease(rel);
    var assets = {};
    rel.files.forEach(function (f) {
      var a = (gh.assets || []).filter(function (x) { return x.name === f.name; })[0];
      if (!a) throw new Error(f.name + " is signed but not attached to the release");
      if (a.digest && a.digest !== "sha256:" + f.sha256) {
        throw new Error("GitHub's " + f.name + " is not the file that was signed. Nothing from GitHub is offered.");
      }
      assets[f.name] = a.browser_download_url;
    });
    return { rel: rel, assets: assets };
  }

  async function fromRelay() {
    if (!relayBase()) throw new Error("no relay address is set");
    var rel = await getJson(relayBase() + "/updates/latest", 15000);
    await verifyRelease(rel);
    return { rel: rel };
  }

  /* The bytes, through the relay: GitHub's downloads cannot be read by
     a page (no CORS headers), the relay's copy can, so this is the path
     where the file is hashed here before it is offered. */
  async function fetchFile(entry) {
    if (!relayBase()) throw new Error("no relay address is set, so the file cannot be fetched and checked here");
    var res = await fetch(relayBase() + "/updates/file?name=" + encodeURIComponent(entry.name), { cache: "no-store" });
    if (!res.ok) {
      var data = null;
      try { data = JSON.parse(await res.text()); } catch (e) { /* not json */ }
      throw new Error("the relay: " + ((data && data.error) || ("answered " + res.status)));
    }
    var bytes = await res.arrayBuffer();

    /* Hashed here, against a number that was inside the signature.
       The relay also checks this and its check does not count — it
       is the party being verified. */
    var digest = hex(await window.crypto.subtle.digest("SHA-256", bytes));
    if (digest !== entry.sha256) {
      throw new Error("the downloaded " + entry.name + " does not match the signed release " +
        "(expected " + entry.sha256.slice(0, 12) + "…, got " + digest.slice(0, 12) + "…). " +
        "It was altered or truncated in transit. Nothing has been saved.");
    }
    if (bytes.byteLength !== entry.size) {
      throw new Error("the downloaded " + entry.name + " is the wrong length");
    }
    return bytes;
  }

  /* ---- the flow ---------------------------------------------------- */
  function currentVersion() {
    return (ctx.version || FieldKit.VERSION || "unknown");
  }

  /* Compares dotted numeric versions. Anything unparseable is
     treated as "different, and you decide", rather than guessed at —
     silently deciding that 0.2.0 is older than 0.10.0 by string
     order is the classic way to skip a release. */
  function compareVersions(a, b) {
    var pa = String(a).split(".").map(Number);
    var pb = String(b).split(".").map(Number);
    if (pa.some(isNaN) || pb.some(isNaN)) return null;
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  async function check() {
    state = { phase: "checking", release: null, error: null, verified: null,
      source: null, assets: null, relayVersion: null, sideNote: null, checkedFile: null };
    render();
    var why = [];
    try {
      var got = null;
      try { got = await fromGithub(); state.source = "GITHUB"; }
      catch (e) { why.push("GitHub: " + e.message); }
      /* The relay is asked either way: as the fallback, and to know
         whether its copy has caught up (it is the only path where
         the file is checked here before saving). */
      var viaRelay = null;
      try { viaRelay = await fromRelay(); }
      catch (e) { if (!got) why.push("the relay: " + e.message); }
      if (!got && viaRelay) { got = viaRelay; state.source = "RELAY"; }
      if (!got) throw new Error(why.join("; ") + ".");
      if (viaRelay) state.relayVersion = viaRelay.rel.version;
      state.release = got.rel;
      state.assets = got.assets || null;
      state.verified = true;
      state.phase = "checked";
      if (why.length) state.sideNote = why.join("; ") + " — used the relay instead.";
    } catch (e) {
      state.error = e.message;
      state.phase = "error";
      /* Explicitly cleared. A half-populated release left on screen
         next to an error is how someone ends up installing the thing
         that just failed to verify. */
      state.release = null;
      state.verified = false;
    }
    render();
  }

  async function download(entry) {
    setBusy(true);
    try {
      if (state.relayVersion !== state.release.version) {
        throw new Error("the relay is not serving " + state.release.version + " yet" +
          (state.relayVersion ? " (it has " + state.relayVersion + ")" : "") +
          ". Use FROM GITHUB, then CHECK A DOWNLOADED FILE.");
      }
      var bytes = await fetchFile(entry);
      /* Only now. Everything above this line can fail, and every
         failure above this line means nothing reaches the disk. */
      var handed = ui.download(bytes, entry.name, "text/html");
      if (!handed) {
        throw new Error("this machine refused the download. The file was fetched and " +
          "verified, but nothing here can save it — try FROM GITHUB, or copy the build " +
          "off the SSD directly.");
      }
      /* "Offered", not "saved". ui.download cannot tell whether the
         browser actually wrote anything, and claiming it did is how
         someone ends up looking for a file that was silently
         blocked. */
      ui.toast("VERIFIED — " + entry.name + " OFFERED", "ok");
      note("Signature checked and the file was handed to your browser. If it did not appear " +
        "in Downloads, this machine blocked it silently. Once you have it, copy it over the " +
        entry.name + " on the drive — and keep the old one until the new one has booted once.");
    } catch (e) {
      ui.toast("NOT SAVED — " + e.message, "fail");
      note(e.message, true);
    } finally { setBusy(false); }
  }

  /* GitHub's link, opened as a normal download. The page cannot read
     those bytes, so the check comes after: CHECK A DOWNLOADED FILE. */
  function fromGithubLink(entry) {
    var url = state.assets && state.assets[entry.name];
    if (!url) return;
    var a = el("a", { href: url, target: "_blank", rel: "noopener" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    note("Downloading " + entry.name + " from GitHub. When it is done, press CHECK A DOWNLOADED FILE " +
      "and pick it: it is hashed here and compared with the signed release.");
  }

  /* Any file, hashed here and looked up in the signed list. */
  function pickAndCheck() {
    var input = el("input", { type: "file", accept: ".html,text/html" });
    input.style.display = "none";
    input.addEventListener("change", async function () {
      var file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        var digest = hex(await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
        var hit = state.release.files.filter(function (f) { return f.sha256 === digest; })[0];
        state.checkedFile = hit
          ? { ok: true, text: file.name + " IS the signed " + hit.name + " of " + state.release.version +
              ". Copy it over the one on the drive (as " + hit.name + ")." }
          : { ok: false, text: file.name + " does NOT match any file in the signed release. Do not use it." };
      } catch (e) {
        state.checkedFile = { ok: false, text: "could not read " + file.name + ": " + e.message };
      }
      render();
    });
    document.body.appendChild(input);
    input.click();
  }

  /* ---- UI ----------------------------------------------------------- */
  function setBusy(on) {
    if (nodes.actions) {
      Array.prototype.forEach.call(nodes.actions.children, function (b) { b.disabled = on; });
    }
  }

  function note(text, bad) {
    if (!nodes.note) return;
    nodes.note.textContent = text;
    nodes.note.className = "up-note" + (bad ? " bad" : "");
  }

  function render() {
    if (!nodes.root) return;
    ui.clear(nodes.root);
    var keyDef = FieldKit.service("updateKey");

    nodes.root.appendChild(el("div", { class: "up-head" }, [
      el("div", { class: "up-h", text: "UPDATE" }),
      el("div", { class: "up-p", text:
        "Releases are published on GitHub and copied by your relay, signed on the SSD. " +
        "This checks the signature against a key built into this copy of FieldKit — " +
        "neither GitHub nor the relay is asked whether a release is genuine." })
    ]));

    nodes.root.appendChild(ui.readout([
      { label: "RUNNING", value: currentVersion(), level: "dim" },
      { label: "ASKS", value: "GITHUB " + repo() + (relayBase() ? ", THEN THE RELAY" : ""), level: "dim" },
      { label: "TRUSTED KEY", value: keyDef ? keyDef.fingerprint : "NONE — cannot verify",
        level: keyDef ? "dim" : "fail" }
    ]));

    if (keyDef) {
      nodes.root.appendChild(el("div", { class: "up-fp", text:
        "Compare that fingerprint against the one printed when the key was made. " +
        "It is the one check that does not go through GitHub or the relay." }));
    }

    nodes.actions = el("div", { class: "up-actions" }, [
      ui.button(state.phase === "checking" ? "CHECKING…" : "CHECK FOR AN UPDATE",
        check, { primary: true })
    ]);
    nodes.root.appendChild(nodes.actions);

    nodes.note = el("div", { class: "up-note" });

    if (state.phase === "error") {
      nodes.root.appendChild(el("div", { class: "up-bad" }, [
        el("div", { class: "up-bad-h", text: "NO UPDATE OFFERED" }),
        el("div", { class: "up-bad-p", text: state.error })
      ]));
    }

    if (state.release && state.verified) {
      var rel = state.release;
      var cmp = compareVersions(currentVersion(), rel.version);

      nodes.root.appendChild(ui.readout([
        { label: "SIGNATURE", value: "VERIFIED", level: "pass" },
        { label: "FROM", value: state.source === "GITHUB" ? "GITHUB (FILES MATCH GITHUB'S HASHES)" : "THE RELAY", level: "dim" },
        { label: "RELAY COPY", value: !relayBase() ? "NO RELAY SET"
            : state.relayVersion === rel.version ? "UP TO DATE — FILES CAN BE CHECKED HERE"
            : state.relayVersion ? "STILL ON " + state.relayVersion : "NOT AVAILABLE",
          level: state.relayVersion === rel.version ? "pass" : "warn" },
        { label: "SIGNED BY", value: rel.keyFingerprint || "—", level: "dim" },
        { label: "OFFERED", value: rel.version, level: "dim" },
        { label: "PUBLISHED", value: String(rel.publishedAt || "").slice(0, 16), level: "dim" },
        { label: "COMPARED", value:
            cmp === null ? "CANNOT TELL — VERSIONS DO NOT PARSE"
              : cmp < 0 ? "NEWER THAN YOURS"
              : cmp === 0 ? "THE SAME AS YOURS" : "OLDER THAN YOURS",
          level: cmp === null ? "warn" : cmp < 0 ? "pass" : "dim" }
      ]));

      if (rel.notes) {
        nodes.root.appendChild(el("div", { class: "up-notes", text: rel.notes }));
      }

      /* Offered even when it is not newer, and labelled. A relay
         serving an older signed build is a rollback attempt or a
         mistake, and either way the answer is to show what it is
         rather than to hide the button. */
      if (cmp !== null && cmp > 0) {
        nodes.root.appendChild(el("div", { class: "up-warnbox", text:
          "This release is OLDER than what you are running. It is correctly signed, so it " +
          "is genuinely one of yours — but a relay offering you a step backwards is either " +
          "a stale upload or someone trying to put you on a version with a bug they know " +
          "about. Check the SSD before taking it." }));
      }

      var list = el("div", { class: "up-files" });
      var mine = FieldKit.service("boot") && FieldKit.service("boot").OUTPOST ? "OUTPOST" : "FIELDKIT";
      rel.files.forEach(function (f) {
        var relayOk = state.relayVersion === rel.version;
        list.appendChild(el("div", { class: "up-file" + (f.build === mine ? " mine" : "") }, [
          el("span", { class: "up-file-n", text: f.name + (f.build === mine ? "  ← THIS BUILD" : "") }),
          el("span", { class: "up-file-s", text: Math.round(f.size / 1024) + " KB" }),
          el("span", { class: "up-file-h", text: f.sha256.slice(0, 12) + "…" }),
          relayOk ? ui.button("DOWNLOAD (CHECKED)", function () { download(f); }, { primary: f.build === mine }) : null,
          state.assets && state.assets[f.name] ? ui.button("FROM GITHUB", function () { fromGithubLink(f); }) : null
        ].filter(Boolean)));
      });
      nodes.root.appendChild(list);
      nodes.root.appendChild(el("div", { class: "up-actions" }, [
        ui.button("CHECK A DOWNLOADED FILE", pickAndCheck)
      ]));
      if (state.checkedFile) {
        nodes.root.appendChild(el("div", { class: state.checkedFile.ok ? "up-okbox" : "up-bad", text: state.checkedFile.text }));
      }
      if (state.sideNote) nodes.root.appendChild(el("div", { class: "up-fp", text: state.sideNote }));
      nodes.root.appendChild(el("div", { class: "up-p", text:
        "DOWNLOAD (CHECKED) fetches the file through your relay and hashes it here before " +
        "saving. FROM GITHUB downloads it directly; then CHECK A DOWNLOADED FILE hashes it " +
        "against the signature. FieldKit cannot write to the drive it booted from, so the " +
        "last step is you copying the file across." }));
    }

    nodes.root.appendChild(nodes.note);
  }

  /* ---- selfcheck ------------------------------------------------------ */
  function selfcheck() {
    return [
      { name: "A TRUSTED KEY IS BUILT IN", critical: true, run: async function () {
        var k = FieldKit.service("updateKey");
        if (!k) throw new Error("no update key shipped — no release could ever be verified");
        if (!k.spki || k.spki.length < 80) throw new Error("the shipped key looks malformed");
        if (k.algorithm !== "ECDSA-P256-SHA256") {
          throw new Error("unexpected algorithm: " + k.algorithm);
        }
        return "key " + k.fingerprint;
      } },

      /* The one that matters. A verifier that says yes to everything
         is worse than none, because it looks like protection. */
      { name: "A TAMPERED RELEASE IS REJECTED", critical: true, run: async function () {
        if (!window.crypto || !window.crypto.subtle) {
          throw new Error("SKIPPED — no crypto.subtle on this origin");
        }
        var base = {
          version: "9.9.9", publishedAt: "2026-01-01T00:00:00.000Z",
          algorithm: "ECDSA-P256-SHA256",
          files: [{ name: "X.html", size: 10, sha256: "a".repeat(64) }],
          signature: btoa("not a real signature at all, padded out to a plausible length!!")
        };
        var refused = false;
        try { await verifyRelease(base); } catch (e) { refused = true; }
        if (!refused) throw new Error("a made-up signature was accepted");

        var noSig = JSON.parse(JSON.stringify(base));
        delete noSig.signature;
        refused = false;
        try { await verifyRelease(noSig); } catch (e) { refused = true; }
        if (!refused) throw new Error("a release with no signature at all was accepted");

        var wrongAlg = JSON.parse(JSON.stringify(base));
        wrongAlg.algorithm = "RSA-PSS";
        refused = false;
        try { await verifyRelease(wrongAlg); } catch (e) { refused = true; }
        if (!refused) throw new Error("a release naming a different algorithm was accepted");

        return "forged, unsigned and wrong-algorithm releases all refused";
      } },

      { name: "THE SIGNED STRING IS ORDER-STABLE", critical: true, run: async function () {
        /* If this ever depended on object key order, signatures would
           verify on the machine that made them and fail elsewhere —
           the worst kind of bug, because it passes every test run on
           one computer. */
        var a = { version: "1.0.0", publishedAt: "T", files: [{ name: "n", size: 1, sha256: "h" }] };
        var b = { files: [{ sha256: "h", name: "n", size: 1 }], publishedAt: "T", version: "1.0.0" };
        if (signingPayload(a) !== signingPayload(b)) {
          throw new Error("the payload changes with key order");
        }
        if (signingPayload(a).indexOf("1.0.0") < 0) throw new Error("the version is not covered");
        if (signingPayload(a).indexOf("h") < 0) throw new Error("the file hash is not covered");
        return "built from named fields, not from serialisation";
      } },

      { name: "VERSIONS COMPARE THE WAY PEOPLE EXPECT", critical: false, run: async function () {
        /* 0.10.0 after 0.9.0 is the one string comparison always
           gets wrong, and getting it wrong means silently skipping a
           release. */
        if (compareVersions("0.9.0", "0.10.0") !== -1) throw new Error("0.10.0 is not seen as newer than 0.9.0");
        if (compareVersions("1.0.0", "1.0.0") !== 0) throw new Error("equal versions do not compare equal");
        if (compareVersions("2.0.0", "1.9.9") !== 1) throw new Error("2.0.0 is not seen as newer");
        if (compareVersions("1.2", "1.2.0") !== 0) throw new Error("a missing patch level should mean zero");
        if (compareVersions("1.0.0", "beta") !== null) throw new Error("an unparseable version should be admitted, not guessed");
        return "numeric compare, and it says so when it cannot tell";
      } },

      { name: "NOTHING IS SAVED BEFORE IT IS VERIFIED", critical: true, run: async function () {
        var src = String(download) + String(fetchFile);
        var save = src.indexOf("ui.download");
        var hashCheck = src.indexOf("does not match the signed release");
        if (save < 0) throw new Error("nothing saves the file — the probe is checking the wrong thing");
        if (hashCheck < 0) throw new Error("the downloaded file is never re-hashed");
        /* Ordering asserted by position: fetchFile throws before
           download() ever reaches the save. */
        if (String(download).indexOf("ui.download") < String(download).indexOf("fetchFile")) {
          throw new Error("the file is handed over before it is fetched and checked");
        }
        return "hash checked against the signature first, saved second";
      } }
    ];
  }

  FieldKit.register("updater", {
    title: "UPDATE",
    icon: "⬇",
    group: "SYSTEM",
    about: "Check for and install a signed FieldKit update",
    keywords: "update upgrade version install new",
    width: 660,
    height: 560,
    /* Nothing private is involved: the builds are public. */
    guestSafe: true,
    selfcheck: selfcheck,
    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();
      nodes.root = el("div", { class: "up-root" });
      host.appendChild(nodes.root);
      render();
      /* Asked straight away: opening UPDATE is asking. */
      if (state.phase === "idle" && typeof fetch === "function") check();
    },

    unmount() { nodes = {}; }
  });

  function injectCSS() {
    if (document.getElementById("up-style")) return;
    var s = document.createElement("style");
    s.id = "up-style";
    s.textContent = [
      ".up-root{display:flex;flex-direction:column;gap:10px}",
      ".up-h{font-size:12px;letter-spacing:.2em;color:var(--accent)}",
      ".up-p{font-size:10px;color:var(--fg-dim);line-height:1.6}",
      ".up-fp{font-size:10px;color:var(--fg-dimmer);line-height:1.5}",
      ".up-actions{display:flex;gap:6px;flex-wrap:wrap}",
      ".up-note{font-size:10px;color:var(--fg-dim);line-height:1.5}",
      ".up-note.bad{color:var(--fail)}",
      ".up-notes{font-size:11px;color:var(--fg);border-left:2px solid var(--line2);padding-left:8px}",
      ".up-bad{border:1px solid var(--fail);padding:10px}",
      ".up-bad-h{font-size:10px;letter-spacing:.16em;color:var(--fail);margin-bottom:4px}",
      ".up-bad-p{font-size:10px;color:var(--fg-dim);line-height:1.6}",
      ".up-warnbox{border:1px solid var(--warn);padding:10px;font-size:10px;",
      "  color:var(--warn);line-height:1.6}",
      ".up-files{display:flex;flex-direction:column;gap:4px}",
      ".up-file{display:flex;gap:8px;align-items:center;border:1px solid var(--line);",
      "  padding:6px 8px;font-size:10px}",
      ".up-file-n{flex:1;color:var(--fg)}",
      ".up-file-s{color:var(--fg-dim)}",
      ".up-file-h{color:var(--fg-dimmer)}",
      ".up-file.mine{border-color:var(--accent)}",
      ".up-okbox{border:1px solid var(--pass);padding:10px;font-size:10px;color:var(--pass);line-height:1.6}",
      ".up-root{overflow:auto;height:100%}"
    ].join("\n");
    document.head.appendChild(s);
  }
})(window.FieldKit);
