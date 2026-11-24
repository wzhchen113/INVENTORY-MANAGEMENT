# Spec 207: release proposal

Release-coordinator, 2026-11-24. Built from the four reviewer files in this folder, read in full, plus the spec and the migration's R1 body (L222-274) and the AC-6 and final-check blocks of `cost_rederive_on_pack_size.test.sql`. This proposal is advisory. Whether to ship is the user's call.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical and every gate passes locally, but there are three small fixes: one security Medium (R1's DEFINER fan-out crosses the brand boundary, so another brand can block this brand's pack-size edits) and two Should-fix items (a weakened AC-12 pin and a stale comment). Two of them change the migration body, which has to be final before the D-11 prod apply. Also, nothing is applied to prod yet, so pushing now would turn `db-migrations-applied.yml` red.

## Findings summary
- **code-reviewer:** 0 Critical, 2 Should-fix, 6 Nits.
  - Should-fix: `apply_item_scalars_to_brand.test.sql` (15), "NULL-means-skip", can no longer fail. The row is priced, so R3 rewrites the cost whatever the RPC does.
  - Should-fix: the `receive_purchase_order` comment copied verbatim (migration L493-496) still says "coalesce to >= 1 … never zero". That is false for `case_qty = 0`.
  - Nits: the four-times-repeated `case when … per_each_cost … else round(cost*old/new)` expression in R1; unparenthesised `and`/`or` in the AC-11 boolean; C20 missing from the fixture legend; the jest describe title overstates "per_each_cost parity"; a NaN-for-NULL note; the PROD APPLY header leans on the spec's "D-11" label.
- **security-auditor:** 0 Critical, 0 High, 1 Medium, 0 Low.
  - Medium: R1 (SECURITY DEFINER) rewrites every `inventory_items` row with `catalog_id = new.id`, including rows at another brand's stores. Those rows can exist because of the FU-3 insert-policy gap.
    - A store member of brand 2, staff included, can plant an unpriced row with `cost_per_unit = 999999.999999` that points at a brand-1 catalog id.
    - When the brand-1 admin later lowers that item's pieces, the OQ-2 scaling overflows `numeric(12,6)` (22003) and aborts the admin's catalog PATCH.
    - The admin cannot see the blocking row, so recovery needs a super_admin or psql.
    - Secondary effect: a pieces-count oracle that adds little beyond what pwa-catalog already exposes.
    - Fix: brand-scope both R1 UPDATEs and flip AC-6.
  - Everything else was verified: the `receive_purchase_order` guards and ACL, `search_path` pinning, grants, the R3 INVOKER no-leak, `list_cost_drift` gating and scoping, and that the fixture edits do not weaken the RLS probes.
- **test-engineer:** 12 PASS, 0 FAIL, 1 NOT TESTED (AC-13, expected: it is a prod rollout step).
  - Full pgTAP 116/116 files, including the new files with 59 and 17 assertions. Full jest 323 suites / 4160 tests. `typecheck:test` exit 0.
  - `typecheck` fails locally only with TS2688 on duplicate `node_modules/@types/<name> 2` folders (Finder copies). This was confirmed as an environment issue; CI is unaffected.
  - e2e not run (port 8081 held by another session, and the DB is shared).
  - Flags that `db-migrations-applied.yml` will be red after a push until D-11 has run.
- **backend-architect (post-impl):** 0 Critical, 1 Should-fix, 5 Minor. The design matches the build object by object; `receive_purchase_order` differs from 20260707000000 by exactly one line.
  - S-1 is the same finding as code-reviewer's first Should-fix. Fix: add an unpriced row with a hand-set cost to the NULL-skip call and assert it survives.
  - M-1: stale in-body comments (L389-390, L394, L493-496). The architect accepts keeping them verbatim but suggests a header sentence.
  - M-2: rows that point at another brand's catalog row derive differently depending on who writes them. Run `list_cost_drift` as `postgres` and they show as `drift`, so check `stores.brand_id <> catalog_ingredients.brand_id` before treating a non-zero D-11 count as new drift.
  - M-3: the R3 re-point columns (`catalog_id`, `item_id`) have no behavioral test.
  - M-4: e2e must be confirmed on the post-push `e2e.yml` run.
  - M-5: the working tree has unrelated changes (`app.json`, `CLAUDE.md`, `.claude/agents/*`, spec 181 files). Keep them out of the 207 commit.
  - The four developer deviations were judged: anon checked by `has_function_privilege` (accept), savepoint plus xmin/ctid write detection (accept; this corrects the D-9 claim), the verbatim comment (accept), the (15) comment (partial accept, which is S-1).

**CI gates on `main`:** I could not check these (no shell in this role). The most recent commits on `main` (`11c9be0`, `732987d`, `e213a2a`) are spec 205/206 work, which was applied to prod. Before pushing, confirm that the latest runs of both `test.yml` and `db-migrations-applied.yml` on `main` are green (release step R-1). If either is red, SHIP_READY is blocked whatever happens with this spec.

## Recommended next steps (ordered)

### Fixes (all small; fold them in before committing)

The first two edit the migration file. Do them together and first, because D-11 step 3 compares the normalized md5 of prod functions against local. The migration text must be frozen before the prod apply, and any later edit to a function body (comments inside `$$ … $$` count) means re-applying.

1. **Brand-scope R1's two UPDATEs and flip AC-6.** Severity: security Medium. Effort: about 2 lines of SQL and 3-4 test edits. Done first because it changes R1's contract.
   - **Migration (L240-251 and L256-270).** Add the brand predicate to both UPDATEs. In (a): `and exists (select 1 from public.stores s where s.id = ii.store_id and s.brand_id = new.brand_id)`. In (b), add the same predicate against `ii.store_id` (the `from public.inventory_items ii` join is already there). Schema-qualify, since `search_path = ''`. Update the (a) comment "every store with this catalog row" to "every store of the catalog's brand".
   - **pgTAP `cost_rederive_on_pack_size.test.sql`:**
     - L367-371: flip the AC-6 assertion so store Z's C1 row (`iid(1,3)`) is NOT re-derived. It keeps 33.95, with its version (xmin/ctid) unchanged. Keep the "every brand-1 store" half (A and B).
     - L359-366: rewrite the comment. The D-4 finding still stands (no same-brand store is invisible to a privileged caller). The cross-brand row now pins that R1 stays inside the brand.
     - L807-817, the final "every priced fixture item ends on the rule" check: add an exclusion for `iid(1,3)`, and for Z's C1 link if the fixture has one. Otherwise that check fails once Z is no longer re-derived.
     - Recommended: add one assertion for the attack itself. Plant a brand-2 unpriced row with cost `999999.999999` on a brand-1 catalog row, then have the brand-1 admin lower its pieces. The PATCH must succeed (`lives_ok`) and the planted row must be untouched. Update `plan(59)` to match.
   - **Spec text** (developer or architect; not this role): R1's "every `inventory_items` row with that `catalog_id`" becomes "…at a store of the catalog's brand". Update D-4's last side-effect bullet, the D-12 "Cross-brand rows" risk and AC-6. This matches the owner's intent ("every store of the catalog's brand", R1 bullet 3), so it narrows the contract, not the user-visible behavior. FU-3 is still the root-cause fix (see Out of scope).
   - After this fix, a cross-brand row is never re-derived by R1, but `list_cost_drift()` run as `postgres` can still list it as `drift` (M-2). The M-2(a) runbook note in R-4 below still applies.
2. **Fix or annotate the stale `receive_purchase_order` comments.** Severity: Should-fix per code-reviewer, Minor per architect. Effort: comment-only.
   - The reviewers disagree on the approach. Code-reviewer prefers fixing the comment in the re-created body. The architect prefers keeping the body verbatim and adding a header sentence.
   - Recommendation, which satisfies both: keep the verbatim body, add a one-line `-- NOTE (spec 207): superseded; per_each_cost guards <= 0 and rounds` next to L493-496, and add the architect's sentence to the "SOURCE DISCIPLINE" header (L78-88). Update the header's "ONE changed line" statement to "one changed line plus one NOTE comment".
   - The comment is inside the function body, so the D-11 md5 verification has to use this final text. Do it now, in the same edit as fix 1.
   - Optional nit, same edit: code-reviewer's request to inline the runbook in the PROD APPLY header (L90-97) so it doesn't depend on the spec's "D-11" label. This is outside any function body and has no md5 effect.
3. **S-1: restore the NULL-means-skip pin in `apply_item_scalars_to_brand.test.sql`.** Severity: Should-fix (AC-12 says "not weakened"). Code-reviewer and architect both raised it. Effort: test-only.
   - Add an unpriced row (`case_price 0`, `cost_per_unit 3.33`) and assert it still reads 3.33 after the `(…, 7, null, null)` call.
   - Prefer the architect's second option, a separate fresh catalog row and its own NULL-skip call, so the `updated_count` / `skipped_count` assertions (3)-(5) don't change.
   - Keep (15) as the priced-row pin, but retitle it so it no longer claims to test NULL-skip.
4. **Optional nits, fold in only if they cost nothing.** None blocks ship.
   - Parenthesise the AC-11 `and`/`or` boolean (test L375-379).
   - Add C20 to the fixture legend (test L25-33).
   - Rename the jest describe that claims "per_each_cost parity" (`perEachCost.spec207.test.ts:48-52`).
   - M-3: one re-point assertion per table.
   - The R1 repeated-expression refactor (code-reviewer nit) touches the R1 body. It is optional, and if done it must land in the same edit as fix 1, before the apply. I recommend skipping it: the design's shape used the repeated form and the tests pin its behavior.
5. **Re-run the gates after the fixes:** full `bash scripts/test-db.sh`, full `npx jest`, `npm run typecheck:test`, and `npm run typecheck` (rely on CI for that one, given the local `@types/* 2` artifact). Because fix 1 changes the plan count, check for "Looks like you planned N" failures.

### Release steps (after the fixes are green; owner-gated)

- **R-1. Pre-flight CI check.** `gh run list --branch main --workflow test.yml --limit 1` and `--workflow db-migrations-applied.yml --limit 1`. Both must be green. If not, stop and surface the run URL.
- **R-2. Re-review (light).** The security-auditor confirms the Medium is closed by the brand predicate and the flipped AC-6. Test-engineer re-confirms the counts. This is a delta check, not a full re-review.
- **R-3. Stage the 207 files only (M-5).** Stage with a temporary `GIT_INDEX_FILE` (the shared-index technique in project memory) so the unrelated `app.json`, `CLAUDE.md`, `.claude/agents/*` and spec 181 changes stay out. The 207 set:
  - the migration;
  - the two new pgTAP files;
  - the seven edited pgTAP files;
  - `src/utils/perEachCost.spec207.test.ts`;
  - the spec;
  - the `specs/207-recompute-costs-on-unit-change/` folder (undo JSON and reviews).
  - Test the exported tree. Do not commit until the user says so.
- **R-4. Prod apply per D-11 (Supabase MCP, project `ebwnovzzkwhsdxkpyjka`), immediately before the push.**
  - Step 1: read-only pre-checks. Confirm the `receive_purchase_order` md5 matches local 20260707000000. Run the inline drift baseline. If the baseline is not 0, apply M-2(a) first: check `stores.brand_id <> catalog_ingredients.brand_id` on the flagged rows. Stop and report to the owner only if real same-brand drift remains.
  - Step 2: `execute_sql` the final migration text verbatim, with `insert into supabase_migrations.schema_migrations` for version `20261123130000` placed just before `commit;`. Do not use `apply_migration`.
  - Step 3: verify md5, `prosecdef`/`proconfig`/owner, triggers and privileges against the post-fix local text.
  - Step 4: run AC-13 (`select kind, count(*) from public.list_cost_drift() group by kind`) and record both counts under `## Rollout notes` in the spec.
  - Step 5 (the optional rolled-back behavioral check) is the owner's call.
  - Keep the D-11 undo-file caveat on record: after this migration, an undo of the 2026-11-23 repair must disable `zz_derive_cost_per_unit_trg` inside its transaction.
- **R-5. Commit and push** on the user's explicit go-ahead. Then confirm the latest runs of both `test.yml` and `db-migrations-applied.yml` on `main` are green, and check `e2e.yml` by hand (M-4: this run is the e2e evidence, because CI's seed load now rewrites about 470 priced rows through R3).

## Out of scope for this review
- **FU-1.** An editor Save zeroes an unpriced row's cost at the edited store, overwriting the OQ-2 scaled value there. This is pre-existing spec 104 editor behavior.
- **FU-2.** The CSV import preview still shows a `last_cost` change that R3 ignores on priced rows (owner-accepted OQ-1 effect).
- **FU-3.** Enforce `stores.brand_id = catalog_ingredients.brand_id` on `inventory_items` insert. This is the root cause of the security Medium, the M-2 writer-dependent derivation, and the pwa-catalog pieces exposure. Fix 1 only contains the R1 symptom. The security auditor and architect (M-2b) both ask to raise its priority, so it should be the next spec.
- **Overflow failure mode for same-brand plants.** After fix 1, a same-brand staff member can still plant an extreme unpriced cost, and a later pack-size edit then fails with 22003. The admin can see that row and fix it (Low). A clearer toast mapping for 22003 in the `db.updateInventoryItem` error path would be a client follow-up.
- **The local `node_modules/@types/<name> 2` duplicate folders** that break `npm run typecheck` locally. Environment cleanup, not this spec.
- **The unrelated working-tree changes** (`app.json` identity, `CLAUDE.md`, `.claude/agents/*`, spec 181 files). They belong to their own commit(s). The app identity values must not change without explicit owner approval.
