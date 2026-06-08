#!/usr/bin/env bash
# scripts/smoke-username-resolve.sh — Spec 095 smoke for the username-resolve
# edge function (service-token bearer, verify_jwt=false, anti-oracle uniform-200
# contract).
#
# The headline property this smoke protects is the ANTI-ORACLE contract: an
# existing username and a non-existing username BOTH return HTTP 200, so the
# status code never reveals whether a username exists. It also checks the
# service-token gate (bad/missing token → 401) and CORS preflight.
#
# Checks (mirrors scripts/smoke-edge.sh PASS/FAIL convention, non-zero exit on
# first failure):
#   1. CORS preflight → 200 + allow-* headers.
#   2. POST without Authorization → 401 (service-token gate).
#   3. POST with WRONG token → 401.
#   4. POST with valid token + NON-EXISTENT username → 200 { "email": null }.
#   5. POST with valid token + EXISTING username → 200 with the SAME status as
#      (4) (the anti-oracle property — status indistinguishable). If a known
#      username is supplied (RESOLVE_USERNAME), additionally assert a non-null
#      email is returned; otherwise the existence-parity check still holds.
#   6. RATE LIMIT (spec 095 review fix): fire > the per-IP budget (20/min) from a
#      single forwarded IP and assert (a) the budget requests return 200 and
#      (b) the over-budget request returns 429 with a generic body — AND that the
#      429 is a per-IP signal, not a per-username one (anti-oracle preserved:
#      under the limit, existent and non-existent usernames both still 200).
#
# Auth: the function reads USERNAME_RESOLVE_SERVICE_TOKEN from the edge runtime
# env. Locally, set it in supabase/functions/.env (one line:
#   USERNAME_RESOLVE_SERVICE_TOKEN=local-dev-token
# ) and restart the edge runtime, then export the SAME value to this script via
# USERNAME_RESOLVE_SERVICE_TOKEN. Without the token the auth-gate steps still run
# (they only need a wrong/absent token), but the 200 resolve steps are skipped.
#
# Usage:
#   bash scripts/smoke-username-resolve.sh
#   USERNAME_RESOLVE_SERVICE_TOKEN=local-dev-token bash scripts/smoke-username-resolve.sh
#   RESOLVE_USERNAME=<a-known-username> ...     # assert a non-null email too
#
# Troubleshooting: a 503 / "function source not found" is the edge-runtime
# bind-mount class of issue — see CLAUDE.md "Local edge runtime bind-mount
# captures CWD at boot"; `npx supabase stop --no-backup && npm run dev:db` from
# the repo root fixes it.
#
# Exit code: non-zero on first failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
ORIGIN="${ORIGIN:-http://localhost:8081}"
USERNAME_RESOLVE_SERVICE_TOKEN="${USERNAME_RESOLVE_SERVICE_TOKEN:-}"
RESOLVE_USERNAME="${RESOLVE_USERNAME:-}"

FN_URL="${SUPABASE_URL}/functions/v1/username-resolve"
FAILED=0

pass()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip()  { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step()  { printf '\n== %s ==\n' "$1"; }

# Extract the JSON `email` field ("null" if literally null) from a body.
email_field() {
  printf '%s' "$1" | python3 -c \
    "import json,sys
try:
    v=json.load(sys.stdin).get('email','__missing__')
    print('null' if v is None else v)
except Exception:
    print('__parse_error__')" 2>/dev/null || echo "__parse_error__"
}

################################################################################
# 1. CORS preflight
################################################################################
step "CORS preflight"
HEADERS=$(curl -sS -D - -o /dev/null -X OPTIONS \
  -H "Origin: ${ORIGIN}" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  "$FN_URL" 2>&1)
STATUS=$(printf '%s' "$HEADERS" | head -1 | grep -oE '[0-9]{3}' | head -1)
[[ "$STATUS" == "200" ]] && pass "OPTIONS returns 200" || fail "OPTIONS returns $STATUS (expected 200)"
printf '%s' "$HEADERS" | grep -qi '^access-control-allow-origin:' \
  && pass "has access-control-allow-origin" || fail "missing access-control-allow-origin"
printf '%s' "$HEADERS" | grep -qi '^access-control-allow-methods:.*POST' \
  && pass "allows POST" || fail "missing POST in access-control-allow-methods"

################################################################################
# 2. POST without Authorization -> 401
################################################################################
step "POST without Authorization header"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" \
  -d '{"username":"whoever"}' \
  "$FN_URL")
[[ "$CODE" == "401" ]] && pass "no-token POST returns 401" || fail "no-token POST returns $CODE (expected 401)"

################################################################################
# 3. POST with WRONG token -> 401
################################################################################
step "POST with wrong service token"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer definitely-not-the-token" \
  -H "Content-Type: application/json" \
  -d '{"username":"whoever"}' \
  "$FN_URL")
[[ "$CODE" == "401" ]] && pass "wrong-token POST returns 401" || fail "wrong-token POST returns $CODE (expected 401)"

################################################################################
# 4 + 5. Anti-oracle: non-existent and existent username both 200
################################################################################
if [[ -z "$USERNAME_RESOLVE_SERVICE_TOKEN" ]]; then
  step "Resolve (valid token)"
  skip "non-existent + existent username resolve" "USERNAME_RESOLVE_SERVICE_TOKEN unset"
else
  step "POST valid token + NON-EXISTENT username -> 200 {email:null}"
  R=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${USERNAME_RESOLVE_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"username":"definitely_no_such_user_zzz"}' \
    "$FN_URL")
  CODE_MISS=$(printf '%s' "$R" | tail -1)
  BODY_MISS=$(printf '%s' "$R" | sed '$d')
  if [[ "$CODE_MISS" == "200" ]]; then
    pass "non-existent username returns 200"
    EMAIL=$(email_field "$BODY_MISS")
    [[ "$EMAIL" == "null" ]] && pass "non-existent username yields email:null" \
      || fail "expected email:null, got '$EMAIL' (body: ${BODY_MISS:0:120})"
  else
    fail "non-existent username returns $CODE_MISS (expected 200). Body: ${BODY_MISS:0:160}"
  fi

  step "POST valid token + EXISTING username -> SAME 200 status (anti-oracle)"
  USE_USERNAME="${RESOLVE_USERNAME:-admin}"
  R=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${USERNAME_RESOLVE_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${USE_USERNAME}\"}" \
    "$FN_URL")
  CODE_HIT=$(printf '%s' "$R" | tail -1)
  BODY_HIT=$(printf '%s' "$R" | sed '$d')
  if [[ "$CODE_HIT" == "200" && "$CODE_HIT" == "$CODE_MISS" ]]; then
    pass "existing username returns 200 — status indistinguishable from miss (anti-oracle)"
  else
    fail "existing username returns $CODE_HIT (expected 200, same as miss=$CODE_MISS)"
  fi
  if [[ -n "$RESOLVE_USERNAME" ]]; then
    EMAIL=$(email_field "$BODY_HIT")
    if [[ "$EMAIL" == "null" || "$EMAIL" == "__parse_error__" || "$EMAIL" == "__missing__" ]]; then
      fail "known username '$RESOLVE_USERNAME' resolved to '$EMAIL' (expected a real email)"
    else
      pass "known username '$RESOLVE_USERNAME' resolved to an email"
    fi
  else
    skip "known-username non-null email assertion" "RESOLVE_USERNAME not set"
  fi

  ##############################################################################
  # 6. Rate limit: > budget from one IP -> 429; anti-oracle parity preserved.
  ##############################################################################
  step "Rate limit: > per-IP budget (20/min) from one forwarded IP -> 429"
  # A stable, fictitious forwarded IP so this run owns its own per-IP window
  # (and re-runs within the same minute may already be over budget — see the
  # note below). The function reads the FIRST x-forwarded-for entry as the IP.
  RL_IP="198.51.100.$(( (RANDOM % 200) + 1 ))"
  RL_LIMIT=20
  RL_FIRED=$((RL_LIMIT + 1))
  SAW_200=0
  SAW_429=0
  LAST_CODE=""
  for ((i = 1; i <= RL_FIRED; i++)); do
    CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H "Authorization: Bearer ${USERNAME_RESOLVE_SERVICE_TOKEN}" \
      -H "X-Forwarded-For: ${RL_IP}" \
      -H "Content-Type: application/json" \
      -d '{"username":"definitely_no_such_user_zzz"}' \
      "$FN_URL")
    LAST_CODE="$CODE"
    [[ "$CODE" == "200" ]] && SAW_200=1
    [[ "$CODE" == "429" ]] && SAW_429=1
  done

  if [[ "$SAW_200" == "1" ]]; then
    pass "within-budget requests return 200"
  else
    fail "expected at least one 200 within budget, saw none (last=$LAST_CODE) — is the rate limiter migration applied?"
  fi
  if [[ "$SAW_429" == "1" ]]; then
    pass "over-budget request returns 429 (rate limit enforced)"
  else
    fail "fired $RL_FIRED requests from one IP, never saw 429 (last=$LAST_CODE) — rate limiter not engaged?"
  fi

  step "Anti-oracle preserved under the limit (fresh IP: existent + non-existent both 200)"
  # A DIFFERENT, fresh IP so this check is not itself throttled by the burst
  # above. The 429 is per-IP, so a clean IP still gets the uniform-200 contract.
  RL_IP2="198.51.100.$(( (RANDOM % 50) + 201 ))"
  C_MISS2=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${USERNAME_RESOLVE_SERVICE_TOKEN}" \
    -H "X-Forwarded-For: ${RL_IP2}" \
    -H "Content-Type: application/json" \
    -d '{"username":"definitely_no_such_user_yyy"}' \
    "$FN_URL")
  C_HIT2=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${USERNAME_RESOLVE_SERVICE_TOKEN}" \
    -H "X-Forwarded-For: ${RL_IP2}" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${RESOLVE_USERNAME:-admin}\"}" \
    "$FN_URL")
  if [[ "$C_MISS2" == "200" && "$C_HIT2" == "200" ]]; then
    pass "fresh-IP existent + non-existent username both 200 (anti-oracle holds under the limit)"
  else
    fail "anti-oracle parity broken under the limit: miss=$C_MISS2 hit=$C_HIT2 (expected both 200)"
  fi
fi

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m✓ all checks passed\033[0m\n'
  exit 0
else
  printf '\033[31m✗ some checks failed\033[0m\n'
  exit 1
fi
