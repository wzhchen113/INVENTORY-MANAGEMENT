## Test report for spec 184

### Acceptance criteria status
pgTAP file: `supabase/tests/stock_store_from_store.test.sql` (196 assertions, T-1..T-36). Jest paths abbreviated.

- AC-1 (counts + jsonb keys) -> PASS, pgTAP T-2 (keys pinned)
- AC-2 (per-field reset/copy) -> PASS, pgTAP T-3 (non-zero stock/eod/avg usage/expiry fixture)
- AC-3 (fresh ids) -> PASS, pgTAP T-4
- AC-4 (links, one primary = vendor_id) -> PASS, pgTAP T-5 (run as `authenticated`, covers the F-3 policy trap)
- AC-5 (no-link item) -> PASS, pgTAP T-6, T-7
- AC-6 (staff EOD read shape) -> PASS, pgTAP T-7
- AC-7 (source unchanged) -> PASS, pgTAP T-8
- AC-8 (partly stocked, never disturbed) -> PASS, pgTAP T-9, T-16 (conflict arm)
- AC-9 (second run no-op) -> PASS, pgTAP T-10
- AC-10 (A then B) -> PASS, pgTAP T-12
- AC-11 (all-or-nothing) -> PASS, pgTAP T-14 (forced trigger failure)
- AC-12 (empty source) -> PASS, pgTAP T-15
- AC-13 (uncarried tick, default_cost unused) -> PASS, pgTAP T-17
- AC-14 (tick now carried elsewhere) -> PASS, pgTAP T-18
- AC-15 (foreign/nonexistent tick refuses) -> PASS, pgTAP T-19
- AC-16 (null/empty ticks) -> PASS, pgTAP T-20
- AC-17 (refusals) -> PASS, pgTAP T-21..T-28 with anti-vacuity probes. The null-`brand_id` bullet is unreachable (`stores.brand_id` NOT NULL); pinned by T-29 `col_not_null` (design F-5, acceptable substitute).
- AC-18 (cross-brand link) -> PASS, pgTAP T-30 (skip and report)
- AC-19 (grants, overload, search_path, prosecdef, no order_schedule write) -> PASS, pgTAP T-31
- AC-20 (specs 179/177 coexist, lints unmodified) -> PASS, pgTAP T-32; `inventory_items_identity_lock` (80), `cross_store_item_rejection` (54), `public_grants_explicit`, `permissive_policy_lint` (5) pass; `git status` shows none of them modified
- AC-21 (one audit row) -> PASS, pgTAP T-33, T-10, T-14
- AC-22 (S1-S4 states) -> PASS, `src/lib/eodEmptyState.test.ts` + `EODCountSection.emptyState.spec184.test.tsx`
- AC-23 (partial links = no S2) -> PASS, same two files
- AC-24 (reset on store switch, `+ vendor` enabled) -> PASS, `EODCountSection.emptyState.spec184.test.tsx`; also browser-verified
- AC-25 (three-locale keys) -> PASS, keys present in en/es/zh-CN; `src/i18n/i18n.test.ts` passes in the full jest run
- AC-26 (phone) -> PASS, `eod/__tests__/PhoneEodCount.test.tsx`, `EODCountSection.emptyState.spec184.test.tsx`
- AC-27 (STOCK button, testID, label, 44x44 hitSlop like EDIT) -> PASS, `StoresTab.stock.spec184.test.tsx`; responsive sheet at phone width browser-verified only
- AC-28 (source picker) -> PASS, `StockStoreDialog.test.tsx`; pgTAP T-35 for the data side
- AC-29 (no source available) -> PASS, `StockStoreDialog.test.tsx`; browser step 6
- AC-30 (pre-write statement) -> PASS, `StockStoreDialog.test.tsx`
- AC-31 (nothing to add) -> PASS, `StockStoreDialog.test.tsx`; browser step 4
- AC-32 (uncarried list) -> PASS, `StockStoreDialog.test.tsx`; browser step 5
- AC-33 (result message + refresh) -> PASS, `src/utils/stockResult.test.ts`, `StockStoreDialog.test.tsx`, `StoresTab.stock.spec184.test.tsx`, `useStore.stockStore.spec184.test.ts` (reload behavior); browser-verified
- AC-34 (no-schedule warning) -> PASS, `stockResult.test.ts`, `StoresTab.stock.spec184.test.tsx`; pgTAP flag
- AC-35 (failure keeps dialog, no double call) -> PASS, `StockStoreDialog.test.tsx` ("a second press in flight sends no second call"), `useStore.stockStore.spec184.test.ts`
- AC-36 (db.ts wrappers, slice action, no direct supabase in components) -> PASS, `db.stockStore.spec184.test.ts`, `useStore.stockStore.spec184.test.ts`; `grep supabase` on `StockStoreDialog.tsx` and `StoreFormDrawer.tsx` returns nothing. (D-15 reads go through `db.fetchInventory`/`db.fetchVendors`, still in db.ts.)
- AC-37 (no item-selection UI) -> PASS, `StockStoreDialog.test.tsx`
- AC-38 (Stock from field, n/N footer, edit unchanged) -> PASS, `StoreFormDrawer.test.tsx`
- AC-39 (uncarried count after create) -> PASS, `StoreFormDrawer.test.tsx`, `stockResult.test.ts`, `StoresTab.stock.spec184.test.tsx`
- AC-40 (addStore promise, revert, notify) -> PASS, `useStore.addStore.spec184.test.ts` (incl. mid-flight reload case), `StoreFormDrawer.test.tsx`
- AC-41 (created but not stocked, retry) -> PASS, `StoreFormDrawer.test.tsx`, `StoresTab.stock.spec184.test.tsx`
- AC-42 (same result content, schedule warning on create path) -> PASS, `StoreFormDrawer.test.tsx`, `StoresTab.stock.spec184.test.tsx`
- AC-43 (refresh doesn't drop new store) -> PASS, `StoresTab.stock.spec184.test.tsx`, `StoreFormDrawer.test.tsx`
- AC-44 (gates) -> PASS with a local caveat, see below
- AC-45 (browser pass) -> PASS as recorded, "## Browser verification (AC-45)" in the spec. Not re-run by me (no browser tool in this session). It covers steps 1-7 at 1440 and 375 widths. Stated gaps: failed-load state (N5) is jest-only, dark mode, native, second-admin realtime, staff EOD at a stocked store.
- AC-46 (prod apply runbook) -> PASS (design deliverable): spec section 10 has Steps 1-6, probes and rollback. Nothing applied to prod, as intended; it still needs the owner's go-ahead.

Totals: 46 PASS, 0 FAIL, 0 NOT TESTED. AC-45 and AC-46 are a recorded manual pass and a document, not automated tests.

### Test run
- `npx jest` (full): 296/296 suites, 3755/3755 tests, 17/17 snapshots, 0 failures.
- `npx tsc --noEmit --types <24 real @types names, the " 2" dirs excluded>`: exit 0, no output.
- `npm run typecheck:test`: exit 0.
- Plain `npm run typecheck`: fails locally with TS2688 on the stray `node_modules/@types/* 2` directories (confirmed, not touched). This is local-only. `node_modules` is gitignored, and `.github/workflows/test.yml` job `typecheck-base` runs `npm ci` and then `npm run typecheck`, so CI has a clean tree. The `--types` substitute covers the same graph (tsconfig.json include/exclude unchanged).
- `./scripts/test-db.sh` (full): 94/95 files pass, exit 1. The only failure is `supabase/tests/order_approvals_fk_set_null.test.sql` (failed tests 5-12, i.e. 8 assertions, matching what you described; untracked, other session, untouched). `stock_store_from_store.test.sql` PASS (196 assertions). The four AC-20 suites PASS.

Migration replay check (shared DB not reset):
- `supabase/migrations/20261105000000_stock_store_from_store.sql` is the newest on disk (previous: `20261027000000`), so no slot collision.
- Method: one `psql` session on the local container with my own `begin` ... `rollback`. I stripped the file's own `begin;`/`commit;` (its `lock_timeout` stays), dropped both functions, confirmed they were absent, applied the file body from scratch, checked results, applied it a second time (idempotent `create or replace`), then rolled back. After the rollback the functions were still present, so the shared DB is unchanged.
- Result: no errors under `ON_ERROR_STOP`. After the replay both functions have `prosecdef=f`, `proconfig={search_path=public}`, anon EXECUTE false, authenticated EXECUTE true. The second pass also succeeded.
- Limit: this proves the file applies cleanly against the current local schema from a "functions absent" state. It does not prove a full-chain `supabase db reset` replay (earlier migrations are unchanged and already in this DB, and the file has no non-function DDL, so risk is low). CI's pgTAP job does a fresh stack and will exercise the full chain. I did not recompute the design's normalized md5s; the raw `pg_get_functiondef` md5s I saw are not comparable to the recorded values.

### Notes
- No tests added: no real gap found. I did not modify any file apart from this report.
- Not independently re-verified: the AC-45 browser pass, and phone-width layout (jest cannot see it).
- The backend "two-psql" concurrency probe is documented in the spec; I did not repeat it. pgTAP T-16 covers the conflict arm.
- Open observation from the browser notes: "SUBMIT COUNT stays enabled at 0 items", unverified behavior, outside this spec's ACs.
- Before pushing: apply the migration to prod per spec section 10 first, otherwise `db-migrations-applied.yml` goes red. `order_approvals_fk_set_null.test.sql` will fail CI pgTAP if committed as-is by the other session; keep it out of this change's commit unless that spec's fix lands with it.
- Nothing staged or committed.
