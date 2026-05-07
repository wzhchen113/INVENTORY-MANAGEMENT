## Code review for spec 003

_Reviewer: code-reviewer. Review scope: migration SQL craftsmanship, architect-deviation review, bulk DELETE shape, NOTICE output, and CLAUDE.md hard rules. No UI or TypeScript changes in this spec._

---

### Critical

None.

---

### Should-fix

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:110` — The apply-context sanity check uses `v_canon_visible_count < 7` as its guard, but the check is a straight `COUNT(*)` against an exact IN-list of 7 names rather than an `EXISTS` with a `HAVING COUNT(*) >= 7` predicate. The lesson learned from Spec 001 (dependency list, spec line 161) explicitly says "use `EXISTS (SELECT 1 ...)` for boolean-predicate checks, not `SELECT COUNT(*) > 0`." The guard here is doing what a Spec 001 lessons-learned item said not to do: it issues an aggregating `SELECT COUNT(*)` and then tests the result in PL/pgSQL, rather than a single `EXISTS`. For a one-time apply-context sanity check against a static list this is not a correctness bug, but it is a direct deviation from a recorded lessons-learned rule. The architect's own sketch in §7 used the `EXISTS ... HAVING COUNT(*) >= 10` form. Suggested fix: replace the `SELECT COUNT(*) INTO v_canon_visible_count … IF v_canon_visible_count < 7` pair with a single `IF NOT EXISTS (SELECT 1 FROM public.prep_recipes WHERE … HAVING COUNT(*) >= 7)` guard, eliminating `v_canon_visible_count` from DECLARE. This also removes the extra variable, which marginally simplifies the DECLARE block.

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:77–78` — `v_canon_visible_count` is declared but only used inside the `ELSIF v_orphan_count = v_grand_total_expected` branch. Variables in PL/pgSQL are initialized to NULL at DECLARE time regardless of whether a branch is taken. The variable is harmless but it is an unused-outside-its-branch declaration that the `EXISTS` fix (above) would eliminate entirely. Flag as Should-fix only because it is the direct consequence of the lessons-learned deviation and fixing one fixes the other.

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:251` — The final success NOTICE says "across 7 preps" as a hardcoded literal rather than a variable. The architect's §4 sketch used `v_prep_count` (a variable) in the equivalent NOTICE wording: `RAISE NOTICE 'Spec 003: cleared % orphans (% repointed, % deleted) across % preps'`. Hardcoding `7` is not wrong today, but it is inconsistent with the pattern the spec established for making the NOTICE self-describing, and it would silently emit the wrong count if a future idempotent re-run checked against a different migration revision. More practically: the NOTICE does not use neutral wording for the two counts — "matching-deduped" and "divergent-discarded" are semantic labels, not the neutral "repointed / deleted" the architect's spec §4 called for. The spec explicitly says "RAISE NOTICE … cleared % orphans (% repointed, % deleted) across % preps" on line 494 of the design. The emitted wording "matching-deduped, % divergent-discarded" is accurate but introduces vocabulary not anchored in the spec's AC wording or the NOTICE template. A reader scanning prod logs who has the spec open would need to map the log vocabulary back to spec vocabulary. Suggest using the spec's template wording: `(% matching-deduped, % divergent-discarded)` is fine as an _alternative_ label only if the spec had approved it; since the spec template used "repointed / deleted", the migration should match.

---

### Nits

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:1–67` — The header comment block is thorough and well-structured: apply-path matrix, certified counts, and "Out of scope" section are all present and correctly stated. One small inconsistency: the comment at line 43 says "Grand total: 332 repoint, 67 delete = 399" using the word "repoint" for the matching-DELETEd branch, while the migration body's step-6 comment at line 227 labels the same step "Mutation 1: DELETE matching orphans." Having "repoint" in the header and "DELETE matching orphans" in the body (both correct per spec's semantic analysis in §5 point 3–4) creates a minor terminology split inside a single file. A one-word parenthetical in the header count line — e.g., "332 repoint (DELETE-as-dedup)" — would make the mapping explicit without requiring the reader to cross-reference the spec.

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:208–220` — The second FOR loop ("detect orphans whose prep_name is NOT in the manifest at all") is correct and its comment explains why it exists (line 208–210). This loop fires only if a new affected name surfaced post-probe, which the grand-total assertion in step 8 would also catch (a new name would increase total rows above 399, triggering the grand-total RAISE EXCEPTION). Both guards are valid defense-in-depth; the comment on line 208 could note that the grand-total assertion in step 8 is the other backstop for this case, so a reader understands the redundancy is intentional. (out-of-scope) As a general pattern, recording the backstop relationship in comments helps the next developer decide whether either guard can be removed during a future simplification pass.

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:53–55` — The filename note ("the 20260507040000 timestamp is load-bearing — it must sort AFTER 20260507030000_spec006_*") is correct and appropriately placed. The note says "It does NOT need to sort before any future migration" — this is a helpful and correct statement. Optionally, adding "(unlike Spec 001's load-bearing sort-before constraint)" would cross-reference the counterexample for any reader who reads this migration after reading Spec 001 and wonders why this one says "does NOT need to sort before." Cosmetic.

- `supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql:81–87` (step 1 count query) — The orphan count query JOINs `prep_recipe_ingredients pri` to `prep_recipes pr` on `pr.id = pri.prep_recipe_id` with a WHERE on `pr.is_current = false`. This is functionally correct. Spec 001's equivalent count query (line 62–67 of Spec 001 migration) used the same INNER JOIN shape. No issue — just confirming alignment.

- Build notes (`specs/003-prep-recipe-ingredients-orphans.md`, `### Re-probe 2026-05-07` section) — The per-name remote breakdown was not re-probed in the 2026-05-07 run (permission denied for additional `db query --linked` calls). The build notes acknowledge this and justify proceeding on grand-total parity alone, citing the architect's apply-path matrix. This is the same limitation as Spec 001's remote probe (which also could not enumerate per-name counts remotely). The justification is sound: grand-total parity + apply-path matrix argument is the same defense Spec 001 used and it held. This note is informational for the release-coordinator: the per-name remote parity is asserted by inference, not by direct probe. Not a migration-code defect; flagged so the release-coordinator can decide whether to surface it as an acknowledged risk.

---

### Architect-deviation findings

The build notes (spec line 1241) list four deviations from the architect's design. All four are credible as reported:

1. **Filename timestamp `20260507040000` vs architect's `20260506000000`**: Dev bumped to sort after Spec 006 (`20260507030000_*`). Correct and necessary — architect's original timestamp would have sorted _before_ Spec 006 once Spec 006 shipped.

2. **DELETE-only body vs architect's "repoint matching / delete divergent" language**: The architect's §5 section 3 explicitly derives and explains this: the live unique index `prep_recipe_ingredients_logical_unique` makes UPDATE-to-canonical collide on every matching row, so DELETE is the semantically-equivalent operation. The migration body encodes the correct derivation and the header comment at lines 12–19 explains it. No gap.

3. **Per-prep assertions BEFORE mutation (step 5) vs architect's sketch placing them AFTER**: Dev cites Spec 005 as precedent. The spec's AC (line 83) does not specify ordering of the per-prep assertion relative to mutation — it only requires that per-prep counts are asserted. Pre-mutation assertion is strictly _better_ from a diagnostic standpoint: the RAISE EXCEPTION fires without having partially mutated the DB. This is a sound deviation.

4. **No recovery snapshot**: Architect's §12 Q7 resolution explicitly concluded that `BEGIN/ROLLBACK` + PITR + seed.sql jointly provide adequate recovery, and no sidecar table was warranted. The migration follows the architect's own resolution. Not a deviation.

All four deviations are within bounds and documented.

---

### CLAUDE.md hard-rule checks

- `AdminScreens.tsx`: not touched. No finding.
- Legacy stores (`useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `npm run db`): not touched. No finding.
- `app.json` slug: not touched. No finding.
- Direct Supabase calls outside `src/lib/db.ts`: N/A (migration-only spec). No finding.
- New realtime channels: none introduced. No finding.
- json-server / `db.json` patterns in new code: none. No finding.
- `window.confirm` / `Alert.alert` direct calls: N/A. No finding.
- `current_setting('jwt...')` custom SQL: none. No finding.
- Test files outside existing pattern: none. No finding.
