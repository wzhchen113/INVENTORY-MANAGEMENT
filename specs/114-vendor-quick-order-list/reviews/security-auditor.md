# Security audit for spec 114

Scope: per-vendor order codes on `public.item_vendors` (additive `order_code text`
column) + universal quick-order list export. One additive DDL migration, no new
RPC, no new edge function, no new policy, no new grant, no publication change.
Verdict: **CLEAN — no findings at any severity.** All five requested checks pass,
independently re-verified on the live local stack.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
None.

---

## Verification detail (the five requested checks)

### 1. RLS inheritance — the added column rides the existing whole-row gate (PASS, live-verified)

`order_code` inherits the four `store_member_*_item_vendors` policies
(`supabase/migrations/20260630000000_item_vendors.sql:121-142`) unchanged. Those
policies gate the WHOLE ROW via
`exists(… inventory_items ii where ii.id = item_vendors.item_id and public.auth_can_see_store(ii.store_id))`.
Postgres RLS is row-level and column-agnostic, so a new column is covered by
SELECT/INSERT/UPDATE/DELETE the instant it exists. The migration adds no policy
and edits none.

**Independently re-verified on the live stack** (`supabase_db_imr-inventory`,
`psql -U postgres`, hermetic `begin … rollback`). The 2222 manager
(`22222222-…`, JWT `app_metadata.role='user'`) is a member of **Frederick + Towson**
only (confirmed via `user_stores`); **Charles** and **Reisters** are non-member
stores. Impersonating the manager (`set local role authenticated` +
`request.jwt.claims`), seeding a Charles item's link under postgres:

- Non-member SELECT of the Charles link → **0 rows visible** (SELECT scope holds).
- Non-member `UPDATE … set order_code = 'HACK-INJECT'` on the Charles link →
  **0 rows updated**; ground-truth re-read under postgres shows the Charles
  `order_code` **still NULL** (USING clause hides the row — refusal held).
- Member `UPDATE … set order_code = 'US-OK-777'` on a Frederick link →
  **1 row updated**; ground-truth read confirms the member write persisted.

This is the exact refusal the pgTAP assertion (12) pins
(`supabase/tests/item_vendors_rls.test.sql:248-266`, "non-member UPDATE cannot write
order_code on a Charles link (stays NULL — RLS regression pin)"). No column-level
grant hole, no policy that needed updating and didn't get it.

### 2. No grant leak — table + column grants unchanged, spec-097 posture intact (PASS)

The migration contains **zero** grant/revoke statements (verified: the only two
executable statements are `alter table … add column if not exists order_code text`
and a `comment on column`). The added column inherits the table-level grants
automatically.

Live column-privilege check on `item_vendors.order_code`: anon / authenticated /
service_role each hold exactly `INSERT, REFERENCES, SELECT, UPDATE` — identical
inheritance from the table grant, no narrower and no wider grant on the new column.
No anon/public write path to the column that isn't already bounded by RLS (an anon
caller has no JWT `sub`, satisfies no `auth_can_see_store()`, and is refused at the
policy layer — the grant alone admits nothing). RLS is still enabled
(`relrowsecurity = t`); the four `store_member_*` policies are present and unchanged.

Note (NOT a spec-114 finding): the local box shows table-level `TRUNCATE` on
anon/authenticated. `TRUNCATE` is a table-only privilege (it cannot exist at column
granularity and is still bounded by table ownership, not a write path to the new
column), and it is not introduced by this migration — a pre-existing local-stack
observation only. Prod grants are unchanged because this migration touches no grants.

### 3. No injection / data-exposure via `order_code` (PASS)

`order_code` is operator-entered free text, stored and rendered as-is. Confirmed it
reaches no injection or exposure sink:

- **SQL:** written via the supabase client `.upsert()` as a bound object field
  (`src/lib/db.ts:373` create, `:504` update: `order_code: l.orderCode || null`) —
  PostgREST parameterizes it. No string interpolation, no `EXECUTE`, no dynamic SQL.
  The read (`db.ts:239`) adds `order_code` as a fixed column name in the PostgREST
  select projection (a literal, not user input).
- **HTML / mail:** the quick-order builder (`src/utils/poQuickOrderText.ts`) is a
  pure string builder emitting a plain TAB-delimited `<code>\t<qty>` block that flows
  to `sharePurchaseOrder` (clipboard / native share / RN `Text` preview). A repo-wide
  grep confirms `order_code`/`orderCode` never reaches `dangerouslySetInnerHTML`,
  an `innerHTML`/`html:` sink, Resend, `console.log`/`warn`/`error`, or
  `notifyBackendError`. No mail body, no HTML template — the spec's own "no HTML sink,
  client-only plain text" claim holds.
- **The block carries no `$` / no money** (`poQuickOrderText.ts` imports no
  `formatMoney`, `PoQuickOrderLine` omits any cost field; jest pins `not.toContain('$')`).

The `|| null` coalesce on both write paths correctly persists empty/blank/absent as
SQL NULL rather than `''` or the string `"undefined"` — no data-shape leak.

### 4. Migration is additive-only DDL — no destructive change, no drift (PASS)

`supabase/migrations/20260708000000_item_vendor_order_code.sql` has exactly two
executable statements: `alter table public.item_vendors add column if not exists
order_code text;` (nullable, no default, no NOT NULL → metadata-only/instant on
PG 17, existing rows NULL, no backfill) and a `comment on column`. Grep for
`drop|truncate|delete|update|create/alter/drop policy|grant|revoke|alter
publication|not null|default` finds matches ONLY inside comment lines (the header
documents what the migration deliberately does NOT do). Verified locally: the column
landed as `text`, `is_nullable = YES`, no default. Sorts last on disk (after
`20260707000000_staff_receiving_price_gate.sql`).

No RLS drift, no publication drift, no grant drift. Reversible-by-design
(`drop column order_code`). Prod is NOT yet applied — the developer correctly flagged
the prod-apply as user-gated (execute_sql the ALTER + `schema_migrations` insert
`20260708000000` + verify column presence, NOT a body-md5 since this is DDL);
`db-migrations-applied.yml` (spec 064) will sit red until that `schema_migrations`
row lands, which is expected and resolves on apply. Surfacing per the CLAUDE.md CI
rule: this is additive/reversible DDL, so the drift-gate red is benign-pending-apply,
not a destructive-migration hazard.

### 5. Dependencies — package.json unchanged, npm audit skipped (PASS)

`git diff HEAD -- package.json package-lock.json` → 0 changes (also absent from the
working-tree modified set and the last 3 commits). No new/updated dependency. Per the
process, `npm audit` is skipped.

---

## Notes for the release-coordinator

- No security finding blocks this spec. RLS on the new column is proven both by the
  extended pgTAP (`item_vendors_rls.test.sql` assertions 9-12, `plan(14)`) and by an
  independent live probe on the running stack.
- The one operational item to carry (not a security defect): the prod migration is
  unapplied, so the spec-064 `db-migrations-applied.yml` gate will be red until the
  user-gated MCP apply lands. That is the documented additive-DDL flow, not drift.

### Dependencies
No package.json changes — skipped.
