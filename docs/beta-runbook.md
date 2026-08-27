# Desktop client — beta tester runbook

How to install and smoke-test a beta build of the Delivery Console desktop
client (v0.2.0 and later) from GitHub Releases. No repo checkout and no
Node/npm needed — the only prerequisites on the machine are **git** and
**Claude Code** (the `claude` CLI on PATH), which the embedded runner drives.

## Get the build

1. Open the release page:
   <https://github.com/datavail-solutions/engagement-console/releases> and
   pick the latest `v*` release (you need to be signed in to GitHub with
   access to this repo — the repo is private).
2. Download the asset for your OS:
   - **Windows (primary):** `Delivery-Console-Setup-<version>.exe` (NSIS
     installer) — or the portable `Delivery-Console-<version>.exe` if you
     can't/won't install (runs from anywhere, but never auto-updates).
   - **macOS:** `Delivery-Console-<version>.dmg` (ignore the `.zip`; it
     exists for the future update feed).
   - **Linux:** `Delivery-Console-<version>.AppImage` — `chmod +x` it and run.

## Unsigned-build caveats (expected, not a defect)

Beta builds are **not code-signed** — the signing cert is a procurement item
tracked on DAT-237. Consequences:

- **Windows SmartScreen** blocks the first run with "Windows protected your
  PC". Click **More info → Run anyway**. Some browsers also warn on
  download — choose Keep.
- **macOS Gatekeeper** refuses a double-click open. Right-click the app →
  **Open** → **Open** (or System Settings → Privacy & Security → "Open
  Anyway"). Silent **auto-update is disabled on macOS** until builds are
  signed — Squirrel.Mac won't apply unsigned updates.

## Updates during the beta: manual, per release

The repo serving the release feed is private, and `electron-updater`'s
GitHub provider downloads anonymously — so the in-app update check gets a
404 and is silently ignored (by design; see `desktop/src/main/updater.ts`).

**For the beta, install each release by hand** from the releases page, same
steps as above — the installer upgrades in place, keeping your config and
sign-in. When we announce a new build, re-download and re-run the installer.
(Whether we go to a public releases repo or a console-served feed for
automatic updates is a post-beta decision — see the private-repo caveat in
`desktop/README.md`.)

## First-run checklist

Work through these in order and report where it breaks:

1. **Install & launch** — installer completes without admin prompt
   (per-user install), app opens with the console look and feel.
2. **OAuth first-run** — click **Sign in to Databricks**: your browser
   opens the workspace sign-in, and after approving you land back in the
   app signed in. Restart the app — you should stay signed in.
3. **Embedded console loads** — My Tickets shows your engagements/queue
   (loaded from the console API as you).
4. **Agent auto-start** — the Agents page shows Claude Code detected, and
   the default 1× instance starts with the app (fleet identity
   `<agentName>-claude-1`).
5. **A real claimed run** — queue a ticket routed to you, hit **▶ Run**,
   and watch the live feed through to `RESULT.md`/complete, with the PR
   opened on the work repo.

## Reporting

File findings on the board against the **beta** tag (or ping the desktop
channel) with: OS + version, the release version (title bar / installer
filename), the checklist step that failed, and the relevant lines from the
app log.
