# Spec 147: Phone tier for the four shared-list-shell screens (Reconciliation / POS imports / Audit log / Reports)

Status: READY_FOR_REVIEW

> Next increment of the admin-console phone-optimization program (specs
> 140/142/143/144/145/146) driven by the external design handoff
> (`design_handoff_imr_phone`, README §7-17 "Remaining sections — shared list
> shell"). Spec 142 delivered the global chrome + the shared list/detail drill-in
> scaffold + `PhoneWidgets`; specs 143-146 the Ordering, Weekly-count, Dashboard,
> and Users tiers. This spec covers the FOUR small "shared list shell" screens in
> one combined pass — **Reconciliation, POS imports, Audit log, Reports** — each a
> desktop `TabStrip` + fixed-width table/grid that becomes a full-width two-line
> card list → full-screen detail. Frontend-only, presentation-layer, gated on
> `useIsPhone()`; no backend / migration / edge-function / `src/lib/db.ts`
> contract change.

## Scope (design handoff README §7-17)

Each host section gets `if (isPhone) return <PhoneXxx .../>` placed AFTER all
hooks (desktop + tablet byte-unchanged, AC-REG). The shared row shape is
`[pill] name … value / meta … tag`; every tap opens a FULL-SCREEN detail per
Hard Rule 1 (except Audit — see Deviations).

- **Reconciliation** (`ReconciliationSection` → `PhoneReconciliation`): the
  7-column fixed-width variance table becomes variance rows — a severity pill
  (Δ% colored by `varianceTone`: |Δ%| ≥25 danger, ≥10 warn, favorable ok, else
  neutral) + item name + Δ$ value; meta = expected/counted. Tap → detail
  (`PropertyCard`: EXPECTED / COUNTED / Δ QTY / Δ$ / Δ% / CAT). A NET footer row
  mirrors the desktop's net row. **Model-lift** — the host's already-computed
  `computeVarianceLines`-derived `rows` + net summary flow down in a `model`
  bundle (do not re-derive the variance math on the phone side; spec-145
  pattern).
- **POS imports** (`POSImportsSection` → `PhonePOSImports`): the import-history
  table becomes import rows (state pill + filename + matched/total; meta = when ·
  rows · matched). Tap → detail (`StatPanel` TOTAL / MATCHED / UNMAPPED + the
  unmatched-item list). A 48px "+ UPLOAD CSV" primary surfaces an honest toast —
  the CSV column-mapping flow and the alias-mapping UI are desktop-only.
  **Direct-store** (reads `posImports` / `currentStore` / `recipes`, same
  matched/total tallies as the desktop row).
- **Audit log** (`AuditLogSection` → `PhoneAuditLog`): the fixed-width feed table
  becomes a virtualized, day-grouped `SectionList` — mono day `GroupCaption`s +
  two-line rows (dot + "time · user" meta line, full wrapping message) + the
  existing bilingual text filter as a 44px input. **Direct-store** (reuses
  `formatAuditAction` + `matchesQuery`; no forked filter logic).
- **Reports** (`ReportsSection` → `PhoneReports`): the template/saved-report card
  grid becomes saved-report rows (name + READY/RUNNING/QUEUED/FAILED pill via
  `reportPillState` + last-run meta). Tap → detail: lazy `loadLatestRun`, the
  run's KPIs as a phone-safe `PropertyCard`, an honest note that the full table +
  builder are desktop, and a 48px RUN REPORT primary (`runReport`). A 48px "+ NEW
  REPORT" primary surfaces an honest toast (desktop-only builder). **Direct-store**
  (reads `savedReports` / `reportRuns`, reuses `runReport` / `loadLatestRun`).

Each: `if (isPhone) return <PhoneXxx/>` after all hooks; no TabStrips on phone;
every tappable ≥44×44; FlatList/SectionList for unbounded lists; both themes via
tokens only; status pills use the ok/low/out/danger/warn/info semantic tokens —
never the accent; three-catalog i18n parity.

## Reuse (no new primitives, no forked logic)

`useCmdColors()` / `CmdRadius` / `PhoneType` / `mono()`; `TwoLineRow` /
`GroupCaption` / `PropertyCard` / `StatPanel` (`PhoneWidgets`);
`PhoneDrillScaffold` + `usePhoneDrill` (spec 142) for the three drill-in
sections; `StatusPill`; `relativeTime`; `formatAuditAction` + `matchesQuery`;
`common.editOnDesktop` for the honest toasts. Reconciliation's variance math
stays in `ReconciliationSection` (`computeVarianceLines`) and is lifted; the
other three read their slices directly (the PhoneOrdering / PhoneVendors
direct-store pattern). No new store fields, no direct `db.ts` access.

## Acceptance

- Full item / filename / report names (flex:1, ellipsize only past the full
  width); Audit messages WRAP (never letter-stack); no horizontal scroll; every
  tappable ≥44×44 (rows ≥56, UPLOAD/NEW/RUN 48, filter input 44); both themes via
  tokens only; variance / import / report pills use semantic tokens, never the
  accent (`varianceTone` / `reportPillState` are pure + unit-tested).
- Desktop (≥1100px) + tablet (768-1099px) render output byte-unchanged (AC-REG):
  the guard + a `useIsPhone()` read + the `PhoneXxx` import (+ the `model` bundle
  for Reconciliation) are the only edits to each host; the desktop return subtree
  is untouched.
- `npx tsc --noEmit` clean; full `npx jest` green (1636 tests).

## Deviations / notes

- **Audit log is intentionally list-only (deviation from Hard Rule 1).** README
  §7-17 scopes Audit as a "day-grouped" list only — unlike the other three it has
  no richer per-event detail. Because the row renders the FULL message (wrapping,
  never truncated), a full-screen detail would be an empty re-print of the same
  text, so there is no drill-in. The row is non-interactive, matching the desktop
  read-only `feed.tsx`. The other three sections DO honor Hard Rule 1 (full
  drill-in).
- **UPLOAD CSV + NEW REPORT are honest toasts, not fake forms.** The CSV
  column-mapping flow, the POS alias-mapping UI, and the report query-builder are
  heavy desktop-only surfaces; per the handoff's "desktop-only edit actions
  surface honest toasts instead of fake forms" rule they point to the desktop
  console rather than forking a reduced form. (Contrast spec 146's Users, whose
  INVITE reused the real production drawer because a validated invite path
  existed — no equivalent phone-safe path exists here.)
- **Reports renders the run KPIs (phone-safe) but not the full result table.**
  The run output's `kpis` are label/value pairs and render safely in a
  `PropertyCard`; the full tabular result + the builder stay desktop, surfaced as
  an honest note. RUN REPORT and loadLatestRun reuse the desktop store actions
  verbatim (no forked orchestration).
- **Model-lift for Reconciliation, direct-store for the other three.** Per the
  task's "model-lift or direct-store per what's cleanest": Reconciliation's
  non-trivial `VarianceLine → VarianceRow` mapping is single-sourced in the host
  and lifted; POS imports / Audit / Reports are simple read-only reads best done
  directly (matching PhoneOrdering).
- **Reports pill scheme mapped onto the real run status.** The handoff's
  READY/RUNNING/QUEUED is generic; the codebase's `ReportRun.status` is
  `'pending' | 'ok' | 'error'` with `undefined` = never run. Mapping: no run →
  QUEUED (neutral), pending → RUNNING (info), ok → READY (ok), error → FAILED
  (danger). Exposed as the pure `reportPillState` helper so the never-the-accent
  guarantee is unit-testable.

## Tests (jest track only — no DB/edge change)

- `phone/__tests__/PhoneReconciliation.test.tsx` — pure `varianceTone` severity
  mapping (never-the-accent); row render (pill + name + Δ$); drill-in detail
  (expected/counted); net footer; both empty states (no-variance vs no-EOD).
- `phone/__tests__/PhonePOSImports.test.tsx` — import row matched/total; drill-in
  detail (StatPanel + unmatched list); honest UPLOAD CSV toast; empty state.
- `phone/__tests__/PhoneAuditLog.test.tsx` — current-store-only day-grouped rows;
  full wrapping message; text filter narrowing by actor; empty state.
- `phone/__tests__/PhoneReports.test.tsx` — pure `reportPillState` mapping; row
  render; drill-in detail (loadLatestRun on open + KPIs + RUN REPORT → runReport);
  honest NEW REPORT toast; empty state.
- `phone/__tests__/PhoneListScreens.acReg.test.tsx` — the combined AC-REG pin:
  all four hosts render their desktop TabStrip tree at desktop AND tablet (phone
  component absent) and only the phone component at phone (tab strip gone).
  Mirrors PhoneSections.acReg / PhoneDashboard.acReg.
- No existing `*Section*.test.tsx` suite renders these four hosts at phone width
  (`InventoryDesktopLayout.test.tsx` mocks all four to `null` and already forces
  `useIsPhone → false`), so NO desktop-forcing `theme/breakpoints` mock was
  needed elsewhere.

## Verification

The `preview_*` browser tooling referenced in the frontend-developer workflow is
not present in this environment, so verification is via `npx tsc --noEmit`
(clean) + full `npx jest` (1636 green). The new `PhoneListScreens.acReg` suite
mounts the REAL host sections (`ReconciliationSection` / `POSImportsSection` /
`AuditLogSection` / `ReportsSection`) through the REAL `isPhone` guard at all
three tiers, so the `PhoneXxx ↔ Section` import graph is exercised end-to-end for
every screen (same posture specs 145/146 documented).

## Files changed

### New
- src/screens/cmd/sections/phone/PhoneReconciliation.tsx
- src/screens/cmd/sections/phone/PhonePOSImports.tsx
- src/screens/cmd/sections/phone/PhoneAuditLog.tsx
- src/screens/cmd/sections/phone/PhoneReports.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneReconciliation.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhonePOSImports.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneReports.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneListScreens.acReg.test.tsx
- specs/147-phone-list-screens-tier.md

### Modified — host sections (guard + model lift; desktop/tablet byte-unchanged)
- src/screens/cmd/sections/ReconciliationSection.tsx  (isPhone guard →
  PhoneReconciliation; model bundle lifting rows + net summary)
- src/screens/cmd/sections/POSImportsSection.tsx  (isPhone guard → PhonePOSImports)
- src/screens/cmd/sections/AuditLogSection.tsx  (isPhone guard → PhoneAuditLog)
- src/screens/cmd/sections/ReportsSection.tsx  (isPhone guard → PhoneReports)

### Modified — i18n (all three catalogs, parity kept)
- src/i18n/en.json / es.json / zh-CN.json  (section.reconciliation.phone.*,
  section.posImports.phone.*, section.reports.phone.*; Audit reuses existing
  section.auditLog.* keys)

## Handoff

next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of this spec. Each reviewer writes its findings
  to specs/147-phone-list-screens-tier/reviews/<your-name>.md.
payload_paths:
  - specs/147-phone-list-screens-tier.md
  - src/screens/cmd/sections/phone/PhoneReconciliation.tsx
  - src/screens/cmd/sections/phone/PhonePOSImports.tsx
  - src/screens/cmd/sections/phone/PhoneAuditLog.tsx
  - src/screens/cmd/sections/phone/PhoneReports.tsx
  - src/screens/cmd/sections/ReconciliationSection.tsx
  - src/screens/cmd/sections/POSImportsSection.tsx
  - src/screens/cmd/sections/AuditLogSection.tsx
  - src/screens/cmd/sections/ReportsSection.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneReconciliation.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhonePOSImports.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneReports.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneListScreens.acReg.test.tsx
  - src/i18n/en.json
  - src/i18n/es.json
  - src/i18n/zh-CN.json
