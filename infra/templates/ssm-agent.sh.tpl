#!/bin/sh
# Harness, not part of any install guide (docs/adr/0002, docs/adr/0008). Some distro AMIs ship no SSM
# agent (Debian 13, Rocky 9, Fedora 44, RHEL 9 and Arch do not), and SSM is the only way into the box, so a bare target on one
# of them needs exactly this and nothing else. python3 is already there (cloud-init needs it), so the
# agent's package is fetched with it and installed with the distro's own low-level tool (dpkg or rpm; Arch has neither, so it unpacks the rpm with
# bsdtar, which ships in its base image):
# no apt, dnf, curl or wget, which would change what a guide's own install step sees on a fresh
# machine. Filled in per distro by `locals.bootstraps` in ec2.tf.
set -eu
python3 - <<'PY'
import time, urllib.request
for attempt in range(5):
    try:
        urllib.request.urlretrieve("${url}", "${pkg}")
        break
    except Exception:
        if attempt == 4:
            raise
        time.sleep(10)
PY
${install} ${pkg}
# dpkg and rpm copy the agent's config templates into place when they install it; a bare unpack does not.
# `cp -n` makes this a no-op wherever the package manager already did.
for t in /etc/amazon/ssm/*.template; do [ -e "$t" ] && cp -n "$t" "$(echo "$t" | sed 's/\.template$//')"; done
systemctl enable --now amazon-ssm-agent
