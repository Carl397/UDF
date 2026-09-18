#!/usr/bin/env bash
# Phase 4 smoke test: T&C acceptance + ban/suspend ladder + device ban + immediate lockout.
# Runs against the live backend on :4000. Mirrors smoke-reports.sh conventions.
set -uo pipefail
API=http://localhost:4000/api
PW='ChangeMe!12345'
PASS=0; FAIL=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ✅ $1 ($3)"; PASS=$((PASS+1));
  else echo "  ❌ $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi
}
login() { curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$PW\"}"; }
tok()  { echo "$1" | jq -r '.accessToken // empty'; }
code() { echo "$1" | jq -r '.error.code // empty'; }
act()  { curl -s -X POST "$API/moderation/actions" -H "Authorization: Bearer $ATOK" \
  -H 'Content-Type: application/json' -d "$1"; }

# Reset the target member to a pristine state so the run is idempotent.
# Accepting terms is a one-way stamp, so without this the "tcAccepted initially
# false" assertion fails on every re-run after the first. Uses psql + the
# DATABASE_URL from backend/.env; skipped gracefully if either is unavailable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_URL="$(grep -E '^DATABASE_URL=' "$SCRIPT_DIR/../.env" 2>/dev/null | head -1 | cut -d= -f2-)"
reset_member() { # reset_member <user-id>
  [ -n "${1:-}" ] && [ -n "$DB_URL" ] && command -v psql >/dev/null 2>&1 || return 0
  psql "$DB_URL" -P pager=off -tAc "UPDATE users SET tc_version=NULL, tc_accepted_at=NULL, moderation_status='active', is_active=true, suspended_until=NULL WHERE id='$1'" >/dev/null 2>&1 || true
}

echo "== setup =="
ADMIN=$(login admin@party.example); ATOK=$(tok "$ADMIN")
chk "admin token present" yes "$([ -n "$ATOK" ] && echo yes || echo no)"
MID=$(curl -s "$API/moderation/users?search=member.ward9@udf.example" -H "Authorization: Bearer $ATOK" | jq -r '.items[0].id // empty')
chk "member found in moderation queue" yes "$([ -n "$MID" ] && echo yes || echo no)"
reset_member "$MID"

echo "== T&C acceptance =="
MEM=$(login member.ward9@udf.example); MTOK=$(tok "$MEM")
chk "login tcAccepted initially false" false "$(echo "$MEM" | jq -r '.tcAccepted')"
ACC=$(curl -s -w "\n%{http_code}" -X POST "$API/auth/terms/accept" -H "Authorization: Bearer $MTOK")
chk "POST /auth/terms/accept → 200" 200 "$(echo "$ACC" | tail -1)"
MEM2=$(login member.ward9@udf.example); MTOK=$(tok "$MEM2")
chk "re-login tcAccepted true" true "$(echo "$MEM2" | jq -r '.tcAccepted')"

echo "== moderation profile =="
PROF=$(curl -s -w "\n%{http_code}" "$API/moderation/users/$MID" -H "Authorization: Bearer $ATOK")
chk "GET profile → 200" 200 "$(echo "$PROF" | tail -1)"
chk "profile records accepted version" "1.0.0" "$(echo "$PROF" | head -1 | jq -r '.user.tcVersion')"

echo "== warn =="
W=$(act "{\"userId\":\"$MID\",\"action\":\"warn\",\"reason\":\"Smoke test warning\"}")
chk "warn → moderationStatus warned" warned "$(echo "$W" | jq -r '.moderationStatus')"

echo "== suspend + immediate lockout =="
S=$(act "{\"userId\":\"$MID\",\"action\":\"suspend\",\"reason\":\"Smoke test suspension\",\"durationDays\":1}")
chk "suspend → moderationStatus suspended" suspended "$(echo "$S" | jq -r '.moderationStatus')"
LOCK=$(curl -s -o /dev/null -w "%{http_code}" "$API/transparency/reports?scope=mine" -H "Authorization: Bearer $MTOK")
chk "suspended user's live access token rejected → 401" 401 "$LOCK"
SL=$(login member.ward9@udf.example)
chk "suspended login → 403 account_suspended" account_suspended "$(code "$SL")"

echo "== reinstate =="
R=$(act "{\"userId\":\"$MID\",\"action\":\"reinstate\",\"reason\":\"Smoke test reinstate\"}")
chk "reinstate → moderationStatus active" active "$(echo "$R" | jq -r '.moderationStatus')"
RL=$(login member.ward9@udf.example); MTOK=$(tok "$RL")
chk "reinstated login works" yes "$([ -n "$MTOK" ] && echo yes || echo no)"

echo "== ban + immediate lockout =="
B=$(act "{\"userId\":\"$MID\",\"action\":\"ban\",\"reason\":\"Smoke test ban\"}")
chk "ban → moderationStatus banned" banned "$(echo "$B" | jq -r '.moderationStatus')"
chk "ban → isActive false" false "$(echo "$B" | jq -r '.isActive')"
LOCK2=$(curl -s -o /dev/null -w "%{http_code}" "$API/transparency/reports?scope=mine" -H "Authorization: Bearer $MTOK")
chk "banned user's live access token rejected → 401" 401 "$LOCK2"
BL=$(login member.ward9@udf.example)
chk "banned login → 403 account_banned" account_banned "$(code "$BL")"
R2=$(act "{\"userId\":\"$MID\",\"action\":\"reinstate\",\"reason\":\"Smoke test cleanup\"}")
chk "final reinstate → active" active "$(echo "$R2" | jq -r '.moderationStatus')"

echo "== device ban =="
DID="smoke-device-$$"
DL=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -H "x-device-id: $DID" \
  -d "{\"email\":\"member.ward9@udf.example\",\"password\":\"$PW\"}")
chk "device login pre-ban works" yes "$([ -n "$(tok "$DL")" ] && echo yes || echo no)"
DB=$(act "{\"deviceId\":\"$DID\",\"action\":\"device_ban\",\"reason\":\"Smoke test device ban\"}")
chk "device_ban recorded" device_ban "$(echo "$DB" | jq -r '.action')"
DL2=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -H "x-device-id: $DID" \
  -d "{\"email\":\"member.ward9@udf.example\",\"password\":\"$PW\"}")
chk "banned device login → 403 device_banned" device_banned "$(code "$DL2")"
REG=$(curl -s -X POST "$API/public/register" -H 'Content-Type: application/json' -H "x-device-id: $DID" \
  -d "{\"fullName\":\"Smoke Tester\",\"email\":\"smoke.$$@udf.example\",\"regionCode\":\"NORTH\",\"tcAccepted\":true}")
chk "banned device register → 403 device_banned" device_banned "$(code "$REG")"
DEVL=$(curl -s "$API/moderation/devices" -H "Authorization: Bearer $ATOK" | jq -r --arg d "$DID" '[.items[]|select(.deviceId==$d)]|length')
chk "device appears in banned register" 1 "$DEVL"
DU=$(act "{\"deviceId\":\"$DID\",\"action\":\"device_unban\",\"reason\":\"Smoke test cleanup\"}")
chk "device_unban recorded" device_unban "$(echo "$DU" | jq -r '.action')"
DL3=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -H "x-device-id: $DID" \
  -d "{\"email\":\"member.ward9@udf.example\",\"password\":\"$PW\"}")
chk "unbanned device login works" yes "$([ -n "$(tok "$DL3")" ] && echo yes || echo no)"

echo "== validation & authorization =="
BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/moderation/actions" -H "Authorization: Bearer $ATOK" \
  -H 'Content-Type: application/json' -d "{\"userId\":\"$MID\",\"action\":\"suspend\",\"reason\":\"missing duration\"}")
chk "suspend without durationDays → 400" 400 "$BAD"
# Reuse the member token from the device section rather than logging in again —
# the login limiter is 20/15min per IP, and a fresh login here is the one most
# likely to trip it on a back-to-back re-run.
MTOK2=$(tok "$DL3")
FORB=$(curl -s -o /dev/null -w "%{http_code}" "$API/moderation/users" -H "Authorization: Bearer $MTOK2")
chk "member cannot access moderation → 403" 403 "$FORB"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
