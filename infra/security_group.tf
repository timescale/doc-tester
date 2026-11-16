# Zero ingress rules, on purpose (see docs/adr/0002). Reachability is exclusively through the SSM
# tunnel (infra/tunnel.sh) — there is no IP for anyone to allow-list, because there is no open port.
resource "aws_security_group" "ec2" {
  name        = "doc-testing-tool-ec2"
  description = "Self-hosted TimescaleDB target: no inbound at all, reachable only via SSM Session Manager."
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "HTTPS: SSM channel, apt/timescaledb package repos"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "HTTP: apt mirrors and redirect chains"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS (TCP) for large responses"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS (UDP)"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "doc-testing-tool-ec2"
  }
}
