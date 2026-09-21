#!/usr/bin/env bash
# Brand the UDF webmail portal: the flag logo on the login screen AND every
# signed-in page (full fit on login), the party favicon, and the party colour
# palette across the whole UI through a small Roundcube plugin.
#
# Everything installed here comes from the repo, so re-running after a Roundcube
# upgrade restores the branding in one step (an upgrade replaces skins/ and
# plugins/, which is exactly why the logo is a separate file and the colours
# live in a plugin rather than in the skin's own stylesheet).
#
#   scp -r deploy/scripts/brand-webmail.sh deploy/branding deploy/webmail \
#       root@HOST:/root/udf-deploy/
#   ssh root@HOST 'bash /root/udf-deploy/brand-webmail.sh'
#
# Idempotent: the branded config block is removed and re-added, the plugins line
# only gains 'udf_branding' once, and assets are re-installed by content.
set -euo pipefail

WEBROOT="${WEBROOT:-/var/www/udf/webmail}"
SRC="${SRC:-/root/udf-deploy}"
SKIN_IMAGES="${WEBROOT}/skins/elastic/images"
PLUGIN_DIR="${WEBROOT}/plugins/udf_branding"
CONFIG="${WEBROOT}/config/config.inc.php"

for f in "${SRC}/branding/udf-webmail-logo.png" "${SRC}/branding/udf-webmail-favicon.ico" \
         "${SRC}/webmail/udf_branding/udf_branding.php" \
         "${SRC}/webmail/udf_branding/skins/elastic/udf-branding.css"; do
  [ -f "${f}" ] || { echo "missing source asset: ${f}" >&2; exit 1; }
done
{ [ -d "${SKIN_IMAGES}" ] && [ -f "${CONFIG}" ]; } \
  || { echo "webmail layout not found under ${WEBROOT}" >&2; exit 1; }

BK=/root/backups/prewebmailbrand-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "${BK}"; chmod 700 "${BK}"
cp -a "${CONFIG}" "${BK}/"
echo "config backup -> ${BK}"

# ── assets ──────────────────────────────────────────────────────────────────
install -o root -g www-data -m 644 "${SRC}/branding/udf-webmail-logo.png"    "${SKIN_IMAGES}/udf-logo.png"
install -o root -g www-data -m 644 "${SRC}/branding/udf-webmail-favicon.ico" "${SKIN_IMAGES}/udf-favicon.ico"
install -d -o root -g www-data -m 755 "${PLUGIN_DIR}" "${PLUGIN_DIR}/skins/elastic"
install -o root -g www-data -m 644 "${SRC}/webmail/udf_branding/udf_branding.php" "${PLUGIN_DIR}/udf_branding.php"
install -o root -g www-data -m 644 "${SRC}/webmail/udf_branding/skins/elastic/udf-branding.css" \
        "${PLUGIN_DIR}/skins/elastic/udf-branding.css"
echo "assets installed: login logo, favicon, udf_branding plugin + its stylesheet"

# ── config ──────────────────────────────────────────────────────────────────
sed -i '/# BEGIN UDF-BRANDING/,/# END UDF-BRANDING/d' "${CONFIG}"
cat >>"${CONFIG}" <<'BLOCK'

# BEGIN UDF-BRANDING (managed by deploy/scripts/brand-webmail.sh)
# Logo on EVERY task, not just the login screen: the 'elastic' key applies to
# every task under the Elastic skin, so the header of the signed-in mailbox,
# settings and contacts pages carries the party mark too. 'elastic:login' is
# kept explicit so the login sizing rule always has its source.
$config['skin_logo'] = [
    'elastic'        => '/images/udf-logo.png',
    'elastic:login'  => '/images/udf-logo.png',
];
$config['favicon'] = '/images/udf-favicon.ico';
# END UDF-BRANDING
BLOCK

if ! grep -q "^\$config\['plugins'\].*udf_branding" "${CONFIG}"; then
  sed -i "/^\$config\['plugins'\]/ s/\];\$/, 'udf_branding'];/" "${CONFIG}"
  echo "udf_branding added to the enabled plugins"
else
  echo "udf_branding already enabled"
fi

chown root:www-data "${CONFIG}"; chmod 640 "${CONFIG}"
php -l "${CONFIG}" >/dev/null
grep -q "^\$config\['plugins'\].*udf_branding" "${CONFIG}" || { echo "plugins line did not update" >&2; exit 1; }
echo "config updated, PHP syntax OK"

# ── verify ──────────────────────────────────────────────────────────────────
echo "== verify =="
rc=0
code=$(curl -s -o /tmp/udf-login.html -w '%{http_code}' https://mail.udf-party.co.za/)
grep -q 'udf-logo.png'    /tmp/udf-login.html && echo "login page (HTTP ${code}) uses the UDF logo" \
  || { echo "FAIL: logo not referenced (HTTP ${code})"; rc=1; }
grep -q 'udf-favicon.ico' /tmp/udf-login.html && echo "login page uses the UDF favicon" \
  || { echo "FAIL: favicon not referenced"; rc=1; }
grep -q 'udf-branding.css' /tmp/udf-login.html && echo "login page loads the UDF stylesheet (plugin active)" \
  || { echo "FAIL: plugin stylesheet not referenced"; rc=1; }
# The slogan/pillar strip is injected into the login card by the plugin's
# template_container hook, so it has to arrive as real markup, not CSS content.
grep -q 'udf-brand-pillars' /tmp/udf-login.html && echo "login page carries the UDF brand strip (slogan + pillars)" \
  || { echo "FAIL: brand strip not rendered"; rc=1; }
for phrase in "Service before self" "Housing" "Women &amp; youth"; do
  grep -q "${phrase}" /tmp/udf-login.html && echo "login page says: ${phrase}" \
    || { echo "FAIL: missing copy '${phrase}'"; rc=1; }
done
for u in /skins/elastic/images/udf-logo.png /skins/elastic/images/udf-favicon.ico \
         /plugins/udf_branding/skins/elastic/udf-branding.css; do
  out=$(curl -s -o /dev/null -w '%{http_code}' "https://mail.udf-party.co.za${u}")
  [ "${out}" = 200 ] && echo "served 200: ${u}" || { echo "FAIL ${out}: ${u}"; rc=1; }
done
rm -f /tmp/udf-login.html
exit "${rc}"
