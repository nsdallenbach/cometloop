# Infrastructure

Terraform for the hosted console described in
[docs/platform-architecture.md](../docs/platform-architecture.md) sections 3
and 7, plus the GitHub Actions deploy pipeline. Two stacks:

| Stack | Provider | Creates |
|---|---|---|
| `infra/azure` | azurerm 4, azuread 3, azapi 2 | resource group, Log Analytics, ACR (Basic), Key Vault (RBAC) with placeholder secrets, Container Apps environment, user-assigned identity, `api` + `worker` container apps, managed certificate + `app.cometloop.ai` binding, GitHub OIDC app registration |
| `infra/cloudflare` | cloudflare 5 | `app.cometloop.ai` CNAME, `asuid.app` TXT (Azure domain verification), AI Gateway `cometloop` |

Not managed here, on purpose: the Neon project (`misty-water-72985311`, see
`neon.ts`), the `cometloop.ai` apex site (Workers static assets, deployed
separately), and every secret *value*.

Nothing has been applied. State is local; `versions.tf` in each stack has a
commented `azurerm` backend block and the commands to create the storage
account for it. Move state there before a second person applies.

## Order of operations once the subscription exists

Every command below is run by a human from the repo root. Values marked
"paste" are typed or piped in by hand and never written to a file in the
repo.

### 1. Azure: sign in and pick the subscription

```bash
az login
az account set --subscription "<subscription name or id>"
az account show --query '{name:name, id:id, tenant:tenantId}'
```

The signed-in user needs Owner (or Contributor + User Access Administrator)
on the subscription: the stack creates role assignments. It also creates an
Entra app registration, so the user needs Application Administrator in the
tenant or the default "users can register applications" setting.

### 2. Azure: first apply

```bash
cd infra/azure
terraform init
terraform apply
```

Takes 10-15 minutes, most of it the Container Apps environment and a 90 s
pause for RBAC propagation (`key-vault.tf`). `custom_domain_enabled` stays at
its default `false` here: the domain needs DNS records that need outputs from
this apply.

Both apps come up on a public placeholder image (`variables.tf`,
`bootstrap_placeholder_image`) because the registry is empty until the
first deploy. That is expected; the api answers with a greeting on its
`azurecontainerapps.io` hostname and the worker idles.

Note the outputs; steps 3-5 use them:

```bash
terraform output
```

### 3. Key Vault: set the real secret values

Terraform created four secrets holding the literal text `PLACEHOLDER ...`
and will never touch their values again (`lifecycle { ignore_changes =
[value] }`). Set each one:

```bash
KV=$(terraform output -raw key_vault_name)

# Neon connection string, from the Neon console or `neon connection-string`.
az keyvault secret set --vault-name "$KV" --name database-url --value '<paste>'

# Anthropic key for the default provider.
az keyvault secret set --vault-name "$KV" --name anthropic-api-key --value '<paste>'

# Neon Auth JWKS endpoint for the project (not secret, but lives with the rest).
az keyvault secret set --vault-name "$KV" --name neon-auth-jwks-url --value '<paste>'

# GitHub App private key: multi-line PEM, so read it from a file outside the repo.
az keyvault secret set --vault-name "$KV" --name github-app-private-key --file ~/cometloop-github-app.pem
```

Use `--value "$(pbpaste)"` / `--value "$(xclip -o)"` rather than typing a key
into a shell that keeps history, or prefix the command with a space if
`HISTCONTROL=ignorespace` is set. Container Apps reads a secret when a
revision is provisioned, so a value changed later needs
`az containerapp revision restart` (or the next deploy) to take effect.

### 4. Cloudflare: DNS and AI Gateway

The API token needs `Zone > DNS > Edit` on `cometloop.ai` and
`Account > AI Gateway > Edit`. Create it in the dashboard (My Profile > API
Tokens) and export it; the provider reads the environment variable.

```bash
cd ../cloudflare
export CLOUDFLARE_API_TOKEN='<paste>'
terraform init
terraform apply \
  -var zone_id=<cometloop.ai zone id, dashboard Overview page> \
  -var aca_fqdn="$(terraform -chdir=../azure output -raw api_fqdn)" \
  -var custom_domain_verification_id="$(terraform -chdir=../azure output -raw custom_domain_verification_id)"
```

The apex site's records are not in this stack and are not touched. The CNAME
is proxied by default (`-var proxied=false` for DNS-only). Set the zone's
SSL mode to **Full (strict)** in the dashboard (SSL/TLS > Overview) if it is
not already; the Azure managed certificate is publicly trusted so strict
works, and anything looser lets Cloudflare connect to the origin without
verifying it.

### 5. Azure: second apply for the custom domain

```bash
cd ../azure
terraform apply -var custom_domain_enabled=true
```

Adds `app.cometloop.ai` to the api, requests the managed certificate
(validated through the `asuid` TXT record, so the proxied CNAME does not get
in the way) and binds it. Issuance usually takes 5-15 minutes; the apply
waits. If it fails with a validation error, the TXT record has not
propagated yet - wait and re-run. From then on include
`-var custom_domain_enabled=true` in every apply (or put it in a local
`terraform.tfvars`, which is git-ignored).

### 6. GitHub: deploy identity and the gate

The deploy workflow authenticates with OIDC, so the three "secrets" are
identifiers rather than credentials:

```bash
gh secret set AZURE_CLIENT_ID       --repo nsdallenbach/cometloop --body "$(terraform output -raw github_deploy_client_id)"
gh secret set AZURE_TENANT_ID       --repo nsdallenbach/cometloop --body "$(terraform output -raw tenant_id)"
gh secret set AZURE_SUBSCRIPTION_ID --repo nsdallenbach/cometloop --body "$(terraform output -raw subscription_id)"
gh variable set DEPLOY_ENABLED      --repo nsdallenbach/cometloop --body true
```

Until `DEPLOY_ENABLED` is `true` the Deploy workflow's job is skipped on
every trigger, which is why this pipeline can be merged before the
subscription exists.

### 7. First deploy

```bash
gh workflow run deploy.yml --repo nsdallenbach/cometloop --ref main
gh run watch --repo nsdallenbach/cometloop
```

Builds the root `Dockerfile`, pushes `<acr>/cometloop:<sha>` and `:latest`,
and updates both apps to `<sha>` (the worker with the
`node dist/server/worker.js` command). After this, every green CI run on
`main` deploys the same way.

## What to check after the first deploy

- `gh run view --log` shows both `az containerapp update` steps and the
  Verify step reporting `provisioning=Succeeded` and a healthy revision for
  api and worker.
- `https://app.cometloop.ai` serves the console over a Cloudflare-issued
  certificate; `curl -sI https://<api_fqdn>` (the Azure hostname) shows the
  managed certificate. Both should return the app, not the placeholder
  greeting.
- Worker logs show pg-boss starting and the scheduled ticks registering:
  `az containerapp logs show -n cometloop-prod-worker -g cometloop-prod-rg --tail 50`.
- Log Analytics receives console output from both apps
  (`ContainerAppConsoleLogs_CL`, a few minutes behind).
- Key Vault references resolved: `az containerapp show -n cometloop-prod-api
  -g cometloop-prod-rg --query 'properties.configuration.secrets[].name'`
  lists the four names, and the app's `/healthz` (or `/api/llm/health` until
  it exists) reports a database connection.
- The AI Gateway dashboard (Cloudflare > AI > AI Gateway > cometloop) shows
  requests once a model call has gone through.
- The api's scale rule is in place: `az containerapp show ... --query
  'properties.template.scale'` shows min 1 / max 3 and the
  `http-concurrency` rule.
- `terraform plan` in `infra/azure` (with `-var custom_domain_enabled=true`)
  is empty: the image/command changes made by the deploy are ignored by
  design.

## Rough monthly cost

Consumption pricing, East US 2, list prices at the time of writing; the
first 180,000 vCPU-s and 360,000 GiB-s per month on Container Apps are free
and Log Analytics ingests the first 5 GB free.

| Item | Basis | Approx. USD/month |
|---|---|---|
| Container Apps `api` | 1 replica always on at 0.5 vCPU / 1 GiB, mostly active | 25-40 |
| Container Apps `worker` | 1 replica at 0.25 vCPU / 0.5 GiB, mostly idle (idle rate is ~1/8 of active) | 5-12 |
| Container Registry | Basic tier, 10 GB included | 5 |
| Log Analytics | a few GB/month above the free 5 GB at ~$2.30-2.76/GB, 30-day retention | 0-10 |
| Key Vault | per 10k operations; the apps read at revision start | < 1 |
| Cloudflare DNS, proxy, AI Gateway | Free plan | 0 |
| **Total** | | **~40-70** |

Scaling the api to 3 replicas under load adds ~$1/day per extra replica
while it lasts. Neon is billed separately on its own plan.

## Day-to-day

- Change infrastructure: edit, `terraform plan`, `terraform apply` in the
  stack. Names are derived in `infra/azure/locals.tf`; the deploy workflow's
  `env` block mirrors them, so rename in both places.
- Rotate a secret: `az keyvault secret set` then
  `az containerapp revision restart` on each app (or push to main).
- Roll back: `gh workflow run deploy.yml` deploys `main`, so revert the
  commit; or `az containerapp update --image <acr>/cometloop:<older sha>`
  by hand - terraform will not undo it.
- Redeploy the apps from scratch after an image exists:
  `terraform apply -var bootstrap_placeholder_image=false -var image_tag=<sha>`.

## AWS — the hosting that is actually being set up

The Azure stack above was written first and is kept as the alternative;
**nothing of it is applied.** The console is going to **Amazon ECS Express
Mode** instead — one Fargate service whose load balancer, HTTPS listener,
target group, security groups and autoscaling ECS provisions and manages
(App Runner is sunset and denied by the project's policy). Everything about it — the stack, cost, order of
operations, DNS, Neon Auth trusted origins, GitHub Environments and the
first deploy — is in [aws/README.md](aws/README.md). `deploy.yml` targets
AWS; the Azure path has no workflow any more.
