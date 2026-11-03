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

> **Get it:** download `OUTPOST-STANDALONE.html` (and `PREFLIGHT.html`, a
> safety check to run first on a computer you do not know) from the
> [latest release](../../releases/latest) and open it in Chrome. While it
> starts, it shows the relay address it is about to use: press **C** (or
> CHANGE OR ADD ADDRESS) to add or change one. Add more than one and, if the
> one in use does not answer, the others are tried by themselves. The
> repository owner runs a relay; accounts on it are approved by hand. It
> answers at each of these addresses:
>
> - `https://relay.outlawfieldkit.com`
> - `https://tool.outlawfieldkit.com`
> - `https://save.outlawfieldkit.com`
> - `https://learn.outlawfieldkit.com`
> - `https://edu.outlawfieldkit.com`
>
> (`run.outlawfieldkit.com` is RUNNER's own server, not a relay address;
> RUNNER finds it by itself.) If the whole domain is ever blocked, a new one
> will be listed here.

---

## Contents

- [Three files](#three-files)
- [What is in it](#what-is-in-it)
- [Using it](#using-it)
- [How it fits together](#how-it-fits-together)
- [Security model](#security-model)
- [Running your own server](#running-your-own-server)
- [Building from source](#building-from-source)
- [Repository layout](#repository-layout)
- [Roadmap](#roadmap)
- [Reporting bugs and security issues](#reporting-bugs-and-security-issues)
- [Contributing](#contributing)
- [License](#license)

---

## Three files

Each release has three files. Put them in the same folder.

| File | What it is |
|---|---|
| `OUTPOST-STANDALONE.html` | **The one most people want.** Messages, the streamed browser, RUNNER, ASK and the small tools. No vault. |
| `FIELDKIT-STANDALONE.html` | The full build, for the people who run the relay: everything in OUTPOST plus the encrypted vault and the tools for running a relay. |
| `PREFLIGHT.html` | **A check to run first** on a computer you do not know. It opens nothing and stores nothing. It says what it finds, then opens either build. |

**What PREFLIGHT checks.** On this computer and in this browser:
- whether a browser extension has replaced the crypto functions FieldKit relies on;
- whether an earlier session left FieldKit data behind (it offers to wipe it);
- the clock;
- whether the computer can decode the video and sound the streamed browser and RUNNER send.

Type one or more relay addresses and it also says which of them this network lets through, whether WebSockets get through (the browser and
RUNNER need them), and whether the streamed browser and RUNNER are up. On a
FieldKit drive it also checks every file against the drive's manifest. It
cannot see keyloggers or anything outside the browser, and says so at the
top. Its verdict is CLEAR, CAUTION or DO NOT UNLOCK; the last only matters
for the full build's vault, so OPEN OUTPOST is allowed once the checks have run.

The two builds are made from the same tree, every time.

| | **OUTPOST** | **FIELDKIT** |
|---|---|---|
| For | Anyone with an account on a relay | The people who run the relay |
| MESSAGES, BROWSER, RUNNER, ASK | ✓ | ✓ |
| Small tools (QR CODE, GAME MATH) | ✓ | ✓ |
| RELAY LINK (relay addresses) and UPDATE (signed updates) | ✓ | ✓ |
| ADMIN CENTER, for an admin signed in on a relay | ✓ | ✓ |
| Encrypted vault: NOTES, FILES, TASK BOARD, backups | ✗ | ✓ |
| TOPOLOGY, and for admins the terminal and CritterScript | ✗ | ✓ |

OUTPOST is limited by **absence**, not by a setting: the vault's code
(`core/crypto.js`, `core/store.js` and the transports) is not in its bundle,
so there is nothing on that drive that could open a vault.

---

## What is in it

**The desktop.** A search bar across the top: type anywhere and press Enter
to open the first match. *Your apps* fills with what you use most (right-click
an app to pin it there), and *all apps* is grouped as ONLINE, FILES, TOOLS and
SYSTEM. If anything needs you, it
says so under the search bar. Ctrl+K searches apps and records, and Ctrl+/
lists the keys. Windows open where you left them, snap to the sides of the
screen, and can come back after a reload; right-click a window's taskbar button
to snap or close it, and Ctrl+Shift+D shows the desktop. A line at the top says when a service
is down and clears itself when it is back; ◉ in the taskbar keeps what you
missed. Themes, a CRT mode, a lock screen, and settings for bigger text, higher
contrast and less motion. FIELDKIT has 18 apps and OUTPOST 12, and the manual
covers them all.

**MESSAGES.** End-to-end encrypted chat with the people on your relay. New
accounts wait for a moderator's approval. Tiers: guest, member, admin.

**BROWSER** has two modes. The **lighter mode** (0.8.0, when the relay has a
[lens](lens/README.md) server set up) runs each page in your own browser through
[Scramjet](https://github.com/MercuryWorkshop/scramjet), and only its bytes pass
through a small rented server that applies the same block lists. A page costs
what it weighs. YouTube plays there too (0.10.0): it refuses a rented
server's own address, so its connections leave through Cloudflare WARP, or
through proxy addresses you buy. Every site in the lighter mode shares one
server, so it says plainly, and again at any password box, not to sign in to
anything there. The **full mode**, for signing in and for what the lighter
mode cannot run, is for admins and for members an admin allows (ADMIN CENTER,
PEOPLE): a real Chromium running on the relay, streamed to the panel as
H.264 video and decoded in hardware with WebCodecs, falling back to pictures
when video is not available. It has:
- tabs, back/forward, find, zoom, and copy and paste both ways;
- downloads, saved to this device or encrypted into FILES;
- a page's "choose file" opening your own file picker;
- touch: drag to scroll, tap, pinch to zoom;
- a new-tab page of your bookmarks and recent sites;
- bookmarks and history, encrypted in your vault in FIELDKIT, and kept
  unencrypted on that computer in OUTPOST, which has no vault;
- ads, trackers, malware and adult sites refused for everyone, from lists that
  refresh themselves, with a DNS filter behind them set by the relay's owner;
- a warm start: pointing at its tile starts it before you click.

Members' sign-ins in the full mode can be kept for a while. DATA SAVER lowers
its video for YouTube by itself.

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
- What you run most stays at the top, and RUN AGAIN repeats the last one.
- Admins get a library of shared programs with cards (a title, a line about
  it, and a PLAY button), punishments, a bin, power readings and a
  fair-access line.

**ADMIN CENTER.** One page for admins: what is up, who is waiting for approval,
who is in the browser, what was blocked and any report that a block was wrong, a
line to tell everyone something, and recent warnings and errors. Nothing typed by
anyone passes through it, and blocked sites are counted by site, not by person.

**ASK.** Questions answered by the best thing it can reach, and every reply
says which: a model on your own PC, the server's small models (members only),
a tiny model installed into this browser with one button (everyone, WebGPU),
or built-in rules when there is none of those.

**The vault (FIELDKIT only).** NOTES (notes, snippets, configs, decisions and
incidents, every version kept), encrypted FILES and a TASK BOARD. They sync
through the relay as ciphertext.

**Tools.** QR CODE, GAME MATH, and TOPOLOGY, a picture of your network that
fills itself in from the relay and marks what is up. Admins also get a terminal
with CritterScript (a tiny language built in). DIAGNOSTICS and RELAY LINK, with
LINK DOCTOR inside, find what is wrong.

---

## Using it

1. Download `OUTPOST-STANDALONE.html` (or `FIELDKIT-STANDALONE.html` if you
   run a relay) from [Releases](../../releases/latest).
2. Open it in Chrome or another Chromium browser. It runs from `file://`; no
   web server is needed.
3. **The relay address**: while it starts, press **C** (or CHANGE OR ADD
   ADDRESS) and type the relay's address, such as `relay.example.com`. You
   can save several; if the one in use does not answer, the others are
   tried in turn. RELAY LINK changes it later, in either build.
4. **MESSAGES → create an account.** On a relay that approves accounts, you
   can sign in once a moderator has approved you.
5. BROWSER and RUNNER use the same account.

Settings are kept in the browser's local storage, so you enter the relay
once per computer. Clearing site data forgets them.

On a computer you do not know, open `PREFLIGHT.html` first (it is in the
release and on a built drive; see [Three files](#three-files)), press RUN
CHECKS, then open a build from its buttons.

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
signed (Ed25519), and fetches the relay's public key by itself. With
`runner.innerUrl` set, the relay passes RUNNER's connection through to the run
server over the tailnet without reading it, so RUNNER answers on every address
the relay does; without it, the panel connects to the run server directly.

Both servers share one home internet line with other things, so together they
send at most a set ceiling (12 Mbit/s by default, of a 21 Mbit/s line): every
connection they serve is paced to it, and the busier it gets, the sooner video
steps down and new sessions wait. RUNNER's ADMIN sets it.

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
  request goes through a guard proxy, which also applies the block lists.
- The block lists apply to everyone, admins included. An admin can allow a
  site for everyone; a site blocked by mistake can be reported from the panel.

**RUNNER.**
- Every job runs in its own container, under gVisor where it is installed,
  with every capability dropped and limits on memory, processes and files.
- Guests get no network.
- Members' network goes through a filtering proxy with per-job limits.
- Files are kept per person, with quotas and expiry.
- Only admins can add shared programs.

**Updates.** Release builds are signed with an ECDSA P-256 key kept offline.
The signed record rides in the GitHub release's notes, and the public half of
the key is built into the client (`core/update-key.js`). UPDATE asks GitHub
first and the relay second (the relay keeps a checked copy of the latest
release, for networks that block GitHub). Each file's hash is checked before
it is saved, or after, with CHECK A DOWNLOADED FILE. So neither GitHub nor a
relay that is taken over can forge an update; they can only withhold one.

**Secrets never live in this repository.** Real configuration
(`relay/config.local.json`, the generated `relay/config.json`), tunnel tokens,
relay data, recovery keys and the release key are all in `.gitignore`.
`relay/config.example.json` is the annotated template.

---

## Running your own server

This is everything, in the order to do it. You need one machine for the relay.
Everything after the relay is optional, and each step works without the next.

| Step | What you get | How |
|---|---|---|
| 1. Build | your own copy, with your relay's address in it | `node build.js` ([building](#building-from-source)) |
| 2. Relay | MESSAGES, sync, FILES, UPDATE, the engine for browser models | [`SETUP.md`](SETUP.md) parts 1 and 2 |
| 3. Tunnel | an https address with no port opened | [`SETUP.md`](SETUP.md) part 3 |
| 4. Streamed browser | BROWSER | the Docker image, [`relay/BROWSER.md`](relay/BROWSER.md) |
| 5. Run server | RUNNER, on a second Linux machine | `runnerd/setup.sh`, [below](#running-your-own-run-server-runner) |
| 6. Small AI models | ASK for your members | `sh runnerd/tiny-ai.sh`, [below](#small-ai-models) |
| Optional: a lens server | BROWSER's lighter mode and YouTube, off your home connection | a small rented Linux server, `lens/setup.sh`, [`lens/README.md`](lens/README.md) |
| Optional: a graphics card | smooth games in BROWSER | `sh runnerd/browser-card.sh`, [`relay/BROWSER.md`](relay/BROWSER.md#a-graphics-card) |
| 7. A big AI model | ASK with your own PC | LM Studio and `aiTargets`, [`MODELS.md`](MODELS.md) |
| 8. Accounts | who may use what | `messaging` in the config: `moderators`, `requireApproval` |
| 9. Your own updates | signed releases to your users | [`SETUP.md`](SETUP.md) part 6 |

Your settings go in `relay/config.local.json`, which never leaves your machine.
`node build.js` merges it over `relay/config.example.json`, which explains every
setting, and writes `relay/config.json` to upload. Check it all afterwards with
`PREFLIGHT.html`, then DIAGNOSTICS.

### The relay

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

### Small AI models

On the run server, in the folder `setup.sh` uses:

```bash
sh tiny-ai.sh
```

It fetches two small models (about 700 MB, each checked against a pinned hash),
starts them where only the tailnet can reach them, and prints the `tinyAi` lines
for your relay's config. Put those in and restart the relay. They need about
1.5 GB of memory between them and no graphics card, and RUNNER takes priority
over them. `sh tiny-ai.sh stop` stops them.

Only members and admins can use them, one question at a time each. Everyone
else gets the models that run in their own browser, which cost you nothing: the
relay only hands the page the engine, and the model comes from Hugging Face.

### Running your own run server (RUNNER)

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
fetcher, the GitHub snapshot tool and the WebLLM bundler.

## Repository layout

| Path | What |
|---|---|
| `FIELDKIT.html`, `OUTPOST.html` | The two builds' entry points; each lists its modules |
| `PREFLIGHT.html` | The check to run first: this computer, this browser, the relay and its services, and a drive against its manifest |
| `core/` | The kernel, UI, desktop, crypto, store, sync, messaging crypto, CritterScript |
| `modules/` | One file per app |
| `relay/` | The relay server, the streamed browser, its Docker image |
| `lens/` | BROWSER's lighter mode: the Wisp server for a rented machine, its page, its image |
| `runnerd/` | The run server, its sandbox images, `setup.sh` |
| `tools/` | Build and release helpers |
| `tests/` | The test suite (`node tests/run.js`) |
| `vendor/web-llm.js` | [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0), bundled by `tools/build-webllm.js` |

Comments in the source often cite sections like `FIELDKIT_PROJECT.md §14.18`
or `RUNNER_PLAN.md §22`. Those are the project's internal design logs. They
are not published here, because they are full of the specifics of one
person's own machines.

---

## Roadmap

What is planned, in order, and what each step waits on. Nothing here is in a
release until it is built, tested and running.

**Done in 0.6.0.** Ads, trackers, malware and adult sites blocked in BROWSER for
everyone, from lists that refresh themselves (checked against real game sites:
the games still start). A line at the top when a service is down, which clears
itself. ADMIN CENTER. Windows that remember where they were and snap. A new-tab
page, drafts in MESSAGES, RUN AGAIN, text size, contrast and less motion. A
read-only disk for the graphics-card browser helper. `/probe`, a page that says
what a device allows.

**Done in 0.8.0: a lighter BROWSER ("lens").** The full mode runs every page on
the server and sends it as video, about 11 MB a minute while it moves. Lens
runs the page in your own browser, through a small rented server, so a page
costs what it weighs and nothing more while you read it. The streamed browser
stays, as the fallback and for what lens cannot do.
- *Built in it:* the same block lists, checked as each connection opens;
  private addresses refused; a monthly ceiling on its own meter, and the
  provider's own count; passes signed by the relay; a notice to everyone when
  it falls back, which clears itself.
- *What it cannot do:* YouTube refuses a rented server's address, so it opens
  in the full mode by itself. All sites in it share one origin, so sign-ins
  belong in the full mode.
- *Next:* a cache for pages you open twice, which the test showed would
  roughly halve what a second visit costs.

**Done in 0.10.0: YouTube in the lighter mode, and the home browsers kept
for those who need them.** YouTube refuses a rented server's address ("Sign
in to confirm you're not a bot") and plays for a Cloudflare WARP one, so the
lens server runs WARP in a small container of its own and sends only
YouTube's connections through it (`lens/egress.js`); bought proxy addresses
can stand in or add to it. YouTube then plays in your own browser, with no
streaming and nothing over the home connection. The full mode, which does
use the home connection, is now for admins and the members an admin allows;
everyone else has the lighter mode, which warns at every turn not to sign in
there. (0.9.0's idea of a bigger rented server running the full mode was
dropped: about four more browsers for $24 a month was not worth it.)

**After that.**
- Sound in BROWSER without one Chromium per session (it is the biggest memory
  cost now).
- PLAY: web games served as files from your own relay, and RUN HERE: small
  Python scripts and old formats (Flash, DOS) run on your own computer instead of
  the server.
- Games drawn on the graphics card inside RUNNER's sandbox. This needs a newer
  card (Turing or later); the current one cannot do it under gVisor.
- The old proxy browser (`relay/browse.js`) goes once lens replaces it as the
  fallback.

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
- **You may** charge for a server you run with it (access fees,
  subscriptions, donations, sponsors, ads around the service), to pay for
  the servers and make a reasonable profit, as long as you say it is built
  on Outlaw FieldKit and link here (license 1.1, section 2(f)).
- **You may not** sell the software itself, charge for its code or
  release files, put it or a rebranded copy into a product you sell, or
  publish copies of it anywhere else: other repositories, mirrors, stores
  or download sites.
- Contributions you send are yours, and you allow them to be used in
  FieldKit under its license.
- Parts that come from other projects, such as `vendor/web-llm.js`
  (Apache-2.0), keep their own licenses.

For anything the license does not cover, [open an issue](../../issues) and
ask.
