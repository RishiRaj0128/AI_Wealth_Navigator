# ==============================================================================
# ACM CERTIFICATES
# ==============================================================================

# 1. Primary Region Certificate (for ALB: api.<domain_name>)
resource "aws_acm_certificate" "alb" {
  domain_name       = "api.${var.domain_name}"
  validation_method = "DNS"

  tags = {
    Name = "${var.project_name}-alb-cert"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# 2. us-east-1 Region Certificate (for CloudFront: <domain_name> and www.<domain_name>)
# Note: CloudFront distributions require certificates in us-east-1 regardless of primary region.
resource "aws_acm_certificate" "cloudfront" {
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  tags = {
    Name = "${var.project_name}-cloudfront-cert"
  }

  lifecycle {
    create_before_destroy = true
  }
}
