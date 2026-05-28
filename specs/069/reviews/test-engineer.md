## Test report for spec 069

### Acceptance criteria status

- AC1: Bug fixed — a NULL-brand staff user can read catalog_ingredients for their brand; EOD embed returns non-null name → PASS — `supabase/tests/staff_brand_id_backfill.test.sql::arm (2)` (auth_can_see_brand + catalog SELECT > 0 rows) + `arm (6)` (EOD join returns 0 null-name rows across all 143 Towson inventory_items)
- AC2: The vendors embed is also fixed — same staff user reading brand-A vendors returns > 0 rows → PASS — `supabase/tests/staff_brand_id_backfill.test.sql::arm (5)`
- AC3: Approach decided and approved — Option A chosen, blast-radius analysis in spec §1, user approval on record → PASS (gate met before build; not a test assertion but a process AC)
- AC4: Backfill correctness — every role='user' profile with ≥1 user_stores row has non-NULL brand_id post-backfill; pgTAP asserts zero NULL-brand-staff-with-stores rows remain → PASS — `arm (10)` (backfill UPDATE sets correct brand) + `arm (11)` (post-backfill invariant zero-count)
- AC5: Invite flow — a newly-invited role='user' user has profiles.brand_id set to their store's brand after registerInvitedUser; no regression to admin path → PASS — `src/lib/registerInvitedUser.test.ts::stamps profiles.brand_id from resolved_brand_id for a staff (role=user) invite` + `leaves the admin invite path unchanged` + `does NOT use resolved_brand_id for an admin invite even if the two ever diverge`
- AC6: No cross-brand regression — brand-A admin cannot read brand-B catalog or vendors → PASS — `supabase/tests/staff_brand_id_backfill.test.sql::arm (7)`
- AC7: Prod verification plan stated — §8 lists the exact pre-migration count query + three post-deploy curl/SQL probes → PASS (stated in spec; execution is post-deploy by user/main Claude, not a test artifact)
- AC8: Tests land on named tracks — pgTAP for RLS/backfill (37 files including new one); jest for auth.ts change (4 new tests in registerInvitedUser.test.ts); no shell smoke needed → PASS

### Test run

**jest (full suite):**
```
npm test -- --no-coverage
Test Suites: 35 passed, 35 total
Tests:       334 passed, 334 total   (up from 330; 4 new from spec 069)
Time:        2.07 s
```

**typecheck (base + test):**
```
npm run typecheck       — clean (0 errors)
npm run typecheck:test  — clean (0 errors)
```

**pgTAP (after npx supabase db reset):**
```
bash scripts/test-db.sh
37/37 DB test file(s) passed
staff_brand_id_backfill.test.sql — PASS (13 assertion(s))
```

Count went from 36 to 37 files as expected.

### Mutation test result — CRITICAL FINDING

**Finding:** The pgTAP test does NOT catch a broken/missing migration backfill UPDATE. When the backfill UPDATE in `20260528020000_staff_brand_id_backfill.sql` was commented out and the DB reset, all 13 arms of `staff_brand_id_backfill.test.sql` still PASSED.

**Root cause:** The test is hermetically self-contained. Every arm that exercises the fix (arms 2, 5, 6, 10, 11) performs its own inline fixture setup (explicitly calling `update public.profiles set brand_id = brand_a` for arms 2/5/6, or running the backfill UPDATE verbatim inline for arm 10). The post-backfill invariant arm (11) checks `count(*) = 0` of NULL-brand-staff-with-stores — this is trivially true even without the migration's backfill because the seed already has Tara Manager with `brand_id` set (`seed.sql:118-120`). There are NO NULL-brand-staff-with-stores rows in the post-reset state regardless of whether the migration's DO block ran or not.

**Consequence:** The migration's actual backfill DO block has ZERO test coverage as code under test. If a developer introduced a bug into the DO block's UPDATE predicate (wrong WHERE clause, wrong subquery, wrong column) that caused it to silently skip the target rows or set the wrong brand, pgTAP would not catch it. The dev's "143 → 0" observation is a manual prod observation, not a test-enforced invariant.

**Severity:** Medium. The fix is a one-time backfill of 1 row in prod (the "Charles" staff user). Both halves of the permanent fix (get_pending_invitation RPC widen + registerInvitedUser stamp) are tested and will prevent recurrence. The migration's DO block is also self-guarding (post-backfill RAISE EXCEPTION would fire in prod if the UPDATE misses rows), so a silent failure at deploy time is unlikely. But a regression in a future re-run of the backfill logic (e.g., from a re-seed or new NULL-brand staff) would not be caught.

**What would fix this:** The test would need a seed-state where at least one NULL-brand staff user with user_stores actually exists before the pgTAP transaction begins — meaning the seed or a before-test fixture must create a NULL-brand staff user, and the test must rely on the migration's DO block having already run at reset time to confirm it. Alternatively, arm (11) could be restructured to insert a NULL-brand staff user BEFORE the migration's backfill and verify it is fixed AFTER, rather than running the fix inline.

### Both-halves check (spec §10 risk #2)

PASS — both halves are implemented and tested:

- **Backfill half (existing staff):** `supabase/migrations/20260528020000_staff_brand_id_backfill.sql` DO block. Tested by arms (10)/(11) via inline logic replication (not via the migration code directly — see mutation test finding above).
- **Future-invite half (new staff):** `get_pending_invitation` RPC widened to return `resolved_brand_id`; `registerInvitedUser` reads `invitation.resolved_brand_id ?? invitation.brand_id ?? null` for `role='user'` invites. Tested by `registerInvitedUser.test.ts` arm 1 (staff invite stamps brand_id from resolved_brand_id). The jest test would catch a regression where the auth.ts stamp was removed or reverted.

### Seed regression check (Tara Manager unaffected)

PASS — The backfill UPDATE is predicated on `brand_id IS NULL`. The seed sets Tara Manager's `brand_id = '2a000000-0000-0000-0000-000000000001'` (`seed.sql:119-120`), so the WHERE clause skips her. There is no explicit pgTAP assertion proving "Tara was not modified by the backfill" — the guard is purely logical (WHERE predicate). Given that arm (11) passes and Tara's existing user_stores (Towson + Frederick, both brand A) would resolve to the same brand anyway, the risk of an unintended side-effect is negligible, but the gap is worth noting.

### "143 → 0" claim verification

The dev's claim that 143/143 blank catalog names → 0/143 after the fix IS captured by arm (6): the pgTAP EOD embed arm runs on a real local DB with the seed's 143 Towson inventory_items (verified: `SELECT count(*) FROM inventory_items JOIN catalog_ingredients ON catalog_id WHERE store_id = Towson` returns 143). Arm (6)'s belt-and-braces check asserts both `count(*) > 0` (at least one row exists, preventing a vacuous pass) and `count(*) = 0` of null-name rows under the fixed staff JWT. A regression that broke the brand stamp and returned null catalog embeds would cause arm (6) to fail because the LEFT JOIN would produce 143 rows where `ci.name IS NULL`.

**However** — this is under the in-test manually-stamped brand_id, not from the migration's backfill. The "143 → 0" outcome is confirmed as a correct test assertion for the RLS/brand fix, but the test does not guard against the migration's DO block being broken (same mutation test finding above).

### Minor findings

1. **Test file name deviation:** The spec §9 names the test file `staff_null_brand_catalog_read.test.sql`; the developer named it `staff_brand_id_backfill.test.sql`. The actual name is arguably more descriptive. Not a blocker.

2. **EODCount.test.tsx null-catalog arm absent:** Per spec §9 Q4 guidance ("no new arm needed there unless a client change lands — it does not"), this is acceptable. The existing tests all mock `catalog: { name: 'Flour', unit: 'lb' }` (non-null) and confirm the UI renders the name. A dedicated arm showing the pre-fix `catalog: null` state would improve documentation but is not required by the spec.

3. **Seed regression arm absent for Tara:** No explicit pgTAP arm asserts that Tara Manager's brand_id is unchanged by the backfill. Low risk (WHERE predicate), but a one-line `is((select brand_id from profiles where id = '22222222...'), brand_a, 'Tara unaffected by backfill')` would close the gap cleanly.

### Summary

The spec's test plan is substantially complete. The two required tracks land with the correct tests. The mutation test revealed one structural gap: the pgTAP test's hermetic inline fixtures mean the migration's backfill DO block code is not itself exercised — a bug in the DO block would not be caught at CI time. The permanent fix (future-invite path) is well-guarded by jest. Given the one-time backfill is 1 prod row and the migration includes a self-guarding RAISE EXCEPTION, this is rated Medium risk, not Critical.

**The release-coordinator should consider:** does the mutation-test gap (migration backfill code has no test coverage) constitute a blocker given the one-time nature of the backfill? The author's position: it is a finding to surface, but given the migration's own post-backfill RAISE EXCEPTION guard, the small prod footprint (1 row), and the fact that the permanent fix is fully tested, SHIP_READY with this as a documented limitation is defensible.

## Handoff
next_agent: NONE
prompt: Test report complete. 8 PASS, 0 FAIL, 0 NOT TESTED across acceptance criteria. One Medium finding: pgTAP mutation test reveals the migration's backfill DO block is not itself under test — the test uses inline fixture logic rather than depending on the migration's UPDATE, so a bug in the migration code would not be caught at CI time. All other coverage is solid: 334 jest tests pass, 37/37 pgTAP files pass, both typechecks clean. The "143 → 0" claim is captured by arm (6) for the RLS fix; the future-invite path is covered by registerInvitedUser.test.ts. SHIP_READY is defensible with the mutation-test gap documented.
payload_paths:
  - specs/069/reviews/test-engineer.md
