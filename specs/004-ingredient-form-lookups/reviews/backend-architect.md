# Spec 004 — Backend architect post-implementation drift re-review (after fix-pass)

**Reviewer:** backend-architect
**Mode:** post-implementation drift review (re-review after fix-pass)
**Spec:** [`specs/004-ingredient-form-lookups.md`](../../004-ingredient-form-lookups.md)
**Status on entry:** READY_FOR_REVIEW
**Scope:** architectural drift only (contract, schema, RLS, realtime, store actions, probe). Craftsmanship is code-reviewer's lane. This pass adds: (a) re-walk of the prior 0 Critical / 1 Should-fix / 4 Nits and (b) audit for new drift introduced by the fix-pass.

## Summary

The fix-pass landed clean on the architectural surface. Item 1 (slice typing) was applied at every consumer site cited in the release proposal, including the cascade of `(s: any)` / `(c: any)` casts I had no visibility on the first pass. Item 6 (return-contract) now matches `addIngredientConversion`'s replace-on-save pattern. Item 8a — the High RLS finding — produced a new migration whose body is verbatim the P5 hardening template and hits all four operations. The dual-mechanism UX divergences in `CategoriesSection` and `IngredientFormDrawer` are resolved (S1 from prior review), and N1's "explain why `each` is exempt" comment landed at the right line with the right rationale. Realtime hook and `upsertIngredientConversion` were untouched, both correctly. No new architectural drift introduced.

**No Critical findings. No Should-fix findings. 1 Nit (carried-over: Spec 006 cleanup).**

## Re-walk of prior findings

### Prior Critical: (none)
N/A — no change.

### Prior Should-fix S1 — CategoriesSection delete: `disabled` instead of toast

**RESOLVED.** `disabled={count > 0}` was removed at `CategoriesSection.tsx:229-235`. The DELETE button is now always clickable; `handleDelete` at lines 84-103 fires the existing Toast with `text2` showing the in-use count. A new comment at lines 224-228 documents the design choice ("Keeping the button clickable preserves the 'why can't I delete?' affordance — spec 004 fix-pass item 2").

The release proposal flagged the same divergence in `IngredientFormDrawer` (item 2); also resolved at `IngredientFormDrawer.tsx:217-220` with parallel comment ("SAVE is always enabled; required-field validation runs inside `handleSave` ... — spec 004 fix-pass item 2"). Both surfaces now use the same pattern: button always clickable, validation in handler, Toast on miss.

Browser-verified by main Claude per the dispatch note: "categories DELETE on Protein → toast 'is on 68 items'; SAVE on empty → toast 'Required field missing'". Both match the spec's wording.

### Prior Nit N1 — `each` carve-out from yellow warning is undocumented

**RESOLVED.** Comment landed at `IngredientForm.tsx:368-373`:

> `each` is intentionally exempt: it is a tracking unit (count of physical items) that does not need a `g` / `fl_oz` conversion to function — the cost-calc resolves it via `subUnitSize` × `subUnitUnit` when a recipe asks for a different unit. Per spec 004 §7 + architect N1, suppressing the yellow warning here avoids flagging the most common ingredient unit on the system.

Explains WHY (cost-calc resolution path, prevalence of `each`), not just THAT. The reference back to spec 004 §7 + my N1 keeps the trail navigable. Carve-out at line 374 (`if (!u || isCanonicalUnit(u) || u === 'each') return null;`) is unchanged.

### Prior Nit N2 — Cost-calc dual-check at useStore.ts:1282-1283 is dead code per probe

**STILL-OPEN BY DESIGN.** Filed for Spec 006 cleanup per release proposal "Out of scope". Not touched in fix-pass. Consistent with the prior call.

### Prior Nit N3 — `upsertIngredientConversion` unused by new write UI

**STILL-OPEN BY DESIGN.** Verified at `db.ts:1102-1113`: function present, body unchanged. The new write UI uses `createIngredientConversion` / `updateIngredientConversion` / `deleteIngredientConversion` exclusively. Filed for Spec 006 cleanup per release proposal "Out of scope". Confirmed left as-is intentionally.

### Prior Nit N4 — Realtime publication migration body matches design

**STILL CLEAN.** No changes to `20260507010947_spec004_realtime_publication_add_conversions.sql` in fix-pass. Membership-add still single-table, idempotent. No regression.

## New drift audit (fix-pass)

### Question 1: Slice-type fix cascade — any `(s: any)` / `(c: any)` casts left on `ingredientConversions`?

**CLEAN.** Verified by reading the cited sites:

- `useStore.ts:190` — initializer is `[] as IngredientConversion[]`. ✓
- `types/index.ts:381` — `ingredientConversions: IngredientConversion[]` (non-optional, no `?`). ✓
- `useStore.ts:503-553` — three new actions read `s.ingredientConversions` directly with no defensive `|| []` cast. ✓ (The slice is guaranteed non-undefined now.)
- `InventoryCatalogMode.tsx:579-582` — three action selectors are bare `(s) =>`. ✓
- `InventoryCatalogMode.tsx:594` — `allConversions.filter((c) => ids.has(c.inventoryItemId))` — no `(c: any)` cast and no dead `c.catalogId` branch. ✓
- `InventoryCatalogMode.tsx:600` — `sel.primary.catalogId || sel.primary.id` — no `as any` cast. ✓
- `IngredientForm.tsx:289` — `useStore((s) => s.ingredientConversions)` is bare. ✓
- `IngredientForm.tsx:299-300` — `for (const c of allConversions) { const pu = c.purchaseUnit.toLowerCase()...}` — no `(c: any)` cast and no `c.purchase_unit` snake_case fallback. ✓
- `IngredientForm.tsx:374-377` — `allConversions.some((c) => c.purchaseUnit.toLowerCase()...)` — same shape, clean. ✓

No regressions. The TypeScript typing is now load-bearing across the slice.

### Question 2: Item 6 return-contract — does the saved row from `updateIngredientConversion` match `IngredientConversion`?

**CLEAN.** The mapper at `db.ts:1172-1179` (`updateIngredientConversion` return path) emits exactly six fields:

```
id, inventoryItemId, purchaseUnit, baseUnit, conversionFactor, netYieldPct
```

That is the full surface of `IngredientConversion` (`types/index.ts:157-169`) — no missing fields, no extras. The store action at `useStore.ts:530-535` does `set((s) => ({ ingredientConversions: s.ingredientConversions.map((c) => (c.id === id ? saved : c)) }))`, replacing the row outright — but since `saved` carries every field on the type, no shadow-field merge issue is possible. Pattern parity with `addIngredientConversion` at lines 507-512 is exact (both use the swap-by-id pattern after the server returns).

The `db.updateIngredientConversion` signature `Promise<IngredientConversion>` (not `Promise<void>`) closes the divergence the release proposal flagged. Caller and callee agree.

**Subtle note (not drift):** `updateIngredientConversion` accepts `Partial<Pick<IngredientConversion, 'purchaseUnit' | 'baseUnit' | 'conversionFactor' | 'netYieldPct'>>` — so callers cannot patch `inventoryItemId` (the catalog FK). That's correct: changing the FK on an existing conversion would re-key the row to a different catalog ingredient and is semantically a delete-plus-insert. The narrow `Pick` is a defensive type, not drift.

### Question 3: New RLS migration — operations covered, ordering, helper choice

**CLEAN.** `20260507015244_spec004_ingredient_categories_rls_p6.sql` audited line-by-line:

- **Drop-before-create ordering.** Lines 23-31 drop the legacy `auth_manage_ingredient_categories` (the permissive `recover_undeclared_tables` policy that overwrote P5) AND four pre-P5 split-policy names that may exist in older environments. Lines 33-48 then create the four new policies. Idempotent (the docstring at line 19-21 calls this out explicitly).
- **All four operations covered.**
  - `Authenticated can read ingredient categories` (SELECT) — `using (auth.uid() is not null)` at line 35.
  - `Admins can write ingredient categories` (INSERT) — `with check (public.auth_is_admin())` at line 39.
  - `Admins can update ingredient categories` (UPDATE) — both `using` and `with check` use `auth_is_admin()` at lines 43-44.
  - `Admins can delete ingredient categories` (DELETE) — `using (public.auth_is_admin())` at line 48.
- **Helper choice.** `auth_is_admin()` (not the JWT `app_metadata.role` check from older migrations) is the right call — it's the project's current convention. Cross-checked against `20260504073942_brand_catalog_p5_rls.sql:176-198` (the P5 hardening for `ingredient_conversions`), which uses the exact same shape:

  | Operation | P5 ingredient_conversions (lines)        | New ingredient_categories (lines) | Match? |
  | --------- | ---------------------------------------- | --------------------------------- | ------ |
  | SELECT    | `auth.uid() is not null` (180-182)       | `auth.uid() is not null` (33-35)  | ✓      |
  | INSERT    | `auth_is_admin()` with check (185-187)   | `auth_is_admin()` with check (37-39) | ✓   |
  | UPDATE    | `auth_is_admin()` using+check (189-193)  | `auth_is_admin()` using+check (41-44) | ✓  |
  | DELETE    | `auth_is_admin()` using (195-198)        | `auth_is_admin()` using (46-48)   | ✓      |

  Verbatim shape match. P5 is the current convention for brand-shared admin tables; using it here means the next admin who reads either migration finds the same template.

- **Why not per-store RLS via `auth_can_see_store()`?** `ingredient_categories` is a global string list (no `store_id` column, no `brand_id` column). The right gate is "any authed user can read, only admins can write" — exactly what the new policies encode. Single-tenant 2AM PROJECT today; if/when categories become brand-scoped, that's a column-add migration plus a policy rewrite — out of scope for spec 004.

- **Migration filename.** `20260507015244_spec004_ingredient_categories_rls_p6.sql` follows the project's `YYYYMMDDHHMMSS_<short_name>.sql` convention. The `_p6` suffix is consistent with the existing `_p5_rls.sql` etc.

- **Realtime publication impact.** `ingredient_categories` was already a member of `supabase_realtime` (per release proposal item 8a — the table has been replicated since the brand catalog refactor). Policy changes don't require publication-membership edits. The CLAUDE.md realtime gotcha (`docker restart supabase_realtime_imr-inventory`) does **not** apply to this migration. No deploy/dev step beyond `npx supabase db reset`.

### Question 4: `each` carve-out comment — landed and explains WHY?

**RESOLVED.** Comment is at `IngredientForm.tsx:368-373` (six lines), placed immediately above the `if (!u || isCanonicalUnit(u) || u === 'each') return null;` branch at line 374. Body explains:
- WHAT the carve-out is (`each` is exempt from the yellow warning).
- WHY (it's a tracking unit, not a measurement; cost-calc resolves it via `subUnitSize` × `subUnitUnit`).
- WHAT WOULD GO WRONG without it (false-positive warnings on the most common ingredient unit).

That matches the "explains WHY, not just THAT" criterion. The reference to "spec 004 §7 + architect N1" gives the next reader a trail back to the design docs. Good.

### Question 5: Realtime publication / `useRealtimeSync.ts` impact from typing fix

**NOT AFFECTED.** Re-read `useRealtimeSync.ts` end-to-end. The hook signature (`storeId`, `onSync`, `brandId`) was already typed without `any`; the slice typing change in `AppState.ingredientConversions` doesn't touch this file. Line 49's `ingredient_conversions` subscription (no filter) and the inline comment at lines 46-48 are unchanged. As predicted, no impact.

### Question 6: `upsertIngredientConversion` left as-is for Spec 006

**CONFIRMED.** Function present at `db.ts:1102-1113`, no callers in the new write UI. The release proposal explicitly filed this as Spec 006 cleanup ("Out of scope for this review"). Body is byte-identical to the pre-fix-pass version. Correct call — removing it would have required hunting for callers in legacy paths and isn't load-bearing for spec 004's contract.

## Cross-spec architectural sanity (fix-pass artifacts)

A few sanity checks beyond the dispatcher's six questions:

- **`net_yield_pct` range-check tightening.** Verified at `InventoryCatalogMode.tsx:641-654` (handleAdd) and lines 692-702 (saveEdit): both paths now reject `parsed <= 0 || parsed > 100` with a Toast, and only assign `yieldN` after the range check passes. Empty input still falls back to 100 (column default). Comments at lines 641-644 and 692 reference "security-auditor M1 / spec 004 fix-pass item 3" — good provenance trail. **Not architectural drift; quality fix that closes the auditor Medium.**
- **`NUMERIC_RE` consolidation.** Now lives at `src/utils/validators.ts:22` with a clear docstring (`Tightened from /^\d*\.?\d*$/ per spec 004 fix-pass (security-auditor M2)`). `IngredientForm.tsx:8` imports `isNumericInput`; `InventoryCatalogMode.tsx:21` imports `NUMERIC_RE` directly. Both consumers use the centralized definition. **Single source of truth achieved.** Loose-`.` is now correctly rejected (regex `/^(\d+\.?\d*|\d*\.\d+|)$/` requires a digit on at least one side of the decimal).
- **Snake_case fallbacks removed.** `InventoryCatalogMode.tsx` row display (lines 855-862) reads `conv.purchaseUnit`, `conv.baseUnit`, `conv.conversionFactor`, `conv.netYieldPct` only — no `purchase_unit` etc. fallbacks. `startEdit` at lines 670-677 same. `IngredientForm.tsx:300` uses `c.purchaseUnit` only. The `(conv: any)` cast at the row map is gone. **Fully clean.**
- **Cost-calc invariant probe.** Dispatch confirmed delta=0 was re-run post-fix. Same result as pre-fix (the fix-pass touched type signatures and policies, not the cost-calc path). Invariant gate continues to pass.

## What did NOT drift in the fix-pass

- The two migrations from the original implementation (`20260507010947_spec004_realtime_publication_add_conversions.sql` and the spec 004 backfill) are untouched. Only one new migration was added (the RLS p6).
- Store action signatures (§8 of the design) are byte-identical to the pre-fix-pass — only the action *bodies* changed (adding `.then((saved) => set(...))` to `updateIngredientConversion` per item 6, removing defensive `|| []` casts).
- `IngredientFormDrawer.toUpdates()` still maps `subUnitUnit` correctly — the silent `packUnit` save bug stays closed.
- The `pwa-catalog` edge function was not touched (correctly — the schema didn't change).
- No new tables, no new columns. The fix-pass was pure RLS + types + UX divergence.

## Severity tally (this re-review)

- Critical: 0
- Should-fix: 0
- Nits: 1 (N3 — `upsertIngredientConversion` retained but unused by new write UI; deferred to Spec 006 cleanup per release proposal "Out of scope". Not introduced or worsened by fix-pass; carried over.)

## Severity comparison vs. prior review

| | Prior review | This re-review |
|---|---|---|
| Critical | 0 | 0 |
| Should-fix | 1 (S1 — categories delete UX) | 0 (S1 RESOLVED) |
| Nits | 4 (N1, N2, N3, N4) | 1 (N3 only — others either RESOLVED or carried-as-deferred) |

S1 → RESOLVED. N1 → RESOLVED. N2 → STILL-OPEN by design (Spec 006). N3 → STILL-OPEN by design (Spec 006). N4 → STILL CLEAN.

The fix-pass closed everything actionable for spec 004's scope. Spec 006 will pick up N2 and N3 as a single dead-code-cleanup pass.

## Handoff

next_agent: NONE
prompt: Architectural drift re-review complete after fix-pass. 0 Critical, 0 Should-fix, 1 Nit (carried over from prior review for Spec 006 cleanup). All fix-pass items audited cleanly: slice typing cascade is fully removed (no `(s: any)` / `(c: any)` left on the `ingredientConversions` slice), `updateIngredientConversion`'s saved-row replacement matches `addIngredientConversion`'s pattern with the right field set, the new RLS p6 migration is verbatim P5 shape with all four operations gated by `auth_is_admin()`, the `each` carve-out comment explains WHY, and `useRealtimeSync.ts` is correctly untouched. Spec 004 is architecturally clean.
payload_paths:
  - specs/004-ingredient-form-lookups/reviews/backend-architect.md
