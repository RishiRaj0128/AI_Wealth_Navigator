# ==============================================================================
# ROUTE 53 DNS ALIAS RECORDS (Optional)
#
# If var.route53_zone_id is provided, ALIAS records are automatically provisioned.
# If your domain is hosted at another registrar (e.g. GoDaddy, Namecheap, Cloudflare),
# leave route53_zone_id blank and configure CNAME records using the targets printed
# in Terraform outputs.
# ==============================================================================

# Root Domain -> CloudFront Distribution
resource "aws_route53_record" "root" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# WWW Subdomain -> CloudFront Distribution
resource "aws_route53_record" "www" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# API Subdomain -> Application Load Balancer
resource "aws_route53_record" "api" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
