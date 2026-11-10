#!/usr/bin/env bash
# scripts/smoke-po-number-concurrency.sh — Spec 190 Track 3 smoke (AC-4).
#
# Two concurrent inserts into public.purchase_orders with a NULL po_number, so
# both go through the set_po_number trigger:
#   session A: begin; insert; pg_sleep(8); commit;     (backgrounded)
#   session B: insert (autocommit), started once A has inserted and is sleeping
#
# Before spec 190, B read the same committed max() as A, computed the same
# number, blocked on purchase_orders_po_number_key, and failed with 23505 when
# A committed. With the sequence (spec 190 D-7) each session gets its own
# nextval(), so:
#   1. A commits.
#   2. B commits.
#   3. Both po_numbers are well formed ('^PO-[0-9]{3,}$') and different.
#   4. B never waited on A at the index, shown two ways: B's insert, timed
#      inside its own session, took under B_MAX_MS (a wait would last until A
#      commits, i.e. seconds); and A was still open when B returned. A holds
#      for A_HOLD_S (8s) so docker exec start-up on a busy machine can't eat
#      the margin.
#
# Both sessions run as postgres (the table owner), which is the "two owner
# sessions" reproduction from the spec: concurrency alone, no RLS involved. The
# RLS cases are pinned by supabase/tests/generate_po_number_sequence.test.sql.
#
# Local stack only: it talks to the local Postgres container via docker exec.
# Smokes are not in CI; run by hand before ship.
#
# Usage:
#   bash scripts/smoke-po-number-concurrency.sh
#
# Fixtures: two purchase_orders rows with fixed ids (store_id NULL, status
# 'draft'), deleted by id before the run and again in the EXIT trap. Each run
# uses two sequence numbers; gaps are accepted (spec 190 Q4).
#
# Exit code: non-zero if any check failed. Exits 1 straight away if session A
# never reaches pg_sleep, because every later check depends on A being open.

# -e is intentionally omitted: every check runs and accumulates into $FAILED.
set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_imr-inventory}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"

PO_A="b1900009-0000-0000-0000-00000000000a"
PO_B="b1900009-0000-0000-0000-00000000000b"
APP_A="smoke_spec190_session_a"
A_HOLD_S=8      # how long A keeps its transaction open after inserting
B_MAX_MS=2000   # B's insert must finish well inside A's hold

FAILED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
step() { printf '\n== %s ==\n' "$1"; }

psql_val() {
  docker exec -i -e PGOPTIONS='--client-min-messages=warning' "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -q -X -A -t -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  printf '\033[31mERROR\033[0m: container "%s" not running. Run `npm run dev:db` first.\n' "$CONTAINER" >&2
  exit 2
fi

if [[ "$(psql_val "select to_regclass('public.purchase_orders_po_number_seq') is not null")" != "t" ]]; then
  printf '\033[31mERROR\033[0m: public.purchase_orders_po_number_seq not found. Apply supabase/migrations/20261109140000_po_number_sequence.sql first.\n' >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
A_PID=""

cleanup() {
  if [[ -n "$A_PID" ]] && kill -0 "$A_PID" 2>/dev/null; then
    wait "$A_PID" 2>/dev/null
  fi
  psql_val "delete from public.purchase_orders where id in ('$PO_A', '$PO_B')" >/dev/null
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

psql_val "delete from public.purchase_orders where id in ('$PO_A', '$PO_B')" >/dev/null

################################################################################
step "session A: insert, hold the transaction open for ${A_HOLD_S}s"
################################################################################
docker exec -i -e PGOPTIONS='--client-min-messages=warning' -e PGAPPNAME="$APP_A" "$CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -q -X -A -t -v ON_ERROR_STOP=1 >"$TMP_DIR/a.out" 2>&1 <<SQL &
begin;
insert into public.purchase_orders (id, status, total_cost) values ('$PO_A', 'draft', 0);
select pg_sleep($A_HOLD_S);
commit;
SQL
A_PID=$!

# Wait (up to ~5s) until A is inside pg_sleep, i.e. its insert has run.
A_READY=0
for _ in $(seq 1 50); do
  if [[ "$(psql_val "select count(*) from pg_stat_activity where application_name = '$APP_A' and state = 'active' and query like '%pg_sleep%'")" == "1" ]]; then
    A_READY=1
    break
  fi
  sleep 0.1
done
if [[ $A_READY -eq 1 ]]; then
  pass "session A has inserted and is holding its transaction open"
else
  fail "session A never reached pg_sleep; the remaining checks need A open, aborting"
  sed 's/^/    /' "$TMP_DIR/a.out"
  # Roll A back if it is stuck somewhere other than pg_sleep, so the EXIT trap
  # doesn't wait on it.
  psql_val "select pg_terminate_backend(pid) from pg_stat_activity where application_name = '$APP_A'" >/dev/null
  printf '\n\033[31m✗ smoke-po-number-concurrency failed\033[0m\n'
  exit 1
fi

################################################################################
step "session B: insert while A is open"
################################################################################
# B times its own insert server-side (clock_timestamp before and after, each
# statement autocommitted), so docker exec start-up is not counted. Prints the
# insert's duration in whole milliseconds.
B_OUT=$(docker exec -i -e PGOPTIONS='--client-min-messages=warning' "$CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -q -X -A -t -v ON_ERROR_STOP=1 2>&1 <<SQL
select clock_timestamp() as b_t0 \\gset
insert into public.purchase_orders (id, status, total_cost) values ('$PO_B', 'draft', 0);
select floor(extract(epoch from clock_timestamp() - :'b_t0'::timestamptz) * 1000)::bigint;
SQL
)
B_RC=$?
A_STILL_OPEN="$(psql_val "select count(*) from pg_stat_activity where application_name = '$APP_A' and state = 'active' and query like '%pg_sleep%'")"

if [[ $B_RC -eq 0 ]]; then
  pass "session B committed (no 23505)"
else
  fail "session B failed (psql exit $B_RC)"
  printf '%s\n' "$B_OUT" | sed 's/^/    /'
fi

if [[ $B_RC -eq 0 && "$B_OUT" =~ ^[0-9]+$ ]]; then
  if (( B_OUT < B_MAX_MS )); then
    pass "session B's insert took ${B_OUT}ms (< ${B_MAX_MS}ms; B never waited on A)"
  else
    fail "session B's insert took ${B_OUT}ms (>= ${B_MAX_MS}ms; B may have waited on A)"
  fi
elif [[ $B_RC -eq 0 ]]; then
  fail "could not read session B's insert duration"
  printf '%s\n' "$B_OUT" | sed 's/^/    /'
fi

if [[ "$A_STILL_OPEN" == "1" ]]; then
  pass "session B finished while A was still open (B never waited on A)"
else
  fail "session A was no longer open when B finished (B may have waited on A)"
fi

wait "$A_PID"
A_RC=$?
A_PID=""
if [[ $A_RC -eq 0 ]]; then
  pass "session A committed"
else
  fail "session A failed (psql exit $A_RC)"
  sed 's/^/    /' "$TMP_DIR/a.out"
fi

################################################################################
step "both numbers are well formed and distinct"
################################################################################
NUM_A="$(psql_val "select po_number from public.purchase_orders where id = '$PO_A'")"
NUM_B="$(psql_val "select po_number from public.purchase_orders where id = '$PO_B'")"
printf '    A: %s\n    B: %s\n' "${NUM_A:-<none>}" "${NUM_B:-<none>}"

if [[ "$NUM_A" =~ ^PO-[0-9]{3,}$ && "$NUM_B" =~ ^PO-[0-9]{3,}$ ]]; then
  pass "both po_numbers match ^PO-[0-9]{3,}\$"
else
  fail "a po_number is missing or malformed"
fi

if [[ -n "$NUM_A" && -n "$NUM_B" && "$NUM_A" != "$NUM_B" ]]; then
  pass "the two po_numbers differ"
else
  fail "the two po_numbers are not distinct"
fi

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m✓ smoke-po-number-concurrency passed\033[0m\n'
else
  printf '\033[31m✗ smoke-po-number-concurrency failed\033[0m\n'
fi
exit $FAILED
