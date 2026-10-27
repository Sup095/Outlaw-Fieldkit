# GETTING THE RELAY THROUGH A RESTRICTIVE NETWORK

The relay works fine from a home network and gets blocked on a school
one. This explains why, what actually fixes it, and how to tell which
problem you have.

---

## FIRST, THE HONEST PART

If a network administrator has deliberately blocked personal servers,
routing around that block may be against the acceptable-use policy you
agreed to, and a managed Chromebook can log where it connects. That is
your call to make, not mine — but make it knowingly rather than by
accident.

Everything below is also the correct setup for every *other* network:
mobile data, a friend's wifi, a coffee shop, a hotel. The current
configuration — plain HTTP on port 25569 — fails on most of those too,
for the same reason. Fixing it is worth doing regardless of school.

---

## WHY IT GETS BLOCKED

The relay is currently reachable as something like:

```
http://your-host.example:25569
```

That has three separate problems, any one of which is enough:

**1. The port. This is almost certainly the one.**
Most school and corporate firewalls permit outbound traffic on 80 and
443 and drop everything else. Port 25569 is not on anybody's allow
list. This has nothing to do with what the traffic contains — the
packets are dropped before anyone looks.

**2. Plain HTTP.**
Filters that inspect traffic treat unencrypted HTTP to an unknown host
as low-trust by default. Chrome also increasingly refuses or warns on
plain HTTP.

**3. An uncategorised destination.**
Filtering services sort domains into categories and often block
anything they have never seen. A bare IP address is worse — many
filters block IP-literal destinations outright, because that is a
classic way to dodge a domain blocklist.

---

## WOULD DNS FIX IT?

**On its own, no.** A hostname does not change which port the traffic
goes to. If the block is port-based — and it probably is — pointing a
domain at the same `host:25569` changes nothing at all.

A domain *is* necessary, but as part of the real fix rather than
instead of it. What you actually need is all three at once:

- a real hostname
- on port **443**
- with valid **TLS**

At that point the traffic is indistinguishable from any other HTTPS
request, because that is exactly what it is.

---

## THE FIX: CLOUDFLARE TUNNEL

`cloudflared` makes an **outbound** connection from the relay to
Cloudflare and serves your hostname over their edge. Concretely:

- No inbound port forward. You can close 25569 entirely.
- Real hostname, real certificate, port 443.
- Traffic goes to Cloudflare IPs, which sit in front of a large share
  of the web — blocking them wholesale breaks too much to be practical.
- Free. You need a domain on Cloudflare (a cheap `.com`, or any TLD
  they support).

### Setup

There are two ways to create a Cloudflare Tunnel, and only one of them
works here.

The documented one — `cloudflared tunnel login`, `tunnel create`,
`tunnel route dns` — is three interactive commands run **on the
machine that will host the tunnel**. A Pterodactyl console is not a
shell. It is one process's stdout with an input box wired to that
process's stdin, so there is nothing there to type commands into. If
you follow the standard Cloudflare walkthrough you will get to step
two and have nowhere to run it.

The other way is a **dashboard-managed** (or "remotely-managed")
tunnel. Cloudflare holds the configuration and hands you one long
token. `cloudflared` takes the token and asks Cloudflare what it is
supposed to be doing. Nothing is created on the container, so nothing
has to be typed there. That is the path below.

**1. Get a domain onto Cloudflare.** Buy one anywhere, change its
nameservers to the two Cloudflare gives you. Free plan is fine. If you
bought the domain *from* Cloudflare, this is already done.

**2. Create the tunnel in the dashboard.**

- <https://one.dash.cloudflare.com> → **Networks** → **Tunnels**
- **Create a tunnel** → connector type **Cloudflared** → name it
  (`fieldkit-relay`) → **Save**
- The install page appears. Ignore every command it offers — you only
  want the long token inside them. It is the last argument of the
  `--token` flag: a ~180-character string beginning `ey`. Copy it.

**3. Add the public hostname.** This is the subdomain, and in this
flow it is a form rather than a command:

- On the tunnel, **Public Hostname** → **Add a public hostname**
- **Subdomain**: `relay` · **Domain**: pick yours · **Path**: empty
- **Service**: type `HTTP`, URL `127.0.0.1:8080`
- Save.

The DNS record is created for you. You do not add a CNAME by hand, and
you should not — Cloudflare writes a proxied record pointing at the
tunnel's UUID, which is not something you can usefully type yourself.

> The service port must match the port the relay actually listens on.
> Pterodactyl sets that at runtime via `SERVER_PORT`, which overrides
> `config.json`. Check the panel's port allocation and use that number
> here. Getting it wrong shows up as **error 502** from the hostname
> while the relay itself is running fine.

**4. Put the binary and the token in place.**

On your PC:

```bash
node relay/fetch-cloudflared.js
```

That downloads the linux/amd64 build into `relay/cloudflared-bin/` and
checks it really is an ELF binary rather than an HTML error page.
Upload it to `/home/container/cloudflared-bin/cloudflared` alongside
the relay, and set the startup file to `start.js`.

Then in `config.json`:

```json
"cloudflared": {
  "token": "eyJhIjoiN...the-long-token..."
}
```

`start.js` launches the tunnel before the relay binds, and keeps
serving even if the tunnel dies — a side-car failure must never take
the relay down with it.

**5. Point the relay at loopback only.** Once the tunnel is doing the
listening, the relay does not need to be internet-exposed at all. In
`config.json`:

```json
"host": "127.0.0.1",
"trustProxy": "loopback"
```

`trustProxy` matters: without it every request appears to come from
127.0.0.1 and the whole rate limit becomes one shared bucket. With it,
the relay reads the real client address out of `CF-Connecting-IP`.

**Do this step last, and only after the tunnel works.** Do not set
`trustProxy` while the relay is still directly exposed on a forwarded
port. That header is attacker-controlled there, and believing it lets
anyone reset their own rate limit — including the limits guarding the
unauthenticated `GET /vault`.

**6. Point FieldKit at it** — RELAY LINK, `https://relay.yourdomain.com`,
no port. Run LINK DOCTOR to confirm.

### If you would rather create the tunnel yourself

If you do have a real shell somewhere with the domain's credentials,
the locally-managed flow still works and `start.js` still supports it:
run `tunnel login` / `tunnel create` / `tunnel route dns` there, upload
the credentials JSON, and set `cloudflared.tunnel` (and optionally
`configFile`) instead of `token`. `token` wins if both are set.

---

## IF YOU DO NOT WANT TO BUY A DOMAIN

**Quick tunnels** need no account and no domain:

```bash
./cloudflared tunnel --url http://127.0.0.1:8080
```

It prints a random `https://<words>.trycloudflare.com` hostname. Real
TLS, port 443, works immediately.

Two catches, both real:

- **The hostname changes every restart.** You would be re-entering the
  relay URL constantly, and the vault does not care but you will.
- **`trycloudflare.com` is more likely to be categorised** as a tunnel
  or anonymiser service and blocked as a category, precisely because it
  is free and disposable. A hostname on your own domain does not carry
  that reputation.

Fine for testing whether the port was the problem. Not what you want
long-term.

---

## OTHER OPTIONS, AND WHY THEY ARE WORSE HERE

**Tailscale.** Already in the project for the AI hop, and excellent for
that. As the *client* path it is weaker: you cannot install it on a
managed Chromebook, and its coordination traffic is a well-known
signature that filters do block. Keep it for relay-to-home-PC, which is
what it is already doing.

**Port forward 443 at home instead.** Works, and costs nothing. But it
exposes your home IP, needs a certificate you renew yourself, and many
consumer ISPs block inbound 443. The tunnel avoids all three.

**A VPS in front.** Same effect as the tunnel, plus a monthly bill and
a second machine to keep patched.

**Just use port 443 directly on the current host.** Better than 25569,
and worth trying if it is easy — but you still need a certificate, and
Pterodactyl's port allocation may not let you have 443 at all.

---

## WHICH PROBLEM DO I ACTUALLY HAVE?

Open **LINK DOCTOR** in FieldKit. It runs a battery of probes and names
the failure instead of leaving you guessing. What it can tell apart:

| Verdict | What it means | What to do |
|---|---|---|
| NO NETWORK AT ALL | Even a known-good public host is unreachable | Captive portal, or wifi is not actually connected |
| NAME DOES NOT RESOLVE | DNS has no answer for this hostname | Typo, or a DNS-level filter |
| PORT LOOKS BLOCKED | Packets are dropped — the probe hangs to timeout | **This one. Move to 443 via a tunnel.** |
| CONNECTION REFUSED | Something answered "no" instantly | The relay is not running, or wrong port |
| SOMETHING ELSE ANSWERED | A reply arrived, but not from the relay | A filter's block page, or a transparent proxy |
| TLS PROBLEM | Reached it, certificate rejected | Self-signed cert, or expired |
| CORS MISCONFIGURED | The relay replied but the browser discarded it | Relay-side header problem, not the network |
| RELAY IS HEALTHY | It works | — |

The distinction that matters most is **blocked vs refused**, and the
tell is timing. A firewall dropping packets makes the probe hang until
it times out. A machine with nothing listening on that port answers
"refused" in milliseconds. LINK DOCTOR measures this.

---

## AFTER YOU SWITCH

- Close the old forwarded port. Leaving it open is a second front door
  with none of the protections you just added.
- Re-run FULL SYSTEM EXERCISE and check the NETWORK group.
- The vault does not care what the URL is. Records are keyed by your
  password, not by host, so moving the relay changes nothing about
  your data.
