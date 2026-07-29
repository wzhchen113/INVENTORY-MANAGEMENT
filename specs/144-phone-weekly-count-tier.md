# Spec 144: Phone tier for the Inventory count (weekly) screen

Status: READY_FOR_REVIEW

> Next increment of the admin-console phone-optimization program (specs 140/142/143)
> driven by the external design handoff (`design_handoff_imr_phone`, README §4
> "Inventory count / weekly (P1)"). Spec 140 delivered the phone EOD-count tier +
> the keypad-sheet idiom; spec 142 the global chrome + list/detail sections; spec
> 143 the Ordering tier. This spec covers the **Inventory count (weekly)** screen:
> the desktop count worksheet (a `ScrollView` that mounts every row, plus the
> spec-139 export toolbar and the spec-110 layout authoring) becomes a
> full-screen, thumb-first, keypad-driven worksheet across ALL store items grouped
> by category, virtualized in a `FlatList`, with a per-row system-variance line and
> its own all-counted submit gate. Frontend-only, presentation-layer, gated on
> `useIsPhone()`; no backend / migration / edge-function / `src/lib/db.ts` change.

## Scope (design handoff README §4)

Behind `if (isPhone) return <PhoneWeeklyCount model={…}/>` placed AFTER all hooks
in `InventoryCountSection.tsx` (desktop + tablet byte-unchanged, AC-REG):

- **Header:** title ("Weekly count") + "WEEKLY · WK n" badge (ISO week, same
  formula as the EOD day strip).
- **Progress row:** "N OF M COUNTED" caption + right status ("N LEFT" warn /
  "READY" ok / "SENT ✓" while submitting) + a 3px accent bar.
- **Export chip row:** ↓ CSV · ↓ PDF · ◎ {lang} ▾. CSV/PDF reuse the spec-139
  `onExportCsv` / `onExportPdf` handlers verbatim (cross-platform — web print
  dialog + native share; NOT desktop-only, so no honest-toast stub needed). The
  ◎ chip cycles the EXPORT-scoped locale EN → ES → 中文 → EN (`nextExportLocale`),
  localizing the next export only — never the app-wide UI language.
- **Grouped count rows (FlatList, virtualized — 143 items):** a single flat feed
  of `GroupCaption` headers ("{category} · {n} ITEMS", category asc) interleaved
  with count rows (name asc within). Each row = 20×20 counted indicator square +
  full-width name + meta line ("{unit} · case {cq} · sys {stock}") + two 62×48
  wells (CS ×{cq} only when caseQty > 1, plus the unit well). Tapping a well opens
  the keypad sheet on that field.
- **Variance line (once counted):** "✓ MATCHES SYSTEM" (ok) when the counted total
  equals the system on-hand within 0.01; else "{±diff} {unit} VS SYSTEM" — warn,
  escalating to **danger past ±15%** (`|diff| / max(1, sys) > 0.15`, strict). Pure
  classifier `weeklyVariance` mirrors the prototype 1:1.
- **Submit bar (own gate):** in-flow "SUBMIT WEEKLY COUNT". Gate = EVERY item
  counted (stricter than the desktop's ≥1-entry gate — matches the prototype); a
  blocked press toasts the remainder and seats the keypad on the first uncounted
  item. When ready it calls the parent's real `onSubmit` (which submits every
  non-blank entry and clears the form — the honest backend path, reused verbatim).
- **Keypad sheet:** the EOD `PhoneKeypadSheet`, byte-for-byte contract — NEXT
  advances to the next-uncounted with wraparound (→ DONE ✓ + toast when none
  remain), SKIP, auto-select the cases field when caseQty > 1, max 5 chars / one
  dot, 0 is a valid count.

## Reuse (no new primitives, no forked logic)

`useCmdColors()` / `CmdRadius` / `PhoneType` / `mono()`; `GroupCaption`
(`PhoneWidgets`); `PhoneKeypadSheet` (`../eod`); the pure keypad helpers
`appendKeypadDigit` / `activeFieldFor` / `advanceUncounted` (`lib/eodKeypad`) +
`firstUncounted` (`lib/countOrder`); `formatQty` (`utils/formatQty`). The count
state (`caseCounts` / `unitCounts` / `itemNotes` + setters), the counters
(`nonBlankCount` / `totalItems` / `hasNegative`), the submit handler (`onSubmit`),
and the spec-139 export handlers all live in `InventoryCountSection` and are
passed down in a `model` bundle — exactly the PhoneEodCount lift pattern (no new
store fields, no direct DB access). The weekly count is a **separate entry
keyspace from EOD** by construction: these maps are `InventoryCountSection`'s own
React state, disjoint from `EODCountSection`'s.

## Acceptance

- Full category + item names (flex:1, ellipsize only past full width); no
  sideways/stacked text; no horizontal scroll; every tappable ≥44×44 (wells 62×48,
  export chips 44 tall, submit 48); both themes via tokens only.
- Desktop (≥1100px) + tablet (768–1099px) render output byte-unchanged (AC-REG):
  the guard + a `useIsPhone()` read + the `PhoneWeeklyCount` import + one `wkNum`
  memo + collapsing the former inline `isPhone ? …` squeeze ternaries to their
  (already-active) desktop-branch constants are the only edits to
  `InventoryCountSection.tsx`; the desktop return subtree is untouched.
- `npx tsc --noEmit` clean; full `npx jest` green (1583 tests); web bundle
  compiles via Metro (15.9 MB; the `PhoneWeeklyCount ↔ InventoryCountSection`
  cycle resolves — both directions exercised by jest + the web bundle).

## Deviations / notes

- **Stricter submit gate than desktop.** Desktop submits any non-blank subset;
  the phone gate requires ALL items counted and toasts the remainder, per README
  §4 ("Own submit gate") and the prototype (`if (wLeft > 0) { toast…; return; }`).
  Deliberate, phone-only; desktop unchanged.
- **No persistent "submitted / locked" banner.** The prototype shows a sticky
  SUBMITTED ✓ block, but the real desktop `onSubmit` CLEARS the form for a fresh
  count (there is no locked weekly-count state in the store). Reusing the honest
  handler over faking a lock, the phone tier likewise clears + toasts on submit.
- **Cases well only when caseQty > 1** (EOD's established row machinery, which the
  task mandates reusing) rather than the prototype's always-both-wells; the keypad
  auto-select already keys on caseQty > 1, so a "CS ×1" well would be dead weight.
- **Category grouping only** (no category chip / search / layout-authoring on
  phone). Those are desktop chrome (Hard Rule 4); the phone worksheet is count +
  export, grouped by category over the full store inventory.
- **`groupItems` is plural-only** ("{count} ITEMS") for all counts — a minor copy
  simplification vs the prototype's 1-ITEM singular; noted for parity review.

## Tests (jest track only — no DB/edge change)

- `phone/__tests__/PhoneWeeklyCount.test.tsx` — category grouping + GroupCaption
  counts; variance line (matches / signed shortfall / absent-when-uncounted) + the
  pure `weeklyVariance` ±15% danger boundary (23/20 = 0.15 → warn, 23.01/20 →
  danger); the own submit gate (blocked → toast, onSubmit not called; ready →
  onSubmit); keypad write-through (open well → digit → the correct entry setter's
  updater appends) incl. caseQty>1 auto-select; the ◎ export-locale cycle.
- `phone/__tests__/PhoneWeeklyCount.acReg.test.tsx` — desktop + tablet render the
  desktop `count.tsx` TabStrip tree, not the phone component; phone renders it and
  drops the tab strip. Mirrors `PhoneOrdering.acReg.test.tsx`.
- The four existing `InventoryCountSection*.test.tsx` suites gained the
  desktop-forcing `theme/breakpoints` mock (jest's non-web `Platform.OS` makes
  `useIsPhone()` true, which now routes to `PhoneWeeklyCount`).

## Files changed

### New
- src/screens/cmd/sections/phone/PhoneWeeklyCount.tsx
- src/screens/cmd/sections/phone/weeklyVariance.ts
- src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.acReg.test.tsx
- specs/144-phone-weekly-count-tier.md

### Modified — host section (guard + model lift; desktop/tablet byte-unchanged)
- src/screens/cmd/sections/InventoryCountSection.tsx  (isPhone guard →
  PhoneWeeklyCount; `wkNum` memo; inline `isPhone ? …` squeeze ternaries collapsed
  to their desktop-branch constants)

### Modified — i18n (all three catalogs, parity kept)
- src/i18n/en.json / es.json / zh-CN.json  (section.inventoryCount.phone.weekBadge,
  submitWeekly, matchesSystem, vsSystem, uncountedRemain, groupItems)

### Modified — existing tests (force desktop tier for the new isPhone fork)
- src/screens/cmd/sections/__tests__/InventoryCountSection.customOrder.test.tsx
- src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx
- src/screens/cmd/sections/__tests__/InventoryCountSection.layouts.test.tsx
- src/screens/cmd/sections/__tests__/InventoryCountSection.parStatus.test.tsx

## Handoff

next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of this spec. Each reviewer writes its findings
  to specs/144-phone-weekly-count-tier/reviews/<your-name>.md.
payload_paths:
  - specs/144-phone-weekly-count-tier.md
  - src/screens/cmd/sections/phone/PhoneWeeklyCount.tsx
  - src/screens/cmd/sections/phone/weeklyVariance.ts
  - src/screens/cmd/sections/InventoryCountSection.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.acReg.test.tsx
  - src/i18n/en.json
  - src/i18n/es.json
  - src/i18n/zh-CN.json
