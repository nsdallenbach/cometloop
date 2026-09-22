output "app_record" {
  value = {
    name    = cloudflare_dns_record.app.name
    content = cloudflare_dns_record.app.content
    proxied = cloudflare_dns_record.app.proxied
  }
}

output "asuid_record_name" {
  value = cloudflare_dns_record.asuid.name
}

output "ai_gateway_url" {
  description = "Base URL for the Anthropic provider slot; matches infra/azure var ai_gateway_url."
  value       = "https://gateway.ai.cloudflare.com/v1/${var.account_id}/${cloudflare_ai_gateway.cometloop.id}/anthropic"
}
