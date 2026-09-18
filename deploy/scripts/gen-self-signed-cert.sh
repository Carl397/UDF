#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# gen-self-signed-cert.sh — self-signed TLS cert for serving UDF over HTTPS by IP.
# ═══════════════════════════════════════════════════════════════════════════
# Target origin: https://<SERVER_IP>   (default 102.68.98.129)
#
# Writes into /etc/udf/tls (root-owned):
#   udf.key     (2048-bit, chmod 600) — nginx ssl_certificate_key
#   udf.crt     (self-signed, 825d)   — nginx ssl_certificate
#   udf-ca.pem  (= udf.crt)           — bundle as the Android trust anchor
#
# The CN + subjectAltName are the IP so clients match the host. A self-signed
# cert is NOT trusted by default: browsers show a warning (click-through) and
# the Android release build must bundle udf-ca.pem (see the release
# network_security_config.xml + RUNBOOK). Swap in a CA cert (e.g. Let's Encrypt
# on a real domain) later, then set ENABLE_HSTS=true.
#
# Usage:  sudo bash deploy/scripts/gen-self-signed-cert.sh [SERVER_IP] [DAYS]
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SERVER_IP="${1:-102.68.98.129}"
DAYS="${2:-825}"
TLS_DIR=/etc/udf/tls

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
install -d -m 750 "$TLS_DIR"

KEY="$TLS_DIR/udf.key"
CRT="$TLS_DIR/udf.crt"

if [[ -f "$CRT" ]]; then
  echo "• Certificate already exists: $CRT"
  echo "  Delete it (and $KEY) then re-run to regenerate."
else
  openssl req -x509 -nodes -newkey rsa:2048 -days "$DAYS" \
    -keyout "$KEY" -out "$CRT" \
    -subj "/C=ZA/ST=Western Cape/L=Cape Town/O=UDF/CN=$SERVER_IP" \
    -addext "subjectAltName=IP:$SERVER_IP" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth"
  chmod 600 "$KEY"; chmod 644 "$CRT"
  cp "$CRT" "$TLS_DIR/udf-ca.pem"; chmod 644 "$TLS_DIR/udf-ca.pem"
  echo "• Generated self-signed certificate for IP $SERVER_IP ($DAYS days):"
  echo "    $CRT              (nginx ssl_certificate)"
  echo "    $KEY              (nginx ssl_certificate_key, chmod 600)"
  echo "    $TLS_DIR/udf-ca.pem   (Android trust anchor — copy into the APK build)"
fi

echo
echo "Verify:  openssl x509 -in $CRT -noout -subject -ext subjectAltName -dates"
