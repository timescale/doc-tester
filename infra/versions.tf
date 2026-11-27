terraform {
  # >= 1.17: this state is shared and Terraform will not read state written by a NEWER version, so once
  # anyone applies with 1.17 everyone on 1.16 is locked out. The team moved to 1.17 together; this turns the
  # state-version error into a clear one at `init`.
  required_version = ">= 1.17"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state in S3. Bucket is versioned + SSE-encrypted with public access blocked. The very
  # first bucket was created out-of-band via an admin AWS identity (chronology, not a permanent
  # restriction) — docs-tester's own policy (docs/adr/0003) can create/delete it going forward.
  #
  # The bucket is not named here: its name contains the AWS account number. infra/up.sh passes it to
  # `terraform init` from DOCTEST_TFSTATE_BUCKET in .env (-backend-config).
  backend "s3" {
    key          = "doc-testing-tool/ec2/terraform.tfstate"
    region       = "us-east-1"
    # No profile here: the backend reads AWS_PROFILE from the environment infra/env.sh sets,
    # so DOCTEST_AWS_PROFILE decides the identity everywhere, and a box with an instance role needs none.
    encrypt      = true
    use_lockfile = true
  }
}
