#!/usr/bin/env bash
# scripts/test-db.sh — Spec 022 Track 2 runner.
#
# Walks every .sql file under supabase/tests/ and executes it inside the
# running Supabase Postgres container via `psql -f`. Each test file owns
# its own `begin; ... rollback;` framing plus pgTAP `select plan(N); ...
# select * from finish();` — so test runs are hermetic (the seed is
# untouched) AND a wrong assertion count fails the file.
#
# Architect's design (spec 022 §4) names pg_prove. The local Supabase
# Postgres image does NOT ship pg_prove (only the pgtap extension's
# SQL functions). Rather than rely on a tool that isn't there, this
# wrapper invokes psql directly and inspects pgTAP's own output for the
# canonical `# Looks like you failed N tests of M` line. Same hermetic
# isolation, no new binary required.
#
# Preconditions:
#   - `npm run dev:db` is up locally OR a `supabase start` was run in CI.
#   - The container is named per `supabase/config.toml`'s project_id
#     (default for this repo: supabase_db_imr-inventory). Override with
#     CONTAINER=... if your local stack uses a different project name.
#
# Usage:
#   npm run test:db                          # all tests under supabase/tests/
#   bash scripts/test-db.sh path/to.test.sql # one specific file
#
# Exit code: non-zero on first failing file. (No --fail-fast flag; the
# loop early-exits on `failed=1` like scripts/smoke-edge.sh does.)

set -u  # don't `set -e` — we want to keep going long enough to print a summary

CONTAINER="${CONTAINER:-supabase_db_imr-inventory}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"

REPO_ROOT="$(cd "$(dirname "$0")/.."; pwd)"
TEST_DIR="${REPO_ROOT}/supabase/tests"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
step() { printf '\n== %s ==\n' "$1"; }

# Sanity: container running?
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  printf '\033[31mERROR\033[0m: container "%s" not running. Run `npm run dev:db` first.\n' "$CONTAINER" >&2
  exit 2
fi

# Args: a single file path, or nothing → walk supabase/tests/.
declare -a TEST_FILES=()
if [[ $# -ge 1 ]]; then
  for arg in "$@"; do
    if [[ -f "$arg" ]]; then
      TEST_FILES+=("$arg")
    else
      printf '\033[31mERROR\033[0m: not a file: %s\n' "$arg" >&2
      exit 2
    fi
  done
else
  # Stable order: shell glob, sorted lexically.
  if [[ ! -d "$TEST_DIR" ]]; then
    printf '\033[33mWARN\033[0m: no test directory at %s — nothing to run.\n' "$TEST_DIR"
    exit 0
  fi
  while IFS= read -r -d '' f; do
    TEST_FILES+=("$f")
  done < <(find "$TEST_DIR" -name '*.test.sql' -type f -print0 | sort -z)
fi

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  printf '\033[33mWARN\033[0m: no .test.sql files found under %s\n' "$TEST_DIR"
  exit 0
fi

TOTAL=0
FAILED=0

for f in "${TEST_FILES[@]}"; do
  TOTAL=$((TOTAL + 1))
  rel="${f#${REPO_ROOT}/}"
  step "$rel"

  # Stream the file into psql -f via stdin. ON_ERROR_STOP=1 makes a
  # syntax error or unexpected raise fail the run. `--single-transaction`
  # is NOT used — each test file already owns a `begin; ... rollback;`
  # block, and forcing an outer transaction would conflict with that.
  OUTPUT=$(docker exec -i \
    -e PGOPTIONS='--client-min-messages=warning' \
    "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -q -X -A -t -f - 2>&1 < "$f")
  RC=$?

  if [[ $RC -ne 0 ]]; then
    fail "$rel (psql exit $RC)"
    printf '%s\n' "$OUTPUT" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
    continue
  fi

  # pgTAP prints `1..N` then `ok N - msg` / `not ok N - msg` lines and a
  # trailing `# Looks like you failed N tests of M` when any failed. We
  # scan for that and for any `not ok` line as a defense in depth.
  #
  # We ALSO scan for `# Looks like you planned N tests but ran M` —
  # pgTAP's tell for "fewer assertions ran than the plan declared",
  # which can hide silent test skipping (e.g., an early RAISE that
  # short-circuits before all asserts run). Closes code-reviewer S1.
  if printf '%s' "$OUTPUT" | grep -q '^not ok '; then
    fail "$rel (pgTAP assertion(s) failed)"
    printf '%s\n' "$OUTPUT" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
    continue
  fi
  if printf '%s' "$OUTPUT" | grep -q '# Looks like you failed'; then
    fail "$rel (plan/finish mismatch)"
    printf '%s\n' "$OUTPUT" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
    continue
  fi
  if printf '%s' "$OUTPUT" | grep -qE '# Looks like you planned [0-9]+ tests? but ran [0-9]+'; then
    fail "$rel (plan declared more assertions than ran — possible silent skip)"
    printf '%s\n' "$OUTPUT" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
    continue
  fi

  # Count `ok N - msg` lines and surface them as a passes summary.
  oks=$(printf '%s' "$OUTPUT" | grep -c '^ok ' || true)
  pass "$rel (${oks} assertion(s) passed)"
done

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf '\033[32m✓ %d/%d DB test file(s) passed\033[0m\n' "$TOTAL" "$TOTAL"
  exit 0
else
  printf '\033[31m✗ %d/%d DB test file(s) failed\033[0m\n' "$FAILED" "$TOTAL"
  exit 1
fi
