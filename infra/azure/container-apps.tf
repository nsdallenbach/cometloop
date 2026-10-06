# The two apps from docs/platform-architecture.md section 7: `api` (Express +
# static client, external ingress, scales on HTTP concurrency) and `worker`
# (pg-boss consumer, no ingress, one replica).
#
# Ownership split, and why the lifecycle blocks exist: terraform fixes the
# *shape* of each app (identity, secrets, env, resources, scaling, ingress);
# .github/workflows/deploy.yml owns *what runs* (image, command, args) via
# `az containerapp update`. Ignoring those three attributes means a later
# `terraform apply` never rolls a deployment back to whatever tag happened to
# be in image_tag, and the bootstrap placeholder (variables.tf) is replaced
# by the first deploy without terraform fighting it.

resource "azurerm_container_app" "api" {
  name                         = local.names.api
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  # Single: every update replaces the previous revision once the new one is
  # healthy. Multiple would need explicit traffic splitting in the pipeline.
  revision_mode = "Single"
  tags          = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  # Key Vault references resolved by the platform with the app identity.
  # versionless_id = always the current version, so rotating a secret is
  # `az keyvault secret set` + a restart, with no terraform involvement.
  dynamic "secret" {
    for_each = local.secrets
    content {
      name                = secret.value
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.key].versionless_id
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas

    container {
      name   = "api"
      image  = local.app_image
      cpu    = var.api_cpu
      memory = var.api_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = tostring(var.port)
      }
      env {
        name  = "AI_GATEWAY_URL"
        value = var.ai_gateway_url
      }
      # The console's own sign-in (Neon Auth). Not a secret — the browser
      # talks to this URL directly; the JWKS URL beside it is in Key Vault
      # only because the four secrets travel together (locals.tf).
      env {
        name  = "NEON_AUTH_BASE_URL"
        value = var.neon_auth_base_url
      }
      dynamic "env" {
        for_each = local.secrets
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = tostring(var.api_concurrent_requests)
    }
  }

  ingress {
    external_enabled           = true
    target_port                = var.port
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
      template[0].container[0].command,
      template[0].container[0].args,
    ]
  }
}

resource "azurerm_container_app" "worker" {
  name                         = local.names.worker
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = local.secrets
    content {
      name                = secret.value
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.key].versionless_id
    }
  }

  template {
    # Exactly one: the scheduled ticks use pg-boss singleton keys, so more
    # replicas would be safe but pointless until there is queue depth.
    min_replicas = 1
    max_replicas = 1

    container {
      name    = "worker"
      image   = local.app_image
      command = local.worker_command
      cpu     = var.worker_cpu
      memory  = var.worker_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "AI_GATEWAY_URL"
        value = var.ai_gateway_url
      }
      dynamic "env" {
        for_each = local.secrets
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }

  # No ingress block: nothing reaches the worker over the network.

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
      template[0].container[0].command,
      template[0].container[0].args,
    ]
  }
}
