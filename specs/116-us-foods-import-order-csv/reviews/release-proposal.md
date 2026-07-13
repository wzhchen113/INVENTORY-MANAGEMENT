# Release proposal — Spec 116: US Foods "Import Order" CSV export

## Verdict
verdict: FIXES_NEEDED
rationale: A code-reviewer Critical (`updateVendor` silently swallows Supabase errors, breaking optimistic-revert for the very fields this feature persists) and a test-engineer Critical (the sole user-facing trigger, `onCsvPress`'s US-Foods branch, has zero coverage) both stand, so SHIP_READY is barred.

## Findings summary
- **code-reviewer**: 1 Critical, 4 Should-fix, 5 Nits. Top: `src/lib/db.ts:2972` `updateVendor`'s terminal update never destructures `{ error }` / never throws (unlike `updateStore` and `createVendor`), so a real backend failure (RLS denial, constraint violation) resolves as success — the UI reports "Saved" while nothing persisted, for `accountNumber` + all three new import fields. This is a PRE-EXISTING third instance of the exact silent-data-loss bug the surrounding comments already document twice, and this feature now depends on that write path. Should-fix: hardcoded English i18n on the new segmented control (sibling control i18n's fully); `Vendor.orderImportFormat` typed as bare `string` instead of `'' | 'us_foods'`; Risk 1 silent vendor-drop needs a toast cue; duplicated date expression.
- **security-auditor**: 0 Critical, 1 Should-fix, nits. Top: CSV/formula injection — `order_code` (writable by any store member via the staff app, a lower privilege) and `itemName` flow into CSV cells with no formula-lead neutralization (`= + - @`, tab, CR). The file is opened in Excel/Sheets by an admin before upload, so this is a genuine cross-privilege injection into an admin-consumed artifact. Pre-existing in `reorderExport.ts`; this spec widens it by adding the staff-writable `order_code` sink, so the fix belongs here. RLS/grant posture on the migration confirmed correct.
- **test-engineer**: 6 builder unit tests PASS, full jest 1136 green, typecheck clean. AC 6-11, 14 PASS. Marks AC12/AC13 (the `onCsvPress` US-Foods branch + toast — the only end-to-end trigger) NOT TESTED → Critical per its mandate, and independently high-risk (glue across three store slices, the exact wiring-no-op bug class that has repeatedly bitten `db.ts`). Also notes AC4/AC5 need BOTH a persistence test AND an error-rejection test — an args-only persistence test would go green while the code-reviewer's Critical remains undetected. AC1 (migration shape) and AC3 (`fetchVendors` mapping) uncovered — Should-fix. The pgTAP `item_vendors_rls.test.sql` assertion-12 failure is judged PRE-EXISTING local-dirty-fixture (hand-seeded spec-114 order codes in the local DB), NOT a spec-116 regression: reproduced on `main` with staged changes stashed, the RLS write was still correctly blocked, and CI `test.yml` was green on the last push (d66d6d2) with a fresh DB. Weighing it as such — not a ship blocker.
- **backend-architect**: 0 Critical, 1 Should-fix (S1), 3 Minor. Contract, migration additivity, RLS posture, and `db.ts` centralization all land as designed. S1 (OWNER QUESTION): the brand-shared US FOOD vendor row means all 4 stores emit the SAME CUSTOMER NUMBER (`cfg.accountNumber`); real US Foods accounts usually have a distinct per-location ship-to/customer number, so 3 of 4 stores could upload under the wrong account — a silent wrong-account order. The current schema cannot express a per-(store,vendor) override; that override is explicitly out of scope and needs owner confirmation before the export is relied on across all 4 stores.

## Owner decision required (may gate cross-store use)
**Per-store US Foods customer number (backend-architect S1).** Before this export is used by more than one store, the owner must confirm: do all 4 stores genuinely share ONE US Foods customer number?
- If YES → no code change; record the fact in the spec (the schema silently assumes it).
- If NO → the export is unsafe for 3 of 4 stores as built (silent wrong-account orders). A per-(store,vendor) customer-number override is a separate spec (out of scope here); until then the export should be limited to the single store whose customer number matches the brand vendor row.
This is a product decision, not a code defect — surface it to the owner regardless of the code fixes below. Do not auto-add the override table.

## Recommended next steps (ordered)

FIXES_NEEDED — must-fix before commit:

1. **[Critical — code-reviewer] `db.ts:2972` `updateVendor` swallows the Supabase error.** Destructure `{ error }` from the terminal `.update(...)` call and `if (error) throw error;`, mirroring `updateStore` (`db.ts:121-126`). First because it is a Critical, it is load-bearing for this feature's own writes (account/customer number + the 3 import fields), and it unblocks a correct regression test in step 2.
2. **[Critical — test-engineer] Cover the `onCsvPress` US-Foods branch (AC12/AC13) AND close AC4/AC5 correctly.** (a) Add a jest/RTL test in `ReorderSection.test.tsx` mocking `useStore` to return one `us_foods`-tagged vendor + matching `exportPayload`, spying on `triggerDownload`/`Blob`: assert the `USFoods_ImportOrder_<slug>_<date>.csv` filename, that vendor header fields are threaded through, the toast counts, and that the generic-CSV path is NOT taken; a second test with two displayed vendors covers Risk 1. (b) In `db.updateVendor.test.ts`, add the field-persistence assertions for `accountNumber` + the 3 new fields AND a test that mocks the terminal call to resolve `{ error }` and asserts `updateVendor` REJECTS — the latter only passes once step 1 lands, so it also verifies the fix. Depends on step 1.
3. **[Should-fix — security-auditor] Neutralize CSV formula injection in `usFoodsImport.ts`.** Prefix a leading `'` (or `\t`) on any cell value starting with `= + - @`, tab, CR, or LF, applied to at least `PRODUCT NUMBER` (`order_code`, staff-writable) and `DESCRIPTION` (`itemName`), defensively to the header account fields. Ship-blocking here because this spec introduces the staff-writable `order_code` sink into an admin-opened file (the generic `reorderExport.ts` path is a follow-up, not this commit).
4. **[Should-fix — code-reviewer] Risk 1 silent vendor-drop toast cue.** Append an omitted-vendor note to the success toast when `exportPayload.vendors.length > 1` and a US-Foods vendor was chosen, so a manager isn't surprised other vendors' rows are missing. (Same finding as backend-architect M3.)
5. **[Should-fix — code-reviewer] i18n the new segmented control.** Add `section.vendors.orderImportFormat*` keys (en/es/zh-CN) for "Order import format" / hint / "Distributor #" / "Department", matching the sibling `orderUnit` control's pattern in the same file.
6. **[Should-fix — code-reviewer] Narrow `Vendor.orderImportFormat`** from bare `string` to `'' | 'us_foods'` in `src/types/index.ts:470`, matching the sibling `orderUnit` union and the drawer's own `FormValues`, so a typo'd tag fails at compile time.

Follow-ups (not blocking this commit):
- AC1 pgTAP shape assertions in `vendors_role_access.test.sql` (3 `has_column`/`col_is_null`) to match the sibling spec-115 convention.
- AC3 `db.fetchVendors.test.ts` for the new null→undefined/`''` mapping.
- Formula-injection neutralization in the generic `reorderExport.ts:234` path (parallel to step 3).
- code-reviewer nits: hoist the duplicated date expression; unify `cfg`/`usCfg`→`vendor`, `vendorsList`→`vendors` naming; align null-normalization convention across the 3 new fields; collapse the double DEPARTMENT-default.

## Out of scope for this review
- **Per-(store,vendor) customer-number override table/JSONB** (backend-architect S1) — a separate spec, gated on the owner decision above.
- **Generic `reorderExport.ts` formula-injection hardening** — parallel pre-existing gap; follow-up spec.
- **`item_vendors_rls.test.sql` assertion-12 pgTAP failure** — judged pre-existing local-dirty-fixture (hand-seeded local DB), not a spec-116 regression and not a ship blocker; raise as a separate fixture-hygiene ticket so the local pgTAP track returns to 65/65. CI `test.yml` was green on d66d6d2.
- **A second vendor format (Sysco, etc.)** and the `CHECK`-allowlist-vs-text-tag decision (backend-architect M1) — decide in that format's spec.
- **Surfacing `order_code` from `report_reorder_list`** (backend-architect M2) — client-side resolution is the correct call for this spec; a future contract decision.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 6 must-fix items (2 Critical, 4 Should-fix), top: db.ts updateVendor swallows the Supabase error (silent save-failure). Plus an OWNER DECISION — confirm all 4 stores share one US Foods customer number before cross-store use.
payload_paths:
  - specs/116-us-foods-import-order-csv/reviews/release-proposal.md
