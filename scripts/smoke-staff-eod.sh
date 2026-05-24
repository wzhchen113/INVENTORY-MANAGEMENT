#!/usr/bin/env bash
# scripts/smoke-staff-eod.sh — Spec 061 / C3 cross-repo smoke for the
# per-user-JWT staff EOD path.
#
# End-to-end test: signs in as the seed manager@local.test user, calls
# public.staff_submit_eod() RPC over PostgREST with the staff user's
# access_token as the Bearer, asserts a clean 200 + valid submission_id,
# replays the same client_uuid for idempotency, and exercises the
# negative case (out-of-membership store rejected by the new
# auth_can_see_store gate in the RPC body). Also smokes the deprecated
# edge functions return HTTP 410.
#
# Why a real per-user JWT: spec 061 GRANTed staff_submit_eod to
# `authenticated` (not service_role) and added a server-side
# auth_can_see_store(p_store_id) gate that needs a real auth.uid()
# claim to evaluate. A service-role caller would now hit a REVOKE'd
# EXECUTE; this smoke proves the new contract works from the staff
# user's actual auth surface.
#
# Mirrors the shape of scripts/smoke-rpc.sh — same env-var fallbacks,
# same PASS/FAIL output convention, non-zero exit on first failure.
#
# Usage:
#   bash scripts/smoke-staff-eod.sh                # default: local stack
#   SUPABASE_URL=https://...                       # remote override
#   SUPABASE_ANON_KEY=...                          # remote override
#   STAFF_TOKEN=...                                # skip login round-trip
#   STAFF_EMAIL=manager@local.test                 # override
#   STAFF_PASSWORD=password                        # override
#   STORE_ID=<uuid>                                # override the
#                                                  # in-membership store
#                                                  # (default: Frederick)
#   NON_MEMBER_STORE_ID=<uuid>                     # override the
#                                                  # negative-case store
#                                                  # (default: Charles)
#
# Troubleshooting: if this script returns 503 or "function source not
# found" on the edge function smoke (step 9), it's the same edge-
# runtime bind-mount class of issue as smoke-edge.sh. See CLAUDE.md
# "Local edge runtime bind-mount captures CWD at boot" — running
# `npx supabase stop --no-backup && npm run dev:db` from the repo
# root fixes it.
#
# Exit code: non-zero on first failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"

# Local publishable/anon API key. Stable across `supabase start`s on
# the same project_id. (`supabase status` prints the current values.)
# Safe to commit — this is the public key.
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH}"

STAFF_EMAIL="${STAFF_EMAIL:-manager@local.test}"
STAFF_PASSWORD="${STAFF_PASSWORD:-password}"
STAFF_TOKEN="${STAFF_TOKEN:-}"

# Default in-membership store: Frederick (manager has user_stores row
# for it per supabase/seed.sql:200). Default out-of-membership store:
# Charles (no user_stores row for the manager).
STORE_ID="${STORE_ID:-0f240390-edda-4b25-8c72-45eeb2ce1988}"
NON_MEMBER_STORE_ID="${NON_MEMBER_STORE_ID:-1ea549bb-8b50-4078-9301-479311d9fdec}"

FAILED=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step() { printf '\n== %s ==\n' "$1"; }

################################################################################
# 0. Acquire a staff access_token (unless caller passed one)
################################################################################
if [[ -z "${STAFF_TOKEN}" ]]; then
  step "login as ${STAFF_EMAIL}"
  LOGIN=$(curl -sS -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${STAFF_EMAIL}\",\"password\":\"${STAFF_PASSWORD}\"}" \
    "${SUPABASE_URL}/auth/v1/token?grant_type=password")
  STAFF_TOKEN=$(printf '%s' "$LOGIN" | jq -r '.access_token // empty' 2>/dev/null || echo "")
  if [[ -z "${STAFF_TOKEN}" ]]; then
    fail "could not acquire staff access_token (login response: ${LOGIN:0:300})"
    printf '\n\033[31m✗ smoke-staff-eod failed at login\033[0m\n'
    exit 1
  fi
  pass "got staff access_token (${#STAFF_TOKEN} chars)"
fi

################################################################################
# 1. Discover a vendor from the seed
################################################################################
step "discover a vendor via PostgREST"
VENDOR_ID=$(curl -sS \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  "${SUPABASE_URL}/rest/v1/vendors?select=id&limit=1" \
  | jq -r '.[0].id // empty' 2>/dev/null || echo "")

if [[ -z "${VENDOR_ID}" || "${VENDOR_ID}" == "null" ]]; then
  fail "could not discover a vendor — staff user may lack SELECT on vendors"
  printf '\n\033[31m✗ smoke-staff-eod failed at vendor discovery\033[0m\n'
  exit 1
fi
pass "vendor_id=${VENDOR_ID}"

################################################################################
# 2. Discover an inventory_item at STORE_ID
################################################################################
step "discover an inventory_item at store ${STORE_ID}"
ITEM_ID=$(curl -sS \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  "${SUPABASE_URL}/rest/v1/inventory_items?store_id=eq.${STORE_ID}&select=id&limit=1" \
  | jq -r '.[0].id // empty' 2>/dev/null || echo "")

if [[ -z "${ITEM_ID}" || "${ITEM_ID}" == "null" ]]; then
  fail "could not discover an inventory_item at ${STORE_ID} — store may be empty or staff lacks SELECT"
  printf '\n\033[31m✗ smoke-staff-eod failed at item discovery\033[0m\n'
  exit 1
fi
pass "inventory_items.id=${ITEM_ID}"

################################################################################
# 3. Discover a Charles item for the negative case (uses postgres role
#    via SQL? — no, just need ANY uuid; the negative case fails at the
#    membership gate BEFORE the item is dereferenced, so any uuid works).
#    Use a syntactic uuid placeholder — the membership gate refuses
#    before item lookup runs. (Reuse Frederick item to keep payload
#    well-formed; the RPC gate fires on p_store_id, not p_ingredient_id.)
################################################################################
NEG_ITEM_ID="${ITEM_ID}"

################################################################################
# 4. Generate a client_uuid
################################################################################
CLIENT_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
# Derive the test date deterministically from CLIENT_UUID so the
# (store_id, date, vendor_id) triple is unique each run. Without this,
# `ON CONFLICT (store_id, date, vendor_id) DO UPDATE` would preserve
# the original `client_uuid` from a previous same-day run, and the
# row-visibility check below would fail looking for a `client_uuid`
# that never made it into the table. Historical date range (~3-27
# years ago) means no collision with real prod data either.
UUID_HEX=${CLIENT_UUID//-/}
UUID_NUM=$((16#${UUID_HEX:0:6}))   # 24 bits = 0 .. 16M-1
DAY_OFFSET=$((UUID_NUM % 9000 + 1000))  # ~3 to ~27 years ago
if date -v-1d +%Y-%m-%d >/dev/null 2>&1; then
  # BSD/macOS date
  TODAY=$(date -v-${DAY_OFFSET}d +%Y-%m-%d)
else
  # GNU/Linux date
  TODAY=$(date -d "${DAY_OFFSET} days ago" +%Y-%m-%d)
fi

################################################################################
# 5. First call to staff_submit_eod — assert HTTP 200 + submission_id
################################################################################
step "POST /rpc/staff_submit_eod (first call, expect 200 + conflict=false)"
RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"p_client_uuid\": \"${CLIENT_UUID}\",
    \"p_store_id\": \"${STORE_ID}\",
    \"p_date\": \"${TODAY}\",
    \"p_submitted_by\": null,
    \"p_status\": \"submitted\",
    \"p_entries\": [{\"ingredient_id\": \"${ITEM_ID}\", \"actual_remaining\": 10}],
    \"p_vendor_id\": \"${VENDOR_ID}\"
  }" \
  "${SUPABASE_URL}/rest/v1/rpc/staff_submit_eod")

CODE=$(printf '%s' "$RESPONSE" | tail -1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$CODE" != "200" ]]; then
  fail "POST /rpc/staff_submit_eod returned ${CODE} (expected 200). Body: ${BODY:0:300}"
  printf '\n\033[31m✗ smoke-staff-eod failed\033[0m\n'
  exit 1
fi
pass "first call returns 200"

SUBMISSION_ID=$(printf '%s' "$BODY" | jq -r '.submission_id // empty' 2>/dev/null || echo "")
CONFLICT_FLAG=$(printf '%s' "$BODY" | jq -r '.conflict // false' 2>/dev/null || echo "parse-error")

if [[ -z "${SUBMISSION_ID}" ]]; then
  fail "response missing submission_id: ${BODY:0:300}"
else
  pass "response has submission_id=${SUBMISSION_ID}"
fi

if [[ "$CONFLICT_FLAG" != "false" ]]; then
  fail "first call returned conflict=${CONFLICT_FLAG} (expected false): ${BODY:0:300}"
else
  pass "first call returned conflict=false"
fi

################################################################################
# 6. Confirm the eod_submissions row exists, visible via the staff JWT
################################################################################
step "GET /eod_submissions?client_uuid=eq.${CLIENT_UUID} (verify row visible)"
ROW=$(curl -sS \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  "${SUPABASE_URL}/rest/v1/eod_submissions?store_id=eq.${STORE_ID}&client_uuid=eq.${CLIENT_UUID}&select=id,store_id,submitted_by")

ROW_COUNT=$(printf '%s' "$ROW" | jq 'length' 2>/dev/null || echo "parse-error")
if [[ "$ROW_COUNT" != "1" ]]; then
  fail "expected exactly 1 row at client_uuid=${CLIENT_UUID}, got: ${ROW:0:300}"
else
  pass "exactly 1 eod_submissions row at client_uuid=${CLIENT_UUID}"
fi

# Spec 061 spoof-proofing check: submitted_by must be the staff user id
# (server-derived from auth.uid() via the trigger), not null. Hard-coded
# manager_id from supabase/seed.sql:79.
ROW_SUBMITTED_BY=$(printf '%s' "$ROW" | jq -r '.[0].submitted_by // empty' 2>/dev/null || echo "")
if [[ "$ROW_SUBMITTED_BY" == "22222222-2222-2222-2222-222222222222" ]]; then
  pass "row.submitted_by is auth.uid() (staff user, not caller-supplied null)"
else
  fail "row.submitted_by was '${ROW_SUBMITTED_BY}' (expected '22222222-2222-2222-2222-222222222222')"
fi

################################################################################
# 7. Replay with same client_uuid — assert 200 + conflict=true + same id
################################################################################
step "POST /rpc/staff_submit_eod (replay, expect 200 + conflict=true)"
RESPONSE2=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"p_client_uuid\": \"${CLIENT_UUID}\",
    \"p_store_id\": \"${STORE_ID}\",
    \"p_date\": \"${TODAY}\",
    \"p_submitted_by\": null,
    \"p_status\": \"submitted\",
    \"p_entries\": [{\"ingredient_id\": \"${ITEM_ID}\", \"actual_remaining\": 12}],
    \"p_vendor_id\": \"${VENDOR_ID}\"
  }" \
  "${SUPABASE_URL}/rest/v1/rpc/staff_submit_eod")

CODE2=$(printf '%s' "$RESPONSE2" | tail -1)
BODY2=$(printf '%s' "$RESPONSE2" | sed '$d')

if [[ "$CODE2" != "200" ]]; then
  fail "replay returned ${CODE2} (expected 200). Body: ${BODY2:0:300}"
else
  pass "replay returns 200"
fi

REPLAY_CONFLICT=$(printf '%s' "$BODY2" | jq -r '.conflict // false' 2>/dev/null || echo "parse-error")
REPLAY_SUB_ID=$(printf '%s' "$BODY2" | jq -r '.submission_id // empty' 2>/dev/null || echo "")

if [[ "$REPLAY_CONFLICT" != "true" ]]; then
  fail "replay returned conflict=${REPLAY_CONFLICT} (expected true): ${BODY2:0:300}"
else
  pass "replay returned conflict=true (idempotency dedup worked)"
fi

if [[ "$REPLAY_SUB_ID" != "$SUBMISSION_ID" ]]; then
  fail "replay submission_id (${REPLAY_SUB_ID}) does not match first call (${SUBMISSION_ID})"
else
  pass "replay submission_id matches first call's"
fi

################################################################################
# 8. Out-of-membership store negative case (Charles)
################################################################################
step "POST /rpc/staff_submit_eod with non-membership store (expect non-200)"
NEG_CLIENT_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
RESPONSE3=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"p_client_uuid\": \"${NEG_CLIENT_UUID}\",
    \"p_store_id\": \"${NON_MEMBER_STORE_ID}\",
    \"p_date\": \"${TODAY}\",
    \"p_submitted_by\": null,
    \"p_status\": \"submitted\",
    \"p_entries\": [{\"ingredient_id\": \"${NEG_ITEM_ID}\", \"actual_remaining\": 5}],
    \"p_vendor_id\": \"${VENDOR_ID}\"
  }" \
  "${SUPABASE_URL}/rest/v1/rpc/staff_submit_eod")

CODE3=$(printf '%s' "$RESPONSE3" | tail -1)
BODY3=$(printf '%s' "$RESPONSE3" | sed '$d')

# PostgREST maps SQLSTATE 42501 to HTTP 403 by default. Accept any
# non-200 as a pass — the exact mapping isn't load-bearing, only that
# the membership gate refused before the row landed.
if [[ "$CODE3" == "200" ]]; then
  fail "non-membership store call should NOT have returned 200: body=${BODY3:0:300}"
else
  pass "non-membership store call returns ${CODE3} (auth_can_see_store gate fired)"
fi

# Defense in depth: confirm no row landed at the non-membership store.
NEG_ROW_COUNT=$(curl -sS \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  "${SUPABASE_URL}/rest/v1/eod_submissions?client_uuid=eq.${NEG_CLIENT_UUID}&select=id" \
  | jq 'length' 2>/dev/null || echo "parse-error")

# Note: a staff user CANNOT see rows in a non-membership store via RLS,
# so this is checking from their POV. If a row HAD landed it'd be
# invisible from this call too; the real check is that CODE3 != 200.
if [[ "$NEG_ROW_COUNT" == "0" ]]; then
  pass "no eod_submissions row at NEG_CLIENT_UUID (from staff POV)"
else
  fail "unexpected NEG_ROW_COUNT=${NEG_ROW_COUNT} (parse error or row leaked through)"
fi

################################################################################
# 9. Edge function deprecation smoke (A3 verification) — three functions
#    return HTTP 410 with the spec-061 reference body.
################################################################################
step "deprecated edge functions return 410"
for fn in staff-eod-submit staff-catalog staff-waste-log; do
  case "$fn" in
    staff-catalog) METHOD=GET; PAYLOAD="";;
    *)             METHOD=POST; PAYLOAD="-d {}";;
  esac
  RESPONSE_FN=$(curl -sS -w '\n%{http_code}' -X "$METHOD" \
    -H "Content-Type: application/json" \
    ${PAYLOAD} \
    "${SUPABASE_URL}/functions/v1/${fn}")
  CODE_FN=$(printf '%s' "$RESPONSE_FN" | tail -1)
  BODY_FN=$(printf '%s' "$RESPONSE_FN" | sed '$d')

  if [[ "$CODE_FN" != "410" ]]; then
    fail "/functions/v1/${fn} returned ${CODE_FN} (expected 410). Body: ${BODY_FN:0:200}"
  else
    pass "/functions/v1/${fn} returns 410"
  fi

  # Check the body mentions spec 061.
  if printf '%s' "$BODY_FN" | grep -q 'spec 061'; then
    pass "/functions/v1/${fn} body references spec 061"
  else
    fail "/functions/v1/${fn} body missing 'spec 061' reference: ${BODY_FN:0:200}"
  fi
done

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m✓ all checks passed\033[0m\n'
  exit 0
else
  printf '\033[31m✗ some checks failed\033[0m\n'
  exit 1
fi
