# Execution Console beta runbook

Everything a beta tester needs to install the desktop client, run the scripted
scenarios, and file findings — written to be followed cold, with no prior
exposure to the product. This document lives at `docs/beta-runbook.md` and is
mirrored into the Execution Console engagement's **Standards** tab for the
beta window (same convention as `docs/development-standards.md`).

Two tags carry the beta:

- `beta-sample` — the seeded tickets you run through (see
  [Seeded sample tickets](#seeded-sample-tickets))
- `beta-feedback` — findings you file (see
  [Filing feedback](#filing-feedback))

## 1. Install

Download the latest release from
<https://github.com/datavail-solutions/engagement-console/releases>:

- **Windows** — the NSIS installer (primary) or the portable exe.
- **macOS** — the dmg.
- **Linux** — the AppImage.

**The builds are unsigned this beta** (code signing is procurement-gated,
tracked on DAT-237). Expect and click through:

- **Windows SmartScreen**: "Windows protected your PC" → **More info** →
  **Run anyway**.
- **macOS Gatekeeper**: blocked on double-click → right-click the app →
  **Open** → **Open**, or **System Settings → Privacy & Security → Open
  Anyway**.

Installed Windows builds self-update silently (check hourly, install on next
quit). The portable exe and macOS builds do **not** self-update this beta —
if asked to test a newer build, download it again. Opt out of auto-update
with `"autoUpdate": false` in config.json.

Prerequisites: network access to the console URL and a Databricks workspace
identity with **Can Use** permission on the app. No Node, no Databricks CLI
required (an authenticated CLI is used silently as a fallback if present).

## 2. First run — sign in

1. Launch the app. Open the **Identity** tab (⛉ in the left nav).
2. Under **DATABRICKS**, click **Sign in to Databricks**. Your browser opens
   the workspace sign-in; complete it and return — the app catches the
   redirect. You stay signed in across restarts (refresh token encrypted via
   the OS keychain: DPAPI on Windows, Keychain on macOS, libsecret on Linux).
3. The auth row should show a green **signed in (browser OAuth)** (or
   **signed in via Databricks CLI** if the CLI fallback kicked in). Use
   **Test connection** to list your engagements and prove the loop.

Identity states you may see on the Databricks row:

| State | Meaning |
|---|---|
| `signed in (browser OAuth)` | Normal. |
| `signed in via Databricks CLI` | Fallback to a logged-in local CLI — fine. |
| `dev token from env` | `DATABRICKS_TOKEN` env override — dev mode only, flag it if you didn't set it. |
| `not signed in` | Sign in before anything else will work. |

Below Databricks sit **GitHub**, **Azure** and **Azure DevOps** device-code
sign-ins. **These are optional this beta** — work repos clone and push with
console-vended tokens, so leave the providers signed out unless a scenario
says otherwise. All tokens land encrypted via the OS keychain, never in
plaintext files — that claim is part of the exit criteria, so if you ever
find token-looking material in a plain file, that is a finding.

## 3. The five surfaces

The left nav has five entries:

- **▤ Tickets** — the web console itself, embedded (board, ticket drawer,
  planning chatbox, Standards tab), signed in as you with no second login.
  This is where you pick up and steer work.
- **◆ Agents** — the coding agents on this machine: per-type config (install
  status, instance count 0–4, auto-start), the work queue (**ROUTED TO
  YOU** / **SHARED POOL** / **ACTIVE ON THIS MACHINE**), tabbed live feeds
  per instance with **▶ Start** / **■ Stop** / **✕ Kill run**, and the
  **⌨ Terminal** pane.
- **⛉ Identity** — every identity the machine works with (section 2).
- **⇅ Sync** — placeholder this beta ("coming in a later phase"); nothing to
  test.
- **▲ Deploys** — the local deployment queue: your merged tickets appear
  here and deploy from this machine as you. The web app's Deploys tab is a
  read-only mirror of events this client posts.

## 4. How work flows

```
board (Backlog) → ◆ Deploy to Agent lane / Queue for agent → queued
  → routed (to a person) or pool (anyone's runner)
  → claimed by an agent instance → ticket moves to In Progress, feed goes live
  → agent pushes branch DAT-xxx-<slug>, opens a PR (branch/title contains the key → auto-link)
  → complete: done → ticket moves to Review   (failed → back to Backlog)
  → a human reviews and merges the PR (agents never merge their own work)
  → merged → the assignee's desktop Deploys tab queues it → ▶ Deploy → green → Done
```

Key vocabulary: a **routed** task carries an assignee and only that person's
runners can claim it; a **pool** task is claimable by any online runner. The
runner heartbeats while working; a claim silent for 15 minutes is reclaimed
and requeued by the fleet watch, and after two reclaims it fails to a human.

## 5. Where things live on disk

| What | Where |
|---|---|
| Config | `%APPDATA%/delivery-console-desktop/config.json` (Windows) · `~/Library/Application Support/delivery-console-desktop/config.json` (macOS) — written on first run |
| Task workdirs | `~/agent-work/<TICKET-KEY>-task<id>/` — contains `work-package.json`, the `repo/` clone, and `RESULT.md` when the run finishes |
| Tokens | OS keychain only (encrypted via `safeStorage`) — **never** in config.json or the workdirs |

Config keys worth knowing (env overrides in parentheses): `consoleUrl`
(`APP_URL`), `databricksHost`, `agentName` (`AGENT_NAME`, default
`desktop-<hostname>`), `harness` (`claude` or `codex`), `workRoot`
(`WORK_ROOT`, default `~/agent-work`), `maxRunMinutes` (watchdog, default
180), `agents.<kind>.instances` / `.autoStart` (edited by the Agents page),
`autoUpdate`, `deployCommand` (`DEPLOY_COMMAND`, overrides the auto-detected
deploy).

## 6. When stuck

- **Nothing claims work** → Identity tab: signed in? Agents tab: at least
  one instance configured and **waiting** (green ▶ Start if stopped)?
- **403 on claim / credential / coordination** → a deliberate per-agent
  security restriction (lead controls scopes on the agent map). Not a bug —
  ask a lead to widen the scope, don't retry in a loop.
- **FLEET DOWN on the board** → work queued 10+ minutes with zero online
  runners; start an instance or ask who owns the queue.
- **Web console looks stale after a deploy** → the served bundle doesn't
  hot-reload; hard-refresh the Tickets tab (↻ reload button in its toolbar).
- **A run seems dead** → Agents tab: if the row is active with no live
  process the orphan banner and **Release** appear (scenario 4); otherwise
  **✕ Kill run**.
- Anything else: file it as feedback (below) — "I got stuck here" is
  exactly the data the beta exists to collect.

---

## Scripted scenarios

Each tester runs all eight on their own machine. Copy this section into your
own notes and check items off; file a `beta-feedback` ticket for every ✗
with the scenario number in the title. Scenario 3 needs both testers live;
scenario 8 needs a merged sample.

### Scenario 1 — sign-in and identity states

- [ ] Fresh install launches; Identity tab shows `not signed in`
- [ ] **Sign in to Databricks** completes in the browser and the state goes
      green (`browser OAuth` or `via Databricks CLI`)
- [ ] **Test connection** lists your engagements, including Execution Console
- [ ] GitHub / Azure / Azure DevOps rows exist, are signed out, and nothing
      in the beta forces you to sign them in
- [ ] Quit and relaunch: still signed in, no browser round-trip

### Scenario 2 — pick up a seeded ticket, watch it through to Review

- [ ] Tickets tab → Execution Console board → filter the board by tag
      `beta-sample`; pick an unclaimed sample
- [ ] Queue it (**Queue for agent** in the drawer or drag to
      **◆ Deploy to Agent**) routed to yourself
- [ ] Agents tab: the ticket appears under **ROUTED TO YOU**; press **▶ Run**
- [ ] The instance tab goes **RUNNING** and the live feed streams harness
      output and tool calls
- [ ] A PR opens on GitHub whose branch/title contains the ticket key, and
      the ticket card links it
- [ ] On completion the ticket lands in **Review** with the run summary as a
      comment
- [ ] Spot-check `~/agent-work/<KEY>-task<id>/`: work-package.json, repo
      clone, RESULT.md — and no credential material anywhere in it

### Scenario 3 — routed isolation (with the other tester, pairs with DAT-252)

The full multi-identity drill procedure lives in
[docs/beta-provisioning.md](./beta-provisioning.md) (DAT-252) — the checks
below are the pass/fail summary.

- [ ] Tester A routes a seeded sample to **themselves** (assignee = A) and
      does NOT run it
- [ ] Tester B's Agents tab shows it in neither **ROUTED TO YOU** nor
      **SHARED POOL**, and B's idle instances never claim it
- [ ] Tester A's machine shows it under **ROUTED TO YOU** and can claim it
- [ ] Repeat mirrored (B routes to B, A must not see/claim it)

### Scenario 4 — kill mid-flight, and orphan recovery

Kill:

- [ ] Run a seeded sample; while the feed is streaming press **✕ Kill run**
- [ ] The task completes **failed** with an honest summary (no fake success),
      and the ticket returns to **Backlog**

Orphan (quit the app mid-run):

- [ ] Run another sample; while RUNNING, quit the app entirely
- [ ] Relaunch: Agents tab shows the task under **ACTIVE ON THIS MACHINE**
      with "⚠ No process on this machine — the app restarted while this run
      was in flight." and a **Release** button
- [ ] **Release** fails the task with an honest summary; the ticket returns
      to Backlog immediately (no 15-minute stall wait)

### Scenario 5 — instance scaling and parallel claims

- [ ] Agents tab: set **Claude Code** instances to **2**
- [ ] Queue two seeded samples to the shared pool (no assignee)
- [ ] Both instances claim one each (never the same ticket twice); two
      instance tabs stream independent feeds, each labeled with its ticket key
- [ ] Both finish and both tickets reach Review

### Scenario 6 — terminal in a run's workdir

- [ ] During (or right after) a run, press the **⌨** button on the task row
      (or **⌨ Terminal** on the instance bar)
- [ ] The docked terminal opens **in that task's workdir**
      (`~/agent-work/<KEY>-task<id>`) — verify with `pwd`/`cd`, `ls` shows
      `work-package.json` and `repo/`
- [ ] Hide the pane and reopen it: the shell session survived

### Scenario 7 — board filters

- [ ] On the embedded board, the **FILTER** row offers an assignee dropdown
      (Everyone / Unassigned / names) and a tag dropdown (Any tag / …)
- [ ] Tag = `beta-sample` shows exactly the seeded samples
- [ ] Assignee = you narrows it to your cards; the two filters combine
- [ ] **✕ CLEAR** restores the full board

### Scenario 8 — deploys queue detection (observe-only)

Target: the seeded **CONTRIBUTING.md** sample — the only one without the
`no-deploy` tag. After its scenario-2 run is reviewed and a lead merges the
PR:

- [ ] The desktop **Deploys** tab queues the ticket automatically (↻ to
      poll now): ticket key, title, PR number, repo, state **QUEUED**
- [ ] The web app's Deploys tab mirrors it read-only
- [ ] **Do not press ▶ Deploy** unless a lead has designated a safe deploy
      target this beta — observing the queued state completes the scenario

---

## Seeded sample tickets

Seven docs-grade sample tickets (no schema, CI, or server code — safe for
agent runs) are tagged `beta-sample` on the Execution Console board, with
estimates set, workstream **Beta**. Six also carry `no-deploy`; the
CONTRIBUTING.md one deliberately does not, so scenario 8 has a queue target.

To (re-)seed, anyone with app access runs:

```bash
node scripts/seed-beta-tickets.mjs
```

It is idempotent — samples whose titles already exist are skipped, so
re-running after a partial failure only fills gaps. `ENGAGEMENT_ID`,
`APP_URL`, `DATABRICKS_HOST` / `DATABRICKS_TOKEN` env vars override the
defaults (same conventions as `scripts/coordination-roundtrip.mjs`).

After the beta, filter the board by `beta-sample` to sweep the samples off.

## Filing feedback

File every finding from the board's chatbox (the **+ New ticket** modal —
one description box; the planning agent derives the title and refines it
into a ticket in Backlog). Paste this template into the description:

```
Beta feedback.

Surface: <Tickets | Agents | Identity | Sync | Deploys | web console | install/update>
Scenario: <1–8, or "free use">
Expected: <what you expected>
Actual: <what happened — paste exact error text>
Screenshot: <attached to the ticket after creation>
```

Then open the created ticket's drawer and:

1. Add the **`beta-feedback`** tag.
2. Attach the screenshot (attachments are on the drawer; max 25 MB).

**Triage cadence: daily during the beta window.** The lead filters the board
by tag `beta-feedback` each morning, classifies (`bug` / `feature` via the
standard tags), and routes anything blocking a scenario the same day. Don't
sit on findings to batch them — file as you hit them.

## Exit criteria (go / no-go for widening the beta)

1. **All eight scenarios pass on both tester machines** (checklists above
   completed, every ✗ either fixed and re-run or explicitly waived).
2. **Zero credential material on disk outside keychain blobs** — spot-check
   config.json, `~/agent-work/**`, and logs on both machines.
3. **No orphaned claims left unrecoverable** — every kill/quit in scenario 4
   ended with the ticket honestly back in Backlog, nothing stuck in a
   claimed state needing manual DB surgery.
4. **The beta metrics dashboard shows the runs** (dashboard delivered by the
   beta metrics ticket) — the scenario runs from both machines are visible.
