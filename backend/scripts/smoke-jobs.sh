#!/usr/bin/env bash
# PRD-jobs §9.2–9.4 smoke tests. Runs against the live backend on :4000.
set -uo pipefail
API=http://localhost:4000/api
PASS=0; FAIL=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ✅ $1 ($3)"; PASS=$((PASS+1));
  else echo "  ❌ $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi
}
login() { curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"ChangeMe!12345\"}" | jq -r '.token // .accessToken // empty'; }

echo "== login =="
MEM=$(login member.ward9@udf.example)
COU=$(login councillor.ward9@udf.example)
chk "member token present" "yes" "$([ -n "$MEM" ] && echo yes || echo no)"
chk "councillor token present" "yes" "$([ -n "$COU" ] && echo yes || echo no)"

echo "== FR-K: member interest =="
G=$(curl -s -w "\n%{http_code}" "$API/jobs/interest" -H "Authorization: Bearer $MEM")
chk "GET /interest (member)" "200" "$(echo "$G" | tail -1)"
echo "$G" | head -1 | jq -c '{email:.interest.email, workTypes:.interest.workTypes}'
P=$(curl -s -w "\n%{http_code}" -X PUT "$API/jobs/interest" -H "Authorization: Bearer $MEM" \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ward9","surname":"Resident","email":"member.ward9@udf.example","workTypes":["labourer","gardening","cleaning"],"experience":"Updated via smoke test."}')
chk "PUT /interest (member)" "200" "$(echo "$P" | tail -1)"
# PII tripwire: member must NOT be able to read aggregate demand.
DM=$(curl -s -o /dev/null -w "%{http_code}" "$API/jobs/demand?ward=NORTH-W09" -H "Authorization: Bearer $MEM")
chk "GET /demand as member is forbidden" "403" "$DM"

echo "== FR-L: councillor aggregate demand (PII tripwire) =="
CD=$(curl -s -w "\n%{http_code}" "$API/jobs/demand?ward=NORTH-W09" -H "Authorization: Bearer $COU")
chk "GET /demand (councillor)" "200" "$(echo "$CD" | tail -1)"
BODY=$(echo "$CD" | head -1)
echo "$BODY" | jq -c '{scope,total,availableNow,byWorkType:(.byWorkType|length),trend:(.trend|length)}'
# The demand payload must never contain personal fields.
for k in first_name firstName surname email; do
  if echo "$BODY" | grep -q "$k"; then echo "  ❌ PII LEAK: demand contains '$k'"; FAIL=$((FAIL+1));
  else echo "  ✅ no '$k' in demand"; PASS=$((PASS+1)); fi
done
# Scope tripwire: councillor may not read a ward outside their scope.
OUT=$(curl -s -o /dev/null -w "%{http_code}" "$API/jobs/demand?ward=CPT-W090" -H "Authorization: Bearer $COU")
chk "GET /demand out-of-scope ward forbidden" "403" "$OUT"

echo "== FR-M: councillor records + publishes an opportunity (relay) =="
CR=$(curl -s -w "\n%{http_code}" -X POST "$API/jobs/opportunities" -H "Authorization: Bearer $COU" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Smoke Test Labourers","company":"Test Co","workTypes":["labourer","cleaning"],"description":"curl smoke","contactEmail":"hr@testco.example","closesAt":"2026-12-31"}')
chk "POST /opportunities (councillor)" "201" "$(echo "$CR" | tail -1)"
OID=$(echo "$CR" | head -1 | jq -r '.opportunity.id')
REF=$(echo "$CR" | head -1 | jq -r '.opportunity.refNo')
echo "  → id=$OID ref=$REF"
# Contact tripwire: no company contact → 400.
NC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/jobs/opportunities" -H "Authorization: Bearer $COU" \
  -H 'Content-Type: application/json' -d '{"title":"No Contact","company":"X","workTypes":["labourer"]}')
chk "POST /opportunities without contact rejected" "400" "$NC"
PUB=$(curl -s -w "\n%{http_code}" -X POST "$API/jobs/opportunities/$OID/publish" -H "Authorization: Bearer $COU")
chk "POST /opportunities/:id/publish" "200" "$(echo "$PUB" | tail -1)"
echo "$PUB" | head -1 | jq -c '{status:.opportunity.status, stats:.opportunity.stats, dup:.duplicateWarning}'
MATCHED=$(echo "$PUB" | head -1 | jq -r '.opportunity.stats.matched')
chk "relay matched > 0" "yes" "$([ "$MATCHED" -gt 0 ] && echo yes || echo no)"

echo "== FR-K6: member sees published opportunity in own ward =="
MO=$(curl -s -w "\n%{http_code}" "$API/jobs/opportunities" -H "Authorization: Bearer $MEM")
chk "GET /opportunities (member)" "200" "$(echo "$MO" | tail -1)"
echo "$MO" | head -1 | jq -c '{count:(.items|length), anyStats:([.items[].stats]|map(select(.!=null))|length), refs:[.items[].refNo]}'
# Member list must not expose delivery stats.
HASSTATS=$(echo "$MO" | head -1 | jq '[.items[].stats]|map(select(.!=null))|length')
chk "member opportunity list hides stats" "0" "$HASSTATS"

echo "== FR-M: member notified (in-app) =="
NOT=$(curl -s "$API/notifications" -H "Authorization: Bearer $MEM" | jq -c '[.items[]?|select(.kind=="job")]|length')
echo "  job notifications for member: $NOT"

echo "== cleanup: close smoke-test opportunity =="
CL=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/jobs/opportunities/$OID/close" -H "Authorization: Bearer $COU")
chk "POST /opportunities/:id/close" "200" "$CL"
# Restore member interest to the seeded state.
curl -s -o /dev/null -X PUT "$API/jobs/interest" -H "Authorization: Bearer $MEM" \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ward9","surname":"Resident","email":"member.ward9@udf.example","workTypes":["labourer","gardening"],"experience":"Available for general labour and garden maintenance."}'

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
