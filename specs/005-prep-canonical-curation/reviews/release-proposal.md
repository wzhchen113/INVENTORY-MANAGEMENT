# Release proposal — Spec 005 (prep canonical curation)

_Note: this file was written by main Claude on the release-coordinator's behalf — the agent has no `Write` tool grant per its definition (`Tools: Read, Grep, Glob`), so it returned the proposal as a chat message instead. Content below is the agent's verbatim output. Workflow follow-up is filed as a separate task chip from spec 002._

---

## Verdict
verdict: SHIP_READY
rationale: All four reviewers reported 0 Critical and 0 High findings; the migration is a faithful implementation of the post-amendment-#3 design with all 11 acceptance criteria PASS on local, RLS-clean, and structurally idempotent — no Should-fix item blocks ship.

## Findings summary

- **code-reviewer**: 0 Critical / 1 Should-fix / 5 Nits. Top: per-name canonical sanity check uses an aggregate `count = 3` rather than a per-name `count = 1` guard (build-stop 5's letter); in practice protected by the partial unique index `prep_recipes_brand_name_current_unique` so the only theoretical hole is a degenerate state the index already prevents.
- **security-auditor**: 0 Critical / 0 High / 0 Medium / 1 Low / 1 Informational. RLS-clean: no policies, no roles, no grants, no secrets touched; pure data UPDATE on a brand-shared table whose RLS posture is invariant under name changes; all 16 affected rows are `is_current = false` so `pwa-catalog` payload is byte-identical pre/post. Low finding is an optional forensic audit-row recommendation, consistent with Spec 001 precedent of accepting destructive UPDATE without an audit row.
- **test-engineer**: 0 Critical / 3 Should-fix / 4 Nits. **11 of 11 ACs PASS**. Should-fix items: (S1) `## Remote drift investigation` placeholder section never populated — content lives in section 1 inline + build notes; (S2) migration not registered in `supabase_migrations.schema_migrations` after manual `docker exec ... psql` apply — fixable via `supabase migration repair --status applied 20260506000000`; (S3) post-apply protocol references `/tmp/spec003-probe.sql` without a self-contained inline definition or section pointer.
- **backend-architect (drift)**: 0 Critical / 0 Should-fix / 4 Minor. Implementation matches amendment-#3 design contract row-for-row (manifest, mechanic, expected counts, assertion pattern, idempotency, atomic transaction, target-canonical sanity check). All 4 Minor findings are spec-hygiene flags (stale design-text remnants, audit-trail callout density), not defects.

**Architect M4 — Spec 006 reference:** I verified directly. `specs/006-house-special-blend-sauce-drift.md` IS on disk (30+ lines, `Status: DRAFT`, header "House Special Blend (Sauce) — remote canonical drift cleanup"). It is untracked per `git status` (`?? specs/006-...`), which is likely why the architect's review tooling missed it — the architect ran their drift review during the same day's session and probably looked at tracked files only. **M4 is functionally resolved** — the seam the architect flagged (Spec 006 not bridged) is bridged. No action needed beyond noting this in the proposal.

## Recommended next steps (ordered)

Since SHIP_READY:

**Before commit (worth folding now — small, low-risk, improves audit trail):**

1. **test-engineer S2 — Run `supabase migration repair --status applied 20260506000000` against local.** Reconciles `supabase_migrations.schema_migrations` so `supabase migration list` and `supabase db diff` show a consistent state on local. Functionally, remote push will work fine without this (no-op path catches a re-apply), but the local-tracking divergence is real spec hygiene that costs ~5 seconds to fix. **Do this now.**

2. **test-engineer S1 — Fill in the empty `## Remote drift investigation` section.** Two sentences from section 1 + build notes is enough: "Hypothesis (a) confirmed: post-2026-05-02 production drift, 1 non-current `prep_recipes` row + 6 orphan `prep_recipe_ingredients` rows under `House Special Blend (Sauce)` on remote, absent from local seed. Deferred to Spec 006 per amendment #3." Keeps the spec navigable for future readers who hit the placeholder section first.

**Remote push timing — push BEFORE close-out commit, per Spec 001 precedent (`6a2a6b3`):**

3. **Push migration to remote.** Run `supabase db push --linked` to apply `20260506000000_rename_prep_canonicals.sql` to production. Architect's drift review explicitly affirms the migration is byte-identical for remote — gate 1 + gate 1b cross-environment data agree on all 4 source names, so the 16-row UPDATE will replay deterministically. Expected NOTICE: `Spec 005: renamed 16 prep_recipes rows across 4 names (0 is_current flips)`. After remote applies, `schema_migrations` is registered there automatically.

4. **Verify post-remote-push gates.** Spec 003 gate 2 on remote should now show 8 names (the Spec 005 4 + `Burger Patty` from Spec 001 + `Cajun Seasoning (House Mix)` + `White Sauce` + `Yellow Rice` + `House Special Blend (Sauce)` from the existing `36016d31` row that's Spec 006's territory) all at `canonical_current_count = 1`. Test-engineer's AC1 caveat covers this expected outcome.

5. **Stage the commit:** `supabase/migrations/20260506000000_rename_prep_canonicals.sql`, `specs/005-prep-canonical-curation.md` (with S1 fix), `specs/005-prep-canonical-curation/reviews/` (all four reviews + this proposal), `docs/internal/prep-canonicalness-notes.md` (currently untracked working file, referenced by spec as authority — should be tracked). User then runs `git commit`.

**Punt to follow-up (not worth folding now):**

6. **code-reviewer Should-fix (per-name EXISTS guard).** The aggregate `count = 3` check is functionally equivalent to per-name `count = 1` in the presence of the partial unique index `prep_recipes_brand_name_current_unique`. The strictest letter-of-build-stop-5 form would be a defense-in-depth improvement, but the migration has already applied locally with 0 false-negatives and the index covers the gap. Punt as a template-improvement note for future curation specs (Spec 006, Spec 003 retry).

7. **test-engineer S3** (`/tmp/spec003-probe.sql` reference). Spec text-only fix; doesn't affect the migration. Punt as part of the Spec 003 retry's PM/architect pass since they'll touch the gate-2 SQL anyway.

8. **All Nits (5 from code-reviewer, 4 from test-engineer/architect).** Documentation hygiene. None affect the artifact being shipped. Document once in a "spec template lessons learned" doc rather than fixing piecemeal across closed specs.

9. **Architect's "lessons learned for future spec architecture" section** (architect-can-probe-locally tier, probe-gate hygiene rules, two-amendment cap). User-facing CLAUDE.md proposal — out of scope for this spec's release.

## Out of scope for this review

- **security-auditor Low finding (forensic audit-row).** Repo precedent (Spec 001) accepts destructive UPDATE without an audit row; flagged Low explicitly because no compliance regime in repo touches recipe-name history and no PII is involved. Punt as a project-level data-governance question, not a Spec 005 blocker.
- **Spec 006 implementation.** Architect's M4 finding is moot (file exists), but the actual cleanup work — repointing the 6 orphan ingredient rows under `36016d31`/`4fbd90` and reconciling owner-notes prefix — is Spec 006's territory.
- **Spec 003 retry.** Halt-stops 2 and 3 close on Spec 005's 4-name set; halt-stop 6 closes after Spec 006 ships. Retry dispatch is downstream of both.
- **Architect's CLAUDE.md proposals (architect-probe tier, probe-gate hygiene rules, two-amendment cap).** Project-policy questions for the user, not Spec 005 scope.
- **Cross-spec touches confirmed clean.** The commit will include only `supabase/migrations/20260506000000_rename_prep_canonicals.sql` (new), `specs/005-prep-canonical-curation.md` + reviews dir (new), and optionally `docs/internal/prep-canonicalness-notes.md` (currently untracked working file referenced by the spec). It does NOT modify other specs, other migrations, edge functions, app code, or `useStore.ts`. No drift into Spec 001, 003, 004, or 006 files.

## Handoff
next_agent: NONE
prompt: SHIP_READY, 2 spec-hygiene fixes worth folding before commit (schema_migrations repair + fill empty drift-investigation section); remote push before close-out commit per Spec 001 precedent; architect's M4 "Spec 006 not on disk" finding verified moot — file exists at specs/006-house-special-blend-sauce-drift.md (untracked).
payload_paths:
  - specs/005-prep-canonical-curation/reviews/code-reviewer.md
  - specs/005-prep-canonical-curation/reviews/security-auditor.md
  - specs/005-prep-canonical-curation/reviews/test-engineer.md
  - specs/005-prep-canonical-curation/reviews/backend-architect.md
  - specs/005-prep-canonical-curation.md
  - specs/006-house-special-blend-sauce-drift.md
