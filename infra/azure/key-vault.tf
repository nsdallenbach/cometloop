# Key Vault in RBAC mode. Terraform creates each secret once with a
# placeholder value; a human sets the real value with `az keyvault secret set`
# (infra/README.md) and terraform never reads it back or overwrites it -
# `ignore_changes = [value]` below. Real values never touch the repo, the
# plan output or the state file beyond the placeholder.

resource "azurerm_key_vault" "main" {
  name                       = local.names.key_vault
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
  # Off while the stack is young: with purge protection on, a destroy blocks
  # the vault name for the retention period. Turn it on once the vault
  # holds customer-facing keys and destroys are no longer routine.
  purge_protection_enabled = false
  tags                     = local.tags
}

# Whoever runs terraform needs write access to create the placeholders. In
# RBAC mode even the subscription Owner has no data-plane rights by default.
resource "azurerm_role_assignment" "deployer_kv_secrets_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Azure RBAC is eventually consistent; writing a secret right after the
# assignment returns 403 for up to a few minutes, and a container app whose
# identity cannot yet read the vault fails to provision its first revision.
# The apps reference the secrets, so they inherit this pause transitively.
resource "time_sleep" "rbac_propagation" {
  depends_on = [
    azurerm_role_assignment.deployer_kv_secrets_officer,
    azurerm_role_assignment.app_kv_secrets_user,
    azurerm_role_assignment.app_acr_pull,
  ]
  create_duration = "90s"
}

resource "azurerm_key_vault_secret" "app" {
  for_each = local.secrets

  name         = each.value
  key_vault_id = azurerm_key_vault.main.id
  value        = "PLACEHOLDER - set with az keyvault secret set, see infra/README.md"
  content_type = "set out of band; terraform ignores the value"
  tags         = local.tags

  lifecycle {
    # The whole point: terraform owns the secret's existence, not its value.
    ignore_changes = [value]
  }

  depends_on = [time_sleep.rbac_propagation]
}
