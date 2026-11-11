# Spec 195: prod pre-checks (read-only)

Run by the main session on 2026-11-09 through the Supabase MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`. Read-only; nothing changed. Re-run P-1 to P-6 right before the apply (AC-R1), because these are a snapshot.

| Query | Result |
|---|---|
| **P-1** policies | Exactly the three in the spec: `Admins can manage all store links` (ALL, privileged + `auth_can_see_brand` on the store's brand), `Users can manage own store links` (ALL, `user_id = auth.uid()`), `Users can read own store links` (SELECT, `user_id = auth.uid()`). All PERMISSIVE, role `public`. |
| **P-2** triggers | Only `user_stores_brand_match_trg`, BEFORE INSERT OR UPDATE, enabled `O`. |
| **P-3** live brands | Two: `2AM PROJECT` and `Baltimore Seafood`, neither deleted. So the hole is cross-tenant. |
| **P-4** NULL-brand non-super_admin profiles holding stores | None. |
| **P-5** branded users linked to another brand's store | None. |
| **P-6** staff links not explained by an invitation | 7 of the 8 staff (`role='user'`) links. |

## P-6 follow-up

P-6 as written matches `invitations.profile_id`. The app inserts invitations with the all-zero placeholder `profile_id` (`src/lib/auth.ts:441`), so that match misses nearly everything. A second read-only query classified every staff link:

- All 8 staff profiles have a `username`.
- 1 link matches an invitation by email for that exact store.
- The other 7 have no invitation at all (prod holds 4 invitations in total). They are store-user accounts made by `manage-store-user` (spec 165), which creates the profile and its `user_stores` rows through the service role without an invitation. 4 of the 7 have a matching `Store user created` audit row (spec 167). The other 3 have none, which fits accounts created before spec 167's audit shipped, but nothing records that.
- Every staff link is to a store in the user's own brand.

**Reading:** no evidence of any self-link on prod. The table has no author or timestamp column, so this cannot be proven, only found consistent. Nothing here needs the owner before the apply, unless the owner doesn't recognise the 3 store-user accounts with no creation audit row (ids are in the session transcript, not recorded here).

Totals at the time: 8 staff profiles, 8 staff links, 10 `user_stores` rows overall.

## P-6 (rewritten) and P-7, 2026-11-09

Also read-only, through the Supabase MCP.

- **P-6 as rewritten in the spec** (email match through `auth.users`, `detail::jsonb ->> 'target_id'` match on `Store user created` rows) ran cleanly and reproduced the split above: 8 links, 1 by invitation, 4 by audit row, 3 neither, 0 cross-brand.
- **Non-JSON `Store user created` rows** (`not pg_input_is_valid(detail, 'jsonb')`): 0.
- **P-7, registration still works after the drop:** `public.user_stores` owner `postgres`, `relrowsecurity = true`, `relforcerowsecurity = false`; `register_invited_profile()` owner `postgres`, `prosecdef = true`; `postgres` has `rolbypassrls = true`. So the function's own-link insert bypasses row-level security and isn't affected by dropping the own-row write policy. Server version 17.6.
