# Spec 049: Cross-brand catalog copy/paste (Cmd UI)

Status: READY_FOR_REVIEW

## User story
As a super-admin operating a multi-brand environment, I want to copy
`catalog_ingredients` and `vendors` from one brand into another brand
from the Cmd UI — both as one-offs (per-row "Copy to brand…") and in
bulk (multi-select checkbox + top-bar "Copy N items to brand…") — so
that I can seed a new brand from an existing one without re-typing the
catalog or running the whole-catalog `copy_brand_catalog` RPC from a
SQL console.

Authoring stays in the user's own brand. The per-store "create for all
stores" toggle (Spec 041 era) stays brand-scoped — it is NOT being
generalized to cross brands. Cross-brand reach is the explicit feature
this spec adds, and only via deliberate copy actions performed by
super-admins.

## Background — what already exists
- `public.copy_brand_catalog(p_source_brand_id, p_target_brand_id)`
  ([supabase/migrations/20260517030000_copy_brand_catalog.sql](../supabase/migrations/20260517030000_copy_brand_catalog.sql))
  bulk-clones every row of `catalog_ingredients` from source to
  target, `ON CONFLICT (brand_id, lower(name)) DO NOTHING`. Returns the
  inserted-row count. Gated by `auth_is_privileged()` plus
  `auth_can_see_brand` on both source and target.
- TS wrapper: `copyBrandCatalog(sourceBrandId, targetBrandId)` at
  [src/lib/db.ts:2544](../src/lib/db.ts).
- `auth_is_super_admin()` helper exists in the auth helpers; the
  cross-brand copy RPC and UI affordances gate on it (NOT the broader
  `auth_is_privileged()` which also lets brand-scoped admin/master in).
- This spec covers the **per-row / multi-row, UI-driven** variant —
  where the user explicitly picks N items in the source brand and
  copies them to a single target brand. The whole-catalog RPC stays as
  a complementary "seed everything at once" primitive.

## Acceptance criteria

### Backend — RPC contract
- [ ] A new SECURITY DEFINER RPC accepts
      `(p_source_brand_id uuid, p_target_brand_id uuid, p_table text,
      p_source_ids uuid[])` where `p_table` is one of
      `'catalog_ingredients'` or `'vendors'`. Any other value raises a
      structured error.
- [ ] The RPC inserts the selected rows into the target brand using
      `ON CONFLICT DO NOTHING` keyed on the existing per-brand
      uniqueness constraint (`(brand_id, lower(name))` for
      `catalog_ingredients`; the project's existing vendor uniqueness
      for `vendors` — architect to confirm exact constraint name).
- [ ] The RPC returns a single result envelope of shape
      `{copied: int, skipped: int, skipped_names: text[]}` so the
      caller can render a precise toast. `skipped_names` is bounded
      (e.g., first 20) to avoid runaway payloads.
- [ ] The RPC rejects callers who fail `auth_is_super_admin()` with
      Postgres `42501` (`permission denied`). Admin and master roles
      MUST be rejected even when they can see both source and target
      brands.
- [ ] The RPC rejects calls where the super-admin cannot see either
      brand via `auth_can_see_brand` (defense in depth — super-admin
      effectively sees all brands today, but the check stays in to
      survive future scope tightening).
- [ ] On success, the RPC writes exactly ONE `audit_log` row in the
      **target brand** with shape
      `{actor_id: auth.uid(), brand_id: <target>, action:
      'catalog_copy', payload: {source_brand_id, table, names,
      skipped_count}}` where `names` is the list of source row names
      successfully copied. No audit row in the source brand.
- [ ] The RPC executes the inserts and the audit row in a single
      transaction; partial failure rolls back both.

### Frontend — Cmd UI affordances
- [ ] Inventory > Ingredients section
      ([src/screens/cmd/sections/InventoryCatalogMode.tsx](../src/screens/cmd/sections/InventoryCatalogMode.tsx)
      or its current equivalent) gains BOTH:
      (a) a per-row overflow menu item "Copy to brand…" that opens a
      brand picker for one item; and
      (b) a multi-select checkbox column with a top-bar action "Copy N
      items to brand…" that opens the same picker for the selected
      rows.
- [ ] Inventory > Vendors section gains the same two affordances
      (per-row overflow "Copy to brand…" + multi-select checkbox +
      top-bar bulk action).
- [ ] Both affordances are visible **only** to callers whose role is
      `super_admin`. Admin and master callers see neither the overflow
      item nor the multi-select-driven top-bar action. The check uses
      the existing role hook / auth helper, NOT a hardcoded literal.
- [ ] The brand picker lists only brands the caller can see via
      `auth_can_see_brand` and excludes the current source brand
      (cannot copy a brand to itself).
- [ ] The picker dialog explicitly shows the copy text
      "Existing items in the target brand will be skipped." so the
      user is not surprised by the skip-on-conflict behavior.
- [ ] On RPC completion, a toast renders
      `"N copied, M skipped"` (e.g., `"3 copied, 2 skipped"`). On RPC
      failure, `notifyBackendError` renders the structured error
      toast.
- [ ] No new sidebar entry; affordances live inside the existing
      Inventory > Ingredients and Inventory > Vendors sections.

### Negative tests
- [ ] **UI-layer gate**: an admin (or master) user signed in does NOT
      see the per-row "Copy to brand…" overflow item, the multi-select
      checkbox column dedicated to cross-brand copy, or the top-bar
      "Copy N items to brand…" affordance on either section.
- [ ] **RPC-layer gate**: an admin (or master) user who calls the RPC
      directly (e.g., from a console or a forged client) receives a
      `42501` / `permission denied` error and NO rows are inserted in
      the target brand and NO audit row is written.
- [ ] Calling with `p_table = 'recipes'` (or any value outside the v1
      whitelist) raises a structured error and writes no rows.
- [ ] Calling with `p_source_brand_id = p_target_brand_id` is
      rejected without writing rows.

### Tests / infra
- [ ] A new migration at
      `supabase/migrations/<YYYYMMDDHHMMSS>_spec049_cross_brand_copy.sql`
      contains the new RPC and any helper indexes.
- [ ] A new pgTAP test file at
      `supabase/tests/cross_brand_copy.test.sql` covers, at minimum:
      (a) super_admin can copy N source rows of
      `catalog_ingredients` and `vendors` into a target brand and the
      result envelope reports the correct `copied`/`skipped` split;
      (b) admin is rejected with `42501`; master is rejected with
      `42501`;
      (c) skip-on-conflict — pre-seed the target with a row of the
      same lower(name), run copy, assert that row is in
      `skipped_names` and not duplicated;
      (d) calling with `p_table = 'recipes'` raises a structured
      error and writes nothing;
      (e) `source = target` is rejected;
      (f) exactly one `audit_log` row lands in the target brand with
      the expected `action='catalog_copy'` payload shape; zero in
      source brand.
- [ ] All existing pgTAP tests under `supabase/tests/*.test.sql`
      continue to pass after the migration runs.
- [ ] No `app.json` changes (slug stays `towson-inventory` per CLAUDE.md
      "app.json slug mismatch (DO NOT AUTO-FIX)").
- [ ] No realtime publication membership changes — the rows inserted
      land in tables already in the `supabase_realtime` publication
      ([per the multi-brand-schema migration](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)
      and earlier per-store-RLS work), so clients in the target brand
      pick up the change via the existing `brand-{target-id}` channel.
      (Spec 049 to verify, not modify.)
- [ ] Client calls the new RPC via `supabase.rpc(...)` through
      [src/lib/db.ts](../src/lib/db.ts) (matching the existing
      `copyBrandCatalog` shape). No edge function is added.

## In scope
- A new SECURITY DEFINER RPC keyed on `(source_brand_id,
  target_brand_id, table, source_ids[])` supporting **two tables only**:
  `catalog_ingredients` and `vendors`.
- The matching TS wrapper(s) in [src/lib/db.ts](../src/lib/db.ts) —
  one helper that accepts the table parameter, or two thin wrappers
  (architect's call).
- Cmd UI affordances on Inventory > Ingredients AND Inventory >
  Vendors:
  - Per-row overflow menu "Copy to brand…"
  - Multi-select checkbox column + top-bar "Copy N items to brand…"
- A brand picker dialog (reusing an existing picker if one exists,
  otherwise a thin new component) scoped to brands the caller can see
  and excluding the current source brand. Shows the
  "existing items will be skipped" warning copy.
- Skip-on-conflict semantics, matching the existing
  `copy_brand_catalog` RPC.
- A single `audit_log` row in the target brand per successful copy
  call (one row per RPC call, not one per copied item).
- Toast on completion showing `"N copied, M skipped"`.
- pgTAP test coverage at
  `supabase/tests/cross_brand_copy.test.sql` covering both happy paths
  and all three negative cases (admin reject, master reject, wrong
  `p_table` reject).

## Out of scope (explicitly)
- **Recipes, prep_recipes, and their ingredient FK chains.** Deferred
  to v2. The FK remapping decision (`recipe_ingredients` →
  target-brand `catalog_ingredients`) is the messy part and needs its
  own spec. Rationale: keep v1 small and shippable.
- **`pos_recipe_aliases`.** Not a natural cross-brand copy target;
  aliases are tightly menu-coupled to a brand's POS configuration.
- **`ingredient_conversions`.** Conversions are brand-specific (unit
  preferences, density assumptions); they are not portable as-is. v2
  may revisit.
- **`recipe_categories`.** Already global per Spec 013 (no `brand_id`
  axis); cross-brand copy is N/A.
- **Overwrite, append-with-suffix, refuse-on-conflict.** v1 ships
  skip-only, matching the existing `copy_brand_catalog` semantics. A
  future spec can add a `conflict_policy` enum if real demand emerges.
- **A radio/picker in the dialog for conflict policy.** Not in v1.
  The picker dialog states the policy as fixed copy.
- **Multi-source-brand selection.** v1 is one-source-brand-to-one-
  target-brand. Copying from multiple source brands into one target in
  a single action is v2 if ever.
- **Cross-tenant copy.** Different orgs / tenants are not a thing in
  this system; everything is one tenant with multiple brands.
- **Generalizing the "create for all stores" toggle to cross-brand.**
  The toggle stays brand-scoped. Cross-brand actions only happen via
  the explicit copy affordances added by this spec.
- **Two-way sync.** After the copy, the two rows are independent.
  Editing one does NOT propagate to the other. Matches existing
  `copy_brand_catalog` semantics.
- **Cascade copy across linked tables.** Copying a vendor does NOT
  pull in its vendor-ingredient links, contracts, etc. Each table is
  its own opt-in.
- **Cross-brand `inventory_items` copy.** `inventory_items` are
  per-store, not per-brand catalog. Adding catalog rows to a brand
  triggers normal per-store creation flows separately.
- **Bulk import from CSV.** Out of scope — this is brand-to-brand
  copy. CSV import is a separate workflow.
- **Edge function path.** Direct PostgREST RPC is the chosen path.
  Edge function reserved for the day we need batched cross-table
  semantics that PostgREST can't express cleanly.
- **Changing the existing `copy_brand_catalog` RPC's public
  contract.** Spec 049 adds the per-row variant; the whole-catalog
  variant stays. Architect may refactor under the hood if a common
  helper emerges, but the public signature of `copy_brand_catalog`
  does not change.
- **Allowing admin / master to push catalog into brands they
  administer.** They are brand-scoped per Spec 041; super-admin only
  for cross-brand copy in v1.
- **Audit log in the source brand.** Target-brand-only per the user's
  decision. No double-logging.
- **`app.json` slug change.** Stays `towson-inventory` pending
  explicit user approval (per CLAUDE.md "app.json slug mismatch
  (DO NOT AUTO-FIX)").

## Open questions resolved
- **Q1 — Tables in scope (v1):** `catalog_ingredients` and `vendors`
  ONLY. Recipes / prep_recipes deferred to v2 (FK remap is the messy
  part). `pos_recipe_aliases` and `ingredient_conversions` not in v1
  (tightly menu/unit-coupled). `recipe_categories` out (already global
  per Spec 013).
- **Q2 — Role gate:** Super_admin only. Admin and master are
  brand-scoped per Spec 041 and cannot push catalog into brands they
  don't own. Gate is enforced at BOTH the RPC layer
  (`auth_is_super_admin()` check) and the UI layer (affordances
  hidden). No partial trust on the client.
- **Q3 — Conflict semantics:** Skip-on-conflict (matches existing
  `copy_brand_catalog` `ON CONFLICT DO NOTHING`). No radio in v1; the
  picker dialog states the policy as fixed copy. Overwrite / suffix
  variants left to a future spec.
- **Q4 — Recipe FK remapping:** N/A — recipes out of scope for v1.
- **Q5 — UI shape:** Both. Per-row overflow menu for one-offs PLUS
  multi-select checkbox column with top-bar bulk action for seeding
  scenarios. Both sit on the existing Inventory > Ingredients and
  Inventory > Vendors sections.
- **Q6 — Audit log:** Target brand only. Single `audit_log` row in
  the receiving brand per RPC call with shape `{actor_id, brand_id,
  action: 'catalog_copy', payload: {source_brand_id, table, names,
  skipped_count}}`. No source-brand audit row.
- **Q7 — Where it lives:** Inside each section. No new sidebar entry.
  Inventory > Ingredients gets the affordances; Inventory > Vendors
  gets the affordances. Vendors sits in its existing location (sub-
  section under Inventory or wherever it currently lives in the Cmd
  UI) — match the existing surface.

## Dependencies
- Brand-isolation infrastructure: Spec 041 (`auth_can_see_store`
  brand scope), Spec 042 (RLS hardening followups), Spec 043
  (profiles RLS sweep). All landed.
- `copy_brand_catalog` RPC and TS wrapper (already shipped — see
  Background).
- `auth_can_see_brand(uuid)` helper and `auth_is_super_admin()` helper
  ([supabase/migrations/20260509000000_multi_brand_schema_rls.sql](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)
  and related auth-helper migrations).
- `audit_log` table — existing shape (`actor_id`, `brand_id`,
  `action`, `payload jsonb`, `created_at`). Architect to confirm the
  exact column list against the current schema before finalizing the
  RPC's INSERT statement.
- pgTAP runner at [scripts/test-db.sh](../scripts/test-db.sh).
- Existing per-brand uniqueness constraints on `catalog_ingredients`
  (`(brand_id, lower(name))`) and `vendors` (architect to confirm
  vendor uniqueness constraint name).

## Project-specific notes
- **Cmd UI section.** Affordances added in
  [src/screens/cmd/sections/InventoryCatalogMode.tsx](../src/screens/cmd/sections/InventoryCatalogMode.tsx)
  (or whatever the current ingredients-section file is named) and the
  vendors section file under
  [src/screens/cmd/sections/](../src/screens/cmd/sections/). No new
  section file. No
  [CmdNavigator.tsx](../src/navigation/CmdNavigator.tsx) wiring
  changes.
- **Per-store or admin-global.** Admin-global at the action layer
  (brand-to-brand operation, not store-to-store). Per-row authoring in
  the source brand remains brand-scoped via existing RLS.
- **Realtime channels touched.** None added. Target-brand subscribers
  on `brand-{target-id}` see the new rows via the existing
  publication. Per CLAUDE.md "Realtime publication gotcha", any change
  to the realtime publication would need a `docker restart
  supabase_realtime_imr-inventory` to re-snapshot the slot — Spec 049
  explicitly does NOT change the publication, so this gotcha does not
  apply, but the architect should flag it as a risk if the
  implementation ends up touching the publication for any reason.
- **Migrations needed.** Yes — one migration adding the new
  cross-brand-copy RPC.
- **Edge functions touched.** None. Direct PostgREST RPC through
  `supabase.rpc(...)` in [src/lib/db.ts](../src/lib/db.ts), matching
  the existing `copyBrandCatalog` shape.
- **Web/native scope.** Web + native both. The Cmd UI ships to both;
  no web-only APIs (web-push, etc.) are involved.
- **Test track.** pgTAP for the RPC + RLS gates (mandatory). Jest for
  the TS wrapper if the wrapper grows non-trivial mapping logic;
  otherwise optional. Shell smokes not required as a CI gate per
  CLAUDE.md "Test framework" guidance.
- **Role-gate parity with edge functions.** N/A — this spec adds no
  edge functions. The role check lives in the RPC via
  `auth_is_super_admin()` and in the UI via the existing role hook.
- **`app.json` slug.** Unchanged. Stays `towson-inventory` per
  CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)".

## Backend design

### A — Headline contract decisions

1. **Single dispatching RPC.** `public.copy_catalog_rows(p_source_brand_id uuid, p_target_brand_id uuid, p_table text, p_source_ids uuid[])`. One grant, one revoke, one pgTAP suite. Both target tables share the same gate set (super-admin + visibility on both brands + source != target + table whitelist) and the same result envelope; dispatching inside the function on `p_table` keeps the public surface small. The two table branches are short (one INSERT … SELECT … ON CONFLICT each), so the "duplicated boilerplate" concern from PM Q1 is bounded. Mirrors the spec's AC §"Backend — RPC contract" wording verbatim.

2. **Selection keyed on UUIDs, not names.** PM's "names" framing in the audit payload still holds, but the RPC accepts `p_source_ids uuid[]` per the AC. Rationale: a name-keyed selection re-implements the brand's case-insensitive uniqueness inside the RPC and races against concurrent edits in the source brand. UUIDs are stable. Names are derived server-side from the selected rows before INSERT and persisted into the audit row so the operator can read "what got copied" without joining the audit row back to source rows that may have been renamed since. This also resolves PM open question "names parameter — case-sensitive match or case-insensitive?": the question is moot under UUID-keyed selection.

3. **`SECURITY DEFINER` with explicit gate.** Matches existing `copy_brand_catalog` ([supabase/migrations/20260517030000_copy_brand_catalog.sql](../supabase/migrations/20260517030000_copy_brand_catalog.sql)). Rationale: the RPC must INSERT into the target brand's `catalog_ingredients` / `vendors`, and we want the explicit `auth_is_super_admin()` gate to be the only authorization path — not a layered policy interaction where, e.g., a future RLS loosening would silently re-open the door. Definer also lets the function write the audit row to `audit_log` even though super-admin's JWT lacks `app_metadata.role='admin'` (see Risks §1). `set search_path = public` like the existing helper. The gate set inside the function body is:
   - `auth_is_super_admin()` — admin and master MUST be rejected with `raise exception 'super_admin only'` (mapped to SQLSTATE `42501` is the existing precedent in `copy_brand_catalog`; we'll follow the same shape but with a more specific message). The pgTAP arm asserts the exception message; the existing `throws_ok` shape in [supabase/tests/copy_brand_catalog.test.sql:47-51](../supabase/tests/copy_brand_catalog.test.sql) is the model.
   - `auth_can_see_brand(p_source_brand_id)` and `auth_can_see_brand(p_target_brand_id)` — defense-in-depth per AC, even though super-admin's `auth_can_see_brand` short-circuits to TRUE today.
   - `p_source_brand_id <> p_target_brand_id` — same shape as existing `copy_brand_catalog`.
   - `p_table in ('catalog_ingredients', 'vendors')` — whitelist; raise `'invalid table: %'` otherwise.

### B — Data model changes

**Migration filename**: `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` (date-only ordering; first to use 2026-05-18 so the timestamp portion can be `000000`).

**Additive, no destructive shape changes.** Two pieces:

1. **New unique index on `vendors`** to support `ON CONFLICT (brand_id, lower(name)) DO NOTHING`. This index does NOT exist today (confirmed: only `eod_submissions_store_date_key`, `order_schedule_store_id_day_of_week_vendor_name_key`, and the recipes brand-menu-item unique are on the books; vendors has no name uniqueness at all). Index spec:

   ```sql
   create unique index if not exists vendors_brand_name_lower_unique
     on public.vendors (brand_id, lower(name));
   ```

   **Rollout safety check.** The seed dataset has 9 vendors in brand `2a0…001` with distinct uppercase names (BJs, COSTCO, GOLDEN CITY …) so there's no in-prod-seed collision. However, prod may have accidental case-variant duplicates that haven't been noticed. The migration MUST include a pre-flight DO block that aborts with a clear message if any `(brand_id, lower(name))` collision exists in `vendors`, mirroring the spec 012a pre-flight shape ([20260509000000_multi_brand_schema_rls.sql:256-271](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)). On collision, the operator runs a manual dedupe before re-applying. Do NOT silently `delete` rows.

2. **New RPC** `public.copy_catalog_rows(uuid, uuid, text, uuid[])` returning a composite type. Signature:

   ```
   create type public.copy_catalog_result as (
     copied        int,
     skipped       int,
     skipped_names text[]
   );

   create or replace function public.copy_catalog_rows(
     p_source_brand_id uuid,
     p_target_brand_id uuid,
     p_table           text,
     p_source_ids      uuid[]
   ) returns public.copy_catalog_result
   language plpgsql
   security definer
   set search_path = public
   as $$ … $$;

   revoke execute on function public.copy_catalog_rows(uuid, uuid, text, uuid[]) from public, anon;
   grant  execute on function public.copy_catalog_rows(uuid, uuid, text, uuid[]) to authenticated;
   ```

   Composite type is preferable to `jsonb` for the return because PostgREST hands the caller a typed object the wrapper can read field-by-field with no JSON parse. `skipped_names` is bounded inside the function body to 20 (`array_agg(name order by name) … limit 20` over the conflict set) per AC; the unbounded count goes in `skipped`.

   **Body sketch** (pseudocode, not committed):

   ```
   1. Gate (super_admin, see source, see target, source <> target, table in whitelist).
   2. Lock source ids: select id, name from <table> where brand_id = p_source_brand_id and id = any(p_source_ids).
      Names captured here are the v_source_names text[] used for audit.
   3. Pre-compute the skip set: which v_source_names already exist in target as lower(name)?
      v_skipped_names := array_agg(distinct name) over the conflict rows, bounded by limit 20.
      v_skipped := full conflict count (unbounded).
   4. INSERT into <target table> (brand_id, <columns>) SELECT p_target_brand_id, <columns>
      FROM <source table> WHERE brand_id = p_source_brand_id AND id = any(p_source_ids)
      ON CONFLICT (brand_id, lower(name)) DO NOTHING.
   5. GET DIAGNOSTICS v_copied = ROW_COUNT.
   6. If v_copied = 0 AND v_skipped = 0: skip the audit insert (no-op; nothing happened).
      Else: INSERT INTO audit_log (...) per §C below.
   7. RETURN (v_copied, v_skipped, v_skipped_names)::public.copy_catalog_result.
   ```

   **Column list for catalog_ingredients copy** (mirror existing `copy_brand_catalog`):
   `name, unit, category, case_qty, sub_unit_size, sub_unit_unit, default_cost, default_case_price, coalesce(i18n_names, '{}'::jsonb)`. Do NOT propagate `id, brand_id, created_at, updated_at`.

   **Column list for vendors copy**: `name, contact_name, phone, email, account_number, lead_time_days, delivery_days, categories, order_cutoff_time, eod_deadline_time`. Do NOT propagate `id, brand_id, last_order_date` (per-brand operational state) or `created_at`. `categories` and `delivery_days` are `text[]`; copy as-is.

### C — `audit_log` shape — diverges from PM spec

**Finding**: the spec's payload shape `{actor_id, brand_id, action: 'catalog_copy', payload: {...}}` does NOT match the actual `audit_log` columns. Current shape (verified [supabase/migrations/20260405000759_init_schema.sql:196-205](../supabase/migrations/20260405000759_init_schema.sql)):

```
audit_log (
  id          uuid primary key,
  store_id    uuid references stores(id),  -- nullable
  user_id     uuid references profiles(id),
  action      text not null,
  detail      text,
  item_ref    text,
  value       text,
  created_at  timestamptz default now()
)
```

No `brand_id` column. No `payload jsonb` column. No `actor_id` (the equivalent is `user_id`).

**Decision — match existing columns, do NOT add new columns to `audit_log` in this spec.** Reasoning:
- Adding `brand_id` + `payload jsonb` to `audit_log` is a real cross-cutting schema change (8 audit_log readers in `db.ts` / store, all four staff/copy RPCs writing audit_log rows would need to be updated to set the new columns, RLS policies on `audit_log` would need rewriting). That belongs in a dedicated spec — not silently absorbed into Spec 049.
- Existing brand-level audit precedent: this is the first brand-level audit event the codebase wants to write. Other migrations (`staff_log_waste`, `staff_submit_eod_v2`) all set `store_id` non-null and serialize human-readable strings into `detail` / `value`.

**Concrete mapping for the catalog_copy audit row**:

| audit_log column | value                                                                                       |
|------------------|---------------------------------------------------------------------------------------------|
| `store_id`       | `NULL` (cross-cutting brand-level event)                                                    |
| `user_id`        | `auth.uid()`                                                                                |
| `action`         | `'catalog_copy'`                                                                            |
| `item_ref`       | `p_table` (e.g. `'catalog_ingredients'` or `'vendors'`)                                     |
| `detail`         | `p_target_brand_id::text` (cheap join key; the target-brand-only audit posture per AC §6)   |
| `value`          | `jsonb_build_object('source_brand_id', p_source_brand_id, 'target_brand_id', p_target_brand_id, 'table', p_table, 'names', v_source_names, 'skipped_count', v_skipped, 'copied_count', v_copied)::text` |

Yes, `value` is `text`, not `jsonb`. We serialize a JSON object as text — readable to the operator, parseable by anyone who needs it. The target brand id is also in `value` for completeness; `detail` is the cheap WHERE-key for the future audit-listing UI.

**One audit row per RPC call** per AC §6. If `v_copied = 0 AND v_skipped = 0` (nothing to do — e.g., empty `p_source_ids`), skip the audit insert to avoid noise.

**Source-brand audit row**: NONE per AC §6 / Q6. Architect honors this even though it's asymmetric vs. some audit shops' double-entry. Easy to add in a later spec if real demand emerges; harder to retroactively dedupe rows if added now.

### D — RLS impact

**No new tables → no new policies on a brand-scoped table.** The RPC writes to existing tables that already have their own policies:

- `catalog_ingredients` — INSERT policy `privileged_insert_catalog_ingredients` ([20260509000000_multi_brand_schema_rls.sql:450](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)) requires `auth_is_privileged() AND auth_can_see_brand(brand_id)`. Super-admin passes both via the `auth_is_privileged` OR-arm and `auth_can_see_brand` short-circuit. Even under `SECURITY DEFINER`, this policy is bypassed (definer-as-postgres skips RLS), which is the desired posture: we want exactly one gate (the explicit `auth_is_super_admin()` check at function entry) and no surprise from policy interactions on the write path.
- `vendors` — same shape (`privileged_insert_vendors`). Same conclusion.
- `audit_log` — existing INSERT policy `store_member_insert_audit_log` ([20260504173035_per_store_rls_hardening.sql:167-172](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)) requires `(store_id IS NOT NULL AND auth_can_see_store(store_id)) OR (store_id IS NULL AND auth_is_admin())`. The second arm uses `auth_is_admin()` which reads JWT `app_metadata.role` and returns FALSE for super-admin (super-admin's JWT role isn't 'admin' or 'master'). Under regular policy-evaluated INSERT, a super-admin attempting to insert a `store_id IS NULL` row would be denied. SECURITY DEFINER bypasses this — which is why the audit insert must live inside the SECURITY DEFINER RPC and not a client-side mirror. **Flag for security-auditor**: the audit_log RLS gap for super-admin + NULL store_id is pre-existing; Spec 049 does NOT widen it, but the design hinges on SECURITY DEFINER being the only path. A separate spec should eventually rewrite the `audit_log` policy to accept super-admin explicitly via `auth_is_privileged()` — out of scope here.

**No RLS policy modifications.** Architect explicitly chose not to touch the `audit_log` policy in this migration to keep the blast radius small. If the audit-log shape itself changes later, the policy gets rewritten with it.

### E — API contract

**RPC, not table/view.** Multi-row INSERT with conflict bookkeeping + audit + transactional rollback is precisely the case for an RPC — PostgREST can't express it. Mirrors `copy_brand_catalog` ([src/lib/db.ts:2544](../src/lib/db.ts)).

**Request shape (PostgREST JSON body)**:
```
POST /rest/v1/rpc/copy_catalog_rows
{
  "p_source_brand_id": "<uuid>",
  "p_target_brand_id": "<uuid>",
  "p_table":           "catalog_ingredients" | "vendors",
  "p_source_ids":      ["<uuid>", "<uuid>", ...]
}
```

**Response shape** (PostgREST unwraps the composite type):
```
{
  "copied":        3,
  "skipped":       2,
  "skipped_names": ["Tomato", "Basil"]
}
```

**Error cases**:
| Cause                                                  | SQL                                                       | HTTP via PostgREST    |
|--------------------------------------------------------|-----------------------------------------------------------|-----------------------|
| Non-super-admin caller                                 | `raise exception 'super_admin only'`                      | 500 with body message |
| Caller can't see source brand                          | `raise exception 'source brand not accessible'`           | 500                   |
| Caller can't see target brand                          | `raise exception 'target brand not accessible'`           | 500                   |
| `p_source_brand_id = p_target_brand_id`                | `raise exception 'source and target brands must differ'`  | 500                   |
| `p_table not in ('catalog_ingredients', 'vendors')`    | `raise exception 'invalid table: %', p_table`             | 500                   |
| Some `p_source_ids` not in source brand                | Silently skipped (the WHERE clause filters them)          | 200 / fewer copies    |
| Empty `p_source_ids`                                   | Returns `(0, 0, '{}')`; no audit row                      | 200                   |

The existing `copyBrandCatalog` wrapper catches `error` from `supabase.rpc()` and throws — same pattern works here. Error strings are stable (used by pgTAP `throws_ok`); future renames go through a deprecation cycle.

### F — `src/lib/db.ts` surface

**Single wrapper**, mirroring (1). Lives next to `copyBrandCatalog` (~line 2544) in [src/lib/db.ts](../src/lib/db.ts):

```ts
export type CatalogCopyTable = 'catalog_ingredients' | 'vendors';

export interface CopyCatalogRowsResult {
  copied: number;
  skipped: number;
  skippedNames: string[];   // snake → camel mapping per house convention
}

export async function copyCatalogRows(
  sourceBrandId: string,
  targetBrandId: string,
  table: CatalogCopyTable,
  sourceIds: string[],
): Promise<CopyCatalogRowsResult> {
  const { data, error } = await supabase.rpc('copy_catalog_rows', {
    p_source_brand_id: sourceBrandId,
    p_target_brand_id: targetBrandId,
    p_table:           table,
    p_source_ids:      sourceIds,
  });
  if (error) throw error;
  // PostgREST returns the composite as a single object; default to zeros if RPC body is null.
  return {
    copied:       (data as any)?.copied        ?? 0,
    skipped:      (data as any)?.skipped       ?? 0,
    skippedNames: (data as any)?.skipped_names ?? [],
  };
}
```

snake_case → camelCase mapping is done inline (`skipped_names` → `skippedNames`) — matches the `mapItem`-style helpers throughout the file. No re-export needed; callers (`InventoryCatalogMode.tsx`, `VendorsSection.tsx`, store action) import from `'../../../lib/db'`.

**Why one wrapper, not two**: PM Q4 trade-off resolved in favor of the dispatching shape. A future v2 that adds `recipes` only needs to widen `CatalogCopyTable` and the server whitelist — the wrapper signature is stable. Two thin wrappers (`copyCatalogIngredients` / `copyVendors`) would have to be added in lockstep for every new table, which is the bigger ongoing tax.

### G — Edge function changes

**None.** Direct PostgREST RPC. No `supabase/functions/` changes. No `supabase/config.toml` `verify_jwt` decisions to make. (Per AC §"Tests / infra" and §"Project-specific notes" — explicit.)

### H — Realtime impact

**No publication changes.** Both `catalog_ingredients` and `vendors` are already in `supabase_realtime` per [supabase/migrations/20260514140000_realtime_publication_tighten.sql:43-53](../supabase/migrations/20260514140000_realtime_publication_tighten.sql). The RPC INSERTs into target-brand rows fire the existing `brand-{target-id}` channel ([src/hooks/useRealtimeSync.ts:50-61](../src/hooks/useRealtimeSync.ts)) which subscribers in the target brand already listen to with `filter: brand_id=eq.${brandId}`.

**Realtime publication gotcha — NOT triggered by this spec.** Per CLAUDE.md "Realtime publication gotcha" and MEMORY.md `project_realtime_publication_gotcha.md`: a mid-session change to the `supabase_realtime` publication needs `docker restart supabase_realtime_imr-inventory` locally to re-snapshot the slot. Spec 049 does NOT modify the publication, so this gotcha does NOT apply. The architect explicitly verified that the publication already includes both target tables before designing the realtime story. Flag in the migration header anyway: "REALTIME: this migration does NOT touch the supabase_realtime publication."

**Source-brand subscribers**: nothing fires there. Source rows are unchanged. This is the intended posture per AC ("after the copy, the two rows are independent").

**Debounce interaction**: `useRealtimeSync.ts` debounces `onSync` at 400ms ([src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts)). A bulk copy that inserts e.g. 50 rows into a target brand fires 50 events; the debounced reload coalesces them into one `loadFromSupabase` call. No special handling needed.

### I — Frontend store impact (`src/store/useStore.ts`)

**No new slice.** The wrapper is called directly from the section components after the user confirms the picker dialog. Pattern matches the existing `copyBrandCatalog` use in [src/components/cmd/BrandFormDrawer.tsx:46](../src/components/cmd/BrandFormDrawer.tsx) — the section component calls the RPC, renders the toast, and lets the realtime reload pull the new rows in. No local-state mutation needed because:

- The current user is a super-admin in the SOURCE brand; the target brand may not even be in their current visible scope. Adding optimistic rows to the local `catalogIngredients` / `vendors` slice would be wrong if the target brand isn't selected.
- The skip count is server-derived. The client cannot accurately optimistically split rows into "copied" vs "skipped" without re-running the same conflict check.

**Optimistic-then-revert pattern**: explicitly NOT applied here. Justified above. `notifyBackendError` is still imported by the section components (already is — see VendorsSection / InventoryCatalogMode usage) and used to render the failure toast. On success, the section component renders the `"N copied, M skipped"` toast directly using `Toast.show({ type: 'success', ... })` — same shape as `BrandFormDrawer.tsx:48-51`.

**One small slice addition** — `brandsList` (already in the store, [src/store/useStore.ts:528](../src/store/useStore.ts)) is the source of brands for the picker. No new selector needed; the picker dialog component can `useStore((s) => s.brandsList.filter(b => !b.deletedAt && b.id !== currentSourceBrandId))`.

### J — Frontend — Cmd UI affordances

Sections to modify:
- [src/screens/cmd/sections/InventoryCatalogMode.tsx](../src/screens/cmd/sections/InventoryCatalogMode.tsx) — per-row overflow menu + multi-select column + top-bar bulk action.
- [src/screens/cmd/sections/VendorsSection.tsx](../src/screens/cmd/sections/VendorsSection.tsx) — same affordances.

**Role gate.** Both sections gate render through `useIsSuperAdmin()` from [src/hooks/useRole.ts](../src/hooks/useRole.ts). Pattern matches existing `BrandPicker` ([src/components/cmd/BrandPicker.tsx:39](../src/components/cmd/BrandPicker.tsx)) — `if (!isSuperAdmin) return null;` for the affordance subtree. NOT a hardcoded literal — AC §"UI-layer gate" is satisfied via the existing hook.

**Picker dialog.** New reusable component `src/components/cmd/CopyToBrandDialog.tsx` (frontend-developer's call on filename, but new component is acceptable). Reusing `BrandPicker.tsx` directly is poor fit — `BrandPicker` is a header switcher that mutates `currentBrandId`, not a destination chooser that emits one selection. The new dialog:
- Takes props: `{ visible, sourceBrandId, table: CatalogCopyTable, sourceIds: string[], onClose, onSuccess(result) }`.
- Renders the list of brands from `useStore.brandsList` filtered to `!deletedAt && b.id !== sourceBrandId`.
- Shows the fixed copy "Existing items in the target brand will be skipped." per AC.
- Confirm button calls `copyCatalogRows(sourceBrandId, target, table, sourceIds)`, then renders the `"N copied, M skipped"` toast via `onSuccess`. Failure toast via `notifyBackendError` is fine but the existing call sites use inline `Toast.show({ type: 'error', ... })` (see `BrandFormDrawer.tsx:53-57`); follow that.

**Multi-select column.** A new lightweight selection state (`React.useState<Set<string>>`) per section, scoped to the current section only — does NOT belong in the global store. When the set is non-empty AND `isSuperAdmin`, a top-bar pill renders "Copy N items to brand…" → opens the dialog with all selected ids. Checkbox column is the leftmost column; only renders for super-admin (gate the column header AND each row's checkbox).

**Per-row overflow menu.** Each section already has a per-row overflow menu (or row action area — frontend-developer to confirm shape). Adds one item "Copy to brand…" → opens the dialog with the single row's id.

### K — Risks and tradeoffs

1. **Audit_log RLS asymmetry for super-admin + NULL store_id.** Pre-existing; Spec 049 uses SECURITY DEFINER to bypass. If a future spec ever decides to drop the SECURITY DEFINER posture, the audit insert breaks. Mitigation: pgTAP arm asserts the audit row is written when super-admin runs the RPC, which would catch a regression.

2. **`vendors_brand_name_lower_unique` index — prod data may collide.** No `(brand_id, lower(name))` constraint exists on vendors today. If prod has accidental case-variant duplicates ("Sysco" + "SYSCO"), the migration's index creation fails. The pre-flight DO block surfaces this with a clear message; the operator dedupes manually before re-applying. Acceptable risk because the migration is dev-applied first.

3. **Concurrent-copy audit race (PM open question).** Two super-admins fire `copy_catalog_rows` simultaneously into the same target brand. Each transaction sees the pre-conflict row state at its own snapshot; one transaction inserts a row, the other's `ON CONFLICT DO NOTHING` skips it. Each transaction writes its OWN audit_log row reflecting its OWN `copied`/`skipped` split — so the sum of `copied_count` across the two audit rows correctly reflects what landed in the target. No deadlock risk because both transactions write to the same target brand rows in a deterministic order (PostgreSQL handles unique-index conflict resolution without acquiring table locks). The only "weird" observable: a later auditor reading the two audit rows individually might see overlapping `names` arrays, but the `value` JSON is per-transaction-truthful. Acceptable.

4. **Migration ordering — index BEFORE function.** The `vendors_brand_name_lower_unique` index must be created BEFORE the RPC body references `ON CONFLICT (brand_id, lower(name))` on `vendors`. The function body is parsed at CREATE FUNCTION time but conflict-target resolution happens at first call (plpgsql is interpreted). Safe ordering: index pre-flight → index create → function create → grants. Within a single migration file the ordering is explicit.

5. **Performance on the 286 KB seed dataset.** Catalog has ~143 rows × however-many brands; vendors has ~9 rows × however-many brands. Even a full-brand bulk copy is < 200 rows. The unique index is on `(brand_id, lower(name))` which is a small expression index; rebuild cost is trivial. No perf risk.

6. **Edge function cold-start.** N/A — no edge function path.

7. **PostgREST authentication boundary.** The RPC is granted to `authenticated` only, with `revoke ... from public, anon`. The `auth_is_super_admin()` gate is the second-line defense in case the GRANT is loosened later. Both layers must reject admin/master to satisfy AC's negative test "RPC-layer gate: an admin (or master) user who calls the RPC directly receives a 42501 / permission denied error."

8. **`SQLSTATE` for the role-gate exception.** Existing `copy_brand_catalog` uses plain `raise exception 'privileged only'` which lands as SQLSTATE `P0001` (`raise_exception`), NOT `42501` (`insufficient_privilege`). The Spec 049 AC §"Backend — RPC contract" mentions Postgres `42501`. Architect's call: emit `'super_admin only'` as a normal `raise exception` (defaults to `P0001`) and let pgTAP assert on the MESSAGE text rather than SQLSTATE. The AC text mentions `42501` but the existing precedent in `copy_brand_catalog` is `P0001`-via-message. Going for consistency with the existing helper. **Surface as an open question for the user**: if `42501` is a hard requirement, the function body must use `raise exception 'super_admin only' using errcode = '42501';`. The pgTAP `throws_ok` would then need to assert on errcode, not message. Reading the AC literally, the body matters more than the SQLSTATE letter — the existing test pattern asserts on the message string ([copy_brand_catalog.test.sql:49](../supabase/tests/copy_brand_catalog.test.sql)).

9. **Audit row visibility.** `store_id IS NULL` audit rows are visible only to `auth_is_admin()` (per the existing audit_log SELECT policy in spec 023). Super-admin's JWT does NOT carry `app_metadata.role='admin'`, so super-admin CANNOT see its own audit rows through the API today. This is a pre-existing audit-visibility gap, NOT introduced by Spec 049. Flagged for security-auditor and the next audit-log rewrite spec. Workaround: the audit rows are still queryable via `psql` / direct DB access; a future "audit listing UI" spec will need to fix this policy.

### L — Open question to the user (from §K item 8)

The AC mentions Postgres `42501` for role-rejection. The existing `copy_brand_catalog` precedent is plain `raise exception 'privileged only'` (SQLSTATE P0001) and the pgTAP test asserts on the message string. Architect prefers staying with the existing pattern (message-based assertion) unless `42501` is a hard external requirement (e.g., a planned generic 4xx-mapping layer that watches errcodes). Defaulting to the existing pattern for the build; if `42501` is required, swap to `raise exception 'super_admin only' using errcode = '42501';` and adjust the pgTAP arm to `throws_ok(..., '42501', ...)`.

### M — pgTAP coverage (mandatory)

New file `supabase/tests/cross_brand_copy.test.sql` (matches AC §"Tests / infra"). Plan size: 9 arms. Pattern mirrors [supabase/tests/copy_brand_catalog.test.sql](../supabase/tests/copy_brand_catalog.test.sql). Test arms:

1. super_admin can copy N source rows of `catalog_ingredients`; result `copied=N, skipped=0`.
2. super_admin can copy N source rows of `vendors`; result `copied=N, skipped=0`.
3. admin (with app_metadata.role='admin') rejected with `'super_admin only'`.
4. master (with app_metadata.role='master') rejected with `'super_admin only'`.
5. Skip-on-conflict: pre-seed target with one row of same `lower(name)`; copy includes it; result has that name in `skipped_names`, `skipped=1`, row not duplicated in target.
6. Invalid `p_table='recipes'` → `'invalid table: recipes'`, zero rows in target, zero audit rows.
7. `p_source_brand_id = p_target_brand_id` → `'source and target brands must differ'`.
8. After a successful super_admin call: exactly 1 audit_log row in target with `action='catalog_copy'`, `value::jsonb -> 'source_brand_id' = source_uuid`, `item_ref = 'catalog_ingredients'`.
9. After the same successful call: zero audit_log rows pointing to the source brand (cross-check the absence — `where value::jsonb ->> 'target_brand_id' = source_brand_id`).

All wrapped in `begin; ... rollback;` per the test harness contract ([scripts/test-db.sh](../scripts/test-db.sh)). Promotes the seed admin to super_admin within the transaction, same shape as the existing `copy_brand_catalog.test.sql`.

### N — Files changed (expected)

Backend:
- `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` (new)
- `supabase/tests/cross_brand_copy.test.sql` (new)
- `src/lib/db.ts` — add `CatalogCopyTable`, `CopyCatalogRowsResult`, `copyCatalogRows()` near line 2544 (next to `copyBrandCatalog`)

Frontend:
- `src/components/cmd/CopyToBrandDialog.tsx` (new) — reusable picker dialog
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — checkbox column, per-row overflow item, top-bar bulk action, dialog mount
- `src/screens/cmd/sections/VendorsSection.tsx` — same set
- Possibly `src/i18n/{en,es,zh-CN}.json` for the new toast / dialog copy (frontend-developer's call)

No changes:
- `supabase/config.toml` (no edge function changes)
- `app.json` (slug unchanged per CLAUDE.md)
- `src/store/useStore.ts` (no slice changes — pattern matches `BrandFormDrawer.tsx` direct-RPC call)
- `src/hooks/useRealtimeSync.ts` (no channel changes)
- `supabase_realtime` publication (both tables already in)

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend-developer: write the migration `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` (pre-flight + vendors unique index + composite return type + `copy_catalog_rows` RPC), the pgTAP file `supabase/tests/cross_brand_copy.test.sql` with the 9 arms in §M, and the `copyCatalogRows` wrapper in `src/lib/db.ts` near line 2544. Use plain `raise exception 'super_admin only'` (P0001) to match the existing `copy_brand_catalog` shape unless the user explicitly requests SQLSTATE `42501`. Frontend-developer: add the new `CopyToBrandDialog` component, multi-select state + checkbox column, per-row overflow item, and top-bar bulk pill on both `InventoryCatalogMode.tsx` and `VendorsSection.tsx`. Gate all affordances through `useIsSuperAdmin()`. On success render `"N copied, M skipped"` toast (Toast.show success); on failure surface via the existing error-toast pattern from `BrandFormDrawer.tsx:53-57`. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/049-cross-brand-catalog-copy.md

## Files changed

### Migrations
- `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` (new) — pre-flight vendors-collision DO block, `vendors_brand_name_lower_unique` index, `public.copy_catalog_result` composite type, `public.copy_catalog_rows(uuid, uuid, text, uuid[])` SECURITY DEFINER RPC, grants/revokes (anon-revoke shape).

### pgTAP tests
- `supabase/tests/cross_brand_copy.test.sql` (new) — 13 arms covering admin reject, master reject, anon GRANT lockdown, super_admin copy ingredients (positive), super_admin copy vendors (positive), skip-on-conflict (copied=1 + skipped=2 re-run), source==target reject, invalid `p_table` reject, and target-only audit shape (count >= 3, `item_ref`, `value::jsonb -> 'source_brand_id'`, zero rows pointing at source brand).
- `supabase/tests/reports_anon_revoke.test.sql` (modified) — extended plan from 11 to 12; added arm (12) asserting `anon` lacks EXECUTE on `copy_catalog_rows(uuid, uuid, text, uuid[])`.

### TS wrapper (src/lib/db.ts)
- `src/lib/db.ts` — added `CatalogCopyTable` type, `CopyCatalogResult` interface, and `copyCatalogRows(sourceBrandId, targetBrandId, table, sourceIds)` helper next to the existing `copyBrandCatalog` (~line 2553+). Maps RPC composite `skipped_names` → camelCase `skippedNames` per house convention.

### Frontend — Cmd UI affordances
- `src/components/cmd/CopyToBrandDialog.tsx` (new) — reusable cross-brand copy dialog (ResponsiveSheet center-modal). Renders the item-preview block, target brand picker (chips minus source + soft-deleted), fixed skip-on-conflict notice, confirm/cancel footer, Esc-to-close + Cmd+Enter keyboard idiom. Calls `copyCatalogRows` and fires success / error toasts via the BrandFormDrawer pattern.
- `src/components/cmd/CopyToBrandDialog.test.tsx` (new) — 6 jest arms: render (title + chips + skip notice), visible=false short-circuit, no-eligible-brands empty state, success path (RPC args + success toast), error path (RPC reject + error toast + dialog stays open), confirm-disabled-until-target-picked.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — added `useIsSuperAdmin` import + `brand` slice read. New state: `selectedKeys: Set<string>`, `copyDialogOpen`, `singleRowGroup`. Per-row leftmost checkbox column + per-row "COPY" pill (super-admin only). Top-bar bulk pill rendered when selection is non-empty. Mounts `CopyToBrandDialog` with `table="catalog_ingredients"`; on success clears selection state. Per-row affordance gates on `g.primary.catalogId` (legacy seeds without a catalog FK get skipped).
- `src/screens/cmd/sections/VendorsSection.tsx` — mirrored shape: `useIsSuperAdmin` + `brand` slice, `selectedVendorIds: Set<string>`, per-row checkbox + COPY pill, top-bar bulk pill, `CopyToBrandDialog` mount with `table="vendors"`. Selection is keyed on `vendor.id` (the brand-level row id the RPC expects).
- `src/i18n/en.json` — new `dialog.copyToBrand.*` namespace (24 keys): title, headerLabel, subtitle{Ingredients,Vendors}, itemsHeader, moreCount, pickBrandHeader, skipNoticeHeader, skipNotice, cancel, confirm, copying, successToast, errorToast, noBrandsAvailable, bulkPill{Ingredients,Vendors}, rowActionLabel, selectAllAria, selectRowAria, table{Ingredients,Vendors}, readyToCopy, pickFirst.
- `src/i18n/es.json` — Spanish parity for the new namespace.
- `src/i18n/zh-CN.json` — Chinese parity for the new namespace.

### Verification
- `npx supabase db reset` — clean apply through the new migration; seed re-applied.
- `bash scripts/test-db.sh supabase/tests/cross_brand_copy.test.sql` — 13/13 assertions pass.
- `npm run test:db` — 29/29 pgTAP files pass (no regressions in other tests).
- `npm run typecheck` / `npx tsc --noEmit` — clean (frontend slice included).
- `npm test -- --ci` — 174/174 jest tests pass (was 168 before frontend; +6 from `CopyToBrandDialog.test.tsx`). I18n catalog-parity arm in `src/i18n/i18n.test.ts` covers the new `dialog.copyToBrand.*` keys across en/es/zh-CN.

### Browser verification — NOT performed in this slice
- The preview tools (`preview_start`, `preview_eval`, etc.) are not available in the agent environment that executed the frontend slice. The dev server is running locally on port 8081 and the affordances are pure render-tree + `useIsSuperAdmin` gating, but no live click-through was exercised. **Reviewers should manually:**
  1. Login as a super-admin (the local seed only includes admin/manager/master — escalate one to super_admin via `update profiles set role='super_admin' where id=...` or seed a new super_admin in `supabase/seed.sql`).
  2. Navigate to Inventory > Ingredients; select 2-3 rows via the leftmost checkbox; click the top-bar "Copy N to brand…" pill; pick a different brand; confirm; verify the toast shows "N copied, M skipped".
  3. Click a per-row "COPY" pill; verify the same dialog opens preselected with that single row.
  4. Repeat on Inventory > Vendors.
  5. Login as admin@local.test (role 'admin'); confirm the checkbox column, per-row COPY pill, and top-bar bulk pill are ALL hidden (negative-gate test). Same for master@local.test (role 'master').

### Open question for review
- The architect's design (§K item 8 / §L) flagged that `copy_brand_catalog` uses plain `raise exception` (SQLSTATE P0001) while the spec AC mentioned `42501`. Per the user's instructions for this build slice, the new RPC uses `raise exception '<msg>' using errcode = 'P0001'` (explicit P0001 — matches the existing precedent). Tests assert on message text, not SQLSTATE. If reviewers want SQLSTATE `42501` semantics, swap `errcode` and adjust the pgTAP arms accordingly.

### Post-review fixes (backend slice, items 1/3/4 of 5)

Per `specs/049-cross-brand-catalog-copy/reviews/release-proposal.md` (FIXES_NEEDED). Frontend-developer is addressing items 2 and 5 in parallel. Status intentionally left at READY_FOR_REVIEW so the second handoff to reviewers covers both slices once frontend lands.

- `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` — Item 3 (code-reviewer SF1). Removed dead `v_source_count INT := 0;` declaration and both unused `SELECT count(*) ... INTO v_source_count` scans from the `catalog_ingredients` and `vendors` branches. Two table scans per RPC call eliminated for zero behavior change.
- `supabase/tests/cross_brand_copy.test.sql` — Items 1 + 4 (code-reviewer SF2/SF3, test-engineer Critical #1).
  - Plan bumped from `plan(13)` to `plan(14)`.
  - Added a transaction-scoped `UPDATE profiles SET role='admin' WHERE id='22222222-...'` in the fixtures block (existing seed brand_id satisfies `profiles_role_brand_consistent`).
  - Split former arm (1) into (1a) profiles.role='master' + (1b) profiles.role='admin'; arm (2) now precisely labeled "caller profiles.role='master' with matching JWT". Labels in all three rejection arms now name the EXACT `profiles.role` being tested rather than relying on the misleading JWT claim.
  - Tightened the audit-row count assertion from `cmp_ok(..., '>=', 3, ...)` to `cmp_ok(..., '=', 4, ...)` (arms 4, 5, 6a, 6b each write exactly one row). Updated the §9a header comment to match. A vendors-audit-row regression or stray-insert would now fail this arm.

### Post-review verification
- `npx supabase db reset` — clean re-apply with the dead-var removal.
- `bash scripts/test-db.sh supabase/tests/cross_brand_copy.test.sql` — 14/14 (was 13/13).
- `npm run test:db` — 29/29 pgTAP files green (no regressions).
- `npm run typecheck` — clean.

### Post-review fixes (frontend slice, items 2/5 of 5)

Per `specs/049-cross-brand-catalog-copy/reviews/release-proposal.md` (FIXES_NEEDED). Backend slice items 1/3/4 are listed above; the frontend slice closes items 2 and 5. Both slices complete the FIXES_NEEDED list.

- `src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx` (new) — Item 2 (test-engineer Critical #2 / AC-N1 / AC-F3). Negative-gate jest coverage. Mocks `useIsSuperAdmin` directly + stubs heavy child components (IngredientFormDrawer, ExportCsvDrawer, CopyToBrandDialog, IngredientForm, TabStrip, StatCard, PropertiesJson, ComingSoonPanel). 4 arms:
  - `useIsSuperAdmin=false` → per-row checkbox + per-row COPY pill absent.
  - `useIsSuperAdmin=false` → top-bar bulk pill absent.
  - `useIsSuperAdmin=true` (positive control) → per-row checkbox + COPY pill render.
  - `useIsSuperAdmin=true` + checkbox press → top-bar bulk pill renders with `{count}=1`.
- `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` (new) — Item 2 mirror for Inventory > Vendors. Same 4-arm shape (2 negative-gate + 2 positive-control). Heavy children stubbed: VendorFormDrawer, CopyToBrandDialog, TabStrip, StatCard, StatusPill, PropertiesJson, POHistoryTab.
- `src/i18n/en.json` — Item 5 (code-reviewer SF4). Removed dead key `dialog.copyToBrand.selectAllAria` (never referenced in any component or screen).
- `src/i18n/es.json` — Item 5 mirror. Spanish key removed.
- `src/i18n/zh-CN.json` — Item 5 mirror. Chinese key removed.

Pattern chosen for the gate tests (architect's "smaller proxy" path): mocked `useIsSuperAdmin` via `jest.mock('@/hooks/useRole', ...)` so each test can flip the gate by calling `mockUseIsSuperAdmin.mockReturnValue(true|false)`. This avoids seeding `profiles.role` through the entire store machinery. Heavy children stubbed as `() => null` so we don't drag in the full Cmd UI render tree. The list pane (where all three affordances live) renders without the detail pane's child components because we mount with empty / single-row inventory and let the auto-select land on the first row.

### Post-review verification (frontend slice)
- `npm test -- --ci` — 182/182 jest tests pass (was 174 after backend slice; +8 from the two new section tests).
- `npm run typecheck` — clean.
- I18n catalog-parity test (`src/i18n/i18n.test.ts`) passes — all three catalogs are still in sync after `selectAllAria` removal (key absent in all three).
