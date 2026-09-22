# Foundation: resource group, logs, registry, identity.
# Secrets live in key-vault.tf, the apps in container-apps.tf, the domain in
# custom-domain.tf and the GitHub deploy identity in github-oidc.tf.

resource "azurerm_resource_group" "main" {
  name     = local.names.resource_group
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = local.names.log_analytics
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

resource "azurerm_container_registry" "main" {
  name                = local.names.registry
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Basic"
  # No admin user: the apps pull with the managed identity (AcrPull below)
  # and GitHub pushes with its federated identity (AcrPush, github-oidc.tf),
  # so there is no registry password to store anywhere.
  admin_enabled = false
  tags          = local.tags
}

# One identity shared by both apps: same registry, same secrets. Splitting
# it buys nothing until the worker needs a permission the api must not have.
resource "azurerm_user_assigned_identity" "app" {
  name                = local.names.identity
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "app_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "app_kv_secrets_user" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_container_app_environment" "main" {
  name                       = local.names.environment
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = local.tags
  # No workload_profile block = consumption-only environment: billed per
  # vCPU-second and GiB-second with no reserved nodes, which is the right
  # shape for two small always-on apps.
}
