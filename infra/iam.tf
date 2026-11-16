# Named doc-testing-tool-* — load-bearing, not stylistic: docs-tester's own policy
# (doc-testing-tool-terraform-policy, see docs/adr/0003) only grants iam:CreateRole/PassRole/etc. on
# that exact prefix.
resource "aws_iam_role" "ec2" {
  name = "doc-testing-tool-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# This is the whole network-access story (docs/adr/0002): the instance can open an SSM session
# outbound to the SSM service, so nothing needs to be open inbound.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2" {
  name = "doc-testing-tool-ec2-profile"
  role = aws_iam_role.ec2.name
}
