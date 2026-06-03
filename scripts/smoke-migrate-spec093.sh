#!/usr/bin/env bash
# scripts/smoke-migrate-spec093.sh — Spec 093 Track 3 apply-order smoke.
#
# Confirms the spec 093 backfill migration applies cleanly against the running
# local Supabase Postgres container, in sequence after the rest of the schema,
# and that its post-conditions hold:
#   1. The migration file applies without error (psql exit 0).
#   2. The audit table public.spec093_case_qty_backfill_audit exists post-apply.
#   3. The audit table is RLS-enabled and NOT granted to anon/authenticated
#      (back-office artifact posture — spec 093 §2).
#   4. No mis-encoded catalog rows remain (coalesce(case_qty,1)<=1 AND
#      coalesce(sub_unit_size,1)>1) — the Population-B UPDATE took effect.
#   5. Re-applying the migration is a no-op on data (idempotent / re-run safe):
#      the mis-encoded count stays 0.
#
# This mirrors the spec's "apply-order smoke for the backfill migration" note
# and the docker-exec-psql shape of scripts/smoke-rpc.sh / test-db.sh. Unlike
# the pgTAP test (which runs the backfill body inside a rolled-back txn against
# fixtures), this smoke applies the REAL migration file to the live DB and
# leaves it applied — it is intended to run against a fresh
# `npm run dev:db:reset` stack where the migration is already part of the
# applied set, OR to hand-verify a manual apply.
#
# Preconditions:
#   - `npm run dev:db` is up locally (container named per config.toml's
#     project_id; default supabase_db_imr-inventory). Override with CONTAINER=…
#
# Usage:
#   bash scripts/smoke-migrate-spec093.sh
#
# Exit code: non-zero on first failure.

# -e is intentionally omitted: each check accumulates into a $FAILED flag so all
# failures are reported, not just the first (same posture as smoke-rpc.sh /
# smoke-edge.sh). pipefail is added so a failed apply step inside a `… | …` pipe
# isn't masked by a later stage succeeding.
set -uo pipefail

CONTAINER="${CONTAINER:-supabase_db_imr-inventory}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"

REPO_ROOT="$(cd "$(dirname "$0")/.."; pwd)"
MIGRATION="${REPO_ROOT}/supabase/migrations/20260602120000_spec093_case_qty_backfill.sql"

FAILED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
step() { printf '\n== %s ==\n' "$1"; }

# psql helper: run SQL, return the trimmed single-value result on stdout.
psql_val() {
  docker exec -i -e PGOPTIONS='--client-min-messages=warning' "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -q -X -A -t -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

# Sanity: container running?
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  printf '\033[31mERROR\033[0m: container "%s" not running. Run `npm run dev:db` first.\n' "$CONTAINER" >&2
  exit 2
fi

# Sanity: migration file present?
if [[ ! -f "$MIGRATION" ]]; then
  printf '\033[31mERROR\033[0m: migration not found: %s\n' "$MIGRATION" >&2
  exit 2
fi

################################################################################
# 1. Apply the migration file (idempotent — safe even if already applied).
################################################################################
step "apply 20260602120000_spec093_case_qty_backfill.sql"
OUT=$(docker exec -i -e PGOPTIONS='--client-min-messages=notice' "$CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -f - 2>&1 < "$MIGRATION")
RC=$?
if [[ $RC -ne 0 ]]; then
  fail "migration apply failed (psql exit $RC)"
  printf '%s\n' "$OUT" | sed 's/^/    /'
  printf '\n\033[31m✗ smoke-migrate-spec093 failed at apply\033[0m\n'
  exit 1
fi
pass "migration applied cleanly (psql exit 0)"
# Surface the Population-C RAISE NOTICE so the operator sees the hand-review size.
printf '%s\n' "$OUT" | grep -i 'split rows flagged' | sed 's/^/    /' || true

################################################################################
# 2. Audit table exists.
################################################################################
step "audit table exists"
EXISTS=$(psql_val "select to_regclass('public.spec093_case_qty_backfill_audit') is not null;")
if [[ "$EXISTS" == "t" ]]; then
  pass "public.spec093_case_qty_backfill_audit exists"
else
  fail "audit table missing (to_regclass returned: ${EXISTS})"
fi

################################################################################
# 3. Audit table is RLS-enabled and not granted to anon/authenticated.
################################################################################
step "audit table back-office posture (RLS on, no anon/authenticated grant)"
RLS=$(psql_val "select relrowsecurity from pg_class where oid = 'public.spec093_case_qty_backfill_audit'::regclass;")
if [[ "$RLS" == "t" ]]; then
  pass "RLS enabled on the audit table"
else
  fail "RLS NOT enabled on the audit table (relrowsecurity=${RLS})"
fi

GRANTS=$(psql_val "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='spec093_case_qty_backfill_audit' and grantee in ('anon','authenticated');")
if [[ "$GRANTS" == "0" ]]; then
  pass "no anon/authenticated grants on the audit table"
else
  fail "audit table has ${GRANTS} anon/authenticated grant(s) — should be 0"
fi

################################################################################
# 4. No mis-encoded catalog rows remain.
################################################################################
step "no mis-encoded catalog rows remain (Population-B UPDATE took effect)"
MIS=$(psql_val "select count(*) from public.catalog_ingredients where coalesce(case_qty,1)<=1 and coalesce(sub_unit_size,1)>1;")
if [[ "$MIS" == "0" ]]; then
  pass "0 rows with case_qty<=1 AND sub_unit_size>1"
else
  fail "${MIS} mis-encoded row(s) remain — Population-B UPDATE did not fully apply"
fi

################################################################################
# 5. Re-apply is a data no-op (idempotent / re-run safe).
################################################################################
step "re-apply is a data no-op (idempotency)"
OUT2=$(docker exec -i -e PGOPTIONS='--client-min-messages=warning' "$CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -f - 2>&1 < "$MIGRATION")
RC2=$?
if [[ $RC2 -ne 0 ]]; then
  fail "re-apply failed (psql exit $RC2)"
  printf '%s\n' "$OUT2" | sed 's/^/    /'
else
  MIS2=$(psql_val "select count(*) from public.catalog_ingredients where coalesce(case_qty,1)<=1 and coalesce(sub_unit_size,1)>1;")
  if [[ "$MIS2" == "0" ]]; then
    pass "re-apply clean; mis-encoded count still 0 (self-extinguishing predicate)"
  else
    fail "re-apply changed data — mis-encoded count is now ${MIS2} (expected 0)"
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
