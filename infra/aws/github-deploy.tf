# Deploy identity for GitHub Actions. The project's managed service control
# policy denies every IAM *Provider* action, so GitHub's OIDC federation
# (the passwordless pattern the Azure stack uses) is not available here.
# The fallback is an IAM user with one access key, scoped to exactly what
# the workflow does: push to this environment's repository and redeploy
# this environment's service. Terraform creates the user and its policy;
# the key is minted by a human and lands only in the GitHub Environment
# (README step 3), never in state:
#
#   aws iam create-access-key --user-name cometloop-<env>-github-deploy --profile cometloop
#
# Rotate by creating a second key, updating the GitHub secrets, and
# deleting the first.

resource "aws_iam_user" "github_deploy" {
  name = local.names.deploy_user
  path = "/ci/"
}

data "aws_iam_policy_document" "github_deploy" {
  # Push images to this environment's repository.
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.main.arn]
  }
  # Redeploy and watch this environment's service.
  statement {
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
      "ecs:DescribeExpressGatewayService",
    ]
    resources = [
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:service/${local.names.cluster}/${local.names.service}",
    ]
  }
  statement {
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks", "ecs:DescribeClusters"]
    resources = ["*"]
  }
  statement {
    actions   = ["elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeListeners"]
    resources = ["*"]
  }
}

resource "aws_iam_user_policy" "github_deploy" {
  name   = "deploy"
  user   = aws_iam_user.github_deploy.name
  policy = data.aws_iam_policy_document.github_deploy.json
}
