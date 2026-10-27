# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository. Do not open a public issue for them.

Helpful to include:

- what is affected: the client (which build), the relay, or the run server;
- how to reproduce it, and what an attacker gains;
- any proof of concept, kept to the minimum needed.

You should hear back within a week. Once a fix is out, you will be credited
in the advisory unless you would rather not be.

## In scope

- Anything that lets the relay, or someone who controls it, read vault
  records or message contents.
- Escaping a RUNNER sandbox, or reaching another person's files or jobs.
- The streamed browser reaching the relay's own API, a private address, or
  another person's session.
- Forging a RUNNER ticket, a load report or a signed release.
- Accounts: getting past approval, bans, or another person's tier.
- Secrets that should not be in this repository.

## Known and accepted

These are deliberate, and documented in the README:

- The relay sees record metadata (id, type, update time) and who messages whom.
- The streamed browser's pages run on the relay, so the relay's owner can see
  the addresses visited. It is not an anonymity tool.
- A relay that is taken over can withhold an update, but cannot forge one.

## Supported versions

Only the latest release and the `main` branch get fixes.
