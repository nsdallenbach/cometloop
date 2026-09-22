# Passwordless deploys from GitHub Actions. The workflow (.github/workflows/
# deploy.yml) asks GitHub for an OIDC token and exchanges it for an Entra
# token via azure/login; Entra accepts it because the federated credential
# below trusts tokens whose subject is a run on this repo's deploy branch.
# No client secret exists, so nothing expires and nothing can leak.
#
# After apply, set the three repo secrets from the outputs:
#
#   gh secret set AZURE_CLIENT_ID       --repo nsdallenbach/cometloop --body "$(terraform output -raw github_deploy_client_id)"
#   gh secret set AZURE_TENANT_ID       --repo nsdallenbach/cometloop --body "$(terraform output -raw tenant_id)"
#   gh secret set AZURE_SUBSCRIPTION_ID --repo nsdallenbach/cometloop --body "$(terraform output -raw subscription_id)"
#
# None of the three is sensitive on its own (they are identifiers, not
# credentials) but GitHub secrets keep them out of logs.

resource "azuread_application" "github_deploy" {
  display_name = local.names.github_oidc
  notes        = "GitHub Actions deploy identity for ${var.github_repository}; managed by terraform in infra/azure."
}

resource "azuread_service_principal" "github_deploy" {
  client_id = azuread_application.github_deploy.client_id
}

resource "azuread_application_federated_identity_credential" "github_branch" {
  application_id = azuread_application.github_deploy.id
  display_name   = "github-${replace(var.github_repository, "/", "-")}-${var.github_deploy_branch}"
  description    = "Workflow runs on ${var.github_deploy_branch} of ${var.github_repository}"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  # `workflow_run`-triggered and `workflow_dispatch` runs on main both carry
  # this subject. A dispatch from another branch is rejected by design.
  subject = "repo:${var.github_repository}:ref:refs/heads/${var.github_deploy_branch}"
}

# Push images.
resource "azurerm_role_assignment" "github_acr_push" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = azuread_service_principal.github_deploy.object_id
}

# `az containerapp update` writes the app (Microsoft.App/containerApps/write)
# and re-asserts its user-assigned identity, which needs the identity's
# assign/action. Contributor on the resource group covers both; scoping it to
# the two apps plus the identity would need three assignments and a custom
# role for marginal gain.
resource "azurerm_role_assignment" "github_rg_contributor" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.github_deploy.object_id
}
