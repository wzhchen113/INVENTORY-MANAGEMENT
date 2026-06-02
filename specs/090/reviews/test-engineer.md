## Test report for spec 090

### Acceptance criteria status

- **AC-110 — User/manager invite WITH assigned stores → non-null `invitations.brand_id`**
  PASS — `src/lib/inviteUser.test.ts::derives a non-null brand_id from the assigned store for a user invite (AC-110)`
  Non-vacuous: the call passes `brandId: null` (the pre-fix drawer value); the mock returns `{ brand_id: BRAND_A }` from the stores read; the assertion `expect(mockInvitationInsertPayload.brand_id).toBe(BRAND_A)` would FAIL if the derive block were removed and `opts.brandId` (null) were inserted verbatim. Additionally, `expect(mockStoresReadFired).toBe(true)` catches removal of the derive read itself.

- **AC-122 — Zero-store user invite remains allowed and brand-less; guard skips it**
  PASS — `src/lib/inviteUser.test.ts::leaves a zero-store user invite NULL-brand and does NOT fire the derive read (AC-122)`
  Asserts `result.error === null`, `mockInvitationInsertPayload.brand_id === null`, and `mockStoresReadFired === false`. Would fail if the guard incorrectly fired on a zero-store invite or blocked it.

- **AC-116 half 1 — Admin invite `brandId` passed verbatim; derive NOT fired**
  PASS — `src/lib/inviteUser.test.ts::passes an admin invite brand_id through verbatim and does NOT fire the derive read (AC-116, half 1)`
  Asserts `brand_id === BRAND_A` verbatim and `mockStoresReadFired === false`.

- **AC-116 half 2 — Admin invite with null brand → existing error string, no INSERT**
  PASS — `src/lib/inviteUser.test.ts::returns the existing missing-brand error for an admin invite with no brand and writes NO row (AC-116, half 2)`
  Asserts `result.error === 'Admin invitations require a brand assignment'` and `mockInvitationInsertPayload === null`.

- **AC — Backward-compat; existing rows untouched**
  PASS (by design / structural) — The fix is a pure write-path guard; no migration, no backfill re-run, no existing-row reads. Confirmed by reading the implementation (`src/lib/auth.ts` and `src/components/cmd/InviteUserDrawer.tsx`): no touch to existing rows. No test is required for a "don't do X" constraint with no code path that could violate it.

- **AC — pgTAP arm for DB CHECK (conditional)**
  N/A — Architect resolved open question C as app-level only; no DB CHECK, no migration, no pgTAP arm required. Confirmed: no new `.test.sql` file for spec 090.

- **AC — Tests land on named tracks (jest mandatory, pgTAP only if CHECK/function/grant changes)**
  PASS — jest file `src/lib/inviteUser.test.ts` is present and covers all four required cases. No pgTAP added (correct: no DB change).

### Gap note — `InviteUserDrawer` call-site derivation untested at component level

`src/components/cmd/InviteUserDrawer.test.tsx` does not assert the `brandId` argument passed to `inviteUser`. The test mocks `inviteUser` as a jest.fn() but makes no `.toHaveBeenCalledWith(...)` assertion that would catch the PRIMARY fix at `InviteUserDrawer.tsx:154-159` (the `derivedBrandId` computation).

This gap is **acceptable** for the same reason the architect stated in the design doc: the spec kept the secondary defense-in-depth derive inside `inviteUser` (`auth.ts:313-320`), so the `inviteUser` jest tests (which assert the INSERT payload's `brand_id`) cover the durable contract surface. The drawer-level derivation is the practical first pass; the `inviteUser` guard is the authoritative gate. If the drawer's `derivedBrandId` were silently broken but `inviteUser` still received a store-ID list, the `inviteUser` derive would correct it and the jest suite would still pass — but that scenario cannot arise in practice because the drawer already passes `derivedBrandId` (which, for a user with stores, resolves to `brandId ?? null` — the active brand). The gap is noted here for future coverage completeness, not as a block.

### Test run

```
Command: npx jest --no-coverage
Test Suites: 56 passed, 56 total
Tests:       557 passed, 557 total
Time:        2.543 s

Command: npx jest --testPathPattern="inviteUser" --no-coverage
Test Suites: 2 passed (unit src/lib/inviteUser.test.ts + component src/components/cmd/InviteUserDrawer.test.tsx)
Tests:       12 passed, 12 total
Time:        0.456 s

Command: npx tsc --noEmit
Exit 0 — no errors.

Command: npx tsc -p tsconfig.test.json --noEmit
Exit 0 — no errors.
```

No regressions. The four new cases in `src/lib/inviteUser.test.ts` all pass.

### Notes

- **No pgTAP run** — correct. Architect confirmed app-level-only guard, no migration, no DB change. The `db-migrations-applied` gate is not triggered.
- **No shell smoke** — correct per spec (no edge function touched).
- **Developer reported 56 suites / 557 tests** (updated from the original estimate of 51/557 after the new file was added). The actual run confirms 56 suites / 557 tests.
- **`console.warn` noise** — the `process.env.EXPO_OS` warning across several suites is a pre-existing infrastructure issue unrelated to this spec; it does not affect test outcomes.
- **Headline derive test is non-vacuous** — confirmed by reading both the mock setup and the assertions: passing `brandId: null` with a store ID, mock returning `{ brand_id: BRAND_A }`, and asserting the INSERT payload's `brand_id === BRAND_A`. Removing the derive block would cause line 110 to fail. Removing the stores read would cause line 107 to fail.
