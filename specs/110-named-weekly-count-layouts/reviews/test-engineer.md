## Test report for spec 110

Spec: `specs/110-named-weekly-count-layouts.md` (named, store-shared weekly-count
layouts + admin rename). Verified against the developers' "Files changed"
section by re-running every suite myself (not trusting the reported counts)
and reading source + test files for each acceptance criterion.

### Acceptance criteria status

- **AC-1** (rename "Inventory count" → "Weekly count" / "Conteo semanal" /
  "每周盘点", byte-identical to staff `weekly.title`, keys + DB `screen` tokens
  unchanged) → **PASS** —
  `src/screens/cmd/sections/__tests__/InventoryCountSection.layouts.test.tsx::"AC-1: the section header renders the renamed \"Weekly count\" title (not \"Inventory count\")"`
  (asserts `getByText('Weekly count')` present AND `queryByText('Inventory count')` null).
  Independently verified: (a) a repo-wide grep for the three stale strings
  ("Inventory count", "Conteo de inventario", "库存盘点") across `src/i18n/*`
  returns zero hits; (b) a byte-for-byte Python comparison of
  `sidebar.items.inventoryCount` / `section.inventoryCount.title` (all 3 admin
  locales) against staff `weekly.title` (all 3 staff locales) returns exact
  match in every locale; (c) `inventoryCountKind` and `sidebar.items.inventory`
  (unrelated keys) are untouched; (d) no jest file anywhere still asserts the
  old value as present (the only other file-level hit,
  `InventoryCountSection.draft.test.tsx`, is a comment, not an assertion).

- **AC-2** (store-scoped table, ≤3 layouts/store, one shared set for both
  Weekly surfaces, server-side cap, pgTAP asserts 4th-create fails + store
  isolation) → **PASS** —
  `supabase/tests/store_count_layouts.test.sql` cases (4)/(5) (3 layouts then
  4th create → `P0001 'layout limit reached'`) and (19)/(21) (store isolation:
  Store-A-only member sees 0 Charles rows, including after a Charles row is
  seeded via RLS-bypass). Verified schema-level: `store_count_layouts` table
  exists with `position between 1 and 3` CHECK + `store_count_layouts_store_position_uq`
  unique index on `(store_id, position)` (confirmed live via `\d` on the local
  DB) — a structural belt-and-braces cap independent of the RPC, additionally
  pinned by pgTAP case (26) (`23514` on a direct 4th-slot insert).

- **AC-3** (visibility — any store member, including staff-role, can SELECT;
  non-member cannot; shared one-set-per-store unchanged) → **PASS** —
  `store_count_layouts.test.sql` cases (14) (staff-role A CAN SELECT
  Frederick's layouts) and (19)/(21) (A sees 0 Charles rows, before and after a
  Charles row exists). RLS SELECT policy confirmed live:
  `store_member_read_count_layouts USING (auth_can_see_store(store_id))` — no
  `auth_is_privileged()` gate on SELECT, matching the "any member reads" design.

- **AC-3b** (write authorization — privileged-only, server-side; staff-role
  member denied INSERT/UPDATE/DELETE via RLS/RPC, not merely UI hiding) →
  **PASS** — this is the headline ruling and it is well covered by THREE
  independent mechanisms in `store_count_layouts.test.sql`:
  - case (15): staff A calling the `save_store_count_layout` RPC directly →
    `throws_ok(..., '42501', ...)` (RPC role-gate refusal).
  - case (16): staff A issuing a **direct INSERT** (not through the RPC) →
    `throws_ok(..., '42501', ...)` (RLS WITH CHECK denial) — this is the case
    that proves the gate is not merely inside the RPC.
  - cases (17)/(18): staff A issuing direct UPDATE / DELETE of an existing
    Frederick row → 0 rows affected (RLS USING denies silently, matching the
    `user_count_orders_rls.test.sql` precedent shape).
  Live-DB confirmation: all four RLS policies verified via `pg_policies` —
  INSERT/UPDATE/DELETE all read `auth_is_privileged() AND auth_can_see_store(store_id)`;
  the three RPCs confirmed `security_definer = t`, `EXECUTE` revoked from
  `anon`/`public`, granted to `authenticated` only (via
  `has_function_privilege`). Both the RPC-authoritative path and the
  RLS-defense-in-depth path are exercised — this satisfies the spec's explicit
  demand that "a direct PostgREST/RPC call from a staff session fails."

- **AC-4** (admin authors a new layout — Save with no selection, name entry,
  appears on BOTH surfaces after reload/fresh-fetch) → **PASS** —
  jest: `InventoryCountSection.layouts.test.tsx::"AC-9: Save with NO layout
  selected opens the name modal, then creates the layout (AC-4)"` (asserts the
  modal opens, `saveStoreCountLayout` called with `storeId`, entered name, and
  `layoutId=null`, and the section refetches the authoritative list on
  success). pgTAP round-trip: cases (1)-(3) (create returns non-null id, lands
  at position 1, reads back with exact `name`+`item_ids`). The
  "appears on both surfaces" half of AC-4 is structurally guaranteed rather
  than end-to-end browser-tested: both the admin `db.ts:fetchStoreCountLayouts`
  and the staff `screens/staff/lib/countLayouts.ts:fetchStoreCountLayouts`
  query the identical table/columns with the identical RLS SELECT policy — I
  confirmed this at the source level (both do
  `.select('id,name,item_ids,position,updated_at').eq('store_id', storeId).order('position')`)
  — so "both surfaces see the same list" is a mechanical consequence of the
  shared table + shared RLS, not something requiring its own two-client
  integration test, and no `preview_*` browser tooling was available in this
  environment to drive that literally (flagged in Notes, matches the
  developer's own disclosure).

- **AC-5** (admin overwrites the selected layout — OVERWRITES `item_ids`, keeps
  name/slot, reflected on staff after reload) → **PASS** —
  jest: `InventoryCountSection.layouts.test.tsx::"AC-5: Save WITH a layout
  selected overwrites it WITHOUT a name prompt"` (asserts no modal shown, call
  args `name` preserved + `layoutId` set → overwrite, not create). pgTAP: cases
  (6)-(9) (item_ids+name replaced, position UNCHANGED at 1, row count stays 3
  — did not create a 4th row — and `updated_at` advances past a
  deliberately-back-dated `created_at`, proving last-write-wins timestamping,
  which doubles as an AC-7 pin). Source-level confirmation: `save_store_count_layout`'s
  overwrite branch explicitly does not touch `position`.

- **AC-6** (admin renames / deletes — name updates alone on rename; row +
  pill gone on delete; deleting the selected layout returns admin to Default,
  staff falls back to Default on next fetch) → **PASS** — jest:
  `"AC-6: Rename opens the modal prefilled with the layout name and calls the
  rename action"` and `"AC-6: Delete is confirm-gated and calls the delete
  action, returning to Default"` (asserts `mockConfirm` fires BEFORE the
  delete side-effect, then `deleteStoreCountLayout` called, then the Default
  pill becomes `selected: true`). pgTAP: cases (10)/(11) (rename updates name,
  leaves `item_ids` unchanged) and (12)/(13) (delete drops the count by one and
  the freed slot is reused by the next create). The staff-side "falls back to
  Default on its next fetch" half is a structural consequence (the row/pill is
  simply gone from the next `fetchStoreCountLayouts` result — no server action
  needed, as the design states) rather than its own dedicated staff test, which
  is an acceptable simplification since the staff pick-only suite already
  covers "0 layouts → Default only, no crash" as an equivalent state.

- **AC-7** (concurrency — whole-row last-write-wins by `updated_at`, no field
  merge, no lock) → **PASS** — pgTAP case (9) (`updated_at` provably later
  than a back-dated `created_at` after overwrite). The "no field merge / two
  admins editing concurrently" claim is asserted structurally (the overwrite
  UPDATE statement replaces `name`+`item_ids` wholesale with no read-then-merge
  step, verified by reading the RPC body) rather than via a true two-session
  race (the design itself calls out that a genuine concurrency race is outside
  pgTAP's single-session scope and defers the atomicity proof to the advisory
  lock + the structural unique index, which pgTAP case (26) pins). This is a
  reasonable, disclosed scope boundary, not a gap.

- **AC-8** (pick, BOTH surfaces — pill row Default + up to 3 named; Default =
  category-grouped; named = flat Custom with headers suppressed; any counter;
  RNW + native) → **PASS** — admin:
  `InventoryCountSection.layouts.test.tsx::"renders the pill row: Default + one
  pill per named layout..."`. Staff:
  `WeeklyCount.test.tsx::"AC-8: picking a named layout applies its order as a
  flat Custom view (headers suppressed)"` (asserts both rows render, category
  header disappears when a layout is picked, reappears on Default). **Native
  is NOT independently tested** — both suites run under the jsdom/RNW jest
  project; there is no native-specific test run in this repo (consistent with
  CLAUDE.md's stated native-testing gap — flagged as an existing, disclosed
  limitation, not new to this spec).

- **AC-8b** (author affordances admin-ONLY; staff pill row pick-only, no
  Save/drag/rename/delete) → **PASS** — this is the most important regression
  pin in the whole spec and it IS present:
  `WeeklyCount.test.tsx::"renders a PICK-ONLY row: Default + named pills, and
  NO save/drag/reset affordances"` explicitly asserts
  `queryByTestId('weekly-view-default')`, `weekly-view-custom`,
  `weekly-reset-order`, and `weekly-layout-save` are all `null`, while
  `weekly-save-draft` (the unrelated spec-106 button) remains present. I
  independently confirmed at the source/diff level (not just the test) that
  `WeeklyCount.tsx` no longer imports `CountOrderDragList` and no longer calls
  `fetchCountOrder`/`saveCountOrder`/`resetCountOrder` — the git diff shows the
  old toggle, drag import, and testIDs were genuinely deleted, not merely made
  unreachable. The admin side keeps `CountOrderDragList` (confirmed present) —
  matches "the drag component survives ONLY in the admin Weekly section."

- **AC-9** (Save admin-only; overwrite-vs-create-new; 3-cap client-blocked
  before server; drag persists only on Save; no Save button on staff) →
  **PASS with one minor untested affordance** —
  `"AC-9: with 3 layouts, \"Save layout\" (create path) is refused CLIENT-SIDE
  with the cap toast, no modal, no RPC"` (asserts the exact toast text `'3
  layouts max — overwrite or delete one first'`, no modal, `mockSaveLayout`
  never called) plus the AC-4/AC-5 tests above cover overwrite-vs-create. Drag
  persists only on Save: confirmed at the source level — `onReorder` sets
  local `savedIds` only; the RPC write happens exclusively inside
  `persistLayout`, called only from `onSaveLayout`/`onSaveAsNew`/`onNameSubmit`.
  Staff has no Save button: confirmed both by the negative jest assertion
  above and the source-level absence of any write helper import in
  `WeeklyCount.tsx`.
  **Minor gap:** the component wires a THIRD affordance,
  `onSaveAsNew`/`testID="inv-layout-save-as-new"` ("save as new" even when a
  layout is currently selected — distinct from plain Save's overwrite-when-
  selected behavior) — no jest test presses that specific button. The
  underlying create-path logic (client cap check + modal-then-create) is
  identical to, and indirectly exercised by, the "Save with NO layout
  selected" test, so this is a coverage gap on the AFFORDANCE WIRING only, not
  on unverified business logic. Recommend a follow-up test pressing
  `inv-layout-save-as-new` while a layout IS selected, asserting it still opens
  the create modal rather than silently overwriting. Not blocking (the
  behavior it would pin is provably identical to already-tested code), but
  flagged.

- **AC-10** (search composes with a selected layout on BOTH surfaces;
  render-only, never mutates a saved layout) → **PASS** — admin:
  `InventoryCountSection.customOrder.test.tsx::"AC-10: the name search
  composes with the custom order (survivors in custom relative order)"`
  (pre-existing spec-103 test, still valid because it exercises
  `applyCountOrder` directly — the exact function spec 110 reuses verbatim per
  design §9 — rather than UI toggle specifics that were removed). Staff:
  `WeeklyCount.test.tsx::"AC-10: search composes with the picked layout
  (matching rows in layout relative order)"` (full-render: picks the layout,
  types a search term, asserts the non-matching row disappears while the
  matching row in layout order survives). Neither test path can mutate a
  layout via search (search is a pure render filter; no write helper is
  reachable from the search input at the source level — confirmed by reading
  both screens).

- **AC-11** (submission scope + "X of N counted" + red-uncounted + gate-jump
  unchanged; submission always the full set; gate-jump follows selected
  layout's order; stale item id tolerated; no count RPC touched) → **PASS** —
  Admin: `onSubmit` in `InventoryCountSection.tsx` iterates `storeInventory`
  (confirmed at the source level, line 985), never `savedIds`/`filteredItems`;
  pinned by the pre-existing `customOrder.test.tsx` AC-9 tests. Staff:
  `WeeklyCount.test.tsx::"AC-11: the submit payload is byte-identical with
  Default and with a picked layout"` (renders twice, once Default and once
  with the layout picked, and asserts `entries` are `toEqual` across both) —
  and I independently confirmed at the source level that `onSubmit` maps over
  `items` directly, never `savedIds`. Gate-jump:
  `WeeklyCount.test.tsx::"AC-11: the gate jump targets the first uncounted in
  the PICKED layout order"` (fills the item that is NOT first in the layout
  order, submits, asserts the toast fires with the correct remaining count and
  `submitWeeklyCount` is never called) — and at the source level the gate uses
  `applyCountOrder(items, savedIds, ...)` then `firstUncounted` on the applied
  list, matching the claim. Stale-id tolerance is unchanged spec-103
  `applyCountOrder` behavior (not re-tested here, correctly deferred to the
  existing `countOrder` pure-function jest suite per the design's own §11 jest
  note). No count RPC file was touched (`submitInventoryCount`/
  `submitWeeklyCount` call sites are unchanged — confirmed via `git diff`
  showing no changes to the RPC-calling functions themselves, only to the
  order-derivation inputs feeding the render list).

- **AC-12** (all new strings in all 3 locales; admin `section.*` gets
  authoring+pick; staff `weekly.*` gets pick-only; no hardcoded English) →
  **PASS** — programmatically verified: `section.countLayout.*` has 22 keys,
  identical key sets across en/es/zh-CN, and no value in es or zh-CN is a
  byte-identical copy-paste of the English string (i.e., genuinely
  translated, not just present). `weekly.layout.*` (staff) has exactly the 2
  keys the spec predicts (`default`, `loadFailed`) — no authoring strings
  leaked into the staff catalog, matching AC-8b. Read `CountLayoutNameModal.tsx`
  end-to-end: every visible string goes through `T('section.countLayout.*')`.
  One non-blocking nit: `accessibilityLabel="Close"` on the modal's backdrop
  overlay is hardcoded English — it is a screen-reader-only label with no
  on-screen visible text, so it is arguably outside AC-12's "no user-visible
  hardcoded English" scope, but flagged for completeness.

- **AC-13** (migration DELETEs stale Weekly `user_count_orders` rows; EOD rows
  intact) → **PASS** — pgTAP case (27) seeds one `staff-weekly` row + one
  `staff-eod` row, re-runs the EXACT migration DELETE predicate, and asserts
  `'0/1'` (Weekly gone, EOD survives) — this tests the DELETE predicate's
  scoping directly rather than relying on migration-replay order, per the
  design's own recommendation. I additionally verified against the actual
  local DB state (not just the pgTAP transaction, which rolls back): querying
  `user_count_orders` directly shows 0 rows for
  `screen in ('admin-inventory','staff-weekly')` post-migration — confirming
  the migration's real DELETE statement already ran locally, not merely that
  the pgTAP replica of it works.

### Test run

**jest** — `npx jest`
```
Test Suites: 85 passed, 85 total
Tests:       948 passed, 948 total
Snapshots:   0 total
Time:        3.283 s
```
Matches the developer's claimed 948/948 across 85 suites exactly. (Pre-existing,
unrelated `act(...)` console warnings appear in `WeeklyCount.test.tsx` — these
are noise, not failures; see Notes.)

**typecheck** — both exit 0:
```
npx tsc --noEmit                       → EXIT:0
npx tsc -p tsconfig.test.json --noEmit → EXIT:0
```

**pgTAP** — `npm run test:db` (run once, sequentially, per the task's
concurrency guard):
```
✓ 63/63 DB test file(s) passed
```
`supabase/tests/store_count_layouts.test.sql` → 27/27 assertions passed,
matching `select plan(27);` — no plan/assertion-count mismatch. All other 62
pre-existing files remained green (no regression introduced elsewhere).

No purchase_orders or store_count_layouts rows were created or left behind
outside the pgTAP file's own `begin;...rollback;` framing — verified
post-run: `select count(*) from store_count_layouts` = 0,
`select count(*) from purchase_orders` = 0 (both queried, neither mutated by
me). Realtime container was NOT restarted (correctly — this migration makes
zero `supabase_realtime` publication changes, confirmed live via
`pg_publication_tables`, so the restart ritual does not apply here, matching
the spec's own explicit ABSENCE callout).

### Notes

**Shape-only / mock-heavy test assessment.** I looked specifically for tests
that mock around the behavior under test rather than exercising it:
- `src/lib/db.storeCountLayouts.test.ts` mocks `./supabase` and `./inflight` —
  this is the CORRECT boundary for this layer (it pins the db.ts→PostgREST/RPC
  translation contract: exact column selection, exact `p_*` RPC arg names,
  snake→camel mapping, throw-on-error) and does not re-test RLS/RPC business
  logic, which is properly pgTAP's job. Not a false-confidence mock.
- `InventoryCountSection.layouts.test.tsx` and `WeeklyCount.test.tsx` (spec-110
  describe block) mock only the `db.ts`/supabase I/O boundary and drive the
  REAL component tree via `@testing-library/react-native` + real testIDs +
  real state transitions (pill selection, modal open/close, confirm-gating).
  This is full-render behavior testing, not shape-only.
- The pre-existing `InventoryCountSection.customOrder.test.tsx` re-implements
  the section's filter/submission logic as standalone functions
  (`deriveFilteredItems`, `buildEntrySet`) rather than rendering the component.
  This is a pragmatic pattern already established by spec 103 for this
  specific file (the section doesn't expose these closures for direct import),
  and I verified the re-implemented logic matches the actual source
  (`storeInventory`-scoped submission, category→search→alpha filter order) —
  so it is a faithful mirror, not a divergent double that could rot silently.
  Flagging as a design note for future specs: if this file's hand-copied logic
  ever drifts from the real component's implementation, the test would keep
  passing while the real behavior regresses. Not a spec-110 regression (the
  pattern predates it) but worth the release-coordinator's awareness.

**Design §11 coverage vs. implementation.** I compared the pgTAP plan(27) case
list against the design's enumerated cases 1-12 (with sub-cases) one-for-one;
every design case has a corresponding assertion, and the implementation did
NOT skip any enumerated case. The one departure from the design's literal text
is case 12's own designer note ("the cleanest pin is a dedicated arm... testing
the DELETE predicate's scoping rather than relying on migration replay order")
— the developer followed that exact recommended shape, not a shortcut.

**Coverage gap (non-blocking, flagged above under AC-9).** The
`inv-layout-save-as-new` button (a third Save-adjacent affordance distinct
from plain Save) has no direct jest assertion pressing it. The code path it
triggers is logically identical to, and indirectly verified by, the
already-tested "Save with no layout selected" create path, so I am not
treating this as a FAIL or NOT TESTED — it's an affordance-WIRING gap on
otherwise-verified logic. Recommend the frontend-developer or a follow-up test
pass add one assertion: press `inv-layout-save-as-new` WHILE a layout is
selected and confirm it opens the create modal (not an overwrite).

**Accessibility-label nit (non-blocking).** `CountLayoutNameModal.tsx`'s
backdrop `accessibilityLabel="Close"` is hardcoded English with no visible
on-screen text — arguably outside AC-12's "user-visible hardcoded English"
scope (screen-reader-only), but flagged for i18n completeness in a future
pass.

**No new test framework introduced.** All new tests land in the existing three
tracks (jest / pgTAP / — no shell smokes were needed or added, matching the
design's own "shell smoke: none anticipated"). No vitest/playwright/CI-workflow
changes were made or needed.

**Prod-apply is correctly flagged, not yet my concern to verify against prod.**
The migration is applied + recorded in the LOCAL `schema_migrations` table
(confirmed: `20260706000000` present). Per the developer's own handoff and
project memory ("Prod migration via Supabase MCP"), the prod-apply is a
separate, explicitly-flagged step the developer did not perform themselves —
this is out of scope for a test-engineer review of local test coverage, but
the release-coordinator should confirm the prod-apply + `db-migrations-applied.yml`
green-run happens before or alongside a SHIP_READY recommendation, per the
CLAUDE.md CI-status-check hard rule.

**Native testing gap (pre-existing, not new to this spec).** AC-8 explicitly
requires "works on react-native-web (Vercel) AND native (EAS)." All tests run
under the jsdom/RNW jest project; there is no native-specific test harness in
this repo (consistent with CLAUDE.md's stated gap: "Native testing is harder
and not yet set up"). Not a spec-110-specific regression, but the AC's native
half is unverified by automated test — surfaced per the standard house rule
for cross-platform ACs.

### Summary

13 acceptance criteria (AC-1 through AC-13). **13 PASS, 0 FAIL, 0 NOT TESTED.**
One minor non-blocking coverage gap (Save-as-new button wiring) and one minor
non-blocking i18n nit (accessibility label) are noted above but do not rise to
a Critical finding — the underlying business logic they'd pin is otherwise
verified. Full jest (948/948, 85 suites), both typechecks (exit 0), and full
pgTAP (63/63 files, including the new 27/27-assertion `store_count_layouts.test.sql`)
all match the developers' claims exactly, verified by my own independent run.

## Resolution (main Claude, post-review fix pass — 2026-07-04)

Both non-blocking minors addressed:
- **Save-as-new press-test** added to
  `InventoryCountSection.layouts.test.tsx` — presses `inv-layout-save-as-new`
  with a layout selected, asserts the modal opens EMPTY and the save action is
  called with `layoutId null` (create, not overwrite).
- **Hardcoded a11y label** — the modal backdrop now uses `T('common.close')`
  (existing key, translated es/zh-CN).

Additionally (from the parallel code/security reviews, affecting counts):
pgTAP plan 27 → 30 (SF-1 oracle pins 18b/c/d) and jest 948 → 950 (save-as-new
+ the SF-1 category-drag gate pin). All suites re-run green: jest 950/950,
both typechecks exit 0, pgTAP 63/63 files.
