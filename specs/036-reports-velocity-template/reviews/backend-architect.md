# Spec 036 — Backend architect post-impl review

Mode: drift review against architect design §A0-§A17 (spec.md lines 607-1427).
All gates green per the dispatch prompt (typecheck, typecheck:test, jest 54,
pgTAP 18/18, smoke). 8 files touched; no boundary violations.

## Verdict

**No Critical findings. No Should-fix findings. 3 Nits.**

The implementation lands the design with high fidelity. Every checklist item
the dispatch prompt asked me to verify clears. The dev's flagged adjustment
(brand-scoped recipe fixture lookup instead of the dropped `recipes.store_id`)
is correct and matches my §A5 / spec Q9 design intent — the runner reads
recipes via the brand-scoped SELECT policy (per
`supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:32-35`), the
fixture do-block executes before the `set local role authenticated` switch so
the optional INSERT path runs as superuser (RLS-bypass), and the brand_id
lookup via `stores.brand_id` is the correct shape. No design change required.

## Drift walkthrough (design point → implementation site)

| § | Architect prescription | Implementation | Match |
|---|---|---|---|
| A0 #1 | Migration filename `20260515120000_report_run_velocity.sql` | `supabase/migrations/20260515120000_report_run_velocity.sql` | exact |
| A0 #2 | `v_series_n constant int := 5;` with future-tunable comment | `migration:120` — `v_series_n constant int := 5; -- top-N cap; see header for follow-up tunable` | exact |
| A0 #3 | `recipe_id` deeplink field deferred | Rows emit `recipe` (label) only, no `recipe_id` | exact |
| A0 #4 | `byOpts` ternary refactor deferred with inline comment | `ReportDetailFrame.tsx:271-274` — comment present and verbatim to design text | exact |
| A2 | `language plpgsql / security invoker / set search_path = public` | `migration:111-113` | exact |
| A2 | First-statement 42501 auth gate | `migration:134-137` | exact |
| A2 | `revoke from public, anon; grant to authenticated;` | `migration:434-435` | exact |
| A3 #1 | (1) AUTH GATE comment block | `migration:132-137` | exact |
| A3 #2 | (2) PARAM COERCION, `coalesce(nullif(...), default)` for from/to/by | `migration:139-155` | exact |
| A3 #3 | (3) RANGE VALIDATION raises 22023, `from = to` allowed | `migration:157-165` | exact |
| A3 #3 | `v_window_days := (v_to - v_from) + 1` | `migration:166` | exact |
| A3 #4 | (4) COLUMN HEADER built up-front for both `by:` modes | `migration:168-188` | exact |
| A3 #5 | (5) HEADLINE TOTALS + TOP-RECIPE single-CTE pass | `migration:190-233` | exact |
| A3 #6 | (6) EMPTY-RESULT short-circuit | `migration:235-245` | exact |
| A3 #7 | (7) KPI ASSEMBLY — 3 KPIs, all `"tone": null`, top-mover guard on `> 0` | `migration:247-281` | exact |
| A3 #8 | (8) ROWS branched by `v_by`, `qty / v_window_days` velocity, revenue $/-$ guard, deterministic sort | `migration:283-371` | exact |
| A3 #9 | (9) SERIES top-N=5, `v_distinct_dates < 2` empty gate, round(_, 2) on y | `migration:373-422` | exact |
| A3 #10 | (10) FINAL ENVELOPE | `migration:424-430` | exact |
| A3 header notes | 11 design choices documented inline | `migration:11-104` — 11 bullets present | exact |
| A4 | Dispatcher arm slotted after `'vendor'`, before `else`; all other arms preserved | `migration:459-481` matches vendor:492-512 byte-for-byte with the new velocity arm at line 470-471 | exact |
| A5 | RLS: no policy changes; runner relies on existing per-store reads via `auth_can_see_store` | No DDL on policies; `security invoker` lets caller's RLS fire | exact |
| A6 | RPC envelope, request shape, error cases | Migration produces the documented shape | exact |
| A7 | No edge function changes | `velocity` does not appear in `supabase/functions/` (grep clean) | exact |
| A8 | No `src/lib/db.ts` change | `velocity` does not appear in `src/lib/db.ts` (grep clean) | exact |
| A9 | No realtime publication touch | `pos_imports`/`pos_import_items` membership unchanged | exact |
| A10 | No `src/store/useStore.ts` change | `velocity` does not appear in `useStore.ts` (grep clean) | exact |
| A11 #1 | `templates.ts` flip + comment line | `templates.ts:16` and `templates.ts:34` (status flipped to `'live'`) | exact |
| A11 #2 | `NewReportModal` BY_OPTIONS gets `velocity: ['recipe', 'category']`, ByOption widened, defaultByForTemplate gains `velocity → 'recipe'` branch, by useState widened | `NewReportModal.tsx:78,83,94,130` | exact |
| A11 #3 | `ReportDetailFrame` widens `overrideBy`/`onByChange`/`savedBy`/`effectiveBy`/`onPickBy`/`byOpts`/ByPopover internal types | `ReportDetailFrame.tsx:62,63,192,204,260,275,668-672` | exact |
| A11 #3 | Inline comment at byOpts (architect §A0 #4 deferral) | `ReportDetailFrame.tsx:272-274` | exact |
| A11 #4 | `ReportsSection` widens `OverrideState['by']` and `setOverrideBy` arg | `ReportsSection.tsx:41,178` | exact |
| A12 | pgTAP plan(11), 11 arms matching the architect plan, arm 8 load-bearing velocity-ratio test | `report_run_velocity.test.sql:34,310-335` — arm 8 explicitly proves window_days denominator | exact |
| A13 | `reports_anon_revoke.test.sql` plan 10→11, arm placement after vendor before reorder, trailing arms renumbered, header bullet bump | `reports_anon_revoke.test.sql:40,140-152,154-163` | exact |
| A14 | No realtime/edge/db.ts/useStore change | confirmed via grep | exact |
| A17 | Post-merge deploy is `npx supabase db push --linked --yes` only | Spec §"Post-merge deploy" (lines 1497-1505) explicitly tells dev NOT to run it — that's the release-coordinator's call | exact |

## Boundary check

8 files touched, all of them in the architect's prescribed file list:
- `supabase/migrations/20260515120000_report_run_velocity.sql` (new)
- `supabase/tests/report_run_velocity.test.sql` (new)
- `supabase/tests/reports_anon_revoke.test.sql` (modified)
- `src/screens/cmd/sections/reports/templates.ts`
- `src/components/cmd/NewReportModal.tsx`
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`
- `src/screens/cmd/sections/ReportsSection.tsx`
- `specs/036-reports-velocity-template/spec.md` (status + Files changed)

No unintended touches. `velocity` does not appear in `src/lib/db.ts`,
`src/store/useStore.ts`, or `supabase/functions/` (all grep-confirmed clean
per §A7/A8/A10). `src/types/index.ts:515` already had `'velocity'` in the
templateId union from a pre-existing spec landing — no edit required, no edit
made.

## Dev's flagged adjustment

The dev correctly identified that `recipes.store_id` was dropped in
`20260504072830_brand_catalog_p3_lockdown.sql:53`. The PM spec referred to
"Frederick recipes" but post-P3 recipes are brand-scoped, not store-scoped.
The fixture in `report_run_velocity.test.sql:46-83` resolves
`stores.brand_id` and then looks up recipes by `brand_id`, with an
INSERT-fallback when fewer than two seed rows exist. This matches the
architect intent at §A5:

> recipes → existing brand-scoped SELECT policy (per the brand-catalog
> refactor; authenticated users can read recipes for their brand).

And Q9 (spec line 526-532):

> Q9: Does this spec add a new table or migration to pos_imports /
> pos_import_items / recipes? → NO. All three tables exist and are
> well-populated by the existing POS-import surface and Recipes section.

The fixture runs as the test runner (superuser, before the `set local role
authenticated` at test line 102), so the conditional `insert into
public.recipes` bypasses the `admin_write_recipes` policy (which requires
`auth_is_admin()`). The subsequent manager-JWT-anchored calls work via the
existing brand-scoped SELECT policy on recipes (`auth_read_recipes`:
`auth.uid() is not null`). The runner itself doesn't care: it just
left-joins by `recipes.id = pos_import_items.recipe_id`. **Adjustment is
correct and design-aligned.**

## Nits (cosmetic, optional, no action recommended pre-merge)

**N1. Stale "Mirrors vendor's Top vendor cross-cut behaviour" comment in
arm 10.** `supabase/tests/report_run_velocity.test.sql:367` says "Mirrors
vendor's Top vendor cross-cut behaviour" but `report_run_vendor.test.sql`
has no Top-vendor cross-cut arm (verified via `grep "Top vendor"`). The
velocity arm 10 is a legitimate cross-cut test, just not "mirrored" from
vendor — it's net-new coverage. Cosmetic comment-only nit, doesn't change
test behaviour. Could be a follow-up cleanup.

**N2. Header comment block in `reports_anon_revoke.test.sql` has a minor
self-reference shift.** Lines 11-14 say "Header was stale at '8 RPCs
covered' pre-spec-035 — spec 034 added the waste arm without bumping the
comment; spec 035 fixed that and added the vendor arm; spec 036 added the
velocity arm. Net: comment goes 8 → 11 across spec-034/035/036." The
sentence is correct, but it's growing per-spec and will keep growing. A
future spec can rewrite it as a one-liner ("Bumped by specs 034 / 035 /
036") if it gets noisy. Not load-bearing.

**N3. Empty `recipes.menu_item` defensive note.** Architect §A15 noted
empty-string `menu_item` would fall through to literal empty string; dev
chose not to add `nullif(trim(r.menu_item), '')` as the design left it as
"developer call." Acceptable per the architect explicit "no action needed."
Surfacing only because the next reviewer might ask. The `recipes` table's
init schema declares `menu_item text not null` (init_schema.sql:74) so
empty-string is only reachable through a future migration relaxing the
NOT NULL or an admin insert that bypasses the NOT NULL — defense-in-depth
that didn't ship is fine.

## What I checked but did NOT find as drift

- Migration header documents all 11 design choices per §A3 (lines 11-104).
- `v_window_days = (v_to - v_from) + 1` — load-bearing per Q2/§A0.
  Confirmed at migration:166. Test arm 8 (load-bearing per architect §A12)
  proves the denominator at `test:310-335`.
- Empty short-circuit returns `series: '[]'::jsonb` NOT null — spec 016
  contract. Confirmed at migration:243.
- All three KPIs emit `"tone": null` (migration:256, 270, 279). No
  copy-paste of waste's `case when v_total_dollar < 50 then 'ok' ...` block.
- Top-N=5 series cap hardcoded via constant, not a magic number in the
  LIMIT clause (migration:120, 405).
- Dispatcher's signature unchanged; arms preserved in landing-order
  (`stub`, `cogs`, `variance`, `waste`, `vendor`, `velocity`); single
  `else` not_implemented branch with the documented envelope shape.
- `qty / v_window_days` — `numeric / integer` returns `numeric` in
  Postgres (no integer-division pitfall).
- `select last_run_velocity → SQLSTATE 42501` for anon at GRANT time via
  `reports_anon_revoke.test.sql:144-152`.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 3 Nits.
  Implementation matches design point-by-point including the dev's correctly
  flagged brand-scoped recipe fixture adjustment.
payload_paths:
  - specs/036-reports-velocity-template/reviews/backend-architect.md
