## Test report for spec 067

### Acceptance criteria status

- AC1: root cause identified — the `set local role anon` + `throws_ok` anti-pattern at arm 10 of `compute_menu_capacity.test.sql` causes a Postgres SIGSEGV in CI under the `supabase/setup-cli@v1 latest` pg image → PASS. The architect's design doc names cause (d) with high-confidence evidence from two existing test files (`reports_anon_revoke.test.sql` lines 31-42, `cross_brand_copy.test.sql` lines 17-19), both of which contain explicit prior-incident documentation of the same crash signature. No diagnostic CI experiment was required; the codebase archaeology is conclusive.

- AC2: fix lands and CI Track 2 passes — arm 10 of `compute_menu_capacity.test.sql` now uses `has_function_privilege('anon', 'public.compute_menu_capacity(uuid)', 'EXECUTE')` (no runtime role-switch). CI run 26542639015 on branch `spec-067-ci-crash-fix` shows `compute_menu_capacity.test.sql` PASS with 16 assertion(s). → PASS `supabase/tests/compute_menu_capacity.test.sql` arm 10

- AC3: cascade victims pass — CI run 26542639015 shows all four previously-failing tests green: `copy_brand_catalog` (5 assertions), `cross_brand_copy` (14 assertions), `delete_last_privileged_guard` (4 assertions), `demote_self_guard` (6 assertions). Total Track 2: 35 PASS / 0 FAIL (was 30 PASS / 5 FAIL before this fix). → PASS

- AC4: process change so this doesn't silently happen again — The architect's design doc specifies option (a): a CLAUDE.md edit requiring `release-coordinator` to confirm the most recent `test.yml` run on `main` is green before recommending SHIP_READY. Per the spec's explicit design decision, CLAUDE.md is user-owned; the implementer surfaces the draft wording for user approval and must NOT auto-merge. The spec states this explicitly at `## CLAUDE.md — Not modified by the implementer`. The FE-dev has fulfilled the obligation by drafting the wording in the handoff payload within the spec file itself. The actual edit to CLAUDE.md requires user signoff before landing. → PASS (implementer obligation complete; user-approval step is pending and is correctly out-of-scope for the implementer and this reviewer)

### Test run

**CI run 26542639015 (branch `spec-067-ci-crash-fix`, triggered 2026-05-27):**

All four tracks green:
- Track 1 — jest-expo: PASS (all jest tests)
- Track 1a — typecheck (test graph): PASS
- Track 1b — typecheck (full base graph): PASS
- Track 2 — Supabase DB tests: 35 PASS / 0 FAIL

Track 2 highlights (previously failing, now PASS):
```
PASS supabase/tests/compute_menu_capacity.test.sql (16 assertion(s) passed)
PASS supabase/tests/copy_brand_catalog.test.sql (5 assertion(s) passed)
PASS supabase/tests/cross_brand_copy.test.sql (14 assertion(s) passed)
PASS supabase/tests/delete_last_privileged_guard.test.sql (4 assertion(s) passed)
PASS supabase/tests/demote_self_guard.test.sql (6 assertion(s) passed)
PASS supabase/tests/reports_anon_revoke.test.sql (13 assertion(s) passed)
```

**Plan count verification:**
- `compute_menu_capacity.test.sql`: `select plan(16)` — confirmed, unchanged from spec 060.
- `reports_anon_revoke.test.sql`: `select plan(13)` — confirmed, bumped from 12 as designed. CI shows 13 assertion(s) passed.

### Regression-prevention check

Grep for `set local role anon` across all `supabase/tests/*.test.sql` files returns exactly 3 lines:

```
supabase/tests/compute_menu_capacity.test.sql:437:-- Catalog-querying assertion (NOT `set local role anon` + throws_ok).
supabase/tests/reports_anon_revoke.test.sql:35:-- Prior version used `set local role anon` + `throws_ok` to verify the
supabase/tests/cross_brand_copy.test.sql:18:-- do NOT use `set local role anon` (segfaults under newer pg-version in CI).
```

All three are inside SQL comment lines (`--`). Zero actual `set local role anon` SQL statements remain in the test suite. The architect's assertion that "the other 2 are warning comments" is verified — all three files reference the pattern only to warn against it.

Cross-check: grep for `throws_ok` across the full test suite finds 55 call sites across 20 files. None co-occur with an actual (non-comment) `set local role anon` statement in the same file. No latent anti-pattern instances exist.

### Diff summary

The diff between `main` and `spec-067-ci-crash-fix` in `supabase/tests/` contains exactly the two designed edits:

1. `compute_menu_capacity.test.sql` arm 10: removed `set local role anon;` + `throws_ok(...)` block and the obsolete trailing comment; replaced with `select ok(not has_function_privilege('anon', 'public.compute_menu_capacity(uuid)', 'EXECUTE'), ...)`. Plan stays at 16.

2. `reports_anon_revoke.test.sql`: header comment count 12 → 13 + `compute_menu_capacity` bullet added; `select plan(12)` → `select plan(13)`; new arm 13 `ok(not has_function_privilege(...))` added at end.

No migration, no RPC change, no schema change, no edge function change, no frontend change.

### Notes

- **AC4 status clarification:** The implementer is required to draft the CLAUDE.md wording and surface it for user approval — not to auto-merge it. The spec's `## Files changed > CLAUDE.md` section explicitly states "Not modified by the implementer. Wording for AC4(a) is drafted in the handoff payload below for user approval; the user owns the file edit." The draft wording is present in the spec file's handoff payload. The implementer met this obligation. The user-approval step is a deliberate gate that is correctly deferred.

- **Local run:** The task prompt notes FE-dev confirmed local `npm run test:db` passes 35/35. The authoritative verification gate per the spec is CI (run 26542639015), which is green. Local parity is consistent with CI green given the fix eliminates the CI-specific crash trigger.

- **No framework gaps.** All tests land in the pgTAP DB tests track as designed. No new framework introduced.

- **SHIP_READY:** All four ACs are PASS. CI Track 2 is 35/35 green on the feature branch. No anti-pattern instances remain. The CLAUDE.md edit awaits user signoff (correctly out of scope for this reviewer).

## Handoff
next_agent: NONE
prompt: Test report complete. 4 PASS, 0 FAIL, 0 NOT TESTED across acceptance criteria. CI run 26542639015 shows Track 2 35/35 (was 30/35). No remaining `set local role anon` anti-pattern instances. CLAUDE.md AC4(a) wording drafted in spec handoff payload, awaiting user approval before the edit lands. SHIP_READY.
payload_paths:
  - specs/067/reviews/test-engineer.md
