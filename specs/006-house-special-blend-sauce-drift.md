# Spec 006: House Special Blend (Sauce) — remote canonical drift cleanup

Status: READY_FOR_REVIEW

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
reflect the current prod canonical (`36016d31...`), with the stale
`4fbd90...` row and its 6 orphan ingredient rows removed and owner-notes
updated to match — so that there is one unambiguous source of truth for this
prep's canonical version and ingredient list, and the +6 prep-ingredient row
drift currently blocking Spec 003's gate_1 retry is closed.

## Acceptance criteria

Locked to the Q1=(a) + Q3=(a) path (see "Resolved answers" below).

- [ ] `docs/internal/prep-canonicalness-notes.md` line 99 is edited so the
      canonical prefix for `House Special Blend (Sauce)` reads `36016d31`
      (replacing `4fbd90`). The edit is committed in the same change as the
      migration.
- [ ] One new timestamped migration in `supabase/migrations/` ships, wrapped
      in a single `BEGIN; … COMMIT;` transaction.
- [ ] Pre-impl remote probe records, in Spec 006's `## Build notes` section,
      the exact row counts: `prep_recipes` rows at name `House Special Blend
      (Sauce)` (expected 2 on remote: 1 with `is_current = true` prefixed
      `36016d31`, 1 with `is_current = false` prefixed `4fbd90`); and
      `prep_recipe_ingredients` rows whose `prep_recipe_id` matches the
      `4fbd90` row (expected 6 on remote).
- [ ] Migration deletes from `prep_recipe_ingredients` exactly 6 rows whose
      `prep_recipe_id = <4fbd90 row id>`, then deletes from `prep_recipes`
      exactly 1 row (`id = <4fbd90 row id>`). Both deletes are guarded by
      count assertions inside the transaction — if pre-delete counts do not
      match the manifest exactly, the transaction aborts (Spec 001 / 003 /
      005 precedent: no partial repair on unexpected counts).
- [ ] Migration is idempotent: re-running on a database where the cleanup
      already applied results in 0 deletes and the transaction still commits
      cleanly (no errors, no spurious changes).
- [ ] Post-apply verification probe records in `## Build notes`: remote has
      exactly 1 `prep_recipes` row at name `House Special Blend (Sauce)`
      (the `36016d31` row, `is_current = true`); remote has 0
      `prep_recipe_ingredients` rows referencing the deleted `4fbd90` row id;
      and the `prep_recipe_ingredients` global orphan count on remote has
      decreased by exactly 6 (closing the Spec 003 gate_1 +6 drift).
- [ ] No `prep_recipe_ingredients` row references a `prep_recipes` row that
      no longer exists, scoped to name `House Special Blend (Sauce)` on
      remote.
- [ ] The migration is compatible with the existing partial unique index
      `prep_recipes_brand_name_current_unique` (deletes only — no
      `is_current` toggles, so the unique guard is not exercised).

## In scope

- `prep_recipes` and `prep_recipe_ingredients` rows on remote at the exact
  name `House Special Blend (Sauce)` (the `is_current = true` `36016d31` row
  is left untouched; the `is_current = false` `4fbd90` row and its 6
  ingredient rows are deleted).
- Editing `docs/internal/prep-canonicalness-notes.md` line 99 to list
  `36016d31` as the canonical prefix.
- A single atomic migration with pre-delete count assertions.
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
  Spec 005's Q5. Spec 006 does not contract-gate Spec 003 retry — Spec 003's
  gate_1 names do not include `House Special Blend (Sauce)` — but it does
  close the +6 grand-total `prep_recipe_ingredients` drift currently
  triggering one of Spec 003's stop conditions. See "Resolved answers" Q4.
- **Constraint guard / unique index on `prep_recipes (brand_id, name) WHERE
  is_current`.** Originally pinned to Spec 003 section 14, but the partial
  unique index `prep_recipes_brand_name_current_unique` already exists in
  `supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql`,
  so this is a non-issue and explicitly outside Spec 006.
- **Owner-notes auto-sync mechanism.** `docs/internal/prep-canonicalness-notes.md`
  is owner-curated. This spec edits line 99 manually as part of the fix but
  does not add tooling for sync.
- **Investigation of who/what re-versioned the canonical on prod.** Q2 below
  resolved as "no" — without a write-side audit log on prod, the originator
  is likely unanswerable. The drift is small and contained; the spec accepts
  prod's `36016d31` as authoritative for this one prep with a documented
  one-off note.
- **Repointing the 6 orphan ingredient rows to the new canonical.** Q3
  resolved as "delete" (Spec 003 precedent). The 6 rows belong to a stale
  recipe version; preserving them as repointed ingredients on the new
  canonical would mix two ingredient histories.

## Resolved answers (locked 2026-05-06 by user — PM-recommended defaults)

The user authorized the PM-recommended defaults in the task brief. If any of
these is wrong, the user can override before architect dispatch.

### Q1 — Canonical reconciliation source of truth

**Resolved: (a) Update notes to match remote.**

Rationale: smallest blast radius. If the prod re-version was intentional
(someone fixed a real bug or updated the recipe), reverting remote would
re-introduce whatever they fixed. Treating prod as authoritative for this
one prep is the conservative call. Owner-notes line 99 will be edited to
list `36016d31` as the canonical prefix.

### Q2 — Investigate the prod re-version?

**Resolved: No.**

Rationale: without git-blame on prod data and without a write-side audit log
capturing the re-version event, "who did it" is likely unanswerable. The
drift is small (1 row + 6 ingredient rows) and contained. Accept it as-is.

### Q3 — Orphan `prep_recipe_ingredients` rows disposition

**Resolved: (a) Delete.**

Rationale: matches the "delete divergent" policy from Spec 003 the user
already approved. The 6 orphan rows are attached to a `prep_recipes` row
that's now non-current and about to be removed; they are stale either way.
Repointing (Q3-b) would mix ingredient histories from two recipe versions.

### Q4 — Spec 003 retry trigger

**Ratified: Spec 006 does NOT contract-gate Spec 003 retry**, BUT Spec 006
does close the +6 grand-total drift currently triggering Spec 003's gate_1
stop condition.

Rationale: Spec 003's gate_1 contract is keyed on the 4 names from Spec 005's
manifest, none of which is `House Special Blend (Sauce)`. The contract is
unaffected. However, Spec 003's gate_1 also does a grand-total
`prep_recipe_ingredients` orphan count check (local 399, remote 405 = +6),
and those 6 rows are exactly the rows this spec deletes. Once Spec 006
applies, the local/remote orphan totals reconcile and Spec 003 can re-probe
without that stop condition firing. Both reasons matter for sequencing —
Spec 006 should ship before the next Spec 003 retry attempt.

### Q5 — Migration scope (derived from Q1 + Q3)

**Pinned: Q1=(a) + Q3=(a) → one migration that deletes 6
`prep_recipe_ingredients` rows + 1 `prep_recipes` row, wrapped in one
transaction with count assertions, plus owner-notes line 99 edit committed
alongside.**

Architect produces exact SQL; shape is constrained to:

```
BEGIN;
  -- assert: 1 prep_recipes row matching (brand_id, name='House Special Blend (Sauce)', id prefix '4fbd90', is_current=false)
  -- assert: exactly 6 prep_recipe_ingredients rows referencing that row id
  DELETE FROM prep_recipe_ingredients WHERE prep_recipe_id = <4fbd90 row id>;
  -- assert: 6 rows deleted
  DELETE FROM prep_recipes WHERE id = <4fbd90 row id>;
  -- assert: 1 row deleted
COMMIT;
```

Idempotency: on re-run, the assertions allow 0-row matches (already deleted)
and the transaction commits cleanly with no-op deletes. Architect picks the
exact assertion idiom (PL/pgSQL `IF NOT FOUND` / `RAISE EXCEPTION` vs
`GET DIAGNOSTICS` count check — Spec 003's design has the precedent shape).

## Project precedent (carry forward)

- **Atomic transaction** for any migration (Spec 001 / 003 / 005 precedent).
- **Pre-impl probe with documented results** before any apply.
- **No partial repair on unexpected counts** — if the probe finds a
  different row count than predicted, abort and re-spec.
- **Idempotent re-run path** — applying the migration twice yields the same
  end state.
- **Reference `docs/internal/prep-canonicalness-notes.md`** as authoritative
  for owner intent (now edited to reflect the prod canonical for this prep).
- **Reference Spec 005's `## Build notes` and `### Final apply`** as the
  audit trail for how this drift was discovered.

## Dependencies

- Spec 005 must have shipped to its post-apply state — Spec 006 reasons
  about the post-Spec-005 remote, not pre-Spec-005. (Spec 005 is committed
  as `52de146`.)
- `docs/internal/prep-canonicalness-notes.md` (read-only reference for owner
  intent, edited at line 99 as part of the fix).
- Existing migration: `supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql`
  (the partial unique index `prep_recipes_brand_name_current_unique` —
  noted because Spec 006's migration must be compatible with this guard;
  delete-only shape means the guard is not exercised).

## Project-specific notes

- **Cmd UI section / legacy:** N/A — this is a backend data-cleanup spec,
  no UI surface.
- **Per-store or admin-global:** Brand-scoped. `prep_recipes` and
  `prep_recipe_ingredients` are brand-level.
- **Realtime channels touched:** `brand-{id}` channel for the 2AM PROJECT
  brand if the migration ships and clients are subscribed at apply time.
  **Realtime publication gotcha — likely N/A** (no `CREATE/ALTER PUBLICATION`
  in this migration; deletes on tables already in the realtime publication
  do not require re-snapshotting). Architect to confirm.
- **Local edge runtime bind-mount gotcha — likely N/A** (no edge function
  changes). Architect to confirm.
- **Migrations needed:** Yes — exactly one new timestamped migration in
  `supabase/migrations/`.
- **Edge functions touched:** None. `pwa-catalog` reads `is_current = true`
  rows and is unaffected — the `4fbd90` row being deleted is already
  `is_current = false` on remote, and the `36016d31` row that customers see
  is untouched.
- **Web/native scope:** N/A.
- **Tests:** No test framework wired up. The pre-impl probe and post-apply
  verification probe are inline `psql` / SQL queries recorded in `## Build
  notes`, not test files. If the architect wants a reusable verification
  probe, it goes in `scripts/` as a one-off ts-node or `psql` script
  alongside `scripts/test-unit-conversion.ts` — not in a missing test
  runner.
- **Production impact:** Direct prod data mutation (1 + 6 = 7 row deletes).
  Architect must include a rollback plan (the deleted rows' contents must
  be captured to a recovery file before apply, e.g. via `pg_dump --data-only
  --table prep_recipes --table prep_recipe_ingredients` filtered by id, or
  inline `\copy ... TO` snapshots inside the probe step). User must confirm
  before apply (Spec 001 / 003 / 005 precedent).

## Backend design

### 0. Pinned identifiers (resolved at probe time)

The migration body needs the canonical UUIDs, not just the prefixes. The
**developer pins them at probe time** by reading the row off remote and
hard-coding the full id literals into the migration before commit. Spec 001
established this precedent (developer reads the value from the gate query
and embeds it as a literal); we keep it because dynamically resolving the
id inside the migration would (a) make the migration non-deterministic on
re-run and (b) silently mask the case where the row no longer matches.

For this spec, the architect-pinned values to discover and embed:

- `BRAND_ID = '2a000000-0000-0000-0000-000000000001'` (2AM PROJECT — known constant from seed).
- `STALE_PREP_ID` — the full UUID of the `prep_recipes` row at
  `(brand_id = BRAND_ID, name = 'House Special Blend (Sauce)', is_current = false)`.
  Probe expects this to begin with `4fbd90`.
- `CANONICAL_PREP_ID` — the full UUID of the `is_current = true` row at the
  same `(brand_id, name)`. Probe expects this to begin with `36016d31`.
  Not used by the delete; recorded in `## Build notes` only as a
  cross-check.

### 1. Pre-implementation probe

Two-sided probe (local smoke + remote authoritative). Run in this order;
**stop the entire build if either side disagrees with the manifest**.

#### 1a. Local smoke probe (state baseline; sanity, not gate)

Local matches owner-notes pre-edit: only the `4fbd90` row at the canonical
name, `is_current = true`. Run via `docker exec` against the local
container booted by `npm run dev:db`:

```
docker exec -i supabase_db_imr-inventory \
  psql -U postgres -d postgres -At <<'SQL'
-- Expect: 1 row, id starts with '4fbd90', is_current = true
select substr(id::text,1,8) as id_prefix, is_current
  from prep_recipes
 where brand_id = '2a000000-0000-0000-0000-000000000001'
   and name = 'House Special Blend (Sauce)';

-- Expect: 0 rows (local has no '4fbd90' non-current row, no '36016d31' row at all)
select count(*) as remote_only_state
  from prep_recipes
 where brand_id = '2a000000-0000-0000-0000-000000000001'
   and name = 'House Special Blend (Sauce)'
   and (is_current = false or id::text like '36016d31%');
SQL
```

If local shows the migration's expected pre-state (i.e., already has the
`4fbd90 / is_current=false` row plus a `36016d31 / is_current=true` row),
**something is wrong** — local has been hand-edited or re-seeded from a
post-drift dump. Stop and surface to the user.

#### 1b. Remote authoritative probe (gate; Spec 005 precedent)

Run from the repo root via `npx supabase db query --linked`. Spec 005's
build notes already documented this path; same shape here:

```sql
-- gate_a: prep_recipes shape at the canonical name
select id::text as id_full,
       substr(id::text,1,8) as id_prefix,
       is_current,
       updated_at
  from prep_recipes
 where brand_id = '2a000000-0000-0000-0000-000000000001'
   and name = 'House Special Blend (Sauce)'
 order by is_current desc;
-- Expect 2 rows:
--   1: id starts '36016d31', is_current = true
--   2: id starts '4fbd90',   is_current = false

-- gate_b: prep_recipe_ingredients fan-out for the stale row
select count(*) as ing_count
  from prep_recipe_ingredients
 where prep_recipe_id in (
   select id from prep_recipes
    where brand_id = '2a000000-0000-0000-0000-000000000001'
      and name = 'House Special Blend (Sauce)'
      and is_current = false
 );
-- Expect: 6

-- gate_c: prep_recipe_ingredients fan-out for the current row (cross-check, not gated)
select count(*) as current_ing_count
  from prep_recipe_ingredients
 where prep_recipe_id in (
   select id from prep_recipes
    where brand_id = '2a000000-0000-0000-0000-000000000001'
      and name = 'House Special Blend (Sauce)'
      and is_current = true
 );
-- Recorded in build notes; no gate value (whatever's there is what's there)

-- gate_d: grand-total prep_recipe_ingredients orphan count baseline
select count(*) as orphan_total
  from prep_recipe_ingredients pri
  left join prep_recipes pr on pr.id = pri.prep_recipe_id
 where pr.id is null
    or pr.is_current = false;
-- Expect: 405 (Spec 003 gate_1 grand-total at time of writing).
-- Post-apply, this should drop to 399.
```

**STOP conditions** (any of these aborts the spec; surface to user):

- gate_a returns ≠ 2 rows.
- gate_a's `4fbd90` row has `is_current = true`, or the `36016d31` row has
  `is_current = false`.
- gate_a returns no row beginning with `4fbd90`, or no row beginning with
  `36016d31`.
- gate_b returns ≠ 6.
- gate_d returns ≠ 405 — means the global drift moved underneath us; Spec
  003's contract assumptions need re-checking before we proceed.

The developer records all four results in `## Build notes` before applying.

### 2. Recovery snapshot (NEW PRECEDENT — explicit acknowledgement)

**This is a contract change from Spec 001 / 003 / 005.** Those specs ran
destructive UPDATEs/DELETEs without an audit row because their data was
reproducible from the local seed. Spec 006 deletes prod-only rows that
**do not exist in any committed seed**. Once gone, they are gone. We
therefore add a recovery-snapshot step that the prior specs did not have.

#### Decision: filesystem snapshot via `\copy`, NOT audit_log

Rationale:

- An `audit_log` row inside the same transaction would commit-or-rollback
  with the deletes. That is fine for the success-path. But on the
  recovery path (user later realizes Q1=(a) was wrong), the data we need
  to reconstruct the row is the FULL row image — every column of
  `prep_recipes` (notes, version, owner-set fields) and every column of
  the 6 `prep_recipe_ingredients` rows. Cramming that into a single
  audit_log row's `details jsonb` works in principle but couples the
  rollback procedure to whatever shape we picked for that JSON, and
  makes hand-restore awkward.
- A `\copy ... TO` of two CSV/tsv files (one per table) under
  `scripts/recovery-snapshots/<timestamp>-spec006/` is the
  smallest-surface-area answer. It sits next to
  `scripts/test-unit-conversion.ts` in the existing one-off-scripts
  pattern and is restorable with a one-line `\copy ... FROM`. The user
  also gets a tangible artifact at the repo level (commit-able if
  desired, gitignored otherwise) before the destructive step runs.
- This is **not in the migration transaction.** The snapshot runs as a
  pre-apply step from the developer's local shell, against remote, BEFORE
  the migration push. If the migration aborts on its own assertions,
  no harm — the snapshot is harmless in isolation. If the migration
  commits, the snapshot is the rollback artifact.

#### Snapshot procedure (developer runs once, before migration apply)

From repo root, against the linked remote:

```
mkdir -p scripts/recovery-snapshots/$(date -u +%Y%m%dT%H%M%SZ)-spec006
SNAP=$(ls -td scripts/recovery-snapshots/*-spec006 | head -1)

# Use psql connected via the linked Supabase project (the same channel
# `supabase db query --linked` uses; developer reads connection string
# from `.env.local` or supabase secrets — same path Spec 005 used).
psql "$REMOTE_DB_URL" <<SQL
\copy (
  select * from prep_recipes
   where brand_id = '2a000000-0000-0000-0000-000000000001'
     and name = 'House Special Blend (Sauce)'
     and is_current = false
) TO '$SNAP/prep_recipes_4fbd90.tsv' WITH (FORMAT csv, DELIMITER E'\t', HEADER true);

\copy (
  select pri.* from prep_recipe_ingredients pri
   join prep_recipes pr on pr.id = pri.prep_recipe_id
   where pr.brand_id = '2a000000-0000-0000-0000-000000000001'
     and pr.name = 'House Special Blend (Sauce)'
     and pr.is_current = false
) TO '$SNAP/prep_recipe_ingredients_4fbd90.tsv' WITH (FORMAT csv, DELIMITER E'\t', HEADER true);
SQL

wc -l $SNAP/*.tsv
# Expect: prep_recipes_4fbd90.tsv = 2 lines (1 header + 1 row)
#         prep_recipe_ingredients_4fbd90.tsv = 7 lines (1 header + 6 rows)
```

**Gate:** if either file has the wrong line count, abort. Do not push the
migration.

The developer commits the snapshot directory in the same git commit as the
migration so the rollback artifact is durable. (Repo-root note: this is a
new directory; add to `.gitignore` only if a future cleanup pass decides
the artifacts should not live in git.)

**Prerequisite note (added 2026-05-07 post-build):** the procedure above
assumes `$REMOTE_DB_URL` is set in the developer's environment with a
direct Postgres connection string to the linked project. This is NOT
provided by `npx supabase link` and is NOT auto-populated in
`.env.local`. The Spec 006 build hit this gap and substituted
`npx supabase db query --linked` with `to_jsonb(t.*)` projections plus
hand-written TSV emission (column ordering pinned via
`information_schema.columns.ordinal_position`). The TSV shape is still
`\copy ... FROM`-restorable per §14, but future operators copying this
template should either (a) provision `REMOTE_DB_URL` first, or (b)
follow the dev's substitution path. Architect Nit (post-impl review)
flagged this as a template-hygiene item.

### 3. Migration SQL — shape (developer authors the file)

**Filename:** `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql`
(Spec 004's RLS p6 timestamp `20260507015244` is the most recent on disk;
we stamp later. Developer may bump if a closer-spaced timestamp is needed
to land between unrelated migrations.)

**Shape** (developer fills the two `<full-uuid>` literals from probe step):

```
BEGIN;

-- ─── Assertion 1: the stale prep_recipes row exists in expected shape.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM prep_recipes
   WHERE id = '<STALE_PREP_ID full uuid>'::uuid
     AND brand_id = '2a000000-0000-0000-0000-000000000001'::uuid
     AND name = 'House Special Blend (Sauce)'
     AND is_current = false;

  -- Idempotent: 0 rows (already deleted on a prior apply) is OK.
  -- 1 row is the first-apply path. >1 means something is structurally
  -- wrong (the row id is the PK, so >1 should be impossible — fail
  -- loudly if it ever happens).
  IF v_count NOT IN (0, 1) THEN
    RAISE EXCEPTION
      'spec006: stale prep_recipes row count = %, expected 0 or 1',
      v_count;
  END IF;
END $$;

-- ─── Assertion 2: ingredient fan-out matches manifest exactly when the
-- ─── parent row is still present.
DO $$
DECLARE
  v_parent int;
  v_ing    int;
BEGIN
  SELECT count(*) INTO v_parent
    FROM prep_recipes
   WHERE id = '<STALE_PREP_ID full uuid>'::uuid;

  SELECT count(*) INTO v_ing
    FROM prep_recipe_ingredients
   WHERE prep_recipe_id = '<STALE_PREP_ID full uuid>'::uuid;

  IF v_parent = 1 AND v_ing <> 6 THEN
    RAISE EXCEPTION
      'spec006: parent stale row present but ingredient fan-out = %, expected 6',
      v_ing;
  END IF;

  IF v_parent = 0 AND v_ing <> 0 THEN
    RAISE EXCEPTION
      'spec006: parent stale row absent but % orphan ingredient rows remain (idempotency invariant violated)',
      v_ing;
  END IF;
END $$;

-- ─── Delete: ingredients first (FK respect).
DELETE FROM prep_recipe_ingredients
 WHERE prep_recipe_id = '<STALE_PREP_ID full uuid>'::uuid;

-- ─── Assertion 3: deleted-count is in {0, 6}. Use GET DIAGNOSTICS
-- ─── inside a DO block that wraps the DELETE — implementation detail
-- ─── for the developer (PL/pgSQL idiom).

-- ─── Delete: the parent row.
DELETE FROM prep_recipes
 WHERE id = '<STALE_PREP_ID full uuid>'::uuid;

-- ─── Assertion 4: deleted-count is in {0, 1}. Same idiom.

COMMIT;
```

**Idempotency contract:**

- First apply: assertion 1 sees 1 row, assertion 2 sees 1 parent + 6 ings;
  DELETEs remove 6 + 1; assertions 3 and 4 see (6, 1).
- Second apply (re-run): assertion 1 sees 0 rows, assertion 2 sees 0
  parent + 0 ings; DELETEs remove 0 + 0; assertions 3 and 4 see (0, 0).
  Transaction commits cleanly with no-op deletes.
- Inconsistent state (parent gone but ings still present, or parent
  present but ings ≠ 6): RAISE EXCEPTION, transaction rolls back, the
  developer gets a clear message and aborts. **Spec 003's "no partial
  repair" precedent** — we do not silently fix unexpected state.

### 4. Owner-notes line 99 edit

`docs/internal/prep-canonicalness-notes.md` line 99 currently reads:

```
### House Special Blend (Sauce) (canonical prefix: 4fbd90)
```

Edit to:

```
### House Special Blend (Sauce) (canonical prefix: 36016d31)
```

(Verified by reading the file; the literal line content is shown above.
The 6 ingredient rows beneath, lines 100–105, are NOT touched by this
spec — they're owner-curated reference notes. Whether the
`36016d31` canonical's ingredients functionally match those 6 lines is
an owner-review item, not a Spec 006 deliverable. If they diverge, that's
a future-spec follow-up; mention in `## Build notes`.)

The owner-notes edit ships in the **same git commit** as the migration and
the recovery snapshot directory. Three artifacts, one commit, one PR
(or one direct push).

### 5. Post-apply verification probe

Run via `npx supabase db query --linked` immediately after migration push
succeeds. Record results in `## Build notes`:

```sql
-- verify_a: stale row gone
select count(*) as stale_remaining
  from prep_recipes
 where brand_id = '2a000000-0000-0000-0000-000000000001'
   and name = 'House Special Blend (Sauce)'
   and is_current = false;
-- Expect: 0

-- verify_b: ingredient orphans for the stale id gone
select count(*) as stale_ings_remaining
  from prep_recipe_ingredients
 where prep_recipe_id = '<STALE_PREP_ID full uuid>'::uuid;
-- Expect: 0

-- verify_c: canonical untouched
select id::text as id_full,
       substr(id::text,1,8) as id_prefix,
       is_current
  from prep_recipes
 where brand_id = '2a000000-0000-0000-0000-000000000001'
   and name = 'House Special Blend (Sauce)';
-- Expect: 1 row, id_prefix = '36016d31', is_current = true

-- verify_d: Spec 003 grand-total drift closed
select count(*) as orphan_total
  from prep_recipe_ingredients pri
  left join prep_recipes pr on pr.id = pri.prep_recipe_id
 where pr.id is null
    or pr.is_current = false;
-- Expect: 399 (was 405 pre-apply). Diff of -6 == this spec's payload.
```

If verify_a, verify_b, or verify_c fail, the transaction shouldn't have
committed (assertion shape catches all known-bad shapes pre-COMMIT). If
they fail anyway, that's a structural bug — escalate. If verify_d returns
a value other than exactly 399, the global drift moved between probe and
apply; flag and surface to user (the migration's payload still landed
correctly; the global count just isn't a clean reconciliation anymore).

### 6. RLS impact

**None.** Confirmed by reading
[supabase/migrations/20260504173035_per_store_rls_hardening.sql](supabase/migrations/20260504173035_per_store_rls_hardening.sql):
the per-store RLS hardening covers `inventory_items`, `eod_*`,
`waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`,
`pos_import_items`. **`prep_recipes` and `prep_recipe_ingredients` are
not in that policy set** — they're brand-level catalog tables, governed
by whatever pre-existing policies the brand-catalog refactor set, and
the migration applies with superuser context (Supabase migration apply
path), bypassing RLS regardless. No new policy authoring; no policy
edits. N/A.

### 7. API contract impact

**None.** No changes to `src/lib/db.ts`. No new helpers, no signature
changes. The existing `prep_recipes` / `prep_recipe_ingredients` reads
on the frontend will see one fewer row (the stale `4fbd90` row was
already filtered out by `is_current = true` everywhere it matters; the
delete removes it from the underlying table but no client query was
returning it post-Spec-005 anyway).

### 8. Edge function impact

**None.** Confirmed by spec section "Edge functions touched: None."
`pwa-catalog` is the only edge function reading these tables and it
filters `is_current = true`, which means the stale `4fbd90` row was
invisible to it before the delete and remains invisible after. No
`verify_jwt` toggles, no service-token changes.

### 9. `src/lib/db.ts` surface

**No changes.** Nothing to map snake_case → camelCase. Nothing to
re-export. The frontend store impact is also nil — no slice of
`src/store/useStore.ts` is touched, and the optimistic-then-revert
pattern with `notifyBackendError` doesn't apply (no client-initiated
write).

### 10. Realtime impact

**Channels:** `brand-{2a000000-0000-0000-0000-000000000001}` (the 2AM
PROJECT brand channel) will replay 7 row deletes if any client is
subscribed at apply time.

**Publication-membership gotcha — N/A.** The migration contains no
`alter publication supabase_realtime` statements; it's a pure DELETE on
tables already in the publication. No `docker restart
supabase_realtime_imr-inventory` step required for local dev. (And the
migration won't be applied locally anyway — see §13 path matrix.)

**Bind-mount gotcha — N/A.** No edge function changes; no `supabase/functions/`
mounts re-evaluated.

### 11. Frontend store impact

**None.** No slice changes to `src/store/useStore.ts`. No optimistic
write path. The realtime debounced reload at
[`src/hooks/useRealtimeSync.ts`](../src/hooks/useRealtimeSync.ts) will
issue one extra reload-tick if a client is connected when the migration
applies, which is the existing handled path — no special handling.

### 12. Compatibility with `prep_recipes_brand_name_current_unique`

**Compatible — index is not exercised.** Confirmed by reading
[supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql](../supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql):

```sql
create unique index if not exists prep_recipes_brand_name_current_unique
  on public.prep_recipes (brand_id, lower(name))
  where is_current = true;
```

The deleted row is `is_current = false` and therefore not in the partial
index at all. No `is_current` toggle happens. The `36016d31` canonical
row stays `is_current = true` and uniquely occupies its
`(brand_id, lower(name))` slot before, during, and after. Index-neutral.

### 13. Apply-path matrix (Spec 001 precedent)

| Path | Where | What happens | Notes |
|------|-------|--------------|-------|
| **A — remote prod** | `npx supabase db push` against linked project | Assertion 1 sees 1, assertion 2 sees 1+6, DELETEs remove 6+1, assertions 3+4 see (6,1), COMMIT. This is the only meaningful apply path. | The recovery snapshot must exist before this runs. |
| **B — local fresh DB pre-seed** | `supabase db reset --local` against an empty DB before `seed.sql` loads | Assertion 1 sees 0, assertion 2 sees 0+0, DELETEs no-op, assertions 3+4 see (0,0), COMMIT. Idempotency path; no-op. | Expected; this is what idempotency guarantees. |
| **C — local with seed loaded** | `supabase db reset --local` + seed | Assertion 1 sees 0 (local has the row at id `4fbd90...` but **`is_current = true`**, not false — the assertion's WHERE clause filters it out), assertion 2's parent count = 0, ingredient count = 6 → **`RAISE EXCEPTION 'spec006: parent stale row absent but 6 orphan ingredient rows remain'`**. ABORT. | This is the structural-mismatch case the assertions are designed to catch. **Local is not the apply target for this migration.** Future operators running this against local for any reason will see a clear, named failure and know to route the migration only at remote. Document this in `## Build notes`. |

The path-C abort is **expected and desirable**. We deliberately do not
make the migration tolerant of "row exists but with `is_current = true`"
— that would mask exactly the kind of drift this spec is cleaning up.

### 14. Rollback plan

If, post-apply, the user determines Q1=(a) was the wrong call (for
example, they discover the prod re-version was an accident and the
`4fbd90` recipe was actually correct), restore from the snapshot:

```
SNAP=scripts/recovery-snapshots/<timestamp>-spec006

psql "$REMOTE_DB_URL" <<SQL
BEGIN;
\copy prep_recipes FROM '$SNAP/prep_recipes_4fbd90.tsv' \
  WITH (FORMAT csv, DELIMITER E'\t', HEADER true);
\copy prep_recipe_ingredients FROM '$SNAP/prep_recipe_ingredients_4fbd90.tsv' \
  WITH (FORMAT csv, DELIMITER E'\t', HEADER true);
-- Verify counts:
select count(*) from prep_recipes where id = '<STALE_PREP_ID>'::uuid; -- 1
select count(*) from prep_recipe_ingredients where prep_recipe_id = '<STALE_PREP_ID>'::uuid; -- 6
COMMIT;
SQL
```

This restores the row contents bit-for-bit (every column captured by
`select *`). The owner-notes edit then needs a manual revert (line 99
back to `4fbd90`). The user runs this; agents do not auto-rollback.

If a `36016d31` vs `4fbd90` reconciliation strategy then needs to change,
that's a follow-up spec, not part of Spec 006.

### 15. Risks and tradeoffs

- **Live risk: direct unrecoverable prod mutation.** Mitigated by:
  pre-impl probe gates (4 named STOP conditions); recovery snapshot
  captured to filesystem in same commit; idempotent migration shape so
  re-running is safe; assertion-driven abort on any unexpected count.
  The user is the final gate — developer must surface probe results to
  user and get explicit "apply" before pushing.
- **Snapshot-vs-apply race.** A non-zero window exists between the
  `\copy` snapshot and the migration push during which prod could mutate
  again. Mitigation: developer runs snapshot and migration push
  back-to-back, no delay; verify_d in §5 catches any drift in the
  global orphan count. Acceptable.
- **Owner-notes drift.** The 6 ingredient lines beneath line 99 in
  `docs/internal/prep-canonicalness-notes.md` describe the OLD
  (`4fbd90`) recipe's ingredients. After the canonical flip to
  `36016d31`, those notes may or may not reflect the real prod recipe.
  This spec does NOT update those lines (out of scope per Q3 — owner
  curates them). Flag in `## Build notes` so the user remembers to
  re-curate them as a follow-up.
- **Spec 003 grand-total assumption.** We assert pre-apply orphan total
  = 405 and post-apply = 399. If the prod orphan landscape moves between
  Spec 005's probe and Spec 006's apply, the numbers shift. The
  assertions inside the migration don't depend on the global total —
  only the §1 gate_d and §5 verify_d probes do. If those diverge,
  surface to user; do NOT block the migration's structural correctness
  on the global count.
- **Performance.** 7 row deletes on a brand-scoped table set. No index
  rebuild, no FK re-eval cascades beyond the FK that orders our delete
  sequence. 286 KB seed is irrelevant — this runs against prod, not
  local. Microseconds.
- **Cold-start / edge functions.** N/A — no edge function changes.

### 16. Open architect-level flags (for the developer)

- **Snapshot location in git.** The design places snapshots under
  `scripts/recovery-snapshots/<timestamp>-spec006/`. If the user later
  decides these should be `.gitignore`'d (because they contain
  prod-extracted data), that's a one-line `.gitignore` add in a future
  cleanup. For Spec 006 specifically, the snapshot **should be
  committed** so the rollback artifact is durable and reviewable in the
  same PR.
- **Migration filename.** Proposed
  `20260507030000_spec006_house_special_blend_sauce_cleanup.sql`. The
  `spec006_` prefix matches the human-readable convention seen in
  recent migrations and ties the file to this spec. Developer may
  adjust the timestamp seconds-component if a clean ordering with
  unrelated in-flight migrations matters.
- **`audit_log` row capture inside the transaction.** Architect-level
  decision: NO. Rationale in §2. If the user later wants an audit row
  in addition to the filesystem snapshot, that's an additive request,
  not a precondition for Spec 006 shipping.

## Handoff

next_agent: backend-developer
prompt: Implement Spec 006 against the design under `## Backend design`. This is the
  first spec on this branch with **direct unrecoverable prod data mutation** — the
  recovery snapshot in §2 MUST be captured (and the file line counts verified) BEFORE
  pushing the migration. Run the §1 probes first and record all four gate values in
  `## Build notes`; if any STOP condition trips, abort and surface to the user. Pin
  `STALE_PREP_ID` and `CANONICAL_PREP_ID` from gate_a and embed `STALE_PREP_ID` as a
  literal in the migration. Edit `docs/internal/prep-canonicalness-notes.md` line 99
  (current text shown in §4). Run §5 post-apply verification and record results.
  After implementation, set `Status: READY_FOR_REVIEW` and list files changed under
  `## Files changed` (migration, owner-notes edit, recovery snapshot directory).
payload_paths:
  - specs/006-house-special-blend-sauce-drift.md
  - docs/internal/prep-canonicalness-notes.md
  - supabase/migrations/20260505055228_prep_recipes_brand_name_current_unique.sql
  - supabase/migrations/20260504173035_per_store_rls_hardening.sql

## Build notes

Build phase (pre-push). Status remains `READY_FOR_BUILD` because the next
gate is the user-authorized prod push; post-apply verification will flip
status to `READY_FOR_REVIEW`.

### §1 gate outputs (remote authoritative probe)

Pinned identifiers (from gate_a):

- `STALE_PREP_ID     = 4fbd90cc-7e06-4eef-a462-82efd386bfef`
- `CANONICAL_PREP_ID = 36016d31-4da1-466b-9547-e528cf0f4c8f`
- `BRAND_ID          = 2a000000-0000-0000-0000-000000000001` (constant)

Gate values:

- **gate_a** — 2 rows at `(brand_id, name='House Special Blend (Sauce)')`:
  one `is_current = true` prefixed `36016d31`, one `is_current = false`
  prefixed `4fbd90`. Matches manifest. PASS.
- **gate_b** — `prep_recipe_ingredients` fan-out for the stale `4fbd90`
  parent = **6**. Matches manifest. PASS.
- **gate_c** — `prep_recipe_ingredients` fan-out for the current `36016d31`
  parent = **6**. Recorded for cross-check; not gated. (Note: equal counts
  on the two parents do not imply identical ingredient sets — the post-flip
  ingredient list under owner-notes is an owner-curation follow-up per
  §15's "Owner-notes drift" risk.)
- **gate_d** — global `prep_recipe_ingredients` orphan-or-stale total =
  **405**. Matches Spec 003 gate_1's pre-cleanup baseline. PASS.

No STOP condition tripped. All four gates clear.

### Recovery snapshot

Captured to `scripts/recovery-snapshots/20260507T040300Z-spec006/` before
any apply attempt. Four files (TSV + JSON pair per table):

| File                                  | Lines | Notes                       |
|---------------------------------------|-------|-----------------------------|
| `prep_recipes_4fbd90.tsv`             | 2     | 1 header + 1 row            |
| `prep_recipe_ingredients_4fbd90.tsv`  | 7     | 1 header + 6 rows           |
| `prep_recipes_4fbd90.json`            | —     | matching JSON capture       |
| `prep_recipe_ingredients_4fbd90.json` | —     | matching JSON capture       |

Line counts match the architect's §2 manifest exactly. Rollback artifact
is durable.

### Migration

- Filename: `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql`
- 126 lines, single `BEGIN; … COMMIT;` transaction.
- `STALE_PREP_ID` embedded as a literal (`4fbd90cc-7e06-4eef-a462-82efd386bfef`).
- Idempotency contract per architect's §3.

### §3 tightening — assertion 2's parent-row SELECT

The architect's §3 draft had assertion 2's parent SELECT as:

```sql
SELECT count(*) FROM prep_recipes WHERE id = STALE_PREP_ID
```

This contradicted §13's path-C prediction. On local-with-seed-loaded, the
row at `4fbd90cc...` exists but with `is_current = true` (NOT false). The
unfiltered SELECT would return `v_parent = 1`, sending control into the
"parent present" branch. With `v_ing = 6`, that branch's `v_ing <> 6` check
is FALSE, so neither RAISE EXCEPTION fires, the assertion DO block exits
cleanly, and the subsequent DELETE statements run — wiping the local
canonical row and its 6 ingredient rows. That is precisely the silent
local data-loss that §13 path-C is supposed to prevent.

**Fix applied (user-authorized option A on 2026-05-07):** add
`AND is_current = false` to assertion 2's parent SELECT, mirroring
assertion 1's filter. One clause added to one SELECT; nothing else
changed. Diff:

```diff
   SELECT count(*) INTO v_parent
     FROM prep_recipes
-   WHERE id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid;
+   WHERE id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid
+     AND is_current = false;
```

Rationale citation: user-authorized option A on 2026-05-07. The
tightening achieves §13's intent (path-C must abort on the named
exception, not silently delete local canonical data).

### Path-C dry-run evidence

Run against `supabase_db_imr-inventory` (local) wrapped in explicit
`BEGIN; … ROLLBACK;` so no rows mutate. Local pre-state confirmed:
1 row at `(brand, name='House Special Blend (Sauce)')` with prefix
`4fbd90cc` and `is_current = true`; 6 ingredient rows joined to it.

**Pre-fix prediction (architect's draft, never actually executed —
deduced from the SQL):**

```
NOTICE: assertion_2: v_parent = 1, v_ing = 6
(no RAISE EXCEPTION; DELETEs would proceed and silently destroy local data)
```

**Post-fix actual output (executed 2026-05-07 against local):**

```
BEGIN
NOTICE:  assertion_1: v_count = 0
DO
NOTICE:  assertion_2: v_parent = 0, v_ing = 6
ERROR:  spec006: parent stale row absent but 6 orphan ingredient rows remain (idempotency invariant violated)
CONTEXT:  PL/pgSQL function inline_code_block line 24 at RAISE
ROLLBACK
```

Confirmed:

- `v_parent = 0` (was `1` pre-fix) — the new `AND is_current = false`
  filter excludes the local `is_current = true` row.
- `v_ing = 6` (unchanged — the ingredient SELECT was already correct).
- The `v_parent = 0 AND v_ing <> 0` branch fires with the architect's
  named exception text:
  `spec006: parent stale row absent but 6 orphan ingredient rows remain (idempotency invariant violated)`
- The transaction aborts cleanly; the explicit `ROLLBACK;` echoes
  through psql.
- Post-rollback re-probe confirmed local state unchanged: still
  `4fbd90cc | t` with 6 ingredient rows. No data mutated.

This matches §13 path-C's predicted shape exactly. The tightening is
load-bearing.

### Owner-notes edit

`docs/internal/prep-canonicalness-notes.md` line 99 — verified verbatim
match to architect's documented before-text before editing.

| Phase  | Line 99 content                                                       |
|--------|-----------------------------------------------------------------------|
| Before | `### House Special Blend (Sauce) (canonical prefix: 4fbd90)`          |
| After  | `### House Special Blend (Sauce) (canonical prefix: 36016d31)`        |

Lines 100–105 (the 6 ingredient lines beneath the heading) are untouched
per architect's §4 and §15 — owner-curated, follow-up review item.

## Files changed (build phase, pre-push)

- `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql`
  — new (126 lines; the §3 tightening lands as `AND is_current = false` on
  assertion 2's parent SELECT).
- `docs/internal/prep-canonicalness-notes.md` — modified at line 99
  (canonical prefix `4fbd90` → `36016d31`).
- `scripts/recovery-snapshots/20260507T040300Z-spec006/` — new directory,
  4 files:
    - `prep_recipes_4fbd90.tsv` (2 lines)
    - `prep_recipes_4fbd90.json`
    - `prep_recipe_ingredients_4fbd90.tsv` (7 lines)
    - `prep_recipe_ingredients_4fbd90.json`
- `specs/006-house-special-blend-sauce-drift.md` — modified (added
  `## Build notes` and `## Files changed (build phase, pre-push)` sections).

## Apply log + post-apply verification (2026-05-07, user-authorized push)

User authorized `npx supabase db push --linked` on 2026-05-07 after
reviewing the staged migration, recovery snapshot manifest, and path-C
dry-run output.

```
Applying migration 20260507030000_spec006_house_special_blend_sauce_cleanup.sql...
Finished supabase db push.
```

Migration applied without error against project `ebwnovzzkwhsdxkpyjka`.
No errors, no warnings. **Correction (2026-05-07, post-review):** an
earlier draft of this section claimed `RAISE NOTICE` lines fired during
prod apply but were suppressed by `supabase db push`'s output filter.
That was inaccurate — the committed migration has no `RAISE NOTICE`
statements (only `RAISE EXCEPTION`). The NOTICE-style narration shown in
the path-C dry-run (build notes section above) came from an instrumented
intermediate version of the SQL, not from the committed file. Prod
apply emitted no operator-visible audit lines; the four assertion
counts that landed (`v_count = 1`, `v_parent = 1, v_ing = 6`, deleted
ingredients = 6, deleted parent = 1) are inferred from the §5
verification probes below, not from runtime NOTICE output.

### §5 verification probes — all four PASS

Run via the Supabase MCP `execute_sql` tool against project
`ebwnovzzkwhsdxkpyjka` immediately after push.

| Probe | Expected | Actual | Status |
|-------|----------|--------|--------|
| verify_a — stale row gone | 0 | 0 | PASS |
| verify_b — orphan ingredients for stale id gone | 0 | 0 | PASS |
| verify_c — canonical untouched (id_prefix `36016d31`, is_current=true) | match | `36016d31` / true | PASS |
| verify_d — Spec 003 grand-total drift closed | 399 (was 405) | 399 | PASS |

verify_d's drop from 405 → 399 is exactly Spec 006's payload (1 prep_recipes
row + 6 prep_recipe_ingredients rows = 7 deletes; Spec 003's left-join
orphan count drops by 6 because the 6 ingredient orphans are the only
left-join hits affected — the prep_recipes parent doesn't appear in the
left-join's count). This closes Spec 003's gate_1 +6 stop condition; Spec
003's next retry will see remote/local parity at 399 grand-total.

### Recovery snapshot — preserved

The pre-apply recovery snapshot at
`scripts/recovery-snapshots/20260507T040300Z-spec006/` is committed
alongside this migration so a future operator can `\copy ... FROM` the
two TSV files back into prod if an unintended consequence surfaces.
Rollback procedure is documented in §14 of the design above.

### Status flip

`Status: READY_FOR_BUILD` → `Status: READY_FOR_REVIEW` (this commit).
Reviewer fan-out next: code-reviewer + security-auditor + test-engineer
+ backend-architect (post-impl drift).
