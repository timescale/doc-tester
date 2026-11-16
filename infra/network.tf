data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  # us-east-1e in this account doesn't support the current-gen t3 family: t3.small fails there
  # with "Unsupported ... Availability Zone", so this is pinned to us-east-1a.
  filter {
    name   = "availability-zone"
    values = ["us-east-1a"]
  }
}

data "aws_ami" "ubuntu_2404" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Debian 13 (trixie), the current stable. The page names no Debian version; packagecloud serves
# timescaledb for trixie and bookworm alike. `debian-13-amd64-2*` skips the `-daily-` images.
data "aws_ami" "debian_13" {
  most_recent = true
  owners      = ["136693071363"] # Debian

  filter {
    name   = "name"
    values = ["debian-13-amd64-2*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Rocky Linux 9. The Rocky guide hardcodes EL 9 (the pgdg and timescale repo URLs) and says "Rocky
# Linux 9 only" for the module step, so this is 9 and not 10, which also exists. `Base` skips the LVM
# images. Owner is the Rocky Linux Foundation.
data "aws_ami" "rocky_9" {
  most_recent = true
  owners      = ["792107900819"]

  filter {
    name   = "name"
    values = ["Rocky-9-EC2-Base-9.*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Fedora 44, the current stable. The Fedora guide builds its pgdg repo URL from `rpm -E %{fedora}`, so
# it names no release; pgdg publishes a repo RPM for 43 and 44 (42 is a 404), so this is the newest.
# The name pattern skips Rawhide, ELN and prerelease images. Owner is the Fedora Project.
data "aws_ami" "fedora_44" {
  most_recent = true
  owners      = ["125523088429"]

  filter {
    name   = "name"
    values = ["Fedora-Cloud-Base-AmazonEC2.x86_64-44-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Red Hat Enterprise Linux 9. The Red Hat guide builds its repo URLs from `rpm -E %{rhel}` and names no
# release; this is 9 to match Rocky 9 (EL 10 is served too). `Hourly2` is the pay-as-you-go image, whose
# repos come through RHUI with no subscription to register. The minor is pinned because `most_recent`
# across `RHEL-9*` flips between minors (a 9.6 respin is newer than the latest 9.8): bump it on a new
# minor. Owner is Red Hat.
data "aws_ami" "rhel_9" {
  most_recent = true
  owners      = ["309956199498"]

  filter {
    name   = "name"
    values = ["RHEL-9.8.0_HVM-*-x86_64-*-Hourly2-GP3"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Arch Linux. Arch publishes no AMI, only a signed cloud image, so this is one the account owns: built
# once (and again to refresh) by infra/arch-ami/build.sh, which imports the official image and names the
# AMI doc-testing-tool-arch-<image version>. The newest wins, so a refresh is just running that again.
# Arch is rolling, so a run is a snapshot of whatever `pacman -Syu` served that day.
data "aws_ami" "arch" {
  most_recent = true
  owners      = ["self"]

  filter {
    name   = "name"
    values = ["doc-testing-tool-arch-*"]
  }
}
