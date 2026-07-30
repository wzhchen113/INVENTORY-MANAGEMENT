## Code review for spec 143 (Phone tier — Ordering / Reorder)

Reviewed: `src/screens/cmd/sections/phone/PhoneOrdering.tsx`, the `ReorderSection.tsx`
guard + re-exports, `phone/__tests__/PhoneOrdering.test.tsx` /
`PhoneOrdering.acReg.test.tsx`, and the three i18n catalogs.

### Critical
None found.

### Should-fix
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx:182-186` and `:363-369` —
  the stepper display rounds a fractional case suggestion before it's editable
  (`qtyOf` = `Math.round(poOrderedToCases(...))`), so the FIRST tap of +/− on an
  unrounded line (e.g. suggestedUnits/caseQty = 14.17 cases) writes
  `poCasesToBase(15 or 13, caseQty)` — jumping straight past the true value
  instead of nudging from it. The desktop `TextInput` path preserves the exact
  fraction via `poOrderedDisplay`/`poResolveEdit` (only rounds on write). This
  is a real behavior difference from desktop, not just a UI simplification —
  the first stepper tap silently discards the fractional remainder. Worth an
  explicit product decision (seed the stepper from the rounded display but
  base the *first* tap's delta off the true fractional suggestedUnits, or
  document the precision loss as an accepted phone deviation like the other
  ones in this spec's Deviations section).

### Nits
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx:198,248,388` — several
  strings (`'unnamed vendor'`, `'today'`, `'tomorrow'`, `` `in ${n} days` ``)
  are hardcoded English rather than run through `T()`. This mirrors
  pre-existing un-localized strings already in `ReorderSection.tsx` (not a
  regression introduced here), but since this is new phone-only code it would
  have been a good spot to close the gap rather than propagate it.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx:459` — `statusBadgeFor`'s
  `if (!at || Number.isNaN(at.getTime()))` fallback returns a bare `'COUNTED'`
  label that never goes through `T()`, inconsistent with every other label in
  the same function which do (`phoneItemsAffected`, etc. are localized
  upstream). Low-traffic branch (only hit on a malformed `eodSubmittedAt`), but
  worth a quick fix for consistency.

Overall: AC-REG is solid — the `isPhone` guard in `ReorderSection.tsx:1453-1454`
sits after all hooks and before the no-store guard, and the desktop return
subtree is otherwise untouched. No direct Supabase calls, no hardcoded hex
colors, no `Alert.alert`/`window.confirm`, and the `PhoneOrdering ↔
ReorderSection` re-export cycle (`applyReorderEdits` / `narrowReorderToVendor`
/ `handleCsvExport` / `handlePdfExport` / `handleImportExport`) is genuine reuse
with no forked logic.

## Handoff
next_agent: NONE
prompt: Code review complete for spec 143. 0 Critical, 1 Should-fix, 2 Nits.
payload_paths:
  - specs/143-phone-ordering-tier/reviews/code-reviewer.md
