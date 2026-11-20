# Spec 188: Repair the Breadbot nightly sync

Status: READY_FOR_BUILD

Origin: the owner approved starting this on 2026-11-08 after a read-only prod investigation (`pos-imports-empty-investigation.md`, session notes `local_0a6faf4e-0fd8-4bf7-892f-47aeb351d71f`). Prod facts below come from that investigation and the main session's dispatch, and are cited, not re-derived, because the product manager has no prod access. Code facts were read from the working tree on 2026-11-08, and line numbers are pointers. Spec 184 flagged part of this earlier ([184 L803](184-stock-new-store.md)).

**Owner acceptance (2026-11-08):** the owner replied "All defaults OK", relayed verbatim by the main session. That covers the whole confirm list: D-A to D-E, P-1 to P-11, and item 17 (COGS at 0.0%). The decisions and details below are settled. D-E wasn't in the original request: the product manager found while reading the code that the repair alone wouldn't fill the POS Imports screen. **One fact stays unanswered:** the owner accepted D-B's default but didn't say whether Breadbot has H Street and Kenyon (PF-6). It doesn't block this spec.

## User story

As the **owner of 2AM PROJECT**, I want the nightly Breadbot sync to import each store's sales again and to tell me when it fails, so that variance, COGS and velocity reports are computed from real sales, and the sync can't stay broken for months without anyone noticing.

## Decisions (owner-settled, 2026-11-08)

| # | Question | Owner's decision | Why |
|---|---|---|---|
| D-A | Import sales only, or also deduct `current_stock`? | **Import only, first.** | See "D-A in detail" below. Deduction would lower `current_stock` nightly for the first time since May, and it would change reorder suggestions. |
| D-B | H Street and Kenyon are active but not in `STORE_MAP`. What happens to them? | **Both stay out of `STORE_MAP`.** Whether Breadbot has them is still unanswered (PF-6). | No change until the owner confirms. If they were added later, they'd be the fourth and fifth store, which is the point where the code comment says the map should move to a table ([index.ts L22-23](../supabase/functions/breadbot-nightly-sync/index.ts)). |
| D-C | How far back to backfill? | **30 days ending yesterday,** cut short if the pre-flight shows Breadbot holds less. | See "D-C in detail" below. |
| D-D | Should variance, COGS and velocity warn when the window has no sales data? | **Yes, but as a follow-up spec,** not built here. | With data flowing, the warning only matters on gap days, and it means editing three long report functions. |
| D-E | Should the admin app load imports from the database? **(Raised by the product manager.)** | **Yes, in this spec,** as a separately landable change (R7). | Without it, the POS Imports table, recipe sales and the current store's Dashboard POS figures would stay empty after a successful repair. See "What the repair changes". |

### D-A in detail
- **Why import-only first.** The reports only need sales rows. Deduction adds risk and fixes nothing the owner has reported.
- **Double counting.** EOD counts now also set `current_stock` ([20261024000000 L262-270](../supabase/migrations/20261024000000_eod_entries_no_need.sql)). A count taken at close already reflects that day's sales. Deducting the same sales at 10:00 UTC the next morning would count them twice for any counted item, until its next EOD. This is reasoning from the code, not something measured.
- **Reorder suggestions would change under deduction.** The fact that a repair leaves suggestions alone (`usage_per_portion` is 0 on all 739 items in the 5 active stores checked) only holds for import-only. Deducting lowers `current_stock`, which is the `on_hand` used for any vendor with no EOD that day ([L506-511](../supabase/migrations/20261024000000_eod_entries_no_need.sql)), and `par_replacement` is computed from `on_hand`.
- **The manual paths still deduct.** `importPOS` deducts on the single-day fetch, the range backfill and CSV ([useStore.ts L3424](../src/store/useStore.ts)). Under import-only, the nightly and manual paths behave differently. This spec doesn't change that (P-9).
- **If deduction is ever on, prep recipes are handled like this:** a sale expands through `recipe_prep_items` and `prep_recipe_ingredients` with the same flatten the reports use: `rpi.quantity × pri.quantity`, walking `sub_recipe_id`, depth cap 5, cycle guard ([variance L259-299](../supabase/migrations/20260514120020_report_run_variance_multivendor.sql)). Each leaf converts to the item's tracking unit through `catalog_ingredients`. An unconvertible leaf is skipped and counted in the response, never applied 1:1. A truncated recipe is reported. Today's sync ignores prep, and `importPOS` ignores prep and falls back to 1:1 on an unknown unit (L3438).

### D-C in detail
What each reader needs from `import_date`:

| Reader | Window | Source |
|---|---|---|
| Variance, as the report modal seeds it | The days between the last two submitted EOD dates, usually a few | [seedVarianceDates.ts](../src/utils/seedVarianceDates.ts), variance L369-370 |
| Velocity and COGS defaults | 30 days | velocity L144-145, COGS L111-114 |
| Weekly low stock, reorder rate | Trailing 7 days | lowstock L197-198 |
| Dashboard | 14 days | [DashboardSection.tsx L287](../src/screens/cmd/sections/DashboardSection.tsx) |
| Unmapped review, retroactive alias fix | 30 days | [db.ts L4433, L4466](../src/lib/db.ts) |

- **Why 30 days.** It covers every default window. It's also the limit of the repair tools: a line left unmapped on an older import can't be fixed through the UI.
- **Going deeper.** A variance run with custom dates could use older sales, but only back to the oldest EOD anchor. `specs/186-retention-purge-server-job.md` reports 2026-04-16, mostly Charles (figure relayed, not re-run). Nothing earlier has an anchor to reconcile against.
- **The purge.** `cleanupOldRecords` keys on `imported_at`, not `import_date` ([db.ts L6249](../src/lib/db.ts)). A backfilled row gets `imported_at = now()`, so it lasts 90 days from the backfill however old its sales date is. Backfill depth therefore doesn't affect retention. Nightly rows would age out at 90 days until the retention spec ships; it keeps `pos_imports` with no age limit.

## Current state (verified)

### The failure (prod, from the investigation)
- `breadbot-nightly-sync` (pg_cron job 5, 10:00 UTC) fails for Frederick, Charles and Towson with `recipes: column recipes.store_id does not exist`, seen in logs on 2026-11-02 and 2026-11-08.
- It has **probably** failed since migration [20260504072830_brand_catalog_p3_lockdown.sql](../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql) (L53). This is inferred: the deployed v16 dates from 2026-04-28, and logs were only checked for those two days.
- `pos_imports` and `pos_import_items` have 0 rows. No partial writes: the throw comes before the insert.
- The secret and the Breadbot API key work. Breadbot returned rows for 2026-11-07.

### Stale reads (repo copy has the same bugs)
| Read | [index.ts](../supabase/functions/breadbot-nightly-sync/index.ts) | Now |
|---|---|---|
| `recipes.store_id` | L291, type L95 | Gone (P3 L53). Recipes are brand-scoped through `brand_id` |
| `recipe_ingredients.item_id` | L303 | Gone (P3 L71). Now `catalog_id` |
| `inventory_items.unit, sub_unit_size, sub_unit_unit` | L321 | Gone (P3 L60, L63-64). Now on `catalog_ingredients` |
| `recipe_prep_items` | Not read | The reports expand it |

### Why nobody noticed
- The handler catches per-store errors and returns HTTP 200 (L472-483).
- Cron "succeeded" only means `net.http_post` was queued. **Nothing reads the response, so a non-2xx alone is also invisible.** This is why R2 needs more than a status code.
- No alert exists.

### Impact today (from the investigation; reports read as SQL, not run)
- `report_run_variance` shows all real usage as unexplained loss.
- COGS and velocity have no sales.
- POS Imports, recipe sales and Dashboard POS figures are empty.
- Weekly low stock's usage rate falls to 0.
- **Reorder suggestions are not affected,** and repairing the sync will not change them, because `usage_per_portion` is 0 on all 739 items in the 5 active stores checked. Populating it is out of scope.

### What the repair changes, and what it doesn't
Assumes D-A import-only and the backfill done. **Read from code, not run.**

| Surface | After the repair | Source |
|---|---|---|
| Variance | The sales term is real for mapped items. **Accuracy is limited; see the first three risks** | variance L356-374 |
| Velocity | Quantities and rates are real. Revenue is 0, so its "top recipe" falls back to alphabetical | velocity L225 |
| COGS | **Reads wrong in a new way, accepted by the owner for now.** Today it's empty. With rows and revenue 0, it shows `0.0%` with a warn tone and a negative gross margin | COGS L334-350 |
| Weekly low stock | Usage rate goes above 0, and `low_stock` switches to the projected rule, so **more items may flag** | lowstock L294-300 |
| Reorder `suggested_qty` | Unchanged | usage term is × 0 |
| POS Imports mapping tab | Fills, because it reads the database | db.ts L4432 |
| **POS Imports table, desktop and phone** | **Fills only because of R7 (D-E).** `posImports` is only written by `importPOS` in the same session and is never loaded from the database today | useStore.ts L1389, L3426; POSImportsSection L46, L127 |
| **Recipe sales (recipe detail)** | **Fills only because of R7 (D-E)** | RecipesSection L657-677 |
| **Dashboard, current store** | **Fills only because of R7 (D-E).** Other stores already fill from the database, and the current store is overlaid from the unloaded slice | DashboardSection L338-341 |
| Dashboard attention rules using POS | May start firing, e.g. the food-cost streak. The architect traces this | DashboardSection L285-286 |

## Requirements

### R1. Port to the catalog schema
Store, then `brand_id`, then recipes. Ingredients and units through `catalog_id` and `catalog_ingredients`, with the per-store item found on `(store_id, catalog_id)`. Check that the 57 existing `pos_recipe_aliases` still resolve (PF-3).

### R2. Failures become visible
Non-2xx when any store fails, plus an alert that reaches a person. Fit of the existing channels, read for this spec:

| Spec 162 path | Fit | Notes |
|---|---|---|
| Bell and push: `notifications` row, then `enqueue_submission_push`, then `submission-push-fanout` ([20260829000000](../supabase/migrations/20260829000000_auto_place_order_attempts.sql) L143-185) | **Good.** Reuse the shape | Already reaches super_admins and brand admins, and already has an urgent style. Needs a new type: reusing `order_failed` would push "Order NOT placed". `source_id`, `brand_id` and `store_id` are NOT NULL |
| Email: [send-order-failure-email](../supabase/functions/send-order-failure-email/index.ts) | **Poor for v1** | It takes an `attempt_id` and renders order-specific text, so it would need a sibling. All Resend mail sends from `onboarding@resend.dev`, which per project memory (2026-10-23, not re-checked) only delivers to the Resend account owner. Admins likely wouldn't receive it |

An alert sent from inside the function can't fire if the function never runs. That covers the exact failures below: a gateway 401 after a bad deploy (R3), a secret mismatch after rotation (R4), or a boot error. P-4 covers these.

### R3. Deploy pitfall
Confirmed by reading [supabase/config.toml](../supabase/config.toml) (function entries L440-541) on 2026-11-08:
- **`breadbot-nightly-sync` has no entry,** while prod runs it with `verify_jwt=false`. A plain redeploy could turn JWT checks on and make cron fail with 401, and this spec is what triggers that first redeploy since April.
- **`fetch-breadbot-sales` has no entry either.** Spec 014 states `verify_jwt = true` (L248), and its handler also checks the session itself (L91-102). Its prod setting wasn't checked (PF-1).

Both get explicit entries, in the commented style the file already uses.

### R4. Rotate the cron secret
Rotate it and stop embedding it literally in job 5, reading it from `public._edge_auth` the way job 6 `eod-reminder-cron` does (repo shape: [20260424211733 L172-186](../supabase/migrations/20260424211733_security_fixes.sql)). The old value is exposed in a session transcript. **No secret value appears in this spec, any migration, any log or any tool output** (AC-25).

The job's definition isn't in the repo at all: a search for `breadbot` in `supabase/migrations/` and `supabase/scripts/` finds no schedule. This work brings it under version control.

Named follow-up, not in scope: **`weekly-reminder-cron` also embeds a literal bearer** ([script L49](../supabase/scripts/weekly-reminder-cron.sql) shows the shape; prod value not seen).

### R5. Regression guard
Typecheck doesn't cover this function's queries: `supabase/functions/**` is excluded from both typecheck graphs ([tests/README.md](../tests/README.md)), and the Supabase client here is untyped anyway. The obvious fix, a `scripts/smoke-*.sh`, would not be a guard by itself, because **Track 3 is manual-run only and isn't in CI**. A smoke nobody runs fails the same silent way. P-7 sets the tracks.

### R6. Backfill
Recent days must be recoverable through the existing `body.date` override with stock deduction off. **A dated run never deducts, even if deduction is turned on later.**

**Do not backfill through the manual modal.** [FetchBreadbotModal.tsx L250](../src/components/cmd/FetchBreadbotModal.tsx) calls `importPOS`, which deducts stock, adjusting today's `current_stock` for sales from past days. Its dedup also means that once the function has imported a day, the modal skips it (L215-218), so running the function first is safe.

How far back Breadbot's history goes is **unknown**. It's a pre-flight check (PF-4), not an assumption.

### R7. Load imports from the database (D-E)
The store load fills `posImports` for the current store from `pos_imports`, so that imports written by the sync appear in the POS Imports table, recipe sales and the current store's Dashboard figures.

## Pre-flight (read-only, before any change)

Results go in the spec's implementation notes and to the owner. **No pre-flight or runbook step may select or print `cron.job.command`, `_edge_auth.value` or request headers.** The exposure happened because a command was printed and a redaction regex missed its format.

- **PF-1.** Read the prod `verify_jwt` setting for `breadbot-nightly-sync` and `fetch-breadbot-sales`. Expected: `false` and `true`. If the second differs, stop and ask.
- **PF-2.** Confirm job 5's identity without printing it:
  ```sql
  select jobid, jobname, schedule, active,
         command ~ 'breadbot-nightly-sync' as targets_sync,
         command ~ '_edge_auth'            as reads_edge_auth
    from cron.job where jobid = 5;
  ```
- **PF-3.** Aliases. The `recipe_id` foreign key cascades, so a dangling alias can't exist. What can break is a recipe in another brand, because the sync now only loads the store's brand's recipes. Also list any alias whose store isn't one of the three synced stores.
  ```sql
  select s.name as store, count(*) as aliases,
         count(*) filter (where r.brand_id is distinct from s.brand_id) as wrong_brand
    from public.pos_recipe_aliases a
    join public.recipes r on r.id = a.recipe_id
    left join public.stores s on s.id = a.store_id
   group by s.name order by s.name;
  ```
  Expected total: 57. A row with a NULL `store` is a global alias, and its `wrong_brand` count is meaningless. Non-zero `wrong_brand` goes to the owner and isn't auto-fixed.
- **PF-4.** Breadbot's history. Call `fetch-breadbot-sales` from an admin session for each store at candidate dates: 7, 30 and 90 days back, and 2026-05-04. It's a read-only proxy, so no secret is handled and nothing is written. Record the oldest day with rows per store, and **whether any revenue field exists upstream**: both functions hardcode `revenue: 0` and their row type declares none.
- **PF-5.** How much units disagree, which sizes the first risk below:
  ```sql
  select count(*) as lines,
         count(*) filter (where lower(coalesce(ri.unit,'')) <> lower(coalesce(ci.unit,''))) as unit_differs
    from public.recipe_ingredients ri
    join public.catalog_ingredients ci on ci.id = ri.catalog_id;
  ```
- **PF-6.** Unanswered fact: does Breadbot have H Street and Kenyon? The owner accepted D-B's default without answering this, so nothing here should assume either answer. It doesn't block the build or the runbook, because both stores stay out of `STORE_MAP` either way.

## Settled details (proposed by the product manager, accepted by the owner)

- **P-1. Alert channel: bell and push,** using the spec 162 shape with a new type `pos_sync_failed`, urgent like `order_failed`. **No email in v1,** for the reason in R2. Follow-up once a Resend domain is verified.
- **P-2. Alert cadence:** one per (store, date), on scheduled runs only. A dated run reports through its response, so a bad backfill can't send dozens of pushes.
- **P-3. What counts as failure:**
  - Any store `failed` means HTTP 500, and the body still has the per-store `results`.
  - `store_not_found` becomes `failed`. Today it's `skipped` (L269-271), so a renamed store would drop out silently forever.
  - One store's `no_upstream_data` stays `skipped`, since a closed day is legitimate.
  - **Warnings** alert but stay 2xx: every synced store with no upstream data on the same night, or a store with rows where **zero** matched a recipe. Both are silent-failure shapes.
- **P-4. A watchdog outside the function.** Each scheduled run leaves a durable record. A second pg_cron job about an hour after the sync alerts if no record exists for that morning. This is the only part of R2 that catches a function that never ran: without it, a gateway 401 or a secret mismatch would stay silent.
- **P-5. The secret gets its own `_edge_auth` row,** generated inside the database so nobody ever sees it, and the function checks against that row, as `eod-reminder-cron` does ([L139-150](../supabase/functions/eod-reminder-cron/index.ts)). `BREADBOT_CRON_SECRET` is retired. **It doesn't reuse or rotate `cron_bearer`:** that token also guards the reminders, push fan-out and failure email, and rotating it could break the literal in `weekly-reminder-cron`.
- **P-6. `fetch-breadbot-sales`:** config entry only, pinned to what PF-1 shows. It's not redeployed.
- **P-7. Guard tracks:**
  - **Track 2 (pgTAP, blocking in CI):** a contract test that fails on the PR whose migration breaks a read. This is the blocking guard for the exact failure that happened.
  - **Track 1 (jest, blocking in CI):** reads the function's source and fails if it uses a table or column the contract test doesn't cover, so the two can't drift. It also pins `STORE_MAP` parity and the config entries.
  - **Track 3 (`scripts/smoke-breadbot-sync.sh`, manual):** end-to-end behaviour against a stub Breadbot, in the `smoke-weekly-reminder.sh` / `smoke-store-user.sh` shape, local-only with an EXIT-trap cleanup. Required before deploy. Added to `npm run test:smoke`.
- **P-8. The backfill runs server-side from SQL through `net.http_post`,** with the secret read from `_edge_auth`, so nobody handles it. One date per call, at least 5 seconds apart: each date makes 3 Breadbot calls, and spec 014 documents a 60/min limit (not re-checked).
- **P-9. The manual modal is unchanged.** No copy change and no switch to turn off its deduction. Whether it should keep deducting is a follow-up.
- **P-10. Verification:** smoke plus browser preview of the bell at desktop and phone widths. No native Simulator pass.
- **P-11. Label:**

  | Key meaning | en | es | zh-CN |
  |---|---|---|---|
  | Alert title | POS sync failed | Error de sincronización POS | POS 同步失败 |

## Acceptance criteria

Test tracks are named per AC, following [tests/README.md](../tests/README.md). pgTAP fixtures are hermetic. ACs marked **prod** are recorded in the review notes.

### Port (R1)
- [ ] **AC-1:** With seeded recipes, a run imports each synced store's sales: one `pos_imports` row per (store, date), `import_date` = the target date, `imported_by` NULL, and one `pos_import_items` row per collapsed raw POS name. HTTP 200, each store's outcome `imported`. (smoke)
- [ ] **AC-2:** Recipe candidates are exactly `recipes.brand_id = stores.brand_id`. A recipe in another brand is never matched, even when its name is an exact match. (smoke)
- [ ] **AC-3:** A POS name with an alias maps to the alias's recipe, even when another recipe would match by name. An alias pointing to a recipe in another brand falls through to matching. `menu_item` stores the raw POS string and matching uses it, not the canonical name. (smoke)
- [ ] **AC-4:** The function contains no read of `recipes.store_id`, `recipe_ingredients.item_id` or `inventory_items.unit/sub_unit_size/sub_unit_unit`. (jest, AC-27)
- [ ] **AC-5:** The ported deduction path resolves ingredients through `catalog_id` to `(store_id, catalog_id)`, reads units from `catalog_ingredients`, and follows the D-A prep rule. It runs only under the server-side setting in AC-7. (smoke, with the setting on)
- [ ] **AC-6 (prod):** PF-3 is recorded and any exception was reported to the owner. After the first real import, the mapped and unmapped counts per store are reported.

### Stock (D-A, R6)
- [ ] **AC-7:** Deduction is off unless a server-side setting turns it on. No request can turn it on. The setting is off on prod (D-A). (smoke)
- [ ] **AC-8:** With the setting off, `current_stock` on every `inventory_items` row of the synced stores is unchanged after a run, checked row by row. (smoke)
- [ ] **AC-9:** With the setting **on**, a dated run still changes no `current_stock`. (smoke)
- [ ] **AC-10:** `report_reorder_list` returns the same `suggested_qty` for every item before and after sales rows exist, with `usage_per_portion` 0 and `current_stock` unchanged. This pins the "won't change suggestions" statement. (pgTAP)

### Idempotency and date handling
- [ ] **AC-11:** A second run for the same date reports `already_imported` for each store and adds no rows. (smoke)
- [ ] **AC-12:** The `pos_imports` row and its items land together or not at all. Today the header is inserted first (L339-366), so a failed item insert leaves a header that makes the dedup skip that date **forever**. An injected item-insert failure leaves no header, reports `failed`, and a retry imports the date. (pgTAP if the design moves the write to an RPC, otherwise smoke)
- [ ] **AC-13:** A malformed `body.date` returns 400. Today it silently falls back to yesterday (L454-458). A date of today or later, in the sync's timezone, returns 400: today's partial data would import, and the dedup would then block the complete day permanently. (smoke)
- [ ] **AC-14:** With no `body.date`, the target stays yesterday in `DEFAULT_TIMEZONE`, and the sync still runs after Breadbot's 04:00 rollover. (existing behaviour; smoke asserts the date in the response)

### Failure visibility (R2)
- [ ] **AC-15:** One store failing gives HTTP 500 with `{date, results}` listing all three stores, and the other stores still import. No failures gives 2xx. `store_not_found` counts as a failure (P-3). (smoke)
- [ ] **AC-16:** A failed store on a scheduled run creates exactly one `pos_sync_failed` notification for that (store, date), visible to that brand's admins and masters and all super_admins, and not to staff. Repeating the failure for the same (store, date) adds no row. `actor_user_id` is NULL so the push isn't filtered. (pgTAP)
- [ ] **AC-17:** The P-3 warnings alert and stay 2xx: all synced stores with no upstream data, or a store with rows where zero matched. (smoke or pgTAP, per the design)
- [ ] **AC-18:** A dated run with a failure returns 500 and creates no notification. (smoke)
- [ ] **AC-19:** A failure while sending the alert doesn't change the import's result or the HTTP status, matching the spec 162 AC-9 posture. (pgTAP)
- [ ] **AC-20:** The notification body holds the store, the date and a short reason, capped in length. It holds no secret, header or API key. (pgTAP or smoke)
- [ ] **AC-21:** The bell and phone list render the type as urgent, and the push title uses the P-11 label with no "submitted" wording. `derivePushCopy` and its Deno twin agree. `notifications_type_check` keeps every value present at build time. Strings exist in all three locales. (jest; existing i18n parity test)
- [ ] **AC-22 (P-4):** With no run record for the morning, the watchdog creates an alert, and with a record it creates none. Two watchdog runs create one alert. Any new function has EXECUTE revoked from `public, anon, authenticated`. Any new table has RLS and trips no `permissive_policy_lint`. (pgTAP)

### Deploy (R3)
- [ ] **AC-23:** `supabase/config.toml` has `[functions.breadbot-nightly-sync] verify_jwt = false` and `[functions.fetch-breadbot-sales]` with the PF-1 value, each with a comment on why. A jest test fails if either entry is missing or flips. (jest)
- [ ] **AC-24 (prod):** After deploying, the setting still reads `false`. A POST with no JWT and a wrong secret returns the **function's own** `{"error":"Unauthorized"}`, not the gateway's 401 body. This is the probe that tells the two apart.

### Secret (R4)
- [ ] **AC-25:** No literal secret exists in the repo, a migration, a log line or the spec's review notes. The runbook's verification steps return booleans, never values. (review, plus a grep for the old env name's value shape in the diff)
- [ ] **AC-26 (prod):** Job 5 has the same `schedule` and `active` as before. PF-2 now returns `reads_edge_auth = true`. The function no longer reads `BREADBOT_CRON_SECRET`, the secret is unset on prod (name check only) and removed from `supabase/functions/.env.local.example`, and the auth comment at index.ts L7-11 is rewritten. `cron_bearer` is untouched. Old values remain in `cron.job_run_details` history, and they're dead after rotation.

### Regression guard (R5)
- [ ] **AC-27:** The Track 2 contract test passes, naming every table and column the function reads or writes, and it exercises those reads against the real schema. The Track 1 test fails if the function uses a table or column outside the contract. (pgTAP, jest)
- [ ] **AC-28:** `STORE_MAP` in both functions and `BREADBOT_STORES` in [posBreadbot.ts](../src/lib/posBreadbot.ts) hold the same names, pinned by jest. **The fix itself doesn't change the map.** The hand-sync rule stays, now enforced, and the stale pointer at `fetch-breadbot-sales` L22 to the deleted `POSImportScreen.tsx` is corrected. (jest)
- [ ] **AC-29:** The Track 3 smoke exists, refuses a non-local `SUPABASE_URL`, removes its fixtures in an EXIT trap, is added to `npm run test:smoke`, and is documented in `tests/README.md`. Its result is recorded before the prod deploy.
- [ ] **AC-30 (proof the guard can fail):** Each of these was tried by hand and the result recorded, in the shape of specs 170 and 178:

  | Temporary change | Must fail |
  |---|---|
  | Scratch migration drops `catalog_ingredients.sub_unit_unit` | Track 2 contract |
  | Function selects a column missing from the contract | Track 1 |
  | The handler returns 200 on a failed store | Smoke, AC-15 |
  | A dated run honours the deduction setting | Smoke, AC-9 |
  | Config entry removed | Track 1, AC-23 |

### Backfill (R6, D-C)
- [ ] **AC-31 (prod):** PF-4 is recorded, and the depth used is the lesser of D-C and what Breadbot holds, per store.
- [ ] **AC-32 (prod):** The backfill's per-day, per-store outcomes are reported to the owner. `current_stock` totals per store are unchanged from before the backfill, apart from EOD counts submitted meanwhile, which the check accounts for. Re-running a day reports `already_imported`.
- [ ] **AC-33 (prod):** The first scheduled run after cutover shows rows for yesterday at all three stores, or an explained `skipped`, and its run record or response is read back.

### Load from the database (R7, D-E)
- [ ] **AC-34:** After a store load, `posImports` holds that store's imports from `pos_imports` for the design's window (proposed: 30 days), mapped through the existing shape. A failed read leaves the store load working and logs a warning. Late results obey the spec 176 guards. (jest)
- [ ] **AC-35:** An import done in the session and then reloaded appears once, not twice. Switching store shows only that store's imports. The POS Imports table, recipe sales and Dashboard's current store show the imported rows. (jest, browser preview)

### Gates and rollout
- [ ] **AC-36:** `scripts/test-db.sh`, full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass. `permissive_policy_lint` and `public_grants_explicit` pass unmodified.
- [ ] **AC-37:** The design includes a prod runbook for project `ebwnovzzkwhsdxkpyjka`, run on the owner's go-ahead, in this order, with the deploy and job change done well away from 10:00 UTC:
  1. Pre-flight PF-1 to PF-5. PF-6 stays unanswered and doesn't block.
  2. Apply the migration through the Supabase MCP and insert its version into `schema_migrations`, **before** the push.
  3. Deploy the function from a tree that has the config entry; run AC-24.
  4. Switch job 5 (AC-26); unset the old secret.
  5. Run one recent dated day and check it.
  6. Backfill (P-8).
  7. Push; confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.
  8. Confirm the next scheduled run (AC-33).

  It also states a rollback that can't re-expose the old secret.
- [ ] **AC-38:** `app.json` `slug` is unchanged (`towson-inventory`).

## In scope
- Porting `breadbot-nightly-sync` to the catalog schema, with deduction ported and off by default.
- All-or-nothing imports and stricter `body.date` handling.
- Non-2xx on failure, bell and push alerts, and the watchdog.
- `config.toml` entries for both Breadbot functions.
- Rotating the secret, moving job 5 to `_edge_auth`, and versioning the job in the repo.
- The contract test, source pin, `STORE_MAP` parity pin and smoke.
- The backfill and prod runbook.
- R7 (D-E).

## Out of scope (explicitly)
- **Populating `usage_per_portion`.** The owner excluded it, and it's why suggestions don't change.
- **Rotating `weekly-reminder-cron`'s literal bearer.** Named follow-up.
- **Changing how reports compute.** The unit, revenue and cost issues under "Risks" are follow-ups, because fixing them is report work, not sync work.
- **The "no sales data" warning (D-D).** Follow-up spec. The shape proposed for it: variance, COGS and velocity add a warn KPI through their existing `kpis` array when the window has days with no `pos_imports` row, e.g. "Sales imported for 5 of 7 days", with the envelope keys unchanged.
- **Revenue.** Breadbot's row type has no revenue field, so it stays 0. PF-4 checks upstream.
- **The manual modal and CSV deduction** (P-9).
- **Adding stores to `STORE_MAP`** (D-B), and **moving the map to a table**.
- **A unique constraint on `pos_imports (store_id, import_date)`.** CSV imports can legitimately share a date, and a manual import racing the cron is rare.
- **Email alerts** until a Resend domain is verified (P-1).
- **The same guard for other edge functions.** Any function reading the schema has this risk. Follow-up once this shape proves itself.
- **Retention.** `specs/186-retention-purge-server-job.md` owns it.
- **Customer PWA, `pwa-catalog`, `app.json` slug, EAS or push config.** Not touched.

## Open questions

**For the owner:** no decision is open. See PF-6 below for the one unanswered fact.

**Facts this spec couldn't establish:** the pre-flight answers the first four. The fifth stays open.
- Breadbot's history depth, and any revenue field (PF-4).
- The prod `verify_jwt` of `fetch-breadbot-sales` (PF-1).
- Whether the 57 aliases resolve (PF-3).
- How often recipe units differ from tracking units (PF-5).
- Whether Breadbot has H Street and Kenyon (PF-6). The owner didn't answer this. Both stores stay out of `STORE_MAP`.

## Open questions resolved
- Q: Which app? → A: This repo's admin surface. Staff and the customer PWA aren't involved.
- Q: Is reorder affected by the repair? → A: No under import-only, from the investigation. Deduction would change it through `on_hand` (D-A).
- Q: Could the fix promise accurate variance? → A: No. It makes the sales term real, not necessarily right (Risks).
- Q: D-A to D-E, P-1 to P-11 and item 17? → A: Accepted as proposed (see "Owner confirmation").

## Owner confirmation (2026-11-08)

The owner's reply, relayed verbatim by the main session: "All defaults OK". It covers this list:
1. **D-A** Import sales only for now. No nightly stock deduction.
2. **D-B** H Street and Kenyon stay out of `STORE_MAP`. Whether Breadbot has them wasn't answered (PF-6).
3. **D-C** Backfill 30 days, or less if Breadbot holds less.
4. **D-D** The "no sales data" warning is a follow-up, not built here.
5. **D-E** Load imports from the database in this spec, so the POS Imports screen actually fills.
6. **P-1** Alerts by bell and push. No email until a Resend domain is verified.
7. **P-2** One alert per store per night. Backfill runs don't alert.
8. **P-3** A renamed or missing store counts as a failure. One store with no data doesn't. All stores with no data, or zero recipe matches, sends an alert.
9. **P-4** A watchdog job catches a sync that never ran.
10. **P-5** The secret gets its own row and is generated unseen. `cron_bearer` isn't touched.
11. **P-6** `fetch-breadbot-sales` gets a config entry only.
12. **P-7** Contract test and source pin in CI, smoke by hand before deploy.
13. **P-8** Backfill from SQL, about 5 seconds per date.
14. **P-9** The manual Fetch Breadbot modal keeps deducting stock, unchanged.
15. **P-10** Browser checks only. No native Simulator pass.
16. **P-11** Alert title translations.
17. **COGS will show 0.0% and a negative margin** once sales arrive, because Breadbot has no revenue. Accepted for now.

## Notes for architect
- **N1. Mechanism is yours.** That covers the deduction setting, the shape of the run record, how the contract test exercises the reads, and which status code family beyond "non-2xx".
- **N2. Consider a read and write RPC.** If the function's reads and the header-plus-items insert move into SQL, pgTAP tests the real code, AC-12 becomes one transaction, and the source pin in P-7 shrinks. Weigh it against a two-part deploy.
- **N3. Alert plumbing.** `notifications.source_id` must be a UUID that's stable per (store, date) to dedupe on `notifications_type_source_uidx`. A run record's id, or a derived UUID, both work. The watchdog also needs a `store_id` and `brand_id`, since both are NOT NULL, and the synced store list lives in TS. Decide where it gets them. An option is one alert per store from the most recent run record.
- **N4. Don't use `net._http_response` as the watchdog's signal.** A pg_net timeout can look like failure while the function succeeds, and job 5's `timeout_milliseconds` isn't known. Job 6 uses 30000.
- **N5. Frontend touch points for the new type:** `AdminNotification` in `src/types/index.ts`, `URGENT_TYPES` and the `order_failed` branches in `NotificationBell.tsx`, routing in `PhoneNotifications.tsx`, `derivePushCopy` and its Deno copy, and the type list in `src/lib/eodPopup.test.ts`.
- **N6. Local stub.** `BREADBOT_BASE_URL` in `.env.local.example` points at a dead `127.0.0.1` port. The edge runtime is in a container, so a stub on the host needs `host.docker.internal`, as config.toml L322 does. If a smoke sees 503, check the bind-mount note in CLAUDE.md.
- **N7. Interaction with the retention spec.** It found no service-role delete of `pos_imports`, and its server-side refusal must not block a fresh row. If AC-12 is built as a compensating delete, it adds one, so prefer one transaction. Its first-run checks expect business-table counts "at or above" the snapshot, which a backfill satisfies.
- **N8. R7 details.** `importPOS` prepends locally, so a reload must not duplicate (AC-35). `posImports` feeds `cmdSelectors` and `usageCalculations`, so real data reaches those for the first time; trace them. The comment at POSImportsSection L127 becomes stale.
- **N9. Migration slot.** After the newest in `supabase/migrations/` at build time, currently `20261108000000`. Other sessions are adding migrations.

## Risks
- **Variance becomes populated, not necessarily right.** Variance, weekly low stock and the reorder rate multiply `qty_sold` by the recipe quantity with **no unit conversion** (variance L255, L359; lowstock L190), while counts are in tracking units. Where a recipe says oz and the item is counted in cases, expected usage is far off. Variance could flip from "everything is loss" to large overages, and weekly low stock could over-flag. PF-5 sizes it. Read from code, not run.
- **Variance dollars may be understated.** Its $ impact is `delta × cost_per_unit` (L416-417). Spec 104 made `cost_per_unit` per-each, and its migration doesn't redefine the variance function, which still dates from `20260514120020`. The bridge other consumers got appears absent here. Not verified; a reviewer should confirm, and it's a follow-up either way.
- **COGS reads wrong in a new way.** The owner accepted this for now. See "What the repair changes" and item 17 of "Owner confirmation".
- **Mapping coverage is unknown.** Aliases were last used 2026-05-10, and the menu may have moved on. Unmapped lines are excluded from the reports, so low coverage still understates sales. AC-6 reports it, and the mapping tab lets a manager fix the last 30 days.
- **The first redeploy since April.** The deployed v16 dates from 2026-04-28, and how it differs from the repo copy wasn't compared, beyond the investigation noting the same bugs. AC-24 and step 5 of the runbook catch surprises.
- **The cutover window.** The job change and the function deploy must both land between 10:00 UTC fires, or the next fire gets a 401. A missed night is recoverable by a dated run.
- **Alert noise.** A persistent failure sends one push per store per night until fixed. That's deliberate; the last failure ran for months.
- **Prod and repo drift.** The migration must be on prod before the push, or `db-migrations-applied.yml` goes red.

## Dependencies
- Spec 162 (alert shape), spec 120 (notifications and push fan-out), spec 180 (latest `notifications_type_check`).
- Spec 014 (manual fetch), spec 015 (alias tools and the unloaded `posImports` note).
- Spec 098 (cron function pinning precedent), spec 022 and 078 (test tracks).
- Spec 097 (grants), spec 053 (permissive-policy lint), spec 064 (migration gate).
- `specs/186-retention-purge-server-job.md` (N7).

## Project-specific notes
- **Cmd UI section / legacy:** no new section. Touches `NotificationBell.tsx` and `phone/PhoneNotifications.tsx`. For R7, `useStore.ts` and `db.ts`, with `POSImportsSection.tsx`, `RecipesSection.tsx` and `DashboardSection.tsx` as readers.
- **Which app:** admin, in this repo. The staff app and customer PWA aren't involved. The `eod-reminder-cron` and spec 162 paths are reused as patterns and not changed.
- **Per-store or admin-global:** the sync runs across the mapped stores; imports and alerts are per store. `notifications` stays admin-only through its brand policy. The function uses the service role, so its scope comes from `STORE_MAP`, not RLS.
- **Edge function or PostgREST:** edge function, with `verify_jwt=false` and its own secret gate, called by pg_cron. An RPC is the architect's option (N2).
- **Realtime channels touched:** the existing `notifications-{brandId}` channel for the bell. `store-{id}` and `brand-{id}` are unchanged; `useRealtimeSync.ts` doesn't subscribe to `pos_imports`, so imports appear on the next load. No publication change is expected. If the design publishes a new table, the `docker restart supabase_realtime_imr-inventory` re-snapshot applies locally.
- **Migrations needed:** yes. The `_edge_auth` row, job 5's definition, the `notifications_type_check` widening, the emitter, the run record and the watchdog.
- **Edge functions touched:** `breadbot-nightly-sync` (deployed), `submission-push-fanout` (copy branch, deployed), `fetch-breadbot-sales` (comment and config only; not deployed).
- **Web/native scope:** both, since notification UI is shared code. Browser verification only (P-10).
- **`app.json` slug:** not touched.
- **Test tracks:** pgTAP (contract, alerts, watchdog, reorder invariance), jest (source pin, `STORE_MAP` parity, config pin, push copy, bell, i18n, R7), shell smoke (function behaviour against a stub). Reasons in P-7.

## Backend design

Written 2026-11-08 against the working tree. Owner decisions are taken as settled, and none proved unworkable. Prod facts come from the main session's read-only checks that day. Code facts were read, not run, unless a section says otherwise.

### 1. Answers to the design points

| Point | Answer |
|---|---|
| N2, reads and write in an RPC? | **Yes, both.** The function keeps auth, date handling, `STORE_MAP`, the Breadbot call and the matcher. Everything touching the schema moves to SQL. The two-part deploy costs nothing extra, because the secret row, run record and alert type already force migration before function |
| AC-12 atomicity | One PL/pgSQL call, `record_pos_import`, so header and items share one transaction. No compensating delete, so N7 stays satisfied |
| Secret cutover | Deploy first, then switch job 5, in one sitting inside a time gate. A failed deploy leaves the old pair, which still agree. See section 10 |
| Rollback | Job 5 is paused, never restored. No step can put the old value back, and no step ever captures it. See section 10 |
| Watchdog store list | From the function's own most recent run record: names, ids and timezone. SQL holds no store list. See section 5 |
| How the function reads the secret | PostgREST read of `_edge_auth` as service role, the `eod-reminder-cron` L139-150 shape |
| R7 window | 30 days, loaded inside `fetchAllForStore` |
| R7 dedupe | Full replace from the database, keeping only local rows with no database twin on (date, filename) |
| Dashboard attention rules | **No rule changes.** The spec's "may start firing" doesn't happen while revenue is 0. See section 8 |
| Retention spec | No conflict. Its migration is already in the tree. See section 9 |
| Migration slot | `20261109000000`, after `20261108120000_retention_prune_job.sql` and `20261108130000_order_approval_approver_snapshot.sql`, both of which appeared during this design |

**Three problems found that the spec didn't name.** All are handled below, and the first changes behaviour the owner may want to look at:
1. **Deleting a recipe would silently wipe its ingredients once sales rows exist** (section 2.3).
2. **Two screens date sales by `imported_at`,** which a backfill makes wrong (section 8).
3. **pg_net sends after commit,** so a SQL loop with `pg_sleep` would fire the whole backfill at once (section 10, step 6).

### 2. Data model

Migration: `supabase/migrations/20261109000000_breadbot_nightly_sync_repair.sql`. **Re-check the slot at build time.** It must sort after the newest file then, and the prod `schema_migrations` insert must use the final version. Wrap it in `begin; ... commit;` as spec 162 does. Additive apart from the FK action in 2.3, which is safe because `pos_import_items` is empty on prod at apply time.

#### 2.1 `public.pos_sync_runs` (new)
One row per function run past authentication.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK, default `gen_random_uuid()` | |
| `target_date` | date not null | |
| `scheduled` | boolean not null | true when the request had no `date` |
| `timezone` | text not null | The timezone the function used |
| `expected_stores` | jsonb not null | `[{name, store_id}]`, from `STORE_MAP` resolved at run start. `store_id` is null when a name doesn't resolve |
| `started_at` | timestamptz not null, default `now()` | |
| `finished_at` | timestamptz | Null means started but never finished |
| `http_status` | integer | |
| `results` | jsonb | Per-store outcomes, section 3.5 |
| `warnings` | jsonb | P-3 warnings |

- Index on `(target_date, scheduled)`, and on `(started_at desc)` for "latest run".
- No FK to `stores`, deliberately, so it can't block a store or brand delete.
- Not pruned. About one row a day, plus the backfill. The spec 186 job names only its own tables.

#### 2.2 Other additive objects
- `_edge_auth` row `breadbot_cron_secret`, generated with `encode(extensions.gen_random_bytes(32), 'hex')` and insert-where-not-exists, the shape at [20260424211733 L146-148](../supabase/migrations/20260424211733_security_fixes.sql). No `returning`.
- `notifications_type_check` widened from 10 to 11 values, adding `pos_sync_failed`. Current source is [20261027000000 L100](../supabase/migrations/20261027000000_eod_update_notifications.sql). **Re-read the newest definition at build time,** since another session could widen it first.
- `pos_imports (store_id, import_date)` and `pos_import_items (import_id)` indexes, `if not exists`. Neither exists in the repo, and the velocity migration (L87-88) deferred them. Dedup, R7's embed and the reports all filter on these, and spec 186 keeps these rows with no age limit. Instant on empty tables.
- Scheduling of the watchdog job (section 5).
- `notify pgrst, 'reload schema';` at the end, because the function calls new RPCs straight after apply. No existing migration does this. The dated run in step 5 proves the RPCs are visible.

Two `_edge_auth` rows are read but not created by the migration:
- `breadbot_sync_url`: the function's URL, not a secret, inserted by the prod runbook. Absent locally, so the local stack never schedules job 5 (the `cron_url` pattern at 20260424211733 L150-170).
- `breadbot_deduct_stock`: the D-A setting (section 3.4). **Never inserted on prod.**

`_edge_auth` already holds non-secret configuration such as `submission_push_url`, so this adds no new kind of content and no new table.

#### 2.3 `pos_import_items.recipe_id`: NO ACTION to ON DELETE SET NULL
**The problem.** [db.ts L3128-3134](../src/lib/db.ts) `deleteRecipe` runs three separate deletes without checking errors: ingredients, prep items, then the recipe. The FK ([init L191](../supabase/migrations/20260405000759_init_schema.sql)) is NO ACTION. Today no sales rows exist, so all three succeed. Once any mapped sales line references a recipe, the first two succeed and the third fails with 23503, which is ignored because supabase-js returns errors rather than throwing. The revert at useStore.ts L3016 never fires. **The recipe reappears on the next reload with no ingredients.** Spec 186 lists this delete as "silently fails" and notes it will matter once Breadbot is fixed, but the partial wipe is worse than that. Read from code, not run; the arm in D-AC-3 proves it.

**The choice.** `ON DELETE SET NULL`, the same treatment `pos_imports.imported_by` got in [20260528000000 L82-86](../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql). Recipe delete keeps working as it does today, and the sales line stays, with its POS name and quantity, satisfying "keep".

**The cost.** A deleted recipe's history drops out of velocity, COGS and variance, because they exclude NULL `recipe_id`. `recipe_mapped` stays true on those lines, so the imports table still counts them as matched. The alternative is refusing the delete and surfacing the error, which means a recipe with sales could never be deleted. **Owner decision (2026-11-08): keep deletes working, so `ON DELETE SET NULL` stands.** The owner was told about the cost above and the refuse-the-delete alternative.

**Verify after apply:** exactly one FK on that column with `confdeltype = 'n'`. `drop constraint if exists` would silently leave a differently-named prod constraint in place.

### 3. API contract

**PostgREST and RPC split.** Machine traffic uses RPCs. The one table read is the secret. R7 reuses the existing PostgREST shape.

Grant posture for all functions below: `security definer`, `set search_path = public, pg_temp`, and `revoke all ... from public, anon, authenticated`.

| Function | Executable by | Called from |
|---|---|---|
| `pos_sync_store_context` | service_role | Edge function |
| `record_pos_import` | service_role | Edge function |
| `pos_sync_begin_run` | service_role | Edge function |
| `pos_sync_finish_run` | service_role | Edge function |
| `emit_pos_sync_failed` | owner only (also revoke service_role) | Finish, watchdog |
| `pos_sync_apply_deduction` | owner only | `record_pos_import` |
| `pos_sync_convert_qty` | owner only | Deduction |
| `pos_sync_watchdog` | postgres | pg_cron |
| `pos_sync_install_job` | postgres (security invoker) | Runbook, pgTAP |

#### 3.1 `pos_sync_store_context(p_store_name text, p_import_date date) returns jsonb`
Returns `{found: false}`, or `{found: true, store_id, brand_id, already_imported, recipes: [{id, menu_item}], aliases: [{pos_name, recipe_id}]}`.
- Recipes: `recipes.brand_id = stores.brand_id` (AC-2).
- Aliases: `store_id = s.id or store_id is null`, inner-joined to a recipe of the same brand, ordered with store-specific rows first. An other-brand alias is simply absent, so matching falls through (AC-3). The TS fall-through stays too.
- Raises P0001 on more than one store with that name, or a store with no brand. Those become `failed`.

#### 3.2 `record_pos_import(p_store_id uuid, p_import_date date, p_filename text, p_items jsonb, p_scheduled boolean) returns jsonb`
`p_items` is `[{menu_item, qty_sold, revenue, recipe_id}]`, and `recipe_mapped` is derived from `recipe_id`. In order:
1. Take `pg_advisory_xact_lock` on (store, date), then re-check for an existing header. If one exists, return `{outcome: 'already_imported'}`. This closes the cron-versus-backfill race without the unique constraint the spec excludes. A manual modal import doesn't take the lock, which the spec accepts as rare.
2. Insert the header with `imported_by` NULL, then the items.
3. Deduct only when `p_scheduled` is true **and** `_edge_auth.breadbot_deduct_stock` is exactly `on`. Otherwise skip, and touch no `inventory_items` row.
4. Return `{outcome: 'imported', import_id, item_count, mapped_count, unmapped_count, deduction: {applied, lines_applied, lines_skipped_unconvertible, recipes_truncated}}`.

Any error rolls back all of it, including deduction. An injected bad `recipe_id` leaves no header (AC-12), and a retry imports the date.

#### 3.3 Run record
- `pos_sync_begin_run(p_target_date date, p_scheduled boolean, p_timezone text, p_store_names text[]) returns uuid`. Resolves names to ids once.
- `pos_sync_finish_run(p_run_id uuid, p_results jsonb, p_http_status integer) returns jsonb`. Sets `finished_at`, `results` and `warnings`, classifies P-3 warnings, emits alerts on scheduled runs only, and returns `{warnings: [{store, code}], alerts: n}`. Classification lives only here, so pgTAP covers it (AC-17).

#### 3.4 Deduction (ported, off)
`pos_sync_apply_deduction(p_import_id uuid) returns jsonb` runs inside `record_pos_import`'s transaction, unlike today's "log and continue".
- Flatten as [variance L254-299](../supabase/migrations/20260514120020_report_run_variance_multivendor.sql) does: direct lines plus prep leaves, `rpi.quantity * pri.quantity`, depth 5, cycle guard. Keep each leaf's own unit.
- Join `inventory_items` on `(store_id, catalog_id)` and `catalog_ingredients` for `unit, sub_unit_size, sub_unit_unit`.
- `pos_sync_convert_qty(qty, from_unit, unit, sub_unit_size, sub_unit_unit)` is immutable and ports `convertToTrackingUnit` and its tables from index.ts L35-90. Null means unconvertible: skipped and counted, never 1:1.
- Aggregate per item, then one `update ... set current_stock = greatest(0, current_stock - x), last_updated_by = null` for each. `inventory_items_identity_lock_trg` fires only on `id` and `store_id` updates, so it doesn't interfere.
- The `ingredient_conversions` table and `base_quantity` columns are not used, matching today's function. Compare with the client's `convertToItemUnit` before anyone turns this on.

The setting is a database row because no request path can write it, a smoke can flip it without restarting the edge runtime, and absent means off. A dated run passes `p_scheduled = false`, so AC-9 holds whatever the setting says.

#### 3.5 HTTP contract of the function
`POST`, `verify_jwt = false`, header `x-cron-secret`, optional body `{date: 'YYYY-MM-DD'}`.

| Status | Body | When |
|---|---|---|
| 200 | `{date, scheduled, results, warnings}` | No store failed. Warnings stay 2xx (P-3) |
| 500 | Same shape | Any store `failed`, including `store_not_found` (AC-15) |
| 400 | `{error: 'Invalid date'}` | Non-JSON non-empty body, `date` not a string, wrong shape, not a real calendar date (round-trip check, so 2026-02-31 fails), or today or later in the sync's timezone (AC-13). An empty body counts as no date |
| 401 | `{error: 'Unauthorized'}` | Wrong or missing secret (AC-24) |
| 405 | `{error: 'Method not allowed'}` | Not POST |
| 500 | `{error: 'Server not configured'}` or `{error: 'Missing env: <names>'}` | Secret row unreadable or env missing. No run record, so the watchdog covers it |

`results` entries:
- `{store, storeId, outcome: 'imported', itemCount, mappedCount, unmappedCount, upstreamRows, deduction}`
- `{store, storeId, outcome: 'skipped', reason: 'already_imported' | 'no_upstream_data'}`
- `{store, storeId, outcome: 'failed', errorCode, error}`, where `storeId` may be null

`errorCode` is one of `store_not_found`, `upstream_error`, `upstream_timeout`, `upstream_bad_response`, `context_failed`, `write_failed`, `internal`.

**Breadbot's response body is never kept.** Today's error includes 200 characters of it (L210). `error` becomes `Breadbot <status>` or a capped database message, so nothing upstream can reach a log, the run record or a notification.

### 4. Edge function changes

`breadbot-nightly-sync`: `verify_jwt = false`, now explicit in config. Handler order:
1. Method and env checks.
2. Read `_edge_auth` where `name = 'breadbot_cron_secret'` through the service-role client. Read failure gives 500 and logs no value. Mismatch gives 401.
3. Validate the date.
4. `pos_sync_begin_run`, best effort.
5. For each `STORE_MAP` entry in sequence: context, dedup, Breadbot with `AbortSignal.timeout(20000)`, `findRecipe` on the raw name, `record_pos_import`. A per-store catch produces `failed`.
6. `pos_sync_finish_run`, best effort.
7. Respond.

**Rule for steps 4 and 6:** a run-record or alert error is logged and never changes an import result or the status (AC-19). The watchdog then sees no finished run, which is the correct signal.

**Removed from the source:** `RecipeRow.store_id`, the recipe, ingredient and inventory reads, the serial stock updates, `convertToTrackingUnit` and its tables, and `BREADBOT_CRON_SECRET`. The L7-11 auth comment and the L13-16 idempotency comment get rewritten. `findRecipe` stays as the hand-synced copy of `recipeMatch.ts`.

**Runtime against the limits.** The only measurement is 13 seconds for 3 stores up to the recipes read, about 4 seconds per store. The port replaces four reads with one RPC and two inserts with one, and the slowest part of a full run today, one update per item per ingredient, is gone. Estimate: 15 to 25 seconds, **not measured**. Worst case with the new timeout is 3 × 20 seconds plus database time, about 70 seconds, which beats job 5's 60-second `timeout_milliseconds`. So the new job command uses **120000**. AC-26 pins only schedule and active. A pg_net timeout doesn't stop the function, and nothing reads the response anyway (N4). 120 seconds sits under the 150-second limit as remembered in section 15.

`submission-push-fanout`: redeployed with a `pos_sync_failed` label and `derivePushCopy` branch: title `POS sync failed`, body `<store> · <body>`, truncated at 120 characters like `order_failed`. Same change in `src/utils/pushNotificationCopy.ts`. Its auth is unchanged.

`fetch-breadbot-sales`: L22 comment now points at `src/lib/posBreadbot.ts`, plus the config entry. **Not deployed** (P-6).

`config.toml`: `[functions.breadbot-nightly-sync] verify_jwt = false` and `[functions.fetch-breadbot-sales] verify_jwt = true`, with comments. The second assumes PF-1 shows true. If PF-1 differs, stop and ask, per the spec.

### 5. Alerts and watchdog (N3, P-2, P-3, P-4)

**`emit_pos_sync_failed(p_store_name text, p_store_id uuid, p_target_date date, p_reason_code text) returns void`.** The spec 162 shape: inner `exception when others then raise warning`, `on conflict (type, source_id) do nothing`, and `enqueue_submission_push` only for a new row.
- `source_id` = `md5('pos_sync_failed|' || p_store_name || '|' || p_target_date)::uuid`. Stable per (store, date), so a failure, a warning and a watchdog alert for the same pair produce one row. No extension needed. Uses the `STORE_MAP` name, because a missing store has no id.
- `actor_user_id` NULL, so the push isn't filtered. `actor_name` = `Breadbot sync`, so the bell's secondary line doesn't say "Someone".
- `store_name` = the map name. `body` = `<date> · <reason>`, capped at 200 characters. **AC-20 reading:** the store travels in `store_name`, as on every other type, and both bell and push render it next to `body`. The arm checks both columns.
- **The reason comes from a closed code list, never free text,** so AC-20 holds by construction:

  | Code | Text |
  |---|---|
  | `store_not_found` | store not found |
  | `upstream_error`, `upstream_bad_response` | Breadbot request failed |
  | `upstream_timeout` | Breadbot timed out |
  | `context_failed`, `write_failed`, `internal` | import failed |
  | `no_upstream_all` | no sales data from Breadbot for any store |
  | `zero_matched` | no item matched a recipe |
  | `run_missing` | sync did not run |
  | `run_unfinished` | sync did not finish |

- **A store with no row** has no `store_id` or `brand_id` of its own, and both are NOT NULL. `pos_sync_finish_run` passes the first resolved store from this run's `expected_stores`, falling back to the previous run's. The row keeps the missing store's name in `store_name`, and brand scoping is correct either way. If nothing resolves, the alert can't be sent: the response is still 500 and the warning is logged. This can only happen before any good run exists, and runbook step 5 would catch it.

**Warnings,** classified in `pos_sync_finish_run`: `no_upstream_all` when every expected store is skipped with `no_upstream_data`; `zero_matched` per store when `itemCount > 0` and `mappedCount = 0`. Returned on every run, emitted on scheduled runs only.

**`pos_sync_watchdog() returns integer`,** pg_cron job `pos-sync-watchdog`, `7 11 * * *`. Off the `*/5` minutes, an hour after job 5, not sharing a minute with spec 186's `47 8 * * *`. Scheduled in the migration with the `if exists ... unschedule` shape of [20260607130000 L179-190](../supabase/migrations/20260607130000_username_resolve_rate_limit.sql).
1. Read the latest `pos_sync_runs` row of **any** kind. If none exists, raise a notice and return 0. This is the state between migration and the first dated run, so cutover can't false-alarm.
2. `v_date = ((now() at time zone v_last.timezone) - interval '1 day')::date`.
3. A row with `scheduled` true, that `target_date`, and `finished_at` set means return 0. A failed run has already alerted.
4. Otherwise the reason is `run_unfinished` if a scheduled row for that date exists, else `run_missing`. Emit one alert per entry in that latest row's `expected_stores` that still has a store.

**Why this is not a second source of truth:** the store list and timezone both come from the function's own last run. A dated run counts for the list but doesn't satisfy step 3. `net._http_response` isn't read (N4), which also matters because it held only about 6 hours when checked. One push per store is deliberate, matching P-2.

### 6. RLS impact

| Object | Policies | Helper |
|---|---|---|
| `pos_sync_runs` (new) | RLS on, **no policies**, so API roles get nothing. Keeps inherited grants (Category B, as `_edge_auth`), so `public_grants_explicit` passes unmodified, and no policy means nothing for `permissive_policy_lint` | None. No client reads it. A future admin view would add a scoped policy |
| `notifications` | `privileged_brand_read_notifications` unchanged. It gives AC-16's audience and denies staff | `auth_is_privileged()` + `auth_can_see_brand()` |
| `pos_imports`, `pos_import_items` | Unchanged. R7 reads through `store_member_read_pos_imports` and `store_member_read_pos_import_items` | `auth_can_see_store()` |
| `pos_imports` DELETE | Spec 186's `pos_imports_restrict_delete_aged` stacks on the existing policy. This spec adds no API delete | Its own predicate |
| `_edge_auth` | Unchanged, no client access | None |

The function's service role bypasses RLS, so its scope comes from `STORE_MAP`, as the spec says. No `ADMIN_ROLES` gate applies, because no caller JWT exists.

### 7. `src/lib/db.ts` surface

```ts
export const POS_IMPORT_HYDRATION_DAYS = 30;
export async function fetchPosImportsForStore(storeId: string, sinceDate: string): Promise<POSImport[]>; // throws on error
```
- Share a private query and mapper with `fetchPosImportsForStores` (L1662-1697), whose swallow-to-`[]` behaviour stays. Snake to camel exactly as L1681-1695. Order by `import_date desc, imported_at desc`.
- `fetchAllForStore` adds `posImports` and `posImportsFailed` to its `Promise.all`, using the `.catch` flag pattern of `inventoryFailed` (L6043-6046), and `console.warn`s. `since` uses the same UTC calculation as L4433, so all 30-day readers agree.
- Pure helper in new `src/lib/posImportsHydration.ts`:
  ```ts
  export function mergeHydratedPosImports(hydrated: POSImport[] | undefined, failed: boolean, prior: POSImport[], storeId: string): POSImport[];
  export function sortPosImportsNewestFirst(rows: POSImport[]): POSImport[]; // date desc, importedAt desc
  ```
- Merge rule. If `hydrated` is undefined or `failed`, return `prior` filtered to `storeId`, so a failed read keeps what's on screen and a switch never shows another store's rows. Otherwise return `hydrated` plus any `prior` row for `storeId` with a non-UUID id (`makeId` gives `pos<ms>`) and no hydrated row sharing (date, filename).

**Why in `fetchAllForStore` rather than a tail like `loadMenuCapacity`:**
- It lands in the same `set` as the other slices, after spec 176 R-3's `sid` check, so AC-34's late-result guard costs nothing.
- `undefined` handling means **no test mock changes.** A new `db.*` tail would break the mocks in about 16 store test files, the same churn spec 186 just went through.
- The cost: the store load waits on one more read. See section 14.

### 8. Frontend store impact and what changes on screen (N8)

**Slice:** `posImports` in [useStore.ts](../src/store/useStore.ts), written at L2285's `set` through the merge helper. The optimistic-then-revert pattern and `notifyBackendError` don't apply: it's a background read, and a failed read logs a warning (AC-34). The `__all__` branch (L2210) sets `posImports: []`. No production path reaches it (N4), but `allPos` would double-count there. Stale comments at useStore.ts L3502 and POSImportsSection L127 get corrected.

**Why AC-35 holds.** `importPOS` runs only after `savePOSImport` has awaited (POSImportsSection L245-253, FetchBreadbotModal L248-250) with the same filename and date. A reload that sees the row replaces the local copy. One that began before the save keeps it. CSV goes through `RunImportModal`, which doesn't call `importPOS`.

Every reader of `posImports`, traced:

| Surface | Code | What changes | Action |
|---|---|---|---|
| POS table, desktop and phone | POSImportsSection L113, PhonePOSImports L108 | Fills. **`.slice().reverse()` on a newest-first list shows the oldest first,** and "Last import" reads `imports[0]`, so it would name a month-old file | **Replace with `sortPosImportsNewestFirst`** |
| POS stat cards | L196-203 | Rows, Unmapped and Failed become 30-day totals. A day with zero matches shows red `failed` | None. It's real information, and AC-6 reports it |
| POS "when" column | L347 | After a backfill every row shows the same age. The filename carries the date | None |
| Mapping tab | L943-958 | Gains `lastSeen`. **No double counting:** the server count wins, and local only adds to it | None |
| Recipe sales rows | RecipesSection L674 | Fills. **Dates use `importedAt`, so every backfilled day would show the backfill date** | **Use `im.date`, falling back to `importedAt`** |
| Recipe sales cards | L708-709 | **"Units · YTD" and "Revenue · YTD" would be 30-day figures,** and revenue reads $0 | **Change the label values to 30d** in all three locales. Food cost % and margin come from the recipe, not sales, so they don't move |
| Prep recipe weekly depletion | PrepRecipesSection L582 | Fills. **Filters on `importedAt`, so for a week after the backfill it adds up 30 days as one week,** inflating depletion and shrinking days of cover about fourfold | **Filter on `im.date`** |
| Inventory recipes tab | cmdSelectors L97-105 | `soldPerWeek` becomes real, already date-based | None |
| Inventory usage tab | InventoryDesktopLayout L970-978 | Fills. The 8-week chart reads 0 for its oldest 4 weeks, permanently, because of the 30-day window. "Last 28d" is right. Only the top 15 items by usage get a series, so others still say "link this item to a recipe" even when linked | None. Accepted with the 30-day window; existing top-15 behaviour is a follow-up |
| Dashboard COGS card | DashboardSection L541-544, `computeCogsTheoretical` | **Visible change.** Theoretical goes from $0 to a real figure for the current store, as it already would for others. Delta shrinks or flips, and % goes from 0.0 to a real figure. **The figure itself is rough:** L443 multiplies quantity × recipe quantity × per-each cost with no unit conversion or spec 104 bridge, and ignores prep | None. Report-accuracy follow-up, same class as the first Risks entries. Tell the owner |
| Dashboard heatmap | L563-578, `computeStoreFoodCostVariancePp` | **No change.** `revenue > 0` is false, so it stays on the same proxy branch as with no POS data (L661-671) | None |
| Attention queue | `computeAttentionQueue` | **No change to any rule.** `food_cost_streak` is the only rule reading POS, and it goes through that same proxy, so it fires exactly when it does today. It would change only if revenue became non-zero: a CSV with revenue, or a future upstream field | None. Corrects the spec's "may start firing" row |
| Reconciliation | `buildReconciliationLines` | Nothing. It has no non-test caller | None |
| `getRecipesUsingItem` | cmdSelectors L99 | Doesn't filter by store, which is safe because the merge keeps the slice to one store | None |

Dashboard's `allPos` (L338-341) stays correct: other stores come from the cross-store read, the current store from the slice, with no overlap. It reads 14 days from a 30-day slice, and the selectors filter by date.

**Notification UI (N5):**
- `SubmissionNotificationType` in `src/types/index.ts`.
- `URGENT_TYPES` and the `order_failed` red headline and body branches in `NotificationBell.tsx` (L45, L322, L335).
- Phone body branch (`PhoneNotifications.tsx` L336), and `sectionForNotification` returning `POSImports`.
- `chrome.submissionBell.type.pos_sync_failed` in all three locales, from P-11.
- The non-popup list in `src/lib/eodPopup.test.ts` L131. `EOD_POPUP_TYPES` is unchanged, so no popup.

### 9. Interaction with spec 186 (N7)

Spec 186 is `READY_FOR_BUILD`, and its migration `20261108120000_retention_prune_job.sql` is in the tree. Read, not edited.

| Point | Effect |
|---|---|
| Restrictive DELETE on `pos_imports` (1 day, by `imported_at`) | No effect on imports: this spec only inserts. Spec 186's statement that the function has no delete path stays true |
| Backfilled rows | `imported_at = now()`, so they're fresh to any policy and to any stale client's cutoff. After a day they're protected like other rows |
| If this ships first and 186 slips | Rows age out through `cleanupOldRecords` 90 days after import, so around February 2027. Spec 186's own deadline is 2026-11-20, so this is theoretical |
| First-run checks | Counts "at or above the snapshot" are satisfied by a backfill. Its row-count arms are hermetic |
| Rollback here | Run as `postgres`, the table owner, without forced RLS, so the restrictive policy doesn't apply. If the delete in section 10 runs after 186's snapshot, its report must explain the drop |
| Job minutes | `47 8` versus `0 10` and `7 11`. No collision |
| Client edits | Both touch the store-load area of `useStore.ts`. Textual neighbours only |
| Migration order | Independent. Applied through MCP, and the gate compares sets |
| Its "Consequences" table says `deleteRecipe` silently fails | **Goes stale after section 2.3.** Not edited here; the main session may want to note it there |

### 10. Cutover and runbook (AC-37)

Project `ebwnovzzkwhsdxkpyjka`, on the owner's go-ahead.

**Rules for every step:**
- No statement selects `cron.job.command`, `_edge_auth.value`, `net.http_request_queue`, or any request header.
- Checks return booleans.
- No `returning` on secret writes.
- pgTAP checks use `ok()`, not `is()`, because `is()` prints values on failure.

**Why this order can't leave a disagreement across a fire:**
- **Deploy first.** If the deploy fails, v16 and the literal job still agree, and nothing has changed. Switching the job first would leave a disagreeing pair after a failed deploy.
- **Then switch at once,** in the same sitting, whatever AC-24 shows. The new row is right for every future function version, so a function problem is fixed forward without touching the job again.
- **A time gate bounds the window** between those two steps to minutes, with no fire inside it:
  ```sql
  select (now() at time zone 'utc')::time >= '11:15'
      or (now() at time zone 'utc')::time <  '03:30' as safe_window;
  ```
  Starting after 11:15 UTC clears both 10:00 and the 11:07 watchdog, so it can't false-alarm. Stopping at 03:30 UTC also keeps runs away from 00:00 to 04:00 New York, when "yesterday" is still Breadbot's open business day: AC-13 blocks calendar today only, and an import of a partial day can't be corrected, because the dedup then blocks that date. **This residual applies to any hand-run dated call,** and the gate is what covers it.
- **After this cutover there is never another one.** Function and job both read the row per request, so a rotation is one `update`.

**Worst case if a fire lands in the gap anyway:** the function returns its own 401 and imports nothing. A dated run recovers the day.

**Steps:**

1. **Pre-flight.** PF-1 to PF-5. PF-6 stays open and doesn't block. Extra checks, all read-only, none printing a value:
   - **PF-2 additions:** `username = current_user as owned_by_caller`, `command ~ 'x-cron-secret' as sends_cron_header`. Job 5's identity, schedule and timeout were read on 2026-11-08; re-confirm identity, schedule and active now.
   - **PF-7:** `exists(...)` booleans on `_edge_auth`: `submission_push_url` true; `breadbot_cron_secret`, `breadbot_sync_url`, `breadbot_deduct_stock` all false. Also `pg_cron` extension version, `supabase_realtime` `puballtables` expected false, and the current `notifications_type_check` definition.
   - **PF-8:** `select jobname, schedule, active from cron.job order by jobname;` No job at minute `7 11`. Names and schedules only.
   - **PF-9:** each of Frederick, Charles and Towson matches exactly one `stores` row.
   - **PF-10:** function secret **names only** (filter out any digest column): `BREADBOT_API_KEY` present, and note whether `DEFAULT_TIMEZONE` and `BREADBOT_BASE_URL` are set.
   - Record `current_stock` per store for AC-32: `select store_id, sum(current_stock), count(*) from public.inventory_items where store_id in (...) group by 1;`

2. **Migration,** through MCP, then insert the exact version in `schema_migrations`, **before** the push. Any time of day. Harmless alone: v16 ignores the new row, and the watchdog no-ops with no run record. Then insert `breadbot_sync_url`. Verify by normalized md5 for each new function, `pg_get_constraintdef` for the type check, the FK check from 2.3, the watchdog `cron.job` row active, and a boolean that the secret row exists with length 64.

3. **Gate, then deploy,** from a tree with the config entries: `submission-push-fanout`, then `breadbot-nightly-sync`. Run AC-24 with a wrong secret, and confirm `verify_jwt` is still false.

4. **Immediately:** `select public.pos_sync_install_job();`. It reads the URL, then finds the job by name and uses `cron.alter_job(jobid, command := ...)`, so id, schedule and active stay as they were. It falls back to `cron.schedule` only where no job exists. Then:
   - Re-run PF-2, expecting `reads_edge_auth = true` (AC-26).
   - Unset `BREADBOT_CRON_SECRET`, and check by name only.

   The command has the shape of [20260424211733 L175-185](../supabase/migrations/20260424211733_security_fixes.sql), with `'x-cron-secret', (select value from public._edge_auth where name = 'breadbot_cron_secret')`, `body := '{}'::jsonb`, `timeout_milliseconds := 120000`.

5. **One dated day,** yesterday, inside the gate:
   ```sql
   select net.http_post(
     url := (select value from public._edge_auth where name = 'breadbot_sync_url'),
     headers := jsonb_build_object(
       'x-cron-secret', (select value from public._edge_auth where name = 'breadbot_cron_secret'),
       'Content-Type', 'application/json'),
     body := jsonb_build_object('date', '<YYYY-MM-DD>'),
     timeout_milliseconds := 120000) as request_id;
   ```
   Read back from the run record, never from pg_net:
   ```sql
   select target_date, finished_at is not null as finished, http_status, results, warnings
     from public.pos_sync_runs
    where not scheduled and target_date = '<YYYY-MM-DD>'
    order by started_at desc limit 1;
   ```
   This also proves the secret works end to end with nobody having seen it, and gives the watchdog its store list. **Record the time per store and the line counts:** this is the first real measure of runtime and of R7's payload.

6. **Backfill (P-8),** newest date first, for the 30 days ending yesterday. **One statement per MCP call, and wait for that date's run to show `finished` before sending the next, at least 5 seconds apart. Do not use a SQL loop.** pg_net sends only after commit, so a `do` block with `pg_sleep` would release every request together, overlapping runs and exceeding the 60/min Breadbot limit. Expect about 8 to 13 minutes, estimated. A date past Breadbot's history returns `skipped`, so per-store depth takes care of itself; check against PF-4 (AC-31). If a date doesn't finish in 150 seconds, stop and look. Report per-day, per-store outcomes, and re-check `current_stock` against step 1, accounting for EOD submitted meanwhile (AC-32).

7. **Push,** in the same sitting and **before the next 10:00 UTC.** The bell's label and red treatment ship with the web bundle, and an alert could fire on the next scheduled run. Confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

8. **Next scheduled run (AC-33).** After 10:00 UTC, read the `scheduled` row. After 11:07 UTC, confirm no `run_missing` alert. Report mapped and unmapped counts per store (AC-6) and the 30-day line counts per store.

**Rollback. None of these can re-expose the old value.**

| Situation | Action |
|---|---|
| Stop nightly imports | `cron.alter_job(<job 5>, active := false)` **and** the same for `pos-sync-watchdog`, or the watchdog alerts every morning. Re-enable with `active := true` |
| Function defect | Fix forward and redeploy. **Do not redeploy v16:** it reads the unset env var, returns 500, and fails on recipes anyway |
| Secret suspected exposed | `update public._edge_auth set value = encode(extensions.gen_random_bytes(32), 'hex') where name = 'breadbot_cron_secret';` Both sides pick it up on the next request |
| Bad import data | With the owner's go-ahead, as `postgres`: delete from `pos_imports` where `imported_by is null`, filename starts `Breadbot nightly · `, and `import_date` in the range. Items cascade. No stock effect under import-only. Then re-run dated |
| Migration | Leave it. Additive, and the type check must stay wide once any row exists |

**Forbidden in any rollback:** setting `BREADBOT_CRON_SECRET` again, writing a literal into `cron.job.command`, or printing a job command to "see what it was". Old literal values remain in `cron.job_run_details` for up to 7 days after the switch, until `prune-cron-history` removes them. They are dead by then (AC-26), and nothing in this runbook reads that column.

### 11. Test tracks

| Track | File | Covers |
|---|---|---|
| pgTAP | `supabase/tests/breadbot_sync_contract.test.sql` | `has_column` for every column the RPCs use, then **executes** context, record and deduction with the setting on. Execution matters because PL/pgSQL bodies bind late, so a dropped column fails only when run. AC-2, AC-3, AC-5, AC-9, AC-12, AC-27 |
| pgTAP | `supabase/tests/pos_sync_alerts.test.sql` | AC-16 to AC-20, AC-22, grants via `has_function_privilege`, the job install. AC-19: add a `not valid` CHECK rejecting the type inside the test transaction, and assert the finish call still returns |
| pgTAP | `supabase/tests/pos_imports_reorder_invariance.test.sql` | AC-10, D-AC-3 |
| jest | `src/lib/breadbotSync.contract.test.ts` | Reads the function source: `.from()` only `_edge_auth`, `.select()` only `value`, `.rpc()` only the four names, each of which must appear in the contract test. AC-4, AC-23, AC-28, and no `BREADBOT_CRON_SECRET`. Precedent: `authEmailHook.parity.test.ts` |
| jest | `src/lib/posImportsHydration.test.ts`, `src/store/useStore.posImportsHydration.spec188.test.ts` | Merge rules, AC-34, AC-35, spec 176 drop |
| jest | Existing push copy, bell, phone, eodPopup and i18n parity tests | AC-21, D-AC-1, D-AC-2 |
| smoke | `scripts/smoke-breadbot-sync.sh` with a Node stub on `54399` | AC-1, AC-7, AC-8, AC-9, AC-11, AC-13, AC-14, AC-15, AC-18. Refuses a non-local URL, reads the secret without echoing it, EXIT trap removes fixtures, restores any renamed store, and deletes the setting row |

**Local stub (N6).** Add to `[edge_runtime.secrets]` in config.toml: `BREADBOT_BASE_URL = "http://host.docker.internal:54399"` and `BREADBOT_API_KEY = "dev_dummy_breadbot_key"` (the existing public dummy). A clean `npx supabase stop --no-backup && npm run dev:db` is needed after that. `smoke-edge.sh` isn't affected: it defaults to the prod URL, and its upstream arms need a token.

**CI can read `cron.job`.** Tests run as `postgres`, and earlier migrations already call `cron.schedule` in the same stack. Not yet exercised by any test, so the first CI run confirms it.

### 12. Design-added acceptance criteria

These follow from the trace above and sit alongside the spec's ACs:
- [ ] **D-AC-1:** After hydration the POS table and phone list show the newest `import_date` first, and "Last import" names the newest. (jest)
- [ ] **D-AC-2:** Recipe sales rows date by `import_date`, its cards read 30d in all three locales, and prep weekly depletion counts only imports whose `import_date` falls in the last 7 days, regardless of `imported_at`. (jest)
- [ ] **D-AC-3:** With a mapped `pos_import_items` row, deleting the recipe succeeds, the sales line survives with NULL `recipe_id`, and `deleteRecipe`'s three statements leave nothing half-done. A control on the old constraint inside the test shows the recipe survive without its ingredients. (pgTAP)

### 13. Realtime impact

**No publication change, so no `docker restart supabase_realtime_imr-inventory` step.** `pos_sync_runs` isn't added: the publication has been an explicit list since [20260514140000](../supabase/migrations/20260514140000_realtime_publication_tighten.sql), and PF-7 confirms that on prod. `store-{id}` and `brand-{id}` replay nothing new, and `pos_imports` isn't published, so new imports appear on the next store load. The bell gets `pos_sync_failed` through the existing `notifications-{brandId}` channel.

### 14. Risks and tradeoffs

- **R7 payload on every reload.** Each debounced realtime reload re-reads 30 days of lines. Line counts are unknown. At an assumed 60 to 150 lines per store per day, that's 2,000 to 4,500 embedded rows per reload. Comparable to what `fetchAllForStore` already pulls, since `fetchInventory` reads all stores, but it also holds back `storeLoading`. The seed has no POS rows, so local dev won't show it. Step 8 reports real counts. If it hurts, the follow-up is to skip the re-read on same-store reloads.
- **`fetchUnmappedPosImports` can undercount.** It's a top-level read on `pos_import_items`, so `max_rows = 1000` applies. With low mapping coverage, 30 days of unmapped lines could pass that. The mapping tab's counts would be low, though names would mostly still appear. Not changed here.
- **The manual path can still leave a header with no items,** because `savePOSImport` (L2993) doesn't check its item insert. R7 makes such a row visible, reading as success with 0 rows. Out of scope under P-9.
- **Recipe history on delete** (section 2.3).
- **Report accuracy** stays as the spec's Risks describe, and R7 adds the COGS card to that list.
- **Watchdog alert noise on a long outage.** Three pushes a morning, deliberate (P-2).
- **The watchdog is itself a cron job with no watchdog.** A failure shows only in `cron.job_run_details`. Accepted as the last line.
- **A second store with a mapped name** becomes a `failed` store with a clear reason. PF-9 confirms none today.
- **CPU limit.** `findRecipe` re-tokenizes every recipe per line: about 150 × 41 small operations per store. Low risk, and precomputing recipe tokens is a one-line change if it shows.
- **Native builds** show the raw key or fallback for the new type until updated. Web ships at step 7.
- **Cold start.** A once-a-day function always cold-starts. Inside the 20-second Breadbot budget per store, and it doesn't affect correctness.

### 15. Not verified

- Edge limits: 150-second wall clock and idle, 2-second CPU. From memory of Supabase's documentation, and the plan wasn't checked. Step 5's timing tests the real case.
- Full-run runtime and line counts. Estimates only until step 5.
- `cron.alter_job` on prod's `pg_cron` version. Local is exercised by pgTAP; PF-7 reads the version.
- That job 5's owner is the caller's role. PF-2's addition checks it.
- `pos_import_items_recipe_id_fkey` being the constraint's name on prod. Step 2's FK check catches a mismatch.
- `service_role` read on `_edge_auth` on prod. Inferred from `eod-reminder-cron` working, and step 5 proves it.
- How deployed v16 differs from the repo copy. Not needed, since v16 is replaced.
- Whether the CLI's secrets listing can be cut to names cleanly. PF-10 asks for names only, so check the output shape before relying on it.
- The `deleteRecipe` wipe was read from code, not run. D-AC-3 runs it.
- PostgREST's `max_rows` on embedded rows. I recall it applying per parent, which wouldn't bind below 1,000 lines per import, but this wasn't tested.
- What `T()` shows for a missing key on an old native bundle.
- Spec 186's build is in progress in another session, so its migration may still change.

### 16. Build split

**backend-developer:** the migration; `breadbot-nightly-sync`; `submission-push-fanout` and `src/utils/pushNotificationCopy.ts` together; `fetch-breadbot-sales` comment; `config.toml`; `.env.local.example`; pgTAP files; the contract jest test; the smoke and stub; `tests/README.md`; `package.json` `test:smoke`; `db.ts` (section 7) and `src/lib/posImportsHydration.ts`.

**frontend-developer:** `useStore.ts` wiring; POS table and phone sort; recipe sales date and labels; prep depletion filter; the bell, phone sheet, types and i18n; the related jest tests; browser preview at desktop and phone widths (P-10).

R7 lands safely before or after the repair, since it loads nothing while the table is empty. **Ship it no later than step 7.** Also follow the project's rule to run full `npx jest` and search for tests pinning old behaviour, notably anything asserting the POS list's reversed order.

**Spotted, not touched:** `findRecipesByMenuItem` ([db.ts L3146](../src/lib/db.ts)) still selects the dropped `recipes.store_id` and has no caller outside its own definition. A cleanup candidate for a later pass.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the "Backend design" section of this spec, using the split in section 16. Re-check the migration slot and the newest notifications_type_check at build time. Don't run any prod step: the runbook in section 10 waits for the owner's go-ahead. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/188-breadbot-nightly-sync-repair.md
