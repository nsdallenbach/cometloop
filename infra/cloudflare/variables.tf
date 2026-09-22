variable "api_token" {
  description = <<-EOT
    Cloudflare API token with Zone:DNS:Edit on cometloop.ai and
    Account:AI Gateway:Edit. Leave unset and export CLOUDFLARE_API_TOKEN
    instead; never put it in a tfvars file that is committed.
  EOT
  type        = string
  sensitive   = true
  default     = null
}

variable "account_id" {
  description = "Cloudflare account that owns the zone and the AI Gateway."
  type        = string
  default     = "f5cc5adfdff1116476646bbe72b49d80"
}

variable "zone_id" {
  description = "Zone id of cometloop.ai (dashboard > Overview > API section, or `wrangler`/the API)."
  type        = string
}

variable "zone_name" {
  type    = string
  default = "cometloop.ai"
}

variable "app_hostname" {
  description = "Console hostname. The v5 provider wants the full name, not the relative label."
  type        = string
  default     = "app.cometloop.ai"
}

variable "aca_fqdn" {
  description = "Container Apps ingress hostname: `terraform output -raw api_fqdn` in infra/azure."
  type        = string
}

variable "custom_domain_verification_id" {
  description = "`terraform output -raw custom_domain_verification_id` in infra/azure; goes in the asuid TXT record."
  type        = string
}

variable "proxied" {
  description = <<-EOT
    Orange-cloud the app CNAME so Cloudflare terminates TLS, applies WAF and
    hides the Azure hostname (docs/platform-architecture.md: Full (strict)
    to the ACA managed certificate). Set false to go DNS-only, e.g. to rule
    Cloudflare out while debugging.
  EOT
  type        = bool
  default     = true
}

variable "ai_gateway_id" {
  description = "AI Gateway name; the path segment in AI_GATEWAY_URL (infra/azure var ai_gateway_url)."
  type        = string
  default     = "cometloop"
}

variable "ai_gateway_collect_logs" {
  description = "Keep per-request logs in the gateway (prompt/response bodies included); the per-tenant usage view depends on them."
  type        = bool
  default     = true
}

variable "ai_gateway_cache_ttl" {
  description = "Seconds to cache identical requests at the gateway. 0 disables caching, which is right for an agent console where identical prompts should still get fresh completions."
  type        = number
  default     = 0
}
