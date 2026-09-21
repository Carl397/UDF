#!/usr/bin/env bash
# Install the 30-day, single-active-webmail-session policy for Roundcube 1.6.19.
# A new login revokes the previous webmail session; policy errors fail CLOSED.
# This does not restrict separate IMAP clients or enroll a physical device.
# Existing sessions require one fresh login on first activation.
# Back up config/plugin/SQLite, validate before activation, reload only FPM.
# No FPM session.cookie_lifetime override: the plugin persists both cookies.
#
#   scp -r deploy/scripts/configure-mail-sessions.sh deploy/webmail \
#       root@HOST:/root/udf-deploy/
#   ssh root@HOST 'bash /root/udf-deploy/configure-mail-sessions.sh'
#
set -euo pipefail

WEBROOT="${WEBROOT:-/var/www/udf/webmail}"
SRC="${SRC:-/root/udf-deploy}"
CONFIG="${WEBROOT}/config/config.inc.php"
PLUGIN_DIR="${WEBROOT}/plugins/udf_single_session"
DB="${DB:-/var/lib/udf-webmail/roundcube.db}"
PHPFPM_SVC="${PHPFPM_SVC:-php8.1-fpm}"
FPM_BIN="${FPM_BIN:-php-fpm8.1}"
umask 077

PLUG_SRC="${SRC}/webmail/single-session/udf_single_session.php"
[ -f "${PLUG_SRC}" ] || { echo "missing plugin source: ${PLUG_SRC}" >&2; exit 1; }
[ -f "${CONFIG}" ]   || { echo "Roundcube config not found at ${CONFIG}" >&2; exit 1; }
[ "$(id -u)" = 0 ]   || { echo "must run as root" >&2; exit 1; }

[ "$(<"${WEBROOT}/.roundcube-version")" = '1.6.19' ] || { echo 'Unsupported Roundcube version' >&2; exit 1; }
for svc in nginx postfix dovecot opendkim "${PHPFPM_SVC}"; do
  systemctl is-active --quiet "${svc}"
done
php -l "${PLUG_SRC}" >/dev/null
"${FPM_BIN}" -t
BK=$(mktemp -d /root/backups/premailsession-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX)
chmod 700 "${BK}"
cp -a "${CONFIG}" "${BK}/config.inc.php.bak"
[ ! -f "${PLUGIN_DIR}/udf_single_session.php" ] || cp -a "${PLUGIN_DIR}/udf_single_session.php" "${BK}/plugin.php.bak"
php "${SRC}/webmail/single-session/prepare.php" "${CONFIG}" "${DB}" "${BK}/roundcube.db" "${BK}/config.candidate.php"
php -l "${BK}/config.candidate.php" >/dev/null
php -r 'require $argv[1]; if ($config["session_lifetime"] !== 43200 || !in_array("udf_single_session", $config["plugins"], true)) exit(1);' "${BK}/config.candidate.php"
echo "backups and candidate validated -> ${BK}"
rollback() {
  trap - ERR
  install -o root -g www-data -m 640 "${BK}/config.inc.php.bak" "${CONFIG}"
  if [ -f "${BK}/plugin.php.bak" ]; then
    install -o root -g www-data -m 644 "${BK}/plugin.php.bak" "${PLUGIN_DIR}/udf_single_session.php"
  fi
  systemctl reload "${PHPFPM_SVC}" || true
  echo 'Activation failed; previous config restored. Policy table retained inert for investigation.' >&2
  exit 1
}
trap rollback ERR

# ── 2. plugin file ───────────────────────────────────────────────────────────
install -d -o root -g www-data -m 755 "${PLUGIN_DIR}"
install -o root -g www-data -m 644 "${PLUG_SRC}" "${PLUGIN_DIR}/udf_single_session.php"
echo "plugin installed: ${PLUGIN_DIR}/udf_single_session.php"

# Activate the validated config atomically; no mail daemon restart.
install -o root -g www-data -m 640 "${BK}/config.candidate.php" "${CONFIG}.udf-new"
mv -f "${CONFIG}.udf-new" "${CONFIG}"
systemctl reload "${PHPFPM_SVC}"
systemctl is-active --quiet "${PHPFPM_SVC}"
runuser -u www-data -- php -r '$db = new PDO("sqlite:" . $argv[1]); $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION); $db->query("SELECT user_id, token_hash, expires_at FROM udf_session_policy LIMIT 0");' "${DB}"
code=$(curl --fail --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' https://mail.udf-party.co.za/)
[ "${code}" = 200 ]
trap - ERR
echo 'Policy installed; live two-client login and cookie checks are still required.'
