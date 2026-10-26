# Spec 175 — main-session verification (2026-10-23)

Run by the dispatching session after the developer handed off.

## AC-21 — gates (re-run independently)
- `npx jest` (full): 264/264 suites, 3303/3303 tests, 17/17 snapshots — PASS
- `npm run typecheck`: clean — PASS
- `npm run typecheck:test`: clean — PASS

## AC-17 — comment-only UI edits
`git diff -U0` on `ReorderSection.tsx` + `phone/PhoneOrdering.tsx`, filtered to non-`//` changed lines: empty — PASS.

## AC-22 — browser check (local stack, expo-web, admin@local.test, Towson)
Test data: a Friday `order_schedule` row for US FOOD + a submitted EOD for today (31 entries, all 0 remaining). Rows removed afterwards (plus the draft PO the export created).

1. Phone, 390 px: Ordering showed `1 VENDORS · 30 LINES`.
2. Changed Banana Pudding's EOD entry to 1000 and bumped `eod_submissions.submitted_at` in SQL. Realtime reload ran; the list never emptied and updated to `29 LINES` (Banana Pudding gone). Network: a second `report_reorder_list` POST (the silent refresh). — PASS
3. Phone: ··· → EXPORT CSV. Toast "CSV exported", ORDER HISTORY · 1 (draft recorded), self-echo reload issued a third `report_reorder_list`; list stayed at 29 lines. — PASS
4. Desktop: Reorder section showed US FOOD, 29 items. Changed Wings' entry + bumped again: list stayed and updated to 28 items. — PASS
5. Store switch Towson → Frederick (desktop): 0 vendors, "No vendors are ordered on Friday", no Towson carry-over. — PASS (spec 021 clear intact)

## CI on main (latest run, head 8872de2)
- test.yml: success — https://github.com/wzhchen113/INVENTORY-MANAGEMENT/actions/runs/40029711237
- db-migrations-applied.yml: success — https://github.com/wzhchen113/INVENTORY-MANAGEMENT/actions/runs/40029711242
- e2e.yml: success — https://github.com/wzhchen113/INVENTORY-MANAGEMENT/actions/runs/40029711234

## Fix round 1 — re-verification (2026-10-25)
- `npx jest` (full): 265/265 suites, 3309/3309 tests, 17/17 snapshots — PASS
- `npm run typecheck` / `npm run typecheck:test`: exit 0 — PASS
- AC-17 non-comment filter on `ReorderSection.tsx` + `phone/PhoneOrdering.tsx` vs HEAD: 0 lines — PASS
- AC-22 re-run on the fix-round-1 build (expo-web, phone width, Towson, re-seeded Sunday schedule + today's EOD for US FOOD; rows removed afterwards):
  1. Ordering: `1 VENDORS · 30 LINES`.
  2. Changed Banana Pudding's entry + bumped `submitted_at`: list stayed, refreshed to `29 LINES` — PASS.
  3. Switch Towson → Frederick: `0 VENDORS · 0 LINES`, "No vendors are ordered on Sunday" — PASS (store-switch clear).
  4. Switch back → Towson: `1 VENDORS · 29 LINES` reloaded — PASS.
