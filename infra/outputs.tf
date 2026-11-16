output "instance_id" {
  description = "Instance id infra/tunnel.sh targets for the SSM port-forward."
  value       = aws_instance.ec2.id
}
