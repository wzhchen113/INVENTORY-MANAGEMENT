# Spec 134: PO order-lines — order in cases, not units

Status: READY_FOR_REVIEW

> **Owner request (verbatim):** "i need it the order to be cases, if more than
> one unit in one case, only do units if 1 unit = 1 case."
>
> Screenshot context: the Purchase-order detail screen's order-lines table.
> The owner mentally orders in CASES (e.g. French Fries 84 units at 6/case =
> 14 cases) but the table shows and edits the ORDERED column in base units.

## User story

As a **store manager (admin Cmd UI)**, on a Purchase-order's order-lines
table I want each line whose item comes more than one to a case to show AND
let me edit the ordered quantity in **cases** (with the units-per-case shown
the way the count screens already show "× N"), and its price column to show
the **case price**, so I order the way the vendor's boxes actually ship —
while items that are exactly one unit per case keep showing units. The line
total and the order subtotal must not change (the underlying math is the
same either way).

## Background (grounded this session)

- The order-lines table lives in
  [`src/screens/cmd/sections/POsSection.tsx`](../src/screens/cmd/sections/POsSection.tsx)
  (the spec-107 loop). Each row renders `li.orderedQty` in **base/counted
  units** — editable via a `TextInput` on a draft
  (`POsSection.tsx:605-626`), read-only otherwise — with UNIT $ =
  `li.costPerUnit` (`:630-632`) and LINE $ = `li.orderedQty * li.costPerUnit`
  (`:633-635`). The subtotal (`:117`) sums `orderedQty * costPerUnit`.
- `PoLine` already carries everything needed with **no new fetch**
  ([`db.ts:1511-1536`](../src/lib/db.ts)): `orderedQty` (base units),
  `costPerUnit` (per-COUNTED-unit snapshot, spec-107 OQ-6 — NOT per-each),
  `caseQty` (catalog `case_qty`; **1 when null / no case size**),
  `subUnitSize`, `unit`.
- The edit write path already stores base units:
  `updatePoLineQty(poId, poItemId, orderedQty)`
  ([`useStore.ts:2707-2724`](../src/store/useStore.ts)) → `db.updatePoItemQty`.
  So an edit expressed in cases is written as `cases × caseQty` base units;
  **no schema change, no `po_items.ordered_qty` semantics change.**
- The math is invariant. For a case item: `casePrice = costPerUnit × caseQty`
  and `cases = orderedQty / caseQty`, so
  `cases × casePrice = orderedQty × costPerUnit` — LINE $ and the subtotal are
  byte-identical whether computed in units or cases. This is a **display +
  edit-unit conversion only.**
- The quick-order paste block already converts to whole cases via the shared
  `computePoQuickOrderLines` / `buildPoQuickOrderText`
  ([`src/utils/poQuickOrderText.ts`](../src/utils/poQuickOrderText.ts)) and is
  **not changed by this spec** (stated in Out of scope).
- Draft PO lines are seeded from reorder `suggestedUnits`
  (`useStore.ts:2759`; `ReorderSection.tsx:347`), which is normally a
  whole-case multiple — but not guaranteed for every line (par-based or
  shared multi-vendor items), so the non-whole-case display case is real and
  handled (see AC-5).

## Acceptance criteria

- [ ] **AC-1 (case rows show cases).** For a line whose `caseQty > 1`, the
      ORDERED column shows the quantity in cases — `orderedQty / caseQty` —
      with a units-per-case sub-caption in the count-screen "× N" idiom
      (e.g. `14 cs` with a `× 6 / case` sub-line). For a line whose
      `caseQty <= 1` (1 unit = 1 case, or no case size), the ORDERED column is
      **unchanged** — it shows base units exactly as today (`li.orderedQty
      li.unit`).
- [ ] **AC-2 (case rows edit in cases, on a draft).** On a `draft` PO, the
      editable ORDERED cell for a `caseQty > 1` line accepts a **cases** value;
      committing writes `round(cases) × caseQty` base units through the
      existing `updatePoLineQty` → `db.updatePoItemQty` path
      (`po_items.ordered_qty` stays base units). A `caseQty <= 1` line edits in
      units exactly as today. The commit only fires a write when the resulting
      **base-unit** quantity differs from the stored `orderedQty` (so an
      untouched line — including an untouched fractional-case line — is never
      rewritten; see AC-5).
- [ ] **AC-3 (case price in the price column).** For a `caseQty > 1` line, the
      per-unit price column ("UNIT $") shows the **case price**
      `costPerUnit × caseQty`, labelled so the operator can tell it is a case
      price (e.g. a `/cs` suffix or the column caption reflecting case rows).
      A `caseQty <= 1` line shows `costPerUnit` as today.
- [ ] **AC-4 (LINE $ and subtotal unchanged).** The LINE $ per row and the
      order subtotal render the **same dollar values as before this spec**
      for every PO — proven by the identity `cases × casePrice = orderedQty ×
      costPerUnit`. No change to the subtotal computation input
      (`POsSection.tsx:117`) is required beyond it remaining base-unit-correct.
- [ ] **AC-5 (fractional cases — display exact, never silently corrupt).**
      When `orderedQty` is not an exact multiple of `caseQty` (e.g. 85 units
      at 6/case = 14.17 cs), the ORDERED cell shows the **exact decimal**
      case value (up to 2 dp; whole values show clean with no decimals). The
      value is NOT rounded for display. Because the AC-2 write-diff guard
      compares in base units, a fractional line the operator does not touch is
      never rewritten; a fractional line the operator DOES edit writes the
      whole-case product they typed. (Owner-flagged fork OQ-1 — see below.)
- [ ] **AC-6 (mixed table reads cleanly).** A PO whose lines mix `caseQty > 1`
      and `caseQty <= 1` items renders both row kinds in the same table
      without misalignment: case rows read in cases (+ "× N" sub-caption),
      unit rows read in units, and the column headers/subtotal row stay
      aligned to the existing fixed column widths (`:574-580`, `:648-669`).
- [ ] **AC-7 (i18n ×3).** Every new user-visible string — the "× N / case"
      sub-caption, the case-price `/cs` label, and any changed/added column
      caption — exists in en / es / zh-CN in the admin catalog
      (`src/i18n/*.json`, via `useT`). No hardcoded English on the surface.
- [ ] **AC-8 (tests — jest).** A pure conversion helper (units⇄cases display +
      the edit write-back `cases → base units`) is unit-tested: `caseQty=6`,
      `orderedQty=84` → `14` cases display and an edit of `13` writes `78`;
      `caseQty=6`, `orderedQty=85` → `14.17` display (exact, not rounded) and
      an untouched line issues NO write; `caseQty=1` → units verbatim, no case
      treatment; case price `costPerUnit × caseQty` and LINE $ identity hold.

## In scope

- The ORDERED column display + inline-edit unit switch (cases for `caseQty >
  1`, units for `caseQty <= 1`) on the `POsSection` order-lines table,
  including the "× N / case" sub-caption.
- The price column showing case price for `caseQty > 1` lines, labelled.
- A small pure helper for the units⇄cases display + edit write-back
  conversion, jest-covered (AC-8).
- i18n ×3 for the new/changed strings.

## Out of scope (explicitly)

- **Storage / schema change.** `po_items.ordered_qty` and
  `po_items.cost_per_unit` keep their current base-unit / per-counted-unit
  meanings. **No migration.** Rationale: this is display + edit-unit only; the
  identity in AC-4 makes storage untouched sufficient.
- **The RECEIVED column and the PO-driven receiving flow** (spec 105/113/121).
  RECEIVED stays in units in this spec. Rationale: keeps the slice tight;
  partial receives are frequently non-whole-case and have their own screens —
  a case display there is a clean follow-up. (Owner-flagged fork OQ-2 — see
  below.)
- **The quick-order paste block / share text.** `poQuickOrderText.ts`
  (`computePoQuickOrderLines` / `buildPoQuickOrderText`) already ceil-converts
  to whole cases and is untouched. Rationale: it is already case-based; this
  spec only aligns the on-screen table with that mental model.
- **The human-readable spec-108 Share (`poShareText.ts`).** Untouched — it is
  a person-readable message and correctly shows `qty × unit`.
- **Reorder-card / PO-create quantities.** `suggestedUnits → orderedQty`
  seeding (`useStore.ts:2759`) is unchanged; this spec only changes how an
  existing line's stored base-unit qty is displayed and edited.
- **Changing the base-unit meaning of any edit.** Editing a `caseQty > 1`
  line still resolves to a base-unit write; the DB never learns about "cases."
- **`app.json` slug / identity drift / repo-root spreadsheet** — untouched
  (CLAUDE.md DO-NOT-AUTO-FIX).

## Open questions resolved

Both forks are resolved with the PM-recommended default and **flagged for the
owner** (owner accepts unless they redirect — the interactive question tool
was unavailable in this session, so the defaults are recorded here for the
owner to confirm during review).

- **OQ-1 [FLAGGED] — fractional-case display + edit semantics.** → **Display
  the exact decimal (e.g. 14.17 cs), edits write `round(cases) × caseQty`
  base units, and the write only fires when the resulting base-unit qty
  differs from stored (so an untouched fractional line is never silently
  rounded 85→84).** Rationale: whole-case lines (the common case, seeded from
  reorder cases) show clean; the rare fractional line shows the truth instead
  of a misleading whole number, and the base-unit write-diff guard prevents
  silent corruption. Alternative the owner may prefer: add a subtle "not a
  whole case" hint on fractional lines, or ceil-to-whole display (rejected —
  overstates vs stored and drifts LINE $ from the true stored total).
- **OQ-2 [FLAGGED] — received / receiving in cases now or follow-up?** →
  **Follow-up; RECEIVED stays in units in this spec.** Rationale: keeps the
  change to exactly what the owner asked (the ORDERED column) and avoids the
  fractional-partial-receive edge surface. Owner may pull it forward.

## Dependencies

- **Spec 107 (live) — the PO loop + `PoLine` shape.** `PoLine.caseQty`,
  `PoLine.costPerUnit` (per-counted-unit, OQ-6), `PoLine.orderedQty`
  ([`db.ts:1511-1536`](../src/lib/db.ts)); the order-lines table + the
  editable-cell path in
  [`POsSection.tsx`](../src/screens/cmd/sections/POsSection.tsx); the write
  path `updatePoLineQty` → `db.updatePoItemQty`
  ([`useStore.ts:2707-2724`](../src/store/useStore.ts)).
- **Spec 104 (live) — cost basis.** `costPerUnit` is per-each on
  `inventory_items`, but the PO-line snapshot `PoLine.costPerUnit` is already
  the **per-counted-unit** value, so case price = `costPerUnit × caseQty`
  needs no extra `× subUnitSize` bridge here.
- **Spec 114/115 (live) — the case-conversion precedent** in
  `poQuickOrderText.ts` (`ceil(orderedQty / coalesce(caseQty,1))`). This spec
  reuses the same `coalesce(caseQty, 1)` divide-safety but displays an exact
  (non-ceil) value on-screen and does NOT touch that builder.
- **i18n catalogs** — `src/i18n/{en,es,zh-CN}.json` `section.purchaseOrders.*`
  — new sub-caption / case-price / column-label keys ×3.
- **No migration. No edge function. No RPC.**

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI only — `POsSection` order-lines
  table. No legacy admin surface (spec 025 deleted it). No new section.
- **Which app:** this repo (admin). Staff app not touched (staff receiving is
  a separate surface, spec 113). Customer PWA unaffected.
- **Per-store or admin-global:** per-store — POs are store-scoped via
  `auth_can_see_store()`; this is a pure display/edit change over data the
  operator already sees. No RLS impact.
- **Edge function or PostgREST:** neither new — edits ride the existing
  `db.updatePoItemQty` PostgREST update. No RPC, no edge function.
- **Realtime channels touched:** none new. Edits already replay on
  `store-{id}` via the existing `po_items` write path; no publication change,
  so **no** `docker restart supabase_realtime` step.
- **Migrations needed:** **no.** Display + edit-unit only; storage semantics
  unchanged (the AC-4 identity is why).
- **Edge functions touched:** none.
- **Web/native scope:** both (web Vercel + native EAS). Plain RN `View`/`Text`/
  `TextInput` — no web-only API.
- **Tests (spec 022 tracks):** **jest** only — a pure units⇄cases display +
  edit-write-back conversion helper (AC-8). No pgTAP (no DB change), no shell
  smoke (no RPC/edge round-trip).
- **app.json slug:** untouched — no build-identifier / store-listing / push
  bearing. `slug` stays `towson-inventory` (load-bearing, do-not-auto-fix).

## Backend design

**Confirmed: frontend-only.** No migration, no RPC, no edge function, no RLS
change, no realtime publication change. The AC-4 identity means storage
(`po_items.ordered_qty` = base units, `po_items.cost_per_unit` =
per-counted-unit) is untouched and sufficient. The write path
`updatePoLineQty(poId, poItemId, orderedQty)` → `db.updatePoItemQty`
([useStore.ts:2707](../src/store/useStore.ts),
[db.ts](../src/lib/db.ts)) keeps its base-unit contract; the component
converts cases → base before calling it. `PoLine.caseQty` /
`PoLine.costPerUnit` / `PoLine.orderedQty` already ride the existing fetch
([db.ts:1511-1536](../src/lib/db.ts)) — no fetch, no `mapPoItemRow` change.

Because there is no data-model / RLS / API-contract / edge-function / realtime
surface, those standard headings are intentionally empty for this spec. The
whole design is the pure helper + the `POsSection` render/edit wiring + i18n.

### 1. Pure helper module (AC-8) — `src/utils/poCaseDisplay.ts`

New module, sibling to `poQuickOrderText.ts` / `formatQty.ts` (same domain,
same `src/utils` home). Follows the extract-and-pin precedent
([src/lib/eodDayStatus.ts](../src/lib/eodDayStatus.ts),
`src/lib/countOrder.ts`): PURE + total, no React, no supabase, no theme, no
i18n import; jest-covered byte-for-byte. Its ONLY import is `formatQty` from
`./formatQty` (reused for the "up to 2 dp, trailing-zeros dropped, whole =
clean" display — `85/6 → "14.17"`, `84/6 → "14"`, satisfying AC-5).

`caseQty` is normalized via a `> 1` predicate everywhere (mirrors the
`coalesce(caseQty, 1)` divide-safety of `computePoQuickOrderLines`
[poQuickOrderText.ts:146](../src/utils/poQuickOrderText.ts) and the
`(it.caseQty || 0) > 1` inventory-count precedent
[InventoryCountSection.tsx:1081](../src/screens/cmd/sections/InventoryCountSection.tsx)):
`null / 0 / 1 / <1` all mean "no case" → the row stays in units.

Signatures to pin:

```ts
export function isCaseRow(caseQty: number): boolean;
//   caseQty > 1 (NaN/null/0/1 → false → unit row).

export function poOrderedToCases(orderedQty: number, caseQty: number): number;
//   isCaseRow → orderedQty / caseQty (EXACT, NOT rounded — AC-5); else orderedQty.

export function poCasesToBase(cases: number, caseQty: number): number;
//   isCaseRow → Math.round(cases) * caseQty (AC-2 whole-case write);
//   else cases verbatim (unit rows keep today's raw-number write, incl. fractional units).

export function poCasePrice(costPerUnit: number, caseQty: number): number;
//   isCaseRow → costPerUnit * caseQty (AC-3); else costPerUnit.
//   costPerUnit is per-COUNTED-unit (spec-107 OQ-6) — NO ×subUnitSize bridge (spec-104 dep).

export function poOrderedDisplay(orderedQty: number, caseQty: number): string;
//   formatQty(poOrderedToCases(orderedQty, caseQty)) — the seed for the TextInput
//   defaultValue AND the read-only number. "14", "14.17", etc.

export function poResolveEdit(
  rawText: string,
  orderedQty: number,
  caseQty: number,
): { write: boolean; base: number };
//   The load-bearing write-diff guard (AC-2 / AC-5). See §3.
```

### 2. Display treatment — pinned (AC-1/3/6)

The order-lines table has FIXED column widths — ORDERED `width:100`,
RECEIVED `width:90`, UNIT $ `width:80`, LINE $ `width:90`, name `flex:1`,
draft delete `width:28`
([POsSection.tsx:574-580, 648-669](../src/screens/cmd/sections/POsSection.tsx)).
**Column headers and widths do NOT change** (no `orderedCol` / `unitCol`
caption change — rows self-describe), so the header row and the subtotal
spacer row stay byte-aligned (AC-6). New per-row text lives as sub-captions
INSIDE the existing fixed cells, not as new columns.

- **ORDERED cell (width 100).**
  - `isCaseRow` read-only (`:622-626`): replace `{li.orderedQty} {li.unit}`
    with `{poOrderedDisplay(...)} {casesUnit}` (e.g. `14.17 cs`) plus a
    second `<Text>` sub-caption below it in the count-screen "× N" idiom —
    `× {caseQty} / case` — at `fontSize ~9`, `color: C.fg3` (mirrors
    [InventoryCountSection.tsx:1136](../src/screens/cmd/sections/InventoryCountSection.tsx)
    `× ${it.caseQty}`). Wrap the two Texts in a right-aligned `View` so the
    fixed width holds.
  - `isCaseRow` editable draft (`:605-621`): `TextInput` `defaultValue` =
    `poOrderedDisplay(...)`, `keyboardType="numeric"`, with the same
    `× {caseQty} / case` sub-caption beneath the input inside the width-100
    cell.
  - Non-case rows (`caseQty <= 1`): UNCHANGED — read-only shows
    `{li.orderedQty} {li.unit}`; editable seeds `String(li.orderedQty)`.
- **UNIT $ cell (width 80, `:630-632`).**
  - `isCaseRow`: `$${poCasePrice(li.costPerUnit, li.caseQty).toFixed(2)}`
    plus a `/cs` sub-caption (or inline suffix) `fontSize ~9`, `color: C.fg3`
    so the operator can tell it is a case price (AC-3). Width 80 is tight —
    prefer the sub-caption line over an inline suffix.
  - Non-case rows: UNCHANGED — `$${li.costPerUnit.toFixed(2)}`.
- **LINE $ (width 90, `:633-635`) and subtotal (`:117`, `:665-667`): DO NOT
  TOUCH.** They stay `orderedQty * costPerUnit`. AC-4 holds because LINE $ is
  computed from the STORED base, never from the displayed cases value — so a
  fractional display line (14.17 cs) still bills the true `85 × costPerUnit`,
  no drift. Do NOT "helpfully" recompute LINE $ as `cases × casePrice`.

### 3. Edit write-back + the fractional guard (AC-2 / AC-5, OQ-1) — REPLACES `n === li.orderedQty`

The current guard at
[POsSection.tsx:613](../src/screens/cmd/sections/POsSection.tsx)
(`if (!Number.isFinite(n) || n < 0 || n === li.orderedQty) return;`) is
replaced by a call into `poResolveEdit`:

```ts
onEndEditing={(e) => {
  const { write, base } = poResolveEdit(e.nativeEvent.text, li.orderedQty, li.caseQty);
  if (write) void updatePoLineQty(sel.id, li.poItemId, base);
}}
```

**Correctness note the developer MUST honor (surfaced, not silently coded
around).** AC-2 phrases the guard as "the resulting BASE-unit quantity differs
from the stored `orderedQty`." That base-vs-stored comparison is **insufficient
on its own for a fractional line** and, taken literally, re-introduces the exact
`85 → 84` corruption AC-5 forbids: the display seed is precision-lossy
(`formatQty(85/6) = "14.17"`), and `round(14.17) × 6 = 84 ≠ 85`, so a fractional
line the operator merely focuses and blurs would compute base `84`, differ from
stored `85`, and WRITE — silently rounding `85 → 84`. The base-vs-stored check
only works for whole-case and unit rows.

`poResolveEdit` therefore makes the **display-string no-op the PRIMARY guard**
(the true generalization of today's `n === li.orderedQty`, now in the row's
display unit) and keeps the base-diff as a secondary check:

```
poResolveEdit(rawText, orderedQty, caseQty):
  const trimmed = rawText.trim()
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0)          return { write: false, base: orderedQty }
  if (trimmed === poOrderedDisplay(orderedQty, caseQty)) return { write: false, base: orderedQty }  // ← untouched, incl. fractional focus+blur
  const base = poCasesToBase(n, caseQty)
  if (base === orderedQty)                    return { write: false, base }   // e.g. "14.0" vs seed "14"
  return { write: true, base }
```

This delivers the OQ-1 fork exactly as specced without changing it: fractional
lines DISPLAY the exact decimal; an edit writes `round(cases) × caseQty` base
units; an UNTOUCHED fractional line issues NO write (string-equal seed);
a fractional line the operator DOES retype writes the whole-case product. For
unit rows (`caseQty <= 1`) `poCasesToBase` is identity, so behavior is
byte-identical to today. **OQ-2 (RECEIVED stays in units) is honored — the
RECEIVED cell `:627-629` is not touched.**

Jest pins (AC-8), all against `poResolveEdit` / the pure fns — no component mount:
- `caseQty=6, orderedQty=84`: `poOrderedDisplay → "14"`; `poResolveEdit("13",84,6) → { write:true, base:78 }`; `poResolveEdit("14",84,6) → { write:false }`.
- `caseQty=6, orderedQty=85`: `poOrderedDisplay → "14.17"` (exact, not rounded); `poResolveEdit("14.17",85,6) → { write:false }` (untouched); `poResolveEdit("14",85,6) → { write:true, base:84 }`.
- `caseQty=1` (and `0`/null): `poOrderedDisplay(84,1) → "84"`, `isCaseRow → false`, `poCasesToBase(84,1) → 84`; unit rows verbatim, no case treatment.
- `poCasePrice(cpu,6) === cpu*6`; identity `cases × casePrice === orderedQty × costPerUnit` for whole-case lines.

### 4. i18n (AC-7) — three new keys ×3 catalogs

Add under `section.purchaseOrders.*` in each of `src/i18n/en.json`,
`src/i18n/es.json`, `src/i18n/zh-CN.json` (via `useT`), no hardcoded English:

| key | en | es | zh-CN |
|-----|----|----|-------|
| `perCaseCaption` | `× {count} / case` | `× {count} / caja` | `× {count} / 箱` |
| `casesUnit` | `cs` | `cj` | `箱` |
| `casePriceSuffix` | `/cs` | `/cj` | `/箱` |

No column-header caption changes (rows self-describe), so no edits to the
existing `orderedCol` / `unitCol` keys.

### 5. Store / realtime / RLS impact

- **`src/store/useStore.ts`:** unchanged. `updatePoLineQty` already takes base
  units and already runs the optimistic-then-revert + `notifyBackendError`
  pattern ([useStore.ts:2707-2724](../src/store/useStore.ts)); the component
  passes the converted `base`, so no slice or signature change.
- **`src/lib/db.ts`:** unchanged — no new helper, no `mapPoItemRow` change
  (`caseQty` already mapped, [db.ts:1535](../src/lib/db.ts)).
- **Realtime:** edits replay on the existing `store-{id}` channel via the
  `po_items` write path. No `supabase_realtime` publication change → **no**
  `docker restart supabase_realtime_imr-inventory` step.
- **RLS:** none — pure display/edit over rows the operator already sees via
  `auth_can_see_store()`.

### 6. Risks & tradeoffs

- **The AC-2/AC-5 guard tension (§3) is the one real correctness risk** — a
  base-only diff check corrupts fractional lines. Mitigated by the
  display-string primary guard in `poResolveEdit`, pinned by the untouched-
  fractional jest case. This is the single most important review checkpoint.
- **Fixed-width cells + sub-captions:** the `× N / case` and `/cs` sub-lines
  must live inside the existing width-100 / width-80 cells (right-aligned
  `View` wrappers). If they force wrap, verify against the header/subtotal
  spacer rows (AC-6) — do not widen columns (would desync `:648-669`).
- **`onEndEditing` fires on blur:** the string-equal primary guard makes a
  no-op focus+blur cheap and write-free on every row kind. No debounce needed.
- **Performance:** all helpers are O(1) pure arithmetic per row; the 286 KB
  seed's largest POs are tens of lines — negligible.
- **No edge/cold-start/migration-ordering surface** for this spec.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec. Add the pure
  `src/utils/poCaseDisplay.ts` helper (signatures + `poResolveEdit` logic in
  §1/§3) with a jest test pinning the AC-8 cases; wire the `POsSection`
  order-lines ORDERED + UNIT $ cells per §2, replacing the
  `n === li.orderedQty` guard at POsSection.tsx:613 with the `poResolveEdit`
  call in §3; leave LINE $, subtotal, and RECEIVED untouched; add the three
  i18n keys ×3 in §4. After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/134-po-order-lines-case-display.md

## Files changed

- `src/utils/poCaseDisplay.ts` (new) — pure units⇄cases helper: `isCaseRow`,
  `poOrderedToCases`, `poCasesToBase`, `poCasePrice`, `poOrderedDisplay`,
  `poResolveEdit` (display-string primary no-op guard per §3).
- `src/utils/poCaseDisplay.test.ts` (new) — jest pin of the AC-8 cases
  (whole cases 84→14, edit 13→78, fractional 85→"14.17" untouched-no-write,
  fractional retype 14→84, caseQty=1/0 unit passthrough, case-price + LINE $
  identity, §3 input-validation guard).
- `src/screens/cmd/sections/POsSection.tsx` — imported the helper; wired the
  ORDERED cell (cases display + `× N / case` sub-caption, case-aware
  `defaultValue`, `poResolveEdit` replacing the `n === li.orderedQty` guard)
  and the UNIT $ cell (case price + `/cs` sub-caption) inside the existing
  fixed column widths. LINE $, subtotal, and RECEIVED untouched.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added
  `section.purchaseOrders.perCaseCaption` / `casesUnit` / `casePriceSuffix`.

## Implementation notes

- **Verified:** `npx tsc --noEmit` (base) and `npx tsc -p tsconfig.test.json
  --noEmit` (test) both clean; full `npx jest` = 1353 passed / 124 suites,
  including the new helper suite (17) and the existing `POsSection.test.tsx`
  (unchanged — it does not pin the ORDERED cell / guard, so the guard swap is
  non-breaking).
- **Test scope note (surfaced, not silent):** the spec §3 guard is
  `n = Number(rawText.trim())`; `Number('')` is `0` (finite, non-negative), so
  an empty ORDERED field resolves to base `0` and writes — identical to the
  pre-spec `Number(raw)` behavior, unchanged by this spec. The helper test
  therefore pins only the §3-guaranteed no-write inputs (`NaN`, negative); it
  does NOT assert empty-string behavior, to avoid encoding either a footgun or
  a behavior change the design did not specify.
- **Browser verification NOT performed by the implementing agent** — the
  `preview_*` browser tools are not in this agent's tool set and browsers are
  read-tier for computer-use. Needs main-session verification: local stack
  (`admin@local.test` / `password`), and since the local DB currently has 0
  POs (but 86 catalog ingredients with `case_qty > 1`, so the path IS
  reachable), create a draft PO via Reorder for a multi-unit-case item, then
  confirm (1) the ORDERED cell reads in cases with the `× N / case`
  sub-caption, (2) UNIT $ shows the case price with `/cs`, (3) LINE $ +
  subtotal are unchanged vs base units, (4) editing in cases persists
  `po_items.ordered_qty` as `round(cases) × caseQty` base units (check the DB
  value), and (5) a focus+blur on a fractional-case line does NOT rewrite it.
