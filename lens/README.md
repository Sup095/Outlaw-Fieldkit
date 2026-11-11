# lens: BROWSER's lighter mode

BROWSER's full mode runs every page on the server and sends it as video, about
11 MB a minute while it moves, across a home connection. Lens runs the page
in the person's own browser instead: [Scramjet](https://github.com/MercuryWorkshop/scramjet)
(a service worker that rewrites pages) and libcurl.js (TLS in the page, in
WebAssembly) send every connection the page makes over one WebSocket, using
the [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) protocol, to a
small rented server that opens them. A page costs what it weighs, and nothing
while you read it. The full mode stays, as the fallback and for what lens
cannot do (a page too heavy for an older computer, or a site that blocks
this server's address).

| file | what it is |
|---|---|
| `server.js` | The lens server: the client's files, `/lens/status`, `/lens/why`, and Wisp at `/wisp/<pass>/`. A pass is signed by the relay (`relay/lens-link.js`), names an account, and lasts 12 hours. It pulls the relay's public key, the admins' ALLOW list, and (with a read-only token) Linode's own transfer count. |
| `wisp.js` | Our Wisp v1 server. Every connection a page asks for goes through the relay's own guard (`relay/guard.js`): the block lists, private and cloud-metadata addresses, the filtering resolver, and the ports a page may open. Then the meter. UDP is refused. A person who reads slowly pauses their own sites, not the server. |
| `meter.js` | Bytes sent this month, against a ceiling, kept on disk, and a share per person per day. When the ceiling is reached, new connections are refused and BROWSER moves to the full mode. The provider's count, when ahead, wins. |
| `client/` | The lens page (`index.html`, `lens.js`): the toolbar, the history, the pass, and the messages it trades with BROWSER's panel (listed at the top of `lens.js`). It runs no site itself. Each site runs in a **slot** (`slot.html`, `slot.js`), Scramjet and all, on an origin of its own; `codec.js` masks addresses and names sites; `sw.js` is the service worker, which also catches a request Scramjet missed and fetches it through the lens rather than straight from the computer. |
| `egress.js` | Sites that refuse this server's address leave through an upstream proxy instead: YouTube ("Sign in to confirm you're not a bot") through Cloudflare WARP, or through proxy addresses you buy (SOCKS5 or HTTP, with a login). The guard has already judged and resolved the site; the proxy is asked for exactly that address. One person keeps one proxy, a failing one is rested a minute, and with none left the site opens directly. The list of proxies is `/srv/lens/egress.json` on the server (kept out of config.json because bought ones carry a login). |
| `warp/` | The `fk-warp` container: Debian's WireGuard tools make Cloudflare WARP its only way out (registered once, with the request WARP's own app makes, kept in `/srv/lens/warp`), and `socks.js` is a SOCKS5 door on the host's 127.0.0.1:1080 that opens addresses only, never anything inside. If WARP stops answering it restarts itself. |
| `patch-scramjet.js` | Our fixes to Scramjet 1.1.0, made when the image is built: the cookie wait that left Wikipedia white; an empty `url()` in a stylesheet that swallowed a bracket and hid half of YouTube's styles; a module script added by a page's own code that ran twice (CrazyGames' game frame); frames loaded with no Referer (CrazyGames' game files refused them); and WebSockets that lost their subprotocol and handed binary messages over in another frame's types (Photon, behind CrazyGames' multiplayer games). The build stops if any code it changes is not there exactly once. |
| `patch-libcurl.js` | Our fixes to libcurl-transport 1.5.2: the first requests after a page starts wait for libcurl's WebAssembly instead of failing ("wasm not loaded yet"), and a WebSocket's subprotocol is passed on. |
| `vendor/` | The exact versions of Scramjet, bare-mux and libcurl-transport, with their hashes; fetched at build, never committed. |
| `Dockerfile`, `Caddyfile`, `setup.sh` | The image, the HTTPS front (Let's Encrypt, and the slots' certificates on demand), and one script that installs or updates it all on the server. |

Setting it up: `tools/make-deploy.js` writes `deploy/lens.tar.gz`; on the
server, `sudo sh lens/lens/setup.sh <relay address> <lens host name>`. Then the
lens address goes in ADMIN CENTER (SERVICES), and BROWSER uses it.

**YouTube.** `setup.sh` starts `fk-warp` and writes `/srv/lens/egress.json`
once, with WARP as the only proxy. To add bought addresses (or use them
instead of WARP), edit that file and run `docker restart fk-lens`:

```json
{ "proxies": ["socks5://127.0.0.1:1080",
              "socks5://USER:PASS@203.0.113.7:1080",
              "http://USER:PASS@203.0.113.8:3128"] }
```

`hosts` may list the sites to send through them; left out, it is YouTube's.
`/lens/status` says `"youtube": true` while a proxy is usable, and the lens
page then plays YouTube itself instead of handing it to the full mode.

**Each site in a space of its own (0.16.3).** A site runs in a slot,
`s0.<lens host>` to `s15.<lens host>`, so the browser itself keeps its
storage, sign-ins, service worker and Scramjet's cookie jar apart from every
other site's and from the lens page, which holds the pass. The site a slot
belongs to is the registrable name (`example.co.uk`, `someone.github.io`).

- A slot given to a new site (after 16, the one used longest ago) is opened
  once with `?wipe=1`, and the server answers with `Clear-Site-Data`.
- Another site loading in a slot's page (a link, a redirect) is stopped
  before its scripts run and opened in its own slot. BACK and FORWARD cross
  slots.
- A popup or a new-window link to another site opens in that site's own
  slot, and the page that asked gets no window, as when a popup is blocked.
- A sign-in box one site frames into its page for another (Google's inside
  a game site) can be read by the page around it, so the lens page says STOP
  and offers to open that site on its own.
- The lens page believes a slot about its own site only: a page that got
  past Scramjet still cannot put another site's address in the bar.

This needs a DNS record, `*.<lens host>`, to the server (not proxied).
Caddy gets each slot's certificate the first time it is asked for, after
the lens server's `/lens/tls-ok/` says the name is a slot. Without the
record, the lens page finds no slots, runs every site in one shared slot on
its own origin, as before 0.16.3, and says in a bar that never goes away
not to sign in to anything.

Tests: `node tests/lens-wisp.test.js` (a real WebSocket client, real TCP
sites on loopback, the relay's real guard, the pass rules, the patch).

Licences: Scramjet is MIT. libcurl-transport is AGPL-3.0 and libcurl.js
LGPL-3.0. libcurl.js is served unmodified; libcurl-transport carries the fixes in `patch-libcurl.js`, made at build, and the page links both sources and FieldKit's, where the patch is.
