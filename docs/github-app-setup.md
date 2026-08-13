# GitHub App setup

The console's first-class GitHub auth is a **GitHub App**: no tokens pasted or
stored — connections keep only an installation id, and the server mints
short-lived (~1 h) installation tokens for syncs and for vending git
credentials to devbox runners. The pasted-PAT flow remains as a fallback and
for Azure DevOps.

## 1. Register the App (org admin, one time)

GitHub → your org (e.g. `datavail-solutions`) → **Settings → Developer
settings → GitHub Apps → New GitHub App**:

- **Name**: `delivery-console` (shows as `delivery-console[bot]`)
- **Homepage URL**: the app URL
  (`https://delivery-console-7474645607548631.aws.databricksapps.com`)
- **Webhook**: leave **inactive** for now — Databricks Apps sit behind the
  workspace OAuth proxy, so GitHub cannot deliver events directly yet. The
  console already exposes an HMAC-verified receiver at
  `POST /api/webhooks/github` (events: `push`, `pull_request`) for when
  unauthenticated ingress or a relay is available; refresh comes from polling
  until then.
- **Permissions** (Repository):
  - Contents: **Read & write** (runners push branches)
  - Pull requests: **Read & write** (runners open PRs)
  - Actions: **Read-only** (the deploy watch polls workflow runs to gate
    tickets on the pipeline; without it merged tickets settle to Done
    unverified, with a warning in the feed)
  - Metadata: Read-only (mandatory)

> Already installed without Actions access? Edit the App's permissions, then
> approve the permission update under the org's **Installations** page —
> tokens pick up the new scope on the next sync.
- **Where can it be installed**: Only on this account.

After creating: note the **App ID**, then **Generate a private key** (.pem
download).

## 2. Install it on your repos

App settings → **Install App** → choose the org → select the delivery repos
(e.g. `datavail-solutions/engagement-console`). That's the entire per-repo
credential story — access is managed on this screen from now on.

## 3. Configure the console

Put the key in a Databricks secret scope and wire env vars:

```bash
databricks secrets create-scope delivery-console
databricks secrets put-secret delivery-console github-app-private-key --string-value "$(cat delivery-console.*.private-key.pem)"
```

`databricks.yml` — add a secret resource to the app:

```yaml
      resources:
        - name: github-app-private-key
          secret:
            scope: delivery-console
            key: github-app-private-key
            permission: READ
```

`app.yaml` — expose it plus the App id:

```yaml
env:
  - name: GITHUB_APP_ID
    value: "<app id>"
  - name: GITHUB_APP_PRIVATE_KEY
    valueFrom: github-app-private-key
  # optional, only once webhooks can reach the app:
  # - name: GITHUB_APP_WEBHOOK_SECRET
  #   valueFrom: github-app-webhook-secret
```

Deploy (`databricks bundle deploy && databricks bundle run app`). The
`GET /api/github-app/status` endpoint confirms configuration and lists
installations.

## 4. Connect a repo

Engagement → Config → Repository: leads now see a **GitHub App** picker
listing every installed repo — pick one and Connect. No token field.

## 5. Devbox runners get credentials vended

For App-connected repos, a runner holding a claimed task exchanges it for a
fresh git credential instead of carrying its own:

```bash
CRED=$(curl -s -X POST "$APP/api/agent/work/$TASK_ID/git-credential" -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"agent\": \"$AGENT\"}")
git clone "$(echo "$CRED" | jq -r .cloneUrl)" repo   # token expires in ~1 h
```

The same token authenticates `gh`/REST calls to open the PR
(`GH_TOKEN=$(echo "$CRED" | jq -r .token)`). PAT-connected repos return 409 —
those runners bring their own credentials as before.
