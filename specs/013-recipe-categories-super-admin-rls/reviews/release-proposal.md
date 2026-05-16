# Release proposal — Spec 013 (refreshed)

Refreshed proposal on the amended spec (Status: READY_FOR_REVIEW). The previous proposal at this path was FIXES_NEEDED, driven by (a) test-engineer flagging AC9 as an untestable UI probe and (b) security-auditor's Low documentation drift on a non-existent `brand_id` column. The spec was amended on the same body: AC9 (line 34) now explicitly defers UI verification per CLAUDE.md "Legacy admin screens"; the `brand_id` references at lines 31 and 67 were removed and replaced with the accurate `(id, name, created_at)` schema description. All four reviewers were re-run on the amended state. This proposal supersedes the prior one.

## Verdict
verdict: SHIP_READY
rationale: All four refreshed reviews report zero Critical / High / Should-fix / Medium / Low / Minor findings; the prior Critical (test-engineer, AC9) and prior Low (security-auditor, `brand_id` doc drift) are both resolved, and AC6-AC8 are now covered by a live pgTAP test rather than implementer-reported one-shot probes.

## Findings summary

- **code-reviewer**: 0 Critical, 0 Should-fix, 1 Nit. The lone Nit observes that the `drop policy if exists` / `create policy` pair is not wrapped in an explicit `BEGIN; ... COMMIT;` block — but it is consistent with the prior-art `20260510020000_order_schedule_super_admin_rls.sql`, so it is a project pattern rather than a local deviation; reviewer says "no action required". Header comment block judged above the quality bar. No application-code, store-slice, or legacy-file findings.

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 0 Low. Strict-superset truth table re-verified against the unchanged migration; admin/master/super_admin all pass, plain user / NULL JWT all fail. All helpers in the call graph (`auth_is_admin`, `auth_is_super_admin`, `auth_is_privileged`) confirmed SECURITY DEFINER with locked `search_path = public, auth`. The `auth_is_super_admin()` profile probe is not a client-exploitable privilege-escalation vector — promotion to `super_admin` requires an existing super-admin (`super_admin_manage_profiles` gates role-changing UPDATEs) or out-of-band bootstrap. Prior Low (doc drift on `brand_id` at spec lines 31 / 67) explicitly cleared by the amendments. No `package.json` change — `npm audit` skipped.

- **test-engineer**: 8/9 ACs PASS, 1 DEFERRED. AC1-AC5 verified by static analysis of the migration file plus live policy dump. AC6-AC8 verified by live pgTAP execution against `supabase_db_imr-inventory` (5 assertions, all `ok`, runnable via `bash scripts/test-db.sh supabase/tests/recipe_categories_super_admin_rls.test.sql`). AC9 deferred and explicitly judged acceptable per CLAUDE.md frozen-legacy policy — the recipe-category CRUD surface exists only in `src/screens/AdminScreens.tsx` (must not be extended) with no Cmd UI equivalent. AC6 deliberately constructs a JWT carrying `app_metadata.role='user'` while the profiles row is promoted to `super_admin`, proving the passing path is `auth_is_super_admin()` (profiles-based) rather than `auth_is_admin()` (JWT-based); AC8b exercises the orthogonal JWT-based `master` path. Prior Critical cleared. Acceptance-criteria coverage: 8 verified (AC1-AC8), 1 deferred/acceptable (AC9).

- **backend-architect** (post-impl, re-review): 0 Critical, 0 Should-fix, 0 Minor. Line-by-line drift check against the amended design contract — all 12 design requirements pass. Implementation lands the contract with zero deviation: single `drop policy if exists` + `create policy` against `public.recipe_categories` only, SELECT policy untouched, no scope creep, no helper churn, no grants, strict superset of prior permissions. Global-vs-brand-scoped framing now accurate (no `brand_id` column; helper without brand argument is the correct shape, as opposed to the `auth_can_see_brand(brand_id)` pattern used by per-brand tables). Filename slot `20260510030000_*` correctly slotted after dependency `20260509000000_*` and sibling `20260510020000_*`.

## Artifacts to stage with the commit

The pgTAP test file written during this re-review is uncommitted and should be staged alongside the migration when the user commits the SHIP_READY tag:

- `supabase/tests/recipe_categories_super_admin_rls.test.sql` — new permanent hermetic pgTAP test (5 assertions covering AC6, AC7, AC8a, AC8b plus a fixture-setup assertion). Runs inside `begin; ... rollback;` so the seed is untouched. Peer of `supabase/tests/invitations_super_admin_rls.test.sql`; follows the same fixture pattern (reuses the seeded master user's UUID, promotes via `UPDATE profiles` inside the transaction, rolls back). Runnable via `npm run test:db` (Spec 022 Track 2).

The migration file (`supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`) and the amended spec (`specs/013-recipe-categories-super-admin-rls.md`) are already on disk and will be staged in the same commit.

## Recommended next steps (ordered)

1. **Commit and deploy.** Stage the migration, the amended spec, and the new pgTAP test file in a single commit. Suggested message shape: `Spec 013: recipe_categories super-admin RLS fix + pgTAP coverage (SHIP_READY)`.
2. **Deploy via the normal Supabase migration path.** RLS-only change — no realtime restart, no edge-function redeploy, no `src/lib/db.ts` update, no `useStore.ts` change. The `docker restart supabase_realtime_imr-inventory` gotcha does not apply.
3. **(Optional, non-blocking follow-up)** If the project decides to standardise on explicit `BEGIN; ... COMMIT;` wrappers in migrations, retrofit this file and `20260510020000_order_schedule_super_admin_rls.sql` together — they share the same pattern. Track separately; not a blocker for this ship.

## Out of scope for this review

- A Cmd UI surface for recipe-category CRUD (would unblock a true end-to-end UI probe but is explicitly out of scope per the spec's "Out of scope" clause and AC9's deferred wording). If/when built, it must be exercised end-to-end at that time.
- The remaining tables flagged by the 012a audit comment that still need super-admin RLS parity — each is a separate follow-up spec, on demand.
- Refactoring the `profiles_sync_role` trigger or the `app_metadata` shape (explicitly listed under "Out of scope" in the spec).
- Changes to the helper functions (`auth_is_admin`, `auth_is_super_admin`, `auth_is_privileged`) — correct, hardened, and out of scope.

## Handoff
next_agent: NONE
prompt: SHIP_READY. Stage `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`, `specs/013-recipe-categories-super-admin-rls.md`, and the new `supabase/tests/recipe_categories_super_admin_rls.test.sql` together when committing.
payload_paths:
  - specs/013-recipe-categories-super-admin-rls/reviews/release-proposal.md
