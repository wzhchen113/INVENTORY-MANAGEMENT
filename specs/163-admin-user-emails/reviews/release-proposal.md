# Release proposal: spec 163 (admin user emails)

## Verdict
verdict: FIXES_NEEDED
rationale: security-auditor flagged a Critical. It is a pre-existing `profiles` INSERT policy hole that lets any signed-in user insert themselves as `super_admin`, and that `profiles.role` is the only thing the new email RPC trusts. The CLAUDE.md hard rule blocks SHIP_READY on any Critical, even though every reviewer judged the spec-163 diff itself correct.

Two more things block SHIP_READY:
- Rollout acceptance criteria AC-R1 and AC-R2 (prod migration, CI gates green on `main`) have not run yet.
- The CI status on `main` for `test.yml` and `db-migrations-applied.yml` was not checked during this synthesis. This agent cannot run `gh`, so the latest runs must be checked before any ship decision.

## Findings summary

- **code-reviewer:** 0 Critical, 2 Should-fix, 9 Nits. The data layer, precedence order, async fallback wrapper, single RPC call site and staged `UsersSection.tsx` all check out.
  - Should-fix: `src/lib/auth.ts:655-657` has a spec-163 comment sitting by itself, 28 lines away from the code it describes. Move it to the `email:` line at `:683`.
  - Should-fix: `src/lib/auth.ts:641-649` still calls invitations the main email source. Reword it to say they are the fallback.
  - Notable nits:
    - `db.ts:5479-5484` and `:5525-5531` comments are out of date.
    - `db.fetchBrandAdmins.test.ts:425` asserts `Toast.show` was not called, which can never fail because `db.ts` never imports Toast.
    - The `search_path` literal in pgTAP arm 3 depends on how Postgres formats it.
    - The `'(email not loaded)'` literal is not translated (out of scope).

- **security-auditor:** 1 Critical, 1 High, 0 Medium, 2 Low. **Both the Critical and the High predate spec 163.** The auditor's verdict on the spec-163 diff: "correct". The predicate, grants, `search_path`, input handling and client fallback are all verified.
  - **Critical (pre-existing):** the `profiles` INSERT policy `"Anyone can insert own profile or admin can insert any"` (`supabase/migrations/20260502071736_remote_schema.sql:399-404`) ends in `OR (auth.uid() IS NOT NULL)`. Any authenticated caller can therefore insert a profile with any `id`, `role` and `brand_id`.
    - The `AFTER INSERT` trigger `sync_role_to_app_metadata()` then copies that role into `auth.users.raw_app_meta_data`.
    - Reproduced locally (rolled back): an orphan auth user inserted itself as `super_admin`, and `get_profile_emails` then returned every email.
    - Who can reach it: anyone who can sign up with the public anon key; every invited user who has not registered yet (`registerInvitedUser` sends a client-chosen `role`, `src/lib/auth.ts:527-536`); and any customer-PWA auth user with no profile.
    - Impact: full takeover across brands. This is live in prod today whether or not spec 163 ships.
  - **High H1 (pre-existing, spec 053):** `supabase/tests/permissive_policy_lint.test.sql` uses `\b` in 8 regex literals. In Postgres regex syntax `\b` means backspace, not word boundary (that is `\y`). So the OR-tail detection has never matched anything, which is why the Critical survived specs 043, 051 and 053.
    - With the fix, the lint flags exactly one policy: the profiles INSERT policy above.
    - `supabase/tests/order_approvals.test.sql` also uses `\b` and should be checked.
  - **Low L1:** the function copies the policy predicate instead of inheriting it, so the two could drift. The auditor recommends a pgTAP parity check comparing `get_profile_emails(ids)` with an RLS-filtered `select id from profiles` under the same JWT.
  - **Low L2:** pgTAP arm 8 cannot tell whether super_admin visibility comes from `profiles.role` or the JWT. Add an arm where a `role='user'` profile carries JWT `app_metadata.role='super_admin'` and must get 0 rows.

- **test-engineer:** 22 PASS, 0 FAIL, 2 NOT TESTED. The two not tested are AC-R1 (prod MCP apply) and AC-R2 (both CI gates green after the push). These are rollout gates, not code defects.
  - Runs: full `npx jest` passed (219 suites, 2523 tests), both typecheck gates passed, and `scripts/test-db.sh` passed 86/86, including `get_profile_emails.test.sql` 18/18.
  - **The reviewer added a new file**, `src/screens/cmd/sections/__tests__/UsersSection.identityLine.spec163.test.tsx` (4 render tests for AC-U1 and AC-U2). It is not staged or committed. Including it in the commit is the user's call.
  - Non-blocking gap: the Brands members tab has no render test.
  - Non-blocking gap: no browser or native UI check has been done yet.

- **backend-architect (post-impl):** 0 Critical, 1 Should-fix, 4 Minor. **No contract drift**: every item in §0-§11 of the design matches.
  - **S1:** the mandatory rollout steps are still open and must happen before the push.
    - Apply to prod via MCP first, or `db-migrations-applied.yml` goes red.
    - The in-browser check is the only positive proof the RPC works in prod, because the fallback hides failures and MCP has no JWT.
    - Also confirm `pg_proc.proowner` is `postgres`.
  - **M1:** the function body contains U+2026 (`…`) in its inline comments. Those bytes feed the normalized-md5 rollout check, so a transport or encoding difference could cause a false mismatch. Switch to ASCII `...` **before** the prod apply.
  - **M2:** the `db.ts:5479-5483` comment still calls invitations the email source. This is the same issue as code-reviewer's nit.
  - **M3:** no pgTAP arm covers the `coalesce(u.email,'') <> ''` blank-email filter.
  - **M4:** no direct unit test for `fetchProfileEmails` covering dedupe and skipping blank emails.

## Recommended next steps (ordered)

### Sequencing decision: separate security spec, landed first (recommended)

Handle the Critical and H1 in a **new, separate security spec that lands before spec 163's prod rollout**, rather than folding them into 163. Reasons:

1. **Different scope and blast radius.** The fix rewrites the `profiles` INSERT policy, moves invited-user profile creation into a server-side SECURITY DEFINER RPC (or extends `consume_invitation`), adds a `BEFORE INSERT` role guard trigger, and changes the registration path in `registerInvitedUser`. That needs its own PM/architect design, its own pgTAP, and its own security review. Folding it into a read-only email feature would hide a security change inside an unrelated diff.
2. **The spec-163 diff needs no change to fix it.** Every reviewer verified the 163 code. Keeping it separate preserves that clean review.
3. **The Critical and H1 must ship together.** Correcting the lint regex (`\b` to `\y`) turns the lint red on the current profiles INSERT policy right away. So the lint fix and the policy fix belong in the same PR, which is a natural boundary for one security spec.
4. **Order matters.** Spec 163 adds a new PII reader whose only trust anchor is `profiles.role`. Closing the forgery path first means 163 never ships on top of a known-forgeable gate.

Be clear about what holding 163 does and does not do. **Holding 163 does not close the hole.** The privilege escalation is live in prod now. A forged super_admin can already reach everything, including other users' emails via `preview_brand_cascade`. So 163 adds little extra exposure, and the security spec is urgent on its own merits.

If the user decides to roll out 163 before the security spec anyway, that is the user's call. It should be written down as an explicit risk acceptance (the auditor asks for this), and the security spec should still start immediately.

**Working-tree note:** the security spec will edit `src/lib/auth.ts` (`registerInvitedUser`, around lines 502-536). Spec 163's uncommitted changes are in the same file (`fetchAllUsers`, around lines 596-690). The regions don't overlap, so conflicts are unlikely. To keep the two commits separate, the user may want to commit 163 **locally (no push)** before security-spec work starts. That commit must not be pushed until the 163 migration is in prod (step 5).

### Fix list

1. **Urgent, read-only prod triage (Critical; first because it may reveal live exploitation).** The owner runs these against prod (`ebwnovzzkwhsdxkpyjka`) or authorizes them via MCP:
   - `select id, role, brand_id, created_at from profiles where role in ('super_admin','admin','master') order by created_at;` and look for unexpected rows.
   - Compare `auth.users.raw_app_meta_data->>'role'` with `profiles.role` and look for drift.
   - `select with_check from pg_policies where tablename='profiles' and cmd='INSERT';` to confirm the live policy text.

   If anything unexpected shows up, treat it as an incident before any further pipeline work.

2. **New security spec covering the Critical and High H1 (product-manager, then the normal pipeline). Lands and goes to prod before 163's rollout.** Scope, per the auditor:
   - Replace the profiles INSERT `WITH CHECK` with `(id = auth.uid() and role = 'user' and brand_id is null) OR (auth_is_privileged() and auth_can_see_brand(brand_id))`, with no `auth.uid() IS NOT NULL` tail.
   - Move invited-registration profile creation server-side, so `role`, `brand_id` and `username` come from the invitation row (keyed on `auth.email()`). Stop accepting a role chosen by the client in `registerInvitedUser`.
   - Add a `BEFORE INSERT` trigger that rejects `role <> 'user'` for `authenticated`/`anon` callers that are not super_admin.
   - Change `\b` to `\y` in all 8 regex literals in `permissive_policy_lint.test.sql`. Add a positive OR-tail fixture arm that must be flagged. Check `order_approvals.test.sql` for the same bug.
   - Run its own MCP prod apply and CI-gate check per CLAUDE.md.

3. **Spec 163 pre-rollout touch-ups (Should-fix; must happen before the 163 prod apply, because M1 changes the function body the md5 check compares).** Send to backend-developer:
   - M1: replace U+2026 with ASCII `...` inside the `$$` body of `20261008000000_get_profile_emails.sql`.
   - code-reviewer Should-fix: move the spec-163 pointer comment from `src/lib/auth.ts:655-657` to the `email:` line at `:683`, and reword the lead-in at `:641-649`.
   - M2 / code-reviewer nits: update the comments at `src/lib/db.ts:5479-5484` and `:5525-5531` to say invitations are the fallback.
   - Re-run full `npx jest`, `npm run typecheck`, `npm run typecheck:test` and `scripts/test-db.sh` afterwards.

4. **Optional pgTAP and jest hardening for 163 (Low/Minor; cheap now because the files are not committed yet).** Doing these changes `plan(18)`, so the plan count must be updated:
   - L2: an arm proving super_admin visibility comes from `profiles.role`, not the JWT.
   - M3: an arm proving a blank or NULL `auth.users.email` returns no row.
   - L1: a parity arm against the RLS-filtered `profiles` SELECT.
   - M4: a direct `fetchProfileEmails` unit test.
   - Drop the vacuous `Toast.show` assertion in `db.fetchBrandAdmins.test.ts:425`.

   These can be deferred to a follow-up if the user prefers a smaller diff.

5. **Spec 163 prod rollout (needs user approval; it has not happened). Run in this order, after step 2's security spec is in prod:**
   1. **Apply the migration to prod via Supabase MCP before anything is pushed to `main`:**
      - Run `execute_sql` with the exact migration body.
      - Insert version `20261008000000`, name `get_profile_emails`, into `supabase_migrations.schema_migrations`.
      - Run the normalized-md5 check of `pg_get_functiondef('public.get_profile_emails(uuid[])'::regprocedure)` against the repo body.
      - Confirm `has_function_privilege('anon', 'public.get_profile_emails(uuid[])', 'EXECUTE') = false`.
      - Confirm `proowner` is `postgres`.
      - If the first client call returns `PGRST202`, run `notify pgrst, 'reload schema';` once.
      - Do not read an empty MCP result as success or failure. MCP has no JWT, so 0 rows is the correct result there.
   2. **The user commits and pushes to `main`.** Main Claude does not auto-commit. The commit decision includes the staged `UsersSection.tsx` change and test-engineer's new `UsersSection.identityLine.spec163.test.tsx`.
   3. **Browser-verify in prod** once Vercel has deployed the new client. Before that, the prod web app is still running the old invitation-only code, which is why this step comes after the push.
      - Sign in as a prod admin, open Users & access, and confirm that "Towson Staff" (and "Charles Staff" / "Frederick Staff") show `@username · <real email> · <shortId>`.
      - Confirm the Brands members tab shows real emails instead of "(email not loaded)".
      - This is the only positive evidence the RPC works in prod, because the fallback hides failures.
   4. **Check both CI gates on `main`** with `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`. Both must be green. Per project memory, also check `e2e.yml` manually. If either gate is red or still running, surface the run URL and wait for the user.

6. **Re-run release-coordinator once steps 2-5 are done** (or once the user records a risk acceptance for the Critical). At that point a SHIP_READY verdict for 163 is reachable: there is no 163-specific blocker left beyond the rollout gates.

## Out of scope for this review

- **The profiles INSERT privilege escalation and the dead lint regex** (security-auditor Critical and H1). They predate 163 and belong in the separate security spec from step 2, not in spec 163.
- **The hardcoded `'(email not loaded)'` literal** in `UsersSection.tsx:376` and `BrandsSection.tsx:972`. The spec says to leave that line unchanged. It's a candidate for the pending i18n pass.
- **Local `supabase_migrations.schema_migrations` drift.** `20260819000000`, `20260829000000`, `20260829000100` and `20261008000000` were applied locally with `psql -f` and never recorded, so `npx supabase migration up` can't be used locally. This is dev-env cleanup, separate from this spec.
- **A Brands members tab render test** (test-engineer gap). Optional follow-up.
- **Extracting the duplicated `safeProfileEmails` wrapper.** The spec deliberately kept it inline. Revisit if a third consumer appears.
- **Removing the invitation-based email fallback.** Explicitly deferred until the RPC is proven in prod.
- **Removing the unused `brandId?` parameter of `fetchInvitationsForUserLookup`.** Unrelated tidy-up.
