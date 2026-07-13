-- ============================================================
-- Per-store US Foods CUSTOMER NUMBER (2026-07).
--
-- Follow-up to 20260712000000 (vendor import-order fields). The US FOOD vendor
-- is a single brand-shared `vendors` row, but each physical store has its OWN
-- US Foods ship-to / customer number under the corporate account (owner
-- confirmed). A single `account_number` would stamp every store's Import-Order
-- file with the same customer number → 3 of 4 stores uploading under the wrong
-- account. This adds a per-store override map:
--
--   import_customer_numbers  jsonb  — { "<store_id>": "<customer number>", ... }
--
-- Keyed by store UUID (text). The export resolves CUSTOMER NUMBER as
-- `import_customer_numbers[store_id]` with `account_number` as the brand-level
-- fallback default. DISTRIBUTOR / DEPARTMENT stay on the vendor row (division-
-- level, shared across the brand's stores).
--
-- Rides the existing `public.vendors` RLS (row-level, column-agnostic; brand-
-- scoped read, privileged brand-scoped write) — a store-keyed config map on a
-- brand-shared row is visible to brand members only, same as the sibling
-- import fields. Customer numbers are B2B account identifiers, not regulated
-- PII. No new table, no RLS/grant/publication change. Nullable, no default →
-- a vendor with no map behaves exactly as before (falls back to account_number).
-- ============================================================

alter table public.vendors
  add column if not exists import_customer_numbers jsonb;

comment on column public.vendors.import_customer_numbers is
  'Per-store US Foods CUSTOMER NUMBER override for the Import-Order CSV: { "<store_id>": "<customer number>" }. Falls back to account_number when a store has no entry. Distributor/department stay vendor-level (division-scoped).';
