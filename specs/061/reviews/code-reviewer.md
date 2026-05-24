## Code review for spec 061

### Critical

None.

The four load-bearing items pass:

1. `auth_can_see_store(p_store_id)` gate is present at migration line 95, BEFORE the vendor-name hydration (line 100) and well before any INSERT (line 143). Raises errcode `42501` on failure. Correct.
2. Audit attribution uses `coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown')` (migration line 114). `auth.uid()` wins when present; `p_submitted_by` is a fallback for the deprecated legacy path, not the trusted source. Correct.
3. GRANT swap: line 221 `revoke all ... from public, anon, authenticated, service_role` then line 222 `grant execute ... to authenticated`. Both halves present. Correct.
4. `security definer` is retained (migration line 63). Correct.
5. All three edge functions return HTTP 410 with descriptive JSON + `reference` field, and preserve CORS headers so OPTIONS preflight succeeds before the 410 is seen. Correct.

---

### Should-fix

- `supabase/tests/staff_role_eod_rls.test.sql:60,104` — `v_client_c` / `test.client_c` is generated in the fixture block and stored via `set_config`, but is never referenced in any assertion. It is dead fixture code. Either add the "conflict on different client_uuid for same triple" assertion the spec review checklist calls for (which would use this UUID for the second client submitting the same store/date/vendor triple), or remove the declaration. As written, it is misleading: a reader expects a test that exercises client_c somewhere, and will search for it. The spec's §8 assertion list does not include this case either, so adding it would require bumping the plan count from 11 to 12 and writing the assertion — but the current state of declaring a UUID that goes nowhere is worse than either outcome.

- `supabase/tests/staff_role_eod_rls.test.sql:47` — `select plan(11)` is correct for the assertions present, but the comment block at lines 8–41 describes assertions (1)–(10) plus "(11) idempotency folded in as the 11th item." The execution ORDER is: assertion (10) runs first (lines 111–118, under the postgres role), then (1)–(9), then (11). The label "(10)" appears physically before "(1)" in the file but is numbered tenth in the stated plan — creating a mismatch between the assertion's label and its execution position. Consider renaming the pre-role-switch assertion "(0) service_role grant check" or placing it last and calling it "(11)" with idempotency as "(10)". As written, the label `(10)` fires first in execution order, which will confuse future editors tracing a failing test output line like `not ok 1 — (10) service_role lacks EXECUTE`. Execution order index 1 with label "(10)" is not wrong at the pgTAP protocol level (TAP numbers sequentially, the label is just a string), but it will mislead.

- `supabase/tests/staff_role_eod_rls.test.sql` — No positive read assertion for brand-shared tables. The spec §0 architect ruling explicitly says "Staff CAN read brand-catalog rows today — by-design." Assertion (9) covers the write-block (staff cannot INSERT into `recipes`). There is no complementary assertion that `SELECT FROM public.recipes` or `SELECT FROM public.catalog_ingredients` returns rows rather than zero or an error for the staff user. The spec §8 assertion list omits this as well, but the spec review checklist requires it. A one-line `select ok((select count(*)::bigint from public.recipes) > 0, 'staff user can SELECT recipes (brand-shared read, by design)')` would close the gap and raise the plan count by 1.

- `scripts/smoke-staff-eod.sh:307–331` — The edge-function deprecation loop runs the three functions but sends no `apikey` or `Authorization` header. The `staff-*` functions have `verify_jwt = false` in `config.toml`, which means the gateway doesn't reject headerless calls — the functions themselves don't validate any token in the new 410 body. This is intentional by spec (the 410 should respond to ANY caller), and locally the anon key is not required because `verify_jwt = false`. However, if a future operator sets `verify_jwt = true` for one of these deprecated functions by mistake, the headerless curl in the smoke would get a 401 rather than a 410 and the smoke would correctly fail. No change is technically necessary today, but adding `-H "apikey: ${SUPABASE_ANON_KEY}"` to the deprecation smoke loop would make the test more robust and consistent with how the other curls in the script are written.

---

### Nits

- `supabase/tests/staff_role_eod_rls.test.sql:233` — Assertion (5) uses `'2026-05-23'::date` (the implementation date) for the negative-case call that gets refused by `auth_can_see_store` before any row can land. Since the call raises an exception before INSERT, there is no real isolation risk. But for consistency with assertion (1)'s comment ("Test-only date '1999-12-31' — NOT today's date"), consider using a similarly synthetic date (`'1999-11-30'`) to signal intentionality and avoid coupling to the current calendar.

- `supabase/tests/staff_role_eod_rls.test.sql:261` — Assertion (6) seeds Charles at `'2026-05-22'`. Assertion (8) also seeds Charles at `'2026-05-22'` (line 295). Both are wrapped in `on conflict do nothing` so two runs of the suite in the same transaction aren't a problem. But both share the same date for the same store/vendor; if a third test or future smoke script inadvertently lands a row at Charles/2026-05-22, assertion (8)'s count-is-0 check will false-positive fail from the staff POV (RLS hides all Charles rows from the staff user regardless, so the isolation concern is less about correctness and more about future-reader confusion). A synthetic date (`'1999-11-29'`) would match the pattern used for assertion (1).

- `supabase/functions/staff-catalog/index.ts:24` — `Access-Control-Allow-Methods` is `"GET, OPTIONS"`. The original `staff-catalog` function was GET-only. A POST from a browser to this endpoint would not be blocked by CORS (the browser would not send a preflight for a GET, and a POST would get CORS-blocked before the 410 is seen). For a deprecated tombstone, the method list is cosmetic — but `"GET, POST, OPTIONS"` would make preflight succeed for any HTTP verb and is what the spec §4 reference body shape shows. Low-stakes since this is a 410 tombstone.

- `imr-staff/App.tsx:29,35,40` — Inline hex color literals (`'#fff'`, `'#444'`, `'#888'`) in the placeholder screen. The imr-inventory project's "no inline hex literals" rule applies to that repo, not imr-staff (imr-staff has no `useColors()` hook yet). These are fine for a placeholder component — flagging only so spec 062 knows to establish the theming pattern before any real screen ships.

- `scripts/smoke-staff-eod.sh` — `set -u` only (no `set -e`). The script uses `FAILED=1` + deferred-exit rather than `set -e`, which is an explicit design choice (mirrors `smoke-rpc.sh`). Consistent with the established pattern — not a deviation.
