## Verdict
verdict: SHIP_READY
rationale: Zero Criticals across all four reviewers, the lone Should-fix is already fixed, and the core ordering-bug acceptance criterion is deterministically proven.

## Findings summary
- code-reviewer: 0 Critical, 1 Should-fix, 3 Nits. Should-fix (stale block comment above the `item_vendors` reconcile in `db.ts:466-474` not mentioning the new demote step) is ALREADY FIXED — the comment now documents demote → upsert → delete ordering. The 3 nits are all cosmetic test-file items (unused `itemVendorsBuilders` collection, imprecise mock-scope comment, unused `catalog_id` mock field) left as-is, non-blocking. Fix placement, null-handling, abort-signal threading, and call-order assertions all confirmed correct.
- security-auditor: 0 Critical, 0 High, 0 Medium, 0 Low. All three requested confirmation points hold — RLS parity (demote governed by the pre-existing `store_member_update_item_vendors` policy, scoped to `item_id`), no injection (all values bound method args), no new data exposure/secrets. No migration/RPC/edge/RLS surface touched.
- test-engineer: NOT BLOCKING. Core AC (primary switch on a 2-vendor item no longer trips `item_vendors_one_primary_per_item`) is PASS via deterministic demote-before-upsert ordering proof; AC4 (`primaryVendorId=null` demote-all) PASS; AC8 (named jest track) PASS. AC2/AC3/AC5/AC6/AC7 NOT TESTED at db.ts write-path level — AC2's "verified by a DB read" was named "optional" in the design and is a genuine but non-blocking gap (recommend follow-up pgTAP/shell). AC5/6/7 paths are byte-for-byte unchanged (additive diff), low-risk by inspection. Full jest 1218/1218 green, tsc + typecheck:test clean, targeted 5/5. One pre-existing UNRELATED pgTAP failure (`item_vendors_rls.test.sql` test 12) confirmed present going in — no migration/RLS change in this spec, out of scope.
- backend-architect: 0 findings. No drift — implementation matches the design on all five checked points (pre-demote shape/placement, demote→upsert→delete ordering, no `updated_at` in demote payload, no migration/RPC/edge and `createInventoryItem` untouched, named jest ordering test). Accepted non-atomic 3-call window is as-designed for v1.

## Recommended next steps (ordered)
1. Commit and deploy. No prod-side action required — this spec ships no migration, RPC, or edge function, so only the `test.yml` gate applies (the `db-migrations-applied.yml` gate is irrelevant this spec). Confirm the latest `test.yml` run on `main` is green after push before considering the pipeline closed.
2. (optional, non-blocking) Trim the 3 test-file nits when next touching the file: drop the dead `itemVendorsBuilders` collection, tighten the mock-scope comment at `:142`, and reduce the `single()` mock to `{ vendor_id: null }`.

## Out of scope for this review
- Follow-up pgTAP/shell smoke that drives a real 2-vendor primary switch against the local stack and reads back `item_vendors.is_primary` to close AC2/AC3 with an actual DB read (design named this "optional / belt-and-suspenders"; track separately).
- Pre-existing `item_vendors_rls.test.sql` test 12 failure — a non-member UPDATE can still write `order_code` on a link it shouldn't see. Predates spec 124, no RLS change here; belongs in its own RLS-hardening spec.
- Backfilling dedicated db.ts write-path regression tests for AC5/AC6/AC7 (cost/case-price/order-code payload, single-vendor/no-change path, delete-de-selected-link) — a pre-existing coverage gap in `updateInventoryItem`'s vendor-link reconcile, not introduced by this spec.
