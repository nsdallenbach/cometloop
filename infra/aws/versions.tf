terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # aws_ecs_express_gateway_service landed in the 6.x line.
      version = ">= 6.20"
    }
  }

  # State is local until a second person applies. To move it to S3, create
  # the bucket once (versioning on, SSE-S3), then uncomment, run
  # `terraform init -migrate-state`, and commit. One key per environment.
  #
  # backend "s3" {
  #   bucket       = "cometloop-tfstate"
  #   key          = "aws.staging.tfstate"
  #   region       = "us-east-2"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = local.tags
  }
}
