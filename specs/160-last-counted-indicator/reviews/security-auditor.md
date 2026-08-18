# Security audit for spec 160

Scope: `git diff --cached` (25 files). Audited with independent verification
against the running local stack (`supabase_db_imr-inventory`, up 9 days) rather
than accepting the developer's reported results.

**Verdict: 0 Critical, 0 High, 0 Medium, 4 Low. Nothing blocks merge.**

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/migrations/20260817000000_items_last_counted.sql:95-96` — `EXECUTE`
  is granted to the whole `authenticated` role, not to an admin band, so any
  authenticated principal of any sibling app that shares this Supabase project
  can invoke `items_last_counted(<arbitrary uuid>)`. This is the correct and
  intended posture (it mirrors spec 128 exactly, and RLS — not the grant — is
  the boundary), and I verified empirically that it leaks nothing (see
  Verification below). Recording it only so the next reviewer does not
  re-derive it: **the grant is not the control; `auth_can_see_store()` on the
  driver table is.** No action.
- `supabase/migrations/20260817000000_items_last_counted.sql:67` — `service_role`
  retains `EXECUTE` (Supabase default privileges; the migration revokes only
  `public, anon`, same as spec 128). `service_role` has `BYPASSRLS`, so a future
  edge function calling this RPC with the service key would get **cross-store**
  results with no `auth_can_see_store()` clipping. No such caller exists today
  (grep: the only callers are `src/lib/db.ts:1471` under the user's JWT and
  `src/screens/staff/lib/itemsUpdated.ts:30`). Flagging as a forward-looking
  constraint for whoever writes the first edge-function consumer.
- `supabase/tests/items_last_counted.test.sql:277-293` — coverage shape, not a
  defect. The per-store-isolation arms (13)/(14) run **after `reset role`**,
  i.e. as `postgres` (table owner, RLS bypassed), so they pin the SQL semantics
  of per-store scoping but not the RLS denial. Only arm (15) exercises RLS, and
  it covers the "no visibility at all" case. The case an attacker would actually
  attempt — *authenticated, granted store A, asks for store B* — has no pgTAP
  arm. I verified it manually (Verification #2) and it behaves correctly; a
  future arm inside the `set local role authenticated` block would make that a
  standing gate rather than a one-off manual check.
- `src/store/useStore.ts:4508` — `notifyBackendError('Load last counted', e)`
  `console.warn`s the raw PostgREST error on an admin-only surface. Consistent
  with the project-wide posture and carries no PII, no row data and no SQL
  fragments (worst realistic content is `permission denied for function
  items_last_counted`, the known spec-152 anon-caller fingerprint). No action.

---

### Verification performed (not taken on trust)

**1. Attack-surface inventory by file list, not by claim.**
`git diff --cached --name-only` contains **no** `supabase/functions/*`, **no**
`supabase/config.toml`, **no** policy migration. Grepping the entire staged
diff for `alter publication`, `create policy`, `drop policy`, `enable row level
security`, `security definer`, `drop function` returns **zero** SQL hits (only
prose in the spec file). The architect's "no publication change, no realtime
container restart" ruling holds — nothing in this change touches
`supabase_realtime`. No `verify_jwt` decision exists to audit; no service-token
surface was added. `package.json` is untouched.

**2. Is `security invoker` genuinely sufficient? Can a caller probe a store they
cannot see?** No. Verified directly in Postgres, in a rolled-back transaction,
impersonating the seed `user`-role principal `2222…` (granted Towson +
Frederick via `user_stores`, **not** Charles or Reisters), with
`set local role authenticated` + matching `request.jwt.claims`:

| probe | result |
|---|---|
| `items_last_counted(Towson)` — granted | 143 rows, 31 non-null |
| `items_last_counted(Charles)` — ungranted | **0 rows** |
| `items_last_counted(Reisters)` — ungranted | **0 rows** |
| non-null values for an ungranted store | **0** |

Empty set, not rows-with-NULL, and **not** an error — so an invisible store and
a nonexistent store are indistinguishable to the caller (no existence oracle).
No timing channel either: the driver (`inventory_items where store_id =
p_store_id`) returns zero rows under RLS, so the union-max lateral is never
evaluated for an invisible store. All five underlying tables are RLS-enabled
with a single store-scoped permissive SELECT policy each, verified in
`pg_class` / `pg_policies`: `inventory_items`, `eod_submissions`,
`inventory_counts` gate on `auth_can_see_store(store_id)` directly;
`eod_entries` and `inventory_count_entries` gate transitively via `EXISTS` on
their parent. No `USING (true)`, no wide `auth.uid() IS NOT NULL` policy in the
set. AC-6 is structural, as designed.

Anon is denied at the grant layer, confirmed by execution (not just by ACL
inspection): `set local role anon` → `ERROR: permission denied for function
items_last_counted` (SQLSTATE 42501).

**3. `staff_items_updated` rewrite — is it genuinely behavior-preserving on a
live staff surface?**

- Signature + return table are **byte-identical** to spec 128
  (`20260722000000_ingredient_changed_badge.sql:102` vs
  `20260817000000_items_last_counted.sql:107`, character-for-character). No
  `drop function` in the migration, so there is no window in which the staff RPC
  is absent.
- Grants are byte-identical (`revoke … from public, anon` / `grant … to
  authenticated`, lines 128-129 vs 136-137). Deployed ACL confirms: `postgres`,
  `authenticated`, `service_role` — **no `anon`**. Nothing was widened.
- `prosecdef = f` (INVOKER), `provolatile = s` (STABLE), `proconfig =
  {search_path=public}` on **both** functions — identical to spec 128's prior
  definition, so item 3 of the prompt is answered: the search_path posture is
  unchanged, not merely similar. Shadowing via `search_path = public` is a
  non-issue here anyway: every table reference is schema-qualified, and
  `authenticated` holds only `USAGE` (no `CREATE`) on schema `public`
  (`nspacl`: `authenticated=U/pg_database_owner`).
- **Output equivalence, measured.** I recomputed spec 128's original inline
  definition side-by-side with the deployed new function and diffed the full
  result sets in both directions (`EXCEPT` each way), across **all four seed
  stores**, as an `admin` JWT and again as the scoped `user` JWT:
  `only_old = 0`, `only_new = 0`, `old_rows = new_rows = 143` for every store.
  The `LEFT JOIN` also cannot fan out — `items_last_counted` returns one row per
  `inventory_items` PK — and the row counts confirm it (143 → 143).
- **Can the LEFT JOIN expose an item the old INNER JOIN excluded?** No. The
  `catalog_ingredients` INNER join is unchanged and sits on the same driver
  `ii`; `items_last_counted` is joined on the right, so it can only add a
  column, never a row. Confirmed by the developer's own negative control:
  `items_last_counted` returns the RLS-invisible-catalog item (arm 11) while
  `staff_items_updated` still **drops** it (arm 12). That is the intended
  boundary and it is intact.
- **The regression gate is untouched and green.**
  `supabase/tests/ingredient_changed_badge.test.sql` does **not** appear in the
  staged file list (design §0.3 says editing it would itself be the defect), and
  I ran it against the migrated local DB: **20/20 assertions pass, unedited**.
  `supabase/tests/items_last_counted.test.sql`: **16/16 pass**.

**4. Filter tokens — no cross-store leak, no authorization change.**
`counted:` is resolved from `lastCountedByItem`, which is guarded on
`lastCountedStoreId === currentStore.id`
(`src/screens/cmd/InventoryDesktopLayout.tsx:179`) and
`=== item.storeId` on phone (`PhoneInventoryDetail.tsx:87`,
`PhoneInventoryList.tsx:121`). When the guard fails the tone is `undefined` and
`src/utils/filterParser.ts:87` returns `false` for every `counted:` token — it
fails **closed** (zero rows), not open. The slice is cleared to *not loaded* on
store switch (`useStore.ts:2040`), on the `__all__` branch (`:1966`) and on sign-out
(`SIGNED_OUT_DATA_RESET`, `:1125`), so no previous store's or previous user's
dates can be rendered or filtered against. The map is client-side display
filtering over an already-RLS-clipped list; it is not an authorization boundary
and does not become one.
The `RecipesSection` blast radius is as the architect ruled: its matcher
(`RecipesSection.tsx:106-108`) acts on `category` **only** and silently ignores
every other parsed key, so `counted:` merely stops being a name token there.
`storeRecipes` is server-scoped; nothing about recipe visibility changes.

**5. Secrets / PII / injection.** No `process.env`, no `EXPO_PUBLIC_*`, no key
material, no new logging in the staged diff (grepped). The new i18n values carry
`{date}` / `{value}` placeholders that are interpolated with `String.replace`
into React Native `accessibilityLabel` / `Text` children — no HTML sink, no
Resend `html:` field, no `escapeHtml` obligation. The RPC takes one bound `uuid`
argument; there is no `EXECUTE`/dynamic SQL anywhere in the migration.

**6. Prod-apply risk (ship-time note, per the CI caveat).** The migration is
additive and idempotent: two `create or replace function` statements, no `drop`,
no DDL on tables, no data change, no index build (so no `SHARE` lock on
`eod_entries` and none of spec 151's off-peak caveat), no publication change.
Ordering inside the file is correct — `items_last_counted` is created *before*
`staff_items_updated` references it. Timestamp `20260817000000` is the newest on
disk. Two things to do at apply time, neither a code defect:
(a) `create or replace` on a **live** staff RPC silently overwrites whatever is
currently in prod — before applying, confirm prod's `staff_items_updated` body
still matches the committed spec-128 migration (the project's normalized-md5
check) so an undetected dashboard-SQL-editor drift isn't quietly discarded;
(b) apply before or with the frontend and insert the exact version string into
`supabase_migrations.schema_migrations`, or `db-migrations-applied.yml` hard-fails
on `main`. Rollback is clean: re-apply spec 128's body + `drop function
public.items_last_counted(uuid)`; no data is at risk.

### Dependencies

No `package.json` / `package-lock.json` changes in the staged diff — `npm audit`
skipped.
