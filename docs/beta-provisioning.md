# Beta tester provisioning (DAT-252)

Everything a beta tester needs before first launch, how to provision it, and
the multi-identity verification drill that proves identity scoping holds
across people. Pairs with [beta-runbook.md](./beta-runbook.md) (DAT-253) —
that document is what the tester follows; this one is what the **lead/admin**
runs to get them there, plus the evidence log.

## What a tester needs

Work is routed by **workspace identity email** (DAT-227): the desktop app
signs in via native OAuth, every console call carries that identity, and
`app.agent_tasks.assignee` is matched against it. So provisioning is
identity-first:

| # | Requirement | Where it lives | Why |
|---|---|---|---|
| 1 | Active workspace user | Databricks workspace (SCIM) | OAuth sign-in + every API call |
| 2 | `CAN_USE` on the `delivery-console` app | Databricks Apps permissions | Reaching the console URL at all |
| 3 | Roster row **with email** | `app.team_members` | Email is what routes work; a null email means routed tickets never reach them |
| 4 | Engagement membership | `app.engagement_members` → execution-console | Board/project visibility for non-admins |
| 5 | `eec-developers` group | Databricks workspace groups | Console role resolves developer (see `server/routes/roles.ts`) |
| 6 | Machine prereqs | Their laptop | git on PATH, Claude Code installed + signed in on their own Anthropic seat, optionally Codex |

**GitHub: nothing personal is required for runs.** Runners clone and push
with short-lived installation tokens vended by the console's GitHub App
([github-app-setup.md](./github-app-setup.md)); PRs open as
`delivery-console[bot]`. Org membership only matters for humans reviewing
PRs in the GitHub UI — a tester without it can still run every scenario.

## Provisioning (lead/admin)

One command per tester, run by an admin with the Databricks CLI authenticated
against the workspace:

```bash
node scripts/provision-beta-tester.mjs --email sean.law@datavail.com --name "Sean Law"
```

Idempotent: it creates or completes the `app.team_members` row (setting the
email if the row exists without one), joins the member to the engagement
(default `execution-console`), grants `CAN_USE` on the app, and adds the user
to `eec-developers`. Rerunning is safe. Manual fallback: Admin tab for the
roster + `databricks apps update-permissions delivery-console` +
`databricks groups patch` for the group.

> **Role caveat:** membership of the workspace `admins` group wins over
> `eec-developers` in `resolveIdentity()` — such a tester shows up as console
> *admin* (sees every engagement). Fine for access, but less realistic for
> scoping tests; if the beta should exercise the developer view, the lead
> must take them out of workspace `admins` (a workspace-level decision, not
> made by this ticket's automation).

## Machine prereqs (each tester)

The tester runs, from a checkout or a copy of this script:

```bash
node scripts/verify-beta-machine.mjs
```

Checks git on PATH, Claude Code installed (+ a sign-in heuristic — the
authoritative check is launching `claude` once), Codex (optional, informational),
Databricks CLI auth against the workspace, console reachability, and that the
identity the console sees is on the engagement roster with a matching email.
Exits non-zero on any hard failure, so the output can be pasted as evidence.

## Agent security defaults (DAT-212)

Confirmed live (2026-08-26, `GET /api/agents/overview`): every observed
`desktop-*` delivery runner — including all three `desktop-DEN1WNSILVA-*`
instances — carries the **standard** runner scopes
(`claim_work`, `git_credential`, `coordination`); the `pr-reviewer` agent is
`custom` (`coordination`, `pr_review`). New `desktop-<THEIRHOST>-*` agents get
the same role-aware baseline the moment they first appear
(`baselineSecurity()` in `server/routes/agent-security.ts` — no stored row
means the standard baseline, never a lockout). Leads see and adjust per-agent
scopes on the `/agents` map.

## Multi-identity verification drill

The point of the beta: prove one person's routed work is invisible to
everyone else, while pool work is visible to all and claimed exactly once.
Run when **both testers plus the lead's machine are online** (fleet shows all
three).

1. Lead routes a scratch ticket to **tester A** (queue with
   `assignee = <A's email>`).
2. On each machine, run the scoping probe:

   ```bash
   # Tester A — must see it
   TICKET=DAT-XXX EXPECT=visible node scripts/verify-identity-scoping.mjs
   # Tester B and the lead's machine — must NOT see it; probe the claim denial too
   TICKET=DAT-XXX EXPECT=hidden CLAIM_PROBE=1 node scripts/verify-identity-scoping.mjs
   ```

   The probe reads the identity-scoped queue (`GET /api/agent/work`) as the
   signed-in identity and, for `EXPECT=hidden` with `CLAIM_PROBE=1`, attempts
   a claim of that ticket and passes only when the console refuses it. The
   claim probe is deliberately only honored on the hidden side — on the
   visible side it would really claim the task.
3. Tester A runs the ticket from ROUTED TO YOU; confirm tester B's app never
   showed it.
4. Lead queues one **pool** ticket (no assignee); all three machines see it
   (`verify-identity-scoping.mjs` prints the pool count); exactly one claims
   — the claim is an atomic compare-and-set (`UPDATE … WHERE state = 'queued'`
   in the claim endpoint), so the other two lose the race and poll on.
5. Record the three probe outputs in the evidence log below.

Server-side, the same predicate is unit-tested in
`server/routes/agent-assignee.test.ts` (`assigneeScope`); the drill is the
live cross-machine proof.

## Evidence log

### 2026-08-26 — provisioning pass (DAT-252 agent run)

- **Tester A — Sean Law (`sean.law@datavail.com`)**: workspace user active ✓;
  `CAN_USE` granted on `delivery-console` ✓ (was missing — before this pass
  only workspace admins and the owner could reach the app URL); roster row
  (id 7) email set ✓ (was null, so routing could never have reached him);
  already an `execution-console` engagement member ✓; added to
  `eec-developers` ✓. Note: he is also in workspace `admins`, so his console
  role resolves **admin** (see role caveat above).
- **Tester B**: identity not recorded on the ticket, in the repo, or on the
  roster at the time of this pass. Provisioning is one
  `provision-beta-tester.mjs` command once the lead names them.
- **Live drill**: not runnable in this pass — no tester machine has ever
  polled the console (fleet shows only `desktop-DEN1WNSILVA-*`). Procedure
  and probes above are ready; run it during the first joint session.
