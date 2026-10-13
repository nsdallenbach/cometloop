# Cometloop — desktop client

Phase 1 scaffold of the local client
([docs/local-client-architecture.md](../docs/local-client-architecture.md)):
an Electron shell with the console's design tokens, a zod-validated config, a
Databricks credential manager with **native browser OAuth** (authorization
code + PKCE, refresh token encrypted via `safeStorage`, silent renewal,
≤10 min access-token cache, 401 → refresh-once), and a typed IPC bridge. The
Projects view proves the loop: it is the console itself, signed in as *you*.

## Sidebar

The sidebar is the only navigation: the embedded console renders no top
bar of its own inside the desktop (it detects the `Electron/` user agent).

| Entry | What it shows |
|---|---|
| **Projects** | The web console, embedded: portfolio, each project's Board · Tickets · Roadmap · … tabs, ticket drawer, planning. Remembers where you were across entries and restarts. |
| **Workflows** | The console's `/workflows` page (DAT-284) in the same webview. |
| **Agents** | Native: the coding agents on this machine — the desktop is *the* agents surface; the console's Agents tab is not shown in the shell. |
| **Agent Tools** | Native: MCP servers and skills the agents run with. |
| **Metrics** | The console's `/metrics` page (cross-project usage) in the same webview. |
| **Identity** | Native: every identity the machine works with. |
| **Sync** | Placeholder. |
| **Deploys** | Native: the local deployment queue. |
| **Settings** (bottom) | The console's `/settings` page (staffing & project lifecycle; formerly Admin). |

Console entries are routed inside the running SPA (`history.pushState`)
rather than reloaded, so Projects keeps its place while you look at
Workflows, Metrics or Settings. Navigating inside the console (a palette
command, a link) moves the sidebar highlight to match. The **↻** in the
sidebar footer reloads the console — useful after a deploy, since the
served bundle does not hot-reload.

## Title bar

Right of the wordmark, before the window controls, three icon-only
affordances the web top bar used to carry (tooltips name them):

- **Sun / moon** — theme. It sets `data-theme` on the shell and writes the
  same `eec-theme` key into the embedded console, which switches at once;
  the choice survives restarts on both sides.
- **Bell** — your console notifications: unread count, dropdown, mark
  read / mark all read; a row with a ticket opens it in Projects. Read via
  the console client in the main process (`/api/notifications`), polled
  every 30s and whenever the window regains focus.
- **Shield** (only when shown) — the console could not verify your role,
  so admin/lead actions inside it are hidden; click to retry.

**Console sign-in.** When the console is not behind the Databricks Apps proxy (a localhost `APP_URL`, or `consoleAuth: "none"` / `CONSOLE_AUTH=none`), the desktop needs no workspace token — the console handles sign-in itself and the Identity page shows the mode as **local**. Set `consoleAuth: "databricks"` to force the token flow for a localhost URL.

## Run it

```bash
cd desktop
npm install
npm run dev          # electron-vite dev with HMR
```

Prereqs: Node 20+ and network access to the console. First launch: pick an
**environment** (below), then click **Sign in to Databricks** — your browser
opens the workspace sign-in, the app catches the redirect, and you stay
signed in across restarts. (No Databricks CLI needed; if one is installed
and logged in it is used silently as a fallback.)

## Environments

An environment is a console deployment the desktop signs in to.
The first launch shows a picker; the choice is persisted as `environment`
in config.json and **Identity → Switch environment** brings the picker back
(the app relaunches, because the credential manager, console client, agent
pool and webview session are all built from the resolved URL at startup).

| Environment | Console | Backing data | Who uses it |
|---|---|---|---|
| **Production** | `delivery-console` Databricks App (until the AWS stack in the private `cometloop-infra` repo is applied for prod; then `https://app.cometloop.ai`) | Lakebase branch `production` | everyone, day to day |
| **Staging** | `https://staging.cometloop.ai` — Amazon ECS (Express Mode), `consoleAuth: none` | Neon branch `staging` | testers on the staging build |
| **Local** | `http://localhost:8000` (`consoleAuth: none`) | whatever the dev server points at | developers |

Staging and Local use the **console's own sign-in**: the embedded console
shows its Neon Auth sign-in screen (email + password, or Google) and the
desktop needs no workspace token, so the Identity page reports the mode as
**console sign-in**. Production still signs in to the Databricks workspace.
Native surfaces that call the API from the main process (Agents queue,
Deploys, the bell) have no console session on `consoleAuth: none`
deployments yet and report *not signed in* — the desktop-side console
sign-in is the next piece (docs/platform-architecture.md §5 "Desktop app").
Add your own entries to `environments` in
config.json (`id`, `label`, `consoleUrl`, optional `databricksHost`,
`consoleAuth`, `note`). `APP_URL` in the environment pins the console for a
dev run and skips the picker entirely.

**Staging build.** `npm run dist:win:staging` bakes `COMETLOOP_CHANNEL=staging`
into the bundle (`electron.vite.config.ts` → `__COMETLOOP_CHANNEL__`) and
packages with `electron-builder.staging.yml`: product name **Cometloop
Staging**, appId `ai.cometloop.desktop.staging`, output in
`release-staging/`. It installs beside the production app with its own
config and keychain entries, preselects **Staging** on the picker, and has
`autoUpdate` off by default so the production release feed can never replace
it. Hand the installer or portable exe to testers directly; it is not
published to GitHub Releases.

Config lives at `%APPDATA%/cometloop-desktop/config.json` (written on
first run; `%APPDATA%/Cometloop Staging/` for the staging build) and can be
overridden per-run with env vars: `APP_URL`,
`DATABRICKS_HOST`, `DATABRICKS_PROFILE`, `DATABRICKS_CLI`, `AGENT_NAME`,
`HARNESS`, `WORK_ROOT`, `MAX_RUN_MINUTES`, `MCP_SERVER`, `DEPLOY_COMMAND`,
`AUTO_UPDATE`. `DATABRICKS_TOKEN` skips the CLI entirely (dev mode; never
persisted).

To develop the desktop against a **local** web console instead of the
deployed one, start `npm run dev` at the repo root (port 8000) and then:

```bash
APP_URL=http://localhost:8000 AGENT_NAME=desktop-dev-<you> npm run dev
```

The embedded console, queue and deploy events all hit that local server; the
runner still claims real work from the shared queue, so name the agent
distinctly and stop it when you are done.

## Checks

```bash
npm run typecheck    # this package is excluded from the root TS/lint projects
npm run build        # electron-vite production build
npm run dist:win     # NSIS installer + portable exe into release/
npm run dist:win:staging  # the tester build (Cometloop Staging) into release-staging/
```

## Releases & auto-update (DAT-237)

`.github/workflows/desktop-release.yml` matrix-builds on tag push and
publishes to GitHub Releases: Windows NSIS installer + portable exe
(primary), macOS dmg (+ zip for the update feed), Linux AppImage. To cut a
release:

```bash
cd desktop && npm run release -- 0.3.1
```

`scripts/release.mjs` bumps `package.json` + the lockfile, commits, tags
`v0.3.1` and pushes both; it refuses to run off `main`, with a dirty tree,
behind `origin/main`, or with a version that is not newer. Watch the build
with `gh run watch` and the release appears at
<https://github.com/nsdallenbach/cometloop/releases>. (By hand: bump the
version, `git tag v<version>`, push the tag — CI fails the build if the two
disagree.)

Installed builds update themselves silently via `electron-updater`
(`src/main/updater.ts`): a check against the release feed at launch and
hourly, background download, install on the next app quit. The sidebar
footer shows the running version (its tooltip has the updater's state; a
click checks now) and, once a newer build is downloaded, an **Update to
vX.Y.Z** button that restarts into it. The button is refused while an agent
is mid-run; the build still installs on the next quit. Every transition is appended to
`<userData>/updater.log`. Opt out with `"autoUpdate": false` in
config.json (or `AUTO_UPDATE=0`) to pin a build. Not self-updating by
design, and the footer says which: dev runs, the portable exe (nothing
installed to replace), and macOS until builds are signed (Squirrel.Mac
refuses unsigned updates).

The consoles a build offers on first launch are baked in by the release
workflow from the repository variables `COMETLOOP_PRODUCTION_CONSOLE_URL`,
`COMETLOOP_STAGING_CONSOLE_URL` and `COMETLOOP_DATABRICKS_HOST` (empty →
the console signs users in itself). A build whose staging URL equals its
production URL offers Production and Local only. The list is not written to
config.json, so a newer build's consoles reach every install.

**Code signing** is the long-lead item (procurement, tracked on DAT-237):
unsigned builds install fine but Windows shows the SmartScreen warning, and
macOS auto-update stays off. When certs arrive, add the `CSC_*` secrets
named in the workflow — no config changes needed. MSIX/winget can follow if
IT wants managed rollout.

**Private-repo caveat:** `electron-updater`'s GitHub provider downloads
release assets anonymously, so if this repo is private the update check 404s
(installs from a downloaded installer still work). Options, in preference
order: publish desktop releases to a small public releases repo, or front
the feed with a generic HTTPS channel the console serves. Decide before the
first broad rollout.

## Agents (DAT-245)

The **Agents** page manages the coding agents on this machine: per agent
type (Claude Code, Codex) it shows install status/version, an instance
count (0–4) and an auto-start toggle — all persisted in config.json.
Agents appear as cards with their logo; **New agent** opens a five-step
wizard (agent → model → projects → tools & skills → launch) and **⚙
Configure** on a card reopens it (DAT-280). The wizard sets the
**projects** the instances claim from (none = any), the **model** (from the
console's catalog, or any id the harness accepts), the registry **MCP
servers** and **skills** attached to every run, and the instance count /
auto-start. This is the one place agents are configured — the desktop
reports it home (`PUT /api/agent/self`) and the web console's Agents page
mirrors it read-only for leads and PMs.
Instances run concurrently, each with its own fleet identity
(`<agentName>-<kind>-<n>`), claim loop, live feed and Start/Stop/Kill,
tabbed in the UI. Default config auto-starts 1× Claude Code with the app
so the queue never stalls. Launching a new build kills the previous app
instance (PID-file replace; DAT-234 orphan recovery covers a run caught
in the crossfire).

## Deploys (DAT-236)

The **Deploys** page is the local deployment queue: merged tickets assigned
to you (linked PR merged, deploy not settled) queue here automatically.
**▶ Deploy** checks out `origin/<default branch>` and runs the deploy on
this machine as *you* — `databricks bundle deploy` + `databricks bundle run
app` for bundle repos (override with `deployCommand` in config.json /
`DEPLOY_COMMAND`), with every line streamed live in-app. The client posts
ticket-keyed deploy events (queued/started/succeeded/failed/removed) home:
a green deploy moves the ticket to Done, a red one posts the ⚠ feed
warning — and the web app's Deploys tab renders a READ-ONLY mirror from
those events only. No path from the web app into anyone's laptop.

## Identity broker (DAT-235)

The **Identity** page holds every identity the machine works with, phase B:

- **Databricks** — native browser OAuth (DAT-228), unchanged.
- **GitHub / Azure / Azure DevOps** — device-code sign-ins with login state
  per provider. Each flow reuses a registered public client (gh's and az's,
  the same precedent as `databricks-cli` for Databricks), opens the browser
  on the verification page and shows the user code in-app. Tokens land
  encrypted via `safeStorage` (DPAPI/Keychain/libsecret) — never plaintext
  files; Microsoft tokens renew silently off the stored refresh token.
- **MCP server auth** — named secrets for MCP servers, stored the same way
  and handed to harness runs as `MCP_AUTH_<NAME>` env, never written into
  the workdir.

Runner credential selection: work repos keep cloning/pushing with the
console-vended GitHub App token (`GIT_TOKEN`); client-owned repos run as
the dev — ADO via an `Authorization: Bearer` header, GitHub (when the App
can't vend) via an inline credential helper — both injected through
env-only git config (`GIT_CONFIG_*`), so the dev credential reaches every
git invocation of the run without ever touching disk. Local git
credentials stay the last-resort fallback.

## The embedded runner

**My Tickets** polls the queue as you (server-scoped: shared pool + tasks
routed to you). **▶ Run** on a queued ticket claims it on this machine;
**Runs** shows the live feed (harness output, tool calls, lifecycle) with
Start/Stop runner (long-poll loop, like a devbox) and Kill run. Harness
processes are spawned hidden (`windowsHide`, piped stdio) — no console
windows. The lifecycle is the devbox runner's: claim → workdir under
`~/agent-work` → vended git credential → harness (`claude` or `codex`, set
`harness` in config.json or `HARNESS` env) → heartbeats → `RESULT.md` →
complete. Not ported yet, deliberately: project provisioning (base
image/library installs) and service-mode harnesses.

What the run is configured with comes from the console, not this machine
(DAT-279): the work package carries the **model** a lead picked for this
agent on the Agents page and its **registry attachments** — MCP servers
written into the workdir `.mcp.json`, skills into `.claude/skills/` (Claude)
or `AGENTS.md` (Codex). A server that requires a credential is filled from
**Identity → MCP server auth** (`MCP_AUTH_<SLUG>`); if that secret is
missing the run's feed and the ticket say so before the harness starts.

## Layout

```
src/main/       config.ts (zod schema) · credentials.ts (Databricks tokens) · identity.ts (gh/az/ADO + MCP secrets) · index.ts (window + IPC)
src/preload/    contextBridge surface (typed in renderer env.d.ts)
src/renderer/   React shell: title bar, nav, views (inline styles + shared/design tokens)
```

Security posture: contextIsolation on, nodeIntegration off, renderer never
sees tokens or the network — everything crosses the typed IPC boundary in
`src/preload/index.ts`. Harness processes (later phases) spawn with piped
stdio and `windowsHide` — no console windows, output renders in-app.
