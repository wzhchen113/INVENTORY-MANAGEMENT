# src/ layout (placeholder)

This is the scaffold directory for the imr-staff app. Spec 062 (in
this repo, written by a future product-manager run) will populate
these subdirectories with the real implementation.

Subdirectories:

- `screens/` — EOD count screen, store picker, sign-in screen.
- `hooks/` — `useConnectionStatus.ts` (per imr-inventory spec 061
  §1 Q3 — NetInfo on native, navigator.onLine on web), other
  helpers.
- `store/` — Zustand store. Mirrors imr-inventory's pattern but
  staff-app scoped (no admin slices).
- `lib/` — Supabase client init, EOD submission wrapper around
  `supabase.rpc('staff_submit_eod', ...)`, offline queue
  read/write/drain helpers.
- `i18n/` — Hand-rolled `t()` over a typed message catalog. Pattern
  copied from imr-inventory `src/i18n/`. English-only in v1.
- `navigation/` — React Navigation stack (sign-in → store picker →
  EOD count).
- `components/` — Small UI primitives. No design system — the staff
  app is intentionally minimal in v1.

See the imr-inventory contract:
`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061-staff-app-eod-count.md`
