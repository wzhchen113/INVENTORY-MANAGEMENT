## Code review for spec 147 (Phone tier — Reconciliation / POS imports / Audit log / Reports)

Reviewed: `PhoneReconciliation.tsx`, `PhonePOSImports.tsx`, `PhoneAuditLog.tsx`,
`PhoneReports.tsx`, the four host-section guards
(`ReconciliationSection.tsx`, `POSImportsSection.tsx`, `AuditLogSection.tsx`,
`ReportsSection.tsx`), the five new test files, and the i18n catalogs.

### Critical
None found.

### Should-fix
- `src/screens/cmd/sections/phone/PhoneReports.tsx:46-70` — this file defines
  its own local `StatusPill` component, shadowing the shared
  `components/cmd/StatusPill` that `PhonePOSImports.tsx`, `PhoneUsers.tsx`, and
  `PhoneDashboard.tsx` all import for the exact same "status chip" concept.
  Same name, different prop shape (`state: ReportPillState` here vs
  `status: 'ok'|'low'|'out'|...` on the shared one) — a reader jumping between
  phone files will reasonably assume `StatusPill` means the same thing
  everywhere and be wrong. Rename the local one (e.g. `ReportStatusPill`) to
  remove the collision, or extend the shared `StatusPill` to accept a
  `label`-driven variant if the four report states don't map cleanly onto the
  existing `status` union.

### Nits
- `src/screens/cmd/sections/phone/PhoneAuditLog.tsx:39-53` and
  `src/screens/cmd/sections/AuditLogSection.tsx:21-35` — the `ACTION_TONE` map
  is duplicated verbatim (same keys, same tones) between the phone and desktop
  files rather than shared from one location. The spec's Reuse section
  correctly scopes `formatAuditAction` / `matchesQuery` as shared, but this
  particular map slipped through as copy-paste; low risk (both are small,
  static objects) but a future new `AuditAction` value now has to be added in
  two places to stay in sync.
- `src/screens/cmd/sections/phone/PhoneAuditLog.tsx:57-67` and
  `src/screens/cmd/sections/AuditLogSection.tsx:42-52` — `formatDayLabel` is
  also duplicated byte-for-byte between the two files (same signature, same
  body). Same low-risk/duplication-debt as above; a good pair to hoist into a
  shared `utils/` helper in a later cleanup pass since both are now pure and
  side-effect-free.
- `src/screens/cmd/sections/phone/PhonePOSImports.tsx:35-41` — the `tally()`
  status derivation (`total > 0 && matched === 0 ? 'out' : errors > 0 ? 'low' :
  'ok'`) is inline in the phone file with no equivalent pure/exported
  counterpart on the desktop side to diff against; the spec's model-lift-vs-
  direct-store rationale is sound, but since this bit of business logic
  determines a semantic status color it would benefit from being unit-pinned
  the same way `varianceTone` / `reportPillState` are (it currently has no
  dedicated export, though `PhonePOSImports.test.tsx` presumably exercises it
  indirectly through rendered rows — worth confirming with test-engineer).

Overall: all four hosts place their `isPhone` guard after every hook and
before/after the appropriate desktop-only early-returns, per the pattern in
specs 143-146; `varianceTone` and `reportPillState` are clean pure/exported
classifiers with the never-the-accent guarantee intact; no direct Supabase
calls, no hardcoded hex, no `Alert.alert`/`window.confirm`. The Audit-log
deviation from Hard Rule 1 (no drill-in) is well-reasoned and disclosed, not a
finding.

## Handoff
next_agent: NONE
prompt: Code review complete for spec 147. 0 Critical, 1 Should-fix, 3 Nits.
payload_paths:
  - specs/147-phone-list-screens-tier/reviews/code-reviewer.md
