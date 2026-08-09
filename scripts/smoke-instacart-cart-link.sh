#!/usr/bin/env bash
# scripts/smoke-instacart-cart-link.sh — Spec 149 AC-30, updated for spec 155
# AC-24 (spec 022 Track 3).
#
# Round trip against the instacart-cart-link edge function, plus the §5.5
# retailer-availability probe.
#
# ★ SPEC 155 CHANGED WHAT THE PROBE MEANS. It used to be "the operator gate
#   before enabling the Instacart channel" — three of its four arms returned
#   409/502 and REFUSED to mint. It is now ADVISORY: the minted link is
#   retailer-agnostic (the admin picks the store on Instacart's shopping-list
#   page), so a missing ZIP, a dead probe, an empty market, or a key that is not
#   in the market listing all MINT ANYWAY and merely tag the 200 body with
#   `advisory`. The ONE remaining refusal is a BLANK vendors.instacart_retailer_key
#   — that is the explicit opt-in token, not a pin (AC-16).
#
# NOT WIRED INTO CI. There is no smoke-test runner in either gate
# (test.yml / db-migrations-applied.yml) — this is a MANUAL pre/post-deploy step,
# exactly like scripts/smoke-edge.sh. Spec 149 §10.11 says so explicitly; do not
# assume a green CI means these checks ran. Say so in the PR description.
#
# Checks:
#   0. CORS preflight returns 200 + the allow-* headers.
#   1. §5.5 retailer probe — GET /idp/v1/retailers for the store's REAL ZIP and
#      report whether a retailer_key exists for BJ's and for Sam's Club. RECORD
#      both keys; they become vendors.instacart_retailer_key.
#      Requires INSTACART_IDP_API_KEY locally — this probe talks to Instacart
#      directly, NOT through the edge function (the function never echoes the key).
#   2. POST without Authorization                → 401 (the gateway verify_jwt=true guard).
#   3. Admin JWT + a valid instacart approvalId  → 200 { ok:true, url }.
#   4. Non-privileged JWT                        → 403, and NO upstream call (AC-23).
#   5. Cross-store / unknown approvalId          → 404 'approval not found' (AC-24).
#   6. Forced products_link non-2xx (bad IDP key)→ 502 { error:'upstream_error' },
#                                                  explicitly NOT ok:true (AC-15).
#   ── spec 155 advisory posture ──────────────────────────────────────────────
#   7. BLANK vendors.instacart_retailer_key      → 409 { error:'retailer_unavailable',
#                                                  fallbackChannel, reason:'blank_retailer_key' }
#                                                  (155 AC-16 — the only surviving refusal).
#   8. Store with a NULL/blank postal_code       → 200 { advisory:'no_postal_code' }
#                                                  — was 409 (155 AC-13).
#   9. Retailer key absent from the ZIP's market → 200 { advisory:'retailer_not_in_zip' }
#                                                  — was 409 (155 AC-14). An EMPTY market
#                                                  shares this token; the function's log
#                                                  line carries retailers=<n> (155 §4.3).
#  10. Retailers probe 5xx / timeout             → 200 { advisory:'retailers_probe_failed' }
#                                                  and NEVER 502/504 — was 502 (155 AC-15).
#  11. Retailers probe 200-then-STALLED BODY     → 200 { advisory:'retailers_probe_failed' }
#                                                  WITHIN the ~13 s ceiling. Pins the
#                                                  post-review S4 fix: the abort deadline
#                                                  covers the BODY read, not just the headers.
#
# ★★ FIXTURE HYGIENE — arms 7-11 each need a FRESH approval PER RUN ★★
#    The function's idempotency path returns { reused:true } with NO probe and NO
#    advisory whenever the approval already carries a live external_ref — which is
#    exactly the state a fixture is left in after ONE successful mint. So:
#      • give arms 7-11 approval rows that steps 3 and 6 never touch, and
#      • before each re-run, either mint fresh rows or clear the old ones:
#          update public.order_approvals
#             set external_ref = null, external_ref_expires_at = null, status = 'pending'
#           where id in ( ...the fixture ids... );
#    Every advisory arm detects `"reused":true` and SKIPs with that instruction
#    instead of failing with a misleading "expected advisory:<token>".
#
# Usage:
#   scripts/smoke-instacart-cart-link.sh              # all checks
#   scripts/smoke-instacart-cart-link.sh preflight    # just CORS (no auth needed)
#   scripts/smoke-instacart-cart-link.sh retailers    # just the direct §5.5 probe
#
# Env:
#   SUPABASE_URL             default: http://127.0.0.1:54321 (local stack)
#   ORIGIN                   default: http://localhost:8081
#   ADMIN_TOKEN              a privileged (admin/master/super_admin) access_token.
#                            Steps 3, 5, 6, 7, 8, 9, 10, 11 skip without it.
#   STAFF_TOKEN              a NON-privileged (role 'user') access_token.
#                            Step 4 skips without it.
#   APPROVAL_ID              an order_approvals.id whose channel = 'instacart'
#                            and status <> 'ordered', visible to ADMIN_TOKEN.
#   FOREIGN_APPROVAL_ID      an order_approvals.id the ADMIN_TOKEN caller must
#                            NOT be able to see. Defaults to a random uuid, which
#                            exercises the same 404 path.
#   BLANK_KEY_APPROVAL_ID    step 7. A pending instacart approval whose VENDOR has
#                            a NULL/blank instacart_retailer_key.
#   NO_ZIP_APPROVAL_ID       step 8. A pending instacart approval whose STORE has a
#                            NULL/blank postal_code (and whose vendor HAS a key).
#   UNKNOWN_KEY_APPROVAL_ID  step 9. A pending instacart approval whose vendor's
#                            instacart_retailer_key does NOT appear in the store
#                            ZIP's market listing (e.g. 'definitely_not_a_retailer').
#   PROBE_FAIL_APPROVAL_ID   step 10. A FRESH pending instacart approval (no live
#                            external_ref), run while the DEPLOYED function's
#                            INSTACART_IDP_BASE_URL points at a stub that 5xx's (or
#                            hangs >3s on) /idp/v1/retailers.
#                            NO DEFAULT — it deliberately no longer falls back to
#                            APPROVAL_ID, because step 3 mints that row earlier in the
#                            same run and step 10 would then silently land on the
#                            no-advisory reuse path (the arm would never run).
#   STALL_BODY_APPROVAL_ID   step 11. A FRESH pending instacart approval, run while the
#                            DEPLOYED function's INSTACART_IDP_BASE_URL points at a stub
#                            whose /idp/v1/retailers answers 200 HEADERS and then STALLS
#                            the body (e.g. >30s) while /idp/v1/products/products_link
#                            still 200s promptly. No default, same reason as above.
#   STALL_BODY_MAX_SECONDS   step 11 wall-clock bound. Default 12 (the ~13 s §4.4
#                            ceiling, minus the mint being a fast local stub).
#   INSTACART_IDP_API_KEY    for step 1 only (the direct retailer probe).
#   INSTACART_IDP_BASE_URL   default: https://connect.instacart.com
#   STORE_ZIP                the store's real postal code, for step 1.
#
# NOTE — steps 3, 6 and 7-11 each need a DIFFERENT approval row (different
# vendor/store fixture), FRESH per run (see FIXTURE HYGIENE above). Set only the
# ones you have; the rest skip cleanly.
#
# Exit code: non-zero on first failure.

set -u  # not -e: we capture failed curls and report cleanly

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
ORIGIN="${ORIGIN:-http://localhost:8081}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
STAFF_TOKEN="${STAFF_TOKEN:-}"
APPROVAL_ID="${APPROVAL_ID:-}"
FOREIGN_APPROVAL_ID="${FOREIGN_APPROVAL_ID:-00000000-0000-4000-8000-00000000dead}"
# Spec 155 AC-24 fixtures (steps 7-11). Each needs its OWN approval row, FRESH
# per run — see FIXTURE HYGIENE in the header. None of them defaults to
# APPROVAL_ID: step 3 mints that row, after which the reuse path returns no
# advisory at all and the arm would silently self-skip.
BLANK_KEY_APPROVAL_ID="${BLANK_KEY_APPROVAL_ID:-}"
NO_ZIP_APPROVAL_ID="${NO_ZIP_APPROVAL_ID:-}"
UNKNOWN_KEY_APPROVAL_ID="${UNKNOWN_KEY_APPROVAL_ID:-}"
PROBE_FAIL_APPROVAL_ID="${PROBE_FAIL_APPROVAL_ID:-}"
STALL_BODY_APPROVAL_ID="${STALL_BODY_APPROVAL_ID:-}"
STALL_BODY_MAX_SECONDS="${STALL_BODY_MAX_SECONDS:-12}"
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
  step "§5.5 retailer availability for the store's ZIP (advisory since spec 155)"
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
        print(f'  NO MATCH for {want!r} — spec 155: a WARNING, not a blocker; you may still opt this vendor in')
"
      note "record the printed retailer_key values into vendors.instacart_retailer_key"
      note "spec 155: a key MISSING from this ZIP's listing is a WARNING, not a blocker — you"
      note "  may still opt the vendor in; the approve path mints and shows an advisory toast."
      note "  Record it in the spec-155 enablement log either way. (A BLANK key column is still"
      note "  an explicit opt-OUT: that arm alone still refuses, with reason=blank_retailer_key.)"
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
    # Spec 155 — an advisory on the happy path is INFORMATIONAL, never a failure.
    if printf '%s' "$BODY" | grep -q '"advisory"'; then
      note "200 carries an advisory: $(printf '%s' "$BODY" | grep -o '"advisory":"[a-z_]*"')"
      note "  (spec 155: the mint proceeded anyway — this is the demoted probe, working)"
    else
      pass "no advisory — the retailers probe ran clean"
    fi
  elif [[ "$CODE" == "409" ]]; then
    # Spec 155 AC-16: since the probe demotion, the ONLY thing that produces a
    # 409 retailer_unavailable is a BLANK vendors.instacart_retailer_key. A ZIP
    # or market-coverage 409 here means the deployed function predates spec 155.
    printf '%s' "$BODY" | grep -q 'retailer_unavailable' \
      && { pass "409 retailer_unavailable (blank-key opt-out path)"; \
           printf '%s' "$BODY" | grep -q '"fallbackChannel"' && pass "409 carries fallbackChannel" || fail "409 missing fallbackChannel"; \
           printf '%s' "$BODY" | grep -q '"reason":"blank_retailer_key"' \
             && pass "409 carries reason:blank_retailer_key (155 AC-16)" \
             || fail "409 missing reason:blank_retailer_key — is the DEPLOYED function pre-spec-155? Body: ${BODY:0:200}"; } \
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
# 6. Forced products_link non-2xx -> 502 upstream_error, NOT a fake success
#    (spec 149 AC-15). UNCHANGED by spec 155 — the MINT failing is a real
#    failure; only the RETAILERS probe was demoted (steps 8-10).
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

################################################################################
# SPEC 155 — the advisory posture (AC-13/14/15/16). Steps 7-10.
#
# Shared shape: POST an approval, and assert the function MINTS (200) with the
# expected `advisory` token instead of refusing. Each helper deliberately fails
# on a 409/502/504, because that is the pre-spec-155 behavior and the single most
# likely regression: a demoted arm that still blocks the order.
################################################################################

# is_reused <body> — true when the function took the idempotency path. A reused
# 200 carries NO advisory and made NO probe call, so every advisory arm below is
# INCONCLUSIVE (not failing) against such a fixture.
is_reused() { printf '%s' "$1" | grep -q '"reused":true'; }

REUSE_HINT="fixture already has a live external_ref (\"reused\":true) — the probe never ran. Clear external_ref/external_ref_expires_at on that order_approvals row (or use a fresh approval) and re-run; see FIXTURE HYGIENE in this script's header"

# assert_advisory <label> <approvalId> <expected-token>
assert_advisory() {
  local label="$1" approval="$2" want="$3"
  local resp code body
  resp=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${approval}\"}" \
    "$FN_URL")
  code=$(printf '%s' "$resp" | tail -1)
  body=$(printf '%s' "$resp" | sed '$d')
  if [[ "$code" == "200" ]] && is_reused "$body"; then
    skip "${label}" "$REUSE_HINT"
    return
  fi
  if [[ "$code" != "200" ]]; then
    fail "${label}: returned $code, expected 200 + advisory:${want} (a 409/502/504 here is the pre-spec-155 blocking behavior). Body: ${body:0:200}"
    return
  fi
  pass "${label}: mints (200) instead of refusing"
  printf '%s' "$body" | grep -q '"ok":true' \
    && pass "${label}: body carries ok:true" \
    || fail "${label}: body missing ok:true: ${body:0:200}"
  printf '%s' "$body" | grep -q '"url":"http' \
    && pass "${label}: body carries a products_link url" \
    || fail "${label}: body missing url: ${body:0:200}"
  printf '%s' "$body" | grep -q "\"advisory\":\"${want}\"" \
    && pass "${label}: advisory is '${want}'" \
    || fail "${label}: expected advisory:${want}, got: ${body:0:200}"
  printf '%s' "$body" | grep -qi 'instacart_idp_api_key\|Bearer ' \
    && fail "${label}: SECRET LEAK in the response body" \
    || pass "${label}: no credential material in the response body"
}

################################################################################
# 7. Blank vendors.instacart_retailer_key -> 409 + reason:blank_retailer_key
#    (155 AC-16). The ONLY availability arm that still refuses.
################################################################################
step "Blank retailer key still refuses (155 AC-16)"
if [[ -z "$ADMIN_TOKEN" || -z "$BLANK_KEY_APPROVAL_ID" ]]; then
  skip "blank-key refusal" "need ADMIN_TOKEN and BLANK_KEY_APPROVAL_ID"
else
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${BLANK_KEY_APPROVAL_ID}\"}" \
    "$FN_URL")
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  if [[ "$CODE" == "200" ]] && is_reused "$BODY"; then
    # The idempotency path runs BEFORE the blank-key refusal, so a consumed
    # fixture returns a reused 200 here — inconclusive, not a regression.
    skip "blank-key refusal" "$REUSE_HINT"
  elif [[ "$CODE" == "409" ]]; then
    pass "blank retailer key returns 409"
    # The WIRE TOKEN is deliberately unchanged (155 §4.2) so the client's
    # spec-149 fallback branch survives the deploy-skew window (AC-18).
    printf '%s' "$BODY" | grep -q '"error":"retailer_unavailable"' \
      && pass "409 error token is still 'retailer_unavailable' (155 AC-18 deploy-skew)" \
      || fail "409 body: ${BODY:0:200}"
    printf '%s' "$BODY" | grep -q '"fallbackChannel"' \
      && pass "409 carries fallbackChannel" || fail "409 missing fallbackChannel"
    printf '%s' "$BODY" | grep -q '"reason":"blank_retailer_key"' \
      && pass "409 carries reason:blank_retailer_key (155 AC-16 distinguishability)" \
      || fail "409 missing reason:blank_retailer_key: ${BODY:0:200}"
  else
    fail "blank retailer key returns $CODE (expected 409). Body: ${BODY:0:200}"
  fi
fi

################################################################################
# 8. NULL store postal_code -> 200 advisory:no_postal_code (155 AC-13, was 409)
################################################################################
step "Null store ZIP mints with an advisory (155 AC-13)"
if [[ -z "$ADMIN_TOKEN" || -z "$NO_ZIP_APPROVAL_ID" ]]; then
  skip "null-ZIP advisory" "need ADMIN_TOKEN and NO_ZIP_APPROVAL_ID"
else
  note "the probe is SKIPPED entirely for a null ZIP — no /idp/v1/retailers call is made"
  assert_advisory "null ZIP" "$NO_ZIP_APPROVAL_ID" "no_postal_code"
fi

################################################################################
# 9. Key absent from the ZIP's market -> 200 advisory:retailer_not_in_zip
#    (155 AC-14, was 409). An EMPTY market (OQ-3) shares this token and is
#    distinguished by retailers=0 in the function's log line (155 §4.3).
################################################################################
step "Unknown retailer key for the ZIP mints with an advisory (155 AC-14)"
if [[ -z "$ADMIN_TOKEN" || -z "$UNKNOWN_KEY_APPROVAL_ID" ]]; then
  skip "unknown-key advisory" "need ADMIN_TOKEN and UNKNOWN_KEY_APPROVAL_ID"
else
  note "set that vendor's instacart_retailer_key to something not in the market, e.g. 'definitely_not_a_retailer'"
  note "check the function log for: advisory=retailer_not_in_zip retailers=<n>  (retailers=0 ⇒ empty market)"
  assert_advisory "unknown retailer key" "$UNKNOWN_KEY_APPROVAL_ID" "retailer_not_in_zip"
fi

################################################################################
# 10. Retailers probe 5xx / timeout -> 200 advisory:retailers_probe_failed
#     (155 AC-15, was 502) — and NEVER 504. The probe has its own 3s budget and
#     its own try/catch precisely so its timeout cannot reach the outer 504 arm.
################################################################################
step "Retailers probe failure mints with an advisory, never 502/504 (155 AC-15)"
if [[ -z "$ADMIN_TOKEN" || -z "$PROBE_FAIL_APPROVAL_ID" ]]; then
  skip "probe-failure advisory" "need ADMIN_TOKEN and PROBE_FAIL_APPROVAL_ID (a FRESH approval — it no longer defaults to APPROVAL_ID, which step 3 consumes)"
else
  note "point the DEPLOYED function's INSTACART_IDP_BASE_URL at a stub whose /idp/v1/retailers"
  note "  5xx's (or hangs >3s), while /idp/v1/products/products_link still 200s, then re-run."
  note "expected: HTTP 200 with \"advisory\":\"retailers_probe_failed\" and a real url — NOT 502, NOT 504"
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${PROBE_FAIL_APPROVAL_ID}\"}" \
    "$FN_URL")
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  if [[ "$CODE" == "502" || "$CODE" == "504" ]]; then
    fail "probe failure surfaced as $CODE — spec 155 AC-15 demoted this to an advisory. Body: ${BODY:0:200}"
  elif [[ "$CODE" == "200" ]] && is_reused "$BODY"; then
    # Was a benign "the probe is HEALTHY" note before the post-review S2 fix —
    # which is how a consumed fixture silently swallowed this whole arm.
    skip "probe-failure advisory" "$REUSE_HINT"
  elif printf '%s' "$BODY" | grep -q '"advisory":"retailers_probe_failed"'; then
    pass "probe failure surfaces as 200 + advisory:retailers_probe_failed"
    printf '%s' "$BODY" | grep -q '"url":"http' \
      && pass "the mint still happened (url present)" \
      || fail "advisory present but no url: ${BODY:0:200}"
  elif [[ "$CODE" == "200" ]]; then
    skip "probe-failure advisory" "the retailers probe answered CLEANLY (200, no probe_failed advisory) — point the DEPLOYED function's INSTACART_IDP_BASE_URL at a 5xx/hanging stub to exercise this arm"
  else
    note "current outcome: HTTP $CODE — ${BODY:0:200}"
  fi
fi

################################################################################
# 11. Retailers probe answers 200 HEADERS then STALLS THE BODY -> 200
#     advisory:retailers_probe_failed, WITHIN the §4.4 budget.
#
#     Post-review S4: the spec-149 idpFetch cleared its abort timer as soon as
#     `fetch` resolved — i.e. at HEADERS — so a stalled BODY was read with no
#     deadline at all and the advisory probe could pin the whole request past the
#     ~13 s ceiling (§11 risk 2 arriving through the body read). The deadline now
#     covers `.json()`. This arm is the pin: the outcome must be the SAME advisory
#     as arm 10 *and* the wall clock must stay inside STALL_BODY_MAX_SECONDS.
################################################################################
step "Stalled probe BODY still aborts at the 3s budget (post-review S4)"
if [[ -z "$ADMIN_TOKEN" || -z "$STALL_BODY_APPROVAL_ID" ]]; then
  skip "stalled-body budget" "need ADMIN_TOKEN and STALL_BODY_APPROVAL_ID (a FRESH approval)"
else
  note "point the DEPLOYED function's INSTACART_IDP_BASE_URL at a stub whose /idp/v1/retailers"
  note "  sends 200 headers and then HOLDS the body open (>30s), while"
  note "  /idp/v1/products/products_link still 200s promptly, then re-run."
  note "expected: HTTP 200 + \"advisory\":\"retailers_probe_failed\" + a url, in < ${STALL_BODY_MAX_SECONDS}s"
  STALL_T0=$SECONDS
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"approvalId\":\"${STALL_BODY_APPROVAL_ID}\"}" \
    "$FN_URL")
  STALL_ELAPSED=$(( SECONDS - STALL_T0 ))
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  if [[ "$CODE" == "502" || "$CODE" == "504" ]]; then
    fail "stalled probe body surfaced as $CODE — the probe must never refuse the mint (AC-15). Body: ${BODY:0:200}"
  elif [[ "$CODE" == "200" ]] && is_reused "$BODY"; then
    skip "stalled-body budget" "$REUSE_HINT"
  elif printf '%s' "$BODY" | grep -q '"advisory":"retailers_probe_failed"'; then
    pass "stalled probe body surfaces as 200 + advisory:retailers_probe_failed"
    printf '%s' "$BODY" | grep -q '"url":"http' \
      && pass "the mint still happened (url present)" \
      || fail "advisory present but no url: ${BODY:0:200}"
    if [[ "$STALL_ELAPSED" -lt "$STALL_BODY_MAX_SECONDS" ]]; then
      pass "returned in ${STALL_ELAPSED}s (< ${STALL_BODY_MAX_SECONDS}s) — the deadline covered the body read"
    else
      fail "returned in ${STALL_ELAPSED}s (>= ${STALL_BODY_MAX_SECONDS}s) — the abort deadline is NOT covering the body read (S4 regression)"
    fi
    note "cross-check the function log for: advisory=retailers_probe_failed cause=timeout"
  elif [[ "$CODE" == "200" ]]; then
    skip "stalled-body budget" "the retailers probe answered CLEANLY in ${STALL_ELAPSED}s — is the stub actually stalling the body?"
  else
    note "current outcome: HTTP $CODE after ${STALL_ELAPSED}s — ${BODY:0:200}"
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
