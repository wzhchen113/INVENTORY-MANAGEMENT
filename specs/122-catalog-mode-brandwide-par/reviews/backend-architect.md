# Backend-architect drift review — spec 122

Reviewer: backend-architect (post-implementation mode)
Verdict: **No Critical or Should-fix drift.** Implementation matches the authored
`## Backend design` contract. Two Minor notes below, both intentional/acceptable.

## Confirmations against the contract

### 1. Migration `20260717000000_apply_item_scalars_to_brand.sql` — MATCHES
- Signature is exactly `apply_item_scalars_to_brand(p_catalog_id uuid, p_par_level numeric, p_cost_per_unit numeric, p_case_price numeric) returns jsonb` (lines 78-83). SECURITY DEFINER, `set search_path = public`.
- Single atomic set-based UPDATE (lines 117-124), not a per-row loop — as designed. `GET DIAGNOSTICS v_updated = ROW_COUNT`.
- `coalesce(p_<field>, ii.<field>)` NULL-means-skip on all three columns (lines 118-120). Correct.
- OVERWRITE semantics with the documented divergence-from-119 header prose (lines 23-31) and comment (line 152). The intentional divergence is called out explicitly per the design's instruction; not flagged as an inconsistency.
- Raise-gates in order: `auth_is_privileged()` → `'privileged only'` (94-96); catalog lookup → `'catalog ingredient not found'` (98-103); `auth_can_see_brand(v_brand_id)` → `'brand not accessible'` (106-108). Byte-aligned with 119.
- Per-store `auth_can_see_store(ii.store_id)` in the UPDATE WHERE (line 123) — the per-store gate (AC-8/AC-11). Semantically identical to 119's in-loop check.
- Return shape `{updated_count, skipped_count, skipped_store_ids}` (140-144). Skipped set query (129-138) is byte-aligned with 119 (166-176): visible brand stores with no row for this catalog, not created (AC-9).
- `current_stock`/count-like fields excluded BY CONSTRUCTION — the UPDATE names exactly three columns; those fields are never parameters (AC-5/AC-6).
- `revoke ... from public, anon; grant ... to authenticated;` (148-149). Matches 119.
- **Version no collision confirmed:** migration sequence runs `…0710` → `…0716000000`; `20260717000000` is the unique next slot.

### 2. `db.ts` `applyItemScalarsToBrand` — MATCHES
- `useInflight.getState().track((signal) => …)` + `.abortSignal(signal)`, `kind: 'write'` (db.ts:574-597). Same discipline as the 119 sibling.
- `?? null` maps blank/undefined → SQL NULL-means-skip (583-585) — not 0.
- snake→camel mapped return `{ updatedCount, skippedCount, skippedStoreIds }` (591-595). Correct.

### 3. Frontend — MATCHES
- **Display binding fix (AC-1/AC-2):** `InventoryCatalogMode.tsx:759` — `item={sel && (sel.rows.find((r) => r.storeId === currentStore.id) ?? sel.primary)}`. Exactly the designed expression. `currentStore` is now in scope on the main component (`InventoryCatalogMode.tsx:81`), as the design required.
- **`brandWide` routing:** catalog.tsv edit drawer passes `brandWide` (`InventoryCatalogMode.tsx:762`); the per-store items.tsv drawer in `InventoryDesktopLayout.tsx:562-567` does NOT pass it → single-store (AC-13 regression guard holds).
- **Drawer Save (`IngredientFormDrawer.tsx:264-319`):** edit branch always calls `updateItem(item.id, toUpdates(values))` (current store, incl. current_stock/expiry/count fields), and additionally — only when `brandWide && catalogId` — fires `applyScalarsToAllStores(catalogId, { parLevel, costPerUnit, casePrice })` with a summary toast. `current_stock`/count-like never reach the fan-out payload (AC-5/AC-6 hold structurally).
- **Blank → null:** `scalarOrNull` (`IngredientFormDrawer.tsx:99-104`) returns `null` for blank/non-finite, a real number otherwise — so a cleared field skips rather than zeroing every store. Matches the design's field-parsing note.
- **Store action `applyScalarsToAllStores` (useStore.ts:1456-1497):** optimistic patch of par/cost/case_price ONLY on in-memory rows for the catalog, snapshot-and-revert on RPC failure via `notifyBackendError`, returns summary or `null` (AC-10). Interface entry (useStore.ts:248-251) matches the designed signature.
- **i18n:** `applyScalarsSuccessTitle`/`applyScalarsSuccessDetail` present in en/es/zh-CN.
- No direct `supabase.from/rpc` call bypassing `db.ts` — the fan-out flows store action → `db.applyItemScalarsToBrand` → RPC.

### 4. Realtime / publication / edge — NO CHANGE NEEDED (confirmed)
- `inventory_items` is already in `supabase_realtime` (per `20260514140000_realtime_publication_tighten.sql`). This is a function-only migration; publication membership is untouched. The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply. Header calls this out (lines 46-52). No edge function change.

### 5. Prod apply — NOTED, PENDING
- Migration header (lines 54-60) documents MCP `execute_sql` + `schema_migrations` version insert + normalized-md5 verify, and flags the `db-migrations-applied.yml` red window between repo-commit and prod-apply. This is main Claude's step; no edge redeploy this spec.

## Minor notes (non-blocking)

- **M1 — Optimistic-write divergence from design §6 is intentional and an improvement.** Design §6 prose said "no naive optimistic write across the fan-out targets" (copied from the 119 rationale). The implementation DOES optimistically patch all in-memory catalog rows and revert on failure (useStore.ts:1473-1496). This is correct and better than §6's text: unlike the vendor fan-out, the catalog view holds every store's `inventory_items` row in the `inventory` slice, so the targets ARE local and revertible. The interface doc (useStore.ts:240-247), the design's own "Files changed (frontend)" section, and the review prompt (item 3) all expect this optimistic behavior. Treat §6's prose as superseded, not as drift.

- **M2 — Dual independent write/revert paths on the current store (accepted tradeoff).** On a `brandWide` Save the current store's row is touched by BOTH `updateItem` (its own optimistic patch + `db.updateInventoryItem` write with revert-to-`prev` on failure) AND `applyScalarsToAllStores` (optimistic patch of all catalog rows incl. current + RPC). In the normal both-succeed path this is the harmless idempotent double-write the design acknowledged. In a split-failure edge (one path throws, the other commits) the two revert paths act independently, leaving a transient local inconsistency for the current store until the next realtime replay / reload reconciles to server truth. Low severity — inherent to the dual-path design that was deliberately chosen (updateItem stays the current-store/count-field path; the RPC is the scalar fan-out). No change recommended; noted for awareness.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor (both intentional/accepted). Implementation matches the spec 122 backend design contract; migration/db.ts/frontend all conform, no realtime or edge change, prod-apply pending main Claude.
payload_paths:
  - specs/122-catalog-mode-brandwide-par/reviews/backend-architect.md
