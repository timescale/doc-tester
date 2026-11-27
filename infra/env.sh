# Sourced by init.sh, up.sh, down.sh and tunnel.sh: loads ../.env the way the tool does, then applies
# the one rule for which AWS identity runs this (EDU-1069), the same as lib/aws-env.mjs.
#
# A variable already in the environment wins over the file, as with Node's loadEnvFile in
# lib/services.mjs, so a shell or a CI job that exports DOCTEST_AWS_PROFILE gets the same identity in
# the tool's own calls and in terraform. The reader takes a line as `NAME=value` or `export NAME=value`,
# trims the value, strips one pair of single or double quotes, drops a ` # comment` tail from an
# unquoted value and a trailing CR, and expands nothing: no `$VAR`, no backticks, no `$(...)`, which
# `source` used to run. (loadEnvFile also joins multi-line quoted values and expands `\n` inside
# double quotes; none of the values these scripts read has either.)
#
# DOCTEST_AWS_PROFILE names the profile, default docs-tester; set to the empty string, no profile is
# used and the machine's own credential chain applies (an instance role, a CI OIDC role; on a laptop
# that chain includes a `default` profile in ~/.aws, so check `aws sts get-caller-identity` before
# relying on it). Terraform's backend and provider read AWS_PROFILE from here and name none of their own.
ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in export\ *) line="${line#export }"; line="${line#"${line%%[![:space:]]*}"}" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    name="${line%%=*}"
    name="${name%"${name##*[![:space:]]}"}"
    case "$name" in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
    [ -z "${!name+set}" ] || continue
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    case "$value" in
      \"*\"*) value="${value#\"}"; value="${value%%\"*}" ;;
      \'*\'*) value="${value#\'}"; value="${value%%\'*}" ;;
      *) value="${value%% \#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
    esac
    export "$name=$value"
  done < "$ENV_FILE"
fi

if [ -n "${DOCTEST_AWS_PROFILE-docs-tester}" ]; then
  export AWS_PROFILE="${DOCTEST_AWS_PROFILE-docs-tester}"
else
  unset AWS_PROFILE AWS_DEFAULT_PROFILE # the aws CLI honours both; neither may redirect a run that asked for none
fi
