#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# bootstrap-server.sh — run ON THE SERVER (as root) to install UDF.
# ═══════════════════════════════════════════════════════════════════════════
# PREREQUISITES (in order — see RUNBOOK.md):
#   1. provision-server.sh        (Node 20, PostgreSQL+PostGIS, udf user, dirs)
#   2. gen-secrets.sh             (/etc/udf/jwt_*.pem + secrets.env)
#   3. gen-self-signed-cert.sh    (/etc/udf/tls/udf.{crt,key})
#   4. /etc/udf/udf-api.env filled from production.env.example (DATABASE_URL etc.)
#   5. ship.sh has staged /root/udf-deploy (artifacts + kit)
#
# This script: extracts artifacts, installs backend runtime deps, creates the DB
# role/database + PostGIS, runs migrations, seeds geo, and (if SUPERADMIN_* are
# present in the env) seeds the super-admin. It does NOT enable nginx or the
# systemd unit — those are done by hand with review (see RUNBOOK).
#
# Usage:  sudo DEPLOY_DIR=/root/udf-deploy bash scripts/bootstrap-server.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi

DEPLOY_DIR="${DEPLOY_DIR:-/root/udf-deploy}"
ART="$DEPLOY_DIR/artifacts"
APP_DIR=/opt/udf
BACKEND_DIR="$APP_DIR/backend"
WEB_DIR=/var/www/udf/frontend
ENV_FILE=/etc/udf/udf-api.env
SECRETS=/etc/udf/secrets.env

# ── preflight ────────────────────────────────────────────────────────────────
for f in "$ENV_FILE" "$SECRETS" /etc/udf/jwt_private.pem /etc/udf/jwt_public.pem \
         "$ART/udf-backend.tar.gz" "$ART/udf-frontend.tar.gz"; do
  [[ -e "$f" ]] || { echo "❌ MISSING $f — complete the prerequisites first." >&2; exit 1; }
done
command -v node >/dev/null || { echo "❌ node not found — run provision-server.sh." >&2; exit 1; }

# Load config so the node/psql steps see DATABASE_URL, keys, and prod settings.
set -a; . "$ENV_FILE"; . "$SECRETS"; set +a
export NODE_ENV=production
: "${DATABASE_URL:?DATABASE_URL must be set in $ENV_FILE}"

# ── 1. backend bundle ────────────────────────────────────────────────────────
echo "==> 1/6 extract backend → $BACKEND_DIR"
install -d "$APP_DIR"
rm -rf "$BACKEND_DIR"
tar -xzf "$ART/udf-backend.tar.gz" -C "$APP_DIR"     # yields $APP_DIR/backend
[[ -d "$BACKEND_DIR/dist/db/migrations" ]] || { echo "❌ migrations missing from bundle" >&2; exit 1; }

echo "==> 2/6 npm ci --omit=dev (backend runtime deps, on-platform)"
cd "$BACKEND_DIR"
npm ci --omit=dev --no-audit --no-fund

# ── 3. database role + database + PostGIS ────────────────────────────────────
echo "==> 3/6 create DB role/database (idempotent)"
DB_USER="$(node -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).username))')"
DB_PASS="$(node -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).password))')"
DB_NAME="$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
# Role (heredoc keeps the password out of the process list / argv).
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE "$DB_USER" LOGIN PASSWORD '$DB_PASS';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres psql -q -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"
# Extensions must be created by a superuser; the app then uses them as $DB_USER.
sudo -u postgres psql -d "$DB_NAME" -q -c "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# ── 4. migrations ────────────────────────────────────────────────────────────
echo "==> 4/6 run migrations"
cd "$BACKEND_DIR"
node dist/db/migrate.js

# ── 5. geo seed (snapshot if shipped, else ArcGIS fetch) ─────────────────────
echo "==> 5/6 seed geo (ward/subcouncil boundaries)"
if [[ -f "$ART/regions_data.sql" ]]; then
  echo "    importing shipped regions snapshot (no outbound needed)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$ART/regions_data.sql"
else
  echo "    fetching from City of Cape Town ArcGIS (needs outbound internet)"
  node dist/db/seedCapeTown.js
fi

# ── 6. super-admin (only if creds are in the environment) ────────────────────
echo "==> 6/6 super-admin"
if [[ -n "${SUPERADMIN_EMAIL:-}" && -n "${SUPERADMIN_PASSWORD:-}" ]]; then
  node dist/db/seedAdmin.js
else
  echo "    SUPERADMIN_EMAIL/PASSWORD not set — skipped."
  echo "    Seed it later WITHOUT committing creds:"
  echo "      cd $BACKEND_DIR && set -a && . $ENV_FILE && . $SECRETS && set +a && \\"
  echo "      SUPERADMIN_EMAIL='real@email' SUPERADMIN_PASSWORD='strong-pass' \\"
  echo "      SUPERADMIN_NAME='Carl Marks' node dist/db/seedAdmin.js"
fi

# ── ownership ────────────────────────────────────────────────────────────────
echo "==> extract frontend → $WEB_DIR"
rm -rf "$WEB_DIR"; install -d "$WEB_DIR"
tar -xzf "$ART/udf-frontend.tar.gz" -C "$WEB_DIR"
chown -R udf:udf "$BACKEND_DIR"
chown -R root:udf "$WEB_DIR"
find "$WEB_DIR" -type d -exec chmod 755 {} + ; find "$WEB_DIR" -type f -exec chmod 644 {} +

cat <<EOF

✅ Bootstrap complete.
   backend : $BACKEND_DIR  (dist + node_modules, owned udf:udf)
   frontend: $WEB_DIR       (static export)
   database: $DB_NAME (role $DB_USER) — migrated + geo seeded

Next (by hand, with review — see RUNBOOK.md):
  1. sudo cp $DEPLOY_DIR/systemd/udf-api.service /etc/systemd/system/
     sudo systemctl daemon-reload
     sudo systemctl enable --now udf-api
     curl -s http://127.0.0.1:4000/healthz      # expect {"status":"ok","db":true}
  2. Install the nginx site AFTER the 'nginx -T' pre-flight (mail-safe):
     sudo cp $DEPLOY_DIR/nginx/udf.conf /etc/nginx/sites-available/udf
     sudo ln -s /etc/nginx/sites-available/udf /etc/nginx/sites-enabled/udf
     sudo nginx -t && sudo systemctl reload nginx
  3. Open https://<SERVER_IP>/healthz and the app in a browser (accept the
     self-signed warning).
EOF
