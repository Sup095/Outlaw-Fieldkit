# SETTING UP FIELDKIT FROM NOTHING

This assumes you have the files and a domain on Cloudflare, and nothing
else set up. It goes in order. Each part says what it is for, so if
something breaks you know which part to look at rather than starting
over.

There are **three places** and each has one job. Almost every confusing
failure comes from doing something in the wrong one:

| Place | What it is | What it does |
|---|---|---|
| **The SSD** (`F:\FieldKit`) | Your working copy, with the git history | Where you edit. Nothing else edits here. |
| **The thumb drive** | A copy made by the build script | What you actually run, on any machine |
| **The container** (Pterodactyl) | The relay | Serves encrypted blobs to both of you |

The SSD is the only original. The drive is disposable — if it dies you
rebuild it in thirty seconds. The container never holds anything it
could read.

**On the drive there are two things to open, in order.** `PREFLIGHT.html`
first — it asks whether this machine is safe to unlock the vault on, and
it is the only file that checks the others. Then `FIELDKIT.html`. On your
own PC the first one is ten seconds of habit; on a borrowed machine it is
the whole point.

---

## PART 1 — THE DRIVE

**What this gives you:** a working FieldKit you can open on any
computer, including a school Chromebook, with no install and no
network.

### 1.1 Build it

On your PC, in `F:\FieldKit`:

```bash
node build.js
```

That writes `FIELDKIT-STANDALONE.html` — every script inlined into one
file. It is the escape hatch for machines that refuse to load separate
script files from removable media.

### 1.2 Copy it to the stick

Plug the drive in, note its letter, then:

```bash
node build.js --deploy E:\
```

Use the real letter. This copies `PREFLIGHT.html`, `FIELDKIT.html`,
`core/`, `modules/`, the standalone bundle, and the optional bundles if
you built them, into `E:\FieldKit\`.

It then **reads the files back off the drive** and checks every script
in the boot manifest is present at the right size. If the drive filled
up or you pulled it mid-copy it says so and fails. A half-copied stick
boots to MODULE LOAD FAILURE on a machine where you have no terminal to
work out why, so this check is worth the two seconds.

It will refuse to copy `relay/`, `tests/`, `tools/`, `node_modules/`
and `.git/`. Those belong on the SSD or the server.

**Write down the fingerprint it prints at the end.** It looks like
this:

```
DRIVE FINGERPRINT  6a654a3f11e8ecce
```

The first eight characters are enough. Put them somewhere that is
**not the drive** — a note on your phone is fine. `PREFLIGHT.html`
shows the same value every time you run it, and if it ever comes up
different, either you rebuilt the drive or a machine wrote to it.

### 1.3 Open PREFLIGHT first

`E:\FieldKit\PREFLIGHT.html` is the gate. On a machine you own, this is
ten seconds of habit. On a school or library PC it is the difference
between typing your passphrase somewhere safe and typing it somewhere
that is watching.

1. Open it in Chrome or Edge (the drive check needs a folder picker
   that Firefox and Safari do not have).
2. Press **RUN CHECKS**.
3. Press **CHECK THIS DRIVE** and pick the `FieldKit` folder on the
   stick — the folder itself, not the whole drive.
4. If you have a relay, type its URL and press **CHECK RELAY**.
5. Read the verdict at the top.

- **CLEAR TO PROCEED** — the OPEN FIELDKIT button works.
- **PROCEED WITH CAUTION** — read the findings, then tick the box if
  you still want to. Usually a browser extension, or a drive check you
  have not run yet.
- **DO NOT UNLOCK THE VAULT HERE** — the button stays dead. Use a
  different machine, or open FieldKit and stay in **guest mode**, which
  never asks for the passphrase and never touches the vault.

Read the box at the top of that page at least once. It is honest about
what it cannot see, and what it cannot see is most of a computer.

### 1.4 Open FieldKit

Open `E:\FieldKit\FIELDKIT.html` in Chrome. You should get the boot
screen, then a desktop with the modules grouped down the left side —
PROJECT, NOTES, VAULT, RELAY, TOOLS, SYSTEM.

If instead you get MODULE LOAD FAILURE, open
`FIELDKIT-STANDALONE.html` from the same folder. That one is a single
file and cannot hit the separate-script-file problem.

**Everything from here on works without the relay.** The vault runs
locally. The relay is what makes it the *same* vault on two machines.

---

## PART 2 — THE RELAY

**What this gives you:** the shared half. Both of you unlock the same
vault, and files uploaded on one machine appear on the other.

**What it is not:** the relay cannot read anything. Records arrive
already encrypted, files arrive as separately-encrypted chunks with no
filename and no ordering, and the manifest that ties the chunks back
into a file is itself a sealed record. This is not a policy — there is
no code path where the plaintext exists on that machine.

### 2.1 Upload the files

Into `/home/container/` on the Pterodactyl server:

```
server.js
start.js
fetch-tailscale.js
fetch-cloudflared.js
config.example.json
CONNECTIVITY.md
LARGE-FILES.md
README.md
cloudflared.example.yml
```

Set **MAIN_FILE** to `start.js`. `start.js` starts the side-cars (the
tunnel, and Tailscale if you use it) and then hands over to
`server.js`. Setting it to `server.js` also works and simply starts
neither.

### 2.2 Make config.json

Copy `config.example.json` to `config.json` and edit it. The example
file is heavily commented — every `"_name"` key is a note about the
key below it, and the relay ignores them.

The three things you must change:

**`provisionToken`** — a one-time secret that authorises creating the
vault. Generate one on your PC:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Paste the output in. It stops working the moment a vault exists, so it
never needs rotating — but do not reuse a password here.

**`port`** — match it to the container's allocated port. Note that
Pterodactyl sets `SERVER_PORT` at runtime and that **overrides** this
value, so if they disagree the panel wins. Check the panel for the real
number.

**`aiTargets`** — only matters if you want the AI relay. Delete the
entries or leave them; unreachable targets just report unreachable.

Leave `trustProxy` as `false` for now. Part 3 says when to change it,
and changing it early is the one mistake in this document that is
actually dangerous.

### 2.3 Start it and check

Start the server. The console should show the relay binding to a port.
Then, from a browser on any machine:

```
http://your-host:PORT/health
```

You want JSON with `"up": true` and `"vaultProvisioned": false`. If you
get nothing, the port is not open — that is Part 3's problem, not a
config error.

### 2.4 Create the vault

Which of these you are in depends on whether you already made a vault
before the relay existed. Both end in the same place.

**If you have not created a vault yet** — open FieldKit, and at the
`NO VAULT ON THIS TRANSPORT` screen set a password. Before doing that,
open **RELAY** → **RELAY LINK**, enter the relay URL and the provision
token, press SAVE, and reload. The vault is then created directly on
the relay.

**If you already made a vault** — which is the normal case, because
RELAY LINK is a module and modules only exist once a vault does, so
the first vault anyone creates is always local-only:

1. **RELAY** → **RELAY LINK**
2. Enter the relay URL and the provision token
3. Press **PROVISION THIS VAULT ON THE RELAY**

That uploads the vault header and every record you have already
written, then switches the running session onto the relay. No restart.

**SAVE does not do this.** SAVE writes the URL into settings for the
next boot; it has never been the step that puts data on the relay.
If the boot screen says `NO VAULT ON RELAY — reachable · open RELAY
LINK and press PROVISION`, this is the button it means.

Afterwards, **clear the provision token**. It cannot be used again
while a vault exists, but there is no reason to leave it in browser
storage. (PROVISION clears it for you.)

Your password never leaves the machine. What the relay stores is a
hash of a key derived from it, which is enough to check you know the
password and not enough to work out what it is.

Confirm it took: `/health` should now report
`"vaultProvisioned": true`, and RELAY LINK's CURRENT SESSION panel
should show TRANSPORT: RELAY with STORE STATE: ONLINE.

---

## PART 3 — THE SUBDOMAIN AND THE TUNNEL

**What this gives you:** the relay reachable from the school network.

Right now it is on something like `http://host:25569`. Three things are
wrong with that, and any one of them is enough to get it blocked:
the port is not 80 or 443, the traffic is plain HTTP, and the
destination is a bare host nobody has categorised. `relay/CONNECTIVITY.md`
goes into why. The fix is a Cloudflare Tunnel, which makes an
**outbound** connection from the container to Cloudflare and serves
your hostname over port 443 with a real certificate.

### 3.1 Why not the way Cloudflare documents it

Cloudflare's walkthrough has you run `cloudflared tunnel login`, then
`tunnel create`, then `tunnel route dns` — three interactive commands
**on the machine hosting the tunnel**.

A Pterodactyl console is not a shell. It is one process's stdout with
an input box wired to that process's stdin. There is nowhere to type
those commands. If you follow the standard guide you will get to step
two and be stuck, and it will not be obvious why.

So: create the tunnel **in the dashboard** instead. Cloudflare keeps
the configuration and gives you a token. The container only ever runs
`cloudflared` with that token; it creates nothing.

### 3.2 Create the tunnel

1. <https://one.dash.cloudflare.com> → **Networks** → **Tunnels**
2. **Create a tunnel** → connector type **Cloudflared** → name it
   `fieldkit-relay` → **Save**
3. An install page appears with commands for various platforms.
   **Ignore the commands.** You want one thing off this page: the long
   token inside them, which is the last argument after `--token`. It
   starts with `ey` and runs about 180 characters. Copy it.

If you navigate away before copying it, open the tunnel again and use
**Configure** → the token is shown there too.

### 3.3 Add the subdomain

This is the part with no command. It is a form:

1. On the tunnel → **Public Hostname** → **Add a public hostname**
2. **Subdomain**: `relay`
3. **Domain**: your domain from the dropdown
4. **Path**: leave empty
5. **Service** → type **HTTP**, URL `127.0.0.1:8080`
6. **Save**

You now have `relay.yourdomain.com`. The DNS record was created for
you — do not add a CNAME by hand. Cloudflare writes a proxied record
pointing at the tunnel's UUID, which is not something you could
usefully type yourself.

> **The port in step 5 must be the port the relay actually listens
> on.** That is `SERVER_PORT` from the panel, not necessarily the
> `8080` in the example. Getting it wrong gives you **error 502** from
> the hostname while the relay is running perfectly — which reads like
> a relay fault and is not one.

`HTTP` rather than `HTTPS` is correct here. That leg is inside the
container, from cloudflared to the relay over loopback. The encryption
that matters is between the browser and Cloudflare, and that is
handled for you.

### 3.4 Get cloudflared onto the container

On your PC:

```bash
node relay/fetch-cloudflared.js
```

That downloads the linux/amd64 build into `relay/cloudflared-bin/` and
verifies it really is a Linux binary rather than an HTML error page —
worth checking, because a redirect or a rate-limit page would download
successfully and then fail at startup with something unhelpful.

Upload the result to `/home/container/cloudflared-bin/cloudflared`.

### 3.5 Wire it up

In `config.json`:

```json
"cloudflared": {
  "token": "eyJhIjoiN...the-long-token..."
}
```

Restart. The console should show cloudflared starting **before** the
relay binds, and the tunnel should go green in the dashboard within a
few seconds.

The token is a credential — anyone with it can publish traffic through
your tunnel. `config.json` is gitignored for exactly this reason.
`start.js` deliberately does not print it to the log, because
Pterodactyl keeps console scrollback.

If cloudflared fails, the relay still starts and still serves on its
forwarded port. A side-car failure must never take the relay down —
but it does mean the hostname is dead while the direct port works,
which is a confusing pair of symptoms if you do not know to expect it.

### 3.6 Test, then lock it down

Check `https://relay.yourdomain.com/health` in a browser. You want the
same JSON as before, now over HTTPS with no port.

Then, and **only** once that works:

```json
"host": "127.0.0.1",
"trustProxy": "loopback"
```

Restart, and close the forwarded port in Pterodactyl.

Both lines matter and the order matters:

- `host` on loopback means the relay is no longer reachable except
  through the tunnel. That is the point — one front door.
- `trustProxy` lets the relay read the real client address out of
  `CF-Connecting-IP`. Without it every request looks like it came from
  127.0.0.1 and the entire rate limit becomes one shared bucket for
  the whole internet.

**Do not set `trustProxy` before the relay is behind the tunnel.** On a
publicly forwarded port that header is written by whoever is calling,
so believing it lets anyone reset their own rate limit — including the
limits protecting the unauthenticated `GET /vault`. This is the one
step in this document where doing it early is worse than not doing it
at all.

### 3.7 Point FieldKit at the new address

**RELAY LINK** → `https://relay.yourdomain.com`, no port. Then
**RELAY** → **LINK DOCTOR**, which probes the connection and names the
specific failure if there is one, rather than leaving you guessing
between "blocked", "refused" and "something else answered".

---

## PART 4 — THE SECOND PERSON

They need three things: the drive (or a copy of the files), the relay
URL, and the vault password.

1. Copy `E:\FieldKit\` to their drive, or run
   `node build.js --deploy <their-drive>` on your PC.
2. They open `FIELDKIT.html`, go to **RELAY LINK**, enter the relay URL
   and **no** provision token — the vault already exists.
3. They unlock with the shared password.

They now have the same vault. Set a display name each in **SETTINGS**,
so records carry an author and you can tell who wrote what.

**The password is the whole thing.** There is no reset, no recovery
email, no support. If both of you forget it, the data is gone — that
is what "the relay cannot read it" means in practice. Write it down
somewhere physical, and make a recovery key (**VAULT** → **SAVE
CODES**) before you have anything you would miss.

---

## PART 5 — GIT, AND WHAT GOES WHERE

You have two places to put project data and they are not
interchangeable. The split is simple:

| | **Git** | **The vault** |
|---|---|---|
| Good at | versions, diffs, merges, history | encryption, reachability, secrecy |
| Use for | scenes, scripts, models, textures | plans, keys, notes, anything private |
| The test | "losing this would hurt" | "showing this would hurt" |

Godot scenes and Blender files belong in Git with LFS. They change
constantly, you will want to see what changed and go back, and neither
of those is something the vault does. **PROJECT** → **GIT CONSOLE**
walks through setting that up, including LFS from day one, which is
much easier than adding it after you have committed a 400 MB `.blend`.

The vault is for the things you would not push to a repo: design
documents you are not ready to share, credentials, the decision log,
and any large file you want on both machines without putting it in
version control. **PROJECT** → **VAULT FILES** handles those — it
splits a file into chunks, encrypts each one separately, and uploads
them. The relay stores bytes and learns nothing.

---

## PART 6 — SHIPPING AN UPDATE

### What it actually is

This is a remote-code path into the application that holds the vault.
Whoever decides what FieldKit downloads next can hand over a modified
`core/crypto.js`, and the build that quietly copies your passphrase
looks exactly like the build that does not. Publishing a SHA-256 beside
the file proves nothing — anyone who can replace the file can replace
the hash next to it.

So the trust lives in a **key**, not in the server:

```
  YOUR PC                      THE RELAY                  THE DRIVE
  ─────────────────────────    ────────────────────       ──────────────────
  release-key.json                                        core/update-key.js
  (private, never leaves)                                 (public, in the build)
        │                                                        │
        │ node build.js --release                                │
        ▼                                                        │
  release/                     upload by hand                    │
   release.json  ──────────────────────────►  data/updates/      │
   FIELDKIT-STANDALONE.html                        │             │
   OUTPOST-STANDALONE.html                         │             │
                                                   ▼             ▼
                                          UPDATER downloads, then verifies
                                          the signature against the key it
                                          already had. No match, no update.
```

**The relay is assumed hostile.** It holds no key and is never asked
whether a release is good. A relay that is taken over completely can
withhold an update, serve a stale one, or serve rubbish — and the worst
any of those achieves is leaving you on the version you already have.

### Once, ever: make the key

```bash
node tools/make-release-key.js
```

Two files come out:

- `release-key.json` — the **private** half. Gitignored. **Never upload
  this, to Pterodactyl or anywhere else.** Anyone holding it can hand
  FieldKit a modified build that verifies perfectly.
- `core/update-key.js` — the **public** half. Committed, and it ships
  inside every build, which is what lets the app verify without asking
  the relay anything.

It prints a fingerprint. **Write it down somewhere that is not the
drive.** UPDATER displays the fingerprint of whatever signed a release,
and comparing it to what you wrote down is the one check that does not
pass through the relay.

The tool refuses to overwrite an existing private key. Rotating means
deleting it deliberately — and every older release stops verifying the
moment the new public half ships, which is the point of rotating.

### Every time: publish

```bash
node build.js --release "what changed"
```

That rebuilds both standalone files, hashes them, signs the result, and
then — the part that matters — **verifies its own output against the
public half before writing it**, and checks that `core/update-key.js`
actually carries that public half. A build signed with a key no client
has would be rejected everywhere with nothing visibly wrong on the
relay.

You get a `release/` folder:

```
release/
  release.json                 version, notes, per-file size + sha256, signature
  FIELDKIT-STANDALONE.html
  OUTPOST-STANDALONE.html
```

Upload **the contents of `release/`** into the relay's `data/updates/`
— same as any other Pterodactyl file upload. Then in `config.json`:

```json
"updates": { "enabled": true }
```

The notes are deliberately **outside** the signature. They are prose
for a human, they change nothing about what gets installed, and the
client must never decide anything from them.

### Every time: install

On the machine being updated:

1. **SYSTEM → UPDATER → CHECK.**
2. It downloads, re-hashes each file against a number that was *inside*
   the signature, and checks the signature against the key built into
   the running app.
3. Only if all of that passes does it say **VERIFIED** and offer the
   file. Compare the fingerprint it shows to the one you wrote down.
4. Save the downloaded `FIELDKIT-STANDALONE.html` **over** the one on
   the drive.

Then close the tab and reopen it. That is the whole install.

### Why you save a file by hand

`file://` cannot write to the drive it was loaded from. There is no API
for it and there should not be — a page that could overwrite its own
origin on disk is a worse problem than the one it solves. So an update
ends with you saving one file over another, and that only works because
the update **is** one file.

Which is also the limit: `--release` ships the **standalone builds
only**, not the 74-file payload. New models, new vendor files, or
anything outside the two HTML files still needs

```bash
node build.js --deploy E:\
```

with the drive plugged into the PC. The updater is for "the app
changed", not "the drive changed".

### Things it does on purpose

- It says **OFFERED**, not **SAVED**, because `ui.download` cannot tell
  whether the browser actually wrote anything, and claiming it did is
  how someone goes looking for a file that was silently blocked.
- A correctly-signed release **older** than what you are running is
  shown, labelled, and warned about rather than hidden. A relay
  offering a step backwards is either a stale upload or a rollback
  attempt, and either way the answer is to say which.
- Vault token only. A messaging session is not enough, and OUTPOST
  cannot fetch updates — the 401 says so out loud rather than failing
  vaguely.

---

## WHEN SOMETHING IS WRONG

Start with the app, not the terminal — on the Chromebook there is no
terminal, and the app is built to diagnose itself.

- **TOOLS → TERMINAL**, then type `setup`. It reads live state and
  tells you which step you are actually on and the single next thing
  to do.
- `doctor` in the same place runs the quick self-test.
- **RELAY → LINK DOCTOR** for anything network-shaped.
- **SYSTEM → DIAGNOSTICS** → FULL SYSTEM EXERCISE for the deep pass.

A few failures and what they actually mean:

| Symptom | Usually |
|---|---|
| MODULE LOAD FAILURE on the drive | Machine blocks separate script files — open `FIELDKIT-STANDALONE.html` |
| **Boot says NO VAULT ON RELAY** | **RELAY LINK → PROVISION THIS VAULT ON THE RELAY. SAVE alone does not upload anything** |
| Everything in the console looks empty | The relay is not serving the vault; provision it, and the records come back |
| **Pterodactyl stuck on "Starting"** | **The egg's done-string never matched. Not a relay fault — see below** |
| **`/health` says `no such route`** | **Read the 404 body: it names the path the relay saw and the routes it has** |
| Relay healthy in logs, unreachable | `"host": "127.0.0.1"` set before the tunnel exists. Use `0.0.0.0` until then |
| 502 from `relay.yourdomain.com` | The tunnel's service port ≠ the relay's real port |
| Hostname dead, direct port fine | cloudflared did not start — check the console for its startup line |
| `/health` says `vaultProvisioned: false` after setup | The provision step did not complete; re-enter the token and reload |
| Everyone shares one rate limit | `trustProxy` not set — but only set it once you are behind the tunnel |
| Uploads fail near a round number | Blob quota. `blobQuotaBytes` in `config.json`; raise it if the disk has room |
| **PREFLIGHT says DO NOT UNLOCK** | **Read the reason at the top. See below — some of them are the machine, one of them is you** |
| PREFLIGHT cannot check the drive | Firefox and Safari have no folder picker. Use Chrome or Edge |
| PREFLIGHT finds no `drive-manifest.json` | Drive was built before manifests existed. Re-run `node build.js --deploy` |

### PREFLIGHT said stop

Each blocking finding means something specific, and two of them are
about the drive rather than the PC.

- **Files verified byte for byte — FAIL.** Something wrote to the
  drive. Do not run FieldKit off it. Re-deploy from the SSD, and treat
  the machine that last had the stick as suspect.
- **Files that should not be here — FAIL.** An `autorun.inf`, a `.lnk`,
  or a loose executable. Same answer: re-deploy, and scan the stick
  from a machine you trust.
- **Native code check — FAIL.** A browser extension is sitting in front
  of the crypto, the clipboard, or the network. Not necessarily
  malicious — but it can read what you type. Try a private window with
  extensions disabled, or a clean profile.
- **Remote control (webdriver) — FAIL.** The browser is being driven by
  automation software. Everything you type is visible to whatever is
  driving it. Walk away from this machine.
- **Manifest fingerprint mismatch.** The file list has been edited.
  Compare against the eight characters you wrote down at deploy time.
- **Clock disagreement over five minutes.** Fix the machine's clock;
  TLS will fail and your work will be dated wrongly.

If the machine is the only one available, open FieldKit anyway and stay
in **guest mode**. It never asks for the passphrase and never touches
the vault, so a compromised PC gets nothing.

And read the box at the top of PREFLIGHT once. A clean result means the
specific problems it knows how to look for were not there. It cannot
see a keylogger, and it says so.

### "Starting" forever

Pterodactyl decides a server has started by **matching a string in its
stdout** — the egg's Startup Configuration → Done string. It does not
watch the port. If nothing matches, the relay runs perfectly and the
panel sits on "Starting" indefinitely, no crash and no error. Restarts
then take the full kill timeout, because the panel never believed it
was up.

**If you used the `node.js generic` egg, this is guaranteed to happen**
— it ships with its done-strings left as the literal placeholders
`"change this text 1"` and `"change this text 2"`, which no program
will ever print.

Fix it at Admin → Nests → your egg → **Configuration** → **Startup
Configuration**:

```json
{
    "done": [
        "Server started",
        "fieldkit-relay listening on"
    ]
}
```

The relay prints both. Either alone is enough; both are listed so the
egg survives a reworded banner. Note this is an **admin-side** change
to the egg, not a per-server setting.

That egg has a second bug worth fixing while you are in there: its
startup command tests `[[ "${MAIN_FILE}" == "*.js" ]]` with the glob
quoted, which is a literal string comparison rather than a pattern
match. It never matches, so every `.js` file is run through
`ts-node --esm` instead of `node`. Drop the quotes around `*.js`.

This one is worth knowing because it **hides other problems**: while the
panel says "Starting" it is natural to assume the relay never came up,
and go looking in completely the wrong place.

### "no such route"

The 404 answers itself now. It comes back as:

```json
{
  "error": "no such route",
  "saw": { "method": "GET", "path": "/health" },
  "routes": ["GET  /health", "GET  /vault", "..."]
}
```

- `saw.path` **≠ what you asked for** → something between you and the
  relay is rewriting the path.
- `saw.path` **is right, but the route is missing from `routes`** →
  that container is running an older `server.js`. Re-upload it. The
  boot log prints the same list, so you can check without a request.
- **No JSON at all** → you are not talking to the relay. Note that
  `8080` is a common Pterodactyl *panel* port, and it is the default in
  `config.example.json` — pointing the tunnel at `8080` when the relay
  is on its allocated port lands you somewhere else entirely.
