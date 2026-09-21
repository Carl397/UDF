#!/usr/bin/env bash
# Local runtime smoke for this workstream's HTTP-facing behaviour:
#   1. Resident-report South-Africa gate (createResidentReportSchema bounds refine)
#      — an out-of-country point is rejected 400, a Cape Town point is accepted and
#      resolved to its ward (routing by location, not by the filer's own ward).
#   2. The public CMS read surface (GET /api/public/pages + /:slug).
# The CMS AUTHORING surface (create/edit/publish pages + blocks) is `content:manage`
# (superadmin-only) and is exercised in-transaction by workflow-regression.mjs, so
# it is not hit here. Runs against the live backend on :4000. Safe to delete.
set -uo pipefail
API=http://localhost:4000/api
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1 ($3)"; PASS=$((PASS+1));
  else echo "  ❌ $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
contains() { case "$3" in *"$2"*) echo "  ✅ $1"; PASS=$((PASS+1));; *) echo "  ❌ $1 — [$2] not in [$3]"; FAIL=$((FAIL+1));; esac; }
login() { curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"ChangeMe!12345\"}" | jq -r '.token // .accessToken // empty'; }
# POST a JSON body, print the HTTP status code, leave the body in the out file.
post() { local url="$1" tok="$2" json="$3" out="${4:-/tmp/udf-cms-body}";
  curl -s -o "$out" -w "%{http_code}" -X POST "$url" \
    ${tok:+-H "Authorization: Bearer $tok"} -H 'Content-Type: application/json' -d "$json"; }
get() { local url="$1" tok="${2:-}" out="${3:-/tmp/udf-cms-body}";
  curl -s -o "$out" -w "%{http_code}" "$url" ${tok:+-H "Authorization: Bearer $tok"}; }

MEM=$(login member.ward9@udf.example)
if [ -z "$MEM" ]; then echo "  ❌ member login failed — is the backend on :4000 up?"; exit 1; fi

echo "== 1. South-Africa resident-report gate =="
RIO=$(post "$API/transparency/reports" "$MEM" '{"category":"pothole","message":"SMOKE rio","lat":-22.9068,"lng":-43.1729}' /tmp/rio)
chk "out-of-country (Rio) → 400" "400" "$RIO"
contains "400 explains the SA restriction" "South Africa" "$(cat /tmp/rio)"

CT=$(post "$API/transparency/reports" "$MEM" '{"category":"pothole","message":"SMOKE capetown","lat":-33.9249,"lng":18.4241}' /tmp/ct)
chk "Cape Town point → 201" "201" "$CT"
CTWARD=$(jq -r '.wardCode // empty' /tmp/ct)
contains "Cape Town point resolved to a ward" "CPT-W" "$CTWARD"

# The filer still sees their own report under scope=mine (owner keeps updates).
MINE=$(get "$API/transparency/reports?scope=mine&limit=50" "$MEM" /tmp/mine)
chk "filer lists own reports (scope=mine) → 200" "200" "$MINE"
contains "the Cape Town report is in the filer's list" "$(jq -r '.id' /tmp/ct)" "$(cat /tmp/mine)"

echo "== 2. Public CMS pages read surface =="
PL=$(get "$API/public/pages" "" /tmp/pages)
chk "GET /public/pages → 200" "200" "$PL"
contains "page index is a { pages } object" "pages" "$(cat /tmp/pages)"
MISS=$(get "$API/public/pages/does-not-exist-$$" "" /tmp/miss)
chk "GET /public/pages/<unknown> → 404" "404" "$MISS"

echo
echo "smoke-cms-geo: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
