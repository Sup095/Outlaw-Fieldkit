# FieldKit Relay

Encrypted blob store + AI proxy. Runs in a Pterodactyl container.

**Zero npm dependencies** — pure Node `http`. No `npm install`, no `node_modules`,
nothing to break when the container restarts.

## What it can and cannot do

It stores ciphertext it cannot read. The client derives the encryption key from the
master password and never sends it. The server only ever holds:

- the vault header (salt + a password-wrapped key, useless without the password)
- record bodies as AES-GCM ciphertext
- record metadata in plaintext: `id`, `type`, `updatedAt`, `schemaVersion`

That metadata is the deliberate trade: it is what makes sync possible. The relay
therefore knows *how many* notes exist and when they changed, but not what they say.

Mutating Bastion actions (kill-switch, restarts) live at `POST /actions` and are
**tailnet-only** — see [Quick actions](#quick-actions-tailnet-only) below and
`FIELDKIT_PROJECT.md` §9D. They are off by default and never ride the public leg.

## Setup

1. Upload `server.js`, `start.js`, `fetch-tailscale.js`, `fetch-cloudflared.js`,
   `config.example.json`, `CONNECTIVITY.md`, `cloudflared.example.yml`,
   `LARGE-FILES.md` and this README to the container.

   `start.js` is the Pterodactyl **MAIN_FILE** if you are using either side-car —
   the Cloudflare Tunnel (CONNECTIVITY.md) or Tailscale-in-container (below).
   Leaving it out is why those sections would otherwise fail with "cannot find
   module". Running `server.js` directly still works and simply starts neither.

   The two `fetch-*.js` scripts run on **your PC**, not here. They download the
   Linux binaries and verify them; you upload the results. There is no way to
   fetch them from the container, because a Pterodactyl console is one process's
   stdout rather than a shell.
2. Copy the example config and edit it:
   ```
   cp config.example.json config.json
   ```
3. Set `provisionToken` to a long random string. Generate one with:
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
4. Fill in `aiTargets`. Lowest `priority` wins; the relay fails over automatically
   when the preferred target is unreachable.
5. Set the Pterodactyl **MAIN_FILE** to `start.js` (or `server.js` if you want
   neither side-car).
6. Point the container's allocated port at `port` in the config. Pterodactyl
   sets `SERVER_PORT` at runtime and that **overrides** `port`, so if the two
   disagree the allocation wins — check the panel for the real number before
   pointing anything else at it.

## First run

In FieldKit, open **RELAY LINK**, enter the relay URL and the provision token, press
SAVE, then restart FieldKit. The first boot creates the vault and uploads the header.

**Clear the provision token afterwards** — it only works once, while no vault exists,
but there is no reason to leave it sitting in browser storage.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | liveness + whether a vault exists |
| GET | `/vault` | none | see below |
| POST | `/vault` | provision token | first run only, 409 if a vault exists |
| PUT | `/vault` | bearer | password change (re-wrapped header) |
| GET | `/records` | bearer | metadata only, no ciphertext |
| GET/PUT/DELETE | `/records/:id` | bearer | `id` must match `[A-Za-z0-9_-]{1,64}` |
| GET | `/status` | bearer | read-only service probes, GET-and-report only |
| GET | `/ai/targets` | bearer | live health per target |
| POST | `/ai/chat` | bearer | proxies to LM Studio, `__target` forces one |
| GET | `/blobs` | bearer | index: key, size, date, plus usage vs quota |
| GET/PUT/DELETE | `/blobs/:key` | bearer | raw encrypted bytes, `key` must match `[a-f0-9]{32,64}` |
| GET | `/actions` | tailnet + bearer | list the whitelist |
| POST | `/actions` | tailnet + bearer | run one, body is `{ id }` and nothing else |
| GET | `/usage` | bearer | counters — never content |

## Blobs — encrypted file storage

The design argument is in **LARGE-FILES.md**; this is the endpoint that came out of
it. Records are JSON, so a `.blend` in one would need base64 (+33%) and three
copies in memory at once. Blobs take raw bytes instead.

**This is the dumbest route on the relay, on purpose.** It stores bytes under a key
and hands them back. It does not parse them, does not know what file they belong to,
does not know their order, and cannot tell one file's chunks from another's. The
client splits the file, encrypts each chunk under its own IV, and writes the
manifest — name, size, ordered chunk list — as an ordinary **sealed record**.

Two consequences, both deliberate:

- The relay cannot reconstruct a file even in principle. It holds an unordered heap
  of unlabelled ciphertext. There is a test that asserts exactly this.
- **Lose the manifest and the file is gone**, though every byte is still here.
  Manifests are records, so they ride along in vault backups; blobs do not. FieldKit's
  VAULT FILES panel has VERIFY (are all my chunks present?) and FIND ORPHANED CHUNKS
  (are there chunks no file points at?) for the two halves of that gap.

**Not tailnet-only.** Unlike actions, this is data sync — reaching your own files
from a school Chromebook is the entire point. It authenticates like `/records`.

Two knobs, both in `config.json`:

- `blobMaxBytes` (8 MB) — a per-**chunk** cap. The client splits before uploading, so
  raising this does not let bigger files through; it only makes each request larger.
- `blobQuotaBytes` (2 GB) — total across all blobs. Set it below what your plan
  actually allows. Over it, uploads get a `507` naming the numbers rather than
  filling the volume and taking the relay down.

Oversized chunks get a real `413` with an explanation, not a connection reset —
a client that sees a reset cannot tell "this chunk is too big" from "the relay is
down", and retries forever.

## Quick actions (tailnet-only)

This is the kill switch. It is off until you configure it: with no `actions` in
`config.json`, the relay has no ability to change anything.

**The client sends an id.** Not a command, not arguments, not a flag. `cmd` and
`args` come from your config file and are spawned **without a shell**, so there is
no parsing for a semicolon or a backtick to escape into. A caller who can shape any
part of a command line turns the whitelist into decoration; that is why the request
body has exactly one field the server reads.

Four gates, in order:

1. **Tailnet** — checked *before* auth, so a public caller learns the door is shut
   without learning whether their token was any good.
2. **Bearer token** — same as every other authenticated route.
3. **Whitelist** — an id not in `config.json` is not an action. 404.
4. **Cooldown** — per action, so a stuck client cannot restart a server in a loop.

### A trusted proxy is never the tailnet

`cloudflared` runs beside the relay and connects to it **from 127.0.0.1**. If
loopback counted as the tailnet, every request off the public internet would arrive
pre-approved.

That started as a special case about loopback, which left the same hole open one
address over: `trustProxy` also accepts an array, and a reverse proxy on a Tailscale
address (nginx on the bastion at `100.64.0.9`, say) sits inside `100.64.0.0/10` — so
the range check waved through everything it forwarded from the internet.

So the rule is stated once, generally: **a peer whose `X-Forwarded-For` we are
willing to believe is a public ingress, whatever its address.** `onTailnet()` refuses
any peer that `peerIsTrusted()` accepts, before it looks at the address at all.
Turning on a tunnel closes this door by itself rather than requiring you to remember
a second switch.

The practical consequence: **with a proxy configured, requests through it are refused
for actions — including `curl` from the box itself when the proxy is on loopback.**
That is correct. Test from a direct tailnet peer.

Putting an address in **both** `trustProxy` and `extraTailnetIps` is a contradiction.
The relay resolves it safely (public ingress wins) and logs an ERROR at startup,
because you almost certainly did not mean it.

The relay says which mode it is in at startup:

```
[INFO] actions: restart-minecraft, recent-logs (tailnet-only)
[INFO] trustProxy is set, so the trusted proxy is treated as public ingress — actions require a direct tailnet peer, not a forwarded request
```

## Usage counters

`GET /usage` returns how often each route was hit, which AI target served each
request, how often the chain fell back to a lower tier, and per-action outcomes.

**Counters only.** Nothing in `usage.json` identifies a client: no prompts, no
message contents, no record contents, no addresses. Record ids are counted *by
shape* — `GET /records/:x`, never the id itself, because a counter keyed by record
id would be a list of which records exist and how often each is touched, which is
precisely the metadata a zero-knowledge store is supposed not to leak.

> **What this does not cover.** The relay's own console log *does* record the client
> address on every request, and Pterodactyl keeps that console output on disk. The
> counters are clean; the request log is not. `GET /usage` says so in its own
> response rather than letting the counters' privacy imply the whole relay's.

**No counter key ever comes from a request.** Keys are drawn from the fixed route
table, and anything unrecognised collapses into `GET /(unrecognised)`; a refused
action id is counted under `(unrecognised)` rather than under itself. Otherwise
`GET /<8000 characters>` would mint a permanent 8 KB key — unauthenticated, surviving
restart through `usage.json`, and re-serialised synchronously by the flush timer
every 30 seconds. The key space is bounded by a constant.

Written to `data/usage.json` every 30 seconds rather than on every request; a
restart loses at most that much counting, and the file records `lastFlush` so the
gap is visible rather than pretended away. Set `usageLog: false` to count nothing.

### Why `GET /vault` is unauthenticated

You need the salt and the wrapped key *in order to derive* the token that would
authenticate you. That is inherent to a zero-knowledge design, not an oversight.
The defences are the PBKDF2 cost (600k iterations) and hard rate limiting —
10 requests per minute per IP on that route specifically.

This means the security of everything rests on the master password. Use a long one.

### CORS

A `file://` page sends `Origin: null`, so the relay must accept it. CORS is therefore
**not** a security boundary here — the bearer token is, and every mutating route
checks it.

## Verified behaviour

Covered by tests run against a live instance during development:

- provisioning refuses a missing, wrong, or replayed token
- unauthenticated, wrong-token, and malformed-bearer requests are all rejected
- record ids are validated, not sanitised; path traversal cannot read or write
  outside `data/records/` even with valid auth
- oversized bodies are refused rather than buffered
- rate limiting engages on the unauthenticated vault route
- AI failover: priority 1 when healthy, priority 2 when it drops, 503 with
  per-target health when everything is down
- plaintext never reaches server disk
- a spoofed `X-Forwarded-For` cannot reset a rate limit when `trustProxy` is false
- actions: an unknown id is refused; extra fields in the body (`cmd`, `args`,
  `shell`) are ignored rather than executed; an id containing shell
  metacharacters is just an unknown id; a missing binary fails instead of
  throwing; cooldowns refuse repeats and say how long is left
- the action list never leaks the configured command line to the client
- with `trustProxy: "loopback"`, actions from loopback are refused with 403
  **before** auth, a forged `X-Forwarded-For`/`CF-Connecting-IP` does not open the
  gate, and read-only routes keep working over the tunnel
- with `trustProxy` as an **array**, a listed peer is refused actions even when its
  address is inside the Tailscale range, and an address in both `trustProxy` and
  `extraTailnetIps` is reported as an ERROR at startup
- usage counters never contain a record id — only `GET /records/:x`
- three unknown paths and a 200 KB action id mint **no** new counter keys; they
  collapse into fixed buckets, and every route key stays under 40 characters
- an oversized body returns HTTP 413 with a reason, rather than resetting the
  connection (which the client could not tell apart from the relay being down)

Blobs, same method:

- every route is authenticated; the index is not readable anonymously
- a blob round-trips byte for byte, and what is on disk is **exactly** what was
  sent — nothing parsed, re-encoded, or base64'd on the way through
- blob keys are validated, not sanitised: `../`, percent-encoded traversal,
  uppercase, dots and dashes are all refused, and the vault header is provably
  untouched afterwards
- an oversized chunk returns 413 naming `blobMaxBytes`, stores nothing, and the
  relay keeps serving
- the quota returns 507 with the actual numbers and how to raise it; overwriting an
  existing key at the ceiling still works, so a client retrying a chunk is not locked
  out; deletion frees the quota immediately
- **after storing every chunk of a file, the relay holds nothing that says which
  chunks belong together, in what order, or under what name** — and no record was
  created either
- usage counts blob routes by shape (`/blobs/:x`), never by key
- an empty body is a 400; POST and PATCH do not fall through to another handler

58 checks in `test-actions.js` and 40 in `test-blobs.js`, against live relay
processes.

## Tailscale inside the container (optional)

Only needed if the relay must reach an LM Studio that is **not** on the same
network as the Pterodactyl host. If every AI target is on the host's LAN, use LAN
IPs and skip this entirely — fewer moving parts.

### Why the normal install does not work

Tailscale usually needs `/dev/net/tun` and the `NET_ADMIN` capability. A Pterodactyl
container is unprivileged and has neither, and the panel gives you no way to grant
them. So the standard install cannot work here.

### What does work: userspace networking

`tailscaled --tun=userspace-networking` needs no TUN device and no special
capabilities. Instead of a network interface it exposes a local HTTP/SOCKS proxy.
`server.js` speaks to that proxy directly (see `httpProxy` in the config), using raw
`http.request` rather than `fetch`, so no dependency is needed.

### Setup

**Note for Windows:** you need **linux/amd64** binaries — they will never run on your
own machine, they are only for the container. Windows has no reliable built-in way to
open a `.tgz`, so use the helper:

```
node relay/fetch-tailscale.js
```

It queries Tailscale for the current stable version, downloads the tarball (~37 MB),
and unpacks `tailscaled` and `tailscale` into `relay/tailscale-bin/`. That folder is
gitignored — the binaries are ~70 MB and don't belong in the repo.

1. Run the fetch script above.
2. Upload **both** files from `relay/tailscale-bin/` into `/home/container/`.
   The panel's file manager works, but ~70 MB over the web uploader is slow — SFTP
   (WinSCP or FileZilla, using the SFTP details on the server's Settings tab) is
   much faster.
3. **Mark both executable.** SFTP clients let you change permissions via right-click →
   Properties/Permissions; set them to `0755`. If startup reports "permission denied"
   or "not found" for a file that is clearly there, this is why.
4. Create `/home/container/tailscale-authkey.txt` containing **only** the auth key,
   no quotes and no trailing text. (Or set a `TS_AUTHKEY` env var if you would rather
   add an egg variable — the env var wins if both exist.)
5. Set `MAIN_FILE` to **`start.js`** instead of `server.js`.
6. Set `"httpProxy": "http://127.0.0.1:1055"` in `config.json`.
7. Restart. The console should show tailscaled starting, then
   `tailscale proxy listening on 127.0.0.1:1055`, then the relay.

If step 7 shows `WARNING: proxy never came up`, the daemon failed — check the console
above it for the tailscaled error, usually a bad auth key or a missing executable bit.

`start.js` is safe to use as `MAIN_FILE` unconditionally — with no auth key present
it just starts the relay directly.

### Security measures — do all of these

The container is internet-exposed on a forwarded port, so a Tailscale node running
inside it is the highest-value thing to lock down. In order of importance:

**1. Use an ephemeral, tagged, pre-authorized auth key.** Generate it at
*Settings → Keys* in the Tailscale admin console with:
- **Ephemeral: on** — the node vanishes from your tailnet when the container stops,
  instead of accumulating dead machines that still hold ACL grants.
- **Reusable: off** if you can tolerate re-issuing on each redeploy. Reusable keys are
  a standing credential.
- **Tags: `tag:fieldkit-relay`** — this is what the ACL below binds to. An untagged
  node inherits *your user's* access, which would give a public-facing container the
  run of your entire tailnet.

**2. Write an ACL that grants the tag only what it needs.** In the admin console's
Access Controls, the relay should reach LM Studio's port on two machines and nothing
else:

```json
{
  "tagOwners": {
    "tag:fieldkit-relay": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src":    ["tag:fieldkit-relay"],
      "dst":    ["100.64.0.11:1234", "100.64.0.12:1234"]
    }
  ]
}
```

Critically, **no rule lists `tag:fieldkit-relay` as a `dst`**, so nothing on the
tailnet can dial into the container either. Test rules before applying — the admin
console has a preview that shows what a tag can reach.

**3. `--shields-up`** is already passed by `start.js`. It refuses all inbound
connections regardless of ACL, as a second layer. The relay is reached over its
forwarded port, never over the tailnet, so nothing legitimate dials in.

**4. `--accept-routes=false` and `--accept-dns=false`**, also already passed. The
container should not inherit subnet routes or your tailnet's DNS.

**5. Never advertise routes or an exit node** from this container. `start.js` does
not, and you should not add it. A public-facing container advertising a subnet route
would bridge the internet into your home network.

**6. Keep the auth key out of git.** `relay/tailscale-authkey.txt`, `relay/.tailscale/`,
and the binaries are all gitignored. `start.js` chmods the key file to 600 on read.

**7. Rotate the key if the container is ever compromised**, and revoke the node from
the admin console. Ephemeral keys make this mostly self-cleaning.

### Verifying it worked

`RELAY LINK → TEST LINK` in FieldKit. Hop 1 green plus both AI targets reachable
means the proxy path is working. Hop 1 green with targets down means the relay is
fine but cannot reach the tailnet — check that `httpProxy` is set and that the ACL
actually grants `tag:fieldkit-relay` those destinations.

## Pterodactyl says "Starting" forever

The process is running, the logs look right, nothing crashed — and the
panel never turns green. Stops and restarts take the full kill timeout
because the panel never believed it was up.

**This is not the relay.** Pterodactyl decides a server has started by
matching a string in its stdout — the egg's **Startup Configuration →
Done** array. It does not watch the port. If nothing matches, the
server runs perfectly and the panel sits on "Starting" indefinitely.

### The cause, if you used the `node.js generic` egg

That egg ships with the done-strings still set to their placeholders:

```json
{
    "done": [
        "change this text 1",
        "change this text 2"
    ]
}
```

Those are instructions to the egg's author that were never followed.
They will never appear in any program's output, so **no server using
this egg unmodified is ever marked as running.**

### The fix

Admin → Nests → your egg → **Configuration** tab → **Startup
Configuration**, and replace it with:

```json
{
    "done": [
        "Server started",
        "fieldkit-relay listening on"
    ]
}
```

Either line is enough on its own; both are listed so the egg keeps
working if the relay's banner is ever reworded. Restart the server —
it should go green within a second of the relay binding.

This is an **admin-side** change to the egg, not a per-server setting.
If you cannot reach the nest configuration, the alternative is to have
the relay print whatever string your egg is already looking for; ask
whoever runs the panel what it is.

### A second bug in that same egg, worth knowing about

Its startup command contains:

```bash
if [[ "${MAIN_FILE}" == "*.js" ]]; then node ...; else ts-node --esm ...; fi
```

The glob is **quoted**, which makes it a literal string comparison
instead of a pattern match. `start.js` is not the literal text `*.js`,
so the test always fails and every `.js` file gets run through
`ts-node --esm` — which will not load CommonJS `require()` at all.
Removing the quotes (`== *.js`) fixes it, or set the startup command
to run `node` directly.

Worth knowing because it hides other problems: while the panel thinks a
server is still starting, it is easy to assume the relay never came up
and go looking in the wrong place entirely.

## "no such route" from a path that should exist

The 404 body answers this itself. It contains:

```json
{
  "error": "no such route",
  "saw": { "method": "GET", "path": "/health" },
  "routes": ["GET  /health", "..."]
}
```

Read `saw.path` first:

- **`saw.path` is not what you asked for** — something between you and
  the relay is rewriting the path. A tunnel pointed at the wrong
  origin, or a proxy adding a prefix.
- **`saw.path` is right but the route is missing from `routes`** — this
  container is running an older `server.js` than you think. Re-upload
  it. The boot log prints the same route list, so you can check without
  making a request at all.
- **You get no JSON at all** — you are not talking to the relay.
  Something else is on that port, or the tunnel's service URL points
  somewhere else. Port `8080` is a common Pterodactyl **panel** port,
  and pointing a tunnel at it instead of the relay's allocated port is
  an easy mistake to make.

## The relay is up but nothing can reach it

Check the boot log for:

```
[WARN] host is 127.0.0.1, so this relay accepts connections from INSIDE
```

`"host": "127.0.0.1"` is correct **only** once a Cloudflare Tunnel is
running in front. Set that way with no tunnel, the relay is healthy,
the logs are clean, and it is unreachable — Pterodactyl's allocation
forwards to the container's address, not to loopback. Use `0.0.0.0`
until the tunnel works, then switch. See CONNECTIVITY.md step 6.

## Operational notes

- Writes are temp-file-then-rename, so a crash cannot leave a half-written record.
- Rate limit buckets are in-memory and reset on restart. That is abuse damping,
  not a security control.
- `data/` and `config.json` are gitignored. Back up `data/` — the ciphertext is
  useless to anyone else, but it is still the only copy of your notes.
- Losing both the master password and the recovery key means the data is
  unrecoverable. That is the design working, not a bug.
