# Contributing to Outlaw FieldKit

Thanks for wanting to help. Bug reports, ideas and pull requests are all
welcome.

## Before you start

- For anything bigger than a small fix, open an [issue](../../issues) first
  and say what you want to change. That saves you building something that
  will not be merged.
- Security problems go through
  [private vulnerability reporting](../../security/advisories/new), never a
  public issue or pull request. See [`SECURITY.md`](SECURITY.md).

## Making a change

1. Fork the repository on GitHub and make a branch in your fork.
2. You need Node.js 22 or newer and nothing else: there are no packages to
   install.
3. Make your change. Keep to the style of the file you are in: plain
   JavaScript, no build step for the code itself, no new dependencies, and
   comments that say *why*, not *what*.
4. Run the tests and rebuild the single-file builds:

   ```bash
   node tests/run.js
   node build.js
   ```

   Add or update tests for what you changed. A new app in `modules/` must
   pass `tests/module-hygiene.test.js`; a new relay or run server file must
   be added where the deploy tools list them (the tests say so if it is
   missing).
5. Open a pull request against `main`. Say what it changes, why, and how you
   tested it. The test workflow runs on every pull request and must pass.

## Things that will not be merged

- Anything that weakens the security model in the README: sending vault
  data unencrypted, letting the streamed browser or RUNNER reach the rest of
  FieldKit or the server's network, or loosening the sandbox.
- Tracking, ads, analytics or anything that phones home.
- Secrets, personal addresses or real server details in code, tests or
  docs. Use stand-ins such as `example.com` and `100.64.0.x`.

## The license and your contribution

FieldKit is under the [Outlaw FieldKit License](LICENSE), which allows
forking on GitHub to prepare pull requests but not publishing copies
elsewhere. By sending a contribution you confirm you have the right to, you
keep its copyright, and you allow it to be used in FieldKit under that
license and under any terms chosen for later versions (section 4 of the
license).
