# Spec 123 — Backend architectural drift review

Reviewer: backend-architect (post-implementation mode)
Verdict: **No drift. Implementation matches the design contract.**
Findings: 0 Critical, 0 Should-fix, 4 Minor (all informational / pre-existing pattern).

Reviewed against the `## Backend design` I authored in
`specs/123-reorder-per-vendor-exports-po-created.md`.

---

## 1. Migration `20260718000000_reorder_list_has_po.sql` — CONFIRMED

- **CREATE OR REPLACE, verbatim live body + single additive `has_po` key.** I
  diffed the new migration body against the last real redefinition of
  `report_reorder_list` (`20260711000000_reorder_list_include_stocked.sql`). The
  reorder math is byte-identical across every CTE: depth-cap pre-walk,
  `direct_ri`/`recursive_prep`/`all_ri`, `item_on_hand` (spec-102 item×vendor
  explode + OQ-5 cost fallback), `pending_po_qty`, `pos_daily_per_item`, the
  next-delivery offset lateral, `per_item` math, the spec-104 `estimated_cost ×
  sub_unit_size` bridge, the `include_stocked` filter, the KPI block, the
  warnings block, and the final envelope. The ONLY logic change is the additive
  `'has_po'` key in `vendor_rows` (lines 582-589). No accidental reorder-math
  drift.
- **Base-body provenance is correct.** The migration header says the body was
  dumped via `pg_get_functiondef` reflecting "20260717000000-era state." I
  verified `20260717000000_apply_item_scalars_to_brand.sql` does NOT redefine
  `report_reorder_list` (it defines `apply_item_scalars_to_brand`), and no
  migration between `20260711000000` and `20260718000000` touches the function.
  So the live body the dump captured *equals* the `20260711000000` base the
  design specified — the two approaches converge. No stale-base regression
  (include_stocked / spec-104 cost basis / i18n names all preserved).
- **EXISTS predicate matches the design exactly** (lines 582-589):
  keyed on `po.store_id = p_store_id AND po.vendor_id = vwi.vendor_id AND
  po.reference_date = v_as_of_date AND po.status <> 'cancelled'`. Correlated to
  `vendors_with_items vwi`, so the flag is per surfaced vendor card, computed
  against the same `v_as_of_date` the card renders for. `draft/sent/partial/
  received` all count; only `cancelled` excluded — matches Q2. Legacy
  `reference_date = null` never matches (`null = date` → NULL, not true) —
  matches Q4.
- **No signature / param / grant / security change.** Same `(uuid, jsonb)`
  signature, same `p_params->>'as_of_date'` date source, `SET search_path =
  public` preserved. The dumped header omits an explicit `SECURITY INVOKER`
  clause — this is expected: `pg_get_functiondef` only prints `SECURITY DEFINER`
  (invoker is the default), and `CREATE OR REPLACE` without a SECURITY clause
  keeps invoker. Security context is preserved, not changed. Auth gate is still
  the first statement (line 29, `auth_can_see_store(p_store_id)`).
- **Version ordering.** `20260718000000` sorts after `20260717000000`
  (latest on disk). No collision.

## 2. Date-string identity round-trip — CONFIRMED

The chain is intact and load-bearing exactly as designed:
- RPC emits `envelope.as_of_date = to_char(v_as_of_date, 'YYYY-MM-DD')`
  (migration line 654).
- `fetchReorderSuggestions` maps `asOfDate: envelope.as_of_date` into
  `reorderPayload` (`src/lib/db.ts:3946`).
- `createPoDraft` threads `get().reorderPayload?.asOfDate` as `referenceDate`
  (`src/store/useStore.ts:2698-2703`).
- `createPurchaseOrderDraft` writes it to `reference_date` when present
  (`src/lib/db.ts:1559`).
- The RPC EXISTS then compares `po.reference_date = v_as_of_date`.

Both dates derive from the same `v_as_of_date` string, so a just-created draft
flips `has_po` true on the `loadReorderSuggestions()` re-fetch that
`createPoDraft` already fires (`useStore.ts:2714`). Reading
`reorderPayload.asOfDate` (the server's echoed date) rather than a
component-supplied value is the right call — it guarantees identity with what
the next fetch queries.

## 3. TS surface — CONFIRMED

- `mapReorderVendor` surfaces `hasPo: Boolean(v?.has_po ?? false)`
  (`src/lib/db.ts:4024`) — correct snake→camel, absent defaults false.
- `ReorderVendor.hasPo: boolean` added as a **required** field
  (`src/types/index.ts:912`). Required (not optional) is reasonable: both
  mappers (admin `db.ts` and staff `fetchReorder.ts`) always emit it, so no
  type-hole. Any future producer of a `ReorderVendor` is now forced to set it.
- Staff `fetchReorder.ts:110` maps `hasPo` identically; correctly documented as
  inert (staff Reorder renders no create-PO button). Satisfies the shared type.

## 4. Frontend — CONFIRMED

- Global top-of-screen CSV/PDF buttons removed from the `TabStrip` rightSlot;
  only the date picker + REFRESH remain (`ReorderSection.tsx:1176-1199`).
- Per-vendor exports (`ReorderVendorExportButtons`, :410) narrow via the new
  exported `narrowReorderToVendor(payload, vendor)` (:89) —
  `{...payload, vendors:[vendor], kpis: computeReorderKpis([vendor])}` — and feed
  the SAME `handleCsvExport`/`buildReorderCsv` + `handlePdfExport` builders
  (no signature change). Matches the design's payload-narrowing contract.
- Import-format path preserved and scoped per-vendor: `pickImportVendor(narrowed,
  vendorsList)` → `handleImportExport(narrowed, …)` on the single-vendor payload
  (:421-425); falls through to generic CSV otherwise.
- Web-only gating preserved: footer buttons render only under `showExport`
  (:675, `showExport` still `Platform.OS === 'web' && …` at :1143).
- Disabled "PO CREATED": `CreatePoButton` early-returns a non-pressable `View`
  (no `onPress`) when `vendorHasPo(vendor)` (:222-246), keeping the
  `reorder-create-po-${vendorId}` testID; unchanged confirm→create→toast path
  when false. Per-vendor `hasPo` on the payload keeps two vendors independent.
- i18n `poCreatedLabel` / `poCreatedAria` present with parity in en/es/zh-CN
  (`src/i18n/*.json:1014-1015`).
- pgTAP `supabase/tests/reorder_list_has_po.test.sql` implements all five design
  fixtures (A true / B cancelled false / C different-date false / D no-PO false /
  E null-reference_date false) plus the A-vs-D independence assertion. Matches
  the design's test surface.

## 5. RLS / edge / realtime / publication — CONFIRMED none

No new table, no policy change, no edge function touched, no
`supabase_realtime` publication membership change. `report_reorder_list` stays
`security invoker` gating on `auth_can_see_store` first; the inner EXISTS reads
`purchase_orders`, already per-store RLS-scoped, and the outer `p_store_id` gate
bounds it. No `docker restart supabase_realtime_imr-inventory` needed. Reorder
list stays fetch-on-demand; `createPoDraft` re-fetches in-session.

## 6. Prod deploy state — CONFIRMED pending (main Claude)

Migration is committed but not yet applied to prod. Deploy steps (per project
policy — `db push` lacks the prod password): apply the SQL via Supabase MCP
`execute_sql`, insert `20260718000000` into `supabase_migrations.schema_migrations`,
and verify the function via normalized-md5. No edge redeploy. **Until the
version row is inserted in prod, the `db-migrations-applied.yml` gate will hard-
fail** (repo migration missing from prod) — expected, clears on insert.

---

## Minor notes (informational — not drift, no action required for ship)

1. **Per-vendor CSV/PDF button `accessibilityLabel`s are hardcoded English**
   ("Export CSV" / "Export PDF", `ReorderSection.tsx:448,457`) while the button
   text ("CSV"/"PDF") is locale-neutral. This matches the existing pattern — the
   sibling REFRESH button aria ("Refresh reorder list", :1192) is also hardcoded
   English — so it is not new drift. Only `poCreated*` needed i18n per the design,
   and that landed. Optional future polish.
2. **Migration header comment** ("reflects 20260717000000-era state") is
   accurate for the dump environment but could read as if 20260717 defined the
   function. It did not; the body's last definer is 20260711. Cosmetic.
3. **UTC-midnight straddle** (design-flagged): when admin uses no date override,
   both the create and the re-fetch resolve `v_as_of_date` from server
   `current_date` (UTC). A create + refetch straddling UTC midnight could
   momentarily disagree. Negligible, already surfaced in the design's risks.
4. **Disabled state is UX-only** (design-flagged): a determined direct INSERT
   still bypasses the "PO CREATED" guard; RLS still store-scopes writes. Out of
   scope per Q3.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 4 Minor
  (all informational). Implementation matches the spec 123 backend design —
  migration is verbatim-base + single additive has_po key, date-string identity
  round-trips, TS surfaces and pgTAP match, no RLS/edge/realtime/publication
  change. Prod apply via MCP + schema_migrations insert is pending main Claude
  (the db-migrations-applied gate stays red until that insert).
payload_paths:
  - specs/123-reorder-per-vendor-exports-po-created/reviews/backend-architect.md
