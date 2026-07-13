## Test report for spec 116 (US Foods "Import Order" CSV export)

Scope reviewed (staged, uncommitted): `supabase/migrations/20260712000000_vendor_import_order_fields.sql`,
`src/utils/usFoodsImport.ts` + `.test.ts`, `src/lib/db.ts` (vendor field
mapping + bundled `account_number` fix), `src/components/cmd/VendorFormDrawer.tsx`,
`src/screens/cmd/sections/ReorderSection.tsx`, `src/types/index.ts`.

### Acceptance criteria status

1. **Migration** — `vendors` gains 3 additive nullable columns
   (`order_import_format`, `import_distributor_number`, `import_department`),
   no default → **PASS (verified by direct inspection, NOT by an automated
   test)**. Confirmed locally: `\d vendors` on the running
   `supabase_db_imr-inventory` container shows all three columns as nullable
   `text` with no default. No pgTAP asserts this shape (no
   `has_column`/`col_is_null` for these 3 columns anywhere in
   `supabase/tests/`). Low risk to ship without one — additive, no CHECK, no
   RLS change (see security-auditor's confirmation) — but note the immediately
   preceding sibling migration for this same table (`20260709000000_vendor_order_unit.sql`,
   spec 115) DID get a dedicated pgTAP schema-shape + RLS-write assertion in
   `supabase/tests/vendors_role_access.test.sql` (assertions 5-8). This spec's
   columns have no CHECK/NOT NULL to verify, so the omission is defensible, but
   flagging the convention gap.

2. **`VendorFormDrawer` segmented control + conditional reveal** —
   → **NOT TESTED**. `src/components/cmd/VendorFormDrawer.test.tsx` has zero
   references to `orderImportFormat`/`us_foods`/"Distributor"/"Department" —
   grepped, confirmed empty. The file already has a proven pattern for exactly
   this shape of control (the sibling `orderUnit` `SegmentField`, tests at
   lines 64-110: renders both options, defaults, toggles, threads through
   `addVendor`/`updateVendor`, prefills on edit). None of that pattern was
   replicated for the new control. This is PM Risk 3 / the gap the spec itself
   flags ("no live click-through"). Track: **jest** (component,
   `@testing-library/react-native`, same file).

3. **`db.ts fetchVendors` maps 3 new fields** (`order_import_format` →
   `orderImportFormat` undefined-on-null; the other two → `''` on null) →
   **NOT TESTED**. There is no `fetchVendors` test file anywhere in the repo
   (grepped `src/lib/*.test.ts` for `fetchVendors`/`createVendor` — zero real
   hits, only a comment mention in `db.updateVendor.test.ts:8`). This is a
   pre-existing gap for the whole function, not unique to this feature, but
   the 3 new fields specifically are unverified by any test. Verified correct
   by code reading only (`src/lib/db.ts:1806-1809`). Track: **jest**.

4. **`createVendor`/`updateVendor` persist the 3 new fields; empty string on
   update clears to NULL** → **NOT TESTED**. No `createVendor` test file
   exists. `db.updateVendor.test.ts` (5 tests) covers `deliveryDays` /
   `categories` / `name` / `phone` / `orderUnit` — none of the 3 new fields.
   Verified correct by code reading (`db.ts:2960-2964`, the omit-key-to-skip +
   `|| null` clear pattern matches the established convention exactly). Track:
   **jest** — same file, same pattern, straightforward to extend (see Notes).

5. **`updateVendor` persists `accountNumber` edits (latent bug fix)** →
   **NOT TESTED**. Confirmed by grep: `accountNumber` does not appear
   anywhere in `db.updateVendor.test.ts`. This is exactly the "PM nice-to-have
   #4" the task called out, and exactly the bug class this test file was
   *written* to catch for `deliveryDays`/`categories` (see the file's own
   header comment). See **Critical** note below — a naive regression test
   here would not be sufficient on its own; see why.

6. **`buildUsFoodsImportCsv` pure function, exact 19-col header in template
   order** → **PASS** — `src/utils/usFoodsImport.test.ts::'emits the exact
   19-column template header'`.

7. **Only ordered items written; at/above-par excluded and NOT counted as
   skipped** → **PASS** —
   `usFoodsImport.test.ts::'excludes have-enough (at/above par) items from the
   order file'` (asserts `included: 0` AND `skippedNoCode: 0`, i.e. not
   miscounted as a skip).

8. **Item with no resolvable `order_code` is SKIPPED (never emitted with
   blank PRODUCT NUMBER) and counted in `skippedNoCode`** → **PASS** —
   `usFoodsImport.test.ts::'SKIPS items with no order code and counts them'`
   (also asserts the emitted CSV does NOT contain the missing-code item's
   other identifying value, i.e. no half-written row).

9. **Case-sized items write CS=suggestedCases/EA=0; no-case items write
   CS=0/EA=suggestedQty** → **PASS** —
   `usFoodsImport.test.ts::'maps a case item...'` and `'...no-case item into
   EA (CS = 0)'`.

10. **DATE → M/D/YYYY (no leading zeros); DEPARTMENT defaults `'0'` when
    blank; PRODUCT NUMBER = order_code; DESCRIPTION = item name; EXTENDED
    PRICE = server-rounded `estimatedCost`** → **PASS** — DATE/PRODUCT
    NUMBER/DESCRIPTION/EXTENDED PRICE all asserted in the `'maps a case item'`
    test (`row[3]`, `row[5]`, `row[7]`, `row[14]`); DEPARTMENT-blank-default
    asserted in `'defaults DEPARTMENT to 0 when blank...'`.

11. **Empty order → valid header-only file** → **PASS** —
    `usFoodsImport.test.ts::'...renders a header-only file for an empty
    order'` (asserts exactly 1 non-empty line).

12. **`ReorderSection` `onCsvPress` detects a displayed vendor with
    `orderImportFormat === 'us_foods'` and emits
    `USFoods_ImportOrder_<store-slug>_<date>.csv` instead of the generic CSV;
    otherwise unchanged** → **NOT TESTED**. Grepped both
    `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx` and
    `ReorderSectionCases.test.tsx` for `usFoods`/`UsFoods`/`US_FOODS`/
    `orderImportFormat`/`onCsvPress` — zero hits in either file. This is the
    single integration point that actually invokes the feature end-to-end
    (branch selection, header assembly from vendor config, filename
    construction, fallback-to-generic-CSV path) and it has no coverage at any
    layer — no jest/RTL test, no pgTAP (not applicable), no shell smoke. This
    is the PM's Risk 3 in its most concrete form.

13. **Toast reports included count and, when >0, skipped-no-code count** →
    **NOT TESTED**. Same gap as #12 — `handleUsFoodsImportExport`'s
    `Toast.show` call is entirely unexercised by any test.

14. **jest: `usFoodsImport.test.ts` covers header shape / case→CS /
    no-case→EA / skip-no-code / exclude-have-enough / header-only-empty; full
    jest suite stays green** → **PASS** — ran both; see Test run below.

### Test run

```
npx jest usFoodsImport --silent
PASS unit src/utils/usFoodsImport.test.ts
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total

npx jest db.updateVendor --silent
PASS unit src/lib/db.updateVendor.test.ts
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total

npx jest --silent   (full suite)
Test Suites: 99 passed, 99 total
Tests:       1136 passed, 1136 total
Time:        ~3.6s

npm run typecheck            → clean, no errors
npm run typecheck:test       → clean, no errors

npm run test:db (pgTAP, full run against local supabase_db_imr-inventory)
64/65 files PASS, 1/65 FAIL:
  supabase/tests/item_vendors_rls.test.sql — assertion 12 failed
    "(12) non-member UPDATE cannot write order_code on a Charles link
    (stays NULL — RLS regression pin)"
    have: 8302192   want: NULL
```

**The `item_vendors_rls.test.sql` failure is PRE-EXISTING and unrelated to
spec 116.** Reproduced identically on `main` with all spec-116 staged changes
stashed out (confirmed via `git stash` / rerun / `git stash pop` + re-stage).
Root cause: the fixture assumes a specific (first-Charles-item,
first-vendor-by-id) `item_vendors` row starts with `order_code = NULL`, but
that exact pair already carries a real order code (`8302192`, US FOOD /
Charles) from the spec-114 backfill data that's present in the local dev DB
(matches the "36 order codes across 141 links, already DONE in prod" note in
this spec's own "Out of scope" section — that data is also synced locally).
**This is not a security regression** — the assertion that failed is the
"stays NULL" expectation, not "did the value change to `HACK-1`"; the RLS
write was in fact still correctly blocked (the value is the pre-existing real
code, not the attempted `'HACK-1'`). It is a stale test-fixture assumption
invalidated by unrelated backfilled data, not a symptom of anything in the
staged diff (the staged migration only touches `vendors`, never
`item_vendors`). Flagging for visibility since it affects overall pgTAP
health (`64/65`, not `65/65`), but it does not block spec 116 and none of
spec 116's own tests touch `item_vendors`.

### Notes — ranked Critical → Should-fix → Nits

**Critical**

- **AC12/AC13 (`ReorderSection` `onCsvPress` US-Foods branch + toast) are
  genuinely uncovered by every track.** Per my system instructions, any AC
  marked NOT TESTED is a Critical finding for the release-coordinator
  regardless of my own risk read, so I'm marking it as such — but for the
  record, my own risk assessment: this is the sole user-facing trigger for
  the entire feature, it's glue code across three store slices
  (`vendorsList`, `inventory`, `exportPayload`) rather than a pure function,
  and this exact class of bug — new state silently not wired through, so the
  feature no-ops back to old behavior with no error surfaced — is the
  precise bug class that has repeatedly bitten this codebase on `db.ts`
  (`deliveryDays`/`categories`, and now `accountNumber`, per the comments in
  `db.ts` itself). A wiring mistake here (e.g. `vendorsList` never actually
  containing the US-Foods-tagged vendor because of a stale selector, or the
  `find` picking the wrong vendor when multiple are displayed) would silently
  fall through to the generic CSV with zero test or runtime signal. Concrete,
  cheap test to close this: a jest/RTL test on `ReorderSection.test.tsx`
  mocking `useStore` to return one `us_foods`-tagged vendor + a matching
  `exportPayload`, spying on `triggerDownload`/`Blob`, pressing the CSV
  button, and asserting (a) the filename matches
  `USFoods_ImportOrder_<slug>_<date>.csv`, (b) `buildUsFoodsImportCsv` (or its
  output) reflects the vendor's header fields, (c) the generic CSV path is
  NOT taken. A second test with two displayed vendors (one US-Foods, one not)
  covering the Risk-1 "first vendor wins" behavior would also close a
  documented spec risk.

- **`db.ts` `updateVendor`'s terminal call swallows errors — already flagged
  Critical by code-reviewer** (`src/lib/db.ts:2972`:
  `await supabase.from('vendors').update(dbUpdates).eq('id', id).abortSignal(signal);`
  — no `{ error }` destructure, no `if (error) throw`). This is directly
  relevant to my mandate here: it means **any regression test added for
  AC4/AC5 in the existing `db.updateVendor.test.ts` style (asserting
  `updateSpy` was called with the right body) would NOT catch this bug**,
  because that style of test only inspects the arguments passed into
  `.update()`, never the resolved/rejected outcome of the call. A test suite
  that only added "does the body include `account_number` / the 3 new
  fields" assertions (the PM's "nice-to-have #4", the natural next step)
  would go green while the underlying write-failure-reports-success defect
  remains completely undetected — false confidence. Closing AC4/AC5 properly
  needs **two** things in `db.updateVendor.test.ts`: (1) the field-persistence
  assertions the PM asked for, mirroring the existing `deliveryDays`/
  `categories` tests, AND (2) a new test that mocks the terminal call to
  resolve with `{ error: {...} }` and asserts `updateVendor(...)` REJECTS —
  which will currently fail until the code-reviewer's fix lands. I'm not
  writing or fixing this myself per my instructions (bug goes back to the
  developer), but flagging that the "add a persistence test" ask, taken
  literally, would not have caught the more serious defect sitting right next
  to it.

**Should-fix**

- **AC1 (migration shape)** has no pgTAP coverage, breaking the
  immediately-preceding sibling migration's convention
  (`vendors_role_access.test.sql` asserts `order_unit`'s shape). Low risk
  here (no CHECK/NOT NULL to verify, no RLS change per security-auditor's
  confirmation), so I would not block on this alone, but a 3-assertion
  `has_column`/`col_is_null` addition to `vendors_role_access.test.sql` would
  close the gap cheaply and match project convention.
- **AC3 (`fetchVendors` mapping)** and the `createVendor` half of **AC4** have
  no jest coverage at all — this is a pre-existing gap for these two
  functions generally (no test file exists for either), not unique to this
  feature, so I'm not ranking it above Should-fix. Recommend a small
  `db.fetchVendors.test.ts` (mirroring `db.updateVendor.test.ts`'s mocking
  shape) at minimum for the 3 new fields' null→undefined/`''` mapping, since
  that mapping is new-to-this-spec logic, not inherited.
- **The `item_vendors_rls.test.sql` pre-existing failure** (see Test run
  above) should be raised to the developer/PM as a separate ticket — it's a
  stale fixture assumption, not a security hole, but it means the pgTAP
  track is not currently fully green on `main`, independent of spec 116.

**Nits**

- None beyond what code-reviewer/security-auditor already filed against the
  implementation itself (i18n hardcoding, type narrowing, formula-injection
  hardening) — out of this report's scope (test coverage), but worth reading
  alongside this file since the formula-injection Should-fix
  (security-auditor) and the missing-error-throw Critical (code-reviewer) are
  both things a more complete test suite (an injection-neutralization unit
  test; the error-rejection test above) would have caught mechanically.

### Framework note

No new test framework was introduced or needed. All recommended additions
above stay within the existing jest track (`usFoodsImport.test.ts`,
`db.updateVendor.test.ts`, `VendorFormDrawer.test.tsx`,
`ReorderSection.test.tsx`) or the existing pgTAP track
(`vendors_role_access.test.sql`). No shell-smoke work applies — this feature
has no edge function or RPC surface.
