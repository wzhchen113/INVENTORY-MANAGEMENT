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
#
# Usage:
#   bash scripts/smoke-store-user.sh            # local stack only (refuses remote)
#
# Fixtures: admin@local.test (brand A admin) and manager@local.test
# (role='user', real email). The script creates, and removes in its EXIT trap:
#   - brand "zz_s165 brand B" + one store in it (docker psql)
#   - every auth user whose profile username or email starts with zz_s165
#   - a temporary trigger public.zz_s165_fail_user_stores (arm C only)
# If interrupted with kill -9, recover with:
#   docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
#     "drop trigger if exists zz_s165_fail_user_stores on public.user_stores;
#      drop function if exists public.zz_s165_fail_user_stores();
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
  psql_q "delete from auth.users where id in (select id from public.profiles where username like 'zz_s165%') or email like 'zz_s165%';
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
