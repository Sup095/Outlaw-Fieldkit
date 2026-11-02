# lens: BROWSER's lighter mode

BROWSER's full mode runs every page on the server and sends it as video, about
11 MB a minute while it moves, across a home connection. Lens runs the page
in the person's own browser instead: [Scramjet](https://github.com/MercuryWorkshop/scramjet)
(a service worker that rewrites pages) and libcurl.js (TLS in the page, in
WebAssembly) send every connection the page makes over one WebSocket, using
the [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) protocol, to a
small rented server that opens them. A page costs what it weighs, and nothing
while you read it. The full mode stays, as the fallback and for what lens
cannot do (YouTube will not play for a rented server's address; anything you
sign in to belongs there too).

| file | what it is |
|---|---|
| `server.js` | The lens server: the client's files, `/lens/status`, `/lens/why`, and Wisp at `/wisp/<pass>/`. A pass is signed by the relay (`relay/lens-link.js`), names an account, and lasts 12 hours. It pulls the relay's public key, the admins' ALLOW list, and (with a read-only token) Linode's own transfer count. |
| `wisp.js` | Our Wisp v1 server. Every connection a page asks for goes through the relay's own guard (`relay/guard.js`): the block lists, private and cloud-metadata addresses, the filtering resolver, and the ports a page may open. Then the meter. UDP is refused. A person who reads slowly pauses their own sites, not the server. |
| `meter.js` | Bytes sent this month, against a ceiling, kept on disk, and a share per person per day. When the ceiling is reached, new connections are refused and BROWSER moves to the full mode. The provider's count, when ahead, wins. |
| `client/` | The page: a toolbar, Scramjet, and the messages it trades with BROWSER's panel (listed at the top of `lens.js`). |
| `patch-scramjet.js` | Our one change to Scramjet 1.1.0, made when the image is built. Its worker waited for the page to acknowledge each cookie on a script's response, and a browser holds that message until the page has parsed, which the script was blocking: Wikipedia stayed white. The build stops if the code it changes is not there exactly once. |
| `vendor/` | The exact versions of Scramjet, bare-mux and libcurl-transport, with their hashes; fetched at build, never committed. |
| `Dockerfile`, `Caddyfile`, `setup.sh` | The image, the HTTPS front (Let's Encrypt), and one script that installs or updates it all on the server. |

Setting it up: `tools/make-deploy.js` writes `deploy/lens.tar.gz`; on the
server, `sudo sh lens/lens/setup.sh <relay address> <lens host name>`. Then the
lens address goes in ADMIN CENTER (SERVICES), and BROWSER uses it.

Tests: `node tests/lens-wisp.test.js` (a real WebSocket client, real TCP
sites on loopback, the relay's real guard, the pass rules, the patch).

Licences: Scramjet is MIT. libcurl-transport is AGPL-3.0 and libcurl.js
LGPL-3.0; both are served unmodified, and the page links their source.
