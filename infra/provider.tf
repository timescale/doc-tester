provider "aws" {
  region = "us-east-1"
  # No profile here either: AWS_PROFILE from the environment, or the machine's own credential chain
  # (see infra/env.sh).
}
