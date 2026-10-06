# The console on Amazon ECS Express Mode (docs/platform-architecture.md
# section 7, AWS variant): ECS provisions and manages the Application Load
# Balancer, HTTPS listener, target group, security groups and autoscaling
# for one Fargate service from a single resource. The whole ECS feature set
# stays available underneath (`express-service-advanced-customization`),
# which is how the custom domain is attached. App Runner is not an option:
# AWS sunset it in April 2026 and the project's managed policy denies it.
#
# The worker is not deployed: it is still a stub (server/worker.ts). When
# phase 4 splits the loops out it becomes a second ECS service or a
# scheduled task on the same cluster.

# ---- image registry -----------------------------------------------------

resource "aws_ecr_repository" "main" {
  name                 = local.names.repository
  image_tag_mutability = "MUTABLE" # the deploy workflow moves the <environment> tag
  force_delete         = var.environment != "prod"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep the last ten images; every deploy pushes a <sha> tag.
resource "aws_ecr_lifecycle_policy" "main" {
  repository = aws_ecr_repository.main.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ---- secrets (SSM Parameter Store, SecureString) ------------------------
# Created with placeholder values that Terraform never overwrites: the real
# values are set by a human with `aws ssm put-parameter --overwrite`
# (README). ECS injects them at task start, so a changed value needs a new
# deployment (`aws ecs update-service --force-new-deployment`).

resource "aws_ssm_parameter" "app" {
  for_each = local.secrets

  name  = each.value
  type  = "SecureString"
  value = "PLACEHOLDER - set with aws ssm put-parameter --overwrite"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- logs and cluster ---------------------------------------------------

resource "aws_cloudwatch_log_group" "api" {
  name              = local.names.log_group
  retention_in_days = 30
}

resource "aws_ecs_cluster" "main" {
  name = local.names.cluster

  setting {
    name  = "containerInsights"
    value = "disabled" # the free tier's CloudWatch allowance is better spent on logs
  }
}

# ---- IAM: task execution (pull image, write logs, read secrets) --------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = local.names.exec_role
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = [for p in aws_ssm_parameter.app : p.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"] # the account's default SSM key; scope to its ARN if a CMK is introduced
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ---- IAM: Express Mode infrastructure (ALB, target group, SGs, scaling) --

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "infrastructure" {
  name               = local.names.infra_role
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "infrastructure_managed" {
  role       = aws_iam_role.infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
}

# ---- the service --------------------------------------------------------

resource "aws_ecs_express_gateway_service" "api" {
  service_name            = local.names.service
  cluster                 = aws_ecs_cluster.main.name
  execution_role_arn      = aws_iam_role.execution.arn
  infrastructure_role_arn = aws_iam_role.infrastructure.arn
  cpu                     = var.cpu
  memory                  = var.memory
  health_check_path       = local.health_check_path
  wait_for_steady_state   = true

  primary_container {
    image          = local.app_image
    container_port = var.port

    aws_logs_configuration {
      log_group         = aws_cloudwatch_log_group.api.name
      log_stream_prefix = "api"
    }

    environment {
      name  = "NODE_ENV"
      value = "production"
    }
    environment {
      name  = "PORT"
      value = tostring(var.port)
    }
    environment {
      name  = "AI_GATEWAY_URL"
      value = var.ai_gateway_url
    }
    environment {
      name  = "NEON_AUTH_BASE_URL"
      value = var.neon_auth_base_url
    }
    # Uploads live on the task's ephemeral disk until object storage lands
    # (platform-architecture phase 5) — fine for staging.
    environment {
      name  = "FILES_DIR"
      value = "/tmp/cometloop-files"
    }

    dynamic "secret" {
      for_each = local.secrets
      content {
        name       = secret.key
        value_from = aws_ssm_parameter.app[secret.key].arn
      }
    }
  }

  scaling_target {
    min_task_count            = var.min_tasks
    max_task_count            = var.max_tasks
    auto_scaling_metric       = "AVERAGE_CPU"
    auto_scaling_target_value = 60
  }

  depends_on = [
    aws_iam_role_policy_attachment.execution_managed,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.infrastructure_managed,
  ]
}

# ---- custom domain certificate -----------------------------------------
# ACM issues it against DNS validation records (outputs.tf) that go into
# Cloudflare. Attaching it to the Express-managed HTTPS listener, and
# letting that listener's host rule accept the hostname, is
# `attach-domain.sh` — the listener is created by ECS, outside this state.

resource "aws_acm_certificate" "api" {
  count = var.custom_domain == "" ? 0 : 1

  domain_name       = var.custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}
