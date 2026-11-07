# Spec 184: backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-11-05. Mode: post-impl. Spec `Status:` left at READY_FOR_REVIEW. No spec or code edited.

**Scope:** the working-tree migration, `db.ts`, `useStore.ts`, `eodEmptyState.ts`, `stockResult.ts`, `StockStoreDialog`, `StoreFormDrawer`, `StoresTab`, `EODCountSection`, `PhoneEodCount`, and the spec's `## Backend design`, `## Files changed` and section 10.

**What I couldn't run.** This pass had no shell and no database tool, so everything below comes from reading files. The md5s, the 196 pgTAP assertions, the jest totals and the browser pass are other agents' records. Prod's `max_rows` is not visible from the repo, and I did not learn it.

## Verdict

**No Critical findings.** The migration and the store slice match the design's contract: gates and messages, D-1 to D-9, return keys, grants, D-10, D-11, D-13 and N5. I found no unlisted backend drift. No component calls `supabase` directly.

| Severity | Count |
|---|---|
| Critical | 0 |
| Should-fix | 3 |
| Minor | 6 |

The two design questions that came back to me are both errors in my design, not developer drift. The developer built D-14's stop condition and the `scheduleConfigured` input exactly as I specified them.

## Judgment 1: the listed deviations

`## Files changed` has a "Frontend deviations" list only. The backend half lists no deviations, just the note that the vendor mapper already exposes `importCustomerNumbers`. That note is correct ([db.ts:2336](../../../src/lib/db.ts)).

**D-15 reading through `db.ts` from `StoresTab`: accept. Section 11 of my design was wrong.** Both of the developer's reasons hold:
- `stockStoreFromStore` doesn't await its reload ([useStore.ts:3598-3600](../../../src/store/useStore.ts)), as D-11 requires. When the result arrives, the `inventory` slice lacks the new rows, so a freshly stocked store would never warn.
- The `vendors` slice holds the current store's brand ([db.ts:6046](../../../src/lib/db.ts)), and the Brands tab can be showing a different brand.

Alternatives I weighed:
- Awaiting the reload would delay the result and still wouldn't fix the brand mismatch.
- Adding the gap to the RPC's return would give one snapshot, but it changes the contract and the md5s for a one-line warning.

This isn't a new pattern. `StoresTab` already reads through `db.fetchStoresIncludingInactive` ([BrandsSection.tsx:1144](../../../src/screens/cmd/sections/BrandsSection.tsx)). AC-36 still holds: the reads use `track`-wrapped `db.ts` helpers, and the stock traffic itself goes through the slice action. The implementation at [BrandsSection.tsx:1216-1238](../../../src/screens/cmd/sections/BrandsSection.tsx) reads after the commit, drops a stale response through the generation ref, and reports a failed check instead of showing nothing. `fetchVendors` throws on error ([db.ts:2303](../../../src/lib/db.ts)), so that failure path is reachable. Treating a blank entry as missing goes slightly past D-15's wording, and it's correct: `vendorImportShared.ts:82` falls back on a blank value too.

| Other listed deviation | Ruling | Why |
|---|---|---|
| AC-39 line suppressed when the brand has no source ([stockResult.ts:150](../../../src/utils/stockResult.ts), [StoreFormDrawer.tsx:205](../../../src/components/cmd/StoreFormDrawer.tsx)) | Accept | The literal AC-39 would point at a `STOCK` action that AC-29 leaves with no list and no submit. A failed preview correctly leaves it on. The state doesn't exist on prod today. |
| AC-33 "ticked rows added" shown only once something was ticked ([stockResult.ts:76](../../../src/utils/stockResult.ts)) | Accept | A literal reading of AC-33 would print "0 ticked catalog rows" on every 2AM run. The test-engineer may note the wording gap, but it isn't drift from the contract. |
| Inert close paths in create mode only ([StoreFormDrawer.tsx:148-151](../../../src/components/cmd/StoreFormDrawer.tsx)) | Accept | Section 6 didn't scope them, and AC-38 keeps edit mode unchanged. AC-43's race exists only on create. |
| `links_skipped_cross_brand` gets a result line ([stockResult.ts:90](../../../src/utils/stockResult.ts)) | Accept | My AC-18 choice was "skip and report". Without this line, nothing reports it. |
| `confirmAction` not used | Accept | The design adds no extra confirm. AC-30 is the confirm step. |
| Dialog, drawer and panel copy in hardcoded English | Accept | This is what section 6 says. |

## Judgment 2: D-14's stop condition

**Recommendation: continue until an empty page.** Change the stop at [db.ts:333](../../../src/lib/db.ts) from "shorter than 1000" to "zero rows". The check must stay above the `page[page.length - 1]` read.

**The backend developer's concern is correct.** PostgREST applies the smaller of the client's `limit` and its `max_rows`, per its documented behavior; I haven't run this against a lowered value. With `max_rows = 500` the first page has 500 rows, reads as short, and the loop stops at row 500 with no error. That is the same silent loss D-14 exists to remove.

My finding F-2 said the fix "is harmless at any value". It is harmless, but it isn't effective at any value, and I didn't say so. The comment at [db.ts:282-283](../../../src/lib/db.ts) carries the same assumption: it treats `supabase/config.toml` as if it governed prod, and that file only configures the local stack.

**How likely this is.** Probably unlikely today. The repo's value is 1000, and I understand 1000 to be Supabase's default. Prod has about 584 rows, so a value below that would already be hiding items. A value between 584 and 999 would show nothing yet, and would then fail exactly as F-2 describes as stores are added. That's why this is Should-fix and not Critical.

| Option | Correct at any `max_rows`? | Cost | Ruling |
|---|---|---|---|
| Keep short-page stop, and read prod's value once | No. It proves today only, and a later dashboard change brings the bug back with no signal. | None | Reject |
| **Stop on an empty page** | Yes | One more request per all-stores load | **Choose** |
| `select(..., { count: 'exact' })`, stop when the count is reached | Yes | No extra request, but the count re-evaluates RLS over every visible row, on every page of every reload, and it adds a second stop condition and a nullable count | Reject. It's the fallback if the extra round trip ever shows up in a measurement. |
| Lower the page size, say to 500 | No. It only moves the threshold. | More requests past the threshold | Reject |

**What the extra request costs (reasoned, not measured):**
- **Volume.** `fetchAllForStore` makes about 16 requests today, so this adds one. No production path uses the `__all__` fan-out ([useStore.ts:2205-2207](../../../src/store/useStore.ts)), so it isn't multiplied per store.
- **Latency.** The request runs after the first page, so the inventory read takes one more round trip.
- **Server work.** It's a primary-key range scan past the last visible id, with embeds over zero rows, which is less than the count option.
- **Failure exposure, the real cost.** A transient failure on this request rejects the read, sets `inventoryFailed` and blanks the slice under D-13, even though the first page was good. It can't be softened: returning what we have on a failed page is the same silent truncation. I accept this. The two requests run back to back, the screen says `itemsNotLoaded` and not "no items", and the next reload heals it. The follow-up to keep prior rows on a failed reload (section 11) becomes slightly more valuable.

**The change needs test work first, or jest will hang.** `wire` at [db.fetchInventoryPaging.spec184.test.ts:157-174](../../../src/lib/db.fetchInventoryPaging.spec184.test.ts) returns the same rows whatever the cursor. Under the new stop, the case at L190-195 never terminates. It loops on resolved promises without yielding to timers, so jest's timeout may not rescue it. Make `wire` return an empty page once `.gt` has been called. Then:
- update the request counts: L67-75 from 1 to 2, L77-96 from 3 to 4, L117-125 from 2 to 3;
- add a capped-server case: pages of 500, 500 and 31 rows give 1031 rows and 4 requests. This is the case the current code fails.

I grepped for other exposure: the only test calling the real no-argument `fetchInventory()` or the real `fetchAllForStore` is this file. The `useStore` suites that reach `loadFromSupabase` mock `db`.

Production can't loop forever: `id > cursor`, ordered by primary key, always advances. No page cap is needed.

Only TypeScript changes, so the two function md5s stay valid.

## Judgment 3: `scheduleConfigured` in `deriveEodEmptyState`

**It's dead API. Remove it.** This is my signature's fault: the D-12 table never read the field.

It can't matter from the real call site. Rows 1-6 don't read it. Rows 7 and 8 need `vendorTabsCount = 0` and `allVendorTabsCount > 0`, and [EODCountSection.tsx:467](../../../src/screens/cmd/sections/EODCountSection.tsx) returns `allVendorTabs` when no schedule is configured. So reaching those rows already implies it's true. The test at [eodEmptyState.test.ts:114-116](../../../src/lib/eodEmptyState.test.ts) pins that a parameter does nothing, and a reader of the signature could reasonably assume stores with no schedule are handled there.

Remove:
- the field at [eodEmptyState.ts:42](../../../src/lib/eodEmptyState.ts);
- the argument and dependency at [EODCountSection.tsx:482](../../../src/screens/cmd/sections/EODCountSection.tsx) and L487;
- `base.scheduleConfigured` and the L114-116 test in `eodEmptyState.test.ts`.

The local `scheduleConfigured` memo stays. `vendorTabs`, the toggle (L1376) and the pills (L1641) use it.

## Judgment 4: section 10 against the migration

**The runbook still matches the migration as written.** I read each item against [the migration](../../../supabase/migrations/20261105000000_stock_store_from_store.sql) and found no mismatch. The probes were not executed.

| Runbook item | Migration or repo | Result |
|---|---|---|
| Version and name, Step 3 | Filename, and header L39-41 | Match |
| "line 1 to the final `commit;`", Step 2 | `begin;` L46, `commit;` L489, header L37-38 | Match |
| Signatures, Steps 1 and 4 | `(uuid,uuid,uuid[])` L50-54, `(uuid,uuid)` L342-345 | Match |
| `prosecdef` f, `{search_path=public}`, no PUBLIC, `auth_x` true | L58-59, L349-350, L483-487 | Match |
| Probe 1 message | `stock_store: privileged only`, L93 | Byte match |
| Probe 1 "no claims means not privileged" | `auth_is_admin` reads the JWT, `auth_is_super_admin` reads `auth.uid()` | Holds |
| Probe 2 claims (`sub` only, no `app_metadata`) | `auth_is_super_admin` passes through `profiles`, so G-1, G-4 and G-7 pass | Holds |
| Probe 2 `items_copied`, one `Store stocked` row | L326, L298 | Match |
| Probe 2 store insert | Same columns as the pgTAP fixture (`brand_id`, `name`, `address`) | Holds |
| Step 1's five `inventory_items` triggers, none on `item_vendors` | Grep across all migrations finds exactly these five | Match |
| `inventory_items_store_catalog_unique` | [p3_lockdown:42](../../../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql) | Match |
| "Nothing at or after this version" | Newest other migration on disk is `20261027000000` | Holds |

The recommended changes in this review touch no SQL, so the recorded md5s and the runbook's Steps 2-5 don't need to change. M-1's fresh recompute is still the binding check.

The gaps are around the runbook, not in its match to the file: S-3 and M-2 to M-4 below.

## Findings

### Critical

None.

### Should-fix

**S-1. D-14 stops on a short page, so a prod `max_rows` below 1000 still truncates silently.** [db.ts:333](../../../src/lib/db.ts). Stop on an empty page; see Judgment 2. Also correct the comments at L282-283 and L291-292, and the tests listed there.

**S-2. AC-44 and AC-20 have no recorded pgTAP result.** `## Files changed` records "196 assertions" for the new file, but no pass count and no full `scripts/test-db.sh` run. The frontend half marks that script not verified, because that half changed no SQL. So nothing here shows that the new suite passes or that `inventory_items_identity_lock`, `cross_store_item_rejection`, `public_grants_explicit` and `permissive_policy_lint` pass unmodified. Plain `npm run typecheck` also wasn't run; the substitute is recorded with its reason. Record the run before ship. Expect `order_approvals_fk_set_null.test.sql` to be red, per S-3.

**S-3. Section 10 Step 6 doesn't guard against pushing spec 178's untracked test.** `supabase/tests/order_approvals_fk_set_null.test.sql` is still untracked, and no spec 178 migration is on disk. Spec 179 recorded it failing 8 of 12 (its §10 Step 6). I couldn't re-run it. If a broad `git add` picks it up, `test.yml` goes red on the push that Step 6 then has to confirm green. Step 6 should say: stage the paths listed under `## Files changed` explicitly and leave that file out.

### Minor

**M-1. `scheduleConfigured` is dead input.** [eodEmptyState.ts:42](../../../src/lib/eodEmptyState.ts). Remove it; see Judgment 3.

**M-2. The rollback text only works before the push.** Spec line 775. Once the file is on `main`, deleting the version row makes `db-migrations-applied.yml` hard-fail. After Step 6, rollback needs a forward migration that drops the functions, and the version row stays.

**M-3. `PROBE SKIPPED` has no stated meaning.** Spec line 771 defines only `PROBE FAILED`. Spec 179 gives the wording to reuse: fall back to Step 4 plus the local pgTAP run.

**M-4. Step 1 sizes "distance to the F-2 cap" against an assumed 1000.** Spec line 705. Add a report-only read of prod's `max_rows` from the dashboard's API settings. After S-1 this no longer affects correctness, but the number is still worth knowing, since `fetchInventory(storeId)` and other reads are unpaged.

**M-5. Three parts of my design are now superseded.** I left them as instructed, and whoever next edits the spec should update them:
- F-2's "harmless at any value";
- section 5's D-14 "until a page comes back short", and its line about an exactly-1000-row page;
- section 11's D-15 "compute from the vendors already in the slice".

**M-6. SUBMIT COUNT at 0 items is safe but says the wrong thing.** This answers the browser pass's open question, from reading the code rather than pressing it. With no items, `missing` is empty, `buildSubmission` returns null ([EODCountSection.tsx:887](../../../src/screens/cmd/sections/EODCountSection.tsx)), and `onSubmit` shows the `enterAtLeastOne` toast (L1013-1015). Nothing is written. Telling someone to enter a count at a store with nothing to count sits awkwardly beside S1, so it's a copy decision for the owner. Phone uses the same `onSubmit` (L1346).

## Confirmed without a finding

- **Concurrency.** The recorded probe (advisory wait, 0 added, no duplicates) matches D-1 and D-2.
- **Reload count.** The browser pass's two reloads per run match section 7's prediction.
- **F-3.** T-5b executes the writable-CTE refusal rather than assuming it.
- **N5.** `inventoryLoadStatus` is written in the same `set` as `inventory` ([useStore.ts:2288-2292](../../../src/store/useStore.ts)), so a dropped load writes neither.
- **N6 and AC-24.** Implemented as designed ([EODCountSection.tsx:328-330](../../../src/screens/cmd/sections/EODCountSection.tsx), L1374-1379).

## Still open

- Whether prod's `max_rows` is 1000 (M-4).
- The realtime burst with a second admin connected, which section 7 and the browser pass both leave unmeasured.
