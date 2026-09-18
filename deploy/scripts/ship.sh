#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# ship.sh — copy the deploy kit + build artifacts to the server. STAGING ONLY:
# nothing is executed or enabled on the server by this script.
# ═══════════════════════════════════════════════════════════════════════════
# Uses ssh/scp/tar only (no rsync dependency). Authenticate with an SSH key
# (recommended) or accept the password prompt. The password is NEVER stored here.
#
# Usage:
#   SERVER=root@102.68.98.129 bash deploy/scripts/ship.sh
#
# Stages everything under /root/udf-deploy on the server:
#   scripts/  nginx/  systemd/  production.env.example  RUNBOOK.md  artifacts/
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# Stop macOS bsdtar writing AppleDouble "._*" sidecars into the bundle; GNU tar
# on the server would extract them as real files (see build-offbox.sh).
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ART="$ROOT/deploy/.artifacts"
SERVER="${SERVER:-root@102.68.98.129}"
REMOTE_DIR="${REMOTE_DIR:-/root/udf-deploy}"

[[ -f "$ART/udf-backend.tar.gz" && -f "$ART/udf-frontend.tar.gz" ]] || {
  echo "ERROR: artifacts missing. Run build-offbox.sh first." >&2; exit 1; }

echo "==> staging deploy kit + artifacts"
STAGE="$(mktemp -d)"
KIT="$STAGE/udf-deploy"
install -d "$KIT/artifacts"
cp -R "$ROOT/deploy/scripts" "$ROOT/deploy/nginx" "$ROOT/deploy/systemd" "$KIT/"
cp "$ROOT/deploy/production.env.example" "$KIT/"
[[ -f "$ROOT/deploy/RUNBOOK.md" ]] && cp "$ROOT/deploy/RUNBOOK.md" "$KIT/"
# Artifacts are FILES (tarballs, .sql, .json, .png). Copy only the top level and
# never recurse: a stray directory in .artifacts (e.g. a browser profile left by
# a live-login check) would otherwise be shipped to the production box, taking
# any cookies/session data inside it along for the ride. `cp dir dest` also just
# fails under `set -e`, which is how this was found.
find "$ART" -maxdepth 1 -type f -exec cp {} "$KIT/artifacts/" \;
echo "    artifacts staged: $(find "$KIT/artifacts" -maxdepth 1 -type f | wc -l | tr -d ' ') file(s)"
tar -czf "$STAGE/udf-deploy.tar.gz" -C "$STAGE" udf-deploy
echo "    bundle: $(du -sh "$STAGE/udf-deploy.tar.gz" | cut -f1)"

echo "==> scp → $SERVER:/root/"
scp "$STAGE/udf-deploy.tar.gz" "$SERVER:/root/udf-deploy.tar.gz"

echo "==> extract on server → $REMOTE_DIR"
ssh "$SERVER" "rm -rf '$REMOTE_DIR' && install -d /root && tar -xzf /root/udf-deploy.tar.gz -C /root && rm -f /root/udf-deploy.tar.gz && chmod +x '$REMOTE_DIR'/scripts/*.sh && echo staged: && ls -1 '$REMOTE_DIR'"

rm -rf "$STAGE"
echo
echo "Staged on $SERVER at $REMOTE_DIR"
echo "Next:  ssh $SERVER"
echo "       cd $REMOTE_DIR && less RUNBOOK.md      # read it end-to-end first"
