# The streamed browser

§14.11. A real Chromium, running in the relay's container, whose screen
is sent to the FieldKit panel as video and whose keyboard and mouse come
back over one WebSocket.

It replaces the fetch-and-rewrite proxy, which is still there and still
works as the fallback. If the container has no Chromium, the panel gets
the proxy and nothing breaks.

---

## Why it replaced the proxy

The proxy fetched a page, rewrote every URL in it, and served the result
from the relay's own origin. That works for documents and cannot be made
to work for applications:

- a single-page app routes on `location.pathname`, which the proxy path
  is not
- a bundle branches on its own hostname, which it no longer has
- a bot check wants a real browser to answer it, and there wasn't one

Every fix bought one site and cost another. The last one — moving the
visible address to the site's own path — traded a blank YouTube search
for a browser that dropped pages at random.

Here the browser **is** a browser. Pages render correctly because
nothing is rewritten. A bot check appears and the person solves it,
because there is a real human on the other end of a real browser and
that is exactly what those checks are for.

**Nothing here disguises anything.** Chromium identifies itself
honestly. No User-Agent is forged, no header is rewritten, nothing
pretends to be residential traffic. The reason bot checks stop being a
wall is that a person answers them, not that the relay slips past them.

---

## What it costs

| | |
|---|---|
| **Memory** | ~150 MB for Chromium plus 80–150 MB per active session. Six sessions fit in 4 GB alongside the rest of the relay. |
| **Sound** | With PulseAudio in the image (it is, from 2026-10-27) each session gets its own Chromium and its own silent sound card; what plays is sent as Opus while the panel's SOUND is on, and silence is not sent. About 350 MB per session (PSS, measured), plus a spare kept started. `"sound": false` goes back to one shared, muted Chromium. |
| **It is a picture** | FIND and zoom act on the real page; text is selected and copied through the page, and copy and paste work both ways. |
| **Downloads** | Saved to your device or encrypted into VAULT FILES; a page's "choose file" opens your own picker. |

---

**Seeing it live.** An admin (the vault holder, or a MESSAGES admin) has a
**USAGE** button in the browser's toolbar. It shows, every 4 seconds,
Chromium's CPU and memory across all its processes, each session, and
each open panel's bandwidth, video cap and encoder CPU. The relay reads
these from `/proc` (`proc-usage.js`), so they are Linux-only.

## What it fixes

**Requests.** The old browser could not help sending hundreds of them:
one article was two or three hundred proxied fetches, each one counted
by the rate limiter. A streamed session is **one** connection. The
page's requests happen inside the container and never reach the limiter.
`browserMax` is 60 a minute where `browseMax` had to be 3000.

**Isolation.** One Chromium **browser context** per account — Chromium's
own boundary, so separate cookies, storage, cache and history. Two
people on the same relay cannot see each other's sessions.

**Accounts.** The browser session is keyed to the **messaging account**.
One sign-in serves both apps. A vault token still works and gets its own
session, because OUTPOST has no messaging account.

**Clearing.** `COOKIES` forgets the jar. `WIPE` destroys the whole
browser context — not a best-effort clear, the context is gone.

---

## Setting it up

Since 2026-10-26 the relay's **code is inside the image**, together with
Chromium, cloudflared and tailscale. The server folder holds only
`config.json` and the `data/` the relay writes. No registry account is
needed: the image is built on Bastion 1 itself.

### 1. Build the image on Bastion 1

On the dev PC, `node tools/make-deploy.js` writes `deploy/bastion1.tar.gz`
and the exact commands into `deploy/NEXT-STEPS.txt`:

```bash
scp deploy/bastion1.tar.gz you@bastion-1:~/
```

```bash
ssh you@bastion-1 "rm -rf bastion1 && tar xzf bastion1.tar.gz && docker build -t fieldkit-relay:1 bastion1"
```

Pterodactyl (Wings) tries to download `fieldkit-relay:1`, cannot, finds the
image already on the machine under that name, and uses it. Its log says
"unable to pull requested image from remote source, however the image exists
locally". That warning is expected.

### 2. Import the egg and create the server

1. **Admin → Nests → Import Egg**: `relay/docker/egg-fieldkit-relay.json`.
   If an older FieldKit egg is there, delete it first, or import this one
   over it.
2. **Admin → Servers → Create New**:
   - Nest and Egg: the FieldKit Relay egg.
   - Docker image: `fieldkit-relay:1` (already selected).
   - Memory: **4096 MB**. Disk: as much as you like for vault blobs.
   - Allocation: any port. The relay listens on the port in `config.json`
     (25569) and cloudflared, inside the same container, reaches it there.
   - Startup: leave **Main File** as `/opt/fieldkit/relay/start.js` and
     **Config File** as `/home/container/config.json`.
3. When it has installed, upload **one file** into it:
   `deploy/relay-upload/config.json`.
4. Start it.

A fresh server has no `data/`: the vault is re-provisioned by the clients with
the `provisionToken`, and MESSAGES accounts must be made again. Register the
admin account named in `messaging.moderators` first.

Never upload `release-key.json`.

### Updating later

- **Code changed** (`_CHANGED.txt` says so): run the two commands in step 1
  again, then press **Restart** in the panel. Wings re-creates the container
  from the new image on every start.
- **Only config changed**: upload `config.json`, then Restart.

### 3. Memory

4 GB is comfortable for two people with headroom. 2 GB works with
`maxSessions` at 2–3. Below that, leave the streamed browser off.

### 4. Turn it on

In `config.json`:

```json
"browser": { "enabled": true, "dnsFilter": "adult", "maxSessions": 6 }
```

Leave `browse.enabled` on as well — that is the fallback.

### 5. Check the log

```
browser: streamed browser on — chromium at /usr/bin/chromium, up to 6 session(s), content filter: adult.
browser: every request it makes goes through the guard proxy. It cannot reach this relay's own API or any private address.
```

If instead it says **"no chromium binary was found"**, the image is
wrong or `browser.chromium` needs the path spelled out. The log lists
every path it tried.

---

## A second machine: browser helpers

When the relay has no free session, or is over its load line, new
sessions can go to a **browser helper**: this same image on another
machine, run as its own Pterodactyl server, so its processor and memory
show in the panel beside the relay's. The panel notices nothing: it
still talks only to the relay, which passes the stream through to the
helper over your home network or tailnet. The helper is never put on
the internet, and it answers nothing that does not carry a pass signed
by the relay.

1. **Build the image on the second machine** too, the same two commands
   as step 1 (Wings on that machine uses the local tag).
2. **Give it an allocation** in the panel: on that machine's node, a
   port on `0.0.0.0` (for example `25570`).
3. **Create the server**: same egg, that node, that allocation. Memory:
   about 400 MB per session; `maxSessions` is 8 by default. CPU: give it
   what you can spare (each session uses up to half a processor while its
   page moves).
4. **Upload its config.json**: `node tools/make-deploy.js` writes one to
   `deploy/helper-upload/config.json`, with your relay's browser and
   filter settings and the relay's public address
   (`helper.relayUrl`), from which the helper fetches the relay's key.
   Start it. Its log should say `have the relay's key`.
5. **Tell the relay**: in the relay's config, list the helper by an
   address the relay's container can reach, best the second machine's
   tailnet address:

   ```json
   "browser": { "helpers": ["http://100.64.0.12:25570"] }
   ```

   Restart the relay. Its log says how many helpers it has, and when one
   stops or starts answering.

A session stays on the machine that holds it. If a helper goes away,
new sessions simply stay on the relay. An admin's **USAGE** shows each
helper and its sessions.

---

## Content filtering

Every name the browser looks up is resolved **inside the relay**,
against the servers `dnsFilter` names. This is stronger than pointing
Chromium at a filtered resolver: those flags are version-dependent,
fall back silently, and are skipped entirely by a literal IP address.

| Setting | What it blocks |
|---|---|
| `adult` *(default)* | Pornography, plus phishing and malware. |
| `family` | The above plus proxies, VPNs, and forced safe search. |
| `security` | Malware and phishing only. No content filtering. |
| `system` | Nothing. Uses the container's own resolver. |

Filtering is **CleanBrowsing's** list, not one kept here. A blocked site
fails to resolve, and the panel says so in words rather than showing
Chromium's tunnel error.

`browse.blockHosts` and the downloaded blocklist apply here too — one
list for both browsers.

---

## The guard, and why the vault is still safe

The old browser had no network of its own. This one is a **real browser
inside the relay's container**, which is a genuinely different threat
model: without a boundary, a page could `fetch("http://127.0.0.1:25569/vault")`
and read the vault out of the relay it is running inside.

So Chromium is launched pointed at a proxy on loopback — `guard.js` —
and with `--proxy-bypass-list=<-loopback>`, which removes the one
exemption Chromium has by default. **Every** request it makes goes
through the guard: pages, subresources, XHR, WebSockets.

The guard:

- resolves every name itself, through the filtered resolver
- refuses every private and reserved range, checking **all** answers for
  a name, not just the first
- refuses any port other than 80, 443, 8080 and 8443
- applies the relay's own block list

Verified by driving a real browser at it: `http://127.0.0.1:<relay>/vault`,
`http://127.0.0.1:8080/` and `http://192.168.1.1:80/` are all refused.

Chromium's own sandbox is off (`noSandbox`), because a Pterodactyl
container does not grant the user namespaces it needs — left on,
Chromium will not start at all. What protects the relay is the guard and
the fact that the vault is encrypted with a key this process never
holds.

---

## Troubleshooting

**Every page is empty boxes.** No fonts in the image. The Dockerfile
installs `fonts-liberation`, `fonts-dejavu-core` and the Noto packages;
a slimmer base image will not have them.

**"chromium exited during startup".** Almost always a missing shared
library. The relay logs Chromium's last few lines of stderr, which name
it. The Dockerfile lists the closure explicitly for this reason.

**Pages load then die on anything heavy.** `/dev/shm` is 64 MB by
default. The relay already passes `--disable-dev-shm-usage`, which moves
those surfaces to `/tmp` — so `/tmp` needs the space.

**The stream connects and no frames arrive.** Frames are only encoded
while somebody is attached. If the panel is open and nothing is drawing,
check the relay log for a `guard:` refusal — a page that cannot load
anything has nothing to paint.

**It works, then the session vanishes.** `idleMinutes` (default 15). A
session nobody is watching is closed and its memory returned. This is
deliberate on a shared machine: an unwatched session should not sit
there signed in to things.
