# Spec 003: Repoint orphaned `prep_recipe_ingredients.prep_recipe_id` references

Status: READY_FOR_BUILD

**Type:** Backend / data repair migration
**Filed:** 2026-05-06
**Predecessor:** [Spec 001](001-repoint-burger-patty-prep-refs.md) (DONE) — established the project precedent for one-shot prep-recipe orphan repair migrations.
**Cross-reference:** [Spec 002](002-pwa-catalog-bind-mount-fix.md) (DONE) — unblocked the local `pwa-catalog` HTTP path used for data-invariant verification analogous to Spec 001's AC7b.

## User story
As a backend operator of the 2AM PROJECT data layer, I want the orphan `prep_recipe_ingredients` rows that point at non-current (`is_current = false`) `prep_recipes` to be reconciled with the canonical current rows for each affected prep, so that the brand-catalog refactor's deduplication leaves no dangling internal references in the prep ingredient lists — eliminating the second (~100x larger) tail of the same root cause that Spec 001 fixed for `recipe_prep_items`.

## Background

Spec 001's pre-implementation probe (lines 56–62 of [`specs/001-repoint-burger-patty-prep-refs.md`](001-repoint-burger-patty-prep-refs.md)) enumerated every FK to `prep_recipes(id)` and counted orphans across each. The probe surfaced two distinct orphan populations:

| Column | Dangling | Non-current | Total orphans | Spec |
|---|---|---|---|---|
| `recipe_prep_items.prep_recipe_id` | 0 | 4 | 4 | 001 (DONE) |
| `prep_recipe_ingredients.prep_recipe_id` | 0 | 399 | **399** | **003 (this spec)** |
| `prep_recipe_ingredients.sub_recipe_id` | 0 | 0 | 0 (459 NULL, ignored) | n/a |

Both populations were created by `supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql`, which deduplicated `prep_recipes` by marking duplicates `is_current = false` but did NOT update FK refs in `prep_recipe_ingredients` to the canonical row. Spec 001 fixed the 4-row tail in `recipe_prep_items`. This spec addresses the 399-row tail in `prep_recipe_ingredients`.

Spec 001's "Sibling-table finding" section logged the characterization probe of the 399 orphans (probe SQL at [001-repoint-burger-patty-prep-refs.md lines 86–91](001-repoint-burger-patty-prep-refs.md)). Recorded findings, **as known on 2026-05-05** (architect must re-probe at design time — these numbers may have shifted post-Spec-001 apply, post-seed reload, or post-environment divergence):

- **52** distinct non-current `prep_recipe_id` values are referenced (vs 4 in `recipe_prep_items`).
- **10** distinct prep names affected, all in **1** brand (`2a000000-0000-0000-0000-000000000001`).
- Top offenders by orphan-row count, as recorded:

  | Prep name | Orphan ingredient rows |
  |---|---|
  | 2AM SAUCE | 150 |
  | House Special Seasoning Mix | 56 |
  | Cajun Seasoning (House Mix) | 48 |
  | White Sauce | 36 |
  | 2AM Sauce | 30 |
  | Burger Patty | 28 |
  | Tumeric Mix | 20 |
  | Yellow Rice | 16 |
  | 2AM SAUCE 10 | 10 |
  | Tumeric Seasoning (House Mix) | 5 |

- Notable: `2AM SAUCE` (150), `2AM Sauce` (30), and `2AM SAUCE 10` (10) appear as separate prep names — **case- and suffix-variant duplicates** that the dedup either did not collapse or collapsed in the opposite direction from how `prep_recipe_ingredients` was repointed. Architect must determine whether the canonical "current" prep for each variant family is itself unique, or whether the variant names refer to genuinely-different preps. The naming pattern strongly suggests the former (typos/casing) but this is not yet established — see Open Questions below.

### Why this is data-shape-dependent (not a copy of Spec 001)

Spec 001 had a clean narrow shape: 4 orphans → 1 canonical, all in one recipe ("2AM Cheeseburger"), all under one brand. The architect could verify the row-by-row safety analysis manually. This spec's 399 orphans fan out across **52 non-current source rows → up to 10 canonical destinations** (assuming the "top offenders" prep names each map to one canonical), and likely across a much larger set of recipes than the single "2AM Cheeseburger" Spec 001 touched. The semantic risk is also different:

- `recipe_prep_items` orphans break a downstream API contract (the `pwa-catalog` `prep_recipes[]` lookup).
- `prep_recipe_ingredients` orphans **may or may not** break a contract — a non-current prep with intact ingredient rows is internally consistent. **Whether the orphans actually represent broken state depends on whether the canonical and non-canonical versions of each affected prep have DIFFERENT ingredient lists.** That has not been investigated. Naive repointing without that answer would silently change recipe behavior if (and only if) the lists diverge.

### What Spec 001 established as project precedent

The architect should carry these forward unless the user overrides:

- Atomic transaction (`BEGIN` / `COMMIT`).
- Pre-mutation count assertion vs expected; `RAISE EXCEPTION` and roll back on mismatch.
- No partial repair under unexpected counts.
- Idempotent re-run path (count = 0 → no-op).
- Apply-path matrix (remote vs local-with-seed vs reset-then-seed) explicitly considered in design — Spec 001's section 5b is the template.
- Pre-impl probe required, results documented in spec.
- Design via `DO $$ ... $$` block, count-first control flow (canonical lookup gated by count branch).
- Per-store RLS hardening implications considered (`auth_can_see_store()` / `auth_is_admin()`); migration assumes superuser apply context.
- Realtime publication-membership gotcha surfaced even when no publication change is required.
- Filename timestamp ordering matters when this migration interacts with adjacent migrations on the apply path.
- Backend-architect designs and revises until correct (Spec 001 took 3 revisions after surfacing apply-path edge cases).

## Acceptance criteria

> Numeric placeholders below intentionally avoid hardcoding "exactly 399" and "exactly 52 non-current sources" because Spec 001 demonstrated that what looks like a stable count from a prior probe can shift between probe time and apply time (Spec 001's Path A vs Path B-revised divergence). The architect's pre-implementation probe is the source of truth for the count contract; the developer encodes whatever value the architect's probe certifies.

> **Resolved repair strategy (per user direction on Q1/Q2/Q3):** Delete divergent rows, repoint matching rows; no constraint guard; bulk migration with per-prep assertions on top of the grand-total assertion.

- [ ] A new timestamped migration is added under `supabase/migrations/` following the established `YYYYMMDDHHMMSS_description.sql` naming convention.
- [ ] The migration is wrapped in an atomic transaction (`BEGIN` / `COMMIT`).
- [ ] The migration looks up canonical current `prep_recipes` rows by `(name, brand_id, is_current = true)` for each affected prep name. **For each affected name, exactly one current row must be found.** If any affected name resolves to zero or multiple current rows, `RAISE EXCEPTION` and roll back. (Mirrors Spec 001 section 4a–4b, generalized across all affected names rather than the single hardcoded "Burger Patty".)
- [ ] The migration applies the **"delete divergent, repoint matching"** strategy: for each orphan `prep_recipe_ingredients` row whose source non-current prep has an ingredient set IDENTICAL to its canonical current counterpart, repoint via `UPDATE … SET prep_recipe_id = canonical`. For each orphan whose source non-current prep has an ingredient set that DIVERGES from the canonical's, DELETE the orphan row. The canonical's ingredient list is authoritative; divergent ingredient lines are discarded. (Set-equality is computed over `(catalog_ingredient_id, quantity, unit)` tuples per the probe gate item 4 below; architect codifies the exact predicate.)
- [ ] The migration counts orphan `prep_recipe_ingredients` rows in scope (rows whose `prep_recipe_id` resolves to a `prep_recipes` row with `is_current = false`) before mutating anything.
  - If the orphan count is exactly **0**, exit successfully as a no-op (idempotent re-run path).
  - If the orphan count equals the architect's certified expected count (computed at probe time), proceed with repair, then verify total rows affected (deleted + updated) equals expected count. If the affected count differs from expected, `RAISE EXCEPTION` and roll back. **No partial repair under unexpected state.**
  - If the orphan count is anything other than 0 or the expected count, `RAISE EXCEPTION` and roll back.
- [ ] **Per-prep affected-count assertions.** In addition to the grand-total assertion above, the migration asserts the affected count (deleted + updated) for EACH affected prep name matches the architect's per-prep expected counts certified at probe time. If any per-prep count diverges, `RAISE EXCEPTION` and roll back. This gives better diagnostics than Spec 001's pure grand-total approach if the migration aborts mid-apply — the operator knows which prep's repair shape changed between probe and apply.
- [ ] **No DB-level constraint guard ships in this migration.** This spec is a one-shot data fix in the same shape as Spec 001. Future-drift prevention (partial unique index on `(name, brand_id) WHERE is_current = true`, trigger asserting `prep_recipe_ingredients.prep_recipe_id` references a current row, etc.) is explicitly out of scope. If the architect believes a guard is warranted, it is filed as a separate spec recommendation in the architect's handoff — it does NOT block this spec.
- [ ] **Variant-name groupings reported, not unified.** The architect's probe output must explicitly report the variant-name groupings (e.g., `2AM SAUCE` / `2AM Sauce` / `2AM SAUCE 10`) and any same-prep evidence (or lack thereof) the probe surfaces. **User policy: variant names are treated as SEPARATE preps unless the probe surfaces a strong reason to unify (e.g., they are clearly the same prep with typos).** If the probe surfaces such evidence, surface to the user before proceeding — variant-name unification is otherwise out of scope and gets a follow-up spec if needed.
- [ ] After the migration is applied via `supabase db push` against a populated environment (remote prod or a local DB that already has `seed.sql` loaded), re-running the orphan-count probe SQL returns 0 rows. This must hold under whichever apply-path branches the architect identifies as live (Path A / B-original / B-revised / etc. — Spec 001's section 5b is the template; architect must enumerate the variants for THIS spec's data shape).
- [ ] When applied via `supabase db reset --local` (which runs migrations against an EMPTY DB before loading `seed.sql`), the migration completes without error as a no-op. End-state orphans persisting after `seed.sql` loads is expected and is not a defect of this migration — same structural limitation as Spec 001 AC6.
- [ ] **(Data invariant via SQL substitute)** After the migration is applied, every `prep_recipe_id` referenced by `prep_recipe_ingredients` resolves to a `prep_recipes` row with `is_current = true`. Verified via SQL probe (`docker exec ... psql` locally, `supabase db query --linked` remotely).
- [ ] **(HTTP path through `pwa-catalog`)** Architect determines whether a `pwa-catalog` HTTP-path AC is meaningful for this spec given the resolved "delete divergent, repoint matching" strategy. `pwa-catalog` emits `prep_recipes[].ingredients[]` derived from `prep_recipe_ingredients`; under the resolved strategy, the canonical's ingredient list is authoritative for every affected prep, so the catalog payload's `ingredients[]` for each canonical prep should equal what the canonical already had pre-migration (no shift on canonicals). The HTTP-path AC primarily confirms no regression on the canonical side. Spec 002 unblocked the local HTTP path so this AC is achievable; architect's call whether to include it.
- [ ] **(Sub-recipe column regression check — see Open Q5)** Re-run the `prep_recipe_ingredients.sub_recipe_id` probe at architect time. Spec 001's probe found 0 orphans in this column on 2026-05-05; this AC re-confirms that finding has not regressed at apply time. If non-zero orphans appear in `sub_recipe_id`, surface to the user before proceeding — do not auto-expand scope.
- [ ] The migration has been reviewed by the security-auditor for RLS implications (writes touching `prep_recipe_ingredients` under per-store RLS hardening — see `supabase/migrations/20260504173035_per_store_rls_hardening.sql`). The hardening migration covers `inventory_items`, `eod_*`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items` — the auditor must enumerate any policies on `prep_recipe_ingredients` directly (likely defined in earlier brand-catalog refactor migrations) and confirm none reject the migration's mutations under superuser apply context, and confirm no `WITH CHECK` invariant is violated.
- [ ] The migration has been reviewed by the backend-architect for migration convention adherence (filename format, helper function usage, `SECURITY DEFINER` semantics if used, transaction style, comment style — Spec 001's design is the precedent).

## Pre-implementation gate: ingredient-divergence probe

Before the architect designs the migration, the architect must run a pre-implementation probe and document results inline in this spec (under "Probe results"). The probe must answer:

1. **Is the recorded characterization (52 non-current sources, 10 prep names, 1 brand, 399 rows) still accurate** against both the local seeded DB and remote prod? Spec 001 demonstrated probe results can shift between filing and apply time.
2. **For each affected prep name** (`2AM SAUCE`, `House Special Seasoning Mix`, etc.), how many `is_current = true` rows exist in `prep_recipes` filtered to `(name, brand_id)`? The migration's lookup contract requires exactly 1 per name.
3. **Variant-name groupings (`2AM SAUCE` vs `2AM Sauce` vs `2AM SAUCE 10`).** The probe must report the variant-name groupings explicitly (per-name canonical row id, per-name canonical ingredient set, any cross-variant overlap or lack thereof). User policy: treat as SEPARATE preps unless the probe surfaces strong same-prep evidence (typos, identical ingredient sets, identical downstream usage). If such evidence appears, surface to the user — do not auto-expand to a unification step.
4. **Ingredient-divergence question (the central one for this spec):** for each affected non-current prep, do its `prep_recipe_ingredients` rows have the same `(catalog_ingredient_id, quantity, unit)` set as its canonical current counterpart, or do they differ? **Required output (per user policy on Q1):** the architect must produce per-prep counts of (a) MATCHING rows → repoint candidates, and (b) DIVERGENT rows → delete candidates. These counts are the per-prep expected counts the migration asserts against (per the per-prep affected-count assertion AC above).
5. **Cross-brand check:** Spec 001 reported "all 10 prep names in 1 brand" on 2026-05-05. Re-confirm at probe time. If any cross-brand orphan now exists, surface to the user.
6. **Recipe fan-out:** how many distinct recipes (via `prep_recipe_ingredients.prep_recipe_id` → `prep_recipes` → upstream usage) are affected? Even though the user has chosen bulk repair, fan-out is still useful diagnostic context if the migration aborts.
7. **`prep_recipe_ingredients.sub_recipe_id` regression check:** re-run the column-2 probe from Spec 001. Was 0 orphans, must still be 0 orphans, or surface to user.

**Expected outcome based on Spec 001's recorded probe:** 399 orphan rows across 52 non-current sources, 10 prep names, 1 brand. Anything else is news and must be surfaced before this spec proceeds. The architect must NOT auto-expand scope based on probe results — surface findings, get user direction.

### Probe results

Populated by backend-developer 2026-05-06 at build start. **Multiple build-stop conditions triggered — see `## Build notes` at the bottom of this spec.**

- [x] `prep_recipe_ingredients.prep_recipe_id` orphan count: **local 399 / remote 405** (matches recorded value locally; remote diverges +6)
- [x] Distinct non-current source `prep_recipe_id` count: **local 52** (matches recorded; remote not probed past gate 1 due to permission denial)
- [x] Affected prep names + brand fan-out: **local 10 names, 1 brand** (matches recorded)
- [x] Per-name canonical-current count (must be exactly 1 per name): **VIOLATED — 4 of 10 names have count = 0 (`2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`).** STOP condition triggered.
- [x] Variant-name groupings + same-prep evidence (or lack): **`2am sauce` group: `[2AM Sauce, 2AM SAUCE]` — strong same-prep evidence (near-identical ingredient sets; only differences are in unit normalization for two ingredients).** STOP condition triggered.
- [x] Ingredient-set divergence per affected prep (matching → repoint / divergent → delete): see gate 4 table in `## Build notes` below. Note: results unreliable for 4 names that have no canonical at all (those rows are classified `divergent` by default because `EXISTS` against an empty canonical set is always false — but that classification is not honest).
- [x] Cross-brand orphans: **0 (1 brand only — `2a000000-...`)** as expected.
- [x] Recipe fan-out (count of distinct recipes whose preps are affected): **15 recipes** (informational).
- [x] `prep_recipe_ingredients.sub_recipe_id` orphans: **0** (matches recorded — no regression).

## In scope

- One new SQL migration in `supabase/migrations/` that resolves the orphan `prep_recipe_ingredients.prep_recipe_id` rows pointing at non-current `prep_recipes`, applying the resolved "delete divergent, repoint matching" strategy.
- Pre-implementation probe per the gate above, with results recorded in this spec.
- Per-prep affected-count assertions on top of the grand-total assertion.
- Local + remote verification via SQL orphan-count probe, mirroring Spec 001 AC4 verification.
- An optional HTTP-path verification through `pwa-catalog` analogous to Spec 001 AC7b — included only if the architect determines it is meaningful for this spec's mutation surface.

## Out of scope (explicitly)

- **`prep_recipe_ingredients.sub_recipe_id` repair.** Was 0 orphans on Spec 001's probe; architect must re-confirm at design time per the gate above. If the regression check finds orphans, surface to the user — do not auto-expand.
- **`recipe_prep_items` re-fix.** Spec 001 already addressed those 4 rows. Architect must NOT touch `recipe_prep_items` in this spec.
- **Deleting the now-unreferenced non-current `prep_recipes` rows** (the 52 sources). Mirrors Spec 001's "deleting orphan source rows is a separate follow-up spec" stance — repointing is reversible, deletion is not.
- **Constraint hardening (DB-level FK guard, trigger, partial unique index on `is_current = true`, etc.)** to prevent future drift. Resolved per Q2: data fix only, no guard in this spec. If the architect believes a guard is warranted, they file it as a separate spec recommendation in their handoff — it does NOT block this spec.
- **Auto-expanding scope to other sibling tables** if the architect's probe surfaces unexpected orphans elsewhere — surface to user.
- **Variant-name unification** (`2AM SAUCE` vs `2AM Sauce` vs `2AM SAUCE 10` collapse). Resolved per Q3: variants are treated as SEPARATE preps unless the probe surfaces strong same-prep evidence; if such evidence appears, surface to the user and file a follow-up spec.
- **Changes to `pwa-catalog` edge function logic.** The function's `is_current = true` filter is correct (same precedent as Spec 001). Bug is bad data, not bad code.
- **UI changes in `imr-inventory`.** Backend-only data fix, no Cmd UI section, no legacy admin screen.
- **A general-purpose deduplication tool, cron, or scheduled cleanup.** This is a one-shot fix for the same Phase 2 backfill incident as Spec 001.
- **Test framework introduction** for this spec. Verification stays manual (SQL probe + optional HTTP curl), same as Spec 001. Test framework selection (vitest recommended in Spec 001 lessons learned) is its own future spec.

## Open questions resolved

- **Q1 — Repair strategy under ingredient-set divergence.** RESOLVED: **"Delete divergent, repoint matching."** Canonical's ingredient list is authoritative. Orphans whose ingredient set MATCHES the canonical → repointed via `UPDATE … SET prep_recipe_id = canonical`. Orphans whose ingredient set DIVERGES from the canonical → deleted. Matches Spec 001's "canonical wins" precedent. Some recipe ingredient lists may shift visibly to store managers; that is accepted. The three subcases enumerated at filing time (all-identical / some-differ / many-differ) collapse to a single migration shape under this directive — the migration applies the same predicate uniformly per row, regardless of how skewed the matching/divergent split turns out at probe time. The architect's probe still produces per-prep counts of matching and divergent rows because those counts feed the per-prep assertions (Q3 below); they no longer gate strategy selection.

- **Q2 — One-shot data fix vs data fix + constraint guard.** RESOLVED: **"Data fix only."** Same shape as Spec 001. No DB-level guard (no partial unique index, no trigger, no FK refinement) ships in this migration. Future-drift prevention is explicitly out of scope for this spec. If the architect believes a guard is needed, they file it as a separate spec recommendation in their handoff — they must NOT block this spec on a guard, and must NOT bundle a guard into this migration. Rationale: a guard is a structural change with broader risk surface than a data fix and warrants its own design pass.

- **Q3 — Recipe-count tolerance / staging.** RESOLVED: **"Bulk + stricter per-prep asserts."** One migration, atomic transaction. Grand-total count assertion (Spec 001 shape) PLUS per-prep-name affected-count assertions on top. The per-prep assertions give better diagnostics than Spec 001's pure grand-total approach if the migration aborts mid-apply — the operator can identify which prep's repair shape changed between probe and apply. Variant-name handling (folded from the original PM-question list): variant names (`2AM SAUCE` / `2AM Sauce` / `2AM SAUCE 10`) are treated as SEPARATE preps unless the architect's probe surfaces strong same-prep evidence (e.g., clearly the same prep with typos, identical ingredient sets, identical downstream usage). Variant-name unification is otherwise out of scope and gets a follow-up spec if needed.

- **Q4 — Cross-brand check at scale.** _Deferred to architect probe time._ Spec 001 said "no cross-brand issues" for its 4 rows. At 399 rows, the architect's probe re-confirms; if any cross-brand orphan exists, the architect surfaces to the user before designing.

- **Q5 — Sub-recipe column regression.** _Deferred to architect probe time._ Probe gate item 7 above re-confirms the 0-orphan finding from Spec 001. Architect surfaces if this regressed.

- **Q6 — Seed.sql divergence between local and remote.** _Deferred to architect probe time._ Spec 001 hit Path B-revised on both local and remote (no Path A divergence). The architect must verify this still holds for the 399 by running the probe on both environments. Spec 001's section 5b matrix is the template.

- **Q7 — Backout / reversal plan.** _Deferred to architect probe time._ Spec 001 did not ship an explicit backout migration; reversal was "rollback the migration". At 399 rows touched (and now with DELETEs in the mix per the resolved Q1), the architect must decide whether a documented backout migration is warranted (e.g., a stored snapshot of the pre-mutation state captured into a sidecar table within the same transaction) or whether the inverse reconstructed from the original orphan-source mapping is sufficient. The architect's call. Note: the resolved Q1's DELETE branch makes pure UPDATE-inverse reversal lossy on its own; architect should weigh this when choosing.

## Dependencies

- Spec 001's migration (`supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql`) — applied to local and remote, sets the precedent shape. **In particular:** Spec 001's "Lessons learned" section (lines 618–625) carries forward should-fix items the architect must apply to this spec's migration:
  1. Use `EXISTS (SELECT 1 ...)` for boolean-predicate checks, not `SELECT COUNT(*) > 0`.
  2. NOTICE messages should use neutral wording when multiple branches can produce the same final count.
  3. Don't assume external state on remote without probing it.
- Existing migration `supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql` (the migration that introduced the orphans for both Specs 001 and 003).
- Existing migration `supabase/migrations/20260505000000_dedupe_repointed_ingredient_lines.sql` — currently latest applied dedup migration; new migration must sort after it. Spec 001's filename was load-bearing for sort-before-dedup; this spec's filename is load-bearing for sort-after-everything. Architect to confirm timestamp.
- Existing migration `supabase/migrations/20260504173035_per_store_rls_hardening.sql` — RLS context the security-auditor must review the new migration against.
- Existing edge function `supabase/functions/pwa-catalog/` — used for optional HTTP-path verification; not modified. Spec 002's bind-mount fix unblocks local HTTP testing.
- Local Supabase dev stack (`npm run dev:db`) for verification.

## Project-specific notes

- **Cmd UI section / legacy:** N/A — backend-only data fix, no UI surface.
- **Per-store or admin-global:** Brand-scoped (recorded as brand `2a000000-...` only; architect re-confirms at probe). Migration runs as superuser at apply time; RLS does not gate the migration itself, but the security-auditor must confirm the writes do not violate any post-apply invariant under per-store RLS hardening (`auth_can_see_store()` / `auth_is_admin()`). Same superuser-only apply assumption as Spec 001 — flag for security-auditor.
- **Realtime channels touched:** `brand-{brandId}` per-affected-brand. The `brand-{brandId}` channel in `src/hooks/useRealtimeSync.ts` (lines 35–38) subscribes to `recipes`, `prep_recipes`, `catalog_ingredients`, `vendors` — **not `prep_recipe_ingredients`**. Same finding as Spec 001 section 6: even if the row event is published, no admin client is currently listening for it. **The realtime publication-membership gotcha (`docker restart supabase_realtime_imr-inventory` after a publication change) does NOT apply** — this migration does not change publication membership. Flag for the developer/auditor: do not add `prep_recipe_ingredients` to the publication as part of this fix; that's an unrelated change.
- **Migrations needed:** Yes — one new timestamped SQL migration. (No second migration: per resolved Q2, no constraint guard ships in this spec.)
- **Edge functions touched:** None modified. `pwa-catalog` may be used for optional HTTP-path verification only (depends on architect's call after probe).
- **Web/native scope:** N/A — backend-only.
- **Tests:** No test framework wired up in this repo. Verification stays manual (SQL probe + optional HTTP curl), same as Spec 001. Spec 001's lessons learned recommends vitest for the next spec that needs automated coverage; not blocking for this spec.
- **`app.json` slug:** Not touched.
- **`AdminScreens.tsx`:** Not touched. (Backend-only fix.)
- **`useStore.ts` / `useSupabaseStore.ts` / `useJsonServerSync.ts`:** Not touched. (Backend-only fix.)

## Risk surface (PM-level summary; architect refines in design)

- **Repair strategy under ingredient divergence (Q1, RESOLVED).** Strategy is "delete divergent, repoint matching" — canonical wins. Risk shifts from "silent recipe-behavior change" to "visible ingredient-list shift on divergent recipes". User has accepted that some recipe ingredient lists may visibly shift to store managers. The probe gate's "ingredient-set divergence per affected prep" item is still the most important architect output, now because it produces the per-prep counts the migration asserts against.
- **Apply-path matrix at 399-row scale.** Spec 001 surfaced THREE distinct populated-environment apply paths (A, B-original, B-revised) for 4 rows; at 52 distinct non-current source UUIDs, the matrix could be larger or smaller depending on whether the dedup index already collides on the in-flight UPDATE. Architect must trace the matrix explicitly per Spec 001's section 5b template, **including whether the live unique index `recipe_prep_items_logical_unique` has an analog on `prep_recipe_ingredients`** that would force a similar DELETE-or-UPDATE branch; if so, architect must confirm Spec 001's ROW_NUMBER survivor pattern transposes cleanly to this spec's partition keys. Note: the resolved Q1's DELETE branch interacts with the apply-path matrix — divergent rows are deleted unconditionally regardless of which path is taken, but UPDATE-side collisions still need the survivor pattern.
- **Variant-name aliasing (Q3, RESOLVED — separate unless probe shows otherwise).** `2AM SAUCE` / `2AM Sauce` / `2AM SAUCE 10` are surfaced by the recorded probe as separate prep names. User policy is to treat as separate. If the architect's probe surfaces strong same-prep evidence, surface to the user before designing — do not auto-expand to a unification step.
- **Recipe fan-out blast radius (Q3, RESOLVED — bulk with per-prep asserts).** 399 rows touched in one migration is a much larger blast radius than Spec 001's 4. Per-prep affected-count assertions are now required (per Q3 resolution) to give better diagnostics than Spec 001's grand-total-only approach if the migration aborts mid-apply.
- **Cross-spec coupling.** This spec's `pwa-catalog` HTTP-path AC (if included) depends on Spec 002's bind-mount fix, which is DONE. Spec 002 is a dependency in the operational sense (HTTP path must work) but not in the migration apply-order sense.

## Handoff guidance for the architect

When this spec flips to `READY_FOR_ARCH`, the architect should:

1. Read Spec 001 in full — it is the precedent. Section 5 (control flow), section 5b (apply-path matrix), and the post-merge "Lessons learned" section (lines 618–625) are the most directly applicable.
2. Run the pre-implementation probe per the gate above and populate the "Probe results" section. **Resolved Q1 ("delete divergent, repoint matching") collapses what would have been three branching strategy paths into one migration shape** — the architect does not need to choose between strategies. The probe still must produce per-prep counts of matching (repoint) and divergent (delete) rows because those counts feed the per-prep assertions required by resolved Q3.
3. Confirm with the user that the resolved Q1 / Q2 / Q3 stances still hold once the probe data is in. If the probe data invalidates a directive (e.g., probe finds zero divergent rows everywhere — Q1's DELETE branch is dead code, surface as an FYI; or probe finds variant-name same-prep evidence — surface for direction), surface immediately and do not proceed with design.
4. Produce the design via the same `DO $$ ... $$` block + count-first + branch-on-count + group-level-survivor-selection-if-needed shape as Spec 001 section 5. Encode the architect's certified expected count(s) as literals in the migration: a grand-total expected count AND a per-prep expected count for each affected name (per resolved Q3). No probe-time coupling at apply time.
5. **If the architect determines a constraint guard is warranted (per resolved Q2's "architect may file as separate spec"), surface as a recommendation in the handoff payload — do NOT bundle it into this migration and do NOT block this spec on it.**
6. Set `Status: READY_FOR_BUILD` and hand off per Spec 001's pipeline (backend-developer parallel-fan-in with reviewers).

## Backend design

### 0. Architect probe-execution constraint (must be addressed before build proceeds)

**The architect dispatched for spec 003's design pass has Read/Write/Edit tooling only — no shell or `docker exec` access.** The "Probe results" section below therefore CANNOT be populated with live numeric values inline by this design pass. The architect has instead:

- Recorded the **expected probe outputs** based on (a) Spec 001's recorded probe (399 rows, 52 sources, 10 names, 1 brand, on 2026-05-05), (b) the owner-curated canonical ingredient lists in [`docs/internal/prep-canonicalness-notes.md`](../docs/internal/prep-canonicalness-notes.md) (working draft, captured 2026-05-05), and (c) the schema and dedup-index reality verified by reading the migrations directly.
- Provided **complete, copy-pasteable probe SQL** in section 1 below that returns the exact per-prep counts the migration's `_spec003_expectations` temp table needs as input.
- Designed the migration so that the probe outputs are **encoded as a hardcoded expectation manifest inside the migration body**, not derived at apply time. This is the same shape Spec 001 used for its `4` literal — Spec 003's manifest is a 10-row table of `(prep_name, expected_repoint_count, expected_delete_count)` tuples plus a grand total.

**What the developer MUST do before authoring the migration:**

1. Run the probe SQL in section 1 below against the local seeded DB (`docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < probe.sql`), pasting the output into the "Probe results" checklist above this design section. This populates the actual numeric values the architect could not.
2. Run the same probe against remote prod (`npx supabase db query --linked < probe.sql`). If local and remote disagree on grand-total or per-prep counts, **STOP** — surface to the user before proceeding. Spec 001's apply-path divergence between local and remote was 0 (both hit Path B-revised), but at 52 source UUIDs the variance surface is larger.
3. If the probe surfaces any of the following, **STOP** and surface to the user before continuing build:
   - Cross-brand orphans (probe item 5).
   - Same-prep evidence across variant names `2AM SAUCE` / `2AM Sauce` / `2AM SAUCE 10` (probe item 3).
   - `prep_recipe_ingredients.sub_recipe_id` orphans regression (probe item 7).
   - Per-prep canonical-current count != 1 for any name (probe item 2).
   - All-zero divergent counts everywhere (Q1's DELETE branch becomes dead code — FYI to user).
4. Encode the certified per-prep counts into the migration's expectation manifest verbatim. **No probe-time coupling at apply time** — the migration must contain the same literal values that the developer just produced.

This is **structurally similar** to Spec 001's pre-implementation gate (architect probes, encodes literal `4`, developer verifies match at apply time). The only difference: spec 003's literal is a 10-row manifest rather than a single integer, and the data captured is one design pass deeper because the matching/divergent split per prep cannot be derived from public schema alone — it requires running the probe against the seeded data.

**This is the only deviation from the architect-runs-probe-inline mandate in the spec gate.** All other gate items are addressed in this design.

### 1. Probe SQL (developer runs at build start; architect supplies)

The probe SQL below answers all 7 gate items in a single transaction (read-only). Run via `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -f -` against the local DB and `npx supabase db query --linked` against remote.

```sql
-- Spec 003 pre-implementation probe.
-- Returns 7 result sets, one per gate item. Read-only — no mutations.

-- Gate item 1: orphan grand total + breakdown.
SELECT 'gate_1_grand_total' AS probe,
       COUNT(*) FILTER (WHERE pr.id IS NULL)                                  AS dangling,
       COUNT(*) FILTER (WHERE pr.id IS NOT NULL AND pr.is_current = false)    AS non_current,
       COUNT(*) FILTER (WHERE pr.id IS NULL OR pr.is_current = false)         AS total_orphans
  FROM public.prep_recipe_ingredients t
  LEFT JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id;

-- Gate item 1b: distinct non-current source prep_recipe_id count.
SELECT 'gate_1b_distinct_sources' AS probe,
       COUNT(DISTINCT pr.id) AS distinct_non_current_sources
  FROM public.prep_recipe_ingredients t
  JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id
 WHERE pr.is_current = false;

-- Gate item 1c: per-prep-name affected breakdown (for the manifest).
SELECT 'gate_1c_per_name'   AS probe,
       pr.name              AS prep_name,
       pr.brand_id::text    AS brand,
       COUNT(*)             AS orphan_rows,
       COUNT(DISTINCT pr.id) AS source_rows
  FROM public.prep_recipe_ingredients t
  JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id
 WHERE pr.is_current = false
 GROUP BY pr.name, pr.brand_id
 ORDER BY orphan_rows DESC;

-- Gate item 2: per-name canonical-current count (must be exactly 1 per name).
SELECT 'gate_2_canonical_per_name' AS probe,
       affected.name        AS prep_name,
       affected.brand_id::text AS brand,
       COUNT(curr.id)       AS canonical_current_count,
       array_agg(curr.id::text ORDER BY curr.id) FILTER (WHERE curr.id IS NOT NULL) AS canonical_ids
  FROM (
    SELECT DISTINCT pr.name, pr.brand_id
      FROM public.prep_recipe_ingredients t
      JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id
     WHERE pr.is_current = false
  ) affected
  LEFT JOIN public.prep_recipes curr
    ON curr.name = affected.name
   AND curr.brand_id = affected.brand_id
   AND curr.is_current = true
 GROUP BY affected.name, affected.brand_id
 ORDER BY affected.name;

-- Gate item 3: variant-name groupings (case-insensitive collapse).
-- Surfaces 2AM SAUCE / 2AM Sauce / 2AM SAUCE 10 as a single group if they
-- share lower-case prefix, AND reports their canonical ingredient sets so
-- the architect can eyeball whether they're "the same prep".
WITH affected_names AS (
  SELECT DISTINCT pr.name, pr.brand_id
    FROM public.prep_recipe_ingredients t
    JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id
   WHERE pr.is_current = false
)
SELECT 'gate_3_variants'         AS probe,
       lower(name)               AS lower_name,
       array_agg(DISTINCT name ORDER BY name) AS distinct_cased_names,
       COUNT(DISTINCT name)      AS variant_count
  FROM affected_names
 GROUP BY lower(name), brand_id
HAVING COUNT(DISTINCT name) > 1
 ORDER BY variant_count DESC, lower_name;

-- Gate item 3b: canonical ingredient sets per affected name (for cross-variant
-- comparison + the matching/divergent computation in gate item 4).
SELECT 'gate_3b_canonical_ingredients' AS probe,
       curr.name                 AS prep_name,
       pri.catalog_id::text      AS catalog_id,
       pri.sub_recipe_id::text   AS sub_recipe_id,
       COALESCE(pri.type, 'raw') AS type,
       pri.unit                  AS unit,
       pri.quantity              AS quantity
  FROM public.prep_recipes curr
  JOIN public.prep_recipe_ingredients pri ON pri.prep_recipe_id = curr.id
 WHERE curr.is_current = true
   AND curr.name IN (
     SELECT DISTINCT pr.name
       FROM public.prep_recipe_ingredients t
       JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id
      WHERE pr.is_current = false
   )
 ORDER BY curr.name, pri.catalog_id, pri.sub_recipe_id, pri.unit;

-- Gate item 4: per-prep matching/divergent counts.
-- An orphan row "matches" its canonical iff there exists a canonical row at
-- the SAME (catalog_id, sub_recipe_id, type, unit, quantity) tuple. Otherwise
-- it's "divergent" and the resolved Q1 directive deletes it.
--
-- NULL handling matches the dedup index semantics:
--   - catalog_id, sub_recipe_id, unit compared with IS NOT DISTINCT FROM
--   - type compared via COALESCE(type, 'raw') (matches dedup index)
--   - quantity compared with IS NOT DISTINCT FROM (covers any NULL quantities)
WITH orphans AS (
  SELECT pri.id           AS orphan_id,
         pri.prep_recipe_id AS orphan_source_id,
         pr.name          AS prep_name,
         pr.brand_id      AS brand_id,
         pri.catalog_id,
         pri.sub_recipe_id,
         COALESCE(pri.type, 'raw') AS type,
         pri.unit,
         pri.quantity
    FROM public.prep_recipe_ingredients pri
    JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
   WHERE pr.is_current = false
),
canonicals AS (
  SELECT pri.prep_recipe_id AS canonical_id,
         pr.name           AS prep_name,
         pr.brand_id       AS brand_id,
         pri.catalog_id,
         pri.sub_recipe_id,
         COALESCE(pri.type, 'raw') AS type,
         pri.unit,
         pri.quantity
    FROM public.prep_recipe_ingredients pri
    JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
   WHERE pr.is_current = true
     AND pr.name IN (SELECT DISTINCT prep_name FROM orphans)
),
classified AS (
  SELECT o.orphan_id,
         o.prep_name,
         o.brand_id,
         CASE WHEN EXISTS (
           SELECT 1 FROM canonicals c
            WHERE c.prep_name    = o.prep_name
              AND c.brand_id     = o.brand_id
              AND c.catalog_id    IS NOT DISTINCT FROM o.catalog_id
              AND c.sub_recipe_id IS NOT DISTINCT FROM o.sub_recipe_id
              AND c.type          = o.type
              AND c.unit          IS NOT DISTINCT FROM o.unit
              AND c.quantity      IS NOT DISTINCT FROM o.quantity
         ) THEN 'matching' ELSE 'divergent' END AS classification
    FROM orphans o
)
SELECT 'gate_4_per_prep_split' AS probe,
       prep_name,
       brand_id::text AS brand,
       COUNT(*) FILTER (WHERE classification = 'matching')  AS expected_repoint_count,
       COUNT(*) FILTER (WHERE classification = 'divergent') AS expected_delete_count,
       COUNT(*) AS expected_total_count
  FROM classified
 GROUP BY prep_name, brand_id
 ORDER BY expected_total_count DESC;

-- Gate item 5: cross-brand check.
SELECT 'gate_5_cross_brand' AS probe,
       COUNT(DISTINCT pr.brand_id) AS distinct_brands,
       array_agg(DISTINCT pr.brand_id::text ORDER BY pr.brand_id::text) AS brand_ids
  FROM public.prep_recipe_ingredients t
  JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id
 WHERE pr.is_current = false;

-- Gate item 6: recipe fan-out (how many distinct recipes are downstream).
-- Joins through recipe_prep_items because prep_recipe_ingredients itself does
-- not reference recipes — recipes consume preps via recipe_prep_items.
SELECT 'gate_6_recipe_fanout' AS probe,
       COUNT(DISTINCT rpi.recipe_id) AS distinct_recipes_affected
  FROM public.recipe_prep_items rpi
 WHERE rpi.prep_recipe_id IN (
   SELECT DISTINCT pr.id
     FROM public.prep_recipes pr
    WHERE pr.name IN (
      SELECT DISTINCT pr2.name
        FROM public.prep_recipe_ingredients t
        JOIN public.prep_recipes pr2 ON pr2.id = t.prep_recipe_id
       WHERE pr2.is_current = false
    )
      AND pr.is_current = true
 );

-- Gate item 7: prep_recipe_ingredients.sub_recipe_id regression check.
SELECT 'gate_7_sub_recipe_orphans' AS probe,
       COUNT(*) FILTER (WHERE sub_pr.id IS NULL AND t.sub_recipe_id IS NOT NULL) AS dangling,
       COUNT(*) FILTER (WHERE sub_pr.id IS NOT NULL AND sub_pr.is_current = false) AS non_current,
       COUNT(*) FILTER (WHERE t.sub_recipe_id IS NOT NULL AND (sub_pr.id IS NULL OR sub_pr.is_current = false)) AS total_orphans
  FROM public.prep_recipe_ingredients t
  LEFT JOIN public.prep_recipes sub_pr ON sub_pr.id = t.sub_recipe_id;
```

Save as `/tmp/spec003-probe.sql` (or similar), run, and paste the per-result-set output into the Probe results checklist above.

### 2. Anticipated probe results (architect's pre-design baseline)

These are the architect's expectations based on Spec 001's 2026-05-05 recorded probe + the owner-curated canonical lists. **The developer must verify each line below against actual probe output. Any divergence stops the build.**

| Gate item | Expected | Source |
|---|---|---|
| 1 grand total | `dangling=0, non_current=399, total_orphans=399` | Spec 001 lines 56–62, recorded 2026-05-05 |
| 1b distinct sources | `52` | Same |
| 1c per-name breakdown | 10 prep names per the table on spec lines 31–43 | Same |
| 2 canonical-current count | `1` for each of the 10 affected names | Inferred from `docs/internal/prep-canonicalness-notes.md` listing one canonical prefix per prep |
| 3 variant groupings | `2am sauce` group: `[2AM SAUCE, 2AM Sauce, 2AM SAUCE 10]` (3 distinct cased names). User policy: SEPARATE unless probe surfaces same-prep evidence. | Spec 003 line 44 + spec 001 line 116 |
| 3b canonical ingredient sets | Per-prep ingredient lists per `docs/internal/prep-canonicalness-notes.md`. **2AM SAUCE canonical (`66d823`) has 10 ingredients; Burger Patty canonical (`500ef2`) has 5; etc.** | Owner-curated notes |
| 4 per-prep matching/divergent split | **UNKNOWN** without probe execution. The owner notes only describe canonical ingredient sets, not orphan ingredient sets. Architect's best guess: most orphans are matching (Phase 2 dedup repointed equivalent rows; only divergence sources are pre-dedup quantity drift between stores like the Philly Cheesesteak case in dedup migration's comment). | n/a — must probe |
| 5 cross-brand | `1 brand` (`2a000000-...`) | Spec 001 line 102, Spec 003 line 28 |
| 6 recipe fan-out | unknown — informational only. Likely 10–30 distinct recipes (the affected preps include core sauces/seasonings used by many recipes). | n/a — must probe |
| 7 sub_recipe_id orphans | `0` | Spec 001 line 61 |

**Why item 4 is the central unknown.** Per-prep matching/divergent counts cannot be derived from schema or owner notes alone — they require comparing each of 399 orphan rows against the canonical's ingredient set. The probe SQL above does this in a single CTE; the developer's first build action is running it and pasting the result.

**Why the architect didn't request user-runs-probe-and-pastes-back during design.** The probe is computational and read-only. Spec 001's precedent is "architect runs probe, encodes literal counts in migration". Spec 003's directive is the same. The constraint here is purely tooling: this design pass had no shell tool. The migration design below is fully specified — only the literal expected counts in section 5's manifest need substitution before the developer commits the SQL.

### 3. Migration shape

**Filename:** `supabase/migrations/20260506000000_repoint_or_delete_ingredient_orphans.sql`

- Sorts after `20260505000000_dedupe_repointed_ingredient_lines.sql` (latest applied dedup migration). Required.
- Filename timestamp is **not load-bearing for ordering against any unapplied migration** — unlike Spec 001's `20260504235959` slot which had to sort before the dedup migration on Path B-original. Spec 003 always runs after dedup-is-live (the unique index `prep_recipe_ingredients_logical_unique` is in scope at apply time on every path).
- Atomic: `BEGIN; ... COMMIT;` wrapper. All 399 row mutations succeed or none do.
- Single `DO $$ ... $$` block carrying the control flow, mirroring Spec 001's pattern.
- Description string `repoint_or_delete_ingredient_orphans` — names the action and the divergent/matching split.

**Destructive vs additive.** Destructive: this migration both UPDATEs (repoint matching orphans) and DELETEs (divergent orphans). Per Q7 below, rollback is via `BEGIN/ROLLBACK` semantics during apply + per-prep diagnostic NOTICEs; no separate backout migration ships.

**Rollout safety.** Atomic transaction; counts asserted before mutating; per-prep counts asserted alongside grand total. Same shape as Spec 001 in spirit, scaled to a 10-row manifest.

### 4. Per-prep assertions — temp table of expectations

Using a **temp table of expectations** (`_spec003_expectations`) — not per-prep `DO` blocks (would balloon migration body to ~400 lines for 10 preps × 40 lines each), and not a generic `assert_eq` helper (would require a CREATE FUNCTION at the top of the migration that's only used once and then needs cleanup; over-engineered).

The temp table is created at the start of the count = expected branch, populated with the architect-certified expected counts, then joined against actual mutation counts at the assertion step. Output is a single `RAISE EXCEPTION` if any per-prep row mismatches, with the prep name and (expected, actual) counts in the error message.

Concretely (pseudocode — developer authors final SQL):

```
CREATE TEMP TABLE _spec003_expectations (
  prep_name             text PRIMARY KEY,
  expected_repoint_cnt  int  NOT NULL,
  expected_delete_cnt   int  NOT NULL,
  -- Optional convenience: total = repoint + delete; redundant but cheap.
  expected_total_cnt    int  GENERATED ALWAYS AS (expected_repoint_cnt + expected_delete_cnt) STORED
) ON COMMIT DROP;

INSERT INTO _spec003_expectations (prep_name, expected_repoint_cnt, expected_delete_cnt) VALUES
  ('2AM SAUCE',                    /* TBD repoint */, /* TBD delete */),
  ('House Special Seasoning Mix',  /* TBD */,         /* TBD */),
  ('Cajun Seasoning (House Mix)',  /* TBD */,         /* TBD */),
  ('White Sauce',                  /* TBD */,         /* TBD */),
  ('2AM Sauce',                    /* TBD */,         /* TBD */),
  ('Burger Patty',                 /* TBD */,         /* TBD */),
  ('Tumeric Mix',                  /* TBD */,         /* TBD */),
  ('Yellow Rice',                  /* TBD */,         /* TBD */),
  ('2AM SAUCE 10',                 /* TBD */,         /* TBD */),
  ('Tumeric Seasoning (House Mix)', /* TBD */,        /* TBD */);
```

The 10 prep names are the recorded set from Spec 001 line 116 / Spec 003 line 28. The developer substitutes the `/* TBD */` integers from the gate-4 probe output before committing. Grand-total expected count = `SUM(expected_total_cnt)` across the manifest, asserted to equal **399** (or whatever the gate-1 probe certifies).

**Note on prep_name uniqueness.** The PRIMARY KEY on `prep_name` works because the 10 names are distinct strings (variant-name policy = treat as separate). If the probe surfaces variant unification (FYI to user), the manifest would need `(prep_name, brand_id)` as a composite key — not anticipated, but flagged.

Diagnostic NOTICE on success (lessons-learned #2 from Spec 001 — neutral wording):

```
RAISE NOTICE 'Spec 003: cleared % orphans (% repointed, % deleted) across % preps',
  v_grand_total, v_grand_repointed, v_grand_deleted, v_prep_count;
```

Per-prep success NOTICEs are NOT emitted — too noisy for 10 preps. Only the grand-total summary fires on success. Per-prep diagnostics fire only on assertion failure.

### 5. Apply-path matrix

Spec 001's section 5b template, exercised for spec 003's data shape.

| Path | Starting state | Required end state |
|---|---|---|
| **A) `db push` to remote** | 399 orphan `prep_recipe_ingredients` rows, dedup index `prep_recipe_ingredients_logical_unique` already live. Remote already has Spec 001's `20260504235959_repoint_burger_patty_orphans.sql` applied — that migration touched `recipe_prep_items`, not `prep_recipe_ingredients`, so the orphans this spec targets are unaffected and remote DB state matches local seed. | 0 orphans, canonical preps' ingredient lists unchanged. Per-prep splits sum to 399. |
| **B) `db push` to a populated environment without dedup index** | n/a in practice. Dedup migration `20260505000000_*` is already applied on every populated environment as of 2026-05-06. The B-original analog from Spec 001 (populated-without-dedup) does not exist for spec 003. | n/a |
| **B-revised) Manual re-execute after `db reset --local`** | `db reset --local` runs migrations in order against empty DB (this migration exits as no-op via the count=0 branch), then loads `seed.sql`. Seed re-introduces 399 orphans. Developer manually re-executes via `psql`. Dedup index is live. | 0 orphans, same end-state as Path A. |
| **C) `db reset --local` (no manual re-execute)** | Empty DB at migration time → no-op; seed then loads 399 orphans. | 399 orphans persist (acknowledged structural limitation per AC9, mirrors Spec 001's Path C). |
| **D) Re-run after success** | 0 orphans visible. Count = 0 branch fires, no-op. | unchanged. |

**Differences vs Spec 001's matrix:**

1. **No Path B-original.** Spec 001's B-original (populated-without-dedup) was a real path because Spec 001's filename was `20260504235959`, sorting BEFORE the dedup migration on push paths where neither was applied. Spec 003's filename sorts AFTER all dedup migrations on every path. There is no "populated without spec 003's prerequisites" state.
2. **No external-canonical-collision branch.** Spec 001's Path A had a pre-existing canonical-pointing row to collide against. Spec 003's canonical preps already have clean (post-dedup) ingredient lists; the question is whether each ORPHAN's `(catalog_id, sub_recipe_id, type, unit, quantity)` tuple matches a canonical ingredient line. If it matches → repoint causes intra-update collision against the canonical's already-extant row → must DELETE the orphan instead. If it doesn't match → divergent → DELETE per Q1 anyway. **In other words: the matching/divergent split is the only branching, and BOTH branches reduce to either "delete the orphan" or "transparently UPDATE the orphan to a tuple that — by definition of `matching` — already exists on the canonical".**
3. **Critical insight:** under the resolved Q1, the migration's UPDATE branch would collide with the live unique index on EVERY matching row, because by definition a "matching" orphan has the same `(catalog_id, sub_recipe_id, type, unit)` tuple as an extant canonical row at the canonical's `prep_recipe_id`. Repointing the orphan onto canonical's `prep_recipe_id` produces a tuple `(canonical_prep_id, type, catalog_id, sub_recipe_id, unit)` that is **already present** on the canonical row. **The UPDATE collides immediately.**

   The fix: matching orphans must be **DELETED, not UPDATEd**. The user's resolved Q1 phrasing ("repoint matching") was semantically equivalent to "the canonical already has a matching row, so the orphan's content is preserved if we just delete it" — which is what's actually correct here. The migration ships TWO DELETE statements:
   - DELETE orphans whose ingredient tuple matches a canonical's tuple (the "repoint matching" outcome — semantically equivalent to repointing because the canonical already has the row).
   - DELETE orphans whose ingredient tuple diverges from any canonical tuple (the explicit "delete divergent" outcome).

   Both DELETEs are correct under the directive: "canonical's ingredient list is authoritative". After both DELETEs, the orphan source `prep_recipes` rows have zero `prep_recipe_ingredients` rows pointing at them (because both branches removed those rows), and the canonical preps are unchanged. **No UPDATE statement is issued at all.**

4. **Surface to user (anticipated).** The architect believes Q1's "repoint matching" was intended to mean "preserve the matching orphan's information, however that's expressed in SQL". Under the unique-index reality of `prep_recipe_ingredients_logical_unique`, that means DELETE-the-orphan-because-canonical-already-has-it, not UPDATE. The end-state is identical: canonical's ingredient list is authoritative, orphans are gone. **Flagged for user awareness in the handoff** — the migration's mutation surface is "DELETE-only", not "DELETE-or-UPDATE", which is a slight semantic shift from spec language. The end-state contract is preserved; the implementation is simpler.

   Alternative considered + rejected: a ROW_NUMBER survivor pattern that picks one orphan per `(canonical_prep_id, type, catalog_id, sub_recipe_id, unit)` group as the "winner" and UPDATEs it while DELETing siblings. This works ONLY when canonical has ZERO row at that tuple — but canonicals have full ingredient lists post-dedup, so canonical's row is always present. Survivor pattern produces zero "winners" and 399 DELETEs across two branches. Identical outcome to the "DELETE-only" design but more complex. Rejected on simplicity grounds.

### 6. DELETE branch design (the entire migration body)

**Per-orphan classification** is computed once into a temp table `_spec003_orphan_decisions`, then the two DELETE branches consume it. This mirrors Spec 001's `_spec001_orphan_decisions` pattern.

```
CREATE TEMP TABLE _spec003_orphan_decisions (
  orphan_id      uuid PRIMARY KEY,
  prep_name      text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('matching', 'divergent'))
) ON COMMIT DROP;

INSERT INTO _spec003_orphan_decisions (orphan_id, prep_name, classification)
WITH orphans AS (
  SELECT pri.id           AS orphan_id,
         pri.prep_recipe_id AS orphan_source_id,
         pr.name          AS prep_name,
         pr.brand_id      AS brand_id,
         pri.catalog_id,
         pri.sub_recipe_id,
         COALESCE(pri.type, 'raw') AS type,
         pri.unit,
         pri.quantity
    FROM public.prep_recipe_ingredients pri
    JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
   WHERE pr.is_current = false
),
canonicals AS (
  SELECT pri.prep_recipe_id AS canonical_id,
         pr.name           AS prep_name,
         pr.brand_id       AS brand_id,
         pri.catalog_id,
         pri.sub_recipe_id,
         COALESCE(pri.type, 'raw') AS type,
         pri.unit,
         pri.quantity
    FROM public.prep_recipe_ingredients pri
    JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
   WHERE pr.is_current = true
     AND pr.name IN (SELECT DISTINCT prep_name FROM orphans)
)
SELECT o.orphan_id,
       o.prep_name,
       CASE WHEN EXISTS (
         SELECT 1 FROM canonicals c
          WHERE c.prep_name    = o.prep_name
            AND c.brand_id     = o.brand_id
            AND c.catalog_id    IS NOT DISTINCT FROM o.catalog_id
            AND c.sub_recipe_id IS NOT DISTINCT FROM o.sub_recipe_id
            AND c.type          = o.type
            AND c.unit          IS NOT DISTINCT FROM o.unit
            AND c.quantity      IS NOT DISTINCT FROM o.quantity
       ) THEN 'matching' ELSE 'divergent' END
  FROM orphans o;

-- Now: total = 399, expected_repoint = SUM(matching), expected_delete = SUM(divergent).

-- Mutation 1: DELETE matching orphans (canonical already has the row).
DELETE FROM public.prep_recipe_ingredients
 WHERE id IN (SELECT orphan_id FROM _spec003_orphan_decisions WHERE classification = 'matching');
GET DIAGNOSTICS v_repointed_count = ROW_COUNT;
-- Note: we count this as "repointed" semantically — the orphan's information was
-- preserved via canonical's pre-existing equivalent row. Not lost, just relocated.

-- Mutation 2: DELETE divergent orphans (canonical's row is authoritative; orphan's
-- divergent content is discarded).
DELETE FROM public.prep_recipe_ingredients
 WHERE id IN (SELECT orphan_id FROM _spec003_orphan_decisions WHERE classification = 'divergent');
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

-- Grand-total assertion.
IF v_repointed_count + v_deleted_count <> v_grand_total_expected THEN
  RAISE EXCEPTION 'Spec 003: expected % total rows affected, got % repointed + % deleted = % — rolling back',
    v_grand_total_expected, v_repointed_count, v_deleted_count, v_repointed_count + v_deleted_count;
END IF;

-- Per-prep assertion.
PERFORM 1
  FROM _spec003_expectations e
  LEFT JOIN (
    SELECT prep_name,
           COUNT(*) FILTER (WHERE classification = 'matching')  AS actual_repoint_cnt,
           COUNT(*) FILTER (WHERE classification = 'divergent') AS actual_delete_cnt
      FROM _spec003_orphan_decisions
     GROUP BY prep_name
  ) actuals USING (prep_name)
 WHERE COALESCE(actuals.actual_repoint_cnt, 0) <> e.expected_repoint_cnt
    OR COALESCE(actuals.actual_delete_cnt, 0)  <> e.expected_delete_cnt
LIMIT 1;

IF FOUND THEN
  -- Diagnostic NOTICE per mismatched prep, then RAISE EXCEPTION.
  FOR r IN
    SELECT e.prep_name,
           e.expected_repoint_cnt,
           e.expected_delete_cnt,
           COALESCE(a.actual_repoint_cnt, 0) AS actual_repoint_cnt,
           COALESCE(a.actual_delete_cnt, 0)  AS actual_delete_cnt
      FROM _spec003_expectations e
      LEFT JOIN (
        SELECT prep_name,
               COUNT(*) FILTER (WHERE classification = 'matching')  AS actual_repoint_cnt,
               COUNT(*) FILTER (WHERE classification = 'divergent') AS actual_delete_cnt
          FROM _spec003_orphan_decisions
         GROUP BY prep_name
      ) a USING (prep_name)
     WHERE COALESCE(a.actual_repoint_cnt, 0) <> e.expected_repoint_cnt
        OR COALESCE(a.actual_delete_cnt, 0)  <> e.expected_delete_cnt
  LOOP
    RAISE NOTICE 'Spec 003: per-prep mismatch on "%": expected (% repoint, % delete), got (% repoint, % delete)',
      r.prep_name, r.expected_repoint_cnt, r.expected_delete_cnt,
      r.actual_repoint_cnt, r.actual_delete_cnt;
  END LOOP;
  RAISE EXCEPTION 'Spec 003: per-prep affected-count assertion failed — rolling back';
END IF;
```

**Why DELETE-only is correct semantically.** Per Q1 directive: "Canonical's ingredient list is authoritative." Both branches preserve that:
- **Matching:** orphan's tuple is byte-equivalent to a canonical row's tuple. Deleting the orphan loses no information — canonical retains the equivalent row. Catalog payloads from `pwa-catalog` are unchanged.
- **Divergent:** orphan's tuple differs from canonical. Per directive, divergent content is discarded. Canonical's row stands. Catalog payloads are unchanged on the canonical side. The recipe ingredient list "shifts" only when a downstream consumer was previously rendering the orphan side (which `pwa-catalog` doesn't, because of `is_current = true` filter — see section 9).

**Would the canonical's ingredient list shift if any DELETE is wrong?** No. Both DELETEs target only orphan rows (rows whose `prep_recipe_id` is non-current). Canonical preps' ingredient lines have `prep_recipe_id` = a current prep, so they are never in `_spec003_orphan_decisions` and never deleted. The canonical's pre-migration ingredient list = post-migration ingredient list, byte-identical. **Verified by the data invariant AC** (re-running gate 1 returns 0 orphans, and the canonical's ingredient set is unchanged because the migration touches no current prep's rows).

**Concurrent writes / RLS / superuser apply.** Same as Spec 001:
- Migration applies as `postgres` superuser via `supabase db push` / `db reset` — RLS bypassed.
- The DELETEs touch no store-scoped column; brand-id is implicit via the `prep_recipes` join.
- No `WITH CHECK` violation under any policy chain (DELETEs don't trigger `WITH CHECK`).
- The hardening migration `20260504173035_per_store_rls_hardening.sql` does not list `prep_recipe_ingredients` directly; auditor must enumerate `pg_policy` rows for `public.prep_recipe_ingredients` and confirm no policy rejects superuser DELETE. Same shape as Spec 001's section 4.

### 7. Apply-time control flow (full DO-block sketch)

The `DO $$ ... $$` block follows Spec 001's count-first-then-mutate pattern, scaled to the 10-prep manifest.

```
BEGIN;

DO $$
DECLARE
  v_brand_id              constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_grand_total_expected  constant int  := 399;  -- developer substitutes from probe gate 1
  v_orphan_count          int;
  v_repointed_count       int;
  v_deleted_count         int;
  r                       record;
BEGIN

  -- 1. Count orphans first (Spec 001 lessons learned: count before canonical lookup).
  SELECT COUNT(*) INTO v_orphan_count
    FROM public.prep_recipe_ingredients pri
    JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
   WHERE pr.is_current = false;

  IF v_orphan_count = 0 THEN
    RAISE NOTICE 'Spec 003: no-op (no orphans found — pre-seed apply OR already repaired)';

  ELSIF v_orphan_count = v_grand_total_expected THEN
    -- 2. Apply-context sanity check: if non-current preps are visible at expected
    --    count, current preps for the affected names must also be visible
    --    (defends against partial-RLS-hiding silent no-op).
    IF NOT EXISTS (
      SELECT 1
        FROM public.prep_recipes
       WHERE is_current = true
         AND brand_id = v_brand_id
         AND name IN (
           '2AM SAUCE', 'House Special Seasoning Mix',
           'Cajun Seasoning (House Mix)', 'White Sauce',
           '2AM Sauce', 'Burger Patty', 'Tumeric Mix',
           'Yellow Rice', '2AM SAUCE 10', 'Tumeric Seasoning (House Mix)'
         )
       HAVING COUNT(*) >= 10  -- adjust if probe surfaces a different N
    ) THEN
      RAISE EXCEPTION 'Spec 003: % orphans visible but canonical preps not all visible — restricted apply context?',
        v_orphan_count;
    END IF;

    -- 3. Build the expectations manifest (literal values from architect's probe).
    CREATE TEMP TABLE _spec003_expectations (
      prep_name             text PRIMARY KEY,
      expected_repoint_cnt  int  NOT NULL,
      expected_delete_cnt   int  NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO _spec003_expectations VALUES
      -- Developer substitutes from probe gate 4. Sum of repoint+delete per row
      -- = orphan_rows from gate 1c. Sum across all rows = v_grand_total_expected.
      ('2AM SAUCE',                     /* TBD */, /* TBD */),
      ('House Special Seasoning Mix',   /* TBD */, /* TBD */),
      ('Cajun Seasoning (House Mix)',   /* TBD */, /* TBD */),
      ('White Sauce',                   /* TBD */, /* TBD */),
      ('2AM Sauce',                     /* TBD */, /* TBD */),
      ('Burger Patty',                  /* TBD */, /* TBD */),
      ('Tumeric Mix',                   /* TBD */, /* TBD */),
      ('Yellow Rice',                   /* TBD */, /* TBD */),
      ('2AM SAUCE 10',                  /* TBD */, /* TBD */),
      ('Tumeric Seasoning (House Mix)', /* TBD */, /* TBD */);

    -- 4. Classify orphans (per section 6 SQL).
    CREATE TEMP TABLE _spec003_orphan_decisions (
      orphan_id      uuid PRIMARY KEY,
      prep_name      text NOT NULL,
      classification text NOT NULL CHECK (classification IN ('matching', 'divergent'))
    ) ON COMMIT DROP;

    INSERT INTO _spec003_orphan_decisions ...; -- per section 6

    -- 5. Two DELETEs (matching first, then divergent — order doesn't matter
    --    correctness-wise, only diagnostic clarity).
    DELETE FROM public.prep_recipe_ingredients
     WHERE id IN (SELECT orphan_id FROM _spec003_orphan_decisions WHERE classification = 'matching');
    GET DIAGNOSTICS v_repointed_count = ROW_COUNT;

    DELETE FROM public.prep_recipe_ingredients
     WHERE id IN (SELECT orphan_id FROM _spec003_orphan_decisions WHERE classification = 'divergent');
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- 6. Grand-total assertion.
    IF v_repointed_count + v_deleted_count <> v_grand_total_expected THEN
      RAISE EXCEPTION 'Spec 003: expected % total rows affected, got % repointed + % deleted = %',
        v_grand_total_expected, v_repointed_count, v_deleted_count,
        v_repointed_count + v_deleted_count;
    END IF;

    -- 7. Per-prep assertion (per section 6 PERFORM + LOOP).
    -- ... emits NOTICE per mismatch, then RAISE EXCEPTION ...

    RAISE NOTICE 'Spec 003: cleared % orphans (% matching-deduped, % divergent-discarded) across 10 preps',
      v_repointed_count + v_deleted_count, v_repointed_count, v_deleted_count;

  ELSE
    RAISE EXCEPTION
      'Spec 003: unexpected orphan count % (expected 0 or %) — aborting',
      v_orphan_count, v_grand_total_expected;
  END IF;

END
$$;

COMMIT;
```

### 8. AC mapping

Every spec 003 acceptance criterion mapped to a verification step.

| AC (spec line) | Maps to | Verification |
|---|---|---|
| Migration filename + naming convention (line 75) | Section 3 (`20260506000000_repoint_or_delete_ingredient_orphans.sql`) | File exists at expected path, sorts after `20260505000000_*` |
| `BEGIN/COMMIT` wrapper (line 76) | Section 7 sketch | grep migration body for `BEGIN;` and `COMMIT;` |
| Canonical lookup contract — exactly 1 current row per name (line 77) | Section 7 step 2 (apply-context sanity) + probe gate item 2 | If probe gate 2 ≠ 1 for any name, build STOPS before migration is authored |
| "Delete divergent, repoint matching" strategy (line 78) | Section 5–6 (DELETE-only design with matching/divergent split) | Migration body matches the section 6 sketch shape |
| Grand-total count assertion (line 79–82) | Section 7 step 6 | `RAISE EXCEPTION` if `v_repointed_count + v_deleted_count <> 399` |
| Per-prep affected-count assertions (line 83) | Section 7 step 7 | `_spec003_expectations` LEFT JOIN against actuals; `RAISE EXCEPTION` on any mismatch with diagnostic NOTICEs |
| No DB-level constraint guard (line 84) | Section 3 ("destructive vs additive") + section 11 below | Migration body does not declare any `CREATE INDEX`, `CREATE TRIGGER`, `ALTER TABLE ... ADD CONSTRAINT`. Architect's recommended follow-up is a separate spec, not bundled |
| Variant-name groupings reported, not unified (line 85) | Probe gate 3 + 3b output captured in Probe results | Developer pastes gate 3 output; if same-prep evidence surfaces, build STOPS for user direction |
| Post-apply orphan-count probe = 0 (line 86) | Section 9 verification protocol | Re-run gate 1 SQL post-apply; expect `total_orphans = 0` |
| `db reset --local` no-op (line 87) | Section 5 Path C | NOTICE captured: `Spec 003: no-op (no orphans found...)`; post-seed gate 1 returns 399 (acknowledged limitation, mirrors Spec 001 AC6) |
| Data invariant — every `prep_recipe_id` in `prep_recipe_ingredients` resolves to current prep (line 88) | Section 9 SQL probe | `SELECT COUNT(*) FROM prep_recipe_ingredients pri LEFT JOIN prep_recipes pr ON pr.id = pri.prep_recipe_id WHERE pr.id IS NULL OR pr.is_current = false` returns 0 |
| HTTP path through `pwa-catalog` (line 89) | Section 9 — architect's call: **NOT included as a strict AC** | Rationale: under DELETE-only design, canonical preps' `ingredients[]` arrays in the catalog payload are byte-identical pre/post migration. The migration mutates only orphan rows that are NEVER emitted by `pwa-catalog` (which filters to `is_current = true`). Spec 001 AC7b had a meaningful HTTP-path assertion because the `recipe_prep_items` UPDATE changed which `prep_recipes[]` entry the cheeseburger references; spec 003's mutation is invisible to `pwa-catalog` by construction. **Optional regression smoke**: still run `curl pwa-catalog?store_id=<towson>` post-migration; payload should be byte-identical to pre-migration capture. Documented in section 9 as a non-blocking smoke check. |
| Sub-recipe column regression check (line 90) | Probe gate 7 | If gate 7 returns non-zero, build STOPS for user direction |
| Security-auditor RLS review (line 91) | Section 10 | Auditor enumerates `pg_policy WHERE polrelid = 'public.prep_recipe_ingredients'::regclass`; confirms no policy rejects superuser DELETE; confirms no `WITH CHECK` invariant applicable to DELETE |
| Backend-architect convention review (line 92) | This `## Backend design` section serves as the design contract; post-impl review will check that the migration matches the contract | Architect post-impl review per Spec 001 precedent (filed under `specs/003-prep-recipe-ingredients-orphans/reviews/backend-architect.md`) |

**Note on AC7b-equivalent.** Spec 001's HTTP-path AC was the project's first retroactively-verified AC (post-Spec 002 bind-mount fix). Spec 003 does NOT need the equivalent because the mutation surface is invisible to `pwa-catalog` payloads. Including it would test serialization machinery, not this spec's data contract. The optional smoke check (section 9) covers regression detection without making it a blocking AC.

### 9. Verification protocol

Maps 1-to-1 to the spec's acceptance criteria. Run in order; ALL must pass.

**Pre-build (developer's first action, before authoring the migration):**
1. Run probe SQL from section 1 against local DB. Paste output into Probe results checklist.
2. Run probe SQL against remote (`npx supabase db query --linked < probe.sql`). Compare to local; STOP on divergence.
3. STOP on any of: cross-brand orphans, variant-name same-prep evidence, sub_recipe_id orphan regression, canonical-current count != 1, all-zero divergent counts.
4. Substitute architect-certified per-prep counts into the `_spec003_expectations` INSERT in the migration body. Substitute grand total into `v_grand_total_expected`.

**During apply (`docker exec ... psql < migration.sql`):**
- NOTICE captured: `Spec 003: cleared 399 orphans (X matching-deduped, Y divergent-discarded) across 10 preps`. Or: `no-op (no orphans found...)` if already repaired or pre-seed.

**Post-apply (developer + test-engineer reviewer):**

1. **Orphan count = 0.** Re-run probe gate 1:
   ```sql
   SELECT COUNT(*) FROM prep_recipe_ingredients pri
     LEFT JOIN prep_recipes pr ON pr.id = pri.prep_recipe_id
    WHERE pr.id IS NULL OR pr.is_current = false;
   ```
   Expected: `0`.

2. **Data invariant.** Re-run gate 1 + gate 7 — both return 0.

3. **Canonical preps unchanged.** Capture canonical ingredient lists pre- and post-migration:
   ```sql
   SELECT pr.name,
          array_agg(jsonb_build_object(
            'catalog_id',    pri.catalog_id,
            'sub_recipe_id', pri.sub_recipe_id,
            'type',          COALESCE(pri.type, 'raw'),
            'unit',          pri.unit,
            'quantity',      pri.quantity
          ) ORDER BY pri.id) AS ingredients
     FROM prep_recipes pr
     JOIN prep_recipe_ingredients pri ON pri.prep_recipe_id = pr.id
    WHERE pr.is_current = true
      AND pr.name IN ('2AM SAUCE', 'House Special Seasoning Mix', 'Cajun Seasoning (House Mix)',
                      'White Sauce', '2AM Sauce', 'Burger Patty', 'Tumeric Mix', 'Yellow Rice',
                      '2AM SAUCE 10', 'Tumeric Seasoning (House Mix)')
    GROUP BY pr.name
    ORDER BY pr.name;
   ```
   Expected: pre-migration capture = post-migration capture, byte-identical.

4. **`pwa-catalog` regression smoke (non-blocking).** Pre-migration:
   ```bash
   STORE_ID=$(docker exec ... psql -tAc "select id from public.stores where name ilike 'towson%' limit 1;")
   curl -sS "http://127.0.0.1:54321/functions/v1/pwa-catalog?store_id=$STORE_ID" \
     -H "Authorization: Bearer $PWA_SERVICE_TOKEN" > /tmp/pre.json
   ```
   Post-migration:
   ```bash
   curl -sS "http://127.0.0.1:54321/functions/v1/pwa-catalog?store_id=$STORE_ID" \
     -H "Authorization: Bearer $PWA_SERVICE_TOKEN" > /tmp/post.json
   diff <(jq -S . /tmp/pre.json) <(jq -S . /tmp/post.json)
   ```
   Expected: empty diff (canonical-side ingredient lists unchanged). If the diff is non-empty, surface to user — should never happen under DELETE-only design unless the architect's matching/divergent classification predicate is wrong.

5. **Per Spec 002's bind-mount cure:** if local edge runtime is in a clean post-cure state (per Spec 002's resolved bind-mount fix), the smoke step 4 above just works. If not, surface to user (out of scope here).

### 10. RLS impact + security-auditor scope

**Tables touched.** `prep_recipe_ingredients` only. (DELETE × 2.)

**RLS policies the auditor must enumerate.** Per `supabase/migrations/20260504173035_per_store_rls_hardening.sql`, the hardening covers a specific list of tables (`inventory_items`, `eod_*`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`) that does NOT include `prep_recipe_ingredients`. The brand-catalog refactor migrations (P1/P2/P3/P5 dated 2026-05-04) likely defined `prep_recipe_ingredients` policies separately. Auditor must:
1. `SELECT polname, polcmd, polqual, polwithcheck FROM pg_policy WHERE polrelid = 'public.prep_recipe_ingredients'::regclass;` against local + remote.
2. Confirm no `DELETE` policy rejects superuser context (it can't — `postgres` bypasses RLS — but document the assumption per Spec 001 precedent).
3. Confirm no `WITH CHECK` invariant applies to DELETE (it can't — `WITH CHECK` only fires on INSERT/UPDATE).
4. Confirm no per-store invariant is violated by removing rows from a brand-scoped table. Brand `2a000000-...` is the only affected brand (probe gate 5 confirms); deletions reduce the row population without altering any remaining row's brand membership.

**Helper-function impact.** None. `auth_can_see_store(store_id)` and `auth_is_admin()` are not invoked by the migration (it runs as `postgres`).

**No new policies introduced.** No helper-function changes.

**Same superuser-only apply assumption as Spec 001.** Auditor must re-confirm no non-superuser path can invoke this migration body — the same `EXECUTE` audit Spec 001's auditor performed on `src/lib/db.ts` and `supabase/functions/**/*.ts` (Spec 001 line 610) applies verbatim here.

### 11. Risk / blast radius

- **Apply-context fragility under restricted RLS.** Same residual hole as Spec 001 section 7. The count = 0 branch covers both "already repaired" and "pre-seed apply" — RLS hiding all `prep_recipe_ingredients` rows from a non-superuser would silently no-op a broken environment. Mitigation: superuser-only apply per "Project-specific notes". The apply-context sanity check in section 7 step 2 ("if 399 orphans visible, canonical preps must be visible") catches partial-RLS-hiding for the count = expected branch only.

- **Per-prep assertion failure recoverability.** `BEGIN/ROLLBACK` semantics mean any per-prep mismatch rolls back the entire migration. The diagnostic NOTICE LOOP names which prep diverged with (expected, actual) tuples. Operator can re-probe to understand the shift, update the manifest, re-apply. Spec 001's failure mode at `(deleted + updated) != 4` was the same shape; this scales it to per-prep granularity. **No partial state left in the DB on failure.**

- **Manifest staleness between architect probe and developer apply.** Worst case: the seed.sql was reloaded mid-build with new orphan counts, and the manifest's hardcoded values no longer match. The strict per-prep assertion catches this loudly. Operator re-probes, updates manifest, re-applies. Same protection Spec 001 had on `4`.

- **Performance.** 399 rows × 2 DELETEs is sub-millisecond. The classification CTE involves an EXISTS subquery against `canonicals` (the canonical preps' ~65 current ingredient lines per dedup migration's expected count). EXISTS is index-backed via `prep_recipe_ingredients_logical_unique`. No index changes warranted.

- **Edge function cold-start.** N/A — migration touches no edge functions.

- **Concurrent writes during apply.** Standard migration safety. The DELETE row locks plus the BEGIN/COMMIT wrapper make the count-then-mutate sequence safe against another writer in the same brand. Migration applies in low-traffic window.

- **Realtime publication membership.** Spec 003 does NOT change `supabase_realtime` publication membership. The publication-membership gotcha (`docker restart supabase_realtime_imr-inventory` after a publication change) **DOES NOT APPLY** here. Per project memory `memory/project_realtime_publication_gotcha.md`. **Re-stated explicitly:** the developer must NOT add `prep_recipe_ingredients` to the publication as part of this fix; that's an unrelated change. If the user later wants admin clients to auto-reload on `prep_recipe_ingredients` changes, that's a separate hook + publication change in `src/hooks/useRealtimeSync.ts` + a publication ALTER + a docker restart on dev — out of scope for spec 003.

- **Sibling-table contagion (out of scope, surfaced for awareness).** Spec 001 fixed `recipe_prep_items` (4 rows). Spec 003 fixes `prep_recipe_ingredients` (399 rows). After spec 003 ships, the only known sibling-orphan tail is the 52 non-current `prep_recipes` rows themselves (now unreferenced by both `recipe_prep_items` and `prep_recipe_ingredients`). User has explicitly out-of-scoped deleting those (spec 003 line 133). A future spec 004-deletion could clean them up; the architect recommends doing so eventually because they're confusing in the admin UI, but this is a soft suggestion not a build blocker.

- **Variant-name unification (deferred).** `2AM SAUCE` / `2AM Sauce` / `2AM SAUCE 10` are treated as separate by user policy. If the probe surfaces same-prep evidence, build stops for user direction. If user later wants unification, that's a separate spec — repointing on `name`, not on `id`, with a different mutation surface.

- **`pwa-catalog` regression risk.** The DELETE-only design is provably orthogonal to `pwa-catalog`'s output (the function filters `is_current = true` and only emits canonical preps' ingredient lines, which are not in scope for any DELETE). The smoke check in section 9 step 4 catches any regression should the architect's classification predicate be subtly wrong. This is the only meaningful semantic risk in the entire migration.

### 12. Q4–Q7 resolution (deferred questions from spec)

- **Q4 — Cross-brand check.** Resolved by probe gate 5. Anticipated: 1 brand only (`2a000000-...`). Build STOPS if probe surfaces > 1 brand.

- **Q5 — Sub-recipe regression.** Resolved by probe gate 7. Anticipated: 0 orphans. Build STOPS if probe surfaces non-zero.

- **Q6 — Seed.sql divergence local vs remote.** Resolved by running probe on both (section 9 pre-build steps 1 + 2). Anticipated: identical. Build STOPS on divergence. **Note:** spec 003 does NOT need to handle a Path A vs Path B-revised divergence at the migration design level — the migration is shape-invariant under both because the dedup index is live everywhere and the DELETE-only design has no UPDATE-side collision branches. Local and remote are expected to behave identically.

- **Q7 — Backout / reversal plan.** Architect's call: **`BEGIN/ROLLBACK` semantics + per-prep diagnostic NOTICEs are sufficient. No separate backout migration ships.** Rationale:
  - Within-transaction rollback covers any apply-time failure (every assertion path RAISEs and rolls back).
  - Post-commit reversal would be needed only if a later discovery proves the matching/divergent classification was wrong. At that point, the orphan source rows' content is gone — but it was ALSO available in the `_spec003_orphan_decisions` temp table only during the transaction. A snapshot-based backout (capturing pre-mutation orphan content into a sidecar permanent table) would let post-commit reversal re-INSERT specific orphan rows. This is structurally feasible but: (a) the seed.sql still contains the original orphans for local reproducibility; (b) remote prod's pre-migration state is captured in supabase's automatic point-in-time recovery (PITR) backups for any reasonable time window; (c) at 399 rows, the cost of designing/testing/maintaining a sidecar table mechanism is higher than the cost of a `supabase db query --linked` re-run from a PITR snapshot if absolutely needed.
  - **The DELETE branch makes pure UPDATE-inverse reversal lossy** (correctly noted in spec line 156). A snapshot is the only complete inverse, and PITR + seed.sql jointly already provide it.
  - **Trade-off accepted.** If the user later decides post-commit reversal is required (e.g., the matching/divergent predicate proves wrong on a non-trivial subset), the recovery path is: (i) restore from PITR if remote, OR (ii) `supabase db reset --local` if local, then re-design and re-apply spec 003 with corrected logic. This is acceptable at 399 rows.

### 13. `src/lib/db.ts` surface, frontend store, edge function changes — none

- **`src/lib/db.ts`:** no helper changes. The migration is server-side data repair only. Same as Spec 001 section 8.
- **`src/store/useStore.ts`:** no slice changes. No optimistic-then-revert (no client-initiated write).
- **Edge functions:** no changes. `pwa-catalog`'s `verify_jwt = false` + service-token validation strategy is unchanged. Used for optional regression smoke only.
- **`src/screens/cmd/sections/`:** no changes.
- **Legacy paths (`src/screens/AdminScreens.tsx`, `src/store/useSupabaseStore.ts`, `src/store/useJsonServerSync.ts`, `db.json`, `npm run db`):** explicitly NOT touched per CLAUDE.md.

### 14. Architect's recommended follow-up: Spec 004 (constraint guard)

**Per Q2's "architect may file as separate spec recommendation in handoff":** the architect believes a DB-level guard against future drift IS warranted, but as a **separate spec 004**, not bundled into spec 003.

The shape of the recommended guard:
- **Trigger** on `prep_recipe_ingredients` BEFORE INSERT/UPDATE that asserts `prep_recipe_id` references a `prep_recipes` row with `is_current = true`. Raises if the row is non-current. Permits NULL `prep_recipe_id` only if the column allows it (it doesn't — schema declares it FK but nullable; trigger should match column nullability).
- **Alternative:** partial unique index on `(prep_recipe_id) WHERE prep_recipe_id IN (SELECT id FROM prep_recipes WHERE is_current = false)` would prevent INSERTs at the index level — but this requires either an immutable function in the WHERE clause (Postgres rejects) or a generated column tracking `is_current`, both more invasive than a trigger. Trigger is simpler.
- **Risk:** the brand-catalog refactor's `is_current = false` rows might still need to be SELECTABLE for version-history UI (per `20260504062318_brand_catalog_p2_backfill.sql` line 121–122 comment "Old versions are kept as-is — they're version history"). The trigger gates writes only, not reads, so this is fine.

**Why NOT bundled into spec 003:**
- Per Q2 directive: "data fix only".
- A guard is structural (changes the table's mutation contract); spec 003 is a one-shot data repair. Separate concerns, separate review surface.
- If the guard fires unexpectedly during the spec 003 migration (e.g., for some reason the migration tries to INSERT — it doesn't, but defensively), the guard would block the spec 003 fix itself. Decoupling avoids this trap.

**Filed as recommendation in the handoff payload.** Not a build blocker for spec 003.


## Build notes

Recorded by backend-developer 2026-05-06 at build start. **Build halted at probe stage — no migration authored, no apply attempted, no remote push attempted.** Three of the six architect-prescribed build-stop conditions triggered. Surfacing to user for direction per the design's section 0 step 3 mandate.

### Status of the six build-stop conditions

| Condition | Triggered? | Detail |
|---|---|---|
| Cross-brand orphans | No | Gate 5: 1 brand only (`2a000000-...`). |
| Variant same-prep evidence | **YES** | Gate 3 + spot-check: `2AM Sauce` and `2AM SAUCE` have near-identical ingredient sets across multiple non-current rows (only `gal` vs `fl_oz` unit drift on two ingredients). Strong same-prep evidence per spec line 100/218. |
| `sub_recipe_id` orphan regression | No | Gate 7: 0 dangling, 0 non-current. Matches Spec 001 finding. |
| Per-prep canonical-current count != 1 | **YES (severe)** | Gate 2: 4 of 10 affected prep names have ZERO canonical-current rows: `2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`, `Tumeric Mix`. The migration's "exactly one current row per affected name" contract (AC line 77) cannot hold. Affected orphan count: 30 + 10 + 56 + 20 = **116 of 399 rows** (~29%) have no canonical to repoint to / dedupe against. |
| All-zero divergent counts everywhere | n/a | Gate 4 produced a non-zero divergent column for several names, but its results are unreliable for the 4 names with no canonical (they default to `divergent` because the canonical set is empty). FYI condition does not apply. |
| Local-vs-remote divergence (architect's section 0 step 2 directive) | **YES** | Local gate 1 grand-total = **399**. Remote gate 1 grand-total = **405**. +6 row drift on remote vs local. (Only the gate 1 query was run against remote; permission for further remote queries was denied. The +6 delta cannot be attributed to a specific prep without the per-name probe on remote, which requires user authorization.) |

### Raw probe output (local)

Source: `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < /tmp/spec003-probe.sql` on 2026-05-06.

```
gate_1_grand_total:    dangling=0, non_current=399, total_orphans=399
gate_1b_distinct_sources: distinct_non_current_sources=52
gate_1c_per_name (10 rows):
  2AM SAUCE                     | 150 orphans | 15 source rows
  House Special Seasoning Mix   |  56 orphans |  8 source rows
  Cajun Seasoning (House Mix)   |  48 orphans |  8 source rows
  White Sauce                   |  36 orphans |  4 source rows
  2AM Sauce                     |  30 orphans |  3 source rows
  Burger Patty                  |  28 orphans |  4 source rows
  Tumeric Mix                   |  20 orphans |  4 source rows
  Yellow Rice                   |  16 orphans |  4 source rows
  2AM SAUCE 10                  |  10 orphans |  1 source row
  Tumeric Seasoning (House Mix) |   5 orphans |  1 source row
gate_2_canonical_per_name (10 rows):
  2AM SAUCE                     | canonical_current_count=1 | id=66d823bb-bad0-4f3e-9dd3-3ab378372cc4
  Burger Patty                  | canonical_current_count=1 | id=500ef28d-3288-4fb8-accb-c3708d1491f9
  Cajun Seasoning (House Mix)   | canonical_current_count=1 | id=5d6a0ea2-d4cd-4b3c-88ff-080a2eceb382
  Tumeric Seasoning (House Mix) | canonical_current_count=1 | id=c7d9a94b-cf30-4bb7-9b2b-c2577ae7a10a
  White Sauce                   | canonical_current_count=1 | id=8782cf2d-6bfc-4639-b95d-54ff0f8c3ef1
  Yellow Rice                   | canonical_current_count=1 | id=fb1e76b4-f8f2-40bb-ae1b-faf6534dfbf5
  2AM Sauce                     | canonical_current_count=0 | (none)            <-- STOP
  2AM SAUCE 10                  | canonical_current_count=0 | (none)            <-- STOP
  House Special Seasoning Mix   | canonical_current_count=0 | (none)            <-- STOP
  Tumeric Mix                   | canonical_current_count=0 | (none)            <-- STOP
gate_3_variants:
  2am sauce | distinct_cased=[2AM Sauce, 2AM SAUCE] | variant_count=2
gate_4_per_prep_split (10 rows):
  prep                          | repoint | delete | total
  2AM SAUCE                     |   123   |   27   |  150
  House Special Seasoning Mix   |     0   |   56   |   56  <-- 0 repoint because no canonical
  Cajun Seasoning (House Mix)   |    44   |    4   |   48
  White Sauce                   |    24   |   12   |   36
  2AM Sauce                     |     0   |   30   |   30  <-- 0 repoint because no canonical
  Burger Patty                  |    20   |    8   |   28
  Tumeric Mix                   |     0   |   20   |   20  <-- 0 repoint because no canonical
  Yellow Rice                   |    16   |    0   |   16
  2AM SAUCE 10                  |     0   |   10   |   10  <-- 0 repoint because no canonical
  Tumeric Seasoning (House Mix) |     5   |    0   |    5
gate_5_cross_brand: distinct_brands=1, brand_ids=[2a000000-0000-0000-0000-000000000001]
gate_6_recipe_fanout: distinct_recipes_affected=15
gate_7_sub_recipe_orphans: dangling=0, non_current=0, total_orphans=0
```

### Raw probe output (remote)

Source: `npx supabase db query --linked < /tmp/spec003-gate1.sql` on 2026-05-06. Only gate 1 was run; further remote queries were denied permission.

```
gate_1_grand_total: dangling=0, non_current=405, total_orphans=405
```

### Divergence vs architect's anticipated values (section 2 of design)

| Gate | Architect anticipated | Local actual | Match? |
|---|---|---|---|
| 1 grand total | 399 | 399 | yes (local) |
| 1 grand total (remote) | 399 (assumed parity) | 405 | **no — +6 drift** |
| 1b distinct sources | 52 | 52 | yes |
| 1c per-name breakdown | 10 names per spec table | 10 names matching the table | yes |
| 2 canonical-current per name | 1 for each of 10 names | 1 for 6 names; 0 for 4 names | **no — 4-of-10 violation** |
| 3 variant groupings | `[2AM SAUCE, 2AM Sauce, 2AM SAUCE 10]` (3 distinct) | `[2AM Sauce, 2AM SAUCE]` (2 distinct) — `2AM SAUCE 10` is uppercased and thus does not collapse with the others under `lower()`. | partial — 2 grouped, not 3 |
| 4 per-prep split | "most matching, divergent rare" | mixed: some preps 0% repoint, others ~80% repoint | **divergent** |
| 5 cross-brand | 1 brand | 1 brand | yes |
| 6 recipe fan-out | "10–30 distinct recipes" | 15 | yes |
| 7 sub_recipe orphans | 0 | 0 | yes |

### Same-prep evidence: spot-check between `2AM Sauce` and `2AM SAUCE`

Per design section 0 step 3 ("Same-prep evidence across variant names ... STOP and surface"), the developer ran a spot-check comparing ingredient sets between the canonical `2AM SAUCE` (`66d823`) and several non-current `2AM Sauce` rows (`09d5c5...`, `8b875d...`, `b1fb2a...`):

- Both share 8 ingredients at byte-identical `(catalog_id, type, unit, quantity)` tuples (Sugar, Parsley Flake, Mayonnaise, Worcestershire, Mustard, Ketchup, Horseradish, Garlic Granulated, Paprika).
- The canonical `2AM SAUCE` has TWO ingredients the `2AM Sauce` rows do not (`Cajun Seasoning prep` 8 oz, `Sugar` redundancy in `oz` vs the variant's normalization).
- The `2AM Sauce` rows have ONE ingredient the canonical does not (`Cajun Spice & Skillet` `090008` 8 oz — appears to be the raw equivalent of the canonical's prep reference).
- Conclusion: these are **the same conceptual prep** ("2AM Sauce" recipe), with the variant pre-dating a refactor that swapped the raw `Cajun Spice & Skillet` for the prep `Cajun Seasoning (House Mix)`. They are not separate preps in any meaningful business sense.

This is the strong same-prep evidence the spec contemplated at line 100. Per the spec's resolution policy, this triggers a surface-to-user requirement before continuing.

### Implication for migration design

The current migration design (architect's section 6/7 sketch) cannot proceed unchanged because:

1. **The `_spec003_expectations` manifest** assumes 10 prep names each with exactly 1 canonical. For 4 of the 10, there is no canonical at all. The migration would either need to (a) treat those 4 names as "delete-all" (i.e., the orphans have no surviving authoritative version anywhere), or (b) treat them as same-prep variants of one of the 6 names that DO have a canonical, or (c) be deferred until owner curation establishes a canonical.

2. **The same-prep variant evidence** for `2AM Sauce` ↔ `2AM SAUCE` means the user policy of "treat as separate" should be revisited. If they ARE the same prep, the 30 orphan rows under `2AM Sauce` should attach to the `2AM SAUCE` canonical (`66d823`) — but the predicate the design uses is `(name, brand_id)` exact-match, which does not collapse `Sauce` with `SAUCE`.

3. **Remote +6 row drift.** Local seed was pulled from prod on 2026-05-02 (per project memory). Today is 2026-05-06. Either remote has had 6 new orphans introduced since then, or local has had 6 fewer — either way, the manifest counts cannot be authoritative until the source of the divergence is explained. Architect's section 0 step 2 says STOP on this divergence.

### Filename decision (architect vs amendment)

Both the architect's suggested name (`20260506000000_repoint_or_delete_ingredient_orphans.sql`) and the amended name (`20260506000000_delete_orphan_ingredient_lines.sql`) are moot at this stage — no migration is being authored. When the spec is unblocked, either name is acceptable; the developer's assistant should default to the amended name (DELETE-only is honest about what the migration does, per the architect's section 5 finding that no UPDATE is issued).

### Verification protocol output

n/a — no migration applied. Local DB is unchanged. Remote DB is unchanged. No `supabase db push`, no `supabase db reset --local`, no `psql` write was executed.

### Remote-push status

**PENDING USER AUTHORIZATION — surfacing for explicit confirmation.** Per amendment 1 in the developer brief, no remote push will be attempted without explicit user authorization. In addition, no remote push will be attempted without first resolving the build-stop conditions above.

### Recommended user direction (FYI to PM, not a decision)

The shape of the resolution is owner-knowledge-dependent and cannot be derived from data. Likely paths the user might pick (in increasing order of architectural change):

1. **Owner curates the 4 missing canonicals** by manually setting `is_current = true` on a chosen non-current row per missing name, OR by inserting fresh canonical rows. Then re-run the probe and proceed with build.
2. **Variant unification** (in particular, treating `2AM Sauce`'s 30 orphans as same-prep with `2AM SAUCE`'s canonical, and ditto for any other variant pairs the owner identifies). Spec 003 was explicit that this is OUT OF SCOPE for this spec; would need an explicit user override or a separate spec.
3. **Scope-narrow spec 003** to only the 6 prep names with a canonical (= 283 of 399 orphan rows; the other 116 are deferred to a future spec).
4. **Defer spec 003 entirely** until a separate canonical-curation spec / owner pass clears the gate-2 violations.
5. **Owner-curated `is_current` flips** as a separate one-off migration, then resume spec 003 unchanged.

The user picks. Until then, spec 003 is BLOCKED_AT_PROBE.

### Files staged

None. No migration was authored, no source files were modified beyond this spec's Probe results section and this Build notes section. `docs/internal/prep-canonicalness-notes.md` was read but not modified, per the developer brief.

