terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    # App registration + federated credential for GitHub OIDC (github-oidc.tf).
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    # azurerm has no resource for Container Apps *managed* certificates
    # (only BYO certificates), so the free managed cert and its binding go
    # through the ARM API directly (custom-domain.tf).
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
    # RBAC assignments take up to a couple of minutes to propagate; without
    # a pause the first apply fails writing the Key Vault placeholders.
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # State stays local until the subscription exists. To move it to Azure
  # Storage afterwards (recommended before a second person applies):
  #
  #   az group create -n cometloop-tfstate-rg -l eastus2
  #   az storage account create -n cometlooptfstate -g cometloop-tfstate-rg \
  #     -l eastus2 --sku Standard_LRS --allow-blob-public-access false
  #   az storage container create -n tfstate --account-name cometlooptfstate \
  #     --auth-mode login
  #
  # then uncomment, run `terraform init -migrate-state`, and commit.
  #
  # backend "azurerm" {
  #   resource_group_name  = "cometloop-tfstate-rg"
  #   storage_account_name = "cometlooptfstate"
  #   container_name       = "tfstate"
  #   key                  = "azure.prod.tfstate"
  #   use_azuread_auth     = true
  # }
}

provider "azurerm" {
  # Subscription and tenant come from `az login` / `az account set`, or from
  # ARM_SUBSCRIPTION_ID / ARM_TENANT_ID. Nothing is hardcoded here so the
  # same config applies to whichever subscription is created.
  features {
    key_vault {
      # A destroyed vault would otherwise linger soft-deleted and block a
      # re-create under the same name for 90 days.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}

provider "azuread" {}

provider "azapi" {}
