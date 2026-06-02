# Spec 086: Cases + Units dual-entry on the staff EOD count screen (parity with admin)

Status: READY_FOR_REVIEW

> **What changed since DRAFT:** the two blocking open questions are resolved by
> the user. OQ-1 resolved to **MATCH THE ADMIN — CONVERT** (not "store
> separately"), which is the OPPOSITE of the original request's framing and
> **fully dissolves the reports tension**: because the converted total still
> lands in `actual_remaining`, `report_run_variance` (+ multivendor) and
> `report_reorder_list` need NO changes. OQ-6 resolved to **STAFF SCREEN ONLY**:
> the admin EOD worksheet already has the two boxes, so there is no new admin UI.
> The feature is now scoped as: **bring the staff EOD count screen to parity with
> the admin worksheet** (`EODCountSection.tsx`) — same dual inputs, same
> conversion formula, same three persisted values.

## User story

As a **store staff member doing the end-of-day count**, I want **two number
inputs per item — one for full cases and one for loose units, converted to a
single total using the item's units-per-case — exactly the way the admin EOD
worksheet already works** — so that I can record "2 cases, 5 units" without
doing pack-math in my head, and the count I submit reads back identically to a
manager's count.

## Ground truth found in code (the reference pattern to mirror)

Verified against the codebase on 2026-06-01. The admin EOD worksheet is the
canonical pattern this spec ports to the staff surface.

1. **`eod_entries` already has the two columns.** `actual_remaining_cases` and
   `actual_remaining_each` (both `numeric`, nullable) were added in
   [`supabase/migrations/20260502071736_remote_schema.sql:55,57`](../../supabase/migrations/20260502071736_remote_schema.sql).
   **No new `eod_entries` column is needed.**

2. **The admin EOD worksheet is the reference.**
   [`src/screens/cmd/sections/EODCountSection.tsx`](../../src/screens/cmd/sections/EODCountSection.tsx)
   keeps per-vendor `caseCountsByVendor` + `unitCountsByVendor` state, renders a
   Cases input and a Units input per row, and computes the total via
   **`cases × (i.caseQty || 1) + units`** in two places:
   - `itemTotal` — [`EODCountSection.tsx:390-396`](../../src/screens/cmd/sections/EODCountSection.tsx)
   - `buildSubmission` — [`EODCountSection.tsx:429`](../../src/screens/cmd/sections/EODCountSection.tsx)
   It persists all three values: `actualRemaining` (the converted total),
   `actualRemainingCases` (raw cases), `actualRemainingEach` (raw units)
   ([`EODCountSection.tsx:433-435`](../../src/screens/cmd/sections/EODCountSection.tsx)).
   The "entered" predicate is "either Cases OR Units non-empty"
   (`hasEntry`, [`EODCountSection.tsx:397-398`](../../src/screens/cmd/sections/EODCountSection.tsx)).
   The pre-fill read uses the legacy-row fallback
   `actualRemainingEach ?? actualRemaining` for units
   ([`EODCountSection.tsx:340-344`](../../src/screens/cmd/sections/EODCountSection.tsx)).
   The file's top comment ("Single qty input per item (no dual cases/each)") is
   **stale** — correct it in passing.

3. **`db.ts` already round-trips all three values** for the admin path:
   `submitEODCount` writes `actual_remaining` / `actual_remaining_cases` /
   `actual_remaining_each` ([`src/lib/db.ts:561-562`](../../src/lib/db.ts)) and
   the EOD read mappers hydrate them back; `EODEntry`
   ([`src/types/index.ts:283-284`](../../src/types/index.ts)) carries the
   optional fields. **Not touched by this spec.**

4. **The STAFF path is the gap — single-number end-to-end:**
   - **`EodItem` has no `caseQty`.** [`src/screens/staff/lib/types.ts:17-22`](../../src/screens/staff/lib/types.ts)
     is `{ id, vendorId, name, unit }`, and `fetchItemsForVendor`
     ([`src/screens/staff/screens/EODCount.tsx:114-141`](../../src/screens/staff/screens/EODCount.tsx))
     selects `inventory_items.select('id, vendor_id, catalog:catalog_ingredients(name, unit)')`
     — it does NOT select any units-per-case column. The staff app has no
     pack-size to convert with today; that query must add the source column.
   - **`EodEntry` is single-number.** [`types.ts:33-36`](../../src/screens/staff/lib/types.ts):
     `{ item_id: string; count: number }`.
   - **`EODCount.tsx` renders one input per item** to a `counts: Record<string,string>`
     map ([`EODCount.tsx:552-567`](../../src/screens/staff/screens/EODCount.tsx),
     testID `eod-item-input-${id}`).
   - **Pre-fill reads only the total.** `fetchExistingSubmission`
     ([`EODCount.tsx:149-178`](../../src/screens/staff/screens/EODCount.tsx))
     selects `eod_entries(item_id, actual_remaining)` and maps to `count`.
   - **`entriesForRpc` maps `count → actual_remaining` only**
     ([`src/screens/staff/hooks/useEodSubmit.ts:67-75`](../../src/screens/staff/hooks/useEodSubmit.ts)).
   - **`QueuedSubmission.entries: EodEntry[]`** is single-number, with the spec
     062 §3 note to bump the storage key version if the shape changes
     ([`types.ts:38-40`](../../src/screens/staff/lib/types.ts)). Canonical key
     is `imr-staff:eod-queue:v1` ([`src/screens/staff/lib/eodQueue.ts:20`](../../src/screens/staff/lib/eodQueue.ts)),
     and the migration playbook is already documented at
     [`eodQueue.ts:227-229`](../../src/screens/staff/lib/eodQueue.ts).

5. **The `staff_submit_eod` RPC drops cases/each.** Latest migration
   [`20260525000000_staff_submit_eod_per_user_jwt.sql:156-162`](../../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql)
   destructures `jsonb_to_recordset(p_entries)` as
   `(ingredient_id uuid, actual_remaining numeric, unit text, notes text)` and
   INSERTs only `actual_remaining`
   ([`…:164-165`](../../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql)).
   Needs an additive migration to read + write the two split fields.

6. **The reports read ONLY `actual_remaining`** — and that is exactly why the
   convert decision (OQ-1) resolves the reporting tension with **zero report
   changes**:
   - [`report_run_variance`](../../supabase/migrations/20260512120000_report_run_variance.sql)
     + multivendor variant ([`20260514120020_…`](../../supabase/migrations/20260514120020_report_run_variance_multivendor.sql))
     sum `e.actual_remaining`.
   - [`report_reorder_list`](../../supabase/migrations/20260514130000_report_reorder_list.sql)
     uses `e.actual_remaining` as `on_hand`.
   Because staff will now write the converted total into `actual_remaining`
   (same as admin), the reports keep reading a true on-hand number for staff
   counts. **No report touched.**

**Net:** port the admin worksheet's dual-input + convert-to-total behavior to
the staff EOD screen, type, queue, submit hook, and RPC. Schema and reports are
untouched.

## Acceptance criteria

### Staff catalog / type (`EodItem`)
- [ ] Staff `EodItem` ([`src/screens/staff/lib/types.ts:17-22`](../../src/screens/staff/lib/types.ts))
      gains a `caseQty: number | null` field (units-per-case).
- [ ] `fetchItemsForVendor` ([`EODCount.tsx:114-141`](../../src/screens/staff/screens/EODCount.tsx))
      selects the units-per-case column from the same catalog source the admin
      already reads via `i.caseQty` (the architect confirms the exact
      column/table — likely `catalog_ingredients` or `inventory_items`; admin
      item-management already renders `case ${it.caseQty}` at
      [`EODCountSection.tsx:1172`](../../src/screens/cmd/sections/EODCountSection.tsx),
      so the source column exists) and maps it onto `EodItem.caseQty`.
- [ ] An item whose units-per-case is absent/null defaults to **1** at the
      conversion site (the `i.caseQty || 1` rule, byte-for-byte with the admin).

### Staff EOD screen (`src/screens/staff/screens/EODCount.tsx`)
- [ ] Each item row renders **two** numeric inputs — a Cases input and a Units
      input — replacing today's single input (`EODCount.tsx:552-567`). Both
      `keyboardType="decimal-pad"` with `inputMode="decimal"` on web (mirroring
      today's `EODCount.tsx:558-561`), each with a distinct `testID`
      (`eod-item-cases-${id}` and `eod-item-units-${id}`) and a distinct
      `accessibilityLabel`. The existing single-input testID
      `eod-item-input-${id}` is removed/replaced; any test/selector referencing
      it is updated.
- [ ] Per-item state holds both values — two `Record<string,string>` maps
      (e.g. `caseCounts` / `unitCounts`) mirroring the admin section's split,
      OR one map keyed by a `{ cases, units }` shape.
- [ ] The displayed/submitted **total per item = `cases × (caseQty || 1) + units`**
      — byte-for-byte the admin formula at `EODCountSection.tsx:395,429`. Empty
      Cases or empty Units parses to 0 before the multiply/add (same `isNaN → 0`
      coercion as the admin).
- [ ] A row counts as "entered" (included in the submit payload) when EITHER
      the Cases OR the Units input is non-empty — the admin `hasEntry` rule
      (`EODCountSection.tsx:397-398`). Fully-blank rows are skipped (matches
      today's onSubmit filter).
- [ ] The pre-fill path seeds BOTH inputs: `fetchExistingSubmission`
      (`EODCount.tsx:149-178`) selects `actual_remaining_cases` and
      `actual_remaining_each` (in addition to `actual_remaining`), and the
      screen seeds Cases from `actual_remaining_cases` and Units from
      **`actual_remaining_each ?? actual_remaining`** (the admin legacy-row
      fallback at `EODCountSection.tsx:340-344`). For a legacy row (split fields
      NULL), Cases shows blank/0 and Units shows the existing total.
- [ ] The Submit / Queued / Already-submitted toasts and the forbidden-banner
      behavior are unchanged from today.

### Staff queue + submit hook
- [ ] Staff `EodEntry` ([`types.ts:33-36`](../../src/screens/staff/lib/types.ts))
      is extended to carry the two raw inputs AND the computed total, mirroring
      what `db.ts submitEODCount` + `EODEntry` already round-trip. Suggested
      shape (architect finalizes the exact field names):
      `{ item_id: string; actual_remaining: number; actual_remaining_cases: number | null; actual_remaining_each: number | null }`.
      The total (`actual_remaining`) is computed client-side at entry time via
      the conversion formula, so the queued payload is self-contained and does
      NOT need `caseQty` at drain time.
- [ ] `entriesForRpc` ([`useEodSubmit.ts:67-75`](../../src/screens/staff/hooks/useEodSubmit.ts))
      maps the new fields into the RPC arg object:
      `{ ingredient_id, actual_remaining, actual_remaining_cases, actual_remaining_each }`.
- [ ] **The AsyncStorage queue key version is bumped** `imr-staff:eod-queue:v1`
      → `imr-staff:eod-queue:v2` ([`eodQueue.ts:20`](../../src/screens/staff/lib/eodQueue.ts)),
      because `QueuedSubmission.entries` shape changes — per the spec 062 §3
      note and the playbook already at `eodQueue.ts:227-229`.
- [ ] **In-flight `:v1` queue handling = read-once migrate, then discard the old
      key (OQ-5 resolved).** On first boot after upgrade, if a `:v1` payload
      exists, each `:v1` entry's single `count` is migrated to a `:v2` entry as
      `actual_remaining = count`, `actual_remaining_cases = null`,
      `actual_remaining_each = count` (so it round-trips as a units-only legacy
      count and still drains successfully), written under `:v2`, and the `:v1`
      key is removed. No data loss; the in-flight count drains under the new
      shape. (The architect may instead choose drop-and-clear if migrate is
      disproportionate; the AC default is migrate-then-discard.)
- [ ] The poison-queue / offline E2E guards that key on the queue-key string
      are updated to `:v2`: `STAFF_QUEUE_KEY` in
      [`e2e/fixtures/constants.ts:72`](../../e2e/fixtures/constants.ts), the
      `addInitScript` removal in [`e2e/eod.spec.ts`](../../e2e/eod.spec.ts), the
      unit reference in [`src/screens/staff/store/useStaffStore.test.ts:72`](../../src/screens/staff/store/useStaffStore.test.ts),
      and the docs in [`tests/README.md`](../../tests/README.md).
- [ ] An offline submit, then reconnect → drain, persists the cases/units the
      staff member entered (the converted total reaches `actual_remaining` and
      the raw splits reach `_cases`/`_each`).

### Backend RPC (`staff_submit_eod`) — additive migration
- [ ] `staff_submit_eod`'s `jsonb_to_recordset` accepts two new fields —
      `actual_remaining_cases numeric` and `actual_remaining_each numeric` —
      additive to the existing recordset destructure at
      [`20260525000000_…:156-162`](../../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql).
- [ ] The RPC INSERTs the two new fields into `eod_entries` alongside
      `actual_remaining` (extends the INSERT at
      [`…:164-165`](../../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql)
      from `(submission_id, item_id, actual_remaining, notes)` to also write
      `actual_remaining_cases, actual_remaining_each`).
- [ ] The value written to `actual_remaining` is the **client-computed converted
      total** the staff screen sends (`cases × (caseQty || 1) + units`). The RPC
      does NOT recompute the total — it stores what it receives, the same single
      number the reports read. (No `caseQty` is sent to or known by the RPC.)
- [ ] The function **signature is unchanged** —
      `(uuid, uuid, date, text, text, jsonb, uuid)` — because the new fields
      ride inside the `p_entries` jsonb. **No GRANT change.**
- [ ] **Backward-compatible:** a `p_entries` element WITHOUT the two new keys
      still inserts successfully (the missing keys read as NULL via
      `jsonb_to_recordset`), so the existing admin direct-PostgREST path
      (`db.ts submitEODCount`) and any older caller are unaffected.
- [ ] The `inventory_items.current_stock` / `eod_remaining` write
      ([`…:174-179`](../../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql))
      continues to use `actual_remaining` (the total) — unchanged.
- [ ] The audit-log `value` string
      ([`…:194`](../../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql))
      continues to render `actual_remaining` (the total) + unit — unchanged for
      v1 (the human-readable cases+units breakdown is explicitly out of scope;
      see OQ-3).
- [ ] The RPC change must not weaken the `auth_can_see_store(p_store_id)` gate
      (`…:95-98`) or the `eod_entries` cross-store-consistency trigger
      (`20260514120030_eod_submissions_consistency.sql`).

### Admin EOD section — no behavior change
- [ ] `EODCountSection.tsx` is **NOT modified** beyond an optional one-line
      correction of the stale top comment ("Single qty input per item …",
      ~line 61). Its conversion formula, state, and persistence are the
      reference and stay as-is. `InventoryCountSection.tsx` is not touched.

### Backward compatibility / no data loss
- [ ] Existing `eod_entries` rows with `actual_remaining` set and `_cases` /
      `_each` NULL render and re-edit on the staff screen without error: Cases
      blank, Units = the existing total (the `?? actual_remaining` fallback).
      No historical-row data migration.

## In scope
- Staff `EodItem` type + `fetchItemsForVendor` query: add `caseQty` (units-per-case).
- Staff EOD screen: two inputs per item (Cases + Units), convert-to-total via
  `cases × (caseQty || 1) + units`, both-input pre-fill with legacy fallback.
- Staff `EodEntry` + `QueuedSubmission` shape extension; AsyncStorage queue
  key-version bump `:v1 → :v2` with read-once migrate of any in-flight payload.
- Staff submit hook (`useEodSubmit` `entriesForRpc`) → RPC mapping of the three
  values.
- `staff_submit_eod` RPC: additive migration to read + INSERT
  `actual_remaining_cases` / `actual_remaining_each` from `p_entries`
  (no signature change, no GRANT change, backward-compatible).
- Correcting the stale comment at the top of `EODCountSection.tsx` (optional).
- Updating the queue-key references in the test fixtures/docs for the bump.
- Tests across the affected tracks (see Project-specific notes).

## Out of scope (explicitly)
- **Any admin UI change.** The admin EOD worksheet (`EODCountSection.tsx`)
  already has the two boxes (OQ-6); no new admin two-box UI is requested. The
  admin inventory-count path (`InventoryCountSection.tsx` / `inventory_counts` /
  `submit_inventory_count`) already supports the split and is untouched.
- **Any report change.** `report_run_variance` (+ multivendor) and
  `report_reorder_list` read `actual_remaining`, which now carries the converted
  total for staff counts too — so the convert decision means **zero report
  work**. A pack-size-aware variance that reads `_cases`/`_each` directly is a
  future spec, not this one.
- **`db.ts` / `src/types/index.ts EODEntry` changes.** The admin path already
  round-trips all three values; this spec does not modify them.
- **A units-per-case management / data-entry UI.** Not requested. Staff reads
  the existing catalog value read-only.
- **Staff realtime.** Staff stack has no realtime in v1 (spec 062); unchanged.
- **The customer PWA.** Sibling app; out of repo scope.
- **`app.json` slug.** Not touched.

## Open questions resolved
- **OQ-1 (headline — conversion vs. store-separately + the reports tension) →
  MATCH THE ADMIN: CONVERT.** Staff converts via `cases × (caseQty || 1) + units`
  and stores all three values, with the total in `actual_remaining`. Because the
  total lands in `actual_remaining`, the reports (`report_run_variance` +
  multivendor, `report_reorder_list`) need **no changes**. The earlier
  "store separately, no conversion" framing is **superseded and dropped**.
- **OQ-2 (entry shape + RPC field names) → `actual_remaining` (total) +
  `actual_remaining_cases` + `actual_remaining_each`**, matching the existing
  `eod_entries` columns and the admin path. The total is computed client-side;
  the RPC stores what it receives. Exact TS field names finalized by architect.
- **OQ-3 (box labels + the `unit` sub-label) → match the admin worksheet's
  labeling.** Left box "Cases", right box "Units" (the FE/architect may show the
  item's `unit` as the Units sub-label for parity — the staff row already
  renders `item.unit` as a secondary line at `EODCount.tsx:545-549`). New staff
  i18n keys under `eod.*` ([`src/screens/staff/i18n/en.json`](../../src/screens/staff/i18n/en.json));
  exact copy finalized by FE. The audit-log human-readable cases+units breakdown
  is NOT in v1 (RPC keeps writing the total).
- **OQ-4 (legacy-row interpretation) → Cases = blank/0, Units = `actual_remaining`**
  on display/pre-fill (the admin `actualRemainingEach ?? actualRemaining`
  fallback at `EODCountSection.tsx:340-344`). No historical-row data migration.
- **OQ-5 (in-flight queue migration on `:v1 → :v2` bump) → read-once migrate,
  then discard the old key.** Each `:v1` entry's `count` becomes a `:v2` entry
  with `actual_remaining = count`, `actual_remaining_cases = null`,
  `actual_remaining_each = count`; old key removed. (Architect may downgrade to
  drop-and-clear if migrate is disproportionate.)
- **OQ-6 (which admin surface) → STAFF SCREEN ONLY.** The admin EOD worksheet
  already has the two boxes; no new admin UI. Work is staff-screen parity only.

## Dependencies
- `eod_entries.actual_remaining_cases` / `actual_remaining_each` columns
  (already live — `20260502071736_remote_schema.sql`).
- `staff_submit_eod` RPC (latest:
  `20260525000000_staff_submit_eod_per_user_jwt.sql`) — needs the additive
  migration to read + INSERT the two `p_entries` fields.
- The catalog units-per-case source column behind the admin's `i.caseQty`
  (architect confirms exact `catalog_ingredients` / `inventory_items` column)
  — read-only dependency for the staff `fetchItemsForVendor` query.
- Staff offline-queue infra (`useStaffStore` enqueue/drain, `eodQueue.ts`
  `QUEUE_KEY` + the spec 062 §3 key-version-bump contract).
- The two report RPCs (`report_run_variance` + multivendor,
  `report_reorder_list`) — **read-only, NOT modified** (convert decision means
  no change).
- Admin `EODCountSection.tsx` — read-only reference pattern; not modified.

## Project-specific notes
- **Cmd UI section / legacy:** Admin reference is the Cmd section
  `src/screens/cmd/sections/EODCountSection.tsx` (no legacy admin; read-only
  reference). The work lands in the staff surface
  `src/screens/staff/screens/EODCount.tsx` + `src/screens/staff/lib/*` +
  `src/screens/staff/hooks/*` — a documented carve-out (verbatim port; direct
  `supabase.*` calls allowed; follow its existing patterns, do NOT route through
  `db.ts`).
- **Which app:** This repo (admin Cmd UI + staff EOD app — both live here since
  spec 063). Customer PWA out of scope.
- **Per-store or admin-global:** Per-store. `staff_submit_eod` gates on
  `auth_can_see_store(p_store_id)` (`20260525000000_…:95-98`); `eod_submissions`
  / `eod_entries` RLS is per-store + the `eod_entries` cross-store-consistency
  trigger (`20260514120030_eod_submissions_consistency.sql`). The additive RPC
  change must not weaken either.
- **Edge function or PostgREST:** PostgREST RPC (`staff_submit_eod`), called by
  the staff app under its per-user JWT (spec 061). No edge function.
- **Realtime channels touched:** None. Staff has no realtime (spec 062); the RPC
  migration changes no publication membership, so the realtime docker-restart
  ritual does not apply.
- **Migrations needed:** YES — one additive migration to `staff_submit_eod`
  (read + INSERT the two `p_entries` fields). No new column (already exist), no
  signature change, no GRANT change. **The `db-migrations-applied` gate
  applies** — user runs `npx supabase db push --linked` post-merge.
- **Edge functions touched:** None.
- **Web/native scope:** Both. The staff EOD screen ships to web (Vercel) and
  native (EAS); the dual-input layout must hold on a phone viewport (the spec-072
  scroll/footer regression class — see the Track-4 scroll guard in
  `tests/README.md`). No web-only APIs involved.
- **Tests (name the track):**
  - **Track 1 (jest):** staff `EODCount` two-input render + the conversion
    (`cases × (caseQty || 1) + units`, including `caseQty` absent → ×1) + the
    "entered when either filled" predicate + both-input pre-fill with the
    legacy `?? actual_remaining` fallback; `useEodSubmit` `entriesForRpc` sends
    the three values; queue enqueue/dequeue under the new `EodEntry` shape and
    the `:v1 → :v2` read-once migrate.
  - **Track 2 (pgTAP):** `staff_submit_eod` writes `actual_remaining_cases` /
    `actual_remaining_each` into `eod_entries` AND stores the client-sent total
    in `actual_remaining`; a legacy entry (no split keys) still inserts (cases/
    each NULL); confirm the per-store gate + consistency trigger still hold.
    Reuse the seeded-user + hermetic begin/rollback pattern; if any grant is
    touched (expected: none), assert via `has_function_privilege`.
  - **Track 4 (Playwright):** extend `e2e/eod.spec.ts` — submit with Cases +
    Units online, reload, assert pre-fill of BOTH inputs; offline → queue →
    drain preserves the converted total + splits. Update the queue-key-version
    bump everywhere the poison-queue guard keys on the string (`:v1 → :v2`).

## Backend design (architect)

Authored 2026-06-01. Trace verified against the codebase HEAD. Everything in
this section is "design"; the developers author the `.ts` / `.sql`. Two pins
the PM flagged are resolved first because the rest depends on them.

### PIN 1 — the catalog column behind the admin's `i.caseQty` (load-bearing)

**The source column is `public.catalog_ingredients.case_qty` (numeric).** The
staff catalog query must add it to its existing `catalog_ingredients` join.

Full trace (admin path):
- The admin worksheet reads `i.caseQty` off an inventory item
  (`EODCountSection.tsx:395,429`). `i` is an element of `useStore(s => s.inventory)`.
- The `inventory` slice is hydrated by `loadFromSupabase` in `src/lib/db.ts`. The
  inventory select joins the catalog row:
  `catalog:catalog_ingredients(id, name, unit, category, case_qty, sub_unit_size, sub_unit_unit, i18n_names)`
  — **`src/lib/db.ts:166`**.
- The item mapper sets **`caseQty: parseFloat(c.case_qty) || 1`** —
  **`src/lib/db.ts:3385`** (the catalog hydration mapper; `current_stock` is
  hydrated nearby). The `|| 1` is where a null/absent pack-size becomes 1.
- Cross-check: `fetchCatalogIngredients` (`db.ts:3370-3399`) and
  `updateInventoryItem` (`db.ts:271-278`, writes `case_qty`) both confirm
  `case_qty` lives on `catalog_ingredients`, not on `inventory_items`.

The staff `fetchItemsForVendor` query today selects
`inventory_items.select('id, vendor_id, catalog:catalog_ingredients(name, unit)')`
(`EODCount.tsx:122`). It must become:

```
.select('id, vendor_id, catalog:catalog_ingredients(name, unit, case_qty)')
```

Mapping (snake_case → camelCase), in the `rows.map(...)` block at
`EODCount.tsx:133-141`, mirroring the admin's coercion shape:

```
caseQty: c?.case_qty == null ? null : Number(c.case_qty),
```

> **Deliberate divergence from the admin mapper, justified.** The admin mapper
> collapses null → 1 at hydration (`parseFloat(c.case_qty) || 1`). The staff
> `EodItem.caseQty` is typed `number | null` (per AC) and we keep the `null`
> through to the conversion call-site, applying `|| 1` THERE
> (`cases * (caseQty || 1) + units`). Net arithmetic is byte-identical to the
> admin — `null` and `1` both yield `× 1` — but preserving `null` on the type
> lets a future pack-size-aware feature distinguish "genuinely 1-per-case" from
> "unknown" without a migration. If the developer prefers exact admin parity
> (`caseQty: parseFloat(c.case_qty) || 1`, type `number`), that is also
> acceptable and changes no test outcome; the AC mandates `number | null`, so
> the null-preserving form is the default.

RLS note: the staff query already reads `inventory_items` + `catalog_ingredients`
under the staff per-user JWT and works today; adding one more already-granted
column to an existing join introduces **no new RLS surface**. `catalog_ingredients`
is brand-scoped and readable to authenticated callers who can see the brand
(spec 005 P5 policies); the staff JWT already passes that gate for the `name`/`unit`
columns it reads now.

### PIN 2 — final `EodEntry` shape + the `:v1 → :v2` queue-migrate

**Final `EodEntry` (staff, `src/screens/staff/lib/types.ts`):**

```
export type EodEntry = {
  item_id: string;
  actual_remaining: number;              // client-computed total (the number reports read)
  actual_remaining_cases: number | null; // raw Cases input, null when blank
  actual_remaining_each: number | null;  // raw Units input, null when blank
};
```

Rationale for these exact names: they are the snake_case RPC/column names, so
`entriesForRpc` becomes a near-identity map (no rename churn) and the persisted
queue payload reads 1:1 against `eod_entries` columns. This mirrors how the admin
`EODEntry` (`src/types/index.ts:283-284`) already carries
`actualRemaining` / `actualRemainingCases` / `actualRemainingEach`. The single
`count` field is **removed** — every reader is in-repo and updated in this spec
(`EODCount.tsx` build + pre-fill, `useEodSubmit.entriesForRpc`,
`fetchExistingSubmission`, the `useStaffStore` queue tests). `count` does NOT
survive as an alias; a half-migrated payload would be ambiguous.

The total is computed **client-side at entry-build time** (in
`EODCount.tsx onSubmit`) so the queued payload is self-contained — `caseQty` is
NOT persisted and NOT needed at drain time. This is the whole reason the convert
decision keeps the RPC and reports untouched.

**`:v1 → :v2` decision → READ-ONCE MIGRATE, then discard (finalize OQ-5, NOT
downgraded to drop-and-clear).**

Justification for migrate over drop-and-clear: the infrastructure already exists
and the transform is trivial and lossless. `App.tsx:201-203` already calls
`migrateQueueIfNeeded()` immediately BEFORE `hydrateQueue()` on the staff mount
path — the exact hook the `eodQueue.ts:224-240` migration contract was written
for, currently a documented no-op (`eodQueue.ts:103-106`). A `:v1` in-flight
count is a staff member's unsynced end-of-day work; silently dropping it on an
app upgrade is real data loss for zero engineering saving. Migrate is ~15 lines.

`:v1` entries are the OLD shape `{ item_id, count }`. The transform maps each to
the new shape as a **units-only legacy count** (consistent with how legacy DB
rows with null splits are interpreted — OQ-4):

```
{ item_id,
  actual_remaining: count,
  actual_remaining_cases: null,
  actual_remaining_each: count }
```

This round-trips correctly: the total reaches `actual_remaining`, the splits
land null/units exactly as a legacy row would, and the item drains under the
`:v2` shape on the next connectivity flip. Procedure (per the contract at
`eodQueue.ts:224-240`):

1. `QUEUE_KEY` constant flips to `imr-staff:eod-queue:v2` (`eodQueue.ts:20`).
2. `migrateQueueIfNeeded` (`eodQueue.ts:103`) gains a branch:
   read `imr-staff:eod-queue:v1`; if present and non-empty, JSON-parse, map each
   element's `count` → the 3-field shape above (preserving `client_uuid`,
   `store_id`, `date`, `vendor_id`, `status`, `queued_at`, `intent_user_id`,
   `attempts`, `lastError`), write the array under `:v2`, then `removeItem` the
   `:v1` key. MUST be idempotent (contract rule 3): if `:v2` already exists,
   do not clobber it — only migrate when `:v2` is absent/empty and `:v1` is
   present. Malformed `:v1` bytes: best-effort — skip the element, don't throw
   (mirrors `hydrateQueue`'s tolerant posture).
3. `isValidQueuedSubmission` (`eodQueue.ts:30-44`) updates its `entries`
   element check in lockstep — the array-of-`{item_id, actual_remaining, ...}`
   shape (contract rule, `eodQueue.ts:238-240`). Today it only asserts
   `Array.isArray(o.entries)`; tighten to validate the element fields if the
   developer wants, but at minimum it must not reject the new shape.

This is a pure-frontend file; it ships with the frontend half.

---

### Data model changes

**None.** Both target columns already exist:
`public.eod_entries.actual_remaining_cases numeric` and
`public.eod_entries.actual_remaining_each numeric`, added additively in
`supabase/migrations/20260502071736_remote_schema.sql:55,57` (both nullable, no
default). No new table, no new column, no new index. The only migration is the
additive `create or replace` of the `staff_submit_eod` RPC body (below) — purely
behavioral, no DDL, no destructive change, safe to apply forward and (by being a
superset that tolerates missing keys) safe under rollback.

**Proposed migration filename:**
`supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql`
(must sort AFTER the current latest, `20260531010000_invitations_brand_id_backfill.sql`).

### RLS impact

**Unchanged — confirmed.** No new table → no new policies. The RPC stays
`security definer` with its in-body `auth_can_see_store(p_store_id)` gate
(`20260525000000_...:95-98`) verbatim. The two consistency triggers that fire on
the RPC's `eod_entries` INSERT —
`eod_entries_check_store_trg` (cross-store item/parent match) and
`eod_submissions_set_submitted_by_trg` (submitted_by override), both from
`20260514120030_eod_submissions_consistency.sql` — are agnostic to which columns
the INSERT lists; adding `actual_remaining_cases`/`actual_remaining_each` to the
column list does not touch the trigger predicates. The admin EDIT-path policies
(`admin_update_eod_*`) are likewise untouched. **No policy is added, dropped, or
rewritten by this spec.**

### API contract

**PostgREST RPC, not a new endpoint.** `public.staff_submit_eod(...)` — same
7-arg signature, called by the staff app under its per-user JWT (spec 061). The
two new values ride INSIDE the existing `p_entries jsonb` array; the function
**signature is unchanged**, so **no GRANT churn** and **no anon/service_role
re-affirmation needed** — confirmed. The existing
`GRANT EXECUTE ... TO authenticated` and the `REVOKE ... FROM public, anon,
service_role` from `20260525000000_...:221-222` stay exactly as-is and are NOT
re-emitted by the new migration (re-emitting them is allowed but unnecessary;
the SECURITY DEFINER + auth_can_see_store gate is the real boundary).

**Request shape** (per element of `p_entries`, after `entriesForRpc`):
```
{ ingredient_id: uuid,
  actual_remaining: number,        // the client-computed total
  actual_remaining_cases: number | null,
  actual_remaining_each: number | null }
```
`unit` and `notes` keys remain optional/absent for the staff path exactly as
today (the staff hook never sent them; `jsonb_to_recordset` reads them as NULL).

**Response shape:** unchanged — `{ submission_id, conflict, reason?, entry_ids?,
stock_updates? }`.

**Error cases:** unchanged — `42501` (caller cannot see store) → frontend
`forbidden`; `22023` (null vendor_id); idempotent replay returns
`conflict: true`. No new error class.

**Backward compatibility (load-bearing):** a `p_entries` element WITHOUT the two
new keys still inserts — `jsonb_to_recordset` yields NULL for absent columns, and
the `eod_entries` columns are nullable. So the admin direct-PostgREST path
(`db.ts submitEODCount`, which does NOT go through this RPC — it upserts
`eod_entries` directly) is unaffected, and any older staff client mid-rollout
still succeeds with `_cases`/`_each` = NULL.

#### RPC body change — precise diff from `20260525000000_...`

Two edits inside the function body; nothing else changes. The new migration is a
full `create or replace function public.staff_submit_eod(...)` carrying the
entire current body with these two hunks applied (do NOT `drop function` — a
plain `create or replace` preserves the signature/GRANTs and avoids GRANT
re-churn; the prior migration used drop+recreate to surface signature drift, but
here the signature is intentionally identical so `create or replace` is the
correct, lower-risk verb).

Hunk A — the `jsonb_to_recordset` column list (`20260525000000_...:156-162`):
```
  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      ingredient_id uuid,
      actual_remaining numeric,
      actual_remaining_cases numeric,   -- NEW
      actual_remaining_each numeric,    -- NEW
      unit text,
      notes text
    )
  loop
```

Hunk B — the `eod_entries` INSERT (`20260525000000_...:164-165`):
```
    insert into public.eod_entries
      (submission_id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes)
    values
      (v_submission_id, v_entry.ingredient_id, v_entry.actual_remaining,
       v_entry.actual_remaining_cases, v_entry.actual_remaining_each,
       coalesce(v_entry.notes, ''))
    returning id into v_entry_id;
```

Everything else stays byte-for-byte:
- The vendor-scoped `inventory_items.current_stock`/`eod_remaining` write
  (`...:174-179`) continues to use `v_entry.actual_remaining` (the total) — the
  RPC does NOT recompute the total, it stores what it receives. `caseQty` is
  never sent to or known by the RPC.
- The audit-log `value` string (`...:194`) continues to render
  `v_entry.actual_remaining || ' ' || unit` — the human-readable cases+units
  breakdown is explicitly out of v1 (OQ-3).
- The `auth_can_see_store` gate, idempotency check, vendor presence check, and
  the `on conflict (store_id, date, vendor_id)` upsert are unchanged.

End the migration file with the standard realtime/RLS no-op header comment
(mirror `20260525000000_...:44-46`): **no RLS change, no schema change, no
realtime publication membership change.**

### Edge function changes

**None.** This path is PostgREST RPC under the staff per-user JWT (spec 061); no
edge function is involved. `verify_jwt` settings in `config.toml` are untouched.
(The deprecated `staff-eod-submit` function remains 410'd and is not a caller.)

### `src/lib/db.ts` surface

**No change to `db.ts`.** Two reasons: (1) the staff subtree is a documented
carve-out that calls `supabase.*` directly and intentionally does NOT route
through `db.ts` (CLAUDE.md "DB access centralized" + this spec's Project notes);
(2) the admin `db.ts submitEODCount` already round-trips all three values and is
explicitly out of scope. The staff `fetchItemsForVendor` /
`fetchExistingSubmission` queries live in `EODCount.tsx` and are edited there.

For completeness, the staff-side helper signatures the FE owns (all in
`EODCount.tsx`, all already `supabase.*`-direct):
- `fetchItemsForVendor(storeId, vendorId): Promise<EodItem[]>` — add `case_qty`
  to the select; map `caseQty`.
- `fetchExistingSubmission(storeId, dateIso, vendorId): Promise<ExistingSubmission | null>`
  — extend the `eod_entries(...)` select to
  `eod_entries(item_id, actual_remaining, actual_remaining_cases, actual_remaining_each)`
  and map each entry to the new `EodEntry` shape
  (`actual_remaining_each ?? actual_remaining` is applied at the SCREEN seed
  step for the Units box, per OQ-4 — see Frontend store impact).

### Realtime impact

**None — confirmed, and the docker-restart ritual does NOT apply.** Two
independent reasons:
1. The staff stack has no realtime subscriptions in v1 (spec 062).
2. The migration changes **zero publication membership**. Critically,
   `eod_entries` is **NOT** in the `supabase_realtime` publication — the explicit
   table list in `20260514140000_realtime_publication_tighten.sql:43-53` includes
   `eod_submissions` but **not** `eod_entries`. So even though the RPC now writes
   two more columns to `eod_entries`, there is no publication to touch and no
   replication slot to re-snapshot. **No `docker restart
   supabase_realtime_imr-inventory` step on apply.** (The admin Cmd UI continues
   to receive `eod_submissions` row events on `store-{id}` and reloads via the
   existing `useRealtimeSync` debounce — unchanged; the deeper `_cases`/`_each`
   values arrive on that reload through `db.ts`'s existing EOD read mappers.)

### Frontend store impact

**`src/store/useStore.ts` — no change.** The admin store slice is untouched (the
admin worksheet already does cases/units). The staff app uses a separate
slice-isolated store, **`src/screens/staff/store/useStaffStore.ts`**, and the
optimistic-then-revert + `notifyBackendError` pattern there is the staff-local
one (`src/screens/staff/lib/notifyBackendError.ts`). The only `useStaffStore`
touch is mechanical: its queue mutations (`enqueueEod`/`dequeueEod`/
`hydrateQueueFromStorage`) persist `QueuedSubmission` whose `entries` element
shape changed — no logic change in the store itself, but the unit test at
`useStaffStore.test.ts:72` asserts the literal `:v1` key string and must flip to
`:v2`.

Screen seed logic (`EODCount.tsx`, the `useEffect` at lines 225-256 + render at
552-567) is where the dual-input + legacy fallback lands:
- Replace the single `counts: Record<string,string>` with two maps —
  `caseCounts` / `unitCounts` (`Record<string,string>`), mirroring the admin's
  `caseCountsByVendor`/`unitCountsByVendor` split but un-keyed-by-vendor since the
  staff screen already scopes to one selected vendor at a time.
- Seed step (replaces `EODCount.tsx:241-247`): for each existing entry, seed
  `caseCounts[item_id]` from `actual_remaining_cases` (blank when null) and
  `unitCounts[item_id]` from **`actual_remaining_each ?? actual_remaining`**
  (the admin legacy-row fallback, `EODCountSection.tsx:340-344`). A legacy row
  (splits NULL) → Cases blank, Units = the existing total.
- Build step (replaces the `entries` map in `onSubmit`, `EODCount.tsx:298-306`):
  for each row where EITHER `caseCounts[id]` OR `unitCounts[id]` is non-empty
  (the admin `hasEntry` rule, `EODCountSection.tsx:397-398`), compute
  `total = cases * (caseQty || 1) + units` with `isNaN → 0` coercion on each
  input (byte-identical to `EODCountSection.tsx:391-395,429`), and emit
  `{ item_id, actual_remaining: total, actual_remaining_cases: casesOrNull,
  actual_remaining_each: unitsOrNull }`. `caseQty` is read from the loaded
  `EodItem`. The "no counts entered" empty-payload guard
  (`EODCount.tsx:307-315`) stays.
- Render (replaces the single `<Input testID={`eod-item-input-${id}`}>` at
  `EODCount.tsx:552-567`): two `<Input>`s — `eod-item-cases-${id}` and
  `eod-item-units-${id}`, both `keyboardType="decimal-pad"` +
  `inputMode="decimal"` on web, each with a distinct `accessibilityLabel`. The
  old `eod-item-input-${id}` testID is removed; update any selector that
  references it (the Track-4 e2e and any jest query).

`useEodSubmit.entriesForRpc` (`useEodSubmit.ts:67-75`) becomes a near-identity
map onto the RPC arg object:
```
{ ingredient_id: e.item_id,
  actual_remaining: e.actual_remaining,
  actual_remaining_cases: e.actual_remaining_cases,
  actual_remaining_each: e.actual_remaining_each }
```
(plus `unit`/`notes` may stay absent as today). `callStaffSubmitEod`,
`SubmitPayload`, `Outcome`, the drain loop, and the queue write-through are
otherwise unchanged — they pass `entries` opaquely.

### Reports — explicitly confirmed NO change

`report_run_variance` (`20260512120000_...`), its multivendor variant
(`20260514120020_...`), and `report_reorder_list` (`20260514130000_...`) all read
`eod_entries.actual_remaining` (summed as variance / used as `on_hand`). Because
staff now writes the **converted total** into `actual_remaining` (same column,
same semantics as the admin path), these reports keep reading a true on-hand
number. **No report RPC is touched.** This is the entire payoff of the OQ-1
convert decision.

### Risks and tradeoffs (explicit)

- **Migration ordering.** New file `20260601000000_...` sorts after the current
  latest `20260531010000_...` — verified. The `db-migrations-applied` gate
  applies (CLAUDE.md CI section); user runs `npx supabase db push --linked`
  post-merge. No CI assumption beyond the two gates already on disk.
- **RLS gaps — none introduced.** The SECURITY DEFINER `auth_can_see_store`
  gate and both `eod_entries` triggers are unchanged and continue to fire on the
  new INSERT. The `case_qty` read adds no new RLS surface (already-granted column
  on an already-joined table).
- **`create or replace` vs `drop+recreate`.** Chosen `create or replace` to
  preserve the GRANT/signature with zero churn. Trade-off: it will NOT surface
  accidental signature drift the way the prior drop+recreate did — mitigated by
  the pgTAP `has_function` shape assertion (below) and the fact that the
  signature is intentionally byte-identical.
- **`count` field removal is a breaking type change inside the staff slice.**
  Every reader is in-repo and enumerated above; TypeScript strict will flag any
  missed call-site at build (the test-graph typecheck gate catches it). The
  `:v1` migrate covers persisted payloads. Low residual risk.
- **Performance on the 286 KB seed.** Negligible. `fetchItemsForVendor` adds one
  scalar column to an existing per-vendor join (tens of rows). The RPC adds two
  numeric columns to an INSERT it already runs per entry. No new query, no new
  index need, no N+1.
- **Edge-function cold-start.** N/A — no edge function in this path.
- **Web/native dual-input layout** (spec-072 scroll/footer regression class).
  Two inputs per row widen the trailing cell; the FE must keep the Track-4 scroll
  guard intact on a phone viewport (the `flex:1` list body + pinned footer at
  `EODCount.tsx:526-534,705-708`). Flagged for the FE; covered by the Track-4
  e2e scroll guard.
- **Idempotency of the `:v1` migrate.** If `:v2` already exists the migrate must
  no-op (not clobber). Contract rule 3 (`eodQueue.ts:233`) — the developer must
  guard on `:v2` absent before transforming, or the second mount could overwrite
  freshly-enqueued `:v2` items with re-read `:v1` bytes. Called out as a Critical
  in the FE acceptance.

### Test contract

**Track 2 (pgTAP)** — `staff_submit_eod` against the seeded-user + hermetic
begin/rollback pattern (reuse the existing EOD pgTAP harness):
1. Call the RPC with a `p_entries` element carrying
   `actual_remaining`, `actual_remaining_cases`, `actual_remaining_each`; assert
   the resulting `eod_entries` row has all three persisted (total in
   `actual_remaining`, raw splits in `_cases`/`_each`).
2. Call with a legacy element OMITTING the two split keys; assert it still
   inserts with `_cases`/`_each` = NULL and `actual_remaining` set — the
   backward-compat guarantee.
3. Assert the per-store gate still holds (a caller without
   `auth_can_see_store(p_store_id)` still raises `42501`) and the
   `eod_entries_check_store` consistency trigger still fires on a cross-store
   item (existing assertions; confirm they still pass under the new INSERT).
4. **Grant check:** the signature/GRANT is intentionally unchanged, so assert
   shape via `has_function_privilege('authenticated', 'public.staff_submit_eod(...)','execute')`
   = true ONLY if the developer wants belt-and-suspenders. **Do NOT** add a
   `set role anon` + `throws_ok` probe — that segfaults CI (spec 067). No grant
   is touched, so a grant test is optional, not required.

**Track 1 (jest)** — staff slice:
- `EODCount` renders TWO inputs per row (`eod-item-cases-${id}`,
  `eod-item-units-${id}`); the single-input testID is gone.
- Conversion: `cases * (caseQty || 1) + units`, including `caseQty` null → ×1,
  and `isNaN → 0` on each empty input.
- "Entered when EITHER filled" predicate; fully-blank rows skipped.
- Pre-fill seeds BOTH boxes incl. the legacy `actual_remaining_each ??
  actual_remaining` fallback (Cases blank for a legacy row).
- `useEodSubmit.entriesForRpc` sends all three values in the RPC arg object.
- Queue: enqueue/dequeue under the new `EodEntry` shape; the `:v1 → :v2`
  read-once migrate (a seeded `:v1` payload becomes a `:v2` payload with
  `actual_remaining_cases: null`, `actual_remaining_each = count`,
  `actual_remaining = count`; `:v1` key removed; idempotent on a second run).
- Flip the `:v1` literal to `:v2` in `useStaffStore.test.ts:72`.

**Track 4 (Playwright)** — extend `e2e/eod.spec.ts`: submit Cases+Units online,
reload, assert BOTH inputs pre-fill; offline → queue → drain preserves total +
splits. Flip `STAFF_QUEUE_KEY` to `:v2` in `e2e/fixtures/constants.ts:72`, update
the `addInitScript` removal in `e2e/eod.spec.ts`, and the docs in
`tests/README.md`. (Track 4 is owned by whichever dev owns the e2e suite; the FE
owns the fixture/spec string flips since they ride with the queue-key bump.)

### File ownership (parallel fan-out — disjoint except `types.ts`)

**backend-developer owns (RPC + DB tests):**
- `supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql` (new)
- the Track-2 pgTAP test file under `supabase/tests/` (extend the EOD coverage)

**frontend-developer owns (staff slice + jest + e2e fixtures):**
- `src/screens/staff/lib/types.ts` (`EodItem` +`caseQty`; `EodEntry` 3-field
  shape; `QueuedSubmission` rides the `EodEntry` change) — **FE owns this file
  outright; backend does not touch it.**
- `src/screens/staff/screens/EODCount.tsx` (two inputs, convert, pre-fill,
  query+map `case_qty`)
- `src/screens/staff/hooks/useEodSubmit.ts` (`entriesForRpc`)
- `src/screens/staff/lib/eodQueue.ts` (`QUEUE_KEY` → `:v2`;
  `migrateQueueIfNeeded` branch; `isValidQueuedSubmission` in lockstep)
- `src/screens/staff/i18n/en.json` (Cases/Units labels, OQ-3)
- `src/screens/staff/store/useStaffStore.test.ts` (`:v2` literal)
- jest specs for the above; `e2e/fixtures/constants.ts`, `e2e/eod.spec.ts`,
  `tests/README.md` (queue-key `:v2` flips)
- optional one-line stale-comment fix at `EODCountSection.tsx:61` (admin file,
  comment-only)

The two halves touch **disjoint files** — backend is `supabase/`, frontend is
`src/screens/staff/` + `e2e/` + `tests/`. No collision. They can run in parallel.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec's "## Backend design
  (architect)" section. backend-developer owns ONLY
  supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql (additive
  `create or replace` of staff_submit_eod — two body hunks per the precise diff;
  signature/GRANT unchanged; backward-compatible) plus the Track-2 pgTAP
  coverage. frontend-developer owns the entire staff slice
  (src/screens/staff/lib/types.ts — FE-owned outright; EODCount.tsx dual-input +
  convert + case_qty query/map + legacy pre-fill; useEodSubmit.entriesForRpc;
  eodQueue.ts QUEUE_KEY :v1→:v2 + migrateQueueIfNeeded read-once-migrate;
  i18n; jest; and the e2e/tests `:v2` fixture flips). The file sets are disjoint
  (supabase/ vs src/screens/staff/ + e2e/ + tests/), so run in parallel. After
  implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/086/spec.md

---

## Files changed (parallel build — backend-developer + frontend-developer)

**Backend (RPC migration + pgTAP) — backend-developer:**
- `supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql` (NEW) — additive `create or replace` of `staff_submit_eod`; two body hunks (jsonb_to_recordset gains `actual_remaining_cases`/`actual_remaining_each`; the `eod_entries` INSERT writes them alongside the total). Signature byte-identical → GRANT preserved; backward-compatible (absent keys → NULL); no RLS/realtime change.
- `supabase/tests/staff_submit_eod_cases_each.test.sql` (NEW) — 6 assertions (GRANT survived via `has_function_privilege`; split values persist; legacy entry without split keys still inserts; total stored as-received; per-store 42501 gate intact). No `set role anon`.

**Frontend (staff slice + e2e/tests fixtures) — frontend-developer:**
- `src/screens/staff/lib/types.ts` — `EodItem.caseQty`; `EodEntry` → `{ item_id, actual_remaining, actual_remaining_cases, actual_remaining_each }`; `QueuedSubmission`/`SubmitPayload`/`ExistingSubmission` ride the change.
- `src/screens/staff/screens/EODCount.tsx` — `case_qty` added to the catalog join + mapped; two inputs per item (`eod-item-cases-*` / `eod-item-units-*`); `total = cases × (caseQty || 1) + units`; split + legacy (`each ?? actual_remaining`) pre-fill; live total line.
- `src/screens/staff/hooks/useEodSubmit.ts` — `entriesForRpc` sends all three values.
- `src/screens/staff/lib/eodQueue.ts` — `QUEUE_KEY` `:v1→:v2`; `V1_QUEUE_KEY`; idempotent read-once-migrate (write-then-remove ordering); tightened `isValidQueuedSubmission`.
- `src/screens/staff/i18n/en.json` — `eod.col.cases/units/casesAria/unitsAria`, `eod.row.caseOf/total`.
- jest: `EODCount.test.tsx`, `useEodSubmit.test.ts`, `eodQueue.test.ts`, `store/useStaffStore.test.ts`, `i18n/i18n.test.ts`.
- e2e/docs: `e2e/fixtures/constants.ts` (`STAFF_QUEUE_KEY :v2`), `e2e/eod.spec.ts`, `e2e/auth.setup.ts`, `tests/README.md`.

**Verification:** backend pgTAP 41/41 files (new 6/6, EOD anchors intact); frontend jest 47 suites / 459 tests, base + test-graph + e2e typechecks exit 0, and a live browser round-trip (Cases=2 + Units=3 on a `case_qty=4` item → total 11 persisted with `cases:2, each:3`). Changes are UNCOMMITTED.
