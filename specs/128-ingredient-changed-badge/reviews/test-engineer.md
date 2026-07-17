## Test report for spec 128

### Acceptance criteria status

- AC1: Photo change (`catalog_ingredients.image_path`) shows the "Updated" badge for every store in the brand whose most recent relevant count did not include the change → **PASS** — `supabase/tests/ingredient_changed_badge.test.sql::(9) updating image_path stamps image_changed_at`, `::(14) changed item that was never counted → updated=true`, `::(17) a SUBMITTED eod count after the change clears the badge`. Note: the pgTAP fixture uses a single store, so "every store in the brand" is verified structurally (one shared `catalog_ingredients` row, joined per-store in the RPC) rather than with an explicit two-store fixture. Low risk — `image_changed_at` lives on the shared catalog row and the RPC's per-store predicate (`where ii.store_id = p_store_id`) is a trivial WHERE-clause guarantee, not a computation that needs a dedicated multi-store pgTAP case. Flagged for completeness, not blocking.

- AC2: Primary-vendor change (`inventory_items.vendor_id`) shows the badge only on that store's rows → **PASS** — `ingredient_changed_badge.test.sql::(11) changing vendor_id stamps vendor_changed_at`, `::(18) change AFTER the last submitted count → updated=true`. Same note as AC1: cross-store non-leakage is enforced by the RPC's `store_id` filter (trivial by construction, matches the existing per-store RLS pattern already covered by `supabase/tests/staff_role_eod_rls.test.sql` / `item_vendors_rls.test.sql`), not independently re-tested with two stores here.

- AC3: Badge clears for a store once that store submits a count that includes the item; does not clear for other stores that haven't recounted → **PASS** (highest-risk AC, directly tested) — `ingredient_changed_badge.test.sql::(17)` (submitted EOD after change clears), `::(18)` (change after last count re-sets to true), `::(19)` (last_counted_at is max over BOTH eod + weekly submitted counts — weekly clears it), `::(20)` (a DRAFT weekly does NOT clear — draft exclusion confirmed). Cross-store isolation is the same structural `store_id` filter noted in AC1/AC2.

- AC4: Unchanged item (no photo/vendor change) shows no badge → **PASS** — `ingredient_changed_badge.test.sql::(16) item with no photo/vendor change (changed_at NULL) → updated=false`.

- AC5: Subtle in-context visual near the thumbnail, no layout shift, no overlap with count input, renders web + native → **PASS** (component + row-composition level) — `src/screens/staff/components/UpdatedBadge.test.tsx` (renders label/testID/a11y label), `EODCount.test.tsx::EODCount — spec 128 Updated badge` and `WeeklyCount.test.tsx::WeeklyCount — spec 128 Updated badge` (badge composes inside the existing `itemNameRow`, alongside the name and, on Weekly, the LOW pill, never overlapping the trailing count inputs — confirmed by reading the row JSX). No live-browser/screenshot verification was performed in this pass (no `preview_*` tooling reachable for the staff-only surface, same disclosed gap as spec 127); jsdom/react-native-web rendering under jest-expo is the coverage that exists. Flagged as a gap, not a block — matches the project's existing disclosed limitation for this staff subtree.

- AC6: The `updated` signal reaches the row through the existing staff fetch/projection as a computed boolean, no separate per-row query → **PASS** — `src/screens/staff/lib/itemsUpdated.test.ts::calls staff_items_updated with p_store_id` (one call, store-scoped, not per-item), plus the EOD/Weekly merge tests confirm a single RPC call feeding a `Set` merged onto every row.

- AC7: Staff have no acknowledge/dismiss control → **PASS** (by inspection, not an explicit negative test) — `UpdatedBadge.tsx` is a plain `View`/`Text` pill with no `onPress`/`Touchable*` wrapper and no dismiss affordance; `UpdatedBadge.test.tsx` does not simulate a press because there is nothing to press. No test asserts "tapping the badge does nothing," but there is no interactive surface to assert against — treated as adequately covered by absence of any interaction handler in the implementation.

- AC8: Delivery is visual only — no push, no admin bell/notification, no new notification rows → **PASS** — confirmed by diff inspection: no changes to `src/lib/webPush.ts`, no edge functions touched, no new notification-table writes; the migration is columns + triggers + one `security invoker` RPC only.

### Test run

**pgTAP** — `bash scripts/test-db.sh supabase/tests/ingredient_changed_badge.test.sql`
```
== supabase/tests/ingredient_changed_badge.test.sql ==
  PASS supabase/tests/ingredient_changed_badge.test.sql (20 assertion(s) passed)
✓ 1/1 DB test file(s) passed
```
All 20 assertions green, including the SD-1 non-interference guard (cost-only update does NOT stamp `vendor_changed_at`, test 12) and the `IS DISTINCT FROM` no-op guard (re-writing the same `vendor_id` does NOT stamp, test 13).

**jest (filtered)** — `npx jest itemsUpdated UpdatedBadge EODCount WeeklyCount`
```
Test Suites: 6 passed, 6 total
Tests:       80 passed, 80 total
```

**jest (full)** — `npx jest`
```
Test Suites: 120 passed, 120 total
Tests:       1285 passed, 1285 total
```
Matches the expected 1285 total called out in the task.

**Typecheck gates**
- `npx tsc --noEmit` — clean, exit 0.
- `npm run typecheck:test` — clean, exit 0.
- `npx jest i18n.test` — 2 suites / 24 tests passed (staff `chrome.count.updatedBadge` key present in `en.json` / `es.json` / `zh-CN.json`, parity test green).

Local DB sanity check before running pgTAP: confirmed via `psql \d` that `catalog_ingredients.image_changed_at`, `inventory_items.vendor_changed_at`, and both `BEFORE UPDATE` triggers already exist in the local container (migrations 127/128 pre-applied), so the pgTAP run reflects real applied schema, not just the file contents.

### Notes

- **Highest-risk ACs (per task) are directly and solidly covered:**
  (a) badge clears once the store counts the item — pgTAP tests 17/19/20 pin the exact `submitted_at` comparison, including the max-over-both-count-kinds and draft-exclusion edge cases;
  (b) triggers don't false-stamp on cost-only/same-vendor writes — pgTAP tests 10/12/13 pin the `IS DISTINCT FROM` guard for both the name-only and cost-only no-op cases, plus the same-vendor re-write case explicitly called out in the SD-1 risk section;
  (c) the fetch never blocks the count screen — `itemsUpdated.test.ts` proves the helper never rejects (error, thrown, non-array payload all degrade to an empty `Set`), and both `EODCount.test.tsx` / `WeeklyCount.test.tsx` add a dedicated "still renders the rows when the badge RPC fails" test proving the primary item list is unaffected by an `staff_items_updated` failure.

- **Minor, non-blocking gap:** no pgTAP fixture exercises two distinct stores side-by-side to empirically prove "store A's badge doesn't leak to store B" / "brand-level photo change appears for every store." The RPC's `where ii.store_id = p_store_id` predicate makes this structurally guaranteed (same posture as the already-covered `report_weekly_lowstock` RPC and the existing per-store RLS pgTAP suite — `staff_role_eod_rls.test.sql`, `item_vendors_rls.test.sql`), so this is a documentation/completeness note rather than an uncovered behavior worth blocking on.

- **RLS on `staff_items_updated` itself is not independently pgTAP-tested** — the test file runs as the `postgres` superuser (RLS bypassed) and its own header comment explicitly defers RLS coverage to the existing per-store policy test suite, since the RPC is `security invoker` and adds no new policy. Consistent with project convention; not a gap introduced by this spec.

- **No visual/browser verification of the badge render** was possible in this pass — same disclosed limitation as the frontend-developer's own verification notes (staff surface unreachable via the admin-only local login, no `preview_*` tooling available for this environment). Coverage rests on jsdom/react-native-web unit/integration tests. If a future spec sets up a staff-login preview path, a manual visual check of "no layout shift / no overlap with count input" on both EOD and Weekly rows would close this out definitively — not required to ship.

- **Migration ordering dependency (127 before 128)** is enforced by timestamp naming (`20260721000000_ingredient_photos.sql` before `20260722000000_ingredient_changed_badge.sql`) and confirmed applied together in the local stack in the correct order.

- No fourth test framework introduced; all new tests landed in the existing three tracks (pgTAP, jest) per spec 022 routing. No shell-smoke coverage needed (no edge function touched, confirmed above).

- `app.json` slug untouched (confirmed via `git status`), consistent with the hard rule.
