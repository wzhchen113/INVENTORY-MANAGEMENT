#!/usr/bin/env bash
# scripts/smoke-rpc.sh — Spec 022 Track 3 example smoke for a PostgREST RPC.
#
# Same shape as scripts/smoke-edge.sh: env-var driven, sectioned PASS/FAIL
# output, non-zero exit on first failure. Single check by design — this is
# the v1 *example*; future smoke specs add more.
#
# Architect's pick (spec 022 §9): smoke `report_run('stub', ...)`. The
# `stub` template returns a fixed-shape envelope independent of seed data,
# so the script stays stable as the seed evolves. Real-data templates
# (cogs, variance) are deferred to the retroactive-coverage spec.
#
# Why a real admin session, not service_role: this repo's RLS helpers
# (auth_is_admin / auth_can_see_store) read role from `app_metadata.role`
# in the user's JWT — they intentionally do NOT honour `role=service_role`
# at the JWT top level (that's a PostgREST concept, not the project's
# admin gate). The local seed ships an `admin@local.test` user expressly
# for this kind of smoke; we log in as that user and pass the resulting
# access_token. Matches the smoke-edge.sh pattern.
#
# Usage:
#   bash scripts/smoke-rpc.sh                # default: local stack
#   SUPABASE_URL=https://...                 # remote override
#   SUPABASE_ANON_KEY=...                    # remote override
#   ADMIN_TOKEN=...                          # skip the login round-trip
#   ADMIN_EMAIL=admin@local.test             # override
#   ADMIN_PASSWORD=password                  # override
#   STORE_ID=<uuid>                          # override the default seed store
#
# Troubleshooting: if this script gets a 503 or "function source not found"
# it's the same edge-runtime bind-mount class of issue as the smoke-edge.sh
# failures. See CLAUDE.md > "Local edge runtime bind-mount captures CWD at
# boot" — `npx supabase stop --no-backup && npm run dev:db` from the repo
# root fixes it.
#
# Exit code: non-zero on failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"

# Local publishable/anon API key. Stable across `supabase start`s on the
# same project_id. (`supabase status` prints the current values.) Safe to
# commit — this is the public key.
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH}"

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

# Default store: Towson (a seed store, stable id). The stub runner ignores
# p_store_id beyond the auth gate; this just needs to be a UUID the
# logged-in user can see (admin sees all).
STORE_ID="${STORE_ID:-00000000-0000-0000-0000-000000000001}"

FAILED=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step() { printf '\n== %s ==\n' "$1"; }

################################################################################
# 0. Acquire an admin access_token (unless caller passed one)
################################################################################
if [[ -z "${ADMIN_TOKEN}" ]]; then
  step "login as ${ADMIN_EMAIL}"
  LOGIN=$(curl -sS -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    "${SUPABASE_URL}/auth/v1/token?grant_type=password")
  ADMIN_TOKEN=$(printf '%s' "$LOGIN" | jq -r '.access_token // empty' 2>/dev/null || echo "")
  if [[ -z "${ADMIN_TOKEN}" ]]; then
    fail "could not acquire admin access_token (login response: ${LOGIN:0:300})"
    printf '\n\033[31m✗ smoke-rpc failed at login\033[0m\n'
    exit 1
  fi
  pass "got admin access_token (${#ADMIN_TOKEN} chars)"
fi

################################################################################
# 1. report_run(template=stub) smoke — happy path
################################################################################
step "report_run(template=stub) against ${SUPABASE_URL}"
RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"p_template_id\":\"stub\",\"p_store_id\":\"${STORE_ID}\",\"p_params\":{}}" \
  "${SUPABASE_URL}/rest/v1/rpc/report_run")

CODE=$(printf '%s' "$RESPONSE" | tail -1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$CODE" != "200" ]]; then
  fail "POST /rpc/report_run returned $CODE (expected 200). Body: ${BODY:0:300}"
  printf '\n\033[31m✗ smoke-rpc failed\033[0m\n'
  exit 1
fi
pass "POST /rpc/report_run returns 200"

# Validate the envelope shape via jq. The stub runner returns:
#   { "kpis": [...], "columns": [...], "rows": [...], "series": [...] }
HAS_ALL=$(printf '%s' "$BODY" | jq -r '
  (has("kpis") and has("columns") and has("rows") and has("series"))
' 2>/dev/null || echo "parse-error")

if [[ "$HAS_ALL" == "parse-error" ]]; then
  fail "response is not valid JSON: ${BODY:0:300}"
elif [[ "$HAS_ALL" != "true" ]]; then
  fail "response missing one of kpis/columns/rows/series: ${BODY:0:300}"
else
  pass "response has kpis/columns/rows/series"
fi

# Sanity check: stub runner's `columns` always has exactly 2 entries
# ('item', 'value'). If this trips, the stub runner contract drifted —
# would be caught here before it broke the frontend's frame renderer.
COL_COUNT=$(printf '%s' "$BODY" | jq -r '.columns | length' 2>/dev/null || echo "parse-error")
if [[ "$COL_COUNT" == "2" ]]; then
  pass "stub envelope.columns has 2 entries"
elif [[ "$COL_COUNT" == "parse-error" ]]; then
  fail "could not parse .columns length"
else
  fail "stub envelope.columns has ${COL_COUNT} entries (expected 2)"
fi

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m✓ all checks passed\033[0m\n'
  exit 0
else
  printf '\033[31m✗ some checks failed\033[0m\n'
  exit 1
fi
