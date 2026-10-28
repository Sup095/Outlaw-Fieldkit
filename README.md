# Outlaw FieldKit

A portable toolkit that runs from a single HTML file: no install, no
extensions, nothing to set up on the computer in front of you. Open it in
Chrome from a USB stick or a download and you get a small desktop of apps.
Point it at a **relay** (a small server you or a friend runs) and it adds
encrypted sync, end-to-end encrypted messaging, a browser streamed from the
server, and **RUNNER**, which runs uploaded programs in a sandbox on a second
machine and streams the window back.

Everything that leaves your machine is either encrypted before it goes, or
says plainly that it is not.

> **Get it:** download `OUTPOST-STANDALONE.html` from the
> [latest release](../../releases/latest) and open it in Chrome. While it
> starts, it shows the relay address it is about to use: press **C** (or
> CHANGE OR ADD ADDRESS) to add or change one. Add more than one and, if the
> one in use does not answer, the others are tried by themselves. The
> repository owner runs a relay; accounts on it are approved by hand. It
> answers at each of these addresses:
>
> - `https://relay.outlawfieldkit.com`
> - `https://run.outlawfieldkit.com`
> - `https://tool.outlawfieldkit.com`
> - `https://save.outlawfieldkit.com`
> - `https://learn.outlawfieldkit.com`

---

## Contents

- [Two builds](#two-builds)
- [What is in it](#what-is-in-it)
- [Using it](#using-it)
- [How it fits together](#how-it-fits-together)
- [Security model](#security-model)
- [Running your own relay](#running-your-own-relay)
- [Running your own run server (RUNNER)](#running-your-own-run-server-runner)
- [Building from source](#building-from-source)
- [Repository layout](#repository-layout)
- [Reporting bugs and security issues](#reporting-bugs-and-security-issues)
- [Contributing](#contributing)
- [License](#license)

---

## Two builds

Both are built from the same tree, every time.

| | **OUTPOST** | **FIELDKIT** |
|---|---|---|
| For | Anyone with an account on a relay | The people who run the relay |
| Messages, browser, RUNNER | ✓ | ✓ |
| Small tools (QR codes, diff, game math, guestbook) | ✓ | ✓ |
| Encrypted vault: notes, files, task board, decisions, logs | ✗ | ✓ |
| Server admin panels, AI chat, terminal, updater | ✗ | ✓ |

OUTPOST is limited by **absence**, not by a setting: the vault's code
(`core/crypto.js`, `core/store.js` and the transports) is not in its bundle,
so there is nothing on that drive that could open a vault.

---

## What is in it

**The desktop.** A search bar across the top: type anywhere and press Enter
to open the first match. *Your apps* fills with what you use most, and *all
apps* is grouped as ONLINE, FILES, PROJECT, SERVERS, TOOLS and SYSTEM. Ctrl+K
searches apps and records. Themes, a CRT mode, and a lock screen.

**MESSAGES.** End-to-end encrypted chat with the people on your relay. New
accounts wait for a moderator's approval. Tiers: guest, member, admin.

**BROWSER.** A real Chromium running on the relay, streamed to the panel as
H.264 video and decoded in hardware with WebCodecs, falling back to pictures
when video is not available. It has:
- tabs, back/forward, find, zoom, and copy and paste both ways;
- downloads, saved to this device or encrypted into VAULT FILES;
- a page's "choose file" opening your own file picker;
- touch: drag to scroll, tap, pinch to zoom;
- bookmarks and history kept encrypted in your vault;
- a DNS content filter, set by the relay's owner;
- a warm start: pointing at its tile starts it before you click.

Guests get a throwaway session; members' sign-ins can be kept for a while.

**RUNNER.** Upload a program (Python, JavaScript, shell, Linux binaries,
Windows `.exe` through Wine, or a `.zip` of a whole folder) and it runs in a
sandbox on the run server. You get its output live, or its window as video
with your keyboard and mouse sent back.
- Guests' sandboxes are wiped when they leave.
- Members keep their files, can leave jobs running, get filtered internet,
  and have a saved folder; Windows programs keep their saves and settings
  in it.
- A zip is unpacked inside the sandbox; you choose which program in it to
  start.
- Admins get a library of shared programs with cards (a title, a line about
  it, and a PLAY button), punishments, a bin, power readings and a
  fair-access line.

**The vault (FIELDKIT only).** Notes, a scratchpad, snippets, a task board,
decisions, a changelog, an incident log, a playtest log, encrypted file
storage and save codes. They sync through the relay as ciphertext.

**Tools.** QR codes, a code diff, game maths, a terminal with CritterScript (a
tiny language built in), link diagnostics, topology and mesh planners, an AI
chat (relay models, or a model run locally in the browser with WebGPU), and a
self-test.

---

## Using it

1. Download `OUTPOST-STANDALONE.html` (or `FIELDKIT-STANDALONE.html` if you
   run a relay) from [Releases](../../releases/latest).
2. Open it in Chrome or another Chromium browser. It runs from `file://`; no
   web server is needed.
3. **The relay address**: while it starts, press **C** (or CHANGE OR ADD
   ADDRESS) and type the relay's address, such as `relay.example.com`. You
   can save several; if the one in use does not answer, the others are
   tried in turn. In the full build, RELAY LINK changes it too.
4. **MESSAGES → create an account.** On a relay that approves accounts, you
   can sign in once a moderator has approved you.
5. BROWSER and RUNNER use the same account.

Settings are kept in the browser's local storage, so you enter the relay
once per computer. Clearing site data forgets them.

`PREFLIGHT.html` (in the source tree and on a built drive) checks that the
files on a drive match the manifest the build wrote, before you trust it with
a password.

---

## How it fits together

```
 ┌──────────────────────────┐        https / wss         ┌──────────────────────────────┐
 │  the HTML file, in       │ ─────────────────────────▶ │  RELAY  (relay/)             │
 │  Chrome                  │                            │  Node, no npm dependencies   │
 │  - encrypts before send  │ ◀───────────────────────── │  - vault ciphertext store    │
 │  - decodes video         │      video, events         │  - accounts and messages     │
 └──────────┬───────────────┘                            │  - streamed Chromium         │
            │                                            │  - signs RUNNER tickets      │
            │  wss, with a one-minute signed ticket      └──────────────────────────────┘
            ▼
 ┌──────────────────────────────┐
 │  RUN SERVER  (runnerd/)      │
 │  Docker + gVisor sandboxes   │
 │  console output, windows as  │
 │  H.264 + Opus, a filtering   │
 │  egress proxy                │
 └──────────────────────────────┘
```

The relay knows who you are. The run server only believes a ticket the relay
signed (Ed25519), and fetches the relay's public key by itself. No upload,
output or video for RUNNER passes through the relay.

---

## Security model

**The vault.**
- A random 256-bit AES-GCM key encrypts every record.
- That key is wrapped by one derived from your password (PBKDF2-SHA256, then
  HKDF).
- A separate HKDF output is the only thing the relay learns about your
  password.
- The relay stores ciphertext, plus each record's id, type and update time
  (what sync needs).
- A recovery key is a second wrapping of the same key. Treat it like the
  password.

**Messages.**
- Each account has an ECDH P-256 identity key. Its private half is sealed
  under a key from your password before it is stored on the relay, which is
  how signing in on a new computer works.
- Each conversation has a random AES-GCM key, sealed to each member's public
  key.
- The relay sees who talks to whom and when, not what is said.

**The streamed browser is not anonymity.**
- Every page runs on the relay, so **the relay's owner can see every address
  you visit**. Only sign in to sites you would trust that person with.
- All sites in a session share one browser profile.
- The browser cannot reach the relay's own API or any private address; every
  request goes through a guard proxy.

**RUNNER.**
- Every job runs in its own container, under gVisor where it is installed,
  with every capability dropped and limits on memory, processes and files.
- Guests get no network.
- Members' network goes through a filtering proxy with per-job limits.
- Files are kept per person, with quotas and expiry.
- Only admins can add shared programs.

**Updates.** Release builds are signed with an Ed25519 key kept offline. The
public half is built into the client (`core/update-key.js`), so a relay that
is taken over can withhold an update but cannot forge one.

**Secrets never live in this repository.** Real configuration
(`relay/config.local.json`, the generated `relay/config.json`), tunnel tokens,
relay data, recovery keys and the release key are all in `.gitignore`.
`relay/config.example.json` is the annotated template.

---

## Running your own relay

The relay is plain Node.js (22 or newer) with **no npm dependencies**. For the
streamed browser it needs Chromium and ffmpeg, which the Docker image in
`relay/docker/` includes.

```bash
cp relay/config.example.json relay/config.local.json   # then edit it
node build.js                                          # writes relay/config.json
node relay/server.js
```

- `relay/config.example.json` explains every setting.
- [`SETUP.md`](SETUP.md): setting everything up from nothing, including a
  Cloudflare Tunnel so no port is opened.
- [`relay/README.md`](relay/README.md): the relay itself.
- [`relay/BROWSER.md`](relay/BROWSER.md): the streamed browser and its Docker
  image, with a Pterodactyl egg, and *browser helpers*: a second machine that
  takes new browser sessions when the relay is full.
- [`relay/CONNECTIVITY.md`](relay/CONNECTIVITY.md): getting HTTPS in front of
  it.
- [`relay/LARGE-FILES.md`](relay/LARGE-FILES.md): large files.
- [`MODELS.md`](MODELS.md): AI models, on the relay or in the browser.

## Running your own run server (RUNNER)

A Linux machine with Docker. `runnerd/setup.sh` sets it up and updates it,
and is safe to run again:
- a fixed-size disk for uploads;
- gVisor;
- the job images, including Wine and the windowed one;
- the service, a Cloudflare Tunnel, and a small host service for power
  readings.

The relay passes RUNNER through to it over the tailnet (`runner.innerUrl`),
so RUNNER answers on whatever address the relay does.

See [`runnerd/README.md`](runnerd/README.md).

---

## Building from source

Needs Node.js 22 or newer. There is nothing to install.

```bash
node build.js            # builds FIELDKIT-STANDALONE.html and OUTPOST-STANDALONE.html
node build.js --only OUTPOST --deploy E:\   # a drive with only OUTPOST on it
node tests/run.js        # the whole test suite
```

The tests are plain Node with a small fake DOM (`tests/harness.js`). They
cover:
- the crypto, the store and sync;
- every module's self-checks;
- the relay's routes, and the browser engine against a fake Chromium;
- the run server end to end with an unsandboxed test driver.

They run on Windows and Linux; CI runs them on every push.

`tools/` has the release signer, the deploy-bundle maker, a blocklist
fetcher and the WebLLM bundler.

## Repository layout

| Path | What |
|---|---|
| `FIELDKIT.html`, `OUTPOST.html` | The two builds' entry points; each lists its modules |
| `PREFLIGHT.html` | Checks a drive against its manifest before you unlock anything |
| `core/` | The kernel, UI, desktop, crypto, store, sync, messaging crypto, CritterScript |
| `modules/` | One file per app |
| `relay/` | The relay server, the streamed browser, its Docker image |
| `runnerd/` | The run server, its sandbox images, `setup.sh` |
| `tools/` | Build and release helpers |
| `tests/` | The test suite (`node tests/run.js`) |
| `vendor/web-llm.js` | [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0), bundled by `tools/build-webllm.js` |

Comments in the source often cite sections like `FIELDKIT_PROJECT.md §14.18`
or `RUNNER_PLAN.md §22`. Those are the project's internal design logs. They
are not published here, because they are full of the specifics of one
person's own machines.

---

## Reporting bugs and security issues

- **Bugs and ideas:** open an [issue](../../issues). Say which build, which
  browser, and what you did.
- **Security problems:** please do **not** open a public issue. Use
  [private vulnerability reporting](../../security/advisories/new). See
  [`SECURITY.md`](SECURITY.md).

Use FieldKit on networks and devices you are allowed to use it on, and within
the rules of whoever runs them.

---

## Contributing

Pull requests are welcome. Fork the repository, make your change, run
`node tests/run.js` (the suite needs only Node 22 or later), and open a pull
request. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the details.

---

## License

FieldKit is **source-available**, not open source. The
[license](LICENSE) in plain words:

- **You may** use it, run your own relay and run server for yourself and
  the people you choose, change it for your own use, use someone else's
  server, and fork it on GitHub to send pull requests.
- **You may not** sell it or make money with it (no charging for it or for
  access to a server running it, no ads), or publish copies of it anywhere
  else: other repositories, mirrors, stores or download sites.
- Contributions you send are yours, and you allow them to be used in
  FieldKit under its license.
- Parts that come from other projects, such as `vendor/web-llm.js`
  (Apache-2.0), keep their own licenses.

For anything the license does not cover, [open an issue](../../issues) and
ask.
