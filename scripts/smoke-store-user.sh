#!/usr/bin/env bash
# scripts/smoke-store-user.sh — Spec 165 smoke for the `manage-store-user`
# edge function (admin "Add user" with username + password and no email, plus
# admin "Set password" for username-only store users).
#
# Sibling of scripts/smoke-edge-roles.sh: same pass/fail/skip output, same
# accumulator contract (every arm runs; `exit $FAILED` at the end), same
# local-only refusal, same EXIT-trap cleanup.
#
# Arms (spec 165 §10):
#    1 no bearer → 401                       11 duplicate username → 409 (+ no orphan)
#    2 `user` bearer → 403                   12 username-resolve + password sign-in
#    3 cross-brand store → 403               13 set_password on self → 400
#    4 storeIds [] → 400                     14 set_password on an admin → 403
#    5 brand A + brand B stores → 400        15 set_password on a real-email user → 400
#    6 username "A!" → 400                   16 S-REV: set_password revokes sessions
#    7 reserved "admin" → 400                17 old password fails / new works
#    8 short password → 400                  18 no response body leaks password/placeholder
#    9 happy path → 201 + DB assertions      19 mail catcher has zero messages
#   10 role:"admin" in body ignored          C  compensation (forced user_stores failure)
#  14b set_password on a placeholder user whose app_metadata.role != 'user' → 403
#    A audit trail (spec 167): server-side audit_log rows for create /
#      set_password (A1-A9), zero rows for refused paths, no secrets
#   AF AC-4 failure injection (spec 167): forced audit_log insert failure
#
# Usage:
#   bash scripts/smoke-store-user.sh            # local stack only (refuses remote)
#
# Fixtures: admin@local.test (brand A admin) and manager@local.test
# (role='user', real email). The script creates, and removes in its EXIT trap:
#   - brand "zz_s165 brand B" + one store in it (docker psql)
#   - every auth user whose profile username or email starts with zz_s165
#   - a temporary trigger public.zz_s165_fail_user_stores (arm C only)
#   - a temporary trigger public.zz_s167_fail_audit_log (arm AF only)
# If interrupted with kill -9, recover with:
#   docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
#     "drop trigger if exists zz_s165_fail_user_stores on public.user_stores;
#      drop function if exists public.zz_s165_fail_user_stores();
#      drop trigger if exists zz_s167_fail_audit_log on public.audit_log;
#      drop function if exists public.zz_s167_fail_audit_log();
#      delete from public.audit_log where action in ('Store user created','Store user password set')
#         and item_ref like 'zz_s165%';
#      delete from auth.users where id in (select id from public.profiles where username like 'zz_s165%')
#         or email like 'zz_s165%';
#      delete from public.stores where name = 'zz_s165 store B';
#      delete from public.brands where name = 'zz_s165 brand B';"
#
# Known local limitation: `username-resolve` needs USERNAME_RESOLVE_SERVICE_TOKEN
# on the edge runtime. When it is unset or mismatched locally, arm 12's
# resolve step SKIPs (recorded, not worked around); the password sign-in is
# still proven against the placeholder email read from auth.users.
#
# Exit code: non-zero on failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    printf '\033[31mREFUSE\033[0m smoke-store-user.sh mutates state and only runs against a local stack.\n' >&2
    printf '       SUPABASE_URL=%s is non-local. Aborting.\n' "$SUPABASE_URL" >&2
    exit 2
    ;;
esac

DB_CONTAINER="supabase_db_imr-inventory"
EDGE_CONTAINER="supabase_edge_runtime_imr-inventory"
MAILPIT_URL="${MAILPIT_URL:-http://127.0.0.1:54324}"
FN_URL="${SUPABASE_URL}/functions/v1/manage-store-user"
BRAND_A="2a000000-0000-0000-0000-000000000001"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password}"
USER_EMAIL="${USER_EMAIL:-manager@local.test}"
USER_PASSWORD="${USER_PASSWORD:-password}"

FAILED=0
BODIES_FILE="$(mktemp -t smoke-store-user.XXXXXX)"
TRIGGER_INSTALLED=0
AUDIT_TRIGGER_INSTALLED=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step() { printf '\n== %s ==\n' "$1"; }

psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atc "$1" 2>/dev/null; }

cleanup() {
  local exit_code=$?
  printf '\n== cleanup ==\n'
  if [[ "$TRIGGER_INSTALLED" == "1" ]]; then
    psql_q "drop trigger if exists zz_s165_fail_user_stores on public.user_stores; drop function if exists public.zz_s165_fail_user_stores();" >/dev/null \
      && pass "dropped temporary failure trigger" \
      || printf '  \033[31mWARN\033[0m could not drop zz_s165_fail_user_stores — see header\n'
  fi
  if [[ "$AUDIT_TRIGGER_INSTALLED" == "1" ]]; then
    psql_q "drop trigger if exists zz_s167_fail_audit_log on public.audit_log; drop function if exists public.zz_s167_fail_audit_log();" >/dev/null \
      && pass "dropped temporary audit_log failure trigger" \
      || printf '  \033[31mWARN\033[0m could not drop zz_s167_fail_audit_log — see header\n'
  fi
  psql_q "delete from public.audit_log where action in ('Store user created','Store user password set') and item_ref like 'zz_s165%';
          delete from auth.users where id in (select id from public.profiles where username like 'zz_s165%') or email like 'zz_s165%';
          delete from public.stores where name = 'zz_s165 store B';
          delete from public.brands where name = 'zz_s165 brand B';" >/dev/null \
    && pass "removed zz_s165 users, store B, brand B" \
    || printf '  \033[31mWARN\033[0m cleanup failed — see header for manual recovery\n'
  rm -f "$BODIES_FILE"
  exit "$exit_code"
}
trap cleanup EXIT

# ── keys + preflight ────────────────────────────────────────────────────────
step "preflight"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  skip "all arms" "local stack not running (npm run dev:db)"
  exit 0
fi
ANON_KEY="${SUPABASE_ANON_KEY:-$(docker exec "$EDGE_CONTAINER" printenv SUPABASE_ANON_KEY 2>/dev/null)}"
SERVICE_KEY="$(docker exec "$EDGE_CONTAINER" printenv SUPABASE_SERVICE_ROLE_KEY 2>/dev/null)"
RESOLVE_TOKEN="${EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN:-$(grep -h '^EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN=' .env .env.local 2>/dev/null | tail -1 | cut -d= -f2-)}"
if [[ -z "$ANON_KEY" || -z "$SERVICE_KEY" ]]; then
  fail "could not read SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY from $EDGE_CONTAINER"
  exit 1
fi
pass "read local keys"

# login <email> <password> → prints the token JSON (empty on failure)
login_json() {
  curl -sS -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg e "$1" --arg p "$2" '{email:$e,password:$p}')"
}
login_code() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg e "$1" --arg p "$2" '{email:$e,password:$p}')"
}

# call <bearer|""> <json body> → sets CODE and BODY; records BODY for arm 18
call() {
  local bearer="$1" body="$2" out
  if [[ -n "$bearer" ]]; then
    out=$(curl -sS -w '\n%{http_code}' -X POST "$FN_URL" -H "Content-Type: application/json" \
      -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${bearer}" -d "$body")
  else
    out=$(curl -sS -w '\n%{http_code}' -X POST "$FN_URL" -H "Content-Type: application/json" -d "$body")
  fi
  CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
  printf '%s\n' "$BODY" >> "$BODIES_FILE"
}

# expect <label> <code> [error-string]
expect() {
  local label="$1" want_code="$2" want_err="${3:-}" got_err
  got_err=$(printf '%s' "$BODY" | jq -r '.error // empty' 2>/dev/null)
  if [[ "$CODE" != "$want_code" ]]; then
    fail "$label → HTTP $CODE (expected $want_code) body=$BODY"
  elif [[ -n "$want_err" && "$got_err" != "$want_err" ]]; then
    fail "$label → error '$got_err' (expected '$want_err')"
  else
    pass "$label → $CODE${want_err:+ '$want_err'}"
  fi
}

ADMIN_JSON=$(login_json "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
ADMIN_BEARER=$(printf '%s' "$ADMIN_JSON" | jq -r '.access_token // empty')
ADMIN_ID=$(printf '%s' "$ADMIN_JSON" | jq -r '.user.id // empty')
USER_JSON=$(login_json "$USER_EMAIL" "$USER_PASSWORD")
USER_BEARER=$(printf '%s' "$USER_JSON" | jq -r '.access_token // empty')
USER_ID=$(printf '%s' "$USER_JSON" | jq -r '.user.id // empty')
if [[ -z "$ADMIN_BEARER" || -z "$USER_BEARER" ]]; then
  fail "could not sign in fixtures ($ADMIN_EMAIL / $USER_EMAIL)"
  exit 1
fi
pass "signed in $ADMIN_EMAIL (admin) and $USER_EMAIL (user)"

# Brand A stores (two, so the happy path asserts one user_stores row per store)
STORE_A1=$(psql_q "select id from public.stores where brand_id='${BRAND_A}' order by name limit 1")
STORE_A2=$(psql_q "select id from public.stores where brand_id='${BRAND_A}' order by name offset 1 limit 1")
BRAND_B=$(psql_q "insert into public.brands (name) values ('zz_s165 brand B') returning id" | head -1)
STORE_B=$(psql_q "insert into public.stores (name, brand_id, address) values ('zz_s165 store B', '${BRAND_B}', '1 Smoke St') returning id" | head -1)
if [[ -z "$STORE_A1" || -z "$STORE_A2" || -z "$STORE_B" ]]; then
  fail "fixture stores missing (A1=$STORE_A1 A2=$STORE_A2 B=$STORE_B)"
  exit 1
fi
pass "fixtures: brand A stores $STORE_A1, $STORE_A2; brand B store $STORE_B"

# Spec 167 audit baseline (Arm A7 asserts the exact delta) + log window (A9).
AUDIT_ACTIONS_SQL="action in ('Store user created','Store user password set')"
AUDIT_BASE=$(psql_q "select count(*) from public.audit_log where $AUDIT_ACTIONS_SQL")
SMOKE_T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)

SUFFIX=$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
U_MAIN="zz_s165_${SUFFIX}"        # 14 chars
U_ROLE="zz_s165_r${SUFFIX}"       # 15 chars
U_COMP="zz_s165_c${SUFFIX}"       # 15 chars
PW1="S165-first-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
PW2="S165-second-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
PLACEHOLDER_COUNT_SQL="select count(*) from auth.users where email ~ '^u-[0-9a-f]{32}@no-email\\.invalid\$'"

create_body() { # <username> <password> <storeIds JSON array> [extra jq object]
  local extra="${4:-}"
  [[ -z "$extra" ]] && extra='{}'
  jq -cn --arg u "$1" --arg p "$2" --argjson s "$3" --argjson x "$extra" \
    '{action:"create", name:"Smoke Store User", username:$u, password:$p, storeIds:$s} + $x'
}

################################################################################
step "Arm 1: no bearer → 401"
call "" "$(create_body "$U_MAIN" "$PW1" "[\"$STORE_A1\"]")"
[[ "$CODE" == "401" ]] && pass "no bearer → 401" || fail "no bearer → $CODE (expected 401)"

step "Arm 2: user-role bearer → 403"
call "$USER_BEARER" "$(create_body "$U_MAIN" "$PW1" "[\"$STORE_A1\"]")"
expect "create as role=user" 403 "forbidden"
call "$USER_BEARER" "$(jq -cn --arg id "$ADMIN_ID" '{action:"set_password", userId:$id, password:"whatever-123"}')"
expect "set_password as role=user" 403 "forbidden"

step "Arm 3: admin with a cross-brand store → 403"
call "$ADMIN_BEARER" "$(create_body "$U_MAIN" "$PW1" "[\"$STORE_B\"]")"
expect "brand-A admin → brand-B store" 403 "forbidden: target is in a different brand"

step "Arm 4: empty storeIds → 400"
call "$ADMIN_BEARER" "$(create_body "$U_MAIN" "$PW1" "[]")"
expect "storeIds []" 400 "at least one store is required"

step "Arm 5: mixed-brand stores → 400"
call "$ADMIN_BEARER" "$(create_body "$U_MAIN" "$PW1" "[\"$STORE_A1\",\"$STORE_B\"]")"
expect "brand A + brand B" 400 "stores must belong to one brand"
call "$ADMIN_BEARER" "$(create_body "$U_MAIN" "$PW1" "[\"00000000-0000-0000-0000-00000000dead\"]")"
expect "unknown store id" 400 "unknown store"

step "Arm 6: bad username format → 400"
call "$ADMIN_BEARER" "$(create_body "A!" "$PW1" "[\"$STORE_A1\"]")"
expect "username 'A!'" 400 "username must be 3-20 characters: a-z, 0-9, _ or ."

step "Arm 7: reserved username → 400"
call "$ADMIN_BEARER" "$(create_body "Admin" "$PW1" "[\"$STORE_A1\"]")"
expect "username 'Admin'" 400 "username is reserved"

step "Arm 8: short password → 400"
call "$ADMIN_BEARER" "$(create_body "$U_MAIN" "short7!" "[\"$STORE_A1\"]")"
expect "7-char password" 400 "password must be at least 8 characters"

step "Misc: invalid JSON / unknown action / blank name"
call "$ADMIN_BEARER" "{not json"
expect "malformed JSON" 400 "invalid JSON"
call "$ADMIN_BEARER" '{"action":"promote"}'
expect "unknown action" 400 "unknown action"
call "$ADMIN_BEARER" "$(create_body "$U_MAIN" "$PW1" "[\"$STORE_A1\"]" '{"name":"   "}')"
expect "blank name" 400 "name is required"

[[ "$(psql_q "select count(*) from public.profiles where username like 'zz_s165%'")" == "0" ]] \
  && pass "no profile created by any refused request" \
  || fail "a refused request left a zz_s165 profile behind"

################################################################################
step "Arm 9: happy path → 201"
PH_BEFORE=$(psql_q "$PLACEHOLDER_COUNT_SQL")
# Mixed-case username + duplicate store id: server must lowercase + dedupe.
call "$ADMIN_BEARER" "$(create_body "$(printf '%s' "$U_MAIN" | tr 'a-z' 'A-Z')" "$PW1" "[\"$STORE_A1\",\"$STORE_A2\",\"$STORE_A1\"]")"
expect "create" 201
NEW_ID=$(printf '%s' "$BODY" | jq -r '.id // empty')
[[ "$(printf '%s' "$BODY" | jq -c 'keys')" == '["id","username"]' ]] \
  && pass "response keys are exactly {id, username}" || fail "response keys: $BODY"
[[ "$(printf '%s' "$BODY" | jq -r '.username')" == "$U_MAIN" ]] \
  && pass "username stored lowercased ($U_MAIN)" || fail "username in response: $BODY"
if [[ -n "$NEW_ID" ]]; then
  ROW=$(psql_q "select p.role, p.brand_id, p.username, p.status, p.initials, p.color,
                       (select count(*) from public.user_stores us where us.user_id=p.id),
                       u.raw_app_meta_data->>'role', (u.email_confirmed_at is not null),
                       (u.email ~ '^u-[0-9a-f]{32}@no-email\\.invalid\$'), u.email
                  from public.profiles p join auth.users u on u.id=p.id where p.id='${NEW_ID}'")
  IFS='|' read -r R_ROLE R_BRAND R_USER R_STATUS R_INIT R_COLOR R_US R_JWTROLE R_CONF R_SHAPE NEW_EMAIL <<<"$ROW"
  [[ "$R_ROLE" == "user" ]] && pass "profiles.role = user" || fail "profiles.role = $R_ROLE"
  [[ "$R_BRAND" == "$BRAND_A" ]] && pass "profiles.brand_id = brand A (derived)" || fail "brand_id = $R_BRAND"
  [[ "$R_USER" == "$U_MAIN" && "$R_STATUS" == "active" ]] && pass "username + status=active" || fail "username/status = $R_USER/$R_STATUS"
  [[ "$R_INIT" == "SS" && "$R_COLOR" == "#378ADD" ]] && pass "initials SS, color #378ADD" || fail "initials/color = $R_INIT/$R_COLOR"
  [[ "$R_US" == "2" ]] && pass "one user_stores row per distinct store (2)" || fail "user_stores rows = $R_US"
  [[ "$R_JWTROLE" == "user" ]] && pass "raw_app_meta_data.role = user" || fail "app_metadata.role = $R_JWTROLE"
  [[ "$R_CONF" == "t" ]] && pass "email_confirmed_at set" || fail "email not confirmed"
  [[ "$R_SHAPE" == "t" ]] && pass "auth email matches the placeholder regex" || fail "auth email shape wrong"
  [[ "$NEW_EMAIL" != *"${U_MAIN}"* && "$NEW_EMAIL" != *"${NEW_ID//-/}"* ]] \
    && pass "placeholder is independent of username and user id" || fail "placeholder derived from username/id"
else
  fail "no id in create response; skipping DB assertions"
  NEW_EMAIL=""
fi

step "Arm 10: role/brand/email in the body are ignored"
call "$ADMIN_BEARER" "$(create_body "$U_ROLE" "$PW1" "[\"$STORE_A1\"]" \
  "$(jq -cn --arg b "$BRAND_B" '{role:"admin", brand_id:$b, brandId:$b, email:"zz_s165_evil@local.test", id:"00000000-0000-0000-0000-000000000bad"}')")"
expect "create with role:admin" 201
ROLE_ID=$(printf '%s' "$BODY" | jq -r '.id // empty')
[[ "$ROLE_ID" != "00000000-0000-0000-0000-000000000bad" ]] && pass "client id ignored" || fail "client id honoured"
[[ "$(psql_q "select role||'|'||brand_id from public.profiles where id='${ROLE_ID}'")" == "user|${BRAND_A}" ]] \
  && pass "still role=user, brand A" || fail "role/brand honoured from body"
[[ "$(psql_q "select count(*) from auth.users where email='zz_s165_evil@local.test'")" == "0" ]] \
  && pass "client email ignored" || fail "client email honoured"

step "Arm 11: duplicate username → 409 (and nothing orphaned)"
PH_MID=$(psql_q "$PLACEHOLDER_COUNT_SQL")
call "$ADMIN_BEARER" "$(create_body "$U_MAIN" "$PW1" "[\"$STORE_A1\"]")"
expect "duplicate username" 409 "username taken"
call "$ADMIN_BEARER" "$(create_body "$(printf '%s' "$U_MAIN" | tr 'a-z' 'A-Z')" "$PW1" "[\"$STORE_A1\"]")"
expect "duplicate username (case-insensitive)" 409 "username taken"
[[ "$(psql_q "$PLACEHOLDER_COUNT_SQL")" == "$PH_MID" ]] \
  && pass "placeholder auth.users count unchanged by the 409s" || fail "409 left an orphan auth user"
[[ "$PH_MID" == "$((PH_BEFORE + 2))" ]] \
  && pass "exactly two placeholder accounts created so far" || fail "placeholder count $PH_BEFORE → $PH_MID (expected +2)"

step "Arm C: compensation — forced user_stores failure leaves no partial state"
if psql_q "create function public.zz_s165_fail_user_stores() returns trigger language plpgsql as \$f\$
             begin
               if exists (select 1 from public.profiles where id = new.user_id and username = '${U_COMP}') then
                 raise exception 'zz_s165 forced failure';
               end if;
               return new;
             end \$f\$;
           create trigger zz_s165_fail_user_stores before insert on public.user_stores
             for each row execute function public.zz_s165_fail_user_stores();" >/dev/null; then
  TRIGGER_INSTALLED=1
  PH_C=$(psql_q "$PLACEHOLDER_COUNT_SQL")
  call "$ADMIN_BEARER" "$(create_body "$U_COMP" "$PW1" "[\"$STORE_A1\"]")"
  expect "create with forced user_stores failure" 500 "could not create account"
  [[ "$(psql_q "$PLACEHOLDER_COUNT_SQL")" == "$PH_C" ]] && pass "auth user rolled back" || fail "orphan auth user left behind"
  [[ "$(psql_q "select count(*) from public.profiles where username='${U_COMP}'")" == "0" ]] \
    && pass "profile rolled back (username released)" || fail "orphan profile left behind"
  psql_q "drop trigger zz_s165_fail_user_stores on public.user_stores; drop function public.zz_s165_fail_user_stores();" >/dev/null \
    && TRIGGER_INSTALLED=0
  call "$ADMIN_BEARER" "$(create_body "$U_COMP" "$PW1" "[\"$STORE_A1\"]")"
  expect "same username succeeds once the fault is removed" 201
else
  skip "Arm C" "could not install temporary trigger"
fi

################################################################################
step "Arm 12: username-resolve + password sign-in"
RESOLVED=""
if [[ -n "$RESOLVE_TOKEN" ]]; then
  R_OUT=$(curl -sS -w '\n%{http_code}' -X POST "${SUPABASE_URL}/functions/v1/username-resolve" \
    -H "Content-Type: application/json" -H "Authorization: Bearer ${RESOLVE_TOKEN}" \
    -d "$(jq -cn --arg u "$U_MAIN" '{username:$u}')")
  R_CODE=$(printf '%s' "$R_OUT" | tail -1)
  RESOLVED=$(printf '%s' "$R_OUT" | sed '$d' | jq -r '.email // empty' 2>/dev/null)
fi
if [[ -n "$RESOLVED" ]]; then
  [[ "$RESOLVED" == "$NEW_EMAIL" ]] && pass "username-resolve → the account's email" || fail "resolve returned a different email"
else
  skip "username-resolve step" "local USERNAME_RESOLVE_SERVICE_TOKEN unset/mismatched (HTTP ${R_CODE:-n/a}); not worked around"
  RESOLVED="$NEW_EMAIL"
fi
SIGNIN_JSON=$(login_json "$RESOLVED" "$PW1")
REFRESH_1=$(printf '%s' "$SIGNIN_JSON" | jq -r '.refresh_token // empty')
NEW_BEARER=$(printf '%s' "$SIGNIN_JSON" | jq -r '.access_token // empty')
[[ -n "$NEW_BEARER" ]] && pass "password sign-in as @$U_MAIN → 200" || fail "password sign-in failed: $SIGNIN_JSON"
# Second, independent session (a second device) for S-REV.
REFRESH_2=$(login_json "$RESOLVED" "$PW1" | jq -r '.refresh_token // empty')

step "Arm 13: set_password on self → 400"
call "$ADMIN_BEARER" "$(jq -cn --arg id "$ADMIN_ID" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
expect "self" 400 "cannot set password for self"
call "$ADMIN_BEARER" "$(jq -cn --arg id "$(printf '%s' "$ADMIN_ID" | tr 'a-f' 'A-F')" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
expect "self (uppercased uuid)" 400 "cannot set password for self"

step "Arm 14: set_password on an admin target → 403"
ADM2_EMAIL="zz_s165_admin_${SUFFIX}@local.test"
ADM2_ID=$(curl -sS -X POST "${SUPABASE_URL}/auth/v1/admin/users" -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" \
  -d "$(jq -cn --arg e "$ADM2_EMAIL" '{email:$e, password:"zz-s165-admin", email_confirm:true}')" | jq -r '.id // empty')
if [[ -n "$ADM2_ID" ]] && psql_q "insert into public.profiles (id, name, role, brand_id) values ('${ADM2_ID}', 'zz_s165 admin', 'admin', '${BRAND_A}')" >/dev/null; then
  call "$ADMIN_BEARER" "$(jq -cn --arg id "$ADM2_ID" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
  expect "same-brand admin target" 403 "forbidden: target is not a store user"
else
  fail "could not create the admin fixture"
fi
call "$ADMIN_BEARER" "$(jq -cn --arg p "$PW2" '{action:"set_password", userId:"00000000-0000-0000-0000-00000000dead", password:$p}')"
expect "unknown target" 403 "forbidden: target is not a store user"
call "$ADMIN_BEARER" "$(jq -cn --arg p "$PW2" '{action:"set_password", userId:"not-a-uuid", password:$p}')"
expect "malformed userId" 400 "userId required"

step "Arm 14b: set_password on a placeholder user whose JWT role is not 'user' → 403"
# Security L3: profiles.role='user' but auth app_metadata.role='admin' (drift).
if [[ -n "${ROLE_ID:-}" ]] && psql_q "update auth.users set raw_app_meta_data = raw_app_meta_data || '{\"role\":\"admin\"}'::jsonb where id='${ROLE_ID}'" >/dev/null; then
  ROLE_HASH_BEFORE=$(psql_q "select encrypted_password from auth.users where id='${ROLE_ID}'")
  call "$ADMIN_BEARER" "$(jq -cn --arg id "$ROLE_ID" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
  expect "app_metadata.role=admin target" 403 "forbidden: target is not a store user"
  [[ "$(psql_q "select encrypted_password from auth.users where id='${ROLE_ID}'")" == "$ROLE_HASH_BEFORE" ]] \
    && pass "password hash unchanged" || fail "password changed despite the refusal"
else
  fail "could not set app_metadata.role on the arm 10 account"
fi

step "Arm 15: set_password on a real-email user → 400"
call "$ADMIN_BEARER" "$(jq -cn --arg id "$USER_ID" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
expect "manager@local.test" 400 "account has an email; use password reset"
[[ "$(login_code "$USER_EMAIL" "$USER_PASSWORD")" == "200" ]] \
  && pass "manager password unchanged" || fail "manager password changed!"

step "Arm 8b: set_password with a short password → 400"
call "$ADMIN_BEARER" "$(jq -cn --arg id "$NEW_ID" '{action:"set_password", userId:$id, password:"short7!"}')"
expect "7-char password" 400 "password must be at least 8 characters"

step "Arm 16 (S-REV): set_password revokes existing sessions"
SESS_BEFORE=$(psql_q "select count(*) from auth.sessions where user_id='${NEW_ID}'")
[[ "${SESS_BEFORE:-0}" -ge 2 ]] && pass "precondition: ${SESS_BEFORE} live sessions" || fail "precondition: sessions=${SESS_BEFORE}"
call "$ADMIN_BEARER" "$(jq -cn --arg id "$NEW_ID" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
expect "set_password happy path" 200
[[ "$(printf '%s' "$BODY" | jq -c '.')" == '{"success":true}' ]] && pass "response is exactly {success:true}" || fail "response: $BODY"
for RT in "$REFRESH_1" "$REFRESH_2"; do
  RC=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" -d "$(jq -cn --arg r "$RT" '{refresh_token:$r}')")
  [[ "$RC" == "400" ]] && pass "S-REV: pre-change refresh token rejected (400)" || fail "S-REV: refresh token still works (HTTP $RC)"
done
SESS_AFTER=$(psql_q "select count(*) from auth.sessions where user_id='${NEW_ID}'")
[[ "$SESS_AFTER" == "0" ]] && pass "S-REV: auth.sessions count = 0" || fail "S-REV: auth.sessions count = $SESS_AFTER"

step "Arm 17: old password fails, new password works"
[[ "$(login_code "$RESOLVED" "$PW1")" == "400" ]] && pass "old password → 400" || fail "old password still works"
[[ "$(login_code "$RESOLVED" "$PW2")" == "200" ]] && pass "new password → 200" || fail "new password rejected"

################################################################################
# Arm A (spec 167 §8.1): server-side audit trail. Arms 1-17 have run, so each
# assertion below is a scoped TOTAL — a refused path that wrote a row would
# push a count above its exact expected value (AC-12d before/after proof).
step "Arm A: server-side audit trail (spec 167)"

# audit_rows <action> <item_ref> → "store_id|user_id|value|target_id|brand_id|keys" per row
audit_rows() {
  psql_q "select store_id, user_id, coalesce(value,''), detail::jsonb->>'target_id', coalesce(detail::jsonb->>'brand_id','<null>'),
                 (select array_agg(k order by k) from jsonb_object_keys(detail::jsonb) k)
            from public.audit_log where action='$1' and item_ref='$2' order by store_id"
}
audit_count() { # <action> <item_ref>
  psql_q "select count(*) from public.audit_log where action='$1' and item_ref='$2'"
}
# check_audit <label> <action> <item_ref> <want_count> <want_target_id> <want_brand> <want_store_ids (sorted, space-sep)>
check_audit() {
  local label="$1" action="$2" ref="$3" want_n="$4" want_tid="$5" want_brand="$6" want_stores="$7"
  local rows n got_stores bad=0 s_id u_id val tid bid keys
  n=$(audit_count "$action" "$ref")
  if [[ "$n" != "$want_n" ]]; then
    fail "$label: $n row(s) (expected exactly $want_n)"
    return
  fi
  pass "$label: exactly $want_n row(s)"
  rows=$(audit_rows "$action" "$ref")
  got_stores=$(printf '%s\n' "$rows" | cut -d'|' -f1 | sort | tr '\n' ' ' | sed 's/ $//')
  [[ "$got_stores" == "$want_stores" ]] && pass "$label: store_id set matches" || fail "$label: store_ids '$got_stores' (expected '$want_stores')"
  while IFS='|' read -r s_id u_id val tid bid keys; do
    [[ -z "$s_id" ]] && continue
    [[ "$u_id" == "$ADMIN_ID" ]] || { bad=1; fail "$label: user_id $u_id (expected caller $ADMIN_ID)"; }
    [[ -z "$val" ]] || { bad=1; fail "$label: value not empty"; }
    [[ "$tid" == "$want_tid" ]] || { bad=1; fail "$label: detail.target_id $tid (expected $want_tid)"; }
    [[ "$bid" == "$want_brand" ]] || { bad=1; fail "$label: detail.brand_id $bid (expected $want_brand)"; }
    [[ "$keys" == "{brand_id,target_id}" ]] || { bad=1; fail "$label: detail keys $keys (expected {brand_id,target_id})"; }
  done <<<"$rows"
  [[ "$bad" == "0" ]] && pass "$label: user_id=caller, value='', detail={target_id,brand_id} correct"
}

A_STORES_12=$(printf '%s\n%s\n' "$STORE_A1" "$STORE_A2" | sort | tr '\n' ' ' | sed 's/ $//')

# A1 (AC-12a): multi-store create. Exactly 2 also proves the Arm 9 duplicate
# store id was deduped and the Arm 11 409s wrote nothing.
check_audit "A1 create @$U_MAIN" "Store user created" "$U_MAIN" 2 "$NEW_ID" "$BRAND_A" "$A_STORES_12"
# A2: Arm 10's injected brand_id (brand B) is ignored in the audit too.
check_audit "A2 create @$U_ROLE" "Store user created" "$U_ROLE" 1 "${ROLE_ID:-}" "$BRAND_A" "$STORE_A1"
# A3: only the post-fault retry wrote a row; the compensated attempt wrote none.
if [[ "$TRIGGER_INSTALLED" == "0" ]]; then
  U_COMP_ID=$(psql_q "select id from public.profiles where username='${U_COMP}'")
  check_audit "A3 create @$U_COMP (compensated attempt wrote none)" "Store user created" "$U_COMP" 1 "$U_COMP_ID" "$BRAND_A" "$STORE_A1"
else
  skip "A3" "Arm C trigger still installed"
fi
# A4 (AC-12b): set_password → one row per current user_stores store. Exactly 2
# also proves Arm 8b (short password on the same target) wrote nothing.
check_audit "A4 password set @$U_MAIN" "Store user password set" "$U_MAIN" 2 "$NEW_ID" "$BRAND_A" "$A_STORES_12"
# A5: Arm 14b refusal wrote nothing.
[[ "$(audit_count "Store user password set" "$U_ROLE")" == "0" ]] \
  && pass "A5 refused set_password (@$U_ROLE, 14b) → 0 rows" || fail "A5 refused set_password wrote an audit row"

# A6 (AC-12e): store-less target → 200, zero rows, never a NULL-store row.
U_NOST="zz_s165_n${SUFFIX}"       # 15 chars
call "$ADMIN_BEARER" "$(create_body "$U_NOST" "$PW1" "[\"$STORE_A1\"]")"
expect "A6 create @$U_NOST" 201
NOST_ID=$(printf '%s' "$BODY" | jq -r '.id // empty')
if [[ -n "$NOST_ID" ]]; then
  psql_q "delete from public.user_stores where user_id='${NOST_ID}'" >/dev/null
  call "$ADMIN_BEARER" "$(jq -cn --arg id "$NOST_ID" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
  expect "A6 set_password on a store-less target" 200
  [[ "$(printf '%s' "$BODY" | jq -c '.' 2>/dev/null)" == '{"success":true}' ]] \
    && pass "A6 response is exactly {success:true}" || fail "A6 response: $BODY"
  [[ "$(audit_count "Store user password set" "$U_NOST")" == "0" ]] \
    && pass "A6 store-less set_password → 0 rows" || fail "A6 store-less set_password wrote a row"
else
  fail "A6 could not create the store-less fixture"
fi
[[ "$(psql_q "select count(*) from public.audit_log where $AUDIT_ACTIONS_SQL and store_id is null")" == "0" ]] \
  && pass "A6 no store_id IS NULL audit rows for these actions" || fail "A6 found a store_id IS NULL audit row"

# AF (AC-4): best-effort under a forced audit failure. A temporary BEFORE
# INSERT trigger on public.audit_log raises P0001 for rows whose item_ref is
# U_AUD only (so nothing else in the run is affected). create must still
# return 201 and set_password 200, the account must be KEPT (an audit
# failure never compensates), zero audit rows land for U_AUD, and the edge
# logs carry the code (P0001) but never the trigger's message.
step "Arm AF: forced audit_log failure does not change the response (spec 167 AC-4)"
U_AUD="zz_s165_f${SUFFIX}"        # 15 chars
AUD_TRIGGER_MSG="zz_s167 forced audit failure"
AUD_ID=""
if psql_q "create function public.zz_s167_fail_audit_log() returns trigger language plpgsql as \$f\$
             begin
               if new.item_ref = '${U_AUD}' then
                 raise exception '${AUD_TRIGGER_MSG}' using errcode = 'P0001';
               end if;
               return new;
             end \$f\$;
           create trigger zz_s167_fail_audit_log before insert on public.audit_log
             for each row execute function public.zz_s167_fail_audit_log();" >/dev/null; then
  AUDIT_TRIGGER_INSTALLED=1
  AF_T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  call "$ADMIN_BEARER" "$(create_body "$U_AUD" "$PW1" "[\"$STORE_A1\"]")"
  expect "AF create under forced audit failure" 201
  AUD_ID=$(printf '%s' "$BODY" | jq -r '.id // empty' 2>/dev/null)
  [[ "$(printf '%s' "$BODY" | jq -c 'keys' 2>/dev/null)" == '["id","username"]' ]] \
    && pass "AF create response keys are exactly {id, username}" || fail "AF create response: $BODY"
  if [[ -n "$AUD_ID" ]]; then
    [[ "$(psql_q "select count(*) from public.profiles p join auth.users u on u.id=p.id where p.id='${AUD_ID}' and p.username='${U_AUD}'")" == "1" ]] \
      && pass "AF account kept (profile + auth user; no compensation)" || fail "AF account was compensated / removed after the audit failure"
    [[ "$(psql_q "select count(*) from public.user_stores where user_id='${AUD_ID}'")" == "1" ]] \
      && pass "AF user_stores row kept" || fail "AF user_stores row missing"
    call "$ADMIN_BEARER" "$(jq -cn --arg id "$AUD_ID" --arg p "$PW2" '{action:"set_password", userId:$id, password:$p}')"
    expect "AF set_password under forced audit failure" 200
    [[ "$(printf '%s' "$BODY" | jq -c '.' 2>/dev/null)" == '{"success":true}' ]] \
      && pass "AF set_password response is exactly {success:true}" || fail "AF set_password response: $BODY"
    AUD_EMAIL=$(psql_q "select email from auth.users where id='${AUD_ID}'")
    [[ "$(login_code "$AUD_EMAIL" "$PW2")" == "200" ]] \
      && pass "AF new password works (password change kept)" || fail "AF new password rejected"
  else
    fail "AF no id in create response; skipping account / set_password checks"
  fi
  [[ "$(psql_q "select count(*) from public.audit_log where item_ref='${U_AUD}'")" == "0" ]] \
    && pass "AF zero audit rows for @$U_AUD" || fail "AF an audit row landed despite the forced failure"
  psql_q "drop trigger zz_s167_fail_audit_log on public.audit_log; drop function public.zz_s167_fail_audit_log();" >/dev/null \
    && AUDIT_TRIGGER_INSTALLED=0
  [[ "$AUDIT_TRIGGER_INSTALLED" == "0" ]] && pass "AF temporary audit_log trigger dropped" || fail "AF could not drop the audit_log trigger (cleanup retries)"
  if [[ -n "$AUD_ID" ]] && AF_LOGS=$(docker logs --since "$AF_T0" "$EDGE_CONTAINER" 2>&1); then
    AF_FAIL_LINES=$(printf '%s\n' "$AF_LOGS" | grep -F "audit write failed" | grep -F "$AUD_ID" | grep -cF "P0001")
    [[ "$AF_FAIL_LINES" -ge 2 ]] \
      && pass "AF edge logs: $AF_FAIL_LINES 'audit write failed ... P0001' lines for the target" \
      || fail "AF edge logs: expected 2 'audit write failed ... P0001' lines for $AUD_ID, found $AF_FAIL_LINES"
    if printf '%s' "$AF_LOGS" | grep -qF -- "$AUD_TRIGGER_MSG"; then
      fail "AF edge logs contain the trigger's error message"
    else
      pass "AF edge logs never contain the trigger's error message"
    fi
  else
    skip "AF log checks" "no target id or docker logs unavailable for $EDGE_CONTAINER"
  fi
else
  skip "Arm AF" "could not install temporary audit_log trigger"
fi

# A7 (AC-5 catch-all): created U_MAIN 2 + U_ROLE 1 + U_COMP 1 + U_NOST 1,
# plus password set U_MAIN 2 = 7 (Arm AF adds 0 by design). Catches a row
# from ANY refused path in the script (self, admin target, unknown/malformed
# id), whatever its item_ref.
# UPDATE THIS TALLY whenever a success arm that writes audit rows is added.
AUDIT_DELTA=$(( $(psql_q "select count(*) from public.audit_log where $AUDIT_ACTIONS_SQL") - AUDIT_BASE ))
[[ "$AUDIT_DELTA" == "7" ]] && pass "A7 audit rows added by this run = 7" || fail "A7 audit rows added by this run = $AUDIT_DELTA (expected 7)"

# A8 (AC-12c / AC-6): no column of any audit row holds a password or the
# placeholder. Matching happens in bash so the password never enters SQL.
AUDIT_DUMP=$(psql_q "select concat_ws('|', store_id, user_id, action, item_ref, value, detail)
                       from public.audit_log where $AUDIT_ACTIONS_SQL and item_ref like 'zz_s165%'")
A_LEAK=0
for SECRET in "$PW1" "$PW2" "no-email.invalid" "${NEW_EMAIL:-}"; do
  [[ -z "$SECRET" ]] && continue
  if printf '%s' "$AUDIT_DUMP" | grep -qF -- "$SECRET"; then A_LEAK=1; fail "A8 an audit row contains '${SECRET:0:6}…'"; fi
done
[[ "$A_LEAK" == "0" ]] && pass "A8 no password / placeholder in $(printf '%s\n' "$AUDIT_DUMP" | grep -c . | tr -d ' ') audit rows"

# A9 (AC-6 log hygiene, passwords only — other functions in this run may
# legitimately mention the placeholder domain).
if EDGE_LOGS=$(docker logs --since "$SMOKE_T0" "$EDGE_CONTAINER" 2>&1); then
  L_LEAK=0
  for SECRET in "$PW1" "$PW2"; do
    if printf '%s' "$EDGE_LOGS" | grep -qF -- "$SECRET"; then L_LEAK=1; fail "A9 edge runtime logs contain '${SECRET:0:6}…'"; fi
  done
  [[ "$L_LEAK" == "0" ]] && pass "A9 edge runtime logs since $SMOKE_T0 contain neither password"
else
  skip "A9" "docker logs unavailable for $EDGE_CONTAINER"
fi

################################################################################
step "Arm 18: response bodies never leak the password or placeholder"
LEAK=0
for SECRET in "$PW1" "$PW2" "no-email.invalid"; do
  if grep -qF -- "$SECRET" "$BODIES_FILE"; then LEAK=1; fail "a response body contains '${SECRET:0:6}…'"; fi
done
[[ "$LEAK" == "0" ]] && pass "no password / placeholder in $(wc -l <"$BODIES_FILE" | tr -d ' ') captured bodies"

################################################################################
# Arm 20 (added by test-engineer, spec 165 §E): send-welcome-email is
# self-triggerable by a signed-in placeholder account (the gate accepts the
# caller's own auth email). It must return 200 {success:true, skipped:
# "placeholder"} and never reach Resend.
step "Arm 20: send-welcome-email skips a placeholder account"
WEL_JWT=$(login_json "$RESOLVED" "$PW2" | jq -r '.access_token // empty')
if [[ -n "$WEL_JWT" ]]; then
  WEL_BODY=$(curl -sS -w '\n%{http_code}' -X POST "${SUPABASE_URL}/functions/v1/send-welcome-email" \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${WEL_JWT}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg e "$RESOLVED" '{email:$e, name:"zz_s165"}')")
  WEL_CODE=$(printf '%s' "$WEL_BODY" | tail -1)
  WEL_JSON=$(printf '%s' "$WEL_BODY" | sed '$d' | jq -c '.' 2>/dev/null)
  [[ "$WEL_CODE" == "200" && "$WEL_JSON" == '{"success":true,"skipped":"placeholder"}' ]] \
    && pass "send-welcome-email → 200 skipped:placeholder" || fail "send-welcome-email → HTTP ${WEL_CODE} ${WEL_JSON}"
else
  fail "could not sign in as the placeholder account for arm 20"
fi

step "Arm 19: mail catcher received nothing for placeholder accounts"
if curl -sS -o /dev/null "${MAILPIT_URL}/api/v1/info" 2>/dev/null; then
  MC=$(curl -sS "${MAILPIT_URL}/api/v1/search?query=no-email.invalid" | jq -r '.messages_count // 0')
  [[ "$MC" == "0" ]] && pass "Mailpit: 0 messages to no-email.invalid" || fail "Mailpit: $MC message(s) to no-email.invalid"
else
  skip "Arm 19" "Mailpit API not reachable at $MAILPIT_URL"
fi

printf '\n'
if [[ "$FAILED" == "0" ]]; then printf '\033[32mALL ARMS PASSED\033[0m\n'; else printf '\033[31mSOME ARMS FAILED\033[0m\n'; fi
exit "$FAILED"
