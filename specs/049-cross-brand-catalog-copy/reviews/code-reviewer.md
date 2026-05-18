# Code review for spec 049 (re-review after 5 Should-fix fixes)

## Critical

_None._

## Should-fix

_None._ All five Should-fix items from the prior review are correctly resolved:

- **SF1 resolved** — `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql`: `v_source_count` declaration and both `SELECT count(*) INTO v_source_count` table scans are gone. The only `count(*)` calls that remain are in the pre-flight collision-detection DO block, which is correct.

- **SF2 resolved** — `src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx` (new, 4 arms) and `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` (new, 4 arms): Both files deliver the required negative-gate + positive-control shape. Each has 2 arms with `useIsSuperAdmin=false` (checkbox absent, COPY pill absent, bulk pill absent) and 2 positive-control arms including a `fireEvent.press` on the checkbox to confirm the bulk pill appears.

- **SF3 resolved** — `supabase/tests/cross_brand_copy.test.sql:393-413`: Section header now reads "exactly FOUR audit rows in target" and the assertion is `cmp_ok(..., '=', 4, ...)`. Header and assertion are in agreement.

- **SF4 resolved** — `supabase/tests/cross_brand_copy.test.sql`: `plan(14)` (was 13). Fixture block at lines 44-54 promotes `22222222-2222-2222-2222-222222222222` to `'admin'`. Arm (1a) covers `profiles.role='master'`; arm (1b) covers `profiles.role='admin'` using the promoted fixture. Labels are precise. The spec's requirement that admin AND master be rejected is now independently exercised.

- **SF5 resolved** — `selectAllAria` is absent from all three i18n catalogs (`en.json`, `es.json`, `zh-CN.json`) and from all component and screen files. The parity check in `i18n.test.ts` continues to pass because the removal was applied uniformly across all three catalogs.

## Nits

The following Nits from the original review are unchanged in the re-reviewed code. They are not regressions introduced by the fixes; they existed before and were not in scope for this fix pass.

- `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql:124` — `set search_path = public, auth` deviates from the existing `copy_brand_catalog` precedent (`set search_path = public`). The only `auth`-schema reference (`auth.uid()` at line 284) is schema-qualified, so `auth` in the search path is redundant. Harmless but inconsistent.

- `src/components/cmd/CopyToBrandDialog.tsx:9` — The imported type is `CopyCatalogResult`; the spec §F names it `CopyCatalogRowsResult`. Minor naming inconsistency between spec and implementation.

- `src/screens/cmd/sections/InventoryCatalogMode.tsx` and `src/screens/cmd/sections/VendorsSection.tsx` — `e.stopPropagation?.()` uses optional chaining on a method that is always defined on `GestureResponderEvent`. The `?.` is unnecessary noise.

- `src/components/cmd/CopyToBrandDialog.tsx:128` — `submitting` is listed in the `useCallback` deps array of `handleConfirm`. The guard at line 104 (`if (!targetBrandId || submitting || ...)`) means the dep is functionally needed, but the ref pattern at lines 133-134 (`handleConfirmRef.current = handleConfirm`) already ensures the keyboard handler always calls the latest version. Callback identity churn on every `submitting` state flip without behavior benefit. Low impact.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 4 Nits (all pre-existing; the 5 Should-fix items from the prior review are fully resolved).
