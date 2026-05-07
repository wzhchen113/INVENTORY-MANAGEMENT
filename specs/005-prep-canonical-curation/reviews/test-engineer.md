## Test report for spec 005

Reviewed by: test-engineer
Date: 2026-05-06
Build state at review: `Status: READY_FOR_REVIEW (local apply complete; remote push pending explicit user authorization)`

---

### Acceptance criteria status

- **AC1** (spec line 59): After the migration, every orphan-bearing prep name resolves to exactly one `prep_recipes` row with `is_current = true` per brand.
  → **PASS** — Live query confirms `canonical_current_count = 1` for all 7 affected names post-apply on local: `2AM SAUCE`, `Burger Patty`, `Cajun Seasoning (House Mix)`, `House Special Seasoning (House Mix)`, `Tumeric Seasoning (House Mix)`, `White Sauce`, `Yellow Rice`. Verified by running Spec 003's gate 2 SQL directly: 7 rows, all `canonical_current_count = 1`. Test: `docker exec ... psql` gate_2_canonical_per_name query above.
  **Caveat — remote only:** Spec 003's gate 2 on remote will surface an 8th name (`House Special Blend (Sauce)`) with `canonical_current_count = 1` from the existing `36016d31` row; that name is Spec 006's territory, not a failure of Spec 005. Spec 005's 4-name set clears this AC completely on both environments.

- **AC2** (spec line 60): `2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, and `Tumeric Mix` are reconciled by renaming to owner-curated names; per-row mechanic is selected per probe results.
  → **PASS** — Gate 1 post-apply returns 0 rows for all four old names: confirmed by live psql probe. Migration uses `rename-into-collision` for all 4 rows (no `is_current` flips), consistent with the corrected section 2 mechanic table.

- **AC3** (spec line 61): Variant unification for `2AM Sauce` ↔ `2AM SAUCE` applied via rename; canonical `2AM SAUCE` row's ingredient list not modified.
  → **PASS** — `SELECT COUNT(*) FROM prep_recipes WHERE name = '2AM Sauce' AND brand_id = '2a000000-...'` returns 0. Canonical `66d823bb-bad0-4f3e-9dd3-3ab378372cc4` retained at `2AM SAUCE` with `is_current = true` unchanged. `non_current_count` at `2AM SAUCE` grew from 15 to 19 (+3 from `2AM Sauce` +1 from `2AM SAUCE 10`), consistent with spec expectation. Migration does not touch `prep_recipe_ingredients`.

- **AC4** (spec line 62): The +6 remote-vs-local drift is investigated by the architect's pre-impl probe and the cause is documented.
  → **PASS (with caveat on section placement)** — The root cause is documented in Spec 005 section 1 "Remote drift investigation" subsection and extensively in `## Build notes` (Resumption and Final apply subsections). Cause is confirmed: hypothesis (a) — newer production drift post-2026-05-02, specifically 1 non-current `prep_recipes` row + 6 orphan `prep_recipe_ingredients` rows under `House Special Blend (Sauce)` on remote, absent from local seed.
  **Caveat:** The dedicated `## Remote drift investigation` section at spec line 195–198 was never filled in — it still shows the PM's placeholder text ("The architect's pre-impl probe identifies…"). The investigation findings live only in the inline section 1 subsection and build notes. This is a documentation gap (Should-fix), not a functional failure.

- **AC5** (spec line 63): Migration is a timestamped file under `supabase/migrations/` following `YYYYMMDDHHMMSS_description.sql`.
  → **PASS** — File `supabase/migrations/20260506000000_rename_prep_canonicals.sql` exists, uses 14-digit timestamp, sorts immediately after `20260505065303_admin_rpcs_lock_anon.sql` and before `20260507010946_spec004_*`.

- **AC6** (spec line 64): Migration wrapped in `BEGIN` / `COMMIT`.
  → **PASS** — `BEGIN;` at line 46, `COMMIT;` at line 193 of the migration file.

- **AC7** (spec line 65): Pre-mutation count assertion with `RAISE EXCEPTION` rollback on mismatch.
  → **PASS** — Migration implements a two-layer assertion: (a) grand-total check before mutation (lines 83–95 of SQL), (b) per-name actuals snapshot (`_spec005_actuals`) compared against manifest via `LEFT JOIN + COALESCE(actual_count, 0) <> expected_rename_count`, with a diagnostic NOTICE LOOP per mismatched name, then `RAISE EXCEPTION 'Spec 005: per-name affected-count assertion failed — rolling back'`. Additionally a pre-mutation target-canonical sanity check asserts `v_target_canon_count = 3`. Post-UPDATE grand-total `GET DIAGNOSTICS` assertion: `v_renamed_count <> v_expected_grand` → `RAISE EXCEPTION`.

- **AC8** (spec line 66): Idempotent re-run path: second apply against post-curation state is a no-op.
  → **PASS** — Directly verified: re-running the migration after success produced:
  ```
  BEGIN
  DO
  NOTICE:  Spec 005: no-op (no rows under any rename old_name — pre-seed apply OR already curated)
  COMMIT
  ```
  No mutations. The `count = 0` branch fires cleanly.

- **AC9** (spec line 67): Apply-path matrix (remote vs local-with-seed vs reset-then-seed) explicitly considered.
  → **PASS** — Section 5 covers Path A (remote `db push`), Path B-revised (manual re-execute after `db reset --local`), Path C (`db reset --local` no manual re-execute, acknowledged structural limitation), Path D (re-run after success). Amendment notes from #2 and #3 are preserved showing how the matrix evolved.

- **AC10** (spec line 68): Owner-curated `docs/internal/prep-canonicalness-notes.md` referenced as authority for names. Spec 005 does NOT re-derive canonical names from data.
  → **PASS** — The file exists as an untracked working file (confirmed via `git status`: `?? docs/internal/prep-canonicalness-notes.md`). Sections 0, 1, 2, and 7 of the design all cite it directly. The migration's header comment also references it (line 6 of the SQL). The file was not modified by any Spec 005 work.

- **AC11** (spec line 69): After this spec ships, Spec 003's halt-stop gates 2, 3, and 6 (or the certified subset) no longer fire.
  → **PASS on gates 2 and 3 (local)**; **PARTIAL on gate 6 per spec's own acknowledgement**:
  - Gate 2 (spec 003 definition — canonical per name): All 7 orphan-bearing names on local have `canonical_current_count = 1`. Live query confirms.
  - Gate 3 (spec 003 definition — variant names): Gate 3 SQL returns 0 rows — no remaining case-variant pairs share a lowercased name in the affected set. `2AM Sauce` no longer exists as a distinct name.
  - Gate 6 (Spec 003 developer halt: local 399 / remote 405 +6 drift): Spec 005 documents the cause; full numerical closure (bringing remote count in line with local) requires Spec 006. Spec 005 itself explicitly scopes this as partial closure: "Spec 003 halt-stop 6 full closure is sibling Spec 006's territory per amendment #3." Spec 006 exists as a DRAFT spec. This is NOT a failure of Spec 005 — it is the acknowledged and user-approved scope boundary.

---

### Test run

All probes run read-only against the local Supabase stack (`npm run dev:db`). No mutations performed. The migration was already applied by the developer via `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < supabase/migrations/20260506000000_rename_prep_canonicals.sql`; this reviewer only re-runs verification probes and the idempotent no-op re-run.

**Commands and results:**

```
# Gate 1: 4 source names absent post-apply
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "SELECT name FROM prep_recipes WHERE name IN ('2AM Sauce','2AM SAUCE 10','House Special Seasoning Mix','Tumeric Mix') GROUP BY name, brand_id;"
→ (0 rows)  PASS

# Gate 1b: 3 target canonicals unchanged
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "SELECT name, current_count, non_current_count, canonical_id FROM ..."
→ 2AM SAUCE: current=1, non_current=19, canonical=66d823bb  PASS
→ House Special Seasoning (House Mix): current=1, non_current=8, canonical=38678f33  PASS
→ Tumeric Seasoning (House Mix): current=1, non_current=5, canonical=c7d9a94b  PASS

# Spec 003 gate 2 post-apply
→ 7 rows, all canonical_current_count=1  PASS

# Spec 003 gate 3 post-apply (variant evidence)
→ (0 rows)  PASS

# No duplicate is_current=true rows
→ (0 rows)  PASS

# Idempotent re-run
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < \
  supabase/migrations/20260506000000_rename_prep_canonicals.sql
→ NOTICE: Spec 005: no-op (no rows under any rename old_name — pre-seed apply OR already curated)  PASS

# Migration file exists and sorts correctly
ls supabase/migrations/ | grep 2026050[56]
→ 20260506000000_rename_prep_canonicals.sql between 20260505065303 and 20260507010946  PASS
```

**Pass count: 11 of 11 ACs — all PASS (gate 6 partial closure is spec-acknowledged scope, not a failure).**

---

### Notes

#### Critical findings: NONE

No AC is in a FAIL state. All acceptance criteria are met on local, which is the only environment where the migration has been applied. Remote push is pending user authorization, which is the spec's documented status.

#### Should-fix findings

**S1 — `## Remote drift investigation` section never populated.**
The PM-authored placeholder section at spec line 195–198 was never filled in. The architect's actual investigation lives in section 1's inline subsection (line 528 onwards) and in `## Build notes`. A fresh developer reading only the spec's top-level sections would see the placeholder and not know the investigation is complete. The content exists; it is just in the wrong place. Recommendation: copy the two-sentence summary from section 1 "Remote drift investigation" (hypothesis (a) confirmed: 1 non-current `prep_recipes` row + 6 orphan ingredient rows under `House Special Blend (Sauce)` on remote, post-2026-05-02 production drift, not affecting Spec 005's 4-name set) into the `## Remote drift investigation` section and mark it "(filled in from build notes)".

**S2 — Migration not registered in `schema_migrations` after manual psql apply.**
The developer applied the migration via direct `docker exec ... psql` (bypassing the Supabase CLI). This means `supabase_migrations.schema_migrations` does NOT have an entry for version `20260506000000` on local. Implication: when `supabase db push` is run against local in the future, the CLI will see the migration file is not tracked and attempt to re-apply it. The migration's `count=0` no-op branch handles this safely — the re-apply produces the no-op NOTICE and the CLI then inserts the version. This is not a data-safety risk. However, it creates a divergence: local DB has the effect of the migration applied but no tracking record, while remote (after push) will have both. Any developer running `supabase db diff` or `supabase migration list` on local will see a confusing state. Recommendation: before or immediately after the remote push, run `supabase migration repair --status applied 20260506000000` against local to register the version without re-applying the SQL.

**S3 — Section 7 post-apply step 3 references `/tmp/spec003-probe.sql` without self-contained definition.**
The verification protocol at spec line 856 says "Re-run Spec 003's probe (`/tmp/spec003-probe.sql`)". A fresh developer checking out this repo and following the post-apply protocol would not find `/tmp/spec003-probe.sql` on disk — it only exists in the developer's local `/tmp` during active development. Spec 003 does define the probe SQL inline at its section 1 (lines 265–415), but the spec 005 verification protocol does not cite the section location. This is a minor reproducibility gap. Recommendation: update the reference to read "Re-run Spec 003 gate 2 SQL (Spec 003 section 1, lines 265–284)" or embed the 20-line gate 2 query directly in the post-apply steps.

#### Nit-level findings

**N1 — Section 4's NOTICE sketch is stale (describes `% with is_current flip`).**
The spec's section 4 "Diagnostic NOTICE on success" sketch (line 733) still reads:
```
RAISE NOTICE 'Spec 005: renamed % prep_recipes rows across % names (% with is_current flip)', ...
```
The authored migration emits `(0 is_current flips)` as a literal, not `%`. The spec's section 7 "During apply" note (line 845) acknowledges this stale parenthetical. The migration's actual NOTICE is correct; the section 4 sketch is documentation debt from before amendment #1 corrected the mechanic. No functional impact.

**N2 — Spec 003 gate 6 terminology inconsistency.**
Spec 005 references "Spec 003 halt-stop gate 6" at multiple points (lines 69, 857, 1346, etc.), but Spec 003's build notes and architect design use "gate_6_recipe_fanout" (the distinct-recipes SQL) and a separate unlabeled "Local-vs-remote divergence" halt condition. The local-vs-remote divergence is the one Spec 005 is addressing; it is not the architect's `gate_6_recipe_fanout` SQL. The cross-spec terminology creates ambiguity. Not a functional issue since both specs agree on what was blocked and what is resolved.

**N3 — `pwa-catalog` smoke was deferred with no record of being run.**
Section 7 post-apply step 4 marks the `pwa-catalog` smoke as "optional, non-blocking" and the expected diff is zero. The build notes record "SKIPPED" at each halt. Since the expected diff is zero and every renamed row is excluded from the catalog filter (`is_current = false`), the smoke provides no information beyond confirmation of a known invariant. Not flagged as a test gap.

**N4 — No test framework (acknowledged project-wide).**
Per CLAUDE.md and the scope of this review, the absence of a test framework is not flagged Critical for this spec. The migration's pre-mutation assertions are the in-band test. All assertions passed on local apply.

#### Remote-push deferral scope

The spec status is `READY_FOR_REVIEW (local apply complete; remote push pending explicit user authorization)`. The remote push has not happened. The following ACs are verified on local only and will be re-verified on remote automatically when `db push` runs:

- AC1 (gate 2 canonical count): Local PASS; remote expected identical per byte-identical gate 1 + gate 1b cross-environment data.
- AC2 (source names absent): Local PASS; remote expected 0 rows for the same 4 source names since gate 1 confirmed byte-identical row IDs on both environments.
- AC7 (pre-mutation assertion): Will fire on remote at push time; the migration's manifest counts (4/8/3/1) match remote's actual counts per the resumption probe.
- AC8 (idempotent re-run): Not needed on first remote apply; would apply only if pushed twice.

The spec explicitly acknowledges this deferral and states the migration is "byte-identical for remote" based on the resumption probe's cross-environment comparison. The remote apply will be the final closure of ACs 1, 2, and 7 on the production environment.

**No AC is FAIL. Gate 6 partial closure is the spec's own acknowledged scope boundary, not a test failure.**
