# Backend-architect review — Spec 116: US Foods "Import Order" CSV export

Mode: post-implementation architectural-drift review (read-only). Scope: data
model, migration additivity/prod-drift, `db.ts` contract fit, reorder-export
resolution path, and Risk 1. Code style deferred to code-reviewer.

Verdict: architecture is sound and matches the contract in the spec. One
genuine data-model open question worth surfacing to the owner (per-store US
Foods customer number), plus a few Should-fix / Minor notes. No Critical.

---

## Findings

### Should-fix

**S1 — Per-store US Foods customer number is not expressible; brand-level
`account_number` may be wrong for 3 of the 4 stores.**
`handleUsFoodsImportExport` sets `customerNumber: cfg.accountNumber` from the
single brand-shared US FOOD vendor row
([ReorderSection.tsx:659](src/screens/cmd/sections/ReorderSection.tsx)). US FOOD
is one `vendors` row spanning all 4 stores (spec §"Per-store or admin-global"),
so every store's Import-Order file carries the **same** CUSTOMER NUMBER.

In real US Foods (and Sysco/PFG) operations, a corporate parent account almost
always has a **distinct customer / ship-to number per physical location** for
delivery routing and billing, even under one national agreement. If that holds
for the 2AM PROJECT stores, three of the four stores will upload a file stamped
with another store's customer number — a silent wrong-account order, not a
visible failure. The DISTRIBUTOR (division) number is genuinely brand/region
level and reusing it is fine; CUSTOMER NUMBER is the one at risk.

This is the exact case the task flagged ("is per-store US Foods account ever a
real need?"). The current model cannot represent it: `account_number`,
`import_distributor_number`, `import_department` are all columns on the
brand-level `vendors` row. Expressing per-store customer numbers needs a
per-(store, vendor) override — a small `store_vendors`-style table or a JSONB
`import_customer_by_store` on the vendor — neither of which is in the staged
work.

Recommendation: surface to the owner as a blocking product question BEFORE this
ships to more than a single-customer-number brand. If all 4 stores genuinely
share one US Foods customer number, no change is needed — but that fact should
be confirmed and recorded in the spec, because the schema silently assumes it.
Do not auto-add the override table; it is a scope + owner decision.

### Minor

**M1 — `order_import_format` free-text tag: right extensibility call, but no
`CHECK` guard against a silently-unrecognized value.**
Text-tag over enum is the correct choice here and is well justified in the
migration header
([20260712000000_vendor_import_order_fields.sql:37-38](supabase/migrations/20260712000000_vendor_import_order_fields.sql)):
a Postgres enum would force `ALTER TYPE ... ADD VALUE` (non-transactional,
migration-per-format) for exactly the extension the tag is designed to avoid.
Endorsed.

The residual risk is that any value other than the literal `'us_foods'` falls
through to the generic CSV path silently — a typo'd tag (`'usfoods'`) produces
no error, just the wrong export. In practice the value is set by a
segmented control (None / US Foods), not free-typed, so the blast radius is
small. A `CHECK (order_import_format IN ('us_foods'))` would catch DB-side
drift but reintroduces a migration per new format — the very cost the text tag
avoids. Net: acceptable as-is; if a second format lands, prefer a
CHECK-with-allowlist-that-grows-per-format (mirrors the escapeHtml allowlist
posture) over an unconstrained column, and decide it in that spec.

**M2 — Reorder RPC should NOT be changed to surface `order_code`; client-side
resolution is the correct call for this spec.**
`handleUsFoodsImportExport` resolves each PRODUCT NUMBER off the hydrated
`inventory` slice, not the reorder payload
([ReorderSection.tsx:654-655](src/screens/cmd/sections/ReorderSection.tsx)).
This is the *established* pattern — byte-for-byte the same resolver the
quick-order path uses ([ReorderSection.tsx:282-284](src/screens/cmd/sections/ReorderSection.tsx)),
and `ReorderItem` deliberately carries no code
([types/index.ts:813](src/types/index.ts)). Surfacing `order_code` from
`report_reorder_list` would be a broader contract change touching the RPC plus
both the admin (`db.mapReorderVendor`) and staff (`fetchReorder`) mappers, and
would fork an item that links to multiple vendors (which vendor's code?). Reusing
the per-(item, vendor) resolver against `cfg.id` is the right, consistent call.
No change recommended.

One latent coupling to note (pre-existing, not introduced here): the resolver
depends on `inventory` being loaded and containing the item + its vendor link.
The reorder payload comes from the RPC; the inventory slice is fetched
separately. If they diverge (item present in the reorder payload but absent /
un-hydrated in `inventory`), the code resolves to `undefined` and the item is
counted as `skippedNoCode` — reported honestly in the toast, but attributed to
"no order code set" when the real cause is a stale inventory slice. Same
systemic risk already lives in the quick-order path, so it is not new drift.
The durable fix (RPC returns the code) is a future contract decision, not this
spec's job.

**M3 — Risk 1 (single-vendor file silently drops other vendors) is acceptable
product behavior, but the omission is fully silent.**
`onCsvPress` picks the FIRST `us_foods` vendor and `handleUsFoodsImportExport`
emits only that vendor's items, fully REPLACING the generic multi-vendor CSV
([ReorderSection.tsx:1040-1047](src/screens/cmd/sections/ReorderSection.tsx)).
When the day-filter isolates US FOOD (the common case) this is correct — a US
Foods import file is inherently single-vendor. Architecturally fine; not a flaw.

The gap is UX, not architecture: when the view shows US FOOD *and* another
vendor, the manager silently loses the other vendors' CSV entirely and gets no
cue that rows were omitted. The success toast reports only included/skipped for
US FOOD. Recommend the toast append an omitted-vendor note when
`exportPayload.vendors.length > 1` (e.g. "N other vendor(s) not included — use
the day filter"). Product-owned call; flagging so it is a decision, not an
accident.

### Confirmations (no action)

**C1 — Migration is additive, idempotent, and prod-drift-safe.**
Three nullable columns, no default, `add column if not exists`
([20260712000000_vendor_import_order_fields.sql:32-35](supabase/migrations/20260712000000_vendor_import_order_fields.sql)).
A vendor with none set behaves exactly as before (AC met). The `if not exists`
guard makes the file safe to (re-)apply regardless of prod state, so once
committed the repo file + the `schema_migrations` version `20260712000000` row
satisfy the `db-migrations-applied.yml` presence check and the gate stays green.
Caveat on the gate's limits: it compares version-string presence, not DDL
content — it will NOT catch a divergence between the SQL actually run via MCP
`execute_sql` and this file. Since the DDL here is idempotent additive
columns, confirm the MCP-applied statement was this same
`add column if not exists` set (not a hand-typed variant), then there is zero
content-drift exposure. No RLS/grant/publication change — correctly asserted;
additive columns inherit the existing `vendors` brand-visibility policies.

**C2 — `db.ts` mapping fits the centralization convention; no contract drift.**
`fetchVendors` maps all three new columns with the documented null-handling
(`order_import_format || undefined`, the two text fields `|| ''`)
([db.ts:1807-1809](src/lib/db.ts)); `createVendor` writes them spread-guarded
omit-when-empty ([db.ts:1829-1831](src/lib/db.ts)); `updateVendor` writes them
with empty-string→null clear semantics
([db.ts:2962-2964](src/lib/db.ts)) — matches AC 27-31 exactly. All vendor DB
traffic stays inside `db.ts`; the export path reads already-hydrated store
state, so nothing bypasses `db.ts` to hit Supabase directly. Good.

**C3 — The bundled `account_number`-on-update fix is correct and in-contract.**
`updateVendor` previously dropped `accountNumber`, so editing "Account #"
no-oped on update ([db.ts:2950-2954](src/lib/db.ts)). Since CUSTOMER NUMBER
reuses this column, the fix is load-bearing for the feature, not incidental
cleanup — correctly scoped into this spec (AC 32). Empty-string→null clear
matches the sibling fields.

Minor consistency note (not a defect): `createVendor` returns `{ ...vendor,
id }` — it echoes the caller's input rather than re-mapping the persisted row
([db.ts:1834](src/lib/db.ts)). Pre-existing pattern shared by the whole vendor
path; the new fields inherit it. Fine because realtime + the next `fetchVendors`
reconcile state, but worth knowing the returned object is the optimistic input,
not the DB row.

---

## Summary

| Sev       | Finding                                                                 |
|-----------|-------------------------------------------------------------------------|
| Should-fix| S1 — per-store US Foods customer number not expressible (owner Q)        |
| Minor     | M1 — text tag right, no CHECK guard against unrecognized value           |
| Minor     | M2 — client-side order-code resolution is correct; don't change the RPC  |
| Minor     | M3 — Risk 1 acceptable but silent; recommend an omitted-vendor toast     |

No Critical. Contract, migration additivity, RLS posture, and `db.ts`
centralization all land as designed. S1 is the one item that should reach the
owner before this pattern is relied on across all 4 stores.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 4 findings (0 Critical, 1
  Should-fix, 3 Minor). S1 (per-store US Foods customer number) is an owner
  product question, not a code defect; the rest are Minor/confirmations.
payload_paths:
  - specs/116-us-foods-import-order-csv/reviews/backend-architect.md
