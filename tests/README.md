# FieldKit tests

```bash
npm test
```

Or a subset, matched against suite filenames:

```bash
node tests/run.js qr guest
```

Each `*.test.js` runs in its own child process — `harness.js` installs
globals (`window`, `document`, `crypto`, …) and sharing one process would
let a suite's fake window leak into the next. A suite that crashes before
printing its `RESULT` line is reported as *broken* rather than quietly
counting as zero failures.

## What lives here and what does not

These suites cover **logic**: cryptography, encoders, state machines,
isolation boundaries. They run with a hand-rolled fake DOM and no
dependencies, because the drive carries none.

Two kinds of verification deliberately live **outside** the drive:

- **DOM integration** (mounting real modules, focus, event wiring) needs
  `jsdom`, installed in a scratch directory only.
- **The QR cross-check** compares `core/qr.js` module-for-module against
  the independent `qrcode` npm package across every version and version
  boundary. Worth re-running after any change to `core/qr.js`:

  ```bash
  npm install qrcode        # in a scratch dir, never on the drive
  ```

  then load `core/qr.js` into a bare `{ provide }` shim and diff its
  matrix against `QRCode.create([{data, mode:"byte"}], {errorCorrectionLevel:"M", version})`.
  Force byte mode — the reference optimises across numeric/alphanumeric
  segments, ours is byte-only by design, so anything else compares two
  different encodings and reports false differences.

## The in-app suite

`tests/` is the developer-side net. The user-facing one is **DIAGNOSTICS →
FULL SYSTEM EXERCISE**, which runs inside FieldKit on the real machine and
drives every feature for real — including a live message to the AI. See
`core/selftest.js`.

`contract.test.js` is what keeps those two in sync: it fails if a
registered module does not ship a `selfcheck()`, so the in-app exercise
cannot quietly stop covering things as features are added.

**When you add a module, add a `selfcheck(api)`:**

```js
function selfcheck(api) {
  return [
    { name: "DOES THE THING", critical: false, run: async function () {
      nodes.input.value = "probe";
      doTheThing();
      if (!/expected/.test(nodes.out.textContent)) throw new Error("it did not");
      return "short description of what was proven";
    } }
  ];
}
FieldKit.register("my-module", { selfcheck: selfcheck, /* ... */ });
```

Rules that matter:

- The list must be buildable **before** mount — the exercise enumerates
  checks first, then mounts. Do not touch post-mount state at build time.
- Anything persisted must be registered: `api.sandbox.track(id)`. Cleanup
  runs in a `finally`, so a check that throws still leaves no debris.
- Throw a message starting with `SKIPPED` for an unmet precondition. That
  reports as SKIP, not as a failure.
- `critical: true` means a failure halts confidence in the whole build.
  Use it for correctness and security, not for cosmetics.
- Never destroy real user state to test it. The screen-lock probe, for
  example, refuses to overwrite an existing PIN and verifies negatively
  instead.

## Writing a suite

```js
const { bootstrap, makeRunner } = require("./harness");
const FieldKit = bootstrap(["core/kernel.js", "core/thing.js"]);
const { ok, section, state } = makeRunner("thing");

section("the thing");
ok("does what it says", thing.doIt() === 42);

console.log("\nRESULT  pass " + state.pass + "  fail " + state.fail);
process.exit(state.fail ? 1 : 0);
```

The `RESULT` line is what the runner parses. Print it even on the crash
path, or the suite is counted as broken.
