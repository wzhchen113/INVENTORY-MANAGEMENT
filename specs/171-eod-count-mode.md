# Spec 171: Per-ingredient EOD count mode (cases + units / cases only / units only)

Status: READY_FOR_REVIEW

Origin: owner request (2026-10-23), verbatim: "on the EOD counts, on the setting for each ingredients have a option to null out case or units, so that user can only select one options". The owner approved the scope in chat before this spec was written. Decisions 1-5 below are recorded as resolved.

## User stories

1. As a **brand admin**, I want to set each ingredient to be counted in cases only, units only, or both, so that end-of-day counters cannot enter a mixed or wrong-granularity count. Today a counter can enter "4 each" for Lettuce Iceberg (case 24) when the store counts it by the case.
2. As a **store manager or staff counter**, I want the EOD count row to offer only the box that applies to the ingredient, so that I can't fill the wrong one and the total is unambiguous.
3. As an **admin**, I want ingredients I have not configured to behave exactly as they do today.

## Current state (verified 2026-10-23)

- Every EOD row has a CASES box and a UNITS box, and `total = cases × caseQty + units`. The CASES box is enabled only when `caseQty > 1` (caption `× N`). Otherwise it renders `'—'`, is non-editable, and is dimmed (opacity 0.5).
  - Desktop row: [src/screens/cmd/sections/EODCountSection.tsx](../src/screens/cmd/sections/EODCountSection.tsx) `renderEodRow` (~L869, `hasCase` at ~L888). The gate-jump focus ref goes to the case input when `hasCase` and to the units input otherwise (~L916-L947).
  - `itemTotal` (~L564), `localHasEntry` / `hasEntry` (~L588-L590; either box non-blank counts), `buildSubmission` (~L700; per-entry total ~L718), the completeness gate in `onSubmit` (~L795).
  - `deriveCountedItemIds` (~L74) treats any non-blank case **or** unit value in **any** vendor tab's local map as counted (spec 102, counted once globally).
- Admin phone EOD ([src/screens/cmd/sections/eod/PhoneEodCount.tsx](../src/screens/cmd/sections/eod/PhoneEodCount.tsx), [PhoneKeypadSheet.tsx](../src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx)) reuses the parent's `hasEntry` / `itemTotal` through `model`. It **omits** the CS well when `caseQty ≤ 1`. The initial active field comes from `activeFieldFor(caseQty)` in [src/lib/eodKeypad.ts:51](../src/lib/eodKeypad.ts), called on pending-focus (L109) and on advance (L152).
- Staff EOD ([src/screens/staff/screens/EODCount.tsx](../src/screens/staff/screens/EODCount.tsx)) fetches `catalog_ingredients(name, unit, case_qty, i18n_names, image_path)` directly via PostgREST (~L151) and keeps `caseQty` nullable (~L189).
  - Counting logic: `isCounted` (~L379), `sheetTotal` (~L389), the submit gate `isBlank` (~L704), entry building (~L734-L751), row total (~L873).
  - `activeFieldFor` is called at ~L432 and ~L690.
  - [StaffEodCountRow.tsx](../src/screens/staff/screens/eod/StaffEodCountRow.tsx) and [StaffKeypadSheet.tsx](../src/screens/staff/screens/eod/StaffKeypadSheet.tsx) omit the CS well when `hasPack` is false.
  - `src/screens/staff/lib/eodKeypad.ts` re-exports the shared helper.
- `activeFieldFor` is **also** used by the out-of-scope weekly count screen [src/screens/cmd/sections/phone/PhoneWeeklyCount.tsx](../src/screens/cmd/sections/phone/PhoneWeeklyCount.tsx) (L161, L189). Its existing tests are [src/lib/eodKeypad.test.ts:67](../src/lib/eodKeypad.test.ts) and [src/screens/staff/lib/eodKeypad.test.ts:35](../src/screens/staff/lib/eodKeypad.test.ts).
- `case_qty` lives on `public.catalog_ingredients`, which is brand-level ([20260504060452_brand_catalog_p1_additive.sql:40](../supabase/migrations/20260504060452_brand_catalog_p1_additive.sql)).
  - Admin reads it through the `catalog:` embed in `fetchInventory` ([src/lib/db.ts:290](../src/lib/db.ts)).
  - Admin writes it through `updateInventoryItem`'s `catalogUpdates` (db.ts ~L463-L491) and on create through the `create_inventory_item_with_catalog` RPC (`p_case_qty`, db.ts ~L363; latest body in `20260517000000_user_data_i18n_names.sql`).
- Editor: [src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx), with the "units / case" field at ~L1062. It is hosted by `IngredientFormDrawer.tsx` and `InventoryCatalogMode.tsx`.
- Realtime: `catalog_ingredients` is already in `supabase_realtime`, and the admin already subscribes to it on `brand-{id}` ([src/hooks/useRealtimeSync.ts:67](../src/hooks/useRealtimeSync.ts)). The staff stack has no realtime (spec 062).

## Acceptance criteria

**Schema (pgTAP, new file `supabase/tests/eod_count_mode.test.sql`)**
- [ ] AC-1: `public.catalog_ingredients` has a column `eod_count_mode`, type `text`, `NOT NULL`, default `'cases_and_units'`.
- [ ] AC-2: A CHECK constraint admits exactly `'cases_and_units'`, `'cases_only'`, `'units_only'`.
  - Inserting or updating to any other value (e.g. `'cases'`, `''`) raises SQLSTATE `23514`.
  - Setting it to NULL raises `23502`.
- [ ] AC-3: After the migration, every pre-existing `catalog_ingredients` row reads `'cases_and_units'` (backfilled by the default; no row is NULL). A row inserted with the column omitted also reads `'cases_and_units'`.
- [ ] AC-4: A staff principal (`role='user'` with a `user_stores` grant) can read `eod_count_mode` through the same `item_vendors → inventory_items → catalog_ingredients` embed path the staff app uses. Its existing inability to UPDATE `catalog_ingredients` is unchanged (0 rows / refused, per the existing policy).
- [ ] AC-5: The migration is additive and re-runnable (`add column if not exists` plus an idempotent constraint add). The existing pgTAP suite passes unchanged, including `spec093_case_qty_backfill`, `cross_brand_copy`, `copy_brand_catalog`, `staff_role_eod_rls`, `ingredient_changed_badge`, and `permissive_policy_lint`.

**Effective-mode resolution (jest, pure helper)**
- [ ] AC-6: A single pure helper resolves the *effective* mode from `(caseQty, storedMode)`, and every in-scope surface uses it.
  - `caseQty` of `null`, `undefined`, `0`, or `1` → `'units_only'` regardless of the stored mode.
  - `caseQty > 1` → the stored mode.
  - A missing or unknown stored mode with `caseQty > 1` → `'cases_and_units'`.
  - Jest covers every combination of {null, 0, 1, 24} × {each of the three modes, undefined}.
- [ ] AC-7: Total, counted, and submission rules, driven by the effective mode (jest covers each mode):
  - `'cases_and_units'`: total = `cases × caseQty + units`, byte-identical to today.
  - `'cases_only'`: total = `cases × caseQty`, and any value in the units map for that item is ignored.
  - `'units_only'`: total = `units`, and any value in the cases map is ignored.
  - An item counts as entered (`localHasEntry` / `hasEntry` / staff `isCounted` / staff `isBlank` negation) only when an **enabled** box is non-blank.
  - The emitted entry carries `actual_remaining_cases` / `actualRemainingCases = null`/`undefined` for a disabled cases box, and `actual_remaining_each` / `actualRemainingEach = null`/`undefined` for a disabled units box. `actual_remaining` equals the mode's total.

**Keypad initial field (jest)**
- [ ] AC-8: The EOD surfaces pick the initial keypad field from the effective mode:
  - `'cases_only'` → `'cases'`
  - `'units_only'` → `'units'`
  - `'cases_and_units'` → `'cases'` (today's behavior for `caseQty > 1`).

  This applies at every call site on the admin phone (pending-focus and advance) and the staff app (advance and pending-focus).
- [ ] AC-9: `PhoneWeeklyCount` behavior is unchanged. The existing `activeFieldFor(caseQty)` assertions in both `eodKeypad.test.ts` files pass unmodified. If the helper gains a mode parameter, it is optional, and omitting it reproduces today's output.

**Admin desktop row (jest)**
- [ ] AC-10: For an item with `caseQty = 24`:
  - `'units_only'`: the CASES input is non-editable, shows no value, has placeholder `'—'`, is dimmed (opacity 0.5), and its caption reads `'—'`. The UNITS input is editable.
  - `'cases_only'`: the UNITS input is non-editable, shows no value, has placeholder `'—'`, is dimmed, and its caption reads `'—'`. The CASES input is editable with caption `× 24`.
  - A disabled box never shows the uncounted danger border.
- [ ] AC-11: The submit gate's jump target (the `pendingFocusItem` focus ref) lands on the **enabled** input: case input for `'cases_only'`, units input for `'units_only'`, unchanged for `'cases_and_units'`.
- [ ] AC-12: `deriveCountedItemIds` ignores a non-blank value sitting in an item's **disabled** box in any vendor tab. That means a stale disabled-box value cannot mark a shared item counted in another tab. Existing `EODCountSection.countedOnce` / `customOrder` tests pass. New arms cover each mode.

**Admin phone + staff app (jest)**
- [ ] AC-13: Admin phone row ([PhoneEodCount.tsx](../src/screens/cmd/sections/eod/PhoneEodCount.tsx)) and keypad sheet ([PhoneKeypadSheet.tsx](../src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx)) omit the disabled well, mirroring today's no-case omission:
  - `'units_only'`: no CS well.
  - `'cases_only'`: no unit well; the CS well is present.
  - `'cases_and_units'`: both wells present (`caseQty > 1`).
- [ ] AC-14: The same rendering rules hold for the staff app's [StaffEodCountRow.tsx](../src/screens/staff/screens/eod/StaffEodCountRow.tsx) and [StaffKeypadSheet.tsx](../src/screens/staff/screens/eod/StaffKeypadSheet.tsx). The existing `StaffEodCountRow.test.tsx` arms pass, and new arms assert the `eod-well-<id>-units` testID is absent under `'cases_only'`.
- [ ] AC-15: The staff catalog fetch (`EODCount.tsx` ~L151) selects `eod_count_mode`. The staff `EodItem` carries it. The staff gate, entries, and totals follow AC-7.

**Stale value in a now-disabled box (decision 5; jest)**
- [ ] AC-16: Setup: an item with `caseQty = 24` has a typed case value of `"2"` and a blank units box. Its effective mode then becomes `'units_only'` (realtime reload on admin, or re-fetch on staff). After that:
  - (a) the row's total is 0;
  - (b) the row is uncounted (red / blocking), and the final-submit gate blocks and jumps to it;
  - (c) `buildSubmission` (admin) and the staff entry builder both omit the item, or emit it without the case value, when no enabled box has a value;
  - (d) the CASES box renders disabled per AC-10 / AC-13 / AC-14.

  The mirror case (`'cases_only'` with a stale units value) behaves symmetrically. Clearing the stale value from local state is allowed but not required.

**Editor (jest)**
- [ ] AC-17: [IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx) renders an "EOD count" control next to the "units / case" field. It has three options labeled "Cases + units", "Cases only", "Units only", and it defaults to "Cases + units" for a new ingredient.
  - The control is rendered only when the parsed case size is `> 1`.
  - At case size `≤ 1` (blank, 0, 1, unparseable) it is hidden. The form's stored mode value is **preserved**, not rewritten, so raising the case size back above 1 resurfaces the prior choice.
- [ ] AC-18: Saving an existing ingredient with a changed mode persists `catalog_ingredients.eod_count_mode` through `updateInventoryItem`'s catalog-level update path (`src/lib/db.ts`). Omitting the field leaves the column untouched, matching the omit-key-to-skip convention. Creating a new ingredient with a non-default mode persists that mode. The architect chooses between an RPC parameter on `create_inventory_item_with_catalog` and a follow-up catalog update.
- [ ] AC-19: `fetchInventory`'s `catalog:` embed selects `eod_count_mode`. The admin `InventoryItem` exposes it as camelCase `eodCountMode`, with a missing value mapping to `'cases_and_units'`.

**Historical and locked display (decision 4)**
- [ ] AC-20: A submitted (locked, not in EDIT) vendor count renders its stored `actual_remaining_cases` / `actual_remaining_each` regardless of the item's current mode. The mode governs editing only. Jest covers one admin and one staff arm: an item now `'units_only'` whose submission stored cases = 2 still displays 2 in the read-only view.
  - **Amended by OQ-A (owner-approved 2026-10-23):** the admin UNITS display (desktop read-only view, desktop EDIT prefill, phone locked row) falls back to `actual_remaining` **only when both** `actual_remaining_each` and `actual_remaining_cases` are null (a true legacy row). A cases-only entry (cases set, each null) now shows blank units instead of the total. This matches the staff app's existing seed logic. Every other stored value renders exactly as before.

**Regression gates**
- [ ] AC-21: For ingredients left at the default, every EOD surface behaves identically to before. Existing EOD jest suites pass without modification of their assertions: `PhoneEodCount.test.tsx`, `StaffEodCountRow.test.tsx`, both `eodKeypad.test.ts` files, `EODCountSection.*.test.tsx`, and the IngredientForm tests.
- [ ] AC-22: Full `npx jest`, `npm run typecheck`, the test-graph typecheck (`typecheck:test`), and the full pgTAP suite (`npm run test:db`) pass. `scripts/smoke-staff-eod.sh` passes against the local stack.

## In scope

- One additive migration: the `catalog_ingredients.eod_count_mode` column, its default, and its CHECK. A `create_inventory_item_with_catalog` signature change only if the architect picks that route for AC-18.
- A new pgTAP file (AC-1 to AC-4).
- A pure effective-mode helper and the total/counted/entry rules (AC-6, AC-7), plus the keypad initial-field rule (AC-8).
- The `src/lib/db.ts` read/write mapping and the `InventoryItem` type field.
- The IngredientForm control.
- Admin desktop EOD row, admin phone EOD + keypad sheet, staff EOD row + keypad sheet + catalog fetch.
- Jest coverage per the ACs above.

## Out of scope (explicitly)

- **Weekly / inventory count screens** (`InventoryCountSection`, `PhoneWeeklyCount`, staff `WeeklyCount`). Owner decision 4. AC-9 guards the shared helper so they don't change by accident.
- **Ordering / reorder, receiving, POs.** Owner decision 4. Reorder RPCs keep reading `case_qty` only.
- **Re-rendering or migrating already-submitted counts.** They render as stored (AC-20). No backfill of `eod_entries`.
- **Server-side enforcement.** `staff_submit_eod` and the admin `eod_entries` upsert do not reject a cases value on a `'units_only'` item, and no DB trigger nulls it. The request is a UI-input restriction. Rationale: a server check would also have to handle queued offline staff submissions built before a mode change. It can be a follow-up if the owner wants it.
- **Count export** (`src/utils/countExport.ts`). It may keep emitting whatever is typed in either map (owner decision 3). The architect may fold in a mode-aware export only if it is trivial; it is not required.
- **"Updated" badge (spec 128).** A mode change does not stamp `image_changed_at` or raise the staff "Updated" badge.
- **Cross-brand catalog copy** (`copy_catalog_rows`, `copy_brand_catalog`). Copied rows receive the default `'cases_and_units'` rather than the source's mode. Rationale: the copy RPCs enumerate columns explicitly, and widening them is a separate catalog-copy concern.
- **Per-store override of the mode.** It is brand-level only (owner decision 1).
- **Prod apply of the migration.** That is the owner's call via Supabase MCP. Until then, committing the migration turns `db-migrations-applied.yml` red (see Risks).
- **`app.json` slug.** Not touched.

## Open questions resolved (owner-approved scope, 2026-10-23)

- Q: What values does the setting take? → A: Three: "Cases + units" (default, today's behavior), "Cases only", "Units only".
- Q: Where is it stored, and is it per-store or brand-wide? → A: Brand-level, on `public.catalog_ingredients` next to `case_qty`. It applies to every store in the brand. Existing rows default to cases + units, so nothing changes until a mode is set.
- Q: Where is it edited? → A: In `IngredientForm.tsx` near the case-size field. It is shown only when case size > 1. When `caseQty ≤ 1`, only units are countable, so the setting is moot and the item is treated as units-only regardless of the stored value.
- Q: Which surfaces honor it? → A: Admin desktop EOD row, admin phone EOD + keypad sheet (the initial keypad field must be the enabled one), and the staff EOD app. The disabled box renders like today's no-case box. Totals and the submit completeness gate consider only the enabled box. Count export may stay as-is unless the change is trivial.
- Q: What is out of scope? → A: Weekly/inventory count screens, ordering/reorder, receiving, and already-submitted historical counts (they render as stored).
- Q: What happens when a box already holds a value and the mode then disables it (e.g. a mid-day realtime change)? → A: The disabled box's value is ignored in the total, the counted predicate, and the submission (AC-16).

## Notes for architect (non-blocking interpretations)

- **N1. "Renders like today's no-case box" differs by surface.** On the desktop, today's no-case box is a visible `'—'`, non-editable, dimmed input. On the phone and staff wells, today's no-case CS well is **omitted**. This spec applies each surface's existing convention to whichever box is disabled (AC-10 vs AC-13/AC-14). On phone and staff, a `'cases_only'` item therefore shows only the CS well. That is new (today the unit well is always present), so confirm the layout holds with a single CS well.
- **N2. The stored mode stays separate from the effective mode.** AC-17 keeps the stored value when case size drops to ≤ 1, and AC-6 makes it inert. Do not "normalize" the stored value on save.
- **N3. Drafts.** A previously saved draft entry may carry a value in a box that is now disabled. Under AC-7/AC-16 that row reads uncounted, and a re-saved draft omits it (or emits it without the disabled value). Check whether the admin draft upsert replaces or merges entries, so that a re-save doesn't silently drop a draft row the user expects to keep. If it replaces, that outcome is the accepted consequence of decision 5, but say so in the design.
- **N4. Staff offline queue.** Queued staff submissions are built at submit time from the then-current mode, so a later mode change does not touch them. No queue change is expected.
- **N5. Shared helper.** `activeFieldFor` in `src/lib/eodKeypad.ts` is shared with `PhoneWeeklyCount`, and `src/screens/staff/lib/eodKeypad.ts` re-exports it (an identity test pins this). Extending it with an optional mode argument, or adding a sibling helper, are both fine as long as AC-9 holds.
- **N6. Labels.** IngredientForm field labels are hardcoded English today ("units / case"). The new control's labels follow that convention. No staff or admin i18n catalog strings are needed, because the disabled box/well reuses existing `'—'` / omission rendering.

## Risks

- **`db-migrations-applied` goes red on commit** until the migration is applied to prod (project `ebwnovzzkwhsdxkpyjka`, via MCP). Per CLAUDE.md, SHIP_READY requires both gates green. Applying before pushing yields only the gate's warn path.
- **Client/DB ordering.** An admin or staff client built before this ships ignores the column (harmless). A new client against a DB without the column fails the `catalog:` embed select. Apply the migration before or with the client deploy.
- **Realtime after the column add.** `catalog_ingredients` is already published, so no publication change is needed. The architect should confirm locally that `brand-{id}` change events still fire after `alter table … add column`. If they don't, the `docker restart supabase_realtime_imr-inventory` ritual from the project memory applies.
- **Staff sees a mode change only on re-fetch** (no staff realtime, spec 062). A counter mid-session keeps the old mode until the vendor list reloads. AC-16 bounds the damage on the admin side only. This is accepted.

## Dependencies

- `public.catalog_ingredients.case_qty` (brand catalog P1), spec 093 case-size semantics, spec 102 counted-once-globally (`deriveCountedItemIds`), spec 103 custom order / gate jump, spec 129 staff submitted-lock, spec 086 cases/units split (`actual_remaining_cases` / `actual_remaining_each`), and the phone-tier keypad (`src/lib/eodKeypad.ts`).
- Local stack (`npm run dev:db`) for pgTAP and the staff EOD smoke.

## Project-specific notes

- Cmd UI section / legacy: `src/screens/cmd/sections/EODCountSection.tsx` and `src/screens/cmd/sections/eod/` (admin). Also the staff subtree `src/screens/staff/screens/EODCount.tsx` + `eod/`, and the editor `src/components/cmd/IngredientForm.tsx`.
- Per-store or admin-global: brand-level (per brand, all stores). Readable by store members through the existing `catalog_ingredients` RLS. Writable by privileged roles through the existing catalog update policy. No policy change.
- Realtime channels touched: `brand-{id}` (existing `catalog_ingredients` subscription). No publication change.
- Migrations needed: yes (one, additive).
- Edge functions touched: none.
- Web/native scope: both. All touched code is shared React Native / react-native-web, and the staff app ships in the same bundle.
- Test tracks: pgTAP (new `eod_count_mode.test.sql`, plus full-suite regression), jest (helper, rows, keypad sheets, editor, db mapping), shell smoke (`scripts/smoke-staff-eod.sh` regression).

## Backend design

Architect: backend-architect, 2026-10-23. All line numbers are from `main` at `c2ac211`.

### 0. Decisions at a glance

| # | Decision |
|---|---|
| D1 | One migration: `supabase/migrations/20261023000000_catalog_eod_count_mode.sql`. It sorts after the current latest, `20261022000000_audit_log_rls_hardening.sql`. It is additive and idempotent, and it does not change the publication. |
| D2 | **AC-18 create path: extend the RPC.** Drop and recreate `create_inventory_item_with_catalog` with a 13th param, `p_eod_count_mode text default 'cases_and_units'`, added **last**. Do not use a follow-up catalog update. Rationale is in §3. |
| D3 | Brand-level column, existing RLS. No policy is added or changed. No grant is needed for the column. |
| D4 | One pure helper module, `src/lib/eodCountMode.ts`, owns the type, normalization, effective-mode resolution, and the total/counted/entry rules. Every in-scope surface goes through it (AC-6). |
| D5 | `activeFieldFor(caseQty, mode?)` gets an optional 2nd arg. With one argument its output is identical to today for every input (AC-9). |
| D6 | `deriveCountedItemIds` gets an optional `effectiveModeOf` resolver. Without it, the result is identical to today (AC-12; existing tests unchanged). |
| D7 | **Locked/read-only rows render with the *legacy* layout** (`effectiveEodCountMode(caseQty)`, no stored mode). Editable rows use the live mode. One rule gives AC-20 on every surface. |
| D8 | Deploy order: apply the prod migration via MCP **before** pushing to `main`. That keeps `db-migrations-applied` green and makes the DB lead the client. |

### 1. Data model

**Migration `20261023000000_catalog_eod_count_mode.sql`.** It is additive. It runs as a single `begin; … commit;`. The header comment should follow the `20260721000000_ingredient_photos.sql` style: what, RLS, realtime, idempotency.

Pseudocode (the developer writes the SQL):

1. `alter table public.catalog_ingredients add column if not exists eod_count_mode text not null default 'cases_and_units';`
   - On PG 17 this is a metadata-only ALTER: a constant default, no row rewrite, and a brief AccessExclusive lock. Every existing row reads `'cases_and_units'` the moment the migration commits (AC-3). No UPDATE backfill is needed.
2. Add the CHECK constraint `catalog_ingredients_eod_count_mode_check`: `eod_count_mode in ('cases_and_units','cases_only','units_only')`.
   - Make it idempotent with `alter table … drop constraint if exists catalog_ingredients_eod_count_mode_check;` followed by `add constraint …`. Drop-then-add keeps the definition deterministic on re-run. Validation scans about 143 local rows and a similarly small prod table, which is trivial.
   - Bad values raise `23514` and NULL raises `23502` (AC-2).
3. `comment on column public.catalog_ingredients.eod_count_mode is 'Spec 171: EOD count input mode …'`. The comment should state that the mode is inert when `case_qty <= 1`, and that the stored value is never normalized on save (N2).
4. RPC drop and recreate (§3).

**Grants (spec 097).** Nothing extra is needed for the column.
- `catalog_ingredients` has only table-level grants: `grant select, insert, update, delete, references, trigger on all tables … to anon, authenticated` in `20260618000000_public_grants_explicit.sql:147`.
- No migration issues a column-level `grant/revoke (col)` on this table. I grepped for every `grant|revoke … (` and found only function signatures.
- A new column therefore inherits the table grant. RLS (`brand_member_read_catalog_ingredients` / `privileged_update_catalog_ingredients`, `20260509000000_multi_brand_schema_rls.sql:446-458`) stays the inner gate.

**Seed / copy RPCs.**
- `supabase/seed.sql:254` inserts into `catalog_ingredients` with an explicit column list, so the default fills in.
- `copy_brand_catalog` (`20260517030000:40`) and `copy_catalog_rows` (`20260518000000:170`) also enumerate columns explicitly, so copied rows get the default. That matches the spec's out-of-scope decision.

**Triggers.** The only UPDATE trigger on the table is `trg_catalog_image_changed_at`. It stamps `image_changed_at` only when `image_path IS DISTINCT FROM`, so a mode change cannot raise the spec-128 "Updated" badge. This is confirmed.

### 2. RLS impact

No policy changes. This is a brand-level table (`brand_id`), so the helpers involved are `auth_can_see_brand()` plus `auth_is_privileged()`, not `auth_can_see_store()`.

| Command | Existing policy | Effect for `eod_count_mode` |
|---|---|---|
| SELECT | `brand_member_read_catalog_ingredients` | Staff `role='user'` in the brand read it through the `item_vendors → inventory_items → catalog_ingredients` embed (AC-4). |
| UPDATE | `privileged_update_catalog_ingredients` (`auth_is_privileged() AND auth_can_see_brand(brand_id)`) | Admin editor writes. A staff UPDATE affects 0 rows (AC-4). |
| INSERT | `privileged_insert_catalog_ingredients` | The SECURITY INVOKER RPC inserts under the caller's RLS, unchanged. |

The `permissive_policy_lint` test is unaffected because no policies are added.

### 3. API contract

**Read (PostgREST, existing embed).**
- Admin: add `eod_count_mode` to the `catalog:` embed in `fetchInventory` (`src/lib/db.ts:290`).
- Staff: add it to the `catalog:catalog_ingredients(...)` embed in `fetchItemsForVendor` (`src/screens/staff/screens/EODCount.tsx:151`).
- The value arrives as a string. Clients normalize unknown or missing values to `'cases_and_units'`.

**Update (PostgREST, existing path).** In `updateInventoryItem`'s `catalogUpdates`, map `updates.eodCountMode` to `eod_count_mode` using the omit-key-to-skip convention (`db.ts:463-474`). An invalid value fails with PostgREST 400 / `23514`. See Risk R5 for how that error is currently handled.

**Create (RPC). Decision: extend `create_inventory_item_with_catalog`. Do not add a follow-up update.**

Why the RPC:
1. **Atomic.** A follow-up `UPDATE` after the RPC is a second round-trip. If it fails, the item exists with the default mode, and `addItem`'s `.catch` (`useStore.ts:2258`) would remove the optimistic row even though the server row exists.
2. **Correct find-existing semantics.** The RPC's find-existing branch (`20260517000000:171-197`) deliberately does not overwrite catalog fields (`case_qty`, `i18n_names`, …) when the name already exists in the brand. A follow-up update cannot tell "created" from "found", so it would overwrite a brand-wide setting from a per-store create. With the RPC, mode behaves exactly like `case_qty`.
3. **Precedent.** Spec 040 threaded `p_i18n_names` the same way, and pgTAP can test the round trip.

The current overload is the **12-arg** signature from `20260517000000_user_data_i18n_names.sql:135-148`. No later migration redefines it. Grep across `supabase/migrations/` finds only that file and the original `20260504173843`. Spec 104 explicitly did not re-create it.

New signature (13 args, new param last with a default):

```
public.create_inventory_item_with_catalog(
  p_brand_id uuid, p_store_id uuid, p_name text,
  p_unit text default '', p_category text default null,
  p_case_qty numeric default 1, p_sub_unit_size numeric default 1,
  p_sub_unit_unit text default '', p_default_cost numeric default 0,
  p_default_case_price numeric default 0, p_per_store jsonb default '{}'::jsonb,
  p_i18n_names jsonb default '{}'::jsonb,
  p_eod_count_mode text default 'cases_and_units'
) returns jsonb  language plpgsql  security invoker  set search_path = public
```

- **Avoiding overload ambiguity.** First run `drop function if exists public.create_inventory_item_with_catalog(uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb);` (the exact 12-arg list), then `create or replace` the 13-arg version, both in the same transaction.
  - If both overloads existed, PostgREST would return `PGRST203` (ambiguous) for any call that omits `p_eod_count_mode`, which is every legacy caller.
  - Re-running is safe: the 12-arg drop is a no-op and `create or replace` reconciles the 13-arg version.
- **Body.** Copy it **verbatim** from `20260517000000:153-273`, with exactly three edits:
  1. Add `eod_count_mode` to the catalog `insert` column list, with value `coalesce(p_eod_count_mode, 'cases_and_units')`.
  2. The `on conflict … do update set updated_at = now()` branch stays untouched. Mode is **not** overwritten on find-existing.
  3. Add `'eod_count_mode', c.eod_count_mode` to the returned `catalog` jsonb object, so `mapItem` hydrates the created row without a refetch.
- **Error cases.**
  - Missing brand, store, or name: unchanged `P0001` raise.
  - Invalid `p_eod_count_mode` on a **new** catalog row: CHECK `23514`, which PostgREST maps to HTTP 400. `addItem` already reverts and calls `notifyBackendError('Add item', e)`.
  - Invalid value on the **find-existing** path: silently ignored, the same as every other catalog field there.
  - The client only ever sends one of the three literals.
- **Grants.**
  - `revoke all on function public.create_inventory_item_with_catalog(<13-arg list>) from public, anon;`
  - `grant execute on function … (<13-arg list>) to authenticated;`
  - Why the revoke: a freshly created function now picks up `alter default privileges … grant all on functions to anon, authenticated, service_role` (spec 097, `20260618000000:205`) as well as Postgres' implicit PUBLIC EXECUTE. The revoke matches the modern convention (`20261008000000_get_profile_emails.sql:71`).
  - This is a slight **tightening**. Today anon can EXECUTE it through PUBLIC, though RLS blocks any write. Called out for the security-auditor. service_role keeps EXECUTE through default privileges.
- **Compatibility.**
  - Old clients send 12 named args and resolve to the 13-arg function with the default. ✓
  - The pgTAP calls in `user_data_i18n_names.test.sql:265,306` use named args. ✓
  - A new client against an old DB gets `PGRST202`, but it would already fail the `fetchInventory` embed, so the ordering constraint is the same (D8).
- **PostgREST schema cache.** Supabase's `pgrst_ddl_watch` event trigger reloads the cache on DDL, including DDL run through MCP `execute_sql`. If `PGRST202 … p_eod_count_mode` shows up right after the prod apply, run `notify pgrst, 'reload schema';` once. This is a deploy step, not a code change.

### 4. Edge functions

None. No function reads or writes this column in the EOD path. `staff_submit_eod` and the admin `eod_entries` upsert are unchanged, which matches the "no server-side enforcement" decision.

### 5. Shared pure helper: `src/lib/eodCountMode.ts` (new)

The module is dependency-free: no React, no store, no supabase. It mirrors `src/lib/eodKeypad.ts`. Exact surface:

```ts
export type EodCountMode = 'cases_and_units' | 'cases_only' | 'units_only';
export const EOD_COUNT_MODES: readonly EodCountMode[];          // the 3 literals, DB CHECK order
export const DEFAULT_EOD_COUNT_MODE: EodCountMode;              // 'cases_and_units'
export function isEodCountMode(v: unknown): v is EodCountMode;
export function normalizeEodCountMode(v: unknown): EodCountMode; // unknown/missing → DEFAULT
/** AC-6. NOT (typeof caseQty === 'number' && caseQty > 1) → 'units_only' (covers null/undefined/0/1/NaN/<1);
 *  else normalizeEodCountMode(stored). */
export function effectiveEodCountMode(caseQty: number | null | undefined, stored?: unknown): EodCountMode;
export function eodBoxes(mode: EodCountMode): { cases: boolean; units: boolean };
/** AC-7 counted predicate: an ENABLED box is non-blank (trim). */
export function eodHasEntry(mode: EodCountMode, caseRaw: string | undefined, unitRaw: string | undefined): boolean;
/** AC-7 total, parseFloat + NaN→0 per enabled box: cases_and_units = c*(caseQty||1)+u (byte-identical
 *  to today), cases_only = c*(caseQty||1), units_only = u. */
export function eodTotal(mode: EodCountMode, caseQty: number | null | undefined,
                         caseRaw: string | undefined, unitRaw: string | undefined): number;
/** AC-7 entry values. null when !eodHasEntry. A disabled box → null; an enabled-but-unparseable
 *  box → null (today's NaN rule). total === eodTotal(...). */
export function eodEntryValues(mode: EodCountMode, caseQty: number | null | undefined,
                               caseRaw: string | undefined, unitRaw: string | undefined):
  { total: number; cases: number | null; units: number | null } | null;
```

- Callers resolve the mode once per item and pass the **effective** mode in.
- Admin `buildSubmission` maps `null → undefined` for `actualRemainingCases` / `actualRemainingEach`. `submitEODCount` already does `?? null` (`db.ts:1005-1006`).
- The staff builder uses `null` directly.

**Type placement.** Define `EodCountMode` in `src/lib/eodCountMode.ts`. `src/types/index.ts` re-imports it as a type, following the existing `import type { OrderChannel } from '../utils/orderChannel'` precedent at `types/index.ts:7`.

**Staff barrel.** Add a new `src/screens/staff/lib/eodCountMode.ts` that re-exports the module, using the same idiom as `src/screens/staff/lib/eodKeypad.ts`. Staff screens import only staff-local paths. Add an identity test like `src/screens/staff/lib/eodKeypad.test.ts:19-24`.

**`activeFieldFor` (AC-8/AC-9), `src/lib/eodKeypad.ts:51`:**

```ts
export function activeFieldFor(caseQty: number | undefined | null, mode?: EodCountMode | null): 'cases' | 'units'
// = effectiveEodCountMode(caseQty, mode) === 'units_only' ? 'units' : 'cases'
```

- With one argument, `effectiveEodCountMode(caseQty, undefined)` resolves to `'cases_and_units'` iff `caseQty > 1`, which is exactly today's `(caseQty ?? 0) > 1`.
- `PhoneWeeklyCount` (L161, L189) and both existing test files stay untouched.
- The staff barrel re-exports the same function, so the identity test still holds.
- `eodKeypad.ts` importing `./eodCountMode` keeps it dependency-free.

**Single resolver rule (D7).** Every surface computes a per-row mode as follows:

```
rowMode = isReadOnlyLocked ? effectiveEodCountMode(caseQty)                    // legacy layout, AC-20
                           : effectiveEodCountMode(caseQty, item.eodCountMode) // live mode
```

- "Read-only locked" means admin `isVendorLocked` (`EODCountSection.tsx:448`; `PhoneEodCount` `model.isVendorLocked`) or staff `inputsLocked` (`EODCount.tsx:356`).
- The rest-day disable is **not** a lock for this purpose. Rest-day rows still use local maps, so they use the live mode.

### 6. `src/lib/db.ts` surface

| Site | Change |
|---|---|
| `fetchInventory` select, L290 | Append `eod_count_mode` to the `catalog:` embed column list. |
| `mapItem`, L6036+ | Add `eodCountMode: normalizeEodCountMode(cat.eod_count_mode)`. Missing → `'cases_and_units'` (AC-19). Works for the RPC return too (§3 edit 3). |
| `createInventoryItem`, L363-391 | Add `p_eod_count_mode: normalizeEodCountMode(item.eodCountMode)` to the RPC args. The input type already covers the optional field through `Omit<InventoryItem,'id'\|'vendors'>`. |
| `updateInventoryItem`, L463-474 | Add `if (updates.eodCountMode !== undefined) catalogUpdates.eod_count_mode = updates.eodCountMode;`. This rides the existing `catalog_id` lookup and update with no extra round-trip, because the form always sends name/unit/caseQty too. |

Mapping: `eod_count_mode` ↔ `eodCountMode`.

**Type (`src/types/index.ts`, `InventoryItem` near L183):** `eodCountMode?: EodCountMode;`, with a doc comment for spec 171. It is **optional** on purpose: dozens of jest and typecheck:test fixtures build `InventoryItem` literals, and making it required would churn them. Readers treat `undefined` as default, which `effectiveEodCountMode` already does. `mapItem` always populates it. Leave `CatalogIngredient` unchanged; nothing in scope reads the mode from the catalog slice.

### 7. Realtime impact

- **Channel:** `brand-{id}`, through the existing `catalog_ingredients` subscription (`useRealtimeSync.ts:67`). A mode edit triggers the debounced 400 ms `loadFromSupabase`, which re-runs `fetchInventory`. The new `eodCountMode` reaches `filteredItems`, and the admin rows re-resolve, giving AC-16 on admin.
- **Publication:** **no change.** `catalog_ingredients` is already a member (`20260514140000_realtime_publication_tighten.sql`). A publication without a column list ships all columns, so ADD COLUMN needs no ALTER PUBLICATION. Spec 040 (`i18n_names`) and spec 127 (`image_path`) both added columns to this published table with no realtime restart.
- **Dev step (not a runtime concern):** after `npm run dev:db` with the new migration, the backend-developer runs one check: edit a row's `eod_count_mode` in Studio and confirm the admin worksheet reloads. If no event fires, run `docker restart supabase_realtime_imr-inventory`, the project's realtime publication gotcha, and note that it was needed.
- **Staff:** no realtime (spec 062). The mode refreshes on the vendor-list re-fetch. This is accepted in the spec's Risks.

### 8. Frontend store impact (`src/store/useStore.ts`)

No new actions, and **no code change** in `useStore.ts`.
- `updateItem` (L2276) spreads `itemUpdates` into the optimistic patch, so `eodCountMode` applies optimistically to the edited row. `db.updateInventoryItem` failure reverts through `notifyBackendError('Update item', e)` (see R5).
- `addItem` (L2210) spreads the item into the optimistic row and swaps in the RPC result, which now carries `catalog.eod_count_mode`.
- Other stores' rows with the same `catalogId` pick up the brand-level change on the next fetch or realtime event, which is the same behavior as `caseQty` today.

### 9. Surface-by-surface rules (frontend)

**Admin desktop, `src/screens/cmd/sections/EODCountSection.tsx`**
- **Mode map.** `const modeById = useMemo(() => new Map(storeInventory.map(i => [i.id, effectiveEodCountMode(i.caseQty, i.eodCountMode)])), [storeInventory])`. Build it from `storeInventory`, not `filteredItems`, because other tabs' items must resolve too.
- **`itemTotal`** (L564) becomes `eodTotal(liveMode(i), i.caseQty, caseCounts[i.id], unitCounts[i.id])`.
- **`localHasEntry`** (L588) becomes `eodHasEntry(liveModeById(id), …)`. Fallback for an id missing from the map: `'cases_and_units'`, which keeps today's either-box rule.
- **`buildSubmission`** (L705-733): filter on the mode-aware `localHasEntry`. Values come from `eodEntryValues` (`cases`/`units` `null → undefined`, `actualRemaining = total`). This gives AC-7 and AC-16(c).
- **`deriveCountedItemIds`** (L74), AC-12. Add an optional arg `effectiveModeOf?: (itemId: string) => EodCountMode | undefined`.
  - In arm (a), a case-map value counts only if `!mode || eodBoxes(mode).cases`. Units work the same way.
  - Arm (b), persisted submissions, is **unchanged**. A persisted entry is a recorded count; see N3.
  - Pass `(id) => modeById.get(id)` and add it to the memo deps.
  - Omitting the arg reproduces today's behavior byte-for-byte, so `countedOnce` / `customOrder` pass unmodified.
- **`renderEodRow`** (L869-997), AC-10/AC-11:
  - Compute `rowMode` per D7 and `const box = eodBoxes(rowMode)`.
  - CASES input: `box.cases` replaces today's `hasCase` in `value`, `editable`, `placeholder`, `color`, `backgroundColor`, the danger-border predicate, `opacity`, and the caption.
  - Under `units_only`, the case box renders exactly like today's no-case box.
  - UNITS input: when `!box.units`, set `value=''`, `editable={false}`, `placeholder='—'`, `opacity 0.5`, caption `'—'`, and **no** danger border. Otherwise it is unchanged.
  - Keep the meta line (`· case N`, `· total`) keyed on `hasCase = caseQty > 1` as today. That is display info, not input.
  - **Focus ref (AC-11):** `caseInputRefs.current[id]` gets the cases input when `box.cases`, otherwise the units input. This is equivalent to `activeFieldFor(caseQty, rowMode) === 'cases'`, and it is unchanged for `cases_and_units`.
  - In locked view (`rowMode` = legacy), values come from `submittedEntry` exactly as today (AC-20).
- The `onSubmit` gate (L795) and `countedNum` need no edits. They consume `hasEntry`, which is now mode-aware.

**Admin phone, `eod/PhoneEodCount.tsx` + `eod/PhoneKeypadSheet.tsx`**
- `PhoneEodModel` needs no interface change. `hasEntry` and `itemTotal` come from the parent, already mode-aware.
- **`CountRow`** (L488): `rowMode` per D7, where locked = `model.isVendorLocked`. Render the CS well iff `eodBoxes(rowMode).cases` and the unit well iff `.units` (AC-13).
- **`activeFieldFor(item.caseQty, item.eodCountMode)`** at L109 (pending-focus) and L152 (advance). AC-8.
- **Clamp the seated field.** In `PhoneEodCount`, derive `seatedField = sheetItem && !eodBoxes(effectiveEodCountMode(sheetItem.caseQty, sheetItem.eodCountMode))[activeField] ? activeFieldFor(sheetItem.caseQty, sheetItem.eodCountMode) : activeField`. Use `seatedField` both in `onKey` and as the sheet's `activeField` prop. Then a stale `activeField` can never write into a hidden map.
- **`PhoneKeypadSheet`:** compute `mode = effectiveEodCountMode(item.caseQty, item.eodCountMode)`. The sheet only opens unlocked (`openSheet` L116 guard), so the live mode is correct. Render wells per `eodBoxes(mode)`.
- **N1:** wells are `flex: 1`, so a lone CS well spans the row. In `CountRow`, a lone 62×48 well in place of the unit well keeps the row height. The layout holds; no style change is needed.

**Staff, `src/screens/staff/screens/EODCount.tsx` + `eod/StaffEodCountRow.tsx` + `eod/StaffKeypadSheet.tsx` + `lib/types.ts`**
- **Fetch (AC-15).** L151 select adds `eod_count_mode`. `CatalogRow` gains `eod_count_mode: string | null`. The item map adds `eodCountMode: normalizeEodCountMode(c?.eod_count_mode)`.
- `EodItem` (`lib/types.ts:32`) gains `eodCountMode?: EodCountMode`, imported as a type from `../../../types` (re-exported) or from the helper.
- `WeeklyItem` is **not** touched (out of scope).
- **`modeFor`:** `const modeFor = (it) => inputsLocked ? effectiveEodCountMode(it.caseQty) : effectiveEodCountMode(it.caseQty, it.eodCountMode)`.
- **Use `modeFor` everywhere counting happens:**
  - `isCounted` (L379): `eodHasEntry`.
  - `sheetTotal` (L389): `eodTotal`.
  - `isBlank` (L704): `!eodHasEntry`.
  - The entries builder (L734-751): `eodEntryValues` → `{ actual_remaining: total, actual_remaining_cases: cases, actual_remaining_each: units }`, skipping `null`.
  - Row `total` (L873).
- **`activeFieldFor(x.caseQty, x.eodCountMode)`** at L432 and L690. Clamp the seated field in `onKey` the same way as on admin phone.
- **`StaffEodCountRow`:** add an **optional** prop `countMode?: EodCountMode`.
  - Fallback when omitted: `hasPack ? 'cases_and_units' : 'units_only'`, so existing `StaffEodCountRow.test.tsx` arms pass unmodified.
  - CS well iff `eodBoxes(countMode).cases`. Unit well iff `.units`, so `eod-well-<id>-units` is absent under `cases_only` (AC-14).
  - `hasPack` keeps driving the "case of N" meta and the total line.
  - The orchestrator passes `countMode={modeFor(item)}`.
- **`StaffKeypadSheet`:** compute the live mode from `item` (the sheet opens unlocked only) and render wells per `eodBoxes`.
- **Seeding** (`seedFromExisting`, L444) is unchanged. On EDIT a stale disabled-box seed is ignored by the rules above, which gives AC-16 on staff.

**Editor, `src/components/cmd/IngredientForm.tsx` + `IngredientFormDrawer.tsx`**
- `IngredientFormValues` gains `eodCountMode?: EodCountMode`. It is optional so typed test fixtures don't churn. `blankValues()` seeds `'cases_and_units'`.
- **Control:** use the existing exported `SelectField` with label "EOD count" and options "Cases + units" / "Cases only" / "Units only" (hardcoded English, N6). Put it adjacent to the "units / case" `InputLine` at L1062.
- **Visibility:** render iff `Number.isFinite(parseFloat(values.caseQty)) && parseFloat(values.caseQty) > 1`. Use `parseFloat` to match `toUpdates`' `parseFloat(v.caseQty) || 1`.
- `handleCaseQtyChange` (L916) must **not** touch `eodCountMode`. That preserves the stored value per AC-17 and N2.
- **Drawer:** `fromItem` adds `eodCountMode: it.eodCountMode ?? 'cases_and_units'`, and `toUpdates` adds `eodCountMode: v.eodCountMode ?? 'cases_and_units'`.
  - The edit path goes through `updateItem`, then `catalogUpdates`. The create path goes through `addItem({...base})`, then `p_eod_count_mode`. Both reach the DB with no other drawer change (AC-18).
  - The dirty check stays correct because `initial` comes from `fromItem`.
- `JsonPreview` is unchanged.

**Count export:** unchanged (owner decision 3). It is not folded in.

### 10. N3 resolution (drafts)

Read from code:
1. **Admin draft save replaces.** `submitEODCount` (`db.ts:959-1013`) upserts the parent on `(store_id, date, vendor_id)`, then **deletes every `eod_entries` row** for the submission and inserts the new set. It does not merge.
2. **Drafts are never rehydrated into the local maps.** The local maps are session state (`EODCountSection.tsx:165-170`, "Refresh discards"). `isVendorLocked` and EDIT prefill only exist for `status === 'submitted'` (L431-448, L467). So a re-saved draft always contains exactly the current session's mode-enabled typed values.
3. **Consequence.** A draft entry whose only value sits in a now-disabled box is omitted on re-save, and its `eod_entries` row is deleted.
   - This is the **accepted consequence of decision 5**.
   - It is the same class of drop that already happens today for any draft row not re-typed after a refresh.
4. **Residual edge, documented and not fixed.** `deriveCountedItemIds` arm (b) counts **the current vendor's own** draft entries as counted, so the following sequence lets the gate pass while `buildSubmission` omits the item:
   - Save Draft with a cases value.
   - The mode flips to `units_only` (realtime).
   - Submit in the same session.

   The final submit then replaces the entries and drops that item. This is pre-existing spec-102 behavior; it also happens for any draft-only item after a refresh. AC-16(b)'s scenario uses an unsaved typed value, which the design satisfies. Making arm (b) mode-aware would change spec 102's cross-tab semantics, so it is a follow-up if the owner wants it.
5. **Staff** has no drafts. The offline queue is built at submit time, so N4 is confirmed and the queue needs no change.

### 11. Tests required (in addition to the ACs)

- **pgTAP, `supabase/tests/eod_count_mode.test.sql`:**
  - AC-1 to AC-4, plus the RPC arms:
    - (a) `p_eod_count_mode => 'units_only'` round-trips to the column and the returned `catalog.eod_count_mode`;
    - (b) omitted resolves to `'cases_and_units'`;
    - (c) `'bogus'` on a new name raises `23514`;
    - (d) the find-existing path does not overwrite an existing row's mode;
    - (e) `has_function_privilege('anon', '<13-arg>', 'execute')` is false and `authenticated` is true. Use the pattern in `public_grants_explicit.test.sql` if `has_function_privilege` misbehaves in CI.
  - Set up the staff principal the same way `staff_role_eod_rls.test.sql:121-130` does.
- **jest, backend:**
  - `src/lib/eodCountMode.test.ts`: the AC-6 matrix {null, 0, 1, 24} × {3 modes, undefined} and AC-7 per mode.
  - `src/lib/db.eodCountMode.test.ts`, mirroring `db.updateInventoryItemPrimarySwitch.test.ts`:
    - `mapItem` default and passthrough, through `fetchInventory`;
    - `updateInventoryItem` sends `eod_count_mode` only when the key is present;
    - `createInventoryItem` passes `p_eod_count_mode`.
- **jest, frontend:**
  - New `activeFieldFor` 2-arg arms in a **new** describe block in `src/lib/eodKeypad.test.ts` (existing assertions untouched).
  - Staff barrel identity for `eodCountMode`.
  - `deriveCountedItemIds` per-mode arms.
  - AC-10/11/13/14/16/17/20 render arms.

### 12. Deploy / dev order (D8)

1. Local: `npm run dev:db` (or `npx supabase db reset`). Run the realtime check from §7. Run `npm run test:db`, `npx jest`, `npm run typecheck`, `npm run typecheck:test`, and `scripts/smoke-staff-eod.sh`.
2. **Before applying to prod:** confirm prod's current `create_inventory_item_with_catalog` body matches the `20260517000000` body. Use the normalized-md5 procedure in project memory (`ebwnovzzkwhsdxkpyjka`). If it differs, stop, because the recreate would clobber undeclared prod drift.
3. **Prod apply (owner-approved, via Supabase MCP):**
   - Execute the migration SQL.
   - Insert version `20261023000000`, name `catalog_eod_count_mode`, into `supabase_migrations.schema_migrations`.
   - Verify the new function md5 and `\d catalog_ingredients`.
   - If needed, run `notify pgrst, 'reload schema'`.
4. **Then** push to `main`. Vercel ships the client after the DB, and `db-migrations-applied` stays green. Check both gates afterwards, per CLAUDE.md.
5. EAS/native builds also lag the DB, so there is no extra constraint.

### 13. Risks and tradeoffs

- **R1. Migration ordering.** If the client deploys before the DB, the admin `fetchInventory` embed and the staff vendor fetch fail (400 unknown column), which blanks the inventory and EOD lists. D8 mitigates this: apply to prod before the push. In the reverse order, old clients against the new DB are fine.
- **R2. Recreating a live RPC.** The drop and create run in one transaction, so no window exists where the function is missing. The main risk is body drift from the copy; deploy step 2 plus pgTAP (a)-(d) plus the existing `user_data_i18n_names` (4)/(5) guard it. **No 12-arg overload may survive**, otherwise every legacy call returns `PGRST203`. pgTAP should assert exactly one `pg_proc` row named `create_inventory_item_with_catalog`.
- **R3. Grant tightening on the RPC** (revoke from anon/PUBLIC) is deliberate and called out for the security-auditor. The spec-113 "ungated cost writer" finding on this RPC is **not** addressed here. The privilege posture (SECURITY INVOKER, `authenticated`) is preserved exactly. It remains a separate security spec.
- **R4. RLS gaps.** None introduced. The column is brand-level and rides existing brand-scoped policies. Staff can read the mode, which they need, and cannot write it.
- **R5. Silent catalog-update failure (pre-existing).** `updateInventoryItem` does not check the `catalog_ingredients` update's `error` (`db.ts:486-490`). A failed mode write (for example a non-privileged caller, or RLS) shows as an optimistic success with no revert, and the next fetch corrects it. This applies to every catalog field today and is **not fixed here**; see OQ-B.
- **R6. Performance.** Negligible. ADD COLUMN with a constant default does not rewrite rows. The CHECK validation scan is trivial at the seed size (143 catalog rows) and similar in prod. The embed adds one short text column per row. The helpers are O(1) per row, and the `modeById` map is O(n) per inventory change.
- **R7. Edge function cold-start:** N/A. No function is touched.
- **R8. Stale-mode edge for `caseQty <= 1`.** Today a stale cases value on an item whose `caseQty` dropped to ≤1 counts as `cases × 1`. After this spec it is ignored. That box was already non-editable, so this is consistent with decision 5 and only reachable through a mid-session `case_qty` edit.
- **R9. Parallel-dev dependency.** The frontend imports `src/lib/eodCountMode.ts` and `InventoryItem.eodCountMode`, which the backend owns (see split). The signatures in §5 and §6 are pinned. Prefer dispatching backend first. If the two run in parallel, the frontend codes against §5 and must not create or edit the helper file.

### 14. Open questions (non-blocking; default = NOT in this build)

- **OQ-A — RESOLVED / APPROVED, in scope (owner, 2026-10-23, verbatim: "Yes — include the OQ-A fix (read-only/edit prefill showing actual_remaining as units when only cases were entered) in the frontend build.").** Implemented in the frontend build; AC-20 amended above. Original note follows. The admin locked view and EDIT prefill fall back to `units = actual_remaining` whenever `actual_remaining_each` is NULL, **even when `actual_remaining_cases` is set**. Sites: `EODCountSection.tsx:495-499` (prefill), `:878-884` (locked render), and `PhoneEodCount.tsx:500-506`.
  - The staff side already does it correctly, falling back only when both are NULL (`EODCount.tsx:452-457`, spec 086 OQ-4).
  - Today, typing only cases makes the admin locked view show e.g. CASES 2 / UNITS 48. Under `'cases_only'` **every** submitted entry hits this path.
  - If the mode is later flipped back to `'cases_and_units'`, EDIT followed by re-submit double-counts (2×24 + 48).
  - The fix is a 3-site predicate change in files the frontend is already touching. It changes AC-20's "exactly as today" for those rows, so it needs PM/user sign-off. Without sign-off, the frontend-developer leaves it alone.
- **OQ-B.** Make `updateInventoryItem` throw on the catalog-update `error`, so mode/name/case_qty failures revert and toast. This is a pre-existing gap across all catalog fields and changes behavior beyond this spec. Suggest a follow-up spec.

### 15. Build split (no file overlap)

**backend-developer** (data contract + shared pure helper):
- `supabase/migrations/20261023000000_catalog_eod_count_mode.sql` (new)
- `supabase/tests/eod_count_mode.test.sql` (new)
- `src/lib/eodCountMode.ts` (new) + `src/lib/eodCountMode.test.ts` (new)
- `src/types/index.ts` (`EodCountMode` type import + `InventoryItem.eodCountMode?`)
- `src/lib/db.ts` (§6) + `src/lib/db.eodCountMode.test.ts` (new)
- Local realtime check (§7) and the prod-body md5 pre-check (§12 step 2). Prod apply only on explicit owner approval.

**frontend-developer** (all UI + keypad + staff):
- `src/lib/eodKeypad.ts` (`activeFieldFor` optional 2nd arg) + `src/lib/eodKeypad.test.ts` (new describe block only)
- `src/screens/staff/lib/eodCountMode.ts` (new barrel) + `src/screens/staff/lib/eodCountMode.test.ts` (new)
- `src/screens/cmd/sections/EODCountSection.tsx` + new/extended `__tests__` arms
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx`, `eod/PhoneKeypadSheet.tsx` + tests
- `src/screens/staff/screens/EODCount.tsx`, `eod/StaffEodCountRow.tsx`, `eod/StaffKeypadSheet.tsx`, `src/screens/staff/lib/types.ts` + tests
- `src/components/cmd/IngredientForm.tsx`, `src/components/cmd/IngredientFormDrawer.tsx` + tests

`src/store/useStore.ts` is not modified. Whichever developer finishes last sets `Status: READY_FOR_REVIEW` and merges both file lists under `## Files changed`.

### Backend implementation notes

backend-developer, 2026-10-23. Implemented per §1, §3, §5, §6 with no design deviations. `Status:` was left at `READY_FOR_BUILD` because the frontend half is still to come. Whichever developer finishes last sets `READY_FOR_REVIEW` and writes `## Files changed`.

**Files changed (backend half)**
- Migrations: `supabase/migrations/20261023000000_catalog_eod_count_mode.sql` (new). It adds the column, default, and CHECK (drop-then-add), plus the column comment. It drops the 12-arg `create_inventory_item_with_catalog` and recreates it as 13-arg with `p_eod_count_mode` last. The body is verbatim from `20260517000000` plus the three §3 edits. Grants: `revoke all … from public, anon` and `grant execute … to authenticated`.
- pgTAP: `supabase/tests/eod_count_mode.test.sql` (new). 25 assertions:
  - AC-1 to AC-3.
  - AC-4, using the staff principal `manager@local.test`. It reads through the item_vendors → inventory_items → catalog_ingredients join, sees the admin-set value, and a staff UPDATE affects 0 rows with the value unchanged.
  - RPC arms (a) to (e).
  - R2: exactly one `pg_proc` overload.
  - SECURITY INVOKER is preserved.
- Shared helper: `src/lib/eodCountMode.ts` (new). The exported surface is byte-for-byte the §5 pinned signatures. `src/lib/eodCountMode.test.ts` (new) has 41 tests covering the AC-6 matrix, AC-7 per mode, and AC-16 helper arms.
- Types: `src/types/index.ts`. `import type { EodCountMode } from '../lib/eodCountMode'` plus a re-export, following the `OrderChannel` precedent. Adds `InventoryItem.eodCountMode?: EodCountMode`.
- `src/lib/db.ts`:
  - `eod_count_mode` added to the `fetchInventory` `catalog:` embed.
  - `mapItem` sets `eodCountMode: normalizeEodCountMode(cat.eod_count_mode)`.
  - `createInventoryItem` passes `p_eod_count_mode: normalizeEodCountMode(item.eodCountMode)`.
  - `updateInventoryItem` adds an omit-key-to-skip `catalogUpdates.eod_count_mode`.
- `src/lib/db.eodCountMode.test.ts` (new). 11 tests:
  - the embed projection;
  - mapItem passthrough, the missing/null/unknown → default case, and stored ≠ effective (N2);
  - update present / absent / shares the one catalog update / per-store-only issues no catalog update;
  - create passes the mode, omitted → default, and an RPC error propagates.

**Verification (local stack only; nothing applied to prod, no `db push`)**
- `npx supabase migration up --local`: applied `20261023000000`.
- After applying:
  - exactly one overload, `(…, jsonb, jsonb, text)`, with ACL `{postgres=X, authenticated=X, service_role=X}` (no anon, no PUBLIC);
  - all 143 seed rows read `cases_and_units`.
- Re-applying the file via `psql -v ON_ERROR_STOP=1` succeeded, which confirms the idempotent re-run. The column add and 12-arg drop were NOTICE-skipped.
- `bash scripts/test-db.sh supabase/tests/eod_count_mode.test.sql`: PASS, 25 assertions.
- `npm run test:db`: `✓ 89/89 DB test file(s) passed`, exit 0.
- `npx jest`: 236/236 suites, 2901/2901 tests, exit 0.
- `npm run typecheck`: exit 0.
- `npm run typecheck:test`: exit 0.
- `bash scripts/smoke-staff-eod.sh`: `✓ all checks passed`.
- Ad-hoc supabase-js probe against local PostgREST:
  - The staff (`manager@local.test`) embed returns `eod_count_mode`.
  - The admin `catalog:` embed returns it.
  - A legacy named-arg RPC call without `p_eod_count_mode` succeeds with no PGRST203 and returns `cases_and_units`.
  - The 13-arg call with `cases_only` round-trips.
  - `'bogus'` returns `23514`.
  - An anon RPC call returns `42501`.
  - A staff UPDATE returns 0 rows.
  - Probe rows were cleaned up and the mode was reverted.
- Realtime check (§7):
  - A `postgres_changes` UPDATE on `catalog_ingredients` (filtered by id) delivered `eod_count_mode: "units_only"` **without** `docker restart supabase_realtime_imr-inventory`. The restart was NOT needed.
  - The first probe timed out because the UPDATE fired 500 ms after `SUBSCRIBED`, before the binding was live. A baseline on `inventory_items` and a re-run on `catalog_ingredients` with a 1 s delay both delivered.
  - This was a probe-timing artifact, not the publication gotcha.

**Not done (out of this lane's mandate)**
- The §12 step-2 prod-body md5 pre-check against `ebwnovzzkwhsdxkpyjka` was not run: no prod access in this run. It must run before the owner-approved prod apply.

### Frontend implementation notes

frontend-developer, 2026-10-23. Implemented §9 surface-by-surface with no design deviations, plus the owner-approved OQ-A fix. Backend-owned files (`src/lib/eodCountMode.ts`, `src/types/index.ts`, `src/lib/db.ts`, the migration, the pgTAP file) were imported as pinned and not edited.

**What landed**
- `activeFieldFor(caseQty, mode?)` (D5): `effectiveEodCountMode(caseQty, mode) === 'units_only' ? 'units' : 'cases'`. The one-arg output is unchanged (AC-9); `PhoneWeeklyCount` is untouched.
- Admin desktop (`EODCountSection.tsx`):
  - `modeById` built from `storeInventory`; `itemTotal` → `eodTotal`; `localHasEntry` → `eodHasEntry` (fallback `'cases_and_units'`); `buildSubmission` → `eodEntryValues` (`null → undefined`).
  - `deriveCountedItemIds` gains the optional `effectiveModeOf` (D6); arm (b) unchanged.
  - `renderEodRow`: `rowMode` per D7, `eodBoxes` drives both inputs (value, editable, placeholder, colors, danger border, opacity, caption) and the focus ref (AC-11). The "focused"/uncounted styling reads only the ENABLED box's value, so a stale disabled-box value cannot hide the red uncounted state (AC-16b). The meta line stays keyed on `caseQty > 1`.
  - Added `testID`s `eod-case-input-<id>` / `eod-unit-input-<id>` on the two row inputs (test + e2e hooks; no visual change).
- Admin phone (`PhoneEodCount.tsx`, `PhoneKeypadSheet.tsx`): wells per `eodBoxes(rowMode)` (row: D7; sheet: live mode). `activeFieldFor(..., item.eodCountMode)` at pending-focus and advance. The `seatedField` clamp is used both in `onKey` and as the sheet's `activeField`.
- Staff (`EODCount.tsx`, `StaffEodCountRow.tsx`, `StaffKeypadSheet.tsx`, `lib/types.ts`, new `lib/eodCountMode.ts` barrel):
  - The fetch selects `eod_count_mode`; `EodItem.eodCountMode` is normalized at fetch.
  - `modeFor` (D7 via `inputsLocked`) drives `isCounted`, `countedNum` (now derived from `isCounted`), `sheetTotal`, `isBlank`, the entry builder, and the row total.
  - The `seatedField` clamp is applied, and `activeFieldFor` gets the mode at advance and pending-focus.
  - `StaffEodCountRow` takes an optional `countMode` with the `hasPack` fallback.
- Editor (`IngredientForm.tsx`, `IngredientFormDrawer.tsx`):
  - `IngredientFormValues.eodCountMode?`; `blankValues()` seeds `'cases_and_units'`.
  - New exported `EOD_COUNT_MODE_OPTIONS` + `showEodCountModeControl(caseQty)` (parseFloat > 1).
  - The "EOD count" `SelectField` renders on its own row directly beneath the "units / case" row. That row is already 3 × 33% wide, so the control goes below it rather than inline.
  - `handleCaseQtyChange` is untouched, so the stored mode survives a case-size round-trip (N2).
  - Drawer `fromItem` / `toUpdates` carry the mode.
- OQ-A: new exported pure helper `unitsDisplayFor(entry)` in `EODCountSection.tsx`. Units fall back to `actualRemaining` only when BOTH splits are null. It is used at all three sites (desktop EDIT prefill, desktop read-only render, `PhoneEodCount` locked row). Staff was already correct and is unchanged.

**Tests added (jest)**
- `src/lib/eodKeypad.test.ts`: a new describe block for the 2-arg `activeFieldFor`. The existing assertions are untouched.
- `src/screens/staff/lib/eodCountMode.test.ts`: barrel identity.
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx` (22 tests, full-section render on desktop and phone tiers):
  - AC-12 pure arms and OQ-A `unitsDisplayFor` arms.
  - AC-10 (both modes), AC-11 (focus lands on the enabled input), AC-7 draft payload.
  - AC-16 (stale cases → units_only: disabled, total 0, uncounted, gate blocks, draft omits) plus its cases_only mirror.
  - AC-20 locked desktop (with the legacy both-null row), OQ-A EDIT prefill + UPDATE payload (no double count).
  - Phone AC-13 rows + sheet, AC-8 gate seat, seated-field clamp, AC-20 + OQ-A phone locked.
- `src/screens/staff/screens/EODCount.test.tsx`: a new describe block covering:
  - AC-15 select projection (the mock builder now records `select()` args; no existing assertion changed);
  - cases_only submit payload, the units_only gate seating UNITS, the default-mode regression;
  - AC-20 + AC-16 on staff (locked shows stored cases; EDIT makes it inert and the gate blocks).
- `StaffEodCountRow.test.tsx` / `StaffKeypadSheet.test.tsx`: AC-14 arms (`eod-well-<id>-units` absent under cases_only, and others).
- `src/components/cmd/IngredientForm.spec171.test.tsx` (AC-17) and `src/components/cmd/IngredientFormDrawer.spec171.test.tsx` (AC-18 edit/create/N2).

**Verification**
- `npx jest`: 240/240 suites, 2954/2954 tests, exit 0. `npm run typecheck`: exit 0. `npm run typecheck:test`: exit 0.
- Browser, local stack. The preview_* tools were not available in this agent run, so verification used the repo's existing Playwright install (driven from a scratchpad script, not added to the repo) against `npx expo start --web --port 8081`, logged in as admin@local.test / Towson, using Banana Pudding (`case_qty` 8):
  - **"Cases only"** was set through the ingredient form's EOD count select. The DB read `cases_only`.
    - The desktop row's UNITS input was non-editable, blank, placeholder `—`, opacity 0.5, caption `—`, with no red border.
    - Typing 3 cases gave "total 24 each", "1 of 31 items counted", and est. value $61.23.
  - **"Units only"**:
    - CASES became disabled/`—`/dimmed and UNITS editable; 5 units gave "total 5 each".
    - With Desserts filtered, SUBMIT COUNT showed the "Count every item first" toast, and `document.activeElement` was `eod-unit-input-<id>` (AC-11).
  - **Phone width** (resized to 390×844):
    - units_only: the row showed only the unit well, and the sheet showed only the unit well (`= 2 each total`).
    - cases_only: the row showed only the CS well, and the sheet showed only `CS ×8` (`= 16 each total`). The single-well layout holds (N1).
  - No console errors and no 4xx/5xx Supabase responses.
- **Restored:**
  - The mode was set back to `cases_and_units` through the form; all 143 catalog rows read `cases_and_units`.
  - `inventory_items` scalars are unchanged (`cost_per_unit` 0.510250, `case_price` 20.41, par 40).
  - The four local `audit_log` "Item edit" rows my saves created were deleted.
  - No EOD draft or submission was saved.
  - `updated_at` on the Banana Pudding catalog and item rows moved forward. The prior value was not captured.
- **Not browser-verified:** the staff app. Towson has no `order_schedule` rows locally, so the staff EOD screen renders no vendors without fixture data. Staff behavior is covered by the jest arms above.

### Review-fix round 1

Applies items 1-5 of `specs/171-eod-count-mode/reviews/release-proposal.md`, as approved by the owner. No SQL, migration, or RPC change. `Status` stays `READY_FOR_REVIEW`.

**1. Critical: `PhoneWeeklyCount` regression (code-reviewer, AC-9)**
- `PhoneKeypadSheet` gained an optional `countMode?: EodCountMode` prop, which is the effective mode.
  - When the prop is omitted, the sheet uses the legacy layout `eodBoxesFor(item.caseQty)`: both wells when caseQty > 1, otherwise units only. It ignores `item.eodCountMode`.
- `PhoneEodCount` passes `effectiveEodCountMode(sheetItem.caseQty, sheetItem.eodCountMode)`. This is the same resolution `seatedField` clamps against.
- `PhoneWeeklyCount.tsx` is unmodified, per owner decision 4.
- Regression arms were added to `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.test.tsx`. They run against a caseQty-24 item stored as `units_only`, and again as `cases_only`, with 3 tests per mode:
  - opening the row's CS well renders both sheet wells, and a digit writes through `setCaseCounts` only;
  - opening the units well renders both wells, and a digit writes through `setUnitCounts` only;
  - after a blocked submit (one-arg `activeFieldFor` puts the cursor in cases), both wells render and the keypad writes.
- Mutation check: reverting the sheet to read `item.eodCountMode` makes all 6 new arms fail. With the fix, all 6 pass.

**2. Should-fix: de-duplicated box resolution and seated-field clamp**
- `src/lib/eodKeypad.ts` (frontend-owned) gained two helpers:
  - `eodBoxesFor(caseQty, stored?)`, which is `eodBoxes(effectiveEodCountMode(...))`;
  - `clampActiveField(active, caseQty, stored?)`, which is the §9 clamp.
- `activeFieldFor`'s one-arg behavior is byte-identical: the 1-arg and 2-arg arms are unmodified and still pass.
- The staff barrel `src/screens/staff/lib/eodKeypad.ts` re-exports both helpers.
- Call sites now using the helpers:
  - `PhoneEodCount` and staff `EODCount` use `clampActiveField` for `seatedField`;
  - `PhoneKeypadSheet` (default arm) and `StaffKeypadSheet` use `eodBoxesFor`.
  - `StaffKeypadSheet` keeps the live mode: its only consumer is the staff EOD screen, so the staff weekly screen is not affected.
- Unit tests for both helpers are in the existing spec-171 describe block of `src/lib/eodKeypad.test.ts`.
- Not converted: the row sites, because they resolve a locked/live `rowMode` first and also use it for the D7 legacy layout.

**3. Should-fix: `EODCountSection.itemTotal`**
- `itemTotal` now resolves the mode through `liveModeById(i.id)`, the same path `localHasEntry` and `buildSubmission` use.
- No behavior change: every `filteredItems` row comes from `storeInventory`, which is what `modeById` is built from.

**4. Should-fix: `IngredientFormDrawer`**
- Both `'cases_and_units'` literals now use `DEFAULT_EOD_COUNT_MODE`.

**5. Nits**
- `EODCountSection.caseInputRefs`: kept the name to avoid touching the palette-focus code. The declaration comment now explains that the ref holds the first enabled input, which is the units input when the cases box is disabled.
- `EODCountSection.buildSubmission`: the `?? 0` / `v?.` dead guards are gone. The code is now a `flatMap` whose empty-array arm only narrows the type. `?? undefined` stays only for the `null` → `undefined` conversion.
- `eodKeypad.ts`: dropped the redundant `mode ?? undefined`.
- `IngredientForm.tsx`: the identity `.map` is removed and `EOD_COUNT_MODE_OPTIONS` is passed directly.
  - This required widening `SelectField`'s `options` prop from `Array<...>` to `ReadonlyArray<...>` in `src/components/cmd/SelectField.tsx`. The component only reads `options`, so this is type-only and backward compatible for every caller.
- Staff `EODCount.tsx`: removed the stale entry-builder comment, including its dead `EODCountSection.tsx` line references.
- `StaffEodCountRow.tsx`: the `counted` and `total` prop docs now describe the mode-aware semantics.
- `src/lib/db.ts:467`: added `eod_count_mode` to the catalog-level fields comment. This is a comment-only change in a backend-owned file, permitted by the owner for this one line.

**Verification**
- `npx jest`: 240/240 suites, 2967/2967 tests (was 2955; adds 6 PhoneWeeklyCount arms and 6 helper tests), exit 0.
- `npm run typecheck`: exit 0. `npm run typecheck:test`: exit 0.
- Browser, local stack:
  - Setup: preview_* tools were unavailable, so I used the repo's Playwright from a scratchpad script against `npx expo start --web --port 8081`, logged in as admin@local.test / Towson, at 390×844. The item was Banana Pudding (case_qty 8), with its mode set via local SQL.
  - **Weekly count, `units_only`:**
    - The row showed both wells.
    - Tapping CS opened the sheet with both wells (`CS ×8` and `EACH`). Typing 3, then 4 into EACH, gave `= 28 each total`.
  - **Weekly count, `cases_only`:** identical result (both wells, 28).
  - **Phone EOD (explicit-prop path):**
    - `units_only`: the row and sheet each showed only the units well (`= 2 each total`).
    - `cases_only`: only the CS well (`= 16 each total`).
  - No console errors and no 4xx/5xx Supabase responses.
- **Restored:**
  - Banana Pudding is back to `cases_and_units`; all 143 catalog rows read `cases_and_units`.
  - `updated_at` on the catalog row (17:04:15.819+00) and item row is unchanged, since catalog_ingredients has no updated_at trigger.
  - There are no new `audit_log` rows and `user_count_drafts` is empty. The typed weekly values were backspaced, and nothing was submitted or saved.
- **Still not browser-verified:** the staff app (no local `order_schedule` fixtures) and native.

## Files changed

**Backend (backend-developer)**
- `supabase/migrations/20261023000000_catalog_eod_count_mode.sql` (new)
- `supabase/tests/eod_count_mode.test.sql` (new)
- `src/lib/eodCountMode.ts` (new)
- `src/lib/eodCountMode.test.ts` (new)
- `src/types/index.ts`
- `src/lib/db.ts`
- `src/lib/db.eodCountMode.test.ts` (new)

**Frontend (frontend-developer)**
- `src/lib/eodKeypad.ts`
- `src/lib/eodKeypad.test.ts`
- `src/screens/staff/lib/eodCountMode.ts` (new)
- `src/screens/staff/lib/eodCountMode.test.ts` (new)
- `src/screens/cmd/sections/EODCountSection.tsx`
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx`
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx`
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx` (new)
- `src/screens/staff/screens/EODCount.tsx`
- `src/screens/staff/screens/EODCount.test.tsx`
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx`
- `src/screens/staff/screens/eod/StaffEodCountRow.test.tsx`
- `src/screens/staff/screens/eod/StaffKeypadSheet.tsx`
- `src/screens/staff/screens/eod/StaffKeypadSheet.test.tsx`
- `src/screens/staff/lib/types.ts`
- `src/components/cmd/IngredientForm.tsx`
- `src/components/cmd/IngredientForm.spec171.test.tsx` (new)
- `src/components/cmd/IngredientFormDrawer.tsx`
- `src/components/cmd/IngredientFormDrawer.spec171.test.tsx` (new)
- `src/screens/staff/lib/eodKeypad.ts` (review-fix round 1: re-export `eodBoxesFor` / `clampActiveField`)
- `src/components/cmd/SelectField.tsx` (review-fix round 1: `options` widened to `ReadonlyArray`)
- `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.test.tsx` (review-fix round 1: spec-171 regression arms)

**Spec**
- `specs/171-eod-count-mode.md`
