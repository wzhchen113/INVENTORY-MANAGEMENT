# Spec 041: Brand-scoped per-store visibility (tighten auth_can_see_store)

Status: READY_FOR_REVIEW

## User story
As a brand-admin (e.g. "Bobby", role `admin`, `profiles.brand_id` = 2AM PROJECT),
I want the admin app to scope every store-picker and per-store read/write to my
brand so that I cannot accidentally see or modify a sibling brand's data
(Baltimore Seafood stores, their inventory, EOD submissions, audit log, etc.).
Super-admins must retain global visibility; staff/user accounts must continue
to be limited to stores granted via `user_stores`.

## Bug being fixed (production)
On prod, Bobby — a regular brand-admin assigned to 2AM PROJECT — can see
Baltimore Seafood stores in the TitleBar store picker
([src/components/cmd/TitleBar.tsx:43](../src/components/cmd/TitleBar.tsx)) and
can issue PostgREST reads against any per-store table for those foreign stores.

Root cause: `public.auth_can_see_store(p_store_id)` (defined in
[supabase/migrations/20260504173035_per_store_rls_hardening.sql:31](../supabase/migrations/20260504173035_per_store_rls_hardening.sql),
later updated in
[supabase/migrations/20260509000000_multi_brand_schema_rls.sql:216](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql))
short-circuits to `auth_is_admin() = true` for any user whose JWT
`app_metadata.role` is in `('admin','master')`, regardless of brand. The
helper never consults `profiles.brand_id` vs `stores.brand_id`. Bobby
therefore passes the second OR-arm for every store row across every brand,
which cascades through every RLS policy that calls `auth_can_see_store`.

## Acceptance criteria
- [ ] `public.auth_can_see_store(p_store_id uuid)` is redefined so that:
      (a) `auth_is_super_admin()` callers return `true` for every existing
      store; (b) `auth_is_admin()` callers return `true` ONLY when the
      target store's `brand_id` passes `auth_can_see_brand(s.brand_id)`;
      (c) any other caller returns `true` only when a row exists in
      `user_stores` for `(auth.uid(), p_store_id)`.
- [ ] The redefinition lives in a new migration at exactly
      `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`.
- [ ] Migration is `CREATE OR REPLACE FUNCTION` (no signature change), keeps
      `language sql stable security definer set search_path = public, auth`,
      and re-applies the existing
      `grant execute on function public.auth_can_see_store(uuid) to authenticated, anon`
      grant (so privilege state is byte-identical to today).
- [ ] No RLS policy text needs to change. Every policy that calls
      `auth_can_see_store(store_id)` continues to compile and the helper's
      truthiness simply tightens at the call site.
- [ ] pgTAP test at `supabase/tests/auth_can_see_store_brand_scope.test.sql`
      covers (1) admin-of-own-brand sees own-brand store → `true`; (2)
      admin-of-own-brand does NOT see foreign-brand store → `false`; (3)
      super_admin sees both → `true` for every store row; (4) staff/user
      with a `user_stores` grant sees the granted store → `true`; (5)
      staff/user with NO grant for a store → `false`. Tests run under
      `supabase test db` via [scripts/test-db.sh](../scripts/test-db.sh).
- [ ] After the migration, a PostgREST GET as Bobby against
      `/rest/v1/stores?select=*` returns ONLY rows where `brand_id` matches
      his `profiles.brand_id`. (Smoke-able via shell smoke; not required as
      a CI gate.)
- [ ] After the migration, a PostgREST GET as Bobby against
      `/rest/v1/inventory_items?store_id=eq.<foreign-store>` returns `[]`
      (RLS filter, not a 4xx). Same expected for `eod_submissions`,
      `waste_log`, `audit_log` (where `store_id` is not null),
      `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`,
      `inventory_counts`, `inventory_count_entries`, `order_schedule`,
      `report_runs`, `report_run_runs`/related artifacts gated through the
      helper.
- [ ] All existing pgTAP tests under `supabase/tests/*.test.sql` continue
      to pass after the migration runs. (Spec 041's brief notes the
      previous draft of this helper passed 26/26 — architect to confirm.)
- [ ] No client-side code changes ship with this spec. The TitleBar's
      `accessibleStores` filter at
      [src/components/cmd/TitleBar.tsx:43](../src/components/cmd/TitleBar.tsx)
      becomes correct-by-construction because the data plane no longer
      hydrates foreign-brand stores into the Zustand `stores` slice.

## Visibility model (decided — not negotiable)
- **super_admin** (`profiles.role = 'super_admin'`) → sees every store in
  every brand. Unchanged.
- **admin / master** (JWT `app_metadata.role`) → sees every store in
  their OWN brand only, where "own brand" is `profiles.brand_id`.
  Brand-admins implicitly see every store in their brand without needing
  a `user_stores` grant. This is the tightening — previously they saw
  every store everywhere.
- **staff / user** → sees only stores granted via `user_stores`. Unchanged.
  (Note: staff use a separate app; this branch is reached when a non-admin
  authenticates against the admin app.)

## In scope
- Redefining `public.auth_can_see_store(p_store_id uuid)` to add the
  brand-scope check for the admin/master branch.
- A single new migration file at the path above.
- A new pgTAP test file at `supabase/tests/auth_can_see_store_brand_scope.test.sql`.
- Verifying every existing RLS policy that calls `auth_can_see_store`
  continues to compile and the truthiness tightens correctly.
- Optionally adding a `comment on function public.auth_can_see_store` that
  documents the three-arm semantics and links back to this spec.

## Out of scope (explicitly)
- **No client-side changes.** The TitleBar bypass, `useStore.ts`'s
  `accessibleStores`, the Cmd `Stores` section, and any other client
  filter stay byte-identical. Rationale: client-side filters are
  belt-and-suspenders only — once RLS filters the data plane, those
  filters operate on a pre-filtered set and stay correct.
- **No staff-app changes.** Staff app lives in a sibling repo. If staff
  go through `staff-*` edge functions (service-token bearer, not JWT),
  they bypass `auth.uid()` anyway and this helper does not affect them.
- **No edge function changes.** Edge functions that gate on caller role
  via `requireAdminCaller()` rely on `auth_is_privileged()` /
  `ADMIN_ROLES`, not `auth_can_see_store`. Brand-scoping the edge-function
  ADMIN gate is a separate (larger) spec.
- **No user-stores grant changes.** The grant table stays the canonical
  per-row mechanism for staff/user accounts. Brand-admins simply skip it.
- **No `app.json` slug changes.** Unrelated.
- **No new role.** No `brand_admin` distinct from `admin`. The brand
  scoping is derived from `profiles.brand_id`, not a separate role.
- **No data migration for users.** This spec does not add or remove
  `user_stores` rows; it only changes the helper that consults them.
  Pre-flight backfill for NULL `profiles.brand_id` rows is flagged as an
  open question for the architect (see "Open questions for architect").
- **No realtime channel changes.** Realtime publication membership is
  unchanged; clients still subscribe to `store-{id}` and `brand-{id}`
  channels, and the filtering happens via RLS at SELECT time.
- **No retroactive coverage of other RLS helpers.** If `auth_is_admin()`
  is used directly (without going through `auth_can_see_store`) elsewhere,
  fixing those call sites is a separate spec — they continue to grant
  cross-brand access until tightened separately. Architect should flag any
  such call sites for follow-up but not fix them here.

## Tables affected by this fix (enumerated for verification)
Every table whose RLS policy invokes `auth_can_see_store(store_id)` (or
the parent-row variant) tightens automatically when the helper is
redefined. The full list, walked from `supabase/migrations/`:

**Direct (policy gates on `auth_can_see_store(store_id)`):**
- `public.inventory_items` (per_store_rls_hardening:43-61)
- `public.eod_submissions` (per_store_rls_hardening:63-81)
- `public.waste_log` (per_store_rls_hardening:134-152)
- `public.audit_log` (per_store_rls_hardening:154-181 — `store_id IS NOT NULL` branch only; `store_id IS NULL` branch stays on `auth_is_admin()` cross-cutting events)
- `public.purchase_orders` (per_store_rls_hardening:183-201)
- `public.pos_imports` (per_store_rls_hardening:253-271)
- `public.inventory_counts` (inventory_counts:139-154)
- `public.order_schedule` (order_schedule_super_admin_rls:24-26, READ policy only — WRITE stays on `auth_is_privileged()`)
- `public.report_runs` (report_runs:114-161, both `for select` and admin variants)

**Parent-scoped (policy gates via EXISTS on a parent that calls `auth_can_see_store`):**
- `public.eod_entries` (per_store_rls_hardening:83-132, scoped through `eod_submissions.store_id`)
- `public.po_items` (per_store_rls_hardening:203-251, scoped through `purchase_orders.store_id`)
- `public.pos_import_items` (per_store_rls_hardening:273-321, scoped through `pos_imports.store_id`)
- `public.inventory_count_entries` (inventory_counts:156-211, scoped through `inventory_counts.store_id`)

**RPC entry-points that gate FIRST on `auth_can_see_store`:**
- `public.submit_inventory_count` (inventory_counts:253)
- `public.report_run_*` family (`report_run_cogs`, `report_run_variance`,
  `report_run_variance_multivendor`, `report_run_waste`, `report_run_vendor`,
  `report_run_velocity`, `report_run_custom`, `report_runs` outer dispatcher,
  `report_reorder_list`) — each calls `auth_can_see_store(p_store_id)` at
  the top of its body and raises `42501` on false. After this spec, those
  RPCs reject Bobby for foreign-brand `p_store_id` arguments without any
  code change to the RPCs themselves.

**The `stores` table itself** routes through
`auth_can_see_store(id)` in
[supabase/migrations/20260509000000_multi_brand_schema_rls.sql:618](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql),
which is the policy that controls the store-picker leak Bobby hit.

Architect must walk `supabase/migrations/` one more time before writing
the design doc to confirm no table was missed; the list above was
grep-derived but the architect owns the formal enumeration in the design
doc.

## Helper redefinition (reference shape — architect finalizes)
```sql
create or replace function public.auth_can_see_store(p_store_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or (
      public.auth_is_admin()
      and exists (
        select 1 from public.stores s
         where s.id = p_store_id
           and public.auth_can_see_brand(s.brand_id)
      )
    )
    or exists (
      select 1 from public.user_stores
       where user_id = auth.uid()
         and store_id = p_store_id
    );
$$;

grant execute on function public.auth_can_see_store(uuid) to authenticated, anon;
```

Notes for architect:
- The three OR-arms are short-circuit-friendly: super_admin short-circuits
  the whole thing; admin-of-own-brand short-circuits before the
  `user_stores` lookup; staff fall through to the existing membership
  arm.
- The inner `exists` does a single point-lookup against `public.stores`
  by primary key, then defers to `auth_can_see_brand`, which itself is a
  point-lookup against `public.profiles`. Both have indexes per 012a
  (`profiles_brand_id_idx`, `profiles_role_idx`).
- The function is `SECURITY DEFINER` and explicitly sets `search_path`,
  so RLS-recursion-via-helper cannot subvert visibility.
- `auth_can_see_brand(NULL)` returns `false` (its `exists` fails on NULL).
  This is the behavior the operational concern in open questions
  references — see Q4.

## Open questions resolved (from PM brief)
- Q: Visibility model for brand-admins? → A: Admins/masters see every store
  in their OWN brand. Implicit, no `user_stores` grant needed. Staff
  remain strict-per-store via `user_stores`. Super-admin sees all.
- Q: Migration filename / slot? → A:
  `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`.
  Slot 040000 on 2026-05-17 is free per `ls supabase/migrations/`.
- Q: Where does the test live? → A:
  `supabase/tests/auth_can_see_store_brand_scope.test.sql`, run via
  `scripts/test-db.sh` under the existing pgTAP harness.
- Q: Should the client-side filter at TitleBar:43 be removed? → A: No.
  It becomes redundant but harmless; removing it is a separate cleanup
  spec if wanted, not part of this security fix.

## Open questions for architect
1. **Existing pgTAP tests under the OLD loose semantics.** Walk
   `supabase/tests/*.test.sql` and flag any test that PROMOTES a
   brand-admin and asserts they can read a cross-brand store / per-store
   row. The previous draft pgTAP run reportedly produced 26/26 pass with
   the new helper, suggesting no regressions — but the architect should
   confirm explicitly and list any tests that need adjustment (with the
   fix) in the design doc.
2. **SECURITY DEFINER RPCs that bypass RLS and call `auth_can_see_store`
   internally.** The `report_run_*` family explicitly calls the helper as
   a first-line gate and raises 42501 on false. Those continue to work,
   but their semantics tighten — Bobby calling
   `report_run_cogs(p_store_id => <foreign-brand-store>)` now returns
   42501 instead of returning rows. Architect should confirm this is
   intentional (it is) and list every RPC affected.
3. **Per-store views / materialized views.** Likely none, but confirm.
   Search for `create view`/`create materialized view` that may need
   refreshing or rewriting.
4. **Operational concern: live users with `profiles.brand_id IS NULL`.**
   `auth_can_see_brand(NULL)` returns false, so any admin/master whose
   `brand_id` is NULL after this migration loses ALL admin store
   visibility — they keep only their explicit `user_stores` grants (which
   for brand-admins is typically empty). Architect must specify a
   pre-flight check (count + per-row report) and decide whether the
   migration body should (a) refuse to apply if any NULL admin/master
   rows exist; (b) backfill them to a default brand; or (c) accept the
   regression with a noted operational follow-up. The 012a migration
   already backfilled all profiles to the 2AM brand at landing time, so
   a NULL row would indicate drift since then.
5. **`user_stores` as the canonical grant model.** Confirm no other grant
   mechanism shipped recently that this spec would miss. (Cross-check
   specs 029-040 to be sure.)
6. **Comment-on-function and audit trail.** Architect can choose whether
   to add `comment on function public.auth_can_see_store(uuid) is '...'`
   linking back to spec 041 in the migration.

## Dependencies
- Existing helpers: `public.auth_is_super_admin()`, `public.auth_is_admin()`,
  `public.auth_can_see_brand(uuid)` — all defined in
  [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql).
- Existing table: `public.stores(id uuid pk, brand_id uuid)`.
- Existing table: `public.profiles(id uuid pk, brand_id uuid, role text)`.
- pgTAP harness: [scripts/test-db.sh](../scripts/test-db.sh).
- No new edge functions, no new TS modules, no new migrations beyond the
  one named above.

## Project-specific notes
- Cmd UI section / legacy: No UI change. The TitleBar store picker
  ([src/components/cmd/TitleBar.tsx](../src/components/cmd/TitleBar.tsx))
  is the symptom site but the fix is server-side only.
- Per-store or admin-global: Per-store, but with new brand-derived
  implicit visibility for admin/master. Super-admin remains admin-global.
- Realtime channels touched: None directly. Clients subscribing to
  `store-{id}` for a foreign-brand store will simply fetch zero rows when
  they reload (the RLS filter applies on SELECT). The realtime
  publication membership itself is unchanged. Architect should note this
  in the design doc as a realtime-safety acknowledgement.
- Migrations needed: Yes — exactly one,
  `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`.
- Edge functions touched: None. Edge functions that call PostgREST as the
  user's JWT pick up the new helper semantics for free.
- Web/native scope: Both. The fix is entirely in Postgres, so it applies
  uniformly to the Vercel web bundle and the EAS native bundle.
- Tests track: pgTAP (DB test track per spec 022). New file:
  `supabase/tests/auth_can_see_store_brand_scope.test.sql`. No jest or
  shell-smoke additions required for this spec.

## Backend / architecture design

### 0. Resolution of architect open questions

**Q1 — Existing pgTAP tests under the OLD loose semantics.** Walked
`supabase/tests/*.test.sql`. **No existing test depends on the loose
semantics.** Two reasons:

- The seed (`supabase/seed.sql:178-201`) only contains a single brand
  (`2a000000-0000-0000-0000-000000000001`, "2AM PROJECT"). Both the admin
  fixture (`11111111-…`, brand A) and the master fixture (`33333333-…`,
  brand A) have `profiles.brand_id = brand A`, and the seed also inserts
  `user_stores` rows that grant admin + master access to every store
  (`seed.sql:190-196`). After this migration the admin-of-own-brand arm
  passes for them on every existing store, AND the `user_stores`
  membership arm is also satisfied — so every existing test that
  impersonates admin/master keeps passing. The "cross-brand" denial path
  is exactly what this spec exists to enable, and there is no existing
  seed row that would exercise it.
- Tests that exercise the negative path (`report_run_custom.test.sql`,
  `report_run_velocity.test.sql`, `inventory_count_entries_check_store.test.sql`)
  do so via the **manager** fixture (`22222222-…`, role `'user'`,
  brand A) — the manager has explicit `user_stores` rows only for Towson
  and Frederick, so the test asserts that manager → Charles fails. That
  path goes through the third OR-arm (`user_stores` lookup), which is
  byte-identical before and after this migration. Unchanged.

Conclusion: 26/26 pre-existing tests stay green. No test edits required.

**Q2 — SECURITY DEFINER RPCs that call `auth_can_see_store` internally.**
Enumerated via `grep`:

- `public.submit_inventory_count` (`inventory_counts:253`)
- `public.report_run` outer dispatcher (`report_runs:177`)
- `public.report_run_cogs` (`report_runs:232`)
- `public.report_run_variance` (`report_run_variance:143`)
- `public.report_run_variance_multivendor` (`report_run_variance_multivendor:88`)
- `public.report_run_waste` (`report_run_waste:89, 435`)
- `public.report_run_vendor` (`report_run_vendor:124, 487`)
- `public.report_run_velocity` (`report_run_velocity` — same shape)
- `public.report_run_custom` (`report_run_custom:139, 326`)
- `public.report_reorder_list` (`report_reorder_list:119`)

All ten check `auth_can_see_store(p_store_id)` as the FIRST statement
and `raise exception … using errcode = '42501'` on false. After this
spec, those RPCs reject `p_store_id` for a foreign-brand store with
42501 for Bobby. **Intentional** — the helper is the single source of
truth for "can this caller touch this store", and the RPC gate's
purpose is to surface RLS denial as a clean error class (rather than
returning empty data after an expensive query). Tightening the helper
tightens the gate by construction. No RPC body changes required.

The eleventh privileged helper, `public.assert_not_last_of_role`
(`assert_not_last_of_role.sql:39`), explicitly does NOT call
`auth_can_see_store` — its comment block at line 22-31 is explicit:
"`auth_can_see_store() / brand RLS would otherwise return a brand-scoped
count for a brand-admin caller, which is the wrong predicate.`" That
helper bypasses RLS by `security definer` design, and is correctly
unaffected by this spec. Confirmed.

**Q3 — Per-store views / materialized views.** `grep -i 'create
(materialized )?view'` against `supabase/migrations/` returns zero
matches. No view rewrites or `REFRESH MATERIALIZED VIEW` are needed.

**Q4 — Operational concern: live admin/master with `profiles.brand_id IS
NULL`.** This is **structurally impossible** at the database layer
today. Migration `20260509000000_multi_brand_schema_rls.sql:327-331`
contains a post-backfill invariant check that raises if any
admin/master row has NULL brand_id, and lines 341-348 install a CHECK
constraint `profiles_role_brand_consistent` that enforces the invariant
going forward:

```sql
add constraint profiles_role_brand_consistent
check (
  (role = 'super_admin' and brand_id is null)
  or (role = 'admin'       and brand_id is not null)
  or (role = 'master'      and brand_id is not null)
  or (role = 'user')
);
```

So an admin/master profile **cannot** have NULL brand_id without
deliberate constraint disable via psql — which violates project
convention. **Decision: NO backfill block in the migration.** The CHECK
constraint is the contract. I will, however, add a defensive
pre-flight `DO` block at the top of the new migration that re-asserts
the invariant — same idiom as `20260509000000:327-331`. If the assertion
fails, the migration refuses to apply and tells the operator which rows
to fix. This is belt-and-suspenders, not a backfill — the constraint
already prevents the bad state.

Pre-flight wording:

```sql
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin', 'master') and brand_id is null
  ) then
    raise exception
      '041: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;
```

**Q5 — `user_stores` as the canonical grant model.** Walked specs
029-040 + every migration after 012a (`20260509000000`) for grant
mechanisms.

- `user_stores` is the only per-row store-grant table. No alternative
  grant table was added.
- `profiles.brand_id` is the per-row brand-grant mechanism (via the
  `profiles_role_brand_consistent` CHECK and the `auth_can_see_brand`
  helper).
- The 012a migration (`:357-379`) added a `user_stores_brand_match`
  trigger that REJECTS inserts where the user's brand and the store's
  brand differ. So existing `user_stores` rows cannot already be
  cross-brand (the migration's pre-flight at line 256-271 asserted
  zero cross-brand rows at the time, and the trigger blocks future
  inserts).
- No edge function bypasses `user_stores` for store-level grants. The
  `staff-*` and `pwa-catalog` functions use a service-token bearer and
  never set `auth.uid()`, so they pass through PostgREST's
  service_role context — they're not subject to this helper at all.

Conclusion: the three OR-arms in the new helper are complete. No
additional grant tables to consider.

**Q6 — Comment-on-function and audit trail.** Optional per the spec. I
recommend adding the `comment on function …` clause — there is no
existing precedent in `supabase/migrations/` (zero matches for
`^comment on function`), but a single-line comment pinning the
semantics to spec 041 will help the next architect avoid re-derivation.
Developer to include or omit at their discretion. Either is acceptable
for AC purposes.

### 1. Postgres function diff

**File:** `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
(slot confirmed free — `ls supabase/migrations/2026051*.sql` shows
`20260517030000_copy_brand_catalog.sql` as the latest 2026-05-17 entry).

**Shape** — adopt the PM reference verbatim with two adjustments
(pre-flight + explicit grant):

```sql
-- pre-flight (Q4 belt-and-suspenders)
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin','master') and brand_id is null
  ) then
    raise exception
      '041: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;

create or replace function public.auth_can_see_store(p_store_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or (
      public.auth_is_admin()
      and exists (
        select 1
          from public.stores s
         where s.id = p_store_id
           and public.auth_can_see_brand(s.brand_id)
      )
    )
    or exists (
      select 1
        from public.user_stores
       where user_id = auth.uid()
         and store_id = p_store_id
    );
$$;

-- Mirror the explicit grant pattern from auth_can_see_brand /
-- auth_is_super_admin / auth_is_privileged in 012a (:241-243). The
-- helper has been callable today via the implicit PUBLIC EXECUTE
-- default — this line just makes the grant state explicit and
-- byte-aligned with the sibling helpers. Idempotent.
grant execute on function public.auth_can_see_store(uuid) to authenticated, anon;

-- Optional but recommended (Q6).
comment on function public.auth_can_see_store(uuid) is
  'spec 041: super_admin sees all; admin/master sees stores in their own brand (via auth_can_see_brand); other roles see only stores granted via user_stores.';
```

**Attribute sanity-check (against AC and existing 012a definition):**

| Attribute              | Current (012a:216-227)              | New (this spec)                  | Match? |
|------------------------|-------------------------------------|----------------------------------|--------|
| Signature              | `(p_store_id uuid) returns boolean` | `(p_store_id uuid) returns boolean` | yes |
| Language               | `sql`                                | `sql`                             | yes |
| Volatility             | `stable`                             | `stable`                          | yes |
| Security context       | `security definer`                   | `security definer`                | yes |
| `search_path`          | `public, auth`                       | `public, auth`                    | yes |
| `STRICT` modifier      | not set                              | not set                           | yes |
| Grant audience         | implicit PUBLIC                      | explicit `authenticated, anon`    | tighter (and matches sibling helpers) |

**`auth_can_see_brand(NULL)` behavior** — verified against
`20260509000000:200-210`. The function is `select super_admin OR exists
(… brand_id = p_brand_id)`. `brand_id = NULL` is `NULL` (never true) in
SQL, so the EXISTS clause is false for any non-super-admin. A
stores row with `brand_id IS NULL` would therefore be invisible to
admins via the second arm. **This is safe** — `stores.brand_id` is
defined with the brand FK and is not nullable in the seed data; if a
store somehow had NULL brand_id, only super-admins or explicit
`user_stores` members would see it, which is the conservative default.
No NULL-handling addition needed.

**Short-circuit ordering** — Postgres evaluates `OR` left-to-right and
short-circuits. The fastest arm (`auth_is_super_admin()`, a single
`profiles` point-lookup on `auth.uid()`) fires first; the medium-cost
arm (`auth_is_admin()` + two point-lookups: `stores` by id, then
`profiles` by id) fires second; the variable-cost arm (`user_stores`
exists scan, expected single-row for the typical caller) fires last.
Indexes confirmed present: `profiles_brand_id_idx`,
`profiles_role_idx` (012a), `stores_pkey` (init schema), and
`user_stores(user_id, store_id)` is the primary key per init schema.

### 2. Cascade table list (verified complete)

Every place the helper is invoked in an RLS policy or RPC body. PM's
list is correct except for **one omission**: `report_definitions` has
its own per-store policies (`report_runs.sql:146-161`), not just being
a parent of `report_runs`. Added below.

**Direct policy invocations** (table.policy → migration:line):

| Table                          | Migration                                                     |
|--------------------------------|---------------------------------------------------------------|
| `inventory_items`              | `per_store_rls_hardening:43-61`                                |
| `eod_submissions` (SELECT/INSERT/DELETE) | `per_store_rls_hardening:63-81`                       |
| `eod_submissions` (UPDATE, privileged) | `eod_submissions_consistency:156-159`                  |
| `eod_entries` (SELECT/INSERT/DELETE) | `per_store_rls_hardening:83-132` (parent-via-EXISTS)     |
| `eod_entries` (UPDATE, privileged) | `eod_submissions_consistency:164-181` (parent-via-EXISTS) |
| `waste_log`                    | `per_store_rls_hardening:134-152`                              |
| `audit_log` (SELECT/INSERT)    | `per_store_rls_hardening:154-172` (NULL branch on `auth_is_admin()` is intentionally unchanged — see spec §"Tables affected") |
| `audit_log` (UPDATE/DELETE)    | gates on `auth_is_admin()` only, not `auth_can_see_store` — unaffected and intentional |
| `purchase_orders`              | `per_store_rls_hardening:183-201`                              |
| `po_items`                     | `per_store_rls_hardening:203-251` (parent-via-EXISTS)          |
| `pos_imports`                  | `per_store_rls_hardening:253-271`                              |
| `pos_import_items`             | `per_store_rls_hardening:273-321` (parent-via-EXISTS)          |
| `stores` (SELECT only)         | `multi_brand_schema_rls:616-618`                               |
| `order_schedule` (SELECT only) | `order_schedule_super_admin_rls:24-26`                         |
| `report_runs`                  | `report_runs:114-132`                                          |
| **`report_definitions`** (PM omitted) | **`report_runs:146-161`**                                |
| `inventory_counts`             | `inventory_counts:139-154`                                     |
| `inventory_count_entries`      | `inventory_counts:166-211` (parent-via-EXISTS)                 |

**RPC entry-point invocations** (function → migration:line of the
`if not public.auth_can_see_store(p_store_id) then` gate):

| RPC                                    | Migration:line                              |
|----------------------------------------|----------------------------------------------|
| `submit_inventory_count`               | `inventory_counts:253`                       |
| `report_run` outer dispatcher          | `report_runs:177`                            |
| `report_run_cogs`                      | `report_runs:232`                            |
| `report_run_variance`                  | `report_run_variance:143`                    |
| `report_run_variance_multivendor`      | `report_run_variance_multivendor:88`         |
| `report_run_waste` (+ inner)           | `report_run_waste:89, 435`                   |
| `report_run_vendor` (+ inner)          | `report_run_vendor:124, 487`                 |
| `report_run_velocity`                  | `report_run_velocity` (same shape)           |
| `report_run_custom` (+ inner)          | `report_run_custom:139, 326`                 |
| `report_reorder_list`                  | `report_reorder_list:119`                    |

**No constraint or view references**. Checked
`grep -i 'create (materialized )?view'` and `grep CHECK.*auth_can_see_store`
across migrations — zero matches.

### 3. RLS impact

No policy text changes in this migration. Every existing policy that
calls `public.auth_can_see_store(store_id)` simply gets tighter
truthiness for the admin/master OR-arm. Super-admin and staff arms are
unchanged. The cascade is purely via helper redefinition.

### 4. API contract

No PostgREST or RPC signature changes. The behavior at the wire is:

- `GET /rest/v1/stores` as Bobby → returns only rows with
  `stores.brand_id = profiles.brand_id` (his own brand) plus any rows
  granted via `user_stores` (typically none for a brand-admin).
- `GET /rest/v1/inventory_items?store_id=eq.<foreign-store>` as Bobby
  → `200 []` (RLS-filtered, not a 4xx).
- `POST /rest/v1/rpc/report_run_cogs` with `p_store_id` = foreign store
  → `42501` from the in-function gate. Same shape as today for an
  out-of-membership store, just covers more cases.

### 5. Edge function changes

None. The 10 functions in `supabase/functions/` either:

- Call PostgREST with the user's JWT, in which case they inherit the
  tightened helper for free (any function that hits per-store tables
  via the user's JWT now sees only own-brand rows for a brand-admin
  caller); or
- Bypass JWT entirely (the `staff-*` and `pwa-catalog` functions use a
  service-token bearer and run under service_role, which bypasses RLS
  by Supabase convention).

No `verify_jwt` toggle changes. No new edge function. No service-token
validation changes.

### 6. `src/lib/db.ts` surface

**Zero changes.** All existing helpers continue to work — RLS does the
filtering at the data plane. The Zustand `stores` slice will hydrate
fewer rows for a brand-admin caller after the migration, and every
downstream `accessibleStores` derivation, store-picker render, and
realtime filter operates on the pre-filtered set. The signature of
every `db.*` helper is unchanged.

### 7. Realtime impact

- **Publication membership: UNCHANGED.** No `alter publication
  supabase_realtime add/drop table` in this migration. **No docker
  restart of `supabase_realtime_imr-inventory` required.** Confirmed by
  the design: this migration only redefines a function; the
  publication's table list is byte-identical before and after.
- **RLS-filtered broadcast semantics.** Supabase Realtime evaluates RLS
  per subscriber on every broadcast. Today, a brand-admin subscribed to
  `store-{foreign}` would receive INSERTs/UPDATEs because the loose
  helper passed them through. After this migration, the same subscriber
  receives nothing for foreign-brand row changes — the helper returns
  false and the row is filtered out before transmission. **This is the
  intended behavior** (it is the cross-brand leak Bobby experienced),
  not a regression. Clients that mistakenly subscribed to a foreign
  channel will simply stop receiving events; the next reload will not
  re-hydrate those rows either. No client-side change required.
- **`store-{id}` and `brand-{id}` channel names** are content-routing
  conventions in the client, not RLS hooks. Helper redefinition does
  not affect channel routing — it affects per-row visibility within
  those channels.

### 8. Frontend store impact

Zero. The optimistic-then-revert pattern in
`src/store/useStore.ts` does not change. `notifyBackendError` will
surface 42501 from the RPC gate for foreign-store calls the same way
it does today for non-member stores. The TitleBar `isAdmin` bypass at
`src/components/cmd/TitleBar.tsx:43` becomes correct-by-construction
once RLS filters the `stores` query result down to the admin's own
brand — no edit needed (and explicitly out of scope per spec).

### 9. pgTAP test plan

**File:** `supabase/tests/auth_can_see_store_brand_scope.test.sql`
(executed by `scripts/test-db.sh` under the existing pgTAP harness).

**Strategy.** Mirror the hermetic begin/rollback + `request.jwt.claims`
impersonation pattern from
`supabase/tests/recipe_categories_super_admin_rls.test.sql` and the
in-transaction-promote-to-super_admin trick from
`supabase/tests/delete_last_privileged_guard.test.sql:95-97`.

Seed contains a single brand. To exercise the cross-brand denial path,
the test transaction MUST insert a second brand row and a foreign-brand
store row — both under `set local role postgres` for the fixture phase,
then `rollback` to keep the seed unchanged.

**Test plan (6 arms, expand the PM's 5-arm plan by one):**

```
plan(6)

fixture (inside begin; … rollback;):
  - insert brand B   (id = b1000000-0000-0000-0000-000000000001, name 'Foreign Brand')
  - insert store_b   (id = b1000001-...,           brand_id = brand B)
  - seed store_a     = Towson (already in seed,    brand_id = brand A)
  - seed admin       = 11111111-… (brand A, role admin)
  - seed manager     = 22222222-… (brand A, role user, user_stores: Towson + Frederick)
  - seed master      = 33333333-… (brand A, role master)
  - re-attestation: admin / master have user_stores rows for all
    seed brand-A stores, but NOT for store_b (cross-brand insert
    would be blocked by user_stores_brand_match trigger anyway)

(1) Arm — admin own-brand pass.
    JWT { sub: admin_id, app_metadata.role: 'admin' }
    is(auth_can_see_store(store_a /* Towson */),  true,
       'admin sees own-brand store via auth_is_admin() + auth_can_see_brand() arm')

(2) Arm — admin foreign-brand fail.
    JWT same as (1)
    is(auth_can_see_store(store_b /* Foreign Brand */), false,
       'admin does NOT see foreign-brand store (no user_stores row, brand mismatch)')

(3) Arm — master own-brand pass.
    JWT { sub: master_id, app_metadata.role: 'master' }
    is(auth_can_see_store(store_a), true,
       'master sees own-brand store (same arm as admin, app_metadata.role=master also passes auth_is_admin())')

(4) Arm — super_admin all-brand pass.
    Promote seed master to super_admin in-txn (set role='super_admin',
    brand_id = NULL — required by profiles_role_brand_consistent CHECK).
    Pattern from delete_last_privileged_guard.test.sql:95-97.
    JWT { sub: master_id, app_metadata.role: 'super_admin' } (note: role
    is ignored by auth_is_super_admin() — that helper reads profiles.role
    NOT JWT — but we set the JWT to match for cleanliness)
    is(auth_can_see_store(store_a),  true, 'super_admin sees brand A store')
    is(auth_can_see_store(store_b),  true, 'super_admin sees brand B store')
    (counts as TWO test_ok results — adjust plan() to 7 if we keep both,
    or collapse via a single bool_and over a VALUES list to one ok())

(5) Arm — staff with user_stores grant pass.
    JWT { sub: manager_id, app_metadata.role: 'user' }
    is(auth_can_see_store(towson_id /* manager has user_stores grant */),
       true, 'staff with user_stores grant sees granted store')

(6) Arm — staff without user_stores grant fail.
    JWT same as (5). manager has NO grant for store_b (also no grant for
    Charles, but Charles is brand A so technically the admin arm could
    apply if role were admin — manager is role 'user', so cleanest test is
    against a store with no grant. Use Charles for clarity.).
    is(auth_can_see_store(charles_id),
       false, 'staff with no user_stores grant does not see store')
```

Resolved test-plan count: **6 plan slots** (collapse arm 4 to a single
`ok(public.auth_can_see_store(a) and public.auth_can_see_store(b), …)`
to fit 6 cleanly; or expand `plan(7)` if the developer prefers granular
output. Either is acceptable.

**Optional 7th arm — NULL brand_id admin behavior.** Skip. Forcing the
test to create an admin row with NULL brand_id requires disabling
`profiles_role_brand_consistent`, which is invasive even inside a
hermetic transaction (`alter table … drop constraint` + rollback works,
but the test becomes about CHECK-constraint mechanics, not the helper).
The pre-flight assertion in the migration body covers the NULL case
operationally; the constraint covers it structurally.

**Hermetic isolation.** `begin; … rollback;` at file top/bottom. Brand
B and store_b never persist beyond the test transaction. Mirrors
`delete_last_privileged_guard.test.sql:35,126`.

**JWT-impersonation pattern.** Use `set local role authenticated` +
`select set_config('request.jwt.claims', jsonb_build_object(...)::text,
true)` immediately before each test arm. Copy verbatim from
`recipe_categories_super_admin_rls.test.sql:65-74` (the cleanest
reference shape in the test corpus).

## Profile column-write lockdown

Added in response to review-round 1 (security-auditor's
live-verified privilege-escalation finding). Spec 041's original
design ended at §9 — helper redefinition + pgTAP. The auditor
demonstrated that the redefinition alone is insufficient: by
promoting `profiles.brand_id` to a security boundary for the
first time, the spec silently activated a pre-existing wide-open
self-write path on `public.profiles` (the "Users can update own
profile" RLS policy at
`supabase/migrations/20260502071736_remote_schema.sql:417-422` has
no `with check` clause), which allows a brand-admin to PATCH their
own `brand_id` and immediately defeat the entire tightening. The
auditor also demonstrated a chained "brand-bounce" variant where
the attacker flips brand_id, INSERTs a `user_stores` grant on a
foreign store (now permitted by the `user_stores_brand_match`
trigger because brand_ids agree), then flips brand_id back —
leaving a permanent cross-brand grant via the third OR-arm of the
helper that survives session reset and JWT refresh.

### Trigger design

The fix is a single BEFORE-UPDATE trigger on `public.profiles`
that rejects self-mutation of two security-load-bearing columns
(`brand_id` and `role`) by non-super_admin callers. Bundled into
the existing `20260517040000_auth_can_see_store_brand_scope.sql`
migration to keep the migration log clean (one migration changes
all the load-bearing surface in lockstep).

```sql
create or replace function public.assert_brand_id_immutable_for_self()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE'
     and old.id = auth.uid()
     and not public.auth_is_super_admin() then
    if old.brand_id is distinct from new.brand_id then
      raise exception
        'brand_id is read-only for self-edits (super_admin only)';
    end if;
    if old.role is distinct from new.role then
      raise exception
        'role is read-only for self-edits (super_admin only)';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists profiles_self_brand_lock on public.profiles;
create trigger profiles_self_brand_lock
  before update on public.profiles
  for each row
  execute function public.assert_brand_id_immutable_for_self();
```

### Rationale and design choices

- **Self-edit detection via `old.id = auth.uid()`.** Only blocks
  self-writes. An admin (or super_admin) updating ANOTHER user's
  profile through the existing "Admins can update any profile" or
  `super_admin_manage_profiles` policies is unaffected.
- **super_admin bypass via `auth_is_super_admin()`.** Super_admin
  callers retain the ability to change their own (and any
  other user's) `brand_id` / `role`. The bypass reads
  `profiles.role` (server-side), NOT the JWT — so it cannot be
  forged from the client.
- **`role` column also locked down (defense-in-depth).** A
  brand-admin who could self-promote to `super_admin` via PATCH
  would bypass every brand-scoped policy in one step. The
  `profiles_sync_role` trigger at
  `supabase/migrations/20260424211732_recover_undeclared_tables.sql:135-137`
  mirrors `profiles.role` into `app_metadata.role`, so a
  successful self-write to `role` would also propagate into the
  JWT. Blocking the self-write here is the right place — earlier
  in the chain than the mirror.
- **Trigger over `with check`.** A trigger is additive — it
  doesn't require dropping and recreating the existing
  "Users can update own profile" or "Admins can update any
  profile" policies (both of which are outside spec 041's stated
  scope). The trigger also catches BOTH policy paths in one place.
- **`set search_path = public, auth`** matches the sibling
  trigger function `user_stores_brand_match` at
  `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:361`.
- **NULL `auth.uid()` is safe.** When the postgres superuser
  runs an UPDATE (migrations, seed, ops backfill), `auth.uid()`
  returns NULL. `old.id = NULL` is NULL (never true), so the
  lockdown branch is bypassed — matching the
  `user_stores_brand_match` trigger's NULL-handling pattern.

### Pre-flight DO block change

The earlier draft used `raise warning`. The architect's design
contract was `raise exception` — fail-closed if the
`profiles_role_brand_consistent` CHECK has somehow drifted. Per
the code-reviewer and backend-architect Critical findings, this
migration now uses `raise exception` and simplifies the block:

```sql
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin','master') and brand_id is null
  ) then
    raise exception
      '041: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;
```

The `v_bad_count` variable from the earlier draft is removed —
`if exists (…) then raise exception` is the canonical idiom for a
fail-closed pre-flight, and the count is not needed in the error
message. The misleading comment "Same idiom as 012a:327-331" (which
incorrectly cited the warning idiom) is also removed; the new
comment block above the DO documents the exception semantics.

### Delete-path lockdown

Added in response to review-round 2 (security-auditor's
live-verified Critical that the UPDATE trigger alone was
insufficient). The new finding:

**Why the UPDATE trigger was insufficient.** Round-1's
`profiles_self_brand_lock` BEFORE-UPDATE trigger closes the
direct `UPDATE profiles SET brand_id = …` path. But a brand-admin
can reach the same end-state via DELETE+INSERT:

1. `DELETE FROM public.profiles WHERE id = auth.uid()` — admitted
   by the existing "Admins can delete profiles" policy at
   `supabase/migrations/20260502071736_remote_schema.sql`
   (gated on JWT `app_metadata.role IN ('admin','master')`).
2. `INSERT INTO public.profiles (id, name, role, brand_id)
   VALUES (auth.uid(), 'Reborn', 'super_admin', NULL)` —
   admitted by the "Anyone can insert own profile or admin can
   insert any" policy (gated on `id = auth.uid()`).

Same end-state as the round-1 UPDATE attack — full cross-brand
visibility, AND in the role variant, **same-session super_admin
self-escalation** (because `auth_is_super_admin()` reads
`profiles.role` server-side, no JWT refresh required).

**The fix: a companion BEFORE-DELETE trigger.** Block step 1, and
the chain dies before step 2 can land:

```sql
create or replace function public.assert_profile_self_delete_blocked()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if old.id = auth.uid() and not public.auth_is_super_admin() then
    raise exception 'profile self-delete is not permitted (use admin delete flow)';
  end if;
  return old;
end
$$;

drop trigger if exists profiles_self_delete_lock on public.profiles;
create trigger profiles_self_delete_lock
  before delete on public.profiles
  for each row
  execute function public.assert_profile_self_delete_blocked();
```

**Rationale and design choices:**

- **Self-DELETE detection via `old.id = auth.uid()`.** Mirrors
  the UPDATE trigger's `old.id = auth.uid()` guard. An admin
  (or super_admin) deleting another user's profile through the
  existing "Admins can delete profiles" policy is unaffected.
- **super_admin bypass via `auth_is_super_admin()`.** Super_admin
  callers retain the ability to delete any profile, including
  their own. (The "delete own super_admin profile" case is
  upstream-gated by the spec 031 `assert_not_last_of_role`
  guard called from the `delete-user` edge function before any
  destructive op — see
  `supabase/functions/delete-user/index.ts`.)
- **No companion BEFORE-INSERT trigger needed.** The PK
  constraint on `profiles.id` plus the FK to `auth.users.id`
  together make a standalone self-INSERT (without first
  deleting the existing profile row) impractical:
  - The PK collision blocks the second INSERT while the
    original row exists.
  - The FK to `auth.users` is what populates `profiles.id` in
    the first place (via the existing signup trigger). A
    brand-new INSERT would need a corresponding `auth.users`
    row, which requires the service-role admin flow.
  - So blocking the DELETE alone closes the attack chain at
    step 1 — the INSERT cannot proceed without it.
- **Trigger over RLS policy edit.** Same rationale as the
  UPDATE trigger above — additive, scoped, and avoids editing
  the "Admins can delete profiles" policy (which would expand
  the spec 041 surface). The trigger fires regardless of which
  policy admitted the DELETE.
- **`set search_path = public, auth`** matches the sibling
  trigger function pattern.
- **NULL `auth.uid()` is safe.** Migration / seed DELETEs run
  under the postgres superuser; `auth.uid()` returns NULL, the
  `old.id = NULL` comparison is NULL (never true), and the
  lockdown branch is skipped.

**Test coverage.** Three new pgTAP arms (11-13) in
`supabase/tests/auth_can_see_store_brand_scope.test.sql`:

- (11) brand-admin self-DELETE rejected by the trigger
  (`throws_ok` on stable message `'profile self-delete is not
  permitted (use admin delete flow)'`).
- (12) in-txn-promoted super_admin can DELETE another user's
  profile (positive control — trigger does not over-block). Run
  under `reset role` (postgres) with super_admin JWT claims so
  the trigger's behavior is isolated from the RLS policy stack
  (which has no super_admin-specific DELETE policy on
  `public.profiles` today).
- (13) end-to-end DELETE+INSERT escalation chain dies at step 1
  — brand-admin DELETE on own profile fails with the stable
  message, so the INSERT step is never reached. We don't need
  to attempt the INSERT; per the design rationale above the PK
  + FK constraints make it impractical anyway.

### Truncate-path lockdown

Added in response to review-round 3 (security-auditor's
live-verified Critical that BOTH the round-1 UPDATE trigger AND
the round-2 DELETE trigger missed). This is the third
"same end-state, different verb" iteration of the same underlying
weakness — UPDATE → DELETE+INSERT → TRUNCATE+INSERT.

**Why the round-1 UPDATE trigger AND the round-2 DELETE trigger
were both insufficient.** TRUNCATE does NOT fire row-level
triggers per documented Postgres semantics — it has its own
statement-level TRUNCATE trigger event class. Both round-1's
`profiles_self_brand_lock` (BEFORE-UPDATE) and round-2's
`profiles_self_delete_lock` (BEFORE-DELETE) are row-level
triggers and never execute for TRUNCATE. A brand-admin can:

1. `TRUNCATE TABLE public.profiles CASCADE` — admitted because
   Supabase's default grants include TRUNCATE on every public
   table to `authenticated` and `anon`. Round-2's DELETE trigger
   never fires.
2. `INSERT INTO public.profiles (id, name, role, brand_id)
   VALUES (auth.uid(), 'Reborn', 'super_admin', NULL)` — admitted
   by the "Anyone can insert own profile or admin can insert any"
   policy. PK collision is no longer a barrier because step 1
   emptied the table.

Same end-state as the round-1 UPDATE and round-2 DELETE+INSERT
attacks: full cross-brand visibility AND same-session super_admin
self-escalation (`auth_is_super_admin()` reads `profiles.role`
server-side, no JWT refresh required).

**The fix: REVOKE TRUNCATE.** A single-line REVOKE at the bottom
of the same migration closes the chain at step 1:

```sql
revoke truncate on public.profiles from authenticated, anon;
```

**Rationale for REVOKE over a BEFORE-TRUNCATE trigger:**

- **Minimum surface.** No legitimate client flow calls TRUNCATE
  on profiles — zero call sites across `src/`,
  `supabase/functions/`, and the migration history. The REVOKE
  removes the privilege at the grant layer, so the TRUNCATE
  attempt is rejected before any trigger or RLS policy
  evaluation. A BEFORE-TRUNCATE trigger would be a heavier
  defense for an attack chain that doesn't need to support any
  legitimate flow.
- **service_role retains TRUNCATE.** The REVOKE targets
  `authenticated` and `anon` only. `service_role` (used by
  migrations, seed flows, and the postgres superuser bypass)
  is unaffected. No legitimate flow is broken.
- **Postgres semantics.** TRUNCATE not firing row-level triggers
  is documented Postgres behavior, not a quirk. Future
  authentication or trigger refactors won't accidentally
  re-enable the bypass via the row-level trigger layer.
- **Round-1 and round-2 triggers remain in place.** Together
  with the REVOKE, they cover the three verb-bound paths
  (UPDATE / DELETE / TRUNCATE) that lead to the same end-state.
  Each defense is independent and verb-bound; together they
  close the surface the security audit identified across rounds
  1, 2, and 3.

**Test coverage.** One new pgTAP arm (14) in
`supabase/tests/auth_can_see_store_brand_scope.test.sql`:

- (14) brand-admin TRUNCATE on `public.profiles` is rejected
  with `permission denied for table profiles` / SQLSTATE
  `42501` (insufficient_privilege). pgTAP's 4-arg `throws_ok`
  pins both the SQLSTATE and the message. Without the REVOKE,
  the TRUNCATE would succeed and the INSERT step would land
  the same escalation the round-1 and round-2 attacks reached.
  This arm guards against a regression where a future migration
  re-grants TRUNCATE on `public.profiles`.

### Known follow-up work (security-auditor High items)

These were flagged by security-auditor as High but explicitly
deferred by the release-coordinator as out-of-scope for spec 041:

1. **`order_schedule` WRITE policy** at
   `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql:28-31`
   gates only on `auth_is_privileged()` with no
   `auth_can_see_store(store_id)` check. Brand-admin Bobby can
   still INSERT/UPDATE/DELETE `order_schedule` rows for
   foreign-brand stores. Closes READ via this spec but not WRITE.
2. **"Admins can update any profile"** policy at
   `supabase/migrations/20260502071736_remote_schema.sql:390-395`
   permits a brand-A admin to PATCH a brand-B user's `name`,
   `email`, `notifications_enabled`, etc. The role-mirror trigger
   prevents role escalation, but other PII / preference columns
   are wide-open. Out of scope per the spec's
   "auth_is_admin() call sites fixed separately" carve-out.

Both are tracked as follow-up specs.

### 10. Pre-flight checklist (operational, for the deployer)

Manual verification recommended on prod before applying. The migration
body also asserts these, but verifying ahead lets the operator fix
issues without a failed deploy:

1. **No NULL-brand_id admin/master rows.** Run:
   ```sql
   select id, name, role from public.profiles
    where role in ('admin','master') and brand_id is null;
   ```
   Expected: empty. If non-empty, the migration's pre-flight DO block
   will raise on apply.

2. **`stores.brand_id` populated for every row.** Run:
   ```sql
   select id, name from public.stores where brand_id is null;
   ```
   Expected: empty. A NULL `stores.brand_id` would make the row
   invisible to admins via the second arm post-migration (only
   super_admin or explicit user_stores members could see it). Not
   blocked by the migration body — operationally surfaced here.

3. **No cross-brand `user_stores` rows.** Already enforced by the
   012a trigger, but verify:
   ```sql
   select count(*) from public.user_stores us
    join public.profiles p on p.id = us.user_id
    join public.stores   s on s.id = us.store_id
    where p.brand_id is not null and s.brand_id is not null
      and p.brand_id <> s.brand_id;
   ```
   Expected: 0.

4. **`docker restart supabase_realtime_imr-inventory` — NOT required.**
   The publication membership is unchanged. Standard `supabase
   migration up` is sufficient.

### 11. Risks and tradeoffs

- **Risk: hidden RLS gap on a table not enumerated.** Mitigated by the
  cascade-table walk above. I re-walked `grep auth_can_see_store
  supabase/migrations/`, cross-referenced against the PM's enumerated
  list, and found one omission (`report_definitions`) which is now
  listed. Reasonable confidence the list is complete; if a future
  migration adds a new per-store table with a custom (non-helper) RLS
  predicate, this spec does not catch it — but every existing table
  routed through the helper IS caught.

- **Risk: a privileged RPC short-circuits visibility differently than
  RLS.** Audited the 10 RPCs that gate on `auth_can_see_store`. All
  ten use the same `if not public.auth_can_see_store(p_store_id) then
  raise … 42501` shape as the first statement; none consult
  `auth_is_admin()` separately or implement a fallback. Helper
  tightening will tighten these RPCs by construction.

- **Risk: super_admin promotion gap.** The `profiles_sync_role`
  trigger (`supabase/migrations/…`) mirrors `profiles.role` into JWT
  `app_metadata.role` on every profile update, including for
  super_admin. So a freshly-promoted super_admin's JWT will read
  `app_metadata.role = 'super_admin'`, which is **not** in
  `('admin','master')` and so does NOT pass `auth_is_admin()`. The
  new helper's first arm (`auth_is_super_admin()`) reads
  `profiles.role` directly and short-circuits correctly. Tested in
  `recipe_categories_super_admin_rls.test.sql:65-85`. No regression.

- **Performance risk on the 286 KB seed.** The new helper adds at
  worst two index point-lookups (`stores` by `id` PK, then `profiles`
  by `auth.uid()` via PK + the `brand_id` filter). Both are O(1).
  `auth_is_admin()` is a JWT scan (in-memory). The helper is `stable`,
  so the planner can hoist its evaluation. Net: a few microseconds
  per row evaluated by an RLS policy. The 286 KB seed has hundreds of
  `inventory_items` rows; the cost is negligible.

- **Edge-function cold-start.** No new edge functions. No change to
  cold-start surface.

- **Migration ordering.** Strictly additive function replacement +
  `comment on` + `grant execute`. The `create or replace function …`
  syntax is byte-safe re-runnable. No table locks. Apply order with
  respect to other migrations is irrelevant — every other migration
  in the chain either pre-defines the helper (012a) or references it
  in RLS without redefining it.

- **Rollback safety.** If the migration is reverted by hand, the
  helper falls back to the 012a definition
  (`super_admin or auth_is_admin() or user_stores-exists`). All
  callers compile unchanged. Loose-but-functional. The only signature
  that would be broken is if 012a were also rolled back — that's not
  in scope.

### 12. Files the developer will create / modify

Strictly two files (unchanged file count across the original ship +
the review-round 1, round-2, and round-3 fixes — all deltas land in
the same two files):

1. **NEW** `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
   — pre-flight DO block (now `raise exception`, per review-round 1
   fix), helper redefinition, explicit grant, comment-on-function,
   the `assert_brand_id_immutable_for_self()` function +
   `profiles_self_brand_lock` BEFORE-UPDATE trigger (per
   review-round 1 fix), the
   `assert_profile_self_delete_blocked()` function +
   `profiles_self_delete_lock` BEFORE-DELETE trigger (per
   review-round 2 fix — see "Delete-path lockdown" above), AND
   the `revoke truncate on public.profiles from authenticated,
   anon` statement (per review-round 3 fix — see "Truncate-path
   lockdown" above).

2. **NEW** `supabase/tests/auth_can_see_store_brand_scope.test.sql`
   — hermetic pgTAP file, plan(14), fixtures + 14 arms. Arms (1)-(6)
   per §9 above; arms (7)-(10) added per review-round 1 fix; arms
   (11)-(13) added per review-round 2 fix; arm (14) added per
   review-round 3 fix:
   - (7) brand-admin self-PATCH on `profiles.brand_id` is rejected
     by the UPDATE trigger.
   - (8) brand-admin self-PATCH on `profiles.role` is rejected.
   - (9) super_admin can UPDATE another user's `brand_id`
     (positive control — UPDATE trigger doesn't over-block).
   - (10) end-to-end: after a rejected self-PATCH, the brand-admin
     STILL cannot see foreign-brand stores.
   - (11) [round-2 NEW] brand-admin self-DELETE on profiles is
     rejected by the new `profiles_self_delete_lock` trigger
     (`throws_ok` on stable message `'profile self-delete is not
     permitted (use admin delete flow)'`).
   - (12) [round-2 NEW] super_admin can DELETE another user's
     profile (positive control — DELETE trigger doesn't
     over-block). Run under `reset role` (postgres) with
     super_admin JWT claims to isolate the trigger from the
     RLS policy stack.
   - (13) [round-2 NEW] end-to-end DELETE+INSERT escalation chain
     dies at step 1 — brand-admin DELETE on own profile fails,
     INSERT step never reached.
   - (14) [round-3 NEW] brand-admin TRUNCATE on `public.profiles`
     is rejected with `permission denied for table profiles` /
     SQLSTATE 42501 by the new REVOKE — closes the
     TRUNCATE+INSERT bypass that neither the round-1 UPDATE
     trigger nor the round-2 DELETE trigger covered.

No edits to `src/lib/db.ts`, no edits to `src/store/useStore.ts`, no
edits to `supabase/functions/*`, no edits to existing migrations or
tests, no edits to `supabase/config.toml`.

## Handoff
next_agent: backend-developer
prompt: Implement the design in §1-12. Two new files only — the
  migration at `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
  and the pgTAP test at `supabase/tests/auth_can_see_store_brand_scope.test.sql`.
  Run via `npm run dev:db` then `bash scripts/test-db.sh` to verify the
  new test passes and the existing pgTAP suite stays green (26/26).
  After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed.
payload_paths:
  - specs/041-brand-scoped-store-visibility.md

## Files changed

Migrations:
- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql` (NEW, amended in review-rounds 1, 2, and 3) — Redefines `public.auth_can_see_store(uuid)` with the three-arm brand-scoped semantics (super_admin / admin-of-own-brand / user_stores-grant). Includes:
    - Pre-flight `do $$` block that now `raise exception`s (not warning — per code-reviewer + backend-architect Critical findings) if any admin/master profile has NULL `brand_id`. Simplified — no `v_bad_count` variable, uses `if exists (...) then raise exception`. Misleading "Same idiom as 012a:327-331" comment removed; new comment block documents the exception semantics.
    - Explicit `grant execute … to authenticated, anon` aligning with sibling 012a helpers.
    - `comment on function` pinning the semantics to spec 041.
    - Review-round 1: `public.assert_brand_id_immutable_for_self()` function + `profiles_self_brand_lock` BEFORE-UPDATE trigger on `public.profiles`. Rejects self-mutation of `brand_id` or `role` by non-super_admin callers (closes the security-auditor live-verified privilege-escalation chain — PATCH /rest/v1/profiles?id=eq.<self> + brand-bounce attack). Mirrors the existing `user_stores_brand_match` trigger pattern from 012a.
    - Review-round 2: `public.assert_profile_self_delete_blocked()` function + `profiles_self_delete_lock` BEFORE-DELETE trigger on `public.profiles`. Closes the DELETE+INSERT bypass of the round-1 UPDATE trigger that the security-auditor live-verified: a brand-admin (JWT `app_metadata.role='admin'`) could DELETE their own profile (admitted by "Admins can delete profiles") and then INSERT a fresh row with foreign brand_id or `role='super_admin'` (admitted by the self-INSERT policy), reaching the same end-state as the round-1 UPDATE attack including same-session super_admin self-escalation. Blocking DELETE at step 1 closes the chain — the INSERT cannot proceed because of PK + FK constraints. Super_admin bypass via `auth_is_super_admin()` so legitimate cross-user deletes through the admin flow continue to work.
    - Review-round 3: `revoke truncate on public.profiles from authenticated, anon`. Closes the TRUNCATE+INSERT bypass that neither the round-1 UPDATE trigger nor the round-2 DELETE trigger covered — TRUNCATE does NOT fire row-level triggers per documented Postgres semantics. Supabase's default grants include TRUNCATE on every public table to authenticated and anon; this REVOKE strips the privilege so the brand-admin's TRUNCATE attempt fails with `permission denied for table profiles` (SQLSTATE 42501) BEFORE any trigger or RLS policy evaluation. service_role retains TRUNCATE — no legitimate flow (migrations, seed, edge functions) is affected. Together with the round-1 UPDATE trigger and round-2 DELETE trigger, this closes the three verb-bound paths (UPDATE / DELETE / TRUNCATE) that lead to the same privilege-escalation end-state.
- Follow-up: spec 051 (`supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql`) closes the OR-shadow gap that left `auth_can_see_store(id)` correct in the helper but neutralized at the SELECT policy on `public.stores` — the legacy `auth_manage_stores` permissive ALL policy was never dropped when this spec landed `store_member_read_stores`, and Postgres ORs permissive policies for the same `(table, command)` pair, so the wide policy shadowed every scoped one. Spec 051 drops it (plus the sibling shadow policies on `user_stores`) so the helper tightening this spec shipped actually gates the read at the data plane.

pgTAP tests:
- `supabase/tests/auth_can_see_store_brand_scope.test.sql` (NEW, amended in review-rounds 1, 2, and 3) — Hermetic `begin; … rollback;` with `plan(14)`. Fourteen arms:
    - (1) admin sees own-brand Towson;
    - (2) admin does NOT see in-txn foreign-brand store;
    - (3) seed master promoted to super_admin in-txn sees foreign-brand store;
    - (4) JWT app_metadata.role='master' (impersonating seed admin) sees own-brand Towson;
    - (5) seed manager with `user_stores` grant sees Towson;
    - (6) seed manager with no grant for Charles is rejected.
    - (7) [round-1] brand-admin self-PATCH on `profiles.brand_id` is rejected by `profiles_self_brand_lock` trigger (`throws_ok` on stable message `'brand_id is read-only for self-edits (super_admin only)'`).
    - (8) [round-1] brand-admin self-PATCH on `profiles.role` is rejected (`throws_ok` on stable message `'role is read-only for self-edits (super_admin only)'`).
    - (9) [round-1] super_admin can UPDATE another user's `brand_id` (positive control — UPDATE trigger does not over-block).
    - (10) [round-1] end-to-end: after rejected self-PATCH in arm (7), brand-admin still cannot see foreign-brand store via the helper (proves the chain closes at step 1).
    - (11) [round-2] brand-admin self-DELETE on profiles is rejected by `profiles_self_delete_lock` trigger (`throws_ok` on stable message `'profile self-delete is not permitted (use admin delete flow)'`).
    - (12) [round-2] super_admin can DELETE another user's profile (positive control — DELETE trigger does not over-block). Run under `reset role` (postgres) with super_admin JWT claims to isolate the trigger from the RLS policy stack, which has no super_admin-specific DELETE policy on `public.profiles` today.
    - (13) [round-2] end-to-end: brand-admin DELETE+INSERT escalation chain dies at step 1 — re-impersonates the brand-admin after the arm (12) positive control and confirms the DELETE still fails with the stable message.
    - (14) [round-3 NEW] brand-admin TRUNCATE on `public.profiles` is rejected by the REVOKE (`throws_ok` 4-arg form pinning SQLSTATE `42501` and message `'permission denied for table profiles'`). Guards against a regression where a future migration re-grants TRUNCATE on `public.profiles`.
  JWT impersonation via `set local role authenticated` + `set_config('request.jwt.claims', …, true)`. The foreign brand + store are inserted inside the transaction and rolled back; the seed remains untouched.

Verification performed (review-round 3):
- Applied amended migration locally via `docker exec -i supabase_db_imr-inventory psql … < <migration>` — clean `DO / CREATE FUNCTION / GRANT / COMMENT / CREATE FUNCTION / DROP TRIGGER / CREATE TRIGGER / COMMENT / CREATE FUNCTION / DROP TRIGGER / CREATE TRIGGER / COMMENT / REVOKE` output. No errors.
- Manually reproduced security-auditor's round-3 Critical attack (brand-admin TRUNCATE on `public.profiles` with the admin JWT claims set) → `ERROR: permission denied for table profiles`. Chain blocked at step 1 before any trigger or RLS policy evaluation.
- `bash scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql` → 14/14 assertions pass (including the new arm 14).
- `bash scripts/test-db.sh` (full suite) → 26/26 test files pass (no regressions).
- `npm run typecheck` → exit 0.

Out-of-scope (untouched per architect §5, §6, §8, plus review-round 1+2+3 release-coordinator carve-outs):
- `src/components/cmd/TitleBar.tsx` — correct-by-construction once RLS filters the data plane.
- `src/lib/db.ts`, `src/store/useStore.ts`, `supabase/functions/*`, `supabase/config.toml` — no changes required.
- `app.json` — unrelated.
- `supabase/seed.sql` — unrelated.
- `order_schedule` WRITE policy (security-auditor High #1, carry-forward) — explicitly deferred to a follow-up spec; documented in "Known follow-up work" above. Round-3 amendment does NOT bundle this fix per the release-proposal carve-out.
- "Admins can update any profile" cross-brand admin write loophole (security-auditor Medium, carry-forward) — explicitly deferred to a follow-up spec; documented in "Known follow-up work" above. Round-3 amendment does NOT bundle this fix.
- Structural weakness on "Users can update own profile" (no `with check` clause) — flagged as round-2 High; deferred to a follow-up spec per release-proposal. The round-2 DELETE trigger and round-3 REVOKE TRUNCATE do not address it; they only close verb-bound paths.
