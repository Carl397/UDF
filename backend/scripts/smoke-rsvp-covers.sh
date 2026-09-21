#!/usr/bin/env bash
# Local runtime smoke for the three features added in this workstream:
#   A. DB-unique member email (migration 039 + 409 on duplicate signup)
#   B. Cover images on events + ward bulletins (migration 040, upload/serve/delete)
#   C. Named, login-required, one-per-member RSVP + organiser-scoped attendee list (041)
# Runs against the live backend on :4000. Safe to delete.
set -uo pipefail
API=http://localhost:4000/api
WARD=NORTH-W09   # events.ward / members.ward store the full ward region code
DBURL="$(grep -m1 '^DATABASE_URL' .env | cut -d= -f2-)"
PASS=0; FAIL=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ✅ $1 ($3)"; PASS=$((PASS+1));
  else echo "  ❌ $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi
}
login() { curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"ChangeMe!12345\"}" | jq -r '.token // .accessToken // empty'; }
# POST a JSON body, print the HTTP status code, leave the body in $2 (file).
post() { local url="$1" tok="$2" json="$3" out="${4:-/tmp/udf-last-body}";
  curl -s -o "$out" -w "%{http_code}" -X POST "$url" \
    ${tok:+-H "Authorization: Bearer $tok"} -H 'Content-Type: application/json' -d "$json"; }
get() { local url="$1" tok="${2:-}" out="${3:-/tmp/udf-last-body}";
  curl -s -o "$out" -w "%{http_code}" "$url" ${tok:+-H "Authorization: Bearer $tok"}; }
del() { curl -s -o /tmp/udf-last-body -w "%{http_code}" -X DELETE "$1" -H "Authorization: Bearer $2"; }
sq() { psql "$DBURL" -P pager=off -Atc "$1"; }
# 'yes' when the status is 200/201, else 'no (<code>)'.
wrote() { if [ "$1" = 200 ] || [ "$1" = 201 ]; then echo yes; else echo "no ($1)"; fi; }

# 1x1 transparent PNG as a base64 data URL.
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

regjson() { jq -nc --arg n "$1" --arg e "$2" '
  {fullName:$n, email:$e, tier:"voter", regionCode:"NORTH", ward:"9", tcAccepted:true,
   consent:{emailOptin:true, smsOptin:false, phoneOptin:false, dataShare:false}}'; }

echo "== A. unique member email =="
EMAIL="smoke-dup-$(date +%s)@udf.example"
A1=$(post "$API/public/register" "" "$(regjson "Smoke Dup" "$EMAIL")")
chk "fresh signup → 201" "201" "$A1"
A2=$(post "$API/public/register" "" "$(regjson "Smoke Dup" "$EMAIL")")
chk "same email again → 409" "409" "$A2"
jq -r '.error.message // .message // .' /tmp/udf-last-body | sed 's/^/    message: /'
# Race: the same brand-new email twice, concurrently. Both requests can pass the
# app-level pre-check, so only the DB unique index can keep the row singular.
E1="smoke-race-$(date +%s)@udf.example"
RB1=$(regjson "Race One" "$E1"); RB2=$(regjson "Race Two" "$E1")
( post "$API/public/register" "" "$RB1" > /tmp/udf-race-a; echo >> /tmp/udf-race-a ) &
( post "$API/public/register" "" "$RB2" > /tmp/udf-race-b; echo >> /tmp/udf-race-b ) & wait
RACEMIX=$(cat /tmp/udf-race-a /tmp/udf-race-b | sort | tr -d '\n')
chk "concurrent same email → one 201 + one 409" "201409" "$RACEMIX"
chk "partial unique index exists" "1" "$(sq "select count(*) from pg_indexes where indexname='members_email_bidx_live_unique'")"
chk "no live duplicate email left in DB" "0" "$(sq "select count(*) from (select email_bidx from members where email_bidx is not null and deleted_at is null group by email_bidx having count(*) > 1) d")"

echo
echo "== C. named RSVP =="
MEM=$(login member.ward9@udf.example)
ORG=$(login regional.organizer@udf.example)
chk "member token" "yes" "$([ -n "$MEM" ] && echo yes || echo no)"
chk "organiser token" "yes" "$([ -n "$ORG" ] && echo yes || echo no)"
post "$API/events" "$ORG" "$(jq -nc --arg t "Smoke RSVP $(date +%s)" --arg w "$WARD" '{title:$t, kind:"meeting", startsAt:"2026-10-30T15:00:00.000Z", ward:$w, capacity:2}')" /tmp/udf-ev >/dev/null
EVID=$(jq -r '.id // empty' /tmp/udf-ev)
chk "event created" "yes" "$([ -n "$EVID" ] && echo yes || echo no)"
[ -z "$EVID" ] && jq -c . /tmp/udf-ev

chk "anonymous RSVP → 401" "401" "$(post "$API/events/$EVID/rsvp" "" '{}')"
C=$(post "$API/events/$EVID/rsvp" "$MEM" '{"response":"going"}')
chk "member RSVP" "200" "$C"
chk "RSVP count = 1" "1" "$(jq -r '.rsvpCount' /tmp/udf-last-body)"
post "$API/events/$EVID/rsvp" "$MEM" '{"response":"going"}' >/dev/null
chk "repeat RSVP idempotent (still 1)" "1" "$(jq -r '.rsvpCount' /tmp/udf-last-body)"
chk "one row per member" "1" "$(sq "select count(*) from event_rsvps where event_id='$EVID'")"
get "$API/events/$EVID" "$MEM" >/dev/null
chk "detail marks caller going" "true" "$(jq -r '.going' /tmp/udf-last-body)"
get "$API/events/$EVID" "" >/dev/null
chk "detail anonymous not going" "false" "$(jq -r '.going' /tmp/udf-last-body)"
post "$API/events/$EVID/rsvp" "$MEM" '{"response":"interested"}' >/dev/null
chk "going→interested frees slot" "0" "$(jq -r '.rsvpCount' /tmp/udf-last-body)"
post "$API/events/$EVID/rsvp" "$MEM" '{"response":"going"}' >/dev/null
chk "interested→going re-takes slot" "1" "$(jq -r '.rsvpCount' /tmp/udf-last-body)"

echo "== attendees visibility =="
AC=$(get "$API/events/$EVID/attendees" "$ORG")
chk "organiser GET attendees" "200" "$AC"
jq -c '{total, first:(.items[0]|{name,membershipNo,ward,response})}' /tmp/udf-last-body | sed 's/^/    /'
chk "attendee named" "yes" "$(jq -r 'if (.items[0].name|type)=="string" and (.items[0].name|length)>0 then "yes" else "no" end' /tmp/udf-last-body)"
# membershipNo/ward are surfaced when the RSVP'ing account is a linked member
# (users.member_id). Seeded staff/member logins here are not linked, so the
# fields are legitimately null — assert the keys are always present.
chk "attendee row exposes membershipNo+ward keys" "yes" "$(jq -r 'if (.items[0]|has("membershipNo")) and (.items[0]|has("ward")) then "yes" else "no" end' /tmp/udf-last-body)"
chk "member GET attendees → 403" "403" "$(get "$API/events/$EVID/attendees" "$MEM")"
chk "anonymous GET attendees → 401" "401" "$(get "$API/events/$EVID/attendees" "")"
chk "attendees read audited" "yes" "$(sq "select case when count(*)>0 then 'yes' else 'no' end from audit_log where action='event.attendees.read' and target_id='$EVID'")"

chk "cancel RSVP" "200" "$(del "$API/events/$EVID/rsvp" "$MEM")"
chk "cancel leaves count 0" "0" "$(jq -r '.rsvpCount' /tmp/udf-last-body)"
chk "row removed on cancel" "0" "$(sq "select count(*) from event_rsvps where event_id='$EVID'")"

echo
echo "== B. cover images =="
UP=$(post "$API/events/$EVID/cover" "$ORG" "$(jq -nc --arg d "$PNG" '{dataUrl:$d}')")
chk "event cover upload" "yes" "$(wrote "$UP")"
get "$API/events/$EVID" "" >/dev/null
chk "event hasCover true" "true" "$(jq -r '.hasCover' /tmp/udf-last-body)"
chk "public GET event cover" "200" "$(get "$API/events/$EVID/cover" "" /tmp/udf-smoke-cover.png)"
chk "cover content-type" "image/png" "$(curl -s -o /dev/null -w '%{content_type}' "$API/events/$EVID/cover")"
chk "cover bytes > 0" "yes" "$([ "$(wc -c < /tmp/udf-smoke-cover.png | tr -d ' ')" -gt 0 ] && echo yes || echo no)"
chk "Range request served" "yes" "$(
  R=$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-' "$API/events/$EVID/cover")
  { [ "$R" = "200" ] || [ "$R" = "206" ]; } && echo yes || echo "no ($R)")"
post "$API/events" "$ORG" "$(jq -nc --arg t "Smoke NoCover $(date +%s)" --arg w "$WARD" '{title:$t, kind:"meeting", startsAt:"2026-10-30T15:00:00.000Z", ward:$w}')" /tmp/udf-ev2 >/dev/null
NCID=$(jq -r '.id' /tmp/udf-ev2)
chk "missing cover → 404" "404" "$(get "$API/events/$NCID/cover" "")"
chk "anon cover upload → 401" "401" "$(post "$API/events/$EVID/cover" "" "$(jq -nc --arg d "$PNG" '{dataUrl:$d}')")"
chk "member cover upload → 403" "403" "$(post "$API/events/$EVID/cover" "$MEM" "$(jq -nc --arg d "$PNG" '{dataUrl:$d}')")"
chk "event cover delete" "200" "$(del "$API/events/$EVID/cover" "$ORG")"
get "$API/events/$EVID" "" >/dev/null
chk "event hasCover false after delete" "false" "$(jq -r '.hasCover' /tmp/udf-last-body)"

ADMIN=$(login national.admin@udf.example)
BLT=$(post "$API/ward-bulletins" "$ADMIN" "$(jq -nc --arg t "Smoke cover $(date +%s)" --arg w "$WARD" '{kind:"news", title:$t, body:"Cover smoke test body.", wardCode:$w}')" /tmp/udf-bl)
BLID=$(jq -r '.id // empty' /tmp/udf-bl)
chk "bulletin created" "201" "$BLT"
if [ -n "$BLID" ]; then
  BC=$(post "$API/ward-bulletins/$BLID/cover" "$ADMIN" "$(jq -nc --arg d "$PNG" '{dataUrl:$d}')")
  chk "bulletin cover upload" "yes" "$(wrote "$BC")"
  get "$API/ward-bulletins/$BLID" "$ADMIN" >/dev/null
  chk "bulletin hasCover true" "true" "$(jq -r '.hasCover' /tmp/udf-last-body)"
  chk "published bulletin cover public" "200" "$(get "$API/ward-bulletins/$BLID/cover" "" /tmp/udf-bl-cover.png)"
  chk "bulletin cover delete" "200" "$(del "$API/ward-bulletins/$BLID/cover" "$ADMIN")"
  get "$API/ward-bulletins/$BLID" "$ADMIN" >/dev/null
  chk "bulletin hasCover false after delete" "false" "$(jq -r '.hasCover' /tmp/udf-last-body)"
else
  jq -c . /tmp/udf-bl
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
