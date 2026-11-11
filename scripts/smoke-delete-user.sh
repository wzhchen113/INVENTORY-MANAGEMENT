#!/usr/bin/env bash
# scripts/smoke-delete-user.sh — Spec 187 smoke for the `delete-user` edge
# function's audit trail (who deleted whom) and its refusals.
#
# Sibling of scripts/smoke-store-user.sh: same pass/fail/skip output, same
# accumulator contract (every arm runs; `exit $FAILED` at the end), same
# local-only refusal, same EXIT-trap cleanup. Smokes are not in CI, so this one
# is run by hand before ship.
#
# Arms (spec 187 AC-23 to AC-29):
#   AC-23   target with a user_stores row on one store and approvals on another:
#           {success:true}, one 'User deleted' row per store, D4's field values,
#           and the approval count from before the deletes
#   AC-23b  a store in both halves of the union gets one row
#   AC-24   the target's approvals have NULL approved_by and an intact snapshot,
#           with approved_by_id equal to the target id and to detail.target_id
#   AC-25   target with no stores: 0 rows, one console line, still 200
#   AC-25a  super_admin caller on JWT role alone (no profile): NULL user_id, and
#           detail.caller_id carries the id
#   AC-26   placeholder-email target: empty value, no-email.invalid in no column
#   AC-27   self-delete, cross-brand and last-of-role refusals write 0 rows
#   AC-28   profile removed + auth delete fails: same 500, rows written with
#           auth_user_deleted=false; a retry writes no second row
#   AF      forced audit_log failure doesn't change the response (known limit:
#           the audit write is best-effort)
#   AC-29   no new console line carries an email, a name or an error message
#   TALLY   rows added by this run match the arms above, so a refused path that
#           wrote a row fails here whatever its item_ref
#
# Usage:
#   bash scripts/smoke-delete-user.sh            # local stack only (refuses remote)
#
# Fixtures: admin@local.test (brand A admin). The script creates, and removes in
# its EXIT trap:
#   - disposable auth users + profiles named zz_s187_<suffix> ...
#   - brand "zz_s187 brand B", brand-A store "zz_s187 store", vendor "zz_s187 vendor"
#   - a temporary table public.zz_s187_block_auth_delete (arm AC-28 only)
#   - a temporary trigger public.zz_s187_fail_audit_log (arm AF only)
# The last-of-role arm also sets every other master to 'admin' for its one request,
# then restores them, here and again in the trap. Any other session using a master
# login on this stack sees that for about a second.
# If interrupted with kill -9, recover with:
#   docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
#     "drop table if exists public.zz_s187_block_auth_delete;
#      drop trigger if exists zz_s187_fail_audit_log on public.audit_log;
#      drop function if exists public.zz_s187_fail_audit_log();
#      update public.profiles set role = 'master'
#       where id = '33333333-3333-3333-3333-333333333333' and role = 'admin';
#      delete from public.audit_log where action = 'User deleted' and item_ref like 'zz_s187%';
#      delete from auth.users where email like 'zz_s187%'
#         or id in (select id from public.profiles where name like 'zz_s187%');
#      delete from public.stores where name = 'zz_s187 store';
#      delete from public.vendors where name = 'zz_s187 vendor';
#      delete from public.brands where name = 'zz_s187 brand B';"
#   Then delete any auth.users row left from the AC-26 arm, whose address is a
#   u-<hex>@no-email.invalid placeholder with no profile.
#
# Exit code: non-zero on failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    printf '\033[31mREFUSE\033[0m smoke-delete-user.sh mutates state and only runs against a local stack.\n' >&2
    printf '       SUPABASE_URL=%s is non-local. Aborting.\n' "$SUPABASE_URL" >&2
    exit 2
    ;;
esac

DB_CONTAINER="supabase_db_imr-inventory"
EDGE_CONTAINER="supabase_edge_runtime_imr-inventory"
FN_URL="${SUPABASE_URL}/functions/v1/delete-user"
BRAND_A="2a000000-0000-0000-0000-000000000001"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password}"

FAILED=0
BLOCK_TABLE_INSTALLED=0
AUDIT_TRIGGER_INSTALLED=0
OTHER_MASTERS=""
PH_EMAIL=""

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step() { printf '\n== %s ==\n' "$1"; }

psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atc "$1" 2>/dev/null; }

restore_masters() {
  local id
  for id in $OTHER_MASTERS; do
    psql_q "update public.profiles set role = 'master' where id = '${id}'" >/dev/null \
      || printf '  \033[31mWARN\033[0m could not restore master %s — see header\n' "$id"
  done
  OTHER_MASTERS=""
}

cleanup() {
  local exit_code=$?
  printf '\n== cleanup ==\n'
  restore_masters
  if [[ "$BLOCK_TABLE_INSTALLED" == "1" ]]; then
    psql_q "drop table if exists public.zz_s187_block_auth_delete" >/dev/null \
      && pass "dropped temporary auth-delete blocker" \
      || printf '  \033[31mWARN\033[0m could not drop zz_s187_block_auth_delete — see header\n'
  fi
  if [[ "$AUDIT_TRIGGER_INSTALLED" == "1" ]]; then
    psql_q "drop trigger if exists zz_s187_fail_audit_log on public.audit_log; drop function if exists public.zz_s187_fail_audit_log();" >/dev/null \
      && pass "dropped temporary audit_log failure trigger" \
      || printf '  \033[31mWARN\033[0m could not drop zz_s187_fail_audit_log — see header\n'
  fi
  psql_q "delete from public.audit_log where action = 'User deleted' and (item_ref like 'zz_s187%' or value like 'zz_s187%');
          delete from auth.users where email like 'zz_s187%' or email = '${PH_EMAIL}'
             or id in (select id from public.profiles where name like 'zz_s187%');
          delete from public.stores where name = 'zz_s187 store';
          delete from public.vendors where name = 'zz_s187 vendor';
          delete from public.brands where name = 'zz_s187 brand B';" >/dev/null \
    && pass "removed zz_s187 users, store, vendor, brand and audit rows" \
    || printf '  \033[31mWARN\033[0m cleanup failed — see header for manual recovery\n'
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
if [[ -z "$ANON_KEY" || -z "$SERVICE_KEY" ]]; then
  fail "could not read SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY from $EDGE_CONTAINER"
  exit 1
fi
pass "read local keys"

login_json() {
  curl -sS -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg e "$1" --arg p "$2" '{email:$e,password:$p}')"
}

# call <bearer> <userId> → sets CODE and BODY
call() {
  local out
  out=$(curl -sS -w '\n%{http_code}' -X POST "$FN_URL" -H "Content-Type: application/json" \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer $1" -d "$(jq -cn --arg id "$2" '{userId:$id}')")
  CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# expect_body <label> <code> <exact compact JSON>
expect_body() {
  local got
  got=$(printf '%s' "$BODY" | jq -c '.' 2>/dev/null)
  if [[ "$CODE" == "$2" && "$got" == "$3" ]]; then
    pass "$1 → $2 $3"
  else
    fail "$1 → HTTP $CODE body=$BODY (expected $2 $3)"
  fi
}

# new_auth_user <email> [app_metadata JSON] → prints the id
new_auth_user() {
  local meta="${2:-}"
  [[ -z "$meta" ]] && meta='{}'
  curl -sS -X POST "${SUPABASE_URL}/auth/v1/admin/users" -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg e "$1" --argjson m "$meta" '{email:$e, password:"zz-s187-password", email_confirm:true, app_metadata:$m}')" \
    | jq -r '.id // empty'
}

# new_target <email> <name> <role> <brand id> → prints the id. The arguments are
# this script's own test values, not outside input, so interpolating them into SQL is safe.
new_target() {
  local id
  id=$(new_auth_user "$1")
  [[ -z "$id" ]] && return 1
  psql_q "insert into public.profiles (id, name, role, brand_id) values ('${id}', '$2', '$3', '$4')" >/dev/null || return 1
  printf '%s' "$id"
}

# new_approval <store id> <approver id> <status> <day offset>
new_approval() {
  psql_q "insert into public.order_approvals (store_id, vendor_id, business_date, approved_by, channel, status, lines)
          values ('$1', '${VENDOR}', date '2026-01-01' + $4, '$2', 'manual', '$3', '[]'::jsonb)" >/dev/null
}

# All 'User deleted' rows about a target, matched in text so no cast can fail on
# another writer's detail.
ud_where() { printf "action = 'User deleted' and detail like '%%\"target_id\":\"%s\"%%'" "$1"; }
ud_count() { psql_q "select count(*) from public.audit_log where $(ud_where "$1")"; }

# log_lines <needle> <target id> → prints the count of edge log lines with both
log_lines() {
  docker logs --since "$SMOKE_T0" "$EDGE_CONTAINER" 2>&1 | grep -F "$1" | grep -cF "$2"
}

# wait_log <needle> <target id> <want> → 0 once the count equals <want>. Edge logs
# reach docker a moment after the response.
wait_log() {
  local i n
  for i in 1 2 3 4 5 6 7 8 9 10; do
    n=$(log_lines "$1" "$2")
    [[ "$n" == "$3" ]] && return 0
    sleep 0.5
  done
  return 1
}

# check_rows <label> <target id> <want count> <want store ids, sorted, space-sep>
#   <want user_id, or empty for NULL> <want item_ref> <want value> <want caller_id>
#   <want target_role> <want brand_id, or null> <want approval_count> <want auth_user_deleted>
check_rows() {
  local label="$1" tid="$2" want_n="$3" want_stores="$4" want_uid="$5" want_ref="$6" want_val="$7"
  local want_caller="$8" want_role="$9" want_brand="${10}" want_count="${11}" want_auth="${12}"
  local n got_stores bad=0 sid uid ref val detail got_detail want_detail rows
  n=$(ud_count "$tid")
  if [[ "$n" != "$want_n" ]]; then
    fail "$label: $n row(s) (expected exactly $want_n)"
    return
  fi
  pass "$label: exactly $want_n row(s)"
  rows=$(psql_q "select store_id, coalesce(user_id::text, ''), coalesce(item_ref, ''), coalesce(value, ''), detail
                   from public.audit_log where $(ud_where "$tid") order by store_id")
  got_stores=$(printf '%s\n' "$rows" | cut -d'|' -f1 | sort | tr '\n' ' ' | sed 's/ $//')
  [[ "$got_stores" == "$want_stores" ]] && pass "$label: store_id set matches" \
    || fail "$label: store_ids '$got_stores' (expected '$want_stores')"
  want_detail=$(jq -cnS --arg c "$want_caller" --arg t "$tid" --arg r "$want_role" --argjson b "$want_brand" \
    --argjson n "$want_count" --argjson a "$want_auth" \
    '{caller_id:$c, target_id:$t, target_role:$r, brand_id:$b, approval_count:$n, auth_user_deleted:$a}')
  while IFS='|' read -r sid uid ref val detail; do
    [[ -z "$sid" ]] && continue
    [[ "$uid" == "$want_uid" ]] || { bad=1; fail "$label: user_id '$uid' (expected '$want_uid')"; }
    [[ "$ref" == "$want_ref" ]] || { bad=1; fail "$label: item_ref '$ref' (expected '$want_ref')"; }
    [[ "$val" == "$want_val" ]] || { bad=1; fail "$label: value '$val' (expected '$want_val')"; }
    got_detail=$(printf '%s' "$detail" | jq -cS '.' 2>/dev/null)
    [[ "$got_detail" == "$want_detail" ]] || { bad=1; fail "$label: detail $got_detail (expected $want_detail)"; }
  done <<<"$rows"
  [[ "$bad" == "0" ]] && pass "$label: user_id, item_ref, value and detail match D4"
}

ADMIN_JSON=$(login_json "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
ADMIN_BEARER=$(printf '%s' "$ADMIN_JSON" | jq -r '.access_token // empty')
ADMIN_ID=$(printf '%s' "$ADMIN_JSON" | jq -r '.user.id // empty')
if [[ -z "$ADMIN_BEARER" ]]; then
  fail "could not sign in $ADMIN_EMAIL"
  exit 1
fi
pass "signed in $ADMIN_EMAIL"

SUFFIX=$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
# Whole seconds: `docker logs --since` may include lines from up to a second before
# the run. The leak scans only look for strings unique to this run, so that is harmless.
SMOKE_T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STORE_A1=$(psql_q "select id from public.stores where brand_id='${BRAND_A}' order by name limit 1")
STORE_Z=$(psql_q "insert into public.stores (name, brand_id, address) values ('zz_s187 store', '${BRAND_A}', '1 Smoke St') returning id" | head -1)
VENDOR=$(psql_q "insert into public.vendors (name, brand_id) values ('zz_s187 vendor', '${BRAND_A}') returning id" | head -1)
BRAND_B=$(psql_q "insert into public.brands (name) values ('zz_s187 brand B') returning id" | head -1)
if [[ -z "$STORE_A1" || -z "$STORE_Z" || -z "$VENDOR" || -z "$BRAND_B" ]]; then
  fail "fixtures missing (A1=$STORE_A1 Z=$STORE_Z vendor=$VENDOR brand B=$BRAND_B)"
  exit 1
fi
pass "fixtures: seed store $STORE_A1, disposable store $STORE_Z, vendor $VENDOR, brand B $BRAND_B"
STORES_BOTH=$(printf '%s\n%s\n' "$STORE_A1" "$STORE_Z" | sort | tr '\n' ' ' | sed 's/ $//')

################################################################################
step "AC-23: user_stores on one store, approvals on another"
T1_EMAIL="zz_s187_t1_${SUFFIX}@local.test"; T1_NAME="zz_s187_${SUFFIX} t1"
T1=$(new_target "$T1_EMAIL" "$T1_NAME" "admin" "$BRAND_A")
if [[ -n "$T1" ]]; then
  psql_q "insert into public.user_stores (user_id, store_id) values ('${T1}', '${STORE_A1}')" >/dev/null
  new_approval "$STORE_Z" "$T1" pending 1
  new_approval "$STORE_Z" "$T1" approved 2
  new_approval "$STORE_Z" "$T1" ordered 3
  call "$ADMIN_BEARER" "$T1"
  expect_body "delete" 200 '{"success":true}'
  check_rows "AC-23" "$T1" 2 "$STORES_BOTH" "$ADMIN_ID" "$T1_NAME" "$T1_EMAIL" "$ADMIN_ID" admin "\"$BRAND_A\"" 3 true
  [[ "$(psql_q "select count(*) from auth.users where id='${T1}'")" == "0" && \
     "$(psql_q "select count(*) from public.profiles where id='${T1}'")" == "0" ]] \
    && pass "AC-23: profile and auth user are gone" || fail "AC-23: profile or auth user still there"

  step "AC-24: the target's approvals keep their snapshot"
  ROWS=$(psql_q "select count(*) from public.order_approvals
                  where store_id='${STORE_Z}' and approved_by is null
                    and approved_by_name='${T1_NAME}' and approved_by_email='${T1_EMAIL}'
                    and approved_by_id='${T1}'")
  [[ "$ROWS" == "3" ]] && pass "AC-24: 3 approvals with NULL approved_by and an intact snapshot, approved_by_id = target" \
    || fail "AC-24: $ROWS of 3 approvals have NULL approved_by and an intact snapshot with approved_by_id = target"
  # The id on the approvals and detail.target_id on every audit row are the same id.
  # Text match, like ud_where, so no cast can fail on another writer's detail.
  ID_PAIRS=$(psql_q "select count(*) from public.order_approvals oa, public.audit_log al
                      where oa.store_id='${STORE_Z}' and oa.approved_by_name='${T1_NAME}'
                        and al.action = 'User deleted'
                        and al.detail like '%\"target_id\":\"' || oa.approved_by_id::text || '\"%'")
  [[ "$ID_PAIRS" == "6" ]] && pass "AC-24: approved_by_id equals detail.target_id (3 approvals x 2 audit rows)" \
    || fail "AC-24: $ID_PAIRS of 6 approval/audit pairs have approved_by_id = detail.target_id"
else
  fail "could not create target t1"
fi

step "AC-23b: a store in both halves of the union gets one row"
T1B_EMAIL="zz_s187_t1b_${SUFFIX}@local.test"; T1B_NAME="zz_s187_${SUFFIX} t1b"
T1B=$(new_target "$T1B_EMAIL" "$T1B_NAME" "admin" "$BRAND_A")
if [[ -n "$T1B" ]]; then
  psql_q "insert into public.user_stores (user_id, store_id) values ('${T1B}', '${STORE_Z}')" >/dev/null
  new_approval "$STORE_Z" "$T1B" pending 4
  call "$ADMIN_BEARER" "$T1B"
  expect_body "delete" 200 '{"success":true}'
  check_rows "AC-23b" "$T1B" 1 "$STORE_Z" "$ADMIN_ID" "$T1B_NAME" "$T1B_EMAIL" "$ADMIN_ID" admin "\"$BRAND_A\"" 1 true
else
  fail "could not create target t1b"
fi

################################################################################
step "AC-25: a target with no stores writes 0 rows and logs one line"
T2_EMAIL="zz_s187_t2_${SUFFIX}@local.test"; T2_NAME="zz_s187_${SUFFIX} t2"
T2=$(new_target "$T2_EMAIL" "$T2_NAME" "user" "$BRAND_A")
if [[ -n "$T2" ]]; then
  call "$ADMIN_BEARER" "$T2"
  expect_body "delete" 200 '{"success":true}'
  [[ "$(ud_count "$T2")" == "0" ]] && pass "AC-25: 0 rows" || fail "AC-25: wrote a row for a store-less target"
  wait_log "[delete-user] audit skipped: target has no stores" "$T2" 1 \
    && pass "AC-25: exactly one console line" \
    || fail "AC-25: expected one 'audit skipped' line for $T2, found $(log_lines "[delete-user] audit skipped: target has no stores" "$T2")"
else
  fail "could not create target t2"
fi
[[ "$(psql_q "select count(*) from public.audit_log where action='User deleted' and store_id is null")" == "0" ]] \
  && pass "AC-25: no NULL-store 'User deleted' row exists" || fail "AC-25: found a NULL-store 'User deleted' row"

################################################################################
step "AC-25a: a super_admin caller with no profile"
SA_EMAIL="zz_s187_sa_${SUFFIX}@local.test"
SA_ID=$(new_auth_user "$SA_EMAIL" '{"role":"super_admin"}')
SA_BEARER=$(login_json "$SA_EMAIL" "zz-s187-password" | jq -r '.access_token // empty')
T3_EMAIL="zz_s187_t3_${SUFFIX}@local.test"; T3_NAME="zz_s187_${SUFFIX} t3"
T3=$(new_target "$T3_EMAIL" "$T3_NAME" "user" "$BRAND_A")
if [[ -n "$SA_BEARER" && -n "$T3" ]]; then
  [[ "$(psql_q "select count(*) from public.profiles where id='${SA_ID}'")" == "0" ]] \
    && pass "AC-25a: setup: the caller has no profile" || fail "AC-25a: setup: the caller has a profile"
  psql_q "insert into public.user_stores (user_id, store_id) values ('${T3}', '${STORE_Z}')" >/dev/null
  call "$SA_BEARER" "$T3"
  expect_body "delete" 200 '{"success":true}'
  check_rows "AC-25a" "$T3" 1 "$STORE_Z" "" "$T3_NAME" "$T3_EMAIL" "$SA_ID" user "\"$BRAND_A\"" 0 true
else
  fail "could not set up the no-profile super_admin caller or its target"
fi

################################################################################
step "AC-26: a placeholder-email target"
PH_HEX=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
PH_EMAIL="u-${PH_HEX}@no-email.invalid"; T4_NAME="zz_s187_${SUFFIX} t4"
T4=$(new_target "$PH_EMAIL" "$T4_NAME" "user" "$BRAND_A")
if [[ -n "$T4" ]]; then
  psql_q "insert into public.user_stores (user_id, store_id) values ('${T4}', '${STORE_Z}')" >/dev/null
  call "$ADMIN_BEARER" "$T4"
  expect_body "delete" 200 '{"success":true}'
  check_rows "AC-26" "$T4" 1 "$STORE_Z" "$ADMIN_ID" "$T4_NAME" "" "$ADMIN_ID" user "\"$BRAND_A\"" 0 true
  DUMP=$(psql_q "select concat_ws('|', store_id, user_id, action, item_ref, value, detail)
                   from public.audit_log where $(ud_where "$T4")")
  if printf '%s' "$DUMP" | grep -qF "no-email.invalid"; then
    fail "AC-26: no-email.invalid appears in an audit column"
  else
    pass "AC-26: no-email.invalid appears in no column"
  fi
else
  fail "could not create the placeholder target"
fi

################################################################################
step "AC-27: refused requests write 0 rows"
BEFORE_SELF=$(ud_count "$ADMIN_ID")
call "$ADMIN_BEARER" "$ADMIN_ID"
expect_body "self-delete" 400 '{"error":"cannot delete self"}'
[[ "$(ud_count "$ADMIN_ID")" == "$BEFORE_SELF" ]] && pass "AC-27: self-delete wrote 0 rows" || fail "AC-27: self-delete wrote a row"

T5_EMAIL="zz_s187_t5_${SUFFIX}@local.test"; T5_NAME="zz_s187_${SUFFIX} t5"
T5=$(new_target "$T5_EMAIL" "$T5_NAME" "user" "$BRAND_B")
if [[ -n "$T5" ]]; then
  call "$ADMIN_BEARER" "$T5"
  expect_body "cross-brand" 403 '{"error":"forbidden: target is in a different brand"}'
  [[ "$(ud_count "$T5")" == "0" ]] && pass "AC-27: cross-brand wrote 0 rows" || fail "AC-27: cross-brand wrote a row"
  [[ "$(psql_q "select count(*) from public.profiles where id='${T5}'")" == "1" ]] \
    && pass "AC-27: cross-brand target is still there" || fail "AC-27: cross-brand target was removed"
else
  fail "could not create the cross-brand target"
fi

# A disposable master, so a regressed guard can't delete a seed user. Every other
# master is 'admin' for this one request.
T6_EMAIL="zz_s187_t6_${SUFFIX}@local.test"; T6_NAME="zz_s187_${SUFFIX} t6"
T6=$(new_target "$T6_EMAIL" "$T6_NAME" "master" "$BRAND_A")
if [[ -n "$T6" ]]; then
  psql_q "insert into public.user_stores (user_id, store_id) values ('${T6}', '${STORE_Z}')" >/dev/null
  OTHER_MASTERS=$(psql_q "update public.profiles set role = 'admin' where role = 'master' and id <> '${T6}' returning id" | grep -E '^[0-9a-f-]{36}$')
  call "$ADMIN_BEARER" "$T6"
  restore_masters
  expect_body "last-of-role" 400 '{"error":"cannot delete the last master"}'
  [[ "$(ud_count "$T6")" == "0" ]] && pass "AC-27: last-of-role wrote 0 rows" || fail "AC-27: last-of-role wrote a row"
  [[ "$(psql_q "select count(*) from public.user_stores where user_id='${T6}'")" == "1" ]] \
    && pass "AC-27: last-of-role refused before any side effect" || fail "AC-27: last-of-role left a partial delete"
  [[ "$(psql_q "select role from public.profiles where id='33333333-3333-3333-3333-333333333333'")" == "master" ]] \
    && pass "AC-27: seed master restored" || fail "AC-27: seed master not restored"
else
  fail "could not create the disposable master"
fi

################################################################################
step "AC-28: profile removed, auth delete fails"
T7_EMAIL="zz_s187_t7_${SUFFIX}@local.test"; T7_NAME="zz_s187_${SUFFIX} t7"
T7=$(new_target "$T7_EMAIL" "$T7_NAME" "user" "$BRAND_A")
if [[ -n "$T7" ]] && psql_q "create table public.zz_s187_block_auth_delete (user_id uuid not null references auth.users(id));
                             insert into public.zz_s187_block_auth_delete values ('${T7}');" >/dev/null; then
  BLOCK_TABLE_INSTALLED=1
  psql_q "insert into public.user_stores (user_id, store_id) values ('${T7}', '${STORE_Z}')" >/dev/null
  call "$ADMIN_BEARER" "$T7"
  if [[ "$CODE" == "500" && -n "$(printf '%s' "$BODY" | jq -r '.error // empty' 2>/dev/null)" && "$(printf '%s' "$BODY" | jq -c 'keys' 2>/dev/null)" == '["error"]' ]]; then
    pass "AC-28: same 500 {error} as today"
  else
    fail "AC-28: HTTP $CODE body=$BODY (expected 500 with only an error field)"
  fi
  [[ "$(psql_q "select count(*) from public.profiles where id='${T7}'")" == "0" && \
     "$(psql_q "select count(*) from auth.users where id='${T7}'")" == "1" ]] \
    && pass "AC-28: setup held: profile gone, login survives" || fail "AC-28: profile/login state is not the partial failure"
  check_rows "AC-28" "$T7" 1 "$STORE_Z" "$ADMIN_ID" "$T7_NAME" "$T7_EMAIL" "$ADMIN_ID" user "\"$BRAND_A\"" 0 false

  step "AC-28: the retry writes no second row (design risk: the row stays stale)"
  psql_q "drop table public.zz_s187_block_auth_delete" >/dev/null && BLOCK_TABLE_INSTALLED=0
  call "$ADMIN_BEARER" "$T7"
  expect_body "retry" 200 '{"success":true}'
  [[ "$(ud_count "$T7")" == "1" ]] && pass "AC-28: still one row, auth_user_deleted stays false" || fail "AC-28: retry wrote another row"
else
  skip "AC-28" "could not install the auth-delete blocker"
fi

################################################################################
step "AF: a forced audit_log failure doesn't change the response"
AF_EMAIL="zz_s187_af_${SUFFIX}@local.test"; AF_NAME="zz_s187_${SUFFIX} af"
AF_MSG="zz_s187 forced audit failure"
AF=$(new_target "$AF_EMAIL" "$AF_NAME" "user" "$BRAND_A")
if [[ -n "$AF" ]] && psql_q "create function public.zz_s187_fail_audit_log() returns trigger language plpgsql as \$f\$
             begin
               if new.item_ref = '${AF_NAME}' then
                 raise exception '${AF_MSG}' using errcode = 'P0001';
               end if;
               return new;
             end \$f\$;
           create trigger zz_s187_fail_audit_log before insert on public.audit_log
             for each row execute function public.zz_s187_fail_audit_log();" >/dev/null; then
  AUDIT_TRIGGER_INSTALLED=1
  psql_q "insert into public.user_stores (user_id, store_id) values ('${AF}', '${STORE_Z}')" >/dev/null
  call "$ADMIN_BEARER" "$AF"
  expect_body "delete" 200 '{"success":true}'
  [[ "$(ud_count "$AF")" == "0" ]] && pass "AF: zero rows for the target" || fail "AF: a row landed despite the forced failure"
  [[ "$(psql_q "select count(*) from auth.users where id='${AF}'")" == "0" ]] \
    && pass "AF: the delete still went ahead" || fail "AF: the delete didn't complete"
  psql_q "drop trigger zz_s187_fail_audit_log on public.audit_log; drop function public.zz_s187_fail_audit_log();" >/dev/null \
    && AUDIT_TRIGGER_INSTALLED=0
  if wait_log "[delete-user] audit write failed" "$AF" 1; then
    AF_LINE=$(docker logs --since "$SMOKE_T0" "$EDGE_CONTAINER" 2>&1 | grep -F "[delete-user] audit write failed" | grep -F "$AF")
    printf '%s' "$AF_LINE" | grep -qF "P0001" \
      && pass "AF: edge log has the code" || fail "AF: edge log line has no P0001: $AF_LINE"
  else
    fail "AF: expected one 'audit write failed' line for $AF"
  fi
else
  skip "AF" "could not install the temporary audit_log trigger"
fi

################################################################################
step "AC-29: console lines carry no email, name or error message"
if EDGE_LOGS=$(docker logs --since "$SMOKE_T0" "$EDGE_CONTAINER" 2>&1); then
  LEAK=0
  # Unique to this run, so a line from another session on the shared stack can't match.
  for SECRET in "$T1_EMAIL" "$T1_NAME" "${T1B_EMAIL}" "${T1B_NAME}" "$T2_EMAIL" "$T2_NAME" "$SA_EMAIL" \
                "$T3_EMAIL" "$T3_NAME" "$PH_EMAIL" "$T4_NAME" "$T5_EMAIL" "$T5_NAME" "$T6_EMAIL" "$T6_NAME" \
                "$T7_EMAIL" "$T7_NAME" "$AF_EMAIL" "$AF_NAME" "$AF_MSG" "zz_s187_block_auth_delete"; do
    if printf '%s' "$EDGE_LOGS" | grep -qF -- "$SECRET"; then LEAK=1; fail "AC-29: edge logs contain '$SECRET'"; fi
  done
  # Other functions in a shared stack may mention the placeholder domain, so this
  # one scans only this function's lines.
  if printf '%s\n' "$EDGE_LOGS" | grep -F "[delete-user]" | grep -qF "no-email.invalid"; then
    LEAK=1; fail "AC-29: a [delete-user] line contains no-email.invalid"
  fi
  [[ "$LEAK" == "0" ]] && pass "AC-29: edge logs since $SMOKE_T0 contain none of them"
else
  skip "AC-29" "docker logs unavailable for $EDGE_CONTAINER"
fi

################################################################################
# TALLY: t1 2 + t1b 1 + t3 1 + t4 1 + t7 1 = 6. t2, the refusals and AF add 0.
# UPDATE THIS TALLY whenever an arm that writes audit rows is added.
step "TALLY: rows written by this run"
TALLY=$(psql_q "select count(*) from public.audit_log where action = 'User deleted' and item_ref like 'zz_s187_${SUFFIX}%'")
[[ "$TALLY" == "6" ]] && pass "this run added 6 'User deleted' rows" || fail "this run added $TALLY 'User deleted' rows (expected 6)"

printf '\n'
if [[ "$FAILED" == "0" ]]; then printf '\033[32mALL ARMS PASSED\033[0m\n'; else printf '\033[31mSOME ARMS FAILED\033[0m\n'; fi
exit "$FAILED"
