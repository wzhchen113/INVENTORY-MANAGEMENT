# Security audit for spec 159 — Dashboard scope picker

Auditor pass, 2026-08-16. Scope: the staged diff (`git diff --cached`), 13 files.
Threat model applied: multi-tenant per-store RLS (`auth_can_see_store()`), admin-only
surface (`auth_is_admin()`), sibling apps (staff / customer PWA) hitting the same
Supabase project as untrusted callers.

**Verdict: no Critical, no High. Nothing here blocks the spec.**

Everything below is Low. The four questions I was asked to scrutinize all resolve in the
implementation's favour, and I verified each one independently against the live database
rather than accepting the architect's or developer's reasoning.

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/lib/db.ts:856-859` — **`fetchWasteLogForStores` degrades a transport/session
  failure into a legitimate-looking `$0` WASTE / WK tile.** On any PostgREST error the
  helper `console.warn`s and returns `[]`; `DashboardSection.tsx:315-319` adds a second
  `.catch(console.warn)`. Neither path raises `sessionLost` (that flag is only set from
  `useStore.ts:1887` inside `loadFromSupabase`'s `hasActiveSession()` probe, which these
  five mount-time reads bypass entirely). A dead/expired token therefore renders the
  WASTE tile as a confident `$0` rather than an error state.
  **This is NOT an authorization-masking bug** — see the analysis section below; RLS
  denials are silent row filters, not errors, so there is nothing for this branch to
  swallow. The failure direction is under-report, i.e. fail-closed.
  **Pre-existing, not a regression:** all four siblings
  (`fetchEodSubmissionsForStores` `db.ts:1176`, `fetchPosImportsForStores`,
  `fetchOrderScheduleForStores`, `fetchOrderSubmissionsForStores`) have byte-identical
  warn-and-return-`[]` posture, and the architect locked it deliberately (§3: "Do not
  call `notifyBackendError`"). Spec Risk R6 anticipated exactly this and the
  implementation honours it. *Fix (follow-up, not this spec):* distinguish "loaded, empty"
  from "failed to load" in the five cross-store reads and render an em-dash instead of a
  zero. Filing it against this spec's helper alone would just create asymmetry.

- `src/lib/db.ts:851` — **Data minimization: the aggregate read pulls `notes` and
  `logged_by` it never uses.** The only consumer is the `quantity × costPerUnit` sum
  (`DashboardSection.tsx:393-405`), yet the select pulls free-text `notes` and the actor
  UUID for every waste row across every visible store into client memory. The architect
  explicitly stripped the `profiles` and `catalog_ingredients` embeds for exactly this
  reason (§2) but left these two scalar columns. No exposure path exists today (the rows
  are all RLS-visible to the caller, and nothing logs or transmits them — `console.warn`
  emits only `error.message`), so this is hygiene, not a leak. *Fix:* drop `notes` and
  `logged_by` from the select list and map `notes: ''` / `loggedByUserId: ''` the same
  way `itemName` and `loggedBy` are already sparse-filled.

- `src/lib/db.ts:848-854` — **No `.limit()` on the fan-out; bounded only by the 14-day
  cutoff.** Spec Risk R5 required a date cutoff instead of a full-table read, and the
  implementation supplies one (`.gte('logged_at', sinceISO)`), covered by the existing
  `idx_waste_log_store_logged_at (store_id, logged_at)` index. A brand with many stores
  and heavy waste logging still returns an unbounded row count. Consistent with all four
  siblings (none carry a `.limit()`), authenticated-admin-only, and self-inflicted.
  Informational — no change requested.

---

## The four questions, answered against the live database

### 1. Is the `.in('store_id', …)` fan-out with no server-side pre-filter safe? — **Yes. Verified independently, not inherited.**

I re-derived the policy chain from the migrations and then confirmed it against the
running local stack rather than trusting the architect's table or the developer's
`Verification` note.

Live `pg_policies` / `pg_class` state for `public.waste_log`:

```
relrowsecurity = t
store_member_read_waste_log   PERMISSIVE  SELECT  auth_can_see_store(store_id)
store_member_insert_waste_log PERMISSIVE  INSERT  (with check) auth_can_see_store(store_id)
store_member_update_waste_log PERMISSIVE  UPDATE  auth_can_see_store(store_id)
store_member_delete_waste_log PERMISSIVE  DELETE  auth_can_see_store(store_id)
```

Exactly **one** permissive SELECT policy, no trivially-wide OR-tail, no
`USING (true)`, no `auth.uid() IS NOT NULL` survivor. The two historical wide policies
are genuinely gone: `"Store access"` (init `20260405000759_init_schema.sql:275`) dropped
at `20260502071736_remote_schema.sql:41`, and `auth_manage_waste_log` dropped at
`20260504173035_per_store_rls_hardening.sql:135`. This matters because of the
CLAUDE.md ORed-permissive-policies rule — a single surviving wide policy would have
neutralized the scoped one. None survives.

Then the behavioural proof, run as the non-privileged local manager
(`22222222-…`, `profiles.role = 'user'`, grants: Towson + Frederick), inside a
transaction that was rolled back (nothing persisted; `waste_log` re-confirmed at 0 rows
afterwards, and `git status` shows no working-tree modification):

```
is_admin | is_super | towson_granted | charles_not_granted
---------+----------+----------------+--------------------
 f       | f        | t              | f
```

and the exact wire shape of `fetchWasteLogForStores(['towson','charles'], …)`:

```sql
select reason, store_id from public.waste_log
 where store_id in ('<towson>','<charles>')
   and logged_at >= now() - interval '14 days';
--    reason    | store_id
-- probe-towson | 00000000-...-000000000001      ← 1 row. Charles silently dropped.
```

The unauthorized store's row is filtered, not errored — which is the structural
guarantee, not a coincidence: Postgres RLS composes the policy `USING` clause into the
query's `WHERE`, so a denied row is an absent row. There is no code path by which a
denial becomes an exception for the `[]`-degrade branch to swallow.

`auth_can_see_store()` itself (`20260517040000_auth_can_see_store_brand_scope.sql:88-108`)
is the three-arm helper the rest of the app uses — super-admin, or admin/master within
`auth_can_see_brand(store.brand_id)`, or `user_stores` membership. Cross-brand admins are
correctly excluded by arm 2.

**Sibling comparison (asked for explicitly):** the four pre-existing loaders share the
identical posture and the identical gate — `eod_submissions` SELECT is
`auth_can_see_store(store_id)` at `20260504173035_per_store_rls_hardening.sql:66-68`.
Since I found no problem in the new one, there is nothing to propagate. The new helper is
neither a regression nor a new standing issue; it is the fifth instance of a pattern that
is sound.

One additional check the design did not make, which closes the last gap in the
"client list is only a rendering rule" argument: `public.stores` SELECT is
`store_member_read_stores USING (auth_can_see_store(id))` — the **same predicate**. So
the client's `stores` slice, and therefore `visibleStores`, and therefore
`scopedStoreIds`, is by construction a subset of the stores whose `waste_log` rows RLS
will return. A partial-denial silent under-report is not reachable in normal operation;
in a grant-revocation race RLS still wins and the result fails closed.

**Answer to "can the `[]` degrade mask an authorization failure in a way that misleads
the user":** it cannot mask an authorization failure (there is no error to mask). It can
mask a transport/session failure as `$0` — recorded as the first Low above, pre-existing
and shared by all four siblings.

### 2. Did any store enumeration escape `visibleStoresFor(...)`? — **No. AC-V is met, including the mount-time fetch id list.**

I grepped every `stores` reference in the post-change file rather than reading the diff
hunks. Raw-`stores`-slice survivors, and why each is correct:

| `DashboardSection.tsx` | Use | Verdict |
|---|---|---|
| `:155` | `const stores = useStore(...)` | the input to `visibleStoresFor` at `:210-213` |
| `:561`, `:601` | `stores` **argument** into `computeTopVarianceItems` / `computeAttentionQueue` | name lookup only (`cmdSelectors.ts:519`, `:369`); the **iteration** is `scopeStoreIds` / `scopedStores`, so only visible stores' names can ever be resolved. Narrowing this argument would blank names, not tighten access — the design called this out and the code honours it. |
| `:1290` | `users.find(u => … u.stores.includes(store.id))` (manager name on a store card) | pre-existing; the card itself now renders only for `scopedStores`, so this is strictly narrower than before spec 159 |

The security-critical one specifically called out in the brief — **the mount-time
cross-store fetch — is correct**: `DashboardSection.tsx:282` now reads
`visibleStoreIdsKey.split(',')` (derived from `visibleStores` at `:252-255`), replacing
the pre-159 `stores.map(s => s.id)`. The dep list at `:328` is
`[visibleStoreIdsKey, currentStore.id]`, so a brand switch refetches rather than serving a
stale wider set. All five reads — including the four pre-existing ones — now request the
narrowed id list, so this spec *tightens* four existing requests as a side effect.

Every rendering enumeration reads `scopedStores` (a filter of `visibleStores`):
heatmap `:~590`, `queueByStore` `:~600`, card grid `:~840`, `storeCount` `:391`,
`eodSubmittedToday` `:~296`, picker options `:696` (`stores={visibleStores}`).
`scopedInventory` `:376-379` narrows the genuinely-cross-store `inventory` slice through
`scopeIdSet`. Per spec §12.6 this closes a real pre-existing cross-brand leak in the
headline TOTAL INV VALUE for super-admins — a security improvement shipped by this spec.

Pinned by test: `DashboardSection.scopePicker.spec159.test.tsx:198-215` asserts an
out-of-brand store is neither a picker option nor a card, and that its inventory value is
excluded from the aggregate. I ran the suite independently — 37 tests pass across the
three visibility-relevant files.

Defense in depth worth noting: even if a caller forced a scope onto a non-visible store,
`effectiveScope` re-validates against `visibleStores` at `:224-226` (AC-P5) and
`scopedStores` re-filters `visibleStores` at `:230-240`, so an out-of-set id resolves to
an empty scope, never to that store's data.

### 3. Can `brandNameFor` leak a brand name the caller shouldn't see? — **No. It fails closed by construction.**

`src/lib/storeVisibility.ts:78-86` resolves only from two client slices, and both are
RLS-gated by the same predicate:

- `public.brands` SELECT is
  `brand_member_read_brands USING (auth_can_see_brand(id) AND (deleted_at IS NULL OR auth_is_super_admin()))`
  (`20260509000000_multi_brand_schema_rls.sql:422-427`), confirmed live.
- `auth_can_see_brand()` is super-admin, or `profiles.brand_id = p_brand_id`
  (`:200-210`).

So `brand` and `brandsList` can only ever contain brands the caller is permitted to read.
The `brandId` fed in comes from `aggregateLabelFor`'s distinct-brand scan over
`scopedStores` (`DashboardSection.tsx:621`) — stores that already passed
`visibleStoresFor`. Both inputs are pre-authorized; the function performs no I/O and
cannot synthesize a name.

The interesting edge resolves correctly too: a non-privileged user with a `user_stores`
grant into a brand that is not their `profiles.brand_id` would see the *store*
(`auth_can_see_store` arm 3) but not the *brand row* (`auth_can_see_brand` false) — so
`brandNameFor` returns `null` and `:626` degrades to the generic
`scopeAllFallback` / `allStores` copy. Null, never a placeholder, never a guess. Same
outcome for the >1-distinct-brand case (`:625`) and for pre-hydration first paint.

No injection surface in the label either: `t()` interpolates via
`value.replace(/\{(\w+)\}/g, cb)` with a **function** replacement
(`src/i18n/index.ts:89-90`), so `$&`-style sequences in a store or brand name are not
re-interpreted, and the result renders into a React Native `<Text>` — no HTML sink, no
`dangerouslySetInnerHTML`. The escapeHtml convention applies to Resend HTML bodies in
edge functions; it does not apply here.

### 4. Is the picker treated as display-only, not an authorization boundary? — **Yes.**

`ScopePicker` (`DashboardSection.tsx:889-990`) receives `stores={visibleStores}` and calls
`onSelect` → `setScope`, component-local `useState` only. It never calls
`setCurrentStore`, never writes `profiles`, never touches `currentBrandId`, and persists
nothing (AC-P3 / PM-2 honoured — I checked the diff for writes and found none).

The layering is correct and stated in the code: RLS is the boundary
(`db.ts:836-838` docblock), `visibleStoresFor` is the client-side rendering rule
(`storeVisibility.ts:25-27`), and the scope picker narrows *within* that. Note also that
the client-side `useRole()` placeholder is not used as a gate anywhere in this diff —
no new code treats it as a security boundary.

---

## Contract claims verified rather than trusted

- **No migration, RPC, edge function, or config change.** Confirmed by file list: the
  staged set contains zero paths under `supabase/migrations/`, `supabase/functions/`, or
  `supabase/config.toml`. So: no new table needing RLS, no new `verify_jwt` entry, no
  `ADMIN_ROLES` set needing `super_admin`, no `escapeHtml` obligation, no
  last-of-role / self-guard obligation. AC-T4's pgTAP condition correctly does not fire.
- **No realtime change (AC-R3).** No `.channel(` / `subscribe(` / `ALTER PUBLICATION` in
  any staged source file — the only matches are spec prose. `waste_log` was already in
  `supabase_realtime` (confirmed live via `\d public.waste_log`), so no publication
  membership moved and the `docker restart supabase_realtime_imr-inventory` gotcha does
  not apply.
- **No secrets.** Scanned the full staged diff for `service_role`, JWT-shaped literals,
  `api[_-]?key`, `secret`, `password`, `token`, `EXPO_PUBLIC` — the single `EXPO_PUBLIC`
  hit is a code comment in a test file explaining a mocked env var. No key material, no
  credentials, no service token.
- **No new logging of PII or tokens.** The one new log is
  `console.warn('[Supabase] fetchWasteLogForStores:', error.message)` (`db.ts:857`) —
  a PostgREST error string, no row data, no ids, no token. Matches the sibling contract.
- **No cross-identity carryover** for the phone-pinned `[currentStore]` fallback
  (`:236`): `SIGNED_OUT_DATA_RESET` (`useStore.ts:1083-1084`) blanks `currentStore` on
  sign-out, and the KPIs it feeds are computed from the RLS-loaded `inventory` slice, so
  a stale id yields empty data rather than another tenant's rows.

---

### Dependencies

No `package.json` or lockfile changes in the staged diff — `npm audit` skipped per
process.
