terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Local state until the Azure state backend exists (infra/azure/versions.tf
  # has the storage-account commands); then share the same container:
  #
  # backend "azurerm" {
  #   resource_group_name  = "cometloop-tfstate-rg"
  #   storage_account_name = "cometlooptfstate"
  #   container_name       = "tfstate"
  #   key                  = "cloudflare.prod.tfstate"
  #   use_azuread_auth     = true
  # }
}

provider "cloudflare" {
  # null here makes the provider fall back to the CLOUDFLARE_API_TOKEN
  # environment variable, which is how the token is meant to arrive; the
  # variable exists so a CI runner can pass it explicitly instead.
  api_token = var.api_token
}
