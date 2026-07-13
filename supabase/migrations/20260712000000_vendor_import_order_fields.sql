-- ============================================================
-- Vendor per-format "Import Order" export fields (2026-07).
--
-- Builds on spec 114 (per-vendor `item_vendors.order_code` SKU mapping +
-- universal quick-order list). This adds the vendor-level header values a
-- vendor-specific ORDER-FILE export needs — starting with the US Foods MOXē
-- "Import Order" CSV, whose upload needs only customer # + product # + qty
-- (see spec 114 Background). Three additive nullable columns on
-- `public.vendors`:
--
--   • order_import_format        — which vendor file template this vendor
--                                  uses. NULL = none (generic export only);
--                                  'us_foods' = the US Foods Import-Order CSV.
--                                  A text tag (not an enum) so a future
--                                  format (e.g. 'sysco') is a value, not a
--                                  migration.
--   • import_distributor_number  — US Foods DISTRIBUTOR (division) number
--                                  (e.g. '4147'). Free-form text; other
--                                  formats may reuse or ignore it.
--   • import_department          — US Foods DEPARTMENT (e.g. '0').
--
-- CUSTOMER NUMBER reuses the EXISTING `vendors.account_number` — no new
-- column. All three are nullable with no default: a vendor with no import
-- format set behaves exactly as today (generic reorder export only).
--
-- No RLS change: `public.vendors` policies already gate every column under
-- the caller's brand visibility; additive columns inherit them. No grant
-- change: table-level grants cover new columns (spec 097 explicit-grant
-- posture). No realtime/publication change.
-- ============================================================

alter table public.vendors
  add column if not exists order_import_format       text,
  add column if not exists import_distributor_number text,
  add column if not exists import_department         text;

comment on column public.vendors.order_import_format is
  'Vendor-specific order-file export template tag. NULL = none; ''us_foods'' = US Foods Import-Order CSV. Text (not enum) so a new format is a value, not a migration.';
comment on column public.vendors.import_distributor_number is
  'US Foods DISTRIBUTOR (division) number for the Import-Order CSV header (e.g. ''4147''). Free-form.';
comment on column public.vendors.import_department is
  'US Foods DEPARTMENT for the Import-Order CSV header (e.g. ''0''). Free-form.';
