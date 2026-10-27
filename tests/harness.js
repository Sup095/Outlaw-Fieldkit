/* ============================================================
   FieldKit test harness
   Loads core files into a minimal fake window so their logic can be
   exercised under Node.

   Deliberately not jsdom: the drive carries no dependencies, and
   these suites test logic, not layout. Full DOM-integration runs
   happen outside the drive with jsdom installed separately.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");

const ROOT = path.join(__dirname, "..");

/* ---- minimal DOM ---------------------------------------------- */
/* Every element node under `node`, not including it. */
function descendants(node) {
  const out = [];
  (function walk(n) {
    (n.children || []).forEach(function (c) {
      if (!c || c.nodeType === 3) return;
      out.push(c);
      walk(c);
    });
  })(node);
  return out;
}

/* A deliberately small selector engine: an optional tag, then any
   number of #id and .class parts on the same element, and comma
   lists of those. Enough to find things in a panel; not a browser.

   Compound class selectors were added when the window chrome grew
   `.fk-win-grip.e` and `.fk-win-grip.w` — before that, ".a.b" was
   read as one class literally named "a.b" and matched nothing, and
   a querySelector that silently returns null reads as a missing
   element rather than as a selector this engine cannot parse. */
function matches(node, sel) {
  if (!node || !sel) return false;
  return String(sel).split(",").some(function (part) {
    part = part.trim();
    if (!part) return false;

    var tag = (part.match(/^[a-zA-Z][\w-]*/) || [""])[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;

    var rest = part.slice(tag.length);
    if (!tag && !rest) return false;

    var classes = String(node.className || "").split(/\s+/);
    var bits = rest.match(/[.#][^.#]+/g) || [];
    if (!tag && !bits.length) return false;

    return bits.every(function (b) {
      var name = b.slice(1);
      if (!name) return false;
      if (b[0] === "#") return node.attributes && node.attributes.id === name;
      return classes.indexOf(name) >= 0;
    });
  });
}

function fakeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [], style: {}, dataset: {}, attributes: {},
    value: "", className: "",
    parentNode: null,
    appendChild(c) {
      if (c && c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
      this.children.push(c);
      if (c && typeof c === "object") c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c && typeof c === "object") c.parentNode = null;
      return c;
    },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    removeAttribute(k) { delete this.attributes[k]; },
    _listeners: null,
    addEventListener(type, fn) {
      if (!this._listeners) this._listeners = {};
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!this._listeners || !this._listeners[type]) return;
      const i = this._listeners[type].indexOf(fn);
      if (i >= 0) this._listeners[type].splice(i, 1);
    },
    dispatchEvent(ev) {
      const fns = (this._listeners && this._listeners[ev.type]) || [];
      fns.slice().forEach((fn) => fn.call(this, ev));
      return true;
    },
    querySelector(sel) { return descendants(this).find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(this).filter((n) => matches(n, sel)); },
    /* Node.contains: true for the node itself and any descendant.
       Guards that ask "did this event come from inside my overlay?"
       depend on it. */
    contains(other) {
      if (!other) return false;
      if (other === this) return true;
      return descendants(this).indexOf(other) >= 0;
    },
    /* Enough of a text field to exercise the copy paths. */
    focus() { fakeElement._active = this; },
    select() { this.selectionStart = 0; this.selectionEnd = (this.value || "").length; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    click() {
      if (typeof this.onclick === "function") this.onclick({ type: "click", target: this });
      this.dispatchEvent({ type: "click", target: this,
        preventDefault() {}, stopPropagation() {} });
    },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    getContext() { return null; },
    /* firstChild is what ui.clear() loops on — without it, clear()
       silently does nothing and panels appear to never redraw. */
    get firstChild() { return this.children.length ? this.children[0] : null; }
  };
  node.classList = Object.create(node.classList);
  node.classList._s = new Set();

  /* `src` and `srcdoc` REFLECT, the way the real DOM does: setting
     the property sets the attribute, and removeAttribute() clears
     the property with it.

     Without this the fake DOM cannot see the bug that made BROWSER
     do nothing at all. An <iframe> carrying a srcdoc attribute
     ignores src entirely, so the fix is removeAttribute("srcdoc")
     before navigating — and a fake element where the property and
     the attribute are unrelated reports that fix as working while
     leaving a stale .srcdoc that the module then checks. Modelling
     one detail of the real DOM is cheaper than every iframe test
     silently measuring the wrong object. */
  ["src", "srcdoc"].forEach(function (name) {
    Object.defineProperty(node, name, {
      configurable: true,
      enumerable: true,
      get() { return this.attributes[name]; },
      set(v) { this.attributes[name] = v; }
    });
  });

  /* textContent ADDS UP, the way a real one does.

     It used to be a plain string field, so a container with children
     reported "" no matter what was inside it. Anything checking what
     a panel actually says had to know that and walk the tree itself
     — modules/help.js carries a helper written for exactly this —
     and a check that did not know it passed by reading nothing and
     finding nothing wrong with it. That is the worst possible
     failure mode for an assertion about wording.

     Setting it clears the children, which is what the real one does
     and is the behaviour ui.clear() and every "reset this label"
     call depend on. Own text comes before child text, matching how
     ui.el() builds a node: attributes first, children appended
     after. */
  let _text = "";
  Object.defineProperty(node, "textContent", {
    configurable: true,
    enumerable: true,
    get() {
      if (!this.children.length) return _text;
      return _text + this.children.map(function (c) {
        return (c && c.textContent) || "";
      }).join("");
    },
    set(v) {
      _text = v === null || v === undefined ? "" : String(v);
      this.children.slice().forEach((c) => this.removeChild(c));
    }
  });

  return node;
}

function fakeDocument() {
  const byId = {};
  const doc = {
    head: fakeElement("head"),
    body: fakeElement("body"),
    documentElement: fakeElement("html"),
    createElement: (t) => fakeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById(id) {
      if (byId[id]) return byId[id];
      return descendants(doc.documentElement).concat(descendants(doc.body))
        .find((n) => n.attributes && n.attributes.id === id) || null;
    },
    querySelector(sel) {
      return descendants(doc.body).find((n) => matches(n, sel)) || null;
    },
    querySelectorAll(sel) {
      return descendants(doc.body).filter((n) => matches(n, sel));
    },
    get activeElement() { return fakeElement._active || null; },
    execCommand() { return false; },
    addEventListener() {}
  };
  doc.documentElement.style.setProperty = function (k, v) { this[k] = v; };
  return doc;
}

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear()
  };
}

/* ---- bootstrap ------------------------------------------------ */
/* Loads the given core files in order and returns window.FieldKit.
   Each file is a classic script that self-registers, exactly as it
   does in the browser. */
function bootstrap(files) {
  /* Real listener plumbing on window, not a no-op.

     It was a no-op for a long time, and that is precisely why a
     whole class of bug was invisible here: the command palette and
     the easter-egg watcher both bind to `window` with capture, and
     both sailed straight through the screen lock. Nothing in the
     suite could see it, because nothing dispatched.

     Registration order plus stopImmediatePropagation is all the
     semantics the app relies on — a capture listener registered by
     an earlier-loading file runs first and can halt the rest. */
  const winListeners = [];
  const win = {
    crypto: nodeCrypto.webcrypto,
    isSecureContext: true,
    location: { protocol: "file:", origin: "null", reload() { win.__reloaded = true; } },
    addEventListener(type, fn, capture) {
      winListeners.push({ type, fn, capture: !!capture });
    },
    removeEventListener(type, fn, capture) {
      const i = winListeners.findIndex((l) =>
        l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) winListeners.splice(i, 1);
    },
    dispatchEvent(ev) {
      let stopped = false;
      const original = ev.stopImmediatePropagation;
      ev.stopImmediatePropagation = function () {
        stopped = true;
        if (typeof original === "function") original.call(ev);
      };
      if (typeof ev.preventDefault !== "function") ev.preventDefault = function () {};
      for (const l of winListeners.slice()) {
        if (stopped) break;
        if (l.type !== ev.type) continue;
        l.fn.call(win, ev);
      }
      return !stopped;
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    performance: { now: () => Date.now() }
  };

  /* Recent Node defines navigator/crypto/performance as getter-only
     accessors on globalThis, so plain assignment throws. */
  const def = (name, value) =>
    Object.defineProperty(global, name, { value, writable: true, configurable: true });

  def("window", win);
  def("document", fakeDocument());
  def("localStorage", fakeStorage());
  def("navigator", { hardwareConcurrency: 8, deviceMemory: 8, platform: "test", userAgent: "node" });
  def("matchMedia", win.matchMedia);
  def("location", win.location);
  def("TextEncoder", require("util").TextEncoder);
  def("TextDecoder", require("util").TextDecoder);
  def("crypto", nodeCrypto.webcrypto);

  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    try {
      new Function(src + "\n//# sourceURL=" + f)();
    } catch (e) {
      throw new Error("loading " + f + " failed: " + e.message);
    }
  }
  return win.FieldKit;
}

/* ---- assertions ----------------------------------------------- */
function makeRunner(suiteName) {
  const state = { pass: 0, fail: 0, failures: [] };

  function ok(name, cond, detail) {
    if (cond) {
      state.pass++;
      console.log("  PASS  " + name);
    } else {
      state.fail++;
      state.failures.push(name + (detail ? "  -- " + detail : ""));
      console.log("  FAIL  " + name + (detail ? "  -- " + detail : ""));
    }
  }

  function section(t) { console.log("\n== " + t + " =="); }

  async function throws(name, fn, match) {
    let msg = null;
    try { await fn(); } catch (e) { msg = e.message; }
    if (msg === null) return ok(name, false, "did not throw");
    if (match && !match.test(msg)) return ok(name, false, "threw: " + msg);
    return ok(name, true);
  }

  return { ok, section, throws, state, suiteName };
}

module.exports = { ROOT, bootstrap, makeRunner, fakeElement, fakeDocument };
