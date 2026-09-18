# UDF Production Deploy Runbook

Target: single Ubuntu 22.04 VM at **`102.68.98.129`**, served over **HTTPS by IP
with a self-signed certificate**. This box **also runs a live mail stack**
(postfix / dovecot / opendkim) and nginx on :80/:443 — every step below is
written to **avoid disrupting mail**.

> **Status: PLAN + SCRIPTS ONLY.** Nothing in `deploy/` touches the server until
> you run it. Read this end-to-end first.

---

## 0. Architecture

```
                 Internet
                    │  443 (TLS, self-signed)
              ┌─────▼─────┐
              │   nginx   │  serves static frontend  → /var/www/udf/frontend (out/)
              │ (existing)│  proxies /api, /healthz   → 127.0.0.1:4000
              └─────┬─────┘  (mail vhosts UNTOUCHED)
                    │  loopback only
              ┌─────▼──────────────┐        ┌────────────────────────┐
              │ udf-api (systemd)  │───────▶│ PostgreSQL + PostGIS   │
              │ node dist/index.js │  5432  │ db "udf", role "udf"   │
              │ User=udf, hardened │        └────────────────────────┘
              └────────────────────┘
   /etc/udf: udf-api.env (config) · secrets.env (KEK+blind index) · jwt_*.pem · tls/
```

- **Backend** binds `127.0.0.1:4000` — never exposed directly; nginx proxies it.
- **Frontend** is a Next.js **static export** (`out/`) built **off-box** (the VM's
  ~1 GB RAM cannot build Next safely) and served as plain files.
- Web app is **same-origin** with `/api` → no CORS needed for browsers. The
  **Android** app (WebView origin `http://localhost`) is cross-origin → CORS +
  a bundled trust anchor are required (see §9).

---

## 1. Prerequisites & safety

- SSH access as `root` (or sudo). **Confirm you can still SSH before/after every
  firewall-adjacent step** — ufw currently restricts SSH to a specific admin IP.
  These scripts **do not touch ufw**.
- Outbound internet on the VM (apt, npm registry, and — unless you ship a geo
  snapshot — the City of Cape Town ArcGIS endpoint).
- ~2 GB free disk (Node, PostgreSQL, deps). A 1 GB **swap file is created** by
  provisioning to protect the low-RAM box.
- **Back up the mail config** before starting (cheap insurance):
  `sudo tar czf /root/pre-udf-backup.tgz /etc/nginx /etc/postfix /etc/dovecot`

**Credential hygiene**
- The scripts read secrets from the environment / `/etc/udf` — **never hardcode
  or commit them**. `deploy/production.env.example` contains placeholders only.
- After deploy, **rotate the VM root password** and **switch to SSH-key auth**
  (the password was shared in plaintext during planning).

---

## 2. Confirm the super-admin identity (before seeding)

The bootstrap seed needs an email + password. Two values from planning looked
ambiguous — **confirm them before you seed**:
- Email TLD: `…@gmail.co` vs `…@gmail.com`.
- Password: the provided string appeared truncated.

Provide them **inline at seed time** (not in a file). See §7.

---

## 3. Build artifacts (OFF-BOX — your machine)

```bash
cd /path/to/UDF
# Web served by nginx on the same origin → relative /api is correct:
API_BASE=/api bash deploy/scripts/build-offbox.sh
# Optional: also snapshot local geo so the server needs no ArcGIS access:
#   DUMP_GEO=1 API_BASE=/api bash deploy/scripts/build-offbox.sh
```

Produces `deploy/.artifacts/`:
- `udf-backend.tar.gz` — compiled `dist/` (+ `dist/db/migrations/*.sql`),
  `package.json`, and a **backend-only `package-lock.json`**.
- `udf-frontend.tar.gz` — the static `out/`.
- `regions_data.sql` *(only with `DUMP_GEO=1`)*.

---

## 4. Ship to the server (OFF-BOX)

```bash
SERVER=root@102.68.98.129 bash deploy/scripts/ship.sh
```

Stages everything under **`/root/udf-deploy/`** (scripts, nginx, systemd, env
template, this runbook, artifacts). Uses `scp`+`tar` only. **Executes nothing.**

---

## 5. Provision + secrets + cert (ON SERVER)

```bash
ssh root@102.68.98.129
cd /root/udf-deploy

# 5.1 Node 20, PostgreSQL+PostGIS, swap, udf user, dirs. Does NOT touch nginx/ufw/mail.
sudo bash scripts/provision-server.sh

# 5.2 RS256 JWT key pair + LOCAL_KEK/BLIND_INDEX_KEY (→ /etc/udf/secrets.env). Values never printed.
sudo bash scripts/gen-secrets.sh

# 5.3 Self-signed TLS cert for the IP (→ /etc/udf/tls/udf.{crt,key}, + udf-ca.pem for Android)
sudo bash scripts/gen-self-signed-cert.sh 102.68.98.129
```

---

## 6. Configure the environment (ON SERVER)

```bash
sudo cp production.env.example /etc/udf/udf-api.env
sudo chown root:udf /etc/udf/udf-api.env && sudo chmod 640 /etc/udf/udf-api.env
sudo nano /etc/udf/udf-api.env
```

Set at minimum:
- `DATABASE_URL=postgres://udf:<STRONG_PASSWORD>@127.0.0.1:5432/udf`
  (avoid a single-quote `'` in the password — it is embedded in SQL by bootstrap).
- `CORS_ORIGINS=https://102.68.98.129,http://localhost`
- `PUBLIC_BASE_URL=https://102.68.98.129`
- `ENABLE_HSTS=false` (self-signed), `HOST=127.0.0.1`, `NODE_ENV=production`.
- `MAIL_FROM="UDF Party <no-reply@<YOUR_DOMAIN>>"` — **REQUIRED in production**
  (the API refuses to boot without it). **Keep the double quotes:** this file is
  read both by systemd `EnvironmentFile=` *and* by `set -a; . /etc/udf/udf-api.env`
  in the steps below. systemd tolerates a bare value, but the shell does not —
  unquoted, the spaces and `<>` abort sourcing with ``syntax error near
  unexpected token `newline'`` and every on-box `node` step fails. It is the
  From: identity for onboarding OTP + starter-pack mail (FR-Q) and **must be
  DKIM-aligned** with the box's opendkim domain — check which domains are
  actually signed with `cat /etc/opendkim/signing.table` — or receiving servers
  may reject/spam-folder it. A VPS placeholder hostname (`*.yourlocaldomain.com`)
  is signed locally but is not publicly resolvable, so mail from it will not be
  delivered; use a real domain with aligned SPF/DKIM/DMARC before onboarding real
  members. `SMTP_HOST`/`SMTP_PORT` default to the local postfix relay
  (`127.0.0.1:25`, no auth/TLS); only set the `SMTP_*`/`MAIL_RETURN_PATH` keys
  when using a remote relay.

`LOCAL_KEK` / `BLIND_INDEX_KEY` come from `/etc/udf/secrets.env` (already
generated) — leave them commented here. JWT keys are referenced by path
(`JWT_PRIVATE_KEY_PATH=/etc/udf/jwt_private.pem`, etc.).

---

## 7. Bootstrap the app + database (ON SERVER)

```bash
cd /root/udf-deploy
sudo DEPLOY_DIR=/root/udf-deploy bash scripts/bootstrap-server.sh
```

This: extracts artifacts → `npm ci --omit=dev` (backend runtime deps) → creates
the `udf` role/database + PostGIS → runs **migrations** → seeds **geo** (snapshot
if shipped, else ArcGIS) → extracts the frontend → fixes ownership.

**Seed the super-admin** (creds inline, never stored):
```bash
cd /opt/udf/backend
sudo bash -c 'set -a; . /etc/udf/udf-api.env; . /etc/udf/secrets.env; set +a; \
  SUPERADMIN_EMAIL="confirmed@email.com" \
  SUPERADMIN_PASSWORD="the-confirmed-strong-password" \
  SUPERADMIN_NAME="Carl Marks" \
  node dist/db/seedAdmin.js'
```
The seed is idempotent, pre-accepts the T&C (so the admin is never gated by it),
and prints **no secret**. Re-running only re-asserts role/active/T&C.

**Forced password change (first login).** The seed always sets
`users.must_change_password = TRUE`, because the bootstrap password is
operator-supplied (known/shared) and must be rotated to a private one. On the
admin's first sign-in the app shows a mandatory **Choose a new password** gate
*ahead of* the T&C gate, instead of the dashboard; it cannot be skipped.
Submitting calls `POST /api/auth/change-password`, which verifies the current
password, **bumps `token_version` and revokes every other refresh token** (so any
other session still holding the shared password is logged out), returns a fresh
token pair, and clears the flag. The login response mirrors the flag as
`mustChangePassword`. A wrong current password is a `400 invalid_current_password`
(not a `401`, so it never trips the client's silent-refresh retry). Like the T&C
gate this is enforced client-side; the `change-password` endpoint is the security
boundary. Re-running `seed:admin` re-arms the gate (useful after a redeploy).

**Member onboarding (FR-P/FR-Q).** A member who registers through the app is
auto-provisioned a `users` row (`role=member`, `must_change_password=TRUE`,
`member_id` bound) and emailed a **starter pack**: a one-time 6-digit **OTP** plus
their ward councillor's bio/photo, the mini-manifesto, and the party leader. The
member signs in with their **email + the OTP as the password**, is forced to
choose a real password (`POST /api/auth/change-password`, which clears the flag
and activates a `pending` membership), and only then reaches the app. With no
`MAIL_FROM` set the mail is captured to the `email_outbox` table instead of sent
(dev fallback), so nothing crashes without SMTP.

**Backfill pre-Phase-B members (one-time).** Members who joined *before*
onboarding have no `users` row and cannot sign in. After the migration, provision
them (dry-run first to see the count; it never emails unless you pass `--send`,
so a backfill cannot trigger a mass starter-pack blast — backfilled members use
"Resend OTP" on the login screen instead):
```bash
cd /opt/udf/backend
sudo bash -c 'set -a; . /etc/udf/udf-api.env; . /etc/udf/secrets.env; set +a; \
  node dist/db/provisionMembers.js'            # dry run: count members lacking a login
sudo bash -c 'set -a; . /etc/udf/udf-api.env; . /etc/udf/secrets.env; set +a; \
  node dist/db/provisionMembers.js --force'    # provision accounts (no email)
```
On a **fresh** production DB there are no pre-existing members, so this is a
no-op; it matters only when the box already holds seeded/test members.

---

## 8. Start the API (ON SERVER)

```bash
sudo cp /root/udf-deploy/systemd/udf-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now udf-api
systemctl status udf-api --no-pager
curl -s http://127.0.0.1:4000/healthz     # expect {"status":"ok","db":true}
journalctl -u udf-api -n 50 --no-pager    # confirm "🚀 API server listening" + jwt:"RS256"
```

If the service fails with **EPERM**, a native module tripped the syscall filter:
edit the unit and comment out `SystemCallFilter` / `SystemCallErrorNumber`, then
`sudo systemctl daemon-reload && sudo systemctl restart udf-api`.

---

## 9. Enable nginx (ON SERVER) — **mail-safe, do last**

⚠ **Pre-flight (mandatory):** this VM's nginx already serves mail endpoints.
```bash
sudo nginx -T | grep -nE "listen|server_name|default_server"   # map existing vhosts
```
- Requests to `https://<IP>` send **no SNI** (RFC 6066 forbids IP literals in the
  SNI extension, and Chromium/Android WebView honour it) → nginx completes the
  handshake on the **:443 `default_server`** and only *then* picks the vhost from
  the `Host` header. So the certificate an IP-literal client sees is the
  **default block's**, not the `udf` vhost's.
- On this box the panel-created `block-direct-ip.conf` owns `default_server` on
  :80 and :443 (`server_name _` + `return 444`). **UDF now depends on its
  certificate lines**: it must present `/etc/udf/tls/udf.crt` (SAN
  `IP Address:102.68.98.129`), otherwise clients get
  `CN=vm478jzwg.yourlocaldomain.com` — untrusted *and* a hostname mismatch. A
  human can click through that in a browser; an Android WebView cannot, and
  **bundling a trust anchor in the APK does not help, because no anchor can fix a
  name mismatch.** The tracked copy is `deploy/nginx/block-direct-ip.conf`;
  install it per its header (`cp` → `nginx -t` → `systemctl reload nginx`).
  Leave `return 444` in place — unknown Hosts must still be dropped — and leave
  the mail vhost alone (it is matched by SNI/Host, never by default).
- Do **not** steal `default_server` for the `udf` vhost to work around this:
  that would answer unknown-Host requests with UDF content instead of dropping
  them, losing the panel's hardening for no benefit.
- If a real domain is ever pointed at this IP, add it to the `udf` vhost's
  `server_name` and issue a proper certificate for it; the IP path above stays
  working either way.

```bash
sudo cp /root/udf-deploy/nginx/udf.conf /etc/nginx/sites-available/udf
sudo ln -s /etc/nginx/sites-available/udf /etc/nginx/sites-enabled/udf
sudo nginx -t                       # MUST pass
sudo systemctl reload nginx         # reload (NOT restart) to keep mail connections
```

Verify (accept the self-signed warning in a browser):
```bash
curl -sk https://127.0.0.1/healthz                 # {"status":"ok","db":true}
curl -skI https://127.0.0.1/ | head -1             # HTTP/2 200
# The cert a NO-SNI client (i.e. the APK) actually receives — must be UDF's:
echo | openssl s_client -connect 102.68.98.129:443 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
# Strict validation against the anchor the APK bundles. NOTE: curl has no
# `%{ssl_verify}` write-out variable (it errors "unknown --write-out variable").
# The proof is that this succeeds WITHOUT -k: on a trust or hostname mismatch
# curl aborts instead of printing 200.
curl -s -o /dev/null -w '%{http_code}\n' \
  --cacert frontend/android-overrides/udf_tls_ca.pem https://102.68.98.129/healthz
# Belt and braces — the bundled anchor, the server's key material, and the cert
# actually served to a no-SNI client must all be the SAME certificate:
openssl x509 -in frontend/android-overrides/udf_tls_ca.pem -noout -fingerprint -sha256
ssh root@102.68.98.129 'openssl x509 -in /etc/udf/tls/udf-ca.pem -noout -fingerprint -sha256'
echo | openssl s_client -connect 102.68.98.129:443 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
# Mail still healthy:
sudo systemctl is-active postfix dovecot opendkim
```

---

## 10. Android app against the self-signed origin

An APK must (a) call the **absolute** API base and (b) **trust the self-signed
cert**. Both are now wired through the tracked overrides — the only per-build
input is `NEXT_PUBLIC_API_BASE`:

```bash
cd frontend
# debug APK against production (what was shipped for device testing):
NEXT_PUBLIC_API_BASE=https://102.68.98.129/api npm run apk
```

1. `npm run apk` = `build:mobile` (`NEXT_EXPORT=1 next build`, bakes the API base
   into the static bundle) → `cap:sync` → `android:assets` → `assembleDebug`.
2. `frontend/scripts/prepare-android-assets.mjs` copies
   `android-overrides/udf_tls_ca.pem` into `app/src/main/res/raw/` **and**
   `app/src/release/res/raw/`, plus both network security configs. A missing PEM
   **aborts the build** — Gradle would otherwise produce an APK that silently
   fails every request to the origin.
3. Both configs carry an active `<domain-config>` for `102.68.98.129`
   (`cleartextTrafficPermitted="false"`, anchors `@raw/udf_tls_ca` + `system`).
   The debug base-config still allows cleartext so a local `10.0.2.2` backend
   works; the domain rule is more specific and is unaffected by it.
4. For a **release** APK: create `frontend/android/keystore.properties` (from the
   `.example`) + keystore, then `cd frontend/android && ./gradlew assembleRelease`.
   Unsigned release builds are not installable, so don't ship one.
5. **After any certificate re-issue** (or an IP change), refresh the anchor and
   rebuild — a stale PEM fails hostname/trust validation at login:
   ```bash
   scp root@102.68.98.129:/etc/udf/tls/udf-ca.pem \
     frontend/android-overrides/udf_tls_ca.pem
   ```
   Verify from the dev machine before building (see §9): `curl --cacert
   frontend/android-overrides/udf_tls_ca.pem https://102.68.98.129/healthz` must
   return `200` **without** `-k` — succeeding at all is the proof, because curl
   aborts on a trust or hostname mismatch. (There is no `%{ssl_verify}` write-out
   variable, so do not try to assert on one.) If that fails, the problem is
   server-side (default_server cert — §9), not in the APK.

> **Gradle needs JDK 17.** The Android Gradle Plugin refuses older JVMs
> ("requires Java 17 … currently using Java 11"). Point `JAVA_HOME` at a 17 JDK
> first — on macOS/brew:
> `export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
> (Android Studio's bundled JBR, 17+, also works). CI pins Temurin 17.

> **Native hardening is durable across `cap add`.** The UDF security
> customizations (FLAG_SECURE `MainActivity`, manifest permissions, the
> debug/release `network_security_config`, the `udf_tls_ca.pem` trust anchor,
> release signing/minify in `build.gradle`, ProGuard keep rules,
> `keystore.properties.example`) are tracked in `frontend/android-overrides/` and
> re-applied automatically by `frontend/scripts/prepare-android-assets.mjs`,
> which CI runs right after `cap add`. The generated `frontend/android/` tree is
> git-ignored, so **never edit it directly** — change the override instead. On a
> Capacitor major upgrade, diff the overrides against a fresh `cap add` output
> before rebuilding.

### Verifying an APK on the emulator when FLAG_SECURE blocks screenshots

`MainActivity` sets `FLAG_SECURE`, so `adb exec-out screencap -p` yields a black
frame **by design** — that is the hardening working, not a broken build. Read the
WebView's real content from the accessibility tree instead (unaffected by
`FLAG_SECURE`):

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/ui.xml
grep -o 'text="[^"]*"' /tmp/ui.xml | sort -u        # what is actually on screen
```

Driving the UI blind is fine because every tap target's `bounds="[x1,y1][x2,y2]"`
is in that dump:
```bash
adb shell input tap 640 1842        # e.g. the "Sign in" button
adb shell input text "WrongPass123" # into the focused field
```

**End-to-end TLS proof without real credentials:** submit a deliberately wrong
password. If the card shows the server's own message — `Invalid credentials`
(`ApiError.unauthorized` in `backend/src/modules/auth/service.ts`) — then DNS,
routing, the TLS handshake against the bundled anchor, and the JSON round trip
all worked. A trust failure instead surfaces as a generic client-side error plus
`net::ERR_CERT_*` / `SSLHandshakeException` in `adb logcat`:
```bash
adb logcat -d | grep -iE "ERR_CERT|SSLHandshake|TrustAnchor|net::ERR"   # must stay empty
adb shell cat /proc/net/tcp6 | awk '$4=="01"'   # remote …81624466:01BB = 102.68.98.129:443 ESTABLISHED
```

### Local debug build + on-device test (no server required)

A **debug** APK can talk to a backend on your dev machine via the emulator's
host alias (`10.0.2.2` → host loopback). The debug `network_security_config`
permits cleartext HTTP, so no certificate is needed:

```bash
cd frontend
NEXT_PUBLIC_API_BASE=http://10.0.2.2:4000/api npm run apk   # build:mobile + cap:sync + android:assets + assembleDebug
"$HOME/Library/Android/sdk/emulator/emulator" -avd Pixel_9_Pro &   # or plug in a device
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.udf.party/.MainActivity
adb shell dumpsys window windows | grep -i secure   # MainActivity must show SECURE
```

**Phase 8 status:** the debug APK is built, installed, and verified on the
`Pixel_9_Pro` AVD — `SECURE` window flag set, `screencap` redacted, backend
reachable (established TCP to `:4000`), WebView loads the bundled export, no JS
or network errors. Interactive checks that need a human plus seeded
member/councillor data (permission prompts, report-with-media, supporter share,
ban lockout) remain manual. The **release** APK against the self-signed server
origin (steps 1–4) still awaits the production deploy, which is plan-only until
you approve.

---

## 11. Verification checklist

- [ ] `systemctl is-active udf-api` → `active`; logs show `jwt:"RS256"`.
- [ ] `curl -sk https://<IP>/healthz` → `{"status":"ok","db":true}`.
- [ ] Browser loads the app at `https://<IP>/` (after accepting the cert warning).
- [ ] Super-admin can log in at `/login`, is **not** shown the T&C gate, and
      **is** shown the forced **Choose a new password** gate; after setting a
      private password the dashboard loads (and re-running `seed:admin` re-arms it).
- [ ] `/terms`, `/register`, `/crm/moderation` render (nginx SPA fallback works).
- [ ] A `/v/<code>` and `/confirm/<token>` link resolve (nginx edge rewrites).
- [ ] Map shows Cape Town wards (geo seeded): check `regions` row count > 0.
- [ ] Mail unaffected: `postfix`/`dovecot`/`opendkim` active; webmail still loads.
- [ ] Onboarding mail flows: register a test member → a starter-pack row lands in
      `email_outbox` with `status='sent'` (or is delivered via postfix), and the
      member can sign in with **email + OTP** then is forced to change password.

---

## 12. Known gaps / follow-ups

- **Outbound email is now implemented (FR-Q).** `src/security/mailer.ts` is a
  dependency-free SMTP client that relays through the box's local postfix
  (`127.0.0.1:25`, DKIM-signed by opendkim) and records every message in
  `email_outbox`; with no `MAIL_FROM` it captures instead of sending (dev). The
  older `resident_report_outbox` / `job_relay_outbox` dev transports are
  unchanged. `MAIL_FROM` now uses `no-reply@udf-party.co.za`; SPF, DKIM and
  DMARC are published and verified. Keep that mail identity unchanged during
  the CRM hostname cutover.
- **Certificate / HSTS.** Production is served on `https://102.68.98.129` with a
  self-signed cert and `ENABLE_HSTS=false`. §15 cuts over to
  `https://crm.udf-party.co.za` with a Let's Encrypt cert and flips HSTS on; the
  legacy IP path is kept alive for existing debug APKs.
- **Single small VM** shared with mail. Monitor memory; consider moving the DB or
  app to its own host if load grows. `MemoryMax=512M` caps the API.

---

## 13. Operations

**Backups** (add to cron):
```bash
# Database. NOTE: redirect as root — `pg_dump -f /root/...` run as the postgres
# user fails with "Permission denied", since postgres cannot write into /root.
sudo -u postgres pg_dump -Fc udf > /root/backups/udf-$(date +%F).dump
pg_restore -l /root/backups/udf-$(date +%F).dump >/dev/null && echo "dump readable"
# Key material (JWT private key + KEK + blind index) — losing these is fatal:
sudo tar czf /root/backups/udf-etc-$(date +%F).tgz -C /etc udf
```
Store backups **off-box** and encrypted. Test a restore periodically.

**Logs:** `journalctl -u udf-api -f`  ·  nginx: `/var/log/nginx/{access,error}.log`

**Update deploy** (new code):
```bash
# off-box:  API_BASE=/api bash deploy/scripts/build-offbox.sh && SERVER=root@<IP> bash deploy/scripts/ship.sh
# on-box — take the §13 Backups dump FIRST, then:
sudo tar xzf /root/udf-deploy/artifacts/udf-backend.tar.gz -C /opt/udf
cd /opt/udf/backend && sudo npm ci --omit=dev
# Migrations need the config: env.ts fail-fasts (process.exit) on missing keys and
# `sudo` drops the environment, so source BOTH files inside the sudo shell.
sudo bash -c 'set -a; . /etc/udf/udf-api.env; . /etc/udf/secrets.env; set +a; \
  cd /opt/udf/backend && node dist/db/migrate.js'
# Ownership is NOT preserved: the tarball is built off-box (macOS uid 501).
sudo chown -R udf:udf /opt/udf/backend
sudo systemctl restart udf-api
sudo rm -rf /var/www/udf/frontend && sudo install -d /var/www/udf/frontend \
  && sudo tar xzf /root/udf-deploy/artifacts/udf-frontend.tar.gz -C /var/www/udf/frontend
sudo chown -R root:udf /var/www/udf/frontend
sudo find /var/www/udf/frontend -type d -exec chmod 755 {} +
sudo find /var/www/udf/frontend -type f -exec chmod 644 {} +
```

⚠ **If the release adds a newly *required* env var, set it BEFORE extracting.**
FR-Q's `MAIL_FROM` is the worked example: the already-running process keeps
serving happily from memory after `dist` is replaced, so a missing key surfaces
only at `systemctl restart` — and because the unit is `Restart=always`, a failed
boot becomes a crash loop rather than a clean failure. Extract → migrate →
restart therefore opens a window in which any unrelated crash takes the API down
permanently. `migrate.js` imports the same `env.ts`, so it aborts before touching
the database — which is the cheap early warning. Dry-run the gate first:
```bash
sudo bash -c 'set -a; . /etc/udf/udf-api.env; . /etc/udf/secrets.env; set +a; \
  cd /opt/udf/backend && node -e "require(\"./dist/config/env.js\"); console.log(\"env OK\")"'
```
Harmless noise when extracting macOS-built tarballs on Linux:
`tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'`.
Extracting over `/opt/udf` preserves `node_modules` (much faster on the 1 GB
box) but leaves behind files deleted upstream; `sudo rm -rf /opt/udf/backend`
first if you want a guaranteed-clean tree.

**Rollback (API):** keep the previous `udf-backend.tar.gz`; re-extract + `npm ci`
+ `systemctl restart udf-api`. Migrations are additive/idempotent; a DB rollback
requires restoring the `pg_dump`.

---

## 14. File map (this kit)

```
deploy/
  production.env.example        backend prod env template (placeholders only)
  RUNBOOK.md                    this file
  nginx/udf.conf                static frontend + /api proxy + edge rewrites (mail-safe)
  nginx/udf-manifesto.conf      public manifesto site vhost (apex :443 + www redirect)
  systemd/udf-api.service       hardened unit (User=udf, loopback, sandboxed)
  scripts/
    build-offbox.sh             OFF-BOX: build backend dist + frontend out/ + bundle
    ship.sh                     OFF-BOX: scp+tar the kit+artifacts to /root/udf-deploy
    provision-server.sh         ON-BOX: Node20, PostgreSQL+PostGIS, swap, udf user, dirs
    gen-secrets.sh              ON-BOX: RS256 keypair + secrets.env (KEK, blind index)
    gen-self-signed-cert.sh     ON-BOX: TLS cert for the IP (+ Android trust anchor)
    bootstrap-server.sh         ON-BOX: extract, npm ci, db, migrate, geo, super-admin
```

---

## 15. Domain cutover — `crm.udf-party.co.za`

Moves the public origin from `https://102.68.98.129` (self-signed) to
`https://crm.udf-party.co.za` (Let's Encrypt), while **keeping the legacy IP path
alive** for existing debug APKs. The IP path is preserved by
`block-direct-ip.conf` on the `:443` `default_server`, which continues to serve
`/etc/udf/tls/udf.crt` (SAN `IP Address:102.68.98.129`) to no-SNI clients.

Do **not** run any of this until DNS has propagated and you have taken the §13
backups. Every nginx action is a `reload`, never a `restart` — this box serves
live mail.

### 15.1 DNS (registrar)

```
A     crm.udf-party.co.za       102.68.98.129     TTL 300
TXT   udf-party.co.za           "v=spf1 ip4:102.68.98.129 -all"
TXT   _dmarc.udf-party.co.za    "v=DMARC1; p=none; rua=mailto:postmaster@udf-party.co.za"
TXT   <selector>._domainkey.udf-party.co.za    (published in 15.5)
PTR   102.68.98.129             mail.udf-party.co.za   (set at the VPS provider, not in DNS)
```

Verify:
```bash
dig +short crm.udf-party.co.za             # 102.68.98.129
dig +short TXT udf-party.co.za             # SPF present
```

### 15.2 Pre-flight — confirm nothing else owns the domain

```bash
ssh root@102.68.98.129
sudo nginx -T | grep -nE "server_name|listen .* default_server"
sudo nginx -T | grep -n "udf-party" || echo "no existing vhost — safe to proceed"
```

If the panel already has a stub vhost for the domain, disable it first
(`rm /etc/nginx/sites-enabled/<name> && sudo nginx -t && sudo systemctl reload nginx`).

### 15.3 Stage the ACME webroot, then issue the cert

First, from your dev machine, ship the updated kit (the tracked `udf.conf` and
`production.env.example` now carry the domain):
```bash
SERVER=root@102.68.98.129 bash deploy/scripts/ship.sh
```

The tracked `nginx/udf.conf` now has an `:80` vhost with
`server_name crm.udf-party.co.za 102.68.98.129` and a
`location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }`.
Install it **before** requesting the cert so HTTP-01 has somewhere to land.
During the initial cutover the LE cert does not yet exist, so the tracked
`ssl_certificate` path would fail `nginx -t` — swap in the self-signed lines
that are commented right below them, then flip after 15.4.

```bash
sudo install -d -m 755 /var/www/letsencrypt
sudo cp /root/udf-deploy/nginx/udf.conf /etc/nginx/sites-available/udf
# One-time bootstrap: point the :443 vhost at the existing self-signed cert so
# nginx -t passes before LE has issued anything.
sudo sed -i \
  -e 's|^    ssl_certificate     /etc/letsencrypt/live/crm.udf-party.co.za/fullchain.pem;|    ssl_certificate     /etc/udf/tls/udf.crt;|' \
  -e 's|^    ssl_certificate_key /etc/letsencrypt/live/crm.udf-party.co.za/privkey.pem;|    ssl_certificate_key /etc/udf/tls/udf.key;|' \
  /etc/nginx/sites-available/udf
sudo nginx -t && sudo systemctl reload nginx

# Issue. --webroot, NOT --nginx: certbot's nginx plugin rewrites vhosts and
# would collide with the panel's block-direct-ip.conf and the mail vhost.
sudo apt install -y certbot
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d crm.udf-party.co.za \
  --agree-tos -m postmaster@udf-party.co.za --non-interactive --keep-until-expiring
```

The certificate intentionally covers the CRM hostname only. The public website
and mail host remain separate virtual hosts.

### 15.4 Flip the vhost to the LE cert

```bash
sudo cp /root/udf-deploy/nginx/udf.conf /etc/nginx/sites-available/udf   # tracked version already points at LE
sudo nginx -t && sudo systemctl reload nginx

# Publicly trusted handshake for SNI-routed clients — MUST succeed without -k:
curl -sI https://crm.udf-party.co.za/healthz | head -1    # HTTP/2 200 or HTTP/1.1 200
echo | openssl s_client -servername crm.udf-party.co.za -connect 102.68.98.129:443 2>/dev/null \
  | openssl x509 -noout -issuer -subject -text
#   issuer  = C=US, O=Let's Encrypt (or similar)
#   subject = CN=crm.udf-party.co.za; SAN includes DNS:crm.udf-party.co.za

# Legacy IP path still on the self-signed cert (unchanged):
echo | openssl s_client -connect 102.68.98.129:443 2>/dev/null \
  | openssl x509 -noout -subject -text
#   subject = CN=102.68.98.129, SAN: IP Address:102.68.98.129
```

Confirm auto-renewal is armed:
```bash
sudo systemctl list-timers certbot.timer --no-pager
sudo certbot renew --dry-run
```

### 15.5 Flip the application origin; keep the verified mail identity

SPF, DKIM (`udf2026`) and DMARC for `udf-party.co.za` are already published and
verified. Keep `MAIL_FROM="UDF Party <no-reply@udf-party.co.za>"` unchanged and
confirm the signing key before the API restart:

```bash
sudo opendkim-testkey -d udf-party.co.za -s udf2026 -vvv
sudo cp /etc/udf/udf-api.env /root/backups/udf-api.env.pre-domain-$(date +%F-%H%M%S)
sudo nano /etc/udf/udf-api.env
```

Set (per the updated `production.env.example`):
```
CORS_ORIGINS=https://crm.udf-party.co.za,https://102.68.98.129,http://localhost
PUBLIC_BASE_URL=https://crm.udf-party.co.za
ENABLE_HSTS=true
MAIL_FROM="UDF Party <no-reply@udf-party.co.za>"
```

Dry-run the env gate (RUNBOOK §13 lesson) **before** restarting, then restart:
```bash
sudo bash -c 'set -a; . /etc/udf/udf-api.env; . /etc/udf/secrets.env; set +a; \
  cd /opt/udf/backend && node -e "require(\"./dist/config/env.js\"); console.log(\"env OK\")"'
sudo systemctl restart udf-api
systemctl status udf-api --no-pager
curl -s https://crm.udf-party.co.za/healthz      # {"status":"ok","db":true}
```

Send-test the new From address end-to-end:
```bash
# Register a throwaway member from the app; the starter-pack must arrive and
# pass SPF/DKIM/DMARC. Check headers on the receiving side for
#   Authentication-Results: ... spf=pass dkim=pass dmarc=pass
# Locally you can also confirm the mail left the box:
sudo postqueue -p                                 # must be empty
sudo tail -50 /var/log/mail.log | grep -E "udf-party|opendkim"
```

### 15.6 Rebuild the APK against the domain

Let's Encrypt is in the Android system trust store. New APKs use system trust
only and no longer bundle the self-signed IP anchor. Existing fielded APKs keep
their already-bundled anchor while the legacy IP vhost remains available.

```bash
cd frontend
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
NEXT_PUBLIC_API_BASE=https://crm.udf-party.co.za/api npm run apk
```

Bundle-level proof (no device attached):
```bash
unzip -p android/app/build/outputs/apk/debug/app-debug.apk \
  assets/public/_next/static/chunks/*.js 2>/dev/null \
  | grep -oE "https://[a-z0-9.-]+/api" | sort -u
#   expect exactly: https://crm.udf-party.co.za/api
```

### 15.7 Verification checklist

- [ ] `dig +short crm.udf-party.co.za` → `102.68.98.129`.
- [ ] `curl -sI https://crm.udf-party.co.za/healthz` → `200` **without** `-k`.
- [ ] Cert served for SNI=`crm.udf-party.co.za` is Let's Encrypt (issuer check above).
- [ ] Cert served for no-SNI (IP literal) is still `CN=102.68.98.129` — APK path intact.
- [ ] `curl -sI http://crm.udf-party.co.za/` → `301` to `https://crm.udf-party.co.za/`.
- [ ] `sudo certbot renew --dry-run` succeeds.
- [ ] `/etc/udf/udf-api.env` has `PUBLIC_BASE_URL=https://crm.udf-party.co.za`,
      `ENABLE_HSTS=true`, and `MAIL_FROM="UDF Party <no-reply@udf-party.co.za>"`
      (double quotes present).
- [ ] `systemctl is-active udf-api postfix dovecot opendkim nginx` → all `active`.
- [ ] `opendkim-testkey -d udf-party.co.za -s udf2026 -vvv` → `key OK`.
- [ ] Starter-pack mail to an external inbox shows `spf=pass dkim=pass dmarc=pass`
      and lands in the primary tab (not spam).
- [ ] QR / invite links generated after the cutover start with
      `https://crm.udf-party.co.za/v/...` (spot-check via `email_outbox` rows).
- [ ] Existing debug APKs pinned to `https://102.68.98.129/api` still authenticate.

---

## 16. Public manifesto site — `udf-party.co.za` (apex)

The 4-page static election-manifesto site (workspace `website/`: `index.html`,
`housing-infrastructure.html`, `safety-communities.html`, `economy-governance.html`
+ `assets/`) is served on the **apex domain** with a dedicated vhost, separate
from the CRM on `crm.udf-party.co.za`.

Layout on the box:

- Webroot: `/var/www/udf/manifesto` (rsynced from `website/`, plain static files).
- Vhost: `/etc/nginx/sites-available/udf-manifesto` (tracked:
  `deploy/nginx/udf-manifesto.conf`), symlinked into `sites-enabled/`.
  `:443` only — apex serves the site, `www.udf-party.co.za` 301s to the apex.
- Cert: Let's Encrypt `/etc/letsencrypt/live/udf-party.co.za/`
  (SANs `udf-party.co.za` + `www.udf-party.co.za`), renewed by `certbot.timer`.
- `:80` for apex/www stays owned by `udf-acme.conf` (ACME webroot responder +
  301 to https). **Never** duplicate those `server_name`s on `:80` in the
  manifesto vhost — it would steal the challenge path and break renewals.
- No `default_server` here: `block-direct-ip.conf` keeps the `:80`/`:443`
  defaults, and the mail vhost (`vm478jzwg.conf`) keeps resolving by SNI/Host.

### 16.1 Deploy / update the site (OFF-BOX → ON-BOX)

```bash
# 1. Ship the static files (idempotent):
rsync -az -e 'ssh -o BatchMode=yes' website/ root@102.68.98.129:/var/www/udf/manifesto/

# 2. Only if the vhost template changed — sync config, test, reload (never restart):
scp deploy/nginx/udf-manifesto.conf root@102.68.98.129:/etc/nginx/sites-available/udf-manifesto
ssh root@102.68.98.129 'nginx -t && systemctl reload nginx'
```

First-time cert issue (already done 2026-09-16; repeat only if the cert is lost):

```bash
ssh root@102.68.98.129 'certbot certonly --webroot -w /var/www/letsencrypt \
  -d udf-party.co.za -d www.udf-party.co.za -n --agree-tos \
  --email jnefdt7@gmail.com --no-eff-email'
# then install the vhost (nginx -t fails until the cert exists) and reload
```

### 16.2 Verification checklist

- [ ] `curl -sI https://udf-party.co.za/` → `200`, with `strict-transport-security`,
      `x-content-type-options: nosniff`, `x-frame-options: DENY`.
- [ ] `curl -sI https://www.udf-party.co.za/` → `301` → `https://udf-party.co.za/`.
- [ ] `curl -sI http://udf-party.co.za/` → `301` → `https://udf-party.co.za/`.
- [ ] `openssl s_client -connect 102.68.98.129:443 -servername udf-party.co.za`
      → subject `CN=udf-party.co.za`, issuer Let's Encrypt.
- [ ] All four pages + `assets/css/style.css` + both images → `200`;
      unknown path → `404` (no SPA fallback by design).
- [ ] Regressions: `https://crm.udf-party.co.za/healthz` → `200`; webmail vhost
      and the legacy no-SNI IP path unchanged.
- [ ] `certbot certificates` lists both `crm.udf-party.co.za` and `udf-party.co.za`.

