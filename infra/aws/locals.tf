data "aws_caller_identity" "current" {}

locals {
  base = "${var.name_prefix}-${var.environment}"

  # Names are derived once here so .github/workflows/deploy.yml can mirror
  # them verbatim (it pushes to the repository and redeploys the service by
  # cluster + name). Change a name here and in the workflow together.
  names = {
    cluster     = local.base
    repository  = local.base
    service     = "${local.base}-api"
    exec_role   = "${local.base}-ecs-execution"
    infra_role  = "${local.base}-ecs-infrastructure"
    deploy_user = "${local.base}-github-deploy"
    log_group   = "/ecs/${local.base}/api"
  }

  tags = merge(var.tags, { environment = var.environment })

  # Env var name -> SSM parameter name (SecureString, free tier). Values are
  # placeholders Terraform never touches again (lifecycle ignore_changes);
  # set the real ones with `aws ssm put-parameter --overwrite` — README.
  secrets = {
    DATABASE_URL           = "/${local.base}/database-url"
    ANTHROPIC_API_KEY      = "/${local.base}/anthropic-api-key"
    NEON_AUTH_JWKS_URL     = "/${local.base}/neon-auth-jwks-url"
    GITHUB_APP_PRIVATE_KEY = "/${local.base}/github-app-private-key"
  }

  registry_image = "${aws_ecr_repository.main.repository_url}:${var.image_tag}"
  app_image      = var.bootstrap_placeholder_image ? var.placeholder_image : local.registry_image
  # The hello image answers on `/`; the console's health endpoint is /healthz.
  health_check_path = var.bootstrap_placeholder_image ? "/" : "/healthz"
}
