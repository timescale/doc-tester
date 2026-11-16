#!/bin/bash
# Mirrors src/partials/_install-self-hosted-ubuntu.mdx + its Debian-based start/end partials
# command-for-command, in the same order a human reader hits them — non-interactive flags
# substituted only where the docs use an interactive prompt. See docs/adr/0003 for why this stays
# close to the docs' own commands (PG 18, postgres superuser only, no invented role/database).
set -euo pipefail

# --- _install-self-hosted-debian-based-start.mdx ---
apt-get update
apt-get install -y gnupg postgresql-common apt-transport-https lsb-release wget
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y

# --- _install-self-hosted-ubuntu.mdx: add the TimescaleDB package + GPG key ---
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" > /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg

# --- _install-self-hosted-debian-based-end.mdx ---
apt-get update
apt-get install -y timescaledb-2-postgresql-18 postgresql-client-18
timescaledb-tune --quiet --yes
systemctl restart postgresql

# The docs' own next two steps are interactive (`sudo -u postgres psql`, then `\password postgres`).
# Not tracing this line (-x is never enabled above) so the password never lands in
# /var/log/cloud-init-output.log.
sudo -u postgres psql -c "ALTER ROLE postgres WITH PASSWORD '${db_password}';"
