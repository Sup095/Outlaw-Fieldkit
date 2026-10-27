/* ============================================================
   FieldKit :: MESSAGES
   The client for §14.2. Runs in both builds.

   Everything sensitive happens here and nothing sensitive leaves:
   the password never goes to the relay, the private key is unwrapped
   in memory and never written down, and messages are sealed before
   they are sent and opened after they arrive.

   ---- WHAT LIVES WHERE ----------------------------------------

   In memory only, gone when the tab closes:
     identity (the unwrapped private key), convKeys.

   In settings (so a new machine knows who you are, never what you
   know): msgHandle. It rides the drive profile; the password does
   not and cannot.

   Nothing at all in the vault. Messaging is a separate identity
   system from the vault on purpose — mixing them would drag the
   vault's threat model down to this one's.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {}, mc = null;

  /* Session state. Deliberately all in memory. */
  var session = null;          // { handle, token, moderator, pubKey }
  var identity = null;         // unwrapped private key
  var convKeys = {};           // convId -> { epoch -> CryptoKey }
  var conversations = [];
  var directory = [];
  var moderators = [];         // handles, from the relay's own config
  var messages = {};           // convId -> [{ from, at, text, ok }]
  var openConv = null;
  var cursor = 0;
  var polling = false, stopPolling = false;

  /* 8, matching the vault's rule in core/store.js rather than
     inventing a second standard. A minimum long enough to be
     annoying is a minimum people work around — and the thing
     actually doing the work here is 600k PBKDF2 iterations, which
     makes guessing expensive whatever the length. */
  var MIN_PASSWORD = 8;
  var MIN_POLL_GAP = 300;      // see pollLoop()
  /* Kept in step with LIMITS.handle in relay/messaging.js. Checked
     here as well so a bad handle is refused instantly rather than
     after the 600k-iteration derivation that would otherwise run
     first and then be thrown away by a 400. */
  var HANDLE_RE = /^[a-z0-9._-]{3,24}$/;

  function relayBase() {
    var u = String(ctx.settings.get("relayUrl") || "").trim();
    return u ? u.replace(/\/+$/, "") : "";
  }

  /* ---- talking to the relay ------------------------------------ */
  async function api(method, p, body, opts) {
    opts = opts || {};
    var base = relayBase();
    if (!base) throw new Error("no relay is configured — set one in SETTINGS first");

    var headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (session && session.token && !opts.anon) headers.Authorization = "Bearer " + session.token;

    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, opts.timeout || 15000);
    try {
      /* window.fetch rather than bare fetch, and it matters: the
         selfcheck below proves the password never leaves by swapping
         window.fetch out. Calling the bare binding would leave a
         second door the probe cannot see. */
      var res = await window.fetch(base + p, {
        method: method, headers: headers, mode: "cors", cache: "no-store",
        signal: ac.signal,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      var text = await res.text();
      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }

      if (!res.ok) {
        /* A ban is not an error to show as a red toast and move on
           from — it ends the session, so it is handled here once
           rather than at every call site. */
        if (res.status === 403 && data && data.banned) {
          signOut("your account has been " + (data.banned.until ? "suspended" : "banned"));
        }
        var err = new Error((data && data.error) || ("relay returned " + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("the relay did not answer in time");
      throw e;
    } finally { clearTimeout(timer); }
  }

  /* ---- sign in / sign up --------------------------------------- */
  function checkHandle(handle) {
    if (!HANDLE_RE.test(handle)) {
      throw new Error("that handle will not do — 3 to 24 characters, lowercase letters, " +
        "digits, and . _ - only");
    }
  }

  async function signUp(handle, password, displayName) {
    checkHandle(handle);
    if (String(password).length < MIN_PASSWORD) {
      throw new Error("that password is too short — at least " + MIN_PASSWORD + " characters. " +
        "There is no way to reset it, so make it one you will not lose.");
    }
    var keys = await mc.accountKeys(password, handle);
    var pair = await mc.newIdentity();
    var out = await api("POST", "/msg/register", {
      handle: handle,
      authSecret: keys.authSecret,
      pubKey: await mc.exportPublic(pair),
      wrappedPrivKey: await mc.wrapPrivate(pair, keys.wrapKey),
      displayName: displayName || handle
    }, { anon: true });

    identity = pair.privateKey;
    session = { handle: out.handle, token: out.token, moderator: !!out.moderator,
      root: !!out.root, tier: out.tier || "member" };
    ctx.settings.set("msgHandle", out.handle);
    return session;
  }

  async function signIn(handle, password) {
    checkHandle(handle);
    var keys = await mc.accountKeys(password, handle);
    var out = await api("POST", "/msg/login",
      { handle: handle, authSecret: keys.authSecret }, { anon: true });

    /* The server said yes, but the server does not hold the key that
       proves it. Unwrapping is the real check — and it failing here
       after a successful login means the stored blob is damaged, not
       that the password was wrong. */
    identity = await mc.unwrapPrivate(out.wrappedPrivKey, keys.wrapKey);
    session = { handle: out.handle, token: out.token, moderator: !!out.moderator,
      root: !!out.root, tier: out.tier || "member", pubKey: out.pubKey };
    ctx.settings.set("msgHandle", out.handle);
    return session;
  }

  function signOut(why) {
    stopPolling = true;
    if (session) { api("POST", "/msg/logout").catch(function () { /* best effort */ }); }
    session = null;
    identity = null;
    convKeys = {};
    conversations = [];
    messages = {};
    openConv = null;
    cursor = 0;
    if (why) ui.toast(String(why).toUpperCase(), "warn");
    render();
  }

  /* ---- conversation keys --------------------------------------- */
  async function keyFor(conv, epoch) {
    epoch = epoch || conv.keyEpoch || 1;
    convKeys[conv.id] = convKeys[conv.id] || {};
    if (convKeys[conv.id][epoch]) return convKeys[conv.id][epoch];

    /* Only the current epoch's key is on the server — older ones are
       gone the moment a rotation happens. A message from before a
       rotation is unreadable and says so; that is the cost of
       rotation being real. */
    if (epoch !== (conv.keyEpoch || 1)) return null;
    if (!conv.myKey) return null;
    var k = await mc.openSealed(conv.myKey, identity);
    convKeys[conv.id][epoch] = k;
    return k;
  }

  async function loadConversations() {
    var out = await api("GET", "/msg/conv");
    conversations = out.conversations || [];
    return conversations;
  }

  async function loadDirectory() {
    var out = await api("GET", "/msg/users");
    directory = out.users || [];
    /* The relay publishes its own moderator list rather than the
       client inferring it from the directory: a moderator configured
       but not yet registered has no directory row, and inferring
       would silently build an escrow that /msg/report then rejects. */
    /* The tier is re-read here because an admin can change it while
       this session is open, and a guest should not have to sign out
       and in again to find out they were approved. */
    if (session && out.tier) {
      session.tier = out.tier;
      session.moderator = !!out.moderator;
      session.root = !!out.root;
    }
    moderators = out.moderators || directory.filter(function (u) { return u.moderator; })
      .map(function (u) { return u.handle; });
    return directory;
  }

  function byHandle(h) {
    return directory.filter(function (u) { return u.handle === h; })[0] || null;
  }

  /* ---- creating a conversation --------------------------------- */
  async function startConversation(handles, name) {
    var members = handles.map(function (h) { return String(h).toLowerCase(); });
    if (members.indexOf(session.handle) < 0) members.push(session.handle);

    var convKey = await mc.newConversationKey();
    var keys = {};
    for (var i = 0; i < members.length; i++) {
      var who = byHandle(members[i]);
      if (!who) throw new Error("no such person: " + members[i]);
      keys[members[i]] = await mc.sealTo(convKey, who.pubKey);
    }

    var out = await api("POST", "/msg/conv", {
      kind: members.length === 2 ? "dm" : "group",
      members: members, name: name || "", keys: keys
    });
    await loadConversations();
    return out.id;
  }

  /* ---- sending and receiving ----------------------------------- */
  async function send(conv, text) {
    var key = await keyFor(conv);
    if (!key) throw new Error("this conversation's key could not be opened");
    var ct = await mc.sealMessage(key, { text: text, at: new Date().toISOString() });
    await api("POST", "/msg/send", { convId: conv.id, ct: ct });
  }

  async function absorb(list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var conv = conversations.filter(function (c) { return c.id === m.conv; })[0];
      if (!conv) continue;

      messages[m.conv] = messages[m.conv] || [];
      if (messages[m.conv].some(function (x) { return x.id === m.id; })) continue;

      var row = { id: m.id, from: m.from, at: m.at, seq: m.seq, ok: false, text: "" };
      try {
        var key = await keyFor(conv, m.epoch);
        if (!key) {
          /* Named rather than blank. "This is from before the key was
             changed" is a fact about the conversation, not a bug, and
             a silent gap would look like lost messages. */
          row.text = "[sealed under an older key — unreadable since the key was rotated]";
        } else {
          var payload = await mc.openMessage(key, m.ct);
          row.text = String(payload.text == null ? "" : payload.text);
          row.ok = true;
        }
      } catch (e) {
        row.text = e.message === "WRONG_KEY"
          ? "[could not be opened with this conversation's key]"
          : "[unreadable]";
      }
      messages[m.conv].push(row);
      if (m.seq > cursor) cursor = m.seq;
    }
    Object.keys(messages).forEach(function (id) {
      messages[id].sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
    });
  }

  /* Long poll. One request parked at a time, re-armed on return —
     an ordinary GET on 443 through the tunnel that already works,
     rather than a WebSocket on a port a filter has never seen. */
  async function pollLoop() {
    if (polling) return;
    polling = true;
    stopPolling = false;
    while (!stopPolling && session) {
      var started = Date.now();
      try {
        var out = await api("GET", "/msg/poll?since=" + cursor, undefined, { timeout: 40000 });
        if (!session) break;
        if (out && out.messages && out.messages.length) {
          await absorb(out.messages);
          renderThread();
          renderList();
          var unread = out.messages.filter(function (m) { return m.from !== session.handle; });
          if (unread.length && (!openConv || unread.some(function (m) { return m.conv !== openConv; }))) {
            ui.toast(unread.length + " NEW MESSAGE" + (unread.length > 1 ? "S" : ""), "info");
          }
        } else if (out && typeof out.cursor === "number" && out.cursor > cursor) {
          /* Something changed that is not a message — a new
             conversation, or a rotation. Reload rather than sit on a
             stale member list. */
          cursor = out.cursor;
          await loadConversations();
          renderList();
        }
      } catch (e) {
        if (!session) break;
        /* A poll that fails must not spin. Back off and keep the
           panel usable; the relay being briefly unreachable is the
           normal condition on a school network, not an error state
           worth shouting about. */
        await new Promise(function (r) { setTimeout(r, 5000); });
      }

      /* A floor between requests. The real relay parks for ~30s with
         nothing to say, so this normally costs nothing — but a relay
         that answers instantly every time, whether misconfigured or
         failing fast behind a proxy that returns 200, would otherwise
         spin this loop as hard as the machine allows. On a laptop
         running off a USB stick that is a flat battery, not a
         slowdown. */
      var spent = Date.now() - started;
      if (spent < MIN_POLL_GAP) {
        await new Promise(function (r) { setTimeout(r, MIN_POLL_GAP - spent); });
      }
    }
    polling = false;
  }

  /* ---- reporting ------------------------------------------------
     The confirmation is the feature. Someone filing a report is
     handing their whole conversation to a moderator, and finding
     that out afterwards would be a betrayal rather than a policy. */
  async function reportConversation(conv, against, reason) {
    var key = await keyFor(conv);
    if (!key) throw new Error("this conversation's key could not be opened, so it cannot be reported");

    /* Re-read rather than trusting what was loaded at sign-in: the
       moderator list is the one thing here that must be current, and
       a stale copy would build an escrow missing whoever was added
       since. */
    await loadDirectory();
    if (!moderators.length) {
      throw new Error("this relay has no moderators configured, so nobody could open the report");
    }

    var escrow = {};
    for (var i = 0; i < moderators.length; i++) {
      var mod = byHandle(moderators[i]);
      if (!mod || !mod.pubKey) {
        throw new Error("moderator '" + moderators[i] + "' has no account on this relay yet, " +
          "so the report could not be sealed to them. Nothing was sent.");
      }
      escrow[mod.handle] = await mc.sealTo(key, mod.pubKey);
    }

    return api("POST", "/msg/report", {
      convId: conv.id, against: against || null, reason: reason, escrow: escrow
    });
  }

  async function rotateKey(conv) {
    var fresh = await mc.newConversationKey();
    var keys = {};
    for (var i = 0; i < conv.members.length; i++) {
      var who = byHandle(conv.members[i]);
      if (!who) throw new Error("cannot rotate: no public key for " + conv.members[i]);
      keys[conv.members[i]] = await mc.sealTo(fresh, who.pubKey);
    }
    await api("POST", "/msg/rotate", { convId: conv.id, keys: keys });
    delete convKeys[conv.id];
    await loadConversations();
  }

  /* ============================================================
     UI
     ============================================================ */
  function render() {
    if (!nodes.root) return;
    ui.clear(nodes.root);
    if (!mc || !mc.available()) return renderNoCrypto();
    if (!relayBase()) return renderNoRelay();
    if (!session) return renderSignIn();
    renderMain();
  }

  function renderNoCrypto() {
    nodes.root.appendChild(el("div", { class: "mg-empty" }, [
      el("div", { class: "mg-empty-h", text: "MESSAGING CANNOT RUN HERE" }),
      el("div", { class: "mg-empty-p", text:
        "crypto.subtle is unavailable on this origin, and every message is sealed before it " +
        "leaves. Nothing here would be private without it, so it does not run rather than " +
        "pretending to." })
    ]));
  }

  function renderNoRelay() {
    nodes.root.appendChild(el("div", { class: "mg-empty" }, [
      el("div", { class: "mg-empty-h", text: "NO RELAY CONFIGURED" }),
      el("div", { class: "mg-empty-p", text:
        "Messages live on your relay. Set its address in SETTINGS, then come back." })
    ]));
  }

  function renderSignIn() {
    var handle = el("input", { class: "mg-input", type: "text", placeholder: "handle",
      value: ctx.settings.get("msgHandle") || "" });
    var pw = el("input", { class: "mg-input", type: "password", placeholder: "password" });
    var name = el("input", { class: "mg-input", type: "text", placeholder: "display name (optional)" });
    var busy = false;

    async function go(fn, label) {
      if (busy) return;
      busy = true;
      var note = nodes.signinNote;
      note.textContent = label + "... deriving your key, this takes a moment";
      note.className = "mg-note";
      try {
        await fn();
        await loadDirectory();
        await loadConversations();
        render();
        pollLoop();
      } catch (e) {
        note.textContent = e.message === "WRONG_PASSWORD"
          ? "That password does not open your key. There is no reset — the key is sealed under it."
          : e.message;
        note.className = "mg-note bad";
      } finally { busy = false; }
    }

    var note = el("div", { class: "mg-note" });
    nodes.signinNote = note;

    nodes.root.appendChild(el("div", { class: "mg-signin" }, [
      el("div", { class: "mg-empty-h", text: "MESSAGES" }),
      el("div", { class: "mg-empty-p", text:
        "A separate account from your vault, on your relay. Messages are sealed on this " +
        "machine and the relay never sees your password or what you write." }),
      handle, pw, name,
      el("div", { class: "mg-actions" }, [
        ui.button("SIGN IN", function () {
          go(function () { return signIn(handle.value.trim().toLowerCase(), pw.value); }, "SIGNING IN");
        }),
        ui.button("CREATE ACCOUNT", function () {
          go(function () {
            return signUp(handle.value.trim().toLowerCase(), pw.value, name.value.trim());
          }, "CREATING");
        })
      ]),
      note,
      el("div", { class: "mg-warn", text:
        "There is no password reset. Your private key is sealed under it, and the relay " +
        "cannot open it — that is the point. Lose the password and the account's history " +
        "goes with it." })
    ]));
  }

  function renderMain() {
    var list = el("div", { class: "mg-list" });
    var thread = el("div", { class: "mg-thread" });
    nodes.list = list;
    nodes.thread = thread;

    nodes.root.appendChild(el("div", { class: "mg-wrap" }, [
      el("div", { class: "mg-bar" }, [
        el("span", { class: "mg-me", text: session.handle +
          (session.moderator ? "  [ADMIN]"
            : session.tier === "guest" ? "  [GUEST — NOT APPROVED YET]" : "") }),
        ui.button("NEW", promptNewConversation),
        session.moderator ? ui.button("REPORTS", openReports) : el("span"),
        session.moderator ? ui.button("PEOPLE", openPeople) : el("span"),
        ui.button("SIGN OUT", function () { signOut(); })
      ]),
      el("div", { class: "mg-cols" }, [list, thread])
    ]));

    renderList();
    renderThread();
  }

  function renderList() {
    if (!nodes.list) return;
    ui.clear(nodes.list);
    if (!conversations.length) {
      nodes.list.appendChild(el("div", { class: "mg-none", text: "NO CONVERSATIONS YET" }));
      return;
    }
    conversations.forEach(function (c) {
      var others = c.members.filter(function (h) { return h !== session.handle; });
      var label = c.kind === "group" ? (c.name || others.join(", ")) : others[0];
      var last = (messages[c.id] || [])[(messages[c.id] || []).length - 1];
      var row = el("div", { class: "mg-conv" + (openConv === c.id ? " sel" : "") }, [
        el("span", { class: "mg-conv-name", text: (c.kind === "group" ? "# " : "") + label }),
        el("span", { class: "mg-conv-last",
          text: last ? (last.from + ": " + last.text).slice(0, 44) : "no messages yet" })
      ]);
      row.addEventListener("click", function () { openConv = c.id; renderList(); renderThread(); });
      nodes.list.appendChild(row);
    });
  }

  function renderThread() {
    if (!nodes.thread) return;
    ui.clear(nodes.thread);
    var conv = conversations.filter(function (c) { return c.id === openConv; })[0];
    if (!conv) {
      nodes.thread.appendChild(el("div", { class: "mg-none", text: "PICK A CONVERSATION" }));
      return;
    }

    var head = el("div", { class: "mg-head" }, [
      el("span", { text: conv.members.join(", ") }),
      el("span", { class: "mg-epoch", text: "key #" + (conv.keyEpoch || 1) })
    ]);

    var body = el("div", { class: "mg-msgs" });
    (messages[conv.id] || []).forEach(function (m) {
      body.appendChild(el("div", { class: "mg-msg" + (m.from === session.handle ? " mine" : "") +
        (m.ok ? "" : " bad") }, [
        el("span", { class: "mg-from", text: m.from }),
        el("span", { class: "mg-text", text: m.text }),
        el("span", { class: "mg-at", text: String(m.at || "").slice(11, 16) })
      ]));
    });

    var input = el("input", { class: "mg-input mg-send", type: "text",
      placeholder: "message" });
    async function fire() {
      var t = input.value.trim();
      if (!t) return;
      input.value = "";
      try { await send(conv, t); }
      catch (e) { ui.toast("NOT SENT — " + e.message, "fail"); input.value = t; }
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") fire(); });

    nodes.thread.appendChild(head);
    nodes.thread.appendChild(body);
    nodes.thread.appendChild(el("div", { class: "mg-compose" }, [
      input, ui.button("SEND", fire)
    ]));
    nodes.thread.appendChild(el("div", { class: "mg-tools" }, [
      ui.button("REPORT", function () { promptReport(conv); }, { danger: true }),
      ui.button("ROTATE KEY", function () { promptRotate(conv); })
    ]));
    body.scrollTop = body.scrollHeight;
  }

  /* There is no ui.modal — the shared widget set stops at buttons and
     panels. Rather than inventing one globally for three callers,
     this puts an overlay inside the module's own root, which also
     means it disappears with the window instead of outliving it. */
  function overlay(children) {
    var box = el("div", { class: "mg-modal" }, children);
    var over = el("div", { class: "mg-overlay" }, [box]);
    over.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    nodes.root.appendChild(over);
    function close() { if (over.parentNode) over.parentNode.removeChild(over); }
    return { box: box, close: close };
  }

  function promptNewConversation() {
    var pick = el("select", { class: "mg-input mg-pick", multiple: true, size: 10 });
    directory.filter(function (u) { return u.handle !== session.handle; }).forEach(function (u) {
      pick.appendChild(el("option", { value: u.handle,
        text: u.handle +
          (u.displayName && u.displayName !== u.handle ? "  (" + u.displayName + ")" : "") +
          (u.moderator ? "  [moderator]" : "") +
          (u.banned ? "  [banned]" : "") }));
    });

    var name = el("input", { class: "mg-input", type: "text", placeholder: "group name (optional)" });
    var fp = el("div", { class: "mg-note", text:
      "Pick one person for a DM, or several for a group. Hold Ctrl to pick more than one." });

    /* The fingerprint is the only defence against a relay that hands
       out the wrong public key, so it is shown at the moment you
       choose someone rather than buried in a details pane. */
    pick.addEventListener("change", async function () {
      var chosen = selected();
      if (chosen.length !== 1) {
        fp.textContent = chosen.length + " selected";
        return;
      }
      var u = byHandle(chosen[0]);
      try {
        fp.textContent = chosen[0] + "'s key fingerprint: " + await mc.fingerprint(u.pubKey) +
          "  — read it to them out loud to be sure it is really them";
      } catch (e) { fp.textContent = "fingerprint unavailable"; }
    });

    /* children rather than .options: the options are appended
       directly here with no optgroups, so the two are the same list,
       and children is the one that exists on anything DOM-shaped. */
    function selected() {
      return Array.prototype.filter.call(pick.children, function (o) { return o.selected; })
        .map(function (o) { return o.value; });
    }

    var o = overlay([
      el("div", { class: "mg-empty-h", text: "NEW CONVERSATION" }),
      pick, fp, name,
      el("div", { class: "mg-actions" }, [
        ui.button("START", async function () {
          var chosen = selected();
          if (!chosen.length) return ui.toast("PICK SOMEONE", "warn");
          try {
            openConv = await startConversation(chosen, name.value.trim());
            renderList(); renderThread();
            o.close();
          } catch (e) { ui.toast("COULD NOT START — " + e.message, "fail"); }
        }, { primary: true }),
        ui.button("CANCEL", function () { o.close(); })
      ])
    ]);
  }

  /* The four things a reporter has to know BEFORE they send, not
     after. Written out rather than summarised, because every one of
     them is a surprise if you find out later. */
  var REPORT_WARNING = [
    "Filing this report gives the moderators the key to this whole conversation.",
    "",
    "  1. They will be able to read EVERY message in it, including yours.",
    "  2. When they mark it resolved, that access ends — but they will already",
    "     have read whatever they read. Resolving cannot undo that.",
    "  3. For that reason the conversation key is changed afterwards, so what",
    "     they held stops working on anything sent from then on.",
    "  4. The outcome is recorded: a temporary ban, a permanent one, or nothing.",
    "",
    "You can only report a conversation you are part of."
  ].join("\n");

  function promptReport(conv) {
    var against = el("select", { class: "mg-input" });
    var others = conv.members.filter(function (h) { return h !== session.handle; });
    others.forEach(function (h) {
      against.appendChild(el("option", { value: h, text: h }));
    });
    /* Set rather than left to the browser's implicit "first option
       wins". A report that names nobody is a report a moderator has
       to guess at, and depending on an implicit default for that is
       how it would happen. */
    if (others.length) against.value = others[0];
    var why = el("textarea", { class: "mg-input", rows: 3,
      placeholder: "what happened (the moderators read this first)" });

    var who = el("div", { class: "mg-note", text: moderators.length
      ? "It will be readable by: " + moderators.join(", ")
      : "This relay has no moderators configured — a report could not be opened by anyone." });

    var o = overlay([
      el("div", { class: "mg-empty-h", text: "REPORT THIS CONVERSATION" }),
      el("pre", { class: "mg-warnbox", text: REPORT_WARNING }),
      who,
      el("div", { class: "mg-note", text: "Who is this about?" }), against,
      why,
      el("div", { class: "mg-actions" }, [
        ui.button("SEND REPORT", async function () {
          if (!why.value.trim()) return ui.toast("SAY WHAT HAPPENED FIRST", "warn");
          try {
            await reportConversation(conv, against.value, why.value.trim());
            ui.toast("REPORT FILED", "ok");
            o.close();
          } catch (e) { ui.toast("NOT FILED — " + e.message, "fail"); }
        }, { danger: true }),
        ui.button("CANCEL", function () { o.close(); })
      ])
    ]);
  }

  function promptRotate(conv) {
    var o = overlay([
      el("div", { class: "mg-empty-h", text: "CHANGE THIS CONVERSATION'S KEY" }),
      el("pre", { class: "mg-warnbox", text:
        "Everyone in the conversation gets a new key.\n\n" +
        "Messages already sent stay readable to whoever could already read them —\n" +
        "including a moderator who reviewed a report. What changes is that anything\n" +
        "sent from now on is sealed under a key they do not have.\n\n" +
        "Messages already on your screen stay on it. But the old key is not kept\n" +
        "anywhere — not here and not on the relay — so the next time you sign in,\n" +
        "everything sent before this point will show as unreadable and stay that\n" +
        "way. That is the cost of the cut-off being real.\n\n" +
        "Do this after a report is resolved. Otherwise revoking access means nothing." }),
      el("div", { class: "mg-actions" }, [
        ui.button("CHANGE THE KEY", async function () {
          try { await rotateKey(conv); ui.toast("KEY CHANGED", "ok"); renderThread(); o.close(); }
          catch (e) { ui.toast("NOT CHANGED — " + e.message, "fail"); }
        }),
        ui.button("CANCEL", function () { o.close(); })
      ])
    ]);
  }

  async function openReports() {
    var o = overlay([]);
    var box = o.box, close = o.close;

    box.appendChild(el("div", { class: "mg-empty-h", text: "MODERATION" }));
    box.appendChild(el("div", { class: "mg-note", text: "loading..." }));

    try {
      var rep = await api("GET", "/msg/reports");
      var signins = await api("GET", "/msg/signins").catch(function () { return { alerts: [] }; });
      ui.clear(box);
      box.appendChild(el("div", { class: "mg-empty-h", text: "MODERATION" }));

      if (signins.alerts && signins.alerts.length) {
        box.appendChild(el("div", { class: "mg-alerts" },
          [el("div", { class: "mg-empty-h", text: "SIGN-IN ALERTS" })].concat(
            signins.alerts.map(function (a) {
              return el("div", { class: "mg-alert",
                text: a.handle + " — " + a.why + " (from " + a.sources + " source(s))" });
            }))));
      }

      var open = (rep.reports || []).filter(function (r) { return r.status === "open"; });
      if (!open.length) box.appendChild(el("div", { class: "mg-none", text: "NOTHING OPEN" }));

      open.forEach(function (r) {
        box.appendChild(el("div", { class: "mg-report" }, [
          el("div", { class: "mg-conv-name",
            text: r.by + " reported " + (r.against || "the conversation") }),
          el("div", { class: "mg-note", text: r.reason }),
          el("div", { class: "mg-actions" }, [
            ui.button("READ IT", function () { reviewReport(r, box); }),
            ui.button("NO ACTION", function () { resolve(r, "none"); }),
            ui.button("SUSPEND 7d", function () { resolve(r, "tempban", 7); }, { danger: true }),
            ui.button("BAN", function () { resolve(r, "ban"); }, { danger: true })
          ])
        ]));
      });

      box.appendChild(ui.button("CLOSE", close));
    } catch (e) {
      ui.clear(box);
      box.appendChild(el("div", { class: "mg-note bad", text: e.message }));
      box.appendChild(ui.button("CLOSE", close));
    }

    async function resolve(r, action, days) {
      try {
        var out = await api("POST", "/msg/resolve",
          { reportId: r.id, action: action, against: r.against, days: days });
        ui.toast("RESOLVED — " + action.toUpperCase(), "ok");
        if (out.rotate) {
          ui.toast("THE MEMBERS SHOULD NOW CHANGE THAT CONVERSATION'S KEY", "warn");
        }
        close();
      } catch (e) { ui.toast("NOT RESOLVED — " + e.message, "fail"); }
    }
  }

  /* Who is on this relay and what they are allowed to use. Admins
     only — the relay refuses everyone else, this just does not offer
     the button.

     An admin can approve an account, or make it an admin. Taking
     admin AWAY is offered only to an admin named in config.json; the
     relay enforces that, and the button is hidden here so nobody is
     shown something that would only ever answer no. */
  async function openPeople() {
    var o = overlay([]);
    var box = o.box, close = o.close;

    async function act(handle, action, sure) {
      if (sure && !window.confirm(sure)) return;
      try {
        await api("POST", "/msg/role", { handle: handle, action: action });
        ui.toast(handle.toUpperCase() + " — " + action.toUpperCase() + "D", "ok");
        /* The moderator list is what reports are sealed to, so it
           has to be re-read the moment it changes. */
        loadDirectory().catch(function () { /* next poll gets it */ });
        draw();
      } catch (e) { ui.toast("NOT CHANGED — " + e.message, "fail"); }
    }

    function buttonsFor(p, out) {
      if (p.handle === session.handle || p.root) return [];
      var b = [];
      if (p.tier === "guest" && !p.banned) {
        b.push(ui.button("APPROVE", function () { act(p.handle, "approve"); }));
      }
      if (p.tier === "member") {
        b.push(ui.button("MAKE ADMIN", function () {
          act(p.handle, "promote", "Make " + p.handle + " an admin?\n\n" +
            "They will be able to read reported conversations, ban people, approve " +
            "accounts and make other admins. Only an admin named in the relay's " +
            "config can take this away again.");
        }));
        if (out.requireApproval) {
          b.push(ui.button("UNAPPROVE", function () { act(p.handle, "unapprove"); }, { danger: true }));
        }
      }
      if (p.tier === "admin" && out.root) {
        b.push(ui.button("REMOVE ADMIN", function () {
          act(p.handle, "demote", "Remove admin from " + p.handle + "?");
        }, { danger: true }));
      }
      return b;
    }

    async function draw() {
      ui.clear(box);
      box.appendChild(el("div", { class: "mg-empty-h", text: "PEOPLE" }));
      try {
        var out = await api("GET", "/msg/people");
        var waiting = out.people.filter(function (p) { return p.tier === "guest" && !p.banned; });
        box.appendChild(el("div", { class: "mg-note", text: !out.requireApproval
          ? "This relay does not require approval: every account is a member."
          : waiting.length ? waiting.length + " account(s) waiting for approval."
          : "Nobody is waiting for approval." }));

        /* The ones needing a decision first, then everyone else. */
        var order = { guest: 0, member: 1, admin: 2 };
        out.people.sort(function (a, b) {
          return (order[a.tier] - order[b.tier]) || a.handle.localeCompare(b.handle);
        }).forEach(function (p) {
          var tag = p.tier.toUpperCase() + (p.root ? " (CONFIG)" : "") +
            (p.banned ? "  BANNED" : "") + (p.handle === session.handle ? "  (YOU)" : "");
          box.appendChild(el("div", { class: "mg-report" }, [
            el("div", { class: "mg-conv-name", text: p.handle + "  [" + tag + "]" }),
            el("div", { class: "mg-note", text: p.displayName +
              (p.approved ? "  ·  approved by " + p.approved.by : "") +
              (p.madeAdmin ? "  ·  made admin by " + p.madeAdmin.by : "") }),
            el("div", { class: "mg-actions" }, buttonsFor(p, out))
          ]));
        });

        if (out.audit && out.audit.length) {
          box.appendChild(el("div", { class: "mg-empty-h", text: "RECENT CHANGES" }));
          out.audit.slice(0, 12).forEach(function (a) {
            box.appendChild(el("div", { class: "mg-alert",
              text: String(a.at).slice(0, 16).replace("T", " ") + "  " + a.by + "  " +
                a.action + "  " + a.target }));
          });
        }
      } catch (e) {
        box.appendChild(el("div", { class: "mg-note bad", text: e.message }));
      }
      box.appendChild(ui.button("CLOSE", close));
    }

    draw();
  }

  /* A moderator reads a reported conversation by decrypting it here.
     The relay hands over ciphertext and an escrowed key; it never
     decrypted anything to serve this. */
  async function reviewReport(r, box) {
    try {
      var out = await api("GET", "/msg/review?report=" + r.id);
      if (!out.key) throw new Error("no escrowed key for you on this report");
      var convKey = await mc.openSealed(out.key, identity);

      var pane = el("div", { class: "mg-msgs" });
      for (var i = 0; i < (out.messages || []).length; i++) {
        var m = out.messages[i];
        var text;
        try { text = (await mc.openMessage(convKey, m.ct)).text; }
        catch (e) { text = "[sealed under a different key — sent after a rotation]"; }
        pane.appendChild(el("div", { class: "mg-msg" }, [
          el("span", { class: "mg-from", text: m.from }),
          el("span", { class: "mg-text", text: text }),
          el("span", { class: "mg-at", text: String(m.at || "").slice(0, 16) })
        ]));
      }
      box.appendChild(el("div", { class: "mg-review" }, [
        el("div", { class: "mg-empty-h", text: "REPORTED CONVERSATION" }),
        pane
      ]));
    } catch (e) { ui.toast("COULD NOT OPEN — " + e.message, "fail"); }
  }

  /* ---- selfcheck ------------------------------------------------ */
  function selfcheck() {
    return [
      { name: "CRYPTO IS PRESENT", critical: true, run: async function () {
        if (!mc) throw new Error("the msgCrypto service is missing from this build");
        if (!mc.available()) throw new Error("SKIPPED — crypto.subtle is unavailable on this origin");
        return "sealing is possible here";
      } },
      /* The property this whole module exists to keep, checked by
         actually running a sign-up against a stubbed fetch and
         looking at what it tried to send. A source-reading version of
         this probe would pass on code that builds the body a
         different way; this one cannot. */
      { name: "THE PASSWORD NEVER REACHES THE RELAY", critical: true, run: async function () {
        if (!mc.available()) throw new Error("SKIPPED — no crypto.subtle here");
        if (!relayBase()) throw new Error("SKIPPED — no relay is configured to send to");

        var marker = "probe-pw-" + Math.random().toString(36).slice(2) + "-neverleaves";
        var sent = [];
        var realFetch = window.fetch;
        var saved = {
          session: session, identity: identity,
          handle: ctx.settings.get("msgHandle") || ""
        };

        window.fetch = function (url, opts) {
          sent.push({ url: String(url), body: String((opts && opts.body) || ""),
            headers: JSON.stringify((opts && opts.headers) || {}) });
          return Promise.resolve({
            ok: true, status: 201,
            text: function () {
              return Promise.resolve(JSON.stringify({ handle: "probe", token: "probe-token" }));
            }
          });
        };

        try {
          await signUp("probe", marker, "probe");
        } catch (e) {
          /* A throw before the request is fine — nothing was sent. A
             throw after is not, and the assertions below still run. */
        } finally {
          window.fetch = realFetch;
          session = saved.session;
          identity = saved.identity;
          /* Restored to whatever it was; "" where it was unset, which
             is how the sign-in field already treats a missing value. */
          ctx.settings.set("msgHandle", saved.handle);
        }

        /* Every request caught in the window is checked, not just the
           registration: the poll loop is running at the same time and
           a leak down that route would count just as much. */
        if (!sent.length) throw new Error("sign-up sent nothing at all — the probe proved nothing");
        sent.forEach(function (r) {
          if (r.body.indexOf(marker) >= 0) {
            throw new Error("the password appeared in a request body to " + r.url);
          }
          if (r.headers.indexOf(marker) >= 0) {
            throw new Error("the password appeared in a request header to " + r.url);
          }
          if (r.url.indexOf(marker) >= 0) {
            throw new Error("the password appeared in a URL");
          }
        });

        var reg = sent.filter(function (r) { return /\/msg\/register$/.test(r.url); })[0];
        if (!reg) throw new Error("sign-up never reached /msg/register — the probe proved nothing");
        if (reg.body.indexOf("authSecret") < 0) {
          throw new Error("no derived auth secret was sent — sign-up is not doing the derivation");
        }
        return "sign-up sent " + sent.length + " request(s) and the password was in none of them; " +
          "the registration carried the derived secret instead";
      } },

      /* Two copies of one rule drift. This is the cheap way to notice
         before a user waits through a 600k-iteration derivation only
         to be handed a 400 by the relay. */
      { name: "THE HANDLE RULE MATCHES THE RELAY'S", critical: false, run: async function () {
        [["ab", false], ["abc", true], ["a".repeat(24), true], ["a".repeat(25), false],
         ["Alice", false], ["a b", false], ["a.b_c-d", true], ["", false]].forEach(function (c) {
          if (HANDLE_RE.test(c[0]) !== c[1]) {
            throw new Error("the handle rule disagrees on " + JSON.stringify(c[0]));
          }
        });
        return "3-24, lowercase, and . _ - only — the same rule the relay enforces";
      } },
      { name: "A MESSAGE ROUND-TRIPS SEALED", critical: true, run: async function () {
        if (!mc.available()) throw new Error("SKIPPED — no crypto.subtle here");
        var k = await mc.newConversationKey();
        var marker = "probe-" + Math.random().toString(36).slice(2);
        var sealed = await mc.sealMessage(k, { text: marker });
        if (sealed.indexOf(marker) >= 0) throw new Error("the plaintext is visible in the sealed form");
        var back = await mc.openMessage(k, sealed);
        if (back.text !== marker) throw new Error("round trip changed the message");
        return "sealed, sent-shaped, and opened again";
      } },
      { name: "THE REPORT WARNING SAYS ALL FOUR THINGS", critical: false, run: async function () {
        [/read EVERY message/i, /cannot undo/i, /key is changed/i, /outcome is recorded/i]
          .forEach(function (re, i) {
            if (!re.test(REPORT_WARNING)) throw new Error("point " + (i + 1) + " is missing");
          });
        return "the consequences are stated before the report is sent";
      } },
      { name: "SESSION STATE IS NOT PERSISTED", critical: true, run: async function () {
        /* The token and the unwrapped private key must die with the
           tab. A drive left in a school PC should not carry a live
           session, and the drive profile must not carry one to the
           next machine either. */
        var s = String(signIn) + String(signUp) + String(signOut);
        if (/localStorage|sessionStorage|store\.put/.test(s)) {
          throw new Error("the sign-in path writes session state somewhere persistent");
        }
        /* The handle is the one thing that is allowed to be
           remembered — it is who you are, not proof of it. */
        var writes = s.match(/settings\.set\(\s*"([^"]+)"/g) || [];
        writes.forEach(function (w) {
          if (w.indexOf('"msgHandle"') < 0) {
            throw new Error("the sign-in path persists something other than the handle: " + w);
          }
        });
        if (session && session.token) {
          var profile = FieldKit.service("driveProfile");
          if (profile && profile.PORTABLE && profile.PORTABLE.indexOf("msgToken") >= 0) {
            throw new Error("the session token is listed as portable — it would ride the drive");
          }
        }
        return "token and private key live in memory only; only the handle is remembered";
      } }
    ];
  }

  /* A service as well as a module, and a deliberately narrow one.

     OUTPOST has no vault, so a messaging session is the only thing
     a guest can prove — and BROWSER needs a credential. Rather than
     handing out the session token for someone else to put in a URL,
     this does the exchange and returns only the ticket. Same
     reasoning as transportRelay.browseTicket(). */
  FieldKit.provide("messages", {
    signedIn: function () { return !!(session && session.token); },
    handle: function () { return session ? session.handle : null; },
    isModerator: function () { return !!(session && session.moderator); },
    /* guest, member or admin. RUNNER reads this to decide what to
       offer; the relay decides what is actually allowed. */
    tier: function () { return session ? session.tier : null; },
    browseTicket: async function () {
      if (!session) throw new Error("not signed in to MESSAGES");
      return api("POST", "/browse/ticket");
    },
    /* And the streamed one. The account IS the browser session on
       that side — your cookies, your history — which is what makes
       one sign-in serve both apps. */
    streamTicket: async function () {
      if (!session) throw new Error("not signed in to MESSAGES");
      return api("POST", "/browser/ticket");
    },
    /* The browser's USAGE readout; the relay answers admins only. */
    browserUsage: async function () {
      if (!session) throw new Error("not signed in to MESSAGES");
      return api("GET", "/browser/usage");
    },
    /* RUNNER's. The relay signs who this account is and what tier,
       and says where the run server is; the panel takes that
       straight there. Same reasoning as the two above: the
       session token stays in this module. */
    runnerTicket: async function () {
      if (!session) throw new Error("not signed in to MESSAGES");
      return api("POST", "/runner/ticket");
    },
    /* RUNNER, when the run server is asleep (RUNNER_PLAN.md §24). */
    runnerWake: async function () {
      if (!session) throw new Error("not signed in to MESSAGES");
      return api("POST", "/runner/wake");
    }
  });

  FieldKit.register("messages", {
    title: "MESSAGES",
    icon: "✉",
    group: "ONLINE",
    about: "End-to-end encrypted chat with the people on your relay",
    keywords: "chat dm talk friends message inbox people approve accounts",
    width: 860,
    height: 620,
    guestSafe: false,
    selfcheck: selfcheck,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      mc = FieldKit.service("msgCrypto");
      injectCSS();
      nodes.root = el("div", { class: "mg-root" });
      host.appendChild(nodes.root);
      render();
      if (session) pollLoop();
    },

    unmount() {
      stopPolling = true;
      nodes = {};
    }
  });

  function injectCSS() {
    if (document.getElementById("mg-style")) return;
    var s = document.createElement("style");
    s.id = "mg-style";
    s.textContent = [
      ".mg-root{height:100%;display:flex;flex-direction:column;position:relative}",
      ".mg-wrap{display:flex;flex-direction:column;height:100%;gap:6px}",
      ".mg-bar{display:flex;gap:6px;align-items:center;padding-bottom:6px;",
      "  border-bottom:1px solid var(--line)}",
      ".mg-me{flex:1;font-size:11px;letter-spacing:.14em;color:var(--accent)}",
      ".mg-cols{display:flex;gap:8px;flex:1;min-height:0}",
      ".mg-list{width:210px;flex:none;overflow:auto;border-right:1px solid var(--line)}",
      ".mg-thread{flex:1;display:flex;flex-direction:column;min-width:0}",
      ".mg-conv{padding:7px 6px;border-bottom:1px solid var(--line);cursor:pointer}",
      ".mg-conv.sel{background:rgba(var(--accent-glow),.10)}",
      ".mg-conv-name{display:block;font-size:11px;letter-spacing:.1em;color:var(--fg)}",
      ".mg-conv-last{display:block;font-size:10px;color:var(--fg-dimmer);margin-top:2px}",
      ".mg-head{display:flex;justify-content:space-between;font-size:10px;color:var(--fg-dim);",
      "  padding:4px 6px;border-bottom:1px solid var(--line)}",
      ".mg-epoch{color:var(--fg-dimmer)}",
      ".mg-msgs{flex:1;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:5px}",
      ".mg-msg{display:grid;grid-template-columns:90px 1fr 44px;gap:8px;font-size:11px;",
      "  align-items:baseline}",
      ".mg-msg.mine .mg-from{color:var(--accent)}",
      ".mg-msg.bad .mg-text{color:var(--warn);font-style:italic}",
      ".mg-from{color:var(--fg-dim);font-size:10px;overflow:hidden;text-overflow:ellipsis}",
      ".mg-text{color:var(--fg);white-space:pre-wrap;word-break:break-word}",
      ".mg-at{color:var(--fg-dimmer);font-size:9px;text-align:right}",
      ".mg-compose{display:flex;gap:6px;padding:6px 0}",
      ".mg-tools{display:flex;gap:6px;padding-bottom:4px}",
      ".mg-input{background:#0e1210;color:var(--fg);border:1px solid var(--line2);",
      "  padding:7px 9px;font:inherit;font-size:11px;flex:1;min-width:0}",
      ".mg-send{flex:1}",
      ".mg-pick{width:100%;min-height:170px}",
      "textarea.mg-input{resize:vertical;width:100%}",
      ".mg-signin{max-width:420px;margin:0 auto;display:flex;flex-direction:column;gap:8px;",
      "  padding-top:18px}",
      ".mg-actions{display:flex;gap:6px;flex-wrap:wrap}",
      ".mg-empty{padding:28px;text-align:center}",
      ".mg-empty-h{font-size:12px;letter-spacing:.2em;color:var(--accent);margin-bottom:6px}",
      ".mg-empty-p{font-size:11px;color:var(--fg-dim);line-height:1.6}",
      ".mg-none{padding:18px;text-align:center;font-size:10px;letter-spacing:.16em;",
      "  color:var(--fg-dimmer)}",
      ".mg-note{font-size:10px;color:var(--fg-dim);line-height:1.5}",
      ".mg-note.bad{color:var(--fail)}",
      ".mg-warn{font-size:10px;color:var(--warn);line-height:1.5;border:1px dashed var(--line2);",
      "  padding:8px}",
      ".mg-warnbox{font-size:10px;color:var(--warn);line-height:1.5;white-space:pre-wrap;",
      "  border:1px solid var(--fail);padding:10px;margin:0 0 8px}",
      ".mg-overlay{position:absolute;inset:0;background:rgba(0,0,0,.7);display:flex;",
      "  align-items:center;justify-content:center;z-index:20;padding:16px}",
      ".mg-modal{background:var(--bg2);border:1px solid var(--line2);padding:14px;",
      "  max-width:560px;width:100%;max-height:100%;overflow:auto;display:flex;",
      "  flex-direction:column;gap:8px}",
      ".mg-report{border-bottom:1px solid var(--line);padding:8px 0}",
      ".mg-alerts{border:1px solid var(--warn);padding:8px;margin-bottom:8px}",
      ".mg-alert{font-size:10px;color:var(--warn);padding:2px 0}",
      ".mg-review{border-top:1px solid var(--line);margin-top:8px;max-height:280px;overflow:auto}"
    ].join("\n");
    document.head.appendChild(s);
  }
})(window.FieldKit);
