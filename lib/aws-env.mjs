// The one setting that decides which AWS identity the tool runs as (EDU-1069).
//
// DOCTEST_AWS_PROFILE names the local AWS CLI profile. Unset, it is `docs-tester` (docs/adr/0003), and
// the profile is passed explicitly to every `aws` and terraform call rather than inherited from an
// ambient AWS_PROFILE, which could silently point a run at the wrong account. Set to the empty string,
// no profile is used at all: the machine's own credential chain applies, which is how a box with an
// instance role, or a CI job with an OIDC role, authenticates. The infra/ scripts apply the same rule
// (infra/env.sh), and the Terraform backend and provider name no profile of their own. The value is
// taken as written, like the scripts take it, so the two never resolve to different identities.
export function awsProfile() {
  const v = process.env.DOCTEST_AWS_PROFILE;
  return v === undefined ? "docs-tester" : v;
}

// The environment for an `aws` or terraform child: AWS_PROFILE set to the profile, or absent.
export function awsEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const profile = awsProfile();
  if (profile) env.AWS_PROFILE = profile;
  else { delete env.AWS_PROFILE; delete env.AWS_DEFAULT_PROFILE; } // the aws CLI honours both
  return env;
}
