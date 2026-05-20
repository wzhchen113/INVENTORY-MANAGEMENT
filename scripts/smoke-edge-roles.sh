#!/usr/bin/env bash
# scripts/smoke-edge-roles.sh — Spec 027 smoke for the send-invite-email
# role gate. Asserts the ADMIN_ROLES Set in the edge function mirrors
# `public.auth_is_privileged()` on the DB side — admin, master, and
# super_admin all reach the post-gate handler.
#
# Sibling of scripts/smoke-edge.sh (which smokes fetch-breadbot-sales)
# and scripts/smoke-rpc.sh (which smokes report_run RPC). Same pass/fail
# output shape, same SKIP idiom for missing creds, same set -u contract.
# Like both siblings, this script runs ALL arms before exiting; FAILs
# accumulate into $FAILED and the final `exit $FAILED` reports non-zero
# if any arm failed (accumulator pattern, not first-failure-aborts).
#
# Convention: edge functions that role-gate must include super_admin in
# ADMIN_ROLES. Reference: supabase/functions/delete-user/index.ts:19.
# DB-side canonical check: public.auth_is_privileged().
#
# Usage:
#   bash scripts/smoke-edge-roles.sh              # default: local stack
#   SUPABASE_URL=https://...                      # remote override
#   SUPABASE_ANON_KEY=...                         # remote override
#   ADMIN_BEARER=...                              # skip Arm 3 login round-trip
#   SUPER_ADMIN_BEARER=...                        # skip Arm 4 promote/login dance
#   ADMIN_EMAIL=admin@local.test                  # override
#   ADMIN_PASSWORD=password                       # override
#
# Behavior with missing creds: Arms 3 and 4 require a working local stack
# (login + docker exec). If either fails, they SKIP rather than FAIL, so
# this script can run in CI without a local stack. Arms 1 and 2 are
# unauth and always run.
#
# State mutation: Arm 4 temporarily promotes admin@local.test to
# super_admin and reverts via `trap restore_admin EXIT`. The restore runs
# on any exit path (success, fail, SIGINT). If interrupted between mutate
# and restore (kill -9), recover with:
#   docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
#     "update public.profiles set role='admin', \
#      brand_id='2a000000-0000-0000-0000-000000000001' \
#      where id=(select id from auth.users where email='admin@local.test' limit 1);"
#
# Exit code: non-zero on failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"

# Defense-in-depth: this script MUTATES state on the target stack (Arm 4
# promotes admin@local.test to super_admin and reverts via EXIT trap).
# If $SUPABASE_URL is ever pointed at a remote / prod stack by accident,
# the docker exec would silently SKIP — but we refuse to run at all
# rather than rely on that, so a misconfigured environment is loud.
# Reviewer: security-auditor spec 027 M1.
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    printf '\033[31mREFUSE\033[0m smoke-edge-roles.sh mutates state and only runs against a local stack.\n' >&2
    printf '       SUPABASE_URL=%s is non-local. Aborting.\n' "$SUPABASE_URL" >&2
    exit 2
    ;;
esac

# Local publishable/anon API key. Stable across `supabase start`s on the
# same project_id. Safe to commit — this is the public key. Same value
# as scripts/smoke-rpc.sh:45.
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH}"

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password}"
ADMIN_BEARER="${ADMIN_BEARER:-}"
SUPER_ADMIN_BEARER="${SUPER_ADMIN_BEARER:-}"
BRAND_A="2a000000-0000-0000-0000-000000000001"
ORIGIN="${ORIGIN:-https://hopeful-lewin.vercel.app}"

FN_URL="${SUPABASE_URL}/functions/v1/send-invite-email"
FAILED=0
PROMOTED=0  # tracks whether Arm 4 ran the promotion (so trap knows to restore)

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step() { printf '\n== %s ==\n' "$1"; }

# Restore admin@local.test to admin role + brand A. Runs even on failure
# via `trap restore_admin EXIT`. Guarded by PROMOTED flag so we don't try
# to revert state we never mutated.
restore_admin() {
  local exit_code=$?
  if [[ "$PROMOTED" == "1" ]]; then
    printf '\n== restore admin@local.test ==\n'
    if docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
      "update public.profiles set role='admin', brand_id='${BRAND_A}' \
       where id=(select id from auth.users where email='${ADMIN_EMAIL}' limit 1);" \
      >/dev/null 2>&1; then
      pass "restored ${ADMIN_EMAIL} to admin role"
    else
      printf '  \033[31mWARN\033[0m could not restore %s — recover manually (see header)\n' "$ADMIN_EMAIL"
    fi
  fi
  exit "$exit_code"
}
trap restore_admin EXIT

################################################################################
# Arm 1 — CORS preflight (no auth). Same shape as smoke-edge.sh:53-71.
################################################################################
step "Arm 1: CORS preflight"
HEADERS=$(curl -sS -D - -o /dev/null -X OPTIONS \
  -H "Origin: ${ORIGIN}" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  "$FN_URL" 2>&1)

STATUS=$(printf '%s' "$HEADERS" | head -1 | grep -oE '[0-9]{3}' | head -1)
if [[ "$STATUS" == "200" || "$STATUS" == "204" ]]; then
  pass "OPTIONS returns ${STATUS}"
else
  fail "OPTIONS returns ${STATUS} (expected 200 or 204)"
fi

printf '%s' "$HEADERS" | grep -qi '^access-control-allow-origin:' \
  && pass "has access-control-allow-origin" \
  || fail "missing access-control-allow-origin"
printf '%s' "$HEADERS" | grep -qi '^access-control-allow-methods:.*POST' \
  && pass "allows POST" \
  || fail "missing/incorrect access-control-allow-methods"
printf '%s' "$HEADERS" | grep -qi '^access-control-allow-headers:.*authorization' \
  && pass "allows authorization header" \
  || fail "missing authorization in access-control-allow-headers"

################################################################################
# Arm 2 — POST without Authorization → 401. Same shape as smoke-edge.sh:77-85.
################################################################################
step "Arm 2: POST without Authorization header"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$FN_URL")
# Either the Supabase gateway (verify_jwt=true) or the function's own
# requireAdminCaller entry guard returns 401. Both shapes satisfy the
# "no anon access" assertion.
if [[ "$CODE" == "401" ]]; then
  pass "no-auth POST returns 401"
else
  fail "no-auth POST returns $CODE (expected 401)"
fi

################################################################################
# Arm 3 — POST with admin JWT → gate passes (200 or 4xx post-gate).
################################################################################
step "Arm 3: POST with admin JWT"
if [[ -z "${ADMIN_BEARER}" ]]; then
  # Try to mint a token via the local stack.
  LOGIN=$(curl -sS -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    "${SUPABASE_URL}/auth/v1/token?grant_type=password" 2>/dev/null || echo "")
  ADMIN_BEARER=$(printf '%s' "$LOGIN" | jq -r '.access_token // empty' 2>/dev/null || echo "")
fi

if [[ -z "${ADMIN_BEARER}" ]]; then
  skip "admin-JWT arm" "no ADMIN_BEARER and local stack login failed (no local stack?)"
else
  RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${ADMIN_BEARER}" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "$FN_URL")
  CODE=$(printf '%s' "$RESPONSE" | tail -1)
  BODY=$(printf '%s' "$RESPONSE" | sed '$d')
  # Gate-passes shape: empty body triggers the post-gate "email and name
  # required" check (line 49 of send-invite-email/index.ts) → 400. A 200
  # would mean the body was valid + Resend succeeded (won't happen on
  # local — no RESEND_API_KEY — but accept it for prod-style runs). 401
  # means the gate rejected the token entirely (or login was stale).
  # 403 means the role gate rejected — that is the regression detector
  # in Arm 4 (and would also be wrong here for admin).
  if [[ "$CODE" == "200" || "$CODE" == "400" ]]; then
    pass "admin JWT reaches post-gate handler (HTTP ${CODE})"
    if [[ "$CODE" == "400" ]]; then
      printf '%s' "$BODY" | grep -qi 'email and name required' \
        && pass "post-gate validation message present" \
        || fail "expected 'email and name required', got: ${BODY:0:200}"
    fi
  elif [[ "$CODE" == "401" ]]; then
    fail "admin JWT rejected at entry guard (401) — login likely stale: ${BODY:0:200}"
  elif [[ "$CODE" == "403" ]]; then
    fail "admin JWT rejected by role gate (403) — admin should always pass: ${BODY:0:200}"
  else
    fail "admin JWT returned unexpected ${CODE}: ${BODY:0:200}"
  fi
fi

################################################################################
# Arm 4 — POST with super_admin JWT → gate passes. LOAD-BEARING.
#
# Pre-fix (spec 027 Track A not applied): super_admin returns 403 because
# ADMIN_ROLES = {admin, master}.
# Post-fix: super_admin returns 200/400 (same shape as Arm 3).
################################################################################
step "Arm 4: POST with super_admin JWT (load-bearing — regression detector)"

if [[ -z "${SUPER_ADMIN_BEARER}" ]]; then
  # Promote admin@local.test to super_admin. The profiles_sync_role_to_jwt
  # AFTER trigger fires on UPDATE and writes app_metadata.role into
  # auth.users.raw_app_meta_data. A FRESH login is required to mint a
  # JWT containing the new claim — the trigger updates source-of-truth,
  # not in-flight tokens.
  if ! docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
    "update public.profiles set role='super_admin', brand_id=null \
     where id=(select id from auth.users where email='${ADMIN_EMAIL}' limit 1);" \
    >/dev/null 2>&1; then
    skip "super_admin arm" "docker exec to local postgres failed (no local stack?)"
  else
    PROMOTED=1
    LOGIN_S=$(curl -sS -X POST \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
      "${SUPABASE_URL}/auth/v1/token?grant_type=password" 2>/dev/null || echo "")
    SUPER_ADMIN_BEARER=$(printf '%s' "$LOGIN_S" | jq -r '.access_token // empty' 2>/dev/null || echo "")
    if [[ -z "${SUPER_ADMIN_BEARER}" ]]; then
      fail "could not mint super_admin JWT after promotion: ${LOGIN_S:0:200}"
    fi
  fi
fi

if [[ -n "${SUPER_ADMIN_BEARER}" ]]; then
  RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPER_ADMIN_BEARER}" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "$FN_URL")
  CODE=$(printf '%s' "$RESPONSE" | tail -1)
  BODY=$(printf '%s' "$RESPONSE" | sed '$d')
  if [[ "$CODE" == "200" || "$CODE" == "400" ]]; then
    pass "super_admin JWT reaches post-gate handler (HTTP ${CODE})"
    if [[ "$CODE" == "400" ]]; then
      printf '%s' "$BODY" | grep -qi 'email and name required' \
        && pass "post-gate validation message present" \
        || fail "expected 'email and name required', got: ${BODY:0:200}"
    fi
  elif [[ "$CODE" == "403" ]]; then
    fail "super_admin JWT rejected by role gate (403) — Track A regression: ${BODY:0:200}"
  elif [[ "$CODE" == "401" ]]; then
    fail "super_admin JWT rejected at entry guard (401) — fresh-login likely failed: ${BODY:0:200}"
  else
    fail "super_admin JWT returned unexpected ${CODE}: ${BODY:0:200}"
  fi
fi

################################################################################
# Arm 5 — Response body does NOT echo unescaped <script> markup. Spec 028.
#
# Defense-in-depth check that the function's JSON response path does not
# reflect unsanitized caller input back. The primary attack surface (the
# rendered HTML email body) is covered by:
#   - Track C jest tests on src/utils/escapeHtml.ts
#   - Manual CT6 gate (developer runs one curl + one docker-logs-grep)
# This arm catches the secondary case: the function 4xx'ing with an
# error message that echoes the literal tag.
#
# Reuses Arm 3's $ADMIN_BEARER. SKIPs if Arm 3 could not mint a token.
# Best-effort cleanup deletes the auth.users row created via the
# auth.admin.inviteUserByEmail fallback (no RESEND_API_KEY locally).
################################################################################
step "Arm 5: response body does not echo unescaped <script> markup (spec 028)"
if [[ -z "${ADMIN_BEARER}" ]]; then
  skip "escape-test arm" "no ADMIN_BEARER (no local stack?)"
else
  ESCAPE_EMAIL="escape-test-${RANDOM}@local.test"
  PAYLOAD=$(printf '{"email":"%s","name":"<script>x</script>","role":"user","storeNames":""}' "$ESCAPE_EMAIL")
  RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${ADMIN_BEARER}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$FN_URL")
  CODE=$(printf '%s' "$RESPONSE" | tail -1)
  BODY=$(printf '%s' "$RESPONSE" | sed '$d')

  # Pass conditions:
  # - HTTP status is 200 (Resend fallthrough → Supabase Auth invite, success
  #   on fresh email) OR 4xx (validation or rate-limit; both legitimate
  #   non-crash exits).
  # - Response body does NOT contain literal "<script>" (case-insensitive).
  if [[ "$CODE" == "200" || "$CODE" =~ ^4[0-9][0-9]$ ]]; then
    if printf '%s' "$BODY" | grep -qi '<script>'; then
      fail "response body echoed unescaped <script> markup: ${BODY:0:200}"
    else
      pass "response body does not reflect unescaped tag (HTTP ${CODE})"
    fi
  else
    fail "unexpected ${CODE}: ${BODY:0:200}"
  fi

  # Best-effort cleanup: delete the auth.users row we may have created
  # via the auth.admin.inviteUserByEmail fallback. Local-only.
  docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
    "delete from auth.users where email='${ESCAPE_EMAIL}';" \
    >/dev/null 2>&1 || true
fi

################################################################################
# Arm 6 — last-super-admin delete refusal. Spec 031.
#
# Reuses Arm 4's super_admin promotion (PROMOTED=1 and SUPER_ADMIN_BEARER set).
# After Arm 4 runs, admin@local.test is the sole super_admin row in profiles.
# This arm POSTs delete-user with the promoted user as both caller and target —
# the function should refuse with HTTP 400 AND no state mutation should occur.
#
# Either refusal string is acceptable (spec AC line 182-189):
#   - "cannot delete self" (the self-delete refusal at line 59-64) — fires
#     FIRST per the design at §4 ordering, so this is what we expect in
#     practice.
#   - "cannot delete the last super_admin" (the new last-of-role refusal at
#     P0001 → HTTP 400) — would fire if a future dev reorders the checks.
#
# State-mutation invariant: re-query super_admin count after the refused
# call. Must still be 1. If it changed, the function partial-deleted before
# refusing — that's a FAIL.
################################################################################
step "Arm 6: last-super-admin delete refusal (spec 031)"
DELETE_USER_URL="${SUPABASE_URL}/functions/v1/delete-user"

if [[ "$PROMOTED" != "1" ]]; then
  skip "last-super-admin arm" "Arm 4 super_admin promotion did not run"
elif [[ -z "${SUPER_ADMIN_BEARER}" ]]; then
  skip "last-super-admin arm" "no SUPER_ADMIN_BEARER (Arm 4 login failed?)"
else
  SA_COUNT=$(docker exec -i supabase_db_imr-inventory psql -tA \
    -U postgres -d postgres \
    -c "select count(*) from public.profiles where role='super_admin';" \
    2>/dev/null | tr -d ' ')
  if [[ "$SA_COUNT" != "1" ]]; then
    skip "last-super-admin arm" "super_admin count is ${SA_COUNT:-?} (need exactly 1 for this arm)"
  else
    pass "pre-check: exactly one super_admin row in profiles"

    ADMIN_UID=$(docker exec -i supabase_db_imr-inventory psql -tA \
      -U postgres -d postgres \
      -c "select id from auth.users where email='${ADMIN_EMAIL}' limit 1;" \
      2>/dev/null | tr -d ' ')

    if [[ -z "$ADMIN_UID" ]]; then
      fail "could not resolve admin uid for ${ADMIN_EMAIL}"
    else
      RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
        -H "apikey: ${SUPABASE_ANON_KEY}" \
        -H "Authorization: Bearer ${SUPER_ADMIN_BEARER}" \
        -H "Content-Type: application/json" \
        -d "{\"userId\":\"${ADMIN_UID}\"}" \
        "$DELETE_USER_URL")
      CODE=$(printf '%s' "$RESPONSE" | tail -1)
      BODY=$(printf '%s' "$RESPONSE" | sed '$d')

      if [[ "$CODE" == "400" ]]; then
        if printf '%s' "$BODY" | grep -qE '"error":"cannot delete (self|the last super_admin)"'; then
          pass "delete-user refused (HTTP 400, $BODY)"
        else
          fail "expected refusal string ('cannot delete self' or 'cannot delete the last super_admin'), got: ${BODY:0:200}"
        fi
      else
        fail "expected 400, got $CODE: ${BODY:0:200}"
      fi

      # State-mutation invariant: super_admin count must still be 1.
      POST_SA_COUNT=$(docker exec -i supabase_db_imr-inventory psql -tA \
        -U postgres -d postgres \
        -c "select count(*) from public.profiles where role='super_admin';" \
        2>/dev/null | tr -d ' ')
      if [[ "$POST_SA_COUNT" == "1" ]]; then
        pass "post-check: super_admin count unchanged (still 1) — function did not partial-delete"
      else
        fail "post-check: super_admin count changed to ${POST_SA_COUNT:-?} (expected 1) — function partial-deleted before refusing"
      fi
    fi
  fi
fi

################################################################################
# Arm 7 — self-demote refusal (spec 050). Defense-in-depth.
#
# Reuses Arm 3's $ADMIN_BEARER (plain admin). Does NOT reuse Arm 4's
# super_admin promotion — the self-demote check is meaningful at any
# admin role (admin, master, super_admin), so the cheaper path is the
# plain-admin login from Arm 3. Avoids contaminating Arm 4's
# PROMOTED=1 / restore_admin machinery.
#
# PostgREST RPC error mapping: the function raises with SQLSTATE P0001
# message 'cannot demote self'. PostgREST maps P0001 → HTTP 400. The
# assertion below pins on BOTH the status code AND the message string —
# if the version mapping shifts in a future Supabase upgrade, the
# message assertion is the load-bearing test (same posture as Arm 6
# from spec 031).
#
# State-mutation invariant: the admin row is re-queried after the
# refusal. role and brand_id must be unchanged — confirms the refusal
# fired BEFORE the UPDATE side-effect.
################################################################################
step "Arm 7: self-demote refusal (spec 050)"
DEMOTE_RPC_URL="${SUPABASE_URL}/rest/v1/rpc/demote_profile_to_user"

if [[ -z "${ADMIN_BEARER}" ]]; then
  skip "self-demote arm" "no ADMIN_BEARER (Arm 3 login failed?)"
else
  ADMIN_UID=$(docker exec -i supabase_db_imr-inventory psql -tA \
    -U postgres -d postgres \
    -c "select id from auth.users where email='${ADMIN_EMAIL}' limit 1;" \
    2>/dev/null | tr -d ' ')

  if [[ -z "$ADMIN_UID" ]]; then
    fail "could not resolve admin uid for ${ADMIN_EMAIL}"
  else
    # Snapshot pre-state for the state-mutation invariant. Arm 4 may
    # have promoted admin@local.test to super_admin (brand_id=null) and
    # then restore_admin reverts back to admin/brand_a on EXIT — but
    # this arm runs BEFORE the trap fires, so the pre-state can be
    # either (admin, brand_a) or (super_admin, null) depending on
    # whether Arm 4 ran. We snapshot what's actually there.
    PRE_ROLE=$(docker exec -i supabase_db_imr-inventory psql -tA \
      -U postgres -d postgres \
      -c "select role from public.profiles where id='${ADMIN_UID}';" \
      2>/dev/null | tr -d ' ')
    PRE_BRAND=$(docker exec -i supabase_db_imr-inventory psql -tA \
      -U postgres -d postgres \
      -c "select coalesce(brand_id::text, 'NULL') from public.profiles where id='${ADMIN_UID}';" \
      2>/dev/null | tr -d ' ')

    RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${ADMIN_BEARER}" \
      -H "Content-Type: application/json" \
      -d "{\"target_user_id\":\"${ADMIN_UID}\"}" \
      "$DEMOTE_RPC_URL")
    CODE=$(printf '%s' "$RESPONSE" | tail -1)
    BODY=$(printf '%s' "$RESPONSE" | sed '$d')

    # PostgREST maps P0001 → HTTP 400. The body is a PostgrestError JSON:
    #   {"code":"P0001","details":null,"hint":null,"message":"cannot demote self"}
    # The message-string assertion is the load-bearing test (the status
    # mapping can drift across Supabase versions; the string is the
    # stable contract).
    if [[ "$CODE" == "400" ]]; then
      if printf '%s' "$BODY" | grep -qE '"message":"cannot demote self"'; then
        pass "demote_profile_to_user RPC refused self (HTTP 400, $BODY)"
      else
        fail "expected message 'cannot demote self', got: ${BODY:0:200}"
      fi
    else
      fail "expected 400, got $CODE: ${BODY:0:200}"
    fi

    # State-mutation invariant: admin row unchanged. Confirms the
    # refusal fired BEFORE the UPDATE side-effect.
    POST_ROLE=$(docker exec -i supabase_db_imr-inventory psql -tA \
      -U postgres -d postgres \
      -c "select role from public.profiles where id='${ADMIN_UID}';" \
      2>/dev/null | tr -d ' ')
    POST_BRAND=$(docker exec -i supabase_db_imr-inventory psql -tA \
      -U postgres -d postgres \
      -c "select coalesce(brand_id::text, 'NULL') from public.profiles where id='${ADMIN_UID}';" \
      2>/dev/null | tr -d ' ')
    if [[ "$POST_ROLE" == "$PRE_ROLE" && "$POST_BRAND" == "$PRE_BRAND" ]]; then
      pass "post-check: admin role/brand_id unchanged (role=${POST_ROLE}, brand=${POST_BRAND})"
    else
      fail "post-check: admin mutated (role ${PRE_ROLE}→${POST_ROLE}, brand ${PRE_BRAND}→${POST_BRAND})"
    fi
  fi
fi

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m✓ all checks passed\033[0m\n'
else
  printf '\033[31m✗ some checks failed\033[0m\n'
fi
# Exit code is set by trap (it returns the exit code that triggered it).
# We pre-set $? here so the trap restore step uses our intended status.
exit $FAILED
