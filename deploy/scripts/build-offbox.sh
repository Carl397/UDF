#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# build-offbox.sh — build shippable artifacts on the OPERATOR's machine.
# ═══════════════════════════════════════════════════════════════════════════
# WHY off-box: the target VM has ~1 GB RAM; a Next.js build would OOM it. So we
# build here and ship only:
#   • a standalone BACKEND bundle: compiled dist/ (+ migrations) + package.json
#     + a backend-only package-lock.json → the server runs `npm ci --omit=dev`
#     to install runtime deps natively (argon2 ships a linux-x64 prebuild, so no
#     compilation is needed, but installing on-platform is still the correct,
#     reproducible path).
#   • the FRONTEND static export (out/) → served directly by nginx.
#
# Outputs into deploy/.artifacts/ :
#   udf-backend.tar.gz, udf-frontend.tar.gz, (optional) regions_data.sql
#
# Usage:
#   API_BASE=/api bash deploy/scripts/build-offbox.sh
#
#   API_BASE  value baked into the client bundle (NEXT_PUBLIC_*):
#             • web behind nginx (same origin) → /api            (default)
#             • other origin                   → https://HOST/api
#   DUMP_GEO=1  also snapshot the local `regions` table so the server can seed
#               geo WITHOUT outbound ArcGIS access (needs local pg_dump).
#   LOCAL_DATABASE_URL  dev DB to snapshot geo from (default below).
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# macOS bsdtar stores extended attributes (com.apple.provenance) as AppleDouble
# "._*" sidecar entries; GNU tar on the Linux server materialises them as real
# files (e.g. dist/db/migrations/._001_init.sql, which sorts before 001_init.sql
# and breaks migrate.js). COPYFILE_DISABLE stops tar from ever writing them.
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ART="$ROOT/deploy/.artifacts"
API_BASE="${API_BASE:-/api}"
DUMP_GEO="${DUMP_GEO:-0}"
LOCAL_DATABASE_URL="${LOCAL_DATABASE_URL:-postgres://party:party_dev_only@localhost:5433/party}"

echo "==> repo=$ROOT  API_BASE=$API_BASE  DUMP_GEO=$DUMP_GEO"
rm -rf "$ART"; install -d "$ART"

# ── 0. Install workspace deps (root lock) ────────────────────────────────────
cd "$ROOT"
[[ -d node_modules ]] || npm ci

# ── 1. Backend: compile (tsc → dist) + bundle migrations ─────────────────────
echo "==> backend: build"
npm run build --workspace backend
cd "$ROOT/backend"
# tsc does NOT copy .sql; the migration runner resolves dist/db/migrations at
# runtime, so mirror the SQL next to the compiled migrate.js.
install -d dist/db/migrations
cp -f src/db/migrations/*.sql dist/db/migrations/
echo "    dist/db/migrations: $(ls -1 dist/db/migrations | wc -l | tr -d ' ') .sql files"

# ── 2. Backend: standalone runtime lock (decoupled from the workspace) ───────
echo "==> backend: generate standalone package-lock (runtime install on server)"
STAGE="$(mktemp -d)"
BUNDLE="$STAGE/backend"
install -d "$BUNDLE"
cp -f "$ROOT/backend/package.json" "$BUNDLE/"
cp -Rf "$ROOT/backend/dist" "$BUNDLE/dist"
LOCKTMP="$(mktemp -d)"
cp -f "$ROOT/backend/package.json" "$LOCKTMP/"
( cd "$LOCKTMP" && npm install --package-lock-only --ignore-scripts >/dev/null )
cp -f "$LOCKTMP/package-lock.json" "$BUNDLE/package-lock.json"
tar -czf "$ART/udf-backend.tar.gz" -C "$STAGE" backend
echo "    → $ART/udf-backend.tar.gz  (dist + package.json + lock)"
rm -rf "$STAGE" "$LOCKTMP"

# ── 3. Frontend: static export (NEXT_EXPORT=1 → out/) ────────────────────────
echo "==> frontend: static export"
cd "$ROOT/frontend"
NEXT_PUBLIC_API_BASE="$API_BASE" npm run build:mobile
[[ -d out ]] || { echo "ERROR: frontend out/ was not produced" >&2; exit 1; }
tar -czf "$ART/udf-frontend.tar.gz" -C "$ROOT/frontend/out" .
echo "    → $ART/udf-frontend.tar.gz  ($(du -sh "$ROOT/frontend/out" | cut -f1) static)"

# ── 4. Optional: deterministic geo snapshot (no ArcGIS needed on server) ─────
if [[ "$DUMP_GEO" == "1" ]]; then
  echo "==> geo: dumping local regions table"
  if command -v pg_dump >/dev/null 2>&1; then
    # pg_dump refuses a server newer than itself (e.g. host v14 vs a v16 dev
    # container) — capture stderr and, on ANY failure, DELETE the snapshot so
    # bootstrap falls back to seed:cpt instead of importing a 0-byte no-op that
    # would silently leave the map with no wards.
    if pg_dump "$LOCAL_DATABASE_URL" -t public.regions --data-only --column-inserts \
        > "$ART/.regions_raw.sql" 2>"$ART/.geo_err"; then
      # `regions` has a NON-deferrable self-FK (parent_code→code); a data-only
      # dump is not guaranteed to be parent-first, and bootstrap imports with
      # ON_ERROR_STOP as the non-superuser owner. Wrap the load to drop the FK,
      # insert, then re-add (which validates) — owner-only, no superuser needed.
      {
        echo "-- UDF regions geo snapshot (wrapped for order-independent load)."
        echo "-- Self-FK regions_parent_code_fkey (parent_code -> code) is NOT deferrable;"
        echo "-- drop it during load, re-add (validates) after. Must match the schema."
        echo "ALTER TABLE public.regions DROP CONSTRAINT IF EXISTS regions_parent_code_fkey;"
        echo
        cat "$ART/.regions_raw.sql"
        echo
        echo "ALTER TABLE public.regions ADD CONSTRAINT regions_parent_code_fkey FOREIGN KEY (parent_code) REFERENCES public.regions(code) ON DELETE SET NULL;"
      } > "$ART/regions_data.sql"
      echo "    → $ART/regions_data.sql ($(grep -c 'INSERT INTO' "$ART/regions_data.sql" | tr -d ' ') rows, FK-wrapped)"
    else
      echo "    geo dump FAILED — removing empty snapshot; server will use seed:cpt:" >&2
      sed 's/^/      /' "$ART/.geo_err" >&2 || true
      rm -f "$ART/regions_data.sql"
    fi
    rm -f "$ART/.regions_raw.sql" "$ART/.geo_err"
  else
    echo "    pg_dump not found — skipping (server can use seed:cpt)"
  fi
fi

echo
echo "Artifacts ready in $ART:"
ls -1 "$ART"
echo
echo "Next: SERVER=root@102.68.98.129 bash deploy/scripts/ship.sh"
