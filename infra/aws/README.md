# Cometloop on Amazon ECS Express Mode

Terraform for the hosted console on **Amazon ECS Express Mode**: one
Fargate service from a single resource, with the Application Load Balancer,
HTTPS listener, target group, security groups and autoscaling provisioned
and managed by ECS. Applied once per environment (`environment = "staging"`
/ `"prod"`), each with its own state. Region **us-east-2** — the
new-experience Cometloop project's single Region, and the Neon project's.
`staging.tfvars.example` and `prod.tfvars.example` hold the values.

Why not App Runner: AWS sunset it in April 2026 (no new customers) and the
project's managed service control policy denies it outright; AWS's own
migration target is Express Mode. Why no OIDC for GitHub: the same policy
denies every IAM `*Provider*` action, so the deploy identity is a scoped
IAM user instead (`github-deploy.tf`).

What one environment creates:

| Resource | Purpose |
|---|---|
| ECR repository `cometloop-<env>` | the console image; last 10 kept; scan on push |
| SSM SecureString parameters `/cometloop-<env>/…` | `database-url`, `anthropic-api-key`, `neon-auth-jwks-url`, `github-app-private-key` — placeholder values Terraform never overwrites |
| ECS cluster `cometloop-<env>`, log group `/ecs/cometloop-<env>/api` | where the service and its logs live |
| Express Mode service `cometloop-<env>-api` | the api on Fargate: health check `/healthz`, env from variables, secrets from the parameters above; ECS creates the ALB + HTTPS listener + target group + security groups + CPU autoscaling for it |
| IAM roles `…-ecs-execution`, `…-ecs-infrastructure` | pull the image, write logs, read the parameters; let ECS manage the load-balancer stack (`AmazonECSInfrastructureRoleforExpressGatewayServices`) |
| ACM certificate for the custom domain | `staging.cometloop.ai` / `app.cometloop.ai`; attached to the Express listener by `attach-domain.sh` |
| IAM user `/ci/cometloop-<env>-github-deploy` | what `.github/workflows/deploy.yml` signs in as: push to the repository, redeploy the service |

No worker: it is still a stub (`server/worker.ts`). When phase 4 splits the
background loops out it becomes a second service or a scheduled task on the
same cluster.

## Cost

us-east-2 list prices, approximate:

| Item | Basis | USD/month |
|---|---|---|
| Fargate task, staging | 1 × 0.25 vCPU / 512 MiB always on | ≈ 9 |
| Application Load Balancer | fixed hourly + light traffic | ≈ 17–20 |
| Fargate tasks, production | 1–3 × 0.5 vCPU / 1 GiB | 18–55 |
| ECR, SSM (standard), CloudWatch logs | low volume | 0–2 |

So staging is roughly **USD 27–32 a month**, most of it the load balancer.
The free plan's USD 100 credit (expires 2027-04-05) covers the first few
months. Neon is billed separately on its own plan.

## Order of operations

Prerequisites: the AWS CLI v2 signed in to the Cometloop project
(`aws login --profile cometloop`), Terraform ≥ 1.6, `python` on PATH (the
helper script uses it). The provider reads the profile from `aws_profile`
(default `cometloop`). Every command below runs from `infra/aws`.

### 1. Apply the stack

```bash
cp staging.tfvars.example staging.tfvars     # git-ignored; edit if needed
terraform init                               # S3 backend: add -backend-config="key=aws.staging.tfstate" (versions.tf)
terraform apply -var-file=staging.tfvars
terraform output
```

The service comes up on AWS's public hello image because the repository is
empty until the first deploy; the `service_endpoints` hostname answers with
its greeting over HTTPS (ECS's own certificate). With local state and two
environments, `terraform workspace new staging` / `prod` before each apply
keeps them apart.

### 2. Set the secret values

Never in a file in the repo. `aws ssm put-parameter --overwrite` on the
names from `terraform output ssm_parameter_names`:

```bash
P=/cometloop-staging
aws ssm put-parameter --overwrite --type SecureString --name "$P/database-url" --value '<Neon staging branch pooled connection string>'
aws ssm put-parameter --overwrite --type SecureString --name "$P/neon-auth-jwks-url" --value 'https://ep-curly-unit-b5qfj8cm.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth/.well-known/jwks.json'
aws ssm put-parameter --overwrite --type SecureString --name "$P/anthropic-api-key" --value '<key>'
# GitHub App key: multi-line PEM from a file outside the repo — or leave the
# placeholder on staging: two instances polling one installation would
# double-post on real PRs.
aws ssm put-parameter --overwrite --type SecureString --name "$P/github-app-private-key" --value "file://$HOME/cometloop-github-app.pem"
```

Use `--value "$(pbpaste)"` or a leading space with `HISTCONTROL=ignorespace`
rather than typing a secret into a shell that keeps history. ECS injects
parameters at task start, so a changed value needs a new deployment:
`aws ecs update-service --cluster cometloop-staging --service cometloop-staging-api --force-new-deployment`.

### 3. Deploy identity and the GitHub Environment

Mint the deploy user's key (Terraform created the user and its policy, never
the key) and put it in a GitHub Environment per environment, with the
`DEPLOY_ENABLED` gate:

```bash
aws iam create-access-key --user-name "$(terraform output -raw deploy_user_name)"   # note AccessKeyId + SecretAccessKey once
gh api -X PUT repos/nsdallenbach/cometloop/environments/staging
gh secret set AWS_ACCESS_KEY_ID     --env staging --repo nsdallenbach/cometloop --body '<AccessKeyId>'
gh secret set AWS_SECRET_ACCESS_KEY --env staging --repo nsdallenbach/cometloop --body '<SecretAccessKey>'
gh variable set DEPLOY_ENABLED      --env staging --repo nsdallenbach/cometloop --body true
```

`production` the same way after the prod apply; give it a required reviewer
if promotion should need a click. Rotate by creating a second key, updating
the two secrets, deleting the first. Until `DEPLOY_ENABLED` is `true` the
job skips itself on every trigger, which is why the workflow can be merged
before the stack exists.

### 4. First deploy and the flip off the placeholder

```bash
gh workflow run deploy.yml --repo nsdallenbach/cometloop --ref main   # staging is the default input
gh run watch --repo nsdallenbach/cometloop
```

It pushes `<sha>` and `staging` tags, then stops because the service still
runs the placeholder. Flip the stack:

```bash
terraform apply -var-file=staging.tfvars -var bootstrap_placeholder_image=false
```

ECS rolls the service onto `<repository>:staging` with the `/healthz`
health check. Put `bootstrap_placeholder_image = false` into
`staging.tfvars` from then on; every later run of the workflow moves the
tag and forces a new deployment.

### 5. Certificate and DNS (Cloudflare, zone cometloop.ai)

`terraform output custom_domain_dns_records` lists two records. Create the
**ACM validation** CNAME first, DNS-only (grey cloud), and wait for the
certificate to show `ISSUED` (`aws acm describe-certificate`, usually a few
minutes). Then attach it to the Express-managed listener and let the
listener's host rule accept the hostname:

```bash
AWS_PROFILE=cometloop ./attach-domain.sh
```

Finally create **the hostname** CNAME (`staging` → the service endpoint).
It may be proxied; set the zone's SSL mode to **Full (strict)** — the ACM
certificate on the load balancer is publicly trusted. The `infra/cloudflare`
stack is written for one hostname; extend it or create these by hand.
Re-run the script if an Express Mode update ever recreates the listener.

### 6. Neon Auth trusted origin

Sign-in redirects only to allow-listed origins. Register the hostname on
the **staging** branch before pointing testers at it, and production's on
`production`:

```bash
neon neon-auth domain add https://staging.cometloop.ai     # select the staging branch
neon neon-auth domain add https://app.cometloop.ai         # select the production branch
```

### 7. Who may sign in

`app.tenant_members` on the staging branch. An admin adds testers before
they sign up — `POST /api/admin/members {"email": "…", "role": "member"}`
(console admins are `owner` / `admin` rows) — or in SQL. A sign-in whose
email is not a member is answered `No workspace`.

From then on every green CI run on `main` deploys to staging on its own;
production deploys only when someone runs the Deploy workflow with
`environment = production`.

## What to check after the first deploy

- `https://<service endpoint>/healthz` → `{ ok: true, db: { ok: true } }`
  (then the same on `https://staging.cometloop.ai/healthz`).
- `/api/auth/config` → `{ provider: 'neon-auth', url }` with the branch's auth URL.
- The sign-in screen renders at the root URL; signing in as a member lands
  on the portfolio; an unknown email gets `No workspace`.
- `aws ecs describe-services` shows one running task on the
  `<repository>:staging` image; the log group `/ecs/cometloop-staging/api`
  carries the boot lines (`[main] Postgres via DATABASE_URL_UNPOOLED …`).
- `terraform plan` is empty: the image is pinned by tag and parameter values
  are ignored by design.

## Day-to-day

- Change infrastructure: edit, `terraform plan`, `terraform apply` with the
  environment's var-file. Names are derived in `locals.tf`; the deploy
  workflow derives the same names from the environment, so rename in both.
- Rotate a secret: `aws ssm put-parameter --overwrite`, then
  `aws ecs update-service … --force-new-deployment`.
- Roll back: re-run the Deploy workflow on a revert, or by hand re-tag an
  older `<sha>` as `staging` (`aws ecr batch-get-image` + `put-image`) and
  force a new deployment.
- Spend limit: a paid-plan project can pause itself when its limit is hit
  (its policy then denies `ecs:CreateService` and friends); sudden
  `Access Denied` on things that used to work means check AWS Settings →
  Billing.
