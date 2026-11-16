locals {
  amis = {
    ubuntu = data.aws_ami.ubuntu_2404.id
    debian = data.aws_ami.debian_13.id
    rocky  = data.aws_ami.rocky_9.id
    fedora = data.aws_ami.fedora_44.id
    redhat = data.aws_ami.rhel_9.id
    arch   = data.aws_ami.arch.id
  }

  # AMIs that ship no SSM agent get a bootstrap that installs only it (docs/adr/0008). Ubuntu's ships
  # one, so it has no entry. Each distro is a URL and the installer for its package format.
  ssm_agent_url = "https://amazon-ssm-us-east-1.s3.us-east-1.amazonaws.com/latest"

  # Arch has neither dpkg nor rpm: the agent's rpm is unpacked with bsdtar, which ships in its base image.
  arch_ssm_agent_script = base64encode(templatefile("${path.module}/templates/ssm-agent.sh.tpl", {
    url     = "${local.ssm_agent_url}/linux_amd64/amazon-ssm-agent.rpm"
    pkg     = "/tmp/amazon-ssm-agent.rpm"
    install = "bsdtar -C / -xf"
  }))

  bootstraps = {
    debian = templatefile("${path.module}/templates/ssm-agent.sh.tpl", {
      url     = "${local.ssm_agent_url}/debian_amd64/amazon-ssm-agent.deb"
      pkg     = "/tmp/amazon-ssm-agent.deb"
      install = "dpkg -i"
    })
    rocky = templatefile("${path.module}/templates/ssm-agent.sh.tpl", {
      url     = "${local.ssm_agent_url}/linux_amd64/amazon-ssm-agent.rpm"
      pkg     = "/tmp/amazon-ssm-agent.rpm"
      install = "rpm -i"
    })
    fedora = templatefile("${path.module}/templates/ssm-agent.sh.tpl", {
      url     = "${local.ssm_agent_url}/linux_amd64/amazon-ssm-agent.rpm"
      pkg     = "/tmp/amazon-ssm-agent.rpm"
      install = "rpm -i"
    })
    redhat = templatefile("${path.module}/templates/ssm-agent.sh.tpl", {
      url     = "${local.ssm_agent_url}/linux_amd64/amazon-ssm-agent.rpm"
      pkg     = "/tmp/amazon-ssm-agent.rpm"
      install = "rpm -i"
    })
    # Arch's image holds cloud-init's final stage (where user_data runs) and sshd until the clock is
    # synced, and its timesyncd asks the public NTP pool, which times out here: the security group allows
    # no UDP 123. So timesyncd is pointed at AWS's link-local time source, which a security group does
    # not filter, from bootcmd (init stage, ahead of that wait). It is written there and not with
    # write_files because bootcmd runs before write_files.
    arch = <<-EOT
      #cloud-config
      write_files:
        - path: /var/lib/doc-testing-tool/ssm-agent.sh
          permissions: "0755"
          encoding: b64
          content: ${local.arch_ssm_agent_script}
      bootcmd:
        - mkdir -p /etc/systemd/timesyncd.conf.d
        - printf '[Time]\nNTP=169.254.169.123\n' > /etc/systemd/timesyncd.conf.d/99-aws.conf
        - systemctl restart systemd-timesyncd
      runcmd:
        - /var/lib/doc-testing-tool/ssm-agent.sh
    EOT
  }
}

resource "aws_instance" "ec2" {
  ami                    = local.amis[var.os]
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.ec2.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name

  # IMDSv2 only.
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_size = 20
    encrypted   = true
  }

  # Installs TimescaleDB the way src/partials/_install-self-hosted-ubuntu.mdx does, so the
  # pre-installed target is ready on boot. It is NOT a verbatim run of the guide: it adds -y/--yes,
  # runs as root, and sets the password with ALTER ROLE instead of the guide's interactive steps
  # (see infra/templates/user-data.sh.tpl). Testing the guide itself is what `bare` is for: no
  # user_data at all, so an install-guide run (docs/adr/0007) is what installs the database.
  #
  # A bare box gets at most the SSM agent, for an AMI that does not ship one (local.bootstraps).
  user_data = var.bare ? lookup(local.bootstraps, var.os, null) : templatefile("${path.module}/templates/user-data.sh.tpl", {
    db_password = random_password.db.result
  })

  lifecycle {
    # The pre-installed box is built by the Ubuntu cloud-init script; another distro only exists as a
    # bare target, where an install-guide run is what installs the database (docs/adr/0008).
    precondition {
      condition     = var.bare || var.os == "ubuntu"
      error_message = "A pre-installed target is Ubuntu only; set bare = true to use another os."
    }
  }

  tags = {
    # Load-bearing, not stylistic: doc-testing-tool-terraform-policy's ssm:StartSession/SendCommand
    # grant (docs/adr/0003) is conditioned on this exact tag value.
    Name = "doc-testing-tool-ec2"
  }
}
