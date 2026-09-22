output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "acr_login_server" {
  description = "Registry host the deploy workflow pushes to."
  value       = azurerm_container_registry.main.login_server
}

output "acr_name" {
  value = azurerm_container_registry.main.name
}

output "key_vault_name" {
  description = "Target for `az keyvault secret set --vault-name`."
  value       = azurerm_key_vault.main.name
}

output "key_vault_secret_names" {
  description = "Env var -> Key Vault secret name; each needs its real value set out of band."
  value       = local.secrets
}

output "api_fqdn" {
  description = "Container Apps ingress hostname; the Cloudflare CNAME target (infra/cloudflare var aca_fqdn)."
  value       = azurerm_container_app.api.ingress[0].fqdn
}

output "custom_domain_verification_id" {
  description = "Value of the `asuid.app` TXT record (infra/cloudflare var custom_domain_verification_id)."
  value       = azurerm_container_app_environment.main.custom_domain_verification_id
}

output "container_app_names" {
  value = {
    api    = azurerm_container_app.api.name
    worker = azurerm_container_app.worker.name
  }
}

output "app_identity" {
  description = "User-assigned identity shared by api and worker."
  value = {
    id           = azurerm_user_assigned_identity.app.id
    client_id    = azurerm_user_assigned_identity.app.client_id
    principal_id = azurerm_user_assigned_identity.app.principal_id
  }
}

output "github_deploy_client_id" {
  description = "AZURE_CLIENT_ID repo secret."
  value       = azuread_application.github_deploy.client_id
}

output "tenant_id" {
  description = "AZURE_TENANT_ID repo secret."
  value       = data.azurerm_client_config.current.tenant_id
}

output "subscription_id" {
  description = "AZURE_SUBSCRIPTION_ID repo secret."
  value       = data.azurerm_client_config.current.subscription_id
}
