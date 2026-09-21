#!/usr/bin/env bash
# Give councillors a self-service webmail password change.
#
# Roundcube's `password` plugin ships with the install but is not enabled, and
# none of its drivers can work here as shipped: the webmail FPM pool disables
# exec/system/proc_open/popen, and /etc/dovecot/users is root:root 0600. The
# fix is NOT to widen either - a web app that can rewrite the mailbox
# credential store turns one PHP bug into 25 hijacked councillor mailboxes.
#
# Instead:
#   * /usr/local/sbin/udf-mail-passwd       root-only helper, listens on a unix
#     socket, verifies the CURRENT password against the stored SHA512-crypt
#     before writing, hashes the new one with `doveadm pw`, replaces the file
#     atomically and keeps it 0600 root:root.
#   * plugins/password/drivers/udf_mailbox.php   the Roundcube side; no shell,
#     no file access, one three-line socket call.
#
# Sources live in deploy/webmail/{mail-passwd,password-drivers}/ - edit those
# and re-run this script, never the installed copies. Safe to re-run, including
# after a Roundcube upgrade (which replaces plugins/).
#
#   scp -r deploy/scripts/enable-webmail-password.sh deploy/webmail root@HOST:/root/udf-deploy/
#   ssh root@HOST 'bash /root/udf-deploy/enable-webmail-password.sh'
set -euo pipefail

WEBROOT="${WEBROOT:-/var/www/udf/webmail}"
SRC="${SRC:-/root/udf-deploy}"
CONFIG="${WEBROOT}/config/config.inc.php"
DRIVERS="${WEBROOT}/plugins/password/drivers"
SOCK=/run/udf-mail-passwd/mail.sock
UNIT=udf-mail-passwd.service
FPM_SERVICE="${FPM_SERVICE:-php8.1-fpm}"

for f in "${SRC}/webmail/mail-passwd/udf-mail-passwd.py" \
         "${SRC}/webmail/mail-passwd/${UNIT}" \
         "${SRC}/webmail/password-drivers/udf_mailbox.php"; do
  [ -f "${f}" ] || { echo "missing source: ${f}" >&2; exit 1; }
done
[ -d "${DRIVERS}" ] || { echo "password plugin not present at ${DRIVERS}" >&2; exit 1; }
[ -f /etc/dovecot/users ] || { echo "/etc/dovecot/users not found" >&2; exit 1; }

BK=/root/backups/premailpasswd-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "${BK}"; chmod 700 "${BK}"
cp -a "${CONFIG}" "${BK}/config.inc.php"
cp -a /etc/dovecot/users "${BK}/users"
cp -a "/etc/systemd/system/${UNIT}" "${BK}/" 2>/dev/null || true
echo "backup (roundcube config + mailbox file) -> ${BK}"

# ── helper daemon ───────────────────────────────────────────────────────────
install -o root -g root -m 700 "${SRC}/webmail/mail-passwd/udf-mail-passwd.py" /usr/local/sbin/udf-mail-passwd
python3 -c 'import py_compile,sys; py_compile.compile("/usr/local/sbin/udf-mail-passwd", doraise=True)' \
  || { echo "helper does not compile" >&2; exit 1; }
install -o root -g root -m 644 "${SRC}/webmail/mail-passwd/${UNIT}" "/etc/systemd/system/${UNIT}"
systemctl daemon-reload
systemctl enable --now "${UNIT}"
systemctl restart "${UNIT}"          # pick up a newly installed helper binary
sleep 1
systemctl is-active --quiet "${UNIT}" || { echo "helper failed to start" >&2; journalctl -u "${UNIT}" -n 25 --no-pager; exit 1; }

owner=$(stat -c '%U:%G %a' "${SOCK}")
[ "${owner}" = "root:www-data 660" ] \
  || { echo "unexpected socket permissions on ${SOCK}: ${owner}" >&2; exit 1; }
echo "helper: $(systemctl is-active "${UNIT}"), socket ${SOCK} ${owner}"

# ── roundcube driver + plugin config ────────────────────────────────────────
install -o root -g www-data -m 644 "${SRC}/webmail/password-drivers/udf_mailbox.php" "${DRIVERS}/udf_mailbox.php"
php -l "${DRIVERS}/udf_mailbox.php" >/dev/null
echo "driver installed: ${DRIVERS}/udf_mailbox.php"

sed -i '/# BEGIN UDF-MAIL-PASSWORD/,/# END UDF-MAIL-PASSWORD/d' "${CONFIG}"
cat >>"${CONFIG}" <<'BLOCK'

# BEGIN UDF-MAIL-PASSWORD (managed by deploy/scripts/enable-webmail-password.sh)
# The change is applied by the root-owned udf-mail-passwd helper over a unix
# socket; Roundcube neither runs a shell nor writes /etc/dovecot/users.
$config['password_driver'] = 'udf_mailbox';
$config['password_confirm_current'] = true;
# Must match MIN_LENGTH in the helper, so the UI rejects short values first.
$config['password_minimum_length'] = 10;
# The helper already records every change in the journal; no need to duplicate
# it into Roundcube's log, where it would sit beside unrelated request noise.
$config['password_log'] = false;
# END UDF-MAIL-PASSWORD
BLOCK

if ! grep -q "^\$config\['plugins'\].*'password'" "${CONFIG}"; then
  sed -i "/^\$config\['plugins'\]/ s/\];\$/, 'password'];/" "${CONFIG}"
  echo "'password' added to the enabled plugins"
else
  echo "'password' already enabled"
fi

chown root:www-data "${CONFIG}"; chmod 640 "${CONFIG}"
php -l "${CONFIG}" >/dev/null
grep -q "^\$config\['plugins'\].*'password'" "${CONFIG}" || { echo "plugins line did not update" >&2; exit 1; }
grep -q "password_driver.*udf_mailbox" "${CONFIG}" || { echo "driver not configured" >&2; exit 1; }
echo "config updated, PHP syntax OK"

# opcache can hold config.inc.php and the driver; a reload is enough and drops
# no sessions (the pools are separate services from nginx and the CRM).
systemctl reload "${FPM_SERVICE}" || systemctl restart "${FPM_SERVICE}"
echo "${FPM_SERVICE} reloaded"

# ── verify ───────────────────────────────────────────────────────────────────
echo "== verify =="
rc=0
code=$(curl -s -o /dev/null -w '%{http_code}' https://mail.udf-party.co.za/)
[ "${code}" = 200 ] && echo "webmail login still serves (HTTP ${code})" \
  || { echo "FAIL: webmail HTTP ${code}"; rc=1; }
[ "$(stat -c '%a' /etc/dovecot/users)" = 600 ] && [ "$(stat -c '%U:%G' /etc/dovecot/users)" = root:root ] \
  && echo "mailbox store untouched: /etc/dovecot/users still root:root 0600" \
  || { echo "FAIL: /etc/dovecot/users permissions changed"; rc=1; }
grep -q 'udf_mailbox' "${DRIVERS}/udf_mailbox.php" && echo "driver in place" || { echo "FAIL: driver missing"; rc=1; }
# The driver must load and the socket must answer, as the web user, without a
# real mailbox being involved: a deliberately wrong current password has to
# come back BAD_CURRENT, which proves the whole PHP -> socket -> Dovecot-hash
# path and that a wrong password changes nothing.
as_www=$(sudo -u www-data php -r '
  define("PASSWORD_CRYPT_ERROR",1); define("PASSWORD_ERROR",2);
  define("PASSWORD_CONNECT_ERROR",3); define("PASSWORD_IN_HISTORY",4);
  define("PASSWORD_CONSTRAINT_VIOLATION",5); define("PASSWORD_SUCCESS",0);
  require "'"${DRIVERS}"'/udf_mailbox.php";
  $d = new rcube_udf_mailbox_password();
  $r = $d->save("definitely-not-the-password", "a-test-new-password-1", "snefdt@udf-party.co.za");
  echo is_array($r) ? ($r["code"] === PASSWORD_ERROR ? "rejected" : "code=".$r["code"]) : "unexpected-accept";
' 2>&1 | tail -1)
[ "${as_www}" = "rejected" ] && echo "driver reachable from www-data; a wrong current password is rejected" \
  || { echo "FAIL: driver probe returned '${as_www}'"; rc=1; }
journalctl -u "${UNIT}" -n 6 --no-pager -o cat | sed 's/^/  helper log: /'
[ "${rc}" = 0 ] && echo "OK: webmail password change enabled" || echo "ONE OR MORE CHECKS FAILED"
exit "${rc}"
