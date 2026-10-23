## Verdict
verdict: SHIP_READY
rationale: All four reviewers report 0 Critical. All 11 acceptance criteria pass. Full jest and both typechecks are green. Both CI gates on the base commit `f7b2759` are green. The one Should-fix is about owner awareness and needs no code change.

## Findings summary
- **code-reviewer:** 0 Critical, 0 Should-fix, 7 Nits (2 of them are out-of-scope notes).
  - The code implements D1-D6 as designed, with no bugs.
  - The check order is correct (lookup error, then catalog_id, then UPDATE error, then 0 rows).
  - Both D3 strings match byte for byte.
  - No new `supabase.from/rpc` calls outside `db.ts`. `useStore.ts` is unchanged.
  - The Nits are comment wording (db.ts:487-492, 504-506), duplicated test arrangements (`FAILURE_CASES` and the individual `it`s), the AC-4 test using `toEqual` where `toContainEqual` would do, and a cosmetic snapshot lookup in the store test.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low (both informational).
  - The RLS-denial detection is correct against `privileged_update_catalog_ingredients`.
  - It was verified live with BEGIN…ROLLBACK: admin and master get 1 row, and the `user`-role manager gets 0 rows with no error.
  - `.select('id')` cannot falsely fail a permitted updater. The SELECT policy `auth_can_see_brand` is a superset of UPDATE USING, and `brand_id` is never in the write allowlist.
  - Low 1: raw PostgREST messages (PGRST116, 23514/23505 constraint names) reach the toast `text2`. They expose only schema and constraint names. `details`/`hint` are not rendered, and the per-store path already behaves this way.
  - Low 2 (pre-existing): the `'Item edit'` audit event fires even when the save fails.
- **test-engineer:** 11/11 AC PASS, 0 FAIL, 0 NOT TESTED.
  - Targeted run: 4 suites / 33 tests. Full run: 257 suites / 3194 tests green. `typecheck` and `typecheck:test` are clean.
  - Reasoned red-on-old: AC-1 to AC-5 would fail at HEAD, and AC-7/AC-8 pin unchanged behavior.
  - Residual risk: the RLS `[]` shape was verified only against mocks. The main session's local-DB probe and the security-auditor's live probe have since closed this risk (see below).
- **backend-architect (post-impl):** no contract drift, 0 Critical, 1 Should-fix (a gap in the design's risk statement, not in the code), 3 Minor.
  - S1: the drawer always sends catalog fields, so the blast radius is larger than D7 describes (see owner notes).
  - M1: the CSV import is a second `updateItem` caller with catalog fields.
  - M2: the AC-4 test pins that `select('id')` was called, not its position in the chain.
  - M3: the claim that `notifyBackendError` is "module-local" is inaccurate in D6 and the test header (it is exported). Cosmetic; the test approach is still correct.

### Facts from the dispatching session (not in the reviewer files)
- CI gates on `main` at `f7b2759` (the base of this staged change):
  - `test.yml` run 40017908117: success.
  - `db-migrations-applied.yml` run 40017907876: success.
- Main session's local-DB probe (BEGIN…ROLLBACK, `authenticated` role plus JWT claims): `UPDATE catalog_ingredients … RETURNING id` returns 0 rows and no error for the `user`-role profile, and 1 row for admin. The 0-row detection works, and permitted updaters do not false-fail. This independently matches the security-auditor's probe.
- No migration is in this change, so no prod `db push` is needed. It ships with the next web deploy.

## Recommended next steps (ordered)
1. **Commit the staged change, then deploy.** The owner runs the commit; nothing is auto-committed. The staged set is:
   - `src/lib/db.ts`
   - `src/lib/db.eodCountMode.test.ts`
   - the two `*.spec173.test.ts` files
   - the spec
   - this `reviews/` directory, which is still untracked (`??`) and must be `git add`ed if you want the reviews in the commit
2. **After the push, check both CI gates on `main`** (`test.yml` and `db-migrations-applied.yml`) per the CLAUDE.md rule. Also check `e2e.yml` by hand until it is promoted into the gate checklist.
3. **(Optional, before or right after deploy) Read-only prod check for architect S1's exposure:**
   ```sql
   select p.id, p.email, p.role, u.raw_app_meta_data->>'role' as jwt_role
   from public.profiles p
   join auth.users u on u.id = p.id
   where p.role in ('admin','master')
     and coalesce(u.raw_app_meta_data->>'role','') not in ('admin','master');
   ```
   Zero rows means the "every drawer save reverts" exposure is theoretical for the profile-to-JWT drift case. Any rows are users who will start seeing toasts on every ingredient-drawer save. Fix their `app_metadata.role` rather than the code. This check does not cover the second exposed group, privileged users who fail `auth_can_see_brand` for an item's catalog row.

### Owner notes: behavior changes to expect
- **S1 (architect Should-fix): every drawer save can now revert.** `IngredientFormDrawer.tsx:144-172` `toUpdates()` always sends `name`, `category`, `unit`, `caseQty`, `subUnitSize`, `subUnitUnit`, and `eodCountMode`, whether or not they changed. So every drawer save enters the catalog block.
  - For any Cmd-UI user who fails `privileged_update_catalog_ingredients`, **every** drawer save now reverts and toasts. That includes par-only, cost-only, and vendor-link-only edits, which used to land because only the catalog half was silently dropped.
  - Who is exposed:
    - `admin`/`master` profiles whose JWT `app_metadata.role` is missing or stale;
    - privileged users who fail `auth_can_see_brand` for the item's catalog row.
  - This is intended under AC-5 ("no half-write"), but it is a larger UX change than D7 states. Expect "my edit now errors" reports from those users.
  - A possible follow-up spec would make the drawer send diff-only catalog fields, so per-store-only edits skip the catalog block.
- **M1: CSV import.** `csvImport.ts:481` calls `updateItem` for each row, with a diff-only payload. For rows whose `name`/`category`/`unit`/`caseQty` changed, a catalog failure now has three effects:
  - it also drops that row's per-store `costPerUnit`/`parLevel` changes;
  - it fires one toast per failed row;
  - the importer still counts the row in `updated++` (a fire-and-forget over-count that predates this spec).
  - Candidate follow-up: have the importer await each row and tally the real outcomes.

### Nits: apply now or defer?
**Recommendation: defer all of them. Commit as staged.**
- None of the Nits changes behavior. Applying any of them would mean re-running full jest and re-staging, which is not worth it for cosmetic edits.
- I re-read the comment at db.ts:487-492. It is a little redundant but accurate and readable. The spec-173 lines carry the "why".
- The two test-assertion Nits pull in opposite directions:
  - code-reviewer wants a looser `toContainEqual` on the AC-4 `select` op;
  - architect M2 wants a stricter op-sequence pin `['update','eq','select','abortSignal']`.
  - Both are defensible, so neither should be applied unilaterally. If a fifth catalog failure mode is ever added, settle the AC-4 assertion style and add the `FAILURE_CASES` cross-reference comment then.

## Out of scope for this review
These are candidate follow-up specs:
- **Reverse partial write:** the catalog write succeeds, a later per-store or `item_vendors` write fails, and the UI reverts the whole item. Fixing this needs a split revert or a transactional RPC (spec "Out of scope").
- **Audit event fires on failed saves:** `useStore.ts:2317` records `'Item edit'` with the attempted payload even when the DB refused the write. Flagged by code-reviewer, security-auditor (Low), and spec D7. This is an audit-integrity gap.
- **Drawer sends unchanged catalog fields** (architect S1): make `toUpdates()` diff-only so per-store edits never touch `catalog_ingredients`.
- **CSV importer outcome tallying** (architect M1).
- **Friendly copy for known PostgREST codes** (23505, 23514, PGRST116) instead of raw messages in the toast (security-auditor Low).
- **Other unchecked writes in `db.ts`,** including the `vendor_id` lookup at db.ts:564-570 in this same function, and the pre-existing `id.length < 10` silent early return.
- **Pre-existing `catalogUpdates: any` / `perStore: any` typing** at db.ts:471.
