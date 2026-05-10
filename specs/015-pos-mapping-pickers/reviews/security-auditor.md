# Security audit for spec 015 (POS menu-item mapping pickers)

## Critical (BLOCKS merge)

None. Spec 015 introduces no new attack surface that warrants blocking the
merge. New surface (one PostgREST DELETE helper, one client component, one
store action, three picker call-sites) is additive over an already
RLS-protected table — see §"Existing RLS state" below for the verbatim
verification.

## High (must fix before deploy)

None.

## Medium

None new from this spec.

## Low

### L1. Spec §2 RLS premise is stale (architect-side documentation drift, NOT a runtime issue)

`specs/015-pos-mapping-pickers.md:382-423` (architect's "Status quo")
asserts that `pos_recipe_aliases` is still on the legacy
"any-authed-user" RLS pattern (`auth.uid() IS NOT NULL` shape from
`supabase/migrations/20260425043301_pos_recipe_aliases.sql:23-41`) and
that the "any motivated client could DELETE a global alias via direct
PostgREST."

**This is no longer true.** The 2026-05-09 multi-brand RLS migration
(`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:909-970`)
replaced the legacy policies entirely. Verified by direct `pg_policy`
query against the live local stack:

```
brand_member_read_pos_recipe_aliases | r |
  EXISTS (SELECT 1 FROM recipes r
          WHERE r.id = pos_recipe_aliases.recipe_id
            AND auth_can_see_brand(r.brand_id))

privileged_insert_pos_recipe_aliases | a | (with check)
  auth_is_privileged()
  AND EXISTS (SELECT 1 FROM recipes r
              WHERE r.id = pos_recipe_aliases.recipe_id
                AND auth_can_see_brand(r.brand_id))

privileged_update_pos_recipe_aliases | w | (using + with check, both same)
  auth_is_privileged()
  AND EXISTS (SELECT 1 FROM recipes r
              WHERE r.id = pos_recipe_aliases.recipe_id
                AND auth_can_see_brand(r.brand_id))

privileged_delete_pos_recipe_aliases | d |
  auth_is_privileged()
  AND EXISTS (SELECT 1 FROM recipes r
              WHERE r.id = pos_recipe_aliases.recipe_id
                AND auth_can_see_brand(r.brand_id))
```

`relrowsecurity = t` confirmed.

**Helpers in play** (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:200-239`):
- `auth_can_see_brand(uuid)` — true iff super-admin OR caller's
  `profiles.brand_id` matches.
- `auth_is_privileged()` — true iff `auth_is_admin()` (JWT
  `app_metadata.role IN ('admin','master')`) OR `auth_is_super_admin()`
  (`profiles.role = 'super_admin'`).

**Concrete impact (corrected):** within the same brand, an admin/master
user CAN read/write/delete `pos_recipe_aliases` rows that belong to
another store under the same brand — because the policy is gated on the
recipe's `brand_id`, not the alias's `store_id`. Cross-brand access is
properly blocked (the `EXISTS` on `recipes` filters by
`auth_can_see_brand`). Non-admin roles (JWT `app_metadata.role` not in
`('admin','master')` and `profiles.role != 'super_admin'`) are blocked
from all writes, and reads also require brand membership.

For the imr-inventory threat model (admin-only app, single brand "2AM
PROJECT" today): the per-store boundary on this table is **not enforced
by RLS** — only by the UI's `currentStore.id` filter in
`fetchPosRecipeAliases` and the picker's `currentStore.id` write target.
A motivated admin in Store A could craft a curl to insert/update/delete
a Store B alias (same brand). This is the same shape as the architect's
flagged drift, just for a different reason — recipe-brand-gated, not
"any-authed-user." Severity drops from Medium-to-Low because the only
callers who can exercise it are already brand-admins (who legitimately
manage the brand catalog and any of its stores' POS data); they cannot
reach across brands; and the remaining gap (cross-store-within-brand
isolation) is a known design tradeoff for the brand-scoped catalog.

**This is not introduced by spec 015.** It pre-dates the spec. Filed Low
so the architect's review file (which still says "spec 015 does NOT
attempt to fix it" and labels it Medium for product overall) can be
re-aligned in a separate doc-only follow-up.

### L2. Architect §11 "global alias UI gate is cosmetic / motivated client could DELETE via direct PostgREST" — also stale

`specs/015-pos-mapping-pickers.md:843-861` warns that the UI gate
hiding the remove affordance on global aliases is "purely cosmetic" and
that "a motivated client could DELETE a global alias via direct
PostgREST."

**Mostly false post-2026-05-09.** The current
`privileged_delete_pos_recipe_aliases` policy requires
`auth_is_privileged() AND auth_can_see_brand(r.brand_id)`. A
non-admin/non-super-admin user CANNOT delete the global alias via direct
PostgREST — RLS rejects the DELETE.

**The remaining gap** is intra-brand: an admin/master in Brand A could
DELETE a global alias (`store_id IS NULL`) whose underlying recipe is in
Brand A — RLS does not check `store_id`, only the recipe's brand. So the
UI "hide" is still an additional defense-in-depth layer for admins
within the same brand who have no business touching cross-store/global
aliases. Cross-brand deletion of a global alias whose recipe is in
another brand is properly blocked by RLS.

Severity Low because (a) admin role is already trusted with brand-wide
write authority, (b) global aliases are exceptional rows seeded by the
maintainer with no UI affordance to create them, (c) cross-brand
isolation is intact.

### L3. Architect's "follow-up RLS hardening — pos_recipe_aliases" recommendation should be re-scoped

`specs/015-pos-mapping-pickers.md:404-416` recommends a follow-up spec
that "drops the legacy 'Store access' / `auth.uid() IS NOT NULL` policy
and adds the four `auth_can_see_store(store_id)`-helper policies."

The legacy policy is already gone. The follow-up, if pursued, would now
need to:
- Decide whether the per-store boundary inside a brand is a real
  security boundary or just a UX convenience. Today the table is
  brand-scoped via the parent recipe; aliases are conceptually a
  per-store concept but the new RLS model doesn't enforce that. If the
  user wants cross-store isolation within a brand, the follow-up adds
  `OR (pos_recipe_aliases.store_id IS NULL OR
  auth_can_see_store(pos_recipe_aliases.store_id))` to each policy's
  `using`/`with check` expression.
- Decide on global aliases (`store_id IS NULL`): admin-only writes
  (`auth_is_privileged()` only, not `auth_can_see_brand`) or
  super-admin-only writes (`auth_is_super_admin()`).

Not blocking spec 015. Surfaced so the architect's recommendation lands
on the right model.

## Routine checks

### No new secrets in client

Verified. `RecipePickerModal.tsx` and the changed sections of
`POSImportsSection.tsx` and `useStore.ts` reference only existing store
state and existing helpers. No `EXPO_PUBLIC_*` additions, no service
tokens hardcoded, no third-party API keys. `db.ts:1483-1496` uses the
existing authenticated `supabase` client — service-role key is not
reachable from client code. ✓

### `deletePosRecipeAlias(storeId, posName)` filter

`src/lib/db.ts:1483-1496` (verbatim):

```ts
export async function deletePosRecipeAlias(
  storeId: string,
  posName: string,
): Promise<void> {
  const { error } = await supabase
    .from('pos_recipe_aliases')
    .delete()
    .eq('store_id', storeId)
    .eq('pos_name', posName.trim());
  if (error) {
    console.warn('[Supabase] deletePosRecipeAlias:', error.message);
    throw error;
  }
}
```

This **correctly prevents accidentally hitting a global alias** when
called for a store-scoped removal. PostgREST translates `.eq('store_id',
storeId)` to `WHERE store_id = $storeId`, which is FALSE (not NULL-true)
for any row whose `store_id IS NULL`. So a global alias of the same
`pos_name` is never matched by this DELETE.

Defense-in-depth confirmed at three layers:
- UI layer: `POSImportsSection.tsx:1115` wraps the REMOVE button in
  `!isGlobal ? <button /> : null` — global rows have no remove
  affordance.
- Store-action layer: `src/store/useStore.ts:1508-1513` filters local
  optimistic state with `(a.store_id === storeId && ...)` — global rows
  unchanged in local slice even on optimistic update.
- DB layer: `.eq('store_id', storeId)` filter rejects global rows
  server-side. RLS additionally requires `auth_is_privileged()` plus
  brand membership for the recipe.

Note: the early-return in `removePosRecipeAlias` (`useStore.ts:1503`:
`if (!storeId || !posName) return`) prevents the DELETE from firing
without a `storeId`. Even if it did fire, the `.eq('store_id',
undefined)` would serialize to a query that PostgREST rejects rather
than turning into `IS NULL` — confirmed by the supabase-js client's
documented behavior. ✓

### No new RPC path / SECURITY DEFINER risk

Verified. Spec 015 introduces zero new database functions. The new
helper goes through PostgREST direct table access. No SECURITY DEFINER
risk introduced. ✓

### Input validation

`posName` is user-controlled (originates from the POS string in the
imported file or fetched from Breadbot). It flows through:
- `.eq('pos_name', posName.trim())` — parameterized, not interpolated.
  No SQL-injection surface.
- `<Text>{posName}</Text>` in `RecipePickerModal.tsx:126` and
  `POSImportsSection.tsx:1014, 1069` — React auto-escapes. No XSS.
- testID interpolation: `mapping-cmd-unmapped-pick-${u.pos_name}`
  (`POSImportsSection.tsx:1021`),
  `mapping-cmd-alias-edit-${c.pos_name}` (line 1093),
  `mapping-cmd-alias-remove-${c.pos_name}` (line 1117). On web,
  React Native's testID maps to `data-testid` — non-rendered DOM
  attribute, not an XSS surface even with arbitrary characters.
- `confirmAction(title, message, onConfirm)` —
  `src/utils/confirmAction.ts:9` uses `window.confirm(\`${title}\\n\\n${message}\`)`.
  `window.confirm` renders strings as plain text (browser-native chrome,
  not the page DOM). No XSS surface. ✓

### Error messages

`notifyBackendError('Remove alias', e)` (`useStore.ts:1519`) bubbles the
underlying Supabase error message into a toast. Supabase error messages
on a DELETE may include the policy name on RLS rejection (e.g.
`new row violates row-level security policy "..."`) — but for DELETE,
the typical message is `permission denied for table pos_recipe_aliases`
or similar generic form. Not a meaningful information disclosure.
Existing pattern across the codebase. ✓

### CORS / cookies / CSRF / rate-limiting

No new edge functions, no new public endpoints, no new auth surface.
PostgREST flow inherits Supabase's built-in `Authorization: Bearer
<jwt>` model — token-bearer auth, no cookie auth. CSRF not applicable
(no same-origin cookie session). Rate-limiting unchanged. ✓

### `verify_jwt` checks

No new functions in `supabase/functions/`. No `supabase/config.toml`
changes. ✓

## Existing RLS state — verbatim from `pg_policy`

For the architect's §2 sanity check (the prompt explicitly asked):

| polname                              | cmd | expression (using / with check)                                                                           |
|--------------------------------------|-----|-----------------------------------------------------------------------------------------------------------|
| `brand_member_read_pos_recipe_aliases`  | r   | `EXISTS (SELECT 1 FROM recipes r WHERE r.id = pos_recipe_aliases.recipe_id AND auth_can_see_brand(r.brand_id))` |
| `privileged_insert_pos_recipe_aliases`  | a   | with check: `auth_is_privileged() AND EXISTS (SELECT 1 FROM recipes r WHERE r.id = pos_recipe_aliases.recipe_id AND auth_can_see_brand(r.brand_id))` |
| `privileged_update_pos_recipe_aliases`  | w   | using + with check: `auth_is_privileged() AND EXISTS (SELECT 1 FROM recipes r WHERE r.id = pos_recipe_aliases.recipe_id AND auth_can_see_brand(r.brand_id))` |
| `privileged_delete_pos_recipe_aliases`  | d   | using: `auth_is_privileged() AND EXISTS (SELECT 1 FROM recipes r WHERE r.id = pos_recipe_aliases.recipe_id AND auth_can_see_brand(r.brand_id))` |

`relrowsecurity = t`. The `auth_can_see_store(store_id)` helper is **NOT
referenced** by any of these policies — they go through brand membership
on the parent recipe instead. This is the architectural choice the
multi-brand migration made; it's not the bug the architect flagged.

## Dependencies

No `package.json` changes — `npm audit` skipped per the audit playbook.
Confirmed via `git status` and `git diff --stat HEAD -- package.json`.

## Handoff

next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low (all pre-existing or stale-spec-doc nits, none block deploy).
payload_paths:
  - specs/015-pos-mapping-pickers/reviews/security-auditor.md
