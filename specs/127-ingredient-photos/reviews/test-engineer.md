## Test report for spec 127 (ingredient photos)

### Acceptance criteria status

**Admin (Cmd editor, web-only)**

- AC1: Photo control shows current photo (or placeholder), plus Upload / Replace / Remove → **PASS** — `src/components/cmd/IngredientPhotoControl.test.tsx::"shows UPLOAD (no Remove) when there is no photo"` + `::"shows REPLACE + REMOVE when a photo exists..."`. The `IngredientForm.tsx:970-975` gating (`mode === 'edit' && item?.catalogId && currentStore?.brandId`) that decides whether the control renders at all is verified only by code read — no dedicated `IngredientForm` test exercises add-mode-hides-control vs edit-mode-shows-control.
- AC2: Web-only `<input type="file">`; native does NOT render an upload control → **NOT TESTED** — `IngredientPhotoControl.tsx:47,126-165` correctly `Platform.OS === 'web'`-gates the Upload/Replace/Remove buttons vs a view-only `<Text>` on native, but every test in `IngredientPhotoControl.test.tsx` mocks `Platform.OS` to `'web'` unconditionally (line 12-16). No test renders the component with `Platform.OS !== 'web'` to assert the native branch (no picker/buttons, view-only text). Low risk (simple ternary, code-reviewed correct) but genuinely unexercised.
- AC3: Upload stores object in Storage + sets `catalog_ingredients.image_path`; reload shows the photo → **PARTIAL / NOT TESTED at the db.ts layer** — `IngredientPhotoControl.test.tsx` proves the control calls `downscaleImage` then `useStore().uploadIngredientImage(catalogId, brandId, blob)`, but `useStore` is entirely mocked out, and there is no test anywhere for `src/lib/db.ts::uploadIngredientImage` itself (the function that actually does the storage upload + column update). See AC6.
- AC4: Replace overwrites/updates the object; `image_path` resolves to the new image after reload → **NOT TESTED** — same gap as AC3/AC6; the "new uuid + delete old object" sequencing in `db.ts:4837-4891` has zero test coverage.
- AC5: Remove clears `image_path` (deletes/orphans the object); editor shows placeholder → **PARTIAL** — the placeholder render is covered (`IngredientPhotoControl.test.tsx` shows placeholder/no-Remove-button when no photo, and `IngredientThumb.test.tsx` covers the placeholder path generally). The wiring test proves the control calls `useStore().removeIngredientImage('cat-1')`. The actual `db.ts::removeIngredientImage` column-clear-then-delete sequencing (`db.ts:4900-4930`) is **not** unit tested (`useStore` mocked out in the control test; no store-level test either).
- AC6: Write helper lives in `db.ts`, upload+column-set as one logical op, orphan cleaned up on column-set failure → **NOT TESTED — genuine gap, one of the three highest-risk ACs named for this review.** I grepped the whole repo (`grep -rl "uploadIngredientImage\|removeIngredientImage" --include="*.test.ts*"`) and the only hit is `IngredientPhotoControl.test.tsx`, which mocks `useStore` entirely and never touches real `db.ts`/`supabase.storage`/`supabase.from` code. There is no `db.uploadIngredientImage.test.ts` / `db.removeIngredientImage.test.ts` in the style of the repo's existing per-function convention (`src/lib/db.updateInventoryItemPrimarySwitch.test.ts`, `db.saveCountOrder.test.ts`, `db.updateStore.test.ts`, etc.), and no test in `src/store/useStore*.test.ts` exercises the store's `uploadIngredientImage`/`removeIngredientImage` actions either (revert-on-failure branch included). The design (§14b) explicitly named this test: *"uploadIngredientImage — mock storage+PostgREST, assert sequencing (upload→update→delete-old) and the orphan-cleanup-on-column-failure branch."* That test was not written. I read the shipped code (`db.ts:4837-4930`) and the sequencing/cleanup logic looks correct (upload → update; on update failure, best-effort `storage.remove([newPath])` then re-throw; on success, best-effort remove of the previous object; remove-flow nulls the column first, then best-effort deletes) — but "looks correct on read" is not a substitute for the named test, and per the test-design rule this is a real bug-magnet path (partial-failure branch) that a future refactor could silently break with nothing to catch it.
- AC7: Non-admin / cross-brand admin cannot write; `storage.objects` policies reject; `catalog_ingredients` UPDATE respects brand RLS → **PARTIAL — policy-existence/definition only, not behavioral impersonation.** `supabase/tests/ingredient_photos.test.sql` asserts (via `pg_policies.qual`/`with_check` string matching) that the four policies exist, target the right `cmd`, and reference `auth_is_privileged`/`auth_can_see_brand`/`storage.foldername` — it does **not** actually attempt an INSERT as a simulated non-privileged or cross-brand JWT and assert rejection/acceptance. The test file's own header names this exact gap and cites it as the design's accepted fallback (`storage.objects`' internal row machinery makes direct impersonated INSERTs awkward in the pgTAP harness). This is a lower-risk gap than AC6 because the underlying predicates (`auth_is_privileged()`, `auth_can_see_brand()`) are independently proven behaviorally elsewhere (`supabase/tests/auth_can_see_store_brand_scope.test.sql`, `admin_rpcs_privileged.test.sql`), and the security-auditor's independent code-read (`specs/127-ingredient-photos/reviews/security-auditor.md`) confirms the policy shape is correct and fail-safe. Still, no test in this repo actually *proves* a brand-A admin succeeds and a brand-B admin/non-privileged user fails an INSERT into this specific bucket.

**Staff (count screens)**

- AC8: EOD + Weekly rows (via `ListRow.tsx` composition) display a thumbnail when a photo exists → **PASS (component-level), implicit-only (integration-level)** — `IngredientThumb.test.tsx` directly proves the `<Image>` render path at a resolved URL. `EODCount.tsx:727` / `WeeklyCount.tsx:931` correctly compose `<IngredientThumb path={item.imagePath} testID=... />` into each row (confirmed by code read) and the projection (`image_path` added to the `catalog:catalog_ingredients(...)` select, mapped to `imagePath`) is present at `EODCount.tsx:148,191` and `WeeklyCount.tsx:97,131`. However, none of the fixtures in `EODCount.test.tsx` / `WeeklyCount.test.tsx` set `image_path` on a row, so the existing suites exercise the composition only in the "no photo → placeholder" branch, not the "photo present → Image" branch, end-to-end. No test asserts `eod-item-thumb-<id>` or `weekly-item-thumb-<id>` renders an `<Image>` for a populated fixture.
- AC9: Photo appears for every store in the brand (brand-level, not per-store) → **NOT TESTED** — this rides the pre-existing `catalog_ingredients` ↔ `inventory_items` brand-shared join (same mechanism `i18nNames`/`defaultShelfLifeDays` already use across stores), and no spec-127-specific test constructs two stores in one brand and confirms both see the same `imagePath`. Structurally low risk since it's the identical mechanism already relied on by other brand-shared fields, but genuinely unproven for this field.
- AC10: No-photo row shows a graceful placeholder (no broken image, no layout shift) → **PASS** — `IngredientThumb.test.tsx::"renders the placeholder (no Image) when the path is null"`, `::"...when the path is undefined"`, and `::"uses the same fixed box size in both states (no layout shift)"` (asserts equal width/height between the Image and placeholder render, non-zero). This is the strongest-covered of the three highest-risk ACs named for this review.
- AC11: Staff have no upload/replace/remove control (view-only) → **PASS** — confirmed by code read of `src/screens/staff/components/IngredientThumb.tsx`: the component renders only an `<Image>`/placeholder `<View>`, no `TouchableOpacity`/pressable/file-input anywhere in the staff subtree's photo surface. No negative test explicitly asserts "no button exists," but there is nothing in the component that could render one.
- AC12: `image_path` flows onto `InventoryItem` via the existing catalog→inventory join / `mapItem`, no per-row query → **PASS (by code read / established convention)** — `db.ts:242-247` (`fetchInventory` select + `mapItem`), `db.ts:5060`-area (`mapItem` returning `imagePath: cat.image_path ?? null`), and `fetchCatalogIngredients` all add the field as designed. No dedicated jest test asserts `mapItem`'s `imagePath` hydration specifically, but this matches the repo's existing convention for `i18nNames` (also not directly unit-tested at the `mapItem` level — it's exercised indirectly through consuming screens instead), so this is not a deviation from house testing practice.

### Test run

```
bash scripts/test-db.sh supabase/tests/ingredient_photos.test.sql
  PASS supabase/tests/ingredient_photos.test.sql (14 assertion(s) passed)
  ✓ 1/1 DB test file(s) passed

npx jest downscaleImage IngredientThumb IngredientPhotoControl
  PASS component src/components/cmd/IngredientPhotoControl.test.tsx
  PASS component src/screens/staff/components/IngredientThumb.test.tsx
  PASS unit src/utils/downscaleImage.test.ts
  Test Suites: 3 passed, 3 total
  Tests:       16 passed, 16 total

npx jest (full suite)
  Test Suites: 117 passed, 117 total
  Tests:       1263 passed, 1263 total
  (matches the 1263 figure recorded in the spec's Verification note)

npx tsc --noEmit
  exit 0, clean

npm run typecheck:test
  exit 0, clean
```

No failing tests. Everything that IS tested, passes.

### Notes

**Blocking gap (highest-risk AC, genuinely uncovered):** AC6 — the `src/lib/db.ts`
`uploadIngredientImage`/`removeIngredientImage` sequencing and orphan-cleanup-on-
failure branches have **zero** test coverage, despite being explicitly named in
the design (§14b/c) and flagged as one of the three highest-risk behaviors for
this review. The `IngredientPhotoControl.test.tsx` suite mocks `useStore`
entirely, so it proves only "the control calls the store action with the right
args" — it never touches the real `db.ts` code that does the actual
upload→update→cleanup sequencing, and there's no store-level test either (no
test drives `useStore.getState().uploadIngredientImage(...)` / `.removeIngredientImage(...)`
against a mocked `supabase.storage`/`supabase.from` to prove the revert-on-failure
path or the column-fail → orphan-remove path actually fires). This is exactly
the kind of partial-failure branch that silently rots under refactor with no
test to catch it. I read the shipped implementation and it looks correct against
the design, but "looks correct" is not equivalent to the named test existing.
Recommend a `src/lib/db.uploadIngredientImage.test.ts` (mocking `supabase.storage.from().upload/remove`
and `supabase.from().update()`) asserting: (1) happy-path sequencing order
(read-previous → upload → column-update → delete-old), (2) upload failure short-
circuits before any column update, (3) column-update failure triggers a
best-effort `storage.remove([newPath])` before re-throw, (4) a failed old-object
delete on the happy path is swallowed, not surfaced. A parallel `removeIngredientImage`
test: column-clear happens before the object delete, and object-delete failure
does not throw.

**Named, accepted, non-blocking gap:** AC7 — the pgTAP storage-write-RLS test is
policy-existence/definition assertion only (string-matches `qual`/`with_check`
against `pg_policies`), not a behavioral impersonation test (no actual INSERT
attempted as a non-privileged or cross-brand JWT). The test file's own comments
name this as the deliberate design fallback because directly impersonating
`storage.objects` writes in the pgTAP harness is awkward (the storage schema's
own row machinery — owner columns, triggers — is outside the migration's
surface). This is lower risk than AC6 because: the underlying predicates
(`auth_is_privileged()`, `auth_can_see_brand()`) are independently proven via
behavioral impersonation tests elsewhere in the repo (`auth_can_see_store_brand_scope.test.sql`,
`admin_rpcs_privileged.test.sql`), and the security-auditor's independent code
read (`specs/127-ingredient-photos/reviews/security-auditor.md`) confirms the
policy shape is correct, complete, and fail-safe with 0 Critical/High findings.
I'm not blocking on this one, but flagging it explicitly per the review brief:
if a future change touches the `storage.objects` policy predicates for this
bucket, there is no automated test that would catch a regression in the actual
enforcement (only in the policy's textual definition).

**Minor gaps, not blocking:**
- AC2 (native admin view-only) — implemented (`Platform.OS`-gated) but
  untested; every `IngredientPhotoControl` test mocks `Platform.OS = 'web'`.
- AC8 integration depth — `IngredientThumb` itself is well-tested in isolation,
  but neither `EODCount.test.tsx` nor `WeeklyCount.test.tsx` includes a fixture
  with a non-null `image_path`, so the "photo present on a real count row" path
  is only exercised implicitly (no crash) rather than asserted (`<Image>` present
  with the right `uri`).
- AC9 (brand-wide sharing) — no spec-127-specific test proves two stores in the
  same brand see the same `imagePath`; relies on the pre-existing brand-shared
  catalog join used by other fields.
- AC1 — no dedicated test for `IngredientForm.tsx`'s add-mode-vs-edit-mode
  gating of the photo control (verified by code read only:
  `mode === 'edit' && item?.catalogId && currentStore?.brandId`).

**Framework note:** all new tests correctly stayed within the three named
tracks (jest component/unit tests, pgTAP). No new framework introduced.

**Everything that exists passes.** The gaps above are coverage gaps (missing
tests), not failing tests — nothing needs to go back to the developer for a
fix; the recommendation is to add the named-but-missing `db.ts` sequencing test
before this ships, given it's an explicitly-flagged highest-risk behavior with
a partial-failure branch and currently zero coverage.
