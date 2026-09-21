# ==============================================================================
# GITHUB ACTIONS OIDC IDENTITY PROVIDER & DEPLOY ROLE
#
# Allows GitHub Actions workflows on the `main` branch of `var.github_repo` to
# securely assume this deployment role without any long-lived IAM access keys.
# ==============================================================================

# 1. GitHub OIDC Provider (data source if already exists, else resource)
# Check if GitHub OIDC provider exists in AWS account
data "aws_iam_openid_connect_provider" "github" {
  count = 1
  url   = "https://token.actions.githubusercontent.com"
}

# If it didn't exist, this resource would be used, but since data source or resource can be handled cleanly:
# We create it with try/condition or directly create if not present.
# Standard pattern:
resource "aws_iam_openid_connect_provider" "github" {
  count           = length(data.aws_iam_openid_connect_provider.github.arn) > 0 ? 0 : 1
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c5878692eee48e54099652dd322abb91f4d677b"
  ]
}

locals {
  github_oidc_arn = length(data.aws_iam_openid_connect_provider.github.arn) > 0 ? data.aws_iam_openid_connect_provider.github.arn : aws_iam_openid_connect_provider.github[0].arn
}

# 2. IAM Role Scoped STRICTLY to the Repository's Main Branch
resource "aws_iam_role" "github_deploy" {
  name = "${var.project_name}-github-deploy-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = local.github_oidc_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-github-deploy-role"
  }
}

# 3. Least-Privilege Scoped Policy for Deployment
resource "aws_iam_role_policy" "github_deploy_permissions" {
  name = "${var.project_name}-github-deploy-policy"
  role = aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ECR Authentication (requires * on GetAuthorizationToken)
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      # ECR Push to Backend Repository
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = aws_ecr_repository.backend.arn
      },
      # ECS Service Deployment
      {
        Sid    = "ECSUpdate"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices"
        ]
        Resource = aws_ecs_service.backend.id
      },
      # PassRole to ECS Task and Execution Roles
      {
        Sid    = "PassRoleToECS"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.ecs_execution.arn,
          aws_iam_role.ecs_task.arn
        ]
      },
      # S3 Frontend Static Sync
      {
        Sid    = "S3FrontendDeploy"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.frontend.arn,
          "${aws_s3_bucket.frontend.arn}/*"
        ]
      },
      # CloudFront Cache Invalidation
      {
        Sid      = "CloudFrontInvalidate"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = aws_cloudfront_distribution.frontend.arn
      }
    ]
  })
}
