# Spec 157: super_admin parity for `auth_is_admin()`-gated writes + honest DB Inspector auth banner

Status: READY_FOR_REVIEW

> **Owner-observed incident (2026-08-09).** The owner's `super_admin` account is
> **silently denied** on ingredient-category management and on admin audit-log
> writes/deletes — 0-row PostgREST responses that `db.ts` does not check, so the
> UI reports success and nothing persists. Then, when the owner opened **DB
> Inspector** to diagnose it, the screen told them:
>
> > *"You are NOT admin per the JWT."*
> > *"Brand-catalog P5 RLS gates writes by auth_is_admin(). If you expect to be
> > admin, ALL your CRUD is being silently denied…"*
>
> That banner is **factually wrong in scope** — the vast majority of the owner's
> CRUD works fine, because almost every write policy was moved to
> `auth_is_privileged()` years of specs ago. It is right that *something* is
> denied; it is wrong about *how much*, and it is alarming out of proportion.
>
> This spec closes both halves: the **seven surviving policies** that still gate
> on the narrow `auth_is_admin()`, and the **client banner** that mirrors the
> narrow check instead of the real privileged predicate.

---

## PM summary (plain language, for the owner)

There are two roles that count as "admin-ish" in this database:

- `admin` / `master` — checked by reading your **login token** (`auth_is_admin()`).
- `super_admin` — checked by reading your **profile row** (`auth_is_super_admin()`),
  deliberately, so nobody can promote themselves to super_admin from any UI.

Most rules in the database use a third helper, `auth_is_privileged()`, which means
"either of the above". That is why almost everything works for you.

Seven rules never got updated and still ask the narrow question. When you — a
`super_admin` — try to add, rename or delete an **ingredient category**, or edit
or delete an **audit-log** row, Postgres answers "no rows matched" rather than
"denied". PostgREST turns that into a `204 No Content`, the app treats it as
success, and your change disappears. Nothing is broken in the UI; the rule is
just asking the wrong question.

The fix is the same one this project has already applied five separate times
(recipe categories, the whole brand catalog, order schedules, the three admin
RPCs, user-store grants): change those seven rules to ask the wider question.
Nobody loses access — `admin` and `master` still pass exactly as before, and
`super_admin` newly passes.

The second half is the DB Inspector banner. It should say what is actually true —
"you are super_admin; token-only checks report false, which is normal" — and it
should name the handful of things that are genuinely gated instead of claiming
everything is.

---

## User stories

- **US-1 (the write lands).** As the owner signed in as `super_admin`, I want
  adding / renaming / deleting an ingredient category to actually persist, so the
  Categories section is usable by the highest-privilege account in the system.
- **US-2 (audit-log parity).** As a `super_admin`, I want the admin audit-log
  UPDATE/DELETE paths — including the audit rows deleted as part of deleting a
  store, and the 90-day retention purge — to work for me the same way they work
  for an `admin`.
- **US-3 (honest diagnostics).** As a `super_admin` opening DB Inspector, I want
  the auth banner to tell me the truth about my access — not a red warning
  claiming "ALL your CRUD is being silently denied" when it is not.
- **US-4 (no silent regression later).** As the owner, I want the narrow-vs-wide
  helper distinction written down where the next person adding a policy will see
  it, so an eighth leftover does not accumulate.

---

## Findings from the codebase (so the architect is not designing blind)

Verified against the tree at `6dda20c`, plus the owner's live prod `pg_policies`
inspection on 2026-08-09.

### The three helpers, and what each actually reads

| helper | source of truth | admits | defined in |
|---|---|---|---|
| `public.auth_is_admin()` | **JWT** `app_metadata.role` | `admin`, `master` — **not** `super_admin` | [20260504073942_brand_catalog_p5_rls.sql:23-27](../supabase/migrations/20260504073942_brand_catalog_p5_rls.sql) |
| `public.auth_is_super_admin()` | **`profiles.role`** (deliberately NOT the JWT — "super-admin must NOT be settable from any UI") | `super_admin` | [20260509000000_multi_brand_schema_rls.sql:187-195](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) |
| `public.auth_is_privileged()` | both, ORed | `admin`, `master`, `super_admin` | [20260509000000_multi_brand_schema_rls.sql:235-239](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) |

The 012a header comment already states the failure mode this spec is cleaning up
after: *"Super-admin promotion via `profiles.role` does NOT also set the JWT
`app_metadata.role` to 'admin', so `auth_is_admin()` (which reads the JWT) returns
false for super-admins. We OR the two helpers explicitly so super-admin still
passes write policies."*

### The complete live blast radius of `auth_is_admin()`

`public.auth_is_admin()` is referenced in **only 8 migration files, 56
occurrences** (`rg 'public\.auth_is_admin\(\)' supabase/migrations`). Filtering to
statements not superseded by a later migration:

| # | live reference | effect of a `super_admin` caller today | notes |
|---|---|---|---|
| 1 | `public.auth_can_see_store()` OR-arm ([20260517040000](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)) | **no impact** — the function already short-circuits on `auth_is_super_admin()` first | no-op either way |
| 2 | `public.auth_is_privileged()` OR-arm | **no impact** — ORed with `auth_is_super_admin()` | no-op either way |
| 3 | `audit_log` / `store_member_read_audit_log` (SELECT) — OR-arm `store_id is null and auth_is_admin()` | ✗ cannot read **store-less** audit rows (store-scoped rows are fine via `auth_can_see_store`) | [per_store_rls_hardening.sql:160-165](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) |
| 4 | `audit_log` / `store_member_insert_audit_log` (INSERT) — same OR-arm | ✗ cannot INSERT a **store-less** audit row | same file, 167-172 |
| 5 | `audit_log` / `admin_update_audit_log` (UPDATE) | ✗ **all** UPDATEs denied | same file, 174-177 |
| 6 | `audit_log` / `admin_delete_audit_log` (DELETE) | ✗ **all** DELETEs denied | same file, 179-181 |
| 7 | `ingredient_categories` / `"Admins can write ingredient categories"` (INSERT) | ✗ denied | [spec004_..._rls_p6.sql:37-39](../supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql) |
| 8 | `ingredient_categories` / `"Admins can update ingredient categories"` (UPDATE) | ✗ denied | same file, 41-44 |
| 9 | `ingredient_categories` / `"Admins can delete ingredient categories"` (DELETE) | ✗ denied | same file, 46-48 |

**Nothing else.** Specifically confirmed *not* affected:

- Every `admin_*` policy created by the P5 migration on `recipes`, `prep_recipes`,
  `vendors`, `catalog_ingredients`, `ingredient_conversions`, `recipe_ingredients`,
  `prep_recipe_ingredients`, `recipe_prep_items`, `brands` was **dropped and
  replaced** by the `privileged_*` family in
  [20260509000000_multi_brand_schema_rls.sql:407-990](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql).
- The three `if not public.auth_is_admin() then raise exception 'admin only'`
  RPC guards (`admin_db_inspector_probe`, `admin_dedupe_recipes`,
  `admin_dedupe_prep_recipes`) were **already broadened** to
  `auth_is_privileged()` by
  [20260517020000_admin_rpcs_use_privileged.sql](../supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql).
  No remaining `not public.auth_is_admin()` guard exists in any live function body.
- `recipe_categories` writes were fixed by the identical spec-013 change
  ([20260510030000](../supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql)).

⚠ **The architect must re-verify this table against prod before designing**, since
the repo is not authoritative for prod policy text. Two queries:

```sql
-- (a) every policy whose predicate still names the narrow helper
select schemaname, tablename, policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and (coalesce(qual,'') like '%auth_is_admin%'
     or coalesce(with_check,'') like '%auth_is_admin%')
 order by tablename, cmd;

-- (b) every FUNCTION body that names it, beyond the two known OR-arms
select p.oid::regprocedure as fn, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and pg_get_functiondef(p.oid) like '%auth_is_admin%'
 order by 1;
```

Query (b) is the one the grep cannot fully substitute for: a function body edited
via the dashboard SQL editor would not appear in `supabase/migrations/`.

### Why the denial is *silent* rather than an error

RLS refusal on a `DELETE`/`UPDATE` whose `USING` fails is not an error — the rows
simply do not match. PostgREST returns `204`. And the three category writers in
`db.ts` do not destructure `error` at all:

```ts
// src/lib/db.ts:4087-4095 — representative of add/update/delete
export async function deleteIngredientCategory(name: string): Promise<void> {
  return useInflight.getState().track(async (signal) => {
    await supabase.from('ingredient_categories').delete().eq('name', name).abortSignal(signal);
  }, { kind: 'write', label: 'deleteIngredientCategory' });
}
```

So even an INSERT refusal (which *would* be a `42501` error) is swallowed. See
OQ-4 — this spec's **default is not to change that**, and the reasoning is
recorded there rather than silently omitted.

### Client surfaces that ride the seven policies

| surface | call site | today, as `super_admin` |
|---|---|---|
| Categories section (ingredient categories CRUD) | [CategoriesSection.tsx](../src/screens/cmd/sections/CategoriesSection.tsx) → `db.addIngredientCategory` / `updateIngredientCategory` / `deleteIngredientCategory` ([db.ts:4059-4095](../src/lib/db.ts)) | optimistic row appears, nothing persists, no toast |
| Ingredient-category i18n name patch | [db.ts:3527-3540](../src/lib/db.ts) | same |
| Store delete cascade | [db.ts:181](../src/lib/db.ts) — `from('audit_log').delete().eq('store_id', id)` | audit rows for the store are **not** deleted |
| 90-day retention purge | [db.ts:5831](../src/lib/db.ts) — `cleanupOldRecords` | audit rows never purged (the `safe()` wrapper logs errors, but a 0-row delete is not an error) |
| Audit log viewer | [AuditLogSection.tsx](../src/screens/cmd/sections/AuditLogSection.tsx) | read is fine for store-scoped rows; store-less rows are invisible |

### The DB Inspector banner

- Screen: **[src/screens/DBInspectorScreen.tsx](../src/screens/DBInspectorScreen.tsx)**
  — a sibling stack route registered in
  [CmdNavigator.tsx:49](../src/navigation/CmdNavigator.tsx), reached from the
  sidebar item `DBInspector` wired in
  [ResponsiveCmdShell.tsx:159-164](../src/screens/cmd/ResponsiveCmdShell.tsx) via
  the selector at [cmdSelectors.ts:1137](../src/lib/cmdSelectors.ts). It uses the
  **legacy** `useColors()` palette, not `useCmdColors()`.
- Banner logic, [lines 186-201](../src/screens/DBInspectorScreen.tsx): keys off
  `probe.auth.is_admin` only. Green "You are admin — writes are authorized." or
  red "You are NOT admin per the JWT." + the ALL-your-CRUD paragraph at
  [line 198](../src/screens/DBInspectorScreen.tsx).
- The payload it reads comes from `public.admin_db_inspector_probe()`
  ([20260517020000:26-31](../supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql)),
  which today emits `auth: { is_admin, app_metadata, user_id }` — **there is no
  `is_privileged` / `is_super_admin` field to key an honest banner off**.
- ★ Note the irony that makes the current copy self-refuting: the RPC's own guard
  is `if not public.auth_is_privileged() then raise exception 'admin only'`. If
  the banner rendered at all, the caller **is** privileged.
- The screen is **not internationalized** — zero `useT` / `t(` / i18n imports.
  Copy changes here are plain string edits, no catalog work. (See out-of-scope.)
- There is **no** jest suite for this screen today (`DBInspector*.test.tsx` does
  not exist).

### Precedent: every prior parity fix chose the same shape

| spec | target | fix |
|---|---|---|
| 012a | all brand-catalog tables | `admin_*` policies dropped, `privileged_*` created |
| 013 | `recipe_categories` write | `auth_is_admin()` → `auth_is_privileged()` |
| 027 | edge functions | `ADMIN_ROLES = {admin, master, super_admin}` — CLAUDE.md records this set as *mirroring `auth_is_privileged()`* |
| 042 | `order_schedule` write | `auth_is_privileged() and auth_can_see_store(store_id)` |
| — | the three admin RPCs | `auth_is_privileged()` (20260517020000) |
| 051 | `user_stores` admin policy | `auth_is_privileged() and … auth_can_see_brand(...)` |

Spec 051 **explicitly noticed and explicitly deferred** the exact gap this spec
closes:

> *"Write policies on `public.ingredient_categories` are NOT touched — they remain
> gated by `auth_is_admin()` per spec 004 P6."*
> — [20260520010000_legacy_permissive_policy_dropout.sql:154-156](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)

---

## The (a) vs (b) decision — resolved, with the rejected option's reasoning kept

**(a) Broaden `auth_is_admin()` to also accept `'super_admin'`** — one function,
DB-wide.
**(b) Rewrite the seven leftover policies to `auth_is_privileged()`**, leaving
`auth_is_admin()` narrow.

**PM default: (b).** Rationale, so nobody re-opens it without new information:

1. **It would move super_admin's grant onto the JWT.** `auth_is_super_admin()`
   reads `profiles.role` *on purpose* — 012a §2: "super-admin must NOT be settable
   from any UI." Today a JWT that merely *claims* `app_metadata.role='super_admin'`
   grants nothing. Under (a) it would grant everything `auth_is_privileged()`
   grants. The `profiles_sync_role` trigger and the spec-042 `role changes require
   super_admin` trigger make this hard to exploit — but (a) still converts a
   profiles-guarded path into a token-guarded one, which is the wrong direction.
2. **Staleness.** A user promoted to `super_admin` mid-session has a fresh
   `profiles.role` and a stale JWT. `auth_is_super_admin()` admits immediately;
   the (a) JWT-string route admits only after a token refresh. (a) would therefore
   *not* reliably fix the reported bug.
3. **It collapses the two-tier design.** `auth_is_admin()` would become
   `auth_is_privileged()` minus the staleness-proof arm, making every
   `auth_is_privileged()` call site redundant and the helper pair meaningless — a
   much larger refactor than a 7-policy bug justifies.
4. **Precedent + blast-radius asymmetry.** Six prior fixes chose (b). And under (b)
   the blast radius is *exactly* the seven policies listed; under (a) it is
   "every current and future reader of `auth_is_admin()`", including references
   that may exist in prod but not in `supabase/migrations/`.

The **narrowness of `auth_is_admin()` is the intended design**, not the outlier.
The outlier is the seven policies that call it directly instead of calling the
convenience wrapper. AC-9 makes that explicit in-database so the next author sees
it without reading this spec.

---

## Acceptance criteria

### A. Policy parity (the seven)

- [ ] **AC-1 (`ingredient_categories` writes).** A caller whose `profiles.role` is
      `super_admin` can `INSERT`, `UPDATE` and `DELETE` rows in
      `public.ingredient_categories` via PostgREST under RLS. Concretely: the
      Categories section's add / rename / delete round-trips and a subsequent
      re-read reflects the change.
- [ ] **AC-2 (`audit_log` UPDATE/DELETE).** A `super_admin` caller can `UPDATE` and
      `DELETE` rows in `public.audit_log`. Concretely: `deleteStore` removes the
      store's audit rows, and `cleanupOldRecords`' `audit_log` arm deletes rows
      older than the cutoff.
- [ ] **AC-3 (`audit_log` store-less rows).** A `super_admin` caller can `SELECT`
      and `INSERT` `audit_log` rows where `store_id IS NULL` (the cross-cutting-event
      arm). The `store_id IS NOT NULL` arm keeps delegating to
      `auth_can_see_store()` — **byte-unchanged**.
- [ ] **AC-4 (strict superset — nobody loses access).** For every one of the seven
      policies, an `admin` JWT and a `master` JWT are admitted exactly as they are
      today, and a `user`/`staff` JWT is still refused. The change is provably a
      widening: each rewritten predicate is the old predicate with
      `auth_is_admin()` replaced by `auth_is_admin() OR auth_is_super_admin()`.
- [ ] **AC-5 (`auth_is_admin()` itself is unchanged).** The function body of
      `public.auth_is_admin()` is **not modified** — it still returns true only for
      JWT `app_metadata.role ∈ {admin, master}`. A diff that touches its `select`
      is contract drift, not a shortcut (see the (a)/(b) section).
- [ ] **AC-6 (one migration, idempotent).** Exactly one new migration under
      `supabase/migrations/`, `drop policy if exists` before every `create policy`,
      re-runnable to a no-op, policy-DDL-only (no table/column/index/trigger/grant
      changes), with an operational rollback block in the header comment following
      the [spec-051 migration](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)
      shape.
- [ ] **AC-7 (applied to prod, gate re-green).** The migration is applied to prod
      per the house flow (Supabase MCP `execute_sql` + the exact version inserted
      into `supabase_migrations.schema_migrations` + normalized-md5 verification,
      project `ebwnovzzkwhsdxkpyjka`), and the
      [`db-migrations-applied.yml`](../.github/workflows/db-migrations-applied.yml)
      gate is green on `main` afterwards. The known red window between merge and
      apply is called out in the PR body.
- [ ] **AC-8 (permissive-policy lint stays green, no allowlist row).** The spec-053
      probe [permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql)
      passes **without** adding a row to its 2-row allowlist. `auth_is_privileged()`
      is not a trivially-wide predicate, and no `SELECT` policy's `using` clause is
      loosened. The two `*_categories` SELECT policies are not touched.
- [ ] **AC-9 (the rule is written down in-database).** `public.auth_is_admin()`
      carries a `comment on function` stating that it is the **narrow, JWT-only**
      tier (`admin`/`master`), that `super_admin` is intentionally excluded because
      its source of truth is `profiles.role`, and that **new policies should gate on
      `auth_is_privileged()`** unless they deliberately mean to exclude super_admin
      — in which case they must say so in a `comment on policy`.

### B. Honest DB Inspector auth banner

- [ ] **AC-10 (truthful predicate).** The banner keys off the **privileged**
      predicate, not `is_admin`. A `super_admin` sees an **affirmative** state, not
      a red warning. An `admin`/`master` sees the same affirmative state they see
      today.
- [ ] **AC-11 (the probe can answer the question).** `public.admin_db_inspector_probe()`'s
      `auth` object gains `is_privileged` and `is_super_admin` booleans alongside
      the existing `is_admin`, `app_metadata`, `user_id`. `is_admin` is **kept**
      (it is genuinely useful: it tells you which arm admitted you). No other key
      is renamed or removed — the `schema` / `counts` / `recipe_groups` /
      `prep_groups` payload is byte-unchanged, and the function's
      `auth_is_privileged()` entry guard, `security definer`, `set search_path`
      and grants are unchanged.
- [ ] **AC-12 (copy names only what is actually gated).** The non-privileged copy
      no longer claims "**ALL** your CRUD is being silently denied" and no longer
      cites `auth_is_admin()` as the gate for brand-catalog writes (it has not been
      since 012a). The privileged-but-not-JWT-admin case (i.e. `super_admin`) reads
      as reassurance, not alarm — the shape to convey: *you are super_admin; writes
      are authorized; token-only checks report `is_admin: false`, which is expected
      because super_admin is read from your profile row, not your token.* Exact
      wording is the implementer's, but it must not assert a scope it cannot
      substantiate.
- [ ] **AC-13 (the impossible state is labelled as such).** If `is_privileged` is
      ever false, the banner may still warn — but it says so as *"the probe should
      not have returned at all"* (the RPC's own guard is `auth_is_privileged()`),
      rather than as a normal diagnosis.
- [ ] **AC-14 (no i18n surface added).** `DBInspectorScreen` remains un-i18n'd
      hardcoded English, consistent with the rest of the screen. No key is added to
      `src/i18n/*.json` or to any staff catalog.
- [ ] **AC-15 (payload-shape resilience).** A probe response **without** the new
      fields (an old deployed function, or a stale prod apply) does not crash the
      screen and does not render a false green: the missing-field case degrades to a
      neutral/unknown state. The web bundle and the DB do not deploy atomically —
      same deploy-skew posture as spec 155 AC-18.

### C. Regression group (AC-REG)

- [ ] **AC-REG-1 (no policy other than the seven changes).** A before/after
      `pg_policies` dump for `public.*` differs in exactly seven rows. Any eighth
      diff is drift.
- [ ] **AC-REG-2 (helpers frozen).** `auth_is_admin()`, `auth_is_super_admin()`,
      `auth_is_privileged()`, `auth_can_see_store()`, `auth_can_see_brand()` bodies
      are unchanged (AC-9's `comment on function` is metadata, not a body edit).
- [ ] **AC-REG-3 (no scope loosening or tightening beyond role).** The rewritten
      predicates keep their existing `store_id` / OR-arm structure verbatim; only
      the role helper changes. In particular `admin_update_audit_log` /
      `admin_delete_audit_log` remain **unscoped by store** — see OQ-3.
- [ ] **AC-REG-4 (existing pgTAP suites green, unmodified).** In particular
      [recipe_categories_super_admin_rls.test.sql](../supabase/tests/recipe_categories_super_admin_rls.test.sql),
      [legacy_permissive_policy_dropout.test.sql](../supabase/tests/legacy_permissive_policy_dropout.test.sql),
      [permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql),
      [rls_hardening_followups.test.sql](../supabase/tests/rls_hardening_followups.test.sql),
      [admin_rpcs_privileged.test.sql](../supabase/tests/admin_rpcs_privileged.test.sql),
      [actor_fk_cascade_audit.test.sql](../supabase/tests/actor_fk_cascade_audit.test.sql) and
      [missed_order_audit_rpc.test.sql](../supabase/tests/missed_order_audit_rpc.test.sql).
- [ ] **AC-REG-5 (staff untouched).** No change under `src/screens/staff/` or its
      i18n catalogs. Staff EOD / weekly-count writes ride
      `auth_can_see_store()` / dedicated RPCs and are outside this diff.
- [ ] **AC-REG-6 (no edge function touched).** Zero files under
      `supabase/functions/`, and `supabase/config.toml` stays out of the diff.
      The `ADMIN_ROLES` sets already include `super_admin` (spec 027) — this spec
      brings the DB *toward* that posture, it does not change it.
- [ ] **AC-REG-7 (`app.json`).** Untouched, slug (`towson-inventory`) included.
- [ ] **AC-REG-8 (no realtime change).** Policy DDL does not alter publication
      membership, so the `docker restart supabase_realtime_imr-inventory` ritual is
      **not** required and must not be added to any checklist as a no-op.

### D. Tests (spec 022 tracks — the test-engineer routes by track name)

- [ ] **AC-16 (pgTAP — primary track).** New arms in a new suite (working name
      `supabase/tests/super_admin_policy_parity.test.sql`), hermetic
      `begin; … rollback;`, modelled on
      [recipe_categories_super_admin_rls.test.sql](../supabase/tests/recipe_categories_super_admin_rls.test.sql)
      (which already documents the fixture trick: promote the seeded master
      `33333333-…` to `super_admin` with `brand_id = null` inside the txn to satisfy
      `profiles_role_brand_consistent`, and impersonate with
      `app_metadata.role='user'` so the passing path is provably
      `auth_is_super_admin()` and not the JWT).
      Minimum coverage — **positive super_admin + negative regular-user for every
      changed policy**:
      - `ingredient_categories`: super_admin INSERT / UPDATE / DELETE succeed;
        plain-`user` INSERT throws `42501`; plain-`user` UPDATE/DELETE affect 0 rows.
      - `audit_log` store-less row: super_admin INSERT succeeds and SELECT sees it;
        plain-`user` cannot.
      - `audit_log` UPDATE and DELETE: super_admin affects 1 row; plain-`user`
        affects 0 rows.
      - Regression arms: `admin` JWT and `master` JWT still succeed on at least one
        vector per table (AC-4).
      - A `select … from pg_policies` assertion that no `public.*` policy predicate
        contains `auth_is_admin` outside the documented OR-arms (see OQ-6 for
        whether this becomes a standalone lint probe).
- [ ] **AC-17 (jest).** A new suite for the DB Inspector banner covering the four
      probe shapes: `{is_privileged:true, is_admin:true}` → affirmative;
      `{is_privileged:true, is_admin:false, is_super_admin:true}` → affirmative,
      **no** red "NOT admin" string, **no** "ALL your CRUD" string;
      `{is_privileged:false}` → the AC-13 "should not have returned" shape;
      **fields absent entirely** → neutral, no false green (AC-15).
- [ ] **AC-18 (no shell smoke).** This spec adds no service-token or key-dependent
      surface, so the third track is not exercised. Say so in the PR rather than
      leaving it ambiguous.
- [ ] **AC-19 (typecheck gates).** Both `test.yml` typecheck jobs pass — including
      `typecheck:test`, which jest alone does not cover (the phone-tier lesson).

---

## In scope

- One migration rewriting the **seven** surviving bare-`auth_is_admin()` policies
  (`audit_log` ×4, `ingredient_categories` ×3) to `auth_is_privileged()`,
  preserving every other clause verbatim.
- A `comment on function public.auth_is_admin()` recording the narrow-tier rule.
- Extending `public.admin_db_inspector_probe()`'s `auth` object with
  `is_privileged` + `is_super_admin` (additive only).
- Rewriting the `DBInspectorScreen` auth banner to key off the privileged
  predicate and to say only what is true.
- pgTAP arms for every changed policy (positive super_admin + negative regular
  user + admin/master regression) and a jest suite for the banner.
- Applying the migration to prod and re-greening `db-migrations-applied.yml`.

## Out of scope (explicitly — non-goals)

- **Broadening `auth_is_admin()` itself.** Option (a), rejected above with four
  reasons. The helper stays narrow; AC-5 pins it.
- **Store/brand-scoping `admin_update_audit_log` / `admin_delete_audit_log`.**
  Those two policies have **no store or brand scope at all** — any `admin` can
  update or delete any audit row across every brand. That is a pre-existing gap
  worth its own spec (it interacts with `cleanupOldRecords`, which does a global
  `delete … lt(created_at, cutoff)` with no store filter and would break under a
  naive `auth_can_see_store(store_id)` tightening). Flagged, not fixed — a parity
  spec that also tightens is two changes wearing one coat. See OQ-3.
- **Making `db.ts`'s category writers check `error`.** The silent-swallow at
  [db.ts:4059-4095](../src/lib/db.ts) and [db.ts:3527](../src/lib/db.ts) is what
  turned this bug into a *ghost*, but fixing RLS removes the denial for the
  affected principal. Changing error handling touches optimistic-then-revert
  semantics for every caller and belongs in its own change. See OQ-4.
- **Internationalizing `DBInspectorScreen`.** It is hardcoded English throughout;
  translating one banner would make the screen inconsistent with itself. AC-14
  pins the exclusion.
- **Restyling DB Inspector onto the Cmd palette.** It uses legacy `useColors()`.
  Out of scope; copy and predicate only.
- **Any role-hierarchy change** (e.g. "only super_admins may demote super_admins").
  The spec-050 self-guard and the spec-031 last-of-role guard are untouched.
- **Any edge-function change.** `ADMIN_ROLES` already includes `super_admin`
  everywhere (spec 027). AC-REG-6.
- **Backfilling / re-issuing JWTs, or changing `profiles_sync_role`.** Nothing here
  requires a token refresh — `auth_is_super_admin()` reads `profiles.role` live.
- **`app.json` slug / identity drift.** Untouched per CLAUDE.md's DO-NOT-AUTO-FIX
  rule. Nothing here touches build identifiers, store listings or push certs.
- **The staff surface and the customer PWA.** Different app, different repo
  (PWA); staff writes do not ride any of the seven policies.

## Open questions resolved (from the incident + this investigation)

- Q: Is `super_admin` actually being denied, or is the banner the whole bug?
  → **A: Both are real.** Seven policies genuinely deny; the banner is separately
  wrong about scope. Fix both, in one spec, because diagnosing one without the
  other is what cost the owner an afternoon.
- Q: Broaden the helper (a) or the policies (b)?
  → **A: (b).** Full reasoning in the "(a) vs (b) decision" section; AC-5 pins the
  helper as unchanged.
- Q: Does any policy *deliberately* exclude `super_admin`?
  → **A: None found.** All nine live references were enumerated; two are no-op
  OR-arms inside `auth_can_see_store()` / `auth_is_privileged()`, and the seven
  are unambiguous leftovers — spec 051 even documented the `ingredient_categories`
  three as a known deferral. The architect re-verifies against prod
  `pg_policies` + `pg_proc` before designing (queries provided above).
- Q: Do the edge functions need a matching change?
  → **A: No.** CLAUDE.md's `ADMIN_ROLES = {admin, master, super_admin}` rule
  already mirrors `auth_is_privileged()`; the DB was behind, not ahead.

## Open questions (non-blocking — defaults chosen so the architect is unblocked)

Each has a PM default. The owner can override any at architect review without
reshaping the contract.

- **OQ-1 — (a) vs (b).** **Default: (b)**, per the dedicated section. Recorded as
  an OQ rather than a closed decision only because (a) was explicitly requested for
  evaluation; the evidence points one way. If the architect finds a prod policy or
  function that (b) would miss, that is the trigger to revisit.
- **OQ-2 — how the banner learns it is privileged.** **Default: extend the probe
  RPC** with `is_privileged` + `is_super_admin` (AC-11). The rejected alternative —
  inferring "the RPC returned, therefore I am privileged" — is *technically* sound
  today but is an invisible coupling to the RPC's entry guard that the next edit
  would silently break. A second alternative, reading `app_metadata.role` client-side,
  re-creates the token-trust problem this spec is arguing against. Since one
  migration is already shipping, folding the `create or replace function` into it
  costs one prod apply, not two.
- **OQ-3 — should `audit_log` UPDATE/DELETE gain a store/brand scope?**
  **Default: NO, defer.** Named in out-of-scope with the `cleanupOldRecords`
  interaction spelled out. Reviewers are likely to raise it; the answer is "yes,
  eventually, in its own spec with its own retention-purge design", not "while
  we're in here."
- **OQ-4 — should the three `ingredient_categories` writers in `db.ts` start
  surfacing `error`?** **Default: NO, defer.** It is the honesty half of the same
  incident and it is tempting, but it changes optimistic-then-revert behavior for
  every caller of those helpers and needs its own jest pins. If the architect
  judges it a two-line change with no behavior change for the success path, they
  may fold it in — but it must then get its own AC and its own test, not ride
  along unpinned.
- **OQ-5 — where the narrow/wide rule is durably recorded.** **Default: the
  `comment on function` (AC-9) ships in this spec; the parallel CLAUDE.md bullet is
  drafted in the PR body for the owner to accept or decline.** Agents do not edit
  CLAUDE.md unilaterally. Proposed bullet text:
  > *"`public.auth_is_admin()` is the NARROW tier — JWT `app_metadata.role ∈
  > {admin, master}` only. `super_admin` is deliberately excluded because its
  > source of truth is `profiles.role`, not the token. New RLS policies and
  > SECURITY DEFINER guards gate on `public.auth_is_privileged()` unless they
  > intend to exclude super_admin, in which case the exclusion is stated in a
  > `comment on policy`. Spec 157 closed the last seven leftovers (`audit_log` ×4,
  > `ingredient_categories` ×3); an eighth is a regression."*
- **OQ-6 — standalone pgTAP lint probe for future bare-`auth_is_admin()` policies?**
  **Default: YES, as one arm inside the new suite** (not a separate file):
  assert that no `public.*` policy predicate contains `auth_is_admin` at all after
  this spec — which will be exactly true, since the only two surviving references
  are inside function bodies, not policy predicates. That makes the arm a clean
  `= 0` with no allowlist to maintain, in the spirit of spec 053. If the architect
  prefers a separate `auth_is_admin_policy_lint.test.sql` mirroring spec 053's file
  layout, that is equally acceptable.
- **OQ-7 — migration filename/timestamp.** **Default:**
  `supabase/migrations/20260809000000_super_admin_policy_parity.sql` (next after
  `20260803000000_report_last_order_context.sql`). Architect may adjust the
  timestamp; the ordering constraint is only that it sorts after 20260803000000.

## Dependencies

- [supabase/migrations/20260504073942_brand_catalog_p5_rls.sql](../supabase/migrations/20260504073942_brand_catalog_p5_rls.sql)
  — defines `auth_is_admin()`. **Read-only** (AC-5); the `comment on function` in
  the new migration is the only thing that references it.
- [supabase/migrations/20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)
  — the four `audit_log` policies being rewritten.
- [supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql](../supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql)
  — the three `ingredient_categories` write policies being rewritten.
- [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)
  — `auth_is_super_admin()` / `auth_is_privileged()` / `auth_can_see_brand()`.
  **Frozen.**
- [supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql](../supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql)
  — the current body of `admin_db_inspector_probe()`; the new migration
  `create or replace`s it with the two added `auth` keys (AC-11). Copy the body
  verbatim and change only the `jsonb_build_object('auth', …)` block, exactly as
  20260517020000 itself did.
- [supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql](../supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql)
  and [20260520010000_legacy_permissive_policy_dropout.sql](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)
  — reference shapes for the migration header + rollback block.
- [supabase/tests/recipe_categories_super_admin_rls.test.sql](../supabase/tests/recipe_categories_super_admin_rls.test.sql)
  — reference shape for the pgTAP fixtures.
- [supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql)
  — must stay green with **no** allowlist edit (AC-8).
- [src/screens/DBInspectorScreen.tsx](../src/screens/DBInspectorScreen.tsx) — the
  `Probe` type ([lines 70-84](../src/screens/DBInspectorScreen.tsx)) and the banner
  ([lines 186-201](../src/screens/DBInspectorScreen.tsx)).
- [src/lib/db.ts](../src/lib/db.ts) — **read-only reference** for the affected
  write paths (4059-4095, 3527, 181, 5831). No edit at the OQ-4 default.
- Prod project `ebwnovzzkwhsdxkpyjka` + the Supabase MCP apply flow (the house
  substitute for `supabase db push`, which lacks the prod password).
- Both CI gates: [.github/workflows/test.yml](../.github/workflows/test.yml) and
  [.github/workflows/db-migrations-applied.yml](../.github/workflows/db-migrations-applied.yml).

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI only. The banner lives on the
  `DBInspector` **sibling stack route**
  ([src/screens/DBInspectorScreen.tsx](../src/screens/DBInspectorScreen.tsx),
  registered at [CmdNavigator.tsx:49](../src/navigation/CmdNavigator.tsx)) — note
  it is *not* under `src/screens/cmd/sections/`, and it renders with the legacy
  `useColors()` palette. That is pre-existing and intentional per
  [cmdSelectors.ts:1133](../src/lib/cmdSelectors.ts); this spec does not relocate
  or restyle it. No legacy admin surface exists (spec 025).
- **Which app:** this repo (admin) only. Staff subtree untouched (AC-REG-5); the
  customer PWA and the Chrome extension are siblings and are untouched.
- **Per-store or admin-global:** **mixed, and the distinction is preserved
  exactly.** `ingredient_categories` is **admin-global** curated master data
  (intentionally cross-brand per spec 004 / 051 — its SELECT policy is on the
  spec-053 allowlist and is not touched here). `audit_log` is **per-store** via the
  `auth_can_see_store(store_id)` arm, with a store-less arm for cross-cutting
  events; both arms keep their existing shape and only the role helper widens
  (AC-REG-3). Per-store RLS hardening posture is unchanged.
- **Edge function or PostgREST:** **PostgREST + one RPC.** The category and
  audit-log writes are plain PostgREST under RLS through
  [src/lib/db.ts](../src/lib/db.ts). The probe is an existing SECURITY DEFINER RPC
  called via `supabase.rpc` from the screen — a pre-existing carve-out from the
  db.ts rule that this spec does not widen. **No edge function is touched**
  (AC-REG-6), so the `verify_jwt` / service-token split, the `ADMIN_ROLES` mirror
  rule, the `escapeHtml()` rule and the `callEdgeFunction` rule are all N/A here.
- **Realtime channels touched:** **none.** Policy DDL does not change publication
  membership, so the `docker restart supabase_realtime_imr-inventory` gotcha does
  **not** apply — stated explicitly so nobody pads the checklist (AC-REG-8).
- **Migrations needed:** **yes — exactly one.** Policy DDL + one
  `comment on function` + one `create or replace function
  admin_db_inspector_probe`. It must be applied to prod via the MCP flow, and
  `db-migrations-applied.yml` will sit **red between merge and apply** — surface
  the run URL and re-check per the CLAUDE.md CI rule rather than treating red as
  drift.
- **Edge functions touched:** **none.** The three permanent `staff-*` 410 stubs
  and every other function are untouched.
- **Web/native scope:** **both.** The policy change is server-side and platform
  agnostic. The banner ships in the admin Cmd UI bundle (web → Vercel, native →
  EAS); DB Inspector is desktop-oriented but is not web-gated.
- **Tests (spec 022 tracks):** **pgTAP is the primary track** (AC-16); **jest**
  covers the banner (AC-17); the **shell-smoke** track is deliberately not
  exercised (AC-18). `typecheck:test` is a CI gate jest alone does not cover
  (AC-19).
- **`app.json` slug:** untouched (`towson-inventory`), per CLAUDE.md's
  DO-NOT-AUTO-FIX rule. Nothing here touches build identifiers, app store listings
  or push certs.
- **CI:** both gates must be green on `main` before this ships, and — per the
  CLAUDE.md rule — the migration gate must be re-checked **after** the prod apply,
  not just after the merge.

## Files expected to change (architect may refine)

- `specs/157-super-admin-rls-parity.md` (this file)
- `supabase/migrations/20260809000000_super_admin_policy_parity.sql` — **new**;
  7 policy rewrites + `comment on function auth_is_admin()` +
  `create or replace function admin_db_inspector_probe()`
- `supabase/tests/super_admin_policy_parity.test.sql` — **new** pgTAP suite
- `src/screens/DBInspectorScreen.tsx` — `Probe` type + banner predicate + copy
- `src/screens/__tests__/DBInspectorScreen.test.tsx` (or the house-conventional
  location) — **new** jest suite

Explicitly **not** in the diff: `src/lib/db.ts` (at the OQ-4 default),
`src/screens/staff/**`, `src/i18n/*`, `supabase/functions/**`,
`supabase/config.toml`, `app.json`, `vercel.json`, and
`supabase/tests/permissive_policy_lint.test.sql` (AC-8 — an allowlist edit here
would itself be drift).

---

# Backend design

Author: backend-architect. Design mode, entered at `Status: READY_FOR_ARCH`.

## 0. Prod re-verification — NOT PERFORMED HERE. Hard gate handed downstream.

The dispatching prompt asked me to re-verify the spec's live-reference table
against prod via the Supabase MCP `execute_sql` before designing. **I could not
do this.** This agent's toolset in the current session is `Read` / `Write` /
`Edit` / `Grep` / `Glob` only — there is no `ToolSearch` and no
`mcp__supabase__*` tool exposed to me, so the queries could not be run. I am not
going to silently pretend the check happened; that is exactly the class of
"assume the repo is prod" error this spec exists to clean up after.

**Consequence, and it is load-bearing: D-0 below is a blocking pre-implementation
step for `backend-developer`, not a nice-to-have.** The design below is derived
from repo state at `6dda20c` and is *conditionally* correct. If D-0 returns
anything other than the expected set, the developer stops and re-opens this
section rather than adapting on the fly.

### D-0 (BLOCKING, backend-developer, before writing the migration)

Run the spec's two queries against project `ebwnovzzkwhsdxkpyjka` via Supabase
MCP `execute_sql`, and paste both result sets into the PR body.

**Expected result of query (a)** — exactly seven rows, in this shape:

| tablename | policyname | cmd | narrow-helper location |
|---|---|---|---|
| `audit_log` | `store_member_read_audit_log` | SELECT | `qual`, `store_id IS NULL` OR-arm |
| `audit_log` | `store_member_insert_audit_log` | INSERT | `with_check`, `store_id IS NULL` OR-arm |
| `audit_log` | `admin_update_audit_log` | UPDATE | `qual` + `with_check`, whole predicate |
| `audit_log` | `admin_delete_audit_log` | DELETE | `qual`, whole predicate |
| `ingredient_categories` | `Admins can write ingredient categories` | INSERT | `with_check`, whole predicate |
| `ingredient_categories` | `Admins can update ingredient categories` | UPDATE | `qual` + `with_check`, whole predicate |
| `ingredient_categories` | `Admins can delete ingredient categories` | DELETE | `qual`, whole predicate |

**Expected result of query (b)** — exactly two functions, both `prosecdef = true`:
`public.auth_can_see_store(uuid)` and `public.auth_is_privileged()`. (Note the
probe RPC and the two dedupe RPCs will NOT appear: `20260517020000` replaced
their guards with `auth_is_privileged()`, and the probe's *payload* reference to
`auth_is_admin()` inside `jsonb_build_object` will make it appear in query (b)
as well — see the caveat below.)

⚠ **Caveat on query (b) as written in the spec.** It matches
`pg_get_functiondef(...) like '%auth_is_admin%'`, which will also match
`public.admin_db_inspector_probe()` because that function *emits*
`'is_admin', public.auth_is_admin()` in its payload
([20260517020000:28](../supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql)).
That is a payload read, not a gate, and it is **intentional and kept** (AC-11).
So the expected query-(b) result is **three** rows, not two:
`auth_can_see_store(uuid)`, `auth_is_privileged()`, `admin_db_inspector_probe()`.
The developer should additionally run the sharper gate-specific probe:

```sql
select p.oid::regprocedure as fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and pg_get_functiondef(p.oid) ~* 'not\s+public\.auth_is_admin\s*\(\s*\)';
```

Expected: **zero rows**. A non-zero result is a live gate the repo does not know
about and is a stop-and-escalate.

### Stop-and-escalate conditions

- Query (a) returns **more than seven** rows → an eighth leftover exists in prod
  that is not in `supabase/migrations/`. Do not silently widen the migration to
  cover it; report the extra rows and re-dispatch `backend-architect`. The
  seven-row count is pinned by AC-REG-1 and an unannounced eighth invalidates it.
- Query (a) returns **fewer than seven** rows → someone already patched part of
  this in prod via the dashboard SQL editor. The migration is still correct
  (every statement is `drop policy if exists` + `create policy`, so it converges),
  but AC-REG-1's "differs in exactly seven rows" assertion needs restating and
  the PR body must record the pre-existing drift.
- Any policy's `qual` / `with_check` text differs structurally from the repo text
  reproduced in §2 below → the "byte-preserve every other clause" instruction
  applies to **prod's** text, not the repo's. Report before writing.
- The gate-specific probe returns any row → stop.

### What I *did* verify, from the repo, and one correction to the spec

- `rg 'public\.auth_is_admin\(\)' supabase/migrations` → **56 occurrences across
  8 files**, matching the spec exactly.
- The spec's blast-radius table is **correct on repo evidence**. The 27
  `admin_*` policies created by
  [20260504073942_brand_catalog_p5_rls.sql](../supabase/migrations/20260504073942_brand_catalog_p5_rls.sql)
  are all named in the `drop policy if exists` block at
  [20260509000000:415-851](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)
  — I counted both sides. The surviving P5 `auth_read_*` SELECT policies use
  `auth.uid() is not null`, **not** the narrow helper, so the OQ-6 `= 0` lint arm
  is achievable on repo state (see §7).
- **A broader grep finds 21 files, not 8.** `rg 'auth_is_admin' supabase/` (no
  `public.` prefix, no parens) hits 21 files / 86 occurrences. I checked every
  file outside the spec's eight:
  `20260703000000_user_count_drafts.sql`, `20260630000500_user_count_orders.sql`,
  `20260510120000_report_runs.sql`, `20260513000000_inventory_counts.sql`,
  `20260630000000_item_vendors.sql`, `20260622090000_weekly_count_kind_and_cadence.sql`
  — **all comment-only**, plus the pgTAP suites. No live reference. The spec's
  enumeration stands. Recording this so the next reader does not re-derive it and
  panic at the 21-file number.
- **Correction to the spec's "Client surfaces" table.**
  [db.ts:3529 `updateIngredientCategoryI18n`](../src/lib/db.ts) is listed as
  behaving the "same" as the three writers at 4059-4095. It does not: it
  *destructures and throws* on `error` (line 3523/3539 shape). The *outcome* is
  the same — an RLS-denied UPDATE returns zero rows and no error — but the
  mechanism differs, and a reviewer reading the spec will otherwise flag it as a
  contradiction. This does not change the design; it changes OQ-4's blast radius
  (three helpers, not four).
- **Neither `audit_log` nor `ingredient_categories` is in the `supabase_realtime`
  publication at all** — see
  [20260514140000_realtime_publication_tighten.sql:43-53](../supabase/migrations/20260514140000_realtime_publication_tighten.sql).
  This is stronger than AC-REG-8 claims; see §6.

### D-0 execution record (backend-developer, 2026-08-09)

> ⛔ **ESCALATION — the PROD half of D-0 was NOT performed, for the same
> reason the architect could not perform it.** My toolset in this session is
> `Read` / `Write` / `Edit` / `Bash` only. There is **no `ToolSearch` tool and no
> `mcp__supabase__*` tool exposed**, `~/.supabase/access-token` does not exist,
> no `SUPABASE_ACCESS_TOKEN` is in the environment, and `mcpServers` is empty for
> this project in both `.mcp.json` (absent) and `~/.claude.json`. There is no
> path from this session to project `ebwnovzzkwhsdxkpyjka`. I am recording that
> rather than pretending the check happened — that is the exact class of
> "assume the repo is prod" error this spec exists to clean up after.
>
> **D-0 therefore remains a BLOCKING gate, now in front of the prod apply
> (AC-7 / §10 step 2) rather than in front of the migration.** Whoever holds the
> MCP tool must run the three queries below against prod and compare to the
> local results recorded here BEFORE applying. The migration itself is
> convergent (`drop policy if exists` + `create policy` throughout), so
> pre-existing prod drift does not make it *wrong* — but an **eighth** policy in
> prod would make it **incomplete**, and AC-REG-1's "exactly seven rows differ"
> assertion would be false.

**What I *was* able to run:** all three queries against the **local** stack
(`supabase_db_imr-inventory`), which carries **128 applied migrations, latest
`20260803000000`** — i.e. the full repo chain at `6dda20c`, and whose schema
descends from the `supabase db pull` of prod taken 2026-05-02. This verifies the
spec's blast-radius table against the *migration chain*. It does **not** detect
dashboard-SQL-editor drift in prod, which is the only thing D-0 actually exists
to catch.

#### Query (a) — policies whose predicate names the narrow helper

Local result: **exactly seven rows**, matching the architect's expected table
row-for-row, including which of `qual` / `with_check` carries the reference.

```
       tablename       |               policyname                |  cmd   | in_qual | in_with_check
-----------------------+-----------------------------------------+--------+---------+---------------
 audit_log             | admin_delete_audit_log                  | DELETE | yes     | no
 audit_log             | store_member_insert_audit_log           | INSERT | no      | yes
 audit_log             | store_member_read_audit_log             | SELECT | yes     | no
 audit_log             | admin_update_audit_log                  | UPDATE | yes     | yes
 ingredient_categories | Admins can delete ingredient categories | DELETE | yes     | no
 ingredient_categories | Admins can write ingredient categories  | INSERT | no      | yes
 ingredient_categories | Admins can update ingredient categories | UPDATE | yes     | yes
(7 rows)
```

Full predicate text (confirms the §3 "byte-preserve every other clause"
instruction is against text identical to the repo's; `permissive`/`roles` also
recorded because the migration must not change them either):

```
audit_log | admin_delete_audit_log        | DELETE | PERMISSIVE | {public} | qual: auth_is_admin()                                                                                        | with_check: -
audit_log | store_member_insert_audit_log | INSERT | PERMISSIVE | {public} | qual: -                                                                                                      | with_check: (((store_id IS NOT NULL) AND auth_can_see_store(store_id)) OR ((store_id IS NULL) AND auth_is_admin()))
audit_log | store_member_read_audit_log   | SELECT | PERMISSIVE | {public} | qual: (((store_id IS NOT NULL) AND auth_can_see_store(store_id)) OR ((store_id IS NULL) AND auth_is_admin())) | with_check: -
audit_log | admin_update_audit_log        | UPDATE | PERMISSIVE | {public} | qual: auth_is_admin()                                                                                        | with_check: auth_is_admin()
ingredient_categories | Admins can delete ingredient categories | DELETE | PERMISSIVE | {public} | qual: auth_is_admin() | with_check: -
ingredient_categories | Admins can write ingredient categories  | INSERT | PERMISSIVE | {public} | qual: -               | with_check: auth_is_admin()
ingredient_categories | Admins can update ingredient categories | UPDATE | PERMISSIVE | {public} | qual: auth_is_admin() | with_check: auth_is_admin()
```

#### Query (b) — function bodies naming the narrow helper

⚠ **The spec's query (b) as written does not run.** It errors with:

```
ERROR:  "array_agg" is an aggregate function
```

`pg_get_functiondef()` raises on aggregate/window/procedure entries, and the
planner may evaluate it before the `nspname = 'public'` join filter. **Add
`and p.prokind = 'f'`.** Whoever runs this against prod must use the corrected
form or they will get an error instead of an answer:

```sql
select p.oid::regprocedure as fn, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
   and pg_get_functiondef(p.oid) like '%auth_is_admin%'
 order by 1;
```

Local result: **four** rows, not the architect's predicted three — the
prediction omitted `auth_is_admin()` itself, whose own `create or replace`
definition trivially contains its own name. All four are accounted for and none
is a gate:

```
             fn             | prosecdef
----------------------------+-----------
 auth_is_admin()            | t          <- its own definition (trivial self-match)
 auth_can_see_store(uuid)   | t          <- documented OR-arm, no-op for super_admin
 admin_db_inspector_probe() | t          <- payload emit, not a gate (AC-11 keeps it)
 auth_is_privileged()       | t          <- documented OR-arm
(4 rows)
```

#### Sharper gate-only probe — the actual stop-and-escalate condition

```sql
select p.oid::regprocedure as fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
   and pg_get_functiondef(p.oid) ~* 'not\s+public\.auth_is_admin\s*\(\s*\)';
```

Local result: **zero rows.** No live `if not public.auth_is_admin()` guard
exists in any function body. (Same `prokind` caveat applies.)

#### R-5 sanity — `audit_log` size

`select count(*) from public.audit_log` → **0** locally. **Not meaningful for
the R-5 retention-purge cost question** — that number must be taken from prod
during the pre-apply D-0 pass.

#### Verdict

Against the **migration chain**: the seven-row expectation holds exactly, the
predicate text matches the repo, and no function-level gate survives. No
stop-and-escalate condition tripped **locally**. Against **prod**: unverified,
and explicitly carried forward as a pre-apply blocker.

## 1. Open-question rulings

| OQ | PM default | Architect ruling |
|---|---|---|
| **OQ-1** — (a) broaden helper vs (b) rewrite policies | (b) | **(b), affirmed.** The PM's four reasons hold and I add a fifth: `public.auth_is_admin()` is referenced 56 times across 8 migrations and is the OR-arm of `auth_can_see_store()`, which is itself the gate on ~40 store-scoped policies. Option (a) would silently re-widen the spec-041 brand-scoping arm (`auth_is_admin() AND auth_can_see_brand(...)`) for anyone holding a forged-claim JWT. (b)'s blast radius is seven rows in `pg_policies`. Not close. |
| **OQ-2** — how the banner learns it is privileged | extend the probe RPC | **Extend the probe, affirmed** — with the refinement in §4/§8: the client must treat *field absence* as `unknown`, not as `false`. Inferring privilege from "the RPC returned" is rejected for the PM's stated reason (invisible coupling), and additionally because it cannot distinguish `admin` from `super_admin`, which is precisely the distinction AC-12 needs to write honest copy. |
| **OQ-3** — store/brand-scope `audit_log` UPDATE/DELETE | defer | **Defer, affirmed.** Flagged as a future spec in §11. I add the concrete reason the naive fix breaks: `cleanupOldRecords` ([db.ts:5831](../src/lib/db.ts)) issues a global `delete … lt('created_at', cutoff)` with no store filter. Under a `auth_can_see_store(store_id)` tightening, a brand-admin's purge would silently become a partial purge and store-less rows (`store_id IS NULL`) would become unpurgeable by anyone but a super_admin. That is a retention-design change, not a role-parity change. |
| **OQ-4** — make `db.ts` category writers surface `error` | defer, architect may fold in | **Defer. Do NOT fold in.** The PM left the door open "if it's a two-line change with no success-path behavior change." It is not. `addIngredientCategory` / `updateIngredientCategory` / `deleteIngredientCategory` are called from `CategoriesSection` inside the optimistic-then-revert pattern; making them throw converts today's silent-no-op into a thrown rejection at three call sites whose `catch` behavior is not currently pinned by any test. That needs its own AC, its own jest arms, and its own revert-path design. Folding it in here would also make AC-REG-1's "seven rows" the only clean assertion in a two-concern diff. **`src/lib/db.ts` stays out of the diff entirely.** Flagged in §11. |
| **OQ-5** — where the narrow/wide rule is recorded | `comment on function` ships; CLAUDE.md bullet drafted in PR body | **Affirmed.** The `comment on function` is in the migration (§2). The CLAUDE.md bullet text the PM drafted is good as-is; it goes in the PR body for the owner to accept. **Agents do not edit CLAUDE.md in this PR.** One addition I want in the drafted bullet: a pointer to the *counter-example*, so the rule is not read as absolute — `public.user_count_drafts` and `public.user_count_orders` deliberately have **no** privileged bypass at all ([20260703000000:128-133](../supabase/migrations/20260703000000_user_count_drafts.sql), [20260630000500:111-118](../supabase/migrations/20260630000500_user_count_orders.sql)); those tables state the exclusion in a header comment, which is exactly the escape hatch the rule prescribes. |
| **OQ-6** — standalone lint probe vs one arm | YES, one arm in the new suite | **One arm in the new suite, affirmed.** Not a separate file: a `= 0` assertion with no allowlist is not worth its own file, and colocating it with the seven policies it protects means the next person who changes those policies sees the guard. Exact arm shape in §7 (LINT-1). **Important**: the arm must scan `pg_policies` predicates only, NOT function bodies — `auth_can_see_store()` and `auth_is_privileged()` legitimately name the narrow helper in their bodies and must not trip it. |
| **OQ-7** — migration filename | `20260809000000_super_admin_policy_parity.sql` | **Affirmed unchanged.** Latest migration on disk is `20260803000000_report_last_order_context.sql`; `20260809000000` sorts after it and matches today's date. |

## 2. Data model changes

**Migration:** `supabase/migrations/20260809000000_super_admin_policy_parity.sql`
— **new, one file, additive-in-effect, DDL-only.**

No tables, columns, indexes, constraints, triggers, grants, extensions or
publication members are created, altered or dropped. The migration contains
exactly three kinds of statement:

1. Seven `drop policy if exists` + `create policy` pairs (§3).
2. One `comment on function public.auth_is_admin()` (AC-9).
3. One `create or replace function public.admin_db_inspector_probe()` (§4).

**Rollout safety.** Every statement is idempotent and re-runnable to a no-op.
Policy DDL takes an `ACCESS EXCLUSIVE` lock on the target table for the duration
of the statement — on `audit_log` and `ingredient_categories` that is
microseconds, and both tables are low-traffic. There is a sub-millisecond window
between `drop policy` and `create policy` in which the dropped policy does not
exist; because both statements run inside the same transaction (the migration
must be wrapped `begin; … commit;` — mirror
[20260528000000_actor_fk_cascade_audit.sql:52](../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql)),
no concurrent session ever observes the gap. **Wrapping in an explicit
transaction is required, not optional**, precisely because the MCP `execute_sql`
apply path does not guarantee statement-level atomicity across a multi-statement
body.

**Destructive?** No. Every rewritten predicate is a strict superset of its
predecessor (AC-4). No principal loses access. There is no data migration and no
backfill.

**Header + rollback block.** Follow the
[spec-051 migration](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)
shape: a `-- ===` banner, the "what/why", an explicit "Policy DDL ONLY" paragraph
naming what is *not* changed (schema, publication, helpers), an idempotency
paragraph, and an operational `Rollback (no down-migration shipped)` block that
reproduces the seven **pre-change** `create policy` statements verbatim so an
operator can revert by paste. Also state, in the header, that
`auth_is_admin()`'s body is deliberately untouched (AC-5) and why.

## 3. RLS impact — the seven policies, predicate by predicate

Rule for all seven: **replace `public.auth_is_admin()` with
`public.auth_is_privileged()` and change nothing else.** Not `auth_is_admin() OR
auth_is_super_admin()` written out longhand — call the wrapper, matching every
prior parity fix (specs 013, 042, 051) and keeping the lint arm in §7 a clean
`= 0`.

### `public.audit_log` (4 policies)

Source of truth for current text:
[20260504173035_per_store_rls_hardening.sql:160-181](../supabase/migrations/20260504173035_per_store_rls_hardening.sql).

| policy | cmd | current predicate | new predicate |
|---|---|---|---|
| `store_member_read_audit_log` | SELECT | `USING ((store_id is not null and auth_can_see_store(store_id)) or (store_id is null and auth_is_admin()))` | identical, second OR-arm → `auth_is_privileged()` |
| `store_member_insert_audit_log` | INSERT | `WITH CHECK ((store_id is not null and auth_can_see_store(store_id)) or (store_id is null and auth_is_admin()))` | identical, second OR-arm → `auth_is_privileged()` |
| `admin_update_audit_log` | UPDATE | `USING (auth_is_admin()) WITH CHECK (auth_is_admin())` | both → `auth_is_privileged()` |
| `admin_delete_audit_log` | DELETE | `USING (auth_is_admin())` | → `auth_is_privileged()` |

The `store_id is not null` arms delegating to `auth_can_see_store()` are
**byte-unchanged** (AC-3, AC-REG-3). `admin_update_audit_log` /
`admin_delete_audit_log` remain **unscoped by store** — deliberate, per OQ-3.
Add a `comment on policy` to each of those two recording that the missing store
scope is a *known, deferred* gap owned by a future spec, so the next reader does
not mistake it for an oversight this spec introduced.

### `public.ingredient_categories` (3 policies)

Source of truth:
[20260507015244_spec004_ingredient_categories_rls_p6.sql:37-48](../supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql).

| policy | cmd | current | new |
|---|---|---|---|
| `Admins can write ingredient categories` | INSERT | `WITH CHECK (auth_is_admin())` | → `auth_is_privileged()` |
| `Admins can update ingredient categories` | UPDATE | `USING (auth_is_admin()) WITH CHECK (auth_is_admin())` | both → `auth_is_privileged()` |
| `Admins can delete ingredient categories` | DELETE | `USING (auth_is_admin())` | → `auth_is_privileged()` |

Policy **names are kept verbatim**, quoted-identifier spelling and all. Renaming
them to a `privileged_*` family would be cosmetically tidier but would break
AC-REG-1's seven-row diff (each rename shows as a drop + an add) and would
invalidate the spec-053 allowlist's sibling naming context. Not worth it.

The fourth policy on this table — `Authenticated can read ingredient categories`
(SELECT, `using (true) to authenticated`, rewritten by spec 051 and **on the
spec-053 allowlist**) — is **not touched**. AC-8 holds: no new trivially-wide
permissive policy is created, `auth_is_privileged()` is not a trivially-wide
predicate under the spec-053 regex (it is a function call, not
`true` / `auth.uid() is not null` / `auth.role() = 'authenticated'`), and no
allowlist row is added. I re-read
[permissive_policy_lint.test.sql:118-127](../supabase/tests/permissive_policy_lint.test.sql)
to confirm the regex cannot match a bare `auth_is_privileged()` predicate.

### Policies NOT touched — pinned for the reviewer

`recipe_categories` (spec 013, already privileged), all `privileged_*` policies
from 012a, `stores`, `user_stores`, `profiles`, `invitations`,
`user_count_drafts`, `user_count_orders` (deliberately no privileged bypass),
every `store_member_*` policy on other tables, and both `*_categories` SELECT
policies.

### Helper functions — frozen (AC-5, AC-REG-2)

`auth_is_admin()`, `auth_is_super_admin()`, `auth_is_privileged()`,
`auth_can_see_store()`, `auth_can_see_brand()` bodies are not edited. The only
statement in this migration that names `auth_is_admin` at the function level is
the `comment on function` (metadata; `pg_proc.prosrc` is unchanged — a reviewer
can verify with a normalized-md5 of `pg_get_functiondef` before/after).

**`comment on function public.auth_is_admin()` content (AC-9)** — must assert all
four of:
1. narrow tier: JWT `app_metadata.role ∈ {admin, master}` only;
2. `super_admin` is intentionally excluded, because its source of truth is
   `profiles.role` (`auth_is_super_admin()`), not the token;
3. new RLS policies and SECURITY DEFINER guards should gate on
   `public.auth_is_privileged()`;
4. a policy that *deliberately* excludes super_admin must say so in a
   `comment on policy`.
Include the spec number (157) and the fact that the seven leftovers were closed
here, so the next reader can find this spec.

## 4. API contract

**PostgREST vs RPC: both, unchanged from today.** This spec adds no new endpoint.

### (a) The seven policies — PostgREST, no contract change

`ingredient_categories` and `audit_log` continue to be reached by plain
PostgREST table calls through existing `src/lib/db.ts` helpers. Request and
response shapes are byte-identical. What changes is only *which principals get
non-zero row counts*.

Observable delta for a `super_admin` caller:

| call | before | after |
|---|---|---|
| `POST /rest/v1/ingredient_categories` | `401`-class RLS refusal → PostgREST `403` with SQLSTATE `42501` (swallowed by `db.ts`) | `201` / `204`, row persists |
| `PATCH /rest/v1/ingredient_categories?name=eq.X` | `204`, **0 rows affected** | `204`, 1 row affected |
| `DELETE /rest/v1/ingredient_categories?name=eq.X` | `204`, **0 rows affected** | `204`, 1 row affected |
| `POST /rest/v1/audit_log` with `store_id: null` | `403` / `42501` | `201` |
| `PATCH` / `DELETE /rest/v1/audit_log` | `204`, 0 rows | `204`, N rows |
| `GET /rest/v1/audit_log` (store-less rows) | rows absent | rows present |

For `admin` / `master` callers: **no observable change whatsoever.** That is the
AC-4 superset property and it is what the pgTAP regression arms pin.

**Error cases.** Unchanged. An INSERT that fails `WITH CHECK` still raises
`42501` → PostgREST `403`. An UPDATE/DELETE that fails `USING` still returns
zero rows and no error — this is Postgres semantics, not something this spec
changes, and it is exactly the honesty gap OQ-4 defers.

### (b) `public.admin_db_inspector_probe()` — RPC, additive-only

Signature, volatility, `security definer`, `set search_path = public`, entry
guard (`if not public.auth_is_privileged() then raise exception 'admin only'`),
and grants (`revoke … from public, anon` + `grant execute … to authenticated`
per [20260505065303](../supabase/migrations/20260505065303_admin_rpcs_lock_anon.sql))
are **all unchanged**. `create or replace` preserves grants; do not re-issue
them and do not re-issue the revoke.

```
public.admin_db_inspector_probe() returns jsonb
```

**Copy the body verbatim from
[20260517020000_admin_rpcs_use_privileged.sql:14-135](../supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql)
and change exactly one block** — the `'auth'` object — exactly the way
`20260517020000` itself changed exactly one line of `20260505065303`'s body:

```
'auth', jsonb_build_object(
  'is_admin',       public.auth_is_admin(),        -- KEPT (AC-11)
  'is_privileged',  public.auth_is_privileged(),   -- NEW
  'is_super_admin', public.auth_is_super_admin(),  -- NEW
  'app_metadata',   coalesce(auth.jwt() -> 'app_metadata', '{}'::jsonb),
  'user_id',        auth.uid()
)
```

Key **order** inside `jsonb_build_object` is irrelevant to consumers (jsonb
normalizes), but placing the three booleans adjacent reads best. The `schema` /
`counts` / `recipe_groups` / `prep_groups` blocks must be **byte-identical** to
the 20260517020000 body — a reviewer will diff them. Do not "improve" anything
in passing.

**Response shape (TypeScript view of the `auth` object after this change):**

```ts
auth: {
  is_admin: boolean;
  is_privileged?: boolean;    // optional in the TS type — see §8 / AC-15
  is_super_admin?: boolean;   // optional in the TS type
  app_metadata: any;
  user_id: string | null;
}
```

The two new fields are typed **optional on the client** even though the DB
always emits them post-apply. That is deliberate: the web bundle and the DB do
not deploy atomically (same posture as spec 155 AC-18), so a client built after
the merge can hit a DB where the migration has not landed yet. Typing them
required would let the compiler bless a `false` that is really `undefined`.

**Error cases.** Unchanged: non-privileged caller → `raise exception 'admin only'`
→ PostgREST `400` with `message: 'admin only'`, surfaced by the screen's existing
`catch` into the red error `Card` at
[DBInspectorScreen.tsx:175-179](../src/screens/DBInspectorScreen.tsx). Anon
caller → `42501` insufficient privilege from the `revoke`.

## 5. Edge function changes

**None.** Zero files under `supabase/functions/`, and `supabase/config.toml` stays
out of the diff (AC-REG-6). No `verify_jwt` decision is in play. The
`ADMIN_ROLES = {admin, master, super_admin}` mirror rule, the `escapeHtml()`
rule, the `callEdgeFunction` rule, and the last-of-role / self-guard rules are
all N/A — this spec brings the DB *toward* the posture the edge functions
already hold since spec 027.

Cold-start: N/A, no function is invoked.

## 6. `src/lib/db.ts` surface

**No new helpers. No edits. `src/lib/db.ts` is not in the diff.**

This is the deliberate consequence of the OQ-4 ruling. The existing helpers that
start working correctly for `super_admin` — with **no code change** — are:

| helper | line | what changes |
|---|---|---|
| `addIngredientCategory(name, i18nNames?): Promise<void>` | [4059](../src/lib/db.ts) | insert now lands |
| `updateIngredientCategory(oldName, newName, i18nNames?): Promise<void>` | [4071](../src/lib/db.ts) | update now affects 1 row |
| `deleteIngredientCategory(name): Promise<void>` | [4087](../src/lib/db.ts) | delete now affects 1 row |
| `updateIngredientCategoryI18n(name, i18nNames): Promise<void>` | [3529](../src/lib/db.ts) | update now affects 1 row (this one already throws on `error`) |
| `deleteStore(id)` audit cascade | [181](../src/lib/db.ts) | `from('audit_log').delete().eq('store_id', id)` now deletes |
| `cleanupOldRecords()` audit arm | [5831](../src/lib/db.ts) | 90-day purge now deletes |

snake_case → camelCase mapping is unaffected: `fetchIngredientCategories` already
maps `i18n_names` → `i18nNames`
([db.ts:4052-4055](../src/lib/db.ts)) and no column is added.

**The probe RPC call at
[DBInspectorScreen.tsx:134](../src/screens/DBInspectorScreen.tsx)
(`supabase.rpc('admin_db_inspector_probe')`) is a pre-existing carve-out from the
"all DB access through db.ts" rule.** This spec does **not** widen it and does
**not** regularize it. Reviewers: a `supabase.rpc` in this one file is expected;
a *new* `supabase.from(...)` anywhere would be drift.

## 7. Realtime impact

**None — and more strongly than AC-REG-8 states.**

- The migration does not touch `supabase_realtime` publication membership, so
  the `docker restart supabase_realtime_imr-inventory` ritual **does not apply**.
  Per AC-REG-8 it must not be added to any checklist as a defensive no-op. State
  this explicitly in the migration header (matching
  [20260528010000:62-63](../supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql)).
- Additionally: **neither `audit_log` nor `ingredient_categories` is a member of
  the publication at all.** The spec-045 tighten
  ([20260514140000:43-53](../supabase/migrations/20260514140000_realtime_publication_tighten.sql))
  restricted it to ten tables — `inventory_items`, `waste_log`,
  `eod_submissions`, `purchase_orders`, `inventory_counts`, `recipes`,
  `prep_recipes`, `catalog_ingredients`, `vendors`, `ingredient_conversions`
  (plus `item_vendors`, added by spec 100). Neither of this spec's two tables is
  on that list, and
  [useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) contains no reference to
  either.
- **Consequence for the frontend:** neither the `store-{id}` nor the
  `brand-{id}` channel will replay a category write. `CategoriesSection` must
  keep relying on its existing optimistic update + explicit refetch. There is no
  "it'll sync itself" path here and nobody should add one in this spec.

## 8. Frontend design — `DBInspectorScreen` banner

### Store impact

**None.** No slice of [src/store/useStore.ts](../src/store/useStore.ts) changes.
`DBInspectorScreen` holds the probe in local `useState` and reads only
`recipes` / `prepRecipes` from the store for the cache-vs-DB delta lines. The
optimistic-then-revert + `notifyBackendError` pattern **does not apply** — this
is a read-only diagnostic with no write path in the banner.

### `Probe` type change

[DBInspectorScreen.tsx:70-84](../src/screens/DBInspectorScreen.tsx) — extend only
the `auth` member, per the shape in §4(b). `is_privileged` and `is_super_admin`
are **optional** (`?: boolean`). Nothing else in `Probe` changes.

### Banner state machine — export a pure classifier

The banner logic must be extracted into a **pure, exported function** in the
same file, so the jest suite (AC-17) can assert all four probe shapes without
rendering the screen (which would require mocking `supabase`, `useStore`,
`useColors`, `@react-navigation/native`, `TimezoneBar` and `Card`/`EmptyState`).
This is the same testability shape as `describeSchema()` already in the file at
[line 102](../src/screens/DBInspectorScreen.tsx) — an existing in-file
precedent, not a new pattern.

```ts
export type AuthBannerState =
  | 'privileged-jwt'          // is_privileged && is_admin      → affirmative
  | 'privileged-super-admin'  // is_privileged && !is_admin      → affirmative
  | 'not-privileged'          // is_privileged === false         → "impossible state"
  | 'unknown';                // field absent / not a boolean    → neutral

export function classifyAuthBanner(auth: Probe['auth'] | null | undefined): AuthBannerState;
```

Classification rules, in order (the order matters — AC-15 before AC-13):

1. `auth` is null/undefined → `'unknown'`.
2. `typeof auth.is_privileged !== 'boolean'` → `'unknown'`. **This is the
   deploy-skew arm (AC-15).** An old deployed function emits `is_admin` but not
   `is_privileged`; we must not read `undefined` as `false` and render the alarm,
   and we must not read `is_admin === true` as a green either. Neutral.
3. `auth.is_privileged === false` → `'not-privileged'`.
4. `auth.is_admin === true` → `'privileged-jwt'`.
5. otherwise → `'privileged-super-admin'`.

Note rule 5 keys off `is_privileged && !is_admin` rather than off
`is_super_admin`. `is_super_admin` is used for *copy detail*, not for the
branch — that keeps the classifier total even if the two new fields ever
disagree, and means a hypothetical future privileged tier still lands in an
affirmative state rather than falling through to alarm.

### Copy — export it as a map

Also export the copy so the jest suite can assert AC-12's negative string
constraints without a render:

```ts
export const AUTH_BANNER_COPY: Record<AuthBannerState, {
  tone: 'ok' | 'warn' | 'unknown';
  icon: string;      // Ionicons name
  title: string;
  detail?: string;
}>;
```

Content requirements (exact wording is the implementer's — these are the
constraints, per AC-12/AC-13):

- **`privileged-jwt`** — tone `ok`, `shield-checkmark`, green. Keep today's
  meaning ("you are admin — writes are authorized"). An `admin`/`master` must see
  the same affirmative state they see today (AC-10).
- **`privileged-super-admin`** — tone `ok`, `shield-checkmark`, green.
  Reassurance, not alarm. Must convey: you are `super_admin`; writes are
  authorized; token-only checks report `is_admin: false`, which is **expected**
  because super_admin is read from your profile row (`profiles.role`), not your
  token. Do not use `C.danger` or `C.warning` anywhere in this branch.
- **`not-privileged`** — tone `warn`. Must be framed as *"this state should not
  be reachable — the probe's own entry guard is `auth_is_privileged()`, so if you
  are reading this, something is inconsistent"* (AC-13). It must **not** read as a
  routine diagnosis.
- **`unknown`** — tone `unknown`, neutral color (`C.textSecondary`), a neutral
  icon (e.g. `help-circle`). Must convey: this build is newer than the deployed
  `admin_db_inspector_probe()`; the privilege fields are missing, so no claim is
  made either way. **Must not be green and must not be red.**

**Hard string constraints across all four (AC-12):**
- The literal `ALL your CRUD` must not appear anywhere in the file.
- `auth_is_admin()` must not be cited as the gate for brand-catalog writes — that
  stopped being true at spec 012a. If the string `auth_is_admin` appears at all,
  it may only appear in the `privileged-super-admin` copy as an explanation of
  why the *token check* reports false.
- The string `You are NOT admin per the JWT` must not appear in any branch
  reachable by a privileged caller. (Simplest and safest: delete it outright.)

### Render change

Replace the `probe.auth.is_admin ? … : …` ternary at
[lines 186-201](../src/screens/DBInspectorScreen.tsx) with a lookup:
`const banner = AUTH_BANNER_COPY[classifyAuthBanner(probe.auth)]`, then render
icon/title/detail from it. The two `kvLine` rows below
(`app_metadata:` / `user_id:`) stay verbatim. Consider adding a third `kvLine`
echoing `is_admin / is_privileged / is_super_admin` raw values — useful for the
next diagnosis and consistent with the screen's existing raw-values style;
optional, at the implementer's discretion.

### i18n and styling

- **No i18n** (AC-14). Hardcoded English, no `useT`, no key in
  `src/i18n/*.json`, no staff catalog change.
- **No restyle.** The screen stays on the legacy `useColors()` palette. Do not
  introduce `useCmdColors()` here.

## 9. Test design

### pgTAP — `supabase/tests/super_admin_policy_parity.test.sql` (new, primary track)

Hermetic `begin; … rollback;`. Model on
[recipe_categories_super_admin_rls.test.sql](../supabase/tests/recipe_categories_super_admin_rls.test.sql)
— reuse its fixture trick verbatim: promote the seeded master
`33333333-3333-3333-3333-333333333333` to `role='super_admin', brand_id=null`
inside the txn (the `profiles_role_brand_consistent` CHECK requires the NULL
brand), and impersonate with `app_metadata.role='user'` so the passing path is
**provably** `auth_is_super_admin()` and not the JWT.

Seed principals: admin `1111…1111`, plain user `2222…2222` (role `user`),
master/super_admin `3333…3333`.

Arms:

| # | ctx | assertion |
|---|---|---|
| F-1 | — | fixture: master promoted to `super_admin` in this txn |
| IC-1 | super_admin (JWT role=`user`) | INSERT into `ingredient_categories` succeeds |
| IC-2 | super_admin | UPDATE (rename) affects the row |
| IC-3 | super_admin | DELETE removes the row |
| IC-4 | plain user | INSERT `throws_ok(… , '42501', …)` |
| IC-5 | plain user | UPDATE affects **0** rows |
| IC-6 | plain user | DELETE affects **0** rows |
| IC-7 | admin JWT | INSERT succeeds (AC-4 regression) |
| IC-8 | master JWT | INSERT succeeds (AC-4 regression) |
| AL-1 | super_admin | INSERT `audit_log` row with `store_id IS NULL` succeeds |
| AL-2 | super_admin | SELECT sees that store-less row (count = 1) |
| AL-3 | plain user | INSERT store-less row `throws_ok('42501')` |
| AL-4 | plain user | SELECT of a store-less row returns 0 |
| AL-5 | super_admin | UPDATE of a **store-scoped** fixture row affects 1 |
| AL-6 | super_admin | DELETE of a **store-scoped** fixture row affects 1 |
| AL-7 | plain user | UPDATE of that same row affects **0** |
| AL-8 | plain user | DELETE of that same row affects **0** |
| AL-9 | admin JWT | UPDATE affects 1 (AC-4 regression) |
| AL-10 | master JWT | DELETE affects 1 (AC-4 regression) |
| LINT-1 | superuser (`reset role`) | `= 0` policies in `public.*` whose `qual` or `with_check` names `auth_is_admin` |

**Design notes the implementer must not skip:**

- **AL-7 / AL-8 must use a store-scoped row that the plain user genuinely CAN
  see** (a `store_id` for which user `2222…` has a `user_stores` grant in the
  seed). If you use a store-less row, the user fails the SELECT arm too and the
  test proves nothing about the UPDATE/DELETE policy — it would pass even if the
  fix were wrong. This is the sharpest arm in the suite; get it right.
- Insert `audit_log` fixture rows while at superuser (`reset role`) **before**
  switching to `authenticated`, so RLS is bypassed for setup. `audit_log`
  columns: `id, store_id, user_id, action (not null), detail, item_ref, value,
  created_at` ([init_schema:196-205](../supabase/migrations/20260405000759_init_schema.sql));
  `user_id` FKs `profiles(id)` `on delete set null`
  ([20260528000000](../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql)) —
  use a seeded profile id or NULL.
- Row-count assertions: use `get diagnostics` inside a `do $$` block stashed via
  `set_config`, or a `select count(*)` before/after — **do not** use
  `savepoint` + `rollback to savepoint` around a pgTAP `is()`; that discards the
  assertion from pgTAP's temp-table counters and trips
  `scripts/test-db.sh`'s "planned N but ran M" detector. See
  [permissive_policy_lint.test.sql:203-213](../supabase/tests/permissive_policy_lint.test.sql)
  for the drop-then-assert precedent.
- **LINT-1 scans `pg_policies` ONLY** — never `pg_proc` / `pg_get_functiondef`.
  `auth_can_see_store()` and `auth_is_privileged()` legitimately name
  `auth_is_admin` in their bodies and the probe RPC emits it in its payload; a
  function-body scan would false-fail. The failure message must `string_agg` the
  offending `schema.table / policy` triples (spec-053 arm-2 style) and must say:
  *"an eighth bare-`auth_is_admin()` policy has appeared — see spec 157; widen it
  to `auth_is_privileged()` or state the deliberate exclusion in a
  `comment on policy` and add it to this arm's exception list."*
- `plan(N)` must equal the number of `is`/`throws_ok`/`lives_ok` calls actually
  executed — 20 with the arms above. `scripts/test-db.sh` hard-fails on a
  mismatch.
- Test-data names must be collision-proof against the 286 KB prod-derived seed:
  use the `__test_spec157_*` prefix (mirroring `__test_spec013_*`).

### pgTAP — existing suites (AC-REG-4)

`recipe_categories_super_admin_rls`, `legacy_permissive_policy_dropout`,
`permissive_policy_lint`, `rls_hardening_followups`, `admin_rpcs_privileged`,
`actor_fk_cascade_audit`, `missed_order_audit_rpc` must stay green
**unmodified**. Note `admin_rpcs_privileged.test.sql` calls
`admin_db_inspector_probe()` via `lives_ok` and asserts nothing about the payload
shape, so the additive `auth` keys cannot break it — verified by reading it.

### jest — `src/screens/__tests__/DBInspectorScreen.test.tsx` (new)

Lands in the **`component`** project (`testEnvironment: 'jsdom'`), matched by
`<rootDir>/src/screens/**/*.test.tsx`
([jest.config.js:109-111](../jest.config.js)). It imports a `.tsx`, so it cannot
go in the fast node project.

Because the suite targets the exported `classifyAuthBanner()` +
`AUTH_BANNER_COPY` rather than a render, mocking is minimal — but importing the
module still pulls `react-native`, `@expo/vector-icons`,
`@react-navigation/native`, `../lib/supabase`, `../store/useStore`,
`../theme/colors` and `../components`. Mock those at the module boundary the way
[RecipeCategoriesSection.test.tsx:37-62](../src/screens/cmd/sections/__tests__/RecipeCategoriesSection.test.tsx)
does. If the import chain proves noisy, the acceptable fallback is to move the
classifier + copy map into a sibling `src/screens/dbInspectorBanner.ts` and
import it from the screen — but **prefer keeping it in the screen file**; a
one-function module is a worse tradeoff than four `jest.mock` lines.

Arms (AC-17):

| # | input | assert |
|---|---|---|
| 1 | `{ is_privileged: true, is_admin: true }` | `'privileged-jwt'`; copy tone `ok` |
| 2 | `{ is_privileged: true, is_admin: false, is_super_admin: true }` | `'privileged-super-admin'`; tone `ok`; copy contains **no** `NOT admin per the JWT` and **no** `ALL your CRUD` |
| 3 | `{ is_privileged: false, is_admin: false }` | `'not-privileged'`; copy conveys the AC-13 "should not have returned" framing |
| 4 | `{ is_admin: true }` (new fields **absent**) | `'unknown'`; tone is neither `ok` nor an alarm — no false green (AC-15) |
| 5 | `null` / `undefined` | `'unknown'` (total-function guard) |
| 6 | whole-file assertion | the literal `ALL your CRUD` appears in **no** entry of `AUTH_BANNER_COPY` |

Arm 4 is the one that actually earns its keep — it is the deploy-skew arm and
the easiest to accidentally regress by writing `auth.is_privileged ? … : …`.

### Shell smoke (AC-18)

Deliberately not exercised — no service-token or key-dependent surface is added.
Say so explicitly in the PR body rather than leaving it ambiguous.

### Typecheck (AC-19)

Both `test.yml` typecheck jobs must pass, including `typecheck:test` — jest alone
does not cover it, and the new optional `?: boolean` fields plus the exported
`AuthBannerState` union are exactly the kind of change that passes jest and fails
`typecheck:test`.

## 10. Deploy / apply sequence

1. Merge the PR. **`db-migrations-applied.yml` goes red immediately** — the
   migration is in the repo and not in prod's `schema_migrations`. This is the
   known window; surface the run URL in the PR body per the CLAUDE.md CI rule and
   do **not** treat it as drift.
2. Apply to prod via the house MCP flow (project `ebwnovzzkwhsdxkpyjka`):
   `execute_sql` the migration body (wrapped `begin; … commit;`), then insert the
   exact version string `20260809000000` into
   `supabase_migrations.schema_migrations`, then verify the two touched functions
   (`auth_is_admin` unchanged, `admin_db_inspector_probe` replaced) with
   normalized-md5 of `pg_get_functiondef`.
3. Re-run query (a) from D-0. Expected: **zero rows**.
4. Re-check **both** gates on `main` — `test.yml` and
   `db-migrations-applied.yml`. Note the CLI is pinned to `2.108.0` for the
   migration gate (v2.109.0's TS port breaks the table parse and produces a false
   "missing from prod"); a red gate is not automatically drift — diff repo
   migrations against `schema_migrations` first.
5. Redeploy the web bundle (Vercel). Order does not matter for correctness
   because of the AC-15 `unknown` state, but DB-first means users never see the
   neutral banner. Note that Vercel ships at merge, not on an operator's
   schedule — so in the merge→prod-apply window the deployed banner shows the
   neutral `unknown` state *and* the seven-policy RLS bug is still live on prod;
   do not run the step-6 smoke until step 2 has completed.
6. Owner smoke: sign in as `super_admin`, add / rename / delete an ingredient
   category in the Categories section, confirm it survives a refresh; open DB
   Inspector and confirm the green affirmative banner.

## 11. Risks and tradeoffs

**Critical-class**

- **R-1 — the prod re-verify was not done by me (§0).** Everything here is
  conditional on D-0. If prod carries an eighth policy or a dashboard-edited
  function body, AC-REG-1's seven-row assertion is wrong and the "complete blast
  radius" claim is wrong. **Mitigation: D-0 is a blocking gate with explicit
  stop-and-escalate conditions.** Do not skip it because the repo grep agrees
  with the spec — the repo is not prod, and that is the entire premise of the
  incident this spec was written from.

**Should-fix-class**

- **R-2 — `admin_update_audit_log` / `admin_delete_audit_log` gain a
  cross-brand principal.** After this change, a `super_admin` can update or
  delete any audit row across every brand — the same unscoped reach an `admin`
  already has today. Since `super_admin` is by definition the top tier and
  `auth_can_see_store()` already short-circuits true for them, this grants no
  *net new* visibility. But it does mean the pre-existing OQ-3 gap now has two
  principal classes instead of one. **Accepted; flagged in the `comment on
  policy`; owned by the deferred OQ-3 spec.**
- **R-3 — migration-ordering / non-atomic apply.** The migration mixes policy DDL
  with a `create or replace function`. If the MCP `execute_sql` path applies
  statements individually and fails midway, the DB is left with some policies
  widened and the probe not replaced (or vice versa). Neither half is destructive
  and re-running converges, but the DB would be inconsistent with
  `schema_migrations` if the version row was already inserted. **Mitigation:
  explicit `begin; … commit;` wrapper (§2), and insert the `schema_migrations`
  row only after the body commits.**
- **R-4 — jest suite scope creep.** AC-17's "no red 'NOT admin' string" is easy
  to satisfy by asserting on a rendered tree, which drags the whole
  `DBInspectorScreen` import chain (supabase client, Zustand store, navigation)
  into jsdom. The exported-classifier design (§8) is specifically to avoid that.
  If the implementer renders instead, expect flaky mock churn and a slow suite.

**Minor**

- **R-5 — per-row cost of `auth_is_super_admin()` on the retention purge.**
  `auth_is_privileged()` is `auth_is_admin() OR auth_is_super_admin()`;
  `auth_is_super_admin()` is `stable security definer` and does a PK-equality
  lookup on `profiles`. Postgres short-circuits the OR, so **`admin`/`master`
  callers pay literally nothing new**. A `super_admin` running
  `cleanupOldRecords`' global `delete from audit_log where created_at < cutoff`
  pays one cached PK probe per candidate row. On the 286 KB seed this is
  unmeasurable. On a prod `audit_log` of unknown size it is worth a sanity
  `select count(*) from audit_log` during the D-0 pass — if it is in the millions,
  note it, but do not pre-optimize (the correct fix would be OQ-3's retention
  redesign, not a policy hack).
- **R-6 — no CI coverage of the copy constraints beyond jest.** The "must not
  contain `ALL your CRUD`" rule is enforced by one jest arm. A future edit that
  reintroduces alarmist copy in a *new* branch would not be caught. Accepted;
  the arm-6 whole-map assertion is the cheap mitigation.
- **R-7 — `auth_is_admin()` comment is metadata only.** AC-9's rule lives in
  `pg_description`, which nobody reads unless they run `\df+`. That is why OQ-5
  also drafts the CLAUDE.md bullet — the comment is the in-database backstop, not
  the primary channel.

## 12. Deliberate exclusions — flagged for future specs

Recorded here so `release-coordinator` and the reviewer fan-out can see these
were *decided*, not *missed*:

- **FUTURE-1 — `audit_log` UPDATE/DELETE store/brand scoping (OQ-3).**
  `admin_update_audit_log` and `admin_delete_audit_log` have no store or brand
  scope. Any privileged caller can mutate any audit row in any brand. Fixing this
  requires co-designing `cleanupOldRecords`' retention purge (currently a global
  unfiltered delete) and deciding who may purge `store_id IS NULL` rows. Own
  spec, own ACs. **Not this diff.**
- **FUTURE-2 — honest error surfacing in `db.ts`'s category writers (OQ-4).**
  `addIngredientCategory` / `updateIngredientCategory` /
  `deleteIngredientCategory` ([db.ts:4059-4095](../src/lib/db.ts)) do not
  destructure `error`, so a `42501` INSERT refusal resolves as success. (Note:
  `updateIngredientCategoryI18n` at [3529](../src/lib/db.ts) already *does*
  throw — the spec's table is imprecise here; see §0.) Fixing RLS removes the
  denial for the affected principal but leaves the ghost-write class of bug
  intact for the next principal. Changing it alters optimistic-then-revert
  semantics at every call site and needs its own jest pins. **Not this diff.**
- **FUTURE-3 — the zero-row-write blind spot generally.** FUTURE-2's narrow form
  is one instance of a repo-wide pattern: PostgREST `204` on an RLS-shadowed
  UPDATE/DELETE is indistinguishable from success everywhere in `db.ts`. A
  systematic answer (e.g. `.select()` on writes to force a row count, or a
  `trackWrite` wrapper that asserts affected-rows > 0) is a real architectural
  question and deserves a real spec. Mentioning it because this incident is the
  second time it has cost the owner an afternoon.

## 13. Files to change (refined from the spec's list)

| file | who | change |
|---|---|---|
| `supabase/migrations/20260809000000_super_admin_policy_parity.sql` | backend-developer | **new** — 7 policy rewrites + 2 `comment on policy` + 1 `comment on function` + 1 `create or replace function admin_db_inspector_probe()`; `begin;…commit;` wrapped; spec-051-shaped header + rollback block |
| `supabase/tests/super_admin_policy_parity.test.sql` | backend-developer | **new** — 20-arm pgTAP suite per §9 |
| `src/screens/DBInspectorScreen.tsx` | frontend-developer | `Probe['auth']` + exported `AuthBannerState` / `classifyAuthBanner()` / `AUTH_BANNER_COPY`; banner render swapped to the lookup |
| `src/screens/__tests__/DBInspectorScreen.test.tsx` | frontend-developer | **new** — 6-arm jest suite per §9 |
| `specs/157-super-admin-rls-parity.md` | both | `Status:` → `READY_FOR_REVIEW`; `## Files changed` appended |

**Confirmed out of the diff** (a reviewer should treat any of these appearing as
drift): `src/lib/db.ts`, `src/store/useStore.ts`, `src/screens/staff/**`,
`src/i18n/*`, `supabase/functions/**`, `supabase/config.toml`, `app.json`
(slug stays `towson-inventory`), `vercel.json`,
`supabase/tests/permissive_policy_lint.test.sql`, `CLAUDE.md`, and any
`.github/workflows/*`.

**PR body must additionally contain:** the D-0 query results (both), the drafted
CLAUDE.md bullet from OQ-5 for the owner to accept or decline, the AC-18
"no shell smoke, and here is why" statement, and the known
`db-migrations-applied.yml` red window with its run URL.

---

## Files changed

Backend half by `backend-developer`, frontend half by `frontend-developer`
(both 2026-08-09). The full staged diff is exactly five files: the two
backend artifacts below, the two frontend artifacts (§ "Frontend"), and this
spec file.

### Migrations

- `supabase/migrations/20260809000000_super_admin_policy_parity.sql` — **new.**
  `begin; … commit;` wrapped (§2 / R-3: the MCP `execute_sql` apply path does not
  guarantee statement-level atomicity across a multi-statement body). Contains:
  - 7 × (`drop policy if exists` + `create policy`) swapping
    `public.auth_is_admin()` → `public.auth_is_privileged()` and changing nothing
    else. Policy names, `permissive` kind, `to` role lists (`{public}` on all
    seven) and the `store_id IS NOT NULL AND auth_can_see_store(store_id)`
    OR-arms are byte-preserved. `audit_log` ×4, `ingredient_categories` ×3.
  - 4 × `comment on policy` on the `audit_log` policies, two of which record the
    OQ-3 / FUTURE-1 deferred store-scope gap in `pg_policies`-visible metadata.
  - 1 × `comment on function public.auth_is_admin()` (AC-9) asserting all four
    required clauses + the `user_count_drafts` / `user_count_orders`
    deliberate-exclusion counter-example from the OQ-5 ruling. **Metadata only —
    `pg_proc.prosrc` for `auth_is_admin()` is unchanged (AC-5 / AC-REG-2),
    verified post-apply.**
  - 1 × `create or replace function public.admin_db_inspector_probe()` — body
    copied verbatim from `20260517020000_admin_rpcs_use_privileged.sql:14-135`,
    the ONLY delta being two additive keys in the `auth` object
    (`is_privileged`, `is_super_admin`). Signature, `security definer`,
    `set search_path`, the `auth_is_privileged()` entry guard, and the
    `schema` / `counts` / `recipe_groups` / `prep_groups` blocks are unchanged;
    grants are preserved by `create or replace` and are not re-issued.
  - Spec-051-shaped header with the "Policy DDL only", "no realtime publication
    change", idempotency and operational-rollback blocks (the seven pre-change
    `create policy` statements reproduced verbatim for paste-revert).

### Tests (pgTAP track)

- `supabase/tests/super_admin_policy_parity.test.sql` — **new.** 20 arms,
  hermetic `begin; … rollback;`, `plan(20)`, `__test_spec157_*` fixture prefix.
  F-1 / IC-1…IC-8 / AL-1…AL-10 / LINT-1 exactly per §9. LINT-1 scans
  `pg_policies` predicates **only** (never `pg_proc`) and `string_agg`s offending
  `schema.table / policy (cmd)` triples into the failure message.

### Frontend

- `src/screens/DBInspectorScreen.tsx` — exported `ProbeAuth` type (optional
  `is_privileged` / `is_super_admin` for deploy skew), pure exported
  `classifyAuthBanner()` (five ordered rules, absence-check BEFORE false-check
  so a stale probe degrades to `unknown`), `AUTH_BANNER_COPY` map (Ionicons-name
  union for `icon`); banner render swapped to the lookup; the banned strings
  ("You are NOT admin per the JWT", "ALL your CRUD") deleted.
- `src/screens/__tests__/DBInspectorScreen.test.tsx` — **new.** 10 jest arms
  covering all five classifier states, the deploy-skew absence≠false arm, and
  the AC-17 whole-map banned-string assertion.

### Not changed (confirmed absent from the diff)

`src/**` other than the two files above (incl. `src/lib/db.ts` per the OQ-4
ruling, `src/store/useStore.ts`,
`src/screens/staff/**`, `src/i18n/*`), `supabase/functions/**`,
`supabase/config.toml`, `supabase/tests/permissive_policy_lint.test.sql`
(AC-8 — no allowlist row added), `app.json` (slug stays `towson-inventory`),
`vercel.json`, `CLAUDE.md`, `.github/workflows/*`.

### Verification performed (local only — NO prod apply)

- `npx supabase migration up --local` → applied clean as migration #129.
- Post-apply `pg_policies`: all seven rewritten to `auth_is_privileged()`;
  **0** policies in `public.*` still naming `auth_is_admin`; the untouched
  `"Authenticated can read ingredient categories"` SELECT policy still reads
  `to authenticated using (true)`.
- `auth_is_admin()` `prosrc` byte-identical post-apply (AC-5).
- Probe RPC live-checked in both directions: an `admin` JWT returns
  `{is_admin: true, is_privileged: true, is_super_admin: false}`; a `super_admin`
  (JWT `app_metadata.role='user'`) returns
  `{is_admin: false, is_privileged: true, is_super_admin: true}` — i.e. exactly
  the shape the AC-12 honest banner needs. Top-level payload keys unchanged
  (`auth`, `schema`, `counts`, `recipe_groups`, `prep_groups`).
- **Idempotency (AC-6):** the migration body was re-applied a second time via
  `psql` → succeeded, policy state unchanged, suite still 20/20.
- **Negative controls** (the suite was proven to actually fail without the fix,
  by reverting policies inside the hermetic txn):
  - all four `audit_log` policies reverted → AL-1, AL-2, AL-5, AL-6 fail;
    the plain-user and admin/master regression arms correctly stay green;
    LINT-1 fails and names all four offenders.
  - `ingredient_categories` UPDATE + DELETE reverted → IC-2 **and** IC-3 fail.
  - `ingredient_categories` DELETE only reverted → IC-3 fails alone.
  - full revert → the bare IC-1 insert raises `42501` and aborts the run.
  - This round caught and fixed a real false-pass: IC-3 originally deleted only
    the post-rename name, so it passed trivially whenever IC-2's rename had been
    denied. It now targets `name in (pre, post)` and asserts on both.
- Gates: `npm run test:db` **81/81 files** (incl. all seven AC-REG-4 suites and
  `permissive_policy_lint` unmodified) · `npx jest` **202 suites / 2203 tests** ·
  `npx tsc --noEmit` clean · `npm run typecheck:test` clean.

### Still owed before this can ship

1. ~~The prod half of D-0~~ — **DONE** by the dispatcher via Supabase MCP; see
   the D-0 prod execution record below. Gate SATISFIED.
2. **The prod apply** (AC-7 / §10 step 2) — deliberately not performed;
   happens after the user's commit + push, per §10 ordering.
3. ~~The frontend half~~ — **DONE** by `frontend-developer` (see § "Frontend").
4. **The OQ-5 CLAUDE.md bullet** — drafted in the spec, for the owner to accept
   or decline in the PR. Agents do not edit CLAUDE.md unilaterally.

### D-0 prod execution record (run by dispatcher via Supabase MCP, 2026-08-09)

Run against project `ebwnovzzkwhsdxkpyjka` (prod), corrected query (b) with `p.prokind = 'f'`:

- **Query (a) — 7 rows exactly, matching §3's table**: audit_log {admin_delete_audit_log DELETE, admin_update_audit_log UPDATE, store_member_insert_audit_log INSERT, store_member_read_audit_log SELECT}; ingredient_categories {"Admins can delete/update/write ingredient categories" DELETE/UPDATE/INSERT}. No eighth prod-only policy → AC-REG-1's seven-row claim holds on prod.
- **Query (b) — 4 rows**: admin_db_inspector_probe, auth_can_see_store, auth_is_admin (self), auth_is_privileged. Matches the corrected expectation; none is a gate.
- **Gate-only probe (`~* 'not\s+public\.auth_is_admin\s*\(\s*\)'`) — 0 rows.**
- **R-5 context**: `public.audit_log` count on prod = 4,485.

D-0 gate: **SATISFIED** — prod apply may proceed post-review per §10.
