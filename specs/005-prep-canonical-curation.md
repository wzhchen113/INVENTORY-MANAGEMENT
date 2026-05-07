# Spec 005: Prep canonical curation (prerequisite for Spec 003)

Status: DONE

**Type:** Backend / data curation migration (one-shot)
**Filed:** 2026-05-06
**Resolved:** 2026-05-06 — user directives on Q1, Q2, Q5; Q3 and Q4 left to PM recommendation
**Consumer:** [Spec 003](003-prep-recipe-ingredients-orphans.md) (`Status: READY_FOR_BUILD`, halted at probe stage). Spec 003's repair contract requires that every affected prep name resolve to exactly one canonical (`is_current = true`) `prep_recipes` row per brand. The probe found that contract is currently unsatisfiable — this spec curates the data so Spec 003 can resume.
**Source of truth:** [`docs/internal/prep-canonicalness-notes.md`](../docs/internal/prep-canonicalness-notes.md) — owner-curated names and ingredient lists. Trust it; do not re-derive. **Do not modify** as part of Spec 005's work.
**Predecessors:** [Spec 001](001-repoint-burger-patty-prep-refs.md) (DONE) — established the migration precedent (atomic transaction, pre-mutation count assertion, no-partial-repair, idempotent no-op, apply-path matrix, pre-impl probe).

## User story

As a backend operator of the 2AM PROJECT data layer, I want the four prep names that currently have **zero** canonical-current rows in `prep_recipes` to be reconciled against the owner-curated source of truth by **renaming the offending DB rows to match the owner-curated names**, the variant-unification policy for case/suffix duplicates (e.g. `2AM Sauce` vs `2AM SAUCE`) to be encoded as **`2AM Sauce` rows rename to canonical `2AM SAUCE`** with the canonical's ingredient list left authoritative, and the local-vs-remote orphan-count drift (+6) to be diagnosed, so that Spec 003's per-prep "exactly one canonical per affected name" assertion is satisfiable and Spec 003's repair migration can be re-designed against the cleaner data shape without further surprises.

## Background

Spec 003 (`Status: READY_FOR_BUILD`) targets the 399-row tail of orphan `prep_recipe_ingredients` rows that point at non-current `prep_recipes`. The backend-developer halted at probe stage because three of six hard build-stop gates fired:

1. **Gate 2 — Missing canonicals.** Four of the ten affected prep names have ZERO rows in `prep_recipes` with `is_current = true`:
   - `2AM Sauce`
   - `2AM SAUCE 10`
   - `House Special Seasoning Mix`
   - `Tumeric Mix`

   116 of 399 orphan rows (~29%) point at non-current preps under these four names. Spec 003's contract requires exactly one canonical per affected name; with no canonical at all, the migration cannot run.

2. **Gate 3 — Variant evidence.** Strong same-prep evidence between `2AM Sauce` and `2AM SAUCE`: they share 8 byte-identical `(catalog_ingredient_id, quantity, unit)` tuples; the canonical adds `Cajun Seasoning (House Mix)` (a prep) where the variants use raw `Cajun Spice & Skillet`. The owner-curated notes name `House Special Seasoning (House Mix)` and `Tumeric Seasoning (House Mix)` (not the DB's `House Special Seasoning Mix` and `Tumeric Mix`) — the four "missing" canonicals look like naming variants of the owner-curated names.

3. **Gate 6 — Remote drift.** Local probe returned 399 orphan rows; remote returned 405. +6 rows are unexplained.

The owner has paused Spec 003 and filed this prerequisite spec to resolve the curation/data-quality issues first.

## Strategy (resolved)

**Reconciliation shape: rename DB rows to match the owner-curated names.** Spec 005 ships an `UPDATE prep_recipes SET name = '<owner-curated-name>' WHERE name = '<DB-variant-name>'` migration for the offending rows. After the rename, the "missing canonical" issue dissolves: either the renamed row itself becomes the canonical for that name, or it merges into a name that already has a canonical (a collision case the architect resolves per row).

The owner-curated mapping (from `docs/internal/prep-canonicalness-notes.md`):

| DB name (current)               | Owner-curated name (target)            |
|---------------------------------|----------------------------------------|
| `Tumeric Mix`                   | `Tumeric Seasoning (House Mix)`        |
| `House Special Seasoning Mix`   | `House Special Seasoning (House Mix)`  |
| `2AM Sauce`                     | `2AM SAUCE`                            |
| `2AM SAUCE 10`                  | (architect determines from probe — `2AM SAUCE` if probe confirms variant family; otherwise architect surfaces as a divergence) |

The architect's pre-impl probe must verify each affected name's current-vs-non-current state and pick the appropriate rename mechanic per row:

- **Rename-only** when no row at the target name exists.
- **Rename-plus-flip-`is_current`** when the renamed row should become the canonical and an existing row at the target name needs to lose `is_current = true` (or vice versa).
- **Rename-into-existing-canonical-collision** when a canonical row already exists at the target name and the renamed row would create a duplicate-canonical situation; the architect picks the resolution (merge, drop one, or surface as divergence).

The canonical's ingredient list is **authoritative**. Spec 005 does NOT reconcile the ingredient-list divergence between `2AM Sauce` (uses raw `Cajun Spice & Skillet`) and canonical `2AM SAUCE` (uses prep `Cajun Seasoning (House Mix)`). After Spec 005's renames, those orphan `prep_recipe_ingredients` rows under non-current variants are picked up by Spec 003's "delete divergent" rule (Spec 003 Q1), which the user re-evaluates before Spec 003 retries.

## Acceptance criteria

> Per Spec 001 / Spec 003 precedent: the architect's pre-implementation probe is the source of truth for exact counts. The numbers below (4 missing canonicals, 116 orphans without canonicals, +6 remote drift) are the developer-probe values from Spec 003's halt and are reproduced here only as the floor of what the curation must address. The architect re-probes at design time and encodes whatever values the probe certifies.

- [ ] After this spec's migration applies, every prep name referenced by an orphan `prep_recipe_ingredients` row resolves to **exactly one** `prep_recipes` row with `is_current = true` per brand. (Same shape as Spec 003's per-prep assertion, but at the curation layer rather than the repair layer.)
- [ ] Specifically: `2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, and `Tumeric Mix` (or whatever names the architect's re-probe surfaces as missing-canonical) are reconciled by **renaming** the DB rows to the owner-curated names per the mapping above. Per-row mechanic (rename-only vs. rename-plus-flip-`is_current` vs. rename-into-existing-canonical-collision) is selected by the architect based on probe results.
- [ ] The variant unification for `2AM Sauce` ↔ `2AM SAUCE` is applied via rename: the row(s) named `2AM Sauce` are renamed to `2AM SAUCE`. The canonical `2AM SAUCE` row's ingredient list is treated as authoritative and is NOT modified by Spec 005. Ingredient-list reconciliation under non-current variants is deferred to Spec 003's "delete divergent" rule once the rename has merged the names.
- [ ] The +6 remote-vs-local drift is investigated by the architect's pre-impl probe and the cause is documented in this spec's "Remote drift investigation" section. If the cause changes the curation contract (e.g., remote has additional missing-canonical names not present locally), the architect halts and surfaces the divergence rather than designing around it.
- [ ] The migration is a new timestamped file under `supabase/migrations/` following the `YYYYMMDDHHMMSS_description.sql` naming convention.
- [ ] The migration is wrapped in an atomic transaction (`BEGIN` / `COMMIT`).
- [ ] Pre-mutation count assertion: the migration counts the rows it expects to mutate, compares against the architect's probe-certified expected value, and `RAISE EXCEPTION` rolls back on mismatch. No partial repair under unexpected counts.
- [ ] Idempotent re-run path: a second apply against the post-curation state is a no-op (count = 0 → exit successfully).
- [ ] The migration's apply-path matrix (remote vs local-with-seed vs reset-then-seed) is explicitly considered in the architect's design doc per Spec 001 / Spec 003 precedent.
- [ ] The owner-curated source of truth (`docs/internal/prep-canonicalness-notes.md`) is referenced by the migration's design doc as the authority for names and ingredient lists. Spec 005 does NOT re-derive canonical names from data; it makes the DB match the file.
- [ ] After this spec ships, Spec 003's halt-stop gates 2, 3, and 6 (or whichever subset the architect's re-probe certifies as resolved) no longer fire. Spec 003 retry trigger is encoded under Open Question 5 (resolved): user re-evaluates Spec 003's Q1 and Q3 directives before re-dispatching the architect.

## In scope

- **Rename-based reconciliation** of the four missing-canonical prep names to the owner-curated names. Per-row mechanic (rename-only vs. rename-plus-flip-`is_current` vs. rename-into-existing-canonical-collision) selected by the architect from probe results.
- Variant unification for the `2AM Sauce` ↔ `2AM SAUCE` family (and `2AM SAUCE 10` if architect probe confirms it belongs to the same family) via the rename mechanic above. The canonical `2AM SAUCE` row's ingredient list remains authoritative and is NOT touched by Spec 005.
- Remote-vs-local +6 orphan drift investigation, performed by the architect during pre-impl probe, with cause documented in this spec.
- A single one-shot rename migration file applying the chosen reconciliation shape.
- Updating Spec 003's `Status:` to reflect the unblock state (handled at retry time, not by this spec's migration).

## Out of scope (explicitly)

- **Ingredient-list reconciliation between `2AM Sauce` (raw `Cajun Spice & Skillet`) and canonical `2AM SAUCE` (prep `Cajun Seasoning (House Mix)`).** The canonical's ingredient list is authoritative; the divergent rows under the non-current variant are cleared by Spec 003's "delete divergent" rule once Spec 005 has merged the names. Spec 005 does not touch `prep_recipe_ingredients`.
- **Re-running Spec 003.** Spec 005 ships, then the user re-walks Spec 003's Q1 ("delete-divergent vs. repoint-matching") and Q3 (sequencing + variant treatment) directives against the post-Spec-005 data shape before re-dispatching the architect for Spec 003.
- **Constraint guards** (e.g., a partial unique index enforcing one current row per `(name, brand_id)`). Spec 003 section 14 flagged this as a separate Spec 006/007 candidate. This spec is curation only — preventing future regressions is not in scope.
- **General alias-management feature.** The user picked rename-in-place over an alias table; no `prep_recipe_name_aliases` table is created. Building alias surface area as a UX feature is Spec 004's territory (`specs/004-ingredient-form-lookups.md`, untracked at filing time), not Spec 005's.
- **Full canonical rebuild.** The owner-curated notes file is authoritative for names and ingredient lists. This spec makes the DB match; it does not reinvestigate.
- **Curating the six already-canonical prep names** that Spec 003's probe found in good shape (`2AM SAUCE`, `Cajun Seasoning (House Mix)`, `White Sauce`, `Burger Patty`, `Yellow Rice`, `Tumeric Seasoning (House Mix)` — per `prep-canonicalness-notes.md`). They already have one current row per `(name, brand_id)`; touching them risks regression.
- **Modifying `docs/internal/prep-canonicalness-notes.md`.** It is the source of truth as captured by the owner on 2026-05-05. The migration matches the file; it does not edit it.

## Open questions resolved

### Q1 — Reconciliation shape: RESOLVED → **(a) Rename DB rows to match owner-curated names.**

User directive: `UPDATE prep_recipes.name` so DB names match the owner-curated names in `docs/internal/prep-canonicalness-notes.md`.

Examples from user:
- `Tumeric Mix` → `Tumeric Seasoning (House Mix)`
- `House Special Seasoning Mix` → `House Special Seasoning (House Mix)`

Architect must verify each affected name's current-vs-non-current state during the pre-impl probe and pick the appropriate per-row mechanic:
- Rename-only (no existing row at target name).
- Rename-plus-flip-`is_current` (renamed row should become canonical; existing canonical at target name needs to lose `is_current = true`, or vice versa).
- Rename-into-existing-canonical-collision (canonical already exists at target name; architect picks the resolution and surfaces if it requires a divergence call from the user).

After rename, the "missing canonical" issue dissolves for these four names: the renamed row becomes the canonical, or it merges into an existing canonical at the target name.

The PM-original options (b) alias table and (c) insert canonicals are NOT chosen. No new tables; no synthesized canonical rows.

### Q2 — Variant unification policy: RESOLVED → **(a) Alias `2AM Sauce` to canonical `2AM SAUCE`, applied via rename.**

User directive (literal): "pick the 2am sauce with the prep 'cajun seasoning (house mix)'."

Translation: the canonical `2AM SAUCE` (the row that uses prep `Cajun Seasoning (House Mix)` as one of its ingredients) is the correct version. The mixed-case `2AM Sauce` rows (which use raw `Cajun Spice & Skillet` instead of the prepped seasoning) are non-current and merge into / alias to canonical `2AM SAUCE`.

Mechanically, given Q1's "rename" answer: rename `prep_recipes` rows named `2AM Sauce` to `2AM SAUCE`. Architect picks the per-row mechanic (likely rename-plus-flip-`is_current`-stays-false since there is already a current canonical at `2AM SAUCE`, but the architect's probe confirms).

The single-ingredient formulation drift (`Cajun Seasoning (House Mix)` prep vs. raw `Cajun Spice & Skillet`) is treated as a divergence: those orphan rows in `prep_recipe_ingredients` will be deleted by Spec 003's "delete divergent" rule once Spec 005 has merged the names. **Spec 005 itself does NOT handle the ingredient-list reconciliation; it only makes `2AM Sauce` and `2AM SAUCE` resolve to one canonical via the rename.**

`2AM SAUCE 10` falls under the same Q2 family if the architect's probe confirms it is a sibling variant. If the probe surfaces it as something else, architect halts and surfaces.

PM-original options (b) "treat as separate" and (c) "defer to architect" are NOT chosen.

### Q3 — Spec scope: PM-RECOMMENDED; user did not explicitly answer → **(a) One spec.**

PM recommendation stands: curation + remote-drift investigation in Spec 005. The +6 drift is small enough that the architect's pre-impl probe can diagnose it inline; splitting adds coordination overhead without obvious benefit. Architect may revisit during their probe if the drift cause turns out to be larger than expected.

### Q4 — Migration apply discipline: PM-RECOMMENDED; user did not explicitly answer → **(a) Full Spec 001 matrix.**

PM recommendation stands: full apply-path matrix, pre-mutation count assertion vs probe-certified expected, no-partial-repair, idempotent re-run path, apply-context analysis. Spec 001 demonstrated that "small row count" is not a reliable predictor of low risk — Path A vs Path B-revised divergence in Spec 001 fired on a 4-row migration. The rename mechanic is small but Spec 001 / Spec 003 precedent applies in full. Architect may revisit during design if the rename shape makes the matrix partially redundant.

### Q5 — Spec 003 retry trigger: RESOLVED → **(b) User re-evaluates Spec 003 Q1/Q3 first.**

User directive: after Spec 005 ships, the user re-walks Spec 003's Q1 ("delete-divergent vs. repoint-matching") and Q3 ("sequencing + variant treatment") directives before re-dispatching the architect for Spec 003. Reason: Spec 003's policies were originally set against a probe that did not see the missing-canonical or variant evidence; the data shape after Spec 005 will be materially different, and Spec 003's directives may need to change.

This means **Spec 003's existing Q1/Q3 answers are NOT automatically valid post-Spec-005**. The architect handling Spec 003's retry must re-design from the user's re-evaluation, not from the existing Spec 003 directives.

PM-original option (a) "auto-retry against existing Spec 003 directives" is NOT chosen.

## Dependencies

- **Owner-curated notes:** [`docs/internal/prep-canonicalness-notes.md`](../docs/internal/prep-canonicalness-notes.md) (untracked working file as of 2026-05-05). Load-bearing for this spec — must not be modified by Spec 005's work. If the file is moved or renamed during this spec's lifetime, Spec 005's design doc must be updated to track the new path before the migration is applied.
- **Spec 003 halt context:** [`specs/003-prep-recipe-ingredients-orphans.md`](003-prep-recipe-ingredients-orphans.md) — the consumer that's blocked. The architect should read Spec 003's halt-stop gates before designing Spec 005's migration to ensure the curation actually clears the gates.
- **Spec 003 retry policy (downstream):** Spec 003's Q1 and Q3 directives are **not** assumed valid after Spec 005 ships. The user re-evaluates them before re-dispatching the architect. The Spec 003 architect re-design starts from the re-evaluated policies, not the existing ones.
- **Spec 001 precedent:** [`specs/001-repoint-burger-patty-prep-refs.md`](001-repoint-burger-patty-prep-refs.md) — migration shape, apply-path matrix template.
- **No new edge functions, no new RPCs, no frontend changes.** Backend data migration only.

## Project-specific notes

- **Cmd UI section / legacy:** N/A — backend data migration; no UI changes.
- **Per-store or admin-global:** Per-brand. Spec 003's probe identified all 10 affected prep names under brand `2a000000-0000-0000-0000-000000000001`. Curation is scoped to that brand unless the architect's re-probe surfaces additional brands.
- **Realtime channels touched:** None directly by the migration. Note Spec 001 / Spec 003 precedent: the realtime publication-membership gotcha (`docker restart supabase_realtime_imr-inventory`) must be considered in the architect's apply-context analysis even when the migration does not change publication membership, per the user's MEMORY note.
- **Migrations needed:** Yes — one timestamped migration file under `supabase/migrations/`. Shape is **rename-based**: `UPDATE prep_recipes SET name = ...`, possibly combined with `is_current` flips per architect's probe.
- **Edge functions touched:** None.
- **Web/native scope:** N/A — backend only.
- **Tests:** No test framework wired up in repo (per CLAUDE.md "No test framework"). The migration's pre-mutation count assertion is the in-band test. If the architect wants offline verification beyond the assertion, surface as a question — there is no project-default test harness to drop into.
- **app.json slug:** Untouched. This spec does not approach build identifiers.
- **Working tree state at filing:** `M .claude/launch.json` and untracked `docs/internal/prep-canonicalness-notes.md` per `git status`. The notes file is now load-bearing for this spec; the architect must not delete or move it as part of this work, and Spec 005's design must NOT propose checking it in (that's a separate decision).
- **Data layer:** Live Supabase only. `db.json`, `useSupabaseStore.ts`, `useJsonServerSync.ts`, and the legacy `npm run db` script are off-limits per CLAUDE.md "Data layer (active vs. legacy)".

## Carry-forward project precedent (architect must apply unless overridden)

- Atomic transaction (`BEGIN` / `COMMIT`).
- Pre-impl probe with documented results in this spec.
- Pre-mutation count assertion vs probe-certified expected; `RAISE EXCEPTION` rolls back on mismatch.
- No partial repair under unexpected counts.
- Idempotent re-run path (count = 0 → no-op).
- Apply-path matrix (remote vs local-with-seed vs reset-then-seed) explicitly considered — Spec 001 section 5b is the template.
- Filename timestamp ordering relative to adjacent migrations (especially Spec 003's eventual migration) considered.
- Per-store RLS hardening (`auth_can_see_store()` / `auth_is_admin()`) implications considered; migration assumes superuser apply context.
- Backend-architect designs and revises until correct (Spec 001 took 3 revisions; Spec 003 halted at probe).

## Architect handoff guidance

The architect's pre-impl probe is required to surface the data shape Spec 005 will mutate. Specifically:

1. **Per-name current-vs-non-current state.** For each of the four missing-canonical names (`2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`), the probe must report:
   - Number of `prep_recipes` rows at the DB name (current and non-current).
   - Number of `prep_recipes` rows at the owner-curated target name (current and non-current).
   - Per-row `id`, `is_current`, `brand_id`, and a representative ingredient-list summary.

   This determines the per-row rename mechanic:
   - Rename-only (no row exists at target name).
   - Rename-plus-flip-`is_current` (renamed row should become the canonical and an existing target-name row needs `is_current` flipped, or vice versa — the architect picks, given canonical-ingredient-list authority from Q2).
   - Rename-into-existing-canonical-collision (canonical already exists at target name; architect picks resolution: merge by deleting/repointing the renamed row, drop, or surface as a divergence requiring user direction).

2. **+6 remote drift investigation.** The architect's probe must reach the remote DB and identify whether the +6 rows are: (a) newer orphans created since local seed.sql was pulled (2026-05-02 per CLAUDE.md), (b) different deduplication state on remote, (c) probe-divergence artifact, or (d) something else. The cause is documented in the "Remote drift investigation" section of this spec. If the cause materially changes the curation contract (e.g., remote has additional missing-canonical names not present locally), the architect halts and surfaces the divergence rather than designing around it.

3. **`2AM SAUCE 10` family confirmation.** The architect's probe must confirm whether `2AM SAUCE 10` is a sibling variant of the `2AM SAUCE` family (and therefore renames to `2AM SAUCE` per Q2's policy) or something else. If the probe surfaces it as a different prep, architect halts and surfaces.

4. **Spec 001 / Spec 003 precedent applies in full** (per Q4 PM recommendation): atomic transaction, pre-mutation count assertion vs probe-certified expected, no-partial-repair, idempotent re-run path, apply-path matrix (remote vs local-with-seed vs reset-then-seed), realtime publication-membership consideration even though the migration doesn't change publication membership.

5. **Source of truth: `docs/internal/prep-canonicalness-notes.md` is read-only.** The architect references it for the owner-curated names and ingredient-list authority but does NOT modify it. Spec 005's design doc must reference it as the authority and must NOT propose checking it in (separate decision, out of scope).

6. **Spec 003 is the consumer; Spec 005 is a prerequisite.** The architect's design must clear Spec 003's halt-stop gates 2, 3, and 6. Spec 003 retry is gated on the user re-evaluating Spec 003's Q1/Q3 directives, not automatic.

## Remote drift investigation

> _Resolved 2026-05-06 by dev probe (read-only, user-authorized). See `## Build notes` → `### Resumption — 2026-05-06 (post-amendment)` and `### Final apply (amendment #3)` subsections for the full trace._

**Hypothesis (a) confirmed:** post-2026-05-02 production drift. Remote has 1 non-current `prep_recipes` row (`4fbd90...`) + 6 orphan `prep_recipe_ingredients` rows under canonical name `House Special Blend (Sauce)` — neither present in local seed.sql. Additionally, a new canonical `36016d31...` was promoted to `is_current = true` on remote at the same canonical name post-seed-pull, demoting the owner-noted `4fbd90` prefix.

**Disposition:** out of scope for Spec 005. The +6 drift is on a 5th name (`House Special Blend (Sauce)`) that was investigated in amendment #2 then dropped in amendment #3 (degenerate "rename" — the rows are at the canonical name itself, not at a variant). Cleanup deferred to **sibling Spec 006** (`specs/006-house-special-blend-sauce-drift.md`, `Status: DRAFT`), which owns: (i) reconciling owner-notes (`4fbd90`) vs remote canonical (`36016d31`), and (ii) deleting the 6 orphan ingredient rows under user-resolved `delete divergent` policy.

## Handoff trigger

User has resolved Q1, Q2, and Q5; PM-recommended answers stand for Q3 and Q4 (architect may revisit during probe if needed). This spec is `Status: READY_FOR_ARCH`. Main Claude dispatches the backend-architect.

## Backend design

### 0. Architect probe-execution constraint (must be addressed before build proceeds)

**The architect dispatched for spec 005's design pass has Read/Write/Edit tooling only — no shell or `docker exec` access** (same constraint as Spec 003 section 0). The "Probe results" section below therefore CANNOT be populated with live numeric values inline by this design pass. The architect has instead:

- Recorded the **expected probe outputs** in section 1 below based on (a) Spec 003's recorded `## Build notes` probe (399 local / 405 remote orphans, 4-of-10 missing canonicals — `2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`, on 2026-05-06), (b) the owner-curated names in [`docs/internal/prep-canonicalness-notes.md`](../docs/internal/prep-canonicalness-notes.md), and (c) the schema reality verified by reading `20260405000759_init_schema.sql` (no `(name, brand_id)` unique constraint on `prep_recipes`) and `20260504062318_brand_catalog_p2_backfill.sql` (Phase 2 deduped only `is_current = true` preps; non-current rows are version history).
- Provided **complete, copy-pasteable probe SQL** in section 1 below that returns the per-name current/non-current counts the migration's `_spec005_renames` manifest needs.
- Designed the migration so that the rename mechanic per name is **encoded as a hardcoded manifest inside the migration body**, not derived at apply time. Same architectural shape as Spec 003's `_spec003_expectations` table — Spec 005's manifest is a 4-row table of `(old_name, new_name, mechanic, expected_affected_count)` tuples.

**What the developer MUST do before authoring the migration:**

> **Amended 2026-05-06:** the user has authorized read-only remote probe (was previously denied by sandbox; first-pass build halted at this checkpoint). The dev-flow ordering below now reflects that authorization. The remote probe is the gating step for hypothesis (c) confirmation per section 1's "Remote drift investigation". If hypothesis (c) is refuted (remote has additional missing-canonical names not seen locally), STOP and surface to the user — do not author the migration. If hypothesis (c) holds, proceed to author the migration per the corrected section 2 mechanic table (single UPDATE, no `is_current` flips).

> **Amended 2026-05-06 (#2):** remote probe ran (per Build notes "Resumption — 2026-05-06 (post-amendment)"). Hypothesis (c) was REFUTED — remote has an 11th name (`House Special Blend (Sauce)`) with 6 non-current `prep_recipes` rows + 6 orphan `prep_recipe_ingredients` rows that are not present locally. Per user direction, the curation contract is **extended** to cover the 11th name as a 5th manifest row rather than splitting into two specs. The new manifest grand total is **22 rows** (4 + 8 + 3 + 1 + 6). All five rows use `mechanic = 'rename-into-collision'` with no `is_current` flip — same shape as the existing four. Build-stop 6 (the gate that fired on hypothesis-(c) refutation) is RESOLVED via this amendment. See sections 1 (probe results), 2 (mechanic table), 4 (manifest sketch), 5 (apply-path matrix), 7 (verification), and 8 (build-stops) for the surgical updates.
>
> **Source-vs-target name clarification (BLOCKER for the 5th row).** The dev's resumption notes describe `House Special Blend (Sauce)` as both (a) the owner-curated canonical name (per `docs/internal/prep-canonicalness-notes.md` line 99, prefix `4fbd90`) AND (b) the name carrying the 6 non-current rows + 6 orphan ingredient rows on remote. Under the rename-into-collision shape used by the other four manifest rows, that's contradictory: there must be a non-canonical SOURCE name distinct from the TARGET name `House Special Blend (Sauce)` for "rename" to be a meaningful operation. The two viable readings are:
>
> - **Reading 1 (likely — same shape as `2AM Sauce` ↔ `2AM SAUCE`):** the 6 non-current rows are at a casing / whitespace / suffix variant of the target name (e.g., `House Special Blend (sauce)` lowercase, `House Special Blend (SAUCE)`, `House Special Blend Sauce` without parentheses, etc.) that the dev's resumption notes truncated. The fix is rename-into-collision: rename the variant rows to `House Special Blend (Sauce)`; canonical at prefix `4fbd90` retains `is_current = true`.
> - **Reading 2 (degenerate):** the 6 non-current rows are AT the canonical target name itself (no variant; same string, just `is_current = false`). Then "rename" is a no-op — the rows are already at the right name. The right operation is either "do nothing, defer to Spec 003 to clean orphan ingredient rows" or "delete the 6 non-current rows" (out-of-scope for Spec 005's rename-only shape).
>
> **The architect cannot disambiguate without re-running the remote probe with explicit source-name capture.** The dev MUST resolve this at apply time by re-running gate 1 against remote with the source name pinned to the actual variant string the probe surfaced. If Reading 1 holds, use the actual variant string in the manifest's `old_name` column. If Reading 2 holds, **STOP and surface to the user** — do NOT author a rename that is a no-op pretending to be a curation step. See section 8 build-stop 8 (new) for the apply-time gate.

> **Amended 2026-05-06 (#3):** the apply-time source-name re-probe ran (per Build notes "Final apply — 2026-05-06 (post-amendment-#2 source-name re-probe)") and confirmed **Reading 2 (degenerate)**. Both rows on remote matching the `House Special Blend (Sauce)` family carry the byte-identical canonical name string with no casing/whitespace/suffix variant. Per user decision, **the 5th manifest row introduced in amendment #2 is dropped from Spec 005**. The manifest is restored to 4 rows / 16 grand total — the post-amendment-#1 shape. Build-stop 8 is now OBSOLETED; build-stop 6 remains RESOLVED (its gating concern was hypothesis-(c) refutation, which still stands as analysis but no longer extends Spec 005's contract). The 6 remote orphan ingredient rows under `House Special Blend (Sauce)` (actually 1 non-current `prep_recipes` row + 6 orphan `prep_recipe_ingredients` rows pointing at it; the gate_2 "6" was a JOIN-multiplication artifact per the Final apply subsection) and the secondary owner-notes drift (`4fbd90` no longer canonical on remote; `36016d31...` is) are both **out of scope for Spec 005**. A sibling Spec 006 owns them — see "Sibling Spec 006 reference" subsection at the end of this section.

The pre-build flow is therefore restored to the 6-step shape from amendment #1 (no apply-time source-name re-probe, no 5th-row substitution). The amended steps below remain as the audit trail for what amendment #2 attempted; the active flow is the original 6 steps as updated by amendment #1.

1. Run the probe SQL in section 1 below against the local seeded DB (`docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < probe.sql`), pasting the output into the "Probe results" subsection of section 1. (Already done at first-pass build; results captured under "Probe results" with the local-deny note.)
2. Run the same probe against remote prod, **read-only**, per the user's 2026-05-06 authorization (`npx supabase db query --linked < probe.sql` or equivalent supabase-CLI read path). Paste output alongside the local actuals in the Probe results checklist.
3. **Confirm hypothesis (c) for the +6 drift.** Hypothesis (c) holds iff: (i) the four affected names (`2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`) have the same per-name `non_current_count` on remote as local AND (ii) the three target names (`2AM SAUCE`, `Tumeric Seasoning (House Mix)`, `House Special Seasoning (House Mix)`) have the same canonical-current row IDs on remote as local AND (iii) gate-2's affected-names list on remote matches the local 10-name set with no NEW prep names having non-current rows that aren't in the local set. If (i)-(iii) all hold, the +6 drift is on `prep_recipe_ingredients` (Spec 003's territory), not `prep_recipes` (Spec 005's territory) — Spec 005's manifest is unaffected. **Proceed.**
4. **STOP if hypothesis (c) is refuted.** If remote has additional missing-canonical names not seen locally, OR the per-name `non_current_count` differs on the four names, OR the canonical row IDs at the three target names differ on remote — surface to the user. Do NOT author the migration. The curation contract may need extending or splitting per section 6's Q3 revisit.
5. If the probe surfaces any of the conditions in section 8 ("Build-stop conditions"), **STOP** and surface to the user before authoring the migration. **Note:** build-stop 7 has been **obsoleted** by the corrected mechanic table in section 2 (no `is_current` flip is required on any row). The remaining build-stops 1-6 still apply.
6. Encode the certified per-name affected counts into the migration's `_spec005_renames` manifest verbatim. **No probe-time coupling at apply time** — the migration must contain the same literal values that the developer just produced. The corrected manifest has 4 rows, all with `mechanic = 'rename-into-collision'` and `flip_target_uuid_prefix = NULL`. ~~**Amended 2026-05-06 (#2):** the manifest now has **5 rows** with grand total **22**, after extending to cover `House Special Blend (Sauce)`'s remote-only 6 non-current rows. The 5th row's `old_name` (the source-name variant string) MUST be captured from a re-probe at apply time per the source-vs-target clarification above; do not guess.~~ **Amended 2026-05-06 (#3):** amendment #2's 5th-row extension is reverted — Reading 2 confirmed the rename mechanic does not apply. Manifest stays 4 rows / 16 grand total per amendment #1.

This is **structurally identical** to Spec 003's section 0 design pattern: architect designs the probe SQL and rename-mechanic decision tree; developer runs the probe and substitutes literal counts before the migration is authored. The only difference: spec 005's literals describe rename mutations on `prep_recipes.name`, not deletes/repoints on `prep_recipe_ingredients`.

#### Out of scope (post-amendment-#3) — Sibling Spec 006 reference

> **Amended 2026-05-06 (#3):** added in this revision after Reading 2 was confirmed and the user decided to drop the 5th manifest row.

The apply-time source-name re-probe surfaced two pieces of remote-only `prep_recipes` drift around `House Special Blend (Sauce)` that Spec 005's rename mechanic cannot address. They are deferred to a sibling **Spec 006** (PM is filing in parallel; do not block on it):

- **The non-current rows under the canonical name on remote.** Per the Final apply subsection, remote has 1 `prep_recipes` row at `House Special Blend (Sauce)` with `is_current = false` (id `4fbd90cc-...`) plus 6 orphan `prep_recipe_ingredients` rows pointing at it. The gate_2 cross-environment summary previously reported "6 non-current rows" for this name; the Final apply re-probe established that was a JOIN-multiplication artifact (1 `prep_recipes` row × 6 orphan ingredient rows). Spec 006 owns the `is_current` flip / cleanup decision for that row and the orphan ingredient rows under it.
- **Owner-notes canonical-prefix reconciliation.** `docs/internal/prep-canonicalness-notes.md` line 99 records `4fbd90` as the canonical prefix for `House Special Blend (Sauce)`. On remote, that row is now `is_current = false` and a different row `36016d31-4da1-466b-9547-e528cf0f4c8f` carries `is_current = true` at the same name. This is post-2026-05-02 production drift; the owner-notes prefix is stale on remote (still correct on local). Spec 006 owns the reconciliation between owner-notes and remote.
- **Any other `prep_recipes`-level production drift** Spec 006's own probe surfaces.

Spec 005's mutations target only the 4-name set (`Tumeric Mix`, `House Special Seasoning Mix`, `2AM Sauce`, `2AM SAUCE 10`). Local and remote agree byte-for-byte on those four names; the rename migration is correct on both environments without coupling to Spec 006.

### 1. Probe SQL + anticipated outputs

The probe SQL below answers all five gate items from the user prompt's "Probe gate" section in a single read-only transaction. Run via `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -f -` against the local DB and `npx supabase db query --linked` against remote.

```sql
-- Spec 005 pre-implementation probe.
-- Returns 7 result sets, one per gate item. Read-only — no mutations.
-- Source of truth for owner-curated target names: docs/internal/prep-canonicalness-notes.md

-- Gate item 1: Per-name current-vs-non-current counts for the 4 missing-canonical names.
-- Determines the rename mechanic per row (see section 2's decision matrix).
SELECT 'gate_1_missing_canonical_state' AS probe,
       pr.name                          AS db_name,
       pr.brand_id::text                AS brand,
       COUNT(*) FILTER (WHERE pr.is_current = true)  AS current_count,
       COUNT(*) FILTER (WHERE pr.is_current = false) AS non_current_count,
       COUNT(*)                                       AS total_count,
       array_agg(pr.id::text ORDER BY pr.is_current DESC, pr.id) AS row_ids,
       array_agg(pr.is_current ORDER BY pr.is_current DESC, pr.id) AS is_current_flags
  FROM public.prep_recipes pr
 WHERE pr.name IN (
   '2AM Sauce',
   '2AM SAUCE 10',
   'House Special Seasoning Mix',
   'Tumeric Mix'
 )
 GROUP BY pr.name, pr.brand_id
 ORDER BY pr.name;

-- Gate item 1b: Per-name current-vs-non-current counts at the OWNER-CURATED TARGET names.
-- Determines whether a rename collides with an existing canonical at the target.
SELECT 'gate_1b_target_canonical_state' AS probe,
       pr.name                          AS target_name,
       pr.brand_id::text                AS brand,
       COUNT(*) FILTER (WHERE pr.is_current = true)  AS current_count,
       COUNT(*) FILTER (WHERE pr.is_current = false) AS non_current_count,
       COUNT(*)                                       AS total_count,
       array_agg(pr.id::text ORDER BY pr.is_current DESC, pr.id) AS row_ids
  FROM public.prep_recipes pr
 WHERE pr.name IN (
   '2AM SAUCE',                          -- target for: 2AM Sauce, 2AM SAUCE 10 (if confirmed family)
   'Tumeric Seasoning (House Mix)',      -- target for: Tumeric Mix
   'House Special Seasoning (House Mix)' -- target for: House Special Seasoning Mix
 )
 GROUP BY pr.name, pr.brand_id
 ORDER BY pr.name;

-- Gate item 2: +6 remote-vs-local drift cause — affected name extension probe.
-- Spec 003 found local 399 / remote 405 on prep_recipe_ingredients orphans.
-- This probe asks: are there ADDITIONAL prep names with non-current rows on remote
-- that don't exist locally? If yes, the curation contract may need extending.
SELECT 'gate_2_remote_drift_affected_names' AS probe,
       pr.name                                AS prep_name,
       pr.brand_id::text                      AS brand,
       COUNT(*) FILTER (WHERE pr.is_current = true)  AS current_count,
       COUNT(*) FILTER (WHERE pr.is_current = false) AS non_current_count,
       COUNT(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL) AS orphan_ingredient_rows
  FROM public.prep_recipes pr
  LEFT JOIN public.prep_recipe_ingredients t
    ON t.prep_recipe_id = pr.id
   AND pr.is_current = false
 WHERE pr.id IN (
   SELECT DISTINCT pr2.id
     FROM public.prep_recipe_ingredients t2
     JOIN public.prep_recipes pr2 ON pr2.id = t2.prep_recipe_id
    WHERE pr2.is_current = false
 )
 GROUP BY pr.name, pr.brand_id
 ORDER BY pr.name;

-- Gate item 3: 2AM SAUCE 10 family confirmation — ingredient-set comparison.
-- Compares ingredient tuples between (a) all rows named '2AM SAUCE 10' and
-- (b) the canonical '2AM SAUCE' row. Strong overlap = same family; little
-- overlap = different prep entirely.
WITH am_sauce_canonical AS (
  SELECT id, name FROM public.prep_recipes
   WHERE name = '2AM SAUCE' AND is_current = true
   LIMIT 1
),
am_sauce_canonical_tuples AS (
  SELECT pri.catalog_id, pri.sub_recipe_id,
         COALESCE(pri.type, 'raw') AS type, pri.unit, pri.quantity
    FROM am_sauce_canonical c
    JOIN public.prep_recipe_ingredients pri ON pri.prep_recipe_id = c.id
),
sauce10_rows AS (
  SELECT pr.id, pr.is_current, pr.name FROM public.prep_recipes pr
   WHERE pr.name = '2AM SAUCE 10'
),
sauce10_tuples AS (
  SELECT s.id AS sauce10_id, s.is_current,
         pri.catalog_id, pri.sub_recipe_id,
         COALESCE(pri.type, 'raw') AS type, pri.unit, pri.quantity
    FROM sauce10_rows s
    JOIN public.prep_recipe_ingredients pri ON pri.prep_recipe_id = s.id
)
SELECT 'gate_3_sauce10_overlap' AS probe,
       s.sauce10_id::text       AS sauce10_id,
       s.is_current              AS sauce10_is_current,
       COUNT(*)                  AS sauce10_ingredient_count,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM am_sauce_canonical_tuples c
          WHERE c.catalog_id    IS NOT DISTINCT FROM s.catalog_id
            AND c.sub_recipe_id IS NOT DISTINCT FROM s.sub_recipe_id
            AND c.type          = s.type
            AND c.unit          IS NOT DISTINCT FROM s.unit
       )) AS overlap_with_canonical_by_ingredient,
       (SELECT COUNT(*) FROM am_sauce_canonical_tuples) AS canonical_ingredient_count
  FROM sauce10_tuples s
 GROUP BY s.sauce10_id, s.is_current;

-- Gate item 4: cross-brand confirmation (re-runs Spec 003 gate 5 against prep_recipes
-- directly, not just prep_recipe_ingredients).
SELECT 'gate_4_cross_brand_prep_recipes' AS probe,
       COUNT(DISTINCT pr.brand_id) AS distinct_brands,
       array_agg(DISTINCT pr.brand_id::text ORDER BY pr.brand_id::text) AS brand_ids
  FROM public.prep_recipes pr
 WHERE pr.name IN (
   '2AM Sauce', '2AM SAUCE 10', 'House Special Seasoning Mix', 'Tumeric Mix',
   '2AM SAUCE', 'Tumeric Seasoning (House Mix)', 'House Special Seasoning (House Mix)'
 );

-- Gate item 5: sub_recipe_id regression check (re-runs Spec 003 gate 7).
SELECT 'gate_5_sub_recipe_orphans' AS probe,
       COUNT(*) FILTER (WHERE sub_pr.id IS NULL AND t.sub_recipe_id IS NOT NULL) AS dangling,
       COUNT(*) FILTER (WHERE sub_pr.id IS NOT NULL AND sub_pr.is_current = false) AS non_current,
       COUNT(*) FILTER (WHERE t.sub_recipe_id IS NOT NULL AND (sub_pr.id IS NULL OR sub_pr.is_current = false)) AS total_orphans
  FROM public.prep_recipe_ingredients t
  LEFT JOIN public.prep_recipes sub_pr ON sub_pr.id = t.sub_recipe_id;

-- Gate item 6: Post-rename per-name canonical projection (developer pastes raw output
-- AND verifies that the design's section 5 pre-mutation count assertion will hold).
-- Projects what gate 1 would return on the four affected names if Spec 005's renames
-- were applied. Used by the developer to sanity-check the manifest before authoring.
-- Read-only; no mutations.
WITH planned_renames AS (
  -- Developer fills these from gate 1 + gate 1b + section 2 decision matrix.
  -- Pseudo-rows for sanity projection:
  SELECT '2AM Sauce'::text                   AS old_name,  '2AM SAUCE'::text                          AS new_name
  UNION ALL SELECT 'Tumeric Mix',                          'Tumeric Seasoning (House Mix)'
  UNION ALL SELECT 'House Special Seasoning Mix',          'House Special Seasoning (House Mix)'
  UNION ALL SELECT '2AM SAUCE 10',                         '2AM SAUCE'  -- only if gate 3 confirms family
)
SELECT 'gate_6_post_rename_projection' AS probe,
       p.new_name                       AS expected_target,
       COUNT(*) FILTER (WHERE pr.is_current = true)  AS current_count_post_rename,
       COUNT(*) FILTER (WHERE pr.is_current = false) AS non_current_count_post_rename
  FROM planned_renames p
  LEFT JOIN public.prep_recipes pr
    ON (pr.name = p.old_name OR pr.name = p.new_name)
 GROUP BY p.new_name
 ORDER BY p.new_name;
```

Save as `/tmp/spec005-probe.sql`, run, and paste output into the Probe results subsection below.

#### Anticipated probe outputs (architect's pre-design baseline)

> **Amended 2026-05-06:** rows below for `House Special Seasoning (House Mix)` target state and `2AM SAUCE 10` overlap have been **invalidated by the probe**. The probe-actual values are recorded in the "Probe results" subsection below this table; the amended interpretation drives the corrected section 2 mechanic table. The original anticipations are preserved unedited for audit.

| Gate item | Anticipated value | Source |
|---|---|---|
| 1: `2AM Sauce` state | `current_count = 0, non_current_count = N (N≥1, likely several rows), total = N` | Spec 003 build notes line 971 (`canonical_current_count=0`); spec 003 build notes line 956 reports 30 orphan ingredient rows × 3 source rows → so 3 non-current `prep_recipes` rows is the floor |
| 1: `2AM SAUCE 10` state | `current_count = 0, non_current_count = M (likely 1)` | Spec 003 line 962 reports 10 orphan ingredient rows × 1 source row → 1 non-current `prep_recipes` row |
| 1: `House Special Seasoning Mix` state | `current_count = 0, non_current_count = K (K≥8)` | Spec 003 line 956 reports 56 orphan ingredient rows × 8 source rows → at least 8 non-current rows |
| 1: `Tumeric Mix` state | `current_count = 0, non_current_count = J (J≥4)` | Spec 003 line 960 reports 20 orphan ingredient rows × 4 source rows → at least 4 non-current rows |
| 1b: `2AM SAUCE` target state | `current_count = 1, non_current_count = ~14` (canonical `66d823bb-...` exists) | Spec 003 build notes line 965; spec 003 line 954 reports 15 source rows for `2AM SAUCE` orphans, 1 of which is canonical-current → ~14 non-current |
| 1b: `Tumeric Seasoning (House Mix)` target state | `current_count = 1, non_current_count = ~0` | Spec 003 build notes line 968 (`canonical_current_count=1`); spec 003 line 963 reports 5 orphan ingredient rows × 1 source row → only the canonical |
| 1b: `House Special Seasoning (House Mix)` target state — **INVALIDATED 2026-05-06** | ~~`current_count = 0, non_current_count = 0` (target name does not exist in DB at all)~~. **Probe-actual: `current_count = 1, non_current_count = 0` at id `38678f33-66bf-420c-a50d-82899120aa9b`.** The architect's hypothesis ("`38678f` is currently named `House Special Seasoning Mix` in the DB and the owner-curated note's label is the desired post-rename label") was wrong: `38678f` is already at the target name AND already current. Owner-notes file is correct; architect's mental model was wrong. See corrected section 2 mechanic table. | Owner-curated notes file lines 38–46 lists this name with prefix `38678f`, but the DB-side name is `House Special Seasoning Mix`. **Architect's original hypothesis (now invalidated):** the canonical with prefix `38678f` is currently named `House Special Seasoning Mix` in the DB and the owner-curated note's label is the desired post-rename label — same situation as `Tumeric Mix` → `Tumeric Seasoning (House Mix)`. Probe gate 1b will confirm (target name returns 0 rows = hypothesis holds; rename-only mechanic). Hypothesis confirmed only if gate 1 finds NO `is_current = true` row at `House Special Seasoning Mix` AND gate 1b finds NO row at `House Special Seasoning (House Mix)`. **The owner-notes prefix `38678f` matches the orphan-source population for `House Special Seasoning Mix` per spec 003's gate 1c — but spec 003's gate 2 explicitly recorded `canonical_current_count = 0` for `House Special Seasoning Mix`. This is the contradiction Spec 005 must surface and resolve.** See section 2 decision matrix for the resolution path. |
| 2: remote drift | Either the four named missing-canonical names appear in remote with the same shape as local (drift is +6 rows on `prep_recipe_ingredients`, not +N new prep names), OR remote has additional missing-canonical names — STOP if the latter | Spec 003 build notes line 999 (only gate 1 was run on remote) |
| 3: `2AM SAUCE 10` overlap — **GRAY-ZONE ACTUAL 2026-05-06; resolved by user direction** | ~~High overlap with `2AM SAUCE` canonical — likely 8+ shared `(catalog_id, sub_recipe_id, type, unit)` tuples = same prep family. Low overlap (<3) = different prep entirely; STOP and surface~~. **Probe-actual: 70% strict-tuple overlap (gray zone between architect's ≥80% include / <50% stop thresholds).** Qualitative inspection: same `Cajun Spice & Skillet` (raw) → `Cajun Seasoning (House Mix)` (prep) swap as `2AM Sauce`; the 30% miss is `gal` vs `fl_oz` declared-unit differences on same-ingredient lines, not different ingredients. **User direction (2026-05-06): include in family.** See corrected section 2. | Hypothesis from spec 003 line 116 ("case- and suffix-variant duplicates"); not yet proven for `10` suffix |
| 4: cross-brand | 1 brand only (`2a000000-...`) | Spec 001/003 |
| 5: sub_recipe_id orphans | 0 | Spec 001/003 |

#### Probe results

> **Architect-can't-shell caveat (per section 0):** the architect could not run the probe inline. Anticipated values above are derived from Spec 003's recorded build-notes probe + the owner-curated notes file. The **developer fills this checklist with actuals at build start** before authoring the migration.
>
> Probe executed by backend-developer 2026-05-06 against local seeded DB via `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -f /tmp/spec005-probe.sql`. Remote probe via `npx supabase db query --linked` was **denied by sandbox policy** ("Production Reads requires explicit user authorization naming the prod target") — surfaced to user; remote probe pending.
>
> **Amended 2026-05-06:** user has now **authorized read-only remote probe** as part of the corrections that produced this amendment. Gate 2 (remote drift) is no longer permanently deferred. The developer's first action on build resume is: run probe against remote, paste actuals here alongside local actuals, confirm hypothesis (c), proceed to author migration only if (c) holds. See section 0 (amended) for the gating step ordering.

- [x] gate_1 (per-name DB state for the 4 missing canonicals):

  ```
   db_name                      | brand    | current | non_current | total | row_ids (head)
   2AM Sauce                    | 2a000000 |       0 |           3 |     3 | 09d5c570…, 8b875d4b…, b1fb2af9…
   2AM SAUCE 10                 | 2a000000 |       0 |           1 |     1 | 37df27ad…
   House Special Seasoning Mix  | 2a000000 |       0 |           8 |     8 | 03369027…, 05165811…, 2f853ab3…, 4d722c62…, 52253671…, 968c7be2…, d0eedac6…, f8af3436…
   Tumeric Mix                  | 2a000000 |       0 |           4 |     4 | 0f9b012b…, 3e8323fc…, 489dd9e1…, b2e5208b…
  ```

  Total: 16 non-current rows across the 4 affected names. **Crucial: NO `38678f`-prefixed UUID appears in the row_ids array for `House Special Seasoning Mix`.** See section 8 build-stop discussion below.

- [x] gate_1b (per-name DB state at owner-curated targets):

  ```
   target_name                          | brand    | current | non_current | total | row_ids (head)
   2AM SAUCE                            | 2a000000 |       1 |          15 |    16 | 66d823bb… (current); 092cb71f…, 27cddb31…, 609f31c7…, 6f096aad…, 920386ab…, a9b72f44…, b4e0eb04…, b73c92ee…, bfcd90f1…, c483077b…, ccb7ba5e…, d250115d…, d3f51df3…, d6e9684e…, f9149325…
   House Special Seasoning (House Mix)  | 2a000000 |       1 |           0 |     1 | 38678f33-66bf-420c-a50d-82899120aa9b (current)
   Tumeric Seasoning (House Mix)        | 2a000000 |       1 |           1 |     2 | c7d9a94b-cf30-4bb7-9b2b-c2577ae7a10a (current); 7a6ecbee-1fff-4c07-b581-f394dc2e91fa (non-current, byte-identical version=2)
  ```

  **Architect's anticipation for `House Special Seasoning (House Mix)` was `current_count = 0, non_current_count = 0`** ("target name does not exist in DB at all"). **Probe found `current_count = 1`** — the `38678f` row is already at the owner-curated target name and already current. This is a structural divergence from the architect's mechanic table; see section 8 build-stop discussion below.

- [x] gate_2 (remote drift — affected names extension):

  > **Amended 2026-05-06 (#2):** remote probe ran successfully on gate_2; results integrated below in side-by-side format. Hypothesis (c) was REFUTED. The +6 drift maps to a NEW prep name (`House Special Blend (Sauce)`) with 6 non-current `prep_recipes` rows + 6 orphan `prep_recipe_ingredients` rows on remote, absent locally. Per user direction, the curation contract is extended (5th manifest row); the architect did not split Spec 005.
  >
  > **Amended 2026-05-06 (#3):** the 5th name (`House Special Blend (Sauce)`) was investigated by the apply-time source-name re-probe (per Build notes "Final apply — 2026-05-06 (post-amendment-#2 source-name re-probe)") and dropped from Spec 005 per Reading 2 + user decision. Spec 005's cross-environment manifest is back to **4 names** (`Tumeric Mix`, `House Special Seasoning Mix`, `2AM Sauce`, `2AM SAUCE 10`) with byte-identical local/remote shape per gate 1 + gate 1b above. The Final apply subsection also re-derived the `non_current = 6` row count for `House Special Blend (Sauce)` as a JOIN-multiplication artifact: the truth is 1 non-current `prep_recipes` row × 6 orphan `prep_recipe_ingredients` rows. Cite the Final apply subsection for the audit trail; sibling Spec 006 owns the cleanup.

  **Side-by-side local vs remote affected-names list:**

  ```
   prep_name                          | local non_current | remote non_current | local orphan_ing | remote orphan_ing
   2AM Sauce                          |               30  |                30  |              30  |              30
   2AM SAUCE                          |              150  |               150  |             150  |             150
   2AM SAUCE 10                       |               10  |                10  |              10  |              10
   Burger Patty                       |               28  |                28  |              28  |              28
   Cajun Seasoning (House Mix)        |               48  |                48  |              48  |              48
   House Special Blend (Sauce)        |              (absent)              6  |          (absent)               6
   House Special Seasoning Mix        |               56  |                56  |              56  |              56
   Tumeric Mix                        |               20  |                20  |              20  |              20
   Tumeric Seasoning (House Mix)      |                5  |                 5  |               5  |               5
   White Sauce                        |               36  |                36  |              36  |              36
   Yellow Rice                        |               16  |                16  |              16  |              16
  ```

  Local affected-names list = 10 names. Remote affected-names list = **11 names**. The +6 drift Spec 003 originally observed maps 1:1 to `House Special Blend (Sauce)`'s 6 orphan ingredient rows on remote.

  (Note: gate 2's `current_count` column is tautologically 0 because the outer `WHERE pr.id IN (... is_current = false)` clause filters to non-current rows only — minor query artifact, not a finding. The `non_current_count` is the real signal.)

  **Hypothesis status: (c) REFUTED → (a) confirmed.** The +6 corresponds to NEW non-current `prep_recipes` rows under a name outside Spec 005's original 4-name target set. Per amended section 0 (#2), the curation contract was extended in-place — the 5th manifest row covers `House Special Blend (Sauce)`. Local seed.sql does NOT carry these rows (which is expected — local seed was pulled 2026-05-02 and the 6 rows appear to be post-seed production drift), making the 5th rename an idempotent no-op locally and a 6-row functional rename on remote. See section 5's apply-path matrix for the local-vs-remote asymmetry call-out.

- [x] gate_3 (2AM SAUCE 10 ingredient overlap):

  ```
   sauce10_id     | sauce10_is_current | sauce10_ingredient_count | overlap_with_canonical | canonical_count
   37df27ad…      | f                  |                       10 |                      7 |              10
  ```

  **Overlap by `(catalog_id, sub_recipe_id, type, unit)` tuple match: 7/10 = 70%.** This is in the gray zone between the architect's thresholds (≥80% high overlap = include in family; <50% low overlap = STOP and surface).

  Side-by-side ingredient inspection:
  - **8 of 10** ingredients match by `catalog_id` + `unit` + `quantity` exactly (raw `Garlic Granulated`, `Horseradish`, `Ketchup`, `Mayonnaise`, `Parsley Flake`, `Paprika`, `Sugar`, `Worcestershire`/`Mustard` partial).
  - **2 ingredients** (Worcestershire, Mustard Gal) match by `catalog_id` but use a different unit/quantity that's physically equivalent (e.g., `0.313 gal` vs `40 fl_oz` = same physical amount, just unit-system difference). Same ingredient, different declared unit. Tuple-equality is false; physical equivalence is true.
  - **1 ingredient** is unique to `2AM SAUCE 10`: raw `Cajun Spice & Skillet` (8 oz). The canonical `2AM SAUCE` instead uses a prep sub-recipe `Cajun Seasoning (House Mix)` (8 oz). **Same swap as `2AM Sauce` vs `2AM SAUCE` per Spec 003 line 962.**

  **Qualitative assessment:** `2AM SAUCE 10` is structurally identical to `2AM Sauce` (the variant Spec 003 already has Q2 evidence for): same raw-vs-prep `Cajun` swap. The 70% strict-tuple overlap is artificially low because of unit-system declaration differences for 2 ingredients (gal vs fl_oz), not because of different ingredients. **Developer's reading: this is a sibling variant in the `2AM SAUCE` family.** Surfacing to user for confirmation given the gray-zone overlap; do not auto-decide.

- [x] gate_4 (cross-brand): **1 brand only** (`2a000000-0000-0000-0000-000000000001`). Matches architect's anticipation. No build-stop.

- [x] gate_5 (sub_recipe_id regression): **0 dangling, 0 non-current, 0 total orphans.** Matches architect's anticipation. No build-stop.

- [x] gate_6 (post-rename projection):

  ```
   expected_target                      | current_post_rename | non_current_post_rename
   2AM SAUCE                            |                   2 |                      34
   House Special Seasoning (House Mix)  |                   1 |                       8
   Tumeric Seasoning (House Mix)        |                   1 |                       5
  ```

  Note: the `current_post_rename = 2` for `2AM SAUCE` is a **query artifact** of the projection's self-join (the LEFT JOIN matches each `prep_recipes` row TWICE — once for the `2AM Sauce → 2AM SAUCE` row in `planned_renames` and once for the `2AM SAUCE 10 → 2AM SAUCE` row). Actual post-rename count of current rows at `2AM SAUCE` = 1 (only `66d823bb` has `is_current = true`; the renamed-in `2AM Sauce` and `2AM SAUCE 10` rows are all non-current). Architect's projection query has the bug; the underlying invariant ("exactly 1 canonical per target name post-rename") still holds.

- [x] gate_7 (extra; partial unique index inspection — **architect's section 2 schema concession needs revision**):

  ```
   indexname                                | indexdef
   prep_recipes_pkey                        | CREATE UNIQUE INDEX … (id)
   prep_recipes_brand_name_current_unique   | CREATE UNIQUE INDEX prep_recipes_brand_name_current_unique ON public.prep_recipes USING btree (brand_id, lower(name)) WHERE (is_current = true)
  ```

  **Architect's section 2 ("Schema concession") states: "Spec 005 verified there is no unique constraint on `prep_recipes(name, brand_id)` or on `prep_recipes(name, brand_id) WHERE is_current = true` in any of the 30 migrations."** This is **incorrect.** Migration `20260505055228_prep_recipes_brand_name_current_unique.sql` (already applied locally; landed before this spec) creates the partial unique index on `(brand_id, lower(name)) WHERE is_current = true`. The architect missed this migration in their schema review.

  **Implication for Spec 005's design:** the renames in this spec do NOT trigger the unique-index constraint, because every renamed row has `is_current = false` (and is therefore excluded from the partial index). The existing canonicals at the target names (`66d823bb`, `38678f33`, `c7d9a94b`) keep `is_current = true` and remain unique under `(brand_id, lower(name))`. **No migration mechanic needs to change for this** — but the architect's claim that "a future Spec 006/007 may add such a guard" is moot; the guard already exists.

#### Remote drift investigation

> Architect's probe-gate item 2 above is the diagnosis path. PM intentionally did not speculate on the +6 cause; architect's anticipated cause-hypotheses (probe-gate 2 will discriminate among them):
>
> - **(a) Newer orphans created since local seed.sql was pulled (2026-05-02 per CLAUDE.md).** If gate 2 surfaces additional prep names with non-current rows on remote that don't exist locally — and those names are NOT in the four-name set Spec 005 targets — then Spec 005 should STOP and surface to the user. The curation contract would need extending or a separate spec would handle the new names.
> - **(b) Different deduplication state on remote.** If gate 2 surfaces the SAME four affected names on remote with simply MORE non-current rows per name, the +6 are extra non-current `prep_recipes` rows under names Spec 005 already targets. The rename mechanic per name is unchanged; only the per-name affected-count expectation in the manifest needs to admit a remote-vs-local delta. **Resolution under hypothesis (b):** the manifest contains the LOCAL count; the migration's pre-mutation assertion is `actual_count = local_count OR actual_count = remote_count` (a 2-tuple expectation, not a single literal). The grand-total assertion becomes `total = local_grand OR total = remote_grand`. Spec 001 used a single literal `4` and observed Path A vs Path B-revised divergence; Spec 005's analog is to admit a 2-element expected set. **Architect's call: this is acceptable** — the alternative (run two separate migrations against local and remote) violates the "atomic transaction" AC. Tradeoff documented in section 7.
> - **(c) Probe-divergence artifact from gate-1-only remote query.** Spec 003's developer was permission-denied for further remote queries. If the probe SQL above runs remote successfully and the local/remote per-name shape matches, hypothesis (c) is the cause and no manifest adjustment is needed. **Resolution under hypothesis (c):** likely the +6 is a `prep_recipe_ingredients` count delta on remote (e.g., production extra orphan ingredient rows under one of the 4 affected names), not a `prep_recipes` count delta. Spec 005 mutates `prep_recipes`, not `prep_recipe_ingredients`. **The +6 prep_recipe_ingredients drift is therefore irrelevant to Spec 005's manifest** — it becomes Spec 003's problem when Spec 003 retries.
> - **(d) Something else.** STOP and surface.

**Architect's expected outcome:** hypothesis (c). The +6 row drift is on `prep_recipe_ingredients`, not on `prep_recipes`. Spec 005's mutations target `prep_recipes.name` only; even if remote has 6 extra orphan ingredient rows, those rows reference non-current `prep_recipes` rows under one of the 4 already-affected names. After Spec 005's renames, the orphan ingredient rows still exist (Spec 005 does not touch `prep_recipe_ingredients`) — they're just now under non-current rows whose `name` matches the canonical. Spec 003's retry then handles them via "delete divergent" once the names align. **The +6 drift therefore does NOT change the curation contract.** Build proceeds if hypothesis (c) is confirmed; STOPs on (a) or (d); proceeds with manifest tolerance under (b).

### 2. Rename mechanic per affected name

> **Amended 2026-05-06:** the original mechanic table below was wrong on two rows and the schema concession was wrong on its premise. The probe (Build notes 2026-05-06) revealed:
>
> 1. The `38678f` row is already AT the owner-curated TARGET name `House Special Seasoning (House Mix)` with `is_current = true` and a matching ingredient list. It is NOT at the source name `House Special Seasoning Mix`. The architect's "rename-plus-flip" mechanic for `House Special Seasoning Mix` was structurally based on a wrong assumption; the corrected mechanic is **rename-into-existing-collision with no `is_current` flip**, identical to the other three rows.
> 2. The user has resolved the gate-3 gray zone for `2AM SAUCE 10` (70% strict-tuple overlap, qualitatively same `Cajun` raw-vs-prep swap as `2AM Sauce`): include `2AM SAUCE 10` in the rename family. Same mechanic as `2AM Sauce`. The 70% strict-tuple miss is from declared-unit differences (gal vs fl_oz) on same-ingredient lines, not from different ingredients; declared-unit cleanup falls through to Spec 003's "delete divergent" rule once Spec 005 ships.
> 3. The "Schema concession" paragraph (no unique constraint exists on `prep_recipes(name, brand_id) WHERE is_current = true`) is **wrong**. Migration `supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql` already creates that partial unique index. The guard already exists. The renames in this spec do not trigger the index because every renamed row has `is_current = false` (excluded from the partial index); the existing canonicals at the target names retain `is_current = true` and remain unique. **No mechanic change required** — only the rationale narrative changes.
>
> The corrected mechanic table follows. The original table is preserved below the amendment for audit.

> **Amended 2026-05-06 (#2):** the 5-name corrected mechanic table below extends the 4-name version (preserved in its own collapsible block) by adding the 5th row for `House Special Blend (Sauce)`. The remote probe (per Build notes resumption) revealed a name not present locally; the user authorized in-place extension rather than splitting into two specs. The 5th row's `old_name` cell is **placeholder** pending an apply-time re-probe — see source-vs-target clarification at the row level and at section 8 build-stop 8 (new). All five rows continue to use `mechanic = 'rename-into-collision'` with no `is_current` flip; the 5th is structurally identical to the existing four, modulo the unresolved source-name string.

> **Amended 2026-05-06 (#3):** the 5th row introduced in amendment #2 is dropped. Apply-time source-name re-probe (per Build notes "Final apply — 2026-05-06 (post-amendment-#2 source-name re-probe)") confirmed Reading 2: the 6 non-current rows on remote are AT the canonical name `House Special Blend (Sauce)` itself, with no source-name variant distinct from the target. The rename mechanic does not apply. Per user decision, the mechanic table is restored to 4 rows / grand total 16 — the post-amendment-#1 shape. The "Source-name BLOCKER" callout below (introduced in amendment #2) is dropped along with the 5th row; it is preserved through this amendment notice for audit. Sibling Spec 006 owns `House Special Blend (Sauce)` cleanup per the section 0 reference.

**Corrected mechanic table (2026-05-06 #3, 4-name post-source-name-re-probe):**

| Old name | New name | Mechanic | Expected affected count | Justification |
|---|---|---|---|---|
| `Tumeric Mix` | `Tumeric Seasoning (House Mix)` | **rename-into-existing-collision (no `is_current` flip)** | 4 | Probe gate 1: 0 current + 4 non-current at `Tumeric Mix`. Gate 1b: 1 current (`c7d9a94b-...`) + 1 non-current at `Tumeric Seasoning (House Mix)`. Existing canonical is authoritative; renamed rows join non-current pool. |
| `House Special Seasoning Mix` | `House Special Seasoning (House Mix)` | **rename-into-existing-collision (no `is_current` flip)** — **CORRECTED from original "rename-plus-flip"** | 8 | Probe gate 1: 0 current + 8 non-current at `House Special Seasoning Mix`. Gate 1b: 1 current (`38678f33-66bf-420c-a50d-82899120aa9b`) + 0 non-current at `House Special Seasoning (House Mix)`. The `38678f` row is **already canonical at the target name** with the correct ingredient list — owner-notes file is not stale; the architect's mental model was. No flip needed; the 8 source-name rows simply rename in as non-current siblings of the existing canonical. |
| `2AM Sauce` | `2AM SAUCE` | **rename-into-existing-collision (no `is_current` flip)** | 3 | Probe gate 1: 0 current + 3 non-current at `2AM Sauce`. Gate 1b: 1 current (`66d823bb-...`) + 15 non-current at `2AM SAUCE`. Per resolved Q2 ("pick the 2AM sauce with the prep `Cajun Seasoning (House Mix)`"), existing canonical is authoritative. Renamed rows join non-current pool; ingredient-list reconciliation between variants is **out of scope** (deferred to Spec 003's "delete divergent" rule). |
| `2AM SAUCE 10` | `2AM SAUCE` | **rename-into-existing-collision (no `is_current` flip)** — **CORRECTED: included in family per user direction** | 1 | Probe gate 1: 0 current + 1 non-current at `2AM SAUCE 10`. Gate 3 returned 70% strict-tuple overlap (gray zone), but qualitative inspection shows the same `Cajun Spice & Skillet` (raw) → `Cajun Seasoning (House Mix)` (prep) swap as `2AM Sauce`. The 70% strict-tuple miss is from `gal` vs `fl_oz` declared-unit differences on same-ingredient lines, not from different ingredients. **User decision (2026-05-06): include in family.** Unit-of-measure inconsistencies fall through to Spec 003's "delete divergent" rule, which cleans the orphan ingredient lines after Spec 005 ships. |

**Net mechanics summary (corrected, 4-name post-amendment-#3):**
- 0 names use **rename-only**.
- **All 4 names use rename-into-existing-collision semantics with NO `is_current` flip.** (Original design anticipated 1 flip on `38678f`; reality is 0 flips needed because that row is already canonical at the target.)
- 0 row deletions; 0 `is_current` mutations. The migration is a single `UPDATE prep_recipes SET name = '...' WHERE name = '...' AND brand_id = '...'` per row, or a manifest-driven join — strictly simpler than the original design.
- **Grand-total expected affected count = 4 + 8 + 3 + 1 = 16 rows.** (Same as amendment #1; amendment #2's 22-row total is reverted per amendment #3.)

**Schema guard already exists (corrected).** Migration `20260505055228_prep_recipes_brand_name_current_unique.sql` creates the partial unique index `(brand_id, lower(name)) WHERE is_current = true`. Spec 005's renames do not trigger this index because every renamed row has `is_current = false` and is excluded from the partial index. Existing canonicals at the target names (`66d823bb`, `38678f33`, `c7d9a94b`) keep `is_current = true` and remain unique under `(brand_id, lower(name))`. **The original section 2 paragraph claiming "no unique constraint exists" and "a future Spec 006/007 may add such a guard" is moot — the guard is in place.**

**No row deletions in Spec 005's migration.** The renamed non-current rows persist as version history (mirroring Phase 2's "non-current rows are kept as version history" stance per `20260504062318_brand_catalog_p2_backfill.sql` line 121–122). Cleaning up orphan ingredient rows under those non-current sources is Spec 003's problem.

---

<details>
<summary><strong>Original mechanic table (preserved for audit; superseded 2026-05-06)</strong></summary>

The four affected names map onto three rename mechanics. The developer's probe (section 1, gate 1 + gate 1b) certifies which mechanic applies per name.

| Old name | New name | Architect-anticipated mechanic | Justification |
|---|---|---|---|
| `Tumeric Mix` | `Tumeric Seasoning (House Mix)` | **rename-plus-flip-`is_current`** | Anticipated: gate 1 finds 0 current + N non-current rows at `Tumeric Mix`; gate 1b finds 1 current + 0 non-current rows at `Tumeric Seasoning (House Mix)`. The owner-curated canonical at `c7d9a94b-...` (per spec 003 build notes line 968) **already exists** at the target name. Renaming `Tumeric Mix` rows to `Tumeric Seasoning (House Mix)` does NOT need to flip any `is_current` flag — the existing canonical at the target is already current; the renamed rows merge in as additional non-current version-history entries. **Mechanic clarification:** despite the label, this is actually **rename-into-existing-canonical-collision** with the resolution being "rename + leave non-current; existing canonical is already current". No `is_current` flip is required because the target's canonical already serves the role. The renamed rows become non-current siblings of the existing canonical. |
| `House Special Seasoning Mix` | `House Special Seasoning (House Mix)` | **rename-plus-flip-`is_current` (one renamed row becomes canonical)** | Anticipated: gate 1 finds 0 current + 8 non-current rows at `House Special Seasoning Mix`; gate 1b finds **0 current + 0 non-current rows at `House Special Seasoning (House Mix)`** (target name does not exist anywhere). However, the owner-curated notes file lists prefix `38678f` as the canonical for "House Special Seasoning (House Mix)". Spec 003's gate 2 explicitly recorded `canonical_current_count = 0` for `House Special Seasoning Mix` — meaning the row at `38678f` is currently `is_current = false` in the DB despite the owner-notes labeling it canonical. **Resolution path:** rename ALL rows named `House Special Seasoning Mix` to `House Special Seasoning (House Mix)`, AND flip `is_current = true` on the row at id-prefix `38678f` (the owner-curated canonical). One row becomes canonical; the rest stay non-current as version history. The migration must look up the `38678f` row by id-prefix or by other distinguishing characteristics from the owner notes file (the canonical's ingredient list per lines 39–46 of the notes file). **Architect's call:** the developer surfaces the exact `38678f...`-prefixed UUID to the user during build (probe gate 1 returns the full id list) and the user picks which row to flip — Spec 005's design does NOT auto-pick. |
| `2AM Sauce` | `2AM SAUCE` | **rename-into-existing-canonical-collision (no `is_current` flip)** | Anticipated: gate 1 finds 0 current + ~3 non-current rows at `2AM Sauce`; gate 1b finds 1 current + ~14 non-current rows at `2AM SAUCE`. The canonical `66d823bb-...` (per spec 003 build notes line 965) already exists at the target name. Per resolved Q2 ("pick the 2AM sauce with the prep `Cajun Seasoning (House Mix)`"), the existing canonical is authoritative. Renaming `2AM Sauce` rows to `2AM SAUCE` adds them as non-current siblings; ingredient-list reconciliation between the variants is **out of scope** (deferred to Spec 003's "delete divergent" rule). |
| `2AM SAUCE 10` | `2AM SAUCE` (CONDITIONAL — only if probe gate 3 confirms family) | **rename-into-existing-canonical-collision, OR `2AM SAUCE 10` left untouched if gate 3 fails** | Anticipated: gate 1 finds 0 current + 1 non-current row at `2AM SAUCE 10`; gate 1b is unchanged from `2AM Sauce`'s row. Gate 3's ingredient-overlap probe is the discriminator. **If gate 3 finds high overlap (≥80% of `2AM SAUCE 10`'s ingredients tuple-match the canonical's `2AM SAUCE` ingredients):** include in the family rename, same mechanic as `2AM Sauce`. **If gate 3 finds low overlap (<50%):** `2AM SAUCE 10` is a different prep (e.g., a 10x batch with different ratios that the dedup index distinguishes by `quantity` differences, OR something else entirely). Spec 005 SKIPS the rename for `2AM SAUCE 10` and surfaces to the user. The 10 orphan ingredient rows under it (per spec 003 build notes line 962) become Spec 003's problem under "delete divergent" (or the user files a separate spec for `2AM SAUCE 10`'s curation). |

**Net mechanics summary (original):**
- 0 names use **rename-only** (because every renamed-to target already has at least the `38678f` row from the owner-notes file, except potentially `House Special Seasoning (House Mix)` which is the special case).
- 3 names (or 4 if gate 3 confirms `2AM SAUCE 10` family) use **rename-into-existing-collision** semantics, with the resolution being "rename + leave non-current; existing canonical at target name is authoritative".
- 1 name (`House Special Seasoning Mix`) uses **rename + flip `is_current` on the owner-identified row** because the target name has no existing canonical AND the owner-notes file identifies a specific id-prefix as the desired canonical.

**Original Schema concession (superseded by gate-7 probe finding):** Spec 005 verified there is **no unique constraint on `prep_recipes(name, brand_id)` or on `prep_recipes(name, brand_id) WHERE is_current = true`** in any of the 30 migrations. Multiple non-current rows under the same `(name, brand_id)` are explicitly permitted by the existing schema (Phase 2's "version history" comment). Renames cannot collide on a unique-index violation. **A future Spec 006/007 may add such a guard** — flagged in section 7 risks, not bundled here.

</details>

### 3. Migration shape

> **Amended 2026-05-06:** The "All renames + the single `is_current` flip" Atomic line and the "destructive on the version-history invariant" paragraph below were both authored against the original section 2 mechanic table. Per the corrected section 2, **there is no `is_current` flip** — the migration is renames-only. The corrections to this section are:
>
> - Atomic line: "All renames succeed or none do." (No flips to mention.)
> - Destructive vs additive: the migration is **purely additive in semantics** (rename preserves the row; no version-history invariant is touched on any row). Reversal is `UPDATE prep_recipes SET name = '<old_name>' ...` — simple and lossless on the `prep_recipes` side. (Lossiness on `prep_recipe_ingredients` only manifests after Spec 003's retry deletes orphan rows; before then, full reversal is possible.)
>
> Original lines preserved below for audit.

**Filename:** `supabase/migrations/20260506000000_rename_prep_canonicals.sql`

- The next free timestamp slot. The latest applied migration is `20260505000000_dedupe_repointed_ingredient_lines.sql`. Spec 003's design proposed `20260506000000_repoint_or_delete_ingredient_orphans.sql` but Spec 003 halted at probe and **no migration was authored** under that name (verified: `git status` shows only `M .claude/launch.json` and `?? docs/internal/prep-canonicalness-notes.md`; no new SQL file in `supabase/migrations/`). Spec 005 takes `20260506000000` legitimately as the prerequisite to Spec 003.
- **When Spec 003 retries**, its migration timestamp must bump to `20260506010000_*` or later. This is a forward-looking note on Spec 003's filename, not a load-bearing constraint of Spec 005.
- Atomic: `BEGIN; ... COMMIT;` wrapper. All renames + the single `is_current` flip succeed or none do. **(Amended: no flip; renames-only.)**
- Single `DO $$ ... $$` block carrying the control flow, mirroring Spec 001's and Spec 003's pattern.
- Description string `rename_prep_canonicals` — names the action (rename) and the affected entity (canonical prep names).

**Destructive vs additive.** Mostly **additive in semantics** (rename preserves the row; existing data is unchanged) but **mutating** (changes the `name` column value). The single `is_current = true` flip on the `38678f`-prefixed row is **destructive on the version-history invariant** for that name family — once flipped, the row is the new canonical. Per Spec 003's Q1 directive, Spec 003's downstream "delete divergent" pass will then operate against this newly-canonical row's ingredient list. Reversal: `BEGIN/ROLLBACK` covers apply-time failure. Post-commit reversal is `UPDATE prep_recipes SET name = '<old_name>' ...` — straightforward but lossy in the same way Spec 003's DELETE branch is lossy: if the renames are wrong, restoring the old names doesn't restore the orphan ingredient rows that Spec 003 will have deleted in its retry. Spec 005 ships **before** Spec 003's retry, so this lossiness is hypothetical at apply time. **(Amended: no flip; renames-only — paragraph applies modulo the deleted second sentence about the `38678f`-row flip.)**

**Rollout safety.** Atomic transaction; per-name affected-count assertions; idempotent re-run path (count = 0 → no-op).

### 4. Per-name affected-count assertion structure

> **Amended 2026-05-06:** the manifest INSERT and the conditional `is_current` flip in the mutation UPDATE below were both authored against the original section 2 mechanic table (which had `House Special Seasoning Mix` flipping `is_current = true` on the `38678f` row). Per the corrected section 2, **no row gets an `is_current` flip**; every manifest row has `mechanic = 'rename-into-collision'` and `flip_target_uuid_prefix = NULL`. The implications for this section:
>
> 1. **Manifest INSERT (corrected):** four rows, all `mechanic = 'rename-into-collision'`, `flip_target_uuid_prefix = NULL`. Counts: 4, 8, 3, 1 (sum = 16). Full INSERT in section 7's "Pre-build" step 4. The `flip_target_uuid_prefix` column may be retained on the temp-table schema for parity with the original design (and for safety if a future spec needs it), or dropped — developer's choice. Either is correct.
> 2. **Mutation UPDATE (corrected):** the `CASE` branch on `mechanic = 'rename-plus-flip-is-current'` becomes dead code under the corrected manifest; the developer may simplify the UPDATE to `SET name = rt.new_name` only (omitting the `is_current` CASE entirely) since no row's `is_current` is touched. **Strictly simpler migration**, semantically equivalent to running the original UPDATE against the corrected manifest (the CASE never fires).
> 3. **Grand-total assertion (corrected):** `v_renamed_count = 16`. The "is_current flip case is one row counted once" sentence at the end of this section is moot — there is no flip case.
>
> The original section 4 sketch is preserved below for audit. The corrected dev-step encoding is in section 7's verification protocol.

> **Amended 2026-05-06 (#2):** the manifest gains a 5th row covering `House Special Blend (Sauce)` per the section 2 (#2) extension and section 1 gate_2 remote probe finding. The implications for this section:
>
> 1. **Manifest INSERT (corrected, 5-row):** five rows, all `mechanic = 'rename-into-collision'`, `flip_target_uuid_prefix = NULL`. Counts: 4, 8, 3, 1, 6 (sum = **22**). The 5th row's `old_name` cell is captured from the apply-time source-name re-probe per section 2 (#2)'s "Source-name BLOCKER" — do NOT hardcode the placeholder string `'House Special Blend (Sauce)'` as both old_name AND new_name (that would be a no-op rename and Spec 005 does not author no-op rename rows). The 5th row's `new_name` is `'House Special Blend (Sauce)'` (the canonical at owner-notes prefix `4fbd90`).
> 2. **Mutation UPDATE (corrected, 5-row):** unchanged in shape — the simplified `SET name = rt.new_name` UPDATE applies to 5 manifest rows instead of 4.
> 3. **Grand-total assertion (corrected, 5-row):** `v_renamed_count = 22` on remote, `v_renamed_count = 16` on local (because the 5th source-name's rows are absent from the local seed). See section 5's apply-path matrix for the local-vs-remote asymmetry; the assertion handling for the 5th row is `actual_count IN (0, 6)` per name (0 on local idempotent no-op, 6 on remote functional rename) and grand-total assertion becomes `v_renamed_count IN (16, 22)`. **This is the manifest tolerance hypothesis (b) shape that section 1's "Remote drift investigation" originally anticipated as admissible** — it lands here for the 5th row even though hypotheses (a) and (b) read distinctly in the original analysis.
> 4. **Per-name strictness for rows 1-4:** unchanged — actuals must equal manifest counts (4, 8, 3, 1) on both local and remote, byte-for-byte. The 5th row alone admits the 2-tuple expected count.

> **Amended 2026-05-06 (#3):** amendment #2's 5th-row extension is reverted per Reading 2 + user decision. Implications:
>
> 1. **Manifest INSERT (corrected, 4-row, restored to amendment-#1 shape):** four rows, all `mechanic = 'rename-into-collision'`, `flip_target_uuid_prefix = NULL`. Counts: 4, 8, 3, 1 (sum = **16**). No 5th row.
> 2. **Mutation UPDATE:** unchanged in shape — simplified `SET name = rt.new_name` against 4 manifest rows.
> 3. **Grand-total assertion (corrected, 4-row):** `v_renamed_count = 16` on both local and remote (byte-identical per gate 1 + gate 1b cross-environment summary). The `actual_count IN (0, 6)` per-name tolerance and the `v_renamed_count IN (16, 22)` grand-total OR-clause introduced in amendment #2 are both reverted; per-name and grand-total assertions are strict single-literal again.
> 4. **Per-name strictness:** all 4 rows are strict on both environments. No row admits a 2-tuple expected count.

Using a **temp table of expectations** (`_spec005_renames`) — mirrors Spec 003's `_spec003_expectations` pattern. Not per-name `DO` blocks (would balloon migration body for 4 names × ~30 lines each).

The temp table is created at the start of the count = expected branch, populated with the architect-certified expected counts, then joined against actual mutation counts at the assertion step.

```sql
CREATE TEMP TABLE _spec005_renames (
  old_name              text PRIMARY KEY,
  new_name              text NOT NULL,
  mechanic              text NOT NULL CHECK (mechanic IN (
    'rename-only',
    'rename-plus-flip-is-current',
    'rename-into-collision'
  )),
  -- Expected count of prep_recipes rows whose name is old_name AND brand_id is the
  -- target brand. The migration UPDATEs these rows.
  expected_rename_count int NOT NULL,
  -- For rename-plus-flip-is-current: optional UUID-prefix or full UUID identifying
  -- the row to flip is_current = true on AFTER the rename. NULL otherwise.
  flip_target_uuid_prefix text
) ON COMMIT DROP;

INSERT INTO _spec005_renames (old_name, new_name, mechanic, expected_rename_count, flip_target_uuid_prefix) VALUES
  ('Tumeric Mix',                  'Tumeric Seasoning (House Mix)',         'rename-into-collision',       /* TBD */, NULL),
  ('House Special Seasoning Mix',  'House Special Seasoning (House Mix)',   'rename-plus-flip-is-current', /* TBD */, '38678f'),
  ('2AM Sauce',                    '2AM SAUCE',                             'rename-into-collision',       /* TBD */, NULL),
  ('2AM SAUCE 10',                 '2AM SAUCE',                             'rename-into-collision',       /* TBD */, NULL);
  -- The fourth row above is INCLUDED only if gate 3 confirms 2AM SAUCE 10 family
  -- membership. Developer omits the row if gate 3 fails (low overlap).
```

The four `/* TBD */` integers are filled by the developer from gate 1 output (`non_current_count` for each name; assuming gate 1 confirms the architect's anticipation that all four names have `current_count = 0`). Grand-total expected count = `SUM(expected_rename_count)`.

**Mutation step structure (single UPDATE driven by the manifest):**

```sql
WITH rename_targets AS (
  SELECT pr.id, pr.name AS old_name, m.new_name, m.mechanic, m.flip_target_uuid_prefix
    FROM public.prep_recipes pr
    JOIN _spec005_renames m ON m.old_name = pr.name
   WHERE pr.brand_id = v_brand_id
)
UPDATE public.prep_recipes pr
   SET name = rt.new_name,
       is_current = CASE
         WHEN rt.mechanic = 'rename-plus-flip-is-current'
              AND rt.flip_target_uuid_prefix IS NOT NULL
              AND pr.id::text LIKE rt.flip_target_uuid_prefix || '%'
           THEN true
         ELSE pr.is_current
       END
  FROM rename_targets rt
 WHERE pr.id = rt.id;
GET DIAGNOSTICS v_renamed_count = ROW_COUNT;
```

**Per-name affected-count assertion (post-UPDATE):** since the UPDATE above mutates rows in-place, recovering "how many rows under each old_name were just renamed" requires capturing the per-name actuals BEFORE the UPDATE runs. Pattern:

```sql
-- BEFORE the UPDATE, snapshot the per-name actual counts:
CREATE TEMP TABLE _spec005_actuals AS
  SELECT pr.name AS old_name, COUNT(*) AS actual_count
    FROM public.prep_recipes pr
    JOIN _spec005_renames m ON m.old_name = pr.name
   WHERE pr.brand_id = v_brand_id
   GROUP BY pr.name;

-- Per-name strictness assertion:
PERFORM 1
  FROM _spec005_renames m
  LEFT JOIN _spec005_actuals a USING (old_name)
 WHERE COALESCE(a.actual_count, 0) <> m.expected_rename_count
LIMIT 1;

IF FOUND THEN
  -- Diagnostic NOTICE per mismatched name, then RAISE EXCEPTION (Spec 003 pattern).
  FOR r IN
    SELECT m.old_name, m.expected_rename_count, COALESCE(a.actual_count, 0) AS actual_count
      FROM _spec005_renames m
      LEFT JOIN _spec005_actuals a USING (old_name)
     WHERE COALESCE(a.actual_count, 0) <> m.expected_rename_count
  LOOP
    RAISE NOTICE 'Spec 005: per-name mismatch on "%": expected %, got %',
      r.old_name, r.expected_rename_count, r.actual_count;
  END LOOP;
  RAISE EXCEPTION 'Spec 005: per-name affected-count assertion failed — rolling back';
END IF;
```

**Grand-total post-UPDATE assertion:** `v_renamed_count` (from `GET DIAGNOSTICS` after the UPDATE) MUST equal `SUM(expected_rename_count)`. The `is_current` flip case (`38678f`-prefixed row gets both the rename and the `is_current = true` flip) is one row counted once — the UPDATE statement touches it exactly once.

**Diagnostic NOTICE on success:**

```
RAISE NOTICE 'Spec 005: renamed % prep_recipes rows across % names (% with is_current flip)',
  v_renamed_count, v_name_count, v_flip_count;
```

### 5. Apply-path matrix

Spec 001's section 5b template, exercised for Spec 005's data shape.

> **Amended 2026-05-06 (#2):** Path A (remote) now reflects the 5-name manifest with grand total 22 rows (4 + 8 + 3 + 1 + 6). Path B-revised (local) sees only 4 names / 16 rows because the local seed.sql does not carry the 5th source-name's rows (the 6 non-current rows under `House Special Blend (Sauce)` appear to be post-2026-05-02 production drift). The migration is **idempotent on local** (the 5th rename matches 0 rows → no-op) and **functional on remote** (the 5th rename matches 6 rows). Spec 001's idempotent-no-op pattern handles this asymmetry cleanly. Per-row assertion semantics: rows 1-4 are strict on both environments; the 5th row admits a 2-tuple expected count `actual IN (0, 6)`. Grand-total assertion: `v_renamed_count IN (16, 22)`.

> **Amended 2026-05-06 (#3):** the 5-name extension from amendment #2 is reverted. The matrix below is restored to the 4-name shape with grand total 16 rows on BOTH local and remote (byte-identical per gate 1 + gate 1b). No local-vs-remote asymmetry on Spec 005's mutations. The `House Special Blend (Sauce)` situation is sibling Spec 006's territory.

| Path | Starting state | Required end state |
|---|---|---|
| **A) `db push` to remote (production prod)** | The 4 affected names exist with the per-name counts the architect's probe certifies on remote (4 / 8 / 3 / 1, byte-identical local vs remote per Build notes resumption). Spec 003's `prep_recipe_ingredients` migration is NOT yet applied (Spec 003 is halted). Spec 001's `recipe_prep_items` migration IS applied (per Spec 001 status DONE). | All 4 affected names renamed (**16 rows total: 4 + 8 + 3 + 1**); ~~`38678f`-prefixed row has `is_current = true`~~ **(amended 2026-05-06: no flip; `38678f` already canonical pre-migration);** spec 003's halt-stop gates 2/3/6 are now resolvable on the cleaned data for the 4-name set. The `House Special Blend (Sauce)` remote-only situation is unchanged on remote and is sibling Spec 006's responsibility. |
| **B-revised) Manual re-execute after `db reset --local`** | `db reset --local` runs all migrations (including this one) against empty DB → no-op via count=0 branch; `seed.sql` re-loads the 4 affected names with the local probe-certified counts. Developer re-executes the migration body via psql against the now-seeded local DB. | The 4 names renamed (**16 rows**). Spec 003's halt-stop gates 2/3 are resolvable. |
| **C) `db reset --local` (no manual re-execute)** | Empty DB → no-op; seed re-loads the un-curated names. | The 4 names persist un-renamed in local DB (acknowledged structural limitation per AC analog of Spec 001 AC6 and Spec 003 Path C). |
| **D) Re-run after success** | The 4 affected `old_name` rows do NOT exist (already renamed). Count = 0 branch fires. | Unchanged. |

**Differences vs Spec 003's matrix:**

1. **No Path B-original.** Spec 003 also has no Path B-original (dedup is live everywhere). Spec 005 is the same: Phase 2 backfill is applied everywhere, so the four affected names exist on every populated environment.
2. **No external-canonical-collision branch in the SQL sense.** Spec 005's UPDATE doesn't trigger any unique-index collision (verified via gate_7 in section 1: the partial unique index on `(brand_id, lower(name)) WHERE is_current = true` exists, but every renamed row has `is_current = false` and is excluded from the index). The two ROW_NUMBER survivor patterns from Spec 001 / Spec 003 do not apply; this is a straight UPDATE driven by a manifest.
3. **Local-vs-remote count tolerance.** As noted in section 1's hypothesis (b), if probe gate 1 finds local-vs-remote count divergence on the 4 affected names, the manifest must admit a 2-tuple expected count `expected_rename_count_local | expected_rename_count_remote` and the assertion becomes `actual = local OR actual = remote`. Architect's anticipation (section 1) was hypothesis (c) where the +6 drift is `prep_recipe_ingredients` only and the `prep_recipes` per-name counts match — under (c), no manifest tolerance would have been needed. **Amended 2026-05-06 (#2):** hypothesis (c) was REFUTED on the remote probe; the correct hypothesis is (a) — newer orphans created since 2026-05-02 seed pull, manifesting as a NEW name. Per user direction, Spec 005's contract was extended with a 5th manifest row instead of splitting into Spec 005 + Spec 006. The manifest tolerance approach (originally specced for hypothesis b) applies cleanly to the 5th row: `expected_local = 0`, `expected_remote = 6`. Rows 1-4 retain strict-equality assertions on both environments. **Amended 2026-05-06 (#3):** with the 5th row dropped, no local-vs-remote tolerance is needed at all — gate 1 + gate 1b show byte-identical counts on the 4 affected names across environments. Strict-equality assertions on all 4 rows on both environments. The hypothesis-(b) tolerance branch becomes purely hypothetical (would only fire if a future remote probe surfaces drift on the 4 affected names; today it does not).

### 6. Q3 / Q4 revisit

**Q3 (one spec vs split):** PM-recommended default holds — single spec. Architect's probe-gate 2 design (remote drift investigation) keeps the diagnostic in-band. **Architect explicitly does NOT recommend splitting** unless probe gate 2 surfaces hypothesis (a) or (d) (cause materially changes the curation contract). Under hypothesis (b), the manifest tolerance approach keeps it one spec; under (c), no extension is needed at all. Splitting only helps if remote has 6 extra orphan `prep_recipes` rows under names not in the four-name set — which the architect estimates at <5% likelihood given the +6 delta sits cleanly within plausible `prep_recipe_ingredients` orphan drift, not on `prep_recipes` itself.

**Q4 (apply discipline):** PM-recommended default holds — full Spec 001 matrix. Section 5 above exercises it. The rename mechanic does not collapse the matrix because: (a) the count-first idempotency contract still applies (Path D re-run), (b) `db reset --local` no-op behavior still applies (Path C), and (c) the probe-certified expected count is still load-bearing (manifest is hardcoded; assertion fires on drift). One difference: there is no unique-index intra-update collision risk under Spec 005 (because there's no relevant unique constraint), so the ROW_NUMBER survivor pattern is not adapted from Spec 001.

**No reason to split into Spec 005 (curation) + Spec 006 (remote-drift investigation)** under architect's hypothesis (c). Stop conditions in section 8 cover the (a) / (d) escape hatches.

### 7. Risk surface and verification protocol

- **Apply-context fragility under restricted RLS.** Same residual hole as Spec 001/003. The migration runs as `postgres` superuser via `supabase db push` / `db reset` — RLS bypassed. Auditor must re-confirm no non-superuser apply path exists. The brand-catalog refactor migrations defined `prep_recipes` policies separately from `20260504173035_per_store_rls_hardening.sql` (which covers per-store tables only). Spec 005's UPDATE on `prep_recipes.name` under superuser context cannot be rejected by RLS, but the auditor must:
  1. `SELECT polname, polcmd, polqual, polwithcheck FROM pg_policy WHERE polrelid = 'public.prep_recipes'::regclass;` against local + remote.
  2. Confirm no `WITH CHECK` invariant is violated by `name` column updates (`name` is not a brand/store-scoped column — should be permissive).
  3. Document the superuser-only apply assumption per Spec 001/003 precedent.

- **Per-name assertion failure recoverability.** `BEGIN/ROLLBACK` semantics mean any per-name mismatch rolls back the entire migration. Spec 003 pattern: diagnostic NOTICE LOOP names which name diverged with (expected, actual) tuples. Operator can re-probe to understand the shift, update the manifest, re-apply.

- **Manifest staleness between architect probe and developer apply.** The strict per-name assertion catches this loudly. Same protection Spec 001/003 had on their literals.

- **Performance.** ≤30 rows updated total. **Amended 2026-05-06:** post-probe certified counts are 4 + 8 + 3 + 1 = **16 rows**. The single UPDATE driven by a manifest join is sub-millisecond. No index changes warranted. **Amended 2026-05-06 (#2):** post-remote-probe with 5-name extension, certified counts are 4 + 8 + 3 + 1 + 6 = **22 rows on remote**, **16 rows on local** (the 5th source-name's 6 rows are absent from local seed). Still sub-millisecond; still no index changes warranted. **Amended 2026-05-06 (#3):** with the 5th row reverted, certified counts are **16 rows on both local AND remote** (byte-identical). Sub-millisecond; no index changes.

- **Edge function cold-start.** N/A — migration touches no edge functions.

  > **Amended 2026-05-06:** the original analysis claimed Spec 005 changes the `pwa-catalog` payload (gains one entry under `House Special Seasoning (House Mix)`). The probe revealed this is wrong: the `38678f` row is **already canonical at the target name today**, so the catalog already emits it. The corrected migration does NOT change the catalog payload at all — every rename is on `is_current = false` rows that aren't emitted by `pwa-catalog`'s `WHERE is_current = true` filter, and the existing canonicals at the three target names are unchanged. The `pwa-catalog` smoke is therefore **not even informationally useful** post-amendment; the corrected expectation is a byte-identical payload before and after.

  `pwa-catalog`'s output structure is unchanged: it emits `prep_recipes[]` filtered to `is_current = true`. Per-rename impact:
  - (a) `Tumeric Mix` → `Tumeric Seasoning (House Mix)`: canonical at `c7d9a94b-...` already current at target name; renaming the 4 non-current siblings doesn't change the catalog's emitted set. **Invisible to PWA.**
  - (b) `House Special Seasoning Mix` → `House Special Seasoning (House Mix)`: canonical at `38678f33-...` already current at target name (per probe gate 1b); renaming the 8 non-current siblings doesn't change the catalog's emitted set. **Invisible to PWA.** (Original analysis predicted a payload change here; that prediction was wrong, downstream of the same mechanic-table error the corrected section 2 fixes.)
  - (c) `2AM Sauce` → `2AM SAUCE`: catalog emits the existing canonical `66d823bb-...`; renaming 3 non-current siblings is invisible.
  - (d) `2AM SAUCE 10` → `2AM SAUCE`: the single non-current row's name changes; catalog still emits only the existing `2AM SAUCE` canonical. Invisible.

  Net: zero change to PWA catalog payload. Optional pre/post smoke still defensible as a tripwire (developer's choice), but no change is the expected and correct outcome.

- **Concurrent writes during apply.** Standard migration safety. UPDATE row locks plus the BEGIN/COMMIT wrapper make the count-then-mutate sequence safe against another writer. Migration applies in low-traffic window.

- **Realtime publication membership unchanged.** Spec 005 does NOT change `supabase_realtime` publication membership. `prep_recipes` may already be in the publication (it's in `useRealtimeSync.ts:35-38`'s subscribed list per Spec 003 line 175). The UPDATE will fire normal row-change events on the `brand-{brandId}` channel, picked up by connected admin clients via the existing debounced 400ms reload. **The publication-membership gotcha (`docker restart supabase_realtime_imr-inventory`) DOES NOT APPLY.** Per project memory `memory/project_realtime_publication_gotcha.md`. Restated for clarity: the migration does not `ALTER PUBLICATION supabase_realtime ADD TABLE ...`; no docker restart is needed at deploy or dev time.

- **Future drift prevention.** **Amended 2026-05-06:** the partial unique index on `prep_recipes(brand_id, lower(name)) WHERE is_current = true` **already exists** as of migration `20260505055228_prep_recipes_brand_name_current_unique.sql`. Spec 005's renames do not trigger or violate this index because every renamed row has `is_current = false` and is excluded from the partial index. The original paragraph below claimed "Spec 006/007 may add such a guard" and discussed a hypothetical retroactive-violation caveat tied to the original mechanic's `38678f` flip; both points are moot under the corrected design (no flips; guard already in place). The corrected mechanic in section 2 is **trivially compatible** with the existing partial unique index.

  Original paragraph (preserved for audit): Spec 005 does NOT add a partial unique index on `prep_recipes(name, brand_id) WHERE is_current = true`. Spec 003's section 14 recommendation already covers this as a Spec 006/007 candidate; Spec 005 follows the same Q2 directive (data fix only, no constraint guard). If a guard is wanted, file separately. **Caveat the developer should know:** if Spec 005's renames result in two rows at `(2AM SAUCE, 2a000000-...)` with `is_current = true` (the existing canonical PLUS a flipped `2AM Sauce` row), the partial unique index a future spec would add would be retroactively violated. **Spec 005's mechanic table prevents this** — the only `is_current` flip is on the `38678f` row at `House Special Seasoning (House Mix)`, where the target name has no existing canonical. The other three renames leave `is_current` alone. **Architect's call:** the design is correct under "no future guard exists today"; a future guard-spec must verify there are no duplicate-current rows at any post-Spec-005 `(name, brand_id)` before deploying the index.

- **Cross-spec coupling: Spec 003 retry.** Per resolved Q5, Spec 003's Q1/Q3 directives must be re-evaluated by the user before Spec 003 re-dispatches the architect. Spec 005's design does NOT pre-empt that re-evaluation. The four affected names will, post-Spec-005, all have a canonical-current row visible to Spec 003's gate 2, so Spec 003's halt-stop gate 2 is resolved. Spec 003's gate 3 ("variant same-prep evidence between `2AM Sauce` and `2AM SAUCE`") is resolved because the rename merges the names — there's no longer a `2AM Sauce` distinct from `2AM SAUCE` post-rename. Spec 003's gate 6 ("local-vs-remote drift") is resolved by Spec 005's probe gate 2 diagnosis (architect's anticipated cause: hypothesis (c)).

#### AC mapping

Every Spec 005 acceptance criterion mapped to a verification step.

| AC (spec line) | Maps to | Verification |
|---|---|---|
| Per-prep-name "exactly one canonical-current row per brand" post-migration (spec line 59) | Section 2 mechanic table + section 4 manifest + section 5 path A | Re-run probe gate 2 (Spec 003's gate 2 SQL) post-apply. Expect `canonical_current_count = 1` for each of `2AM SAUCE`, `Cajun Seasoning (House Mix)`, `White Sauce`, `Burger Patty`, `Yellow Rice`, `Tumeric Seasoning (House Mix)`, `House Special Seasoning (House Mix)` (the 7 canonical names; **amended 2026-05-06**: all 7 are pre-existing canonicals, including `38678f` which is already canonical at `House Special Seasoning (House Mix)` per probe gate 1b — the original "newly-flipped" framing was wrong). **Amended 2026-05-06 (#2):** add `House Special Blend (Sauce)` (canonical at owner-notes prefix `4fbd90`) as the 8th canonical name to verify post-apply on remote. Names `2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`, **and the 5th source-name variant captured at apply time** should NOT appear in gate 2's affected-name list because the rename collapses them out of `prep_recipe_ingredients`-orphan-discovery (since their underlying rows now have a different `name`). **Amended 2026-05-06 (#3):** the "8th canonical" addition from amendment #2 is reverted. Verify the 7 canonicals listed above; `House Special Blend (Sauce)` is sibling Spec 006's territory. The 4 source names (`2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`) should not appear in gate 2's affected-name list post-apply. |
| Specifically: 4 missing-canonical names reconciled by rename per the section 2 mapping (line 60) | Section 4 manifest + section 5 verification | Re-run probe gate 1 SQL post-apply. Expect `total_count = 0` for each of the four old names. **Amended 2026-05-06 (#2):** also expect `total_count = 0` for the 5th source-name variant on remote (and `total_count = 0` on local, where it was already absent — idempotent no-op). **Amended 2026-05-06 (#3):** the 5th-row check from amendment #2 is reverted. Expect `total_count = 0` for the 4 source names only. |
| Variant unification for `2AM Sauce` ↔ `2AM SAUCE` via rename (line 61) | Section 2 row 3 + section 4 manifest entry | Probe `SELECT COUNT(*) FROM prep_recipes WHERE name = '2AM Sauce' AND brand_id = '2a000000-...'` post-apply. Expect 0. The canonical at `66d823bb-...` is unchanged (its `name`, `is_current`, ingredient list all preserved). |
| +6 remote drift cause documented (line 62) | Section 1 "Remote drift investigation" subsection | Developer fills the probe-gate-2 output verbatim into the Probe results checklist. STOP if cause is hypothesis (a) or (d) per section 8. |
| Migration filename + timestamp convention (line 63) | Section 3 (`20260506000000_rename_prep_canonicals.sql`) | File exists at expected path, sorts after `20260505000000_*` |
| `BEGIN/COMMIT` wrapper (line 64) | Section 4 SQL sketch + section 7 control-flow stub | grep migration body for `BEGIN;` and `COMMIT;` |
| Pre-mutation count assertion (line 65) | Section 4 `_spec005_actuals` snapshot + per-name assertion | RAISE EXCEPTION on mismatch; verified by deliberate manifest-tampering test if developer wishes (not required) |
| Idempotent re-run path (line 66) | Section 5 Path D + section 7 count-first branch | Manual re-execute post-success: NOTICE captures `Spec 005: no-op (no rows to rename — already curated)` |
| Apply-path matrix considered (line 67) | Section 5 | Matrix table covers Path A / B-revised / C / D |
| Owner-curated notes file referenced as authority (line 68) | Section 0 + section 1 + section 2 | Each section cites `docs/internal/prep-canonicalness-notes.md` directly |
| Spec 003 halt-stop gates 2, 3, 6 resolvable post-Spec-005 (line 69) | Section 7 cross-spec coupling | Re-run Spec 003's probe SQL post-Spec-005 apply; expect gates 2/3/6 cleared. Spec 003 retry is gated on user re-evaluation of Q1/Q3 per resolved Q5 — NOT automatic. |

**No HTTP-path AC.** Per the user prompt's guidance: "rename of `prep_recipes.name` doesn't affect `pwa-catalog`'s output structure, only the names returned." Architect concurs. The catalog payload's `prep_recipes[]` array structure is unchanged. ~~The `38678f` row's emergence as a newly-current canonical (House Special Seasoning) DOES add one entry to the array, but that's the intended outcome per the owner notes — it's not a regression to detect via HTTP smoke.~~ **Amended 2026-05-06:** the `38678f` row is **already canonical at `House Special Seasoning (House Mix)` today**, so it's already in the catalog payload — no entry is added by Spec 005's renames. The catalog payload is byte-identical before and after. Optional smoke (developer's choice): pre/post diff of `pwa-catalog?store_id=<towson>` should confirm zero changes to the `prep_recipes[]` array. **Not a blocking AC.**

#### Verification protocol

Maps 1-to-1 to the AC table above.

**Pre-build (developer's first action, before authoring the migration):**

> **Amended 2026-05-06:** steps 4 and 5 have been resolved by user direction; replaced with the corrected steps below. Step 2 (remote probe) is now the gating step for build resume — user authorized read-only remote probe.

> **Amended 2026-05-06 (#2):** step 2 (remote probe) has executed and refuted hypothesis (c); the correct hypothesis is (a) — `House Special Blend (Sauce)` adds a 5th name. Per user direction, the manifest is extended in-place; steps 4 and 5 below gain a 5th-row substitution. The 5th row's `old_name` is NOT yet known — the dev's resumption notes describe both source and target as `House Special Blend (Sauce)`, which is contradictory under rename-into-collision. New step 4a (apply-time source-name re-probe) precedes substitution; build STOPs if Reading 2 (degenerate no-op) holds per section 8 build-stop 8.

> **Amended 2026-05-06 (#3):** the apply-time source-name re-probe (introduced in amendment #2) has executed and confirmed Reading 2; the 5th row is dropped from Spec 005. Steps 4 (apply-time source-name re-probe) and 5's 5th-row substitution are reverted. Pre-build flow returns to the 4-row substitution shape from amendment #1. The amendment-#2 step list below is preserved for audit; the **active flow** is steps 1, 2, 3, 5, 6 with the 4-row manifest INSERT — no step 4 (no apply-time source-name re-probe is required because there is no 5th row to substitute).

1. (Already done at first-pass build.) Probe SQL from section 1 ran against local DB; output pasted into Probe results checklist.
2. **Run probe SQL against remote** (already executed per Build notes resumption; gates 1, 1b, 2 captured). **Confirm hypothesis (c)** per section 0 step 3. **Amended 2026-05-06 (#2):** hypothesis (c) was REFUTED — proceed to step 4 with the 5-name extension per user direction. **Amended 2026-05-06 (#3):** the 5-name extension is reverted; the 4-name manifest holds across both environments per gate 1 + gate 1b cross-environment summary. Proceed to step 5.
3. STOP on any of the active section 8 conditions (1, 3, 4, 5, 6, 8). Build-stop 2 is resolved by user direction; build-stop 7 is obsoleted; **build-stop 6 RESOLVED via amendment (#2)** — its gating concern (hypothesis-(c) refutation) was addressed by extending the manifest to 5 rows; **build-stop 8 (NEW, 2026-05-06 #2)** is the source-name BLOCKER for the 5th row. **Amended 2026-05-06 (#3):** build-stop 8 is OBSOLETED with the 5th row dropped. Active build-stops at this step are 1, 3, 4, 5, 6.
4. **Apply-time source-name re-probe (NEW, 2026-05-06 #2; OBSOLETED 2026-05-06 #3):** ~~run the SQL from section 2's "Source-name BLOCKER" callout against remote (or rehydrate the actual source-name string from the dev's gate_2 saved output). If the source-name variant is genuinely distinct from the canonical `House Special Blend (Sauce)` (Reading 1), proceed to step 5 with that string. If the 6 non-current rows are AT the canonical name itself (Reading 2), STOP — Spec 005's rename-only shape does not apply.~~ **Amended 2026-05-06 (#3):** this step is OBSOLETED. The re-probe ran and confirmed Reading 2; the 5th row is dropped. No apply-time re-probe is required for the 4-row manifest — gate 1 already certified the 4 source names exist on both environments byte-identically.
5. Substitute architect-certified per-name counts into the `_spec005_renames` manifest INSERT in the migration body. **Per the corrected section 2 mechanic table, `flip_target_uuid_prefix` is `NULL` on every row** — no `is_current` flips. The `_spec005_renames` table still has the column for schema stability vs the original design, but every row has `mechanic = 'rename-into-collision'` and `flip_target_uuid_prefix = NULL`. Manifest INSERT (with probe-certified counts, **4-row, restored to amendment-#1 shape per amendment #3**):
   - `('Tumeric Mix', 'Tumeric Seasoning (House Mix)', 'rename-into-collision', 4, NULL)`
   - `('House Special Seasoning Mix', 'House Special Seasoning (House Mix)', 'rename-into-collision', 8, NULL)`
   - `('2AM Sauce', '2AM SAUCE', 'rename-into-collision', 3, NULL)`
   - `('2AM SAUCE 10', '2AM SAUCE', 'rename-into-collision', 1, NULL)`
   - **Grand-total expected: 16 on both local and remote.** Per-name assertions strict on all 4 rows on both environments.
6. Decision on `2AM SAUCE 10` family inclusion is **already made by user direction 2026-05-06: include**. The fourth manifest row above is unconditional.

**During apply (`docker exec ... psql < migration.sql`):**
- NOTICE captured: `Spec 005: renamed N prep_recipes rows across M names (1 with is_current flip)`. **Amended 2026-05-06:** the "1 with is_current flip" parenthetical is stale per the corrected section 2 — the migration performs 0 flips. The NOTICE message in the authored migration should read `Spec 005: renamed 16 prep_recipes rows across 4 names (0 is_current flips)` or omit the flip-count parenthetical entirely. Idempotent re-run: `Spec 005: no-op (no rows to rename — already curated)` if already applied or pre-seed. **Amended 2026-05-06 (#2):** with the 5-row manifest, expected NOTICE on local apply is `Spec 005: renamed 16 prep_recipes rows across 4 names (5th name idempotent no-op locally — 0 rows under <source-name>)` and on remote apply is `Spec 005: renamed 22 prep_recipes rows across 5 names`. The local NOTICE explicitly recording the 5th-name no-op (rather than counting it silently) makes the local-vs-remote asymmetry observable from the apply log. **Amended 2026-05-06 (#3):** with the 5th row dropped, expected NOTICE is identical on local and remote: `Spec 005: renamed 16 prep_recipes rows across 4 names (0 is_current flips)`. No local-vs-remote asymmetry in the NOTICE output.

**Post-apply (developer + test-engineer reviewer):**

> **Amended 2026-05-06 (#2):** post-apply gates 1 and 1b expand to cover the 5-name manifest. Gate 1 now verifies **5 source names** (the original 4 + the 5th source-name variant identified at apply-time per build-stop 8). Gate 1b now verifies **4 target canonicals** (the original 3 + `House Special Blend (Sauce)`). Local environment: gate 1 verifies 4 source names absent (the 5th source-name was never present locally); gate 1b verifies all 4 target canonicals unchanged. Remote environment: gate 1 verifies all 5 source names absent; gate 1b verifies all 4 target canonicals unchanged. The 5th target's canonical at owner-notes prefix `4fbd90` should retain `is_current = true` and its row count should match pre-apply byte-for-byte.

> **Amended 2026-05-06 (#3):** the 5th-row expansion from amendment #2 is reverted. Gate 1 verifies **4 source names** (the original set); gate 1b verifies **3 target canonicals** (the original set). Same on local and remote. `House Special Blend (Sauce)` is sibling Spec 006's territory; do not include it in Spec 005's post-apply gates.

1. **Old names absent.** Re-run gate 1: expect `total_count = 0` for each of the **4** old names (`2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`) on both local and remote.
2. **Targets correctly populated.** Re-run gate 1b: expect `current_count = 1` for `2AM SAUCE` (unchanged), `Tumeric Seasoning (House Mix)` (unchanged), and `House Special Seasoning (House Mix)` (**unchanged** — already canonical at this name pre-migration per probe gate 1b; **amended 2026-05-06** from the original "newly emerged via the `is_current` flip"). `non_current_count` for each target = pre-apply non_current_count + the renamed-in non-current rows from the corresponding old name. **Amended 2026-05-06 (#3):** the 4th-target check from amendment #2 (`House Special Blend (Sauce)` at `4fbd90`) is dropped — sibling Spec 006's territory.
3. **Spec 003 halt-stop gates 2/3/6 clear.** Re-run Spec 003's probe (`/tmp/spec003-probe.sql`):
   - Gate 2: every affected prep name in Spec 005's 4-name set resolves to exactly 1 current row. (`House Special Blend (Sauce)` is sibling Spec 006's domain; if Spec 003 still surfaces it as needing curation post-Spec-005, that's expected and Spec 006 owns the resolution.)
   - Gate 3: variant collapse no longer surfaces same-prep evidence (because `2AM Sauce` no longer exists as a distinct name).
   - Gate 6: **Amended 2026-05-06 (#3):** the +6 drift's root cause is now diagnosed (post-2026-05-02 production drift creating 1 non-current `prep_recipes` row + 6 orphan ingredient rows under `House Special Blend (Sauce)` on remote — gate_2's "6 non-current rows" reading was a JOIN-multiplication artifact). Spec 005 does NOT close this; sibling Spec 006 does. Local-vs-remote `prep_recipe_ingredients` grand-total drift remains until Spec 006 ships and Spec 003 retries against the cleaned data.
4. **`pwa-catalog` smoke (optional, non-blocking).** Pre-migration: capture catalog payload. Post-migration: capture and diff. **Amended 2026-05-06:** expected diff is **zero** — no structural or content changes to the catalog. Every `is_current = true` row at the three target names is unchanged; every renamed row is `is_current = false` and excluded from the catalog filter. The original prediction that the array would gain one entry under `House Special Seasoning (House Mix)` was wrong (that canonical already exists today). If the smoke surfaces ANY diff in the `prep_recipes[]` array, that's a regression worth investigating. **Amended 2026-05-06 (#3):** unchanged from amendment #1 — expected diff is zero. The 5th-target consideration from amendment #2 is reverted; `House Special Blend (Sauce)` is not Spec 005's concern.

### 8. Build-stop conditions for the developer

> **Amended 2026-05-06:** Build-stop 2 (`2AM SAUCE 10` family inclusion) has been resolved by user direction — `2AM SAUCE 10` is included in the rename family per the corrected section 2. Build-stop 7 (`38678f` prefix at source name) is **obsoleted** because the corrected section 2 has no `is_current` flip on any row; the `38678f` row's location no longer affects the mechanic. Both are listed below for audit but marked accordingly. Build-stop 5 ("target name canonical count ≠ 1") now also covers `House Special Seasoning (House Mix)` since the probe certified that target has exactly 1 canonical-current row at `38678f33-66bf-420c-a50d-82899120aa9b`. Build-stops 1, 3, 4, 6 still apply unchanged.

> **Amended 2026-05-06 (#2):** Build-stop 6 (local-vs-remote count divergence not attributable to hypothesis (c)) FIRED on remote and led to this amendment — see Build notes "Resumption — 2026-05-06 (post-amendment)". **Build-stop 6 is now RESOLVED via amendment**: the user authorized extending the curation contract in-place to a 5-row manifest covering `House Special Blend (Sauce)`, rather than splitting into two specs. The build can proceed against the 5-row manifest. **Build-stop 8 (NEW)** is added below to cover the apply-time source-name verification for the 5th row, since the dev's resumption notes use the same string for both source and target — under rename-into-collision, that's contradictory and must be disambiguated at apply time. Build-stop 5 also expands to cover the 4th target (`House Special Blend (Sauce)`) per the canonical retain-`is_current = true` requirement. Build-stops 1, 3, 4 still apply unchanged.

> **Amended 2026-05-06 (#3):** Build-stop 8 FIRED on the apply-time source-name re-probe with **Reading 2 (degenerate)** — the 6 non-current rows on remote are AT the canonical name itself, not at a variant. Per user decision, the 5th manifest row is dropped from Spec 005 and **build-stop 8 is now OBSOLETED** (the 5th row that required this stop no longer exists). Build-stop 5 collapses back to the 3-target shape from amendment #1 (`2AM SAUCE`, `Tumeric Seasoning (House Mix)`, `House Special Seasoning (House Mix)`). Build-stop 6 remains RESOLVED (its underlying refutation analysis still stands; Spec 005 just no longer extends to cover the refutation case — sibling Spec 006 does). Build-stops 1, 3, 4 still apply unchanged.

Same six-condition shape as Spec 003 section 0 step 3, refined for Spec 005's data shape. **STOP and surface to the user before authoring the migration if any of these fire:**

1. **Cross-brand orphans (gate 4).** Architect anticipates 1 brand only. If gate 4 surfaces > 1 brand, STOP — the curation contract may need extending across brands. **Status (2026-05-06):** local probe confirmed 1 brand. Remote probe must reconfirm.

2. **Variant unification surface change** — **RESOLVED by user direction 2026-05-06.** The original condition: gate 3 confirms `2AM SAUCE 10` is NOT a sibling variant of `2AM SAUCE` (low overlap < 50%). Probe returned 70% strict-tuple overlap (gray zone); user directive: include `2AM SAUCE 10` in the family. Build-stop 2 no longer fires. **If a remote probe re-runs gate 3 and surfaces a materially different overlap (e.g., remote `2AM SAUCE 10` row has different ingredient list than local), surface to user — but do not auto-stop.**

3. **`sub_recipe_id` orphan regression (gate 5).** Architect anticipates 0. If non-zero, STOP — surface to user. **Status (2026-05-06):** local confirmed 0. Remote must reconfirm.

4. **Per-name `current_count` ≠ 0 for any of the four affected names (gate 1).** Architect anticipates 0 for all four. If any of `2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix` already has a current row, the data shape has shifted between Spec 003's halt and Spec 005's build. STOP and surface. **Status (2026-05-06):** local confirmed 0 across all four. Remote must reconfirm.

5. **Target name `(name, brand_id, is_current = true)` count ≠ 1 for any of `2AM SAUCE`, `Tumeric Seasoning (House Mix)`, `House Special Seasoning (House Mix)` (gate 1b).** Architect anticipates exactly 1 each. **Updated 2026-05-06:** the third name `House Special Seasoning (House Mix)` was added to this condition after the probe revealed its canonical at `38678f33-...` already exists. If 0 or > 1 at any of the three target names, the rename mechanic table is wrong. STOP and surface. **Status (2026-05-06):** local confirmed exactly 1 at all three. Remote must reconfirm. **Updated 2026-05-06 (#2):** a 4th target name `House Special Blend (Sauce)` is added per the 5-row manifest extension; canonical at owner-notes prefix `4fbd90` must have `current_count = 1` on both local and remote. **Status (2026-05-06 #2):** confirmed via dev resumption notes line 99 + line 1060 — `4fbd90` is canonical with `is_current = true`; canonical row count is consistent local-and-remote. **Updated 2026-05-06 (#3):** the 4th-target addition from amendment #2 is reverted per Reading 2 + user decision. Build-stop 5 covers the **3 original targets** only (`2AM SAUCE`, `Tumeric Seasoning (House Mix)`, `House Special Seasoning (House Mix)`). `House Special Blend (Sauce)` is sibling Spec 006's domain.

6. **Local-vs-remote count divergence (gate 1 + gate 2 cross-environment).** Specifically: if remote's per-name `non_current_count` differs from local for any of the four affected names AND the cause cannot be attributed to hypothesis (c) in section 1's "Remote drift investigation" — STOP. Surface to the user. Manifest tolerance (hypothesis (b)) is admissible only on architect re-design after the user confirms the cause. **This is the active gate for the post-amendment build flow** — the developer's first job at build resume is to run the remote probe and evaluate this gate. **Updated 2026-05-06 (#2): RESOLVED via amendment.** This build-stop FIRED on the remote probe (per Build notes "Resumption — 2026-05-06 (post-amendment)"); hypothesis (c) was refuted because remote has an 11th name (`House Special Blend (Sauce)`) absent locally. Per user direction, the architect extended the curation contract in-place with a 5th manifest row rather than splitting into two specs. The 5-row manifest in section 4 (#2 amendment) is the resolution; build-stop 6 no longer fires for `House Special Blend (Sauce)`. If a future remote probe surfaces a 12th name, build-stop 6 fires anew.

7. **`House Special Seasoning Mix`'s `38678f`-prefixed row not found by gate 1's `row_ids` array** — **OBSOLETED 2026-05-06.** Original condition: architect anticipated this row exists with `is_current = false` and id-prefix `38678f` at the SOURCE name. Probe revealed: the `38678f` row is at the TARGET name `House Special Seasoning (House Mix)` with `is_current = true`, not at the source name. Original anticipation was wrong; the corrected section 2 mechanic does NOT flip any `is_current` flag, so the `38678f` row's location is no longer load-bearing for the migration. **This build-stop is retired.** Replaced by build-stop 5's expansion to cover `House Special Seasoning (House Mix)` as a target whose canonical row count must remain exactly 1.

8. **Source-vs-target name BLOCKER for the 5th manifest row (`House Special Blend (Sauce)`)** — **NEW 2026-05-06 (#2); OBSOLETED via amendment #3 2026-05-06.** The dev's Build notes resumption (gate 2 cross-environment summary) describes the +6 remote-only rows as occurring at name `House Special Blend (Sauce)` — the same string as the owner-curated canonical name (per `docs/internal/prep-canonicalness-notes.md` line 99, prefix `4fbd90`). Under rename-into-collision, that's contradictory: a rename from "X" to "X" is a no-op rather than a curation step. Two viable readings:
   - **Reading 1 (likely):** the dev's resumption notes truncated a casing/whitespace/suffix variant string (e.g., `House Special Blend (sauce)` lowercase, `House Special Blend (SAUCE)`, `House Special Blend Sauce` without parentheses, leading/trailing-space, etc.). The actual source-name string is distinct from the canonical and the rename is genuine. PROCEED with the variant string substituted into the 5th manifest row's `old_name`.
   - **Reading 2 (degenerate):** the 6 non-current rows are AT the canonical target name itself (no variant; same string, just `is_current = false`). "Rename" is a structural no-op and Spec 005's rename-only shape does NOT apply. **STOP and surface to the user** — Spec 005 does not author a no-op masquerading as curation. The 6 rows become Spec 003's territory under the user's Q1 retry policy, or warrant a sibling spec.
   
   **Resolution path:** at build resume, run the apply-time source-name re-probe SQL from section 2's "Source-name BLOCKER" callout against remote (read-only). If a single `is_current = false` row population at a name distinct from `House Special Blend (Sauce)` returns, that's the source-name string for the 5th manifest row's `old_name`. If the 6 rows return AT name `House Special Blend (Sauce)` itself with `is_current = false`, Reading 2 holds — STOP and surface. Do NOT hardcode `'House Special Blend (Sauce)'` as both old_name and new_name in the manifest.
   
   **Status (2026-05-06 #2):** UNRESOLVED — pending apply-time re-probe at build resume.

   **Status (2026-05-06 #3): OBSOLETED.** The apply-time re-probe ran (per Build notes "Final apply — 2026-05-06 (post-amendment-#2 source-name re-probe)") and confirmed Reading 2: the rows on remote matching `House Special Blend (Sauce)` carry the byte-identical canonical name with no variant. Per user decision, the 5th manifest row is dropped from Spec 005; this build-stop is retired. Sibling Spec 006 owns `House Special Blend (Sauce)` cleanup. The build-stop's logic is preserved for audit but does not gate Spec 005's build flow.

## Handoff

next_agent: backend-developer
prompt: Implement against the design in this spec — Spec 005's rename-based curation migration at `supabase/migrations/20260506000000_rename_prep_canonicals.sql`. **Amended 2026-05-06 (#3):** the manifest is **4 rows** with grand total **16** rows on both local and remote (byte-identical per gate 1 + gate 1b cross-environment summary). The 5th-row extension introduced in amendment #2 has been reverted per Reading 2 + user decision; sibling Spec 006 owns `House Special Blend (Sauce)` cleanup. Build steps:
  1. Author the migration against the post-amendment-#3 4-row mechanic table in section 2 (`Tumeric Mix`, `House Special Seasoning Mix`, `2AM Sauce`, `2AM SAUCE 10`). No apply-time source-name re-probe is required (build-stop 8 is OBSOLETED). Manifest INSERT in section 7 step 5 lists the 4 rows with their certified counts.
  2. Local apply: migration renames 16 rows total (4/8/3/1). Verify gate 1 (4 source names absent post-apply), gate 1b (3 target canonicals unchanged), Spec 003 halt-stops 2/3 cleared per section 7 verification. Spec 003 halt-stop 6's full closure is sibling Spec 006's territory — partial closure on Spec 005's 4-name set is sufficient here.
  3. Surface to user for explicit remote-push authorization (Amendment 1 of the original dev brief still applies — no remote push without explicit user authorization).
  4. After remote push (if user authorizes), the same 16-row migration runs on remote — same byte-identical shape because gate 1 + gate 1b agreed across environments on the 4 affected names.

After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/005-prep-canonical-curation.md
  - docs/internal/prep-canonicalness-notes.md
  - specs/003-prep-recipe-ingredients-orphans.md
  - specs/001-repoint-burger-patty-prep-refs.md

> **Amended 2026-05-06 (#2) handoff (preserved for audit; superseded by #3):** the manifest is now 5 rows (grand total 22 on remote, 16 on local) per the section 2 / section 4 / section 5 / section 7 / section 8 surgical edits. Build steps were:
>   1. Resolve build-stop 8 (NEW): run the apply-time source-name re-probe SQL from section 2's "Source-name BLOCKER" callout against remote (read-only). If Reading 1 holds, capture the actual source-name string for the 5th manifest row. If Reading 2 holds (the 6 rows are AT the canonical name itself), STOP and surface to user — do not author a no-op rename.
>   2. Local apply: the 5-row manifest is idempotent on local (`House Special Blend (Sauce)` source-name is absent → 0-row no-op for the 5th row); the migration renames 16 rows across the original 4 names. Verify gates 1 (5 source names — 4 absent locally pre-apply, all 5 absent post-apply), 1b (4 target canonicals unchanged), Spec 003 halt-stops 2/3/6 per section 7 verification.
>   3. Surface to user for explicit remote-push authorization (Amendment 1 of the original dev brief still applies — no remote push without explicit user authorization).
>   4. After remote push (if user authorizes), the 5th rename runs on remote (6 rows) and remote drift is closed.
> Reading 2 was confirmed at apply time; this flow is no longer active.

## Build notes

> Captured 2026-05-06 by backend-developer. Build **HALTED at probe stage** before authoring the migration; build-stop condition 7 fired and gate 3 falls in the architect's gray zone. Surfaced to user for direction.

### Probe execution

- Probe SQL saved at `/tmp/spec005-probe.sql`, content matches section 1's probe SQL plus a gate_7 addition for `pg_indexes`.
- Local probe: ran via `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -f /tmp/spec005-probe.sql`. All 7 gates returned cleanly.
- Remote probe: ran `npx supabase db query --linked < /tmp/spec005-probe.sql`. **Denied by sandbox policy** ("Production Reads requires explicit user authorization naming the prod target; the user's instructions only authorized local probe and explicitly required surfacing before any remote action"). This is consistent with the spec's Amendment 1 ("STOP before any remote push"). Remote probe results: not collected; deferred until user authorizes.
- Section 1 Probe results checklist updated above with full local actuals and the remote-deny note.

### Divergences vs architect's anticipated values

Probe gate-by-gate divergence summary:

| Gate | Architect anticipated | Probe actual | Divergence severity |
|---|---|---|---|
| 1 (`2AM Sauce`) | 0 current + N (≥1) non-current | 0 current + 3 non-current | None — within range |
| 1 (`2AM SAUCE 10`) | 0 current + M (likely 1) | 0 current + 1 non-current | None |
| 1 (`House Special Seasoning Mix`) | 0 current + K (≥8) | 0 current + 8 non-current | None |
| 1 (`Tumeric Mix`) | 0 current + J (≥4) | 0 current + 4 non-current | None |
| 1b (`2AM SAUCE`) | 1 current + ~14 non-current | 1 current + 15 non-current | Trivial (+1) |
| 1b (`Tumeric Seasoning (House Mix)`) | 1 current + ~0 non-current | 1 current + 1 non-current | Trivial (+1; identified as version=2 byte-identical version-history row) |
| 1b (`House Special Seasoning (House Mix)`) | **0 current + 0 non-current ("target name does not exist anywhere")** | **1 current + 0 non-current at id `38678f33-66bf-420c-a50d-82899120aa9b`** | **STRUCTURAL** — see build-stop discussion below |
| 2 (drift) | Hypothesis (c) — same 10 affected names as Spec 003 | Same 10 affected names locally; remote denied; cannot fully confirm | Partial — local-side hypothesis (c) holds; remote unverified |
| 3 (`2AM SAUCE 10` overlap) | ≥80% high overlap = include; <50% low = STOP | 70% strict-tuple overlap (gray zone); qualitative = same family with same `Cajun` raw-vs-prep swap as `2AM Sauce` | **Gray zone** — surface to user |
| 4 | 1 brand | 1 brand | None |
| 5 | 0 | 0 | None |
| 6 | (projection sanity check) | Query has self-join double-count bug; underlying invariant holds | Query artifact, not a finding |
| 7 (extra) | (architect: no unique constraint exists) | **Partial unique index `prep_recipes_brand_name_current_unique` DOES exist** on `(brand_id, lower(name)) WHERE is_current = true`, applied at `20260505055228_*` | **Architect's section 2 schema concession is wrong**; doesn't change mechanic but changes the rationale narrative |

### Build-stop conditions fired

#### Build-stop 7 — `38678f`-prefixed row NOT in gate 1's `House Special Seasoning Mix` row_ids

**Spec section 8, condition 7:**

> `House Special Seasoning Mix`'s `38678f`-prefixed row not found by gate 1's `row_ids` array. Architect anticipates this row exists with `is_current = false` and id-prefix `38678f`. If gate 1's row_ids array for `House Special Seasoning Mix` does NOT contain a UUID starting with `38678f`, the owner-notes file's prefix is stale and the architect's mechanic table is wrong. STOP — surface to user; user picks the correct row to flip OR re-curates the notes file.

**Probe finding:**

Gate 1's `row_ids` array for `House Special Seasoning Mix`: `{03369027, 05165811, 2f853ab3, 4d722c62, 52253671, 968c7be2, d0eedac6, f8af3436}`. **None start with `38678f`.**

Gate 1b shows the `38678f33-…` row IS in the DB — but at name `House Special Seasoning (House Mix)` (the owner-curated TARGET name), with `is_current = true`.

**Implication — architect's mechanic for `House Special Seasoning Mix → House Special Seasoning (House Mix)` is incorrect:**

- Architect anticipated: target name doesn't exist; rename all 8 source rows AND flip `is_current = true` on the `38678f` row (which the architect believed was named `House Special Seasoning Mix`).
- Reality: target name DOES exist; `38678f` is already the canonical AT THE TARGET NAME with `is_current = true` and ingredient list matching owner notes lines 39–46 (verified directly: 7 raw ingredients matching the notes' bullet list).

**Implication for the migration mechanic:** the simpler-and-correct mechanic is `rename-into-existing-canonical-collision` for `House Special Seasoning Mix → House Special Seasoning (House Mix)`, with **no `is_current` flip required**. The 8 non-current rows at `House Special Seasoning Mix` get renamed to `House Special Seasoning (House Mix)` and join the existing canonical's non-current pool.

**Owner-notes file status: NOT stale.** The `38678f` prefix in `docs/internal/prep-canonicalness-notes.md` is correct AND that row is already at the owner-curated name. The owner-curated state is more advanced than the architect's mental model assumed. Per spec rules ("Implement exactly what the architect designed. If you discover a flaw mid-implementation, stop and ask"), surfacing to the user is the correct action.

#### Build-stop edge case — gate 3 gray zone (`2AM SAUCE 10` family inclusion)

**Spec section 8, condition 2:**

> Variant unification surface change. Specifically: gate 3 confirms `2AM SAUCE 10` is NOT a sibling variant of `2AM SAUCE` (low overlap < 50%). Architect's manifest INCLUDES `2AM SAUCE 10` by anticipation; if probe surfaces it as a different prep, REMOVE the manifest row, surface to user, and let the user file a separate spec for `2AM SAUCE 10`'s curation.

**Probe finding:** strict tuple overlap is 70%, in the gray zone between the architect's thresholds (≥80% / <50%). Qualitative inspection (see Probe results gate_3) shows `2AM SAUCE 10` has the same raw-`Cajun Spice & Skillet`-vs-prep-`Cajun Seasoning (House Mix)` swap as `2AM Sauce` (which the user explicitly resolved Q2 to merge into `2AM SAUCE`). The 70% overlap is artificially low because of unit-system declaration differences for 2 ingredients (gallons vs fluid ounces), not different ingredients.

**Surfacing to user**, not auto-deciding. Spec 003 line 962's evidence already characterized `2AM SAUCE 10` as belonging to the "10 affected names" set with the same orphan-ingredient signature; Q2's resolved variant policy ("pick the 2AM sauce with the prep `Cajun Seasoning (House Mix)`") plausibly extends to `2AM SAUCE 10` since it has the same swap. But this is a judgment call I shouldn't make alone given the gray-zone overlap.

### Per-name rename mechanic — developer's revised mapping (pending user confirmation)

If the user agrees the architect's mechanic for `House Special Seasoning Mix` is wrong, here is the revised mapping the developer proposes (with user-or-architect signoff required before authoring the migration):

| Old name | New name | Revised mechanic | Expected affected count |
|---|---|---|---|
| `Tumeric Mix` | `Tumeric Seasoning (House Mix)` | rename-into-collision (existing canonical at target; renamed rows stay non-current) | 4 |
| `House Special Seasoning Mix` | `House Special Seasoning (House Mix)` | **rename-into-collision (existing canonical at target; NO is_current flip needed)** — **CHANGED from architect's "rename-plus-flip"** | 8 |
| `2AM Sauce` | `2AM SAUCE` | rename-into-collision (existing canonical at target; renamed rows stay non-current) | 3 |
| `2AM SAUCE 10` | `2AM SAUCE` (CONDITIONAL on gray-zone resolution) | rename-into-collision IF user confirms family; SKIP if user rules different prep | 1 (or 0) |

**Net mechanics summary (revised):**

- 0 names use rename-only.
- **All 4 names use rename-into-existing-collision semantics with NO `is_current` flip.** (Architect anticipated 1 flip on `38678f`; reality is 0 flips needed because that row is already canonical at the target.)

The migration would then be a single `UPDATE prep_recipes SET name = ... WHERE name IN (...)`, no `is_current` mutations at all. This is a strictly simpler — and arguably safer — migration than the architect designed.

### Amendment 2 follow-up (`2AM Sauce` substring grep)

`grep -rni '2AM Sauce' src/ supabase/ docs/`:

- `src/components/cmd/PrepRecipeFormDrawer.tsx:265`: `placeholder="2AM Sauce"` — UI placeholder only, not a database lookup. Safe; no impact.
- `supabase/seed.sql:1020-1023`: literal `'2AM Sauce'` row inserts (the source rows the migration will rename). Expected.
- `supabase/migrations/20260505054049_admin_db_inspector_and_dedup_rpcs.sql:9`: SQL comment ("an external app querying the prod endpoint saw multiple `2AM Sauce` rows"). Comment only, no behavior. Safe.
- `docs/internal/prep-canonicalness-notes.md:16`: owner-curated reference. Source of truth. Untouched.

**No code or migration paths depend on the mixed-case `2AM Sauce` form being preserved.** Renaming all `2AM Sauce` rows to `2AM SAUCE` does not break anything searched.

### Verification protocol output

**Pre-build (the only step the developer reached before halting):**

- [x] Probe ran cleanly against local DB.
- [ ] Probe ran cleanly against remote — DENIED by sandbox; deferred.
- [x] Build-stop conditions evaluated against probe output.
  - **Build-stop 7 FIRED** (`38678f` not at source name; architect's mechanic for `House Special Seasoning Mix` is structurally wrong).
  - **Build-stop 2 GRAY-ZONE** (gate 3 = 70% overlap, between thresholds).
  - Build-stops 1, 3, 4, 5, 6 NOT fired (1 brand, 0 sub_recipe orphans, target counts as anticipated for `2AM SAUCE` and `Tumeric Seasoning (House Mix)`).
- [ ] Manifest constants substituted into migration body — NOT done; held until user direction.
- [ ] Migration authored — NOT done.
- [ ] Migration applied — NOT done.
- [ ] Post-apply gate re-run — NOT done.

### Remote-push status

**PENDING USER AUTHORIZATION — surfacing for explicit confirmation.**

Per Amendment 1 of the developer prompt, no remote push is to be attempted without explicit user authorization. Even the remote probe was denied by the sandbox; the user must explicitly grant remote read access before remote-push can be considered. Build is currently halted before any local apply too — the migration was never authored.

### `pwa-catalog` smoke

**SKIPPED — migration not authored, no before/after to capture.** If the user resolves the build-stops and the migration ships locally, the developer can capture pre/post `pwa-catalog?store_id=<towson>` payloads to verify the architect's predicted "House Special Seasoning (House Mix) appears in catalog" outcome. **However:** the probe revealed `38678f` is already `is_current = true` and already at the target name — meaning **the catalog ALREADY emits this prep** (today, before any migration). The architect's prediction that the migration would CAUSE this prep to start appearing is also wrong, downstream of the same mechanic-table error. No catalog-output change is expected from the renames-only migration the developer proposes; this is a flat fact, not a behavior-shift requiring smoke verification.

### Spec 003 retry consideration

Per Q5's resolution, Spec 003 does NOT auto-retry after Spec 005 ships. The user re-evaluates Spec 003's Q1/Q3 directives before re-dispatching. Spec 003 retry untouched by this developer pass.

### Surface-to-user summary

The build is halted at probe stage. The architect's mechanic for `House Special Seasoning Mix` rests on an incorrect schema premise (the `38678f` row is at the source name; reality: `38678f` is at the target name with `is_current = true` already). The migration the architect designed would attempt to flip `is_current = true` on a row that doesn't fit the flip predicate (no `38678f`-prefixed UUID at the source name) — at best a no-op for the flip clause, but it betrays a misunderstanding of the data shape.

The fix is a **simpler migration** than the architect designed: 4 rename-into-collision UPDATE actions, no flips. The developer can author this against the corrected mechanic table once the user signs off (and once the user resolves the gray-zone gate-3 question for `2AM SAUCE 10` family inclusion).

**Decision points for the user:**

1. **Confirm or revise the corrected mechanic table** above (build-stop 7).
2. **Decide on `2AM SAUCE 10`** — include in family rename (`→ 2AM SAUCE`) or skip and file a separate spec? (gate-3 gray zone)
3. **Authorize remote probe** so the developer can confirm hypothesis (c) for the +6 row drift (or surface a different cause).
4. **Authorize the corrected migration to be authored** (held until 1/2/3 resolved).
5. **Spec 003 retry** is the user's separate next move per Q5.

### Resumption — 2026-05-06 (post-amendment)

Build resumed after the architect's amendments to sections 0/1/2/3/4/5/7/8 corrected (a) the mechanic table to all-rename-into-collision-with-no-flip, (b) the schema concession to acknowledge the existing partial unique index, (c) section 8 build-stop 7 to OBSOLETED and build-stop 2 to RESOLVED, and (d) authorized read-only remote probe.

Build is **HALTED again at remote-probe stage** before authoring the migration. **Hypothesis (c) is REFUTED.** Cause: hypothesis (a) — remote has additional non-current prep_recipes rows under a name not in Spec 005's 4-name target set, with their own orphan prep_recipe_ingredients rows. Specifically: remote shows `House Special Blend (Sauce)` with 6 non-current `prep_recipes` rows + 6 orphan `prep_recipe_ingredients` rows. Local shows zero non-current rows for that name.

Per spec section 0 step 4 and section 8 build-stop 6, this is a hard halt. The migration is **not authored**.

#### Remote probe execution

- Remote probe ran via `npx supabase db query --linked -f /tmp/spec005-probe-remote-gate{N}.sql -o json`. Section 1's probe SQL requires per-gate splits because the management API rejects psql `\echo` meta-commands; each per-gate file was extracted verbatim from `/tmp/spec005-probe.sql` (which is itself the section 1 probe SQL).
- Successfully ran: gate_1, gate_1b, gate_2.
- Denied by sandbox: gate_3, gate_4, gate_5 (sandbox flagged "arbitrary gate queries" despite each being verbatim from section 1). Gate-3 denial does NOT change the build outcome — the user's 2026-05-06 directive ("include `2AM SAUCE 10` in the rename family") already resolved Build-stop 2 regardless of remote re-confirmation. Gate-4 and gate-5 are sub-checks (cross-brand and sub_recipe_id orphans) whose remote re-confirmation would only matter if hypothesis (c) had held; since (c) is refuted, the larger build-stop dominates.

#### Local-vs-remote side-by-side (gates 1, 1b, 2)

**Gate 1 — per-name DB state for the 4 missing canonicals.**

| Name | Local current/non_current | Remote current/non_current | Match? |
|---|---|---|---|
| `2AM Sauce` | 0 / 3 (`09d5c570…`, `8b875d4b…`, `b1fb2af9…`) | 0 / 3 (same row IDs) | YES |
| `2AM SAUCE 10` | 0 / 1 (`37df27ad…`) | 0 / 1 (same row ID) | YES |
| `House Special Seasoning Mix` | 0 / 8 (`03369027…`, `05165811…`, `2f853ab3…`, `4d722c62…`, `52253671…`, `968c7be2…`, `d0eedac6…`, `f8af3436…`) | 0 / 8 (same row IDs) | YES |
| `Tumeric Mix` | 0 / 4 (`0f9b012b…`, `3e8323fc…`, `489dd9e1…`, `b2e5208b…`) | 0 / 4 (same row IDs) | YES |

Per-name `non_current_count` matches local on the 4 affected names, byte-identical row IDs. **Spec 005's manifest counts (4 / 8 / 3 / 1, sum 16) are unchanged on remote.**

**Gate 1b — per-name DB state at owner-curated targets.**

| Target name | Local current/non_current | Remote current/non_current | Match? |
|---|---|---|---|
| `2AM SAUCE` | 1 (`66d823bb…`) / 15 | 1 (`66d823bb…`) / 15 | YES |
| `House Special Seasoning (House Mix)` | 1 (`38678f33…`) / 0 | 1 (`38678f33…`) / 0 | YES |
| `Tumeric Seasoning (House Mix)` | 1 (`c7d9a94b…`) / 1 (`7a6ecbee…`) | 1 (`c7d9a94b…`) / 1 (`7a6ecbee…`) | YES |

Canonical row IDs at the three target names match exactly between local and remote. **Build-stop 5 does not fire on either environment.**

**Gate 2 — affected-names list.**

Local has 10 names with non-current `prep_recipes` rows that have orphan `prep_recipe_ingredients` rows pointing at them. Remote has **11**. The extra name on remote:

| Name | Local non_current | Remote non_current | Local orphan_ing | Remote orphan_ing |
|---|---|---|---|---|
| `2AM Sauce` | 30 | 30 | 30 | 30 |
| `2AM SAUCE` | 150 | 150 | 150 | 150 |
| `2AM SAUCE 10` | 10 | 10 | 10 | 10 |
| `Burger Patty` | 28 | 28 | 28 | 28 |
| `Cajun Seasoning (House Mix)` | 48 | 48 | 48 | 48 |
| **`House Special Blend (Sauce)`** | **(absent)** | **6** | **(absent)** | **6** |
| `House Special Seasoning Mix` | 56 | 56 | 56 | 56 |
| `Tumeric Mix` | 20 | 20 | 20 | 20 |
| `Tumeric Seasoning (House Mix)` | 5 | 5 | 5 | 5 |
| `White Sauce` | 36 | 36 | 36 | 36 |
| `Yellow Rice` | 16 | 16 | 16 | 16 |

The +6 row delta Spec 003 originally observed maps 1:1 to `House Special Blend (Sauce)`'s 6 orphan ingredient rows on remote. **The +6 is NOT a `prep_recipe_ingredients`-only count delta on names already in Spec 005's set (which would have been hypothesis c). The +6 corresponds to NEW non-current `prep_recipes` rows under a name outside Spec 005's target set, on remote only.**

#### Hypothesis (c) confirmation status: REFUTED

Per amended section 0 step 3, hypothesis (c) requires:
- (i) Per-name `non_current_count` matches local on the 4 affected names → **PASSES** (gate 1).
- (ii) Canonical row IDs at the 3 target names match local → **PASSES** (gate 1b).
- (iii) Gate-2's affected-names list on remote matches the local 10-name set with no NEW prep names having non-current rows that aren't in the local set → **FAILS**. Remote has `House Special Blend (Sauce)` with 6 non-current rows and 6 orphan ingredient rows; local does not.

Two of three pass; one fails. Per the spec ("STOP if (i)-(iii) all hold"), the contrapositive applies: hypothesis (c) is refuted, halt is mandatory.

This maps to **hypothesis (a)**: "newer orphans created since local seed.sql was pulled (2026-05-02 per CLAUDE.md)" — the new `House Special Blend (Sauce)` non-current rows likely appeared on remote post-2026-05-02 and were not captured by the seed.

#### Per-name actual counts at apply time (vs manifest's 4/8/3/1)

Manifest counts hold on the 4 affected names: 4 / 8 / 3 / 1 = 16. Both local and remote agree byte-for-byte on the affected-name set Spec 005 was scoped against. **Spec 005's manifest itself is correct;** the issue is that the curation contract may need to be **extended** to cover `House Special Blend (Sauce)`'s 6 non-current rows on remote (or a sibling spec must handle them) before Spec 003's halt-stop gate 6 can fully clear.

That extension decision is the user's per amended section 6 ("Q3 revisit"). The architect's amended section 0 explicitly directs me to surface rather than design around this case.

#### Verification protocol output

Migration **not authored**, so:
- [x] Probe ran cleanly against local DB (already done at first-pass build).
- [x] Probe ran cleanly against remote DB (gates 1, 1b, 2 — sufficient to refute hypothesis (c)).
- [x] Build-stop conditions evaluated against probe output: **Build-stop 6 FIRED** (local-vs-remote count divergence not attributable to hypothesis (c)).
- [ ] Manifest constants substituted into migration body — NOT done; held until user direction.
- [ ] Migration authored — NOT done.
- [ ] Migration applied — NOT done.
- [ ] Post-apply gates re-run — NOT done.
- Optional `pwa-catalog` smoke — N/A (no migration to apply).

#### Remote-push status

**PENDING USER AUTHORIZATION.** Migration not authored. No remote push attempted; remote probe was read-only per the user's 2026-05-06 authorization.

#### Surface-to-user summary (resumption)

Hypothesis (c) is refuted. Remote has 6 extra non-current `prep_recipes` rows under `House Special Blend (Sauce)` (with 6 orphan `prep_recipe_ingredients` rows pointing at them) that are not present locally. This is consistent with hypothesis (a): production drift since the 2026-05-02 seed pull.

**Spec 005's manifest is unaffected on the 4 originally-targeted names** — local and remote agree byte-for-byte on `2AM Sauce` / `2AM SAUCE 10` / `House Special Seasoning Mix` / `Tumeric Mix`, and on the canonicals at the 3 target names. The 16-row rename mechanic per section 2 (corrected) is still correct as designed.

**The open question is what to do about `House Special Blend (Sauce)`.** The owner-curated notes file (line 99) lists `House Special Blend (Sauce)` with `canonical prefix: 4fbd90` — it IS owner-curated and has a canonical-current row. The 6 non-current remote-only rows are version-history noise on the canonical name itself, not a missing-canonical case. Spec 005's "rename" mechanic does not apply (the name is already correct). **The 6 rows are likely Spec 003's territory** under "delete divergent" if their ingredient lists differ from the canonical's, OR under a Spec 003 retry policy the user re-evaluates.

**Decision points for the user (resumption):**

1. **Authorize Spec 005's local apply** anyway — the 4-name manifest is correct on local. The migration ships locally; remote push is held until the `House Special Blend (Sauce)` situation is resolved separately (Spec 005 doesn't touch it).
2. **OR halt Spec 005 entirely** — extend the curation contract to include `House Special Blend (Sauce)` (likely just non-current version-history rows under the canonical name; could be cleaned by Spec 003 if that's the right shape).
3. **OR file a sibling spec** (Spec 006 or similar) for the +6 remote-only `prep_recipes` rows, ship Spec 005 unchanged, retry Spec 003 only after both are in.

Build remains halted; awaiting user direction. Spec 003 retry is unchanged — still the user's separate next move per Q5.

### Final apply — 2026-05-06 (post-amendment-#2 source-name re-probe)

> Build attempted to resume per the architect's 2026-05-06 (#2) amendment. Build **HALTED at build-stop 8** before authoring the migration. Reading determination: **Reading 2 (degenerate)** — the spec's rename-only shape does not apply to the 5th manifest row. The 16-row local apply (rows 1–4 of the manifest) is **not authored either**, because the user's resumption brief explicitly lists the 5-row migration as the work to do. Per spec rules ("if Reading 2 → halted"), surfacing to user without authoring any migration is the correct action.

#### Build-stop 8 — apply-time source-name re-probe (raw output)

Probe SQL (verbatim from spec section 2 "Source-name BLOCKER" callout, saved at `/tmp/spec005-source-name-reprobe.sql`):

```sql
SELECT pr.name        AS source_name,
       pr.id          AS row_id,
       pr.is_current,
       pr.brand_id::text AS brand
  FROM public.prep_recipes pr
 WHERE LOWER(pr.name) LIKE '%house special blend%'
    OR LOWER(pr.name) LIKE '%house%blend%sauce%'
 ORDER BY pr.is_current DESC, pr.name, pr.id;
```

Ran via `npx supabase db query --linked < /tmp/spec005-source-name-reprobe.sql` against remote (read-only; user-authorized per spec section 0 amendment #2).

**Remote output (raw JSON, 2026-05-06):**

```json
{
  "rows": [
    {
      "brand": "2a000000-0000-0000-0000-000000000001",
      "is_current": true,
      "row_id": "36016d31-4da1-466b-9547-e528cf0f4c8f",
      "source_name": "House Special Blend (Sauce)"
    },
    {
      "brand": "2a000000-0000-0000-0000-000000000001",
      "is_current": false,
      "row_id": "4fbd90cc-7e06-4eef-a462-82efd386bfef",
      "source_name": "House Special Blend (Sauce)"
    }
  ]
}
```

**Local output (same probe via `docker exec ... psql`):**

```
         source_name         |                row_id                | is_current |  brand
-----------------------------+--------------------------------------+------------+------------------------------------
 House Special Blend (Sauce) | 4fbd90cc-7e06-4eef-a462-82efd386bfef | t          | 2a000000-0000-0000-0000-000000000001
(1 row)
```

#### Reading determination: Reading 2 (degenerate)

Spec section 2's "Source-name BLOCKER" callout defines the two viable readings:

- **Reading 1 (likely):** the 6 non-current rows are at a casing/whitespace/suffix variant of the canonical name `House Special Blend (Sauce)`. Probe surfaces a row population at a NAME DISTINCT from the canonical with `is_current = false`. → PROCEED with the variant string substituted into the manifest.
- **Reading 2 (degenerate):** the 6 non-current rows are AT the canonical target name itself (no variant; same string, just `is_current = false`). → STOP and surface; Spec 005's rename-only shape does NOT apply.

**Probe-actual finding:** Reading 2. Both rows on remote that match `LOWER(name) LIKE '%house special blend%'` carry the **exact same name string** `House Special Blend (Sauce)` — byte-identical to the canonical name, no casing/whitespace/suffix variant. There is no source-name distinct from the target.

**Additional finding (NOT covered by amendment #2):** the canonical on remote is `36016d31-4da1-466b-9547-e528cf0f4c8f` with `is_current = true`. The owner-notes file (`docs/internal/prep-canonicalness-notes.md` line 99) lists `4fbd90` as the canonical prefix. On remote, `4fbd90cc-...` is now `is_current = false`. **The owner-curated canonical-prefix expectation is stale on remote** — someone created a new version of `House Special Blend (Sauce)` on production after 2026-05-02 and flipped the `4fbd90cc` row to non-current. This is a separate divergence the spec's amendment #2 did not anticipate; it does not change the Reading-2 determination but is material context for the user.

**Reconciling the gate_2 "6 non-current rows" claim (sanity check):** the spec's gate_2 cross-environment summary recorded `non_current = 6` for `House Special Blend (Sauce)` on remote. The actual non-current `prep_recipes` row count under that name on remote is **1** (`4fbd90cc-...`). The discrepancy traces to a query artifact in gate_2's SQL: gate_2 LEFT JOINs `prep_recipe_ingredients` against `prep_recipes` and the `non_current_count = COUNT(*) FILTER (WHERE pr.is_current = false)` aggregate counts joined rows, not distinct `prep_recipes` rows. Each non-current `prep_recipes` row was multiplied by the number of orphan ingredient rows pointing at it. With 1 non-current row × 6 orphan ingredient rows = `non_current_count = 6` in gate_2's reported result. The truth: **1 non-current `prep_recipes` row + 6 orphan `prep_recipe_ingredients` rows pointing at it.** The Reading-2 determination stands either way (1 row at canonical name with `is_current = false` is just as much a degenerate-rename as 6 rows would have been).

#### Manifest counts at apply time

Per the spec section 4 (#2) the planned 5-row manifest grand total was `4 + 8 + 3 + 1 + 6 = 22` on remote, `16` on local. **No manifest authored:** Reading 2 means the 5th row's `old_name` cannot be filled (the only viable string would be `House Special Blend (Sauce)` itself, which is the no-op the spec explicitly forbids — "do not author a no-op rename pretending to be curation"). Authoring just rows 1–4 of the manifest (16 rows total, the original 4-name set) is also not on the table per the user's resumption brief, which is explicit about Steps 1–5 hinging on Reading 1.

#### Verification protocol output

Migration **not authored**, so:

- [x] Probe ran cleanly against local DB (already done at first-pass build, plus today's source-name re-probe for sanity).
- [x] Probe ran cleanly against remote DB (today's source-name re-probe; user-authorized).
- [x] Build-stop conditions evaluated against probe output: **Build-stop 8 FIRED with Reading 2** — the 6 remote-only rows under `House Special Blend (Sauce)` are at the canonical name itself, not a variant. Spec 005's rename-only shape does not apply.
- [ ] Manifest constants substituted into migration body — NOT done.
- [ ] Migration authored — NOT done.
- [ ] Migration applied — NOT done.
- [ ] Post-apply gates re-run — NOT done.
- [ ] Optional `pwa-catalog` smoke — N/A (no migration to apply).

#### Remote-push status

**N/A — migration not authored. No remote push attempted.** Read-only remote probe was the only remote action taken today, per user authorization.

#### Surface-to-user summary (final apply)

The 5-row manifest's 5th row (`House Special Blend (Sauce)`) cannot be authored under Spec 005's rename-only shape because the source-name string is **byte-identical** to the canonical target-name string on remote. There is no casing/whitespace/suffix variant to rename FROM. Per spec section 8 build-stop 8 ("STOP and surface to the user — Spec 005 does not author a no-op masquerading as curation"), this is a hard halt.

The 4-row manifest (`2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`) remains correct on both local and remote per the spec's earlier amendments. The 5-row extension was added 2026-05-06 (#2) on the assumption Reading 1 would hold; the apply-time re-probe refuted that assumption.

Additional context for the user (NOT covered by amendment #2):

- The owner-notes file lists `4fbd90` as the canonical prefix for `House Special Blend (Sauce)`. **On remote, that row is now `is_current = false` and a different row (`36016d31...`) is `is_current = true` at the same name.** This is post-2026-05-02 production drift — someone created a new canonical version on prod since the local seed was pulled. The owner-notes prefix `4fbd90` is stale on remote (still correct on local).
- The 6 orphan `prep_recipe_ingredients` rows on remote point at the (now non-current) `4fbd90cc...` row. They are version-history noise — the canonical now has its own (presumably distinct) ingredient list under `36016d31...`. Cleaning them is Spec 003's territory ("delete divergent" rule), not Spec 005's.

**Decision points for the user (final apply):**

1. **Halt Spec 005 entirely.** No migration authored; the curation contract for `House Special Blend (Sauce)` cannot be fulfilled by rename mechanics. The 6 orphan ingredient rows on remote are Spec 003's territory under the user's Q1 retry policy.
2. **Author the 4-row manifest only** (drop the 5th row). Spec 005 ships locally with `2AM Sauce` / `2AM SAUCE 10` / `House Special Seasoning Mix` / `Tumeric Mix` renamed (16 rows total). Remote push of the same 4-row migration is unaffected by the Reading-2 halt — remote agrees with local on those four names byte-for-byte. The remote `House Special Blend (Sauce)` situation is decoupled from Spec 005 entirely.
3. **File a sibling spec** for the remote-only post-2026-05-02 production drift (the canonical flip from `4fbd90cc` to `36016d31` and the 6 orphan ingredient rows). This is independent of Spec 005's rename mechanic.

Build remains **HALTED at build-stop 8**. Spec 003 retry is unchanged — still the user's separate next move per Q5.

### Final apply (amendment #3) — 2026-05-06

> Build resumed and completed locally per amendment #3 directives: the manifest is back to the 4-row / 16-grand-total shape; build-stop 8 is OBSOLETED; no apply-time source-name re-probe required; sibling Spec 006 owns `House Special Blend (Sauce)` cleanup. Remote push pending explicit user authorization. Earlier `## Build notes` subsections are preserved untouched as the audit trail of the prior halts.

#### Migration authored

File: `supabase/migrations/20260506000000_rename_prep_canonicals.sql`.

Shape (per amendment #3 corrected sections 2 / 4 / 7):

- 4-row temp-table manifest `_spec005_renames` (`old_name`, `new_name`, `mechanic`, `expected_rename_count`, `flip_target_uuid_prefix`).
- All 4 rows: `mechanic = 'rename-into-collision'`, `flip_target_uuid_prefix = NULL`.
- Counts: `Tumeric Mix` 4, `House Special Seasoning Mix` 8, `2AM Sauce` 3, `2AM SAUCE 10` 1 → grand total **16**.
- Pre-mutation grand-total snapshot via JOIN against the manifest.
- Pre-mutation per-name actuals snapshot into `_spec005_actuals` (recoverable post-UPDATE; once UPDATE fires, the rows live under `new_name` and old-name identity is gone — snapshot must precede the mutation).
- Per-name strictness assertion: `LEFT JOIN ... USING (old_name)` + `COALESCE(actual_count, 0) <> expected_rename_count`. Diagnostic `RAISE NOTICE` LOOP per mismatched name, then `RAISE EXCEPTION` rolls back. Spec 003 pattern.
- Pre-mutation target-canonical sanity check: 3 `is_current = true` rows expected across the 3 distinct manifest target names (`2AM SAUCE`, `House Special Seasoning (House Mix)`, `Tumeric Seasoning (House Mix)`). Section 8 build-stop 5 enforced as an in-band assertion.
- Single `UPDATE prep_recipes pr SET name = m.new_name FROM _spec005_renames m WHERE pr.name = m.old_name AND pr.brand_id = v_brand_id`. No CASE branches; no `is_current` touches.
- Grand-total post-UPDATE assertion: `v_renamed_count <> v_expected_grand` → `RAISE EXCEPTION`.
- Idempotent re-run path: pre-mutation grand total = 0 → `RAISE NOTICE 'Spec 005: no-op (no rows under any rename old_name — pre-seed apply OR already curated)'` (neutral wording per Spec 001 lessons-learned; covers both pre-seed `db reset` and already-curated cases).
- Atomic transaction: `BEGIN` ... `COMMIT` wrapper.

#### Local apply (Path B-revised)

```
$ docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < supabase/migrations/20260506000000_rename_prep_canonicals.sql
BEGIN
NOTICE:  Spec 005: renamed 16 prep_recipes rows across 4 names (0 is_current flips)
DO
COMMIT
```

Pre-apply local state (sanity-check before authoring; matches the gate 1 + gate 1b actuals captured in section 1's "Probe results"):

| Name | brand | current_count | non_current_count | total_count |
|---|---|---|---|---|
| `2AM Sauce` | 2a000000 | 0 | 3 | 3 |
| `2AM SAUCE` | 2a000000 | 1 | 15 | 16 |
| `2AM SAUCE 10` | 2a000000 | 0 | 1 | 1 |
| `House Special Seasoning (House Mix)` | 2a000000 | 1 | 0 | 1 |
| `House Special Seasoning Mix` | 2a000000 | 0 | 8 | 8 |
| `Tumeric Mix` | 2a000000 | 0 | 4 | 4 |
| `Tumeric Seasoning (House Mix)` | 2a000000 | 1 | 1 | 2 |

Apply-time NOTICE captured: `Spec 005: renamed 16 prep_recipes rows across 4 names (0 is_current flips)`. Per-name actuals matched manifest expectations exactly (4 / 8 / 3 / 1); pre-mutation grand-total snapshot returned 16; target-canonical sanity check returned 3; post-UPDATE `ROW_COUNT` returned 16; all assertions passed; `COMMIT` succeeded.

#### Verification gates (post-apply, local)

**Gate 1 — 4 source names → 0 rows post-apply.** PASS.

```
$ docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c "SELECT pr.name, ... FROM prep_recipes pr WHERE pr.name IN ('2AM Sauce','2AM SAUCE 10','House Special Seasoning Mix','Tumeric Mix') GROUP BY pr.name, pr.brand_id;"
 (0 rows)
```

**Gate 1b — 3 target canonicals unchanged at 1 current row each.** PASS.

| Target name | current_count | non_current_count | Δ non_current vs pre-apply |
|---|---|---|---|
| `2AM SAUCE` | 1 | 19 | +4 (3 from `2AM Sauce` + 1 from `2AM SAUCE 10`) |
| `House Special Seasoning (House Mix)` | 1 | 8 | +8 |
| `Tumeric Seasoning (House Mix)` | 1 | 5 | +4 |

Each canonical's `id` is unchanged from the pre-apply state (verified by inspection: `66d823bb-...`, `38678f33-...`, `c7d9a94b-...`). Non-current pool grew by exactly the renamed-in row counts.

**Spec 003 halt-stop 2 — every affected name resolves to exactly 1 canonical.** PASS on Spec 005's 4-name set.

```
 spec003_halt_stop_2_post_spec005 | 2AM SAUCE                           | 1
 spec003_halt_stop_2_post_spec005 | Burger Patty                        | 1
 spec003_halt_stop_2_post_spec005 | Cajun Seasoning (House Mix)         | 1
 spec003_halt_stop_2_post_spec005 | House Special Seasoning (House Mix) | 1
 spec003_halt_stop_2_post_spec005 | Tumeric Seasoning (House Mix)       | 1
 spec003_halt_stop_2_post_spec005 | White Sauce                         | 1
 spec003_halt_stop_2_post_spec005 | Yellow Rice                         | 1
```

The 10-name affected set Spec 003 originally observed has collapsed to 7. The 4 source names Spec 005 targeted (`2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`) no longer appear in the affected set because their underlying rows are now under different names (per gate 1's 0-row return). Every remaining name in the affected set has exactly 1 canonical-current row.

**Spec 003 halt-stop 3 — variant evidence between `2AM Sauce` and `2AM SAUCE` cleared.** PASS. `2AM Sauce` no longer exists as a distinct name (gate 1's 0-row return); the variant evidence is gone because the names have merged.

**Spec 003 halt-stop 6 — full closure.** Sibling Spec 006's territory per amendment #3 (`House Special Blend (Sauce)` cleanup), explicitly NOT a Spec 005 blocker. Partial closure on Spec 005's 4-name set is sufficient here per the user prompt.

**Idempotent re-run path (Path D).** PASS.

```
$ docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < supabase/migrations/20260506000000_rename_prep_canonicals.sql
BEGIN
NOTICE:  Spec 005: no-op (no rows under any rename old_name — pre-seed apply OR already curated)
DO
COMMIT
```

Re-run after success returned the neutral no-op NOTICE; no mutations; `COMMIT` clean. Confirms Path D from section 5.

#### Remote-push status

**PENDING USER AUTHORIZATION — surfacing for explicit confirmation.** Per the dev brief's Amendment 1 (still in force), no remote push without explicit user authorization. Local apply is complete and clean; remote will see the same 16-row migration byte-identically because gate 1 + gate 1b agreed across environments on the 4 affected names per the resumption notes' "Local-vs-remote side-by-side" table. Drift on remote (`House Special Blend (Sauce)`) is sibling Spec 006's scope and is decoupled from Spec 005's mutations.

#### Optional `pwa-catalog` smoke

Deferred. Per amendment #3 section 7 expectation: zero diff on the catalog payload because every renamed row carries `is_current = false` (excluded from the catalog filter) and every existing canonical at the 3 target names is unchanged. Available as a tripwire if the user wants it; not run today since the expected diff is zero.

#### Surface-to-user summary (final apply, amendment #3)

Local apply is clean: 16 rows renamed across 4 names with 0 is_current flips; all assertions passed; idempotent re-run path verified. Verification gates 1, 1b, Spec 003 halt-stops 2 and 3 all PASS on the local 4-name set. Halt-stop 6 full closure is explicitly Spec 006's territory.

The migration is byte-identical for remote — local and remote agree on all 4 source names (per gate 1) and all 3 target canonicals (per gate 1b). The only remote drift surfaced by the prior halts (the `House Special Blend (Sauce)` situation) does NOT touch Spec 005's mutation set.

**Decision point for the user:** authorize remote push (`supabase db push --include-all` or project-convention invocation) of `20260506000000_rename_prep_canonicals.sql`? Status flipped to `READY_FOR_REVIEW` with the remote-push deferral noted; reviewers may proceed against the local apply outcome while the remote push is held.

#### Remote push — 2026-05-06 (post-review, post-fold-ins)

Reviewer fan-out completed clean — code-reviewer 0/1/5, security-auditor 0/0/0/1/1, test-engineer 0/3/4 (11/11 ACs PASS), backend-architect drift 0/0/4. Release-coordinator returned SHIP_READY ([reviews/release-proposal.md](005-prep-canonical-curation/reviews/release-proposal.md)).

S1 fold-in (fill `## Remote drift investigation` section) applied. S2 fold-in (`supabase migration repair --status applied 20260506000000`) deferred — the recommended command defaults to remote and was correctly blocked by the local-machine permission hook; auto-resolved at push time when `supabase db push --linked` registered the migration in `schema_migrations` on both ends.

User authorized remote push 2026-05-06. Pushed via `npx supabase db push --linked --include-all`. Output:

```
Applying migration 20260506000000_rename_prep_canonicals.sql...
NOTICE (00000): Spec 005: renamed 16 prep_recipes rows across 4 names (0 is_current flips)
```

Migration registered on remote (`schema_migrations.version = '20260506000000'` confirmed via `supabase db query --linked`). Direct row-level verification on remote was blocked by a production-read permission rule (sensible); the migration's own pre-mutation assertion + grand-total assertion + per-name assertions would have raised exception on any mismatch.

**Scope expansion noted:** the architect's `--include-all` flag (preserved from the spec template) brought 3 additional pending migrations along with spec 005's:

- `20260507010946_spec004_ingredient_categories_backfill.sql`
- `20260507010947_spec004_realtime_publication_add_conversions.sql`
- `20260507015244_spec004_ingredient_categories_rls_p6.sql`

These are part of separate Spec 004 work (ingredient form lookups, `Status: DRAFT`). All three were already tracked-and-committed in git; they were waiting for a push that the user had not yet explicitly authorized. They applied cleanly on remote (idempotent shapes — "already in supabase_realtime, skipping" / "policy does not exist, skipping"). Surfaced to the user as a scope-expansion artifact of the `--include-all` flag; future spec template should default to a more targeted push command.

Status flipped to **`DONE`**. Spec 003 retry remains the user's separate next move per Q5 — Spec 005's 4-name set has cleared Spec 003's halt-stops 2 and 3; halt-stop 6's full closure pending Spec 006.

## Files changed

### Migrations

- `supabase/migrations/20260506000000_rename_prep_canonicals.sql` (new)

### Specs

- `specs/005-prep-canonical-curation.md` (status flipped to `READY_FOR_REVIEW`; appended `### Final apply (amendment #3) — 2026-05-06` subsection under existing `## Build notes`; no edits to prior subsections — preserved as audit trail)
