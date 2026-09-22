# app.cometloop.ai on the api's ingress with a free Azure-managed certificate.
#
# This needs two applies because of a circular dependency across the two
# stacks: Azure only accepts the hostname once it can see a TXT record
# `asuid.app.cometloop.ai` whose value is this environment's verification
# id, and that id only exists after the environment is created.
#
#   1. terraform apply                     (custom_domain_enabled=false, default)
#      -> outputs custom_domain_verification_id and api_fqdn
#   2. cd ../cloudflare && terraform apply (creates the CNAME + asuid TXT)
#   3. terraform apply -var custom_domain_enabled=true
#      -> adds the hostname, requests the certificate (a few minutes while
#         Azure validates and DigiCert issues), binds it
#
# All three resources are gated on the same variable so step 1 does not try
# to add the hostname before its TXT record exists.
#
# Why azapi for two of the three: azurerm models BYO certificates
# (azurerm_container_app_environment_certificate) but not managed ones, and
# its custom-domain resource cannot bind a managed certificate. The ARM
# resource `managedCertificates` and the `customDomains` entry on the app
# are small enough to drive directly.

resource "azurerm_container_app_custom_domain" "app" {
  count = var.custom_domain_enabled ? 1 : 0

  name             = var.custom_domain
  container_app_id = azurerm_container_app.api.id

  lifecycle {
    # The binding is written by azapi_update_resource.bind below; without
    # this azurerm would see the SNI binding as drift and try to remove it.
    ignore_changes = [certificate_binding_type, container_app_environment_certificate_id]
  }
}

resource "azapi_resource" "managed_certificate" {
  count = var.custom_domain_enabled ? 1 : 0

  type      = "Microsoft.App/managedEnvironments/managedCertificates@2024-03-01"
  name      = local.names.managed_cert
  parent_id = azurerm_container_app_environment.main.id
  location  = azurerm_resource_group.main.location
  tags      = local.tags

  body = {
    properties = {
      subjectName             = var.custom_domain
      domainControlValidation = var.certificate_validation_method
    }
  }

  # Azure will not issue for a hostname the environment does not know yet.
  depends_on = [azurerm_container_app_custom_domain.app]
}

# Binds the certificate: the hostname entry on the app gains the certificate
# id and switches from Disabled to SniEnabled. Equivalent of
# `az containerapp hostname bind`.
resource "azapi_update_resource" "bind" {
  count = var.custom_domain_enabled ? 1 : 0

  type        = "Microsoft.App/containerApps@2024-03-01"
  resource_id = azurerm_container_app.api.id

  body = {
    properties = {
      configuration = {
        ingress = {
          customDomains = [
            {
              name          = var.custom_domain
              bindingType   = "SniEnabled"
              certificateId = azapi_resource.managed_certificate[0].id
            }
          ]
        }
      }
    }
  }
}
