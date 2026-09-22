# DNS for the console and the AI Gateway. The apex site (cometloop.ai, a
# Workers static-assets deployment) is intentionally not modelled here: this
# stack only ever touches records it created, so it cannot clobber the site.

# app.cometloop.ai -> Container Apps ingress. Proxied by default (see the
# variable); the Azure side then validates the managed certificate by TXT
# rather than CNAME, because a CNAME lookup resolves to Cloudflare's edge.
resource "cloudflare_dns_record" "app" {
  zone_id = var.zone_id
  name    = var.app_hostname
  type    = "CNAME"
  content = var.aca_fqdn
  proxied = var.proxied
  ttl     = 1 # 1 = automatic; also the only value allowed while proxied
  comment = "Cometloop console -> Azure Container Apps (infra/cloudflare)"
}

# Domain-ownership proof for Container Apps: `asuid.<host>` TXT with the
# environment's verification id. Required both to add the hostname and to
# validate/renew the managed certificate, so it stays for the life of the
# binding. Cloudflare stores TXT content quoted; quoting it here keeps the
# plan clean instead of showing a perpetual diff.
resource "cloudflare_dns_record" "asuid" {
  zone_id = var.zone_id
  name    = "asuid.${var.app_hostname}"
  type    = "TXT"
  content = "\"${var.custom_domain_verification_id}\""
  ttl     = 1
  comment = "Azure Container Apps domain verification for ${var.app_hostname} (infra/cloudflare)"
}

# AI Gateway `cometloop`: the api sends model calls through
# https://gateway.ai.cloudflare.com/v1/<account>/cometloop/<provider> and gets
# per-request logs, caching and rate limiting without any code in the app
# (docs/platform-architecture.md section 6). Provider keys are still
# supplied by the caller on each request; the gateway holds none.
resource "cloudflare_ai_gateway" "cometloop" {
  account_id = var.account_id
  id         = var.ai_gateway_id

  collect_logs               = var.ai_gateway_collect_logs
  cache_ttl                  = var.ai_gateway_cache_ttl
  cache_invalidate_on_update = true

  # 0/0 = no gateway-side rate limit; provider limits and the app's own
  # per-tenant budgets apply. Raise once there is a number to defend.
  rate_limiting_interval = 0
  rate_limiting_limit    = 0
}
