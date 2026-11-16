variable "aws_profile" {
  description = "Local AWS CLI profile to run as (see docs/adr/0003). Defaults to docs-tester so an ambient AWS_PROFILE can't silently redirect this."
  type        = string
  default     = "docs-tester"
}

variable "bare" {
  description = "Skip the cloud-init TimescaleDB install, so the box is only the OS: the bare target an install-guide run follows the docs' own steps on (CONTEXT.md). Set by lib/ec2.mjs's apply({ bare }) as TF_VAR_bare."
  type        = bool
  default     = false
}

variable "os" {
  description = "Distro of the bare target (docs/adr/0008). The pre-installed box is Ubuntu only. Set by lib/ec2.mjs's apply({ os }) as TF_VAR_os; each name needs an AMI in ec2.tf and a default user in lib/ec2.mjs."
  type        = string
  default     = "ubuntu"

  validation {
    condition     = contains(["ubuntu", "debian", "rocky", "fedora", "redhat", "arch"], var.os)
    error_message = "os must be one of: ubuntu, debian, rocky, fedora, redhat, arch (keep in step with OSES in lib/plan.mjs)."
  }
}

variable "instance_type" {
  description = "EC2 instance type for the self-hosted TimescaleDB target. t3.micro's 1GB RAM isn't enough headroom for timescaledb-tune to work with."
  type        = string
  default     = "t3.small"
}
