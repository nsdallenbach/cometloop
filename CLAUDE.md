# AI Assistant Instructions

<!-- appkit-instructions-start -->
## Databricks AppKit

This project uses Databricks AppKit packages. For AI assistant guidance on using these packages, refer to:

- **@databricks/appkit** (Backend SDK): [./node_modules/@databricks/appkit/CLAUDE.md](./node_modules/@databricks/appkit/CLAUDE.md)
- **@databricks/appkit-ui** (UI Integration, Charts, Tables, SSE, and more.): [./node_modules/@databricks/appkit-ui/CLAUDE.md](./node_modules/@databricks/appkit-ui/CLAUDE.md)

### Databricks Skills

For enhanced AI assistance with Databricks CLI operations, authentication, data exploration, and app development, install the Databricks skills:

```bash
databricks aitools install
```
<!-- appkit-instructions-end -->

## Development standards

Read [docs/development-standards.md](./docs/development-standards.md) before
making changes — it is the working agreement for this repo: git/PR flow and
the CI deploy gate, validation commands, database migration ownership rules,
server/client/LLM conventions, and agent-runner discipline. The same document
is mirrored into the app's Standards tab for the Cometloop engagement
(`node scripts/sync-standards.mjs` pushes the repo copy; never edit it in the
tab).

## One product, two shells

The repo ships **one product in two shells** that must move together:

| Package | What it is | Validate with |
|---|---|---|
| `client/` + `server/` | The web console — a Databricks App (AppKit, Express + React/Vite). Deployed by CI on every merge to `main`. | `npm run typecheck && npm run lint && npm run build` (root) |
| `desktop/` | The Electron desktop client — embeds the deployed web console in its Projects entry (and routes it to Workflows, Metrics and Settings) and adds native-only surfaces (Agents, Agent Tools, Identity, Deploys, Terminal). Released by tag (`v*`). | `cd desktop && npm run typecheck && npm run build` |
| `shared/` | Code both shells import: `api-client/` (typed console client), `design/` (tokens), `harnesses/` (coding-agent adapters). | Covered by both of the above |
| `mcp/`, `devbox-runner/`, `scripts/` | Standalone plain-JS packages (MCP server, headless runner, ops scripts). | `node --check <file>` |

Hosting is **not** in this repo: the Terraform stacks (AWS ECS Express Mode,
the Azure alternative, Cloudflare) and the Deploy workflow live in the
private `nsdallenbach/cometloop-infra` repo. This repo's CI hands every
green `main` to that repo's Deploy workflow (`dispatch-deploy` in
`.github/workflows/ci.yml`); nothing here knows how the console is hosted.

Rules that follow from that split:

- **An API or `shared/` change is a two-shell change.** If you touch a route
  the desktop calls (`shared/api-client/index.ts` is the list), a `shared/`
  type, or a work-package/claim payload, update the desktop consumer in the
  same PR and run the desktop typecheck. CI runs it too; do not let it be the
  first time you find out.
- **UI/UX changes carry their parity status.** Board, drawer, planning and
  every other `client/` screen reach the desktop through the embedded webview
  (parity by construction). Anything implemented separately on both sides —
  tokens, fonts, markdown rendering, toasts, theme, card idioms — is
  *shared by design*: tick the parity item in the PR template, update
  [docs/feature-parity-tracker.md](./docs/feature-parity-tracker.md), or file a
  `parity-gap` ticket. Process: [docs/cross-platform-parity.md](./docs/cross-platform-parity.md).
- **Agents are managed on the desktop; the web is read-only for them.**
  Runner agents are developers' local agents: scope, model, MCP servers and
  skills are configured in the desktop Agents page (`desktop/src/renderer`,
  persisted in the desktop config, reported via `PUT /api/agent/self`). The
  web Agents page mirrors that for leads and PMs and only offers governance
  (endpoint agents, security scopes, load balancing, registry publishing).
  Never add runner configuration to the web app.
- **Run `/parity-check` before opening a PR** — the project skill walks the
  classification, the docs that need touching, and the validation for each
  package.

## Which doc to update

| When you change… | Update |
|---|---|
| A server route, table, or the runner/claim contract | `docs/architecture.md` (module list, flows); `docs/devbox-integration.md` if the HTTP contract moved |
| Anything a desktop user sees (nav entry, view, config key, install/update flow) | `desktop/README.md`; `docs/beta-runbook.md` if testers follow it |
| A working agreement (validation, git flow, migrations, prompts) | `docs/development-standards.md`, then `node scripts/sync-standards.mjs` after merge |
| The local-client plan or its status | `docs/local-client-architecture.md` |
| A harness adapter | `devbox-runner/README.md` (the harness table) |
| An LLM flow's fallback | `docs/llm-fallbacks.md` |

## Local development

- Web: copy `.env.example` to `.env` (values come from `databricks.yml` and
  `databricks postgres get-endpoint …`; see README), `databricks auth login`,
  then `npm run dev` → http://localhost:8000. Without `GITHUB_APP_PRIVATE_KEY`
  the repo-sync features are off; everything else works.
- Web without Databricks: set `DATABASE_URL` (a `.env.local` with the Neon URL,
  `npm run dev:local`; or `docker compose up`) and the server boots on plain
  Postgres with every Databricks feature off — model calls take their
  deterministic fallbacks. Details: [docs/local-dev.md](./docs/local-dev.md).
- Desktop against the local server: `cd desktop && APP_URL=http://localhost:8000 npm run dev`.
- The primary checkout is shared by several Claude sessions and the
  emulation runner lives in its own worktree (`~/delivery-runner`, pinned to
  `main`). Use a fresh worktree from `origin/main` for independent work
  (`claude --worktree` puts it under `.claude/worktrees/`, which git, eslint
  and vitest ignore).

## AWS (Agent Toolkit for AWS — new AWS experience)

Hosting for the hosted console (staging first, then production) is **Amazon
ECS Express Mode** in the **Cometloop** project, Region **us-east-2** —
Terraform and runbook in the private `nsdallenbach/cometloop-infra` repo
(`aws/README.md` there). App Runner is sunset and denied by
the project's policy; IAM OIDC providers are denied too, so CI deploys as a
scoped IAM user. The AWS CLI profile is
`cometloop` (`aws login --profile cometloop`; the Agent Toolkit MCP server is
registered with `AWS_MCP_PROXY_PROFILES=cometloop`). The rules below are the
toolkit's starter rules for the new AWS experience; where they conflict with
this project's own instructions, the project's instructions win.

### Terminology

- Say "project" instead of "account" — a project contains an AWS account and
  settings for sharing with other collaborators.
- Say "team member" instead of "IAM user" — users are invited by email, not
  created or federated in IAM.
- Say "AWS Settings" for management tasks at <https://settings.aws.com/>
  (project management, billing, team members, spend limits). Actual AWS
  resources are viewed in the AWS Management Console.
- Say "selected Region" for the user's Region — not "home Region".
- The user has a managed IAM experience: managed service control policies
  (SCPs) and resource control policies (RCPs) govern the use of AWS. IAM
  policies are still needed to let services work with each other. Reference:
  <https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html>

### Constraints

- All projects share a single Region determined by the user's contact
  address (here **us-east-2**). Resources cannot be created elsewhere.
  - MUST create all Regional resources in the project's assigned Region.
  - CAN create AWS WAF and CloudWatch Logs resources in us-east-1 only when a
    global resource (e.g. a global WAF) requires us-east-1 dependencies; when
    inventorying resources, look in both the selected Region and us-east-1
    for those.
  - MUST NOT create Lambda, API Gateway or other Regional resources in any
    other Region. MUST NOT use Lambda@Edge, CloudFormation StackSets,
    cross-Region actions (DynamoDB/S3/RDS replication, multi-Region KMS
    keys) or Route 53 cross-Region routing policies.
  - CloudFront is global and allowed in us-east-1, pointing at
    project-Region origins.
  - If the user cannot confirm their Region (AWS Settings → View all
    projects → Overview → Additional Info → Region), check `~/.aws/config`.
- IAM permissions for human access are managed by AWS. Don't assign roles
  to team members unless absolutely necessary.
- A paid-plan project may have a **spend limit** that pauses it when
  exceeded. On sudden "Access Denied" for operations that previously worked,
  ask about the spend limit (AWS Settings → Billing) and whether the project
  is on the paid plan. After creating resources, ask whether to keep or
  clean them up.
- Not every service is available. If one fails: run
  `aws freetier get-account-plan-state --profile cometloop`; for `FREE` check
  the Free Tier supported-services list, for `PAID` the Paid Tier list, else
  the "Not supported for this experience" list — the user may need to
  activate advanced features.
  <https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html>
- Before starting an AWS task, check whether a relevant AWS skill is
  available (`retrieve_skill` on the aws-mcp server) and prefer its guidance.

### Help level

`help_level`: **not yet set** — ask once: "How much guidance would you like
from me? Low (I only flag security risks), medium (I ask a couple of
clarifying questions if something seems off), or high (I explain what I'm
doing, suggest alternatives, and flag best practices)." Then record the
answer here.

- **LOW**: follow the constraints, execute requests without modification, no
  clarifying questions unless the action would create a security
  vulnerability, no alternatives.
- **MEDIUM**: execute the request; up to two clarifying questions per task
  when something is ambiguous or off; never repeat a dismissed question; no
  trade-off explanations unless asked.
- **HIGH**: explain each step before executing, suggest alternatives when a
  better approach exists, flag best practices; still execute the user's
  choice.
