# Code review for spec 119

Scope: `supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql`,
`supabase/tests/apply_item_vendors_to_brand.test.sql`, `src/lib/db.ts`
(`applyItemVendorsToBrand`), `src/store/useStore.ts`
(`applyVendorsToAllStores`), `src/components/cmd/IngredientForm.tsx` +
`IngredientFormDrawer.tsx`, and the three i18n catalogs.

### Critical

None.

### Should-fix

- `src/lib/db.ts:538` — `applyItemVendorsToBrand`'s `track()` callback is
  `async () => { ... }` — it never declares the `signal` parameter, and the
  `supabase.rpc('apply_item_vendors_to_brand', {...})` call is never chained
  with `.abortSignal(signal)`. This violates the "Spec 055 discipline note"
  documented at the top of this same file (`src/lib/db.ts:4-25`), which is
  explicit: *"Always chain `.abortSignal(signal)` on the PostgrestBuilder
  BEFORE `await`... if the chain is missed, the call still works but is
  un-cancellable (the 30s timer will leave the fetch running silently)."*
  Every sibling RPC wrapper in the file — including the ones cited by this
  spec's own design doc as the reference shape (`copyBrandCatalog` at
  `src/lib/db.ts:4176-4180`, `submitInventoryCount` at `:1168-1184`,
  `previewBrandCascade`, `hardDeleteBrand`, etc.) — takes `(signal)` and
  chains `.abortSignal(signal)`. Concretely, if this RPC hangs, the
  `useInflight` 30s hard-abort timer fires `ctrl.abort()`, but since nothing
  in the callback is wired to `ctrl.signal`, the underlying fetch keeps
  running and the `await fn(ctrl.signal)` inside `track()` never settles —
  so unlike every other write path in the app, this one gets no "Request
  timed out" toast and the "Apply vendors to all stores" button spins
  forever with `applyingToAllStores` stuck `true`. Fix: add the `signal`
  param and chain `.abortSignal(signal)` on the RPC call, matching every
  other wrapper in the file.

### Nits

- `src/lib/db.ts:552` — `const row: any = data ?? {};` uses a bare `any`
  where sibling RPC wrappers in this file cast to a concrete shape instead
  (e.g. `submitInventoryCount`'s `const result = (data || {}) as { count_id?:
  string; conflict?: boolean; entry_ids?: string[] };` at `src/lib/db.ts:1189`,
  or `previewBrandCascade`'s dedicated `mapCascadePreview`). A typed cast here
  (`{ updated_count?: number; skipped_count?: number; skipped_store_ids?:
  string[] }`) would catch a snake_case typo against the RPC's actual return
  shape instead of silently reading `undefined`.
- `supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql:110-114`
  — the target-set query selects `ii.store_id` into the loop record
  (`v_item`), but `v_item.store_id` is never read anywhere in the loop body
  (the per-store filter already happened in the query's `WHERE` clause).
  Harmless, but the unused column reads as a loose end for a future editor
  wondering why it's there.
- (out-of-scope) `supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql:116-124`
  — the inline comment says the pre-upsert "unset any EXISTING primary"
  step "mirrors `updateInventoryItem`'s proven ordering," but
  `updateInventoryItem` (`src/lib/db.ts:474-518`, untouched by this spec) has
  no equivalent unset-first step — it relies solely on a single multi-row
  upsert and is theoretically exposed to the same transient
  `item_vendors_one_primary_per_item` violation on a primary re-point,
  depending on row-processing order within the statement. This migration's
  extra defensive step is actually more robust than the code it says it
  mirrors, not merely equivalent — worth a wording tweak, and potentially a
  follow-up spec to backport the same guard into `updateInventoryItem`, but
  out of scope for this diff.

### Verified as correct / compliant

- SQL reconcile body: preserve-existing-price vs. seed-new-link is encoded
  correctly in the single `INSERT ... ON CONFLICT DO UPDATE` (insert branch
  seeds `cost_per_unit`/`case_price` from the submitted values; the `DO
  UPDATE` branch touches only `order_code`/`is_primary`/`updated_at`, per
  AC-6). `order_code` propagates on both branches (AC-7). The de-select
  delete (`vendor_id <> all(...)`) correctly reduces to "delete everything"
  on an empty submitted set (AC-5). `is_primary` + the legacy scalar mirror
  are written on every target store (AC-8). The pre-upsert "unset old
  primary" step correctly guards the `item_vendors_one_primary_per_item`
  partial-unique index against a primary repoint, independent of submitted
  array order, and is exercised by pgTAP assertions (6)-(10).
- Auth gate mirrors `copy_brand_catalog`'s reference shape byte-for-byte
  (`auth_is_privileged()` → resolve `brand_id` → `auth_can_see_brand()` →
  per-store `auth_can_see_store()` filter inside the target/skipped
  queries) — never-cross-brand is enforced and pgTAP assertion (1)/(17)/(18)
  cover it.
- `db.ts` convention: no direct `supabase.from`/`.rpc` call outside `db.ts`;
  the RPC is exposed as a single thin wrapper consumed by the store action.
- `useStore.ts` `applyVendorsToAllStores` correctly avoids a naive
  cross-store optimistic write (nothing to optimistically patch for stores
  not held in local state), fires the RPC, reloads only the current store on
  success, and calls `notifyBackendError` + returns `null` on failure — no
  silent-success path. `loadFromSupabase` already swallows its own internal
  errors (`src/store/useStore.ts:1262-1265`), so a reload hiccup after a
  successful RPC write does not get mis-reported as an "Apply vendors to all
  stores failed" toast — the code comment's "non-fatal if the reload
  hiccups" claim checks out.
- `Save` (`handleSave` in `IngredientFormDrawer.tsx`) is untouched — no
  reference to the new action or RPC anywhere in that path.
- The "Apply vendors to all stores" button is genuinely distinct from Save:
  separate `TouchableOpacity` with different styling (bordered `C.panel2`
  vs. filled `C.accent` Save button), gated behind `confirmAction(...)` with
  brand-wide-specific copy, rendered EDIT-mode only (`onApplyToAllStores`
  passed only when `mode === 'edit' && item?.catalogId`), with an in-flight
  guard (`applyingToAllStores`) disabling the button during the call.
- Theming: all new UI in `IngredientForm.tsx` uses `useCmdColors()` tokens
  (`C.border`, `C.panel2`, `C.fg`, `C.fg3`) — no inline hex/color literals
  introduced.
- `confirmAction` (not `window.confirm`/`Alert.alert` directly) gates the
  brand-wide action, matching project convention.
- i18n parity: all six `section.inventory.applyVendors*` keys
  (`applyVendorsAllStores`, `applyVendorsHelp`, `applyVendorsConfirmTitle`,
  `applyVendorsConfirmBody`, `applyVendorsConfirmCta`,
  `applyVendorsSuccessTitle`, `applyVendorsSuccessDetail`) are present at
  identical line numbers in `en.json`/`es.json`/`zh-CN.json`, and the
  `{updated}`/`{skipped}` placeholders match the existing `t()` interpolation
  convention (`src/i18n/index.ts:89-91`).
- No duplicate `applyItemVendorsToBrand` definition remains in `db.ts` (the
  spec's "Files changed" note about a momentary duplicate copy checks out —
  only one definition exists, confirmed by grep across `src/`).
