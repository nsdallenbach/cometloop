output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "region" {
  value = var.region
}

output "ecr_repository_url" {
  description = "Where the deploy workflow pushes; the service runs `<this>:<image_tag>`."
  value       = aws_ecr_repository.main.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_express_gateway_service.api.service_name
}

output "service_arn" {
  value = aws_ecs_express_gateway_service.api.service_arn
}

output "service_endpoints" {
  description = "The Express Mode ingress endpoints (the managed load balancer's hostname); answer before the custom domain is attached."
  value       = aws_ecs_express_gateway_service.api.ingress_paths
}

output "deploy_user_name" {
  description = "Mint its access key by hand: aws iam create-access-key --user-name <this>"
  value       = aws_iam_user.github_deploy.name
}

output "ssm_parameter_names" {
  description = "Set each with `aws ssm put-parameter --name <n> --type SecureString --overwrite --value ...`."
  value       = { for k, p in aws_ssm_parameter.app : k => p.name }
}

output "certificate_arn" {
  value = var.custom_domain == "" ? null : aws_acm_certificate.api[0].arn
}

output "custom_domain_dns_records" {
  description = <<-EOT
    DNS records to create in Cloudflare: ACM's validation CNAME (DNS-only,
    grey cloud) and, once `attach-domain.sh` has run, the hostname's CNAME
    to the service endpoint (may be proxied; set the zone's SSL mode to
    Full (strict) — the certificate on the load balancer is publicly trusted).
  EOT
  value = var.custom_domain == "" ? [] : concat(
    [for o in aws_acm_certificate.api[0].domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value, purpose = "ACM validation" }],
    [for p in aws_ecs_express_gateway_service.api.ingress_paths : { name = var.custom_domain, type = "CNAME", value = replace(p.endpoint, "/^https?:\\/\\//", ""), purpose = "the hostname" }],
  )
}

output "custom_domain" {
  value = var.custom_domain
}
