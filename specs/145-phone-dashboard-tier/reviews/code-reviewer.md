## Code review for spec 145 (Phone tier — Dashboard)

Reviewed: `src/screens/cmd/sections/phone/PhoneDashboard.tsx`, the
`DashboardSection.tsx` guard + four phone-only memos,
`phone/__tests__/PhoneDashboard.test.tsx` / `.acReg.test.tsx`, and the three
i18n catalogs.

### Critical
None found.

### Should-fix
None found. The guard (`DashboardSection.tsx:431`) is placed after every hook
in the component (confirmed no `React.use*` call appears below it), and after
the pre-existing `storeLoading` skeleton early-return — an ordering choice
that predates this spec and isn't a new regression. `outItems` /
`wasteEventCount` / `eodRows` / `recentActivity` are genuinely lifted from the
same selectors the desktop KPIs already use (`getItemStatus`, `wasteLog`,
`focalInventory`, `auditLog`), not re-derived. The `eodRows` vendor↔item
membership correctly mirrors `EODCountSection`'s junction (`vendorIds` with a
scalar `vendorId` fallback).

### Nits
- `src/screens/cmd/sections/phone/PhoneDashboard.tsx:72-74` — the local
  `money()` helper (`toLocaleString('en-US', { minimumFractionDigits: 2,
  maximumFractionDigits: 2 })`) duplicates-with-a-difference the shared
  `formatMoney` in `src/utils/reorderExport.ts` (no thousands separator there).
  Matches the design prototype's format 1:1 per the header comment, so not
  wrong, but it's a second "format money" helper in the phone tree (PhoneOrdering
  imports the shared one) — worth consolidating into one shared phone-money
  formatter if a future phone screen needs comma-grouped totals too.
- `src/screens/cmd/sections/phone/PhoneDashboard.tsx:232,282` — falls back to
  `T('section.reorder.unnamedVendor')` for a missing vendor name, borrowing a
  key from the Reorder section's i18n namespace rather than a
  `section.dashboard.phone.*` key of its own. Harmless (same string, same
  three catalogs), but a values-vs-namespace decision worth a beat in a follow-up
  i18n cleanup — a section that reads copy from an unrelated section's
  namespace is a small maintenance trap if Reorder's key ever gets renamed.

Overall: no direct Supabase calls, no hardcoded hex, no `Alert.alert` /
`window.confirm`, status colors are semantic tokens throughout (`C.danger` /
`C.warn` / `C.ok`, never `C.accent`, for OUT/LOW/EOD-pill tones), and the
NEEDS ATTENTION drill-in genuinely reuses the shared `PhoneDrillScaffold` +
`PhoneInventoryDetail` rather than forking a new detail view.

## Handoff
next_agent: NONE
prompt: Code review complete for spec 145. 0 Critical, 0 Should-fix, 2 Nits.
payload_paths:
  - specs/145-phone-dashboard-tier/reviews/code-reviewer.md
