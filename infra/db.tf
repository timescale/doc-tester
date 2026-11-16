# The box is throwaway, so there's nothing for a human to invent or remember (see docs/adr/0003 /
# the plan's DB-password decision): generated fresh per apply, stored only in SSM Parameter Store,
# fed straight into cloud-init. Never written to .env or 1Password.
resource "random_password" "db" {
  length  = 32
  special = false # keeps interpolation into the bash heredoc in user-data.sh.tpl simple to reason about
}

resource "aws_ssm_parameter" "db_password" {
  name        = "/doc-testing-tool/ec2/db-password"
  description = "postgres superuser password for the self-hosted TimescaleDB target, generated per-apply."
  type        = "SecureString"
  value       = random_password.db.result
}
