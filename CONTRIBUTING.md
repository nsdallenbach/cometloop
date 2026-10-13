# Contributing to Cometloop

Thanks for helping. This is a short guide; the full working agreement is
[docs/development-standards.md](docs/development-standards.md) and the
architecture is in [docs/architecture.md](docs/architecture.md).

## Validate before you push

CI runs the same commands on every push to `main`. Run them from a clean
state before opening a pull request:

```bash
npm run typecheck && npm run lint && npm run build      # web console (client/ + server/ + shared/)
cd desktop && npm run typecheck && npm run build        # desktop client
```

As needed: `npm run test:unit` (vitest), `npm run test:smoke` (Playwright
against a local dev server), `npm run format` (prettier), and
`node --check mcp/server.mjs devbox-runner/runner.mjs` for the plain-JS
packages. A change to `shared/` or to an API route the desktop calls is a
two-shell change: update the desktop consumer in the same PR.

## Pull requests

1. Branch from `main` (`git checkout -b my-change origin/main`).
2. Keep the PR focused and the description short: what changed, why, and
   how you validated it. Fill in the PR template, including the parity
   item when a change touches both shells
   ([docs/cross-platform-parity.md](docs/cross-platform-parity.md)).
3. Update the doc that owns the change (the table in `CLAUDE.md` says
   which one).
4. Open the PR against `main`. CI must be green and a maintainer reviews
   before merge. Merges to `main` are deployed by the maintainers.

Bug reports and feature requests go through GitHub issues.

## Developer Certificate of Origin

Every commit must be signed off:

```bash
git commit -s -m "Describe the change"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer, which
certifies that you wrote the change or otherwise have the right to submit
it under the project's license, as described in the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).
Pull requests with unsigned commits are not merged.

Cometloop is licensed under the AGPL-3.0 and also offered under commercial
licenses. The DCO is what keeps that possible: it records that every
contribution was made with the right to contribute it, so the project can
keep relicensing the combined work without chasing down each author later.
No copyright assignment is involved; you keep the copyright on your work.

The text of the DCO 1.1:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
