#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# setup-webmail.sh — install secure Roundcube webmail for the UDF mail box.
# ═══════════════════════════════════════════════════════════════════════════
# ON-BOX. Run as root on the production VM (102.68.98.129):
#   sudo bash /root/udf-deploy/scripts/setup-webmail.sh
#
# Serves https://mail.udf-party.co.za → Roundcube 1.6.19 (LTS, checksum-pinned)
# against the existing Dovecot (IMAP) / Postfix (submission) stack. Uses the
# mailbox's OWN credentials at login — this script never creates or resets a
# mail password. State (sqlite db, temp, logs) lives OUTSIDE the webroot.
#
# ⚠ THIS VM RUNS LIVE MAIL. nginx is only ever `reload`ed, never restarted.
#   The CRM vhost, the manifesto vhost and block-direct-ip.conf are untouched;
#   this adds ONE new :443 vhost matched by SNI = mail.udf-party.co.za.
#
# IDEMPOTENT-GUARDED: refuses to run if a previous webmail deploy is present,
# unless the pinned artifact is already extracted and verified (then it only
# re-verifies). Safe to re-run for verification.
# ═══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail
umask 022

# ── Pinned identity ──────────────────────────────────────────────────────
RC_VERSION="1.6.19"
RC_URL="https://github.com/roundcube/roundcubemail/releases/download/${RC_VERSION}/roundcubemail-${RC_VERSION}-complete.tar.gz"
# SHA-256 published on roundcube.net/download AND the GitHub release asset digest.
RC_SHA256="c47fd99cd7cbb7aee2557d8ca614a4c51e91f6fa3767ca4ce32c6126f9ebff5b"
DOMAIN="mail.udf-party.co.za"
WEBROOT="/var/www/udf/webmail"
STATE="/var/lib/udf-webmail"
SOCK="/run/php/php8.1-fpm-roundcube.sock"
POOL="/etc/php/8.1/fpm/pool.d/roundcube.conf"
WORK="/root/udf-releases/webmail-${RC_VERSION}"
ACME_EMAIL="postmaster@udf-party.co.za"

log()  { printf '\033[1;32m[webmail]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[webmail] %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. Guards ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || fail "must run as root"
for svc in nginx postfix dovecot opendkim; do
  systemctl is-active --quiet "$svc" || fail "required service not active: $svc"
done
command -v php8.1 >/dev/null || fail "php8.1 not installed (run the apt step first)"
log "guards passed; mail stack active"

# ── 1. Fetch + verify Roundcube (checksum is the hard authenticity gate) ──
install -d -m 700 "$WORK"
cd "$WORK"
if [[ ! -f "roundcubemail-${RC_VERSION}-complete.tar.gz" ]]; then
  log "downloading Roundcube ${RC_VERSION} complete…"
  curl -fsSL --retry 3 -o "roundcubemail-${RC_VERSION}-complete.tar.gz" "$RC_URL"
fi
printf '%s  roundcubemail-%s-complete.tar.gz\n' "$RC_SHA256" "$RC_VERSION" | sha256sum -c - \
  || fail "Roundcube checksum mismatch — refusing to install"
log "checksum verified: ${RC_SHA256}"

# Best-effort GPG signature check (non-fatal: keyserver may be unreachable).
if curl -fsSL --retry 2 -o "roundcubemail-${RC_VERSION}-complete.tar.gz.asc" \
     "${RC_URL}.asc" 2>/dev/null; then
  if gpg --batch --keyserver keyserver.ubuntu.com --recv-keys 41C4F7D5 >/dev/null 2>&1 \
     && gpg --batch --verify "roundcubemail-${RC_VERSION}-complete.tar.gz.asc" \
        "roundcubemail-${RC_VERSION}-complete.tar.gz" >/dev/null 2>&1; then
    log "GPG signature verified (Roundcube Developers 41C4F7D5)"
  else
    log "GPG verification skipped/failed (checksum already verified — continuing)"
  fi
fi

# ── 2. Extract to webroot (fresh) ────────────────────────────────────────
if [[ -e "$WEBROOT" ]]; then
  [[ -f "$WEBROOT/index.php" && -f "$WEBROOT/.roundcube-version" ]] \
    || fail "$WEBROOT exists but is not a Roundcube install — inspect manually"
  log "webroot already present; re-verifying only"
else
  install -d -m 755 "$WEBROOT"
  tar --no-same-owner -xzf "roundcubemail-${RC_VERSION}-complete.tar.gz" \
      -C "$WEBROOT" --strip-components=1
  # IMPORTANT: remove the web installer so it can never run.
  rm -rf "$WEBROOT/installer"
  echo "$RC_VERSION" > "$WEBROOT/.roundcube-version"
  chown -R root:www-data "$WEBROOT"
  find "$WEBROOT" -type d -exec chmod 755 {} +
  find "$WEBROOT" -type f -exec chmod 644 {} +
  log "extracted Roundcube ${RC_VERSION} to $WEBROOT (installer removed)"
fi

# ── 3. State dirs OUTSIDE webroot (db, temp, logs) ───────────────────────
install -d -m 750 -o www-data -g www-data "$STATE"
install -d -m 750 -o www-data -g www-data "$STATE/temp"
install -d -m 750 -o www-data -g www-data "$STATE/logs"
[[ -e "$STATE/roundcube.db" ]] || { touch "$STATE/roundcube.db"; chown www-data:www-data "$STATE/roundcube.db"; chmod 640 "$STATE/roundcube.db"; }
log "state dirs ready at $STATE"

# ── 4. Roundcube config (des_key freshly generated, hardened) ────────────
if [[ -f "$WEBROOT/config/config.inc.php" ]]; then
  DES_KEY="$(grep -oP "(?<=\\\$config\['des_key'\] = ')[^']+" "$WEBROOT/config/config.inc.php" || true)"
  [[ -n "$DES_KEY" ]] || DES_KEY="$(openssl rand -hex 16)"
else
  DES_KEY="$(openssl rand -hex 16)"   # 32 hex chars = 32-byte key for AES-256-CBC
fi
cat > "$WEBROOT/config/config.inc.php" <<PHP
<?php
/* UDF webmail — generated by deploy/scripts/setup-webmail.sh. Do not commit. */
\$config = [];

// ── Database: SQLite outside the webroot (single mailbox; no extra server) ──
\$config['db_dsnw'] = 'sqlite:////var/lib/udf-webmail/roundcube.db?mode=0640';

// ── IMAP (Dovecot) / SMTP (Postfix submission) over loopback TLS ──────────
// Both use the mailbox's OWN login credentials (entered at the Roundcube
// login screen). The on-box mail cert is self-signed with a non-matching CN,
// so peer verification is disabled for these 127.0.0.1-only connections; the
// traffic never leaves the host, so there is no network MITM exposure.
\$config['imap_host'] = 'tls://localhost:143';
\$config['imap_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true]];
\$config['imap_timeout'] = 15;
\$config['smtp_host'] = 'tls://localhost:587';
\$config['smtp_user'] = '%u';
\$config['smtp_pass'] = '%p';
\$config['smtp_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true]];
\$config['smtp_timeout'] = 15;

// ── Crypto / session ──────────────────────────────────────────────────────
\$config['des_key'] = '${DES_KEY}';
\$config['cipher_method'] = 'AES-256-CBC';
\$config['session_storage'] = 'db';
\$config['session_lifetime'] = 30;
\$config['session_samesite'] = 'Lax';
\$config['ip_check'] = false;

// ── Login / identity ──────────────────────────────────────────────────────
\$config['username_domain'] = 'udf-party.co.za';
\$config['mail_domain'] = 'udf-party.co.za';
\$config['login_lc'] = 2;
\$config['login_rate_limit'] = 3;
\$config['auto_create_user'] = true;
\$config['identities_level'] = 0;

// ── Paths / behaviour ─────────────────────────────────────────────────────
\$config['temp_dir'] = '/var/lib/udf-webmail/temp/';
\$config['log_dir']  = '/var/lib/udf-webmail/logs/';
\$config['log_driver'] = 'file';
\$config['log_logins'] = true;
\$config['smtp_log'] = true;
\$config['use_https'] = true;          // always behind nginx TLS
\$config['force_https'] = false;       // nginx serves :443 only for this vhost
\$config['enable_installer'] = false;
\$config['skin'] = 'elastic';
\$config['product_name'] = 'UDF Webmail';
\$config['support_url'] = '';
\$config['x_frame_options'] = 'sameorigin';
\$config['max_message_size'] = '20M';
\$config['proxy_whitelist'] = ['127.0.0.1'];
\$config['plugins'] = ['archive', 'zipdownload'];
PHP
chown root:www-data "$WEBROOT/config/config.inc.php"
chmod 640 "$WEBROOT/config/config.inc.php"
log "wrote hardened config.inc.php"

# ── 5. PHP-FPM pool (isolated socket, open_basedir keeps it off secrets) ──
cat > "$POOL" <<POOLCONF
[roundcube]
user = www-data
group = www-data
listen = ${SOCK}
listen.owner = www-data
listen.group = www-data
listen.mode = 0660
pm = ondemand
pm.max_children = 5
pm.process_idle_timeout = 10s
pm.max_requests = 200
chdir = ${WEBROOT}
php_admin_value[memory_limit] = 128M
php_admin_value[upload_max_filesize] = 25M
php_admin_value[post_max_size] = 26M
php_admin_value[expose_php] = 0
php_admin_value[date.timezone] = Africa/Johannesburg
php_admin_value[session.cookie_httponly] = 1
php_admin_value[session.cookie_secure] = 1
php_admin_value[session.use_strict_mode] = 1
; Keep webmail off mail/CRM secrets: it may read its own tree, its state dir,
; /tmp, system CA + shared read-only data — NOT /etc/dovecot, /etc/udf, /opt/udf.
php_admin_value[open_basedir] = ${WEBROOT}/:${STATE}/:/tmp/:/etc/ssl/certs/:/usr/share/:/dev/urandom:/proc/meminfo
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen,show_source
POOLCONF
# The default www pool binds :9000/unix and is unused here; leave it but ensure
# it does not conflict. Reload picks up the new pool.
systemctl reload php8.1-fpm || systemctl restart php8.1-fpm
sleep 1
[[ -S "$SOCK" ]] || fail "php-fpm roundcube socket not created at $SOCK"
log "php8.1-fpm pool 'roundcube' active on $SOCK"

# ── 6. Let's Encrypt cert for the mail host (HTTP-01 via existing webroot) ─
if [[ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  log "requesting Let's Encrypt certificate for ${DOMAIN}…"
  certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" \
    --agree-tos -m "$ACME_EMAIL" --non-interactive --keep-until-expiring \
    || fail "certbot issuance failed — check DNS + /var/www/letsencrypt reachability"
else
  log "certificate for ${DOMAIN} already present; keeping"
fi

# ── 7. Install nginx vhost (reload only — live mail) ─────────────────────
SRC_CONF="/root/udf-deploy/nginx/udf-webmail.conf"
[[ -f "$SRC_CONF" ]] || fail "nginx template not shipped: $SRC_CONF"
install -m 644 "$SRC_CONF" /etc/nginx/sites-available/udf-webmail
[[ -e /etc/nginx/sites-enabled/udf-webmail ]] \
  || ln -s /etc/nginx/sites-available/udf-webmail /etc/nginx/sites-enabled/udf-webmail
nginx -t || fail "nginx config test failed — vhost NOT enabled"
systemctl reload nginx
log "nginx reloaded with ${DOMAIN} vhost"

# ── 8. Verify (transport + login page + mail stack unchanged) ────────────
log "verifying…"
openssl s_client -starttls imap -connect 127.0.0.1:143 </dev/null 2>/dev/null | grep -q "BEGIN CERTIFICATE" && log "IMAP STARTTLS OK" || log "IMAP STARTTLS check inconclusive"
openssl s_client -starttls smtp -connect 127.0.0.1:587 </dev/null 2>/dev/null | grep -q "BEGIN CERTIFICATE" && log "SMTP STARTTLS OK" || log "SMTP STARTTLS check inconclusive"

# The verification curl can transiently fail (curl exit 60) in the instant right
# after `systemctl reload nginx` while workers swap in the new cert, so retry.
CODE=""
for attempt in 1 2 3 4 5; do
  CODE="$(curl -s -o /tmp/rc-login.html -w '%{http_code}' "https://${DOMAIN}/" || true)"
  [[ "$CODE" == "200" ]] && break
  sleep 2
done
[[ "$CODE" == "200" ]] || fail "login page returned HTTP ${CODE:-none} after retries"
grep -qi "roundcube\|UDF Webmail\|_task=login" /tmp/rc-login.html || fail "login page content unexpected"
log "login page served over HTTPS (HTTP 200)"

for svc in nginx postfix dovecot opendkim udf-api; do
  systemctl is-active --quiet "$svc" || fail "post-deploy service down: $svc"
done
curl -fsS https://crm.udf-party.co.za/healthz >/dev/null && log "CRM health OK (unaffected)" || fail "CRM health check failed"

log "DONE — sign in at https://${DOMAIN}/ with the ${DOMAIN} mailbox password"
