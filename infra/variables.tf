variable "aws_region" {
  description = "Primary AWS region for deployment (e.g. us-east-1, ap-south-1)"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name prefix used for resource naming"
  type        = string
  default     = "wealth-navigator"
}

variable "domain_name" {
  description = "Primary domain name (e.g. example.com)"
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID if using Route 53 (leave empty if managed elsewhere)"
  type        = string
  default     = ""
}

variable "db_password" {
  description = "Master database password for RDS PostgreSQL"
  type        = string
  sensitive   = true
}

variable "gemini_api_key" {
  description = "Google Gemini API key stored securely in AWS Secrets Manager"
  type        = string
  sensitive   = true
}

variable "github_repo" {
  description = "GitHub repository formatted as 'owner/repo' for OIDC trust scoping"
  type        = string
}

variable "alert_email" {
  description = "Email address to receive monthly AWS budget tripwire alerts"
  type        = string
}
