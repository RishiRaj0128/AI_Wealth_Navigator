# ==============================================================================
# AWS BUDGET SAFETY-NET TRIPWIRE ($30/MONTH)
#
# Context: The AWS account holds a promotional credit balance. This budget alert
# serves as an early mistake-catcher and tripwire against runaway compute or
# forgotten resources, not a hard service quota.
# ==============================================================================

resource "aws_budgets_budget" "monthly_spend" {
  name              = "${var.project_name}-monthly-budget"
  budget_type       = "COST"
  limit_amount      = "30"
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = "2026-01-01_00:00"

  # Notification 1: Trigger when actual spend crosses 80% ($24.00)
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  # Notification 2: Trigger when forecasted spend crosses 100% ($30.00)
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
