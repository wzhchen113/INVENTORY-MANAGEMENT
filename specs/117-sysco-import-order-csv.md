# Spec 117: SYSCO Import-Order file export

Status: READY_FOR_REVIEW

> **Origin (owner ask, verbatim):** owner attached a SYSCO order-guide export
> (`SYSCO Jul 06, 2026 at 3_45 PM.csv`) and said "build sysco import/export".
> Owner decisions (via Q&A): mirror the file's **H/F/P layout** for the upload;
> **per-store** SYSCO customer number (reuse the US Foods per-store infra).

Sibling of spec 116 (US Foods Import-Order CSV). Built directly on top of it,
reusing `vendors.order_import_format` (new value `'sysco'`) and the per-store
`vendors.import_customer_numbers` map — **no new migration**.

## Background

SYSCO's order file is a three-record layout (from the operator's download):
```
H,<order#>,<route>,<customer#>,"<datetime>",<delivery>,N,,,<PO>,<PO>,<total>,<count>,<status>
F,SUPC,"Case Qty","Split Qty","Cust #",Pack/Size,Brand,Description,"Mfr #","Per Lb","Case $","Each $"
P,<SUPC>,<Case Qty>,<Split Qty>,,<Pack/Size>,<Brand>,<Description>,,N,<Case $>,<Each $>
```
The product code is **SUPC** (→ `item_vendors.order_code`, spec 114). Upload-back
capability is NOT independently verified (spec 114 §Background) — the owner will
test-upload; the export mirrors the download layout as the best-known shape.

## User story

As a store manager, when the reorder list is for my SYSCO-configured vendor, I
want the **Export CSV** button to download a SYSCO order file (H/F/P) with my
below-par SYSCO items' SUPCs and order quantities, so I can upload it to SYSCO
instead of retyping.

## Acceptance criteria

1. New `order_import_format = 'sysco'` recognized end-to-end (db map, type,
   Vendors form option, reorder branch). No migration (reuses existing column).
2. `buildSyscoImportCsv` emits one `H` record (customer # + order datetime + the
   literal `N`; SYSCO-assigned order#/total/status blank), the `F` field row
   **byte-for-byte** from the export, and one `P` row per ordered SYSCO item.
3. `P` row: `SUPC` = the item's order_code; `Case Qty` = whole cases; `Split
   Qty` = loose units (no-case items → Split Qty). Description/Pack Size/prices
   populated for readability (owner choice); Brand/Mfr # blank (not stored).
4. Only below-par items (qty > 0) WITH an order code are written; codeless items
   are skipped and counted; have-enough items excluded. Header-only file (H+F)
   when nothing is ordered.
5. Leading-zero SUPCs preserved (text). CSV/spreadsheet formula injection
   neutralized on order code + description (+ header) via the shared `csvSafe`.
6. Custom serializer quotes text-with-spaces (matching SYSCO's export style);
   codes/numbers unquoted. Rows joined with CRLF.
7. Per-store CUSTOMER NUMBER: `importCustomerNumbers[storeId]` → `account_number`
   fallback; a missing number is surfaced in the toast, not silent.
8. `onCsvPress` emits US Foods OR SYSCO file per the displayed vendor's format,
   else the generic CSV; other vendors omitted from the single-vendor file are
   cued in the toast (Risk 1, shared emitter).
9. Shared `vendorImportShared.ts` (csvSafe / isOrdered / orderQuantities) is the
   single source of truth for both vendor builders; US Foods refactored onto it
   with identical behavior (its tests unchanged/green).

## Scope / non-goals

- No new DB migration; no RLS change (reuses spec 116 vendor fields).
- SYSCO distributor/route/department: NOT modeled (US Foods keeps distributor/
  department; SYSCO's `route` field is left blank in H). Add later if needed.
- Upload-format certainty is out of scope (owner test-uploads).

## Risks

- **R1 — upload shape unverified:** mirrors the download layout; SYSCO may
  require different H fields or reject extra columns. Owner to test-upload.
- **R2 — Pack/Size + prices are derived**, not SYSCO's exact values (we don't
  store SYSCO pack strings/brand). Informational only; ignored on upload.
- **R3 — H output fields blank:** order#/total/status left empty on a new order;
  if SYSCO's importer requires any, the owner's test will surface it.
