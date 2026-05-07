# Backend-architect post-impl drift review — Spec 003

**Reviewer:** backend-architect (design author)
**Mode:** post-implementation drift review
**Spec:** [`specs/003-prep-recipe-ingredients-orphans.md`](../../003-prep-recipe-ingredients-orphans.md)
**Migration under review:** [`supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql`](../../../supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql) (262 lines)
**Date:** 2026-05-07
**Apply state at review:** local + remote (project `ebwnovzzkwhsdxkpyjka`) both APPLIED, post-apply verification PASS on both.

## Summary

**Verdict: NO drift findings at any severity.** The implementation
matches the design contract on every axis the design specified, and the
two places it deviates from my §3 / §7 sketches are improvements I would
have specified myself had I been re-running the design pass against the
2026-05-07 probe state instead of the 2026-05-06 probe state. The
deviations cited in the dispatching prompt are either (a) trivially
correct timestamp arithmetic forced by Specs 005/006 landing between my
design and the build, or (b) clarifications of a design intent I had
already documented, not substantive drift.

The live prod apply log matches the local apply log verbatim (`332
matching-deduped, 67 divergent-discarded = 399`), which is the strongest
possible evidence that the design's apply-path-A vs apply-path-B
shape-invariance claim (§5) held under live conditions.

## Per-deviation evaluation

### Deviation 1: Filename `20260507040000_spec003_*` vs my §3 `20260506000000_*`

Not drift. My §3 said the filename "must sort after
`20260505000000_dedupe_repointed_ingredient_lines.sql`" and is "**not
load-bearing for ordering against any unapplied migration**". Specs 005
and 006 landed between my design and this build, both with timestamps
`20260506*` and `20260507030000`. A `20260506000000` filename would
either no-op (because Spec 005 runs after it and re-introduces the very
state Spec 003 just cleared) or sort-conflict with Spec 005's
`20260506000000_rename_prep_canonicals.sql`. Bumping to `20260507040000`
to sort after both is the only correct choice.

The dev also added the `spec003_` description prefix per Spec 004/006
convention. Consistent with project naming evolution; non-breaking.

**No finding.**

### Deviation 2: DELETE-only body (no UPDATE)

Not drift. My §5 finding (lines 515–524 of the spec) explicitly
documented this:

> Critical insight: under the resolved Q1, the migration's UPDATE
> branch would collide with the live unique index on EVERY matching
> row... The fix: matching orphans must be **DELETED, not UPDATEd**.
> The migration ships TWO DELETE statements... **No UPDATE statement
> is issued at all.**

The implementation matches this finding line for line (migration lines
229–241 — two `DELETE FROM` statements, no `UPDATE`). The dev also
preserved the semantic naming I called for: variable
`v_repointed_count` and NOTICE phrasing `matching-deduped /
divergent-discarded` honor my "the orphan's information is preserved
via canonical's pre-existing equivalent row" framing without lying
about the SQL operator.

**No finding.** This was explicit design, not a deviation.

### Deviation 3: Per-prep assertion ordering — pre-mutation vs my §7 post-mutation sketch

This is the only one that warranted real evaluation. My §7 sketch
placed assertions after the DELETEs (steps 6–7 in the sketch). The dev
placed them before (migration lines 182–224, prior to lines 229–241's
DELETEs).

**Both produce the same correctness guarantee** under the
assertion-aborts-rollback semantics. Either ordering means a manifest
mismatch leaves the DB byte-identical to its pre-migration state
because the `BEGIN/COMMIT` wraps everything and any `RAISE EXCEPTION`
rolls the entire DO block back.

**Pre-mutation is strictly better in every other dimension.** Three
reasons:

1. **Cheaper failure path.** A divergent manifest aborts before any
   row locks are taken on `prep_recipe_ingredients`. Post-mutation
   ordering would hold those locks until the assertion fires, then
   release them on rollback. At 399 rows + a low-traffic apply window
   the difference is microscopic, but it is real and it costs nothing
   to claim.

2. **Cleaner diagnostic semantics.** Pre-mutation, the
   `_spec003_orphan_decisions` table contains the *classification of
   what's currently in the DB*. Post-mutation it would contain *the
   classification of what was in the DB at INSERT time*, which is
   identical in this migration but more confusing to reason about if a
   future operator reads the failure NOTICE without the migration
   source open.

3. **Spec 005 precedent.** The dev cited this in the handoff. I did
   not check Spec 005 during design — had I, I would have followed the
   same convention, since Spec 005 / 006 are the immediate-prior peer
   migrations and convention consistency is itself an architectural
   value.

The grand-total assertion remains post-mutation in the implementation
(line 245), correctly — that one needs `ROW_COUNT` from the DELETEs to
compare against. Defense-in-depth.

The dispatching prompt asks whether my §7 ordering was "deliberate
(post-mutation lets you assert the count of deleted rows, not the
count of orphans found) or loose". **Honest answer: it was loose.** I
was tracing Spec 001's `_spec001_orphan_decisions` pattern from
memory, where the per-prep assertion is conceptually "did the
mutation do what we expected", and I encoded that intent as
post-mutation without re-checking whether per-prep classification
counts are functionally identical pre vs post. They are. The dev's
reordering is a strict improvement and should be the project pattern
going forward.

**No finding. This is a design improvement the dev surfaced; thank
them.**

### Deviation 4: No recovery snapshot

Not drift. My §12 Q7 resolution explicitly accepted the trade-off:

> `BEGIN/ROLLBACK` semantics + per-prep diagnostic NOTICEs are
> sufficient. No separate backout migration ships.

The §12 rationale named PITR + seed.sql as the joint inverse — not a
filesystem snapshot. Spec 006's filesystem snapshot precedent applies
to prod-only data (data not represented in local seed); Spec 003's
data is in the local seed (probe-confirmed in the 2026-05-07 re-run).
The dev's "default to no snapshot per developer brief" matches my
design directly.

**No finding.**

## Re-evaluation of design sections under the live-apply outcome

### §5 apply-path matrix consistency under the dev's assertion ordering

The matrix had four live paths (A, B-revised, C, D — B-original was
ruled out at design time). Live apply was Path A. With the dev's
pre-mutation assertion ordering, all four paths still behave per the
matrix:

- **Path A (`db push` to remote, 399 orphans).** Count branch hits
  `v_orphan_count = 399`, classifier runs, manifest matches, two
  DELETEs fire, COMMIT. **Confirmed live: prod NOTICE at line 1254 of
  spec exactly matches predicted output.**
- **Path B-revised (manual re-execute after `db reset --local`).**
  Same flow as Path A; pre-mutation assertion does not change
  behavior because the seeded orphan population is identical.
- **Path C (`db reset --local`, no manual re-execute).** Empty DB at
  apply time → `v_orphan_count = 0` → no-op branch fires before any
  classifier or assertion runs. Pre-mutation reordering does not
  affect this path because both orderings short-circuit at the count
  branch.
- **Path D (re-run after success).** Same as Path C semantically — 0
  orphans visible → no-op. Live-confirmed by the dev's idempotent
  re-run output (spec lines 1227–1235).

Matrix holds. No drift.

### §7 control-flow integrity under all expected count states

Three count states the design specified:

- `v_orphan_count = 0` → NOTICE no-op, COMMIT clean. **Confirmed by
  idempotent re-run.**
- `v_orphan_count = 399` (expected) → repair branch fires. **Confirmed
  by both local apply and prod apply.**
- `v_orphan_count` = anything else → final `RAISE EXCEPTION` at
  migration line 254–257 fires, rollback. **Not exercised in this
  apply (counts matched), but the branch is intact in the source.**

Pre-mutation assertion ordering does not change any of these branches
— the assertion is INSIDE the `v_orphan_count = 399` branch and
short-circuits via `RAISE EXCEPTION` if the per-prep classification
diverges from the manifest. All three RAISE branches still fire
correctly under the dev's reordering. **No drift.**

### §12 Q4–Q7 resolutions — all probe results landed

| Q | Anticipated resolution | Live outcome | Match |
|---|---|---|---|
| Q4 cross-brand | 1 brand only | gate_5 = 1 brand (prod + local) | yes |
| Q5 sub_recipe regression | 0 orphans | gate_7 = 0 (prod + local) | yes |
| Q6 local-vs-remote | identical (with caveat re: +6 drift to investigate) | 399/399 post-Spec-006 | yes (drift closed by Spec 006) |
| Q7 backout plan | rollback + PITR + seed.sql joint inverse, no sidecar | dev shipped no sidecar; PITR available on prod | yes |

All four resolutions held. **No drift.**

## Forward-looking notes

**Spec 003 unblocking effect.** Live state confirms 0 orphans in
`prep_recipe_ingredients` on prod (`verify_orphan_count = 0`). Combined
with Spec 001's 0 orphans in `recipe_prep_items` (DONE), the only
remaining known sibling-orphan tail in the brand-catalog refactor's
P2-backfill incident is the **52 non-current `prep_recipes` rows**
themselves, which are now zero-referenced by both child tables.

The user has explicitly out-of-scoped deleting those (spec 003 line
133). The architect's earlier soft suggestion (§11) that a future
spec could clean them up stands, but it is **a weaker suggestion now
than at design time** because:

- Pre-Spec-003: those 52 rows were still load-bearing for
  `prep_recipe_ingredients` integrity (their FK ancestors).
- Post-Spec-003: those 52 rows are pure dead weight in
  `prep_recipes`. They show up in admin UI version-history if the UI
  surfaces non-current preps, but they affect no payload, no
  ingredient list, no consumed prep_recipe_ingredients row.

A Spec 007-style "delete unreferenced non-current `prep_recipes`"
follow-up is now strictly safer than it was at Spec 003 design time.
**Filed as a soft recommendation, not a build blocker.** Not in the
scope of this drift review to spec it; surfacing as a forward-looking
note for the user / release-coordinator.

**Spec 003 is the second-to-last data-cleanup spec the team filed.**
With Specs 001/003/005/006 all DONE-or-near-DONE, and only the
zero-referenced `prep_recipes` cleanup left as a known data-shape
follow-up, the brand-catalog refactor's data debt is functionally
closed.

## Findings ranked

**Critical:** none.

**Should-fix:** none.

**Nits:** none.

The implementation matches the design contract on every axis. The four
"deviations" cited in the dispatching prompt are: (1) a forced
timestamp bump that the design itself permitted; (2) an explicit
design finding the dev correctly implemented; (3) a strict improvement
on a loose design choice; (4) a non-deviation aligned with the design's
explicit Q7 resolution.

If anything, this is the cleanest design-to-implementation match I've
seen across Specs 001 / 003 — a sign that the per-prep manifest
pattern + DELETE-only finding + apply-path matrix template are now
mature enough to be the project's standard data-repair migration
shape. Spec 005 and 006 (which the dev cited as precedent for the
pre-mutation assertion ordering) appear to have absorbed the same
lessons. Pattern is converged.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 findings across all
  severities. Implementation matches the design contract verbatim;
  the four cited deviations are non-substantive (timestamp arithmetic,
  explicit design finding implemented, strict improvement on a loose
  sketch, non-deviation aligned with Q7 resolution). Spec 003 is
  ready to ship from the architect's perspective. Forward-looking
  note: post-Spec-003, the 52 non-current `prep_recipes` rows are now
  zero-referenced by both child tables — a future "delete unreferenced
  non-current preps" spec is strictly safer than it was at Spec 003
  design time, but remains explicitly out of scope per user direction.
payload_paths:
  - specs/003-prep-recipe-ingredients-orphans/reviews/backend-architect.md
  - specs/003-prep-recipe-ingredients-orphans.md
  - supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql
