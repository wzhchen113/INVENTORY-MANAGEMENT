# Code reviewer findings — Spec 012c

> Note: code-reviewer agent emitted findings as inline output (its system
> prompt restricts file writes); main Claude transcribed verbatim.

## Critical

- **`src/screens/cmd/sections/BrandsSection.tsx:149`** — **Double toast on
  soft-delete of the currently-active brand.** When `softDeleteBrand(sel.id)`
  is called for the brand matching `currentBrandId`, the store action at
  `useStore.ts:543-551` fires `Toast.show({ type: 'info', text1: 'Brand "X"
  was deleted', ... })` via the auto-swap path. Then `handleSoftDelete` at
  BrandsSection:149 fires a second `Toast.show({ type: 'info', text1:
  'Soft-deleted "X"', ... })` on `ok === true`. Operator sees two toasts
  for the same event. Fix: remove the `Toast.show` in `handleSoftDelete`
  and rely solely on the store-side auto-swap toast (better copy:
  "Switched to All brands view"), or guard the screen-level toast on
  `prevBrandId !== sel.id`.

- **`src/lib/db.ts:1757`** — **`mapCascadePreview` uses misleading variable
  name `counts`** that is immediately misread on future maintenance. The
  variable holds `p?.blocking_profile_counts` (admin/user/superadmin
  headcount), not per-table row counts. Per-table row counts are read
  separately from `p?.counts` at line 1774. Not a runtime bug today but
  a maintenance trap. Rename to `profileCounts` or `roleCounts`.

## Should-fix

- **`src/store/useStore.ts:626-633`** — `loadBrandStatsIncludingDeleted`
  overwrites the shared `brandStats` slice with soft-deleted brands
  included. BrandsSection now calls this on every mount (line 81). Any
  other consumer of `brandStats` that assumed pre-012c contract
  (active-only) will see soft-deleted brands. No other consumer today,
  but contract drift is silent. Fix: (a) add separate
  `brandStatsWithDeleted` slice, OR (b) document at the type definition.
  Option (a) cleaner.

- **`src/store/useStore.ts:558`** — Revert path for `softDeleteBrand`
  calls `setCurrentBrandId(prevBrandId)` which has the side-effect of
  triggering `loadFromSupabase`. On intermittent network error, operator
  sees correct revert AND triggers an unnecessary full reload. Fix: use
  `set({ currentBrandId: prevBrandId })` directly.

- **`src/components/cmd/TypeToConfirmModal.tsx:298`** and
  **`src/screens/cmd/sections/BrandsSection.tsx:704`** — `as any` cast to
  suppress TypeScript error on `outlineStyle: 'none'`. Violates CLAUDE.md
  "any casts ... used to suppress type errors." Use typed extension or
  extract a `webInputStyle` constant. Check existing `BrandFormDrawer`
  for the established pattern and replicate.

- **`src/components/cmd/TypeToConfirmModal.tsx:194`,
  `CascadePreviewModal.tsx:251`, `BrandsSection.tsx:890`** — Inline hex
  color literals `'#FFFFFF'` / `'#FFF'` on destructive button text. Should
  use theme tokens. Cmd palette has `C.accentFg` (white in light, black
  in dark). Fix: either (a) add `dangerFg: '#FFFFFF'` to LightCmd/DarkCmd
  (both white since both danger colors are dark enough), or (b) reuse
  `C.accentFg` with a comment.

- **`supabase/migrations/20260510010000_brand_delete_cascade.sql:619`** —
  `user_stores_links` as the JSON key for the `user_stores` table count
  doesn't match the actual table name (`user_stores`). CascadePreviewModal
  renders counts by key — operator sees "user_stores_links" in the
  cascade preview instead of "user_stores" (sounds like an FK
  relationship, not a table). Rename to `'user_stores'` in the RPC. The
  mapper passes counts through as-is so no mapper change needed.

## Nits

- **`src/store/useStore.ts:370`** — `brandDeletionLog: {}` reset in
  `logout` is correct, but if the Should-fix `brandStatsWithDeleted` slice
  lands, `logout` reset needs updating too.

- **`src/components/cmd/CascadePreviewModal.tsx:95`** — Comment cites
  `§211` which is wrong (line-number artefact from earlier draft). Change
  to `§11 risk #4 ("new admin invited mid-flow" mitigation)`.

- **`src/screens/cmd/sections/BrandsSection.tsx:61`** — `tabId` initial
  value `'profile.tsx'` — file-extension-as-tab-id pattern inherited from
  012b. Out-of-scope.

- **`supabase/migrations/20260510010000_brand_delete_cascade.sql`** —
  Migration filename `20260510010000_*` not `20260510000000_*` as spec §0
  probe #9 + §12 state. Backend dev chose 010000 because 012b took the
  000000 slot. Build notes confirm but spec body still references the
  original filename. Update spec body to reflect actual filename.

- **`src/screens/cmd/sections/BrandsSection.tsx:865`** — `canActOn` logic
  excludes `role === 'super_admin'` implicitly (only `admin || master`
  match). Self-protection covers the super-admin case via `isSelf`, but
  `canActOn` could be explicit (`u.role !== 'super_admin'`) for clarity.
