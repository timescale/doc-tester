# SSM Session Manager port-forwarding only for the EC2 target

The EC2 target needs to be reachable for Postgres and shell access from a laptop whose IP changes constantly, and the docs procedures run against it are sometimes mutating — a static IP allowlist is awkward and doesn't hold up.

We use zero public inbound security group rules. Reachability goes exclusively through the SSM tunnel, via an IAM role with `AmazonSSMManagedInstanceCore` attached to the instance. This removes the changing-IP problem entirely — SSM authenticates via IAM, not source IP — without ever opening 22/5432 to the internet.

**Considered and rejected**: opening 5432/22 to `0.0.0.0/0` and tightening later. Rejected because the instance would be internet-reachable in the meantime, for a database that mutating docs procedures run against.
