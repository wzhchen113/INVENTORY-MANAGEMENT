#!/usr/bin/env bash
# scripts/smoke-edge.sh — fast pre/post-deploy smoke test for the breadbot
# edge functions. Runs four checks that take ~2 seconds total:
#   1. CORS preflight returns 200 + the required allow-* headers
#      (catches the class of bug we just shipped a fix for — browser preflight
#       was dying with 405)
#   2. POST without Authorization returns 401 (verify_jwt guard works)
#   3. POST with valid session but unmapped store returns 400
#   4. POST with valid session + mapped store returns 200 + rows[]
#
# The point is: run this after every `deploy_edge_function` and BEFORE
# starting a browser click-through. If it fails, no reason to go clicking.
#
# Usage:
#   scripts/smoke-edge.sh                        # runs all 4, uses env defaults
#   scripts/smoke-edge.sh preflight              # just the CORS check (no auth needed)
#   SUPABASE_URL=... BOBBY_TOKEN=... scripts/smoke-edge.sh
#
# Env:
#   SUPABASE_URL     (default: https://ebwnovzzkwhsdxkpyjka.supabase.co)
#   ORIGIN           (default: https://hopeful-lewin.vercel.app)
#   BOBBY_TOKEN      a valid admin access_token. If unset, steps 3+4 are
#                    skipped (so the script still runs in CI-type contexts
#                    without a session). Pull one from
#                    /tmp/bobby_session_compact.json if present.
#
# Exit code: non-zero on first failure.

set -u  # don't `set -e` — we need to capture failed curls and report cleanly

SUPABASE_URL="${SUPABASE_URL:-https://ebwnovzzkwhsdxkpyjka.supabase.co}"
ORIGIN="${ORIGIN:-https://hopeful-lewin.vercel.app}"
BOBBY_TOKEN="${BOBBY_TOKEN:-}"

# Pick up a locally-cached session if the env var isn't set.
if [[ -z "${BOBBY_TOKEN}" && -f /tmp/bobby_session_compact.json ]]; then
  BOBBY_TOKEN=$(python3 -c "import json; print(json.load(open('/tmp/bobby_session_compact.json'))['access_token'])" 2>/dev/null || echo "")
fi

FN_URL="${SUPABASE_URL}/functions/v1/fetch-breadbot-sales"
ONLY="${1:-all}"
FAILED=0

pass()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip()  { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step()  { printf '\n== %s ==\n' "$1"; }

################################################################################
# 1. CORS preflight
################################################################################
if [[ "$ONLY" == "all" || "$ONLY" == "preflight" ]]; then
  step "CORS preflight"
  HEADERS=$(curl -sS -D - -o /dev/null -X OPTIONS \
    -H "Origin: ${ORIGIN}" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,content-type,apikey" \
    "$FN_URL" 2>&1)

  STATUS=$(printf '%s' "$HEADERS" | head -1 | grep -oE '[0-9]{3}' | head -1)
  [[ "$STATUS" == "200" ]] && pass "OPTIONS returns 200" || fail "OPTIONS returns $STATUS (expected 200)"

  printf '%s' "$HEADERS" | grep -qi '^access-control-allow-origin:' \
    && pass "has access-control-allow-origin" \
    || fail "missing access-control-allow-origin"
  printf '%s' "$HEADERS" | grep -qi '^access-control-allow-methods:.*POST' \
    && pass "allows POST" \
    || fail "missing/incorrect access-control-allow-methods"
  printf '%s' "$HEADERS" | grep -qi '^access-control-allow-headers:.*authorization' \
    && pass "allows authorization header" \
    || fail "missing authorization in access-control-allow-headers"
fi

################################################################################
# 2. POST without auth -> 401
################################################################################
if [[ "$ONLY" == "all" ]]; then
  step "POST without Authorization header"
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -d '{"storeName":"Frederick","date":"2026-04-22"}' \
    "$FN_URL")
  # verify_jwt=true at the gateway layer returns 401 before our handler runs.
  [[ "$CODE" == "401" ]] && pass "no-auth POST returns 401" || fail "no-auth POST returns $CODE (expected 401)"
fi

################################################################################
# 3. POST with unmapped store -> 400
################################################################################
if [[ "$ONLY" == "all" ]]; then
  step "POST with unmapped store"
  if [[ -z "$BOBBY_TOKEN" ]]; then
    skip "unmapped-store check" "no BOBBY_TOKEN"
  else
    RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
      -H "Authorization: Bearer ${BOBBY_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"storeName":"Towson","date":"2026-04-22"}' \
      "$FN_URL")
    CODE=$(printf '%s' "$RESPONSE" | tail -1)
    BODY=$(printf '%s' "$RESPONSE" | sed '$d')
    if [[ "$CODE" == "400" ]]; then
      pass "unmapped store returns 400"
      printf '%s' "$BODY" | grep -qi 'not mapped' && pass "error message mentions 'not mapped'" || fail "unexpected body: $BODY"
    else
      fail "unmapped store returns $CODE (expected 400)"
    fi
  fi
fi

################################################################################
# 4. POST valid -> 200 + rows
################################################################################
if [[ "$ONLY" == "all" ]]; then
  step "POST valid (Frederick/2026-04-22)"
  if [[ -z "$BOBBY_TOKEN" ]]; then
    skip "valid-POST check" "no BOBBY_TOKEN"
  else
    RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
      -H "Authorization: Bearer ${BOBBY_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"storeName":"Frederick","date":"2026-04-22"}' \
      "$FN_URL")
    CODE=$(printf '%s' "$RESPONSE" | tail -1)
    BODY=$(printf '%s' "$RESPONSE" | sed '$d')
    if [[ "$CODE" == "200" ]]; then
      pass "valid POST returns 200"
      ROWS=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('rows', [])))" 2>/dev/null || echo "parse-error")
      if [[ "$ROWS" == "parse-error" ]]; then
        fail "response is not JSON: ${BODY:0:200}"
      elif [[ "$ROWS" -gt 0 ]]; then
        pass "got $ROWS rows"
      else
        fail "got 0 rows (expected >0 for Frederick/2026-04-22)"
      fi
    else
      fail "valid POST returns $CODE (expected 200). Body: ${BODY:0:200}"
    fi
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
