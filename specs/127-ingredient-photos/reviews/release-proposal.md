# Release proposal — spec 127 (ingredient photos)

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical, and the sole blocking coverage gap plus the two graded fixes were all resolved after review; only accepted Minors/Nits and a documented post-ship prod-apply remain.

## Findings summary
- **code-reviewer**: 0 Critical, 1 Should-fix, 5 Nits. Top issue — stale `previousPath` docstring/`it()` title in `IngredientPhotoControl.test.tsx` (Should-fix) → **RESOLVED** (docstring + test title corrected to the shipped 3-arg signature). Nits (`#000` literal on accent = tracked backlog, JSX indentation in EODCount, no empty-id early-return in db.ts helpers, native-branch test gap) all non-blocking; the 7-point focus-area assessment came back clean (sequencing, migration idempotency, downscale, thumb placeholder, web-gating, optimistic-revert, projection all correct).
- **security-auditor**: 0 Critical, 0 High, 0 Medium, 3 Low. Write RLS confirmed correct and fail-safe. Low #1 (public SELECT policy allowed anon cross-tenant `list()` enumeration) → **RESOLVED**: SELECT scoped to `auth_is_privileged() AND auth_can_see_brand((foldername)[1])`, bucket stays `public=true` so CDN image display is unaffected; pgTAP updated. Low #2 (assert RLS enabled on `storage.objects`) → deferred to prod-apply checklist. Low #3 (benign super_admin root-path hygiene) → no action, not reachable by any non-super_admin caller.
- **test-engineer**: 7 ACs PASS; 1 **blocking** coverage gap (AC6 — `db.ts uploadIngredientImage`/`removeIngredientImage` sequencing + orphan-cleanup untested) → **RESOLVED** via new `src/lib/db.uploadIngredientImage.test.ts` (7 tests: happy-path ordering, delete-old, column-update-failure → orphan cleanup, upload-fail-no-write, removeIngredientImage). Named-accepted non-blocking gap AC7 (pgTAP is structural, not behavioral impersonation — underlying `auth_is_privileged`/`auth_can_see_brand` predicates proven elsewhere). Minor non-blocking gaps: AC2 native view-only branch, AC8 populated-fixture depth, AC9 brand-wide sharing, AC1 add-vs-edit gating. Everything that exists passes; no failing tests.
- **backend-architect**: 0 Critical, 0 Should-fix, 5 Minor (all accepted deviations/confirmations). Migration, uuid-per-upload path scheme, helper sequencing, `image_path` projection completeness, resolver, and frontend all match the contract; no realtime/publication change; version slot `20260721000000` has no collision.

## Recommended next steps (ordered)
SHIP_READY:
1. Commit and (per project rule) let the user confirm the commit.
2. **Required before feature is live — main Claude, post-ship**: apply migration `20260721000000_ingredient_photos.sql` to prod via MCP `execute_sql` (idempotent: `image_path` column + PUBLIC `ingredient-images` bucket + 4 `storage.objects` policies), then insert the exact version into `schema_migrations`. No edge redeploy needed.
3. **Required post-apply verification**: confirm the bucket exists and is `public=true`, the 4 `storage.objects` policies exist, and RLS is enabled on `storage.objects` (`select relrowsecurity from pg_class where oid = 'storage.objects'::regclass` = true — closes security Low #2).
4. **After push to `main`**: confirm the latest run of BOTH gates — `test.yml` and `db-migrations-applied.yml` — is green before further pipeline work (the `db-migrations-applied` gate hard-fails until step 2's version is in prod's `schema_migrations`).
5. (optional, non-blocking follow-ups) native admin view-only branch test (AC2); populated-`image_path` fixtures in EODCount/WeeklyCount suites (AC8); brand-wide sharing test (AC9); `#000`-on-accent backlog sweep.

## Out of scope for this review
- `#000`-on-accent color-literal sweep — existing tracked cleanup backlog item across ~10 `src/components/cmd/*` files, not a spec-127 regression.
- Behavioral `storage.objects` RLS impersonation harness (AC7) — deferred by design; belongs to a future storage-test-infra effort, not this spec.
