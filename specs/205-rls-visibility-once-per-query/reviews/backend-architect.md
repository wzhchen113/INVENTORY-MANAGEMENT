# Spec 205: backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-11-23. Read-only review. `Status:` not changed.

**Verdict: no Critical findings.** The implementation matches the "## Backend design" section (D-1 to D-9) and the 2026-11-23 Architect ruling. There are 2 Should-fix items (both are spec and prod-check records, not code) and 5 Minor items.

## What I checked

### D-2.1 helpers: match
- [20261123120000_rls_visibility_once_per_query.sql](../../../supabase/migrations/20261123120000_rls_visibility_once_per_query.sql) L295-326. Both bodies match D-2.1 character for character:
  - `array(select … union select …)`, never `array_agg`;
  - the `exists (profiles …)` arm is copied from `auth_can_see_brand`;
  - `language sql stable security definer set search_path = public, auth`.
- L328-331: `revoke all … from public`, then `grant execute … to authenticated, anon, service_role`, as designed (D-0 item 1).
  - The developer reports `proacl = {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`, with no PUBLIC entry.
  - [rls_visibility_once_per_query.test.sql](../../../supabase/tests/rls_visibility_once_per_query.test.sql) L441-461 pins this.
- L333-337: both `comment on function` texts are verbatim from D-2.1, including "CHANGE BOTH TOGETHER".

### D-2.6 rewrites: all 36 match
I compared each `alter policy` (migration L344-488) with the D-2.6 text:

| group | count | result |
|---|---|---|
| Direct store-scoped (`stores` uses `id`) | 13 | match; the `::uuid[]` cast is present in all of them |
| Store plus privileged (`order_approvals`, `order_schedule` ALL) | 2 | match; there is no WITH CHECK clause |
| Store EXISTS children (aliases `s`, `c`, `ii`, `po`, `pi`) | 5 | match |
| `audit_log` | 1 | match |
| Direct brand-scoped | 4 | match |
| `brands` | 1 | match; both super_admin arms are wrapped |
| Brand plus privileged (`notifications`, `staff_reports`) | 2 | match |
| `profiles`, with `id = (select auth.uid())` | 1 | match (D-2.5) |
| Brand EXISTS children (aliases `ci`, `r`, `pr`, `r`, `r`) | 5 | match |
| `user_stores` ALL | 1 | match; there is no WITH CHECK clause |
| `invitations` | 1 | match |

On `invitations`:
- the `not coalesce((… or …), false)` is the one NOT context (D-2.4);
- `auth_profile_is_privileged()` is wrapped;
- `invited_by = auth.uid()` is left bare on purpose (D-2.5).

All 21 store fragments use `= any ((select public.auth_visible_store_ids())::uuid[])`. I found no other form.

The R9 rollback (header L95-153) has 36 `alter policy` lines. Each one is the pre-205 source text:
- the `invitations` block matches [20261110120000_invitations_hardening.sql](../../../supabase/migrations/20261110120000_invitations_hardening.sql) L252-269;
- the others match the migrations cited in D-1.

The developer rehearsed it: after rollback the D-1 JSON was byte-identical to pre-205.

### D-3 migration order: match
The sequence is `begin` → `set local lock_timeout = '5s'` → pre-flight → `lock table` → helpers, grants and comments → 36 ALTERs → index → post-flight → `commit`.
- **Pre-flight** (L165-249): (a) a set diff against the 36 triples that reports both extras and missing; (b) both ALL policies have a WITH CHECK equal to their whitespace-normalized USING. It adds one check I didn't design: both ALL policies must exist. That is a good addition.
- **Lock list** (L254-290): all 35 tables, alphabetical, with `profiles`, `stores` and `user_stores` last.
- **Index** (L494-495): as R8.
- **Post-flight** (L500-526): the three designed checks.
- **Header:** it covers posture, the equivalence argument, the cast note, "CHANGE BOTH TOGETHER", realtime, locks, the prod apply and R9.
- **Filename:** re-glob still holds. `20261118120100` is the newest file before this one, and no 202/203/204/206 migration has landed.

### D-4 pin edits: match
I checked `spec205_pin_edits.diff`:
- **S-3:** the literal is re-pinned to the captured deparse, which equals the corrected D-4 prediction byte for byte. The message and comment are as designed. S-4 is untouched.
- **K-b:** this is the D-4 CASE form. The SELECT check requires `auth_profile_brand_id()` and forbids `auth_can_see_brand(`. The DELETE check still requires `auth_can_see_brand`. Both still require `auth_is_super_admin()` and `invited_by = auth.uid()`. The count stays at 2.
- **P1b:** `like '%auth_visible_store_ids()%'`. The expected string and the `+priv` arm are unchanged, and the header comment and message were updated.
- **T3:** the qual is re-pinned to the captured post-205 text, and the with_check is the pre-205 literal byte for byte. The md5 comment now refers to with_check.

### D-5 suites: match, with acceptable deviations
- **[rls_per_row_helper_lint.test.sql](../../../supabase/tests/rls_per_row_helper_lint.test.sql):** plan(3).
  - Arms 1 and 2 use an empty allowlist CTE with `not exists`.
  - Arm 3 uses the drop-then-assert probe. Its message carries the cast warning.
  - It scans qual only, PERMISSIVE and RESTRICTIVE, for SELECT and ALL. This matches D-5.1.
- **rls_visibility_once_per_query.test.sql:** plan(56) = 7 + 12 + 1 + 3 + 3 + 30, which matches the implementation notes.
  - AC-5 pins `prorettype` (the cast residual in D-2.2).
  - AC-5b uses the test-side `coalesce` over every store and brand, plus NULL and a random uuid.
  - AC-6 is a full 126-row manifest, checked as a set diff in both directions. It also pins the ALL with_check md5 against the pre-205 qual md5.
  - AC-2 alternates the old and new text with ALTER, runs as the real principals, runs the ALL UPDATE/DELETE probe inside a caught `P0205`, has a restore guard, and has all four designed non-vacuity guards. A fifth guard, SA versus NULLFK rows, was added.
  - The two mutation runs reported in the notes show that the suite is not vacuous.
  - Deviations are listed as M-3 and M-4 below. Both are acceptable.

### D-6 evidence: met
I read `after_explain.txt`:
- **(a)** The `inventory_items` Filter is `((InitPlan 26).col1 OR (store_id = ANY ((InitPlan 27).col1)))`. Inside the `item_vendors` EXISTS (SubPlan 11, `loops=564`), InitPlans 7-10 each show `loops=1`. The `vendors` and `catalog_ingredients` embeds show InitPlans with `loops=1`. Execution takes 6.36-6.76 ms against 4.74 ms with no RLS, which is 1.38× and inside the 3× target.
- **(b)** The `eod_entries` and `inventory_count_entries` EXISTS become `hashed SubPlan`s whose helper InitPlans are `loops=1`. The call takes 2.29-2.80 ms, down from 428 ms.
- **(c)** `Index Scan using audit_log_store_id_created_at_idx`, with no Seq Scan. It takes 0.16 ms, down from 77.9 ms.
- No `auth_can_see_*` appears in any AFTER plan.

AC-10 (realtime, both directions, over three DB states), AC-12 (the rollback rehearsal, 112/112 green on the pre-205 pins) and the AC-6 one-time diff (only the 36 qual md5s differ) are all recorded.

## Findings

### Critical
None.

### Should-fix

**SF-1. Ruling needed in the spec record: is AC-8 met? It is, and the over-broad pass condition was my error.**
- **What the developer recorded.** The notes say the literal D-6 pass condition is "not met". That condition was "`auth_is_super_admin` / `auth_is_privileged` appear only under InitPlan nodes". Two per-row calls remain, both outside R4:
  - `super_admin_read_all_profiles` (after_explain.txt L397);
  - `audit_log_restrict_select_store_user_actions` (L952).
- **Ruling.** The spec's own AC-8 asks two things: the R4 visibility helpers appear only as InitPlans, and there is no `auth_can_see_*` in any per-row Filter, SubPlan or Join Filter. Both hold.
  - D-6 over-reached: it named `auth_is_super_admin` and `auth_is_privileged` without limiting them to the R4 quals. That is my design error, not drift by the developer.
  - D-6 (c) already listed the restrictive audit_log exception. The profiles policy is the one I missed.
- **Action.** Before release, the developer or main session adds one line under the AC-8 evidence: "AC-8 met per architect review; the two remaining per-row calls come from non-R4 policies (see the architect review, follow-up)". Then release-coordinator won't read the AC as broken. No code change.

**SF-2. Add sizing for the profiles per-row path to the D-7 step 4 prod check (AC-14).**
- **Why the local evidence doesn't cover it.** The local harness for (a) has 0 `inventory_items` rows with `last_updated_by` set. SubPlan 22 shows `rows=0`, and its InitPlans show "never executed". So the per-row `auth_is_super_admin()` from `super_admin_read_all_profiles` costs nothing locally.
- **What happens on prod.** That call runs once per item whose `last_updated_by` matches a profile row. It is a single SECURITY DEFINER profiles lookup, not the nested chain inside `auth_can_see_store`. It is still per row, and prod has about 887 items.
  - The plan shape also matters. PostgREST's `LEFT JOIN LATERAL` embed may plan it differently from the hand-written correlated subquery: a join filters each profile row once, while a per-item subplan filters once per item.
- **Amend AC-14 to record:**
  - `select count(*) from public.inventory_items where last_updated_by is not null` (read-only);
  - for the profiles node in the prod (a) plan: `loops`, the actual time, and whether `auth_is_super_admin()` sits in its Filter.
- **How to read the result.** This is expected and is not an AC-14 failure. If prod (a) misses 3× no-RLS because of it, the miss is reported and investigated (AC-9 wording). The fix goes in the follow-up below.

### Minor

**M-1. The ALL-policy reachability probe has no standing non-vacuity guard.**
- [rls_visibility_once_per_query.test.sql](../../../supabase/tests/rls_visibility_once_per_query.test.sql) L898-931 maps any non-P0205 error to `ERR:<sqlstate>` in both `upd` and `del`.
- If every principal errored the same way in both modes (for example, a future trigger or grant change), L960-969 would pass with nothing compared.
- Mutation 1 shows that the probe bites today. Still, one `is()` asserting that ADM-A's new-mode `upd` and `del` for both tables are non-empty and not `ERR:%` would keep it honest. This isn't blocking.

**M-2. The lint doesn't catch an unwrapped new helper.**
- `store_id = any (public.auth_visible_store_ids())` parses (it's an array expression) and is per row. AC-4 only looks for `auth_can_see_*(`.
- Put it in the follow-up spec as a second lint arm: a regex for `auth_(visible_store_ids|profile_brand_id|is_super_admin|is_privileged|profile_is_privileged)\(\)` not preceded by `SELECT ` in the deparse. ARE supports `(?<!…)`.
- This is out of scope for 205's ACs.

**M-3. AC-3 is aggregated** (L724-754). It uses one `is()` for errors and one for nonzero counts, instead of 35 `lives_ok`. Each table's error is caught separately and named on failure. This is equivalent to D-5.2, so I accept it.

**M-4. The fixtures disable all user triggers.** They use `disable trigger user` on `user_stores` and 15 other tables, where D-5.2 named only `user_stores_brand_match_trg`. It is transactional and rolled back, foreign keys and CHECK constraints stay enforced, and the notes explain it. I accept it. Code-reviewer may want the trigger list kept to the tables that need it. That is not an architecture concern.

**M-5. My own design text is inconsistent.** D-0 item 7 says "three existing files edited (four arms)", but four files are edited, one arm each, which matches D-4 and `## Files changed`. This is cosmetic, with no implementation impact.

## Assessment: `super_admin_read_all_profiles` and the restrictive audit_log policy

**Recommendation: a follow-up spec, not this spec.** Don't fold either policy into 205.

**Why not now:**
1. **Scope.** R4 is defined as SELECT and ALL quals that call `auth_can_see_store(` or `auth_can_see_brand(`, and the owner approved that scope on 2026-11-23. Neither policy qualifies. Folding them in is a scope expansion that needs the owner's say (project rule).
2. **Re-work.** Every artifact is keyed to the 36 policies: the pre-flight triple set, the post-flight, the AC-6 manifest, the AC-2 old-text table, the R9 rollback, the AC-12 rehearsal and the AC-6 one-time diff. Adding a 37th means re-running D-1, AC-6, AC-2 and AC-12 and re-reviewing, which reopens the build for a change measured at 0 ms locally.
3. **Bounded cost.**
   - **`super_admin_read_all_profiles`:** one PK lookup per matching profile row, with no nested `stores`/`user_stores` chain. Its cost on prod is unmeasured (SF-2 measures it).
   - **The restrictive audit_log policy:** its OR evaluates the cheap `action <> ALL (...)` first (L952), so `auth_is_privileged()` runs only on the three store-user/deleted action rows. That's negligible.
4. **Equivalence.** Both fixes are trivially equivalent: a zero-argument STABLE helper, InitPlan versus per-row, on the same snapshot. They make a small, clean, separately reviewable migration.

**Suggested follow-up scope** (for the PM; one spec):
- `profiles.super_admin_read_all_profiles` (SELECT) → `using ((select public.auth_is_super_admin()))`;
- `brands.super_admin_manage_brands` (ALL; its USING also applies to SELECT) → the same wrap, with an explicit WITH CHECK set to the old text, under the R6 rule;
- `audit_log_restrict_select_store_user_actions` (RESTRICTIVE) → `or (select public.auth_is_privileged())`, through `ALTER POLICY` so it stays restrictive (the spec 194/186 pins `C-1b`/`P-1` cover only the delete quals, but re-grep first);
- a census across **all** `public.*` tables, not only the 35, of SELECT and ALL quals that call any zero-argument SECURITY DEFINER `auth_*` helper unwrapped;
- the 29 `auth_rls_initplan` self-policy warnings already deferred by 205, such as the bare `auth.uid()` that `Users can read own profile` inlines per row (after_explain.txt L397);
- the M-2 lint arm.

**Exception.** If the AC-14 prod (a) EXPLAIN shows the profiles path pushing the inventory read past 3× no-RLS, the owner may prioritize the follow-up immediately. It still goes in a **new** migration. Once 205 is on prod, its file is history and must not be edited.

## D-7 prod rollout: still correct against the final text, with amendments

The steps hold as written. I confirm them against the final migration and add these notes:

1. **Step 1 (AC-13 pre-check):** unchanged.
   - Prod's D-1 must return the same 36 triples, and the five helper md5s must match the "Build step 0" table in the implementation notes.
   - The migration's own pre-flight enforces the 36-triple set again at apply time and fails closed.
   - `select version()` must be the same major (17).
2. **Step 2 (apply):** unchanged.
   - The file carries its own `begin; … commit;`, `set local lock_timeout` only takes effect inside it, and the header comments are harmless to `execute_sql`.
   - A 55P03 or 40P01 rolls back the whole transaction and is safe to retry.
   - Then insert version `20261123120000`, name `rls_visibility_once_per_query`, into `supabase_migrations.schema_migrations`.
3. **Step 3 (push):** unchanged, with one addition.
   - The working tree holds unrelated modifications: `app.json`, `CLAUDE.md`, the agent files, the spec 181 test and spec.
   - The spec 205 commit must stage only its own 8 files (the migration, 2 new suites, 4 pin edits and the spec), using the shared-index procedure from project memory.
   - After the push, check `test.yml` and `db-migrations-applied.yml`, and check `e2e.yml` by hand.
4. **Step 4 (AC-14 post-check):** unchanged, plus SF-2.
   - Expected values: `proacl` as recorded locally (postgres, anon, authenticated and service_role, no `=X/` entry); `proowner = postgres`; D-1 returns 0 rows; the index is present.
   - For the manifest diff, run the same manifest query on local and on prod, rather than diffing prod against the test file's constants. The constants are raw-deparse md5s, which only hold on the same Postgres major.
   - The (a) and (c) EXPLAINs will show the two non-R4 per-row calls. That is expected, per SF-1 and SF-2.
5. **Step 5 (rollback):** unchanged.
   - The R9 block in the header is commented out with `-- `. Strip the prefix from `-- begin;` through `-- commit;` exactly as rehearsed for AC-12.
   - Then delete the `schema_migrations` row and revert the commit.
6. **Realtime:** no publication change, so no realtime restart on prod. This is unchanged.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix (SF-1 AC-8 ruling to record in the spec; SF-2 add profiles-path sizing to the AC-14 prod check), 5 Minor. The two non-R4 per-row helper calls are recommended for a follow-up spec, not this one.
payload_paths:
  - specs/205-rls-visibility-once-per-query/reviews/backend-architect.md
