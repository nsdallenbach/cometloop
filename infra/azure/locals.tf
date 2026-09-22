data "azurerm_client_config" "current" {}

locals {
  base = "${var.name_prefix}-${var.environment}"

  # Names are derived once here so .github/workflows/deploy.yml can mirror
  # them verbatim (it calls `az containerapp update` by name). Change a name
  # here and in the workflow's env block together.
  names = {
    resource_group = "${local.base}-rg"
    log_analytics  = "${local.base}-law"
    # ACR names: 5-50 alphanumerics, globally unique.
    registry = replace("${local.base}acr", "-", "")
    # Key Vault names: 3-24 chars, globally unique.
    key_vault    = "${local.base}-kv"
    identity     = "${local.base}-id"
    environment  = "${local.base}-env"
    api          = "${local.base}-api"
    worker       = "${local.base}-worker"
    github_oidc  = "${local.base}-github-deploy"
    managed_cert = replace(var.custom_domain, ".", "-")
  }

  tags = merge(var.tags, { environment = var.environment })

  # Env var name -> Key Vault secret name (KV allows only [a-zA-Z0-9-]).
  # Both apps get all four; the api is the only consumer of the GitHub App
  # key today but the worker's repo-sync loop will need it once it moves
  # behind pg-boss (docs/platform-architecture.md section 7).
  secrets = {
    DATABASE_URL           = "database-url"
    ANTHROPIC_API_KEY      = "anthropic-api-key"
    NEON_AUTH_JWKS_URL     = "neon-auth-jwks-url"
    GITHUB_APP_PRIVATE_KEY = "github-app-private-key"
  }

  registry_image = "${azurerm_container_registry.main.login_server}/${var.image_repository}:${var.image_tag}"
  app_image      = var.bootstrap_placeholder_image ? var.placeholder_image : local.registry_image

  # With the placeholder there is no worker entrypoint to run; the deploy
  # workflow sets the real command on the first deploy.
  worker_command = var.bootstrap_placeholder_image ? null : ["node", "dist/server/worker.js"]
}
