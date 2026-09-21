#!/usr/bin/env bash
# Provision UDF councillor mailboxes on the production mail host.
#
# Appends to the existing Dovecot passwd-file and the Postfix virtual-mailbox
# map, creates each Maildir, then proves every account authenticates and routes.
# Nothing is restarted: only `postfix reload` runs (Dovecot reads passwd-file at
# auth time and auth_cache_size is 0, so it needs no reload either).
#
#   scp deploy/scripts/provision-mailboxes.sh \
#       deploy/scripts/councillor-mailboxes.txt \
#       root@HOST:/root/udf-deploy/
#   ssh root@HOST 'bash /root/udf-deploy/provision-mailboxes.sh'
#
# Re-running is safe: accounts that already exist are skipped, and the shared
# password is reused from the root-only file instead of being replaced.
# The password is never echoed by this script and never leaves the host.
set -euo pipefail

DOMAIN="udf-party.co.za"
LIST="${LIST:-/root/udf-deploy/councillor-mailboxes.txt}"
USERS=/etc/dovecot/users
MAILBOX_MAP=/etc/postfix/vmail/mailboxes
MAILBASE=/var/mail/vhosts/${DOMAIN}
PASSFILE=/root/udf-councillor-mailbox-password.txt
RESERVED="admin info support membership no-reply noreply notifications alerts postmaster abuse webmaster root"

[ -f "${LIST}" ] || { echo "missing mailbox list: ${LIST}" >&2; exit 1; }
{ [ -f "${USERS}" ] && [ -f "${MAILBOX_MAP}" ] && [ -d "${MAILBASE}" ]; } \
  || { echo "expected mail layout not found (${USERS}, ${MAILBOX_MAP}, ${MAILBASE})" >&2; exit 1; }

BK=/root/backups/premailboxes-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "${BK}"; chmod 700 "${BK}"
cp -a "${USERS}" "${MAILBOX_MAP}" "${BK}/"
[ -f "${MAILBOX_MAP}.db" ] && cp -a "${MAILBOX_MAP}.db" "${BK}/"
echo "backup of both maps -> ${BK}"

if [ -s "${PASSFILE}" ]; then
  PASS="$(<"${PASSFILE}")"
  echo "reusing the existing shared password in ${PASSFILE} (mode 600, root only)"
else
  # no `head -c | tr` pipeline here: head closing the pipe early makes tr die
  # with SIGPIPE, which `set -o pipefail` turns into an aborted run
  raw=$(head -c 512 /dev/urandom | tr -dc 'A-Za-z0-9')
  PASS=${raw:0:20}
  [ ${#PASS} -eq 20 ] || { echo "could not derive a 20-char password" >&2; exit 1; }
  (umask 077; printf '%s\n' "${PASS}" >"${PASSFILE}")
  echo "generated a shared password; stored only in ${PASSFILE} (mode 600, root only)"
fi

has_user() { awk -F: -v u="$1" '$1 == u { found = 1 } END { exit !found }' "${USERS}"; }

added=0 skipped=0
while read -r lp who _wards; do
  case "${lp}" in ''|'#'*) continue ;; esac
  user="${lp}@${DOMAIN}"
  if printf '%s\n' ${RESERVED} | grep -qx -- "${lp}"; then
    echo "SKIP reserved localpart: ${user}"; skipped=$((skipped + 1)); continue
  fi
  if has_user "${user}"; then
    echo "exists: ${user}"; skipped=$((skipped + 1)); continue
  fi
  hash=$(doveadm pw -s SHA512-CRYPT -p "${PASS}")
  [ -n "${hash}" ] || { echo "doveadm pw returned no hash for ${user}" >&2; exit 1; }
  printf '%s:%s:5000:5000::%s/%s/::\n' "${user}" "${hash}" "${MAILBASE}" "${lp}" >>"${USERS}"
  printf '%s\t%s/%s/\n' "${user}" "${DOMAIN}" "${lp}" >>"${MAILBOX_MAP}"
  mkdir -p "${MAILBASE}/${lp}/cur" "${MAILBASE}/${lp}/new" "${MAILBASE}/${lp}/tmp"
  chown -R vmail:vmail "${MAILBASE}/${lp}"
  chmod 2700 "${MAILBASE}/${lp}"
  chmod 700 "${MAILBASE}/${lp}/cur" "${MAILBASE}/${lp}/new" "${MAILBASE}/${lp}/tmp"
  echo "added:  ${user}  (${who})"
  added=$((added + 1))
done <"${LIST}"

chmod 600 "${USERS}"; chown root:root "${USERS}"
postmap "${MAILBOX_MAP}"
postfix reload
echo "maps rebuilt, postfix reloaded (no service restart)"

echo "== verify: Dovecot auth + Postfix inbound routing =="
failed=0
while read -r lp _who _wards; do
  case "${lp}" in ''|'#'*) continue ;; esac
  user="${lp}@${DOMAIN}"
  if doveadm auth test "${user}" "${PASS}" >/dev/null 2>&1; then auth=ok; else auth=FAIL; fi
  route=$(postmap -q "${user}" "hash:${MAILBOX_MAP}" || true)
  [ -n "${route}" ] || route=none
  dir="${MAILBASE}/${lp}/new"
  [ -d "${dir}" ] && dirmode=$(stat -c '%a:%U:%G' "${dir}") || dirmode=missing
  if [ "${auth}" = ok ] && [ "${route}" != none ] && [ "${dirmode}" != missing ]; then
    echo "OK    ${user}  -> ${route}  (${dirmode})"
  else
    echo "FAIL  ${user}  auth=${auth} route=${route} maildir=${dirmode}"
    failed=$((failed + 1))
  fi
done <"${LIST}"

unset PASS
echo
echo "added=${added} skipped=${skipped} failed=${failed}"
echo "shared password: read it once with  cat ${PASSFILE}  then delete that file."
exit "${failed}"
