variable "location" {
  description = "Azure region for everything in this stack."
  type        = string
  default     = "eastus2"
}

variable "name_prefix" {
  description = "Prefix for every resource name (see locals.tf for the naming scheme)."
  type        = string
  default     = "cometloop"
}

variable "environment" {
  description = "Deployment environment; part of every resource name."
  type        = string
  default     = "prod"
}

variable "image_repository" {
  description = "Repository name inside the registry that the deploy workflow pushes to."
  type        = string
  default     = "cometloop"
}

variable "image_tag" {
  description = <<-EOT
    Image tag used when the container apps are *created* and
    bootstrap_placeholder_image is false. After creation the deploy workflow
    owns the image (see the lifecycle block in container-apps.tf), so changing
    this later is a no-op.
  EOT
  type        = string
  default     = "latest"
}

variable "bootstrap_placeholder_image" {
  description = <<-EOT
    true (the default) creates the apps with a public placeholder image
    instead of one from the registry. The registry is empty on the first apply
    - the deploy workflow is what pushes the first image - and Container Apps
    refuses to provision a revision whose image cannot be pulled, so the
    first apply would fail without this. Set to false only when re-creating
    the apps after an image with `image_tag` already exists in the registry.
  EOT
  type        = bool
  default     = true
}

variable "placeholder_image" {
  description = <<-EOT
    Placeholder used during bootstrap. Must listen on the PORT environment
    variable (Container Apps fails a revision whose container does not accept
    connections on the ingress target port) and must not expose its
    environment - the placeholder receives the Key Vault-backed env vars.
    Google's Cloud Run hello image honours PORT by contract and only prints a
    greeting.
  EOT
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello:latest"
}

variable "port" {
  description = "Port the api container listens on (passed as PORT and used as the ingress target port)."
  type        = number
  default     = 8000
}

variable "api_cpu" {
  description = "vCPU per api replica. Container Apps consumption allows 0.25 steps up to 4."
  type        = number
  default     = 0.5
}

variable "api_memory" {
  description = "Memory per api replica; must be 2x the vCPU value in Gi on consumption."
  type        = string
  default     = "1Gi"
}

variable "worker_cpu" {
  type    = number
  default = 0.25
}

variable "worker_memory" {
  type    = string
  default = "0.5Gi"
}

variable "api_min_replicas" {
  type    = number
  default = 1
}

variable "api_max_replicas" {
  type    = number
  default = 3
}

variable "api_concurrent_requests" {
  description = "HTTP scale rule: add a replica when the per-replica concurrent request count passes this."
  type        = number
  default     = 50
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "ai_gateway_url" {
  description = <<-EOT
    Base URL the api uses for model calls, pointing at the Cloudflare AI
    Gateway created by infra/cloudflare (gateway id `cometloop`, Anthropic
    provider slot). Not a secret: the gateway is unauthenticated and the
    Anthropic key still travels with every request.
  EOT
  type        = string
  default     = "https://gateway.ai.cloudflare.com/v1/f5cc5adfdff1116476646bbe72b49d80/cometloop/anthropic"
}

variable "custom_domain" {
  description = "Hostname bound to the api's ingress."
  type        = string
  default     = "app.cometloop.ai"
}

variable "custom_domain_enabled" {
  description = <<-EOT
    Adds the custom domain, requests the managed certificate and binds it.
    Leave false on the first apply: the domain add fails until the
    `asuid.app` TXT record from infra/cloudflare exists, and that record needs
    this stack's `custom_domain_verification_id` output. See custom-domain.tf.
  EOT
  type        = bool
  default     = false
}

variable "certificate_validation_method" {
  description = <<-EOT
    How Azure proves control of the custom domain when issuing the managed
    certificate: CNAME, HTTP or TXT. TXT (the asuid record) is the default
    because the CNAME check looks for the Container Apps FQDN behind the name,
    and with the Cloudflare record proxied it sees Cloudflare's edge instead.
  EOT
  type        = string
  default     = "TXT"

  validation {
    condition     = contains(["CNAME", "HTTP", "TXT"], var.certificate_validation_method)
    error_message = "certificate_validation_method must be CNAME, HTTP or TXT."
  }
}

variable "github_repository" {
  description = "owner/name of the GitHub repository whose Actions deploy through OIDC."
  type        = string
  default     = "nsdallenbach/cometloop"
}

variable "github_deploy_branch" {
  description = "Branch whose workflow runs may assume the deploy identity."
  type        = string
  default     = "main"
}

variable "tags" {
  type = map(string)
  default = {
    product   = "cometloop"
    managedBy = "terraform"
  }
}

variable "neon_auth_base_url" {
  description = <<-EOT
    Neon Auth (managed Better Auth) base URL of the Neon branch this
    environment runs on — the console serves it to the browser from
    `GET /api/auth/config` and signs users in against it. Per branch: the
    `production` branch's URL for prod, the `staging` branch's for staging
    (`neon neon-auth status`, or the Neon console → Auth). The matching
    JWKS URL goes into Key Vault as `neon-auth-jwks-url`.
  EOT
  type        = string
  default     = ""
}
