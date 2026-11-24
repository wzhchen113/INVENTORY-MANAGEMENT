# Spec 205: RLS visibility checks run once per query, not once per row

Status: READY_FOR_REVIEW

Numbering: 205 was assigned by the main session on 2026-11-23. Its sibling, spec 206 (one realtime reload per edit, never overlapping), is app-code only and ships independently. No `205-*` file was on disk when this was written.

Origin: the 2026-11-23 slowness investigation (read-only, on prod project `ebwnovzzkwhsdxkpyjka`): finding 1 in the side-session note `slowness-findings.md`, and the "Spec 205" section of `slowness-plan-fixes-1-2.md`. The owner approved the scope on 2026-11-23.

**Owner decisions (2026-11-23, in chat):** the first draft of this spec found two points in the approved scope that couldn't both be met as written. The owner settled both the same day:
- **OQ-1:** option (a). Grant EXECUTE on both new helpers to `authenticated` and `anon`, like every sibling `auth_*` helper. Revoke it from `public`.
- **OQ-2:** the recommended default. Update only the existing pgTAP checks that pin policy text, keeping each check's intent. Behavioural tests stay untouched.

The full record is under **Open questions resolved**. No open questions remain.

## User story

As a store manager using the admin app, I want lists to load and edits and submits to come back in well under a second, not 2 to 12 seconds. I want this without anyone gaining or losing access to any row.

## The problem (measured 2026-11-23; verified in the tree)

- **How the per-row check works.** Most SELECT policies on `public.*` call `public.auth_can_see_store(store_id)` or `public.auth_can_see_brand(brand_id)` in their USING clause.
  - Both are `language sql stable security definer` ([20260517040000_auth_can_see_store_brand_scope.sql](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql) L88-108; [20260509000000_multi_brand_schema_rls.sql](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) L187-210).
  - Postgres can't inline a SECURITY DEFINER function, so it calls the function **once per candidate row**.
  - Each call nests more calls: `auth_is_super_admin()` (a `profiles` lookup), `auth_is_admin()` (a JWT parse), then a `stores` lookup with another `auth_can_see_brand` (two more `profiles` lookups), then a `user_stores` lookup.
  - Measured cost: about 0.5 to 1.1 ms per `auth_can_see_store` call. The helpers appear in 61 store-scoped and 50 brand-scoped policies across 35 tables.
- **Measured on prod.** These are EXPLAIN ANALYZE runs as the brand admin (`role authenticated` plus JWT claims, in a rolled-back transaction):

  | Read | With RLS | Without RLS / notes |
  |---|---|---|
  | `inventory_items` with embeds (887 rows) | 1,574 ms | 35 ms (45x). The `item_vendors` policy re-checks the parent item and calls `auth_can_see_store` again for every link row. |
  | `items_last_counted(store)` (SECURITY INVOKER), 150 items | 2.4 to 2.9 s | About 4k RLS calls on `eod_submissions` / `eod_entries` / `inventory_counts` rows. pg_stat: 791 calls, mean 1,061 ms, max 7.3 s. `staff_items_updated`, which wraps it: 830 calls, mean 1,247 ms. |
  | `audit_log` latest 100 for one store | 630 ms | Seq scan of all 4,007 rows with RLS per row. `audit_log.store_id` has no index (confirmed: no index on `audit_log` in `supabase/migrations/`). |
  | `report_reorder_list`, `compute_menu_capacity`, `report_weekly_lowstock` | mean 1,052 / 752 / 1,509 ms | Invoker RPCs. They speed up with no change of their own. |

  Prod edge logs: p50 0.4 to 1.6 s and p90 5 to 12 s per request, on tables of a few thousand rows. The DB is CPU-bound (cache hit 100%, small compute tier).
- **The fix pattern.** Move the per-caller work into helpers that take no row argument, and call them as `(select helper())`. Postgres plans an uncorrelated scalar subquery as an **InitPlan** and evaluates it once per query. The per-row work then becomes a plain `store_id = ANY ($1)` comparison.

## Open questions resolved (owner, 2026-11-23)

- **Scope?** → Fix 1 only: one migration, no app code. Fix 2 (realtime reload scheduling) is spec 206.
- **New helpers?** → `auth_visible_store_ids() returns uuid[]` and `auth_profile_brand_id() returns uuid`, both SECURITY DEFINER, STABLE, with a pinned search_path.
  - EXECUTE is granted to `authenticated` and `anon`, and revoked from `public` (OQ-1 below).
- **Which policies?** → The SELECT policies, and the USING of ALL-command policies, that call `auth_can_see_store` / `auth_can_see_brand` per row. That's about 35 (list under R4).
- **What stays unchanged?**
  - the functions `auth_can_see_store` / `auth_can_see_brand`;
  - every INSERT/UPDATE/DELETE WITH CHECK;
  - every RPC body;
  - all app code.
- **Visibility?** → Byte-for-byte equivalent for every role, including anon, and including rows with NULL `store_id` / `brand_id`.
- **Extra index?** → `audit_log(store_id, created_at desc)`.
- **Tests?**
  - the existing pgTAP suite green, with only the policy-text-pinning checks updated (OQ-2 below) and every behavioural test unchanged;
  - a new equivalence suite;
  - a new shape lint;
  - `permissive_policy_lint` still passes;
  - local EXPLAIN timings recorded;
  - the rollback text documented.
- **Prod?** → Via Supabase MCP, only on the owner's explicit go-ahead. The push and the prod apply happen close together because of the `db-migrations-applied` gate. After the apply, run a read-only EXPLAIN check on prod.
- **Out of scope?**
  - spec 206;
  - loading only the current store's inventory;
  - multi-step write RPCs;
  - a compute upgrade;
  - the `auth_rls_initplan` advisor warnings on the `profiles` / `user_stores` / `notifications` self-policies (follow-up).
- **OQ-1. Anon caller: who gets EXECUTE on the new helpers?** → **(a): `authenticated` and `anon`, revoked from `public`** (owner, 2026-11-23). This replaces the first brief's "authenticated only".
  - **Why it came up.** Most target policies have no `TO` clause, so they apply to `PUBLIC`, which includes `anon`. For example, `store_member_read_inventory_items` ([20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) L46-48) has none. `anon` also holds SELECT on every `public` table (spec 097, [20260618000000_public_grants_explicit.sql](../supabase/migrations/20260618000000_public_grants_explicit.sql) L148).
    - Today an anon read returns `[]`, because `auth_can_see_store` is granted to anon and returns false.
    - If the new helper weren't executable by anon, Postgres would check EXECUTE when the executor starts. The read would then fail with `42501 permission denied for function ...`, the same symptom as the spec 152 session-loss incident.
  - **Why the grant is safe.** This matches every sibling `auth_*` helper ([20260509000000](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) L241-243; [20260517040000](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql) L116). For anon, `auth.uid()` is null and the JWT carries no admin role. So `auth_visible_store_ids()` returns `'{}'` and `auth_profile_brand_id()` returns null, and anon sees 0 rows with no error, the same as today.
  - **Not chosen:**
    - (b) `TO authenticated` on every rewritten policy;
    - (c) accepting 42501 errors for anon.
- **OQ-2. Existing pgTAP checks that pin policy text?** → **Update only the text-pinning checks, keeping each check's intent. Behavioural tests stay untouched** (owner, 2026-11-23).
  - **The four known pins:**
    - [audit_log_rls_hardening.test.sql](../supabase/tests/audit_log_rls_hardening.test.sql) **S-3** (L263-269): the byte-exact USING of `store_member_read_audit_log`.
    - [invitations_hardening.test.sql](../supabase/tests/invitations_hardening.test.sql) **K-b** (L231-235): requires the SELECT **and** DELETE quals to contain `auth_can_see_brand` (count = 2).
    - [report_last_order_context.test.sql](../supabase/tests/report_last_order_context.test.sql) **P1b** (L845-861): requires the SELECT quals of `purchase_orders`, `po_items`, `order_approvals`, `eod_submissions` and `eod_entries` to contain `auth_can_see_store`, or it reports them `UNSCOPED`.
    - [user_stores_own_row_writes.test.sql](../supabase/tests/user_stores_own_row_writes.test.sql) **T3** (L217-224): the byte-exact qual **and** with_check of the ALL policy `Admins can manage all store links`.
  - **Further pins:** the architect greps the whole `supabase/tests/` tree for other `pg_policies` text pins on the R4 tables before the build. Those may be updated under the same rule.
  - **How each pin is updated:** it re-pins the new text, or the new helper name for the `like` checks, and keeps its intent. For example:
    - P1b still proves each source table is store-scoped, not `UNSCOPED`;
    - K-b still proves the brand scope and the super_admin arm;
    - T3 still pins WITH CHECK byte-unchanged.
  - Every changed check is listed under `## Files changed`.
  - **Not chosen:** excluding the pinned policies from the rewrite.

## Requirements

- **R1. New helper `public.auth_visible_store_ids() returns uuid[]`.**
  - **Shape:** `language sql`, `stable`, `security definer`, pinned `search_path` (the siblings use `public, auth`; the architect confirms).
  - **Returns** the distinct store ids for which today's arms (ii) and (iii) of `auth_can_see_store` hold for the caller:
    - **(ii)** if `public.auth_is_admin()` is true: every `stores.id` whose `brand_id` equals the caller's `profiles.brand_id`. A null profile brand or a null store brand matches nothing, as `brand_id = p_brand_id` does today.
    - **(iii)** UNION every `user_stores.store_id` where `user_id = auth.uid()`.
  - **Empty result:** an empty array (`'{}'`), never null, so `= ANY(...)` evaluates to false rather than null for a non-null id.
  - **Super_admin** (arm (i)) is **not** folded in. It stays a separate `(select public.auth_is_super_admin())` arm in the policy, so rows with a NULL id keep today's outcome (R3).
  - **Grants (OQ-1):** `revoke execute ... from public; grant execute ... to authenticated, anon;`.
  - **Comment:** a `comment on function` states the equivalence to `auth_can_see_store` arms (ii) and (iii), and cites spec 041 and this spec.
- **R2. New helper `public.auth_profile_brand_id() returns uuid`.**
  - **Shape:** the same posture and grants as R1.
  - **Returns** `profiles.brand_id` for `auth.uid()`, or null.
  - **Applies to every role, not only admins.** `auth_can_see_brand` matches the profile brand for every role, so a `role = user` staff member sees brand-scoped rows of their own brand today ([20260509000000](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) L200-210). This helper must keep that.
- **R3. Rewrite rule (equivalence).** In each policy in R4, replace each per-row call in the USING expression as follows. Where it sits inside an EXISTS, replace it there.
  - **Store:** `public.auth_can_see_store(<expr>)` → `((select public.auth_is_super_admin()) OR <expr> = ANY ((select public.auth_visible_store_ids())))`.
  - **Brand:** `public.auth_can_see_brand(<expr>)` → `((select public.auth_is_super_admin()) OR <expr> = (select public.auth_profile_brand_id()))`.
  - **Other helpers in the same qual.** A zero-argument auth helper already in the same USING expression, for example `auth_is_privileged()` in the `audit_log` and `order_approvals` quals, is wrapped in `(select ...)` too. It's the same policy text, and it serves the same goal: no per-row helper call is left in a rewritten qual.
  - **No `auth_is_admin`.** No rewritten qual may name `auth_is_admin`. The spec 157 `super_admin_policy_parity` LINT-1 forbids it, and the R1 helper encapsulates it.
  - **Equivalence holds when the outcome is the same:** for every caller and every row, the row is admitted under the new text iff it was admitted under the old text. The predicates differ only in null versus false for a NULL id:
    - old: `auth_can_see_store(NULL)` is false for a non-super_admin;
    - new: `NULL = ANY(...)` is null.

    Both deny in a USING clause. The architect confirms that no rewritten call sits under `NOT`, `IS FALSE`, `IS NOT TRUE` or a `CASE`, where null and false would differ. If one does, it gets `coalesce(..., false)`.
- **R4. Policies in scope.**
  - **Which ones:** every permissive or restrictive policy on `public.*` whose `cmd` is `SELECT` or `ALL` and whose `qual` calls `auth_can_see_store(` or `auth_can_see_brand(`.
  - **Authoritative list:** the architect takes it from `pg_policies` on a fresh `supabase db reset` (not from grepping migrations), cross-checks it read-only against prod's `pg_policies`, and records it in the design with each policy's old qual text. Any prod/local difference stops the build and goes to the owner.
  - **Expected tables** (from the 2026-11-23 prod scan):
    - `audit_log`, `brands`, `catalog_ingredients`, `eod_entries`, `eod_submissions`, `ingredient_conversions`, `inventory_count_entries`, `inventory_counts`, `inventory_items`, `invitations`;
    - `item_vendors`, `notifications`, `order_approvals`, `order_schedule` (two policies), `po_items`, `pos_import_items`, `pos_imports`, `pos_recipe_aliases`, `prep_recipe_ingredients`, `prep_recipes`;
    - `profiles`, `purchase_orders`, `recipe_ingredients`, `recipe_prep_items`, `recipes`, `report_definitions`, `report_runs`, `staff_reports`, `store_count_layouts`, `stores`;
    - `user_stores`, `vendor_order_attempts`, `vendors`, `waste_log`, `weekly_reminder_log`.
  - **EXISTS-style child policies** get the swap inside the EXISTS: `item_vendors`, `eod_entries`, `inventory_count_entries`, `po_items`, `recipe_ingredients`, `recipe_prep_items`, `prep_recipe_ingredients`, `pos_recipe_aliases`, `ingredient_conversions`, `pos_import_items`, `user_stores`.
  - **Storage policies** on `storage.objects` (for example the `ingredient_images_*` policies pinned by `ingredient_photos.test.sql`) are **not** in scope. The lint (AC-4) covers `public.*` only.
- **R5. Mechanism: `ALTER POLICY ... USING (...)`, not drop and create.**
  - **What it keeps:** policy names, `cmd`, `permissive`, `roles` and the policy count per `(table, cmd)` are unchanged. Spec 157's `report_last_order_context` P1a and spec 194's `kept_records_delete_hardening` pin the names.
  - **No policy is added or dropped,** so the CLAUDE.md permissive-OR rule has nothing new to compose.
- **R6. The WITH CHECK side is unchanged.**
  - INSERT and UPDATE WITH CHECK expressions and DELETE USING expressions are untouched.
  - **The ALL-policy trap:** an ALL policy with **no** explicit WITH CHECK reuses its USING as the write check. So rewriting its USING would silently rewrite its write check too. For each such policy, the migration sets an explicit `WITH CHECK` equal to the **old** USING text, so the write-side predicate stays the old text (equivalent, and still one call per written row).
  - The architect lists which ALL policies this applies to. An ALL policy that already has an explicit WITH CHECK keeps it byte-for-byte (for example `user_stores` T3).
- **R7. Unchanged objects.**
  - the bodies, grants and comments of `auth_can_see_store`, `auth_can_see_brand`, `auth_is_super_admin`, `auth_is_admin` and `auth_is_privileged`;
  - every RPC and trigger body;
  - every edge function;
  - every file under `src/`;
  - the realtime publication.
- **R8. Index.** `create index if not exists audit_log_store_id_created_at_idx on public.audit_log (store_id, created_at desc)` (the architect may rename it).
  - It is not `CONCURRENTLY`: the migration runs in a transaction, and the table has about 4k rows.
- **R9. Rollback text.** The migration header (or the design, if too long) carries hand-written rollback SQL. It is **not** a committed migration file, because that would trip the drift gate:
  1. an `ALTER POLICY` back to each old USING, removing any R6 WITH CHECK that was added;
  2. `drop index` for R8;
  3. `drop function` for both helpers, last.

  The rollback is tested once locally (apply, roll back, then run the full pgTAP suite green), and the result is recorded in the implementation notes.

## Acceptance criteria

**Fixture terms (pgTAP, `begin; … rollback;`):**
- **Brand A** with stores **A1** and **A2**; **brand B** with store **B1**.
- Where the column is nullable, each R4 table has rows at A1, A2 and B1 (or brand A / brand B for brand-scoped tables), **plus a row with a NULL `store_id` / `brand_id`**.
- **Principals:**
  - **SA:** a super_admin. `profiles.role = 'super_admin'`; the JWT role is neither admin nor master.
  - **ADM-A:** a JWT `admin`, profile brand A, no `user_stores`.
  - **MST-A:** a JWT `master`, profile brand A.
  - **ADM-B:** a JWT `admin`, profile brand B.
  - **ADM-A+L:** ADM-A plus a `user_stores` link, if the brand-match trigger allows one the admin arm doesn't already cover; otherwise omitted, with the reason noted.
  - **STALE:** a JWT `admin` whose profile brand is NULL (the spec 195 demoted-admin shape).
  - **ROLE-ONLY:** `profiles.role = 'admin'` but a JWT role of `user` (the parity trap).
  - **STAFF:** `role = user`, profile brand A, linked to A1 only.
  - **LOOSE:** authenticated, profile brand A, no links.
  - **NOBRAND:** authenticated, NULL profile brand, no links.
  - **ANON.**

### Regression and lints (pgTAP)

- [ ] **AC-1 (existing suite, OQ-2):** `scripts/test-db.sh` passes in full.
  - **What may be edited:** only the policy-text-pinning checks (the four named in OQ-2, plus any further ones the architect finds). Each keeps its intent and is listed under `## Files changed`.
  - **What may not:** no behavioural test is edited or deleted. This explicitly includes `auth_can_see_store_brand_scope`, `item_vendors_rls`, `eod_cross_vendor_read_rls`, `super_admin_policy_parity` (including LINT-1), `staff_role_eod_rls`, `profiles_rls_sweep`, `rls_hardening_followups`, `kept_records_delete_hardening`, `retention_prune_job` and `admin_submit_eod`.
- [ ] **AC-2 (equivalence, new suite):** for every R4 policy, and for every principal above, the rows each principal sees under the new policies are exactly the rows postgres finds when it filters the table by that policy's **old** USING text under the same principal's claims.
  - **How the old side is computed:** the old functions still exist (R7), so the suite evaluates the recorded old text directly. Each comparison is a set equality on primary key (`set_eq` or `results_eq` on sorted ids).
  - **The NULL-id rows** are asserted explicitly: SA sees them wherever the old policy let SA see them, and every other principal sees exactly what it saw before.
  - **ALL policies:** the rows reachable by `UPDATE … SET <col> = <col> … RETURNING id` and by `DELETE … RETURNING id`, run inside a savepoint that is rolled back, are equal under old and new text.
- [ ] **AC-3 (anon, OQ-1):** as ANON, every R4 table's SELECT returns 0 rows with **no error** (no 42501), the same as today.
  - `has_function_privilege` shows EXECUTE on both helpers for `authenticated` and `anon`, and not for `public`.
- [ ] **AC-4 (shape lint, new suite):** a pgTAP arm fails, listing each offender, when any policy on `public.*` with `cmd in ('SELECT','ALL')` has a `qual` containing `auth_can_see_store(` or `auth_can_see_brand(`.
  - **Exemptions** go in an explicit VALUES allowlist, the same shape as spec 053. It is seeded empty, unless the architect finds a policy that must keep the call and records why.
  - The arm proves it can fail: it creates a throwaway offending policy in the transaction, asserts the lint query returns it, then drops it.
- [ ] **AC-5 (helpers' posture):** both helpers have `prosecdef = true`, `provolatile = 's'`, the pinned `proconfig` search_path, and the R1/R2 return types.
  - `auth_visible_store_ids()` returns `'{}'`, not null, for NOBRAND and for ANON. `auth_profile_brand_id()` returns null for ANON.
  - It returns exactly {A1, A2} for ADM-A and MST-A, {B1} for ADM-B, {A1} for STAFF, `'{}'` for STALE, ROLE-ONLY (unless that principal has links) and LOOSE.
- [ ] **AC-6 (policy posture):** for every R4 policy:
  - the name, `cmd`, `permissive` and `roles` are unchanged;
  - the per-`(table, cmd)` count is unchanged;
  - the INSERT/UPDATE WITH CHECK and DELETE USING text is byte-identical to before;
  - every ALL policy that lacked a WITH CHECK now carries one equal to its old USING (R6).

  `permissive_policy_lint.test.sql` passes with no allowlist change.
- [ ] **AC-7 (index):** `audit_log_store_id_created_at_idx` (or the architect's name) exists on `(store_id, created_at desc)`.

### Performance evidence (local; recorded in this spec)

- [ ] **AC-8 (plan shape):** as ADM-A on the local stack, `EXPLAIN (ANALYZE, BUFFERS)` of each of these shows the visibility helpers only as `InitPlan` nodes, and no `auth_can_see_store` / `auth_can_see_brand` in any per-row Filter, SubPlan or Join Filter:
  - (a) the app's `inventory_items` read with its embeds, the same select string `db.fetchInventory` sends;
  - (b) `select * from public.items_last_counted('<A1>')`;
  - (c) `select * from public.audit_log where store_id = '<A1>' order by created_at desc limit 100`, which also uses the R8 index (no seq scan).
- [ ] **AC-9 (timings):** a before/after table for (a) to (c), with row counts, goes in this spec's implementation notes. Before is measured on the pre-migration local DB, after on the migrated one. Each runs three times and the median is reported.
  - **The no-RLS baseline for (a)** (as postgres) is recorded alongside.
  - **The target:** (a) after is within 3x the no-RLS baseline. This is the expectation; a miss is reported and investigated, not silently accepted.

### Realtime and gates

- [ ] **AC-10 (realtime unchanged, manual local check):** realtime `postgres_changes` delivery is authorized by these same SELECT policies. On the local stack, with two signed-in browsers (ADM-A on store A1 and ADM-B on B1), an `inventory_items` update at A1 reaches ADM-A's `store-{A1}` subscription and not ADM-B. This is recorded in the implementation notes. No publication changes, so the `docker restart supabase_realtime_imr-inventory` ritual does **not** apply.
- [ ] **AC-11 (no client change):** no file under `src/` or `supabase/functions/` changes. The full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass.
- [ ] **AC-12 (rollback rehearsed, R9):** the rollback SQL is applied locally after the migration, the full pgTAP suite is then green with the pre-205 text-pin checks, and the result is recorded. The DB is then re-migrated.

### Prod (owner go-ahead only; recorded in the implementation notes)

- [x] **AC-13 (pre-check, read-only):**
  - prod's `pg_policies` for the R4 tables match the local pre-migration texts the design recorded;
  - prod's `auth_can_see_store` / `auth_can_see_brand` / `auth_is_super_admin` match local by normalized md5;
  - `to_regprocedure('public.auth_visible_store_ids()')` and `to_regprocedure('public.auth_profile_brand_id()')` are both NULL on prod before the apply. `create or replace` would keep an existing function's owner and ACL; the migration's pre-flight also refuses this case (release proposal B-1).

  **AC-13 is a hard gate, not paperwork** (release proposal A-4). Any mismatch stops the apply and goes to the owner.
- [x] **AC-14 (post-check):**
  - prod's helpers match local by normalized md5 and by `prosecdef` / `proconfig` / `proacl` (the `proacl` includes `anon` and `authenticated`, not `public`);
  - prod's `pg_policies` for the R4 tables match local post-migration;
  - the index is present;
  - the AC-8 EXPLAINs re-run read-only on prod as the brand admin (in a rolled-back transaction, the same method as 2026-11-23) show the InitPlan shape. Their timings are recorded next to the 2026-11-23 figures;
  - the `pg_read_all_data` members (`supabase_read_only_user`, `supabase_etl_admin`) are still BYPASSRLS on prod (security verification item 5);
  - **SF-2 sizing** for the non-R4 `super_admin_read_all_profiles` per-row path: record `select count(*) from public.inventory_items where last_updated_by is not null`, and, for the profiles node of the prod (a) plan, its `loops`, its actual time, and whether `auth_is_super_admin()` sits in its Filter. If this path makes prod (a) miss the 3x target, report it; it is not an AC-14 failure.

  **AC-14 is a hard gate, not paperwork** (release proposal A-4). Any mismatch goes to the owner for the R9 rollback decision.

## In scope

- One migration, sorted after the newest migration on disk at build time. Today that's `20261118120100`; re-glob for specs 202/203/204/206. It contains:
  - the two R1/R2 helpers with their grants and comments;
  - the R4 `ALTER POLICY` rewrites, with R6's explicit WITH CHECKs;
  - the R8 index;
  - a header covering the posture, the equivalence argument, the realtime note, the prod apply, the R9 rollback and lock behaviour (`ALTER POLICY` takes an ACCESS EXCLUSIVE lock per table: use `set local lock_timeout`, one transaction).
- One new pgTAP equivalence suite (AC-2, AC-3, AC-5, AC-6) and one shape-lint suite (AC-4). Or one suite; the architect names the files.
- The text-pin check updates under OQ-2.
- The AC-8/AC-9 evidence, the AC-10 check, the AC-12 rehearsal, and the AC-13/14 prod records.

## Out of scope (explicitly)

- **Spec 206** (realtime reload scheduling, single-flight). It's a separate spec, with no file overlap.
- **Loading only the current store's inventory** (findings §3). It needs an audit of the cross-store sections first.
- **The serial fetch waterfall** (findings §4) and **multi-step write RPCs** (findings §5).
- **A compute-tier upgrade.**
- **Changing write-side policies** (INSERT/UPDATE WITH CHECK, DELETE USING). They run once per written row, and writes are small.
- **Changing RPC bodies,** including the interim "make `items_last_counted` SECURITY DEFINER" idea from the findings note. The policy rewrite makes it unnecessary.
- **The 29 `auth_rls_initplan` advisor warnings** on self-policies such as `user_id = auth.uid()` on `profiles`, `user_stores` and `notifications`. They're a follow-up spec; the per-call cost there is small.
- **Storage (`storage.objects`) policies.**
- **Changing `auth_can_see_store` / `auth_can_see_brand`** or their callers in RPCs and edge functions.
- **Changing policy role lists** (`TO authenticated`). Not chosen under OQ-1.
- **`waste_log` unbounded reads and unfiltered `fetchIngredientConversions`** (findings §6). These are client changes.
- **The `app.json` slug.** It isn't touched.

## Dependencies

- **Spec 041:** the three-arm semantics of `auth_can_see_store` that R1 must mirror.
- **Spec 012a / multi-brand** (`20260509000000`): `auth_can_see_brand`, `auth_is_super_admin` and the grant posture that R1/R2 copy.
- **Spec 053:** `permissive_policy_lint`, which must stay green.
- **Spec 157:** `super_admin_policy_parity` LINT-1 (no `auth_is_admin` in any policy), and the `report_last_order_context` P1a/P1b pins.
- **Specs 170, 198, 195:** the `audit_log`, `invitations` and `user_stores` text pins (OQ-2).
- **Spec 097:** the explicit table grants that make anon reach these policies (OQ-1).
- **Spec 064:** the `db-migrations-applied` gate (prod timing).
- **Specs 202/203/204:** migration ordering only. Re-glob before dating the file.
- No library or edge-function dependency.

## Project-specific notes

- **Cmd UI section / legacy:** none. This is a server-only change. Every Cmd UI section, and the staff app (which reads through the same policies), get faster with no code change.
- **Which app:** this repo's admin and staff surfaces. The customer PWA reads through `pwa-catalog` with a service token, which bypasses RLS, so it's unaffected.
- **Per-store or admin-global:** this spec is about the per-store and per-brand visibility layer itself. Visibility is unchanged by contract (AC-2, AC-3).
- **Edge function or PostgREST:** database only. Service-role edge functions bypass RLS and are unaffected. User-JWT calls get the new policies.
- **Realtime channels touched:** none changed. `store-{id}` and `brand-{id}` delivery is authorized by the rewritten SELECT policies, so AC-10 checks it. No publication change, so the restart gotcha doesn't apply.
- **Migrations needed:** yes, one.
- **Edge functions touched:** none.
- **Web/native scope:** both, server-side only. Every installed client benefits once the migration is on prod. No Vercel deploy or EAS build is needed.
- **`app.json` slug:** not touched.
- **Tests:** pgTAP (AC-1 to AC-7, AC-12). Jest and typecheck as regression gates only (AC-11). No shell smoke.

## Residual risk

- **Access-control layer (medium-high).** A wrong rewrite leaks or hides rows. Mitigations:
  - the AC-2 equivalence suite across 11 principals, including NULL-id rows;
  - the AC-4 lint against reintroduction;
  - security-auditor review;
  - prod pre/post policy diffs (AC-13/14);
  - a rehearsed rollback (AC-12).
- **Helper drift.** `auth_visible_store_ids` duplicates arms (ii) and (iii) of `auth_can_see_store`. A future change to one that isn't made to the other would split read visibility from write checks and RPC gates.
  - The AC-2 suite catches it only if it's re-run against the changed function. The helper's `comment on function` and the migration header must say "change both together".
  - The architect may propose a CLAUDE.md convention bullet. Agents don't edit CLAUDE.md without the owner's approval.
- **Weaker text pins.** Updating the four text-pinning checks (OQ-2) means they now pin the new shape. The behavioural proof of equivalence comes from AC-2, not from those checks.
- **Prod-only policies.** A policy edited on prod through the dashboard would differ from local. AC-13 stops the apply if so.
- **Lock window.** `ALTER POLICY` on about 35 tables in one transaction briefly blocks reads on each table. Apply in a quiet window, with `lock_timeout`.
- **The InitPlan inside an EXISTS** on child tables may be planned as a per-outer-row SubPlan in some plan shapes. AC-8 (a) checks the `item_vendors` embed, the worst measured case.

## Prod apply and commit (owner, later; not part of this spec's done state)

- **Commit:** stage only. Don't commit without the owner's explicit go-ahead.
- **Prod apply** (Supabase MCP, project `ebwnovzzkwhsdxkpyjka`), only on the owner's go-ahead, in a quiet window:
  1. Run the AC-13 read-only pre-check.
  2. `execute_sql` the migration body as one transaction.
  3. Insert the exact version into `supabase_migrations.schema_migrations`.
  4. Run the AC-14 post-check, including the read-only EXPLAINs.
- **Timing:** the push to `main` and the prod apply happen close together, or `db-migrations-applied.yml` goes red. After the push, confirm `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand.
- **Rollback:** the R9 SQL, applied the same way, only on an owner decision.

## Handoff
next_agent: backend-architect
prompt: Design the contract for spec 205 (RLS visibility once per query). Read the acceptance criteria and project-specific notes, then:
  - enumerate the R4 policies from pg_policies on a fresh db reset with their old qual text, and cross-check prod read-only;
  - specify both helper bodies and their grants (authenticated + anon, revoked from public, per OQ-1);
  - give the exact ALTER POLICY rewrites, including the R6 explicit WITH CHECKs for ALL policies;
  - grep supabase/tests/ for every policy-text pin on the R4 tables (OQ-2);
  - lay out the equivalence and lint suites, and the migration name and position.
  Then produce the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/205-rls-visibility-once-per-query.md

## Backend design

Architect, 2026-11-23. Database only: one migration, two new pgTAP files, edits to three existing pgTAP files. No `src/`, no edge function, no publication change.

### D-0. Summary of decisions

1. **Two helpers, as specced:** `public.auth_visible_store_ids() returns uuid[]` and `public.auth_profile_brand_id() returns uuid`. Both are `language sql stable security definer set search_path = public, auth`. EXECUTE is revoked from `public` and granted to `authenticated, anon, service_role`. The extra `service_role` grant is additive: it matches the spec 097 default privileges, and it keeps `proacl` the same whichever role creates the function on prod (see D-7).
2. **36 policies on 35 tables, rewritten with `ALTER POLICY ... USING (...)` only.** The list in D-2 matches prod exactly (cross-check below).
3. **R6 adds no WITH CHECK.** Both ALL policies (`order_schedule` "Admins can write order_schedule" and `user_stores` "Admins can manage all store links") already have an explicit WITH CHECK equal to their USING, both on prod (export note) and in the repo ([20260517050000](../supabase/migrations/20260517050000_rls_hardening_followups.sql) L75-76; [20260520010000](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql) L120-138).
   - The `ALTER POLICY` statements therefore **omit** `WITH CHECK`, which leaves it byte-for-byte unchanged.
   - A pre-flight in the migration fails if either WITH CHECK is NULL (D-3 step 2).
4. **One NOT context: `invitations`.** It gets `coalesce(..., false)`; details in D-2.4. No other rewritten call sits under `NOT`, `IS FALSE`, `IS NOT TRUE` or `CASE`.
5. **`auth.uid()` is wrapped in `profiles` only.** In `invitations` it stays bare on purpose (D-2.5).
6. **Migration:** `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql`. Re-glob before committing; specs 202, 203 and 204 are READY_FOR_ARCH and may add migrations.
7. **Tests:**
   - two new files: `supabase/tests/rls_visibility_once_per_query.test.sql` (AC-2, AC-3, AC-5, AC-6, AC-7) and `supabase/tests/rls_per_row_helper_lint.test.sql` (AC-4);
   - four existing files edited, one arm each: `audit_log_rls_hardening` S-3, `invitations_hardening` K-b, `report_last_order_context` P1b, `user_stores_own_row_writes` T3.

### D-1. Prod vs repo cross-check (R4, AC-13 precondition)

I ran two checks:
- Each of the 36 policy names in the prod export was grepped in `supabase/migrations/`, and I took the latest `create policy`.
- A separate multiline grep listed every `create policy … for select|all … auth_can_see_(store|brand)` in the repo. It finds exactly these 36, plus the out-of-scope `storage.objects` policy `ingredient_images_public_read`.

The only `alter policy` statements in the repo are on two RESTRICTIVE `audit_log` policies that are not in scope.

**Result: no difference between repo and prod. Nothing blocks the build.** The details:
- Every prod qual is the deparse of the repo source in the table below.
- `roles` match: `{authenticated}` for invitations only, `{public}` for the rest (`user_stores` says `to public` explicitly).
- All 36 are PERMISSIVE.
- Both ALL policies have with_check equal to qual.
- The latest definitions come from: `20260504173035` (9 policies), `20260509000000` (11), `20260510020000` (order_schedule read), `20260510120000` (2), `20260513000000` (2), `20260517050000` (order_schedule ALL), `20260517060000` (profiles), `20260520010000` (user_stores), `20260622090100`, `20260630000000`, `20260706000000`, `20260715000000`, `20260720000000`, `20260801000100`, `20260809000000` (audit_log), `20260829000000` and `20261110120000` (invitations).

The prod helper bodies in the export match the latest repo definitions:
- `auth_can_see_store`: [20260517040000](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql) L88-108.
- `auth_can_see_brand`, `auth_is_super_admin` and `auth_is_privileged`: [20260509000000](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) L187-239.
- `auth_is_admin`: [20260504073942](../supabase/migrations/20260504073942_brand_catalog_p5_rls.sql) L23-27.

**Build step 0 (required, stops the build on a mismatch).** On a fresh `npx supabase db reset`, run:

```sql
select tablename, policyname, cmd, permissive, roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and cmd in ('SELECT','ALL')
   and qual ~ 'auth_can_see_(store|brand)\('
 order by tablename, policyname;
```

- It must return exactly the 36 rows in D-2. Save the output as the **pre-205 manifest** (D-6 step 1); it is the "recorded old text" for AC-2 and AC-13.
- A 37th row (for example from spec 204 landing first) stops the build and goes back to the architect.

### D-2. Helpers, equivalence proof, and the exact rewrites

#### D-2.1 Helper bodies (design; the developer authors the file)

```sql
create or replace function public.auth_visible_store_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, auth
as $$
  select array(
    select s.id
      from public.stores s
     where public.auth_is_admin()
       and exists (
         select 1 from public.profiles p
          where p.id = auth.uid()
            and p.brand_id = s.brand_id
       )
    union
    select us.store_id
      from public.user_stores us
     where us.user_id = auth.uid()
  );
$$;

create or replace function public.auth_profile_brand_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select p.brand_id from public.profiles p where p.id = auth.uid();
$$;

revoke all on function public.auth_visible_store_ids() from public;
revoke all on function public.auth_profile_brand_id()  from public;
grant execute on function public.auth_visible_store_ids() to authenticated, anon, service_role;
grant execute on function public.auth_profile_brand_id()  to authenticated, anon, service_role;
```

Notes on the bodies:
- `array(select …)` returns `'{}'` on an empty result, never NULL (R1). Do not use `array_agg`, which returns NULL on an empty set.
- Every object reference is schema-qualified, so the `public, auth` search_path (the same as the siblings) only affects operator lookup, and `pg_catalog` is searched first implicitly.
- The `exists (profiles …)` form copies the `auth_can_see_brand` arm character for character. That makes review a line-by-line diff.
- `comment on function` for each:
  - **auth_visible_store_ids:** `'spec 205: store ids for which arms (ii) and (iii) of auth_can_see_store (spec 041) hold for the caller — own-brand stores when auth_is_admin() and profiles.brand_id matches stores.brand_id, UNION the caller''s user_stores links. Super_admin (arm i) is NOT folded in; policies OR (select auth_is_super_admin()) separately. Never NULL. CHANGE BOTH TOGETHER: any edit to auth_can_see_store must be mirrored here, and supabase/tests/rls_visibility_once_per_query.test.sql re-run.'`
  - **auth_profile_brand_id:** `'spec 205: the caller''s profiles.brand_id or NULL, for every role. Mirrors the non-super_admin arm of auth_can_see_brand (spec 012a). CHANGE BOTH TOGETHER with auth_can_see_brand.'`

#### D-2.2 Rewrite fragments

Let `S`, `V` and `B` stand for the following exact texts:
- `S` = `(select public.auth_is_super_admin())`
- `V` = `(select public.auth_visible_store_ids())::uuid[]`, an InitPlan subquery cast to the type it already returns (design fix, 2026-11-23; see below)
- `B` = `(select public.auth_profile_brand_id())`

Then:
- **Store swap:** `public.auth_can_see_store(<e>)` → `(S or <e> = any (V))`. Written out, the store fragment is `<e> = any ((select public.auth_visible_store_ids())::uuid[])`.
  - **The `::uuid[]` cast is load-bearing** (corrected 2026-11-23, after the developer's hand-back). The first draft said double parentheses were enough. That was wrong.
    - In the Postgres grammar, `select_with_parens` absorbs any number of parentheses. So `= any (select …)`, `= any ((select …))` and `= any (((select …)))` all parse as the subquery form of ANY. That form compares `<e>` with each row, each row is a `uuid[]`, and the query fails with `42883 operator does not exist: uuid = uuid[]`. The developer confirmed this on PostgreSQL 17.6 (repro and evidence under "Implementation notes").
    - The cast makes the operand an ordinary expression. It is then a scalar subquery returning the array, planned as one InitPlan: `Filter: (store_id = ANY ((InitPlan 1).col1))`.
    - `pg_policies` deparses it as `(<e> = ANY (( SELECT auth_visible_store_ids() AS auth_visible_store_ids)::uuid[]))`.
  - **Why the cast rather than `coalesce((select …), '{}')` or `array(select unnest(…))`:**
    - The cast to the type the helper already returns adds no semantics, so the D-2.3 proof is unchanged. Within the same type it is display-only: no conversion function runs at execution.
    - `coalesce` would add a per-row expression node for no benefit, because the helper never returns NULL (R1, pinned by AC-5). It would also turn a hypothetical NULL return into an empty array, hiding a broken helper instead of failing closed. A bare NULL array already denies, through `= ANY(NULL)` → NULL.
    - `array(select unnest(…))` rebuilds the array through a second sublink.
  - **Residual:** an explicit cast would silently coerce if the helper's return type ever changed, for example to `text[]`. AC-5 pins `prorettype = 'uuid[]'::regtype`, so that change would fail the suite.
  - **Dropping the cast fails loudly.** The migration aborts with 42883 and rolls back whole; nothing changes silently.
  - **R3 supersession:** R3's literal store form (`= ANY ((select …))`) has the same defect. This fragment supersedes it. The semantics are identical; only the syntax changes.
- **Brand swap:** `public.auth_can_see_brand(<e>)` → `(S or <e> = B)`.
- **Other zero-argument helpers in a rewritten qual** are wrapped:
  - `auth_is_privileged()` → `(select public.auth_is_privileged())`;
  - `auth_is_super_admin()` → `S`;
  - `auth_profile_is_privileged()` → `(select public.auth_profile_is_privileged())`.
- **No rewritten qual names `auth_is_admin`** (spec 157 LINT-1). It lives only inside `auth_visible_store_ids()`, and LINT-1 scans `pg_policies` only, never function bodies (super_admin_policy_parity.test.sql L444-451).

#### D-2.3 Equivalence proof (old text vs new text, every caller, every row)

Old definitions:
- `cs(x)` = `SA ∨ (ADM ∧ ∃s[s.id=x ∧ cb(s.brand_id)]) ∨ ∃us[us.user_id=uid ∧ us.store_id=x]`
- `cb(b)` = `SA ∨ ∃p[p.id=uid ∧ p.brand_id=b]`

Here `SA` = `auth_is_super_admin()`, `ADM` = `auth_is_admin()` (the JWT claim), and `uid` = `auth.uid()`. Both helpers are SECURITY DEFINER, owned by `postgres` (which owns these tables), and the tables don't FORCE RLS. So their reads of `stores`, `profiles` and `user_stores` are unfiltered, in the old helpers and the new ones alike.

**Case SA true.** Old `cs(x)` and `cb(b)` are true for every x, including NULL. New: `S or …` is true. Equal.

**Case SA false.** Inside the ADM arm, `cb(s.brand_id)` reduces to `∃p[p.id=uid ∧ p.brand_id=s.brand_id]`. So:
- `cs(x) ≡ (ADM ∧ ∃s[s.id=x ∧ ∃p[...]]) ∨ ∃us[...]`.
- `V` = `{s.id | ADM ∧ ∃p[p.id=uid ∧ p.brand_id=s.brand_id]} ∪ {us.store_id | us.user_id=uid}`.
- **Non-NULL x:** `x = any(V)` is true iff x is in either set. That holds iff `cs(x)`, because `stores.id` is the PK, so `s.id = x` selects at most one store. If x is in neither set, the result is false; it could be NULL only if `V` contains a NULL element, and NULL still denies.
- **NULL x:** old: `s.id = NULL` and `us.store_id = NULL` are never true, so `cs(NULL)` is false. New: `NULL = any(V)` is NULL (or false when `V='{}'`). Both deny in USING.
- **Brand, non-NULL b:** `profiles.id` is the PK, so `∃p[p.id=uid ∧ p.brand_id=b]` is true iff `B = b`. `B` is NULL when there is no profile or the profile brand is NULL; that is NULL vs false, and both deny.
- **Brand, NULL b:** old false; new NULL. Both deny.

**Snapshot.** The old per-row STABLE call and the new InitPlan both run against the statement's snapshot. Neither sees rows written by the current command, for example on INSERT … RETURNING, where the SELECT policy is checked. Behaviour is the same.

**InitPlan timing.** An InitPlan is evaluated lazily on first use, once per execution. That includes generic plans and PostgREST prepared statements, and realtime's per-subscriber execution with that subscriber's claims. An empty table never evaluates it, which is also the same as today.

Per-principal check of the proof. A1 and A2 are brand-A stores; B1 is a brand-B store:

| principal | profile role / brand | JWT `app_metadata.role` | links | `V` | `B` | `cs(A1)` | `cs(B1)` | `cs(NULL)` |
|---|---|---|---|---|---|---|---|---|
| SA | super_admin / NULL | super_admin | – | `{}` | NULL | t (S) | t (S) | t (S) |
| ADM-A | admin / A | admin | – | {A1,A2} | A | t | f | f |
| MST-A | master / A | master | – | {A1,A2} | A | t | f | f |
| ADM-B | admin / B | admin | – | {B1} | B | f | t | f |
| ADM-A+L | admin / A | admin | A1, **B1 (planted, D-5.2)** | {A1,A2,B1} | A | t | t | f |
| STALE | user / NULL | admin | – | `{}` | NULL | f | f | f |
| STALE+L | user / NULL | admin | A1 | {A1} | NULL | t | f | f |
| ROLE-ONLY | admin / A | user | – | `{}` | A | f | f | f |
| STAFF | user / A | user | A1 | {A1} | A | t | f | f |
| LOOSE | user / A | user | – | `{}` | A | f | f | f |
| NOBRAND | user / NULL | user | – | `{}` | NULL | f | f | f |
| ANON | (none) | (anon JWT) | – | `{}` | NULL | f | f | f |

Notes on this table:
- The `cs` columns hold for old and new alike, with NULL read as deny.
- Brand checks follow `B`, so LOOSE and STAFF see brand-A rows on brand-scoped tables. That is R2 and today's behaviour.
- **ADM-A+L.** The spec allows the principal to be omitted if the trigger blocks a useful link. A same-brand link is redundant under arm (ii), so the fixture **plants a cross-brand B1 link with the trigger disabled inside the transaction.** That is the only fixture that proves the UNION keeps arm (iii) for admins.
- **STALE+L** is added: it is the exact spec 195 demoted-admin shape (NULL brand, keeps a link).

#### D-2.4 The NOT context (R3), `invitations` only

In the old SELECT qual, `NOT (EXISTS (... WHERE s.id IS NULL OR NOT auth_can_see_brand(s.brand_id)))`, the call sits under `NOT`:
- Old, non-SA caller with `B` NULL: `NOT false` is true, so the store row matches, the EXISTS is true, and the invitation is **hidden**.
- A bare new swap would give `NOT NULL` = NULL. The row would not match, the EXISTS could be false, and the invitation would be **visible**.

Today this is unreachable: the leading `auth_profile_is_privileged()` requires a profile role of admin, master or super_admin. `profiles_role_brand_consistent` forces a non-NULL brand on admin and master, and super_admin short-circuits. The coalesce is still required, so the predicate stays exact:
`not coalesce(((select public.auth_is_super_admin()) or s.brand_id = (select public.auth_profile_brand_id())), false)`.

`stores.brand_id` is NOT NULL ([20260504072830](../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql) L19). I audited every other rewritten call: none sits under NOT, IS FALSE, IS NOT TRUE or CASE.

Re-checked for the 2026-11-23 `::uuid[]` fix:
- This `coalesce` wraps a **brand** comparison (`= (select …)`, a plain scalar subquery). The developer confirmed that form parses, so it is unaffected.
- The `invitations` SELECT contains no store fragment.
- Its `coalesce(..., false)` is boolean-level: it maps NULL to false under `NOT`. It is unrelated to the rejected array-level `coalesce((select …), '{}')` alternative.
- The store fragment appears only in the 21 store-scoped rewrites in D-2.6: 13 direct, 2 privileged, 5 EXISTS children and `audit_log`. None of them sits under NOT.

#### D-2.5 `auth.uid()` wrapping

- **`profiles` "Admins can read all profiles":** wrapped, `id = (select auth.uid())`. No test pins this text, and the policy is on the inventory read path (the `updater:profiles` embed).
- **`invitations` SELECT:** `invitations.invited_by = auth.uid()` stays **bare**, for three reasons:
  - it is the last OR arm, reached only for brand-less, store-less rows;
  - `auth.uid()` is not SECURITY DEFINER;
  - wrapping it would break the literal `invited_by = auth.uid()` checks in `invitations_hardening` K-b **and** `profiles_insert_hardening` K-13. Those exist to pin the D-7 inviter arm, and the gain is nil.

  This is the "where safe" exception. R3's goal of no per-row `public.auth_*` call in a rewritten qual still holds.

#### D-2.6 The 36 rewrites (the migration body; old USING is the repo source text, which deparses to the prod export)

All of these are `alter policy "<name>" on public.<table> using (<new>);` with no WITH CHECK clause.

**Direct store-scoped (13).** New USING `((select public.auth_is_super_admin()) or <col> = any ((select public.auth_visible_store_ids())::uuid[]))`:

| table | policy | `<col>` | old USING |
|---|---|---|---|
| eod_submissions | store_member_read_eod_submissions | store_id | `public.auth_can_see_store(store_id)` |
| inventory_counts | store_member_read_inventory_counts | store_id | same |
| inventory_items | store_member_read_inventory_items | store_id | same |
| order_schedule | Store members can read order_schedule | store_id | same |
| pos_imports | store_member_read_pos_imports | store_id | same |
| purchase_orders | store_member_read_purchase_orders | store_id | same |
| report_definitions | store_member_read_report_definitions | store_id | same |
| report_runs | store_member_read_report_runs | store_id | same |
| store_count_layouts | store_member_read_count_layouts | store_id | same |
| vendor_order_attempts | store_member_read_vendor_order_attempts | store_id | same |
| waste_log | store_member_read_waste_log | store_id | same |
| weekly_reminder_log | weekly_reminder_log_read | store_id | same |
| stores | store_member_read_stores | **id** | `public.auth_can_see_store(id)` |

**Store plus privileged (2):**
- `order_approvals` / `privileged_store_read_order_approvals`
  - old: `public.auth_is_privileged() and public.auth_can_see_store(store_id)`
  - new: `(select public.auth_is_privileged()) and ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]))`
- `order_schedule` / `Admins can write order_schedule` (**ALL**)
  - same old and new as above. **The WITH CHECK is not in the statement** and stays `(auth_is_privileged() AND auth_can_see_store(store_id))`.

**Store-scoped EXISTS children (5).** New USING `exists (select 1 from public.<parent> <a> where <a>.id = <table>.<fk> and ((select public.auth_is_super_admin()) or <a>.store_id = any ((select public.auth_visible_store_ids())::uuid[])))`. Old: the same EXISTS with `public.auth_can_see_store(<a>.store_id)`.

| table | policy | parent `<a>` | fk |
|---|---|---|---|
| eod_entries | store_member_read_eod_entries | eod_submissions `s` | submission_id |
| inventory_count_entries | store_member_read_inventory_count_entries | inventory_counts `c` | count_id |
| item_vendors | store_member_read_item_vendors | inventory_items `ii` | item_id |
| po_items | store_member_read_po_items | purchase_orders `po` | po_id |
| pos_import_items | store_member_read_pos_import_items | pos_imports `pi` | import_id |

**audit_log / store_member_read_audit_log (1):**
- old: `(store_id is not null and public.auth_can_see_store(store_id)) or (store_id is null and public.auth_is_privileged())`
- new: `(store_id is not null and ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]))) or (store_id is null and (select public.auth_is_privileged()))`

**Direct brand-scoped (4).** New USING `((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id()))`. Old: `public.auth_can_see_brand(brand_id)`. The four:
- catalog_ingredients / brand_member_read_catalog_ingredients
- prep_recipes / brand_member_read_prep_recipes
- recipes / brand_member_read_recipes
- vendors / brand_member_read_vendors

**brands / brand_member_read_brands (1):**
- old: `public.auth_can_see_brand(id) and (deleted_at is null or public.auth_is_super_admin())`
- new: `((select public.auth_is_super_admin()) or id = (select public.auth_profile_brand_id())) and (deleted_at is null or (select public.auth_is_super_admin()))`

**Brand plus privileged (2).** Applies to `notifications` / `privileged_brand_read_notifications` and `staff_reports` / `privileged_brand_read_staff_reports`:
- old: `public.auth_is_privileged() and public.auth_can_see_brand(brand_id)`
- new: `(select public.auth_is_privileged()) and ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id()))`

**profiles / Admins can read all profiles (1):**
- old: `(public.auth_is_privileged() and public.auth_can_see_brand(brand_id)) or id = auth.uid()`
- new: `((select public.auth_is_privileged()) and ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id()))) or id = (select auth.uid())`

**Brand-scoped EXISTS children (5).** New USING `exists (select 1 from public.<parent> <a> where <a>.id = <table>.<fk> and ((select public.auth_is_super_admin()) or <a>.brand_id = (select public.auth_profile_brand_id())))`. Old: the same EXISTS with `public.auth_can_see_brand(<a>.brand_id)`.

| table | policy | parent `<a>` | fk |
|---|---|---|---|
| ingredient_conversions | brand_member_read_ingredient_conversions | catalog_ingredients `ci` | catalog_id |
| pos_recipe_aliases | brand_member_read_pos_recipe_aliases | recipes `r` | recipe_id |
| prep_recipe_ingredients | brand_member_read_prep_recipe_ingredients | prep_recipes `pr` | prep_recipe_id |
| recipe_ingredients | brand_member_read_recipe_ingredients | recipes `r` | recipe_id |
| recipe_prep_items | brand_member_read_recipe_prep_items | recipes `r` | recipe_id |

**user_stores / Admins can manage all store links (1, ALL):**
- old: `public.auth_is_privileged() and exists (select 1 from public.stores s where s.id = user_stores.store_id and public.auth_can_see_brand(s.brand_id))`
- new: `(select public.auth_is_privileged()) and exists (select 1 from public.stores s where s.id = user_stores.store_id and ((select public.auth_is_super_admin()) or s.brand_id = (select public.auth_profile_brand_id())))`
- The WITH CHECK is not in the statement and stays byte-identical (T3).

**invitations / Admins can read invitations (1, `to authenticated`).** Old: [20261110120000](../supabase/migrations/20261110120000_invitations_hardening.sql) L252-269. New:

```
(select public.auth_profile_is_privileged())
and invitations.role in ('user', 'admin')
and (invitations.brand_id is null
     or ((select public.auth_is_super_admin()) or invitations.brand_id = (select public.auth_profile_brand_id())))
and not exists (
  select 1
    from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
    left join public.stores s on s.id::text = lower(sid.store_id)
   where s.id is null
      or not coalesce(((select public.auth_is_super_admin()) or s.brand_id = (select public.auth_profile_brand_id())), false)
)
and (
  invitations.brand_id is not null
  or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
  or (select public.auth_is_super_admin())
  or invitations.invited_by = auth.uid()
)
```

Count: 13 + 2 + 5 + 1 + 4 + 1 + 2 + 1 + 5 + 1 + 1 = **36**.

**Effects that come for free (no change needed):**
- Several policy subqueries read RLS-protected tables. RLS applies recursively inside them: `inventory_items` inside `item_vendors`, `stores` inside `user_stores` and `invitations`. Every recursion target is itself in R4, so the composition stays equivalent and gets cheap at each level.
- There is no recursion loop, because the helpers are DEFINER and read `stores`, `profiles` and `user_stores` unfiltered.

**One deviation from R6's wording.** For the two ALL policies, USING also governs the existing row on UPDATE and DELETE. So their "DELETE USING" does change text, though equivalently. The only alternative is splitting the policies, which R5 forbids. AC-2's UPDATE/DELETE probes (D-5.4) cover it.

### D-3. Migration `20261123120000_rls_visibility_once_per_query.sql`

**Ordering.** It sorts after `20261118120100_set_item_primary_vendor.sql`, the newest file on disk today. Specs 202, 203 and 204 are READY_FOR_ARCH and may add files: whichever lands second re-dates. Spec 206 adds no migration.

Body, in order, inside an explicit `begin; … commit;` (the shape of [20261109191000](../supabase/migrations/20261109191000_demote_profile_brand_scope.sql) L144-150):

1. `set local lock_timeout = '5s';`
2. **Fail-closed pre-flight `do $$` block:**
   - (a) the set of `(tablename, policyname, cmd)` in `pg_policies` where `schemaname='public' and cmd in ('SELECT','ALL') and qual ~ 'auth_can_see_(store|brand)\('` equals the 36 expected triples. On a mismatch it raises and lists the extra and missing triples;
   - (b) both ALL policies have `with_check is not null`, and `regexp_replace(with_check,'\s+',' ','g') = regexp_replace(qual,'\s+',' ','g')`.

   Do **not** embed exact-text md5s in the migration. A future Postgres major version re-deparses differently, and a CI replay would then fail on history. The exact-text comparison is AC-13, out of band.
3. **`lock table … in access exclusive mode`** for the 35 tables in one statement: alphabetical, but `profiles`, `stores` and `user_stores` **last**. In-flight readers of other tables lazily take `AccessShare` on those three inside the helpers, so locking them last shortens the deadlock window (Risks 4).
4. Create both helpers, then revoke, grant and comment (D-2.1). The helpers must exist before any policy references them.
5. The 36 `alter policy … using (…)` statements (D-2.6).
6. `create index if not exists audit_log_store_id_created_at_idx on public.audit_log (store_id, created_at desc);` (R8). Not CONCURRENTLY. The table already holds an AccessExclusive lock from step 3, and it has about 4k rows on prod.
7. **Post-flight `do $$` block:**
   - zero rows match the step 2(a) query (the AC-4 lint, run at apply time);
   - both ALL policies' `with_check` still contains `auth_can_see_`;
   - `select public.auth_visible_store_ids()` as the migration role is not NULL.
8. `commit;`

**Header comment** (the R9 and in-scope list). It covers:
- posture: helpers, grants, why `anon` (OQ-1);
- the D-2.3 equivalence argument in short, including the NOT/coalesce note and the load-bearing `::uuid[]` cast note (D-2.2);
- "CHANGE BOTH TOGETHER";
- realtime: no publication change and no restart ritual, though delivery is authorized by these SELECT policies;
- the prod apply via MCP (D-7);
- lock behaviour;
- the full hand-written **R9 rollback** below.

**R9 rollback text** (in the header; never a migration file):

```sql
begin;
set local lock_timeout = '5s';
-- 1. 36 x: alter policy "<name>" on public.<table> using (<old USING from D-2.6>);
--    (ALL policies: nothing to remove, no WITH CHECK was added; their WITH CHECK was never touched)
drop index if exists public.audit_log_store_id_created_at_idx;
drop function if exists public.auth_visible_store_ids();
drop function if exists public.auth_profile_brand_id();
commit;
```

- Write all 36 `alter policy` lines out literally in the header, using the old source texts from D-2.6.
- The functions are dropped last; while any policy still references them, `pg_depend` blocks the drop.

### D-4. Existing test pins (OQ-2): full grep and new expectations

I grepped all of `supabase/tests/` for `pg_policies`, `pg_policy`, `polqual`, `pg_get_expr`, `policies_are`, and `qual`/`with_check like` on helper names. 16 files touch `pg_policies`.

**Pins that this spec breaks: four arms in four files.**

1. [audit_log_rls_hardening.test.sql](../supabase/tests/audit_log_rls_hardening.test.sql) **S-3** (L262-269). Re-pin the byte-exact new qual, **captured from `pg_policies` after the migration** (not hand-typed).
   - The predicted deparse, corrected 2026-11-23 for the `::uuid[]` cast and based on the developer's observed form `(id = ANY (( SELECT … AS …)::uuid[]))`, is `(((store_id IS NOT NULL) AND (( SELECT auth_is_super_admin() AS auth_is_super_admin) OR (store_id = ANY (( SELECT auth_visible_store_ids() AS auth_visible_store_ids)::uuid[])))) OR ((store_id IS NULL) AND ( SELECT auth_is_privileged() AS auth_is_privileged)))`. As before, the pinned literal is the captured one, not this prediction.
   - No other predicted pin contains the store fragment:
     - T3 (`user_stores`) is brand-scoped and unaffected.
     - P1b matches on the substring `auth_visible_store_ids()`, which the cast form still contains.
     - K-b is brand-scoped.
   - Change the comment and message to "literal captured AFTER the spec 205 migration; the spec 157 semantics are unchanged (proved by rls_visibility_once_per_query)".
   - **S-4** (the INSERT with_check) stays byte-unchanged and unedited. That is the "write side untouched" proof.
2. [invitations_hardening.test.sql](../supabase/tests/invitations_hardening.test.sql) **K-b**, the second sub-check (L231-235). Replace it with a check that still counts 2 and keeps the brand-scope, super_admin and D-7 intent. With `nq = lower(regexp_replace(qual,'\s+',' ','g'))`:
   ```
   and (select count(*) = 2 from pg_policies
         where schemaname='public' and tablename='invitations' and cmd in ('SELECT','DELETE')
           and case cmd when 'SELECT' then nq like '%auth_profile_brand_id()%' and nq not like '%auth_can_see_brand(%'
                        else nq like '%auth_can_see_brand%' end
           and nq like '%auth_is_super_admin()%'
           and nq like '%invited_by = auth.uid()%')
   ```
   All other K-b sub-checks and K-a pass unchanged:
   - `auth_profile_is_privileged()` is still a substring of the wrapped form;
   - `auth_is_privileged()` is absent;
   - the UPDATE and INSERT checks are untouched.
3. [report_last_order_context.test.sql](../supabase/tests/report_last_order_context.test.sql) **P1b** (L845-861). Change `case when qual like '%auth_can_see_store%'` to `case when qual like '%auth_visible_store_ids()%'`.
   - The expected string `'eod_entries:store, eod_submissions:store, order_approvals:store+priv, po_items:store, purchase_orders:store'` is **unchanged**. The `+priv` arm still matches `auth_is_privileged` inside the wrapped form.
   - Update the message and the header comment (L83-84) to say "routes through the spec 205 store-visibility InitPlan".
   - P1a (names) is unchanged.
4. [user_stores_own_row_writes.test.sql](../supabase/tests/user_stores_own_row_writes.test.sql) **T3** (L208-224). Keep `permissive|cmd|…|with_check` in one string:
   - **with_check stays the old literal byte-for-byte**, and its md5 `b05a4d4429e322a9cf194d6072b5f6d3` comment stays valid for with_check;
   - the qual part becomes the new literal, captured after the migration;
   - update the comment to "qual captured after spec 205; with_check unchanged since spec 195".

**Grepped and confirmed unaffected** (no edit):
- `profiles_insert_hardening` K-13 and K-16. They pass because `invited_by = auth.uid()` stays bare (D-2.5), `auth_profile_is_privileged()` is still a substring, and `auth_is_privileged()` is absent. K-2 is the profiles INSERT, untouched.
- `super_admin_policy_parity` LINT-1: no `auth_is_admin` in any rewritten text.
- `permissive_policy_lint` arms 1-2: no rewritten text starts with or ORs a trivially-wide token. I checked every new text against both regexes.
- `order_approvals` S3 and L1 (the same regexes).
- `kept_records_delete_hardening` C-1a (names and cmd only), C-1b (RESTRICTIVE quals only) and C-6.
- `retention_prune_job` P-1 (RESTRICTIVE delete quals), P-4 and P-7 (comments; no policy comment is changed).
- `audit_log_rls_hardening` S-1, S-2, S-4, S-5 (admin_delete) and S-6 (comments preserved by ALTER POLICY).
- `user_stores_own_row_writes` T1 (`policies_are`), T2 and T4.
- `vendors_role_access` (counts), `admin_submit_eod` (counts), `auto_place_order_attempts` (counts), `order_approvals_approver_snapshot` (profiles DELETE count), `inventory_items_identity_lock` (the tombstone table).
- `ingredient_photos` (storage, out of scope).

**Decision: no policy comment is edited.** Several comments still say "delegates to auth_can_see_store()". That is semantically still true, because the new predicate is equivalent. Editing comments would put the `like 'spec 170: %'` (S-6) and `spec 186` (P-7) comment pins at risk. The migration header records the change instead.

Jest: no jest test reads these migrations or pins policy text. `invitationsClamp.source.test.ts` reads the 198 migration and `invitations_hardening.test.sql`, but only the clamp UPDATE, which K-b's edit doesn't touch.

### D-5. New pgTAP suites

#### D-5.1 `supabase/tests/rls_per_row_helper_lint.test.sql` (AC-4)

A spec 053-shaped file, `begin; … rollback;`, `plan(3)`:
- **Arm 1:** the offender count is 0:
  ```
  pg_policies where schemaname='public' and cmd in ('SELECT','ALL')
    and (coalesce(qual,'') like '%auth_can_see_store(%' or coalesce(qual,'') like '%auth_can_see_brand(%')
    and not exists (allowlist match)
  ```
  - It covers PERMISSIVE and RESTRICTIVE. It checks `qual` only, never `with_check`; the two ALL policies keep the old helper there by design.
  - The allowlist is a CTE seeded empty: `allowlist(schemaname, tablename, policyname) as (select null::name, null::name, null::name where false)`. Use `not exists`, not `not in`, which breaks on NULL. The comment says to add VALUES rows with a one-line reason in the same PR.
- **Arm 2:** `string_agg` of the offenders is `''`, for readable CI failures.
- **Arm 3 (proves the lint can fail):** create `public.__lint_probe_per_row_helper (id uuid primary key)`, enable RLS, and add a SELECT policy `using (public.auth_can_see_store(id))`. Run the arm 1 query (without the allowlist exemption) filtered to that table in a `do $$` block, `set_config` the count, drop the policy and table, then `is(count, 1)`. This is the drop-then-assert pattern from `permissive_policy_lint.test.sql` arm (3); a savepoint rollback would lose the pgTAP counters.

The message tells the reader: "use `((select public.auth_is_super_admin()) or <store> = any ((select public.auth_visible_store_ids())::uuid[]))` / `((select public.auth_is_super_admin()) or <brand> = (select public.auth_profile_brand_id()))`; the ::uuid[] cast is required (without it ANY takes the subquery form and fails with 42883); see spec 205".

#### D-5.2 `supabase/tests/rls_visibility_once_per_query.test.sql` (AC-2, AC-3, AC-5, AC-6, AC-7)

Hermetic `begin; … rollback;`, run as postgres, impersonating the PostgREST way: `set local role authenticated|anon` plus `set_config('request.jwt.claims', …, true)`. This is the pattern of `user_stores_own_row_writes.test.sql` L56-60.

**Fixtures** (as postgres; stash the ids with `set_config('test.*')`):
- **Brands:** brand A `b2050000-0000-0000-0000-00000000000a` and brand B `…0b`, with stores A1 and A2 (brand A) and B1 (brand B). Copy the store column set from `user_stores_own_row_writes` L116-125.
- **Principals:** the 11 from the spec plus STALE+L, with ids `20500000-0000-0000-0000-0000000000NN`.
  - Create the `auth.users` rows with `''` token columns, copying `user_stores_own_row_writes` L129-153, then the profiles (L158-169).
  - Profile roles and brands are as in the D-2.3 table. `profiles_role_brand_consistent` allows all of them; super_admin must have a NULL brand.
  - JWT claims: `{"sub": <id>, "role": "authenticated", "app_metadata": {"role": <jwt role>}}`. For ANON: `{"role": "anon"}` with `set local role anon`.
- **Links:**
  - STAFF → A1 and STALE+L → A1. The trigger admits both (same brand, or a NULL-brand first link; `user_stores_own_row_writes` L171-176 does the same).
  - ADM-A+L → A1, and → B1 under `alter table public.user_stores disable trigger user_stores_brand_match_trg; … enable trigger …`. This is transactional DDL as the table owner, rolled back with the file.
- **Rows:** at least one row at A1, A2 and B1 (store-scoped) or at brand A and brand B (brand-scoped) in **each of the 35 tables**, plus a NULL-scope row for every table whose scope column is nullable.
  - Resolve nullability from `information_schema.columns` at build time. Known nullable: `audit_log.store_id`, `profiles.brand_id` (the NOBRAND, STALE and SA profiles cover it) and `invitations.brand_id` (include a D-7 row with NULL brand, empty `store_ids` and `invited_by` = ADM-A, plus a store-list row naming A1, and one naming B1).
  - Copy working column sets and trigger-safe inserts from the existing suites:
    - `report_last_order_context` (purchase_orders, po_items, order_approvals, eod_submissions, eod_entries);
    - `item_vendors_rls` (item_vendors, inventory_items, catalog_ingredients, vendors);
    - `store_count_layouts`, `staff_reports_issue`, `submission_notifications` (notifications), `auto_place_order_attempts` (vendor_order_attempts), `inventory_counts_append_only` (inventory_counts and entries), `report_run_custom` (report_runs and definitions), `rls_hardening_followups` (order_schedule), `invitations_hardening` (invitations), `copy_brand_catalog` and `cross_brand_copy` (recipes, prep_recipes and their children, ingredient_conversions, pos_recipe_aliases).

**Arms** (the developer sets `plan(N)`):

- **AC-5 (helpers).**
  - `prosecdef`, `provolatile = 's'`, `proconfig = '{"search_path=public, auth"}'` and the return types, per helper. Pin them as `prorettype = 'uuid[]'::regtype` and `'uuid'::regtype`. The store fragment's explicit `::uuid[]` cast relies on this pin (D-2.2 residual).
  - `has_function_privilege` is true for `authenticated` and `anon`, and PUBLIC is absent from `aclexplode(proacl)` (grantee 0).
  - Per principal: `auth_visible_store_ids()` equals the D-2.3 `V` column (compare sorted arrays), and `auth_profile_brand_id()` equals the `B` column. This pins `'{}'` and not NULL for NOBRAND and ANON.
- **AC-5b (predicate truth table, exhaustive and cheap).** For each principal, and each `x` in {A1, A2, B1, every seed store, NULL, a random uuid}:
  ```
  auth_can_see_store(x) = coalesce((select public.auth_is_super_admin()) or x = any ((select public.auth_visible_store_ids())::uuid[]), false)
  ```
  The outer `coalesce(..., false)` here is part of the test, not the policy. It folds the new predicate's NULL (for a NULL `x`) to false, so it can be compared with the old function's false. The `::uuid[]` cast is the same fragment the policies use.
  The same for `b` in {A, B, seed brand, NULL, random} against `auth_can_see_brand(b)`. Aggregate mismatches into one string per principal, expected `''`.
- **AC-7:** `pg_indexes.indexdef = 'CREATE INDEX audit_log_store_id_created_at_idx ON public.audit_log USING btree (store_id, created_at DESC)'`.
- **AC-6 (posture).** Pin a manifest VALUES list generated from the local DB **after** the migration: `(tablename, policyname, cmd, permissive, roles::text, md5(coalesce(qual,'')), md5(coalesce(with_check,'')))` for **every** policy on the 35 tables. Assert that the live catalog equals the manifest exactly (set equality via `except` both ways), so a mismatch lists the differing rows.
  - Before committing the manifest, the developer diffs it against the same query run on the pre-205 DB. **The only differing rows may be the 36 R4 qual md5s.** Record that diff in the implementation notes; it is the one-time "write side byte-identical" proof.
  - Separately assert that the two ALL policies' `md5(with_check)` equals the md5 of their **old** qual from the pre-205 manifest (R6).
  - The header comment gives the regeneration query for future specs that intentionally change a policy on these tables (see Risks 6).
- **AC-3 (anon).**
  - For each of the 35 tables, as ANON: `lives_ok('select count(*) from public.<t>')` and the count is 0.
  - Guard: if `has_table_privilege('anon', 'public.<t>', 'SELECT')` is false for some table, that table's arm asserts the same `42501 permission denied for table` error as before instead. I found no such table: spec 097 grants anon SELECT on all of `public`.
  - Pin `has_function_privilege('anon', …)` for both helpers.
- **AC-2 (equivalence, old vs new, as the real principal).**
  - `create temp table spec205_r4(tbl text, pol text, old_using text, new_using text)`:
    - `old_using` = the 36 `qual` literals from the pre-205 manifest (the deparse, which is valid SQL under the default search_path);
    - `new_using` = captured from `pg_policies.qual` at file start.
  - `pg_temp.spec205_mode(p text)` runs `format('alter policy %I on public.%I using (%s)', pol, tbl, <old|new>)` for all 36. It must run as postgres (the table owner). ALL policies' WITH CHECK is untouched by a USING-only ALTER.
  - `pg_temp.spec205_observe()`, for each principal:
    - set the claims, `execute 'set local role …'`;
    - for each of the 35 tables, `execute format('select coalesce(string_agg(<pk>::text, '','' order by <pk>::text), '''') from public.%I', …)` into an array variable. `<pk>` is the primary-key columns joined with `':'`, resolved from `pg_index.indisprimary`; fall back to `ctid` if a table has none;
    - `reset role`, then insert into `pg_temp.spec205_obs(mode, principal, tbl, ids)` as postgres.
  - Run `spec205_mode('old')`, observe('old'), `spec205_mode('new')`, observe('new'). Then:
    - one `is()` per principal: the `string_agg` of tables where old ≠ new, expected `''`;
    - one `is()` asserting the catalog is back to `new_using` for all 36 (a restore guard).
  - **Non-vacuity guards** (without these, equality alone could pass on empty data):
    - ADM-A sees at least one fixture row in every table except notifications and staff_reports if ADM-A isn't privileged. ADM-A *is* privileged, so expect at least 1 everywhere, and 0 brand-B fixture rows;
    - STAFF sees 0 rows in `notifications`, `staff_reports` and `order_approvals` (the privileged conjunct);
    - SA sees every NULL-scope row its old policy admitted (for example `audit_log` NULL-store rows via `auth_is_privileged`);
    - ADM-A+L sees the B1 rows of store-scoped tables (arm iii) but **not** brand-B rows of brand-scoped tables.
  - **ALL-policy reachability** (`user_stores`, `order_schedule`), per mode and principal:
    - disable user triggers on both tables (`alter table … disable trigger user`, rolled back with the file), so the probe tests RLS rather than the brand-match trigger;
    - then, inside a plpgsql `begin … exception` block: `with u as (update public.<t> set <pkcol> = <pkcol> returning <pk>) select string_agg(…)` into a variable; then the same for `delete … returning`; then `raise exception using errcode = 'P0205'`, caught, so both writes roll back;
    - compare the old and new strings outside the block, so the pgTAP counters survive.
  - **Runtime:** old mode is the slow path. If the file goes over about 60 s locally, restrict observations to rows at fixture stores and brands, NULL-scope rows, and the seed's first store. Do not drop the seed entirely.

### D-6. Local verification procedure (AC-8 to AC-12)

1. **Baseline (pre-205).**
   - Without the migration file on disk: `npm run dev:db`, `npx supabase db reset`. Save the D-1 query output and the AC-6 manifest query output (all policies on the 35 tables) to scratch files.
   - Record the helper md5s: `select proname, md5(regexp_replace(pg_get_functiondef(oid),'\s+',' ','g')) from pg_proc where pronamespace='public'::regnamespace and proname in ('auth_can_see_store','auth_can_see_brand','auth_is_super_admin','auth_is_admin','auth_is_privileged')`.
   - Record `select version()`.
2. **EXPLAINs (AC-8, AC-9).** Run each 3 times before and after, and report the median.
   - Session preamble, as the seed admin (brand A):
     ```
     begin; set local role authenticated;
     select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"admin"}}',true);
     explain (analyze, buffers) <query>;
     rollback;
     ```
   - **(a)** A hand-written SQL equivalent of `INVENTORY_SELECT` ([src/lib/db.ts](../src/lib/db.ts) L275-280). PostgREST plans aren't exposed locally. It is `inventory_items ii` with correlated scalar subqueries for:
     - `vendor` (vendors by `ii.vendor_id`);
     - `item_vendors` (a `json_agg` over `item_vendors iv where iv.item_id = ii.id`, with its nested `vendors`);
     - `updater` (profiles by `ii.last_updated_by`);
     - `catalog` (catalog_ingredients by `ii.catalog_id`);

     ordered by `ii.id`, `limit 1000`. Also time the real request through PostgREST with `curl` and the admin's access token, as a wall-clock sanity check.
     - The no-RLS baseline is the same SQL as `postgres` (reset role).
     - Target: after ≤ 3× the baseline.
   - **(b)** `items_last_counted` is `language sql` with `set search_path`, so it is **not inlinable**, and EXPLAIN of the call shows only a Function Scan.
     - Record the call's total time: `explain analyze select * from public.items_last_counted('<Towson>')`.
     - For the plan-shape evidence, EXPLAIN its body ([20260817000000](../supabase/migrations/20260817000000_items_last_counted.sql) L74-92) with `p_store_id` replaced by the literal.
   - **(c)** `select * from public.audit_log where store_id = '<Towson>' order by created_at desc limit 100`. Expect an `Index Scan using audit_log_store_id_created_at_idx` and no Seq Scan.
     - The RESTRICTIVE `audit_log_restrict_select_store_user_actions` still calls `auth_is_privileged()` per row, but only on the three store-user/deleted actions. That is out of scope (not `auth_can_see_*`); note it in the evidence.
   - **AC-8 pass condition:** `auth_visible_store_ids`, `auth_profile_brand_id`, `auth_is_super_admin` and `auth_is_privileged` appear only under `InitPlan` nodes. `auth_can_see_store` and `auth_can_see_brand` appear in no Filter, SubPlan or Join Filter. The expected store filter shape is `(store_id = ANY ((InitPlan N).col1))`. A per-row `SubPlan` on `auth_visible_store_ids` means the cast is missing or misplaced. For (a), check specifically that the `item_vendors` EXISTS shows its InitPlans evaluated once (`loops=1`), not per outer row.
   - Record row counts. The local seed is smaller than prod; say so next to the table.
3. **Realtime (AC-10).**
   - Before and after the migration, both channels:
     - Create a brand-B admin on the local stack: insert a brand B, a store B1, and an `auth.users` row with `''` token columns, an `auth.identities` email row, a `crypt()` password, and `app_metadata.role = 'admin'`; then a profile with role admin and brand B. Or use the app's user-management flow.
     - Sign in ADM-A (`admin@local.test`) on store A1 = Towson in one browser, and ADM-B in another.
   - **The filter alone would hide A1 changes from ADM-B's `store-{B1}` channel,** so it proves nothing about RLS. The negative check must therefore use a subscription whose filter *matches* A1. Use a throwaway scratchpad Node script with `@supabase/supabase-js`, signed in as ADM-B, subscribing to:
     - `postgres_changes` on `inventory_items` with `filter: store_id=eq.<Towson>`;
     - `catalog_ingredients` with `filter: brand_id=eq.<brand A>`.
   - As postgres, run `update public.inventory_items set par_level = par_level where id = <a Towson item>` and the same no-op update on a brand-A catalog row.
   - **Expected:** ADM-A's app reloads (network tab) and gets both events; ADM-B's script gets none.
   - There is no publication change, so the restart ritual doesn't apply to the migration. **But a `supabase db reset` recreates the publication.** Run `docker restart supabase_realtime_imr-inventory` after any reset, before this check, or the check fails for unrelated reasons.
4. **pgTAP (AC-1, AC-4 to AC-7):** `npm run test:db`, all green.
5. **Rollback rehearsal (AC-12).**
   - Apply the R9 SQL from the header with `psql` in the db container.
   - Write the pre-205 versions of the four edited test files to the scratchpad (`git show HEAD:supabase/tests/<f>`).
   - Run `bash scripts/test-db.sh <every supabase/tests/*.test.sql except the two new files, with the 4 edited ones replaced by their scratch copies>`. It must be all green.
   - Re-run the D-1 query: it must return the 36 old rows.
   - Re-migrate with `npx supabase db reset`. The `schema_migrations` row persists after a manual rollback, so `migration up` would skip it. Then restart realtime.
   - Record the result in the implementation notes.
6. **AC-11:** `git diff --stat` shows nothing under `src/` or `supabase/functions/`; `npx jest`, `npm run typecheck` and `npm run typecheck:test` all pass.

### D-7. Prod rollout (owner's explicit go-ahead only; project `ebwnovzzkwhsdxkpyjka`)

**Prod writes need the owner's explicit go-ahead in chat.** Agents stage only. Steps 1 and 4 are read-only and may run on the developer's own initiative.

1. **AC-13 pre-check (read-only, MCP `execute_sql`):**
   - the D-1 query and the AC-6 manifest query on prod. Diff them against the local pre-205 captures by md5 of whitespace-normalized text: `md5(regexp_replace(coalesce(qual,''),'\s+',' ','g'))`, and the same for `with_check`;
   - the five helper md5s;
   - `select version()`, which must be the same major as local;
   - `to_regprocedure('public.auth_visible_store_ids()')` and `to_regprocedure('public.auth_profile_brand_id()')` both return NULL.

   **This is a hard gate. Any mismatch stops the apply** and goes to the owner.
2. **Apply:** one `execute_sql` call with the migration body as written (its own `begin … commit`), in a quiet window.
   - If it fails with `lock_timeout` (55P03) or a deadlock (40P01), the whole transaction rolled back. It is safe to retry.
   - Then insert the exact version `20261123120000` (and name) into `supabase_migrations.schema_migrations`, the same way as prior MCP applies (project memory: prod migration via MCP).
   - **The migration is not replayable** (its pre-flight fails closed after a successful apply). If `execute_sql` succeeded but the `schema_migrations` insert failed, insert the row; do **not** re-run the migration.
3. **Staging and push timing:**
   - Stage **only** the spec-205 paths (the migration, the two new suites, the four edited test files, this spec, and optionally `specs/205-rls-visibility-once-per-query/reviews/`). Use the shared-index procedure from project memory (temp `GIT_INDEX_FILE`, `read-tree HEAD`, `apply --cached`), and test the exported tree. Never stage the unrelated working-tree files (`.claude/agents/*`, `CLAUDE.md`, `app.json`, spec 181 and its test).
   - Push to `main` right after step 2, or `db-migrations-applied.yml` goes red. Then check that the latest `test.yml` and `db-migrations-applied.yml` runs on `main` are green, and check `e2e.yml` by hand.
4. **AC-14 post-check (read-only):**
   - the helpers' normalized md5, `prosecdef`, `proconfig`, `proacl`, and `pg_get_userbyid(proowner) = 'postgres'` match local. If MCP created them under another owner, stop and ask; do not silently re-own. `proacl` must include `anon` and `authenticated` and must not include an empty-grantee `=X/` entry (PUBLIC);
   - the D-1 query returns 0 rows;
   - the AC-6 manifest matches the local post-205 manifest. Compare by running **the same manifest query on local and on prod** and diffing the outputs, not against the constants in the test file;
   - the index is present;
   - `pg_read_all_data` members (`supabase_read_only_user`, `supabase_etl_admin`) are still BYPASSRLS;
   - SF-2 sizing: `select count(*) from public.inventory_items where last_updated_by is not null`, and, for the profiles node of the prod (a) plan, its `loops`, actual time, and whether `auth_is_super_admin()` sits in its Filter. A 3x-target miss caused by this path is reported, not an AC-14 failure.
   - Re-run the three AC-8 EXPLAINs as the brand admin in a `begin; set local role authenticated; set_config(claims); explain (analyze, buffers) …; rollback;` batch, the same method as 2026-11-23. For (b), use the body form. Record the timings next to the spec's table (1,574 ms / 2.4-2.9 s / 630 ms).
   - **This is a hard gate.** Any mismatch goes to the owner for the rollback decision.
5. **Rollback:** the R9 SQL, applied the same way, only on an owner decision. To get runnable SQL, strip the leading `-- ` from every line of the migration header from `-- begin;` through `-- commit;`. Then delete the `schema_migrations` row **and** revert the commit, or the drift gate fails.

### D-8. API contract, db.ts, frontend store, edge functions, realtime

- **API contract:** unchanged. Every PostgREST read returns the same rows (AC-2).
  - The two helpers become callable as `/rest/v1/rpc/auth_visible_store_ids` and `/rpc/auth_profile_brand_id`, like their siblings.
  - They disclose only the caller's own brand and the store ids the caller can already read from `stores`. ANON gets `{}` and null.
  - No app code calls them; they are not added to `src/lib/db.ts`.
- **`src/lib/db.ts`:** no change. **`src/store/useStore.ts`:** no change, and optimistic-then-revert doesn't apply.
- **Edge functions:** none touched.
  - Service-role functions bypass RLS.
  - User-JWT calls, including the user-scoped clients inside edge functions, get the faster equivalent policies.
  - `verify_jwt` settings are unchanged.
- **Realtime:** the `store-{id}` and `brand-{id}` channels are unchanged. `postgres_changes` authorization runs each subscriber's claims through these SELECT policies, and the InitPlan is re-evaluated per execution, so it is per-subscriber. AC-10 verifies this.
  - No `supabase_realtime` publication change, so **no** `docker restart supabase_realtime_imr-inventory` is needed for this migration. The restart *is* needed after any `db reset` during verification (D-6).

### D-9. Risks and tradeoffs

1. **A wrong rewrite leaks or hides rows (access control; high impact).** Mitigations:
   - the D-2.3 proof;
   - the AC-5b exhaustive predicate table;
   - AC-2 run as the real principals, comparing old and new policy sets on the same data, with non-vacuity guards;
   - the in-migration pre-flight and post-flight;
   - the AC-4 lint;
   - AC-13/14 on prod;
   - the rehearsed rollback.

   The `::uuid[]` cast in `= any ((select public.auth_visible_store_ids())::uuid[])` is the single most likely typo; it was itself the subject of a design fix (D-2.2). Dropping it fails loudly with `42883 operator does not exist: uuid = uuid[]` at `ALTER POLICY` time, and the whole migration rolls back. It never fails silently.
2. **Helper drift.** `auth_visible_store_ids` duplicates arms (ii) and (iii), and `auth_profile_brand_id` duplicates the `auth_can_see_brand` arm. A later edit to one side splits read visibility from write checks and RPC gates.
   - Mitigations: the "CHANGE BOTH TOGETHER" comments and the AC-5b table (it fails if only one side changes).
   - **Proposed CLAUDE.md bullet (owner approval needed; agents don't edit CLAUDE.md):** "**Per-row RLS visibility goes through InitPlan helpers.** SELECT policies and the USING of ALL policies on `public.*` never call `auth_can_see_store(...)` / `auth_can_see_brand(...)` per row. They use `((select public.auth_is_super_admin()) or <store> = any ((select public.auth_visible_store_ids())::uuid[]))` / `((select public.auth_is_super_admin()) or <brand> = (select public.auth_profile_brand_id()))`. The `::uuid[]` cast is load-bearing: without it, any number of parentheses still parses as the subquery form of ANY and fails with 42883. The helpers duplicate arms of `auth_can_see_store` / `auth_can_see_brand`: change both together. Enforced by `supabase/tests/rls_per_row_helper_lint.test.sql`. Reference: spec 205."
3. **Future policies.** A new SELECT policy written in the old style fails the AC-4 lint in CI, which is intended. The lint message gives the replacement.
4. **The lock window on prod.**
   - 35 AccessExclusive locks in one transaction. In-flight readers lazily take AccessShare on `stores`, `profiles` and `user_stores` inside the helpers, so a deadlock with a live request is possible.
   - Locking those three last plus `lock_timeout = 5s` bounds it. If the migration loses, it rolls back cleanly; if a reader loses, one request errors.
   - Today's queries run 2-12 s on prod, so pick a quiet window. A timeout means retry, not intervene.
5. **InitPlan inside EXISTS and LATERAL** (`item_vendors`, `items_last_counted`). These are expected to evaluate once, because they're uncorrelated. If AC-8 shows `loops>1` on a helper InitPlan, report it rather than restructure. The predicate stays correct; only the speed-up shrinks.
6. **Weaker and more churn-prone text pins.**
   - S-3, K-b, P1b and T3 now pin the new shape; behavioural equivalence comes from AC-2.
   - The AC-6 manifest pins every policy on 35 tables. Any later spec that intentionally changes one of them must regenerate it (the query is in the file header). This is the price of making AC-6 a standing check rather than a one-time diff. Flag it to code-reviewer.
7. **Ordering with spec 204.** Spec 204 (READY_FOR_ARCH) may add policies or triggers on `item_vendors` and `inventory_items`.
   - If it lands first and adds a SELECT or ALL policy using `auth_can_see_*`, the 205 pre-flight fails closed. That is intended: re-run D-1 and extend the rewrite.
   - If 205 lands first, spec 204's design must use the new fragments, or the AC-4 lint fails it.
8. **Cold start and performance.** No edge function is involved. On the seed dataset the helpers read at most the 4-6 seed stores and a handful of user_stores rows per query. The new index adds one small write per audit insert, on about 4k rows.
9. **Not fixed here (follow-ups):**
   - the RESTRICTIVE `audit_log_restrict_select_store_user_actions` per-row `auth_is_privileged()`;
   - the 29 `auth_rls_initplan` self-policy warnings;
   - write-side policies;
   - the bare `auth.uid()` in `invitations` (D-2.5).

### Files the developer is expected to touch

- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql` (new)
- `supabase/tests/rls_visibility_once_per_query.test.sql` (new)
- `supabase/tests/rls_per_row_helper_lint.test.sql` (new)
- `supabase/tests/audit_log_rls_hardening.test.sql` (S-3 only)
- `supabase/tests/invitations_hardening.test.sql` (K-b second sub-check only)
- `supabase/tests/report_last_order_context.test.sql` (P1b plus its header comment)
- `supabase/tests/user_stores_own_row_writes.test.sql` (T3 plus its comment)
- this spec (implementation notes: AC-8/9 table, AC-10, AC-12, the AC-6 pre/post diff; later the AC-13/14 records)

## Handoff
next_agent: backend-developer
prompt: Implement spec 205 against the "## Backend design" section in this spec. Run build step 0 (D-1) first, on a fresh db reset; stop if it doesn't return exactly the 36 policies. Author the migration (D-3), the two new pgTAP suites (D-5) and the four pin edits (D-4). Run the local verification (D-6), including the rollback rehearsal, and record the evidence in the spec's implementation notes. Do NOT apply anything to prod and do NOT commit; prod steps (D-7) wait for the owner's explicit go-ahead. When done, set Status: READY_FOR_REVIEW and list the files changed under ## Files changed.
payload_paths:
  - specs/205-rls-visibility-once-per-query.md

## Implementation notes (backend-developer, 2026-11-23)

The first build pass stopped at D-3 on a design error: the double-parenthesis ANY form doesn't parse ("Blocker" below). The architect fixed the design ("Architect ruling" below). The build then completed ("Build completed after the ruling" at the end).

### Build step 0 (D-1): passed

- Ran `supabase db reset` locally (CLI 2.95.4, PostgreSQL 17.6 aarch64). The D-1 query returns **exactly 36 rows**, and the names, cmd, permissive and roles match D-2.6.
- Both ALL policies have `with_check` = `qual`.
- The pre-205 captures are saved in the developer's scratchpad (session-local; regenerate with the D-1 / AC-6 queries on a fresh reset if lost):
  - the D-1 manifest (text and JSON);
  - the AC-6 manifest, 126 policies on the 35 tables;
  - the helper md5s.
- Pre-205 helper md5s (normalized `pg_get_functiondef`):

  | function | md5 |
  |---|---|
  | `auth_can_see_brand` | `9bdda1d11645a10d8de6bb3c4b03c132` |
  | `auth_can_see_store` | `d4333ba81f02b198ce5697a4a643936f` |
  | `auth_is_admin` | `edd9f767758181e96c8f1a61f32e4e65` |
  | `auth_is_privileged` | `9806745ff624b29dadfe37e53d253315` |
  | `auth_is_super_admin` | `50e62102043d5ffe48dc6613555ec802` |

### BEFORE timings (D-6 step 2): recorded

**Method:**
- `begin; … rollback;` on the pre-205 DB as postgres.
- The local seed has **0** rows in `eod_submissions`, `eod_entries`, `inventory_counts`, `inventory_count_entries` and `audit_log`. Without data, (b) and (c) would measure nothing, so the transaction first **pads** them with `session_replication_role = replica` (triggers off), then runs `analyze`. All of it is rolled back:
  - 10 submitted EOD submissions per store × every item at that store: 40 submissions, 5,720 entries;
  - 5 spot counts per store: 20 counts, 2,860 entries;
  - 4,000 `audit_log` rows: 3,800 spread over the 4 stores (950 at Towson) and 200 with a NULL store.
- Then `set local role authenticated` with the seed admin's claims (`11111111-…`, JWT `admin`, brand 2AM PROJECT).
- Each query ran 3 times; the median is reported.

**Seed sizes:** 4 stores, 572 `inventory_items`, 564 `item_vendors`. Prod is larger (887 items in the 2026-11-23 measurement).

| query | rows | no-RLS (postgres) | BEFORE as admin (median of 3) | runs |
|---|---|---|---|---|
| (a) `INVENTORY_SELECT` SQL equivalent, all stores, `limit 1000` | 572 | 4.96 ms | **184.9 ms** (37×) | 184.9 / 186.3 / 183.8 |
| (b) `items_last_counted(Towson)` call | 143 | n/a | **428.1 ms** | 451.3 / 428.1 / 415.1 |
| (b) body, with the literal store id | 143 | 0.72 ms | **458.7 ms** | 458.7 / 547.5 / 416.5 |
| (c) `audit_log` Towson top 100 | 100 of 950 | 0.22 ms | **77.9 ms** | 77.9 / 76.7 / 99.8 |

The real PostgREST request, timed with `curl` and the admin's token (the `db.fetchInventory` select string, `limit=1000`, 572 rows, 564 links, 639,634 bytes): 0.42 / 0.45 / 0.52 / 0.56 s wall clock.

### Blocker (resolved by the architect ruling): `= any ((select …))` is still the subquery form of ANY in Postgres 17

D-2.2 says the double parentheses make the operand a scalar subquery that returns the array, and that the single-parenthesis form is the one that fails. On PostgreSQL 17.6, **single, double and triple parentheses all fail the same way.** The grammar's `select_with_parens` absorbs any number of extra parentheses, so `x = any ((select f()))` is still ANY over a subquery's rows:

```
select '…0001'::uuid = any (select pg_temp.arr());      -- ERROR: operator does not exist: uuid = uuid[]
select '…0001'::uuid = any ((select pg_temp.arr()));    -- ERROR: operator does not exist: uuid = uuid[]
select '…0001'::uuid = any (((select pg_temp.arr())));  -- ERROR: operator does not exist: uuid = uuid[]
select '…0001'::uuid = any ((select pg_temp.arr())::uuid[]);             -- t
select '…0001'::uuid = any (coalesce((select pg_temp.arr()), '{}'));     -- t
```

Applying the D-3 migration therefore fails at the first store-scoped `alter policy` with `42883 operator does not exist: uuid = uuid[]`. The whole transaction rolled back. I checked afterwards: no helpers, no index, no `schema_migrations` row, and D-1 still returns the 36 old rows. The local DB is exactly pre-205.

**A form that works (evidence for the architect, not a decision):**
- **The form:** an explicit cast turns the subquery into an `a_expr`: `store_id = any ((select public.auth_visible_store_ids())::uuid[])`.
- **Plan:** a single InitPlan, `Filter: (store_id = ANY ((InitPlan 1).col1))` with `InitPlan 1 -> Result`. That is the shape AC-8 wants.
- **Deparse in `pg_policies`:** `(id = ANY (( SELECT pg_temp.arr() AS arr)::uuid[]))`.
- **Alternative:** `coalesce((select …), '{}')` also parses, but adds a node for nothing, since the helper never returns NULL.

**What the architect needs to change if the cast form is adopted:**
- the store-swap fragment in D-2.2 and every store-scoped rewrite in D-2.6;
- D-2.2's "double parentheses are load-bearing" note, plus the same claim in D-9 risk 1 and in the proposed CLAUDE.md bullet;
- the predicted S-3 deparse in D-4;
- the AC-5b predicate expression in D-5.2;
- the D-5.1 lint message text.

The brand swap (`= (select …)`) is unaffected.

**Draft migration (complete except for this one fragment):**
- I moved it out of `supabase/migrations/` so that `supabase db reset` doesn't break for parallel work.
- It is in the developer's scratchpad as `20261123120000_rls_visibility_once_per_query.DRAFT.sql`.
- It follows D-3 step by step: the pre-flight with the 36 triples and the ALL-policy WITH CHECK check, the 35-table `lock table` with profiles, stores and user_stores last, both helpers with grants and comments, the 36 `alter policy`, the index, the post-flight, and the header with the R9 rollback written out in full.
- Once the architect rules, the only edit is the store-swap fragment, in 21 places, plus the header note.

**Not started:** the two new pgTAP suites (D-5), the four pin edits (D-4), the AFTER EXPLAINs, the AC-10 realtime check, and the AC-12 rollback rehearsal. All of them depend on the final policy text.

### Architect ruling (2026-11-23): design fixed, Status stays READY_FOR_BUILD

**Ruling.** The developer's cast form is adopted: `<e> = any ((select public.auth_visible_store_ids())::uuid[])`. The developer's diagnosis is correct; my first-draft claim about double parentheses was wrong.
- **Why the cast and not `coalesce`:** see D-2.2. In short, the cast is a same-type cast that adds no semantics, so the D-2.3 equivalence proof is unchanged.
  - It plans as the single InitPlan Param AC-8 wants.
  - A bare NULL array still fails closed. `coalesce` would add a per-row node and mask a NULL helper return.
  - The one residual is a silent coercion if the helper's return type ever changed. AC-5 now pins `prorettype` for that.

**Updated in the design** (the implementation notes above are unchanged):
- D-2.2: the `V` fragment, the store-swap wording, the "cast is load-bearing" note, and the R3 supersession;
- D-2.4: re-check of the invitations `coalesce(..., false)`. It is brand-only and unaffected. The store fragment appears only in the 21 store rewrites;
- D-2.6: all 21 store-scoped rewrites (13 direct, 2 privileged, 5 EXISTS children, `audit_log`);
- D-3: the header-note wording;
- D-4: the predicted S-3 deparse, plus a note that T3, P1b and K-b need no further change;
- D-5.1: the lint message;
- D-5.2: the AC-5b expression and the AC-5 `prorettype` pin;
- D-6: the AC-8 expected filter shape `(store_id = ANY ((InitPlan N).col1))`;
- D-9: risk 1 and the proposed CLAUDE.md bullet.

**Unchanged:** the brand swap, the helper bodies and grants, the 36-policy list, the lock order, the pre- and post-flight, the R9 rollback text (it restores the old USING, so it has no store fragment), and the test plan structure.

**Developer next step:** apply the fragment to the 21 places in the scratchpad draft, move it back into `supabase/migrations/`, and continue from D-3.

### Build completed after the ruling (backend-developer, 2026-11-23)

Everything below ran on the local stack only (PostgreSQL 17.6, supabase CLI 2.95.4). Nothing touched prod, and nothing is staged or committed.

#### Migration (D-3)

- **Re-glob:** `20261118120100_set_item_primary_vendor.sql` is still the newest file on disk, so `20261123120000` keeps its slot.
- **The fragment:** `= any ((select public.auth_visible_store_ids())::uuid[])`, in all 21 store-scoped rewrites. The header's equivalence note now describes the cast instead of the double parentheses.
- **Apply:** `supabase migration up --local` applied it cleanly, and a later `supabase db reset` replays it cleanly.
  - Post-apply, the D-1 query returns 0 rows.
  - Both helpers have `prosecdef = t`, `provolatile = s`, `proconfig = {"search_path=public, auth"}` and return types `uuid[]` / `uuid`.
  - Their `proacl` is `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`, with no PUBLIC entry.
- **The S-3 deparse** matches the architect's corrected prediction byte for byte: `(((store_id IS NOT NULL) AND (( SELECT auth_is_super_admin() AS auth_is_super_admin) OR (store_id = ANY (( SELECT auth_visible_store_ids() AS auth_visible_store_ids)::uuid[])))) OR ((store_id IS NULL) AND ( SELECT auth_is_privileged() AS auth_is_privileged)))`.
- **R7:** the five existing helper md5s are unchanged after the migration; they match the "Build step 0" table.

#### AC-6 one-time diff (write side byte-identical)

I ran the AC-6 manifest query (every policy on the 35 tables) before and after the migration:
- **Before and after:** 126 policies each, with the same `(table, policy)` set.
- **Differences:** column `md5(qual)` only, on exactly the 36 R4 policies. Name, cmd, permissive, roles and every `md5(with_check)` are identical.
- **The ALL policies:** their `md5(with_check)` (order_schedule `14541bb187014c50c377dcdc963127c3`, user_stores `b05a4d4429e322a9cf194d6072b5f6d3`) equals their pre-205 `md5(qual)`.

#### Pin edits (D-4)

Each pin keeps its intent:
- **S-3:** re-pinned to the captured literal above. S-4 is untouched.
- **K-b:** the second sub-check now uses the CASE form from D-4. Every other sub-check is untouched.
- **P1b:** now matches `'%auth_visible_store_ids()%'`. The expected string is unchanged, and the header comment and message were updated.
- **T3:** the qual is re-pinned to the captured post-205 deparse. The with_check is byte-for-byte the pre-205 literal. The comment was updated, and the md5 now refers to with_check.

#### New suites (D-5)

**`rls_per_row_helper_lint.test.sql`, plan(3):** the allowlist CTE is seeded empty. Arm 3 creates a throwaway policy and checks it is caught (drop-then-assert).

**`rls_visibility_once_per_query.test.sql`, plan(56), about 1.8 s locally.** Fixtures and principals follow D-5.2: all 12 principals, including STALE+L and ADM-A+L with the planted cross-brand B1 link. There are rows in all 35 tables, plus NULL-scope rows and NULL-FK child rows. The assertions:

| arm | assertions |
|---|---|
| AC-5 | 7: posture including `prorettype`; EXECUTE for authenticated and anon; no PUBLIC grant; V and B per principal |
| AC-5b | 12: one per principal |
| AC-7 | 1 |
| AC-6 | 3: manifest both ways, plus the ALL with_check md5 |
| AC-3 | 3 |
| AC-2 | 30: 12 row-set equalities, 12 ALL UPDATE/DELETE reachability checks, 1 restore guard, 5 non-vacuity guards |

Choices reviewers should know about:
- **Fixtures:** inserted with `alter table … disable trigger user` on the 16 fixture tables that have user triggers. This is transactional DDL as the table owner, rolled back with the file, and foreign keys stay enforced. It is the `report_last_order_context` precedent, widened, so the fixtures can include shapes the write-side triggers refuse: the cross-brand link, NULL-store rows, NULL-FK children. `user_stores` and `order_schedule` stay trigger-disabled through the ALL probes, per D-5.2.
- **AC-3:** written as one aggregated `is()` for errors and one for nonzero counts, instead of 35 separate `lives_ok`. Each loop iteration catches its own error, so a failure names every offending table.
- **AC-5b:** compares against every store and brand in the DB (the fixtures, the seed's 4 stores and 1 brand), plus NULL and a random uuid.
- **AC-6 manifest:** generated from the post-205 capture and diffed against the pre-205 one as described above. The header carries the regeneration query.
- **Mutation proof that the suite isn't vacuous** (scratchpad copies only):
  1. Dropping arm (iii) from `auth_visible_store_ids()` fails 10 assertions: AC-5 V, AC-5b for ADM-A+L, STALE+L and STAFF, AC-2 for the same three principals, ALL reachability for ADM-A+L and STALE+L, and the ADM-A+L non-vacuity guard.
  2. Rewriting `inventory_items` without the super_admin arm fails 4: the AC-6 manifest both ways, AC-2 for SA, and the SA non-vacuity guard.
- **Observed visible-row counts are non-trivial.** For example, ADM-A sees 2 to 6 fixture rows per table, including 6 brand-A profiles and 3 invitations (A, its own D-7 row, A1). SA sees 576 items. ANON sees 0 everywhere.

#### Test runs

| run | result |
|---|---|
| `bash scripts/test-db.sh` (after `supabase db reset`) | **114/114 files, 2,659 assertions** |
| `npx jest` | **322 suites, 4,131 tests passed** |
| `npm run typecheck` | exit 2, only the 24 `TS2688` errors from the git-ignored `node_modules/@types/* 2` folders (local-only; CI unaffected) |
| `npm run typecheck:test` | clean |

#### AFTER timings (AC-9)

Same harness and synthetic padding as BEFORE: medians of 3, as the seed admin.

| query | rows | no-RLS (postgres) | BEFORE | AFTER | AFTER runs |
|---|---|---|---|---|---|
| (a) inventory read with embeds | 572 | 4.74 ms | 184.9 ms | **6.53 ms** (1.38× no-RLS; target ≤ 3× met) | 6.76 / 6.53 / 6.36 |
| (b) `items_last_counted(Towson)` call | 143 | n/a | 428.1 ms | **2.47 ms** | 2.80 / 2.47 / 2.29 |
| (b) body | 143 | 0.76 ms | 458.7 ms | **2.68 ms** | 2.68 / 2.70 / 2.63 |
| (c) `audit_log` Towson top 100 | 100 of 950 | 0.03 ms | 77.9 ms | **0.16 ms** | 0.17 / 0.16 / 0.14 |

The real PostgREST request (`curl`, the `fetchInventory` select string): 0.42 to 0.56 s BEFORE, **0.03 to 0.08 s** AFTER. The response is identical in shape: 572 rows, 564 links, 639,634 bytes.

#### Plan shape (AC-8)

- **No `auth_can_see_*`:** neither function appears anywhere in the AFTER plans. There were 36 occurrences in BEFORE.
- **(a):** the `inventory_items` filter is `((InitPlan 26).col1 OR (store_id = ANY ((InitPlan 27).col1)))`. Inside the `item_vendors` EXISTS (SubPlan 11, run 564 times), its four helper InitPlans each show `loops=1`. The `vendors` and `catalog_ingredients` embeds use InitPlans with `loops=1`.
- **(b):** the outer filter is `store_id = ANY ((InitPlan 2).col1)`. The `eod_entries` / `inventory_count_entries` policy EXISTS become a `hashed SubPlan` (`loops=1`) whose helpers are InitPlans with `loops=1`.
- **(c):** `Index Scan using audit_log_store_id_created_at_idx`, with no Seq Scan.

**AC-8 ruling (architect post-impl review, SF-1):** AC-8 is met. The two remaining per-row calls (`super_admin_read_all_profiles`, and the restrictive `audit_log_restrict_select_store_user_actions`) come from non-R4 policies. They are a follow-up (release proposal FU-1). The D-6 "only under InitPlan" wording over-reached.

**Two per-row helper calls remain, both outside R4** (neither calls `auth_can_see_*`). The literal D-6 wording ("`auth_is_super_admin` / `auth_is_privileged` only under InitPlan") is therefore not met for them:
1. **(c):** the RESTRICTIVE `audit_log_restrict_select_store_user_actions` still has `OR auth_is_privileged()` per row. D-6 already notes this, and the OR short-circuits on ordinary actions.
2. **(a), new finding:** the `updater:profiles` embed's filter still carries `auth_is_super_admin()` per row, from the permissive `profiles` policy **`super_admin_read_all_profiles`** (`using (auth_is_super_admin())`). It isn't in R4, since it doesn't call `auth_can_see_*`. It runs only on rows that already match `id = ii.last_updated_by`, which is 0 rows locally. On prod it costs one profiles lookup per item that has `last_updated_by` set. **Suggested follow-up** (out of scope here, no change made): wrap it as `(select public.auth_is_super_admin())`, alongside the `auth_rls_initplan` self-policy follow-up.

#### Realtime (AC-10)

**Method:**
- A throwaway scratchpad Node script (`@supabase/supabase-js` from the repo's `node_modules`) signs in as ADM-A (`admin@local.test`, brand 2AM PROJECT, which includes Towson). It also signs in as a local-only brand-B admin, created with a crypt password, an `auth.identities` row, and `app_metadata.role = admin`.
- Both subscribe to `postgres_changes` on `inventory_items` with `store_id=eq.<Towson>` and on `catalog_ingredients` with `brand_id=eq.<2AM PROJECT>`. These filters *match* A1 for both, so only RLS can separate them.
- As postgres, it runs a no-op `update` on one Towson item and one brand-A catalog row.
- realtime was restarted after every `db reset`.

I used ADM-A's Node client as the positive control instead of a browser network tab. It checks the same thing at the protocol level.

**Results:**

| DB state | ADM-A | ADM-B |
|---|---|---|
| post-migration | 2 events (inventory_items UPDATE, catalog_ingredients UPDATE) | 0 |
| rolled back to pre-205 (AC-12) | 2 | 0 |
| re-migrated by `db reset` | 2 | 0 |

The brand-B fixture was deleted afterwards.

#### Rollback rehearsal (AC-12)

1. Extracted the R9 SQL from the migration header (the `-- begin;` to `-- commit;` block) and applied it with `psql`: 36 `ALTER POLICY`, then `DROP INDEX` and two `DROP FUNCTION`, in one transaction.
2. Checks after the rollback:
   - the D-1 JSON capture (all 36 quals) is **byte-identical** to the pre-205 capture;
   - the AC-6 manifest is identical to pre-205;
   - the helper md5s are unchanged;
   - both new helpers and the index are gone.
3. Ran `bash scripts/test-db.sh` over all 112 pre-existing files, with the 4 edited files swapped for their `git show HEAD:` versions and the 2 new suites left out: **112/112 green, 2,600 assertions**.
   - As a cross-check, the new S-3 and T3 pins and the new lint correctly **fail** on the rolled-back DB.
4. Re-migrated with `supabase db reset`, restarted realtime, and re-ran the full suite: 114/114. Then re-ran the AC-10 probe.

#### AC-11

- `git status` shows no change of mine under `src/` or `supabase/functions/`. The one `src/` diff in the tree, `src/lib/nativeAppConfig.spec181.test.ts`, was already there and isn't part of this spec.
- jest and both typechecks are as reported above.

#### Not done here

- AC-13 and AC-14 (the prod pre-check, apply and post-check) wait for the owner's explicit go-ahead (D-7).
- The proposed CLAUDE.md bullet (D-9 risk 2) is left for the owner. CLAUDE.md is not edited.

### Fix pass: release proposal A-1 to A-4, B-1, B-2 (backend-developer, 2026-11-23)

The owner approved every item in `specs/205-rls-visibility-once-per-query/reviews/release-proposal.md` sections A and B. The "hoist `auth_is_admin()`" nit was not taken, per the proposal. No policy text, helper body, grant or index changed.

#### What changed

| item | file | change |
|---|---|---|
| A-1 | migration header | Added a "NOT REPLAYABLE (by design)" paragraph, including: if `execute_sql` succeeded but the `schema_migrations` insert failed, insert the row; do not re-run. Also added the pre-flight note that a new per-row policy dated before this file must be added to the expected list. |
| A-2 | migration header, R9 block | Added the forward-order 35-table `lock table … in access exclusive mode` (profiles, stores, user_stores last) right after `set local lock_timeout`, inside the `-- ` block. Added a sentence saying how to run it: strip `-- ` from `-- begin;` through `-- commit;`. |
| A-3 | migration L273/L275, test L691/L703 | `string_agg(…, order by 1)` → `order by tablename, policyname`. No other positional `order by` remains in the migration, the equivalence suite or the lint suite. |
| A-4 | this spec | See the list below. |
| B-1 | migration pre-flight | The first check in the existing pre-flight `do $$` block, before any `create function`: raise if `to_regprocedure('public.auth_visible_store_ids()')` or `to_regprocedure('public.auth_profile_brand_id()')` is not null. Message: `spec 205 pre-flight: public.auth_visible_store_ids() or public.auth_profile_brand_id() already exists (already applied? do not re-run; see the header)`. |
| B-2 | `rls_visibility_once_per_query.test.sql` header | A LIFECYCLE paragraph. AC-3, AC-5, AC-6 and AC-7 are permanent. AC-2 and AC-5b are migration-time proofs that a later spec deletes, or re-baselines (`old_using` / the AC-5b reference), when it intentionally changes one of the 36 policies or `auth_can_see_*`. |

The A-4 spec edits:
- the SF-1 AC-8 ruling, under the AC-8 evidence;
- the SF-2 sizing, in AC-14 and D-7 step 4;
- AC-13 and AC-14 marked as hard gates. AC-13 and D-7 step 1 gain the `to_regprocedure` NULL pre-check; AC-14 and D-7 step 4 gain the `pg_read_all_data` BYPASSRLS check;
- D-7 step 2: the non-replayable note;
- D-7 step 3: stage only the spec-205 paths, with the shared-index procedure;
- D-7 step 4: compare manifests by running the same query on local and prod;
- D-7 step 4: the hard-gate line;
- D-7 step 5: the strip-`-- ` instruction;
- M-5: D-0 item 7 now says "four existing files edited, one arm each".

I also corrected two comments in the test header that named a non-existent `spec205_old` table. They now say `spec205_r4.old_using`.

#### Verification

| check | result |
|---|---|
| `supabase db reset` | applies `20261123120000` cleanly; the AC-6 manifest is identical to the earlier post-205 capture |
| `bash scripts/test-db.sh` | **114/114 files, 2,659 assertions** (unchanged) |
| Re-running the migration body on the migrated DB | refused by the B-1 guard with the message above; the transaction rolls back |
| AC-12 re-rehearsal | see below |
| `npx jest` | **322 suites, 4,131 tests passed** |
| Final local state | post-205: re-migrated by `supabase db reset`, realtime restarted |

The AC-12 re-rehearsal used the new R9 text:
1. Extracted the block from the migration header by stripping `-- ` from `-- begin;` through `-- commit;`. Its `lock table` list is identical (`diff`) to the forward one.
2. Applied it with `psql`: `SET`, `LOCK TABLE`, 36 `ALTER POLICY`, `DROP INDEX`, 2 `DROP FUNCTION`, one transaction.
3. After the rollback:
   - the D-1 capture of all 36 quals is **byte-identical** to the pre-205 capture;
   - the AC-6 manifest is identical to pre-205;
   - the five helper md5s are unchanged;
   - both helpers and the index are gone.
4. Ran the 112 pre-existing pgTAP files, with the four edited files swapped for their `git show HEAD:` versions: **112/112, 2,600 assertions**.
5. Re-migrated with `supabase db reset`.

### Prod rollout (main Claude, 2026-11-23, project `ebwnovzzkwhsdxkpyjka`, owner go-ahead in chat)

Commit e213a2a (spec-205 paths only, shared-index procedure; jest 322/4,131 on the exported tree).

**AC-13 pre-check (read-only): PASS.**
- `version()`: PostgreSQL 17.6 aarch64, the same as local.
- `to_regprocedure` is NULL for both new helpers; the index is absent; `schema_migrations` had no `20261123120000` (latest was `20261118120100`).
- The five helper md5s match the Build step 0 table exactly.
- D-1 returned the 36 expected policies.
- The AC-6 manifest (126 policies on the 35 tables, raw md5 of qual and with_check), hashed as one string in `tablename, policyname` order: `396705159d116c3bd0741b12508206f1` on prod and on the local pre-205 capture. Byte-identical.

**Apply.** One `execute_sql` of the migration body (L204-583, `begin` through `commit`) succeeded on the first try, with no lock timeout. Then `insert into supabase_migrations.schema_migrations (version, name) values ('20261123120000', 'rls_visibility_once_per_query')`. Pushed to `main` straight after.

**AC-14 post-check: PASS.**
- New helpers: md5 `a80debb55360aa50cffda341748ca678` (`auth_visible_store_ids`) and `9f64acd91030e6e765b8b266dfc68409` (`auth_profile_brand_id`), the same as local. Both are `prosecdef`, `search_path=public, auth`, STABLE, owner `postgres`, with `proacl` `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` and no PUBLIC (`=X/`) entry. Return types `uuid[]` and `uuid`.
- The five existing helper md5s are unchanged. (They carry a pre-existing PUBLIC `=X/postgres` entry on prod; not changed by this spec.)
- D-1 returns 0 rows.
- AC-6 manifest on prod: `d96e8635f625a1fb356ab4290db91d1c`, 126 policies, identical to the same query on the local post-205 DB.
- `audit_log_store_id_created_at_idx` is present: `btree (store_id, created_at DESC)`.
- `pg_read_all_data` members are `postgres`, `supabase_etl_admin` and `supabase_read_only_user`; both service roles are still BYPASSRLS.
- **SF-2 sizing:** 130 of 887 `inventory_items` have `last_updated_by` set. In plan (a) the profiles node runs 887 loops at 0.005 ms each, with `auth_is_super_admin()` still per row in its Filter (from `super_admin_read_all_profiles`). Total cost is a few ms, so it doesn't threaten the 3x target. FU-1 can wait.

**AC-8 timings on prod**, as the brand admin (`role authenticated`, admin JWT claims, local settings inside one implicit transaction, nothing written), one run each:

| query | 2026-11-23 before | after | no-RLS |
|---|---|---|---|
| (a) `INVENTORY_SELECT` equivalent, 887 rows | 1,574 ms | **73.1 ms** | 35 ms (2.1x) |
| (b) `items_last_counted(Towson)` call, 150 rows | 2.4-2.9 s | **22.1 ms** | n/a |
| (b) body form, literal store id | n/a | 103.9 ms execution (58.8 ms planning) | n/a |
| (c) `audit_log` Towson top 100 | 630 ms | **9.2 ms** (index scan on the new index) | n/a |

## Files changed

**Migrations**
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql` (new)

**pgTAP: new suites**
- `supabase/tests/rls_visibility_once_per_query.test.sql` (new: AC-2, AC-3, AC-5, AC-5b, AC-6, AC-7)
- `supabase/tests/rls_per_row_helper_lint.test.sql` (new: AC-4)

**pgTAP: text-pin updates (OQ-2; behavioural tests untouched)**
- `supabase/tests/audit_log_rls_hardening.test.sql`: S-3 only
- `supabase/tests/invitations_hardening.test.sql`: K-b, second sub-check only
- `supabase/tests/report_last_order_context.test.sql`: P1b, plus its header comment
- `supabase/tests/user_stores_own_row_writes.test.sql`: T3, plus its comment

**Spec**
- `specs/205-rls-visibility-once-per-query.md`: Status, implementation notes, this list

**Not changed:** anything under `src/`, `supabase/functions/`, `supabase/config.toml`, the realtime publication, `app.json` or `CLAUDE.md`.
