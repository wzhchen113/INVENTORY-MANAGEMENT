# Security audit for spec 116 — US Foods "Import Order" CSV export

Scope reviewed (staged, uncommitted): the migration
`supabase/migrations/20260712000000_vendor_import_order_fields.sql`, the pure CSV
builder `src/utils/usFoodsImport.ts`, the `db.ts` vendor mapping + `account_number`
update fix, and the admin Cmd UI (`VendorFormDrawer.tsx`, `ReorderSection.tsx`).
Owner areas: auth/authz, RLS, secrets, input validation, PII/data exposure.

## Critical (BLOCKS merge)

None.

## Should-fix (address before deploy)

- `src/utils/usFoodsImport.ts:113-131` — **CSV / spreadsheet formula injection.**
  `PRODUCT NUMBER` (the per-(item,vendor) `order_code`) and `DESCRIPTION`
  (`item.itemName`) are written into CSV cells via `Papa.unparse` with no
  formula-neutralization. Papa escapes CSV delimiters/quotes but does NOT
  prefix the dangerous formula lead characters (`= + - @`, tab, CR). This file
  is intentionally opened in Excel/Sheets by an admin ("populate optional/price
  columns for human review", spec §In scope) before upload to US Foods.
  - Threat path is in-model: `item_vendors.order_code` is writable by any
    **store member** — the separate staff app — via `store_member_insert_item_vendors` /
    `store_member_update_item_vendors` (`supabase/migrations/20260630000000_item_vendors.sql:126,131`,
    gated only by `auth_can_see_store`, not admin). A lower-privilege staff user
    can set an order code such as `=HYPERLINK("http://evil","ok")` or
    `=cmd|'/c calc'!A1` that executes/rehydrates when the admin opens the
    exported file. `itemName` is brand-member controlled and is a weaker but
    parallel sink.
  - Impact: code/formula execution or data-exfil hyperlink firing in the
    admin's spreadsheet client, driven by input from a lower-privilege sibling
    app. Not a DB-side privilege escalation, but a genuine cross-privilege
    injection into an admin-consumed artifact.
  - Fix: neutralize each free-text cell before unparse — prefix a leading `'`
    (or `\t`) when the value starts with `= + - @`, tab, CR, or LF. Apply to at
    least `PRODUCT NUMBER` and `DESCRIPTION` (and defensively the header
    strings `CUSTOMER NUMBER` / `DISTRIBUTOR` / `DEPARTMENT`).
  - Note (not a reason to skip): the pre-existing generic export
    `src/utils/reorderExport.ts:234` (`Papa.unparse(rows, { columns })` with
    `item.itemName`) has the same gap. This spec widens the exposure by adding
    the staff-writable `order_code` as a new sink, so the fix belongs here; the
    generic path is worth a follow-up.

## Nits

- `src/screens/cmd/sections/ReorderSection.tsx:684` — error handler logs
  `e?.message` only (no header values, no account/customer number). Good — keep
  it that way; do not add the vendor config object to the `console.warn`, as the
  customer/distributor number is a business account identifier.
- `import_distributor_number` / `import_department` / `account_number` are B2B
  vendor account identifiers, not regulated consumer PII/PCI. They are
  brand-scoped in the DB (see RLS verification below) and only surfaced in an
  admin-initiated export the admin already possesses. No handling change
  required; flagged only so a future spec that widens read access reconsiders.

## Verifications (claims that hold)

- **Migration "no RLS/grant change needed" claim — CONFIRMED correct.**
  `public.vendors` RLS (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:575-602`,
  as amended by `20260710000000_drop_redundant_vendor_insert_policy.sql`) is:
  SELECT = `brand_member_read_vendors` → `auth_can_see_brand(brand_id)`;
  INSERT/UPDATE/DELETE = privileged (`auth_is_privileged()` = admin/master/
  super_admin) AND `auth_can_see_brand(brand_id)`. RLS is row-level and
  column-agnostic, so the three additive columns inherit exactly these gates —
  readable only within the caller's brand, writable only by privileged
  brand members. No new column exposes anything cross-brand, and the customer
  PWA cannot read vendors (customers are not brand members → `auth_can_see_brand`
  fails). Grants: spec-097 blanket table grant
  (`20260618000000_public_grants_explicit.sql`) is table-level and extends to
  new columns automatically. The migration's stated posture is accurate.
- **No RLS-bypassing access path in `db.ts`.** `fetchVendors` / `createVendor` /
  `updateVendor` all go through the same PostgREST client and hit the vendors
  policies above. The `account_number`-on-update fix (`src/lib/db.ts:2954`) just
  threads an already-permitted column through the existing
  `privileged_update_vendors` gate; `|| null` clears on empty. No new surface.
- **Prices are admin-only.** `handleUsFoodsImportExport` and the reorder payload
  render only inside `ReorderSection` (admin Cmd UI, mounted for admin roles via
  `RoleRouter`). The intentional inclusion of prices in this file is confined to
  the admin surface, consistent with the owner decision.
- **Segmented-control value is not a security boundary.** `orderImportFormat`
  only selects a client-side export template; it does not gate any read/write.
  No misuse of the `useRole()` placeholder.

## Dependencies

No `package.json` change in the staged set — `npm audit` skipped.
