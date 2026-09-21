# ==============================================================================
# TERRAFORM OUTPUTS
# ==============================================================================

# --- GitHub Actions Secrets & Variables ---

output "oidc_role_arn" {
  description = "Value for GitHub Secret: AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.github_deploy.arn
}

output "ecr_repository_url" {
  description = "Value for GitHub Variable: ECR_REPOSITORY"
  value       = aws_ecr_repository.backend.repository_url
}

output "ecs_cluster_name" {
  description = "Value for GitHub Variable: ECS_CLUSTER"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Value for GitHub Variable: ECS_SERVICE"
  value       = aws_ecs_service.backend.name
}

output "s3_bucket_name" {
  description = "Value for GitHub Variable: S3_BUCKET_NAME"
  value       = aws_s3_bucket.frontend.id
}

output "cloudfront_distribution_id" {
  description = "Value for GitHub Variable: CLOUDFRONT_DISTRIBUTION_ID"
  value       = aws_cloudfront_distribution.frontend.id
}

output "aws_region" {
  description = "Value for GitHub Variable: AWS_REGION"
  value       = var.aws_region
}

# --- Network & Endpoint Details ---

output "alb_dns_name" {
  description = "Public Application Load Balancer DNS Name (target for api.<domain> CNAME if not using Route 53)"
  value       = aws_lb.main.dns_name
}

output "cloudfront_domain_name" {
  description = "CloudFront Distribution Domain Name (target for root / www CNAME if not using Route 53)"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "rds_endpoint" {
  description = "Internal RDS PostgreSQL Endpoint"
  value       = aws_db_instance.postgres.endpoint
}

# --- DNS Validation Records (Required to activate ACM Certificates) ---

output "acm_validation_alb" {
  description = "DNS CNAME validation records for the ALB certificate (api.<domain>)"
  value = [
    for dvo in aws_acm_certificate.alb.domain_validation_options : {
      domain_name = dvo.domain_name
      record_name = dvo.resource_record_name
      record_type = dvo.resource_record_type
      record_value = dvo.resource_record_value
    }
  ]
}

output "acm_validation_cloudfront" {
  description = "DNS CNAME validation records for the CloudFront certificate (<domain> & www.<domain>)"
  value = [
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : {
      domain_name = dvo.domain_name
      record_name = dvo.resource_record_name
      record_type = dvo.resource_record_type
      record_value = dvo.resource_record_value
    }
  ]
}
