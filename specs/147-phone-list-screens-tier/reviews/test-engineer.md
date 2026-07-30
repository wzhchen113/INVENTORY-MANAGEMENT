## Test report for spec 147

Track confirmation: frontend-only per the spec header. `git show --stat
1661d54` shows zero touched files under `supabase/`, `scripts/`, or `e2e/` for
the whole batch. **Jest track only**, no fourth framework introduced.

### Acceptance criteria status

- AC1 (full item/filename/report names, Audit messages WRAP — never
  letter-stack, no horizontal scroll, every tappable ≥44×44, both themes via
  tokens, variance/import/report pills use semantic tokens — never accent,
  `varianceTone`/`reportPillState` pure + unit-tested) → PASS on the
  pure-function half (see Notes — both helpers are directly unit-tested with
  the never-accent guarantee); PARTIAL on the layout/wrap/dimension half,
  which is structural/manual (dispatcher's live 375×812 browser pass covered
  all four screens per the task brief, consistent with the rest of the
  batch).
- AC2 (desktop/tablet render output byte-unchanged for all four hosts,
  AC-REG) → PASS — `phone/__tests__/PhoneListScreens.acReg.test.tsx` is a
  single combined suite driving all four real hosts
  (`ReconciliationSection`/`POSImportsSection`/`AuditLogSection`/
  `ReportsSection`) through the real `isPhone` guard at desktop, tablet, AND
  phone tiers (12 assertions: 4 hosts × 3 tiers). Diff review of all four host
  files confirms the claimed minimal edit surface (guard + `PhoneXxx` import,
  plus the model bundle for Reconciliation only) — no other lines in any
  host's desktop return subtree changed.
- AC3 (`npx tsc --noEmit` clean; full `npx jest` green — spec claims 1636,
  final batch total 1658) → PASS — `npx tsc --noEmit` clean. Full `npx jest`:
  172 suites / 1658 tests, all green. `npm run typecheck:test` also passes
  clean for this spec's own files specifically — cross-checked the three
  repo-wide `typecheck:test` error paths (see specs 143/144/146) against this
  spec's "Files changed" list: no overlap.

### Test run

```
npx tsc --noEmit                        → clean, 0 errors
npm run typecheck:test                  → FAILS repo-wide (3 errors), but NONE
                                           in this spec's files — see spec
                                           148's report for the consolidated
                                           finding (specs 143/144/146 only)
npx jest                                 → Test Suites: 172 passed, 172 total
                                           Tests: 1658 passed, 1658 total
                                           Snapshots: 2 passed, 2 total
```

pgTAP / shell smokes not run — no DB/edge/RPC surface in this spec.

### Notes

- **`varianceTone` severity mapping (never accent)** — PASS —
  `PhoneReconciliation.test.tsx::maps |Δ%| ≥ 25 → danger, ≥ 10 → warn,
  favorable → ok, else neutral` covers all four bands with concrete numeric
  fixtures (−30/danger, 27/danger, −12/warn, 2/ok, −2/neutral) including the
  favorable-vs-unfavorable distinction (a positive Δ% at low magnitude → ok,
  negative at low magnitude → neutral) rather than just the boundary
  magnitudes. Reconciliation's model-lift (variance math stays in
  `ReconciliationSection`, not re-derived) is verified by inspection of
  `PhoneReconciliation.tsx`'s prop signature (`model: PhoneReconciliationModel`
  carrying pre-computed rows + net) — no re-implementation of
  `computeVarianceLines` found in the phone file.
- **`reportPillState` mapping (never accent)** — PASS —
  `PhoneReports.test.tsx::maps no-run → queued, pending → running, ok →
  ready, error → failed` covers all four real `ReportRun.status` values
  including the `undefined` (never-run) case, matching the spec's stated
  mapping table exactly.
- **Reconciliation drill-in + net footer + both empty states** — PASS —
  `PhoneReconciliation.test.tsx` has distinct tests for the row render, the
  detail open, the net footer, AND both empty states separately
  (no-variance-but-EOD-exists vs no-EOD-at-all) — this is a meaningful
  distinction (the desktop screen and the phone screen both need to
  distinguish "nothing to reconcile" from "no submission to reconcile
  against"), and both are exercised rather than collapsed into one generic
  empty-state test.
- **POS imports honest UPLOAD CSV toast + drill-in StatPanel** — PASS —
  `PhonePOSImports.test.tsx::UPLOAD CSV fires an honest toast (desktop-only
  flow)` confirms no fake upload form opens; `::opens the detail with stats +
  the unmatched-item list` confirms the StatPanel (TOTAL/MATCHED/UNMAPPED) and
  unmatched-list render from the real `posImports`/`recipes` slices
  (direct-store pattern, not model-lift, as the spec states).
- **Audit log — day-grouped rows, full wrapping message, filter, deliberate
  no-drill-in** — PASS on the tested behavior —
  `PhoneAuditLog.test.tsx::shows the full message with the item reference` and
  `::the text filter narrows the feed by actor` both assert against concrete
  fixture text (not a smoke render). The spec's Hard-Rule-1 deviation (Audit
  is intentionally list-only, no full-screen detail, because the row already
  shows the full un-truncated message) is a documented, reasoned exception —
  I checked `PhoneListScreens.acReg.test.tsx` and confirmed it does NOT expect
  a drill-in for Audit specifically (only Reconciliation/POS/Reports get the
  detail-tap assertions), so the combined AC-REG suite correctly encodes this
  asymmetry rather than silently missing it.
- **Reports drill-in: `loadLatestRun` on open, KPIs via `PropertyCard`, RUN
  REPORT → `runReport`, honest NEW REPORT toast** — PASS —
  `PhoneReports.test.tsx::opens the detail (loadLatestRun) and RUN REPORT
  calls runReport` asserts BOTH the lazy-load-on-open behavior and the
  RUN REPORT action call the real store actions (not forked orchestration);
  `::NEW REPORT fires an honest toast (desktop-only builder)` confirms no fake
  report-builder form opens.
- **All four empty states** — PASS — each of the four component test files
  has its own dedicated empty-state test (`no variance`/`no EOD`, `no
  imports`, `no events`, `no saved reports`), not a shared generic case.
- **No pre-existing host suites needed a desktop-forcing mock** — confirmed:
  `InventoryDesktopLayout.test.tsx` already mocks all four hosts to `null` and
  forces `useIsPhone → false`; re-ran it, unaffected. No `*Section*.test.tsx`
  for these four hosts exists elsewhere that would need updating.
- **i18n parity** — verified programmatically across all three catalogs (0
  missing/extra keys), including this spec's `section.reconciliation.phone.*`
  / `section.posImports.phone.*` / `section.reports.phone.*` keys (Audit
  correctly reuses existing `section.auditLog.*` keys per the spec's note,
  rather than adding a redundant phone-scoped duplicate set).

### Verdict for this spec

No FAIL/NOT TESTED against this spec's own stated acceptance criteria. Both
pure never-the-accent helpers are unit-tested at the boundary level, all four
sections' drill-in/empty-state/honest-toast behaviors are directly tested (not
smoke-rendered), the deliberate Audit-has-no-drill-in deviation is correctly
reflected in the combined AC-REG suite rather than silently mismatched, and
this spec's own test files are not implicated in the repo-wide
`typecheck:test` failure (that failure belongs to specs 143/144/146 — see
those reports and spec 148's consolidated note).

## Handoff
next_agent: NONE
prompt: Test report complete for spec 147.
payload_paths:
  - specs/147-phone-list-screens-tier/reviews/test-engineer.md
