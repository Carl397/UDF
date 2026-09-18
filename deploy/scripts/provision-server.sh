#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# provision-server.sh — prepare an Ubuntu 22.04 VM to host UDF (backend + web).
# ═══════════════════════════════════════════════════════════════════════════
# IDEMPOTENT. Run as root on the server:
#   sudo bash deploy/scripts/provision-server.sh
#
# ⚠ THIS VM RUNS A LIVE MAIL STACK (postfix/dovecot/opendkim) AND NGINX. This
#   script deliberately DOES NOT:
#     • touch ufw / firewall rules (SSH is already locked to your admin IP and
#       80/443 are already open for the mail web endpoints),
#     • modify, reload, or enable/disable nginx (the UDF site is added later by
#       hand with an `nginx -t` guard — see deploy/nginx/udf.conf),
#     • alter any mail service.
#   It only ADDS: swap, Node 20, PostgreSQL + PostGIS, build tools, a `udf`
#   system user, and the app directories.
#
# Low RAM (~1 GB): a 1 GB swap file is created first so `npm ci` and the Node
# runtime don't OOM the box (the frontend is built OFF-box — see build-offbox.sh).
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

APP_USER=udf
APP_DIR=/opt/udf
WEB_DIR=/var/www/udf
ETC_DIR=/etc/udf

echo "==> 1/7  apt update + base packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg openssl \
  build-essential python3

echo "==> 2/7  swap (guard against OOM on a ~1 GB VM)"
if ! swapon --show 2>/dev/null | grep -q .; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    swap enabled: $(swapon --show --noheadings || true)"
else
  echo "    swap already present — skipping"
fi

echo "==> 3/7  Node.js 20 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v)  npm $(npm -v)"

echo "==> 4/7  PostgreSQL + PostGIS"
apt-get install -y postgresql postgresql-contrib postgis
systemctl enable --now postgresql
# Ensure the PostGIS extension package for the installed PG major is present.
PG_MAJOR="$(psql --version 2>/dev/null | awk '{print $3}' | cut -d. -f1 || echo 14)"
apt-get install -y "postgresql-${PG_MAJOR}-postgis-3" || \
  echo "    (postgis meta already satisfied; will verify CREATE EXTENSION in bootstrap)"

echo "==> 5/7  app system user + group"
getent group "$APP_USER" >/dev/null 2>&1 || groupadd --system "$APP_USER"
id -u "$APP_USER" >/dev/null 2>&1 || \
  useradd --system --gid "$APP_USER" --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

echo "==> 6/7  directories"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"
install -d -o root -g "$APP_USER" -m 755 "$WEB_DIR" "$WEB_DIR/frontend"
install -d -o root -g "$APP_USER" -m 750 "$ETC_DIR"

echo "==> 7/7  done"
cat <<EOF

Provisioning complete.

Firewall: NOT modified. Confirm you can still SSH, and that 80/443 are open:
    sudo ufw status verbose
(The UDF API binds 127.0.0.1:4000 — it needs NO inbound port; nginx proxies it.)

Next:
  1. sudo bash deploy/scripts/gen-secrets.sh          # JWT keys + KEK/blind index
  2. sudo bash deploy/scripts/gen-self-signed-cert.sh # TLS cert for the IP
  3. Create the DB role/database  → see bootstrap-server.sh
  4. Fill /etc/udf/udf-api.env    → from deploy/production.env.example
  5. Ship build artifacts         → build-offbox.sh + ship.sh
  6. Install nginx site + systemd → deploy/nginx/udf.conf, deploy/systemd/udf-api.service
  7. Read deploy/RUNBOOK.md end-to-end BEFORE touching this box.
EOF
