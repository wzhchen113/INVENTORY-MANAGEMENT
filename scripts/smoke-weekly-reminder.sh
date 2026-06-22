#!/usr/bin/env bash
# scripts/smoke-weekly-reminder.sh — Spec 098 §10 shell smoke for the
# weekly-reminder-cron edge function.
#
# Checks:
#   1. Shared-bearer gate: a request with a WRONG bearer returns 403
#      (the _edge_auth/cron_bearer guard fires). No secret needed.
#   2. Sane envelope: with the REAL cron_bearer, the function returns
#      HTTP 200 + { ok: true, summary: { weekly: [...] } }.
#   3. Once-per-store-per-week dedup: a second invocation in the same
#      week reminds 0 (every store entry is skipped or toRemind=0). The
#      first run's weekly_reminder_log rows make the replay a no-op.
#
# Steps 2-3 need the cron_bearer. Provide it directly via CRON_BEARER, or
# let the script fetch it via SERVICE_ROLE_KEY against the local stack. If
# neither is available, steps 2-3 are SKIPPED (step 1 still runs).
#
# Usage:
#   bash scripts/smoke-weekly-reminder.sh
#   CRON_BEARER=<hex>            scripts/smoke-weekly-reminder.sh
#   SERVICE_ROLE_KEY=<key>       scripts/smoke-weekly-reminder.sh
#   SUPABASE_URL=https://...     # remote override
#
# Troubleshooting: a 503 / "function source not found" is the edge-runtime
# bind-mount class of issue (see CLAUDE.md). Run
# `npx supabase stop --no-backup && npm run dev:db` from the repo root.
#
# Exit code: non-zero on first failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-}"
CRON_BEARER="${CRON_BEARER:-}"
FN_URL="${SUPABASE_URL}/functions/v1/weekly-reminder-cron"

FAILED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step() { printf '\n== %s ==\n' "$1"; }

################################################################################
# 1. Wrong bearer -> 403 (no secret needed)
################################################################################
step "wrong bearer returns 403"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer definitely-not-the-cron-bearer" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$FN_URL")
[[ "$CODE" == "403" ]] && pass "wrong bearer returns 403" || fail "wrong bearer returns $CODE (expected 403)"

################################################################################
# Acquire the real cron_bearer if not supplied
################################################################################
if [[ -z "$CRON_BEARER" && -n "$SERVICE_ROLE_KEY" ]]; then
  step "fetch cron_bearer via service_role"
  CRON_BEARER=$(curl -sS \
    -H "apikey: ${SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    "${SUPABASE_URL}/rest/v1/_edge_auth?select=value&name=eq.cron_bearer" \
    | jq -r '.[0].value // empty' 2>/dev/null || echo "")
  [[ -n "$CRON_BEARER" ]] && pass "got cron_bearer (${#CRON_BEARER} chars)" \
    || fail "could not fetch cron_bearer via service_role"
fi

if [[ -z "$CRON_BEARER" ]]; then
  skip "envelope + dedup checks" "no CRON_BEARER or SERVICE_ROLE_KEY"
  printf '\n'
  if [[ $FAILED -eq 0 ]]; then
    printf '\033[32m✓ gate check passed (auth steps skipped)\033[0m\n'; exit 0
  else
    printf '\033[31m✗ some checks failed\033[0m\n'; exit 1
  fi
fi

################################################################################
# 2. Real bearer -> 200 + sane envelope
################################################################################
step "real bearer returns 200 + { ok, summary.weekly }"
RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "Authorization: Bearer ${CRON_BEARER}" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$FN_URL")
CODE=$(printf '%s' "$RESPONSE" | tail -1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$CODE" != "200" ]]; then
  fail "real-bearer POST returned $CODE (expected 200). Body: ${BODY:0:300}"
  printf '\n\033[31m✗ smoke-weekly-reminder failed\033[0m\n'; exit 1
fi
pass "real-bearer POST returns 200"

OK_FLAG=$(printf '%s' "$BODY" | jq -r '.ok // false' 2>/dev/null || echo "parse-error")
HAS_WEEKLY=$(printf '%s' "$BODY" | jq -r 'has("summary") and (.summary | has("weekly"))' 2>/dev/null || echo "parse-error")
[[ "$OK_FLAG" == "true" ]] && pass "envelope has ok:true" || fail "envelope ok=${OK_FLAG}: ${BODY:0:300}"
[[ "$HAS_WEEKLY" == "true" ]] && pass "envelope has summary.weekly[]" || fail "missing summary.weekly: ${BODY:0:300}"

################################################################################
# 3. Once-per-store-per-week dedup — second run reminds 0
#    Every store entry in the replay must have toRemind absent (skipped) or
#    toRemind == 0. (A store not due today is also skipped — both are fine;
#    the invariant is "no NEW reminders on the replay".)
################################################################################
step "second invocation same week reminds 0 (dedup)"
RESPONSE2=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "Authorization: Bearer ${CRON_BEARER}" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$FN_URL")
CODE2=$(printf '%s' "$RESPONSE2" | tail -1)
BODY2=$(printf '%s' "$RESPONSE2" | sed '$d')

if [[ "$CODE2" != "200" ]]; then
  fail "replay POST returned $CODE2 (expected 200). Body: ${BODY2:0:300}"
else
  pass "replay POST returns 200"
fi

# Sum toRemind across all weekly entries; any entry without toRemind (it was
# skipped) contributes 0. A clean dedup => total NEW reminders == 0.
NEW_REMINDERS=$(printf '%s' "$BODY2" \
  | jq '[.summary.weekly[]? | (.toRemind // 0)] | add // 0' 2>/dev/null || echo "parse-error")
if [[ "$NEW_REMINDERS" == "0" ]]; then
  pass "replay issued 0 new reminders (once-per-store-per-week guard held)"
else
  fail "replay issued ${NEW_REMINDERS} new reminders (expected 0): ${BODY2:0:300}"
fi

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m✓ all checks passed\033[0m\n'; exit 0
else
  printf '\033[31m✗ some checks failed\033[0m\n'; exit 1
fi
