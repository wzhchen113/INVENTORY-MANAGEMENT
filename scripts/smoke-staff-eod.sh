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
# Spec 172 (step 8b): primes a linked item's on-hand to 7 with a numeric
# count, then submits a NO NEED entry for it and asserts 200, an empty
# stock_updates, current_stock unchanged (7 — not 0, not NULL), and the
# persisted row is no_need=true with NULL numerics. Like the rest of this
# smoke it is non-transactional: it leaves that item's local on-hand at 7.
#
# Spec 193 (step 8c, AC-11): staff_submit_eod now refuses a store member's
# p_date outside [A - 35, A + 1], A = today in America/New_York, with
# SQLSTATE 22023. Step 8c sends A - 36 and asserts HTTP 400 (not 403), the
# exact code and message, and that no row carries that call's client_uuid.
# It is the only track that proves the SQLSTATE -> HTTP mapping the shipped
# staff drain depends on. Every other submit now uses an in-window date
# (A - k, k in [3, 33]) picked from triples that are still free.
#
# LOCAL-ONLY (spec 193 §8): in-window dates pointed at a real project could
# replace a real count (step 8b also primes a real item's on-hand), so the
# script refuses any SUPABASE_URL that isn't exactly a loopback origin
# (http(s)://localhost, 127.0.0.1 or [::1], optional port, optional trailing
# slash, case-insensitive; no userinfo, path, query or fragment), before it
# fetches a token. There is no override flag on purpose. Rows it
# creates are deleted on exit (best effort, via docker exec psql on the local
# db container); audit_log / notifications rows and step 8b's on-hand of 7
# remain as local residue.
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
#   bash scripts/smoke-staff-eod.sh                # local stack only
#   SUPABASE_URL=http://127.0.0.1:<port>           # override (loopback origin
#                                                  # only: localhost,
#                                                  # 127.0.0.1 or [::1])
#   SUPABASE_ANON_KEY=...                          # override
#   STAFF_TOKEN=...                                # skip login round-trip
#   STAFF_EMAIL=manager@local.test                 # override
#   STAFF_PASSWORD=password                        # override
#   STORE_ID=<uuid>                                # override the
#                                                  # in-membership store
#                                                  # (default: Frederick)
#   NON_MEMBER_STORE_ID=<uuid>                     # override the
#                                                  # negative-case store
#                                                  # (default: Charles)
#   CONTAINER=supabase_db_imr-inventory            # db container used for
#                                                  # the exit cleanup
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

# Spec 193: local-only guard, BEFORE any login. No env flag overrides it.
# Allowlist the WHOLE URL (not an extracted host): anything beyond scheme,
# loopback host, optional port and optional trailing slash is refused, so
# userinfo / '#@' / '?@' tricks (http://evil.invalid#@127.0.0.1) can't pass.
LOCAL_URL_RE='^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/?$'
shopt -s nocasematch
if [[ "$SUPABASE_URL" =~ $LOCAL_URL_RE ]]; then SMOKE_URL_OK=1; else SMOKE_URL_OK=0; fi
shopt -u nocasematch
if [[ "$SMOKE_URL_OK" != "1" ]]; then
  printf '\033[31mREFUSED\033[0m: smoke-staff-eod.sh is local-only (SUPABASE_URL "%s" is not a loopback origin).\n' "$SUPABASE_URL" >&2
  printf 'Since spec 193 it writes in-window EOD dates, which against a real project could replace a real count.\n' >&2
  exit 2
fi

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

# Spec 193: best-effort cleanup of the rows this run created, so smoke rows
# don't use up the free in-window dates. Local by construction (the guard
# above), matching scripts/test-db.sh's container default. Step 8b's stored
# uuid is PRIME_UUID: the NO NEED call lands on the primed row and the
# upsert keeps the first uuid. Step 8c's OOW_UUID is tracked too: it should
# never write, but if the bound regresses it writes a real A - 36 row.
# eod_entries cascade.
CLIENT_UUID=""
PRIME_UUID=""
OOW_UUID=""
cleanup() {
  local ids=""
  for u in "${CLIENT_UUID}" "${PRIME_UUID}" "${OOW_UUID}"; do
    [[ -n "$u" ]] && ids="${ids:+${ids},}'${u}'"
  done
  [[ -z "$ids" ]] && return 0
  if ! docker exec "${CONTAINER:-supabase_db_imr-inventory}" psql -U postgres -d postgres -qAt \
       -c "delete from public.eod_submissions where client_uuid in (${ids})" >/dev/null 2>&1; then
    printf '  \033[33mWARN\033[0m cleanup could not delete this run'"'"'s eod_submissions rows (%s)\n' "$ids"
  fi
}
trap cleanup EXIT

# Spec 193: the staff window is anchored on the America/New_York date.
A_NY=$(TZ=America/New_York date +%Y-%m-%d)
ny_days_ago() {
  if date -v-1d +%Y-%m-%d >/dev/null 2>&1; then
    TZ=America/New_York date -v-"$1"d +%Y-%m-%d       # BSD/macOS date
  else
    TZ=America/New_York date -d "$1 days ago" +%Y-%m-%d  # GNU/Linux date
  fi
}

# First free in-window date for (STORE_ID, $1): candidates A - k, k in
# [3, 33], in an order seeded by $2 (a uuid). k >= 3 and <= 33 keep clear of
# today, yesterday and both bounds, so a run crossing New York midnight can't
# flip an outcome. A fresh triple matters: step 6 looks the row up by
# client_uuid, and the upsert keeps an older uuid on an existing row.
# Prints the date, or nothing if every candidate is taken.
pick_free_date() {
  local vendor="$1" seed_hex="${2//-/}" start i k d n
  start=$(( (16#${seed_hex:0:6}) % 31 ))
  for (( i = 0; i < 31; i++ )); do
    k=$(( 3 + (start + i) % 31 ))
    d=$(ny_days_ago "$k")
    n=$(curl -sS \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${STAFF_TOKEN}" \
      "${SUPABASE_URL}/rest/v1/eod_submissions?store_id=eq.${STORE_ID}&vendor_id=eq.${vendor}&date=eq.${d}&select=id" \
      | jq 'length' 2>/dev/null || echo "err")
    if [[ "$n" == "0" ]]; then
      printf '%s' "$d"
      return 0
    fi
  done
  return 1
}

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
# Spec 193: an in-window date (A - k, k in [3, 33], New York calendar) whose
# (STORE_ID, date, VENDOR_ID) triple is still free, picked in a CLIENT_UUID-
# seeded order. A fresh triple keeps CLIENT_UUID on the row: ON CONFLICT
# (store_id, date, vendor_id) DO UPDATE would preserve an older client_uuid,
# and the row-visibility check below looks the row up by CLIENT_UUID.
TODAY=$(pick_free_date "${VENDOR_ID}" "${CLIENT_UUID}" || true)
if [[ -z "${TODAY}" ]]; then
  fail "no free in-window date for (${STORE_ID}, ${VENDOR_ID}); run \`npx supabase db reset\`"
  printf '\n\033[31m✗ smoke-staff-eod failed at date selection\033[0m\n'
  exit 1
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
# Spec 193: TODAY is in the window, so this still tests the store gate
# rather than the date bound.
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
# 8b. Spec 172 — NO NEED entry: 200, current_stock unchanged, no
#     stock_updates, and the persisted row is no_need=true with NULL total.
#     Uses an item LINKED (item_vendors) to its vendor at STORE_ID so the
#     RPC's junction-membership on-hand write WOULD fire for a numeric
#     entry — that is what makes "current_stock unchanged" meaningful.
################################################################################
step "POST /rpc/staff_submit_eod with a NO NEED entry (spec 172)"
NN_LINK=$(curl -sS \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  "${SUPABASE_URL}/rest/v1/item_vendors?select=item_id,vendor_id,item:inventory_items!inner(store_id)&item.store_id=eq.${STORE_ID}&limit=1")
NN_ITEM_ID=$(printf '%s' "$NN_LINK" | jq -r '.[0].item_id // empty' 2>/dev/null || echo "")
NN_VENDOR_ID=$(printf '%s' "$NN_LINK" | jq -r '.[0].vendor_id // empty' 2>/dev/null || echo "")
if [[ -z "${NN_ITEM_ID}" || -z "${NN_VENDOR_ID}" ]]; then
  fail "could not discover a linked (item, vendor) pair at ${STORE_ID}: ${NN_LINK:0:300}"
else
  pass "linked pair item=${NN_ITEM_ID} vendor=${NN_VENDOR_ID}"

  stock_of() {
    curl -sS \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${STAFF_TOKEN}" \
      "${SUPABASE_URL}/rest/v1/inventory_items?id=eq.$1&select=current_stock,eod_remaining" \
      | jq -c '.[0] // empty' 2>/dev/null || echo ""
  }
  NN_CLIENT_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
  # Spec 193: a free in-window triple for (STORE_ID, NN_VENDOR_ID).
  NN_DATE=$(pick_free_date "${NN_VENDOR_ID}" "${NN_CLIENT_UUID}" || true)
  if [[ -z "${NN_DATE}" ]]; then
    # Stop here, like step 4: priming / submitting with p_date "" would only
    # bury this cause under secondary failures. The EXIT trap still cleans up.
    fail "no free in-window date for (${STORE_ID}, ${NN_VENDOR_ID}); run \`npx supabase db reset\`"
    printf '\n\033[31m✗ smoke-staff-eod failed at date selection (step 8b)\033[0m\n'
    exit 1
  fi

  # Prime a known NON-ZERO on-hand (7) with a numeric count first, so the
  # unchanged-check catches a regression that writes 0 as well as NULL.
  PRIME_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
  CODE_PRIME=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${STAFF_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"p_client_uuid\": \"${PRIME_UUID}\",
      \"p_store_id\": \"${STORE_ID}\",
      \"p_date\": \"${NN_DATE}\",
      \"p_submitted_by\": null,
      \"p_status\": \"submitted\",
      \"p_entries\": [{\"ingredient_id\": \"${NN_ITEM_ID}\", \"actual_remaining\": 7}],
      \"p_vendor_id\": \"${NN_VENDOR_ID}\"
    }" \
    "${SUPABASE_URL}/rest/v1/rpc/staff_submit_eod")
  NN_BEFORE=$(stock_of "${NN_ITEM_ID}")
  if [[ "$CODE_PRIME" == "200" && "$(printf '%s' "$NN_BEFORE" | jq '.current_stock == 7' 2>/dev/null)" == "true" ]]; then
    pass "primed on-hand to 7 with a numeric count (${NN_BEFORE})"
  else
    fail "could not prime on-hand (HTTP ${CODE_PRIME}, stock=${NN_BEFORE})"
  fi

  RESPONSE_NN=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${STAFF_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"p_client_uuid\": \"${NN_CLIENT_UUID}\",
      \"p_store_id\": \"${STORE_ID}\",
      \"p_date\": \"${NN_DATE}\",
      \"p_submitted_by\": null,
      \"p_status\": \"submitted\",
      \"p_entries\": [{\"ingredient_id\": \"${NN_ITEM_ID}\", \"no_need\": true}],
      \"p_vendor_id\": \"${NN_VENDOR_ID}\"
    }" \
    "${SUPABASE_URL}/rest/v1/rpc/staff_submit_eod")
  CODE_NN=$(printf '%s' "$RESPONSE_NN" | tail -1)
  BODY_NN=$(printf '%s' "$RESPONSE_NN" | sed '$d')

  if [[ "$CODE_NN" != "200" ]]; then
    fail "NO NEED call returned ${CODE_NN} (expected 200). Body: ${BODY_NN:0:300}"
  else
    pass "NO NEED call returns 200"

    NN_UPDATES=$(printf '%s' "$BODY_NN" | jq -c '.stock_updates' 2>/dev/null || echo "parse-error")
    if [[ "$NN_UPDATES" == "[]" ]]; then
      pass "stock_updates is empty (NO NEED item omitted)"
    else
      fail "stock_updates should be [] for a NO NEED-only call, got: ${NN_UPDATES}"
    fi

    NN_AFTER=$(stock_of "${NN_ITEM_ID}")
    if [[ -n "${NN_BEFORE}" && "${NN_AFTER}" == "${NN_BEFORE}" ]]; then
      pass "current_stock / eod_remaining unchanged (${NN_AFTER})"
    else
      fail "on-hand changed by a NO NEED entry: before=${NN_BEFORE} after=${NN_AFTER}"
    fi

    NN_SUB_ID=$(printf '%s' "$BODY_NN" | jq -r '.submission_id // empty' 2>/dev/null || echo "")
    NN_ROW=$(curl -sS \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${STAFF_TOKEN}" \
      "${SUPABASE_URL}/rest/v1/eod_entries?submission_id=eq.${NN_SUB_ID}&item_id=eq.${NN_ITEM_ID}&select=no_need,actual_remaining,actual_remaining_cases,actual_remaining_each" \
      | jq -c '.[0] // empty' 2>/dev/null || echo "")
    if [[ "$NN_ROW" == '{"no_need":true,"actual_remaining":null,"actual_remaining_cases":null,"actual_remaining_each":null}' ]]; then
      pass "eod_entries row persisted as no_need=true with NULL numerics"
    else
      fail "unexpected NO NEED eod_entries row: ${NN_ROW:0:300}"
    fi
  fi
fi

################################################################################
# 8c. Spec 193 (AC-11) — out-of-window date: HTTP 400 (not 403), SQLSTATE
#     22023, the exact message, and no row for this call's client_uuid. Not
#     "no row at the triple": real local data at A - 36 can exist. A was
#     computed before the call on the same clock, so the server's A is never
#     earlier and A - 36 stays outside the window even across midnight.
################################################################################
step "POST /rpc/staff_submit_eod at A - 36 (expect 400 + 22023, spec 193)"
OOW_MSG='staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)'
OOW_DATE=$(ny_days_ago 36)
OOW_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
RESPONSE_OOW=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"p_client_uuid\": \"${OOW_UUID}\",
    \"p_store_id\": \"${STORE_ID}\",
    \"p_date\": \"${OOW_DATE}\",
    \"p_submitted_by\": null,
    \"p_status\": \"submitted\",
    \"p_entries\": [{\"ingredient_id\": \"${ITEM_ID}\", \"actual_remaining\": 4}],
    \"p_vendor_id\": \"${VENDOR_ID}\"
  }" \
  "${SUPABASE_URL}/rest/v1/rpc/staff_submit_eod")
CODE_OOW=$(printf '%s' "$RESPONSE_OOW" | tail -1)
BODY_OOW=$(printf '%s' "$RESPONSE_OOW" | sed '$d')

if [[ "$CODE_OOW" == "400" ]]; then
  pass "A - 36 (${OOW_DATE}, A = ${A_NY}) returns 400 (not 403)"
else
  fail "A - 36 (${OOW_DATE}) returned ${CODE_OOW} (expected 400). Body: ${BODY_OOW:0:300}"
fi

OOW_CODE_FIELD=$(printf '%s' "$BODY_OOW" | jq -r '.code // empty' 2>/dev/null || echo "")
OOW_MSG_FIELD=$(printf '%s' "$BODY_OOW" | jq -r '.message // empty' 2>/dev/null || echo "")
if [[ "$OOW_CODE_FIELD" == "22023" && "$OOW_MSG_FIELD" == "$OOW_MSG" ]]; then
  pass "body carries code 22023 and the exact window message"
else
  fail "unexpected refusal body (code='${OOW_CODE_FIELD}', message='${OOW_MSG_FIELD}')"
fi

OOW_ROWS=$(curl -sS \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${STAFF_TOKEN}" \
  "${SUPABASE_URL}/rest/v1/eod_submissions?client_uuid=eq.${OOW_UUID}&select=id" \
  | jq 'length' 2>/dev/null || echo "parse-error")
if [[ "$OOW_ROWS" == "0" ]]; then
  pass "no eod_submissions row carries the refused call's client_uuid"
else
  fail "refused call left ${OOW_ROWS} row(s) at client_uuid=${OOW_UUID}"
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
