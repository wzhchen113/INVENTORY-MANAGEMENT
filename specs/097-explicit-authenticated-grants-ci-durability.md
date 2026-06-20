# Spec 097: Explicit Supabase-role grants on `public.*` — durable CI fix for the Supabase-CLI grant-drift failure

Status: READY_FOR_REVIEW

> **All blocking questions (Q1–Q5) are resolved** — see "Open questions
> resolved" below. Architect may begin. Q5 (the exact pgTAP probe shape) was
> deferred to the architect by the user; it is a design-level recommendation,
> not a blocking product decision.

## Background (why this spec exists)

Spec 096's CI run went red: 34 of 46 pgTAP files under `supabase/tests/*.test.sql`
failed with uniform `permission denied for table … (SQLSTATE 42501)`. The cause
was **Supabase CLI version drift, not a code change**. The Track 2 "Supabase DB
tests" job in `.github/workflows/test.yml` used `supabase/setup-cli@v1` with
`version: latest`, which drifted from CLI **2.105.0** (live at the last green
DB-test run on 2026-06-08) to **2.106.0+**. The newer CLI ships a bundled
Postgres image that **revokes the implicit `GRANT … TO {anon, authenticated,
service_role} ON public.*`** older images granted. Our pgTAP tests run as the
`authenticated` role (they exercise RLS via `auth.uid()` JWT-claim injection),
so without table-level grants they cannot even reach the RLS check — hence the
mass `permission denied`. Local dev stayed green only because it reuses the OLD
cached Postgres image (`postgres:17.6.1.084`). This is the
"local-green/CI-red pgTAP asymmetry" already noted in CLAUDE.md (specs 060/067).

**Stopgap already shipped (commit 4c180c8, on `main`, CI green):** the Track 2
job was pinned to `version: 2.105.0` (`.github/workflows/test.yml` lines
~124–132, with an explanatory comment block). This works but freezes the project
on an old CLI — the pin cannot be bumped until the grants are made explicit.

This spec is the **durable fix** and is a follow-up carried over from spec 096's
release proposal "Deferred / follow-up" lineage (the `>= 20260617000000_*.sql`
migration slot). It is **distinct from** the spec-096 empty-`sub_unit_unit`
re-model, which is a *separate* deferred item and is explicitly out of scope here.

## User story

As a **maintainer of the I.M.R CI pipeline**, I want the default table-level
grants on `public.*` for the three Supabase roles (`anon`, `authenticated`,
`service_role`) to be **explicit in a migration** rather than inherited from
whatever the bundled Postgres image happens to grant, so that a future
deliberate Supabase-CLI bump cannot silently reintroduce the 34-file mass
`permission denied` failure, and so the team can move off the frozen
`version: 2.105.0` pin onto a newer CLI without breaking Track 2.

Secondary (regression-catching) story:

As a **developer adding a future migration**, I want a pgTAP probe that fails
**loudly and specifically** if the grant posture regresses, so the next grant
regression surfaces as one targeted test failure rather than a 34-file mass
denial that takes 7 runs / 3 days to diagnose (the spec 060 / 067 pattern).

## Acceptance criteria

- [ ] A new migration in `supabase/migrations/` (next free slot is
      `20260618000000_*.sql` — latest on disk is
      `20260607130000_username_resolve_rate_limit.sql`, today is 2026-06-18)
      issues explicit `GRANT` statements restoring the default grant posture to
      **all three** Supabase roles — `anon`, `authenticated`, AND `service_role`
      — across all current `public` objects. The grant posture **matches what
      the pre-2.106 bundled Postgres image provided by default** (i.e. restores
      what the newer image revokes), NOT a hand-picked narrower subset. The exact
      privilege set per object class (e.g. SELECT/INSERT/UPDATE/DELETE on tables,
      USAGE/SELECT on sequences, EXECUTE on functions) is an **architect-level
      detail** — the requirement is fidelity to the prior default posture, and
      the architect names the precise statements in the design doc.
- [ ] The same migration issues `ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT … TO {anon, authenticated, service_role}` so that **every future
      table/object created in `public` inherits the grants automatically**. Both
      halves — grants on existing objects AND default privileges for future
      objects — are in scope; the default-privileges half is what makes the fix
      durable against tables added by later migrations.
- [ ] The migration is **idempotent / safe to re-apply**: re-running it is a
      harmless re-grant (or no-op). `GRANT` and `ALTER DEFAULT PRIVILEGES … GRANT`
      are idempotent by definition, so the migration body is a **safe no-op
      against prod** (prod predates the image change and still carries the
      implicit grants). No down migration (repo convention — strictly additive).
- [ ] **Ship checklist — prod reconciliation (hard dependency):** the new
      migration is applied to **prod** via `supabase db push` / `supabase
      migration up` (NOT the dashboard SQL editor — per the "don't drift via
      dashboard" rule) so its filename appears in prod's
      `supabase_migrations.schema_migrations`. This is required **regardless of
      whether the grant body changes anything on prod** — the
      `.github/workflows/db-migrations-applied.yml` bi-directional drift gate
      hard-fails if a local migration filename is absent from prod. Because the
      body is an idempotent no-op against prod's existing grants, this
      reconciliation is safe.
- [ ] A pgTAP regression-guard probe (file under `supabase/tests/*.test.sql`)
      asserts the grants exist — e.g. `has_table_privilege('authenticated',
      'public.<table>', 'SELECT')` and the `anon` / `service_role` equivalents —
      so a future regression surfaces as **one targeted, named failure** rather
      than 34 scattered permission-denied errors. The probe **fails** if the
      grant posture regresses. (Exact probe shape = Q5, deferred to the
      architect — see "Open questions resolved" for the recommended shape.)
- [ ] The new pgTAP probe **passes** when run through the existing
      `npm run test:db` wrapper (the `scripts/test-db.sh` runner that discovers
      `*.test.sql` files and runs each via `docker exec … psql -f`).
- [ ] `.github/workflows/test.yml` Track 2 ("Supabase DB tests") is bumped
      **off** `version: 2.105.0` to a CLI **≥ 2.106.0** (the first version family
      known to revoke the default grants). The exact target — pinned `2.106.0`
      for a deterministic non-floating proof, a later fixed `>= 2.106.0` pin, or
      `latest` — is an **architect/dev call**; the requirement is that Track 2
      runs against an image that previously failed 34/46.
- [ ] **Load-bearing proof:** the Track 2 "Supabase DB tests" job is **GREEN**
      against that ≥ 2.106.0 CLI — i.e. **all 46 pgTAP files pass** against the
      image that previously failed 34 of them, including the new regression-guard
      probe. That green run is the evidence the explicit grants work. (Per the
      CLAUDE.md "CI status check after every push to `main`" rule, the green
      Track 2 run must be confirmed on `main` before SHIP_READY.)
- [ ] The explanatory comment block in `.github/workflows/test.yml` (currently
      lines ~127–131, the `version: 2.105.0` pin rationale) is **updated** to
      reflect the new posture: grants are now schema-explicit, the pin was moved
      forward deliberately, and the explicit-grant migration is the durable fix
      backing the bump.
- [ ] No RLS **policy** is added, dropped, or altered. No role/permission
      redesign. The change is grants-only (existing objects + default privileges)
      + one pgTAP probe + the Track 2 pin bump + its comment.

## In scope

- One additive SQL migration in `supabase/migrations/` that makes the default
  table/sequence/function grants on `public.*` explicit for **all three**
  Supabase roles (`anon`, `authenticated`, `service_role`), **plus**
  `ALTER DEFAULT PRIVILEGES` so future objects inherit the grants.
- One pgTAP regression-guard probe under `supabase/tests/` asserting the grant
  posture, so a future regression is caught in-suite as a targeted failure.
- Bumping the `version:` pin in `.github/workflows/test.yml` Track 2 off
  `2.105.0` to a CLI ≥ 2.106.0, and updating its explanatory comment block.
- Reconciling the new migration into prod's `schema_migrations` via
  `supabase db push` / `migration up` so the `db-migrations-applied` drift gate
  stays green (operational ship-checklist dependency).
- Documentation touch (architect/dev to decide whether it belongs in this spec
  or is deferred): the CLAUDE.md "local-green/CI-red pgTAP asymmetry" note may
  warrant a one-line pointer at this spec's explicit-grant migration as the
  durable fix.

## Out of scope (explicitly)

- **The spec-096 empty-`sub_unit_unit` re-model.** Populating `sub_unit_unit` on
  legacy `unit='cases'` rows + EOD/Reorder revalidation + backfill pgTAP is a
  SEPARATE deferred spec (096 release-proposal "Deferred / follow-up"). It also
  lands in the `>= 20260617000000` slot but is unrelated to grants. Do NOT fold
  it in. — Rationale: different problem domain (data semantics vs. CI durability);
  bundling would couple two unrelated review surfaces.
- **Any RLS policy change.** This spec does not add, drop, or rewrite a single
  `CREATE POLICY` / `ALTER POLICY`. Grants and policies are different layers; the
  bug is purely the grant layer. — Rationale: policy changes carry their own
  security-review weight and are not what broke. Note for the architect: tables
  that are deliberately RLS-on / no-permissive-policy (e.g.
  `public.username_resolve_rate_limit`, spec 095) remain unreachable by
  `anon`/`authenticated` via PostgREST **even with** the restored table grants,
  because RLS still denies — restoring grants does not weaken those tables'
  posture. This is why the fix is grants-only and needs no policy work.
- **Any broad role/permission redesign.** No new roles, no reshaping of
  `auth_is_admin()` / `auth_is_privileged()` / `auth_can_see_store()`, no changing
  which role the pgTAP tests run as. — Rationale: the fix is to make *existing*
  effective grants explicit, not to change the permission model.
- **Retroactively pinning or changing the OTHER three CI jobs** (jest, typecheck,
  typecheck-base). Only Track 2 boots Postgres and is affected by the CLI image.
  — Rationale: scope containment; those jobs do not boot Postgres.
- **A managed/admin UI for grants.** No app-surface (Cmd UI) change of any kind.
  This is backend + CI only. — Rationale: nothing user-facing is involved.
- **Auditing/fixing every historical Critical's pgTAP coverage.** Per
  tests/README.md that is a separate follow-up track. — Rationale: this spec adds
  exactly one probe for exactly one regression class.

## Open questions resolved

- **Q1 — Does prod need the migration body, or only its filename?**
  → A: **Both questions answered.** (a) The grant body is a **safe no-op against
  prod**: prod predates the CLI image change and still carries the implicit
  grants, and `GRANT` / `ALTER DEFAULT PRIVILEGES … GRANT` are idempotent, so
  re-applying them changes nothing harmful. (b) Reconciling the migration into
  prod **is part of this spec's ship checklist** — the
  `db-migrations-applied.yml` gate hard-fails if the migration's filename is
  absent from prod's `schema_migrations`, so the migration MUST be applied to
  prod (`supabase db push` / `migration up`) regardless of whether the body
  changes anything there. Captured as a ship-checklist acceptance criterion above.

- **Q2 — Which roles get explicit grants?**
  → A: **All three.** Grant to `anon`, `authenticated`, AND `service_role`,
  faithfully restoring Supabase's default grant posture (the pre-2.106 image
  granted all three). Do NOT narrow to `authenticated`-only. The architect scopes
  the precise per-role/per-object-class privilege set to match the prior default
  posture.

- **Q3 — Grant scope / future-proofing?**
  → A: **Existing tables AND default privileges.** The migration grants on all
  current `public` objects AND issues `ALTER DEFAULT PRIVILEGES … GRANT … TO
  {anon, authenticated, service_role}` so every *future* object inherits the
  grants automatically. **Both halves are in scope** — the default-privileges
  half is what makes the fix durable. The exact privilege set is an
  architect-level detail; the spec requires the grant posture **match what the
  pre-2.106 image provided by default**, not a hand-picked subset. (Architect
  note: `ALTER DEFAULT PRIVILEGES` applies to objects created by the role that
  runs the ALTER — the design doc should confirm the migration runs as the role
  whose future objects need the inheritance, typically the migration owner.)

- **Q4 — Un-pin in this spec, or separately?**
  → A: **Prove against ≥ 2.106.0 in this spec.** This spec edits
  `.github/workflows/test.yml` Track 2 to bump the `supabase/setup-cli` pin
  **off** `2.105.0` to a version **≥ 2.106.0** (the first family that revokes the
  defaults). The exact target — fixed `2.106.0` for a deterministic
  non-floating proof vs. current-latest-stable vs. `latest` — is an
  **architect/dev call**. The **load-bearing acceptance criterion** is that
  Track 2 must be GREEN against the bumped CLI: all 46 pgTAP files pass against
  the image that previously failed 34 of them. That green run is the proof the
  grants work.

- **Q5 — What proves the fix in-suite?**
  → A: **Deferred to the backend-architect** (not a blocking product decision).
  The spec REQUIRES a regression-guard pgTAP probe so a future re-break surfaces
  as one clear failing assertion rather than 34 scattered permission-denied
  errors. **Recommended shape** (architect makes the final call): assert
  `has_table_privilege('authenticated', 'public.<table>', 'SELECT')` (plus the
  `anon` and `service_role` equivalents) across the public tables — ideally the
  iterate-all-tables-with-allowlist pattern modeled on spec 053's
  `supabase/tests/permissive_policy_lint.test.sql`, with an allowlist seed for
  intentional exceptions (e.g. `public.username_resolve_rate_limit`, which is
  RLS-on / no-permissive-policy and deliberately not reachable by
  `authenticated`). The architect decides dedicated-list vs. iterate-all and
  finalizes the assertion set.

## Dependencies

- **`.github/workflows/test.yml`** — Track 2 "Supabase DB tests" job (lines
  ~115–148). The pin lives at lines ~124–132 and the comment block at ~127–131.
  Both the `version:` line and the comment are edited.
- **`.github/workflows/db-migrations-applied.yml`** (spec 064) — the
  bi-directional migration-drift gate. The new migration's filename MUST be
  reconciled into prod's `schema_migrations` or this gate hard-fails. Hard
  dependency (see the prod-reconciliation acceptance criterion).
- **`scripts/test-db.sh`** + `npm run test:db` — the pgTAP runner the new probe
  must pass through.
- **`supabase/migrations/`** — the new migration timestamps `20260618000000` or
  later (latest on disk: `20260607130000_username_resolve_rate_limit.sql`).
- **Prod Supabase project** — operational ship step: apply the new migration so
  its filename appears in `supabase_migrations.schema_migrations` (via
  `supabase migration up` / `db push`, NOT the dashboard SQL editor).
- **`supabase/seed.sql`** — no change expected, but the architect should confirm
  the restored grants do not interact with seed-time role setup.

## Project-specific notes

- **Cmd UI section / legacy:** none — backend + CI only, no app-surface change.
- **Which app:** N/A (admin repo); this is infrastructure, not a feature for any
  app surface.
- **Per-store or admin-global:** N/A — grants are schema-level, not store-scoped.
  This does NOT touch `auth_can_see_store()` or per-store RLS.
- **Edge function or PostgREST:** neither in the request path. The grants affect
  the `anon` / `authenticated` / `service_role` roles that PostgREST and edge
  functions assume, but no edge function is added or changed.
- **Realtime channels touched:** none. No `supabase_realtime` publication change,
  so the `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
- **Migrations needed:** YES — exactly one additive migration
  (`20260618000000_*.sql` or later): grants on existing `public` objects for all
  three roles + `ALTER DEFAULT PRIVILEGES` for future objects, idempotent, no
  down migration. Must be reconciled into prod (ship-checklist dependency).
- **Edge functions touched:** none.
- **Web/native scope:** N/A — no client code; CI + DB schema only.
- **Tests:** Track 2 (pgTAP DB tests). One new `supabase/tests/*.test.sql`
  regression-guard probe. No jest (Track 1) or shell-smoke (Track 3) work. The
  test-engineer routes to the pgTAP track, and the bar includes a **green Track 2
  run against a CLI ≥ 2.106.0** (the load-bearing proof).
- **`app.json` slug:** not touched. (Noted only because this spec edits build/CI
  config — the `slug: towson-inventory` value is NOT in scope and is not changed.)
- **CLAUDE.md ground rules honored:** strictly additive migration; no down
  migration; no dashboard SQL-editor drift (reconcile via CLI); the
  local-green/CI-red asymmetry this fixes is the documented spec 060/067 pattern;
  the post-push-to-`main` green-Track-2 confirmation rule applies before
  SHIP_READY.

---

## Backend design

### 0. Investigation findings (what the prior default posture actually is)

These are the facts that ground every decision below. The developer should
treat them as the design's load-bearing premises.

1. **`supabase/seed.sql` carries ZERO grant setup.** `grep -nE
   'GRANT|REVOKE|ALTER ROLE|CREATE ROLE'` over the 286 KB seed returns nothing.
   The seed only inserts the admin `auth.users` row and prod-pulled
   stores/vendors/inventory data. So the seed does **not** define the role-grant
   posture and cannot conflict with or duplicate this migration's grants.
   → **seed.sql interaction: none. No conflict, no duplication.**

2. **No migration anywhere issues a table-level `GRANT … TO anon` /
   `… TO authenticated`.** `grep -niE
   'grant\s+(select|insert|update|delete|all).*to.*(anon|authenticated)'` over
   all 88 migrations returns **no matches**. Every table-level grant those two
   roles currently enjoy on `public.*` comes **purely from the bundled Postgres
   image default** — i.e. the implicit broad grant that the ≥2.106 image
   revokes. This is precisely why 34/46 pgTAP files broke: nothing in the repo
   restores those grants, so when the image stopped emitting them, the grants
   vanished. **This migration is the first and only place those grants become
   schema-explicit.**

3. **The pre-2.106 default posture is broad: `GRANT ALL` to all three roles,
   with RLS as the real gate.** Two independent proofs from the existing test
   suite:
   - 38 of 46 pgTAP files do `set local role authenticated` (or `anon`) and then
     run `SELECT`/DML against `public` tables. They all *implicitly* depend on
     the broad default grant; none of them grant it themselves.
   - `supabase/tests/username_resolve_rate_limit.test.sql` arm (6) does
     `set local role authenticated; select count(*) from
     public.username_resolve_rate_limit` and asserts the result is **0 rows** —
     and this passes today. A *missing* table grant would raise `42501`, not
     return 0. So `authenticated` **holds a SELECT grant even on
     `username_resolve_rate_limit`**; that table is unreachable via PostgREST
     because **RLS denies**, not because the grant is absent. This is the
     "grant present ≠ row-reachable" distinction the probe must honor (§4).

   Supabase's conventional default for these roles is `GRANT ALL ON ALL
   TABLES/SEQUENCES/ROUTINES IN SCHEMA public` + `GRANT USAGE ON SCHEMA public`,
   with RLS doing the actual per-row gating. Fidelity to that posture — **not a
   hand-picked SELECT-only subset** — is the spec's explicit bar (AC line 62–66,
   Q2).

   > **CORRECTION (reframed fidelity bar — see §1a).** "Fidelity to the prior
   > posture" must mean the **NET EFFECTIVE** posture the project actually had
   > immediately pre-2.106 = *the raw image default MINUS the deliberate REVOKEs
   > the project had layered on top of it*. The raw image `GRANT ALL` is NOT the
   > target; restoring it verbatim re-opens two holes the project deliberately
   > closed (finding #5 below + §1a): the spec-041 `profiles` TRUNCATE revoke and
   > the spec-093 audit-table revoke. The reframed bar is still "not a
   > hand-picked SELECT-only subset" — it is `ALL`-minus-TRUNCATE for tables (the
   > full client-usable set) plus the two targeted locks. §1a restores exactly
   > that net-effective ACL, not the raw default.

4. **Migrations run as the `postgres` role.** `scripts/test-db.sh` connects
   `-U postgres`; `supabase db reset` / `db push` / `migration up` apply
   migrations as `postgres`. So every *future* table created by a later
   migration is owned by `postgres`, and `ALTER DEFAULT PRIVILEGES` must be
   scoped to objects `postgres` creates for the inheritance to fire (§2).

5. **Two tables are deliberately scoped at the RLS layer but NOT at the grant
   layer (Category B):** `public._edge_auth` (migration `20260424211733`) and
   `public.username_resolve_rate_limit` (spec 095). Both are RLS-on /
   no-permissive-policy. The restored broad grant **does not weaken them** — RLS
   still denies `anon`/`authenticated` every row (the spec's own out-of-scope
   note line 149–153 says exactly this). They are therefore **NOT
   grant-allowlist entries** in the probe; they receive the table grant like
   every other table and stay unreachable via RLS. See §4b Category B for the
   precise handling.

   > **CORRECTION — there is also a THIRD table, scoped at the GRANT layer
   > (Category A), with the OPPOSITE posture.**
   > `public.spec093_case_qty_backfill_audit` (spec 093, migration
   > `20260602120000:68`) does `revoke all … from anon, authenticated` — it is
   > grant-locked, the inverse of the two RLS-locked tables above. The broad
   > table grant in §1a re-opens it, so §1a re-locks it with a targeted REVOKE,
   > and the probe DOES allowlist it (the one and only allowlist row) AND adds a
   > negative assertion that its grant is absent. Do not conflate the two
   > categories: Category B (these two) holds the grant and is RLS-unreachable
   > → OFF the allowlist; Category A (the audit table) withholds the grant by
   > design → ON the allowlist. The litmus test is "does a migration `REVOKE …
   > from {anon|authenticated}` at the GRANT layer?" — only the audit table
   > answers yes. See §4b.

---

### 1. Data model changes

**No tables, columns, or indexes change.** This is a pure grant migration plus
default-privileges. Destructive vs additive: **strictly additive** — only
`GRANT` and `ALTER DEFAULT PRIVILEGES … GRANT` statements, which are idempotent
and add privileges. No down migration (repo convention).

**Proposed migration filename:**
`supabase/migrations/20260618000000_public_grants_explicit.sql`
(next free slot; latest on disk is `20260607130000_username_resolve_rate_limit.sql`,
today is 2026-06-18 — matches AC line 55–57 and Dependencies line 235).

#### 1a. Grants on existing objects (the precise statements)

> **CORRECTION (post-design drift fix).** The prior version of this section
> emitted `grant all on all tables in schema public` and asserted in §7 risk 1
> that "tables + sequences + schema-usage [are] broad (those have no competing
> per-object REVOKEs — verified: zero table-level grants/revokes for
> anon/authenticated exist)." **That premise was factually false.** A re-grep
> (`grep -rniE "revoke .* on .* from .*(anon|authenticated)"
> supabase/migrations/`, then subtracting the `on function …` / EXECUTE lines)
> finds **exactly two deliberate, pre-existing TABLE-level REVOKEs** that sort
> EARLIER than `20260618000000`, so a blanket later `GRANT ALL` re-opens both:
>
> 1. `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:305`
>    — `revoke truncate on public.profiles from authenticated, anon;`. This is
>    the **spec-041 round-3 live-verified Critical** TRUNCATE+INSERT
>    privilege-escalation fix (a brand-admin TRUNCATEs `public.profiles` to
>    bypass the row-level UPDATE/DELETE triggers, then re-INSERTs as cross-brand
>    `super_admin`). `GRANT ALL` includes `TRUNCATE`, so a blanket grant
>    re-opens the escalation. Two existing pgTAP arms guard this and FAILED on
>    the flawed migration:
>    `auth_can_see_store_brand_scope.test.sql` arm 14 and
>    `profiles_rls_sweep.test.sql` arm 12.
> 2. `supabase/migrations/20260602120000_spec093_case_qty_backfill.sql:68` —
>    `revoke all on public.spec093_case_qty_backfill_audit from anon,
>    authenticated;`. A back-office audit table deliberately locked at the grant
>    layer (RLS-enabled-no-policy AND grant-revoked). `GRANT ALL ON ALL TABLES`
>    silently re-grants SELECT/everything on it — and the OLD §4b "empty
>    allowlist" probe would have asserted the re-opened grant was *correct*,
>    pinning the regression with a passing test.
>
> This is the SAME REVOKE-ordering hazard already handled correctly for
> *routines* below — the table side was wrongly asserted clean.

**Reframed fidelity bar.** The spec's "match the pre-2.106 default posture" (AC
line 62–66, Q2) must mean the **NET EFFECTIVE posture the project actually had
immediately pre-2.106** — i.e. *image-default grants MINUS the two deliberate
REVOKEs the project had already applied on top of that default* — **NOT the raw
image default**. Restoring the raw image default re-introduces two holes the
project deliberately closed (the profiles TRUNCATE escalation and the audit-table
lock). "Fidelity" = reproduce the effective grant ACL that existed on
2026-06-07, which already had those two REVOKEs baked in. Every statement below
serves that reframed bar.

Restore the broad pre-2.106 posture across the object classes that exist in
`public`, plus schema usage — **scoped so both deliberate REVOKEs survive**:

```sql
-- Schema usage (required before any object inside the schema is reachable).
grant usage on schema public to anon, authenticated, service_role;

-- Tables (+ views) — anon/authenticated: explicit privilege list that OMITS
-- TRUNCATE. PostgREST/clients never need TRUNCATE; dropping it from the broad
-- grant means the spec-041 `revoke truncate on public.profiles from
-- authenticated, anon` is preserved AT THE SOURCE (this grant can never
-- re-open it, regardless of migration ordering). This is the net-effective
-- pre-2.106 posture for these two roles, not the raw image default.
grant select, insert, update, delete, references, trigger
  on all tables in schema public to anon, authenticated;

-- Tables (+ views) — service_role: full ALL (service_role legitimately RETAINS
-- TRUNCATE; the spec-041 revoke deliberately scoped only anon/authenticated and
-- the migration comment notes "service_role retains TRUNCATE (separate grant
-- audience)"). Keeping ALL here is faithful, not a hole.
grant all on all tables in schema public to service_role;

-- EXCLUSION — re-lock the one audit table that was `revoke all … from anon,
-- authenticated` (spec 093). The line above just re-granted SELECT/etc on it;
-- restore its deliberate lock. service_role keeps its grant (it predates and is
-- unaffected). This is the ONE table that withholds the grant by design.
revoke select, insert, update, delete, references, trigger
  on public.spec093_case_qty_backfill_audit from anon, authenticated;

-- Sequences: USAGE + SELECT + UPDATE are what `GRANT ALL ON SEQUENCE` expands
-- to; emit ALL for fidelity (no competing per-sequence REVOKE exists — grep
-- confirmed). All three roles.
grant all on all sequences in schema public to anon, authenticated, service_role;

-- NOTE (approach 7a): deliberately NO retroactive `grant all on all routines`
-- here. A blanket routines grant at this timestamp would sort AFTER — and thus
-- RE-OPEN — the ~15 per-RPC `REVOKE EXECUTE … FROM anon, authenticated`
-- hardening migrations (specs 016/061/095). EXECUTE on existing functions is
-- already correctly set by those migrations and was never the cause of the 34
-- failures (all were TABLE denials). Future functions are restored via the
-- `ALTER DEFAULT PRIVILEGES … ON functions` line in §1b. See §7 risk 1.
```

> **Developer note on the re-lock REVOKE vs. the rejected routines (b) shape.**
> §7 risk 1 rejects "GRANT ALL ON ALL ROUTINES then re-emit ~15 per-RPC REVOKEs"
> as brittle. The single `revoke … from public.spec093_case_qty_backfill_audit`
> above is **not** the same anti-pattern: it is exactly ONE table (not ~15
> scattered objects), the audit table is a fixed, named, non-recurring artifact,
> and the alternative (an explicit per-table allowlist in the GRANT loop) is
> strictly more code for one row. The routines case had ~15 REVOKEs across many
> migrations and a *recurring* class (every new RPC); the table case has exactly
> one. One targeted re-lock is the minimal, auditable shape. The TRUNCATE hole on
> `profiles` is handled differently — by OMITTING TRUNCATE from the broad grant
> entirely (at the source), not by a re-emit — because TRUNCATE is a *privilege
> class* clients never need, so dropping it globally is clean and also hardens
> any future table against the same escalation class (see §1b).

Notes for the developer:

- **Why not `GRANT ALL` for anon/authenticated.** `ALL` on a table includes
  `TRUNCATE`, and a later `GRANT ALL` would re-open the spec-041 escalation that
  `20260517040000:305` closed. The bar is the **net-effective** pre-2.106
  posture (image default MINUS the two REVOKEs), not the raw default. The
  explicit `SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER` list is the
  full set of table privileges *except* TRUNCATE — i.e. everything PostgREST and
  clients actually use. RLS remains the real gate; this list does not weaken any
  per-row check. (The 34 broken files all needed SELECT/DML, never TRUNCATE.)
- **`service_role` keeps `GRANT ALL`** — it has zero table-level REVOKEs anywhere
  (grep-confirmed) and legitimately retains TRUNCATE per the spec-041 comment, so
  the raw broad grant is faithful for that role and re-opens nothing.
- **`ALL TABLES` / the explicit privilege list both cover views** (PostgREST-
  exposed views inherit table-class grants). No separate view statement needed.
  Views have no TRUNCATE concept, so omitting TRUNCATE from the list is a no-op
  for views.
- **The audit-table re-lock is mandatory.** `grant … on all tables` is a
  schema-wide sweep that hits `spec093_case_qty_backfill_audit` (a base table
  that survives its migration's transaction — `pg_tables` enumerates it). The
  immediately-following `revoke … from anon, authenticated` restores its
  deliberate lock. Emit the REVOKE *after* the broad table grant so it wins.
- **No retroactive `ALL ROUTINES` grant (approach 7a — unchanged).** The per-RPC
  `REVOKE EXECUTE … FROM anon, authenticated` hardening in ~15 migrations runs
  EARLIER than this migration (`20260618000000`), so a retroactive `grant all on
  all routines` here would sort AFTER those REVOKEs and RE-OPEN the
  deliberately-locked RPCs — a security regression (specs 016/061/095). Routines
  are therefore restored for FUTURE objects only, via the `ALTER DEFAULT
  PRIVILEGES … ON functions` line in §1b; existing functions keep exactly what
  their own migrations granted/revoked. See §7 risk 1.
- **Order within the file:** schema usage first; then the anon/authenticated
  table grant; then the service_role table grant; then the audit-table re-lock
  REVOKE (must follow the table grants); then the sequences grant. The two table
  grants are order-independent relative to each other, but the re-lock REVOKE
  MUST follow them.

#### 1b. Default privileges for future objects

> **CORRECTION (knock-on from §1a).** The prior version granted `ALL` on future
> tables to all three roles, which would re-introduce the TRUNCATE-escalation
> *hazard class* on every future table (each new table would be born with
> `TRUNCATE` granted to anon/authenticated, exactly the privilege the spec-041
> fix removed from `profiles`). To keep the no-TRUNCATE baseline durable, the
> future-objects table grant for anon/authenticated also OMITS TRUNCATE.
> service_role keeps `ALL` (it legitimately retains TRUNCATE).

```sql
-- FOR ROLE postgres is explicit-by-design: migrations run as postgres (finding
-- #4), so future tables are postgres-owned and only postgres's default
-- privileges govern their inheritance. Stating FOR ROLE postgres makes the
-- migration correct regardless of which role the apply session reports as
-- current_user, and self-documents the ownership assumption.

-- Future tables — anon/authenticated: same no-TRUNCATE privilege list as §1a,
-- so a future table inherits everything-except-TRUNCATE and the escalation
-- class can never be reintroduced by accident. A future table that genuinely
-- needs anon/authenticated TRUNCATE revoked could still do it explicitly (as
-- profiles did); defaulting to no-TRUNCATE is the safer baseline.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete, references, trigger
  on tables to anon, authenticated;

-- Future tables — service_role: ALL (retains TRUNCATE, matching §1a).
alter default privileges for role postgres in schema public
  grant all on tables to service_role;

-- Future sequences: ALL to all three (no competing per-sequence REVOKE class).
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

-- Future functions: ALL (= EXECUTE) to all three. This is the ONLY routine
-- restoration in the migration (no retroactive routines grant — §1a/§7 risk 1).
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
```

Notes:

- **`FOR ROLE postgres` is REQUIRED, not optional.** `ALTER DEFAULT PRIVILEGES`
  applies only to objects created *by the role named in `FOR ROLE`* (default:
  the current role running the ALTER). If the apply session's `current_user`
  ever differs from the table-creating role, a bare ALTER would silently fail to
  cover future tables. Pinning `FOR ROLE postgres` ties the default privileges
  to the role that actually owns future objects (finding #4). This directly
  answers Q3's architect note ("confirm the migration runs as the role whose
  future objects need the inheritance").
- **Future-table anon/authenticated grant OMITS TRUNCATE — same list as §1a.**
  This is the deliberate decision for the prompt's point 3: defaulting future
  tables to no-TRUNCATE-for-anon/authenticated makes the safer baseline
  automatic. A future table that legitimately needs anon/authenticated to hold
  TRUNCATE is vanishingly rare and can grant it explicitly; the common case
  (clients never TRUNCATE) is now the default and the escalation class is
  closed by construction for all future tables, not just `profiles`.
- **Object-class keyword is `functions`** in the `ALTER DEFAULT PRIVILEGES`
  grammar (not `routines` — that spelling is only valid in the `GRANT … ON ALL
  ROUTINES` form). Easy to trip on; flagged.
- **Audit-table-style future locks remain a per-table opt-in.** The
  default-privileges grant means a future table is born WITH the (no-TRUNCATE)
  grant; if a future table needs to be grant-locked like
  `spec093_case_qty_backfill_audit`, its own migration emits the `revoke …`
  explicitly (as spec 093 did). The default-privileges layer does not need to
  anticipate that.
- This is the half that makes the fix **durable**: every table a future
  migration adds inherits the appropriate grant automatically, so a later
  CLI bump can never re-strand a newly-added table (AC line 67–72, Q3).

#### 1c. Idempotency & prod safety

- `GRANT`, `ALTER DEFAULT PRIVILEGES … GRANT`, and the single targeted re-lock
  `REVOKE` are all **idempotent by definition** — re-applying is a harmless
  re-grant / re-revoke / no-op. Confirmed against AC line 73–77 and Q1(a).
- **Prod safety:** prod predates the image change and still carries the implicit
  grants AND both deliberate REVOKEs (spec-041's `profiles` TRUNCATE revoke and
  spec 093's audit-table revoke are already applied there). The corrected
  migration reproduces exactly that net-effective ACL:
  - the no-TRUNCATE table grant for anon/authenticated is a subset of what prod
    already holds (prod has the broad grant minus TRUNCATE on `profiles`), so
    re-granting SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER changes nothing;
  - the `service_role` `GRANT ALL` re-grants what it already holds;
  - the audit-table re-lock REVOKE removes a grant the audit table never had on
    prod (spec 093 already revoked it), so it is a no-op;
  - the `ALTER DEFAULT PRIVILEGES` rows are added to prod's catalog (harmless).
  **Net effect on prod: nil.** Safe no-op. This is why the prod-reconciliation
  ship step (Q1(b)) is safe to run.
- **The migration contains exactly ONE `REVOKE`** — the targeted audit-table
  re-lock in §1a — which restores a *pre-existing* deliberate lock that the
  broad table grant would otherwise have undone. It does NOT touch the per-RPC
  EXECUTE-REVOKE hardening (those live in their own migrations and remain in
  force — see §7 ordering). The `profiles` TRUNCATE lock is preserved not by a
  REVOKE here but by OMITTING TRUNCATE from the broad grant (at the source).

---

### 2. RLS impact

**Zero.** No `CREATE POLICY`, `ALTER POLICY`, `DROP POLICY`, or `ENABLE/DISABLE
ROW LEVEL SECURITY`. This confirms AC line 115–117 and the out-of-scope note
(line 145–153). Grants and policies are different layers; this migration touches
only the grant layer.

Critically — and this is the spec's sharpest nuance — **restoring the broad
table grant does NOT make any RLS-on table reachable that wasn't before.**
`username_resolve_rate_limit` and `_edge_auth` stay locked to
`anon`/`authenticated` via their (absent permissive) RLS policies. The grant is
the *outer* gate; RLS is the *inner* gate; both must pass. Restoring the outer
gate to its historical posture leaves the inner gate exactly as-is. The
`permissive_policy_lint.test.sql` probe (spec 053) continues to pass unchanged,
since no policy is added.

---

### 3. API contract / edge functions / db.ts / realtime / store

All of these are **N/A by design** — this is a CI-durability + schema-grant
change with no request-path surface. Stated explicitly so the reviewers can
confirm nothing was missed:

- **API contract (PostgREST vs RPC):** unchanged. No new table/view/RPC. The
  grants affect the `anon`/`authenticated`/`service_role` roles PostgREST and
  edge functions assume, but no endpoint is added or altered.
- **Edge function changes:** none. No `verify_jwt` change, no service-token
  logic. (`supabase/config.toml` untouched.)
- **`src/lib/db.ts` surface:** **no new helper.** No frontend calls this. No
  snake_case → camelCase mapping involved.
- **Realtime impact:** **none.** No `supabase_realtime` publication membership
  change. → **The `docker restart supabase_realtime_imr-inventory` ritual does
  NOT apply** (confirms Project-specific-notes line 253–254). Neither
  `store-{id}` nor `brand-{id}` replays anything; there is no data change.
- **Frontend store impact:** **none.** No slice of `src/store/useStore.ts`
  changes; the optimistic-then-revert / `notifyBackendError` pattern is not
  involved (no client write path).

---

### 4. The regression-guard pgTAP probe (Q5 — architect's call)

**File:** `supabase/tests/public_grants_explicit.test.sql`

**Decision: iterate-all-tables-with-allowlist**, modeled on spec 053's
`permissive_policy_lint.test.sql` (the spec's recommended shape, and the right
one here). Rationale over a hardcoded per-table list: the grant posture is a
*schema-wide invariant* — "every `public` base table grants `ALL` (or at least
the asserted privileges) to all three roles, except an explicit allowlist." An
iterate-all probe catches a future table that a developer adds **without** the
default-privileges inheritance taking effect (the exact durability failure mode
this spec exists to prevent), whereas a hardcoded list would silently not cover
new tables. This makes the probe self-maintaining: it asserts the *property*,
not an enumerated snapshot.

#### 4a. The assertion set

> **CORRECTION.** The probe now has TWO kinds of assertion: the **positive
> SELECT-sentinel** (unchanged in spirit, but now with a non-empty allowlist)
> AND new **negative assertions** that pin the two deliberate REVOKEs §1a
> preserves. The negative assertion on `profiles.TRUNCATE` is precisely the
> arm that would have caught the original flaw — the OLD probe asserted only
> positive SELECT and would have stayed green while the escalation re-opened.

**Positive arm — SELECT sentinel (with allowlist).** For every base table in
`public` (`pg_tables where schemaname = 'public'`) NOT on the grant-allowlist
(§4b), assert `has_table_privilege(<role>, '<schema.table>', 'SELECT')` is
`true` for roles `anon`, `authenticated`, `service_role`.

Why `SELECT` as the single positive sentinel rather than all of
SELECT/INSERT/UPDATE/DELETE: `SELECT` is the privilege the 34 broken files
actually needed (they read tables to reach the RLS check), and it is the
privilege arm (6) of the username-rate-limit test depends on. Asserting `SELECT`
for all three roles across all (non-allowlisted) tables is a faithful, low-noise
sentinel for "the broad grant is present." Note: `profiles` is NOT allowlisted —
it still holds SELECT for all three roles (only TRUNCATE was removed), so the
positive sentinel still passes on it. (The developer MAY additionally assert
`INSERT` for defense-in-depth; `SELECT`-per-role is the required floor. Keep the
plan count in sync — see 4d.)

**Negative arms — the two deliberate REVOKEs (NEW; required).** These convert
the two silent-regression surfaces §1a guards into guarded assertions:

1. **`profiles` TRUNCATE lock** (the arm that would have caught the flaw):
   - `has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')` is
     **`false`**.
   - `has_table_privilege('anon', 'public.profiles', 'TRUNCATE')` is **`false`**.
   - (Optionally, a positive counterpart: `has_table_privilege('service_role',
     'public.profiles', 'TRUNCATE')` is `true` — service_role legitimately
     retains it. Recommended, low cost, documents the asymmetry.)
   - The assertion message must point at
     `20260517040000_auth_can_see_store_brand_scope.sql:305` (spec-041 round-3
     anti-escalation) and at §1a's "OMIT TRUNCATE from the broad grant" decision:
     "if this fails, the broad table grant in
     `20260618000000_public_grants_explicit.sql` re-granted TRUNCATE to
     anon/authenticated — it must use the explicit no-TRUNCATE privilege list,
     NOT `GRANT ALL`. Re-opens the spec-041 TRUNCATE+INSERT escalation."
2. **`spec093_case_qty_backfill_audit` total grant lock:**
   - `has_table_privilege('authenticated', 'public.spec093_case_qty_backfill_audit',
     'SELECT')` is **`false`**, and the `anon` equivalent is **`false`**. (The
     developer MAY broaden to assert no INSERT/UPDATE/DELETE either; SELECT-false
     for both roles is the required floor — if SELECT is absent the broad grant
     was correctly re-locked.)
   - The assertion message must point at
     `20260602120000_spec093_case_qty_backfill.sql:68` and §1a's re-lock REVOKE:
     "if this fails, the broad table grant re-opened the spec-093 audit table —
     the §1a `revoke … from anon, authenticated` re-lock is missing or was
     emitted before the broad grant."

These negative arms are the mechanism that makes the probe *guard* the
correction rather than merely coexist with it.

#### 4b. The allowlist — and the crucial "grant present ≠ row-reachable" nuance

> **This is the single most important correctness point in the probe.**
>
> **CORRECTION.** The prior version asserted the allowlist is EMPTY ("there are
> currently ZERO such tables"). That was the second face of the §1a flaw: with
> the corrected migration, **`spec093_case_qty_backfill_audit` legitimately
> withholds the table grant** (it is `revoke all … from anon, authenticated`),
> so the SELECT-sentinel positive arm would (correctly) flag it as missing the
> grant unless it is allowlisted. The allowlist is **no longer empty: it has
> exactly one row.**

The allowlist is for tables that **intentionally withhold the table-level GRANT
from a Supabase role** — i.e. where `has_table_privilege` for the positive
SELECT sentinel is *expected* to be `false` BY DESIGN. There is a sharp,
two-category distinction the next developer must not conflate:

- **Category A — "no grant by design" → ON the allowlist.**
  `public.spec093_case_qty_backfill_audit` (spec 093,
  `20260602120000:68`): `revoke all … from anon, authenticated`. It receives NO
  table grant for those two roles — by deliberate design. The positive
  SELECT-sentinel must therefore SKIP it for `anon`/`authenticated` (allowlist),
  and the §4a negative arm asserts the absence is real. **This is the one and
  only current allowlist row** (and it is allowlisted only for `anon` and
  `authenticated`; `service_role` retains its grant, so do NOT allowlist the
  `(audit_table, service_role)` pair — assert SELECT-true there).

- **Category B — "has grant but RLS-unreachable" → OFF the allowlist.**
  `public.username_resolve_rate_limit` (spec 095) and `public._edge_auth` are
  RLS-enabled / no-permissive-policy, so `anon`/`authenticated` cannot reach a
  single row over PostgREST. BUT they still **hold the broad SELECT grant**
  (proven: `username_resolve_rate_limit.test.sql` arm (6) does `set local role
  authenticated; select count(*) …` and gets 0 rows, not `42501` — a missing
  grant would raise `42501`). They are unreachable via *RLS*, a different layer
  than the *grant*. **They MUST NOT be on the grant-allowlist** — the probe
  asserts the grant IS present on them, faithfully pinning the historical
  posture. Allowlisting them would wrongly stop asserting their grant and let a
  future grant-strand on them pass unnoticed.

The litmus test for an allowlist row: **"does this table run `REVOKE … on <table>
… from {anon|authenticated}` at the GRANT layer?"** Only `spec093_case_qty_
backfill_audit` answers yes. RLS-on-no-policy is NOT the test — that is Category
B and stays off the list.

→ **Seed the allowlist as a 1-row `VALUES` list** (the audit table, for the two
roles that lose the grant), exactly the shape spec 053 uses for its 2-row list.
The allowlist is keyed `(schemaname, tablename, rolename)` (NOT just table) so
the same table can be allowlisted for `anon`/`authenticated` while still asserted
for `service_role`. Document inline that:

> "An entry here means a table *intentionally* withholds the table-level GRANT
> from the named Supabase role at the GRANT layer (a deliberate `REVOKE … from
> <role>`) — NOT that the table is RLS-locked. RLS-locked / no-policy tables
> (`username_resolve_rate_limit`, `_edge_auth`) still receive the GRANT and are
> NOT listed here; they are unreachable via RLS, a different layer. The single
> seed row is `spec093_case_qty_backfill_audit` for `anon` and `authenticated`
> (spec 093 `revoke all`). Add a row only if a future migration deliberately
> `REVOKE`s a table-level grant from a role, with a one-line justification in
> the same PR — and add the matching §4a negative assertion."

This wording prevents the next developer from conflating the two layers — the
exact trap that produced the original §1a flaw (a blanket `GRANT ALL` + empty
allowlist would have re-opened the audit table AND asserted that re-opening was
correct).

#### 4c. Probe arm structure (modeled on spec 053)

> **CORRECTION.** Arms (1)/(2)'s detection CTE now subtracts the **role-keyed**
> 1-row allowlist (§4b), and two **new negative arms** (5)/(6) pin the deliberate
> REVOKEs (§4a). The synthetic-table arms (3)/(4) are unchanged in shape.

Recommended `plan(N)` arms, all inside `begin; … rollback;` with
`create extension if not exists pgtap;`:

1. **Positive (count):** the number of `(table, role)` pairs where
   `has_table_privilege(role, 'public.'||table, 'SELECT')` is `false`, **minus
   the role-keyed allowlist**, equals `0`. Iterate `pg_tables × (anon,
   authenticated, service_role)` via a cross join; the allowlist is keyed
   `(tablename, rolename)` so the `(spec093_case_qty_backfill_audit, anon)` and
   `(…, authenticated)` pairs are excluded while `(…, service_role)` is still
   asserted. (Mirror spec 053 arm (1)'s `where (…) not in (select * from
   allowlist)` shape, extended with the role column.)
2. **Positive (string_agg, log-readability):** `string_agg` of the offending
   `public.<table> / <role>` pairs (after the allowlist subtraction) is `''` —
   so a CI failure prints the exact missing grants without a re-query (the spec
   053 arm-2 pattern). Include a remediation hint in the assertion message: "the
   explicit-grant migration `20260618000000_public_grants_explicit.sql` did not
   cover this table — check `ALTER DEFAULT PRIVILEGES` inheritance, or add a
   role-keyed grant-allowlist row (+ a §4a negative assertion) if the omission
   is intentional."
3. **Negative (synthetic missing-grant guard):** create a throwaway
   `public.__grant_probe_*` table inside the transaction, **`REVOKE SELECT …
   FROM authenticated`** on it, run the same detection CTE, capture the hit
   count into a session var via `set_config`, **drop the synthetic table, THEN
   assert** the detector counted it as a violation (`= 1`). Drop-then-assert
   pattern (spec 053) to avoid the `savepoint+rollback` pgTAP-counter-loss
   footgun that `scripts/test-db.sh` flags as "planned N but ran M". Proves the
   probe catches a missing grant rather than vacuously passing.

   - **Subtlety:** a freshly created throwaway table is owned by the test's
     `current_user` (`postgres`). The `ALTER DEFAULT PRIVILEGES FOR ROLE
     postgres` from the migration means the synthetic table is **born with the
     (no-TRUNCATE) grant for anon/authenticated and ALL for service_role already
     attached**, so arm 3 must explicitly `REVOKE SELECT … FROM authenticated`
     to create the violation. Document this — it's the inverse of spec 053's arm
     3 (which *adds* a wide policy; here we *remove* a grant).
4. **Optional (false-positive guard, recommended):** create a second throwaway
   table, leave its inherited grant intact, assert the detector does NOT flag it
   (`= 0`). Mirrors spec 053 arm 4. Proves the detector isn't flagging
   correctly-granted tables. (Bonus: this incidentally proves the §1b future-
   table default-privileges grant fired — the synthetic table inherited SELECT
   without an explicit grant.)
5. **Negative (`profiles` TRUNCATE lock — the would-have-caught-the-flaw arm):**
   assert `has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')`
   is `false` AND `has_table_privilege('anon', 'public.profiles', 'TRUNCATE')`
   is `false`. (Recommended companion: `has_table_privilege('service_role',
   'public.profiles', 'TRUNCATE')` is `true`.) No synthetic table needed — these
   read the live catalog directly (§4e: `has_table_privilege` works for an
   arbitrary role regardless of session role). Message cites
   `20260517040000:305` + §1a OMIT-TRUNCATE decision (§4a).
6. **Negative (`spec093_case_qty_backfill_audit` grant lock):** assert
   `has_table_privilege('authenticated', 'public.spec093_case_qty_backfill_audit',
   'SELECT')` is `false` AND the `anon` equivalent is `false`. (Recommended
   companion: `has_table_privilege('service_role', …, 'SELECT')` is `true` —
   service_role keeps its grant.) Message cites `20260602120000:68` + §1a
   re-lock REVOKE (§4a). This arm and the allowlist row (§4b Category A) are two
   halves of one fact: the allowlist *stops the positive arm asserting the
   grant*, and this negative arm *asserts the grant is actually absent* — without
   it, a future drive-by that drops the §1a re-lock REVOKE would only be caught
   by the audit table re-appearing in the positive arm if it were also removed
   from the allowlist (it wouldn't be), so the negative arm is what truly guards
   the lock.

4d. **Plan-count discipline:** `scripts/test-db.sh` hard-fails on "planned N but
ran M" (the silent-skip guard). Keep `plan(N)` exactly equal to the number of
`select ok/is(...)` calls. Counting the REQUIRED floor: arms (1)+(2) =2, arm (3)
=1, arms (5)+(6) — each bundles two `ok(...)` calls (anon + authenticated) so =4
at minimum (or 6 if the two `service_role`-true companions are included). Plus
optional arm (4) =1 and any extra INSERT/`service_role` companions. The
developer fixes the final `plan(N)` to the exact count authored — do NOT
copy a number from this spec; count the `ok/is` calls in the file. A
multi-assertion arm using `select ok(a); select ok(b);` counts as 2 toward the
plan.

4e. **Probe runs as `postgres`** (the `test-db.sh` connection role).
`has_table_privilege('<role>', …)` queries the catalog for an *arbitrary* role
regardless of the session role, so no `set role` dance is needed for the
positive arms — cleaner and crash-free (the same reason `reports_anon_revoke`
switched off `set role` + `throws_ok` to `has_function_privilege` after the CI
segfault noted in that file's header).

---

### 5. CI change — the `supabase/setup-cli` target version (Q4 — architect's call)

**Recommendation: pin to a fixed `2.106.0`.**

`.github/workflows/test.yml` Track 2 (`db` job), the `version:` line currently at
~132:

```yaml
        with:
          version: 2.106.0   # was 2.105.0 (spec 097)
```

**Why `2.106.0` over the alternatives** (the trade-off the spec names, line
99–103 / Q4):

| Option | Verdict | Reasoning |
|---|---|---|
| **`2.106.0` (fixed)** | **Chosen** | `2.106.0` is the *first known-broken* version — the exact family that revoked the default grants. Pinning here makes the green run a **deterministic proof against the precise regression** (all 46 pass against the image that failed 34). It does not float, so a future CLI release can't silently re-perturb the proof. A *deliberate* future bump is a one-line PR with its own green run — which is exactly the controlled posture this spec is establishing. |
| current-latest-stable (e.g. whatever `2.10x` is newest) | Rejected | Proves nothing *specific* — if the newest happens to behave differently from 2.106.0, a green run no longer demonstrates the grants survive the *known-broken* image. Adds a moving target with no upside over the fixed pin. |
| `latest` | Rejected | This is the original sin (drift from 2.105.0 → 2.106.0 with no pin) that caused the 7-run/3-day blind failure. Re-accepting `latest` re-opens the exact silent-drift hole spec 097 exists to close. |

The fixed `2.106.0` pin is the minimum that satisfies the load-bearing AC
(line 104–109): "Track 2 GREEN against a CLI ≥ 2.106.0 … all 46 pgTAP files pass
against the image that previously failed 34." 47 files after this spec adds the
new probe — the developer should expect **47/47 green**.

**Comment block update** (AC line 110–114): replace the `version: 2.105.0`
rationale comment (~127–131) with text reflecting the new posture. Suggested
substance (developer authors the exact wording):

> Pinned to 2.106.0 — the first CLI family whose bundled Postgres image revokes
> the implicit `GRANT … ON public.* TO {anon, authenticated, service_role}`.
> Grants are now schema-explicit via
> `20260618000000_public_grants_explicit.sql`, so this image passes all pgTAP
> files. The pin was moved forward *deliberately* (spec 097); it is fixed (not
> `latest`) so a future CLI release can't silently re-perturb the grant proof —
> bump it in its own PR with a green Track 2 run. See CLAUDE.md
> local-green/CI-red note.

**Scope guard:** only the Track 2 `db` job's `version:` and its comment change.
The `jest`, `typecheck`, and `typecheck-base` jobs are **not touched** (they
don't boot Postgres) — confirms out-of-scope line 158–160.

---

### 6. Prod reconciliation (ship-checklist hard dependency)

Per AC line 78–87 / Q1(b) and `db-migrations-applied.yml` (spec 064): the new
migration's filename MUST appear in prod's
`supabase_migrations.schema_migrations`, or the bi-directional drift gate
hard-fails (local migration absent from prod). Because the body is an idempotent
no-op against prod's existing implicit grants (§1c), applying it is safe.

**Operational step (NOT the dashboard SQL editor — per the "don't drift"
rule):** `supabase db push` (or `supabase migration up` against the linked prod
project) after merge. This is a release-coordinator / human ship step, flagged
here so it isn't lost. It is **not** a runtime concern and **not** something the
developer does at code-authoring time — it's a deploy step.

---

### 7. Risks and tradeoffs (explicit)

1. **[Highest] Later blanket `GRANT` re-opening earlier deliberate `REVOKE`s —
   a SINGLE hazard class that hits BOTH tables AND routines.** Because this
   migration sorts at `20260618000000` — after every existing REVOKE — any
   blanket `GRANT ALL` it emits wins over an earlier per-object `REVOKE` and
   silently re-opens it. The prior design caught this for routines but
   **wrongly asserted the table side was clean.** A re-grep
   (`grep -rniE "revoke .* on .* from .*(anon|authenticated)"
   supabase/migrations/`, minus the `on function …`/EXECUTE lines) finds the
   COMPLETE set of TABLE-level REVOKEs from `anon`/`authenticated`: **exactly
   two.** Both must survive.

   **1.1 — TABLE REVOKEs (the corrected face; was the verified flaw).**
   - `20260517040000_auth_can_see_store_brand_scope.sql:305` —
     `revoke truncate on public.profiles from authenticated, anon;` (spec-041
     round-3 anti-escalation Critical; service_role deliberately retains
     TRUNCATE).
   - `20260602120000_spec093_case_qty_backfill.sql:68` —
     `revoke all on public.spec093_case_qty_backfill_audit from anon,
     authenticated;` (back-office audit table grant-locked).

     A blanket `grant all on all tables in schema public to anon, authenticated`
     re-opens BOTH: it re-grants `TRUNCATE` on `profiles` (re-arming the
     TRUNCATE+INSERT escalation) and SELECT/everything on the audit table. The
     developer's local run confirmed this: `auth_can_see_store_brand_scope.test
     .sql` arm 14 and `profiles_rls_sweep.test.sql` arm 12 FAILED on the flawed
     migration.

     **Resolution (chosen — see §1a):** for `anon`/`authenticated`, emit an
     explicit privilege list that **OMITS TRUNCATE** (`grant select, insert,
     update, delete, references, trigger`) instead of `GRANT ALL` — preserving
     the `profiles` lock *at the source* (no ordering dependency, and it hardens
     the whole TRUNCATE-escalation class for every table); for `service_role`
     emit `GRANT ALL` (it has zero table REVOKEs and retains TRUNCATE
     legitimately); and emit ONE targeted `revoke … from anon, authenticated`
     on `spec093_case_qty_backfill_audit` *after* the broad table grant to
     restore its deliberate lock. Rejected alternatives: (b) `GRANT ALL` then
     re-emit BOTH table REVOKEs — partially adopted only for the audit table
     (exactly one named table, not a recurring class), but rejected for
     `profiles` TRUNCATE because omitting a never-needed privilege class at the
     source is cleaner and broader than a re-emit; (c) an explicit
     exclusion/allowlist set inside the GRANT loop — rejected as more code than
     one REVOKE for one table.

   **1.2 — ROUTINE REVOKEs (the face the prior design handled correctly).**
   ~15 migrations do `REVOKE EXECUTE … FROM public, anon, authenticated` on
   specific SECURITY DEFINER RPCs (staff RPCs, report RPCs,
   `check_username_resolve_rate_limit`, etc.) as defense-in-depth. A retroactive
   `GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated,
   service_role` would sort AFTER all of those REVOKEs and RE-OPEN execute on
   RPCs that were deliberately locked down (a spec 016/061/095 regression).

     **Resolution (chosen — unchanged):** **NO retroactive `GRANT ALL ON ALL
     ROUTINES`.** Restore routines for FUTURE objects only via `ALTER DEFAULT
     PRIVILEGES … ON functions` (§1b). Rationale: the 34 failing files failed on
     **table** `permission denied`, not function EXECUTE (functions were already
     correctly granted/revoked by their own migrations), so a retroactive
     routines grant solves no observed failure and actively risks re-opening
     locked RPCs. Rejected: (b) `GRANT ALL ON ALL ROUTINES` then re-emit every
     per-RPC REVOKE — brittle, duplicates ~15 REVOKE blocks across many
     migrations (a *recurring* class), invites drift; (c) `GRANT ALL ON ALL
     ROUTINES` and accept the loosened EXECUTE — silently reverses hardening, a
     security regression.

   **Net shape (approach 7a, corrected):** retroactive grants on **TABLES**
   (no-TRUNCATE for anon/authenticated, ALL for service_role, with the audit
   table re-locked) + **SEQUENCES** (ALL, all three roles); `ALTER DEFAULT
   PRIVILEGES` on tables (same no-TRUNCATE split) + sequences + functions. No
   retroactive routines grant.

   **Probe alignment.** The probe (§4) asserts TABLE privileges only (no routine
   EXECUTE for anon/authenticated — that would contradict 1.2), AND now adds the
   two negative arms (§4a arms 5/6) that pin the two TABLE REVOKEs from 1.1. The
   negative-on-`profiles`-TRUNCATE arm is specifically the assertion that would
   have caught the original flaw. This keeps the probe and the migration aligned
   on BOTH faces of the hazard. *The developer must confirm this shape with the
   reviewers; if product later wants literal routine-grant fidelity that is a
   separate decision (1.2 alternative b).*

2. **`ALTER DEFAULT PRIVILEGES` ownership mismatch.** If a future migration ever
   creates a table as a role other than `postgres` (none do today; finding #4),
   the `FOR ROLE postgres` default privileges won't cover it and the probe (§4)
   would catch it as a missing grant on the next CI run — which is the
   *intended* loud failure, not a silent gap. Acceptable: the probe converts the
   risk into a targeted test failure.

3. **Probe performance on the seed dataset.** `has_table_privilege` is a catalog
   lookup, O(1) per call; iterating ~40 tables × 3 roles ≈ 120 lookups inside a
   single CTE is sub-millisecond. The 286 KB seed is irrelevant — the probe
   reads `pg_tables` + `pg_class` ACLs, not table rows. No performance concern.

4. **Edge-function cold-start:** N/A — no edge function touched.

5. **CLI pin staleness (the meta-risk).** A fixed `2.106.0` pin will itself age.
   This is acceptable and intended: the durability guarantee is that the
   *grants* are now explicit, so a future bump is a deliberate one-line PR whose
   green Track 2 run re-proves the posture. The pin is a controlled checkpoint,
   not a frozen liability (contrast with the un-pinned `latest` that caused this
   spec). Documented in the comment block (§5).

6. **Migration ordering vs. `_edge_auth` / rate-limit tables (Category B).**
   The grant migration sorts after both; both tables already exist when it runs,
   so the broad table grant (the no-TRUNCATE list for anon/authenticated, ALL
   for service_role) picks them up. No special handling. The probe then asserts
   their grant IS present (they are NOT allowlisted — they hold the grant and
   are unreachable via RLS, a different layer) — pinning the historical posture
   (§4b Category B). Contrast with `spec093_case_qty_backfill_audit` (Category A),
   which IS allowlisted because it genuinely withholds the grant.

7. **Migration ordering vs. the audit-table re-lock REVOKE.** Within the new
   migration, the §1a `revoke … from anon, authenticated` on
   `spec093_case_qty_backfill_audit` MUST be emitted AFTER the broad
   `grant … on all tables` (otherwise the broad grant, sorting later in the
   file, would undo the re-lock). Single-file ordering, fully under the
   developer's control — flagged so it isn't reordered by a drive-by edit. The
   §4 negative arm 6 guards against this being lost.

---

### 8. Files the developer will touch

> **Drift note (read before you start).** The developer already authored files
> encoding the SUPERSEDED design (blanket `GRANT ALL` on tables + empty
> allowlist) — they are on disk, unstaged — and applied+reversed the flawed
> migration in the local DB. **Overwrite** the migration and the probe with the
> corrected design below (§1a/§1b/§4). Do NOT preserve the `GRANT ALL ON ALL
> TABLES` line or the empty-allowlist probe. The architect did not touch those
> on-disk files (no Bash); the rewrite is yours.

- **New (overwrite the on-disk draft):**
  `supabase/migrations/20260618000000_public_grants_explicit.sql` (§1 —
  `GRANT USAGE ON SCHEMA public` to all three; explicit no-TRUNCATE table grant
  `select,insert,update,delete,references,trigger` to anon/authenticated +
  `GRANT ALL` table grant to service_role; targeted `revoke … from anon,
  authenticated` re-lock on `spec093_case_qty_backfill_audit` AFTER the table
  grant; `GRANT ALL` on sequences to all three; `ALTER DEFAULT PRIVILEGES FOR
  ROLE postgres` — no-TRUNCATE list on tables for anon/authenticated, ALL on
  tables for service_role, ALL on sequences + functions for all three; NO
  retroactive routines grant — approach 7(a) corrected).
- **New (overwrite the on-disk draft):**
  `supabase/tests/public_grants_explicit.test.sql` (§4 — iterate-all tables × 3
  roles `has_table_privilege` SELECT sentinel minus a **1-row role-keyed
  allowlist** seeding `spec093_case_qty_backfill_audit` for anon+authenticated;
  drop-then-assert synthetic negative arm; **two new negative arms** asserting
  `profiles` TRUNCATE is FALSE for anon/authenticated and the audit table's
  SELECT is FALSE for anon/authenticated; `plan(N)` counted to the exact
  `ok/is` calls authored — §4d).
- **Edit:** `.github/workflows/test.yml` Track 2 `db` job — `version: 2.106.0`
  and the comment block (§5).
- **Unchanged but confirmed:** `supabase/config.toml` (no edge/realtime change),
  `supabase/seed.sql` (no grant setup — no edit), `src/lib/db.ts`,
  `src/store/useStore.ts` (no client surface).
- **Operational (post-merge, not a code edit):** `supabase db push` to reconcile
  the migration into prod's `schema_migrations` (§6).
- **Optional doc touch (developer/reviewer call, AC line 132–135):** a one-line
  pointer in the CLAUDE.md "local-green/CI-red pgTAP asymmetry" note to this
  spec's explicit-grant migration as the durable fix. Defer if it expands scope.
  (Note: the CLAUDE.md "CI status check" bullet already references
  `20260618000000_public_grants_explicit.sql` by name — that reference is still
  accurate under the corrected design; the filename did not change.)

## Handoff
next_agent: backend-developer
prompt: REBUILD against the CORRECTED design (§1a/§1b/§4/§7 risk 1 were revised
  after a verified flaw — a blanket `GRANT ALL ON ALL TABLES` re-opened two
  deliberate table-level REVOKEs). Overwrite the on-disk draft migration and
  probe (they encode the superseded blanket-GRANT-ALL + empty-allowlist design;
  the flawed migration was already applied+reversed in the local DB — overwrite,
  do not patch). This is migration + pgTAP + CI only — no frontend.
  (1) Migration `supabase/migrations/20260618000000_public_grants_explicit.sql`,
  approach 7(a) CORRECTED: `GRANT USAGE ON SCHEMA public` to all three roles;
  for anon+authenticated a no-TRUNCATE table grant `grant select, insert,
  update, delete, references, trigger on all tables …` (NOT `GRANT ALL` — omitting
  TRUNCATE preserves the spec-041 `profiles` revoke at the source); for
  service_role `grant all on all tables …`; then a targeted `revoke select,
  insert, update, delete, references, trigger on
  public.spec093_case_qty_backfill_audit from anon, authenticated` AFTER the
  table grant (restores the spec-093 audit-table lock the broad grant undoes);
  `grant all on all sequences …` to all three; `ALTER DEFAULT PRIVILEGES FOR
  ROLE postgres` — no-TRUNCATE list on tables for anon/authenticated, ALL on
  tables for service_role, ALL on sequences + functions for all three; NO
  retroactive routines grant (preserves the ~15 per-RPC EXECUTE REVOKEs — §7
  risk 1.2).
  (2) Probe `supabase/tests/public_grants_explicit.test.sql` (§4): iterate-all
  tables × 3 roles `has_table_privilege` SELECT sentinel minus a 1-row
  role-keyed allowlist seeding `spec093_case_qty_backfill_audit` for
  anon+authenticated (NOT empty — that table genuinely withholds the grant;
  `username_resolve_rate_limit`/`_edge_auth` stay OFF the allowlist because they
  DO hold the grant); drop-then-assert synthetic negative arm; PLUS two new
  negative arms — `has_table_privilege('{authenticated,anon}','public.profiles',
  'TRUNCATE')` is FALSE (the arm that would have caught the flaw) and
  `has_table_privilege('{authenticated,anon}',
  'public.spec093_case_qty_backfill_audit','SELECT')` is FALSE; set `plan(N)` to
  the exact `ok/is` count authored (§4d — do not copy a number from the spec).
  (3) Bump `.github/workflows/test.yml` Track 2 `version:` to fixed `2.106.0`
  and rewrite its comment block (§5).
  Run `npm run test:db` locally — the new probe AND all 46 existing files must
  pass, INCLUDING `auth_can_see_store_brand_scope.test.sql` arm 14 and
  `profiles_rls_sweep.test.sql` arm 12 (they FAILED on the flawed migration; they
  must be green now). After implementation, set Status: READY_FOR_REVIEW and list
  files changed under ## Files changed. Release-step note: reconcile the migration
  into prod via `supabase db push` (§6) and confirm Track 2 GREEN on `main`
  against 2.106.0 before SHIP_READY (load-bearing proof, AC line 104–109).
payload_paths:
  - specs/097-explicit-authenticated-grants-ci-durability.md

---

## Files changed

> Rebuild against the CORRECTED design (§1a/§1b/§4/§7 risk 1). The two on-disk
> draft files encoding the SUPERSEDED design (blanket `GRANT ALL ON ALL TABLES`
> + empty allowlist) were OVERWRITTEN, not patched. The CI workflow + CLAUDE.md
> edits from the prior run were verified to already match the corrected design
> (corrected §5 / §8) and left as-is.

### Migrations
- `supabase/migrations/20260618000000_public_grants_explicit.sql` — OVERWRITTEN
  with the corrected approach 7(a): `grant usage on schema public` to all three
  roles; for anon/authenticated a no-TRUNCATE table grant
  (`select, insert, update, delete, references, trigger on all tables …`) — NOT
  `GRANT ALL`, omitting TRUNCATE preserves the spec-041 `profiles` revoke at the
  source; for service_role `grant all on all tables …`; then a targeted
  `revoke select, insert, update, delete, references, trigger on
  public.spec093_case_qty_backfill_audit from anon, authenticated` AFTER the
  table grant (restores the spec-093 audit-table lock the broad grant undoes);
  `grant all on all sequences …` to all three; `ALTER DEFAULT PRIVILEGES FOR
  ROLE postgres` — no-TRUNCATE list on tables for anon/authenticated, ALL on
  tables for service_role, ALL on sequences + functions for all three; NO
  retroactive routines grant (preserves the ~15 per-RPC EXECUTE REVOKEs).

### pgTAP tests
- `supabase/tests/public_grants_explicit.test.sql` — OVERWRITTEN with the
  corrected probe (`plan(10)`): iterate-all tables × 3 roles
  `has_table_privilege` SELECT sentinel minus a **1-row role-keyed allowlist**
  seeding `spec093_case_qty_backfill_audit` for anon + authenticated (Category A);
  `username_resolve_rate_limit` / `_edge_auth` stay OFF the allowlist (Category B
  — they hold the grant, are RLS-unreachable); drop-then-assert synthetic
  negative arm (3) + false-positive arm (4); PLUS two new negative arms — arm (5)
  `profiles` TRUNCATE is FALSE for authenticated/anon (the arm that would have
  caught the flaw), TRUE for service_role; arm (6) audit-table SELECT is FALSE
  for authenticated/anon, TRUE for service_role.

### CI
- `.github/workflows/test.yml` — VERIFIED (prior-run edit): Track 2 `db` job
  `version: 2.106.0` (fixed pin) + rewritten comment block (corrected §5). Left
  as-is — matches the corrected design. The other three jobs untouched.

### Docs
- `CLAUDE.md` — VERIFIED (prior-run edit): a single-line pointer in the
  "CI status check after every push to `main`" note that spec 097's
  `20260618000000_public_grants_explicit.sql` durably fixes the CLI grant-drift
  class of the local-green/CI-red asymmetry. Left as-is — matches corrected §8.

### Unchanged but confirmed
- `supabase/config.toml` (no edge/realtime change), `supabase/seed.sql` (no grant
  setup), `src/lib/db.ts`, `src/store/useStore.ts` (no client surface).

### Local validation
- `npm run test:db` → **47/47 green**, including the new probe
  (`public_grants_explicit.test.sql`, 10 assertions = `plan(10)`) and the two
  guards that FAILED on the flawed migration, now green:
  `auth_can_see_store_brand_scope.test.sql` arm 14 (14 assertions) and
  `profiles_rls_sweep.test.sql` arm 12 (12 assertions).
- Meta-test (load-bearing-ness proof): temporarily re-applying the flawed
  `grant all on all tables … to anon, authenticated` made arms 5a/5b + 6a/6b go
  red (and 5c/6c stay green), confirming the negative arms genuinely catch the
  superseded design's regression. Local DB restored to the corrected
  net-effective posture afterward.
- Spot-checks against the live local catalog:
  `profiles` TRUNCATE → f (anon/authenticated), t (service_role);
  `spec093_case_qty_backfill_audit` SELECT → f (anon/authenticated), t
  (service_role); `stores` / `username_resolve_rate_limit` / `_edge_auth` SELECT
  → t (authenticated).

### Pending by design (NOT done at code-authoring time — release steps)
- **Prod reconciliation (§6):** `supabase db push` / `migration up` to record
  `20260618000000` in prod's `schema_migrations` (idempotent no-op body — §1c).
  The USER runs this post-merge; the developer does NOT push to prod.
- **Load-bearing CI proof (AC line 104–109):** the definitive 2.106.0 evidence
  is the post-push Track 2 run on `main` (the local image is the OLD
  `postgres:17.6.1.084` that grants ALL by default, so several grant lines are
  local no-ops). Confirm Track 2 GREEN against 2.106.0 on `main` before
  SHIP_READY.
