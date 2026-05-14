# Architectural drift review for Spec 026

Post-impl review against the `## Architect design` section of
`specs/026-post-025-cleanup/spec.md`. This spec was a three-track
cleanup (RLS broadening, doc rot, devDep removal) so the architectural
surface is small; nevertheless the design specified several load-bearing
details (migration filename, policy names byte-for-byte, plan(4) and the
fixture approach for the test, Q5 frozen-file collapse). Below are the
findings ranked Critical → Should-fix → Nits.

## Summary

- **0 Critical**
- **0 Should-fix** (all observations are coverage notes or nits)
- **2 Nits**

No release blocker. The implementation matches the design.

---

## Critical

None.

---

## Should-fix

None.

---

## Nits

### N1 — Hermetic-fixture approach changed from synthetic to seed-UID; explanation is sound but design called the toss the other way

`supabase/tests/invitations_super_admin_rls.test.sql:20-27` chooses
approach (1) from the architect's "Hermetic super_admin fixture" section
(reuse the seed master's `auth.users.id` and `UPDATE` its `profiles` row
inside the txn), not approach (2) (mint synthetic UUIDs and INSERT a
freestanding `profiles` row). The architect's design at
`specs/026-post-025-cleanup/spec.md:557-569` explicitly recommended
approach (2) ("synthetic UUIDs") and *also* documented caveat (b) at
`spec.md:583-588` authorising the fallback to approach (1) "if FK exists."

The dev verified the FK does exist
(`supabase/migrations/20260405000759_init_schema.sql:21` — `id uuid
primary key references auth.users(id) on delete cascade`) and switched to
approach (1) with an `UPDATE` (not `INSERT ... ON CONFLICT`, since the
seed already has the row). The file header at lines 20-27 of the test
documents the choice. This is the design's caveat-(b) escape valve being
exercised correctly; the deviation is sound. No fix needed.

### N2 — Test file uses `UPDATE` rather than the spec's `INSERT ... ON CONFLICT DO UPDATE`

The architect's caveat (b) wording (`spec.md:585`) phrased the fallback
as `INSERT ... ON CONFLICT (id) DO UPDATE SET role = 'super_admin'`. The
dev used a plain `UPDATE` (`supabase/tests/invitations_super_admin_rls.test.sql:52-54`).
This is *better* than the architect's wording because the seed master
row is guaranteed to exist (line 169 of `supabase/seed.sql`), so a plain
`UPDATE` is sufficient and clearer than the upsert. The architect's
phrasing would have worked too. Calling this out as a nit only because
the design's exact suggestion was not followed verbatim; the deviation
improves clarity.

---

## Coverage check against the design

The remainder of this review is the explicit checklist from the dispatching
prompt. None of the items below produce a finding; they are coverage notes
for the release-coordinator.

### 1. Migration filename and shape

- **Filename:** `supabase/migrations/20260514150000_invitations_super_admin_rls.sql` — matches the design's Q1 resolution at `spec.md:417`. Strict-monotonic ordering preserved (`20260514150000 > 20260514140000`).
- **Migration shape:** matches the design's pseudocode at `spec.md:460-480` byte-for-byte. Four `drop policy if exists` precede four `create policy`. Header comment block at lines 1-26 cites the three required references (original gate, helper introduction, prior art).
- **Policy names** (line 28-46 of the migration) match the originals at `supabase/migrations/20260424211733_security_fixes.sql:42-57` exactly: `"Admins can read invitations"`, `"Admins can insert invitations"`, `"Admins can update invitations"`, `"Admins can delete invitations"`. Byte-for-byte preservation confirmed.
- **All four policies** swap `((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))` for `public.auth_is_privileged()`. The UPDATE policy preserves both `using` and `with check` (line 41-44). SELECT/DELETE use `using` only; INSERT uses `with check` only — matches the original policy operation semantics.

### 2. pgTAP test plan and arms

- **`plan(4)`** declared at `supabase/tests/invitations_super_admin_rls.test.sql:32`. Four assertions present:
  - Line 46-47: fixture `isnt(...)` — design assertion 1.
  - Line 78-84: arm (i) admin JWT `is(... = 1, ...)` — design assertion 2.
  - Line 105-111: arm (ii) super_admin via profiles row `is(... = 1, ...)` — design assertion 3.
  - Line 128-138: arm (iii) plain user JWT `throws_ok(..., '42501', ...)` — design assertion 4.

  Plan and asserter count match exactly. The design at `spec.md:528-533` specified all four; all four landed.

- **JWT impersonation pattern.** `set local role authenticated;` set once at line 59, persists across the transaction. `set_config('request.jwt.claims', ...)` called separately for each arm. Same shape as the design template at `spec.md:617-672` and the comparator test `supabase/tests/eod_submissions_consistency.test.sql:72-82`.

- **Super_admin fixture isolation.** The JWT for arm (ii) carries `app_metadata.role = 'user'` (line 95) — intentionally NOT admin. This proves the super_admin code path triggers via `profiles.role` lookup inside `auth_is_super_admin()`, independent of the JWT. Matches the design's stated intent at `spec.md:649`.

- **Arm (iii) rejection isolation.** The JWT for the user arm carries `app_metadata.role = 'user'` (line 123) and the seeded manager's `profiles.role` is `'user'` (verified at `supabase/seed.sql:119`), so both `auth_is_admin()` (JWT check) and `auth_is_super_admin()` (profiles lookup) return false. `auth_is_privileged()` short-circuits to false → 42501. The test header at lines 113-117 documents this reasoning.

### 3. Pre-existing `profiles` schema check

The dispatcher prompt asked whether the dev "handled it correctly." Yes:

- The dev confirmed FK existence at `supabase/migrations/20260405000759_init_schema.sql:21` (`profiles.id uuid primary key references auth.users(id) on delete cascade`).
- Switched to the design's caveat-(b) approach: reuse the seed master's UUID and UPDATE its profile.
- The UPDATE flips both `role` and `brand_id` atomically (line 52-54) to satisfy the `profiles_role_brand_consistent` CHECK at `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:342-348` which requires `super_admin → brand_id IS NULL`. This is the design's caveat (a) handled correctly.

### 4. RLS strict-superset check

- **Old check** (per `supabase/migrations/20260424211733_security_fixes.sql:44`): `((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master']))`.
- **New check** (per `auth_is_privileged()` definition at `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`): `auth_is_admin() OR auth_is_super_admin()`.
- **`auth_is_admin()`** at `supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:23-27`: `coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = any (array['admin', 'master'])` — bit-for-bit equivalent of the old check.
- **`auth_is_super_admin()`** at `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:187-195`: `exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin')` — false for `auth.uid() IS NULL` (anon).

**Conclusion:** the OR of `auth_is_admin()` and `auth_is_super_admin()`:
- includes every caller the old check admitted (admin/master JWTs continue to pass via `auth_is_admin()`),
- additionally admits super_admin profiles rows,
- denies anon (both sub-helpers return false for null `auth.uid()`).

Strict superset. No new path opens for unprivileged roles.

### 5. Realtime / Edge functions

- **Realtime:** no change to `supabase_realtime` publication membership. `public.invitations` was not in the publication before this migration (verified against `supabase/migrations/20260514140000_realtime_publication_tighten.sql` — the explicit allowlist does not include `invitations`) and is not added by this migration. No `docker restart supabase_realtime_imr-inventory` step required. The realtime-publication gotcha is not triggered. Matches `spec.md:891-895`.
- **Edge functions:** none of the 10 edge functions read the invitations policies directly (they use service-role keys that bypass RLS). `send-invite-email`, `delete-user`, and the `staff-*` set are unchanged. Matches `spec.md:898-900`.

### 6. `grep -E 'json-server'` after Track C

Track C verification confirms zero matches outside historical specs and the
historical-tagged enforcement rule:

- `CLAUDE.md:199` — "Spec 026 then removed the orphaned `json-server` devDependency." — historical context, AC-compliant.
- `.claude/agents/code-reviewer.md:39` — "Reintroduction of json-server or `db.json` patterns in new code (both deleted in spec 025; re-introduction is Critical)." — active enforcement rule, AC-compliant.
- `package.json` — zero matches (verified).
- `package-lock.json` — zero matches (verified).
- All other matches are inside `specs/`, which is historical archive (AC C3 explicitly carves these out).

### 7. Q5 frozen-file list resolution

Design Q5 (`spec.md:421-432`) said the post-spec-025 frozen-file list
collapses to a single entry: the `app.json` slug. Verified across all 8
agent prompt files:

| File | Hard-rules / frozen-files section status |
|------|------------------------------------------|
| `.claude/agents/frontend-developer.md:69-73` | Single bullet: `app.json` slug. |
| `.claude/agents/backend-developer.md:30-36` | Single bullet: `app.json` slug. |
| `.claude/agents/backend-architect.md:45` | Single rule: `app.json` slug (collapsed into Rules block). |
| `.claude/agents/test-engineer.md:48-52` | Single bullet: `app.json` slug. |
| `.claude/agents/product-manager.md:31,76` | Two references both naming only `app.json` slug. |
| `.claude/agents/workflow-orchestrator.md:72` | Single rule: `app.json` slug. |
| `.claude/agents/workflow-auditor.md:30` | Single rule: `app.json` slug. |
| `.claude/agents/code-reviewer.md:36-37` | Two rules: (i) "deleted in spec 025" enumeration is *detection logic for reviewers* not a "do-not-modify" rule (line 36); (ii) explicit `app.json` slug rule (line 37). |

All eight collapse to the `app.json` slug rule as the single living
frozen-file constraint. The `code-reviewer.md:36` enumeration is acceptable
because it documents what re-creation looks like (an active reviewer
detection heuristic), not what to "not modify" — that nuance is captured in
the test-engineer.md review's S1.

### 8. Boundary violations

None observed:
- `src/components/cmd/InviteUserDrawer.tsx` and `src/screens/cmd/sections/UsersSection.tsx` not in `Files changed` — matches AC A6.
- `src/lib/db.ts`, `src/store/useStore.ts`, edge functions, `supabase/seed.sql` all untouched — matches AC A5 and the design's "no surface change" stance.
- CLAUDE.md edits do not touch the `app.json slug mismatch` section (lines 214-217), which the design explicitly required to be preserved (`spec.md:781-784`).
- No "while I was here" prose rewrites in CLAUDE.md or the agent prompts (AC B4 compliance). Spot checks of conventions, agent workflow, and resolved-questions sections show only the in-scope edits enumerated in the design.

### 9. Migration ordering and lexical sort

Confirmed `20260514150000_invitations_super_admin_rls.sql` sorts last in
`supabase/migrations/` (verified via Glob — the file is the last entry in
the alphabetical listing). No reorder gymnastics, no back-dating. Safe to
apply on new prod deployments which run in lexical order.

### 10. Pre-existing observations not introduced by spec 026

The test-engineer's Nit N2 about the migration count line in CLAUDE.md
(line 22 says "30 migrations, 2026-04-05 → 2026-05-05") is technically
out-of-date — the count is now 31 (or higher, since multiple migrations
post-2026-05-05 already exist) and the date range extends to 2026-05-14.
This was not in the doc-rot pass's enumerated AC B2 list, so the dev was
right to leave it. Surface as a follow-up doc-rot pass if the user wants
the count line normalized. Not a blocking finding for spec 026.

---

## Conclusion

The implementation matches the architect's design. The two deviations
worth noting are (a) the seed-UID-with-`UPDATE` fixture approach instead
of the synthetic-UUID-with-`INSERT` approach, which the design's caveat
(b) explicitly authorised when the FK exists (it does), and (b) using
plain `UPDATE` instead of `INSERT ... ON CONFLICT DO UPDATE`, which is
strictly clearer because the seed master row is guaranteed to exist.
Both deviations are improvements, not drift.

RLS is a strict superset of the prior policy. No new paths open for
unprivileged callers. No realtime, edge function, or
`src/lib/db.ts`/`useStore.ts` surface changes. The Q5 frozen-file list
collapse is consistent across all 8 agent prompts. Track C is fully
clean.

No blocker for release.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Nits.
payload_paths:
  - specs/026-post-025-cleanup/reviews/backend-architect.md
