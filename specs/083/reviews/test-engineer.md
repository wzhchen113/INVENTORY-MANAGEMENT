## Test report for spec 083

### Acceptance criteria status

**Data / migration (backfill)**

- AC1: An invitation resolvable to a profile with brand X has `brand_id = X` (no longer NULL) after the migration. → PASS — `supabase/tests/invitations_brand_id_backfill.test.sql::arm 2` (UPDATE #1 profile_id path) and `::arm 4` (UPDATE #2 name fallback path) both assert `brand_id` equals the linked profile's brand_id after the inline UPDATEs run.

- AC2: The migration is idempotent (second run links/updates zero additional rows). → PASS — `supabase/tests/invitations_brand_id_backfill.test.sql::arm 6` re-runs BOTH inline UPDATEs and asserts the arm-2 row is unchanged.

- AC3: The migration does NOT touch `invitations.brand_id` for rows whose linked profile has a NULL brand (accepted bootstrap gap). → PASS — `supabase/tests/invitations_brand_id_backfill.test.sql::arm 3` inserts an invitation linked via profile_id to a NULL-brand profile, runs UPDATE #1, and asserts `brand_id IS NULL` on that invitation.

- AC4: The migration does NOT modify any function/RPC body (data-only). → PASS — `grep -c "CREATE|ALTER|DROP|GRANT|REVOKE|FUNCTION|PROCEDURE|POLICY|TABLE|INDEX|COLUMN"` on the migration file returns 0. The migration file is a single `do $$ … $$` block with no DDL.

- AC5: Migration file timestamp sorts AFTER `20260531000000_consume_invitation_sets_profile_id.sql` (spec 082). → PASS — `20260531010000_invitations_brand_id_backfill.sql` confirmed present and sorts strictly after `20260531000000` in `ls supabase/migrations/`.

**Query relaxation (TS)**

- AC6: `fetchInvitationsForUserLookup` returns an invitation row matched by `profile_id` even when a `brandId` is passed and that invitation's `brand_id` is NULL. → PASS — `src/lib/db.fetchInvitationsForUserLookup.test.ts::(a)` passes a `brandId`, mocks the invitations table to return a `brand_id: null` row, and asserts the row is in the result. Also confirmed in db.ts: the `if (brandId) q = q.eq('brand_id', brandId)` line has been removed; the query now unconditionally selects from `invitations` without brand filter.

- AC7: `fetchAllUsers(opts)` returns a non-empty `email` for a profile whose only matching invitation is NULL-brand, in BOTH the brand-scoped (`opts.brandId` set) AND all-brands (`opts.brandId` undefined) calls. → PASS — `src/lib/auth.fetchAllUsers.test.ts` contains two arms: the first calls `fetchAllUsers({ brandId: BRAND })` and asserts `bob.email === 'bobby@example.com'`; the second calls `fetchAllUsers()` and asserts `chuck.email === 'charles@example.com'`. Both cases explicitly tested.

**UI behavior (consequence, verified manually per spec)**

- AC8: Bobby and Charles render their email (not "(email not loaded)") in both the super_admin all-brands view and a brand-scoped view. → NOT TESTED (automated) — The spec explicitly designates these as "verified manually" (spec §"UI behavior (consequence, verified manually — see test notes)"). No automated test exists or is warranted here; the fix is fully exercised by the jest arms above at the loader level. The UI consequence is transitively covered: `fetchAllUsers` is the direct feed to `UsersSection.tsx`, and AC7 asserts the email is non-empty. Manual verification at deploy time is required per the spec.

- AC9: Reset-Password and Delete are no longer blocked by the empty-email guard for Bobby and Charles. → NOT TESTED (automated) — Same posture as AC8. The block condition in `UsersSection.tsx:77` is `if (!u.email)`. AC7 asserts `u.email` is non-empty; the unblocking is a direct logical consequence. The spec treats this as a manual verify item. No automated test is feasible without a full UI integration test (Playwright against prod-shaped data), which is out of scope per the spec's "Out of scope" section.

---

### Test run

**jest (targeted)**
```
npx jest src/lib/db.fetchInvitationsForUserLookup src/lib/auth.fetchAllUsers --no-coverage
PASS unit src/lib/db.fetchInvitationsForUserLookup.test.ts
PASS unit src/lib/auth.fetchAllUsers.test.ts
Test Suites: 2 passed, 2 total
Tests:       4 passed, 4 total
```

**jest (full suite)**
```
npx jest --no-coverage
Test Suites: 44 passed, 44 total
Tests:       406 passed, 406 total
(2 console.warn / console.error lines in unrelated tests — pre-existing noise, not regressions)
```

**pgTAP**
```
npm run test:db
== supabase/tests/invitations_brand_id_backfill.test.sql ==
  PASS supabase/tests/invitations_brand_id_backfill.test.sql (6 assertion(s) passed)
... [all 40 files pass] ...
✓ 40/40 DB test file(s) passed
```

**typechecks**
```
npx tsc --noEmit                                  # exit 0
npx tsc -p tsconfig.test.json --noEmit            # exit 0
```

---

### Notes

**Byte-identity of inline UPDATEs vs migration (drift discipline check).** The spec and the test header both require the pgTAP inline UPDATE copies to be byte-identical to the migration's DO block statements. Verified via normalized comparison: UPDATE #1 and UPDATE #2 are logically identical in both files. The only difference is indentation style (the migration uses 5-space alignment inside the DO block; the test uses 3-space at the top level) — this is the same documented de-indent convention spec 082 applies to its inline copy. Semantic content is identical.

**Arm 4 seed-name check.** The pgTAP arm 4 fixture inserts a sentinel invitation with `name = 'Tara Manager'` and asserts it matches the seed manager profile. Confirmed: `supabase/seed.sql` line 119 inserts the manager profile with name `'Tara Manager'` and UUID `22222222-2222-2222-2222-222222222222`. The match is real, not vacuous.

**Both-cases coverage for AC7.** The spec AC explicitly says "BOTH the brand-scoped (`opts.brandId` set) and all-brands (`opts.brandId` undefined) calls." Confirmed: `src/lib/auth.fetchAllUsers.test.ts` contains two separate `it()` arms — one calling `fetchAllUsers({ brandId: BRAND })` and one calling `fetchAllUsers()` with no argument. Both pass.

**pgTAP arm coverage.** Plan is `plan(6)`. Six arms executed: (1) fixture sanity, (2) UPDATE #1 profile_id fill (core AC), (3) NULL-brand profile left NULL, (4) UPDATE #2 name fallback fill, (5) UPDATE #2 ambiguity guard left NULL, (6) idempotency. All six pass. No grant/`set role anon` arm — correct, the spec and the test header both document this is data-only (avoids the spec-067 CI segfault pattern).

**UI-consequence ACs (AC8, AC9).** The spec itself designates these as manual-verify-only ("UI behavior (consequence, verified manually — see test notes)"). This is acceptable. The loader-level jest arms (AC6, AC7) provide the strongest automatable coverage short of a full E2E Playwright test against prod-shaped data, which would require the Bobby/Charles prod users to exist in the local stack — they do not (seed has zero invitations). The manual verification note in the spec is appropriate and acknowledged.

**No fourth framework introduced.** All tests land in the existing tracks: pgTAP (DB) and jest (TS). Shell smoke track not used — correct per the spec ("No shell-smoke track needed").

**Migration ordering dependency.** `20260531010000` (spec 083) depends on spec 082's `20260531000000` having run first (UPDATE #1 requires the spec-082 `profile_id` backfill). Ordering confirmed by file sort. The `db-migrations-applied` drift gate will flag one unapplied migration until `npx supabase db push --linked` is run post-merge — expected and documented in the spec.
