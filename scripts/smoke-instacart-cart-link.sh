#!/usr/bin/env bash
# scripts/smoke-instacart-cart-link.sh — Spec 149 AC-30 (spec 022 Track 3).
#
# Round trip against the instacart-cart-link edge function, plus the OQ-2
# retailer-availability probe that the design (§5.5) calls "the operator gate
# before enabling the Instacart channel".
#
# NOT WIRED INTO CI. There is no smoke-test runner in either gate
# (test.yml / db-migrations-applied.yml) — this is a MANUAL pre/post-deploy step,
# exactly like scripts/smoke-edge.sh. Spec 149 §10.11 says so explicitly; do not
# assume a green CI means these checks ran.
#
# Checks:
#   0. CORS preflight returns 200 + the allow-* headers.
#   1. OQ-2 retailer probe — GET /idp/v1/retailers for the store's REAL ZIP and
#      report whether a retailer_key exists for BJ's and for Sam's Club. RECORD
#      both keys; they become vendors.instacart_retailer_key. If either is
#      MISSING, leave that vendor's order_channel NULL (⇒ R-3 resolves it to
#      'extension', i.e. today's behavior) and note it. DO NOT set the column.
#      Requires INSTACART_IDP_API_KEY locally — this probe talks to Instacart
#      directly, NOT through the edge function (the function never echoes the key).
#   2. POST without Authorization                → 401 (the gateway verify_jwt=true guard).
#   3. Admin JWT + a valid instacart approvalId  → 200 { ok:true, url }.
#   4. Non-privileged JWT                        → 403, and NO upstream call (AC-23).
#   5. Cross-store / unknown approvalId          → 404 'approval not found' (AC-24).
#   6. Forced upstream non-2xx (bad IDP key)     → 502 { error:'upstream_error' },
#                                                  explicitly NOT ok:true (AC-15).
#
# Usage:
#   scripts/smoke-instacart-cart-link.sh              # all checks
#   scripts/smoke-instacart-cart-link.sh preflight    # just CORS (no auth needed)
#   scripts/smoke-instacart-cart-link.sh retailers    # just the OQ-2 probe
#
# Env:
#   SUPABASE_URL             default: http://127.0.0.1:54321 (local stack)
#   ORIGIN                   default: http://localhost:8081
#   ADMIN_TOKEN              a privileged (admin/master/super_admin) access_token.
#                            Steps 3, 5, 6 skip without it.
#   STAFF_TOKEN              a NON-privileged (role 'user') access_token.
#                            Step 4 skips without it.
#   APPROVAL_ID              an order_approvals.id whose channel = 'instacart'
#                            and status <> 'ordered', visible to ADMIN_TOKEN.
#   FOREIGN_APPROVAL_ID      an order_approvals.id the ADMIN_TOKEN caller must
#                            NOT be able to see. Defaults to a random uuid, which
#                            exercises the same 404 path.
#   INSTACART_IDP_API_KEY    for step 1 only (the direct retailer probe).
#   INSTACART_IDP_BASE_URL   default: https://connect.instacart.com
#   STORE_ZIP                the store's real postal code, for step 1.
#
# Exit code: non-zero on first failure.

set -u  # not -e: we capture failed curls and report cleanly

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
ORIGIN="${ORIGIN:-http://localhost:8081}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
STAFF_TOKEN="${STAFF_TOKEN:-}"
APPROVAL_ID="${APPROVAL_ID:-}"
FOREIGN_APPROVAL_ID="${FOREIGN_APPROVAL_ID:-00000000-0000-4000-8000-00000000dead}"
INSTACART_IDP_API_KEY="${INSTACART_IDP_API_KEY:-}"
INSTACART_IDP_BASE_URL="${INSTACART_IDP_BASE_URL:-https://connect.instacart.com}"
STORE_ZIP="${STORE_ZIP:-}"

FN_URL="${SUPABASE_URL}/functions/v1/instacart-cart-link"
ONLY="${1:-all}"
FAILED=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
note() { printf '  \033[36mNOTE\033[0m %s\n' "$1"; }
step() { printf '\n== %s ==\n' "$1"; }

################################################################################
# 0. CORS preflight
################################################################################
if [[ "$ONLY" == "all" || "$ONLY" == "preflight" ]]; then
  step "CORS preflight"
  HEADERS=$(curl -sS -D - -o /dev/null -X OPTIONS \
    -H "Origin: ${ORIGIN}" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,content-type,apikey" \
    "$FN_URL" 2>&1)
  STATUS=$(printf '%s' "$HEADERS" | head -1 | grep -oE '[0-9]{3}' | head -1)
  [[ "$STATUS" == "200" ]] && pass "OPTIONS returns 200" || fail "OPTIONS returns ${STATUS:-<none>} (expected 200)"
  printf '%s' "$HEADERS" | grep -qi '^access-control-allow-origin:' \
    && pass "has access-control-allow-origin" || fail "missing access-control-allow-origin"
  printf '%s' "$HEADERS" | grep -qi '^access-control-allow-methods:.*POST' \
    && pass "allows POST" || fail "missing/incorrect access-control-allow-methods"
fi

################################################################################
# 1. OQ-2 retailer probe (the operator gate — §5.5)
################################################################################
if [[ "$ONLY" == "all" || "$ONLY" == "retailers" ]]; then
  step "OQ-2 retailer availability for the store's ZIP"
  if [[ -z "$INSTACART_IDP_API_KEY" || -z "$STORE_ZIP" ]]; then
    skip "retailer probe" "need INSTACART_IDP_API_KEY and STORE_ZIP"
  else
    RESP=$(curl -sS -w '\n%{http_code}' -X GET \
      -H "Authorization: Bearer ${INSTACART_IDP_API_KEY}" \
      -H "Accept: application/json" \
      "${INSTACART_IDP_BASE_URL}/idp/v1/retailers?postal_code=${STORE_ZIP}&country_code=US")
    CODE=$(printf '%s' "$RESP" | tail -1)
    BODY=$(printf '%s' "$RESP" | sed '$d')
    if [[ "$CODE" != "200" ]]; then
      fail "GET /idp/v1/retailers returned $CODE (expected 200)"
    else
      pass "GET /idp/v1/retailers returned 200"
      # Report every retailer whose name looks like BJ's or Sam's Club, plus the
      # total. The operator RECORDS the printed retailer_key values.
      printf '%s' "$BODY" | python3 -c "
import json,sys
try:
    rs = json.load(sys.stdin).get('retailers', [])
except Exception as e:
    print('  parse-error:', e); sys.exit(0)
print(f'  {len(rs)} retailer(s) serve this ZIP')
for want in (\"bj\", \"sam\"):
    hits = [r for r in rs if want in (r.get('name') or '').lower()]
    if hits:
        for h in hits:
            print(f\"  MATCH {want}: retailer_key={h.get('retailer_key')!r} name={h.get('name')!r}\")
    else:
        print(f'  NO MATCH for {want!r} — leave that vendor order_channel NULL (⇒ extension, i.e. today behavior)')
"
      note "record the printed retailer_key values into vendors.instacart_retailer_key"
      note "a MISSING key ⇒ leave order_channel NULL; DO NOT set the column"
    fi
  fi
fi

[[ "$ONLY" == "all" ]] || { printf '\n'; [[ $FAILED -eq 0 ]] && { printf '\033[32m✓ all checks passed\033[0m\n'; exit 0; } || { printf '\033[31m✗ some checks failed\033[0m\n'; exit 1; }; }

################################################################################
# 2. POST without Authorization -> 401
################################################################################
step "POST without Authorization header"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" \
  -d "{\"approvalId\":\"${FOREIGN_APPROVAL_ID}\"}" \
  "$FN_URL")
[[ "$CODE" == "401" ]] && pass "no-auth POST returns 401" || fail "no-auth POST returns $CODE (expected 401)"

################################################################################
# 3. Admin JWT + valid approvalId -> 200 { ok:true, url }
################################################################################
step "Admin JWT + valid instacart approvalId"
if [[ -z "$ADMIN_TOKEN" || -z "$APPROVAL_ID" ]]; then
  skip "happy-path mint" "need ADMIN_TOKEN and APPROVAL_ID"
else
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${APPROVAL_ID}\"}" \
    "$FN_URL")
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  if [[ "$CODE" == "200" ]]; then
    pass "valid POST returns 200"
    printf '%s' "$BODY" | grep -q '"ok":true' && pass "body carries ok:true" || fail "body missing ok:true: ${BODY:0:200}"
    printf '%s' "$BODY" | grep -q '"url":"http' && pass "body carries a products_link url" || fail "body missing url: ${BODY:0:200}"
    printf '%s' "$BODY" | grep -qi 'instacart_idp_api_key\|Bearer ' && fail "SECRET LEAK: response body echoes credential material" || pass "no credential material in the response body"
  elif [[ "$CODE" == "409" ]]; then
    # Legitimate outcome when the vendor's retailer does not serve the ZIP —
    # this is the OQ-2 fallback, not a failure of the function.
    printf '%s' "$BODY" | grep -q 'retailer_unavailable' \
      && { pass "409 retailer_unavailable (OQ-2 fallback path)"; \
           printf '%s' "$BODY" | grep -q '"fallbackChannel"' && pass "409 carries fallbackChannel" || fail "409 missing fallbackChannel"; } \
      || fail "409 with unexpected body: ${BODY:0:200}"
  else
    fail "valid POST returns $CODE (expected 200, or 409 retailer_unavailable). Body: ${BODY:0:200}"
  fi
fi

################################################################################
# 4. Non-privileged JWT -> 403, no upstream call (AC-23)
################################################################################
step "Non-privileged JWT"
if [[ -z "$STAFF_TOKEN" ]]; then
  skip "role-gate check" "no STAFF_TOKEN"
else
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${STAFF_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${APPROVAL_ID:-$FOREIGN_APPROVAL_ID}\"}" \
    "$FN_URL")
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  [[ "$CODE" == "403" ]] && pass "non-privileged POST returns 403 (AC-23)" || fail "non-privileged POST returns $CODE (expected 403). Body: ${BODY:0:200}"
  printf '%s' "$BODY" | grep -q '"error":"forbidden"' && pass "403 body error is 'forbidden'" || fail "403 body: ${BODY:0:200}"
fi

################################################################################
# 5. Cross-store / unknown approvalId -> 404 (AC-24)
################################################################################
step "Cross-store approvalId"
if [[ -z "$ADMIN_TOKEN" ]]; then
  skip "cross-store refusal" "no ADMIN_TOKEN"
else
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${FOREIGN_APPROVAL_ID}\"}" \
    "$FN_URL")
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  [[ "$CODE" == "404" ]] && pass "cross-store approvalId returns 404 (AC-24)" || fail "cross-store approvalId returns $CODE (expected 404). Body: ${BODY:0:200}"
  printf '%s' "$BODY" | grep -q 'approval not found' && pass "404 body error is 'approval not found'" || fail "404 body: ${BODY:0:200}"
fi

################################################################################
# 6. Forced upstream non-2xx -> 502 upstream_error, NOT a fake success (AC-15)
################################################################################
step "Forced upstream failure surfaces as 502, never ok:true"
if [[ -z "$ADMIN_TOKEN" || -z "$APPROVAL_ID" ]]; then
  skip "upstream-failure check" "need ADMIN_TOKEN and APPROVAL_ID"
else
  note "set INSTACART_IDP_API_KEY to a bogus value (or INSTACART_IDP_BASE_URL to a 500 stub)"
  note "on the DEPLOYED function, then re-run: scripts/smoke-instacart-cart-link.sh"
  note "expected: HTTP 502 with {\"error\":\"upstream_error\",\"upstreamStatus\":...} and NO ok:true"
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${APPROVAL_ID}\"}" \
    "$FN_URL")
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  if printf '%s' "$BODY" | grep -q '"ok":true'; then
    if [[ "$CODE" == "200" ]]; then
      note "upstream is healthy (ok:true) — re-run with a bogus key to exercise the 502 path"
    else
      fail "ok:true on HTTP $CODE — this is the spec-031/032 silent-fake-success regression"
    fi
  elif [[ "$CODE" == "502" ]]; then
    pass "upstream failure surfaces as 502"
    printf '%s' "$BODY" | grep -q 'upstream_error' && pass "502 body error is 'upstream_error'" || fail "502 body: ${BODY:0:200}"
    printf '%s' "$BODY" | grep -q '"correlationId"' && pass "502 carries a correlationId" || fail "502 missing correlationId"
  else
    note "current outcome: HTTP $CODE — ${BODY:0:200}"
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
