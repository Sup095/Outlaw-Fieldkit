# Getting a model for AI LOCAL

AI LOCAL is **tier 2**: the model that runs inside the browser tab, on
the machine in front of you, with no network at all. It exists for when
the relay is unreachable — which is exactly when you are on the weakest
machine in the room, so everything below is a compromise with that.

If you just want the short version:

```bash
node tools/model-info.js Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC
```

That prints the two download URLs and where to put the result. The rest
of this file is why.

---

## The three tiers, so it is clear which one this is

| tier | what runs | where | needs |
|---|---|---|---|
| **1 — relay** | whatever LM Studio is serving | the PC at home | the relay reachable |
| **2 — local** | WebLLM, in the tab | this machine's GPU | a model folder |
| **3 — heuristics** | no model at all | here | nothing |

Tier 1 will be faster and better than any tier-2 model, always. Tier 2
is not an upgrade — it is the thing that answers when the relay does
not.

---

## Engine and model are two different downloads

Confusing them is the usual reason AI LOCAL says "no engine":

| | what it is | size | where it comes from |
|---|---|---|---|
| **the engine** | `vendor/web-llm.js` | 5.3 MB | `node tools/build-webllm.js` |
| **the model** | a folder of weights | 0.4–5 GB | Hugging Face, see below |

The engine is **already built and committed**. If AI LOCAL says there is
no engine, the drive is out of date — re-run `node build.js --deploy
<drive>`. Everything below is about the model, which is not in the repo
and never will be.

---

## Which model — the actual recommendation

**Start with `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC`.**

<https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC>

- ~1.0 GB on disk, **1630 MB of GPU memory** while running.
- Trained for code, which is what this toolkit is for. A general 1B
  model will chat more pleasantly and be worse at the only job you
  actually have for it offline.
- No reasoning preamble. Qwen3 and the DeepSeek-R1 distils emit a
  `<think>` block before answering, which on a Chromebook means
  watching it think for thirty seconds before the answer starts.
  (FieldKit strips those blocks — `stripReasoning()` in
  `core/selftest.js` — but stripping them does not give the time back.)

**If that will not load, drop to `Llama-3.2-1B-Instruct-q4f16_1-MLC`**
(879 MB). Weaker at code, but it is the smallest thing that still holds
a conversation, and it is the one to try when you are not sure the
machine can do this at all.

**On a real laptop or the desktop**, step up to
`Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` (5107 MB) — but at that point
you are on a machine that can reach the relay, so ask why you are not
using tier 1.

### Honest limits

None of these know Godot 4 or GDScript well. They will confidently
produce GDScript 3 syntax, invent `Node` methods, and get the
`@export` / `export` split wrong. They are useful for "what does this
error mean", "write me a regex", "rename these across a file" — not for
"write my state machine". That is not a FieldKit problem; a 1.5B model
is a 1.5B model.

### Reading the names

```
mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC
       └── model ──────────────────┘ └ quant ┘
```

- `q4f16_1` — 4-bit weights, 16-bit activations. **The usual choice.**
- `q4f32_1` — 32-bit activations. Roughly 15% more memory, for
  machines whose GPU handles 16-bit floats badly. Try `f16` first.
- `q0f16` / `q0f32` — unquantised. Much larger, marginally better,
  pointless at these sizes.
- `-1k` suffix — a 1024-token context instead of 4096. Smaller, and it
  will forget the start of a long conversation.

### Everything the vendored engine can run

```bash
node tools/model-info.js            # the ones under ~2 GB
node tools/model-info.js --all      # all 141
node tools/model-info.js coder      # anything matching
```

Those numbers are read out of `vendor/web-llm.js` itself, not typed
here, so they cannot disagree with the engine that will load them.

---

## The two downloads, and the trap in the second one

**1. The weights.** The whole repo — forty-odd shard files plus the
config. Clicking them individually is a bad afternoon:

```bash
git lfs install
git clone https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC
```

**2. The compiled library** — a `.wasm`, from a completely different
repository, and **its filename is not always the model's name**:

```
https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_48/Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm
```

Note that carefully: the recommended model is **Qwen2.5-Coder-1.5B**
and its library is **Qwen2-1.5B**. Several models share one compiled
library, and `Llama-3.1-8B` spells its version `3_1` in the filename.
Guess and you get a 404 after the multi-gigabyte part already
succeeded. `node tools/model-info.js <exact-id>` prints the right one
because it reads the pairing out of the engine.

Save the `.wasm` **into the same folder as the weights**, beside
`mlc-chat-config.json`.

### Why the `.wasm` is not optional

If it is missing, WebLLM's default behaviour is to fetch it from the
internet at load time. That defeats the entire point of an offline tier
and will fail on a school network anyway. AI LOCAL checks for it up
front and reports `needsWasm`, rather than letting you discover it when
you press send.

---

## What the folder has to contain

AI LOCAL validates this before anything heavy happens, and names
whichever file is missing:

```
qwen2.5-coder-1.5b/
  mlc-chat-config.json        required
  ndarray-cache.json          required
  params_shard_0.bin          required (usually dozens of these)
  params_shard_1.bin
  ...
  tokenizer.json              usually present
  Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm    required in practice
```

Checking up front is deliberate: the alternative is a two-minute load
that dies deep inside the engine with a message about a missing key in
an object.

---

## Putting it on the drive

Make a `models/` folder next to `core/` and `modules/` on the SSD:

```
F:\FieldKit\
  core\
  modules\
  models\
    qwen2.5-coder-1.5b\
      mlc-chat-config.json
      ndarray-cache.json
      params_shard_0.bin
      ...
      Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm
```

`node build.js --deploy E:\` copies it across with everything else.
Nothing to configure — `models` is already in the payload list and is
simply absent on a drive that has none, which is the normal state.

In FieldKit: **AI LOCAL → pick a model folder** → choose
`models/qwen2.5-coder-1.5b` on the drive.

### Two things this costs

**Gigabytes on a 15.9 GB stick.** The 1.5B model is about 1 GB and
fine. A 7B one is a third of the drive.

**It is not covered by the drive manifest.** Hashing gigabytes on every
build would mean waiting minutes to learn that files nobody edited
still have the same contents, so `models/` is copied but not hashed —
which means PREFLIGHT does not verify it and would not notice a
tampered model. That is a real gap, stated rather than hidden. It is a
much smaller risk than tampered *code*, which is hashed, but it is not
zero. If it matters for a particular model, keep it off the drive and
load it from the host machine's disk with the same folder picker.

---

## When it does not work

AI LOCAL says which of these it is rather than making you guess.

**"no engine"** — `vendor/web-llm.js` is missing from the drive.
Re-deploy.

**"folder is not a usable MLC model"** — it names the missing file.
Almost always `ndarray-cache.json`, from copying only the `.bin`
shards.

**`needsWasm`** — no `.wasm` in the folder. See above; the model will
otherwise try to reach the internet for it.

**It loads, then the tab dies** — out of GPU memory. The number
`model-info.js` prints is what it wants *while running*, and a
Chromebook reporting 4 GB is not offering 4 GB to one tab. Drop a size,
or try the `q4f32_1` build if `f16` is what crashed.

**WebGPU is not available** — no WebGPU, no tier 2, and nothing in
FieldKit can change that. Chrome 113+ on hardware the school has not
blocklisted. Tier 3 heuristics still work.

**It is very slow** — expected, and not fixable here. Generation runs
on the main thread, because a Worker created from a `file://` URL is
blocked as cross-origin and the blob-URL workaround cannot see the
fetch shim AI LOCAL installs. The panel says so. This is the offline
fallback, not the fast path.
