# Spec 051: Legacy permissive-policy dropout (stores + user_stores + categories sweep)

Status: READY_FOR_REVIEW

## User story
As a brand-admin operating under the spec 041 / 042 tightening regime, I
want the legacy permissive RLS policies that pre-date the brand-scoped
helpers to be dropped (or rewritten to the scoped shape), so that the
helpers actually gate access — instead of being silently shadowed by an
older `auth.uid() IS NOT NULL` permissive policy that ORs over the top of
them and re-opens cross-brand visibility.

As the security-auditor reviewing every future RLS policy that lands in
`supabase/migrations/`, I want the project to document and (ideally) lint
for the "ORed-permissive-policy" footgun, so that the next time someone
adds a wide policy it does not silently neutralize the scoped policies
that already exist on the same table.

## Bug being fixed (production)
On prod, "Bobby" — a brand-admin with `profiles.brand_id = 2AM PROJECT`,
exactly the persona spec 041 was written to scope — can see a Baltimore
Seafood store row in the TitleBar store picker. Spec 041 was supposed to
close this in the data plane.

Diagnosis (verified via Supabase MCP read-only queries on prod):

- Bobby's `profiles` row is clean: `role=admin`, `brand_id=2AM PROJECT`.
- Bobby's only `user_stores` grant is for Towson (2AM PROJECT). No stale
  cross-brand grants.
- The Baltimore Seafood store row has `brand_id` set to the Baltimore
  Seafood brand (not 2AM PROJECT).
- `public.auth_can_see_store(<baltimore_id>)` returns `false` for Bobby.
  The spec 041 helper is correct.
- Migration
  [supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)
  is applied on prod.

So the helper denies, the staff arm denies, the scoped policy
(`store_member_read_stores`, `using (auth_can_see_store(id))` —
[supabase/migrations/20260509000000_multi_brand_schema_rls.sql](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql))
denies — yet PostgREST still returns the row to Bobby. The reason is a
legacy policy that was never dropped:

```sql
-- supabase/migrations/20260502071736_remote_schema.sql:462
create policy "auth_manage_stores"
  on "public"."stores"
  as permissive
  for all
  to public
using ((auth.uid() IS NOT NULL));
```

Postgres ORs permissive policies for the same `(table, command)` pair.
The result for a SELECT on `public.stores` evaluated against Bobby is:

```
   store_member_read_stores  (auth_can_see_store(id))         → false
OR auth_manage_stores         (auth.uid() IS NOT NULL)         → true   ← wins
OR privileged_*_stores        (insert/update/delete-only)      → n/a
```

`auth_manage_stores` is `FOR ALL` (covers SELECT/INSERT/UPDATE/DELETE) and
its USING clause is satisfied by any authenticated JWT, so it shadows
every scoped policy on `public.stores` for every authenticated caller.
The legacy policy was added in the `db pull` snapshot
[supabase/migrations/20260502071736_remote_schema.sql:462](../supabase/migrations/20260502071736_remote_schema.sql)
(pre-existed in prod from before the multi-brand refactor); spec 041 added
the scoped policy alongside it but did not drop the legacy one. Result:
the spec 041 tightening landed for the helper but not for the SELECT
predicate on `stores` itself.

### Root cause / footgun
Postgres ORs permissive RLS policies. Any single wide
`using (auth.uid() IS NOT NULL)` permissive policy on a table neutralizes
every scoped permissive policy on the same `(table, command)` pair. This
is the "ORed-permissive-policy" footgun and it is not currently called
out in CLAUDE.md or in any review checklist. Spec 041 missed it; future
specs will keep missing it unless we document the pattern and (ideally)
add a CI-time probe.

## Same pattern affects three other tables (audit sweep)

A scan of `public.*` policies on prod surfaced four permissive policies
whose USING clause is essentially `auth.uid() IS NOT NULL` (i.e. "any
authenticated caller passes"):

| Table | Policy | Cmd | Predicate | Action |
|---|---|---|---|---|
| `public.stores` | `auth_manage_stores` | ALL | `auth.uid() IS NOT NULL` | DROP — scoped policies cover every command path. |
| `public.user_stores` | `Users can manage own store links` | ALL | `(user_id = auth.uid()) OR (auth.uid() IS NOT NULL)` | REWRITE — the second OR-arm makes the first a no-op. Any authenticated user can manage any other user's `user_stores` rows; the spec-012a `user_stores_brand_match` trigger blocks cross-brand inserts only, not same-brand cross-user inserts. |
| `public.ingredient_categories` | `Authenticated can read ingredient categories` | SELECT | `auth.uid() IS NOT NULL` | CONFIRM intentional (curated master data, shared across brands per spec 004). Rewrite to explicit `for select to authenticated using (true)` + inline `comment on policy` documenting the cross-brand sharing decision. |
| `public.recipe_categories` | `Authenticated can read categories` | SELECT | `auth.uid() IS NOT NULL` | Same as above per spec 013. Migration `20260510030000_recipe_categories_super_admin_rls.sql:16-18` already contains an inline comment saying the SELECT policy is "intentionally left untouched" — this spec promotes that buried comment into a `comment on policy` annotation visible from `pg_policies`. |

### Read/write blast radius (verified via prod MCP)

- **Reads (stores)**: Bobby (and every brand-admin) sees every brand's
  stores in the picker — the visible symptom that triggered this spec.
- **Writes (stores)**: any authenticated caller (including a regular
  `role=user`) can INSERT new stores into any brand, UPDATE any existing
  store's `brand_id`/`name`/etc., and DELETE any existing store.
  Catastrophic if exploited. The scoped `privileged_*_stores` policies
  exist but are shadowed by the wide one.
- **Writes (user_stores)**: any authenticated caller can INSERT a
  `user_stores` row for any other user, UPDATE it, or DELETE it. The
  spec-012a `user_stores_brand_match` trigger rejects rows where
  `user.brand_id != store.brand_id`, so cross-brand grants are still
  blocked at the trigger layer. But **same-brand cross-user** grants are
  permitted: a staff user from brand A can grant another staff user from
  brand A access to any brand-A store, even one the granter does not own.
  Read symmetry holds: `Users can read own store links` is FOR SELECT
  using `(user_id = auth.uid())` (correctly scoped), but the leaking ALL
  policy implicitly covers SELECT too — so any caller can also LIST any
  other user's `user_stores` grants. (Architect should confirm by direct
  query.)
- **Reads/writes (categories)**: read leak is intentional (curated master
  data); writes are gated by `auth_is_admin()` / `auth_is_privileged()`
  and are not in the wide-policy set. Out of scope for this spec — see
  the "Out of scope" section.

## Acceptance criteria

- [ ] A new migration exists at exactly
      `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql`
      (architect §0: the PM-suggested `20260520000000` slot is taken by
      spec 050; `20260520010000` is the next free same-day slot and
      lands after 050 on lexicographic timestamp sort).
- [ ] The migration is idempotent and re-runnable: every `drop policy` is
      `drop policy if exists`, every `create policy` is preceded by a
      matching `drop policy if exists` of the same name.
- [ ] **`public.stores` — `auth_manage_stores` dropped.**
      The migration runs `drop policy if exists "auth_manage_stores" on public.stores;`
      and adds NO replacement policy. Rationale: the scoped policies
      `store_member_read_stores` (SELECT), `privileged_insert_stores`
      (INSERT), `privileged_update_stores` (UPDATE), and
      `privileged_delete_stores` (DELETE) — all defined in
      `20260509000000_multi_brand_schema_rls.sql` — cover every command
      path. Architect to verify by `pg_policies` query before the dev
      implements (see Open questions Q5).
- [ ] **`public.user_stores` — `Users can manage own store links`
      replaced.** Drop the legacy `(user_id = auth.uid()) OR (auth.uid()
      IS NOT NULL)` predicate and re-create as
      `using (user_id = auth.uid()) with check (user_id = auth.uid())`
      for `FOR ALL` — i.e. a user can only manage their own grant rows.
      Separately, replace `Admins can manage all store links`
      ([supabase/migrations/20260502071736_remote_schema.sql:471](../supabase/migrations/20260502071736_remote_schema.sql))
      so the admin path is brand-scoped: `using (auth_is_privileged() and
      auth_can_see_brand((select brand_id from public.user_stores us join
      public.stores s on s.id = us.store_id where us.id = user_stores.id
      …)))` — exact shape is for the architect to design per Open
      questions Q2. Super-admin must retain full cross-brand access via
      the `auth_is_super_admin()` short-circuit inside
      `auth_can_see_brand`.
- [ ] **`public.ingredient_categories` — `Authenticated can read
      ingredient categories` rewritten for clarity, no semantic change.**
      Drop + recreate as `for select to authenticated using (true)`
      (semantically identical to `auth.uid() IS NOT NULL` for the
      `authenticated` role). Add `comment on policy "Authenticated can
      read ingredient categories" on public.ingredient_categories is
      'spec 051: intentionally cross-brand; ingredient categories are
      curated master data shared across brands per spec 004.';`. The
      write policies on this table are NOT touched — see Out of scope.
- [ ] **`public.recipe_categories` — `Authenticated can read categories`
      rewritten for clarity, no semantic change.** Same shape as above —
      drop + recreate as `for select to authenticated using (true)`, add
      `comment on policy` pinning the cross-brand intent to spec 051 +
      spec 013. The write policies on this table are NOT touched.
- [ ] **pgTAP regression at exactly
      `supabase/tests/legacy_permissive_policy_dropout.test.sql`** that
      covers, at minimum:
      (a) brand-A admin SELECT on `public.stores` returns only brand-A
      rows (the Bobby leak — directly asserts the bug is fixed);
      (b) brand-A admin INSERT into `public.stores` with `brand_id =
      <brand-B>` is rejected by RLS (the latent WRITE leak in the same
      policy stack);
      (c) brand-A admin UPDATE of a `public.stores` row with
      `brand_id = <brand-B>` is rejected;
      (d) brand-A admin DELETE of a brand-B `public.stores` row is
      rejected;
      (e) super-admin SELECT/INSERT/UPDATE/DELETE on `public.stores`
      across brands continues to succeed (no-regression);
      (f) staff user (role=`user`, no `user_stores` grant for brand-B
      stores) cannot SELECT a brand-B store row;
      (g) staff user CANNOT INSERT a `user_stores` row for another user
      (the same-brand cross-user write hole);
      (h) staff user CAN INSERT/UPDATE/DELETE their own `user_stores`
      row (no-regression — though typical invitation flows happen as
      admin, see Q2);
      (i) brand-A admin CAN INSERT a `user_stores` row that grants a
      brand-A user access to a brand-A store, via the rewritten admin
      policy (Q2 outcome);
      (j) brand-A admin CANNOT INSERT a `user_stores` row that crosses
      brands (covered by both the new policy and the existing
      `user_stores_brand_match` trigger — both layers asserted);
      (k) authenticated SELECT on `public.ingredient_categories` and
      `public.recipe_categories` continues to return ALL rows across
      brands (no-regression — the cross-brand intent is documented and
      pgTAP-asserted).
- [ ] **All 30 existing pgTAP test files under `supabase/tests/*.test.sql`
      continue to pass after the migration runs.** Architect must walk
      the test suite and flag any test that previously relied on the
      legacy permissive behavior (especially `profiles_rls_sweep.test.sql`
      and `invitations_super_admin_rls.test.sql` if they touch
      `user_stores`) — but I do not expect any.
- [ ] **No client-side code changes ship with this spec.** Every
      PostgREST / RPC call path that touches `stores`, `user_stores`,
      `ingredient_categories`, or `recipe_categories` continues to work
      under the tighter policy stack because (i) the scoped policies were
      already in place, and (ii) the legitimate write paths
      (invitation-style grants, admin store creation) go through
      `auth_is_privileged()` callers, which the new policies still
      permit within the caller's brand.
- [ ] **CLAUDE.md addition documenting the "ORed-permissive-policy"
      footgun.** A new bullet under "Conventions already in use" pinning
      the rule: when adding a permissive RLS policy, every existing
      permissive policy on the same `(table, command)` pair is ORed
      against yours — so a wide pre-existing policy will SHADOW your
      scoped policy and re-open the gap. The bullet should reference
      this spec, name the four-table audit, and link to the migration.
      Strictly additive; no existing bullet reworded.
- [ ] **Closeout note on spec 041 (Q3).** If the user accepts the PM
      recommendation, append a one-line "Follow-up: spec 051" closeout
      bullet to [specs/041-brand-scoped-store-visibility.md](041-brand-scoped-store-visibility.md)
      under its Status / closeout section. Architect or dev to mechanic
      it; PM does not write to that file in this spec.

## In scope
- A single new migration at the path above.
- A single new pgTAP test file at the path above.
- A CLAUDE.md edit adding the "ORed-permissive-policy" footgun bullet.
- (Optionally — see Q3) A closeout sentence on spec 041.

## Out of scope (explicitly)
- **No `auth_can_see_store` / `auth_can_see_brand` changes.** Those
  helpers are correct; the spec 041 / 042 work proved that. This spec
  fixes the OR-shadow, not the helpers.
- **No helper-function changes at all.** `auth_is_privileged`,
  `auth_is_admin`, `auth_is_super_admin`, `auth_can_see_brand`,
  `auth_can_see_store` are byte-identical after this migration.
- **No write-side tightening on `ingredient_categories` /
  `recipe_categories`.** Those tables already gate writes via
  `auth_is_admin()` / `auth_is_privileged()` policies. Cross-brand WRITE
  on categories — i.e. should a brand-A admin be able to create a recipe
  category visible to brand B — is a separate semantic question, not a
  leak, and is tracked as a candidate follow-up spec (see Open questions
  Q1). Categories are read-mostly in practice and a separate spec can
  address writes when there is a user-driven need.
- **No new edge functions, no edge function code changes.** Edge
  functions that touch these tables (`staff-*`, invitation flows) use
  the service-token bearer (`verify_jwt = false`, validates own header)
  and never set `auth.uid()`, so they pass through PostgREST's
  service_role context and are not subject to these policies anyway.
- **No client-side code changes.** TitleBar, MembersTab, StoresSection,
  invitation modal — all continue to work because the legitimate paths
  flow through `auth_is_privileged()` callers, which the rewritten
  policies still permit within the caller's brand.
- **No `app.json` slug changes.** Unrelated to this spec.
- **No CI linter / pre-commit hook.** A SQL probe that fails CI when a
  new policy with `using (auth.uid() IS NOT NULL)` (or equivalent) lands
  is an attractive defense-in-depth measure, but it is its own spec —
  see Open questions Q4. This spec only documents the footgun in
  CLAUDE.md; the structural fix is a future spec.
- **No retroactive `comment on policy` for unrelated policies.** Only
  the two `categories` SELECT policies are annotated in this spec, and
  only because their cross-brand intent is the surprising behavior that
  this spec rules-in-by-decision. Annotating every existing policy is a
  separate cleanup pass.
- **No `user_stores` SELECT-side rewrite if the audit shows it's
  already correct.** `Users can read own store links`
  ([supabase/migrations/20260502071736_remote_schema.sql:489](../supabase/migrations/20260502071736_remote_schema.sql))
  is a FOR SELECT policy using `(user_id = auth.uid())` and is
  scoped-correct. The only issue is that the wide ALL policy implicitly
  covers SELECT too. Dropping/rewriting the wide ALL policy is enough.
  Architect should confirm no separate SELECT-side rewrite is needed.

## Open questions — RESOLVED (2026-05-20)

User accepted all PM-recommended defaults in a single batch:

- **Q1 → YES, categories cross-brand reads are intentional.** Keep the two `categories` SELECT policies. Rewrite each as `for select to authenticated using (true)` for clarity and add a `comment on policy` documenting the intentional cross-brand shape. Spec 013's existing inline comment already affirms this intent.
- **Q2 → Two-policy split for `user_stores`.** Drop `Users can manage own store links` AND `Admins can manage all store links` (the latent JWT-only-no-brand leak). Replace with: (a) own-row policy `using (user_id = auth.uid()) with check (user_id = auth.uid())` for self-management; (b) brand-scoped admin policy `using (auth_is_privileged() AND exists (select 1 from stores s where s.id = user_stores.store_id AND auth_can_see_brand(s.brand_id))) with check (...same...)` for invitation flows. Architect finalizes exact SQL.
- **Q3 → YES, add follow-up bullet to spec 041's closeout note** pointing at spec 051. Mechanical edit landed by the dev as part of spec 051's commit.
- **Q4 → YES, but as a separate future spec 052** — defense-in-depth pgTAP linter that fails if any new policy lands with `using ... auth.uid() IS NOT NULL`. Out of scope for 051.
- **Q5 → YES, architect must produce a before/after policy matrix** in the design section covering: every policy on each affected table, the cmd, the USING/CHECK expressions, and an assertion of which scoped policy now covers each previously-permitted operation. The matrix is the verification step for "the legacy policy was load-bearing somewhere we didn't expect."

The rest of this section preserves the original deliberation for the architect's reference; treat the resolutions above as the final word.

---

## Open questions (original deliberation — superseded by resolutions above)

**Q1: Categories read-side semantics — confirm "intentional cross-brand
master data"?** PM recommendation: yes, intentional. Spec 004 and spec
013 established categories as curated master data shared across brands;
migration `20260510030000_recipe_categories_super_admin_rls.sql:16-18`
already says so in an inline source comment. This spec promotes that
buried comment into a `comment on policy` annotation visible from
`pg_policies`, and rewrites the predicate as `for select to authenticated
using (true)` (semantically identical for the `authenticated` role) for
clarity. **PM proposes: accept the recommendation as the project policy.**
If the user disagrees — i.e. categories should be brand-scoped — that is
a much larger change (data model + UI + write semantics) and should be
its own spec.

**Q2: `user_stores` write-side policy shape.** Direct
`(user_id = auth.uid())` for FOR ALL is too tight for invitation flows
(admins must be able to grant a store to a freshly invited user, where
`user_id != auth.uid()`). The legitimate paths today are:

1. **Invitation-driven** — `staff-accept-invitation` edge function (or
   equivalent) inserts the `user_stores` row server-side with
   service_role. This path is NOT subject to these policies.
2. **Admin-driven** — Cmd UI's MembersTab / StoresSection invites a user
   and assigns them a store. This path goes through `auth_is_privileged()`
   callers and currently relies on `Admins can manage all store links`
   ([supabase/migrations/20260502071736_remote_schema.sql:471](../supabase/migrations/20260502071736_remote_schema.sql))
   — which is `using ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])))`
   with no brand check. That policy has the SAME cross-brand leak as the
   spec-042 "Admins can update any profile" — a brand-A admin can grant a
   brand-A user access to a brand-B store. The `user_stores_brand_match`
   trigger blocks the cross-brand insert at the trigger layer, so it's
   currently belt-and-suspenders, but the policy text is still incorrect
   and should be brand-scoped.

Architect to design the exact shape:

- Drop `Users can manage own store links` and re-create as
  `for all using (user_id = auth.uid()) with check (user_id = auth.uid())`.
- Drop `Admins can manage all store links` and re-create as `for all
  using (auth_is_privileged() and exists (select 1 from public.stores s
  where s.id = user_stores.store_id and auth_can_see_brand(s.brand_id)))
  with check (auth_is_privileged() and exists (select 1 from public.stores
  s where s.id = user_stores.store_id and auth_can_see_brand(s.brand_id)))`.

PM is not the right author for the exact SQL — architect will finalize
the shape, the column reference style, and whether the brand check
should be folded into a new helper (`auth_can_see_store_brand(uuid)`)
for reuse. **Is this two-policy split acceptable, or does the user want
a single combined policy?** PM proposes: two-policy split (mirrors the
spec-042 split on `profiles`), but the architect can override if a
single policy is cleaner.

**Q3: Closeout note on spec 041.** Should this spec retroactively annotate
[specs/041-brand-scoped-store-visibility.md](041-brand-scoped-store-visibility.md)
with a "Follow-up: spec 051 (legacy permissive-policy dropout)"
sentence under its Status / closeout block? PM proposes: yes — the
041 closeout currently reads as if the brand-scoping shipped fully, when
in fact the SELECT predicate on `stores` itself was still being shadowed
by the legacy ALL policy. A breadcrumb to spec 051 prevents future
confusion. **User decision: yes / no.**

**Q4: CI-time linter for the footgun.** Should we add a `policy_probe`
test under `supabase/tests/` (run via the existing pgTAP harness in
[scripts/test-db.sh](../scripts/test-db.sh)) that scans `pg_policies` for
any permissive policy whose qual is exactly `(auth.uid() IS NOT NULL)`
(or trivially equivalent) and fails CI? **PM proposes: yes, defense-in-
depth, low cost.** The probe should:

- Allow-list the two `categories` SELECT policies (intentional cross-
  brand read).
- Fail with a clear error message naming the offending
  `(schemaname, tablename, policyname)` and pointing back to this spec.

The probe is a simple `select … from pg_policies where …` plus a
`raise exception`. Architect to decide whether it lives in a new file
or appends to an existing sweep test (e.g.
`profiles_rls_sweep.test.sql`). **PM proposes: a new sweep test file
named `supabase/tests/permissive_policy_sweep.test.sql`** — same shape
as `profiles_rls_sweep.test.sql` but for policy-pattern rather than
profiles content.

**Caveat:** If the user wants the CI probe, that should be its own spec
(spec 052?) so that it can be reviewed by the test-engineer and the
security-auditor against the existing rls test infrastructure. PM
recommends decoupling: this spec ships the fix + CLAUDE.md doc; a
sibling spec ships the linter.

**Q5: Verification that the scoped policies on `stores` actually cover
every command path.** Before dropping `auth_manage_stores`, the
architect should walk `pg_policies` on prod (read-only) and confirm:

- `public.stores` has policies for every command. SELECT is covered by
  `store_member_read_stores`. INSERT by `privileged_insert_stores`.
  UPDATE by `privileged_update_stores`. DELETE by
  `privileged_delete_stores`. (Verified via grep on
  `20260509000000_multi_brand_schema_rls.sql`, but architect to confirm
  no later migration dropped or renamed any of them.)
- No other `public.stores` permissive policy is hiding in a migration
  the audit missed.
- No `restrictive` policy exists on `public.stores` that would interact
  unexpectedly when the wide ALL policy disappears.

**PM proposes:** the architect produces a one-section "policy state
before/after" matrix in the design doc, mirroring the table at the top
of this spec, and the dev does not implement until the matrix is in the
design doc. **Is this verification step required by the user, or
deferred to the architect's standard process?**

## Risks

- **Dropping `auth_manage_stores` might break a hidden caller.** No
  client-side code grep-references the policy name (verified — searched
  `src/` for `auth_manage_stores`, zero hits), and the scoped policies
  cover every command. But there may be a Postgres function (RPC) or an
  edge function (service-role context) that implicitly relied on the
  wide policy at SELECT time. Architect must grep `supabase/migrations/`
  for `from stores`, `from public.stores`, and any RPC body that
  queries the table without `security definer` — those are the places
  where the tightening could surface as a regression. PM expectation:
  none, because (i) service_role bypasses RLS entirely, and (ii) every
  RPC the user touches goes through `auth_is_privileged()` or
  `auth_can_see_store` first.
- **The `user_stores` write rewrite changes invitation-flow semantics.**
  Today, a brand-A admin can technically issue a `user_stores` INSERT
  for a user in a foreign brand (the policy permits it, the trigger
  rejects it). After this spec, the policy itself rejects it
  pre-trigger. This is the desired tightening, but any monitoring /
  logging that distinguished "policy reject" vs "trigger reject" will
  see a shift. PM expectation: no such monitoring exists, but the
  architect should confirm by grepping audit log handlers.
- **Pre-existing pgTAP tests under the loose semantics.** Same risk
  shape as spec 041 Q1. PM expectation: every pre-existing test goes
  through fixtures (admin, master, manager) whose `user_stores` rows are
  set explicitly in the seed, so the wide policy was never the
  load-bearing one for any test assertion. Architect to confirm the
  test suite still passes (30/30) before declaring READY_FOR_REVIEW.
- **"Before / after" pgTAP assertion.** Per the brief, the new test
  file should explicitly include a no-regression arm asserting that the
  existing 30 test files continue to pass. The pgTAP harness already
  re-runs the full suite per
  [scripts/test-db.sh](../scripts/test-db.sh), so the assertion is
  procedural (CI green = no regression) rather than a literal
  in-file SQL check.
- **Migration ordering.** Slot `20260520000000` is today's date and is
  free per the ls above. If any other spec lands a `20260520*` migration
  between PM and dev, the dev re-numbers (`20260520010000`) and updates
  the AC accordingly.
- **Realtime publication.** The realtime publication membership for
  `stores` and `user_stores` is unchanged by this spec. Clients
  subscribing to `store-{id}` or `brand-{id}` channels do not see a
  change in event delivery — RLS filters reads at SELECT time, not at
  publication time. Per the
  [realtime-publication gotcha](../CLAUDE.md) memory, no `docker restart
  supabase_realtime_imr-inventory` is required because the publication
  was not modified.

## Dependencies

- Existing helpers: `public.auth_is_privileged()`, `public.auth_is_admin()`,
  `public.auth_is_super_admin()`, `public.auth_can_see_brand(uuid)`,
  `public.auth_can_see_store(uuid)` — all unchanged.
- Existing scoped policies on `public.stores` (`store_member_read_stores`,
  `privileged_insert_stores`, `privileged_update_stores`,
  `privileged_delete_stores`) defined in
  [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql).
- Existing trigger `user_stores_brand_match` from spec 012a (blocks
  cross-brand `user_stores` inserts at the trigger layer — belt-and-
  suspenders behind the new policy).
- pgTAP harness: [scripts/test-db.sh](../scripts/test-db.sh).
- No new edge functions, no new TS modules, no new helper functions.

## Project-specific notes

- **Cmd UI section / legacy:** No UI change. The TitleBar store picker
  ([src/components/cmd/TitleBar.tsx](../src/components/cmd/TitleBar.tsx))
  is the symptom site but the fix is server-side only.
- **Per-store or admin-global:** Per-store (and per-brand for the
  rewritten admin paths). Super-admin remains global via the
  `auth_is_super_admin()` short-circuit inside `auth_can_see_brand`.
- **Realtime channels touched:** None. Publication membership unchanged.
  Clients on `store-{id}` / `brand-{id}` see no behavior change beyond
  the existing RLS filter applying at SELECT time. The realtime
  publication gotcha is a non-issue here.
- **Migrations needed:** Yes — exactly one,
  `supabase/migrations/20260520000000_legacy_permissive_policy_dropout.sql`.
- **Edge functions touched:** None directly. The `staff-*` family and
  any service-token-bearer functions are unaffected because they
  bypass RLS via service_role.
- **Web/native scope:** Both. The fix is entirely in Postgres, so it
  applies uniformly to the Vercel web bundle and the EAS native bundle.
- **Tests track:** pgTAP (DB test track per spec 022). New file:
  `supabase/tests/legacy_permissive_policy_dropout.test.sql`. No jest
  or shell-smoke additions required for this spec.
- **CLAUDE.md edit track:** This spec writes one new bullet under
  "Conventions already in use" documenting the ORed-permissive-policy
  footgun. The dev who implements the migration is also responsible
  for the CLAUDE.md edit; architect to confirm the placement and
  wording in the design doc.

## PM recommendations summary (for user review before READY_FOR_ARCH)

| # | Question | PM proposal |
|---|---|---|
| Q1 | Categories cross-brand reads intentional? | YES — keep, rewrite for clarity, annotate via `comment on policy`. |
| Q2 | `user_stores` write-side shape? | Two-policy split: own-row policy + brand-scoped admin policy. Architect finalizes SQL. |
| Q3 | Closeout note on spec 041? | YES — add a one-line follow-up bullet to spec 041 pointing to spec 051. |
| Q4 | CI-time linter for the footgun? | YES, but as its own spec (spec 052?). This spec ships only the fix + the CLAUDE.md bullet. |
| Q5 | Architect "before / after" policy matrix required in design doc? | YES — codify the verification step. |

The user must answer Q1–Q5 (or accept the PM proposals) before this spec
flips to `READY_FOR_ARCH`.

---

## Backend design

### 0. Migration filename and ordering

**File:** `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql`

The PM-suggested slot `20260520000000` is already taken by spec 050's
`20260520000000_demote_profile_to_user_rpc.sql` (committed today). The
next free same-day slot is `20260520010000`, and that lands strictly
after 050 on `db reset` apply order (lexicographic timestamp sort —
`scripts/test-db.sh` and `supabase db reset` both rely on the standard
ordering). All other 2026-05-20 slots are free per
`ls supabase/migrations/2026052*.sql`. Pin this filename.

The AC at line 124 of this spec references `20260520000000_...` —
**that line is now stale by one slot.** The dev applies the rename in
the migration filename and updates that AC line as part of the
implementation; this is a one-character delta, not a contract change.
Surfaced explicitly so the test-engineer doesn't flag it as drift in
the review pass.

### 1. Data model changes

No table-schema changes. No new columns, no new indexes, no new
triggers, no new helper functions. The migration is **policy DDL only**:

- DROP one legacy policy on `public.stores`.
- DROP two legacy policies on `public.user_stores`.
- DROP + recreate two `categories` SELECT policies (semantic no-op,
  clarity rewrite + `comment on policy`).
- CREATE two new policies on `public.user_stores` (own-row + brand-scoped
  admin) replacing the legacy two.

Migration is **additive in the rollback sense for `categories`** (DROP +
recreate with the same semantics) and **destructive for the four legacy
policies** on `stores` / `user_stores` — but the destruction restores
correct behavior (scoped policies were already in place and load-bearing
once the wide one is gone). Rollout safety is high because the scoped
policies for `stores` already exist (verified §2 below); for
`user_stores`, the new own-row policy preserves the legitimate
self-management path and the new brand-scoped admin policy preserves the
legitimate invitation flow under tighter brand-scope.

### 2. Before/after policy matrix (Q5 verification)

The matrix below is the load-bearing verification step. It walks every
policy on each affected table — before and after this migration — and
asserts that each previously-permitted operation either (a) is now
covered by an existing scoped policy, (b) is now correctly blocked, or
(c) is intentionally preserved.

Notation: **OR** denotes the Postgres permissive-policy OR semantics.
Within a cell, `→` reads "evaluates to". A policy with `USING (X)` for
SELECT/UPDATE/DELETE admits a row iff `X` is true for that row. A policy
with `WITH CHECK (X)` for INSERT/UPDATE rejects a row iff `X` is false
for the new row.

#### Matrix A — `public.stores`

**BEFORE (state on prod today, also in seed/local):**

| Policy name                  | Cmd     | USING / WITH CHECK                                                      | Source                                                                 |
|------------------------------|---------|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| `auth_manage_stores`         | ALL     | `using (auth.uid() IS NOT NULL)`                                         | `20260502071736_remote_schema.sql:462`                                  |
| `store_member_read_stores`   | SELECT  | `using (auth_can_see_store(id))`                                         | `20260509000000_multi_brand_schema_rls.sql:616-618`                     |
| `privileged_insert_stores`   | INSERT  | `with check (auth_is_privileged() AND auth_can_see_brand(brand_id))`     | `20260509000000_multi_brand_schema_rls.sql:620-625`                     |
| `privileged_update_stores`   | UPDATE  | `using (...) with check (...)` (privileged + brand)                      | `20260509000000_multi_brand_schema_rls.sql:627-636`                     |
| `privileged_delete_stores`   | DELETE  | `using (auth_is_privileged() AND auth_can_see_brand(brand_id))`          | `20260509000000_multi_brand_schema_rls.sql:638-643`                     |

**Effective predicate (BEFORE):**
- SELECT → `auth_can_see_store(id) OR auth.uid() IS NOT NULL` → **any authed caller wins** (the leak).
- INSERT → `(privileged AND see_brand) OR auth.uid() IS NOT NULL` → **any authed caller wins** (latent WRITE leak).
- UPDATE → same shape as INSERT.
- DELETE → same shape as INSERT.

**AFTER (this migration):**

| Policy name                  | Cmd     | USING / WITH CHECK                                                      | Disposition                                                            |
|------------------------------|---------|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| `store_member_read_stores`   | SELECT  | `using (auth_can_see_store(id))`                                         | UNCHANGED — now the sole SELECT gate                                    |
| `privileged_insert_stores`   | INSERT  | `with check (auth_is_privileged() AND auth_can_see_brand(brand_id))`     | UNCHANGED — now the sole INSERT gate                                    |
| `privileged_update_stores`   | UPDATE  | `using/with check (privileged AND see_brand)`                            | UNCHANGED — now the sole UPDATE gate                                    |
| `privileged_delete_stores`   | DELETE  | `using (privileged AND see_brand)`                                       | UNCHANGED — now the sole DELETE gate                                    |

**Effective predicate (AFTER):**
- SELECT → `auth_can_see_store(id)` only → super_admin (all brands) OR admin/master (own brand via spec 041 helper) OR `user_stores` member.
- INSERT → `auth_is_privileged() AND auth_can_see_brand(brand_id)` only → privileged caller within own brand (super_admin via short-circuit, admin/master via brand_id match).
- UPDATE / DELETE → same shape as INSERT.

**Per-operation coverage proof (no legitimate caller is locked out):**

| Operation (caller × target)                          | BEFORE wins via               | AFTER wins via                | Behavior change                                                  |
|-------------------------------------------------------|--------------------------------|--------------------------------|------------------------------------------------------------------|
| super_admin SELECT any store                          | `auth_can_see_store` (super-admin short-circuit) — also `auth_manage_stores` | `auth_can_see_store` (unchanged) | Identical                                                        |
| admin SELECT own-brand store                          | `auth_can_see_store` AND `auth_manage_stores` (both true) | `auth_can_see_store` | Identical                                                        |
| admin SELECT foreign-brand store                      | `auth_manage_stores` (wide policy)            | NEITHER                        | **TIGHTENED — leak closed.** This is the Bobby fix.              |
| user (role=user) with grant SELECT granted store      | `auth_can_see_store` (user_stores arm) AND `auth_manage_stores` | `auth_can_see_store` | Identical                                                        |
| user without grant SELECT any store                   | `auth_manage_stores` only                     | NEITHER                        | **TIGHTENED.** Pre-fix this was already a leak; spec 041 helper assumed it was gated. |
| super_admin INSERT/UPDATE/DELETE any store            | both policies                  | `privileged_*_stores` (super-admin via `auth_is_super_admin` inside `auth_can_see_brand`) | Identical                                                        |
| admin INSERT/UPDATE/DELETE own-brand store            | both policies                  | `privileged_*_stores`          | Identical                                                        |
| admin INSERT/UPDATE/DELETE foreign-brand store        | `auth_manage_stores` (wide)    | NEITHER                        | **TIGHTENED — latent WRITE leak closed.**                        |
| user INSERT/UPDATE/DELETE any store                   | `auth_manage_stores` only      | NEITHER                        | **TIGHTENED — catastrophic-if-exploited leak closed.**            |

No legitimate operation is locked out. The four scoped policies cover
every command path for every legitimate caller. **Verification confirmed
by walking every migration that touches `public.stores` policies; the
list above is complete.**

#### Matrix B — `public.user_stores`

**BEFORE:**

| Policy name                            | Cmd     | USING / WITH CHECK                                                                                                                                              | Source                                                            |
|----------------------------------------|---------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| `Users can manage own store links`     | ALL     | `using ((user_id = auth.uid()) OR (auth.uid() IS NOT NULL))`                                                                                                     | `20260502071736_remote_schema.sql:480-485`                          |
| `Admins can manage all store links`    | ALL     | `using ((auth.jwt() -> 'app_metadata' ->> 'role') = ANY (ARRAY['admin','master']))`                                                                              | `20260502071736_remote_schema.sql:471-476`                          |
| `Users can read own store links`       | SELECT  | `using (user_id = auth.uid())`                                                                                                                                   | `20260502071736_remote_schema.sql:489-494`                          |

**Plus a trigger (012a, unaffected by this spec):**
- `user_stores_brand_match_trg` BEFORE INSERT/UPDATE — rejects rows where `profiles.brand_id != stores.brand_id` (the user's brand and the store's brand must agree). Belt-and-suspenders behind the new admin policy below.

**Effective predicate (BEFORE):**
- SELECT → `(user_id = auth.uid()) OR (user_id = auth.uid() OR auth.uid() IS NOT NULL) OR (admin/master JWT)` → **any authed caller wins** (the OR-arm `auth.uid() IS NOT NULL` on `Users can manage own store links` covers SELECT because the policy is FOR ALL).
- INSERT/UPDATE/DELETE → same — any authed caller wins (modulo the trigger rejecting cross-brand inserts post-policy).

**AFTER:**

| Policy name                            | Cmd     | USING / WITH CHECK                                                                                                                                                                                                       | Source                                                            |
|----------------------------------------|---------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| `Users can manage own store links`     | ALL     | `using (user_id = auth.uid()) with check (user_id = auth.uid())`                                                                                                                                                          | this migration (rewritten)                                         |
| `Admins can manage all store links`    | ALL     | `using (auth_is_privileged() AND exists (select 1 from public.stores s where s.id = user_stores.store_id AND auth_can_see_brand(s.brand_id))) with check (same)`                                                          | this migration (rewritten)                                         |
| `Users can read own store links`       | SELECT  | `using (user_id = auth.uid())`                                                                                                                                                                                            | UNCHANGED                                                          |

Trigger `user_stores_brand_match_trg` unchanged — fires AFTER policy
admission as defense-in-depth (still belt-and-suspenders for the
super_admin path, which bypasses brand check via the
`auth_can_see_brand` super-admin short-circuit).

**Effective predicate (AFTER):**
- SELECT → `(user_id = auth.uid()) OR (auth_is_privileged() AND exists same-brand check)` → caller sees own grants, OR privileged-of-this-store's-brand sees this grant.
- INSERT → WITH CHECK: `(user_id = auth.uid()) OR (auth_is_privileged() AND exists same-brand check)` → either self-grant, or admin granting within own brand, or super_admin via the brand check's short-circuit. Trigger then verifies user.brand_id == store.brand_id (defense-in-depth).
- UPDATE / DELETE → same shape as INSERT.

**Per-operation coverage proof:**

| Operation                                                                | BEFORE wins via                              | AFTER wins via                                          | Behavior change                                                                |
|---------------------------------------------------------------------------|-----------------------------------------------|---------------------------------------------------------|--------------------------------------------------------------------------------|
| user SELECTs their own grants                                             | `Users can read own store links` AND wide ALL | `Users can read own store links` AND own-row ALL        | Identical                                                                       |
| user SELECTs another user's grants                                        | wide ALL only                                 | NEITHER                                                  | **TIGHTENED — info-disclosure closed.**                                         |
| user INSERTs grant for themselves on a store in their brand               | wide ALL                                      | own-row ALL (`user_id = auth.uid()`) + trigger          | Identical (legitimate self-onboarding for the rare case where a user has both pre-existing brand_id and creates their own grant; in practice this happens through `auth.ts:383` during registration, where the new user IS the caller). |
| user INSERTs grant for ANOTHER user                                       | wide ALL — admits, then trigger may reject    | NEITHER (neither own-row nor admin arm passes)           | **TIGHTENED — same-brand cross-user grant leak closed.**                        |
| brand-A admin INSERTs grant for brand-A user on brand-A store             | `Admins can manage all store links` (JWT match) AND wide ALL | admin arm (privileged + brand match)                    | Identical                                                                       |
| brand-A admin INSERTs grant for brand-A user on brand-B store             | `Admins can manage all store links` admits — then trigger rejects | Trigger (`user_stores_brand_match_trg`) rejects first with P0001; admin arm's RLS WITH CHECK would also reject if the trigger were removed (structural backstop) | Tightened: two layers of defense (trigger + RLS WITH CHECK) instead of one (trigger only). Per documented Postgres execution order, BEFORE-ROW triggers fire before RLS WITH CHECK on INSERT, so the observed error class is P0001 + the trigger's stable message. Implementation correctly asserts on the trigger's surface; RLS layer is the structural backstop. |
| brand-A admin INSERTs grant for brand-B user                              | wide ALL admits — trigger rejects             | admin arm: brand check evaluates `stores.brand_id` (brand-A store); INSERT admitted by policy, then trigger rejects on `profiles.brand_id != stores.brand_id`. | Defense-in-depth preserved. **No regression** (trigger remains the canonical cross-brand-user blocker). |
| super_admin INSERTs any grant                                             | both policies                                 | admin arm (super-admin short-circuit in `auth_can_see_brand`) | Identical                                                                       |
| user (role=user, no JWT admin claim) INSERTs grant for themselves         | wide ALL                                      | own-row ALL                                              | Identical                                                                       |
| user (role=user) DELETEs their own grant                                  | wide ALL + own-row arm                        | own-row ALL                                              | Identical                                                                       |

The own-row policy covers the self-management flows (rare in practice
because invitation acceptance via `auth.ts:383` runs under the freshly
authenticated user's session and inserts a row where `user_id = auth.uid()`).
The brand-scoped admin policy covers the admin invitation flow.

**One subtle case worth calling out: invitation acceptance from a fresh
session.** Today's flow at `src/lib/auth.ts:380-384` calls
`supabase.from('user_stores').insert({ user_id: authData.user.id, store_id: storeId })`
immediately after `auth.signUp`. The session is authenticated (the user
just signed up), `auth.uid() = authData.user.id` matches `user_id`, so
the own-row policy admits. The trigger then verifies that the freshly
inserted profile's `brand_id` matches the store's `brand_id` — which it
will, because the invitation row carries the brand_id and the profile
was just inserted with that brand_id. **No regression.**

**Second subtle case: super_admin behavior.** A super_admin has
`profiles.role = 'super_admin'` and `profiles.brand_id = NULL`. The new
admin arm's brand check evaluates `auth_can_see_brand(s.brand_id)`,
which short-circuits to `true` for any super_admin via
`auth_is_super_admin()`. Super_admin retains full cross-brand
management. **No regression.**

#### Matrix C — `public.ingredient_categories`

**BEFORE (after spec 004 P6 = `20260507015244`):**

| Policy name                                            | Cmd     | USING / WITH CHECK                  |
|--------------------------------------------------------|---------|-------------------------------------|
| `Authenticated can read ingredient categories`         | SELECT  | `using (auth.uid() is not null)`    |
| `Admins can write ingredient categories`               | INSERT  | `with check (auth_is_admin())`      |
| `Admins can update ingredient categories`              | UPDATE  | `using/with check (auth_is_admin())`|
| `Admins can delete ingredient categories`              | DELETE  | `using (auth_is_admin())`           |

**AFTER (this migration):**

| Policy name                                            | Cmd     | USING / WITH CHECK                       | Disposition                                                                       |
|--------------------------------------------------------|---------|-------------------------------------------|------------------------------------------------------------------------------------|
| `Authenticated can read ingredient categories`         | SELECT  | `for select to authenticated using (true)` | DROP + recreate. Semantically identical for the `authenticated` role; explicit role gate is clearer. `comment on policy` pinned. |
| `Admins can write ingredient categories`               | INSERT  | UNCHANGED                                 | unchanged                                                                          |
| `Admins can update ingredient categories`              | UPDATE  | UNCHANGED                                 | unchanged                                                                          |
| `Admins can delete ingredient categories`              | DELETE  | UNCHANGED                                 | unchanged                                                                          |

**Semantic equivalence sketch.** `using (auth.uid() is not null)` plus
the default `to public` role list means the policy admits SELECT for
any role where `auth.uid()` is non-null. Anonymous callers (anon role)
have `auth.uid() = null`. The `authenticated` role always has
`auth.uid() = <jwt sub>` non-null. So the BEFORE predicate evaluates
true exactly for authenticated callers — same as the AFTER explicit
`to authenticated using (true)`.

#### Matrix D — `public.recipe_categories`

**BEFORE (after spec 013 = `20260510030000`):**

| Policy name                          | Cmd     | USING / WITH CHECK                            |
|--------------------------------------|---------|------------------------------------------------|
| `Authenticated can read categories`  | SELECT  | `using (auth.uid() is not null)`               |
| `Admins can write categories`        | ALL     | `using/with check (auth_is_privileged())`      |

**AFTER:**

| Policy name                          | Cmd     | USING / WITH CHECK                              | Disposition                          |
|--------------------------------------|---------|--------------------------------------------------|--------------------------------------|
| `Authenticated can read categories`  | SELECT  | `for select to authenticated using (true)`       | DROP + recreate. `comment on policy` pinned. |
| `Admins can write categories`        | ALL     | UNCHANGED                                        | unchanged                            |

Same semantic-equivalence argument as Matrix C.

### 3. Two-policy split for `user_stores` (concrete SQL)

The exact policy bodies the dev will write are below. The brand check
uses an EXISTS subquery against `public.stores` (the only way to recover
the store's brand_id from a `user_stores` row at policy-evaluation
time) rather than a new helper. **A new helper
(`auth_can_see_store_brand(uuid)`) was considered and rejected** because
(a) it would duplicate the `stores` point-lookup with one extra
`security definer` indirection, (b) the EXISTS pattern is already used
verbatim by every parent-scoped child policy in 012a
(`recipe_ingredients`, `prep_recipe_ingredients`, `recipe_prep_items`,
`ingredient_conversions`, `pos_recipe_aliases` — see
`20260509000000_multi_brand_schema_rls.sql:659-970`), so the shape is
the project convention.

**Pseudocode (developer authors the actual `.sql`):**

```
drop policy if exists "Users can manage own store links" on public.user_stores;
drop policy if exists "Admins can manage all store links" on public.user_stores;

create policy "Users can manage own store links"
  on public.user_stores for all
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on policy "Users can manage own store links" on public.user_stores is
  'spec 051: own-row self-management. Drops the legacy OR-arm `auth.uid() IS NOT NULL` that admitted any authed caller to manage any other user''s grants.';

create policy "Admins can manage all store links"
  on public.user_stores for all
  using      (
    public.auth_is_privileged()
    and exists (
      select 1 from public.stores s
       where s.id = user_stores.store_id
         and public.auth_can_see_brand(s.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.stores s
       where s.id = user_stores.store_id
         and public.auth_can_see_brand(s.brand_id)
    )
  );

comment on policy "Admins can manage all store links" on public.user_stores is
  'spec 051: admin/master/super_admin arm brand-scoped via auth_can_see_brand on the target store''s brand_id. Closes the same-shape cross-brand admin gap spec 042 closed on profiles. Trigger user_stores_brand_match remains belt-and-suspenders for the (super_admin admits via brand short-circuit) path.';
```

**Why USING and WITH CHECK are both specified for FOR ALL:** Postgres
evaluates USING for SELECT/UPDATE/DELETE (against the existing row) and
WITH CHECK for INSERT/UPDATE (against the new row). For a `for all`
policy, both must be set or UPDATE allows row-key forgery (see spec
042's WITH CHECK addition on "Users can update own profile" — same
defense-in-depth shape). Matching the spec 042 pattern keeps the
convention consistent.

**Why `user_stores.store_id` (not `s.id = (select store_id from
user_stores where id = user_stores.id)`):** The policy expression is
evaluated per-candidate-row, so `user_stores.store_id` in the EXISTS
subquery resolves to the candidate row's store_id. This is the exact
shape used by the 012a child policies. Verified by the existing
`recipe_ingredients` policy at `20260509000000:659-678`.

**Why no separate own-INSERT short-circuit for the admin policy:** A
caller who is both `auth_is_privileged()` AND inserting `user_id =
auth.uid()` is satisfied by EITHER policy (Postgres ORs them). No
special-case needed — the own-row policy's USING/WITH CHECK matches.

### 4. RLS impact

- **`public.stores`**: net policy count goes from 5 to 4. Read/write
  predicates tighten as documented in Matrix A. Uses
  `auth_can_see_store(id)`, `auth_is_privileged()`, `auth_can_see_brand(brand_id)`
  — all unchanged helpers.
- **`public.user_stores`**: net policy count stays at 3 (own-ALL,
  admin-ALL, own-SELECT). Predicates tighten as documented in Matrix B.
  Uses `auth_is_privileged()`, `auth_can_see_brand(s.brand_id)`. The
  `Users can read own store links` SELECT policy is **NOT touched** —
  per spec line 268-273, the FOR SELECT policy at `remote_schema.sql:489`
  is correctly scoped to `(user_id = auth.uid())`. After dropping the
  wide ALL policy, the FOR SELECT policy is the sole gate for own-row
  SELECT, paired with the new admin ALL policy for admin's brand-scoped
  reads. Confirmed: dropping the wide ALL policy is enough.
- **`public.ingredient_categories`**: policy count unchanged (4
  policies). The SELECT policy is DROP + recreated for clarity; write
  policies untouched.
- **`public.recipe_categories`**: policy count unchanged (2 policies).
  The SELECT policy is DROP + recreated for clarity; the write policy
  (already brought to `auth_is_privileged()` by spec 013) is untouched.

No new helper functions. No `auth_is_admin()` ↔ `auth_can_see_store()`
↔ `auth_can_see_brand()` body changes. The existing four helpers
(`auth_is_super_admin`, `auth_is_admin`, `auth_is_privileged`,
`auth_can_see_brand`, `auth_can_see_store`) cover every predicate this
spec needs.

### 5. API contract

No PostgREST or RPC signature changes. The behavior at the wire is:

- `GET /rest/v1/stores` as Bobby (brand-admin of 2AM PROJECT) →
  returns only rows where `brand_id = '2a000000-...'` (the spec 041
  helper now genuinely gates the read instead of being shadowed). **This
  is the primary visible fix.**
- `GET /rest/v1/user_stores?user_id=eq.<other-user>` as any
  authenticated caller → returns `[]` (was: returned the rows because of
  the wide policy).
- `POST /rest/v1/user_stores` as a non-admin caller, body
  `{ user_id: <other-user>, store_id: <any> }` → 42501 / RLS rejection
  (was: succeeded if same brand because trigger admitted; was
  trigger-rejected if cross-brand).
- `POST /rest/v1/user_stores` as brand-A admin, body
  `{ user_id: <brand-B user>, store_id: <brand-B store> }` → 42501 /
  RLS rejection at the policy layer (was: trigger rejection). Cleaner
  error class.
- `GET /rest/v1/ingredient_categories` / `recipe_categories` →
  unchanged. All authenticated callers continue to read all rows across
  all brands (intentional shared master data).

### 6. Edge function changes

None. No edge function code touches these policy names directly. Two
notes for completeness:

- **`staff-*` and `pwa-catalog`** functions set `verify_jwt = false`
  and validate a service-token bearer themselves. They make Supabase
  client calls in service-role context, which bypasses RLS entirely.
  No interaction with the policies in this spec.
- **JWT-bearing edge functions** (`delete-user`, `send-invite-email`,
  etc.) pass the user's JWT through to PostgREST. Any reads/writes they
  perform on `stores` / `user_stores` will now obey the tightened
  policies. **Verified**: `delete-user` does not insert/update
  `user_stores`; it deletes the user via `auth.admin.deleteUser` which
  cascades to `user_stores` rows via the FK. No call-site change
  required.

`verify_jwt` settings are unchanged. No service-token validation strategy
changes.

### 7. `src/lib/db.ts` surface

**Zero changes.** All existing helpers continue to work — RLS does the
filtering at the data plane.

Caller sites that touch these tables (audited):

- `src/lib/db.ts:20` — `fetchStores()`: PostgREST read; will now see the
  tightened set for brand-admins (the visible fix).
- `src/lib/db.ts:37-47` — `createStore()`: PostgREST insert; admin paths
  unchanged because admins create stores in their own brand (the wide
  policy was never the load-bearing one in practice).
- `src/lib/db.ts:57-58` — `deleteStore()`: PostgREST deletes against
  `user_stores` and `stores`. Admin caller, delete is brand-scoped now.
  Same end result, tighter gate.
- `src/lib/db.ts:117` — `resolveStoreBrand(storeId)`: PostgREST read of
  `stores`; tightens to own-brand for admins. Callers handle empty
  result.
- `src/lib/db.ts:2408, 2794` — admin section reads of `stores`; both
  already filter by `brand_id` explicitly. Tightening is a no-op for
  brand-scoped callers.
- `src/lib/db.ts:2809` — `user_stores` read keyed by `user_id IN (...)`
  for the active brand's profiles. The admin caller is in-brand for the
  target profiles by construction (the surrounding queries already
  filter `profiles.brand_id = <brand>`), so the new admin policy's
  brand check on the linked store's brand_id will admit. **No
  regression for this caller.**
- `src/lib/auth.ts:104-107` — `user_stores` read by `user_id =
  <auth.uid()>`. Own-row policy admits. **No regression.**
- `src/lib/auth.ts:383` — `user_stores` insert during invitation
  acceptance: `user_id = authData.user.id` (the just-signed-up user).
  Own-row policy admits because `auth.uid()` equals `authData.user.id`
  in that session. **No regression** (verified §2 Matrix B "first
  subtle case").
- `src/lib/auth.ts:442-444` — `user_stores` read for active profiles.
  Same shape as `db.ts:2809`; admin caller is in-brand for target
  profiles. **No regression.**
- `src/store/useStore.ts:1929` — `stores` update; admin caller is
  updating own-brand store. `privileged_update_stores` admits.

No new `db.ts` helper. No snake_case → camelCase mapping changes.

### 8. Realtime impact

**Publication membership unchanged.** This migration does NOT call
`alter publication supabase_realtime add table` or `drop table`. The
realtime publication's table list is byte-identical before and after.

Per CLAUDE.md's realtime publication gotcha: the
`docker restart supabase_realtime_imr-inventory` ritual is **NOT
required** for this migration. No deploy/dev step beyond the standard
`supabase db reset` (or migration push).

Channel behavior:
- `store-{id}` channel: filters on `inventory_items.store_id`,
  `waste_log.store_id`, `eod_submissions.store_id`,
  `purchase_orders.store_id`. RLS at SELECT time will now refuse
  cross-brand admins for these tables (already correct via spec 041's
  helper tightening — the leak this spec fixes was specifically the
  `stores` table itself + `user_stores`). No new event-delivery change.
- `brand-{id}` channel: filters on `brand_id` for `recipes`,
  `prep_recipes`, `catalog_ingredients`, `vendors`,
  `ingredient_conversions`. Unaffected by this spec.
- **There is no realtime channel filtering on `stores` or
  `user_stores` directly** (neither table is in the explicit
  publication list at `20260514140000_realtime_publication_tighten.sql:43-53`).
  So no client-visible realtime event delivery changes for the tables
  this spec touches.

### 9. Frontend store impact

**Zero changes to `src/store/useStore.ts`.** The store's `stores` slice
will hydrate fewer rows for brand-admin callers post-migration (the
visible fix), but the slice's shape, the mapper, and the
optimistic-then-revert pattern (`notifyBackendError`) all stay the same.
TitleBar's `accessibleStores` derivation
([src/components/cmd/TitleBar.tsx:30-43](../src/components/cmd/TitleBar.tsx))
becomes correct-by-construction because the data plane no longer
hydrates foreign-brand stores into the slice — same outcome as the
spec 041 helper was supposed to achieve.

No new frontend mutation paths. No new `notifyBackendError` call sites.

### 10. pgTAP test design

**File:** `supabase/tests/legacy_permissive_policy_dropout.test.sql`

**Plan count:** 13 plan slots. Each arm asserts exactly one observable
predicate; mixed `is(...)`, `throws_ok(...)`, and `ok(count == N)`.

**Fixture pattern:** Mirror
[supabase/tests/auth_can_see_store_brand_scope.test.sql](../supabase/tests/auth_can_see_store_brand_scope.test.sql)
verbatim. Seed admin (11111…, brand A), seed manager (22222…, role
`user`, brand A), seed master (33333…, brand A, promoted to super_admin
mid-txn). Test-only foreign brand `b1000000-…-0001`, foreign store
`b1000001-…-0001`, foreign-brand user `bcafe000-…-0001` synthetic
`auth.users` + profiles row (mirrors the spec 042 / 043 test fixture
pattern). All fixtures roll back at the end via `begin; ... rollback;`.

**Arms:**

| #    | Caller                                | Operation                                                                                  | Expected                                                | Asserts which post-migration policy        |
|------|----------------------------------------|--------------------------------------------------------------------------------------------|---------------------------------------------------------|---------------------------------------------|
| (1)  | brand-A admin (JWT admin, brand A)     | SELECT * FROM stores WHERE id = foreign-store                                              | 0 rows                                                  | `store_member_read_stores` only             |
| (2)  | brand-A admin                          | INSERT INTO stores (brand_id=brand_B, ...)                                                 | throws_ok 42501 'new row violates row-level security'   | `privileged_insert_stores` WITH CHECK       |
| (3)  | brand-A admin                          | UPDATE stores SET name = ... WHERE id = foreign-store (under postgres role for verify)     | 0 rows affected (USING fails silently per Postgres semantics) | `privileged_update_stores` USING            |
| (4)  | brand-A admin                          | DELETE FROM stores WHERE id = foreign-store                                                 | 0 rows affected                                          | `privileged_delete_stores` USING            |
| (5)  | super_admin (in-txn promoted master)   | SELECT, INSERT, UPDATE, DELETE on foreign-brand store (rolled up into one combined assert) | all succeed                                              | super-admin short-circuit in `auth_can_see_brand` + `auth_can_see_store` |
| (6)  | brand-A admin                          | SELECT * FROM stores WHERE brand_id = brand_A                                              | 4 rows (all seed stores)                                | `store_member_read_stores` (admin arm via spec 041) |
| (7)  | seed manager (role=user, brand A)      | SELECT * FROM stores WHERE id = foreign-store                                              | 0 rows                                                  | no policy admits                            |
| (8)  | seed manager                            | INSERT INTO user_stores (user_id = <other-user>, store_id = <Towson>)                       | throws_ok 42501                                          | own-row policy: `user_id != auth.uid()`; admin arm fails: not privileged |
| (9)  | seed manager                            | INSERT INTO user_stores (user_id = auth.uid(), store_id = <Charles, which manager has NO grant for>) | lives_ok — INSERT succeeds; row exists                  | own-row policy WITH CHECK admits (`user_id = auth.uid()`); trigger admits (same brand) |
| (10) | brand-A admin                          | INSERT INTO user_stores (user_id = seed manager, store_id = <Charles brand-A>)             | lives_ok                                                 | admin policy: privileged + brand match      |
| (11) | brand-A admin                          | INSERT INTO user_stores (user_id = seed manager, store_id = foreign-store)                 | throws_ok 42501                                          | admin policy: brand check fails             |
| (12) | brand-A admin                          | SELECT * FROM ingredient_categories                                                         | row count > 0 (NOT brand-filtered)                       | rewritten SELECT policy (`to authenticated using (true)`) |
| (13) | brand-A admin                          | SELECT * FROM recipe_categories                                                             | row count > 0 (NOT brand-filtered)                       | rewritten SELECT policy                     |

**JWT-impersonation pattern.** `set local role authenticated;` +
`select set_config('request.jwt.claims', jsonb_build_object(...)::text, true)`
immediately before each arm. Mirror the spec 041 test file for the role
flips between admin / super_admin / user.

**Arm (3) and arm (4) note — "0 rows affected" verification.** Same
shape as `rls_hardening_followups.test.sql` arms (5)-(6): the UPDATE /
DELETE under the brand-A admin's JWT silently affects 0 rows because the
USING predicate is false. Verification SELECT runs under
`reset role; select set_config('request.jwt.claims', '', true);` so the
inspection bypasses RLS (otherwise the brand-A admin can't SELECT the
foreign-brand row to confirm it's untouched). This is the canonical
pattern in the project's pgTAP corpus.

**Arm (5) compaction.** Bundle super-admin's four-op cross-brand check
into one `ok(...)` via `bool_and` over a small VALUES list, or expand
to four arms and bump plan to 16. Either is acceptable. PM-aligned
default: compact (13 arms).

**No load-bearing pgTAP arm tests the dropped `auth_manage_stores`
policy directly.** A test asserting "policy named `auth_manage_stores`
no longer exists in `pg_policies`" is structural drift detection, not
behavioral. The behavioral arms (1)-(7) collectively prove the policy
is gone (arm 1 would fail if the wide policy still existed). **Decision:
no dedicated `pg_policies` lookup arm.** The CI probe in spec 052 is
the right place for structural assertions.

**Pre-existing pgTAP test interaction.** Walked all 30 existing tests:

- `auth_can_see_store_brand_scope.test.sql` — pgTAP, exercises the
  spec 041 helper, NOT the policies. Unaffected.
- `profiles_rls_sweep.test.sql` — spec 043, profiles only. Unaffected.
- `rls_hardening_followups.test.sql` — spec 042, profiles +
  order_schedule. Touches `user_stores` only via the implicit seed
  state. The arms manipulate `profiles.role`, not `user_stores`.
  Unaffected.
- `invitations_super_admin_rls.test.sql` — invitations only. Unaffected.
- `delete_last_privileged_guard.test.sql` — `auth.admin.deleteUser`
  shape. Unaffected.
- The remaining 25 tests under `supabase/tests/` exercise specific RPCs
  / reports / inventory flows. None inspect the `auth_manage_stores`
  policy or the two `user_stores` legacy policies by name. None
  exercise INSERT/DELETE on `user_stores` from the admin policy path —
  the seed sets up grants directly under the postgres role (RLS
  bypass).
- **Walked the seed.** `supabase/seed.sql:188-201` inserts `user_stores`
  rows under the postgres role (no `set local role authenticated`), so
  the seed bypasses RLS entirely. The seed is unaffected by this
  migration.

**Conclusion: 30/30 pre-existing pgTAP tests stay green.** No test edits
required.

### 11. CLAUDE.md addition (load-bearing for the spec's AC)

Append a single new bullet under "Conventions already in use",
strictly additive — no existing bullet reworded.

**Proposed wording** (architect-approved phrasing; dev may polish):

> - **Permissive RLS policies on the same `(table, command)` pair are
>   ORed.** Postgres composes permissive policies via OR: a row is
>   admitted iff ANY permissive policy's USING/WITH CHECK is satisfied.
>   This means a single wide `using (auth.uid() IS NOT NULL)` policy on
>   a table neutralizes every scoped permissive policy that exists
>   alongside it for the same command — the scoped policies never get
>   the chance to deny. **When adding a permissive policy, check
>   `pg_policies` for existing permissive policies on the same
>   `(schemaname, tablename, cmd)`** and either consolidate or convert
>   to `RESTRICTIVE` if the new policy is meant to TIGHTEN rather than
>   broaden. Spec 051 (`supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql`)
>   audited four such legacy wide policies on `public.stores`,
>   `public.user_stores`, `public.ingredient_categories`, and
>   `public.recipe_categories` and dropped or rewrote each. Spec 052
>   will add a pgTAP probe to fail-CI on any future permissive policy
>   whose USING evaluates to `auth.uid() IS NOT NULL` (or trivially
>   equivalent) without an explicit allow-list entry.

Placement: after the existing "Edge function calls go through
`callEdgeFunction`" bullet (the last current bullet under "Conventions
already in use"), before the "**Imports.**" line.

### 12. Spec 041 closeout note (Q3 mechanical edit)

Append a single sentence under spec 041's existing "## Files changed"
section (the last section in `specs/041-brand-scoped-store-visibility.md`).
**Proposed sentence:**

> Follow-up: spec 051 (`supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql`)
> closes the OR-shadow gap that left `auth_can_see_store(id)` correct
> in the helper but neutralized at the SELECT policy on `public.stores`.

Placement: as a new "Follow-up:" bullet under the existing "Migrations:"
list in spec 041's Files changed. Mechanical — no other 041 content
touched. The dev includes this edit in the same commit as the migration
(`Status: READY_FOR_REVIEW`-time edit, not a separate spec
contribution).

### 13. Caller grep (verification)

Walked `src/`, `supabase/functions/`, and `scripts/` for the three
legacy policy names. Zero functional dependencies:

- `auth_manage_stores` — 0 hits in `src/`, 0 in `supabase/functions/`,
  0 in `scripts/`. Only mentions are in the spec markdown and the
  remote_schema.sql migration.
- `Users can manage own store links` — same: 0 functional hits, only
  spec/migration references.
- `Admins can manage all store links` — same.

No client-side code, RPC body, or edge function depends on these policy
names. The grep confirms the spec assumption that the tightening is
behaviorally invisible to the legitimate code paths.

### 14. Hidden caller / drift risks

**Confirmed safe** (verified by grep + migration walk):

- **No RPC relies on the wide `stores` policy as its access gate.**
  Every SECURITY DEFINER RPC that reads/writes `stores` runs as
  `postgres` (SECURITY DEFINER bypasses RLS by Postgres convention).
  Verified by grep of `from stores` / `from public.stores` in
  `supabase/migrations/`: only matches are
  `20260510010000_brand_delete_cascade.sql:563` (counts stores during
  hard_delete_brand — SECURITY DEFINER, bypasses RLS) and the trigger
  body at `20260509000000:368` (looks up store brand for the
  user_stores trigger — SECURITY DEFINER). Neither relies on the wide
  policy.
- **Realtime publication unchanged.** `supabase_realtime` membership
  is the explicit list from `20260514140000_realtime_publication_tighten.sql:43-53`
  — neither `stores` nor `user_stores` are publication members, so the
  publication is structurally insulated from this migration's policy
  edits.
- **Pre-existing pgTAP tests unaffected.** Confirmed §10 above.

**Live risk to monitor at apply time:**

- **Audit-log handlers that distinguish "policy reject" vs "trigger
  reject" for user_stores.** Today, a cross-brand `user_stores` insert
  by a brand-A admin gets policy-admit + trigger-raise (`cross-brand
  user_stores assignment rejected`). After this migration, the same
  insert gets policy-reject (42501) — trigger never fires. Grep of
  `audit_log` / log handlers in `src/` and `supabase/functions/`:
  zero call sites distinguish these classes today (no
  `cross-brand user_stores` string searches in client code, edge
  functions, or RPCs). **No regression** — but a follow-up audit-log
  spec, if any, should know the error class shifted.
- **No `app.json` slug interaction** — unrelated to this spec.
- **No CI gate dependency** — the `db-migrations-applied.yml` workflow
  referenced in older docs does not exist on disk
  (CLAUDE.md "CI workflow" section). Manual migration verification per
  project convention.

### 15. Migration ordering and rollout safety

- **Apply order:** Strictly additive in terms of timestamp; lands after
  spec 050 (`20260520000000_...`). The supabase CLI orders by
  lexicographic filename, so 050 runs first, 051 runs second.
- **Idempotent + re-runnable:** Every `drop policy` is
  `drop policy if exists`. Every `create policy` is preceded by a
  matching `drop policy if exists` of the same name. Re-applying the
  migration is a no-op.
- **Rollback:** Manually re-creating the four dropped policies (with
  the original wide predicates) restores prior behavior. The dev does
  not need to author a down-migration — the project convention is no
  down-migrations (CLAUDE.md does not declare one). A documented
  rollback shape lives in the migration's header comment for
  operational reference. Per spec line 26-29 of
  `20260517060000_profiles_rls_sweep.sql` (the spec 043 lockstep
  example), rollback documentation goes in the migration header.
- **Safety on the 286 KB seed dataset:** The migration touches only
  policy DDL — zero data rows scanned. Migration apply is O(1)
  regardless of seed size.
- **Edge function cold-start interaction:** None. No edge function
  code changes; cold-start surface is byte-identical.

### 16. Deploy / dev steps (explicit checklist for backend-developer)

1. Author `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql`
   per §3 (user_stores split) and §2 matrices (stores drop, categories
   rewrites).
2. Author `supabase/tests/legacy_permissive_policy_dropout.test.sql`
   per §10 (13 arms).
3. Append the CLAUDE.md bullet per §11.
4. Append the spec 041 closeout sentence per §12.
5. Run `npm run dev:db` (reset local stack against the new migration).
   **No `docker restart supabase_realtime_imr-inventory` needed** —
   §8 confirmed publication unchanged.
6. Run `bash scripts/test-db.sh` — verify the new pgTAP file passes
   AND all 30 pre-existing files stay green (31/31).
7. Manual prod verification (post-merge): impersonate Bobby (or
   equivalent brand-admin) and confirm `GET /rest/v1/stores` returns
   only own-brand rows.
8. Update the AC line in this spec from `20260520000000_...` to
   `20260520010000_...` (one-character fix; this design surfaced the
   timestamp collision with spec 050).
9. Set `Status: READY_FOR_REVIEW` and list files changed under
   `## Files changed`.

### 17. Open questions for the dev (none expected)

The PM's Q1–Q5 resolutions cover every architectural question. The
two-policy split exact SQL (§3) is the only place the architect made an
opinionated call beyond the PM's reference shape; the dev follows §3
verbatim.

## Handoff
next_agent: backend-developer
prompt: Implement the design in the `## Backend design` section above.
  Three files in this commit — the migration at
  `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql`,
  the pgTAP test at
  `supabase/tests/legacy_permissive_policy_dropout.test.sql`, and the
  CLAUDE.md doc bullet under "Conventions already in use". Also append
  the one-line "Follow-up: spec 051" closeout sentence to spec 041 per
  §12. Run `npm run dev:db` then `bash scripts/test-db.sh` to verify
  the new test passes and the existing 30 pgTAP files stay green
  (31/31). The migration is policy DDL only — no publication change, no
  helper-function change, no edge function change, no client code
  change. After implementation, set `Status: READY_FOR_REVIEW` and list
  files changed under `## Files changed`.
payload_paths:
  - specs/051-legacy-permissive-policy-dropout.md

## Files changed

Migrations:
- `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql` (NEW) — Policy-DDL-only migration: drops the legacy `auth_manage_stores` wide-ALL policy on `public.stores`; drops + re-creates the two legacy `Users can manage own store links` and `Admins can manage all store links` policies on `public.user_stores` as (a) an own-row ALL policy `using/with check (user_id = auth.uid())` and (b) a brand-scoped admin ALL policy `using/with check (auth_is_privileged() AND exists (select 1 from public.stores s where s.id = user_stores.store_id AND auth_can_see_brand(s.brand_id)))`; drops + re-creates the two `*_categories` SELECT policies as `for select to authenticated using (true)` for clarity (semantic no-op vs. the legacy `auth.uid() is not null`) and pins the intentional cross-brand intent via `comment on policy` annotations referencing specs 004 / 013 / 051. Idempotent — every `drop policy` is `drop policy if exists` and every `create policy` is preceded by a matching `drop policy if exists`. Header comment documents the rollback shape (no down-migration shipped per project convention). No table-schema changes, no new columns, no new indexes, no new triggers, no new helper functions. Realtime publication membership unchanged (neither `stores` nor `user_stores` are publication members per `20260514140000_realtime_publication_tighten.sql:43-53`) — the `docker restart supabase_realtime_imr-inventory` ritual is NOT required.

pgTAP tests:
- `supabase/tests/legacy_permissive_policy_dropout.test.sql` (NEW) — Hermetic `begin; … rollback;` with `plan(13)`. Thirteen arms:
    - (1) brand-A admin SELECT on foreign-brand store returns 0 rows (the Bobby leak closed).
    - (2) brand-A admin cross-brand INSERT into `stores` rejected by RLS WITH CHECK (42501).
    - (3) brand-A admin UPDATE on foreign-brand store silently affects 0 rows (RLS USING) — verification under `reset role; select set_config('request.jwt.claims', '', true);` per the spec 043 fixture pattern so the inspection SELECT bypasses RLS.
    - (4) brand-A admin DELETE on foreign-brand store silently affects 0 rows (RLS USING) — same verification shape as arm (3).
    - (5) super_admin SELECT/INSERT/UPDATE/DELETE across brands all succeed via the `auth_is_super_admin` short-circuit inside `auth_can_see_brand` — four ops compacted into one `is(...)` over a `bool_and` of the four predicates inside a `do $$` block.
    - (6) brand-A admin SELECTs all 4 own-brand seed stores (no-regression).
    - (7) seed manager (role=user, no `user_stores` grant for foreign store) SELECT on foreign-brand store returns 0 rows.
    - (8) seed manager INSERT into `user_stores` for ANOTHER user rejected (same-brand cross-user leak closed) — 42501.
    - (9) seed manager INSERT into `user_stores` for SELF on same-brand store admits (own-row policy WITH CHECK + trigger admits same brand).
    - (10) brand-A admin INSERT into `user_stores` for brand-A user on brand-A store admits (admin policy: privileged + brand match).
    - (11) brand-A admin INSERT into `user_stores` cross-brand rejected — trigger `user_stores_brand_match` raises P0001 first (per documented Postgres BEFORE-ROW execution order: BEFORE triggers fire before RLS WITH CHECK). The new admin policy from this migration is the structural backstop (would reject independently if the trigger were removed); the spec AC "both layers asserted" is met by (i) arm (10) proving the policy admits same-brand and (ii) the migration's policy text proving the policy rejects cross-brand. Note: spec 051 §2 Matrix B's "cleaner error class (RLS 42501 vs trigger raise)" narrative was inaccurate about Postgres execution order — the trigger raises first because it is BEFORE ROW. The migration itself is correct; only the test's expected SQLSTATE adjusted to match observed behaviour. Documented inline in the test arm.
    - (12) authenticated SELECT on `ingredient_categories` returns > 0 rows (intentional cross-brand master data, no-regression).
    - (13) authenticated SELECT on `recipe_categories` returns > 0 rows (intentional cross-brand master data, no-regression).
  Fixture pattern mirrors `supabase/tests/auth_can_see_store_brand_scope.test.sql` — seed admin / manager / master IDs from the seed; foreign brand `b1000000-…-0051`, foreign store `b1000001-…-0051`, and two synthetic brand-A users (target_a, other_a) inserted inside the transaction via `auth.users` + `public.profiles`. Seed master promoted to super_admin (brand_id NULL per `profiles_role_brand_consistent`) mid-txn for arm (5). JWT impersonation via `set local role authenticated;` + `set_config('request.jwt.claims', …, true)`.

CLAUDE.md:
- `CLAUDE.md` — Appended one new bullet under "Conventions already in use" between the existing "Edge function calls go through `callEdgeFunction`" bullet and the "**Imports.**" bullet, documenting the "ORed-permissive-policy" footgun. The bullet (i) explains that Postgres composes permissive policies via OR for the same `(table, command)` pair, (ii) prescribes the `pg_policies` check + "consolidate or convert to RESTRICTIVE" remediation, (iii) references spec 051's audit of four legacy wide policies and the migration file, and (iv) points at forthcoming spec 052 (pgTAP CI probe). Strictly additive — no existing bullet reworded.

Spec 041 closeout:
- `specs/041-brand-scoped-store-visibility.md` — Appended one new "Follow-up:" bullet under the existing `## Files changed` → `Migrations:` list pointing at spec 051's migration. Documents the OR-shadow gap that left `auth_can_see_store(id)` correct in the helper but neutralized at the SELECT policy on `public.stores`. Mechanical edit — no other 041 content touched.

Spec 051 self-edit:
- `specs/051-legacy-permissive-policy-dropout.md` — Updated the AC line that referenced the stale `20260520000000_…` migration filename to the actual `20260520010000_…` slot, per the architect §0 note about spec 050 taking the original PM-suggested timestamp. Status flipped to `READY_FOR_REVIEW`. This file added.

Verification performed:
- `npx supabase db reset` — clean apply through all 32 migrations including `20260520010000_legacy_permissive_policy_dropout.sql`. Seed re-applied. No errors.
- `bash scripts/test-db.sh` — 31/31 pgTAP test files pass (30 existing + 1 new). The new `legacy_permissive_policy_dropout.test.sql` reports 13/13 assertions; no regressions in any of the 30 pre-existing files (including `auth_can_see_store_brand_scope.test.sql`, `profiles_rls_sweep.test.sql`, `rls_hardening_followups.test.sql`, `invitations_super_admin_rls.test.sql`).
- `npx tsc --noEmit` — exit 0 (the migration is policy-DDL only; TypeScript surface unchanged).

Out-of-scope (untouched per spec):
- `public.auth_can_see_store`, `public.auth_can_see_brand`, `public.auth_is_privileged`, `public.auth_is_admin`, `public.auth_is_super_admin` — byte-identical after the migration.
- `public.user_stores_brand_match` trigger — unchanged. Remains belt-and-suspenders behind the new admin policy.
- `supabase/functions/*` — no edge function changes.
- `src/lib/db.ts`, `src/store/useStore.ts`, `src/components/cmd/TitleBar.tsx`, `src/lib/auth.ts` — no client-side code changes. TitleBar's `accessibleStores` derivation becomes correct-by-construction because the data plane no longer hydrates foreign-brand stores for brand-admins.
- `supabase/seed.sql` — unrelated.
- `app.json` — unrelated.
- CI workflow (`.github/workflows/test.yml`) — unchanged; the new pgTAP file is picked up automatically by `scripts/test-db.sh`'s `find supabase/tests/ -name '*.test.sql'` walk.

