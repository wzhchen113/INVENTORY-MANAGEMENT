# Release proposal: spec 205 (RLS visibility once per query)

Release-coordinator, 2026-11-23. Sources: the spec (including Backend design D-0..D-9 and the implementation notes), the four reviewer files in this directory, and the migration header (L1-165) where reviewer claims needed confirming. Nothing else was edited.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical and all three CI gates are green on `main` (1e9e4b8), but four small fixes are needed before commit. All of them are comments in the migration header or notes in the spec record, and no logic changes. They have to land now because the migration file becomes frozen history once it is applied to prod, and the prod runbook (D-7, AC-13/AC-14) depends on them.

The fix pass is small. Once it is done and re-verified, this goes to the owner as ship-ready, with no further review round needed. The exception is the optional pre-flight guard (B-1): if it is added, the security-auditor should glance at it.

## Findings summary

- **code-reviewer** (no shell; given the four pin edits as a diff): 0 Critical, 6 Should-fix, 8 Nits, plus 1 out-of-scope note.
  - It confirmed all 36 `alter policy` texts match D-2.6. The `::uuid[]` cast is present in all 21 store rewrites, no qual names `auth_is_admin`, the grants match the sibling helpers, and `plan(56)` / `plan(3)` match the assertion counts.
  - Top issues:
    - The R9 rollback block has no up-front `lock table`, which reopens the deadlock window on the incident path (SF-4).
    - The header doesn't say the migration is deliberately non-replayable. That matters for the MCP apply (SF-5).
    - `string_agg(..., order by 1)` doesn't sort (SF-6). I confirmed it at migration L218/L220 and test L679/L691.
    - The 126-row AC-6 md5 manifest is costly to maintain (SF-1).
    - The AC-2 and AC-5b arms have no lifecycle note for future authors (SF-2).
    - The lint's allowlist and predicate are copy-pasted three times, and arm 3 never proves the brand half (SF-3).
- **security-auditor**: 0 Critical, 0 High, 1 Medium, 3 Low, plus 1 informational note.
  - It independently ran a 300-caller-shape grid of old vs new predicates: 0 mismatches. It also confirmed the NULL/false analysis, the invitations `coalesce` under NOT, unchanged WITH CHECK on both ALL policies, SECURITY DEFINER hygiene, and realtime per-subscriber evaluation.
  - **Medium:** two copies of the visibility rule now exist and can drift. AC-5b only covers 12 principal shapes. The fix is a follow-up spec that redefines `auth_can_see_*` on top of the new helpers.
  - **Low:**
    - the lint can't catch a policy that leaves out the super_admin arm;
    - AC-2 compares whole tables, so a neighbouring permissive policy can mask a broken arm on `profiles`, `user_stores` and `order_schedule`;
    - the pre-flight matches policy names, not text, and `create or replace` keeps an existing owner and grants. Its instruction: **treat AC-13/AC-14 as hard gates, not paperwork.**
- **test-engineer**: AC-1 through AC-12 PASS (12 of 12). AC-13 and AC-14 are NOT TESTED, deferred by design because they are prod checks that need the owner's go-ahead.
  - Independently reproduced: full pgTAP 114/114, jest 322 suites / 4,131 tests, `typecheck:test` clean, `typecheck` showing only the known local TS2688 noise, and the AFTER timings and plan shape.
  - AC-10, AC-12 and the BEFORE half of AC-9 rest on developer evidence only.
  - Flagged: the migration and the two new suites are untracked and must be committed together with the four pins. CI uses Supabase CLI 2.106.0 while the local stack is 2.95.4, so only the first CI run proves the S-3/T3 deparse pins (rated low risk).
- **backend-architect** (post-impl drift; no shell): 0 Critical, 2 Should-fix, 5 Minor. The implementation matches D-1 to D-9 and the cast ruling.
  - **SF-1:** record a ruling in the spec that AC-8 is met. The D-6 "only InitPlan" wording over-reached; it was the architect's own error.
  - **SF-2:** add sizing for the `super_admin_read_all_profiles` per-row path to the AC-14 prod check.
  - **Minor:** M-1, no non-vacuity guard on the ALL-policy probe; M-2, the lint misses an unwrapped new helper; M-3 and M-4, accepted deviations; M-5, a cosmetic error in the design text.
  - **D-7 amendments:**
    - stage only the 8 spec-205 files;
    - add the SF-2 sizing;
    - compare the prod manifest by running the same query on local and prod, not against the test-file constants;
    - for rollback, strip `-- ` from `-- begin;` through `-- commit;`.
- **CI on `main`:** `test.yml`, `db-migrations-applied.yml` and `e2e.yml` were all green on 1e9e4b8 when checked by the dispatcher. That satisfies the gate rule for now. It must be re-checked after the push.

## Recommended next steps (ordered)

### A. Must fix before commit (developer pass; header comments and spec record only)

These must land now for one of two reasons. Either they are in the migration file, which must not be edited once it is on prod (architect, "Exception" paragraph), or the prod apply runbook depends on them.

1. **Migration header: state that the migration is non-replayable** (code-reviewer SF-5, Should-fix). Comes first because it changes what the operator does during the MCP apply.
   - Add a line such as: "Fail-closed pre-flight; re-running after a successful apply raises by design. If `execute_sql` succeeded but the `schema_migrations` insert failed, insert the row; do not re-run."
   - Also add code-reviewer's pre-flight nit in the same edit: "a new per-row policy dated before this file must be added to the expected list".
2. **Migration header: add the forward-order `lock table` to the R9 rollback block** (code-reviewer SF-4, Should-fix). The rollback is the incident path. It should take the same 35-table AccessExclusive lock as the forward path, with `profiles`, `stores` and `user_stores` last, rather than 36 serial lock acquisitions.
   - Keep it inside the `-- ` commented block so the D-7 step 5 extraction still works: strip `-- ` from `-- begin;` through `-- commit;`.
   - **Re-rehearse AC-12 locally**, because the rollback text changed. Record the result in the implementation notes.
3. **Fix `order by 1` inside `string_agg`** (code-reviewer SF-6, Should-fix, low severity).
   - Use `order by tablename, policyname` at migration L218/L220. Fix the same pattern at test L679/L691 in the same pass.
   - On its own merits this is cosmetic: it affects only the ordering of failure messages. It is in group A only because the migration freezes after the prod apply.
4. **Spec record edits** (architect SF-1 and SF-2; security Low 3; D-7 amendments). Docs only, but the prod operator follows these.
   - **SF-1:** under the AC-8 evidence, add: "AC-8 met per architect review; the two remaining per-row calls (`super_admin_read_all_profiles`, the restrictive `audit_log_restrict_select_store_user_actions`) come from non-R4 policies; follow-up."
   - **SF-2:** in the AC-14 / D-7 step 4 checklist, add:
     - `select count(*) from public.inventory_items where last_updated_by is not null`;
     - for the profiles node of the prod (a) plan: `loops`, actual time, and whether `auth_is_super_admin()` sits in its Filter. A miss of the 3x target caused by this is reported, not an AC-14 failure.
   - **AC-13 and AC-14 are hard gates:** any mismatch stops the apply, or triggers the rollback decision.
     - Add to AC-13: `to_regprocedure('public.auth_visible_store_ids()')` and `to_regprocedure('public.auth_profile_brand_id()')` are both NULL on prod before the apply. This covers the `create or replace` owner/ACL residual without touching the migration.
     - Add to AC-14: confirm that `pg_read_all_data` members (`supabase_read_only_user`, `supabase_etl_admin`) are still BYPASSRLS on prod (security verification item 5).
   - **D-7 amendments:**
     - step 3 stages only the spec-205 paths, using the shared-index procedure;
     - step 4 compares manifests by running the same query on local and on prod;
     - step 5 strips `-- `.
   - Fix M-5 while editing: D-0 item 7 should say "four files, one arm each".
5. **Re-verify after steps 1 to 4:**
   - `npx supabase db reset`, then the full `bash scripts/test-db.sh` (expect 114/114);
   - the AC-12 rollback re-rehearsal from step 2;
   - `npx jest` (no `src/` change, so this is a formality).
   - The S-3 and T3 pins are unaffected because only header comments and a pre-flight message change.

### B. Optional in the same pass (cheap; not blocking)

- **B-1. Pre-flight guard in the migration** (security Low 3, "if wanted"): raise if either new helper already exists (`to_regprocedure(...) is not null`). It duplicates the AC-13 addition in A-4, but it enforces the check at apply time. If added, have the security-auditor glance at it and re-run step 5.
- **B-2. AC-2 / AC-5b lifecycle paragraph in the test-file header** (code-reviewer SF-2). It is comment-only.
  - It would say which arms are permanent (AC-3, AC-5, AC-6, AC-7) and which are migration-time proofs (AC-2, AC-5b): delete them, or re-baseline `old_using`, when a later spec intentionally changes one of the 36 policies or `auth_can_see_*`.
  - Worth doing now, because spec 204 may touch `item_vendors` / `inventory_items` policies next. If not done now, it moves to follow-up C.
- **Do not** take code-reviewer's nit to hoist `auth_is_admin()` inside `auth_visible_store_ids()`. Changing the helper body would invalidate the recorded md5s, the AC-5b evidence and the security grid for a negligible gain.

### C. Owner decisions before commit

- **C-1. Proposed CLAUDE.md bullet** (design D-9 risk 2). It needs owner approval; agents do not edit CLAUDE.md. The security-auditor recommends it lands with this spec.
  - If approved, consider adding one sentence covering security Low 1: "every use of the new helpers must keep the `(select public.auth_is_super_admin()) or` arm".
  - **Staging caveat:** CLAUDE.md already has unrelated uncommitted edits in the working tree. The bullet must be staged hunk-only (shared-index `apply --cached` of just that hunk), or go in a separate commit once the other CLAUDE.md edits are settled. Do not stage the whole file.
- **C-2. Go-ahead for commit and prod apply.** Both need the owner's explicit approval in chat. Main Claude does not auto-commit.

### D. Commit and prod apply (owner go-ahead; quiet window; push and apply close together)

**Paths to commit for spec 205, and only these:**
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql` (new)
- `supabase/tests/rls_visibility_once_per_query.test.sql` (new)
- `supabase/tests/rls_per_row_helper_lint.test.sql` (new)
- `supabase/tests/audit_log_rls_hardening.test.sql` (S-3 only)
- `supabase/tests/invitations_hardening.test.sql` (K-b second sub-check only)
- `supabase/tests/report_last_order_context.test.sql` (P1b plus header comment)
- `supabase/tests/user_stores_own_row_writes.test.sql` (T3 plus comment)
- `specs/205-rls-visibility-once-per-query.md` (new)
- `specs/205-rls-visibility-once-per-query/reviews/` (the four reviewer files plus this proposal). This follows the spec 206 precedent, whose reviews directory was committed. It is optional if the owner prefers the architect's strict 8-file list.

The test-engineer confirmed the four edited test files contain only spec-205 hunks, so they can be staged whole.

**Do NOT stage:**
- `.claude/agents/*` (8 files)
- `CLAUDE.md` (except an approved C-1 hunk)
- `app.json`
- `specs/181-native-internal-build.md`
- `src/lib/nativeAppConfig.spec181.test.ts`

Use the shared-index procedure from project memory (temp `GIT_INDEX_FILE`, `read-tree HEAD`, `apply --cached`), and run the test suites on the exported tree before committing.

**Sequence:**
1. Commit locally. Do not push yet.
2. **AC-13 pre-check** (read-only, MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`). This is a **hard gate**:
   - prod's D-1 returns the same 36 triples;
   - normalized-md5 diffs of the qual and with_check manifest match local pre-205;
   - the five helper md5s match the "Build step 0" table;
   - `version()` is major 17;
   - both new helper names are absent (A-4).

   Any mismatch stops here and goes to the owner.
3. **Apply.** Run one `execute_sql` with the migration body; it has its own `begin … commit`.
   - On 55P03 (lock timeout) or 40P01 (deadlock), the whole transaction rolled back, so retry.
   - Then insert version `20261123120000`, name `rls_visibility_once_per_query`, into `supabase_migrations.schema_migrations`.
   - If the apply succeeded but the insert failed: insert the row, do **not** re-run the migration (A-1).
4. **Push to `main` immediately.** Applying before pushing is the safe order: a prod entry missing from the repo only warns, while a repo migration missing from prod hard-fails `db-migrations-applied`.
5. **AC-14 post-check.** This is a **hard gate**:
   - helper md5, `prosecdef`, `proconfig`, `proacl` (anon, authenticated and service_role; no `=X/` entry), and `proowner = postgres`. If the owner differs, stop and ask; do not silently re-own;
   - D-1 returns 0 rows;
   - the manifest matches local post-205, using the same query on both sides;
   - the index is present;
   - `pg_read_all_data` members are still BYPASSRLS;
   - the AC-8 EXPLAINs run as the brand admin in a rolled-back transaction, with the SF-2 sizing. Record them next to the 2026-11-23 figures (1,574 ms / 2.4-2.9 s / 630 ms).

   A failure means an owner decision on the R9 rollback: strip `-- `, apply, delete the `schema_migrations` row, and revert the commit.
6. **CI.** Confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green, and check `e2e.yml` by hand.
   - The first CI run is the one that proves the S-3 / T3 deparse pins under the CI image.
   - If either gate is red or in progress, surface the run URL and wait for the owner.
7. **Record AC-13 and AC-14** in the spec's implementation notes, in a small follow-up commit.

### E. Follow-ups (not blocking; candidate follow-up specs)

These can wait because none changes what any principal sees. Each is either on a path outside the approved R4 scope (adding it would reopen the 36-policy build and its proofs) or test-only and editable at any time. Any later DB change goes in a **new** migration, never into `20261123120000`.

- **FU-1. Per-row helper census and InitPlan sweep** (architect's assessment; one spec).
  - Scope:
    - `profiles.super_admin_read_all_profiles` → `using ((select public.auth_is_super_admin()))`;
    - `brands.super_admin_manage_brands` (ALL) → the same wrap, with an explicit WITH CHECK set to the old text, under the R6 rule;
    - the RESTRICTIVE `audit_log_restrict_select_store_user_actions` → `or (select public.auth_is_privileged())`, through `ALTER POLICY` so it stays restrictive;
    - a census across **all** `public.*` tables for unwrapped zero-argument SECURITY DEFINER `auth_*` helpers in SELECT/ALL quals;
    - the 29 `auth_rls_initplan` self-policy warnings (for example the bare `auth.uid()` in "Users can read own profile");
    - the lint additions: architect M-2 (an unwrapped new helper), security Low 1 (a qual that uses the new helpers but lacks `auth_is_super_admin()`), and the code-reviewer nit that the lint ignores bare `auth_is_privileged()` / `auth_is_super_admin()`.
  - **Priority trigger:** if the SF-2 sizing in AC-14 shows the profiles path pushing prod (a) past 3x no-RLS, the owner may pull this forward.
  - **Note:** `profiles`, `brands` and `audit_log` are all among the 35 tables pinned by the AC-6 manifest. This spec will trip that manifest by design, so do it together with FU-3, or after it.
- **FU-2. Single source of truth for visibility** (security Medium).
  - Redefine `auth_can_see_store(x)` as `auth_is_super_admin() or coalesce(x = any(auth_visible_store_ids()), false)`, and `auth_can_see_brand(b)` the same way on top of `auth_profile_brand_id()`.
  - This removes the drift risk the Medium describes, and it speeds up write-side checks and RPC gates. Its own equivalence proof can reuse the security-auditor's 300-shape grid.
  - It touches every write-side policy and RPC gate indirectly, so it needs its own spec and review. It also makes the 205 AC-5b arm tautological, so it should retire or re-baseline AC-2 / AC-5b (see FU-3).
  - Until it lands, the "CHANGE BOTH TOGETHER" comments and the C-1 CLAUDE.md bullet are the only guard.
- **FU-3. Spec-205 test-suite lifecycle hygiene** (test-only).
  - Scope:
    - code-reviewer SF-1: narrow the AC-6 manifest to name, cmd, permissive, roles and per-`(table, cmd)` counts for all policies, plus md5s only for the 36 rewritten quals and the two ALL with_checks; or keep the full manifest and put the regeneration recipe in `tests/README.md`. This is a trade-off the architect chose deliberately (D-9 risk 6), so it is the owner's call;
    - SF-2, if not done in B-2;
    - SF-3: one temp allowlist and one offenders view shared by all lint arms, plus a brand-policy negative probe;
    - architect M-1: an ALL-probe non-vacuity guard (ADM-A new-mode `upd` / `del` non-empty and not `ERR:%`);
    - security Low 2: a per-policy old-vs-new isolation check for tables with overlapping permissive policies (`profiles`, `user_stores`, `order_schedule`);
    - code-reviewer nits: re-assert the R6 with_check after the AC-2 restore guard; K-b `like` count of at least 2 for `auth_profile_brand_id()`; the duplicate S-3/T3 vs manifest pins.
  - It should precede, or ride with, FU-1 and any spec (for example 204) that changes policies on the 35 tables.

## Out of scope for this review

- **Spec 206** (realtime reload scheduling). Already shipped in 1e9e4b8, with no file overlap.
- **Loading only the current store's inventory**, the serial fetch waterfall, multi-step write RPCs, and a compute-tier upgrade (findings §3-§5). These need separate specs.
- **`waste_log` unbounded reads and the unfiltered `fetchIngredientConversions`** (findings §6). These are client changes.
- **Write-side policies** (INSERT/UPDATE WITH CHECK, DELETE USING), and the bare `auth.uid()` in the `invitations` SELECT (D-2.5, kept bare on purpose).
- **`storage.objects` policies** (for example `ingredient_images_public_read`).
- **The local `npm run typecheck` TS2688 noise** from the git-ignored `node_modules/@types/* 2` folders. It is a local environment issue, not CI, and not this spec.
- **The unrelated working-tree changes** (`.claude/agents/*`, CLAUDE.md, `app.json`, spec 181 and its test). They belong to other work. `app.json` identity values must not be changed without explicit owner approval (CLAUDE.md "DO NOT AUTO-CHANGE").

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 4 items, top: migration-header fixes (non-replayable note, lock table in R9 rollback, order by 1), plus spec-record AC-8 ruling / AC-14 sizing / AC-13-14 hard-gate edits; no logic change, then owner go-ahead for 205-only staging and MCP prod apply.
payload_paths:
  - specs/205-rls-visibility-once-per-query/reviews/release-proposal.md
