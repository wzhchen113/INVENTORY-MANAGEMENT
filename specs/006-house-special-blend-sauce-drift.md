# Spec 006: House Special Blend (Sauce) — remote canonical drift cleanup

Status: DRAFT

## Discovery context

This spec exists because of drift surfaced during **Spec 005**'s build (the
rename-based curation prereq for Spec 003). The Spec 005 developer's pre-impl
remote probe (read-only, user-authorized) found state on remote that does not
exist locally and that owner-curated notes do not reflect.

The originating audit trail lives in Spec 005's `## Build notes` and
`### Final apply` subsections — read those before this spec for the gate-query
output that produced the row counts below.

The owner-intent source of truth for this prep is
`docs/internal/prep-canonicalness-notes.md` line 99, which lists canonical
prefix `4fbd90` for `House Special Blend (Sauce)`.

## What the probe found on remote

1. **Canonical re-version on remote.** The `4fbd90...` row referenced in
   owner-notes is now `is_current = false` on remote. A different row
   (`36016d31...`) holds `is_current = true` at the same name
   (`House Special Blend (Sauce)`). This change happened post-2026-05-02 (the
   `seed.sql` pull date) — i.e., someone re-versioned the canonical on prod
   after the local snapshot was captured.

2. **Non-current row + orphan ingredient rows on remote.** Remote has 1
   non-current `prep_recipes` row at the canonical name with 6 orphan
   `prep_recipe_ingredients` rows joined to it. (The "6 non-current rows"
   figure that appeared earlier in Spec 005's gate_2 output was a
   JOIN-multiplication artifact — actual `prep_recipes` row count is 1, with
   6 ingredient rows fanning it out.)

3. **Local has none of this drift.** Local has only the `4fbd90...` row at the
   canonical name with `is_current = true`, matching owner-notes. The
   divergence is entirely remote-side.

This is the reason Spec 005 dropped `House Special Blend (Sauce)` from its
amendment-#3 manifest — the row sits at the EXACT canonical name (not a
variant), so Spec 005's rename-into-collision shape did not apply.

## User story

As the brand owner, I want the `House Special Blend (Sauce)` prep on remote to
either match owner-notes or have owner-notes updated to match remote — and I
want the orphan ingredient rows referencing the non-current `prep_recipes`
row resolved — so that there is one unambiguous source of truth for this
prep's canonical version and ingredient list.

## Acceptance criteria

The exact criteria depend on the user's answers to the open questions below.
Skeleton form, to be tightened once Q1 / Q3 are resolved:

- [ ] Owner-notes line 99 (`House Special Blend (Sauce)` canonical prefix
      `4fbd90`) and remote `prep_recipes` `is_current = true` row at name
      `House Special Blend (Sauce)` agree on the canonical row id, OR a
      documented divergence rationale is recorded in
      `docs/internal/prep-canonicalness-notes.md` with date and reason.
- [ ] The 1 non-current `prep_recipes` row at name `House Special Blend
      (Sauce)` on remote is in the disposition the user chose (deleted with
      its 6 orphan ingredient rows, kept-as-history with a documented
      rationale, or repointed if Q3 chooses repointing). Remote count after
      apply matches the predicted count exactly — no partial repair on
      unexpected counts.
- [ ] If a migration ships, it is wrapped in a single transaction (Spec 001 /
      003 / 005 precedent), is idempotent on re-run, and was preceded by a
      pre-impl probe whose results are recorded in the spec's `## Build
      notes` section.
- [ ] If no migration ships (e.g., Q1 resolves to "update notes, accept
      remote canonical"), the only artifact is an owner-notes edit and that
      edit is committed.
- [ ] No `prep_recipe_ingredients` row references a `prep_recipes` row that
      no longer exists, scoped to name `House Special Blend (Sauce)` on
      remote.

## In scope

- `prep_recipes` and `prep_recipe_ingredients` rows on remote at the exact
  name `House Special Blend (Sauce)` (both the `is_current = true` row and
  any non-current rows at that name).
- Editing `docs/internal/prep-canonicalness-notes.md` line 99 if the user
  directs.
- A single atomic migration if (and only if) the user's Q1 / Q3 / Q5 answers
  require one.
- Pre-impl probe + post-apply verification probe, results recorded in the
  spec's `## Build notes` section.

## Out of scope (explicitly)

- **Generalized prep-drift detection.** This spec is scoped to one prep name
  only. A generalized "track all production drift between local seed and
  remote" feature is a future spec candidate, not this one.
- **Re-do of Spec 005.** Spec 005's 4-row manifest is unchanged and ships
  independently of this spec. This spec does not modify Spec 005's payload
  in any way.
- **Spec 003 retry.** Spec 003 retry is the user's separate next move per
  Spec 005's Q5. Spec 006 does not gate Spec 003 retry; the drift this spec
  addresses does not intersect Spec 003's gate_1 contract (see Q4 below).
- **Constraint guard / unique index on `prep_recipes (brand_id, name) WHERE
  is_current`.** Originally pinned to Spec 003 section 14, but the partial
  unique index `prep_recipes_brand_name_current_unique` already exists in
  `supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql`,
  so this is a non-issue and explicitly outside Spec 006.
- **Owner-notes auto-sync mechanism.** `docs/internal/prep-canonicalness-notes.md`
  is owner-curated. This spec may propose the owner edit it manually but
  does not add tooling for sync.
- **Investigation of who/what re-versioned the canonical on prod.** That's
  raised as Q2 below — if the user wants it, the spec stays in DRAFT until
  the audit lands; if not, the spec proceeds without it.

## Open questions for the user

These must be resolved before this spec moves to `READY_FOR_ARCH`. The first
three are highest-impact — they drive the remediation shape.

### Q1. Canonical reconciliation — which is the source of truth?

Owner-notes (line 99) lists `4fbd90` as canonical. Remote has `36016d31...`
as `is_current = true` at the same name. Pick one:

- **(a) Update notes to match remote.** Treat the prod re-version as
  intentional. Edit `docs/internal/prep-canonicalness-notes.md` line 99 to
  list `36016d31...` as the canonical prefix. No migration. The non-current
  `4fbd90...` row stays as historical record (Spec 001 / 003 precedent), and
  Q3 then asks what to do with its 6 orphan ingredient rows.
- **(b) Revert remote to match notes.** Treat the prod re-version as
  unintentional or unwanted. Migration demotes `36016d31...` to
  `is_current = false` and promotes `4fbd90...` back to `is_current = true`.
  Orphan handling depends on Q3.
- **(c) Accept divergence, document the reason.** Record a per-name
  exception in `docs/internal/prep-canonicalness-notes.md` explaining why
  remote and notes intentionally disagree for this prep. No migration. Q3
  still applies to the orphan ingredient rows.

### Q2. Investigate the prod re-version?

Does the user need to know who/what created `36016d31...` and demoted
`4fbd90...` on prod, before Spec 006 ships a remediation?

- **Yes** → Spec 006 stays in DRAFT until that audit produces a written
  finding. This spec does not perform the audit itself; the audit is a
  separate piece of work.
- **No** → Proceed with Q1's chosen reconciliation policy directly.

### Q3. Orphan `prep_recipe_ingredients` rows — disposition

The 1 non-current `prep_recipes` row on remote has 6 ingredient rows joined
to it. Pick one:

- **(a) Delete.** Same rule Spec 003 used for divergent rows. Cleans the
  data but loses historical record.
- **(b) Repoint.** After canonical reconciliation (Q1), repoint the 6 rows
  to whichever `prep_recipes` row is the canonical one. Trade-off: changes
  historical ingredient lists if the two versions diverge.
- **(c) Leave alone.** `pwa-catalog`'s `is_current = true` filter excludes
  these from end-user-visible output anyway. Safe but doesn't fully resolve
  the orphan situation.

### Q4. Spec 003 retry trigger

Does Spec 003 retry need Spec 006 to ship first?

Best read of the situation: **no** — Spec 003's gate_1 contract is the 4
names from Spec 005's manifest, none of which is `House Special Blend
(Sauce)`. The drift this spec addresses does not intersect Spec 003's
contract. But worth confirming before treating Spec 006 as parallel-safe.

### Q5. Migration scope (derives from Q1 + Q3)

Conditional, fills in once Q1 and Q3 are resolved:

- If Q1 = (a) and Q3 = (c) → no migration; owner-notes edit only.
- If Q1 = (a) and Q3 = (a) → migration deletes the non-current row and its
  6 ingredient rows.
- If Q1 = (a) and Q3 = (b) → migration repoints the 6 ingredient rows to
  the new canonical (`36016d31...`).
- If Q1 = (b) → migration toggles `is_current` on both rows; Q3 then
  determines what happens to whichever row ends up non-current.
- If Q1 = (c) → no canonical migration; Q3 still applies.

Architect will produce the exact SQL once Q1 / Q3 are answered.

## Project precedent (carry forward)

- **Atomic transaction** for any migration (Spec 001 / 003 / 005 precedent).
- **Pre-impl probe with documented results** before any apply.
- **No partial repair on unexpected counts** — if the probe finds a
  different row count than predicted, abort and re-spec.
- **Idempotent re-run path** — applying the migration twice yields the same
  end state.
- **Reference `docs/internal/prep-canonicalness-notes.md`** as authoritative
  for owner intent.
- **Reference Spec 005's `## Build notes` and `### Final apply`** as the
  audit trail for how this drift was discovered.

## Dependencies

- Spec 005 must have shipped to its post-apply state — Spec 006 reasons
  about the post-Spec-005 remote, not pre-Spec-005.
- `docs/internal/prep-canonicalness-notes.md` (read-only reference for owner
  intent; possibly edited as the only artifact, depending on Q1).
- Existing migration: `supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql`
  (the partial unique index `prep_recipes_brand_name_current_unique` —
  noted because Spec 006's migration, if any, must be compatible with this
  guard).

## Project-specific notes

- **Cmd UI section / legacy:** N/A — this is a backend data-cleanup spec,
  no UI surface.
- **Per-store or admin-global:** Brand-scoped. `prep_recipes` and
  `prep_recipe_ingredients` are brand-level.
- **Realtime channels touched:** `brand-{id}` channel for the 2AM PROJECT
  brand if a migration ships and clients are subscribed at apply time.
  **Realtime publication gotcha applies** — see CLAUDE.md / project memory
  re: `docker restart supabase_realtime_imr-inventory` after publication
  changes (only relevant if the migration changes any publication, which it
  likely does not — flag for architect).
- **Migrations needed:** Conditional on Q1 / Q3. If yes, exactly one new
  timestamped migration in `supabase/migrations/`.
- **Edge functions touched:** None expected. `pwa-catalog` reads
  `is_current = true` rows and is unaffected by the disposition of
  non-current rows or the canonical re-version, since end-user output keys
  on whichever row is current at read time.
- **Web/native scope:** N/A.
- **Tests:** No test framework wired up. If the architect wants a SQL-level
  verification probe (recommended), it goes in `scripts/` as a one-off
  ts-node or `psql` script alongside `scripts/test-unit-conversion.ts` —
  not in a missing test runner.
- **Production impact:** Direct prod data mutation if a migration ships.
  Architect must include a rollback plan and the user must confirm before
  apply (Spec 001 / 003 / 005 precedent).
