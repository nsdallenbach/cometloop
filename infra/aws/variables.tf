variable "region" {
  description = "AWS Region. The new-experience project has one Region (us-east-2); it is also the Neon project's."
  type        = string
  default     = "us-east-2"
}

variable "aws_profile" {
  description = "AWS CLI profile Terraform signs in with (`aws login --profile cometloop`). Null uses the default chain."
  type        = string
  default     = "cometloop"
}

variable "name_prefix" {
  description = "Prefix for every resource name (see locals.tf)."
  type        = string
  default     = "cometloop"
}

variable "environment" {
  description = "Deployment environment; part of every resource name. `staging` or `prod`."
  type        = string
  default     = "staging"
}

variable "image_tag" {
  description = <<-EOT
    Image tag the service runs. The deploy workflow pushes every build as
    <sha> and re-tags it as this value, then forces a new ECS deployment so
    the tasks pull it. Per environment by convention: `staging`, `production`.
  EOT
  type        = string
  default     = "staging"
}

variable "bootstrap_placeholder_image" {
  description = <<-EOT
    true (the default) creates the service on a public placeholder image,
    because the private repository is empty on the first apply — the deploy
    workflow pushes the first real image — and ECS cannot start tasks from
    an image that does not exist. After the first deploy has pushed the
    `image_tag`, apply again with false; ECS rolls the service onto it.
  EOT
  type        = bool
  default     = true
}

variable "placeholder_image" {
  description = "Public image for bootstrap. Must listen on `port` and answer 200 on `/`; AWS's hello image does both on 8000."
  type        = string
  default     = "public.ecr.aws/aws-containers/hello-app-runner:latest"
}

variable "port" {
  description = "Port the api container listens on (PORT env and the load balancer's target port)."
  type        = number
  default     = 8000
}

variable "cpu" {
  description = "Fargate task CPU units: 256, 512, 1024, 2048 or 4096."
  type        = string
  default     = "256"
}

variable "memory" {
  description = "Fargate task memory in MiB; 512 or 1024 with 256 CPU, 1024–4096 with 512, and so on."
  type        = string
  default     = "512"
}

variable "min_tasks" {
  description = "Tasks always running. Fargate bills per running task; the Application Load Balancer is the fixed cost."
  type        = number
  default     = 1
}

variable "max_tasks" {
  type    = number
  default = 2
}

variable "neon_auth_base_url" {
  description = <<-EOT
    Neon Auth (managed Better Auth) base URL of the Neon branch this
    environment runs on — the console serves it to the browser from
    `GET /api/auth/config` and signs users in against it. Per branch: the
    `staging` branch's URL for staging, `production`'s for prod (Neon
    console → Branches → <branch> → Auth, or `neon neon-auth status`). Not a
    secret; the matching JWKS URL is the SSM parameter `neon-auth-jwks-url`.
  EOT
  type        = string
  default     = ""
}

variable "ai_gateway_url" {
  description = "Cloudflare AI Gateway base for model calls (infra/cloudflare). Not a secret."
  type        = string
  default     = "https://gateway.ai.cloudflare.com/v1/f5cc5adfdff1116476646bbe72b49d80/cometloop/anthropic"
}

variable "custom_domain" {
  description = <<-EOT
    Hostname for the service, or empty for the load balancer's default
    name only. Terraform requests the ACM certificate (DNS validation —
    create the records it outputs in Cloudflare); attaching it to the
    Express-managed HTTPS listener is `attach-domain.sh` after the apply.
  EOT
  type        = string
  default     = "staging.cometloop.ai"
}

variable "tags" {
  type = map(string)
  default = {
    product   = "cometloop"
    managedBy = "terraform"
  }
}
